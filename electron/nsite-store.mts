// The OS-level nsite store: every NIP-5A site Din has opened or installed,
// kept on disk as its signed manifest, plus the content-addressed blobs those
// manifests name. Ported from Tenna's NsiteSites / NsiteFileServer.
//
//   userData/nsite/sites/<sha256(host)>.json   one record per canonical host
//   userData/nsite-blobs/<hh>/<sha256>          verified blobs, shared by all sites
//
// A record holds the raw signed manifest event (kind 15128 or 35128), never a
// digest of it: this process checks the signature itself before anything is
// written, so a stored record can be served without asking the shell renderer
// again - offline, at boot, before any relay has answered. A record only ever
// moves forward: a manifest older than the stored one is ignored, so a relay
// can't roll a site back.
//
// Installed sites are kept for good, along with every blob their manifest
// names. Everything else is a cache: visited sites' records expire after a
// month unused, and their blobs share an LRU budget. An installed site updates
// atomically - a newer manifest is only adopted once every blob it names is on
// disk, so an app never runs half an update - and the manifest it replaced is
// kept as `previous`, so a page still running the old version can finish
// loading its old chunks.

import { app, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';

export type { NostrEvent };

/** Replaceable event kind for a pubkey's root site (NIP-5A). */
export const NSITE_ROOT_KIND = 15128;
/** Addressable event kind for a named site under a pubkey (NIP-5A). */
export const NSITE_NAMED_KIND = 35128;
/** BUD-03 Blossom server list. */
const SERVER_LIST_KIND = 10063;

/** A site as the protocol handler serves it. */
export interface NsiteSite {
  /** Canonical host this manifest serves (`npub1…` or `<pubkeyB36><dtag>`). */
  host: string;
  /** 64-char lowercase hex pubkey of the site's author. */
  pubkey: string;
  /** The `d` tag for a named site, or null for a root site. */
  dtag: string | null;
  /** Absolute path -> sha256 hex, from the manifest's `path` tags. */
  paths: Record<string, string>;
  /**
   * The paths of the manifest an installed site was updated from, so a page
   * loaded before the update can still fetch the files it was built with.
   */
  previousPaths: Record<string, string> | null;
  /** Blossom servers to try, most trusted first. */
  servers: string[];
  /** The manifest's `title` tag, if any. */
  title: string | null;
  /** The manifest event's `created_at`. */
  updatedAt: number;
  /** The manifest event's id. */
  eventId: string;
}

/** The signed events a site resolves to, as the shell renderer found them. */
export interface NsiteEvents {
  manifest: NostrEvent;
  /** The author's BUD-03 server list, if they publish one. */
  serverList: NostrEvent | null;
  /** Din's own Blossom servers, tried after the author's. */
  servers: string[];
}

/**
 * How an installed (or visited) site presents itself as an app, derived by the
 * shell renderer from the site's own files (see src/lib/nsiteAppInfo.ts) and
 * stored here so the launcher can draw it without reading them again.
 */
export interface NsiteAppInfo {
  /** The manifest event id this was derived from. */
  from: string;
  /** Which derivation produced it, so a newer Din can redo an older one's. */
  version?: number;
  name: string | null;
  /** A small raster data URL (`data:image/webp` or `data:image/png`). */
  icon: string | null;
  /** `#rrggbb`. */
  themeColor: string | null;
}

interface SiteRecord {
  host: string;
  manifest: NostrEvent;
  previous: NostrEvent | null;
  serverList: NostrEvent | null;
  fallbackServers: string[];
  installed: boolean;
  /** Unix ms. */
  installedAt: number | null;
  /** Unix ms. */
  lastUsed: number;
  app: NsiteAppInfo | null;
}

/** What the shell sees of a stored site. */
export interface NsiteSummary {
  host: string;
  eventId: string;
  title: string | null;
  updatedAt: number;
  installed: boolean;
  installedAt: number | null;
  app: NsiteAppInfo | null;
  /** Path -> sha256 of the current manifest. */
  paths: Record<string, string>;
}

/** Visited (not installed) sites unused this long are forgotten. */
const VISITED_TTL_MS = 30 * 24 * 60 * 60_000;

/** `lastUsed` is only rewritten when it is at least this stale. */
const TOUCH_INTERVAL_MS = 60 * 60_000;

/** How long a private window's lookup is reused. These never touch disk. */
const EPHEMERAL_TTL_MS = 5 * 60_000;

/** How long a single Blossom server gets before we move to the next. */
const BLOB_TIMEOUT_MS = 30_000;

/** Disk budget for blobs no installed site needs. */
const CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

/** Bytes written since the last trim; trigger a sweep past this. */
const CACHE_TRIM_INTERVAL_BYTES = 32 * 1024 * 1024;

/** Blobs fetched at once while installing or updating a site. */
const DOWNLOAD_CONCURRENCY = 4;

/** Largest stored app icon (a 256px webp is ~20 KB). */
const MAX_ICON_LENGTH = 256 * 1024;

const HASH_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Canonical hosts (the same grammar as src/lib/nsite.ts)
// ---------------------------------------------------------------------------

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const B36_PUBKEY_LENGTH = 50;
const DTAG_RE = /^[a-z0-9-]{1,63}$/;

function isValidDtag(dtag: string): boolean {
  return DTAG_RE.test(dtag) && !dtag.endsWith('-');
}

function pubkeyToBase36(pubkey: string): string {
  let value = BigInt(`0x${pubkey}`);
  let out = '';
  while (value > 0n) {
    out = B36[Number(value % 36n)] + out;
    value /= 36n;
  }
  return out.padStart(B36_PUBKEY_LENGTH, '0');
}

function base36ToPubkey(label: string): string | null {
  if (label.length !== B36_PUBKEY_LENGTH) return null;
  let value = 0n;
  for (const char of label) {
    const digit = B36.indexOf(char);
    if (digit < 0) return null;
    value = value * 36n + BigInt(digit);
  }
  if (value >= 1n << 256n) return null;
  return value.toString(16).padStart(64, '0');
}

/** The canonical host for a site, or null for a `d` tag no host can carry. */
export function canonicalHostFor(pubkey: string, dtag: string | null): string | null {
  if (!HASH_RE.test(pubkey)) return null;
  if (dtag === null) return nip19.npubEncode(pubkey);
  return isValidDtag(dtag) ? `${pubkeyToBase36(pubkey)}${dtag}` : null;
}

/** Parse a canonical host (`npub1…` or `<pubkeyB36><dtag>`), or null. */
export function parseCanonicalHost(host: string): { pubkey: string; dtag: string | null } | null {
  if (typeof host !== 'string' || host !== host.toLowerCase()) return null;
  if (host.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type === 'npub') return { pubkey: decoded.data, dtag: null };
    } catch {
      // Fall through to the named-site shape.
    }
  }
  if (host.length <= B36_PUBKEY_LENGTH) return null;
  const dtag = host.slice(B36_PUBKEY_LENGTH);
  if (!isValidDtag(dtag)) return null;
  const pubkey = base36ToPubkey(host.slice(0, B36_PUBKEY_LENGTH));
  return pubkey ? { pubkey, dtag } : null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find(([tagName]) => tagName === name);
  return typeof tag?.[1] === 'string' ? tag[1] : null;
}

