/**
 * Internal browser pages — chrome UI that a tab reaches by URL, the way
 * `chrome://settings` or `about:preferences` work in other browsers.
 *
 * These are *not* loadable URLs. A tab pointed at one parks its guest surface
 * on `about:blank` and paints a React component over it, so nothing here ever
 * reaches Chromium's network stack or a `<webview>` `src`.
 *
 * They are deliberately absent from `isAllowedTabUrl` (`src/lib/crx.ts`): a
 * web page or extension must not be able to steer a tab into the browser's
 * own settings. Only the chrome's own
 * navigation path — the address bar and the browser menu — can open one.
 */

/** The settings page. */
export const PREFERENCES_URL = 'about:preferences';

/** Every internal page, by URL. */
const INTERNAL_PAGES: Record<string, { title: string }> = {
  [PREFERENCES_URL]: { title: 'Settings' },
};

/**
 * Canonicalize user-typed input into an internal page URL, or `null` if it
 * doesn't name one. Case- and whitespace-insensitive, and tolerant of a
 * trailing slash, since that's what an address bar tends to produce.
 */
export function normalizeInternalUrl(input: string): string | null {
  const candidate = input.trim().toLowerCase().replace(/\/+$/, '');
  return candidate in INTERNAL_PAGES ? candidate : null;
}

/** Whether a committed tab URL is an internal page. */
export function isInternalUrl(url: string): boolean {
  return url in INTERNAL_PAGES;
}

/**
 * The tab label for an internal page, or `null` for any other URL. Internal
 * pages report no document title, so without this every one of them would
 * fall through to the generic "New tab".
 */
export function internalPageTitle(url: string): string | null {
  return INTERNAL_PAGES[url]?.title ?? null;
}
