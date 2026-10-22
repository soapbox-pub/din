// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - linking a page and the window it opens (see
// electron/popups.mts).
//
// Din opens every window.open as a tab, and Chromium knows nothing of the
// link between them. This gives the page a stand-in for the new tab's window
// from window.open, and the tab a stand-in for the page as window.opener:
// postMessage, close, focus, closed and location, relayed by the main
// process, which checks every message's origins.
//
// Not a full window: a page can't reach into the other one's document, even
// when they're the same origin, or open one it then writes into.
//
// Registered with session.registerPreloadScript in popups.mts. Runs in every
// frame that gets frame preloads, since a sign-in button is often an iframe.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world: everything it needs comes in through `bridge`.
 * @param {{
 *   isPopup: boolean,
 *   willOpen: () => string | null,
 *   didOpen: (id: string) => boolean,
 *   post: (id: string | null, data: unknown, targetOrigin: string) => void,
 *   close: (id: string | null) => void,
 *   focus: (id: string | null) => void,
 *   navigate: (id: string, url: string) => void,
 *   listen: (callback: (type: string, payload: { id: string | null, data?: unknown, origin?: string, href?: string | null }) => void) => void,
 * }} bridge
 */
function installPopupBridge(bridge) {
  const nativeOpen = window.open;

  /**
   * @typedef {{ closed: boolean, href: string | null, name: string, window: object }} Linked
   */
  /** @type {Map<string, Linked>} The windows this page opened. */
  const opened = new Map();
  /** @type {Linked | null} */
  let opener = null;

  /** @param {unknown} options */
  const targetOriginOf = (options) => {
    const target =
      typeof options === 'string'
        ? options
        : options && typeof options === 'object' && 'targetOrigin' in options
          ? String(options.targetOrigin)
          : '/';
    if (target === '*' || target === '/') return target;
    try {
      return new URL(target).origin;
    } catch {
      throw new DOMException(
        `Failed to execute 'postMessage' on 'Window': Invalid target origin '${target}' in a call to 'postMessage'.`,
        'SyntaxError',
      );
    }
  };

  const crossOrigin = () =>
    new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');

  /**
   * The stand-in for a window: `id` is a window this page opened, or null for
   * the opener.
   * @param {string | null} id
   * @param {Linked} state
   */
  const makeWindow = (id, state) => {
    /** @param {unknown} url */
    const navigate = (url) => {
      if (id !== null) bridge.navigate(id, new URL(String(url), location.href).href);
    };
    /** @param {'href' | 'origin' | 'protocol' | 'host' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash'} part */
    const read = (part) => {
      if (state.href === null) throw crossOrigin();
      return part === 'href' ? state.href : new URL(state.href)[part];
    };
    const windowLocation = {
      get href() { return read('href'); },
      set href(url) { navigate(url); },
      get origin() { return read('origin'); },
      get protocol() { return read('protocol'); },
      get host() { return read('host'); },
      get hostname() { return read('hostname'); },
      get port() { return read('port'); },
      get pathname() { return read('pathname'); },
      get search() { return read('search'); },
      get hash() { return read('hash'); },
      /** @param {unknown} url */
      assign(url) { navigate(url); },
      /** @param {unknown} url */
      replace(url) { navigate(url); },
      reload() {},
      toString() { return read('href'); },
    };
    const win = {
      /**
       * @param {unknown} message
       * @param {unknown} [options]
       */
      postMessage(message, options) {
        bridge.post(id, message, targetOriginOf(options));
      },
      close() {
        bridge.close(id);
      },
      focus() {
        bridge.focus(id);
      },
      blur() {},
      get closed() {
        return state.closed;
      },
      get location() {
        return windowLocation;
      },
      set location(url) {
        navigate(url);
      },
      get opener() {
        return id === null ? null : window;
      },
    };
    return win;
  };

  bridge.listen((type, payload) => {
    const linked = payload.id === null ? opener : opened.get(payload.id);
    if (!linked) return;
    if (type === 'message') {
      const event = new MessageEvent('message', { data: payload.data, origin: payload.origin });
      // MessageEventInit only takes a real window as the source.
      Object.defineProperty(event, 'source', { value: linked.window });
      window.dispatchEvent(event);
    } else if (type === 'closed') {
      linked.closed = true;
    } else if (type === 'location') {
      linked.href = payload.href ?? null;
    }
  });

  /**
   * @param {string | URL} [url]
   * @param {string} [target]
   * @param {string} [features]
   */
  window.open = function open(url = '', target = '_blank', features = '') {
    const name = String(target ?? '_blank');
    const lower = name.toLowerCase();
    if (
      lower === '_self' ||
      lower === '_parent' ||
      lower === '_top' ||
      /(^|[\s,])no(opener|referrer)\s*(=\s*(1|yes|true)\s*)?(,|$)/i.test(String(features))
    ) {
      return nativeOpen.call(window, url, name, features);
    }

    // A named window this page opened before is navigated, not opened again.
    if (lower !== '_blank' && lower !== '') {
      for (const [id, linked] of opened) {
        if (linked.name !== name || linked.closed) continue;
        if (String(url) !== '') bridge.navigate(id, new URL(String(url), location.href).href);
        bridge.focus(id);
        return /** @type {Window} */ (linked.window);
      }
    }

    const id = bridge.willOpen();
    /** @type {object | null} */
    let result;
    try {
      result = nativeOpen.call(window, url, name, features);
    } finally {
      if (id !== null && bridge.didOpen(id)) {
        /** @type {Linked} */
        const linked = { closed: false, href: 'about:blank', name, window: {} };
        linked.window = makeWindow(id, linked);
        opened.set(id, linked);
        result = linked.window;
      }
    }
    // The stand-in is no Window, but it's what the page gets in its place.
    return /** @type {Window | null} */ (result);
  };

  if (bridge.isPopup) {
    /** @type {Linked} */
    const linked = { closed: false, href: null, name: '', window: {} };
    linked.window = makeWindow(null, linked);
    opener = linked;
    /** @type {unknown} */
    let value = linked.window;
    Object.defineProperty(window, 'opener', {
      get: () => value,
      set: (next) => {
        value = next;
      },
      configurable: true,
      enumerable: true,
    });
    // A window a page opened may close itself; the tab closes.
    window.close = function close() {
      bridge.close(null);
    };
  }
}