/** Whether a value has the shape of a Nostr event (before verifying it). */
function isEventShaped(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    typeof event.pubkey === 'string' &&
    typeof event.sig === 'string' &&
    typeof event.kind === 'number' &&
    typeof event.created_at === 'number' &&
    typeof event.content === 'string' &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === 'string'))
  );
}

/** A manifest's canonical host, or null if it isn't a servable, signed manifest. */
function manifestHost(event: unknown): string | null {
  if (!isEventShaped(event)) return null;
  let dtag: string | null;
  if (event.kind === NSITE_ROOT_KIND) dtag = null;
  else if (event.kind === NSITE_NAMED_KIND) dtag = tagValue(event, 'd');
  else return null;
  if (event.kind === NSITE_NAMED_KIND && !dtag) return null;
  const host = canonicalHostFor(event.pubkey, dtag);
  if (!host) return null;
  // Copy before verifying: nostr-tools caches the verdict on the object, and
  // this one came over IPC.
  return verifyEvent({ ...event }) ? host : null;
}

function isServerListFor(event: unknown, pubkey: string): event is NostrEvent {
  return (
    isEventShaped(event) &&
    event.kind === SERVER_LIST_KIND &&
    event.pubkey === pubkey &&
    verifyEvent({ ...event })
  );
}

function collectPaths(event: NostrEvent): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [name, filePath, hash] of event.tags) {
    if (name !== 'path') continue;
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) continue;
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) continue;
    paths[filePath] = hash;
  }
  return paths;
}

