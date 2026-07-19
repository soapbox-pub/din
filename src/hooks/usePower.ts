import { useQuery } from '@tanstack/react-query';
import { getPowerBridge } from '@/lib/power';
import type { PowerStatus } from '@/lib/power';

/**
 * TanStack Query hook over the OS power bridge (window.power).
 *
 * Polls on a short interval so the menu-bar indicator and Settings panel track
 * charge level and charging state as they change.
 */
export function useBatteryStatus() {
  const power = getPowerBridge();
  return useQuery<PowerStatus>({
    queryKey: ['power', 'status'],
    queryFn: () => {
      const bridge = getPowerBridge();
      if (!bridge) throw new Error('Power bridge unavailable');
      return bridge.status();
    },
    enabled: power !== undefined,
    refetchInterval: 10_000,
    retry: false,
  });
}
