/**
 * Typed access to the icon theme bridge exposed by the Electron preload
 * (`window.dinos.iconTheme`, see electron/preload.cjs + electron/icon-theme.mts).
 *
 * The icon theme is the system's (a freedesktop icon theme, named in
 * GSettings): native apps take their icons from it, and Din's own apps and
 * file types follow it too, unless it's the "Din" theme, Din's own look.
 * Din can change it on DinOS and GSettings desktops like GNOME; on others
 * (KDE) it's only shown. In a plain browser the bridge is absent.
 */

import type { PublishedThemeInstall } from '@/lib/systemCursor';

export interface IconThemeInfo {
  /** Directory name, e.g. "Papirus-Dark". */
  id: string;
  /** Human-readable name, e.g. "Papirus Dark". */
  name: string;
  /** A few of its icons as data URLs; empty for the Din theme. */
  preview: string[];
  /** Listed only because it's the system's theme; it has too few app icons to restyle Din's apps. */
  limited: boolean;
  /** Whether Din installed it, and so can remove it. */
  imported: boolean;
}

/** A theme as it's published (src/lib/themePackages.ts). */
export interface IconThemeExport {
  id: string;
  name: string;
  inherits: string[];
  /** Its directory as a .tar.gz. */
  archive: Uint8Array;
  /** A few of its icons, for the store to show. */
  previews: { name: string; mime: string; data: Uint8Array }[];
}

/** What Din needs to install a published icon theme. */
export interface IconThemeManifest {
  identifier: string;
  name: string;
  coordinate: string;
  publishedAt: number;
  inherits: string[];
  servers: string[];
  archive: { sha256: string };
}

export interface IconThemeStatus {
  /** The current theme's id. */
  theme: string;
  /** Whether Din shows its own icons (the Din theme). */
  din: boolean;
  /** Whether Din can change the theme here. */
  canChange: boolean;
  /** Whether a change is the desktop's too (GNOME and the like), Din not being the desktop. */
  shared: boolean;
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
  /** A theme's archive and preview icons, for publishing it. */
  exportTheme(id: string): Promise<IconThemeExport>;
  /** The themes installed from Nostr. */
  published(): Promise<PublishedThemeInstall[]>;
  /** Download and install (or update) a published theme; `missing` are parents it names that aren't installed. */
  installPublished(manifest: IconThemeManifest): Promise<{ id: string; missing: string[] }>;
  /** Delete a theme Din installed. */
  removeTheme(id: string): Promise<void>;
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

/** App icons asked for beyond Din's own (installed nsites' and websites'), by name. */
const extraRequests = new Map<string, IconRequest>();
const requestListeners = new Set<() => void>();

/** Look these app icons up in the icon theme too, from now on (IconThemeSync does). */
export function requestThemeIcons(names: string[]): void {
  let added = false;
  for (const name of names) {
    if (extraRequests.has(name)) continue;
    extraRequests.set(name, { names: [name], kind: 'apps' });
    added = true;
  }
  if (added) for (const listener of requestListeners) listener();
}

export function extraThemeIconRequests(): IconRequest[] {
  return [...extraRequests.values()];
}

/** Hear when more icons are asked for. */
export function onThemeIconRequest(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
}
