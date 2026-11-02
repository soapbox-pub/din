import { useEffect, useLayoutEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { setDinBadge } from '@/lib/appBadges';
import { getMailDesktopBridge } from '@/lib/mail';
import { closeNotificationByKey, notify } from '@/lib/notificationCenter';

/**
 * New mail in the user's inboxes (electron/mail.mts watches them from the
 * moment Din starts, Mail open or not), as a notification per message,
 * which a click opens in Mail. None shows while Mail is the window in
 * front, and one goes once its message is read, moved or deleted, here or
 * anywhere else. Mail's Dock tile shows the inboxes' unread count.
 */
export function MailHost() {
  const { windows, open, launchIn } = useWindowManager();
  const windowsRef = useRef(windows);
  const actionsRef = useRef({ open, launchIn });
  useLayoutEffect(() => {
    windowsRef.current = windows;
    actionsRef.current = { open, launchIn };
  });

  useEffect(() => {
    const mail = getMailDesktopBridge();
    if (!mail) return;
    const badge = (unseen: Record<string, number>) => {
      const total = Object.values(unseen).reduce((n, x) => n + x, 0);
      setDinBadge('mail:unseen', 'mail', total || null);
    };
    let live = true;
    void mail.unseen().then((u) => live && badge(u)).catch(() => {});
    const offUnseen = mail.onUnseen(badge);

    const key = (accountId: string, path: string, uid: number) => `mail:${accountId}:${path}:${uid}`;
    const offArrived = mail.onArrived((m) => {
      const shown = windowsRef.current.filter((w) => !w.closing && !w.minimized);
      const front = shown.reduce<(typeof shown)[number] | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined);
      if (front?.appId === 'mail' && document.hasFocus()) return;
      const sender = m.from[0];
      notify({
        source: { appId: 'mail', name: 'Mail' },
        title: sender?.name.trim() || sender?.address || 'New Mail',
        body: [m.subject, m.preview].filter(Boolean).join('\n'),
        replaceKey: key(m.accountId, m.path, m.uid),
        onActivate: () => {
          const params = { accountId: m.accountId, mailbox: m.path, uid: m.uid, nonce: Date.now() };
          // The Mail window the user was last in, unless it's one writing a message.
          const viewer = windowsRef.current
            .filter((w) => w.appId === 'mail' && !w.closing && !w.params?.compose && !w.params?.mailto && w.params?.shortcut !== 'compose')
            .reduce<(typeof windowsRef.current)[number] | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined);
          if (viewer) actionsRef.current.launchIn(viewer.id, params);
          else actionsRef.current.open('mail', params);
        },
      });
    });
    const offRead = mail.onRead(({ accountId, path, uids }) => {
      for (const uid of uids) closeNotificationByKey(key(accountId, path, uid));
    });

    return () => {
      live = false;
      offUnseen();
      offArrived();
      offRead();
      setDinBadge('mail:unseen', 'mail', null);
    };
  }, []);

  return null;
}
