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
