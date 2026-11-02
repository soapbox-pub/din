// @ts-check
// Preload for the Din renderer.
//
// Exposes bridges backed by IPC handlers in main.mts:
//   - window.dinos.boot: first-frame readiness for the hidden-until-ready shell window
//   - window.dinos.session: end the desktop session (log out to the display manager)
//   - window.dinos.fs: filesystem access for the Files app
//   - window.dinos.pty: interactive shell sessions for the Terminal app
//   - window.dinos.wifi: NetworkManager (nmcli) control for the Settings app
//   - window.dinos.vpn: VPN/WireGuard profile toggles for the network selector
//   - window.dinos.tor: Tor's status and on/off switch for Settings, and the
//     onion services pages name, for the Web Browser
//   - window.dinos.display: multi-output arrangement (wlr-randr/xrandr) for the
//     Settings app
//   - window.dinos.pageFullscreen: fits a fullscreen web page to its monitor
//   - window.dinos.monitors: where each display sits in the shell window, for the
//     desktop's layout
//   - window.dinos.zoom: Chromium page zoom (interface scale) for the Settings app
//   - window.dinos.theme: the light/dark mode pages see through prefers-color-scheme
//   - window.dinos.keyboard: the system's keyboard layout, for Settings
//   - window.dinos.datetime: the system's time zone and clock, for Settings
//   - window.dinos.cursor: the pointer's theme and size, for Settings
//   - window.dinos.mouse: Settings → Mouse, for din-shell
//   - window.dinos.accessibility: Settings → Accessibility, passed on to Linux apps
//   - window.dinos.iconTheme: the icon theme, for Settings and Din's icons
//   - window.dinos.tray: apps' status icons and their menus, for the menu bar
//   - window.dinos.systemNotifications: Linux apps' and web pages' notifications,
//     for the notification center
//   - window.dinos.installer: put DinOS on this computer's disk, for the
//     Installer app (live USB boots only)
//   - window.dinos.updater: DinOS system updates, for the Settings app
//   - window.dinos.firmware: firmware updates through fwupd, for the Settings app
//   - window.dinos.airplay: sharing the screen with AirPlay receivers, for the menu
//     bar and Settings
//   - window.dinos.assistant: OpenCode, the coding agent, through its background
//     server, for the Assistant app, its menu-bar item and Settings
//   - window.dinos.dictation: speech to text with whisper.cpp, for Super+H, the
//     assistant's mic button and holding Super+A
//   - window.dinos.bluetooth: BlueZ adapter and devices (pairing, connecting), for
//     the menu bar and Settings
//   - window.dinos.phone: text messages from the user's phones over Bluetooth,
//     for Settings and notifications
//   - window.dinos.mail: the mail accounts' mailing lists, for `din mail`
//   - window.dinos.printing: printers, the print dialog's previews and jobs, and
//     the print queue, for the print dialog and Settings
//   - window.dinos.indd: InDesign documents read into IDML, for Publisher
//   - window.dinos.volumes: USB sticks and SD cards, mounted as they're plugged in
//     and ejected from the Files sidebar
//   - window.dinos.systemMonitor: running processes, CPU, memory and disks, and
//     ending them, for the System Monitor app
//   - window.dinos.bluetoothLogin: receive the account key from a phone over
//     Bluetooth LE, for the login screen
//   - window.dinos.nostrd: the signer daemon that holds the account keys, for the
//     shell's signer and account menu
//   - window.dinos.bootScreen: the wallpaper and clock format DinOS's boot and
//     unlock screen shows
//   - window.dinos.lock: DinOS's lock screen, for the Lock menu item
//   - window.dinos.power: battery/AC status + system power profiles for the menu
//     bar and Settings app, and restart/shut down for the account menu
//   - window.dinos.audio: wpctl volume/mute for the menu bar, Settings, and OSD
//   - window.dinos.brightness: backlight + night light for the menu bar, Settings, OSD
//   - window.dinos.screenshot: capture the desktop as a PNG for the Screenshot app
//   - window.dinos.browser: TLS certificate exceptions, browsing-data clearing,
//     find-in-page, and download progress for the Web Browser app
//   - window.dinos.crx: Chrome extension coordination for the Web Browser app
//   - window.dinos.userscripts: userscript library sync and install
//     requests for the Web Browser app
//   - window.dinos.adblock: the Web Browser's built-in ad blocker
//   - window.dinos.popups: the pop-up blocker's blocked windows and allowed sites
//   - window.dinos.devtools: docked devtools control for the Web Browser app
//   - window.dinos.nostrHost: relays NIP-07 requests from browser tabs and installed
//     web apps to the signed-in account's signer (see NostrBridgeHost /
//     nostr-preload.cjs)
//   - window.dinos.bunkerHost: Din's NIP-46 remote-signer connections (see
//     electron/bunker.mts)
//   - window.dinos.highlightHost: relays NIP-84 highlight clicks from browser tabs to
//     the signer (see HighlightBridgeHost / browser-highlight-preload.cjs)
//   - window.dinos.filePickerHost: relays <input type=file> clicks from guests, and
//     native apps' file dialogs, to the in-Din file picker (see
//     FilePickerBridgeHost)
//   - window.dinos.nsiteHost: relays nsite:// manifest lookups to the renderer's
//     Nostr client (see NsiteBridgeHost / electron/nsite.mts)
//   - window.dinos.nsiteStore: the OS-level store of nsites, and which are
//     installed as apps (see src/lib/nsiteStore.ts / electron/nsite-store.mts)
//   - window.dinos.nappHost: installed nsites' napp runtime - their ENV, clearing
//     their data, opening their windows (see src/lib/napp.ts / electron/napp.mts)
//   - window.dinos.webPushHost: websites' Web Push - the push service, and their
//     workers opening windows (see src/lib/webPush.ts / electron/web-push.mts)
//   - window.dinos.periodicSync: what apps, nsites and web apps have scheduled
//     to do while closed (see src/lib/periodicSync.ts / electron/periodic-sync.mts)
//   - window.dinos.promptHost: yes/no questions for the user - site permissions and
//     extension installs (see PromptHost)
//   - window.dinos.screenShare: pages asking to share the screen, and the shares
//     running (see ScreenShareHost.tsx / electron/screen-share.mts)
//   - window.dinos.screenRecorder: recording the screen to a video (see
//     src/lib/screenRecorder.ts / electron/screen-recorder.mts)
//   - window.dinos.capture: Studio's takes and live streams (see
//     src/lib/capture.ts / electron/capture.mts)
//   - window.dinos.media: what web pages and native apps are playing, and their
//     play/pause/next/previous (see src/lib/nowPlaying.ts / electron/media.mts)
//
// The fs API is Node-flavored (homedir/readdir/readFile/writeFile/...)
// but is deliberately NOT Node's fs module:
//   - promise-only, no sync or callback variants
//   - readdir returns rich entries (kind/size/mtime) in one batched call
//   - readFile is size-capped: 16 MB unless the caller asks for more, 1 GB at most
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

// Every bridge below is a namespace of one global, window.dinos, exposed at
// the end of this file (docs/dinos/README.md).
/** @type {Record<string, unknown>} */
const dinos = { version: 1 };

/**
 * Add a namespace to window.dinos.
 * @param {string} name
 * @param {object} api
 */
function expose(name, api) {
  dinos[name] = api;
}

// Boot bridge (window.dinos.boot): the renderer reports that the app has mounted
// beneath the black boot veil; main.mts keeps the shell window hidden until
// this arrives so the window never maps onto an unpainted (white/garbage)
// surface.
expose('boot', {
  /**
   * Signal that the shell's first frame is ready to be shown. Resolves once
   * the window is on screen.
   * @returns {Promise<void>}
   */
  ready: () => ipcRenderer.invoke('shell:bootReady'),
  /**
   * Whether ~/.config/din/skip-restore was there (it's removed): this start
   * leaves the saved windows closed.
   * @returns {Promise<boolean>}
   */
  skipRestore: () => ipcRenderer.invoke('shell:skipRestore'),
});

// Session bridge (window.dinos.session): "Log out" quits the shell cleanly. As
// a login session a clean exit ends it and hands control back to the display
// manager (GDM etc.); the saved Nostr accounts are untouched. The rest puts
// Din on another Linux's login screen (electron/login-session.mts).
expose('session', {
  /** End the desktop session (quits Din). */
  end: () => ipcRenderer.send('shell:endSession'),

  /** Whether Din is running as another Linux's login session, which "Log out" ends. */
  isLoginSession: () => ipcRenderer.invoke('session:isLoginSession'),

  /** Whether Din is on the login screen, its builds, and the session you log in to. */
  status: () => ipcRenderer.invoke('session:status'),

  /**
   * Install, update, roll back, make default, restore or uninstall. What it
   * prints arrives through onOutput.
   * @param {'install' | 'update' | 'rollback' | 'default' | 'restore' | 'uninstall'} action
   * @param {boolean} [makeDefault] With install: make Din the session you log in to.
   */
  run: (action, makeDefault) => ipcRenderer.invoke('session:run', action, makeDefault),

  /**
   * Subscribe to what the running action prints, line by line. Returns an unsubscribe fn.
   * @param {(line: string) => void} callback
   */
  onOutput: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} line
     */
    const handler = (_event, line) => callback(line);
    ipcRenderer.on('session:output', handler);
    return () => ipcRenderer.removeListener('session:output', handler);
  },
});

expose('fs', {
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

  // The Files app's richer operations (electron/files.mts).

  /**
   * Copy a file or folder into `dir` (as `name`, default its own), renaming
   * to "name (2)" if taken. Resolves to the new path.
   * @param {string} from
   * @param {string} dir
   * @param {string} [name]
   */
  copyInto: (from, dir, name) => ipcRenderer.invoke('fs:copyInto', from, dir, name),

  /**
   * Move a file or folder into `dir`, renaming to "name (2)" if taken.
   * Resolves to the new path.
   * @param {string} from
   * @param {string} dir
   */
  moveInto: (from, dir) => ipcRenderer.invoke('fs:moveInto', from, dir),

  /**
   * Move to an exact path, failing if something is already there.
   * @param {string} from
   * @param {string} to
   */
  move: (from, to) => ipcRenderer.invoke('fs:move', from, to),

  /**
   * Move to the Trash; resolves to the item's name in the Trash.
   * @param {string} path
   */
  trash: (path) => ipcRenderer.invoke('fs:trash', path),

  /**
   * Put a trashed item back; resolves to where it went.
   * @param {string} name
   */
  restore: (name) => ipcRenderer.invoke('fs:restore', name),

  /**
   * Delete one trashed item for good, or (no name) empty the Trash.
   * @param {string} [name]
   */
  purge: (name) => ipcRenderer.invoke('fs:purge', name),

  /** The Trash's files folder (created if missing). */
  trashDir: () => ipcRenderer.invoke('fs:trashDir'),

  /**
   * Everything the Properties dialog shows about a path.
   * @param {string} path
   */
  details: (path) => ipcRenderer.invoke('fs:details', path),

  /**
   * Total size and item counts beneath a folder.
   * @param {string} path
   */
  du: (path) => ipcRenderer.invoke('fs:du', path),

  /**
   * @param {string} path
   * @param {number} mode
   */
  chmod: (path, mode) => ipcRenderer.invoke('fs:chmod', path, mode),

  /**
   * Extract an archive into `dir`; resolves to what was created and what
   * came out damaged. `job` names it for `cancelExtract`.
   * @param {string} archive
   * @param {string} dir
   * @param {string} [job]
   */
  extract: (archive, dir, job) => ipcRenderer.invoke('fs:extract', archive, dir, job),

  /**
   * Stop an extraction started with this `job`; nothing of it is kept.
   * @param {string} job
   */
  cancelExtract: (job) => ipcRenderer.invoke('fs:cancelExtract', job),

  /**
   * Pack entries of `dir` into `dir/outName` (format by extension).
   * @param {string} dir
   * @param {string[]} names
   * @param {string} outName
   */
  compress: (dir, names, outName) => ipcRenderer.invoke('fs:compress', dir, names, outName),

  /**
   * An archive's member names.
   * @param {string} archive
   */
  listArchive: (archive) => ipcRenderer.invoke('fs:listArchive', archive),

  /**
   * Recently made, changed, or opened files, latest first, for the file
   * picker. `extra` adds [path, ms] pairs the shell remembers itself.
   * @param {[string, number][]} extra
   */
  recent: (extra) => ipcRenderer.invoke('fs:recent', extra),

  /**
   * Files and folders beneath `root` whose names contain `query`. A new
   * search from the same window stops the last.
   * @param {string} root
   * @param {string} query
   * @param {{ hidden?: boolean }} [options]
   */
  find: (root, query, options) => ipcRenderer.invoke('fs:find', root, query, options),

  /**
   * Every file beneath a folder, as paths relative to it: a git checkout's
   * tracked and unignored files, else a walk that skips dependency folders.
   * @param {string} root
   */
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),

  /**
   * Search every file beneath a folder. A new search stops the last one.
   * @param {string} root
   * @param {{ query: string, regex: boolean, caseSensitive: boolean, wholeWord: boolean, include: string, exclude: string }} options
   */
  search: (root, options) => ipcRenderer.invoke('fs:search', root, options),

  /**
   * Watch a folder for changes; resolves to a watch id (null if it can't be
   * watched). Changes arrive through onChange.
   * @param {string} path
   */
  watch: (path) => ipcRenderer.invoke('fs:watch', path),

  /** @param {number} id */
  unwatch: (id) => ipcRenderer.invoke('fs:unwatch', id),

  /**
   * Subscribe to changes in watched folders. Returns an unsubscribe fn.
   * @param {(path: string) => void} callback
   */
  onChange: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} path
     */
    const listener = (_event, path) => callback(path);
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },
});

