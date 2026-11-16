import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { NSITE_CATALOG_PUBKEYS } from '@/lib/nsiteCatalog';
import { fetchFlatpakApp, fetchFlatpakCatalog, parseAppNaddr, type FlatpakQuery, type LinuxApp } from '@/lib/nostrFlatpaks';
import {
  THEME_DEFINITION_KIND,
  buildThemeCatalog,
  fetchThemeDefinition,
  themeDeletionsFilter,
} from '@/lib/themeDefinition';
import {
  PACKAGE_KIND,
  buildPackageCatalog,
  fetchThemePackage,
  packageDeletionsFilter,
  type PackageAddress,
  type PackageType,
  type ThemePackage,
} from '@/lib/themePackages';
import { useFollowingPubkeys, useManifestRelays, usePubkey, useRelaysKey, useStoreState } from '../store';

/**
 * The App Store's catalogs other than its apps' (useNsiteCatalog): named
 * themes, cursor themes, icon sets and skins, and Linux apps, by Din's
 * publishers, the user and the people they follow, read from the relays
 * the desktop names. Every query keeps only its authors' events: for an
 * addressable event the author is the only trust boundary.
 */

/** How many the store asks for at a time. */
const PAGE = 40;

/** Who the store lists by: Din's publishers, the user, and the people they follow. */
export function useCatalogAuthors(): string[] {
  const pubkey = usePubkey();
  const following = useFollowingPubkeys();
  return useMemo(() => {
    const set = new Set(NSITE_CATALOG_PUBKEYS);
    if (pubkey) set.add(pubkey);
    for (const p of following) set.add(p);
    return [...set];
  }, [pubkey, following]);
}

/** A paged catalog, as each section shows it. */
export interface CatalogState<T> {
  items: T[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => unknown;
  refresh: () => unknown;
  refreshing: boolean;
}

/** One kind of addressable event by the catalog's authors, newest first, a page at a time, with its authors' deletions. */
function usePagedKind<T>(key: string, kind: number, deletions: (authors: string[]) => NostrFilter, build: (events: NostrEvent[]) => T[], enabled: boolean): CatalogState<T> {
  const relays = useManifestRelays();
  const relaysKey = useRelaysKey();
  const authors = useCatalogAuthors();
  const query = useInfiniteQuery({
    queryKey: [key, 'catalog', authors, relaysKey],
    enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const allowed = new Set(authors);
      const filters: NostrFilter[] = [{ kinds: [kind], authors, limit: PAGE, until: pageParam }];
      // Deletions only need asking for once.
      if (pageParam === undefined) filters.push(deletions(authors));
      const events = await relays.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      return events.filter((event) => allowed.has(event.pubkey));
    },
    getNextPageParam: (page) => {
      const found = page.filter((event) => event.kind === kind);
      if (found.length < PAGE) return undefined;
      return Math.min(...found.map((event) => event.created_at)) - 1;
    },
    staleTime: 60_000,
  });
  const items = useMemo(() => build(query.data?.pages.flat() ?? []), [build, query.data]);
  return {
    items,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isError: query.isError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    refresh: query.refetch,
    refreshing: query.isRefetching,
  };
}

/** The store's themes: named themes (kind 36767). */
export function useThemeCatalog(enabled = true) {
  return usePagedKind('theme', THEME_DEFINITION_KIND, themeDeletionsFilter, buildThemeCatalog, enabled);
}

/** One named theme by its address. */
export function useThemeDefinition(address: { pubkey: string; identifier: string } | null) {
  const relays = useManifestRelays();
  const relaysKey = useRelaysKey();
  return useQuery({
    queryKey: ['theme-definition', address?.pubkey, address?.identifier, relaysKey],
    enabled: !!address,
    queryFn: ({ signal }) => (address ? fetchThemeDefinition(address, relays, signal) : null),
  });
}

/** The store's cursor themes, icon sets or skins. */
export function usePackageCatalog(type: Exclude<PackageType, 'extension'>, enabled = true): CatalogState<ThemePackage> {
  return usePagedKind(`package-${type}`, PACKAGE_KIND[type], (authors) => packageDeletionsFilter(type, authors), buildPackageCatalog, enabled);
}

/** One published cursor theme, icon set or skin by its address. */
export function useThemePackage(address: PackageAddress | null) {
  const relays = useManifestRelays();
  const relaysKey = useRelaysKey();
  return useQuery({
    queryKey: ['theme-package', address?.type, address?.pubkey, address?.identifier, relaysKey],
    enabled: !!address && address.type !== 'extension',
    queryFn: ({ signal }) =>
      address
        ? fetchThemePackage(address, (filters) => relays.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }))
        : null,
  });
}

// ---- Linux apps ----

function useFlatpakQuery(): FlatpakQuery {
  const relays = useManifestRelays();
  return useMemo(
    () => (filters, signal) => relays.query(filters, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) }),
    [relays],
  );
}

/** This computer's NIP-82 platform, where Linux apps install. */
function usePlatform(): string | null {
  const linux = useStoreState()?.linux;
  return linux?.available ? linux.platform : null;
}

/** The Linux apps Din's publishers, the user and the people they follow publish for this computer. */
export function useFlatpakCatalog(enabled = true) {
  const authors = useCatalogAuthors();
  const platform = usePlatform();
  const query = useFlatpakQuery();
  const relaysKey = useRelaysKey();
  return useQuery({
    queryKey: ['nostr-flatpaks', 'catalog', platform, authors, relaysKey],
    enabled: enabled && !!platform,
    queryFn: ({ signal }) => fetchFlatpakCatalog(authors, platform as string, query, signal),
    staleTime: 5 * 60_000,
  });
}

/** One app by its address, when it has a Flatpak or an AppImage for this computer. */
export function useFlatpakApp(address: { pubkey: string; identifier: string } | null) {
  const platform = usePlatform();
  const query = useFlatpakQuery();
  const relaysKey = useRelaysKey();
  return useQuery({
    queryKey: ['nostr-flatpaks', 'one', platform, address?.pubkey, address?.identifier, relaysKey],
    enabled: !!address && !!platform,
    queryFn: ({ signal }) => (address ? fetchFlatpakApp(address, platform as string, query, signal) : null),
  });
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
