import { useEffect, useLayoutEffect, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { notify, updateNotificationByKey } from '@/lib/notificationCenter';
import { getPhoneDesktopBridge } from '@/lib/phone';
import { cleanPhoneError, formatAddress } from '@/shared/phone';

/**
 * New texts from the user's phones (electron/phone.mts), as notifications
 * with a reply field, the way a Mac shows iMessages. One per conversation:
 * a newer text replaces the one before. A click opens the conversation in
 * Messages; none shows while Messages is the window in front.
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
    return phone.onIncoming(({ message, name: rawName, from, update }) => {
      // A number that isn't a contact, written as people write it.
      const name = rawName.split(', ').map(formatAddress).join(', ');
      const group = message.addresses.length > 1;
      const pictures = message.images.length;
      const body = message.body || (pictures ? (pictures === 1 ? 'Sent a picture' : `Sent ${pictures} pictures`) : '');
      const replaceKey = `phone:${message.phoneId}:${message.threadId}`;
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
  }, []);

  return null;
}
