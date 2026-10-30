import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isGuestElement } from '@/platform/guest';
import { Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useAppContext } from '@/hooks/useAppContext';
import { useAppData } from '@/hooks/useAppData';
import { useDragReorder } from '@/hooks/useDragReorder';
import { useLaunching, useLaunchingApps } from '@/lib/appLaunches';
import { DRAG_MIME, acceptDrag, currentDrag, subscribeDrag } from '@/lib/dinDrag';
import { dockTakes, openDropped, type DroppedItem } from '@/lib/dockDrop';
import { poof } from '@/lib/dockPoof';
import { getFsBridge } from '@/lib/fs';
import { registerDockTile } from '@/lib/dockTiles';
import { useNotificationCenter } from '@/lib/notificationCenter';
import { isNsiteAppId } from '@/lib/nsiteApps';
import { cn } from '@/lib/utils';
import { appsDockedAs } from '@/lib/apps';
import type { AppDefinition } from '@/lib/apps';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useMonitors, useWorkAreas } from '@/contexts/MonitorsContext';
import { focusedWindow, windowRect, type WindowState } from '@/hooks/useWindows';
import type { DockStyle } from '@/contexts/AppContext';
import { DOCK_STYLES } from '@/lib/dockStyles';

/** One window in a Dock tile. */
interface DockWindow {
  id: string;
  /** Stacking order; the frontmost window has the highest. */
  z: number;
  minimized: boolean;
  /** What the window's app says it's showing, if anything. */
  title: string | null;
  /** The icon the window's app gave it, if any. */
  icon: string | null;
}

/** How a tile acts on its app and its windows. */
interface DockControls {
  /** Launch a new instance. */
  open: (appId: string, params?: Record<string, unknown>) => void;
  /** Raise and focus a window. */
  focus: (id: string) => void;
  minimize: (id: string) => void;
  /** Close every window of the app. */
  closeAll: (appId: string, windows: DockWindow[]) => void;
}

/** Apps kept in the Dock out of the box. */
const DEFAULT_PINNED = ['file-browser', 'settings', 'web-browser', 'app-store'];

const PinnedAppsSchema = z.array(z.string());

/**
 * Width and height of one dock slot at rest in the previews, in px (icon plus
 * breathing room). The Dock's own is AppConfig's dockSize.
 */
const BASE_WIDTH = 80;
/** Distance, in slots, over which magnification falls off to nothing. */
const FALLOFF = 2.5;

/** Cosine-eased magnification: 1 at rest, `maxScale` under the cursor. */
function magnify(distance: number, maxScale: number): number {
  if (distance >= FALLOFF) return 1;
  return 1 + ((maxScale - 1) * (Math.cos((distance / FALLOFF) * Math.PI) + 1)) / 2;
}

/**
 * How far a fully magnified tile reaches above the bottom of the dock, in px:
 * the icon (the slot less its 5% insets) sitting on its 12.5% bottom offset.
 */
function magnifiedHeight(size: number, maxScale: number): number {
  return size * maxScale * 0.9 + size * 0.125;
}

/**
 * How each backdrop pads the strip of tiles: room around the icons for the
 * backdrop to show, and `lift`, how far the tiles sit above the strip's
 * bottom edge, in px.
 */
const STYLE_LAYOUT: Record<DockStyle, { padding: string; lift: number }> = {
  none: { padding: '', lift: 0 },
  // A floating panel, a little off the bottom edge of the screen.
  modern: { padding: 'px-1.5 pt-2 pb-1', lift: 4 },
  // The shelf flares out past the outermost icons.
  classic: { padding: 'px-6', lift: 0 },
};

/** Height of the hot zone at the screen's bottom edge that reveals a hidden dock, in px. */
const REVEAL_ZONE = 8;
/** Extra slack above the dock before a hot-edge reveal retracts, in px. */
const REVEAL_SLACK = 24;
/** Height of the bottom-edge strip a touch swipe has to start in, in px. */
const SWIPE_ZONE = 16;
/** How far a touch has to travel up from the edge to reveal the dock, in px. */
const SWIPE_DISTANCE = 24;

/** How far above the Dock a pinned tile is dragged to remove it, in px. */
const REMOVE_DISTANCE = 48;

/** Wheel travel that steps a tile to its app's next window, in px. */
const WHEEL_STEP = 50;
/** Minimum time between wheel steps, so a touchpad flick doesn't spin through every window, in ms. */
const WHEEL_COOLDOWN = 120;
/** Most running-window dots drawn under one tile. */
const MAX_DOTS = 4;

/**
 * macOS-style Dock: a centered strip of app tiles that magnify as the
 * pointer sweeps across them, over nothing or over a macOS backdrop
 * (AppConfig's dockMagnification and dockStyle).
 *
 * The dock overlays the bottom edge of the primary monitor and hides itself
 * intelligently: whenever the focused window intersects its footprint
 * (including a window maximized there, which fills the whole monitor) it
 * slides off-screen, and it slides back when the pointer reaches the bottom
 * edge of that monitor, when a finger swipes up from that edge, or when the
 * focused window no longer overlaps it.
 *
 * Shows pinned apps first (kept on this device), then any
 * running apps that aren't pinned. Each tile groups its app's windows, with
 * a dot under it per window (and, for an installed web app or nsite, a
 * count of its unread notifications on the icon's corner): click launches, toggles, or cycles through
 * them, the scroll wheel cycles too, middle-click always opens a new window,
 * right-click offers pin/unpin, close, and uninstall, dragging an
 * unpinned tile left among the pinned ones pins it, and dragging a pinned
 * one up off the Dock unpins it. Files dropped on a tile open in its app,
 * if it opens them (src/lib/dockDrop.ts). A divider separates the
 * pinned apps from the rest, and right-clicking it or the Dock's backdrop
 * between tiles offers the Dock's own settings, as on macOS.
 */
