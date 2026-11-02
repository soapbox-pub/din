import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { Home, Settings2, Store } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { useMenuAbove, type MenuAboveContentProps } from '@/hooks/useMenuAbove';
import { TrayItems } from '@/components/desktop/TrayMenu';
import { AssistantMenuItem } from '@/components/desktop/AssistantIndicator';
import { ScreenShareMenuItem } from '@/components/desktop/ScreenShareHost';
import { ScreenRecordingMenuItem } from '@/components/desktop/ScreenRecordingHost';
import { StudioMenuItem } from '@/components/desktop/StudioMenuItem';
import { WorkspacesMenuItem } from '@/components/desktop/WorkspacesIndicator';
import type { TaskbarStyle } from '@/contexts/AppContext';
import { BarSideContext, useBarSide, useTaskbarEdge } from '@/contexts/BarSideContext';
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
import { isTaskbarVertical, TASKBAR_POSITIONS, TASKBAR_STYLES } from '@/lib/taskbarStyles';
import { cn } from '@/lib/utils';
import { USER_DIRS } from '@/shared/userDirs';

/** Wheel travel that steps a button to its app's next window, in px. */
const WHEEL_STEP = 50;
/** Minimum time between wheel steps, in ms. */
const WHEEL_COOLDOWN = 120;

/**
 * How each build of the taskbar (AppConfig's taskbarStyle) sizes its parts,
 * across the bottom or top of the screen or down one of its sides.
 */
interface TaskbarSizes {
  /** Whether the bar runs down the side of the screen, its buttons in a column. */
  vertical: boolean;
  /** The bar's thickness: its height across the screen, its width down it. */
  bar: string;
  /** The bar's glass: Vista's darker, 7's clearer. */
  glass: string;
  /** An app's button, and the Start button: its width in a row, its height in a column. */
  tile: string;
  /** The icon on an app's button. */
  icon: string;
  /** The icon on a window's button, beside its title. */
  windowIcon: string;
  /** The Start button's logo. */
  logo: string;
}

// Down a side, `bar` matches taskbarWorkspaceClass's margin.
const TASKBAR_SIZES: Record<TaskbarStyle, Record<'row' | 'column', TaskbarSizes>> = {
  slim: {
    row: { vertical: false, bar: 'h-10', glass: 'bg-background/70', tile: 'w-14', icon: 'size-7', windowIcon: 'size-5', logo: 'h-6' },
    column: { vertical: true, bar: 'w-14', glass: 'bg-background/70', tile: 'h-12', icon: 'size-7', windowIcon: 'size-7', logo: 'h-6' },
  },
  tall: {
    row: { vertical: false, bar: 'h-13', glass: 'bg-background/55', tile: 'w-16', icon: 'size-9', windowIcon: 'size-6', logo: 'h-8' },
    column: { vertical: true, bar: 'w-16', glass: 'bg-background/55', tile: 'h-14', icon: 'size-9', windowIcon: 'size-9', logo: 'h-8' },
  },
};

/** One window on the taskbar, with what its button's menu needs to know. */
type TaskWindow = DockWindow & { maximized: boolean };

/** What a window's taskbar button does to it beyond a Dock tile's controls. */
interface WindowControls {
  toggleMaximize: (id: string) => void;
  close: (id: string) => void;
}

/**
 * The taskbar, Windows style: one bar along the bottom of the primary
 * monitor in place of the menu bar and the Dock (AppConfig's desktopLayout),
 * or along its top, or down its left side as Ubuntu's is, or its right (taskbarPosition),
 * slim like Vista's or tall like 7's (taskbarStyle). The Start button opens
 * the apps launcher beside the user's folders and the power buttons; then
 * come the pinned apps and the running ones, either a button per app that
 * groups its windows as a Dock tile does (and shares the Dock's pins, clicks
 * and right-click menu) or a labeled button per window (taskbarButtons); then
 * the menu bar's status icons and the clock in the corner. Unlike the Dock it
 * never hides, and windows maximize above it.
 */
