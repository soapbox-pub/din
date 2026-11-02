// @ts-check
// Session preload for Din apps (din:// and din+file://): what
// din-app-workers.mts gives their service workers, in the shape the web
// gives it. Registered in main.mts on the apps' session twice, as a frame
// preload and as a service-worker preload; it works out which it is, and in
// a frame does anything only in the app's top document.
//
// In the page and the worker:
//   - registration.periodicSync: register, unregister, getTags
//   - registration.showNotification / getNotifications, into Din's
//     notification center (Electron shows none from a registration)
//   - navigator.permissions.query for 'periodic-background-sync'
// In the service worker:
//   - clients.openWindow / WindowClient.focus, through the desktop
//   - the periodicsync, notificationclick and notificationclose events
//     din-app-workers.mts raises, with waitUntil() waited on before it's
//     told they ran
//
// Every call goes to din-app-workers.mts, which reads the app from the
// calling frame or worker and decides there; nothing here is trusted.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {{ ok: true, result: unknown } | { ok: false, error: string, name: string }} Reply
 * @typedef {{
 *   call: (method: string, params?: Record<string, unknown>) => Promise<Reply>,
 *   listen: (callback: (id: number, type: string, init: Record<string, unknown>) => void) => void,
 *   done: (id: number, ok: boolean) => void,
 * }} Bridge
 */

/**
 * Runs in the app's world (its page, or its worker): everything it needs
 * comes in through `bridge`.
 * @param {Bridge} bridge
 */
