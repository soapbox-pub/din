// Electron host for the webOS shell.
//
// Serves the built Vite app (dist/) over a custom app:// protocol instead of
// file:// so that:
//   - the shell gets a real origin (CSP 'self', BrowserRouter, fetch all work)
//   - unknown paths fall back to index.html (SPA routing)
//
// Set SHELL_DEV_URL (e.g. http://localhost:8080) to load a Vite dev server
// instead of the bundled dist/.

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, protocol, net, session } = require('electron');

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

  const win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(process.env.SHELL_DEV_URL || 'app://shell/');
});

app.on('window-all-closed', () => app.quit());
