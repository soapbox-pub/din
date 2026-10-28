// The shell's IPC handlers, by channel, so a bridge port granted to an app
// (electron/din-apps.mts) can reach the same code the shell's ipcRenderer
// calls do. main.mts imports this first, before anything registers a
// handler.

import { ipcMain } from 'electron';

export type Handler = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, ...args: unknown[]) => unknown;

/** ipcMain.handle handlers. */
export const invokeHandlers = new Map<string, Handler>();
/** ipcMain.on listeners (the last one per channel). */
export const sendHandlers = new Map<string, Handler>();

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  invokeHandlers.set(channel, listener as Handler);
  return handle(channel, listener);
};
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => {
  if (typeof channel === 'string') sendHandlers.set(channel, listener as Handler);
  return on(channel, listener);
};