/** https server URLs only, deduplicated, in order. */
function normalizeServers(urls: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    try {
      const url = new URL(raw);
      // https only: the list comes from the site author, and these fetches
      // run from the main process - a plain-http "server" would let any site
      // aim requests at the user's LAN or localhost.
      if (url.protocol !== 'https:') continue;
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // Not a URL.
    }
  }
  return out;
}

function serversOf(manifest: NostrEvent, serverList: NostrEvent | null, fallback: string[]): string[] {
  const tagged = (event: NostrEvent | null) =>
    event?.tags.filter(([name]) => name === 'server').map(([, url]) => url) ?? [];
  // NIP-5A: the manifest's own hints first, then the author's server list,
  // then Din's defaults. Any of them can serve any blob - the hash from the
  // signed manifest is what makes the order safe.
  return normalizeServers([...tagged(manifest), ...tagged(serverList), ...fallback]);
}

function siteOf(
  host: string,
  manifest: NostrEvent,
  previous: NostrEvent | null,
  serverList: NostrEvent | null,
  fallback: string[],
): NsiteSite {
  return {
    host,
    pubkey: manifest.pubkey,
    dtag: manifest.kind === NSITE_NAMED_KIND ? tagValue(manifest, 'd') : null,
    paths: collectPaths(manifest),
    previousPaths: previous ? collectPaths(previous) : null,
    servers: serversOf(manifest, serverList, fallback),
    title: tagValue(manifest, 'title'),
    updatedAt: manifest.created_at,
    eventId: manifest.id,
  };
}

function recordSite(record: SiteRecord): NsiteSite {
  return siteOf(record.host, record.manifest, record.previous, record.serverList, record.fallbackServers);
}

function summaryOf(record: SiteRecord): NsiteSummary {
  return {
    host: record.host,
    eventId: record.manifest.id,
    title: tagValue(record.manifest, 'title'),
    updatedAt: record.manifest.created_at,
    installed: record.installed,
    installedAt: record.installedAt,
    app: record.app,
    paths: collectPaths(record.manifest),
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

let sitesDir = '';
let blobDir = '';
const records = new Map<string, SiteRecord>();
/** Private windows' lookups: in memory only, never on disk. */
const ephemeral = new Map<string, { site: NsiteSite; at: number }>();
/** When each host was last checked against relays, this run. */
const checkedAt = new Map<string, number>();
/** Updates to installed sites waiting on their blobs, by host. */
const staging = new Map<string, NostrEvent>();

let ready: Promise<void> = Promise.resolve();
let onChange: (host: string) => void = () => {};

function recordPath(host: string): string {
  return path.join(sitesDir, `${crypto.createHash('sha256').update(host).digest('hex')}.json`);
}

async function saveRecord(record: SiteRecord): Promise<void> {
  const target = recordPath(record.host);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(record));
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    console.warn('[nsite] could not save', record.host, error);
  }
}

async function deleteRecord(host: string): Promise<void> {
  records.delete(host);
  await fsp.unlink(recordPath(host)).catch(() => {});
}

/** Parse a stored record, re-checking everything about it. */
function parseRecord(raw: unknown): SiteRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const host = manifestHost(value.manifest);
  if (!host || host !== value.host) return null;
  const manifest = value.manifest as NostrEvent;
  const previous = manifestHost(value.previous) === host ? (value.previous as NostrEvent) : null;
  return {
    host,
    manifest,
    previous,
    serverList: isServerListFor(value.serverList, manifest.pubkey) ? value.serverList : null,
    fallbackServers: normalizeServers(Array.isArray(value.fallbackServers) ? value.fallbackServers : []),
    installed: value.installed === true,
    installedAt: typeof value.installedAt === 'number' ? value.installedAt : null,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : 0,
    app: parseAppInfo(value.app),
  };
}

function parseAppInfo(raw: unknown): NsiteAppInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.from !== 'string' || !HASH_RE.test(value.from)) return null;
  const name =
    typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim().slice(0, 64) || null : null;
  const icon =
    typeof value.icon === 'string' &&
    value.icon.length <= MAX_ICON_LENGTH &&
    /^data:image\/(?:webp|png);base64,[a-z0-9+/]+=*$/i.test(value.icon)
      ? value.icon
      : null;
  const themeColor =
    typeof value.themeColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.themeColor)
      ? value.themeColor.toLowerCase()
      : null;
  const version =
    typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : undefined;
  return { from: value.from, ...(version ? { version } : {}), name, icon, themeColor };
}

