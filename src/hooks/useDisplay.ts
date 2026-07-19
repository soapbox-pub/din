import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDisplayBridge } from '@/lib/display';
import type { DisplayStatus } from '@/lib/display';

/**
 * TanStack Query hooks over the OS display bridge (window.display).
 *
 * Status polls on a short interval so the Settings panel tracks resolution
 * changes made elsewhere (e.g. xrandr in the Terminal app). Setting a mode
 * invalidates the status so the UI converges on the new resolution.
 */

function requireBridge() {
  const display = getDisplayBridge();
  if (!display) throw new Error('Display bridge unavailable');
  return display;
}

/** Connected outputs and their modes (polls every few seconds). */
export function useDisplayStatus() {
  const display = getDisplayBridge();
  return useQuery<DisplayStatus>({
    queryKey: ['display', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: display !== undefined,
    refetchInterval: 5_000,
    retry: false,
  });
}

/** Set an output's resolution; invalidates cached display state. */
export function useSetDisplayMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ output, width, height }: { output: string; width: number; height: number }) =>
      requireBridge().setMode(output, width, height),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['display'] }),
  });
}
