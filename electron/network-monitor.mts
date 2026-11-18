// The network side of the System Monitor (window.dinos.networkMonitor): what
// Din's pages fetch, and which programs have connections open.
//
// Requests: every page's HTTP requests and WebSockets, as Chrome's DevTools
// shows them, from the DevTools protocol's Network domain on each page's
// debugger (shared through guest-debugger.mts) while someone records. Not
// session.webRequest: a listener there on the browser's session switches
// chrome.webRequest off for every extension (see main.mts), and each event
// takes only one listener. Private and Tor tabs are never recorded, nor are
// DevTools' own pages. Frames inside other processes (cross-site iframes)
// aren't seen: their requests are their own target's.
//
// Recording only watches; it never blocks or changes a request. Updates go
// to the shell in batches (`network-monitor:events`) every FLUSH_MS; the
// shell keeps the list, and the main process forgets a request once it's
// done and sent. WebSocket frames are cut to FRAME_PREVIEW characters.
// While DevTools is open on a page its frontend owns the Network domain, so
// it's left as the frontend set it, and when DevTools goes it's set up again
// (the holder's reapply).
//
// Connections: every program's established TCP and connected UDP sockets,
// with the bytes each TCP one has carried, from `ss` (iproute2), read when
// asked. Other users' sockets are listed without their program, which only
// root could see. Connections to this computer itself (loopback) aren't
// listed.
//
// A connection is named, and given to what in Din opened it, by what Din
// knows of its own connections, always and not only while recording: the
// main process's own sockets by their local port (undici's connected
// channel: fetch and WebSocket in main, the background relay subscriptions
// of installed nsites among them, whose sites `backgroundSites` names); and
// pages' WebSockets, which connection-preload.cjs reports by host, as it
// does each page's own address, resolved to addresses through the page's
// session (Chromium's own host cache, so the addresses it connected to).
// What Din didn't open, or opened before it was watched, is named by the
// hosts recorded requests reached at its address, else by reverse DNS,
// cached, which is the network's name for the address (often its hosting
// company's) rather than the one it was asked for by.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import diagnostics from 'node:diagnostics_channel';
import dns from 'node:dns/promises';
import net from 'node:net';
import { app, ipcMain, webContents } from 'electron';
import { holdDebugger, holdsDebugger, releaseDebugger } from './guest-debugger.mts';
import { CommandError, runCommand } from './system.mts';

const HOLDER = 'network-monitor';
const FLUSH_MS = 300;
/** How much of a WebSocket frame's payload is kept. */
const FRAME_PREVIEW = 2000;
/** Frames sent in one batch; a busier socket's extras are counted, not sent. */
const FRAMES_PER_FLUSH = 400;
const SS_TIMEOUT_MS = 5000;
const HOST_CACHE_LIMIT = 4000;
/** Reverse lookups at once, and how long one gets. */
const REVERSE_CONCURRENCY = 4;
const REVERSE_TIMEOUT_MS = 3000;
/** How long a host's addresses are trusted before they're asked for again. */
const RESOLVE_TTL_MS = 60_000;
/** Socket hosts kept per page. */
const PAGE_HOST_LIMIT = 200;

/** Who made a request: the desktop itself, or one of its pages. */
export interface RequestSource {
  /** The WebContents, for telling one page from another. */
  contentsId: number;
  kind: 'desktop' | 'browser-tab' | 'web-app' | 'page';
  /** The page's own address (din://files/, a tab's site, widget://clock/). */
  url: string;
  title: string;
}

export type RequestState = 'pending' | 'done' | 'failed' | 'open' | 'closed';

export interface NetworkRequest {
  /** Unique while Din runs: the page's id and the protocol's request id (and a redirect's step). */
  id: string;
  url: string;
  method: string;
  /** DevTools' resource type: Document, Script, Image, Fetch, XHR, WebSocket, ... */
  type: string;
  state: RequestState;
  /** When it started and ended, in ms since the epoch. */
  startedAt: number;
  endedAt: number | null;
  status: number | null;
  statusText: string;
  mimeType: string;
  /** h2, http/1.1, h3, ... */
  protocol: string;
  /** The server's address, as ip:port. */
  remoteAddress: string;
  fromCache: boolean;
  /** Bytes it took over the network, headers included, once known (or so far). */
  size: number;
  /** Where it was redirected, when it was. */
  redirectedTo: string | null;
  error: string | null;
  /** What asked for it: a script's or document's address. */
  initiator: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** A WebSocket's frames so far, each way. */
  framesSent: number;
  framesReceived: number;
  source: RequestSource;
}

