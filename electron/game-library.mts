// Finding the games in ~/roms (electron/games.mts) and their box art.
//
// Each folder of ~/roms named for a system (game-systems.mts) is read one
// level deep: a game is a file of a type the system's games come as, or a
// folder holding some (a GameCube game in a folder of its own, a Switch game
// with its updates and DLC beside it, a disc set), whose files count as if
// they were in the system's folder. Copies of one game are grouped
// (game-names.mts). A folder is read again only when it has changed.
//
// Box art comes from libretro-thumbnails (thumbnails.libretro.com), named
// as No-Intro names games: the list of what it has for a system is fetched
// once a month and kept in ~/.cache/din/games/art, and each game is matched
// by its file's name, or failing that by its title, so "1080 Avalanche.rvz"
// still finds "1080 Avalanche (USA).png".
//
// Nothing here imports Electron, so it runs under plain Node too. Runs as
// TypeScript directly via Node's native type stripping - erasable syntax
// only, like the rest of electron/.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GameArt } from '../src/lib/games.ts';
import { isNumbered, parseName, sortKey, stem, versionLabel, versionScore, type ParsedName } from './game-names.mts';
import { SYSTEMS, systemForFolder, type SystemDef } from './game-systems.mts';

export interface ScannedVersion {
  path: string;
  label: string;
  score: number;
  /** The name as art would be filed under: its file's, wrapped no more. */
  name: string;
  parsed: ParsedName;
}

export interface ScannedGame {
  id: string;
  system: string;
  title: string;
  sort: string;
  versions: ScannedVersion[];
}

export interface ScannedSystem {
  def: SystemDef;
  folder: string;
  mtimeMs: number;
  games: ScannedGame[];
  /** "[BIOS] …" files found in its folder. */
  bios: string[];
}

/** The system folders in a ROMs folder. */
export async function systemFolders(root: string): Promise<{ def: SystemDef; folder: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { def: SystemDef; folder: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const def = systemForFolder(entry.name);
    if (!def) continue;
    // Two folders for one system ("genesis" and "megadrive"): both count.
    found.push({ def, folder: path.join(root, entry.name) });
  }
  return found.sort((a, b) => SYSTEMS.indexOf(a.def) - SYSTEMS.indexOf(b.def));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Read one system's folder into its games. */
export async function scanSystem(def: SystemDef, folder: string, preference: string[]): Promise<ScannedSystem> {
  const stat = await fsp.stat(folder);
  const accepted = new Set(def.extensions);
  const files: string[] = [];
  const bios: string[] = [];
  const consider = (file: string, name: string) => {
    if (name.startsWith('.')) return;
    if (/^\[bios\]/i.test(name)) bios.push(file);
    files.push(file);
  };
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(full)).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) {
      if (accepted.has(extensionOf(entry.name))) consider(full, entry.name);
      continue;
    }
    // A split Switch dump is a folder named like a file (Game.nsp/00, 01).
    if (accepted.has(extensionOf(entry.name))) {
      consider(full, entry.name);
      continue;
    }
    let inner: fs.Dirent[];
    try {
      inner = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of inner) {
      if (accepted.has(extensionOf(file.name)) && (file.isFile() || file.isSymbolicLink() || file.isDirectory())) consider(path.join(full, file.name), file.name);
    }
  }

  // A disc set's .m3u stands for its discs: they're not games of their own.
  const listed = new Set<string>();
  for (const file of files.filter((f) => extensionOf(f) === 'm3u')) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const entry = line.trim();
        if (entry && !entry.startsWith('#')) listed.add(path.resolve(path.dirname(file), entry));
      }
    } catch {
      // Unreadable: its discs show as they are.
    }
  }

  const numbered = isNumbered(files.map((f) => path.basename(f)));
  const groups = new Map<string, ScannedVersion[]>();
  for (const file of files) {
    if (listed.has(file)) continue;
    const base = path.basename(file);
    const parsed = parseName(base, numbered);
    if (parsed.junk || !parsed.key) continue;
    const version: ScannedVersion = {
      path: file,
      label: versionLabel(parsed),
      score: versionScore(parsed, preference, extensionOf(base)),
      name: stem(base, numbered),
      parsed,
    };
    const group = groups.get(parsed.key);
    if (group) group.push(version);
    else groups.set(parsed.key, [version]);
  }

  const games: ScannedGame[] = [];
  for (const [key, versions] of groups) {
    versions.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const title = versions[0].parsed.title;
    games.push({ id: `${def.id}/${key}`, system: def.id, title, sort: sortKey(title), versions });
  }
  games.sort((a, b) => a.sort.localeCompare(b.sort));
  return { def, folder, mtimeMs: stat.mtimeMs, games, bios };
}

