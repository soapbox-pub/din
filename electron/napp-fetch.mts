// napp.fetch: an HTTP request without CORS, for installed nsites (see
// napp.mts and Tenna's NAPP.md). A site may reach any https host, but only
// anonymously and only on the public internet:
//
//   - https only, no credentials in the URL, no CONNECT/TRACE/TRACK
//   - no cookies, ever: none are sent and Set-Cookie never reaches the site;
//     the headers a page can't set on fetch (Cookie, Origin, Host, Sec-*, ...)
//     are dropped here too
//   - nothing on the local network: loopback, private, link-local, CGNAT,
//     unique-local and reserved ranges are refused on the address actually
//     connected to (the DNS lookup is ours), and again on every redirect, so
//     a name pointed at 127.0.0.1 gets nowhere
//   - 16 MB up, 64 MB down, 8 requests in flight per site, 5 redirects, 30 s
//     for the response headers
//
// Requests use Node's https client, not Chromium's: only it lets the lookup
// be checked before the connection is made. The response streams back in
// chunks the site pulls (fetchRead), so it gets a real streaming Response.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const MAX_REDIRECTS = 5;
const HEADERS_TIMEOUT_MS = 30_000;
/** A response nobody reads from for this long is abandoned. */
const IDLE_TIMEOUT_MS = 60_000;

/** Headers a site may not set (the Fetch standard's forbidden names, and more). */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-', 'x-forwarded-'];

const REFUSED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Addresses a site may never reach. */
const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** Whether a site may connect to an IP address. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1, or the old
  // ::127.0.0.1) is that IPv4 address.
  const mapped = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !blocked.check(address, 'ipv6');
}

/**
 * Whether a URL's host may be one the main process connects to for a site:
 * not localhost or a .local name, nor a literal address that isn't public.
 * Names are checked as written only; napp.fetch checks what they resolve to.
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return net.isIP(host) ? isPublicAddress(host) : true;
}

/** A refusal the site sees as fetch's own TypeError. */
class RefusedError extends Error {}

/** DNS lookup that only ever hands the socket public addresses. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const allowed = addresses.filter((a) => isPublicAddress(a.address));
    if (allowed.length === 0) {
      callback(new RefusedError(`${hostname} is on a private network`), '', 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (error: null, addresses: dns.LookupAddress[]) => void)(null, allowed);
    } else {
      callback(null, allowed[0].address, allowed[0].family);
    }
  });
};

/** Check a URL a request is about to go to; returns it parsed. */
function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RefusedError('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new RefusedError('napp.fetch only fetches https URLs');
  if (url.username || url.password) throw new RefusedError('URLs with credentials are refused');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new RefusedError(`${host || 'This host'} is on this computer`);
  }
  // A literal address skips the lookup, so it's checked here.
  if (net.isIP(host) && !isPublicAddress(host)) throw new RefusedError(`${host} is on a private network`);
  return url;
}

export interface NappFetchRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  redirect: 'follow' | 'error' | 'manual';
}

export interface NappFetchHead {
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
}

interface Active {
  site: string;
  stream: Readable | null;
  iterator: AsyncIterator<Buffer> | null;
  received: number;
  idle: NodeJS.Timeout | null;
  abort: () => void;
}

let nextId = 1;
const active = new Map<number, Active>();

function inFlight(site: string): number {
  let count = 0;
  for (const request of active.values()) if (request.site === site) count++;
  return count;
}

function finish(id: number): void {
  const request = active.get(id);
  if (!request) return;
  active.delete(id);
  if (request.idle) clearTimeout(request.idle);
  request.abort();
}

function touch(id: number): void {
  const request = active.get(id);
  if (!request) return;
  if (request.idle) clearTimeout(request.idle);
  request.idle = setTimeout(() => finish(id), IDLE_TIMEOUT_MS);
}

/** The request's headers as Node takes them, with the forbidden ones dropped. */
function outgoingHeaders(headers: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of headers) {
    const name = String(rawName).toLowerCase();
    if (!TOKEN_RE.test(name) || /[\r\n\0]/.test(String(value))) continue;
    if (FORBIDDEN_HEADERS.has(name) || FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))) continue;
    out[name] = out[name] === undefined ? String(value) : `${out[name]}, ${value}`;
  }
  out['accept-encoding'] = 'gzip, deflate, br';
  out['user-agent'] ??= 'Din';
  return out;
}

/** One hop: resolves with the response once its headers are in. */
function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = { ...headers };
    if (body) outgoing['content-length'] = String(body.length);
    const request = https.request(url, {
      method,
      headers: outgoing,
      lookup: publicLookup,
      agent: false,
      signal,
    });
    const timer = setTimeout(() => request.destroy(new RefusedError('The server took too long to answer')), HEADERS_TIMEOUT_MS);
    request.once('response', (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : undefined);
  });
}

