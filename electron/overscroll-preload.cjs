// @ts-check
// Session preload for every app and web page (built-in apps, browser tabs,
// private and Tor ones too, installed web apps and nsites): it tells the
// <webview> hosting the page when a scroll runs past the end of what it
// scrolls, and the desktop bounces the page (src/platform/GuestSurface.tsx),
// as macOS and iOS do. Chromium draws no overscroll of its own on Linux.
//
// It runs in the preload's own world, which the page can't see or reach,
// and sends only how far past the edge a scroll went: never where, or what.
//
// The detecting is src/shared/overscroll.ts, which scripts/build-din-runtime.mjs
// bundles into the function below and writes this file out with it as
// overscroll-preload.built.cjs, which is what Electron loads: a sandboxed
// preload can't load a sibling file.
//
// Plain CommonJS: sandboxed preloads can't be ESM or TypeScript.

const { ipcRenderer } = require('electron');

const loadOverscroll = /** @type {(() => { watchOverscroll: (win: Window, report: (report: { type: 'pull', dx: number, dy: number } | { type: 'release' }) => void) => () => void }) | null} */ (
  /* @overscroll */ null
);

if (process.isMainFrame && loadOverscroll) {
  const { watchOverscroll } = loadOverscroll();
  watchOverscroll(window, (report) => ipcRenderer.sendToHost('din:overscroll', report));
}
