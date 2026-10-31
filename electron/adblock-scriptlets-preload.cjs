// @ts-check
// Session preload for browser tabs that runs the ad blocker's scriptlets
// (`##+js(...)` filters, see electron/adblock.mts) before the page's own
// scripts.
//
// Scriptlets patch the page's globals - JSON.parse, fetch, a config object
// the page reads at startup - so they only work if they're in place first.
// YouTube is the case that matters most: its first video's ads come in an
// inline script, and a scriptlet injected once the page has asked for its
// cosmetics (as Ghostery's own preload does) is too late for them. So this
// asks synchronously, while the document is still empty, and runs what comes
// back in the page's world.
//
// Registered with session.registerPreloadScript in adblock.mts. Runs in every
// frame that gets frame preloads, since scriptlets are written for frames too.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { ipcRenderer, webFrame } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  /** @type {unknown} */
  const scripts = ipcRenderer.sendSync('adblock:scriptlets', location.href);
  if (Array.isArray(scripts) && scripts.length > 0) {
    // webFrame.executeJavaScript runs the code before it returns, outside the
    // page's CSP, which would refuse an eval. All the scriptlets run in one
    // function, as uBO's do: at the top level their helpers (scriptletGlobals,
    // safeSelf, …) would be left on window, where a page can look for them,
    // and YouTube does. Sharing the function's scope also gives them one
    // scriptletGlobals, which they need to share safeSelf. Each still gets a
    // block of its own, since they declare the same helper classes. (The main
    // process drops any that don't parse, which would take the rest down.)
    const blocks = scripts.filter((s) => typeof s === 'string').map((s) => `try{${s}}catch{}`);
    webFrame.executeJavaScript(`(function(){${blocks.join('\n')}})();`).catch(() => {});
  }
}
