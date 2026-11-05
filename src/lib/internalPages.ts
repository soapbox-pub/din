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
 *
 * A `nostr:` URI (src/lib/nostrUri.ts) is one too: a preview of what it names,
 * with buttons to open it in an app. Pages may open those, since they show
 * nothing but what the link points at.
 */

import { parseNostrUri } from '@/lib/nostrUri';
import { APP_KIND, isKnownExtension } from '@/lib/extensionCatalog';
import type { PackageAddress } from '@/lib/themePackages';

/** The settings page. */
export const PREFERENCES_URL = 'about:preferences';

/** Extensions published to Nostr, to find and get (src/components/desktop/apps/ExtensionsPage.tsx). */
export const EXTENSIONS_URL = 'about:extensions';

/** The bookmark manager (src/components/desktop/apps/BookmarksPage.tsx). */
export const BOOKMARKS_URL = 'about:bookmarks';

/** Every fixed internal page, by URL. */
const INTERNAL_PAGES: Record<string, { title: string }> = {
  [PREFERENCES_URL]: { title: 'Settings' },
  [EXTENSIONS_URL]: { title: 'Extensions' },
  [BOOKMARKS_URL]: { title: 'Bookmarks' },
};

/** Tab labels for a `nostr:` page, by what it names. */
const NOSTR_TITLES = { profile: 'Nostr profile', event: 'Nostr event', address: 'Nostr event' } as const;

/**
 * Canonicalize user-typed input into an internal page URL, or `null` if it
 * doesn't name one. Case- and whitespace-insensitive, and tolerant of a
 * trailing slash, since that's what an address bar tends to produce.
 */
export function normalizeInternalUrl(input: string): string | null {
  const nostr = parseNostrUri(input);
  if (nostr) return nostr.uri;
  const candidate = input.trim().toLowerCase().replace(/\/+$/, '');
  return candidate in INTERNAL_PAGES ? candidate : null;
}

/** Whether a committed tab URL is an internal page. */
export function isInternalUrl(url: string): boolean {
  return url in INTERNAL_PAGES || parseNostrUri(url) !== null;
}

/**
 * The tab label for an internal page, or `null` for any other URL. Internal
 * pages report no document title, so without this every one of them would
 * fall through to the generic "New tab".
 */
export function internalPageTitle(url: string): string | null {
  if (extensionAddressOf(url)) return INTERNAL_PAGES[EXTENSIONS_URL].title;
  const nostr = parseNostrUri(url);
  if (nostr) return NOSTR_TITLES[nostr.target.type];
  return INTERNAL_PAGES[url]?.title ?? null;
}

/**
 * The published extension a `nostr:` URI names, or null. Such a link opens
 * on about:extensions' page for it rather than the generic preview. Any
 * NIP-82 app has the same kind, so only one about:extensions knows to be an
 * extension does.
 */
export function extensionAddressOf(url: string): PackageAddress | null {
  const target = parseNostrUri(url)?.target;
  if (target?.type !== 'address' || target.kind !== APP_KIND) return null;
  if (!isKnownExtension(target.pubkey, target.identifier)) return null;
  return { type: 'extension', pubkey: target.pubkey, identifier: target.identifier };
}
