// @ts-check
// Preload for the Din renderer.
//
// Exposes bridges backed by IPC handlers in main.mts:
//   - window.boot: first-frame readiness for the hidden-until-ready shell window
//   - window.fs: filesystem access for the Files app
//   - window.pty: interactive shell sessions for the Terminal app
//   - window.wifi: NetworkManager (nmcli) control for the Settings app
//   - window.vpn: VPN/WireGuard profile toggles for the network selector
//   - window.display: xrandr multi-output arrangement for the Settings app
//   - window.zoom: Chromium page zoom (interface scale) for the Settings app
//   - window.power: battery/AC status + system power profiles for the menu
//     bar and Settings app
//   - window.audio: wpctl volume/mute for the menu bar, Settings, and OSD
//   - window.brightness: backlight + night light for the menu bar, Settings, OSD
//   - window.screenshot: capture the desktop as a PNG for the Screenshot app
//   - window.browser: TLS certificate exceptions, browsing-data clearing,
//     find-in-page, and download progress for the Web Browser app
//   - window.crx: Chrome extension coordination for the Web Browser app
//   - window.userscripts: userscript library sync and install
//     requests for the Web Browser app
//   - window.devtools: docked devtools control for the Web Browser app
//   - window.nostrHost: relays NIP-07 requests from installed web apps to the
//     signed-in account's signer (see NostrBridgeHost / webview-preload.cjs)
//   - window.highlightHost: relays NIP-84 highlight clicks from browser tabs to
//     the signer (see HighlightBridgeHost / browser-highlight-preload.cjs)
//   - window.filePickerHost: relays <input type=file> clicks from guests to the
//     in-Din file picker (see FilePickerBridgeHost)
//   - window.nsiteHost: relays nsite:// manifest lookups to the renderer's
//     Nostr client (see NsiteBridgeHost / electron/nsite.mts)
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
// OS user the shell runs as - see main.mts for the threat model.
//
// This preload is attached only to the shell's BrowserWindow - never to the
// <webview>s the web browser app embeds, so remote sites can't see it.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Boot bridge (window.boot): the renderer reports that the app has mounted
// beneath the black boot veil; main.mts keeps the shell window hidden until
// this arrives so the window never maps onto an unpainted (white/garbage)
// surface on bare X11.
contextBridge.exposeInMainWorld('boot', {
  /** Signal that the shell's first frame is ready to be shown. */
  ready: () => ipcRenderer.send('shell:bootReady'),
});

contextBridge.exposeInMainWorld('fs', {
  /** Absolute path of the shell user's home directory. */
  homedir: () => ipcRenderer.invoke('fs:homedir'),

  /**
   * Metadata for a single path (follows symlinks).
   * @param {string} path
   */
  stat: (path) => ipcRenderer.invoke('fs:stat', path),

  /**
   * List a directory (entries with resolved kind, size, mtime).
   * @param {string} path
   */
  readdir: (path) => ipcRenderer.invoke('fs:readdir', path),

  /**
   * Read up to `maxBytes` of a regular file (for previews).
   * @param {string} path
   * @param {number} [maxBytes]
   */
  readFile: (path, maxBytes) => ipcRenderer.invoke('fs:readFile', path, maxBytes),

  /**
   * Write a file (Uint8Array or string contents), replacing any existing.
   * @param {string} path
   * @param {string | Uint8Array} data
   */
  writeFile: (path, data) => ipcRenderer.invoke('fs:writeFile', path, data),

  /**
   * Create a directory (recursive, like `mkdir -p`).
   * @param {string} path
   */
  mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),

  /**
   * Rename/move a file or directory.
   * @param {string} from
   * @param {string} to
   */
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),

  /**
   * Copy a single regular file.
   * @param {string} from
   * @param {string} to
   */
  copyFile: (from, to) => ipcRenderer.invoke('fs:copyFile', from, to),

  /**
   * Remove a file or directory. Deleting a non-empty directory requires an
   * explicit `{ recursive: true }`.
   * @param {string} path
   * @param {{ recursive?: boolean }} [options]
   */
  rm: (path, options) => ipcRenderer.invoke('fs:rm', path, options),
});

