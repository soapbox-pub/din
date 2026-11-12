import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBluetoothBridge,
  holdNearby,
  type BluetoothDevice,
  type BluetoothState,
  type NearbyDevice,
} from '@/lib/bluetooth';

const BLUETOOTH_KEY = ['bluetooth', 'state'] as const;

function requireBridge() {
  const bluetooth = getBluetoothBridge();
  if (!bluetooth) throw new Error('Bluetooth bridge unavailable');
  return bluetooth;
}

/**
 * The adapter, the devices it knows or sees, and any pairing prompt. The
 * main process pushes the whole state whenever it changes, so this never
 * polls.
 */
export function useBluetoothState() {
  const bluetooth = getBluetoothBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!bluetooth) return;
    return bluetooth.onChanged((state) => queryClient.setQueryData(BLUETOOTH_KEY, state));
  }, [bluetooth, queryClient]);

  return useQuery<BluetoothState>({
    queryKey: BLUETOOTH_KEY,
    queryFn: () => requireBridge().state(),
    enabled: bluetooth !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Look for devices nearby while a component showing them is mounted (and
 * the adapter is on). The main process stops a search after a couple of
 * minutes, so this asks again every minute.
 */
export function useBluetoothDiscovery(enabled: boolean) {
  useEffect(() => {
    const bluetooth = getBluetoothBridge();
    if (!bluetooth || !enabled) return;
    const start = () => void bluetooth.discover(true).catch(() => {});
    start();
    const timer = setInterval(start, 60_000);
    return () => {
      clearInterval(timer);
      void bluetooth.discover(false).catch(() => {});
    };
  }, [enabled]);
}

/**
 * The devices nearby to pair with, among `devices`, in an order that holds
 * still while the component showing them is mounted (holdNearby).
 */
export function useNearbyDevices(devices: readonly BluetoothDevice[] | undefined): NearbyDevice[] {
  const [seen, setSeen] = useState<readonly BluetoothDevice[] | undefined>(undefined);
  const [nearby, setNearby] = useState<NearbyDevice[]>([]);
  if (devices !== seen) {
    setSeen(devices);
    setNearby(holdNearby(nearby, devices ?? []));
  }
  return nearby;
}

export function useBluetoothActions() {
  return {
    setPowered: useMutation({ mutationFn: (on: boolean) => requireBridge().setPowered(on) }),
    pair: useMutation({ mutationFn: (path: string) => requireBridge().pair(path) }),
    connect: useMutation({ mutationFn: (path: string) => requireBridge().connect(path) }),
    disconnect: useMutation({ mutationFn: (path: string) => requireBridge().disconnect(path) }),
    forget: useMutation({ mutationFn: (path: string) => requireBridge().forget(path) }),
  };
}
