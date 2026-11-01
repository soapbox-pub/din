import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useWindowMenuSlot } from '@/contexts/WindowMenuSlotContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useMenuBarSlot } from '@/lib/menuBarSlot';

/**
 * An app's menus (File, View, ...), shown in the menu bar beside its name
 * while its window is the focused one, or in the strip under its window's
 * title bar in the taskbar layout, which has no menu bar. Rendered through a
 * portal, so the menus keep the app's own context.
 */
export function MenuBarMenus({ children }: { children: ReactNode }) {
  const slot = useMenuBarSlot();
  const windowSlot = useWindowMenuSlot();
  const isTop = useWindowIsTop();
  const { config } = useAppContext();
  if (config.desktopLayout === 'taskbar') return windowSlot ? createPortal(children, windowSlot) : null;
  if (!slot || !isTop) return null;
  return createPortal(children, slot);
}
