import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minus, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { getDockTileRect } from '@/lib/dockTiles';
import { animateFlip, animateGenie, type GenieRect } from '@/lib/genie';
import { getScreenshotBridge } from '@/lib/screenshot';
import { WindowTitlebarContext } from '@/contexts/WindowTitlebarContext';
import { WindowAccentContext } from '@/contexts/WindowAccentContext';
import { WindowTitleContext } from '@/contexts/WindowTitleContext';
import { WindowFocusContext } from '@/contexts/WindowFocusContext';
import {
  WindowChromeContext,
  type ChromePoint,
  type ResizeDir,
  type WindowChrome,
} from '@/contexts/WindowChromeContext';
import { isDarkThemeColor, normalizeThemeColor } from '@/lib/themeColor';
import { useSuperHeld } from '@/lib/superKey';
import {
  createModel,
  grabModel,
  modelTopLeft,
  modelTransform,
  spreadModel,
  stepModel,
  ungrabModel,
  WOBBLY_ACTIVE,
  WOBBLY_FORCE,
  WOBBLY_INITIAL,
  type WobblyModel,
} from '@/lib/wobbly';
import { useAppContext } from '@/hooks/useAppContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { MIN_HEIGHT, MIN_WIDTH, windowRect, type WindowState } from '@/hooks/useWindows';
import { areaFor, areaNear, hasNeighbor, snapRect, type Rect, type WorkArea } from '@/lib/monitors';

/**
 * Dragging with the pointer within this many pixels of a monitor's top edge
 * arms the snap-to-maximize (drop to maximize, GNOME/Windows style).
 */
const SNAP_TOP_PX = 6;

/**
 * Dragging with the pointer within this many pixels of a monitor's left or
 * right edge arms a half-monitor tile (drop to snap the window to that
 * half, GNOME/Windows style). More generous than the top zone: you shove the
 * window into the side rather than clip a thin strip. Edges another monitor
 * continues past don't snap - the window is on its way over there.
 */
const SNAP_EDGE_PX = 24;

/** Which edge a title-bar drag is currently snapping to, or null. */
type SnapZone = 'top' | 'left' | 'right' | null;

/** The snap a drag would drop into: the zone and the monitor it's on. */
interface SnapTarget {
  zone: Exclude<SnapZone, null>;
  area: WorkArea;
}

/** The monitor a pointer is on (or nearest), and the pointer clamped onto it. */
function pointerOn(areas: WorkArea[], px: number, py: number): { area: WorkArea; x: number; y: number } {
  const area = areaNear(areas, px, py);
  const { bounds: b } = area;
  return {
    area,
    x: Math.min(Math.max(px, b.x), b.x + b.width - 1),
    y: Math.min(Math.max(py, b.y), b.y + b.height - 1),
  };
}

/** The snap zone under a pointer (workspace coordinates), if any. */
function snapTargetAt(areas: WorkArea[], px: number, py: number): SnapTarget | null {
  const { area, x, y } = pointerOn(areas, px, py);
  // Top wins its (thinner) corner overlap. On the primary monitor the
  // pointer can be above the work area, over the menu bar: that's the top.
  if (y - area.y <= SNAP_TOP_PX && !hasNeighbor(areas, area, 'top', x)) return { zone: 'top', area };
  if (x - area.x <= SNAP_EDGE_PX && !hasNeighbor(areas, area, 'left', y)) return { zone: 'left', area };
  if (area.x + area.width - x <= SNAP_EDGE_PX && !hasNeighbor(areas, area, 'right', y)) {
    return { zone: 'right', area };
  }
  return null;
}

/**
 * A monitor's top edge with another monitor above it doesn't stop the
 * pointer, so its maximize zone arms only once the pointer rests just below
 * it this long. Passing straight through carries the window up there.
 */
const SHARED_TOP_DWELL_MS = 350;

/** The monitor whose shared top edge the pointer rides, if any. */
function sharedTopAt(areas: WorkArea[], px: number, py: number): WorkArea | null {
  const { area, x, y } = pointerOn(areas, px, py);
  if (y - area.y > SNAP_TOP_PX || !hasNeighbor(areas, area, 'top', x)) return null;
  return area;
}

/**
 * The highest a window's top edge may go with the pointer at a spot: the top
 * of the monitor it's on, or nearest. Never the monitor the drag began on,
 * which would yank the window back there while the pointer stays put.
 */
function topLimit(areas: WorkArea[], x: number, y: number): number {
  return areaNear(areas, x, y).y;
}

/**
 * Dragging a maximized window's title bar farther than this tears it away:
 * the window un-maximizes under the cursor and the drag continues. Small
 * enough to feel immediate, large enough that a sloppy click doesn't tear.
 */
const TEAR_AWAY_PX = 8;

/** Gap between the snap preview and the edges of the area it previews. */
const SNAP_HINT_INSET = 6;

