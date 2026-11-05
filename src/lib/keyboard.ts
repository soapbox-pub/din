/**
 * Typed access to the keyboard layout bridge exposed by the Electron preload
 * (`window.dinos.keyboard`, see electron/preload.cjs + electron/keyboard.mts).
 *
 * The layouts here are the system's: Din's own windows and the native Linux
 * apps it runs both type with them. Din can change them on DinOS and on
 * GNOME, and switch between them on DinOS; elsewhere they're only shown. In
 * a plain browser the bridge is absent.
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
  /** The layout typing now. */
  layout: KeyboardLayout;
  /** The system's layouts, in order: the first is the one it starts with. */
  layouts: KeyboardLayout[];
  /** Which of `layouts` is typing. */
  active: number;
  /** Whether Din can change the system's layouts here. */
  canChange: boolean;
  /** Whether Din switches between them here (din-shell, with more than one). */
  canSwitch: boolean;
  /** The layout changed, and Din's own windows switch after a restart. */
  restartNeeded: boolean;
}

export interface KeyboardBridge {
  status(): Promise<KeyboardStatus>;
  /** Every layout and variant installed, sorted by name. */
  layouts(): Promise<KeyboardLayout[]>;
  /** Make a layout the system's only one. */
  set(choice: KeyboardLayoutChoice): Promise<void>;
  /** Make these the system's layouts: one to MAX_KEYBOARD_LAYOUTS, the first the default. */
  setLayouts(choices: KeyboardLayoutChoice[]): Promise<void>;
  /** Type with the system's layout at this index. */
  select(index: number): Promise<void>;
  /** Hear of every change to the layouts or the one typing. Returns an unsubscribe fn. */
  onChanged(callback: (status: KeyboardStatus) => void): () => void;
  /** Restart Din, so its own windows take a changed layout (DinOS). */
  restart(): Promise<void>;
}

/** The most layouts a keyboard can have at once (XKB's groups). */
export const MAX_KEYBOARD_LAYOUTS = 4;

/** The keys that switch layouts, as a Mac's: back to the last one, and on to the next. */
export const LAYOUT_SWITCH_KEYS = { previous: 'Ctrl+Space', next: 'Ctrl+Alt+Space' } as const;

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

/**
 * A short tag for a layout, for the menu bar: its XKB name, as a Mac shows
 * an input source's abbreviation ("US", "DE"). Where two of the layouts
 * are the same one's variants, a variant's first letters follow ("US·CO"
 * for Colemak), so they differ.
 */
export function layoutTag(choice: KeyboardLayoutChoice, layouts: KeyboardLayoutChoice[] = []): string {
  const base = choice.layout.slice(0, 3).toUpperCase();
  const shared = layouts.filter((other) => other.layout === choice.layout).length > 1;
  return shared && choice.variant ? `${base}·${choice.variant.slice(0, 2).toUpperCase()}` : base;
}

/** Just the layout and variant, as the bridge takes them. */
function choiceOf(choice: KeyboardLayoutChoice): KeyboardLayoutChoice {
  return { layout: choice.layout, variant: choice.variant };
}

/** LAYOUTS with CHOICE added at the end, or null when it's there or there's no room. */
export function withLayoutAdded(
  layouts: KeyboardLayoutChoice[],
  choice: KeyboardLayoutChoice,
): KeyboardLayoutChoice[] | null {
  if (layouts.some((other) => layoutKey(other) === layoutKey(choice))) return null;
  if (layouts.length >= MAX_KEYBOARD_LAYOUTS) return null;
  return [...layouts.map(choiceOf), choiceOf(choice)];
}

/** LAYOUTS without the one at INDEX, or null when it's the last one. */
export function withLayoutRemoved(layouts: KeyboardLayoutChoice[], index: number): KeyboardLayoutChoice[] | null {
  if (layouts.length <= 1 || !layouts[index]) return null;
  return layouts.filter((_, i) => i !== index).map(choiceOf);
}

/** LAYOUTS with the one at INDEX moved BY places, or null when it can't go there. */
export function withLayoutMoved(layouts: KeyboardLayoutChoice[], index: number, by: number): KeyboardLayoutChoice[] | null {
  const to = index + by;
  if (!layouts[index] || to < 0 || to >= layouts.length) return null;
  const next = layouts.map(choiceOf);
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}
