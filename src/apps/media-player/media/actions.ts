import { extensionOf } from '@/lib/fileTypes';
import { cleanFsError, getFsBridge, joinPath, sortEntries } from '@/lib/fs';
import { makeTrack, player, type Track } from './engine';
import { adopt, grantsReady, handleFor, homeDir, reachPlaylistSongs, readLocal } from './grants';
import { isPlayableMedia } from './metadata';
import { isPlaylistFile, parsePlaylist, writePlaylist } from './playlists';
import { setPrefs } from './prefs';

/** Skin files: Winamp's .wsz (a renamed zip) and Windows Media Player's .wmz. */
export function skinKindOf(name: string): 'winamp' | 'wmp' | null {
  const ext = extensionOf(name);
  if (ext === 'wsz') return 'winamp';
  if (ext === 'wmz' || ext === 'wms') return 'wmp';
  return null;
}

export async function skinsDir(): Promise<string | null> {
  await grantsReady();
  const home = homeDir();
  return home ? joinPath(home, '.local/share/din/skins') : null;
}

/**
 * Copy a skin file into Din's skins folder (unless it's already there) and
 * wear it. A .zip is taken for a Winamp skin, as Winamp did.
 */
export async function installSkin(path: string, apply = true): Promise<string> {
  const fs = getFsBridge();
  const dir = await skinsDir();
  if (!fs || !dir) throw new Error('Skins need the Electron shell');
  const kind = skinKindOf(path) ?? (extensionOf(path) === 'zip' ? 'winamp' : null);
  if (!kind) throw new Error('That isn’t a skin file');
  let target = path;
  if (!path.startsWith(`${dir}/`)) {
    await fs.mkdir(dir);
    // The same skin again replaces the old copy rather than piling up.
    target = joinPath(dir, path.slice(path.lastIndexOf('/') + 1));
    await fs.writeFile(target, await readLocal(path, 64 * 1024 * 1024));
  }
  if (apply) setPrefs({ skin: { kind, path: target } });
  return target;
}

async function mediaInFolder(dir: string, depth = 0): Promise<string[]> {
  const fs = getFsBridge();
  if (!fs || depth > 8) return [];
  let listing;
  try {
    listing = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of sortEntries(listing.entries)) {
    if (e.name.startsWith('.')) continue;
    const path = joinPath(dir, e.name);
    if (e.kind === 'directory') out.push(...(await mediaInFolder(path, depth + 1)));
    else if (e.kind === 'file' && isPlayableMedia(e.name)) out.push(path);
  }
  return out;
}

/** The songs in a playlist file; to play them, ask for those in folders the player can't reach. */
export async function readPlaylistFile(path: string, { reach = false } = {}): Promise<Track[]> {
  const data = await readLocal(path, 8 * 1024 * 1024);
  let text = new TextDecoder('utf-8').decode(data);
  // Old M3U files are Windows-1252, not UTF-8.
  if (text.includes('\ufffd') && extensionOf(path) !== 'm3u8') text = new TextDecoder('windows-1252').decode(data);
  const entries = parsePlaylist(path, text);
  if (reach) await reachPlaylistSongs(path, entries.map((e) => e.location));
  return entries.map((e) => makeTrack(e.location, { title: e.title, artist: e.artist, duration: e.duration ?? null }));
}

/** Tracks for whatever was opened: songs, videos, playlists and folders. */
export async function tracksFor(paths: string[]): Promise<Track[]> {
  const fs = getFsBridge();
  const tracks: Track[] = [];
  for (const path of paths) {
    if (/^https?:\/\//i.test(path)) {
      tracks.push(makeTrack(path));
      continue;
    }
    if (isPlaylistFile(path)) {
      tracks.push(...(await readPlaylistFile(path, { reach: true })));
      continue;
    }
    if (isPlayableMedia(path)) {
      tracks.push(makeTrack(path));
      continue;
    }
    try {
      const kind = handleFor(path)?.kind ?? (await fs?.stat(path))?.kind;
      if (kind === 'directory') tracks.push(...(await mediaInFolder(path)).map((p) => makeTrack(p)));
    } catch {
      // Gone.
    }
  }
  return tracks;
}

/**
 * Open files the way double-clicking them in Files does: skins are worn,
 * everything else becomes the Now Playing list (or joins it).
 */
export async function openPaths(paths: string[], how: 'play' | 'enqueue' | 'next' = 'play'): Promise<string | null> {
  try {
    const skins = paths.filter((p) => skinKindOf(p));
    if (skins.length > 0) await installSkin(skins[skins.length - 1]);
    const rest = paths.filter((p) => !skinKindOf(p));
    if (rest.length === 0) return null;
    const tracks = await tracksFor(rest);
    if (tracks.length === 0) return 'There’s nothing Din can play there.';
    if (how === 'play') player.setQueue(tracks, 0, true);
    else player.enqueue(tracks, { next: how === 'next' });
    return null;
  } catch (error) {
    return cleanFsError(error);
  }
}

/** Open files the user handed over (picked, dropped, launched with). */
export async function openHandles(handles: readonly FileSystemHandle[], how: 'play' | 'enqueue' | 'next' = 'play'): Promise<string | null> {
  if (handles.length === 0) return null;
  return openPaths(await adopt(handles), how);
}

/** A playlist file's text for these songs. */
export function playlistText(path: string, tracks: Track[]): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return writePlaylist(
    path,
    name,
    tracks.map((t) => ({ location: t.location, title: t.title, artist: t.artist || undefined, duration: t.duration ?? undefined })),
  );
}

export const OPEN_EXTENSIONS = [
  '.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.weba', '.webm', '.mp4', '.m4v', '.mkv', '.mov', '.ogv',
  '.m3u', '.m3u8', '.pls', '.wpl', '.asx', '.wax', '.wvx', '.xspf',
];
export const SKIN_EXTENSIONS = ['.wsz', '.wmz', '.zip'];
