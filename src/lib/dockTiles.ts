/**
 * Registry of live dock-tile elements, keyed by app id.
 *
 * The genie minimize animation (src/lib/genie.ts) needs the screen position
 * of the app's dock tile, but the Dock and the windows are sibling subtrees
 * with no shared parent to thread refs through. There is only ever one Dock,
 * so a module-level map keeps this trivially simple: the Dock registers each
 * tile's wrapper as it mounts/unmounts, and windows look their app's tile up
 * at animation time.
 */

import type { DockEdge } from '@/lib/genie';

const tiles = new Map<string, HTMLElement>();

export function registerDockTile(appId: string, el: HTMLElement | null): void {
  if (el) tiles.set(appId, el);
  else tiles.delete(appId);
}

/**
 * The app tile's resting rect in viewport coordinates, or null if the app
 * has no tile. Along the bottom edge, horizontal position comes from the
 * live rect (the dock's auto-hide slide is vertical-only, so left/width are
 * always valid); the vertical position is derived from layout offsets so a
 * dock caught mid-slide still yields the resting spot it settles at (the
 * footer is pinned to the viewport's bottom edge). A taskbar along any
 * other edge doesn't slide, so its live rect is the resting one.
 */
export function getDockTileRect(
  appId: string,
  edge: DockEdge,
): { x: number; y: number; width: number; height: number } | null {
  const el = tiles.get(appId);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (edge !== 'bottom') return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  return {
    x: rect.left,
    y: window.innerHeight - el.offsetHeight,
    width: rect.width,
    height: el.offsetHeight,
  };
}
