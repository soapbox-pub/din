import { useEffect, useLayoutEffect, useRef } from 'react';
import { MessageCircle, Smartphone } from 'lucide-react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { appForFile } from '@/lib/fileTypes';
import { parentPath } from '@/lib/fs';
import { closeNotificationByKey, getNotificationState, notify, updateNotificationByKey, type NotifyInput } from '@/lib/notificationCenter';
import { getPhoneDesktopBridge, type PhoneReceive } from '@/lib/phone';
import { cleanPhoneError, formatAddress } from '@/shared/phone';

/**
 * New texts from the user's phones (electron/phone.mts), as notifications
 * with a reply field, the way a Mac shows iMessages. One per conversation:
 * a newer text replaces the one before. A click opens the conversation in
 * Messages; none shows while Messages is the window in front, and one goes
 * once its conversation is read, in Messages or on the phone.
 *
 * Files a phone shares over Bluetooth (electron/phone-receive.mts) get one
 * notification per share: progress with Cancel while a file takes more than
 * a moment, then what arrived, with Open or Show in Files. The user just
 * shared from the phone in their hand, so nothing asks first.
 */
export function PhoneHost() {
  const { windows, open } = useWindowManager();
  const windowsRef = useRef(windows);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    windowsRef.current = windows;
    openRef.current = open;
  });

  useEffect(() => {
    const phone = getPhoneDesktopBridge();
    if (!phone) return;
    const key = (phoneId: string, threadId: string) => `phone:${phoneId}:${threadId}`;
    const offMessages = phone.onMessages(({ phoneId, threadIds }) => {
      const notified = new Set(getNotificationState().notifications.map((n) => n.replaceKey));
      const pending = threadIds.filter((t) => notified.has(key(phoneId, t)));
      if (pending.length === 0) return;
      void phone.conversations(phoneId).then((list) => {
        for (const threadId of pending) {
          if (!list.some((c) => c.threadId === threadId && c.unread > 0)) closeNotificationByKey(key(phoneId, threadId));
        }
      }, () => {});
    });
    const offIncoming = phone.onIncoming(({ message, name: rawName, from, update }) => {
      // A number that isn't a contact, written as people write it.
      const name = rawName.split(', ').map(formatAddress).join(', ');
      const group = message.addresses.length > 1;
      const pictures = message.images.length;
      const body = message.body || (pictures ? (pictures === 1 ? 'Sent a picture' : `Sent ${pictures} pictures`) : '');
      const replaceKey = key(message.phoneId, message.threadId);
      const reply = {
        placeholder: `Reply to ${name}`,
        send: (text: string) =>
          phone.send(message.phoneId, message.addresses, text).then(
            () => phone.markRead(message.phoneId, message.threadId),
            (error: unknown) => {
              throw new Error(cleanPhoneError(error));
            },
          ),
      };
      const text = group && from ? `${formatAddress(from)}: ${body}` : body;
      if (update) {
        updateNotificationByKey(replaceKey, { title: name, body: text, reply });
        return;
      }
      const front = windowsRef.current
        .filter((w) => !w.closing && !w.minimized)
        .reduce<(typeof windowsRef.current)[number] | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined);
      if (front?.appId === 'messages' && document.hasFocus()) return;
      notify({
        source: { appId: 'messages', name: 'Messages', icon: MessageCircle },
        title: name,
        body: text,
        replaceKey,
        reply,
        onActivate: () => openRef.current('messages', { phoneId: message.phoneId, threadId: message.threadId, nonce: Date.now() }),
      });
    });
    return () => {
      offMessages();
      offIncoming();
    };
  }, []);

  useEffect(() => {
    const phone = getPhoneDesktopBridge();
    if (!phone) return;
    /** Shares whose progress is on screen, and ones waiting a moment before it is. */
    const shown = new Set<string>();
    const waiting = new Map<string, number>();
    const latest = new Map<string, PhoneReceive>();
    const source = { name: 'Phone', icon: Smartphone };
    const key = (id: string) => `phone-receive:${id}`;

    const progress = (r: PhoneReceive): Pick<NotifyInput, 'title' | 'body' | 'progress'> => ({
      title: r.files.length === 0 && r.current ? `Receiving ${r.current.name}` : `Receiving ${r.files.length + 1} files`,
      body: `From ${r.phoneName}`,
      progress: r.current?.size ? r.current.transferred / r.current.size : null,
    });

    const showProgress = (id: string) => {
      waiting.delete(id);
      const r = latest.get(id);
      if (!r || r.status !== 'receiving') return;
      shown.add(id);
      notify({
        source,
        ...progress(r),
        replaceKey: key(id),
        actions: [{ id: 'cancel', label: 'Cancel' }],
        timeout: 0,
        resident: true,
        onActivate: (action) => {
          if (action === 'cancel') void phone.cancelReceive(id);
        },
      });
    };

    const showFile = (file: { name: string; path: string }) => openRef.current(appForFile(file.name), { path: file.path });
    const showInFiles = (file: { name: string; path: string }) =>
      openRef.current('file-browser', { path: parentPath(file.path), select: file.name });

    const showResult = (r: PhoneReceive) => {
      if (r.status === 'cancelled') return closeNotificationByKey(key(r.id));
      const missed = r.failed.length
        ? `${r.failed.length === 1 ? `${r.failed[0]} didn’t arrive` : `${r.failed.length} didn’t arrive`}${r.error ? `: ${r.error}` : '.'}`
        : '';
      if (r.status === 'failed') {
        const what = r.failed.length === 1 ? r.failed[0] : r.failed.length ? `${r.failed.length} files` : 'files';
        notify({ source, title: `Couldn’t receive ${what} from ${r.phoneName}`, body: r.error ?? 'The phone stopped sending.', replaceKey: key(r.id) });
        return;
      }
      const single = r.files.length === 1 ? r.files[0] : null;
      const last = r.files[r.files.length - 1];
      notify({
        source,
        title: single ? `Received ${single.name}` : `Received ${r.files.length} files`,
        body: [`From ${r.phoneName}, in Downloads.`, missed].filter(Boolean).join(' '),
        replaceKey: key(r.id),
        actions: single ? [{ id: 'open', label: 'Open' }, { id: 'show', label: 'Show in Files' }] : [{ id: 'show', label: 'Show in Files' }],
        onActivate: (action) => {
          if (single && action !== 'show') showFile(single);
          else showInFiles(last);
        },
      });
    };

    const off = phone.onReceive((r) => {
      latest.set(r.id, r);
      if (r.status === 'receiving') {
        if (shown.has(r.id)) updateNotificationByKey(key(r.id), progress(r));
        else if (!waiting.has(r.id)) waiting.set(r.id, window.setTimeout(() => showProgress(r.id), RECEIVE_QUIET_MS));
        return;
      }
      window.clearTimeout(waiting.get(r.id));
      waiting.delete(r.id);
      shown.delete(r.id);
      latest.delete(r.id);
      showResult(r);
    });
    return () => {
      off();
      for (const timer of waiting.values()) window.clearTimeout(timer);
    };
  }, []);

  return null;
}

/** A share done within this long shows only what arrived, never its progress. */
const RECEIVE_QUIET_MS = 1000;
