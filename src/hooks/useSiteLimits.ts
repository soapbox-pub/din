import { useEffect, useState } from 'react';
import { getSiteLimitsBridge, type SiteLimitBlock, type SiteLimitSettings } from '@/lib/siteLimits';

/**
 * The sites the user limited and their time today, kept current with the
 * main process. Null until they arrive, and always outside the Electron shell.
 */
export function useSiteLimitSettings(): SiteLimitSettings | null {
  const [settings, setSettings] = useState<SiteLimitSettings | null>(null);

  useEffect(() => {
    const bridge = getSiteLimitsBridge();
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.onSettings(setSettings);
    bridge.get().then((initial) => {
      if (live) setSettings(initial);
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return settings;
}

/** The limit's page over a guest, or null while it shows its own. */
export function useSiteLimitBlock(wcId: number | null): SiteLimitBlock | null {
  const [state, setState] = useState<{ wcId: number | null; block: SiteLimitBlock | null }>({ wcId, block: null });

  useEffect(() => {
    const bridge = getSiteLimitsBridge();
    if (!bridge || wcId === null) return;
    let live = true;
    const unsubscribe = bridge.onBlock((update) => {
      if (update.wcId === wcId) setState({ wcId, block: update.block });
    });
    bridge.blockOf(wcId).then((block) => {
      if (live) setState((prev) => (prev.wcId === wcId && prev.block ? prev : { wcId, block }));
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [wcId]);

  return state.wcId === wcId ? state.block : null;
}
