import { useEffect, useState } from 'react';
import { getPopupsBridge, type PopupSettings } from '@/lib/popups';

/**
 * The pop-up blocker's settings, kept current with the main process. Null
 * until they arrive, and always outside the Electron shell.
 */
export function usePopupSettings(): PopupSettings | null {
  const [settings, setSettings] = useState<PopupSettings | null>(null);

  useEffect(() => {
    const bridge = getPopupsBridge();
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

const NONE: string[] = [];

/** The pop-ups blocked on a tab's current page. */
export function useBlockedPopups(wcId: number | null): string[] {
  const [state, setState] = useState<{ wcId: number | null; urls: string[] }>({ wcId, urls: NONE });

  useEffect(() => {
    const bridge = getPopupsBridge();
    if (!bridge || wcId === null) return;
    let live = true;
    const unsubscribe = bridge.onBlocked((update) => {
      if (update.wcId === wcId) setState({ wcId, urls: update.urls });
    });
    bridge.blocked(wcId).then((urls) => {
      if (live) setState({ wcId, urls });
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [wcId]);

  return state.wcId === wcId ? state.urls : NONE;
}
