import type { NostrEvent, NostrFilter, NRelay } from '@nostrify/nostrify';
import { NSITE_NAMED_KIND } from '@/lib/nsite';
import {
  deriveNsiteAppDetails,
  NSITE_APP_INFO_VERSION,
  type NsiteAppDetails,
} from '@/lib/nsiteAppInfo';
import { blossomFileSource } from '@/lib/nsiteBlossom';
import {
  FEATURED_APPS_PACK,
  FEATURED_HERO,
  isListedApp,
  parseStoreApp,
  type StoreApp,
} from '@/lib/nsiteCatalog';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * The App Store's catalog, kept on disk (IndexedDB) so the store opens on what
 * it showed last time instead of on a skeleton.
 *
 * It holds the newest named-site manifest (kind 35128) per address, the
 * deletion requests (kind 5) that cover them, and for each site the verdict of
 * checking its files: whether it is an app the store lists, and if so the
 * name, icon and blurb it shows. The store only ever shows a site that has
 * passed that check, so a card never appears and then drops out.
 *
 * Relays are asked for two things: everything newer than one global cursor
 * (syncCatalogTop), and pages going back in time as the user scrolls
 * (loadCatalogPage). The pages re-ask for what is already on disk, which is
 * how the older sites of someone just followed get found.
 */

/** Manifests per relay page. */
export const CATALOG_PAGE = 50;

/** Overlap kept below the cursor, for publishers whose clocks run behind. */
const CURSOR_SLOP = 10 * 60;

/** How long a site that failed the check waits before it is checked again. */
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Sites checked at once. Each check reads a few files from Blossom. */
const CHECK_CONCURRENCY = 4;

const DELETION_KIND = 5;

/** A named site, as the catalog keeps it. */
export interface CatalogEntry {
  /** `pubkey:d`. */
  addr: string;
  /** The newest manifest. */
  event: NostrEvent;
  /** The last check: which manifest, by which derivation, when, and its verdict. */
  check?: { id: string; version: number; at: number; listed: boolean };
  /**
   * The newest manifest that passed, with what it showed. It may be older
   * than `event`; it keeps showing until `event` has been checked.
   */
  listed?: { event: NostrEvent; details: NsiteAppDetails };
}

/** The featured rail, as last fetched. */
export interface FeaturedSnapshot {
  title: string;
  description?: string;
  image?: string;
  /** Hero first, then the members' apps, newest first. */
  addrs: string[];
}

/** A deletion on disk: an address deleted up to `at`, or one event by id. */
type DeletionRecord = { key: string; at?: number; pubkey?: string };

const entries = new Map<string, CatalogEntry>();
const apps = new Map<string, StoreApp>();
const detailsById = new Map<string, NsiteAppDetails>();
/** Address -> newest deletion's `created_at`. */
const deletedAddrs = new Map<string, number>();
/** Event id -> the pubkey that deleted it. */
const deletedIds = new Map<string, string>();
let cursor: number | null = null;
let featured: FeaturedSnapshot | null | undefined;
let loaded = false;

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumped on every change, for useSyncExternalStore. */
export function getCatalogVersion(): number {
  return version;
}

export function isCatalogLoaded(): boolean {
  return loaded;
}

export function catalogEntries(): Iterable<CatalogEntry> {
  return entries.values();
}

export function catalogEntry(addr: string): CatalogEntry | undefined {
  return entries.get(addr);
}

/** The StoreApp a listed entry shows, or null for one that isn't listed. */
export function listedApp(addr: string): StoreApp | null {
  return apps.get(addr) ?? null;
}

/** The checked details of a listed manifest, for seeding its card. */
export function cachedDetails(eventId: string): NsiteAppDetails | undefined {
  return detailsById.get(eventId);
}

/** The featured rail: undefined until known, null when there is none. */
export function getFeatured(): FeaturedSnapshot | null | undefined {
  return featured;
}

