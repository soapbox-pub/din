import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useNostr } from '@nostrify/react';
import type { NostrFilter, NRelay } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import {
  buildCatalog,
  NSITE_CATALOG_PUBKEYS,
  NSITE_CATALOG_RELAY,
  type StoreApp,
} from '@/lib/nsiteCatalog';
import {
  CATALOG_PAGE,
  catalogEntries,
  type CatalogEntry,
  getCatalogVersion,
  isCatalogLoaded,
  listedApp,
  loadCatalog,
  loadCatalogPage,
  needsCheck,
  requestChecks,
  subscribeCatalog,
  syncCatalogTop,
} from '@/lib/nsiteCatalogCache';

/**
 * Where the store looks for manifests: the user's read relays, which is where
 * Din resolves a site when it opens, plus the relay nsites are published to.
 */
export function useManifestRelays(): NRelay {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relays = config.relayMetadata.relays;
  return useMemo(() => {
    const urls = new Set(relays.filter((relay) => relay.read).map((relay) => relay.url));
    urls.add(NSITE_CATALOG_RELAY);
    return nostr.group([...urls]);
  }, [nostr, relays]);
}

/**
 * Query manifests by author, re-checking the authors a relay hands back:
 * manifests are replaceable, so the author is the only trust boundary.
 */
export async function queryManifests(
  relays: NRelay,
  filters: NostrFilter[],
  signal: AbortSignal,
): Promise<StoreApp[]> {
  const allowed = new Set(filters.flatMap((filter) => filter.authors ?? []));
  const events = await relays.query(filters, { signal });
  return buildCatalog(events.filter((event) => allowed.has(event.pubkey)));
}

/** Re-renders on every change to the on-disk catalog; returns its version. */
export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribeCatalog, getCatalogVersion);
}

/** Where the list stands in this window. */
interface Paging {
  /** Sites updated before this aren't shown yet. */
  floor: number;
  /** Where the next relay page starts: undefined for the newest, null when done. */
  until: number | undefined | null;
  loading: boolean;
  error: boolean;
  /** Asking for what changed since the last sync. */
  syncing: boolean;
}

const START: Paging = { floor: Infinity, until: undefined, loading: false, error: false, syncing: false };

/** One window's walk down the catalog, from the top. */
class CatalogPager {
  private state = START;
  private controller = new AbortController();
  private listeners = new Set<() => void>();

  constructor(
    private relays: NRelay,
    private authors: string[],
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(update: (state: Paging) => Partial<Paging>): void {
    this.state = { ...this.state, ...update(this.state) };
    for (const listener of this.listeners) listener();
  }

  /** Start over from the top: sync what changed, and fetch the first page. */
  start = () => {
    this.controller.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.state = START;
    this.set(() => ({ syncing: true }));
    void syncCatalogTop(this.relays, this.authors, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) this.set(() => ({ syncing: false }));
      });
    void this.loadMore();
  };

  stop = () => this.controller.abort();

  /** The authors' manifests on disk, newest first. */
  ordered(): CatalogEntry[] {
    const set = new Set(this.authors);
    return [...catalogEntries()]
      .filter((entry) => set.has(entry.event.pubkey))
      .sort((a, b) => b.event.created_at - a.event.created_at);
  }

  loadMore = async () => {
    const { controller } = this;
    const { until, loading } = this.state;
    if (loading || until === null) return;
    this.set(() => ({ loading: true }));

    // Show the next page of what's on disk right away...
    await loadCatalog();
    if (controller.signal.aborted) return;
    this.set(({ floor }) => {
      const below = this.ordered().filter((entry) => entry.event.created_at < floor);
      const edge = below[Math.min(CATALOG_PAGE, below.length) - 1]?.event.created_at;
      return edge === undefined ? {} : { floor: Math.min(floor, edge) };
    });

    // ...and ask the relays for the same stretch.
    try {
      const next = await loadCatalogPage(this.relays, this.authors, until, controller.signal);
      if (controller.signal.aborted) return;
      this.set(({ floor }) => ({
        floor: next === null ? 0 : Math.min(floor, next),
        until: next,
        loading: false,
        error: false,
      }));
    } catch {
      if (controller.signal.aborted) return;
      this.set(() => ({ loading: false, error: true }));
    }
  };
}

/**
 * The App Store catalog: the named sites published by the store's known
 * publishers (NSITE_CATALOG_PUBKEYS), the signed-in user, and everyone they
 * follow. The web a person already keeps up with is a better guess at the
 * apps they want than anything a publisher could pick, and it is a list
 * nobody has to curate.
 *
 * It reads from the on-disk catalog (nsiteCatalogCache), so it opens on the
 * list it showed last time, and lists only sites whose files have been
 * checked. The list goes back a page at a time (`loadMore`): each page is
 * shown from disk at once and asked of the relays again, which fills in
 * whatever the disk didn't have. Most recently updated first.
 */
export function useNsiteCatalog() {
  const relays = useManifestRelays();
  const { user } = useCurrentUser();
  const follows = useFollowingPubkeys();
  const version = useCatalogVersion();

  const authors = useMemo(
    () => [...new Set([...NSITE_CATALOG_PUBKEYS, ...(user ? [user.pubkey] : []), ...follows])],
    [user, follows],
  );

  // Start over from the top whenever who's in the catalog changes.
  const pager = useMemo(() => new CatalogPager(relays, authors), [relays, authors]);
  useEffect(() => {
    pager.start();
    return pager.stop;
  }, [pager]);
  const paging = useSyncExternalStore(pager.subscribe, pager.getState);

  const ordered = useMemo(() => {
    void version;
    return pager.ordered();
  }, [pager, version]);

  const shown = useMemo(
    () => ordered.filter((entry) => entry.event.created_at >= paging.floor),
    [ordered, paging.floor],
  );

  const waiting = useMemo(() => shown.filter(needsCheck).map((entry) => entry.addr), [shown]);
  useEffect(() => {
    if (waiting.length) requestChecks(waiting);
  }, [waiting]);

  const apps = useMemo(
    () => shown.flatMap((entry) => listedApp(entry.addr) ?? []),
    [shown],
  );
  const allApps = useMemo(
    () => ordered.flatMap((entry) => listedApp(entry.addr) ?? []),
    [ordered],
  );

  const busy = !isCatalogLoaded() || paging.loading || waiting.length > 0;

  return {
    /** The listed sites shown so far. */
    apps,
    /** Every listed site on disk by these authors, for search. */
    allApps,
    /** Nothing to show yet, but something is on its way. */
    isLoading: apps.length === 0 && busy,
    isError: apps.length === 0 && !busy && paging.error,
    /** Fetching or checking more below what's shown. */
    isLoadingMore: busy,
    /** More to fetch; false after a failed page too, until a refresh. */
    hasMore: paging.until !== null && !paging.error,
    loadMore: pager.loadMore,
    refreshing: paging.syncing,
    refresh: pager.start,
  };
}
