/**
 * `nostr:` URIs (NIP-21), and the apps that open them.
 *
 * A `nostr:` link names a profile, an event or an addressable event by its
 * NIP-19 identifier. Din shows one as a page in the Web Browser (an internal
 * page, like about:preferences: nothing is loaded, React paints it), with a
 * way to open it in an app that says it can.
 *
 * Apps say so in their web app manifest, with the standard
 * `protocol_handlers` member, and Din adds one key of its own to the entry,
 * `kinds`, for the event kinds the app shows. No `kinds` means every kind.
 *
 *     "protocol_handlers": [
 *       { "protocol": "nostr", "url": "/open?uri=%s", "kinds": [1, 6, 30023] }
 *     ]
 *
 * `%s` becomes the whole URI, percent-encoded, as `registerProtocolHandler`
 * does it.
 */

import { nip19 } from 'nostr-tools';

/** What a `nostr:` URI points at, decoded. */
export type NostrUriTarget =
  | { type: 'profile'; pubkey: string; relays: string[] }
  | { type: 'event'; id: string; kind: number | null; author: string | null; relays: string[] }
  | { type: 'address'; kind: number; pubkey: string; identifier: string; relays: string[] };

export interface ParsedNostrUri {
  /** The URI in canonical form: `nostr:` and the identifier in lowercase. */
  uri: string;
  /** The NIP-19 identifier alone. */
  bech32: string;
  target: NostrUriTarget;
}

/** Longer than any identifier a link would carry; past it, a URI is abuse. */
const MAX_URI_LENGTH = 4096;

/** Relay hints taken from an identifier, at most. */
const MAX_RELAY_HINTS = 5;

const IDENTIFIER = /^(?:npub|nprofile|note|nevent|naddr)1[023456789acdefghjklmnpqrstuvwxyz]+$/;

/** Relay hints worth asking: secure websocket URLs only. */
function relayHints(relays: string[] | undefined): string[] {
  const out: string[] = [];
  for (const relay of relays ?? []) {
    try {
      const url = new URL(relay);
      if (url.protocol === 'wss:' && !out.includes(url.href)) out.push(url.href);
    } catch {
      // Not a URL.
    }
    if (out.length === MAX_RELAY_HINTS) break;
  }
  return out;
}