// Terminal bridge (window.dinos.pty), backed by the pty:* handlers in main.mts.
// Each session is a real login shell on a pseudo-terminal; data flows as
// raw bytes (Uint8Array out, string in - what xterm.js produces/consumes).
expose('pty', {
  /**
   * Start a shell session; resolves to its session id.
   * @param {{ rows: number, cols: number }} size
   * @param {string} [cwd]
   * @param {string} [appId] a Terminal=true native app to run instead of a shell
   */
  spawn: (size, cwd, appId) => ipcRenderer.invoke('pty:spawn', size, cwd, appId),

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
   * Subscribe to commands starting (one took the terminal from the shell),
   * in all sessions. Returns an unsubscribe fn.
   * @param {(id: number, command: string) => void} callback
   */
  onCommandStart: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {number} id
     * @param {string} command
     */
    const listener = (_event, id, command) => callback(id, command);
    ipcRenderer.on('pty:commandStart', listener);
    return () => ipcRenderer.removeListener('pty:commandStart', listener);
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

// WiFi bridge (window.dinos.wifi), backed by the wifi:* handlers in main.mts
// (nmcli / NetworkManager). Used by the Settings app.
expose('wifi', {
  /** Adapter/radio state. `available: false` when NetworkManager is absent. */
  status: () => ipcRenderer.invoke('wifi:status'),

  /**
   * Visible networks, one entry per SSID. `rescan` forces a fresh scan.
   * @param {boolean} [rescan]
   */
  networks: (rescan) => ipcRenderer.invoke('wifi:networks', rescan),

  /** Saved (remembered) WiFi networks. */
  saved: () => ipcRenderer.invoke('wifi:saved'),

  /**
   * A saved network's settings, and its live link details while it's up.
   * @param {string} uuid
   */
  details: (uuid) => ipcRenderer.invoke('wifi:details', uuid),

  /**
   * The password a saved network joins with, for sharing it; null if none.
   * @param {string} uuid
   */
  secret: (uuid) => ipcRenderer.invoke('wifi:secret', uuid),

  /**
   * Change a saved network's settings.
   * @param {string} uuid
   * @param {unknown} changes
   */
  update: (uuid, changes) => ipcRenderer.invoke('wifi:update', uuid, changes),

  /**
   * Save a network entered by hand, then try to join it.
   * @param {unknown} network
   */
  add: (network) => ipcRenderer.invoke('wifi:add', network),

  /**
   * Join a network, creating or updating its saved profile.
   * @param {string} ssid
   * @param {string} [password]
   */
  connect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),

  /**
   * Join a saved network.
   * @param {string} uuid
   */
  activate: (uuid) => ipcRenderer.invoke('wifi:activate', uuid),

  /** Disconnect the WiFi adapter from its current network. */
  disconnect: () => ipcRenderer.invoke('wifi:disconnect'),

  /**
   * Delete a saved network.
   * @param {string} uuid
   */
  forget: (uuid) => ipcRenderer.invoke('wifi:forget', uuid),

  /**
   * Turn the WiFi radio on or off.
   * @param {boolean} enabled
   */
  setRadio: (enabled) => ipcRenderer.invoke('wifi:setRadio', enabled),
});

// VPN bridge (window.dinos.vpn), backed by the vpn:* handlers in main.mts (nmcli /
// NetworkManager). Toggles existing VPN/WireGuard profiles from the network
// selector; profiles are created out of band (imported config / Terminal).
expose('vpn', {
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

/**
 * @typedef {{ canToggle: boolean, enabled: boolean | null, port: number | null,
 *   progress: number | null, summary: string | null }} TorStatus
 */

// Tor bridge (window.dinos.tor), backed by the tor:* handlers in electron/tor.mts:
// whether there's a Tor and how far it has got connecting, turning it on and
// off on DinOS.
expose('tor', {
  /** @returns {Promise<TorStatus>} */
  status: () => ipcRenderer.invoke('tor:status'),

  /** Look for Tor again now. @returns {Promise<TorStatus>} */
  refresh: () => ipcRenderer.invoke('tor:refresh'),

  /**
   * Turn Tor on or off (DinOS only).
   * @param {boolean} enabled
   * @returns {Promise<TorStatus>}
   */
  setEnabled: (enabled) => ipcRenderer.invoke('tor:set-enabled', enabled),

  /**
   * Subscribe to status changes. Returns an unsubscribe fn.
   * @param {(status: TorStatus) => void} callback
   */
  onStatus: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {TorStatus} status
     */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('tor:status', listener);
    return () => ipcRenderer.removeListener('tor:status', listener);
  },

  /**
   * Subscribe to browser tabs going to or from an onion site, which the
   * main process stopped so the tab can load it in the other session.
   * Returns an unsubscribe fn.
   * @param {(move: { wcId: number, url: string }) => void} callback
   */
  onMoveTab: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, url: string }} move
     */
    const listener = (_event, move) => callback(move);
    ipcRenderer.on('tor:move-tab', listener);
    return () => ipcRenderer.removeListener('tor:move-tab', listener);
  },

  /** Onion hosts with TLS of their own. @returns {Promise<string[]>} */
  tlsHosts: () => ipcRenderer.invoke('tor:tls-hosts'),

  /**
   * Subscribe to the onion hosts with TLS of their own, as one is found.
   * Returns an unsubscribe fn.
   * @param {(hosts: string[]) => void} callback
   */
  onTlsHosts: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string[]} hosts
     */
    const listener = (_event, hosts) => callback(hosts);
    ipcRenderer.on('tor:tls-hosts', listener);
    return () => ipcRenderer.removeListener('tor:tls-hosts', listener);
  },
});

// Site locations bridge (window.dinos.siteLocations), backed by
// electron/site-locations.mts: the onion service (Onion-Location) and nsite
// (Nsite-Location) browser tabs' pages name.
expose('siteLocations', {
  /**
   * What a browser tab's page names.
   * @param {number} wcId
   * @returns {Promise<{ onion: string | null, nsite: string | null }>}
   */
  get: (wcId) => ipcRenderer.invoke('site-locations:get', wcId),

  /**
   * Subscribe to what tabs' pages name. Returns an unsubscribe fn.
   * @param {(update: { wcId: number, onion: string | null, nsite: string | null }) => void} callback
   */
  onChange: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, onion: string | null, nsite: string | null }} update
     */
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('site-locations:changed', listener);
    return () => ipcRenderer.removeListener('site-locations:changed', listener);
  },
});

