import type { Din, StartIn } from '@/sdk';
import { fileTypes, pickFiles as pick, pickFolder, pickSaveFile, type FileTypeFilter } from '@/shared/fileHandles';
import { parentPath } from '@/lib/fs';
import { adopt, handleFor } from './grants';

/**
 * The Media Player's few calls to the desktop that aren't the player's own.
 * It reaches its own folders by path (Music, Videos, its skins and library
 * index), and everything else through what the user picks (`grants.ts`).
 */

function din(): Din {
  if (!window.din) throw new Error('Media Player runs in Din');
  return window.din;
}

interface PickOptions {
  title: string;
  types?: FileTypeFilter[];
  multiple?: boolean;
  /** A folder instead of files. */
  directory?: boolean;
  confirmLabel?: string;
  startIn?: StartIn;
}

/** Din's file picker, to read; what was chosen (and is now reachable by path), or nothing if cancelled. */
export async function pickFiles(options: PickOptions & { directory?: false }): Promise<FileSystemFileHandle[]>;
export async function pickFiles(options: PickOptions): Promise<FileSystemHandle[]>;
export async function pickFiles({ types, directory, ...options }: PickOptions): Promise<FileSystemHandle[]> {
  const handles: FileSystemHandle[] = directory
    ? [await pickFolder(options)].filter((h) => h !== null)
    : await pick({ ...options, mode: 'read', types: types && fileTypes(types) });
  await adopt(handles);
  return handles;
}

/** Din's file picker; the paths chosen, or none if cancelled. */
export async function pickPaths(options: PickOptions): Promise<string[]> {
  return (await pickFiles(options)).map((h) => din().files.path(h));
}

/** Din's save dialog: a handle to write, with the chosen type's extension, or null. */
export function pickSave({ types, ...options }: { title: string; suggestedName?: string; types?: FileTypeFilter[]; startIn?: StartIn }): Promise<FileSystemFileHandle | null> {
  return pickSaveFile({ ...options, types: types && fileTypes(types) });
}

/** A folder of home's as a picker's start: a handle when the player reaches it, else the named folder. */
export async function startFolder(path: string, named: Exclude<StartIn, FileSystemHandle>): Promise<StartIn> {
  return handleFor(path) ?? (await din().files.fromPath(path).catch(() => null)) ?? named;
}

/** Open Files at a folder, with an item in it selected. */
export async function showInFiles(dir: string, select?: string): Promise<void> {
  const handle = handleFor(dir) ?? (await din().files.fromPath(dir));
  await din().app.open('file-browser', select ? { select } : {}, [handle]);
}

/** Open Files on the folder holding a file, with the file selected. */
export function showFileInFiles(path: string): Promise<void> {
  return showInFiles(parentPath(path), path.slice(path.lastIndexOf('/') + 1));
}

/** Open a web page in the Web Browser. */
export function openUrl(url: string): void {
  void din().app.openUrl(url);
}

/** Open the App Store at its Media Player skins. */
export function findSkins(): void {
  void din().app.open('app-store', { tab: 'skins' });
}

/**
 * Ask the desktop to publish a skin in the skins folder to Nostr, by its
 * file name: the App Store asks what to call it, then signs and uploads it,
 * which the player can't do itself.
 */
export function publishSkin(path: string): void {
  void din().app.open('app-store', { publishSkin: path.slice(path.lastIndexOf('/') + 1) });
}
