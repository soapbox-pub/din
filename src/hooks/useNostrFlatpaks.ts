import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useManifestRelays } from '@/hooks/useNsiteCatalog';
import { useCatalogAuthors } from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
import {
  cleanFlatpakError,
  fetchFlatpakApp,
  fetchFlatpakCatalog,
  getFlatpaksBridge,
  installRequest,
  parseAppNaddr,
  type FlatpakProgress,
  type LinuxApp,
  type LinuxFormat,
  type FlatpakQuery,
  type InstalledFlatpak,
} from '@/lib/nostrFlatpaks';

/**
 * The App Store's Linux apps: NIP-82 apps with a Flatpak or an AppImage for
 * this computer (src/lib/nostrFlatpaks.ts), what of them is installed, and
 * installing and removing them through window.dinos.flatpaks.
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

function useQueryFn(): FlatpakQuery {
  const relays = useManifestRelays();
  return useCallback(
    (filters, signal) => relays.query(filters, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) }),
    [relays],
  );
}

/** The Linux apps Din's publishers, the user and the people they follow publish for this computer. */
export function useFlatpakCatalog(enabled = true) {
  const authors = useCatalogAuthors();
  const status = useFlatpakStatus();
  const platform = status.data?.available ? status.data.platform : null;
  const query = useQueryFn();
  return useQuery({
    queryKey: [...FLATPAKS_KEY, 'catalog', platform, authors],
    enabled: enabled && !!platform,
    queryFn: ({ signal }) => fetchFlatpakCatalog(authors, platform as string, query, signal),
    staleTime: 5 * 60_000,
  });
}

/** One app by its address, when it has a Flatpak or an AppImage for this computer. */
export function useFlatpakApp(address: { pubkey: string; identifier: string } | null) {
  const status = useFlatpakStatus();
  const platform = status.data?.available ? status.data.platform : null;
  const query = useQueryFn();
  return useQuery({
    queryKey: [...FLATPAKS_KEY, 'one', platform, address?.pubkey, address?.identifier],
    enabled: !!address && !!platform,
    queryFn: ({ signal }) => (address ? fetchFlatpakApp(address, platform as string, query, signal) : null),
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

/** How the app with this id is getting on being installed or removed, if it is. */
export function useFlatpakBusy(appId: string): FlatpakProgress | undefined {
  useSyncExternalStore(subscribeBusy, () => busyVersion);
  return busy.get(appId);
}

/**
 * Install (or update) and remove apps, sharing the work with the `din`
 * command (installFlatpak, removeFlatpak), refreshing what shows them.
 */
export function useFlatpakActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: INSTALLED_KEY });
  }, [queryClient]);

  const install = useCallback(async (app: LinuxApp, format: LinuxFormat, installed?: InstalledFlatpak) => {
    try {
      await installFlatpak(app, format);
      toast({
        title: installed ? `${app.name} is up to date` : `${app.name} installed`,
        description: installed ? `Version ${app.release.version}.` : 'Find it in the app launcher.',
      });
      return true;
    } catch (error) {
      toast({ title: `Couldn’t ${installed ? 'update' : 'install'} ${app.name}`, description: cleanFlatpakError(error), variant: 'destructive' });
      return false;
    } finally {
      refresh();
    }
  }, [refresh, toast]);

  const remove = useCallback(async (appId: string, name: string) => {
    try {
      await removeFlatpak(appId);
      toast({ title: `${name} removed` });
    } catch (error) {
      toast({ title: `Couldn’t remove ${name}`, description: cleanFlatpakError(error), variant: 'destructive' });
    } finally {
      refresh();
    }
  }, [refresh, toast]);

  return useMemo(() => ({ install, remove }), [install, remove]);
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

/** The Linux apps a search finds: by name and summary, or the one at a pasted address. */
export function useFlatpakMatches(query: string): { apps: LinuxApp[]; pending: boolean; isAddress: boolean } {
  const q = query.trim();
  const address = useMemo(() => parseAppNaddr(q), [q]);
  const catalog = useFlatpakCatalog(!!q && !address);
  const lookup = useFlatpakApp(address);
  const apps = useMemo(() => {
    if (!q) return [];
    if (address) return lookup.data ? [lookup.data] : [];
    const needle = q.toLowerCase();
    return (catalog.data ?? []).filter((app) =>
      [app.name, app.summary, app.identifier, ...app.categories].join('\u0000').toLowerCase().includes(needle));
  }, [q, address, lookup.data, catalog.data]);
  return { apps, pending: address ? lookup.isLoading : catalog.isLoading, isAddress: !!address };
}