/** The response body, decoded as the server encoded it. */
function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

/**
 * Start a request for `site` (a canonical nsite host). Resolves with the
 * response's status and headers; the body is read with {@link fetchRead}.
 * Rejects with an Error whose message the site sees as fetch's TypeError.
 */
export async function fetchStart(site: string, request: NappFetchRequest): Promise<NappFetchHead> {
  if (!request || typeof request.url !== 'string' || typeof request.method !== 'string') {
    throw new RefusedError('Invalid request');
  }
  const method = request.method.toUpperCase();
  if (!TOKEN_RE.test(method) || REFUSED_METHODS.has(method)) throw new RefusedError(`${method} is not allowed`);
  const body = request.body instanceof Uint8Array && request.body.length > 0 ? request.body : null;
  if (body && body.length > MAX_REQUEST_BYTES) throw new RefusedError('The request body is over 16 MB');
  if (body && (method === 'GET' || method === 'HEAD')) throw new RefusedError(`A ${method} request has no body`);
  if (inFlight(site) >= MAX_IN_FLIGHT) throw new RefusedError('Too many requests in flight');
  const headers = outgoingHeaders(Array.isArray(request.headers) ? request.headers : []);

  const id = nextId++;
  const controller = new AbortController();
  const entry: Active = {
    site,
    stream: null,
    iterator: null,
    received: 0,
    idle: null,
    abort: () => controller.abort(),
  };
  active.set(id, entry);

  try {
    let url = checkUrl(request.url);
    let hopMethod = method;
    let hopBody = body;
    let hopHeaders = headers;
    for (let hop = 0; ; hop++) {
      const response = await requestOnce(url, hopMethod, hopHeaders, hopBody, controller.signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && status !== 304 && location) {
        response.resume();
        if (request.redirect === 'error') throw new RefusedError('The server redirected');
        if (hop >= MAX_REDIRECTS) throw new RefusedError('Too many redirects');
        const next = checkUrl(new URL(location, url).href);
        // 303, and 301/302 after a POST, become a bodiless GET, as in fetch.
        if (status === 303 ? hopMethod !== 'HEAD' : (status === 301 || status === 302) && hopMethod === 'POST') {
          hopMethod = 'GET';
          hopBody = null;
          hopHeaders = Object.fromEntries(
            Object.entries(hopHeaders).filter(([name]) => !name.startsWith('content-')),
          );
        }
        // Credentials the site set for one host aren't handed to another.
        if (next.host !== url.host) {
          hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([name]) => name !== 'authorization'));
        }
        url = next;
        continue;
      }

      const out: [string, string][] = [];
      const raw = response.rawHeaders;
      const recoded = response.headers['content-encoding'] !== undefined;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i].toLowerCase();
        if (name === 'set-cookie' || name === 'set-cookie2') continue;
        if (recoded && (name === 'content-encoding' || name === 'content-length')) continue;
        out.push([raw[i], raw[i + 1]]);
      }
      out.push(['X-Napp-Final-Url', url.href]);

      const stream = decoded(response);
      entry.stream = stream;
      entry.iterator = stream[Symbol.asyncIterator]();
      entry.abort = () => {
        controller.abort();
        stream.destroy();
        response.destroy();
      };
      touch(id);
      return { id, status, statusText: response.statusMessage ?? '', headers: out };
    }
  } catch (error) {
    finish(id);
    if (error instanceof RefusedError) throw new Error(error.message, { cause: error });
    throw new Error(error instanceof Error && error.name === 'AbortError' ? 'The request was aborted' : 'Failed to fetch', {
      cause: error,
    });
  }
}

/** The next chunk of a response body, or null at its end. */
export async function fetchRead(site: string, id: unknown): Promise<Uint8Array | null> {
  const request = typeof id === 'number' ? active.get(id) : undefined;
  if (!request || request.site !== site || !request.iterator) return null;
  touch(id as number);
  let next: IteratorResult<Buffer>;
  try {
    next = await request.iterator.next();
  } catch {
    finish(id as number);
    throw new Error('The response was cut off');
  }
  if (next.done) {
    finish(id as number);
    return null;
  }
  request.received += next.value.length;
  if (request.received > MAX_RESPONSE_BYTES) {
    finish(id as number);
    throw new Error('The response is over 64 MB');
  }
  return new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
}

/** Stop reading a response (the site cancelled its body, or aborted). */
export function fetchAbort(site: string, id: unknown): void {
  const request = typeof id === 'number' ? active.get(id) : undefined;
  if (request && request.site === site) finish(id as number);
}

/** Abandon everything a site has in flight (it was uninstalled). */
export function fetchAbortAll(site: string): void {
  for (const [id, request] of active) if (request.site === site) finish(id);
}
