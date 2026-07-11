import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWifiBridge } from '@/lib/wifi';
import type { WifiNetwork, WifiStatus } from '@/lib/wifi';

/**
 * TanStack Query hooks over the OS WiFi bridge (window.wifi).
 *
 * Status and scan results poll on a short interval so the Settings panel
 * tracks connection changes made elsewhere (e.g. nmcli in the Terminal app).
 * Mutations invalidate everything WiFi so the UI converges after connects,
 * disconnects and forgets.
 */

function requireBridge() {
  const wifi = getWifiBridge();
  if (!wifi) throw new Error('WiFi bridge unavailable');
  return wifi;
}

/** Adapter/radio/connection state (polls every few seconds). */
export function useWifiStatus() {
  const wifi = getWifiBridge();
  return useQuery<WifiStatus>({
    queryKey: ['wifi', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: wifi !== undefined,
    refetchInterval: 5_000,
    retry: false,
  });
}

/** Visible networks. `enabled` should be false while the radio is off. */
export function useWifiNetworks(enabled: boolean) {
  const wifi = getWifiBridge();
  return useQuery<WifiNetwork[]>({
    queryKey: ['wifi', 'networks'],
    queryFn: () => requireBridge().networks(),
    enabled: wifi !== undefined && enabled,
    refetchInterval: 15_000,
    retry: false,
  });
}

/** Names of saved network profiles. */
export function useSavedNetworks() {
  const wifi = getWifiBridge();
  return useQuery<string[]>({
    queryKey: ['wifi', 'saved'],
    queryFn: () => requireBridge().saved(),
    enabled: wifi !== undefined,
    staleTime: 10_000,
    retry: false,
  });
}

/** WiFi write operations; each invalidates all cached WiFi state. */
export function useWifiMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['wifi'] });

  const connect = useMutation({
    mutationFn: ({ ssid, password }: { ssid: string; password?: string }) =>
      requireBridge().connect(ssid, password),
    onSettled: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: () => requireBridge().disconnect(),
    onSettled: invalidate,
  });

  const forget = useMutation({
    mutationFn: (ssid: string) => requireBridge().forget(ssid),
    onSettled: invalidate,
  });

  const setRadio = useMutation({
    mutationFn: (enabled: boolean) => requireBridge().setRadio(enabled),
    onSettled: invalidate,
  });

  return { connect, disconnect, forget, setRadio };
}
