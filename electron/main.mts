// Electron host for the Din desktop environment.
//
// Serves the built Vite app (dist/) over a custom app:// protocol instead of
// file:// so that:
//   - the shell gets a real origin (CSP 'self', BrowserRouter, fetch all work)
//   - unknown paths fall back to index.html (SPA routing)
//
// Set DIN_DEV_URL (e.g. http://localhost:8080) to load a Vite dev server
// (with HMR) instead of the bundled dist/. See `npm run dev`.
//
// This file runs as TypeScript directly via Node's native type stripping
// (Electron 43 embeds Node 24) - no build step, so only erasable TS syntax.

// First: it records every IPC handler as it's registered, for apps' bridge
// ports (electron/din-apps.mts).
import './ipc-registry.mts';
import { ptyRoutes } from './pty-routes.mts';
import { allowCameraThroughPortal, PIPEWIRE_CAMERA_FEATURE } from './camera-portal.mts';
import {
  appIdOf,
  attachAppGuest,
  DIN_APPS_PARTITION,
  DIN_FILE_SCHEME,
  DIN_SCHEME,
  appsSession,
  forwardPushToGrants,
  backgroundGrant,
  isAppGuest as isDinAppGuest,
  isBridgeEvent,
  registerDinApps,
} from './din-apps.mts';
import { registerDinAppWorkers } from './din-app-workers.mts';
import { periodicSyncPermissionChanged, registerPeriodicSyncHandlers } from './periodic-sync.mts';
import {
  attachWidgetGuest,
  isWidgetGuest,
  NAPPLET_SCHEME,
  registerWidgets,
  WIDGET_FILE_SCHEME,
  WIDGET_SCHEME,
  widgetOf,
  WIDGETS_PARTITION,
} from './widgets.mts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { app, BrowserWindow, clipboard, ipcMain, protocol, net, session, webContents, screen, globalShortcut, Menu, MenuItem, nativeImage, nativeTheme } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { installChromeWebStore } from 'electron-chrome-web-store';
import { extensionAccess, registerBrowserExtensionHandlers } from './browser-extensions.mts';
import { DevtoolsBridge } from './devtools-bridge.mts';
import {
  registerUserscriptHandlers,
  attachUserscripts,
  isUserscriptInstallUrl,
} from './userscripts.mts';
import { attachAdblock, ensureAdblockEngine, isAdblockExtension, setupAdblock } from './adblock.mts';
import {
  attachPopups,
  justPressed,
  mayOpenWindow,
  popupAttached,
  popupAttaching,
  popupFeatures,
  setupPopups,
  topLevelResponse,
  windowOpened,
} from './popups.mts';
import {
  NSITE_SCHEME,
  registerNsiteProtocol,
  clearNsiteManifestCache,
  clearNsiteBlobCache,
} from './nsite.mts';
import { parseCanonicalHost } from './nsite-store.mts';
import { isProgram, registerNativeAppHandlers, runProgram, terminalAppCommand, terminalEnvironment } from './native-apps.mts';
import { registerNativeDisplayHandlers, sessionBusAddress } from './native-display.mts';
import { registerKeyboardHandlers } from './keyboard.mts';
import { registerDateTimeHandlers } from './datetime.mts';
import { refreshWifiProxy, registerVpnHandlers, registerWifiHandlers } from './network.mts';
import { isOnionProxyCertificate } from './onion-proxy.mts';
import { registerFirewallHandlers } from './firewall.mts';
import {
  isOnionUrl,
  keepTorSession,
  onionRequest,
  registerTorHandlers,
  secureOnionSites,
  torNetworkChanged,
} from './tor.mts';
import {
  attachSiteLocations,
  registerSiteLocationHandlers,
  responseHeader,
  siteLocationResponse,
} from './site-locations.mts';
import { registerCursorHandlers } from './cursor.mts';
import { registerMouseHandlers } from './mouse.mts';
import { registerAccessibilityHandlers } from './accessibility.mts';
import { holdDebugger, releaseDebugger } from './guest-debugger.mts';
import { registerIconThemeHandlers } from './icon-theme.mts';
import { registerInddHandlers } from './indd.mts';
import { registerMailHandlers } from './mail.mts';
import { registerPhoneHandlers } from './phone.mts';
import { registerQuickShareHandlers } from './quickshare.mts';
import { registerVmsHandlers } from './vms.mts';
import {
  ensureNightLightTool,
  nightLightStatus,
  setNightLightEnabled,
  setNightLightSchedule,
  setNightLightTemperature,
  startNightLight,
  stopNightLight,
  type NightLightState,
} from './night-light.mts';
import { registerTrayHandlers } from './tray.mts';
import { registerOpenUri } from './open-uri.mts';
import { attachLaunchedGuest, registerDinLaunch, serveLaunched } from './din-launch.mts';
import { registerDinFileApps } from './din-file-apps.mts';
import { registerNotificationHandlers } from './notifications.mts';
import { registerGeolocationHandlers } from './geolocation.mts';
import { forgetNappSite, nappPermissionChanged, registerNappHandlers } from './napp.mts';
import { forgetWebPushSubscriptions, registerWebPushHandlers, webPushPermissionChanged } from './web-push.mts';
import { watchDiskSpace } from './disk-space.mts';
import { watchLiveStick } from './live-stick.mts';
import { answerFileChooser, cancelFileChoosers, registerFileChooserPortal } from './file-chooser.mts';
import { isInstalling, registerInstallerHandlers } from './installer.mts';
import { registerBluetoothLoginHandlers } from './bluetooth-login.mts';
import { registerBluetoothHandlers } from './bluetooth.mts';
import { registerFeaturesHandlers } from './features.mts';
import { registerVolumesHandlers } from './volumes.mts';
import { cleanUpPrinting, printingNetworkChanged, registerPrintingHandlers, requestPagePrint } from './printing.mts';
import { registerSystemMonitorHandlers } from './system-monitor.mts';
import { registerNostrdHandlers } from './nostrd.mts';
import { registerBunkerHandlers } from './bunker.mts';
import { registerBootScreenHandlers } from './boot-screen.mts';
import { registerLockHandlers } from './lock.mts';
import { registerEraseHandlers } from './erase.mts';
import { registerPasswordsHandlers } from './passwords.mts';
import { registerAskpass } from './askpass.mts';
import { registerPolkitAgent } from './polkit-agent.mts';
import { isUpdating, registerUpdaterHandlers } from './updater.mts';
import { isFlashing, registerFirmwareHandlers } from './firmware.mts';
import { airplayDisplays, airplayNetworkChanged, registerAirPlayHandlers, switchAirPlayMode } from './airplay.mts';
import { registerSystemPackageHandlers } from './system-packages.mts';
import { registerLoginSessionHandlers } from './login-session.mts';
import { registerAssistantHandlers } from './assistant.mts';
import { registerDictationHandlers } from './dictation.mts';
import { allowScreenSharing, registerScreenShareHandlers } from './screen-share.mts';
import { registerEyeDropperHandlers } from './eyedropper.mts';
import { registerScreenRecorderHandlers, stopScreenRecording } from './screen-recorder.mts';
import { attachSelectionColor, setSelectionColor } from './selection-color.mts';
import { setNativeColorScheme, setNativePalette } from './gtk-theme.mts';
import { registerCaptureHandlers, stopCapture } from './capture.mts';
import { pauseAllMedia, registerMediaHandlers, watchMediaGuest } from './media.mts';
import { registerPowerModeHandlers } from './power-mode.mts';
import { CommandError, runCommand, watchCommand } from './system.mts';
import { LOCAL_FILE_SCHEME, registerFileOpsHandlers, registerLocalFileProtocol } from './files.mts';
import { registerProjectHandlers } from './project.mts';
import { startWatchdog } from './watchdog.mts';

// electron-chrome-context-menu ships CJS only, but exports the builder as a
// named export too, which Node's ESM-CJS interop resolves statically.
import { buildChromeContextMenu } from 'electron-chrome-context-menu';

// require.resolve for ensureBrowserActionPreload (no ESM equivalent).
const require = createRequire(import.meta.url);

/** An IPC event from either ipcMain.on or ipcMain.handle. */
type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;

/** Extract a message from an unknown catch-clause error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Locate the built Vite app. Two supported layouts:
//   - DinOS/Nix: main.mts and dist/ are installed side by side (dirname/dist)
//   - the checkout: main.mts lives in electron/, dist/ sits at the repo
//     root (dirname/../dist)
// DIN_DIST_DIR overrides both. (scripts/session.mjs's builds are laid out
// as DinOS's are.)
function resolveDistDir(): string {
  const candidates = [
    process.env.DIN_DIST_DIR,
    path.join(import.meta.dirname, 'dist'),
    path.join(import.meta.dirname, '..', 'dist'),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return path.resolve(dir);
  }
  // Nothing found: fall back to the colocated layout so paths/errors are sane.
  return path.join(import.meta.dirname, 'dist');
}

const DIST = resolveDistDir();
const INDEX = path.join(DIST, 'index.html');

// Must be called before app is ready. NOTE: each call to
// registerSchemesAsPrivileged REPLACES the full list, and importing
// electron-chrome-extensions above already registered the crx scheme
// (extension action icons) - so it must be re-declared here.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  {
    // Built-in apps (electron/din-apps.mts): an origin of their own each,
    // secure, fetchable and streamable, but none of the desktop's app:. A
    // service worker each, for work done while no window is open
    // (electron/din-app-workers.mts).
    scheme: DIN_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: true,
    },
  },
  {
    // Apps from folders (electron/din-file-apps.mts): the same as din:.
    scheme: DIN_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: true,
    },
  },
  {
    // Desktop widgets (electron/widgets.mts): a host page each, which only
    // ever frames the widget's own bytes in a srcdoc.
    scheme: WIDGET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    scheme: NAPPLET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    scheme: WIDGET_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
  {
    scheme: 'crx',
    privileges: {
      bypassCSP: true,
    },
  },
  {
    // NIP-5A static websites (electron/nsite.mts). Each site gets its own
    // origin, so it needs the full set of a web origin's powers: `standard`
    // for real origins and relative URLs, `secure` for a secure context
    // (crypto.subtle, service workers), `stream` + `supportFetchAPI` for
    // on-demand blob delivery and Range requests, and `allowServiceWorkers`
    // because published nsites ship one (Armada's /sw.js, for instance).
    scheme: NSITE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      allowServiceWorkers: true,
    },
  },
  {
    // Local files for the Files app's thumbnails and the Preview window
    // (electron/files.mts): fetchable, and streamable so video can seek.
    scheme: LOCAL_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// After a GPU reset, Chromium blocks WebGL for the pages it blames (or for
// every page, when it can't tell). Din is the whole desktop: losing WebGL
// leaves the Terminal on its DOM renderer until Din restarts.
app.disableDomainBlockingFor3DAPIs();

// Where Din is the desktop, cameras come from PipeWire (camera-portal.mts).
// That goes through the session bus: without one, Chromium would wait on it
// forever, and enumerateDevices with it, microphones included.
const hasSessionBus = !!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.startsWith('disabled:');
if (process.env.DIN_DESKTOP_SESSION === '1' && hasSessionBus) {
  app.commandLine.appendSwitch('enable-features', PIPEWIRE_CAMERA_FEATURE);
}

// safeStorage (Mail's passwords, the bunker's keys, Chromium's cookies) picks
// its Linux keyring by XDG_CURRENT_DESKTOP, and knows only the big desktops:
// for Din's own session ("Din", or nothing at all on DinOS) it would settle
// for basic_text, a key written into Chromium, and isEncryptionAvailable()
// says false. The login keyring is the Secret Service (gnome-keyring on
// DinOS), so it's libsecret, except under KDE, where Chromium's own choice
// of KWallet is right. An explicit --password-store wins.
if (
  process.platform === 'linux' &&
  !app.commandLine.hasSwitch('password-store') &&
  !/kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')
) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

// Each of Din's subsystems (shells, mail, push, askpass, printing, …) stops
// itself on will-quit, once: more than Node's default 10, and not a leak.
app.setMaxListeners(30);

startWatchdog();

/** Map a request pathname to a file inside dist/, with SPA fallback. */
function resolveFile(pathname: string): string {
  const candidate = path.normalize(path.join(DIST, decodeURIComponent(pathname)));

  // Path traversal guard: never serve anything outside dist/.
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) {
    return INDEX;
  }

  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // not a file -> SPA fallback
  }
  return INDEX;
}

// DIN_DEV_URL (e.g. http://localhost:8080) loads a live Vite dev server
// with HMR instead of the bundled dist/. In that mode we run a normal
// resizable window with DevTools rather than the production kiosk shell.
const DEV_URL = process.env.DIN_DEV_URL;

/**
 * The shell's own origin. The shell window may only ever show this origin
 * (see the navigation guard where the window is created), and the sender
 * guard below requires it, so a remote page can never inherit the shell
 * preload's privileged bridges.
 */
const SHELL_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : 'app://din';

// ---------------------------------------------------------------------------
// Filesystem bridge (window.dinos.fs - see preload.cjs / the Files app).
//
// Threat model: everything registered here is callable by any script running
// in the shell's origin, so an XSS in the shell gets this entire API. Since
// the bridge became write-capable, that means an XSS can persist (e.g. write
// shell rc files), not just read. Mitigations, in order of importance:
//   1. Strict CSP in the shell (script-src 'self') - the primary defense.
//   2. The sender guard below: only the shell window's main frame is
//      accepted; <webview> guests (arbitrary web content) are rejected.
//   3. The OS itself: the shell runs as an unprivileged user, so writes to
//      system paths (/nix/store, /etc, ...) fail with EACCES at the kernel
//      boundary. The bridge adds no privilege - it can only do what any
//      process of that user could.
//
// Performance notes: everything is async (libuv threadpool), directory
// listings stat all entries in parallel and are capped at MAX_DIR_ENTRIES,
// and file reads are capped at MAX_READ_BYTES unless the caller asks for more
// (an editor opening a document), so a stray click on a huge file can't
// balloon the renderer. Nothing reads more than MAX_READ_LIMIT.
// ---------------------------------------------------------------------------

const fsp = fs.promises;
const MAX_DIR_ENTRIES = 5000;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_READ_LIMIT = 1024 * 1024 * 1024;

// webContents.id of the shell window; set once the window is created. Used to
// reject IPC from any other web contents (e.g. <webview> guests).
let shellContentsId = -1;

/** Whether a request comes from the shell window's main frame, on the shell origin. */
function isShellSender(event: IpcEvent): boolean {
  // A call on a bridge port the shell granted an app, already checked against
  // the app's permission there (electron/din-apps.mts).
  if (isBridgeEvent(event)) return true;
  return (
    event.sender.id === shellContentsId &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.origin === SHELL_ORIGIN
  );
}

/** Throw unless the request comes from the shell window's main frame. */
function assertShellSender(event: IpcEvent): void {
  if (!isShellSender(event)) {
    throw new Error('fs bridge: unauthorized sender');
  }
}

/** Validate and normalize a caller-supplied absolute path. */
function normalizeAbsolute(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p)) {
    throw new Error('An absolute path is required');
  }
  return path.normalize(p);
}

type FileKind = 'directory' | 'file' | 'other';

/** Classify an fs.Stats as a directory, regular file, or other. */
function kindOf(stats: fs.Stats): FileKind {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/** Plain-object stat summary that survives structured clone. */
function statSummary(stats: fs.Stats): { kind: FileKind; size: number; mtimeMs: number } {
  return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
}

/** One rich directory entry as returned by fs:readdir. */
interface FsDirEntry {
  name: string;
  kind: FileKind;
  symlink: boolean;
  size: number | null;
  mtimeMs: number | null;
}

function registerFsHandlers(): void {
  ipcMain.handle('fs:homedir', (event) => {
    assertShellSender(event);
    return os.homedir();
  });

  ipcMain.handle('fs:stat', async (event, target) => {
    assertShellSender(event);
    return statSummary(await fsp.stat(normalizeAbsolute(target)));
  });

  ipcMain.handle('fs:readdir', async (event, dirPath) => {
    assertShellSender(event);
    const dir = normalizeAbsolute(dirPath);

    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const truncated = dirents.length > MAX_DIR_ENTRIES;
    const slice = truncated ? dirents.slice(0, MAX_DIR_ENTRIES) : dirents;

    const entries = await Promise.all(
      slice.map(async (dirent) => {
        const entry: FsDirEntry = {
          name: dirent.name,
          kind: dirent.isDirectory()
            ? 'directory'
            : dirent.isFile()
              ? 'file'
              : 'other',
          symlink: dirent.isSymbolicLink(),
          size: null,
          mtimeMs: null,
        };
        try {
          // stat() follows symlinks so links to directories browse correctly.
          const stats = await fsp.stat(path.join(dir, dirent.name));
          entry.kind = kindOf(stats);
          entry.size = stats.size;
          entry.mtimeMs = stats.mtimeMs;
        } catch {
          // Broken symlink or permission denied; keep dirent-level info.
        }
        return entry;
      }),
    );

    return { path: dir, entries, truncated };
  });

  ipcMain.handle('fs:readFile', async (event, filePath, maxBytes) => {
    assertShellSender(event);
    const file = normalizeAbsolute(filePath);
    const cap = Math.min(
      Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_READ_BYTES,
      MAX_READ_LIMIT,
    );

    const handle = await fsp.open(file, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('Not a regular file');
      const length = Math.min(stats.size, cap);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      // Buffers cross IPC as Uint8Array via structured clone (zero re-encode).
      return { data: buffer, size: stats.size, truncated: stats.size > length };
    } finally {
      await handle.close();
    }
  });

  ipcMain.handle('fs:writeFile', async (event, filePath, data) => {
    assertShellSender(event);
    const file = normalizeAbsolute(filePath);
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw new Error('writeFile data must be a string or Uint8Array');
    }
    await fsp.writeFile(file, data);
  });

  ipcMain.handle('fs:mkdir', async (event, dirPath) => {
    assertShellSender(event);
    await fsp.mkdir(normalizeAbsolute(dirPath), { recursive: true });
  });

  ipcMain.handle('fs:rename', async (event, from, to) => {
    assertShellSender(event);
    await fsp.rename(normalizeAbsolute(from), normalizeAbsolute(to));
  });

  ipcMain.handle('fs:copyFile', async (event, from, to) => {
    assertShellSender(event);
    await fsp.copyFile(normalizeAbsolute(from), normalizeAbsolute(to));
  });

  ipcMain.handle('fs:rm', async (event, target, options) => {
    assertShellSender(event);
    const p = normalizeAbsolute(target);
    if (p === '/') throw new Error('Refusing to remove /');
    const recursive = options !== null && typeof options === 'object'
      ? options.recursive === true
      : false;
    // Without `recursive`, directories must be empty (rmdir semantics) and
    // files unlink; never silently ignore missing paths (`force` stays off).
    await fsp.rm(p, { recursive });
  });
}

// ---------------------------------------------------------------------------
// PTY bridge (window.dinos.pty - see preload.cjs / the Terminal app).
//
// Gives the shell a real interactive terminal. Instead of node-pty (a native
// module we'd have to rebuild against Electron's ABI inside the Nix build),
// each session spawns pty-host.py: a stdlib-only Python helper that owns the
// pseudo-terminal and proxies bytes over pipes (stdin/stdout for terminal
// I/O, fd 3 for resize commands, fd 4 for "a command finished" events).
//
// Threat model: this is deliberately an arbitrary-command-execution API for
// the shell's origin, so it adds nothing beyond what the fs bridge already
// concedes (window.dinos.fs can write ~/.bashrc, which is code execution on the
// next login). The same boundaries apply: strict CSP, the sender guard, and
// the unprivileged OS user. The preload is never attached to <webview>s, so
// remote web content can't see it.
// ---------------------------------------------------------------------------

const PTY_HELPER = path.join(import.meta.dirname, 'pty-host.py');
const MAX_PTY_SESSIONS = 16;
const MAX_PTY_WRITE_BYTES = 1024 * 1024;

/** id -> ChildProcess running pty-host.py. */
const ptySessions = new Map<number, ChildProcess>();
let nextPtyId = 1;

/** Clamp a caller-supplied terminal dimension to something sane. */
function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(2, Math.floor(value)));
}

/** The login shell of the user we run as (best effort). */
function userShell(): string {
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch {
    // fall through
  }
  return process.env.SHELL || '/bin/sh';
}

