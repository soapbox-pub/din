import type { Din, DinFileHandle, OpenFileOptions, SaveFileOptions } from '@/sdk';
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

/** Din's file picker; what was chosen (and is now reachable by path), or nothing if cancelled. */
export async function pickFiles(options: OpenFileOptions): Promise<DinFileHandle[]> {
  const handles = await din().files.open({ writable: false, ...options });
  await adopt(handles);
  return handles;
}

/** Din's file picker; the paths chosen, or none if cancelled. */
export async function pickPaths(options: OpenFileOptions): Promise<string[]> {
  return (await pickFiles(options)).map((h) => h.path);
}

/** Din's save dialog: a handle to write, with the chosen type's extension, or null. */
export function pickSave(options: SaveFileOptions): Promise<DinFileHandle | null> {
  return din().files.save(options);
}

/** A folder of home's as a picker's start: a handle when the player reaches it, else the named folder. */
export async function startFolder(path: string, named: NonNullable<OpenFileOptions['startIn']>): Promise<NonNullable<OpenFileOptions['startIn']>> {
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
