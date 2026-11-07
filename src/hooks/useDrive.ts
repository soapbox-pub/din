import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDriveSetupBridge, type DriveState, type DriveStatus } from '@/lib/drive';

export const DRIVE_STATE_KEY = ['drive', 'state'] as const;

/**
 * Whether Din Drive is on this computer and running, asked every few seconds
 * (the daemon doesn't push). Disabled where there's no bridge: a plain
 * browser, or an app without the `drive` permission.
 */
export function useDriveState(pollMs = 5_000) {
  const bridge = getDriveSetupBridge();
  return useQuery<DriveState>({
    queryKey: DRIVE_STATE_KEY,
    queryFn: () => bridge!.state(),
    enabled: bridge !== undefined,
    refetchInterval: pollMs,
    retry: false,
  });
}

/** Turn Drive on: find the account's drive, or create one, and mount it. */
export function useTurnOnDrive() {
  const queryClient = useQueryClient();
  return useMutation<DriveStatus>({
    mutationFn: () => getDriveSetupBridge()!.setUp(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['drive'] }),
  });
}
