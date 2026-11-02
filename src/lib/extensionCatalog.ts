import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';

/**
 * Browser extensions on Nostr, as NIP-82 software (NIP.md): an application
 * (kind 32267), its releases (kind 30063, one per version), and each
 * release's assets (kind 3063), of which an extension's is a .crx
 * (`application/x-chrome-extension`).
 *
 * All three carry the platform `["f", "chromium"]` (a Chromium-based
 * browser, which is what runs a .crx; Din's addition to NIP-82's platform
 * identifiers), so relays hand over only extensions with `#f`.
 * about:extensions keeps what its authors (Din's publishers, the people the
 * user follows, and the user) publish that way in IndexedDB, plus the
 * deletions that cover it. It opens on what's on disk, then syncs in the
 * background: each author is asked for everything once, then only for
 * what's newer than when they were last synced. What arrives is merged in,
 * never swapped for the whole: the newest app and release per address win,
 * and a deletion removes what it covers and keeps out anything older that
 * arrives later.
 *
 * An app is listed when it has the platform; its newest release on the
 * `main` channel (by `created_at`, which NIP-82 makes the release date) with
 * a .crx asset on disk is what Get installs, and is fetched when it's opened
 * or got if none is on disk yet.
 */

export const APP_KIND = 32267;
export const RELEASE_KIND = 30063;
export const ASSET_KIND = 3063;
export const CRX_MIME = 'application/x-chrome-extension';

/** The NIP-82 platform (`f`) of what a Chromium-based browser runs: Chrome extensions. */
export const CHROMIUM_PLATFORM = 'chromium';

const DELETION_KIND = 5;
const SHA256 = /^[0-9a-f]{64}$/;
/** Overlap kept below each author's cursor, for publishers whose clocks run behind. */
const CURSOR_SLOP = 10 * 60;
/** Events asked for per relay page. */
const PAGE = 500;
/** How far back one sync pages before it stops. */
const MAX_PAGES = 40;

/** A published browser extension: its app, and its latest release with a .crx, when known. */
export interface ExtensionPackage {
  type: 'extension';
  /** The app event (kind 32267). */
  event: NostrEvent;
  pubkey: string;
  /** The app's `d`. */
  identifier: string;
  title: string;
  summary: string;
  /** The full description, from the app's content. */
  description: string;
  inherits: string[];
  /** Blossom servers its .crx is on, from its URLs. */
  servers: string[];
  /** The .crx's size. */
  size: number;
  /** When its latest release came out, else when the app was published. */
  createdAt: number;
  image: string | null;
  license: string;
  repository: string | null;
  website: string | null;
  version: string;
  permissions: string[];
  hosts: string[];
  minimumChrome: string | null;
  release: { id: string; identifier: string; createdAt: number } | null;
  asset: { id: string; sha256: string; size: number; urls: string[] } | null;
}

interface ReleaseRecord {
  /** `pubkey:d`. */
  key: string;
  id: string;
  pubkey: string;
  /** The app's `d` (its `i`). */
  app: string;
  identifier: string;
  version: string;
  channel: string;
  createdAt: number;
  assets: string[];
}

interface AssetRecord {
  id: string;
  pubkey: string;
  sha256: string;
  size: number;
  urls: string[];
  version: string;
  minimumChrome: string | null;
  permissions: string[];
  hosts: string[];
}

/** A deletion on disk: an address (`a:<kind>:<pubkey>:<d>`) deleted up to `at`, or an event (`e:<id>`) by `pubkey`. */
type DeletionRecord = { key: string; at?: number; pubkey?: string };

const apps = new Map<string, NostrEvent>();
const releases = new Map<string, ReleaseRecord>();
const assets = new Map<string, AssetRecord>();
const deletedAddrs = new Map<string, number>();
const deletedIds = new Map<string, string>();
/** Each author's last sync, by pubkey. */
let cursors: Record<string, number> = {};

let version = 0;
let loaded = false;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribeExtensionCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getExtensionCatalogVersion(): number {
  return version;
}

export function isExtensionCatalogLoaded(): boolean {
  return loaded;
}

