import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBrightnessBridge } from '@/lib/brightness';
import type { BrightnessBridge, BrightnessStatus } from '@/lib/brightness';

/**
 * TanStack Query hooks over the OS brightness bridge (window.dinos.brightness).
 *
 * Status polls on a short interval so the menu-bar control and Settings panel
 * track changes made elsewhere (media keys, brightnessctl in the Terminal).
 * Mutations resolve to the new state and write it straight into the cache so
 * the UI updates without waiting for the next poll.
 */

const BRIGHTNESS_STATUS_KEY = ['brightness', 'status'] as const;

function requireBridge() {
  const brightness = getBrightnessBridge();
  if (!brightness) throw new Error('Brightness bridge unavailable');
  return brightness;
}

// The level a slider is being dragged through, before it's committed, so the
// software dimming (ScreenDimmer) can follow the drag live.
let preview: number | null = null;
const previewListeners = new Set<() => void>();

/** Show a brightness level being dragged through, or null when the drag ends. */
export function setBrightnessPreview(level: number | null): void {
  if (level === preview) return;
  preview = level;
  previewListeners.forEach((listener) => listener());
}

/** The level a brightness slider is being dragged through, or null. */
export function useBrightnessPreview(): number | null {
  return useSyncExternalStore(
    (listener) => {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    () => preview,
  );
}

/** Backlight level + night-light state (polls every few seconds). */
export function useBrightnessStatus() {
  const brightness = getBrightnessBridge();
  return useQuery<BrightnessStatus>({
    queryKey: BRIGHTNESS_STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: brightness !== undefined,
    refetchInterval: 5_000,
    retry: false,
  });
}

/** Brightness/night-light write operations; each primes the cache with the new state. */
export function useBrightnessMutations() {
  const queryClient = useQueryClient();
  const prime = (status: BrightnessStatus) =>
    queryClient.setQueryData(BRIGHTNESS_STATUS_KEY, status);

  const setBrightness = useMutation({
    mutationFn: (percent: number) => requireBridge().setBrightness(percent),
    // Take over from the drag preview right away, so the dimming doesn't
    // flash back to the old level while the bridge call is in flight.
    onMutate: async (percent) => {
      await queryClient.cancelQueries({ queryKey: BRIGHTNESS_STATUS_KEY });
      queryClient.setQueryData<BrightnessStatus>(BRIGHTNESS_STATUS_KEY, (old) =>
        old ? { ...old, brightness: percent } : old,
      );
      setBrightnessPreview(null);
    },
    onSuccess: prime,
    onError: () => queryClient.invalidateQueries({ queryKey: BRIGHTNESS_STATUS_KEY }),
  });

  const setNightLight = useMutation({
    mutationFn: (enabled: boolean) => requireBridge().setNightLight(enabled),
    onSuccess: prime,
  });

  const setTemperature = useMutation({
    mutationFn: (kelvin: number) => requireBridge().setTemperature(kelvin),
    onSuccess: prime,
  });

  const setSchedule = useMutation({
    mutationFn: (schedule: Parameters<BrightnessBridge['setNightLightSchedule']>[0]) =>
      requireBridge().setNightLightSchedule(schedule),
    onSuccess: prime,
  });

  return { setBrightness, setNightLight, setTemperature, setSchedule };
}