export interface WebSocketFrame {
  requestId: string;
  at: number;
  direction: 'sent' | 'received';
  /** 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number;
  /** The payload (base64 for binary), cut to FRAME_PREVIEW characters. */
  data: string;
  /** The payload's whole length, in bytes. */
  length: number;
  /** Whether `data` is only the payload's start. */
  truncated: boolean;
}

export interface NetworkEvents {
  /** Requests that changed, whole. */
  requests: NetworkRequest[];
  frames: WebSocketFrame[];
  /** Frames left out of this batch for being too many. */
  framesDropped: number;
}

/** Something in Din a connection is for: a page, or an installed nsite's background subscriptions. */
export interface ConnectionUser {
  kind: RequestSource['kind'] | 'background';
  /** The page's address, or the nsite's origin (nsite://host). */
  url: string;
  title: string;
}

export interface Connection {
  protocol: 'tcp' | 'udp';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** The remote's name, when known. */
  remoteHost: string | null;
  /**
   * Where `remoteHost` is from: `din` for the name Din connected by, `reverse`
   * for reverse DNS (the address's own name, often its hosting company's).
   */
  hostFrom: 'din' | 'reverse' | null;
  /** Other names Din reached at the same address (a CDN's are shared), so maybe this one's. */
  otherHosts: string[];
  /** What in Din it's for, when Din opened it and knows; empty for Din itself or anything else. */
  users: ConnectionUser[];
  /** Null for another user's, whose program only root can see. */
  pid: number | null;
  program: string | null;
  uid: number | null;
  /** The socket's inode: tells a reconnect from the same connection. */
  inode: number;
  /** Bytes carried so far (TCP only). */
  sent: number | null;
  received: number | null;
}

export interface ConnectionsResult {
  /** False when `ss` isn't there to ask. */
  available: boolean;
  connections: Connection[];
}

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let shell: () => Electron.WebContents | null = () => null;
let pageKind: (contents: Electron.WebContents) => string = () => 'page';
let ignored: (contents: Electron.WebContents) => boolean = () => false;

let subscribers = 0;
let recording = false;
/** Pages being recorded, with what to undo when recording stops. */
const tracked = new Map<number, { contents: Electron.WebContents; detach: () => void }>();
/** Requests in flight, by id. */
const requests = new Map<string, NetworkRequest>();
/** Each request's redirect count (so each step gets an id of its own), by protocol id. */
const redirects = new Map<string, number>();
/** Wall clock minus the protocol's monotonic clock, in ms, by page. */
const clockOffset = new Map<number, number>();
const changed = new Set<string>();
let frames: WebSocketFrame[] = [];
let framesDropped = 0;
let flushTimer: NodeJS.Timeout | null = null;
/** Host names Din's requests reached at each address, newest last. */
const hostsByIp = new Map<string, string>();
/** Reverse DNS answers (null for none), by address. */
const reverseNames = new Map<string, string | null>();
const reverseQueue: string[] = [];
let reverseRunning = 0;

/** The protocol's headers object, flattened to strings. */
function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value;
    else if (value !== undefined && value !== null) out[name] = String(value);
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rememberHost(ip: string, url: string): void {
  if (!ip) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!host || net.isIP(host.replace(/^\[|\]$/g, ''))) return;
  hostsByIp.delete(ip);
  hostsByIp.set(ip, host);
  if (hostsByIp.size > HOST_CACHE_LIMIT) hostsByIp.delete(hostsByIp.keys().next().value as string);
}