async function loadRecords(): Promise<void> {
  await fsp.mkdir(sitesDir, { recursive: true });
  const now = Date.now();
  for (const name of await fsp.readdir(sitesDir).catch(() => [])) {
    const file = path.join(sitesDir, name);
    if (name.endsWith('.tmp')) {
      await fsp.unlink(file).catch(() => {});
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let record: SiteRecord | null;
    try {
      record = parseRecord(JSON.parse(await fsp.readFile(file, 'utf8')));
    } catch {
      record = null;
    }
    if (!record || (!record.installed && now - record.lastUsed > VISITED_TTL_MS)) {
      await fsp.unlink(file).catch(() => {});
      continue;
    }
    records.set(record.host, record);
  }
}

/**
 * Open the store. Records load in the background; anything that reads them
 * waits for that first.
 */
export function initNsiteStore(options: { onChange: (host: string) => void }): void {
  onChange = options.onChange;
  sitesDir = path.join(app.getPath('userData'), 'nsite', 'sites');
  blobDir = path.join(app.getPath('userData'), 'nsite-blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  ready = loadRecords()
    .catch((error: unknown) => console.warn('[nsite] could not load the store', error))
    .then(() => {
      void trimCache();
      // Finish any update that was waiting on blobs when Din last quit.
      for (const record of records.values()) {
        if (record.installed) void ensureBlobs(record.host);
      }
    });
}

/** Resolves once stored records are loaded. */
export function nsiteStoreReady(): Promise<void> {
  return ready;
}

/**
 * The stored site for a host, if Din has one: the record on disk, or for a
 * private window a recent in-memory lookup.
 */
export function storedSite(host: string, persist: boolean): NsiteSite | null {
  const record = records.get(host);
  if (record) return recordSite(record);
  if (persist) return null;
  const entry = ephemeral.get(host);
  if (!entry) return null;
  if (Date.now() - entry.at > EPHEMERAL_TTL_MS) {
    ephemeral.delete(host);
    return null;
  }
  return entry.site;
}

/** Whether a host is due another look on relays. */
export function needsCheck(host: string, maxAgeMs: number): boolean {
  const at = checkedAt.get(host);
  return at === undefined || Date.now() - at > maxAgeMs;
}

/** Note that a stored site was used, for expiring visited ones. */
export function touchSite(host: string): void {
  const record = records.get(host);
  if (!record || Date.now() - record.lastUsed < TOUCH_INTERVAL_MS) return;
  record.lastUsed = Date.now();
  void saveRecord(record);
}

/**
 * Take a resolution from the shell renderer: verify it, and store it unless
 * it's older than what Din already has. Returns the site to serve now, which
 * for an installed site mid-update is still the version it's running.
 */
export function acceptSite(
  events: NsiteEvents,
  persist: boolean,
): { site: NsiteSite } | { error: string } {
  const host = manifestHost(events?.manifest);
  if (!host) return { error: 'The site manifest is not validly signed.' };
  const manifest = events.manifest;
  const serverList = isServerListFor(events.serverList, manifest.pubkey) ? events.serverList : null;
  const fallback = normalizeServers(Array.isArray(events.servers) ? events.servers.slice(0, 16) : []);
  checkedAt.set(host, Date.now());

  const record = records.get(host);

  if (!persist) {
    if (record && record.manifest.created_at >= manifest.created_at) return { site: recordSite(record) };
    const site = siteOf(host, manifest, null, serverList, fallback);
    ephemeral.set(host, { site, at: Date.now() });
    return { site };
  }

  if (!record) {
    const created: SiteRecord = {
      host,
      manifest,
      previous: null,
      serverList,
      fallbackServers: fallback,
      installed: false,
      installedAt: null,
      lastUsed: Date.now(),
      app: null,
    };
    records.set(host, created);
    void saveRecord(created);
    return { site: recordSite(created) };
  }

  // A newer server list or set of defaults can ride along with any answer.
  const newerList =
    serverList && (!record.serverList || serverList.created_at > record.serverList.created_at);
  const serversChanged = fallback.join('\n') !== record.fallbackServers.join('\n');
  if (newerList) record.serverList = serverList;
  if (serversChanged) record.fallbackServers = fallback;

  if (manifest.created_at <= record.manifest.created_at) {
    // The same version, or an older one a lagging relay still has.
    if (newerList || serversChanged) void saveRecord(record);
    return { site: recordSite(record) };
  }

  if (!record.installed) {
    record.manifest = manifest;
    void saveRecord(record);
    onChange(host);
    return { site: recordSite(record) };
  }

  if (newerList || serversChanged) void saveRecord(record);
  void stageUpdate(record, manifest);
  return { site: recordSite(record) };
}

/** Download a newer manifest's blobs, then switch an installed site to it. */
async function stageUpdate(record: SiteRecord, manifest: NostrEvent): Promise<void> {
  if (staging.get(record.host)?.id === manifest.id) return;
  staging.set(record.host, manifest);
  try {
    const servers = serversOf(manifest, record.serverList, record.fallbackServers);
    const { missing } = await downloadAll(collectPaths(manifest), servers);
    const current = records.get(record.host);
    if (missing > 0 || !current?.installed) return;
    if (manifest.created_at <= current.manifest.created_at) return;
    current.previous = current.manifest;
    current.manifest = manifest;
    await saveRecord(current);
    onChange(current.host);
  } finally {
    if (staging.get(record.host)?.id === manifest.id) staging.delete(record.host);
  }
}

/** Stored summaries of installed sites. */
export async function installedSites(): Promise<NsiteSummary[]> {
  await ready;
  return [...records.values()].filter((r) => r.installed).map(summaryOf);
}

/** The stored summary of any site, installed or visited. */
export async function siteSummary(host: string): Promise<NsiteSummary | null> {
  await ready;
  const record = records.get(host);
  return record ? summaryOf(record) : null;
}

/** Mark a stored site installed (keeping its blobs for good). */
export async function markInstalled(host: string): Promise<boolean> {
  await ready;
  const record = records.get(host);
  if (!record) return false;
  if (!record.installed) {
    record.installed = true;
    record.installedAt = Date.now();
    await saveRecord(record);
    onChange(host);
  }
  return true;
}

/** Uninstall a site: its record and blobs go back to being a cache. */
export async function markUninstalled(host: string): Promise<void> {
  await ready;
  const record = records.get(host);
  if (!record?.installed) return;
  record.installed = false;
  record.installedAt = null;
  record.previous = null;
  record.lastUsed = Date.now();
  staging.delete(host);
  await saveRecord(record);
  onChange(host);
}

/** Store how a site presents itself as an app. */
export async function setAppInfo(host: string, info: unknown): Promise<void> {
  await ready;
  const record = records.get(host);
  const parsed = parseAppInfo(info);
  if (!record || !parsed || parsed.from !== record.manifest.id) return;
  record.app = parsed;
  await saveRecord(record);
  onChange(host);
}

/**
 * Make sure every blob an installed site's manifest names is on disk.
 * Reports progress as it goes.
 */
export async function ensureBlobs(
  host: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; total: number; missing: number }> {
  await ready;
  const record = records.get(host);
  if (!record) return { done: 0, total: 0, missing: 0 };
  return downloadAll(collectPaths(record.manifest), recordSite(record).servers, onProgress);
}

async function downloadAll(
  paths: Record<string, string>,
  servers: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; total: number; missing: number }> {
  const hashes = [...new Set(Object.values(paths))];
  const total = hashes.length;
  let done = 0;
  let missing = 0;
  let next = 0;
  onProgress?.(0, total);

  const worker = async () => {
    while (next < hashes.length) {
      const hash = hashes[next++];
      const ok = (await cachedBlobSize(hash)) !== null || (await fetchBlobVerified(hash, servers)) !== null;
      if (!ok) missing++;
      done++;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, total) }, worker));
  return { done, total, missing };
}

