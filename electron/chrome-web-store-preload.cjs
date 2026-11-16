// @ts-check
// The Chrome Web Store's chrome.webstorePrivate and chrome.management, so
// its Add to Chrome button works in the Web Browser: only on the store
// itself (https://chromewebstore.google.com, the exact origin, never a host
// that merely starts with it), whose calls main answers
// (chrome-web-store.mts). Registered on the browser's session by main.mts.
//
// Adapted from electron-chrome-web-store (MIT, Samuel Maddock; see
// chrome-web-store.mts).
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const WEB_STORE_ORIGIN = 'https://chromewebstore.google.com';

const ExtensionInstallStatus = {
  BLACKLISTED: 'blacklisted',
  BLOCKED_BY_POLICY: 'blocked_by_policy',
  CAN_REQUEST: 'can_request',
  CORRUPTED: 'corrupted',
  CUSTODIAN_APPROVAL_REQUIRED: 'custodian_approval_required',
  CUSTODIAN_APPROVAL_REQUIRED_FOR_INSTALLATION: 'custodian_approval_required_for_installation',
  DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version',
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  FORCE_INSTALLED: 'force_installed',
  INSTALLABLE: 'installable',
  REQUEST_PENDING: 'request_pending',
  TERMINATED: 'terminated',
};

const MV2DeprecationStatus = { INACTIVE: 'inactive', SOFT_DISABLE: 'soft_disable', WARNING: 'warning' };

const Result = {
  ALREADY_INSTALLED: 'already_installed',
  BLACKLISTED: 'blacklisted',
  BLOCKED_BY_POLICY: 'blocked_by_policy',
  BLOCKED_FOR_CHILD_ACCOUNT: 'blocked_for_child_account',
  FEATURE_DISABLED: 'feature_disabled',
  ICON_ERROR: 'icon_error',
  INSTALL_ERROR: 'install_error',
  INSTALL_IN_PROGRESS: 'install_in_progress',
  INVALID_ICON_URL: 'invalid_icon_url',
  INVALID_ID: 'invalid_id',
  LAUNCH_IN_PROGRESS: 'launch_in_progress',
  MANIFEST_ERROR: 'manifest_error',
  MISSING_DEPENDENCIES: 'missing_dependencies',
  SUCCESS: 'success',
  UNKNOWN_ERROR: 'unknown_error',
  UNSUPPORTED_EXTENSION_TYPE: 'unsupported_extension_type',
  USER_CANCELLED: 'user_cancelled',
  USER_GESTURE_REQUIRED: 'user_gesture_required',
};