function registerPtyHandlers(): void {
  ipcMain.handle('pty:spawn', async (event, size, cwd, appId) => {
    assertShellSender(event);
    if (ptySessions.size >= MAX_PTY_SESSIONS) {
      throw new Error(`Too many terminal sessions (max ${MAX_PTY_SESSIONS})`);
    }
    const rows = clampDimension(size?.rows, 24);
    const cols = clampDimension(size?.cols, 80);

    let spawnCwd =
      typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096 ? cwd : os.homedir();
    const env = await terminalEnvironment();

    // A Terminal=true app (htop, ...) runs in the pty instead of a shell.
    let argv = ['shell', userShell()];
    if (typeof appId === 'string') {
      const command = await terminalAppCommand(appId);
      argv = ['app', ...command.argv];
      spawnCwd = command.cwd;
      Object.assign(env, command.env);
    }

    const proc = spawn('python3', [PTY_HELPER, String(rows), String(cols), ...argv], {
      cwd: spawnCwd,
      env,
      // fd 3 is the helper's control channel (resize), fd 4 its events.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });

    const id = nextPtyId++;
    ptySessions.set(id, proc);
    const sender = event.sender;

    // A write can race the helper's exit (EPIPE); without handlers those
    // stream errors would be unhandled in the main process.
    proc.stdin?.on('error', () => {});
    proc.stdio[3]?.on('error', () => {});

    const send = (channel: string, ...args: unknown[]) => {
      // A pty handed to another window (electron/pty-routes.mts) talks there.
      const route = ptyRoutes.get(id);
      if (route) route(channel, ...args);
      else if (!sender.isDestroyed()) sender.send(channel, ...args);
    };

    proc.stdout?.on('data', (chunk) => send('pty:data', id, chunk));
    // Helper diagnostics (e.g. exec failures) surface in the terminal too.
    proc.stderr?.on('data', (chunk) => send('pty:data', id, chunk));
    const events = proc.stdio[4];
    if (events && 'read' in events) {
      createInterface({ input: events }).on('line', (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const { type, command, seconds } = (event ?? {}) as Record<string, unknown>;
        if (type === 'start' && typeof command === 'string') {
          send('pty:commandStart', id, command.slice(0, 200));
        }
        if (type === 'done' && typeof command === 'string' && typeof seconds === 'number') {
          send('pty:commandDone', id, { command: command.slice(0, 200), seconds });
        }
      });
    }
    proc.on('error', (err) => {
      send('pty:data', id, Buffer.from(`pty host failed: ${err.message}\r\n`));
      ptySessions.delete(id);
      send('pty:exit', id, -1);
    });
    proc.on('exit', (code) => {
      ptySessions.delete(id);
      send('pty:exit', id, code ?? -1);
      ptyRoutes.delete(id);
    });

    return id;
  });

  ipcMain.on('pty:write', (event, id, data) => {
    assertShellSender(event);
    const proc = ptySessions.get(id);
    if (!proc || typeof data !== 'string' || data.length > MAX_PTY_WRITE_BYTES) return;
    proc.stdin?.write(data);
  });

  ipcMain.on('pty:resize', (event, id, cols, rows) => {
    assertShellSender(event);
    const proc = ptySessions.get(id);
    if (!proc) return;
    const control = proc.stdio[3];
    if (control && 'writable' in control && control.writable) {
      control.write(`resize ${clampDimension(rows, 24)} ${clampDimension(cols, 80)}\n`);
    }
  });

  ipcMain.on('pty:kill', (event, id) => {
    assertShellSender(event);
    const proc = ptySessions.get(id);
    if (!proc) return;
    ptySessions.delete(id);
    proc.kill('SIGTERM');
  });
}

// Don't leave orphaned shells behind when the app quits.
app.on('will-quit', () => {
  for (const proc of ptySessions.values()) proc.kill('SIGTERM');
  ptySessions.clear();
});

// ---------------------------------------------------------------------------
// System tools. The WiFi and VPN bridges live in network.mts.
// ---------------------------------------------------------------------------

/**
 * Run a system tool to completion, off the main process (system.mts):
 * resolves stdout; rejects with `<tool>-missing` when it isn't installed,
 * else with the first line of its error output.
 */
async function tool(
  file: string,
  args: string[],
  timeout: number,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  try {
    return (await runCommand(file, args, { timeout, maxBuffer })).stdout;
  } catch (error) {
    if (error instanceof CommandError && error.code === 'ENOENT') {
      throw new Error(`${file}-missing`, { cause: error });
    }
    const stderr = error instanceof CommandError ? error.stderr : '';
    const detail = (stderr || messageOf(error)).trim().split('\n')[0];
    throw new Error(detail || `${file} failed`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Display bridge (window.dinos.display): the arrangement of the outputs Din's one
// window spans - resolution, position, on/off and which output is primary -
// applied as a whole desired layout at once. Two backends:
//   - wlr-randr on Wayland (din-shell on DinOS), through the compositor's
//     wlr-output-management protocol. "Primary" isn't a Wayland notion: it's
//     Din's own (the monitor with the menu bar and Dock), so it's saved with
//     the arrangement, and the arrangement is reapplied whenever the same set
//     of outputs is connected again - din-shell itself forgets, laying outputs out
//     left to right at their preferred modes.
//   - xrandr on a bare X11 session, where Din is the whole desktop and
//     nothing else manages the outputs.
// Where neither applies (a desktop compositor without the protocol, a
// windowed dev shell), status reports `available: false` and the Settings
// panel renders a fallback - same shape as the WiFi bridge in QEMU.
//
// Positions are in the compositor's layout coordinates, which match output
// pixels at scale 1. (Scaled outputs are laid out by their scaled size, which
// the arrangement editor doesn't model yet.)
//
// Threat model: same boundaries as the other bridges (strict CSP, sender
// guard, arguments re-validated). Both tools run via execFile with an argv
// array - no shell - and the output name / mode are matched against the
// tool's own report before use, so neither can inject or select an invalid
// mode.
// ---------------------------------------------------------------------------

const DISPLAY_TIMEOUT_MS = 15_000;

/** The tool that drives the outputs: the compositor's on Wayland, else X's. */
const DISPLAY_TOOL = process.env.WAYLAND_DISPLAY ? 'wlr-randr' : 'xrandr';

/** Run the display tool with an argv array; resolves stdout, rejects with a clean message. */
function displayTool(args: string[], timeout = DISPLAY_TIMEOUT_MS): Promise<string> {
  return tool(DISPLAY_TOOL, args, timeout, 4 * 1024 * 1024);
}

/** One mode of an output. */
interface DisplayMode {
  width: number;
  height: number;
  /** Hz, 0 where the tool didn't say. */
  refresh: number;
  current: boolean;
  preferred: boolean;
}

/** One connected output, as either tool reports it. */
interface DisplayOutput {
  name: string;
  connected: boolean;
  primary: boolean;
  enabled: boolean;
  current: { width: number; height: number; refresh: number } | null;
  position: { x: number; y: number };
  modes: DisplayMode[];
  /** Millimetres, where the display says (its EDID). */
  physicalSize?: { width: number; height: number };
  /** The AirPlay receiver this display is, for the ones deckmon adds. */
  airplay?: string;
}

/** A desired on-state for one output in a layout call. */
interface OutputPlacement {
  name: string;
  width: number;
  height: number;
  /** Hz, one the output offers at this size; absent keeps whichever rate it has. */
  refresh?: number;
  x: number;
  y: number;
  primary: boolean;
}

/**
 * Parse `xrandr --query` into a list of outputs. Each output header looks like
 *   eDP connected primary 1920x1200+0+0 (normal ...) 302mm x 188mm
 * followed by indented mode lines, one per resolution with each of its rates
 *   1920x1200     60.00*+  48.00     ('*' = current mode, '+' = preferred/native)
 */
function parseXrandr(stdout: string): DisplayOutput[] {
  const outputs: DisplayOutput[] = [];
  let current: DisplayOutput | null = null;
  for (const line of stdout.split('\n')) {
    const head = line.match(
      /^(\S+)\s+(connected|disconnected)\b(\s+primary)?(?:.*?\s(\d+)x(\d+)\+(\d+)\+(\d+))?/,
    );
    if (head) {
      const on = Boolean(head[4]);
      const mm = line.match(/\s(\d+)mm x (\d+)mm/);
      current = {
        name: head[1],
        connected: head[2] === 'connected',
        primary: Boolean(head[3]),
        enabled: on,
        current: on ? { width: Number(head[4]), height: Number(head[5]), refresh: 0 } : null,
        position: on ? { x: Number(head[6]), y: Number(head[7]) } : { x: 0, y: 0 },
        modes: [],
        ...(mm && { physicalSize: { width: Number(mm[1]), height: Number(mm[2]) } }),
      };
      outputs.push(current);
      continue;
    }
    const mode = line.match(/^\s+(\d+)x(\d+)\S*\s+(.*)$/);
    if (mode && current) {
      const width = Number(mode[1]);
      const height = Number(mode[2]);
      const rates = [...mode[3].matchAll(/(\d+(?:\.\d+)?)([*+ ]*)/g)];
      for (const [, rate, flags] of rates.length > 0 ? rates : [['', '0', mode[3]]]) {
        const entry = {
          width,
          height,
          refresh: Number(rate),
          current: flags.includes('*'),
          preferred: flags.includes('+'),
        };
        current.modes.push(entry);
        if (entry.current && current.current) current.current.refresh = entry.refresh;
      }
    }
  }
  return outputs;
}

/** `wlr-randr --json`: one entry per head the compositor knows (all connected). */
interface WlrHead {
  name?: unknown;
  enabled?: unknown;
  position?: { x?: unknown; y?: unknown };
  physical_size?: { width?: unknown; height?: unknown };
  modes?: { width?: unknown; height?: unknown; refresh?: unknown; current?: unknown; preferred?: unknown }[];
}

/** Parse `wlr-randr --json`. Primary is left unset: it's Din's to decide. */
function parseWlrRandr(stdout: string): DisplayOutput[] {
  const heads: unknown = JSON.parse(stdout);
  if (!Array.isArray(heads)) return [];
  return (heads as WlrHead[]).flatMap((head) => {
    if (typeof head?.name !== 'string') return [];
    const modes = (Array.isArray(head.modes) ? head.modes : []).map((m) => ({
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      // To the millihertz the compositor counts in.
      refresh: Math.round((Number(m.refresh) || 0) * 1000) / 1000,
      current: m.current === true,
      preferred: m.preferred === true,
    }));
    const enabled = head.enabled === true;
    const now = enabled ? modes.find((m) => m.current) : undefined;
    const mmWidth = Number(head.physical_size?.width) || 0;
    const mmHeight = Number(head.physical_size?.height) || 0;
    return [{
      name: head.name,
      connected: true,
      primary: false,
      enabled,
      current: now ? { width: now.width, height: now.height, refresh: now.refresh } : null,
      position: enabled
        ? { x: Number(head.position?.x) || 0, y: Number(head.position?.y) || 0 }
        : { x: 0, y: 0 },
      modes,
      ...(mmWidth > 0 && mmHeight > 0 && { physicalSize: { width: mmWidth, height: mmHeight } }),
    }];
  });
}

/** A failure that just means this session's outputs can't be managed. */
function displayUnavailable(error: unknown): boolean {
  const message = messageOf(error);
  return (
    message === `${DISPLAY_TOOL}-missing` ||
    /doesn't support wlr-output-management|failed to connect to display/i.test(message)
  );
}

// ---- Saved arrangements (Wayland) -----------------------------------------

/** An arrangement, as saved for one set of connected outputs. */
interface SavedLayout {
  enabled: OutputPlacement[];
  disabled: string[];
}

/** Saved arrangements by outputSetKey, in the user's config. */
function savedLayoutsPath(): string {
  return path.join(app.getPath('userData'), 'displays.json');
}

/** Key for a set of connected outputs: the arrangement saved for it. */
function outputSetKey(outputs: DisplayOutput[]): string {
  return outputs.map((o) => o.name).sort().join('+');
}

function readSavedLayouts(): Record<string, SavedLayout> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(savedLayoutsPath(), 'utf8'));
    return data && typeof data === 'object' ? (data as Record<string, SavedLayout>) : {};
  } catch {
    return {};
  }
}

function saveLayout(key: string, layout: SavedLayout): void {
  const layouts = readSavedLayouts();
  layouts[key] = layout;
  try {
    fs.writeFileSync(savedLayoutsPath(), JSON.stringify(layouts, null, 2));
  } catch (error) {
    console.warn('displays: could not save the arrangement:', messageOf(error));
  }
}

/** Din's primary among Wayland outputs: the saved choice, if it's on. */
function savedPrimary(outputs: DisplayOutput[]): string | null {
  const saved = readSavedLayouts()[outputSetKey(outputs)];
  const name = saved?.enabled.find((p) => p.primary)?.name;
  return name && outputs.some((o) => o.name === name && o.enabled) ? name : null;
}

/**
 * Connected outputs. Throws '<tool>-missing' where the tool is absent.
 *
 * `probe` asks the X server to re-probe every connector first (--query),
 * which can stall it for ~10 ms - fine before changing the layout, not for
 * the Settings panel's status poll, which reads the state the server already
 * keeps current from hotplug events (--current). Wayland compositors always
 * report live state.
 */
async function queryOutputs(probe = false): Promise<DisplayOutput[]> {
  if (DISPLAY_TOOL === 'xrandr') {
    return parseXrandr(await displayTool([probe ? '--query' : '--current'])).filter((o) => o.connected);
  }
  const outputs = parseWlrRandr(await displayTool(['--json']));
  // No saved choice: the laptop's own panel, so plugging a display in (an
  // AirPlay receiver's, say) doesn't take the menu bar and windows with it.
  // Under din-shell, Electron calls the newest output primary. Without a panel,
  // Electron's choice, else the first on.
  const primaryBounds = screen.getPrimaryDisplay().bounds;
  const primary =
    savedPrimary(outputs) ??
    outputs.find((o) => o.enabled && INTERNAL_OUTPUT.test(o.name))?.name ??
    outputs.find((o) => o.enabled && o.position.x === primaryBounds.x && o.position.y === primaryBounds.y)?.name ??
    outputs.find((o) => o.enabled)?.name;
  return outputs.map((o) => ({ ...o, primary: o.name === primary }));
}

/** Laptop built-in panels (the ones that switch off when the lid shuts). */
const INTERNAL_OUTPUT = /^(eDP|LVDS|DSI)/i;

/** An output's best default mode: preferred, else current, else the largest. */
function preferredMode(output: DisplayOutput): DisplayMode | null {
  return (
    output.modes.find((m) => m.preferred) ||
    output.modes.find((m) => m.current) ||
    [...output.modes].sort((a, b) => b.width - a.width || b.height - a.height)[0] ||
    null
  );
}

/** The fastest rate an output offers at a size (0 where it doesn't say). */
function fastestRefresh(output: DisplayOutput, width: number, height: number): number {
  return Math.max(0, ...output.modes.filter((m) => m.width === width && m.height === height).map((m) => m.refresh));
}

/** Whether two rates are the same mode's (tools round them differently). */
function sameRefresh(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

/** The bounding box of a set of rectangles. */
function unionRect(rects: { x: number; y: number; width: number; height: number }[]): Electron.Rectangle {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Turn each enabled output on at its mode/position (marking one primary) and
 * each disabled output off, in one tool call. Under X there's no window
 * manager, so the shell window is refitted to the new outputs right away
 * instead of waiting on a RandR event. `remember` saves the arrangement (and
 * with it the primary) for this set of outputs - for the user's own
 * arrangements, not automatic ones like the lid hand-off.
 */
async function applyOutputLayout(
  outputs: DisplayOutput[],
  enabled: OutputPlacement[],
  disabled: string[],
  remember = false,
): Promise<void> {
  const args: string[] = [];
  if (DISPLAY_TOOL === 'xrandr') {
    for (const e of enabled) {
      args.push('--output', e.name, '--mode', `${e.width}x${e.height}`, '--pos', `${e.x}x${e.y}`);
      if (e.refresh) args.push('--rate', e.refresh.toFixed(2));
      if (e.primary) args.push('--primary');
    }
    for (const name of disabled) args.push('--output', name, '--off');
  } else {
    const byName = new Map(outputs.map((o) => [o.name, o]));
    for (const e of enabled) {
      args.push('--output', e.name, '--on');
      // A size alone is whichever of its rates wlr-randr finds first: the
      // rate is always named, and the current mode is left alone.
      const output = byName.get(e.name);
      const now = output?.current;
      const refresh = e.refresh || (now && now.width === e.width && now.height === e.height ? now.refresh : 0)
        || (output ? fastestRefresh(output, e.width, e.height) : 0);
      if (!now || now.width !== e.width || now.height !== e.height || !sameRefresh(now.refresh, refresh)) {
        args.push('--mode', refresh ? `${e.width}x${e.height}@${refresh.toFixed(3)}Hz` : `${e.width}x${e.height}`);
      }
      args.push('--pos', `${e.x},${e.y}`);
    }
    for (const name of disabled) args.push('--output', name, '--off');
  }
  await displayTool(args);

  if (remember && DISPLAY_TOOL !== 'xrandr') saveLayout(outputSetKey(outputs), { enabled, disabled });

  if (DISPLAY_TOOL === 'xrandr' && enabled.length > 0 && shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.setBounds(unionRect(enabled));
  }
  // The primary may have moved without any output changing.
  scheduleMonitorsUpdate();
}

/**
 * Validate a renderer-supplied arrangement against the outputs the tool
 * reports - never trust the renderer's strings directly.
 */
function placementsFor(
  outputs: DisplayOutput[],
  rawPlacements: unknown,
): { enabled: OutputPlacement[]; disabled: string[] } {
  if (!Array.isArray(rawPlacements)) throw new Error('Invalid layout');
  const byName = new Map(outputs.map((o) => [o.name, o]));
  const enabled: OutputPlacement[] = [];
  const disabled: string[] = [];
  const mentioned = new Set<string>();
  for (const p of rawPlacements) {
    const output = byName.get(String(p && p.output));
    if (!output) throw new Error('Unknown display output');
    if (mentioned.has(output.name)) throw new Error('Duplicate display output');
    mentioned.add(output.name);
    if (!p.enabled) {
      disabled.push(output.name);
      continue;
    }
    const width = Number(p.width);
    const height = Number(p.height);
    if (!output.modes.some((m) => m.width === width && m.height === height)) {
      throw new Error(`Unsupported mode for ${output.name}`);
    }
    const refresh = p.refresh === undefined || p.refresh === null ? undefined : Number(p.refresh);
    if (
      refresh !== undefined &&
      !output.modes.some((m) => m.width === width && m.height === height && sameRefresh(m.refresh, refresh))
    ) {
      throw new Error(`Unsupported refresh rate for ${output.name}`);
    }
    enabled.push({
      name: output.name,
      width,
      height,
      // The output's own figure for it, which the tool matches exactly.
      ...(refresh !== undefined && {
        refresh: output.modes.find((m) => m.width === width && m.height === height && sameRefresh(m.refresh, refresh))?.refresh,
      }),
      x: Math.max(0, Math.round(Number(p.x)) || 0),
      y: Math.max(0, Math.round(Number(p.y)) || 0),
      primary: Boolean(p.primary),
    });
  }
  // Any connected output the renderer didn't mention is turned off.
  for (const o of outputs) if (!mentioned.has(o.name)) disabled.push(o.name);

  if (enabled.length === 0) throw new Error('At least one display must stay on');
  if (enabled.filter((e) => e.primary).length !== 1) {
    throw new Error('Exactly one display must be primary');
  }
  return { enabled, disabled };
}

/** Whether the outputs are already arranged as `layout` says. */
function layoutMatches(outputs: DisplayOutput[], layout: SavedLayout): boolean {
  const byName = new Map(outputs.map((o) => [o.name, o]));
  return (
    layout.enabled.every((e) => {
      const o = byName.get(e.name);
      return (
        o?.enabled &&
        o.current?.width === e.width &&
        o.current?.height === e.height &&
        (!e.refresh || sameRefresh(o.current.refresh, e.refresh)) &&
        o.position.x === e.x &&
        o.position.y === e.y
      );
    }) && layout.disabled.every((name) => !byName.get(name)?.enabled)
  );
}

/** The set of outputs last seen, so only a change of set restores a layout. */
let lastOutputSet: string | null = null;

/**
 * Wayland: when a set of outputs is connected that the user has arranged
 * before, put it back that way. Only on a change of set: switching an output
 * off (the lid hand-off, say) keeps it in the set, and must stick.
 */
async function restoreSavedLayout(): Promise<void> {
  if (DISPLAY_TOOL === 'xrandr') return;
  let outputs: DisplayOutput[];
  try {
    outputs = await queryOutputs();
  } catch {
    return;
  }
  const key = outputSetKey(outputs);
  if (key === lastOutputSet) return;
  lastOutputSet = key;
  const saved = readSavedLayouts()[key];
  if (!saved || lidAutoArranged || layoutMatches(outputs, saved)) return;
  try {
    // Re-validated like a fresh request: modes can disappear with a new cable.
    const { enabled, disabled } = placementsFor(
      outputs,
      [
        ...saved.enabled.map((e) => ({ output: e.name, enabled: true, ...e })),
        ...saved.disabled.map((name) => ({ output: name, enabled: false })),
      ],
    );
    await applyOutputLayout(outputs, enabled, disabled);
  } catch (error) {
    console.warn('displays: could not restore the saved arrangement:', messageOf(error));
  }
}

/** Whether two rectangles overlap or share a stretch of edge. */
function rectsTouch(a: OutputPlacement, b: OutputPlacement): boolean {
  const xs = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const ys = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (xs >= 0 && ys > 0) || (xs > 0 && ys >= 0);
}

/**
 * Slide OUTPUT toward ANCHOR along the axis that separates them until it sits
 * against it, keeping some of the shared edge.
 */
function placeAgainst(output: OutputPlacement, anchor: OutputPlacement): void {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const gapX = Math.max(anchor.x - (output.x + output.width), output.x - (anchor.x + anchor.width));
  const gapY = Math.max(anchor.y - (output.y + output.height), output.y - (anchor.y + anchor.height));
  if (gapY >= gapX) {
    output.y = output.y < anchor.y ? anchor.y - output.height : anchor.y + anchor.height;
    output.x = clamp(output.x, anchor.x - output.width + 1, anchor.x + anchor.width - 1);
  } else {
    output.x = output.x < anchor.x ? anchor.x - output.width : anchor.x + anchor.width;
    output.y = clamp(output.y, anchor.y - output.height + 1, anchor.y + anchor.height - 1);
  }
}

/**
 * Wayland: close any gap between the enabled outputs. The pointer can't cross
 * one, so it's stuck on whichever side it was on - as when a saved
 * arrangement is restored and a display then changes size (deckmon's virtual
 * display for an AirPlay receiver does). The primary stays put; each output
 * cut off from it is moved against the nearest one that isn't. Not saved: the
 * user's arrangement stays theirs.
 */
async function closeLayoutGaps(): Promise<void> {
  if (DISPLAY_TOOL === 'xrandr') return;
  let outputs: DisplayOutput[];
  try {
    outputs = await queryOutputs();
  } catch {
    return;
  }
  const on: OutputPlacement[] = outputs.flatMap((o) =>
    o.enabled && o.current
      ? [{ name: o.name, width: o.current.width, height: o.current.height, ...o.position, primary: o.primary }]
      : [],
  );
  if (on.length < 2) return;

  const placed = [on.find((p) => p.primary) ?? on[0]];
  let rest = on.filter((p) => p !== placed[0]);
  let moved = false;
  while (rest.length > 0) {
    const touching = rest.find((p) => placed.some((q) => rectsTouch(p, q)));
    if (touching) {
      placed.push(touching);
      rest = rest.filter((p) => p !== touching);
      continue;
    }
    // None touch: move the one closest to the placed ones against its nearest.
    const distance = (a: OutputPlacement, b: OutputPlacement) =>
      Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width)) +
      Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
    let best = { output: rest[0], anchor: placed[0], d: Infinity };
    for (const output of rest) {
      for (const anchor of placed) {
        const d = distance(output, anchor);
        if (d < best.d) best = { output, anchor, d };
      }
    }
    placeAgainst(best.output, best.anchor);
    moved = true;
  }
  if (!moved) return;

  const left = Math.min(...on.map((p) => p.x));
  const top = Math.min(...on.map((p) => p.y));
  for (const p of on) {
    p.x -= left;
    p.y -= top;
  }
  const disabled = outputs.filter((o) => !on.some((p) => p.name === o.name)).map((o) => o.name);
  try {
    await applyOutputLayout(outputs, on, disabled);
  } catch (error) {
    console.warn('displays: could not close a gap between displays:', messageOf(error));
  }
}

function registerDisplayHandlers(): void {
  ipcMain.handle('display:status', async (event) => {
    assertShellSender(event);
    try {
      const airplay = airplayDisplays();
      const outputs = (await queryOutputs()).map((o) => {
        const receiver = airplay.get(o.name);
        return receiver ? { ...o, airplay: receiver } : o;
      });
      return { available: true, outputs };
    } catch (error) {
      if (displayUnavailable(error)) return { available: false, outputs: [] };
      throw error;
    }
  });

  ipcMain.handle('display:applyLayout', async (event, rawPlacements) => {
    assertShellSender(event);
    const outputs = await queryOutputs(true);
    const { enabled, disabled } = placementsFor(outputs, rawPlacements);
    await applyOutputLayout(outputs, enabled, disabled, true);
    // A manual arrangement supersedes any automatic lid re-arrangement.
    lidAutoArranged = false;
  });
}

// ---------------------------------------------------------------------------
// Page fullscreen bridge (window.dinos.pageFullscreen). A page in a <webview> that
// goes fullscreen (a video's fullscreen button) makes its frame fullscreen in
// the shell's page, which spans every monitor; Chromium sizes that frame to
// the whole page and won't let it be resized. With several monitors, the
// shell moves and clips the frame onto its window's monitor
// (src/components/desktop/PageFullscreenHost.tsx), and this lays the page
// out at that monitor's size, until it leaves fullscreen.
// ---------------------------------------------------------------------------

/** A <webview> guest of the shell window, from a renderer-supplied id. */
function shellGuestFromId(wcId: unknown): Electron.WebContents | null {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null;
  return contents.hostWebContents?.id === shellContentsId ? contents : null;
}

/** Guests laid out at a monitor's size, waiting to leave fullscreen. */
const fittedGuests = new Set<number>();

// Pages on different monitors can be fullscreen at once, but Chromium has one
// fullscreen state for the whole window: one page leaving fullscreen (Escape,
// its player's button) takes every other page out too. The rest are put back,
// all but the one the user last clicked or typed in, which is the one leaving.
// Each page's fullscreen element is kept in a world of its own to re-request.

const FULLSCREEN_WORLD_ID = 1_338;

/** Shell guests in fullscreen. */
const fullscreenGuests = new Set<number>();
/** When each shell guest last had a click, tap, or key. */
const guestInputAt = new Map<number, number>();
/** The guests that were fullscreen when they started leaving together. */
let leavingGuests: Set<number> | null = null;

function attachPageFullscreen(contents: Electron.WebContents): void {
  const id = contents.id;
  const touched = () => guestInputAt.set(id, Date.now());
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') touched();
  });
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') touched();
  });
  contents.on('input-event', (_event, input) => {
    if (input.type === 'touchEnd' || input.type === 'gestureTap') touched();
  });
  contents.on('enter-html-full-screen', () => {
    if (contents.hostWebContents?.id !== shellContentsId) return;
    fullscreenGuests.add(id);
    contents
      .executeJavaScriptInIsolatedWorld(FULLSCREEN_WORLD_ID, [
        { code: 'window.dinFullscreenElement = document.fullscreenElement; void 0' },
      ])
      .catch(() => {});
  });
  contents.on('leave-html-full-screen', () => {
    if (!fullscreenGuests.has(id)) return;
    if (!leavingGuests) {
      leavingGuests = new Set(fullscreenGuests);
      setTimeout(restoreFullscreenGuests, 100);
    }
    fullscreenGuests.delete(id);
  });
  contents.once('destroyed', () => {
    fullscreenGuests.delete(id);
    guestInputAt.delete(id);
  });
}

function restoreFullscreenGuests(): void {
  const left = leavingGuests;
  leavingGuests = null;
  if (!left || left.size < 2) return;
  let leaving: number | null = null;
  let latest = -Infinity;
  for (const id of left) {
    const at = guestInputAt.get(id) ?? -Infinity;
    if (at > latest) {
      latest = at;
      leaving = id;
    }
  }
  // Nobody touched any of them: no telling which one meant to leave.
  if (leaving === null) return;
  for (const id of left) {
    // A page the shell hid (its tab went to the background) left on purpose.
    if (id === leaving || fullscreenGuests.has(id) || hiddenGuests.has(id)) continue;
    const guest = webContents.fromId(id);
    if (!guest || guest.isDestroyed()) continue;
    guest
      .executeJavaScriptInIsolatedWorld(
        FULLSCREEN_WORLD_ID,
        [{ code: 'window.dinFullscreenElement?.isConnected && window.dinFullscreenElement.requestFullscreen().catch(() => {}); void 0' }],
        true,
      )
      .catch(() => {});
  }
}

function registerPageFullscreenHandlers(): void {
  // A native app's full screen and pointer lock (NativeWindowView.tsx).
  // Blink allows them only just after a click or key, which games seldom
  // ask on; from here, as a user gesture, it's as if the user had asked.
  const onNativeWindow = async (event: Electron.IpcMainInvokeEvent, rawXid: unknown, body: string) => {
    assertShellSender(event);
    const xid = Number(rawXid);
    if (!Number.isSafeInteger(xid) || xid <= 0) throw new Error('Invalid native window');
    const result: unknown = await event.sender.executeJavaScript(
      `(() => {
        const host = document.querySelector('[data-native-window="${xid}"]');
        if (!host) return false;
        ${body}
      })()`,
      true,
    );
    return result === true;
  };
  ipcMain.handle('pageFullscreen:enterNative', (event, xid) =>
    onNativeWindow(event, xid, 'return host.requestFullscreen().then(() => true, () => false);'),
  );
  ipcMain.handle('pageFullscreen:lockNativePointer', (event, xid) =>
    onNativeWindow(
      event,
      xid,
      `const lock = (options) => Promise.resolve(host.requestPointerLock(options)).then(() => true, () => false);
        return lock({ unadjustedMovement: true }).then((locked) => locked || lock());`,
    ),
  );

  ipcMain.handle('pageFullscreen:fit', (event, wcId, rawWidth, rawHeight) => {
    assertShellSender(event);
    const guest = shellGuestFromId(wcId);
    const width = Math.round(Number(rawWidth));
    const height = Math.round(Number(rawHeight));
    if (!guest || !(width > 0 && width <= 16384 && height > 0 && height <= 16384)) {
      throw new Error('Invalid fullscreen fit');
    }
    const size = { width, height };
    guest.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: 1,
    });
    if (!fittedGuests.has(guest.id)) {
      fittedGuests.add(guest.id);
      const id = guest.id;
      guest.once('leave-html-full-screen', () => {
        fittedGuests.delete(id);
        if (!guest.isDestroyed()) guest.disableDeviceEmulation();
      });
      guest.once('destroyed', () => fittedGuests.delete(id));
    }
  });
}

// ---------------------------------------------------------------------------
// Guest visibility bridge (window.dinos.guestVisibility). Electron overrides a
// <webview> page's document.visibilityState with its embedder window's, so a
// background tab or a minimized window's page is told it's visible and never
// gets a visibilitychange: video players, canvas loops and polling that
// pause themselves for hidden pages keep running, and burn the battery. The
// shell reports which of its guests it is hiding, and this sets their state
// through the same internal message Electron uses for the window's.
// ---------------------------------------------------------------------------

/** Electron's internal channel that sets a guest's document visibility. */
const GUEST_VISIBILITY_CHANNEL = 'GUEST_INSTANCE_VISIBILITY_CHANGE';

/** Electron internals this relies on (lib/browser/guest-view-manager.ts). */
interface InternalWebContents {
  _sendInternal(channel: string, ...args: unknown[]): void;
}

/**
 * Guests the shell is hiding (a background tab, a minimized window), each
 * with what undoes the listeners that keep it hidden.
 */
const hiddenGuests = new Map<number, () => void>();

/** Shell webContents whose window-visibility changes are already watched. */
const visibilityWatchedHosts = new WeakSet<Electron.WebContents>();

function sendGuestVisibility(guest: Electron.WebContents, state: 'hidden' | 'visible'): void {
  if (guest.isDestroyed()) return;
  (guest as unknown as InternalWebContents)._sendInternal(GUEST_VISIBILITY_CHANNEL, state);
}