let activeSyncs = 0;
let lastSyncFailed = false;

/** Whether a sync is asking relays now, and whether the last one failed. */
export function extensionCatalogSync(): { syncing: boolean; failed: boolean } {
  return { syncing: activeSyncs > 0, failed: lastSyncFailed };
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('din-extension-catalog', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('apps', { keyPath: 'key' });
      db.createObjectStore('releases', { keyPath: 'key' });
      db.createObjectStore('assets', { keyPath: 'id' });
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
  apps: { put: Map<string, NostrEvent>; remove: Set<string> };
  releases: { put: Map<string, ReleaseRecord>; remove: Set<string> };
  assets: { put: Map<string, AssetRecord>; remove: Set<string> };
  deletions: DeletionRecord[];
}

function noChanges(): Changes {
  return {
    apps: { put: new Map(), remove: new Set() },
    releases: { put: new Map(), remove: new Set() },
    assets: { put: new Map(), remove: new Set() },
    deletions: [],
  };
}

function changed(c: Changes): boolean {
  return !!(c.apps.put.size || c.apps.remove.size || c.releases.put.size || c.releases.remove.size
    || c.assets.put.size || c.assets.remove.size || c.deletions.length);
}

/** Write changes in one transaction. A failed write only costs the next start. */
async function persist(changes: Changes | null, meta?: Record<string, unknown>): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(['apps', 'releases', 'assets', 'deletions', 'meta'], 'readwrite');
    if (changes) {
      for (const [key, event] of changes.apps.put) tx.objectStore('apps').put({ key, event });
      for (const key of changes.apps.remove) tx.objectStore('apps').delete(key);
      for (const record of changes.releases.put.values()) tx.objectStore('releases').put(record);
      for (const key of changes.releases.remove) tx.objectStore('releases').delete(key);
      for (const record of changes.assets.put.values()) tx.objectStore('assets').put(record);
      for (const id of changes.assets.remove) tx.objectStore('assets').delete(id);
      for (const record of changes.deletions) tx.objectStore('deletions').put(record);
    }
    for (const [key, value] of Object.entries(meta ?? {})) tx.objectStore('meta').put(value, key);
  } catch (error) {
    console.warn('Failed to save the extension catalog:', error);
  }
}

let loading: Promise<void> | undefined;

/** Read the catalog off disk, once. Everything that changes it waits for this. */
export function loadExtensionCatalog(): Promise<void> {
  loading ??= (async () => {
    try {
      const db = await openDb();
      const [storedApps, storedReleases, storedAssets, deletions, storedCursors] = await Promise.all([
        getAll<{ key: string; event: NostrEvent }>(db, 'apps'),
        getAll<ReleaseRecord>(db, 'releases'),
        getAll<AssetRecord>(db, 'assets'),
        getAll<DeletionRecord>(db, 'deletions'),
        getMeta<Record<string, number>>(db, 'cursors'),
      ]);
      for (const { key, event } of storedApps) apps.set(key, event);
      for (const record of storedReleases) releases.set(record.key, record);
      for (const record of storedAssets) assets.set(record.id, record);
      for (const record of deletions) {
        if (record.at !== undefined) deletedAddrs.set(record.key.slice(2), record.at);
        if (record.pubkey !== undefined) deletedIds.set(record.key.slice(2), record.pubkey);
      }
      cursors = storedCursors ?? {};
    } catch (error) {
      console.warn('Failed to load the extension catalog:', error);
    }
    loaded = true;
    notify();
  })();
  return loading;
}

// ---------------------------------------------------------------------------
// Taking events in
// ---------------------------------------------------------------------------

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(([n]) => n === name)?.[1];
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter(([n, v]) => n === name && v).map(([, v]) => v);
}

function size(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function httpsUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  }))];
}

function isDeleted(kind: number, event: NostrEvent, d: string): boolean {
  return (deletedAddrs.get(`${kind}:${event.pubkey}:${d}`) ?? -1) >= event.created_at || deletedIds.get(event.id) === event.pubkey;
}

