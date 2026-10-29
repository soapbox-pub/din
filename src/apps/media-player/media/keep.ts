import { getFsBridge } from '@/lib/fs';
import { player } from './engine';
import { grantsReady, homeDir, inOwnFolders, keepFor, setSavedPaths } from './grants';
import { library } from './library';

/**
 * Which files from outside the player's own folders must still be reachable
 * after a restart: the Now Playing list's, and the songs of the playlists it
 * saved (the library keeps its folders itself).
 */

// Saved state from before the player had grants: what to ask for at startup.
setSavedPaths(async (home) => [...player.getState().queue.map((t) => t.location), ...(await library.savedFolders(home))]);

const PLAYLISTS_KEY = 'din:media-player:playlist-songs';

/** Saved playlists, by path, and the songs from outside the player's folders each names. */
function loadPlaylists(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((l) => typeof l === 'string')),
    );
  } catch {
    return {};
  }
}

function savePlaylists(playlists: Record<string, string[]>) {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
  } catch {
    // Its songs just aren't kept.
  }
  void keepFor('playlists', Object.values(playlists).flat());
}

/** A playlist was saved with these songs: keep reaching those from elsewhere. */
export function rememberPlaylist(path: string, locations: string[]): void {
  const playlists = loadPlaylists();
  const outside = locations.filter((l) => l.startsWith('/') && !inOwnFolders(l));
  if (outside.length > 0) playlists[path] = outside;
  else delete playlists[path];
  savePlaylists(playlists);
}

/** Forget the playlists that are gone (those the player can't look for are kept). */
async function prunePlaylists() {
  await grantsReady();
  const fs = getFsBridge();
  const playlists = loadPlaylists();
  for (const path of Object.keys(playlists)) {
    try {
      await fs?.stat(path);
    } catch (error) {
      if (/ENOENT|no such file/i.test(String(error))) delete playlists[path];
    }
  }
  savePlaylists(playlists);
}

/** Keep the grants the Now Playing list and saved playlists need, while the player runs. */
export function keepGrants(): () => void {
  let last: string | null = null;
  const sync = () => {
    const locations = player.getState().queue.map((t) => t.location);
    const key = locations.join('\n');
    if (key === last) return;
    last = key;
    void keepFor('queue', locations);
  };
  const unsubscribe = player.subscribe(sync);
  sync();
  void prunePlaylists();
  // The library's folders reached at startup are kept even if it isn't shown.
  void grantsReady().then(async () => {
    const home = homeDir();
    if (home && !library.getState().loaded) await keepFor('library', await library.savedFolders(home));
  });
  return unsubscribe;
}
