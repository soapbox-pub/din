// Din apps' service workers (din://<id>/ and din+file://<host>/): what they
// get beyond Chromium's own, in the shape the web gives it, so an app can do
// its work while none of its windows is open.
//
//   - registration.periodicSync: the worker woken on a schedule
//     (periodic-sync.mts), at most every 15 minutes. New tags only from a
//     window of an app the desktop granted `background` (its manifest asks,
//     and for an app that isn't built in, the user allowed it on screen);
//     its worker can only register again a tag it already holds.
//   - registration.showNotification / getNotifications, into Din's
//     notification center, for an app also granted `notifications`. A click
//     raises `notificationclick` in the worker, a dismissal
//     `notificationclose`; for a minute after a click, clients.openWindow
//     opens a window of the app (its URL in the launch params, as `url`) and
//     WindowClient.focus brings one forward.
//
// An app runs in the background only while Din still has it: a built-in
// app, a folder the desktop opened since it started, an app the `din`
// command is running. The page and worker side is din-app-worker-preload.cjs;
// it only asks, and every answer is decided here, with the app read from the
// calling frame or worker.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import v8 from 'node:v8';
import { appIdOf, appOrigin, appsSession, isAppGuest, isBuiltInApp, isFileAppId } from './din-apps.mts';
import { isServedFolder } from './din-file-apps.mts';
import { isLaunchedApp } from './din-launch.mts';
import { closeAppNotification, setAppNotificationHandlers, showAppNotification } from './notifications.mts';
import { appMayNotify, PeriodicSyncError, registerSyncRunner, registerTag, tagsOf, unregisterTag } from './periodic-sync.mts';
import { WorkerEvents } from './worker-events.mts';

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  /** What the desktop granted a window of an app beyond its page: null when not `background`. */
  backgroundGrant: (webContentsId: number) => { appId: string; notifications: boolean } | null;
}

/** How long after a click on its notification a worker may open or focus a window. */
const INTERACTION_WINDOW_MS = 60_000;
const MAX_NOTIFICATIONS_PER_APP = 32;
const MAX_NOTIFICATION_BYTES = 64 * 1024;

let options: Options;

function log(line: string): void {
  console.log(`[din-app-sw] ${line}`);
}