const WebGlStatus = { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' };

/** The store says "Add to Chrome": say the browser's name instead. */
function updateBranding(/** @type {string} */ appName) {
  const update = () =>
    requestAnimationFrame(() => {
      for (const node of document.querySelectorAll('span')) {
        if (node.innerText.includes('Chrome')) node.innerText = node.innerText.replace('Chrome', appName);
      }
    });
  update();
  setTimeout(update, 1000 / 60);
}

/** The store offers Add to Chrome only to Chrome: it sees Chrome's user agent. */
function overrideUserAgent() {
  const chromeVersion = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '133.0.6920.0';
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  void webFrame.executeJavaScript(`Object.defineProperty(navigator, 'userAgent', { value: ${JSON.stringify(userAgent)} });`);
}

function setupWebStore() {
  /** @type {string | undefined} */
  let appName;
  const brand = () => {
    if (appName) updateBranding(appName);
  };

  /** @param {string | null | undefined} message */
  const setExtensionError = (message) => {
    void webFrame.executeJavaScript(`
      if (typeof chrome !== 'undefined') {
        if (!chrome.extension) chrome.extension = {};
        chrome.extension.lastError = ${JSON.stringify(message ? { message } : null)};
      }
    `);
  };

  /**
   * A webstorePrivate method: main's answer, to the callback too if given.
   * @param {string} channel
   * @param {number} arity how many arguments come before the callback
   * @param {(result: unknown) => void} [after]
   */
  const method = (channel, arity, after) => async (/** @type {unknown[]} */ ...args) => {
    const callback = typeof args[arity] === 'function' ? /** @type {(result: unknown) => void} */ (args[arity]) : undefined;
    const result = await ipcRenderer.invoke(channel, ...args.slice(0, arity));
    after?.(result);
    callback?.(result);
    return result;
  };

  const webstorePrivate = {
    ExtensionInstallStatus,
    MV2DeprecationStatus,
    Result,
    WebGlStatus,
    /**
     * @param {unknown} details
     * @param {(result: string) => void} [callback]
     */
    beginInstallWithManifest3: async (details, callback) => {
      const { result, message } = /** @type {{ result: string, message?: string }} */ (
        await ipcRenderer.invoke('chromeWebstore.beginInstall', details)
      );
      setExtensionError(result === Result.SUCCESS ? null : message);
      callback?.(result);
      return result;
    },
    completeInstall: method('chromeWebstore.completeInstall', 1, brand),
    enableAppLauncher: method('chromeWebstore.enableAppLauncher', 1),
    getBrowserLogin: method('chromeWebstore.getBrowserLogin', 0),
    getExtensionStatus: method('chromeWebstore.getExtensionStatus', 2, brand),
    /** @param {(result: unknown) => void} [callback] */
    getFullChromeVersion: async (callback) => {
      const result = /** @type {{ version_number: string, app_name?: string }} */ (
        await ipcRenderer.invoke('chromeWebstore.getFullChromeVersion')
      );
      if (result.app_name) {
        appName = result.app_name;
        updateBranding(appName);
        delete result.app_name;
      }
      callback?.(result);
      return result;
    },
    getIsLauncherEnabled: method('chromeWebstore.getIsLauncherEnabled', 0),
    getMV2DeprecationStatus: method('chromeWebstore.getMV2DeprecationStatus', 0),
    getReferrerChain: method('chromeWebstore.getReferrerChain', 0),
    getStoreLogin: method('chromeWebstore.getStoreLogin', 0),
    getWebGLStatus: method('chromeWebstore.getWebGLStatus', 0),
    install: method('chromeWebstore.install', 2),
    isInIncognitoMode: method('chromeWebstore.isInIncognitoMode', 0),
    isPendingCustodianApproval: method('chromeWebstore.isPendingCustodianApproval', 1),
    setStoreLogin: method('chromeWebstore.setStoreLogin', 1),
  };
  contextBridge.exposeInMainWorld('electronWebstore', webstorePrivate);

  contextBridge.exposeInMainWorld('electronRuntime', { lastError: null, getManifest: async () => ({}) });

  /**
   * An event main sends: the page's listener gets the arguments, never the
   * IPC event (whose `sender` is ipcRenderer itself).
   * @param {string} channel
   */
  const event = (channel) => {
    /** @type {Map<(...args: unknown[]) => void, (event: Electron.IpcRendererEvent, ...args: unknown[]) => void>} */
    const wrapped = new Map();
    return {
      /** @param {(...args: unknown[]) => void} callback */
      addListener: (callback) => {
        /** @param {Electron.IpcRendererEvent} _event @param {unknown[]} args */
        const listener = (_event, ...args) => callback(...args);
        wrapped.set(callback, listener);
        ipcRenderer.on(channel, listener);
      },
      /** @param {(...args: unknown[]) => void} callback */
      removeListener: (callback) => {
        const listener = wrapped.get(callback);
        if (listener) ipcRenderer.removeListener(channel, listener);
        wrapped.delete(callback);
      },
    };
  };

  contextBridge.exposeInMainWorld('electronManagement', {
    onInstalled: event('chrome.management.onInstalled'),
    onUninstalled: event('chrome.management.onUninstalled'),
    /** @param {(extensions: unknown[]) => void} callback */
    getAll: (callback) => {
      void ipcRenderer.invoke('chrome.management.getAll').then(callback);
    },
    /** @param {string} id @param {boolean} enabled */
    setEnabled: (id, enabled) => ipcRenderer.invoke('chrome.management.setEnabled', id, enabled),
    /** @param {string} id @param {unknown} options @param {() => void} [callback] */
    uninstall: (id, options, callback) => {
      void ipcRenderer.invoke('chrome.management.uninstall', id, options).then(() => callback?.());
    },
  });

  void webFrame.executeJavaScript(`
    (function () {
      chrome.webstorePrivate = globalThis.electronWebstore;
      Object.assign(chrome.runtime, electronRuntime);
      Object.assign(chrome.management, electronManagement);
      void 0;
    }());
  `);

  void webstorePrivate.getFullChromeVersion();
  overrideUserAgent();
  process.once('document-start', brand);
  /** @type {{ navigation?: EventTarget }} */ (/** @type {unknown} */ (window)).navigation?.addEventListener('navigate', brand);
}

// The store's own top document: exactly its origin, never a host that only starts the same.
if (location.origin === WEB_STORE_ORIGIN && process.isMainFrame) setupWebStore();
