import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAudioBridge } from '@/lib/audio';
import type { AudioStatus } from '@/lib/audio';

/**
 * TanStack Query hooks over the OS audio bridge (window.audio).
 *
 * Status polls on a short interval so the menu-bar control and Settings panel
 * track volume changes made elsewhere (media keys, wpctl in the Terminal).
 * Mutations resolve to the new state and write it straight into the cache so
 * the UI updates without waiting for the next poll.
 */

const AUDIO_STATUS_KEY = ['audio', 'status'] as const;

function requireBridge() {
  const audio = getAudioBridge();
  if (!audio) throw new Error('Audio bridge unavailable');
  return audio;
}

/** Default sink volume/mute (polls every few seconds). */
export function useAudioStatus() {
  const audio = getAudioBridge();
  return useQuery<AudioStatus>({
    queryKey: AUDIO_STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: audio !== undefined,
    refetchInterval: 5_000,
    retry: false,
  });
}

/** Volume/mute write operations; each primes the cache with the new state. */
export function useAudioMutations() {
  const queryClient = useQueryClient();
  const prime = (status: AudioStatus) => queryClient.setQueryData(AUDIO_STATUS_KEY, status);

  const setVolume = useMutation({
    mutationFn: (percent: number) => requireBridge().setVolume(percent),
    onSuccess: prime,
  });

  const setMuted = useMutation({
    mutationFn: (muted: boolean) => requireBridge().setMuted(muted),
    onSuccess: prime,
  });

  return { setVolume, setMuted };
}
