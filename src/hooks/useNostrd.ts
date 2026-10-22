import { useQuery } from '@tanstack/react-query';

import { nostrdCall, nostrdManagesAccounts, type NostrdStatus } from '@/lib/nostrd';

export const NOSTRD_STATUS_KEY = ['nostrd', 'status'] as const;

/**
 * nostrd's state: whether Din keeps its accounts there, and if so which
 * accounts it holds, which is active, and whether it's locked. NostrdSync
 * refreshes it on nostrd's events.
 */
export function useNostrd() {
  const { data: use = false } = useQuery({
    queryKey: ['nostrd', 'use'],
    queryFn: nostrdManagesAccounts,
    staleTime: Infinity,
  });

  const status = useQuery({
    queryKey: NOSTRD_STATUS_KEY,
    queryFn: () => nostrdCall<NostrdStatus>('status'),
    enabled: use,
    staleTime: Infinity,
    retry: false,
  });

  return { use, status: status.data };
}
