import { createContext, useContext } from 'react';

/**
 * Height of a window's title bar in CSS px (the Window's `h-9`). An app that
 * overlays the title bar insets its content by this much.
 */
export const WINDOW_TITLEBAR_HEIGHT = 36;

/**
 * Lets an app run its content under its window's title bar: the body
 * extends to the window's top edge and the title bar floats over it with no
 * background, so an edge-to-edge page (viewport-fit=cover) shows through
 * seamlessly. The app is responsible for keeping its content clear of the
 * title bar's WINDOW_TITLEBAR_HEIGHT (e.g. as the page's safe-area inset).
 */
export const WindowOverlayContext = createContext<
  ((overlay: boolean) => void) | undefined
>(undefined);

/**
 * Turn the current window's title-bar overlay on or off.
 *
 * Returns a no-op when used outside a Window, so apps can call it
 * unconditionally.
 */
export function useWindowOverlay(): (overlay: boolean) => void {
  return useContext(WindowOverlayContext) ?? noop;
}

function noop() {}
