/**
 * nsite:// URL grammar (NIP-5A static websites).
 *
 * Three spellings of the same site, each with one job:
 *
 * **Display** — what the address bar shows, what "Copy link" emits, what you
 * type. Din owns this string end to end; it never goes near Chromium's URL
 * parser, so it can look however it should look:
 *
 *     nsite://soapbox.pub+armada/notifications   d=armada under _@soapbox.pub
 *     nsite://mk@ditto.pub+polaroids/            d=polaroids under mk@ditto.pub
 *     nsite://soapbox.pub/home                   root site of _@soapbox.pub
 *
 * The `d` tag rides in the host after `+`, so the path is just the site's own
 * path — a root site's `/home` and a named site's `/home` are spelled the same
 * way, and an SPA's routes need no escaping.
 *
 * **Alias** — the same thing, but as a URL Chromium will parse, used for the
 * navigation itself and for links inside pages. Identical to the display form
 * except that a non-default NIP-05 name is joined with `+` rather than `@`:
 *
 *     nsite://mk+ditto.pub+polaroids/
 *
 * That one substitution exists because `@` is URL userinfo, and Chromium
 * strips credentials before a request reaches `protocol.handle` (verified —
 * they are gone from `will-navigate` too). A page-authored
 * `nsite://mk@ditto.pub+polaroids/` would arrive as `_@ditto.pub`'s polaroids:
 * the wrong pubkey, with no error. `mk+ditto.pub+polaroids` survives intact.
 * Din normalizes `@` to `+` on the way in, so typing the pretty form always
 * works; the ugly spelling is transient and never displayed.
 *
 * **Canonical** — what actually serves bytes, and what the browser origin is.
 * NIP-5A's host verbatim, so an nsite origin maps 1:1 onto
 * `<label>.nsite-host.com` on any gateway:
 *
 *     nsite://<npub1…>/<path>            root site   (kind 15128)
 *     nsite://<pubkeyB36><dtag>/<path>   named site  (kind 35128)
 *
 * Because the host is derived from the pubkey, every site gets its own
 * Chromium origin — separate localStorage, IndexedDB, cookies, and service
 * worker — and a name repointing at a different key can never inherit the old
 * key's storage. Aliases 302 here and never serve a document themselves, so an
 * SPA can't pushState its way out of its own site: by the time page code runs,
 * its base URL is canonical.
 */

import { nip19 } from 'nostr-tools';

/** The URL scheme nsites are served under, with its trailing colon. */
export const NSITE_PROTOCOL = 'nsite:';

/** Replaceable event kind for a pubkey's root site (NIP-5A). */
export const NSITE_ROOT_KIND = 15128;
/** Addressable event kind for a named site under a pubkey (NIP-5A). */
export const NSITE_NAMED_KIND = 35128;

/** The NIP-05 name used when an alias names no one in particular. */
const DEFAULT_NIP05_NAME = '_';

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
  /** The path within the site, verbatim, including any query and fragment. */
  path: string;
}

/** One reading of an alias host, before the parts have been validated. */
interface HostReading {
  name: string;
  domain: string;
  dtag: string | null;
}

/**
 * Rewrite a display-form `name@host` authority into the wire form `name+host`,
 * purely textually.
 *
 * This cannot go through `URL`. Chromium drops userinfo outright when parsing
 * a scheme registered with `registerSchemesAsPrivileged` — verified:
 * `new URL('nsite://mk@ditto.pub+polaroids/')` yields
 * `nsite://ditto.pub+polaroids/` with an empty `username`, while the same
 * string under `https:` keeps `mk`. So the name has to be moved out of the
 * userinfo slot before any URL parser touches it, or it is simply gone.
 *
 * Returns null for a malformed authority. That matters: handing the original
 * string back would let the parser quietly drop the `@…` and resolve
 * `nsite://mk@@ditto.pub/` to `_@ditto.pub` — a different site than anyone
 * asked for. Failing is the only safe answer.
 */
function rewriteNsiteUserinfo(rawUrl: string): string | null {
  const prefix = `${NSITE_PROTOCOL}//`;
  if (!rawUrl.toLowerCase().startsWith(prefix)) return rawUrl;

  const rest = rawUrl.slice(prefix.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? '' : rest.slice(end);

  const at = authority.indexOf('@');
  if (at === -1) return rawUrl;
  if (authority.indexOf('@', at + 1) !== -1) return null;

  const name = authority.slice(0, at);
  const host = authority.slice(at + 1);
  if (!name || !host) return null;

  return `${prefix}${name}+${host}${tail}`;
}

/**
 * Parse an alias URL — display (`@`) or wire (`+`) spelling, they differ only
 * in how the name is joined. Returns null for anything that is not an alias,
 * including canonical URLs, which callers should try first via
 * {@link parseCanonicalNsiteHost}.
 */
export function parseNsiteAlias(rawUrl: string): NsiteAlias | null {
  // Fold `name@host` down to `name+host` first; the `@` spelling would
  // otherwise be silently discarded by the URL parser.
  const source = rewriteNsiteUserinfo(rawUrl);
  if (source === null) return null;

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== NSITE_PROTOCOL) return null;

  const host = url.hostname.toLowerCase();
  const path = `${url.pathname || '/'}${url.search}${url.hash}`;

  if (host.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type !== 'naddr') return null;
      const { pubkey, kind, identifier, relays } = decoded.data;
      if (kind !== NSITE_ROOT_KIND && kind !== NSITE_NAMED_KIND) return null;
      return {
        authority: { type: 'naddr', pubkey, kind, identifier, relays: relays ?? [] },
        dtag: kind === NSITE_NAMED_KIND ? identifier : null,
        path,
      };
    } catch {
      return null;
    }
  }

  const parts = host.split('+');
  if (parts.length > 3 || parts.some((part) => part.length === 0)) return null;

  // A `d` tag can never contain a dot and a domain must, so at most one
  // reading of a `+`-joined host can be valid. Try them in that order.
  const readings: HostReading[] = [];
  if (parts.length === 1) {
    readings.push({ name: '', domain: parts[0], dtag: null });
  } else if (parts.length === 2) {
    readings.push({ name: '', domain: parts[0], dtag: parts[1] });
    readings.push({ name: parts[0], domain: parts[1], dtag: null });
  } else {
    readings.push({ name: parts[0], domain: parts[1], dtag: parts[2] });
  }

  for (const reading of readings) {
    if (!DOMAIN_RE.test(reading.domain)) continue;
    if (reading.dtag !== null && !isValidDtag(reading.dtag)) continue;
    const name = reading.name || DEFAULT_NIP05_NAME;
    if (!NIP05_NAME_RE.test(name)) continue;
    return {
      authority: { type: 'nip05', domain: reading.domain, name },
      dtag: reading.dtag,
      path,
    };
  }

  return null;
}

