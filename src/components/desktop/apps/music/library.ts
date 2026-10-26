import { useSyncExternalStore } from 'react';
import { getFsBridge, joinPath, parentPath } from '@/lib/fs';
import { isPlayableMedia, isVideoLocation, trackInfo, baseTitle } from './metadata';
import { isPlaylistFile } from './playlists';
import { player } from './engine';

/**
 * The Media Library: every song and video in the watched folders (Music and
 * Videos by default, as Windows Media Player watches My Music), with its
 * tags, star rating and play count. The index lives in
 * ~/.local/share/din/music-library.json so a scan only reads what changed.
 */

export interface LibraryItem {
  location: string;
  mtimeMs: number;
  size: number;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: string;
  track: number | null;
  disc: number | null;
  duration: number | null;
  bitrate: number | null;
  video: boolean;
  /** When it joined the library (ms since epoch). */
  added: number;
  /** 0-5 stars. */
  rating: number;
  plays: number;
  lastPlayed: number | null;
}

export interface LibraryState {
  folders: string[];
  items: LibraryItem[];
  /** Playlist files found in the watched folders. */
  playlists: string[];
  scanning: boolean;
  /** Files looked at in the scan underway. */
  scanned: number;
  loaded: boolean;
}

interface SavedLibrary {
  version: 1;
  folders: string[];
  items: LibraryItem[];
}

const MAX_DEPTH = 12;
const MAX_FILES = 50_000;

class Library {
  private state: LibraryState = { folders: [], items: [], playlists: [], scanning: false, scanned: 0, loaded: false };
  private listeners = new Set<() => void>();
  private home: string | null = null;
  private saveTimer: number | null = null;
  private loading: Promise<void> | null = null;
  private lastCounted: string | null = null;