// Terminal bridge (window.pty), backed by the pty:* handlers in main.mts.
// Each session is a real login shell on a pseudo-terminal; data flows as
// raw bytes (Uint8Array out, string in - what xterm.js produces/consumes).
contextBridge.exposeInMainWorld('pty', {
  /**
   * Start a shell session; resolves to its session id.
   * @param {{ rows: number, cols: number }} size
   * @param {string} [cwd]
   */
  spawn: (size, cwd) => ipcRenderer.invoke('pty:spawn', size, cwd),

  /**
   * Send user keystrokes/paste data to a session.
   * @param {number} id
   * @param {string} data
   */
  write: (id, data) => ipcRenderer.send('pty:write', id, data),

  /**
   * Inform the session's pty of a new terminal size.
   * @param {number} id
   * @param {number} cols
   * @param {number} rows
   */
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),

  /**
   * Terminate a session (SIGTERM to the pty host, SIGHUP to the shell).
   * @param {number} id
   */
  kill: (id) => ipcRenderer.send('pty:kill', id),

  /**
   * Subscribe to output from all sessions. Returns an unsubscribe fn.
   * @param {(id: number, data: Uint8Array) => void} callback
   */
  onData: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {number} id
     * @param {Uint8Array} data
     */
    const listener = (_event, id, data) => callback(id, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  /**
   * Subscribe to session exits. Returns an unsubscribe fn.
   * @param {(id: number, code: number) => void} callback
   */
  onExit: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {number} id
     * @param {number} code
     */
    const listener = (_event, id, code) => callback(id, code);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },
});

// WiFi bridge (window.wifi), backed by the wifi:* handlers in main.mts
// (nmcli / NetworkManager). Used by the Settings app.
contextBridge.exposeInMainWorld('wifi', {
  /** Adapter/radio state. `available: false` when NetworkManager is absent. */
  status: () => ipcRenderer.invoke('wifi:status'),

  /**
   * Visible networks, one entry per SSID. `rescan` forces a fresh scan.
   * @param {boolean} [rescan]
   */
  networks: (rescan) => ipcRenderer.invoke('wifi:networks', rescan),

  /** Names of saved (remembered) WiFi connection profiles. */
  saved: () => ipcRenderer.invoke('wifi:saved'),

  /**
   * Join a network, creating or updating its saved profile.
   * @param {string} ssid
   * @param {string} [password]
   */
  connect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),

  /** Disconnect the WiFi adapter from its current network. */
  disconnect: () => ipcRenderer.invoke('wifi:disconnect'),

  /**
   * Delete a saved network profile.
   * @param {string} ssid
   */
  forget: (ssid) => ipcRenderer.invoke('wifi:forget', ssid),

  /**
   * Turn the WiFi radio on or off.
   * @param {boolean} enabled
   */
  setRadio: (enabled) => ipcRenderer.invoke('wifi:setRadio', enabled),
});

// VPN bridge (window.vpn), backed by the vpn:* handlers in main.mts (nmcli /
// NetworkManager). Toggles existing VPN/WireGuard profiles from the network
// selector; profiles are created out of band (imported config / Terminal).
contextBridge.exposeInMainWorld('vpn', {
  /** Saved VPN/WireGuard profiles with their active state. `[]` when NetworkManager is absent. */
  list: () => ipcRenderer.invoke('vpn:list'),

  /**
   * Bring a saved VPN profile up.
   * @param {string} name
   */
  connect: (name) => ipcRenderer.invoke('vpn:connect', name),

  /**
   * Bring a saved VPN profile down.
   * @param {string} name
   */
  disconnect: (name) => ipcRenderer.invoke('vpn:disconnect', name),
});

// Display bridge (window.display), backed by the display:* handlers in
// main.mts (xrandr). Used by the Settings app to arrange the outputs on a bare
// X11 session: resolution, position, on/off and which one is primary.
// `available: false` where xrandr doesn't apply (Wayland/cage), so the panel
// can render a fallback.
contextBridge.exposeInMainWorld('display', {
  /** Connected outputs with their available modes/positions. `available: false` = no xrandr. */
  status: () => ipcRenderer.invoke('display:status'),

  /**
   * Apply a complete output arrangement in one atomic xrandr call. Each
   * placement is { output, enabled, primary, x, y, width, height }; every
   * field is re-validated in the main process against xrandr's own report.
   * @param {Array<{ output: string, enabled: boolean, primary: boolean, x: number, y: number, width: number, height: number }>} placements
   */
  applyLayout: (placements) => ipcRenderer.invoke('display:applyLayout', placements),
});

