/**
 * nsite:// URL grammar (NIP-5A static websites).
 *
 * Two URL spaces, both valid URLs, with different jobs:
 *
 * - **Canonical** — what actually serves bytes, and what the browser origin is.
 *   The host is NIP-5A's canonical label verbatim, so an nsite origin maps 1:1
 *   onto `<label>.nsite-host.com` on any gateway:
 *
 *       nsite://<npub1…>/<path>            root site   (kind 15128)
 *       nsite://<pubkeyB36><dtag>/<path>   named site  (kind 35128)
 *
 *   Because the host is derived from the pubkey, every site gets its own
 *   Chromium origin — separate localStorage, IndexedDB, cookies, and service
 *   worker — and a name repointing at a different key can never inherit the
 *   old key's storage.
 *
 * - **Alias** — human-readable, resolved and 302'd to canonical, never serves
 *   a byte:
 *
 *       nsite://<domain>/[@<name>/]<site>/<path>
 *       nsite://<naddr1…>/<path>
 *
 *   where `<site>` is a NIP-5A `d` tag, or `~` for the pubkey's root site, and
 *   `<name>` is the NIP-05 local part (default `_`). A missing `<site>` means
 *   `~`, so `nsite://soapbox.pub/` is the root site of `_@soapbox.pub`.
 *
 *       nsite://soapbox.pub/armada/notifications   d=armada under _@soapbox.pub
 *       nsite://soapbox.pub/~/blog/post            root site, path /blog/post
 *       nsite://ditto.pub/@mk/polaroids/           d=polaroids under mk@ditto.pub
 *       nsite://ditto.pub/@mk/                     root site of mk@ditto.pub
 *
 * Since the alias origin never hosts a document, an SPA can't escape its site
 * by pushState: by the time the page runs, its base URL is canonical, so
 * relative links, history, `fetch`, and service-worker scope are all confined
 * to the one site.
 *
 * Note `@` is spelled as a *path* segment, not URL userinfo. Chromium strips
 * credentials before a request reaches the protocol handler (verified — they
 * are gone from both `protocol.handle` and `will-navigate`), so
 * `nsite://mk@ditto.pub/…` would silently resolve to `_@ditto.pub`: the wrong
 * pubkey, with no error. It is still accepted as address-bar *input* and
 * rewritten to the `/@mk/` form before navigating (see
 * {@link normalizeNsiteInput}), which is safe because that rewrite happens in
 * Din, before Chromium ever sees the string.
 */

import { nip19 } from 'nostr-tools';

/** The URL scheme nsites are served under, with its trailing colon. */
export const NSITE_PROTOCOL = 'nsite:';

/** Replaceable event kind for a pubkey's root site (NIP-5A). */
export const NSITE_ROOT_KIND = 15128;
/** Addressable event kind for a named site under a pubkey (NIP-5A). */
export const NSITE_NAMED_KIND = 35128;

/** The alias path segment that selects a pubkey's root site. */
export const ROOT_SITE_SEGMENT = '~';

/** A NIP-5A `d` tag usable in a canonical host: 1-13 chars, never trailing `-`. */
const DTAG_RE = /^[a-z0-9-]{1,13}$/;

/** The NIP-05 local part charset (NIP-05 §"local part"). */
const NIP05_NAME_RE = /^[a-z0-9\-_.]{1,64}$/;

/** A plausible DNS name for a NIP-05 lookup: at least one dot, no scheme junk. */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

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

/** Whether a `d` tag can appear in a canonical host (NIP-5A's charset rules). */
export function isValidDtag(dtag: string): boolean {
  return DTAG_RE.test(dtag) && !dtag.endsWith('-');
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

/** How an alias names the pubkey that owns the site. */
export type NsiteAliasAuthority =
  /** A NIP-05 lookup: `https://<domain>/.well-known/nostr.json?name=<name>`. */
  | { type: 'nip05'; domain: string; name: string }
  /** A NIP-19 `naddr`, which already carries pubkey, kind, d tag, and hints. */
  | { type: 'naddr'; pubkey: string; kind: number; identifier: string; relays: string[] };

/** A parsed alias URL, before the authority has been resolved to a pubkey. */
export interface NsiteAlias {
  authority: NsiteAliasAuthority;
  /** The `d` tag being addressed, or null for the pubkey's root site. */
  dtag: string | null;
  /** The path *within* the site, always starting with `/`. */
  path: string;
}

/**
 * Parse an alias URL. Returns null for anything that is not one — including
 * canonical URLs, which callers should try first via
 * {@link parseCanonicalNsiteHost}.
 */
export function parseNsiteAlias(rawUrl: string): NsiteAlias | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== NSITE_PROTOCOL) return null;

  const host = url.hostname.toLowerCase();

  let authority: NsiteAliasAuthority | null = null;
  let naddrDtag: string | null = null;

  if (host.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type !== 'naddr') return null;
      const { pubkey, kind, identifier, relays } = decoded.data;
      if (kind !== NSITE_ROOT_KIND && kind !== NSITE_NAMED_KIND) return null;
      authority = {
        type: 'naddr',
        pubkey,
        kind,
        identifier,
        relays: relays ?? [],
      };
      naddrDtag = kind === NSITE_NAMED_KIND ? identifier : null;
    } catch {
      return null;
    }
  } else if (DOMAIN_RE.test(host)) {
    authority = { type: 'nip05', domain: host, name: '_' };
  }

  if (!authority) return null;

  // URL already normalized `..` and `.` away, so this is the effective path.
  const trailingSlash = url.pathname.endsWith('/');
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);

  // Optional `/@name/`, only meaningful for a NIP-05 authority.
  if (segments[0]?.startsWith('@')) {
    const name = decodeURIComponent(segments[0].slice(1)).toLowerCase();
    if (authority.type !== 'nip05' || !NIP05_NAME_RE.test(name)) return null;
    authority = { ...authority, name };
    segments.shift();
  }

  // An naddr already names the site, so it takes no `<site>` segment.
  let dtag: string | null;
  let rest: string[];
  if (authority.type === 'naddr') {
    dtag = naddrDtag;
    rest = segments;
  } else {
    const site = segments.length > 0 ? decodeURIComponent(segments[0]) : ROOT_SITE_SEGMENT;
    if (site === ROOT_SITE_SEGMENT) {
      dtag = null;
    } else if (isValidDtag(site)) {
      dtag = site;
    } else {
      // Not a site selector — e.g. `nsite://soapbox.pub/index.html`. Refusing
      // is the only safe reading: guessing "root site" here would make the
      // same path mean two different sites depending on its spelling.
      return null;
    }
    rest = segments.slice(1);
  }

  const suffix = rest.length > 0 ? `/${rest.join('/')}${trailingSlash ? '/' : ''}` : '/';

  return { authority, dtag, path: `${suffix}${url.search}${url.hash}` };
}

