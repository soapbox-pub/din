// nsite:// protocol handler - NIP-5A static websites, served without a gateway.
//
// A request arrives here for one of two URL spaces (see src/lib/nsite.ts for
// the grammar):
//
//   canonical  nsite://<npub1…>/<path>            root site   (kind 15128)
//              nsite://<pubkeyB36><dtag>/<path>   named site  (kind 35128)
//   alias      nsite://<domain>/[@<name>/]<site>/<path>
//              nsite://<naddr1…>/<path>
//
// Aliases never serve bytes: they resolve to a canonical URL and 302, so the
// document a page runs in is always key-derived. That is what gives each site
// its own Chromium origin (storage, cookies, service worker) and stops an SPA
// from pushState-ing out of its own site.
//
// The data path has no gateway and no trusted intermediary:
//
//   manifest  a signed Nostr event, fetched from relays by the shell renderer
//             (this process has no Nostr client - see registerNsiteHandlers)
//   blobs     fetched straight from Blossom servers by sha256, and *verified*
//             against the hash in the signed manifest before the page sees a
//             byte. A lying server fails the hash and the next one is tried.
//
// Blobs are content-addressed, therefore immutable, therefore perfectly
// cacheable: they land in userData/nsite-blobs/<hash> and are LRU-trimmed.

import { app, ipcMain, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** The scheme this module serves. */
export const NSITE_SCHEME = 'nsite';

/**
 * Adapt a Node read stream to the web stream a `Response` body wants. Node's
 * and the DOM's `ReadableStream` are structurally different types for the same
 * runtime object here, so the cast is the whole point.
 */
function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/** A resolved site manifest, as returned by the shell renderer. */
export interface NsiteSite {
  /** Canonical host this manifest serves (`npub1…` or `<pubkeyB36><dtag>`). */
  host: string;
  /** 64-char lowercase hex pubkey of the site's author. */
  pubkey: string;
  /** The `d` tag for a named site, or null for a root site. */
  dtag: string | null;
  /** Absolute path -> sha256 hex, from the manifest's `path` tags. */
  paths: Record<string, string>;
  /** Blossom servers to try, most trusted first. */
  servers: string[];
  /** The manifest's `title` tag, if any. */
  title: string | null;
  /** The manifest event's `created_at`. */
  updatedAt: number;
}

/** What the shell renderer answers an `nsite:request` with. */
export type NsiteResolution =
  | { kind: 'site'; site: NsiteSite }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; code: string; message: string };

/** How long a resolved manifest is reused before being re-queried. */
const MANIFEST_TTL_MS = 5 * 60_000;

/** How long the shell renderer gets to answer a resolution request. */
const RESOLVE_TIMEOUT_MS = 30_000;

/** How long a single Blossom server gets before we move to the next. */
const BLOB_TIMEOUT_MS = 30_000;

/**
 * Below this size a blob is buffered and hash-checked before any of it is
 * released to the page. Above it the body is streamed and verified as it goes,
 * erroring the stream on mismatch - a page can observe a prefix of an
 * unverified large file, but script-bearing types are buffered whatever their
 * size (SCRIPT_BEARING), so nothing with XSS consequence is released unverified.
 */
const VERIFY_IN_FULL_LIMIT = 4 * 1024 * 1024;

/** Content types that can execute script; always verified before release. */
const SCRIPT_BEARING = /^(text\/html|text\/javascript|image\/svg\+xml|application\/xml|application\/wasm)/;

/** Disk budget for the content-addressed blob cache. */
const CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

/** Bytes written since the last trim; trigger a sweep past this. */
const CACHE_TRIM_INTERVAL_BYTES = 32 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};

