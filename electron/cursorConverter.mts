// The cursor converter's sandbox: a hidden window, one per import, that
// turns the bytes of whatever the user picked into cursors
// (src/lib/cursorImport, bundled into cursor-converter.js by
// scripts/build-cursor-converter.mjs).
//
// Parsing archives and decoding images from strangers is where a bug turns
// into an exploit, so none of it happens in the main process. The window is
// sandboxed, has no Node, and lives in an in-memory session of its own where
// every request but its own data: page is cancelled and every permission is
// refused. Its page is an opaque-origin data: URL with a CSP that allows
// nothing but data: images, it can't navigate or open windows, and it's
// destroyed when the job is done or takes too long. What it sends back is
// only data, which cursorImport.mts checks in full before writing anything.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, session } from 'electron';

const PARTITION = 'din-cursor-converter';
const PRELOAD = path.join(import.meta.dirname, 'cursor-converter-preload.cjs');
const BUNDLE = path.join(import.meta.dirname, 'cursor-converter.js');
const TIMEOUT_MS = 120_000;

const PAGE =
  '<!doctype html><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">` +
  '<title>Cursor converter</title>';

let prepared: Electron.Session | null = null;

function converterSession(): Electron.Session {
  if (prepared) return prepared;
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  prepared = ses;
  return ses;
}

/** Run `request` through the converter; resolves with what its page sends back, unchecked. */
export async function convertInSandbox(request: unknown): Promise<unknown> {
  let bundle: string;
  try {
    bundle = await fs.readFile(BUNDLE, 'utf8');
  } catch {
    throw new Error('The cursor converter isn’t built (node scripts/build-cursor-converter.mjs).');
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webgl: false,
      spellcheck: false,
      enableWebSQL: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      session: converterSession(),
      preload: PRELOAD,
    },
  });
  const contents = win.webContents;
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = new Promise<unknown>((resolve, reject) => {
      contents.ipc.once('cursor-converter:done', (_event, value: unknown) => resolve(value));
      contents.once('render-process-gone', () => reject(new Error('The cursor converter stopped unexpectedly.')));
      timer = setTimeout(() => reject(new Error('Converting the cursors took too long.')), TIMEOUT_MS);
    });
    await contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    await contents.executeJavaScript(bundle);
    contents.send('cursor-converter:job', request);
    return await outcome;
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}