function registerGuestVisibilityHandlers(): void {
  ipcMain.on('guestVisibility:set', (event, wcId, hidden) => {
    if (!isShellSender(event)) return;
    const guest = shellGuestFromId(wcId);
    if (!guest || typeof hidden !== 'boolean') return;
    const id = guest.id;
    if (hidden === hiddenGuests.has(id)) return;
    if (hidden) {
      // Electron restates its own (the window's) visibility to the guest on
      // every dom-ready, so each new document has to be told again, after it.
      const reapply = () => {
        if (hiddenGuests.has(id)) setImmediate(() => sendGuestVisibility(guest, 'hidden'));
      };
      const forget = () => hiddenGuests.delete(id);
      guest.on('dom-ready', reapply);
      guest.once('destroyed', forget);
      hiddenGuests.set(id, () => {
        guest.removeListener('dom-ready', reapply);
        guest.removeListener('destroyed', forget);
        forget();
      });
    } else {
      hiddenGuests.get(id)?.();
    }
    sendGuestVisibility(guest, hidden ? 'hidden' : 'visible');

    // And it restates the window's visibility to every guest whenever the
    // window is shown again, which would un-hide the ones the shell hides.
    const host = guest.hostWebContents;
    if (host && !visibilityWatchedHosts.has(host)) {
      visibilityWatchedHosts.add(host);
      (host as unknown as NodeJS.EventEmitter).on('-window-visibility-change', (state: unknown) => {
        if (state !== 'visible') return;
        setImmediate(() => {
          for (const hiddenId of hiddenGuests.keys()) {
            const hiddenGuest = webContents.fromId(hiddenId);
            if (hiddenGuest) sendGuestVisibility(hiddenGuest, 'hidden');
          }
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Guest file drop bridge (window.dinos.guestFileDrop). Files dragged out of the
// Files app are an in-page drag of paths, with no File objects a page could
// read, and a drag over a <webview> goes to the guest instead of the shell.
// So while one is on, the shell covers its guests and forwards the drag
// here, and this replays it into the page through the DevTools protocol,
// which can drop real files by path, as a drag from a file manager would.
// ---------------------------------------------------------------------------

/** A drag being replayed into a guest. */
interface GuestDrag {
  /** Commands go out in order, each after the last has been answered. */
  queue: Promise<unknown>;
}

const guestDrags = new Map<number, GuestDrag>();

function registerGuestFileDropHandlers(): void {
  ipcMain.on('guestFileDrop:send', (event, wcId, type, rawX, rawY, rawPaths) => {
    if (!isShellSender(event)) return;
    const guest = shellGuestFromId(wcId);
    const x = Number(rawX);
    const y = Number(rawY);
    if (!guest || (type !== 'over' && type !== 'drop' && type !== 'cancel')) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))
      : [];

    let drag = guestDrags.get(guest.id);
    if (!drag) {
      if (type !== 'over' || paths.length === 0) return;
      if (!holdDebugger(guest, 'file-drop')) return;
      drag = { queue: Promise.resolve() };
      guestDrags.set(guest.id, drag);
      dispatchGuestDrag(guest, drag, 'dragEnter', x, y, paths);
    }
    if (type === 'over') {
      dispatchGuestDrag(guest, drag, 'dragOver', x, y, paths);
      return;
    }
    dispatchGuestDrag(guest, drag, type === 'drop' ? 'drop' : 'dragCancel', x, y, paths);
    guestDrags.delete(guest.id);
    void drag.queue.then(() => releaseDebugger(guest, 'file-drop'));
  });
}

function dispatchGuestDrag(
  guest: Electron.WebContents,
  drag: GuestDrag,
  type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel',
  x: number,
  y: number,
  files: string[],
): void {
  // Copy is all a page gets; the files stay where they are.
  const data = { items: [], files, dragOperationsMask: 1 };
  drag.queue = drag.queue
    .then(() => {
      if (guest.isDestroyed() || !guest.debugger.isAttached()) return;
      return guest.debugger.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
    })
    .catch(() => {
      // The page navigated or went away mid-drag.
    });
}

// ---------------------------------------------------------------------------
// Monitors bridge (window.dinos.monitors): where each display sits inside the shell
// window, for the desktop's layout (src/lib/monitors.ts). The production
// window spans every display - din-shell stretches it over all outputs, and on bare
// X11 it's sized to their union below - so positions are relative to the
// union's top-left. Reports null for a single display, or in the windowed dev
// shell, where the viewport is the one monitor.
// ---------------------------------------------------------------------------

/** One display, in DIPs relative to the shell window's top-left. */
interface ShellMonitor {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

/** The union of every display: what the production shell window covers. */
function screenBounds(): Electron.Rectangle {
  return unionRect(screen.getAllDisplays().map((d) => d.bounds));
}

/**
 * The display Din treats as primary. On Wayland that's Din's saved choice of
 * output (matched to a display by position), else what Electron reports.
 */
async function primaryDisplay(displays: Electron.Display[]): Promise<Electron.Display> {
  if (DISPLAY_TOOL !== 'xrandr') {
    try {
      const output = (await queryOutputs()).find((o) => o.primary);
      const match = output && displays.find((d) => d.bounds.x === output.position.x && d.bounds.y === output.position.y);
      if (match) return match;
    } catch {
      // No output management: fall through.
    }
  }
  return screen.getPrimaryDisplay();
}

async function shellMonitors(): Promise<ShellMonitor[] | null> {
  if (DEV_URL) return null;
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return null;
  const origin = screenBounds();
  const primary = await primaryDisplay(displays);
  return displays.map((d, i) => ({
    id: String(d.id),
    name: d.label || `Display ${i + 1}`,
    x: d.bounds.x - origin.x,
    y: d.bounds.y - origin.y,
    width: d.bounds.width,
    height: d.bounds.height,
    primary: d.id === primary.id,
  }));
}

let monitorsTimer: NodeJS.Timeout | null = null;

/**
 * Tell the shell the monitors changed, once things settle: a hotplug arrives
 * as a burst of display events while the compositor rearranges.
 */
function scheduleMonitorsUpdate(): void {
  if (monitorsTimer) clearTimeout(monitorsTimer);
  monitorsTimer = setTimeout(() => {
    monitorsTimer = null;
    void shellMonitors().then((monitors) => sendToShell('monitors:changed', monitors));
  }, 150);
}

function registerMonitorsHandlers(): void {
  ipcMain.handle('monitors:get', (event) => {
    assertShellSender(event);
    return shellMonitors();
  });
}

// ---------------------------------------------------------------------------
// Lid switch. When the laptop is docked to an external display and the lid is
// closed, the built-in panel should switch off and an external output take
// over as primary; opening the lid again restores the built-in panel. There
// is no window manager or logind seat handling this, so the shell watches the
// ACPI lid state itself and drives the outputs through the same path as the
// Settings panel. If the lid closes with no external attached we leave the
// only screen alone rather than blanking the machine.
// ---------------------------------------------------------------------------

const LID_STATE_DIR = '/proc/acpi/button/lid';
const LID_POLL_MS = 2_000;
let lidState: 'open' | 'closed' | null = null; // null = unknown / no lid
let lidAutoArranged = false; // did we auto-disable the built-in panel on close?
let lidTimer: NodeJS.Timeout | null = null;

/** Read the ACPI lid state, or null when the machine has no lid button. */
async function readLidState(): Promise<'open' | 'closed' | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(LID_STATE_DIR);
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const text = await fsp.readFile(path.join(LID_STATE_DIR, entry, 'state'), 'utf8');
      if (/closed/i.test(text)) return 'closed';
      if (/open/i.test(text)) return 'open';
    } catch {
      // Skip an unreadable lid entry.
    }
  }
  return null;
}

/**
 * Lay a set of outputs left-to-right starting at the origin, first one primary,
 * each at its preferred mode. Returns the { enabled, disabled } pair for
 * applyOutputLayout, or null if none can be driven.
 */
function packLeftToRight(
  on: DisplayOutput[],
  off: DisplayOutput[],
): { enabled: OutputPlacement[]; disabled: string[] } | null {
  const enabled: OutputPlacement[] = [];
  let x = 0;
  for (const output of on) {
    const mode = preferredMode(output);
    if (!mode) continue;
    enabled.push({
      name: output.name,
      width: mode.width,
      height: mode.height,
      refresh: fastestRefresh(output, mode.width, mode.height) || undefined,
      x,
      y: 0,
      primary: enabled.length === 0,
    });
    x += mode.width;
  }
  if (enabled.length === 0) return null;
  return { enabled, disabled: off.map((o) => o.name) };
}

/** Lid closed: if docked, switch the built-in panel off and hand off to externals. */
async function onLidClosed(): Promise<void> {
  let outputs: DisplayOutput[];
  try {
    outputs = await queryOutputs(true);
  } catch {
    return;
  }
  const internal = outputs.filter((o) => INTERNAL_OUTPUT.test(o.name));
  const external = outputs.filter((o) => !INTERNAL_OUTPUT.test(o.name));
  // Don't blank the only screen: only act when there's somewhere to hand off to.
  if (internal.length === 0 || external.length === 0) return;

  const layout = packLeftToRight(external, internal);
  if (!layout) return;
  try {
    await applyOutputLayout(outputs, layout.enabled, layout.disabled);
    lidAutoArranged = true;
  } catch {
    // Leave the current arrangement in place on failure.
  }
}

/** Lid opened: undo an automatic close-time hand-off, restoring the built-in panel. */
async function onLidOpened(): Promise<void> {
  if (!lidAutoArranged) return; // only reverse our own change
  lidAutoArranged = false;
  let outputs: DisplayOutput[];
  try {
    outputs = await queryOutputs(true);
  } catch {
    return;
  }
  const internal = outputs.filter((o) => INTERNAL_OUTPUT.test(o.name));
  const external = outputs.filter((o) => !INTERNAL_OUTPUT.test(o.name));
  if (internal.length === 0) return;

  // Built-in panel back as primary at the origin, externals to its right.
  const layout = packLeftToRight([...internal, ...external], []);
  if (!layout) return;
  try {
    await applyOutputLayout(outputs, layout.enabled, layout.disabled);
  } catch {
    // Leave the current arrangement in place on failure.
  }
}

/** Poll the ACPI lid state and react to open/close transitions. */
function registerLidWatch(): void {
  const poll = async () => {
    const next = await readLidState();
    if (!next || next === lidState) return;
    const previous = lidState;
    lidState = next;
    if (previous === null) return; // establish a baseline without acting
    if (next === 'closed') await onLidClosed();
    else await onLidOpened();
  };
  poll();
  lidTimer = setInterval(() => {
    poll().catch(() => {});
  }, LID_POLL_MS);
}

// ---------------------------------------------------------------------------
// Power bridge (window.dinos.power), backed by /sys/class/power_supply. Read-only
// sysfs, so it needs no external binary and works on any Linux session (din-shell
// on DinOS or the bare-X11 standalone launcher). Reports `available: false`
// where there's no battery (desktops, the QEMU VM) so the menu-bar indicator
// hides and the Settings panel shows a fallback. Sender-guarded like the
// other bridges.
// ---------------------------------------------------------------------------

const POWER_SUPPLY_DIR = '/sys/class/power_supply';

/** Read a sysfs attribute, trimmed, or null when it's absent/unreadable. */
async function readPowerAttr(dir: string, name: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path.join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

type BatteryStatus = 'charging' | 'discharging' | 'full' | 'not-charging' | 'unknown';

/** Map the kernel's battery status string to a small stable enum. */
function mapBatteryStatus(raw: string | null): BatteryStatus {
  switch ((raw || '').toLowerCase()) {
    case 'charging':
      return 'charging';
    case 'discharging':
      return 'discharging';
    case 'full':
      return 'full';
    case 'not charging':
      return 'not-charging';
    default:
      return 'unknown';
  }
}

/** Read one battery directory into { name, percent, status, secondsRemaining }. */
async function readBattery(dir: string, name: string): Promise<{
  name: string;
  percent: number | null;
  status: BatteryStatus;
  secondsRemaining: number | null;
}> {
  const [statusRaw, capacityRaw, energyNow, energyFull, powerNow, chargeNow, chargeFull, currentNow] =
    await Promise.all([
      readPowerAttr(dir, 'status'),
      readPowerAttr(dir, 'capacity'),
      readPowerAttr(dir, 'energy_now'),
      readPowerAttr(dir, 'energy_full'),
      readPowerAttr(dir, 'power_now'),
      readPowerAttr(dir, 'charge_now'),
      readPowerAttr(dir, 'charge_full'),
      readPowerAttr(dir, 'current_now'),
    ]);

  const status = mapBatteryStatus(statusRaw);

  // Charge level: prefer the kernel's capacity %, else derive from now/full.
  const now = Number(energyNow ?? chargeNow);
  const full = Number(energyFull ?? chargeFull);
  const rate = Number(powerNow ?? currentNow);
  let percent: number | null = capacityRaw !== null ? Number.parseInt(capacityRaw, 10) : NaN;
  if (Number.isNaN(percent) && Number.isFinite(now) && full > 0) {
    percent = Math.round((now / full) * 100);
  }
  percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent as number)) : null;

  // Time estimate: energy(µWh)/power(µW) or charge(µAh)/current(µA) -> hours.
  let secondsRemaining: number | null = null;
  if (rate > 0 && Number.isFinite(now) && Number.isFinite(full)) {
    if (status === 'charging' && full > now) {
      secondsRemaining = Math.round(((full - now) / rate) * 3600);
    } else if (status === 'discharging') {
      secondsRemaining = Math.round((now / rate) * 3600);
    }
  }

  return { name, percent, status, secondsRemaining };
}

// Power profiles, via the net.hadess.PowerProfiles D-Bus API. The same
// interface is served by power-profiles-daemon on most distros and by
// tuned-ppd on Fedora, so one code path drives both. We speak to it over the
// system bus with busctl (always present via systemd) rather than opening a
// long-lived D-Bus connection, keeping this consistent with the other
// external-tool bridges and adding no dependency. Absent daemon / busctl ->
// available:false so the Settings panel falls back. Switching the active
// profile is a plain writable property set, authorized by polkit for the
// active session (the same path GNOME's toggle uses).
const PPD_BUS = 'net.hadess.PowerProfiles';
const PPD_PATH = '/net/hadess/PowerProfiles';
const PPD_IFACE = 'net.hadess.PowerProfiles';
const BUSCTL_TIMEOUT_MS = 5_000;

/** Run busctl on the system bus; resolves stdout, rejects with a clean message. */
function busctl(args: string[], timeout = BUSCTL_TIMEOUT_MS): Promise<string> {
  return tool('busctl', ['--system', ...args], timeout);
}

/** Read one PowerProfiles property as parsed JSON ({ type, data }). */
async function ppdGetProperty(property: string): Promise<{ type: string; data: unknown }> {
  const out = await busctl([
    '--json=short', 'get-property', PPD_BUS, PPD_PATH, PPD_IFACE, property,
  ]);
  return JSON.parse(out);
}

/** The power-profiles state reported to the Settings panel. */
interface PowerProfilesState {
  available: boolean;
  active: string | null;
  profiles: string[];
}

/** Current profile state, or available:false when the daemon/busctl is absent. */
async function readPowerProfiles(): Promise<PowerProfilesState> {
  try {
    const [active, profiles] = await Promise.all([
      ppdGetProperty('ActiveProfile'),
      ppdGetProperty('Profiles'),
    ]);
    // Profiles is aa{sv}: [{ Profile: {type,data}, Driver: {...} }, ...],
    // ordered low -> high power by the daemon.
    const names: string[] = Array.isArray(profiles.data)
      ? profiles.data
          .map((entry) => entry?.Profile?.data)
          .filter((name): name is string => typeof name === 'string')
      : [];
    return {
      available: names.length > 0,
      active: typeof active.data === 'string' ? active.data : null,
      profiles: names,
    };
  } catch {
    // Daemon not running / not installed / busctl missing: treat as
    // unavailable rather than surfacing a raw D-Bus error to the panel.
    return { available: false, active: null, profiles: [] };
  }
}

// Restart and shut down, through logind. The menu offers each only where
// logind answers a plain "yes" for this session: "challenge" would have
// polkit's agent (electron/polkit-agent.mts) ask for the password, which a
// click on Restart shouldn't.
const LOGIND_BUS = 'org.freedesktop.login1';
const LOGIND_PATH = '/org/freedesktop/login1';
const LOGIND_IFACE = 'org.freedesktop.login1.Manager';

/** Whether logind lets this session run `method` (CanReboot, CanPowerOff) without asking. */
async function logindAllows(method: string): Promise<boolean> {
  try {
    const out = await busctl(['--json=short', 'call', LOGIND_BUS, LOGIND_PATH, LOGIND_IFACE, method]);
    const reply: { data?: unknown[] } = JSON.parse(out);
    return reply.data?.[0] === 'yes';
  } catch {
    return false;
  }
}

/** Refuse to cut short work that would leave the disk half-written. */
function assertSafeToPowerOff(): void {
  if (isUpdating()) throw new Error('An update is being installed. Try again when it finishes.');
  if (isInstalling()) throw new Error('DinOS is being installed. Try again when it finishes.');
  if (isFlashing()) throw new Error('Firmware is being updated. Try again when it finishes.');
}

function registerPowerHandlers(): void {
  ipcMain.handle('power:actions', async (event) => {
    assertShellSender(event);
    const [reboot, powerOff] = await Promise.all([
      logindAllows('CanReboot'),
      logindAllows('CanPowerOff'),
    ]);
    return { reboot, powerOff };
  });

  ipcMain.handle('power:reboot', async (event) => {
    assertShellSender(event);
    assertSafeToPowerOff();
    await tool('systemctl', ['reboot'], 15_000);
  });

  ipcMain.handle('power:powerOff', async (event) => {
    assertShellSender(event);
    assertSafeToPowerOff();
    await tool('systemctl', ['poweroff'], 15_000);
  });

  ipcMain.handle('power:status', async (event) => {
    assertShellSender(event);
    let names: string[];
    try {
      names = await fsp.readdir(POWER_SUPPLY_DIR);
    } catch {
      return { available: false, acConnected: false, batteries: [], devices: [] };
    }

    // A battery whose scope is Device powers something else (a Bluetooth
    // mouse's, hid-<address>-battery): it's listed by its model's name, apart
    // from the computer's own, and never counts toward the computer's charge.
    const batteries = [];
    const devices = [];
    let acConnected = false;
    for (const name of names.sort()) {
      const dir = path.join(POWER_SUPPLY_DIR, name);
      const type = await readPowerAttr(dir, 'type');
      if (type === 'Battery') {
        if ((await readPowerAttr(dir, 'present')) === '0') continue;
        const battery = await readBattery(dir, name);
        if ((await readPowerAttr(dir, 'scope')) === 'Device') {
          devices.push({ ...battery, label: (await readPowerAttr(dir, 'model_name')) || 'Device' });
        } else {
          batteries.push(battery);
        }
      } else if (type === 'Mains' || type === 'USB') {
        // Mains = AC adapter; a USB-C port online means USB-PD is supplying power.
        if ((await readPowerAttr(dir, 'online')) === '1') acConnected = true;
      }
    }

    return {
      available: batteries.length > 0,
      acConnected,
      batteries: batteries.map((battery, i) => ({
        ...battery,
        label: batteries.length > 1 ? `Battery ${i + 1}` : 'Battery',
      })),
      devices,
    };
  });

  ipcMain.handle('power:profiles', async (event) => {
    assertShellSender(event);
    return readPowerProfiles();
  });

  ipcMain.handle('power:setProfile', async (event, name) => {
    assertShellSender(event);
    if (typeof name !== 'string') throw new Error('A profile name is required');
    // Only accept a profile the daemon actually offers, so a compromised
    // renderer can't push arbitrary strings into the D-Bus set-property call.
    const state = await readPowerProfiles();
    if (!state.available) throw new Error('Power profiles are not available');
    if (!state.profiles.includes(name)) {
      throw new Error(`Unknown power profile "${name}"`);
    }
    await busctl([
      'set-property', PPD_BUS, PPD_PATH, PPD_IFACE, 'ActiveProfile', 's', name,
    ]);
    return readPowerProfiles();
  });

  // Log out: quit cleanly. As a login session (scripts/session.mjs) that
  // ends it, returning to the display manager; on DinOS the din-shell
  // service brings a fresh Din back up.
  ipcMain.on('shell:endSession', (event) => {
    if (!isShellSender(event)) return;
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// Audio bridge (window.dinos.audio), backed by wpctl (WirePlumber/PipeWire). Drives
// the default sink's volume and mute for the menu-bar control, the media-key
// OSD, and - for the Settings sound panel - output/input device enumeration
// and selection, per-application (stream) volume, and a test tone played to a
// chosen sink via pw-play. Outputs/inputs on a card's inactive profiles come
// from pactl, and selecting one switches the profile. Where wpctl is absent
// (no PipeWire) it reports available:false and the UI falls back. Same trust
// boundary as the other bridges: sender guard, argv execFile, ids and volumes
// re-validated here.
// ---------------------------------------------------------------------------

const WPCTL_TIMEOUT_MS = 5_000;
const DEFAULT_SINK = '@DEFAULT_AUDIO_SINK@';

/** Run wpctl with an argv array; resolves stdout, rejects with a clean message. */
function wpctl(args: string[], timeout = WPCTL_TIMEOUT_MS): Promise<string> {
  return tool('wpctl', args, timeout);
}

/**
 * Loudest volume Din will set, in percent. Past 100 PipeWire amplifies in
 * software, which can clip, so it stops at 150 like GNOME's over-amplification.
 * Keep in step with MAX_VOLUME in src/lib/audio.ts.
 */
const MAX_VOLUME = 150;
const WPCTL_LIMIT = String(MAX_VOLUME / 100);

/** Clamp a caller-supplied percentage to an integer 0..MAX_VOLUME. */
function clampVolume(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) throw new Error('Invalid volume');
  return Math.max(0, Math.min(MAX_VOLUME, Math.round(n)));
}

/** The default sink's state as reported to the shell. */
interface AudioState {
  available: boolean;
  volume: number | null;
  muted: boolean;
}

/** Default sink volume/mute, or available:false when wpctl is absent. */
async function audioStatus(): Promise<AudioState> {
  try {
    // "Volume: 0.65" or "Volume: 0.65 [MUTED]"
    const out = await wpctl(['get-volume', DEFAULT_SINK]);
    const match = out.match(/Volume:\s*([\d.]+)/);
    const volume = match ? Math.round(Number.parseFloat(match[1]) * 100) : null;
    return { available: true, volume, muted: /\[MUTED\]/.test(out) };
  } catch (error) {
    if (messageOf(error) === 'wpctl-missing') {
      return { available: false, volume: null, muted: false };
    }
    throw error;
  }
}

async function audioSetVolume(pct: unknown): Promise<AudioState> {
  const v = clampVolume(pct);
  await wpctl(['set-volume', '-l', WPCTL_LIMIT, DEFAULT_SINK, `${v}%`]);
  return audioStatus();
}

async function audioSetMuted(muted: boolean): Promise<AudioState> {
  await wpctl(['set-mute', DEFAULT_SINK, muted ? '1' : '0']);
  return audioStatus();
}

/**
 * The extra range past a control's normal one (volume over 100, brightness
 * under 0) sits behind a detent for the media keys: a step that would cross
 * the edge stops on it, and the first press at the edge only knocks. Another
 * press within KNOCK_MS goes through. Keep in step with stepWithDetent in
 * src/lib/overdrive.ts, which does the same for the sliders' arrow keys.
 */
const KNOCK_MS = 1000;

interface DetentRange {
  min: number;
  max: number;
  overMax?: number;
  underMin?: number;
}

function stepWithDetent(current: number, delta: number, range: DetentRange, knock: { at: number }): number {
  const { min, max, overMax, underMin } = range;
  const next = current + delta;
  const edge = delta > 0 ? (overMax === undefined ? null : max) : underMin === undefined ? null : min;
  if (edge !== null) {
    const crossing = delta > 0 ? current < edge && next > edge : current > edge && next < edge;
    if (crossing) return edge;
    if (current === edge) {
      const now = Date.now();
      if (now - knock.at > KNOCK_MS) {
        knock.at = now;
        return current;
      }
    }
  }
  return Math.max(underMin ?? min, Math.min(overMax ?? max, next));
}

const volumeKnock = { at: 0 };

async function audioAdjust(deltaPct: number): Promise<AudioState> {
  const status = await audioStatus();
  if (status.volume === null) throw new Error('no-volume');
  // Turning it up while muted unmutes, as on other desktops; turning it down leaves it muted.
  const unmute = deltaPct > 0 && status.muted;
  if (unmute) await wpctl(['set-mute', DEFAULT_SINK, '0']);
  const next = stepWithDetent(status.volume, deltaPct, { min: 0, max: 100, overMax: MAX_VOLUME }, volumeKnock);
  if (next === status.volume) return unmute ? audioStatus() : status;
  return audioSetVolume(next);
}

async function audioToggleMute(): Promise<AudioState> {
  await wpctl(['set-mute', DEFAULT_SINK, 'toggle']);
  return audioStatus();
}

// --- The default source (microphone): volume, mute, and the mic-mute LED. ---

const DEFAULT_SOURCE = '@DEFAULT_AUDIO_SOURCE@';

/**
 * Default source volume/mute. available:false when wpctl is absent or there
 * is no input to read (wpctl fails on @DEFAULT_AUDIO_SOURCE@ then).
 */
async function audioInputStatus(): Promise<AudioState> {
  try {
    const out = await wpctl(['get-volume', DEFAULT_SOURCE]);
    const match = out.match(/Volume:\s*([\d.]+)/);
    const volume = match ? Math.round(Number.parseFloat(match[1]) * 100) : null;
    return { available: true, volume, muted: /\[MUTED\]/.test(out) };
  } catch {
    return { available: false, volume: null, muted: false };
  }
}

async function audioSetInputVolume(pct: unknown): Promise<AudioState> {
  const v = clampVolume(pct);
  await wpctl(['set-volume', '-l', WPCTL_LIMIT, DEFAULT_SOURCE, `${v}%`]);
  return audioInputStatus();
}

async function audioSetInputMuted(muted: boolean): Promise<AudioState> {
  await wpctl(['set-mute', DEFAULT_SOURCE, muted ? '1' : '0']);
  void syncMicMuteLed();
  return audioInputStatus();
}

async function audioToggleInputMute(): Promise<AudioState> {
  await wpctl(['set-mute', DEFAULT_SOURCE, 'toggle']);
  void syncMicMuteLed();
  return audioInputStatus();
}

/**
 * Laptops with a mic-mute key light an LED on it (ThinkPads: platform::micmute).
 * The kernel drives it with the audio-micmute trigger, which follows an ALSA
 * capture switch - on AMD ThinkPads the HDA codec's, while the built-in mic
 * is a digital one on a different card, so the LED stays lit whatever the mic
 * is doing. Din drives it from the default source's mute instead. Writing 0
 * to brightness detaches the trigger; the LED's brightness file is writable by
 * the `input` group (brightnessctl's udev rules), and anywhere it isn't this
 * quietly does nothing.
 */
const LEDS_DIR = '/sys/class/leds';
const detachedMicLeds = new Set<string>();

async function syncMicMuteLed(): Promise<void> {
  let leds: string[];
  try {
    leds = fs.readdirSync(LEDS_DIR).filter((name) => name.endsWith('::micmute'));
  } catch {
    return;
  }
  if (leds.length === 0) return;
  const status = await audioInputStatus();
  if (!status.available) return;
  for (const led of leds) {
    const file = path.join(LEDS_DIR, led, 'brightness');
    try {
      if (!detachedMicLeds.has(led)) {
        await fs.promises.writeFile(file, '0');
        detachedMicLeds.add(led);
      }
      await fs.promises.writeFile(file, status.muted ? '1' : '0');
    } catch {
      // Not writable here (no udev rule, not in `input`).
    }
  }
}

// --- Device / stream enumeration and per-node control. ---

/** A sink (output) or source (input) device from `wpctl status`. */
interface AudioDevice {
  id: number;
  name: string;
  /** Volume 0-100 (may exceed 100 where PipeWire is boosted), or null. */
  volume: number | null;
  muted: boolean;
  /** True for the default sink/source (the `*` marker in wpctl). */
  isDefault: boolean;
  /** Its freedesktop icon name, e.g. "audio-headset-bluetooth", when known. */
  icon?: string;
  /** A Bluetooth headset on its call profile, while something uses its mic. */
  callQuality?: boolean;
}

/** A per-application playback stream from `wpctl status`. */
interface AudioStream {
  id: number;
  name: string;
  volume: number;
  muted: boolean;
}

/**
 * An output or input that has no node yet because its sound card is on a
 * profile without it (a laptop's headphone jack while the speaker profile is
 * active, a Bluetooth headset's mic on the A2DP profile). Selecting it
 * switches the card's profile.
 */
interface AudioPort {
  /** Card name, e.g. "alsa_card.pci-0000_c4_00.6". */
  card: string;
  /** Port name on that card, e.g. "[Out] Headphones". */
  port: string;
  name: string;
}

interface AudioDevices {
  available: boolean;
  sinks: AudioDevice[];
  sources: AudioDevice[];
  /** Outputs reachable by switching a card's profile. */
  inactiveSinks: AudioPort[];
  /** Inputs reachable by switching a card's profile. */
  inactiveSources: AudioPort[];
}

/** Pull "[vol: 0.60 MUTED]" out of a node line into a percentage and mute flag. */
function parseVolumeTag(text: string): { volume: number | null; muted: boolean } {
  const match = text.match(/\[vol:\s*([\d.]+)(\s+MUTED)?\]/);
  if (!match) return { volume: null, muted: false };
  return { volume: Math.round(Number.parseFloat(match[1]) * 100), muted: Boolean(match[2]) };
}

/**
 * Parse `wpctl status`, returning the sinks, sources and playback-stream nodes
 * under the top-level "Audio" tree only. Crucially this skips the "Video" tree,
 * whose Sinks/Sources are cameras, and the port child rows under Streams (which
 * carry a " > " link arrow). The `*` column marks the default sink/source.
 */
function parseAudioStatus(out: string): {
  sinks: AudioDevice[];
  sources: AudioDevice[];
  streamNodes: { id: number; name: string }[];
} {
  const lines = out.split('\n');
  const sinks: AudioDevice[] = [];
  const sources: AudioDevice[] = [];
  const streamNodes: { id: number; name: string }[] = [];

  const start = lines.findIndex((l) => l === 'Audio');
  if (start === -1) return { sinks, sources, streamNodes };

  let section = '';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next top-level header ("Video", "Settings") ends the Audio tree.
    if (/^\S/.test(line)) break;

    const header = line.match(/[├└]─\s*(\w+):/);
    if (header) {
      section = header[1];
      continue;
    }

    // "<tree chars> [*] <id>. <name>[ vol tag]". The `*` (not a tree char)
    // sits outside the character class, so it's captured separately.
    const node = line.match(/^[\s│├└─]*(\*)?\s*(\d+)\.\s+(.+?)\s*$/);
    if (!node) continue;
    const isDefault = node[1] === '*';
    const id = Number.parseInt(node[2], 10);
    const raw = node[3];

    if (section === 'Sinks' || section === 'Sources') {
      const { volume, muted } = parseVolumeTag(raw);
      const device: AudioDevice = {
        id,
        name: raw.replace(/\s*\[vol:[^\]]*\]\s*$/, '').trim(),
        volume,
        muted,
        isDefault,
      };
      (section === 'Sinks' ? sinks : sources).push(device);
    } else if (section === 'Filters') {
      // A filter that stands in for a device: a Bluetooth headset's mic is
      // one ("bluez_input.<address>  [Audio/Source]"), kept even while the
      // headset is on its music profile and switching it over when used.
      // Listed by node name, with no volume; audioDevices fills those in.
      const filter = raw.match(/^(.+?)\s+\[Audio\/(Sink|Source)\]$/);
      if (!filter) continue;
      const device: AudioDevice = { id, name: filter[1], volume: null, muted: false, isDefault };
      (filter[2] === 'Sink' ? sinks : sources).push(device);
    } else if (section === 'Streams') {
      // Port rows ("output_FL > ...:playback_FL") aren't controllable streams.
      if (/\s>\s/.test(raw)) continue;
      streamNodes.push({ id, name: raw.trim() });
    }
  }

  return { sinks, sources, streamNodes };
}

/** Validate a caller-supplied wpctl node id as a non-negative integer. */
function validNodeId(x: unknown): number {
  const n = Number(x);
  if (!Number.isInteger(n) || n < 0) throw new Error('Invalid device id');
  return n;
}

// --- Card profiles: outputs/inputs that only exist on an inactive profile. ---
// `wpctl status` lists nodes, and a card makes nodes only for its active
// profile, so pactl's card listing (served by pipewire-pulse) fills in the
// rest. Where pactl is missing or too old for `-f json`, these lists are empty.

const PACTL_TIMEOUT_MS = 5_000;
/** How long to wait for a card's new node after switching its profile. */
const PROFILE_SWITCH_WAIT_MS = 3_000;
/** Profiles never offered as a device choice. */
const SKIPPED_PROFILES = new Set(['off', 'pro-audio']);

function pactl(args: string[], timeout = PACTL_TIMEOUT_MS): Promise<string> {
  return tool('pactl', args, timeout, 4 * 1024 * 1024);
}

interface PactlCard {
  name: string;
  active_profile: string | null;
  properties: Record<string, string>;
  profiles: Record<string, { priority: number; available: boolean }>;
  ports: Record<string, { description: string; type: string; availability: string; profiles: string[] }>;
}

/** A sink or source as `pactl -f json list sinks|sources` reports it. */
interface PactlNode {
  name: string;
  description?: string;
  properties: Record<string, string>;
  ports: { name: string; availability?: string }[];
  active_port: string | null;
}

/**
 * PipeWire node ids of sinks/sources whose port is unplugged (a laptop's
 * headset mic with nothing in the jack). wpctl lists them anyway, and picking
 * one records silence.
 */
function unpluggedNodeIds(nodes: PactlNode[]): Set<number> {
  const ids = new Set<number>();
  for (const node of nodes) {
    const port = node.ports?.find((p) => p.name === node.active_port);
    const id = Number(node.properties?.['object.id']);
    if (port?.availability === 'not available' && Number.isInteger(id)) ids.add(id);
  }
  return ids;
}

/**
 * Give devices `wpctl status` listed as filters (no volume tag) the name the
 * user knows them by ("Soundcore Life Q30", not its node name) and their
 * volume and mute, which wpctl prints only when asked for that node.
 */
async function describeFilterDevices(devices: AudioDevice[], nodes: PactlNode[]): Promise<void> {
  await Promise.all(
    devices
      .filter((device) => device.volume === null)
      .map(async (device) => {
        const node = nodes.find((n) => Number(n.properties?.['object.id']) === device.id);
        if (node?.description) device.name = node.description;
        const out = await wpctl(['get-volume', String(device.id)]).catch(() => '');
        const match = out.match(/Volume:\s*([\d.]+)/);
        if (match) device.volume = Math.round(Number.parseFloat(match[1]) * 100);
        device.muted = /\[MUTED\]/.test(out);
      }),
  );
}

/** Parse a `pactl -f json list ...` array; [] when pactl can't provide one. */
async function pactlList<T>(what: 'cards' | 'sinks' | 'sources'): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await pactl(['-f', 'json', 'list', what]));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Whether a card port is an output or an input, from its name. */
function portDirection(port: string): 'output' | 'input' | null {
  if (/^\[Out\]|(^|-)output(-|$)/i.test(port)) return 'output';
  if (/^\[In\]|(^|-)input(-|$)/i.test(port)) return 'input';
  return null;
}

/** The best profile that carries a port: available, highest priority. */
function profileForPort(card: PactlCard, port: string): string | null {
  let best: string | null = null;
  let bestPriority = -Infinity;
  for (const name of card.ports[port]?.profiles ?? []) {
    const profile = card.profiles[name];
    if (!profile?.available || SKIPPED_PROFILES.has(name)) continue;
    if (profile.priority > bestPriority) {
      best = name;
      bestPriority = profile.priority;
    }
  }
  return best;
}

/** Ports with no node because their card's active profile doesn't carry them. */
function inactivePorts(cards: PactlCard[]): { output: AudioPort[]; input: AudioPort[] } {
  const found = { output: [] as AudioPort[], input: [] as AudioPort[] };
  for (const card of cards) {
    // A Bluetooth headset's other profile is the same headphones, which
    // WirePlumber moves between by itself: music, or a call while something
    // records. Offered too, it would be a second row that locks in one.
    if (card.properties?.['device.bus'] === 'bluetooth') continue;
    const cardName = card.properties?.['device.description'] ?? card.name;
    for (const [port, info] of Object.entries(card.ports ?? {})) {
      if (info.availability === 'not available') continue;
      // ALSA offers S/PDIF on many USB devices without the jack; only show it
      // when the card can actually tell it's there.
      if (info.type === 'SPDIF' && info.availability !== 'available') continue;
      if (card.active_profile && info.profiles.includes(card.active_profile)) continue;
      const direction = portDirection(port);
      if (!direction || !profileForPort(card, port)) continue;
      found[direction].push({ card: card.name, port, name: `${cardName} ${info.description}` });
    }
  }
  return found;
}

/** All sinks and sources, or available:false when wpctl is absent. */
async function audioDevices(): Promise<AudioDevices> {
  try {
    const [status, cards, pactlSinks, pactlSources] = await Promise.all([
      wpctl(['status']),
      pactlList<PactlCard>('cards'),
      pactlList<PactlNode>('sinks'),
      pactlList<PactlNode>('sources'),
    ]);
    const parsed = parseAudioStatus(status);
    const { sinks } = parsed;
    let { sources } = parsed;
    // Listed from Filters, so with no volume until described.
    const filters = new Set(sources.filter((device) => device.volume === null).map((device) => device.id));
    await describeFilterDevices([...sinks, ...sources], [...pactlSinks, ...pactlSources]);
    // While a headset is on its call profile, its own mic is listed too; the
    // filter standing in for it is the one to keep, as it lasts.
    const filterNames = new Set(sources.filter((device) => filters.has(device.id)).map((device) => device.name));
    sources = sources.filter((device) => filters.has(device.id) || !filterNames.has(device.name));
    for (const device of [...sinks, ...sources]) {
      const node = [...pactlSinks, ...pactlSources].find((n) => Number(n.properties?.['object.id']) === device.id);
      const icon = node?.properties?.['device.icon_name'];
      if (icon) device.icon = icon;
      const card = cards.find((c) => c.name === node?.properties?.['device.name']);
      if (card?.properties?.['device.bus'] === 'bluetooth' && /head-unit|handsfree|hfp|hsp/i.test(card.active_profile ?? '')) {
        device.callQuality = true;
      }
    }
    const inactive = inactivePorts(cards);
    const unplugged = unpluggedNodeIds([...pactlSinks, ...pactlSources]);
    // The default stays listed even unplugged, so the panel shows what's in use.
    const plugged = (device: AudioDevice) => device.isDefault || !unplugged.has(device.id);
    return {
      available: true,
      sinks: sinks.filter(plugged),
      sources: sources.filter(plugged),
      inactiveSinks: inactive.output,
      inactiveSources: inactive.input,
    };
  } catch (error) {
    if (messageOf(error) === 'wpctl-missing') {
      return { available: false, sinks: [], sources: [], inactiveSinks: [], inactiveSources: [] };
    }
    throw error;
  }
}

/**
 * Switch a card to the profile that carries `port`, then make the node that
 * profile creates for it the default (setting it as that node's active port
 * if the node has several). The card and port must be ones pactl currently
 * lists, so a renderer can't pass arbitrary strings through to pactl.
 */
async function audioSelectPort(rawCard: unknown, rawPort: unknown): Promise<AudioDevices> {
  if (typeof rawCard !== 'string' || typeof rawPort !== 'string') {
    throw new Error('A card and port are required');
  }
  const card = (await pactlList<PactlCard>('cards')).find((c) => c.name === rawCard);
  const direction = portDirection(rawPort);
  const profile = card?.ports?.[rawPort] ? profileForPort(card, rawPort) : null;
  if (!card || !direction || !profile) throw new Error('That device is no longer available');

  await pactl(['set-card-profile', card.name, profile]);

  // The profile's nodes appear asynchronously; wait for the one with our port.
  const kind = direction === 'output' ? 'sinks' : 'sources';
  const deadline = Date.now() + PROFILE_SWITCH_WAIT_MS;
  while (Date.now() < deadline) {
    const node = (await pactlList<PactlNode>(kind)).find(
      (n) => n.properties?.['device.name'] === card.name && n.ports?.some((p) => p.name === rawPort),
    );
    if (node) {
      const type = direction === 'output' ? 'sink' : 'source';
      if (node.active_port !== rawPort) await pactl([`set-${type}-port`, node.name, rawPort]);
      await pactl([`set-default-${type}`, node.name]);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return audioDevices();
}

/**
 * Per-application playback streams. `wpctl status` doesn't print stream volume,
 * so each node's level is fetched individually (there are usually only a few).
 */
async function audioStreams(): Promise<{ available: boolean; streams: AudioStream[] }> {
  let nodes: { id: number; name: string }[];
  try {
    nodes = parseAudioStatus(await wpctl(['status'])).streamNodes;
  } catch (error) {
    if (messageOf(error) === 'wpctl-missing') return { available: false, streams: [] };
    throw error;
  }

  const streams = await Promise.all(
    nodes.map(async ({ id, name }) => {
      const out = await wpctl(['get-volume', String(id)]).catch(() => '');
      const match = out.match(/Volume:\s*([\d.]+)/);
      return {
        id,
        name,
        volume: match ? Math.round(Number.parseFloat(match[1]) * 100) : 100,
        muted: /MUTED/.test(out),
      };
    }),
  );
  return { available: true, streams };
}

/** Make a sink or source the default by node id. */
async function audioSetDefault(id: unknown): Promise<AudioDevices> {
  await wpctl(['set-default', String(validNodeId(id))]);
  return audioDevices();
}

/** Set any node's volume (0-MAX_VOLUME) by id - used for per-device and per-app control. */
async function audioSetNodeVolume(id: unknown, pct: unknown): Promise<void> {
  const node = validNodeId(id);
  const v = clampVolume(pct);
  await wpctl(['set-volume', '-l', WPCTL_LIMIT, String(node), `${v}%`]);
}

/** Mute or unmute any node by id. */
async function audioSetNodeMuted(id: unknown, muted: boolean): Promise<void> {
  await wpctl(['set-mute', String(validNodeId(id)), muted ? '1' : '0']);
}

// --- Test tone (pw-play a short generated sine to a chosen sink). ---

const PW_PLAY_TIMEOUT_MS = 5_000;
let testTonePath: string | null = null;

/** Lazily write a short 440 Hz sine WAV to a temp file; returns its path. */
function testToneFile(): string {
  if (testTonePath && fs.existsSync(testTonePath)) return testTonePath;
  const sampleRate = 48_000;
  const frames = Math.floor(sampleRate * 0.6);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    // Short linear fade in/out (~20ms) so the tone doesn't click.
    const env = Math.min(1, Math.min(i, frames - i) / (sampleRate * 0.02));
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * env * 0.3;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  const file = path.join(app.getPath('temp'), 'din-test-tone.wav');
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
  testTonePath = file;
  return file;
}

/** Play the test tone to a specific sink node via pw-play. */
async function audioTest(id: unknown): Promise<void> {
  const node = validNodeId(id);
  await tool('pw-play', ['--target', String(node), testToneFile()], PW_PLAY_TIMEOUT_MS);
}

function registerAudioHandlers(): void {
  ipcMain.handle('audio:status', async (event) => {
    assertShellSender(event);
    return audioStatus();
  });
  ipcMain.handle('audio:setVolume', async (event, pct) => {
    assertShellSender(event);
    return audioSetVolume(pct);
  });
  ipcMain.handle('audio:setMuted', async (event, muted) => {
    assertShellSender(event);
    return audioSetMuted(muted === true);
  });
  ipcMain.handle('audio:inputStatus', async (event) => {
    assertShellSender(event);
    return audioInputStatus();
  });
  ipcMain.handle('audio:setInputVolume', async (event, pct) => {
    assertShellSender(event);
    return audioSetInputVolume(pct);
  });
  ipcMain.handle('audio:setInputMuted', async (event, muted) => {
    assertShellSender(event);
    return audioSetInputMuted(muted === true);
  });
  ipcMain.handle('audio:devices', async (event) => {
    assertShellSender(event);
    return audioDevices();
  });
  ipcMain.handle('audio:streams', async (event) => {
    assertShellSender(event);
    return audioStreams();
  });
  ipcMain.handle('audio:setDefault', async (event, id) => {
    assertShellSender(event);
    return audioSetDefault(id);
  });
  ipcMain.handle('audio:selectPort', async (event, card, port) => {
    assertShellSender(event);
    return audioSelectPort(card, port);
  });
  ipcMain.handle('audio:setNodeVolume', async (event, id, pct) => {
    assertShellSender(event);
    return audioSetNodeVolume(id, pct);
  });
  ipcMain.handle('audio:setNodeMuted', async (event, id, muted) => {
    assertShellSender(event);
    return audioSetNodeMuted(id, muted === true);
  });
  ipcMain.handle('audio:test', async (event, id) => {
    assertShellSender(event);
    return audioTest(id);
  });
}

// ---------------------------------------------------------------------------
// System change events. The menu bar's network and audio indicators used to
// poll every few seconds; now long-running monitors (via the system worker,
// see system.mts) report changes as they happen, and the shell refreshes on
// those, keeping only a slow poll as a fallback where a monitor is missing.
// ---------------------------------------------------------------------------

/** Coalescing window: monitors print bursts of lines for one change. */
const SYSTEM_EVENT_DEBOUNCE_MS = 250;

/**
 * `pactl subscribe` reports every object PipeWire's Pulse layer has; only
 * these affect what the shell shows (default sink/source volume, devices,
 * per-app streams). Client and module churn is ignored.
 */
const AUDIO_EVENT = /on (sink|source|server|card|sink-input) /;

function registerSystemEvents(): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const changed = (topic: 'network' | 'audio') => {
    if (timers.has(topic)) return;
    timers.set(
      topic,
      setTimeout(() => {
        timers.delete(topic);
        sendToShell('system:changed', topic);
        // A mute or default-source change made anywhere (Settings, an app,
        // pactl in the Terminal) moves the mic-mute LED with it.
        if (topic === 'audio') void syncMicMuteLed();
        // Headphones that just came or went: switch to them, or pause.
        if (topic === 'audio') followAudioDevices();
        // A network with a proxy of its own may have come up or gone down.
        if (topic === 'network') void refreshWifiProxy().catch(() => {});
        // Tor reconnects, or goes quiet, with the network.
        if (topic === 'network') torNetworkChanged();
        // A network just joined has its AirPlay receivers looked for at once.
        if (topic === 'network') airplayNetworkChanged();
        // And its printers are listed again, before CUPS has browsed for them.
        if (topic === 'network') printingNetworkChanged();
      }, SYSTEM_EVENT_DEBOUNCE_MS),
    );
  };
  void syncMicMuteLed();
  followAudioDevices();
  watchCommand('network', 'nmcli', ['monitor'], () => changed('network'));
  watchCommand('audio', 'pactl', ['subscribe'], (line) => {
    if (AUDIO_EVENT.test(line)) changed('audio');
  });
}

// ---------------------------------------------------------------------------
// Headphones, as a Mac has them: plugging in or connecting a Bluetooth or USB
// audio device makes it the output (and, for a headset, the input too), with
// the volume display saying where sound now goes; taking away the device
// that was playing pauses what was playing, instead of letting it carry on
// out of the speakers. Devices are told apart by their card, which lasts as
// long as the device is there, so a Bluetooth headset switching between its
// music and call profiles, which swaps its sinks and sources for others, is
// neither a new device nor a lost one. (WirePlumber's own pausing, which
// can't tell the two apart, is off in os/configuration.nix.)
// ---------------------------------------------------------------------------

/** How long after a device appears its outputs and inputs may still follow. */
const AUDIO_ARRIVAL_MS = 5_000;
/** How long a device must stay gone before it counts as taken away. */
const AUDIO_DEPARTURE_MS = 1_000;

/** One sound device: its card, and the sinks and sources it has now. */
interface AudioCard {
  description: string;
  /** Plugged in or paired, rather than built in (Bluetooth or USB). */
  external: boolean;
  sink: string | null;
  source: string | null;
}

interface AudioSnapshot {
  cards: Map<string, AudioCard>;
  defaultSinkCard: string | null;
}

/** The sound devices there are now; throws when pactl can't tell. */
async function audioSnapshot(): Promise<AudioSnapshot> {
  const list = async (what: 'sinks' | 'sources') => {
    const parsed: unknown = JSON.parse(await pactl(['-f', 'json', 'list', what]));
    if (!Array.isArray(parsed)) throw new Error('pactl gave no list');
    return parsed as PactlNode[];
  };
  const [cardList, sinks, sources, defaultSink] = await Promise.all([
    pactl(['-f', 'json', 'list', 'cards']).then((out) => {
      const parsed: unknown = JSON.parse(out);
      if (!Array.isArray(parsed)) throw new Error('pactl gave no list');
      return parsed as PactlCard[];
    }),
    list('sinks'),
    list('sources'),
    pactl(['get-default-sink']).then((out) => out.trim()),
  ]);
  const cards = new Map<string, AudioCard>();
  for (const card of cardList) {
    const props = card.properties ?? {};
    cards.set(card.name, {
      description: props['device.description'] ?? card.name,
      external: props['device.bus'] === 'bluetooth' || props['device.bus'] === 'usb',
      sink: null,
      source: null,
    });
  }
  let defaultSinkCard: string | null = null;
  const add = (node: PactlNode, kind: 'sink' | 'source') => {
    const props = node.properties ?? {};
    // A sink's monitor is listed among the sources, but isn't an input.
    if (props['media.class'] !== (kind === 'sink' ? 'Audio/Sink' : 'Audio/Source')) return;
    const entry = cards.get(props['device.name'] ?? '');
    if (!entry) return;
    entry[kind] ??= node.name;
    if (kind === 'sink' && node.name === defaultSink) defaultSinkCard = props['device.name'];
  };
  for (const node of sinks) add(node, 'sink');
  for (const node of sources) add(node, 'source');
  return { cards, defaultSinkCard };
}

let audioSeen: AudioSnapshot | null = null;
/** Devices that just appeared: when, and what of theirs Din has switched to. */
const audioArrivals = new Map<string, { at: number; sink: boolean; source: boolean }>();
let audioFollowing: Promise<void> = Promise.resolve();

/** Look at the sound devices again (one look at a time). */
function followAudioDevices(): void {
  audioFollowing = audioFollowing.then(lookAtAudioDevices).catch(() => {});
}

async function lookAtAudioDevices(): Promise<void> {
  let now: AudioSnapshot;
  try {
    now = await audioSnapshot();
  } catch {
    return;
  }
  const before = audioSeen;
  audioSeen = now;
  // The first look is how things stand, not something that just happened.
  if (!before) return;

  for (const [card, info] of now.cards) {
    if (info.external && !before.cards.has(card)) audioArrivals.set(card, { at: Date.now(), sink: false, source: false });
  }
  for (const [card, arrival] of audioArrivals) {
    const info = now.cards.get(card);
    if (!info || Date.now() - arrival.at > AUDIO_ARRIVAL_MS) {
      audioArrivals.delete(card);
      continue;
    }
    if (info.sink && !arrival.sink) {
      arrival.sink = true;
      await pactl(['set-default-sink', info.sink]).catch(() => {});
      now.defaultSinkCard = card;
      void audioStatus()
        .then((status) => sendToShell('audio:osd', { ...status, device: info.description }))
        .catch(() => {});
    }
    // A headset's mic, not a webcam's or a USB microphone's on its own.
    if (info.sink && info.source && !arrival.source) {
      arrival.source = true;
      await pactl(['set-default-source', info.source]).catch(() => {});
    }
  }

  const playedThrough = before.defaultSinkCard;
  if (playedThrough && before.cards.get(playedThrough)?.external && !now.cards.has(playedThrough)) {
    setTimeout(() => {
      audioFollowing = audioFollowing
        .then(async () => {
          const again = await audioSnapshot().catch(() => null);
          if (again && !again.cards.has(playedThrough)) pauseAllMedia();
        })
        .catch(() => {});
    }, AUDIO_DEPARTURE_MS);
  }
}

/** Adjust the default sink and push the new state to the shell for the OSD. */
function pushAudioOsd(statusPromise: Promise<AudioState>): void {
  statusPromise.then((s) => sendToShell('audio:osd', s)).catch(() => {});
}

/** Push the default source's new state to the shell for the microphone OSD. */
function pushInputOsd(statusPromise: Promise<AudioState>): void {
  statusPromise.then((s) => sendToShell('audio:inputOsd', s)).catch(() => {});
}

/**
 * Global volume keys (VolumeUp/Down/Mute) under X11. Wayland has no global
 * key grabs (din-shell offers no GlobalShortcuts portal), so there these calls
 * would silently fail; the keys reach Din as ordinary input instead and
 * attachMediaKeys handles them. Harmless when wpctl is absent (the adjust
 * rejects and no OSD is shown).
 */
function registerMediaKeys(): void {
  if (process.env.WAYLAND_DISPLAY) return;
  globalShortcut.register('VolumeUp', () => pushAudioOsd(audioAdjust(5)));
  globalShortcut.register('VolumeDown', () => pushAudioOsd(audioAdjust(-5)));
  globalShortcut.register('VolumeMute', () => pushAudioOsd(audioToggleMute()));
  for (const [accelerator, key] of [
    ['MediaPlayPause', 'playpause'],
    ['MediaNextTrack', 'nexttrack'],
    ['MediaPreviousTrack', 'previoustrack'],
    ['MediaStop', 'stop'],
  ] as const) {
    globalShortcut.register(accelerator, () => sendToShell('media:key', key));
  }
}

/**
 * Play/pause, next, previous and stop keys, from keyboards and from Bluetooth
 * headsets (BlueZ turns their buttons into a keyboard of their own). Like
 * the volume keys they reach Din as the focused client's input, so they're
 * taken here and sent to the shell, which picks what they control (see
 * src/lib/nowPlaying.ts). The page never sees them: Chromium acting on the
 * key in a focused tab as well would toggle playback twice.
 */
const MEDIA_KEYS: Record<string, string> = {
  MediaPlayPause: 'playpause',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  MediaTrackNext: 'nexttrack',
  MediaTrackPrevious: 'previoustrack',
};

// ---------------------------------------------------------------------------
// Brightness bridge (window.dinos.brightness). Two independent halves:
//   - Screen backlight (/sys/class/backlight), via brightnessctl where
//     installed (DinOS ships it with udev rules that grant the `video`
//     group write access; see os/configuration.nix). Where it's absent (e.g.
//     a dev host), fall back to reading sysfs directly (world-readable) and
//     writing through systemd-logind's Session.SetBrightness D-Bus call,
//     which any active session may use without extra privileges.
//   - Night light / red shift, always on or on a schedule; see
//     night-light.mts.
// Below the backlight's floor, Din dims in software: brightness levels under
// 0 (down to MIN_BRIGHTNESS) hold the backlight at its lowest nonzero step and
// set dimLevel, which the shell draws as a black layer over the whole screen
// (src/components/desktop/ScreenDimmer.tsx). It isn't saved, so Din always
// starts at normal brightness.
// Either half reports available:false where its tool/device is absent. Same
// trust boundary as the other bridges: sender guard, argv execFile/spawn,
// values re-clamped here.
// ---------------------------------------------------------------------------

const BRIGHTNESSCTL_TIMEOUT_MS = 5_000;
const BACKLIGHT_CLASS = 'backlight';
/** Dimmest level, in percent below the backlight's floor. Keep in step with src/lib/brightness.ts. */
const MIN_BRIGHTNESS = -80;
let dimLevel = 0; // 0..-MIN_BRIGHTNESS, software dimming under the backlight's floor

/** Run brightnessctl with an argv array; resolves stdout, rejects with a clean message. */
function brightnessctl(args: string[], timeout = BRIGHTNESSCTL_TIMEOUT_MS): Promise<string> {
  return tool('brightnessctl', args, timeout);
}

/** Clamp a caller-supplied level to an integer MIN_BRIGHTNESS..100. */
function clampBrightness(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) throw new Error('Invalid brightness');
  return Math.max(MIN_BRIGHTNESS, Math.min(100, Math.round(n)));
}

/** Backlight level 0-100 via brightnessctl, null if no backlight device. */
async function brightnessctlGet(): Promise<number | null> {
  // Machine-readable: "device,class,current,40%,max".
  const out = await brightnessctl(['-m', '-c', BACKLIGHT_CLASS, 'info']);
  const line = out
    .trim()
    .split('\n')
    .find((l) => l.includes(`,${BACKLIGHT_CLASS},`));
  if (!line) return null;
  const match = (line.split(',')[3] || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

// --- Sysfs + logind fallback backend (no brightnessctl on the host). ---

const BACKLIGHT_SYS_DIR = '/sys/class/backlight';
type BacklightBackend = 'brightnessctl' | 'sysfs' | null;
let backlightBackendPromise: Promise<BacklightBackend> | null = null; // cached probe

/** First device under /sys/class/backlight, or null (desktops, VMs). */
function sysfsBacklightDevice(): string | null {
  try {
    return fs.readdirSync(BACKLIGHT_SYS_DIR).sort()[0] ?? null;
  } catch {
    return null;
  }
}

/** Read a small sysfs integer file; null if missing or non-numeric. */
function readSysInt(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Backlight level 0-100 straight from sysfs, null if unreadable. */
function sysfsBacklightGet(): number | null {
  const device = sysfsBacklightDevice();
  if (!device) return null;
  const current = readSysInt(path.join(BACKLIGHT_SYS_DIR, device, 'brightness'));
  const max = readSysInt(path.join(BACKLIGHT_SYS_DIR, device, 'max_brightness'));
  if (current === null || !max) return null;
  return Math.round((current / max) * 100);
}

/** Set the backlight to a raw sysfs value via logind's SetBrightness. */
async function logindSetBrightness(device: string, value: number): Promise<void> {
  await tool(
    'busctl',
    [
      'call',
      'org.freedesktop.login1',
      '/org/freedesktop/login1/session/auto',
      'org.freedesktop.login1.Session',
      'SetBrightness',
      'ssu',
      BACKLIGHT_CLASS,
      device,
      String(value),
    ],
    BRIGHTNESSCTL_TIMEOUT_MS,
  );
}

/** Resolve (and cache) which backlight backend works on this machine. */
function ensureBacklightBackend(): Promise<BacklightBackend> {
  if (!backlightBackendPromise) {
    backlightBackendPromise = (async () => {
      try {
        if ((await brightnessctlGet()) !== null) return 'brightnessctl';
      } catch {
        // brightnessctl missing or failing; fall through to sysfs.
      }
      return sysfsBacklightGet() !== null ? 'sysfs' : null;
    })();
  }
  return backlightBackendPromise;
}

/**
 * Backlight level 0-100, or null. Read from sysfs whenever it's readable
 * (it's world-readable on Linux): the menu bar polls this, and a file read
 * costs nothing next to running brightnessctl. brightnessctl stays the way
 * to *change* the level where the sysfs file isn't writable.
 */
async function backlightGet(): Promise<number | null> {
  const direct = sysfsBacklightGet();
  if (direct !== null) return direct;
  const backend = await ensureBacklightBackend();
  if (backend === 'brightnessctl') return brightnessctlGet();
  if (backend === 'sysfs') return sysfsBacklightGet();
  return null;
}

/**
 * Set the backlight to a 0-100 percentage via the active backend. 0 is the
 * lowest nonzero raw step, never off.
 */
async function backlightSet(pct: number): Promise<void> {
  const backend = await ensureBacklightBackend();
  if (backend === 'brightnessctl') {
    await brightnessctl(['-c', BACKLIGHT_CLASS, 'set', pct > 0 ? `${pct}%` : '1']);
    return;
  }
  if (backend !== 'sysfs') throw new Error('no-backlight');
  const device = sysfsBacklightDevice();
  const max = device
    ? readSysInt(path.join(BACKLIGHT_SYS_DIR, device, 'max_brightness'))
    : null;
  if (!device || !max) throw new Error('no-backlight');
  const raw = Math.max(1, Math.round((pct / 100) * max));
  try {
    // Direct write works where udev has granted this user access.
    fs.writeFileSync(path.join(BACKLIGHT_SYS_DIR, device, 'brightness'), String(raw));
  } catch {
    await logindSetBrightness(device, raw);
  }
}

/** The full brightness state as reported to the shell. */
interface BrightnessState {
  available: boolean;
  brightness: number | null;
  nightLight: NightLightState;
}

/** Backlight level + night-light state; per-half available:false when a tool is absent. */
async function brightnessStatus(): Promise<BrightnessState> {
  await ensureNightLightTool();
  let available = false;
  let brightness: number | null = null;
  try {
    brightness = await backlightGet();
    available = brightness !== null;
  } catch {
    // brightnessctl missing or no backlight device: keep the unavailable
    // defaults above.
  }
  if (available && dimLevel > 0) brightness = -dimLevel;
  return { available, brightness, nightLight: nightLightStatus() };
}

/** Set a MIN_BRIGHTNESS..100 level: the backlight above 0, software dimming below. */
async function brightnessSet(pct: unknown): Promise<BrightnessState> {
  const level = clampBrightness(pct);
  await backlightSet(Math.max(0, level));
  dimLevel = Math.max(0, -level);
  return brightnessStatus();
}

const brightnessKnock = { at: 0 };

/** Relative nudge for the media keys, with the detent at 0 (see stepWithDetent). */
async function brightnessAdjust(deltaPct: number): Promise<BrightnessState> {
  const status = await brightnessStatus();
  if (status.brightness === null) throw new Error('no-backlight');
  const next = stepWithDetent(
    status.brightness,
    deltaPct,
    { min: 0, max: 100, underMin: MIN_BRIGHTNESS },
    brightnessKnock,
  );
  if (next === status.brightness) return status;
  return brightnessSet(next);
}

/**
 * Undo the software dimming in a capture of the shell, which includes the
 * dimming layer. Lossy at deep dimming, but screenshots and the genie
 * animation's snapshots come out at normal brightness.
 */
function undimCapture(image: Electron.NativeImage): Electron.NativeImage {
  if (dimLevel === 0) return image;
  const gain = 1 / (1 - dimLevel / 100);
  const size = image.getSize();
  const pixels = image.toBitmap();
  for (let i = 0; i < pixels.length; i++) {
    if ((i & 3) !== 3) pixels[i] = Math.min(255, Math.round(pixels[i] * gain));
  }
  // The bitmap is at device resolution; getSize() is in DIPs.
  const scaleFactor = Math.sqrt(pixels.length / 4 / (size.width * size.height));
  return nativeImage.createFromBitmap(pixels, {
    width: Math.round(size.width * scaleFactor),
    height: Math.round(size.height * scaleFactor),
    scaleFactor,
  });
}

/**
 * Place a capture of `captured` where it sits in `whole` (both in DIPs), on
 * a transparent image the size of `whole` at the capture's resolution.
 */
function padCapture(
  image: Electron.NativeImage,
  captured: Electron.Rectangle,
  whole: Electron.Rectangle,
): Electron.NativeImage {
  const size = image.getSize();
  const ratio = size.width / captured.width;
  const outW = Math.round(whole.width * ratio);
  const outH = Math.round(whole.height * ratio);
  const dx = Math.round((captured.x - whole.x) * ratio);
  const dy = Math.round((captured.y - whole.y) * ratio);
  const src = image.toBitmap();
  const out = Buffer.alloc(outW * outH * 4);
  const rowW = Math.min(size.width, outW - dx);
  for (let row = 0; row < size.height && dy + row < outH; row++) {
    src.copy(out, ((dy + row) * outW + dx) * 4, row * size.width * 4, (row * size.width + rowW) * 4);
  }
  return nativeImage.createFromBitmap(out, { width: outW, height: outH });
}


/**
 * Brightness, volume and playback media keys (mic-mute is read from evdev; see
 * watchEvdevKeys). Electron's accelerator grammar has no brightness key
 * names, and on Wayland globalShortcut can't grab anything,
 * but the compositor delivers XF86MonBrightness* and XF86Audio* keys to the
 * focused client as ordinary keyboard input ("BrightnessUp",
 * "AudioVolumeUp", ...). Din is that client, so intercept them in
 * before-input-event - attached to every webContents, since focus may live
 * inside a <webview> guest - adjust the backlight or sink, and push the new
 * state to the shell for the OSD.
 */
function attachMediaKeys(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key === 'Unidentified' ? input.code : input.key;
    if (key === 'AudioVolumeUp' || key === 'AudioVolumeDown' || key === 'AudioVolumeMute') {
      event.preventDefault();
      if (key === 'AudioVolumeUp') pushAudioOsd(audioAdjust(5));
      else if (key === 'AudioVolumeDown') pushAudioOsd(audioAdjust(-5));
      else pushAudioOsd(audioToggleMute());
      return;
    }
    const mediaKey = MEDIA_KEYS[key];
    if (mediaKey) {
      event.preventDefault();
      if (!input.isAutoRepeat) sendToShell('media:key', mediaKey);
      return;
    }
    let delta: number | null = null;
    if (input.key === 'BrightnessUp' || input.code === 'BrightnessUp') delta = 5;
    if (input.key === 'BrightnessDown' || input.code === 'BrightnessDown') delta = -5;
    if (delta === null) return;
    event.preventDefault();
    brightnessAdjust(delta)
      .then((s) => sendToShell('brightness:osd', s))
      .catch(() => {});
  });
}

function registerBrightnessHandlers(): void {
  startNightLight();
  ipcMain.handle('brightness:status', async (event) => {
    assertShellSender(event);
    return brightnessStatus();
  });
  ipcMain.handle('brightness:setBrightness', async (event, pct) => {
    assertShellSender(event);
    return brightnessSet(pct);
  });
  ipcMain.handle('brightness:setNightLight', async (event, enabled) => {
    assertShellSender(event);
    await setNightLightEnabled(enabled === true);
    return brightnessStatus();
  });
  ipcMain.handle('brightness:setTemperature', async (event, kelvin) => {
    assertShellSender(event);
    await setNightLightTemperature(kelvin);
    return brightnessStatus();
  });
  ipcMain.handle('brightness:setNightLightSchedule', async (event, schedule) => {
    assertShellSender(event);
    await setNightLightSchedule(schedule);
    return brightnessStatus();
  });
}

// ---------------------------------------------------------------------------
// Screenshot bridge (window.dinos.screenshot), backed by the screenshot:* handler
// below. Captures the shell window's rendered contents - the whole Din desktop
// (wallpaper, open windows, menu bar, dock) - as a PNG via Electron's
// compositor (webContents.capturePage). No display-server capture API, so it
// works on any session (din-shell/Wayland or bare X11) with no external tool.
// Absent in a plain browser, where the Screenshot app feature-detects and
// shows a fallback. Same trust boundary as the other bridges: sender guard.
// ---------------------------------------------------------------------------

function registerScreenshotHandlers(): void {
  ipcMain.handle('screenshot:capture', async (event) => {
    assertShellSender(event);
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Shell window unavailable');
    }
    const image = undimCapture(await shellWindow.webContents.capturePage());
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) {
      throw new Error('Captured an empty image');
    }
    // A PNG data URL survives structured clone and drops straight into an
    // <img> / fetch() in the renderer (see src/lib/screenshot.ts).
    return { dataUrl: image.toDataURL(), width, height };
  });

  // Capture just one window's on-screen rectangle, for the genie
  // minimize/restore animation: warping a full-screen <webview> with a
  // projective transform can't be a compositor-only op (the guest surface
  // re-rasterizes every frame), so the renderer snapshots the window to a
  // bitmap and warps that cheap <img> instead (see src/components/desktop/
  // Window.tsx). The rect is in the window's DIPs (the preload converts from
  // zoomed CSS pixels) relative to the shell content's top-left;
  // capturePage returns it at device resolution. A window partly off the
  // screen comes back the size of the whole rect, its hidden part
  // transparent, so the effect lines it up with the window. Asked for a
  // smaller `scale` (cursor effects' water wants the whole screen, fast), it
  // comes back shrunk and as a JPEG, which is far quicker to encode.
  ipcMain.handle('screenshot:captureRegion', async (event, rect, options) => {
    assertShellSender(event);
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Shell window unavailable');
    }
    const [contentW, contentH] = shellWindow.getContentSize();
    const num = (value: unknown): number => {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) throw new Error('Invalid capture region');
      return n;
    };
    const asked = { x: num(rect?.x), y: num(rect?.y), width: Math.max(1, num(rect?.width)), height: Math.max(1, num(rect?.height)) };
    const x = Math.max(0, Math.min(contentW - 1, asked.x));
    const y = Math.max(0, Math.min(contentH - 1, asked.y));
    const width = Math.max(1, Math.min(contentW, asked.x + asked.width) - x);
    const height = Math.max(1, Math.min(contentH, asked.y + asked.height) - y);
    let image = undimCapture(await shellWindow.webContents.capturePage({ x, y, width, height }));
    let size = image.getSize();
    if (size.width === 0 || size.height === 0) {
      throw new Error('Captured an empty image');
    }
    const clipped = x !== asked.x || y !== asked.y || width !== asked.width || height !== asked.height;
    // Not for a rect much bigger than the screen, which can't be a window.
    if (clipped && asked.width * asked.height <= 4 * contentW * contentH) {
      image = padCapture(image, { x, y, width, height }, asked);
      size = image.getSize();
    }
    const scale = Number(options?.scale);
    if (Number.isFinite(scale) && scale >= 0.1 && scale < 1) {
      image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'good' });
      size = image.getSize();
      return { dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`, width: size.width, height: size.height };
    }
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
  });

  // Put a capture on the clipboard. Done here rather than with
  // navigator.clipboard in the renderer, which refuses unless the shell
  // document has focus - and a Print Screen pressed inside a <webview> guest
  // leaves the focus in the guest.
  ipcMain.handle('screenshot:copy', (event, dataUrl) => {
    assertShellSender(event);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('Invalid image');
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('Invalid image');
    clipboard.writeImage(image);
  });
}

// ---------------------------------------------------------------------------
// Keys Chromium can't identify, read from evdev instead:
//
// - The laptop "box select" screenshot key. Newer laptop keyboards carry a
//   dedicated area-screenshot key (dashed-box icon) next to Print Screen; the
//   kernel delivers it as evdev KEY_SELECTIVE_SCREENSHOT, which XKB turns
//   into the XF86SelectiveScreenshot keysym. It becomes the
//   'screenshot-area' shortcut.
// - The mic-mute key (KEY_MICMUTE, keysym XF86AudioMicMute; on ThinkPads it
//   comes from the "ThinkPad Extra Buttons" device). It toggles the default
//   source's mute.
// - The display-switch key (KEY_SWITCHVIDEOMODE, keysym XF86Display; F7 on
//   ThinkPads, again from "ThinkPad Extra Buttons"). It switches an AirPlay
//   receiver between extending the desktop and mirroring it.
//
// Chromium has no DOM key for these keysyms, and its code for KEY_MICMUTE
// has no name, so before-input-event reports them as key "Unidentified",
// code "" - indistinguishable from any other unmapped key. GNOME/KDE handle
// these at the evdev level; do the same: read the keyboard event nodes
// directly.
//
// Reading /dev/input needs the `input` group (DinOS grants it to the
// desktop user); anywhere else the watcher just stays off. The main process
// already observes every keystroke via before-input-event, and nothing here
// is exposed to renderers, so no new capability crosses a trust boundary.
// ---------------------------------------------------------------------------

const EV_KEY = 0x01;
const KEY_SWITCHVIDEOMODE = 0xe3;
const KEY_MICMUTE = 0xf8;
const KEY_SELECTIVE_SCREENSHOT = 0x27a;
/** struct input_event on 64-bit Linux: 16-byte timeval + type + code + value. */
const INPUT_EVENT_SIZE = 24;

/** The /dev/input/event* nodes of keyboard devices, per /proc/bus/input/devices. */
function keyboardEventNodes(): string[] {
  let data: string;
  try {
    data = fs.readFileSync('/proc/bus/input/devices', 'utf8');
  } catch {
    return [];
  }
  const nodes: string[] = [];
  for (const block of data.split('\n\n')) {
    // Only devices with the "kbd" handler report key events (mice etc. don't).
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1] ?? '';
    if (!/(^|\s)kbd(\s|$)/.test(handlers)) continue;
    for (const m of handlers.matchAll(/event\d+/g)) nodes.push(`/dev/input/${m[0]}`);
  }
  return nodes;
}

function watchEvdevKeys(): void {
  if (process.platform !== 'linux') return;
  const watched = new Map<string, ChildProcess>();
  const scan = () => {
    for (const node of keyboardEventNodes()) {
      if (watched.has(node)) continue;
      // Outside the input group (Din's session on another distribution)
      // none can be read, and spawning a `cat` for each on every rescan
      // forked this whole process six times every ten seconds, stalling
      // Din's frames by ~130 ms each time.
      try {
        fs.accessSync(node, fs.constants.R_OK);
      } catch {
        continue;
      }
      let leftover: Buffer = Buffer.alloc(0);
      // Read through `cat` and a pipe, not fs.createReadStream: a file stream
      // parks one of libuv's four threadpool threads in read() for as long as
      // the device is open, and laptops have four or more "keyboards" (sleep
      // button, video bus, vendor hotkeys...). With the pool full, every
      // async fs call in this process waits forever and the shell never
      // loads - a black screen on a ThinkPad P14s Gen 7 AMD.
      const reader = spawn('cat', [node], { stdio: ['ignore', 'pipe', 'ignore'] });
      watched.set(node, reader);
      const stream = reader.stdout;
      stream.on('data', (chunk: string | Buffer) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        const buf = leftover.length > 0 ? Buffer.concat([leftover, data]) : data;
        const full = buf.length - (buf.length % INPUT_EVENT_SIZE);
        for (let off = 0; off < full; off += INPUT_EVENT_SIZE) {
          // value 1 = press (0 = release, 2 = autorepeat).
          if (buf.readUInt16LE(off + 16) !== EV_KEY || buf.readInt32LE(off + 20) !== 1) continue;
          const code = buf.readUInt16LE(off + 18);
          if (code === KEY_SELECTIVE_SCREENSHOT) sendToShell('shortcut', { action: 'screenshot-area' });
          else if (code === KEY_MICMUTE) pushInputOsd(audioToggleInputMute());
          else if (code === KEY_SWITCHVIDEOMODE) switchAirPlayMode();
        }
        leftover = buf.subarray(full);
      });
      const unwatch = () => {
        if (watched.get(node) === reader) watched.delete(node);
      };
      // Unreadable (permissions) or unplugged: drop it so the next rescan
      // can retry (or pick up a replacement keyboard).
      reader.on('error', unwatch);
      reader.on('exit', unwatch);
    }
  };
  // cat only notices its reader is gone on its next write, which may never
  // come; stop the readers with the app.
  app.on('will-quit', () => {
    for (const reader of watched.values()) reader.kill();
  });
  scan();
  // Keyboards come and go (docks, USB/BT keyboards): rescan periodically.
  setInterval(scan, 10_000).unref();
}

// ---------------------------------------------------------------------------
// Chrome extension support (the web browser app).
//
// electron-chrome-extensions implements the chrome.* extension APIs that
// Electron itself lacks (tabs, actions, popups, ...), and
// electron-chrome-web-store lets users install extensions by browsing the
// Chrome Web Store inside the browser app. Everything is scoped to the
// browser's session partition (persist:webbrowser):
//   - extensions run against web pages only, browser tabs and installed apps'
//     windows (which share the session, as Chrome's installed apps share its
//     profile); they can never see the shell's origin (where app data lives)
//     or its privileged bridges
//   - the shell's own session (defaultSession) never loads extensions
//
// Tab model: the shell renders browser tabs as <webview> elements, so each
// tab is a guest WebContents owned by the shell window. Guests are registered
// with the extension system as they're created (web-contents-created below).
// An installed app's window isn't a tab: it never becomes chrome.tabs' active
// tab or gets the browser's toolbar actions.
// Extension-initiated tab operations (chrome.tabs.create/update/remove and
// window.open) are bridged to the shell renderer over IPC (window.dinos.crx in
// preload.cjs), which creates/activates/closes the corresponding tab UI.
//
// IMPORTANT: never attach session.webRequest listeners to the browser
// session; doing so silently disables chrome.webRequest for extensions
// (which content blockers like uBlock Origin depend on).
// ---------------------------------------------------------------------------

// The browser's profile: its tabs, and installed web apps' windows
// (WebAppFrame), which are the same sites and so share their storage, logins
// and permissions, as Chrome's installed apps do. What makes a guest an app
// window is the shell saying so when it attaches (see isAppGuest).
const WEBBROWSER_PARTITION = 'persist:webbrowser';

// Private ("incognito") browser windows run their tabs in this partition.
// Deliberately NOT prefixed with `persist:`, so Electron keeps it in memory
// only - cookies/storage/cache are discarded once the last private tab closes.
// Guests here are hardened like every other <webview> (see will-attach-webview)
// but get no extension system, NIP-07, highlight, or userscript wiring, which
// is bound to the persistent browser session. Must match
// WEBBROWSER_PRIVATE_PARTITION in src/components/desktop/apps/BrowserView.tsx.
const WEBBROWSER_PRIVATE_PARTITION = 'din-webbrowser-private';

// Browser tabs on onion services, from normal and private windows alike, run
// in this partition, whose every request goes through Tor (network.mts). A
// tab moves in and out of it as it goes to and from .onion addresses (see
// keepTorSession). Kept in memory and treated like the private session: no
// extensions, NIP-07 or saved certificate exceptions. Must match
// WEBBROWSER_TOR_PARTITION in src/components/desktop/apps/BrowserView.tsx.
const WEBBROWSER_TOR_PARTITION = 'din-webbrowser-tor';

/**
 * Absolute path to the session preload that gives web pages a NIP-07
 * window.nostr backed by Din's signer (see registerNostrBridge): browser tabs
 * and installed web apps, never private tabs.
 */
const NOSTR_PRELOAD = path.join(import.meta.dirname, 'nostr-preload.cjs');

/**
 * Absolute path to the preload injected into the ad-hoc Web Browser's tabs.
 * Adds the NIP-84 "Highlight" affordance (text selection -> kind 9802). It
 * only relays an explicit highlight click to the shell (see din-highlight:*);
 * window.nostr comes from NOSTR_PRELOAD.
 */
const HIGHLIGHT_PRELOAD = path.join(import.meta.dirname, 'browser-highlight-preload.cjs');

/**
 * Absolute path to the session preload that puts web pages' notifications
 * in Din's notification center (see electron/notifications.mts). Every page
 * gets it - browser tabs, private ones, and installed web apps.
 */
const NOTIFICATION_PRELOAD = path.join(import.meta.dirname, 'notification-preload.cjs');

/**
 * Absolute path to the session preload that answers web pages'
 * navigator.geolocation from GeoClue (see electron/geolocation.mts). Every
 * page gets it - browser tabs, private ones, and installed web apps.
 */
const GEOLOCATION_PRELOAD = path.join(import.meta.dirname, 'geolocation-preload.cjs');

/**
 * Absolute path to the session preload that has navigator.permissions.query
 * say "prompt" for what the user hasn't answered yet (see
 * site-permissions:state). Every page gets it.
 */
const PERMISSIONS_PRELOAD = path.join(import.meta.dirname, 'permissions-preload.cjs');

/**
 * Absolute path to the session preload that gives window.chrome the `app`
 * object Chrome has, without which Google's sign-in refuses the browser as
 * not secure. Every page gets it, in every frame.
 */
const CHROME_APP_PRELOAD = path.join(import.meta.dirname, 'chrome-app-preload.cjs');

/**
 * Absolute path to the session preload that sends web pages' print() to
 * Din's print dialog (see electron/printing.mts). Every page gets it, in
 * every frame.
 */
const PRINT_PRELOAD = path.join(import.meta.dirname, 'print-preload.cjs');

/**
 * Absolute path to the session preload that tells Din when a web page is
 * sharing the screen, so the menu bar can show it and stop it (see
 * electron/screen-share.mts). Every page gets it, in every frame.
 */
const SCREEN_SHARE_PRELOAD = path.join(import.meta.dirname, 'screen-share-preload.cjs');

/**
 * Absolute path to the session preload that gives web pages Din's
 * EyeDropper in place of Chromium's, which can't capture the screen under
 * din-shell (see electron/eyedropper.mts). Every page gets it, in every frame.
 */
const EYEDROPPER_PRELOAD = path.join(import.meta.dirname, 'eyedropper-preload.cjs');

/**
 * Absolute path to the session preload that tells Din what a web page is
 * playing, for the volume menu's media controls (see electron/media.mts).
 * Every page gets it, in every frame.
 */
const MEDIA_PRELOAD = path.join(import.meta.dirname, 'media-preload.cjs');

/**
 * Absolute path to the session preload that autofills logins from Passwords
 * (see electron/passwords.mts). Every page gets it, in every frame.
 */
const PASSWORDS_PRELOAD = path.join(import.meta.dirname, 'passwords-preload.cjs');

/**
 * Absolute path to the session preload that tells Din where the caret is as
 * keys are typed in web pages, while power mode is on (electron/power-mode.mts);
 * power-mode-preload.cjs with src/shared/caret.ts bundled in
 * (scripts/build-din-runtime.mjs).
 */
const POWER_MODE_PRELOAD = path.join(import.meta.dirname, 'power-mode-preload.built.cjs');

/**
 * Absolute path to the session preload that gives installed nsites the napp
 * runtime (see electron/napp.mts): window.napp, notifications and periodic
 * sync from the page and the service worker, and window.ENV. Registered on
 * the browser session for frames and for service workers alike, where it
 * works for an installed nsite in its app window and in a tab.
 */
const NAPP_PRELOAD = path.join(import.meta.dirname, 'napp-preload.cjs');
// Built-in apps' preload: their ports to the desktop and main, nothing else.
// din-app-preload.cjs with window.din's runtime bundled in (scripts/build-din-runtime.mjs).
const DIN_APP_PRELOAD = path.join(import.meta.dirname, 'din-app-preload.built.cjs');
// Built-in apps' service workers (electron/din-app-workers.mts): periodic sync
// and notifications from a registration, for the page and the worker.
const DIN_APP_WORKER_PRELOAD = path.join(import.meta.dirname, 'din-app-worker-preload.cjs');
// Widgets' preload: frames the widget and relays its messages to the desktop.
const WIDGET_PRELOAD = path.join(import.meta.dirname, 'widget-preload.cjs');

/**
 * Absolute path to the session preload that gives websites Web Push and what
 * goes with it (see electron/web-push.mts): registration.pushManager,
 * notifications from a registration, and the worker's push and notification
 * events. Registered on the browser and apps sessions for frames and service
 * workers alike.
 */
const WEB_PUSH_PRELOAD = path.join(import.meta.dirname, 'web-push-preload.cjs');

/** The BrowserWindow hosting the shell (set at startup). */
let shellWindow: BrowserWindow | null = null;

/** The extension system for the browser session (set at startup). */
let chromeExtensions: ElectronChromeExtensions | null = null;

/** Extensions from folders and from Nostr (set at startup). */
let browserExtensions: ReturnType<typeof registerBrowserExtensionHandlers> | null = null;

/**
 * The `src` of the <webview> guest currently being attached. Electron emits
 * `will-attach-webview` immediately before it constructs the guest's
 * WebContents, so the `web-contents-created` hook can read the URL the guest
 * is about to load - `contents.getURL()` is still empty that early, and the
 * guest's initial URL is what decides whether it's a browser tab (see
 * isExtensionPageGuest).
 */
let attachingGuestSrc = '';

/**
 * Whether the <webview> guest currently being attached is an installed app's
 * window, handed to web-contents-created like attachingGuestSrc. The shell
 * says so in the element's `webpreferences` (APP_GUEST_MARK); only the shell
 * creates <webview>s, so a page can't claim it.
 */
let attachingGuestIsApp = false;

/** What the shell puts in an installed app's <webview> `webpreferences`. */
const APP_GUEST_MARK = 'dinInstalledApp=yes';

/** Where Chrome Web Store installs / unpacked extensions live on disk. */
function extensionsPath(): string {
  return path.join(app.getPath('userData'), 'Extensions');
}

/** The session all browser <webview> tabs run in. */
function browserSession(): Electron.Session {
  return session.fromPartition(WEBBROWSER_PARTITION);
}

/**
 * The ephemeral session shared by every private ("incognito") browser tab.
 * Kept in memory only (non-`persist:` partition), so it's discarded once the
 * last private window closes.
 */
function privateBrowserSession(): Electron.Session {
  return session.fromPartition(WEBBROWSER_PRIVATE_PARTITION);
}

/** The in-memory session browser tabs on onion services run in, through Tor. */
function torBrowserSession(): Electron.Session {
  return session.fromPartition(WEBBROWSER_TOR_PARTITION);
}

/** Whether a session is one the browser runs tabs in. */
function isBrowserTabSession(s: Electron.Session): boolean {
  return s === browserSession() || isEphemeralBrowserSession(s);
}

/** Whether a session is a browser one that keeps nothing: the private one, or Tor's. */
function isEphemeralBrowserSession(s: Electron.Session): boolean {
  return s === privateBrowserSession() || s === torBrowserSession();
}

/** Send an event to the shell renderer, if it's still alive. */
function sendToShell(channel: string, payload?: unknown): void {
  if (shellWindow && !shellWindow.webContents.isDestroyed()) {
    shellWindow.webContents.send(channel, payload);
  }
  forwardPushToGrants(channel, [payload]);
}

/** How often, at most, a guest's pointer moves are forwarded to the shell. */
const GUEST_MOVE_INTERVAL_MS = 16;
/** How often, at most, a wheel over an unfocused guest is forwarded to the shell. */
const GUEST_WHEEL_INTERVAL_MS = 250;

/**
 * Pointer input inside a <webview> guest goes to the guest's own document and
 * never reaches the shell's, so the shell can't react to it: popovers and
 * menus stay open over a click into the page, and the dock can't tell the
 * pointer moved over one. Forward what the shell reacts to - button presses
 * and releases, and moves (at most one per frame) - so GuestInputHost can
 * replay it on the guest's <webview> element, and cursor effects can follow
 * the pointer over pages. Coordinates are in DIPs, in the guest's view
 * (x, y) and, where the event has a screen position, the shell's (sx, sy)
 * (verified on Electron 41: the shell's interface zoom isn't applied).
 *
 * A guest's own `focus` event would be the obvious way to report focus too,
 * but it never fires for <webview> guests (also verified), so the shell
 * treats a press as focusing the page instead.
 */
/** The shell's own shortcuts, pressed in a built-in app or a widget, go to the shell. */
function forwardShellShortcuts(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input) => {
    const shortcut = shellShortcutForInput(input);
    if (
      shortcut?.action === 'cycle-windows' ||
      shortcut?.action === 'apps-menu' ||
      shortcut?.action === 'assistant' ||
      shortcut?.action === 'dictation' ||
      shortcut?.action === 'system-monitor' ||
      shortcut?.action === 'security-options' ||
      shortcut?.action === 'focus-area' ||
      shortcut?.action === 'screenshot' ||
      shortcut?.action === 'screenshot-area' ||
      shortcut?.action === 'wm'
    ) {
      claimGuestKey(contents, event, input);
      sendToShell('shortcut', shortcut);
    }
  });
}

/**
 * Spelling suggestions, cut, copy and paste for a text field in contents
 * that draw their own menus (the desktop, built-in apps, widgets).
 */
function popupEditMenu(contents: Electron.WebContents, params: Electron.ContextMenuParams): void {
  if (!params.isEditable) return;
  const { editFlags } = params;
  const menu = new Menu();
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(new MenuItem({ label: suggestion.replace(/&/g, '&&'), click: () => contents.replaceMisspelling(suggestion) }));
    }
    if (params.dictionarySuggestions.length === 0) {
      menu.append(new MenuItem({ label: 'No Guesses Found', enabled: false }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({
        label: 'Add to Dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }),
    );
    menu.append(new MenuItem({ type: 'separator' }));
  }
  if (editFlags.canCut) menu.append(new MenuItem({ role: 'cut' }));
  if (editFlags.canCopy) menu.append(new MenuItem({ role: 'copy' }));
  if (editFlags.canPaste) menu.append(new MenuItem({ role: 'paste' }));
  if (menu.items.length > 0) {
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ role: 'selectAll' }));
  }
  if (menu.items.length === 0) return;
  setImmediate(() => {
    if (shellWindow && !shellWindow.isDestroyed()) menu.popup({ window: shellWindow });
  });
}

function forwardGuestInput(contents: Electron.WebContents): void {
  const wcId = contents.id;
  // Where the pointer is in the shell's own view, from the event's screen
  // position: the guest's view moves with its window, so a window being
  // dragged by a press inside it can't place itself by the guest-local
  // point plus where the shell has the guest now (that's already moved on,
  // and the error feeds back into the drag).
  const inShell = (mouse: Electron.MouseInputEvent): { sx: number; sy: number } | null => {
    if (typeof mouse.globalX !== 'number' || typeof mouse.globalY !== 'number') return null;
    if (!shellWindow || shellWindow.isDestroyed()) return null;
    const content = shellWindow.getContentBounds();
    return { sx: mouse.globalX - content.x, sy: mouse.globalY - content.y };
  };
  let pendingMove: { x: number; y: number; sx?: number; sy?: number; meta: boolean } | null = null;
  let moveTimer: NodeJS.Timeout | null = null;
  let wheelAt = -Infinity;
  const flushMove = (): void => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    if (!pendingMove) return;
    sendToShell('guest:input', { wcId, type: 'move', ...pendingMove });
    pendingMove = null;
  };
  contents.on('before-mouse-event', (_event, mouse) => {
    // Super's state rides along: the shell reads it off pointer events to
    // keep its Super+drag grab layer in sync (src/lib/superKey.ts), and a
    // replayed move without it would read as Super released.
    const meta = mouse.modifiers?.includes('meta') ?? false;
    if (mouse.type === 'mouseMove') {
      pendingMove = { x: mouse.x, y: mouse.y, ...inShell(mouse), meta };
      moveTimer ??= setTimeout(flushMove, GUEST_MOVE_INTERVAL_MS);
    } else if (mouse.type === 'mouseDown') {
      // Keep the order the guest saw: the move that led here comes first.
      flushMove();
      sendToShell('guest:input', { wcId, type: 'down', x: mouse.x, y: mouse.y, ...inShell(mouse), button: mouse.button ?? 'left', meta });
    } else if (mouse.type === 'mouseUp') {
      flushMove();
      sendToShell('guest:input', { wcId, type: 'up', x: mouse.x, y: mouse.y, ...inShell(mouse), button: mouse.button ?? 'left', meta });
    } else if (mouse.type === 'mouseWheel') {
      // Now and then: a scroll is a burst of these, and the shell only
      // needs to hear of one (to hand the page the keyboard, if it lacks
      // it, so scroll keys follow the wheel).
      const now = Date.now();
      if (now - wheelAt < GUEST_WHEEL_INTERVAL_MS) return;
      wheelAt = now;
      flushMove();
      sendToShell('guest:input', { wcId, type: 'wheel', x: mouse.x, y: mouse.y, ...inShell(mouse), meta });
    }
  });
  contents.once('destroyed', () => {
    if (moveTimer) clearTimeout(moveTimer);
  });
}

/**
 * Resolve a renderer-supplied WebContents id to a browser-tab guest, or null.
 * Only <webview> guests inside the browser partition qualify, and installed
 * apps' windows, which share it, don't; anything else (the shell itself,
 * popups, stale ids) is rejected.
 */
function browserTabFromId(wcId: unknown): Electron.WebContents | null {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (contents.session !== browserSession() || isAppGuest(contents)) return null;
  return contents;
}

/**
 * Like {@link browserTabFromId}, but accepts guests in *either* browser session
 * (persistent or the ephemeral private one). Used by the TLS-trust path, which
 * applies to private tabs too; the crx handlers keep the stricter resolver
 * above since extensions never run in the private session.
 */
function anyBrowserTabFromId(wcId: unknown): Electron.WebContents | null {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (!isBrowserTabSession(contents.session) || isAppGuest(contents)) return null;
  return contents;
}

/**
 * Installed apps' windows, by WebContents id: guests the shell attached with
 * APP_GUEST_MARK, in the browser session (recorded in web-contents-created).
 */
const appGuests = new Set<number>();

/**
 * Whether a WebContents is an installed web app's window: connected to the
 * user's Nostr account by being installed, pinned to its origin, and not a
 * browser tab, though it shares the browser's session.
 */
function isAppGuest(contents: Electron.WebContents | null | undefined): boolean {
  return (
    !!contents &&
    !contents.isDestroyed() &&
    contents.getType() === 'webview' &&
    contents.session === browserSession() &&
    appGuests.has(contents.id)
  );
}

/**
 * The origin each installed app's window is pinned to, keyed by WebContents
 * id (recorded in web-contents-created from its first committed load).
 * Navigations away from it are handed to the Web Browser, and only this
 * origin may use the Nostr identity bridge as the app.
 */
const appGuestOrigins = new Map<number, string>();

/** The origin of a URL, or null if it can't be parsed or is opaque. */
function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Whether a URL is on the shell's own origin. Not originOf(): Node's URL
 * doesn't know app: is a standard scheme and gives app://din/ an opaque
 * origin, so the shell's own reload looked like leaving home and was blocked.
 */
function isShellUrl(url: string): boolean {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}` === SHELL_ORIGIN;
  } catch {
    return false;
  }
}