// Native-app bridge (window.nativeApps), backed by the native-apps:* handlers
// in main.mts (XDG desktop entries + EWMH over a raw X11 connection; see
// electron/native-apps.mts). Din acts as the taskbar for ordinary Linux apps:
// it lists and launches them, and tracks/steers their toplevel windows, which
// the host window manager stacks above the shell's own window.
// `available: false` without an X11 session, so the Dock and launcher can
// simply leave them out.
contextBridge.exposeInMainWorld('nativeApps', {
  /** Installed desktop entries, with icons inlined as data URLs. */
  list: () => ipcRenderer.invoke('native-apps:list'),

  /** The session's current toplevel windows. */
  windows: () => ipcRenderer.invoke('native-apps:windows'),

  /**
   * Start an app by its registry id ("native:org.gnome.Calculator").
   * @param {string} appId
   */
  launch: (appId) => ipcRenderer.invoke('native-apps:launch', appId),

  /**
   * Raise a window and give it the keyboard focus (un-minimizing it first).
   * @param {number} windowId
   */
  activate: (windowId) => ipcRenderer.invoke('native-apps:activate', windowId),

  /**
   * Minimize a window.
   * @param {number} windowId
   */
  minimize: (windowId) => ipcRenderer.invoke('native-apps:minimize', windowId),

  /**
   * Ask a window to close (the app may still prompt to save).
   * @param {number} windowId
   */
  close: (windowId) => ipcRenderer.invoke('native-apps:close', windowId),

  /**
   * Subscribe to window-list changes (opened, closed, renamed, minimized,
   * focused). Returns an unsubscribe fn.
   * @param {(windows: Array<{ id: number, appId: string | null, title: string, minimized: boolean, active: boolean }>) => void} callback
   */
  onWindows: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {Array<{ id: number, appId: string | null, title: string, minimized: boolean, active: boolean }>} windows
     */
    const handler = (_event, windows) => callback(windows);
    ipcRenderer.on('native-apps:windows', handler);
    return () => ipcRenderer.removeListener('native-apps:windows', handler);
  },
});

// Zoom bridge (window.zoom). Sets Chromium's page zoom for the shell window -
// true DPI-style scaling: the layout viewport shrinks/grows so innerWidth,
// viewport units and canvas measurements all stay consistent (unlike CSS
// `zoom`, which scales rendering but not layout). Renderer-local via webFrame;
// no IPC or main-process handler involved.
contextBridge.exposeInMainWorld('zoom', {
  /**
   * Set the interface zoom factor (1 = native size). Clamped to 0.5-2.
   * @param {number} factor
   */
  set: (factor) => {
    if (!Number.isFinite(factor)) return;
    webFrame.setZoomFactor(Math.min(2, Math.max(0.5, factor)));
  },
});

// Power bridge (window.power), backed by the power:* handlers in main.mts.
// `status` reads battery/AC state from /sys/class/power_supply (menu-bar
// indicator + Settings battery panel; `available: false` with no battery).
// `profiles`/`setProfile` drive the system power profile through the
// net.hadess.PowerProfiles D-Bus API (power-profiles-daemon / tuned-ppd);
// `available: false` when no such daemon is running.
contextBridge.exposeInMainWorld('power', {
  /** Battery/AC state. `available: false` when no battery is present. */
  status: () => ipcRenderer.invoke('power:status'),

  /** Available power profiles + the active one. `available: false` with no daemon. */
  profiles: () => ipcRenderer.invoke('power:profiles'),

  /**
   * Switch the active power profile. Resolves to the new profiles state.
   * @param {string} name
   */
  setProfile: (name) => ipcRenderer.invoke('power:setProfile', name),
});

