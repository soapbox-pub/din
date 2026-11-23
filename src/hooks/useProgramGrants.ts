import { useEffect, useState } from 'react';
import { getProgramSignerBridge, type ProgramGrants } from '@/lib/programSigner';

/**
 * The programs allowed always to sign as the user through nostrd, kept up to
 * date; null until read, or outside the Electron shell.
 */
export function useProgramGrants(): ProgramGrants | null {
  const [grants, setGrants] = useState<ProgramGrants | null>(null);
  useEffect(() => {
    const bridge = getProgramSignerBridge();
    if (!bridge) return;
    let live = true;
    const load = () =>
      void bridge
        .grants()
        .then((g) => live && setGrants(g))
        .catch(() => {});
    load();
    const off = bridge.onGrantsChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return grants;
}
