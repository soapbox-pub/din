import { connect, type Din, type DinFileHandle } from '@/sdk';
import { fileUrl, getFsBridge, joinPath } from '@/lib/fs';
import { isPlaylistFile } from './playlists';

/**
 * What the player can reach. Its own folders (the manifest's `din.folders`:
 * Music, Videos, its skins and its library's index) it reaches by path.
 * Anything else is a file or folder the user handed it (opened, dropped,
 * launched with, added to the library), as a handle, along with that file's
 * folder (`file-folders`). Handles still needed after a restart (the Now
 * Playing list, the library's folders, saved playlists' songs) are kept as
 * persist tokens, by path, and restored at startup; the rest are released.
 */

const TOKENS_KEY = 'din:media-player:grants';

/** The manifest's `din.folders`, under home. */
const OWN_FOLDERS = ['Music', 'Videos', '.local/share/din/skins', '.local/share/din/media-library'];

export type GrantUser = 'queue' | 'library' | 'playlists';

const handles = new Map<string, DinFileHandle>();
/** Persist tokens by user, then by path. */
let tokens: Partial<Record<GrantUser, Record<string, string>>> = {};
let ownRoots: string[] = [];
let home: string | null = null;
let starting: Promise<Din> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function loadTokens(): Partial<Record<GrantUser, Record<string, string>>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}');
    if (!isRecord(value)) return {};
    const out: Partial<Record<GrantUser, Record<string, string>>> = {};
    for (const user of ['queue', 'library', 'playlists'] as const) {
      const kept = value[user];
      if (!isRecord(kept)) continue;
      out[user] = Object.fromEntries(Object.entries(kept).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
    return out;
  } catch {
    return {};
  }
}

function saveTokens() {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // Not remembered past this session.
  }
}

/** Connected, with home known and last session's grants restored. */
export function grantsReady(): Promise<Din> {
  starting ??= (async () => {
    const din = await connect();
    const fs = getFsBridge();
    if (fs) {
      home = (await fs.homedir()).replace(/\/+$/, '');
      ownRoots = OWN_FOLDERS.map((f) => joinPath(home!, f));
    }
    tokens = loadTokens();
    await Promise.all(Object.values(tokens).flatMap((kept) => Object.entries(kept).map(async ([path, token]) => {
      const handle = await din.files.restore(token).catch(() => null);
      if (handle) {
        if (!handles.has(path)) handles.set(path, handle);
      } else {
        din.files.release(token);
        delete kept[path];
      }
    })));
    saveTokens();
    return din;
  })();
  return starting;
}

/** Home, once `grantsReady` has resolved. */
export function homeDir(): string | null {
  return home;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`);
}

/** Whether a path is in one of the player's own folders. */
export function inOwnFolders(path: string): boolean {
  return ownRoots.some((root) => under(path, root));
}

/**
 * Take files the user handed over. A playlist's folder comes along, so the
 * songs it names beside it (and below) are reached by path.
 */
export async function adopt(given: readonly DinFileHandle[]): Promise<string[]> {
  await Promise.all(given.map(async (handle) => {
    handles.set(handle.path, handle);
    if (handle.kind !== 'file' || !isPlaylistFile(handle.name)) return;
    const folder = await handle.parent().catch(() => null);
    if (folder && !handles.has(folder.path)) handles.set(folder.path, folder);
  }));
  return given.map((h) => h.path);
}

/** The handle for exactly this path, if the user handed it over. */
export function handleFor(path: string): DinFileHandle | null {
  return handles.get(path) ?? null;
}

/** The handed-over path that reaches a path: the file's own, or the nearest folder holding it. */
function reachedBy(path: string): string | null {
  if (handles.has(path)) return path;
  let best: string | null = null;
  for (const [p, h] of handles) {
    if (h.kind === 'directory' && under(path, p) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** A URL to load a local file from: its handle's, or by path in a folder the player reaches. */
export async function localUrl(path: string): Promise<string> {
  await grantsReady();
  const handle = handles.get(path);
  return handle ? handle.url() : fileUrl(path);
}

/** A local file's bytes: through its handle, or by path. */
export async function readLocal(path: string, maxBytes: number): Promise<Uint8Array> {
  await grantsReady();
  const handle = handles.get(path);
  if (handle && handle.kind === 'file') return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  const fs = getFsBridge();
  if (!fs) throw new Error('Files are only available inside Din');
  return (await fs.readFile(path, maxBytes)).data;
}

let keeping: Promise<void> = Promise.resolve();

/**
 * Keep across restarts what reaches these locations (those outside the
 * player's own folders), for one user of them (the Now Playing list, the
 * library, saved playlists), and let go of what that user kept before and
 * no longer needs.
 */
export function keepFor(user: GrantUser, locations: Iterable<string>): Promise<void> {
  const wanted = [...locations];
  keeping = keeping.then(async () => {
    const din = await grantsReady();
    const kept = (tokens[user] ??= {});
    const needed = new Set<string>();
    for (const location of wanted) {
      if (!location.startsWith('/') || inOwnFolders(location)) continue;
      const by = reachedBy(location);
      if (by) needed.add(by);
    }
    let changed = false;
    for (const path of needed) {
      if (kept[path]) continue;
      const token = await handles.get(path)?.persist().catch(() => null);
      if (!token) continue;
      kept[path] = token;
      changed = true;
    }
    for (const [path, token] of Object.entries(kept)) {
      if (needed.has(path)) continue;
      din.files.release(token);
      delete kept[path];
      changed = true;
    }
    if (changed) saveTokens();
  }).catch(() => {});
  return keeping;
}
