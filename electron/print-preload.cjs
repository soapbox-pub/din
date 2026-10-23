// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - sending window.print() to Din's print dialog (see
// electron/printing.mts).
//
// Chromium's own print() opens a GTK print dialog, which under cage takes
// over the whole screen with no way back to Din. This swaps in a print() that
// asks the main process instead, without blocking the page. A frame prints
// just itself: sites often print a receipt or a ticket by writing it into a
// hidden iframe and calling print() there, so the frame's document goes along
// to be drawn again on its own. Preloads don't run in such about:blank
// frames, so their windows get the same print() as the page reaches them.
// The Print button of Chromium's PDF viewer goes to Din's dialog too.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {(frame: { html: string, baseUrl: string, title: string } | null) => void} request
 */
function installPrint(request) {
  /** @type {WeakSet<Window>} */
  const patched = new WeakSet();

  /** @param {Window} win */
  const printFor = (win) =>
    function print() {
      if (win === win.top) {
        request(null);
        return;
      }
      const doc = win.document;
      request({ html: doc.documentElement.outerHTML, baseUrl: doc.baseURI, title: doc.title });
    };

  /** @param {Window | null} win */
  const patch = (win) => {
    if (!win || patched.has(win)) return;
    try {
      Object.defineProperty(win, 'print', { value: printFor(win), writable: true, configurable: true });
      patched.add(win);
    } catch {
      // Another origin's frame: its own copy of this preload sees to it.
    }
  };

  patch(window);

  const proto = HTMLIFrameElement.prototype;
  const contentWindow = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
  const contentDocument = Object.getOwnPropertyDescriptor(proto, 'contentDocument');
  if (contentWindow?.get) {
    const get = contentWindow.get;
    Object.defineProperty(proto, 'contentWindow', {
      ...contentWindow,
      get() {
        const win = get.call(this);
        patch(win);
        return win;
      },
    });
  }
  if (contentDocument?.get) {
    const get = contentDocument.get;
    Object.defineProperty(proto, 'contentDocument', {
      ...contentDocument,
      get() {
        const doc = get.call(this);
        if (doc) patch(doc.defaultView);
        return doc;
      },
    });
  }
}

/**
 * Runs in the world of Chromium's PDF viewer, the frame a PDF opens in. Its
 * Print button asks the PDF plugin itself to print, which would open the
 * GTK dialog; the whole page (the PDF) goes to Din's dialog instead.
 * @param {() => void} request
 */
function installPdfViewerPrint(request) {
  window.addEventListener(
    'click',
    (event) => {
      const print = event
        .composedPath()
        .some((node) => node instanceof Element && node.localName === 'cr-icon-button' && node.id === 'print');
      if (!print) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      request();
    },
    true,
  );
}

if (location.origin === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai') {
  contextBridge.executeInMainWorld({
    func: installPdfViewerPrint,
    args: [() => ipcRenderer.send('printing:request', null)],
  });
} else if (/^(https?|nsite|file|about|blob|data):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installPrint,
    args: [
      /** @param {{ html: string, baseUrl: string, title: string } | null} frame */
      (frame) => ipcRenderer.send('printing:request', frame),
    ],
  });
}
