import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWifiBridge } from '@/lib/wifi';
import type {
  NewWifiNetwork,
  SavedWifiNetwork,
  WifiChanges,
  WifiDetails,
  WifiNetwork,
  WifiStatus,
} from '@/lib/wifi';

/**
 * TanStack Query hooks over the OS WiFi bridge (window.wifi).
 *
 * Status and scan results poll on a short interval so the Settings panel
 * tracks connection changes made elsewhere (e.g. nmcli in the Terminal app).
 * Mutations invalidate everything WiFi so the UI converges after connects,
 * disconnects, edits and forgets.
 */

function requireBridge() {
  const wifi = getWifiBridge();
  if (!wifi) throw new Error('WiFi bridge unavailable');
  return wifi;
}

/**
 * Adapter/radio/connection state. Refreshed on NetworkManager change events
 * (SystemEventsHost); the poll is only a fallback.
 */
export function useWifiStatus() {
  const wifi = getWifiBridge();
  return useQuery<WifiStatus>({
    queryKey: ['wifi', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: wifi !== undefined,
    refetchInterval: 30_000,
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

/** Saved networks. */
export function useSavedNetworks() {
  const wifi = getWifiBridge();
  return useQuery<SavedWifiNetwork[]>({
    queryKey: ['wifi', 'saved'],
    queryFn: () => requireBridge().saved(),
    enabled: wifi !== undefined,
    staleTime: 10_000,
    retry: false,
  });
}

/** One saved network's settings and live link details. */
export function useWifiDetails(uuid: string) {
  const wifi = getWifiBridge();
  return useQuery<WifiDetails>({
    queryKey: ['wifi', 'details', uuid],
    queryFn: () => requireBridge().details(uuid),
    enabled: wifi !== undefined,
    refetchInterval: 10_000,
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

  const activate = useMutation({
    mutationFn: (uuid: string) => requireBridge().activate(uuid),
    onSettled: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: () => requireBridge().disconnect(),
    onSettled: invalidate,
  });

  const forget = useMutation({
    mutationFn: (uuid: string) => requireBridge().forget(uuid),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ uuid, changes }: { uuid: string; changes: WifiChanges }) =>
      requireBridge().update(uuid, changes),
    onSettled: invalidate,
  });

  const add = useMutation({
    mutationFn: (network: NewWifiNetwork) => requireBridge().add(network),
    onSettled: invalidate,
  });

  const setRadio = useMutation({
    mutationFn: (enabled: boolean) => requireBridge().setRadio(enabled),
    onSettled: invalidate,
  });

  /** A fresh scan (the refresh button), which replaces the visible networks. */
  const rescan = useMutation({
    mutationFn: () => requireBridge().networks(true),
    onSuccess: (networks) => queryClient.setQueryData(['wifi', 'networks'], networks),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['wifi', 'status'] }),
  });

  return { connect, activate, disconnect, forget, update, add, setRadio, rescan };
}