// Display bridge (window.dinos.display), backed by the display:* handlers in
// main.mts (wlr-randr under din-shell, xrandr on bare X11). Used by the Settings
// app to arrange the outputs: resolution, position, on/off and which one is
// primary. `available: false` where the outputs can't be managed, so the
// panel can render a fallback.
expose('display', {
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

// Page fullscreen bridge (window.dinos.pageFullscreen), backed by the
// pageFullscreen:* handler in main.mts: lays a fullscreen <webview> page out
// at its monitor's size, until it leaves fullscreen.
expose('pageFullscreen', {
  /**
   * @param {number} webContentsId the <webview>'s guest
   * @param {number} width device-independent pixels
   * @param {number} height device-independent pixels
   */
  fit: (webContentsId, width, height) =>
    ipcRenderer.invoke('pageFullscreen:fit', webContentsId, width, height),
});

// Guest visibility bridge (window.dinos.guestVisibility), backed by the
// guestVisibility:* handler in main.mts: tells a <webview> page it's hidden
// (a background tab, a minimized window) or visible again.
expose('guestVisibility', {
  /**
   * @param {number} webContentsId the <webview>'s guest
   * @param {boolean} hidden
   */
  set: (webContentsId, hidden) => ipcRenderer.send('guestVisibility:set', webContentsId, hidden),
});

// Guest file drop bridge (window.dinos.guestFileDrop), backed by the
// guestFileDrop:* handler in main.mts: replays a drag of files from Files
// into a <webview> page, so the page can take them as files.
expose('guestFileDrop', {
  /**
   * @param {number} webContentsId the <webview>'s guest
   * @param {'over' | 'drop' | 'cancel'} type
   * @param {number} x in the page's CSS pixels
   * @param {number} y in the page's CSS pixels
   * @param {string[]} paths the files being dragged
   */
  send: (webContentsId, type, x, y, paths) =>
    ipcRenderer.send('guestFileDrop:send', webContentsId, type, x, y, paths),
});

// Monitors bridge (window.dinos.monitors), backed by the monitors:* handler in
// main.mts: each display's rectangle within the shell window (null when the
// window covers just one), so the desktop can keep its menu bar and Dock on
// the primary monitor and maximize windows to the monitor they're on.
expose('monitors', {
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

// Native-app bridge (window.dinos.nativeApps), backed by the native-apps:* handlers
// in electron/native-apps.mts: lists installed XDG desktop entries and
// launches them onto Din's embedded display, whose windows Din composites
// into its own. `available: false` where that display can't run, so the Dock
// and launcher can simply leave native apps out.
expose('nativeApps', {
  /** Installed desktop entries, with icons inlined as data URLs. */
  list: () => ipcRenderer.invoke('native-apps:list'),

  /**
   * Start an app by its registry id ("native:org.gnome.Calculator"),
   * optionally with a link for it to open (one of its `schemes`).
   * @param {string} appId
   * @param {string} [uri]
   */
  launch: (appId, uri) => ipcRenderer.invoke('native-apps:launch', appId, uri),

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

  /**
   * Subscribe to links native apps open (electron/open-uri.mts). Returns an
   * unsubscribe fn.
   * @param {(url: string) => void} callback
   */
  onOpenUrl: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {string} url
     */
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('open-uri:open', handler);
    return () => ipcRenderer.removeListener('open-uri:open', handler);
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
    const context = canvas.getContext('2d');
    // An opaque canvas may be showing an app's own buffer whose fourth byte
    // is padding, which mustn't be blended with as if it were alpha.
    if (context && context.getContextAttributes().alpha === false) context.globalCompositeOperation = 'copy';
    context?.drawImage(frame, 0, 0);
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
    gpuPresent(windows);
    gpuPresented?.();
  },
);

/**
 * Show each window's new buffer.
 * @param {unknown} windows
 */
function gpuPresent(windows) {
  if (!Array.isArray(windows)) return;
  for (const { id, buffer } of windows) {
    if (typeof id !== 'number' || typeof buffer !== 'number') continue;
    gpuShowing.set(id, buffer);
    gpuDraw(id);
  }
}

expose('nativeDisplay', {
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
   * A present that came to the page on the compositor's frame stream,
   * straight rather than relayed by the main process: draw it now.
   * @param {unknown} windows
   */
  present: (windows) => gpuPresent(windows),

  /**
   * Called once per present batch relayed by the main process, after drawing: the page acks it to the
   * compositor, which is what paces the apps.
   * @param {() => void} callback
   */
  onPresented: (callback) => {
    gpuPresented = callback;
  },
});

// Keyboard bridge (window.dinos.keyboard), backed by the keyboard:* handlers in
// electron/keyboard.mts: the system's keyboard layout, which Settings shows
// and, where Din knows how, changes to one from xkeyboard-config's list.
expose('keyboard', {
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

// Date & time bridge (window.dinos.datetime), backed by the datetime:* handlers in
// electron/datetime.mts: the system's time zone and clock, which Settings
// shows and, on DinOS, changes.
expose('datetime', {
  /** { timeZone, automatic, synchronized, canChange, canAutomatic }. */
  status: () => ipcRenderer.invoke('datetime:status'),

  /** Every time zone there is, as IANA names. */
  zones: () => ipcRenderer.invoke('datetime:zones'),

  /**
   * Make a time zone the system's.
   * @param {string} zone
   */
  setZone: (zone) => ipcRenderer.invoke('datetime:set-zone', zone),

  /**
   * Set the clock from the network, or don't.
   * @param {boolean} automatic
   */
  setAutomatic: (automatic) => ipcRenderer.invoke('datetime:set-automatic', automatic),

  /**
   * Set the clock, as local time "YYYY-MM-DD HH:MM:SS".
   * @param {string} time
   */
  setTime: (time) => ipcRenderer.invoke('datetime:set-time', time),
});

// Accessibility bridge (window.dinos.accessibility), backed by
// electron/accessibility.mts: Reduce motion, Reduce transparency and
// Increase contrast, for web pages and apps (as CSS media features) and the
// Linux apps Din runs (GSettings, on DinOS); and the screen's zoom, colour
// filter and keyboard aids, for din-shell to apply.
expose('accessibility', {
  /**
   * @param {{ reduceMotion: boolean, reduceTransparency: boolean, highContrast: boolean }} preferences
   */
  set: (preferences) => ipcRenderer.invoke('accessibility:set', preferences),

  /** { screen }: whether din-shell is there to zoom, filter and help with the keyboard. */
  status: () => ipcRenderer.invoke('accessibility:status'),

  /**
   * @param {{ zoomKeys: boolean, colorFilter: string, stickyKeys: boolean, slowKeys: boolean, bounceKeys: boolean }} settings
   */
  setScreen: (settings) => ipcRenderer.invoke('accessibility:screen', settings),
});

// Mouse bridge (window.dinos.mouse), backed by electron/mouse.mts: Settings →
// Mouse, for din-shell to apply.
expose('mouse', {
  /** { available }: whether the settings do anything here (under din-shell). */
  status: () => ipcRenderer.invoke('mouse:status'),
  /**
   * @param {{ scrollDirection: string, trackingSpeed: number, scrollSpeed: number, secondaryClick: string, middleClick: boolean, swipe: string }} settings
   */
  set: (settings) => ipcRenderer.invoke('mouse:set', settings),
});

// Cursor bridge (window.dinos.cursor), backed by the cursor:* handlers in
// electron/cursor.mts: the pointer's XCursor theme and size, which Settings
// shows and, on DinOS, changes, the themes the user imports, and the effect
// packages that come in CursorFX files.
expose('cursor', {
  /** { theme, size, sizes, canChange }. */
  status: () => ipcRenderer.invoke('cursor:status'),

  /** The installed cursor themes: { id, name }[]. */
  themes: () => ipcRenderer.invoke('cursor:themes'),

  /**
   * A few of a theme's cursors as RGBA: { role, width, height, hotX, hotY, rgba }[].
   * @param {string} id
   * @param {number} size
   */
  preview: (id, size) => ipcRenderer.invoke('cursor:preview', id, size),

  /**
   * Make a theme and size the pointer's.
   * @param {{ theme: string, size: number }} choice
   */
  set: (choice) => ipcRenderer.invoke('cursor:set', choice),

  /**
   * Whether shaking the mouse makes the pointer big; din-shell's to do, so
   * only where status().shellPointer.
   * @param {boolean} on
   */
  setShakeToFind: (on) => ipcRenderer.invoke('cursor:shake-to-find', on),

  /**
   * Import the cursor themes and effect packages in a file or folder and
   * make the first theme the pointer's; resolves with { themes, effects },
   * their ids.
   * @param {string} source absolute path
   */
  importTheme: (source) => ipcRenderer.invoke('cursor:import', source),

  /**
   * Delete a theme Din imported.
   * @param {string} id
   */
  removeTheme: (id) => ipcRenderer.invoke('cursor:remove', id),

  /**
   * A theme's cursors for publishing: { id, name, inherits, files: { name, data }[], links: [alias, target][] }.
   * @param {string} id
   */
  exportTheme: (id) => ipcRenderer.invoke('cursor:export', id),

  /** The themes installed from Nostr: { id, source: { coordinate, publishedAt } }[]. */
  published: () => ipcRenderer.invoke('cursor:published'),

  /**
   * Download and install a published theme; resolves with its id.
   * @param {object} manifest
   */
  installPublished: (manifest) => ipcRenderer.invoke('cursor:install-published', manifest),

  /** The imported effect packages, without their pixels. */
  effects: () => ipcRenderer.invoke('cursor:effects'),

  /**
   * One effect package with its pixels, or null.
   * @param {string} id
   */
  effect: (id) => ipcRenderer.invoke('cursor:effect', id),

  /**
   * Delete an effect package.
   * @param {string} id
   */
  removeEffect: (id) => ipcRenderer.invoke('cursor:remove-effect', id),
});

// Icon theme bridge (window.dinos.iconTheme), backed by the icon-theme:*
// handlers in electron/icon-theme.mts: the session's freedesktop icon theme,
// which Settings shows and, on DinOS, changes, and the icons Din's own apps
// and file types take from it.
expose('iconTheme', {
  /** { theme, din, canChange }. */
  status: () => ipcRenderer.invoke('icon-theme:status'),

  /** The installed icon themes: { id, name, preview }[]. */
  themes: () => ipcRenderer.invoke('icon-theme:themes'),

  /**
   * The theme's icons as data URLs, keyed by each request's first name, and
   * which are glyphs to tint: { icons, glyphs }.
   * @param {{ names: string[], kind: 'apps' | 'files' }[]} requests
   */
  lookup: (requests) => ipcRenderer.invoke('icon-theme:lookup', requests),

  /**
   * Make a theme the session's.
   * @param {string} theme
   */
  set: (theme) => ipcRenderer.invoke('icon-theme:set', theme),

  /**
   * A theme for publishing: { id, name, inherits, archive (a .tar.gz), previews: { name, mime, data }[] }.
   * @param {string} id
   */
  exportTheme: (id) => ipcRenderer.invoke('icon-theme:export', id),

  /** The themes installed from Nostr: { id, source: { coordinate, publishedAt } }[]. */
  published: () => ipcRenderer.invoke('icon-theme:published'),

  /**
   * Download and install a published theme; resolves with { id, missing }, missing being parents it lacks.
   * @param {object} manifest
   */
  installPublished: (manifest) => ipcRenderer.invoke('icon-theme:install-published', manifest),

  /**
   * Delete a theme Din installed.
   * @param {string} id
   */
  removeTheme: (id) => ipcRenderer.invoke('icon-theme:remove', id),

  /**
   * Subscribe to theme changes. Returns an unsubscribe fn.
   * @param {() => void} callback
   */
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('icon-theme:changed', handler);
    return () => ipcRenderer.removeListener('icon-theme:changed', handler);
  },
});

// InDesign bridge (window.dinos.indd), backed by the indd:* handler in
// electron/indd.mts: reads an InDesign document into the IDML package Page
// Layout edits.
expose('indd', {
  /**
   * { idml, previews: { graphics, data }[], warnings }; rejects with a
   * sentence when it can't be read.
   * @param {Uint8Array} bytes
   * @param {string} name
   */
  convert: (bytes, name) => ipcRenderer.invoke('indd:convert', bytes, name),
});

// Tray bridge (window.dinos.tray), backed by the tray:* handlers in
// electron/tray.mts: apps' status icons (StatusNotifierItems) for the menu
// bar, their menus, and the clicks that go back to them. Coordinates are
// viewport pixels, which are screen pixels to native apps.
expose('tray', {
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

// System notifications bridge (window.dinos.systemNotifications), backed by
// electron/notifications.mts: notifications from Linux apps (over D-Bus) and
// web pages, for the notification center, and what the user did with them.
expose('systemNotifications', {
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

  /**
   * Subscribe to badges websites, nsites and Linux apps set on their Dock
   * tiles. Returns an unsubscribe fn.
   * @param {(change: unknown) => void} callback
   */
  onBadge: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} change
     */
    const handler = (_event, change) => callback(change);
    ipcRenderer.on('notifications:badge', handler);
    return () => ipcRenderer.removeListener('notifications:badge', handler);
  },

  /** The badges set so far. */
  badges: () => ipcRenderer.invoke('notifications:badges'),
});

// Zoom bridge (window.dinos.zoom). Sets Chromium's page zoom for the shell window -
// true DPI-style scaling: the layout viewport shrinks/grows so innerWidth,
// viewport units and canvas measurements all stay consistent (unlike CSS
// `zoom`, which scales rendering but not layout). Renderer-local via webFrame;
// no IPC or main-process handler involved.
expose('zoom', {
  /**
   * Set the interface zoom factor (1 = native size). Clamped to 0.5-2.
   * @param {number} factor
   */
  set: (factor) => {
    if (!Number.isFinite(factor)) return;
    webFrame.setZoomFactor(Math.min(2, Math.max(0.5, factor)));
  },
});

// Theme bridge (window.dinos.theme), backed by the theme:set handler in main.mts:
// the shell's light/dark mode becomes Chromium's, so `prefers-color-scheme`
// in browser tabs and web apps follows it.
expose('theme', {
  /**
   * Set the color scheme pages see.
   * @param {'light' | 'dark' | 'system'} source
   */
  set: (source) => ipcRenderer.send('theme:set', source),
  /**
   * Set selected text's background in pages, and native apps' accent.
   * @param {string} color `#rrggbbaa`
   */
  setSelection: (color) => ipcRenderer.send('theme:selection', color),
  /**
   * Subscribe to "Set Image as Desktop Background" in a page's right-click
   * menu. Returns an unsubscribe fn.
   * @param {(url: string) => void} callback
   */
  onSetBackground: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ url: string }} d
     */
    const listener = (_event, d) => callback(d.url);
    ipcRenderer.on('theme:setBackground', listener);
    return () => ipcRenderer.removeListener('theme:setBackground', listener);
  },
});

// Power bridge (window.dinos.power), backed by the power:* handlers in main.mts.
// `status` reads battery/AC state from /sys/class/power_supply (menu-bar
// indicator + Settings battery panel; `available: false` with no battery).
// `profiles`/`setProfile` drive the system power profile through the
// net.hadess.PowerProfiles D-Bus API (power-profiles-daemon / tuned-ppd);
// `available: false` when no such daemon is running. `reboot`/`powerOff`
// go through logind, and `actions` says which of them it allows.
expose('power', {
  /** Battery/AC state. `available: false` when no battery is present. */
  status: () => ipcRenderer.invoke('power:status'),

  /** Available power profiles + the active one. `available: false` with no daemon. */
  profiles: () => ipcRenderer.invoke('power:profiles'),

  /**
   * Switch the active power profile. Resolves to the new profiles state.
   * @param {string} name
   */
  setProfile: (name) => ipcRenderer.invoke('power:setProfile', name),

  /** Which of restart and shut down logind allows this session. */
  actions: () => ipcRenderer.invoke('power:actions'),

  /** Restart the computer. */
  reboot: () => ipcRenderer.invoke('power:reboot'),

  /** Shut the computer down. */
  powerOff: () => ipcRenderer.invoke('power:powerOff'),
});

// Installer bridge (window.dinos.installer), backed by electron/installer.mts:
// copies a live USB boot of DinOS onto the computer's own disk.
expose('installer', {
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

// Bluetooth bridge (window.dinos.bluetooth), backed by electron/bluetooth.mts:
// BlueZ's adapter and devices, and the prompts pairing needs.
expose('bluetooth', {
  /** The adapter, the devices it knows or sees, and any pairing prompt. */
  state: () => ipcRenderer.invoke('bluetooth:state'),

  /**
   * Turn the adapter on or off.
   * @param {boolean} on
   */
  setPowered: (on) => ipcRenderer.invoke('bluetooth:setPowered', on),

  /**
   * Start or stop looking for devices nearby. A search stops by itself
   * after a couple of minutes.
   * @param {boolean} on
   */
  discover: (on) => ipcRenderer.invoke('bluetooth:discover', on),

  /**
   * Pair with a device, then connect to it.
   * @param {string} path
   */
  pair: (path) => ipcRenderer.invoke('bluetooth:pair', path),

  /** @param {string} path */
  connect: (path) => ipcRenderer.invoke('bluetooth:connect', path),

  /** @param {string} path */
  disconnect: (path) => ipcRenderer.invoke('bluetooth:disconnect', path),

  /**
   * Remove a device and its pairing.
   * @param {string} path
   */
  forget: (path) => ipcRenderer.invoke('bluetooth:forget', path),

  /**
   * Stop a pairing in progress.
   * @param {string} path
   */
  cancel: (path) => ipcRenderer.invoke('bluetooth:cancel', path),

  /**
   * Answer a pairing prompt.
   * @param {number} id
   * @param {boolean} accept
   * @param {string} [value] The PIN or passkey typed, for those prompts.
   */
  answer: (id, accept, value) => ipcRenderer.invoke('bluetooth:answer', id, accept, value),

  /**
   * Whether the shell is there to answer pairing prompts.
   * @param {boolean} enabled
   */
  setPrompts: (enabled) => ipcRenderer.invoke('bluetooth:prompts', enabled),

  /**
   * Subscribe to state changes. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('bluetooth:changed', handler);
    return () => ipcRenderer.removeListener('bluetooth:changed', handler);
  },
});

// Printing bridge (window.dinos.printing), backed by electron/printing.mts: the
// printers CUPS knows, Din's print dialog, and the print queue.
expose('printing', {
  /** Printers and waiting jobs. */
  state: () => ipcRenderer.invoke('printing:state'),

  /** @param {string} printer */
  capabilities: (printer) => ipcRenderer.invoke('printing:capabilities', printer),

  /**
   * Start printing a page (a <webview> guest); resolves to the document.
   * @param {number} wcId
   */
  openPage: (wcId) => ipcRenderer.invoke('printing:openPage', wcId),

  /**
   * Start printing a file; resolves to the document.
   * @param {string} path
   */
  openFile: (path) => ipcRenderer.invoke('printing:openFile', path),

  /**
   * Lay a document out and draw its first pages.
   * @param {string} id
   * @param {unknown} layout
   */
  preview: (id, layout) => ipcRenderer.invoke('printing:preview', id, layout),

  /**
   * Send a document to a printer; resolves to the job id.
   * @param {string} id
   * @param {unknown} layout
   * @param {unknown} job
   */
  print: (id, layout, job) => ipcRenderer.invoke('printing:print', id, layout, job),

  /**
   * Save a document as a PDF instead.
   * @param {string} id
   * @param {unknown} layout
   * @param {string} path
   */
  savePdf: (id, layout, path) => ipcRenderer.invoke('printing:savePdf', id, layout, path),

  /**
   * The dialog closed without printing.
   * @param {string} id
   */
  close: (id) => ipcRenderer.invoke('printing:close', id),

  /** Forget every open document (the shell just started). */
  reset: () => ipcRenderer.invoke('printing:reset'),

  /** @param {string} job */
  cancelJob: (job) => ipcRenderer.invoke('printing:cancelJob', job),

  /** @param {string} printer */
  setDefault: (printer) => ipcRenderer.invoke('printing:setDefault', printer),

  /** @param {string} printer */
  testPage: (printer) => ipcRenderer.invoke('printing:testPage', printer),

  /** @param {string} printer */
  resume: (printer) => ipcRenderer.invoke('printing:resume', printer),

  /** @param {string} printer */
  remove: (printer) => ipcRenderer.invoke('printing:remove', printer),

  /** Look for printers that need setting up (slow: asks every backend). */
  discover: () => ipcRenderer.invoke('printing:discover'),

  /**
   * Set up a printer `discover` found, with the best driver there is.
   * @param {string} uri
   */
  add: (uri) => ipcRenderer.invoke('printing:add', uri),

  /**
   * Subscribe to pages asking to print. Returns an unsubscribe fn.
   * @param {(document: unknown) => void} callback
   */
  onOpen: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} document
     */
    const handler = (_event, document) => callback(document);
    ipcRenderer.on('printing:open', handler);
    return () => ipcRenderer.removeListener('printing:open', handler);
  },

  /**
   * Subscribe to printers stopping with a job waiting, and those jobs
   * printing after all. Returns an unsubscribe fn.
   * @param {(event: unknown) => void} callback
   */
  onEvent: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} payload
     */
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('printing:event', handler);
    return () => ipcRenderer.removeListener('printing:event', handler);
  },
});

