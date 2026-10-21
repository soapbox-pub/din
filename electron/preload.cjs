// @ts-check
// Preload for the Din renderer.
//
// Exposes bridges backed by IPC handlers in main.mts:
//   - window.boot: first-frame readiness for the hidden-until-ready shell window
//   - window.session: end the desktop session (log out to the display manager)
//   - window.fs: filesystem access for the Files app
//   - window.pty: interactive shell sessions for the Terminal app
//   - window.wifi: NetworkManager (nmcli) control for the Settings app
//   - window.vpn: VPN/WireGuard profile toggles for the network selector
//   - window.display: multi-output arrangement (wlr-randr/xrandr) for the
//     Settings app
//   - window.monitors: where each display sits in the shell window, for the
//     desktop's layout
//   - window.zoom: Chromium page zoom (interface scale) for the Settings app
//   - window.theme: the light/dark mode pages see through prefers-color-scheme
//   - window.keyboard: the system's keyboard layout, for Settings
//   - window.tray: apps' status icons and their menus, for the menu bar
//   - window.systemNotifications: Linux apps' and web pages' notifications,
//     for the notification center
//   - window.installer: put DinOS on this computer's disk, for the
//     Installer app (live USB boots only)
//   - window.updater: DinOS system updates, for the Settings app
//   - window.bluetoothLogin: receive the account key from a phone over
//     Bluetooth LE, for the login screen
//   - window.nostrd: the signer daemon that holds the account keys, for the
//     shell's signer and account menu
//   - window.bootScreen: the wallpaper and clock format DinOS's boot and
//     unlock screen shows
//   - window.lock: DinOS's lock screen, for the Lock menu item
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
//   - window.promptHost: yes/no questions for the user - site permissions and
//     extension installs (see PromptHost)
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

const { contextBridge, ipcRenderer, sharedTexture, webFrame } = require('electron');

// Boot bridge (window.boot): the renderer reports that the app has mounted
// beneath the black boot veil; main.mts keeps the shell window hidden until
// this arrives so the window never maps onto an unpainted (white/garbage)
// surface on bare X11.
contextBridge.exposeInMainWorld('boot', {
  /** Signal that the shell's first frame is ready to be shown. */
  ready: () => ipcRenderer.send('shell:bootReady'),
});

// Session bridge (window.session): "Log out" quits the shell cleanly. Under
// din-session.sh a clean exit ends the login session and hands control back
// to the display manager (GDM etc.); the saved Nostr accounts are untouched.
contextBridge.exposeInMainWorld('session', {
  /** End the desktop session (quits Din). */
  end: () => ipcRenderer.send('shell:endSession'),
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

  /**
   * Subscribe to commands finishing (the shell got the terminal back), in
   * all sessions. Returns an unsubscribe fn.
   * @param {(id: number, done: { command: string, seconds: number }) => void} callback
   */
  onCommandDone: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {number} id
     * @param {{ command: string, seconds: number }} done
     */
    const listener = (_event, id, done) => callback(id, done);
    ipcRenderer.on('pty:commandDone', listener);
    return () => ipcRenderer.removeListener('pty:commandDone', listener);
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
// main.mts (wlr-randr under cage, xrandr on bare X11). Used by the Settings
// app to arrange the outputs: resolution, position, on/off and which one is
// primary. `available: false` where the outputs can't be managed, so the
// panel can render a fallback.
contextBridge.exposeInMainWorld('display', {
  /** Connected outputs with their available modes/positions. `available: false` = unmanageable. */
  status: () => ipcRenderer.invoke('display:status'),

  /**
   * Apply a complete output arrangement in one atomic call. Each
   * placement is { output, enabled, primary, x, y, width, height }; every
   * field is re-validated in the main process against xrandr's own report.
   * @param {Array<{ output: string, enabled: boolean, primary: boolean, x: number, y: number, width: number, height: number }>} placements
   */
  applyLayout: (placements) => ipcRenderer.invoke('display:applyLayout', placements),
});

// Monitors bridge (window.monitors), backed by the monitors:* handler in
// main.mts: each display's rectangle within the shell window (null when the
// window covers just one), so the desktop can keep its menu bar and Dock on
// the primary monitor and maximize windows to the monitor they're on.
contextBridge.exposeInMainWorld('monitors', {
  /** The displays, in DIPs relative to the window's top-left, or null. */
  get: () => ipcRenderer.invoke('monitors:get'),

  /**
   * Subscribe to display changes. Returns an unsubscribe function.
   * @param {(monitors: unknown) => void} callback
   */
  onChange: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} monitors
     */
    const handler = (_event, monitors) => callback(monitors);
    ipcRenderer.on('monitors:changed', handler);
    return () => ipcRenderer.removeListener('monitors:changed', handler);
  },

  /** CSS pixels per DIP: the shell's page zoom. */
  zoomFactor: () => webFrame.getZoomFactor(),
});

