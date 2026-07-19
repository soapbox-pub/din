// Electron host for the Din desktop environment.
//
// Serves the built Vite app (dist/) over a custom app:// protocol instead of
// file:// so that:
//   - the shell gets a real origin (CSP 'self', BrowserRouter, fetch all work)
//   - unknown paths fall back to index.html (SPA routing)
//
// Set DIN_DEV_URL (e.g. http://localhost:8080) to load a Vite dev server
// (with HMR) instead of the bundled dist/. See `npm run dev`.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, net, session, webContents, screen, globalShortcut, Menu, MenuItem } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const buildChromeContextMenu = require('electron-chrome-context-menu').default;
const {
  installChromeWebStore,
  uninstallExtension,
} = require('electron-chrome-web-store');
const { DevtoolsBridge } = require('./devtools-bridge.cjs');

// Locate the built Vite app. Two supported layouts:
//   - Aladdin/Nix: main.cjs and dist/ are installed side by side (__dirname/dist)
//   - repo/standalone launcher (os/x11/din-session.sh): main.cjs lives in
//     electron/, dist/ sits at the repo root (__dirname/../dist)
// DIN_DIST_DIR overrides both. Without this, the standalone session loads
// app://din/ against a non-existent electron/dist and shows a black screen.
function resolveDistDir() {
  const candidates = [
    process.env.DIN_DIST_DIR,
    path.join(__dirname, 'dist'),
    path.join(__dirname, '..', 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return path.resolve(dir);
  }
  // Nothing found: fall back to the colocated layout so paths/errors are sane.
  return path.join(__dirname, 'dist');
}

const DIST = resolveDistDir();
const INDEX = path.join(DIST, 'index.html');

// Must be called before app is ready. NOTE: each call to
// registerSchemesAsPrivileged REPLACES the full list, and requiring
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
]);

/** Map a request pathname to a file inside dist/, with SPA fallback. */
function resolveFile(pathname) {
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

/** Throw unless the request comes from the shell window's main frame. */
function assertShellSender(event) {
  if (
    event.sender.id !== shellContentsId ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('fs bridge: unauthorized sender');
  }
}

/** Validate and normalize a caller-supplied absolute path. */
function normalizeAbsolute(p) {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p)) {
    throw new Error('An absolute path is required');
  }
  return path.normalize(p);
}

