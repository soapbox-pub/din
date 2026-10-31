// The `din` command (electron/din-cli.mts) talks to this module over a Unix
// socket in $XDG_RUNTIME_DIR (din.sock, or din-<pid>.sock when another Din
// has that one; the Terminal's shells get $DIN_SOCKET either way). One
// connection is one request: a JSON line, then lines back.
//
// - `{ command: argv, cwd, session? }`, or `{ path, input, cwd }`: one of the
//   desktop's commands (src/lib/commands/), which runs it and answers once
//   (runCommand), after `progress` lines if it's a long one.
// - `din apps run`: a web app from a folder (a build's dist/) or from a dev
//   server, run as a Din app at din://<origin>/ with window.din like a
//   built-in app's. Lines back: opened, the window's console, closed. The
//   window closes when the connection does, unless the command detached.
// - `din widgets add-folder` sends `{ widget: { dir, size } }`, and hears
//   whether the folder's widget was added to the desktop (offerWidget).
//
// Origins: a random din://tmp-<id>/ by default, whose storage is cleared
// once its last window closes, or one the command names, which keeps its
// storage. Never a built-in app's id. What the app may do beyond a web page
// is the desktop's call (LaunchedAppFrame asks before granting a manifest's
// permissions); here, files are served only from inside the folder named,
// which may not hold Din's own profile.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, net as electronNet } from 'electron';
import { appIdOf, appsSession, isBuiltInApp, isFileAppId, DIN_SCHEME } from './din-apps.mts';

/** Where an app's files come from. */
export type Source = { kind: 'dir'; root: string } | { kind: 'url'; origin: string };

interface Running {
  source: Source;
  /** Its storage goes when its last window does. */
  ephemeral: boolean;
  /** Launches still waiting on the desktop or holding a window. */
  launches: Set<string>;
  /** Whether it ever had a window: until the desktop releases it, it may still. */
  shown: boolean;
}

interface Launch {
  id: string;
  host: string;
  socket: net.Socket | null;
  detach: boolean;
  opened: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface LaunchArgs {
  dir?: unknown;
  url?: unknown;
  origin?: unknown;
  paths?: unknown;
  detach?: unknown;
}

/** What the desktop gets to open a launch's window with (src/lib/launchedApps.ts). */
export interface LaunchRequest {
  launchId: string;
  appId: string;
  /** The app's manifest as found, untrusted: the desktop keeps what it allows. Icons are data URLs. */
  manifest: unknown;
  /** The folder or server it runs from, to show. */
  source: string;
  ephemeral: boolean;
  /** Files named on the command line. */
  paths: string[];
}

const ORIGIN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_REQUEST = 64 * 1024;
const MAX_PATHS = 256;
const MAX_MANIFEST = 256 * 1024;
const MAX_ICON = 1024 * 1024;
/** How long the desktop has to take a launch (it isn't there before sign-in). */
const OPEN_TIMEOUT_MS = 15_000;

const running = new Map<string, Running>();
const launches = new Map<string, Launch>();

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  hasShell: () => boolean;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  /** Folders no app may be served from, or from a folder holding them. */
  protectedPaths: () => string[];
}

let options: Options | null = null;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

/** The file a URL path names in a folder: inside it, symlinks and all. A folder means its index.html. */
function fileIn(root: string, pathname: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(root, `.${pathname}`));
    if (!inside(root, real)) return null;
    if (fs.statSync(real).isDirectory()) real = path.join(real, 'index.html');
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function serveFrom(source: Source, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const accept = request.headers.get('accept');
  if (source.kind === 'url') {
    return electronNet
      .fetch(new URL(url.pathname + url.search, source.origin).toString(), { headers: accept ? { accept } : {} })
      .catch((error: unknown) => new Response(`${source.origin}: ${String(error)}`, { status: 502, headers: { 'content-type': 'text/plain' } }));
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return Promise.resolve(notFound());
  }
  // A page of a client-side router: the app's own page answers it.
  const page = accept?.includes('text/html') && !path.extname(pathname) ? fileIn(source.root, '/') : null;
  const file = fileIn(source.root, pathname) ?? page;
  return file ? electronNet.fetch(pathToFileURL(file).toString()) : Promise.resolve(notFound());
}

