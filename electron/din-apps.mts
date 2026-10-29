// Built-in apps at din://<id>/ (docs/README.md, docs/security-model.md).
//
// Each app window is a <webview> in its own session (persist:din-apps), at an
// origin of its own, in a process of its own. This module serves the apps'
// files on that session, makes the ports that connect each app to the
// desktop (and, for apps granted fs or pty, straight to main), and
// keeps app guests pinned to their own origin.
// (Printing is a desktop service, din.print, since its dialog is the desktop's.)
//
// Trust: an app's preload may ask for its desktop port, and gets one only
// from a main frame in a webview the shell hosts, in this session; the app id
// is the host of the frame's origin, never anything the app says. System
// ports (fs, pty) are made only when the shell asks (dinos.apps.grant), bound to one
// app and one permission, and every call on them is checked against both.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ipcMain, MessageChannelMain, net, session, webContents } from 'electron';
import { LOCAL_FILE_SCHEME, serveLocalFile } from './files.mts';
import { invokeHandlers, sendHandlers } from './ipc-registry.mts';
import { ptyRoutes } from './pty-routes.mts';
import type { MessagePortMain } from 'electron';

export const DIN_SCHEME = 'din';
export const DIN_APPS_PARTITION = 'persist:din-apps';

/** What a din:// app's id may look like: the host of its origin. */
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The permissions whose bridges get a port straight to main, and the IPC channels each reaches. */
const SYSTEM_PERMISSIONS = {
  fs: /^fs:[a-zA-Z]+$/,
  pty: /^pty:(spawn|write|resize|kill|release|adopt)$/,
  assistant: /^assistant:(status|setEnabled|install|restart|recentModels|request)$/,
  indd: /^indd:convert$/,
  volumes: /^volumes:(state|mount|eject)$/,
} as const;
export type SystemPermission = keyof typeof SYSTEM_PERMISSIONS;

/** Events main pushes to the shell on a bridge's channels, which granted apps hear too. */
const SYSTEM_PUSHES: Record<SystemPermission, RegExp | null> = {
  fs: /^fs:changed$/,
  // A pty's output goes to the sender that spawned it.
  pty: null,
  assistant: /^assistant:(status|event)$/,
  indd: null,
  volumes: /^volumes:(changed|event)$/,
};

/**
 * Events made here for calls arriving on a granted bridge port. The shell's
 * sender check accepts them (isBridgeEvent), which is safe because only
 * channels the port's permission covers are ever dispatched with one.
 */
const bridgeEvents = new WeakSet<object>();

/** Whether an IPC event stands for a call on a granted bridge port. */
export function isBridgeEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && bridgeEvents.has(event);
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

/** The apps' session. */
export function appsSession(): Electron.Session {
  return session.fromPartition(DIN_APPS_PARTITION);
}