if (/^(https?|nsite):$/.test(location.protocol)) {
  /** @type {((type: string, payload: { id: string | null }) => void) | null} */
  let listener = null;
  for (const type of ['message', 'closed', 'location']) {
    ipcRenderer.on(`popup-bridge:${type}`, (_event, payload) => listener?.(type, payload));
  }

  contextBridge.executeInMainWorld({
    func: installPopupBridge,
    args: [
      {
        isPopup: window.top === window.self && ipcRenderer.sendSync('popup-bridge:hello') === true,
        willOpen: () => ipcRenderer.sendSync('popup-bridge:will-open'),
        /** @param {string} id */
        didOpen: (id) => ipcRenderer.sendSync('popup-bridge:did-open', id),
        /**
         * @param {string | null} id
         * @param {unknown} data
         * @param {string} targetOrigin
         */
        post: (id, data, targetOrigin) => ipcRenderer.send('popup-bridge:post', id, data, targetOrigin),
        /** @param {string | null} id */
        close: (id) => ipcRenderer.send('popup-bridge:close', id),
        /** @param {string | null} id */
        focus: (id) => ipcRenderer.send('popup-bridge:focus', id),
        /**
         * @param {string} id
         * @param {string} url
         */
        navigate: (id, url) => ipcRenderer.send('popup-bridge:navigate', id, url),
        /** @param {(type: string, payload: { id: string | null }) => void} callback */
        listen: (callback) => {
          listener = callback;
        },
      },
    ],
  });
}