/** Classify an fs.Stats as a directory, regular file, or other. */
function kindOf(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/** Plain-object stat summary that survives structured clone. */
function statSummary(stats) {
  return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
}

function registerFsHandlers() {
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
        const entry = {
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
// I/O, fd 3 for resize commands).
//
// Threat model: this is deliberately an arbitrary-command-execution API for
// the shell's origin, so it adds nothing beyond what the fs bridge already
// concedes (window.fs can write ~/.bashrc, which is code execution on the
// next login). The same boundaries apply: strict CSP, the sender guard, and
// the unprivileged OS user. The preload is never attached to <webview>s, so
// remote web content can't see it.
// ---------------------------------------------------------------------------

const PTY_HELPER = path.join(__dirname, 'pty-host.py');
const MAX_PTY_SESSIONS = 16;
const MAX_PTY_WRITE_BYTES = 1024 * 1024;

/** id -> ChildProcess running pty-host.py. */
const ptySessions = new Map();
let nextPtyId = 1;

/** Clamp a caller-supplied terminal dimension to something sane. */
function clampDimension(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(2, Math.floor(value)));
}

/** The login shell of the user we run as (best effort). */
function userShell() {
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch {
    // fall through
  }
  return process.env.SHELL || '/bin/sh';
}

function registerPtyHandlers() {
  ipcMain.handle('pty:spawn', (event, size) => {
    assertShellSender(event);
    if (ptySessions.size >= MAX_PTY_SESSIONS) {
      throw new Error(`Too many terminal sessions (max ${MAX_PTY_SESSIONS})`);
    }
    const rows = clampDimension(size?.rows, 24);
    const cols = clampDimension(size?.cols, 80);

    const proc = spawn('python3', [PTY_HELPER, userShell(), String(rows), String(cols)], {
      cwd: os.homedir(),
      // fd 3 is the helper's control channel (resize).
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });

    const id = nextPtyId++;
    ptySessions.set(id, proc);
    const sender = event.sender;

    // A write can race the helper's exit (EPIPE); without handlers those
    // stream errors would be unhandled in the main process.
    proc.stdin.on('error', () => {});
    proc.stdio[3]?.on('error', () => {});

    const send = (channel, ...args) => {
      if (!sender.isDestroyed()) sender.send(channel, ...args);
    };

    proc.stdout.on('data', (chunk) => send('pty:data', id, chunk));
    // Helper diagnostics (e.g. exec failures) surface in the terminal too.
    proc.stderr.on('data', (chunk) => send('pty:data', id, chunk));
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
    proc.stdin.write(data);
  });

  ipcMain.on('pty:resize', (event, id, cols, rows) => {
    assertShellSender(event);
    const proc = ptySessions.get(id);
    if (!proc) return;
    const control = proc.stdio[3];
    if (control && control.writable) {
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

const NMCLI_TIMEOUT_MS = 15_000;
const NMCLI_CONNECT_TIMEOUT_MS = 60_000;
const WIFI_TYPE = '802-11-wireless';

/** Run nmcli with an argv array; resolves stdout, rejects with a clean message. */
function nmcli(args, timeout = NMCLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      'nmcli',
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (error.code === 'ENOENT') return reject(new Error('nmcli-missing'));
        const detail = (stderr || error.message || '').trim().split('\n')[0];
        reject(new Error(detail || 'nmcli failed'));
      },
    );
  });
}

/**
 * Split one line of `nmcli -t` output into fields. Terse mode separates
 * fields with ':' and escapes literal ':' and '\' in values with a backslash.
 */
function splitTerse(line) {
  const fields = [];
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
function terseRows(stdout) {
  return stdout.split('\n').filter((line) => line.length > 0).map(splitTerse);
}

/** Validate a caller-supplied SSID. */
function validSsid(ssid) {
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
function validPassword(password) {
  if (password === undefined || password === null || password === '') return undefined;
  if (typeof password !== 'string' || password.length > 256 || password.includes('\0')) {
    throw new Error('Invalid password');
  }
  return password;
}

/** The first WiFi device known to NetworkManager, or null. */
async function wifiDevice() {
  const rows = terseRows(
    await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
  );
  const row = rows.find((fields) => fields[1] === 'wifi');
  if (!row) return null;
  return { iface: row[0], state: row[2], connection: row[3] || null };
}

/** Names of saved WiFi connection profiles. */
async function savedWifiConnections() {
  const rows = terseRows(await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']));
  return rows.filter((fields) => fields[1] === WIFI_TYPE).map((fields) => fields[0]);
}

// ---------------------------------------------------------------------------
// Display bridge (window.display), backed by xrandr. Meaningful only on a bare
// X11 session (the os/x11 standalone launcher), where Din is the whole desktop
// and nothing else manages screen resolution. On Wayland/cage (Aladdin) xrandr
// isn't applicable, so status reports `available: false` and the Settings
// panel renders a fallback - same shape as the WiFi bridge in QEMU.
//
// Threat model: same boundaries as the other bridges (strict CSP, sender
// guard, arguments re-validated). xrandr runs via execFile with an argv array
// - no shell - and the output name / mode are matched against xrandr's own
// parsed output before use, so neither can inject or select an invalid mode.
// ---------------------------------------------------------------------------

const XRANDR_TIMEOUT_MS = 15_000;

/** Run xrandr with an argv array; resolves stdout, rejects with a clean message. */
function xrandr(args, timeout = XRANDR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('xrandr', args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === 'ENOENT') return reject(new Error('xrandr-missing'));
      const detail = (stderr || error.message || '').trim().split('\n')[0];
      reject(new Error(detail || 'xrandr failed'));
    });
  });
}

/**
 * Parse `xrandr --query` into a list of outputs. Each output header looks like
 *   eDP connected primary 1920x1200+0+0 (normal ...) 302mm x 188mm
 * followed by indented mode lines
 *   1920x1200     60.00*+     ('*' = current mode, '+' = preferred/native)
 */
function parseXrandr(stdout) {
  const outputs = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    const head = line.match(
      /^(\S+)\s+(connected|disconnected)\b(\s+primary)?(?:.*?\s(\d+)x(\d+)\+\d+\+\d+)?/,
    );
    if (head) {
      current = {
        name: head[1],
        connected: head[2] === 'connected',
        primary: Boolean(head[3]),
        current: head[4] ? { width: Number(head[4]), height: Number(head[5]) } : null,
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

function registerDisplayHandlers() {
  ipcMain.handle('display:status', async (event) => {
    assertShellSender(event);
    try {
      const outputs = parseXrandr(await xrandr(['--query']));
      return { available: true, outputs: outputs.filter((o) => o.connected) };
    } catch (error) {
      if (error.message === 'xrandr-missing') return { available: false, outputs: [] };
      throw error;
    }
  });

  ipcMain.handle('display:setMode', async (event, rawOutput, rawWidth, rawHeight) => {
    assertShellSender(event);
    // Re-derive the real outputs and only act on a name/mode that xrandr
    // actually reports - never trust the renderer's strings directly.
    const outputs = parseXrandr(await xrandr(['--query']));
    const output = outputs.find((o) => o.connected && o.name === rawOutput);
    if (!output) throw new Error('Unknown display output');
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (!output.modes.some((m) => m.width === width && m.height === height)) {
      throw new Error('Unsupported mode for this output');
    }
    await xrandr(['--output', output.name, '--mode', `${width}x${height}`]);

    // With no WM, resize the shell to the new mode immediately rather than
    // waiting on a RandR event (which the display-metrics-changed listener
    // also handles). Assumes the primary output sits at the origin, which
    // holds for the single-display standalone session.
    if (output.primary && shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.setBounds({ x: 0, y: 0, width, height });
    }
  });
}

// ---------------------------------------------------------------------------
// Power bridge (window.power), backed by /sys/class/power_supply. Read-only
// sysfs, so it needs no external binary and works on any Linux session (cage
// on Aladdin or the bare-X11 standalone launcher). Reports `available: false`
// where there's no battery (desktops, the QEMU VM) so the menu-bar indicator
// hides and the Settings panel shows a fallback. Sender-guarded like the
// other bridges.
// ---------------------------------------------------------------------------

const POWER_SUPPLY_DIR = '/sys/class/power_supply';

/** Read a sysfs attribute, trimmed, or null when it's absent/unreadable. */
async function readPowerAttr(dir, name) {
  try {
    return (await fsp.readFile(path.join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Map the kernel's battery status string to a small stable enum. */
function mapBatteryStatus(raw) {
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
async function readBattery(dir, name) {
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
  let percent = capacityRaw !== null ? Number.parseInt(capacityRaw, 10) : NaN;
  if (Number.isNaN(percent) && Number.isFinite(now) && full > 0) {
    percent = Math.round((now / full) * 100);
  }
  percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;

  // Time estimate: energy(µWh)/power(µW) or charge(µAh)/current(µA) -> hours.
  let secondsRemaining = null;
  if (rate > 0 && Number.isFinite(now) && Number.isFinite(full)) {
    if (status === 'charging' && full > now) {
      secondsRemaining = Math.round(((full - now) / rate) * 3600);
    } else if (status === 'discharging') {
      secondsRemaining = Math.round((now / rate) * 3600);
    }
  }

  return { name, percent, status, secondsRemaining };
}

function registerPowerHandlers() {
  ipcMain.handle('power:status', async (event) => {
    assertShellSender(event);
    let names;
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
}

// ---------------------------------------------------------------------------
// Audio bridge (window.audio), backed by wpctl (WirePlumber/PipeWire). Drives
// the default sink's volume and mute for the menu-bar control, the Settings
// sound panel, and the media-key OSD. Where wpctl is absent (no PipeWire) it
// reports available:false and the UI falls back. Same trust boundary as the
// other bridges: sender guard, argv execFile, volume re-clamped here.
// ---------------------------------------------------------------------------

const WPCTL_TIMEOUT_MS = 5_000;
const DEFAULT_SINK = '@DEFAULT_AUDIO_SINK@';

/** Run wpctl with an argv array; resolves stdout, rejects with a clean message. */
function wpctl(args, timeout = WPCTL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('wpctl', args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === 'ENOENT') return reject(new Error('wpctl-missing'));
      const detail = (stderr || error.message || '').trim().split('\n')[0];
      reject(new Error(detail || 'wpctl failed'));
    });
  });
}

/** Clamp a caller-supplied percentage to an integer 0..100. */
function clampVolume(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) throw new Error('Invalid volume');
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Default sink volume/mute, or available:false when wpctl is absent. */
async function audioStatus() {
  try {
    // "Volume: 0.65" or "Volume: 0.65 [MUTED]"
    const out = await wpctl(['get-volume', DEFAULT_SINK]);
    const match = out.match(/Volume:\s*([\d.]+)/);
    const volume = match ? Math.round(Number.parseFloat(match[1]) * 100) : null;
    return { available: true, volume, muted: /\[MUTED\]/.test(out) };
  } catch (error) {
    if (error.message === 'wpctl-missing') {
      return { available: false, volume: null, muted: false };
    }
    throw error;
  }
}

async function audioSetVolume(pct) {
  const v = clampVolume(pct);
  // -l 1.0 caps at 100% so we never push into PipeWire's >1.0 boost range.
  await wpctl(['set-volume', '-l', '1.0', DEFAULT_SINK, `${v}%`]);
  return audioStatus();
}

async function audioSetMuted(muted) {
  await wpctl(['set-mute', DEFAULT_SINK, muted ? '1' : '0']);
  return audioStatus();
}

async function audioAdjust(deltaPct) {
  const sign = deltaPct >= 0 ? '+' : '-';
  await wpctl(['set-volume', '-l', '1.0', DEFAULT_SINK, `${Math.abs(deltaPct)}%${sign}`]);
  return audioStatus();
}

async function audioToggleMute() {
  await wpctl(['set-mute', DEFAULT_SINK, 'toggle']);
  return audioStatus();
}

function registerAudioHandlers() {
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
}

/**
 * Global media keys (VolumeUp/Down/Mute). Din owns the whole session, so it
 * grabs these directly, adjusts the default sink, and pushes the new state to
 * the shell so it can show the volume OSD. Harmless when wpctl is absent (the
 * adjust rejects and no OSD is shown).
 */
function registerMediaKeys() {
  const push = (statusPromise) =>
    statusPromise.then((s) => sendToShell('audio:osd', s)).catch(() => {});
  globalShortcut.register('VolumeUp', () => push(audioAdjust(5)));
  globalShortcut.register('VolumeDown', () => push(audioAdjust(-5)));
  globalShortcut.register('VolumeMute', () => push(audioToggleMute()));
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

function registerScreenshotHandlers() {
  ipcMain.handle('screenshot:capture', async (event) => {
    assertShellSender(event);
    if (!shellWindow || shellWindow.webContents.isDestroyed()) {
      throw new Error('Shell window unavailable');
    }
    const image = await shellWindow.webContents.capturePage();
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) {
      throw new Error('Captured an empty image');
    }
    // A PNG data URL survives structured clone and drops straight into an
    // <img> / fetch() in the renderer (see src/lib/screenshot.ts).
    return { dataUrl: image.toDataURL(), width, height };
  });
}

function registerWifiHandlers() {
  ipcMain.handle('wifi:status', async (event) => {
    assertShellSender(event);
    try {
      const [device, radio] = await Promise.all([
        wifiDevice(),
        nmcli(['-t', 'radio', 'wifi']),
      ]);
      return { available: true, radioEnabled: radio.trim() === 'enabled', device };
    } catch (error) {
      if (error.message === 'nmcli-missing') {
        return { available: false, radioEnabled: false, device: null };
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
    const bySsid = new Map();
    for (const [inUse, ssid, signal, security, freq] of rows) {
      if (!ssid) continue;
      const network = {
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

/** The BrowserWindow hosting the shell (set at startup). */
let shellWindow = null;

/** The extension system for the browser session (set at startup). */
let chromeExtensions = null;

/** Where Chrome Web Store installs / unpacked extensions live on disk. */
function extensionsPath() {
  return path.join(app.getPath('userData'), 'Extensions');
}

/** The session all browser <webview> tabs run in. */
function browserSession() {
  return session.fromPartition(WEBBROWSER_PARTITION);
}

/** Send an event to the shell renderer, if it's still alive. */
function sendToShell(channel, payload) {
  if (shellWindow && !shellWindow.webContents.isDestroyed()) {
    shellWindow.webContents.send(channel, payload);
  }
}

/**
 * Resolve a renderer-supplied WebContents id to a browser-tab guest, or null.
 * Only <webview> guests inside the browser partition qualify; anything else
 * (the shell itself, popups, stale ids) is rejected.
 */
function browserTabFromId(wcId) {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (contents.session !== browserSession()) return null;
  return contents;
}

// chrome.tabs.create round-trips through the shell renderer (it owns the tab
// UI). Each request gets an id; the renderer answers with the new <webview>
// guest's WebContents id once it attaches.
let nextTabRequestId = 1;
const pendingTabRequests = new Map();
const TAB_REQUEST_TIMEOUT_MS = 15_000;

/** Ask the shell to open a browser tab; resolves to the tab's WebContents. */
function requestShellTab(details) {
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
function ensureBrowserActionPreload() {
  const source = fs.readFileSync(
    require.resolve('electron-chrome-extensions/browser-action'),
    'utf8',
  );
  const file = path.join(app.getPath('userData'), 'browser-action.preload.js');
  fs.writeFileSync(file, `${source}\n;module.exports.injectBrowserAction();\n`);
  return file;
}

function setupChromeExtensions() {
  chromeExtensions = new ElectronChromeExtensions({
    // din is AGPL-3.0-or-later, compatible with the library's GPL-3.0.
    license: 'GPL-3.0',
    session: browserSession(),

    createTab: async (details) => {
      const contents = await requestShellTab(details);
      return [contents, shellWindow];
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
      return shellWindow;
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
  }).catch((error) => {
    console.error('chrome-web-store setup failed:', error);
  });

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

function registerCrxHandlers() {
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
// WebSocket bridge (see devtools-bridge.cjs for why the straightforward
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

/** The session all devtools host <webview>s run in. */
function devtoolsSession() {
  return session.fromPartition(DEVTOOLS_PARTITION);
}

/** CDP proxy connecting devtools frontends to their inspected tabs. */
const devtoolsBridge = new DevtoolsBridge({
  // A session died with its tab or pane; let the shell reconcile pane UI.
  onSessionEnded: (targetId) => sendToShell('devtools:closed', { wcId: targetId }),
});

/** Resolve a renderer-supplied id to a devtools host guest, or null. */
function devtoolsHostFromId(wcId) {
  if (typeof wcId !== 'number') return null;
  const contents = webContents.fromId(wcId);
  if (!contents || contents.isDestroyed()) return null;
  if (contents.getType() !== 'webview') return null;
  if (contents.session !== devtoolsSession()) return null;
  return contents;
}

/** Whether a before-input-event input is the devtools toggle shortcut. */
function isDevtoolsToggleInput(input) {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return true;
  return Boolean(input.control && input.shift && input.key.toLowerCase() === 'i');
}

/**
 * Map a guest before-input-event to a shell shortcut payload, or null.
 * Keyboard focus lives inside <webview> guests, so shell-level shortcuts
 * (window switching, browser tab management) must be intercepted here and
 * forwarded to the shell renderer (see src/lib/shellShortcuts.ts).
 */
function shellShortcutForInput(input) {
  if (input.type !== 'keyDown') return null;
  if (input.alt && !input.control && !input.meta && input.key === 'Tab') {
    return { action: 'cycle-windows', backward: Boolean(input.shift) };
  }
  if (input.control && !input.shift && !input.alt && !input.meta) {
    const key = input.key.toLowerCase();
    if (key === 't') return { action: 'new-tab' };
    if (key === 'w') return { action: 'close-tab' };
    if (key === 'l') return { action: 'focus-address' };
  }
  return null;
}

function registerDevtoolsHandlers() {
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
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  // Save downloads straight to ~/Downloads instead of popping a native
  // GTK save dialog (there is no desktop environment to host one). Applies
  // to both the shell session and the browser tabs' session.
  const downloadToHome = (_event, item) => {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    item.setSavePath(path.join(dir, item.getFilename()));
  };
  session.defaultSession.on('will-download', downloadToHome);
  browserSession().on('will-download', downloadToHome);

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    return net.fetch(pathToFileURL(resolveFile(pathname)).toString());
  });

  registerFsHandlers();
  registerPtyHandlers();
  registerWifiHandlers();
  registerDisplayHandlers();
  registerPowerHandlers();
  registerAudioHandlers();
  registerMediaKeys();
  registerScreenshotHandlers();
  registerCrxHandlers();
  registerDevtoolsHandlers();

  // Must run before any <webview> is created so the extension system's
  // preload/APIs are in place when the first tab loads.
  setupChromeExtensions();

  // Production runs with no window manager (cage on Aladdin, or a bare X11
  // login session via os/x11). cage force-fills the one app, but bare X11 has
  // nothing to honor the EWMH fullscreen hint, so the window would sit at its
  // default size letterboxed on a black screen. Size it to the primary
  // display's bounds explicitly and drop the frame; fullscreen/kiosk still
  // apply where a compositor does honor them.
  const production = !DEV_URL;
  const primaryBounds = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    // Dev: normal windowed shell. Production: fills the display, frameless.
    fullscreen: production,
    kiosk: production,
    frame: !production,
    ...(production
      ? { x: primaryBounds.x, y: primaryBounds.y, width: primaryBounds.width, height: primaryBounds.height }
      : { width: 1280, height: 800 }),
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Expose the fs bridge (window.fs) to the shell.
      preload: path.join(__dirname, 'preload.cjs'),
      // Enable <webview> so the in-shell web browser app can load arbitrary
      // sites (a real embedder, unlike an <iframe> which remote sites block
      // via X-Frame-Options / frame-ancestors). The renderer feature-detects
      // this and falls back to an <iframe> when running in a plain browser.
      webviewTag: true,
    },
  });

  shellContentsId = win.webContents.id;
  shellWindow = win;

  // With no window manager, the shell won't follow a resolution change on its
  // own. Refit it to the primary display whenever the display metrics change
  // (e.g. the Settings display panel applying a new xrandr mode).
  if (production) {
    const refit = () => {
      if (win.isDestroyed()) return;
      const b = screen.getPrimaryDisplay().bounds;
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    };
    screen.on('display-metrics-changed', refit);
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    win.on('closed', () => {
      screen.removeListener('display-metrics-changed', refit);
      screen.removeListener('display-added', refit);
      screen.removeListener('display-removed', refit);
    });
  }

  win.loadURL(DEV_URL || 'app://din/');

  if (DEV_URL) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
});

// Release the media-key grabs (VolumeUp/Down/Mute) when the app exits.
app.on('will-quit', () => globalShortcut.unregisterAll());

// Harden any <webview> the shell embeds (the web browser app). Keep them
// sandboxed with no Node integration, and deny requests to spawn native
// windows - target=_blank and friends become new browser tabs instead.
// Browser-partition guests are also registered as tabs with the Chrome
// extension system (chrome.tabs sees them; content scripts inject).
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  const isBrowserTab = contents.session === browserSession();

  if (chromeExtensions && shellWindow && isBrowserTab) {
    chromeExtensions.addTab(contents, shellWindow);
  }

  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https|chrome-extension):\/\//i.test(url)) {
      sendToShell('crx:openTab', { url });
    }
    return { action: 'deny' };
  });

  // Devtools hosts: pressing the toggle shortcut while focus is inside the
  // devtools pane closes it (routed to its inspected tab). Alt+Tab still
  // switches desktop windows. No Chrome context menu either - the devtools
  // frontend manages its own menus.
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
      if (shortcut?.action === 'cycle-windows') {
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
      openLink: (url) => {
        if (/^(https|chrome-extension):\/\//i.test(url)) {
          sendToShell('crx:openTab', { url });
        }
      },
    });
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
    menu.popup({ window: shellWindow ?? undefined });
  });
});

app.on('window-all-closed', () => app.quit());
