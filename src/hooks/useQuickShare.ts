import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getQuickShareBridge, type QuickShareState } from '@/lib/quickShare';

const QUICK_SHARE_KEY = ['quick-share', 'state'] as const;

function requireBridge() {
  const quickShare = getQuickShareBridge();
  if (!quickShare) throw new Error('Quick Share isn’t available here');
  return quickShare;
}

/** Whether this computer shows up in Quick Share; main pushes changes, so this never polls. */
export function useQuickShareState() {
  const quickShare = getQuickShareBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!quickShare) return;
    return quickShare.onChanged((state) => queryClient.setQueryData(QUICK_SHARE_KEY, state));
  }, [quickShare, queryClient]);

  return useQuery<QuickShareState>({
    queryKey: QUICK_SHARE_KEY,
    queryFn: () => requireBridge().state(),
    enabled: quickShare !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

export function useSetQuickShareEnabled() {
  return useMutation({ mutationFn: (on: boolean) => requireBridge().setEnabled(on) });
}
