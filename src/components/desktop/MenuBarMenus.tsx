import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useMenuBarSlot } from '@/lib/menuBarSlot';

/**
 * An app's menus (File, View, ...), shown in the menu bar beside its name
 * while its window is the focused one. Rendered through a portal, so the
 * menus keep the app's own context.
 */
export function MenuBarMenus({ children }: { children: ReactNode }) {
  const slot = useMenuBarSlot();
  const isTop = useWindowIsTop();
  if (!slot || !isTop) return null;
  return createPortal(children, slot);
}
