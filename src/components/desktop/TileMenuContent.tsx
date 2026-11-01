import { Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import type { AppDefinition } from '@/lib/apps';
import type { DockControls, DockWindow } from '@/lib/dockTileActions';
import { cn } from '@/lib/utils';

/**
 * A Dock or taskbar tile's right-click menu: its app's windows by what
 * they're showing, the app's own actions, a new window, pin or unpin, close,
 * and uninstall. `bar` names the bar in the pin item ("Keep in Dock").
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
}) {
  const { open, focus, closeAll } = controls;
  return (
    <ContextMenuContent className="z-[10000] w-52">
      {/* Every window by what it's showing, to jump straight to one rather
          than cycling there. */}
      {appWindows.length > 1 && (
        <>
          {appWindows.map((w, i) => (
            <ContextMenuItem
              key={w.id}
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
            <ContextMenuItem key={action.label} onSelect={() => open(app.id, { ...action.params, actionAt: Date.now() })}>
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
      {appWindows.length > 0 && (
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
