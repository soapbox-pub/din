import type { AppDefinition } from '@/lib/apps';
import { isDesktopEntryName, parseDesktopEntry, type DesktopEntry } from '@/lib/desktopIcons';
import { appForFile } from '@/lib/fileTypes';
import { getFsBridge, type FsEntryKind } from '@/lib/fs';
import { getNativeAppsBridge, isProgram, NATIVE_APP_PREFIX } from '@/lib/nativeApps';

/** What opening a path needs of the desktop. */
export interface OpenPathDeps {
  open: (appId: string, params?: Record<string, unknown>) => unknown;
  openUrl: (url: string) => void;
  getApp: (id: string) => AppDefinition | undefined;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The app a launcher opens: its X-Din-App, else the installed Linux app it's
 * a copy of (by file name), if either is installed.
 */
export function entryApp(entry: DesktopEntry, fileName: string, getApp: OpenPathDeps['getApp']): AppDefinition | undefined {
  return (entry.app ? getApp(entry.app) : undefined) ?? getApp(`${NATIVE_APP_PREFIX}${fileName.replace(/\.desktop$/i, '')}`);
}

/** Start what a launcher stands for; false when it's nothing Din can open. */
export function launchEntry(entry: DesktopEntry, fileName: string, deps: OpenPathDeps): boolean {
  const app = entryApp(entry, fileName, deps.getApp);
  if (app) {
    deps.open(app.id);
    return true;
  }
  if (entry.type === 'Link' && entry.url) {
    deps.openUrl(entry.url);
    return true;
  }
  return false;
}

/**
 * Open a file or folder as double-clicking it does: a folder in Files, a
 * launcher's app, a program (Windows's through Wine, an AppImage), anything else in the app
 * for its kind (`din open`, desktop icons).
 */
export async function openPath(path: string, kind: FsEntryKind, deps: OpenPathDeps): Promise<void> {
  const name = basename(path);
  if (kind === 'directory') {
    deps.open('file-browser', { path });
    return;
  }
  const native = getNativeAppsBridge();
  if (native && isProgram(name)) {
    await native.runProgram(path);
    return;
  }
  if (isDesktopEntryName(name)) {
    const fs = getFsBridge();
    const text = fs ? new TextDecoder().decode((await fs.readFile(path, 64 * 1024)).data) : '';
    if (launchEntry(parseDesktopEntry(text), name, deps)) return;
    throw new Error(`${name} doesn’t open an app Din has`);
  }
  deps.open(appForFile(name), { path });
}
