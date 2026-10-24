import { useEffect, useState } from 'react';
import { getFirmwareBridge } from '@/lib/firmware';
import type { FirmwareState } from '@/lib/firmware';

/** The firmware updates fwupd found and the one being installed, kept current by the main process. */
export function useFirmwareState(): FirmwareState | null {
  const [state, setState] = useState<FirmwareState | null>(null);

  useEffect(() => {
    const bridge = getFirmwareBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.state().then((initial) => {
      if (!cancelled) setState((current) => current ?? initial);
    });
    const unsubscribe = bridge.onProgress(setState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
