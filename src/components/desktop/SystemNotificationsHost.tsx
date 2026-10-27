import { useEffect, useLayoutEffect, useRef } from 'react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import type { WindowState } from '@/hooks/useWindows';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { getNappHost } from '@/lib/napp';
import { getBrowserBridge } from '@/lib/browser';
import {
  closeNotification,
  closeNotificationsFrom,
  DEFAULT_POPUP_MS,
  notify,
  useNotificationCenter,
  type NotificationSource,
} from '@/lib/notificationCenter';
import { nsiteAppId } from '@/lib/nsiteApps';
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
 * a Linux app's window, the tab or web app a page's came from, or an
 * installed nsite's window at the notification's `data.url` - which its
 * service worker may then move (clients.openWindow, see electron/napp.mts).
 */
export function SystemNotificationsHost() {
  const { windows, focus, open } = useWindowManager();
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
      const origin = n.guest?.remembered ? n.guest.origin : undefined;
      if (app && app.id !== 'web-browser') return { appId: app.id, name: app.name, origin };
      return { name: n.appName, icon: getAppRef.current('web-browser')?.icon, origin };
    };

    /** Open an installed nsite, at a page of its own or where it was. */
    const openSite = (host: string, url: string | null) => {
      const appId = nsiteAppId(host);
      if (!getAppRef.current(appId)) return;
      open(appId, url ? { url } : undefined);
    };

    const show = (n: SystemNotification) => {
      const takesClick = n.actions.some((a) => a.id === 'default');
      const guest = n.guest;
      const site = n.site;
      const siteApp = site ? getAppRef.current(nsiteAppId(site.host)) : undefined;
      notify({
        id: n.id,
        source: guest
          ? guestSource(n, guest.webContentsId)
          : site
            ? { appId: siteApp?.id, name: siteApp?.name ?? `${site.host.slice(0, 12)}…`, origin: `nsite://${site.host}` }
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
        replaceKey: guest && n.tag
          ? `web\0${guest.origin}\0${n.tag}`
          : site && n.tag ? `napp\0${site.host}\0${n.tag}` : undefined,
        onActivate: (action) => {
          if (site) {
            // Open at once; the worker's notificationclick comes after.
            if (action === 'default') openSite(site.host, site.url);
            bridge.activate(n.id, action);
            return;
          }
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
    const offOpen = getNappHost()?.onOpen(({ host, url }) => openSite(host, url));
    return () => {
      offShow();
      offClose();
      offOpen?.();
    };
  }, [focus, open]);

  useCloseBlockedSites();

  return null;
}

/**
 * A site whose notifications were turned off (in Settings, its site info or
 * a notification's menu) takes its notifications with it.
 */
function useCloseBlockedSites() {
  const { notifications } = useNotificationCenter();
  const hasSiteNotifications = notifications.some((n) => n.source.origin);
  const notificationsRef = useRef(notifications);
  useLayoutEffect(() => {
    notificationsRef.current = notifications;
  });

  useEffect(() => {
    const browser = getBrowserBridge();
    if (!browser || !hasSiteNotifications) return;
    return browser.onSitePermissionsChanged(() => {
      void browser.listSitePermissions('notifications').then((sites) => {
        const allowed = new Set(sites.filter((s) => s.allow).map((s) => s.origin));
        const origins = new Set(notificationsRef.current.map((n) => n.source.origin));
        for (const origin of origins) if (origin && !allowed.has(origin)) closeNotificationsFrom(origin);
      }, () => {});
    });
  }, [hasSiteNotifications]);
}
