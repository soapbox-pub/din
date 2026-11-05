import { REDUCE_MOTION_ATTRIBUTE } from '@/shared/reducedMotion';

/**
 * Settings → Accessibility, applied. Each preference marks the desktop's
 * root, where src/index.css acts on it; the theme Din sends its apps carries
 * them (src/components/desktop/dinHost/theme.ts), so each app's root gets the
 * same marks. Web pages and apps also see them as the standard media
 * features (prefers-reduced-motion…), and on DinOS, Linux apps hear of them
 * through GSettings (electron/accessibility.mts).
 */

export interface AccessibilityPreferences {
  reduceMotion: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
  /** A percentage; 100 is normal. */
  textSize: number;
  /** The glass, unless reduceTransparency (or increaseContrast) makes it solid. */
  glass: 'liquid' | 'frosted';
}

export const REDUCE_TRANSPARENCY_ATTRIBUTE = 'data-reduce-transparency';
export const INCREASE_CONTRAST_ATTRIBUTE = 'data-increase-contrast';
/** The root custom property naming what glass is made of (liquid, frosted or solid), which src/index.css's style queries follow; apps get it with the theme. */
export const GLASS_MATERIAL_PROPERTY = '--glass-material';
/** The root custom property every Tailwind text size is multiplied by. */
export const TEXT_SCALE_PROPERTY = '--din-text-scale';

export const MIN_TEXT_SIZE = 100;
export const MAX_TEXT_SIZE = 200;
export const TEXT_SIZE_STEP = 10;

export function clampTextSize(percent: number): number {
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, Math.round(percent)));
}

export interface AccessibilityBridge {
  /**
   * Pass the preferences on: to every web page and app as the CSS media
   * features `prefers-reduced-motion`, `prefers-reduced-transparency` and
   * `prefers-contrast`, and to Linux apps through GSettings (only where Din
   * is the desktop).
   */
  set(preferences: { reduceMotion: boolean; reduceTransparency: boolean; highContrast: boolean }): Promise<void>;
  /** Whether din-shell is there to zoom the screen, filter its colours and help with the keyboard. */
  status(): Promise<{ screen: boolean }>;
  /** Tell din-shell the screen's settings; a no-op without it. */
  setScreen(settings: ScreenAccessibility): Promise<void>;
}

/** What din-shell does for Settings → Accessibility (native/din-compositor/src/session/accessibility.rs). */
export interface ScreenAccessibility {
  zoomKeys: boolean;
  colorFilter: ColorFilter;
  stickyKeys: boolean;
  slowKeys: boolean;
  bounceKeys: boolean;
}

export const COLOR_FILTERS = ['none', 'invert', 'grayscale', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export type ColorFilter = (typeof COLOR_FILTERS)[number];

/** How Settings names each colour filter. */
export const COLOR_FILTER_NAMES: Record<ColorFilter, string> = {
  none: 'None',
  invert: 'Invert colors',
  grayscale: 'Grayscale',
  protanopia: 'Red-green (protanopia)',
  deuteranopia: 'Green-red (deuteranopia)',
  tritanopia: 'Blue-yellow (tritanopia)',
};

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    accessibility?: AccessibilityBridge;
  }
}

export function getAccessibilityBridge(): AccessibilityBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.accessibility;
}

/** Mark the document's root with the preferences. */
export function applyAccessibility(preferences: AccessibilityPreferences): void {
  const root = document.documentElement;
  root.toggleAttribute(REDUCE_MOTION_ATTRIBUTE, preferences.reduceMotion);
  root.toggleAttribute(REDUCE_TRANSPARENCY_ATTRIBUTE, preferences.reduceTransparency || preferences.increaseContrast);
  root.toggleAttribute(INCREASE_CONTRAST_ATTRIBUTE, preferences.increaseContrast);
  // Always set, so apps that took a larger size from the theme's tokens take
  // the normal one back.
  root.style.setProperty(TEXT_SCALE_PROPERTY, String(clampTextSize(preferences.textSize) / 100));
  root.style.setProperty(GLASS_MATERIAL_PROPERTY, preferences.reduceTransparency || preferences.increaseContrast ? 'solid' : preferences.glass);
}
