import { useSyncExternalStore } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Din's notification center: the one list every notification goes through,
 * whatever sent it - Din's own apps (`new Notification()` in the shell, see
 * webNotification.ts), Linux apps (org.freedesktop.Notifications, see
 * electron/notifications.mts), web pages in browser tabs and installed web
 * apps, and installed nsites (window.napp, see electron/napp.mts).
 *
 * A notification pops up in the corner (NotificationPopups) and stays in the
 * notification center (NotificationsIndicator) until it's dismissed or acted on. The
 * list lasts for the session.
 */

/** Why a notification went away, in org.freedesktop.Notifications' terms. */
export type NotificationCloseReason = 'expired' | 'dismissed' | 'closed';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

export interface NotificationAction {
  id: string;
  label: string;
}

/** Who sent a notification. */
export interface NotificationSource {
  /** An app Din knows (built-in, web app, or Linux app): its name and icon. */
  appId?: string | null;
  /** Shown when there's no app, or the app has no name of its own. */
  name: string;
  /** Image URL / data URL, or a Lucide icon. */
  icon?: LucideIcon | string | null;
  /**
   * The site whose notifications permission lets it notify (`https://…`,
   * `nsite://…`), so the user can turn it off from here.
   */
  origin?: string;
}

export interface DesktopNotification {
  id: string;
  source: NotificationSource;
  title: string;
  body: string;
  /** A picture beside the text (an avatar, a contact photo, an app's icon). */
  image?: string | null;
  /** Whether the picture is a person, drawn round. */
  imageRound?: boolean;
  /** A small icon on the picture's corner. */
  badge?: LucideIcon;
  actions: NotificationAction[];
  urgency: NotificationUrgency;
  /** How long the popup stays, in ms; 0 keeps it until dismissed. */
  timeout: number;
  /** Keep it in the notification center once the popup goes. */
  history: boolean;
  /** Acting on it doesn't remove it (org.freedesktop.Notifications' `resident`). */
  resident: boolean;
  /** Notifications with the same key replace each other (a web page's `tag`). */
  replaceKey?: string;
  /** Only the user, clicking it on screen, can act on it: the din command can't (approving sudo). */
  onScreenOnly?: boolean;
  createdAt: number;
  read: boolean;
  /** Clicked (`'default'`) or one of its actions picked. */
  onActivate?: (action: string) => void;
  onClose?: (reason: NotificationCloseReason) => void;
}

export type NotifyInput = Partial<Omit<DesktopNotification, 'source' | 'title' | 'createdAt' | 'read'>> &
  Pick<DesktopNotification, 'source' | 'title'>;

/** How long a popup stays by default. */
export const DEFAULT_POPUP_MS = 6000;
/** Most popups on screen at once; older ones drop off. */
const MAX_POPUPS = 3;
/** The list keeps this many; the oldest go first. */
const MAX_HISTORY = 100;
const DND_KEY = 'din.notifications.dnd';

interface State {
  notifications: DesktopNotification[];
  /** Ids currently popped up, newest first. */
  popups: string[];
  doNotDisturb: boolean;
}

function loadDoNotDisturb(): boolean {
  try {
    return localStorage.getItem(DND_KEY) === '1';
  } catch {
    return false;
  }
}

let state: State = { notifications: [], popups: [], doNotDisturb: loadDoNotDisturb() };
const listeners = new Set<() => void>();
let nextId = 1;

