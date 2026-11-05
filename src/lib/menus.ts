import type { MenuItem } from '@/sdk/din';

/**
 * Typed access to the menus bridge exposed by the Electron preload
 * (`window.dinos.menus`, see electron/preload.cjs + electron/menus.mts):
 * right-click menus of web pages and of text fields in apps, widgets and
 * the desktop, which main builds and the desktop draws as its own.
 * Absent outside the Electron shell.
 */

/** A menu to draw, for the page right-clicked. */
export interface ShownMenu {
  /** Names the menu when an item is chosen or it closes. */
  token: number;
  /** Where it was right-clicked, in the desktop window's DIPs (a page's too). */
  x: number;
  y: number;
  items: MenuItem[];
}

export interface MenusBridge {
  onShow(callback: (menu: ShownMenu) => void): () => void;
  pick(token: number, id: string): void;
  close(token: number): void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    menus?: MenusBridge;
  }
}

/** The menus bridge, or undefined outside the Electron shell. */
export function getMenusBridge(): MenusBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.menus;
}
