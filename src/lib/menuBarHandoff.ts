import { useSyncExternalStore } from 'react';

/**
 * A window maximizing into (or restoring out of) the menu bar's color.
 *
 * The bar takes on the title bar of the maximized window under it, but a
 * maximize animates the window into place over a quarter of a second while
 * the bar's state changes at once. For the length of the animation the
 * window hands the bar its painted position frame by frame, and the bar
 * grows the window's color up into itself (or shrinks it back down) to
 * match, so the window looks like it stretches to the top of the screen.
 *
 * Start and end go through React (useMenuBarHandoff); frames don't, so the
 * bar follows the window at 60fps without a re-render per frame.
 */
export interface MenuBarHandoff {
  windowId: string;
  /** True for a maximize, false for a restore. */
  maximizing: boolean;
}

/** Where the window's color sits in the bar this frame. */
export interface MenuBarHandoffFrame {
  /** The window's painted left and right edges, in viewport pixels. */
  left: number;
  right: number;
  /** How much of the bar's height it fills, 0 to 1. */
  fill: number;
}

/** Longest a handoff may outlive a window that never ended it. */
const SAFETY_MS = 1000;

let current: MenuBarHandoff | null = null;
let lastFrame: MenuBarHandoffFrame | null = null;
let safety: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const frameListeners = new Set<(frame: MenuBarHandoffFrame) => void>();

function set(next: MenuBarHandoff | null) {
  current = next;
  if (!next) lastFrame = null;
  for (const l of listeners) l();
}

/**
 * Begin a handoff for a window's maximize or restore animation, replacing
 * any other. Feed it every frame, first frame included, and end it when the
 * animation finishes or is cancelled; ending a handoff another has replaced
 * does nothing.
 */
export function startMenuBarHandoff(windowId: string, maximizing: boolean) {
  const handoff: MenuBarHandoff = { windowId, maximizing };
  clearTimeout(safety);
  lastFrame = null;
  set(handoff);
  const end = () => {
    if (current !== handoff) return;
    clearTimeout(safety);
    set(null);
  };
  safety = setTimeout(end, SAFETY_MS);
  return {
    frame(f: MenuBarHandoffFrame) {
      if (current !== handoff) return;
      lastFrame = f;
      for (const l of frameListeners) l(f);
    },
    end,
  };
}

/** The handoff under way, if any. */
export function useMenuBarHandoff(): MenuBarHandoff | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

/** Follow the handoff's frames, starting with the latest one if any. */
export function onMenuBarHandoffFrame(cb: (frame: MenuBarHandoffFrame) => void): () => void {
  frameListeners.add(cb);
  if (lastFrame) cb(lastFrame);
  return () => frameListeners.delete(cb);
}