export function Dock({
  workspaceRef,
}: {
  /** The workspace <main> element; window x/y coordinates are relative to it. */
  workspaceRef: React.RefObject<HTMLElement | null>;
}) {
  const { windows } = useWindowManager();
  const { primary } = useMonitors();
  const areas = useWorkAreas();
  const dinActions = useWindowActions();
  const { closeApp } = dinActions;
  const { getApp, canUninstall, uninstallApp } = useInstalledApps();
  // Pinned apps belong to this device and never sync to relays, seeded from
  // the pre-app-data localStorage key on first run.
  const [pinned, setPinned] = useAppData<string[]>(
    'pinned-apps',
    PinnedAppsSchema,
    DEFAULT_PINNED,
    { legacyKey: 'desktop:pinned-apps', localOnly: true },
  );

  // Stable handlers so memo(DockItem) isn't defeated by fresh closures on
  // every dock re-render (the dock re-renders on every window commit).
  const togglePin = useCallback(
    (appId: string) =>
      setPinned((prev) =>
        prev.includes(appId)
          ? prev.filter((id) => id !== appId)
          : [...prev, appId],
      ),
    [setPinned],
  );

  /** Uninstall an app: close its windows, unpin it, drop the entry. */
  const uninstall = useCallback(
    (appId: string) => {
      closeApp(appId);
      setPinned((prev) => prev.filter((id) => id !== appId));
      uninstallApp(appId);
    },
    [closeApp, setPinned, uninstallApp],
  );

  // Din's own window actions, bundled into the shape a tile consumes. The
  // action set is referentially stable, so this object is too.
  const dinControls = useMemo<DockControls>(
    () => ({
      open: dinActions.open,
      focus: dinActions.focus,
      minimize: dinActions.minimize,
      closeAll: (appId) => {
        for (const id of [appId, ...appsDockedAs(appId)]) dinActions.closeApp(id);
      },
    }),
    [dinActions],
  );

  // Where unpinned tiles have been dragged to among themselves. Local to this
  // session, unlike the pins; apps not in it keep launch order after it.
  const [unpinnedOrder, setUnpinnedOrder] = useState<string[]>([]);

  // One dock tile per app: pinned apps first in pin order, then any
  // running apps that aren't pinned, in the order they were dragged into or
  // else launch order. An app still launching counts as running, so it has a
  // tile to bounce on while its window is on the way.
  const launching = useLaunchingApps();
  // The tile a window goes under: its app's, or the one its app docks as.
  const tileOf = (appId: string) => getApp(appId)?.dockAs ?? appId;
  const running = [...new Set([...windows.map((w) => tileOf(w.appId)), ...launching])];
  const pinnedIds = pinned.filter((id) => getApp(id));
  const rank = (id: string) => {
    const i = unpinnedOrder.indexOf(id);
    return i === -1 ? unpinnedOrder.length : i;
  };
  const unpinnedIds = running
    .filter((id) => !pinned.includes(id) && getApp(id))
    .sort((a, b) => rank(a) - rank(b));
  const entryIds = [...pinnedIds, ...unpinnedIds];

  // Unread notifications in the notification center, per tile, for the
  // installed web apps and nsites that sent them.
  const { notifications } = useNotificationCenter();
  const unread = new Map<string, number>();
  for (const n of notifications) {
    const appId = n.source.appId;
    if (!n.history || n.read || !appId) continue;
    const tile = tileOf(appId);
    unread.set(tile, (unread.get(tile) ?? 0) + 1);
  }

  // The Din window that currently holds focus: highest z among visible ones.
  const activeWindow = focusedWindow(windows);

  // Magnification is pointer-driven eye candy; skip it entirely for users
  // who prefer reduced motion (tiles then behave like plain buttons).
  const reduceMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const { config } = useAppContext();
  const magnifies = config.dockMagnification && !reduceMotion;
  const size = config.dockSize;
  const maxScale = config.dockMagnificationScale;
  const dockStyle = config.dockStyle;
  const layout = STYLE_LAYOUT[dockStyle];

  // Cursor-driven magnification bypasses React entirely: pointer moves are
  // coalesced to one requestAnimationFrame tick, which computes each tile's
  // width and writes it straight onto the DOM node. Routing this through
  // setState re-rendered the whole dock (every tile plus its Radix menu
  // tree) per mouse event - mice report faster than the frame rate - and
  // interleaved per-event getBoundingClientRect reads with animating widths,
  // forcing synchronous layouts. That made sweeping across the dock feel
  // sluggish, especially under software rendering.
  //
  // React always renders tiles at the rest size and never touches width
  // again until that size changes, so these direct writes stick.
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const pointerX = useRef<number | null>(null);
  const rafId = useRef(0);
  // Magnified tiles grow up out of the 80px strip, but a tile's neighbors are
  // shorter, so sliding sideways along the top of a big icon would cross empty
  // space outside the strip, end the hover, and collapse the dock under the
  // cursor. While magnified, this pad covers the strip's whole width up to a
  // fully magnified icon's height so the hover holds.
  const hoverPadRef = useRef<HTMLDivElement>(null);
  const magnified = useRef(false);
  // The visible strip of tiles; its untransformed layout box is the dock's
  // footprint for window-intersection checks (offsets ignore the slide
  // transform, unlike getBoundingClientRect).
  const stripRef = useRef<HTMLDivElement>(null);

  // Where the cursor sat within the tile under it, in slots from that tile's
  // center, as of the last paint before a drag. A drag keeps it, so the
  // magnification stays exactly as it was when the tile was picked up.
  const grabFrac = useRef(0);

  // Tiles come from the DOM in DOM order, not from entryIds, so a paint run
  // right after a drag reorders the tiles (before effects refresh any
  // closures) already sizes them for the new order.
  const paint = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tiles = [...strip.querySelectorAll<HTMLElement>(':scope > [data-dock-tile]')];
    // Cursor position in "slot" units (fractional index into the tiles), or
    // null when the pointer is off the dock. While a tile is dragged, it's
    // the dragged tile's slot: the tile rides the pointer and overlaps its
    // neighbors, so hit-testing would flip between them, and the sizes have
    // to follow the order, which only changes when the drag reorders. The
    // reorder hook relies on that: it measures layout right after a reorder.
    // Otherwise it comes from the tile under the pointer, so the math stays
    // stable while widths animate; rects are read before the width writes
    // below, so the frame does one layout, not many. Between two tiles (over
    // the divider) it's halfway from one to the other.
    let cursor: number | null = null;
    const dragged = tiles.findIndex((el) => el.dataset.reorderDragging !== undefined);
    const clientX = pointerX.current;
    if (dragged !== -1) {
      cursor = dragged + grabFrac.current;
    } else if (clientX !== null) {
      let prevRight: number | null = null;
      tiles.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (clientX >= rect.left && clientX < rect.right) {
          grabFrac.current = (clientX - rect.left) / rect.width - 0.5;
          cursor = i + grabFrac.current;
        } else if (prevRight !== null && clientX >= prevRight && clientX < rect.left) {
          cursor = i - 0.5;
        }
        prevRight = rect.right;
      });
    }
    tiles.forEach((el, i) => {
      const scale = cursor === null ? 1 : magnify(Math.abs(i - cursor), maxScale);
      el.style.width = `${Math.round(size * scale)}px`;
    });
    magnified.current = cursor !== null;
    if (hoverPadRef.current) hoverPadRef.current.hidden = cursor === null;
  }, [size, maxScale]);

  const scheduleMagnify = useCallback(
    (clientX: number | null) => {
      if (!magnifies) return;
      pointerX.current = clientX;
      if (rafId.current) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        paint();
      });
    },
    [magnifies, paint],
  );

  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  // Turning magnification off puts every tile back at rest.
  useEffect(() => {
    if (magnifies) return;
    pointerX.current = null;
    paint();
  }, [magnifies, paint]);

  // Any tile can be dragged. Among the pinned tiles the new order is the pin
  // order, so it roams with the pins; pins for apps that aren't installed
  // here stay in the list, after the visible ones. Dragging an unpinned tile
  // left in among the pinned ones pins it there. Pinned tiles stay pinned:
  // they can't be dragged past the last pinned slot (unpinning is in the
  // tile's menu or a drag up off the Dock, and an unpinned app with no
  // windows would vanish mid-drag).
  const reorder = useDragReorder({
    ids: entryIds,
    onMove: (appId, to) => {
      if (pinned.includes(appId) || to < pinnedIds.length) {
        setPinned((prev) => {
          const shown = prev.filter((id) => getApp(id) && id !== appId);
          shown.splice(to, 0, appId);
          return [...shown, ...prev.filter((id) => !getApp(id))];
        });
      } else {
        const order = unpinnedIds.filter((id) => id !== appId);
        order.splice(to - pinnedIds.length, 0, appId);
        setUnpinnedOrder(order);
      }
    },
    constrain: (appId, to) =>
      pinned.includes(appId) ? Math.min(to, pinnedIds.length - 1) : to,
    relayout: magnifies ? paint : undefined,
    // As on macOS, a pinned tile dragged well up off the Dock is unpinned
    // when it's let go, in a puff of smoke; one with windows open stays on as
    // a running app.
    tearOff: {
      enabled: (appId) => pinned.includes(appId),
      // Clear of a magnified icon, which reaches above the strip.
      distance: (magnifies ? magnifiedHeight(size, maxScale) - size : 0) + REMOVE_DISTANCE,
      decorateGhost: (ghost) => {
        ghost.style.boxShadow = '';
        ghost.querySelector('[data-dock-dots]')?.remove();
        ghost.querySelector('[data-dock-badge]')?.remove();
        const label = ghost.querySelector<HTMLElement>('[data-dock-label]');
        if (label) {
          label.textContent = 'Remove';
          label.style.opacity = '1';
        }
      },
      onDrop: (appId) => setPinned((prev) => prev.filter((id) => id !== appId)),
      dismissGhost: poof,
    },
  });
  const dragging = reorder.draggingId !== null;

  /** Stable tile-ref registrar (identity matters for memo'd DockItems). */
  const { register: registerReorder } = reorder;
  const registerRef = useCallback((appId: string, el: HTMLDivElement | null) => {
    if (el) itemRefs.current.set(appId, el);
    else itemRefs.current.delete(appId);
    registerReorder(appId, el);
    // Mirror into the module-level registry the genie minimize animation
    // targets (see src/lib/dockTiles.ts).
    registerDockTile(appId, el);
  }, [registerReorder]);

  // Does the focused window overlap the dock's footprint? Windows behind it
  // don't count, so a small window raised over a maximized one brings the
  // dock back. Geometry comes from committed window-manager state, so this
  // re-evaluates on every move/resize/open/close/minimize/maximize/focus
  // commit.
  const [intersecting, setIntersecting] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const workspace = workspaceRef.current;
      const strip = stripRef.current;
      if (!workspace || !strip) {
        setIntersecting(false);
        return;
      }
      const workspaceRect = workspace.getBoundingClientRect();
      // Dock footprint in viewport coordinates. The footer is pinned to
      // inset-x-0 bottom-0 of the primary monitor, so the strip's offsets
      // are offsets from that monitor's left edge.
      const dockTop = primary.y + primary.height - strip.offsetHeight;
      const dockLeft = primary.x + strip.offsetLeft;
      const dockRight = dockLeft + strip.offsetWidth;
      const overlaps = (w: WindowState) => {
        // Where it's painted: maximized and tiled windows fill their monitor.
        const r = windowRect(w, areas);
        const left = workspaceRect.left + r.x;
        const top = workspaceRect.top + r.y;
        return (
          top + r.height > dockTop &&
          top < primary.y + primary.height &&
          left < dockRight &&
          left + r.width > dockLeft
        );
      };
      setIntersecting(activeWindow !== null && overlaps(activeWindow));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeWindow, entryIds.length, workspaceRef, primary, areas]);

  // Hot-edge reveal: sweeping the pointer into the strip at the very bottom
  // of the screen slides a hidden dock back up; it retracts once the pointer
  // wanders back above the dock. Pointermove (not mousemove) so reveals also
  // fire mid-drag while a window holds pointer capture. The listener only
  // exists while a window overlaps the dock (the only time it can be hidden)
  // and does no layout reads until a reveal is actually in progress, so
  // window drags - which fire pointermove at mouse-report rate - don't pay
  // for a forced reflow per event.
  //
  // Coordinate math alone isn't enough, though: <webview> guests and iframes
  // are foreign surfaces - pointer input over them goes to the guest page and
  // never reaches this document - so with, say, a maximized Browser window the
  // pointermove listener is blind across the whole reveal zone. A real DOM
  // strip at the bottom edge (rendered only while hidden, above the windows)
  // catches the hover instead. Retracting is the mirror-image problem: in the
  // Electron shell, GuestInputHost replays moves over a <webview> as
  // pointermoves, so the listener below sees them; for iframes, a
  // pointerleave check on the footer stands in.
  const [revealed, setRevealed] = useState(false);
  // A reveal only means something while the dock is hideable; drop stale
  // reveals as soon as nothing overlaps (adjust-state-during-render pattern).
  const [wasIntersecting, setWasIntersecting] = useState(intersecting);
  if (wasIntersecting !== intersecting) {
    setWasIntersecting(intersecting);
    if (!intersecting) setRevealed(false);
  }
  //
  // The pointer can also leave the window entirely: a compositor may park a
  // cursor shoved into the bottom edge on the row just past the last one Din
  // covers (cage did), and from there Din gets no pointer events at all - not for a fast throw
  // that skips the hot zone, nor for a slide along the edge. A mouse leaving
  // the window near the primary monitor's bottom edge therefore counts as
  // reaching it.
  useEffect(() => {
    if (!intersecting) return;
    let last: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      // Touch has no hover: a finger only reveals by swiping up from the
      // edge (see the trigger strip below) and retracts by tapping elsewhere.
      if (e.pointerType === 'touch') return;
      last = { x: e.clientX, y: e.clientY };
      // At or past the viewport's bottom edge is the edge itself; past the
      // primary monitor's bottom but inside the viewport is another monitor.
      const fromBottom = e.clientY >= window.innerHeight
        ? 0
        : primary.y + primary.height - e.clientY;
      // Only the primary monitor's bottom edge is the Dock's.
      if (e.clientX < primary.x || e.clientX >= primary.x + primary.width || fromBottom < 0) {
        setRevealed(false);
        return;
      }
      setRevealed((prev) => {
        if (!prev) return fromBottom <= REVEAL_ZONE;
        const dockHeight = magnified.current
          ? magnifiedHeight(size, maxScale) + layout.lift
          : (stripRef.current?.offsetHeight ?? size);
        return fromBottom <= dockHeight + REVEAL_SLACK;
      });
    };
    const onPointerOut = (e: PointerEvent) => {
      // A null relatedTarget on a mouse means it left the window itself.
      if (e.relatedTarget !== null || e.pointerType !== 'mouse' || !last) return;
      const { x, y } = last;
      if (x < primary.x || x >= primary.x + primary.width) return;
      const fromBottom = primary.y + primary.height - y;
      // It left through the bottom if that was the nearest edge, and it was
      // already in the lower part of the screen (a fast throw skips rows).
      const nearest = Math.min(y, x, window.innerWidth - x);
      if (fromBottom >= -1 && fromBottom <= nearest && fromBottom <= primary.height / 4) {
        setRevealed(true);
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerout', onPointerOut);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
    };
  }, [intersecting, primary, layout.lift, size, maxScale]);

  // A swiped-up dock stays until the user touches somewhere else, the way a
  // tablet's does. Capture phase, so windows that stop propagation still
  // dismiss it; the touch itself goes through. Touches inside the dock or in
  // its popups (tile menus are portaled out of the footer)
  // keep it up. A touch on a <webview> or iframe never reaches this document,
  // but it moves focus into the guest, which does.
  const footerRef = useRef<HTMLElement>(null);
  /** Where the current edge swipe's finger went down, if one is in progress. */
  const swipeStartY = useRef<number | null>(null);
  useEffect(() => {
    if (!intersecting || !revealed) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !(e.target instanceof Element)) return;
      if (footerRef.current?.contains(e.target)) return;
      if (e.target.closest('[data-radix-popper-content-wrapper]')) return;
      setRevealed(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      const into = e.target instanceof Element ? e.target : null;
      if (isGuestElement(into) || into?.tagName === 'IFRAME') setRevealed(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [intersecting, revealed]);

  // Keyboard users can still tab into the dock while it's hidden; keep it
  // on-screen whenever any tile holds focus.
  const [focusWithin, setFocusWithin] = useState(false);

  // Hidden only while a window overlaps it and nobody is asking for it.
  const hidden = intersecting && !revealed && !focusWithin;

  // The strip's mouseleave is the only thing that ends magnification, and it
  // doesn't always come. Moves over a <webview> reach this document only as
  // GuestInputHost's synthetic pointermoves, which fire no boundary events;
  // a cursor parked past the screen edge sends nothing at all; and a dock
  // that slides away under a still cursor never sees it leave. Each of those
  // left the last-hovered tile magnified, poking up out of a hidden dock.
  // So a move anywhere outside the strip, the pointer leaving the window,
  // and the dock hiding all collapse it too.
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!magnified.current) return;
      if (e.target instanceof Node && stripRef.current?.contains(e.target)) return;
      scheduleMagnify(null);
    };
    const onPointerOut = (e: PointerEvent) => {
      if (magnified.current && e.relatedTarget === null) scheduleMagnify(null);
    };
    window.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerout', onPointerOut);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
    };
  }, [scheduleMagnify]);
  useEffect(() => {
    if (hidden) scheduleMagnify(null);
  }, [hidden, scheduleMagnify]);

  // Files dragged over a tile, from an app or the desktop: the tile lights
  // up if its app opens them, and opens them when they're dropped there.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  useEffect(() => subscribeDrag(() => {
    if (!currentDrag()) setDropTarget(null);
  }), []);
  /** The app whose tile is at the event's target and takes the drag, if any. */
  const dropAppAt = (e: React.DragEvent): string | null => {
    const tile = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-dock-tile]') : null;
    const appId = tile?.dataset.appId;
    const drag = currentDrag();
    if (!appId || drag?.kind !== 'files' || !e.dataTransfer.types.includes(DRAG_MIME)) return null;
    // Whether each is a folder is only known for an all-folder drag until
    // the drop, which looks.
    const items = drag.paths.map((path) => ({ path, folder: drag.folders }));
    return dockTakes(appId, items) ? appId : null;
  };
  const onDragOver = (e: React.DragEvent) => {
    scheduleMagnify(e.clientX);
    const appId = dropAppAt(e);
    setDropTarget(appId);
    if (!appId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDropTarget(null);
    scheduleMagnify(null);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropTarget(null);
    scheduleMagnify(null);
    const appId = dropAppAt(e);
    if (!appId) return;
    e.preventDefault();
    const entry = acceptDrag(e.dataTransfer.getData(DRAG_MIME), 'copy');
    if (entry?.kind !== 'files') return;
    const fs = getFsBridge();
    void Promise.all(
      entry.paths.map(async (path): Promise<DroppedItem> => ({
        path,
        folder: entry.folders || (await fs?.stat(path).then((st) => st.kind === 'directory', () => false)) === true,
      })),
    ).then((items) => {
      if (dockTakes(appId, items)) openDropped(dinControls.open, appId, items);
    });
  };

  if (entryIds.length === 0) return null;

  return (
    <>
      {/* Hot-edge trigger: a thin strip over the very bottom of the screen,
          present only while the dock is hidden. Unlike the window pointermove
          listener it's a real element above the windows, so it still sees the
          pointer when a <webview> or iframe covers the bottom edge. It also
          catches a finger swiping up from the edge: a touch is implicitly
          captured by the element it lands on, so the whole swipe reports here
          even once it's over a guest surface. Touch needs a taller target than
          a cursor shoved into the edge, hence the larger of the two zones. */}
      {hidden && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-[9999] touch-none"
          style={{ height: Math.max(REVEAL_ZONE, SWIPE_ZONE) }}
          onPointerEnter={(e) => {
            if (e.pointerType !== 'touch') setRevealed(true);
          }}
          // Something dragged to the edge, to drop on a tile.
          onDragEnter={() => setRevealed(true)}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch') swipeStartY.current = e.clientY;
          }}
          onPointerMove={(e) => {
            const startY = swipeStartY.current;
            if (e.pointerType !== 'touch' || startY === null) return;
            if (startY - e.clientY >= SWIPE_DISTANCE) {
              swipeStartY.current = null;
              setRevealed(true);
            }
          }}
          onPointerUp={() => (swipeStartY.current = null)}
          onPointerCancel={() => (swipeStartY.current = null)}
        />
      )}
      <footer
        ref={footerRef}
        aria-label="Dock"
        // pointer-events-none: the footer is a full-width flex shim that only
        // exists to center the strip, but it sits above every window - left
        // as-is, its transparent side regions would swallow clicks on window
        // content in the bottom band (e.g. an app's compose bar). Only the
        // strip re-enables hit-testing; boundary events (onPointerLeave) and
        // bubbling focus events still reach the footer from the strip.
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 z-[9999] flex justify-center',
          'motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out',
          // Past its own height: an icon pokes a little above its tile, and
          // an unread badge on its corner, shadow and all, above that.
          hidden && 'translate-y-[calc(100%+1rem)]',
        )}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocusWithin(false);
          }
        }}
        onPointerLeave={(e) => {
          // Retract when the pointer crosses into a foreign surface: no
          // pointermove will ever arrive from over a <webview>/<iframe>, so
          // the coordinate-based retraction above can't fire. Other exits
          // (menus, slack zone, plain DOM) keep the pointermove semantics.
          const into = e.relatedTarget instanceof Element ? e.relatedTarget : null;
          if (isGuestElement(into) || into?.tagName === 'IFRAME') setRevealed(false);
        }}
      >
        <div
          ref={stripRef}
          data-hidden={hidden || undefined}
          data-style={dockStyle}
          // Explicit auto punches through the footer's none; while hidden the
          // strip goes inert itself (a parent's none no longer covers it), so
          // a mid-slide dock can't catch clicks. Tiles take their clicks on
          // their buttons alone, so the backdrop between them gets its own.
          className={cn(
            'group/dock relative flex items-end',
            layout.padding,
            hidden ? 'pointer-events-none' : 'pointer-events-auto',
          )}
          onMouseMove={(e) => scheduleMagnify(e.clientX)}
          onMouseLeave={() => scheduleMagnify(null)}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Shown only while magnified (see hoverPadRef). First in DOM
              order, so the tiles paint and hit-test above it. */}
          <div
            ref={hoverPadRef}
            aria-hidden
            hidden
            className="absolute inset-x-0 bottom-0"
            style={{ height: magnifiedHeight(size, maxScale) + layout.lift }}
          />
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <DockSurface variant={dockStyle} size={size} />
            </ContextMenuTrigger>
            <DockMenuContent />
          </ContextMenu>
          {entryIds.map((appId, i) => {
            const app = getApp(appId);
            if (!app) return null;
            // Launch order, so cycling visits windows in a fixed sequence.
            // Closing windows are on their way out and can't be focused.
            const appWindows = windows
              .filter((w) => tileOf(w.appId) === appId && !w.closing)
              .map((w) => ({ id: w.id, z: w.z, minimized: w.minimized, title: w.title, icon: w.icon }));
            return (
              <Fragment key={appId}>
                {i === pinnedIds.length && i > 0 && <DockDivider variant={dockStyle} size={size} />}
                <DockItem
                  app={app}
                  size={size}
                  registerRef={registerRef}
                  appWindows={appWindows}
                  activeWindowId={activeWindow?.id ?? null}
                  controls={dinControls}
                  isPinned={pinned.includes(appId)}
                  reordering={dragging}
                  dropping={dropTarget === appId}
                  unread={app.web || isNsiteAppId(app.id) ? (unread.get(appId) ?? 0) : 0}
                  onTogglePin={togglePin}
                  onDragPointerDown={reorder.onPointerDown}
                  onUninstall={canUninstall(appId) ? uninstall : undefined}
                />
              </Fragment>
            );
          })}
        </div>
      </footer>
    </>
  );
}