// Audio bridge (window.audio), backed by the audio:* handlers in main.mts
// (wpctl / PipeWire). Drives the default sink for the menu-bar control and the
// media-key OSD (status/setVolume/setMuted resolve to { available, volume,
// muted }), plus the Settings sound panel: device enumeration/selection
// (devices/setDefault), per-app and per-device control (streams/setNodeVolume/
// setNodeMuted) and a test tone (test). `available: false` when wpctl is absent.
contextBridge.exposeInMainWorld('audio', {
  /** Default sink volume/mute. `available: false` when wpctl is absent. */
  status: () => ipcRenderer.invoke('audio:status'),

  /**
   * Set the default sink volume (0-100). Resolves to the new state.
   * @param {number} percent
   */
  setVolume: (percent) => ipcRenderer.invoke('audio:setVolume', percent),

  /**
   * Mute or unmute the default sink. Resolves to the new state.
   * @param {boolean} muted
   */
  setMuted: (muted) => ipcRenderer.invoke('audio:setMuted', muted),

  /** List output (sink) and input (source) devices. */
  devices: () => ipcRenderer.invoke('audio:devices'),

  /** List per-application playback streams. */
  streams: () => ipcRenderer.invoke('audio:streams'),

  /**
   * Make a device the default sink/source by node id. Resolves to the new
   * device list.
   * @param {number} id
   */
  setDefault: (id) => ipcRenderer.invoke('audio:setDefault', id),

  /**
   * Set any node's volume (0-100) by id (per-app streams, per-device).
   * @param {number} id
   * @param {number} percent
   */
  setNodeVolume: (id, percent) => ipcRenderer.invoke('audio:setNodeVolume', id, percent),

  /**
   * Mute or unmute any node by id.
   * @param {number} id
   * @param {boolean} muted
   */
  setNodeMuted: (id, muted) => ipcRenderer.invoke('audio:setNodeMuted', id, muted),

  /**
   * Play a short test tone to a sink by id.
   * @param {number} id
   */
  test: (id) => ipcRenderer.invoke('audio:test', id),

  /**
   * Subscribe to media-key volume changes (VolumeUp/Down/Mute), for the OSD.
   * The callback receives the new { available, volume, muted } state. Returns
   * an unsubscribe fn.
   * @param {(status: { available: boolean, volume: number | null, muted: boolean }) => void} callback
   */
  onOsd: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ available: boolean, volume: number | null, muted: boolean }} status
     */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('audio:osd', listener);
    return () => ipcRenderer.removeListener('audio:osd', listener);
  },
});

// Brightness bridge (window.brightness), backed by the brightness:* handlers in
// main.mts. Two independent halves: the screen backlight (brightnessctl /
// /sys/class/backlight) and night light / red shift (a warm color temperature
// held by a Wayland/X11 gamma tool, gammastep or wlsunset). Drives the menu-bar
// control, the Settings brightness panel, and the media-key OSD. Mutations
// resolve to the new { available, brightness, nightLight } state; each half
// reports available:false where its tool/device is absent.
contextBridge.exposeInMainWorld('brightness', {
  /** Backlight level + night-light state. See per-field `available` flags. */
  status: () => ipcRenderer.invoke('brightness:status'),

  /**
   * Set the backlight level (0-100). Resolves to the new state.
   * @param {number} percent
   */
  setBrightness: (percent) => ipcRenderer.invoke('brightness:setBrightness', percent),

  /**
   * Turn the warm night-light tint on or off. Resolves to the new state.
   * @param {boolean} enabled
   */
  setNightLight: (enabled) => ipcRenderer.invoke('brightness:setNightLight', enabled),

  /**
   * Set the night-light color temperature in Kelvin. Resolves to the new state.
   * @param {number} kelvin
   */
  setTemperature: (kelvin) => ipcRenderer.invoke('brightness:setTemperature', kelvin),

  /**
   * Subscribe to media-key brightness changes (MonBrightnessUp/Down), for the
   * OSD. The callback receives the new { available, brightness, nightLight }
   * state. Returns an unsubscribe fn.
   * @param {(status: { available: boolean, brightness: number | null, nightLight: object }) => void} callback
   */
  onOsd: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ available: boolean, brightness: number | null, nightLight: object }} status
     */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('brightness:osd', listener);
    return () => ipcRenderer.removeListener('brightness:osd', listener);
  },
});

// Screenshot bridge (window.screenshot), backed by the screenshot:* handler in
// main.mts (webContents.capturePage). Snapshots the Din desktop as a PNG for
// the Screenshot app. Absent in a plain browser, where the app falls back.
contextBridge.exposeInMainWorld('screenshot', {
  /** Capture the desktop; resolves to { dataUrl, width, height } (PNG). */
  capture: () => ipcRenderer.invoke('screenshot:capture'),

  /**
   * Capture just one window's on-screen rectangle (CSS pixels, relative to
   * the shell content's top-left), for the genie minimize/restore animation.
   * Resolves to { dataUrl, width, height } (PNG at device resolution).
   * @param {{ x: number, y: number, width: number, height: number }} rect
   */
  captureRegion: (rect) => ipcRenderer.invoke('screenshot:captureRegion', rect),
});

/**
 * Details of a rejected TLS certificate for a browser tab.
 * @typedef {{ wcId: number, url: string, host: string, error: string, fingerprint: string }} CertificateErrorInfo
 */

