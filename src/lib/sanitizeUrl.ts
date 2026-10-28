import { normalizeInternalUrl } from '@/lib/internalPages';
import { normalizeNsiteInput, NSITE_PROTOCOL, parseCanonicalNsiteHost } from '@/lib/nsite';
import { parseNostrUri } from '@/lib/nostrUri';

/**
 * Sanitize a user-entered URL for safe use as an iframe `src`.
 *
 * Enforces an https-only allowlist. If the input has no scheme it is treated
 * as an `https://` URL. Any non-https result (e.g. `javascript:`, `data:`,
 * `http:`, `file:`) returns `null`. This is the top-priority XSS guard for the
 * browser app — never bypass it.
 */
export function sanitizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;

  return url.toString();
}

/**
 * Sanitize an installed app's URL: https, or an nsite on its canonical,
 * key-derived host. An `naddr` never qualifies: it is only ever redirected to
 * the canonical host, and the app's storage and Nostr connection belong to
 * that origin.
 */
export function sanitizeAppUrl(input: string): string | null {
  const https = sanitizeUrl(input);
  if (https) return https;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== NSITE_PROTOCOL) return null;
    return parseCanonicalNsiteHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a URL for top-level navigation — the Web Browser address bar and
 * terminal link clicks — where the destination is loaded as a real page in the
 * Electron `<webview>` (or a new host-browser tab), not injected into the app's
 * DOM.
 *
 * Broader than {@link sanitizeUrl}: it also permits `http:` so users can reach
 * local dev servers (`http://localhost:8080`) and plain-http sites, and
 * `nsite:` for NIP-5A sites served by Din itself (see `src/lib/nsite.ts`).
 * Script- and data-bearing schemes (`javascript:`, `data:`, `file:`, `blob:`,
 * …) are still rejected. This is safe because the `<webview>` is a separate
 * embedder outside the app's page and CSP. Never use it for an iframe/img
 * `src` of event-sourced data — use {@link sanitizeUrl} /
 * {@link sanitizeImageUrl} there. (The app CSP `frame-src` is https-only, so
 * the plain-browser iframe fallback simply won't load an `http:` result, and
 * `nsite:` has no handler outside the Electron shell at all.)
 */
export function sanitizeNavigationUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:' &&
    url.protocol !== NSITE_PROTOCOL
  ) {
    return null;
  }

  return url.toString();
}

const VIEW_SOURCE_PREFIX = 'view-source:';

/**
 * The `view-source:` URL that shows a page's source in a browser tab, or
 * `null` for anything that isn't an http/https/nsite page (internal pages,
 * blank tabs, extension pages, or a source view itself).
 */
export function viewSourceUrl(url: string): string | null {
  if (!/^(https?|nsite):\/\//i.test(url)) return null;
  const sanitized = sanitizeNavigationUrl(url);
  return sanitized && `${VIEW_SOURCE_PREFIX}${sanitized}`;
}

/** Whether a tab URL is a page-source view (`view-source:…`). */
export function isViewSourceUrl(url: string): boolean {
  return url.toLowerCase().startsWith(VIEW_SOURCE_PREFIX);
}

/**
 * Sanitize a URL for safe use as an image `src` (favicons, avatars, banners).
 *
 * Broader than {@link sanitizeUrl} because favicons are routinely served as
 * inline `data:` URIs rather than fetchable `https:` URLs. Allows `https:` and
 * `data:image/*` (both permitted by the app's `img-src` CSP), and rejects
 * everything else — notably `javascript:`, `http:`, and non-image `data:`
 * payloads. Never use this for navigation; use {@link sanitizeUrl} there.
 */
export function sanitizeImageUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Inline image data URIs are safe as an <img src> and common for favicons.
  // Restrict to image/* to avoid smuggling scripts through other MIME types.
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(trimmed)) {
    return trimmed;
  }

  return sanitizeUrl(trimmed);
}

/** A URL's origin, built by hand for nsite (whose `URL.origin` may be "null"). */
function originOf(raw: string): string | null {
  const url = new URL(raw);
  if (url.protocol === NSITE_PROTOCOL) {
    return url.hostname ? `${NSITE_PROTOCOL}//${url.hostname.toLowerCase()}` : null;
  }
  return url.origin === 'null' ? null : url.origin;
}

/**
 * Whether two URLs share the same origin (scheme + host + port). Non-URL
 * inputs, and URLs with an opaque origin, are never equal. Used to keep an
 * installed app's logged-in session pinned to its own site when a link is
 * routed into its window.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = originOf(a);
    return origin !== null && origin === originOf(b);
  } catch {
    return false;
  }
}

/**
 * Turn a query-or-URL string into a navigable http/https/nsite URL, or one of
 * the browser's own internal pages. If it looks like a bare search term, hand
 * it to a search engine instead. Bare loopback
 * addresses (`localhost:8080`, `127.0.0.1:3000`, `[::1]:8080`) default to
 * `http:` since that's what dev servers speak, and so do `.onion` addresses
 * since that's what most onion services speak; every other schemeless input
 * defaults to `https:`.
 */
export function resolveNavigation(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // The browser's own pages (about:preferences, nostr: links). Returned verbatim: the
  // caller paints them as chrome UI rather than loading them, so they skip
  // sanitizeNavigationUrl's http/nsite allowlist entirely — and, having no
  // `://`, they would otherwise fall through to a web search below.
  const internal = normalizeInternalUrl(trimmed);
  if (internal) return internal;

  // `view-source:<url>` shows a page's source, as in Chrome. The inner
  // address resolves like any other, so `view-source:example.com` works.
  if (isViewSourceUrl(trimmed)) {
    const inner = resolveNavigation(trimmed.slice(VIEW_SOURCE_PREFIX.length));
    return inner ? viewSourceUrl(inner) : null;
  }

  // nsite addresses first, so a bare `npub1…` or `naddr1…` isn't mistaken for
  // a search term.
  const nsite = normalizeNsiteInput(trimmed);
  if (nsite) return nsite;

  // Any other NIP-19 identifier (`nevent1…`, `note1…`, an article's
  // `naddr1…`) is a nostr: link without its scheme.
  const nostr = parseNostrUri(`nostr:${trimmed}`);
  if (nostr) return nostr.uri;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const isLoopback =
    /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(trimmed);
  const looksLikeDomain = /^[^\s]+\.[^\s]{2,}(\/.*)?$/i.test(trimmed);
  // Onion services are mostly plain http: Tor already encrypts and
  // authenticates the connection end to end.
  const isOnion = /^[^\s/:]+\.onion\.?(:\d+)?([/?#].*)?$/i.test(trimmed);

  if (hasScheme || isLoopback || looksLikeDomain) {
    const candidate = hasScheme
      ? trimmed
      : `${isLoopback || isOnion ? 'http' : 'https'}://${trimmed}`;
    const sanitized = sanitizeNavigationUrl(candidate);
    if (sanitized) return sanitized;
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}
