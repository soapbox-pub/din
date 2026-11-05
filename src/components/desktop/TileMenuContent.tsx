import { Maximize2, Minimize2, Minus, Pin, PinOff, Plus, SquareArrowOutUpRight, Trash2, X } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { AddToDesktopItem } from '@/components/desktop/icons/AddToDesktopItem';
import type { MenuAboveContentProps } from '@/hooks/useMenuAbove';
import type { AppDefinition } from '@/lib/apps';
import type { DockControls, DockWindow } from '@/lib/dockTileActions';
import { cn } from '@/lib/utils';

/**
 * A Dock or taskbar tile's right-click menu: its app's windows by what
 * they're showing, the app's own actions, a new window, pin or unpin, add to
 * the desktop, close, and uninstall. `bar` names the bar in the pin item ("Keep in Dock").
 * Given `taskWindow`, it's the menu of that one window's taskbar button, which
 * leads with what can be done to the window and closes it alone.
 */
export function TileMenuContent({
  app,
  appWindows,
  activeWindowId,
  controls,
  isPinned,
  bar,
  onTogglePin,
  onUninstall,
  taskWindow,
  above,
}: {
  app: AppDefinition;
  appWindows: DockWindow[];
  activeWindowId: string | null;
  controls: DockControls;
  isPinned: boolean;
  bar: 'dock' | 'taskbar';
  onTogglePin: (appId: string) => void;
  /** Present only for apps that can be uninstalled. */
  onUninstall?: (appId: string) => void;
  taskWindow?: {
    id: string;
    minimized: boolean;
    maximized: boolean;
    toggleMaximize: (id: string) => void;
    close: (id: string) => void;
  };
  /** Opens the menu above its tile (`useMenuAbove`). */
  above?: MenuAboveContentProps;
}) {
  const { open, focus, minimize, closeAll } = controls;
  return (
    <ContextMenuContent className="z-[10000] w-52" {...above}>
      {taskWindow && (
        <>
          {taskWindow.minimized ? (
            <ContextMenuItem onSelect={() => focus(taskWindow.id)}>
              <SquareArrowOutUpRight aria-hidden /> Restore
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => minimize(taskWindow.id)}>
              <Minus aria-hidden /> Minimize
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => {
              taskWindow.toggleMaximize(taskWindow.id);
              focus(taskWindow.id);
            }}
          >
            {taskWindow.maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}{' '}
            {taskWindow.maximized ? 'Restore down' : 'Maximize'}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {/* Every window by what it's showing, to jump straight to one rather
          than cycling there. */}
      {!taskWindow && appWindows.length > 1 && (
        <>
          {appWindows.map((w, i) => (
            <ContextMenuItem
              key={w.id}
              inset
              onSelect={() => focus(w.id)}
              className={cn(w.id === activeWindowId && 'font-semibold', w.minimized && 'text-muted-foreground')}
            >
              <span className="truncate">{w.title ?? `${app.name} ${i + 1}`}</span>
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
        </>
      )}
      {app.actions && app.actions.length > 0 && (
        <>
          {app.actions.map((action) => (
            <ContextMenuItem key={action.label} inset onSelect={() => open(app.id, { ...action.params, actionAt: Date.now() })}>
              {action.label}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
        </>
      )}
      {!app.singleInstance && (
        <ContextMenuItem onSelect={() => open(app.id)}>
          {/* Native apps decide for themselves whether a second launch opens
              another window or just raises the running one. */}
          <Plus aria-hidden /> {app.native ? 'New instance' : 'New window'}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onTogglePin(app.id)}>
        {isPinned ? (
          <>
            <PinOff aria-hidden /> {bar === 'dock' ? 'Remove from Dock' : 'Unpin from taskbar'}
          </>
        ) : (
          <>
            <Pin aria-hidden /> {bar === 'dock' ? 'Keep in Dock' : 'Pin to taskbar'}
          </>
        )}
      </ContextMenuItem>
      <AddToDesktopItem appId={app.id} />
      {taskWindow ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => taskWindow.close(taskWindow.id)}>
            <X aria-hidden /> Close window
          </ContextMenuItem>
        </>
      ) : appWindows.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => closeAll(app.id, appWindows)}>
            <X aria-hidden />{' '}
            {appWindows.length > 1 ? 'Close all windows' : 'Close window'}
          </ContextMenuItem>
        </>
      )}
      {onUninstall && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => onUninstall(app.id)}>
            <Trash2 aria-hidden /> Uninstall
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
