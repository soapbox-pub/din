import { LayoutGrid, Monitor, Palette, Plus, Wallpaper } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useDesktopBackground } from '@/contexts/DesktopBackgroundContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWidgets } from '@/contexts/WidgetsContext';

/**
 * The desktop's right-click menu, on a layer covering the bare wallpaper
 * beneath the windows (which have menus of their own).
 */
export function DesktopMenu() {
  const { chooseBackground } = useDesktopBackground();
  const { open } = useWindowActions();
  const { widgets, editing, setEditing, setGalleryOpen } = useWidgets();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div aria-hidden className="absolute inset-0" />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => void chooseBackground()}>
          <Wallpaper aria-hidden /> Change Background…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => open('settings', { section: 'themes' })}>
          <Palette aria-hidden /> Customize…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setGalleryOpen(true)}>
          <Plus aria-hidden /> Add Widgets…
        </ContextMenuItem>
        {widgets.length > 0 && (
          <ContextMenuItem onSelect={() => setEditing(!editing)}>
            <LayoutGrid aria-hidden /> {editing ? 'Done Editing Widgets' : 'Edit Widgets'}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => open('settings', { section: 'display' })}>
          <Monitor aria-hidden /> Display Settings…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
