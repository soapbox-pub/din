import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCatalogVersion, useManifestRelays } from '@/hooks/useNsiteCatalog';
import type { StoreApp } from '@/lib/nsiteCatalog';
import {
  catalogEntry,
  getFeatured,
  isCatalogLoaded,
  listedApp,
  loadCatalog,
  needsCheck,
  requestChecks,
  syncFeatured,
} from '@/lib/nsiteCatalogCache';

/** The store's featured rail: a follow pack plus its members' apps. */
export interface FeaturedApps {
  /** Pack `title` tag, e.g. "Team Soapbox". */
  title: string;
  /** Pack `description` tag, if present. */
  description?: string;
  /** Sanitized pack `image` URL, if present. */
  image?: string;
  /**
   * The members' packaged apps, only listed ones, most recently updated
   * first: the first is the hero, the rest the shelf.
   */
  apps: StoreApp[];
}

/**
 * Featured apps for the store's landing page (see syncFeatured), from the
 * on-disk catalog and refreshed from relays. Every app on the rail is
 * checked up front; `data` stays undefined until the first of them that the
 * store lists is known, since that one is the hero. Null when there is none.
 */
export function useFeaturedApps() {
  const relays = useManifestRelays();
  const version = useCatalogVersion();

  const query = useQuery({
    queryKey: ['nostr', 'app-store', 'featured'],
    queryFn: async (c) => {
      await syncFeatured(relays, c.signal);
      return true;
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    void loadCatalog();
  }, []);

  const { data, waiting } = useMemo(() => {
    void version;
    const snapshot = getFeatured();
    if (!snapshot) return { data: snapshot, waiting: [] as string[] };
    const entries = snapshot.addrs.flatMap((addr) => catalogEntry(addr) ?? []);
    const waiting = entries.filter(needsCheck).map((entry) => entry.addr);
    const apps: StoreApp[] = [];
    for (const entry of entries) {
      const app = listedApp(entry.addr);
      if (app) apps.push(app);
      // Nothing listed yet ahead of an unchecked app: it could be the hero.
      else if (apps.length === 0 && needsCheck(entry)) return { data: undefined, waiting };
    }
    return {
      data: apps.length ? { ...snapshot, apps } : null,
      waiting,
    };
  }, [version]);

  useEffect(() => {
    if (waiting.length) requestChecks(waiting);
  }, [waiting]);

  const settling = !isCatalogLoaded() || query.isPending || waiting.length > 0;

  return {
    data,
    isLoading: data === undefined && settling,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  };
}
