// @ts-check
// Session preload for web pages - browser tabs (private and Tor ones too)
// and installed web apps and nsites - for power mode (src/lib/powerMode.ts,
// electron/power-mode.mts): while it's on, each key typed into a text field
// tells Din where the caret is, for the sparks to fly from.
//
// It runs in the preload's own world, which the page can't see or reach,
// and sends nothing while power mode is off: only where the caret is on the
// screen and the text's color, never what was typed.
//
// Where the caret is comes from src/shared/caret.ts, which
// scripts/build-din-runtime.mjs bundles into the function below and writes
// this file out with it as power-mode-preload.built.cjs, which is what
// Electron loads: a sandboxed preload can't load a sibling file.
//
// Plain CommonJS: sandboxed preloads can't be ESM or TypeScript.

const { ipcRenderer } = require('electron');

const loadCaret = /** @type {(() => { caretSpot: (doc: Document) => { x: number, y: number, color: string } | null, typesText: (e: KeyboardEvent) => boolean }) | null} */ (
  /* @caret */ null
);

if (process.isMainFrame && loadCaret) {
  const { caretSpot, typesText } = loadCaret();
  let on = false;
  ipcRenderer.on('power-mode:on', (_event, value) => {
    on = value === true;
  });
  ipcRenderer.invoke('power-mode:on').then(
    (value) => {
      on = value === true;
    },
    () => {},
  );
  window.addEventListener(
    'keydown',
    (e) => {
      if (!on || !typesText(e)) return;
      // After the key has gone in, so the caret has moved.
      requestAnimationFrame(() => {
        const spot = caretSpot(document);
        if (spot) ipcRenderer.send('power-mode:typed', { ...spot, width: window.innerWidth });
      });
    },
    true,
  );
}
