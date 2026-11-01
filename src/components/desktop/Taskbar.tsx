import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { Home, Settings2, Store } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { AppIcon } from '@/components/desktop/AppIcon';
import {
  AccountMenuItem,
  AirPlayMenuItem,
  AppLauncher,
  BatteryMenuItem,
  BluetoothMenuItem,
  BrightnessMenuItem,
  ClockMenuItem,
  SystemButtons,
  VolumeMenuItem,
  WifiMenuItem,
} from '@/components/desktop/MenuBar';
import { PowerDialog, type PowerAction } from '@/components/desktop/PowerDialog';
import { TileMenuContent } from '@/components/desktop/TileMenuContent';
import { TrayItems } from '@/components/desktop/TrayMenu';
import { AssistantMenuItem } from '@/components/desktop/AssistantIndicator';
import { ScreenShareMenuItem } from '@/components/desktop/ScreenShareHost';
import { ScreenRecordingMenuItem } from '@/components/desktop/ScreenRecordingHost';
import { StudioMenuItem } from '@/components/desktop/StudioMenuItem';
import { WorkspacesMenuItem } from '@/components/desktop/WorkspacesIndicator';
import { BarSideContext } from '@/contexts/BarSideContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useDragReorder } from '@/hooks/useDragReorder';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { usePinnedApps, useTileBadges } from '@/hooks/usePinnedApps';
import { focusedWindow } from '@/hooks/useWindows';
import { getAvatarShape } from '@/lib/avatarShape';
import { useLaunching, useLaunchingApps } from '@/lib/appLaunches';
import type { AppBadge } from '@/lib/appBadges';
import { appsDockedAs, type AppDefinition } from '@/lib/apps';
import { onToggleAppsMenu } from '@/lib/appsMenu';
import { registerDockTile } from '@/lib/dockTiles';
import { clickTile, cycleTile, type DockControls, type DockWindow } from '@/lib/dockTileActions';
import { getFsBridge } from '@/lib/fs';
import { cn } from '@/lib/utils';
import { USER_DIRS } from '@/shared/userDirs';

/** Wheel travel that steps a button to its app's next window, in px. */
const WHEEL_STEP = 50;
/** Minimum time between wheel steps, in ms. */
const WHEEL_COOLDOWN = 120;

/**
 * The taskbar, Windows 7 style: one bar along the bottom of the primary
 * monitor in place of the menu bar and the Dock (AppConfig's desktopLayout).
 * The Start button opens the apps launcher beside the user's folders and the
 * power buttons; then come the pinned apps and the running ones, a button per
 * app that groups its windows as a Dock tile does (and shares the Dock's pins,
 * clicks and right-click menu); then the menu bar's status icons and the
 * clock in the corner. Unlike the Dock it never hides, and windows maximize
 * above it.
 */
export function Taskbar() {
  return (
    <BarSideContext.Provider value="top">
      <footer
        aria-label="Taskbar"
        className={cn(
          // Chrome, not content: no text cursor or selection anywhere in it.
          'relative z-20 flex h-10 shrink-0 cursor-default select-none items-stretch gap-1 px-1 tracking-tight',
          'border-t border-border/60 bg-background/70 backdrop-blur-2xl backdrop-saturate-150',
          // A lit top edge, like glass catching the light.
          'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:bg-linear-to-b before:from-foreground/[0.06] before:to-transparent',
        )}
      >
        <StartMenu />
        <TaskButtons />
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <ScreenRecordingMenuItem />
          <StudioMenuItem />
          <ScreenShareMenuItem />
          <WorkspacesMenuItem />
          <TrayItems />
          <AssistantMenuItem />
          <AirPlayMenuItem />
          <BrightnessMenuItem />
          <VolumeMenuItem />
          <BatteryMenuItem />
          <BluetoothMenuItem />
          <WifiMenuItem />
          <AccountMenuItem />
        </div>
        <div className="flex shrink-0 items-stretch py-0.5">
          <ClockMenuItem />
        </div>
      </footer>
    </BarSideContext.Provider>
  );
}

