import { useSyncExternalStore } from 'react';

/** Which skin the player wears: Din's own, or a Winamp or WMP skin file. */
export type SkinChoice =
  | { kind: 'din' }
  | { kind: 'winamp'; path: string }
  | { kind: 'wmp'; path: string };

export type DinTab = 'now-playing' | 'library' | 'radio' | 'skins';

export const TABS: { id: DinTab; label: string }[] = [
  { id: 'now-playing', label: 'Now Playing' },
  { id: 'library', label: 'Library' },
  { id: 'radio', label: 'Radio' },
  { id: 'skins', label: 'Skins' },
];

export interface MusicPrefs {
  skin: SkinChoice;
  tab: DinTab;
  /** Visualization id, or 'art' for album art. */
  vis: string;
  /** Hue of Din's skin chrome (WMP's "Choose Color"), or null to match Din's theme. */
  hue: number | null;
  showList: boolean;
  showEnhancements: boolean;
  /** Din's compact Mini Player. */
  mini: boolean;
  /** Show lyrics over the visualization. */
  lyrics: boolean;
  /** Winamp: which windows are open, double size, and shade modes. */
  winamp: {
    eq: boolean;
    playlist: boolean;
    double: boolean;
    mainShade: boolean;
    eqShade: boolean;
    playlistShade: boolean;
    /** Playlist size in 25×29 steps beyond the minimum. */
    playlistW: number;
    playlistH: number;
    /** Timer shows time remaining. */
    remaining: boolean;
    /** 0 off, 1 spectrum, 2 oscilloscope. */
    vis: number;
  };
  /** The Din skin's full-mode window size, to return to from skins and the Mini Player. */
  dinSize: { width: number; height: number } | null;
  /** Radio stations the user added. */
  stations: { name: string; url: string; genre?: string }[];
}

const KEY = 'din:music-player:prefs';

const DEFAULTS: MusicPrefs = {
  skin: { kind: 'din' },
  tab: 'now-playing',
  vis: 'bars',
  hue: null,
  showList: true,
  showEnhancements: false,
  mini: false,
  lyrics: false,
  winamp: {
    eq: true,
    playlist: true,
    double: false,
    mainShade: false,
    eqShade: false,
    playlistShade: false,
    playlistW: 0,
    playlistH: 4,
    remaining: false,
    vis: 1,
  },
  dinSize: null,
  stations: [],
};

function load(): MusicPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<MusicPrefs> | null;
    if (!saved || typeof saved !== 'object') return DEFAULTS;
    return { ...DEFAULTS, ...saved, winamp: { ...DEFAULTS.winamp, ...(saved.winamp ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): MusicPrefs {
  return prefs;
}

export function setPrefs(patch: Partial<MusicPrefs> | ((p: MusicPrefs) => Partial<MusicPrefs>)): void {
  prefs = { ...prefs, ...(typeof patch === 'function' ? patch(prefs) : patch) };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered.
  }
  for (const l of listeners) l();
}

export function setWinampPrefs(patch: Partial<MusicPrefs['winamp']>): void {
  setPrefs((p) => ({ winamp: { ...p.winamp, ...patch } }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrefs<T>(selector: (p: MusicPrefs) => T): T {
  return useSyncExternalStore(subscribe, () => selector(prefs));
}
