import { useEffect, useRef, useState } from 'react';
import { PointMenu } from '@/components/desktop/dinHost/DataMenus';
import { useAppContext } from '@/hooks/useAppContext';
import { getMenusBridge, type ShownMenu } from '@/lib/menus';
import { findGuest } from '@/platform/guest';

interface OpenMenu extends ShownMenu {
  at: { x: number; y: number };
  /** What was right-clicked, to have focus back before the chosen item runs. */
  returnTo: HTMLElement | null;
}

/**
 * Draws the right-click menus main builds for web pages and for text fields
 * in apps, widgets and the desktop (src/lib/menus.ts), as Din's own menus
 * where the page was right-clicked, instead of native ones that look
 * nothing like them.
 *
 * The menu takes the desktop's focus while it's open, and what acts on a
 * text field (a spelling suggestion, Paste, Select All) acts on whatever
 * has focus when main runs it. So a chosen item goes to main only once the
 * menu is gone and focus is back in the page or field it was opened on;
 * main can't give a guest focus back itself.
 */
export function MenuHost() {
  const { config } = useAppContext();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  /** The newest menu shown, until it has closed. */
  const latest = useRef<number | null>(null);
  /** The item chosen, sent once the menu has closed. */
  const picked = useRef<{ token: number; id: string } | null>(null);

  useEffect(() => {
    const bridge = getMenusBridge();
    if (!bridge) return;
    return bridge.onShow((shown) => {
      // Main has the point in the desktop window's DIPs, a page's included;
      // the shell frame is scaled by the interface zoom.
      const zoom = config.zoomLevel / 100;
      const at = { x: shown.x / zoom, y: shown.y / zoom };
      const active = document.activeElement;
      const returnTo =
        shown.guest !== null ? findGuest(shown.guest) : active instanceof HTMLElement && active !== document.body ? active : null;
      if (latest.current !== null) bridge.close(latest.current);
      latest.current = shown.token;
      setMenu({ ...shown, at, returnTo });
    });
  }, [config.zoomLevel]);

  if (!menu) return null;
  const bridge = getMenusBridge();
  return (
    <PointMenu
      key={menu.token}
      at={menu.at}
      items={menu.items}
      onAction={(id) => {
        picked.current = { token: menu.token, id };
      }}
      onClose={() => {
        setMenu((current) => (current?.token === menu.token ? null : current));
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const choice = picked.current?.token === menu.token ? picked.current : null;
        if (choice) picked.current = null;
        // A newer menu is up: focus stays with it, and main has dropped this one.
        if (latest.current !== menu.token) return;
        latest.current = null;
        if (menu.returnTo?.isConnected) menu.returnTo.focus();
        if (choice) bridge?.pick(menu.token, choice.id);
        else bridge?.close(menu.token);
      }}
    />
  );
}