export function Taskbar() {
  const { config } = useAppContext();
  const position = config.taskbarPosition;
  const sizes = TASKBAR_SIZES[config.taskbarStyle][isTaskbarVertical(position) ? 'column' : 'row'];
  const vertical = sizes.vertical;
  return (
    <BarSideContext.Provider value={position}>
      <footer
        aria-label="Taskbar"
        className={cn(
          // Chrome, not content: no text cursor or selection anywhere in it.
          'z-20 flex shrink-0 cursor-default select-none items-stretch gap-1 tracking-tight',
          sizes.bar,
          sizes.glass,
          'border-border/60 backdrop-blur-2xl backdrop-saturate-150',
          // Glass catching the light along its top or outer edge.
          'before:pointer-events-none before:absolute before:from-foreground/[0.06] before:to-transparent',
          vertical
            ? 'absolute inset-y-0 flex-col py-1 before:inset-y-0 before:w-1/2'
            : 'relative px-1 before:inset-x-0 before:top-0 before:h-1/2 before:bg-linear-to-b',
          position === 'bottom' && 'border-t',
          position === 'left' && 'left-0 border-r before:left-0 before:bg-linear-to-r',
          position === 'right' && 'right-0 border-l before:right-0 before:bg-linear-to-l',
          // Laid out after the workspace, but shown above it.
          position === 'top' && 'order-first border-b',
        )}
      >
        <StartMenu sizes={sizes} />
        <TaskButtons sizes={sizes} separate={config.taskbarButtons === 'separate'} />
        <div className={cn('flex shrink-0 items-center gap-1', vertical ? 'flex-wrap justify-center px-1' : 'pl-1')}>
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
        <div className={cn('flex shrink-0 items-stretch', vertical ? 'px-0.5' : 'py-0.5')}>
          <ClockMenuItem />
        </div>
      </footer>
    </BarSideContext.Provider>
  );
}

/**
 * The Start button and its menu: the apps launcher, searched from its foot,
 * beside the user, their folders, Settings and the power buttons. Super+Space
 * opens it, as it does the apps menu. The button is Din's logo on its own.
 */
