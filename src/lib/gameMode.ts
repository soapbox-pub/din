/**
 * Which native games are in full screen, for what the desktop does while
 * one is (GamePerformanceHost.tsx: the performance power mode).
 *
 * A game is a native window in full screen that Steam launched (its window
 * class is steam_app_<id>), that the Games app launched, or that has locked
 * the pointer for mouse-look; a video player in full screen isn't one, and
 * shouldn't run the computer hot.
 */

import { unlistedNativeApps } from '@/lib/nativeApps';

const games = new Set<number>();
const listeners = new Set<() => void>();

/** Whether native window XID is a game in full screen, or no longer. */
export function setGameFullscreen(xid: number, fullscreen: boolean): void {
  if (fullscreen === games.has(xid)) return;
  if (fullscreen) games.add(xid);
  else games.delete(xid);
  for (const listener of listeners) listener();
}

/** Whether any game is in full screen. */
export function gameInFullscreen(): boolean {
  return games.size > 0;
}

export function subscribeGameFullscreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether a native app is a game Din itself launched: one the Games app
 * plays, an app of its own in the Game category (electron/games.mts).
 */
export function isLaunchedGame(appId: string): boolean {
  return unlistedNativeApps().some((app) => app.id === appId && app.categories.includes('Game'));
}

/** Whether a native window of WM_CLASS is a game Steam launched. */
export function isSteamGame(wmClass: string[]): boolean {
  return wmClass.some((name) => /^steam_app_\d+$/i.test(name));
}
