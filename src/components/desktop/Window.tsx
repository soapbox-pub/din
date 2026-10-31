import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { WindowFrameContext, WindowOwnHeaderContext, type WindowFrame } from '@/contexts/WindowFrameContext';
import { getDockTileRect } from '@/lib/dockTiles';
import { animateFlip, animateGenie, type GenieRect } from '@/lib/genie';
import { effectsFor, resolveEffect, runWindowEffect, type EffectEvent, type WindowEffect } from '@/lib/effects';
import { onEffectPreview } from '@/lib/effects/preview';
import { getScreenshotBridge } from '@/lib/screenshot';
import { WindowTitlebarContext } from '@/contexts/WindowTitlebarContext';
import { WindowAccentContext } from '@/contexts/WindowAccentContext';
import { WindowTitleContext } from '@/contexts/WindowTitleContext';
import { WindowIconContext } from '@/contexts/WindowIconContext';
import { WindowFocusContext } from '@/contexts/WindowFocusContext';
import { WindowAppContext } from '@/contexts/WindowAppContext';
import { WindowVisibleContext } from '@/contexts/WindowVisibleContext';
import {
  WindowChromeContext,
  type ChromePoint,
  type ResizeDir,
  type WindowChrome,
} from '@/contexts/WindowChromeContext';
import { isDarkThemeColor, normalizeThemeColor, themeColorTokens } from '@/lib/themeColor';
import { useSuperHeld } from '@/lib/superKey';
import { beginWindowGesture, endWindowGesture } from '@/lib/windowGestures';
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
import { guestElements, isGuestFullscreen } from '@/platform/guest';

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

/**
 * How long a window must stay covered before it's hidden: long enough for
 * the window over it to finish popping in (its open animation scales it up
 * from 95%) and for a burst of raises to settle.
 */
const COVERED_HIDE_MS = 1000;

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
/**
 * The tiled window (other than `self`) under a viewport point, and where it
 * sits in workspace coordinates.
 */
function tileUnder(clientX: number, clientY: number, self: string): { id: string; rect: Rect } | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof HTMLElement) || el.dataset.tiled === undefined) continue;
    const id = el.dataset.windowId;
    if (!id || id === self) continue;
    return { id, rect: { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } };
  }
  return null;
}

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
 * A frameless window's handles: an 8px band wholly outside it. The window is
 * all app (a native app drawing its own title bar), whose edges are its own;
 * but Din tells native apps they're tiled, and tiled toolkits (Chromium,
 * GTK) leave themselves no resize border, so without these there's none.
 */
/** A window effect as it played: what, and with which random layout. */
interface PlayedEffect {
  effect: WindowEffect | 'none';
  seed: number;
}

function newSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/** An element's layout rect in its offset parent's (the workspace's) coordinates. */
function offsetRect(el: HTMLElement): GenieRect {
  return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

/**
 * The app's dock tile, translated into workspace coordinates. An app always
 * has a tile while it has windows; the bottom-center fallback covers a
 * transient gap (e.g. the Dock re-mounting).
 */
function dockTarget(workspace: HTMLElement | null, dockId: string): GenieRect {
  const ws = workspace?.getBoundingClientRect();
  const wsLeft = ws?.left ?? 0;
  const wsTop = ws?.top ?? 0;
  const tile = getDockTileRect(dockId);
  return tile
    ? { x: tile.x - wsLeft, y: tile.y - wsTop, width: tile.width, height: tile.height }
    : {
        x: (ws?.width ?? window.innerWidth) / 2 - 40,
        y: ws?.height ?? window.innerHeight,
        width: 80,
        height: 80,
      };
}

function hasCaptureBridge(): boolean {
  return !!getScreenshotBridge()?.captureRegion;
}

/**
 * Snapshot the element as it's on screen now, decoded. Null without the
 * shell's capture bridge (a plain browser).
 */
function captureSection(el: HTMLElement): Promise<HTMLImageElement> | null {
  const bridge = getScreenshotBridge();
  const captureRegion = bridge?.captureRegion?.bind(bridge);
  if (!captureRegion) return null;
  const r = el.getBoundingClientRect();
  return captureRegion({ x: r.left, y: r.top, width: r.width, height: r.height }).then(async (shot) => {
    const snapshot = new Image();
    snapshot.src = shot.dataUrl;
    await snapshot.decode();
    return snapshot;
  });
}

const FRAMELESS_RESIZE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: '-top-2 inset-x-0 h-2 cursor-ns-resize' },
  { dir: 's', className: '-bottom-2 inset-x-0 h-2 cursor-ns-resize' },
  { dir: 'w', className: '-left-2 inset-y-0 w-2 cursor-ew-resize' },
  { dir: 'e', className: '-right-2 inset-y-0 w-2 cursor-ew-resize' },
  { dir: 'nw', className: '-top-2 -left-2 size-3 cursor-nwse-resize' },
  { dir: 'ne', className: '-top-2 -right-2 size-3 cursor-nesw-resize' },
  { dir: 'sw', className: '-bottom-2 -left-2 size-3 cursor-nesw-resize' },
  { dir: 'se', className: '-bottom-2 -right-2 size-3 cursor-nwse-resize' },
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
 *
 * Covered windows: a window wholly behind another one (a maximized window
 * over everything else) is hidden like a minimized one, so its pages stop
 * painting and running their animation loops where nobody can see them.
 */
