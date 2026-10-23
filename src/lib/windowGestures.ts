import { useSyncExternalStore } from 'react';

/**
 * Which windows are mid-gesture: being dragged or resized, wobbling, or
 * playing a genie or maximize animation. Those paint through CSS transforms
 * and commit their geometry only when they finish, so the window manager's
 * rects say nothing about where they are on screen until then. The desktop
 * reads this so a window it's hiding behind one of them (see Desktop's
 * covered windows) shows again the moment the one above starts to move.
 *
 * A set of ids rather than a counter: a gesture may end more than once (a
 * snap drop ends the drag, then its FLIP), and ending one twice is harmless.
 */
let moving: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function update(next: ReadonlySet<string>): void {
  moving = next;
  for (const listener of listeners) listener();
}

/** A window's gesture began. */
export function beginWindowGesture(id: string): void {
  if (moving.has(id)) return;
  update(new Set(moving).add(id));
}

/** A window's gesture ended (or it went away mid-gesture). */
export function endWindowGesture(id: string): void {
  if (!moving.has(id)) return;
  const next = new Set(moving);
  next.delete(id);
  update(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ReadonlySet<string> = new Set();

/** The ids of the windows mid-gesture; re-renders when that changes. */
export function useMovingWindows(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => moving, () => EMPTY);
}