// Native-app bridge (window.nativeApps), backed by the native-apps:* handlers
// in electron/native-apps.mts: lists installed XDG desktop entries and
// launches them onto Din's embedded display, whose windows Din composites
// into its own. `available: false` where that display can't run, so the Dock
// and launcher can simply leave native apps out.
contextBridge.exposeInMainWorld('nativeApps', {
  /** Installed desktop entries, with icons inlined as data URLs. */
  list: () => ipcRenderer.invoke('native-apps:list'),

  /**
   * Start an app by its registry id ("native:org.gnome.Calculator").
   * @param {string} appId
   */
  launch: (appId) => ipcRenderer.invoke('native-apps:launch', appId),

  /**
   * The installed app a window belongs to, by owner pid and WM_CLASS.
   * @param {number | null} pid
   * @param {string[]} wmClass
   */
  resolve: (pid, wmClass) => ipcRenderer.invoke('native-apps:resolve', pid, wmClass),

  /**
   * Open a Windows program (.exe, .msi, .bat, .lnk) by absolute path,
   * through Wine (electron/windows-apps.mts).
   * @param {string} file
   */
  runWindowsProgram: (file) => ipcRenderer.invoke('native-apps:run-windows-program', file),

  /**
   * Force quit the program that owns a window (by its pid), for windows
   * that won't close. Only apps on Din's embedded display qualify.
   * @param {number} pid
   */
  forceQuit: (pid) => ipcRenderer.invoke('native-apps:force-quit', pid),

  /**
   * Subscribe to "the installed apps changed" (a program was installed or
   * removed). Returns an unsubscribe fn.
   * @param {() => void} callback
   */
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('native-apps:changed', handler);
    return () => ipcRenderer.removeListener('native-apps:changed', handler);
  },
});

// Embedded display (src/lib/nativeDisplay.ts): pixels and input travel on a
// MessagePort straight between the shell and the compositor process
// (electron/native-display-worker.mts), never through the main process. A
// MessagePort can't cross contextBridge, so it's handed to the page with
// window.postMessage, the documented pattern for isolated preloads; the page
// asks for one with nativeDisplay.connect(), again after every reload.
ipcRenderer.on('native-display:port', (event) => {
  globalThis.postMessage('din:native-display-port', globalThis.location.origin, event.ports);
});
// Wayland windows rendered on the GPU (electron/native-gpu.mts) arrive as
// shared textures, imported once per buffer by the main process, then as
// "window W is in buffer B" presents. The textures can only be used in this
// isolated world, so drawing happens here: the page attaches each window's
// canvas, and every present is a GPU-side drawImage into it - no pixel ever
// passes through JavaScript.

