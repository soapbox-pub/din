// @ts-check
// The chrome.* APIs Electron lacks, in extension pages (chrome-extension://)
// and extension service workers of the Web Browser's session: each call
// goes over IPC (`crx-msg`) to chrome-extensions-router.mts, and each event
// comes back as `crx-<name>`. Registered on the session by
// chrome-extensions.mts. Content scripts don't get these: they run in web
// pages, which this leaves alone, with only what Electron gives them.
//
// Adapted from electron-chrome-extensions (MIT, Samuel Maddock; see
// chrome-extensions.mts).
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer, contextBridge } = require('electron');

/**
 * @typedef {{
 *   noop?: boolean,
 *   defaultResponse?: unknown,
 *   serialize?: (...args: unknown[]) => unknown[],
 * }} MessageOptions
 * @typedef {(...args: unknown[]) => void} Listener
 */

/** How many listeners each event has here, so main hears of the first and the last. */
const listenerCounts = new Map();
/** Each page listener's IPC listener, to remove the same one. */
const ipcListeners = new Map();

/**
 * @param {string} extensionId
 * @param {string} name
 * @param {Listener} callback
 */
function addExtensionListener(extensionId, name, callback) {
  const count = listenerCounts.get(name) || 0;
  if (count === 0) ipcRenderer.send('crx-add-listener', extensionId, name);
  listenerCounts.set(name, count + 1);
  /** @param {Electron.IpcRendererEvent} _event @param {unknown[]} args */
  const listener = (_event, ...args) => callback(...args);
  ipcListeners.set(callback, listener);
  ipcRenderer.addListener(`crx-${name}`, listener);
}

/**
 * @param {string} extensionId
 * @param {string} name
 * @param {Listener} callback
 */
function removeExtensionListener(extensionId, name, callback) {
  const listener = ipcListeners.get(callback);
  if (!listener) return;
  ipcListeners.delete(callback);
  ipcRenderer.removeListener(`crx-${name}`, listener);
  const count = listenerCounts.get(name) || 0;
  if (count <= 1) {
    listenerCounts.delete(name);
    ipcRenderer.send('crx-remove-listener', extensionId, name);
  } else {
    listenerCounts.set(name, count - 1);
  }
}

/**
 * Call `fnName` in main. A trailing function argument is the callback
 * (chrome.* takes either); a failure is logged and answers undefined.
 * @param {string} extensionId
 * @param {string} fnName
 * @param {MessageOptions} options
 * @param {unknown[]} args
 */
async function invokeExtension(extensionId, fnName, options = {}, ...args) {
  const callback = typeof args[args.length - 1] === 'function' ? /** @type {Listener} */ (args.pop()) : undefined;

  if (options.noop) {
    console.warn(`${fnName} is not yet implemented.`);
    if (callback) callback(options.defaultResponse);
    return options.defaultResponse;
  }

  if (options.serialize) args = options.serialize(...args);

  let result;
  try {
    result = await ipcRenderer.invoke('crx-msg', extensionId, fnName, ...args);
  } catch (error) {
    console.error(error);
    result = undefined;
  }

  if (callback) callback(result);
  else return result;
}

/**
 * A native messaging port: `receive` and `disconnect` are the page's, and
 * `ready` hands it its id and a way to send.
 * @param {string} extensionId
 * @param {string} application
 * @param {(message: unknown) => void} receive
 * @param {() => void} disconnect
 * @param {(connectionId: string, send: (message: unknown) => void) => void} ready
 */
function connectNative(extensionId, application, receive, disconnect, ready) {
  const connectionId = crypto.randomUUID();
  void invokeExtension(extensionId, 'runtime.connectNative', {}, connectionId, application);
  /** @param {Electron.IpcRendererEvent} _event @param {unknown} message */
  const onMessage = (_event, message) => receive(message);
  ipcRenderer.on(`crx-native-msg-${connectionId}`, onMessage);
  ipcRenderer.once(`crx-native-msg-${connectionId}-disconnect`, () => {
    ipcRenderer.off(`crx-native-msg-${connectionId}`, onMessage);
    disconnect();
  });
  ready(connectionId, (message) => ipcRenderer.send(`crx-native-msg-${connectionId}`, message));
}

/**
 * @param {string} extensionId
 * @param {string} connectionId
 */
function disconnectNative(extensionId, connectionId) {
  void invokeExtension(extensionId, 'runtime.disconnectNative', {}, connectionId);
}

const bridge = { invokeExtension, addExtensionListener, removeExtensionListener, connectNative, disconnectNative };

