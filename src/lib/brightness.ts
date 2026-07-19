/**
 * Typed access to the OS brightness bridge exposed by the Electron preload
 * (`window.brightness`, see electron/preload.cjs + electron/main.cjs).
 *
 * Covers two independent display-light controls:
 *   - Screen backlight, via brightnessctl (/sys/class/backlight).
 *   - Night light / red shift (warm color temperature), via a Wayland/X11
 *     gamma tool (gammastep, or wlsunset as a fallback) held running in the
 *     main process.
 *
 * Either half degrades independently: a desktop with no backlight but a
 * working gamma tool still gets the night-light toggle, and vice versa. In a
 * plain browser the bridge is missing entirely. Callers must feature-detect
 * and render nothing / a fallback when a half is `available: false`.
 */

/** Night-light (red shift) state. `available` reflects the gamma tool's presence. */
export interface NightLightState {
  /** False when no gamma tool (gammastep/wlsunset) is present. */
  available: boolean;
  /** Whether the warm tint is currently applied. */
  enabled: boolean;
  /** Color temperature in Kelvin (lower = warmer/redder). */
  temperature: number;
}

export interface BrightnessStatus {
  /** False when brightnessctl or a backlight device is absent. */
  available: boolean;
  /** Backlight level 0-100, or null if it couldn't be read. */
  brightness: number | null;
  nightLight: NightLightState;
}

export interface BrightnessBridge {
  /** Backlight level + night-light state. See per-field `available` flags. */
  status(): Promise<BrightnessStatus>;
  /** Set the backlight level (0-100). Resolves to the new state. */
  setBrightness(percent: number): Promise<BrightnessStatus>;
  /** Turn the warm night-light tint on or off. Resolves to the new state. */
  setNightLight(enabled: boolean): Promise<BrightnessStatus>;
  /** Set the night-light color temperature in Kelvin. Resolves to the new state. */
  setTemperature(kelvin: number): Promise<BrightnessStatus>;
  /**
   * Subscribe to media-key brightness changes (for the OSD). The callback
   * receives the new state. Returns an unsubscribe fn.
   */
  onOsd(callback: (status: BrightnessStatus) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    brightness?: BrightnessBridge;
  }
}

/** Warmest useful night-light temperature (deep amber). */
export const MIN_TEMPERATURE = 2500;
/** Coolest night-light temperature (near-neutral daylight). */
export const MAX_TEMPERATURE = 6500;
/** Default night-light temperature — a gentle warm tint. */
export const DEFAULT_TEMPERATURE = 4500;

/** The brightness bridge, or undefined when running outside the Electron shell. */
export function getBrightnessBridge(): BrightnessBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.brightness;
}