/** Serve a launched app's files, from din-apps' din:// handler; null when the id isn't a launched app. */
export function serveLaunched(appId: string, request: Request): Promise<Response> | null {
  const entry = running.get(appId);
  return entry ? serveFrom(entry.source, request) : null;
}

/** A file of the app, by URL path, as the app would load it. */
async function read(source: Source, host: string, pathname: string, max: number): Promise<{ bytes: Buffer; type: string } | null> {
  const response = await serveFrom(source, new Request(`${DIN_SCHEME}://${host}${pathname}`)).catch(() => null);
  if (!response?.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > max) return null;
  return { bytes, type: response.headers.get('content-type') ?? '' };
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
};

/** The app's manifest, as its page links it (a build hashes the name), with its best icon inlined. */
export async function findManifest(source: Source, host: string): Promise<Record<string, unknown>> {
  const page = await read(source, host, '/', MAX_REQUEST * 16);
  const html = page?.bytes.toString('utf8') ?? '';
  const link = /<link\b[^>]*\brel=["']?manifest\b[^>]*>/i.exec(html)?.[0];
  const href = link ? /\bhref=["']?([^"'\s>]+)/i.exec(link)?.[1] : undefined;
  const base = `${DIN_SCHEME}://${host}/`;
  const candidates = href ? [href] : ['/manifest.webmanifest', '/manifest.json'];
  for (const candidate of candidates) {
    let manifestUrl: URL;
    try {
      manifestUrl = new URL(candidate, base);
    } catch {
      continue;
    }
    if (manifestUrl.host !== host) continue;
    const file = await read(source, host, manifestUrl.pathname, MAX_MANIFEST);
    if (!file) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(file.bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) continue;
    const parsed = manifest as Record<string, unknown>;
    const icon = await inlineIcon(source, host, parsed.icons, manifestUrl);
    return { ...parsed, icons: icon ? [{ src: icon }] : [] };
  }
  return { icons: [] };
}

/** The manifest's largest square icon as a data URL (the desktop can't load din://). */
async function inlineIcon(source: Source, host: string, icons: unknown, manifestUrl: URL): Promise<string | null> {
  if (!Array.isArray(icons)) return null;
  const size = (sizes: unknown) =>
    typeof sizes === 'string' ? Math.max(0, ...sizes.split(' ').map((s) => Number.parseInt(s, 10) || 0)) : 0;
  const square = (sizes: unknown) => typeof sizes !== 'string' || sizes.split(' ').some((s) => /^(\d+)x\1$/.test(s) || s === 'any');
  const ranked = icons
    .filter((i): i is { src: string; sizes?: unknown } => typeof i === 'object' && i !== null && typeof (i as { src?: unknown }).src === 'string')
    .sort((a, b) => Number(square(b.sizes)) - Number(square(a.sizes)) || size(b.sizes) - size(a.sizes));
  for (const icon of ranked) {
    let url: URL;
    try {
      url = new URL(icon.src, manifestUrl);
    } catch {
      continue;
    }
    if (url.host !== host) continue;
    const file = await read(source, host, url.pathname, MAX_ICON);
    if (!file) continue;
    const guessed = IMAGE_TYPES[path.extname(url.pathname).slice(1).toLowerCase()];
    const type = /^image\/[a-z0-9.+-]+$/i.test(file.type.split(';')[0].trim()) ? file.type.split(';')[0].trim() : guessed;
    if (type) return `data:${type};base64,${file.bytes.toString('base64')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Launches
// ---------------------------------------------------------------------------

function send(launch: Launch, message: Record<string, unknown>): void {
  if (launch.socket && !launch.socket.destroyed) launch.socket.write(`${JSON.stringify(message)}\n`);
}

function hangUp(launch: Launch): void {
  const socket = launch.socket;
  launch.socket = null;
  socket?.end();
}

/** Forget a launch, and hang up on its command. */
function dropLaunch(launch: Launch): void {
  if (launch.timer) clearTimeout(launch.timer);
  launches.delete(launch.id);
  running.get(launch.host)?.launches.delete(launch.id);
  hangUp(launch);
}

/** A launch that never got its window: the app goes too if nothing else showed it. */
function abandon(launch: Launch, message: string): void {
  send(launch, { type: 'error', message });
  dropLaunch(launch);
  const entry = running.get(launch.host);
  if (entry && !entry.shown && entry.launches.size === 0) running.delete(launch.host);
}

/** The app's last window closed: its origin is free again, and an ephemeral one forgets everything. */
function release(host: string): void {
  const entry = running.get(host);
  if (!entry || [...entry.launches].some((id) => launches.get(id)?.opened === false)) return;
  running.delete(host);
  if (entry.ephemeral) {
    void appsSession().clearStorageData({ origin: `${DIN_SCHEME}://${host}` }).catch((error: unknown) => {
      console.error(`din-launch: clearing din://${host}:`, error);
    });
  }
}