/** Read one file of a stored site, fetching (and verifying) it if needed. */
export async function readSiteFile(host: string, filePath: string): Promise<Buffer | null> {
  await ready;
  const record = records.get(host);
  if (!record || typeof filePath !== 'string') return null;
  const hash = collectPaths(record.manifest)[filePath];
  if (!hash) return null;
  const file = cachePathFor(hash);
  const cached = await fsp.readFile(file).catch(() => null);
  if (cached) return cached;
  return fetchBlobVerified(hash, recordSite(record).servers);
}

/** Forget every site that isn't installed (clearing browsing data). */
export async function clearVisitedSites(): Promise<void> {
  await ready;
  ephemeral.clear();
  checkedAt.clear();
  for (const record of [...records.values()]) {
    if (!record.installed) await deleteRecord(record.host);
  }
}

// ---------------------------------------------------------------------------
// Content-addressed blob cache
// ---------------------------------------------------------------------------

let bytesSinceTrim = 0;
let trimming = false;

export function cachePathFor(hash: string): string {
  return path.join(blobDir, hash.slice(0, 2), hash);
}

/** Every blob an installed site needs, now or after its pending update. */
function pinnedHashes(): Set<string> {
  const pinned = new Set<string>();
  const add = (event: NostrEvent | null | undefined) => {
    if (!event) return;
    for (const hash of Object.values(collectPaths(event))) pinned.add(hash);
  };
  for (const record of records.values()) {
    if (!record.installed) continue;
    add(record.manifest);
    add(record.previous);
  }
  for (const manifest of staging.values()) add(manifest);
  return pinned;
}

