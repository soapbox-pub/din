import { useEffect, useState } from 'react';
import { getTorBridge, type TorStatus } from '@/lib/tor';

/**
 * Tor's status, kept current with the main process. Null until it arrives,
 * and always outside the Electron shell.
 */
export function useTorStatus(): TorStatus | null {
  const [status, setStatus] = useState<TorStatus | null>(null);

  useEffect(() => {
    const bridge = getTorBridge();
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.onStatus(setStatus);
    bridge.status().then((initial) => {
      if (live) setStatus(initial);
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return status;
}

/** The onion service a browser tab's page names (Onion-Location), or null. */
export function useOnionLocation(wcId: number | null): string | null {
  const [state, setState] = useState<{ wcId: number | null; url: string | null }>({ wcId, url: null });

  useEffect(() => {
    const bridge = getTorBridge();
    if (!bridge || wcId === null) return;
    let live = true;
    const unsubscribe = bridge.onOnionLocation((update) => {
      if (update.wcId === wcId) setState({ wcId, url: update.url });
    });
    bridge.onionLocation(wcId).then((url) => {
      if (live) setState({ wcId, url });
    }).catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [wcId]);

  return state.wcId === wcId ? state.url : null;
}
