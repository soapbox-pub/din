// Power mode in web pages (window.dinos.powerMode - see preload.cjs and
// src/lib/powerMode.ts). The desktop says whether it's on; web pages'
// power-mode-preload.cjs hears it, and while it's on reports where the
// caret is as keys are typed, which goes on to the desktop with the page's
// WebContents id for it to place on the screen. Built-in apps tell the
// desktop themselves, over window.din.

import { ipcMain, webContents, type WebContents } from 'electron';

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Whether a guest is a web page of the shell's (a browser tab, an installed web app or nsite). */
  isPageGuest: (contents: WebContents) => boolean;
}

let on = false;

export function registerPowerModeHandlers(opts: Options): void {
  ipcMain.handle('power-mode:set', (event, value: unknown) => {
    opts.assertShellSender(event);
    if ((value === true) === on) return;
    on = value === true;
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.getType() === 'webview' && opts.isPageGuest(contents)) {
        contents.send('power-mode:on', on);
      }
    }
  });

  // From power-mode-preload.cjs, as a page loads.
  ipcMain.handle('power-mode:on', (event) => on && opts.isPageGuest(event.sender));

  // From power-mode-preload.cjs: a key typed, and where the caret is now.
  ipcMain.on('power-mode:typed', (event, raw: unknown) => {
    if (!on || !raw || typeof raw !== 'object' || !opts.isPageGuest(event.sender)) return;
    const { x, y, width, color } = raw as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0)) return;
    opts.sendToShell('power-mode:typed', {
      wcId: event.sender.id,
      x,
      y,
      width,
      color: typeof color === 'string' ? color.slice(0, 100) : '',
    });
  });
}
