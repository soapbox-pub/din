// blossom: protocol handler - BUD-10 Blossom URIs, served without a gateway.
//
//   blossom:<sha256>.<ext>?xs=<server>&as=<pubkey>&sz=<bytes>
//
// A blossom: URI names a file by its hash, with hints for where to find it
// (src/lib/blossomUri.ts has the grammar and the renderer's copy of the
// parser). The Web Browser loads one like any page, and Chromium shows the
// file as it would from the web: a PDF in its viewer, a video that seeks.
//
// Where the file comes from, in BUD-10's order:
//
//   1. Din's blob cache, shared with nsites (nsite-store.mts)
//   2. the `xs` servers, over https only
//   3. each `as` author's BUD-03 server list (kind 10063)
//   4. the user's own Blossom servers, then Din's
//
// This process has no Nostr client, so 3 and 4 are asked of the shell renderer
// (BlossomBridgeHost), and only once the hints have come up short. What it
// answers is a list of places to look, nothing more: every byte served is
// checked against the hash, so no server and no relay is trusted.
//
// The scheme is registered as a standard one, which Chromium needs to seek a
// video, so `blossom:<sha256>.<ext>?…` arrives as `blossom://<sha256>.<ext>/?…`
// (the browser shows it in BUD-10's form). Each file is an origin of its own,
// reaching no site's storage; HTML, SVG and XML are served sandboxed besides,
// so they can't run script at all.

import { ipcMain, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isPublicHost } from './napp-fetch.mts';
import {
  adoptBlobFile,
  blobTempPath,
  cachedBlobSize,
  cachePathFor,
  nsiteStoreReady,
  sha256,
  storeBlob,
} from './nsite-store.mts';
import {
  errorPage,
  mimeFor,
  parseRange,
  SCRIPT_BEARING,
  toWebStream,
  VERIFY_IN_FULL_LIMIT,
} from './nsite.mts';

/** The scheme this module serves. */
export const BLOSSOM_SCHEME = 'blossom';

/** How long a single Blossom server gets to start answering. */
const SERVER_TIMEOUT_MS = 20_000;

/** How long the shell renderer gets to find the authors' servers. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** Longest URI accepted, and most hints of each kind followed. */
const MAX_LENGTH = 4096;
const MAX_HINTS = 8;

/** Types shown sandboxed: they could otherwise run script. */
const SANDBOXED = /^(text\/html|image\/svg\+xml|application\/xml|text\/xml)/;

// ---------------------------------------------------------------------------
// The URI
// ---------------------------------------------------------------------------

interface BlossomUri {
  sha256: string;
  ext: string;
  servers: string[];
  authors: string[];
  size: number | null;
}