/** The app id of a din:// URL or origin, or null. Compares scheme and host, never `URL.origin` ('null' for custom schemes). */
export function appIdOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${DIN_SCHEME}:`) return null;
    return APP_ID.test(parsed.hostname) ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** Whether a WebContents is a built-in app's window. */
export function isAppGuest(contents: Electron.WebContents | null | undefined): boolean {
  return !!contents && !contents.isDestroyed() && contents.getType() === 'webview' && contents.session === appsSession();
}

interface Options {
  /** The built web app (dist/): apps are under src/apps/<id>/ in it. */
  distDir: string;
  /** The Vite dev server, in development: app files are fetched from it. */
  devUrl: string | undefined;
  /** The shell's WebContents, if it's up. */
  shell: () => Electron.WebContents | null;
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  isShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;
  /** Paths no granted fs bridge may touch (Din's own profile, with the desktop's storage). */
  protectedPaths: () => string[];
}

let options: Options | null = null;

/** Serve the apps, and answer their preloads and the shell. Call once the app is ready. */
export function registerDinApps(opts: Options, preloadPath: string): void {
  options = opts;
  const s = appsSession();
  s.protocol.handle(DIN_SCHEME, (request) => serve(request));
  s.protocol.handle(LOCAL_FILE_SCHEME, (request) => serveFileUrl(request));
  s.registerPreloadScript({ id: 'din-app', type: 'frame', filePath: preloadPath });
  // Apps get what a document app needs and nothing that would prompt.
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
  s.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  s.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));

  // An app's preload asking for its port to the desktop.
  ipcMain.on('din-app:connect', (event) => {
    const contents = event.sender;
    const frame = event.senderFrame;
    const shell = opts.shell();
    if (!frame || frame !== contents.mainFrame || !isAppGuest(contents) || !shell) return;
    if (contents.hostWebContents !== shell) return;
    const appId = appIdOf(frame.origin);
    if (!appId) return;
    // A reload reconnects: the old document's grants go with it.
    revokeAll(contents.id);
    const { port1, port2 } = new MessageChannelMain();
    shell.postMessage('dinos-apps:port', { webContentsId: contents.id, appId }, [port1]);
    frame.postMessage('din-app:port', null, [port2]);
  });

  ipcMain.handle('dinos-apps:grant', (event, wcId, permission, roots) => {
    opts.assertShellSender(event);
    if (typeof permission !== 'string' || !(permission in SYSTEM_PERMISSIONS)) throw new Error('Unknown permission');
    const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
    if (!contents || !isAppGuest(contents) || contents.hostWebContents !== opts.shell()) throw new Error('Not an app');
    // fs, scoped: only under these folders (and those added later).
    const scope = permission === 'fs' && Array.isArray(roots)
      ? new Set(roots.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r)).map(realish))
      : null;
    grant(contents, permission as SystemPermission, scope);
    // An app with fs reaches files by path anyway: it gets a URL base to
    // load any of them from (din-file://<token>/<absolute path>), so a
    // folder of thumbnails costs no round trip each.
    if (permission === 'fs') {
      const token = randomUUID();
      const appId = appIdOf(contents.getURL());
      if (appId) fsUrlBases.set(token, { wcId: contents.id, appId });
      return `${LOCAL_FILE_SCHEME}://${token}`;
    }
    return null;
  });

  ipcMain.handle('dinos-apps:revoke', (event, wcId, permission) => {
    opts.assertShellSender(event);
    if (typeof wcId === 'number' && typeof permission === 'string') revoke(wcId, permission as SystemPermission);
  });

  // Another folder a scoped fs grant reaches (the folder of a file the user
  // handed the app, for apps with file-folders).
  ipcMain.handle('dinos-apps:addFsRoot', (event, wcId, root) => {
    opts.assertShellSender(event);
    const entry = typeof wcId === 'number' ? grants.get(wcId)?.get('fs') : undefined;
    if (!entry?.roots || typeof root !== 'string' || !path.isAbsolute(root)) return;
    entry.roots.add(realish(root));
  });

  // A URL an app can load a file it was granted from (media, big pictures),
  // streamed with Range support instead of sent whole over its port.
  ipcMain.handle('dinos-apps:fileUrl', (event, wcId, file) => {
    opts.assertShellSender(event);
    const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
    if (!contents || !isAppGuest(contents) || typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('No such file');
    const appId = appIdOf(contents.getURL());
    if (!appId) throw new Error('Not an app');
    const token = randomUUID();
    fileUrls.set(token, { file: path.resolve(file), wcId: contents.id, appId });
    return `${LOCAL_FILE_SCHEME}://${token}/${encodeURIComponent(path.basename(file))}`;
  });

  // Force quit: SIGKILL reaches a renderer stuck in a loop at once, where
  // forcefullyCrashRenderer() waits on it for seconds.
  ipcMain.handle('dinos-apps:kill', (event, wcId) => {
    opts.assertShellSender(event);
    const contents = typeof wcId === 'number' ? webContents.fromId(wcId) : undefined;
    if (!contents || !isAppGuest(contents)) return;
    const pid = contents.getOSProcessId();
    try {
      if (pid > 0) process.kill(pid, 'SIGKILL');
      else contents.forcefullyCrashRenderer();
    } catch {
      contents.forcefullyCrashRenderer();
    }
  });
}

/** Per-guest policy, from main's web-contents-created. */
export function attachAppGuest(contents: Electron.WebContents, src: string, send: (channel: string, payload: unknown) => void): void {
  const appId = appIdOf(src);
  const home = (url: string) => appId !== null && appIdOf(url) === appId;
  // Pinned to its own origin: scheme and host, top frame and subframes.
  contents.on('will-frame-navigate', (event) => {
    if (home(event.url)) return;
    event.preventDefault();
    if (event.isMainFrame && /^(https?|nsite):\/\//i.test(event.url)) send('crx:openTab', { url: event.url });
  });
  contents.on('will-redirect', (event) => {
    if (!home(event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|nsite):\/\//i.test(url)) send('crx:openTab', { url });
    return { action: 'deny' };
  });
  contents.on('unresponsive', () => send('dinos-apps:responsive', { webContentsId: contents.id, responsive: false }));
  contents.on('responsive', () => send('dinos-apps:responsive', { webContentsId: contents.id, responsive: true }));
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) revokeAll(contents.id);
  });
  const id = contents.id;
  contents.once('destroyed', () => revokeAll(id));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