// Browser bridge (window.browser), backed by the browser:* handlers in
// main.mts. A browser tab that hits an untrusted TLS certificate (self-signed
// or private-CA host) has its load rejected; the details arrive here so the
// Web Browser app can show a "proceed anyway" warning. Accepting pins that
// exact (host, fingerprint) pair in the main process (persisted) so the
// following reload is trusted. Scoped to the browser session only.
contextBridge.exposeInMainWorld('browser', {
  /**
   * Subscribe to rejected-certificate reports for browser tabs. The callback
   * receives { wcId, url, host, error, fingerprint }. Returns an unsubscribe
   * fn.
   * @param {(info: CertificateErrorInfo) => void} callback
   */
  onCertificateError: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {CertificateErrorInfo} info
     */
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:certificateError', listener);
    return () => ipcRenderer.removeListener('browser:certificateError', listener);
  },

  /**
   * Pin a (host, fingerprint) pair as trusted, then reload the offending tab
   * (`wcId`) to `url` from the main process. Resolves once pinned.
   * @param {string} host
   * @param {string} fingerprint
   * @param {number} wcId
   * @param {string} url
   */
  trustCertificate: (host, fingerprint, wcId, url) =>
    ipcRenderer.invoke('browser:trustCertificate', host, fingerprint, wcId, url),

  /**
   * Clear Chromium-side browsing data for the persistent browser session.
   * `cache` wipes the HTTP cache; `cookies` wipes cookies plus all site
   * storage (localStorage, IndexedDB, service workers, ...). Resolves when
   * done. The app's own address-bar history is separate (cleared in-app).
   * @param {{ cache?: boolean, cookies?: boolean }} options
   */
  clearBrowsingData: (options) =>
    ipcRenderer.invoke('browser:clearBrowsingData', options),

  /**
   * Search a browser tab (`wcId`) for `text`. `options.forward` (default
   * true) sets direction; `options.findNext` continues the current search
   * (Enter/Shift+Enter); `options.matchCase` makes it case-sensitive. An
   * empty text clears the highlight. Match counts arrive via onFindResult.
   * @param {number} wcId
   * @param {string} text
   * @param {{ forward?: boolean, findNext?: boolean, matchCase?: boolean }} [options]
   */
  findInPage: (wcId, text, options) =>
    ipcRenderer.invoke('browser:findInPage', wcId, text, options),

  /**
   * Clear a browser tab's find-in-page highlight (find bar closed).
   * @param {number} wcId
   */
  stopFindInPage: (wcId) => ipcRenderer.invoke('browser:stopFindInPage', wcId),

  /**
   * Subscribe to find-in-page match results. The callback receives
   * { wcId, matches, activeMatchOrdinal, finalUpdate }. Returns an
   * unsubscribe fn.
   * @param {(result: { wcId: number, matches: number, activeMatchOrdinal: number, finalUpdate: boolean }) => void} callback
   */
  onFindResult: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, matches: number, activeMatchOrdinal: number, finalUpdate: boolean }} result
     */
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('browser:findResult', listener);
    return () => ipcRenderer.removeListener('browser:findResult', listener);
  },

  /**
   * Subscribe to download progress for browser tabs. Every download is saved
   * to ~/Downloads; each update carries { id, wcId, url, filename, savePath,
   * state, receivedBytes, totalBytes, paused }, where `state` is
   * 'progressing' | 'completed' | 'cancelled' | 'interrupted'. The app filters
   * by `wcId` to route the download to the window/tab that started it. Returns
   * an unsubscribe fn.
   * @param {(info: import('../src/lib/browser').DownloadInfo) => void} callback
   */
  onDownload: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {import('../src/lib/browser').DownloadInfo} info
     */
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:download', listener);
    return () => ipcRenderer.removeListener('browser:download', listener);
  },

  /**
   * Open a completed download with the OS default handler. Restricted to
   * files under ~/Downloads in the main process.
   * @param {string} savePath
   */
  openDownload: (savePath) => ipcRenderer.invoke('browser:openDownload', savePath),

  /**
   * Reveal a completed download in the file manager. Restricted to files
   * under ~/Downloads in the main process.
   * @param {string} savePath
   */
  showDownload: (savePath) => ipcRenderer.invoke('browser:showDownload', savePath),
});

