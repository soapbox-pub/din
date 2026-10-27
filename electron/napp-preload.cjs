// @ts-check
// Session preload for installed nsites: what napp.mts gives them, in the
// shape Tenna's NAPP.md gives it, so a site written for Tenna runs unchanged.
// Registered in main.mts on the apps session twice, as a frame preload and as
// a service-worker preload; it works out which it is and does nothing outside
// an nsite.
//
// In the page (top document):
//   - window.napp.push.set/get and window.napp.fetch
//   - registration.showNotification / getNotifications, into Din's
//     notification center (Chromium's would go to libnotify)
//   - registration.periodicSync, and its permission in navigator.permissions
// In every frame of the site's own origin: window.ENV, when the user has set
// variables for the site.
//
// In the service worker:
//   - self.napp.fetch
//   - registration.showNotification / getNotifications, pushManager (read
//     only: a site subscribes from its page, with napp.push.set) and
//     periodicSync
//   - clients.openWindow / WindowClient.focus, which move the app's window
//   - the push, notificationclick, notificationclose and periodicsync events
//     napp.mts raises, with waitUntil() waited on before it's told they ran
//
// Every call goes to napp.mts, which reads the site from the calling frame or
// worker and decides there; nothing here is trusted.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {{ ok: true, result: unknown } | { ok: false, error: string, name: string }} Reply
 * @typedef {{
 *   call: (method: string, params?: unknown) => Promise<Reply>,
 *   listen: (callback: (id: number, type: string, init: Record<string, unknown>) => void) => void,
 *   done: (id: number, ok: boolean) => void,
 *   env: Record<string, string> | null,
 *   top: boolean,
 * }} Bridge
 */

/**
 * Runs in the site's world (its page, or its worker): everything it needs
 * comes in through `bridge`.
 * @param {Bridge} bridge
 * @returns {boolean} whether this is an nsite (and the bridge is in use)
 */
