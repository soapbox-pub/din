// The napp runtime: what Din gives an installed nsite beyond a browser tab,
// following Tenna's NAPP.md so a site written for Tenna works unchanged here.
//
//   - window.napp.push: Nostr subscriptions Din keeps open while the site is
//     closed (napp-push.mts). Matching events wake the site's service worker
//     with a `push` event whose data is { $type: 'napp.push.payload',
//     event_id, event, relays }.
//   - registration.showNotification / getNotifications, from the page and the
//     worker, into Din's notification center. A click opens the app at
//     `data.url` and raises `notificationclick` in the worker; dismissing one
//     raises `notificationclose`.
//   - napp.fetch / self.napp.fetch: a request without CORS (napp-fetch.mts).
//   - registration.periodicSync: the worker woken on a schedule, at most every
//     15 minutes, after the user allows "Refresh in the background".
//   - window.ENV: per-device variables the user sets in the app's info.
//   - navigator.setAppBadge / clearAppBadge, from the page and the worker,
//     for the app's Dock tile.
//
// Only installed nsites get any of it, in their app's window and in a browser
// tab alike: both are the same site, in the browser's session, sharing one
// service worker. Whether a site is installed is the nsite store's record
// (nsite-store.mts), keyed by its canonical host. The page and worker side is
// napp-preload.cjs; it only ever asks, and every answer is decided here, with
// the site read from the calling frame or worker - never from what the site
// says.
//
// Events reach a worker through worker-events.mts: started for its scope and
// handed the event over IPC, which its preload raises as a real
// PushEvent/NotificationEvent/PeriodicSyncEvent. One event at a time per
// site, five minutes at most each.
//
// For diagnosis, the push pool, worker wakes, notifications and the workers'
// own consoles log `[napp]` lines to the system log, and the pool's live
// state is written to $XDG_RUNTIME_DIR/din-napp.json.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app, ipcMain, net, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { fetchAbort, fetchAbortAll, fetchRead, fetchStart, type NappFetchRequest } from './napp-fetch.mts';
import {
  normalizeSubscriptions,
  PushPool,
  restoreSitePush,
  resubscribe,
  type NappSubscription,
  type SitePush,
} from './napp-push.mts';
import { isInstalledSite, nsiteStoreReady, parseCanonicalHost } from './nsite-store.mts';
import { badgeFromSite, closeSiteNotification, setAppBadge, setSiteNotificationHandlers, showSiteNotification } from './notifications.mts';
import { WorkerEvents, type DispatchResult } from './worker-events.mts';

/** A capability a site asks the user for, as main.mts files it. */
export type NappCapability = 'notifications' | 'background-sync';

export interface NappOptions {
  /** The browser's session, which installed apps (and their workers) share. */
  session: () => Electron.Session;
  sendToShell: (channel: string, payload?: unknown) => void;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  /** Whether a WebContents is a page in that session: a browser tab or an installed app's window. */
  isSiteGuest: (contents: Electron.WebContents) => boolean;
  /** What the user answered for a site, without asking. */
  permission: (origin: string, capability: NappCapability) => NotificationPermission;
  /** Ask the user (if they haven't answered); resolves with whether it's allowed. */
  requestPermission: (origin: string, capability: NappCapability) => Promise<boolean>;
  /** Forget everything the user answered for a site. */
  forgetPermissions: (origin: string) => void;
}

/** How long after a click on its notification a worker may open its window. */
const INTERACTION_WINDOW_MS = 60_000;
const MAX_NOTIFICATIONS_PER_SITE = 32;
const MAX_NOTIFICATION_BYTES = 64 * 1024;
const MIN_SYNC_INTERVAL_MS = 15 * 60_000;
const MAX_SYNC_TAGS = 10;
const SYNC_CHECK_MS = 60_000;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE = 4096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let options: NappOptions;

// ---------------------------------------------------------------------------
// Diagnosis: [napp] lines in the system log, and a status file
// ---------------------------------------------------------------------------

function log(line: string): void {
  console.log(`[napp] ${line}`);
}

/** Per site, what its worker last did with an event. */
const lastDispatch = new Map<string, { type: string; outcome: string; at: number; ms: number }>();
let statusTimer: NodeJS.Timeout | null = null;

/**
 * Where the push pool's state is written for whoever is diagnosing it
 * (`jq . $XDG_RUNTIME_DIR/din-napp.json`): relays, what each said about each
 * subscription, and what each site was handed. Readable by the user only.
 */