/**
 * An extension-initiated tab command surfaced to the browser app.
 * @typedef {(
 *   { type: 'create', requestId: number, url?: string, active: boolean } |
 *   { type: 'open', url: string, openerWcId?: number, background?: boolean } |
 *   { type: 'select', wcId: number } |
 *   { type: 'close', wcId: number }
 * )} CrxTabCommand
 */

// Chrome extension bridge (window.crx), backed by the crx:* handlers in
// main.mts (electron-chrome-extensions). Used by the web browser app to
// coordinate its tab UI with the extension system: extensions can ask for
// tabs to be created/activated/closed, and the shell reports which tab is
// active plus the WebContents id of each newly attached <webview> guest.
contextBridge.exposeInMainWorld('crx', {
  /**
   * Report the active browser tab's webContents id.
   * @param {number} wcId
   */
  tabActivated: (wcId) => ipcRenderer.send('crx:tabActivated', wcId),

  /**
   * Answer a `create` tab request with the new guest's webContents id.
   * @param {number} requestId
   * @param {number} wcId
   */
  resolveCreateTab: (requestId, wcId) =>
    ipcRenderer.send('crx:resolveCreateTab', requestId, wcId),

  /**
   * Subscribe to extension-initiated tab commands. Returns an unsubscribe fn.
   * Commands: { type: 'create', requestId, url?, active }
   *           { type: 'open', url }             (target=_blank from a page)
   *           { type: 'select', wcId }          (chrome.tabs.update active)
   *           { type: 'close', wcId }           (chrome.tabs.remove)
   * @param {(command: CrxTabCommand) => void} callback
   */
  onTabCommand: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, url?: string, active: boolean }} d
     */
    const create = (_event, d) =>
      callback({ type: 'create', requestId: d.requestId, url: d.url, active: d.active });
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ url: string, openerWcId?: number, background?: boolean }} d
     */
    const open = (_event, d) =>
      callback({
        type: 'open',
        url: d.url,
        openerWcId: d.openerWcId,
        background: d.background,
      });
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number }} d
     */
    const select = (_event, d) => callback({ type: 'select', wcId: d.wcId });
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number }} d
     */
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

  /**
   * Uninstall an installed extension by id.
   * @param {string} id
   */
  uninstallExtension: (id) => ipcRenderer.invoke('crx:uninstallExtension', id),

  /**
   * Subscribe to extension action-popup open/close requests (chrome.action
   * popups hosted in-shell - see ExtensionPopupHost). An 'open' command
   * carries { extensionId, url, anchorRect }. Returns an unsubscribe fn.
   * @param {(command: { type: 'open', extensionId: string, url: string, anchorRect: { x: number, y: number, width: number, height: number } } | { type: 'close' }) => void} callback
   */
  onActionPopup: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ extensionId: string, url: string, anchorRect: { x: number, y: number, width: number, height: number } }} d
     */
    const open = (_event, d) =>
      callback({
        type: 'open',
        extensionId: d.extensionId,
        url: d.url,
        anchorRect: d.anchorRect,
      });
    const close = () => callback({ type: 'close' });
    ipcRenderer.on('crx:openActionPopup', open);
    ipcRenderer.on('crx:closeActionPopup', close);
    return () => {
      ipcRenderer.removeListener('crx:openActionPopup', open);
      ipcRenderer.removeListener('crx:closeActionPopup', close);
    };
  },

  /** Report the in-shell action popup was dismissed by the user. */
  actionPopupClosed: () => ipcRenderer.send('crx:actionPopupClosed'),
});

// Userscript bridge (window.userscripts), backed by the userscripts:*
// handlers in main.mts (electron/userscripts.mts). The shell renderer owns
// the script library (localStorage, see src/hooks/useUserscripts.ts) and
// syncs the full list here so the main process can inject matching scripts
// into browser-tab guests as pages load. Navigations to *.user.js files are
// intercepted in main and surfaced back as install requests.
contextBridge.exposeInMainWorld('userscripts', {
  /**
   * Replace the main process's script list (the renderer is authoritative).
   * @param {object[]} scripts
   */
  sync: (scripts) => ipcRenderer.send('userscripts:sync', scripts),

  /**
   * Fetch a userscript's source text over https (size-capped, in main).
   * @param {string} url
   */
  fetchText: (url) => ipcRenderer.invoke('userscripts:fetch', url),

  /**
   * Subscribe to *.user.js install requests. Returns an unsubscribe fn.
   * @param {(request: { url: string, wcId?: number }) => void} callback
   */
  onInstallRequested: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ url: string, wcId?: number }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('userscripts:installRequested', listener);
    return () => ipcRenderer.removeListener('userscripts:installRequested', listener);
  },
});