/** The host of an alias, with the name joined by `separator`. */
function aliasHost(
  authority: Extract<NsiteAliasAuthority, { type: 'nip05' }>,
  dtag: string | null,
  separator: string,
): string {
  const name = authority.name === DEFAULT_NIP05_NAME ? '' : `${authority.name}${separator}`;
  return `${name}${authority.domain}${dtag ? `+${dtag}` : ''}`;
}

/**
 * The wire spelling of an alias: what gets handed to Chromium. Same as the
 * display form except that a name is joined with `+`, so it survives the
 * credential stripping that would otherwise silently drop it.
 */
export function nsiteAliasUrl(alias: NsiteAlias): string | null {
  if (alias.authority.type !== 'nip05') return null;
  return `${NSITE_PROTOCOL}//${aliasHost(alias.authority, alias.dtag, '+')}${alias.path}`;
}

/** The display spelling of an alias: the one with `@` in it. */
function nsiteAliasDisplay(alias: NsiteAlias): string | null {
  if (alias.authority.type !== 'nip05') return null;
  return `${NSITE_PROTOCOL}//${aliasHost(alias.authority, alias.dtag, '@')}${alias.path}`;
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
 * one. This is where `mk@ditto.pub+polaroids` becomes `mk+ditto.pub+polaroids`
 * — safe here because it happens inside Din, before Chromium can strip the
 * userinfo, and invisible because the address bar re-displays the `@` form.
 *
 *     nsite://soapbox.pub+armada/x   -> unchanged (no name to rewrite)
 *     nsite://mk@ditto.pub/          -> nsite://mk+ditto.pub/
 *     naddr1…                        -> nsite://naddr1…/
 *     npub1…                         -> nsite://npub1…/
 */
export function normalizeNsiteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const explicitScheme = trimmed.toLowerCase().startsWith(NSITE_PROTOCOL);
  // Move any `name@` out of the userinfo slot before parsing - see
  // rewriteNsiteUserinfo for why this can't wait until after `new URL`.
  const candidate = rewriteNsiteUserinfo(
    explicitScheme ? trimmed : `${NSITE_PROTOCOL}//${trimmed.replace(/^\/\//, '')}`,
  );
  if (candidate === null) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  // A canonical host is already navigable and takes no name.
  if (parseCanonicalNsiteHost(url.hostname.toLowerCase())) {
    return url.toString();
  }

  // Schemeless input is only nsite input when it can't be anything else: a
  // bare `example.com` still belongs to the https address bar, and a bare
  // `mk@ditto.pub` is far more likely to be an email address than a site.
  // `npub1…` and `naddr1…` are unambiguous.
  if (!explicitScheme && !url.hostname.toLowerCase().startsWith('naddr1')) {
    return null;
  }

  const alias = parseNsiteAlias(candidate);
  if (!alias) return null;
  if (alias.authority.type === 'naddr') return url.toString();
  return nsiteAliasUrl(alias);
}

/**
 * Alias spellings Din has actually resolved, keyed by canonical host. Only
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
    const host = new URL(canonicalUrl).hostname.toLowerCase();
    resolvedAliases.set(host, aliasHost(alias.authority, alias.dtag, '@'));
  } catch {
    // Not a URL; nothing to remember.
  }
}

/**
 * The address-bar spelling of an nsite URL: the name it was reached through
 * when Din resolved one, otherwise the URL unchanged. The result is always
 * something the address bar can navigate back to, so retyping what's shown
 * lands on the same site.
 */
export function nsiteDisplayUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.protocol !== NSITE_PROTOCOL) return rawUrl;

  const remembered = resolvedAliases.get(url.hostname.toLowerCase());
  if (remembered) {
    return `${NSITE_PROTOCOL}//${remembered}${url.pathname}${url.search}${url.hash}`;
  }

  // Not yet resolved (or never was): if this is itself an alias, show its
  // pretty spelling rather than the wire one.
  const alias = parseNsiteAlias(rawUrl);
  return (alias && nsiteAliasDisplay(alias)) ?? rawUrl;
}
