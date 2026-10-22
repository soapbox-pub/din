import { useEffect, useState } from 'react';
import { getBunkerBridge, type BunkerConnection } from '@/lib/bunkerBridge';

/** Din's NIP-46 connections, kept current. Null outside the Electron shell, or until loaded. */
export function useBunkerConnections(): BunkerConnection[] | null {
  const [connections, setConnections] = useState<BunkerConnection[] | null>(null);

  useEffect(() => {
    const bridge = getBunkerBridge();
    if (!bridge) return;
    let live = true;
    bridge.list().then((list) => live && setConnections(list), () => live && setConnections([]));
    const off = bridge.onChange((list) => setConnections(list));
    return () => {
      live = false;
      off();
    };
  }, []);

  return connections;
}
