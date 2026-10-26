import { Monitor, Palette, Wallpaper } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useDesktopBackground } from '@/contexts/DesktopBackgroundContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/**
 * The desktop's right-click menu, on a layer covering the bare wallpaper
 * beneath the windows (which have menus of their own).
 */
export function DesktopMenu() {
  const { chooseBackground } = useDesktopBackground();
  const { open } = useWindowActions();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div aria-hidden className="absolute inset-0" />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => void chooseBackground()}>
          <Wallpaper aria-hidden /> Change Background…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => open('settings', { section: 'appearance' })}>
          <Palette aria-hidden /> Customize…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => open('settings', { section: 'display' })}>
          <Monitor aria-hidden /> Display Settings…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
