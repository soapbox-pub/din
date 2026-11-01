import { createContext, useContext } from 'react';

/**
 * Which way the panels of a bar's items open: down from the menu bar along
 * the top of the screen, or up from the taskbar along the bottom. The status
 * items (the clock, Wi-Fi, volume, the account…) are shared by both bars.
 */
export const BarSideContext = createContext<'top' | 'bottom'>('bottom');

/** The side a bar item's popover opens on. */
export function useBarSide(): 'top' | 'bottom' {
  return useContext(BarSideContext);
}