/**
 * The Start button and its menu: the apps launcher, searched from its foot,
 * beside the user, their folders, Settings and the power buttons. Super+Space
 * opens it, as it does the apps menu.
 */
const StartMenu = memo(function StartMenu() {
  const [open, setOpen] = useState(false);
  const [powerAction, setPowerAction] = useState<PowerAction | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => onToggleAppsMenu(() => setOpen((o) => !o)), []);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Start"
            title="Start"
            className={cn(
              'group grid w-12 shrink-0 place-items-center rounded-md',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <span
              className={cn(
                'grid size-8 place-items-center rounded-full border border-white/20 shadow-md ring-1 ring-black/30',
                'bg-[radial-gradient(circle_at_50%_30%,rgb(96_165_250),rgb(30_64_175)_60%,rgb(15_23_42))]',
                'transition-[filter] group-hover:brightness-125 group-data-[state=open]:brightness-125',
              )}
            >
              <img src="/din-logo.svg" alt="" className="h-4 w-auto drop-shadow" draggable={false} />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={4}
          className="flex w-[min(36rem,calc(100vw-1rem))] overflow-hidden rounded-xl p-0"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <AppLauncher
              searchRef={searchRef}
              onClose={() => setOpen(false)}
              searchAtBottom
              listClassName="h-[28rem] max-h-[60vh]"
            />
          </div>
          <StartSidebar onPower={setPowerAction} />
        </PopoverContent>
      </Popover>
      <PowerDialog action={powerAction} onClose={() => setPowerAction(null)} />
    </>
  );
});

/** The Start menu's right column: the user, their folders, Settings, and power. */
function StartSidebar({ onPower }: { onPower: (action: PowerAction) => void }) {
  const { currentUser } = useLoggedInAccounts();
  const { open } = useWindowActions();
  const fs = getFsBridge();
  const { data: home } = useQuery({
    queryKey: ['fs', 'homedir'],
    queryFn: async () => (await fs!.homedir()).replace(/\/$/, ''),
    enabled: !!fs,
    staleTime: Infinity,
  });
  const name = currentUser
    ? currentUser.metadata.name ?? `${nip19.npubEncode(currentUser.pubkey).slice(0, 12)}…`
    : null;

  const link = (key: string, icon: React.ReactNode, label: string, onClick: () => void) => (
    <PopoverClose asChild key={key}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </PopoverClose>
  );

  return (
    <nav aria-label="Places" className="flex w-48 shrink-0 flex-col border-l border-border/60 bg-muted/40">
      {currentUser && (
        <div className="flex items-center gap-3 px-3 pt-4 pb-2">
          <Avatar className="size-10" shape={getAvatarShape(currentUser.metadata)}>
            <AvatarImage src={currentUser.metadata.picture} alt="" />
            <AvatarFallback>{name?.charAt(0) ?? '?'}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        </div>
      )}
      {home && (
        <>
          <div className="flex flex-col gap-0.5 p-2">
            {link('home', <Home aria-hidden />, 'Home', () => open('file-browser', { path: home }))}
            {USER_DIRS.filter((dir) => dir.name !== 'Desktop').map((dir) =>
              link(dir.name, <dir.icon aria-hidden />, dir.name, () => open('file-browser', { path: `${home}/${dir.name}` })),
            )}
          </div>
          <Separator />
        </>
      )}
      <div className="flex flex-col gap-0.5 p-2">
        {link('settings', <Settings2 aria-hidden />, 'Settings', () => open('settings'))}
        {link('app-store', <Store aria-hidden />, 'App Store', () => open('app-store'))}
      </div>
      <div className="mt-auto">
        <SystemButtons onPower={onPower} />
      </div>
    </nav>
  );
}