// Volumes bridge (window.dinos.volumes), backed by electron/volumes.mts: removable
// disks, mounted as they're plugged in, and ejecting them.
expose('volumes', {
  /** The removable filesystems, mounted or not. */
  state: () => ipcRenderer.invoke('volumes:state'),

  /**
   * Mount a volume; resolves to where.
   * @param {string} id
   */
  mount: (id) => ipcRenderer.invoke('volumes:mount', id),

  /**
   * Unlock an encrypted volume and mount what's in it; resolves to where.
   * @param {string} id
   * @param {string} passphrase
   */
  unlock: (id, passphrase) => ipcRenderer.invoke('volumes:unlock', id, passphrase),

  /**
   * Unmount everything on a volume's disk and power it off.
   * @param {string} id
   */
  eject: (id) => ipcRenderer.invoke('volumes:eject', id),

  /**
   * Subscribe to state changes. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('volumes:changed', handler);
    return () => ipcRenderer.removeListener('volumes:changed', handler);
  },

  /**
   * Subscribe to disks becoming ready, locked, safe to remove, pulled out,
   * or unreadable. Returns an unsubscribe fn.
   * @param {(event: unknown) => void} callback
   */
  onEvent: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} payload
     */
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('volumes:event', handler);
    return () => ipcRenderer.removeListener('volumes:event', handler);
  },
});

/**
 * A subscription to one of main's pushes. Returns an unsubscribe fn.
 * @param {string} channel
 * @param {(payload: any) => void} callback
 */
function listen(channel, callback) {
  /**
   * @param {Electron.IpcRendererEvent} _event
   * @param {unknown} payload
   */
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Passwords (window.dinos.passwords), backed by electron/passwords.mts: the
// vault, and the browser's autofill. Types in src/lib/passwords.ts.
/** @type {Record<string, (...args: unknown[]) => unknown>} */
const passwords = {};
for (const method of [
  'state', 'create', 'unlock', 'lock', 'setAutoUnlock', 'forgetNever', 'changePassword', 'list', 'get', 'save',
  'setFavorite', 'move', 'trash', 'restore', 'deleteForever', 'emptyTrash', 'createGroup', 'renameGroup',
  'deleteGroup', 'import', 'generate', 'copy',
]) {
  passwords[method] = (...args) => ipcRenderer.invoke(`passwords:${method}`, ...args);
}
expose('passwords', {
  ...passwords,
  /** @param {(state: unknown) => void} callback */
  onChanged: (callback) => listen('passwords:changed', callback),
  /** @param {string} url */
  siteLogins: (url) => ipcRenderer.invoke('passwords:site-logins', url),
  /** @param {number} wcId @param {string} id */
  fillPage: (wcId, id) => ipcRenderer.invoke('passwords:fill-page', wcId, id),
  /** @param {number} requestId @param {unknown} choice */
  choose: (requestId, choice) => ipcRenderer.invoke('passwords:choose', requestId, choice),
  /** @param {number} requestId @param {boolean} highlighted */
  highlight: (requestId, highlighted) => ipcRenderer.invoke('passwords:highlight', requestId, highlighted),
  /** @param {number} offerId @param {string} answer @param {string} [username] */
  answerOffer: (offerId, answer, username) => ipcRenderer.invoke('passwords:answer-offer', offerId, answer, username),
  /** @param {(suggestion: unknown) => void} callback */
  onSuggest: (callback) => listen('passwords:suggest', callback),
  /** @param {(requestId: number) => void} callback */
  onHide: (callback) => listen('passwords:hide', (p) => callback(p.requestId)),
  /** @param {(event: unknown) => void} callback */
  onKey: (callback) => listen('passwords:key', callback),
  /** @param {(offer: unknown) => void} callback */
  onOffer: (callback) => listen('passwords:offer', callback),
  /** @param {(offerId: number) => void} callback */
  onOfferGone: (callback) => listen('passwords:offer-gone', (p) => callback(p.offerId)),
});

// Phones (window.dinos.phone), backed by electron/phone.mts: text messages
// from the user's phones, and files they share, for Settings → Phone,
// notifications and the `din phone` commands; Messages has them through its bridge port. Types
// in src/lib/phone.ts.
/** @type {Record<string, (...args: unknown[]) => unknown>} */
const phone = {};
for (const method of [
  'state', 'conversations', 'messages', 'contacts', 'send', 'markRead', 'deleteConversation', 'refresh', 'disconnect', 'add', 'forget',
  'setReceiveFiles', 'cancelReceive',
]) {
  phone[method] = (...args) => ipcRenderer.invoke(`phone:${method}`, ...args);
}
expose('phone', {
  ...phone,
  /** @param {(state: unknown) => void} callback */
  onChanged: (callback) => listen('phone:changed', callback),
  /** @param {(change: unknown) => void} callback */
  onMessages: (callback) => listen('phone:messages', callback),
  /** @param {(incoming: unknown) => void} callback */
  onIncoming: (callback) => listen('phone:incoming', callback),
  /** @param {(receive: unknown) => void} callback */
  onReceive: (callback) => listen('phone:receive', callback),
});

// Mail (window.dinos.mail), backed by electron/mail.mts: the accounts'
// mailing lists, for the `din mail` commands, and new mail and unread
// counts, for notifications and Mail's Dock badge; Mail has all of it
// through its bridge port. Types in src/lib/mail.ts.
/** @type {Record<string, (...args: unknown[]) => unknown>} */
const mail = {};
for (const method of ['accounts', 'mailboxes', 'markAllRead', 'avatarLookups', 'setAvatarLookups', 'subscriptions', 'unsubscribe', 'unseen']) {
  mail[method] = (...args) => ipcRenderer.invoke(`mail:${method}`, ...args);
}
expose('mail', {
  ...mail,
  /** @param {(unseen: unknown) => void} callback */
  onUnseen: (callback) => listen('mail:unseen', callback),
  /** @param {(arrival: unknown) => void} callback */
  onArrived: (callback) => listen('mail:arrived', callback),
  /** @param {(read: unknown) => void} callback */
  onRead: (callback) => listen('mail:read', callback),
});

// Quick Share (window.dinos.quickShare), backed by electron/quickshare.mts:
// the desktop answers shares that arrive with no Quick Share window open (a
// phone's share sheet made this computer visible), in a notification. The
// Quick Share app has the rest through its bridge port. Types in
// src/lib/quickShare.ts.
expose('quickShare', {
  /** @param {string} id @param {boolean} accept */
  respond: (id, accept) => ipcRenderer.invoke('quickshare:respond', id, accept),
  /** @param {string} id */
  cancel: (id) => ipcRenderer.invoke('quickshare:cancel', id),
  /** @param {(transfer: unknown) => void} callback */
  onTransfer: (callback) => listen('quickshare:transfer', callback),
});

// Virtual machines (window.dinos.vms), backed by electron/vms.mts, for the
// `din vms` commands; the Virtual Machines app has them, and machines'
// screens, through its bridge port. Types in src/lib/vms.ts.
/** @type {Record<string, (...args: unknown[]) => unknown>} */
const vms = {};
for (const method of [
  'status', 'list', 'create', 'install', 'retryInstall', 'cancelInstall', 'update', 'remove', 'start', 'shutdown',
  'forceStop', 'pause', 'resume', 'reset', 'setCdrom', 'resizeDisk', 'snapshots', 'takeSnapshot', 'restoreSnapshot',
  'deleteSnapshot',
]) {
  vms[method] = (...args) => ipcRenderer.invoke(`vms:${method}`, ...args);
}
expose('vms', {
  ...vms,
  /** @param {(vms: unknown) => void} callback */
  onChanged: (callback) => listen('vms:changed', callback),
});

// System Monitor bridge (window.dinos.systemMonitor), backed by
// electron/system-monitor.mts: snapshots of what's running, pushed every few
// seconds while someone is subscribed, and SIGTERM/SIGKILL for Din's user's
// own processes.
expose('systemMonitor', {
  /**
   * Receive a snapshot every few seconds; sampling runs only while someone
   * is subscribed. Returns an unsubscribe fn.
   * @param {(snapshot: unknown) => void} callback
   */
  subscribe: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} snapshot
     */
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('system-monitor:snapshot', handler);
    void ipcRenderer.invoke('system-monitor:subscribe');
    return () => {
      ipcRenderer.removeListener('system-monitor:snapshot', handler);
      void ipcRenderer.invoke('system-monitor:unsubscribe');
    };
  },

  /**
   * Ask a process to quit (SIGTERM).
   * @param {number} pid
   */
  end: (pid) => ipcRenderer.invoke('system-monitor:end', pid),

  /**
   * Make a process quit now (SIGKILL).
   * @param {number} pid
   */
  forceQuit: (pid) => ipcRenderer.invoke('system-monitor:force-quit', pid),

  /** The space on /home, measured now. */
  filesystems: () => ipcRenderer.invoke('system-monitor:filesystems'),
});

// Bluetooth login bridge (window.dinos.bluetoothLogin), backed by
// electron/bluetooth-login.mts: advertises a GATT service a phone (Tenna)
// sends the account key to, encrypted to the renderer's ephemeral key.
expose('bluetoothLogin', {
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

// Signer bridge (window.dinos.nostrd), backed by electron/nostrd.mts: nostrd, the
// signer daemon that holds the account keys, signs for the shell and manages
// its accounts.
expose('nostrd', {
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

// Boot screen bridge (window.dinos.bootScreen), backed by electron/boot-screen.mts:
// copies the wallpaper to the boot partition, for DinOS's unlock screen.
expose('bootScreen', {
  /**
   * Show this wallpaper on the boot screen, with a 12- or 24-hour clock.
   * @param {string | null} wallpaper A URL, or null for none.
   * @param {boolean} hour12
   */
  update: (wallpaper, hour12) => ipcRenderer.invoke('boot-screen:update', wallpaper, hour12),
});

// Lock bridge (window.dinos.lock), backed by electron/lock.mts: DinOS's lock
// screen, which runs outside Din.
expose('lock', {
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

  /** What sudo asks for: 'approve', 'password' or 'skip'. */
  sudoMode: () => ipcRenderer.invoke('lock:sudo-mode'),

  /**
   * Change what sudo asks for. Loosening it takes the password.
   * @param {'approve' | 'password' | 'skip'} mode
   * @param {string} [password]
   */
  setSudoMode: (mode, password) => ipcRenderer.invoke('lock:set-sudo-mode', mode, password),
});

// Askpass bridge (window.dinos.askpass), backed by electron/askpass.mts: sudo
// asking to approve a command, or for the password with no terminal to ask on.
expose('askpass', {
  /**
   * Subscribe to requests. Returns an unsubscribe fn.
   * @param {(request: { requestId: number, requester: string, command: string, approve: boolean }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, requester: string, command: string, approve: boolean }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('askpass:request', listener);
    return () => ipcRenderer.removeListener('askpass:request', listener);
  },

  /**
   * Subscribe to requests that went away (sudo stopped, or it timed out).
   * Returns an unsubscribe fn.
   * @param {(requestId: number) => void} callback
   */
  onCancel: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number }} d
     */
    const listener = (_event, d) => callback(d.requestId);
    ipcRenderer.on('askpass:cancel', listener);
    return () => ipcRenderer.removeListener('askpass:cancel', listener);
  },

  /**
   * Answer with the password, or null to cancel. Resolves `{ ok: false }`
   * when the password isn't right.
   * @param {number} requestId
   * @param {string | null} password
   */
  answer: (requestId, password) => ipcRenderer.invoke('askpass:answer', requestId, password),

  /**
   * Allow an approval request, or deny it.
   * @param {number} requestId
   * @param {boolean} allow
   */
  approve: (requestId, allow) => ipcRenderer.invoke('askpass:approve', requestId, allow),
});

// Updater bridge (window.dinos.updater), backed by electron/updater.mts: builds
// Din's source and stages it for the next boot.
expose('updater', {
  /** Versions, the source, and the check or update in progress (or the failed one). */
  state: () => ipcRenderer.invoke('updater:state'),

  /** Look for a newer commit now, and build and stage it. Progress arrives through onProgress. */
  check: () => ipcRenderer.invoke('updater:check'),

  /** Build the branch's tip as it is, over the system's own changes. */
  replace: () => ipcRenderer.invoke('updater:replace'),

  /**
   * Whether the system updates by itself.
   * @param {boolean} auto
   */
  setAuto: (auto) => ipcRenderer.invoke('updater:setAuto', auto),

  /**
   * Build updates from another repository or branch. sudo asks the user first.
   * @param {string} url
   * @param {string} branch
   */
  setSource: (url, branch) => ipcRenderer.invoke('updater:setSource', url, branch),

  /** Switch to the staged system now, where that needs no restart of the computer. */
  apply: () => ipcRenderer.invoke('updater:apply'),

  /**
   * Build a branch or commit of ~/DinOS and switch to it. sudo asks first,
   * in the Assistant conversation `session` if one's named.
   * @param {string} ref
   * @param {string | undefined} session
   */
  buildLocal: (ref, session) => ipcRenderer.invoke('updater:buildLocal', ref, session),
  /** Restart Din, to start a new Din a switch brought. */
  restartDin: () => ipcRenderer.invoke('updater:restartDin'),
  /** Restart the computer, into the staged update. */
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

// Firmware bridge (window.dinos.firmware), backed by electron/firmware.mts:
// updates for the computer's firmware and its devices', through fwupd.
expose('firmware', {
  /** The updates found, and the check or install in progress (or the failed one). */
  state: () => ipcRenderer.invoke('firmware:state'),

  /** Get LVFS's newest releases and look for updates. */
  check: () => ipcRenderer.invoke('firmware:check'),

  /**
   * Install the newest firmware for a device. Resolves when it's done (or
   * staged for the next restart).
   * @param {string} deviceId
   */
  install: (deviceId) => ipcRenderer.invoke('firmware:install', deviceId),

  /** Restart the computer, which applies staged firmware. */
  reboot: () => ipcRenderer.invoke('firmware:reboot'),

  /**
   * Subscribe to state changes. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onProgress: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('firmware:progress', handler);
    return () => ipcRenderer.removeListener('firmware:progress', handler);
  },
});

// AirPlay bridge (window.dinos.airplay), backed by electron/airplay.mts: mirrors
// or extends the screen to AirPlay receivers through deckmon.
expose('airplay', {
  /** Receivers found nearby and the sessions in progress. */
  state: () => ipcRenderer.invoke('airplay:state'),

  /** Look for receivers now. */
  scan: () => ipcRenderer.invoke('airplay:scan'),

  /**
   * Start sharing with a receiver the way it was last shared (extending by
   * default); resolves once it's streaming, or once it failed, which the
   * state's `failure` says.
   * @param {string} target
   */
  connect: (target) => ipcRenderer.invoke('airplay:connect', target),

  /**
   * Mirror or extend to a receiver from now on, switching it over if it's
   * streaming; resolves once it streams the new way.
   * @param {string} target
   * @param {'mirror' | 'extend'} mode
   */
  mode: (target, mode) => ipcRenderer.invoke('airplay:mode', target, mode),

  /**
   * Answer a receiver's request for the PIN it shows, or its password.
   * @param {string} target
   * @param {string} code
   */
  code: (target, code) => ipcRenderer.invoke('airplay:code', target, code),

  /**
   * Stop sharing with a receiver.
   * @param {string} target
   */
  disconnect: (target) => ipcRenderer.invoke('airplay:disconnect', target),

  /**
   * Subscribe to state changes. Returns an unsubscribe fn.
   * @param {(state: unknown) => void} callback
   */
  onChanged: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} state
     */
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('airplay:changed', handler);
    return () => ipcRenderer.removeListener('airplay:changed', handler);
  },

  /**
   * Subscribe to the display-switch key switching a receiver, for the OSD.
   * Returns an unsubscribe fn.
   * @param {(change: unknown) => void} callback
   */
  onOsd: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} change
     */
    const handler = (_event, change) => callback(change);
    ipcRenderer.on('airplay:osd', handler);
    return () => ipcRenderer.removeListener('airplay:osd', handler);
  },
});