/**
 * A single dock tile for one app.
 *
 * - no windows: click launches the app
 * - one window: click toggles it (focus if not active, minimize if active)
 * - multiple windows: click brings the app forward, then cycles which of
 *   its windows is on top
 * - scrolling over the tile cycles through its windows, in either direction
 * - middle-click always opens a new window
 * - right-click: new window, pin/unpin, close all, uninstall
 * - dragging a tile moves it; dropping an unpinned one among the pinned
 *   ones pins it, and dropping a pinned one well above the Dock unpins it
 * - files dropped on it open in the app
 *
 * Memoized: the dock re-renders on every window commit, but a tile (and its
 * Radix context-menu tree) only re-renders when its own app's
 * windows, active state, or pin state actually changed. `appWindows` is
 * rebuilt on every parent render, so the comparator compares its entries
 * field by field rather than by identity.
 */
const DockItem = memo(function DockItem({
  app,
  size,
  registerRef,
  appWindows,
  activeWindowId,
  controls,
  isPinned,
  reordering,
  dropping,
  unread,
  onTogglePin,
  onDragPointerDown,
  onUninstall,
}: {
  app: AppDefinition;
  /** Width and height of the tile at rest, in px. */
  size: number;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: DockWindow[];
  activeWindowId: string | null;
  /** The window manager's actions, in the shape a tile consumes. */
  controls: DockControls;
  isPinned: boolean;
  /**
   * A tile is being dragged. Widths then jump rather than animate: the
   * reorder measures where tiles land right after each move.
   */
  reordering: boolean;
  /** Files dragged over the tile that its app opens: dropping them opens them. */
  dropping: boolean;
  /** Unread notifications the app sent, badged on the tile. */
  unread: number;
  onTogglePin: (appId: string) => void;
  /** Starts a drag to reorder the tiles. */
  onDragPointerDown: (appId: string, e: React.PointerEvent<HTMLElement>) => void;
  /** Present only for installed web apps; removes the app entirely. */
  onUninstall?: (appId: string) => void;
}) {
  const { open, focus, minimize, closeAll } = controls;
  const isAppActive = appWindows.some((w) => w.id === activeWindowId);

  /** Focus a window, or minimize it if it's already the active one. */
  const toggleWindow = (win: DockWindow) => {
    if (win.id === activeWindowId) {
      minimize(win.id);
    } else {
      focus(win.id);
    }
  };

  /**
   * Raise the window `step` places from the active one, in launch order. If
   * none of the app's windows is active, bring its frontmost one forward
   * instead (preferring one that isn't minimized).
   */
  const cycle = (step: number) => {
    if (appWindows.length === 0) return;
    const current = appWindows.findIndex((w) => w.id === activeWindowId);
    if (current === -1) {
      const frontmost = appWindows.reduce((top, w) =>
        (w.minimized === top.minimized ? w.z > top.z : top.minimized) ? w : top,
      );
      focus(frontmost.id);
      return;
    }
    const n = appWindows.length;
    focus(appWindows[(((current + step) % n) + n) % n].id);
  };

  const handleClick = () => {
    if (appWindows.length === 0) {
      open(app.id);
    } else if (appWindows.length === 1) {
      toggleWindow(appWindows[0]);
    } else {
      cycle(1);
    }
  };

  // Wheel travel since the last step, and when that step happened. Wheels
  // report anywhere from one big delta per notch to a stream of small
  // touchpad deltas, so steps go by accumulated distance, rate-limited.
  const wheel = useRef({ delta: 0, at: 0 });
  const handleWheel = (e: React.WheelEvent) => {
    const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    const w = wheel.current;
    // A reversal starts over rather than unwinding the old direction first.
    w.delta = Math.sign(px) === Math.sign(w.delta) ? w.delta + px : px;
    if (Math.abs(w.delta) < WHEEL_STEP || e.timeStamp - w.at < WHEEL_COOLDOWN) return;
    cycle(Math.sign(w.delta));
    w.delta = 0;
    w.at = e.timeStamp;
  };

  // The tile wears the icon of the app's frontmost window, when its app
  // gave it one (Preview's picture, video or file).
  const frontmost = appWindows.reduce<DockWindow | null>((top, w) => (!top || w.z > top.z ? w : top), null);
  const tileIcon = frontmost?.icon ?? app.icon;
  // Bounces until the app's window turns up.
  const launching = useLaunching(app.id);

  const button = (
    <button
      type="button"
      aria-label={
        (appWindows.length > 0
          ? `${app.name} (${appWindows.length} window${appWindows.length > 1 ? 's' : ''})`
          : `Open ${app.name}`) +
        (unread > 0 ? `, ${unread} unread notification${unread > 1 ? 's' : ''}` : '')
      }
      onClick={handleClick}
      onWheel={handleWheel}
      onPointerDown={(e) => {
        if (e.button === 0) onDragPointerDown(app.id, e);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) open(app.id);
      }}
      className={cn(
        'pointer-events-auto absolute inset-x-[5%] bottom-[12.5%] grid aspect-square place-items-center rounded-xl',
        'group-data-hidden/dock:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'motion-reduce:hover:-translate-y-1 motion-reduce:transition-transform',
        dropping && 'bg-white/25 ring-2 ring-primary dark:bg-white/15',
      )}
    >
      <AppIcon
        icon={tileIcon}
        web={app.web}
        className={cn('size-[82%] text-foreground drop-shadow-md', launching && 'motion-safe:animate-dock-bounce')}
      />
      {/* Unread notifications, on the icon's corner as on macOS. */}
      {unread > 0 && (
        <span
          aria-hidden
          data-dock-badge=""
          className={cn(
            'pointer-events-none absolute top-0 right-0 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5',
            'bg-red-600 text-[11px] leading-none font-semibold text-white tabular-nums shadow-md ring-1 ring-black/10',
          )}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {/* Name label, floating above the (possibly magnified) icon. */}
      <span
        aria-hidden
        data-dock-label=""
        className={cn(
          'pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap',
          'rounded-md border border-border/40 bg-background/80 px-2 py-0.5 shadow-sm backdrop-blur-xl',
          'text-xs font-medium text-foreground opacity-0 transition-opacity',
          'group-hover/dock-item:opacity-100 group-focus-within/dock-item:opacity-100',
        )}
      >
        {app.name}
      </span>
    </button>
  );

  const menu = (
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
            <PinOff aria-hidden /> Remove from Dock
          </>
        ) : (
          <>
            <Pin aria-hidden /> Keep in Dock
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

  // Stable identity is load-bearing beyond render perf: React detaches a
  // changed ref callback during the commit's mutation phase, before layout
  // effects run - so an inline arrow here would empty the dock-tile registry
  // for this app in the very commit that minimizes its window, and the genie
  // animation (which looks the tile up in a layout effect) would fall back
  // to the bottom-center of the screen instead of targeting the tile.
  const tileRef = useCallback(
    (el: HTMLDivElement | null) => registerRef(app.id, el),
    [registerRef, app.id],
  );

  const wrapperProps = {
    ref: tileRef,
    'data-dock-tile': '',
    'data-app-id': app.id,
    // Clicks go to the button; around it they fall through to the Dock's
    // backdrop and its menu.
    className: cn(
      'group/dock-item pointer-events-none relative',
      !reordering && 'motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-out',
    ),
    // Rest width only; magnification writes widths directly onto the node
    // (see Dock). Re-renders only change this value when the Dock's size
    // does, so they don't clobber the animated width.
    style: { width: size, height: size },
  } as const;

  // One dot per window, the active one lit. Past MAX_DOTS the row stops
  // growing; the last dot stands in for the rest and lights if any of them
  // is active.
  //
  // The dots sit over whatever is behind the dock (wallpaper, or a window
  // that fills the screen), so no fixed color reads everywhere. Each dot is
  // painted from its own backdrop instead: blurred to one tone, thresholded
  // on luminance to black or white, then inverted - black over light
  // content, white over dark. It works over <webview> guests too, since the
  // compositor applies the filter. On the classic shelf they're Leopard's
  // glowing lights instead.
  const activeIndex = appWindows.findIndex((w) => w.id === activeWindowId);
  const dotCount = Math.min(appWindows.length, MAX_DOTS);
  const runningDots = dotCount > 0 && (
    <div
      aria-hidden
      data-dock-dots=""
      className="pointer-events-none absolute bottom-1 left-1/2 flex -translate-x-1/2 gap-1"
    >
      {Array.from({ length: dotCount }, (_, i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 rounded-full [backdrop-filter:blur(4px)_grayscale(1)_contrast(100)_invert(1)]',
            'group-data-[style=classic]/dock:bg-sky-50 group-data-[style=classic]/dock:[backdrop-filter:none]',
            'group-data-[style=classic]/dock:shadow-[0_0_4px_2px_rgb(125_211_252/0.9)]',
            !(isAppActive && Math.min(activeIndex, dotCount - 1) === i) && 'opacity-50',
          )}
        />
      ))}
    </div>
  );

  return (
    <div {...wrapperProps}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        {menu}
      </ContextMenu>
      {runningDots}
    </div>
  );
}, (prev, next) =>
  prev.app === next.app &&
  prev.size === next.size &&
  prev.registerRef === next.registerRef &&
  prev.activeWindowId === next.activeWindowId &&
  prev.controls === next.controls &&
  prev.isPinned === next.isPinned &&
  prev.reordering === next.reordering &&
  prev.dropping === next.dropping &&
  prev.unread === next.unread &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onDragPointerDown === next.onDragPointerDown &&
  prev.onUninstall === next.onUninstall &&
  prev.appWindows.length === next.appWindows.length &&
  prev.appWindows.every((w, i) => {
    const n = next.appWindows[i];
    return w.id === n.id && w.z === n.z && w.minimized === n.minimized && w.title === n.title && w.icon === n.icon;
  }));


