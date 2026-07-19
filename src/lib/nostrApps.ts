import type { NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * NIP-89 Handler Information events (kind 31990) announce Nostr applications:
 * the `content` field carries kind-0-style app metadata (name, picture, about,
 * website) and platform-named tags list where the app runs. This is the same
 * discovery mechanism used by app directories like NostrHub, Borkstr and
 * nostrapp.link, so Din's App Store surfaces the same catalog.
 */
export const APP_HANDLER_KIND = 31990;

/**
 * Common `t` category tags used by real app listings, mirrored from the
 * NostrHub/Borkstr directories. Many listings only surface via a `#t` filter
 * (relays cap plain recency queries), so the store ORs this list into its
 * query to widen discovery.
 */
export const APP_CATEGORY_TAGS = [
  'social', 'tools', 'video', 'pictures', 'marketplace',
  'music', 'podcast', 'communities', 'messaging', 'dvm',
  'fitness', 'productivity', 'education', 'image', 'todo',
  'rideshare', 'ditto', 'mkstack',
  'relay', 'nostr', 'chat', 'news', 'article', 'blog',
  'media', 'images', 'hosting', 'code', 'pastebin',
  'storage', 'blossom', 'upload', 'tool',
  'zaps', 'goals', 'gigs', 'bounties', 'escrow', 'freelance',
  'bunker', 'desktop', 'ephemeral', 'password-manager',
];

/**
 * Follow Packs (kind 39089) are addressable lists of pubkeys curated by a
 * single author, with `title`/`description`/`image` tags describing the pack.
 */
export const FOLLOW_PACK_KIND = 39089;

/**
 * The "Team Soapbox" follow pack — the App Store's featured-apps source.
 * Listings authored by the pack's members are surfaced on the store's
 * landing page. Addressable coordinate decoded from
 * naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw
 */
export const FEATURED_APPS_PACK = {
  kind: FOLLOW_PACK_KIND,
  pubkey: '932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d',
  identifier: 'k4p5w0n22suf',
} as const;

/**
 * Website host of the app pinned to the featured rail's hero slot. The store's
 * landing page always leads with this app (see FeaturedSection), and the rest
 * of the pack members' listings fill the shelf behind it. Matched by host —
 * rather than a `31990:<pubkey>:<d>` address — so the pin survives the listing
 * being re-published under a new d tag or a different pubkey. Change this to
 * feature a different app.
 */
export const FEATURED_HERO_HOST = 'ditto.pub';

/** A web application parsed from a kind 31990 listing, ready to install. */
export interface StoreApp {
  /** Address coordinate "31990:<pubkey>:<d>", the app's stable identity. */
  address: string;
  pubkey: string;
  identifier: string;
  name: string;
  /** Sanitized https icon URL, if the listing carried a valid one. */
  picture?: string;
  about: string;
  /** Sanitized https start URL — what gets installed. */
  website: string;
  /** Category hashtags (`t` tags), lowercased and deduplicated. */
  hashtags: string[];
  createdAt: number;
}

/**
 * Parse a kind 31990 event into a StoreApp. Returns null for events that
 * aren't installable web apps: kind 31990 is also used by DVM handlers, bots
 * and native-only apps, so we require the full metadata set (name, about,
 * website) plus an https website — matching how other Nostr app directories
 * filter down to real applications. All event-sourced URLs are sanitized
 * here, at the trust boundary.
 */
export function parseStoreApp(event: NostrEvent): StoreApp | null {
  if (event.kind !== APP_HANDLER_KIND) return null;

  const identifier = event.tags.find(([name]) => name === 'd')?.[1];
  if (!identifier) return null;

  let metadata: NostrMetadata = {};
  if (event.content) {
    try {
      metadata = JSON.parse(event.content) as NostrMetadata;
    } catch {
      return null;
    }
  }

  const name = (metadata.name || metadata.display_name || '').trim();
  const about = (metadata.about ?? '').trim();
  if (!name || !about || !metadata.picture || !metadata.website) return null;

  const website = sanitizeUrl(metadata.website);
  if (!website) return null;

  const hashtags = Array.from(
    new Set(
      event.tags
        .filter(([n, value]) => n === 't' && value)
        .map(([, value]) => value.toLowerCase()),
    ),
  );

  return {
    address: `${APP_HANDLER_KIND}:${event.pubkey}:${identifier}`,
    pubkey: event.pubkey,
    identifier,
    name,
    picture: sanitizeUrl(metadata.picture) ?? undefined,
    about,
    website,
    hashtags,
    createdAt: event.created_at,
  };
}

/**
 * Reduce kind 31990 events to the latest revision per (pubkey, d) address,
 * parsed into StoreApps and sorted newest first.
 */
export function dedupeStoreApps(events: NostrEvent[]): StoreApp[] {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== APP_HANDLER_KIND) continue;
    const d = event.tags.find(([name]) => name === 'd')?.[1];
    if (!d) continue;
    const key = `${event.pubkey}:${d}`;
    const prev = latest.get(key);
    if (!prev || event.created_at > prev.created_at) latest.set(key, event);
  }

  return Array.from(latest.values())
    .map(parseStoreApp)
    .filter((app): app is StoreApp => app !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** True when the listing is the pinned hero app (host === FEATURED_HERO_HOST). */
function isFeaturedHero(app: StoreApp): boolean {
  try {
    const host = new URL(app.website).hostname.toLowerCase();
    return host === FEATURED_HERO_HOST || host.endsWith(`.${FEATURED_HERO_HOST}`);
  } catch {
    return false;
  }
}

/**
 * Find the pinned hero app (FEATURED_HERO_HOST) in a list of listings, newest
 * first. Lets the featured rail resolve its hero (Ditto) from the general
 * catalog after fetching — so it can lead with the app even when it isn't a
 * member of the curated follow pack.
 */
export function findFeaturedHero(apps: StoreApp[]): StoreApp | undefined {
  return apps.find(isFeaturedHero);
}

/**
 * Move the pinned hero app (FEATURED_HERO_HOST) to the front so the store's
 * landing page always leads with it, preserving the newest-first order of the
 * remaining apps. Returns the list unchanged when the hero app isn't present.
 */
export function pinFeaturedHero(apps: StoreApp[]): StoreApp[] {
  const heroIndex = apps.findIndex(isFeaturedHero);
  if (heroIndex <= 0) return apps;
  return [
    apps[heroIndex],
    ...apps.slice(0, heroIndex),
    ...apps.slice(heroIndex + 1),
  ];
}
