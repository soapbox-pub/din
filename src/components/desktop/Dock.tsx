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
import type { WindowState } from '@/hooks/useWindows';

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

/** Height of the hot zone at the screen's bottom edge that reveals a hidden dock, in px. */
const REVEAL_ZONE = 8;
/** Extra slack above the dock before a hot-edge reveal retracts, in px. */
const REVEAL_SLACK = 24;

/**
 * macOS-style Dock: a centered, backgroundless strip of app tiles that
 * magnify as the pointer sweeps across them.
 *
 * The dock overlays the bottom edge of the workspace and hides itself
 * intelligently: whenever any visible window intersects its footprint
 * (including maximized windows, which fill the whole workspace) it slides
 * off-screen, and it slides back when the pointer reaches the bottom edge
 * of the screen or when no window overlaps it anymore.
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
  const { closeApp } = useWindowActions();
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

  // One dock tile per app: pinned apps first in pin order, then any
  // running apps that aren't pinned, in launch order.
  const running = [...new Set(windows.map((w) => w.appId))];
  const entryIds = [
    ...pinned,
    ...running.filter((id) => !pinned.includes(id)),
  ].filter((id) => getApp(id));

  // The window that currently holds focus: highest z among visible windows.
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

  // Does any visible window overlap the dock's footprint? Geometry comes
  // from committed window-manager state, so this re-evaluates on every
  // move/resize/open/close/minimize/maximize commit.
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
      // inset-x-0 bottom-0, so the strip's offsets are viewport offsets.
      const dockTop = window.innerHeight - strip.offsetHeight;
      const dockLeft = strip.offsetLeft;
      const dockRight = dockLeft + strip.offsetWidth;
      setIntersecting(
        windows.some((w) => {
          if (w.minimized) return false;
          // Maximized windows fill the workspace, which reaches the screen bottom.
          if (w.maximized) return workspaceRect.bottom > dockTop;
          // Edge-tiled windows are CSS-driven (stored x/width are stale): they
          // span full height against one half of the workspace.
          if (w.snapped) {
            if (workspaceRect.bottom <= dockTop) return false;
            const mid = workspaceRect.left + workspaceRect.width / 2;
            const tileLeft = w.snapped === 'left' ? workspaceRect.left : mid;
            const tileRight = w.snapped === 'left' ? mid : workspaceRect.right;
            return tileLeft < dockRight && tileRight > dockLeft;
          }
          const left = workspaceRect.left + w.x;
          const top = workspaceRect.top + w.y;
          return (
            top + w.height > dockTop &&
            left < dockRight &&
            left + w.width > dockLeft
          );
        }),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [windows, entryIds.length, workspaceRef]);

  // Hot-edge reveal: sweeping the pointer into the strip at the very bottom
  // of the screen slides a hidden dock back up; it retracts once the pointer
  // wanders back above the dock. Pointermove (not mousemove) so reveals also
  // fire mid-drag while a window holds pointer capture. The listener only
  // exists while a window overlaps the dock (the only time it can be hidden)
  // and does no layout reads until a reveal is actually in progress, so
  // window drags - which fire pointermove at mouse-report rate - don't pay
  // for a forced reflow per event.
  const [revealed, setRevealed] = useState(false);
  // A reveal only means something while the dock is hideable; drop stale
  // reveals as soon as nothing overlaps (adjust-state-during-render pattern).
  const [wasIntersecting, setWasIntersecting] = useState(intersecting);
  if (wasIntersecting !== intersecting) {
    setWasIntersecting(intersecting);
    if (!intersecting) setRevealed(false);
  }
  useEffect(() => {
    if (!intersecting) return;
    const onPointerMove = (e: PointerEvent) => {
      const fromBottom = window.innerHeight - e.clientY;
      setRevealed((prev) => {
        if (!prev) return fromBottom <= REVEAL_ZONE;
        const dockHeight = stripRef.current?.offsetHeight ?? 80;
        return fromBottom <= dockHeight + REVEAL_SLACK;
      });
    };
    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [intersecting]);

  // Keyboard users can still tab into the dock while it's hidden; keep it
  // on-screen whenever any tile holds focus.
  const [focusWithin, setFocusWithin] = useState(false);

  // Hidden only while a window overlaps it and nobody is asking for it.
  const hidden = intersecting && !revealed && !focusWithin;

  if (entryIds.length === 0) return null;

  return (
    <footer
      aria-label="Dock"
      className={cn(
        'absolute inset-x-0 bottom-0 z-[9999] flex justify-center',
        'motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out',
        hidden && 'pointer-events-none translate-y-full',
      )}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
    >
      <div
        ref={stripRef}
        className="flex items-end"
        onMouseMove={(e) => scheduleMagnify(e.clientX)}
        onMouseLeave={() => scheduleMagnify(null)}
      >
        {entryIds.map((appId) => {
          const app = getApp(appId);
          if (!app) return null;
          return (
            <DockItem
              key={appId}
              app={app}
              registerRef={registerRef}
              appWindows={windows.filter((w) => w.appId === appId)}
              activeWindowId={activeWindow?.id ?? null}
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
 * windows, active state, or pin state actually changed. `appWindows` is a
 * fresh array each parent render, so the comparator checks its elements
 * (window objects are referentially stable while unchanged).
 */
const DockItem = memo(function DockItem({
  app,
  registerRef,
  appWindows,
  activeWindowId,
  isPinned,
  onTogglePin,
  onUninstall,
}: {
  app: AppDefinition;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: WindowState[];
  activeWindowId: string | null;
  isPinned: boolean;
  onTogglePin: (appId: string) => void;
  /** Present only for installed web apps; removes the app entirely. */
  onUninstall?: (appId: string) => void;
}) {
  const { open, focus, minimize, close, closeApp } = useWindowActions();
  const isAppActive = appWindows.some((w) => w.id === activeWindowId);

  /** Focus a window, or minimize it if it's already the active one. */
  const toggleWindow = (win: WindowState) => {
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
      <ContextMenuItem onSelect={() => open(app.id)}>
        <Plus aria-hidden /> New window
      </ContextMenuItem>
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
          <ContextMenuItem onSelect={() => closeApp(app.id)}>
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
            {appWindows.map((win, i) => (
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
                    <span className="truncate">
                      {app.name} {i + 1}
                    </span>
                    {win.minimized && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        Minimized
                      </span>
                    )}
                  </button>
                </PopoverClose>
                <button
                  type="button"
                  aria-label={`Close ${app.name} ${i + 1}`}
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
  prev.isPinned === next.isPinned &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onUninstall === next.onUninstall &&
  prev.appWindows.length === next.appWindows.length &&
  prev.appWindows.every((w, i) => w === next.appWindows[i]));