function parseRelease(event: NostrEvent): ReleaseRecord | null {
  const identifier = tagValue(event, 'd');
  const app = tagValue(event, 'i');
  if (!identifier || !app) return null;
  return {
    key: `${event.pubkey}:${identifier}`,
    id: event.id,
    pubkey: event.pubkey,
    app,
    identifier,
    version: tagValue(event, 'version')?.trim() ?? identifier.slice(app.length + 1),
    channel: tagValue(event, 'c') ?? 'main',
    createdAt: event.created_at,
    assets: tagValues(event, 'e'),
  };
}

function parseAsset(event: NostrEvent): AssetRecord | null {
  const sha256 = tagValue(event, 'x');
  if (tagValue(event, 'm') !== CRX_MIME || !sha256 || !SHA256.test(sha256)) return null;
  return {
    id: event.id,
    pubkey: event.pubkey,
    sha256,
    size: size(tagValue(event, 'size')),
    urls: httpsUrls(tagValues(event, 'url')),
    version: tagValue(event, 'version')?.trim() ?? '',
    minimumChrome: tagValue(event, 'min_platform_version')?.trim() || null,
    permissions: tagValues(event, 'permission'),
    hosts: tagValues(event, 'host'),
  };
}

/**
 * Take in NIP-82 events and deletions by `authors`. Addressable events and
 * assets only count by their own author, who is the only trust boundary, and
 * a deletion only covers its own author's events (NIP-09).
 */
function ingest(events: NostrEvent[], authors: ReadonlySet<string>): Changes {
  const c = noChanges();

  for (const event of events) {
    if (event.kind !== DELETION_KIND || !authors.has(event.pubkey)) continue;
    for (const [name, value] of event.tags) {
      if (name === 'a' && value) {
        const [kind, pubkey, ...rest] = value.split(':');
        if (pubkey !== event.pubkey || (kind !== String(APP_KIND) && kind !== String(RELEASE_KIND))) continue;
        const addr = `${kind}:${pubkey}:${rest.join(':')}`;
        if ((deletedAddrs.get(addr) ?? -1) >= event.created_at) continue;
        deletedAddrs.set(addr, event.created_at);
        c.deletions.push({ key: `a:${addr}`, at: event.created_at });
        const key = `${pubkey}:${rest.join(':')}`;
        if (kind === String(APP_KIND)) {
          const app = apps.get(key);
          if (app && app.created_at <= event.created_at) {
            apps.delete(key);
            c.apps.put.delete(key);
            c.apps.remove.add(key);
          }
        } else {
          const release = releases.get(key);
          if (release && release.createdAt <= event.created_at) {
            releases.delete(key);
            c.releases.put.delete(key);
            c.releases.remove.add(key);
          }
        }
      } else if (name === 'e' && value && !deletedIds.has(value)) {
        deletedIds.set(value, event.pubkey);
        c.deletions.push({ key: `e:${value}`, pubkey: event.pubkey });
        const asset = assets.get(value);
        if (asset?.pubkey === event.pubkey) {
          assets.delete(value);
          c.assets.put.delete(value);
          c.assets.remove.add(value);
        }
        for (const [key, app] of apps) {
          if (app.id !== value || app.pubkey !== event.pubkey) continue;
          apps.delete(key);
          c.apps.put.delete(key);
          c.apps.remove.add(key);
        }
        for (const [key, release] of releases) {
          if (release.id !== value || release.pubkey !== event.pubkey) continue;
          releases.delete(key);
          c.releases.put.delete(key);
          c.releases.remove.add(key);
        }
      }
    }
  }

  for (const event of events) {
    if (!authors.has(event.pubkey)) continue;
    if (event.kind === APP_KIND) {
      const d = tagValue(event, 'd');
      if (!d || isDeleted(APP_KIND, event, d)) continue;
      const key = `${event.pubkey}:${d}`;
      const existing = apps.get(key);
      if (existing && existing.created_at >= event.created_at) continue;
      apps.set(key, event);
      c.apps.put.set(key, event);
      c.apps.remove.delete(key);
    } else if (event.kind === RELEASE_KIND) {
      const release = parseRelease(event);
      if (!release || isDeleted(RELEASE_KIND, event, release.identifier)) continue;
      const existing = releases.get(release.key);
      if (existing && existing.createdAt >= release.createdAt) continue;
      releases.set(release.key, release);
      c.releases.put.set(release.key, release);
      c.releases.remove.delete(release.key);
    } else if (event.kind === ASSET_KIND) {
      if (assets.has(event.id) || deletedIds.get(event.id) === event.pubkey) continue;
      const asset = parseAsset(event);
      if (!asset) continue;
      assets.set(asset.id, asset);
      c.assets.put.set(asset.id, asset);
    }
  }

  if (changed(c)) {
    void persist(c);
    notify();
  }
  return c;
}

