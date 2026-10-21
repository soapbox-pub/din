import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useAppData } from '@/hooks/useAppData';
import { registerDockTile } from '@/lib/dockTiles';
import { cn } from '@/lib/utils';
import { APPS } from '@/lib/apps';
import type { AppDefinition } from '@/lib/apps';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useMonitors, useWorkAreas } from '@/contexts/MonitorsContext';
import { windowRect, type WindowState } from '@/hooks/useWindows';

/** One window in a Dock tile. */
interface DockWindow {
  id: string;
  /** Label for the multi-window picker. */
  title: string;
  minimized: boolean;
}

/** How a tile acts on its app and its windows. */
interface DockControls {
  /** Launch a new instance. */
  open: (appId: string) => void;
  /** Raise and focus a window. */
  focus: (id: string) => void;
  minimize: (id: string) => void;
  close: (id: string) => void;
  /** Close every window of the app. */
  closeAll: (appId: string, windows: DockWindow[]) => void;
}

/** Apps kept in the Dock out of the box. */
const DEFAULT_PINNED = APPS.filter((app) => !app.hidden).map((app) => app.id);

const PinnedAppsSchema = z.array(z.string());

/** Width of one dock slot at rest, in px (icon plus breathing room). */
const BASE_WIDTH = 80;
/** How large a slot grows directly under the cursor (macOS magnification). */
const MAX_SCALE = 2;
/** Distance, in slots, over which magnification falls off to nothing. */
const FALLOFF = 2.5;

/** Cosine-eased magnification: 1 at rest, MAX_SCALE under the cursor. */
function magnify(distance: number): number {
  if (distance >= FALLOFF) return 1;
  return 1 + ((MAX_SCALE - 1) * (Math.cos((distance / FALLOFF) * Math.PI) + 1)) / 2;
}

/**
 * How far a fully magnified tile reaches above the bottom of the dock, in px:
 * the icon (the slot less its inset-x-1) sitting on its bottom-2.5 offset.
 */
const MAGNIFIED_HEIGHT = BASE_WIDTH * MAX_SCALE + 8;

/** Height of the hot zone at the screen's bottom edge that reveals a hidden dock, in px. */
const REVEAL_ZONE = 8;
/** Extra slack above the dock before a hot-edge reveal retracts, in px. */
const REVEAL_SLACK = 24;
/** Height of the bottom-edge strip a touch swipe has to start in, in px. */
const SWIPE_ZONE = 16;
/** How far a touch has to travel up from the edge to reveal the dock, in px. */
const SWIPE_DISTANCE = 24;

