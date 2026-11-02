// Apps from folders on this computer, at din+file://<hash>/ (docs/din-command.md):
// what the App Store's "Add from a Folder…" installs, for developing an app
// outside Din's tree. The host is the sha256 of the folder's path, in
// base32, so a folder keeps its origin (and its storage) from run to run;
// its id on the desktop is file-<host>.
//
// It's a din:// app in every other way: the apps' session, window.din, its
// own process. Its files are served from inside the folder the way the `din`
// command serves one (din-launch.mts), read afresh on every load, and the
// desktop hears when any of them change, to reload its windows. Main serves
// only folders the desktop has opened since it started; the desktop keeps
// the list, and asks before granting a manifest's permissions.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ipcMain } from 'electron';
import { appsSession, DIN_FILE_SCHEME, fileAppId } from './din-apps.mts';
import { appFolder, findManifest, serveFrom } from './din-launch.mts';
import { nappletHost } from './widgets.mts';

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  /** Folders no app may be served from, or from a folder holding them. */
  protectedPaths: () => string[];
}

/** Folders the desktop opened as apps, by their din+file:// host. */
const folders = new Map<string, { root: string; watcher: fs.FSWatcher | null }>();

/** Whether a folder's app is being served (the desktop opened it since Din started). */
export function isServedFolder(host: string): boolean {
  return folders.has(host);
}

/** Changes there are a project's, not its app's. */
const IGNORED = /(^|[/\\])(\.git|node_modules)([/\\]|$)/;

/** Tell the desktop when a folder's files change, a moment after the last change (a build writes many). */
function watchFolder(host: string, root: string, send: Options['sendToShell']): fs.FSWatcher | null {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename && IGNORED.test(filename.toString())) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send('dinos-apps:folderChanged', { appId: fileAppId(host) });
      }, 300);
    });
    watcher.on('error', () => watcher.close());
    return watcher;
  } catch {
    return null;
  }
}

/** Serve folders' apps, and open them for the desktop. Call once the app is ready. */
export function registerDinFileApps(opts: Options): void {
  appsSession().protocol.handle(DIN_FILE_SCHEME, (request) => {
    let host = '';
    try {
      host = new URL(request.url).hostname;
    } catch {
      // Not a URL.
    }
    const folder = folders.get(host);
    return folder
      ? serveFrom({ kind: 'dir', root: folder.root }, request)
      : new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });

  // Open a folder the user chose as an app: serve it at din+file://<host>/,
  // watch it, and hand back its manifest as found (untrusted, icon inlined).
  ipcMain.handle('dinos-apps:folder', async (event, dir) => {
    opts.assertShellSender(event);
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Not a folder');
    const root = appFolder(path.resolve(dir), opts.protectedPaths());
    const host = nappletHost(createHash('sha256').update(root).digest('hex'));
    if (!folders.has(host)) folders.set(host, { root, watcher: watchFolder(host, root, opts.sendToShell) });
    const manifest = await findManifest({ kind: 'dir', root }, host);
    return { appId: fileAppId(host), path: root, manifest };
  });

  // The desktop removed the app: stop serving and watching its folder.
  ipcMain.handle('dinos-apps:closeFolder', (event, appId) => {
    opts.assertShellSender(event);
    for (const [host, folder] of folders) {
      if (fileAppId(host) !== appId) continue;
      folder.watcher?.close();
      folders.delete(host);
    }
  });
}