/** Take in events this computer published itself (Publish to Nostr…), so they show at once. */
export function ingestPublished(events: NostrEvent[]): void {
  void loadExtensionCatalog().then(() => ingest(events, new Set(events.map((e) => e.pubkey))));
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

export type CatalogQuery = (filters: NostrFilter[], signal?: AbortSignal) => Promise<NostrEvent[]>;

function catalogFilters(authors: string[]): NostrFilter[] {
  return [
    { kinds: [APP_KIND, RELEASE_KIND, ASSET_KIND], authors, '#f': [CHROMIUM_PLATFORM] },
    { kinds: [DELETION_KIND], authors, '#k': [String(APP_KIND), String(RELEASE_KIND), String(ASSET_KIND)] },
  ];
}

/** Everything one filter matches since `since`, a relay page at a time, going back. */
async function pageThrough(query: CatalogQuery, filter: NostrFilter, authors: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
  let until: number | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = (await query([{ ...filter, limit: PAGE, ...(until === undefined ? {} : { until }) }], signal))
      .filter((event) => !seen.has(event.id));
    if (!events.length) return;
    for (const event of events) seen.add(event.id);
    ingest(events, authors);
    const oldest = Math.min(...events.map((event) => event.created_at));
    if (filter.since !== undefined && oldest <= filter.since) return;
    until = oldest - 1;
  }
}

const syncing = new Map<string, Promise<void>>();

/**
 * Bring the catalog up to date for `authors`: everything from those never
 * synced, and what's newer than their cursor from the rest. One at a time
 * per set of authors.
 */
export function syncExtensionCatalog(query: CatalogQuery, authors: string[], signal?: AbortSignal): Promise<void> {
  const key = [...authors].sort().join(',');
  const running = syncing.get(key);
  if (running) return running;
  activeSyncs++;
  notify();
  const run = (async () => {
    await loadExtensionCatalog();
    const started = Math.floor(Date.now() / 1000);
    const allowed = new Set(authors);
    const fresh = authors.filter((pubkey) => cursors[pubkey] === undefined);
    const known = authors.filter((pubkey) => cursors[pubkey] !== undefined);
    const jobs: Promise<void>[] = [];
    if (fresh.length) for (const filter of catalogFilters(fresh)) jobs.push(pageThrough(query, filter, allowed, signal));
    if (known.length) {
      const since = Math.min(...known.map((pubkey) => cursors[pubkey])) - CURSOR_SLOP;
      for (const filter of catalogFilters(known)) jobs.push(pageThrough(query, { ...filter, since }, allowed, signal));
    }
    await Promise.all(jobs);
    cursors = { ...cursors, ...Object.fromEntries(authors.map((pubkey) => [pubkey, started])) };
    void persist(null, { cursors });
    lastSyncFailed = false;
  })()
    .catch((error: unknown) => {
      lastSyncFailed = true;
      throw error;
    })
    .finally(() => {
      syncing.delete(key);
      activeSyncs--;
      notify();
    });
  syncing.set(key, run);
  return run;
}