function sourceOf(contents: Electron.WebContents): RequestSource {
  const kind = contents === shell() ? 'desktop' : pageKind(contents);
  return {
    contentsId: contents.id,
    kind: kind === 'desktop' || kind === 'browser-tab' || kind === 'web-app' ? kind : 'page',
    url: contents.getURL(),
    title: contents.getTitle(),
  };
}

function touch(request: NetworkRequest): void {
  changed.add(request.id);
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function flush(): void {
  flushTimer = null;
  const batch: NetworkEvents = { requests: [], frames, framesDropped };
  for (const id of changed) {
    const request = requests.get(id);
    if (!request) continue;
    batch.requests.push({ ...request });
    // Done with: the shell has it now.
    if (request.state === 'done' || request.state === 'failed' || request.state === 'closed') requests.delete(id);
  }
  changed.clear();
  frames = [];
  framesDropped = 0;
  if (batch.requests.length > 0 || batch.frames.length > 0 || batch.framesDropped > 0) {
    sendToShell('network-monitor:events', batch);
  }
}

/** A protocol timestamp (monotonic seconds) as ms since the epoch. */
function wallTime(contentsId: number, timestamp: unknown): number {
  const t = num(timestamp);
  const offset = clockOffset.get(contentsId);
  return t !== null && offset !== undefined ? t * 1000 + offset : Date.now();
}

/** The current id of a request (its latest redirect step), by the protocol's id. */
function currentId(contentsId: number, requestId: string): string {
  const key = `${contentsId}:${requestId}`;
  const step = redirects.get(key);
  return step ? `${key}:${step}` : key;
}

function blankRequest(contents: Electron.WebContents, id: string, url: string, type: string): NetworkRequest {
  return {
    id,
    url,
    method: 'GET',
    type,
    state: 'pending',
    startedAt: Date.now(),
    endedAt: null,
    status: null,
    statusText: '',
    mimeType: '',
    protocol: '',
    remoteAddress: '',
    fromCache: false,
    size: 0,
    redirectedTo: null,
    error: null,
    initiator: '',
    requestHeaders: {},
    responseHeaders: {},
    framesSent: 0,
    framesReceived: 0,
    source: sourceOf(contents),
  };
}

/**
 * A page that's stopped loading has its documents: one still waiting to
 * finish lost its end to a navigation into another process. Its size is
 * what its headers said, if they did.
 */
function finishDocuments(contentsId: number): void {
  const now = Date.now();
  for (const request of requests.values()) {
    if (request.source.contentsId !== contentsId || request.type !== 'Document') continue;
    if (request.state !== 'pending' || request.status === null) continue;
    request.state = 'done';
    request.endedAt = now;
    if (request.size === 0) {
      const length = Object.entries(request.responseHeaders).find(([name]) => name.toLowerCase() === 'content-length');
      request.size = Number(length?.[1]) || 0;
    }
    touch(request);
  }
}

function onMessage(contents: Electron.WebContents, method: string, params: Record<string, unknown>): void {
  const cid = contents.id;
  const rid = str(params.requestId);
  switch (method) {
    case 'Network.requestWillBeSent': {
      const wall = num(params.wallTime);
      const ts = num(params.timestamp);
      if (wall !== null && ts !== null) clockOffset.set(cid, wall * 1000 - ts * 1000);
      const req = (params.request ?? {}) as Record<string, unknown>;
      const url = str(req.url);
      const key = `${cid}:${rid}`;
      const redirect = params.redirectResponse as Record<string, unknown> | undefined;
      if (redirect) {
        // The step before ends here, redirected; this one gets an id of its own.
        const before = requests.get(currentId(cid, rid));
        if (before) {
          before.state = 'done';
          before.endedAt = wallTime(cid, params.timestamp);
          before.status = num(redirect.status);
          before.statusText = str(redirect.statusText);
          before.responseHeaders = headerMap(redirect.headers);
          before.remoteAddress = addressOf(redirect);
          before.protocol = str(redirect.protocol);
          before.redirectedTo = url;
          before.size = Math.max(before.size, num(redirect.encodedDataLength) ?? 0);
          touch(before);
        }
        redirects.set(key, (redirects.get(key) ?? 0) + 1);
      }
      const initiator = (params.initiator ?? {}) as Record<string, unknown>;
      const stack = (initiator.stack as { callFrames?: { url?: string }[] } | undefined)?.callFrames?.[0]?.url;
      const request = blankRequest(contents, currentId(cid, rid), url, str(params.type) || 'Other');
      request.method = str(req.method) || 'GET';
      request.startedAt = wallTime(cid, params.timestamp);
      request.initiator = str(initiator.url) || stack || '';
      request.requestHeaders = headerMap(req.headers);
      requests.set(request.id, request);
      touch(request);
      return;
    }
    case 'Network.requestWillBeSentExtraInfo': {
      // The headers as sent, cookies included.
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.requestHeaders = { ...request.requestHeaders, ...headerMap(params.headers) };
      touch(request);
      return;
    }
    case 'Network.requestServedFromCache': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.fromCache = true;
      touch(request);
      return;
    }
    case 'Network.responseReceived': {
      const response = (params.response ?? {}) as Record<string, unknown>;
      let request = requests.get(currentId(cid, rid));
      if (!request) {
        // Its start went unseen (a navigation into another process loses the
        // new renderer's first events): it's begun from its response instead.
        const timing = response.timing as Record<string, unknown> | undefined;
        request = blankRequest(contents, currentId(cid, rid), str(response.url), str(params.type) || 'Other');
        request.startedAt = wallTime(cid, timing?.requestTime ?? params.timestamp);
        request.requestHeaders = headerMap(response.requestHeaders);
        requests.set(request.id, request);
      }
      request.status = num(response.status);
      request.statusText = str(response.statusText);
      request.mimeType = str(response.mimeType);
      request.protocol = str(response.protocol);
      request.remoteAddress = addressOf(response);
      request.fromCache ||= response.fromDiskCache === true || response.fromPrefetchCache === true;
      request.responseHeaders = { ...headerMap(response.headers), ...request.responseHeaders };
      if (params.type) request.type = str(params.type);
      rememberHost(str(response.remoteIPAddress), request.url);
      touch(request);
      return;
    }
    case 'Network.responseReceivedExtraInfo': {
      // The headers as they came, Set-Cookie included.
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.responseHeaders = { ...request.responseHeaders, ...headerMap(params.headers) };
      request.status ??= num(params.statusCode);
      touch(request);
      return;
    }
    case 'Network.dataReceived': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.size += num(params.encodedDataLength) ?? 0;
      touch(request);
      return;
    }
    case 'Network.loadingFinished': {
      const request = requests.get(currentId(cid, rid));
      redirects.delete(`${cid}:${rid}`);
      if (!request) return;
      request.state = 'done';
      request.endedAt = wallTime(cid, params.timestamp);
      request.size = Math.max(request.size, num(params.encodedDataLength) ?? 0);
      touch(request);
      return;
    }
    case 'Network.loadingFailed': {
      const request = requests.get(currentId(cid, rid));
      redirects.delete(`${cid}:${rid}`);
      if (!request) return;
      request.state = 'failed';
      request.endedAt = wallTime(cid, params.timestamp);
      request.error = params.canceled === true
        ? 'Canceled'
        : str(params.blockedReason)
          ? `Blocked (${str(params.blockedReason)})`
          : str(params.errorText) || 'Failed';
      touch(request);
      return;
    }
    case 'Network.webSocketCreated': {
      const url = str(params.url);
      const initiator = (params.initiator ?? {}) as Record<string, unknown>;
      const request = blankRequest(contents, currentId(cid, rid), url, 'WebSocket');
      request.protocol = 'websocket';
      request.initiator = str(initiator.url);
      requests.set(request.id, request);
      touch(request);
      return;
    }
    case 'Network.webSocketWillSendHandshakeRequest': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      const wall = num(params.wallTime);
      if (wall !== null) request.startedAt = wall * 1000;
      request.requestHeaders = headerMap((params.request as Record<string, unknown> | undefined)?.headers);
      touch(request);
      return;
    }
    case 'Network.webSocketHandshakeResponseReceived': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      const response = (params.response ?? {}) as Record<string, unknown>;
      request.status = num(response.status);
      request.statusText = str(response.statusText);
      request.responseHeaders = headerMap(response.headers);
      request.state = 'open';
      touch(request);
      return;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      const sent = method === 'Network.webSocketFrameSent';
      const response = (params.response ?? {}) as Record<string, unknown>;
      const opcode = num(response.opcode) ?? 1;
      const payload = str(response.payloadData);
      const length = opcode === 2 ? Math.floor((payload.length * 3) / 4) : Buffer.byteLength(payload);
      if (sent) request.framesSent += 1;
      else request.framesReceived += 1;
      request.size += length;
      touch(request);
      if (frames.length >= FRAMES_PER_FLUSH) {
        framesDropped += 1;
        return;
      }
      frames.push({
        requestId: request.id,
        at: wallTime(cid, params.timestamp),
        direction: sent ? 'sent' : 'received',
        opcode,
        data: payload.length > FRAME_PREVIEW ? payload.slice(0, FRAME_PREVIEW) : payload,
        length,
        truncated: payload.length > FRAME_PREVIEW,
      });
      return;
    }
    case 'Network.webSocketFrameError': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.error = str(params.errorMessage) || 'Error';
      touch(request);
      return;
    }
    case 'Network.webSocketClosed': {
      const request = requests.get(currentId(cid, rid));
      if (!request) return;
      request.state = request.state === 'pending' ? 'failed' : 'closed';
      if (request.state === 'failed') request.error ??= 'Couldn’t connect';
      request.endedAt = wallTime(cid, params.timestamp);
      touch(request);
      return;
    }
  }
}