// System packages bridge (window.dinos.packages), backed by
// electron/system-packages.mts: installing what a feature needs from the host
// system's package manager.
expose('packages', {
  /**
   * Whether what a feature needs is installed, and the command that would install it.
   * @param {'xvfb'} feature
   */
  status: (feature) => ipcRenderer.invoke('packages:status', feature),

  /**
   * Install it, asking for the administrator password in Din.
   * @param {'xvfb'} feature
   */
  install: (feature) => ipcRenderer.invoke('packages:install', feature),
});

// Dictation bridge (window.dinos.dictation), backed by electron/dictation.mts:
// whisper.cpp's server, which turns the shell's recordings into text.
expose('dictation', {
  /** Whether a speech recognizer and its model are installed. */
  available: () => ipcRenderer.invoke('dictation:available'),

  /** Start the recognizer (load the model) ahead of the first transcription. */
  prepare: () => ipcRenderer.invoke('dictation:prepare'),

  /**
   * The text spoken in a recording.
   * @param {Uint8Array} pcm 16 kHz mono 16-bit samples, little-endian.
   */
  transcribe: (pcm) => ipcRenderer.invoke('dictation:transcribe', pcm),

  /**
   * Type text into a web page (a browser tab or web app), where its focus is.
   * @param {number} wcId The page's WebContents id.
   * @param {string} text
   */
  insertIntoGuest: (wcId, text) => ipcRenderer.invoke('dictation:insert-guest', wcId, text),
});

// Assistant bridge (window.dinos.assistant), backed by electron/assistant.mts:
// OpenCode's background server, whose credentials stay in the main process.
expose('assistant', {
  /** Whether it's installed, running and connected. */
  status: () => ipcRenderer.invoke('assistant:status'),

  /**
   * Turn the assistant on (start the server and follow its events) or off.
   * @param {boolean} enabled
   */
  setEnabled: (enabled) => ipcRenderer.invoke('assistant:setEnabled', enabled),

  /** Run OpenCode's installer. */
  install: () => ipcRenderer.invoke('assistant:install'),

  /** Restart the server. */
  restart: () => ipcRenderer.invoke('assistant:restart'),

  /** Ask OpenCode's update service now: the newer version, or null. */
  checkUpdate: () => ipcRenderer.invoke('assistant:checkUpdate'),

  /** Update OpenCode to its newest release and restart the server on it. */
  upgrade: () => ipcRenderer.invoke('assistant:upgrade'),

  /** The models OpenCode's own interface used last. */
  recentModels: () => ipcRenderer.invoke('assistant:recentModels'),

  /**
   * One request to the server's API.
   * @param {string} method
   * @param {string} path Under /api/, with its query.
   * @param {unknown} [body] Sent as JSON.
   */
  request: (method, path, body) => ipcRenderer.invoke('assistant:request', method, path, body),

  /** sudo's password and approval requests from the agent's commands (electron/askpass.mts). */
  passwords: () => ipcRenderer.invoke('assistant:passwords'),

  /**
   * Answer one with the password, or null to cancel. Resolves `{ ok: false }`
   * when the password isn't right. `remember` stops sudo asking in its
   * conversation.
   * @param {number} requestId
   * @param {string | null} password
   * @param {boolean} [remember]
   */
  answerPassword: (requestId, password, remember) =>
    ipcRenderer.invoke('assistant:answerPassword', requestId, password, remember),

  /**
   * Answer an approval request: allow it once, for the rest of its
   * conversation, or deny it.
   * @param {number} requestId
   * @param {'once' | 'conversation' | 'reject'} decision
   */
  approve: (requestId, decision) => ipcRenderer.invoke('assistant:approve', requestId, decision),

  /**
   * Subscribe to status changes. Returns an unsubscribe fn.
   * @param {(status: unknown) => void} callback
   */
  onStatus: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} status
     */
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('assistant:status', handler);
    return () => ipcRenderer.removeListener('assistant:status', handler);
  },

  /**
   * Subscribe to the server's events. Returns an unsubscribe fn.
   * @param {(event: unknown) => void} callback
   */
  onEvent: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {unknown} data
     */
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('assistant:event', handler);
    return () => ipcRenderer.removeListener('assistant:event', handler);
  },
});

// System change events (window.dinos.systemEvents): the main process watches
// NetworkManager and PipeWire for changes (`nmcli monitor`, `pactl
// subscribe`) and says which area changed, so the menu bar and Settings
// refresh on events instead of polling every few seconds.
expose('systemEvents', {
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

// Audio bridge (window.dinos.audio), backed by the audio:* handlers in main.mts
// (wpctl / PipeWire). Drives the default sink for the menu-bar control and the
// media-key OSD (status/setVolume/setMuted resolve to { available, volume,
// muted }), plus the Settings sound panel: device enumeration/selection
// (devices/setDefault), per-app and per-device control (streams/setNodeVolume/
// setNodeMuted) and a test tone (test). `available: false` when wpctl is absent.
expose('audio', {
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

  /** Default source (microphone) volume/mute. `available: false` without one. */
  inputStatus: () => ipcRenderer.invoke('audio:inputStatus'),

  /**
   * Set the default source volume (0-150; past 100 amplifies). Resolves to the new state.
   * @param {number} percent
   */
  setInputVolume: (percent) => ipcRenderer.invoke('audio:setInputVolume', percent),

  /**
   * Mute or unmute the default source. Resolves to the new state.
   * @param {boolean} muted
   */
  setInputMuted: (muted) => ipcRenderer.invoke('audio:setInputMuted', muted),

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
   * Select an output/input on a card's inactive profile: switch the card to
   * a profile that carries the port and make its new node the default.
   * Resolves to the new device list.
   * @param {string} card
   * @param {string} port
   */
  selectPort: (card, port) => ipcRenderer.invoke('audio:selectPort', card, port),

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
   * The callback receives the new { available, volume, muted } state, with
   * `device` naming the output when sound has just moved to headphones.
   * Returns an unsubscribe fn.
   * @param {(status: { available: boolean, volume: number | null, muted: boolean, device?: string }) => void} callback
   */
  onOsd: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ available: boolean, volume: number | null, muted: boolean, device?: string }} status
     */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('audio:osd', listener);
    return () => ipcRenderer.removeListener('audio:osd', listener);
  },

  /**
   * Subscribe to mic-mute key presses, for the OSD. The callback receives the
   * default source's new { available, volume, muted } state. Returns an
   * unsubscribe fn.
   * @param {(status: { available: boolean, volume: number | null, muted: boolean }) => void} callback
   */
  onInputOsd: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ available: boolean, volume: number | null, muted: boolean }} status
     */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('audio:inputOsd', listener);
    return () => ipcRenderer.removeListener('audio:inputOsd', listener);
  },
});