/**
 * macOS-style Dock: a centered, backgroundless strip of app tiles that
 * magnify as the pointer sweeps across them.
 *
 * The dock overlays the bottom edge of the primary monitor and hides itself
 * intelligently: whenever the focused window intersects its footprint
 * (including a window maximized there, which fills the whole monitor) it
 * slides off-screen, and it slides back when the pointer reaches the bottom
 * edge of that monitor, when a finger swipes up from that edge, or when the
 * focused window no longer overlaps it.
 *
 * Shows pinned apps first (roaming via encrypted app data), then any
 * running apps that aren't pinned. Each tile keeps the grouped-window
 * behavior: click launches or toggles, a picker opens for multiple
 * windows, middle-click always opens a new window, and right-click offers
 * pin/unpin, close, and uninstall.
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
  const { getApp, webApps, uninstallWebApp } = useInstalledApps();
  // Pinned apps roam across devices via Din's encrypted app-data layer,
  // seeded from the pre-sync localStorage key on first run.
  const [pinned, setPinned] = useAppData<string[]>(
    'pinned-apps',
    PinnedAppsSchema,
    DEFAULT_PINNED,
    { legacyKey: 'desktop:pinned-apps' },
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

  /** Uninstall a web app: close its windows, unpin it, drop the entry. */
  const uninstall = useCallback(
    (appId: string) => {
      closeApp(appId);
      setPinned((prev) => prev.filter((id) => id !== appId));
      uninstallWebApp(appId);
    },
    [closeApp, setPinned, uninstallWebApp],
  );

  // Din's own window actions, bundled into the shape a tile consumes. The
  // action set is referentially stable, so this object is too.
  const dinControls = useMemo<DockControls>(
    () => ({
      open: dinActions.open,
      focus: dinActions.focus,
      minimize: dinActions.minimize,
      close: dinActions.close,
      closeAll: (appId) => dinActions.closeApp(appId),
    }),
    [dinActions],
  );

  // One dock tile per app: pinned apps first in pin order, then any
  // running apps that aren't pinned, in launch order.
  const running = [...new Set(windows.map((w) => w.appId))];
  const entryIds = [
    ...pinned,
    ...running.filter((id) => !pinned.includes(id)),
  ].filter((id) => getApp(id));

  // The Din window that currently holds focus: highest z among visible ones.
  const activeWindow = windows.reduce<WindowState | null>(
    (top, w) => (!w.minimized && !w.closing && (!top || w.z > top.z) ? w : top),
    null,
  );

  // Magnification is pointer-driven eye candy; skip it entirely for users
  // who prefer reduced motion (tiles then behave like plain buttons).
  const reduceMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // Cursor-driven magnification bypasses React entirely: pointer moves are
  // coalesced to one requestAnimationFrame tick, which computes each tile's
  // width and writes it straight onto the DOM node. Routing this through
  // setState re-rendered the whole dock (every tile plus its Radix menu
  // tree) per mouse event - mice report faster than the frame rate - and
  // interleaved per-event getBoundingClientRect reads with animating widths,
  // forcing synchronous layouts. That made sweeping across the dock feel
  // sluggish, especially under software rendering.
  //
  // React always renders tiles at BASE_WIDTH and never touches width again
  // (the rendered value is constant), so these direct writes stick.
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

  /** Stable tile-ref registrar (identity matters for memo'd DockItems). */
  const registerRef = useCallback((appId: string, el: HTMLDivElement | null) => {
    if (el) itemRefs.current.set(appId, el);
    else itemRefs.current.delete(appId);
    // Mirror into the module-level registry the genie minimize animation
    // targets (see src/lib/dockTiles.ts).
    registerDockTile(appId, el);
  }, []);

  // Kept fresh via an every-render effect so the rAF callback sees the
  // current tile list.
  const paintRef = useRef<() => void>(() => {});
  const paint = () => {
    const clientX = pointerX.current;
    // Cursor position in "slot" units (fractional index into entryIds), or
    // null when the pointer is off the dock. Derived from the tile under the
    // pointer so the math stays stable while widths animate; rects are read
    // before the width writes below, so the frame does one layout, not many.
    let cursor: number | null = null;
    if (clientX !== null) {
      entryIds.forEach((id, i) => {
        const el = itemRefs.current.get(id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (clientX >= rect.left && clientX < rect.right) {
          cursor = i + (clientX - rect.left) / rect.width - 0.5;
        }
      });
    }
    entryIds.forEach((id, i) => {
      const el = itemRefs.current.get(id);
      if (!el) return;
      const scale = cursor === null ? 1 : magnify(Math.abs(i - cursor));
      el.style.width = `${Math.round(BASE_WIDTH * scale)}px`;
    });
    magnified.current = cursor !== null;
    if (hoverPadRef.current) hoverPadRef.current.hidden = cursor === null;
  };
  useEffect(() => {
    paintRef.current = paint;
  });

  const scheduleMagnify = useCallback(
    (clientX: number | null) => {
      if (reduceMotion) return;
      pointerX.current = clientX;
      if (rafId.current) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        paintRef.current();
      });
    },
    [reduceMotion],
  );

  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  // The visible strip of tiles; its untransformed layout box is the dock's
  // footprint for window-intersection checks (offsets ignore the slide
  // transform, unlike getBoundingClientRect).
  const stripRef = useRef<HTMLDivElement>(null);

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
  // The pointer can also leave the window entirely: cage parks a cursor
  // shoved into the bottom edge on the row just past the last one Din covers,
  // and from there Din gets no pointer events at all - not for a fast throw
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
          ? MAGNIFIED_HEIGHT
          : (stripRef.current?.offsetHeight ?? 80);
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
  }, [intersecting, primary]);

  // A swiped-up dock stays until the user touches somewhere else, the way a
  // tablet's does. Capture phase, so windows that stop propagation still
  // dismiss it; the touch itself goes through. Touches inside the dock or in
  // its popups (tile menus and window pickers are portaled out of the footer)
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
      const into = e.target instanceof Element ? e.target.tagName : null;
      if (into === 'WEBVIEW' || into === 'IFRAME') setRevealed(false);
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
          hidden && 'translate-y-full',
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
          const into = e.relatedTarget instanceof Element ? e.relatedTarget.tagName : null;
          if (into === 'WEBVIEW' || into === 'IFRAME') setRevealed(false);
        }}
      >
        <div
          ref={stripRef}
          // Explicit auto punches through the footer's none; while hidden the
          // strip goes inert itself (a parent's none no longer covers it), so
          // a mid-slide dock can't catch clicks.
          className={cn('relative flex items-end', hidden ? 'pointer-events-none' : 'pointer-events-auto')}
          onMouseMove={(e) => scheduleMagnify(e.clientX)}
          onMouseLeave={() => scheduleMagnify(null)}
        >
          {/* Shown only while magnified (see hoverPadRef). First in DOM
              order, so the tiles paint and hit-test above it. */}
          <div
            ref={hoverPadRef}
            aria-hidden
            hidden
            className="absolute inset-x-0 bottom-0"
            style={{ height: MAGNIFIED_HEIGHT }}
          />
          {entryIds.map((appId) => {
            const app = getApp(appId);
            if (!app) return null;
            const appWindows = windows
              .filter((w) => w.appId === appId)
              .map((w, i) => ({
                id: w.id,
                title: `${app.name} ${i + 1}`,
                minimized: w.minimized,
              }));
            return (
              <DockItem
                key={appId}
                app={app}
                registerRef={registerRef}
                appWindows={appWindows}
                activeWindowId={activeWindow?.id ?? null}
                controls={dinControls}
                isPinned={pinned.includes(appId)}
                onTogglePin={togglePin}
                onUninstall={
                  webApps.some((webApp) => webApp.id === appId)
                    ? uninstall
                    : undefined
                }
              />
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
 * - multiple windows: click opens a picker listing every window
 * - middle-click always opens a new window
 * - right-click: new window, pin/unpin, close all, uninstall
 *
 * Memoized: the dock re-renders on every window commit, but a tile (and its
 * Radix context-menu/popover tree) only re-renders when its own app's
 * windows, active state, or pin state actually changed. `appWindows` is
 * rebuilt on every parent render, so the comparator compares its entries
 * field by field rather than by identity.
 */
const DockItem = memo(function DockItem({
  app,
  registerRef,
  appWindows,
  activeWindowId,
  controls,
  isPinned,
  onTogglePin,
  onUninstall,
}: {
  app: AppDefinition;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: DockWindow[];
  activeWindowId: string | null;
  /** The window manager's actions, in the shape a tile consumes. */
  controls: DockControls;
  isPinned: boolean;
  onTogglePin: (appId: string) => void;
  /** Present only for installed web apps; removes the app entirely. */
  onUninstall?: (appId: string) => void;
}) {
  const { open, focus, minimize, close, closeAll } = controls;
  const isAppActive = appWindows.some((w) => w.id === activeWindowId);

  /** Focus a window, or minimize it if it's already the active one. */
  const toggleWindow = (win: DockWindow) => {
    if (win.id === activeWindowId) {
      minimize(win.id);
    } else {
      focus(win.id);
    }
  };

  const handleClick = () => {
    if (appWindows.length === 0) {
      open(app.id);
    } else if (appWindows.length === 1) {
      toggleWindow(appWindows[0]);
    }
    // With multiple windows the tile is a PopoverTrigger; the picker opens.
  };

  const button = (
    <button
      type="button"
      aria-label={
        appWindows.length > 0
          ? `${app.name} (${appWindows.length} window${appWindows.length > 1 ? 's' : ''})`
          : `Open ${app.name}`
      }
      onClick={handleClick}
      onPointerDown={(e) => {
        // Right-clicks open the context menu (via the separate `contextmenu`
        // event). Stop the secondary-button pointerdown from also reaching the
        // PopoverTrigger, which would otherwise toggle the window picker mid-
        // gesture and make the menu flicker open/closed.
        if (e.button !== 0) e.stopPropagation();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) open(app.id);
      }}
      className={cn(
        'absolute inset-x-1 bottom-2.5 grid aspect-square place-items-center rounded-xl',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'motion-reduce:hover:-translate-y-1 motion-reduce:transition-transform',
      )}
    >
      <AppIcon
        icon={app.icon}
        className="size-[82%] text-foreground drop-shadow-md"
      />
      {/* Name label, floating above the (possibly magnified) icon. */}
      <span
        aria-hidden
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
    className: cn(
      'group/dock-item relative h-20',
      'motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-out',
    ),
    // Rest width only; magnification writes widths directly onto the node
    // (see Dock). React re-renders never change this value, so they don't
    // clobber the animated width.
    style: { width: BASE_WIDTH },
  } as const;

  const runningDot = appWindows.length > 0 && (
    <span
      aria-hidden
      className={cn(
        'absolute bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full',
        isAppActive ? 'bg-primary' : 'bg-foreground/70',
      )}
    />
  );

  if (appWindows.length <= 1) {
    return (
      <div {...wrapperProps}>
        <ContextMenu>
          <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
          {menu}
        </ContextMenu>
        {runningDot}
      </div>
    );
  }

  return (
    <div {...wrapperProps}>
      <Popover>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
        <PopoverContent side="top" sideOffset={12} className="z-[10000] w-64 p-1">
          <ul aria-label={`${app.name} windows`} className="flex flex-col gap-0.5">
            {appWindows.map((win) => (
              <li key={win.id} className="flex items-center gap-0.5">
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={() => toggleWindow(win)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      win.id === activeWindowId && 'bg-accent/60',
                    )}
                  >
                    <AppIcon icon={app.icon} className="size-4 shrink-0" />
                    <span className="truncate">{win.title}</span>
                    {win.minimized && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        Minimized
                      </span>
                    )}
                  </button>
                </PopoverClose>
                <button
                  type="button"
                  aria-label={`Close ${win.title}`}
                  onClick={() => close(win.id)}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {runningDot}
    </div>
  );
}, (prev, next) =>
  prev.app === next.app &&
  prev.registerRef === next.registerRef &&
  prev.activeWindowId === next.activeWindowId &&
  prev.controls === next.controls &&
  prev.isPinned === next.isPinned &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onUninstall === next.onUninstall &&
  prev.appWindows.length === next.appWindows.length &&
  prev.appWindows.every((w, i) => {
    const n = next.appWindows[i];
    return w.id === n.id && w.title === n.title && w.minimized === n.minimized;
  }));