/** Whether Din still has an app, to wake its worker for. */
function stillHere(appId: string): boolean {
  if (isFileAppId(appId)) return isServedFolder(appId.slice('file-'.length));
  return isLaunchedApp(appId) || isBuiltInApp(appId);
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

interface Caller {
  appId: string;
  origin: string;
  /** For a page, what the desktop granted its window; a worker has none. */
  grant: { notifications: boolean } | null;
  worker: boolean;
}

function pageCaller(event: Electron.IpcMainInvokeEvent): Caller | null {
  const contents = event.sender;
  const frame = event.senderFrame;
  if (!frame || frame !== contents.mainFrame || !isAppGuest(contents)) return null;
  const appId = appIdOf(frame.origin);
  if (!appId) return null;
  const grant = options.backgroundGrant(contents.id);
  return { appId, origin: appOrigin(appId), grant: grant && grant.appId === appId ? grant : null, worker: false };
}

function workerCaller(event: Electron.IpcMainServiceWorkerInvokeEvent): Caller | null {
  if (event.session !== appsSession()) return null;
  const appId = appIdOf(event.serviceWorker.scope);
  return appId ? { appId, origin: appOrigin(appId), grant: null, worker: true } : null;
}

// ---------------------------------------------------------------------------
// Service workers
// ---------------------------------------------------------------------------

const attached = new WeakSet<Electron.ServiceWorkerMain>();
const events = new WorkerEvents({ prefix: 'din-app-sw', log, onWorker: (worker) => attach(worker) });

function attach(worker: Electron.ServiceWorkerMain): void {
  if (attached.has(worker) || !appIdOf(worker.scope)) return;
  attached.add(worker);
  events.attach(worker);
  try {
    worker.ipc.handle('din-app-sw:call', (event, method, params) => {
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

function dispatch(origin: string, type: string, init: Record<string, unknown>) {
  return events.dispatch(appsSession(), `${origin}/`, origin, type, init);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

interface LiveNotification {
  id: number;
  appId: string;
  title: string;
  options: Record<string, unknown>;
}

let nextNotificationId = 1;
const live = new Map<number, LiveNotification>();
/** Per app, when the user last clicked one of its notifications. */
const lastInteraction = new Map<string, number>();

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** A picture's URL, kept only if it's the app's own or a data: URL (bounded by MAX_NOTIFICATION_BYTES). */
function pictureUrl(value: unknown, appId: string): string {
  if (typeof value !== 'string' || !value) return '';
  if (/^data:image\//i.test(value)) return value;
  return value.length <= 4096 && appIdOf(value) === appId ? value : '';
}

function snapshot(n: LiveNotification): Record<string, unknown> {
  return { id: n.id, title: n.title, ...n.options };
}

function mayNotify(caller: Caller): boolean {
  return caller.worker ? appMayNotify(caller.origin) : caller.grant?.notifications === true;
}

async function showNotification(caller: Caller, params: unknown): Promise<void> {
  if (!mayNotify(caller)) throw new DinAppWorkerError('No notification permission has been granted for this origin.', 'TypeError');
  const { title, options: raw } = (params ?? {}) as { title?: unknown; options?: unknown };
  if (typeof title !== 'string') throw new DinAppWorkerError('A notification needs a title', 'TypeError');
  const opts = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (v8.serialize({ title, opts }).length > MAX_NOTIFICATION_BYTES) {
    throw new DinAppWorkerError('The notification is larger than 64 KiB', 'TypeError');
  }
  const actions = Array.isArray(opts.actions)
    ? opts.actions
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({ action: text(a.action, 256), title: text(a.title, 256) }))
        .filter((a) => a.action && a.title && a.action !== 'default')
        .slice(0, 3)
    : [];
  const tag = text(opts.tag, 256);
  const notification: LiveNotification = {
    id: nextNotificationId++,
    appId: caller.appId,
    title: title.slice(0, 256),
    options: {
      body: text(opts.body, 4096),
      tag,
      icon: pictureUrl(opts.icon, caller.appId),
      badge: pictureUrl(opts.badge, caller.appId),
      image: pictureUrl(opts.image, caller.appId),
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
  // A tag replaces its namesake; past the cap, the oldest goes.
  const mine = [...live.values()].filter((n) => n.appId === caller.appId);
  const replaced = mine.filter((n) => tag && n.options.tag === tag);
  const rest = mine.filter((n) => !replaced.includes(n));
  for (const old of [...replaced, ...rest.slice(0, Math.max(0, rest.length - MAX_NOTIFICATIONS_PER_APP + 1))]) {
    live.delete(old.id);
    closeAppNotification(old.id);
  }
  live.set(notification.id, notification);
  await showAppNotification(appsSession(), {
    id: notification.id,
    appId: caller.appId,
    title: notification.title,
    body: notification.options.body as string,
    icon: notification.options.icon as string,
    actions,
    requireInteraction: notification.options.requireInteraction as boolean,
    silent: notification.options.silent as boolean,
  });
}

function listNotifications(caller: Caller, params: unknown): Record<string, unknown>[] {
  const tag = params && typeof params === 'object' ? (params as Record<string, unknown>).tag : undefined;
  return [...live.values()]
    .filter((n) => n.appId === caller.appId && (typeof tag !== 'string' || !tag || n.options.tag === tag))
    .map(snapshot);
}

function closeNotification(caller: Caller, id: unknown): void {
  const notification = typeof id === 'number' ? live.get(id) : undefined;
  if (!notification || notification.appId !== caller.appId) return;
  live.delete(notification.id);
  closeAppNotification(notification.id);
}

// ---------------------------------------------------------------------------
// Calls from apps
// ---------------------------------------------------------------------------

class DinAppWorkerError extends Error {
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
  const args = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  try {
    let result: unknown = null;
    switch (method) {
      case 'sync.register':
        if (!caller.worker && !caller.grant) {
          throw new DinAppWorkerError('This app has no "background" permission.', 'NotAllowedError');
        }
        registerTag(caller.origin, `${caller.origin}/`, args.tag, args.minInterval, caller.worker, caller.grant ?? {});
        break;
      case 'sync.unregister':
        unregisterTag(caller.origin, args.tag);
        break;
      case 'sync.tags':
        result = tagsOf(caller.origin);
        break;
      case 'sync.permission':
        result = caller.grant || (caller.worker && tagsOf(caller.origin).length > 0) ? 'granted' : 'denied';
        break;
      case 'notification.show':
        await showNotification(caller, args);
        break;
      case 'notification.list':
        result = listNotifications(caller, args);
        break;
      case 'notification.close':
        closeNotification(caller, args.id);
        break;
      case 'clients.open':
      case 'clients.focus': {
        if (!caller.worker) throw new DinAppWorkerError('Not available here', 'NotAllowedError');
        if (Date.now() - (lastInteraction.get(caller.appId) ?? 0) > INTERACTION_WINDOW_MS) {
          throw new DinAppWorkerError('Not allowed to open a window.', 'InvalidAccessError');
        }
        let url: string | null = null;
        if (method === 'clients.open') {
          url = typeof args.url === 'string' ? args.url : '';
          if (appIdOf(url) !== caller.appId) throw new DinAppWorkerError('Only the app itself can be opened', 'TypeError');
        }
        options.sendToShell('din-app-sw:open', { appId: caller.appId, url, focus: method === 'clients.focus' });
        result = true;
        break;
      }
      default:
        throw new Error('Unknown method');
    }
    return { ok: true, result };
  } catch (error) {
    if (error instanceof DinAppWorkerError || error instanceof PeriodicSyncError) return failure(error.message, error.kind);
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function registerDinAppWorkers(opts: Options): void {
  options = opts;
  watchWorkers(appsSession());

  registerSyncRunner('app', {
    dispatch: (origin, _scope, tag) =>
      new Promise((resolve) => {
        const appId = appIdOf(origin);
        if (!appId || !stillHere(appId)) {
          resolve('no-worker');
          return;
        }
        const queued = events.enqueue(origin, async () => resolve(await dispatch(origin, 'periodicsync', { tag })));
        if (!queued) resolve('failed');
      }),
    allowed: (origin) => {
      const appId = appIdOf(origin);
      return !!appId && stillHere(appId);
    },
  });

  setAppNotificationHandlers({
    activate: (id, action) => {
      const notification = live.get(id);
      if (!notification) return;
      live.delete(id);
      lastInteraction.set(notification.appId, Date.now());
      const origin = appOrigin(notification.appId);
      events.enqueue(origin, () =>
        dispatch(origin, 'notificationclick', {
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
      const origin = appOrigin(notification.appId);
      events.enqueue(origin, () => dispatch(origin, 'notificationclose', { notification: snapshot(notification) }));
    },
  });

  // From an app's page (din-app-worker-preload.cjs).
  ipcMain.handle('din-app-sw:call', (event, method, params) => {
    const caller = pageCaller(event);
    if (!caller) return failure('Not available here');
    return call(caller, method, params);
  });
}