function addressOf(response: Record<string, unknown>): string {
  const ip = str(response.remoteIPAddress);
  if (!ip) return '';
  const port = num(response.remotePort);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return port ? `${host}:${port}` : host;
}

/** Turn the Network domain on, unless DevTools' frontend has it. */
function enableNetwork(contents: Electron.WebContents): void {
  if (contents.isDestroyed() || holdsDebugger(contents, 'devtools')) return;
  void contents.debugger
    .sendCommand('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 256 * 1024 })
    .catch(() => {});
}

function eligible(contents: Electron.WebContents): boolean {
  if (contents.isDestroyed()) return false;
  // DevTools' own frontend pages are of the remote type.
  if (contents.getType() === 'remote' || contents.getURL().startsWith('devtools://')) return false;
  return !ignored(contents);
}

function track(contents: Electron.WebContents): void {
  if (!recording || tracked.has(contents.id) || !eligible(contents)) return;
  if (!holdDebugger(contents, HOLDER, () => enableNetwork(contents))) return;
  const listener = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string) => {
    // Child targets (workers attached by DevTools) speak for themselves.
    if (sessionId) return;
    if (method.startsWith('Network.')) onMessage(contents, method, params ?? {});
  };
  contents.debugger.on('message', listener);
  const stopped = () => finishDocuments(contents.id);
  contents.on('did-stop-loading', stopped);
  const id = contents.id;
  const gone = () => {
    tracked.delete(id);
    clockOffset.delete(id);
  };
  contents.once('destroyed', gone);
  tracked.set(id, {
    contents,
    detach: () => {
      contents.removeListener('destroyed', gone);
      contents.removeListener('did-stop-loading', stopped);
      if (contents.isDestroyed()) return;
      contents.debugger.removeListener('message', listener);
      if (!holdsDebugger(contents, 'devtools') && contents.debugger.isAttached()) {
        void contents.debugger.sendCommand('Network.disable').catch(() => {});
      }
      releaseDebugger(contents, HOLDER);
    },
  });
  enableNetwork(contents);
}

