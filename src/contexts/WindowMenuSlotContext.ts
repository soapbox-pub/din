import { createContext, useContext } from 'react';

/**
 * The strip under a window's title bar where its app's menus go when there's
 * no menu bar to put them in (the taskbar layout), Windows style. Provided by
 * Window around its content; null when the window has no such strip.
 */
export const WindowMenuSlotContext = createContext<HTMLElement | null>(null);

/** The hosting window's menu strip, if it has one. */
export function useWindowMenuSlot(): HTMLElement | null {
  return useContext(WindowMenuSlotContext);
}
