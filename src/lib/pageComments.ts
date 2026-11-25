import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

/**
 * Comments on web pages: NIP-22 kind 1111 events whose root is the page's
 * URL (`I` / `K web`), as Ditto and the Ditto browser extension write them,
 * so a comment posted from any of them shows in the others.
 *
 * The page's URL is canonicalized first, exactly as the extension does it
 * (its `src/lib/canonicalUrl.ts`): the fragment and tracking-only parameters
 * go, the rest stays. The canonical form is the `I` tag everyone queries by,
 * so changing it here strands comments made before: don't, unless the
 * extension changes in step.
 */

/** Tracking-only query parameters that are safe to strip (the extension's list, unchanged). */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'wbraid',
  'gbraid',
  'gad_source',
  'gad',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
]);

/**
 * A page's URL as comments name it, or null for what isn't a web page (the
 * browser's own pages, nostr: previews, files, nsites by their naddr).
 */
export function canonicalPageUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

/** The most comments one page's thread loads. */
export const PAGE_COMMENTS_LIMIT = 500;

/** Every comment on a page, top-level and replies: NIP-22 puts the root's `I` on each. */
export function pageCommentsFilter(page: string, limit = PAGE_COMMENTS_LIMIT): NostrFilter {
  return { kinds: [1111], '#I': [page], limit };
}

const tagValue = (event: NostrEvent, name: string) => event.tags.find(([n]) => n === name)?.[1];

/** Whether an event really is a comment on `page`, whatever a relay sent for the filter. */
export function isPageComment(event: NostrEvent, page: string): boolean {
  return event.kind === 1111 && event.tags.some(([n, v]) => n === 'I' && v === page);
}

/** NIP-22 tags for a comment on `page`, at its top or in reply to `parent` (a comment on it). */
export function pageCommentTags(page: string, parent?: NostrEvent): string[][] {
  const tags = [
    ['I', page],
    ['K', 'web'],
  ];
  if (parent) {
    tags.push(['e', parent.id, '', parent.pubkey], ['k', String(parent.kind)], ['p', parent.pubkey]);
  } else {
    tags.push(['i', page], ['k', 'web']);
  }
  return tags;
}

/** A page's comments arranged as a thread. */
export interface PageThread {
  /** Every comment, by id. */
  all: NostrEvent[];
  /** Comments on the page itself, newest first. */
  top: NostrEvent[];
  /** The direct replies to a comment, oldest first. */
  replies(id: string): NostrEvent[];
}

/**
 * Arrange comments into a thread. A reply whose parent isn't among them (not
 * on these relays, or deleted) is shown at the top, rather than lost.
 */
export function threadOf(events: NostrEvent[], page: string): PageThread {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) if (isPageComment(event, page)) byId.set(event.id, event);
  const all = [...byId.values()];
  const children = new Map<string, NostrEvent[]>();
  const top: NostrEvent[] = [];
  for (const event of all) {
    const parent = tagValue(event, 'e');
    if (parent && parent !== event.id && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(event);
      children.set(parent, list);
    } else {
      top.push(event);
    }
  }
  top.sort((a, b) => b.created_at - a.created_at);
  for (const list of children.values()) list.sort((a, b) => a.created_at - b.created_at);
  return { all, top, replies: (id) => children.get(id) ?? [] };
}

// ---- showing how many comments a page has ----

/**
 * Counting a page's comments as it loads asks relays about every page the
 * user visits, so it's off until they turn it on in about:preferences (or
 * `din browser comment-counts on`); private windows and Tor tabs never
 * count. Opening the comments pane asks about that one page, always.
 */
const COUNTS_KEY = 'din:browser:comment-counts';
const listeners = new Set<() => void>();
let countsShown: boolean | null = null;

export function subscribeCommentCounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function areCommentCountsShown(): boolean {
  if (countsShown === null) {
    try {
      countsShown = localStorage.getItem(COUNTS_KEY) === 'true';
    } catch {
      countsShown = false;
    }
  }
  return countsShown;
}

export function setCommentCountsShown(shown: boolean): void {
  countsShown = shown;
  try {
    localStorage.setItem(COUNTS_KEY, String(shown));
  } catch (error) {
    console.warn('Failed to save the comment counts setting:', error);
  }
  for (const listener of listeners) listener();
}

// ---- a comment drafted elsewhere (`din browser comment`) ----

/**
 * Comments drafted for a page by `din browser comment`, by canonical URL,
 * waiting for a browser window to show that page: the window opens its
 * comments pane with the draft in the composer, and posts it only when the
 * user presses Post.
 */
const drafts = new Map<string, string>();
const draftListeners = new Set<() => void>();

export function draftPageComment(page: string, text: string): void {
  drafts.set(page, text);
  for (const listener of draftListeners) listener();
}

/** The draft waiting for `page`, if there is one. */
export function pageCommentDraft(page: string): string | undefined {
  return drafts.get(page);
}

/** Let go of `page`'s draft: posted, or the pane closed. */
export function clearPageCommentDraft(page: string): void {
  if (!drafts.delete(page)) return;
  for (const listener of draftListeners) listener();
}

export function subscribePageCommentDrafts(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}
