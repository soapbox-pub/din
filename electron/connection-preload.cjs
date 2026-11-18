// @ts-check
// Session preload for every page Din shows (the desktop, its apps and
// widgets, browser tabs and installed web apps; never private or Tor tabs)
// telling the main process the host of each WebSocket it opens, once a host
// per document, so System Monitor's Connections can say what a connection is
// and what it's for (network-monitor.mts). A page's other connections are
// named by its own address, and anything else by reverse DNS.
//
// WebSocket stays the page's own constructor behind a Proxy: `new`, `extends`,
// `instanceof` and its statics are the native one's. Workers' sockets aren't
// seen.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {(url: string) => void} report
 */
function watchWebSockets(report) {
  const Native = window.WebSocket;
  if (typeof Native !== 'function') return;
  /** @type {Set<string>} */
  const seen = new Set();
  const Watched = new Proxy(Native, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      try {
        const url = String(socket.url);
        const host = new URL(url).host;
        if (!seen.has(host)) {
          seen.add(host);
          report(url);
        }
      } catch {
        // Unnamed, then.
      }
      return socket;
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(window, 'WebSocket');
  Object.defineProperty(window, 'WebSocket', { ...descriptor, value: Watched });
}

if (/^(https?|nsite|din|widget|app):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: watchWebSockets,
    args: [(/** @type {string} */ url) => ipcRenderer.send('network-monitor:socket', url)],
  });
}
