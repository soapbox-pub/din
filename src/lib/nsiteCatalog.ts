import type { NostrEvent } from '@nostrify/nostrify';
import {
  canonicalNsiteHost,
  isValidDtag,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
} from '@/lib/nsite';

/**
 * The App Store's catalog: nsites (NIP-5A static websites), the only kind of
 * app it offers. Like Tenna's "Add app" list, it is made of the sites a known
 * set of publishers put on Nostr plus whatever the people the user follows
 * publish, read straight from their signed manifests.
 */

/** The manifest kinds a site is published under. */
export const NSITE_KINDS = [NSITE_ROOT_KIND, NSITE_NAMED_KIND];

/** Team Soapbox (_@soapbox.pub), publisher of Din's own apps. */
export const TEAM_SOAPBOX_PUBKEY =
  '781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5';

/**
 * Whose sites the catalog offers everyone, the same publishers Tenna offers:
 * Team Soapbox, Nsite Packagers (other people's clients, packaged as nsites),
 * and the authors of the sites Tenna ships on its wall. Signed in, the user's
 * own pubkey and their follows are added (see useNsiteCatalog).
 */
export const NSITE_CATALOG_PUBKEYS = [
  TEAM_SOAPBOX_PUBKEY,
  'fbb512ea0839e0df4d0d21dc62793a483a877d40870d6032525896e30946ea30', // Nsite Packagers
  '932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d', // MK Fain
  '86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47', // Chadwick
  '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe', // Jared Logan
];

/** The relay nsite manifests are published to, asked alongside the user's own. */
export const NSITE_CATALOG_RELAY = 'wss://relay.ditto.pub/';

/**
 * Follow Packs (kind 39089) are addressable lists of pubkeys curated by a
 * single author, with `title`/`description`/`image` tags describing the pack.
 */
export const FOLLOW_PACK_KIND = 39089;

/**
 * The "Team Soapbox" follow pack, the App Store's featured-apps source: the
 * sites its members publish fill the landing page's shelf. Addressable
 * coordinate decoded from
 * naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw
 */
export const FEATURED_APPS_PACK = {
  kind: FOLLOW_PACK_KIND,
  pubkey: '932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d',
  identifier: 'k4p5w0n22suf',
} as const;

/**
 * The site pinned to the featured rail's hero slot: Team Soapbox's Ditto. A
 * site is named by its key, so this is a key and a `d` tag, never a name a
 * stranger could also claim.
 */
export const FEATURED_HERO = { pubkey: TEAM_SOAPBOX_PUBKEY, dtag: 'ditto' } as const;

/** An installable nsite, parsed from its manifest. */
export interface StoreApp {
  /** Canonical nsite host: the app's identity, origin, and install key. */
  host: string;
  pubkey: string;
  /** The `d` tag of a named site, or null for a pubkey's root site. */
  dtag: string | null;
  /** The manifest, from which the site's files (and so its icon) are read. */
  event: NostrEvent;
  /**
   * The manifest's `title`, or a named site's `d` tag; null for a root site
   * that says nothing, which callers name after its author.
   */
  name: string | null;
  /** The manifest's `description`, or empty. */
  about: string;
  /** Category hashtags (`t` tags), lowercased and deduplicated. */
  hashtags: string[];
  createdAt: number;
}

/** Collapse whitespace and refuse anything too long to stand for a name. */
function tidy(value: string | undefined, limit: number): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text && text.length <= limit ? text : null;
}

/** Hex sha256, as a manifest's `path` tags carry it. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Parse a site manifest into a StoreApp. Returns null for one that can't be
 * opened as an app: a named site without a usable `d` tag (it would fall back
 * to its author's npub and impersonate their root site), or one with no
 * `/index.html` to open.
 */
export function parseStoreApp(event: NostrEvent): StoreApp | null {
  if (event.kind !== NSITE_ROOT_KIND && event.kind !== NSITE_NAMED_KIND) return null;

  let dtag: string | null = null;
  if (event.kind === NSITE_NAMED_KIND) {
    dtag = event.tags.find(([name]) => name === 'd')?.[1] ?? null;
    if (!dtag || !isValidDtag(dtag)) return null;
  }

  const servable = event.tags.some(
    ([name, path, hash]) => name === 'path' && path === '/index.html' && HASH_RE.test(hash ?? ''),
  );
  if (!servable) return null;

  let host: string;
  try {
    host = canonicalNsiteHost(event.pubkey, dtag);
  } catch {
    return null;
  }

  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1];

  return {
    host,
    pubkey: event.pubkey,
    dtag,
    event,
    name: tidy(tag('title'), 48) ?? dtag,
    about: tidy(tag('description'), 500) ?? '',
    hashtags: Array.from(
      new Set(
        event.tags
          .filter(([n, value]) => n === 't' && value)
          .map(([, value]) => value.toLowerCase()),
      ),
    ),
    createdAt: event.created_at,
  };
}

/**
 * Reduce manifests to the newest per site, parsed into StoreApps and sorted by
 * name, the only order a person scanning for one app can follow. Sites that
 * don't name themselves go last.
 */
export function buildCatalog(events: NostrEvent[]): StoreApp[] {
  const latest = new Map<string, StoreApp>();
  for (const event of events) {
    const app = parseStoreApp(event);
    if (!app) continue;
    const seen = latest.get(app.host);
    if (!seen || seen.createdAt < app.createdAt) latest.set(app.host, app);
  }

  return [...latest.values()].sort((a, b) => {
    if (!a.name || !b.name) return a.name ? -1 : b.name ? 1 : 0;
    return a.name.localeCompare(b.name);
  });
}

/** True for the pinned hero site (FEATURED_HERO). */
export function isFeaturedHero(app: StoreApp): boolean {
  return app.pubkey === FEATURED_HERO.pubkey && app.dtag === FEATURED_HERO.dtag;
}
