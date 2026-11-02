import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrFilter } from '@nostrify/nostrify';
import { z } from 'zod';
import { useAppContext } from '@/hooks/useAppContext';
import { useAppData } from '@/hooks/useAppData';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useManifestRelays } from '@/hooks/useNsiteCatalog';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import { getCrxBridge } from '@/lib/crx';
import {
  extensionCatalog,
  extensionCatalogSync,
  getExtensionCatalogVersion,
  ingestPublished,
  isExtensionCatalogLoaded,
  loadExtensionCatalog,
  subscribeExtensionCatalog,
  syncExtensionCatalog,
} from '@/lib/extensionCatalog';
import { getFsBridge } from '@/lib/fs';
import { getIconThemeBridge } from '@/lib/iconTheme';
import { NSITE_CATALOG_PUBKEYS } from '@/lib/nsiteCatalog';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import {
  PACKAGE_KIND,
  buildPackageCatalog,
  fetchThemePackage,
  installThemePackage,
  installedPackages,
  applyTheme,
  packageDeletion,
  packageDeletionsFilter,
  removeTheme,
  type ExtensionKeyStore,
  type InstallDeps,
  type PackageAddress,
  type PackageType,
  type PublishDeps,
  type ThemePackage,
} from '@/lib/themePackages';

/** The query that lists the browser's installed extensions (useCrxExtensions). */
export const CRX_EXTENSIONS_KEY = ['crx', 'extensions'] as const;

/** The browser's installed extensions, or null outside the Din desktop app. */
export function useCrxExtensions() {
  return useQuery({
    queryKey: CRX_EXTENSIONS_KEY,
    queryFn: async () => (await getCrxBridge()?.listExtensions()) ?? null,
  });
}

/** What a store tab lists, and how far it's got. */
export interface PackageCatalogState {
  packages: ThemePackage[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => unknown;
  refresh: () => unknown;
  refreshing: boolean;
}

/**
 * about:extensions' catalog (src/lib/extensionCatalog.ts): what's on disk at
 * once, synced from relays in the background on opening and on refresh.
 */
export function useExtensionCatalog(): PackageCatalogState {
  const relays = useManifestRelays();
  const authors = useCatalogAuthors();
  const version = useSyncExternalStore(subscribeExtensionCatalog, getExtensionCatalogVersion);

  const sync = useCallback(
    () =>
      syncExtensionCatalog(
        (filters, signal) => relays.query(filters, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]) }),
        authors,
      ).catch(() => {}),
    [relays, authors],
  );

  useEffect(() => {
    void loadExtensionCatalog();
    void sync();
  }, [sync]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is what changes when the store does.
  const packages = useMemo(() => extensionCatalog(authors), [authors, version]);
  const loaded = isExtensionCatalogLoaded();
  const { syncing, failed } = extensionCatalogSync();
  return {
    packages,
    isLoading: !loaded || (syncing && packages.length === 0),
    isError: failed && packages.length === 0,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
    refresh: sync,
    refreshing: syncing && packages.length > 0,
  };
}

const ExtensionKeysSchema = z.record(z.string(), z.string());
const NO_KEYS: Record<string, string> = {};

/**
 * The keys the user's own extensions are signed with when published from a
 * folder, by `d`: each one's id, so they roam with the user's encrypted app
 * data (computer.din.extension-keys) to publish the same extension from
 * another computer.
 */
export function useExtensionKeys(): ExtensionKeyStore {
  const [keys, setKeys] = useAppData('extension-keys', ExtensionKeysSchema, NO_KEYS);
  const current = useRef(keys);
  useEffect(() => {
    current.current = keys;
  }, [keys]);
  return useMemo(() => ({
    all: () => current.current,
    set: (identifier, pem) => {
      current.current = { ...current.current, [identifier]: pem };
      setKeys((prev) => ({ ...prev, [identifier]: pem }));
    },
  }), [setKeys]);
}

/** How many published themes the store asks for at a time. */
const PAGE = 40;

/** Who the store lists themes by: Din's publishers, the user, and the people they follow. */
export function useCatalogAuthors(): string[] {
  const { user } = useCurrentUser();
  const following = useFollowingPubkeys();
  return useMemo(() => {
    const set = new Set(NSITE_CATALOG_PUBKEYS);
    if (user) set.add(user.pubkey);
    for (const pubkey of following) set.add(pubkey);
    return [...set];
  }, [user, following]);
}

/** Whether this computer can keep themes of a type: the Din desktop app, not a browser. */
export function canKeepPackages(type: PackageType): boolean {
  if (type === 'skin') return getFsBridge() !== undefined;
  if (type === 'extension') return getCrxBridge() !== undefined;
  return (type === 'cursor' ? getSystemCursorBridge() : getIconThemeBridge()) !== undefined;
}

