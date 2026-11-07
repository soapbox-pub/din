// @ts-check
// Session preload for the browser's persistent session, giving the built-in
// ad blocker's background page (electron/adblock-extension/) its line to the
// main process (electron/adblock.mts). Every other page in the session -
// web pages, other extensions - gets nothing from it.
//
// The main process checks the sender of every message again, so a page that
// reached these channels some other way would still be turned away.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/** Must match ADBLOCK_EXTENSION_ID in electron/adblock.mts. */
const EXTENSION_ORIGIN = 'chrome-extension://gmmdegmbkcjkjfbacghangmkafhmkoeb';

if (location.origin === EXTENSION_ORIGIN) {
  const api = {
    /** @returns {Promise<{ enabled: boolean, allowlist: string[] }>} */
    settings: () => ipcRenderer.invoke('adblock-ext:settings'),

    /** The serialized filter engine, or null before the first one is built. */
    engine: () => ipcRenderer.invoke('adblock-ext:engine'),

    /** Its listeners are up and it has the engine (or knows there's none yet): pages may load. */
    ready: () => ipcRenderer.send('adblock-ext:ready'),

    /** @param {[string, string[]][]} reports newly blocked URLs, by site */
    reportBlocked: (reports) => ipcRenderer.send('adblock-ext:blocked', reports),

    /**
     * @param {string} url a top-level response's URL
     * @param {string | null} coop its Cross-Origin-Opener-Policy header
     * @param {string | null} onionLocation its Onion-Location header
     * @param {string | null} nsiteLocation its Nsite-Location header
     */
    reportDocument: (url, coop, onionLocation, nsiteLocation) =>
      ipcRenderer.send('adblock-ext:document', url, coop, onionLocation, nsiteLocation),

    /** @param {(settings: { enabled: boolean, allowlist: string[] }) => void} callback */
    onSettings: (callback) => {
      ipcRenderer.on('adblock-ext:settings', (_event, settings) => callback(settings));
    },

    /** @param {() => void} callback */
    onEngineChanged: (callback) => {
      ipcRenderer.on('adblock-ext:engineChanged', () => callback());
    },
  };
  // Background pages may run without context isolation, where contextBridge
  // refuses to work and the page shares this world anyway.
  if (process.contextIsolated) contextBridge.exposeInMainWorld('dinAdblock', api);
  else Object.assign(window, { dinAdblock: api });
}