// Nostr identity bridge (window.nostr - see nostr-preload.cjs). Browser tabs
// and installed web apps get a NIP-07 provider whose calls land here. The
// signer, and every decision about whether a site may use it, live in the
// shell renderer (NostrBridgeHost), so each call is relayed to the shell and
// its answer routed back. This side only establishes who is asking: the origin
// is read from the calling frame, never taken from the page.
let nextNostrRequestId = 1;
const pendingNostrRequests = new Map<number, {
  resolve: (reply: NostrReply) => void;
  timer: NodeJS.Timeout;
  /** The guest that asked, so its requests die with its page. */
  wcId: number | null;
}>();

/** Long enough for a prompt to wait in a background tab or window. */
const NOSTR_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** The shell's answer to a relayed request (see NostrBridgeResponse). */
interface NostrReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Bunker connections only: a decision the user asked Din to remember. */
  remember?: unknown;
}

/** Everything the shell needs to decide on and fulfil one request. */
interface NostrRelayRequest {
  method: string;
  params: unknown;
  /** Who is asking: a web origin, or `nip46:<connection>` for a bunker client. */
  origin: string;
  source: 'tab' | 'app' | 'bunker';
  wcId: number | null;
  /** Whether the page was just clicked or typed in (the page's own report). */
  userActivated: boolean;
  /** Bunker connections: the account the connection signs for. */
  account?: string;
  /** Bunker connections: the client's name and what it has been allowed. */
  client?: unknown;
}