// Brightness bridge (window.dinos.brightness), backed by the brightness:* handlers in
// main.mts. Two independent halves: the screen backlight (brightnessctl /
// /sys/class/backlight) and night light / red shift (a warm color temperature
// held by a Wayland/X11 gamma tool, gammastep or wlsunset). Drives the menu-bar
// control, the Settings brightness panel, and the media-key OSD. Mutations
// resolve to the new { available, brightness, nightLight } state; each half
// reports available:false where its tool/device is absent.
expose('brightness', {
  /** Backlight level + night-light state. See per-field `available` flags. */
  status: () => ipcRenderer.invoke('brightness:status'),

  /**
   * Set the brightness level (-80-100; below 0 dims in software). Resolves to the new state.
   * @param {number} percent
   */
  setBrightness: (percent) => ipcRenderer.invoke('brightness:setBrightness', percent),

  /**
   * Turn night light on or off; on a schedule, it tints only in its hours.
   * Resolves to the new state.
   * @param {boolean} enabled
   */
  setNightLight: (enabled) => ipcRenderer.invoke('brightness:setNightLight', enabled),

  /**
   * Set the night-light color temperature in Kelvin. Resolves to the new state.
   * @param {number} kelvin
   */
  setTemperature: (kelvin) => ipcRenderer.invoke('brightness:setTemperature', kelvin),

  /**
   * Set when night light runs: always, sunset to sunrise, or custom hours
   * ("HH:MM", local time). Resolves to the new state.
   * @param {{ schedule: 'always' | 'sunset' | 'custom', from: string, to: string }} schedule
   */
  setNightLightSchedule: (schedule) => ipcRenderer.invoke('brightness:setNightLightSchedule', schedule),

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

// Screenshot bridge (window.dinos.screenshot), backed by the screenshot:* handler in
// main.mts (webContents.capturePage). Snapshots the Din desktop as a PNG for
// the Screenshot app. Absent in a plain browser, where the app falls back.
expose('screenshot', {
  /** Capture the desktop; resolves to { dataUrl, width, height } (PNG). */
  capture: () => ipcRenderer.invoke('screenshot:capture'),

  /**
   * Capture just one window's on-screen rectangle (CSS pixels, relative to
   * the shell content's top-left), for the genie minimize/restore animation.
   * Resolves to { dataUrl, width, height } (PNG at device resolution, or a
   * JPEG shrunk by `options.scale`).
   * @param {{ x: number, y: number, width: number, height: number }} rect
   * @param {{ scale?: number }} [options]
   */
  captureRegion: (rect, options) => ipcRenderer.invoke('screenshot:captureRegion', rect, options),

  /**
   * Put a PNG capture on the system clipboard.
   * @param {string} dataUrl a `data:image/png;base64,...` URL
   */
  copy: (dataUrl) => ipcRenderer.invoke('screenshot:copy', dataUrl),
});

/**
 * Details of a rejected TLS certificate for a browser tab.
 * @typedef {{ wcId: number, url: string, host: string, error: string, fingerprint: string }} CertificateErrorInfo
 */

// Browser bridge (window.dinos.browser), backed by the browser:* handlers in
// main.mts. A browser tab that hits an untrusted TLS certificate (self-signed
// or private-CA host) has its load rejected; the details arrive here so the
// Web Browser app can show a "proceed anyway" warning. Accepting pins that
// exact (host, fingerprint) pair in the main process (persisted) so the
// following reload is trusted. Scoped to the browser session only.
expose('browser', {
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
   * Open a connection to `url`'s origin in the persistent browser session,
   * ahead of a likely navigation there (the address bar, as the user types).
   * @param {string} url
   */
  preconnect: (url) => ipcRenderer.send('browser:preconnect', url),

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
   * Run a downloaded Windows program. Restricted to files under ~/Downloads
   * in the main process.
   * @param {string} savePath
   */
  openDownload: (savePath) => ipcRenderer.invoke('browser:openDownload', savePath),

  /**
   * What a site (`origin`) has been allowed or blocked, and whether the user
   * accepted an untrusted certificate for its host. `isPrivate` reads the
   * private window's session instead of the persistent one.
   * @param {string} origin
   * @param {boolean} isPrivate
   */
  getSiteInfo: (origin, isPrivate) =>
    ipcRenderer.invoke('site-permissions:get', origin, isPrivate),

  /**
   * Allow (true) or block (false) a capability for a site, or forget the
   * answer (null) so it asks again.
   * @param {string} origin
   * @param {string} capability
   * @param {boolean | null} allow
   * @param {boolean} isPrivate
   */
  setSitePermission: (origin, capability, allow, isPrivate) =>
    ipcRenderer.invoke('site-permissions:set', origin, capability, allow, isPrivate),

  /**
   * Delete one site's cookies and storage, in the private window's session
   * if `isPrivate`. Its permissions stay.
   * @param {string} origin
   * @param {boolean} isPrivate
   */
  clearSiteData: (origin, isPrivate) => ipcRenderer.invoke('site-data:clear', origin, isPrivate),

  /**
   * Every site that has a remembered answer for a capability.
   * @param {string} capability
   */
  listSitePermissions: (capability) => ipcRenderer.invoke('site-permissions:list', capability),

  /**
   * A remembered answer changed (asked, switched or forgotten).
   * @param {() => void} callback
   */
  onSitePermissionsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('site-permissions:changed', listener);
    return () => ipcRenderer.removeListener('site-permissions:changed', listener);
  },
});

/**
 * An extension-initiated tab command surfaced to the browser app.
 * @typedef {(
 *   { type: 'create', requestId: number, url?: string, active: boolean } |
 *   { type: 'open', url: string, openerWcId?: number, background?: boolean, popup?: CrxPopupFeatures } |
 *   { type: 'select', wcId: number } |
 *   { type: 'close', wcId: number }
 * )} CrxTabCommand
 */

/**
 * A window.open that asked for a pop-up window, not a tab.
 * @typedef {{ width: number, height: number, private: boolean }} CrxPopupFeatures
 */

// Chrome extension bridge (window.dinos.crx), backed by the crx:* handlers in
// main.mts (electron-chrome-extensions). Used by the web browser app to
// coordinate its tab UI with the extension system: extensions can ask for
// tabs to be created/activated/closed, and the shell reports which tab is
// active plus the WebContents id of each newly attached <webview> guest.
expose('crx', {
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
     * @param {{ url: string, openerWcId?: number, background?: boolean, popup?: CrxPopupFeatures }} d
     */
    const open = (_event, d) =>
      callback({
        type: 'open',
        url: d.url,
        openerWcId: d.openerWcId,
        background: d.background,
        popup: d.popup,
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

  /** Installed extensions ({ id, name, version, description, source, path?, coordinate? }[]). */
  listExtensions: () => ipcRenderer.invoke('crx:listExtensions'),

  /**
   * Uninstall an installed extension by id (one loaded from a folder is
   * only forgotten; its folder stays).
   * @param {string} id
   */
  uninstallExtension: (id) => ipcRenderer.invoke('crx:uninstallExtension', id),

  /**
   * Load an extension from a folder, and keep loading it from there.
   * @param {string} path
   */
  loadUnpacked: (path) => ipcRenderer.invoke('crx:loadUnpacked', path),

  /**
   * Install an extension from a .crx file, asking the user first.
   * @param {string} path
   */
  installFile: (path) => ipcRenderer.invoke('crx:installFile', path),

  /**
   * Load an installed extension again from its files.
   * @param {string} id
   */
  reloadExtension: (id) => ipcRenderer.invoke('crx:reloadExtension', id),

  /**
   * An installed extension as a .crx, and its icon, for publishing it; a
   * folder's is signed with its key in `keys` (PEM, by `d`), or a new one.
   * @param {string} id
   * @param {Record<string, string>} keys
   */
  exportExtension: (id, keys) => ipcRenderer.invoke('crx:exportExtension', id, keys),

  /** The extensions installed from Nostr ({ id, source: { coordinate, publishedAt, sha256? } }[]). */
  published: () => ipcRenderer.invoke('crx:published'),

  /**
   * Install (or update) a published extension; resolves with { id, name }.
   * @param {unknown} manifest
   */
  installPublished: (manifest) => ipcRenderer.invoke('crx:installPublished', manifest),

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

// Userscript bridge (window.dinos.userscripts), backed by the userscripts:*
// handlers in main.mts (electron/userscripts.mts). The shell renderer owns
// the script library (localStorage, see src/hooks/useUserscripts.ts) and
// syncs the full list here so the main process can inject matching scripts
// into browser-tab guests as pages load. Navigations to *.user.js files are
// intercepted in main and surfaced back as install requests.
expose('userscripts', {
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

// Ad blocker bridge (window.dinos.adblock), backed by the adblock:* handlers in
// electron/adblock.mts: on/off, the sites ads are allowed on, and how much
// each browser tab has had blocked.
expose('adblock', {
  /** @returns {Promise<{ enabled: boolean, allowlist: string[] }>} */
  getSettings: () => ipcRenderer.invoke('adblock:getSettings'),

  /** @param {boolean} enabled */
  setEnabled: (enabled) => ipcRenderer.invoke('adblock:setEnabled', enabled),

  /**
   * @param {string} hostname
   * @param {boolean} allowed whether ads are allowed (blocking off) there
   */
  setSiteAllowed: (hostname, allowed) => ipcRenderer.invoke('adblock:setSiteAllowed', hostname, allowed),

  /** @param {number} wcId a browser tab's guest */
  blockedCount: (wcId) => ipcRenderer.invoke('adblock:blockedCount', wcId),

  /**
   * Subscribe to settings changes. Returns an unsubscribe fn.
   * @param {(settings: { enabled: boolean, allowlist: string[] }) => void} callback
   */
  onSettings: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ enabled: boolean, allowlist: string[] }} settings
     */
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('adblock:settings', listener);
    return () => ipcRenderer.removeListener('adblock:settings', listener);
  },

  /**
   * Subscribe to tabs' blocked counts. Returns an unsubscribe fn.
   * @param {(update: { wcId: number, count: number }) => void} callback
   */
  onBlocked: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, count: number }} update
     */
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('adblock:blocked', listener);
    return () => ipcRenderer.removeListener('adblock:blocked', listener);
  },
});

// Pop-up blocker bridge (window.dinos.popups), backed by the popups:* handlers in
// electron/popups.mts: the windows each tab was stopped from opening, and the
// sites allowed to open them without a click.
expose('popups', {
  /** @returns {Promise<{ allowlist: string[] }>} */
  getSettings: () => ipcRenderer.invoke('popups:getSettings'),

  /**
   * @param {string} hostname
   * @param {boolean} allowed whether the site may open pop-ups without a click
   */
  setSiteAllowed: (hostname, allowed) => ipcRenderer.invoke('popups:setSiteAllowed', hostname, allowed),

  /**
   * @param {number} wcId a tab's guest
   * @returns {Promise<string[]>}
   */
  blocked: (wcId) => ipcRenderer.invoke('popups:blocked', wcId),

  /**
   * Subscribe to settings changes. Returns an unsubscribe fn.
   * @param {(settings: { allowlist: string[] }) => void} callback
   */
  onSettings: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ allowlist: string[] }} settings
     */
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('popups:settings', listener);
    return () => ipcRenderer.removeListener('popups:settings', listener);
  },

  /**
   * Subscribe to tabs' blocked pop-ups. Returns an unsubscribe fn.
   * @param {(update: { wcId: number, urls: string[] }) => void} callback
   */
  onBlocked: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, urls: string[] }} update
     */
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('popups:blocked', listener);
    return () => ipcRenderer.removeListener('popups:blocked', listener);
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

// DevTools bridge (window.dinos.devtools), backed by the devtools:* handlers in
// main.mts. The web browser app docks Chrome DevTools inside a tab: it
// renders a devtools host <webview> and asks main to open the tab's
// devtools in it (the host loads the bundled DevTools frontend, connected
// to the tab over a loopback CDP bridge - see devtools-bridge.mts).
expose('devtools', {
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
expose('shellShortcuts', {
  /**
   * Subscribe to forwarded shortcuts. Returns an unsubscribe fn. Payloads:
   *   { action: 'cycle-windows', backward }   (Alt+Tab / Alt+Shift+Tab)
   *   { action: 'apps-menu' }                 (Super+Space)
   *   { action: 'assistant' }                 (Super+A)
   *   { action: 'system-monitor' }            (Ctrl+Shift+Escape)
   *   { action: 'security-options' }          (Ctrl+Alt+Delete)
   *   { action: 'super-key', down }           (Super pressed / released)
   *   { action: 'alt-released' }              (Alt released)
   *   { action: 'screenshot' }                (Print Screen)
   *   { action: 'screenshot-area' }           (Shift+Print Screen or the box-select key)
   *   { action: 'new-tab', wcId }             (Ctrl+T in a browser tab)
   *   { action: 'close-tab', wcId }           (Ctrl+W in a browser tab)
   *   { action: 'focus-address', wcId }       (Ctrl+L in a browser tab)
   *   { action: 'find', wcId }                (Ctrl+F in a browser tab)
   *   { action: 'view-source', wcId }         (Ctrl+U in a browser tab)
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
expose('guestInput', {
  /**
   * Subscribe to forwarded guest input. Returns an unsubscribe fn. Payloads:
   *   { wcId, type: 'move', x, y, sx?, sy?, meta }
   *   { wcId, type: 'down' | 'up', x, y, sx?, sy?, button, meta }
   * @param {(data: { wcId: number, type: string, x: number, y: number, sx?: number, sy?: number, button?: string, meta: boolean }) => void} callback
   */
  onInput: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ wcId: number, type: string, x: number, y: number, sx?: number, sy?: number, button?: string, meta: boolean }} data
     */
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('guest:input', handler);
    return () => ipcRenderer.removeListener('guest:input', handler);
  },
});

// Nostr identity bridge host (window.dinos.nostrHost), backed by the
// nostr-bridge:* handlers in main.mts. Browser tabs and installed web apps get
// a NIP-07 window.nostr (see nostr-preload.cjs), and apps connected over
// NIP-46 (electron/bunker.mts) ask the same questions; their calls are relayed
// here, to the shell renderer, which decides on them and signs with the
// signed-in account's signer. This is the ONLY bridge that serves the user's
// signer, so it must never be attached to a <webview> - only the shell (see
// the header note above).
expose('nostrHost', {
  /**
   * Subscribe to requests. Returns an unsubscribe fn.
   * @param {(request: unknown) => void} callback
   */
  onRequest: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {unknown} request */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('nostr-bridge:request', listener);
    return () => ipcRenderer.removeListener('nostr-bridge:request', listener);
  },

  /**
   * Subscribe to requests main gave up on (timed out, or their page went away).
   * @param {(requestId: number) => void} callback
   */
  onCancel: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {number} requestId */
    const listener = (_event, requestId) => callback(requestId);
    ipcRenderer.on('nostr-bridge:cancel', listener);
    return () => ipcRenderer.removeListener('nostr-bridge:cancel', listener);
  },

  /**
   * Subscribe to a guest's page going away (navigated or closed).
   * @param {(wcId: number) => void} callback
   */
  onPageChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {number} wcId */
    const listener = (_event, wcId) => callback(wcId);
    ipcRenderer.on('nostr-bridge:page-changed', listener);
    return () => ipcRenderer.removeListener('nostr-bridge:page-changed', listener);
  },

  /**
   * Answer a relayed request: { requestId, ok, result?, error?, remember? }.
   * @param {{ requestId: number, ok: boolean, result?: unknown, error?: string, remember?: unknown }} response
   */
  respond: (response) => ipcRenderer.send('nostr-bridge:response', response),

  /** Tell every page with window.nostr that the account changed. */
  accountChanged: () => ipcRenderer.send('nostr-bridge:account-changed'),
});

// Din as a remote signer (window.dinos.bunkerHost), backed by electron/bunker.mts:
// the connections apps make to the user's account over NIP-46.
expose('bunkerHost', {
  list: () => ipcRenderer.invoke('bunker:list'),
  /** @param {{ account: string, relays: string[] }} options */
  create: (options) => ipcRenderer.invoke('bunker:create', options),
  /** @param {string} uri */
  parse: (uri) => ipcRenderer.invoke('bunker:parse', uri),
  /** @param {{ account: string, uri: string }} options */
  accept: (options) => ipcRenderer.invoke('bunker:accept', options),
  /** @param {string} id */
  remove: (id) => ipcRenderer.invoke('bunker:remove', id),
  /** @param {{ id: string, method: string, kind?: number }} options */
  revoke: (options) => ipcRenderer.invoke('bunker:revoke', options),
  /**
   * Subscribe to the connection list changing. Returns an unsubscribe fn.
   * @param {(connections: unknown) => void} callback
   */
  onChange: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {unknown} connections */
    const listener = (_event, connections) => callback(connections);
    ipcRenderer.on('bunker:changed', listener);
    return () => ipcRenderer.removeListener('bunker:changed', listener);
  },
  /**
   * Subscribe to nostrconnect:// links opened in a page. Returns an unsubscribe fn.
   * @param {(uri: string) => void} callback
   */
  onLink: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {string} uri */
    const listener = (_event, uri) => callback(uri);
    ipcRenderer.on('bunker:link', listener);
    return () => ipcRenderer.removeListener('bunker:link', listener);
  },
});

// Highlight bridge host (window.dinos.highlightHost), backed by the din-highlight:*
// handlers in main.mts. A browser tab's NIP-84 highlight click (see
// browser-highlight-preload.cjs) is relayed here, to the shell renderer, where
// HighlightBridgeHost shows it to the user to review and comment on, then
// publishes a kind 9802 event with the signed-in account's signer. Unlike
// nostrHost this carries no arbitrary signing surface - only
// { url, title, text, context } for a fixed highlight kind.
expose('highlightHost', {
  /**
   * Subscribe to highlight-publish requests relayed from browser tabs. The
   * callback receives { requestId, url, title, text, context }. Returns an
   * unsubscribe fn.
   * @param {(request: { requestId: number, url: string, title?: string, text: string, context?: string }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, url: string, title?: string, text: string, context?: string }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('din-highlight:request', listener);
    return () => ipcRenderer.removeListener('din-highlight:request', listener);
  },

  /**
   * Answer a relayed highlight request: { requestId, ok, result?, error? }.
   * A cancelled highlight is ok with no result.
   * @param {{ requestId: number, ok: boolean, result?: unknown, error?: string }} response
   */
  respond: (response) => ipcRenderer.send('din-highlight:response', response),
});