/** Decode a NIP-19 identifier into what it names, or null. `nsec` never qualifies. */
export function decodeNostrIdentifier(bech32: string): NostrUriTarget | null {
  const lower = bech32.toLowerCase();
  if (!IDENTIFIER.test(lower)) return null;
  try {
    const decoded = nip19.decode(lower);
    switch (decoded.type) {
      case 'npub':
        return { type: 'profile', pubkey: decoded.data, relays: [] };
      case 'nprofile':
        return { type: 'profile', pubkey: decoded.data.pubkey, relays: relayHints(decoded.data.relays) };
      case 'note':
        return { type: 'event', id: decoded.data, kind: null, author: null, relays: [] };
      case 'nevent':
        return {
          type: 'event',
          id: decoded.data.id,
          kind: decoded.data.kind ?? null,
          author: decoded.data.author ?? null,
          relays: relayHints(decoded.data.relays),
        };
      case 'naddr':
        return {
          type: 'address',
          kind: decoded.data.kind,
          pubkey: decoded.data.pubkey,
          identifier: decoded.data.identifier,
          relays: relayHints(decoded.data.relays),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Parse a `nostr:` URI. `nostr://npub1…`, which some apps write, is read the
 * same; anything that isn't a readable NIP-19 identifier is null.
 */
export function parseNostrUri(input: string): ParsedNostrUri | null {
  const trimmed = input.trim();
  if (trimmed.length > MAX_URI_LENGTH) return null;
  const match = /^nostr:(?:\/\/)?([a-z0-9]+)\/?$/i.exec(trimmed);
  if (!match) return null;
  const bech32 = match[1].toLowerCase();
  const target = decodeNostrIdentifier(bech32);
  return target ? { uri: `nostr:${bech32}`, bech32, target } : null;
}

/** Whether a string is a `nostr:` URI Din can show. */
export function isNostrUri(input: string): boolean {
  return parseNostrUri(input) !== null;
}

/** The kind a target is known to be without fetching it, or null (a `note1`, say). */
export function knownKind(target: NostrUriTarget): number | null {
  if (target.type === 'profile') return 0;
  return target.kind;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** How an app opens `nostr:` links, from its manifest. */
export interface NostrHandler {
  /** The URL to open, with `%s` where the URI goes. */
  url: string;
  /** The event kinds it shows, or null for every kind. */
  kinds: number[] | null;
}

/** Kinds one handler may name, at most. */
const MAX_KINDS = 256;

/** Longest handler URL Din keeps. */
const MAX_HANDLER_URL = 2048;

/** A manifest's `kinds`, or null for "every kind" (absent, or nothing readable in it). */
function parseKinds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const kinds = [
    ...new Set(
      value.filter(
        (kind): kind is number => typeof kind === 'number' && Number.isInteger(kind) && kind >= 0 && kind <= 65535,
      ),
    ),
  ].slice(0, MAX_KINDS);
  return kinds.length > 0 ? kinds : null;
}

/**
 * The `nostr` entry of a web app manifest's `protocol_handlers`, with its URL
 * resolved against `base` (the manifest's own URL), or null when it has none.
 * Only `nostr` counts: `web+nostr` is not a scheme Din handles. The caller
 * checks the URL is on the app's own origin.
 */
export function parseNostrProtocolHandler(manifest: unknown, base: string): NostrHandler | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const { protocol_handlers: handlers } = manifest as { protocol_handlers?: unknown };
  if (!Array.isArray(handlers)) return null;
  for (const entry of handlers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { protocol, url, kinds } = entry as Record<string, unknown>;
    if (typeof protocol !== 'string' || protocol.trim().toLowerCase() !== 'nostr') continue;
    if (typeof url !== 'string' || !url.includes('%s')) continue;
    try {
      const resolved = new URL(url.trim(), base).href;
      if (resolved.length > MAX_HANDLER_URL || !resolved.includes('%s')) continue;
      return { url: resolved, kinds: parseKinds(kinds) };
    } catch {
      continue;
    }
  }
  return null;
}

/** Re-check a stored handler (it roams, so it's untrusted on the way back in). */
export function normalizeNostrHandler(value: unknown): NostrHandler | null {
  if (typeof value !== 'object' || value === null) return null;
  const { url, kinds } = value as Record<string, unknown>;
  if (typeof url !== 'string' || url.length > MAX_HANDLER_URL || !url.includes('%s')) return null;
  return { url, kinds: parseKinds(kinds) };
}

/** The URL a handler opens for a URI. */
export function handlerUrl(template: string, uri: string): string {
  return template.replace('%s', encodeURIComponent(uri));
}

/** Whether a handler shows a kind. An unknown kind (not fetched yet) matches any. */
export function handlesKind(kinds: number[] | null, kind: number | null): boolean {
  return kinds === null || kind === null || kinds.includes(kind);
}

/**
 * Guest-side script (run via `<webview>.executeJavaScript`) that reads the
 * page's web app manifest and returns its `protocol_handlers` with the URL
 * it was served from, for resolving them. Runs on the page's own origin, so
 * there are no CORS concerns; everything it returns is re-checked host-side.
 */
export const COLLECT_PROTOCOL_HANDLERS_JS = `(async () => {
  const man = document.querySelector('link[rel~="manifest"]');
  let href;
  try { href = man && new URL(man.getAttribute('href'), document.baseURI).href; } catch (e) { return null; }
  if (!href) return null;
  try {
    const res = await fetch(href);
    const json = await res.json();
    return { base: res.url || href, manifest: { protocol_handlers: json && json.protocol_handlers } };
  } catch (e) { return null; }
})()`;
