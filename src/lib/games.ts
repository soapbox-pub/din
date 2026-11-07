/**
 * Games (din.system.games, for the Games app in src/apps/games/, and
 * window.dinos.games for `din games`): the games in ~/roms, laid out as
 * RetroArch lays them out (a folder per system: snes/, gba/, n64/…), and
 * playing them in emulators Din sets up itself. Backed by electron/games.mts.
 */

/** A system with a folder in ~/roms. */
export interface GameSystem {
  /** Its folder's usual name: "snes", "gba". */
  id: string;
  name: string;
  maker: string;
  year: number;
  /** How many games it has. */
  count: number;
  /** Whether its games can be played on this computer now. */
  playable: boolean;
  /** Why not, when they can't: said to the user as it is. */
  unavailable: string | null;
}

/** One copy of a game: a region, a revision, a disc. */
export interface GameVersion {
  path: string;
  /** What sets it apart, from its name: "USA, Rev 1", "Japan". */
  label: string;
}

/** Pictures of a game, from libretro-thumbnails, by URL; any may be missing. */
export interface GameArt {
  boxart: string | null;
  title: string | null;
  snap: string | null;
}

export interface Game {
  /** `<system>/<title>`, stable across scans. */
  id: string;
  system: string;
  /** As people write it: "The Legend of Zelda: A Link to the Past". */
  title: string;
  /** The copy that plays: the one chosen, else the best for this computer's language. */
  path: string;
  /** Every copy, best first. */
  versions: GameVersion[];
  /** Null until the system's art index has been looked up. */
  art: GameArt | null;
  favorite: boolean;
  /** When it was last played (ms since the epoch), or null. */
  lastPlayed: number | null;
  /** How long it's been played, in seconds. */
  playTime: number;
  /** Whether it was left mid-game, to pick up where it was. */
  resumable: boolean;
  /** Whether it came out where this computer's language is spoken (a USA or European copy for English), to feature it. */
  local: boolean;
}

export interface GamesLibrary {
  /** The folder the games are in (~/roms). */
  root: string;
  systems: GameSystem[];
  games: Game[];
}

/** The game being played. */
export interface RunningGame {
  id: string;
  title: string;
  system: string;
  startedAt: number;
}

export interface GamesStatus {
  /** Whether the emulators are on this computer. */
  installed: boolean;
  /** Whether they're an optional feature of DinOS, installed from Settings. */
  optionalFeature: boolean;
  running: RunningGame | null;
}

export interface PlayOptions {
  /** Which copy, by path; the game's own choice if not given. */
  version?: string;
  /** Start from the beginning instead of where it was left. */
  fresh?: boolean;
}

/** What `onChanged` hears: the library (a scan, art, favorites, play time) or what's running. */
export type GamesChange = { kind: 'library' } | { kind: 'running'; running: RunningGame | null };

export interface GamesBridge {
  status(): Promise<GamesStatus>;
  /** The library, scanning ~/roms again where a folder has changed (or all of it, with `rescan`). */
  library(options?: { rescan?: boolean }): Promise<GamesLibrary>;
  /** Play a game, full screen, quitting whatever was being played first. */
  play(id: string, options?: PlayOptions): Promise<void>;
  /** Quit the game being played, keeping where it was. */
  stop(): Promise<void>;
  setFavorite(id: string, favorite: boolean): Promise<void>;
  /** Which copy of a game plays from now on. */
  setVersion(id: string, path: string): Promise<void>;
  /** The moment a game was left at, as a data: URL, or null. */
  resumeImage(id: string): Promise<string | null>;
  /** Forget where a game was left, so it starts from the beginning (its in-game saves stay). */
  forgetResume(id: string): Promise<void>;
  onChanged(callback: (change: GamesChange) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    games?: GamesBridge;
  }
}

/** The desktop's games bridge, for `din games`. */
export function getGamesBridge(): GamesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.games;
}
