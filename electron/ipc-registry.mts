// The shell's IPC handlers, by channel, so a bridge port granted to an app
// (electron/din-apps.mts) can reach the same code the shell's ipcRenderer
// calls do. main.mts imports this first, before anything registers a
// handler.
//
// On Windows, what the shell's pages send and get back has its paths in
// Din's form (electron/windows-paths.mts), translated here for every
// handler at once. The maps keep the handlers as written: a bridge port
// translates its own calls, after checking them.

import { ipcMain } from 'electron';
import { argsFromDin, valueForDin } from './windows-paths.mts';

export type Handler = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, ...args: unknown[]) => unknown;

/** ipcMain.handle handlers. */
export const invokeHandlers = new Map<string, Handler>();
/** ipcMain.on listeners (the last one per channel). */
export const sendHandlers = new Map<string, Handler>();

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  invokeHandlers.set(channel, listener as Handler);
  if (process.platform !== 'win32') return handle(channel, listener);
  return handle(channel, async (event, ...args) => valueForDin(channel, await listener(event, ...argsFromDin(channel, args))));
};
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => {
  if (typeof channel !== 'string') return on(channel, listener);
  sendHandlers.set(channel, listener as Handler);
  if (process.platform !== 'win32') return on(channel, listener);
  return on(channel, (event, ...args) => listener(event, ...argsFromDin(channel, args)));
};
