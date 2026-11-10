import { ArrowDownUp, FilePlus, FolderOpen, FolderPlus, Grid2x2, LayoutGrid, Monitor, Palette, Plus, Sparkles, Wallpaper } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useDesktopBackground } from '@/contexts/DesktopBackgroundContext';
import { useDesktopIcons } from '@/contexts/DesktopIconsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useToast } from '@/hooks/useToast';
import { DESKTOP_ICON_SORTS } from '@/lib/desktopIcons';
import { cleanFsError } from '@/lib/fs';
import { useWallpaper } from './icons/wallpaper';

/**
 * The desktop's right-click menu, on a layer covering the bare wallpaper
 * beneath the windows (which have menus of their own). The layer is also
 * where desktop icons are selected by dragging a box and dropped.
 */
export function DesktopMenu() {
  const { chooseBackground } = useDesktopBackground();
  const { open } = useWindowActions();
  const { widgets, editing, setEditing, setGalleryOpen } = useWidgets();
  const { config, updateConfig } = useAppContext();
  const icons = useDesktopIcons();
  const wallpaper = useWallpaper();
  const { toast } = useToast();
  const fail = (title: string) => (error: unknown) => toast({ title, description: cleanFsError(error), variant: 'destructive' });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div aria-hidden className="absolute inset-0 select-none" {...wallpaper} />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {icons.dir && (
          <>
            <ContextMenuItem onSelect={() => void icons.newFolder().catch(fail('Couldn’t make a folder'))}>
              <FolderPlus aria-hidden /> New Folder
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void icons.newTextFile().catch(fail('Couldn’t make a file'))}>
              <FilePlus aria-hidden /> New Text File
            </ContextMenuItem>
            {icons.shown && icons.icons.length > 0 && (
              <>
                <ContextMenuSub>
                  <ContextMenuSubTrigger className="gap-2">
                    <ArrowDownUp aria-hidden /> Sort By
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-44">
                    {DESKTOP_ICON_SORTS.map((sort) => (
                      <ContextMenuItem key={sort.value} onSelect={() => icons.arrange(sort.value)}>
                        {sort.name}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem onSelect={() => icons.arrange()}>
                  <Sparkles aria-hidden /> Clean Up
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onSelect={() => icons.showInFiles()}>
              <FolderOpen aria-hidden /> Show Desktop in Files
            </ContextMenuItem>
            <ContextMenuCheckboxItem
              checked={config.desktopIcons}
              onCheckedChange={(checked) => updateConfig((current) => ({ ...current, desktopIcons: checked }))}
            >
              Show Desktop Icons
            </ContextMenuCheckboxItem>
            <ContextMenuSeparator />
          </>
        )}
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
        <ContextMenuItem onSelect={() => open('settings', { section: 'desktop' })}>
          <Grid2x2 aria-hidden /> Desktop Settings…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => open('settings', { section: 'display' })}>
          <Monitor aria-hidden /> Display Settings…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
