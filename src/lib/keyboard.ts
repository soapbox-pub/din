/**
 * Typed access to the keyboard layout bridge exposed by the Electron preload
 * (`window.dinos.keyboard`, see electron/preload.cjs + electron/keyboard.mts).
 *
 * The layout here is the system's: Din's own windows and the native Linux
 * apps it runs both type with it. Din can change it on DinOS and on GNOME;
 * elsewhere it's only shown. In a plain browser the bridge is absent.
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
  /** The system's layout (its first, if it has several). */
  layout: KeyboardLayout;
  /** Whether Din can change the system's layout here. */
  canChange: boolean;
  /** DinOS: the layout changed, and Din's own windows switch after a restart. */
  restartNeeded: boolean;
}

export interface KeyboardBridge {
  status(): Promise<KeyboardStatus>;
  /** Every layout and variant installed, sorted by name. */
  layouts(): Promise<KeyboardLayout[]>;
  /** Make a layout the system's. */
  set(choice: KeyboardLayoutChoice): Promise<void>;
  /** Restart Din, so its own windows take a changed layout (DinOS). */
  restart(): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    keyboard?: KeyboardBridge;
  }
}

/** The keyboard bridge, or undefined when running outside the Electron shell. */
export function getKeyboardBridge(): KeyboardBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.keyboard;
}

/** Stable key for a layout choice. */
export function layoutKey(choice: KeyboardLayoutChoice): string {
  return `${choice.layout}:${choice.variant}`;
}