function statusFilePath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? path.join(runtime, 'din-napp.json') : path.join(app.getPath('userData'), 'napp-status.json');
}

function statusChanged(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    const { sites, relays } = pool.status();
    const status = {
      updated: new Date().toISOString(),
      sites: Object.fromEntries(
        Object.entries(sites).map(([host, site]) => [host, { ...site, lastDispatch: lastDispatch.get(host) ?? null }]),
      ),
      relays,
    };
    const file = statusFilePath();
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(status, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // Diagnosis only: the next change writes it again.
    }
  }, 2_000);
}

const WORKER_LOG_PER_MINUTE = 60;
const workerLogBudget = new Map<string, { minute: number; lines: number; dropped: number }>();

/** A site worker's console, into the system log; at most a minute's budget per site. */
function logWorkerConsole(host: string, details: Electron.MessageDetails): void {
  const minute = Math.floor(Date.now() / 60_000);
  let budget = workerLogBudget.get(host);
  if (!budget || budget.minute !== minute) {
    if (budget?.dropped) log(`sw ${host}: ${budget.dropped} more console line(s) dropped`);
    budget = { minute, lines: 0, dropped: 0 };
    workerLogBudget.set(host, budget);
  }
  if (budget.lines >= WORKER_LOG_PER_MINUTE) {
    budget.dropped++;
    return;
  }
  budget.lines++;
  const level = ['verbose', 'info', 'warning', 'error'][details.level] ?? String(details.level);
  const where = details.sourceUrl ? ` (${details.sourceUrl.replace(/^nsite:\/\/[^/]+/, '')}:${details.lineNumber})` : '';
  const message = details.message.length > 2000 ? `${details.message.slice(0, 2000)}…` : details.message;
  log(`sw ${host} ${level}: ${message}${where}`);
}

// ---------------------------------------------------------------------------
// Stored state: subscriptions, periodic sync tags and ENV, per site
// ---------------------------------------------------------------------------

interface SyncTag {
  minInterval: number;
  nextRun: number;
}

interface Stored {
  push: Record<string, SitePush>;
  sync: Record<string, Record<string, SyncTag>>;
  env: Record<string, Record<string, string>>;
}

let stored: Stored = { push: {}, sync: {}, env: {} };
let saveTimer: NodeJS.Timeout | null = null;

function statePath(): string {
  return path.join(app.getPath('userData'), 'napp.json');
}

function load(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<Stored>;
    stored = {
      push: parsed.push && typeof parsed.push === 'object' ? parsed.push : {},
      sync: parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : {},
      env: parsed.env && typeof parsed.env === 'object' ? parsed.env : {},
    };
  } catch {
    // Nothing stored yet (or unreadable): no site has asked for anything.
  }
  for (const host of Object.keys(stored.push)) {
    try {
      stored.push[host] = restoreSitePush(stored.push[host]);
    } catch {
      delete stored.push[host];
    }
  }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const file = statePath();
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(stored));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // Non-fatal: it's written again on the next change.
    }
  }, 1_000);
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

function originOf(host: string): string {
  return `nsite://${host}`;
}