/** Relay a request to the shell; settles with its answer, or an error on timeout. */
function relayNostrRequest(request: NostrRelayRequest, timeoutMs = NOSTR_REQUEST_TIMEOUT_MS): Promise<NostrReply> {
  if (!shellWindow || shellWindow.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'Din is unavailable' });
  }
  return new Promise((resolve) => {
    const requestId = nextNostrRequestId++;
    const timer = setTimeout(() => {
      pendingNostrRequests.delete(requestId);
      sendToShell('nostr-bridge:cancel', requestId);
      resolve({ ok: false, error: 'Timed out waiting for an answer' });
    }, timeoutMs);
    pendingNostrRequests.set(requestId, { resolve, timer, wcId: request.wcId });
    sendToShell('nostr-bridge:request', { requestId, ...request });
  });
}

/** Fail every request a guest is waiting on: its page has gone. */
function cancelNostrRequestsFor(wcId: number, error: string): void {
  for (const [requestId, pending] of pendingNostrRequests) {
    if (pending.wcId !== wcId) continue;
    clearTimeout(pending.timer);
    pendingNostrRequests.delete(requestId);
    sendToShell('nostr-bridge:cancel', requestId);
    pending.resolve({ ok: false, error });
  }
  sendToShell('nostr-bridge:page-changed', wcId);
}

/** Pages that may use window.nostr: secure ones, and the machine's own. */
function isNostrCapableOrigin(origin: string): boolean {
  return /^(https|nsite):\/\//.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

/**
 * Who a window.nostr call is from, or null if it may not make one: the top
 * document of a (non-private) browser tab, or of an installed app on the
 * origin it was installed for. A page's iframes never qualify.
 */
function nostrCaller(event: Electron.IpcMainInvokeEvent): { origin: string; source: 'tab' | 'app' } | null {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return null;
  if (isAppGuest(event.sender)) {
    // Bound to the origin it was installed for (appGuestOrigins), so a page it
    // navigates or is redirected to never inherits the user's identity.
    const origin = appGuestOrigins.get(event.sender.id);
    return origin && frame.origin === origin ? { origin, source: 'app' } : null;
  }
  if (browserTabFromId(event.sender.id) === event.sender) {
    const origin = frame.origin;
    return isNostrCapableOrigin(origin) ? { origin, source: 'tab' } : null;
  }
  return null;
}

function registerNostrBridge(): void {
  ipcMain.handle('nostr-bridge:call', (event, payload): Promise<NostrReply> | NostrReply => {
    const caller = nostrCaller(event);
    if (!caller) return { ok: false, error: 'Nostr is not available here' };
    const method = payload && typeof payload.method === 'string' ? payload.method : '';
    return relayNostrRequest({
      method,
      params: payload ? payload.params : undefined,
      origin: caller.origin,
      source: caller.source,
      wcId: event.sender.id,
      // The page's navigator.userActivation is the page's to fake: the user
      // must also have pressed something in it, as main saw.
      userActivated: Boolean(payload && payload.userActivated) && justPressed(event.sender),
    });
  });

  // The shell renderer's answer to a relayed request. Only the shell may
  // resolve these - a guest cannot forge another guest's response.
  ipcMain.on('nostr-bridge:response', (event, response) => {
    if (!isShellSender(event)) return;
    const pending = response && pendingNostrRequests.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingNostrRequests.delete(response.requestId);
    pending.resolve(
      response.ok
        ? { ok: true, result: response.result, remember: response.remember }
        : { ok: false, error: typeof response.error === 'string' ? response.error : 'Request failed', remember: response.remember },
    );
  });

  // The shell switched accounts: every page with window.nostr hears about it.
  ipcMain.on('nostr-bridge:account-changed', (event) => {
    if (!isShellSender(event)) return;
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.getType() !== 'webview') continue;
      if (contents.session !== browserSession()) continue;
      contents.send('nostr-bridge:account-changed');
    }
  });

  registerBunkerHandlers({ assertShellSender, sendToShell, relay: relayNostrRequest });
}

// NIP-84 highlight bridge (browser-highlight-preload.cjs). A browser tab's
// highlight click carries only the selected text + surrounding context; the
// source URL is read here from the guest's own WebContents (never the page's
// report) so a page can't forge a highlight for a URL it doesn't serve. The
// event is built and signed in the shell with the signed-in account's signer -
// this bridge deliberately exposes no general signing surface to browsed sites.
let nextHighlightRequestId = 1;
const pendingHighlightRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
// The shell asks the user to review the highlight (and maybe write a comment)
// before it's posted, so this only guards against a shell that never answers.
const HIGHLIGHT_REQUEST_TIMEOUT_MS = 30 * 60_000;

/** Query params dropped when cleaning a URL for a highlight source (NIP-84). */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_|ref$|ref_src$|igshid$|yclid$|_hsenc$|_hsmi$|vero_|oly_|wickedid$)/i;

/** Strip tracking params + fragment from a page URL for use as a highlight `r`-tag. */
function cleanHighlightUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // nsite:// is allowed alongside http(s): a canonical nsite URL is derived
    // from the author's pubkey, so it names the highlighted site as durably as
    // a domain does - more so, since no one can repoint it. Other clients
    // can't follow it yet; publishing a gateway URL instead would put a
    // trusted third party into a link the whole design avoids.
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== `${NSITE_SCHEME}:`
    ) {
      return '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function registerHighlightBridge(): void {
  ipcMain.handle('din-highlight:publish', (event, payload) => {
    // Only browser-tab guests may reach this; the URL comes from the tab, not
    // the payload, and only text/context are honored from the page.
    const contents = browserTabFromId(event.sender.id);
    if (!contents || contents !== event.sender) {
      throw new Error('Highlighting is not available here');
    }
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Din shell is unavailable');
    }
    const url = cleanHighlightUrl(event.sender.getURL());
    if (!url) throw new Error('This page cannot be highlighted');

    const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) throw new Error('Nothing selected to highlight');
    if (text.length > 5000) throw new Error('Selection is too long to highlight');

    let context: string | undefined;
    if (payload && typeof payload.context === 'string' && payload.context.length <= 8000) {
      context = payload.context;
    }

    return new Promise((resolve, reject) => {
      const requestId = nextHighlightRequestId++;
      const timer = setTimeout(() => {
        pendingHighlightRequests.delete(requestId);
        reject(new Error('The highlight was never posted'));
      }, HIGHLIGHT_REQUEST_TIMEOUT_MS);
      pendingHighlightRequests.set(requestId, { resolve, reject, timer });
      const title = event.sender.getTitle().slice(0, 300) || undefined;
      sendToShell('din-highlight:request', { requestId, url, title, text, context });
    });
  });

  // The shell's answer to a relayed highlight publish. Only the shell may
  // resolve these.
  ipcMain.on('din-highlight:response', (event, response) => {
    if (!isShellSender(event)) return;
    const pending = response && pendingHighlightRequests.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingHighlightRequests.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || 'Failed to publish highlight'));
  });
}

// ---------------------------------------------------------------------------
// Webview file-chooser interception (the in-Din file picker for uploads).
//
// A native <input type=file> click inside a guest would otherwise pop the host
// GTK/X11 file dialog - which makes no sense in the Din desktop: production
// often has no desktop environment to host such a dialog, and it breaks the
// "file selection happens inside Din" model the FilePickerProvider is built
// on. Instead we intercept the chooser over CDP (Page.setInterceptFileChooser-
// Dialog) on every web-content guest, relay the request to the shell renderer
// (which opens the in-Din FilePickerDialog via useFilePicker), and hand the
// chosen absolute path back to the page with DOM.setFileInputFiles. Chromium
// reads the file bytes from disk itself, so no file contents ever cross the
// process boundary here - only a path the user explicitly selected.
// ---------------------------------------------------------------------------

/** How long a relayed file-pick request waits on the shell before it's dropped. */
const FILE_PICKER_REQUEST_TIMEOUT_MS = 5 * 60_000;
let nextFilePickerRequestId = 1;
interface PendingFilePick {
  contents: Electron.WebContents;
  /** The intercepted <input type=file> node, per Page.fileChooserOpened. */
  backendNodeId: number;
  timer: NodeJS.Timeout;
}
const pendingFilePicks = new Map<number, PendingFilePick>();

function registerFilePickerBridge(): void {
  // The shell's answer to a relayed file-chooser request. Only the shell may
  // resolve these, and it only ever returns a path the user picked in-Din
  // (or null on cancel) - never a page-supplied one.
  ipcMain.on('filepicker:response', (event, response) => {
    if (!isShellSender(event)) return;
    const requestId = response && (response as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'number') return;
    const paths = (response as { paths?: unknown }).paths;
    const chosen = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p !== '') : [];
    // A native app's, through the desktop portal (file-chooser.mts).
    const filter = (response as { filter?: unknown }).filter;
    if (answerFileChooser(requestId, chosen.length > 0 ? chosen : null, typeof filter === 'number' ? filter : null)) {
      return;
    }
    const pending = pendingFilePicks.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFilePicks.delete(requestId as number);

    const { contents, backendNodeId } = pending;
    if (contents.isDestroyed()) return;

    // A non-empty path means the user chose a file; anything else is a cancel.
    // Either way the intercepted chooser must be answered so the input isn't
    // left hanging - an empty file list is the "cancelled" answer.
    const path = (response as { path?: unknown }).path;
    const files = chosen.length > 0 ? chosen : typeof path === 'string' && path ? [path] : [];
    contents.debugger
      .sendCommand('DOM.setFileInputFiles', { files, backendNodeId })
      .catch(() => {
        // Node gone (page navigated) or DOM agent unavailable - nothing to do.
      });
  });

  // A shell that just (re)loaded has no picker open: any it was showing for
  // native apps are cancelled.
  ipcMain.on('filepicker:ready', (event) => {
    if (isShellSender(event)) cancelFileChoosers();
  });
  registerFileChooserPortal({ sendToShell, nextRequestId: () => nextFilePickerRequestId++ });
}

/**
 * Attach CDP file-chooser interception to a web-content guest. Idempotent per
 * WebContents: re-runs (e.g. after devtools closing detaches the shared
 * debugger) simply re-enable interception. Silently no-ops if another client
 * holds the debugger and won't yield.
 */
function attachFileChooserInterception(contents: Electron.WebContents): void {
  const dbg = contents.debugger;

  const enable = () => {
    if (contents.isDestroyed()) return;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch {
      return; // another client owns the debugger; leave it alone
    }
    // Page domain must be enabled to receive fileChooserOpened.
    dbg.sendCommand('Page.enable').catch(() => {});
    dbg
      .sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      .catch(() => {});
  };

  const onMessage = (_e: Electron.Event, method: string, params: unknown) => {
    if (method !== 'Page.fileChooserOpened') return;
    if (!shellWindow || shellWindow.webContents.isDestroyed()) return;
    const { backendNodeId, mode } = params as { backendNodeId?: unknown; mode?: unknown };
    if (typeof backendNodeId !== 'number') return;

    const requestId = nextFilePickerRequestId++;
    const timer = setTimeout(() => {
      pendingFilePicks.delete(requestId);
    }, FILE_PICKER_REQUEST_TIMEOUT_MS);
    pendingFilePicks.set(requestId, { contents, backendNodeId, timer });

    let origin = '';
    try {
      origin = new URL(contents.getURL()).host;
    } catch {
      // Opaque/blank URL - the picker just omits the origin in its title.
    }
    sendToShell('filepicker:request', { requestId, origin, multiple: mode === 'selectMultiple' });
  };

  // devtools closing detaches the shared debugger (see devtools-bridge.mts);
  // re-attach so uploads keep routing to the in-Din picker afterwards.
  const onDetach = () => {
    if (!contents.isDestroyed()) setTimeout(enable, 0);
  };

  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);
  contents.once('destroyed', () => {
    dbg.removeListener('message', onMessage);
    dbg.removeListener('detach', onDetach);
  });

  enable();
}

// chrome.tabs.create round-trips through the shell renderer (it owns the tab
// UI). Each request gets an id; the renderer answers with the new <webview>
// guest's WebContents id once it attaches.
let nextTabRequestId = 1;
const pendingTabRequests = new Map<number, {
  resolve: (tab: Electron.WebContents) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const TAB_REQUEST_TIMEOUT_MS = 15_000;

/** Ask the shell to open a browser tab; resolves to the tab's WebContents. */
function requestShellTab(details: { url?: string; active?: boolean }): Promise<Electron.WebContents> {
  return new Promise((resolve, reject) => {
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      reject(new Error('Shell window unavailable'));
      return;
    }
    const requestId = nextTabRequestId++;
    const timer = setTimeout(() => {
      pendingTabRequests.delete(requestId);
      reject(new Error('Tab creation timed out'));
    }, TAB_REQUEST_TIMEOUT_MS);
    pendingTabRequests.set(requestId, { resolve, reject, timer });
    sendToShell('crx:createTab', {
      requestId,
      url: typeof details.url === 'string' ? details.url : undefined,
      active: details.active !== false,
    });
  });
}

/**
 * Write a standalone preload that injects the <browser-action-list> custom
 * element (extension toolbar buttons) into the shell. The shell renderer is
 * sandboxed, so it can't require() the module itself - instead we concatenate
 * the library's self-contained script (its only external require is
 * 'electron', which sandboxed preloads may load) with a call to its export.
 */
function ensureBrowserActionPreload(): string {
  const source = fs.readFileSync(
    require.resolve('electron-chrome-extensions/browser-action'),
    'utf8',
  );
  const file = path.join(app.getPath('userData'), 'browser-action.preload.js');
  fs.writeFileSync(file, `${source}\n;module.exports.injectBrowserAction();\n`);
  return file;
}

function setupChromeExtensions(): void {
  chromeExtensions = new ElectronChromeExtensions({
    // din is AGPL-3.0-or-later, compatible with the library's GPL-3.0.
    license: 'GPL-3.0',
    session: browserSession(),

    createTab: async (details) => {
      const contents = await requestShellTab(details);
      return [contents, shellWindow!];
    },
    selectTab: (tab) => {
      sendToShell('crx:selectTab', { wcId: tab.id });
    },
    removeTab: (tab) => {
      sendToShell('crx:removeTab', { wcId: tab.id });
    },
    createWindow: async (details) => {
      // The desktop has exactly one native window; extension "windows"
      // (e.g. a popup the extension opens) become tabs instead.
      const url = Array.isArray(details.url) ? details.url[0] : details.url;
      await requestShellTab({ url, active: true });
      return shellWindow!;
    },
  });

  // Chrome Web Store installs: browsing chromewebstore.google.com inside a
  // browser tab gets a working "Add to Chrome" button. Also re-loads all
  // previously installed extensions from disk at startup.
  installChromeWebStore({
    session: browserSession(),
    extensionsPath: extensionsPath(),
    // Allow Manifest V2 so proven extensions like uBlock Origin keep working
    // (Electron has no declarativeNetRequest, which most MV3 blockers need).
    minimumManifestVersion: 2,
    allowUnpackedExtensions: true,
    // The library installs with no confirmation unless this says otherwise.
    // Require the genuine store origin (its own check is a prefix match, see
    // hardenWebStorePreload) and the user's explicit go-ahead, Chrome-style.
    beforeInstall: async ({ frame, localizedName, manifest }) => {
      if (!frame || frame.isDestroyed() || frame.origin !== WEB_STORE_ORIGIN) {
        return { action: 'deny' };
      }
      const raw = manifest as unknown as Record<string, unknown>;
      const allow = await askToAddExtension(
        localizedName || (typeof raw.name === 'string' ? raw.name : 'This extension'),
        extensionAccess(raw),
      );
      return { action: allow ? 'allow' : 'deny' };
    },
  }).catch((error) => {
    console.error('chrome-web-store setup failed:', error);
  });
  hardenWebStorePreload();

  // Extensions loaded from folders and installed from Nostr.
  void browserExtensions?.loadSaved();

  // Serve crx://extension-icon/... in the shell session so the toolbar's
  // <browser-action-list> and the extensions manager can render icons.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);

  // Inject the <browser-action-list> element into the shell.
  session.defaultSession.registerPreloadScript({
    id: 'crx-browser-action',
    type: 'frame',
    filePath: ensureBrowserActionPreload(),
  });
}

/** Ask the user to add an extension, Chrome-style, showing what it can reach. */
function askToAddExtension(name: string, access: { permissions: string[]; hosts: string[] }): Promise<boolean | null> {
  return askShell({ kind: 'extension-install', name, permissions: access.permissions, hostPermissions: access.hosts });
}

