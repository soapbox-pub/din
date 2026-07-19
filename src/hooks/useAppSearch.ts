import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import {
  APP_HANDLER_KIND,
  dedupeStoreApps,
  type StoreApp,
} from '@/lib/nostrApps';

/**
 * NIP-50 full-text search over kind 31990 app listings. The pool's reqRouter
 * (NostrProvider) routes any REQ carrying a `search` filter to the dedicated
 * SEARCH_RELAYS group, since the user's general read relays may not implement
 * the search capability.
 *
 * Search relays return events in relevance order, so results keep the relay's
 * ranking instead of the catalog's newest-first sort (after deduping to the
 * latest revision per address).
 */
export function useAppSearch(query: string) {
  const { nostr } = useNostr();
  const search = query.trim();

  return useQuery<StoreApp[]>({
    queryKey: ['nostr', 'app-store', 'search', search],
    enabled: search.length > 0,
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.query(
        [{ kinds: [APP_HANDLER_KIND], search, limit: 50 }],
        { signal },
      );

      // Record the relay's relevance order per app address before deduping.
      const order = new Map<string, number>();
      for (const event of events) {
        const d = event.tags.find(([name]) => name === 'd')?.[1];
        if (!d) continue;
        const address = `${APP_HANDLER_KIND}:${event.pubkey}:${d}`;
        if (!order.has(address)) order.set(address, order.size);
      }

      return dedupeStoreApps(events).sort(
        (a, b) =>
          (order.get(a.address) ?? Infinity) - (order.get(b.address) ?? Infinity),
      );
    },
    staleTime: 60 * 1000,
    retry: 1,
  });
}
