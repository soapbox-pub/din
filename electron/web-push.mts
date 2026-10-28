// Web Push for websites, and what a push needs around it: the service-worker
// side Chrome gives a site and Electron leaves out (Electron has no push
// service, and no persistent notifications).
//
//   - registration.pushManager: subscribe() asks for notification permission
//     and a channel from the push service (push-service.mts, Mozilla's
//     autopush by default, configurable in Settings). The endpoint and keys
//     the site gets are a standard Web Push subscription: its server sends
//     to them as it would to Firefox. getSubscription(), permissionState()
//     and unsubscribe() as Chrome has them.
//   - A message is decrypted (push-crypto.mts) and wakes the site's worker
//     with a `push` event (worker-events.mts), then acked. A subscription
//     whose worker is gone, or whose site lost its permission, is given
//     back; if the push service forgets them all (or the user switches
//     services), each site gets `pushsubscriptionchange`.
//   - registration.showNotification / getNotifications, from the page and
//     the worker, into Din's notification center. A click raises
//     `notificationclick` in the worker, and dismissing one
//     `notificationclose`; the worker may then use clients.openWindow or
//     WindowClient.focus for a minute.
//
// Websites in the Web Browser's own session and installed web apps get it,
// each session with its own subscriptions, as Chrome profiles would have.
// Private windows and Tor get none, as an incognito window has none. Installed
// nsites have their own push in napp.mts. The page and worker side is
// web-push-preload.cjs; it only asks, and every answer is decided here, with
// the site read from the calling frame or worker.
//
// The push service's connection, subscriptions and deliveries log
// `[web-push]` lines to the system log.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app, ipcMain, net, powerMonitor, webContents } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { closeWorkerNotification, setWorkerNotificationHandlers, showWorkerNotification } from './notifications.mts';
import {
  base64url,
  decryptPushMessage,
  generateSubscriptionKeys,
  isServerKey,
  PushDecryptError,
  type PushHeaders,
  type SubscriptionKeys,
} from './push-crypto.mts';
import { DEFAULT_PUSH_SERVER, PushService, type AckCode, type UnregisterCode } from './push-service.mts';
import { WorkerEvents } from './worker-events.mts';

/** The sessions sites run in, by the name their subscriptions are stored under. */
export type Partition = 'browser' | 'apps';

export interface WebPushOptions {
  sessions: Record<Partition, () => Electron.Session>;
  sendToShell: (channel: string, payload?: unknown) => void;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  /** What the user answered for a site's notifications, without asking. */
  permission: (origin: string) => NotificationPermission;
  /** Ask the user (if they haven't answered); resolves with whether it's allowed. */
  requestPermission: (s: Electron.Session, origin: string) => Promise<boolean>;
}

/** How long after a click on its notification a worker may open or focus a window. */
const INTERACTION_WINDOW_MS = 60_000;
const MAX_NOTIFICATIONS_PER_SITE = 32;
const MAX_NOTIFICATION_BYTES = 64 * 1024;
/** Message versions remembered per channel, to deliver each once. */
const RECENT_VERSIONS = 10;
const MAX_SCOPE_LENGTH = 2048;

let options: WebPushOptions;

function log(line: string): void {
  console.log(`[web-push] ${line}`);
}

// ---------------------------------------------------------------------------
// Stored state: the push service, its UAID, and every subscription
// ---------------------------------------------------------------------------

interface StoredSubscription {
  partition: Partition;
  /** The service worker registration's scope. */
  scope: string;
  endpoint: string;
  /** The applicationServerKey it was made with (base64url), if any. */
  serverKey: string | null;
  userVisibleOnly: boolean;
  keys: SubscriptionKeys;
  createdAt: number;
}

interface Stored {
  /** The push service, when the user chose another than the default. */
  server: string | null;
  uaid: string | null;
  /** By channel ID. */
  subscriptions: Record<string, StoredSubscription>;
}

let stored: Stored = { server: null, uaid: null, subscriptions: {} };
let saveTimer: NodeJS.Timeout | null = null;

function statePath(): string {
  return path.join(app.getPath('userData'), 'web-push.json');
}

function load(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<Stored>;
    stored = {
      server: typeof parsed.server === 'string' ? parsed.server : null,
      uaid: typeof parsed.uaid === 'string' ? parsed.uaid : null,
      subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
    };
  } catch {
    // Nothing stored yet (or unreadable): no site has subscribed.
  }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(writeState, 1_000);
}

