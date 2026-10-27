// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - putting their notifications in Din's notification
// center (see electron/notifications.mts).
//
// Chromium shows a page's `new Notification()` through libnotify, which
// can't say which site or tab sent it, or bring that tab forward when it's
// clicked. This swaps in a Notification that hands the notification to the
// main process instead and fires the page's click and close events when the
// user acts on it in Din. Permission is still Chromium's: asked through the
// same prompt, and checked again in the main process for every notification.
//
// registration.showNotification() isn't covered here. Installed nsites get
// theirs from napp-preload.cjs, which also runs in their service workers;
// anyone else's still goes through libnotify, to Din's D-Bus server.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload. Top documents of web pages only.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world: everything it needs comes in through `bridge`.
 * @param {{
 *   permission: () => NotificationPermission,
 *   show: (options: Record<string, unknown>) => Promise<number | null>,
 *   close: (id: number) => void,
 *   listen: (callback: (id: number, type: string) => void) => void,
 * }} bridge
 */
function installNotification(bridge) {
  const Native = window.Notification;
  if (typeof Native !== 'function') return;

  /** @type {Map<number, (type: string) => void>} */
  const live = new Map();
  bridge.listen((id, type) => {
    const fire = live.get(id);
    if (type === 'close') live.delete(id);
    fire?.(type);
  });

  /** @param {unknown} url */
  const absolute = (url) => {
    if (typeof url !== 'string' || !url) return '';
    try {
      return new URL(url, location.href).href;
    } catch {
      return '';
    }
  };

  class Notification extends EventTarget {
    static get permission() {
      return bridge.permission();
    }

    /** @param {NotificationPermissionCallback} [callback] */
    static requestPermission(callback) {
      return Native.requestPermission(callback);
    }

    static get maxActions() {
      return 0;
    }

    /** @type {number | null} */
    #id = null;
    #closed = false;
    #closeRequested = false;

    /**
     * @param {string} title
     * @param {NotificationOptions} [options]
     */
    constructor(title, options = {}) {
      super();
      if (arguments.length === 0) throw new TypeError("Failed to construct 'Notification': 1 argument required.");
      this.title = String(title);
      this.body = options.body === undefined ? '' : String(options.body);
      this.tag = options.tag === undefined ? '' : String(options.tag);
      this.icon = absolute(options.icon);
      this.badge = absolute(options.badge);
      this.data = options.data ?? null;
      this.dir = options.dir ?? 'auto';
      this.lang = options.lang ?? '';
      this.silent = options.silent ?? null;
      this.requireInteraction = Boolean(options.requireInteraction);
      /** @type {((event: Event) => unknown) | null} */
      this.onclick = null;
      /** @type {((event: Event) => unknown) | null} */
      this.onclose = null;
      /** @type {((event: Event) => unknown) | null} */
      this.onerror = null;
      /** @type {((event: Event) => unknown) | null} */
      this.onshow = null;

      if (bridge.permission() !== 'granted') {
        queueMicrotask(() => this.#fire('error'));
        return;
      }
      bridge
        .show({
          title: this.title,
          body: this.body,
          tag: this.tag,
          icon: this.icon,
          requireInteraction: this.requireInteraction,
        })
        .then(
          (id) => {
            if (id === null) {
              this.#fire('error');
              return;
            }
            this.#id = id;
            live.set(id, (type) => {
              if (type === 'close') this.#closed = true;
              this.#fire(type);
            });
            this.#fire('show');
            if (this.#closeRequested) bridge.close(id);
          },
          () => this.#fire('error'),
        );
    }

    close() {
      if (this.#closed) return;
      if (this.#id === null) this.#closeRequested = true;
      else bridge.close(this.#id);
    }

    /** @param {string} type */
    #fire(type) {
      const event = new Event(type, { cancelable: type === 'click' });
      this.dispatchEvent(event);
      /** @type {Record<string, ((event: Event) => unknown) | null>} */
      const handlers = { click: this.onclick, close: this.onclose, error: this.onerror, show: this.onshow };
      handlers[type]?.call(this, event);
    }
  }

  Object.defineProperty(window, 'Notification', { value: Notification, writable: true, configurable: true });
}

// Extension pages (chrome-extension://) have their own notifications.
if (window.top === window.self && /^(https?|nsite):$/.test(location.protocol)) {
  /** @type {((id: number, type: string) => void) | null} */
  let listener = null;
  ipcRenderer.on('notifications:web-event', (_event, id, type) => listener?.(id, type));

  contextBridge.executeInMainWorld({
    func: installNotification,
    args: [
      {
        permission: () => ipcRenderer.sendSync('notifications:web-permission'),
        /** @param {Record<string, unknown>} options */
        show: (options) => ipcRenderer.invoke('notifications:web-show', options),
        /** @param {number} id */
        close: (id) => ipcRenderer.send('notifications:web-close', id),
        /** @param {(id: number, type: string) => void} callback */
        listen: (callback) => {
          listener = callback;
        },
      },
    ],
  });
}
