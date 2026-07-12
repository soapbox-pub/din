import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Maximize2, Minus, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { WindowTitlebarContext } from '@/contexts/WindowTitlebarContext';
import {
  createModel,
  grabModel,
  modelTopLeft,
  modelTransform,
  stepModel,
  ungrabModel,
  WOBBLY_ACTIVE,
  WOBBLY_FORCE,
  WOBBLY_INITIAL,
  type WobblyModel,
} from '@/lib/wobbly';
import { useAppContext } from '@/hooks/useAppContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
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
  params,
}: {
  component: ComponentType<AppComponentProps>;
  windowId: string;
  params: AppComponentProps['params'];
}) {
  return <AppComponent windowId={windowId} params={params} />;
});

/**
 * Live state of the wobbly spring simulation for one window. Exists only
 * while the window is grabbed or still jiggling after release; `null` means
 * the window is rigid.
 */
interface WobblyDrag {
  model: WobblyModel;
  /** requestAnimationFrame handle of the simulation loop. */
  raf: number;
  /** Timestamp of the previous simulation frame. */
  lastTime: number;
  /** Compiz-style wobbly state bits (WOBBLY_*); 0 once fully settled. */
  flags: number;
  /** Whether the pointer currently holds the model's anchor point. */
  grabbed: boolean;
  /** Anchor position at grab time; the pointer drags it from here. */
  anchorOrigin: { x: number; y: number };
  /** The window's committed layout rect that the CSS transform is relative to. */
  layout: { x: number; y: number; width: number; height: number };
}

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
 *
 * Wobbly windows: when enabled (Settings → Appearance) and the user doesn't
 * prefer reduced motion, title-bar drags run the Compiz wobbly spring model
 * (see src/lib/wobbly.ts). The pointer drives the lattice anchor, a rAF loop
 * integrates the springs, and the deformation is painted as a CSS matrix3d()
 * homography - still compositor-only, no React involvement. The window
 * manager position is committed on pointer-up as usual, then again with the
 * model's resting position once the jelly settles (Compiz moves the window to
 * the model's top-left bound when the wobble ends).
 */
