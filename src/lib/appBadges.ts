import { useSyncExternalStore } from 'react';

/**
 * What apps put on their Dock tiles themselves (navigator.setAppBadge()): a
 * count, or `'flag'` for a plain mark. Kept per window, since each window is
 * its own document; a tile shows its app's windows' badges together.
 */
export type AppBadge = number | 'flag';

let badges = new Map<string, { appId: string; badge: AppBadge }>();
const listeners = new Set<() => void>();

/** A window's badge, or null to clear it (it also goes when the window does). */
export function setWindowBadge(windowId: string, appId: string, badge: AppBadge | null): void {
  const current = badges.get(windowId);
  if (current?.badge === (badge ?? undefined) && current?.appId === appId) return;
  if (!current && badge === null) return;
  badges = new Map(badges);
  if (badge === null) badges.delete(windowId);
  else badges.set(windowId, { appId, badge });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every app's badge: the sum of its windows' counts, or a mark if they only set marks. */
export function useAppBadges(): Map<string, AppBadge> {
  const all = useSyncExternalStore(subscribe, () => badges);
  const byApp = new Map<string, AppBadge>();
  for (const { appId, badge } of all.values()) {
    const prev = byApp.get(appId);
    byApp.set(appId, typeof badge === 'number' ? (typeof prev === 'number' ? prev : 0) + badge : (prev ?? 'flag'));
  }
  return byApp;
}
