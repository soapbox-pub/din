import type { ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useAppContext } from '@/hooks/useAppContext';
import { homeArea, inDirection, WORKSPACE_COUNT, type WindowState } from '@/hooks/useWindows';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useMonitors, useWorkAreas } from '@/contexts/MonitorsContext';
import type { Direction } from '@/lib/wmBindings';

const DIRECTIONS: { dir: Direction; arrow: string }[] = [
  { dir: 'left', arrow: '←' },
  { dir: 'right', arrow: '→' },
  { dir: 'up', arrow: '↑' },
  { dir: 'down', arrow: '↓' },
];

/**
 * A window title bar's right-click menu: minimize, maximize or restore, tile
 * to a half, float or tile (while tiling is on), move to another workspace or
 * display, and close. `children` is the title bar itself. The title bar's
 * minimize and maximize buttons pass their handlers in, so both stop the
 * window wobbling the same way.
 */
export function WindowContextMenu({
  win,
  onMinimize,
  onToggleMaximize,
  children,
}: {
  win: WindowState;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <WindowMenuItems win={win} onMinimize={onMinimize} onToggleMaximize={onToggleMaximize} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The menu's items: mounted only while it's open, so the hooks cost nothing otherwise. */
function WindowMenuItems({
  win,
  onMinimize,
  onToggleMaximize,
}: {
  win: WindowState;
  onMinimize: () => void;
  onToggleMaximize: () => void;
}) {
  const { close, tile, unmaximize, moveToWorkspace, moveToMonitor, toggleFloating } = useWindowActions();
  const { config } = useAppContext();
  const areas = useWorkAreas();
  const { monitors } = useMonitors();

  const from = homeArea(areas, win);
  const others = from
    ? areas.filter((a) => a.id !== from.id).map((a) => ({ item: a, rect: a.bounds }))
    : [];
  // moveToMonitor goes by direction; a monitor off at a diagonal can be the
  // one two directions lead to, so it's listed once.
  const neighbors = from
    ? DIRECTIONS.flatMap(({ dir, arrow }) => {
        const area = inDirection(from.bounds, dir, others);
        return area ? [{ dir, arrow, area }] : [];
      }).filter((n, i, all) => all.findIndex((m) => m.area.id === n.area.id) === i)
    : [];

  return (
    <>
      <ContextMenuItem onSelect={onMinimize}>
        <Minus />
        Minimize
      </ContextMenuItem>
      {win.maximized ? (
        <ContextMenuItem onSelect={onToggleMaximize}>
          <Minimize2 />
          Restore
        </ContextMenuItem>
      ) : (
        <>
          <ContextMenuItem onSelect={onToggleMaximize}>
            <Maximize2 />
            Maximize
          </ContextMenuItem>
          {win.snapped && (
            <ContextMenuItem
              onSelect={() =>
                unmaximize(win.id, win.restore ?? { x: win.x, y: win.y, width: win.width, height: win.height })
              }
            >
              <Minimize2 />
              Restore
            </ContextMenuItem>
          )}
        </>
      )}
      {!win.tiled && (
        <>
          <ContextMenuItem disabled={win.snapped === 'left'} onSelect={() => tile(win.id, 'left')}>
            Tile left
          </ContextMenuItem>
          <ContextMenuItem disabled={win.snapped === 'right'} onSelect={() => tile(win.id, 'right')}>
            Tile right
          </ContextMenuItem>
        </>
      )}
      {config.tilingEnabled && (
        <ContextMenuCheckboxItem checked={!win.tiled} onCheckedChange={() => toggleFloating(win.id)}>
          Floating
        </ContextMenuCheckboxItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Move to workspace</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuRadioGroup
            value={String(win.workspace)}
            onValueChange={(n) => moveToWorkspace(win.id, Number(n), false)}
          >
            {Array.from({ length: WORKSPACE_COUNT }, (_, i) => i + 1).map((n) => (
              <ContextMenuRadioItem key={n} value={String(n)}>
                Workspace {n}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {neighbors.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to display</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {neighbors.map(({ dir, arrow, area }) => (
              <ContextMenuItem key={dir} onSelect={() => moveToMonitor(win.id, dir)}>
                <span className="truncate">{monitors.find((m) => m.id === area.id)?.name ?? 'Display'}</span>
                <ContextMenuShortcut>{arrow}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => close(win.id)}>
        <X />
        Close
      </ContextMenuItem>
    </>
  );
}
