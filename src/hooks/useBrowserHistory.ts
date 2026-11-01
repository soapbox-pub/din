import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  clearBrowserHistory,
  frecency,
  getBrowserHistory,
  loadBrowserHistory,
  recordBrowserFavicon,
  recordBrowserTitle,
  recordBrowserVisit,
  subscribeBrowserHistory,
  type BrowserHistoryEntry,
} from '@/lib/browserHistoryStore';

export type { BrowserHistoryEntry };

/** A site worth a tile on the new-tab page. */
export interface TopSite {
  label: string;
  url: string;
  /** Icon URL, or null for a monogram. */
  icon: string | null;
  /** Whether `icon` is a full app icon (drawn edge to edge) or a small favicon. */
  appIcon: boolean;
  /** Brand color backing the monogram when there is no icon. */
  color?: string;
  /** An nsite's canonical host, whose icon comes from Din's nsite store. */
  nsiteHost?: string;
}

/**
 * The head start a default site gets, in recent visits: another site has to
 * be visited more than this often lately to rank above the defaults.
 */
const DEFAULT_SITE_SCORE = 3;

/** The host a URL counts toward on the new-tab page (`www.` folded in). */
function siteKey(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'nsite:') return null;
    return hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Most-visited sites for the new-tab page, Chrome/Brave style: history is
 * grouped by host and ranked by frecency (visit counts decaying with age),
 * and `defaults` compete with a fixed head start, so they hold their tiles
 * until the user's own habits outrank them.
 */
export function topSites(
  history: BrowserHistoryEntry[],
  defaults: TopSite[],
  limit: number,
  now = Date.now() / 1000,
): TopSite[] {
  const sites = new Map<
    string,
    {
      score: number;
      best: BrowserHistoryEntry;
      root: BrowserHistoryEntry | null;
      favicon: string | null;
    }
  >();
  for (const entry of history) {
    const key = siteKey(entry.url);
    if (!key) continue;
    const score = frecency(entry, now);
    const isRoot = new URL(entry.url).pathname === '/';
    const site = sites.get(key);
    if (!site) {
      sites.set(key, {
        score,
        best: entry,
        root: isRoot ? entry : null,
        favicon: entry.favicon ?? null,
      });
      continue;
    }
    site.score += score;
    if (entry.visits > site.best.visits) site.best = entry;
    if (isRoot && !site.root) site.root = entry;
    // History is most-recent-first, so the first favicon seen is the newest.
    site.favicon ??= entry.favicon ?? null;
  }

  const ranked: { site: TopSite; score: number }[] = defaults.map((site) => {
    const key = siteKey(site.url);
    const visited = key ? sites.get(key) : undefined;
    if (key) sites.delete(key);
    return { site, score: DEFAULT_SITE_SCORE + (visited?.score ?? 0) };
  });

  for (const [key, { score, best, root, favicon }] of sites) {
    const isNsite = best.url.startsWith('nsite://');
    ranked.push({
      site: isNsite
        ? {
            // An nsite's host is key-derived gibberish; its page title says
            // more.
            label: (root ?? best).title || key,
            url: `nsite://${key}/`,
            icon: null,
            appIcon: true,
            nsiteHost: key,
          }
        : {
            label: key,
            url: (root ?? best).url.replace(/^(https:\/\/[^/]+).*$/i, '$1/'),
            icon: favicon,
            appIcon: false,
          },
      score,
    });
  }

  // Stable sort: ties keep the defaults first, in their given order.
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map((r) => r.site);
}

/** Scheme and `www.` stripped, for user-friendly matching and display. */
export function bareUrl(url: string): string {
  return url.replace(/^(https|nsite):\/\/(www\.)?/i, '');
}

/**
 * How a history entry's address is shown: scheme-less, except that an nsite
 * keeps `nsite://`, so its key-derived host doesn't read as a web address.
 */
export function historyDisplayUrl(entry: BrowserHistoryEntry): string {
  return entry.url.startsWith('nsite://') ? entry.url : bareUrl(entry.url);
}

/**
 * Rank history entries against address-bar input. Matches on the URL (scheme
 * ignored) and the page title; URL-prefix matches rank highest, then any URL
 * substring, then title substrings.
 * Frequent and recent visits break ties.
 */