async function serve(request: Request): Promise<Response> {
  const opts = options;
  const url = new URL(request.url);
  const appId = appIdOf(request.url);
  if (!opts || !appId) return notFound();
  const pathname = decodeURIComponent(url.pathname);

  if (opts.devUrl) {
    // Vite serves everything: the app's page, its modules, the dev client.
    // Its own module paths are absolute (/@vite/client, /src/…,
    // /node_modules/…); anything else is relative to the app's page first
    // (./main.tsx), then Din's public files (/icons/…).
    // Main asks for it itself: the page's Origin (din://…) and Sec-Fetch-*
    // headers would read to Vite as a cross-site page fetching its source.
    const accept = request.headers.get('accept');
    const fetchDev = (target: string) =>
      net.fetch(new URL(target + url.search, opts.devUrl).toString(), { headers: accept ? { accept } : {} });
    if (pathname === '/' || pathname === '/index.html') return fetchDev(`/src/apps/${appId}/index.html`);
    if (/^\/(@|node_modules\/|src\/|__)/.test(pathname)) return fetchDev(pathname);
    // Decided by what's on disk: Vite answers a path it doesn't have with
    // its HTML fallback, status 200, so an icon from public/ came back as a
    // page.
    const appDir = path.resolve(import.meta.dirname, '..', 'src', 'apps', appId);
    const own = path.resolve(appDir, `.${pathname}`);
    return fetchDev(own.startsWith(appDir + path.sep) && fs.existsSync(own) ? `/src/apps/${appId}${pathname}` : pathname);
  }

  const appDir = path.join(opts.distDir, 'src', 'apps', appId);
  if (!fs.existsSync(path.join(appDir, 'index.html'))) return notFound();
  const candidates = pathname === '/' ? [path.join(appDir, 'index.html')] : [path.join(appDir, pathname), path.join(opts.distDir, pathname)];
  for (const file of candidates) {
    const resolved = path.resolve(file);
    // Within dist/, and never the desktop's own page.
    if (!resolved.startsWith(path.resolve(opts.distDir) + path.sep)) continue;
    if (path.dirname(resolved) === path.resolve(opts.distDir) && /^(index|404)\.html$/.test(path.basename(resolved))) continue;
    try {
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    return net.fetch(pathToFileURL(resolved).toString());
  }
  return notFound();
}

/** Files granted to apps as URLs, by the token that is the URL's host. */
const fileUrls = new Map<string, { file: string; wcId: number; appId: string }>();

function serveFileUrl(request: Request): Promise<Response> | Response {
  let token: string;
  try {
    token = new URL(request.url).hostname;
  } catch {
    return notFound();
  }
  const grant = fileUrls.get(token);
  if (grant) return serveLocalFile(request, grant.file, { 'access-control-allow-origin': `${DIN_SCHEME}://${grant.appId}` });
  const base = fsUrlBases.get(token);
  const fsGrant = base ? grants.get(base.wcId)?.get('fs') : undefined;
  if (!base || !fsGrant) return notFound();
  let file: string;
  try {
    file = path.resolve(decodeURIComponent(new URL(request.url).pathname));
  } catch {
    return notFound();
  }
  if (isProtectedPath(file) || (fsGrant.roots && !withinRoots(fsGrant.roots, file))) return notFound();
  return serveLocalFile(request, file, { 'access-control-allow-origin': `${DIN_SCHEME}://${base.appId}` });
}

/** Apps granted fs, by the token of the URL base they load files from. */
const fsUrlBases = new Map<string, { wcId: number; appId: string }>();

// ---------------------------------------------------------------------------
// System bridge ports
// ---------------------------------------------------------------------------

interface Grant {
  port: MessagePortMain;
  /** The pty sessions this app spawned (or adopted); it may touch no others. */
  ptys: Set<number>;
  /** For a scoped fs grant, the folders it reaches; null for the whole filesystem. */
  roots: Set<string> | null;
  /** Where the port's pushes go, as the handlers' sender does. */
  send: (channel: string, ...args: unknown[]) => void;
}

const grants = new Map<number, Map<SystemPermission, Grant>>();

function grant(contents: Electron.WebContents, permission: SystemPermission, roots: Set<string> | null = null): void {
  revoke(contents.id, permission);
  const { port1, port2 } = new MessageChannelMain();
  const entry: Grant = { port: port1, ptys: new Set(), roots, send: () => {} };
  let byPermission = grants.get(contents.id);
  if (!byPermission) grants.set(contents.id, (byPermission = new Map()));
  byPermission.set(permission, entry);

  // What the handlers see as their sender: pushes go back down the port.
  const sender = {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed() || grants.get(contents.id)?.get(permission) !== entry,
    send: (channel: string, ...args: unknown[]) => {
      if (!sender.isDestroyed()) port1.postMessage({ push: channel, args });
    },
    once: () => sender,
    on: () => sender,
  };
  entry.send = sender.send;

  port1.on('message', ({ data }) => {
    const { id, channel, args } = (data ?? {}) as { id?: unknown; channel?: unknown; args?: unknown };
    const reply = (message: Record<string, unknown>) => {
      if (typeof id === 'number' && !sender.isDestroyed()) port1.postMessage({ id, ...message });
    };
    if (typeof channel !== 'string' || !Array.isArray(args) || !SYSTEM_PERMISSIONS[permission].test(channel)) {
      reply({ error: { name: 'DinPermissionError', message: `${String(channel)} isn't covered by ${permission}` } });
      return;
    }
    const refusal = checkCall(permission, channel, args, entry);
    if (refusal) {
      reply({ error: { name: 'DinPermissionError', message: refusal } });
      return;
    }
    if (channel === 'pty:release' || channel === 'pty:adopt') {
      try {
        const appId = appIdOf(contents.getURL()) ?? '';
        reply({ result: channel === 'pty:release' ? releasePty(entry, args[0] as number, appId) : adoptPty(entry, args[0], appId) });
      } catch (error) {
        reply({ error: { name: 'NotFoundError', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    const event = { sender, senderFrame: null, ports: [], returnValue: undefined, reply: () => {} };
    bridgeEvents.add(event);
    const invoke = invokeHandlers.get(channel);
    const fire = sendHandlers.get(channel);
    if (invoke) {
      Promise.resolve()
        .then(() => invoke(event as unknown as Electron.IpcMainInvokeEvent, ...args))
        .then((result) => {
          if (channel === 'pty:spawn' && typeof result === 'number') entry.ptys.add(result);
          reply({ result });
        })
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          reply({ error: { name: err.name, message: err.message } });
        });
    } else if (fire) {
      try {
        fire(event as unknown as Electron.IpcMainEvent, ...args);
      } catch {
        // Fire-and-forget, like ipcRenderer.send.
      }
      if (channel === 'pty:kill') entry.ptys.delete(args[0] as number);
    } else {
      reply({ error: { name: 'NotFoundError', message: `No handler for ${channel}` } });
    }
  });
  port1.start();
  contents.mainFrame.postMessage('din-app:system', { permission }, [port2]);
}

/** Why a call on a bridge port is refused, or null to let it through. */
function checkCall(permission: SystemPermission, channel: string, args: unknown[], entry: Grant): string | null {
  if (permission === 'pty' && channel !== 'pty:spawn' && channel !== 'pty:adopt' && !entry.ptys.has(args[0] as number)) {
    return 'Not one of this app\'s terminals';
  }
  if (permission === 'fs') {
    if (entry.roots && !SCOPED_FS.has(channel)) return `${channel} reaches beyond this app's folders`;
    if (entry.roots && channel === 'fs:compress' && Array.isArray(args[1]) && args[1].some((n) => typeof n !== 'string' || n.includes('/'))) {
      return 'Names only, inside the folder';
    }
    for (const arg of args) {
      if (typeof arg !== 'string' || !path.isAbsolute(arg)) continue;
      if (isProtectedPath(arg)) return `${path.resolve(arg)} belongs to Din`;
      if (entry.roots && !withinRoots(entry.roots, arg)) return `${path.resolve(arg)} is outside this app's folders`;
    }
  }
  return null;
}

/**
 * What a scoped fs grant may call: everything that names its paths, and
 * nothing that reaches files by other means (the Trash's names, recent
 * files, search across home).
 */
const SCOPED_FS = new Set([
  'fs:homedir', 'fs:stat', 'fs:readdir', 'fs:readFile', 'fs:writeFile', 'fs:mkdir', 'fs:rename', 'fs:copyFile',
  'fs:rm', 'fs:copyInto', 'fs:moveInto', 'fs:move', 'fs:trash', 'fs:details', 'fs:du', 'fs:chmod', 'fs:extract',
  'fs:cancelExtract', 'fs:compress', 'fs:listArchive', 'fs:watch', 'fs:unwatch',
]);

/** A path with its symlinks resolved, as far as it exists (a link inside a root may point anywhere). */
function realish(file: string): string {
  let head = path.resolve(file);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(file);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function withinRoots(roots: Set<string>, file: string): boolean {
  const resolved = realish(file);
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

/** Terminals on their way between windows of an app, by hand-over token. */
const releasedPtys = new Map<string, { id: number; appId: string; held: [string, unknown[]][]; timer: NodeJS.Timeout }>();

/** How long a released terminal waits to be adopted before its shell ends. */
const PTY_HANDOVER_MS = 15_000;

/** Let go of a terminal for another window of the app to adopt; its output waits meanwhile. */
function releasePty(entry: Grant, id: number, appId: string): string {
  if (!entry.ptys.has(id)) throw new Error('Not one of this app\'s terminals');
  entry.ptys.delete(id);
  const token = randomUUID();
  const held: [string, unknown[]][] = [];
  ptyRoutes.set(id, (channel, ...args) => {
    if (held.length < 10_000) held.push([channel, args]);
  });
  const timer = setTimeout(() => {
    releasedPtys.delete(token);
    ptyRoutes.delete(id);
    const event = { sender: { id: -1, isDestroyed: () => true, send: () => {} } };
    bridgeEvents.add(event);
    try {
      sendHandlers.get('pty:kill')?.(event as unknown as Electron.IpcMainEvent, id);
    } catch {
      // Already gone.
    }
  }, PTY_HANDOVER_MS);
  releasedPtys.set(token, { id, appId, held, timer });
  return token;
}

/** Take over a terminal another window of the same app let go of; resolves with its id. */
function adoptPty(entry: Grant, token: unknown, appId: string): number {
  const released = typeof token === 'string' ? releasedPtys.get(token) : undefined;
  if (!released || released.appId !== appId) throw new Error('No such terminal');
  releasedPtys.delete(token as string);
  clearTimeout(released.timer);
  entry.ptys.add(released.id);
  ptyRoutes.set(released.id, entry.send);
  // What it said in between, after the adopter has its id.
  setImmediate(() => {
    for (const [channel, args] of released.held) entry.send(channel, ...args);
  });
  return released.id;
}

/** Whether a path is one no app may reach, even with fs (Din's own profile). */
function isProtectedPath(file: string): boolean {
  const resolved = path.resolve(file);
  return (options?.protectedPaths() ?? []).some((p) => resolved === p || resolved.startsWith(p + path.sep));
}

function revoke(wcId: number, permission: SystemPermission): void {
  const byPermission = grants.get(wcId);
  const entry = byPermission?.get(permission);
  if (!entry) return;
  byPermission!.delete(permission);
  if (byPermission!.size === 0) grants.delete(wcId);
  entry.port.close();
  // An app's terminals end with its grant.
  const kill = sendHandlers.get('pty:kill');
  for (const id of entry.ptys) {
    ptyRoutes.delete(id);
    const event = { sender: { id: wcId, isDestroyed: () => true, send: () => {} } };
    bridgeEvents.add(event);
    try {
      kill?.(event as unknown as Electron.IpcMainEvent, id);
    } catch {
      // Already gone.
    }
  }
}

function revokeAll(wcId: number): void {
  for (const permission of Object.keys(SYSTEM_PERMISSIONS) as SystemPermission[]) revoke(wcId, permission);
  for (const [token, grant] of fileUrls) {
    if (grant.wcId === wcId) fileUrls.delete(token);
  }
  for (const [token, base] of fsUrlBases) {
    if (base.wcId === wcId) fsUrlBases.delete(token);
  }
}

/**
 * A push main sent the shell on a bridge's channel (fs:changed): granted
 * apps hear it too. pty pushes go to their own sender.
 */
export function forwardPushToGrants(channel: string, args: unknown[]): void {
  for (const byPermission of grants.values()) {
    for (const [permission, entry] of byPermission) {
      if (!SYSTEM_PUSHES[permission]?.test(channel)) continue;
      // A scoped grant hears only of its own folders.
      if (entry.roots && !(typeof args[0] === 'string' && withinRoots(entry.roots, args[0]))) continue;
      entry.port.postMessage({ push: channel, args });
    }
  }
}