function installAppWorkers(bridge) {
  if (location.protocol !== 'din:' && location.protocol !== 'din+file:') return;
  const scope = /** @type {typeof globalThis & Record<string, any>} */ (globalThis);
  const inWorker = typeof scope.ServiceWorkerGlobalScope === 'function' && self instanceof scope.ServiceWorkerGlobalScope;
  if (!inWorker && window.top !== window.self) return;
  const Registration = scope.ServiceWorkerRegistration;
  if (typeof Registration !== 'function') return;
  const proto = Registration.prototype;

  /** @param {Reply & { ok: false }} reply */
  const toError = (reply) => {
    if (reply.name === 'TypeError') return new TypeError(reply.error);
    if (reply.name === 'Error') return new Error(reply.error);
    return new DOMException(reply.error, reply.name);
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  const call = async (method, params) => {
    const reply = await bridge.call(method, params);
    if (reply.ok) return reply.result;
    throw toError(/** @type {Reply & { ok: false }} */ (reply));
  };

  /**
   * @param {object} target
   * @param {string} name
   * @param {unknown} value
   */
  const define = (target, name, value) =>
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });

  /** @param {string} name */
  const protoOf = (name) => {
    const ctor = scope[name];
    return typeof ctor === 'function' ? ctor.prototype : null;
  };

  // -------------------------------------------------------------------------
  // Periodic sync
  // -------------------------------------------------------------------------

  // One per app: an app has one schedule, whichever registration asks.
  const periodicSync = Object.create(protoOf('PeriodicSyncManager') ?? Object.prototype);
  define(periodicSync, 'register', async (/** @type {string} */ tag, /** @type {{ minInterval?: number }} */ options = {}) => {
    await call('sync.register', { tag: String(tag), minInterval: Number(options.minInterval ?? 0) });
  });
  define(periodicSync, 'unregister', async (/** @type {string} */ tag) => {
    await call('sync.unregister', { tag: String(tag) });
  });
  define(periodicSync, 'getTags', () => call('sync.tags'));
  Object.defineProperty(proto, 'periodicSync', { get: () => periodicSync, configurable: true, enumerable: true });

  const permissions = navigator.permissions;
  if (permissions) {
    const nativeQuery = permissions.query.bind(permissions);
    /** @param {PermissionDescriptor} descriptor */
    const query = async (descriptor) => {
      if (descriptor?.name !== /** @type {PermissionName} */ ('periodic-background-sync')) return nativeQuery(descriptor);
      const state = await call('sync.permission');
      const status = new EventTarget();
      Object.defineProperties(status, {
        name: { value: 'periodic-background-sync', enumerable: true },
        state: { value: state, enumerable: true },
        onchange: { value: null, writable: true, enumerable: true },
      });
      return status;
    };
    define(Object.getPrototypeOf(permissions), 'query', query);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** @param {unknown} url */
  const absolute = (url) => {
    if (typeof url !== 'string' || !url) return '';
    try {
      return new URL(url, location.href).href;
    } catch {
      return '';
    }
  };

  /**
   * A notification as getNotifications() and events give it.
   * @param {Record<string, unknown>} snapshot
   */
  const toNotification = (snapshot) => {
    const notification = Object.create(protoOf('Notification') ?? Object.prototype);
    for (const [name, value] of Object.entries(snapshot)) {
      if (name !== 'id') Object.defineProperty(notification, name, { value, enumerable: true });
    }
    define(notification, 'vibrate', Object.freeze([]));
    define(notification, 'close', () => void bridge.call('notification.close', { id: snapshot.id }));
    return notification;
  };

  /**
   * @param {string} title
   * @param {NotificationOptions & { actions?: { action: string, title: string }[], image?: string, renotify?: boolean, timestamp?: number }} [options]
   */
  async function showNotification(title, options = {}) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'showNotification': 1 argument required.");
    await call('notification.show', {
      title: String(title),
      options: {
        body: options.body,
        tag: options.tag,
        icon: absolute(options.icon),
        badge: absolute(options.badge),
        image: absolute(options.image),
        data: options.data,
        actions: (options.actions ?? []).map((a) => ({ action: String(a.action), title: String(a.title) })),
        silent: options.silent,
        renotify: options.renotify,
        requireInteraction: options.requireInteraction,
        timestamp: options.timestamp,
        dir: options.dir,
        lang: options.lang,
      },
    });
  }

  /** @param {GetNotificationOptions} [filter] */
  async function getNotifications(filter = {}) {
    const list = /** @type {Record<string, unknown>[]} */ (await call('notification.list', { tag: filter.tag ?? '' }));
    return list.map(toNotification);
  }

  define(proto, 'showNotification', showNotification);
  define(proto, 'getNotifications', getNotifications);

  if (!inWorker) return;

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  /**
   * @typedef {{ id: string, url: string }} WorkerClient
   * @this {{ matchAll: (options: { type: string, includeUncontrolled: boolean }) => Promise<readonly WorkerClient[]> }}
   * @param {string | URL} url
   */
  async function openWindow(url) {
    const target = new URL(String(url), location.href).href;
    const before = new Set((await this.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => c.id));
    await call('clients.open', { url: target });
    // The app's new window loads its own page; hand back its client once it has.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const windows = await this.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((c) => !before.has(c.id));
      if (client) return client;
    }
    return null;
  }

  /** @this {WorkerClient} */
  async function focus() {
    await call('clients.focus');
    return this;
  }

  if (typeof scope.Clients === 'function') define(scope.Clients.prototype, 'openWindow', openWindow);
  if (typeof scope.WindowClient === 'function') define(scope.WindowClient.prototype, 'focus', focus);

  /**
   * Raise one event din-app-workers.mts sent, and wait for what it asked to be waited on.
   * @param {string} type
   * @param {Record<string, unknown>} init
   */
  const raise = async (type, init) => {
    const event = new Event(type);
    /** @type {Promise<unknown>[]} */
    const waits = [];
    let open = true;
    define(event, 'waitUntil', (/** @type {unknown} */ promise) => {
      if (!open) throw new DOMException('The event handler is already finished.', 'InvalidStateError');
      waits.push(Promise.resolve(promise));
    });

    let eventProto = protoOf('ExtendableEvent');
    if (type === 'notificationclick' || type === 'notificationclose') {
      eventProto = protoOf('NotificationEvent') ?? eventProto;
      const notification = toNotification(/** @type {Record<string, unknown>} */ (init.notification));
      Object.defineProperty(event, 'notification', { value: notification, enumerable: true });
      Object.defineProperty(event, 'action', { value: typeof init.action === 'string' ? init.action : '', enumerable: true });
      Object.defineProperty(event, 'reply', { value: null, enumerable: true });
    } else if (type === 'periodicsync') {
      eventProto = protoOf('PeriodicSyncEvent') ?? eventProto;
      Object.defineProperty(event, 'tag', { value: String(init.tag), enumerable: true });
    }
    if (eventProto) Object.setPrototypeOf(event, eventProto);

    self.dispatchEvent(event);
    // Promises handed over while waiting are waited on too.
    for (let settled = 0; settled < waits.length; ) {
      const batch = waits.slice(settled);
      settled = waits.length;
      await Promise.allSettled(batch);
    }
    open = false;
  };

  bridge.listen((id, type, init) => {
    raise(type, init).then(
      () => bridge.done(id, true),
      () => bridge.done(id, false),
    );
  });
}

const isWorker = typeof window === 'undefined';

// A worker's preload has no `location`: installAppWorkers checks its scope's.
if (isWorker || location.protocol === 'din:' || location.protocol === 'din+file:') {
  /** @type {((id: number, type: string, init: Record<string, unknown>) => void) | null} */
  let listener = null;
  if (isWorker) ipcRenderer.on('din-app-sw:dispatch', (_event, id, type, init) => listener?.(id, type, init));

  // A worker that starts before din-app-workers.mts has seen it gets "no
  // handler": once more after a beat.
  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<Reply>}
   */
  const invoke = (method, params) =>
    ipcRenderer.invoke('din-app-sw:call', method, params).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ipcRenderer
        .invoke('din-app-sw:call', method, params)
        .catch(() => ({ ok: false, error: 'Din is unavailable', name: 'Error' }));
    });

  contextBridge.executeInMainWorld({
    func: installAppWorkers,
    args: [
      {
        call: invoke,
        listen: (/** @type {(id: number, type: string, init: Record<string, unknown>) => void} */ callback) => {
          listener = callback;
        },
        done: (/** @type {number} */ id, /** @type {boolean} */ ok) => ipcRenderer.send('din-app-sw:dispatched', id, ok),
      },
    ],
  });
}
