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
// MessagePorts in a postMessage's transfer list go along: Google's sign-in
// pop-up gets the channel it answers on that way. contextBridge can't carry a
// port between the page's world and this one, so the two worlds pass them -
// and everything else the bridge delivers, to keep it in order - by posting
// to their own window, tagged with a token only they know.
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
 *   token: string,
 *   isPopup: boolean,
 *   willOpen: () => string | null,
 *   didOpen: (id: string) => boolean,
 *   post: (id: string | null, data: unknown, targetOrigin: string) => void,
 *   close: (id: string | null) => void,
 *   focus: (id: string | null) => void,
 *   navigate: (id: string, url: string) => void,
 * }} bridge
 */
function installPopupBridge(bridge) {
  const nativeOpen = window.open;
  const nativePostMessage = window.postMessage;
  const token = bridge.token;

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

  /**
   * The MessagePorts in a postMessage's transfer list. Other transferables
   * are copied rather than moved.
   * @param {unknown} options
   * @param {unknown} transfer
   * @returns {MessagePort[]}
   */
  const portsOf = (options, transfer) => {
    const list = options && typeof options === 'object' && 'transfer' in options ? options.transfer : transfer;
    return Array.isArray(list) ? list.filter((item) => item instanceof MessagePort) : [];
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
       * @param {unknown} [transfer]
       */
      postMessage(message, options, transfer) {
        const targetOrigin = targetOriginOf(options);
        const ports = portsOf(options, transfer);
        if (ports.length === 0) {
          bridge.post(id, message, targetOrigin);
        } else {
          nativePostMessage.call(window, { [token]: 'post', id, data: message, targetOrigin }, {
            targetOrigin: '*',
            transfer: ports,
          });
        }
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

  // What the bridge delivers arrives as a message to this window, ahead of
  // the page's own listeners, which never see it.
  window.addEventListener(
    'message',
    (event) => {
      const tagged = event.data;
      if (event.source !== window || !tagged || typeof tagged !== 'object') return;
      const type = tagged[token];
      if (type !== 'message' && type !== 'closed' && type !== 'location') return;
      event.stopImmediatePropagation();
      /** @type {{ id: string | null, data?: unknown, origin?: string, href?: string | null, severed?: boolean }} */
      const payload = tagged.payload;
      const linked = payload.id === null ? opener : opened.get(payload.id);
      if (!linked) return;
      // Cut off by Cross-Origin-Opener-Policy: no opener at all, as in Chrome.
      if (type === 'closed' && payload.severed && linked === opener && window.opener === linked.window) {
        window.opener = null;
      }
      if (type === 'message') {
        const message = new MessageEvent('message', {
          data: payload.data,
          origin: payload.origin,
          ports: [...event.ports],
        });
        // MessageEventInit only takes a real window as the source.
        Object.defineProperty(message, 'source', { value: linked.window });
        window.dispatchEvent(message);
      } else if (type === 'closed') {
        linked.closed = true;
      } else {
        linked.href = payload.href ?? null;
      }
    },
    true,
  );

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
  // Not randomUUID: that's only in secure contexts, and http pages get this too.
  const token = `din-popup-bridge:${Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('')}`;

  /**
   * @param {string | null} id
   * @param {unknown} data
   * @param {string} targetOrigin
   * @param {MessagePort[]} [ports]
   */
  const post = (id, data, targetOrigin, ports = []) =>
    ipcRenderer.postMessage('popup-bridge:post', { id, data, targetOrigin }, ports);

  // A postMessage from the page with ports in it. Registered before the
  // page's world gets its listener, so this one runs first.
  window.addEventListener(
    'message',
    (event) => {
      const tagged = event.data;
      if (event.source !== window || !tagged || typeof tagged !== 'object' || tagged[token] !== 'post') return;
      event.stopImmediatePropagation();
      post(tagged.id, tagged.data, tagged.targetOrigin, [...event.ports]);
    },
    true,
  );

  for (const type of ['message', 'closed', 'location']) {
    ipcRenderer.on(`popup-bridge:${type}`, (event, payload) => {
      window.postMessage({ [token]: type, payload }, '*', event.ports);
    });
  }

  contextBridge.executeInMainWorld({
    func: installPopupBridge,
    args: [
      {
        token,
        isPopup: window.top === window.self && ipcRenderer.sendSync('popup-bridge:hello') === true,
        willOpen: () => ipcRenderer.sendSync('popup-bridge:will-open'),
        /** @param {string} id */
        didOpen: (id) => ipcRenderer.sendSync('popup-bridge:did-open', id),
        /**
         * @param {string | null} id
         * @param {unknown} data
         * @param {string} targetOrigin
         */
        post: (id, data, targetOrigin) => post(id, data, targetOrigin),
        /** @param {string | null} id */
        close: (id) => ipcRenderer.send('popup-bridge:close', id),
        /** @param {string | null} id */
        focus: (id) => ipcRenderer.send('popup-bridge:focus', id),
        /**
         * @param {string} id
         * @param {string} url
         */
        navigate: (id, url) => ipcRenderer.send('popup-bridge:navigate', id, url),
      },
    ],
  });
}
