import { useEffect, useState } from 'react';
import { getAdblockBridge, type AdblockSettings } from '@/lib/adblock';

/**
 * The ad blocker's settings, kept current with the main process. Null until
 * they arrive, and always outside the Electron shell.
 */
export function useAdblockSettings(): AdblockSettings | null {
  const [settings, setSettings] = useState<AdblockSettings | null>(null);

  useEffect(() => {
    const bridge = getAdblockBridge();
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.onSettings(setSettings);
    bridge.getSettings().then((initial) => {
      if (live) setSettings(initial);
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return settings;
}

/** How many requests the ad blocker has blocked on a tab's current page. */
export function useBlockedCount(wcId: number | null): number {
  const [state, setState] = useState({ wcId, count: 0 });

  useEffect(() => {
    const bridge = getAdblockBridge();
    if (!bridge || wcId === null) return;
    let live = true;
    const unsubscribe = bridge.onBlocked((update) => {
      if (update.wcId === wcId) setState({ wcId, count: update.count });
    });
    bridge.blockedCount(wcId).then((count) => {
      if (live) setState({ wcId, count });
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [wcId]);

  return state.wcId === wcId ? state.count : 0;
}