export function matchHistory(
  history: BrowserHistoryEntry[],
  query: string,
  limit = 6,
): BrowserHistoryEntry[] {
  const q = query.trim().toLowerCase().replace(/^(?:https?|nsite):\/\/(www\.)?/, '');
  if (!q) return [];

  const scored: { entry: BrowserHistoryEntry; score: number }[] = [];
  for (const entry of history) {
    const url = bareUrl(entry.url).toLowerCase();
    const title = entry.title?.toLowerCase() ?? '';
    let score = 0;
    if (url.startsWith(q)) score = 3;
    else if (url.includes(q)) score = 2;
    else if (title.includes(q)) score = 1;
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.visits - a.entry.visits ||
      b.entry.visitedAt - a.entry.visitedAt,
  );

  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * The forms of a history URL that address-bar typing may complete to, shortest
 * first: `www.` and a bare trailing slash are noise, so "https://www.reddit.com/"
 * offers "reddit.com" and "www.reddit.com".
 */
function completionTargets(entry: BrowserHistoryEntry): string[] {
  const noScheme = entry.url.replace(/^(?:https?|nsite):\/\//i, '').replace(/\/$/, '');
  const bare = noScheme.replace(/^www\./i, '');
  return bare === noScheme ? [bare] : [bare, noScheme];
}

/** The history pages under one site that typed text is a prefix of. */
interface SiteMatch {
  /** The site's name as it completes (`www.` only when that was typed). */
  host: string;
  /** The pages' summed frecency. */
  score: number;
  pages: number;
  /** Whether the site's front page itself is in history. */
  visited: boolean;
  best: { entry: BrowserHistoryEntry; target: string; score: number };
}

/**
 * Chrome-style inline autocomplete: what the typed text completes to,
 * returned as `typed` plus the characters that complete it (so the caller can
 * select the appended tail and let Enter take it, or backspace throw it
 * away). Null when nothing matches confidently.
 *
 * Matching pages are grouped by site, and the most-used site wins (typed
 * visits weigh most; see `frecency`). While the text is still part of the
 * site's name, it completes to the site itself when that was visited or more
 * than one page under it matches, so "you" offers "youtube.com", not a video;
 * a lone deep page has to have been typed before, or visited more than once.
 * Once the text runs past the site's name, the most-used page under it wins.
 *
 * Only start-of-URL matches qualify - the dropdown handles the fuzzier ones.
 * A scheme the user typed is honored (and preserved verbatim, along with
 * their capitalization); anything with whitespace is a search, not a URL.
 * Typing a visited URL or a site's name out in full ends the completion:
 * having reached "reddit.com", Enter should go there and not to a deeper page.
 */
export function inlineCompletion(
  history: BrowserHistoryEntry[],
  typed: string,
  now = Date.now() / 1000,
): string | null {
  if (/\s/.test(typed)) return null;

  const scheme = /^(?:https?|nsite):\/\//i.exec(typed)?.[0] ?? '';
  const q = typed.slice(scheme.length).toLowerCase();
  if (!q) return null;

  const sites = new Map<string, SiteMatch>();

  for (const entry of history) {
    if (scheme && !entry.url.toLowerCase().startsWith(scheme.toLowerCase())) continue;

    const targets = completionTargets(entry);
    if (targets.some((t) => t.toLowerCase() === q)) return null;

    const target = targets.find(
      (t) => t.length > q.length && t.toLowerCase().startsWith(q),
    );
    if (!target) continue;

    const slash = target.indexOf('/');
    const host = slash < 0 ? target : target.slice(0, slash);
    const key = host.toLowerCase();
    if (key === q) return null;

    const score = frecency(entry, now);
    const site = sites.get(key);
    if (!site) {
      sites.set(key, { host, score, pages: 1, visited: slash < 0, best: { entry, target, score } });
      continue;
    }
    site.score += score;
    site.pages += 1;
    if (slash < 0) site.visited = true;
    if (score > site.best.score) site.best = { entry, target, score };
  }

  let site: SiteMatch | null = null;
  for (const candidate of sites.values()) {
    if (!site || candidate.score > site.score) site = candidate;
  }
  if (!site) return null;

  let completion: string;
  if (q.length >= site.host.length) completion = site.best.target;
  else if (site.visited || site.pages > 1) completion = site.host;
  else if ((site.best.entry.typed ?? 0) > 0 || site.best.entry.visits > 1) {
    completion = site.best.target;
  } else return null;

  return typed + completion.slice(q.length);
}

/**
 * Where a schemeless address that names a visited site in full should go:
 * the URL that was visited, so "reddit.com" goes straight to
 * "https://www.reddit.com/" (as Chrome's omnibox does) instead of through
 * the site's redirect. A page that loaded (it has a title) beats an address
 * that was only typed and redirected away (see WebBrowser's typedUrls), then
 * the most-used wins; null when nothing matches.
 */
export function historyDestination(history: BrowserHistoryEntry[], text: string): string | null {
  const q = text.trim().toLowerCase();
  if (!q || /\s/.test(q) || /^[a-z][a-z0-9+.-]*:/.test(q)) return null;
  let best: BrowserHistoryEntry | null = null;
  for (const entry of history) {
    if (!/^https?:\/\//i.test(entry.url)) continue;
    if (!completionTargets(entry).some((t) => t.toLowerCase() === q)) continue;
    if (
      !best ||
      (!!entry.title && !best.title) ||
      (!!entry.title === !!best.title && frecency(entry) > frecency(best))
    ) {
      best = entry;
    }
  }
  return best?.url ?? null;
}

/**
 * The web browser's history for the signed-in account (see
 * `browserHistoryStore`), kept on this device only; it never syncs to relays.
 * Most recent first; empty until it loads off disk.
 */
export function useBrowserHistory() {
  const { user } = useCurrentUser();
  const owner = user?.pubkey ?? 'local';

  useEffect(() => {
    void loadBrowserHistory(owner);
  }, [owner]);

  const history = useSyncExternalStore(subscribeBrowserHistory, () => getBrowserHistory(owner));

  const recordVisit = useCallback(
    (url: string, typed?: boolean) => recordBrowserVisit(owner, url, typed),
    [owner],
  );
  const recordTitle = useCallback(
    (url: string, title: string) => recordBrowserTitle(owner, url, title),
    [owner],
  );
  const recordFavicon = useCallback(
    (url: string, favicon: string | null) => recordBrowserFavicon(owner, url, favicon),
    [owner],
  );
  const clearHistory = useCallback(() => clearBrowserHistory(owner), [owner]);

  return { history, recordVisit, recordTitle, recordFavicon, clearHistory };
}
