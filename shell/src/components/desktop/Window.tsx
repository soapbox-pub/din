import { memo, useCallback, useRef } from 'react';
import type { ComponentType } from 'react';
import { Maximize2, Minus, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApp } from '@/lib/apps';
import type { AppComponentProps } from '@/lib/apps';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { MIN_HEIGHT, MIN_WIDTH, type WindowState } from '@/hooks/useWindows';

/** Which edges/corner a resize drag is acting on. */
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The eight resize handles: edges + corners. */
const RESIZE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: 'top-0 inset-x-3 h-1.5 cursor-ns-resize' },
  { dir: 's', className: 'bottom-0 inset-x-3 h-1.5 cursor-ns-resize' },
  { dir: 'w', className: 'left-0 inset-y-3 w-1.5 cursor-ew-resize' },
  { dir: 'e', className: 'right-0 inset-y-3 w-1.5 cursor-ew-resize' },
  { dir: 'nw', className: 'top-0 left-0 size-3 cursor-nwse-resize' },
  { dir: 'ne', className: 'top-0 right-0 size-3 cursor-nesw-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 size-3 cursor-nesw-resize' },
  { dir: 'se', className: 'bottom-0 right-0 size-3 cursor-nwse-resize' },
];

/**
 * Memo boundary between window chrome and app content.
 *
 * Window geometry lives in one `windows` array, so dragging/resizing any
 * window re-renders every <Window> on each pointer move. Both props here are
 * stable per window instance, so memo() stops those re-renders from cascading
 * into app subtrees (which can be large, e.g. the Files entry list).
 */
const WindowContent = memo(function WindowContent({
  component: AppComponent,
  windowId,
}: {
  component: ComponentType<AppComponentProps>;
  windowId: string;
}) {
  return <AppComponent windowId={windowId} />;
});

/** A single draggable, resizable, focusable application window on the desktop. */
export function Window({ window: win, isTop }: { window: WindowState; isTop: boolean }) {
  const { close, minimize, focus, move, resize, toggleMaximize } = useWindowManager();
  const app = getApp(win.appId);
  const dragOrigin = useRef<{ px: number; py: number; wx: number; wy: number } | null>(null);
  const resizeOrigin = useRef<
    | {
        dir: ResizeDir;
        px: number;
        py: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | null
  >(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on the control buttons.
      if ((e.target as HTMLElement).closest('button')) return;
      focus(win.id);
      // Maximized windows are pinned; don't allow title-bar dragging.
      if (win.maximized) return;
      dragOrigin.current = { px: e.clientX, py: e.clientY, wx: win.x, wy: win.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [focus, win.id, win.x, win.y, win.maximized],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = dragOrigin.current;
      if (!origin) return;
      const nextX = origin.wx + (e.clientX - origin.px);
      const nextY = Math.max(0, origin.wy + (e.clientY - origin.py));
      move(win.id, nextX, nextY);
    },
    [move, win.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragOrigin.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const onResizePointerDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      e.stopPropagation();
      focus(win.id);
      resizeOrigin.current = {
        dir,
        px: e.clientX,
        py: e.clientY,
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [focus, win.id, win.x, win.y, win.width, win.height],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const o = resizeOrigin.current;
      if (!o) return;
      const dx = e.clientX - o.px;
      const dy = e.clientY - o.py;

      let { x, y, width, height } = o;

      if (o.dir.includes('e')) width = o.width + dx;
      if (o.dir.includes('s')) height = o.height + dy;
      if (o.dir.includes('w')) {
        // Clamp so the right edge stays fixed as width hits the minimum.
        const clampedDx = Math.min(dx, o.width - MIN_WIDTH);
        x = o.x + clampedDx;
        width = o.width - clampedDx;
      }
      if (o.dir.includes('n')) {
        const clampedDy = Math.min(dy, o.height - MIN_HEIGHT);
        y = Math.max(0, o.y + clampedDy);
        height = o.height - (y - o.y);
      }

      resize(win.id, { x, y, width, height });
    },
    [resize, win.id],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    resizeOrigin.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  if (!app || win.minimized) return null;

  const geometry: React.CSSProperties = win.maximized
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: win.z }
    : { left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z };

  return (
    <section
      aria-label={app.name}
      onPointerDown={() => focus(win.id)}
      style={geometry}
      className={cn(
        'absolute flex flex-col overflow-hidden border border-white/10 bg-neutral-900 shadow-2xl',
        'ring-1 ring-black/40 transition-shadow',
        win.maximized ? 'rounded-none' : 'rounded-xl',
        isTop && 'ring-white/20',
      )}
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => toggleMaximize(win.id)}
        className={cn(
          'flex h-9 shrink-0 touch-none select-none items-center gap-2 border-b border-white/10 bg-black/40 px-3',
          win.maximized ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        )}
      >
        <app.icon className="size-4 shrink-0 text-white/70" aria-hidden />
        <span className="flex-1 truncate text-sm font-medium text-white/90">
          {app.name}
        </span>
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => minimize(win.id)}
          className="grid size-6 place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={win.maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => toggleMaximize(win.id)}
          className="grid size-6 place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          {win.maximized ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close window"
          onClick={() => close(win.id)}
          className="grid size-6 place-items-center rounded-md text-white/70 hover:bg-red-500/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden bg-white">
        <WindowContent component={app.component} windowId={win.id} />
      </div>

      {!win.maximized &&
        RESIZE_HANDLES.map(({ dir, className }) => (
          <div
            key={dir}
            onPointerDown={onResizePointerDown(dir)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            className={cn('absolute z-10 touch-none', className)}
          />
        ))}
    </section>
  );
}