/**
 * Runs in the page's own world, so it must be self-contained: everything it
 * uses arrives as `globalThis.electron` (the bridge above), which it removes
 * again before any of the page's scripts run.
 */
function mainWorldScript() {
  const g = /** @type {{ electron?: typeof bridge, chrome?: typeof chrome }} */ (/** @type {unknown} */ (globalThis));
  const electron = /** @type {typeof bridge} */ (g.electron);
  const chromeApi = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (g.chrome || {}));
  const runtime = /** @type {typeof chrome.runtime | undefined} */ (chromeApi.runtime);
  const extensionId = runtime?.id ?? '';
  // Offscreen documents have no getManifest.
  const manifest = /** @type {{ manifest_version?: number, action?: unknown, browser_action?: unknown }} */ (
    (extensionId && runtime?.getManifest?.()) || {}
  );

  /**
   * @param {string} fnName
   * @param {MessageOptions} [opts]
   */
  const invoke = (fnName, opts = {}) => (/** @type {unknown[]} */ ...args) => electron.invokeExtension(extensionId, fnName, opts, ...args);
  /** @param {string} fnName */
  const noop = (fnName, defaultResponse = /** @type {unknown} */ (undefined)) => invoke(fnName, { noop: true, defaultResponse });

  /** An event main sends (`crx-<name>`). */
  class ExtensionEvent {
    /** @param {string} name */
    constructor(name) {
      this.name = name;
    }
    /** @param {Listener} callback */
    addListener(callback) {
      electron.addExtensionListener(extensionId, this.name, callback);
    }
    /** @param {Listener} callback */
    removeListener(callback) {
      electron.removeExtensionListener(extensionId, this.name, callback);
    }
    hasListener() {
      throw new Error('Method not implemented.');
    }
    hasListeners() {
      throw new Error('Method not implemented.');
    }
  }

  /** An event raised here, in the page. */
  class LocalEvent {
    /** @type {Listener[]} */
    listeners = [];
    /** @param {unknown[]} args */
    _emit(...args) {
      for (const listener of [...this.listeners]) listener(...args);
    }
    /** @param {Listener} callback */
    addListener(callback) {
      this.listeners.push(callback);
    }
    /** @param {Listener} callback */
    removeListener(callback) {
      const index = this.listeners.indexOf(callback);
      if (index > -1) this.listeners.splice(index, 1);
    }
  }

  /** A chrome.types.ChromeSetting that keeps nothing. */
  const setting = () => ({ set() {}, get() {}, clear() {}, onChange: { addListener() {} } });

  /** chrome.runtime.connectNative's port. */
  class NativePort {
    name = '';
    connected = false;
    connectionId = '';
    /** @type {unknown[]} */
    pending = [];
    /** @type {(message: unknown) => void} */
    send = (message) => {
      this.pending.push(message);
    };
    onMessage = new LocalEvent();
    onDisconnect = new LocalEvent();
    /** @param {string} connectionId @param {(message: unknown) => void} send */
    ready(connectionId, send) {
      this.connected = true;
      this.connectionId = connectionId;
      this.send = send;
      for (const message of this.pending) send(message);
      this.pending = [];
    }
    /** @param {unknown} message */
    postMessage(message) {
      this.send(message);
    }
    disconnect() {
      if (!this.connected) return;
      electron.disconnectNative(extensionId, this.connectionId);
      this.onDisconnect._emit();
      this.connected = false;
    }
  }

  /** @param {ImageData} imageData */
  function imageDataUrl(imageData) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }

  /**
   * A namespace: what Electron gave it (`base`), with `methods` answered by
   * main, `noops` that answer `undefined` (or their default) without asking,
   * and `events` main sends.
   * @param {unknown} base
   * @param {{ methods?: string[], noops?: Record<string, unknown>, events?: string[], extra?: Record<string, unknown> }} spec
   * @param {string} [prefix] what main calls it, when that isn't its name here
   */
  const namespace = (base, spec, prefix) => {
    /** @type {Record<string, unknown>} */
    const api = { ...(/** @type {object} */ (base) || {}) };
    for (const method of spec.methods ?? []) api[method] = invoke(`${prefix}.${method}`);
    for (const [method, value] of Object.entries(spec.noops ?? {})) api[method] = noop(`${prefix}.${method}`, value);
    for (const event of spec.events ?? []) api[event] = new ExtensionEvent(`${prefix}.${event}`);
    return Object.assign(api, spec.extra);
  };

  /** chrome.action (MV3) and chrome.browserAction (MV2), both browserAction.* in main. */
  /** @param {unknown} base */
  const action = (base) => namespace(base, {
    methods: ['setTitle', 'getTitle', 'setPopup', 'getPopup', 'setBadgeText', 'getBadgeText',
      'setBadgeBackgroundColor', 'getBadgeBackgroundColor', 'getUserSettings', 'openPopup'],
    noops: { enable: undefined, disable: undefined },
    events: ['onClicked'],
    extra: {
      setIcon: invoke('browserAction.setIcon', {
        // Main can't take ImageData: send data: URLs.
        serialize: (raw) => {
          const details = /** @type {{ imageData?: unknown }} */ (raw);
          if (details.imageData) {
            if (manifest.manifest_version === 3) {
              // An MV3 worker has no canvas to draw it with.
              console.warn('action.setIcon with imageData is not supported');
              details.imageData = undefined;
            } else if (details.imageData instanceof ImageData) {
              details.imageData = imageDataUrl(details.imageData);
            } else {
              details.imageData = Object.fromEntries(
                Object.entries(/** @type {Record<string, ImageData>} */ (details.imageData)).map(([size, data]) => [size, imageDataUrl(data)]),
              );
            }
          }
          return [details];
        },
      }),
    },
  }, 'browserAction');

  /** @param {unknown} base */
  const contextMenus = (base) => {
    let menuCounter = 0;
    /** @type {Record<string, Listener>} */
    const onclicks = {};
    const create = invoke('contextMenus.create');
    const onClicked = new ExtensionEvent('contextMenus.onClicked');
    let listening = false;
    return namespace(base, {
      methods: ['remove', 'removeAll'],
      noops: { update: undefined },
      extra: {
        onClicked,
        /**
         * An item's `onclick` stays here (functions don't cross to main):
         * clicks come back through onClicked.
         * @param {chrome.contextMenus.CreateProperties & { onclick?: Listener }} properties
         * @param {Listener} [callback]
         */
        create(properties, callback) {
          if (typeof properties.id === 'undefined') properties.id = `${++menuCounter}`;
          if (properties.onclick) {
            if (!listening) {
              onClicked.addListener((info, tab) => {
                const handler = onclicks[/** @type {chrome.contextMenus.OnClickData} */ (info).menuItemId];
                if (handler && tab) handler(info, tab);
              });
              listening = true;
            }
            onclicks[properties.id] = properties.onclick;
            delete properties.onclick;
          }
          void create(properties, callback);
          return properties.id;
        },
      },
    }, 'contextMenus');
  };

  /** @param {unknown} base */
  const tabs = (base) => {
    const electronTabs = /** @type {typeof chrome.tabs} */ (base);
    const api = namespace(base, {
      methods: ['create', 'get', 'getCurrent', 'getAllInWindow', 'insertCSS', 'query', 'reload',
        'update', 'remove', 'goBack', 'goForward'],
      events: ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onReplaced'],
      extra: {
        /**
         * Electron's executeScript (C++) needs a tab id; Chrome's defaults
         * to the current window's active tab.
         * @param {unknown} arg1 @param {unknown} arg2 @param {unknown} arg3
         * @returns {Promise<unknown>}
         */
        async executeScript(arg1, arg2, arg3) {
          if (typeof arg1 === 'object') {
            const found = /** @type {chrome.tabs.Tab[]} */ (await query({ active: true, windowId: -2 }));
            return /** @type {(a: unknown, b: unknown, c: unknown) => Promise<unknown>} */ (api.executeScript)(found[0]?.id, arg1, arg2);
          }
          return /** @type {(a: unknown, b: unknown, c: unknown) => unknown} */ (/** @type {unknown} */ (electronTabs.executeScript))(arg1, arg2, arg3);
        },
      },
    }, 'tabs');
    const query = /** @type {(info: object) => Promise<unknown>} */ (api.query);
    return api;
  };

  /** @type {Record<string, { inject?: () => boolean, factory: (base: unknown) => unknown }>} */
  const apis = {
    action: { inject: () => manifest.manifest_version === 3 && !!manifest.action, factory: action },
    browserAction: { inject: () => manifest.manifest_version === 2 && !!manifest.browser_action, factory: action },
    commands: { factory: (base) => namespace(base, { methods: ['getAll'], events: ['onCommand'] }, 'commands') },
    contextMenus: { factory: contextMenus },
    cookies: {
      factory: (base) => namespace(base, {
        methods: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
        events: ['onChanged'],
      }, 'cookies'),
    },
    downloads: {
      factory: (base) => namespace(base, {
        noops: Object.fromEntries(['acceptDanger', 'cancel', 'download', 'erase', 'getFileIcon', 'open', 'pause',
          'removeFile', 'resume', 'search', 'setUiOptions', 'show', 'showDefaultFolder'].map((m) => [m, undefined])),
        events: ['onChanged', 'onCreated', 'onDeterminingFilename', 'onErased'],
      }, 'downloads'),
    },
    extension: {
      factory: (base) => namespace(base, {
        noops: { isAllowedFileSchemeAccess: false, isAllowedIncognitoAccess: false },
        extra: { getViews: () => [] },
      }, 'extension'),
    },
    i18n: {
      inject: () => manifest.manifest_version === 3,
      // Where Electron left a worker without one (electron/electron#45031).
      factory: (base) => (/** @type {{ getMessage?: unknown }} */ (base || {})).getMessage ? base : {
        .../** @type {object} */ (base),
        getUILanguage: () => 'en-US',
        /** @param {Listener} [callback] */
        getAcceptLanguages: (callback) => {
          const languages = ['en-US'];
          if (callback) queueMicrotask(() => callback(languages));
          return Promise.resolve(languages);
        },
        /** @param {string} name */
        getMessage: (name) => name,
      },
    },
    notifications: {
      factory: (base) => namespace(base, {
        methods: ['clear', 'create', 'getAll', 'getPermissionLevel', 'update'],
        events: ['onClicked', 'onButtonClicked', 'onClosed'],
      }, 'notifications'),
    },
    permissions: {
      factory: (base) => namespace(base, {
        methods: ['contains', 'getAll', 'remove', 'request'],
        events: ['onAdded', 'onRemoved'],
      }, 'permissions'),
    },
    privacy: {
      factory: (base) => ({
        .../** @type {object} */ (base),
        network: { networkPredictionEnabled: setting(), webRTCIPHandlingPolicy: setting() },
        services: { autofillAddressEnabled: setting(), autofillCreditCardEnabled: setting(), passwordSavingEnabled: setting() },
        websites: { hyperlinkAuditingEnabled: setting() },
      }),
    },
    runtime: {
      factory: (base) => namespace(base, {
        methods: ['openOptionsPage', 'sendNativeMessage'],
        extra: {
          /** @param {string} application */
          connectNative(application) {
            const port = new NativePort();
            electron.connectNative(
              extensionId,
              application,
              (message) => port.onMessage._emit(message),
              () => port.disconnect(),
              (connectionId, send) => port.ready(connectionId, send),
            );
            return port;
          },
        },
      }, 'runtime'),
    },
    storage: {
      // No sync or managed storage: both are the local area.
      factory: (base) => {
        const local = (/** @type {{ local?: unknown }} */ (base || {})).local;
        return { .../** @type {object} */ (base), managed: local, sync: local };
      },
    },
    tabs: { factory: tabs },
    topSites: { factory: () => ({ get: noop('topSites.get', []) }) },
    webNavigation: {
      factory: (base) => namespace(base, {
        methods: ['getFrame', 'getAllFrames'],
        events: ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onCreatedNavigationTarget', 'onDOMContentLoaded',
          'onErrorOccurred', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onTabReplaced'],
      }, 'webNavigation'),
    },
    webRequest: { factory: (base) => namespace(base, { events: ['onHeadersReceived'] }, 'webRequest') },
    windows: {
      factory: (base) => namespace(base, {
        methods: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'],
        events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
        extra: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 },
      }, 'windows'),
    },
  };

  for (const [name, { inject, factory }] of Object.entries(apis)) {
    if (inject && !inject()) continue;
    Object.defineProperty(chromeApi, name, { value: factory(chromeApi[name]), enumerable: true, configurable: true });
  }

  delete g.electron;
  Object.freeze(chromeApi);
}

if (process.type === 'service-worker' || location.href.startsWith('chrome-extension://')) {
  try {
    if (process.contextIsolated) {
      contextBridge.exposeInMainWorld('electron', bridge);
      contextBridge.executeInMainWorld({ func: mainWorldScript });
    } else {
      // An MV2 background page has no isolated world: this is the page's own.
      /** @type {{ electron?: typeof bridge }} */ (/** @type {unknown} */ (globalThis)).electron = bridge;
      mainWorldScript();
    }
  } catch (error) {
    console.error(`chrome.* APIs failed to load in ${location.href}`, error);
  }
}
