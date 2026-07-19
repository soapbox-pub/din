import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import {
  APP_CATEGORY_TAGS,
  APP_HANDLER_KIND,
  dedupeStoreApps,
  type StoreApp,
} from '@/lib/nostrApps';

/**
 * The App Store catalog: NIP-89 kind 31990 app listings from the user's
 * relays, filtered down to installable web apps.
 *
 * Two filters go out in a single REQ: a plain recency scan plus a `#t`
 * category scan, because many real listings are older than the relay's
 * recency window and only surface via their category tags. Results are
 * deduped to the latest revision per (pubkey, d) address. Public discovery
 * data, so no author scoping (parsing enforces full metadata + https URLs).
 */
export function useNostrApps() {
  const { nostr } = useNostr();

  return useQuery<StoreApp[]>({
    queryKey: ['nostr', 'app-store', 'catalog'],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)]);
      const events = await nostr.query(
        [
          { kinds: [APP_HANDLER_KIND], limit: 100 },
          { kinds: [APP_HANDLER_KIND], '#t': APP_CATEGORY_TAGS, limit: 100 },
        ],
        { signal },
      );
      return dedupeStoreApps(events);
    },
    staleTime: 5 * 60 * 1000,
  });
}