function onCreated(_event: Electron.Event, contents: Electron.WebContents): void {
  // Now, before it starts loading, so its first document is seen too.
  track(contents);
}

function start(): void {
  if (recording) return;
  recording = true;
  for (const contents of webContents.getAllWebContents()) track(contents);
  app.on('web-contents-created', onCreated);
}

function stop(): void {
  if (!recording) return;
  recording = false;
  app.removeListener('web-contents-created', onCreated);
  for (const { detach } of tracked.values()) detach();
  tracked.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flush();
  requests.clear();
  redirects.clear();
  clockOffset.clear();
  changed.clear();
  frames = [];
  framesDropped = 0;
}

/** A shell that reloads or goes away takes its subscriptions with it. */
const watchedShells = new WeakSet<Electron.WebContents>();
function watchShell(contents: Electron.WebContents): void {
  if (watchedShells.has(contents)) return;
  watchedShells.add(contents);
  const reset = () => {
    subscribers = 0;
    stop();
  };
  contents.on('did-navigate', reset);
  contents.on('render-process-gone', reset);
  contents.once('destroyed', reset);
}

// --- Connections ------------------------------------------------------------

/** Split "addr:port" (with [v6] or %iface) into its parts. */
export function splitEndpoint(text: string): { address: string; port: number } {
  const colon = text.lastIndexOf(':');
  let address = colon >= 0 ? text.slice(0, colon) : text;
  const port = colon >= 0 ? Number(text.slice(colon + 1)) || 0 : 0;
  address = address.replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '');
  // An IPv4 address in IPv6 clothes.
  if (address.startsWith('::ffff:') && net.isIPv4(address.slice(7))) address = address.slice(7);
  return { address, port };
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address === 'localhost';
}