function setState(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Show a notification; returns its id. An existing id or `replaceKey` is replaced. */
export function notify(input: NotifyInput): string {
  const id = input.id ?? `n${nextId++}`;
  const notification: DesktopNotification = {
    urgency: 'normal',
    timeout: input.urgency === 'critical' ? 0 : DEFAULT_POPUP_MS,
    history: true,
    resident: false,
    ...input,
    // Callers (toast()) pass these through as undefined when unset.
    body: input.body ?? '',
    actions: input.actions ?? [],
    id,
    createdAt: Date.now(),
    read: false,
  };
  const replaced = state.notifications.filter(
    (n) => n.id === id || (input.replaceKey !== undefined && n.replaceKey === input.replaceKey),
  );
  const gone = new Set(replaced.map((n) => n.id));
  const popUp = !state.doNotDisturb || notification.urgency === 'critical';
  setState({
    ...state,
    notifications: [notification, ...state.notifications.filter((n) => !gone.has(n.id))].slice(0, MAX_HISTORY),
    popups: popUp
      ? [id, ...state.popups.filter((p) => !gone.has(p))].slice(0, MAX_POPUPS)
      : state.popups.filter((p) => !gone.has(p)),
  });
  // A replaced web notification is gone for good; one replaced in place
  // (same id: org.freedesktop.Notifications' replaces_id) lives on.
  for (const old of replaced) if (old.id !== id) old.onClose?.('closed');
  // Popups pushed off the stack, with no list to land in, are done.
  for (const n of state.notifications) {
    if (!n.history && !state.popups.includes(n.id)) remove(n.id, 'expired');
  }
  return id;
}

function remove(id: string, reason: NotificationCloseReason): void {
  const notification = state.notifications.find((n) => n.id === id);
  if (!notification) return;
  setState({
    ...state,
    notifications: state.notifications.filter((n) => n.id !== id),
    popups: state.popups.filter((p) => p !== id),
  });
  notification.onClose?.(reason);
}

/** Remove a notification: the user dismissed it, or its sender closed it. */
export function closeNotification(id: string, reason: NotificationCloseReason = 'dismissed'): void {
  remove(id, reason);
}

/** The popup timed out: it stays in the list, unless it's not kept there. */
export function expirePopup(id: string): void {
  const notification = state.notifications.find((n) => n.id === id);
  if (!notification) return;
  if (!notification.history) {
    remove(id, 'expired');
    return;
  }
  setState({ ...state, popups: state.popups.filter((p) => p !== id) });
}

/** The user clicked a notification (`'default'`) or one of its actions. */
export function activateNotification(id: string, action = 'default'): void {
  const notification = state.notifications.find((n) => n.id === id);
  if (!notification) return;
  notification.onActivate?.(action);
  if (notification.resident) {
    setState({ ...state, popups: state.popups.filter((p) => p !== id) });
  } else {
    remove(id, 'dismissed');
  }
}

/** Take down every notification from a site (it may no longer notify). */
export function closeNotificationsFrom(origin: string): void {
  for (const n of [...state.notifications]) if (n.source.origin === origin) remove(n.id, 'closed');
}

/**
 * Take down the notification with this `replaceKey`, if it's still there:
 * its sender saw to what it was about (a web page's `Notification.close()`).
 */
export function closeNotificationByKey(replaceKey: string): void {
  for (const n of [...state.notifications]) if (n.replaceKey === replaceKey) remove(n.id, 'closed');
}

/** Dismiss everything in the list. */
export function clearNotifications(): void {
  for (const n of [...state.notifications]) remove(n.id, 'dismissed');
}

export function markNotificationsRead(): void {
  if (!state.notifications.some((n) => !n.read)) return;
  setState({ ...state, notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })) });
}

/** Do Not Disturb: notifications still reach the list, but only critical ones pop up. */
export function setDoNotDisturb(on: boolean): void {
  try {
    localStorage.setItem(DND_KEY, on ? '1' : '0');
  } catch {
    // Best-effort: it still applies for this session.
  }
  setState({ ...state, doNotDisturb: on, popups: on ? state.popups.filter((id) => isCritical(id)) : state.popups });
}

function isCritical(id: string): boolean {
  return state.notifications.find((n) => n.id === id)?.urgency === 'critical';
}

function getState(): State {
  return state;
}

/** The notification center's state now (the `din` command's). */
export function getNotificationState(): Readonly<State> {
  return state;
}

/** The notification center's state, re-rendering on every change. */
export function useNotificationCenter(): State {
  return useSyncExternalStore(subscribe, getState);
}
