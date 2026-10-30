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

// Scrollbars for widgets, put in each one's srcdoc ahead of its own styles
// (which can override them): the native ones hidden, and a thin thumb drawn
// over the content of whatever scrolls, shown only while it does.
const SCROLLBAR_STYLE = ':where(*){scrollbar-width:none}';

/** Runs in the napplet's frame, as source: it may use nothing from here. */
function overlayScrollbars() {
  /** @type {Record<'x' | 'y', HTMLElement | null>} */
  const thumbs = { x: null, y: null };
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // Kept clear of the widget's rounded corners.
  const inset = 12;

  /** @param {'x' | 'y'} axis */
  const thumb = (axis) => {
    let el = thumbs[axis];
    if (!el || !el.isConnected) {
      el = document.createElement('din-scroll-thumb');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;border-radius:3px;' +
        'background:rgba(128,128,128,.65);box-shadow:0 0 0 1px rgba(255,255,255,.25);opacity:0;' +
        (still ? '' : 'transition:opacity .25s');
      document.documentElement.appendChild(el);
      thumbs[axis] = el;
    }
    return el;
  };

  /** @param {HTMLElement} el @param {number} left @param {number} top @param {number} width @param {number} height */
  const show = (el, left, top, width, height) => {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.opacity = '1';
  };

  addEventListener('scroll', (event) => {
    const viewport = event.target === document || event.target === document.scrollingElement;
    const el = viewport ? document.scrollingElement : event.target;
    if (!(el instanceof Element)) return;
    const box = viewport ? { left: 0, top: 0 } : el.getBoundingClientRect();
    const x0 = box.left + (viewport ? 0 : el.clientLeft);
    const y0 = box.top + (viewport ? 0 : el.clientTop);
    const w = viewport ? innerWidth : el.clientWidth;
    const h = viewport ? innerHeight : el.clientHeight;
    const y = thumb('y');
    const x = thumb('x');
    if (el.scrollHeight > h + 1) {
      const track = h - inset * 2;
      const length = Math.max(24, (track * h) / el.scrollHeight);
      show(y, x0 + w - 8, y0 + inset + ((track - length) * el.scrollTop) / (el.scrollHeight - h), 6, length);
    } else y.style.opacity = '0';
    if (el.scrollWidth > w + 1) {
      const track = w - inset * 2;
      const length = Math.max(24, (track * w) / el.scrollWidth);
      show(x, x0 + inset + ((track - length) * el.scrollLeft) / (el.scrollWidth - w), y0 + h - 8, length, 6);
    } else x.style.opacity = '0';
    clearTimeout(timer);
    timer = setTimeout(() => {
      y.style.opacity = '0';
      x.style.opacity = '0';
    }, 800);
  }, { capture: true, passive: true });
}

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
      `<script>${prelude}\nglobalThis.NappletShimPrelude.install(${JSON.stringify({ domains })});</script>` +
      `<style>${SCROLLBAR_STYLE}</style><script>(${overlayScrollbars})();</script>`;
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
