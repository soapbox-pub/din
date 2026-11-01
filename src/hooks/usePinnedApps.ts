import { z } from 'zod';
import { useAppData } from '@/hooks/useAppData';
import { useNotificationCenter } from '@/lib/notificationCenter';
import { useAppBadges, type AppBadge } from '@/lib/appBadges';

/** Apps kept in the Dock (or taskbar) out of the box. */
const DEFAULT_PINNED = ['file-browser', 'settings', 'web-browser', 'app-store'];

const PinnedAppsSchema = z.array(z.string());

/**
 * The apps pinned to the Dock, in order, which the taskbar shares. They
 * belong to this device and never sync to relays, seeded from the
 * pre-app-data localStorage key on first run.
 */
export function usePinnedApps() {
  return useAppData<string[]>(
    'pinned-apps',
    PinnedAppsSchema,
    DEFAULT_PINNED,
    { legacyKey: 'desktop:pinned-apps', localOnly: true },
  );
}

/**
 * The badge on each Dock or taskbar tile, by the tile's app id (`tileOf`
 * says which tile an app's windows go under): what the tile's apps set on it
 * themselves (navigator.setAppBadge() from built-in apps, web apps and
 * nsites, a Linux app's LauncherEntry), else a count of their unread
 * notifications.
 */
export function useTileBadges(tileOf: (appId: string) => string): (tile: string) => AppBadge | null {
  const { notifications } = useNotificationCenter();
  const unread = new Map<string, number>();
  for (const n of notifications) {
    const appId = n.source.appId;
    if (!n.history || n.read || !appId) continue;
    const tile = tileOf(appId);
    unread.set(tile, (unread.get(tile) ?? 0) + 1);
  }
  const appBadges = useAppBadges();
  return (tile) => {
    let own: AppBadge | null = null;
    for (const [id, badge] of appBadges) {
      if (tileOf(id) !== tile) continue;
      own = typeof badge === 'number' ? (typeof own === 'number' ? own : 0) + badge : (own ?? 'flag');
    }
    return own ?? (unread.get(tile) || null);
  };
}