/**
 * The taskbar's buttons: pinned apps first in pin order, then running apps
 * that aren't pinned, in the order they were dragged into or else launch
 * order. Dragging a button moves it, and dropping an unpinned one among the
 * pinned ones pins it there. Right-clicking between them offers the
 * taskbar's own settings.
 */
function TaskButtons() {
  const { windows } = useWindowManager();
  const actions = useWindowActions();
  const { closeApp } = actions;
  const { getApp, canUninstall, uninstallApp } = useInstalledApps();
  const [pinned, setPinned] = usePinnedApps();

  const togglePin = useCallback(
    (appId: string) =>
      setPinned((prev) => (prev.includes(appId) ? prev.filter((id) => id !== appId) : [...prev, appId])),
    [setPinned],
  );
  const uninstall = useCallback(
    (appId: string) => {
      closeApp(appId);
      setPinned((prev) => prev.filter((id) => id !== appId));
      uninstallApp(appId);
    },
    [closeApp, setPinned, uninstallApp],
  );
  const controls = useMemo<DockControls>(
    () => ({
      open: actions.open,
      focus: actions.focus,
      minimize: actions.minimize,
      closeAll: (appId) => {
        for (const id of [appId, ...appsDockedAs(appId)]) actions.closeApp(id);
      },
    }),
    [actions],
  );

  const [unpinnedOrder, setUnpinnedOrder] = useState<string[]>([]);
  const launching = useLaunchingApps();
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
  const badgeOf = useTileBadges(tileOf);
  const activeWindow = focusedWindow(windows);

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
    constrain: (appId, to) => (pinned.includes(appId) ? Math.min(to, pinnedIds.length - 1) : to),
  });
  const { register } = reorder;
  // Also the tiles the minimize animation flies windows into (dockTiles).
  const registerRef = useCallback((appId: string, el: HTMLDivElement | null) => {
    register(appId, el);
    registerDockTile(appId, el);
  }, [register]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="toolbar" aria-label="Apps" className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-hidden py-0.5">
          {entryIds.map((appId) => {
            const app = getApp(appId);
            if (!app) return null;
            const appWindows = windows
              .filter((w) => tileOf(w.appId) === appId && !w.closing)
              .map((w) => ({ id: w.id, z: w.z, minimized: w.minimized, title: w.title, icon: w.icon }));
            return (
              <TaskButton
                key={appId}
                app={app}
                registerRef={registerRef}
                appWindows={appWindows}
                activeWindowId={activeWindow?.id ?? null}
                controls={controls}
                isPinned={pinned.includes(appId)}
                badge={badgeOf(appId)}
                onTogglePin={togglePin}
                onDragPointerDown={reorder.onPointerDown}
                onUninstall={canUninstall(appId) ? uninstall : undefined}
              />
            );
          })}
        </div>
      </ContextMenuTrigger>
      <TaskbarMenuContent />
    </ContextMenu>
  );
}

/**
 * One app's taskbar button: its icon, framed while it has windows and lit
 * while one of them has focus, with a second edge behind it for several.
 * Clicks, the wheel and its menu act as a Dock tile's do; middle-click opens
 * a new window.
 */
