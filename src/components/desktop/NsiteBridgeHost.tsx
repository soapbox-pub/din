import { useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import {
  canonicalNsiteHost,
  canonicalNsiteUrl,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  parseCanonicalNsiteHost,
  parseNsiteAlias,
  rememberNsiteAlias,
  type NsiteAliasAuthority,
} from '@/lib/nsite';
import {
  getNsiteHostBridge,
  type NsiteResolution,
  type NsiteSiteManifest,
} from '@/lib/nsiteBridge';

/** How long a NIP-05 name -> pubkey mapping is reused. */
const NIP05_TTL_MS = 10 * 60_000;

/** Budget for a NIP-05 fetch or a relay query. */
const LOOKUP_TIMEOUT_MS = 10_000;

interface Nip05Result {
  pubkey: string;
  relays: string[];
}

const nip05Cache = new Map<string, { result: Nip05Result; fetchedAt: number }>();

/**
 * Relay hints picked up while resolving an alias (an `naddr`'s hints, or the
 * `relays` map in a NIP-05 document), remembered per canonical host so the
 * canonical request that follows the redirect can use them.
 */
const relayHints = new Map<string, string[]>();

/** Resolve `name@domain` to a pubkey via NIP-05, with a short-lived cache. */
async function lookupNip05(
  domain: string,
  name: string,
  signal: AbortSignal,
): Promise<Nip05Result | null> {
  const key = `${name}@${domain}`;
  const cached = nip05Cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < NIP05_TTL_MS) return cached.result;

  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  try {
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      names?: Record<string, string>;
      relays?: Record<string, string[]>;
    };
    const pubkey = body.names?.[name];
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
    const result: Nip05Result = {
      pubkey,
      relays: (body.relays?.[pubkey] ?? []).filter(
        (relay) => typeof relay === 'string' && relay.startsWith('wss://'),
      ),
    };
    nip05Cache.set(key, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

/** Turn an alias authority into a pubkey plus any relay hints it carried. */
async function resolveAuthority(
  authority: NsiteAliasAuthority,
  signal: AbortSignal,
): Promise<Nip05Result | null> {
  if (authority.type === 'naddr') {
    return { pubkey: authority.pubkey, relays: authority.relays };
  }
  return lookupNip05(authority.domain, authority.name, signal);
}

/**
 * Whether an event really is the manifest we asked for. Relays can return
 * anything, so the kind, author, and `d` tag are all re-checked here rather
 * than trusted from the response.
 */
function isManifestFor(event: NostrEvent, pubkey: string, dtag: string | null): boolean {
  if (event.pubkey !== pubkey) return false;
  if (dtag === null) return event.kind === NSITE_ROOT_KIND;
  if (event.kind !== NSITE_NAMED_KIND) return false;
  return event.tags.some(([name, value]) => name === 'd' && value === dtag);
}

/** Collect the manifest's `path` tags into an absolute-path -> sha256 map. */
function collectPaths(event: NostrEvent): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [name, filePath, hash] of event.tags) {
    if (name !== 'path') continue;
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) continue;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) continue;
    paths[filePath] = hash;
  }
  return paths;
}

/** First value of a single-valued tag, or null. */
function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find(([tagName]) => tagName === name);
  return typeof tag?.[1] === 'string' ? tag[1] : null;
}

/** Keep only https/http server URLs, deduplicated, in order. */
function normalizeServers(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // Skip anything that isn't a URL.
    }
  }
  return out;
}

/**
 * Desktop-lifetime fulfiller for nsite:// lookups relayed from the Electron
 * main process (see electron/nsite.mts). Main serves the bytes but has no
 * Nostr client, so every "what site is this URL, and where are its files?"
 * question lands here, where Nostrify and the user's relay list live.
 *
 * Nothing about the *content* path is trusted to this host: it returns a
 * manifest of path -> sha256 taken from a signature-verified event, and main
 * checks every blob it fetches against those hashes. Renders nothing; does
 * nothing outside the Electron shell.
 */