/**
 * Device/responsive emulation metrics for a browser tab.
 * @typedef {{ width: number, height: number, deviceScaleFactor?: number, mobile?: boolean, userAgent?: string }} DevtoolsEmulationMetrics
 */

/**
 * A devtools command pushed from the main process.
 * @typedef {(
 *   { type: 'toggle', wcId: number } |
 *   { type: 'inspect', wcId: number, x: number, y: number } |
 *   { type: 'closed', wcId: number }
 * )} DevtoolsCommand
 */

// DevTools bridge (window.devtools), backed by the devtools:* handlers in
// main.mts. The web browser app docks Chrome DevTools inside a tab: it
// renders a devtools host <webview> and asks main to open the tab's
// devtools in it (the host loads the bundled DevTools frontend, connected
// to the tab over a loopback CDP bridge - see devtools-bridge.mts).
contextBridge.exposeInMainWorld('devtools', {
  /**
   * Dock a tab's devtools into a devtools host <webview> and open them.
   * @param {number} targetWcId
   * @param {number} hostWcId
   */
  open: (targetWcId, hostWcId) =>
    ipcRenderer.invoke('devtools:open', targetWcId, hostWcId),

  /**
   * Close a tab's devtools.
   * @param {number} targetWcId
   */
  close: (targetWcId) => ipcRenderer.invoke('devtools:close', targetWcId),

  /**
   * Highlight the element at page coordinates in the tab's open devtools.
   * @param {number} targetWcId
   * @param {number} x
   * @param {number} y
   */
  inspect: (targetWcId, x, y) =>
    ipcRenderer.invoke('devtools:inspect', targetWcId, x, y),

  /**
   * Apply device/responsive emulation to a tab (metrics object) or clear it
   * (null). Independent of whether the tab's devtools pane is open.
   * @param {number} targetWcId
   * @param {DevtoolsEmulationMetrics | null} metrics
   */
  emulate: (targetWcId, metrics) =>
    ipcRenderer.invoke('devtools:emulate', targetWcId, metrics),

  /**
   * Subscribe to devtools commands from the main process. Returns an
   * unsubscribe fn. Commands:
   *   { type: 'toggle', wcId }        (F12 / Ctrl+Shift+I inside a guest)
   *   { type: 'inspect', wcId, x, y } (context menu "Inspect")
   *   { type: 'closed', wcId }        (devtools died with its tab/pane)
   * @param {(command: DevtoolsCommand) => void} callback
   */
  onCommand: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number }} d
     */
    const toggle = (_event, d) => callback({ type: 'toggle', wcId: d.wcId });
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, x: number, y: number }} d
     */
    const inspect = (_event, d) =>
      callback({ type: 'inspect', wcId: d.wcId, x: d.x, y: d.y });
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number }} d
     */
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
// where the shell can't observe keydown events - main.mts intercepts shell
// shortcuts there via before-input-event and forwards them here. See
// src/lib/shellShortcuts.ts for the typed renderer-side accessor.
contextBridge.exposeInMainWorld('shellShortcuts', {
  /**
   * Subscribe to forwarded shortcuts. Returns an unsubscribe fn. Payloads:
   *   { action: 'cycle-windows', backward }   (Alt+Tab / Alt+Shift+Tab)
   *   { action: 'screenshot' }                (Print Screen)
   *   { action: 'screenshot-area' }           (Shift+Print Screen or the box-select key)
   *   { action: 'new-tab', wcId }             (Ctrl+T in a browser tab)
   *   { action: 'close-tab', wcId }           (Ctrl+W in a browser tab)
   *   { action: 'focus-address', wcId }       (Ctrl+L in a browser tab)
   *   { action: 'find', wcId }                (Ctrl+F in a browser tab)
   *   { action: 'reload', force, wcId }       (Ctrl+R / F5, Ctrl+Shift+R / Shift+F5)
   *   { action: 'cycle-tab', backward, wcId } (Ctrl+Tab / Ctrl+Shift+Tab)
   *   { action: 'goto-tab', digit, wcId }     (Ctrl+1..9 in a browser tab)
   *   { action: 'back' | 'forward', wcId }    (Alt+Left / Alt+Right)
   * @param {(data: { action: string, wcId?: number, backward?: boolean, force?: boolean, digit?: number }) => void} callback
   */
  onShortcut: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ action: string, wcId?: number, backward?: boolean }} data
     */
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },
});