/** The host of a canonical nsite origin or URL, or null. */
function hostOf(url: string): string | null {
  const match = /^nsite:\/\/([^/?#]+)/i.exec(url);
  if (!match) return null;
  const host = match[1].toLowerCase();
  return parseCanonicalHost(host) ? host : null;
}

/** The name of the error a site that isn't installed gets for every call. */
const NOT_INSTALLED = 'NotInstalledError';

/**
 * The installed nsite a frame belongs to, by the origin Chromium gave it: in a
 * browser tab or the app's window, never a private one. Null for anything else.
 */
function installedFrameHost(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string | null {
  const frame = event.senderFrame;
  if (!frame || !options.isSiteGuest(event.sender)) return null;
  const host = hostOf(frame.origin);
  return host && isInstalledSite(host) ? host : null;
}

/** The installed nsite a page call comes from: its top document. */
function pageCaller(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string | null {
  return event.senderFrame === event.sender.mainFrame ? installedFrameHost(event) : null;
}

/** Whether a site is installed, once the store has loaded (workers can start before it has). */
async function isInstalled(host: string): Promise<boolean> {
  await nsiteStoreReady();
  return isInstalledSite(host);
}

// ---------------------------------------------------------------------------
// Service workers
// ---------------------------------------------------------------------------

const attached = new WeakSet<Electron.ServiceWorkerMain>();
const events = new WorkerEvents({
  prefix: 'napp',
  log,
  onOutcome: (host, type, outcome, ms) => {
    lastDispatch.set(host, { type, outcome, at: Date.now(), ms });
    statusChanged();
  },
  onWorker: (worker) => attach(worker),
});

/**
 * Wire up a running nsite worker's IPC. Every nsite's worker has the preload,
 * so this answers them all; only an installed site's calls get anywhere.
 */
function attach(worker: Electron.ServiceWorkerMain): void {
  if (attached.has(worker)) return;
  const host = hostOf(worker.scope);
  if (!host) return;
  attached.add(worker);
  events.attach(worker);
  try {
    worker.ipc.handle('napp:call', async (event, method, params) => {
      if (event.session !== options.session()) return failure('Not available here');
      const scopeHost = hostOf(event.serviceWorker.scope);
      if (!scopeHost) return failure('Not available here');
      if (!(await isInstalled(scopeHost))) return failure('Only installed apps can do this', NOT_INSTALLED);
      return call({ host: scopeHost, worker: true }, method, params);
    });
  } catch {
    // Already wired (a second handle() for the same worker throws).
  }
}

function watchWorkers(s: Electron.Session): void {
  s.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return;
    const worker = s.serviceWorkers.getWorkerFromVersionID(versionId);
    if (worker) attach(worker);
  });
  s.serviceWorkers.on('console-message', (_event, details) => {
    let host: string | null;
    try {
      host = hostOf(s.serviceWorkers.getInfoFromVersionID(details.versionId).scope);
    } catch {
      host = null;
    }
    if (host) logWorkerConsole(host, details);
  });
}

/**
 * Start a site's worker (if it has one) and raise an event in it.
 */
function dispatch(host: string, type: string, init: Record<string, unknown>): Promise<DispatchResult> {
  return events.dispatch(options.session(), `${originOf(host)}/`, host, type, init);
}

/** Run jobs for a site's worker one after another. */
function enqueue(host: string, job: () => Promise<unknown>): void {
  events.enqueue(host, job);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

let pool: PushPool;

function deliverPush(host: string, event: NostrEvent, relay: string): void {
  enqueue(host, () =>
    dispatch(host, 'push', { $type: 'napp.push.payload', event_id: event.id, event, relays: [relay] }),
  );
}

function setPush(host: string, subscriptions: NappSubscription[]): void {
  if (subscriptions.length > 0 || stored.push[host]) {
    log(`${host}: ${subscriptions.length} push subscription(s)`);
  }
  if (subscriptions.length === 0) {
    delete stored.push[host];
    pool.setSite(host, null);
  } else {
    stored.push[host] = resubscribe(stored.push[host], subscriptions);
    pool.setSite(host, stored.push[host]);
  }
  save();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

interface LiveNotification {
  id: number;
  host: string;
  title: string;
  options: Record<string, unknown>;
}

let nextNotificationId = 1;
const live = new Map<number, LiveNotification>();
const lastInteraction = new Map<string, number>();

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * A URL a notification names, resolved and kept only if it's usable. Never
 * cut short: a truncated data: URL decodes as just the picture's top rows.
 * Data URLs are bounded by MAX_NOTIFICATION_BYTES, checked before this.
 */
function pictureUrl(value: unknown, host: string): string {
  if (typeof value !== 'string' || !value) return '';
  const url = value;
  if (/^data:image\//i.test(url)) return url;
  if (url.length > 4096) return '';
  if (/^https:\/\//i.test(url)) return url;
  return hostOf(url) === host ? url : '';
}

/** The notification as the page and worker see it in getNotifications() and events. */
function snapshot(n: LiveNotification): Record<string, unknown> {
  return { id: n.id, title: n.title, ...n.options };
}

async function showNotification(host: string, params: unknown): Promise<void> {
  if (options.permission(originOf(host), 'notifications') !== 'granted') {
    log(`${host}: notification refused, no permission`);
    throw new NappError('No notification permission has been granted for this origin.', 'TypeError');
  }
  const { title, options: raw } = (params ?? {}) as { title?: unknown; options?: unknown };
  if (typeof title !== 'string') throw new NappError('A notification needs a title', 'TypeError');
  const opts = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (v8.serialize({ title, opts }).length > MAX_NOTIFICATION_BYTES) {
    throw new NappError('The notification is larger than 64 KiB', 'TypeError');
  }
  const actions = Array.isArray(opts.actions)
    ? opts.actions
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({ action: text(a.action, 256), title: text(a.title, 256) }))
        .filter((a) => a.action && a.title)
        .slice(0, 3)
    : [];
  const tag = text(opts.tag, 256);
  const data = opts.data ?? null;
  const dataUrl = data && typeof data === 'object' ? (data as Record<string, unknown>).url : undefined;
  let url: string | null = null;
  if (typeof dataUrl === 'string') {
    try {
      const resolved = new URL(dataUrl, `${originOf(host)}/`).href;
      url = hostOf(resolved) === host ? resolved : null;
    } catch {
      url = null;
    }
  }
  const notification: LiveNotification = {
    id: nextNotificationId++,
    host,
    title: title.slice(0, 256),
    options: {
      body: text(opts.body, 4096),
      tag,
      icon: pictureUrl(opts.icon, host),
      badge: pictureUrl(opts.badge, host),
      image: pictureUrl(opts.image, host),
      data,
      actions,
      silent: opts.silent === true,
      renotify: opts.renotify === true,
      requireInteraction: opts.requireInteraction === true,
      timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
      dir: text(opts.dir, 8) || 'auto',
      lang: text(opts.lang, 64),
    },
  };
  // A tag replaces its namesake; past the cap, the oldest goes.
  const mine = [...live.values()].filter((n) => n.host === host);
  for (const old of mine) {
    if (tag && old.options.tag === tag) live.delete(old.id);
  }
  const remaining = mine.filter((n) => live.has(n.id));
  for (const old of remaining.slice(0, Math.max(0, remaining.length - MAX_NOTIFICATIONS_PER_SITE + 1))) {
    live.delete(old.id);
    closeSiteNotification(old.id);
  }
  live.set(notification.id, notification);
  log(`${host}: notification ${notification.id}${tag ? ` tag=${tag}` : ''}${notification.options.silent ? ' (silent)' : ''}`);
  await showSiteNotification(options.session(), {
    id: notification.id,
    host,
    title: notification.title,
    body: notification.options.body as string,
    icon: notification.options.icon as string,
    tag,
    actions,
    requireInteraction: notification.options.requireInteraction as boolean,
    silent: notification.options.silent as boolean,
    url,
  });
}

function listNotifications(host: string, params: unknown): Record<string, unknown>[] {
  const tag = params && typeof params === 'object' ? (params as Record<string, unknown>).tag : undefined;
  return [...live.values()]
    .filter((n) => n.host === host && (typeof tag !== 'string' || !tag || n.options.tag === tag))
    .map(snapshot);
}

function closeNotification(host: string, id: unknown): void {
  const notification = typeof id === 'number' ? live.get(id) : undefined;
  if (!notification || notification.host !== host) return;
  live.delete(notification.id);
  closeSiteNotification(notification.id);
}

function closeAllNotifications(host: string): void {
  for (const n of [...live.values()]) if (n.host === host) closeNotification(host, n.id);
}

// ---------------------------------------------------------------------------
// Periodic sync
// ---------------------------------------------------------------------------

async function registerSync(host: string, params: unknown, worker: boolean): Promise<void> {
  const { tag, minInterval } = (params ?? {}) as { tag?: unknown; minInterval?: unknown };
  if (typeof tag !== 'string' || !tag || tag.length > 256) throw new NappError('Invalid tag', 'TypeError');
  const tags = (stored.sync[host] ??= {});
  const origin = originOf(host);
  if (worker) {
    // Nobody to ask from a worker: only what the site already holds.
    if (!tags[tag] || options.permission(origin, 'background-sync') !== 'granted') {
      throw new NappError('Register new tags from the page', 'NotAllowedError');
    }
  } else if (!(await options.requestPermission(origin, 'background-sync'))) {
    throw new NappError('Permission denied.', 'NotAllowedError');
  }
  if (!tags[tag] && Object.keys(tags).length >= MAX_SYNC_TAGS) {
    throw new NappError(`At most ${MAX_SYNC_TAGS} tags`, 'QuotaExceededError');
  }
  const interval = Math.max(MIN_SYNC_INTERVAL_MS, typeof minInterval === 'number' && minInterval > 0 ? minInterval : 0);
  // Registering again keeps the tag's place in the schedule.
  tags[tag] = { minInterval: interval, nextRun: tags[tag]?.nextRun ?? Date.now() + interval };
  save();
}

function unregisterSync(host: string, tag: unknown): void {
  const tags = stored.sync[host];
  if (!tags || typeof tag !== 'string' || !tags[tag]) return;
  delete tags[tag];
  if (Object.keys(tags).length === 0) delete stored.sync[host];
  save();
}

function runDueSyncs(): void {
  if (!net.isOnline()) return;
  const now = Date.now();
  for (const [host, tags] of Object.entries(stored.sync)) {
    if (options.permission(originOf(host), 'background-sync') !== 'granted') continue;
    for (const [tag, entry] of Object.entries(tags)) {
      if (entry.nextRun > now) continue;
      entry.nextRun = now + entry.minInterval;
      save();
      enqueue(host, () => dispatch(host, 'periodicsync', { tag }));
    }
  }
}

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

function normalizeEnv(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_VARS) throw new Error(`At most ${MAX_ENV_VARS} variables`);
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw new Error(`${name} is not a valid variable name`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) {
      throw new Error(`${name} must be text of at most ${MAX_ENV_VALUE} characters`);
    }
    env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Calls from sites
// ---------------------------------------------------------------------------

/** An error the site sees as a particular kind (TypeError, a DOMException name). */
class NappError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.kind = kind;
  }
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string; name: string };

function failure(error: string, name = 'Error'): Reply {
  return { ok: false, error, name };
}

async function call(caller: { host: string; worker: boolean }, method: unknown, params: unknown): Promise<Reply> {
  const { host, worker } = caller;
  const origin = originOf(host);
  try {
    let result: unknown = null;
    switch (method) {
      case 'push.set': {
        if (worker) throw new NappError('Subscribe from the page', 'NotAllowedError');
        const subscriptions = normalizeSubscriptions(params);
        if (subscriptions.length > 0 && !(await options.requestPermission(origin, 'notifications'))) {
          throw new Error('User rejected');
        }
        setPush(host, subscriptions);
        break;
      }
      case 'push.get':
        result = stored.push[host]?.subscriptions ?? [];
        break;
      case 'push.unsubscribe':
        setPush(host, []);
        result = true;
        break;
      case 'notification.show':
        await showNotification(host, params);
        break;
      case 'notification.list':
        result = listNotifications(host, params);
        break;
      case 'notification.close':
        closeNotification(host, params);
        break;
      case 'badge.set':
        setAppBadge({ kind: 'site', host }, badgeFromSite(params));
        break;
      case 'badge.clear':
        setAppBadge({ kind: 'site', host }, null);
        break;
      case 'fetch.start':
        result = await fetchStart(host, params as NappFetchRequest).catch((error: Error) => {
          throw new NappError(error.message, 'TypeError');
        });
        break;
      case 'fetch.read':
        result = await fetchRead(host, params).catch((error: Error) => {
          throw new NappError(error.message, 'TypeError');
        });
        break;
      case 'fetch.abort':
        fetchAbort(host, params);
        break;
      case 'sync.register':
        await registerSync(host, params, worker);
        break;
      case 'sync.unregister':
        unregisterSync(host, params);
        break;
      case 'sync.tags':
        result = Object.keys(stored.sync[host] ?? {});
        break;
      case 'sync.permission':
        result = options.permission(origin, 'background-sync');
        break;
      case 'clients.open':
      case 'clients.focus': {
        if (!worker) throw new NappError('Not available here', 'NotAllowedError');
        const since = lastInteraction.get(host) ?? 0;
        if (Date.now() - since > INTERACTION_WINDOW_MS) {
          throw new NappError('Not allowed to open a window.', 'InvalidAccessError');
        }
        let url: string | null = null;
        if (method === 'clients.open') {
          url = typeof params === 'string' ? params : '';
          if (hostOf(url) !== host) throw new NappError('Only the site itself can be opened', 'TypeError');
        }
        options.sendToShell('napp:open', { host, url });
        result = true;
        break;
      }
      default:
        throw new Error('Unknown method');
    }
    return { ok: true, result };
  } catch (error) {
    if (error instanceof NappError) return failure(error.message, error.kind);
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Forgetting a site
// ---------------------------------------------------------------------------

/**
 * What a site has as an app: its subscriptions, schedule, notifications and
 * ENV. Called when it's uninstalled, which leaves it a site like any other,
 * still signed in wherever it was: its storage and permissions are the
 * browser's as much as the app's, as in Chrome.
 */
export function forgetNappSite(host: string): void {
  if (!parseCanonicalHost(host)) return;
  setPush(host, []);
  delete stored.sync[host];
  delete stored.env[host];
  save();
  closeAllNotifications(host);
  setAppBadge({ kind: 'site', host }, null);
  fetchAbortAll(host);
  events.forget(host);
  lastInteraction.delete(host);
}

/**
 * Everything a site has on this computer outside its files: what it has as an
 * app, its permissions, and its storage (cookies, IndexedDB, caches, service
 * workers) in the browser's session, which its app window shares. For the
 * user clearing an app's data.
 */
async function clearNappSite(host: string): Promise<void> {
  forgetNappSite(host);
  options.forgetPermissions(originOf(host));
  await options.session().clearStorageData({ origin: originOf(host) }).catch(() => {});
}

/** The user changed a site's answer: what depended on it stops. */
export function nappPermissionChanged(origin: string, capability: string, allow: boolean | null): void {
  const host = hostOf(origin);
  if (!host || allow === true) return;
  if (capability === 'notifications' && stored.push[host]) setPush(host, []);
  if (capability === 'background-sync' && stored.sync[host]) {
    delete stored.sync[host];
    save();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerNappHandlers(nappOptions: NappOptions): void {
  options = nappOptions;
  load();

  pool = new PushPool({
    deliver: deliverPush,
    onStored: () => save(),
    log,
    onStatusChanged: statusChanged,
  });
  for (const [host, push] of Object.entries(stored.push)) pool.setSite(host, push);
  powerMonitor.on('resume', () => pool.wake());
  setInterval(() => {
    if (net.isOnline()) pool.wake();
    runDueSyncs();
  }, SYNC_CHECK_MS);
  app.on('will-quit', () => pool.close());

  watchWorkers(options.session());

  setSiteNotificationHandlers({
    activate: (id, action) => {
      const notification = live.get(id);
      if (!notification) return;
      // A click takes it off the screen, but it's the site's to close: a
      // click isn't a dismissal, so no notificationclose follows.
      live.delete(id);
      lastInteraction.set(notification.host, Date.now());
      enqueue(notification.host, () =>
        dispatch(notification.host, 'notificationclick', {
          notification: snapshot(notification),
          action: action === 'default' ? '' : action,
          reply: null,
        }),
      );
    },
    closed: (id, reason) => {
      const notification = live.get(id);
      if (!notification) return;
      live.delete(id);
      if (reason !== 'dismissed') return;
      enqueue(notification.host, () =>
        dispatch(notification.host, 'notificationclose', { notification: snapshot(notification) }),
      );
    },
  });

  // From an installed nsite's page (napp-preload.cjs).
  ipcMain.handle('napp:call', (event, method, params) => {
    const host = pageCaller(event);
    if (!host) return failure('Not available here');
    return call({ host, worker: false }, method, params);
  });

  // Read synchronously by every nsite frame before the page's own scripts
  // run: whether its site is installed (so the page gets the napp runtime at
  // all), and its window.ENV. Any frame of the site's own origin gets ENV.
  ipcMain.on('napp:frame', (event) => {
    const host = installedFrameHost(event);
    const env = host ? stored.env[host] : undefined;
    event.returnValue = {
      installed: host !== null,
      env: env && Object.keys(env).length > 0 ? env : null,
    };
  });

  // The app's info in the shell (window.dinos.nappHost in preload.cjs).
  const hostArg = (host: unknown): string => {
    if (typeof host !== 'string' || !parseCanonicalHost(host)) throw new Error('napp: expected a canonical nsite host');
    return host;
  };
  ipcMain.handle('napp:status', (event, rawHost) => {
    options.assertShellSender(event);
    const host = hostArg(rawHost);
    return {
      env: stored.env[host] ?? {},
      subscriptions: stored.push[host]?.subscriptions.length ?? 0,
      syncTags: Object.keys(stored.sync[host] ?? {}),
    };
  });
  ipcMain.handle('napp:setEnv', (event, rawHost, env) => {
    options.assertShellSender(event);
    const host = hostArg(rawHost);
    const normalized = normalizeEnv(env);
    if (Object.keys(normalized).length === 0) delete stored.env[host];
    else stored.env[host] = normalized;
    save();
  });
  ipcMain.handle('napp:clearData', (event, rawHost) => {
    options.assertShellSender(event);
    return clearNappSite(hostArg(rawHost));
  });
}