export function NsiteBridgeHost() {
  const { nostr } = useNostr();
  const { config } = useAppContext();

  const readRelays = config.relayMetadata.relays;
  const blossomMetadata = config.blossomServerMetadata;
  const useAppBlossomServers = config.useAppBlossomServers;

  useEffect(() => {
    const bridge = getNsiteHostBridge();
    if (!bridge) return;

    /** Fetch a site's manifest and assemble everything main needs to serve it. */
    async function loadSite(
      pubkey: string,
      dtag: string | null,
      hints: string[],
      signal: AbortSignal,
    ): Promise<NsiteResolution> {
      const urls = [
        ...new Set([
          ...readRelays.filter((relay) => relay.read).map((relay) => relay.url),
          ...hints,
        ]),
      ];
      const pool = urls.length > 0 ? nostr.group(urls) : nostr;

      const manifestFilter = dtag
        ? { kinds: [NSITE_NAMED_KIND], authors: [pubkey], '#d': [dtag], limit: 1 }
        : { kinds: [NSITE_ROOT_KIND], authors: [pubkey], limit: 1 };

      // The author's BUD-03 server list rides along in the same round trip;
      // NIP-5A wants it consulted when the manifest's own hints come up short.
      const events = await pool.query(
        [manifestFilter, { kinds: [10063], authors: [pubkey], limit: 1 }],
        { signal },
      );

      const manifest = events
        .filter((event) => isManifestFor(event, pubkey, dtag))
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!manifest) {
        return {
          kind: 'error',
          code: 'no-manifest',
          message: dtag
            ? `No site named "${dtag}" is published under this key.`
            : 'This key publishes no root site.',
        };
      }

      const serverList = events.find(
        (event) => event.kind === 10063 && event.pubkey === pubkey,
      );

      const site: NsiteSiteManifest = {
        host: canonicalNsiteHost(pubkey, dtag),
        pubkey,
        dtag,
        paths: collectPaths(manifest),
        servers: normalizeServers([
          // NIP-5A: the manifest's own hints first, then the author's server
          // list, then Din's defaults. Any of them can serve any blob - the
          // hash from the signed manifest is what makes the order safe.
          ...manifest.tags.filter(([name]) => name === 'server').map(([, url]) => url),
          ...(serverList?.tags.filter(([name]) => name === 'server').map(([, url]) => url) ??
            []),
          ...getEffectiveBlossomServers(blossomMetadata, useAppBlossomServers),
        ]),
        title: tagValue(manifest, 'title'),
        updatedAt: manifest.created_at,
      };

      return { kind: 'site', site };
    }

    async function resolve(rawUrl: string, signal: AbortSignal): Promise<NsiteResolution> {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { kind: 'error', code: 'bad-url', message: 'That is not a valid URL.' };
      }

      // Canonical host: serve it directly, using any hints stashed by the
      // alias that redirected here.
      const canonical = parseCanonicalNsiteHost(url.hostname);
      if (canonical) {
        return loadSite(
          canonical.pubkey,
          canonical.dtag,
          relayHints.get(url.hostname) ?? [],
          signal,
        );
      }

      const alias = parseNsiteAlias(rawUrl);
      if (!alias) {
        return {
          kind: 'error',
          code: 'bad-url',
          message:
            'Expected nsite://<domain>/<site>/ — use /~/ for the root site, ' +
            'or /@name/<site>/ for a specific NIP-05 name.',
        };
      }

      const resolved = await resolveAuthority(alias.authority, signal);
      if (!resolved) {
        return {
          kind: 'error',
          code: 'no-nip05',
          message:
            alias.authority.type === 'nip05'
              ? `${alias.authority.name}@${alias.authority.domain} does not resolve to a Nostr key.`
              : 'That identifier does not name a site.',
        };
      }

      // A d tag outside NIP-5A's charset has no canonical host, so the site is
      // reachable by naddr only.
      let host: string;
      try {
        host = canonicalNsiteHost(resolved.pubkey, alias.dtag);
      } catch {
        return {
          kind: 'error',
          code: 'bad-url',
          message: `"${alias.dtag}" cannot be addressed by name (NIP-5A allows 1-13 characters of a-z, 0-9 and -).`,
        };
      }

      if (resolved.relays.length > 0) relayHints.set(host, resolved.relays);

      const canonicalUrl = canonicalNsiteUrl(resolved.pubkey, alias.dtag, alias.path);
      // Remember the name so the address bar can show `nsite://soapbox.pub/armada/`
      // instead of the 56-character canonical host it redirects to.
      rememberNsiteAlias(rawUrl, canonicalUrl);

      return { kind: 'redirect', url: canonicalUrl };
    }

    return bridge.onRequest((request) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      void resolve(request.url, controller.signal)
        .catch((error: unknown): NsiteResolution => {
          const aborted = controller.signal.aborted;
          return {
            kind: 'error',
            code: aborted ? 'timeout' : 'no-manifest',
            message:
              aborted
                ? 'Your relays did not answer in time.'
                : error instanceof Error
                  ? error.message
                  : String(error),
          };
        })
        .then((resolution) => {
          clearTimeout(timer);
          bridge.respond({ requestId: request.requestId, resolution });
        });
    });
  }, [nostr, readRelays, blossomMetadata, useAppBlossomServers]);

  return null;
}
