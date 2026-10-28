// @ts-check
// Session preload for websites (browser tabs and installed web apps): what
// web-push.mts gives their service workers, in the shape Chrome gives it.
// Registered in main.mts on both sessions twice, as a frame preload and as a
// service-worker preload; it works out which it is and does nothing outside
// http(s).
//
// In every frame and the worker:
//   - registration.pushManager: subscribe, getSubscription, permissionState,
//     and the PushSubscription they give (unsubscribe, getKey, toJSON)
//   - registration.showNotification / getNotifications, into Din's
//     notification center (Electron shows none from a registration)
//   - registration.unregister, which ends the registration's subscription
// In the service worker:
//   - clients.openWindow / WindowClient.focus, through the shell
//   - the push, pushsubscriptionchange, notificationclick and
//     notificationclose events web-push.mts raises, with waitUntil() waited
//     on before it's told they ran
//
// Every call goes to web-push.mts, which reads the site from the calling
// frame or worker and decides there; nothing here is trusted.
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
 * @typedef {{
 *   endpoint: string,
 *   expirationTime: null,
 *   options: { userVisibleOnly: boolean, applicationServerKey: string | null },
 *   keys: { p256dh: string, auth: string },
 * }} SubscriptionJson
 */

/**
 * Runs in the site's world (its page, or its worker): everything it needs
 * comes in through `bridge`.
 * @param {Bridge} bridge
 */