/** @type {Map<number, Electron.SharedTextureImported>} buffer id -> texture */
const gpuTextures = new Map();
/** @type {Map<number, HTMLCanvasElement>} window id -> canvas */
const gpuCanvases = new Map();
/** @type {Map<number, number>} window id -> the buffer it's showing */
const gpuShowing = new Map();
/** @type {(() => void) | null} the page's ack, once per present batch */
let gpuPresented = null;

/**
 * Draw a window's current buffer into its canvas, if both have arrived.
 * @param {number} id
 */
function gpuDraw(id) {
  const canvas = gpuCanvases.get(id);
  const texture = gpuTextures.get(/** @type {number} */ (gpuShowing.get(id)));
  if (!canvas || !texture) return;
  const frame = texture.getVideoFrame();
  try {
    canvas.getContext('2d')?.drawImage(frame, 0, 0);
  } finally {
    frame.close();
  }
}

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, buffer) => {
  gpuTextures.set(buffer, importedSharedTexture);
  // A present can beat its buffer here; draw whoever was waiting on it.
  for (const [id, showing] of gpuShowing) if (showing === buffer) gpuDraw(id);
});

ipcRenderer.on('native-display:drop', (_event, buffer) => {
  gpuTextures.get(buffer)?.release();
  gpuTextures.delete(buffer);
});

ipcRenderer.on(
  'native-display:present',
  /**
   * @param {Electron.IpcRendererEvent} _event
   * @param {{ id: number, buffer: number }[]} windows
   */
  (_event, windows) => {
    for (const { id, buffer } of windows) {
      gpuShowing.set(id, buffer);
      gpuDraw(id);
    }
    gpuPresented?.();
  },
);

contextBridge.exposeInMainWorld('nativeDisplay', {
  /** Request a port; it arrives as a 'din:native-display-port' message. */
  connect: () => ipcRenderer.send('native-display:connect'),

  /**
   * Show a GPU-rendered window in this canvas (from now on, and its current
   * frame right away).
   * @param {number} id
   * @param {HTMLCanvasElement} canvas
   */
  attachCanvas: (id, canvas) => {
    gpuCanvases.set(id, canvas);
    gpuDraw(id);
  },

  /** @param {number} id */
  detachCanvas: (id) => {
    gpuCanvases.delete(id);
    gpuShowing.delete(id);
  },

  /**
   * Called once per present batch, after drawing: the page acks it to the
   * compositor, which is what paces the apps.
   * @param {() => void} callback
   */
  onPresented: (callback) => {
    gpuPresented = callback;
  },
});

// Keyboard bridge (window.keyboard), backed by the keyboard:* handlers in
// electron/keyboard.mts: the system's keyboard layout, which Settings shows
// and, where Din knows how, changes to one from xkeyboard-config's list.
contextBridge.exposeInMainWorld('keyboard', {
  /** The system's layout ({ layout, variant, name }), whether it can be changed, and whether Din needs a restart for it. */
  status: () => ipcRenderer.invoke('keyboard:status'),

  /** Every layout and variant there is: { layout, variant, name }[]. */
  layouts: () => ipcRenderer.invoke('keyboard:layouts'),

  /**
   * Make a layout the system's.
   * @param {{ layout: string, variant: string }} choice
   */
  set: (choice) => ipcRenderer.invoke('keyboard:set', choice),

  /** Restart Din, so its own windows take a changed layout (DinOS). */
  restart: () => ipcRenderer.invoke('keyboard:restart'),
});