// nsite resolution host (window.dinos.nsiteHost), backed by the nsite:* handlers in
// main.mts. The nsite:// protocol handler needs Nostr lookups - NIP-19
// decoding and a relay query for the NIP-5A manifest - and
// the main process has no Nostr client, so each lookup is relayed here, to the
// shell renderer, where Nostrify and the user's relay list live (see
// NsiteBridgeHost). This carries no signing surface: it only turns a URL into
// a manifest or a redirect.
expose('nsiteHost', {
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

// The OS-level nsite store (window.dinos.nsiteStore), backed by the nsite:* handlers
// in electron/nsite.mts: the signed manifests of the sites Din has opened, and
// which of them are installed as apps. Hosts are always canonical
// (`npub1…` or `<pubkeyB36><dtag>`); main rejects anything else.
expose('nsiteStore', {
  /** Summaries of every installed site. */
  installed: () => ipcRenderer.invoke('nsite:installed'),
  /**
   * The stored summary of one site, installed or visited, or null.
   * @param {string} host
   */
  info: (host) => ipcRenderer.invoke('nsite:info', host),
  /**
   * Install a site and download all of its files.
   * @param {string} host
   */
  install: (host) => ipcRenderer.invoke('nsite:install', host),
  /** @param {string} host */
  uninstall: (host) => ipcRenderer.invoke('nsite:uninstall', host),
  /**
   * One file of a stored site, hash-verified, or null.
   * @param {string} host
   * @param {string} filePath
   */
  read: (host, filePath) => ipcRenderer.invoke('nsite:read', host, filePath),
  /**
   * Store how a site presents itself as an app.
   * @param {string} host
   * @param {{ from: string, name: string | null, icon: string | null, favicon?: string | null, themeColor: string | null, nostr?: { path: string, kinds: number[] | null } | null }} info
   */
  setAppInfo: (host, info) => ipcRenderer.invoke('nsite:setAppInfo', host, info),
  /**
   * A stored site changed (installed, updated, uninstalled, app info).
   * Returns an unsubscribe fn.
   * @param {(event: { host: string }) => void} callback
   */
  onChanged: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, payload: { host: string }) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('nsite:changed', listener);
    return () => ipcRenderer.removeListener('nsite:changed', listener);
  },
  /**
   * Download progress while a site installs. Returns an unsubscribe fn.
   * @param {(event: { host: string, done: number, total: number }) => void} callback
   */
  onProgress: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, payload: { host: string, done: number, total: number }) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('nsite:progress', listener);
    return () => ipcRenderer.removeListener('nsite:progress', listener);
  },
});

// The napp runtime's side of installed nsites (window.dinos.nappHost), backed by
// the napp:* handlers in electron/napp.mts: what an app has set up on this
// computer, its ENV, clearing its data, and its service worker asking for its
// window. Hosts are canonical; main rejects anything else.
expose('nappHost', {
  /**
   * An app's ENV, how many push subscriptions it holds, and its periodic sync tags.
   * @param {string} host
   */
  status: (host) => ipcRenderer.invoke('napp:status', host),
  /**
   * Replace an app's ENV (read by its pages the next time they load).
   * @param {string} host
   * @param {Record<string, string>} env
   */
  setEnv: (host, env) => ipcRenderer.invoke('napp:setEnv', host, env),
  /**
   * Forget everything an app keeps outside its files: storage, service
   * worker, subscriptions, notifications, ENV and permissions.
   * @param {string} host
   */
  clearData: (host) => ipcRenderer.invoke('napp:clearData', host),
  /**
   * An app's worker opened or focused its window, after a click on one of
   * its notifications. Returns an unsubscribe fn.
   * @param {(request: { host: string, url: string | null }) => void} callback
   */
  onOpen: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, payload: { host: string, url: string | null }) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('napp:open', listener);
    return () => ipcRenderer.removeListener('napp:open', listener);
  },
});

// What apps, nsites and web apps do while they're closed (window.dinos.periodicSync),
// backed by the periodic-sync:* handlers in electron/periodic-sync.mts: their
// schedules, for Settings → Background Activity and `din background`.
expose('periodicSync', {
  /** Whether anything runs at all, and every app's schedule. */
  status: () => ipcRenderer.invoke('periodic-sync:status'),
  /**
   * The global switch.
   * @param {boolean} enabled
   */
  setEnabled: (enabled) => ipcRenderer.invoke('periodic-sync:setEnabled', enabled),
  /**
   * Keep an app's schedule without running it, or run it again.
   * @param {string} origin
   * @param {boolean} paused
   */
  setPaused: (origin, paused) => ipcRenderer.invoke('periodic-sync:setPaused', origin, paused),
  /**
   * Run an app's tags now (one, or all of them), paused or not; resolves with how each went.
   * @param {string} origin
   * @param {string} [tag]
   */
  run: (origin, tag) => ipcRenderer.invoke('periodic-sync:run', origin, tag),
  /**
   * Drop an app's schedule; a site that asked the user will ask again.
   * @param {string} origin
   */
  remove: (origin) => ipcRenderer.invoke('periodic-sync:remove', origin),
  /**
   * Drop an app's schedule as it's uninstalled (nothing if it had none).
   * @param {string} origin
   */
  forget: (origin) => ipcRenderer.invoke('periodic-sync:forget', origin),
  /**
   * The status changed. Returns an unsubscribe fn.
   * @param {() => void} callback
   */
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('periodic-sync:changed', listener);
    return () => ipcRenderer.removeListener('periodic-sync:changed', listener);
  },
});

// Websites' Web Push (window.dinos.webPushHost), backed by the web-push:* handlers
// in electron/web-push.mts: the push service and its state for Settings, and
// a site's service worker asking for a window after a click on one of its
// notifications.
expose('webPushHost', {
  /** The push service: its URL, the default's, whether it's connected, and how many subscriptions it holds. */
  status: () => ipcRenderer.invoke('web-push:status'),
  /**
   * Use another push service (null: the default). Every subscription is
   * dropped; sites hear so and subscribe again.
   * @param {string | null} url
   */
  setServer: (url) => ipcRenderer.invoke('web-push:setServer', url),
  /**
   * The status changed. Returns an unsubscribe fn.
   * @param {() => void} callback
   */
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('web-push:changed', listener);
    return () => ipcRenderer.removeListener('web-push:changed', listener);
  },
  /**
   * A worker opened a window (clients.openWindow), in the installed app the
   * URL belongs to or a browser tab. Returns an unsubscribe fn.
   * @param {(request: { url: string }) => void} callback
   */
  onOpen: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, payload: { url: string }) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('web-push:open', listener);
    return () => ipcRenderer.removeListener('web-push:open', listener);
  },
  /**
   * A worker focused one of its pages (WindowClient.focus). Returns an unsubscribe fn.
   * @param {(request: { webContentsId: number }) => void} callback
   */
  onFocus: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, payload: { webContentsId: number }) => void} */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('web-push:focus', listener);
    return () => ipcRenderer.removeListener('web-push:focus', listener);
  },
});

// File-picker bridge host (window.dinos.filePickerHost), backed by the filepicker:*
// handlers in main.mts. A native <input type=file> click inside a browser or
// web-app guest is intercepted over CDP and relayed here, to the shell
// renderer, where FilePickerBridgeHost opens the in-Din FilePickerDialog and
// answers with the chosen absolute path (or null on cancel). The page never
// supplies the path - it only triggers the request. Native apps' Open and
// Save dialogs come the same way, from the desktop portal (file-chooser.mts).
expose('filePickerHost', {
  /**
   * Subscribe to relayed file-chooser requests. The callback receives
   * { requestId, origin, multiple?, options? } - `options` for a native
   * app's dialog, through the desktop portal (see file-chooser.mts).
   * Returns an unsubscribe fn.
   * @param {(request: { requestId: number, origin: string, multiple?: boolean, options?: unknown }) => void} callback
   */
  onRequest: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number, origin: string, multiple?: boolean, options?: unknown }} request
     */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('filepicker:request', listener);
    // A fresh shell has no picker open, whatever the last one was showing.
    ipcRenderer.send('filepicker:ready');
    return () => ipcRenderer.removeListener('filepicker:request', listener);
  },

  /**
   * Subscribe to requests withdrawn before the user answered (the app gave
   * up). Returns an unsubscribe fn.
   * @param {(requestId: number) => void} callback
   */
  onCancel: (callback) => {
    /**
     * @param {Electron.IpcRendererEvent} _event
     * @param {{ requestId: number }} message
     */
    const listener = (_event, message) => callback(message.requestId);
    ipcRenderer.on('filepicker:cancel', listener);
    return () => ipcRenderer.removeListener('filepicker:cancel', listener);
  },

  /**
   * Answer a relayed request: { requestId, path, paths, filter } where path
   * is the (first) chosen absolute path and paths all of them, or null when
   * the user cancelled; filter is the index of the file type in use.
   * @param {{ requestId: number, path: string | null, paths?: string[] | null, filter?: number | null }} response
   */
  respond: (response) => ipcRenderer.send('filepicker:response', response),
});

/**
 * A question the main process needs the user to answer.
 * @typedef {(
 *   { requestId: number, kind: 'permission', origin: string, capabilities: string[], remembered: boolean } |
 *   { requestId: number, kind: 'extension-install', name: string, permissions: string[], hostPermissions: string[] }
 * )} ShellPromptRequest
 */

// Prompt host (window.dinos.promptHost), backed by the prompt:* handlers in main.mts.
// A site asking for the camera/microphone/location/notifications, or the Chrome
// Web Store asking to install an extension, is surfaced here so PromptHost can
// ask the user. Unanswered prompts time out in main (and arrive here as a
// cancel) as "no".
expose('promptHost', {
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
   * Answer a prompt. `dismissed` marks a "no" the user didn't choose (Escape,
   * a click outside), which a site permission doesn't remember as a Block.
   * @param {{ requestId: number, allow: boolean, dismissed?: boolean }} response
   */
  respond: (response) => ipcRenderer.send('prompt:response', response),
});

// Screen sharing (window.dinos.screenShare), backed by electron/screen-share.mts.
// A page's getDisplayMedia() arrives as a pick for ScreenSharePicker, and the
// shares running are listed for the menu bar, which can stop them.
expose('screenShare', {
  /**
   * Subscribe to picks. Returns an unsubscribe fn.
   * @param {(request: unknown) => void} callback
   */
  onPick: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, request: unknown) => void} */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('screen-share:pick', listener);
    return () => ipcRenderer.removeListener('screen-share:pick', listener);
  },

  /**
   * Subscribe to picks main has given up on (timed out). Returns an
   * unsubscribe fn.
   * @param {(requestId: number) => void} callback
   */
  onCancel: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, d: { requestId: number }) => void} */
    const listener = (_event, d) => callback(d.requestId);
    ipcRenderer.on('screen-share:cancel', listener);
    return () => ipcRenderer.removeListener('screen-share:cancel', listener);
  },

  /**
   * Answer a pick: a source id, or null to refuse.
   * @param {{ requestId: number, sourceId: string | null, audio: boolean }} response
   */
  choose: (response) => ipcRenderer.send('screen-share:choice', response),

  /** The shares running now. */
  list: () => ipcRenderer.invoke('screen-share:list'),

  /**
   * Subscribe to the shares running. Returns an unsubscribe fn.
   * @param {(shares: unknown[]) => void} callback
   */
  onActive: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, shares: unknown[]) => void} */
    const listener = (_event, shares) => callback(shares);
    ipcRenderer.on('screen-share:active', listener);
    return () => ipcRenderer.removeListener('screen-share:active', listener);
  },

  /**
   * Stop a share.
   * @param {string} id
   */
  stop: (id) => ipcRenderer.invoke('screen-share:stop', id),
});

// Screen recording (window.dinos.screenRecorder), backed by
// electron/screen-recorder.mts: one recording at a time, kept by main, so the
// Screenshot app, the menu bar and `din screenshot record` all see the same one.
expose('screenRecorder', {
  /** Whether recording is available, and the recording running. */
  status: () => ipcRenderer.invoke('screen-recorder:status'),

  /**
   * Start recording.
   * @param {{ region?: { x: number, y: number, width: number, height: number }, audio?: string, path?: string }} request
   */
  start: (request) => ipcRenderer.invoke('screen-recorder:start', request),

  /** Stop recording; resolves with the saved file, or null when none was running. */
  stop: () => ipcRenderer.invoke('screen-recorder:stop'),

  /**
   * Subscribe to the recorder's status. Returns an unsubscribe fn.
   * @param {(status: unknown) => void} callback
   */
  onState: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, status: unknown) => void} */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('screen-recorder:state', listener);
    return () => ipcRenderer.removeListener('screen-recorder:state', listener);
  },

  /**
   * Subscribe to recordings ending, asked to or not. Returns an unsubscribe fn.
   * @param {(finished: unknown) => void} callback
   */
  onFinished: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, finished: unknown) => void} */
    const listener = (_event, finished) => callback(finished);
    ipcRenderer.on('screen-recorder:finished', listener);
    return () => ipcRenderer.removeListener('screen-recorder:finished', listener);
  },
});

// Studio's takes and live streams (window.dinos.capture), backed by
// electron/capture.mts. Studio itself reaches it over its own port
// (din.system.capture); the desktop has it for the menu bar's recording and
// live indicators and for `din studio`.
/** @type {Record<string, (...args: unknown[]) => Promise<unknown>>} */
const capture = {};
for (const method of [
  'status', 'pointer', 'pointerImage', 'takes', 'take', 'rename', 'begin', 'end', 'open', 'write', 'close', 'transcribe',
  'destinations', 'saveDestination', 'removeDestination', 'streamStart', 'streamStop',
]) {
  capture[method] = (...args) => ipcRenderer.invoke(`capture:${method}`, ...args);
}
expose('capture', {
  ...capture,
  /** @param {Uint8Array} data */
  streamWrite: (data) => ipcRenderer.send('capture:streamWrite', data),
  /**
   * Where the pointer is, in CSS pixels of the desktop, for main to tell
   * Studio (Electron can't see it on Wayland); only while onReportPointer asks.
   * @param {number} x
   * @param {number} y
   */
  pointerAt: (x, y) => ipcRenderer.send('capture:pointerAt', x, y),
  /** @param {() => void} callback */
  onReportPointer: (callback) => listen('capture:reportPointer', callback),
  /** @param {(state: unknown) => void} callback */
  onState: (callback) => listen('capture:state', callback),
  /** @param {(take: unknown) => void} callback */
  onChanged: (callback) => listen('capture:changed', callback),
  /** @param {(ended: unknown) => void} callback */
  onStreamEnded: (callback) => listen('capture:streamEnded', callback),
});

// Media playing in web pages and native apps (window.dinos.media), backed by
// electron/media.mts, for the volume menu's media controls.
// Power mode in web pages (see electron/power-mode.mts / src/lib/powerMode.ts).
expose('powerMode', {
  /**
   * Switch it on or off in web pages.
   * @param {boolean} on
   */
  set: (on) => ipcRenderer.invoke('power-mode:set', on),

  /**
   * Hear keys typed in web pages while it's on: where the caret is in the
   * page (CSS pixels, and the page's width in them) and the text's color.
   * Returns an unsubscribe fn.
   * @param {(typed: { wcId: number, x: number, y: number, width: number, color: string }) => void} callback
   */
  onTyped: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, typed: { wcId: number, x: number, y: number, width: number, color: string }) => void} */
    const listener = (_event, typed) => callback(typed);
    ipcRenderer.on('power-mode:typed', listener);
    return () => ipcRenderer.removeListener('power-mode:typed', listener);
  },
});

