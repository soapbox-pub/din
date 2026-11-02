import type { WindowChrome } from '@/contexts/WindowChromeContext';

/**
 * Each open window's chrome (its move and resize gestures), by window id, so
 * something outside the window can grab it: the menu bar pulls a maximized
 * window down from under it, as its title bar would.
 */
const chromes = new Map<string, WindowChrome>();

export function registerWindowChrome(windowId: string, chrome: WindowChrome): () => void {
  chromes.set(windowId, chrome);
  return () => {
    if (chromes.get(windowId) === chrome) chromes.delete(windowId);
  };
}

export function getWindowChrome(windowId: string): WindowChrome | undefined {
  return chromes.get(windowId);
}

/**
 * Dragging a maximized window's title bar farther than this tears it away:
 * the window un-maximizes under the cursor and the drag continues. Small
 * enough to feel immediate, large enough that a sloppy click doesn't tear.
 */
export const TEAR_AWAY_PX = 8;
