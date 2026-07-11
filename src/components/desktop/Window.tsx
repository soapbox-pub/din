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
 * Drag/resize gestures bypass React entirely (see Window below), but geometry
 * commits, focus changes, and open/close still rebuild the `windows` array.
 * Both props here are stable per window instance, so memo() stops those
 * re-renders from cascading into app subtrees (which can be large, e.g. the
 * Files entry list).
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

/**
 * A single draggable, resizable, focusable application window on the desktop.
 *
 * Drag/resize performance: pointer moves NEVER go through React state. During
 * a drag the window follows the cursor via a `transform: translate3d()`
 * written straight onto the DOM node (compositor-only, no layout, no
 * re-render); during a resize, geometry styles are written directly. The new
 * geometry is committed to the window manager exactly once, on pointer-up.
 * Routing every pointermove through setState re-rendered the whole desktop
 * (all windows + taskbar) per mouse event, which felt sluggish - especially
 * under software rendering.
 */
export const Window = memo(function Window({
  window: win,
  isTop,
}: {
  window: WindowState;
  isTop: boolean;
}) {
  const { close, minimize, focus, move, resize, toggleMaximize } = useWindowManager();
  const app = getApp(win.appId);
  const sectionRef = useRef<HTMLElement>(null);
  // Drag state: pointer origin, window origin, and the latest position (so
  // pointer-up/cancel can commit without needing event coordinates).
  const dragState = useRef<{
    px: number;
    py: number;
    wx: number;
    wy: number;
    x: number;
    y: number;
  } | null>(null);
  const resizeState = useRef<{
    dir: ResizeDir;
    px: number;
    py: number;
    x: number;
    y: number;
    width: number;
    height: number;
    cur: { x: number; y: number; width: number; height: number };
  } | null>(null);

  /**
   * Put the window into "cheap to move" mode for the duration of a gesture.
   * backdrop-filter forces the compositor to re-sample everything behind the
   * window on every frame it moves - the single most expensive part of a drag,
   * catastrophic under software rendering. The card is 90% opaque, so dropping
   * the blur mid-gesture is nearly invisible.
   */
  const beginGesture = useCallback(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.style.willChange = 'transform';
    el.style.backdropFilter = 'none';
  }, []);

  const endGesture = useCallback(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.style.willChange = '';
    el.style.backdropFilter = '';
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on the control buttons.
      if ((e.target as HTMLElement).closest('button')) return;
      focus(win.id);
      // Maximized windows are pinned; don't allow title-bar dragging.
      if (win.maximized) return;
      dragState.current = {
        px: e.clientX,
        py: e.clientY,
        wx: win.x,
        wy: win.y,
        x: win.x,
        y: win.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      beginGesture();
    },
    [focus, win.id, win.x, win.y, win.maximized, beginGesture],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = dragState.current;
    const el = sectionRef.current;
    if (!s || !el) return;
    s.x = s.wx + (e.clientX - s.px);
    s.y = Math.max(0, s.wy + (e.clientY - s.py));
    // Compositor-only move; left/top stay untouched until pointer-up.
    el.style.transform = `translate3d(${s.x - s.wx}px, ${s.y - s.wy}px, 0)`;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const s = dragState.current;
      if (!s) return;
      dragState.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      const el = sectionRef.current;
      if (el) {
        // Swap the transform for real left/top in the same frame so the
        // window doesn't jump back while React commits the new geometry.
        el.style.transform = '';
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      }
      endGesture();
      move(win.id, s.x, s.y);
    },
    [move, win.id, endGesture],
  );

  const onResizePointerDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      e.stopPropagation();
      focus(win.id);
      resizeState.current = {
        dir,
        px: e.clientX,
        py: e.clientY,
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
        cur: { x: win.x, y: win.y, width: win.width, height: win.height },
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      beginGesture();
    },
    [focus, win.id, win.x, win.y, win.width, win.height, beginGesture],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const o = resizeState.current;
    const el = sectionRef.current;
    if (!o || !el) return;
    const dx = e.clientX - o.px;
    const dy = e.clientY - o.py;

    let { x, y, width, height } = o;

    if (o.dir.includes('e')) width = Math.max(MIN_WIDTH, o.width + dx);
    if (o.dir.includes('s')) height = Math.max(MIN_HEIGHT, o.height + dy);
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

    o.cur = { x, y, width, height };
    // Resizing inherently relayouts the window's own subtree, but writing
    // styles directly still avoids re-rendering the rest of the desktop.
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }, []);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const o = resizeState.current;
      if (!o) return;
      resizeState.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      endGesture();
      resize(win.id, o.cur);
    },
    [resize, win.id, endGesture],
  );

  if (!app) return null;

  const geometry: React.CSSProperties = win.maximized
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: win.z }
    : { left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z };

  // Minimized windows stay mounted but hidden so app state (terminal
  // sessions, browser pages, navigation history) survives restore.
  // `visibility: hidden` (not display:none / unmount) keeps layout intact,
  // which the Electron <webview> and xterm's fit logic both depend on.
  if (win.minimized) geometry.visibility = 'hidden';

  return (
    <section
      ref={sectionRef}
      aria-label={app.name}
      onPointerDown={() => focus(win.id)}
      style={geometry}
      className={cn(
        'absolute flex flex-col overflow-hidden border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl',
        'ring-1 ring-black/20 transition-shadow',
        win.maximized ? 'rounded-none' : 'rounded-xl',
        isTop && 'ring-ring/50',
      )}
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => toggleMaximize(win.id)}
        className={cn(
          'flex h-9 shrink-0 touch-none select-none items-center gap-2 border-b border-border/60 bg-background/60 px-3',
          win.maximized ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        )}
      >
        <app.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate text-sm font-medium text-foreground/90">
          {app.name}
        </span>
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => minimize(win.id)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={win.maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => toggleMaximize(win.id)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/80 hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden bg-background/80">
        <WindowContent component={app.component} windowId={win.id} />
      </div>

      {!win.maximized &&
        RESIZE_HANDLES.map(({ dir, className }) => (
          <div
            key={dir}
            onPointerDown={onResizePointerDown(dir)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            className={cn('absolute z-10 touch-none', className)}
          />
        ))}
    </section>
  );
});