/** A connection as `ss` has it, before it's named. */
export type SsConnection = Omit<Connection, 'remoteHost' | 'hostFrom' | 'otherHosts' | 'users'>;

/** A URL's host name, lowercased, or null for an address, loopback or none. */
function nameHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || net.isIP(host.replace(/^\[|\]$/g, ''))) return null;
  return host;
}

// --- What Din knows of its own connections ---------------------------------

/** The main process's own sockets: the host each was opened for, by local port. */
const mainSockets = new Map<number, string>();

diagnostics.subscribe('undici:client:connected', (message) => {
  const { connectParams, socket } = message as {
    connectParams?: { hostname?: string };
    socket?: net.Socket;
  };
  const host = connectParams?.hostname?.toLowerCase();
  const port = socket?.localPort;
  if (!host || !socket || !port) return;
  mainSockets.set(port, host);
  socket.once('close', () => {
    if (mainSockets.get(port) === host) mainSockets.delete(port);
  });
});

/** The hosts each page opened WebSockets to (connection-preload.cjs), by WebContents id. */
const pageSockets = new Map<number, { contents: Electron.WebContents; hosts: Set<string> }>();

function noteSocket(contents: Electron.WebContents, url: unknown): void {
  if (typeof url !== 'string' || url.length > 4096 || !eligible(contents)) return;
  const host = nameHost(url);
  if (!host) return;
  let entry = pageSockets.get(contents.id);
  if (!entry) {
    entry = { contents, hosts: new Set() };
    pageSockets.set(contents.id, entry);
    const id = contents.id;
    // A new document's sockets are its own; the last one's are closed.
    const navigated = () => pageSockets.get(id)?.hosts.clear();
    contents.on('did-navigate', navigated);
    contents.once('destroyed', () => pageSockets.delete(id));
  }
  if (entry.hosts.size < PAGE_HOST_LIMIT) entry.hosts.add(host);
}

/** Each host's addresses as its session resolves them, by session and host. */
const resolved = new WeakMap<Electron.Session, Map<string, { addresses: string[]; at: number; pending: boolean }>>();

/** A host's addresses, as of the last lookup; starts one when it's stale. */
function addressesOf(session: Electron.Session, host: string): string[] {
  let bySession = resolved.get(session);
  if (!bySession) {
    bySession = new Map();
    resolved.set(session, bySession);
  }
  let entry = bySession.get(host);
  if (!entry) {
    entry = { addresses: [], at: 0, pending: false };
    bySession.set(host, entry);
    if (bySession.size > HOST_CACHE_LIMIT) bySession.delete(bySession.keys().next().value as string);
  }
  const current = entry;
  if (!current.pending && Date.now() - current.at > RESOLVE_TTL_MS) {
    current.pending = true;
    session
      .resolveHost(host)
      .then(
        (result) => {
          current.addresses = result.endpoints.map((e) => splitEndpoint(`${e.address}:0`).address);
        },
        () => {
          current.addresses = [];
        },
      )
      .finally(() => {
        current.at = Date.now();
        current.pending = false;
      });
  }
  return current.addresses;
}

