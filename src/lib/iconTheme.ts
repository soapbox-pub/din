/**
 * Typed access to the icon theme bridge exposed by the Electron preload
 * (`window.dinos.iconTheme`, see electron/preload.cjs + electron/icon-theme.mts).
 *
 * The icon theme is the system's (a freedesktop icon theme, named in
 * GSettings): native apps take their icons from it, and Din's own apps and
 * file types follow it too, unless it's the "Din" theme, Din's own look.
 * Din can change it on DinOS; elsewhere it's only shown, and Din keeps its
 * own icons. In a plain browser the bridge is absent.
 */

export interface IconThemeInfo {
  /** Directory name, e.g. "Papirus-Dark". */
  id: string;
  /** Human-readable name, e.g. "Papirus Dark". */
  name: string;
  /** A few of its icons as data URLs; empty for the Din theme. */
  preview: string[];
}

export interface IconThemeStatus {
  /** The current theme's id. */
  theme: string;
  /** Whether Din shows its own icons (the Din theme, or a desktop that isn't Din's). */
  din: boolean;
  /** Whether Din can change the theme here. */
  canChange: boolean;
}

/** Names to look an icon up by, best first, and what it's for. */
export interface IconRequest {
  names: string[];
  kind: 'apps' | 'files';
}

export interface IconThemeBridge {
  status(): Promise<IconThemeStatus>;
  themes(): Promise<IconThemeInfo[]>;
  /** The theme's icons as data URLs, keyed by each request's first name; missing ones are left out. */
  lookup(requests: IconRequest[]): Promise<Record<string, string>>;
  set(theme: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    iconTheme?: IconThemeBridge;
  }
}

/** The theme Din's own icons stand for (electron/icon-theme.mts). */
export const DIN_ICON_THEME = 'Din';

/** The icon theme bridge, or undefined when running outside the Electron shell. */
export function getIconThemeBridge(): IconThemeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.iconTheme;
}