/** The App Store's published cursor themes, icon themes or skins, newest first, a page at a time. */
export function usePackageCatalog(type: PackageType, enabled = true) {
  const relays = useManifestRelays();
  const authors = useCatalogAuthors();
  const kind = PACKAGE_KIND[type];

  const query = useInfiniteQuery({
    queryKey: ['theme-packages', 'catalog', type, authors],
    enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const allowed = new Set(authors);
      const filters: NostrFilter[] = [{ kinds: [kind], authors, limit: PAGE, until: pageParam }];
      if (pageParam === undefined) filters.push(packageDeletionsFilter(type, authors));
      const events = await relays.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      // The author is the only trust boundary for an addressable event.
      return events.filter((event) => allowed.has(event.pubkey));
    },
    getNextPageParam: (page) => {
      const found = page.filter((event) => event.kind === kind);
      if (found.length < PAGE) return undefined;
      return Math.min(...found.map((event) => event.created_at)) - 1;
    },
    staleTime: 60_000,
  });

  const packages = useMemo(() => buildPackageCatalog(query.data?.pages.flat() ?? []), [query.data]);

  return {
    packages,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isError: query.isError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    refresh: query.refetch,
    refreshing: query.isRefetching,
  };
}

/** One published theme by its address. */
export function useThemePackage(address: PackageAddress | null) {
  const relays = useManifestRelays();
  return useQuery({
    queryKey: ['theme-packages', 'one', address?.type, address?.pubkey, address?.identifier],
    enabled: !!address,
    queryFn: ({ signal }) =>
      address
        ? fetchThemePackage(address, (filters) =>
            relays.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }),
          )
        : null,
  });
}

/** The themes of a type installed from Nostr, by coordinate. */
export function useInstalledPackages(type: PackageType) {
  return useQuery({
    queryKey: ['theme-packages', 'installed', type],
    enabled: canKeepPackages(type),
    queryFn: async () => {
      const installed = await installedPackages(type);
      return new Map(installed.map((t) => [t.source.coordinate, { id: t.id, publishedAt: t.source.publishedAt }]));
    },
    staleTime: 60_000,
  });
}

/** What the `din` command and the UI share to publish: the account's uploader and signer. */
export function usePublishDeps(): Omit<PublishDeps, 'progress'> | null {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: upload } = useUploadFile();
  const { mutateAsync: publish } = useNostrPublish();
  const extensionKeys = useExtensionKeys();
  const servers = useMemo(
    () => getEffectiveBlossomServers(config.blossomServerMetadata, config.useAppBlossomServers),
    [config.blossomServerMetadata, config.useAppBlossomServers],
  );
  return useMemo(
    () => (user ? { upload, publish, servers, pubkey: user.pubkey, extensionKeys } : null),
    [user, upload, publish, servers, extensionKeys],
  );
}

/** Installing, using, removing and deleting published themes, and refreshing what shows them. */
export function useThemePackageActions() {
  const relays = useManifestRelays();
  const queryClient = useQueryClient();
  const { mutateAsync: publish } = useNostrPublish();
  const { open } = useWindowActions();

  const refresh = useCallback(
    (type: PackageType) => {
      void queryClient.invalidateQueries({ queryKey: ['theme-packages', 'installed', type] });
      if (type === 'extension') void queryClient.invalidateQueries({ queryKey: CRX_EXTENSIONS_KEY });
      else if (type !== 'skin') void queryClient.invalidateQueries({ queryKey: type === 'cursor' ? ['cursor'] : ['icon-theme'] });
    },
    [queryClient],
  );

  const installDeps: InstallDeps = useMemo(
    () => ({ query: (filters) => relays.query(filters, { signal: AbortSignal.timeout(8000) }) }),
    [relays],
  );

  /** Install (or update) a theme and use it. */
  const install = useCallback(
    async (pkg: ThemePackage, size?: number) => {
      try {
        const id = await installThemePackage(pkg, installDeps);
        await applyTheme(pkg.type, id, { size, open });
        return id;
      } finally {
        refresh(pkg.type);
      }
    },
    [installDeps, refresh, open],
  );

  const use = useCallback(
    async (type: PackageType, id: string, size?: number) => {
      try {
        await applyTheme(type, id, { size, open });
      } finally {
        refresh(type);
      }
    },
    [refresh, open],
  );

  const remove = useCallback(
    async (type: PackageType, id: string) => {
      try {
        await removeTheme(type, id);
      } finally {
        refresh(type);
      }
    },
    [refresh],
  );

  /** Delete one of the user's own published themes (NIP-09). */
  const deleteOwn = useCallback(
    async (pkg: ThemePackage) => {
      const deletion = await publish(packageDeletion(pkg));
      if (pkg.type === 'extension') ingestPublished([deletion]);
      void queryClient.invalidateQueries({ queryKey: ['theme-packages', 'catalog', pkg.type] });
      void queryClient.invalidateQueries({ queryKey: ['theme-packages', 'one', pkg.type, pkg.pubkey, pkg.identifier] });
    },
    [publish, queryClient],
  );

  const refreshPublished = useCallback(
    (type: PackageType) => void queryClient.invalidateQueries({ queryKey: ['theme-packages', 'catalog', type] }),
    [queryClient],
  );

  return { install, use, remove, deleteOwn, refreshPublished };
}
