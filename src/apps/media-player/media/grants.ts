import { connect, type Din } from '@/sdk';
import { fileUrl, getFsBridge, joinPath } from '@/lib/fs';
import { isPlaylistFile } from './playlists';
import { forgetHandle, loadHandle, storeHandle } from '@/shared/handleStore';

/**
 * What the player can reach. Its own folders (the manifest's `din.folders`:
 * Music, Videos, its skins and its library's index) it reaches by path.
 * Anything else is a file or folder the user handed it (opened, dropped,
 * launched with, added to the library), as a handle, along with that file's
 * folder (`file-folders`). Handles still needed after a restart (the Now
 * Playing list, the library's folders, saved playlists' songs) are kept as
 * persist tokens, by path, and restored at startup; the rest are released.
 *
 * State saved before the player had grants (or whose grant is gone) names
 * paths nothing reaches: those it asks the desktop for, once, at startup
 * (silently on the launch that moved it out of the desktop).
 */

const TOKENS_KEY = 'din:media-player:grants';
/** Paths of saved state already asked for at startup and not granted (or gone): not asked again. */
const ASKED_KEY = 'din:media-player:asked';

/** The manifest's `din.folders`, under home. */
const OWN_FOLDERS = ['Music', 'Videos', '.local/share/din/skins', '.local/share/din/media-library'];

export type GrantUser = 'queue' | 'library' | 'playlists';

const handles = new Map<string, FileSystemHandle>();

/** Where a handle's file is. */
const pathOf = (handle: FileSystemHandle): string => window.din!.files.path(handle);
/** Persist tokens by user, then by path. */
let tokens: Partial<Record<GrantUser, Record<string, string>>> = {};
let ownRoots: string[] = [];
let home: string | null = null;
let starting: Promise<Din> | null = null;
let savedPaths: ((home: string) => Promise<string[]>) | null = null;

/** What saved state names by path (the Now Playing list, the library's folders), for startup. */
export function setSavedPaths(list: (home: string) => Promise<string[]>): void {
  savedPaths = list;
}

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
    // A grant that won't come back is a file gone (or one the user took
    // back): not one to ask for again.
    const lost: string[] = [];
    await Promise.all(Object.values(tokens).flatMap((kept) => Object.entries(kept).map(async ([path, token]) => {
      const handle = await loadHandle(token).catch(() => null);
      if (handle) {
        if (!handles.has(path)) handles.set(path, handle);
      } else {
        forgetHandle(token);
        delete kept[path];
        lost.push(path);
      }
    })));
    saveTokens();
    if (home) await reachSavedState(din, home, lost);
    return din;
  })();
  return starting;
}

function loadAsked(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ASKED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Ask once for what saved state names and nothing reaches. */
async function reachSavedState(din: Din, home: string, lost: string[]) {
  const asked = new Set([...loadAsked(), ...lost]);
  const named = savedPaths ? await savedPaths(home).catch(() => []) : [];
  const wanted = [...new Set(named)].filter((p) => p.startsWith('/') && !inOwnFolders(p) && !reachedBy(p) && !asked.has(p));
  if (wanted.length > 0) {
    const granted = await din.files
      .requestAccess(wanted, 'Media Player can’t reach some songs and folders it played before. Allow it to reach them again?')
      .catch(() => []);
    for (const handle of granted) handles.set(pathOf(handle), handle);
    for (const p of wanted) if (!handles.has(p)) asked.add(p);
  }
  try {
    localStorage.setItem(ASKED_KEY, JSON.stringify([...asked].slice(-2000)));
  } catch {
    // Asked again next time.
  }
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
export async function adopt(given: readonly FileSystemHandle[]): Promise<string[]> {
  await Promise.all(given.map(async (handle) => {
    handles.set(pathOf(handle), handle);
    if (handle.kind !== 'file' || !isPlaylistFile(handle.name)) return;
    const folder = await window.din!.files.parent(handle).catch(() => null);
    if (folder && !handles.has(pathOf(folder))) handles.set(pathOf(folder), folder);
  }));
  return given.map(pathOf);
}

/** The handle for exactly this path, if the user handed it over. */
export function handleFor(path: string): FileSystemHandle | null {
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

/**
 * Reach the songs a playlist names that nothing reaches yet, asking the
 * user (one prompt for the playlist).
 */
export async function reachPlaylistSongs(playlist: string, locations: string[]): Promise<void> {
  const din = await grantsReady();
  const folder = playlist.slice(0, playlist.lastIndexOf('/'));
  const wanted = [...new Set(locations)].filter((p) => p.startsWith('/') && !inOwnFolders(p) && !reachedBy(p) && !(reachedBy(playlist) && under(p, folder)));
  if (wanted.length === 0) return;
  const name = playlist.slice(playlist.lastIndexOf('/') + 1);
  const granted = await din.files.requestAccess(wanted, `${name} lists songs in other folders.`).catch(() => []);
  for (const handle of granted) handles.set(pathOf(handle), handle);
}

/** A URL to load a local file from: its handle's, or by path in a folder the player reaches. */
export async function localUrl(path: string): Promise<string> {
  await grantsReady();
  const handle = handles.get(path);
  return handle?.kind === 'file' ? window.din!.files.url(handle as FileSystemFileHandle) : fileUrl(path);
}

/** A local file's bytes: through its handle, or by path. */
export async function readLocal(path: string, maxBytes: number): Promise<Uint8Array> {
  await grantsReady();
  const handle = handles.get(path);
  if (handle?.kind === 'file') return new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
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
    await grantsReady();
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
      const handle = handles.get(path);
      const token = handle && (await storeHandle(handle).catch(() => null));
      if (!token) continue;
      kept[path] = token;
      changed = true;
    }
    for (const [path, token] of Object.entries(kept)) {
      if (needed.has(path)) continue;
      forgetHandle(token);
      delete kept[path];
      changed = true;
    }
    if (changed) saveTokens();
  }).catch(() => {});
  return keeping;
}