/** One app, its newest releases and their .crx assets, from relays into the catalog; resolves with it. */
export async function fetchExtension(
  address: { pubkey: string; identifier: string },
  query: CatalogQuery,
  signal?: AbortSignal,
): Promise<ExtensionPackage | null> {
  await loadExtensionCatalog();
  const { pubkey, identifier } = address;
  const author = new Set([pubkey]);
  ingest(await query([
    { kinds: [APP_KIND], authors: [pubkey], '#d': [identifier] },
    { kinds: [RELEASE_KIND], authors: [pubkey], '#i': [identifier], limit: 5 },
    { kinds: [DELETION_KIND], authors: [pubkey], '#a': [`${APP_KIND}:${pubkey}:${identifier}`] },
  ], signal), author);
  const ids = [...releases.values()]
    .filter((r) => r.pubkey === pubkey && r.app === identifier)
    .flatMap((r) => r.assets)
    .filter((id) => !assets.has(id));
  if (ids.length) ingest(await query([{ kinds: [ASSET_KIND], authors: [pubkey], ids, '#m': [CRX_MIME] }], signal), author);
  return storedExtension(pubkey, identifier);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function originOf(url: string): string | null {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return null;
  }
}

function build(app: NostrEvent): ExtensionPackage | null {
  const identifier = tagValue(app, 'd');
  if (!identifier) return null;
  let release: ReleaseRecord | undefined;
  let asset: AssetRecord | undefined;
  const candidates = [...releases.values()]
    .filter((r) => r.pubkey === app.pubkey && r.app === identifier && r.channel === 'main')
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const candidate of candidates) {
    const found = candidate.assets.map((id) => assets.get(id)).find((a) => a?.pubkey === app.pubkey);
    if (found) {
      release = candidate;
      asset = found;
      break;
    }
  }
  if (!tagValues(app, 'f').includes(CHROMIUM_PLATFORM)) return null;

  const icon = tagValue(app, 'icon');
  const content = app.content.trim();
  return {
    type: 'extension',
    event: app,
    pubkey: app.pubkey,
    identifier,
    title: tagValue(app, 'name')?.trim() || identifier,
    summary: tagValue(app, 'summary')?.trim() || content.split('\n')[0] || '',
    description: content,
    inherits: [],
    servers: [...new Set((asset?.urls ?? []).map(originOf).filter((s): s is string => !!s))],
    size: asset?.size ?? 0,
    createdAt: release?.createdAt ?? app.created_at,
    image: icon ? sanitizeImageUrl(icon) ?? null : null,
    license: tagValue(app, 'license') ?? '',
    repository: httpsUrls(tagValues(app, 'repository'))[0] ?? null,
    website: httpsUrls(tagValues(app, 'url'))[0] ?? null,
    version: release?.version || asset?.version || '',
    permissions: asset?.permissions ?? [],
    hosts: asset?.hosts ?? [],
    minimumChrome: asset?.minimumChrome ?? null,
    release: release ? { id: release.id, identifier: release.identifier, createdAt: release.createdAt } : null,
    asset: asset ? { id: asset.id, sha256: asset.sha256, size: asset.size, urls: asset.urls } : null,
  };
}

/** One extension on disk by its app's address, or null. */
export function storedExtension(pubkey: string, identifier: string): ExtensionPackage | null {
  const app = apps.get(`${pubkey}:${identifier}`);
  return app ? build(app) : null;
}

/** Whether the app at an address is an extension Din knows of. */
export function isKnownExtension(pubkey: string, identifier: string): boolean {
  return storedExtension(pubkey, identifier) !== null;
}

/** The extensions on disk by `authors`, the most recently released first. */
export function extensionCatalog(authors: readonly string[]): ExtensionPackage[] {
  const allowed = new Set(authors);
  return [...apps.values()]
    .filter((app) => allowed.has(app.pubkey))
    .map(build)
    .filter((pkg): pkg is ExtensionPackage => pkg !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** The release ids and asset id of an extension, for deleting it from Nostr along with its app. */
export function extensionReleases(pubkey: string, identifier: string): { identifier: string; id: string; assets: string[] }[] {
  return [...releases.values()]
    .filter((r) => r.pubkey === pubkey && r.app === identifier)
    .map((r) => ({ identifier: r.identifier, id: r.id, assets: r.assets }));
}
