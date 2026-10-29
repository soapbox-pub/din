import type { Din, OpenFileOptions, SaveFileOptions } from '@/sdk';
import { parentPath } from '@/lib/fs';

/**
 * The Media Player's few calls to the desktop that aren't the player's own,
 * by path: it has `fs`, since its library is the Music and Videos folders,
 * its playlists name songs by path and its skins live in a folder of Din's.
 */

function din(): Din {
  if (!window.din) throw new Error('Media Player runs in Din');
  return window.din;
}

/** Din's file picker; the paths chosen, or none if cancelled. */
export async function pickPaths(options: OpenFileOptions): Promise<string[]> {
  const handles = await din().files.open({ writable: false, ...options });
  return handles.flatMap((h) => (h.path ? [h.path] : []));
}

/** Din's save dialog; the path chosen, with the chosen type's extension, or null. */
export async function pickSavePath(options: SaveFileOptions): Promise<string | null> {
  return (await din().files.save(options))?.path ?? null;
}

/** Open Files at a folder, with an item in it selected. */
export async function showInFiles(dir: string, select?: string): Promise<void> {
  const handle = await din().files.fromPath(dir);
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