function sameSource(a: Source, b: Source): boolean {
  return a.kind === 'dir' ? b.kind === 'dir' && a.root === b.root : b.kind === 'url' && a.origin === b.origin;
}

function describe(source: Source): string {
  return source.kind === 'dir' ? source.root : source.origin;
}

/**
 * A folder an app may be served from, with its symlinks resolved: one with
 * an index.html, not holding Din's own profile nor inside it. Throws why not.
 */
export function appFolder(dir: string, protectedPaths: string[]): string {
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    throw new Error(`No such folder: ${dir}`);
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(`No index.html in ${root}`);
  for (const p of protectedPaths) {
    const guarded = (() => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    })();
    if (inside(root, guarded) || inside(guarded, root)) throw new Error(`${root} holds Din's own profile; serve a folder of just the app`);
  }
  return root;
}

/** Check a request and work out the app's source and origin; throws what to tell the command. */
function parse(request: LaunchArgs): { source: Source; host: string; ephemeral: boolean; paths: string[]; detach: boolean } {
  let source: Source;
  if (typeof request.url === 'string') {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new Error(`Not a URL: ${request.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--url takes an http or https URL');
    source = { kind: 'url', origin: url.origin };
  } else if (typeof request.dir === 'string' && path.isAbsolute(request.dir)) {
    source = { kind: 'dir', root: appFolder(request.dir, options?.protectedPaths() ?? []) };
  } else {
    throw new Error('Name a folder, or a dev server with --url');
  }

  let host: string;
  let ephemeral: boolean;
  if (request.origin !== undefined && request.origin !== null) {
    if (typeof request.origin !== 'string' || !ORIGIN.test(request.origin)) {
      throw new Error('--origin takes lowercase letters, digits and dashes (up to 63), starting with a letter or digit');
    }
    if (isFileAppId(request.origin)) throw new Error(`din://${request.origin} is reserved for apps from folders`);
    if (isBuiltInApp(request.origin)) throw new Error(`din://${request.origin} is a built-in app's`);
    const existing = running.get(request.origin);
    if (existing && !sameSource(existing.source, source)) {
      throw new Error(`din://${request.origin} is already running from ${describe(existing.source)}`);
    }
    if (existing?.ephemeral) throw new Error(`din://${request.origin} is in use`);
    host = request.origin;
    ephemeral = false;
  } else {
    do {
      host = `tmp-${randomBytes(6).toString('hex')}`;
    } while (running.has(host));
    ephemeral = true;
  }

  const paths = Array.isArray(request.paths)
    ? request.paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(0, MAX_PATHS)
    : [];
  return { source, host, ephemeral, paths, detach: request.detach === true };
}

async function start(socket: net.Socket, request: LaunchArgs): Promise<void> {
  const opts = options;
  if (!opts) return;
  const say = (message: Record<string, unknown>) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(request);
  } catch (error) {
    say({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    socket.end();
    return;
  }
  if (!opts.hasShell()) {
    say({ type: 'error', message: 'Din’s desktop isn’t running' });
    socket.end();
    return;
  }
  const { source, host, ephemeral, paths, detach } = parsed;
  let entry = running.get(host);
  if (!entry) {
    entry = { source, ephemeral, launches: new Set(), shown: false };
    running.set(host, entry);
  }
  const launch: Launch = { id: randomUUID(), host, socket, detach, opened: false, timer: null };
  launches.set(launch.id, launch);
  entry.launches.add(launch.id);
  socket.on('close', () => {
    if (launch.socket !== socket) return;
    launch.socket = null;
    if (launch.detach || !launches.has(launch.id)) return;
    // Gone before the desktop was asked: nothing to close.
    if (!launch.opened && !launch.timer) abandon(launch, '');
    // Ctrl-C (or the command killed): its window goes with it.
    else opts.sendToShell('dinos-launch:close', launch.id);
  });

  const manifest = await findManifest(source, host);
  if (!launches.has(launch.id)) return;
  launch.timer = setTimeout(() => abandon(launch, 'Din’s desktop didn’t answer (is someone signed in?)'), OPEN_TIMEOUT_MS);
  const payload: LaunchRequest = { launchId: launch.id, appId: host, manifest, source: describe(source), ephemeral, paths };
  opts.sendToShell('dinos-launch:open', payload);
}

/** The desktop's answer to a launch: its window is open, or why not. */
function opened(launchId: unknown, error: unknown): void {
  const launch = typeof launchId === 'string' ? launches.get(launchId) : undefined;
  if (!launch || launch.opened) return;
  if (launch.timer) clearTimeout(launch.timer);
  launch.timer = null;
  if (typeof error === 'string' && error) {
    abandon(launch, error);
    return;
  }
  launch.opened = true;
  const entry = running.get(launch.host);
  if (entry) entry.shown = true;
  send(launch, {
    type: 'opened',
    url: `${DIN_SCHEME}://${launch.host}/`,
    source: entry ? describe(entry.source) : '',
    ephemeral: entry?.ephemeral ?? true,
  });
  if (launch.detach) hangUp(launch);
}

/** The launch's window closed. */
function ended(launchId: unknown): void {
  const launch = typeof launchId === 'string' ? launches.get(launchId) : undefined;
  if (!launch) return;
  send(launch, { type: 'closed' });
  dropLaunch(launch);
}

/** A launched app's window's console, and its crashes, go to the commands that launched it. */
export function attachLaunchedGuest(contents: Electron.WebContents, src: string): void {
  const host = appIdOf(src);
  if (!host || !running.has(host)) return;
  const tell = (message: Record<string, unknown>) => {
    for (const id of running.get(host)?.launches ?? []) {
      const launch = launches.get(id);
      if (launch) send(launch, message);
    }
  };
  contents.on('console-message', (event) => {
    tell({ type: 'console', level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber });
  });
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) tell({ type: 'console', level: 'error', message: `${url}: ${description} (${code})`, source: '', line: 0 });
  });
  contents.on('render-process-gone', (_event, details) => {
    tell({ type: 'console', level: 'error', message: `The window's process ended (${details.reason})`, source: '', line: 0 });
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** What the desktop gets to offer a folder's widget with (src/components/desktop/widgets/WidgetOffers.tsx). */
export interface WidgetOffer {
  offerId: string;
  /** The folder, real and absolute. */
  path: string;
  size?: 'small' | 'medium' | 'large';
}

/** `din widgets add-folder`s waiting on the desktop, by offer id. */
const offers = new Map<string, { socket: net.Socket; timer: ReturnType<typeof setTimeout> | null }>();

/**
 * `din widgets add-folder <folder>`: put a folder's widget on the desktop. The desktop
 * shows it on the widget's permission screen, as Add Widgets does, unless
 * it asks for nothing; the command hears when it's added, or why not.
 */
function offerWidget(socket: net.Socket, raw: unknown): void {
  const opts = options;
  if (!opts) return;
  const fail = (message: string): void => {
    socket.end(`${JSON.stringify({ type: 'error', message })}\n`);
  };
  const args = (typeof raw === 'object' && raw !== null ? raw : {}) as { dir?: unknown; size?: unknown };
  if (typeof args.dir !== 'string' || !path.isAbsolute(args.dir)) return fail('Name a folder');
  let dir: string;
  try {
    dir = appFolder(args.dir, opts.protectedPaths());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (args.size !== undefined && args.size !== null && !['small', 'medium', 'large'].includes(String(args.size))) {
    return fail('--size takes small, medium or large');
  }
  if (!opts.hasShell()) return fail('Din’s desktop isn’t running');

  const offerId = randomUUID();
  const offer = {
    socket,
    timer: setTimeout(() => answerOffer(offerId, 'failed', 'Din’s desktop didn’t answer (is someone signed in?)'), OPEN_TIMEOUT_MS) as ReturnType<typeof setTimeout> | null,
  };
  offers.set(offerId, offer);
  socket.on('close', () => {
    if (!offers.has(offerId)) return;
    // Ctrl-C: the permission screen goes too.
    if (offer.timer) clearTimeout(offer.timer);
    offers.delete(offerId);
    opts.sendToShell('dinos-launch:widget-cancel', offerId);
  });
  const payload: WidgetOffer = { offerId, path: dir, ...(args.size ? { size: args.size as WidgetOffer['size'] } : {}) };
  opts.sendToShell('dinos-launch:widget', payload);
}

/** The desktop on an offer: asking the user, added, or not (and why). */
function answerOffer(offerId: unknown, state: unknown, message: unknown): void {
  const offer = typeof offerId === 'string' ? offers.get(offerId) : undefined;
  if (!offer) return;
  if (offer.timer) clearTimeout(offer.timer);
  offer.timer = null;
  const say = (line: Record<string, unknown>) => {
    if (!offer.socket.destroyed) offer.socket.write(`${JSON.stringify(line)}\n`);
  };
  if (state === 'asking') {
    say({ type: 'asking' });
    return;
  }
  offers.delete(offerId as string);
  say(state === 'added' ? { type: 'added' } : { type: 'error', message: typeof message === 'string' && message ? message : 'It wasn’t added' });
  offer.socket.end();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** What the desktop gets to run a command with (src/components/desktop/CommandHost.tsx). */
export interface CommandRequest {
  id: string;
  /** A command line, `din` itself left off. */
  argv?: string[];
  /** Or a command by its path, with structured arguments (the Assistant's tools). */
  path?: string[];
  input?: Record<string, unknown>;
  /** Where it was run, for relative paths. */
  cwd: string;
  /** The Assistant conversation that ran it ($OPENCODE_SESSION_ID), its word. */
  session?: string;
}

const MAX_ARGV = 1024;

/** Commands waiting on the desktop, by id. */
const commands = new Map<string, { socket: net.Socket; timer: ReturnType<typeof setTimeout> | null }>();

/**
 * `din <area> <command> …`: run in the desktop, whose answer goes back as
 * one line. It may take its time (a confirmation on screen, a build), so the
 * desktop says when it has the command and only that is timed.
 */
function runCommand(socket: net.Socket, raw: Record<string, unknown>): void {
  const opts = options;
  if (!opts) return;
  const fail = (message: string, usage = false): void => {
    socket.end(`${JSON.stringify({ type: 'answer', ok: false, error: message, usage })}\n`);
  };
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length <= MAX_ARGV && value.every((v) => typeof v === 'string');
  const request: CommandRequest = { id: randomUUID(), cwd: typeof raw.cwd === 'string' ? raw.cwd : '' };
  if (typeof raw.session === 'string') request.session = raw.session;
  if (strings(raw.command)) request.argv = raw.command;
  else if (strings(raw.path) && typeof raw.input === 'object' && raw.input !== null && !Array.isArray(raw.input)) {
    request.path = raw.path;
    request.input = raw.input as Record<string, unknown>;
  } else return fail('Bad request', true);
  if (!opts.hasShell()) return fail('Din’s desktop isn’t running');

  const pending = {
    socket,
    timer: setTimeout(() => answerCommand(request.id, { ok: false, error: 'Din’s desktop didn’t answer (is someone signed in?)', usage: false }), OPEN_TIMEOUT_MS) as ReturnType<typeof setTimeout> | null,
  };
  commands.set(request.id, pending);
  socket.on('close', () => {
    const waiting = commands.get(request.id);
    if (waiting?.timer) clearTimeout(waiting.timer);
    commands.delete(request.id);
  });
  opts.sendToShell('dinos-command:run', request);
}

/** The desktop has the command: from here it takes as long as it takes. */
function commandTaken(id: unknown): void {
  const pending = typeof id === 'string' ? commands.get(id) : undefined;
  if (pending?.timer) clearTimeout(pending.timer);
  if (pending) pending.timer = null;
}

/** How a command still running is getting on, as a line before its answer. */
function commandProgress(id: unknown, update: unknown): void {
  const pending = typeof id === 'string' ? commands.get(id) : undefined;
  if (!pending || pending.socket.destroyed || typeof update !== 'object' || update === null) return;
  const { text, percent } = update as { text?: unknown; percent?: unknown };
  if (typeof text !== 'string') return;
  const line: Record<string, unknown> = { type: 'progress', text: text.slice(0, 200) };
  if (typeof percent === 'number' && Number.isFinite(percent)) line.percent = Math.max(0, Math.min(100, Math.round(percent)));
  pending.socket.write(`${JSON.stringify(line)}\n`);
}

function answerCommand(id: unknown, answer: unknown): void {
  const pending = typeof id === 'string' ? commands.get(id) : undefined;
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  commands.delete(id as string);
  const line = typeof answer === 'object' && answer !== null ? answer : { ok: false, error: 'No answer', usage: false };
  if (!pending.socket.destroyed) pending.socket.end(`${JSON.stringify({ type: 'answer', ...line })}\n`);
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

/** Whether something answers on a socket path. */
function answers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function accept(socket: net.Socket): void {
  let buffer = '';
  let started = false;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk: string) => {
    if (started) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > MAX_REQUEST) socket.destroy();
      return;
    }
    started = true;
    let request: unknown;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      request = null;
    }
    if (typeof request !== 'object' || request === null) {
      socket.end(`${JSON.stringify({ type: 'error', message: 'Bad request' })}\n`);
      return;
    }
    const fields = request as { widget?: unknown; command?: unknown; path?: unknown };
    if (fields.widget !== undefined) offerWidget(socket, fields.widget);
    else if (fields.command !== undefined || fields.path !== undefined) runCommand(socket, request as Record<string, unknown>);
    else void start(socket, request as LaunchArgs);
  });
}

