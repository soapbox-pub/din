import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Lets an app render custom content into its window's title bar, replacing
 * the default icon + name. The Window owns a titlebar slot and exposes this
 * setter through context; an app (e.g. the Web Browser) publishes its tab
 * strip into the slot so tabs sit on the same line as the window controls,
 * Chrome-style.
 *
 * `undefined` means the app has no custom content and the default title
 * (icon + name) is shown.
 */
export const WindowTitlebarContext = createContext<
  ((content: ReactNode) => void) | undefined
>(undefined);

/**
 * Set (or clear) the current window's custom title-bar content. Pass a node
 * to take over the title bar; pass `null` to restore the default title.
 *
 * Returns a no-op when used outside a Window (e.g. an app rendered on its own
 * in tests), so apps can call it unconditionally.
 */
export function useWindowTitlebar(): (content: ReactNode) => void {
  return useContext(WindowTitlebarContext) ?? (() => {});
}
