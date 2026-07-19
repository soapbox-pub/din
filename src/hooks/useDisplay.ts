import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDisplayBridge } from '@/lib/display';
import type { DisplayPlacement, DisplayStatus } from '@/lib/display';

/**
 * TanStack Query hooks over the OS display bridge (window.display).
 *
 * Status polls on a short interval so the Settings panel tracks changes made
 * elsewhere (e.g. xrandr in the Terminal app, or the automatic lid-close
 * re-arrangement in the main process). Applying a layout invalidates the
 * status so the UI converges on the new arrangement.
 */

function requireBridge() {
  const display = getDisplayBridge();
  if (!display) throw new Error('Display bridge unavailable');
  return display;
}

/** Connected outputs and their modes/positions (polls every few seconds). */
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

/** Apply a complete output arrangement; invalidates cached display state. */
export function useApplyDisplayLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (placements: DisplayPlacement[]) => requireBridge().applyLayout(placements),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['display'] }),
  });
}
