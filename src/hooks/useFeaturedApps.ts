import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import {
  APP_CATEGORY_TAGS,
  APP_HANDLER_KIND,
  FEATURED_APPS_PACK,
  dedupeStoreApps,
  findFeaturedHero,
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
 * Featured apps for the store's landing page. The curated follow pack
 * (kind 39089) supplies the rail's title/description and the shelf — the
 * kind 31990 listings authored by its members. The hero (Ditto) is resolved
 * separately from the general catalog *after* fetching and pinned to the
 * front, so the rail always leads with it even when the pack is missing or
 * Ditto isn't one of its members. Returns null only when nothing loads.
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

      const members = pack
        ? Array.from(new Set(
            pack.tags
              .filter(([name, value]) => name === 'p' && /^[0-9a-f]{64}$/.test(value ?? ''))
              .map(([, value]) => value),
          ))
        : [];

      // The pack's members supply the shelf. Defensive re-filter in case a
      // relay ignores the authors constraint.
      const memberSet = new Set(members);
      const memberEvents = members.length
        ? await nostr.query(
            [{ kinds: [APP_HANDLER_KIND], authors: members, limit: 100 }],
            { signal },
          )
        : [];
      const shelf = dedupeStoreApps(memberEvents.filter((event) => memberSet.has(event.pubkey)));

      // Feature the hero (Ditto) after fetching: if no member published it,
      // resolve it from the general catalog so the rail still leads with it
      // when the pack is missing or Ditto isn't a member. Same recency + `#t`
      // scan the catalog uses, since host matching can't be a relay filter.
      let apps = shelf;
      if (!findFeaturedHero(apps)) {
        const heroEvents = await nostr.query(
          [
            { kinds: [APP_HANDLER_KIND], limit: 100 },
            { kinds: [APP_HANDLER_KIND], '#t': APP_CATEGORY_TAGS, limit: 100 },
          ],
          { signal },
        );
        const hero = findFeaturedHero(dedupeStoreApps(heroEvents));
        if (hero) apps = [hero, ...shelf];
      }
      apps = pinFeaturedHero(apps);

      if (apps.length === 0) return null;

      return {
        title: pack?.tags.find(([name]) => name === 'title')?.[1] ?? 'Featured',
        description: pack?.tags.find(([name]) => name === 'description')?.[1],
        image: sanitizeUrl(pack?.tags.find(([name]) => name === 'image')?.[1] ?? '') ?? undefined,
        apps,
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
