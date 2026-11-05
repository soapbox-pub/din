import { useEffect, useState } from 'react';
import { getFirewallBridge, type FirewallStatus } from '@/lib/firewall';

/**
 * The firewall's status, kept current with the main process. Null until it
 * arrives, and always outside the Electron shell.
 */
export function useFirewallStatus(): FirewallStatus | null {
  const [status, setStatus] = useState<FirewallStatus | null>(null);

  useEffect(() => {
    const bridge = getFirewallBridge();
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
