import { createContext, useContext } from 'react';

/**
 * Lets an app tint its window's title bar with an accent color, the way
 * Safari tints its chrome from a page's `<meta name="theme-color">`. The
 * Window owns the accent state and strictly sanitizes the value before
 * styling anything (colors are reported by untrusted web pages); apps just
 * publish the raw reported color.
 *
 * `null` (or an unparsable color) restores the default chrome.
 */
export const WindowAccentContext = createContext<
  ((color: string | null) => void) | undefined
>(undefined);

/**
 * Set (or clear) the current window's chrome accent color. Pass a CSS color
 * string to tint the title bar; pass `null` to restore the default chrome.
 *
 * Returns a no-op when used outside a Window (e.g. an app rendered on its
 * own in tests), so apps can call it unconditionally.
 */
export function useWindowAccent(): (color: string | null) => void {
  return useContext(WindowAccentContext) ?? (() => {});
}
