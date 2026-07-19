// Preload for the Din renderer.
//
// Exposes eight bridges backed by IPC handlers in main.cjs:
//   - window.fs: filesystem access for the Files app
//   - window.pty: interactive shell sessions for the Terminal app
//   - window.wifi: NetworkManager (nmcli) control for the Settings app
//   - window.display: xrandr screen-resolution control for the Settings app
//   - window.power: battery/AC status for the menu bar and Settings app
//   - window.audio: wpctl volume/mute for the menu bar, Settings, and OSD
//   - window.crx: Chrome extension coordination for the Web Browser app
//   - window.devtools: docked devtools control for the Web Browser app
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

// WiFi bridge (window.wifi), backed by the wifi:* handlers in main.cjs
// (nmcli / NetworkManager). Used by the Settings app.
contextBridge.exposeInMainWorld('wifi', {
  /** Adapter/radio state. `available: false` when NetworkManager is absent. */
  status: () => ipcRenderer.invoke('wifi:status'),

  /** Visible networks, one entry per SSID. `rescan` forces a fresh scan. */
  networks: (rescan) => ipcRenderer.invoke('wifi:networks', rescan),

  /** Names of saved (remembered) WiFi connection profiles. */
  saved: () => ipcRenderer.invoke('wifi:saved'),

  /** Join a network, creating or updating its saved profile. */
  connect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),

  /** Disconnect the WiFi adapter from its current network. */
  disconnect: () => ipcRenderer.invoke('wifi:disconnect'),

  /** Delete a saved network profile. */
  forget: (ssid) => ipcRenderer.invoke('wifi:forget', ssid),

  /** Turn the WiFi radio on or off. */
  setRadio: (enabled) => ipcRenderer.invoke('wifi:setRadio', enabled),
});

// Display bridge (window.display), backed by the display:* handlers in
// main.cjs (xrandr). Used by the Settings app to change screen resolution on
// a bare X11 session. `available: false` where xrandr doesn't apply
// (Wayland/cage), so the panel can render a fallback.
contextBridge.exposeInMainWorld('display', {
  /** Connected outputs with their available modes. `available: false` = no xrandr. */
  status: () => ipcRenderer.invoke('display:status'),

  /** Set an output's resolution (validated against its reported modes). */
  setMode: (output, width, height) =>
    ipcRenderer.invoke('display:setMode', output, width, height),
});

// Power bridge (window.power), backed by the power:* handler in main.cjs
// (/sys/class/power_supply). Used by the menu-bar battery indicator and the
// Settings battery panel. `available: false` on machines with no battery.
contextBridge.exposeInMainWorld('power', {
  /** Battery/AC state. `available: false` when no battery is present. */
  status: () => ipcRenderer.invoke('power:status'),
});

// Audio bridge (window.audio), backed by the audio:* handlers in main.cjs
// (wpctl / PipeWire). Drives the default sink for the menu-bar control, the
// Settings sound panel, and the media-key OSD. Mutations resolve to the new
// { available, volume, muted } state. `available: false` when wpctl is absent.
contextBridge.exposeInMainWorld('audio', {
  /** Default sink volume/mute. `available: false` when wpctl is absent. */
  status: () => ipcRenderer.invoke('audio:status'),

  /** Set the default sink volume (0-100). Resolves to the new state. */
  setVolume: (percent) => ipcRenderer.invoke('audio:setVolume', percent),

  /** Mute or unmute the default sink. Resolves to the new state. */
  setMuted: (muted) => ipcRenderer.invoke('audio:setMuted', muted),

  /**
   * Subscribe to media-key volume changes (VolumeUp/Down/Mute), for the OSD.
   * The callback receives the new { available, volume, muted } state. Returns
   * an unsubscribe fn.
   */
  onOsd: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('audio:osd', listener);
    return () => ipcRenderer.removeListener('audio:osd', listener);
  },
});