const TaskButton = memo(function TaskButton({
  app,
  registerRef,
  appWindows,
  activeWindowId,
  controls,
  isPinned,
  badge,
  onTogglePin,
  onDragPointerDown,
  onUninstall,
}: {
  app: AppDefinition;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: DockWindow[];
  activeWindowId: string | null;
  controls: DockControls;
  isPinned: boolean;
  badge: AppBadge | null;
  onTogglePin: (appId: string) => void;
  onDragPointerDown: (appId: string, e: React.PointerEvent<HTMLElement>) => void;
  onUninstall?: (appId: string) => void;
}) {
  const active = appWindows.some((w) => w.id === activeWindowId);
  const running = appWindows.length > 0;
  const launching = useLaunching(app.id);
  const frontmost = appWindows.reduce<DockWindow | null>((top, w) => (!top || w.z > top.z ? w : top), null);
  const ref = useCallback((el: HTMLDivElement | null) => registerRef(app.id, el), [registerRef, app.id]);

  const wheel = useRef({ delta: 0, at: 0 });
  const onWheel = (e: React.WheelEvent) => {
    const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    const w = wheel.current;
    w.delta = Math.sign(px) === Math.sign(w.delta) ? w.delta + px : px;
    if (Math.abs(w.delta) < WHEEL_STEP || e.timeStamp - w.at < WHEEL_COOLDOWN) return;
    cycleTile(appWindows, activeWindowId, Math.sign(w.delta), controls.focus);
    w.delta = 0;
    w.at = e.timeStamp;
  };

  const label =
    (running ? `${app.name} (${appWindows.length} window${appWindows.length > 1 ? 's' : ''})` : `Open ${app.name}`) +
    (badge === 'flag' ? ', has news' : badge ? `, ${badge} new` : '');

  return (
    <div ref={ref} data-app-id={app.id} className="relative flex w-14 shrink-0">
      {appWindows.length > 1 && (
        <span aria-hidden className="absolute inset-y-0.5 right-0 left-1 rounded-md border border-foreground/15 bg-foreground/5" />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-pressed={running ? active : undefined}
            title={frontmost?.title ?? app.name}
            onClick={() => clickTile(app.id, appWindows, activeWindowId, controls)}
            onWheel={onWheel}
            onPointerDown={(e) => {
              if (e.button === 0) onDragPointerDown(app.id, e);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) controls.open(app.id);
            }}
            className={cn(
              'relative grid flex-1 place-items-center rounded-md border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              appWindows.length > 1 && 'mr-1',
              active
                ? 'border-foreground/25 bg-foreground/20 shadow-inner'
                : running
                  ? 'border-foreground/15 bg-foreground/10 hover:bg-foreground/15'
                  : 'border-transparent hover:border-foreground/15 hover:bg-foreground/10',
            )}
          >
            <AppIcon
              icon={frontmost?.icon ?? app.icon}
              web={app.web}
              className={cn('size-7 text-foreground drop-shadow-sm', launching && 'motion-safe:animate-pulse')}
            />
            {badge !== null && (
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-0.5 right-1 flex items-center justify-center rounded-full',
                  'bg-red-600 text-[10px] leading-none font-semibold text-white tabular-nums shadow ring-1 ring-black/10',
                  badge === 'flag' ? 'size-2.5' : 'h-4 min-w-4 px-1',
                )}
              >
                {badge === 'flag' ? null : badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <TileMenuContent
          app={app}
          appWindows={appWindows}
          activeWindowId={activeWindowId}
          controls={controls}
          isPinned={isPinned}
          bar="taskbar"
          onTogglePin={onTogglePin}
          onUninstall={onUninstall}
        />
      </ContextMenu>
    </div>
  );
}, (prev, next) =>
  prev.app === next.app &&
  prev.registerRef === next.registerRef &&
  prev.activeWindowId === next.activeWindowId &&
  prev.controls === next.controls &&
  prev.isPinned === next.isPinned &&
  prev.badge === next.badge &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onDragPointerDown === next.onDragPointerDown &&
  prev.onUninstall === next.onUninstall &&
  prev.appWindows.length === next.appWindows.length &&
  prev.appWindows.every((w, i) => {
    const n = next.appWindows[i];
    return w.id === n.id && w.z === n.z && w.minimized === n.minimized && w.title === n.title && w.icon === n.icon;
  }));

/** The menu between the taskbar's buttons: back to the menu bar and Dock, or its settings. */
function TaskbarMenuContent() {
  const { updateConfig } = useAppContext();
  const { open } = useWindowActions();
  return (
    <ContextMenuContent className="z-[10000] w-56">
      <ContextMenuItem onSelect={() => updateConfig((current) => ({ ...current, desktopLayout: 'dock' }))}>
        Use the menu bar and Dock
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => open('settings', { section: 'dock' })}>
        Taskbar Settings…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
