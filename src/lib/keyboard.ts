/**
 * Typed access to the keyboard layout bridge exposed by the Electron preload
 * (`window.keyboard`, see electron/preload.cjs + electron/keyboard.mts).
 *
 * The layout here is the one native Linux apps type with: Din sends them
 * physical keys, and their display servers apply this keymap. It follows the
 * OS's layout unless the user picks another. Din's own windows get their
 * characters from the system Din runs on, so they aren't affected. In a plain
 * browser the bridge is absent.
 */

export interface KeyboardLayoutChoice {
  /** XKB layout, e.g. "us". */
  layout: string;
  /** XKB variant, e.g. "colemak"; '' for the layout's default. */
  variant: string;
}

export interface KeyboardLayout extends KeyboardLayoutChoice {
  /** Human-readable name, e.g. "English (Colemak)". */
  name: string;
}

export interface KeyboardStatus {
  /** The OS's layout (its first, if it has several). */
  system: KeyboardLayout;
  /** The layout picked in Settings, or null to follow the OS. */
  selected: KeyboardLayoutChoice | null;
}

export interface KeyboardBridge {
  status(): Promise<KeyboardStatus>;
  /** Every layout and variant installed, sorted by name. */
  layouts(): Promise<KeyboardLayout[]>;
  /** Use a layout for native apps, or null to follow the OS. */
  set(choice: KeyboardLayoutChoice | null): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    keyboard?: KeyboardBridge;
  }
}

/** The keyboard bridge, or undefined when running outside the Electron shell. */
export function getKeyboardBridge(): KeyboardBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.keyboard;
}

/** Stable key for a layout choice. */
export function layoutKey(choice: KeyboardLayoutChoice): string {
  return `${choice.layout}:${choice.variant}`;
}