// Tray bridge (window.tray), backed by the tray:* handlers in
// electron/tray.mts: apps' status icons (StatusNotifierItems) for the menu
// bar, their menus, and the clicks that go back to them. Coordinates are
// viewport pixels, which are screen pixels to native apps.
contextBridge.exposeInMainWorld('tray', {
  /** The current items. */
  list: () => ipcRenderer.invoke('tray:list'),

  /**
   * Primary click. Resolves false when the app doesn't take it (then the
   * item's menu is the thing to show).
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  activate: (id, x, y) => ipcRenderer.invoke('tray:activate', id, x, y),

  /**
   * Middle click.
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  secondaryActivate: (id, x, y) => ipcRenderer.invoke('tray:secondaryActivate', id, x, y),

  /**
   * Right click on an item without a menu Din can draw: the app shows its own.
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  contextMenu: (id, x, y) => ipcRenderer.invoke('tray:contextMenu', id, x, y),

  /**
   * @param {string} id
   * @param {number} delta
   * @param {'vertical' | 'horizontal'} orientation
   */
  scroll: (id, delta, orientation) => ipcRenderer.invoke('tray:scroll', id, delta, orientation),

  /**
   * An item's menu, read fresh (null when it has none).
   * @param {string} id
   */
  menu: (id) => ipcRenderer.invoke('tray:menu', id),

  /**
   * A menu entry was picked.
   * @param {string} id
   * @param {number} entryId
   */
  menuEvent: (id, entryId) => ipcRenderer.invoke('tray:menuEvent', id, entryId),

  /**
   * Subscribe to the item list. Returns an unsubscribe fn.
   * @param {(items: unknown[]) => void} callback
   */
  onChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown[]} items
     */
    const handler = (_event, items) => callback(items);
    ipcRenderer.on('tray:changed', handler);
    return () => ipcRenderer.removeListener('tray:changed', handler);
  },

  /**
   * Subscribe to menu changes (the item's id): an open menu re-reads itself.
   * Returns an unsubscribe fn.
   * @param {(id: string) => void} callback
   */
  onMenuChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} id
     */
    const handler = (_event, id) => callback(id);
    ipcRenderer.on('tray:menu-changed', handler);
    return () => ipcRenderer.removeListener('tray:menu-changed', handler);
  },
});

// System notifications bridge (window.systemNotifications), backed by
// electron/notifications.mts: notifications from Linux apps (over D-Bus) and
// web pages, for the notification center, and what the user did with them.
contextBridge.exposeInMainWorld('systemNotifications', {
  /**
   * Subscribe to new (or replaced) notifications. Returns an unsubscribe fn.
   * @param {(notification: unknown) => void} callback
   */
  onShow: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} notification
     */
    const handler = (_event, notification) => callback(notification);
    ipcRenderer.on('notifications:show', handler);
    return () => ipcRenderer.removeListener('notifications:show', handler);
  },

  /**
   * Subscribe to notifications their sender closed (their id). Returns an
   * unsubscribe fn.
   * @param {(id: string) => void} callback
   */
  onClose: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} id
     */
    const handler = (_event, id) => callback(id);
    ipcRenderer.on('notifications:close', handler);
    return () => ipcRenderer.removeListener('notifications:close', handler);
  },

  /**
   * The user clicked a notification ('default') or one of its actions.
   * @param {string} id
   * @param {string} action
   */
  activate: (id, action) => ipcRenderer.send('notifications:activate', id, action),

  /**
   * A notification went away.
   * @param {string} id
   * @param {'expired' | 'dismissed' | 'closed'} reason
   */
  closed: (id, reason) => ipcRenderer.send('notifications:closed', id, reason),
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

