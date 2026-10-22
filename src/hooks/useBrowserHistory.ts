import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { useAppData } from '@/hooks/useAppData';

/** One visited page in the browser's history (most recent first). */
export interface BrowserHistoryEntry {
  /** The visited https URL. */
  url: string;
  /** Last page title seen for this URL, when one arrived. */
  title: string | null;
  /** Unix seconds of the most recent visit. */
  visitedAt: number;
  /** Total number of visits to this URL. */
  visits: number;
}

const browserHistorySchema: z.ZodType<BrowserHistoryEntry[]> = z.array(
  z.object({
    url: z.string(),
    title: z.string().nullable(),
    visitedAt: z.number(),
    visits: z.number(),
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

/** Scheme and `www.` stripped, for user-friendly matching and display. */
export function bareUrl(url: string): string {
  return url.replace(/^(https|nsite):\/\/(www\.)?/i, '');
}

/**
 * Rank history entries against address-bar input. Matches on the URL (scheme
 * ignored) and the page title; URL-prefix matches rank highest, then any URL
 * substring, then title substrings. Frequent and recent visits break ties.
 */
export function matchHistory(
  history: BrowserHistoryEntry[],
  query: string,
  limit = 6,
): BrowserHistoryEntry[] {
  const q = query.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
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
function completionTargets(url: string): string[] {
  const noScheme = url.replace(/^(?:https?|nsite):\/\//i, '').replace(/\/$/, '');
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

    const targets = completionTargets(entry.url);
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
 * (encrypted NIP-78 app data under `computer.din.browser-history`, cached
 * locally, roaming across devices when sync is on).
 *
 * Entries are unique by URL and ordered most-recent-first; revisiting a URL
 * moves it to the front and bumps its visit count.
 */
export function useBrowserHistory() {
  const [history, setHistory] = useAppData(
    'browser-history',
    browserHistorySchema,
    EMPTY_HISTORY,
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
      // Skip the write (and the relay republish it schedules) when nothing
      // changes — pages retitle themselves constantly.
      const current = historyRef.current.find((e) => e.url === url);
      if (!current || current.title === clean) return;
      setHistory((prev) =>
        prev.map((e) => (e.url === url ? { ...e, title: clean } : e)),
      );
    },
    [setHistory],
  );

  const clearHistory = useCallback(() => {
    setHistory(() => EMPTY_HISTORY);
  }, [setHistory]);

  return { history, recordVisit, recordTitle, clearHistory };
}
