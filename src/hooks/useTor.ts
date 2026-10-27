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
