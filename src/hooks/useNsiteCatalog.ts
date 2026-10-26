import { useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { NostrFilter, NRelay } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useFollowingPubkeys } from '@/hooks/useFollowingPubkeys';
import {
  buildCatalog,
  NSITE_CATALOG_PUBKEYS,
  NSITE_CATALOG_RELAY,
  NSITE_KINDS,
  type StoreApp,
} from '@/lib/nsiteCatalog';

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

/**
 * The App Store catalog: the nsites published by the store's known publishers
 * (NSITE_CATALOG_PUBKEYS), the signed-in user, and everyone they follow. The
 * web a person already keeps up with is a better guess at the apps they want
 * than anything a publisher could pick, and it is a list nobody has to curate.
 * Sorted by name, nameless sites last (see buildCatalog).
 */
export function useNsiteCatalog() {
  const relays = useManifestRelays();
  const { user } = useCurrentUser();
  const follows = useFollowingPubkeys();

  const authors = useMemo(
    () => [...new Set([...NSITE_CATALOG_PUBKEYS, ...(user ? [user.pubkey] : []), ...follows])],
    [user, follows],
  );

  return useQuery<StoreApp[]>({
    queryKey: ['nostr', 'app-store', 'catalog', authors],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      return queryManifests(relays, [{ kinds: NSITE_KINDS, authors, limit: 500 }], signal);
    },
    // The follow list arrives after the publishers' half; keep showing that
    // rather than flashing a skeleton while the longer list loads.
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
  });
}
