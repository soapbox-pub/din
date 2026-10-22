import { useEffect, useState } from 'react';
import { getUpdaterBridge } from '@/lib/updater';
import type { UpdateState } from '@/lib/updater';

/** DinOS's versions and the update in progress, kept current by the main process. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const bridge = getUpdaterBridge();
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
