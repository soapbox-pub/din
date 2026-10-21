import { useEffect, useLayoutEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import type { WindowState } from '@/hooks/useWindows';
import { closeNotification, DEFAULT_POPUP_MS, notify } from '@/lib/notificationCenter';
import { getSystemNotificationsBridge, type SystemNotification } from '@/lib/systemNotifications';

/** The shortest time an app may ask a popup to stay. */
const MIN_POPUP_MS = 2000;

/**
 * Puts Linux apps' notifications (see src/lib/systemNotifications.ts) in the
 * notification center, and reports back what the user did with them. A
 * click also raises the app's window, as most apps expect of a desktop.
 */
export function SystemNotificationsHost() {
  const { windows, focus } = useWindowManager();
  // Read at click time, without resubscribing on every window change.
  const windowsRef = useRef(windows);
  useLayoutEffect(() => {
    windowsRef.current = windows;
  });

  useEffect(() => {
    const bridge = getSystemNotificationsBridge();
    if (!bridge) return;

    const raise = (appId: string | null) => {
      if (!appId) return;
      const target = windowsRef.current
        .filter((w) => w.appId === appId && !w.closing)
        .reduce<WindowState | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined);
      if (target) focus(target.id);
    };

    const show = (n: SystemNotification) => {
      const takesClick = n.actions.some((a) => a.id === 'default');
      notify({
        id: n.id,
        source: { appId: n.appId, name: n.appName || 'Notification', icon: n.icon },
        title: n.title,
        body: n.body,
        image: n.image,
        actions: n.actions.filter((a) => a.id !== 'default'),
        urgency: n.urgency,
        timeout: n.timeout < 0 ? (n.urgency === 'critical' ? 0 : DEFAULT_POPUP_MS) : n.timeout && Math.max(n.timeout, MIN_POPUP_MS),
        history: !n.transient,
        resident: n.resident,
        onActivate: (action) => {
          if (action !== 'default' || takesClick) bridge.activate(n.id, action);
          // Apps that don't take a click still get their window raised.
          if (action === 'default') raise(n.appId);
        },
        onClose: (reason) => bridge.closed(n.id, reason),
      });
    };

    const offShow = bridge.onShow(show);
    const offClose = bridge.onClose((id) => closeNotification(id, 'closed'));
    return () => {
      offShow();
      offClose();
    };
  }, [focus]);

  return null;
}
