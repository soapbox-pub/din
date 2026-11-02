import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrFilter } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import { useManifestRelays } from '@/hooks/useNsiteCatalog';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
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
  type InstallDeps,
  type PackageAddress,
  type PackageType,
  type PublishDeps,
  type ThemePackage,
} from '@/lib/themePackages';

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
  const servers = useMemo(
    () => getEffectiveBlossomServers(config.blossomServerMetadata, config.useAppBlossomServers),
    [config.blossomServerMetadata, config.useAppBlossomServers],
  );
  return useMemo(() => (user ? { upload, publish, servers } : null), [user, upload, publish, servers]);
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
      if (type !== 'skin') void queryClient.invalidateQueries({ queryKey: type === 'cursor' ? ['cursor'] : ['icon-theme'] });
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
      await publish(packageDeletion(pkg));
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