// Chrome extension bridge (window.crx), backed by the crx:* handlers in
// main.cjs (electron-chrome-extensions). Used by the web browser app to
// coordinate its tab UI with the extension system: extensions can ask for
// tabs to be created/activated/closed, and the shell reports which tab is
// active plus the WebContents id of each newly attached <webview> guest.
contextBridge.exposeInMainWorld('crx', {
  /** Report the active browser tab's webContents id. */
  tabActivated: (wcId) => ipcRenderer.send('crx:tabActivated', wcId),

  /** Answer a `create` tab request with the new guest's webContents id. */
  resolveCreateTab: (requestId, wcId) =>
    ipcRenderer.send('crx:resolveCreateTab', requestId, wcId),

  /**
   * Subscribe to extension-initiated tab commands. Returns an unsubscribe fn.
   * Commands: { type: 'create', requestId, url?, active }
   *           { type: 'open', url }             (target=_blank from a page)
   *           { type: 'select', wcId }          (chrome.tabs.update active)
   *           { type: 'close', wcId }           (chrome.tabs.remove)
   */
  onTabCommand: (callback) => {
    const create = (_event, d) =>
      callback({ type: 'create', requestId: d.requestId, url: d.url, active: d.active });
    const open = (_event, d) => callback({ type: 'open', url: d.url });
    const select = (_event, d) => callback({ type: 'select', wcId: d.wcId });
    const close = (_event, d) => callback({ type: 'close', wcId: d.wcId });
    ipcRenderer.on('crx:createTab', create);
    ipcRenderer.on('crx:openTab', open);
    ipcRenderer.on('crx:selectTab', select);
    ipcRenderer.on('crx:removeTab', close);
    return () => {
      ipcRenderer.removeListener('crx:createTab', create);
      ipcRenderer.removeListener('crx:openTab', open);
      ipcRenderer.removeListener('crx:selectTab', select);
      ipcRenderer.removeListener('crx:removeTab', close);
    };
  },

  /** Installed extensions ({ id, name, version, description }[]). */
  listExtensions: () => ipcRenderer.invoke('crx:listExtensions'),

  /** Uninstall an installed extension by id. */
  uninstallExtension: (id) => ipcRenderer.invoke('crx:uninstallExtension', id),
});

// DevTools bridge (window.devtools), backed by the devtools:* handlers in
// main.cjs. The web browser app docks Chrome DevTools inside a tab: it
// renders a devtools host <webview> and asks main to open the tab's
// devtools in it (the host loads the bundled DevTools frontend, connected
// to the tab over a loopback CDP bridge - see devtools-bridge.cjs).
contextBridge.exposeInMainWorld('devtools', {
  /** Dock a tab's devtools into a devtools host <webview> and open them. */
  open: (targetWcId, hostWcId) =>
    ipcRenderer.invoke('devtools:open', targetWcId, hostWcId),

  /** Close a tab's devtools. */
  close: (targetWcId) => ipcRenderer.invoke('devtools:close', targetWcId),

  /** Highlight the element at page coordinates in the tab's open devtools. */
  inspect: (targetWcId, x, y) =>
    ipcRenderer.invoke('devtools:inspect', targetWcId, x, y),

  /**
   * Apply device/responsive emulation to a tab (metrics object) or clear it
   * (null). Independent of whether the tab's devtools pane is open.
   */
  emulate: (targetWcId, metrics) =>
    ipcRenderer.invoke('devtools:emulate', targetWcId, metrics),

  /**
   * Subscribe to devtools commands from the main process. Returns an
   * unsubscribe fn. Commands:
   *   { type: 'toggle', wcId }        (F12 / Ctrl+Shift+I inside a guest)
   *   { type: 'inspect', wcId, x, y } (context menu "Inspect")
   *   { type: 'closed', wcId }        (devtools died with its tab/pane)
   */
  onCommand: (callback) => {
    const toggle = (_event, d) => callback({ type: 'toggle', wcId: d.wcId });
    const inspect = (_event, d) =>
      callback({ type: 'inspect', wcId: d.wcId, x: d.x, y: d.y });
    const closed = (_event, d) => callback({ type: 'closed', wcId: d.wcId });
    ipcRenderer.on('devtools:toggleRequested', toggle);
    ipcRenderer.on('devtools:inspectRequested', inspect);
    ipcRenderer.on('devtools:closed', closed);
    return () => {
      ipcRenderer.removeListener('devtools:toggleRequested', toggle);
      ipcRenderer.removeListener('devtools:inspectRequested', inspect);
      ipcRenderer.removeListener('devtools:closed', closed);
    };
  },
});

// Shell-level keyboard shortcuts forwarded from the main process. Keyboard
// focus often lives inside <webview> guests (browser tabs, devtools panes),
// where the shell can't observe keydown events - main.cjs intercepts shell
// shortcuts there via before-input-event and forwards them here. See
// src/lib/shellShortcuts.ts for the typed renderer-side accessor.
contextBridge.exposeInMainWorld('shellShortcuts', {
  /**
   * Subscribe to forwarded shortcuts. Returns an unsubscribe fn. Payloads:
   *   { action: 'cycle-windows', backward } (Alt+Tab / Alt+Shift+Tab)
   *   { action: 'new-tab', wcId }           (Ctrl+T in a browser tab)
   *   { action: 'close-tab', wcId }         (Ctrl+W in a browser tab)
   */
  onShortcut: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },
});
