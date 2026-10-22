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
// (Electron 41 embeds Node 24) - no build step, so only erasable TS syntax.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { app, BrowserWindow, ipcMain, protocol, net, session, webContents, screen, globalShortcut, Menu, MenuItem, nativeImage, nativeTheme, shell } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import {
  installChromeWebStore,
  uninstallExtension,
} from 'electron-chrome-web-store';
import { DevtoolsBridge } from './devtools-bridge.mts';
import {
  registerUserscriptHandlers,
  attachUserscripts,
  isUserscriptInstallUrl,
} from './userscripts.mts';
import {
  NSITE_SCHEME,
  registerNsiteProtocol,
  clearNsiteManifestCache,
  clearNsiteBlobCache,
} from './nsite.mts';
import { registerNativeAppHandlers, runWindowsProgram, terminalEnvironment } from './native-apps.mts';
import { isWindowsProgram } from './windows-apps.mts';
import { registerNativeDisplayHandlers } from './native-display.mts';
import { registerKeyboardHandlers } from './keyboard.mts';
import { registerTrayHandlers } from './tray.mts';
import { registerNotificationHandlers } from './notifications.mts';
import { registerInstallerHandlers } from './installer.mts';
import { registerBluetoothLoginHandlers } from './bluetooth-login.mts';
import { registerNostrdHandlers } from './nostrd.mts';
import { registerBootScreenHandlers } from './boot-screen.mts';
import { registerLockHandlers } from './lock.mts';
import { registerUpdaterHandlers } from './updater.mts';
import { airplayDisplays, registerAirPlayHandlers } from './airplay.mts';
import { CommandError, runCommand, watchCommand } from './system.mts';

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
//   - repo/standalone launcher (os/x11/din-session.sh): main.mts lives in
//     electron/, dist/ sits at the repo root (dirname/../dist)
// DIN_DIST_DIR overrides both. Without this, the standalone session loads
// app://din/ against a non-existent electron/dist and shows a black screen.
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
]);

// After a GPU reset, Chromium blocks WebGL for the pages it blames (or for
// every page, when it can't tell). Din is the whole desktop: losing WebGL
// leaves the Terminal on its DOM renderer until Din restarts.
app.disableDomainBlockingFor3DAPIs();

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
// Filesystem bridge (window.fs - see preload.cjs / the Files app).
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
// and file reads are capped at MAX_READ_BYTES so a stray click on a huge
// file can't balloon the renderer.
// ---------------------------------------------------------------------------

const fsp = fs.promises;
const MAX_DIR_ENTRIES = 5000;
const MAX_READ_BYTES = 16 * 1024 * 1024;

// webContents.id of the shell window; set once the window is created. Used to
// reject IPC from any other web contents (e.g. <webview> guests).
let shellContentsId = -1;

