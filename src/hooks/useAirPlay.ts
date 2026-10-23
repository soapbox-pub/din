import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAirPlayBridge, type AirPlayMode, type AirPlayState } from '@/lib/airplay';

const AIRPLAY_KEY = ['airplay', 'state'] as const;

function requireBridge() {
  const airplay = getAirPlayBridge();
  if (!airplay) throw new Error('AirPlay bridge unavailable');
  return airplay;
}

/**
 * Nearby AirPlay receivers and the sessions in progress. The main process
 * pushes the whole state whenever it changes, so this never polls.
 */
export function useAirPlayState() {
  const airplay = getAirPlayBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!airplay) return;
    return airplay.onChanged((state) => queryClient.setQueryData(AIRPLAY_KEY, state));
  }, [airplay, queryClient]);

  return useQuery<AirPlayState>({
    queryKey: AIRPLAY_KEY,
    queryFn: () => requireBridge().state(),
    enabled: airplay !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/** Look for receivers whenever a component showing them mounts. */
export function useAirPlayScan(enabled = true) {
  useEffect(() => {
    if (enabled) void getAirPlayBridge()?.scan().catch(() => {});
  }, [enabled]);
}

export function useAirPlayActions() {
  return {
    connect: useMutation({
      mutationFn: (target: string) => requireBridge().connect(target),
    }),
    mode: useMutation({
      mutationFn: ({ target, mode }: { target: string; mode: AirPlayMode }) =>
        requireBridge().mode(target, mode),
    }),
    disconnect: useMutation({
      mutationFn: (target: string) => requireBridge().disconnect(target),
    }),
    code: useMutation({
      mutationFn: ({ target, code }: { target: string; code: string }) =>
        requireBridge().code(target, code),
    }),
  };
}
