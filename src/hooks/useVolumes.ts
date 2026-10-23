import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getVolumesBridge, type VolumesState } from '@/lib/volumes';

const VOLUMES_KEY = ['volumes', 'state'] as const;

function requireBridge() {
  const volumes = getVolumesBridge();
  if (!volumes) throw new Error('Volumes bridge unavailable');
  return volumes;
}

/**
 * The removable disks plugged in, mounted or not. The main process pushes
 * the whole state whenever it changes, so this never polls.
 */
export function useVolumes() {
  const volumes = getVolumesBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!volumes) return;
    return volumes.onChanged((state) => queryClient.setQueryData(VOLUMES_KEY, state));
  }, [volumes, queryClient]);

  return useQuery<VolumesState>({
    queryKey: VOLUMES_KEY,
    queryFn: () => requireBridge().state(),
    enabled: volumes !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

export function useVolumeActions() {
  return {
    mount: useMutation({ mutationFn: (id: string) => requireBridge().mount(id) }),
    eject: useMutation({ mutationFn: (id: string) => requireBridge().eject(id) }),
  };
}
