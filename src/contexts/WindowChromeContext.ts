import { createContext, useContext } from 'react';

/** Which edges/corner a resize drag is acting on. */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** A pointer position in viewport coordinates. */
export interface ChromePoint {
  clientX: number;
  clientY: number;
}

/**
 * Lets an app that draws its own title bar stand in for the window's chrome
 * (a native app with client-side decorations, in a frameless window): it
 * turns a drag on its own title bar or edges into the same move or resize
 * gesture Din's chrome runs.
 *
 * A gesture is begun with the pointer where it is, then driven by the app,
 * which already holds the pointer: it feeds every move to `gestureMove` and
 * the release to `gestureEnd`.
 */
export interface WindowChrome {
  /** Start moving the window, as a title-bar drag would. */
  beginMove(point: ChromePoint): boolean;
  /**
   * Start resizing the window from an edge or corner. Returns false when the
   * window can't be resized (maximized or tiled).
   */
  beginResize(dir: ResizeDir, point: ChromePoint): boolean;
  gestureMove(point: ChromePoint): void;
  gestureEnd(): void;
}

const NO_CHROME: WindowChrome = {
  beginMove: () => false,
  beginResize: () => false,
  gestureMove: () => {},
  gestureEnd: () => {},
};

export const WindowChromeContext = createContext<WindowChrome | undefined>(undefined);

/**
 * The current window's chrome. Outside a Window (an app rendered on its own
 * in tests) every call is a no-op.
 */
export function useWindowChrome(): WindowChrome {
  return useContext(WindowChromeContext) ?? NO_CHROME;
}
