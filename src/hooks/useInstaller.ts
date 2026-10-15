import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getInstallerBridge } from '@/lib/installer';
import type { InstallerStatus, InstallState } from '@/lib/installer';

/** Live boot status and the disks DinOS could be installed on. */
export function useInstallerStatus() {
  const installer = getInstallerBridge();
  return useQuery<InstallerStatus>({
    queryKey: ['installer', 'status'],
    queryFn: () => {
      const bridge = getInstallerBridge();
      if (!bridge) throw new Error('Installer bridge unavailable');
      return bridge.status();
    },
    enabled: installer !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/** Whether this is a live boot, where the Installer app is offered. */
export function useIsLiveBoot(): boolean {
  const { data } = useInstallerStatus();
  return data?.available === true && data.live;
}

/** The install in progress, kept current by the main process. */
export function useInstallState(): InstallState | null {
  const [state, setState] = useState<InstallState | null>(null);

  useEffect(() => {
    const bridge = getInstallerBridge();
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
