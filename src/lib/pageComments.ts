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

/** Comments on the page itself fetched at a time; their replies come with them. */
export const COMMENTS_PAGE_SIZE = 30;
/** How many levels of replies are followed under a page of comments. */
const REPLY_ROUNDS = 4;

const tagValue = (event: NostrEvent, name: string) => event.tags.find(([n]) => n === name)?.[1];

/** Whether an event really is a comment on `page`, whatever a relay sent for the filter. */
export function isPageComment(event: NostrEvent, page: string): boolean {
  return event.kind === 1111 && event.tags.some(([n, v]) => n === 'I' && v === page);
}

/** A comment on the page itself, not a reply: its parent (`i`) is the page. */
function isTopLevel(event: NostrEvent, page: string): boolean {
  return event.tags.some(([n, v]) => n === 'i' && v === page);
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

/** One page of a page's comments: comments on it, the replies under them, and where the next page starts. */
export interface CommentsPage {
  top: NostrEvent[];
  replies: NostrEvent[];
  /** The next page's `until`, or null at the end. */
  until: number | null;
}

type Query = (filters: NostrFilter[]) => Promise<NostrEvent[]>;

/**
 * Fetch a page of comments on `page`: the newest comments on the page itself
 * up to `until`, and the replies under them, a level at a time. Relays are
 * asked for no more than that, so there's no knowing how many there are in
 * all until the last page.
 */
export async function fetchCommentsPage(query: Query, page: string, until?: number): Promise<CommentsPage> {
  const found = await query([
    { kinds: [1111], '#i': [page], limit: COMMENTS_PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
  ]);
  const top = found
    .filter((e) => isPageComment(e, page) && isTopLevel(e, page))
    .sort((a, b) => b.created_at - a.created_at);
  const seen = new Set(top.map((e) => e.id));
  const replies: NostrEvent[] = [];
  let frontier = [...seen];
  for (let round = 0; round < REPLY_ROUNDS && frontier.length > 0; round++) {
    const level = (await query([{ kinds: [1111], '#e': frontier, limit: 500 }])).filter(
      (e) => isPageComment(e, page) && !seen.has(e.id),
    );
    for (const e of level) seen.add(e.id);
    replies.push(...level);
    frontier = level.map((e) => e.id);
  }
  // `until` takes in the oldest's second again, for others posted in it: a
  // page with nothing new in it is the end.
  const oldest = top.at(-1)?.created_at;
  const more = top.length >= COMMENTS_PAGE_SIZE && oldest !== undefined && top.some((e) => e.created_at !== until);
  return { top, replies, until: more ? oldest : null };
}

/** A page's comments arranged as a thread. */
export interface PageThread {
  /** Every comment, by id. */
  all: NostrEvent[];
  /** Comments on the page itself, newest first. */
  top: NostrEvent[];
  /** Every reply under a comment on the page, however deep, oldest first. */
  replies(id: string): NostrEvent[];
  /** The comment a reply answers, when it's among them. */
  parent(id: string): NostrEvent | undefined;
}

/**
 * Arrange pages of comments into a thread one level deep, as comments read
 * best in a narrow pane: each comment on the page, then all the replies under
 * it in the order they came, each saying who it answers when that isn't the
 * comment they're under.
 */
export function threadOf(pages: CommentsPage[], page: string): PageThread {
  const byId = new Map<string, NostrEvent>();
  const top: NostrEvent[] = [];
  for (const p of pages) {
    for (const e of p.top) {
      if (byId.has(e.id)) continue;
      byId.set(e.id, e);
      top.push(e);
    }
  }
  const topIds = new Set(top.map((e) => e.id));
  const replyList: NostrEvent[] = [];
  for (const p of pages) {
    for (const e of p.replies) {
      if (byId.has(e.id) || !isPageComment(e, page)) continue;
      byId.set(e.id, e);
      replyList.push(e);
    }
  }
  const parentId = (e: NostrEvent) => tagValue(e, 'e');
  const groups = new Map<string, NostrEvent[]>();
  for (const reply of replyList) {
    // Up the chain to the comment on the page it's under.
    let at: NostrEvent | undefined = reply;
    for (let i = 0; at && i < 50 && !topIds.has(at.id); i++) {
      const next = parentId(at);
      at = next ? byId.get(next) : undefined;
    }
    if (!at || !topIds.has(at.id)) continue;
    const group = groups.get(at.id) ?? [];
    group.push(reply);
    groups.set(at.id, group);
  }
  top.sort((a, b) => b.created_at - a.created_at);
  for (const group of groups.values()) group.sort((a, b) => a.created_at - b.created_at);
  return {
    all: [...byId.values()],
    top,
    replies: (id) => groups.get(id) ?? [],
    parent: (id) => {
      const e = byId.get(id);
      const p = e && parentId(e);
      return p ? byId.get(p) : undefined;
    },
  };
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