/** Whether a string is an nsite URL of either space. */
export function isNsiteUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === NSITE_PROTOCOL;
  } catch {
    return false;
  }
}

/**
 * Normalize address-bar input into a navigable nsite URL, or null if it isn't
 * one. This is where the `name@domain` spelling is accepted and rewritten into
 * the `/@name/` path form — safe here because it happens inside Din, before
 * Chromium can strip the userinfo.
 *
 *     mk@ditto.pub/polaroids       -> nsite://ditto.pub/@mk/polaroids
 *     nsite://mk@ditto.pub/~/home  -> nsite://ditto.pub/@mk/~/home
 *     naddr1…                      -> nsite://naddr1…/
 *     npub1…                       -> nsite://npub1…/
 */
export function normalizeNsiteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const body = trimmed.toLowerCase().startsWith(NSITE_PROTOCOL)
    ? trimmed.slice(NSITE_PROTOCOL.length).replace(/^\/\//, '')
    : trimmed;
  const explicitScheme = trimmed.toLowerCase().startsWith(NSITE_PROTOCOL);

  // Split authority from path before touching `@`, so a path-borne `@name`
  // segment is never mistaken for userinfo.
  const slash = body.indexOf('/');
  const authority = (slash === -1 ? body : body.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : body.slice(slash);

  let host = authority;
  let namePrefix = '';

  const at = authority.indexOf('@');
  if (at !== -1) {
    // Exactly one `@`, a valid NIP-05 local part, and a real domain to its
    // right - anything else is not addressing an nsite.
    if (authority.indexOf('@', at + 1) !== -1) return null;
    const name = authority.slice(0, at);
    const domain = authority.slice(at + 1);
    if (!NIP05_NAME_RE.test(name) || !DOMAIN_RE.test(domain)) return null;
    host = domain;
    namePrefix = `/@${name}`;
  }

  const isCanonical = !!parseCanonicalNsiteHost(host);
  const isAliasAuthority =
    host.startsWith('naddr1') || DOMAIN_RE.test(host) || isCanonical;
  if (!isAliasAuthority) return null;

  // Schemeless input is only nsite input when it can't be anything else: a
  // bare `example.com` still belongs to the https address bar, and a bare
  // `mk@ditto.pub` is far more likely to be an email address than a site.
  // `npub1…`, `naddr1…`, and canonical hosts are unambiguous.
  if (!explicitScheme && !host.startsWith('naddr1') && !isCanonical) {
    return null;
  }
  // Canonical hosts take no `@name` prefix - the key already names the owner.
  if (namePrefix && isCanonical) return null;

  const suffix = `${namePrefix}${path}` || '/';
  const candidate = `${NSITE_PROTOCOL}//${host}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;

  // Round-trip through the parsers so callers never get an unnavigable URL.
  try {
    const url = new URL(candidate);
    if (parseCanonicalNsiteHost(url.hostname)) return url.toString();
  } catch {
    return null;
  }
  return parseNsiteAlias(candidate) ? new URL(candidate).toString() : null;
}

/**
 * Alias prefixes Din has actually resolved, keyed by canonical host. Only
 * names that were really looked up land here — the address bar must never
 * invent a human-readable name for an origin, because the host is the security
 * boundary and a name Din didn't verify would be a lie about who owns the page.
 */
const resolvedAliases = new Map<string, string>();

/** Record that `aliasUrl` resolved to `canonicalUrl`, for display purposes. */
export function rememberNsiteAlias(aliasUrl: string, canonicalUrl: string): void {
  const alias = parseNsiteAlias(aliasUrl);
  // An `naddr` is no more readable than the canonical host, so it earns no
  // display alias; only a NIP-05 name does.
  if (!alias || alias.authority.type !== 'nip05') return;
  try {
    const host = new URL(canonicalUrl).hostname;
    const name = alias.authority.name === '_' ? '' : `/@${alias.authority.name}`;
    const site = `/${alias.dtag ?? ROOT_SITE_SEGMENT}`;
    resolvedAliases.set(
      host,
      `${NSITE_PROTOCOL}//${alias.authority.domain}${name}${site}`,
    );
  } catch {
    // Not a URL; nothing to remember.
  }
}

/**
 * The address-bar spelling of an nsite URL: the alias it was reached through
 * when Din resolved one, otherwise the canonical URL unchanged. The result is
 * always a URL the address bar can navigate back to, so retyping what's shown
 * lands on the same site.
 */
export function nsiteDisplayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== NSITE_PROTOCOL) return rawUrl;
    const prefix = resolvedAliases.get(url.hostname);
    if (!prefix) return rawUrl;
    return `${prefix}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}
