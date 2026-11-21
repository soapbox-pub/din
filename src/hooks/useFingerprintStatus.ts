import { useQuery } from '@tanstack/react-query';
import { FINGERPRINT_STATUS_KEY, type LockBridge } from '@/lib/lock';

export function useFingerprintStatus(bridge: LockBridge | undefined) {
  return useQuery({
    queryKey: FINGERPRINT_STATUS_KEY,
    queryFn: () => bridge?.fingerprintStatus() ?? null,
    enabled: !!bridge,
    retry: false,
    refetchInterval: 15_000,
  });
}