/** Whether a request comes from the shell window's main frame, on the shell origin. */
function isShellSender(event: IpcEvent): boolean {
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
      MAX_READ_BYTES,
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
// PTY bridge (window.pty - see preload.cjs / the Terminal app).
//
// Gives the shell a real interactive terminal. Instead of node-pty (a native
// module we'd have to rebuild against Electron's ABI inside the Nix build),
// each session spawns pty-host.py: a stdlib-only Python helper that owns the
// pseudo-terminal and proxies bytes over pipes (stdin/stdout for terminal
// I/O, fd 3 for resize commands, fd 4 for "a command finished" events).
//
// Threat model: this is deliberately an arbitrary-command-execution API for
// the shell's origin, so it adds nothing beyond what the fs bridge already
// concedes (window.fs can write ~/.bashrc, which is code execution on the
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
  ipcMain.handle('pty:spawn', async (event, size, cwd) => {
    assertShellSender(event);
    if (ptySessions.size >= MAX_PTY_SESSIONS) {
      throw new Error(`Too many terminal sessions (max ${MAX_PTY_SESSIONS})`);
    }
    const rows = clampDimension(size?.rows, 24);
    const cols = clampDimension(size?.cols, 80);

    const spawnCwd =
      typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096 ? cwd : os.homedir();
    const env = await terminalEnvironment();

    const proc = spawn('python3', [PTY_HELPER, userShell(), String(rows), String(cols)], {
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
      if (!sender.isDestroyed()) sender.send(channel, ...args);
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
// WiFi bridge (window.wifi - see preload.cjs / the Settings app).
//
// Thin wrapper around `nmcli` (NetworkManager). The shell's OS user is in the
// `networkmanager` group, so nmcli works without polkit prompts; in a plain
// browser or on a machine without NetworkManager the bridge reports
// `available: false` and the Settings app renders a fallback.
//
// Threat model: same boundaries as the other bridges (strict CSP, the sender
// guard, arguments re-validated here). All nmcli invocations use execFile
// with an argv array - no shell, so SSIDs/passwords can't inject commands.
// Passwords do transit argv (briefly visible in /proc/<pid>/cmdline to other
// processes of the same user); acceptable for this single-user demo.
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

const NMCLI_TIMEOUT_MS = 15_000;
const NMCLI_CONNECT_TIMEOUT_MS = 60_000;
const WIFI_TYPE = '802-11-wireless';

/** Run nmcli with an argv array; resolves stdout, rejects with a clean message. */
function nmcli(args: string[], timeout = NMCLI_TIMEOUT_MS): Promise<string> {
  return tool('nmcli', args, timeout, 4 * 1024 * 1024);
}

/**
 * Split one line of `nmcli -t` output into fields. Terse mode separates
 * fields with ':' and escapes literal ':' and '\' in values with a backslash.
 */
function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Non-empty lines of nmcli terse output, split into fields. */
function terseRows(stdout: string): string[][] {
  return stdout.split('\n').filter((line) => line.length > 0).map(splitTerse);
}

/** Validate a caller-supplied SSID. */
function validSsid(ssid: unknown): string {
  if (
    typeof ssid !== 'string' ||
    ssid.length === 0 ||
    ssid.length > 64 ||
    ssid.includes('\0')
  ) {
    throw new Error('Invalid SSID');
  }
  return ssid;
}

/** Validate an optional caller-supplied WiFi password. */
function validPassword(password: unknown): string | undefined {
  if (password === undefined || password === null || password === '') return undefined;
  if (typeof password !== 'string' || password.length > 256 || password.includes('\0')) {
    throw new Error('Invalid password');
  }
  return password;
}

/** One NetworkManager device row. */
interface NmDevice {
  iface: string;
  state: string;
  connection: string | null;
}

/** The first WiFi device known to NetworkManager, or null. */
async function wifiDevice(): Promise<NmDevice | null> {
  const rows = terseRows(
    await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
  );
  const row = rows.find((fields) => fields[1] === 'wifi');
  if (!row) return null;
  return { iface: row[0], state: row[2], connection: row[3] || null };
}

/** The first wired (ethernet) device known to NetworkManager, or null. */
async function ethernetDevice(): Promise<NmDevice | null> {
  const rows = terseRows(
    await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
  );
  const row = rows.find((fields) => fields[1] === 'ethernet');
  if (!row) return null;
  return { iface: row[0], state: row[2], connection: row[3] || null };
}

/** Names of saved WiFi connection profiles. */
async function savedWifiConnections(): Promise<string[]> {
  const rows = terseRows(await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']));
  return rows.filter((fields) => fields[1] === WIFI_TYPE).map((fields) => fields[0]);
}

/** Connection types NetworkManager exposes as a VPN in the network menu. */
const VPN_TYPES = new Set(['vpn', 'wireguard']);

/**
 * Validate a caller-supplied NetworkManager connection name. Names transit
 * argv (no shell), so the concern is only well-formedness, not injection.
 */
function validConnName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 128 ||
    name.includes('\0')
  ) {
    throw new Error('Invalid connection name');
  }
  return name;
}

/** One saved VPN profile and whether its tunnel is currently up. */
interface VpnConnection {
  name: string;
  /** "vpn" (OpenVPN, IKEv2, ...) or "wireguard". */
  type: string;
  active: boolean;
}

/** Saved VPN/WireGuard connection profiles with their active state. */
async function savedVpnConnections(): Promise<VpnConnection[]> {
  const rows = terseRows(
    await nmcli(['-t', '-f', 'NAME,TYPE,ACTIVE', 'connection', 'show']),
  );
  return rows
    .filter((fields) => VPN_TYPES.has(fields[1]))
    .map((fields) => ({ name: fields[0], type: fields[1], active: fields[2] === 'yes' }));
}

// ---------------------------------------------------------------------------
// Display bridge (window.display): the arrangement of the outputs Din's one
// window spans - resolution, position, on/off and which output is primary -
// applied as a whole desired layout at once. Two backends:
//   - wlr-randr on Wayland (cage on DinOS), through the compositor's
//     wlr-output-management protocol. "Primary" isn't a Wayland notion: it's
//     Din's own (the monitor with the menu bar and Dock), so it's saved with
//     the arrangement, and the arrangement is reapplied whenever the same set
//     of outputs is connected again - cage itself forgets, laying outputs out
//     left to right at their preferred modes.
//   - xrandr on a bare X11 session (the os/x11 standalone launcher), where
//     Din is the whole desktop and nothing else manages the outputs.
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
  current: boolean;
  preferred: boolean;
}

/** One connected output, as either tool reports it. */
interface DisplayOutput {
  name: string;
  connected: boolean;
  primary: boolean;
  enabled: boolean;
  current: { width: number; height: number } | null;
  position: { x: number; y: number };
  modes: DisplayMode[];
  /** The AirPlay receiver this display is, for the ones deckmon adds. */
  airplay?: string;
}

/** A desired on-state for one output in a layout call. */
interface OutputPlacement {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  primary: boolean;
}

/**
 * Parse `xrandr --query` into a list of outputs. Each output header looks like
 *   eDP connected primary 1920x1200+0+0 (normal ...) 302mm x 188mm
 * followed by indented mode lines
 *   1920x1200     60.00*+     ('*' = current mode, '+' = preferred/native)
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
      current = {
        name: head[1],
        connected: head[2] === 'connected',
        primary: Boolean(head[3]),
        enabled: on,
        current: on ? { width: Number(head[4]), height: Number(head[5]) } : null,
        position: on ? { x: Number(head[6]), y: Number(head[7]) } : { x: 0, y: 0 },
        modes: [],
      };
      outputs.push(current);
      continue;
    }
    const mode = line.match(/^\s+(\d+)x(\d+)\s+(.*)$/);
    if (mode && current) {
      current.modes.push({
        width: Number(mode[1]),
        height: Number(mode[2]),
        current: mode[3].includes('*'),
        preferred: mode[3].includes('+'),
      });
    }
  }
  return outputs;
}

/** `wlr-randr --json`: one entry per head the compositor knows (all connected). */
interface WlrHead {
  name?: unknown;
  enabled?: unknown;
  position?: { x?: unknown; y?: unknown };
  modes?: { width?: unknown; height?: unknown; current?: unknown; preferred?: unknown }[];
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
      current: m.current === true,
      preferred: m.preferred === true,
    }));
    const enabled = head.enabled === true;
    const now = enabled ? modes.find((m) => m.current) : undefined;
    return [{
      name: head.name,
      connected: true,
      primary: false,
      enabled,
      current: now ? { width: now.width, height: now.height } : null,
      position: enabled
        ? { x: Number(head.position?.x) || 0, y: Number(head.position?.y) || 0 }
        : { x: 0, y: 0 },
      modes,
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
  // Under cage, Electron calls the newest output primary. Without a panel,
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
      if (e.primary) args.push('--primary');
    }
    for (const name of disabled) args.push('--output', name, '--off');
  } else {
    const byName = new Map(outputs.map((o) => [o.name, o]));
    for (const e of enabled) {
      args.push('--output', e.name, '--on');
      // Re-setting the current size could drop it to another refresh rate.
      const now = byName.get(e.name)?.current;
      if (!now || now.width !== e.width || now.height !== e.height) {
        args.push('--mode', `${e.width}x${e.height}`);
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
    enabled.push({
      name: output.name,
      width,
      height,
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
// Page fullscreen bridge (window.pageFullscreen). A page in a <webview> that
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

function registerPageFullscreenHandlers(): void {
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
// Monitors bridge (window.monitors): where each display sits inside the shell
// window, for the desktop's layout (src/lib/monitors.ts). The production
// window spans every display - cage stretches it over all outputs, and on bare
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
// Power bridge (window.power), backed by /sys/class/power_supply. Read-only
// sysfs, so it needs no external binary and works on any Linux session (cage
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

function registerPowerHandlers(): void {
  ipcMain.handle('power:status', async (event) => {
    assertShellSender(event);
    let names: string[];
    try {
      names = await fsp.readdir(POWER_SUPPLY_DIR);
    } catch {
      return { available: false, acConnected: false, batteries: [] };
    }

    const batteries = [];
    let acConnected = false;
    for (const name of names.sort()) {
      const dir = path.join(POWER_SUPPLY_DIR, name);
      const type = await readPowerAttr(dir, 'type');
      if (type === 'Battery') {
        if ((await readPowerAttr(dir, 'present')) === '0') continue;
        batteries.push(await readBattery(dir, name));
      } else if (type === 'Mains' || type === 'USB') {
        // Mains = AC adapter; a USB-C port online means USB-PD is supplying power.
        if ((await readPowerAttr(dir, 'online')) === '1') acConnected = true;
      }
    }

    return { available: batteries.length > 0, acConnected, batteries };
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

  // Log out: quit cleanly. din-session.sh treats exit 0 as "the user quit"
  // and ends the login session, returning to the display manager; on DinOS
  // the cage service brings a fresh Din back up.
  ipcMain.on('shell:endSession', (event) => {
    if (!isShellSender(event)) return;
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// Audio bridge (window.audio), backed by wpctl (WirePlumber/PipeWire). Drives
// the default sink's volume and mute for the menu-bar control, the media-key
// OSD, and - for the Settings sound panel - output/input device enumeration
// and selection, per-application (stream) volume, and a test tone played to a
// chosen sink via pw-play. Where wpctl is absent (no PipeWire) it reports
// available:false and the UI falls back. Same trust boundary as the other
// bridges: sender guard, argv execFile, ids and volumes re-validated here.
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
  const next = stepWithDetent(status.volume, deltaPct, { min: 0, max: 100, overMax: MAX_VOLUME }, volumeKnock);
  if (next === status.volume) return status;
  return audioSetVolume(next);
}

async function audioToggleMute(): Promise<AudioState> {
  await wpctl(['set-mute', DEFAULT_SINK, 'toggle']);
  return audioStatus();
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
}

/** A per-application playback stream from `wpctl status`. */
interface AudioStream {
  id: number;
  name: string;
  volume: number;
  muted: boolean;
}

interface AudioDevices {
  available: boolean;
  sinks: AudioDevice[];
  sources: AudioDevice[];
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

/** All sinks and sources, or available:false when wpctl is absent. */
async function audioDevices(): Promise<AudioDevices> {
  try {
    const { sinks, sources } = parseAudioStatus(await wpctl(['status']));
    return { available: true, sinks, sources };
  } catch (error) {
    if (messageOf(error) === 'wpctl-missing') {
      return { available: false, sinks: [], sources: [] };
    }
    throw error;
  }
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
      }, SYSTEM_EVENT_DEBOUNCE_MS),
    );
  };
  watchCommand('network', 'nmcli', ['monitor'], () => changed('network'));
  watchCommand('audio', 'pactl', ['subscribe'], (line) => {
    if (AUDIO_EVENT.test(line)) changed('audio');
  });
}

/** Adjust the default sink and push the new state to the shell for the OSD. */
function pushAudioOsd(statusPromise: Promise<AudioState>): void {
  statusPromise.then((s) => sendToShell('audio:osd', s)).catch(() => {});
}

/**
 * Global volume keys (VolumeUp/Down/Mute) under X11. Wayland has no global
 * key grabs (cage offers no GlobalShortcuts portal), so there these calls
 * would silently fail; the keys reach Din as ordinary input instead and
 * attachMediaKeys handles them. Harmless when wpctl is absent (the adjust
 * rejects and no OSD is shown).
 */
function registerMediaKeys(): void {
  if (process.env.WAYLAND_DISPLAY) return;
  globalShortcut.register('VolumeUp', () => pushAudioOsd(audioAdjust(5)));
  globalShortcut.register('VolumeDown', () => pushAudioOsd(audioAdjust(-5)));
  globalShortcut.register('VolumeMute', () => pushAudioOsd(audioToggleMute()));
}

// ---------------------------------------------------------------------------
// Brightness bridge (window.brightness). Two independent halves:
//   - Screen backlight (/sys/class/backlight), via brightnessctl where
//     installed (DinOS ships it with udev rules that grant the `video`
//     group write access; see os/configuration.nix). Where it's absent (e.g.
//     a dev host), fall back to reading sysfs directly (world-readable) and
//     writing through systemd-logind's Session.SetBrightness D-Bus call,
//     which any active session may use without extra privileges.
//   - Night light / red shift: a warm color temperature held by a Wayland/X11
//     gamma tool (gammastep preferred, wlsunset as a fallback) kept running in
//     the main process. Under Wayland the gamma ramp is torn down when the
//     client disconnects, so the tool must stay alive for the tint to persist;
//     we run it in continuous mode with equal day/night temps.
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
const NIGHT_LIGHT_TOOLS = ['gammastep', 'wlsunset'];
const MIN_TEMPERATURE = 2500;
const MAX_TEMPERATURE = 6500;
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

/** Clamp a caller-supplied color temperature to an integer in the useful range. */
function clampTemperature(kelvin: unknown): number {
  const n = Number(kelvin);
  if (!Number.isFinite(n)) throw new Error('Invalid temperature');
  return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, Math.round(n)));
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

// --- Night light (red shift) state, held in the main process. ---
let nightLightTool: string | null = null; // resolved tool name, or null when none is present
let nightLightProbed = false; // whether we've looked for a tool yet
let nightLightProc: ChildProcess | null = null; // the running gamma child, or null when off
let nightLightEnabled = false;
let nightLightTemp = 4500;

/** Resolve whether a gamma tool exists (ENOENT = missing); cached after first probe. */
async function probeTool(name: string): Promise<boolean> {
  try {
    await tool(name, ['-V'], 3_000);
    return true;
  } catch (error) {
    // Any error other than a missing binary (e.g. an unknown flag) still
    // means the tool is present and runnable.
    return messageOf(error) !== `${name}-missing`;
  }
}

/** Find and cache the first available gamma tool (gammastep, then wlsunset). */
async function ensureNightLightTool(): Promise<string | null> {
  if (nightLightProbed) return nightLightTool;
  nightLightProbed = true;
  for (const tool of NIGHT_LIGHT_TOOLS) {
    if (await probeTool(tool)) {
      nightLightTool = tool;
      break;
    }
  }
  return nightLightTool;
}

/** Argv that holds a fixed color temperature continuously (so the ramp persists). */
function nightLightArgs(tool: string, temp: number): string[] {
  if (tool === 'wlsunset') {
    // wlsunset needs night < day and a schedule; pin the schedule so it stays
    // at the night temperature essentially all day.
    return ['-t', String(temp), '-T', String(temp + 500), '-S', '23:59', '-s', '00:00'];
  }
  // gammastep: manual location, equal day/night temps, no fade transition.
  return ['-l', '0:0', '-t', `${temp}:${temp}`, '-r'];
}

/** Stop the running gamma child, if any. */
function stopNightLight(): void {
  if (nightLightProc) {
    try {
      nightLightProc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    nightLightProc = null;
  }
  nightLightEnabled = false;
}

/** (Re)start the gamma child at the current temperature. Throws if no tool exists. */
async function startNightLight(): Promise<void> {
  const tool = await ensureNightLightTool();
  if (!tool) throw new Error('night-light-missing');
  stopNightLight();
  const proc = spawn(tool, nightLightArgs(tool, nightLightTemp), { stdio: 'ignore' });
  proc.on('error', () => {}); // spawn race (e.g. tool vanished); status stays sane
  proc.on('exit', () => {
    if (nightLightProc === proc) {
      nightLightProc = null;
      nightLightEnabled = false;
    }
  });
  nightLightProc = proc;
  nightLightEnabled = true;
}

/** The night-light half of the brightness state. */
interface NightLightState {
  available: boolean;
  enabled: boolean;
  temperature: number;
}

function nightLightStatus(): NightLightState {
  return {
    available: nightLightTool !== null,
    enabled: nightLightEnabled,
    temperature: nightLightTemp,
  };
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

async function brightnessSetNightLight(enabled: boolean): Promise<BrightnessState> {
  if (enabled) await startNightLight();
  else stopNightLight();
  return brightnessStatus();
}

async function brightnessSetTemperature(kelvin: unknown): Promise<BrightnessState> {
  nightLightTemp = clampTemperature(kelvin);
  if (nightLightEnabled) await startNightLight(); // respawn with the new temp
  return brightnessStatus();
}

/**
 * Brightness and volume media keys. Electron's accelerator grammar has no
 * brightness key names, and on Wayland globalShortcut can't grab anything,
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
    return brightnessSetNightLight(enabled === true);
  });
  ipcMain.handle('brightness:setTemperature', async (event, kelvin) => {
    assertShellSender(event);
    return brightnessSetTemperature(kelvin);
  });
}

// ---------------------------------------------------------------------------
// Screenshot bridge (window.screenshot), backed by the screenshot:* handler
// below. Captures the shell window's rendered contents - the whole Din desktop
// (wallpaper, open windows, menu bar, dock) - as a PNG via Electron's
// compositor (webContents.capturePage). No display-server capture API, so it
// works on any session (cage/Wayland or bare X11) with no external tool.
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
  // Window.tsx). The rect is in CSS pixels relative to the shell content's
  // top-left; capturePage returns it at device resolution.
  ipcMain.handle('screenshot:captureRegion', async (event, rect) => {
    assertShellSender(event);
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Shell window unavailable');
    }
    const [contentW, contentH] = shellWindow.getContentSize();
    const clamp = (value: unknown, lo: number, hi: number): number => {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) throw new Error('Invalid capture region');
      return Math.max(lo, Math.min(hi, n));
    };
    const x = clamp(rect?.x, 0, contentW);
    const y = clamp(rect?.y, 0, contentH);
    const width = clamp(rect?.width, 1, contentW - x);
    const height = clamp(rect?.height, 1, contentH - y);
    const image = undimCapture(await shellWindow.webContents.capturePage({ x, y, width, height }));
    const size = image.getSize();
    if (size.width === 0 || size.height === 0) {
      throw new Error('Captured an empty image');
    }
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
  });
}

// ---------------------------------------------------------------------------
// The laptop "box select" screenshot key. Newer laptop keyboards carry a
// dedicated area-screenshot key (dashed-box icon) next to Print Screen; the
// kernel delivers it as evdev KEY_SELECTIVE_SCREENSHOT, which XKB turns into
// the XF86SelectiveScreenshot keysym. Chromium has no DOM mapping for that
// keysym, so before-input-event can only report it as "Unidentified" -
// indistinguishable from any other unmapped key. GNOME/KDE handle the key at
// the evdev level; do the same: read the keyboard event nodes directly and
// forward presses to the shell as the 'screenshot-area' shortcut.
//
// Reading /dev/input needs the `input` group (DinOS grants it to the
// desktop user); anywhere else the watcher just stays off. The main process
// already observes every keystroke via before-input-event, and nothing here
// is exposed to renderers, so no new capability crosses a trust boundary.
// ---------------------------------------------------------------------------

const EV_KEY = 0x01;
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

function watchSelectiveScreenshotKey(): void {
  if (process.platform !== 'linux') return;
  const watched = new Map<string, ChildProcess>();
  const scan = () => {
    for (const node of keyboardEventNodes()) {
      if (watched.has(node)) continue;
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
          if (
            buf.readUInt16LE(off + 16) === EV_KEY &&
            buf.readUInt16LE(off + 18) === KEY_SELECTIVE_SCREENSHOT &&
            buf.readInt32LE(off + 20) === 1
          ) {
            sendToShell('shortcut', { action: 'screenshot-area' });
          }
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

/** One WiFi network as listed by wifi:networks. */
interface WifiNetwork {
  ssid: string;
  inUse: boolean;
  signal: number;
  security: string;
  freqMhz: number;
}

function registerWifiHandlers(): void {
  ipcMain.handle('wifi:status', async (event) => {
    assertShellSender(event);
    try {
      const [device, ethernet, radio] = await Promise.all([
        wifiDevice(),
        ethernetDevice(),
        nmcli(['-t', 'radio', 'wifi']),
      ]);
      return { available: true, radioEnabled: radio.trim() === 'enabled', device, ethernet };
    } catch (error) {
      if (messageOf(error) === 'nmcli-missing') {
        return { available: false, radioEnabled: false, device: null, ethernet: null };
      }
      throw error;
    }
  });

  ipcMain.handle('wifi:networks', async (event, rescan) => {
    assertShellSender(event);
    const rows = terseRows(
      await nmcli(
        [
          '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY,FREQ',
          'device', 'wifi', 'list',
          '--rescan', rescan === true ? 'yes' : 'auto',
        ],
        30_000,
      ),
    );

    // One entry per SSID (strongest signal wins; hidden networks skipped).
    const bySsid = new Map<string, WifiNetwork>();
    for (const [inUse, ssid, signal, security, freq] of rows) {
      if (!ssid) continue;
      const network: WifiNetwork = {
        ssid,
        inUse: inUse === '*',
        signal: Number.parseInt(signal, 10) || 0,
        // e.g. "WPA2", "WPA1 WPA2", "" for open networks.
        security: security.trim(),
        freqMhz: Number.parseInt(freq, 10) || 0,
      };
      const existing = bySsid.get(ssid);
      if (!existing || network.inUse || (!existing.inUse && network.signal > existing.signal)) {
        bySsid.set(ssid, network);
      }
    }

    return [...bySsid.values()].sort(
      (a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal,
    );
  });

  ipcMain.handle('wifi:saved', async (event) => {
    assertShellSender(event);
    return savedWifiConnections();
  });

  ipcMain.handle('wifi:connect', async (event, rawSsid, rawPassword) => {
    assertShellSender(event);
    const ssid = validSsid(rawSsid);
    const password = validPassword(rawPassword);
    const saved = (await savedWifiConnections()).includes(ssid);

    if (saved) {
      // Reusing the profile (instead of `device wifi connect`) avoids nmcli
      // piling up duplicate "SSID 1", "SSID 2" profiles.
      if (password !== undefined) {
        await nmcli(['connection', 'modify', 'id', ssid, 'wifi-sec.psk', password]);
      }
      await nmcli(['connection', 'up', 'id', ssid], NMCLI_CONNECT_TIMEOUT_MS);
      return;
    }

    const args = ['device', 'wifi', 'connect', ssid];
    if (password !== undefined) args.push('password', password);
    try {
      await nmcli(args, NMCLI_CONNECT_TIMEOUT_MS);
    } catch (error) {
      // A failed first attempt (wrong password) leaves a broken profile
      // behind that would shadow the next try; drop it.
      await nmcli(['connection', 'delete', 'id', ssid]).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('wifi:disconnect', async (event) => {
    assertShellSender(event);
    const device = await wifiDevice();
    if (!device) throw new Error('No WiFi device');
    await nmcli(['device', 'disconnect', device.iface]);
  });

  ipcMain.handle('wifi:forget', async (event, rawSsid) => {
    assertShellSender(event);
    const ssid = validSsid(rawSsid);
    if (!(await savedWifiConnections()).includes(ssid)) {
      throw new Error(`No saved network named "${ssid}"`);
    }
    await nmcli(['connection', 'delete', 'id', ssid]);
  });

  ipcMain.handle('wifi:setRadio', async (event, enabled) => {
    assertShellSender(event);
    await nmcli(['radio', 'wifi', enabled === true ? 'on' : 'off']);
  });
}

// ---------------------------------------------------------------------------
// VPN bridge (window.vpn - see preload.cjs / the network selector).
//
// Same nmcli/NetworkManager substrate as the WiFi bridge, scoped to VPN and
// WireGuard connection profiles. The menu can only toggle profiles that
// already exist (imported via `nmcli connection import` / a .ovpn/.conf, or
// the Terminal); it deliberately doesn't create or edit them, which would
// mean handling credentials and per-provider config. `vpn:list` reports [] on
// a machine without NetworkManager so the UI simply shows no VPN section.
// ---------------------------------------------------------------------------

function registerVpnHandlers(): void {
  ipcMain.handle('vpn:list', async (event) => {
    assertShellSender(event);
    try {
      return await savedVpnConnections();
    } catch (error) {
      if (messageOf(error) === 'nmcli-missing') return [];
      throw error;
    }
  });

  ipcMain.handle('vpn:connect', async (event, rawName) => {
    assertShellSender(event);
    const name = validConnName(rawName);
    await nmcli(['connection', 'up', 'id', name], NMCLI_CONNECT_TIMEOUT_MS);
  });

  ipcMain.handle('vpn:disconnect', async (event, rawName) => {
    assertShellSender(event);
    const name = validConnName(rawName);
    await nmcli(['connection', 'down', 'id', name]);
  });
}

// ---------------------------------------------------------------------------
// Chrome extension support (the web browser app).
//
// electron-chrome-extensions implements the chrome.* extension APIs that
// Electron itself lacks (tabs, actions, popups, ...), and
// electron-chrome-web-store lets users install extensions by browsing the
// Chrome Web Store inside the browser app. Everything is scoped to the
// browser's session partition (persist:webbrowser):
//   - extensions run against browsed sites only; they can never see the
//     shell's origin (where app data lives) or its privileged bridges
//   - the shell's own session (defaultSession) never loads extensions
//
// Tab model: the shell renders browser tabs as <webview> elements, so each
// tab is a guest WebContents owned by the shell window. Guests are registered
// with the extension system as they're created (web-contents-created below).
// Extension-initiated tab operations (chrome.tabs.create/update/remove and
// window.open) are bridged to the shell renderer over IPC (window.crx in
// preload.cjs), which creates/activates/closes the corresponding tab UI.
//
// IMPORTANT: never attach session.webRequest listeners to the browser
// session; doing so silently disables chrome.webRequest for extensions
// (which content blockers like uBlock Origin depend on).
// ---------------------------------------------------------------------------

const WEBBROWSER_PARTITION = 'persist:webbrowser';

// Installed web apps (WebAppFrame) render in their own session, separate from
// both the shell and the ad-hoc Web Browser's tabs. This partition is the
// trust boundary for the Nostr identity bridge: only guests in this session
// get the NIP-07 preload (see registerNostrBridge / will-attach-webview). Must
// match APP_WEBVIEW_PARTITION in src/components/desktop/apps/BrowserView.tsx.
const WEBAPP_PARTITION = 'persist:din-apps';

// Private ("incognito") browser windows run their tabs in this partition.
// Deliberately NOT prefixed with `persist:`, so Electron keeps it in memory
// only - cookies/storage/cache are discarded once the last private tab closes.
// Guests here are hardened like every other <webview> (see will-attach-webview)
// but get no extension system, NIP-07, highlight, or userscript wiring, which
// is bound to the persistent browser session. Must match
// WEBBROWSER_PRIVATE_PARTITION in src/components/desktop/apps/BrowserView.tsx.
const WEBBROWSER_PRIVATE_PARTITION = 'din-webbrowser-private';

/** Absolute path to the preload injected into installed web-app <webview>s. */
const WEBAPP_PRELOAD = path.join(import.meta.dirname, 'webview-preload.cjs');

/**
 * Absolute path to the preload injected into the ad-hoc Web Browser's tabs.
 * Adds the NIP-84 "Highlight" affordance (text selection -> kind 9802). Unlike
 * WEBAPP_PRELOAD it exposes no window.nostr / signer surface to the page - it
 * only relays an explicit highlight click to the shell (see din-highlight:*).
 */
const HIGHLIGHT_PRELOAD = path.join(import.meta.dirname, 'browser-highlight-preload.cjs');

/**
 * Absolute path to the session preload that puts web pages' notifications
 * in Din's notification center (see electron/notifications.mts). Every page
 * gets it - browser tabs, private ones, and installed web apps.
 */
const NOTIFICATION_PRELOAD = path.join(import.meta.dirname, 'notification-preload.cjs');

/** The BrowserWindow hosting the shell (set at startup). */
let shellWindow: BrowserWindow | null = null;

/** The extension system for the browser session (set at startup). */
let chromeExtensions: ElectronChromeExtensions | null = null;

/**
 * The `src` of the <webview> guest currently being attached. Electron emits
 * `will-attach-webview` immediately before it constructs the guest's
 * WebContents, so the `web-contents-created` hook can read the URL the guest
 * is about to load - `contents.getURL()` is still empty that early, and the
 * guest's initial URL is what decides whether it's a browser tab (see
 * isExtensionPageGuest).
 */
let attachingGuestSrc = '';

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

/** Whether a session is one of the two the browser runs tabs in. */
function isBrowserTabSession(s: Electron.Session): boolean {
  return s === browserSession() || s === privateBrowserSession();
}

/** Send an event to the shell renderer, if it's still alive. */
function sendToShell(channel: string, payload?: unknown): void {
  if (shellWindow && !shellWindow.webContents.isDestroyed()) {
    shellWindow.webContents.send(channel, payload);
  }
}

/** How often, at most, a guest's pointer moves are forwarded to the shell. */
const GUEST_MOVE_INTERVAL_MS = 16;

/**
 * Pointer input inside a <webview> guest goes to the guest's own document and
 * never reaches the shell's, so the shell can't react to it: popovers and
 * menus stay open over a click into the page, and the dock can't tell the
 * pointer moved over one. Forward what the shell reacts to - button presses
 * and moves (at most one per frame) - so GuestInputHost can replay it on the
 * guest's <webview> element. Coordinates are in the guest's view, in DIPs
 * (verified on Electron 41: the shell's interface zoom isn't applied).
 *
 * A guest's own `focus` event would be the obvious way to report focus too,
 * but it never fires for <webview> guests (also verified), so the shell
 * treats a press as focusing the page instead.
 */
function forwardGuestInput(contents: Electron.WebContents): void {
  const wcId = contents.id;
  let pendingMove: { x: number; y: number } | null = null;
  let moveTimer: NodeJS.Timeout | null = null;
  const flushMove = (): void => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    if (!pendingMove) return;
    sendToShell('guest:input', { wcId, type: 'move', ...pendingMove });
    pendingMove = null;
  };
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseMove') {
      pendingMove = { x: mouse.x, y: mouse.y };
      moveTimer ??= setTimeout(flushMove, GUEST_MOVE_INTERVAL_MS);
    } else if (mouse.type === 'mouseDown') {
      // Keep the order the guest saw: the move that led here comes first.
      flushMove();
      sendToShell('guest:input', { wcId, type: 'down', x: mouse.x, y: mouse.y, button: mouse.button ?? 'left' });
    }
  });
  contents.once('destroyed', () => {
    if (moveTimer) clearTimeout(moveTimer);
  });
}

/**
 * Resolve a renderer-supplied WebContents id to a browser-tab guest, or null.
 * Only <webview> guests inside the browser partition qualify; anything else
 * (the shell itself, popups, stale ids) is rejected.
 */
function browserTabFromId(wcId: unknown): Electron.WebContents | null {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (contents.session !== browserSession()) return null;
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
  if (!isBrowserTabSession(contents.session)) return null;
  return contents;
}

/** The session all installed web-app <webview>s run in. */
function appSession(): Electron.Session {
  return session.fromPartition(WEBAPP_PARTITION);
}

/**
 * Whether a WebContents is an installed web-app guest (the only guests the
 * Nostr identity bridge answers). Different origins inside this one session
 * stay storage-isolated by the same-origin policy, so a shared partition is
 * safe; what matters is that browser tabs and the shell are excluded.
 */
function isAppGuest(contents: Electron.WebContents | null | undefined): boolean {
  return (
    !!contents &&
    !contents.isDestroyed() &&
    contents.getType() === 'webview' &&
    contents.session === appSession()
  );
}

/**
 * The origin each installed web-app guest was opened on, keyed by WebContents
 * id (recorded in web-contents-created from the guest's initial src). An app
 * guest is pinned to this origin: navigations away from it are handed to the
 * Web Browser, and only this origin may use the Nostr identity bridge.
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

// Nostr identity bridge (window.nostr in installed web apps - see
// webview-preload.cjs). The signer lives in the shell renderer (the nsec /
// extension / bunker the user logged in with), not here, so each NIP-07 call
// is relayed to the shell and its answer routed back to the requesting guest.
let nextNostrRequestId = 1;
const pendingNostrRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
const NOSTR_REQUEST_TIMEOUT_MS = 60_000;

function registerNostrBridge(): void {
  // A guest's window.nostr.* call: verify it's a trusted app guest, then relay
  // to the shell renderer and resolve with whatever it signs/returns.
  ipcMain.handle('nostr-bridge:call', (event, payload) => {
    // Only the installed app's own top-level document may sign: the guest is
    // bound to the origin it was installed for (appGuestOrigins), so a page it
    // navigates or is redirected to never inherits the user's identity.
    const origin = appGuestOrigins.get(event.sender.id);
    if (
      !isAppGuest(event.sender) ||
      !origin ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.origin !== origin
    ) {
      throw new Error('Nostr bridge is not available here');
    }
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Din shell is unavailable');
    }
    const method = payload && typeof payload.method === 'string' ? payload.method : '';
    return new Promise((resolve, reject) => {
      const requestId = nextNostrRequestId++;
      const timer = setTimeout(() => {
        pendingNostrRequests.delete(requestId);
        reject(new Error('Signing request timed out'));
      }, NOSTR_REQUEST_TIMEOUT_MS);
      pendingNostrRequests.set(requestId, { resolve, reject, timer });
      sendToShell('nostr-bridge:request', {
        requestId,
        method,
        params: payload ? payload.params : undefined,
        origin,
      });
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
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || 'Signing failed'));
  });
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
const HIGHLIGHT_REQUEST_TIMEOUT_MS = 60_000;

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
        reject(new Error('Publishing timed out'));
      }, HIGHLIGHT_REQUEST_TIMEOUT_MS);
      pendingHighlightRequests.set(requestId, { resolve, reject, timer });
      sendToShell('din-highlight:request', { requestId, url, text, context });
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
    const pending = typeof requestId === 'number' && pendingFilePicks.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFilePicks.delete(requestId as number);

    const { contents, backendNodeId } = pending;
    if (contents.isDestroyed()) return;

    // A non-empty path means the user chose a file; anything else is a cancel.
    // Either way the intercepted chooser must be answered so the input isn't
    // left hanging - an empty file list is the "cancelled" answer.
    const path = (response as { path?: unknown }).path;
    const files = typeof path === 'string' && path ? [path] : [];
    contents.debugger
      .sendCommand('DOM.setFileInputFiles', { files, backendNodeId })
      .catch(() => {
        // Node gone (page navigated) or DOM agent unavailable - nothing to do.
      });
  });
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
    const backendNodeId = (params as { backendNodeId?: unknown }).backendNodeId;
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
    sendToShell('filepicker:request', { requestId, origin });
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
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      // Site access comes from MV3 host_permissions, MV2 match patterns mixed
      // into permissions, and content-script matches; show all of them.
      const isPattern = (p: string) => p === '<all_urls>' || p.includes('://');
      const contentScripts = Array.isArray(raw.content_scripts) ? raw.content_scripts : [];
      const sites = new Set([
        ...strings(raw.host_permissions),
        ...strings(raw.permissions).filter(isPattern),
        ...contentScripts.flatMap((cs: unknown) =>
          cs && typeof cs === 'object' ? strings((cs as { matches?: unknown }).matches) : [],
        ),
      ]);
      const allow = await askShell({
        kind: 'extension-install',
        name: localizedName || (typeof raw.name === 'string' ? raw.name : 'This extension'),
        permissions: strings(raw.permissions).filter((p) => !isPattern(p)),
        hostPermissions: [...sites],
      });
      return { action: allow ? 'allow' : 'deny' };
    },
  }).catch((error) => {
    console.error('chrome-web-store setup failed:', error);
  });
  hardenWebStorePreload();

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
type SiteCapability = 'camera' | 'microphone' | 'geolocation' | 'notifications';

type ShellPrompt =
  | { kind: 'permission'; origin: string; capabilities: SiteCapability[] }
  | { kind: 'extension-install'; name: string; permissions: string[]; hostPermissions: string[] };

let nextPromptId = 1;
const pendingPrompts = new Map<number, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>();
const PROMPT_TIMEOUT_MS = 2 * 60_000;

/** Ask the user a yes/no question in the shell; resolves false on timeout. */
function askShell(prompt: ShellPrompt): Promise<boolean> {
  return new Promise((resolve) => {
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      resolve(false);
      return;
    }
    const requestId = nextPromptId++;
    const timer = setTimeout(() => {
      pendingPrompts.delete(requestId);
      sendToShell('prompt:cancel', { requestId });
      resolve(false);
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
    pending.resolve(response.allow === true);
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
//     per origin; the answer holds until Din restarts (private windows forget
//     with their session)
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

/** Per-session answers, keyed `origin\0capability`. */
const siteDecisions = new WeakMap<Electron.Session, Map<string, boolean>>();

function decisionsFor(s: Electron.Session): Map<string, boolean> {
  let decisions = siteDecisions.get(s);
  if (!decisions) {
    decisions = new Map();
    siteDecisions.set(s, decisions);
  }
  return decisions;
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
  const allowed = decisionsFor(s).get(`${origin}\u0000notifications`);
  return allowed === undefined ? 'default' : allowed ? 'granted' : 'denied';
}

function hardenGuestSession(s: Electron.Session, { prompts }: { prompts: boolean }): void {
  const decisions = decisionsFor(s);
  const key = (origin: string, capability: SiteCapability) => `${origin}\u0000${capability}`;
  // One prompt per (origin, capabilities) at a time; repeat requests share it.
  const asking = new Map<string, Promise<boolean>>();

  s.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (ALWAYS_ALLOWED_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    const capabilities = prompts ? requestedCapabilities(permission, details) : null;
    const origin = originOf(details.requestingUrl);
    if (!capabilities || !origin) {
      callback(false);
      return;
    }
    if (capabilities.some((c) => decisions.get(key(origin, c)) === false)) {
      callback(false);
      return;
    }
    const undecided = capabilities.filter((c) => !decisions.has(key(origin, c)));
    if (undecided.length === 0) {
      callback(true);
      return;
    }
    const askKey = `${origin}\u0000${undecided.join(',')}`;
    let answer = asking.get(askKey);
    if (!answer) {
      answer = askShell({ kind: 'permission', origin, capabilities: undecided }).then((allow) => {
        for (const c of undecided) decisions.set(key(origin, c), allow);
        asking.delete(askKey);
        return allow;
      });
      asking.set(askKey, answer);
    }
    answer.then(callback, () => callback(false));
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

// ---------------------------------------------------------------------------
// Extension action popups, rendered in-shell.
//
// electron-chrome-extensions opens chrome.action popups (e.g. Bitwarden's
// unlock bubble) as a separate native frameless BrowserWindow positioned
// next to the action button. That suits a windowing desktop, but Din is a
// single-window kiosk: a popup toplevel detaches from the shell (under a
// kiosk compositor like cage it can't be positioned at all) instead of
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
        pinned.has(certKey(request.hostname, fingerprint))
      ) {
        callback(0);
        return;
      }
      callback(-3);
    });
  };
  installVerifyProc(browserSession(), trustedCerts);
  installVerifyProc(privateBrowserSession(), privateTrustedCerts);

  // A cert Chromium rejected (unpinned self-signed / private-CA host) fires
  // this on a browser session. Reject the load and, for the top-level frame,
  // hand the details to the shell so it can offer "proceed anyway".
  app.on(
    'certificate-error',
    (event, contents, url, error, certificate, callback, isMainFrame) => {
      if (
        !contents ||
        contents.isDestroyed() ||
        !isBrowserTabSession(contents.session)
      ) {
        // Not a browser tab (shell, installed web app, ...): leave Chromium's
        // strict verification in place by not overriding it.
        return;
      }
      // Private tabs check the in-memory exception set; persistent tabs the
      // saved one.
      const pinned =
        contents.session === privateBrowserSession()
          ? privateTrustedCerts
          : trustedCerts;
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
      if (tab && tab.session === privateBrowserSession()) {
        // Private window: pin in memory only, so the exception is discarded
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

  // Open a completed download with the OS default handler, or reveal it in the
  // file manager. Both are restricted to files under ~/Downloads so the shell
  // can't be coaxed into opening an arbitrary path.
  ipcMain.handle('browser:openDownload', async (event, filePath) => {
    assertShellSender(event);
    if (!isDownloadsPath(filePath) || !fs.existsSync(filePath)) return;
    // A downloaded setup.exe runs, the way it would on Windows.
    if (isWindowsProgram(filePath)) return runWindowsProgram(filePath);
    await shell.openPath(filePath);
  });
  ipcMain.handle('browser:showDownload', (event, filePath) => {
    assertShellSender(event);
    if (!isDownloadsPath(filePath) || !fs.existsSync(filePath)) return;
    shell.showItemInFolder(filePath);
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
      // clearing that alone would leave a site's files on disk.
      clearNsiteManifestCache();
      await clearNsiteBlobCache();
    }
    if (opts.cookies === true) {
      // No `storages` filter: clear every storage type (cookies included).
      await s.clearStorageData();
    }
  });
}

// ---------------------------------------------------------------------------
// Color scheme. Chromium answers `prefers-color-scheme` from the host
// desktop's setting, which under cage doesn't exist, so every page saw light.
// Din is the desktop here: the shell reports its own light/dark mode and
// nativeTheme passes it on to every web contents, browser tabs included.
// ---------------------------------------------------------------------------
function registerThemeHandler(): void {
  ipcMain.on('theme:set', (event, source: unknown) => {
    if (!isShellSender(event)) return;
    if (source !== 'light' && source !== 'dark' && source !== 'system') return;
    nativeTheme.themeSource = source;
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
    tab.findInPage(text, {
      forward: opts.forward !== false,
      findNext: opts.findNext === true,
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

  // Installed-extension listing for the browser's extensions menu.
  ipcMain.handle('crx:listExtensions', (event) => {
    assertShellSender(event);
    return browserSession()
      .extensions.getAllExtensions()
      .map((extension) => ({
        id: extension.id,
        name: extension.manifest?.name ?? extension.name,
        version: extension.version,
        description: extension.manifest?.description ?? '',
      }));
  });

  ipcMain.handle('crx:uninstallExtension', async (event, extensionId) => {
    assertShellSender(event);
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
      throw new Error('Invalid extension id');
    }
    await uninstallExtension(extensionId, {
      session: browserSession(),
      extensionsPath: extensionsPath(),
    });
  });
}

// ---------------------------------------------------------------------------
// DevTools for the web browser app (window.devtools - see preload.cjs).
//
// Din runs fullscreen with a single native window (cage shows exactly one
// surface), so Electron's default detached-devtools window is unusable.
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
  WEBAPP_PARTITION,
  DEVTOOLS_PARTITION,
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

/** A shell-level shortcut forwarded from a guest (see window.shellShortcuts). */
type ShellShortcut =
  | { action: 'cycle-windows'; backward: boolean }
  | { action: 'apps-menu' | 'screenshot' | 'screenshot-area' }
  | { action: 'super-key'; down: boolean }
  | { action: 'new-tab' | 'close-tab' | 'focus-address' | 'find' | 'back' | 'forward' }
  | { action: 'reload'; force: boolean }
  | { action: 'cycle-tab'; backward: boolean }
  | { action: 'goto-tab'; digit: number };

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
  // watchSelectiveScreenshotKey).
  if (input.key === 'PrintScreen' && !input.alt && !input.control && !input.meta) {
    return { action: input.shift ? 'screenshot-area' : 'screenshot' };
  }
  if (input.meta && !input.alt && !input.control && !input.shift && input.key === ' ') {
    return { action: 'apps-menu' };
  }
  if (input.alt && !input.control && !input.meta && input.key === 'Tab') {
    return { action: 'cycle-windows', backward: Boolean(input.shift) };
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
  if (input.control && !input.alt && !input.meta && input.key === 'Tab') {
    return { action: 'cycle-tab', backward: Boolean(input.shift) };
  }
  if (input.control && input.shift && !input.alt && !input.meta) {
    if (input.key.toLowerCase() === 'r') return { action: 'reload', force: true };
    return null;
  }
  if (input.control && !input.shift && !input.alt && !input.meta) {
    const key = input.key.toLowerCase();
    if (key === 't') return { action: 'new-tab' };
    if (key === 'w') return { action: 'close-tab' };
    if (key === 'l') return { action: 'focus-address' };
    if (key === 'f') return { action: 'find' };
    if (key === 'r') return { action: 'reload', force: false };
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
    const target = browserTabFromId(targetWcId);
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

  // Reveal the element at page coordinates (context-menu "Inspect").
  ipcMain.handle('devtools:inspect', (event, targetWcId, x, y) => {
    assertShellSender(event);
    if (typeof targetWcId !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    devtoolsBridge.inspect(targetWcId, Math.round(x), Math.round(y));
  });

  // Apply or clear device/responsive emulation on a tab.
  ipcMain.handle('devtools:emulate', async (event, targetWcId, metrics) => {
    assertShellSender(event);
    const target = browserTabFromId(targetWcId);
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
  // Installed apps and devtools would otherwise fall back to the native dialog.
  appSession().on('will-download', downloadToHome);
  devtoolsSession().on('will-download', downloadToHome);
  registerBrowserDownloadHandlers();

  registerPromptBridge();
  hardenGuestSession(browserSession(), { prompts: true });
  hardenGuestSession(privateBrowserSession(), { prompts: true });
  hardenGuestSession(appSession(), { prompts: true });
  hardenGuestSession(devtoolsSession(), { prompts: false });
  // Web pages' notifications go to Din's notification center.
  for (const s of [browserSession(), privateBrowserSession(), appSession()]) {
    s.registerPreloadScript({ id: 'din-notifications', type: 'frame', filePath: NOTIFICATION_PRELOAD });
  }

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    return net.fetch(pathToFileURL(resolveFile(pathname)).toString());
  });

  registerFsHandlers();
  registerPtyHandlers();
  registerWifiHandlers();
  registerVpnHandlers();
  registerDisplayHandlers();
  registerPageFullscreenHandlers();
  registerMonitorsHandlers();
  registerPowerHandlers();
  registerAudioHandlers();
  registerMediaKeys();
  registerSystemEvents();
  registerBrightnessHandlers();
  registerScreenshotHandlers();
  watchSelectiveScreenshotKey();
  registerCrxHandlers();
  registerCertificateHandling();
  registerBrowserDataHandlers();
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
  registerTrayHandlers({ assertShellSender, sendToShell });
  registerNotificationHandlers({ isShellSender, sendToShell, webPermission: siteNotificationPermission });
  registerInstallerHandlers({ assertShellSender, sendToShell });
  registerBluetoothLoginHandlers({ assertShellSender, sendToShell });
  registerNostrdHandlers({ assertShellSender, sendToShell });
  registerBootScreenHandlers({ assertShellSender });
  registerLockHandlers({ assertShellSender });
  registerUpdaterHandlers({ assertShellSender, sendToShell });
  registerAirPlayHandlers({
    assertShellSender,
    sendToShell,
    primaryOutput: async () => (await queryOutputs()).find((o) => o.primary && o.enabled)?.name ?? null,
  });
  registerNativeDisplayHandlers({
    assertShellSender,
    shell: () => (shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents : null),
  });

  // nsite:// in both browser sessions. This process has no Nostr client, so
  // manifest lookups are relayed to the shell renderer (NsiteBridgeHost),
  // which owns Nostrify, the relay list, and the query cache.
  registerNsiteProtocol({
    sessions: [browserSession(), privateBrowserSession()],
    sendToShell,
    isShellSender,
  });

  // Must run before any <webview> is created so the extension system's
  // preload/APIs are in place when the first tab loads.
  setupChromeExtensions();

  // Route chrome.action popups into the shell instead of native windows.
  overrideActionPopup();

  // Production runs with no window manager (cage on DinOS, or a bare X11
  // login session via os/x11). cage force-fills the one app across every
  // output, but bare X11 has nothing to honor the EWMH fullscreen hint, so
  // the window would sit at its default size letterboxed on a black screen.
  // Size it to cover every display explicitly and drop the frame;
  // fullscreen/kiosk still apply where a compositor does honor them. The
  // desktop itself works out where each monitor is (window.monitors).
  const production = !DEV_URL;
  // Bare X11 fullscreens a window onto one display; across several, the
  // explicit bounds have to do.
  const spanX11 = DISPLAY_TOOL === 'xrandr' && screen.getAllDisplays().length > 1;
  const win = new BrowserWindow({
    // Dev: normal windowed shell. Production: fills the displays, frameless.
    fullscreen: production && !spanX11,
    kiosk: production && !spanX11,
    frame: !production,
    ...(production ? screenBounds() : { width: 1280, height: 800 }),
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    // Stay hidden until the renderer reports its first frame is ready (the
    // shell:bootReady gate below). With no window manager (cage on DinOS,
    // bare X11 otherwise), showing early presents an unpainted surface — a
    // white/pixelated glitch frame. The renderer then fades in from black.
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Expose the fs bridge (window.fs) to the shell.
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

  // The shell preload follows its window across navigations, so the shell must
  // never leave its own origin: a remote page loaded here would inherit
  // window.fs, window.pty and every other bridge. External-app handoffs
  // (nostrconnect: for remote signers) are the one exception - they never
  // replace the document. Web links go to the Web Browser instead.
  const keepShellHome = (event: Electron.Event, url: string) => {
    if (originOf(url) === SHELL_ORIGIN) return;
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

  // Attach the NIP-07 preload to installed web-app guests only (keyed on their
  // session partition), so they inherit the user's Nostr identity. Browser
  // tabs and devtools hosts attach in other partitions and get nothing. Keep
  // every guest locked down (sandboxed, no Node) regardless.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Every guest must live in one of Din's own partitions. A guest in the
    // default session would share the shell's app:// origin - and with it the
    // shell's storage, including any locally stored nsec.
    if (!GUEST_PARTITIONS.has(params.partition)) {
      event.preventDefault();
      return;
    }
    // Handed to the web-contents-created hook, which Electron runs next.
    attachingGuestSrc = typeof params.src === 'string' ? params.src : '';
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (params.partition === WEBAPP_PARTITION) {
      webPreferences.preload = WEBAPP_PRELOAD;
    } else if (params.partition === WEBBROWSER_PARTITION) {
      // Load frame preloads into sub-frames, not just the top document, so the
      // chrome.* API preload (session-registered by electron-chrome-extensions
      // as type:'frame') reaches extension web_accessible_resource iframes -
      // e.g. Bitwarden's inline-autofill overlay, a chrome-extension:// iframe
      // the content script embeds in the page. Without this the overlay's own
      // bundle has no chrome.runtime and the fill prompt never renders. The
      // guest stays sandboxed with no Node, so this only widens preload reach.
      // Scoped to the browser session on purpose: the web-app partition's
      // NIP-07 signer preload must never fan out into a page's iframes.
      webPreferences.nodeIntegrationInSubFrames = true;
      if (!attachingGuestSrc.startsWith('chrome-extension://')) {
        // Ad-hoc browser tabs get the highlight preload (no signer surface,
        // just the NIP-84 highlight affordance; see HIGHLIGHT_PRELOAD).
        // Extension pages in this session (the action popup) are not web
        // content. The preload now loads in sub-frames too, but guards itself
        // to the top frame (it would otherwise duplicate in every iframe).
        webPreferences.preload = HIGHLIGHT_PRELOAD;
      }
    }
  });

  // With no window manager, the shell won't follow a resolution change on its
  // own. Refit it over every display whenever they change (e.g. the Settings
  // display panel applying a new mode, or a monitor plugged in), and tell the
  // desktop where the monitors are now. A newly connected set of outputs gets
  // its saved arrangement back (Wayland).
  if (production) {
    const refit = () => {
      if (win.isDestroyed()) return;
      if (DISPLAY_TOOL === 'xrandr') {
        if (screen.getAllDisplays().length > 1 && win.isKiosk()) win.setKiosk(false);
        win.setBounds(screenBounds());
      }
      scheduleMonitorsUpdate();
      void restoreSavedLayout();
    };
    void restoreSavedLayout();
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
  // early presents an unpainted (white/pixelated) buffer on bare X11. The
  // short warm-up lets the hidden window composite complete black frames
  // before it maps; the veil then fades in from black. The fallback ensures
  // a crashed renderer can never leave the kiosk on a permanent black screen.
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  ipcMain.once('shell:bootReady', (event) => {
    if (event.sender === win.webContents) setTimeout(reveal, 400);
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
});

// Harden any <webview> the shell embeds (the web browser app). Keep them
// sandboxed with no Node integration, and deny requests to spawn native
// windows - target=_blank and friends become new browser tabs instead.
// Browser-partition guests are also registered as tabs with the Chrome
// extension system (chrome.tabs sees them; content scripts inject).
app.on('web-contents-created', (_event, contents) => {
  // Brightness and volume keys arrive as ordinary keyboard input to whichever
  // contents holds focus (shell or any guest), so hook them everywhere.
  attachMediaKeys(contents);

  // Holding Super lets the shell drag windows from anywhere, but it can't
  // see the key while focus is inside a guest, so forward its presses (not
  // consumed: Super is still a modifier for the page).
  if (contents.getType() === 'webview') {
    contents.on('before-input-event', (_event, input) => {
      if (input.key !== 'Meta' || input.isAutoRepeat) return;
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      sendToShell('shortcut', { action: 'super-key', down: input.type === 'keyDown' } satisfies ShellShortcut);
    });
  }

  if (contents.getType() !== 'webview') {
    // The shell renderer (address bar, inputs, etc.) gets no context menu by
    // default. Add Cut/Copy/Paste/Select All for editable fields.
    contents.on('context-menu', (_e, params) => {
      if (!params.isEditable) return;
      const { editFlags } = params;
      const menu = new Menu();
      if (editFlags.canCut) menu.append(new MenuItem({ role: 'cut' }));
      if (editFlags.canCopy) menu.append(new MenuItem({ role: 'copy' }));
      if (editFlags.canPaste) menu.append(new MenuItem({ role: 'paste' }));
      if (menu.items.length > 0) {
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'selectAll' }));
      }
      if (menu.items.length === 0) return;
      setImmediate(() => {
        if (shellWindow && !shellWindow.isDestroyed()) {
          menu.popup({ window: shellWindow });
        }
      });
    });
    return;
  }

  forwardGuestInput(contents);

  const isBrowserTab = contents.session === browserSession();

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
  // opens; the src itself was vetted when the app was installed.
  if (contents.session === appSession()) {
    let appOrigin: string | null = null;
    contents.on('did-navigate', (_event, url) => {
      // First real https commit only (an offline first load commits an error
      // page, which mustn't become the pin).
      const origin = originOf(url);
      if (appOrigin || !origin?.startsWith('https:')) return;
      appOrigin = origin;
      appGuestOrigins.set(contents.id, origin);
    });
    contents.once('destroyed', () => appGuestOrigins.delete(contents.id));
    const keepAppHome = (event: Electron.Event, url: string) => {
      if (appOrigin && originOf(url) === appOrigin) return;
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
  if (
    !isExtensionPageGuest &&
    (isBrowserTabSession(contents.session) || contents.session === appSession())
  ) {
    attachFileChooserInterception(contents);
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
  if (isBrowserTab && !isExtensionPageGuest) {
    attachUserscripts(contents);
    contents.on('will-navigate', (event, url) => {
      if (isUserscriptInstallUrl(url)) {
        event.preventDefault();
        sendToShell('userscripts:installRequested', { url, wcId: contents.id });
      }
    });
  }

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isBrowserTab && isUserscriptInstallUrl(url)) {
      sendToShell('userscripts:installRequested', { url, wcId: contents.id });
    } else if (
      /^(https|nsite):\/\//i.test(url) ||
      // Extension pages may open their own kind; a web page may not, since the
      // shell's fresh tab would skip Chromium's web_accessible_resources check.
      (/^chrome-extension:\/\//i.test(url) && contents.getURL().startsWith('chrome-extension://'))
    ) {
      // Tag the popup with its opener so the shell opens the new tab in the
      // same window/session - keeps private-window links out of the
      // persistent, authenticated session (and vice versa). Middle-click and
      // Ctrl/Cmd-click arrive as 'background-tab': open the tab behind the
      // current page without stealing focus or raising the window, Chrome-style.
      sendToShell('crx:openTab', {
        url,
        openerWcId: contents.id,
        background: disposition === 'background-tab',
      });
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
        event.preventDefault();
        sendToShell('devtools:toggleRequested', { wcId: targetId });
        return;
      }
      const shortcut = shellShortcutForInput(input);
      if (
        shortcut?.action === 'cycle-windows' ||
        shortcut?.action === 'apps-menu' ||
        shortcut?.action === 'screenshot' ||
        shortcut?.action === 'screenshot-area'
      ) {
        event.preventDefault();
        sendToShell('shortcut', shortcut);
      }
    });
    return;
  }

  // Shell-level shortcuts inside a page: F12 / Ctrl+Shift+I toggles the
  // tab's docked devtools; Ctrl+T / Ctrl+W manage browser tabs; Alt+Tab
  // switches desktop windows. Keyboard focus lives in the guest then, so
  // the shell can't see the keys itself - forward them.
  if (isBrowserTab) {
    contents.on('before-input-event', (event, input) => {
      if (isDevtoolsToggleInput(input)) {
        event.preventDefault();
        sendToShell('devtools:toggleRequested', { wcId: contents.id });
        return;
      }
      const shortcut = shellShortcutForInput(input);
      if (!shortcut) return;
      event.preventDefault();
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

  // Installed web-app guests aren't browser tabs, but focus still lands inside
  // them, so the shell's window-cycling, apps-menu, and screenshot shortcuts
  // must be forwarded too.
  if (isAppGuest(contents)) {
    contents.on('before-input-event', (event, input) => {
      const shortcut = shellShortcutForInput(input);
      if (
        shortcut?.action === 'cycle-windows' ||
        shortcut?.action === 'apps-menu' ||
        shortcut?.action === 'screenshot' ||
        shortcut?.action === 'screenshot-area'
      ) {
        event.preventDefault();
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
    }
    // buildChromeContextMenu always appends an "Inspect" item last, wired
    // straight to inspectElement() - which opens devtools in a detached
    // native window (unusable in the single-window kiosk shell). Rebuild the
    // menu with that item swapped for one that routes to the shell's docked
    // devtools pane.
    if (isBrowserTab) {
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
