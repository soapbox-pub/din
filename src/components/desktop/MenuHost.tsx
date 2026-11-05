import { useEffect, useRef, useState } from 'react';
import { PointMenu } from '@/components/desktop/dinHost/DataMenus';
import { useAppContext } from '@/hooks/useAppContext';
import { getMenusBridge, type ShownMenu } from '@/lib/menus';

/**
 * Draws the right-click menus main builds for web pages and for text fields
 * in apps, widgets and the desktop (src/lib/menus.ts), as Din's own menus
 * where the page was right-clicked, instead of native ones that look
 * nothing like them.
 */
export function MenuHost() {
  const { config } = useAppContext();
  const [menu, setMenu] = useState<(ShownMenu & { at: { x: number; y: number } }) | null>(null);
  const open = useRef<number | null>(null);
  useEffect(() => {
    open.current = menu?.token ?? null;
  }, [menu]);

  useEffect(() => {
    const bridge = getMenusBridge();
    if (!bridge) return;
    return bridge.onShow((shown) => {
      // Main has the point in the desktop window's DIPs, a page's included;
      // the shell frame is scaled by the interface zoom.
      const zoom = config.zoomLevel / 100;
      const at = { x: shown.x / zoom, y: shown.y / zoom };
      if (open.current !== null) bridge.close(open.current);
      setMenu({ ...shown, at });
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
        bridge?.pick(menu.token, id);
        setMenu(null);
      }}
      onClose={() => {
        bridge?.close(menu.token);
        setMenu((current) => (current?.token === menu.token ? null : current));
      }}
    />
  );
}