export const Window = memo(function Window({
  window: win,
  isTop,
  covered,
}: {
  window: WindowState;
  isTop: boolean;
  /** Whether a window above this one, at rest, covers all of it. */
  covered: boolean;
}) {
  // Actions only (stable identity): subscribing to the full manager would
  // re-render every window's chrome on every commit anywhere on the desktop,
  // defeating the memo() above. With actions only, this component re-renders
  // solely when its own `window` object, `isTop` or `covered` changes.
  const { close, destroy, minimize, focus, move, resize, maximize, unmaximize, tile, toggleMaximize, setTitle, setIcon, setAccent, dropTile } =
    useWindowActions();
  const { config } = useAppContext();
  // Whether closing plays an effect on a snapshot rather than the CSS pop,
  // decided here so the close classes and the close effect agree.
  const closeWithEngine =
    hasCaptureBridge() &&
    (config.closeEffect === 'random' || effectsFor('close').some((e) => e.id === config.closeEffect));
  const { getApp } = useInstalledApps();
  const app = getApp(win.appId);
  const areas = useWorkAreas();
  // A covered window hides once it has stayed covered a moment, and shows
  // again in the same render that it stops being covered.
  const [coverSettled, setCoverSettled] = useState(false);
  useEffect(() => {
    if (!covered) return;
    const timer = setTimeout(() => setCoverSettled(true), COVERED_HIDE_MS);
    return () => {
      clearTimeout(timer);
      setCoverSettled(false);
    };
  }, [covered]);
  // For gesture handlers, which shouldn't re-bind whenever monitors change.
  const areasRef = useRef(areas);
  useLayoutEffect(() => {
    areasRef.current = areas;
  });
  const sectionRef = useRef<HTMLElement>(null);
  // A page in full screen is on top of everything, whatever the windows say
  // (its window was moved under another, off a monitor that went away).
  // Hidden, it would leave Blink holding the desktop inert behind it.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = sectionRef.current;
      setFullscreen(
        !!el && (!!el.querySelector(':fullscreen') || guestElements().some((g) => el.contains(g) && isGuestFullscreen(g))),
      );
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const hiddenBehind = covered && coverSettled && !fullscreen;
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
    /**
     * Dragging a tiled window: the tiled window under the pointer it would
     * trade places with, and the pointer, in workspace coordinates.
     */
    tile?: { target: string | null; key: string; px: number; py: number };
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
  // the restore warp. Kept decoded, so restore's first frame paints at once.
  // `null` until the first minimize, or whenever no shell capture bridge is
  // available (a plain browser), in which case the genie falls back to
  // warping the live element.
  const snapshotRef = useRef<HTMLImageElement | null>(null);
  // The effect the window last minimized with, which restore plays back.
  const minimizedWith = useRef<PlayedEffect | null>(null);

  // Custom title-bar content published by the hosted app (e.g. the browser's
  // tab strip), rendered inline with the window controls. `null` shows the
  // default icon + name. The setter is stable so apps can publish from an
  // effect without re-subscribing.
  const [titlebar, setTitlebar] = useState<ReactNode>(null);
  // The app draws the whole title bar itself, from WindowHeader's pieces.
  const [ownHeader, setOwnHeader] = useState(false);

  // Chrome accent color published by the hosted app (e.g. the loaded page's
  // theme-color), tinting the title bar Safari-style. The raw value comes
  // from an untrusted page, so it's strictly normalized before it's stored
  // in the window manager, where the menu bar also reads it.
  const publishAccent = useCallback(
    (color: string | null) => setAccent(win.id, normalizeThemeColor(color)),
    [setAccent, win.id],
  );

  // What the hosted app says the window is showing; kept in the window
  // manager, where the Dock and the switcher read it.
  const publishTitle = useCallback((title: string | null) => setTitle(win.id, title), [setTitle, win.id]);
  const title = win.title ?? app?.name ?? win.appId;
  const publishIcon = useCallback((icon: string | null) => setIcon(win.id, icon), [setIcon, win.id]);

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
    beginWindowGesture(win.id);
    const el = sectionRef.current;
    if (!el) return;
    el.style.willChange = 'transform';
    el.style.backdropFilter = 'none';
  }, [win.id]);

  const endGesture = useCallback(() => {
    endWindowGesture(win.id);
    const el = sectionRef.current;
    if (!el) return;
    el.style.willChange = '';
    el.style.backdropFilter = '';
  }, [win.id]);

  // A window closed mid-gesture never ends it.
  useEffect(() => () => endWindowGesture(win.id), [win.id]);

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

  // Minimize/restore effects: when the minimized flag flips, play the chosen
  // effect (by default the genie, Compiz's "magic lamp": see
  // src/lib/genie.ts) into / out of the app's dock tile instead of blinking.
  // The window stays mounted either way. Watching the flag here (rather than
  // wrapping the minimize/focus actions) covers every trigger: title-bar
  // button, dock tile clicks and scrolls.
  //
  // Inside the Electron shell the effect runs on a *bitmap snapshot* of the
  // window, not the live element: the section wraps a <webview>/WebGL guest
  // surface, and a projective transform can't composite a guest cheaply - it
  // re-rasterizes the whole surface every frame, which is what made the genie
  // crawl on full-screen windows. A bitmap can also go through a real mesh:
  // src/lib/effects draws it in WebGL, and without WebGL a raster <img> warps
  // with the genie's four-corner CSS transform. The minimize snapshot is
  // cached, with the effect and seed it played, so restore - whose window is
  // off-screen and can't be re-captured - can replay it reversed. Outside the
  // shell (a plain browser: no capture bridge) the genie falls back to
  // warping the live element, as before, whatever effect is chosen.
  const prevMinimized = useRef(win.minimized);
  useLayoutEffect(() => {
    if (prevMinimized.current === win.minimized) return;
    prevMinimized.current = win.minimized;
    const el = sectionRef.current;
    if (!el) return;

    animCancel.current?.();
    animCancel.current = null;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const minimizing = win.minimized;
    // Random draws an effect at minimize; restore plays that one back.
    let played = minimizedWith.current;
    if (minimizing || !played) {
      const resolved = resolveEffect(config.minimizeEffect, 'minimize');
      played = { effect: resolved === 'pop' ? 'none' : resolved, seed: newSeed() };
      minimizedWith.current = played;
    }
    const { effect, seed } = played;
    if (effect === 'none') return;

    // A dock-initiated minimize can catch a still-jiggling window; the
    // effect owns the transform from here.
    stopWobble(false);

    // The rendered rect in workspace coordinates. Offsets rather than the
    // stored geometry, so maximized/tiled windows - whose layout is
    // CSS-percentage-driven - measure correctly; visibility:hidden keeps
    // layout intact, so a just-minimized window still measures.
    const winRect = offsetRect(el);
    if (winRect.width === 0 || winRect.height === 0) return;

    const parent = el.parentElement;
    const target = dockTarget(parent, app?.dockAs ?? win.appId);

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

    // Play the effect on the decoded snapshot - in WebGL, or failing that
    // the genie as an overlay <img> - hiding the live section for the whole
    // timeline. `showSection` hands the section's styles back to React; it's
    // shared by onDone and cancel (which onDone never covers).
    const playSnapshot = (snapshot: HTMLImageElement) => {
      if (!parent) return runLiveGenie();
      const showSection = () => {
        el.style.pointerEvents = '';
        el.style.visibility = minimizing ? 'hidden' : '';
      };

      const effectCancel = runWindowEffect(
        parent,
        snapshot,
        effect,
        winRect,
        target,
        minimizing ? 'out' : 'in',
        win.z,
        seed,
        () => {
          animCancel.current = null;
          showSection();
        },
      );
      if (effectCancel) {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        animCancel.current = () => {
          effectCancel();
          showSection();
        };
        return;
      }

      const img = document.createElement('img');
      img.src = snapshot.src;
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
        showSection();
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

    const capture = captureSection(el);

    if (minimizing && capture) {
      // Snapshot the window at rest, then play the bitmap. Keep the live
      // section visible for the capture (React just committed it hidden);
      // the overlay takes over the instant the capture resolves.
      el.style.visibility = 'visible';
      el.style.pointerEvents = 'none';
      let cancelled = false;
      animCancel.current = () => {
        cancelled = true;
        el.style.pointerEvents = '';
        el.style.visibility = 'hidden';
      };
      capture
        .then((snapshot) => {
          if (cancelled) return;
          snapshotRef.current = snapshot;
          playSnapshot(snapshot);
        })
        .catch(() => {
          if (!cancelled) runLiveGenie();
        });
      return;
    }

    // Restore replays the cached minimize bitmap reversed; the gone first
    // frame is painted synchronously (runWindowEffect's contract), so the
    // full-size window never flashes before the effect brings it back.
    if (!minimizing && hasCaptureBridge() && snapshotRef.current) {
      playSnapshot(snapshotRef.current);
      return;
    }

    runLiveGenie();
    // config.minimizeEffect is read when the flag flips, and a change to it
    // alone returns at the guard above.
  }, [win.minimized, win.appId, app?.dockAs, win.z, config.minimizeEffect, beginGesture, endGesture, stopWobble]);

  // Maximize/restore/tile transitions FLIP from the previous committed rect
  // to the new one: React swaps the geometry instantly (CSS percentages or
  // restored pixels), then this effect plays a compositor-only
  // translate+scale from the old rect down to identity, decelerating into
  // place. Skipped mid-gesture: a tear-away drag already moves the window
  // under the pointer, and animating against it would fight the cursor.
  // Tiled windows FLIP the same way whenever the layout moves their tile.
  const tiledKey = win.tiled ? `${win.tiled.x},${win.tiled.y},${win.tiled.width},${win.tiled.height}` : '';
  const prevMode = useRef({ maximized: win.maximized, snapped: win.snapped, tiledKey });
  useLayoutEffect(() => {
    const prev = prevMode.current;
    prevMode.current = { maximized: win.maximized, snapped: win.snapped, tiledKey };
    if (prev.maximized === win.maximized && prev.snapped === win.snapped && prev.tiledKey === tiledKey) return;
    const el = sectionRef.current;
    const from = paintedRect.current;
    if (!el || !from || win.minimized || win.away) return;
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
  }, [win.maximized, win.snapped, win.minimized, win.away, tiledKey, beginGesture, endGesture, stopWobble]);

  // A window going off to another workspace takes keyboard focus with it,
  // or typing would go on into a window nobody can see.
  useEffect(() => {
    if (!win.away) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && sectionRef.current?.contains(active)) active.blur();
  }, [win.away]);

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

  // Close: close() only marks the window `closing`, and this effect sees it
  // out. With the CSS pop (the default), the exit animation (a reverse of
  // the open pop, via the animate-out classes below) plays on the live
  // element and its animationend calls destroy() for the real removal; a
  // safety-net timer makes sure a missed animationend can never leave an
  // inert ghost window behind. Any other effect plays on a snapshot, like
  // minimize, and destroys the window when it's done. Reduced motion, a
  // minimized (invisible) window, an uninstalled app rendering null and the
  // `none` effect have nothing to wait for. It runs once per close.
  const closeRun = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!win.closing || closeRun.current) return;
    animCancel.current?.();
    animCancel.current = null;
    stopWobble(false);
    const el = sectionRef.current;
    const effect = resolveEffect(config.closeEffect, 'close');
    if (
      !el ||
      win.minimized ||
      effect === 'none' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      destroy(win.id);
      return;
    }
    if (effect === 'pop' || !closeWithEngine) {
      const timer = window.setTimeout(() => destroy(win.id), 400);
      closeRun.current = () => window.clearTimeout(timer);
      return;
    }

    const parent = el.parentElement;
    const capture = captureSection(el);
    if (!parent || !capture) {
      destroy(win.id);
      return;
    }
    const winRect = offsetRect(el);
    let cancelled = false;
    const safety = window.setTimeout(() => destroy(win.id), effect.duration + 3000);
    // Only the timers: the effect's canvas sits in the workspace, outlives
    // the window it showed, and removes itself.
    closeRun.current = () => {
      cancelled = true;
      window.clearTimeout(safety);
    };
    capture
      .then((snapshot) => {
        if (cancelled) return;
        const played = runWindowEffect(parent, snapshot, effect, winRect, null, 'out', win.z, newSeed(), () =>
          destroy(win.id),
        );
        if (played) el.style.visibility = 'hidden';
        else destroy(win.id);
      })
      .catch(() => {
        if (!cancelled) destroy(win.id);
      });
  }, [win.closing, win.minimized, win.id, win.z, config.closeEffect, closeWithEngine, destroy, stopWobble]);
  useEffect(() => () => closeRun.current?.(), []);

  // Settings' effect tiles: play an effect out and back in on this window,
  // through the same snapshot path as minimize (or, for the pop, the same
  // fade and zoom as the CSS), leaving the window as it was.
  useEffect(
    () =>
      onEffectPreview(win.id, (event: EffectEvent, choice: string) => {
        const el = sectionRef.current;
        const parent = el?.parentElement;
        if (!el || !parent || animCancel.current || win.minimized || win.closing) return;
        const effect = resolveEffect(choice, event);
        if (effect === 'none') return;
        if (effect === 'pop') {
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          const gone = { opacity: 0, scale: '0.95' };
          const pop = el.animate(
            [{ opacity: 1, scale: '1' }, { ...gone, offset: 0.25 }, { ...gone, offset: 0.7 }, { opacity: 1, scale: '1' }],
            { duration: 650, easing: 'ease-out' },
          );
          animCancel.current = () => pop.cancel();
          pop.onfinish = () => {
            animCancel.current = null;
          };
          return;
        }
        const capture = captureSection(el);
        if (!capture) return;
        stopWobble(false);
        const winRect = offsetRect(el);
        const target = event === 'minimize' ? dockTarget(parent, app?.dockAs ?? win.appId) : null;
        const seed = newSeed();
        let cancelled = false;
        let current: (() => void) | null = null;
        const show = () => {
          el.style.visibility = '';
          el.style.pointerEvents = '';
        };
        const done = () => {
          animCancel.current = null;
          show();
        };
        el.style.pointerEvents = 'none';
        animCancel.current = () => {
          cancelled = true;
          current?.();
          show();
        };
        capture
          .then((snapshot) => {
            if (cancelled) return;
            current = runWindowEffect(parent, snapshot, effect, winRect, target, 'out', win.z, seed, () => {
              // Gone for a beat, then back.
              const timer = window.setTimeout(() => {
                if (cancelled) return;
                current = runWindowEffect(parent, snapshot, effect, winRect, target, 'in', win.z, seed, done);
                if (!current) done();
              }, 300);
              current = () => window.clearTimeout(timer);
            });
            if (current) el.style.visibility = 'hidden';
            else done();
          })
          .catch(() => {
            if (!cancelled) done();
          });
      }),
    [win.id, win.minimized, win.closing, win.z, win.appId, app?.dockAs, stopWobble],
  );

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
      if (win.tiled && !win.maximized) {
        // A tiled window drags rigidly, and on release trades places with
        // the tile it's dropped on (see onPointerMove and endDrag).
        stopWobble(false);
        dragState.current = {
          px: e.clientX,
          py: e.clientY,
          wx: win.tiled.x,
          wy: win.tiled.y,
          x: win.tiled.x,
          y: win.tiled.y,
          wsLeft,
          wsTop,
          tearAway: null,
          snap: null,
          tile: { target: null, key: '', px: e.clientX - wsLeft, py: e.clientY - wsTop },
        };
        beginGesture();
        return;
      }
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
    [focus, win.id, win.x, win.y, win.width, win.height, win.maximized, win.snapped, win.restore, win.tiled, beginGesture, config.wobblyWindows, stopWobble, wobbleFrame],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on interactive title-bar controls: the window
      // controls (buttons) and any app-provided controls (e.g. tab strip
      // tabs, which are role="tab" divs). Capturing the pointer for a drag
      // here would swallow their click, so bail before setPointerCapture.
      // A right press opens the title bar's menu instead.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, input, textarea, [role="tab"], [data-window-no-drag]')) return;
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

      if (s.tile) {
        s.x = s.wx + (e.clientX - s.px);
        s.y = s.wy + (e.clientY - s.py);
        s.tile.px = px;
        s.tile.py = py;
        el.style.transform = `translate3d(${s.x - s.wx}px, ${s.y - s.wy}px, 0)`;
        // Outline where it would go: the tile under the pointer, or a whole
        // other monitor to tile on.
        const under = tileUnder(e.clientX, e.clientY, win.id);
        const area = under ? null : areaNear(areas, px, py);
        const home = areaFor(areas, { x: win.x, y: win.y, width: win.width, height: win.height });
        const elsewhere = area && area.id !== home.id ? area : null;
        const key = under ? `tile:${under.id}` : elsewhere ? `area:${elsewhere.id}` : '';
        if (key !== s.tile.key) {
          s.tile.key = key;
          s.tile.target = under?.id ?? null;
          setSnapHint(under?.rect ?? elsewhere);
        }
        return;
      }

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
    [beginGesture, unmaximize, win.id, win.x, win.y, win.width, win.height, config.wobblyWindows, stopWobble, wobbleFrame, renderWobble],
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

      if (s.tile) {
        setSnapHint(null);
        if (el) el.style.transform = '';
        endGesture();
        if (s.x === s.wx && s.y === s.wy) return;
        // The FLIP into the new tile starts from where it was let go.
        if (el) paintedRect.current = { x: s.x, y: s.y, width: el.offsetWidth, height: el.offsetHeight };
        dropTile(win.id, s.tile.target, s.tile.px, s.tile.py);
        return;
      }

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
    [move, win.id, win.width, win.height, endGesture, renderWobble, maximize, tile, stopWobble, dropTile],
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
      if (win.maximized || win.snapped || win.tiled) return false;
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
    [focus, win.id, win.x, win.y, win.width, win.height, win.maximized, win.snapped, win.tiled, beginGesture, stopWobble],
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
  // A covered window is hidden the same way: unlike a page's own
  // visibilityState, that is what stops Chromium painting it and running its
  // requestAnimationFrame loops.
  // So is a window on a workspace its monitor isn't showing.
  if (win.minimized || win.away || hiddenBehind) geometry.visibility = 'hidden';

  // Maximized and edge-tiled windows sit flush against the workspace edges:
  // square corners, no floating shadow/ring.
  const flush = win.maximized || win.snapped !== null;
  // A window whose app draws its own title bar (or none) is just the app:
  // no title bar, border, shadow or background, and resize handles only
  // outside it.
  const frameless = win.frameless;

  // Sanitized chrome accent. Theme tokens can't guarantee contrast against
  // an arbitrary page color, so tinted chrome flips its foregrounds to plain
  // black/white based on the accent's luminance.
  const accent = win.accent;
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
  // App-published title-bar content (the browser's tabs) is styled with theme
  // tokens, so re-point them at the accent the same way.
  const titlebarTint = accent ? (themeColorTokens(accent) as CSSProperties) : undefined;

  // Din's title bar, or the pieces of it an app lays out itself (WindowHeader).
  const frame: WindowFrame = {
    win,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    minimize: () => {
      stopWobble(false);
      minimize(win.id);
    },
    toggleMaximize: () => {
      stopWobble(false);
      toggleMaximize(win.id);
    },
    close: () => close(win.id),
    muted: chromeMuted,
    hover: chromeHover,
  };
  const ownsHeader = ownHeader && !frameless;

  return (
    <section
      ref={sectionRef}
      aria-label={title}
      data-window-id={win.id}
      data-tiled={win.tiled && !win.maximized ? '' : undefined}
      data-app-name={app?.name}
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
        // until destroy() commits. animation-duration-*, not duration-*:
        // the latter also sets transition-duration, which with the default
        // `transition-property: all` holds a hidden window (minimize, the
        // genie's snapshot hand-off) visible for the whole transition.
        win.closing && closeWithEngine
          ? 'pointer-events-none'
          : win.closing
          ? 'pointer-events-none motion-safe:animate-out motion-safe:fade-out-0 motion-safe:zoom-out-95 motion-safe:animation-duration-150 motion-safe:fill-mode-forwards'
          : 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:animation-duration-200',
        flush || frameless
          ? 'rounded-none'
          : 'rounded-xl border border-border/60 shadow-2xl ring-1 ring-black/20 transition-shadow',
        !flush && !frameless && isTop && 'ring-ring/50',
        // Tiles sit side by side, so the focused one needs a border that
        // shows, like Hyprland's active border.
        !flush && !frameless && isTop && win.tiled && 'ring-2 ring-primary/80',
      )}
    >
      <WindowFrameContext.Provider value={frame}>
      {!frameless && !ownsHeader && (
        <WindowDragRegion
          style={accent ? { backgroundColor: accent } : undefined}
          className={cn(
            // At least 36px; a tab strip makes it 40.
            'flex min-h-9 shrink-0 items-center gap-2 rounded-t-[inherit] pr-3',
            // The content area's background, so the two read as one surface
            // (and a toolbar with none of its own, like the browser's,
            // continues it).
            !accent && 'bg-background/80',
            titlebar ? 'pl-2' : 'pl-3',
          )}
        >
          {titlebar ? (
            // The app owns the flexible region (drag still works on its empty
            // space; interactive controls inside handle their own events).
            <div className="flex min-w-0 flex-1 items-center self-stretch" style={titlebarTint}>
              {/* Rendered here rather than under the app, so it needs its own
                  chrome: a window's only tab drags the window. */}
              <WindowChromeContext.Provider value={chrome}>{titlebar}</WindowChromeContext.Provider>
            </div>
          ) : (
            <>
              <AppIcon icon={win.icon ?? app.icon} className={cn('size-4 shrink-0', chromeMuted)} />
              {/* In the theme's title font, if it has one (else the var is unset and it inherits). */}
              <span className={cn('flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium', chromeText)}>
                {title}
              </span>
            </>
          )}
          <WindowControls />
        </WindowDragRegion>
      )}

      <div
        className={cn(
          'relative flex-1 overflow-hidden',
          ownsHeader ? 'rounded-[inherit]' : 'rounded-b-[inherit]',
          !frameless && 'bg-background/80',
        )}
      >
        <WindowOwnHeaderContext.Provider value={setOwnHeader}>
        <WindowFocusContext.Provider value={isTop}>
          <WindowTitlebarContext.Provider value={setTitlebar}>
            <WindowTitleContext.Provider value={publishTitle}>
              <WindowIconContext.Provider value={publishIcon}>
                <WindowChromeContext.Provider value={chrome}>
                  <WindowAccentContext.Provider value={publishAccent}>
                    {/* Built-in apps are code-split (React.lazy); the fallback shows
                        while an app's chunk loads on its first launch. */}
                    <WindowAppContext.Provider value={app.id}>
                      <WindowVisibleContext.Provider value={!win.minimized && !win.away && !hiddenBehind}>
                        <Suspense
                          fallback={<div className="size-full animate-pulse bg-muted/40" />}
                        >
                          <WindowContent component={app.component} windowId={win.id} params={win.params} />
                        </Suspense>
                      </WindowVisibleContext.Provider>
                    </WindowAppContext.Provider>
                  </WindowAccentContext.Provider>
                </WindowChromeContext.Provider>
              </WindowIconContext.Provider>
            </WindowTitleContext.Provider>
          </WindowTitlebarContext.Provider>
        </WindowFocusContext.Provider>
        </WindowOwnHeaderContext.Provider>
      </div>
      </WindowFrameContext.Provider>

      {/* Tiled windows are sized by the layout (Super+- / Super+=). */}
      {!flush &&
        !win.tiled &&
        (frameless ? FRAMELESS_RESIZE_HANDLES : RESIZE_HANDLES).map(({ dir, className }) => (
          <div
            key={dir}
            onPointerDown={onResizePointerDown(dir)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            className={cn('absolute z-10 touch-none', className)}
          />
        ))}

      {(superHeld || superDragging) && !win.minimized && !win.closing && !win.away && (
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
