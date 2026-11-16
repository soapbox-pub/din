import { useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getFlatpaksBridge,
  installRequest,
  type FlatpakProgress,
  type LinuxApp,
  type LinuxFormat,
  type InstalledFlatpak,
} from '@/lib/nostrFlatpaks';

/**
 * Linux apps from Nostr on this computer: NIP-82 apps with a Flatpak or an
 * AppImage (src/lib/nostrFlatpaks.ts), what of them is installed, and
 * installing and removing them through window.dinos.flatpaks, for the App
 * Store (through din.store, dinHost/StoreHost.tsx) and the `din` command.
 */

export const FLATPAKS_KEY = ['nostr-flatpaks'] as const;
const INSTALLED_KEY = [...FLATPAKS_KEY, 'installed'] as const;

/** Which ways Linux apps install here, and this computer's NIP-82 platform; null outside the Din desktop app. */
export function useFlatpakStatus() {
  const bridge = getFlatpaksBridge();
  return useQuery({
    queryKey: [...FLATPAKS_KEY, 'status'],
    enabled: !!bridge,
    queryFn: async () => (await bridge?.status()) ?? null,
    staleTime: Infinity,
  });
}

/** The apps installed from Nostr, by Flatpak id. */
export function useInstalledFlatpaks() {
  const bridge = getFlatpaksBridge();
  return useQuery({
    queryKey: INSTALLED_KEY,
    enabled: !!bridge,
    queryFn: async () => new Map(((await bridge?.installed()) ?? []).map((app) => [app.appId, app])),
    staleTime: 30_000,
  });
}

// What's being installed or removed now, shared by every card and page showing the app.
const busy = new Map<string, FlatpakProgress>();
let busyVersion = 0;
const listeners = new Set<() => void>();
let unsubscribeBridge: (() => void) | null = null;

function setBusy(appId: string, progress: FlatpakProgress | null): void {
  if (progress) busy.set(appId, progress);
  else busy.delete(appId);
  busyVersion++;
  for (const listener of listeners) listener();
}

function subscribeBusy(listener: () => void): () => void {
  listeners.add(listener);
  unsubscribeBridge ??= getFlatpaksBridge()?.onProgress((progress) => {
    if (busy.has(progress.appId)) setBusy(progress.appId, progress);
  }) ?? null;
  return () => {
    listeners.delete(listener);
    if (!listeners.size && unsubscribeBridge) {
      unsubscribeBridge();
      unsubscribeBridge = null;
    }
  };
}

/** Every app being installed or removed now, and how far each has got. */
export function useFlatpaksBusy(): FlatpakProgress[] {
  const version = useSyncExternalStore(subscribeBusy, () => busyVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is what changes when `busy` does.
  return useMemo(() => [...busy.values()], [version]);
}

/** Install or update an app from its release, one way, showing it busy meanwhile. */
export async function installFlatpak(
  app: LinuxApp,
  format: LinuxFormat,
  onProgress?: (progress: FlatpakProgress) => void,
): Promise<InstalledFlatpak> {
  const bridge = getFlatpaksBridge();
  if (!bridge) throw new Error('Linux apps install in the Din desktop app');
  if (busy.has(app.identifier)) throw new Error(`${app.name} is already being installed`);
  const request = installRequest(app, format);
  setBusy(app.identifier, { appId: app.identifier, phase: 'download', percent: 0 });
  const off = onProgress ? bridge.onProgress((p) => p.appId === app.identifier && onProgress(p)) : null;
  try {
    return await bridge.install(request);
  } finally {
    off?.();
    setBusy(app.identifier, null);
  }
}

/** Uninstall an app installed from Nostr. */
export async function removeFlatpak(appId: string): Promise<void> {
  const bridge = getFlatpaksBridge();
  if (!bridge) throw new Error('Linux apps install in the Din desktop app');
  setBusy(appId, { appId, phase: 'remove' });
  try {
    await bridge.uninstall(appId);
  } finally {
    setBusy(appId, null);
  }
}