/** Whether an entry's newest manifest still has to be checked. */
export function needsCheck(entry: CatalogEntry): boolean {
  const { check } = entry;
  if (!check || check.id !== entry.event.id || check.version !== NSITE_APP_INFO_VERSION) {
    return true;
  }
  return !check.listed && Date.now() - check.at > RECHECK_MS;
}

function setEntry(entry: CatalogEntry): void {
  const previous = entries.get(entry.addr);
  if (previous?.listed) detailsById.delete(previous.listed.event.id);
  entries.set(entry.addr, entry);
  const app = entry.listed ? parseStoreApp(entry.listed.event) : null;
  if (app && entry.listed) {
    apps.set(entry.addr, app);
    detailsById.set(entry.listed.event.id, entry.listed.details);
  } else {
    apps.delete(entry.addr);
  }
}

function removeEntry(addr: string): void {
  const previous = entries.get(addr);
  if (previous?.listed) detailsById.delete(previous.listed.event.id);
  entries.delete(addr);
  apps.delete(addr);
}

// --- Disk ---

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('din-nsite-catalog', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('entries', { keyPath: 'addr' });
      db.createObjectStore('deletions', { keyPath: 'key' });
      db.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function getMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('meta').objectStore('meta').get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

interface Changes {
  put?: CatalogEntry[];
  remove?: string[];
  deletions?: DeletionRecord[];
  meta?: Record<string, unknown>;
}

/** Write changes in one transaction. A failed write only costs the next start. */
async function persist(changes: Changes): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(['entries', 'deletions', 'meta'], 'readwrite');
    for (const entry of changes.put ?? []) tx.objectStore('entries').put(entry);
    for (const addr of changes.remove ?? []) tx.objectStore('entries').delete(addr);
    for (const record of changes.deletions ?? []) tx.objectStore('deletions').put(record);
    for (const [key, value] of Object.entries(changes.meta ?? {})) {
      tx.objectStore('meta').put(value, key);
    }
  } catch (error) {
    console.warn('Failed to save the app catalog:', error);
  }
}

let loading: Promise<void> | undefined;

/** Read the catalog off disk, once. Everything that changes it waits for this. */
export function loadCatalog(): Promise<void> {
  loading ??= (async () => {
    try {
      const db = await openDb();
      const [stored, deletions, storedCursor, storedFeatured] = await Promise.all([
        getAll<CatalogEntry>(db, 'entries'),
        getAll<DeletionRecord>(db, 'deletions'),
        getMeta<number>(db, 'cursor'),
        getMeta<FeaturedSnapshot | null>(db, 'featured'),
      ]);
      for (const entry of stored) setEntry(entry);
      for (const record of deletions) {
        if (record.at !== undefined) deletedAddrs.set(record.key.slice(2), record.at);
        if (record.pubkey !== undefined) deletedIds.set(record.key.slice(2), record.pubkey);
      }
      cursor = storedCursor ?? null;
      featured = storedFeatured;
    } catch (error) {
      console.warn('Failed to load the app catalog:', error);
    }
    loaded = true;
    notify();
  })();
  return loading;
}

// --- Relays ---

function addrOf(pubkey: string, dtag: string): string {
  return `${pubkey}:${dtag}`;
}

/**
 * Take in manifests and deletion requests from relays. Only events by
 * `authors` count: manifests are addressable, so the author is the trust
 * boundary. A deletion only applies to its own author's sites (NIP-09).
 */
