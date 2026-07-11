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
