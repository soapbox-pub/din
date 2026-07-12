import { LayoutGrid, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
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
import { LoginArea } from '@/components/auth/LoginArea';
import { AppIcon } from '@/components/desktop/AppIcon';
import { WifiIndicator } from '@/components/desktop/WifiIndicator';
import { useClock } from '@/hooks/useClock';
import { useAppData } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';
import { APPS } from '@/lib/apps';
import type { AppDefinition } from '@/lib/apps';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import type { WindowState } from '@/hooks/useWindows';

/** Apps pinned to the taskbar out of the box. */
const DEFAULT_PINNED = APPS.filter((app) => !app.hidden).map((app) => app.id);

const PinnedAppsSchema = z.array(z.string());

/** Bottom toolbar: app launcher, pinned + running apps, wifi, clock, account menu. */
export function Taskbar() {
  const now = useClock();
  const { windows, open, close } = useWindowManager();
  const { apps, getApp, webApps, uninstallWebApp } = useInstalledApps();
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

  // One taskbar button per app (Windows-style grouping): pinned apps first
  // in pin order, then any running apps that aren't pinned, in launch order.
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

  return (
    <footer className="relative z-10 flex h-14 items-center gap-2 border-t border-border/60 bg-background/70 px-2 backdrop-blur-xl">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open app launcher"
            className="size-10 rounded-lg text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
          >
            <LayoutGrid className="size-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={12}
          className="w-72"
        >
          <div className="grid grid-cols-3 gap-2">
            {apps.filter((app) => !app.hidden).map((app) => (
              <ContextMenu key={app.id}>
                <ContextMenuTrigger asChild>
                  <PopoverClose asChild>
                    <button
                      type="button"
                      onClick={() => open(app.id)}
                      className="flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <AppIcon icon={app.icon} className="size-7 text-foreground" />
                      <span className="text-xs leading-tight text-foreground">
                        {app.name}
                      </span>
                    </button>
                  </PopoverClose>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  <ContextMenuItem onSelect={() => togglePin(app.id)}>
                    {pinned.includes(app.id) ? (
                      <>
                        <PinOff aria-hidden /> Unpin from taskbar
                      </>
                    ) : (
                      <>
                        <Pin aria-hidden /> Pin to taskbar
                      </>
                    )}
                  </ContextMenuItem>
                  {webApps.some((webApp) => webApp.id === app.id) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => uninstall(app.id)}
                      >
                        <Trash2 aria-hidden /> Uninstall
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Pinned + running apps */}
      <div className="flex flex-1 items-center gap-1">
        {entryIds.map((appId) => {
          const app = getApp(appId);
          if (!app) return null;
          return (
            <TaskbarAppButton
              key={appId}
              app={app}
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

      <WifiIndicator />

      <time
        dateTime={now.toISOString()}
        className="px-2 text-right text-sm leading-tight text-foreground/90 tabular-nums"
      >
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="block text-xs text-muted-foreground">
          {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </span>
      </time>

      <LoginArea />
    </footer>
  );
}

/**
 * A single grouped taskbar button for one app.
 *
 * Windows-style behavior:
 * - no windows: click launches the app
 * - one window: click toggles it (focus if not active, minimize if active)
 * - multiple windows: click opens a picker listing every window
 * - middle-click always opens a new window
 * - right-click: new window, pin/unpin, close all
 */
function TaskbarAppButton({
  app,
  appWindows,
  activeWindowId,
  isPinned,
  onTogglePin,
  onUninstall,
}: {
  app: AppDefinition;
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
    // With multiple windows the button is a PopoverTrigger; the picker opens.
  };

  const button = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={
        appWindows.length > 0
          ? `${app.name} (${appWindows.length} window${appWindows.length > 1 ? 's' : ''})`
          : `Open ${app.name}`
      }
      onClick={handleClick}
      onAuxClick={(e) => {
        if (e.button === 1) open(app.id);
      }}
      className={cn(
        'relative size-10 rounded-lg text-foreground/90 hover:bg-foreground/10 hover:text-foreground',
        isAppActive && 'bg-foreground/10',
      )}
    >
      <AppIcon icon={app.icon} className="size-5" />
      {appWindows.length > 0 && (
        <span
          aria-hidden
          className={cn(
            'absolute bottom-0.5 left-1/2 h-1 -translate-x-1/2 rounded-full bg-primary transition-all',
            isAppActive ? 'w-4' : 'w-1.5',
          )}
        />
      )}
    </Button>
  );

  const menu = (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onSelect={() => open(app.id)}>
        <Plus aria-hidden /> New window
      </ContextMenuItem>
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? (
          <>
            <PinOff aria-hidden /> Unpin from taskbar
          </>
        ) : (
          <>
            <Pin aria-hidden /> Pin to taskbar
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

  if (appWindows.length <= 1) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
        {menu}
      </ContextMenu>
    );
  }

  return (
    <Popover>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </ContextMenuTrigger>
        {menu}
      </ContextMenu>
      <PopoverContent side="top" sideOffset={8} className="w-64 p-1">
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
  );
}
