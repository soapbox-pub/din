import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAudioBridge } from '@/lib/audio';
import type { AudioDevices, AudioStatus, AudioStreams } from '@/lib/audio';

/**
 * TanStack Query hooks over the OS audio bridge (window.dinos.audio).
 *
 * Status refreshes on PipeWire change events (SystemEventsHost), so the
 * menu-bar control and Settings panel track volume changes made elsewhere
 * (media keys, wpctl in the Terminal); a slow poll backs that up.
 * Mutations resolve to the new state and write it straight into the cache so
 * the UI updates without waiting for the next poll.
 */

const AUDIO_STATUS_KEY = ['audio', 'status'] as const;
export const AUDIO_INPUT_KEY = ['audio', 'input'] as const;
const AUDIO_DEVICES_KEY = ['audio', 'devices'] as const;
const AUDIO_STREAMS_KEY = ['audio', 'streams'] as const;

function requireBridge() {
  const audio = getAudioBridge();
  if (!audio) throw new Error('Audio bridge unavailable');
  return audio;
}

/** Default sink volume/mute. */
export function useAudioStatus() {
  const audio = getAudioBridge();
  return useQuery<AudioStatus>({
    queryKey: AUDIO_STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: audio !== undefined,
    // Refreshed on PipeWire change events (SystemEventsHost); the poll is
    // only a fallback.
    refetchInterval: 30_000,
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

/** Default source (microphone) volume/mute. */
export function useAudioInputStatus() {
  const audio = getAudioBridge();
  return useQuery<AudioStatus>({
    queryKey: AUDIO_INPUT_KEY,
    queryFn: () => requireBridge().inputStatus(),
    enabled: audio !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Microphone volume/mute writes; each primes the cache with the new state. */
export function useAudioInputMutations() {
  const queryClient = useQueryClient();
  const prime = (status: AudioStatus) => queryClient.setQueryData(AUDIO_INPUT_KEY, status);

  const setVolume = useMutation({
    mutationFn: (percent: number) => requireBridge().setInputVolume(percent),
    onSuccess: prime,
  });

  const setMuted = useMutation({
    mutationFn: (muted: boolean) => requireBridge().setInputMuted(muted),
    onSuccess: prime,
  });

  return { setVolume, setMuted };
}

/** Output (sink) and input (source) devices. */
export function useAudioDevices() {
  const audio = getAudioBridge();
  return useQuery<AudioDevices>({
    queryKey: AUDIO_DEVICES_KEY,
    queryFn: () => requireBridge().devices(),
    enabled: audio !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Per-application playback streams (refreshed as apps come and go). */
export function useAudioStreams() {
  const audio = getAudioBridge();
  return useQuery<AudioStreams>({
    queryKey: AUDIO_STREAMS_KEY,
    queryFn: () => requireBridge().streams(),
    enabled: audio !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * Device selection, per-node volume/mute and the test tone. Writes invalidate
 * all cached audio state so the panel converges; `setDefault` also primes the
 * device list from its result to avoid a flash.
 */
export function useAudioDeviceMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['audio'] });

  const setDefault = useMutation({
    mutationFn: (id: number) => requireBridge().setDefault(id),
    onSuccess: (devices: AudioDevices) =>
      queryClient.setQueryData(AUDIO_DEVICES_KEY, devices),
    onSettled: invalidate,
  });

  const selectPort = useMutation({
    mutationFn: ({ card, port }: { card: string; port: string }) =>
      requireBridge().selectPort(card, port),
    onSuccess: (devices: AudioDevices) =>
      queryClient.setQueryData(AUDIO_DEVICES_KEY, devices),
    onSettled: invalidate,
  });

  const setNodeVolume = useMutation({
    mutationFn: ({ id, percent }: { id: number; percent: number }) =>
      requireBridge().setNodeVolume(id, percent),
    onSettled: invalidate,
  });

  const setNodeMuted = useMutation({
    mutationFn: ({ id, muted }: { id: number; muted: boolean }) =>
      requireBridge().setNodeMuted(id, muted),
    onSettled: invalidate,
  });

  const test = useMutation({
    mutationFn: (id: number) => requireBridge().test(id),
  });

  return { setDefault, selectPort, setNodeVolume, setNodeMuted, test };
}
