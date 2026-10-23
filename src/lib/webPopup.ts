import type { CrxPopupFeatures } from '@/lib/crx';

/** The hidden app a page's pop-up window opens in (see WebPopup). */
export const WEB_POPUP_APP_ID = 'web-popup';

/** The window's title bar and the pop-up's address strip, in px. */
const CHROME_HEIGHT = 36 + 33;
/** What a window's border adds to each dimension, in px. */
const BORDER = 2;

/**
 * The desktop window size for a pop-up whose page asked for this size,
 * kept on the screen.
 */
export function popupWindowSize(popup: CrxPopupFeatures): { width: number; height: number } {
  return {
    width: Math.min(popup.width + BORDER, window.innerWidth - 32),
    height: Math.min(popup.height + CHROME_HEIGHT + BORDER, window.innerHeight - 96),
  };
}
