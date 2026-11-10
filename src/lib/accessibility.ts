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

// How each colour blindness sees (Machado, Oliveira and Fernandes, 2009),
// and where what it loses is moved to: din-shell's, so Settings can picture
// a filter as the screen will show it.
const PROTANOPIA = [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998];
const DEUTERANOPIA = [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881];
const TRITANOPIA = [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900];
const RED_GREEN_SHIFT = [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1];
const BLUE_YELLOW_SHIFT = [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function daltonize(simulated: number[], shift: number[]): number[] {
  const lost = IDENTITY.map((value, i) => value - simulated[i]);
  return IDENTITY.map((value, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    return value + [0, 1, 2].reduce((sum, k) => sum + shift[row * 3 + k] * lost[k * 3 + col], 0);
  });
}

/**
 * The colour matrix FILTER is, row by row for RGB (din-shell's
 * accessibility.rs), or undefined for none and invert, which aren't matrices.
 */
export function colorFilterMatrix(filter: ColorFilter): number[] | undefined {
  switch (filter) {
    case 'grayscale': {
      const luma = [0.2126, 0.7152, 0.0722];
      return [...luma, ...luma, ...luma];
    }
    case 'protanopia': return daltonize(PROTANOPIA, RED_GREEN_SHIFT);
    case 'deuteranopia': return daltonize(DEUTERANOPIA, RED_GREEN_SHIFT);
    case 'tritanopia': return daltonize(TRITANOPIA, BLUE_YELLOW_SHIFT);
    default: return undefined;
  }
}

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