expose('media', {
  /** What's playing (or paused) now. */
  list: () => ipcRenderer.invoke('media:list'),

  /**
   * Subscribe to what's playing. Returns an unsubscribe fn.
   * @param {(sources: unknown[]) => void} callback
   */
  onChange: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, sources: unknown[]) => void} */
    const listener = (_event, sources) => callback(sources);
    ipcRenderer.on('media:sources', listener);
    return () => ipcRenderer.removeListener('media:sources', listener);
  },

  /**
   * Play, pause, or skip a source.
   * @param {string} id
   * @param {'play' | 'pause' | 'nexttrack' | 'previoustrack'} action
   */
  control: (id, action) => ipcRenderer.invoke('media:control', id, action),

  /**
   * Subscribe to the media keys (play/pause, next, previous, stop). Returns
   * an unsubscribe fn.
   * @param {(key: string) => void} callback
   */
  onKey: (callback) => {
    /** @type {(event: Electron.IpcRendererEvent, key: string) => void} */
    const listener = (_event, key) => callback(key);
    ipcRenderer.on('media:key', listener);
    return () => ipcRenderer.removeListener('media:key', listener);
  },
});

// Apps bridge (window.dinos.apps): hosting built-in apps at din://<id>/
// (electron/din-apps.mts, docs/dinos/README.md). Each app window's port to
// the desktop arrives here; a port can't cross contextBridge, so it goes to
// the page as a window message (src/lib/dinApps.ts listens for it).
ipcRenderer.on('dinos-apps:port', (event, info) => {
  window.postMessage({ type: 'dinos-apps:port', info }, location.origin, [event.ports[0]]);
});

expose('apps', {
  /**
   * Have main open a port from an app straight to a system bridge.
   * @param {number} webContentsId
   * @param {string} permission
   * @param {{ path: string, writable: boolean }[]} [roots] for fs, the folders it's scoped to (none: the whole filesystem)
   * @returns {Promise<string | null>} for fs, the URL base the app loads files by path from
   */
  grant: (webContentsId, permission, roots) => ipcRenderer.invoke('dinos-apps:grant', webContentsId, permission, roots),
  /**
   * Grant an app window `background`: its page may give the app a schedule
   * (registration.periodicSync), and, with `notifications`, its worker may
   * notify (electron/din-app-workers.mts).
   * @param {number} webContentsId
   * @param {{ notifications: boolean }} options
   * @returns {Promise<void>}
   */
  grantBackground: (webContentsId, options) => ipcRenderer.invoke('dinos-apps:grantBackground', webContentsId, options),
  /**
   * An app's service worker opened a window (clients.openWindow: `url`) or
   * focused one (WindowClient.focus: `focus`), after a click on one of its
   * notifications. Returns an unsubscribe fn.
   * @param {(request: { appId: string, url: string | null, focus: boolean }) => void} callback
   * @returns {() => void}
   */
  onWorkerOpen: (callback) => {
    /** @param {unknown} _event @param {{ appId: string, url: string | null, focus: boolean }} request */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('din-app-sw:open', listener);
    return () => ipcRenderer.removeListener('din-app-sw:open', listener);
  },
  /**
   * Another folder an app's scoped fs grant reaches.
   * @param {number} webContentsId
   * @param {string} root
   * @param {boolean} writable
   * @returns {Promise<void>}
   */
  addFsRoot: (webContentsId, root, writable) => ipcRenderer.invoke('dinos-apps:addFsRoot', webContentsId, root, writable),
  /**
   * Whether an app's fs grant reaches each path (to write it, with `write`).
   * @param {number} webContentsId
   * @param {string[]} paths
   * @param {boolean} write
   * @returns {Promise<boolean[]>}
   */
  reaches: (webContentsId, paths, write) => ipcRenderer.invoke('dinos-apps:reaches', webContentsId, paths, write),
  /**
   * Each path as it resolves now (its links followed), whether it's Din's
   * own, which no app may reach, and whether it's a folder holding home or
   * Din's own files.
   * @param {string[]} paths
   * @returns {Promise<{ real: string, protected: boolean, holds: boolean }[]>}
   */
  resolve: (paths) => ipcRenderer.invoke('dinos-apps:resolve', paths),
  /**
   * Milliseconds since the user last pressed a key or clicked in an app window, or null.
   * @param {number} webContentsId
   * @returns {Promise<number | null>}
   */
  sinceInput: (webContentsId) => ipcRenderer.invoke('dinos-apps:sinceInput', webContentsId),
  /**
   * Close that port.
   * @param {number} webContentsId
   * @param {string} permission
   * @returns {Promise<void>}
   */
  revoke: (webContentsId, permission) => ipcRenderer.invoke('dinos-apps:revoke', webContentsId, permission),
  /**
   * A URL an app window can stream a file from (din-file://<token>/…), good
   * while that window's page stays loaded.
   * @param {number} webContentsId
   * @param {string} path
   * @returns {Promise<string>}
   */
  fileUrl: (webContentsId, path) => ipcRenderer.invoke('dinos-apps:fileUrl', webContentsId, path),
  /**
   * Force quit an app window: kill its renderer process.
   * @param {number} webContentsId
   * @returns {Promise<void>}
   */
  kill: (webContentsId) => ipcRenderer.invoke('dinos-apps:kill', webContentsId),
  /**
   * Hear when an app window stops or starts answering (main's unresponsive).
   * @param {(e: { webContentsId: number, responsive: boolean }) => void} callback
   * @returns {() => void}
   */
  onResponsive: (callback) => {
    /** @param {unknown} _event @param {{ webContentsId: number, responsive: boolean }} e */
    const listener = (_event, e) => callback(e);
    ipcRenderer.on('dinos-apps:responsive', listener);
    return () => ipcRenderer.removeListener('dinos-apps:responsive', listener);
  },
  /**
   * Open a folder as an app: serve it at din+file://<host>/ and watch it
   * (electron/din-file-apps.mts).
   * @param {string} path absolute
   * @returns {Promise<{ appId: string, path: string, manifest: unknown }>} its manifest as found, untrusted
   */
  folder: (path) => ipcRenderer.invoke('dinos-apps:folder', path),
  /**
   * Stop serving and watching a folder's app.
   * @param {string} appId
   * @returns {Promise<void>}
   */
  closeFolder: (appId) => ipcRenderer.invoke('dinos-apps:closeFolder', appId),
  /**
   * Hear when a file in a folder opened as an app changes.
   * @param {(e: { appId: string }) => void} callback
   * @returns {() => void}
   */
  onFolderChanged: (callback) => {
    /** @param {unknown} _event @param {{ appId: string }} e */
    const listener = (_event, e) => callback(e);
    ipcRenderer.on('dinos-apps:folderChanged', listener);
    return () => ipcRenderer.removeListener('dinos-apps:folderChanged', listener);
  },
});

// Widgets bridge (window.dinos.widgets): desktop widgets at widget://<id>/,
// napplet://<hash>/ and widget+file://<hash>/ (electron/widgets.mts, docs/widgets.md). Their ports
// arrive as window messages, like apps' (src/lib/widgets.ts listens).
ipcRenderer.on('dinos-widgets:port', (event, info) => {
  window.postMessage({ type: 'dinos-widgets:port', info }, location.origin, [event.ports[0]]);
});

expose('widgets', {
  /**
   * Fetch a widget from Nostr by its artifact's sha256, verify and keep it.
   * @param {string} sha256
   * @param {string[]} servers Blossom servers to try, in order
   * @returns {Promise<string>} the napplet:// host it's served at
   */
  fetch: (sha256, servers) => ipcRenderer.invoke('dinos-widgets:fetch', sha256, servers),
  /**
   * A widget's icon, by hash from its manifest's Blossom servers, verified.
   * @param {string} sha256
   * @param {string[]} servers
   * @returns {Promise<Uint8Array>}
   */
  icon: (sha256, servers) => ipcRenderer.invoke('dinos-widgets:icon', sha256, servers),
  /**
   * Download something from the web for a widget (NAP-RESOURCE): https, public addresses, no cookies.
   * @param {string} url
   * @returns {Promise<{ bytes: Uint8Array, type: string }>}
   */
  resource: (url) => ipcRenderer.invoke('dinos-widgets:resource', url),
  /**
   * Open a folder as a widget: serve it at widget+file://<host>/ and watch it.
   * @param {string} path absolute
   * @returns {Promise<{ host: string, path: string, html: string }>} its page, as it runs (inlined)
   */
  folder: (path) => ipcRenderer.invoke('dinos-widgets:folder', path),
  /**
   * Hear when a folder opened as a widget changes.
   * @param {(e: { host: string }) => void} callback
   * @returns {() => void}
   */
  onFolderChanged: (callback) => {
    /** @param {unknown} _event @param {{ host: string }} e */
    const listener = (_event, e) => callback(e);
    ipcRenderer.on('dinos-widgets:changed', listener);
    return () => ipcRenderer.removeListener('dinos-widgets:changed', listener);
  },
  /**
   * Hear right-clicks in widgets outside text fields, at a point in the widget.
   * @param {(e: { webContentsId: number, x: number, y: number }) => void} callback
   * @returns {() => void}
   */
  onContextMenu: (callback) => {
    /** @param {unknown} _event @param {{ webContentsId: number, x: number, y: number }} e */
    const listener = (_event, e) => callback(e);
    ipcRenderer.on('dinos-widgets:contextMenu', listener);
    return () => ipcRenderer.removeListener('dinos-widgets:contextMenu', listener);
  },
});

// Launch bridge (window.dinos.launch): apps the `din` command runs from a
// folder or a dev server (electron/din-launch.mts, src/lib/launchedApps.ts).
expose('launch', {
  /**
   * Hear launches: open a window for each, then answer with opened().
   * @param {(request: unknown) => void} callback
   * @returns {() => void}
   */
  onOpen: (callback) => {
    /** @param {unknown} _event @param {unknown} request */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('dinos-launch:open', listener);
    return () => ipcRenderer.removeListener('dinos-launch:open', listener);
  },
  /**
   * Hear that a launch's command went away (Ctrl-C): close its window.
   * @param {(launchId: string) => void} callback
   * @returns {() => void}
   */
  onClose: (callback) => {
    /** @param {unknown} _event @param {string} launchId */
    const listener = (_event, launchId) => callback(launchId);
    ipcRenderer.on('dinos-launch:close', listener);
    return () => ipcRenderer.removeListener('dinos-launch:close', listener);
  },
  /**
   * A launch's window is open, or (with an error) won't be.
   * @param {string} launchId
   * @param {string | null} error
   * @returns {Promise<void>}
   */
  opened: (launchId, error) => ipcRenderer.invoke('dinos-launch:opened', launchId, error),
  /**
   * A launch's window closed.
   * @param {string} launchId
   * @returns {Promise<void>}
   */
  ended: (launchId) => ipcRenderer.invoke('dinos-launch:ended', launchId),
  /**
   * A launched app's last window closed: main may forget it.
   * @param {string} appId
   * @returns {Promise<void>}
   */
  release: (appId) => ipcRenderer.invoke('dinos-launch:release', appId),
  /**
   * Hear `din widgets add-folder`: a folder's widget to offer, then answer with widgetAnswer().
   * @param {(offer: unknown) => void} callback
   * @returns {() => void}
   */
  onWidget: (callback) => {
    /** @param {unknown} _event @param {unknown} offer */
    const listener = (_event, offer) => callback(offer);
    ipcRenderer.on('dinos-launch:widget', listener);
    return () => ipcRenderer.removeListener('dinos-launch:widget', listener);
  },
  /**
   * Hear that an offer's command went away (Ctrl-C): stop asking.
   * @param {(offerId: string) => void} callback
   * @returns {() => void}
   */
  onWidgetCancel: (callback) => {
    /** @param {unknown} _event @param {string} offerId */
    const listener = (_event, offerId) => callback(offerId);
    ipcRenderer.on('dinos-launch:widget-cancel', listener);
    return () => ipcRenderer.removeListener('dinos-launch:widget-cancel', listener);
  },
  /**
   * Where an offer is: asking the user, added, or failed (with why).
   * @param {string} offerId
   * @param {'asking' | 'added' | 'failed'} state
   * @param {string} [message]
   * @returns {Promise<void>}
   */
  widgetAnswer: (offerId, state, message) => ipcRenderer.invoke('dinos-launch:widget-answer', offerId, state, message),
});

// Command bridge (window.dinos.commands): `din <area> <command>` from a
// shell, run by the desktop's command registry (electron/din-launch.mts,
// src/lib/commands/, CommandHost).
expose('commands', {
  /**
   * Hear commands: say taken() at once, then answer().
   * @param {(request: unknown) => void} callback
   * @returns {() => void}
   */
  onRun: (callback) => {
    /** @param {unknown} _event @param {unknown} request */
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('dinos-command:run', listener);
    return () => ipcRenderer.removeListener('dinos-command:run', listener);
  },
  /**
   * The desktop has a command, and is running it.
   * @param {string} id
   * @returns {Promise<void>}
   */
  taken: (id) => ipcRenderer.invoke('dinos-command:taken', id),
  /**
   * How a command still running is getting on.
   * @param {string} id
   * @param {{ text: string, percent?: number }} update
   * @returns {Promise<void>}
   */
  progress: (id, update) => ipcRenderer.invoke('dinos-command:progress', id, update),
  /**
   * A command's answer.
   * @param {string} id
   * @param {unknown} answer
   * @returns {Promise<void>}
   */
  answer: (id, answer) => ipcRenderer.invoke('dinos-command:answer', id, answer),
});

contextBridge.exposeInMainWorld('dinos', dinos);
