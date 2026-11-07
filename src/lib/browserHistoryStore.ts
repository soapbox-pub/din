import { z } from 'zod';
import { appDataCacheKey } from '@/lib/appData';

/**
 * The web browser's history, kept on this device only, in IndexedDB: one
 * database per account, one record per URL. Each account's history is read
 * into memory once and every change is written through, so the address bar
 * matches against it synchronously.
 *
 * Like Chrome, pages are kept for 90 days. Past a generous cap the least-used
 * pages go first, so a site visited every week outlasts yesterday's one-offs.
 */

/** One visited page in the browser's history. */
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
  /** How many of those visits were typed or picked in the address bar. */
  typed?: number;
  /**
   * Visits weighted by how they came (typed ones count for more) and decayed
   * with age, as of `visitedAt`; see `frecency`. Absent on entries from
   * before it was kept, which count their raw visits.
   */
  score?: number;
  /** Last favicon URL the page reported (http(s) only), for top-site tiles. */
  favicon?: string;
}

const entrySchema: z.ZodType<BrowserHistoryEntry> = z.object({
  url: z.string(),
  title: z.string().nullable(),
  visitedAt: z.number(),
  visits: z.number(),
  typed: z.number().optional(),
  score: z.number().optional(),
  favicon: z.string().optional(),
});

/** How long a page stays in history after its last visit. */
const RETENTION_SECONDS = 90 * 86_400;
/** Past this many pages, the least-used are dropped down to PRUNE_TO. */
const MAX_ENTRIES = 10_000;
const PRUNE_TO = 9_000;
/** Very long URLs (session tokens, giant queries) aren't worth remembering. */
const MAX_URL_LENGTH = 1024;
const MAX_TITLE_LENGTH = 160;

/** Visits lose half their weight every two weeks. */
const FRECENCY_HALF_LIFE_DAYS = 14;
/**
 * What a typed visit counts for against a followed link: an address the user
 * types is one they mean to come back to (Chrome weighs them the same way).
 */
const TYPED_VISIT_WEIGHT = 5;

function decay(score: number, from: number, to: number): number {
  return score * 0.5 ** (Math.max(0, to - from) / 86_400 / FRECENCY_HALF_LIFE_DAYS);
}

/**
 * How much an entry is used: its weighted visits, each fading by half every
 * two weeks.
 */
export function frecency(entry: BrowserHistoryEntry, now = Date.now() / 1000): number {
  return decay(entry.score ?? entry.visits, entry.visitedAt, now);
}

/**
 * Whether a URL belongs in history: real https destinations, plus nsite://
 * sites, whose canonical URLs are key-derived and so stay meaningful, and
 * blossom: files, named by their hash.
 */
function isRecordable(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  return url.startsWith('https://') || url.startsWith('nsite://') || url.startsWith('blossom:');
}

interface AccountHistory {
  entries: Map<string, BrowserHistoryEntry>;
  /** Most recent first; rebuilt lazily after a change. */
  snapshot: BrowserHistoryEntry[] | null;
  db: Promise<IDBDatabase | null>;
  loaded: Promise<void>;
  /** Cleared before it finished loading: what's on disk is gone too. */
  cleared: boolean;
}

const EMPTY: BrowserHistoryEntry[] = [];
const accounts = new Map<string, AccountHistory>();
const listeners = new Set<() => void>();

function notify(account: AccountHistory): void {
  account.snapshot = null;
  for (const listener of listeners) listener();
}

/** Subscribe to changes in any account's history. Returns an unsubscribe fn. */
export function subscribeBrowserHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An account's history, most recent first. Stable until it changes. */
export function getBrowserHistory(owner: string): BrowserHistoryEntry[] {
  const account = accounts.get(owner);
  if (!account) return EMPTY;
  account.snapshot ??= [...account.entries.values()].sort((a, b) => b.visitedAt - a.visitedAt);
  return account.snapshot;
}

function openDb(owner: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(`din-browser-history:${owner}`, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries', { keyPath: 'url' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Failed to open browser history:', request.error);
        resolve(null);
      };
    } catch (error) {
      console.warn('Failed to open browser history:', error);
      resolve(null);
    }
  });
}

