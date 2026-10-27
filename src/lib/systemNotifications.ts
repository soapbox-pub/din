/**
 * Typed access to the system notifications bridge exposed by the Electron
 * preload (`window.systemNotifications`, see electron/preload.cjs +
 * electron/notifications.mts): notifications from Linux apps, which Din
 * receives as the desktop's org.freedesktop.Notifications server, and from
 * web pages in browser tabs and installed web apps. Absent outside the
 * Electron shell.
 */

import type { NotificationCloseReason, NotificationUrgency } from '@/lib/notificationCenter';

export interface SystemNotification {
  /** Opaque, unique while it lives. */
  id: string;
  appName: string;
  /** The installed app it belongs to, when known. */
  appId: string | null;
  /** The sender's icon, as a data URL. */
  icon: string | null;
  /** A picture to show beside the text, as a data URL. */
  image: string | null;
  title: string;
  /** Plain text. */
  body: string;
  actions: { id: string; label: string }[];
  urgency: NotificationUrgency;
  /** How long it stays up, in ms; -1 is Din's choice, 0 until dismissed. */
  timeout: number;
  /** Acting on it doesn't remove it. */
  resident: boolean;
  /** Not kept in the list once it's gone from the screen. */
  transient: boolean;
  /** For a web page's: the <webview> it came from. */
  guest: { webContentsId: number; origin: string } | null;
  /** A web page's tag: one with the same tag and origin replaces it. */
  tag: string;
  /**
   * For an installed nsite's (electron/napp.mts): its host, and where a click
   * opens it, or null for its front page.
   */
  site: { host: string; url: string | null } | null;
}

export interface SystemNotificationsBridge {
  onShow(callback: (notification: SystemNotification) => void): () => void;
  /** The sender closed one (its id). */
  onClose(callback: (id: string) => void): () => void;
  /** The user clicked it (`'default'`) or one of its actions. */
  activate(id: string, action: string): void;
  closed(id: string, reason: NotificationCloseReason): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    systemNotifications?: SystemNotificationsBridge;
  }
}

/** The system notifications bridge, or undefined outside the Electron shell. */
export function getSystemNotificationsBridge(): SystemNotificationsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.systemNotifications;
}
