/**
 * Typed access to the OS brightness bridge exposed by the Electron preload
 * (`window.dinos.brightness`, see electron/preload.cjs + electron/main.cjs).
 *
 * Covers two independent display-light controls:
 *   - Screen backlight (/sys/class/backlight), via brightnessctl where
 *     installed, else raw sysfs reads + systemd-logind writes.
 *   - Night light / red shift (warm color temperature), via a Wayland/X11
 *     gamma tool (gammastep, or wlsunset as a fallback) held running in the
 *     main process.
 *
 * Either half degrades independently: a desktop with no backlight but a
 * working gamma tool still gets the night-light toggle, and vice versa. In a
 * plain browser the bridge is missing entirely. Callers must feature-detect
 * and render nothing / a fallback when a half is `available: false`.
 */

/** When night light runs: all the time, sunset to sunrise, or custom hours. */
export type NightLightSchedule = 'always' | 'sunset' | 'custom';

/** Night-light (red shift) state. `available` reflects the gamma tool's presence. */
export interface NightLightState {
  /** False when no gamma tool (gammastep/wlsunset) is present. */
  available: boolean;
  /** Whether night light is on. On a schedule, it only tints in its hours. */
  enabled: boolean;
  /** Whether the warm tint is applied right now. */
  active: boolean;
  /** Color temperature in Kelvin (lower = warmer/redder). */
  temperature: number;
  schedule: NightLightSchedule;
  /** Custom hours, "HH:MM" local time; `to` may be past midnight. */
  from: string;
  to: string;
  /** When the schedule next turns the tint on or off (ms since the epoch), if it will. */
  nextChange: number | null;
  /** The time zone whose sunset is used, or null where it has no coordinates. */
  place: string | null;
}

export interface BrightnessStatus {
  /** False when no backlight device (or usable backend) is present. */
  available: boolean;
  /**
   * Level MIN_BRIGHTNESS-100, or null if it couldn't be read. 0-100 is the
   * backlight; below 0 the backlight is at its floor and the screen is dimmed
   * in software by that many percent.
   */
  brightness: number | null;
  nightLight: NightLightState;
}

export interface BrightnessBridge {
  /** Backlight level + night-light state. See per-field `available` flags. */
  status(): Promise<BrightnessStatus>;
  /** Set the level (MIN_BRIGHTNESS-100). Resolves to the new state. */
  setBrightness(percent: number): Promise<BrightnessStatus>;
  /** Turn night light on or off. Resolves to the new state. */
  setNightLight(enabled: boolean): Promise<BrightnessStatus>;
  /** Set the night-light color temperature in Kelvin. Resolves to the new state. */
  setTemperature(kelvin: number): Promise<BrightnessStatus>;
  /** Set when night light runs. Resolves to the new state. */
  setNightLightSchedule(schedule: {
    schedule: NightLightSchedule;
    from: string;
    to: string;
  }): Promise<BrightnessStatus>;
  /**
   * Subscribe to media-key brightness changes (for the OSD). The callback
   * receives the new state. Returns an unsubscribe fn.
   */
  onOsd(callback: (status: BrightnessStatus) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    brightness?: BrightnessBridge;
  }
}

/**
 * Dimmest brightness level. Below 0 a black layer covers the screen at that
 * many percent opacity. Keep in step with MIN_BRIGHTNESS in electron/main.mts.
 */
export const MIN_BRIGHTNESS = -80;

/** A brightness level for display, with a real minus sign below 0. */
export function brightnessText(level: number): string {
  return level < 0 ? `\u2212${-level}%` : `${level}%`;
}

/** Screen-reader text for a brightness level. */
export function brightnessValueText(level: number): string {
  return level < 0 ? `${-level}% dimmer than the lowest backlight` : `${level}%`;
}

/** Warmest useful night-light temperature (deep amber). */
export const MIN_TEMPERATURE = 2500;
/** Coolest night-light temperature (near-neutral daylight). */
export const MAX_TEMPERATURE = 6500;
/** Default night-light temperature — a gentle warm tint. */
export const DEFAULT_TEMPERATURE = 4500;

/**
 * What a scheduled night light is doing, e.g. "On until 7:04 AM" or "Off until
 * 6:31 PM"; null when it's off or always on.
 */
export function nightLightCaption(
  nightLight: NightLightState,
  timeOptions: Intl.DateTimeFormatOptions,
): string | null {
  if (!nightLight.enabled || nightLight.schedule === 'always') return null;
  const state = nightLight.active ? 'On' : 'Off';
  if (nightLight.nextChange === null) return nightLight.active ? 'On all day' : 'Off all day';
  return `${state} until ${new Date(nightLight.nextChange).toLocaleTimeString([], timeOptions)}`;
}

/** The brightness bridge, or undefined when running outside the Electron shell. */
export function getBrightnessBridge(): BrightnessBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.brightness;
}
