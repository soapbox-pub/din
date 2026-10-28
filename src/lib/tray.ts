/**
 * Typed access to the tray bridge exposed by the Electron preload
 * (`window.dinos.tray`, see electron/preload.cjs + electron/tray.mts).
 *
 * Apps that live in a system tray (chat and sync clients, Steam) publish a
 * StatusNotifierItem on the session bus; Din hosts them, and the menu bar
 * shows their icons and menus. Absent outside the Electron shell.
 */

/** An app's status icon. */
export interface TrayItem {
  /** Opaque id, stable for the item's life. */
  id: string;
  /** The installed app it belongs to, when known. */
  appId: string | null;
  title: string;
  tooltip: string;
  /** Passive items are hidden until they have something to say. */
  status: 'Passive' | 'Active' | 'NeedsAttention';
  /** Data URL, or null when the item has no icon Din can show. */
  icon: string | null;
  /** The item has a menu Din can draw. */
  menu: boolean;
  /** A click opens the menu rather than activating the app. */
  itemIsMenu: boolean;
}

/** One entry of an item's menu. */
export interface TrayMenuEntry {
  id: number;
  type: 'standard' | 'separator';
  label: string;
  enabled: boolean;
  toggle: 'checkmark' | 'radio' | null;
  checked: boolean;
  /** Data URL, or null. */
  icon: string | null;
  /** A submenu, when not empty. */
  children: TrayMenuEntry[];
}

export interface TrayBridge {
  list(): Promise<TrayItem[]>;
  /** Primary click; false when the app didn't take it. */
  activate(id: string, x: number, y: number): Promise<boolean>;
  /** Middle click. */
  secondaryActivate(id: string, x: number, y: number): Promise<boolean>;
  /** Ask the app to show its own menu (for items without one Din can draw). */
  contextMenu(id: string, x: number, y: number): Promise<boolean>;
  scroll(id: string, delta: number, orientation: 'vertical' | 'horizontal'): Promise<boolean>;
  /** The item's menu, read fresh; null when it has none. */
  menu(id: string): Promise<TrayMenuEntry[] | null>;
  menuEvent(id: string, entryId: number): Promise<void>;
  onChanged(callback: (items: TrayItem[]) => void): () => void;
  /** An item's menu changed (its id). */
  onMenuChanged(callback: (id: string) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    tray?: TrayBridge;
  }
}

/** The tray bridge, or undefined outside the Electron shell. */
export function getTrayBridge(): TrayBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.tray;
}
