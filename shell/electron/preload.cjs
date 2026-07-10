// Preload for the webOS shell renderer.
//
// Exposes a minimal, read-only filesystem bridge (`window.webosFs`) backed by
// IPC handlers in main.cjs. Runs sandboxed with context isolation; only the
// three whitelisted operations below are reachable from the page, and the
// main process re-validates every request (sender + arguments).
//
// This preload is attached only to the shell's BrowserWindow - never to the
// <webview>s the web browser app embeds, so remote sites can't see it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webosFs', {
  /** Absolute path of the shell user's home directory. */
  home: () => ipcRenderer.invoke('fs:home'),

  /** List a directory (entries with resolved kind, size, mtime). */
  list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),

  /** Read up to `maxBytes` of a regular file (for previews). */
  readFile: (filePath, maxBytes) =>
    ipcRenderer.invoke('fs:read', filePath, maxBytes),
});
