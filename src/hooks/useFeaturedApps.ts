import { useQuery } from '@tanstack/react-query';
import { queryManifests, useManifestRelays } from '@/hooks/useNsiteCatalog';
import {
  FEATURED_APPS_PACK,
  FEATURED_HERO,
  isFeaturedHero,
  NSITE_KINDS,
  type StoreApp,
} from '@/lib/nsiteCatalog';
import { NSITE_NAMED_KIND } from '@/lib/nsite';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/** The store's featured rail: a follow pack plus its members' apps. */
export interface FeaturedApps {
  /** Pack `title` tag, e.g. "Team Soapbox". */
  title: string;
  /** Pack `description` tag, if present. */
  description?: string;
  /** Sanitized pack `image` URL, if present. */
  image?: string;
  /** The hero (Ditto) first, then the members' packaged apps. */
  apps: StoreApp[];
}

/**
 * Featured apps for the store's landing page. The curated follow pack
 * (kind 39089) supplies the rail's title and description, and its members'
 * nsites fill the shelf - only the ones packaged as apps, with a `title` and
 * a `description`, since a member's personal pages are sites, not apps. The
 * hero (FEATURED_HERO, Ditto) is asked for by its own address in the same
 * round trip and pinned to the front, so the rail leads with it even when the
 * pack is missing. Returns null only when nothing loads.
 */
export function useFeaturedApps() {
  const relays = useManifestRelays();

  return useQuery<FeaturedApps | null>({
    queryKey: ['nostr', 'app-store', 'featured'],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      // Addressable event, so the query is author-scoped: the d tag alone is
      // not a trust boundary.
      const packEvents = await relays.query(
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

      const sites = await queryManifests(
        relays,
        [
          { kinds: [NSITE_NAMED_KIND], authors: [FEATURED_HERO.pubkey], '#d': [FEATURED_HERO.dtag], limit: 1 },
          ...(members.length ? [{ kinds: NSITE_KINDS, authors: members, limit: 300 }] : []),
        ],
        signal,
      );

      const hero = sites.find(isFeaturedHero);
      const shelf = sites.filter((app) => !isFeaturedHero(app) && app.name && app.about);
      const apps = hero ? [hero, ...shelf] : shelf;

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
