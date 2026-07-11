// Preload for the webOS shell renderer.
//
// Exposes two bridges backed by IPC handlers in main.cjs:
//   - window.fs: filesystem access for the Files app
//   - window.pty: interactive shell sessions for the Terminal app
//
// The fs API is Node-flavored (homedir/readdir/readFile/writeFile/...)
// but is deliberately NOT Node's fs module:
//   - promise-only, no sync or callback variants
//   - readdir returns rich entries (kind/size/mtime) in one batched call
//   - readFile is size-capped (previews, not bulk transfer)
//
// Runs sandboxed with context isolation; only the operations below are
// reachable from the page, and the main process re-validates every request
// (sender + arguments). Filesystem authority is bounded by the unprivileged
// OS user the shell runs as - see main.cjs for the threat model.
//
// This preload is attached only to the shell's BrowserWindow - never to the
// <webview>s the web browser app embeds, so remote sites can't see it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fs', {
  /** Absolute path of the shell user's home directory. */
  homedir: () => ipcRenderer.invoke('fs:homedir'),

  /** Metadata for a single path (follows symlinks). */
  stat: (path) => ipcRenderer.invoke('fs:stat', path),

  /** List a directory (entries with resolved kind, size, mtime). */
  readdir: (path) => ipcRenderer.invoke('fs:readdir', path),

  /** Read up to `maxBytes` of a regular file (for previews). */
  readFile: (path, maxBytes) => ipcRenderer.invoke('fs:readFile', path, maxBytes),

  /** Write a file (Uint8Array or string contents), replacing any existing. */
  writeFile: (path, data) => ipcRenderer.invoke('fs:writeFile', path, data),

  /** Create a directory (recursive, like `mkdir -p`). */
  mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),

  /** Rename/move a file or directory. */
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),

  /** Copy a single regular file. */
  copyFile: (from, to) => ipcRenderer.invoke('fs:copyFile', from, to),

  /**
   * Remove a file or directory. Deleting a non-empty directory requires an
   * explicit `{ recursive: true }`.
   */
  rm: (path, options) => ipcRenderer.invoke('fs:rm', path, options),
});

// Terminal bridge (window.pty), backed by the pty:* handlers in main.cjs.
// Each session is a real login shell on a pseudo-terminal; data flows as
// raw bytes (Uint8Array out, string in - what xterm.js produces/consumes).
contextBridge.exposeInMainWorld('pty', {
  /** Start a shell session; resolves to its session id. */
  spawn: (size) => ipcRenderer.invoke('pty:spawn', size),

  /** Send user keystrokes/paste data to a session. */
  write: (id, data) => ipcRenderer.send('pty:write', id, data),

  /** Inform the session's pty of a new terminal size. */
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),

  /** Terminate a session (SIGTERM to the pty host, SIGHUP to the shell). */
  kill: (id) => ipcRenderer.send('pty:kill', id),

  /** Subscribe to output from all sessions. Returns an unsubscribe fn. */
  onData: (callback) => {
    const listener = (_event, id, data) => callback(id, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  /** Subscribe to session exits. Returns an unsubscribe fn. */
  onExit: (callback) => {
    const listener = (_event, id, code) => callback(id, code);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },
});