export const Window = memo(function Window({
  window: win,
  isTop,
}: {
  window: WindowState;
  isTop: boolean;
}) {
  const { close, minimize, focus, move, resize, toggleMaximize } = useWindowManager();
  const { config } = useAppContext();
  const { getApp } = useInstalledApps();
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
  const wobblyRef = useRef<WobblyDrag | null>(null);

  // Custom title-bar content published by the hosted app (e.g. the browser's
  // tab strip), rendered inline with the window controls. `null` shows the
  // default icon + name. The setter is stable so apps can publish from an
  // effect without re-subscribing.
  const [titlebar, setTitlebar] = useState<ReactNode>(null);

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

  /** Paint the current spring-model deformation onto the DOM node. */
  const renderWobble = useCallback(() => {
    const st = wobblyRef.current;
    const el = sectionRef.current;
    if (!st || !el) return;
    el.style.transformOrigin = '0 0';
    el.style.transform = modelTransform(
      st.model,
      st.layout.x,
      st.layout.y,
      st.layout.width,
      st.layout.height,
    );
  }, []);

  /**
   * Tear down the wobble. When the model settled naturally, `commit` moves
   * the window to the model's resting position (Compiz moves the window to
   * the model's top-left bound when the wobble ends); when interrupted (a
   * resize grab, maximize, minimize, close), the window snaps to its last
   * committed geometry.
   */
  const stopWobble = useCallback(
    (commit: boolean) => {
      const st = wobblyRef.current;
      if (!st) return;
      wobblyRef.current = null;
      cancelAnimationFrame(st.raf);
      const el = sectionRef.current;
      if (el) {
        el.style.transform = '';
        el.style.transformOrigin = '';
      }
      endGesture();
      if (commit) {
        const rest = modelTopLeft(st.model);
        const x = Math.round(rest.x);
        const y = Math.max(0, Math.round(rest.y));
        if (el) {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
        if (x !== st.layout.x || y !== st.layout.y) move(win.id, x, y);
      }
    },
    [endGesture, move, win.id],
  );

  /**
   * Simulation loop, one spring-model step per animation frame (Compiz
   * wobblyPreparePaintScreen). Runs while the window is grabbed and until
   * the model settles after release.
   */
  const wobbleFrame = useCallback(
    (now: number) => {
      const st = wobblyRef.current;
      if (!st) return;
      // Clamp so a background tab doesn't integrate a huge burst at once.
      const dt = Math.min(now - st.lastTime, 100);
      st.lastTime = now;
      if (st.flags & WOBBLY_ACTIVE) {
        st.flags = stepModel(st.model, dt);
        // Mirror Compiz: a force-only state must keep the model running.
        if (st.flags === WOBBLY_FORCE) st.flags |= WOBBLY_INITIAL;
        renderWobble();
      }
      if (!st.grabbed && !(st.flags & WOBBLY_ACTIVE)) {
        stopWobble(true);
        return;
      }
      st.raf = requestAnimationFrame(wobbleFrame);
    },
    [renderWobble, stopWobble],
  );

  // The wobble loop must not outlive the window (e.g. closed mid-jiggle).
  useEffect(() => {
    return () => {
      const st = wobblyRef.current;
      if (st) cancelAnimationFrame(st.raf);
      wobblyRef.current = null;
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on interactive title-bar controls: the window
      // controls (buttons) and any app-provided controls (e.g. tab strip
      // tabs, which are role="tab" divs). Capturing the pointer for a drag
      // here would swallow their click, so bail before setPointerCapture.
      const target = e.target as HTMLElement;
      if (target.closest('button, [role="tab"], [data-window-no-drag]')) return;
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

      const wobblyEnabled =
        config.wobblyWindows &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!wobblyEnabled) {
        // A rigid drag interrupts any leftover jiggle from a settings change.
        stopWobble(false);
        return;
      }

      // Grab the spring model at the pointer (Compiz wobblyWindowGrabNotify):
      // the nearest lattice point becomes the anchor the pointer drags. If
      // the window is re-grabbed mid-jiggle, the existing deformed model is
      // reused so the motion stays continuous.
      let st = wobblyRef.current;
      if (!st) {
        st = {
          model: createModel(win.x, win.y, win.width, win.height),
          raf: 0,
          lastTime: performance.now(),
          flags: 0,
          grabbed: false,
          anchorOrigin: { x: 0, y: 0 },
          layout: { x: win.x, y: win.y, width: win.width, height: win.height },
        };
        wobblyRef.current = st;
        st.raf = requestAnimationFrame(wobbleFrame);
      }
      // Pointer position in workspace coordinates, derived from the offset
      // within the window so it works regardless of the workspace's origin.
      const rect = sectionRef.current?.getBoundingClientRect();
      const anchor = grabModel(
        st.model,
        st.layout.x + (rect ? e.clientX - rect.left : win.width / 2),
        st.layout.y + (rect ? e.clientY - rect.top : 0),
      );
      st.grabbed = true;
      st.anchorOrigin = { x: anchor.x, y: anchor.y };
      st.flags |= WOBBLY_INITIAL;
    },
    [focus, win.id, win.x, win.y, win.width, win.height, win.maximized, beginGesture, config.wobblyWindows, stopWobble, wobbleFrame],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = dragState.current;
    const el = sectionRef.current;
    if (!s || !el) return;
    s.x = s.wx + (e.clientX - s.px);
    s.y = Math.max(0, s.wy + (e.clientY - s.py));
    const st = wobblyRef.current;
    if (st?.grabbed && st.model.anchor) {
      // Only the anchor follows the pointer; the rest of the lattice catches
      // up through the springs (Compiz wobblyWindowMoveNotify). The rAF loop
      // paints the result.
      st.model.anchor.x = st.anchorOrigin.x + (s.x - s.wx);
      st.model.anchor.y = st.anchorOrigin.y + (s.y - s.wy);
      st.flags |= WOBBLY_INITIAL;
    } else {
      // Rigid drag: compositor-only move; left/top stay untouched until
      // pointer-up.
      el.style.transform = `translate3d(${s.x - s.wx}px, ${s.y - s.wy}px, 0)`;
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const s = dragState.current;
      if (!s) return;
      dragState.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      const el = sectionRef.current;
      const st = wobblyRef.current;
      if (st?.grabbed) {
        // Free the anchor and let the model settle around the drop point
        // (Compiz wobblyWindowUngrabNotify). The drop position is committed
        // now; the transform keeps wobbling relative to it until the springs
        // come to rest, then stopWobble() commits the resting position.
        ungrabModel(st.model);
        st.grabbed = false;
        st.flags |= WOBBLY_INITIAL;
        st.layout.x = s.x;
        st.layout.y = s.y;
        if (el) {
          el.style.left = `${s.x}px`;
          el.style.top = `${s.y}px`;
        }
        // Repaint against the new layout origin in the same frame so the
        // window doesn't flash at the wrong position.
        renderWobble();
        move(win.id, s.x, s.y);
        return;
      }
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
    [move, win.id, endGesture, renderWobble],
  );

  const onResizePointerDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      e.stopPropagation();
      focus(win.id);
      // Resizing a still-jiggling window snaps it rigid first.
      stopWobble(false);
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
    [focus, win.id, win.x, win.y, win.width, win.height, beginGesture, stopWobble],
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
        onDoubleClick={() => {
          stopWobble(false);
          toggleMaximize(win.id);
        }}
        className={cn(
          'flex h-9 shrink-0 touch-none select-none items-center gap-2 border-b border-border/60 bg-background/60 pr-3',
          titlebar ? 'pl-2' : 'pl-3',
          win.maximized ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        )}
      >
        {titlebar ? (
          // The app owns the flexible region (drag still works on its empty
          // space; interactive controls inside handle their own events).
          <div className="flex min-w-0 flex-1 items-center self-stretch">
            {titlebar}
          </div>
        ) : (
          <>
            <AppIcon icon={app.icon} className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-sm font-medium text-foreground/90">
              {app.name}
            </span>
          </>
        )}
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => {
            stopWobble(false);
            minimize(win.id);
          }}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={win.maximized ? 'Restore window' : 'Maximize window'}
          onClick={() => {
            stopWobble(false);
            toggleMaximize(win.id);
          }}
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
        <WindowTitlebarContext.Provider value={setTitlebar}>
          <WindowContent component={app.component} windowId={win.id} params={win.params} />
        </WindowTitlebarContext.Provider>
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