// Nostr identity bridge host (window.nostrHost), backed by the
// nostr-bridge:* handlers in main.mts. Installed web apps get a NIP-07
// window.nostr (see webview-preload.cjs) whose calls are relayed here, to the
// shell renderer, where the signed-in account's signer runs. The renderer
// subscribes via onRequest and answers each request with respond(). This is
// the ONLY bridge that serves the user's signer, so it must never be attached
// to a <webview> - only the shell (see the header note above).
contextBridge.exposeInMainWorld('nostrHost', {
  /**
   * Subscribe to signing requests relayed from installed web-app guests.
   * The callback receives { requestId, method, params, origin }. Returns an
   * unsubscribe fn.
   * @param {(request: { requestId: number, method: string, params?: unknown, origin: string }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, method: string, params?: unknown, origin: string }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('nostr-bridge:request', listener);
    return () => ipcRenderer.removeListener('nostr-bridge:request', listener);
  },

  /**
   * Answer a relayed request: { requestId, ok, result?, error? }.
   * @param {{ requestId: number, ok: boolean, result?: unknown, error?: string }} response
   */
  respond: (response) => ipcRenderer.send('nostr-bridge:response', response),
});

// Highlight bridge host (window.highlightHost), backed by the din-highlight:*
// handlers in main.mts. A browser tab's NIP-84 highlight click (see
// browser-highlight-preload.cjs) is relayed here, to the shell renderer, where
// HighlightBridgeHost builds and publishes a kind 9802 event with the signed-in
// account's signer. Unlike nostrHost this carries no arbitrary signing surface -
// only { url, text, context } for a fixed highlight kind.
contextBridge.exposeInMainWorld('highlightHost', {
  /**
   * Subscribe to highlight-publish requests relayed from browser tabs. The
   * callback receives { requestId, url, text, context }. Returns an
   * unsubscribe fn.
   * @param {(request: { requestId: number, url: string, text: string, context?: string }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, url: string, text: string, context?: string }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('din-highlight:request', listener);
    return () => ipcRenderer.removeListener('din-highlight:request', listener);
  },

  /**
   * Answer a relayed highlight request: { requestId, ok, result?, error? }.
   * @param {{ requestId: number, ok: boolean, result?: unknown, error?: string }} response
   */
  respond: (response) => ipcRenderer.send('din-highlight:response', response),
});

// nsite resolution host (window.nsiteHost), backed by the nsite:* handlers in
// main.mts. The nsite:// protocol handler needs Nostr lookups - NIP-19
// decoding, a NIP-05 fetch, and a relay query for the NIP-5A manifest - and
// the main process has no Nostr client, so each lookup is relayed here, to the
// shell renderer, where Nostrify and the user's relay list live (see
// NsiteBridgeHost). This carries no signing surface: it only turns a URL into
// a manifest or a redirect.
contextBridge.exposeInMainWorld('nsiteHost', {
  /**
   * Subscribe to nsite resolution requests. The callback receives
   * { requestId, url }. Returns an unsubscribe fn.
   * @param {(request: { requestId: number, url: string }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, url: string }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('nsite:request', listener);
    return () => ipcRenderer.removeListener('nsite:request', listener);
  },

  /**
   * Answer a relayed lookup: { requestId, resolution }.
   * @param {{ requestId: number, resolution: unknown }} response
   */
  respond: (response) => ipcRenderer.send('nsite:response', response),
});

// File-picker bridge host (window.filePickerHost), backed by the filepicker:*
// handlers in main.mts. A native <input type=file> click inside a browser or
// web-app guest is intercepted over CDP and relayed here, to the shell
// renderer, where FilePickerBridgeHost opens the in-Din FilePickerDialog and
// answers with the chosen absolute path (or null on cancel). The page never
// supplies the path - it only triggers the request.
contextBridge.exposeInMainWorld('filePickerHost', {
  /**
   * Subscribe to relayed file-chooser requests. The callback receives
   * { requestId, origin }. Returns an unsubscribe fn.
   * @param {(request: { requestId: number, origin: string }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, origin: string }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('filepicker:request', listener);
    return () => ipcRenderer.removeListener('filepicker:request', listener);
  },

  /**
   * Answer a relayed request: { requestId, path } where path is the chosen
   * absolute path, or null when the user cancelled.
   * @param {{ requestId: number, path: string | null }} response
   */
  respond: (response) => ipcRenderer.send('filepicker:response', response),
});