function writeState(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const file = statePath();
  try {
    // The subscriptions' private keys are in here: the user's eyes only.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Non-fatal: it's written again on the next change.
  }
}

/** The subscription for a registration, with its channel ID. */
function findSubscription(partition: Partition, scope: string): [string, StoredSubscription] | null {
  for (const entry of Object.entries(stored.subscriptions)) {
    if (entry[1].partition === partition && entry[1].scope === scope) return entry;
  }
  return null;
}

/** A subscription as the site sees it (PushSubscription, in web-push-preload.cjs). */
function subscriptionJson(sub: StoredSubscription): Record<string, unknown> {
  return {
    endpoint: sub.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: sub.userVisibleOnly, applicationServerKey: sub.serverKey },
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };
}

function originOf(url: string): string | null {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? origin : null;
  } catch {
    return null;
  }
}

/** The key a registration's events queue under, and its name in the log. */
function siteKey(partition: Partition, scope: string): string {
  return `${partition} ${scope}`;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

interface Caller {
  partition: Partition;
  session: Electron.Session;
  origin: string;
  /** The registration a worker belongs to; a page names one per call. */
  scope: string | null;
}

function partitionOf(s: Electron.Session): Partition | null {
  if (s === options.sessions.browser()) return 'browser';
  if (s === options.sessions.apps()) return 'apps';
  return null;
}

/**
 * A page asking: a frame of a browser tab or an installed web app, on the
 * same origin as the page it's in (Chrome refuses notifications to
 * cross-origin frames).
 */
function pageCaller(event: Electron.IpcMainInvokeEvent): Caller | null {
  const contents = event.sender;
  const frame = event.senderFrame;
  if (!frame || contents.getType() !== 'webview') return null;
  const partition = partitionOf(contents.session);
  const origin = frame.origin;
  if (!partition || !originOf(frame.url) || contents.mainFrame.origin !== origin) return null;
  return { partition, session: contents.session, origin, scope: null };
}

function workerCaller(event: Electron.IpcMainServiceWorkerInvokeEvent): Caller | null {
  const partition = partitionOf(event.session);
  const scope = event.serviceWorker.scope;
  const origin = originOf(scope);
  if (!partition || !origin) return null;
  return { partition, session: event.session, origin, scope };
}

/** The registration a call is about: a worker's own, or one of the page's origin. */
function scopeFor(caller: Caller, params: unknown): string {
  if (caller.scope) return caller.scope;
  const scope = params && typeof params === 'object' ? (params as Record<string, unknown>).scope : undefined;
  if (typeof scope !== 'string' || scope.length > MAX_SCOPE_LENGTH || originOf(scope) !== caller.origin) {
    throw new WebPushError('Not available here', 'SecurityError');
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Service workers
// ---------------------------------------------------------------------------

const attached = new WeakSet<Electron.ServiceWorkerMain>();
const events = new WorkerEvents({ prefix: 'web-push', log, onWorker: (worker) => attach(worker) });

/** Wire up a running worker's IPC, if it's a website's. */
function attach(worker: Electron.ServiceWorkerMain): void {
  if (attached.has(worker) || !originOf(worker.scope)) return;
  attached.add(worker);
  events.attach(worker);
  try {
    worker.ipc.handle('web-push:call', (event, method, params) => {
      const caller = workerCaller(event);
      if (!caller) return failure('Not available here');
      return call(caller, method, params);
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
}

function dispatch(partition: Partition, scope: string, type: string, init: Record<string, unknown>) {
  return events.dispatch(options.sessions[partition](), scope, siteKey(partition, scope), type, init);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

let service: PushService;
/** Per channel, the versions of its latest messages. */
const recentVersions = new Map<string, string[]>();

function serverUrl(): string {
  return stored.server ?? DEFAULT_PUSH_SERVER;
}

function startService(): void {
  service = new PushService(serverUrl(), {
    log,
    uaid: stored.uaid,
    channelCount: () => Object.keys(stored.subscriptions).length,
    onHello: (uaid, reset) => {
      if (uaid !== stored.uaid) {
        stored.uaid = uaid;
        save();
      }
      if (reset) dropAll('the push service forgot them');
    },
    onMessage: receive,
    onStatusChanged: () => options.sendToShell('web-push:changed'),
  });
  service.sync();
}

/** Every subscription is gone: each site hears so, as Firefox tells it. */
function dropAll(why: string): void {
  const all = Object.entries(stored.subscriptions);
  if (all.length === 0) return;
  log(`${all.length} subscription(s) dropped: ${why}`);
  stored.subscriptions = {};
  recentVersions.clear();
  save();
  for (const [, sub] of all) {
    events.enqueue(siteKey(sub.partition, sub.scope), () =>
      dispatch(sub.partition, sub.scope, 'pushsubscriptionchange', {
        oldSubscription: subscriptionJson(sub),
        newSubscription: null,
      }),
    );
  }
  options.sendToShell('web-push:changed');
}

/** Give a subscription back to the push service. */
function unsubscribe(channelID: string, code: UnregisterCode, why: string): void {
  const sub = stored.subscriptions[channelID];
  if (!sub) return;
  log(`${siteKey(sub.partition, sub.scope)}: unsubscribed (${why})`);
  delete stored.subscriptions[channelID];
  recentVersions.delete(channelID);
  save();
  service.unregister(channelID, code);
  service.sync();
  options.sendToShell('web-push:changed');
}

function receive(channelID: string, version: string, data: Buffer | null, headers: PushHeaders | null): Promise<AckCode> {
  const sub = stored.subscriptions[channelID];
  if (!sub) {
    // One given back while the push service wasn't listening.
    service.unregister(channelID, 200);
    return Promise.resolve(102);
  }
  const site = siteKey(sub.partition, sub.scope);
  const recent = recentVersions.get(channelID) ?? [];
  if (recent.includes(version)) {
    log(`${site}: a message came again; already delivered`);
    return Promise.resolve(100);
  }
  if (options.permission(new URL(sub.scope).origin) !== 'granted') {
    unsubscribe(channelID, 202, 'no notification permission');
    return Promise.resolve(102);
  }
  let plaintext: Buffer | null;
  try {
    plaintext = decryptPushMessage(sub.keys, headers, data);
  } catch (error) {
    log(`${site}: a message could not be decrypted: ${error instanceof PushDecryptError ? error.message : error}`);
    return Promise.resolve(101);
  }
  recentVersions.set(channelID, [...recent, version].slice(-RECENT_VERSIONS));
  log(`${site}: message, ${plaintext?.length ?? 0} byte(s)`);
  return new Promise((resolve) => {
    const queued = events.enqueue(site, async () => {
      const result = await dispatch(sub.partition, sub.scope, 'push', {
        data: plaintext ? new Uint8Array(plaintext) : null,
      });
      if (result === 'no-worker') unsubscribe(channelID, 200, 'its service worker is gone');
      resolve(result === 'no-worker' ? 102 : 100);
    });
    // Unacked, it comes again on the next connection.
    if (!queued) resolve(102);
  });
}

/** registration.pushManager.subscribe(), as Chrome has it. */
async function subscribe(caller: Caller, scope: string, params: unknown, worker: boolean): Promise<Record<string, unknown>> {
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const userVisibleOnly = raw.userVisibleOnly === true;
  const keyBytes = raw.applicationServerKey;
  let serverKey: string | null = null;
  if (keyBytes !== null && keyBytes !== undefined) {
    if (!(keyBytes instanceof Uint8Array) || !isServerKey(keyBytes)) {
      throw new WebPushError('The provided applicationServerKey is not valid.', 'InvalidAccessError');
    }
    serverKey = base64url(keyBytes);
  }

  // Asked from the page; a worker only gets what's already allowed.
  const allowed = worker
    ? options.permission(caller.origin) === 'granted'
    : await options.requestPermission(caller.session, caller.origin);
  if (!allowed) throw new WebPushError('Registration failed - permission denied', 'NotAllowedError');

  const existing = findSubscription(caller.partition, scope);
  if (existing) {
    if (existing[1].serverKey === serverKey) return subscriptionJson(existing[1]);
    throw new WebPushError(
      'Registration failed - A subscription with a different applicationServerKey (or gcm_sender_id) already exists; to change the applicationServerKey, unsubscribe then resubscribe.',
      'InvalidStateError',
    );
  }

  try {
    await caller.session.serviceWorkers.startWorkerForScope(scope);
  } catch {
    throw new WebPushError('Subscription failed - no active Service Worker', 'AbortError');
  }

  const channelID = crypto.randomUUID();
  let endpoint: string;
  try {
    endpoint = await service.register(channelID, serverKey && paddedBase64url(serverKey));
  } catch (error) {
    log(`${siteKey(caller.partition, scope)}: subscribing failed: ${error instanceof Error ? error.message : error}`);
    throw new WebPushError('Registration failed - push service error', 'AbortError');
  }
  // Two calls at once: the first one wins, the second's channel goes back.
  const raced = findSubscription(caller.partition, scope);
  if (raced) {
    service.unregister(channelID, 200);
    if (raced[1].serverKey === serverKey) return subscriptionJson(raced[1]);
    throw new WebPushError('Registration failed - a subscription already exists', 'InvalidStateError');
  }
  const sub: StoredSubscription = {
    partition: caller.partition,
    scope,
    endpoint,
    serverKey,
    userVisibleOnly,
    keys: generateSubscriptionKeys(),
    createdAt: Date.now(),
  };
  stored.subscriptions[channelID] = sub;
  save();
  log(`${siteKey(caller.partition, scope)}: subscribed`);
  options.sendToShell('web-push:changed');
  return subscriptionJson(sub);
}

/** A key as the push service wants it: base64url with its padding, as Firefox sends it. */
function paddedBase64url(key: string): string {
  return key.padEnd(Math.ceil(key.length / 4) * 4, '=');
}

/** permissionState(): what subscribe() would get, without asking. */
function permissionState(origin: string): PermissionState {
  const answer = options.permission(origin);
  return answer === 'default' ? 'prompt' : answer;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

interface LiveNotification {
  id: number;
  partition: Partition;
  scope: string;
  origin: string;
  title: string;
  options: Record<string, unknown>;
}

let nextNotificationId = 1;
const live = new Map<number, LiveNotification>();
/** Per registration, when the user last clicked one of its notifications. */
const lastInteraction = new Map<string, number>();

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** A picture's URL, kept only if it's one Din can fetch. Data URLs are bounded by MAX_NOTIFICATION_BYTES. */
function pictureUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  if (/^data:image\//i.test(value)) return value;
  return value.length <= 4096 && /^https?:\/\//i.test(value) ? value : '';
}

/** The notification as the page and worker see it in getNotifications() and events. */
function snapshot(n: LiveNotification): Record<string, unknown> {
  return { id: n.id, title: n.title, ...n.options };
}

async function showNotification(caller: Caller, scope: string, params: unknown): Promise<void> {
  if (options.permission(caller.origin) !== 'granted') {
    throw new WebPushError('No notification permission has been granted for this origin.', 'TypeError');
  }
  const { title, options: raw } = (params ?? {}) as { title?: unknown; options?: unknown };
  if (typeof title !== 'string') throw new WebPushError('A notification needs a title', 'TypeError');
  const opts = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (v8.serialize({ title, opts }).length > MAX_NOTIFICATION_BYTES) {
    throw new WebPushError('The notification is larger than 64 KiB', 'TypeError');
  }
  const actions = Array.isArray(opts.actions)
    ? opts.actions
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({ action: text(a.action, 256), title: text(a.title, 256) }))
        .filter((a) => a.action && a.title)
        .slice(0, 3)
    : [];
  const tag = text(opts.tag, 256);
  const notification: LiveNotification = {
    id: nextNotificationId++,
    partition: caller.partition,
    scope,
    origin: caller.origin,
    title: title.slice(0, 256),
    options: {
      body: text(opts.body, 4096),
      tag,
      icon: pictureUrl(opts.icon),
      badge: pictureUrl(opts.badge),
      image: pictureUrl(opts.image),
      data: opts.data ?? null,
      actions,
      silent: opts.silent === true,
      renotify: opts.renotify === true,
      requireInteraction: opts.requireInteraction === true,
      timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
      dir: text(opts.dir, 8) || 'auto',
      lang: text(opts.lang, 64),
    },
  };
  // A tag replaces its namesake from the same site; past the cap, the oldest goes.
  const mine = [...live.values()].filter((n) => n.partition === caller.partition && n.origin === caller.origin);
  for (const old of mine) {
    if (tag && old.options.tag === tag) live.delete(old.id);
  }
  const remaining = mine.filter((n) => live.has(n.id));
  for (const old of remaining.slice(0, Math.max(0, remaining.length - MAX_NOTIFICATIONS_PER_SITE + 1))) {
    live.delete(old.id);
    closeWorkerNotification(old.id);
  }
  live.set(notification.id, notification);
  await showWorkerNotification(caller.session, {
    id: notification.id,
    origin: caller.origin,
    installed: caller.partition === 'apps',
    title: notification.title,
    body: notification.options.body as string,
    icon: notification.options.icon as string,
    tag,
    actions,
    requireInteraction: notification.options.requireInteraction as boolean,
    silent: notification.options.silent as boolean,
  });
}

function listNotifications(caller: Caller, scope: string, params: unknown): Record<string, unknown>[] {
  const tag = params && typeof params === 'object' ? (params as Record<string, unknown>).tag : undefined;
  return [...live.values()]
    .filter((n) => n.partition === caller.partition && n.scope === scope)
    .filter((n) => typeof tag !== 'string' || !tag || n.options.tag === tag)
    .map(snapshot);
}

function closeNotification(caller: Caller, id: unknown): void {
  const notification = typeof id === 'number' ? live.get(id) : undefined;
  if (!notification || notification.partition !== caller.partition || notification.origin !== caller.origin) return;
  live.delete(notification.id);
  closeWorkerNotification(notification.id);
}

// ---------------------------------------------------------------------------
// Windows, from a worker after a click
// ---------------------------------------------------------------------------

function assertInteraction(caller: Caller, scope: string): void {
  const since = lastInteraction.get(siteKey(caller.partition, scope)) ?? 0;
  if (Date.now() - since > INTERACTION_WINDOW_MS) {
    throw new WebPushError('Not allowed to open a window.', 'InvalidAccessError');
  }
}

/** clients.openWindow: a browser tab, or the installed app the URL belongs to. */
function openWindow(caller: Caller, scope: string, url: unknown): void {
  assertInteraction(caller, scope);
  if (typeof url !== 'string' || url.length > 8192 || !originOf(url)) {
    throw new WebPushError('Only http and https URLs can be opened', 'TypeError');
  }
  options.sendToShell('web-push:open', { url, installed: caller.partition === 'apps' });
}

/** WindowClient.focus: bring forward the tab or app window showing the client. */
function focusWindow(caller: Caller, scope: string, url: unknown): void {
  assertInteraction(caller, scope);
  if (typeof url !== 'string' || originOf(url) !== caller.origin) {
    throw new WebPushError('Not allowed to focus a window.', 'InvalidAccessError');
  }
  const target = webContents
    .getAllWebContents()
    .find((c) => !c.isDestroyed() && c.getType() === 'webview' && c.session === caller.session && c.getURL() === url);
  if (target) options.sendToShell('web-push:focus', { webContentsId: target.id });
}

// ---------------------------------------------------------------------------
// Calls from sites
// ---------------------------------------------------------------------------

/** An error the site sees as a particular kind (TypeError, a DOMException name). */
class WebPushError extends Error {
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

async function call(caller: Caller, method: unknown, params: unknown): Promise<Reply> {
  const worker = caller.scope !== null;
  try {
    const scope = scopeFor(caller, params);
    const args = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    let result: unknown = null;
    switch (method) {
      case 'push.subscribe':
        result = await subscribe(caller, scope, args.options, worker);
        break;
      case 'push.get': {
        const found = findSubscription(caller.partition, scope);
        result = found ? subscriptionJson(found[1]) : null;
        break;
      }
      case 'push.permission':
        result = permissionState(caller.origin);
        break;
      case 'push.unsubscribe': {
        const found = findSubscription(caller.partition, scope);
        if (found) unsubscribe(found[0], 200, 'the site asked');
        result = !!found;
        break;
      }
      case 'registration.unregistered': {
        // The worker's registration is gone, and with it its subscription.
        const found = findSubscription(caller.partition, scope);
        if (found) unsubscribe(found[0], 200, 'its service worker was unregistered');
        break;
      }
      case 'notification.show':
        await showNotification(caller, scope, args);
        break;
      case 'notification.list':
        result = listNotifications(caller, scope, args);
        break;
      case 'notification.close':
        closeNotification(caller, args.id);
        break;
      case 'clients.open':
        if (!worker) throw new WebPushError('Not available here', 'NotAllowedError');
        openWindow(caller, scope, args.url);
        result = true;
        break;
      case 'clients.focus':
        if (!worker) throw new WebPushError('Not available here', 'NotAllowedError');
        focusWindow(caller, scope, args.url);
        result = true;
        break;
      default:
        throw new Error('Unknown method');
    }
    return { ok: true, result };
  } catch (error) {
    if (error instanceof WebPushError) return failure(error.message, error.kind);
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Forgetting
// ---------------------------------------------------------------------------

function forgetWhere(match: (sub: StoredSubscription) => boolean, code: UnregisterCode, why: string): void {
  for (const [channelID, sub] of Object.entries(stored.subscriptions)) {
    if (match(sub)) unsubscribe(channelID, code, why);
  }
}

function closeNotificationsWhere(match: (n: LiveNotification) => boolean): void {
  for (const n of [...live.values()]) {
    if (!match(n)) continue;
    live.delete(n.id);
    closeWorkerNotification(n.id);
  }
}

/** The user changed a site's answer: without notifications, it has no push. */
export function webPushPermissionChanged(origin: string, capability: string, allow: boolean | null): void {
  if (capability !== 'notifications' || allow === true || !options) return;
  forgetWhere((sub) => new URL(sub.scope).origin === origin, 202, 'notification permission withdrawn');
  closeNotificationsWhere((n) => n.origin === origin);
}

/** A session's site data was cleared: its service workers, and their subscriptions, went with it. */
export function forgetWebPushPartition(partition: Partition): void {
  if (!options) return;
  forgetWhere((sub) => sub.partition === partition, 200, 'site data cleared');
  closeNotificationsWhere((n) => n.partition === partition);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** A push service URL the user may choose: wss, or ws to this computer. */
function validServer(url: unknown): string {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('Expected a URL');
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('That is not a URL');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && local)) {
    throw new Error('A push service URL starts with wss://');
  }
  return parsed.href;
}

export function registerWebPushHandlers(webPushOptions: WebPushOptions): void {
  options = webPushOptions;
  load();
  startService();
  powerMonitor.on('resume', () => service.wake());
  setInterval(() => {
    if (net.isOnline()) service.wake();
  }, 60_000);
  app.on('will-quit', () => {
    service.close();
    // A site that subscribed just now still has its subscription next time.
    if (saveTimer) writeState();
  });

  watchWorkers(options.sessions.browser());
  watchWorkers(options.sessions.apps());

  setWorkerNotificationHandlers({
    activate: (id, action) => {
      const notification = live.get(id);
      if (!notification) return;
      // A click takes it off the screen, but it's the site's to close: a
      // click isn't a dismissal, so no notificationclose follows.
      live.delete(id);
      const site = siteKey(notification.partition, notification.scope);
      lastInteraction.set(site, Date.now());
      events.enqueue(site, () =>
        dispatch(notification.partition, notification.scope, 'notificationclick', {
          notification: snapshot(notification),
          action: action === 'default' ? '' : action,
        }),
      );
    },
    closed: (id, reason) => {
      const notification = live.get(id);
      if (!notification) return;
      live.delete(id);
      if (reason !== 'dismissed') return;
      events.enqueue(siteKey(notification.partition, notification.scope), () =>
        dispatch(notification.partition, notification.scope, 'notificationclose', {
          notification: snapshot(notification),
        }),
      );
    },
  });

  // From a page (web-push-preload.cjs).
  ipcMain.handle('web-push:call', (event, method, params) => {
    const caller = pageCaller(event);
    if (!caller) return failure('Not available here');
    return call(caller, method, params);
  });

  // Settings (window.webPushHost in preload.cjs).
  ipcMain.handle('web-push:status', (event) => {
    options.assertShellSender(event);
    return {
      ...service.status(),
      defaultUrl: DEFAULT_PUSH_SERVER,
      subscriptions: Object.keys(stored.subscriptions).length,
    };
  });
  ipcMain.handle('web-push:setServer', (event, url) => {
    options.assertShellSender(event);
    const next = url === null ? null : validServer(url);
    const chosen = next === DEFAULT_PUSH_SERVER ? null : next;
    if (chosen === stored.server) return;
    log(`push service changed to ${chosen ?? DEFAULT_PUSH_SERVER}`);
    // Subscriptions belong to the service they were made with.
    for (const channelID of Object.keys(stored.subscriptions)) service.unregister(channelID, 200);
    service.close();
    dropAll('the push service was changed');
    stored.server = chosen;
    stored.uaid = null;
    save();
    startService();
    options.sendToShell('web-push:changed');
  });
}