/** Content type for a path, from its extension. Blossom's is unreliable. */
function mimeFor(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Lowercase hex sha256 of a buffer. */
function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Manifest resolution (relayed to the shell renderer)
// ---------------------------------------------------------------------------

let sendToShell: (channel: string, payload: unknown) => void = () => {};
let isShellSender: (event: Electron.IpcMainEvent) => boolean = () => false;

let nextRequestId = 1;
const pendingResolutions = new Map<number, {
  resolve: (value: NsiteResolution) => void;
  timer: NodeJS.Timeout;
}>();

/** Cached manifests, keyed by canonical host. */
const manifestCache = new Map<string, { site: NsiteSite; fetchedAt: number }>();

/** In-flight resolutions, so a burst of subresources costs one relay query. */
const inFlight = new Map<string, Promise<NsiteResolution>>();

/**
 * Ask the shell renderer to resolve a URL: NIP-19 decoding, the NIP-05 lookup,
 * and the relay query all live there, where Nostrify, the user's relay list,
 * and the query cache already are. This process deliberately has no Nostr
 * client of its own.
 */
function resolveViaShell(url: string): Promise<NsiteResolution> {
  return new Promise((resolve) => {
    const requestId = nextRequestId++;
    const timer = setTimeout(() => {
      pendingResolutions.delete(requestId);
      resolve({
        kind: 'error',
        code: 'timeout',
        message: 'Timed out looking up this site on your relays.',
      });
    }, RESOLVE_TIMEOUT_MS);
    pendingResolutions.set(requestId, { resolve, timer });
    sendToShell('nsite:request', { requestId, url });
  });
}

/** Resolve a URL, collapsing concurrent requests for the same key. */
function resolveOnce(key: string, url: string): Promise<NsiteResolution> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = resolveViaShell(url).then((resolution) => {
    if (resolution.kind === 'site') {
      manifestCache.set(resolution.site.host, {
        site: resolution.site,
        fetchedAt: Date.now(),
      });
    }
    inFlight.delete(key);
    return resolution;
  });

  inFlight.set(key, promise);
  return promise;
}

/** A cached manifest for a host, if one is still fresh. */
function cachedSite(host: string): NsiteSite | null {
  const entry = manifestCache.get(host);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MANIFEST_TTL_MS) {
    manifestCache.delete(host);
    return null;
  }
  return entry.site;
}

/**
 * Whether a host looks like a canonical (key-derived) one. Only used to pick a
 * cache key - the renderer stays authoritative about what a host really means.
 */
function looksCanonical(host: string): boolean {
  if (/^npub1[0-9a-z]{58}$/.test(host)) return true;
  return /^[0-9a-z]{50}[a-z0-9-]{1,13}$/.test(host) && !host.endsWith('-');
}

// ---------------------------------------------------------------------------
// Content-addressed blob cache
// ---------------------------------------------------------------------------

let cacheDir = '';
let bytesSinceTrim = 0;
let trimming = false;

function cachePathFor(hash: string): string {
  return path.join(cacheDir, hash.slice(0, 2), hash);
}