/** The one origin allowed to drive extension installs. */
const WEB_STORE_ORIGIN = 'https://chromewebstore.google.com';

/**
 * Swap electron-chrome-web-store's frame preload for a copy gated on the exact
 * store origin. Upstream (0.13.0) gates its install API on
 * `location.href.startsWith("https://chromewebstore.google.com")`, which any
 * `chromewebstore.google.com.<attacker>` host also satisfies - handing that
 * page chrome.webstorePrivate (install any extension) and chrome.management
 * (list and uninstall them). Its IPC handlers make the same prefix check, but
 * with the API never exposed to a lookalike page, it has nothing to call them
 * with. If the upstream source no longer contains the gate we patch, fail
 * closed: unregister the preload and leave the store install button inert.
 */
function hardenWebStorePreload(): void {
  const s = browserSession();
  s.unregisterPreloadScript('electron-chrome-web-store');
  const gate = 'location.href.startsWith("https://chromewebstore.google.com")';
  const source = fs.readFileSync(require.resolve('electron-chrome-web-store/preload'), 'utf8');
  if (!source.includes(gate)) {
    console.error('chrome-web-store: preload gate not found; store installs disabled');
    return;
  }
  const file = path.join(app.getPath('userData'), 'chrome-web-store.preload.js');
  fs.writeFileSync(file, source.replaceAll(gate, `location.origin === ${JSON.stringify(WEB_STORE_ORIGIN)}`));
  s.registerPreloadScript({ id: 'din-chrome-web-store', type: 'frame', filePath: file });
}

// ---------------------------------------------------------------------------
// Shell prompts: questions the main process needs the user to answer (a site
// asking for the camera, an extension asking to be installed). Asked in the
// shell renderer (PromptHost); an unanswered prompt times out as "no".
// ---------------------------------------------------------------------------

/** A capability a site must ask the user for. */
type SiteCapability = 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'background-sync';

const SITE_CAPABILITIES: readonly SiteCapability[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'background-sync',
];

type ShellPrompt =
  | { kind: 'permission'; origin: string; capabilities: SiteCapability[]; remembered: boolean }
  | { kind: 'extension-install'; name: string; permissions: string[]; hostPermissions: string[] };

let nextPromptId = 1;
const pendingPrompts = new Map<number, { resolve: (allow: boolean | null) => void; timer: NodeJS.Timeout }>();
const PROMPT_TIMEOUT_MS = 2 * 60_000;

/**
 * Ask the user a yes/no question in the shell. Resolves null when nobody
 * answered (no shell, or it timed out), which callers treat as "no" without
 * remembering it as one.
 */
function askShell(prompt: ShellPrompt): Promise<boolean | null> {
  return new Promise((resolve) => {
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      resolve(null);
      return;
    }
    const requestId = nextPromptId++;
    const timer = setTimeout(() => {
      pendingPrompts.delete(requestId);
      sendToShell('prompt:cancel', { requestId });
      resolve(null);
    }, PROMPT_TIMEOUT_MS);
    pendingPrompts.set(requestId, { resolve, timer });
    sendToShell('prompt:request', { requestId, ...prompt });
  });
}

function registerPromptBridge(): void {
  ipcMain.on('prompt:response', (event, response) => {
    if (!isShellSender(event)) return;
    const pending = response && pendingPrompts.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPrompts.delete(response.requestId);
    // A dismissed prompt (Escape, a click outside) is "not now", not "never".
    pending.resolve(response.allow === true ? true : response.dismissed === true ? null : false);
  });
}

// ---------------------------------------------------------------------------
// Guest session hardening.
//
// Electron grants every permission a page asks for unless told otherwise:
// camera and microphone with no indicator, location, clipboard reads, opening
// arbitrary URL schemes in external apps (xdg-open), and more. Every guest
// session gets a deny-by-default policy instead:
//   - harmless capabilities pages rely on are allowed (writing the clipboard,
//     fullscreen video, pointer lock for games, DRM playback)
//   - camera, microphone, location and notifications are asked in the shell,
//     per origin, and the answer is remembered (site-permissions.json, shared
//     by browser tabs and installed apps; private windows forget with their
//     session). The address bar's site info changes or forgets it.
//   - everything else is denied: clipboard reads, keyboard lock, external
//     protocol handlers, device pickers (HID/serial/USB/Bluetooth), ...
// Guest sessions also refuse file:// outright: nothing legitimate loads local
// files into a tab, and an extension could otherwise point one at Din's own
// profile directory (chrome.tabs.update skips the address bar's checks).
// ---------------------------------------------------------------------------

const ALWAYS_ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'mediaKeySystem',
  'speaker-selection',
]);

/** Key of one answer in a decisions map. */
function decisionKey(origin: string, capability: SiteCapability): string {
  return `${origin}\u0000${capability}`;
}

/**
 * The origin an installed app may be pinned to: an https origin, or the
 * canonical host of an nsite (built by hand, as Node's URL gives nsite:// the
 * opaque origin "null"; it matches what Chromium reports as the frame origin).
 */
function appOriginOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'nsite:') {
      return parseCanonicalHost(hostname) ? `nsite://${hostname}` : null;
    }
  } catch {
    return null;
  }
  const origin = originOf(url);
  return origin?.startsWith('https:') ? origin : null;
}

/**
 * The origin a site's answers are filed under: http(s) and nsite pages only.
 * Node's URL gives every nsite:// URL the opaque origin "null" (Chromium,
 * which knows the scheme is standard, does not), so it is built by hand.
 */
function siteOriginOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

function sitePermissionsPath(): string {
  return path.join(app.getPath('userData'), 'site-permissions.json');
}

/**
 * Answers that outlive a restart: the persistent browser session's, keyed
 * like decisionsFor's. Installed apps' windows are in that session, so a
 * site's tab and its app share them.
 */
let savedDecisions: Map<string, boolean> | null = null;

function persistedDecisions(): Map<string, boolean> {
  if (savedDecisions) return savedDecisions;
  savedDecisions = new Map();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sitePermissionsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [origin, answers] of Object.entries(parsed)) {
        if (!answers || typeof answers !== 'object') continue;
        for (const capability of SITE_CAPABILITIES) {
          const allow: unknown = (answers as Record<string, unknown>)[capability];
          if (typeof allow === 'boolean') savedDecisions.set(decisionKey(origin, capability), allow);
        }
      }
    }
  } catch {
    // No file yet (or corrupt): nothing has been answered.
  }
  return savedDecisions;
}

function saveDecisions(decisions: Map<string, boolean>): void {
  const byOrigin: Record<string, Partial<Record<SiteCapability, boolean>>> = {};
  for (const [k, allow] of decisions) {
    const [origin, capability] = k.split('\u0000') as [string, SiteCapability];
    (byOrigin[origin] ??= {})[capability] = allow;
  }
  try {
    fs.writeFileSync(sitePermissionsPath(), JSON.stringify(byOrigin, null, 2));
  } catch {
    // Non-fatal: the answer just won't survive a restart.
  }
}

/** Answers that only last as long as their session (private windows, devtools). */
const sessionDecisions = new WeakMap<Electron.Session, Map<string, boolean>>();

function remembersDecisions(s: Electron.Session): boolean {
  return s === browserSession();
}

/** A session's answers, keyed `origin\0capability`. */
function decisionsFor(s: Electron.Session): Map<string, boolean> {
  if (remembersDecisions(s)) return persistedDecisions();
  let decisions = sessionDecisions.get(s);
  if (!decisions) {
    decisions = new Map();
    sessionDecisions.set(s, decisions);
  }
  return decisions;
}

/**
 * Prompts dismissed or left to time out, per session. They are refused until
 * Din restarts, so a page can't re-ask in a loop, but never written down as a
 * Block the user didn't choose.
 */
const dismissedPrompts = new WeakMap<Electron.Session, Set<string>>();

function dismissedFor(s: Electron.Session): Set<string> {
  let dismissed = dismissedPrompts.get(s);
  if (!dismissed) {
    dismissed = new Set();
    dismissedPrompts.set(s, dismissed);
  }
  return dismissed;
}

/** Record (or with null, forget) an answer, saving it if the session remembers. */
function decide(s: Electron.Session, origin: string, capability: SiteCapability, allow: boolean | null): void {
  dismissedFor(s).delete(decisionKey(origin, capability));
  const decisions = decisionsFor(s);
  if (allow === null) decisions.delete(decisionKey(origin, capability));
  else decisions.set(decisionKey(origin, capability), allow);
  if (!remembersDecisions(s)) return;
  saveDecisions(decisions);
  nappPermissionChanged(origin, capability, allow);
  webPushPermissionChanged(origin, capability, allow);
  periodicSyncPermissionChanged(origin, capability, allow);
  sendToShell('site-permissions:changed');
}

/** The askable capabilities a permission request needs, or null if not askable. */
function requestedCapabilities(
  permission: string,
  details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest,
): SiteCapability[] | null {
  if (permission === 'geolocation' || permission === 'notifications') return [permission];
  if (permission !== 'media') return null;
  const types = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
  const capabilities: SiteCapability[] = [];
  if (types.includes('video')) capabilities.push('camera');
  if (types.includes('audio')) capabilities.push('microphone');
  return capabilities.length > 0 ? capabilities : null;
}

/** Whether a site may notify, as the user answered (Notification.permission). */
function siteNotificationPermission(s: Electron.Session, origin: string): NotificationPermission {
  const allowed = decisionsFor(s).get(decisionKey(origin, 'notifications'));
  return allowed === undefined ? 'default' : allowed ? 'granted' : 'denied';
}

/** Per session: ask for capabilities as its permission request handler does. */
const siteAskers = new WeakMap<Electron.Session, (origin: string, capabilities: SiteCapability[]) => Promise<boolean>>();

/** Ask (or recall) whether a site may use a capability, as Chromium's own requests are. */
function requestSiteCapability(s: Electron.Session, origin: string, capability: SiteCapability): Promise<boolean> {
  return siteAskers.get(s)?.(origin, [capability]) ?? Promise.resolve(false);
}

/** Whether the user has allowed a site a capability. */
function siteCapabilityAllowed(s: Electron.Session, origin: string, capability: SiteCapability): boolean {
  return decisionsFor(s).get(decisionKey(origin, capability)) === true;
}

function hardenGuestSession(s: Electron.Session, { prompts }: { prompts: boolean }): void {
  const decisions = decisionsFor(s);
  const dismissed = dismissedFor(s);
  const key = decisionKey;
  // One prompt per (origin, capabilities) at a time; repeat requests share it.
  const asking = new Map<string, Promise<boolean>>();

  const ask = (origin: string, capabilities: SiteCapability[]): Promise<boolean> => {
    if (capabilities.some((c) => decisions.get(key(origin, c)) === false || dismissed.has(key(origin, c)))) {
      return Promise.resolve(false);
    }
    const undecided = capabilities.filter((c) => !decisions.has(key(origin, c)));
    if (undecided.length === 0) return Promise.resolve(true);
    const askKey = `${origin}\u0000${undecided.join(',')}`;
    let answer = asking.get(askKey);
    if (!answer) {
      const remembered = remembersDecisions(s);
      answer = askShell({ kind: 'permission', origin, capabilities: undecided, remembered }).then((allow) => {
        for (const c of undecided) {
          if (allow === null) dismissed.add(key(origin, c));
          else decide(s, origin, c, allow);
        }
        asking.delete(askKey);
        return allow === true;
      });
      asking.set(askKey, answer);
    }
    return answer;
  };
  if (prompts) siteAskers.set(s, ask);

  s.setPermissionRequestHandler((_contents, permission, callback, details) => {
    // A nostrconnect:// link is an app asking to use the user's account
    // through Din (electron/bunker.mts). The shell shows what it asks for and
    // connects nothing until the user says so.
    if (
      permission === 'openExternal' &&
      prompts &&
      !isEphemeralBrowserSession(s) &&
      'externalURL' in details &&
      typeof details.externalURL === 'string' &&
      /^nostrconnect:/i.test(details.externalURL)
    ) {
      sendToShell('bunker:link', details.externalURL);
      callback(false);
      return;
    }
    // A nostr: link (NIP-21) opens in the app the user chose for its kind,
    // or as a preview in a tab beside the page (src/hooks/useNostrLinks.ts);
    // a mailto: link opens a new message in Mail. Not from Tor's session: the
    // preview reaches relays directly.
    if (
      permission === 'openExternal' &&
      prompts &&
      s !== torBrowserSession() &&
      'externalURL' in details &&
      typeof details.externalURL === 'string' &&
      details.externalURL.length <= 8192 &&
      /^(nostr|mailto):/i.test(details.externalURL)
    ) {
      sendToShell('crx:openTab', { url: details.externalURL, openerWcId: _contents.id });
      callback(false);
      return;
    }
    if (ALWAYS_ALLOWED_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    // Screen sharing asks the user in its own picker, every time
    // (electron/screen-share.mts); the permission itself is no gate.
    // getDisplayMedia arrives as 'media' naming neither camera nor
    // microphone (Electron 41 lists only device capture in mediaTypes).
    if (
      permission === 'display-capture' ||
      (permission === 'media' && 'mediaTypes' in details && (details.mediaTypes ?? []).length === 0)
    ) {
      callback(prompts);
      return;
    }
    // Chromium's own geolocation can't locate anything here (it would send
    // the request to Google, without a key); pages get Din's instead
    // (geolocation-preload.cjs), which asks through `ask` below.
    if (permission === 'geolocation') {
      callback(false);
      return;
    }
    const capabilities = prompts ? requestedCapabilities(permission, details) : null;
    const origin = siteOriginOf(details.requestingUrl);
    if (!capabilities || !origin) {
      callback(false);
      return;
    }
    ask(origin, capabilities).then(callback, () => callback(false));
  });

  s.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (ALWAYS_ALLOWED_PERMISSIONS.has(permission)) return true;
    let capability: SiteCapability | null = null;
    if (permission === 'geolocation' || permission === 'notifications') capability = permission;
    else if (permission === 'media' && details.mediaType === 'video') capability = 'camera';
    else if (permission === 'media' && details.mediaType === 'audio') capability = 'microphone';
    return capability !== null && decisions.get(key(requestingOrigin, capability)) === true;
  });

  s.setDevicePermissionHandler(() => false);
  s.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  s.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  s.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });

  s.protocol.handle('file', () => new Response('Local files cannot be opened here.', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  }));
}

/**
 * What the Web Browser's site info (the address bar's lock) shows and
 * changes: a site's answers, in the persistent browser session or, for a
 * private window, the private one. An onion site's are always Tor's.
 */
function registerSitePermissionHandlers(): void {
  const resolve = (origin: unknown, isPrivate: unknown): { origin: string; s: Electron.Session } => {
    if (typeof origin !== 'string' || siteOriginOf(origin) !== origin) throw new Error('Invalid site');
    // The Web Browser shows a plain-http onion site as http://, but its pages
    // run as https:// (onionRequest), and that's the origin they ask as.
    if (isOnionUrl(origin)) return { origin: origin.replace(/^http:\/\/([^:/]+)$/i, 'https://$1'), s: torBrowserSession() };
    return { origin, s: isPrivate === true ? privateBrowserSession() : browserSession() };
  };

  ipcMain.handle('site-permissions:get', (event, rawOrigin, isPrivate) => {
    assertShellSender(event);
    const { origin, s } = resolve(rawOrigin, isPrivate);
    const decisions = decisionsFor(s);
    const permissions: Partial<Record<SiteCapability, boolean>> = {};
    for (const capability of SITE_CAPABILITIES) {
      const allow = decisions.get(decisionKey(origin, capability));
      if (allow !== undefined) permissions[capability] = allow;
    }
    const host = hostOf(origin);
    const pinned = isEphemeralBrowserSession(s) ? privateTrustedCerts : trustedCerts;
    const certificateException = !!host && [...pinned].some((k) => k.startsWith(`${host}\u0000`));
    return { permissions, certificateException };
  });

  ipcMain.handle('site-permissions:set', (event, rawOrigin, capability, allow, isPrivate) => {
    assertShellSender(event);
    const { origin, s } = resolve(rawOrigin, isPrivate);
    if (!SITE_CAPABILITIES.includes(capability)) throw new Error('Invalid capability');
    if (typeof allow !== 'boolean' && allow !== null) throw new Error('Invalid decision');
    decide(s, origin, capability, allow);
  });

  // The site info's "Delete site data", as Chrome's: one site's cookies and
  // storage (localStorage, IndexedDB, service workers, cache storage, ...),
  // its subdomains' cookies with them. Its answers stay; resetting those is
  // the site info's own button.
  ipcMain.handle('site-data:clear', async (event, rawOrigin, isPrivate) => {
    assertShellSender(event);
    const { origin, s } = resolve(rawOrigin, isPrivate);
    await s.clearStorageData({ origin });
    const host = hostOf(origin);
    if (host) {
      for (const cookie of await s.cookies.get({ domain: host })) {
        const domain = (cookie.domain ?? host).replace(/^\./, '');
        const url = `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path ?? '/'}`;
        await s.cookies.remove(url, cookie.name).catch(() => {});
      }
    }
    if (s === browserSession()) forgetWebPushSubscriptions(origin);
  });

  // What a page's navigator.permissions.query reports (permissions-preload.cjs):
  // Electron's check can only say yes or no, and an unanswered "no" stops
  // pages that look first from ever asking.
  ipcMain.on('site-permissions:state', (event, name) => {
    const s = event.sender.session;
    const origin = event.senderFrame ? siteOriginOf(event.senderFrame.url) : null;
    const capability = (['camera', 'microphone', 'geolocation', 'notifications'] as const).find((c) => c === name);
    if (!origin || !capability || !siteAskers.has(s)) {
      event.returnValue = null;
      return;
    }
    const key = decisionKey(origin, capability);
    const allow = decisionsFor(s).get(key);
    event.returnValue =
      allow === true ? 'granted' : allow === false || dismissedFor(s).has(key) ? 'denied' : 'prompt';
  });

  // Every site answered for one capability, for Settings (remembered answers only).
  ipcMain.handle('site-permissions:list', (event, capability) => {
    assertShellSender(event);
    if (!SITE_CAPABILITIES.includes(capability)) throw new Error('Invalid capability');
    const sites: { origin: string; allow: boolean }[] = [];
    for (const [k, allow] of persistedDecisions()) {
      const [origin, answered] = k.split('\u0000');
      if (answered === capability) sites.push({ origin, allow });
    }
    return sites;
  });
}

// ---------------------------------------------------------------------------
// Extension action popups, rendered in-shell.
//
// electron-chrome-extensions opens chrome.action popups (e.g. Bitwarden's
// unlock bubble) as a separate native frameless BrowserWindow positioned
// next to the action button. That suits a windowing desktop, but Din is a
// single-window kiosk: a popup toplevel detaches from the shell (under a
// kiosk compositor like din-shell it can't be positioned at all) instead of
// hugging the toolbar the way Chrome's in-window bubble does. So the
// browserAction activateClick handler is overridden to route popup requests
// to the shell renderer, which hosts the popup page in an overlay <webview>
// anchored to the action button (ExtensionPopupHost). The anchor rect is
// already in shell-viewport CSS pixels (the browser-action element's
// getBoundingClientRect), so no coordinate translation is needed.
// ---------------------------------------------------------------------------

/** The action popup currently shown in the shell (drives toggle-close). */
let openActionPopup: { extensionId: string } | null = null;

/** Shape of the BrowserActionAPI internals the popup override relies on. */
interface BrowserActionApiInternals {
  activateClick(details: {
    eventType?: string;
    extensionId: string;
    tabId: number;
    anchorRect: { x: number; y: number; width: number; height: number };
    alignment?: string;
  }): void;
  getPopupUrl(extensionId: string, tabId: number): string | undefined;
  ctx: {
    store: {
      getTabById(id: number): Electron.WebContents | undefined;
      getActiveTabOfCurrentWindow(): Electron.WebContents | undefined;
      tabDetailsCache: Map<number, unknown>;
    };
    router: {
      sendEvent(extensionId: string, name: string, ...args: unknown[]): void;
    };
  };
}

function overrideActionPopup(): void {
  if (!chromeExtensions) return;
  const api = (
    chromeExtensions as unknown as {
      api: { browserAction: BrowserActionApiInternals };
    }
  ).api.browserAction;
  if (
    !api ||
    typeof api.activateClick !== 'function' ||
    typeof api.getPopupUrl !== 'function' ||
    !api.ctx
  ) {
    return;
  }
  const fallback = api.activateClick.bind(api);
  api.activateClick = (details) => {
    try {
      const { extensionId, tabId, anchorRect } = details;
      // Toggle: a second click on the same action closes its popup (mirrors
      // the stock handler's PopupView toggle).
      if (openActionPopup) {
        const same = openActionPopup.extensionId === extensionId;
        openActionPopup = null;
        sendToShell('crx:closeActionPopup');
        if (same) return;
      }
      const tab =
        tabId >= 0
          ? api.ctx.store.getTabById(tabId)
          : api.ctx.store.getActiveTabOfCurrentWindow();
      if (!tab) return;
      const popupUrl = api.getPopupUrl(extensionId, tab.id);
      if (popupUrl && anchorRect) {
        openActionPopup = { extensionId };
        sendToShell('crx:openActionPopup', {
          extensionId,
          url: popupUrl,
          anchorRect,
        });
        return;
      }
      // No popup page: dispatch onClicked, as the stock handler does.
      api.ctx.router.sendEvent(
        extensionId,
        'browserAction.onClicked',
        api.ctx.store.tabDetailsCache.get(tab.id),
      );
    } catch {
      // Internal API drift: degrade to the library's native popup window.
      fallback(details);
    }
  };
}

// ---------------------------------------------------------------------------
// TLS trust for the Web Browser app.
//
// A self-signed / private-CA host (e.g. a device on the local network)
// fails Chromium's default certificate check, and Electron ships no built-in
// "proceed anyway" interstitial - the tab just fails to load. We add one: on a
// certificate error inside a browser tab we reject the load and surface the
// details to the shell, which shows a warning. If the user chooses to proceed
// we pin that exact (host, fingerprint) pair and reload; the next verification
// for that pinned cert is trusted. Scoped to the two browser sessions only, so
// the shell and installed web apps keep strict verification.
//
// Private ("incognito") tabs get the same interstitial, but their exceptions
// are pinned in memory only (privateTrustedCerts) - never written to disk - so
// they're discarded with the ephemeral session, like the rest of a private
// window's state. Persistent tabs pin to trustedCerts (saved across restarts).
// ---------------------------------------------------------------------------

/** Where accepted (host, fingerprint) cert exceptions are persisted. */
function trustedCertsPath(): string {
  return path.join(app.getPath('userData'), 'browser-trusted-certs.json');
}

/** Accepted cert exceptions, keyed by `host\u0000fingerprint`. */
const trustedCerts = new Set<string>();
let trustedCertsLoaded = false;

/**
 * Cert exceptions accepted from *private* tabs, keyed the same way. Kept in
 * memory only (never persisted) so they vanish with the ephemeral private
 * session - a private window shouldn't leave trust state behind on disk.
 */
const privateTrustedCerts = new Set<string>();

/** Identity key for a pinned certificate exception. */
function certKey(host: string, fingerprint: string): string {
  return `${host}\u0000${fingerprint}`;
}

/** Load persisted cert exceptions once (lazy; needs a ready app for userData). */
function loadTrustedCerts(): void {
  if (trustedCertsLoaded) return;
  trustedCertsLoaded = true;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(trustedCertsPath(), 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { host?: unknown }).host === 'string' &&
        typeof (entry as { fingerprint?: unknown }).fingerprint === 'string'
      ) {
        const { host, fingerprint } = entry as { host: string; fingerprint: string };
        trustedCerts.add(certKey(host, fingerprint));
      }
    }
  } catch {
    // No file yet (or unreadable/corrupt): start with no exceptions.
  }
}

/** Persist the current cert exceptions (best-effort). */
function saveTrustedCerts(): void {
  const entries = [...trustedCerts].map((key) => {
    const [host, fingerprint] = key.split('\u0000');
    return { host, fingerprint };
  });
  try {
    fs.writeFileSync(trustedCertsPath(), JSON.stringify(entries, null, 2));
  } catch {
    // Non-fatal: the exception just won't survive a restart.
  }
}

/** Hostname of a URL, or null if it can't be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function registerCertificateHandling(): void {
  loadTrustedCerts();

  // Approve pinned certs *before* Chromium raises an error, so a trusted
  // self-signed host loads cleanly - no error page, no reload dance. Every
  // other cert defers to Chromium's own verification (-3), so valid public
  // certs are still checked normally and unknown bad certs still fail. Each
  // browser session consults its own exception set (persistent vs. the private
  // window's in-memory set).
  const installVerifyProc = (s: Electron.Session, pinned: Set<string>): void => {
    s.setCertificateVerifyProc((request, callback) => {
      const fingerprint = request.certificate?.fingerprint || '';
      if (
        request.hostname &&
        fingerprint &&
        (pinned.has(certKey(request.hostname, fingerprint)) ||
          // The onion proxy's own, standing in for a plain-http onion site.
          (s === torBrowserSession() && isOnionProxyCertificate(request.hostname, fingerprint)))
      ) {
        callback(0);
        return;
      }
      callback(-3);
    });
  };
  installVerifyProc(browserSession(), trustedCerts);
  installVerifyProc(privateBrowserSession(), privateTrustedCerts);
  installVerifyProc(torBrowserSession(), privateTrustedCerts);

  // A cert Chromium rejected (unpinned self-signed / private-CA host) fires
  // this on a browser session. Reject the load and, for the top-level frame,
  // hand the details to the shell so it can offer "proceed anyway".
  app.on(
    'certificate-error',
    (event, contents, url, error, certificate, callback, isMainFrame) => {
      if (
        !contents ||
        contents.isDestroyed() ||
        !isBrowserTabSession(contents.session) ||
        isAppGuest(contents)
      ) {
        // Not a browser tab (shell, installed web app, ...): leave Chromium's
        // strict verification in place by not overriding it.
        return;
      }
      // Private and onion tabs check the in-memory exception set; persistent
      // tabs the saved one.
      const pinned = isEphemeralBrowserSession(contents.session) ? privateTrustedCerts : trustedCerts;
      const host = hostOf(url);
      const fingerprint = certificate.fingerprint || '';
      if (host && fingerprint && pinned.has(certKey(host, fingerprint))) {
        // Pinned (belt-and-suspenders with the verify proc above): trust it.
        event.preventDefault();
        callback(true);
        return;
      }
      // Reject, and (for the top-level load) ask the shell to warn the user.
      event.preventDefault();
      callback(false);
      if (isMainFrame && host) {
        sendToShell('browser:certificateError', {
          wcId: contents.id,
          url,
          host,
          error,
          fingerprint,
        });
      }
    },
  );

  // The shell reports the user chose to proceed: pin the (host, fingerprint)
  // pair and reload the tab. The reload is issued here, from the main process
  // (a browser-initiated navigation), rather than from the renderer's
  // <webview> element - reloading the chrome-error page through the element is
  // blocked by Blink as a cross-origin navigation ("Domains, protocols and
  // ports must match").
  ipcMain.handle(
    'browser:trustCertificate',
    (event, host, fingerprint, wcId, url) => {
      assertShellSender(event);
      if (
        typeof host !== 'string' ||
        typeof fingerprint !== 'string' ||
        !host ||
        !fingerprint
      ) {
        throw new Error('Invalid certificate exception');
      }
      const tab = anyBrowserTabFromId(wcId);
      if (tab && isEphemeralBrowserSession(tab.session)) {
        // Private window or onion site: pin in memory only, so the exception is discarded
        // with the ephemeral session and never touches disk.
        privateTrustedCerts.add(certKey(host, fingerprint));
      } else {
        loadTrustedCerts();
        trustedCerts.add(certKey(host, fingerprint));
        saveTrustedCerts();
      }
      if (tab) {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          tab.loadURL(url).catch(() => {});
        } else {
          tab.reloadIgnoringCache();
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Downloads for the Web Browser app.
//
// There is no desktop environment to host a native save dialog, so every
// download is written straight to ~/Downloads. The browser sessions also
// report the download to the Web Browser app so it can show a download shelf
// with progress and open / show-in-folder actions - otherwise a file link
// would save silently and leave a blank tab, with no sign anything happened.
// ---------------------------------------------------------------------------

let nextDownloadId = 1;

/**
 * A path in ~/Downloads for `filename`, suffixed ` (n)` before the extension
 * if needed so a new download never clobbers an existing file. The download
 * directory is created if missing; the filename is basenamed so a
 * server-supplied name can't escape it.
 */
