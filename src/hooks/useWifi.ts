import { useEffect } from 'react';
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
 * TanStack Query hooks over the OS WiFi bridge (window.dinos.wifi).
 *
 * Status and the networks poll on a short interval so the Settings panel
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

/** How many lists of networks are on screen, and so want scanning for. */
let listsShown = 0;

/**
 * Visible networks. `enabled` should be false while the radio is off.
 *
 * `scan` is for a list of them someone is looking at (the menu bar's panel,
 * Settings): while one is up, each poll has NetworkManager scan again if its
 * last scan is over 30 seconds old. Without one (the menu bar's glyph, which
 * is always there) a poll reads what NetworkManager has, the network it's on
 * and its signal among it, and leaves the radio alone: a scan takes it off
 * its channel for seconds at a time, which a call or a game can feel.
 */
export function useWifiNetworks(enabled: boolean, { scan = false }: { scan?: boolean } = {}) {
  const wifi = getWifiBridge();
  const queryClient = useQueryClient();
  const scans = scan && enabled && wifi !== undefined;
  useEffect(() => {
    if (!scans) return;
    listsShown += 1;
    // What's there is as old as NetworkManager's own last scan.
    if (listsShown === 1) void queryClient.invalidateQueries({ queryKey: ['wifi', 'networks'] });
    return () => {
      listsShown -= 1;
    };
  }, [scans, queryClient]);
  return useQuery<WifiNetwork[]>({
    queryKey: ['wifi', 'networks'],
    queryFn: () => requireBridge().networks(listsShown > 0 ? 'auto' : 'none'),
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
    mutationFn: () => requireBridge().networks('fresh'),
    onSuccess: (networks) => queryClient.setQueryData(['wifi', 'networks'], networks),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['wifi', 'status'] }),
  });

  return { connect, activate, disconnect, forget, update, add, setRadio, rescan };
}
