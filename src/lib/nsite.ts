/**
 * nsite:// URL grammar (NIP-5A static websites).
 *
 * An nsite URL names a site by its key, never by a name resolved over the
 * network. The host is NIP-5A's label verbatim:
 *
 *     nsite://<npub1…>/<path>            root site   (kind 15128)
 *     nsite://<pubkeyB36><dtag>/<path>   named site  (kind 35128)
 *
 * That is the only spelling that serves a document, and so the only one that
 * is ever a page's origin, an installed app's URL, a history entry, or a
 * copied link. Because the host is derived from the pubkey, every site gets
 * its own Chromium origin — separate localStorage, IndexedDB, cookies, and
 * service worker — and maps 1:1 onto `<label>.nsite-host.com` on a gateway.
 *
 * One other spelling is accepted as input: `nsite://<naddr1…>/<path>`, which
 * also names a key outright and can carry relay hints. It never serves bytes;
 * the protocol handler redirects it to the canonical URL, so by the time page
 * code runs its base URL is canonical.
 *
 * Unlike a gateway's subdomain, the host is never a DNS name, so NIP-5A's
 * 13-character cap on the `d` tag (what a 63-character label leaves after the
 * 50-character pubkey) does not apply here; a `d` tag may be up to 63.
 */

import { nip19 } from 'nostr-tools';

/** The URL scheme nsites are served under, with its trailing colon. */
export const NSITE_PROTOCOL = 'nsite:';

/** Replaceable event kind for a pubkey's root site (NIP-5A). */
export const NSITE_ROOT_KIND = 15128;
/** Addressable event kind for a named site under a pubkey (NIP-5A). */
export const NSITE_NAMED_KIND = 35128;

/**
 * A `d` tag usable in a canonical host: NIP-5A's charset, never a trailing
 * `-`, and up to 63 characters rather than its 13, since this host is not a
 * DNS label (see the comment at the top).
 */
const DTAG_RE = /^[a-z0-9-]{1,63}$/;

/** base36 alphabet, per NIP-5A: digits then lowercase letters. */
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A 32-byte pubkey is always exactly 50 base36 characters (left-padded). */
const B36_PUBKEY_LENGTH = 50;

/** Lowercase 64-char hex, the wire form of a pubkey. */
const HEX32_RE = /^[0-9a-f]{64}$/;

/**
 * Encode a 32-byte hex pubkey as NIP-5A's `pubkeyB36`: lowercase base36,
 * left-padded to exactly 50 characters.
 */
export function pubkeyToBase36(pubkeyHex: string): string {
  if (!HEX32_RE.test(pubkeyHex)) {
    throw new Error('pubkeyToBase36 expects 64-char lowercase hex');
  }
  let value = BigInt(`0x${pubkeyHex}`);
  let out = '';
  while (value > 0n) {
    out = B36[Number(value % 36n)] + out;
    value /= 36n;
  }
  return out.padStart(B36_PUBKEY_LENGTH, '0');
}

/** Decode a 50-char NIP-5A `pubkeyB36` label back to 64-char hex, or null. */
export function base36ToPubkey(label: string): string | null {
  if (label.length !== B36_PUBKEY_LENGTH) return null;
  let value = 0n;
  for (const char of label) {
    const digit = B36.indexOf(char);
    if (digit < 0) return null;
    value = value * 36n + BigInt(digit);
  }
  // Anything wider than 32 bytes is not a pubkey, however well-formed.
  if (value >= 1n << 256n) return null;
  return value.toString(16).padStart(64, '0');
}

/** Whether a `d` tag can appear in a canonical host (NIP-5A's charset rules). */
export function isValidDtag(dtag: string): boolean {
  return DTAG_RE.test(dtag) && !dtag.endsWith('-');
}

/**
 * The canonical host for a site: `npub1…` for a root site, `<pubkeyB36><dtag>`
 * for a named one. This string is the origin, so it must be derived only from
 * the pubkey and `d` tag — never from how the user happened to address it.
 */
