// Electron host for the webOS shell.
//
// Serves the built Vite app (dist/) over a custom app:// protocol instead of
// file:// so that:
//   - the shell gets a real origin (CSP 'self', BrowserRouter, fetch all work)
//   - unknown paths fall back to index.html (SPA routing)
//
// Set SHELL_DEV_URL (e.g. http://localhost:8080) to load a Vite dev server
// (with HMR) instead of the bundled dist/. See `make dev`.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, net, session } = require('electron');

const DIST = path.join(__dirname, 'dist');
const INDEX = path.join(DIST, 'index.html');

// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
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

// SHELL_DEV_URL (e.g. http://localhost:8080) loads a live Vite dev server
// with HMR instead of the bundled dist/. In that mode we run a normal
// resizable window with DevTools rather than the production kiosk shell.
const DEV_URL = process.env.SHELL_DEV_URL;

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

app.whenReady().then(() => {
  // Save downloads straight to ~/Downloads instead of popping a native
  // GTK save dialog (there is no desktop environment to host one).
  session.defaultSession.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    item.setSavePath(path.join(dir, item.getFilename()));
  });

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    return net.fetch(pathToFileURL(resolveFile(pathname)).toString());
  });

  registerFsHandlers();
  registerPtyHandlers();
  registerWifiHandlers();

  const win = new BrowserWindow({
    // Dev: normal windowed shell. Production: fullscreen kiosk.
    fullscreen: !DEV_URL,
    kiosk: !DEV_URL,
    width: 1280,
    height: 800,
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

  win.loadURL(DEV_URL || 'app://shell/');

  if (DEV_URL) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
});

// Harden any <webview> the shell embeds (the web browser app). Keep them
// sandboxed with no Node integration, and deny requests to spawn native
// windows (e.g. target=_blank) — navigation stays inside the webview.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) contents.loadURL(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => app.quit());
