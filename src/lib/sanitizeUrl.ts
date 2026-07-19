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

/**
 * Whether two URLs share the same origin (scheme + host + port). Non-URL
 * inputs are never equal. Used to keep an installed app's logged-in session
 * pinned to its own site when a link is routed into its window.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Turn a query-or-URL string into a navigable https URL. If it looks like a
 * bare search term, hand it to a search engine instead.
 */
export function resolveNavigation(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const looksLikeUrl =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^[^\s]+\.[^\s]{2,}(\/.*)?$/i.test(trimmed);

  if (looksLikeUrl) {
    const sanitized = sanitizeUrl(trimmed);
    if (sanitized) return sanitized;
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}