// ---------------------------------------------------------------------------
// Box art
// ---------------------------------------------------------------------------

const THUMBNAILS = 'https://thumbnails.libretro.com';
const ART_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/** libretro-thumbnails files a name with these characters as _ in their place. */
function artFileName(name: string): string {
  return name.replace(/[&*/:`<>?\\|"]/g, '_');
}

export function artUrl(system: string, kind: 'Named_Boxarts' | 'Named_Titles' | 'Named_Snaps', name: string): string {
  return `${THUMBNAILS}/${encodeURIComponent(system)}/${kind}/${encodeURIComponent(artFileName(name))}.png`;
}

interface ArtList {
  names: string[];
  exact: Set<string>;
  byKey: Map<string, string[]>;
}

/** What libretro-thumbnails has for each system, fetched once a month. */
export class ArtIndex {
  private lists = new Map<string, ArtList>();
  private pending = new Map<string, Promise<boolean>>();
  private cacheDir: string;
  private fetchText: (url: string) => Promise<string>;

  constructor(cacheDir: string, fetchText: (url: string) => Promise<string>) {
    this.cacheDir = cacheDir;
    this.fetchText = fetchText;
  }

  /** Whether a system's list is in hand. */
  has(system: string): boolean {
    return this.lists.has(system);
  }

  /** Load a system's list, from the cache or the server; true when it's newly in hand. */
  ensure(system: string): Promise<boolean> {
    if (this.lists.has(system)) return Promise.resolve(false);
    let p = this.pending.get(system);
    if (!p) {
      p = this.load(system).finally(() => this.pending.delete(system));
      this.pending.set(system, p);
    }
    return p;
  }

  private async load(system: string): Promise<boolean> {
    const file = path.join(this.cacheDir, `${system.replace(/[^a-zA-Z0-9 -]/g, '_')}.json`);
    let cached: { fetchedAt: number; names: string[] } | null;
    try {
      cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      cached = null;
    }
    if (!cached || !Array.isArray(cached.names) || Date.now() - cached.fetchedAt > ART_MAX_AGE) {
      try {
        const html = await this.fetchText(`${THUMBNAILS}/${encodeURIComponent(system)}/Named_Boxarts/`);
        const names: string[] = [];
        for (const m of html.matchAll(/<a href="([^"?/][^"]*)\.png">/g)) {
          try {
            names.push(decodeURIComponent(m[1]));
          } catch {
            // A name that doesn't decode isn't one to match.
          }
        }
        if (names.length) {
          cached = { fetchedAt: Date.now(), names };
          await fsp.mkdir(this.cacheDir, { recursive: true });
          await fsp.writeFile(file, JSON.stringify(cached));
        }
      } catch {
        // Offline: an old list is better than none, and none means no art.
      }
    }
    if (!cached) return false;
    const byKey = new Map<string, string[]>();
    for (const name of cached.names) {
      const key = parseName(`${name}.png`).key;
      const list = byKey.get(key);
      if (list) list.push(name);
      else byKey.set(key, [name]);
    }
    this.lists.set(system, { names: cached.names, exact: new Set(cached.names), byKey });
    return true;
  }

  /** A game's art, or null while its system's list isn't in hand. */
  art(def: SystemDef, game: ScannedGame, preference: string[]): GameArt | null {
    if (!def.thumbnails) return { boxart: null, title: null, snap: null };
    const list = this.lists.get(def.thumbnails);
    if (!list) return null;
    const name = matchArt(list, game, preference);
    if (!name) return { boxart: null, title: null, snap: null };
    return {
      boxart: artUrl(def.thumbnails, 'Named_Boxarts', name),
      title: artUrl(def.thumbnails, 'Named_Titles', name),
      snap: artUrl(def.thumbnails, 'Named_Snaps', name),
    };
  }
}

function matchArt(list: ArtList, game: ScannedGame, preference: string[]): string | null {
  for (const version of game.versions) {
    const name = artFileName(version.name);
    if (list.exact.has(name)) return name;
  }
  const candidates = list.byKey.get(game.versions[0].parsed.key);
  if (!candidates?.length) return null;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const name of candidates) {
    const parsed = parseName(`${name}.png`);
    const score = versionScore(parsed, preference, 'png') - (parsed.junk ? 5000 : 0) - (name.includes('[') ? 100 : 0);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}