function installNapp(bridge) {
  if (location.protocol !== 'nsite:') return false;
  const scope = /** @type {typeof globalThis & Record<string, unknown>} */ (globalThis);
  const inWorker = typeof scope.ServiceWorkerGlobalScope === 'function' && self instanceof /** @type {any} */ (scope.ServiceWorkerGlobalScope);

  /** @param {Reply & { ok: false }} reply */
  const toError = (reply) => {
    if (reply.name === 'TypeError') return new TypeError(reply.error);
    if (reply.name === 'Error') return new Error(reply.error);
    return new DOMException(reply.error, reply.name);
  };

  /**
   * @param {string} method
   * @param {unknown} [params]
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

  /**
   * @param {object} target
   * @param {string} name
   * @param {() => unknown} get
   */
  const getter = (target, name, get) =>
    Object.defineProperty(target, name, { get, configurable: true, enumerable: true });

  // -------------------------------------------------------------------------
  // napp.fetch
  // -------------------------------------------------------------------------

  const NULL_BODY = new Set([101, 103, 204, 205, 304]);

  /**
   * fetch's signature, for hosts that send no CORS headers.
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   */
  const nappFetch = async (input, init) => {
    const request = new Request(input, init);
    const { signal } = request;
    if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const head = /** @type {{ id: number, status: number, statusText: string, headers: [string, string][] }} */ (
      await call('fetch.start', {
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body,
        redirect: request.redirect,
      })
    );
    const abort = () => void bridge.call('fetch.abort', head.id);
    signal.addEventListener('abort', abort, { once: true });
    const nullBody = NULL_BODY.has(head.status) || request.method === 'HEAD';
    if (nullBody) abort();
    const stream = nullBody
      ? null
      : new ReadableStream(
          {
            async pull(controller) {
              if (signal.aborted) {
                controller.error(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                return;
              }
              const chunk = /** @type {Uint8Array | null} */ (await call('fetch.read', head.id));
              if (chunk === null) {
                signal.removeEventListener('abort', abort);
                controller.close();
              } else {
                controller.enqueue(chunk);
              }
            },
            cancel: abort,
          },
          { highWaterMark: 0 },
        );
    return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers });
  };

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
   * A page's blob: URL names bytes only the page has: sent as a data: URL.
   * @param {string} url
   */
  const inline = async (url) => {
    if (!url.startsWith('blob:')) return url;
    try {
      const blob = await (await fetch(url)).blob();
      if (!blob.type.startsWith('image/') || blob.size > 48 * 1024) return '';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:${blob.type};base64,${btoa(binary)}`;
    } catch {
      return '';
    }
  };

  /**
   * A notification as getNotifications() and events give it.
   * @param {Record<string, unknown>} snapshot
   */
  const toNotification = (snapshot) => {
    const notification = Object.create(typeof Notification === 'function' ? Notification.prototype : Object.prototype);
    for (const [name, value] of Object.entries(snapshot)) {
      if (name !== 'id') Object.defineProperty(notification, name, { value, enumerable: true });
    }
    define(notification, 'vibrate', Object.freeze([]));
    define(notification, 'close', () => void bridge.call('notification.close', snapshot.id));
    return notification;
  };

  const Registration = scope.ServiceWorkerRegistration;
  if (typeof Registration === 'function' && (inWorker || bridge.top)) {
    const proto = Registration.prototype;

    /**
     * @param {string} title
     * @param {NotificationOptions & { actions?: { action: string, title: string, icon?: string }[], image?: string, renotify?: boolean, timestamp?: number }} [options]
     */
    async function showNotification(title, options = {}) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'showNotification': 1 argument required.");
      await call('notification.show', {
        title: String(title),
        options: {
          body: options.body,
          tag: options.tag,
          icon: await inline(absolute(options.icon)),
          badge: await inline(absolute(options.badge)),
          image: await inline(absolute(options.image)),
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

    // registration.periodicSync
    const periodicSync = Object.freeze({
      /**
       * @param {string} tag
       * @param {{ minInterval?: number }} [options]
       */
      register: async (tag, options = {}) => {
        await call('sync.register', { tag: String(tag), minInterval: Number(options.minInterval ?? 0) });
      },
      /** @param {string} tag */
      unregister: async (tag) => {
        await call('sync.unregister', String(tag));
      },
      getTags: () => call('sync.tags'),
    });
    getter(proto, 'periodicSync', () => periodicSync);

    // registration.pushManager, in the worker only: what napp.push.set holds.
    if (inWorker) {
      const subscription = Object.freeze({
        endpoint: 'napp:push',
        expirationTime: null,
        options: Object.freeze({ userVisibleOnly: false, applicationServerKey: null }),
        getKey: () => null,
        toJSON: () => ({ endpoint: 'napp:push', expirationTime: null, keys: {} }),
        unsubscribe: () => call('push.unsubscribe'),
      });
      const subscribed = async () => /** @type {unknown[]} */ (await call('push.get')).length > 0;
      const pushManager = Object.freeze({
        getSubscription: async () => ((await subscribed()) ? subscription : null),
        permissionState: async () => ((await subscribed()) ? 'granted' : 'prompt'),
        subscribe: async () => {
          throw new DOMException('Subscribe from the page, with napp.push.set().', 'NotSupportedError');
        },
      });
      getter(proto, 'pushManager', () => pushManager);
    }
  }

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  if (!inWorker) {
    if (bridge.env) {
      Object.defineProperty(window, 'ENV', { value: Object.freeze({ ...bridge.env }), enumerable: false });
    }
    if (!bridge.top) return true;

    const push = Object.freeze({
      /** @param {unknown} subscriptions */
      set: async (subscriptions) => {
        await call('push.set', subscriptions);
      },
      get: () => call('push.get'),
    });
    Object.defineProperty(window, 'napp', { value: Object.freeze({ push, fetch: nappFetch }), enumerable: false });

    const permissions = navigator.permissions;
    if (permissions) {
      const nativeQuery = permissions.query.bind(permissions);
      /** @param {PermissionDescriptor} descriptor */
      const query = async (descriptor) => {
        if (descriptor?.name !== /** @type {PermissionName} */ ('periodic-background-sync')) return nativeQuery(descriptor);
        const answer = /** @type {NotificationPermission} */ (await call('sync.permission'));
        const status = new EventTarget();
        Object.defineProperties(status, {
          name: { value: 'periodic-background-sync', enumerable: true },
          state: { value: answer === 'default' ? 'prompt' : answer, enumerable: true },
          onchange: { value: null, writable: true, enumerable: true },
        });
        return status;
      };
      define(Object.getPrototypeOf(permissions), 'query', query);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  Object.defineProperty(self, 'napp', { value: Object.freeze({ fetch: nappFetch }), enumerable: false });

  /**
   * @typedef {{ url: string }} WorkerClient
   * @this {{ matchAll: (options: { type: string, includeUncontrolled: boolean }) => Promise<readonly WorkerClient[]> }}
   * @param {string | URL} url
   */
  async function openWindow(url) {
    const target = new URL(String(url), location.href).href;
    await call('clients.open', target);
    // The app's window navigates there; hand back its client once it has.
    for (let i = 0; i < 30; i++) {
      const windows = await this.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((c) => c.url === target);
      if (client) return client;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /** @this {WorkerClient} */
  async function focus() {
    await call('clients.focus');
    return this;
  }

  const Clients = scope.Clients;
  if (typeof Clients === 'function') define(Clients.prototype, 'openWindow', openWindow);
  const WindowClient = scope.WindowClient;
  if (typeof WindowClient === 'function') define(WindowClient.prototype, 'focus', focus);

  /**
   * @param {string} name
   * @returns {object | null}
   */
  const protoOf = (name) => {
    const ctor = scope[name];
    return typeof ctor === 'function' ? ctor.prototype : null;
  };

  /**
   * Raise one event napp.mts sent, and wait for what it asked to be waited on.
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

    let proto = protoOf('ExtendableEvent');
    if (type === 'push') {
      proto = protoOf('PushEvent') ?? proto;
      const json = JSON.stringify(init);
      const data = Object.create(protoOf('PushMessageData') ?? Object.prototype);
      define(data, 'text', () => json);
      define(data, 'json', () => JSON.parse(json));
      define(data, 'arrayBuffer', () => new TextEncoder().encode(json).buffer);
      define(data, 'bytes', () => new TextEncoder().encode(json));
      define(data, 'blob', () => new Blob([json], { type: 'application/json' }));
      Object.defineProperty(event, 'data', { value: data, enumerable: true });
    } else if (type === 'notificationclick' || type === 'notificationclose') {
      proto = protoOf('NotificationEvent') ?? proto;
      const notification = toNotification(/** @type {Record<string, unknown>} */ (init.notification));
      Object.defineProperty(event, 'notification', { value: notification, enumerable: true });
      Object.defineProperty(event, 'action', { value: typeof init.action === 'string' ? init.action : '', enumerable: true });
      Object.defineProperty(event, 'reply', { value: null, enumerable: true });
    } else if (type === 'periodicsync') {
      proto = protoOf('PeriodicSyncEvent') ?? proto;
      Object.defineProperty(event, 'tag', { value: String(init.tag), enumerable: true });
    }
    if (proto) Object.setPrototypeOf(event, proto);

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
  return true;
}

const isWorker = typeof window === 'undefined';

if (isWorker || location.protocol === 'nsite:') {
  /** @type {((id: number, type: string, init: Record<string, unknown>) => void) | null} */
  let listener = null;
  if (isWorker) ipcRenderer.on('napp:dispatch', (_event, id, type, init) => listener?.(id, type, init));

  // A worker that starts before napp.mts has seen it gets "no handler": once
  // more after a beat.
  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<Reply>}
   */
  const invoke = (method, params) =>
    ipcRenderer.invoke('napp:call', method, params).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ipcRenderer
        .invoke('napp:call', method, params)
        .catch(() => ({ ok: false, error: 'Din is unavailable', name: 'Error' }));
    });

  contextBridge.executeInMainWorld({
    func: installNapp,
    args: [
      {
        call: invoke,
        listen: (/** @type {(id: number, type: string, init: Record<string, unknown>) => void} */ callback) => {
          listener = callback;
        },
        done: (/** @type {number} */ id, /** @type {boolean} */ ok) => ipcRenderer.send('napp:dispatched', id, ok),
        env: isWorker ? null : ipcRenderer.sendSync('napp:env'),
        top: !isWorker && window.top === window.self,
      },
    ],
  });
}
