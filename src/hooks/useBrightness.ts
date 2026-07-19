import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBrightnessBridge } from '@/lib/brightness';
import type { BrightnessStatus } from '@/lib/brightness';

/**
 * TanStack Query hooks over the OS brightness bridge (window.brightness).
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
    onSuccess: prime,
  });

  const setNightLight = useMutation({
    mutationFn: (enabled: boolean) => requireBridge().setNightLight(enabled),
    onSuccess: prime,
  });

  const setTemperature = useMutation({
    mutationFn: (kelvin: number) => requireBridge().setTemperature(kelvin),
    onSuccess: prime,
  });

  return { setBrightness, setNightLight, setTemperature };
}