function installWebPush(bridge) {
  if (!/^https?:$/.test(location.protocol)) return;
  const scope = /** @type {typeof globalThis & Record<string, any>} */ (globalThis);
  const inWorker = typeof scope.ServiceWorkerGlobalScope === 'function' && self instanceof scope.ServiceWorkerGlobalScope;
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
    return typeof ctor === 'function' ? ctor.prototype : Object.prototype;
  };

  /** @param {string} text base64url, padded or not */
  const decode = (text) => {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };

  /** @param {unknown} key an applicationServerKey: a BufferSource or base64url */
  const keyBytes = (key) => {
    if (key === null || key === undefined) return null;
    if (typeof key === 'string') {
      try {
        return decode(key);
      } catch {
        throw new DOMException('The provided applicationServerKey is not encoded as base64url without padding.', 'InvalidCharacterError');
      }
    }
    if (key instanceof ArrayBuffer) return new Uint8Array(key.slice(0));
    if (ArrayBuffer.isView(key)) return new Uint8Array(key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength));
    throw new TypeError("Failed to execute 'subscribe' on 'PushManager': The provided value is not of type '(ArrayBuffer or ArrayBufferView or DOMString)'.");
  };

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  /**
   * A PushSubscription for what web-push.mts holds for `scopeUrl`.
   * @param {SubscriptionJson} json
   * @param {string} scopeUrl
   */
  const toSubscription = (json, scopeUrl) => {
    const subscription = Object.create(protoOf('PushSubscription'));
    const serverKey = json.options.applicationServerKey ? decode(json.options.applicationServerKey).buffer : null;
    const options = Object.create(protoOf('PushSubscriptionOptions'));
    Object.defineProperty(options, 'userVisibleOnly', { value: json.options.userVisibleOnly, enumerable: true });
    Object.defineProperty(options, 'applicationServerKey', { value: serverKey, enumerable: true });
    Object.defineProperty(subscription, 'endpoint', { value: json.endpoint, enumerable: true });
    Object.defineProperty(subscription, 'expirationTime', { value: null, enumerable: true });
    Object.defineProperty(subscription, 'options', { value: options, enumerable: true });
    define(subscription, 'getKey', (/** @type {string} */ name) => {
      if (name === 'p256dh') return decode(json.keys.p256dh).buffer;
      if (name === 'auth') return decode(json.keys.auth).buffer;
      return null;
    });
    define(subscription, 'toJSON', () => ({
      endpoint: json.endpoint,
      expirationTime: null,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }));
    define(subscription, 'unsubscribe', async () => {
      // Another subscription has taken this one's place: this one is gone already.
      const current = /** @type {SubscriptionJson | null} */ (await call('push.get', { scope: scopeUrl }));
      if (!current || current.endpoint !== json.endpoint) return false;
      return /** @type {boolean} */ (await call('push.unsubscribe', { scope: scopeUrl }));
    });
    return subscription;
  };

  /** @type {WeakMap<object, object>} */
  const managers = new WeakMap();

  /** @param {ServiceWorkerRegistration} registration */
  const createPushManager = (registration) => {
    /** @type {object} */
    const manager = Object.create(protoOf('PushManager'));
    define(manager, 'subscribe', async (/** @type {PushSubscriptionOptionsInit} */ options = {}) => {
      if (!registration.active) {
        throw new DOMException('Subscription failed - no active Service Worker', 'AbortError');
      }
      const json = /** @type {SubscriptionJson} */ (
        await call('push.subscribe', {
          scope: registration.scope,
          options: {
            userVisibleOnly: options.userVisibleOnly === true,
            applicationServerKey: keyBytes(options.applicationServerKey),
          },
        })
      );
      return toSubscription(json, registration.scope);
    });
    define(manager, 'getSubscription', async () => {
      const json = /** @type {SubscriptionJson | null} */ (await call('push.get', { scope: registration.scope }));
      return json ? toSubscription(json, registration.scope) : null;
    });
    define(manager, 'permissionState', () => call('push.permission', { scope: registration.scope }));
    return manager;
  };

  /**
   * registration.pushManager: one per registration, as the platform keeps it.
   * @this {ServiceWorkerRegistration}
   */
  function pushManager() {
    let manager = managers.get(this);
    if (!manager) {
      manager = createPushManager(this);
      managers.set(this, manager);
    }
    return manager;
  }
  Object.defineProperty(proto, 'pushManager', { get: pushManager, configurable: true, enumerable: true });

  // The registration's subscription goes with it.
  const nativeUnregister = proto.unregister;
  /** @this {ServiceWorkerRegistration} */
  async function unregister() {
    const gone = await nativeUnregister.call(this);
    if (gone) await bridge.call('registration.unregistered', { scope: this.scope });
    return gone;
  }
  define(proto, 'unregister', unregister);

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
   * @param {string} scopeUrl
   */
  const toNotification = (snapshot, scopeUrl) => {
    const notification = Object.create(protoOf('Notification'));
    for (const [name, value] of Object.entries(snapshot)) {
      if (name !== 'id') Object.defineProperty(notification, name, { value, enumerable: true });
    }
    define(notification, 'vibrate', Object.freeze([]));
    define(notification, 'close', () => void bridge.call('notification.close', { scope: scopeUrl, id: snapshot.id }));
    return notification;
  };

  /**
   * @this {ServiceWorkerRegistration}
   * @param {string} title
   * @param {NotificationOptions & { actions?: { action: string, title: string, icon?: string }[], image?: string, renotify?: boolean, timestamp?: number }} [options]
   */
  async function showNotification(title, options = {}) {
    if (arguments.length === 0) throw new TypeError("Failed to execute 'showNotification': 1 argument required.");
    await call('notification.show', {
      scope: this.scope,
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
    const list = /** @type {Record<string, unknown>[]} */ (
      await call('notification.list', { scope: this.scope, tag: filter.tag ?? '' })
    );
    return list.map((snapshot) => toNotification(snapshot, this.scope));
  }

  define(proto, 'showNotification', showNotification);
  define(proto, 'getNotifications', getNotifications);

  if (!inWorker) return;

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  /**
   * @typedef {{ url: string }} WorkerClient
   * @this {{ matchAll: (options: { type: string, includeUncontrolled: boolean }) => Promise<readonly WorkerClient[]> }}
   * @param {string | URL} url
   */
  async function openWindow(url) {
    const target = new URL(String(url), location.href).href;
    await call('clients.open', { url: target });
    // The tab or app opens there; hand back its client if it's ours to see.
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
    await call('clients.focus', { url: this.url });
    return this;
  }

  if (typeof scope.Clients === 'function') define(scope.Clients.prototype, 'openWindow', openWindow);
  if (typeof scope.WindowClient === 'function') define(scope.WindowClient.prototype, 'focus', focus);

  const ownScope = () => /** @type {ServiceWorkerRegistration} */ (scope.registration).scope;

  /** @param {Uint8Array | null} bytes */
  const toMessageData = (bytes) => {
    if (!bytes) return null;
    const data = Object.create(protoOf('PushMessageData'));
    const copy = () => new Uint8Array(bytes);
    define(data, 'arrayBuffer', () => copy().buffer);
    define(data, 'bytes', copy);
    define(data, 'blob', () => new Blob([copy()]));
    define(data, 'text', () => new TextDecoder().decode(bytes));
    define(data, 'json', () => JSON.parse(new TextDecoder().decode(bytes)));
    return data;
  };

  /**
   * Raise one event web-push.mts sent, and wait for what it asked to be waited on.
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
    if (type === 'push') {
      eventProto = protoOf('PushEvent');
      const data = toMessageData(/** @type {Uint8Array | null} */ (init.data));
      Object.defineProperty(event, 'data', { value: data, enumerable: true });
    } else if (type === 'pushsubscriptionchange') {
      eventProto = protoOf('PushSubscriptionChangeEvent');
      const old = /** @type {SubscriptionJson | null} */ (init.oldSubscription);
      const next = /** @type {SubscriptionJson | null} */ (init.newSubscription);
      Object.defineProperty(event, 'oldSubscription', { value: old && toSubscription(old, ownScope()), enumerable: true });
      Object.defineProperty(event, 'newSubscription', { value: next && toSubscription(next, ownScope()), enumerable: true });
    } else if (type === 'notificationclick' || type === 'notificationclose') {
      eventProto = protoOf('NotificationEvent');
      const snapshot = /** @type {Record<string, unknown>} */ (init.notification);
      Object.defineProperty(event, 'notification', { value: toNotification(snapshot, ownScope()), enumerable: true });
      Object.defineProperty(event, 'action', { value: typeof init.action === 'string' ? init.action : '', enumerable: true });
      Object.defineProperty(event, 'reply', { value: null, enumerable: true });
    }
    Object.setPrototypeOf(event, eventProto);

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

// A worker's preload has no `location`: installWebPush checks its scope's.
if (isWorker || /^https?:$/.test(location.protocol)) {
  /** @type {((id: number, type: string, init: Record<string, unknown>) => void) | null} */
  let listener = null;
  if (isWorker) ipcRenderer.on('web-push:dispatch', (_event, id, type, init) => listener?.(id, type, init));

  // A worker that starts before web-push.mts has seen it gets "no handler":
  // once more after a beat.
  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<Reply>}
   */
  const invoke = (method, params) =>
    ipcRenderer.invoke('web-push:call', method, params).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return ipcRenderer
        .invoke('web-push:call', method, params)
        .catch(() => ({ ok: false, error: 'Din is unavailable', name: 'Error' }));
    });

  contextBridge.executeInMainWorld({
    func: installWebPush,
    args: [
      {
        call: invoke,
        listen: (/** @type {(id: number, type: string, init: Record<string, unknown>) => void} */ callback) => {
          listener = callback;
        },
        done: (/** @type {number} */ id, /** @type {boolean} */ ok) => ipcRenderer.send('web-push:dispatched', id, ok),
      },
    ],
  });
}