/** Write changes in one transaction, resolving to whether it committed. */
async function persist(
  account: AccountHistory,
  changes: { put?: BrowserHistoryEntry[]; remove?: string[]; clear?: boolean },
): Promise<boolean> {
  try {
    const db = await account.db;
    if (!db) return false;
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    if (changes.clear) store.clear();
    for (const url of changes.remove ?? []) store.delete(url);
    for (const entry of changes.put ?? []) store.put(entry);
    return await new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => {
        console.warn('Failed to save browser history:', tx.error);
        resolve(false);
      };
    });
  } catch (error) {
    console.warn('Failed to save browser history:', error);
    return false;
  }
}

function parseEntries(items: unknown[]): BrowserHistoryEntry[] {
  return items.flatMap((item) => {
    const entry = entrySchema.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

function readAll(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('entries').objectStore('entries').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The history Din kept before, as one size-capped list in localStorage
 * (`useAppData`'s cache for the `browser-history` key).
 */
function readLegacy(owner: string): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(appDataCacheKey(owner, 'browser-history'));
    if (raw === null) return [];
    const parsed = z.object({ value: z.array(z.unknown()) }).safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parseEntries(parsed.data.value);
  } catch {
    return [];
  }
}

/**
 * Drop what's past retention, and past the cap the least-used, returning the
 * URLs removed.
 */
function prune(account: AccountHistory, now = Date.now() / 1000): string[] {
  const removed: string[] = [];
  for (const [url, entry] of account.entries) {
    if (now - entry.visitedAt > RETENTION_SECONDS) removed.push(url);
  }
  for (const url of removed) account.entries.delete(url);
  if (account.entries.size > MAX_ENTRIES) {
    const ranked = [...account.entries.values()].sort((a, b) => frecency(a, now) - frecency(b, now));
    for (const entry of ranked.slice(0, ranked.length - PRUNE_TO)) {
      account.entries.delete(entry.url);
      removed.push(entry.url);
    }
  }
  return removed;
}

/** Two records of one URL: the counts add up, and the newer visit's details win. */
function merge(a: BrowserHistoryEntry, b: BrowserHistoryEntry): BrowserHistoryEntry {
  const [newer, older] = a.visitedAt >= b.visitedAt ? [a, b] : [b, a];
  return {
    ...newer,
    title: newer.title ?? older.title,
    favicon: newer.favicon ?? older.favicon,
    visits: newer.visits + older.visits,
    typed: (newer.typed ?? 0) + (older.typed ?? 0),
    score: (newer.score ?? newer.visits) + frecency(older, newer.visitedAt),
  };
}

async function load(account: AccountHistory, owner: string): Promise<void> {
  const db = await account.db;
  if (!db || account.cleared) {
    notify(account);
    return;
  }
  let stored: BrowserHistoryEntry[] = [];
  try {
    stored = parseEntries(await readAll(db));
  } catch (error) {
    console.warn('Failed to load browser history:', error);
  }
  if (account.cleared) {
    notify(account);
    return;
  }
  const legacy = stored.length ? [] : readLegacy(owner);
  // What was recorded while this loaded is merged in, not overwritten.
  const changed: BrowserHistoryEntry[] = [];
  for (const entry of [...stored, ...legacy]) {
    const current = account.entries.get(entry.url);
    const next = current ? merge(current, entry) : entry;
    account.entries.set(entry.url, next);
    if (current || legacy.length) changed.push(next);
  }
  const removed = prune(account);
  const saved = await persist(account, {
    put: changed.filter((e) => account.entries.has(e.url)),
    remove: removed,
  });
  if (saved && legacy.length) localStorage.removeItem(appDataCacheKey(owner, 'browser-history'));
  notify(account);
}

function getAccount(owner: string): AccountHistory {
  const existing = accounts.get(owner);
  if (existing) return existing;
  const account: AccountHistory = {
    entries: new Map(),
    snapshot: null,
    db: openDb(owner),
    loaded: Promise.resolve(),
    cleared: false,
  };
  accounts.set(owner, account);
  account.loaded = load(account, owner);
  return account;
}

/** Read an account's history off disk, once. */
export function loadBrowserHistory(owner: string): Promise<void> {
  return getAccount(owner).loaded;
}

function update(owner: string, entry: BrowserHistoryEntry): void {
  const account = getAccount(owner);
  account.entries.set(entry.url, entry);
  const removed = account.entries.size > MAX_ENTRIES ? prune(account) : [];
  void persist(account, { put: [entry], remove: removed });
  notify(account);
}

/**
 * Record a visit to `url`: moves it to the front and bumps its visit count.
 * `typed` is a visit the user asked for in the address bar (typed, or picked
 * from its suggestions), rather than a link or redirect.
 */
export function recordBrowserVisit(owner: string, url: string, typed = false): void {
  if (!isRecordable(url)) return;
  const existing = getAccount(owner).entries.get(url);
  const now = Math.floor(Date.now() / 1000);
  update(owner, {
    url,
    title: existing?.title ?? null,
    favicon: existing?.favicon,
    visitedAt: now,
    visits: (existing?.visits ?? 0) + 1,
    typed: (existing?.typed ?? 0) + (typed ? 1 : 0),
    score: (existing ? frecency(existing, now) : 0) + (typed ? TYPED_VISIT_WEIGHT : 1),
  });
}

/** Join a page's title onto its entry. */
export function recordBrowserTitle(owner: string, url: string, title: string): void {
  const clean = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!clean) return;
  // Pages retitle themselves constantly; skip the write when nothing changes.
  const current = getAccount(owner).entries.get(url);
  if (!current || current.title === clean) return;
  update(owner, { ...current, title: clean });
}

/** Join a page's favicon onto its entry. */
export function recordBrowserFavicon(owner: string, url: string, favicon: string | null): void {
  // Only plain http(s) icons: data: URIs aren't worth storing per page.
  if (!favicon || !/^https?:\/\//i.test(favicon) || favicon.length > MAX_URL_LENGTH) return;
  const current = getAccount(owner).entries.get(url);
  if (!current || current.favicon === favicon) return;
  update(owner, { ...current, favicon });
}

/** Forget some pages (Shift+Delete on an address-bar suggestion). */
export function removeBrowserHistory(owner: string, urls: string[]): void {
  const account = getAccount(owner);
  const removed = urls.filter((url) => account.entries.delete(url));
  if (!removed.length) return;
  void persist(account, { remove: removed });
  notify(account);
}

/**
 * The suggested sites (see `browserSuggestedSites`) an account removed from
 * its address-bar suggestions, by URL. Kept in localStorage, apart from
 * history, so clearing history or its 90-day expiry doesn't bring them back.
 */
const dismissed = new Map<string, readonly string[]>();

function dismissedKey(owner: string): string {
  return `din-browser-dismissed-suggestions:${owner}`;
}

/** An account's dismissed suggested sites. Stable until it changes. */
export function getDismissedSuggestions(owner: string): readonly string[] {
  let urls = dismissed.get(owner);
  if (!urls) {
    try {
      const parsed = z.array(z.string()).safeParse(
        JSON.parse(localStorage.getItem(dismissedKey(owner)) ?? '[]'),
      );
      urls = parsed.success ? parsed.data : [];
    } catch {
      urls = [];
    }
    dismissed.set(owner, urls);
  }
  return urls;
}

/** Stop suggesting a suggested site to an account. */
export function dismissSuggestion(owner: string, url: string): void {
  const current = getDismissedSuggestions(owner);
  if (current.includes(url)) return;
  const next = [...current, url];
  dismissed.set(owner, next);
  try {
    localStorage.setItem(dismissedKey(owner), JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to save dismissed suggestions:', error);
  }
  for (const listener of listeners) listener();
}

/** Forget an account's whole history. */
export function clearBrowserHistory(owner: string): void {
  const account = getAccount(owner);
  account.entries.clear();
  account.cleared = true;
  localStorage.removeItem(appDataCacheKey(owner, 'browser-history'));
  void persist(account, { clear: true });
  notify(account);
}