// Theme bridge (window.theme), backed by the theme:set handler in main.mts:
// the shell's light/dark mode becomes Chromium's, so `prefers-color-scheme`
// in browser tabs and web apps follows it.
contextBridge.exposeInMainWorld('theme', {
  /**
   * Set the color scheme pages see.
   * @param {'light' | 'dark' | 'system'} source
   */
  set: (source) => ipcRenderer.send('theme:set', source),
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

// Installer bridge (window.installer), backed by electron/installer.mts:
// copies a live USB boot of DinOS onto the computer's own disk.
contextBridge.exposeInMainWorld('installer', {
  /** Whether this is a live boot, the space an install needs, and the disks. */
  status: () => ipcRenderer.invoke('installer:status'),

  /** The install in progress (or finished, or failed). */
  state: () => ipcRenderer.invoke('installer:state'),

  /**
   * Start installing. Progress arrives through onProgress.
   * @param {string} disk
   * @param {'wipe' | 'free' | 'keep'} mode
   * @param {string | null} passphrase Encrypts the disk under it (for
   *   `keep`, unlocks it), or null.
   */
  install: (disk, mode, passphrase) =>
    ipcRenderer.invoke('installer:install', disk, mode, passphrase),

  /** Run the failed install again, with the same choices. */
  retry: () => ipcRenderer.invoke('installer:retry'),

  /** Restart the computer, into the installed system. */
  reboot: () => ipcRenderer.invoke('installer:reboot'),

  /**
   * Subscribe to install progress. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onProgress: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('installer:progress', handler);
    return () => ipcRenderer.removeListener('installer:progress', handler);
  },
});

// Bluetooth login bridge (window.bluetoothLogin), backed by
// electron/bluetooth-login.mts: advertises a GATT service a phone (Tenna)
// sends the account key to, encrypted to the renderer's ephemeral key.
contextBridge.exposeInMainWorld('bluetoothLogin', {
  /** Whether this computer has a Bluetooth adapter that can do it. */
  available: () => ipcRenderer.invoke('bluetooth-login:available'),

  /**
   * Start advertising. Progress arrives through onEvent.
   * @param {string} din The renderer's ephemeral x-only pubkey, hex.
   */
  start: (din) => ipcRenderer.invoke('bluetooth-login:start', din),

  /** Stop advertising. */
  stop: () => ipcRenderer.invoke('bluetooth-login:stop'),

  /**
   * Subscribe to login progress. Returns an unsubscribe fn.
   * @param {(event: unknown) => void} callback
   */
  onEvent: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} payload
     */
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('bluetooth-login:event', handler);
    return () => ipcRenderer.removeListener('bluetooth-login:event', handler);
  },
});

// Signer bridge (window.nostrd), backed by electron/nostrd.mts: nostrd, the
// signer daemon that holds the account keys, signs for the shell and manages
// its accounts.
contextBridge.exposeInMainWorld('nostrd', {
  /** Whether to keep accounts in nostrd ({ use, connected, managed }). */
  info: () => ipcRenderer.invoke('nostrd:info'),

  /**
   * Call a nostrd method. Resolves to { result } or { error: { code, message } }.
   * @param {string} method
   * @param {unknown[]} params
   */
  call: (method, params) => ipcRenderer.invoke('nostrd:call', method, params),

  /**
   * Subscribe to nostrd's events ({ event }). Returns an unsubscribe fn.
   * @param {(event: unknown) => void} callback
   */
  onEvent: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} payload
     */
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('nostrd:event', handler);
    return () => ipcRenderer.removeListener('nostrd:event', handler);
  },
});

// Boot screen bridge (window.bootScreen), backed by electron/boot-screen.mts:
// copies the wallpaper to the boot partition, for DinOS's unlock screen.
contextBridge.exposeInMainWorld('bootScreen', {
  /**
   * Show this wallpaper on the boot screen, with a 12- or 24-hour clock.
   * @param {string | null} wallpaper A URL, or null for none.
   * @param {boolean} hour12
   */
  update: (wallpaper, hour12) => ipcRenderer.invoke('boot-screen:update', wallpaper, hour12),
});

// Lock bridge (window.lock), backed by electron/lock.mts: DinOS's lock
// screen, which runs outside Din.
contextBridge.exposeInMainWorld('lock', {
  /** Whether this computer can be locked (it has a password). */
  available: () => ipcRenderer.invoke('lock:available'),

  /** Lock now. */
  lock: () => ipcRenderer.invoke('lock:lock'),

  /**
   * Change the computer's password: the disk's, the lock screen's, and the
   * Nostr keys'.
   * @param {string} oldPassword
   * @param {string} newPassword
   */
  changePassword: (oldPassword, newPassword) =>
    ipcRenderer.invoke('lock:change-password', oldPassword, newPassword),
});