const URI_RE = /^blossom:(?:\/\/)?([0-9a-f]{64})\.([a-z0-9]{1,16})\/?(?:\?([^#]*))?(?:#.*)?$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

/** Parse a request's URL. Mirrors parseBlossomUri in src/lib/blossomUri.ts. */
function parseUri(raw: string): BlossomUri | null {
  if (raw.length > MAX_LENGTH) return null;
  const match = URI_RE.exec(raw);
  if (!match) return null;
  const params = new URLSearchParams(match[3] ?? '');
  const rawSize = params.get('sz');
  return {
    sha256: match[1].toLowerCase(),
    ext: match[2].toLowerCase(),
    servers: params.getAll('xs').slice(0, MAX_HINTS),
    authors: [...new Set(params.getAll('as').filter((v) => PUBKEY_RE.test(v)).map((v) => v.toLowerCase()))].slice(0, MAX_HINTS),
    size: rawSize && /^\d{1,15}$/.test(rawSize) && Number(rawSize) > 0 ? Number(rawSize) : null,
  };
}

/**
 * An `xs` hint as the server's root URL. BUD-10 puts the server at the root
 * of the domain and lets the scheme be left off; Din only speaks https to it,
 * and never to a host on the local network a link could point it at.
 */
function hintServer(hint: string): string | null {
  const trimmed = hint.trim();
  if (/^http:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(/^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:' || url.username || url.password || !isPublicHost(url.hostname)) return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/** The blob's URL on a server (BUD-01 `GET /<sha256>.<ext>`), https only. */
function blobUrlOn(server: string, file: string): string | null {
  try {
    const url = new URL(file, server.endsWith('/') ? server : `${server}/`);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Servers (the authors' and the user's, asked of the shell renderer)
// ---------------------------------------------------------------------------

/** What the shell renderer answers a `blossom:request` with. */
interface ServerLookup {
  /** The authors' servers, from their kind 10063 lists, in order. */
  authorServers: string[];
  /** The user's own servers, then Din's. */
  servers: string[];
}

let sendToShell: (channel: string, payload: unknown) => void = () => {};
let nextRequestId = 1;
const pendingLookups = new Map<number, { resolve: (value: ServerLookup) => void; timer: NodeJS.Timeout }>();

function lookupServers(authors: string[]): Promise<ServerLookup> {
  return new Promise((resolve) => {
    const requestId = nextRequestId++;
    const timer = setTimeout(() => {
      pendingLookups.delete(requestId);
      resolve({ authorServers: [], servers: [] });
    }, LOOKUP_TIMEOUT_MS);
    pendingLookups.set(requestId, { resolve, timer });
    sendToShell('blossom:request', { requestId, authors });
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 64) : [];
}

/**
 * Every server to try for a blob, in order, each once: the hints first, and
 * only if they run out, the authors' and the user's. A server named in a link
 * or an author's list must be public; the user's own may be on their network.
 */
async function* candidateServers(uri: BlossomUri): AsyncGenerator<string> {
  const seen = new Set<string>();
  const fresh = (server: string | null) => {
    if (!server) return null;
    const key = server.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) return null;
    seen.add(key);
    return server;
  };
  for (const hint of uri.servers) {
    const server = fresh(hintServer(hint));
    if (server) yield server;
  }
  const lookup = await lookupServers(uri.authors);
  for (const raw of lookup.authorServers) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    const server = isPublicHost(host) ? fresh(raw) : null;
    if (server) yield server;
  }
  for (const raw of lookup.servers) {
    const server = fresh(raw);
    if (server) yield server;
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** A server's answer for the blob, with what it says about its length. */
interface Opened {
  response: Response;
  /** The body's length, when the server says. */
  length: number | null;
}

/**
 * Ask each server in turn for the blob (or a range of it) until one has it.
 * A server whose length disagrees with the URI's `sz` is skipped before its
 * body is read, as BUD-10 asks; so is one that redirects off https.
 */
async function openBlob(uri: BlossomUri, range: string | null): Promise<Opened | null> {
  const file = `${uri.sha256}.${uri.ext}`;
  for await (const server of candidateServers(uri)) {
    const url = blobUrlOn(server, file);
    if (!url) continue;
    // The timeout is for the server to start answering: a large file may
    // take far longer than that to arrive, and must not be cut off.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
    try {
      // Not through Chromium's HTTP cache: Din keeps verified blobs itself,
      // and the cache lets one request at a time have a URL, so a video's
      // second request (a seek) would wait out the first's whole download.
      const response = await net.fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        headers: range ? { range } : {},
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok || !response.body || !(response.url || url).startsWith('https:')) {
        void response.body?.cancel();
        continue;
      }
      const length = Number(response.headers.get('content-length'));
      const known = Number.isFinite(length) && length > 0 ? length : null;
      if (uri.size !== null) {
        const total = response.status === 206 ? totalOf(response.headers.get('content-range')) : known;
        if (total !== null && total !== uri.size) {
          void response.body.cancel();
          continue;
        }
      }
      return { response, length: known };
    } catch {
      clearTimeout(timer);
      // Try the next server.
    }
  }
  return null;
}

/** The whole length in a `Content-Range` header (`bytes 0-99/1234`). */
function totalOf(header: string | null): number | null {
  const match = header && /\/(\d+)\s*$/.exec(header);
  return match ? Number(match[1]) : null;
}

/** Read a whole body and check it against the hash; the bytes, or null. */
async function readVerified(body: ReadableStream<Uint8Array>, hash: string): Promise<Buffer | null> {
  const buffer = await new Response(body).arrayBuffer().catch(() => null);
  if (!buffer) return null;
  const data = Buffer.from(buffer);
  return sha256(data) === hash ? data : null;
}

/**
 * Pass a large body through as it arrives, hashing it, and error the stream
 * if the finished bytes don't match. Outside a private window the bytes are
 * written beside the cache as they go and moved into it once they check out,
 * so the file is never held in memory and the next look (or seek) is local.
 */
function streamVerified(body: ReadableStream<Uint8Array>, hash: string, persist: boolean): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const hasher = crypto.createHash('sha256');
  let total = 0;
  let temp: string | null = null;
  let out: fs.WriteStream | null = null;
  const discard = () => {
    const file = temp;
    out?.destroy();
    out = null;
    temp = null;
    if (file) fs.promises.unlink(file).catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async start() {
      if (!persist) return;
      try {
        temp = await blobTempPath(hash);
        out = fs.createWriteStream(temp);
        out.on('error', discard);
      } catch {
        discard();
      }
    },
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        discard();
        controller.error(error);
        return;
      }
      if (chunk.done) {
        if (hasher.digest('hex') !== hash) {
          discard();
          controller.error(new Error('blossom: the file does not match its hash'));
          return;
        }
        const stream = out;
        const file = temp;
        if (stream && file) {
          out = null;
          temp = null;
          stream.end(() => void adoptBlobFile(hash, file, total));
        }
        controller.close();
        return;
      }
      hasher.update(chunk.value);
      total += chunk.value.byteLength;
      out?.write(chunk.value);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      discard();
      void reader.cancel(reason);
    },
  });
}

/** In-flight whole downloads, so two requests for a blob fetch it once. */
const downloading = new Map<string, Promise<Buffer | null>>();

/** Download a whole blob, verified (and cached, outside a private window). */
function downloadVerified(uri: BlossomUri, persist: boolean): Promise<Buffer | null> {
  const key = `${persist ? 'p' : 'e'}:${uri.sha256}`;
  const existing = downloading.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const opened = await openBlob(uri, null);
    if (!opened?.response.body) return null;
    const data = await readVerified(opened.response.body, uri.sha256);
    if (data && persist) await storeBlob(uri.sha256, data);
    return data;
  })().finally(() => downloading.delete(key));
  downloading.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function headersFor(contentType: string, extra: Record<string, string>): Record<string, string> {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...(SANDBOXED.test(contentType) ? { 'content-security-policy': 'sandbox' } : {}),
    ...extra,
  };
}

/** Serve a whole blob, or a range of it, from bytes in hand. */
function serveBuffer(data: Buffer, contentType: string, rangeHeader: string | null, head: boolean): Response {
  const range = parseRange(rangeHeader, data.length);
  if (range) {
    const slice = data.subarray(range.start, range.end + 1);
    return new Response(head ? null : new Uint8Array(slice), {
      status: 206,
      headers: headersFor(contentType, {
        'content-length': String(slice.length),
        'content-range': `bytes ${range.start}-${range.end}/${data.length}`,
        'accept-ranges': 'bytes',
      }),
    });
  }
  return new Response(head ? null : new Uint8Array(data), {
    status: 200,
    headers: headersFor(contentType, { 'content-length': String(data.length), 'accept-ranges': 'bytes' }),
  });
}

/** Serve a cached blob, honoring `Range`, or null when it isn't cached. */
async function serveFromCache(hash: string, contentType: string, rangeHeader: string | null, head: boolean): Promise<Response | null> {
  const size = await cachedBlobSize(hash);
  if (size === null) return null;
  const file = cachePathFor(hash);
  const range = parseRange(rangeHeader, size);
  if (range) {
    const headers = headersFor(contentType, {
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'accept-ranges': 'bytes',
    });
    if (head) return new Response(null, { status: 206, headers });
    return new Response(toWebStream(fs.createReadStream(file, { start: range.start, end: range.end })), { status: 206, headers });
  }
  const headers = headersFor(contentType, { 'content-length': String(size), 'accept-ranges': 'bytes' });
  if (head) return new Response(null, { status: 200, headers });
  return new Response(toWebStream(fs.createReadStream(file)), { status: 200, headers });
}

function notFound(url: string): Response {
  return errorPage(
    404,
    'Could not find this file',
    'None of the Blossom servers this link names, its authors use or you use had a file matching its hash, or none answered in time.',
    url,
  );
}

function failedVerification(url: string): Response {
  return errorPage(502, 'This file failed verification', 'The bytes a Blossom server sent did not match the hash in the link.', url);
}

/**
 * Handle one blossom: request. `persist` is false in private windows: they
 * read the blob cache but never write it.
 */
async function handleRequest(request: Request, persist: boolean): Promise<Response> {
  const uri = parseUri(request.url);
  if (!uri) {
    return errorPage(400, 'That Blossom link is malformed', 'A Blossom link is blossom:, a 64-character sha256 and a file extension.', request.url);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorPage(405, 'Unsupported request', 'Blossom links are read-only.', request.url);
  }
  const head = request.method === 'HEAD';
  const contentType = mimeFor(`blob.${uri.ext}`);
  const rangeHeader = request.headers.get('range');
  const scriptBearing = SCRIPT_BEARING.test(contentType);

  await nsiteStoreReady();
  const cached = await serveFromCache(uri.sha256, contentType, rangeHeader, head);
  if (cached) return cached;

  // A media element's first request asks for everything from the start: that
  // is the whole file, fetched, checked and cached as any other, and answered
  // as the range it asked for, so the element knows it can seek.
  if (rangeHeader && /^bytes=0-$/.test(rangeHeader.trim())) {
    const opened = await openBlob(uri, null);
    if (!opened) return notFound(request.url);
    return serveWhole(opened, uri, contentType, head, persist, request.url, true);
  }

  // A later range (a video seeking) is passed through from the server
  // without waiting for the whole file, the hash only checkable over all of
  // it; never for anything that could run script.
  if (rangeHeader && !scriptBearing) {
    const opened = await openBlob(uri, rangeHeader);
    if (!opened?.response.body) return notFound(request.url);
    const { response } = opened;
    const body = response.body;
    if (response.status === 206 && body) {
      // The length from the range itself: net.fetch's answer may not carry
      // one, and a media element needs it.
      const contentRange = response.headers.get('content-range') ?? '';
      const bounds = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim());
      if (!bounds) {
        void body.cancel();
        return notFound(request.url);
      }
      const headers = headersFor(contentType, {
        'accept-ranges': 'bytes',
        'content-range': contentRange.trim(),
        'content-length': String(Number(bounds[2]) - Number(bounds[1]) + 1),
      });
      if (head) void body.cancel();
      return new Response(head ? null : body, { status: 206, headers });
    }
    // The server ignored the range and is sending all of it: so do we.
    return serveWhole(opened, uri, contentType, head, persist, request.url);
  }

  if (rangeHeader) {
    const data = await downloadVerified(uri, persist);
    return data ? serveBuffer(data, contentType, rangeHeader, head) : notFound(request.url);
  }

  const opened = await openBlob(uri, null);
  if (!opened) return notFound(request.url);
  return serveWhole(opened, uri, contentType, head, persist, request.url);
}

/**
 * Serve a server's whole-file answer. Small files, files of unknown length and
 * anything that could run script are checked in full before a byte is
 * released; a large file streams, checked as it goes.
 */
async function serveWhole(
  opened: Opened,
  uri: BlossomUri,
  contentType: string,
  head: boolean,
  persist: boolean,
  url: string,
  asRange = false,
): Promise<Response> {
  const body = opened.response.body;
  if (!body) return notFound(url);
  const length = opened.length;
  const status = asRange ? 206 : 200;
  const sized = (size: number) =>
    headersFor(contentType, {
      'content-length': String(size),
      'accept-ranges': 'bytes',
      ...(asRange ? { 'content-range': `bytes 0-${size - 1}/${size}` } : {}),
    });
  if (head && length !== null) {
    void body.cancel();
    return new Response(null, { status, headers: sized(length) });
  }
  if (length === null || length <= VERIFY_IN_FULL_LIMIT || SCRIPT_BEARING.test(contentType)) {
    const data = await readVerified(body, uri.sha256);
    if (!data) return failedVerification(url);
    if (persist) void storeBlob(uri.sha256, data);
    if (asRange && data.length > 0) return serveBuffer(data, contentType, 'bytes=0-', head);
    return serveBuffer(data, contentType, null, head);
  }
  return new Response(streamVerified(body, uri.sha256, persist), { status, headers: sized(length) });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Register the blossom: handler on each session that browses, and the IPC the
 * shell renderer answers server lookups on. Sessions marked `persist: false`
 * (private windows) never write the blob cache. Call after
 * registerNsiteProtocol, which opens the store the cache belongs to.
 */
export function registerBlossomProtocol({
  sessions,
  sendToShell: send,
  isShellSender,
}: {
  sessions: Array<{ session: Electron.Session; persist: boolean }>;
  sendToShell: (channel: string, payload: unknown) => void;
  isShellSender: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean;
}): void {
  sendToShell = send;

  for (const { session: target, persist } of sessions) {
    if (target.protocol.isProtocolHandled(BLOSSOM_SCHEME)) continue;
    target.protocol.handle(BLOSSOM_SCHEME, (request) =>
      handleRequest(request, persist).catch((error: unknown) =>
        errorPage(500, 'This file could not be loaded', error instanceof Error ? error.message : String(error), request.url),
      ),
    );
  }

  // Only the shell answers, so a page can never point Din at servers of its
  // choosing (not that it could do harm: every byte is checked).
  ipcMain.on('blossom:response', (event, payload) => {
    if (!isShellSender(event)) return;
    const pending = payload && pendingLookups.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingLookups.delete(payload.requestId);
    pending.resolve({ authorServers: stringList(payload.authorServers), servers: stringList(payload.servers) });
  });
}