const StartMenu = memo(function StartMenu({ sizes }: { sizes: TaskbarSizes }) {
  const side = useBarSide();
  const edge = useTaskbarEdge();
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
              'grid shrink-0 place-items-center rounded-md border border-transparent transition-colors',
              sizes.vertical ? 'mx-0.5' : 'my-0.5',
              sizes.tile,
              'hover:border-foreground/15 hover:bg-foreground/10',
              'data-[state=open]:border-foreground/25 data-[state=open]:bg-foreground/20 data-[state=open]:shadow-inner',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <img
              src="/din-logo.svg"
              alt=""
              className={cn('w-auto max-w-[80%] object-contain drop-shadow-sm', sizes.logo)}
              draggable={false}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
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
              searchAtBottom={edge === 'bottom'}
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
 * taskbar's own settings. With `separate`, an app with windows has a button
 * for each of them in its place instead, dragged together.
 */
function TaskButtons({ sizes, separate }: { sizes: TaskbarSizes; separate: boolean }) {
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
  const windowControls = useMemo<WindowControls>(
    () => ({ toggleMaximize: actions.toggleMaximize, close: actions.close }),
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
    axis: sizes.vertical ? 'y' : 'x',
  });
  const { register } = reorder;
  // Also the tiles the minimize animation flies windows into (dockTiles).
  const registerRef = useCallback((appId: string, el: HTMLDivElement | null) => {
    register(appId, el);
    registerDockTile(appId, el);
  }, [register]);
  const menuAbove = useMenuAbove();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild {...menuAbove.trigger}>
        <div
          role="toolbar"
          aria-label="Apps"
          aria-orientation={sizes.vertical ? 'vertical' : 'horizontal'}
          className={cn(
            'flex flex-1 items-stretch gap-0.5 overflow-hidden',
            sizes.vertical ? 'min-h-0 flex-col px-0.5' : 'min-w-0 py-0.5',
          )}
        >
          {entryIds.map((appId) => {
            const app = getApp(appId);
            if (!app) return null;
            const appWindows: TaskWindow[] = windows
              .filter((w) => tileOf(w.appId) === appId && !w.closing)
              .map((w) => ({ id: w.id, z: w.z, minimized: w.minimized, title: w.title, icon: w.icon, maximized: w.maximized }));
            if (separate && appWindows.length > 0) {
              return (
                <WindowButtons
                  key={appId}
                  app={app}
                  sizes={sizes}
                  registerRef={registerRef}
                  appWindows={appWindows}
                  activeWindowId={activeWindow?.id ?? null}
                  controls={controls}
                  windowControls={windowControls}
                  isPinned={pinned.includes(appId)}
                  badge={badgeOf(appId)}
                  onTogglePin={togglePin}
                  onDragPointerDown={reorder.onPointerDown}
                  onUninstall={canUninstall(appId) ? uninstall : undefined}
                />
              );
            }
            return (
              <TaskButton
                key={appId}
                app={app}
                sizes={sizes}
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
      <TaskbarMenuContent above={menuAbove.content} />
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
  sizes,
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
  sizes: TaskbarSizes;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: TaskWindow[];
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
  const menuAbove = useMenuAbove();

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
    <div ref={ref} data-app-id={app.id} className={cn('relative flex shrink-0', sizes.tile)}>
      {appWindows.length > 1 && (
        <span
          aria-hidden
          className={cn(
            'absolute rounded-md border border-foreground/15 bg-foreground/5',
            sizes.vertical ? 'inset-x-0.5 top-1 bottom-0' : 'inset-y-0.5 right-0 left-1',
          )}
        />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild {...menuAbove.trigger}>
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
              appWindows.length > 1 && (sizes.vertical ? 'mb-1' : 'mr-1'),
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
              className={cn(sizes.icon, 'text-foreground drop-shadow-sm', launching && 'motion-safe:animate-pulse')}
            />
            {badge !== null && <TileBadge badge={badge} />}
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
          above={menuAbove.content}
        />
      </ContextMenu>
    </div>
  );
}, (prev, next) =>
  prev.app === next.app &&
  prev.sizes === next.sizes &&
  prev.registerRef === next.registerRef &&
  prev.activeWindowId === next.activeWindowId &&
  prev.controls === next.controls &&
  prev.isPinned === next.isPinned &&
  prev.badge === next.badge &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onDragPointerDown === next.onDragPointerDown &&
  prev.onUninstall === next.onUninstall &&
  sameWindows(prev.appWindows, next.appWindows));

/** Whether two lists of a button's windows would draw it the same. */
function sameWindows(a: TaskWindow[], b: TaskWindow[]): boolean {
  return a.length === b.length && a.every((w, i) => {
    const n = b[i];
    return w.id === n.id && w.z === n.z && w.minimized === n.minimized && w.title === n.title && w.icon === n.icon &&
      w.maximized === n.maximized;
  });
}

/** The count or dot on a taskbar button for an app's news. */
function TileBadge({ badge }: { badge: AppBadge }) {
  return (
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
  );
}

/**
 * An app's windows on the taskbar when they're kept separate, as on Windows
 * XP and Vista: a button for each, its icon beside its title, that shrinks
 * as the bar fills. A click raises its window or, if it's the active one,
 * minimizes it; middle-click opens a new one; its menu acts on that window
 * first, then on its app. The group drags as one, where the app's button
 * would be. Down a taskbar at the side there's no room for titles, so each
 * window's button is its icon alone.
 */
const WindowButtons = memo(function WindowButtons({
  app,
  sizes,
  registerRef,
  appWindows,
  activeWindowId,
  controls,
  windowControls,
  isPinned,
  badge,
  onTogglePin,
  onDragPointerDown,
  onUninstall,
}: {
  app: AppDefinition;
  sizes: TaskbarSizes;
  registerRef: (appId: string, el: HTMLDivElement | null) => void;
  appWindows: TaskWindow[];
  activeWindowId: string | null;
  controls: DockControls;
  windowControls: WindowControls;
  isPinned: boolean;
  badge: AppBadge | null;
  onTogglePin: (appId: string) => void;
  onDragPointerDown: (appId: string, e: React.PointerEvent<HTMLElement>) => void;
  onUninstall?: (appId: string) => void;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => registerRef(app.id, el), [registerRef, app.id]);
  // Shared by its buttons: only one menu is open at a time.
  const menuAbove = useMenuAbove();

  return (
    <div
      ref={ref}
      data-app-id={app.id}
      className={cn('flex gap-0.5', sizes.vertical ? 'shrink-0 flex-col' : 'min-w-0')}
      // As wide as its buttons at their widest, shrinking with the bar.
      style={sizes.vertical ? undefined : { flex: `0 1 calc(${appWindows.length} * 10rem + ${appWindows.length - 1} * 0.125rem)` }}
    >
      {appWindows.map((w, i) => {
        const active = w.id === activeWindowId;
        const title = w.title ?? app.name;
        const shownBadge = i === 0 ? badge : null;
        const label =
          title + (w.minimized ? ', minimized' : '') +
          (shownBadge === 'flag' ? ', has news' : shownBadge ? `, ${shownBadge} new` : '');
        return (
          <ContextMenu key={w.id}>
            <ContextMenuTrigger asChild {...menuAbove.trigger}>
              <button
                type="button"
                aria-label={label}
                aria-pressed={active}
                title={title}
                onClick={() => clickTile(app.id, [w], activeWindowId, controls)}
                onPointerDown={(e) => {
                  if (e.button === 0) onDragPointerDown(app.id, e);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) controls.open(app.id);
                }}
                className={cn(
                  'relative flex items-center overflow-hidden rounded-md border text-xs transition-colors',
                  sizes.vertical
                    ? cn('shrink-0 justify-center', sizes.tile)
                    : 'max-w-40 min-w-10 flex-1 basis-0 gap-2 px-2 text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-foreground/25 bg-foreground/20 font-medium text-foreground shadow-inner'
                    : 'border-foreground/15 bg-foreground/10 text-foreground/85 hover:bg-foreground/15 hover:text-foreground',
                )}
              >
                <AppIcon
                  icon={w.icon ?? app.icon}
                  web={app.web}
                  className={cn(sizes.windowIcon, 'shrink-0 text-foreground drop-shadow-sm', w.minimized && 'opacity-70')}
                />
                {!sizes.vertical && <span className="min-w-0 flex-1 truncate">{title}</span>}
                {shownBadge !== null && <TileBadge badge={shownBadge} />}
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
              taskWindow={{ ...w, ...windowControls }}
              above={menuAbove.content}
            />
          </ContextMenu>
        );
      })}
    </div>
  );
}, (prev, next) =>
  prev.app === next.app &&
  prev.sizes === next.sizes &&
  prev.registerRef === next.registerRef &&
  prev.activeWindowId === next.activeWindowId &&
  prev.controls === next.controls &&
  prev.windowControls === next.windowControls &&
  prev.isPinned === next.isPinned &&
  prev.badge === next.badge &&
  prev.onTogglePin === next.onTogglePin &&
  prev.onDragPointerDown === next.onDragPointerDown &&
  prev.onUninstall === next.onUninstall &&
  sameWindows(prev.appWindows, next.appWindows));

/**
 * The menu between the taskbar's buttons: its size and position, whether windows combine,
 * back to the menu bar and Dock, or its settings.
 */
function TaskbarMenuContent({ above }: { above: MenuAboveContentProps }) {
  const { config, updateConfig } = useAppContext();
  const { open } = useWindowActions();
  return (
    <ContextMenuContent className="z-[10000] w-56" {...above}>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Size</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuRadioGroup
            value={config.taskbarStyle}
            onValueChange={(value) => {
              const style = TASKBAR_STYLES.find((s) => s.value === value);
              if (style) updateConfig((current) => ({ ...current, taskbarStyle: style.value }));
            }}
          >
            {TASKBAR_STYLES.map((s) => (
              <ContextMenuRadioItem key={s.value} value={s.value}>
                {s.name}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Position</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuRadioGroup
            value={config.taskbarPosition}
            onValueChange={(value) => {
              const position = TASKBAR_POSITIONS.find((p) => p.value === value);
              if (position) updateConfig((current) => ({ ...current, taskbarPosition: position.value }));
            }}
          >
            {TASKBAR_POSITIONS.map((p) => (
              <ContextMenuRadioItem key={p.value} value={p.value}>
                {p.name}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuCheckboxItem
        checked={config.taskbarButtons === 'combine'}
        onCheckedChange={(checked) =>
          updateConfig((current) => ({ ...current, taskbarButtons: checked ? 'combine' : 'separate' }))
        }
      >
        Combine windows
      </ContextMenuCheckboxItem>
      <ContextMenuSeparator />
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
