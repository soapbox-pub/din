import { createContext, useContext } from 'react';

/**
 * Whether the window hosting this app content is the desktop's top (focused)
 * window. Provided by Window around its content; consumed by components that
 * must behave differently while their window is stacked behind another.
 */
export const WindowFocusContext = createContext<boolean>(true);

/**
 * Whether the hosting window is the top (focused) window.
 *
 * Returns `true` outside a Window (e.g. an app rendered on its own in tests),
 * so consumers behave as if focused by default.
 */
export function useWindowIsTop(): boolean {
  return useContext(WindowFocusContext);
}