/** Drop the least recently used blobs until the cache is back under budget. */
async function trimCache(): Promise<void> {
  if (trimming) return;
  trimming = true;
  try {
    const files: Array<{ file: string; size: number; atime: number }> = [];
    let total = 0;
    for (const shard of await fsp.readdir(cacheDir).catch(() => [])) {
      const shardDir = path.join(cacheDir, shard);
      for (const name of await fsp.readdir(shardDir).catch(() => [])) {
        const file = path.join(shardDir, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        files.push({ file, size: stat.size, atime: stat.atimeMs });
        total += stat.size;
      }
    }
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

/** Note bytes added to the cache, sweeping it occasionally. */
function noteCacheWrite(size: number): void {
  bytesSinceTrim += size;
  if (bytesSinceTrim < CACHE_TRIM_INTERVAL_BYTES) return;
  bytesSinceTrim = 0;
  void trimCache();
}

/** Write a verified blob into the cache, atomically. */
async function storeBlob(hash: string, data: Buffer): Promise<void> {
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
async function cachedBlobSize(hash: string): Promise<number | null> {
  const stat = await fsp.stat(cachePathFor(hash)).catch(() => null);
  return stat?.isFile() ? stat.size : null;
}

// ---------------------------------------------------------------------------
// Blossom fetch
// ---------------------------------------------------------------------------

/** BUD-01 blob URL on a server. */
function blobUrl(server: string, hash: string): string | null {
  try {
    const base = server.endsWith('/') ? server : `${server}/`;
    const url = new URL(hash, base);
    // https only: the server list comes from the site author, and these
    // fetches run from the main process - a plain-http "server" would let any
    // site aim requests at the user's LAN or localhost.
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Download a blob and verify it against its hash, trying each server in turn.
 * Returns the bytes, or null if no server produced content matching the hash
 * from the signed manifest.
 */
async function fetchBlobVerified(hash: string, servers: string[]): Promise<Buffer | null> {
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
}

/**
 * Stream a large blob, hashing as it goes and erroring the stream if the
 * finished bytes don't match the manifest. The verified copy is written to the
 * cache so subsequent (and ranged) reads are served locally.
 */
function streamBlobVerified(
  body: ReadableStream<Uint8Array>,
  hash: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const hasher = crypto.createHash('sha256');
  const chunks: Buffer[] = [];
  let total = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (hasher.digest('hex') !== hash) {
          controller.error(new Error('nsite: blob does not match the signed manifest'));
          return;
        }
        void storeBlob(hash, Buffer.concat(chunks, total));
        controller.close();
        return;
      }
      hasher.update(value);
      chunks.push(Buffer.from(value));
      total += value.byteLength;
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}

/** Open a streaming, hash-verified body for a blob from the first live server. */
async function openBlobStream(
  hash: string,
  servers: string[],
): Promise<{ body: ReadableStream<Uint8Array>; size: number | null } | null> {
  for (const server of servers) {
    const url = blobUrl(server, hash);
    if (!url) continue;
    try {
      const response = await net.fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) continue;
      const length = Number(response.headers.get('content-length'));
      return {
        body: streamBlobVerified(response.body, hash),
        size: Number.isFinite(length) && length > 0 ? length : null,
      };
    } catch {
      // Try the next server.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A branded failure page, served in place of Chromium's raw network error. */
function errorPage(status: number, title: string, detail: string, url: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 Inter, system-ui, sans-serif; background: #f8fafc; color: #0f172a;
         padding: 32px; }
  @media (prefers-color-scheme: dark) { body { background: #0b1120; color: #e2e8f0; } }
  main { max-width: 34rem; text-align: center; }
  h1 { font-size: 1.75rem; margin: 0 0 12px; letter-spacing: -0.02em; }
  p { margin: 0 0 16px; opacity: 0.85; }
  code { display: block; overflow-wrap: anywhere; font-size: 0.875rem; opacity: 0.7;
         background: rgba(127,127,127,0.12); padding: 12px 16px; border-radius: 12px; }
</style></head>
<body><main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  <code>${escapeHtml(url)}</code>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Map a resolution error code to a page. */
function resolutionErrorPage(code: string, message: string, url: string): Response {
  const titles: Record<string, string> = {
    'bad-url': 'That nsite address is malformed',
    'no-nip05': "That domain doesn't point to a Nostr key",
    'no-manifest': "This site isn't published yet",
    timeout: 'Relays took too long to answer',
  };
  const status = code === 'bad-url' ? 400 : code === 'no-manifest' ? 404 : 502;
  return errorPage(status, titles[code] ?? 'This nsite could not be loaded', message, url);
}

/** A no-store redirect. Aliases must never be cached into a stale pubkey. */
function redirectTo(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: url, 'cache-control': 'no-store' },
  });
}

/** Parse a `Range` header against a known length. Null means "ignore it". */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  if (rawStart === '') {
    if (rawEnd === '') return null;
    const length = Math.min(Number(rawEnd), size);
    if (length <= 0) return null;
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return null;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Path resolution (NIP-5A)
// ---------------------------------------------------------------------------

interface ResolvedPath {
  hash: string;
  path: string;
  status: number;
}

/** Percent-decode a pathname, tolerating malformed escapes. */
function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Map a request path to a blob hash, following NIP-5A's fallback chain: the
 * exact path, then `index.html` when the path names no file, then `/404.html`.
 */
function resolvePath(site: NsiteSite, pathname: string): ResolvedPath | null {
  const requested = safeDecode(pathname) || '/';

  const exact = site.paths[requested];
  if (exact) return { hash: exact, path: requested, status: 200 };

  const lastSegment = requested.slice(requested.lastIndexOf('/') + 1);
  if (!lastSegment.includes('.')) {
    const indexPath = requested.endsWith('/')
      ? `${requested}index.html`
      : `${requested}/index.html`;
    const index = site.paths[indexPath];
    if (index) return { hash: index, path: indexPath, status: 200 };
  }

  const notFound = site.paths['/404.html'];
  if (notFound) return { hash: notFound, path: '/404.html', status: 404 };

  return null;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** Serve a blob that is already in the cache, honoring `Range`. */
async function serveFromCache(
  hash: string,
  contentType: string,
  status: number,
  rangeHeader: string | null,
  head: boolean,
): Promise<Response | null> {
  const size = await cachedBlobSize(hash);
  if (size === null) return null;
  const file = cachePathFor(hash);

  const range = parseRange(rangeHeader, size);
  if (range) {
    const length = range.end - range.start + 1;
    const headers = {
      'content-type': contentType,
      'content-length': String(length),
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'accept-ranges': 'bytes',
    };
    if (head) return new Response(null, { status: 206, headers });
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    return new Response(toWebStream(stream), { status: 206, headers });
  }

  const headers = {
    'content-type': contentType,
    'content-length': String(size),
    'accept-ranges': 'bytes',
  };
  if (head) return new Response(null, { status, headers });
  return new Response(toWebStream(fs.createReadStream(file)), { status, headers });
}

/** Handle one nsite:// request. */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorPage(405, 'Unsupported request', 'nsites are read-only.', request.url);
  }
  const head = request.method === 'HEAD';

  // Resolve the host to a manifest, or bounce an alias to its canonical URL.
  let site = looksCanonical(host) ? cachedSite(host) : null;
  if (!site) {
    const key = looksCanonical(host) ? host : request.url;
    const resolution = await resolveOnce(key, request.url);
    if (resolution.kind === 'redirect') return redirectTo(resolution.url);
    if (resolution.kind === 'error') {
      return resolutionErrorPage(resolution.code, resolution.message, request.url);
    }
    site = resolution.site;
    // The renderer is authoritative: if it canonicalized to a different host,
    // the page must run on *that* origin, not this one.
    if (site.host !== host) {
      return redirectTo(`${NSITE_SCHEME}://${site.host}${url.pathname}${url.search}${url.hash}`);
    }
  }

  const target = resolvePath(site, url.pathname);
  if (!target) {
    return errorPage(
      404,
      'Not found on this nsite',
      `${site.title ?? 'This site'} publishes no file at ${safeDecode(url.pathname)}.`,
      request.url,
    );
  }
  if (!HASH_RE.test(target.hash)) {
    return errorPage(
      502,
      'Malformed site manifest',
      'The manifest maps this path to something that is not a sha256 hash.',
      request.url,
    );
  }

  const contentType = mimeFor(target.path);
  const rangeHeader = request.headers.get('range');

  const cached = await serveFromCache(
    target.hash,
    contentType,
    target.status,
    rangeHeader,
    head,
  );
  if (cached) return cached;

  if (site.servers.length === 0) {
    return errorPage(
      502,
      'No Blossom server to fetch from',
      "This site's manifest lists no servers and its author publishes no server list (kind 10063).",
      request.url,
    );
  }

  // A ranged request needs the whole blob anyway - the hash can only be
  // checked over the complete file - so fetch it, then serve the range from
  // the cache.
  if (rangeHeader) {
    const data = await fetchBlobVerified(target.hash, site.servers);
    if (!data) {
      return errorPage(
        502,
        'Could not fetch this file',
        'No Blossom server returned content matching the hash in the signed manifest.',
        request.url,
      );
    }
    const served = await serveFromCache(
      target.hash,
      contentType,
      target.status,
      rangeHeader,
      head,
    );
    if (served) return served;
    return new Response(head ? null : new Uint8Array(data), {
      status: target.status,
      headers: { 'content-type': contentType, 'content-length': String(data.length) },
    });
  }

  const opened = await openBlobStream(target.hash, site.servers);
  if (!opened) {
    return errorPage(
      502,
      'Could not fetch this file',
      'No Blossom server had this file, or none answered in time.',
      request.url,
    );
  }

  // Small files are verified in full before the page sees any of them, and so
  // is anything that can run script however large it is: HTML executes as it
  // streams, so an unverified prefix would be XSS in the site's origin.
  if (
    opened.size === null ||
    opened.size <= VERIFY_IN_FULL_LIMIT ||
    SCRIPT_BEARING.test(contentType)
  ) {
    const buffered = await new Response(opened.body).arrayBuffer().catch(() => null);
    if (!buffered) {
      return errorPage(
        502,
        'This file failed verification',
        'The bytes served did not match the sha256 hash in the signed manifest.',
        request.url,
      );
    }
    const data = Buffer.from(buffered);
    return new Response(head ? null : new Uint8Array(data), {
      status: target.status,
      headers: {
        'content-type': contentType,
        'content-length': String(data.length),
        'accept-ranges': 'bytes',
      },
    });
  }

  if (head) {
    void opened.body.cancel();
    return new Response(null, {
      status: target.status,
      headers: {
        'content-type': contentType,
        'content-length': String(opened.size),
        'accept-ranges': 'bytes',
      },
    });
  }

  return new Response(opened.body, {
    status: target.status,
    headers: {
      'content-type': contentType,
      'content-length': String(opened.size),
      'accept-ranges': 'bytes',
    },
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Register the nsite:// handler on each browser session, and the IPC channel
 * the shell renderer answers manifest lookups on.
 */
export function registerNsiteProtocol({
  sessions,
  sendToShell: send,
  isShellSender: isShell,
}: {
  sessions: Electron.Session[];
  sendToShell: (channel: string, payload: unknown) => void;
  isShellSender: (event: Electron.IpcMainEvent) => boolean;
}): void {
  sendToShell = send;
  isShellSender = isShell;

  cacheDir = path.join(app.getPath('userData'), 'nsite-blobs');
  fs.mkdirSync(cacheDir, { recursive: true });
  void trimCache();

  for (const target of sessions) {
    if (target.protocol.isProtocolHandled(NSITE_SCHEME)) continue;
    target.protocol.handle(NSITE_SCHEME, (request) =>
      handleRequest(request).catch((error: unknown) =>
        errorPage(
          500,
          'This nsite could not be loaded',
          error instanceof Error ? error.message : String(error),
          request.url,
        ),
      ),
    );
  }

  // The shell renderer's answer to a relayed lookup. Only the shell may
  // resolve these, so a guest can never answer for a site it doesn't own.
  ipcMain.on('nsite:response', (event, payload) => {
    if (!isShellSender(event)) return;
    const pending = payload && pendingResolutions.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingResolutions.delete(payload.requestId);
    pending.resolve(payload.resolution as NsiteResolution);
  });
}

/** Forget every cached manifest (called when browsing data is cleared). */
export function clearNsiteManifestCache(): void {
  manifestCache.clear();
}

/** Delete every cached blob (called when browsing data is cleared). */
export async function clearNsiteBlobCache(): Promise<void> {
  if (!cacheDir) return;
  await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {});
}