function uniqueDownloadPath(filename: string): string {
  const dir = app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(filename) || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'download';
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** Whether `p` is a real path inside ~/Downloads (guards the open/show IPC). */
function isDownloadsPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false;
  const dir = path.resolve(app.getPath('downloads'));
  const resolved = path.resolve(p);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

/**
 * Attach the reporting `will-download` handler to both browser sessions and
 * register the open / show-in-folder IPC the download shelf calls. Each
 * download is tagged with the initiating guest's WebContents id so the app can
 * route it to the window/tab that started it (matches Tab.wcId).
 */
function registerBrowserDownloadHandlers(): void {
  const onWillDownload = (
    _event: Electron.Event,
    item: Electron.DownloadItem,
    contents: Electron.WebContents,
  ) => {
    const savePath = uniqueDownloadPath(item.getFilename());
    item.setSavePath(savePath);
    const id = nextDownloadId++;
    const wcId = contents && !contents.isDestroyed() ? contents.id : -1;
    const url = item.getURL();
    const filename = path.basename(savePath);
    const report = (state: string) => {
      sendToShell('browser:download', {
        id,
        wcId,
        url,
        filename,
        savePath,
        state,
        paused: item.isPaused(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      });
    };
    report('progressing');
    item.on('updated', (_e, state) =>
      report(state === 'interrupted' ? 'interrupted' : 'progressing'),
    );
    item.once('done', (_e, state) => report(state));
  };
  browserSession().on('will-download', onWillDownload);
  privateBrowserSession().on('will-download', onWillDownload);
  torBrowserSession().on('will-download', onWillDownload);

  // Run a downloaded setup.exe, the way it would on Windows, or an AppImage. Everything else
  // opens in Din's own apps from the renderer; the OS default handler isn't
  // Din's (it picked whatever desktop app was installed, VSCodium for
  // folders). Restricted to files under ~/Downloads so the shell can't be
  // coaxed into running an arbitrary path.
  ipcMain.handle('browser:openDownload', async (event, filePath) => {
    assertShellSender(event);
    if (!isDownloadsPath(filePath) || !fs.existsSync(filePath)) return;
    if (isProgram(filePath)) return runProgram(filePath);
  });
}

// ---------------------------------------------------------------------------
// Clear browsing data for the Web Browser app.
//
// Wipes Chromium-side state for the persistent browser session on request:
// the HTTP cache and/or cookies + all site storage (localStorage, IndexedDB,
// service workers, cache storage, ...). The app's own address-bar history is
// separate (encrypted Nostr app data) and cleared in the renderer.
//
// The private session isn't touched: it's already ephemeral and vanishes when
// the last private window closes, so there's nothing persistent to purge.
// ---------------------------------------------------------------------------
function registerBrowserDataHandlers(): void {
  ipcMain.handle('browser:clearBrowsingData', async (event, options) => {
    assertShellSender(event);
    const opts =
      options && typeof options === 'object'
        ? (options as { cache?: unknown; cookies?: unknown })
        : {};
    const s = browserSession();
    if (opts.cache === true) {
      await s.clearCache();
      // nsite blobs and manifests live outside Chromium's HTTP cache, so
      // clearing that alone would leave a site's files on disk. Installed
      // sites and their files stay: they're apps, not browsing data.
      await clearNsiteManifestCache();
      await clearNsiteBlobCache();
    }
    if (opts.cookies === true) {
      // No `storages` filter: clear every storage type (cookies included).
      await s.clearStorageData();
      // Service workers went too, and push subscriptions belong to them.
      forgetWebPushSubscriptions();
    }
  });
}

// ---------------------------------------------------------------------------
// Preconnecting for the Web Browser's address bar. As the user types, the
// shell names where Enter would go, and this opens a connection to it (DNS,
// TCP, TLS) ahead of time, as Chrome's omnibox does. Chromium dedupes
// repeats and closes the socket if it goes unused.
//
// Only the persistent session: a private or Tor window never asks, since
// connecting before the user commits to a site would leave a trace of what
// they typed (Tor would also be slow to bother with).
// ---------------------------------------------------------------------------
function registerBrowserPreconnectHandler(): void {
  ipcMain.on('browser:preconnect', (event, url: unknown) => {
    if (!isShellSender(event) || typeof url !== 'string') return;
    let origin: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      // Onion services are Tor's session's alone; outside it, a lookup leaks.
      if (/\.onion\.?$/i.test(parsed.hostname)) return;
      origin = parsed.origin;
    } catch {
      return;
    }
    browserSession().preconnect({ url: origin, numSockets: 1 });
  });
}

// ---------------------------------------------------------------------------
// Color scheme. Chromium answers `prefers-color-scheme` from the host
// desktop's setting, which under din-shell doesn't exist, so every page saw light.
// Din is the desktop here: the shell reports its own light/dark mode and
// nativeTheme passes it on to every web contents, browser tabs included.
//
// Where Din is the desktop, native apps get it too, and Din's colors with
// it (gtk-theme.mts).
// ---------------------------------------------------------------------------
function registerThemeHandler(): void {
  ipcMain.on('theme:set', (event, source: unknown) => {
    if (!isShellSender(event)) return;
    if (source !== 'light' && source !== 'dark' && source !== 'system') return;
    nativeTheme.themeSource = source;
    if (source !== 'system') setNativeColorScheme(source);
  });
  ipcMain.on('theme:native', (event, palette: unknown) => {
    if (!isShellSender(event)) return;
    setNativePalette(palette);
  });
  ipcMain.on('theme:selection', (event, color: unknown) => {
    if (!isShellSender(event)) return;
    setSelectionColor(color);
  });
}

// ---------------------------------------------------------------------------
// Find-in-page for the Web Browser app (Ctrl+F).
//
// Chromium's find-in-page is per-WebContents and driven from the main
// process: the shell sends the query here, and match results stream back via
// the guest's `found-in-page` event (wired in web-contents-created). Applies
// to both browser sessions (persistent + private) via anyBrowserTabFromId.
// ---------------------------------------------------------------------------
function registerFindHandlers(): void {
  ipcMain.handle('browser:findInPage', (event, wcId, text, options) => {
    assertShellSender(event);
    if (typeof text !== 'string') throw new Error('Invalid find text');
    const tab = anyBrowserTabFromId(wcId);
    if (!tab) return;
    // An empty query clears the highlight instead of matching everything.
    if (text.length === 0) {
      tab.stopFindInPage('clearSelection');
      return;
    }
    const opts =
      options && typeof options === 'object'
        ? (options as { forward?: unknown; findNext?: unknown; matchCase?: unknown })
        : {};
    // Electron's `findNext` is inverted from its name: `true` starts a new
    // find session and `false` steps through the current one. Our bridge's
    // `findNext` means "step to the next match", so every edit to the query
    // must start a new session, or Chromium keeps highlighting the old text.
    tab.findInPage(text, {
      forward: opts.forward !== false,
      findNext: opts.findNext !== true,
      matchCase: opts.matchCase === true,
    });
  });

  ipcMain.handle('browser:stopFindInPage', (event, wcId) => {
    assertShellSender(event);
    const tab = anyBrowserTabFromId(wcId);
    if (tab) tab.stopFindInPage('clearSelection');
  });
}

function registerCrxHandlers(): void {
  // The shell reports which browser tab is active (drives per-tab extension
  // action state and which tab chrome.tabs APIs consider "active").
  ipcMain.on('crx:tabActivated', (event, wcId) => {
    assertShellSender(event);
    const tab = browserTabFromId(wcId);
    if (tab && chromeExtensions) chromeExtensions.selectTab(tab);
  });

  // The shell answers a crx:createTab request with the new guest's id.
  ipcMain.on('crx:resolveCreateTab', (event, requestId, wcId) => {
    assertShellSender(event);
    const pending = pendingTabRequests.get(requestId);
    if (!pending) return;
    pendingTabRequests.delete(requestId);
    clearTimeout(pending.timer);
    const tab = browserTabFromId(wcId);
    if (tab) pending.resolve(tab);
    else pending.reject(new Error('Tab creation failed'));
  });

  // The shell dismissed the in-shell action popup (outside click, Escape, a
  // tab opening from it): reset the toggle state so the next action click
  // opens fresh rather than toggling closed.
  ipcMain.on('crx:actionPopupClosed', (event) => {
    assertShellSender(event);
    openActionPopup = null;
  });

  // Listing, removing, loading from folders, publishing and installing from
  // Nostr (electron/browser-extensions.mts).
  browserExtensions = registerBrowserExtensionHandlers({
    assertShellSender,
    session: browserSession,
    webStorePath: extensionsPath,
    hidden: isAdblockExtension,
    askToAdd: askToAddExtension,
  });
}

// ---------------------------------------------------------------------------
// DevTools for the web browser app (window.dinos.devtools - see preload.cjs).
//
// Din runs fullscreen with a single native window (din-shell shows exactly one
// window), so Electron's default detached-devtools window is unusable.
// Instead, devtools dock inside the browser tab: the shell renders a second
// <webview> (the "host") below the page, and the host loads the bundled
// DevTools frontend connected to the inspected tab over a loopback CDP
// WebSocket bridge (see devtools-bridge.mts for why the straightforward
// setDevToolsWebContents wiring can't be used, and for the bridge's
// security properties).
//
// Hosts live in their own session partition (persist:devtools, which also
// keeps devtools preferences across runs) so they are never registered as
// browser tabs with the Chrome extension system. Both ends of every request
// are validated: the target must be a browser-tab guest and the host a
// devtools-partition guest, and only the shell may call the handlers.
// ---------------------------------------------------------------------------

const DEVTOOLS_PARTITION = 'persist:devtools';

/** The only session partitions a <webview> guest may attach in. */
const GUEST_PARTITIONS = new Set([
  WEBBROWSER_PARTITION,
  WEBBROWSER_PRIVATE_PARTITION,
  WEBBROWSER_TOR_PARTITION,
  DEVTOOLS_PARTITION,
  DIN_APPS_PARTITION,
  WIDGETS_PARTITION,
]);

/** The session all devtools host <webview>s run in. */
function devtoolsSession(): Electron.Session {
  return session.fromPartition(DEVTOOLS_PARTITION);
}

/** CDP proxy connecting devtools frontends to their inspected tabs. */
const devtoolsBridge = new DevtoolsBridge({
  // A session died with its tab or pane; let the shell reconcile pane UI.
  onSessionEnded: (targetId) => sendToShell('devtools:closed', { wcId: targetId }),
});

/** Resolve a renderer-supplied id to a devtools host guest, or null. */
function devtoolsHostFromId(wcId: unknown): Electron.WebContents | null {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (contents.session !== devtoolsSession()) return null;
  return contents;
}

/** Whether a before-input-event input is the devtools toggle shortcut. */
function isDevtoolsToggleInput(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return true;
  return Boolean(input.control && input.shift && input.key.toLowerCase() === 'i');
}

/** Whether a before-input-event input is Ctrl+P, which prints the page. */
function isPrintInput(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    input.control &&
    !input.shift &&
    !input.alt &&
    !input.meta &&
    input.key.toLowerCase() === 'p'
  );
}

/**
 * Keep a keydown from reaching the page, without losing the keyups after it.
 * Chromium drops every keyup a page would get after a keydown the browser
 * handled, until the next keydown. So the Alt of an Alt+Tab claimed here
 * never came up: the guest's Alt release (and the shell's `alt-released`)
 * only arrived after Alt was pressed again, and the switcher hung open until
 * then. Replaying the held modifier as an autorepeat keydown ends the
 * suppression at once; a held key repeating is something pages already see.
 * The replay waits a task: sent from inside this handler, it ended the
 * suppression before the claimed key's own char event, so Super+H typed an
 * "h" into the page.
 */
function claimGuestKey(
  contents: Electron.WebContents,
  event: Electron.Event,
  input: Electron.Input,
): void {
  event.preventDefault();
  const keyCode = input.alt ? 'Alt' : input.meta ? 'Meta' : input.control ? 'Control' : input.shift ? 'Shift' : null;
  if (!keyCode) return;
  const modifiers: NonNullable<Electron.InputEvent['modifiers']> = ['isautorepeat'];
  if (input.alt) modifiers.push('alt');
  if (input.meta) modifiers.push('meta');
  if (input.control) modifiers.push('control');
  if (input.shift) modifiers.push('shift');
  setTimeout(() => {
    if (!contents.isDestroyed()) contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  }, 0);
}

/** A shell-level shortcut forwarded from a guest (see window.dinos.shellShortcuts). */
type ShellShortcut =
  | { action: 'cycle-windows'; backward: boolean }
  | {
      action:
        | 'apps-menu'
        | 'assistant'
        | 'assistant-released'
        | 'dictation'
        | 'system-monitor'
        | 'security-options'
        | 'screenshot'
        | 'screenshot-area';
    }
  | { action: 'super-key'; down: boolean }
  | { action: 'focus-area'; area: 'menu-bar' | 'dock' | 'status' | 'next' | 'previous' }
  | { action: 'wm'; code: string; shift: boolean; ctrl: boolean; alt: boolean; repeat: boolean }
  | { action: 'alt-released' }
  | {
      action:
        | 'new-tab'
        | 'close-tab'
        | 'focus-address'
        | 'find'
        | 'view-source'
        | 'back'
        | 'forward'
        | 'reopen-tab'
        | 'new-window'
        | 'new-private-window'
        | 'close-window'
        | 'clear-data'
        | 'zoom-in'
        | 'zoom-out'
        | 'zoom-reset'
        | 'fullscreen';
    }
  | { action: 'reload'; force: boolean }
  | { action: 'cycle-tab'; backward: boolean }
  | { action: 'goto-tab'; digit: number };

/**
 * The physical keys Super may bind for window management, with any of
 * Shift, Ctrl and Alt. Keep in step with wmCommandFor in src/lib/wmBindings.ts.
 */
const WM_KEY_CODES = /^(?:Arrow(?:Left|Right|Up|Down)|Digit\d|Tab|Minus|Equal|Enter|Key[WQTFJMKC])$/;

/**
 * Map a guest before-input-event to a shell shortcut payload, or null.
 * Keyboard focus lives inside <webview> guests, so shell-level shortcuts
 * (window switching, browser tab management) must be intercepted here and
 * forwarded to the shell renderer (see src/lib/shellShortcuts.ts). Mirrors
 * the shell-DOM half in DesktopHotkeys.tsx - keep the two in sync.
 */
function shellShortcutForInput(input: Electron.Input): ShellShortcut | null {
  if (input.type !== 'keyDown') return null;
  // Print Screen (the laptop screenshot key): full-screen capture;
  // Shift+Print Screen: select an area. The dedicated box-select key on
  // newer laptops can't reach here - Chromium reports its keysym as
  // "Unidentified" - so it's read from evdev directly instead (see
  // watchEvdevKeys).
  if (input.key === 'PrintScreen' && !input.alt && !input.control && !input.meta) {
    return { action: input.shift ? 'screenshot-area' : 'screenshot' };
  }
  if (input.meta && !input.alt && !input.control && !input.shift && input.key === ' ') {
    return { action: 'apps-menu' };
  }
  // Super+A: the assistant's prompt.
  if (input.meta && !input.alt && !input.control && !input.shift && input.key.toLowerCase() === 'a') {
    return { action: 'assistant' };
  }
  // Super+H: dictation, as Win+H on Windows.
  if (input.meta && !input.alt && !input.control && !input.shift && input.key.toLowerCase() === 'h') {
    return input.isAutoRepeat ? null : { action: 'dictation' };
  }
  if (input.alt && !input.control && !input.meta && input.key === 'Tab') {
    return { action: 'cycle-windows', backward: Boolean(input.shift) };
  }
  // Super plus a window-management key: the shell decides what it does
  // (src/lib/wmBindings.ts), so the page never sees Super+1 and the like.
  if (input.meta && WM_KEY_CODES.test(input.code)) {
    return {
      action: 'wm',
      code: input.code,
      shift: Boolean(input.shift),
      ctrl: Boolean(input.control),
      alt: Boolean(input.alt),
      repeat: Boolean(input.isAutoRepeat),
    };
  }
  // Ctrl+F2 / F3 / F8: the keyboard to the menu bar, the Dock, the status
  // icons; Ctrl+F6 (Shift: backwards) round them, as on a Mac. Keep in step
  // with focusAreaFor in DesktopHotkeys.tsx.
  if (input.control && !input.alt && !input.meta) {
    const area = !input.shift
      ? ({ F2: 'menu-bar', F3: 'dock', F6: 'next', F8: 'status' } as const)[input.key as 'F2']
      : input.key === 'F6' ? 'previous' : undefined;
    if (area) return input.isAutoRepeat ? null : { action: 'focus-area', area };
  }
  // Ctrl+Shift+Escape: the System Monitor, as on Windows.
  if (input.control && input.shift && !input.alt && !input.meta && input.key === 'Escape') {
    return { action: 'system-monitor' };
  }
  // Ctrl+Alt+Delete: the security options screen, as on Windows.
  if (input.control && input.alt && !input.meta && input.key === 'Delete') {
    return { action: 'security-options' };
  }
  // Alt+Left/Right: history navigation (Chrome behavior).
  if (
    input.alt &&
    !input.control &&
    !input.meta &&
    (input.key === 'ArrowLeft' || input.key === 'ArrowRight')
  ) {
    return { action: input.key === 'ArrowLeft' ? 'back' : 'forward' };
  }
  // F5 / Shift+F5.
  if (input.key === 'F5' && !input.control && !input.alt && !input.meta) {
    return { action: 'reload', force: Boolean(input.shift) };
  }
  // Alt+D / F6: the address bar.
  if (input.key === 'F6' && !input.control && !input.alt && !input.meta && !input.shift) {
    return { action: 'focus-address' };
  }
  // F11: the page in full screen, and back.
  if (input.key === 'F11' && !input.control && !input.alt && !input.meta && !input.shift) {
    return input.isAutoRepeat ? null : { action: 'fullscreen' };
  }
  if (
    input.alt &&
    !input.control &&
    !input.meta &&
    !input.shift &&
    input.key.toLowerCase() === 'd'
  ) {
    return { action: 'focus-address' };
  }
  if (input.control && !input.alt && !input.meta && input.key === 'Tab') {
    return { action: 'cycle-tab', backward: Boolean(input.shift) };
  }
  if (
    input.control &&
    !input.shift &&
    !input.alt &&
    !input.meta &&
    (input.key === 'PageDown' || input.key === 'PageUp')
  ) {
    return { action: 'cycle-tab', backward: input.key === 'PageUp' };
  }
  // Page zoom: Ctrl+= or Ctrl++ (the latter usually needs Shift), Ctrl+-,
  // and Ctrl+0.
  if (input.control && !input.alt && !input.meta) {
    if (input.key === '=' || input.key === '+') return { action: 'zoom-in' };
    if (input.key === '-' && !input.shift) return { action: 'zoom-out' };
    if (input.key === '0' && !input.shift) return { action: 'zoom-reset' };
  }
  if (input.control && input.shift && !input.alt && !input.meta) {
    const key = input.key.toLowerCase();
    if (key === 'r') return { action: 'reload', force: true };
    if (key === 't') return { action: 'reopen-tab' };
    if (key === 'n') return { action: 'new-private-window' };
    if (key === 'w') return { action: 'close-window' };
    if (input.key === 'Delete') return { action: 'clear-data' };
    return null;
  }
  if (input.control && !input.shift && !input.alt && !input.meta) {
    const key = input.key.toLowerCase();
    if (key === 't') return { action: 'new-tab' };
    if (key === 'w') return { action: 'close-tab' };
    if (key === 'l') return { action: 'focus-address' };
    if (key === 'f') return { action: 'find' };
    if (key === 'u') return { action: 'view-source' };
    if (key === 'r') return { action: 'reload', force: false };
    if (key === 'n') return { action: 'new-window' };
    if (/^[1-9]$/.test(input.key)) {
      return { action: 'goto-tab', digit: Number(input.key) };
    }
  }
  return null;
}

function registerDevtoolsHandlers(): void {
  // Open a tab's devtools inside a devtools host <webview>.
  ipcMain.handle('devtools:open', async (event, targetWcId, hostWcId) => {
    assertShellSender(event);
    const target = anyBrowserTabFromId(targetWcId);
    const host = devtoolsHostFromId(hostWcId);
    if (!target || !host) throw new Error('devtools: invalid target or host');
    await devtoolsBridge.open(target, host);
  });

  // Close a tab's devtools (the shell is about to unmount the host).
  ipcMain.handle('devtools:close', (event, targetWcId) => {
    assertShellSender(event);
    if (typeof targetWcId !== 'number') return;
    devtoolsBridge.close(targetWcId);
  });

  // Reveal the element at a point (context-menu "Inspect"), given in window
  // pixels from the tab's top-left: the page's CSS pixels are those over the
  // tab's own zoom.
  ipcMain.handle('devtools:inspect', (event, targetWcId, x, y) => {
    assertShellSender(event);
    if (typeof targetWcId !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const target = webContents.fromId(targetWcId);
    const zoom = target && !target.isDestroyed() ? target.getZoomFactor() : 1;
    devtoolsBridge.inspect(targetWcId, Math.round(x / zoom), Math.round(y / zoom));
  });

  // Apply or clear device/responsive emulation on a tab.
  ipcMain.handle('devtools:emulate', async (event, targetWcId, metrics) => {
    assertShellSender(event);
    const target = anyBrowserTabFromId(targetWcId);
    if (!target) throw new Error('devtools: invalid target');
    if (metrics === null) {
      await devtoolsBridge.emulate(target.id, null);
      return;
    }
    if (
      !metrics ||
      !Number.isFinite(metrics.width) ||
      !Number.isFinite(metrics.height)
    ) {
      throw new Error('devtools: invalid emulation metrics');
    }
    await devtoolsBridge.emulate(target.id, {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: Number.isFinite(metrics.deviceScaleFactor)
        ? metrics.deviceScaleFactor
        : 0,
      mobile: Boolean(metrics.mobile),
      userAgent:
        typeof metrics.userAgent === 'string' ? metrics.userAgent : undefined,
    });
  });
}

app.whenReady().then(() => {
  if (process.env.DIN_DESKTOP_SESSION === '1' && hasSessionBus) {
    sessionBusAddress().then(allowCameraThroughPortal).catch((error) => {
      console.warn('Could not allow the camera through the desktop portal:', error);
    });
  }

  // Replace Electron's default application menu. Its role accelerators
  // (Ctrl+W "Close Window", Ctrl+Q "Quit") tear down the entire shell -
  // fatal in a desktop environment where Ctrl+W means "close the app's
  // tab" - and menu accelerators swallow those keys before the shell
  // renderer ever sees them. Production (kiosk) runs with no menu at all;
  // dev keeps reload plus the shell devtools on a non-conflicting
  // accelerator (the browser app already uses F12 / Ctrl+Shift+I for
  // per-tab devtools).
  if (DEV_URL) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Develop',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
            { type: 'separator' },
            // F11: fill the screen without restarting into the kiosk shell.
            { role: 'togglefullscreen' },
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  // Save downloads straight to ~/Downloads instead of popping a native
  // GTK save dialog (there is no desktop environment to host one). The shell's
  // own session saves silently; the browser sessions additionally report
  // progress to the Web Browser app (see registerBrowserDownloadHandlers).
  const downloadToHome = (_event: Electron.Event, item: Electron.DownloadItem) => {
    item.setSavePath(uniqueDownloadPath(item.getFilename()));
  };
  session.defaultSession.on('will-download', downloadToHome);
  // Devtools would otherwise fall back to the native dialog.
  devtoolsSession().on('will-download', downloadToHome);
  registerBrowserDownloadHandlers();

  registerPromptBridge();
  registerSitePermissionHandlers();
  hardenGuestSession(browserSession(), { prompts: true });
  hardenGuestSession(privateBrowserSession(), { prompts: true });
  hardenGuestSession(torBrowserSession(), { prompts: true });
  secureOnionSites(torBrowserSession());
  hardenGuestSession(devtoolsSession(), { prompts: false });
  // Web pages' notifications go to Din's notification center.
  for (const s of [browserSession(), privateBrowserSession(), torBrowserSession()]) {
    s.registerPreloadScript({ id: 'din-notifications', type: 'frame', filePath: NOTIFICATION_PRELOAD });
    s.registerPreloadScript({ id: 'din-geolocation', type: 'frame', filePath: GEOLOCATION_PRELOAD });
    s.registerPreloadScript({ id: 'din-permissions', type: 'frame', filePath: PERMISSIONS_PRELOAD });
    s.registerPreloadScript({ id: 'din-chrome-app', type: 'frame', filePath: CHROME_APP_PRELOAD });
    s.registerPreloadScript({ id: 'din-print', type: 'frame', filePath: PRINT_PRELOAD });
    s.registerPreloadScript({ id: 'din-screen-share', type: 'frame', filePath: SCREEN_SHARE_PRELOAD });
    s.registerPreloadScript({ id: 'din-eyedropper', type: 'frame', filePath: EYEDROPPER_PRELOAD });
    s.registerPreloadScript({ id: 'din-media', type: 'frame', filePath: MEDIA_PRELOAD });
    s.registerPreloadScript({ id: 'din-passwords', type: 'frame', filePath: PASSWORDS_PRELOAD });
    s.registerPreloadScript({ id: 'din-power-mode', type: 'frame', filePath: POWER_MODE_PRELOAD });
    allowScreenSharing(s);
  }
  registerScreenShareHandlers({
    assertShellSender,
    isShellSender,
    sendToShell,
    shellContents: () => (shellWindow && !shellWindow.webContents.isDestroyed() ? shellWindow.webContents : null),
    isShareableGuest: (contents) =>
      shellGuestFromId(contents.id) !== null && isBrowserTabSession(contents.session),
    isPrivate: isEphemeralBrowserSession,
    undim: undimCapture,
  });
  registerEyeDropperHandlers({
    isShellSender,
    sendToShell,
    isPageGuest: (contents) =>
      shellGuestFromId(contents.id) !== null && isBrowserTabSession(contents.session),
  });
  registerMediaHandlers({
    assertShellSender,
    sendToShell,
    isMediaGuest: (contents) =>
      shellGuestFromId(contents.id) !== null && isBrowserTabSession(contents.session),
  });
  registerPowerModeHandlers({
    assertShellSender,
    sendToShell,
    isPageGuest: (contents) =>
      shellGuestFromId(contents.id) !== null && isBrowserTabSession(contents.session),
  });
  // And a window.nostr backed by Din's signer, for tabs and installed apps;
  // private tabs get none.
  browserSession().registerPreloadScript({ id: 'din-nostr', type: 'frame', filePath: NOSTR_PRELOAD });
  // Installed nsites are napps: their pages and their service workers.
  browserSession().registerPreloadScript({ id: 'din-napp', type: 'frame', filePath: NAPP_PRELOAD });
  browserSession().registerPreloadScript({ id: 'din-napp-worker', type: 'service-worker', filePath: NAPP_PRELOAD });
  // Websites get Web Push, in tabs and as installed apps; private ones none.
  browserSession().registerPreloadScript({ id: 'din-web-push', type: 'frame', filePath: WEB_PUSH_PRELOAD });
  browserSession().registerPreloadScript({ id: 'din-web-push-worker', type: 'service-worker', filePath: WEB_PUSH_PRELOAD });

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    return net.fetch(pathToFileURL(resolveFile(pathname)).toString());
  });

  registerDinApps(
    {
      distDir: DIST,
      devUrl: DEV_URL,
      shell: () => (shellWindow && !shellWindow.webContents.isDestroyed() ? shellWindow.webContents : null),
      assertShellSender,
      isShellSender,
      protectedPaths: () => [app.getPath('userData')],
      serveLaunched,
    },
    DIN_APP_PRELOAD,
  );
  // An app prints as a page does, with the web's print().
  appsSession().registerPreloadScript({ id: 'din-print', type: 'frame', filePath: PRINT_PRELOAD });
  appsSession().registerPreloadScript({ id: 'din-app-sw', type: 'frame', filePath: DIN_APP_WORKER_PRELOAD });
  appsSession().registerPreloadScript({ id: 'din-app-sw-worker', type: 'service-worker', filePath: DIN_APP_WORKER_PRELOAD });
  registerWidgets(
    {
      // In development dist/ may hold nothing but them (npm run dev builds them).
      widgetsDir: DEV_URL ? path.resolve(import.meta.dirname, '..', 'dist', 'widgets') : path.join(DIST, 'widgets'),
      cacheDir: path.join(app.getPath('userData'), 'Widgets'),
      shell: () => (shellWindow && !shellWindow.webContents.isDestroyed() ? shellWindow.webContents : null),
      assertShellSender,
    },
    WIDGET_PRELOAD,
  );
  registerDinLaunch({
    sendToShell,
    hasShell: () => !!shellWindow && !shellWindow.webContents.isDestroyed(),
    assertShellSender,
    protectedPaths: () => [app.getPath('userData')],
  });
  registerDinFileApps({
    sendToShell,
    assertShellSender,
    protectedPaths: () => [app.getPath('userData')],
  });

  registerFsHandlers();
  registerFileOpsHandlers({ assertShellSender, sendToShell });
  registerProjectHandlers({ assertShellSender });
  registerLocalFileProtocol(SHELL_ORIGIN);
  registerPtyHandlers();
  registerWifiHandlers({
    assertShellSender,
    proxySessions: () => [browserSession(), privateBrowserSession()],
    torSession: torBrowserSession(),
  });
  registerVpnHandlers({ assertShellSender });
  registerTorHandlers({ assertShellSender, sendToShell });
  registerFirewallHandlers({ assertShellSender, sendToShell });
  registerSiteLocationHandlers({ assertShellSender, sendToShell });
  registerDisplayHandlers();
  registerPageFullscreenHandlers();
  registerGuestVisibilityHandlers();
  registerGuestFileDropHandlers();
  registerMonitorsHandlers();
  registerPowerHandlers();
  registerAudioHandlers();
  registerMediaKeys();
  registerSystemEvents();
  registerBrightnessHandlers();
  registerScreenshotHandlers();
  registerScreenRecorderHandlers({
    assertShellSender,
    sendToShell,
    shellWindow: () => shellWindow,
    primaryBounds: async () => (await primaryDisplay(screen.getAllDisplays())).bounds,
  });
  registerCaptureHandlers({
    assertShellSender,
    sendToShell,
    shellWindow: () => shellWindow,
    primaryBounds: async () => (await primaryDisplay(screen.getAllDisplays())).bounds,
  });
  watchEvdevKeys();
  registerCrxHandlers();
  registerCertificateHandling();
  registerBrowserDataHandlers();
  registerBrowserPreconnectHandler();
  registerFindHandlers();
  registerThemeHandler();
  registerUserscriptHandlers({ assertShellSender });
  registerDevtoolsHandlers();
  registerNostrBridge();
  registerHighlightBridge();
  registerFilePickerBridge();
  registerNativeAppHandlers({
    assertShellSender,
    shell: () => (shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents : null),
  });
  registerKeyboardHandlers({ assertShellSender });
  registerDateTimeHandlers({ assertShellSender });
  registerCursorHandlers({ assertShellSender });
  registerMouseHandlers({ assertShellSender, sendToShell });
  registerAccessibilityHandlers({ assertShellSender });
  registerIconThemeHandlers({
    assertShellSender,
    shell: () => (shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents : null),
  });
  registerInddHandlers({ assertShellSender });
  registerMailHandlers({ assertShellSender, sendToShell });
  registerPhoneHandlers({ assertShellSender, sendToShell });
  registerQuickShareHandlers({ assertShellSender, sendToShell });
  registerVmsHandlers({ assertShellSender, sendToShell });
  registerTrayHandlers({ assertShellSender, sendToShell });
  registerOpenUri({ sendToShell });
  registerNotificationHandlers({
    isShellSender,
    sendToShell,
    webPermission: siteNotificationPermission,
    remembersPermission: remembersDecisions,
  });
  registerNappHandlers({
    session: browserSession,
    sendToShell,
    assertShellSender,
    isSiteGuest: (contents) => contents.getType() === 'webview' && contents.session === browserSession(),
    permission: (origin, capability) => {
      const allowed = decisionsFor(browserSession()).get(decisionKey(origin, capability));
      return allowed === undefined ? 'default' : allowed ? 'granted' : 'denied';
    },
    requestPermission: (origin, capability) => requestSiteCapability(browserSession(), origin, capability),
    forgetPermissions: (origin, only) => {
      for (const capability of only ? [only] : SITE_CAPABILITIES) decide(browserSession(), origin, capability, null);
    },
  });
  registerWebPushHandlers({
    session: browserSession,
    sendToShell,
    assertShellSender,
    permission: (origin) => siteNotificationPermission(browserSession(), origin),
    requestPermission: (origin) => requestSiteCapability(browserSession(), origin, 'notifications'),
    isInstalledApp: isAppGuest,
    syncPermission: (origin) => {
      const allowed = decisionsFor(browserSession()).get(decisionKey(origin, 'background-sync'));
      return allowed === undefined ? 'default' : allowed ? 'granted' : 'denied';
    },
    requestSyncPermission: (origin) => requestSiteCapability(browserSession(), origin, 'background-sync'),
    forgetSyncPermission: (origin) => decide(browserSession(), origin, 'background-sync', null),
  });
  registerDinAppWorkers({ sendToShell, backgroundGrant });
  registerPeriodicSyncHandlers({ assertShellSender, sendToShell });
  registerGeolocationHandlers({
    request: (s, origin) => requestSiteCapability(s, origin, 'geolocation'),
    allowed: (s, origin) => siteCapabilityAllowed(s, origin, 'geolocation'),
  });
  registerInstallerHandlers({ assertShellSender, sendToShell });
  registerBluetoothLoginHandlers({ assertShellSender, sendToShell });
  registerBluetoothHandlers({ assertShellSender, sendToShell });
  registerFeaturesHandlers({ assertShellSender, sendToShell });
  registerVolumesHandlers({ assertShellSender, sendToShell, isInstalling });
  registerPrintingHandlers({
    assertShellSender,
    sendToShell,
    guestFromId: shellGuestFromId,
    isTorSession: (s) => s === torBrowserSession(),
    isAppGuest: isDinAppGuest,
  });
  app.on('will-quit', cleanUpPrinting);
  registerSystemMonitorHandlers({
    assertShellSender,
    sendToShell,
    shell: () => (shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents : null),
    pageKind: (contents) => {
      if (contents.getType() !== 'webview') return 'page';
      if (isAppGuest(contents)) return 'web-app';
      if (contents.session === browserSession()) return 'browser-tab';
      if (isEphemeralBrowserSession(contents.session)) return 'private-tab';
      if (contents.session === devtoolsSession()) return 'devtools';
      return 'page';
    },
  });
  registerNostrdHandlers({ assertShellSender, sendToShell });
  registerAssistantHandlers({ assertShellSender, sendToShell });
  registerDictationHandlers({ assertShellSender, guestFromId: shellGuestFromId });
  registerBootScreenHandlers({ assertShellSender });
  registerLockHandlers({ assertShellSender });
  registerEraseHandlers({ assertShellSender });
  registerPasswordsHandlers({
    assertShellSender,
    isBridgeEvent,
    sendToShell,
    isAutofillGuest: (contents) =>
      shellGuestFromId(contents.id) !== null && isBrowserTabSession(contents.session),
  });
  registerAskpass({
    sendToShell,
    hasShell: () => !!shellWindow && !shellWindow.webContents.isDestroyed(),
    assertShellSender,
  });
  registerPolkitAgent({
    sendToShell,
    hasShell: () => !!shellWindow && !shellWindow.webContents.isDestroyed(),
    assertShellSender,
  });
  registerUpdaterHandlers({ assertShellSender, sendToShell, assertSafeToPowerOff });
  registerFirmwareHandlers({ assertShellSender, sendToShell, assertSafeToPowerOff });
  registerSystemPackageHandlers({ assertShellSender });
  registerLoginSessionHandlers({ devUrl: DEV_URL, assertShellSender, sendToShell });
  registerAirPlayHandlers({
    assertShellSender,
    sendToShell,
    primaryOutput: async () => (await queryOutputs()).find((o) => o.primary && o.enabled)?.name ?? null,
  });
  registerNativeDisplayHandlers({
    assertShellSender,
    shell: () => (shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents : null),
  });

  // nsite:// in every browser session, installed apps' windows included. This
  // process has no Nostr client, so manifest lookups are relayed to the shell
  // renderer (NsiteBridgeHost), which owns Nostrify, the relay list, and the
  // query cache. Private windows never write the nsite store. Not Tor's
  // session: those lookups and blob fetches go out directly, so an onion page
  // that loaded nsite:// would learn its visitor's address.
  registerNsiteProtocol({
    sessions: [
      { session: browserSession(), persist: true },
      { session: privateBrowserSession(), persist: false },
    ],
    sendToShell,
    isShellSender,
    onUninstall: forgetNappSite,
  });

  // Browser tabs (and installed apps, which share their session) say they're
  // Chrome, as Chromium-based browsers do: Electron's default user agent
  // names Electron, which sites like YouTube take as a sign of an ad blocker.
  for (const s of [browserSession(), privateBrowserSession(), torBrowserSession()]) {
    s.setUserAgent(s.getUserAgent().replace(/\s(Electron|din)\/\S+/gi, ''));
  }

  // Must run before any <webview> is created so the extension system's
  // preload/APIs are in place when the first tab loads.
  setupChromeExtensions();

  // The built-in ad blocker (electron/adblock.mts). Also before the first
  // <webview>: its extension and preloads must be in place for the first tab.
  setupAdblock({
    browserSession: browserSession(),
    privateSessions: [privateBrowserSession(), torBrowserSession()],
    isBrowserTab: (contents) => anyBrowserTabFromId(contents.id) === contents || isAppGuest(contents),
    beforeRequest: (s, details) => (s === torBrowserSession() ? onionRequest(details) : null),
    assertShellSender,
    sendToShell,
    onTopLevelResponse: (url, coop, onionLocation, nsiteLocation) => {
      topLevelResponse(browserSession(), url, coop);
      siteLocationResponse(url, onionLocation, nsiteLocation);
    },
  });

  // The pop-up blocker, and window.opener for windows pages open
  // (electron/popups.mts). Also before the first <webview>, for its preload.
  setupPopups({
    sessions: [browserSession(), privateBrowserSession(), torBrowserSession()],
    extensionSessions: [browserSession()],
    isWebGuest: (contents) => contents.getType() === 'webview' && isBrowserTabSession(contents.session),
    assertShellSender,
    sendToShell,
    onTopLevelResponse: (_s, url, headers) => {
      siteLocationResponse(url, responseHeader(headers, 'onion-location'), responseHeader(headers, 'nsite-location'));
    },
  });

  // Route chrome.action popups into the shell instead of native windows.
  overrideActionPopup();

  // Production runs with no window manager (din-shell, on DinOS or as a
  // login session elsewhere, or a bare X11 session). din-shell force-fills the one app across every
  // output, but bare X11 has nothing to honor the EWMH fullscreen hint, so
  // the window would sit at its default size letterboxed on a black screen.
  // Size it to cover every display explicitly and drop the frame;
  // fullscreen/kiosk still apply where a compositor does honor them. The
  // desktop itself works out where each monitor is (window.dinos.monitors).
  const production = !DEV_URL;
  // Bare X11 fullscreens a window onto one display; across several, the
  // explicit bounds have to do.
  const spanX11 = DISPLAY_TOOL === 'xrandr' && screen.getAllDisplays().length > 1;
  // Fullscreen and kiosk are applied when the window is revealed (below),
  // not here: asking for them at construction maps the window at once on
  // Wayland, show: false or not, and din-shell then presents Chromium's white
  // surface before the page's first frame.
  const fullscreen = production && !spanX11;
  const win = new BrowserWindow({
    // Dev: normal windowed shell. Production: fills the displays, frameless.
    frame: !production,
    // Electron 43 rounds frameless windows on Linux; the desktop is square.
    roundedCorners: false,
    ...(production ? screenBounds() : { width: 1280, height: 800 }),
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    // Stay hidden until the renderer reports its first frame is ready (the
    // shell:bootReady gate below). With no window manager (din-shell on DinOS,
    // bare X11 otherwise), showing early presents an unpainted surface — a
    // white/pixelated glitch frame. The renderer then fades in from black.
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Expose the fs bridge (window.dinos.fs) to the shell.
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      // Enable <webview> so the in-shell web browser app can load arbitrary
      // sites (a real embedder, unlike an <iframe> which remote sites block
      // via X-Frame-Options / frame-ancestors). The renderer feature-detects
      // this and falls back to an <iframe> when running in a plain browser.
      webviewTag: true,
    },
  });

  shellContentsId = win.webContents.id;
  shellWindow = win;
  // A destroyed window throws on any property, webContents included, and
  // quitting runs will-quit hooks that still push to the shell after it.
  win.on('closed', () => {
    if (shellWindow === win) shellWindow = null;
  });

  // A profiling session (`npm run session:update -- --profile`): the shell's
  // periodic measurements go to stderr, and from there to the journal.
  if (process.env.DIN_PROFILE === '1') {
    win.webContents.on('console-message', (event) => {
      if (event.message.startsWith('[din perf]')) process.stderr.write(`${event.message}\n`);
    });
  }

  // The shell preload follows its window across navigations, so the shell must
  // never leave its own origin: a remote page loaded here would inherit
  // window.dinos.fs, window.dinos.pty and every other bridge. External-app handoffs
  // (nostrconnect: for remote signers) are the one exception - they never
  // replace the document. Web links go to the Web Browser instead.
  const keepShellHome = (event: Electron.Event, url: string) => {
    if (isShellUrl(url)) return;
    event.preventDefault();
    if (/^(https?|nsite):\/\//i.test(url)) sendToShell('crx:openTab', { url });
  };
  win.webContents.on('will-navigate', (event) => {
    if (/^nostrconnect:/i.test(event.url)) return;
    keepShellHome(event, event.url);
  });
  win.webContents.on('will-redirect', (event) => {
    if (event.isMainFrame) keepShellHome(event, event.url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|nsite):\/\//i.test(url)) sendToShell('crx:openTab', { url });
    return { action: 'deny' };
  });

  // Keep every guest locked down (sandboxed, no Node), and give browser tabs
  // their highlight preload.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Every guest must live in one of Din's own partitions. A guest in the
    // default session would share the shell's app:// origin - and with it the
    // shell's storage, including any locally stored nsec.
    if (!GUEST_PARTITIONS.has(params.partition)) {
      event.preventDefault();
      return;
    }
    // A built-in app's window: din:// (or din+file://) only, sandboxed, no extra preloads, and
    // transparent, so an app can draw its own window's shape.
    if (params.partition === DIN_APPS_PARTITION) {
      if (!appIdOf(typeof params.src === 'string' ? params.src : '')) {
        event.preventDefault();
        return;
      }
      attachingGuestSrc = params.src;
      attachingGuestIsApp = false;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.nodeIntegrationInSubFrames = false;
      delete webPreferences.preload;
      return;
    }
    // A widget: widget://, napplet:// or widget+file:// only, sandboxed, no extra preloads.
    if (params.partition === WIDGETS_PARTITION) {
      if (!widgetOf(typeof params.src === 'string' ? params.src : '')) {
        event.preventDefault();
        return;
      }
      attachingGuestSrc = params.src;
      attachingGuestIsApp = false;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.nodeIntegrationInSubFrames = false;
      delete webPreferences.preload;
      return;
    }
    // Electron spreads the element's `webpreferences` into these, so the
    // shell's mark would reach the guest's own preferences: take it out.
    const isApp = typeof params.webpreferences === 'string' &&
      params.webpreferences.split(',').some((entry) => entry.trim() === APP_GUEST_MARK);
    delete (webPreferences as Record<string, unknown>)[APP_GUEST_MARK.split('=')[0]];
    // An installed app's window is a page in the browser's profile, nowhere else.
    if (isApp && params.partition !== WEBBROWSER_PARTITION) {
      event.preventDefault();
      return;
    }
    // Handed to the web-contents-created hook, which Electron runs next.
    attachingGuestSrc = typeof params.src === 'string' ? params.src : '';
    attachingGuestIsApp = isApp;
    popupAttaching(attachingGuestSrc);
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Guests are transparent by default, so a page that leaves its canvas to
    // the color scheme (a dark-scheme page with no background, a page-source
    // view in dark mode) shows the host's white through it under dark text.
    // Opaque, Chromium paints the canvas to match the scheme as Chrome does.
    // Extension popups keep transparency for their own shapes.
    if (!attachingGuestSrc.startsWith('chrome-extension://')) {
      webPreferences.transparent = false;
    }
    // The ad blocker's engine, before the tab's first request.
    const ephemeralTab =
      params.partition === WEBBROWSER_PRIVATE_PARTITION || params.partition === WEBBROWSER_TOR_PARTITION;
    if (params.partition === WEBBROWSER_PARTITION || ephemeralTab) {
      ensureAdblockEngine();
    }
    // Every frame of a web page needs PRINT_PRELOAD: a frame from another
    // origin calling its own print() would otherwise open Chromium's GTK
    // print dialog, which takes over the whole screen under din-shell. The other
    // session preloads guard themselves to the top document.
    if (ephemeralTab) {
      webPreferences.nodeIntegrationInSubFrames = true;
    }
    // Onion sites run as https (electron/onion-proxy.mts) but still name
    // http:// and ws:// onion addresses, which Tor already encrypts and
    // authenticates; Tor Browser lets them load. Plain http to anywhere else
    // goes to https or nowhere (onionRequest in tor.mts).
    if (params.partition === WEBBROWSER_TOR_PARTITION) {
      webPreferences.allowRunningInsecureContent = true;
    }
    if (params.partition === WEBBROWSER_PARTITION) {
      // Load frame preloads into sub-frames, not just the top document, so the
      // chrome.* API preload (session-registered by electron-chrome-extensions
      // as type:'frame') reaches extension web_accessible_resource iframes -
      // e.g. Bitwarden's inline-autofill overlay, a chrome-extension:// iframe
      // the content script embeds in the page. Without this the overlay's own
      // bundle has no chrome.runtime and the fill prompt never renders. The
      // guest stays sandboxed with no Node, so this only widens preload reach.
      // The NIP-07 preload (NOSTR_PRELOAD) stays inert in iframes, and main
      // refuses calls from anything but a top document either way.
      webPreferences.nodeIntegrationInSubFrames = true;
      if (!isApp && !attachingGuestSrc.startsWith('chrome-extension://')) {
        // Ad-hoc browser tabs get the highlight preload (no signer surface,
        // just the NIP-84 highlight affordance; see HIGHLIGHT_PRELOAD).
        // Extension pages in this session (the action popup) and installed
        // apps' windows don't. The preload now loads in sub-frames too, but
        // guards itself to the top frame (it would otherwise duplicate in
        // every iframe).
        webPreferences.preload = HIGHLIGHT_PRELOAD;
      }
    }
  });

  // With no window manager, the shell won't follow a resolution change on its
  // own. Refit it over every display whenever they change (e.g. the Settings
  // display panel applying a new mode, or a monitor plugged in), and tell the
  // desktop where the monitors are now. A newly connected set of outputs gets
  // its saved arrangement back, and any gap between them is closed (Wayland).
  if (production) {
    const refit = () => {
      if (win.isDestroyed()) return;
      if (DISPLAY_TOOL === 'xrandr') {
        if (screen.getAllDisplays().length > 1 && win.isKiosk()) win.setKiosk(false);
        win.setBounds(screenBounds());
      }
      scheduleMonitorsUpdate();
      void restoreSavedLayout().then(closeLayoutGaps);
    };
    void restoreSavedLayout().then(closeLayoutGaps);
    screen.on('display-metrics-changed', refit);
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    win.on('closed', () => {
      screen.removeListener('display-metrics-changed', refit);
      screen.removeListener('display-added', refit);
      screen.removeListener('display-removed', refit);
      if (lidTimer) clearInterval(lidTimer);
    });

    // Watch the ACPI lid: switch off the built-in panel and hand off to an
    // external display when the laptop is docked and the lid closes (no-op on
    // machines with no lid, e.g. desktops or the QEMU VM).
    registerLidWatch();
  }

  // Present only once the shell renderer reports it has mounted beneath the
  // black boot veil (electron/preload.cjs -> src/components/desktop/
  // BootVeil.tsx). ready-to-show fires on the first paint of ANYTHING -
  // including the white initial about:blank - and mapping the window that
  // early presents an unpainted (white/pixelated) buffer. The short warm-up
  // lets the hidden window composite complete black frames before it maps;
  // the veil then fades in from black. The fallback ensures a crashed
  // renderer can never leave the kiosk on a permanent black screen.
  // The renderer's request resolves once the window is on screen, which is
  // when the veil starts to fade: a hidden window's document still reports
  // itself visible, so the renderer can't tell on its own.
  const reveal = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    if (fullscreen) {
      win.setFullScreen(true);
      win.setKiosk(true);
    }
    win.show();
    watchLiveStick();
    watchDiskSpace();
  };
  // `touch ~/.config/din/skip-restore` (from a text console, Ctrl+Alt+F2)
  // has the next start leave the saved windows closed. Taken once.
  ipcMain.handle('shell:skipRestore', (event) => {
    assertShellSender(event);
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const flag = path.join(config, 'din', 'skip-restore');
    try {
      fs.unlinkSync(flag);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('shell:bootReady', async (event) => {
    if (event.sender !== win.webContents) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    reveal();
  });
  setTimeout(reveal, 10000);

  win.loadURL(DEV_URL || 'app://din/');

  if (DEV_URL) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
});

// Release the media-key grabs (VolumeUp/Down/Mute) and stop the night-light
// gamma child when the app exits. (The embedded display tears itself down;
// see native-display.mts.)
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopNightLight();
  stopScreenRecording();
  stopCapture();
});

