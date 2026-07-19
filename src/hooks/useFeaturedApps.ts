import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import {
  APP_HANDLER_KIND,
  FEATURED_APPS_PACK,
  dedupeStoreApps,
  pinFeaturedHero,
  type StoreApp,
} from '@/lib/nostrApps';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/** The store's featured rail: a follow pack plus its members' app listings. */
export interface FeaturedApps {
  /** Pack `title` tag, e.g. "Team Soapbox". */
  title: string;
  /** Pack `description` tag, if present. */
  description?: string;
  /** Sanitized pack `image` URL, if present. */
  image?: string;
  /** Installable listings authored by pack members, newest first. */
  apps: StoreApp[];
}

/**
 * Featured apps for the store's landing page: resolves the curated follow
 * pack (kind 39089) and then fetches kind 31990 listings authored by its
 * members. Returns null when the pack can't be found on the user's relays.
 */
export function useFeaturedApps() {
  const { nostr } = useNostr();

  return useQuery<FeaturedApps | null>({
    queryKey: ['nostr', 'app-store', 'featured'],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      // Addressable event, so the query is author-scoped: the d tag alone is
      // not a trust boundary.
      const packEvents = await nostr.query(
        [{
          kinds: [FEATURED_APPS_PACK.kind],
          authors: [FEATURED_APPS_PACK.pubkey],
          '#d': [FEATURED_APPS_PACK.identifier],
          limit: 1,
        }],
        { signal },
      );
      const pack = packEvents
        .filter((event) => event.pubkey === FEATURED_APPS_PACK.pubkey)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!pack) return null;

      const members = Array.from(new Set(
        pack.tags
          .filter(([name, value]) => name === 'p' && /^[0-9a-f]{64}$/.test(value ?? ''))
          .map(([, value]) => value),
      ));
      if (members.length === 0) return null;

      const memberSet = new Set(members);
      const events = await nostr.query(
        [{ kinds: [APP_HANDLER_KIND], authors: members, limit: 100 }],
        { signal },
      );

      return {
        title: pack.tags.find(([name]) => name === 'title')?.[1] ?? 'Featured',
        description: pack.tags.find(([name]) => name === 'description')?.[1],
        image: sanitizeUrl(pack.tags.find(([name]) => name === 'image')?.[1] ?? '') ?? undefined,
        // Defensive re-filter in case a relay ignores the authors constraint,
        // then pin the featured hero (Ditto) to the front of the rail.
        apps: pinFeaturedHero(
          dedupeStoreApps(events.filter((event) => memberSet.has(event.pubkey))),
        ),
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
