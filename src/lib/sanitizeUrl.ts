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
 * Sanitize a URL for top-level navigation — the Web Browser address bar and
 * terminal link clicks — where the destination is loaded as a real page in the
 * Electron `<webview>` (or a new host-browser tab), not injected into the app's
 * DOM.
 *
 * Broader than {@link sanitizeUrl}: it also permits `http:` so users can reach
 * local dev servers (`http://localhost:8080`) and plain-http sites. Script- and
 * data-bearing schemes (`javascript:`, `data:`, `file:`, `blob:`, …) are still
 * rejected. This is safe because the `<webview>` is a separate embedder outside
 * the app's page and CSP. Never use it for an iframe/img `src` of event-sourced
 * data — use {@link sanitizeUrl} / {@link sanitizeImageUrl} there. (The app CSP
 * `frame-src` is https-only, so the plain-browser iframe fallback simply won't
 * load an `http:` result.)
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

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

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
 * Turn a query-or-URL string into a navigable http/https URL. If it looks like
 * a bare search term, hand it to a search engine instead. Bare loopback
 * addresses (`localhost:8080`, `127.0.0.1:3000`, `[::1]:8080`) default to
 * `http:` since that's what dev servers speak; every other schemeless input
 * defaults to `https:`.
 */
export function resolveNavigation(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const isLoopback =
    /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(trimmed);
  const looksLikeDomain = /^[^\s]+\.[^\s]{2,}(\/.*)?$/i.test(trimmed);

  if (hasScheme || isLoopback || looksLikeDomain) {
    const candidate = hasScheme
      ? trimmed
      : `${isLoopback ? 'http' : 'https'}://${trimmed}`;
    const sanitized = sanitizeNavigationUrl(candidate);
    if (sanitized) return sanitized;
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}