const VIEW_SOURCE_LINE_WRAP_CSS = `
  form:has(.line-wrap-control input:checked) ~ table {
    width: 100%;
    min-width: 0;
    white-space: pre-wrap;
    word-break: normal;
    overflow-wrap: anywhere;
  }
`;

/**
 * Replace a page-source view's "Line wrap" checkbox with a copy that wraps
 * through CSS alone. Blink's own checkbox saves its state through a service
 * only Chrome provides; in Electron that request is a bad IPC message and the
 * tab's renderer is killed. Source views run no script (executeJavaScript and
 * insertCSS never settle there), so the swap goes through the debugger: nodes
 * parsed from markup come without Blink's native change listener.
 */
async function defuseViewSourceLineWrap(contents: Electron.WebContents): Promise<void> {
  const dbg = contents.debugger;
  // The devtools bridge may already hold the debugger for this tab.
  const owned = !dbg.isAttached();
  if (owned) dbg.attach('1.3');
  try {
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const query = async (selector: string): Promise<number> =>
      (await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
    const outer = async (nodeId: number): Promise<string> =>
      (await dbg.sendCommand('DOM.getOuterHTML', { nodeId })).outerHTML;
    const form = await query('form:has(.line-wrap-control)');
    const gutter = await query('.line-gutter-backdrop');
    if (!form || !gutter) return;
    const formHTML = await outer(form);
    const gutterHTML = await outer(gutter);
    // Re-set in place, the form would be patched and keep its old nodes, so
    // remove it and re-create it beside the gutter (its old place).
    await dbg.sendCommand('DOM.removeNode', { nodeId: form });
    await dbg.sendCommand('DOM.setOuterHTML', {
      nodeId: gutter,
      outerHTML: `${gutterHTML}${formHTML}<style>${VIEW_SOURCE_LINE_WRAP_CSS}</style>`,
    });
  } finally {
    if (owned && dbg.isAttached()) dbg.detach();
  }
}

// Harden any <webview> the shell embeds (the web browser app). Keep them
// sandboxed with no Node integration, and deny requests to spawn native
// windows - target=_blank and friends become new browser tabs instead.
// Browser-partition guests are also registered as tabs with the Chrome
// extension system (chrome.tabs sees them; content scripts inject).
app.on('web-contents-created', (_event, contents) => {
  // Each of Din's modules that tracks a guest (media, popups, passwords,
  // screen share, …) cleans up on its 'destroyed', once per guest, and a
  // browser tab is tracked by more than Node's default 10. Not a leak.
  contents.setMaxListeners(30);

  // Brightness and volume keys arrive as ordinary keyboard input to whichever
  // contents holds focus (shell or any guest), so hook them everywhere.
  attachMediaKeys(contents);

  // Holding Super lets the shell drag windows from anywhere, but it can't
  // see the key while focus is inside a guest, so forward its presses (not
  // consumed: Super is still a modifier for the page). Alt's release is
  // forwarded too, so an Alt+Tab started in a guest commits the moment Alt
  // comes up.
  // Super+A's release is forwarded too, when it was pressed here: holding it
  // dictates into the assistant's prompt until it comes up.
  if (contents.getType() === 'webview') {
    attachPageFullscreen(contents);
    let assistantKeyDown = false;
    contents.on('before-input-event', (event, input) => {
      // Super+H held: only the first press toggles dictation (see
      // shellShortcutForInput), but the repeats mustn't type either.
      if (
        input.type === 'keyDown' &&
        input.isAutoRepeat &&
        input.meta &&
        !input.alt &&
        !input.control &&
        !input.shift &&
        input.key.toLowerCase() === 'h'
      ) {
        claimGuestKey(contents, event, input);
        return;
      }
      if (input.key === 'Alt' && input.type === 'keyUp') {
        sendToShell('shortcut', { action: 'alt-released' } satisfies ShellShortcut);
        return;
      }
      if (input.key.toLowerCase() === 'a') {
        if (input.type === 'keyDown' && input.meta && !input.alt && !input.control && !input.shift) {
          assistantKeyDown = true;
        } else if (input.type === 'keyUp' && assistantKeyDown) {
          assistantKeyDown = false;
          sendToShell('shortcut', { action: 'assistant-released' } satisfies ShellShortcut);
        }
        return;
      }
      if (input.key !== 'Meta' || input.isAutoRepeat) return;
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      sendToShell('shortcut', { action: 'super-key', down: input.type === 'keyDown' } satisfies ShellShortcut);
    });

    contents.on('dom-ready', () => {
      if (!contents.getURL().startsWith('view-source:')) return;
      defuseViewSourceLineWrap(contents).catch(() => {});
    });
  }

  if (contents.getType() !== 'webview') {
    // The shell renderer (address bar, inputs, etc.) gets no context menu by
    // default: editable fields get spelling and Cut/Copy/Paste/Select All.
    contents.on('context-menu', (_e, params) => popupEditMenu(contents, params));
    return;
  }

  forwardGuestInput(contents);

  // A built-in app's window (electron/din-apps.mts): none of what follows,
  // which is for web pages.
  if (isDinAppGuest(contents)) {
    attachAppGuest(contents, attachingGuestSrc, sendToShell);
    attachLaunchedGuest(contents, attachingGuestSrc);
    attachingGuestSrc = '';
    forwardShellShortcuts(contents);
    // Apps draw their own menus; text fields keep cut, copy and paste.
    contents.on('context-menu', (_e, params) => popupEditMenu(contents, params));
    return;
  }

  // A widget (electron/widgets.mts): the same, and the desktop draws its menu.
  if (isWidgetGuest(contents)) {
    attachWidgetGuest(contents, attachingGuestSrc, sendToShell);
    attachingGuestSrc = '';
    forwardShellShortcuts(contents);
    contents.on('context-menu', (_e, params) => popupEditMenu(contents, params));
    return;
  }

  watchMediaGuest(contents);

  // An installed app's window, as the shell said in will-attach-webview
  // above. It shares the browser's session but is no browser tab.
  const isAppWindow = attachingGuestIsApp && contents.session === browserSession();
  attachingGuestIsApp = false;
  if (isAppWindow) {
    appGuests.add(contents.id);
    contents.once('destroyed', () => appGuests.delete(contents.id));
  }
  const isBrowserTab = contents.session === browserSession() && !isAppWindow;
  // Private and Tor tabs too: what goes for every tab, like the inspector.
  const isAnyBrowserTab = isBrowserTab || isEphemeralBrowserSession(contents.session);

  // Guests that start on a chrome-extension:// URL are extension pages, not
  // web content: the in-shell action popup (ExtensionPopupHost) and any
  // extension page the browser opens as a tab (an options page). Consume the
  // src handed over by will-attach-webview above.
  const isExtensionPageGuest = attachingGuestSrc.startsWith('chrome-extension://');
  attachingGuestSrc = '';

  // Web Bluetooth would otherwise pick the first device it finds, unasked.
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });

  // Pin an installed web app to the origin it was opened on. Leaving it - a
  // plain link, a redirect, a script setting location - opens the destination
  // in the Web Browser (or the installed app that owns it) instead, so a
  // foreign page never runs inside the app's window with window.nostr.
  //
  // The pin is taken from the first committed load rather than the raw src,
  // so an app whose home URL redirects (example.com -> www.example.com) still
  // opens; the src itself was vetted when the app was installed. An nsite app
  // is pinned to its canonical, key-derived host, never to a name: the same
  // origin the site has in a browser tab, so the two share its storage.
  if (isAppWindow) {
    let appOrigin: string | null = null;
    contents.on('did-navigate', (_event, url) => {
      // First real commit only (an offline first load commits an error page,
      // which mustn't become the pin).
      const origin = appOriginOf(url);
      if (appOrigin || !origin) return;
      appOrigin = origin;
      appGuestOrigins.set(contents.id, origin);
    });
    contents.once('destroyed', () => appGuestOrigins.delete(contents.id));
    const keepAppHome = (event: Electron.Event, url: string) => {
      if (appOrigin && appOriginOf(url) === appOrigin) return;
      event.preventDefault();
      if (/^(https?|nsite):\/\//i.test(url)) {
        sendToShell('crx:openTab', { url, openerWcId: contents.id });
      }
    };
    contents.on('will-navigate', (event) => keepAppHome(event, event.url));
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && appOrigin) keepAppHome(event, event.url);
    });
  }

  // Route native <input type=file> clicks to the in-Din file picker instead of
  // the host OS dialog. Real web content only - browser tabs (persistent and
  // private) and installed web-app guests; extension pages and devtools hosts
  // are left with their default behavior.
  const isWebPage = !isExtensionPageGuest && isBrowserTabSession(contents.session);
  if (isWebPage) {
    // A page's pending window.nostr requests die with it, and the prompts the
    // user hasn't answered yet go away.
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        cancelNostrRequestsFor(contents.id, 'The page navigated away');
      }
    });
    contents.once('destroyed', () => cancelNostrRequestsFor(contents.id, 'The page was closed'));
    attachFileChooserInterception(contents);
    attachSelectionColor(contents);
    // Pop-ups need a click (electron/popups.mts); a tab one opened is linked
    // to its opener.
    attachPopups(contents);
    popupAttached(contents);
  }

  // Register web-content tabs with the extension system (chrome.tabs sees
  // them; content scripts inject). Extension pages are deliberately left out:
  // store.addTab treats each added tab as activated, so registering the action
  // popup made the extension's own popup the "active tab" the moment it opened
  // - a popup then matched itself (chrome-extension://...) instead of the page
  // behind it, and the real active tab stayed lost after the popup closed.
  // Extension pages the browser does open as tabs arrive through
  // chrome.tabs.create, which registers them itself.
  if (chromeExtensions && shellWindow && isBrowserTab && !isExtensionPageGuest) {
    chromeExtensions.addTab(contents, shellWindow);
  }

  // Userscripts (the browser's native script manager,
  // electron/userscripts.mts): inject matching scripts as pages load, and
  // turn navigations to *.user.js files into install prompts in the shell
  // instead of pages of raw source. Extension pages are off limits.
  // The ad blocker's per-page blocked count (electron/adblock.mts).
  // Installed apps' windows are blocked in as well: the extension half of the
  // blocker sees every request in the browser's session anyway.
  if (isBrowserTabSession(contents.session) && !isExtensionPageGuest) {
    attachAdblock(contents);
  }
  if (isBrowserTabSession(contents.session) && !isAppWindow && !isExtensionPageGuest) {
    // The onion service and nsite the page names, for the address bar
    // (electron/site-locations.mts), and onion sites in Tor's session and
    // nothing else there (electron/tor.mts).
    attachSiteLocations(contents);
    keepTorSession(contents, contents.session === torBrowserSession());
  }

  if (isBrowserTab && !isExtensionPageGuest) {
    attachUserscripts(contents);
    contents.on('will-navigate', (event, url) => {
      if (isUserscriptInstallUrl(url)) {
        event.preventDefault();
        sendToShell('userscripts:installRequested', { url, wcId: contents.id });
      }
    });
  }

  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    // A window.open that asked for a pop-up gets a small window of its own.
    // A web page's only: extension pages open theirs as tabs, as before.
    const popup = isWebPage
      ? popupFeatures(disposition, features, isEphemeralBrowserSession(contents.session), contents.session === torBrowserSession())
      : null;
    if (isBrowserTab && isUserscriptInstallUrl(url)) {
      sendToShell('userscripts:installRequested', { url, wcId: contents.id });
    } else if (
      /^(https|nsite):\/\//i.test(url) ||
      // Onion services are mostly plain http, and Tor encrypts them anyway.
      (/^http:\/\//i.test(url) && isOnionUrl(url)) ||
      // Extension pages may open their own kind; a web page may not, since the
      // shell's fresh tab would skip Chromium's web_accessible_resources check.
      (/^chrome-extension:\/\//i.test(url) && contents.getURL().startsWith('chrome-extension://'))
    ) {
      // A web page needs a click to open one (the pop-up blocker); extension
      // pages are trusted.
      if (isWebPage && !mayOpenWindow(contents, url)) return { action: 'deny' };
      // Tag the popup with its opener so the shell opens the new tab in the
      // same window/session - keeps private-window links out of the
      // persistent, authenticated session (and vice versa). Middle-click and
      // Ctrl/Cmd-click arrive as 'background-tab': open the tab behind the
      // current page without stealing focus or raising the window, Chrome-style.
      sendToShell('crx:openTab', {
        url,
        openerWcId: contents.id,
        background: disposition === 'background-tab',
        popup: popup ?? undefined,
      });
      if (isWebPage) windowOpened(contents, url, popup);
    } else if (isWebPage && url === 'about:blank' && mayOpenWindow(contents, url)) {
      // An empty window the page means to send somewhere: no tab until it
      // does (popup-preload.cjs gives the page its location).
      windowOpened(contents, null, popup);
    }
    return { action: 'deny' };
  });

  // Devtools hosts: pressing the toggle shortcut while focus is inside the
  // devtools pane closes it (routed to its inspected tab). Alt+Tab still
  // switches desktop windows, and Print Screen still starts a capture. No
  // Chrome context menu either - the devtools frontend manages its own menus.
  if (contents.session === devtoolsSession()) {
    contents.on('before-input-event', (event, input) => {
      if (isDevtoolsToggleInput(input)) {
        const targetId = devtoolsBridge.targetIdForHost(contents.id);
        if (targetId === undefined) return;
        claimGuestKey(contents, event, input);
        sendToShell('devtools:toggleRequested', { wcId: targetId });
        return;
      }
      const shortcut = shellShortcutForInput(input);
      if (
        shortcut?.action === 'cycle-windows' ||
        shortcut?.action === 'apps-menu' ||
        shortcut?.action === 'assistant' ||
        shortcut?.action === 'dictation' ||
        shortcut?.action === 'system-monitor' ||
        shortcut?.action === 'security-options' ||
        shortcut?.action === 'focus-area' ||
        shortcut?.action === 'screenshot' ||
        shortcut?.action === 'screenshot-area' ||
        shortcut?.action === 'wm'
      ) {
        claimGuestKey(contents, event, input);
        sendToShell('shortcut', shortcut);
      }
    });
    return;
  }

  // Shell-level shortcuts inside a page: F12 / Ctrl+Shift+I toggles the
  // tab's docked devtools; Ctrl+T / Ctrl+W manage browser tabs; Alt+Tab
  // switches desktop windows. Keyboard focus lives in the guest then, so
  // the shell can't see the keys itself - forward them. Private and Tor tabs
  // too: left to Chromium, the devtools toggle opens DevTools in a window of
  // its own, which din-shell can't show next to Din.
  if (isAnyBrowserTab) {
    contents.on('before-input-event', (event, input) => {
      if (isDevtoolsToggleInput(input)) {
        claimGuestKey(contents, event, input);
        sendToShell('devtools:toggleRequested', { wcId: contents.id });
        return;
      }
      if (isPrintInput(input)) {
        claimGuestKey(contents, event, input);
        requestPagePrint(contents);
        return;
      }
      const shortcut = shellShortcutForInput(input);
      if (!shortcut) return;
      claimGuestKey(contents, event, input);
      sendToShell('shortcut', { ...shortcut, wcId: contents.id });
    });

    // Stream find-in-page match results to the shell's find bar.
    contents.on('found-in-page', (_event, result) => {
      sendToShell('browser:findResult', {
        wcId: contents.id,
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate,
      });
    });
  }

  // Installed apps' windows aren't browser tabs, but focus still lands inside
  // them, so the shell's window-cycling, apps-menu, assistant, System Monitor
  // and screenshot shortcuts must be forwarded too.
  if (isAppWindow) {
    contents.on('before-input-event', (event, input) => {
      if (isPrintInput(input)) {
        claimGuestKey(contents, event, input);
        requestPagePrint(contents);
        return;
      }
      const shortcut = shellShortcutForInput(input);
      if (
        shortcut?.action === 'cycle-windows' ||
        shortcut?.action === 'apps-menu' ||
        shortcut?.action === 'assistant' ||
        shortcut?.action === 'dictation' ||
        shortcut?.action === 'system-monitor' ||
        shortcut?.action === 'security-options' ||
        shortcut?.action === 'focus-area' ||
        shortcut?.action === 'screenshot' ||
        shortcut?.action === 'screenshot-area' ||
        shortcut?.action === 'wm'
      ) {
        claimGuestKey(contents, event, input);
        sendToShell('shortcut', shortcut);
      }
    });
  }

  // Chrome-style right-click menu: navigation, clipboard, link/image
  // actions, plus any items extensions registered via chrome.contextMenus
  // (e.g. uBlock Origin's "Block element...").
  contents.on('context-menu', (_e, params) => {
    let menu = buildChromeContextMenu({
      params,
      webContents: contents,
      extensionMenuItems:
        chromeExtensions && isBrowserTab
          ? chromeExtensions.getContextMenuItems(contents, params)
          : [],
      openLink: (url, disposition) => {
        if (/^(https|chrome-extension):\/\//i.test(url)) {
          // "Open link/image in new tab" (disposition 'default') opens in the
          // background like Chrome; "Open in new window" stays foreground.
          sendToShell('crx:openTab', {
            url,
            openerWcId: contents.id,
            background: disposition === 'default' || disposition === 'background-tab',
          });
        }
      },
    });
    // buildChromeContextMenu only offers "Open image in new tab" and "Copy
    // image address" for images - no way to save the file itself. Insert
    // Chrome's "Save Image" / "Copy Image" after "Open image in new tab".
    // Saving reuses downloadURL(), which the will-download handler routes
    // straight to ~/Downloads.
    if (params.mediaType === 'image' && params.srcURL) {
      menu.insert(
        1,
        new MenuItem({
          label: 'Save Image',
          click: () => contents.downloadURL(params.srcURL),
        }),
      );
      menu.insert(
        2,
        new MenuItem({
          label: 'Copy Image',
          click: () => contents.copyImageAt(params.x, params.y),
        }),
      );
      // https only: the URL may go into the user's profile theme as is.
      if (/^https:\/\//i.test(params.srcURL)) {
        menu.insert(
          3,
          new MenuItem({
            label: 'Set Image as Desktop Background',
            click: () => sendToShell('theme:setBackground', { url: params.srcURL }),
          }),
        );
      }
    }
    // Chrome's "Search Google for “…”" on selected text, after "Copy". The
    // search opens in a new foreground tab with the same engine the address
    // bar uses.
    const selection = params.selectionText.trim().replace(/\s+/g, ' ');
    const copyIndex = menu.items.findIndex((item) => item.label === 'Copy');
    if (selection && copyIndex !== -1) {
      const shown = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection;
      menu.insert(
        copyIndex + 1,
        new MenuItem({
          // A lone "&" would be taken as a mnemonic marker.
          label: `Search DuckDuckGo for “${shown.replace(/&/g, '&&')}”`,
          click: () => {
            sendToShell('crx:openTab', {
              url: `https://duckduckgo.com/?q=${encodeURIComponent(selection)}`,
              openerWcId: contents.id,
              background: false,
            });
          },
        }),
      );
    }
    // buildChromeContextMenu always appends an "Inspect" item last, wired
    // straight to inspectElement() - which opens devtools in a detached
    // native window (unusable in the single-window kiosk shell). Rebuild the
    // menu with that item swapped for one that routes to the shell's docked
    // devtools pane.
    if (isAnyBrowserTab) {
      const replaced = new Menu();
      for (const item of menu.items.slice(0, -1)) replaced.append(item);
      replaced.append(
        new MenuItem({
          label: 'Inspect',
          click: () => {
            sendToShell('devtools:inspectRequested', {
              wcId: contents.id,
              x: params.x,
              y: params.y,
            });
          },
        }),
      );
      menu = replaced;
    }
    // Chrome's "Print…" on the page itself, just above "Inspect".
    if (params.mediaType === 'none' && !params.linkURL && !params.isEditable && !selection) {
      const at = Math.max(0, menu.items.length - 1);
      menu.insert(at, new MenuItem({ type: 'separator' }));
      menu.insert(at, new MenuItem({ label: 'Print…', click: () => requestPagePrint(contents) }));
    }
    // Pop the menu up on the next tick, not synchronously inside the
    // context-menu handler: the right-button press that fired this event is
    // still being processed (the guest grabs focus/pointer for it), and a
    // menu opened mid-press dismisses itself instantly - the "right-click
    // menu flashes and never opens" glitch. Deferring lets the press finish
    // so the popup survives to be used.
    setImmediate(() => {
      if (shellWindow && !shellWindow.isDestroyed()) {
        menu.popup({ window: shellWindow });
      }
    });
  });
});

app.on('window-all-closed', () => app.quit());
