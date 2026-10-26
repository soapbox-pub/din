import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { useAppData } from '@/hooks/useAppData';

/** One visited page in the browser's history (most recent first). */
export interface BrowserHistoryEntry {
  /**
   * The visited https URL, or for an nsite its canonical URL - so visits
   * through a name and through the npub land on the same entry.
   */
  url: string;
  /** Last page title seen for this URL, when one arrived. */
  title: string | null;
  /** Unix seconds of the most recent visit. */
  visitedAt: number;
  /** Total number of visits to this URL. */
  visits: number;
  /** Last favicon URL the page reported (http(s) only), for top-site tiles. */
  favicon?: string;
}

const browserHistorySchema: z.ZodType<BrowserHistoryEntry[]> = z.array(
  z.object({
    url: z.string(),
    title: z.string().nullable(),
    visitedAt: z.number(),
    visits: z.number(),
    favicon: z.string().optional(),
  }),
);

const EMPTY_HISTORY: BrowserHistoryEntry[] = [];

const MAX_ENTRIES = 500;
/**
 * Budget for the serialized history. The whole list is NIP-44 encrypted into
 * a single event, and NIP-44 caps plaintext at 64 KB — stay well under it.
 */
const MAX_SERIALIZED_LENGTH = 48_000;
/** Very long URLs (session tokens, giant queries) aren't worth remembering. */
const MAX_URL_LENGTH = 1024;
const MAX_TITLE_LENGTH = 160;

/**
 * Whether a URL belongs in history: real https destinations, plus nsite://
 * sites, whose canonical URLs are key-derived and so stay meaningful (and
 * private — history is NIP-44 encrypted to the user).
 */
function isRecordable(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  return url.startsWith('https://') || url.startsWith('nsite://');
}

/** Enforce the entry count and serialized-size caps, dropping oldest first. */
function trimHistory(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  let out = entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries;
  while (out.length > 1 && JSON.stringify(out).length > MAX_SERIALIZED_LENGTH) {
    out = out.slice(0, Math.ceil(out.length * 0.9));
  }
  return out;
}

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

/** Visits lose half their weight every two weeks. */
const FRECENCY_HALF_LIFE_DAYS = 14;
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
    const ageDays = Math.max(0, now - entry.visitedAt) / 86_400;
    const score = entry.visits * 0.5 ** (ageDays / FRECENCY_HALF_LIFE_DAYS);
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

/**
 * Chrome-style inline autocomplete: the most-visited history URL that the
 * typed text is a prefix of, returned as `typed` plus the characters that
 * complete it (so the caller can select the appended tail and let Enter take
 * it, or backspace throw it away). Null when nothing matches confidently.
 *
 * Only start-of-URL matches qualify - the dropdown handles the fuzzier ones.
 * A scheme the user typed is honored (and preserved verbatim, along with
 * their capitalization); anything with whitespace is a search, not a URL.
 * Typing a visited URL out in full ends the completion: having reached
 * "reddit.com", Enter should go there and not to a deeper page.
 */
export function inlineCompletion(
  history: BrowserHistoryEntry[],
  typed: string,
): string | null {
  if (/\s/.test(typed)) return null;

  const scheme = /^(?:https?|nsite):\/\//i.exec(typed)?.[0] ?? '';
  const q = typed.slice(scheme.length).toLowerCase();
  if (!q) return null;

  let best: { entry: BrowserHistoryEntry; completion: string } | null = null;

  for (const entry of history) {
    if (scheme && !entry.url.toLowerCase().startsWith(scheme.toLowerCase())) continue;

    const targets = completionTargets(entry);
    if (targets.some((t) => t.toLowerCase() === q)) return null;

    const target = targets.find(
      (t) => t.length > q.length && t.toLowerCase().startsWith(q),
    );
    if (!target) continue;

    if (
      !best ||
      entry.visits > best.entry.visits ||
      (entry.visits === best.entry.visits && entry.visitedAt > best.entry.visitedAt)
    ) {
      best = { entry, completion: target };
    }
  }

  return best ? typed + best.completion.slice(q.length) : null;
}

/**
 * The web browser's persistent history, stored per-user via `useAppData`
 * on this device only; it never syncs to relays.
 *
 * Entries are unique by URL and ordered most-recent-first; revisiting a URL
 * moves it to the front and bumps its visit count.
 */
export function useBrowserHistory() {
  const [history, setHistory] = useAppData(
    'browser-history',
    browserHistorySchema,
    EMPTY_HISTORY,
    { localOnly: true },
  );

  // Mirror for callbacks that only need to read (recordTitle's no-op check).
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const recordVisit = useCallback(
    (url: string) => {
      if (!isRecordable(url)) return;
      setHistory((prev) => {
        const existing = prev.find((e) => e.url === url);
        const entry: BrowserHistoryEntry = {
          url,
          title: existing?.title ?? null,
          favicon: existing?.favicon,
          visitedAt: Math.floor(Date.now() / 1000),
          visits: (existing?.visits ?? 0) + 1,
        };
        return trimHistory([entry, ...prev.filter((e) => e.url !== url)]);
      });
    },
    [setHistory],
  );

  const recordTitle = useCallback(
    (url: string, title: string) => {
      const clean = title.trim().slice(0, MAX_TITLE_LENGTH);
      if (!clean) return;
      // Skip the write when nothing
      // changes — pages retitle themselves constantly.
      const current = historyRef.current.find((e) => e.url === url);
      if (!current || current.title === clean) return;
      setHistory((prev) =>
        prev.map((e) => (e.url === url ? { ...e, title: clean } : e)),
      );
    },
    [setHistory],
  );

  const recordFavicon = useCallback(
    (url: string, favicon: string | null) => {
      // Only plain http(s) icons: data: URIs would eat the size budget.
      if (!favicon || !/^https?:\/\//i.test(favicon) || favicon.length > MAX_URL_LENGTH) return;
      const current = historyRef.current.find((e) => e.url === url);
      if (!current || current.favicon === favicon) return;
      setHistory((prev) =>
        prev.map((e) => (e.url === url ? { ...e, favicon } : e)),
      );
    },
    [setHistory],
  );

  const clearHistory = useCallback(() => {
    setHistory(() => EMPTY_HISTORY);
  }, [setHistory]);

  return { history, recordVisit, recordTitle, recordFavicon, clearHistory };
}
