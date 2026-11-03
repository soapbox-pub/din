// @ts-check
// Session preload for web pages - browser tabs (private and Tor ones too) and
// installed web apps - giving window.chrome the `app` object Chrome gives
// every page.
//
// Electron's Chromium leaves it out, and Google's sign-in tells a browser
// without it from Chrome: with Din's user agent saying Chrome, the account
// page took the missing chrome.app for an embedded or tampered-with browser
// and stopped at "Couldn't sign you in: This browser or app may not be
// secure" right after the email, in a tab, a pop-up, and a bare Electron
// window with no other preloads alike. With it, sign-in goes on to the
// password, as it does in Chromium. chrome.csi and chrome.loadTimes, also
// Chrome's and also missing, made no difference to it, so they stay out.
//
// The object has Chrome's shape for a page that isn't an installed Chrome
// app (Din has none): isInstalled false, no details, and the two enums.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge } = require('electron');

/** Runs in the page's world. */
function installChromeApp() {
  /** @type {Record<string, unknown>} */
  const chrome = /** @type {Record<string, unknown>} */ (Reflect.get(window, 'chrome') ?? {});
  if ('app' in chrome) return;
  const app = {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails() {
      return null;
    },
    getIsInstalled() {
      return false;
    },
    /** @param {(state: string) => void} [callback] */
    installState(callback) {
      if (typeof callback === 'function') setTimeout(() => callback('not_installed'), 0);
    },
    runningState() {
      return 'cannot_run';
    },
  };
  Object.defineProperty(chrome, 'app', { value: app, writable: true, configurable: true, enumerable: true });
  if (!('chrome' in window)) {
    Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });
  }
}

if (/^(https?|nsite):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({ func: installChromeApp });
}