interface AddressUse {
  /** The names Din reached at the address, in the order seen. */
  hosts: Map<string, ConnectionUser[]>;
}

function addUse(index: Map<string, AddressUse>, address: string, host: string, user: ConnectionUser | null): void {
  let use = index.get(address);
  if (!use) {
    use = { hosts: new Map() };
    index.set(address, use);
  }
  let users = use.hosts.get(host);
  if (!users) {
    users = [];
    use.hosts.set(host, users);
  }
  if (user && !users.some((u) => u.kind === user.kind && u.url === user.url)) users.push(user);
}

function userOf(contents: Electron.WebContents): ConnectionUser {
  const { kind, url, title } = sourceOf(contents);
  return { kind, url, title };
}

/**
 * Every address Din's pages are connected to, as far as it knows: their
 * WebSockets' hosts and their own, resolved through their sessions.
 */
function pageAddresses(): Map<string, AddressUse> {
  const index = new Map<string, AddressUse>();
  const pages = new Map<number, { contents: Electron.WebContents; hosts: Set<string> }>();
  for (const contents of webContents.getAllWebContents()) {
    if (!eligible(contents)) continue;
    const hosts = new Set(pageSockets.get(contents.id)?.hosts ?? []);
    const own = /^(https?|wss?):/i.test(contents.getURL()) ? nameHost(contents.getURL()) : null;
    if (own) hosts.add(own);
    if (hosts.size > 0) pages.set(contents.id, { contents, hosts });
  }
  for (const { contents, hosts } of pages.values()) {
    const user = userOf(contents);
    for (const host of hosts) {
      for (const address of addressesOf(contents.session, host)) addUse(index, address, host, user);
    }
  }
  return index;
}

let backgroundSites: () => Map<string, string[]> = () => new Map();

/** The installed nsites whose background subscriptions are on a relay host. */
function backgroundUsers(host: string, sites: Map<string, string[]>): ConnectionUser[] {
  return (sites.get(host) ?? []).map((site) => ({ kind: 'background', url: `nsite://${site}/`, title: site }));
}

/** Din's own processes, whose connections it can say more about. */
function dinPids(): Set<number> {
  return new Set(app.getAppMetrics().map((m) => m.pid));
}

/** A connection named by what Din knows of it, else by recorded requests or reverse DNS. */
function nameConnection(
  c: SsConnection,
  pages: Map<string, AddressUse>,
  sites: Map<string, string[]>,
  din: Set<number>,
): Connection {
  const ours = c.pid !== null && din.has(c.pid);
  if (c.pid === process.pid) {
    const host = mainSockets.get(c.localPort);
    if (host) {
      return { ...c, remoteHost: host, hostFrom: 'din', otherHosts: [], users: backgroundUsers(host, sites) };
    }
  }
  const use = pages.get(c.remoteAddress);
  if (use) {
    // Busiest first: the likeliest of names sharing an address.
    const hosts = [...use.hosts].sort((a, b) => b[1].length - a[1].length);
    const users: ConnectionUser[] = [];
    if (ours && c.pid !== process.pid) {
      for (const [, list] of hosts) {
        for (const user of list) if (!users.some((u) => u.kind === user.kind && u.url === user.url)) users.push(user);
      }
    }
    return { ...c, remoteHost: hosts[0][0], hostFrom: 'din', otherHosts: hosts.slice(1).map(([h]) => h), users };
  }
  const known = hostsByIp.get(c.remoteAddress);
  if (known) return { ...c, remoteHost: known, hostFrom: 'din', otherHosts: [], users: [] };
  const reverse = reverseFor(c.remoteAddress);
  return { ...c, remoteHost: reverse, hostFrom: reverse ? 'reverse' : null, otherHosts: [], users: [] };
}

/**
 * Parse `ss -tuniHpeO state established`: one socket a line, Netid first, no
 * State column (the filter has it), then the queues, the two ends, and
 * key:value details, tcp_info's bytes among them.
 */