/**
 * What the Dock's tiles sit on, filling the strip behind them. It's also what
 * a right-click between the tiles lands on, so it spreads its props and ref
 * onto its root.
 */
function DockSurface({
  variant,
  size,
  className,
  style,
  ...props
}: {
  variant: DockStyle;
  /** The tiles' rest size, which the backdrop's proportions follow. */
  size: number;
} & React.ComponentProps<'div'>) {
  if (variant === 'modern') {
    // macOS since Big Sur: a frosted, rounded panel with a hairline edge.
    return (
      <div
        {...props}
        style={{ borderRadius: size * 0.275, ...style }}
        className={cn(
          'absolute inset-x-0 top-0 bottom-1',
          'border border-white/30 bg-white/25 ring-1 ring-black/10 backdrop-blur-2xl backdrop-saturate-150',
          'shadow-[0_8px_32px_rgb(0_0_0/0.2)] dark:border-white/15 dark:bg-neutral-900/40 dark:ring-black/40',
          className,
        )}
      />
    );
  }
  if (variant === 'classic') {
    // Leopard's glass shelf, seen from above: a frosted floor whose far edge
    // recedes to a bright rim, and a lit front lip.
    return (
      <div {...props} style={{ height: size * 0.45, ...style }} className={cn('absolute inset-x-0 bottom-0', className)}>
        <div
          className={cn(
            'absolute inset-x-0 top-0 bottom-1.5 backdrop-blur-md',
            'bg-[linear-gradient(to_bottom,rgb(255_255_255/0.3),rgb(255_255_255/0.6))]',
            '[clip-path:polygon(32px_0,calc(100%-32px)_0,100%_100%,0_100%)]',
          )}
        />
        <div className="absolute inset-x-8 top-0 h-px bg-white/90" />
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 h-1.5 border-t border-white/90 backdrop-blur-md',
            'bg-[linear-gradient(to_bottom,rgb(255_255_255/0.7),rgb(255_255_255/0.35))]',
            'shadow-[0_1px_3px_rgb(0_0_0/0.35)]',
          )}
        />
      </div>
    );
  }
  return <div {...props} style={style} className={cn('absolute inset-0', className)} />;
}

