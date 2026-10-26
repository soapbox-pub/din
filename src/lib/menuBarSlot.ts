import { useSyncExternalStore } from 'react';

/**
 * Where the focused window's app menus go in the menu bar, after its name,
 * macOS style. The MenuBar registers the element; an app portals its menus
 * into it while its window is on top (see MenuBarMenus).
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setMenuBarSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  listeners.forEach((l) => l());
}

export function useMenuBarSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => slot,
  );
}

/** How an app menu's title looks in the menu bar. */
export const MENU_BAR_TRIGGER_CLASS =
  'h-7 rounded-md px-2.5 text-sm font-medium text-foreground/90 hover:bg-foreground/10 hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10';
