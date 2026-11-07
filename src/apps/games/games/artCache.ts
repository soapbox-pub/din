/**
 * Games' pictures from libretro-thumbnails, kept in the app's own IndexedDB.
 *
 * The server's PNGs are full-size scans (a box is often 300 KB and a
 * thousand pixels tall) for tiles a fifth of that, and it sends no CORS
 * headers, so the page can't read them. They're fetched once with din.fetch,
 * shrunk to what a tile or a backdrop shows and kept as WebP; after that a
 * picture costs a read from disk, with no network at all. A picture the
 * server doesn't have is remembered for a week, so it isn't asked for again
 * on every scroll.
 *
 * Fetches go a few at a time, the newest first: what's on screen now comes
 * before what was scrolled past. A picture nobody wants any more by its turn
 * isn't fetched.
 */
import { useEffect, useState } from 'react';
import { useDin } from '@/sdk/react';

type Fetch = (url: string) => Promise<Response>;

const DB_NAME = 'games-art';
const STORE = 'art';
/** Fetches at once (napp-fetch allows 8 per window). */
const CONCURRENCY = 6;
/** How long a picture the server lacks stays lacking. */
const MISS_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
/** A blob URL nobody shows is let go after this long. */
const RELEASE_DELAY = 30_000;

/** What the cache holds for a URL: the picture, or null where the server had none. */
interface Stored {
  blob: Blob | null;
  at: number;
}

/** Whether a URL is one of libretro-thumbnails', which the page can only see through the cache. */
function isRemote(url: string): boolean {
  return url.startsWith('https://');
}

/** The longest side each kind of picture is kept at: box art for tiles, screens for backdrops. */
function maxSide(url: string): number {
  return url.includes('/Named_Boxarts/') ? 512 : 640;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function read(url: string): Promise<Stored | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const request = d.transaction(STORE, 'readonly').objectStore(STORE).get(url);
    request.onsuccess = () => resolve(request.result as Stored | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function write(url: string, stored: Stored): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(stored, url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Fetching and shrinking
// ---------------------------------------------------------------------------

/** A picture as kept: no bigger than `side` on its longest side, as WebP. */
async function shrink(blob: Blob, side: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } finally {
    bitmap.close();
  }
}

/** The picture from the server, shrunk; null where it has none; throws when it can't be asked (offline). */
async function download(url: string, fetcher: Fetch): Promise<Blob | null> {
  const response = await fetcher(url);
  if (response.status === 404 || response.status === 410) {
    void response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`${response.status} ${response.statusText}`);
  }
  try {
    return await shrink(await response.blob(), maxSide(url));
  } catch {
    // Not a picture the browser can decode: as good as none.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const queue: (() => Promise<void>)[] = [];
let running = 0;

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    // The newest first: what was asked for last is what's on screen.
    const task = queue.pop()!;
    running++;
    void task().finally(() => {
      running--;
      pump();
    });
  }
}

// ---------------------------------------------------------------------------
// Entries: one per URL, shared by everything showing it
// ---------------------------------------------------------------------------

interface Entry {
  /** The blob URL to show, or null where there's no picture; undefined while looking. */
  src: string | null | undefined;
  refs: number;
  listeners: Set<(src: string | null) => void>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** A fetch is waiting its turn or under way. */
  loading: boolean;
}

const entries = new Map<string, Entry>();

function settle(url: string, entry: Entry, blob: Blob | null): void {
  entry.src = blob ? URL.createObjectURL(blob) : null;
  for (const listener of entry.listeners) listener(entry.src);
  if (entry.refs === 0) scheduleRelease(url, entry);
}

function scheduleRelease(url: string, entry: Entry): void {
  if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  entry.releaseTimer = setTimeout(() => {
    if (entry.refs > 0 || entry.loading) return;
    if (entry.src) URL.revokeObjectURL(entry.src);
    entries.delete(url);
  }, RELEASE_DELAY);
}

async function load(url: string, entry: Entry, fetcher: Fetch): Promise<void> {
  entry.loading = true;
  let stored: Stored | undefined;
  try {
    stored = await read(url);
  } catch {
    stored = undefined;
  }
  if (stored && (stored.blob || Date.now() - stored.at < MISS_MAX_AGE)) {
    entry.loading = false;
    settle(url, entry, stored.blob);
    return;
  }
  queue.push(async () => {
    // Scrolled past before its turn: left for when it's shown again.
    if (entry.refs === 0) {
      entry.loading = false;
      entry.src = undefined;
      scheduleRelease(url, entry);
      return;
    }
    try {
      const blob = await download(url, fetcher);
      void write(url, { blob, at: Date.now() }).catch(() => {});
      entry.loading = false;
      settle(url, entry, blob);
    } catch {
      // Offline, or the server failing: nothing kept, so it's asked again next time.
      entry.loading = false;
      settle(url, entry, null);
      entries.delete(url);
    }
  });
  pump();
}

function acquire(url: string, fetcher: Fetch, listener: (src: string | null) => void): () => void {
  let entry = entries.get(url);
  if (!entry) {
    entry = { src: undefined, refs: 0, listeners: new Set(), releaseTimer: null, loading: false };
    entries.set(url, entry);
  }
  const e = entry;
  e.refs++;
  e.listeners.add(listener);
  if (e.releaseTimer) {
    clearTimeout(e.releaseTimer);
    e.releaseTimer = null;
  }
  if (e.src !== undefined) queueMicrotask(() => e.listeners.has(listener) && listener(e.src as string | null));
  else if (!e.loading) void load(url, e, fetcher);
  return () => {
    e.refs--;
    e.listeners.delete(listener);
    if (e.refs === 0) scheduleRelease(url, e);
  };
}

/**
 * A picture to show for `url`: a blob URL from the cache once it's in hand,
 * undefined while it's being looked up, null where there's none. URLs that
 * aren't libretro's (a resume image) come back as they are. Nothing is
 * looked up until `enabled` (the picture is near the screen).
 */
export function useCachedArt(url: string | null | undefined, enabled = true): string | null | undefined {
  const din = useDin();
  const remote = !!url && isRemote(url);
  const [state, setState] = useState<{ url: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!url || !remote || !enabled) return;
    return acquire(url, (u) => din.fetch(u), (src) => setState({ url, src }));
  }, [din, url, remote, enabled]);
  if (!url) return null;
  if (!remote) return url;
  return state?.url === url ? state.src : (entries.get(url)?.src ?? undefined);
}