/**
 * The line between the pinned apps and the others. As on macOS,
 * right-clicking it offers the Dock's settings.
 */
function DockDivider({ variant, size }: { variant: DockStyle; size: number }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="separator" aria-orientation="vertical" className="relative w-4 shrink-0" style={{ height: size }}>
          <span
            aria-hidden
            className={cn(
              'absolute left-1/2 -translate-x-1/2',
              variant === 'classic'
                ? 'top-5 bottom-1 border-l-2 border-dashed border-white/80'
                : 'top-3 bottom-3 w-px',
              variant === 'modern' && 'bg-black/20 dark:bg-white/25',
              // Over the wallpaper, painted from its backdrop like the dots.
              variant === 'none' && 'opacity-50 [backdrop-filter:blur(4px)_grayscale(1)_contrast(100)_invert(1)]',
            )}
          />
        </div>
      </ContextMenuTrigger>
      <DockMenuContent />
    </ContextMenu>
  );
}

/** The Dock's own menu: magnification, its backdrop, and the rest in Settings. */
function DockMenuContent() {
  const { config, updateConfig } = useAppContext();
  const { open } = useWindowActions();
  return (
    <ContextMenuContent className="z-[10000] w-52">
      <ContextMenuCheckboxItem
        checked={config.dockMagnification}
        onCheckedChange={(checked) => updateConfig((current) => ({ ...current, dockMagnification: checked }))}
      >
        Magnification
      </ContextMenuCheckboxItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Background</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuRadioGroup
            value={config.dockStyle}
            onValueChange={(value) => {
              const style = DOCK_STYLES.find((s) => s.value === value);
              if (style) updateConfig((current) => ({ ...current, dockStyle: style.value }));
            }}
          >
            {DOCK_STYLES.map((s) => (
              <ContextMenuRadioItem key={s.value} value={s.value}>
                {s.name}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => open('settings', { section: 'dock' })}>
        Dock Settings…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/** Colors of the stand-in icons in a DockPreview. */
const PREVIEW_ICONS = ['bg-sky-500', 'bg-amber-400', 'bg-emerald-500'];

/**
 * A small Dock of stand-in icons over the given backdrop, for Settings to
 * show its choices with. Laid out at full size like the real one, then
 * scaled down from its bottom center.
 */
export function DockPreview({ variant }: { variant: DockStyle }) {
  return (
    <div aria-hidden className={cn('relative flex shrink-0 origin-bottom scale-[0.4] items-end', STYLE_LAYOUT[variant].padding)}>
      <DockSurface variant={variant} size={BASE_WIDTH} />
      {PREVIEW_ICONS.map((color) => (
        <div key={color} className="relative h-20" style={{ width: BASE_WIDTH }}>
          <div className="absolute inset-x-[5%] bottom-[12.5%] grid aspect-square place-items-center">
            <div className={cn('size-[82%] rounded-[22%] shadow-md', color)} />
          </div>
        </div>
      ))}
    </div>
  );
}
