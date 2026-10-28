// @ts-check
// Session preload for nsites: what napp.mts gives installed ones, in the
// shape Tenna's NAPP.md gives it, so a site written for Tenna runs unchanged.
// Registered in main.mts on the browser's session twice, as a frame preload
// and as a service-worker preload; it works out which it is and does nothing
// outside an nsite. An installed site gets the same in its app's window and
// in a browser tab.
//
// In the page (top document), when the site is installed:
//   - window.napp.push.set/get and window.napp.fetch
//   - registration.showNotification / getNotifications, into Din's
//     notification center (Chromium's would go to libnotify)
//   - registration.periodicSync, and its permission in navigator.permissions
// In every frame of the site's own origin: window.ENV, when the user has set
// variables for the site.
// In every frame and the service worker, installed or not: the Cache API,
// keying the site's own nsite:// URLs.
//
// In the service worker (which can't ask whether its site is installed before
// its script runs, so napp.mts refuses calls from one that isn't, and
// notifications then go to Chromium's own):
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
 *   installed: boolean,
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

  /** @param {unknown} error */
  const notInstalled = (error) => error instanceof DOMException && error.name === 'NotInstalledError';

  const Registration = scope.ServiceWorkerRegistration;
  if (typeof Registration === 'function' && bridge.installed && (inWorker || bridge.top)) {
    const proto = Registration.prototype;
    const native = { showNotification: proto.showNotification, getNotifications: proto.getNotifications };

    /**
     * @this {ServiceWorkerRegistration}
     * @param {string} title
     * @param {NotificationOptions & { actions?: { action: string, title: string, icon?: string }[], image?: string, renotify?: boolean, timestamp?: number }} [options]
     */
    async function showNotification(title, options = {}) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'showNotification': 1 argument required.");
      try {
        await sendNotification(title, options);
      } catch (error) {
        if (!notInstalled(error)) throw error;
        await native.showNotification.call(this, title, options);
      }
    }

    /**
     * @param {string} title
     * @param {NotificationOptions & { actions?: { action: string, title: string, icon?: string }[], image?: string, renotify?: boolean, timestamp?: number }} options
     */
    async function sendNotification(title, options) {
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

    /**
     * @this {ServiceWorkerRegistration}
     * @param {GetNotificationOptions} [filter]
     */
    async function getNotifications(filter = {}) {
      try {
        const list = /** @type {Record<string, unknown>[]} */ (await call('notification.list', { tag: filter.tag ?? '' }));
        return list.map(toNotification);
      } catch (error) {
        if (!notInstalled(error)) throw error;
        return native.getNotifications.call(this, filter);
      }
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
  // The Cache API
  // -------------------------------------------------------------------------

  // Chromium's Cache API keys only http(s) URLs: `cache.put('/x', response)`
  // on nsite:// throws "Request scheme 'nsite' is unsupported", and so does
  // every `add`/`addAll` precache. A site's own URL is kept under a stand-in of
  // the same host, `https://<host>/x`, and turned back on the way out; anybody
  // else's URL is left alone. As Tenna does on iOS (tenna/src/lib/idb/caches.ts).
  const CacheCtor = /** @type {typeof Cache | undefined} */ (scope.Cache);
  const StorageCtor = /** @type {typeof CacheStorage | undefined} */ (scope.CacheStorage);
  if (CacheCtor && StorageCtor) {
    const CacheProto = CacheCtor.prototype;
    const StorageProto = StorageCtor.prototype;
    const NativeRequest = Request;
    const nativeFetch = fetch;
    const own = { protocol: location.protocol, host: location.host };
    const standIn = `https://${own.host}`;
    const native = {
      match: CacheProto.match,
      matchAll: CacheProto.matchAll,
      addAll: CacheProto.addAll,
      put: CacheProto.put,
      delete: CacheProto.delete,
      keys: CacheProto.keys,
      storageMatch: StorageProto.match,
    };

    /** @param {string} href */
    const toKey = (href) => {
      let url;
      try {
        url = new URL(href, location.href);
      } catch {
        return null;
      }
      if (url.protocol !== own.protocol || url.host !== own.host) return null;
      return standIn + url.pathname + url.search + url.hash;
    };

    /** @param {string} href */
    const fromKey = (href) =>
      href.startsWith(`${standIn}/`) ? `${own.protocol}//${own.host}${href.slice(standIn.length)}` : null;

    /**
     * A request like `request`, at another URL: only what matching reads, and
     * keys() hands back, comes along.
     * @param {Request} request
     * @param {string} url
     */
    const moved = (request, url) =>
      new NativeRequest(url, {
        method: request.method,
        headers: request.headers,
        mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
        credentials: request.credentials,
        cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
        redirect: request.redirect,
        integrity: request.integrity,
        referrerPolicy: request.referrerPolicy,
      });

    /**
     * What a native method is given in place of a site's `request`.
     * @param {unknown} request
     * @returns {any}
     */
    const inward = (request) => {
      if (request instanceof NativeRequest) {
        const key = toKey(request.url);
        return key ? moved(request, key) : request;
      }
      if (typeof request === 'string' || request instanceof URL) return toKey(String(request)) ?? request;
      return request;
    };

    /** @param {Request} request */
    const outward = (request) => {
      const url = fromKey(request.url);
      return url ? moved(request, url) : request;
    };

    // Fetches for itself: the native addAll would fetch the stand-in.
    /**
     * @param {Cache} cache
     * @param {Iterable<RequestInfo | URL>} requests
     */
    const addAll = async (cache, requests) => {
      const list = Array.from(requests, (request) => new NativeRequest(request));
      for (const request of list) {
        if (request.method !== 'GET') throw new TypeError('Cache.addAll: only GET requests can be cached.');
      }
      const responses = await Promise.all(list.map((request) => nativeFetch(request)));
      for (const response of responses) {
        if (!response.ok) throw new TypeError(`Cache.addAll: a response had status ${response.status}.`);
        if (response.headers.get('Vary')?.split(',').some((field) => field.trim() === '*')) {
          throw new TypeError("Cache.addAll: a response had 'Vary: *'.");
        }
      }
      await Promise.all(list.map((request, i) => native.put.call(cache, inward(request), responses[i])));
    };

    /** @type {Record<string, (this: any, ...args: any[]) => unknown>} */
    const cacheMethods = {
      match(request, options) {
        return native.match.call(this, inward(request), options);
      },
      matchAll(...args) {
        if (args.length && args[0] !== undefined) args[0] = inward(args[0]);
        return native.matchAll.apply(this, /** @type {[]} */ (args));
      },
      add(request) {
        return cacheMethods.addAll.call(this, [request]);
      },
      addAll(requests) {
        // A brand check before anything is fetched, as the platform's does.
        if (!(this instanceof CacheCtor)) return native.addAll.call(this, requests);
        return addAll(this, requests);
      },
      put(request, response) {
        return native.put.call(this, inward(request), response);
      },
      delete(request, options) {
        return native.delete.call(this, inward(request), options);
      },
      async keys(...args) {
        if (args.length && args[0] !== undefined) args[0] = inward(args[0]);
        const requests = await native.keys.apply(this, /** @type {[]} */ (args));
        return requests.map(outward);
      },
    };
    /** @type {Record<string, (this: any, ...args: any[]) => unknown>} */
    const storageMethods = {
      match(request, options) {
        return native.storageMatch.call(this, inward(request), options);
      },
    };

    /** @type {Record<string, number>} */
    const lengths = { match: 1, matchAll: 0, add: 1, addAll: 1, put: 2, delete: 1, keys: 0 };
    /**
     * @param {object} proto
     * @param {Record<string, Function>} methods
     */
    const patch = (proto, methods) => {
      for (const [name, method] of Object.entries(methods)) {
        Object.defineProperty(method, 'name', { value: name });
        Object.defineProperty(method, 'length', { value: lengths[name] });
        Object.defineProperty(proto, name, { value: method, writable: true, configurable: true, enumerable: true });
      }
    };
    patch(CacheProto, cacheMethods);
    patch(StorageProto, storageMethods);
  }

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  if (!inWorker) {
    if (bridge.env) {
      Object.defineProperty(window, 'ENV', { value: Object.freeze({ ...bridge.env }), enumerable: false });
    }
    if (!bridge.top || !bridge.installed) return true;

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

  /** @type {{ installed: boolean, env: Record<string, string> | null } | null} */
  const frame = isWorker ? null : ipcRenderer.sendSync('napp:frame');

  contextBridge.executeInMainWorld({
    func: installNapp,
    args: [
      {
        call: invoke,
        listen: (/** @type {(id: number, type: string, init: Record<string, unknown>) => void} */ callback) => {
          listener = callback;
        },
        done: (/** @type {number} */ id, /** @type {boolean} */ ok) => ipcRenderer.send('napp:dispatched', id, ok),
        env: frame?.env ?? null,
        // A worker is taken as installed; napp.mts answers for it per call.
        installed: isWorker || frame?.installed === true,
        top: !isWorker && window.top === window.self,
      },
    ],
  });
}
