import { useEffect, useLayoutEffect, useRef } from 'react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import type { WindowState } from '@/hooks/useWindows';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { closeNotification, DEFAULT_POPUP_MS, notify, type NotificationSource } from '@/lib/notificationCenter';
import { getSystemNotificationsBridge, type SystemNotification } from '@/lib/systemNotifications';

/** The shortest time an app may ask a popup to stay. */
const MIN_POPUP_MS = 2000;

interface GuestElement extends HTMLElement {
  getWebContentsId(): number;
}

/** The Din window hosting a <webview> guest, by the guest's WebContents id. */
function guestWindowId(webContentsId: number): string | null {
  for (const element of document.querySelectorAll<GuestElement>('webview')) {
    let id: number;
    try {
      id = element.getWebContentsId();
    } catch {
      continue; // not attached yet
    }
    if (id === webContentsId) return element.closest('[data-window-id]')?.getAttribute('data-window-id') ?? null;
  }
  return null;
}

/**
 * Puts Linux apps' and web pages' notifications (see
 * src/lib/systemNotifications.ts) in the notification center, and reports
 * back what the user did with them. A click also brings the sender forward:
 * a Linux app's window, or the tab or web app a page's came from.
 */
export function SystemNotificationsHost() {
  const { windows, focus } = useWindowManager();
  const { getApp } = useInstalledApps();
  // Read when a notification arrives or is clicked, without resubscribing.
  const windowsRef = useRef(windows);
  const getAppRef = useRef(getApp);
  useLayoutEffect(() => {
    windowsRef.current = windows;
    getAppRef.current = getApp;
  });

  useEffect(() => {
    const bridge = getSystemNotificationsBridge();
    if (!bridge) return;

    const raiseApp = (appId: string) => {
      const target = windowsRef.current
        .filter((w) => w.appId === appId && !w.closing)
        .reduce<WindowState | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined);
      if (target) focus(target.id);
    };

    const raiseGuest = (webContentsId: number) => {
      const windowId = guestWindowId(webContentsId);
      if (windowId) focus(windowId);
      if (hasTabConsumer()) publishTabCommand({ type: 'select', wcId: webContentsId });
    };

    /** A web page's notification is from its web app, or from the site in a browser tab. */
    const guestSource = (n: SystemNotification, webContentsId: number): NotificationSource => {
      const windowId = guestWindowId(webContentsId);
      const appId = windowsRef.current.find((w) => w.id === windowId)?.appId;
      const app = appId ? getAppRef.current(appId) : undefined;
      if (app && app.id !== 'web-browser') return { appId: app.id, name: app.name };
      return { name: n.appName, icon: getAppRef.current('web-browser')?.icon };
    };

    const show = (n: SystemNotification) => {
      const takesClick = n.actions.some((a) => a.id === 'default');
      const guest = n.guest;
      notify({
        id: n.id,
        source: guest
          ? guestSource(n, guest.webContentsId)
          : { appId: n.appId, name: n.appName || 'Notification', icon: n.icon },
        title: n.title,
        body: n.body,
        image: n.image,
        actions: n.actions.filter((a) => a.id !== 'default'),
        urgency: n.urgency,
        timeout:
          n.timeout < 0
            ? n.urgency === 'critical' ? 0 : DEFAULT_POPUP_MS
            : n.timeout && Math.max(n.timeout, MIN_POPUP_MS),
        history: !n.transient,
        resident: n.resident,
        replaceKey: guest && n.tag ? `web\0${guest.origin}\0${n.tag}` : undefined,
        onActivate: (action) => {
          if (guest) {
            bridge.activate(n.id, action);
            if (action === 'default') raiseGuest(guest.webContentsId);
            return;
          }
          if (action !== 'default' || takesClick) bridge.activate(n.id, action);
          // Apps that don't take a click still get their window raised.
          if (action === 'default' && n.appId) raiseApp(n.appId);
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