function ingest(events: NostrEvent[], authors: Set<string>): void {
  const put = new Map<string, CatalogEntry>();
  const remove = new Set<string>();
  const deletions: DeletionRecord[] = [];

  for (const event of events) {
    if (event.kind !== DELETION_KIND || !authors.has(event.pubkey)) continue;
    for (const [name, value] of event.tags) {
      if (name === 'a' && value) {
        const [kind, pubkey, ...rest] = value.split(':');
        if (kind !== String(NSITE_NAMED_KIND) || pubkey !== event.pubkey) continue;
        const addr = addrOf(pubkey, rest.join(':'));
        if ((deletedAddrs.get(addr) ?? -1) >= event.created_at) continue;
        deletedAddrs.set(addr, event.created_at);
        deletions.push({ key: `a:${addr}`, at: event.created_at });
        const entry = entries.get(addr);
        if (entry && entry.event.created_at <= event.created_at) {
          removeEntry(addr);
          put.delete(addr);
          remove.add(addr);
        }
      } else if (name === 'e' && value && !deletedIds.has(value)) {
        deletedIds.set(value, event.pubkey);
        deletions.push({ key: `e:${value}`, pubkey: event.pubkey });
        for (const entry of entries.values()) {
          if (entry.event.id !== value || entry.event.pubkey !== event.pubkey) continue;
          removeEntry(entry.addr);
          put.delete(entry.addr);
          remove.add(entry.addr);
        }
      }
    }
  }

  for (const event of events) {
    if (event.kind !== NSITE_NAMED_KIND || !authors.has(event.pubkey)) continue;
    const app = parseStoreApp(event);
    if (!app?.dtag) continue;
    const addr = addrOf(event.pubkey, app.dtag);
    if ((deletedAddrs.get(addr) ?? -1) >= event.created_at) continue;
    if (deletedIds.get(event.id) === event.pubkey) continue;
    const existing = entries.get(addr);
    if (existing && existing.event.created_at >= event.created_at) continue;
    const entry: CatalogEntry = { ...existing, addr, event };
    setEntry(entry);
    put.set(addr, entry);
    remove.delete(addr);
  }

  if (put.size || remove.size || deletions.length) {
    void persist({ put: [...put.values()], remove: [...remove], deletions });
    notify();
  }
}

function query(relays: NRelay, filters: NostrFilter[], signal: AbortSignal): Promise<NostrEvent[]> {
  return relays.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
}

/**
 * Everything the authors published or deleted since the cursor, then move the
 * cursor up. With no cursor yet, the first page brings the newest sites and
 * this only fetches deletions.
 */
export async function syncCatalogTop(
  relays: NRelay,
  authors: string[],
  signal: AbortSignal,
): Promise<void> {
  await loadCatalog();
  const started = Math.floor(Date.now() / 1000);
  const since = cursor === null ? undefined : cursor - CURSOR_SLOP;
  const deletions: NostrFilter = { kinds: [DELETION_KIND], authors, '#k': [String(NSITE_NAMED_KIND)] };
  const filters: NostrFilter[] = [since === undefined ? deletions : { ...deletions, since }];
  if (since !== undefined) filters.push({ kinds: [NSITE_NAMED_KIND], authors, since });
  ingest(await query(relays, filters, signal), new Set(authors));
  cursor = started;
  void persist({ meta: { cursor } });
}

/**
 * One page of manifests (and deletions) at or before `until`, or the newest
 * page without it. Returns where the next page starts, or null once the
 * relays have nothing older.
 */
export async function loadCatalogPage(
  relays: NRelay,
  authors: string[],
  until: number | undefined,
  signal: AbortSignal,
): Promise<number | null> {
  await loadCatalog();
  const range = until === undefined ? {} : { until };
  const events = await query(
    relays,
    [
      { kinds: [NSITE_NAMED_KIND], authors, limit: CATALOG_PAGE, ...range },
      {
        kinds: [DELETION_KIND],
        authors,
        '#k': [String(NSITE_NAMED_KIND)],
        limit: CATALOG_PAGE,
        ...range,
      },
    ],
    signal,
  );
  ingest(events, new Set(authors));

  // Several relays answer at once, so the page's edge is where the merged
  // answer holds a full page, not the oldest event any one relay sent.
  const times = events
    .filter((event) => event.kind === NSITE_NAMED_KIND)
    .map((event) => event.created_at)
    .sort((a, b) => b - a);
  if (times.length < CATALOG_PAGE) return null;
  const next = times[CATALOG_PAGE - 1];
  // A page all at one second would ask for itself again.
  return until !== undefined && next >= until ? until - 1 : next;
}

