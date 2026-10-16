import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBluetoothBridge } from '@/lib/bluetooth';
import type { BluetoothStatus } from '@/lib/bluetooth';

/**
 * TanStack Query hooks over the OS Bluetooth bridge (window.bluetooth).
 *
 * Status refreshes on BlueZ change events (SystemEventsHost); the poll is a
 * fallback, quicker while a scan runs in case the event monitor is missing.
 * Mutations invalidate all Bluetooth state so the UI converges.
 */

const BLUETOOTH_STATUS_KEY = ['bluetooth', 'status'] as const;

function requireBridge() {
  const bluetooth = getBluetoothBridge();
  if (!bluetooth) throw new Error('Bluetooth bridge unavailable');
  return bluetooth;
}

/** Adapter state and known/nearby devices. */
export function useBluetoothStatus() {
  const bluetooth = getBluetoothBridge();
  return useQuery<BluetoothStatus>({
    queryKey: BLUETOOTH_STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: bluetooth !== undefined,
    refetchInterval: (query) => (query.state.data?.discovering ? 5_000 : 30_000),
    retry: false,
  });
}

/** Bluetooth write operations; each invalidates all cached Bluetooth state. */
export function useBluetoothMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bluetooth'] });

  const setPowered = useMutation({
    mutationFn: (powered: boolean) => requireBridge().setPowered(powered),
    onSuccess: (status: BluetoothStatus) => queryClient.setQueryData(BLUETOOTH_STATUS_KEY, status),
    onSettled: invalidate,
  });

  const scan = useMutation({
    mutationFn: () => requireBridge().scan(),
    onSettled: invalidate,
  });

  const pair = useMutation({
    mutationFn: (address: string) => requireBridge().pair(address),
    onSettled: invalidate,
  });

  const connect = useMutation({
    mutationFn: (address: string) => requireBridge().connect(address),
    onSettled: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: (address: string) => requireBridge().disconnect(address),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (address: string) => requireBridge().remove(address),
    onSettled: invalidate,
  });

  return { setPowered, scan, pair, connect, disconnect, remove };
}