/**
 * Where the command finds Din: a socket in the runtime folder, or on
 * Windows a named pipe of the user's (untested there). The client
 * (din-cli.mts) looks in the same places.
 */
function socketPaths(): { shared: string; own: string } {
  if (process.platform === 'win32') {
    const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
    return { shared: `\\\\.\\pipe\\din-${user}`, own: `\\\\.\\pipe\\din-${user}-${process.pid}` };
  }
  const dir = process.env.XDG_RUNTIME_DIR || app.getPath('userData');
  return { shared: path.join(dir, 'din.sock'), own: path.join(dir, `din-${process.pid}.sock`) };
}

async function listen(): Promise<void> {
  const { shared, own } = socketPaths();
  const pipe = process.platform === 'win32';
  // Another Din (a dev build nested in DinOS) keeps the shared name.
  const file = (await answers(shared)) ? own : shared;
  if (!pipe) fs.rmSync(file, { force: true });
  const server = net.createServer(accept);
  server.on('error', (error) => console.error('din-launch:', error));
  server.listen(file, () => {
    if (!pipe) fs.chmodSync(file, 0o600);
    // For the Terminal's shells and the apps Din starts (native-apps.mts).
    process.env.DIN_SOCKET = file;
  });
  app.on('will-quit', () => {
    server.close();
    if (!pipe) fs.rmSync(file, { force: true });
  });
}

/** Take launches from the `din` command. Call once the app is ready. */
export function registerDinLaunch(opts: Options): void {
  options = opts;
  ipcMain.handle('dinos-launch:opened', (event, launchId, error) => {
    opts.assertShellSender(event);
    opened(launchId, error);
  });
  ipcMain.handle('dinos-launch:ended', (event, launchId) => {
    opts.assertShellSender(event);
    ended(launchId);
  });
  ipcMain.handle('dinos-launch:release', (event, appId) => {
    opts.assertShellSender(event);
    if (typeof appId === 'string') release(appId);
  });
  ipcMain.handle('dinos-launch:widget-answer', (event, offerId, state, message) => {
    opts.assertShellSender(event);
    answerOffer(offerId, state, message);
  });
  ipcMain.handle('dinos-command:taken', (event, id) => {
    opts.assertShellSender(event);
    commandTaken(id);
  });
  ipcMain.handle('dinos-command:progress', (event, id, update) => {
    opts.assertShellSender(event);
    commandProgress(id, update);
  });
  ipcMain.handle('dinos-command:answer', (event, id, answer) => {
    opts.assertShellSender(event);
    answerCommand(id, answer);
  });
  void listen().catch((error: unknown) => console.error('din-launch: listening:', error));
}
