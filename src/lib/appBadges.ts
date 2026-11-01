import { useSyncExternalStore } from 'react';

/**
 * What apps put on their Dock tiles themselves: a count, or `'flag'` for a
 * plain mark. Kept by where each came from, which says when it goes:
 *
 * - `window:<id>`: a built-in app's window (navigator.setAppBadge() in
 *   src/sdk/runtime.ts), cleared when the window closes, since each window
 *   is its own document;
 * - `system:<…>`: an installed web app's or nsite's site, from its pages or
 *   service worker, or a Linux app's LauncherEntry badge (all kept in the
 *   main process, see SystemNotificationsHost), until it clears it;
 * - `din:<…>`: Din's own, for something waiting in one of its apps (an
 *   update in Settings, see UpdateNotifier), until that's seen to.
 *
 * A tile shows its app's badges together.
 */
export type AppBadge = number | 'flag';

let badges = new Map<string, { appId: string; badge: AppBadge }>();
const listeners = new Set<() => void>();

function changed(next: Map<string, { appId: string; badge: AppBadge }>): void {
  badges = next;
  for (const listener of listeners) listener();
}

/** A badge, or null to clear it. */
function setBadge(key: string, appId: string, badge: AppBadge | null): void {
  const current = badges.get(key);
  if (current?.badge === (badge ?? undefined) && current?.appId === appId) return;
  if (!current && badge === null) return;
  const next = new Map(badges);
  if (badge === null) next.delete(key);
  else next.set(key, { appId, badge });
  changed(next);
}

/** A window's badge, or null to clear it (it also goes when the window does). */
export function setWindowBadge(windowId: string, appId: string, badge: AppBadge | null): void {
  setBadge(`window:${windowId}`, appId, badge);
}

/** One of Din's own badges, or null to clear it. */
export function setDinBadge(key: string, appId: string, badge: AppBadge | null): void {
  setBadge(`din:${key}`, appId, badge);
}

/** Replace every badge under a key prefix at once (the main process's, as resolved to apps). */
export function replaceBadges(prefix: string, entries: Map<string, { appId: string; badge: AppBadge }>): void {
  const next = new Map([...badges].filter(([key]) => !key.startsWith(prefix)));
  for (const [key, entry] of entries) next.set(`${prefix}${key}`, entry);
  changed(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every app's badge: the sum of its counts, or a mark if it only set marks. */
export function useAppBadges(): Map<string, AppBadge> {
  const all = useSyncExternalStore(subscribe, () => badges);
  const byApp = new Map<string, AppBadge>();
  for (const { appId, badge } of all.values()) {
    const prev = byApp.get(appId);
    byApp.set(appId, typeof badge === 'number' ? (typeof prev === 'number' ? prev : 0) + badge : (prev ?? 'flag'));
  }
  return byApp;
}
