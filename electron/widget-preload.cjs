// @ts-check
// Preload for desktop widgets (widget:// and napplet:// in the persist:widgets
// session; see electron/widgets.mts and docs/widgets.md).
//
// The host page is empty. This puts the widget in it the way NIP-5D's web
// projection runs a napplet: its verified bytes in a sandbox="allow-scripts"
// srcdoc iframe, with the CSP and window.napplet (@napplet/shim's prelude,
// for the domains the desktop grants) injected ahead of them. The napplet
// talks to window.parent with postMessage; envelopes from that iframe go to
// the desktop over the port main hands over, and the desktop's answers go
// back to it. Nothing is defined in any page's world.
//
// Plain CommonJS: sandboxed preloads can't be ESM or TypeScript.

const { ipcRenderer } = require('electron');

if (process.isMainFrame && /^(widget|napplet):$/.test(location.protocol)) {
  /** @type {MessagePort | null} */
  let desktop = null;
  /** @type {HTMLIFrameElement | null} */
  let frame = null;
  // Until the srcdoc has loaded, its window is the initial about:blank's.
  let ready = false;
  /** @type {unknown[]} */
  const toNapplet = [];

  /** @type {Promise<{ html: string, prelude: string, csp: string }>} */
  const artifact = ipcRenderer.invoke('widget:artifact');
  // Reported to the desktop when the widget starts, not as an unhandled rejection.
  artifact.catch(() => {});
  /** @type {Promise<void>} */
  const loaded = new Promise((resolve) => {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    else resolve();
  });

  /** @param {unknown} message */
  const deliver = (message) => {
    if (ready && frame?.contentWindow) frame.contentWindow.postMessage(message, '*');
    else toNapplet.push(message);
  };

  /** @param {string[]} domains */
  const start = async (domains) => {
    if (frame) return;
    let parts;
    try {
      parts = await artifact;
    } catch (error) {
      desktop?.postMessage({ failed: error instanceof Error ? error.message : String(error) });
      return;
    }
    await loaded;
    const { html, prelude, csp } = parts;
    const injected =
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<script>${prelude}\nglobalThis.NappletShimPrelude.install(${JSON.stringify({ domains })});</script>`;
    // After a doctype, so the page keeps its rendering mode.
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    const srcdoc = doctype ? doctype[0] + injected + html.slice(doctype[0].length) : injected + html;
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allowtransparency', 'true');
    frame.srcdoc = srcdoc;
    frame.addEventListener('load', () => {
      ready = true;
      for (const message of toNapplet.splice(0)) frame?.contentWindow?.postMessage(message, '*');
    }, { once: true });
    document.body.appendChild(frame);
  };

  // The napplet's envelopes, from its iframe and nothing else.
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || typeof data.type !== 'string') return;
    desktop?.postMessage({ message: data });
  });

  ipcRenderer.on('widget:port', (event) => {
    desktop = event.ports[0];
    desktop.onmessage = (e) => {
      const data = e.data || {};
      if (data.init && Array.isArray(data.init.domains)) void start(data.init.domains.filter((/** @type {unknown} */ d) => typeof d === 'string'));
      else if (data.message && typeof data.message === 'object') deliver(data.message);
    };
  });

  ipcRenderer.send('widget:connect');
}
