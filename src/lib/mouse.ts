/**
 * Typed access to the mouse bridge exposed by the Electron preload
 * (`window.dinos.mouse`, see electron/preload.cjs + electron/mouse.mts):
 * Settings → Mouse, which din-shell applies. Elsewhere (Din in another
 * desktop, or a plain browser) the desktop's own settings are the mouse's,
 * and `status()` says these aren't available.
 */

import type { AppConfig } from '@/contexts/AppContext';

export interface MouseSettings {
  scrollDirection: AppConfig['mouseScrollDirection'];
  trackingSpeed: number;
  scrollSpeed: number;
  secondaryClick: AppConfig['mouseSecondaryClick'];
  middleClick: boolean;
  swipe: AppConfig['mouseSwipe'];
}

export interface MouseBridge {
  status(): Promise<{ available: boolean }>;
  set(settings: MouseSettings): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    mouse?: MouseBridge;
  }
}

/** The mouse bridge, or undefined when running outside the Electron shell. */
export function getMouseBridge(): MouseBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.mouse;
}

/** The mouse's settings in CONFIG, as din-shell takes them. */
export function mouseSettings(config: AppConfig): MouseSettings {
  return {
    scrollDirection: config.mouseScrollDirection,
    trackingSpeed: config.mouseTrackingSpeed,
    scrollSpeed: config.mouseScrollSpeed,
    secondaryClick: config.mouseSecondaryClick,
    middleClick: config.mouseMiddleClick,
    swipe: config.mouseSwipe,
  };
}