export function canonicalNsiteHost(pubkey: string, dtag: string | null): string {
  if (!dtag) return nip19.npubEncode(pubkey);
  if (!isValidDtag(dtag)) {
    throw new Error(`d tag is not addressable as a host: ${dtag}`);
  }
  return `${pubkeyToBase36(pubkey)}${dtag}`;
}

/** Build a full canonical URL for a site path. */
export function canonicalNsiteUrl(
  pubkey: string,
  dtag: string | null,
  path: string,
): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${NSITE_PROTOCOL}//${canonicalNsiteHost(pubkey, dtag)}${suffix}`;
}

/** A site resolved from a canonical nsite host. */
export interface CanonicalNsiteHost {
  /** 64-char lowercase hex. */
  pubkey: string;
  /** The `d` tag for a named site, or null for the pubkey's root site. */
  dtag: string | null;
}

/**
 * Parse a canonical nsite host. Tries `npub1…` first (per NIP-5A's parse
 * order) so a base36 label that happens to start with `npub1` can't shadow a
 * real npub — bech32's checksum makes a collision essentially impossible.
 */
export function parseCanonicalNsiteHost(host: string): CanonicalNsiteHost | null {
  if (host !== host.toLowerCase()) return null;

  if (host.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type === 'npub') return { pubkey: decoded.data, dtag: null };
    } catch {
      // Not an npub after all; fall through to the named-site shape.
    }
  }

  if (host.length <= B36_PUBKEY_LENGTH) return null;
  const dtag = host.slice(B36_PUBKEY_LENGTH);
  if (!isValidDtag(dtag)) return null;
  const pubkey = base36ToPubkey(host.slice(0, B36_PUBKEY_LENGTH));
  if (!pubkey) return null;
  return { pubkey, dtag };
}

/** A site named by an `naddr` in an nsite URL, before it is redirected. */
export interface NsiteNaddr {
  /** 64-char lowercase hex. */
  pubkey: string;
  /** The `d` tag for a named site, or null for the pubkey's root site. */
  dtag: string | null;
  /** The relay hints the `naddr` carried. */
  relays: string[];
  /** The path within the site, verbatim, including any query and fragment. */
  path: string;
}

/**
 * Parse `nsite://<naddr1…>/<path>`. Returns null for anything else, including
 * canonical URLs, which callers should try first via
 * {@link parseCanonicalNsiteHost}.
 */
export function parseNsiteNaddrUrl(rawUrl: string): NsiteNaddr | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== NSITE_PROTOCOL) return null;

  const host = url.hostname.toLowerCase();
  if (!host.startsWith('naddr1')) return null;

  try {
    const decoded = nip19.decode(host);
    if (decoded.type !== 'naddr') return null;
    const { pubkey, kind, identifier, relays } = decoded.data;
    if (kind !== NSITE_ROOT_KIND && kind !== NSITE_NAMED_KIND) return null;
    return {
      pubkey,
      dtag: kind === NSITE_NAMED_KIND ? identifier : null,
      relays: relays ?? [],
      path: `${url.pathname || '/'}${url.search}${url.hash}`,
    };
  } catch {
    return null;
  }
}

/** Whether a string is an nsite URL of any spelling. */
export function isNsiteUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === NSITE_PROTOCOL;
  } catch {
    return false;
  }
}

/**
 * Normalize address-bar input into a navigable nsite URL, or null if it isn't
 * one. A bare `npub1…` or `naddr1…` is unambiguous, so it needs no scheme:
 *
 *     nsite://<label>/x   -> unchanged
 *     nsite://naddr1…/    -> unchanged (the protocol handler redirects it)
 *     naddr1…             -> nsite://naddr1…/
 *     npub1…              -> nsite://npub1…/
 */
export function normalizeNsiteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const explicitScheme = trimmed.toLowerCase().startsWith(NSITE_PROTOCOL);
  const candidate = explicitScheme
    ? trimmed
    : `${NSITE_PROTOCOL}//${trimmed.replace(/^\/\//, '')}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== NSITE_PROTOCOL) return null;

  if (parseCanonicalNsiteHost(url.hostname.toLowerCase())) return url.toString();
  if (parseNsiteNaddrUrl(candidate)) return url.toString();
  return null;
}