async function listBlobs(): Promise<Array<{ file: string; hash: string; size: number; atime: number }>> {
  const files: Array<{ file: string; hash: string; size: number; atime: number }> = [];
  for (const shard of await fsp.readdir(blobDir).catch(() => [])) {
    const shardDir = path.join(blobDir, shard);
    for (const name of await fsp.readdir(shardDir).catch(() => [])) {
      const file = path.join(shardDir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      files.push({ file, hash: name, size: stat.size, atime: stat.atimeMs });
    }
  }
  return files;
}

/**
 * Drop the least recently used blobs until the cache is back under budget.
 * Installed sites' blobs are never dropped and don't count against it.
 */
async function trimCache(): Promise<void> {
  if (trimming) return;
  trimming = true;
  try {
    await ready;
    const pinned = pinnedHashes();
    const files = (await listBlobs()).filter((entry) => !pinned.has(entry.hash));
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= CACHE_BUDGET_BYTES) return;
    files.sort((a, b) => a.atime - b.atime);
    for (const entry of files) {
      if (total <= CACHE_BUDGET_BYTES) break;
      await fsp.unlink(entry.file).catch(() => {});
      total -= entry.size;
    }
  } finally {
    trimming = false;
  }
}

/** Delete every blob no installed site needs (clearing browsing data). */
export async function clearUnpinnedBlobs(): Promise<void> {
  await ready;
  const pinned = pinnedHashes();
  for (const entry of await listBlobs()) {
    if (!pinned.has(entry.hash)) await fsp.unlink(entry.file).catch(() => {});
  }
}

function noteCacheWrite(size: number): void {
  bytesSinceTrim += size;
  if (bytesSinceTrim < CACHE_TRIM_INTERVAL_BYTES) return;
  bytesSinceTrim = 0;
  void trimCache();
}

/** Write a verified blob into the cache, atomically. */
export async function storeBlob(hash: string, data: Buffer): Promise<void> {
  const target = cachePathFor(hash);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, target);
    noteCacheWrite(data.length);
  } catch {
    await fsp.unlink(temp).catch(() => {});
  }
}

/** A cached blob's size, or null when it isn't cached. */
export async function cachedBlobSize(hash: string): Promise<number | null> {
  const stat = await fsp.stat(cachePathFor(hash)).catch(() => null);
  return stat?.isFile() ? stat.size : null;
}

// ---------------------------------------------------------------------------
// Blossom fetch
// ---------------------------------------------------------------------------

/** Lowercase hex sha256 of a buffer. */
export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** BUD-01 blob URL on a server (https only). */
export function blobUrl(server: string, hash: string): string | null {
  try {
    const base = server.endsWith('/') ? server : `${server}/`;
    const url = new URL(hash, base);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** In-flight downloads, so a page and an install never fetch a blob twice. */
const fetching = new Map<string, Promise<Buffer | null>>();

/**
 * Download a blob and verify it against its hash, trying each server in turn.
 * Returns the bytes, or null if no server produced content matching the hash
 * from the signed manifest.
 */
export function fetchBlobVerified(hash: string, servers: string[]): Promise<Buffer | null> {
  const existing = fetching.get(hash);
  if (existing) return existing;
  const promise = (async () => {
    for (const server of servers) {
      const url = blobUrl(server, hash);
      if (!url) continue;
      try {
        const response = await net.fetch(url, {
          credentials: 'omit',
          signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const data = Buffer.from(await response.arrayBuffer());
        // The manifest is signed; the server is not trusted. A mismatch means
        // this server is lying or corrupt, so try the next one.
        if (sha256(data) !== hash) continue;
        await storeBlob(hash, data);
        return data;
      } catch {
        // Network error, timeout, abort: fall through to the next server.
      }
    }
    return null;
  })().finally(() => fetching.delete(hash));
  fetching.set(hash, promise);
  return promise;
}