  constructor() {
    // A song counts as played once it has been the current song while playing.
    player.subscribe(() => {
      const s = player.getState();
      const track = s.queue[s.current];
      if (s.status !== 'playing' || !track || track.key === this.lastCounted) return;
      this.lastCounted = track.key;
      this.update(track.location, (item) => ({ plays: item.plays + 1, lastPlayed: Date.now() }));
    });
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<LibraryState>, save = false) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    if (save) this.scheduleSave();
  }

  private async indexPath(): Promise<string | null> {
    const fs = getFsBridge();
    if (!fs) return null;
    this.home ??= await fs.homedir();
    return joinPath(this.home, '.local/share/din/music-library.json');
  }

  /** Load the saved index, then bring it up to date in the background. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const fs = getFsBridge();
      const path = await this.indexPath();
      if (!fs || !path) {
        this.set({ loaded: true });
        return;
      }
      let folders = [joinPath(this.home!, 'Music'), joinPath(this.home!, 'Videos')];
      try {
        const { data } = await fs.readFile(path, 64 * 1024 * 1024);
        const saved = JSON.parse(new TextDecoder().decode(data)) as SavedLibrary;
        if (saved.version === 1 && Array.isArray(saved.items)) {
          folders = Array.isArray(saved.folders) ? saved.folders : folders;
          this.set({ items: saved.items, folders });
        }
      } catch {
        // No index yet.
      }
      this.set({ folders, loaded: true });
      void this.scan();
    })();
    return this.loading;
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
  }

  private async save() {
    const fs = getFsBridge();
    const path = await this.indexPath();
    if (!fs || !path) return;
    const saved: SavedLibrary = { version: 1, folders: this.state.folders, items: this.state.items };
    try {
      await fs.mkdir(parentPath(path));
      await fs.writeFile(path, JSON.stringify(saved));
    } catch {
      // The library still works for this session.
    }
  }

  /** Walk the watched folders, reading tags of new and changed files. */
  async scan(): Promise<void> {
    const fs = getFsBridge();
    if (!fs || this.state.scanning) return;
    this.set({ scanning: true, scanned: 0 });
    const found = new Map<string, { mtimeMs: number; size: number }>();
    const playlists: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || found.size >= MAX_FILES) return;
      let listing;
      try {
        listing = await fs.readdir(dir);
      } catch {
        return;
      }
      const subdirs: string[] = [];
      for (const e of listing.entries) {
        if (e.name.startsWith('.')) continue;
        const path = joinPath(dir, e.name);
        if (e.kind === 'directory') subdirs.push(path);
        else if (e.kind === 'file' && isPlayableMedia(e.name)) found.set(path, { mtimeMs: e.mtimeMs ?? 0, size: e.size ?? 0 });
        else if (e.kind === 'file' && isPlaylistFile(e.name)) playlists.push(path);
      }
      this.set({ scanned: found.size });
      for (const sub of subdirs) await walk(sub, depth + 1);
    };
    for (const folder of this.state.folders) await walk(folder, 0);

    const known = new Map(this.state.items.map((i) => [i.location, i]));
    const fresh: LibraryItem[] = [];
    const stale: [string, { mtimeMs: number; size: number }][] = [];
    for (const [location, stat] of found) {
      const item = known.get(location);
      if (item && item.mtimeMs === stat.mtimeMs && item.size === stat.size) fresh.push(item);
      else stale.push([location, stat]);
    }
    // Keep what we had while the changed files are read.
    this.set({ items: [...fresh, ...stale.flatMap(([l]) => (known.has(l) ? [known.get(l)!] : []))], playlists: playlists.sort() }, true);

    const queue = stale.slice();
    const read: LibraryItem[] = [];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [location, stat] = next;
        const info = await trackInfo(location);
        const old = known.get(location);
        read.push({
          location,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          title: info.title || baseTitle(location),
          artist: info.artist ?? '',
          album: info.album ?? '',
          albumArtist: info.albumArtist ?? '',
          genre: info.genre ?? '',
          year: info.year ?? '',
          track: info.track ?? null,
          disc: info.disc ?? null,
          duration: info.duration ?? null,
          bitrate: info.bitrate ?? null,
          video: isVideoLocation(location),
          added: old?.added ?? Date.now(),
          rating: old?.rating ?? 0,
          plays: old?.plays ?? 0,
          lastPlayed: old?.lastPlayed ?? null,
        });
        if (read.length % 50 === 0) this.flush(fresh, read);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.flush(fresh, read);
    this.set({ scanning: false }, true);
  }

  private flush(fresh: LibraryItem[], read: LibraryItem[]) {
    const byLocation = new Map(fresh.map((i) => [i.location, i]));
    for (const i of read) byLocation.set(i.location, i);
    this.set({ items: [...byLocation.values()] }, true);
  }

  private update(location: string, patch: (item: LibraryItem) => Partial<LibraryItem>) {
    const i = this.state.items.findIndex((item) => item.location === location);
    if (i === -1) return;
    const items = this.state.items.slice();
    items[i] = { ...items[i], ...patch(items[i]) };
    this.set({ items }, true);
  }

  setRating(location: string, rating: number) {
    this.update(location, () => ({ rating: Math.max(0, Math.min(5, Math.round(rating))) }));
  }

  addFolder(folder: string) {
    if (this.state.folders.includes(folder)) return;
    this.set({ folders: [...this.state.folders, folder] }, true);
    void this.scan();
  }

  removeFolder(folder: string) {
    const folders = this.state.folders.filter((f) => f !== folder);
    const inside = (location: string) => location.startsWith(`${folder.replace(/\/+$/, '')}/`);
    this.set({ folders, items: this.state.items.filter((i) => !inside(i.location)) }, true);
  }

  /** Forget a file the library lists (Delete from Library). */
  forget(locations: string[]) {
    const drop = new Set(locations);
    this.set({ items: this.state.items.filter((i) => !drop.has(i.location)) }, true);
  }

  async homedir(): Promise<string | null> {
    const fs = getFsBridge();
    if (!fs) return null;
    this.home ??= await fs.homedir();
    return this.home;
  }
}

export const library = new Library();

export function useLibrary<T>(selector: (state: LibraryState) => T): T {
  return useSyncExternalStore(library.subscribe, () => selector(library.getState()));
}