// Updater bridge (window.updater), backed by electron/updater.mts: stages
// newer DinOS releases for the next boot.
contextBridge.exposeInMainWorld('updater', {
  /** Versions, and the check or update in progress (or the failed one). */
  state: () => ipcRenderer.invoke('updater:state'),

  /** Look for a newer release now, and stage it. Progress arrives through onProgress. */
  check: () => ipcRenderer.invoke('updater:check'),

  /** Restart the computer, into the staged release. */
  reboot: () => ipcRenderer.invoke('updater:reboot'),

  /**
   * Subscribe to update progress. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onProgress: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('updater:progress', handler);
    return () => ipcRenderer.removeListener('updater:progress', handler);
  },
});

// System change events (window.systemEvents): the main process watches
// NetworkManager and PipeWire for changes (`nmcli monitor`, `pactl
// subscribe`) and says which area changed, so the menu bar and Settings
// refresh on events instead of polling every few seconds.
contextBridge.exposeInMainWorld('systemEvents', {
  /**
   * Subscribe to change notices ('network' | 'audio'). Returns an
   * unsubscribe fn.
   * @param {(topic: string) => void} callback
   */
  onChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} topic
     */
    const handler = (_event, topic) => callback(topic);
    ipcRenderer.on('system:changed', handler);
    return () => ipcRenderer.removeListener('system:changed', handler);
  },
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
   * Set the default sink volume (0-150; past 100 amplifies). Resolves to the new state.
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
   * Set any node's volume (0-150) by id (per-app streams, per-device).
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

// Pointer input inside <webview> guests, forwarded from the main process
// (forwardGuestInput in main.mts) because it never reaches the shell's
// document. See src/lib/guestInput.ts for the typed renderer-side accessor.
contextBridge.exposeInMainWorld('guestInput', {
  /**
   * Subscribe to forwarded guest input. Returns an unsubscribe fn. Payloads:
   *   { wcId, type: 'move', x, y }
   *   { wcId, type: 'down', x, y, button }
   * @param {(data: { wcId: number, type: string, x: number, y: number, button?: string }) => void} callback
   */
  onInput: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, type: string, x: number, y: number, button?: string }} data
     */
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('guest:input', handler);
    return () => ipcRenderer.removeListener('guest:input', handler);
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

/**
 * A question the main process needs the user to answer.
 * @typedef {(
 *   { requestId: number, kind: 'permission', origin: string, capabilities: string[] } |
 *   { requestId: number, kind: 'extension-install', name: string, permissions: string[], hostPermissions: string[] }
 * )} ShellPromptRequest
 */

// Prompt host (window.promptHost), backed by the prompt:* handlers in main.mts.
// A site asking for the camera/microphone/location/notifications, or the Chrome
// Web Store asking to install an extension, is surfaced here so PromptHost can
// ask the user. Unanswered prompts time out in main (and arrive here as a
// cancel) as "no".
contextBridge.exposeInMainWorld('promptHost', {
  /**
   * Subscribe to prompts. Returns an unsubscribe fn.
   * @param {(request: ShellPromptRequest) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {ShellPromptRequest} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('prompt:request', listener);
    return () => ipcRenderer.removeListener('prompt:request', listener);
  },

  /**
   * Subscribe to prompts main has given up on (timed out). Returns an
   * unsubscribe fn.
   * @param {(requestId: number) => void} callback
   */
  onCancel: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number }} d
     */
    const listener = (_event, d) => callback(d.requestId);
    ipcRenderer.on('prompt:cancel', listener);
    return () => ipcRenderer.removeListener('prompt:cancel', listener);
  },

  /**
   * Answer a prompt.
   * @param {{ requestId: number, allow: boolean }} response
   */
  respond: (response) => ipcRenderer.send('prompt:response', response),
});
