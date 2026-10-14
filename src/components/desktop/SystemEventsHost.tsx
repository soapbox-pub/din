import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

declare global {
  interface Window {
    /** Present only inside the Electron shell (see electron/preload.cjs). */
    systemEvents?: {
      onChanged(callback: (topic: string) => void): () => void;
    };
  }
}

/** Which cached queries each kind of system change makes stale. */
const QUERIES_BY_TOPIC: Record<string, string[][]> = {
  network: [['wifi'], ['vpn']],
  audio: [['audio']],
};

/**
 * Refreshes system status when it changes: the main process watches
 * NetworkManager and PipeWire and reports changes, so the menu bar and
 * Settings update right away while their polls can stay slow. Polling
 * every few seconds meant spawning tools from the main process on a timer,
 * which froze window drags each time.
 */
export function SystemEventsHost() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return window.systemEvents?.onChanged((topic) => {
      for (const queryKey of QUERIES_BY_TOPIC[topic] ?? []) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [queryClient]);

  return null;
}
