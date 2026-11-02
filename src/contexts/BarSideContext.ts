import { createContext, useContext } from 'react';
import type { TaskbarPosition } from '@/contexts/AppContext';

/**
 * The screen edge of the taskbar a bar item sits in, or null in the menu bar.
 * The status items (the clock, Wi-Fi, volume, the account…) are shared by
 * both bars, and their panels open away from whichever edge theirs is on.
 */
export const BarSideContext = createContext<TaskbarPosition | null>(null);

/** The screen edge of the taskbar a bar item is in, or null in the menu bar. */
export function useTaskbarEdge(): TaskbarPosition | null {
  return useContext(BarSideContext);
}

/**
 * The side a bar item's popover opens on: down from the menu bar or a
 * taskbar along the top, up from one along the bottom, right of one down the
 * left, left of one down the right.
 */
export function useBarSide(): 'top' | 'bottom' | 'left' | 'right' {
  const edge = useContext(BarSideContext);
  return edge === 'bottom' ? 'top' : edge === 'left' ? 'right' : edge === 'right' ? 'left' : 'bottom';
}