/**
 * The featured rail: the curated follow pack (kind 39089) for its title, the
 * hero (FEATURED_HERO, Ditto) by its address, and the members' named sites
 * packaged as apps, with a `title` and a `description`.
 */
export async function syncFeatured(relays: NRelay, signal: AbortSignal): Promise<void> {
  await loadCatalog();

  // Addressable event, so the query is author-scoped: the d tag alone is not
  // a trust boundary.
  const pack = (
    await query(
      relays,
      [{
        kinds: [FEATURED_APPS_PACK.kind],
        authors: [FEATURED_APPS_PACK.pubkey],
        '#d': [FEATURED_APPS_PACK.identifier],
        limit: 1,
      }],
      signal,
    )
  )
    .filter((event) => event.pubkey === FEATURED_APPS_PACK.pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];

  const members = pack
    ? Array.from(new Set(
        pack.tags
          .filter(([name, value]) => name === 'p' && /^[0-9a-f]{64}$/.test(value ?? ''))
          .map(([, value]) => value),
      ))
    : [];
  const authors = [...new Set([FEATURED_HERO.pubkey, ...members])];

  const events = await query(
    relays,
    [
      { kinds: [NSITE_NAMED_KIND], authors: [FEATURED_HERO.pubkey], '#d': [FEATURED_HERO.dtag], limit: 1 },
      ...(members.length ? [{ kinds: [NSITE_NAMED_KIND], authors: members, limit: 300 }] : []),
      { kinds: [DELETION_KIND], authors, '#k': [String(NSITE_NAMED_KIND)] },
    ],
    signal,
  );
  ingest(events, new Set(authors));

  const heroAddr = addrOf(FEATURED_HERO.pubkey, FEATURED_HERO.dtag);
  const memberSet = new Set(members);
  const shelf = [...entries.values()]
    .filter((entry) => {
      if (entry.addr === heroAddr || !memberSet.has(entry.event.pubkey)) return false;
      const app = parseStoreApp(entry.event);
      return Boolean(app?.name && app.about);
    })
    .sort((a, b) => b.event.created_at - a.event.created_at)
    .map((entry) => entry.addr);
  const addrs = entries.has(heroAddr) ? [heroAddr, ...shelf] : shelf;

  featured = addrs.length === 0
    ? null
    : {
        title: pack?.tags.find(([name]) => name === 'title')?.[1] ?? 'Featured',
        description: pack?.tags.find(([name]) => name === 'description')?.[1],
        image: sanitizeUrl(pack?.tags.find(([name]) => name === 'image')?.[1] ?? '') ?? undefined,
        addrs,
      };
  void persist({ meta: { featured } });
  notify();
}

// --- Checks ---

const queue: string[] = [];
const queued = new Set<string>();
let running = 0;

/** Check these sites' files, in order, unless they are already checked. */
export function requestChecks(addrs: string[]): void {
  for (const addr of addrs) {
    if (queued.has(addr)) continue;
    queued.add(addr);
    queue.push(addr);
  }
  pump();
}

function pump(): void {
  while (running < CHECK_CONCURRENCY && queue.length > 0) {
    const addr = queue.shift()!;
    running++;
    void check(addr).finally(() => {
      running--;
      queued.delete(addr);
      pump();
    });
  }
}

async function check(addr: string): Promise<void> {
  const entry = entries.get(addr);
  if (!entry || !needsCheck(entry)) return;
  const { event } = entry;
  let details: NsiteAppDetails | null;
  try {
    details = await deriveNsiteAppDetails(blossomFileSource(event), event.id);
  } catch {
    details = null;
  }

  // The site may have been updated or deleted while its files were read.
  const current = entries.get(addr);
  if (!current || current.event.id !== event.id) return;

  const listed = details !== null && isListedApp(details);
  const next: CatalogEntry = {
    addr,
    event,
    check: { id: event.id, version: NSITE_APP_INFO_VERSION, at: Date.now(), listed },
    listed: listed && details ? { event, details } : undefined,
  };
  setEntry(next);
  void persist({ put: [next] });
  notify();
}
