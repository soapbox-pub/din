import { createContext, useContext } from 'react';

/**
 * Whether the window hosting this app content is showing (not minimized, nor
 * hidden behind a window that covers it).
 * Provided by Window around its content; consumed by web surfaces, which tell
 * their pages they're hidden so those can pause themselves.
 */
export const WindowVisibleContext = createContext<boolean>(true);

/**
 * Whether the hosting window is showing.
 *
 * Returns `true` outside a Window (e.g. an app rendered on its own in tests).
 */
export function useWindowVisible(): boolean {
  return useContext(WindowVisibleContext);
}