/**
 * The eight resize handles: edges + corners. They straddle the window's
 * edge, mostly outside it, so there's a grip of 10px without covering much
 * of the title bar or the app; corners are larger, being the usual grip.
 */
const RESIZE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: '-top-1.5 inset-x-3 h-2.5 cursor-ns-resize' },
  { dir: 's', className: '-bottom-1.5 inset-x-3 h-2.5 cursor-ns-resize' },
  { dir: 'w', className: '-left-1.5 inset-y-3 w-2.5 cursor-ew-resize' },
  { dir: 'e', className: '-right-1.5 inset-y-3 w-2.5 cursor-ew-resize' },
  { dir: 'nw', className: '-top-1.5 -left-1.5 size-4.5 cursor-nwse-resize' },
  { dir: 'ne', className: '-top-1.5 -right-1.5 size-4.5 cursor-nesw-resize' },
  { dir: 'sw', className: '-bottom-1.5 -left-1.5 size-4.5 cursor-nesw-resize' },
  { dir: 'se', className: '-bottom-1.5 -right-1.5 size-4.5 cursor-nwse-resize' },
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
 * Edge snapping: dragging the title bar to the workspace's top edge shows a
 * "drop to maximize" preview and maximizes on release (restore geometry is
 * the pre-drag spot). Dragging a maximized window's title bar tears it away:
 * past a small threshold it un-maximizes under the cursor and the gesture
 * continues as a normal drag.
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
  // Actions only (stable identity): subscribing to the full manager would
  // re-render every window's chrome on every commit anywhere on the desktop,
  // defeating the memo() above. With actions only, this component re-renders
  // solely when its own `window` object or `isTop` changes.
  const { close, destroy, minimize, focus, move, resize, maximize, unmaximize, tile, toggleMaximize, setTitle } =
    useWindowActions();
  const { config } = useAppContext();
  const { getApp } = useInstalledApps();
  const app = getApp(win.appId);
  const areas = useWorkAreas();
  // For gesture handlers, which shouldn't re-bind whenever monitors change.
  const areasRef = useRef(areas);
  useLayoutEffect(() => {
    areasRef.current = areas;
  });
  const sectionRef = useRef<HTMLElement>(null);
  // Drag state: pointer origin, window origin, and the latest position (so
  // pointer-up/cancel can commit without needing event coordinates). The
  // workspace origin is cached at grab time (it can't change mid-drag) so
  // pointer moves never force a layout read.
  const dragState = useRef<{
    px: number;
    py: number;
    wx: number;
    wy: number;
    x: number;
    y: number;
    /** Workspace origin in viewport coordinates, cached at grab. */
    wsLeft: number;
    wsTop: number;
    /** Armed tear-away from maximized/tiled: the size to restore to, or null. */
    tearAway: { width: number; height: number } | null;
    /** Which snap zone the pointer currently rides, and on which monitor. */
    snap: SnapTarget | null;
    /** The shared top edge the pointer is resting under, and whether it's armed yet. */
    dwell?: { areaId: string; timer: number; armed: boolean };
  } | null>(null);
  const resizeState = useRef<{
    dir: ResizeDir;
    px: number;
    py: number;
    x: number;
    y: number;
    width: number;
    height: number;
    /** The highest the top edge may go (its monitor's work area top). */
    minTop: number;
    cur: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const wobblyRef = useRef<WobblyDrag | null>(null);
  // Cancel handle of whichever window-body animation (genie minimize/restore
  // or FLIP maximize/tile) currently owns the transform; the two are
  // mutually exclusive, so one handle covers both.
  const animCancel = useRef<(() => void) | null>(null);
  // The rect the window was last committed at, in workspace coordinates -
  // the "first" frame of the FLIP maximize/restore animation. Kept fresh by
  // a per-commit layout effect below; the snap-drop path overwrites it with
  // the drop position, where the window visually sat (drags don't commit
  // geometry until release).
  const paintedRect = useRef<GenieRect | null>(null);
  // The window's own bitmap, captured on minimize and replayed (reversed) on
  // restore: a minimized window is off-screen, so it can't be re-captured for
  // the restore warp. `null` until the first minimize, or whenever no shell
  // capture bridge is available (a plain browser), in which case the genie
  // falls back to warping the live element.
  const snapshotRef = useRef<string | null>(null);

  // Custom title-bar content published by the hosted app (e.g. the browser's
  // tab strip), rendered inline with the window controls. `null` shows the
  // default icon + name. The setter is stable so apps can publish from an
  // effect without re-subscribing.
  const [titlebar, setTitlebar] = useState<ReactNode>(null);

  // Chrome accent color published by the hosted app (e.g. the loaded page's
  // theme-color), tinting the title bar Safari-style. The raw value comes
  // from an untrusted page, so it's strictly normalized before styling.
  const [accentRaw, setAccent] = useState<string | null>(null);

  // What the hosted app says the window is showing; kept in the window
  // manager, where the Dock and the switcher read it.
  const publishTitle = useCallback((title: string | null) => setTitle(win.id, title), [setTitle, win.id]);
  const title = win.title ?? app?.name ?? win.appId;

  // The rect the drag would snap into (if any): drives the "drop to
  // maximize"/"drop to tile" preview overlay. Only changes when a zone
  // boundary is crossed, so pointer moves still avoid React state churn.
  const [snapHint, setSnapHint] = useState<Rect | null>(null);

  // Holding Super covers the whole window with a grab layer, so it can be
  // dragged from anywhere (web content and native apps included). The layer
  // stays up until a drag it started ends, even if Super is let go first,
  // since it holds that drag's pointer capture.
  const superHeld = useSuperHeld();
  const [superDragging, setSuperDragging] = useState(false);

  // The element in this window that last held focus. Coming back on top -
  // Alt+Tab, a dock click, restoring from minimized - gives it focus again,
  // the way native windows get keyboard focus back when raised, so typing
  // and arrow keys pick up where they left off. A focused <webview> guest
  // registers through GuestInputHost's focusin.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isTop) return;
    const section = sectionRef.current;
    const el = lastFocused.current;
    if (!section || !el?.isConnected || section.contains(document.activeElement)) return;
    el.focus({ preventScroll: true });
  }, [isTop]);

  // A click into an <iframe> (the browser's plain-web fallback) goes to the
  // frame's document, so neither pointerdown nor focusin reaches the handlers
  // below. What this document does see is losing focus to the frame: `blur`
  // on the window, with the frame left as the active element (checked a task
  // later, since not every browser has updated activeElement during blur).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLIFrameElement) || !sectionRef.current?.contains(active)) return;
        lastFocused.current = active;
        focus(win.id);
      });
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      clearTimeout(timer);
    };
  }, [focus, win.id]);

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
        const area = areaFor(areasRef.current, { ...st.layout, x, y: rest.y });
        const y = Math.max(area.y, Math.round(rest.y));
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

  // Genie minimize/restore (Compiz "magic lamp", macOS genie): when the
  // minimized flag flips, warp the window into / out of its app's dock tile
  // instead of blinking (see src/lib/genie.ts). The window stays mounted
  // either way. Watching the flag here (rather than wrapping the
  // minimize/focus actions) covers every trigger: title-bar button, dock
  // tile clicks and scrolls.
  //
  // Inside the Electron shell the warp runs on a *bitmap snapshot* of the
  // window, not the live element: the section wraps a <webview>/WebGL guest
  // surface, and a projective transform can't composite a guest cheaply - it
  // re-rasterizes the whole surface every frame, which is what made the genie
  // crawl on full-screen windows. A raster <img> warps as a plain compositor
  // layer, and (unlike the guest) actually follows the perspective mesh. The
  // minimize snapshot is cached so restore - whose window is off-screen and
  // can't be re-captured - can replay it reversed. Outside the shell (a plain
  // browser: no capture bridge) the genie falls back to warping the live
  // element, as before.
  const prevMinimized = useRef(win.minimized);
  useLayoutEffect(() => {
    if (prevMinimized.current === win.minimized) return;
    prevMinimized.current = win.minimized;
    const el = sectionRef.current;
    if (!el) return;

    animCancel.current?.();
    animCancel.current = null;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // A dock-initiated minimize can catch a still-jiggling window; the genie
    // owns the transform from here.
    stopWobble(false);

    // The rendered rect in workspace coordinates. Offsets rather than the
    // stored geometry, so maximized/tiled windows - whose layout is
    // CSS-percentage-driven - measure correctly; visibility:hidden keeps
    // layout intact, so a just-minimized window still measures.
    const winRect: GenieRect = {
      x: el.offsetLeft,
      y: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
    if (winRect.width === 0 || winRect.height === 0) return;

    // The app's dock tile, translated into workspace coordinates. An app
    // always has a tile while it has windows; the bottom-center fallback
    // covers a transient gap (e.g. the Dock re-mounting).
    const parent = el.parentElement;
    const ws = parent?.getBoundingClientRect();
    const wsLeft = ws?.left ?? 0;
    const wsTop = ws?.top ?? 0;
    const tile = getDockTileRect(win.appId);
    const target: GenieRect = tile
      ? { x: tile.x - wsLeft, y: tile.y - wsTop, width: tile.width, height: tile.height }
      : {
          x: (ws?.width ?? window.innerWidth) / 2 - 40,
          y: ws?.height ?? window.innerHeight,
          width: 80,
          height: 80,
        };

    const minimizing = win.minimized;

    // Warp the live element directly (the pre-snapshot behaviour). Used
    // outside the shell and as a fallback when a capture fails.
    const runLiveGenie = () => {
      beginGesture();
      el.style.pointerEvents = 'none';
      if (minimizing) el.style.visibility = 'visible';
      animCancel.current = animateGenie(el, winRect, target, minimizing ? 'minimize' : 'restore', () => {
        animCancel.current = null;
        el.style.transform = '';
        el.style.transformOrigin = '';
        el.style.opacity = '';
        el.style.pointerEvents = '';
        // Hand visibility back to the React-committed value (hidden while
        // minimized; the property is absent otherwise).
        el.style.visibility = minimizing ? 'hidden' : '';
        endGesture();
      });
    };

    // Warp a bitmap overlay <img>, hiding the live section behind it for the
    // whole timeline. Returns a cleanup that removes the overlay and hands
    // the section's styles back to React - shared by onDone and cancel
    // (which onDone never covers).
    const warpImage = (dataUrl: string) => {
      if (!parent) return runLiveGenie();
      const img = document.createElement('img');
      img.src = dataUrl;
      img.draggable = false;
      img.decoding = 'sync';
      img.style.position = 'absolute';
      img.style.left = `${winRect.x}px`;
      img.style.top = `${winRect.y}px`;
      img.style.width = `${winRect.width}px`;
      img.style.height = `${winRect.height}px`;
      img.style.transformOrigin = '0 0';
      img.style.pointerEvents = 'none';
      img.style.willChange = 'transform';
      img.style.zIndex = String(win.z);
      parent.appendChild(img);

      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';

      const finish = () => {
        img.remove();
        el.style.pointerEvents = '';
        el.style.visibility = minimizing ? 'hidden' : '';
      };
      const cancel = animateGenie(img, winRect, target, minimizing ? 'minimize' : 'restore', () => {
        animCancel.current = null;
        finish();
      });
      animCancel.current = () => {
        cancel();
        finish();
      };
    };

    const bridge = getScreenshotBridge();
    const captureRegion = bridge?.captureRegion?.bind(bridge);

    if (minimizing && captureRegion) {
      // Snapshot the window at rest, then warp the bitmap. Keep the live
      // section visible for the capture (React just committed it hidden); the
      // overlay takes over the instant the capture resolves.
      el.style.visibility = 'visible';
      el.style.pointerEvents = 'none';
      const r = el.getBoundingClientRect();
      let cancelled = false;
      animCancel.current = () => {
        cancelled = true;
        el.style.pointerEvents = '';
        el.style.visibility = 'hidden';
      };
      captureRegion({ x: r.left, y: r.top, width: r.width, height: r.height })
        .then((shot) => {
          if (cancelled) return;
          snapshotRef.current = shot.dataUrl;
          warpImage(shot.dataUrl);
        })
        .catch(() => {
          if (!cancelled) runLiveGenie();
        });
      return;
    }

    // Restore replays the cached minimize bitmap reversed; the fully-swallowed
    // first frame is painted synchronously (animateGenie's contract), so the
    // full-size window never flashes before the warp grows it out of the dock.
    if (!minimizing && captureRegion && snapshotRef.current) {
      warpImage(snapshotRef.current);
      return;
    }

    runLiveGenie();
  }, [win.minimized, win.appId, win.z, beginGesture, endGesture, stopWobble]);

  // Maximize/restore/tile transitions FLIP from the previous committed rect
  // to the new one: React swaps the geometry instantly (CSS percentages or
  // restored pixels), then this effect plays a compositor-only
  // translate+scale from the old rect down to identity, decelerating into
  // place. Skipped mid-gesture: a tear-away drag already moves the window
  // under the pointer, and animating against it would fight the cursor.
  const prevMode = useRef({ maximized: win.maximized, snapped: win.snapped });
  useLayoutEffect(() => {
    const prev = prevMode.current;
    prevMode.current = { maximized: win.maximized, snapped: win.snapped };
    if (prev.maximized === win.maximized && prev.snapped === win.snapped) return;
    const el = sectionRef.current;
    const from = paintedRect.current;
    if (!el || !from || win.minimized) return;
    if (dragState.current || resizeState.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    animCancel.current?.();
    animCancel.current = null;
    stopWobble(false);

    const to: GenieRect = {
      x: el.offsetLeft,
      y: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
    if (!to.width || !to.height || !from.width || !from.height) return;
    if (
      from.x === to.x &&
      from.y === to.y &&
      from.width === to.width &&
      from.height === to.height
    ) {
      return;
    }

    beginGesture();
    animCancel.current = animateFlip(el, from, to, () => {
      animCancel.current = null;
      el.style.transform = '';
      el.style.transformOrigin = '';
      endGesture();
    });
  }, [win.maximized, win.snapped, win.minimized, beginGesture, endGesture, stopWobble]);

  // Record the committed rect for the next FLIP. Declared after the FLIP
  // effect so it runs later in the same commit: the FLIP reads the previous
  // commit's rect before this overwrites it. Offsets ignore transforms, so
  // recording is safe mid-animation.
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    paintedRect.current = {
      x: el.offsetLeft,
      y: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
  });

  // Neither animation loop may outlive the window (e.g. closed mid-flight).
  useEffect(() => () => animCancel.current?.(), []);

  // Close: close() only marks the window `closing`; the exit animation (a
  // reverse of the open pop, via the animate-out classes below) plays on the
  // live element and its animationend calls destroy() for the real removal.
  // This effect handles the cases with no animation to wait for - reduced
  // motion, a minimized (invisible) window, or an uninstalled app rendering
  // null - and arms a safety-net timer so a missed animationend can never
  // leave an inert ghost window behind.
  useLayoutEffect(() => {
    if (!win.closing) return;
    animCancel.current?.();
    animCancel.current = null;
    stopWobble(false);
    if (
      !sectionRef.current ||
      win.minimized ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      destroy(win.id);
      return;
    }
    const timer = window.setTimeout(() => destroy(win.id), 400);
    return () => window.clearTimeout(timer);
  }, [win.closing, win.minimized, win.id, destroy, stopWobble]);

  /**
   * Begin a title-bar drag with the pointer at `e`. The caller holds the
   * pointer and feeds its moves to onPointerMove and its release to endDrag.
   */
  const startDrag = useCallback(
    (e: ChromePoint) => {
      focus(win.id);
      const ws = sectionRef.current?.parentElement?.getBoundingClientRect();
      const wsLeft = ws?.left ?? 0;
      const wsTop = ws?.top ?? 0;
      if (win.maximized || win.snapped) {
        // Arm a tear-away: nothing moves yet - once the pointer travels past
        // TEAR_AWAY_PX (see onPointerMove), the window un-maximizes/un-tiles
        // under the cursor and the gesture continues as a normal drag.
        const restore = win.restore ?? {
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
        };
        dragState.current = {
          px: e.clientX,
          py: e.clientY,
          wx: 0,
          wy: 0,
          x: 0,
          y: 0,
          wsLeft,
          wsTop,
          tearAway: { width: restore.width, height: restore.height },
          snap: null,
        };
        return;
      }
      dragState.current = {
        px: e.clientX,
        py: e.clientY,
        wx: win.x,
        wy: win.y,
        x: win.x,
        y: win.y,
        wsLeft,
        wsTop,
        tearAway: null,
        snap: null,
      };
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
    [focus, win.id, win.x, win.y, win.width, win.height, win.maximized, win.snapped, win.restore, beginGesture, config.wobblyWindows, stopWobble, wobbleFrame],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on interactive title-bar controls: the window
      // controls (buttons) and any app-provided controls (e.g. tab strip
      // tabs, which are role="tab" divs). Capturing the pointer for a drag
      // here would swallow their click, so bail before setPointerCapture.
      const target = e.target as HTMLElement;
      if (target.closest('button, [role="tab"], [data-window-no-drag]')) return;
      // Presses in menus the title bar's content portals elsewhere (a tab's
      // context menu) bubble here through React, but aren't on the title bar.
      if (!(e.currentTarget as HTMLElement).contains(target)) return;
      startDrag(e);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [startDrag],
  );

  const onPointerMove = useCallback(
    (e: ChromePoint) => {
      const s = dragState.current;
      const el = sectionRef.current;
      if (!s || !el) return;

      const areas = areasRef.current;
      const px = e.clientX - s.wsLeft;
      const py = e.clientY - s.wsTop;

      if (s.tearAway) {
        // Maximized window being dragged: past the threshold, restore it
        // under the cursor (horizontally proportional, like Windows/GNOME)
        // and continue as a normal drag.
        if (Math.hypot(e.clientX - s.px, e.clientY - s.py) < TEAR_AWAY_PX) return;
        const { width, height } = s.tearAway;
        // The rect the window is painted at right now (the maximized/tiled
        // layout, in pixels) - measured before the style writes below
        // replace it. The wobbly shrink springs from here.
        const prevRect = {
          x: el.offsetLeft,
          y: el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
        const fraction = prevRect.width > 0
          ? Math.min(Math.max((s.px - s.wsLeft - prevRect.x) / prevRect.width, 0), 1)
          : 0.5;
        const x = Math.round(px - width * fraction);
        // Keep the grab point's offset within the title bar.
        const y = Math.max(
          topLimit(areas, px, py),
          prevRect.y + (e.clientY - s.py),
        );
        s.tearAway = null;
        s.wx = x;
        s.wy = y;
        s.x = x;
        s.y = y;
        s.px = e.clientX;
        s.py = e.clientY;
        // Write the restored geometry directly so this frame is already
        // correct; the state commit below re-renders with the same values.
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        // Interrupt any stale jiggle before beginGesture: stopWobble ends
        // the gesture styling, which must not undo the beginGesture below.
        stopWobble(false);
        beginGesture();
        unmaximize(win.id, { x, y, width, height });

        // With wobbly enabled, the tear-away is springy instead of a snap:
        // the model is created at rest at the restored geometry, grabbed at
        // the pointer, then spread back over the rect the window just
        // occupied - the springs contract the fullscreen sheet into the
        // cursor (the inverse of Compiz's wobbly maximize effect), and the
        // continuing drag wobbles from its very first frame instead of
        // staying rigid until the next grab.
        if (
          config.wobblyWindows &&
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
          const st: WobblyDrag = {
            model: createModel(x, y, width, height),
            raf: 0,
            lastTime: performance.now(),
            flags: WOBBLY_INITIAL,
            grabbed: true,
            anchorOrigin: { x: 0, y: 0 },
            layout: { x, y, width, height },
          };
          // Grab first (the anchor point near the cursor snaps to the hand
          // immediately), then spread the rest of the lattice.
          const anchor = grabModel(st.model, px, py);
          st.anchorOrigin = { x: anchor.x, y: anchor.y };
          spreadModel(st.model, prevRect.x, prevRect.y, prevRect.width, prevRect.height);
          wobblyRef.current = st;
          st.raf = requestAnimationFrame(wobbleFrame);
          // Paint the still-fullscreen first frame now, so the browser never
          // shows the restored-size window before the shrink starts.
          renderWobble();
        }
        return;
      }

      s.x = s.wx + (e.clientX - s.px);
      s.y = Math.max(
        topLimit(areas, px, py),
        s.wy + (e.clientY - s.py),
      );

      // Snap hint while the pointer rides a monitor's edge: top maximizes,
      // left/right tile to that half.
      let snap = snapTargetAt(areas, px, py);
      const shared = snap ? null : sharedTopAt(areas, px, py);
      if (shared && s.dwell?.areaId === shared.id) {
        if (s.dwell.armed) snap = { zone: 'top', area: shared };
      } else {
        if (s.dwell) window.clearTimeout(s.dwell.timer);
        s.dwell = undefined;
        if (shared) {
          const dwell = { areaId: shared.id, armed: false, timer: 0 };
          // The pointer may rest without moving, so arm from a timer.
          dwell.timer = window.setTimeout(() => {
            if (dragState.current !== s || s.dwell !== dwell) return;
            dwell.armed = true;
            s.snap = { zone: 'top', area: shared };
            setSnapHint(snapRect(shared, 'max'));
          }, SHARED_TOP_DWELL_MS);
          s.dwell = dwell;
        }
      }
      if (snap?.zone !== s.snap?.zone || snap?.area.id !== s.snap?.area.id) {
        s.snap = snap;
        setSnapHint(snap ? snapRect(snap.area, snap.zone === 'top' ? 'max' : snap.zone) : null);
      }

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
    },
    [beginGesture, unmaximize, win.id, config.wobblyWindows, stopWobble, wobbleFrame, renderWobble],
  );

  const endDrag = useCallback(
    () => {
      const s = dragState.current;
      if (!s) return;
      dragState.current = null;
      if (s.dwell) window.clearTimeout(s.dwell.timer);

      // An armed tear-away that never crossed the threshold is just a click
      // on a maximized title bar - nothing moved, nothing to commit.
      if (s.tearAway) return;

      const el = sectionRef.current;

      if (s.snap) {
        // Dropped on an edge: maximize (top) or tile to a half (left/right).
        // Restore geometry is the window's pre-drag spot, so un-snapping
        // returns it there rather than to wherever it was dropped.
        const restore = { x: s.wx, y: s.wy, width: win.width, height: win.height };
        setSnapHint(null);
        stopWobble(false);
        if (el) el.style.transform = '';
        endGesture();
        // The FLIP into the snap target starts from the drop position, where
        // the window visually sat (the drag never committed geometry).
        paintedRect.current = { x: s.x, y: s.y, width: win.width, height: win.height };
        if (s.snap.zone === 'top') maximize(win.id, restore, s.snap.area.id);
        else tile(win.id, s.snap.zone, restore, s.snap.area.id);
        return;
      }

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
    [move, win.id, win.width, win.height, endGesture, renderWobble, maximize, tile, stopWobble],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      endDrag();
    },
    [endDrag],
  );

  const onSuperPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || dragState.current || resizeState.current) return;
      e.preventDefault();
      startDrag(e);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setSuperDragging(true);
    },
    [startDrag],
  );

  const onSuperPointerUp = useCallback(
    (e: React.PointerEvent) => {
      onPointerUp(e);
      setSuperDragging(false);
    },
    [onPointerUp],
  );

  /** Begin a resize from `dir`, like startDrag; false while maximized/tiled. */
  const startResize = useCallback(
    (dir: ResizeDir, e: ChromePoint) => {
      if (win.maximized || win.snapped) return false;
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
        minTop: areaFor(areasRef.current, { x: win.x, y: win.y, width: win.width, height: win.height }).y,
        cur: { x: win.x, y: win.y, width: win.width, height: win.height },
      };
      beginGesture();
      return true;
    },
    [focus, win.id, win.x, win.y, win.width, win.height, win.maximized, win.snapped, beginGesture, stopWobble],
  );

  const onResizePointerDown = useCallback(
    (dir: ResizeDir) => (e: React.PointerEvent) => {
      e.stopPropagation();
      if (startResize(dir, e)) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [startResize],
  );

  const onResizePointerMove = useCallback((e: ChromePoint) => {
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
      y = Math.max(Math.min(o.minTop, o.y), o.y + clampedDy);
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

  const endResize = useCallback(() => {
    const o = resizeState.current;
    if (!o) return;
    resizeState.current = null;
    endGesture();
    resize(win.id, o.cur);
  }, [resize, win.id, endGesture]);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeState.current) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      endResize();
    },
    [endResize],
  );

  // An app that draws its own title bar (WindowChromeContext) runs the same
  // gestures from its own. The context value is stable, so apps never
  // re-render for it; it calls the latest handlers.
  const gestures = useRef({ startDrag, onPointerMove, endDrag, startResize, onResizePointerMove, endResize });
  useLayoutEffect(() => {
    gestures.current = { startDrag, onPointerMove, endDrag, startResize, onResizePointerMove, endResize };
  });
  const chrome = useMemo<WindowChrome>(
    () => ({
      beginMove: (point) => {
        if (dragState.current || resizeState.current) return false;
        gestures.current.startDrag(point);
        return true;
      },
      beginResize: (dir, point) =>
        !dragState.current && !resizeState.current && gestures.current.startResize(dir, point),
      gestureMove: (point) => {
        if (dragState.current) gestures.current.onPointerMove(point);
        else if (resizeState.current) gestures.current.onResizePointerMove(point);
      },
      gestureEnd: () => {
        if (dragState.current) gestures.current.endDrag();
        else if (resizeState.current) gestures.current.endResize();
      },
    }),
    [],
  );

  // An app uninstalled while its window is open renders nothing.
  if (!app) return null;

  // Maximized/tiled windows fill (half) their monitor's work area; the
  // window's own x/y/width/height keep their pre-snap values. A normal
  // window renders at its stored geometry.
  const rect = windowRect(win, areas);
  const geometry: React.CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: win.z,
  };

  // Minimized windows stay mounted but hidden so app state (terminal
  // sessions, browser pages, navigation history) survives restore.
  // `visibility: hidden` (not display:none / unmount) keeps layout intact,
  // which the Electron <webview> and xterm's fit logic both depend on.
  if (win.minimized) geometry.visibility = 'hidden';

  // Maximized and edge-tiled windows sit flush against the workspace edges:
  // square corners, no floating shadow/ring.
  const flush = win.maximized || win.snapped !== null;
  // A window whose app draws its own title bar (or none) is just the app:
  // no title bar, border, shadow, background or resize handles.
  const frameless = win.frameless;

  // Sanitized chrome accent. Theme tokens can't guarantee contrast against
  // an arbitrary page color, so tinted chrome flips its foregrounds to plain
  // black/white based on the accent's luminance.
  const accent = normalizeThemeColor(accentRaw);
  const accentDark = accent !== null && isDarkThemeColor(accent);
  const chromeText = accent
    ? accentDark ? 'text-white/90' : 'text-black/80'
    : 'text-foreground/90';
  const chromeMuted = accent
    ? accentDark ? 'text-white/70' : 'text-black/60'
    : 'text-muted-foreground';
  const chromeHover = accent
    ? accentDark
      ? 'hover:bg-white/15 hover:text-white'
      : 'hover:bg-black/10 hover:text-black'
    : 'hover:bg-foreground/10 hover:text-foreground';

  return (
    <section
      ref={sectionRef}
      aria-label={title}
      data-window-id={win.id}
      onPointerDown={() => focus(win.id)}
      // Raise when focus lands anywhere inside the window (React's onFocus is
      // the bubbling focusin), so keyboard users tabbing into a window's
      // content bring it forward. Note this does NOT cover clicks into
      // <webview>/<iframe> guests: those are foreign surfaces whose input
      // never reaches this document, and their host elements don't reliably
      // fire focus events either (Electron webviews in particular, and
      // guest-to-guest focus moves fire nothing here at all). Presses inside
      // a <webview> instead arrive as GuestInputHost's synthetic pointerdown,
      // which raises via the handler above, and focusin, which remembers the
      // guest as the last-focused element. Iframes raise from the window
      // blur listener above.
      onFocus={(e) => {
        if (e.target instanceof HTMLElement) lastFocused.current = e.target;
        focus(win.id);
      }}
      style={geometry}
      onAnimationEnd={(e) => {
        // The exit animation finished: remove the window for real. Guarded
        // by name and target so enter animations (this window's or a
        // child's, bubbling) can't destroy a live window.
        if (win.closing && e.target === e.currentTarget && e.animationName === 'exit') {
          destroy(win.id);
        }
      }}
      className={cn(
        // Not clipped, so the resize handles can reach past the edges; the
        // title bar and the content round their own corners instead.
        'absolute flex flex-col',
        !frameless && 'bg-card/90 backdrop-blur-xl',
        // Open/close animations: a quick macOS-style pop in (fade + zoom
        // from 95%) on mount, and its reverse on close - swapping the
        // classes restarts the element's animation as the exit. CSS
        // keyframes take precedence over inline transforms for their
        // duration, so gestures in the first 200ms are visually deferred,
        // never broken. fill-mode-forwards holds the faded-out final frame
        // until destroy() commits.
        win.closing
          ? 'pointer-events-none motion-safe:animate-out motion-safe:fade-out-0 motion-safe:zoom-out-95 motion-safe:duration-150 motion-safe:fill-mode-forwards'
          : 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200',
        flush || frameless
          ? 'rounded-none'
          : 'rounded-xl border border-border/60 shadow-2xl ring-1 ring-black/20 transition-shadow',
        !flush && !frameless && isTop && 'ring-ring/50',
      )}
    >
      {!frameless && (
        <header
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            if (!e.currentTarget.contains(e.target as Node)) return;
            stopWobble(false);
            toggleMaximize(win.id);
          }}
          style={accent ? { backgroundColor: accent } : undefined}
          className={cn(
            'flex h-9 shrink-0 touch-none select-none items-center gap-2 rounded-t-[inherit] border-b pr-3',
            accent
              ? accentDark ? 'border-white/10' : 'border-black/10'
              : 'border-border/60 bg-background/60',
            titlebar ? 'pl-2' : 'pl-3',
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
            <AppIcon icon={app.icon} className={cn('size-4 shrink-0', chromeMuted)} />
            <span className={cn('flex-1 truncate text-sm font-medium', chromeText)}>
              {title}
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
          className={cn('grid size-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', chromeMuted, chromeHover)}
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
          className={cn('grid size-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', chromeMuted, chromeHover)}
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
          className={cn('grid size-6 place-items-center rounded-md hover:bg-destructive/80 hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', chromeMuted)}
        >
          <X className="size-4" />
        </button>
      </header>
      )}

      <div className={cn('relative flex-1 overflow-hidden rounded-b-[inherit]', !frameless && 'bg-background/80')}>
        <WindowFocusContext.Provider value={isTop}>
          <WindowTitlebarContext.Provider value={setTitlebar}>
            <WindowTitleContext.Provider value={publishTitle}>
              <WindowChromeContext.Provider value={chrome}>
                <WindowAccentContext.Provider value={setAccent}>
                  {/* Built-in apps are code-split (React.lazy); the fallback shows
                      while an app's chunk loads on its first launch. */}
                  <Suspense
                    fallback={<div className="size-full animate-pulse bg-muted/40" />}
                  >
                    <WindowContent component={app.component} windowId={win.id} params={win.params} />
                  </Suspense>
                </WindowAccentContext.Provider>
              </WindowChromeContext.Provider>
            </WindowTitleContext.Provider>
          </WindowTitlebarContext.Provider>
        </WindowFocusContext.Provider>
      </div>

      {!flush &&
        !frameless &&
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

      {(superHeld || superDragging) && !win.minimized && !win.closing && (
        <div
          aria-hidden
          onPointerDown={onSuperPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onSuperPointerUp}
          onPointerCancel={onSuperPointerUp}
          className="absolute inset-0 z-20 cursor-grab touch-none select-none active:cursor-grabbing"
        />
      )}

      {/* Snap preview while the drag rides a monitor's edge: its whole work
          area for "drop to maximize" (top), the left/right half for "drop to
          tile". Portaled to the workspace so it outlines the full snap
          target instead of being clipped to the window's own box. */}
      {snapHint &&
        sectionRef.current?.parentElement &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none absolute z-[9000] rounded-xl border-2 border-primary/50 bg-primary/10 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
            style={{
              left: snapHint.x + SNAP_HINT_INSET,
              top: snapHint.y + SNAP_HINT_INSET,
              width: snapHint.width - SNAP_HINT_INSET * 2,
              height: snapHint.height - SNAP_HINT_INSET * 2,
            }}
          />,
          sectionRef.current.parentElement,
        )}
    </section>
  );
});