export function parseSs(text: string): SsConnection[] {
  const out: SsConnection[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const protocol = fields[0];
    if (protocol !== 'tcp' && protocol !== 'udp') continue;
    // A State column, when there is one, isn't a number.
    const at = /^\d+$/.test(fields[1]) ? 1 : 2;
    const local = splitEndpoint(fields[at + 2] ?? '');
    const remote = splitEndpoint(fields[at + 3] ?? '');
    if (!remote.address || remote.address === '*' || isLoopback(remote.address)) continue;
    const rest = fields.slice(at + 4).join(' ');
    const user = /\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(rest);
    const uid = /\buid:(\d+)/.exec(rest);
    const inode = /\bino:(\d+)/.exec(rest);
    const sent = /\bbytes_sent:(\d+)/.exec(rest);
    const received = /\bbytes_received:(\d+)/.exec(rest);
    out.push({
      protocol,
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      pid: user ? Number(user[2]) : null,
      program: user ? user[1] : null,
      uid: uid ? Number(uid[1]) : null,
      inode: inode ? Number(inode[1]) : 0,
      sent: sent ? Number(sent[1]) : protocol === 'tcp' ? 0 : null,
      received: received ? Number(received[1]) : protocol === 'tcp' ? 0 : null,
    });
  }
  return out;
}

function pumpReverse(): void {
  while (reverseRunning < REVERSE_CONCURRENCY && reverseQueue.length > 0) {
    const ip = reverseQueue.shift() as string;
    reverseRunning += 1;
    const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), REVERSE_TIMEOUT_MS));
    void Promise.race([dns.reverse(ip).catch(() => [] as string[]), timeout])
      .then((names) => {
        reverseNames.set(ip, names[0] ?? null);
        if (reverseNames.size > HOST_CACHE_LIMIT) reverseNames.delete(reverseNames.keys().next().value as string);
      })
      .finally(() => {
        reverseRunning -= 1;
        pumpReverse();
      });
  }
}

/** An address's reverse DNS name, once looked up. */
function reverseFor(ip: string): string | null {
  if (reverseNames.has(ip)) return reverseNames.get(ip) ?? null;
  if (!reverseQueue.includes(ip)) {
    reverseQueue.push(ip);
    pumpReverse();
  }
  return null;
}

async function readConnections(): Promise<ConnectionsResult> {
  let stdout: string;
  try {
    ({ stdout } = await runCommand('ss', ['-tuniHpeO', 'state', 'established'], {
      timeout: SS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    if (error instanceof CommandError && error.code === 'ENOENT') return { available: false, connections: [] };
    throw error;
  }
  const pages = pageAddresses();
  let sites = new Map<string, string[]>();
  try {
    sites = backgroundSites();
  } catch {
    // Named without them.
  }
  const din = dinPids();
  return {
    available: true,
    connections: parseSs(stdout).map((c) => nameConnection(c, pages, sites, din)),
  };
}

export function registerNetworkMonitorHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  shell: () => Electron.WebContents | null;
  pageKind: (contents: Electron.WebContents) => string;
  /** Pages never recorded: private and Tor tabs, DevTools. */
  ignore: (contents: Electron.WebContents) => boolean;
  /** The installed nsites with background subscriptions on each relay host. */
  backgroundSites?: () => Map<string, string[]>;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;
  shell = options.shell;
  pageKind = options.pageKind;
  ignored = options.ignore;
  if (options.backgroundSites) backgroundSites = options.backgroundSites;

  // From connection-preload.cjs, in any page: a WebSocket it opened. Only
  // ever a name for System Monitor; a page that lies about it misnames its
  // own connections.
  ipcMain.on('network-monitor:socket', (event, url: unknown) => noteSocket(event.sender, url));

  ipcMain.handle('network-monitor:record', (event) => {
    assertShellSender(event);
    watchShell(event.sender);
    subscribers += 1;
    start();
  });

  ipcMain.handle('network-monitor:stop', (event) => {
    assertShellSender(event);
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) stop();
  });

  ipcMain.handle('network-monitor:connections', (event) => {
    assertShellSender(event);
    return readConnections();
  });
}
