import { useMemo, useRef, useState } from 'react';
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
import { cn } from '@/lib/utils';
import { APPS } from '@/lib/apps';
import type { AppDefinition } from '@/lib/apps';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
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

/**
 * macOS-style Dock: a centered, backgroundless strip of app tiles that
 * magnify as the pointer sweeps across them.
 *
 * Shows pinned apps first (roaming via encrypted app data), then any
 * running apps that aren't pinned. Each tile keeps the grouped-window
 * behavior: click launches or toggles, a picker opens for multiple
 * windows, middle-click always opens a new window, and right-click offers
 * pin/unpin, close, and uninstall.
 */
export function Dock() {
  const { windows, close } = useWindowManager();
  const { getApp, webApps, uninstallWebApp } = useInstalledApps();
  // Pinned apps roam across devices via Din's encrypted app-data layer,
  // seeded from the pre-sync localStorage key on first run.
  const [pinned, setPinned] = useAppData<string[]>(
    'pinned-apps',
    PinnedAppsSchema,
    DEFAULT_PINNED,
    { legacyKey: 'desktop:pinned-apps' },
  );

  const togglePin = (appId: string) =>
    setPinned((prev) =>
      prev.includes(appId)
        ? prev.filter((id) => id !== appId)
        : [...prev, appId],
    );

  /** Uninstall a web app: close its windows, unpin it, drop the entry. */
  const uninstall = (appId: string) => {
    windows.filter((w) => w.appId === appId).forEach((w) => close(w.id));
    setPinned((prev) => prev.filter((id) => id !== appId));
    uninstallWebApp(appId);
  };

  // One dock tile per app: pinned apps first in pin order, then any
  // running apps that aren't pinned, in launch order.
  const running = [...new Set(windows.map((w) => w.appId))];
  const entryIds = [
    ...pinned,
    ...running.filter((id) => !pinned.includes(id)),
  ].filter((id) => getApp(id));

  // The window that currently holds focus: highest z among visible windows.
  const activeWindow = windows.reduce<WindowState | null>(
    (top, w) => (!w.minimized && (!top || w.z > top.z) ? w : top),
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

  // Cursor position in "slot" units (fractional index into entryIds), or
  // null when the pointer is off the dock. Slot distances drive per-tile
  // magnification; deriving the position from the tile under the pointer
  // keeps the math stable while widths animate.
  const [cursor, setCursor] = useState<number | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const handlePointerMove = (clientX: number) => {
    if (reduceMotion) return;
    let next: number | null = null;
    entryIds.forEach((id, i) => {
      const el = itemRefs.current.get(id);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX < rect.right) {
        next = i + (clientX - rect.left) / rect.width - 0.5;
      }
    });
    setCursor(next);
  };

  if (entryIds.length === 0) return null;

  return (
    <footer aria-label="Dock" className="relative z-[9999] flex justify-center">
      <div
        className="flex items-end"
        onMouseMove={(e) => handlePointerMove(e.clientX)}
        onMouseLeave={() => setCursor(null)}
      >
        {entryIds.map((appId, i) => {
          const app = getApp(appId);
          if (!app) return null;
          const scale = cursor === null ? 1 : magnify(Math.abs(i - cursor));
          return (
            <DockItem
              key={appId}
              app={app}
              width={Math.round(BASE_WIDTH * scale)}
              refCallback={(el) => {
                if (el) itemRefs.current.set(appId, el);
                else itemRefs.current.delete(appId);
              }}
              appWindows={windows.filter((w) => w.appId === appId)}
              activeWindowId={activeWindow?.id ?? null}
              isPinned={pinned.includes(appId)}
              onTogglePin={() => togglePin(appId)}
              onUninstall={
                webApps.some((webApp) => webApp.id === appId)
                  ? () => uninstall(appId)
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
 */
function DockItem({
  app,
  width,
  refCallback,
  appWindows,
  activeWindowId,
  isPinned,
  onTogglePin,
  onUninstall,
}: {
  app: AppDefinition;
  /** Animated slot width in px; the square tile inside fills it. */
  width: number;
  refCallback: (el: HTMLDivElement | null) => void;
  appWindows: WindowState[];
  activeWindowId: string | null;
  isPinned: boolean;
  onTogglePin: () => void;
  /** Present only for installed web apps; removes the app entirely. */
  onUninstall?: () => void;
}) {
  const { open, focus, minimize, close } = useWindowManager();
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
      <ContextMenuItem onSelect={onTogglePin}>
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
          <ContextMenuItem
            onSelect={() => appWindows.forEach((w) => close(w.id))}
          >
            <X aria-hidden />{' '}
            {appWindows.length > 1 ? 'Close all windows' : 'Close window'}
          </ContextMenuItem>
        </>
      )}
      {onUninstall && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onUninstall}>
            <Trash2 aria-hidden /> Uninstall
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );

  const wrapperProps = {
    ref: refCallback,
    className: cn(
      'group/dock-item relative h-20',
      'motion-safe:transition-[width] motion-safe:duration-150 motion-safe:ease-out',
    ),
    style: { width },
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
}
