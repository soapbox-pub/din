import { Airplay, BellOff, Bluetooth, BluetoothConnected, BluetoothOff, CalendarDays, CircleUserRound, EthernetPort, LayoutGrid, Lock, LogOut, Power, RotateCcw, Search, Settings2, Trash2, UserMinus, UserPlus, WifiOff } from 'lucide-react';
import { WifiXIcon } from '@/components/icons/WifiXIcon';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { nip19 } from 'nostr-tools';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarShape } from '@/lib/avatarShape';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import AuthDialog from '@/components/auth/AuthDialog';
import { QuickLoginDialog } from '@/components/auth/QuickLoginDialog';
import { RemoveAccountDialog } from '@/components/auth/RemoveAccountDialog';
import { EditProfileForm } from '@/components/EditProfileForm';
import { AppIcon } from '@/components/desktop/AppIcon';
import { BarPopoverContent } from '@/components/desktop/BarPopoverContent';
import { useTaskbarEdge } from '@/contexts/BarSideContext';
import { setMenuBarSlot } from '@/lib/menuBarSlot';
import { getWindowChrome, TEAR_AWAY_PX } from '@/lib/windowChromes';
import type { WindowChrome } from '@/contexts/WindowChromeContext';
import { WifiPopoverBody, WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { BatteryGlyph, BatteryPopoverBody } from '@/components/desktop/BatteryIndicator';
import { VolumeGlyph, VolumePopoverBody } from '@/components/desktop/VolumeIndicator';
import { BrightnessGlyph, BrightnessPopoverBody } from '@/components/desktop/BrightnessIndicator';
import { AirPlayPopoverBody } from '@/components/desktop/AirPlayIndicator';
import { BluetoothPopoverBody } from '@/components/desktop/BluetoothIndicator';
import { useBluetoothState } from '@/hooks/useBluetooth';
import { getBluetoothBridge } from '@/lib/bluetooth';
import { useAirPlayState } from '@/hooks/useAirPlay';
import { getAirPlayBridge } from '@/lib/airplay';
import { NotificationsPanel } from '@/components/desktop/NotificationsIndicator';
import { useNotificationsBadge } from '@/hooks/useNotificationsBadge';
import { Calendar } from '@/components/ui/calendar';
import { isoDate } from '@/shared/calendar';
import { TrayItems } from '@/components/desktop/TrayMenu';
import { moveAmongItems } from '@/lib/desktopFocus';
import { AssistantMenuItem } from '@/components/desktop/AssistantIndicator';
import { ScreenShareMenuItem } from '@/components/desktop/ScreenShareHost';
import { ScreenRecordingMenuItem } from '@/components/desktop/ScreenRecordingHost';
import { StudioMenuItem } from '@/components/desktop/StudioMenuItem';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { onToggleAppsMenu } from '@/lib/appsMenu';
import { parseQuery } from '@/lib/settingsSearch';
import { matchingSections, type SettingsSection } from '@/lib/settingsSections';
import { useClock } from '@/hooks/useClock';
import { useAppContext } from '@/hooks/useAppContext';
import { timeFormatOptions } from '@/lib/datetime';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
import { useNostrd } from '@/hooks/useNostrd';
import { useQuery } from '@tanstack/react-query';
import { getLockBridge } from '@/lib/lock';
import { getSessionBridge } from '@/lib/session';
import { useAuthor } from '@/hooks/useAuthor';
import { useWifiNetworks, useWifiStatus } from '@/hooks/useWifi';
import { useBatteryStatus } from '@/hooks/usePower';
import { useAudioStatus } from '@/hooks/useAudio';
import { useBrightnessStatus } from '@/hooks/useBrightness';
import { getWifiBridge, isEthernetConnected } from '@/lib/wifi';
import { getPowerBridge, summarizePower } from '@/lib/power';
import { PowerDialog, type PowerAction } from '@/components/desktop/PowerDialog';
import { getAudioBridge } from '@/lib/audio';
import { getBrightnessBridge } from '@/lib/brightness';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { themeColorTokens } from '@/lib/themeColor';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { primaryArea } from '@/lib/monitors';
import type { AppDefinition } from '@/lib/apps';
import { focusedWindow, isShown } from '@/hooks/useWindows';
import { WorkspacesMenuItem } from '@/components/desktop/WorkspacesIndicator';
import { isTaskbarVertical } from '@/lib/taskbarStyles';
import { AddToDesktopItem } from '@/components/desktop/icons/AddToDesktopItem';
import { APP_MIME } from '@/components/desktop/icons/wallpaper';
import { useWallpaperTone } from '@/hooks/useWallpaperTone';

/** The bar's height (h-9), which is the strip of wallpaper its look follows. */
const MENU_BAR_HEIGHT = 36;

/**
 * The scrim over the wallpaper, reaching past the bar (h-12) so it can fade
 * out gently. It holds 55% down to the bottom of the bar's text, which is what
 * white text needs for 4.5:1 even over a pure white part of the wallpaper.
 */
const WALLPAPER_SCRIM: Record<'dark' | 'light', string> = {
  dark: 'linear-gradient(to bottom, rgb(0 0 0 / 0.65), rgb(0 0 0 / 0.55) 50%, rgb(0 0 0 / 0.2) 75%, transparent)',
  light: 'linear-gradient(to bottom, rgb(255 255 255 / 0.65), rgb(255 255 255 / 0.55) 50%, rgb(255 255 255 / 0.2) 75%, transparent)',
};

/**
 * Menu bar along the top of the desktop.
 *
 * The apps menu (the full launcher with search) and the focused app's name
 * sit on the left. The clock sits in the center and opens a calendar above
 * the notification center, GNOME style. Ambient indicators — apps' status
 * icons, hardware, Wi-Fi, and the signed-in account — sit on the right, each
 * behind its own affordance.
 *
 * The bar itself is borderless and transparent, over a soft scrim fading
 * into the wallpaper so it reads as part of the desktop rather than a
 * separate chrome strip. Over a wallpaper, its text and scrim follow the
 * wallpaper instead of the theme, as macOS's do: white over a dark scrim on a
 * dark one, black over a light scrim on a light one, the same along the whole
 * bar. The scrim is strong enough to keep that text legible over the parts of
 * the wallpaper that go the other way. A window maximized under it paints its title bar's
 * color up behind the bar (Window's bar strip) - its app's accent, the
 * default translucent chrome, or for a frameless window, whose title bar's
 * color isn't known, solid white or black - so the two read as one seamless
 * strip, and every animation of the window carries the color with it. The
 * scrim sits under the windows for the same reason.
 */
export function MenuBar() {
  // Subscribes to window state (for the maximized window's text colors), so
  // this re-renders on every window commit - all children are memoized so
  // the re-render stops at this component's own <header> element.
  const { windows } = useWindowManager();
  // Only a window maximized beneath it - on the primary monitor - counts,
  // and of several, the one on top.
  const primaryId = primaryArea(useWorkAreas()).id;
  const fullscreen = windows.reduce<(typeof windows)[number] | null>(
    (top, w) =>
      w.maximized && isShown(w) && (w.monitor === null || w.monitor === primaryId) &&
      (!top || w.z > top.z)
        ? w
        : top,
    null,
  );
  const accent = fullscreen && !fullscreen.frameless ? fullscreen.accent : null;
  // The focused window is the highest visible one, as for its focus ring.
  const focused = focusedWindow(windows);
  const pull = usePullDown(fullscreen?.id ?? null);
  const tone = useWallpaperTone(MENU_BAR_HEIGHT);
  // Under a maximized window the text goes with its title bar, not the wallpaper.
  const tokens = accent
    ? themeColorTokens(accent)
    : !fullscreen && tone && themeColorTokens(tone === 'dark' ? '#000000' : '#ffffff');

  return (
    <>
    {/* Before the workspace, so under every window. It stays the wallpaper's
        while a window maximizes or restores: the window's strip, near enough
        opaque, covers it as it arrives, so changing it would only show as a
        flash ahead of the window. */}
    {tone ? (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-12"
        style={{ background: WALLPAPER_SCRIM[tone] }}
      />
    ) : (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-9 bg-gradient-to-b from-background/60 via-background/25 to-transparent"
      />
    )}
    <header
      aria-label="Menu bar"
      // Ctrl+F2 lands on the Apps button (src/lib/desktopFocus.ts), and the
      // arrow keys go along the bar.
      data-focus-area="menu-bar"
      onKeyDown={(e) => moveAmongItems(e, 'button')}
      {...pull}
      // The accent is sanitized by the window; its tokens keep the bar's
      // contents legible on it, as on the title bar. Over the wallpaper, the
      // same tokens keep them legible on its scrim.
      style={tokens || undefined}
      // Equal side columns keep the clock centered on the screen however
      // much each side holds.
      // tracking-tight approximates SF Pro's optical spacing at menu-bar sizes.
      // Chrome, not content: no text cursor or selection anywhere in it.
      // No color transition on its buttons' text and icons: they must change
      // with the title bar under them, in the same frame. Hover highlights
      // still fade.
      className="relative z-20 grid h-9 cursor-default select-none grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 tracking-tight [&_button]:transition-[background-color,box-shadow,opacity]"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AppsMenu />
        <FocusedAppName appId={focused?.appId ?? null} />
        {/* The focused app's own menus (MenuBarMenus portals them here). */}
        <div ref={setMenuBarSlot} className="flex min-w-0 items-center gap-0.5" />
      </div>
      <ClockMenuItem />
      <div aria-label="Status" role="group" data-focus-area="status" className="flex min-w-0 items-center justify-end gap-1.5">
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
    </header>
    </>
  );
}

/** A press on the bar that isn't on one of its controls. */
function onEmptyBar(e: React.PointerEvent | React.MouseEvent): boolean {
  const target = e.target as HTMLElement;
  // Presses in the bar's popovers and menus bubble here through React, but
  // aren't on the bar.
  return (
    e.currentTarget.contains(target) &&
    !target.closest('button, a, input, textarea, [role="tab"], [role="menuitem"], [data-window-no-drag]')
  );
}

/**
 * The bar stands in for the title bar of the maximized window under it, as
 * it looks like one: pulling down on its empty space tears the window away,
 * and double-clicking there restores it. A press does nothing until the
 * pointer moves, so a click on the bar doesn't focus the window.
 */
function usePullDown(windowId: string | null) {
  const { toggleMaximize } = useWindowActions();
  const press = useRef<{ windowId: string; pointerId: number; x: number; y: number; chrome: WindowChrome | null } | null>(null);

  const end = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    p.chrome?.gestureEnd();
  };

  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !windowId || press.current || !onEmptyBar(e)) return;
      press.current = { windowId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, chrome: null };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointerId !== e.pointerId) return;
      if (!p.chrome) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < TEAR_AWAY_PX) return;
        const chrome = getWindowChrome(p.windowId);
        if (!chrome?.beginMove({ clientX: p.x, clientY: p.y })) {
          press.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
          return;
        }
        p.chrome = chrome;
      }
      p.chrome.gestureMove(e);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick: (e: React.MouseEvent<HTMLElement>) => {
      if (windowId && onEmptyBar(e)) toggleMaximize(windowId);
    },
  };
}

/**
 * The focused app's name, like the bold app name in the macOS menu bar, so
 * it's clear which app has focus even when its window has no title bar.
 */
const FocusedAppName = memo(function FocusedAppName({ appId }: { appId: string | null }) {
  const { apps } = useInstalledApps();
  const app = appId ? apps.find((a) => a.id === appId) : undefined;
  if (!app) return null;

  return (
    <span className="truncate px-1 text-sm font-semibold text-foreground">
      {app.name}
    </span>
  );
});

/** Left menu: the full searchable apps launcher. */
const AppsMenu = memo(function AppsMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Super+Space (see DesktopHotkeys) toggles the menu.
  useEffect(() => onToggleAppsMenu(() => setMenuOpen((open) => !open)), []);

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open apps menu"
          className="h-7 gap-1.5 rounded-md px-2.5 text-sm font-medium text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
        >
          <LayoutGrid className="size-4" aria-hidden />
          Apps
        </Button>
      </PopoverTrigger>
      <BarPopoverContent
        align="start"
        className="w-96 rounded-2xl p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <AppLauncher searchRef={searchRef} onClose={() => setMenuOpen(false)} />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * The apps launcher: a search over the apps and Settings' sections, and
 * their tiles. It lives in a popover (the apps menu, the Start menu), whose
 * tiles close it, and mounts afresh each time that opens, so it always opens
 * on a fresh search. The Start menu puts the search under the tiles.
 */
export function AppLauncher({
  searchRef,
  onClose,
  searchAtBottom = false,
  listClassName,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Closes the popover, when Enter launches the first match. */
  onClose: () => void;
  searchAtBottom?: boolean;
  listClassName?: string;
}) {
  const { apps, uninstallApp, canUninstall } = useInstalledApps();
  // Actions only: keeps the launcher (a large Radix popover tree) out of
  // the per-window-commit re-render cascade.
  const { open, closeApp } = useWindowActions();
  const [query, setQuery] = useState('');

  /** Uninstall an app: close its windows, then drop the entry. */
  const uninstall = useCallback((appId: string) => {
    closeApp(appId);
    uninstallApp(appId);
  }, [closeApp, uninstallApp]);

  // Native apps also match on their desktop entry's Keywords and Categories,
  // so "browser" finds Firefox and "photo" finds an image editor.
  const needle = query.trim().toLowerCase();
  const launcherApps = apps.filter((app) => {
    if (app.hidden) return false;
    if (!needle) return true;
    return (
      app.name.toLowerCase().includes(needle) ||
      (app.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))
    );
  });
  // Din's own apps lead; the host system's installed apps follow in their own
  // section, since there are typically hundreds of them.
  const dinApps = launcherApps.filter((app) => !app.native);
  const nativeApps = launcherApps.filter((app) => app.native);
  // Settings' sections match the way Settings' own search does, once the
  // query has two letters or digits, so "display" or "wifi" finds them.
  const terms = parseQuery(query);
  const settings = terms.join('').length >= 2 ? matchingSections(terms) : [];
  const openSetting = (section: SettingsSection) => open('settings', { section: section.id });

  /** Enter in the search launches the first match, as shown. */
  const launchFirst = () => {
    const first = dinApps[0];
    if (first) {
      onClose();
      open(first.id);
    } else if (settings[0]) {
      onClose();
      openSetting(settings[0]);
    } else if (nativeApps[0]) {
      onClose();
      open(nativeApps[0].id);
    }
  };

  const search = (
    <div
      className={cn(
        'flex items-center gap-2.5 border-border/60 px-4 py-3',
        searchAtBottom ? 'order-last border-t' : 'border-b',
      )}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={searchRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          launchFirst();
        }}
        placeholder="Search your apps…"
        aria-label="Search apps"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col">
      {search}
      <div className={cn('max-h-96 overflow-y-auto p-3', listClassName)}>
        {launcherApps.length === 0 && settings.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No apps or settings match “{query}”.
          </p>
        ) : (
          <>
            <AppGrid
              apps={dinApps}
              onOpen={open}
              onUninstall={uninstall}
              canUninstall={canUninstall}
            />
            {settings.length > 0 && (
              <>
                {dinApps.length > 0 && <LauncherHeading>Settings</LauncherHeading>}
                <SettingsList sections={settings} onOpen={openSetting} />
              </>
            )}
            {nativeApps.length > 0 && (
              <>
                {(dinApps.length > 0 || settings.length > 0) && <LauncherHeading>System</LauncherHeading>}
                <AppGrid
                  apps={nativeApps}
                  onOpen={open}
                  onUninstall={uninstall}
                  canUninstall={canUninstall}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LauncherHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/** Settings' sections that match the search, each opening Settings there. */
function SettingsList({
  sections,
  onOpen,
}: {
  sections: SettingsSection[];
  onOpen: (section: SettingsSection) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {sections.map((section) => (
        <ContextMenu key={section.id}>
          <ContextMenuTrigger asChild>
            <PopoverClose asChild>
              <button
                type="button"
                onClick={() => onOpen(section)}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <section.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{section.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{section.group}</span>
              </button>
            </PopoverClose>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => onOpen(section)}>Open in Settings</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

/** One section of launcher tiles. */
function AppGrid({
  apps,
  onOpen,
  onUninstall,
  canUninstall,
}: {
  apps: AppDefinition[];
  onOpen: (appId: string, params?: Record<string, unknown>) => void;
  onUninstall: (appId: string) => void;
  /** Whether an app can be uninstalled (installed web apps and nsites). */
  canUninstall: (appId: string) => boolean;
}) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {apps.map((app) => (
        <AppTile
          key={app.id}
          app={app}
          onOpen={onOpen}
          onUninstall={onUninstall}
          uninstallable={canUninstall(app.id)}
        />
      ))}
    </div>
  );
}

/**
 * A launcher tile and its menu. Memoized: each keystroke in the search
 * re-renders the launcher, and with the host's apps listed there can be
 * hundreds of tiles, each a stack of Radix components.
 */
const AppTile = memo(function AppTile({
  app,
  onOpen,
  onUninstall,
  uninstallable,
}: {
  app: AppDefinition;
  onOpen: (appId: string, params?: Record<string, unknown>) => void;
  onUninstall: (appId: string) => void;
  uninstallable: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <PopoverClose asChild>
          <button
            type="button"
            onClick={() => onOpen(app.id)}
            // Dragged out onto the wallpaper, it leaves a shortcut there.
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(APP_MIME, app.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            className="flex flex-col items-center gap-2 rounded-xl p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AppIcon icon={app.icon} web={app.web} className="size-9 text-foreground" />
            <span className="line-clamp-2 text-xs leading-tight text-foreground">
              {app.name}
            </span>
          </button>
        </PopoverClose>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onOpen(app.id)}>Open</ContextMenuItem>
        {app.actions?.map((action) => (
          <ContextMenuItem key={action.label} onSelect={() => onOpen(app.id, { ...action.params, actionAt: Date.now() })}>
            {action.label}
          </ContextMenuItem>
        ))}
        <AddToDesktopItem appId={app.id} />
        {uninstallable && (
          <ContextMenuItem
            variant="destructive"
            onSelect={() => onUninstall(app.id)}
          >
            <Trash2 aria-hidden /> Uninstall
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * AirPlay status item: lights up while the screen is shared; clicking lists
 * the receivers to connect to, and switches a connected one between
 * extending and mirroring. Without deckmon it's dimmed, and its panel says
 * what's missing. Renders nothing outside the Electron shell.
 */
export const AirPlayMenuItem = memo(function AirPlayMenuItem() {
  const bridge = getAirPlayBridge();
  const { data } = useAirPlayState();

  if (!bridge || !data) return null;
  const sharing = data.sessions.filter((s) => s.state === 'streaming');

  const label = !data.available
    ? 'Screen sharing: deckmon isn’t installed'
    : sharing.length > 0
      ? `Sharing the screen with ${sharing.map((s) => s.name).join(', ')}`
      : 'Screen sharing';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn(
            'size-7 rounded-md hover:bg-foreground/10 hover:text-foreground',
            sharing.length > 0
              ? 'bg-primary/15 text-primary'
              : data.available ? 'text-foreground/90' : 'text-muted-foreground',
          )}
        >
          <Airplay className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-80 p-0">
        <AirPlayPopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * Brightness status item: sun glyph; clicking opens a backlight slider plus a
 * night-light (red shift) toggle. Renders nothing outside the Electron shell
 * or where neither the backlight nor a gamma tool is present, like the other
 * hardware indicators.
 */
export const BrightnessMenuItem = memo(function BrightnessMenuItem() {
  const bridge = getBrightnessBridge();
  const status = useBrightnessStatus();

  if (!bridge) return null;
  const data = status.data;
  if (!data || (!data.available && !data.nightLight.available)) return null;

  const label = data.available ? `Brightness ${data.brightness ?? '?'}%` : 'Display';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className="size-7 rounded-md text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
        >
          <BrightnessGlyph brightness={data.brightness} className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-72 p-0">
        <BrightnessPopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * Volume status item: speaker glyph; clicking opens a slider + mute popover.
 * Renders nothing outside the Electron shell or where PipeWire/wpctl is
 * absent, like the other hardware indicators.
 */
export const VolumeMenuItem = memo(function VolumeMenuItem() {
  const bridge = getAudioBridge();
  const status = useAudioStatus();

  if (!bridge || !status.data?.available) return null;

  const { volume, muted } = status.data;
  const label = muted ? 'Volume muted' : `Volume ${volume ?? '?'}%`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn(
            'size-7 rounded-md hover:bg-foreground/10 hover:text-foreground',
            muted ? 'text-muted-foreground' : 'text-foreground/90',
          )}
        >
          <VolumeGlyph volume={volume} muted={muted} className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-72 p-0">
        <VolumePopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * Battery status item: a macOS-style solid-fill glyph (bolt when charging);
 * clicking opens a details popover. Renders nothing outside the Electron
 * shell or on machines with no battery (desktops, the VM), like the other
 * hardware indicators.
 */
export const BatteryMenuItem = memo(function BatteryMenuItem() {
  const bridge = getPowerBridge();
  const status = useBatteryStatus();

  if (!bridge || !status.data?.available) return null;

  const summary = summarizePower(status.data);
  if (!summary) return null;

  const critical = !summary.charging && summary.percent !== null && summary.percent <= 15;
  const label = `Battery ${summary.percent ?? '?'}%${summary.charging ? ', charging' : ''}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          className={cn(
            'h-7 rounded-md px-0 hover:bg-foreground/10 hover:text-foreground',
            critical ? 'text-destructive' : 'text-foreground/90',
          )}
        >
          {/* size-* class opts out of the Button's [&_svg]:size-4 override. */}
          <BatteryGlyph
            percent={summary.percent}
            charging={summary.charging}
            className="size-4 w-6.5"
          />
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-72 p-0">
        <BatteryPopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * Bluetooth status item: the glyph says whether it's off, on, or connected
 * to something; clicking lists the paired devices. Renders nothing outside
 * the Electron shell or without an adapter.
 */
export const BluetoothMenuItem = memo(function BluetoothMenuItem() {
  const bridge = getBluetoothBridge();
  const { data } = useBluetoothState();

  if (!bridge || !data?.available || !data.adapter) return null;
  const powered = data.adapter.powered;
  const connected = powered ? data.devices.filter((d) => d.connected) : [];

  const label = !powered
    ? 'Bluetooth off'
    : connected.length > 0
      ? `Bluetooth connected to ${connected.map((d) => d.name).join(', ')}`
      : 'Bluetooth on';
  const Icon = !powered ? BluetoothOff : connected.length > 0 ? BluetoothConnected : Bluetooth;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn(
            'size-7 rounded-md hover:bg-foreground/10 hover:text-foreground',
            powered ? 'text-foreground/90' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-72 p-0">
        <BluetoothPopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/**
 * Wi-Fi status item: glyph mirrors the adapter state; clicking opens the
 * quick-connect panel. Renders nothing outside the Electron shell or on
 * systems without an adapter, like hardware indicators do.
 */
export const WifiMenuItem = memo(function WifiMenuItem() {
  const bridge = getWifiBridge();
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const ethernet = isEthernetConnected(status.data);
  const networks = useWifiNetworks(radioEnabled && hasAdapter);

  // Render when there's a Wi-Fi adapter or a live wired link; an ethernet-only
  // machine still gets a network indicator.
  if (!bridge || !status.data?.available || (!hasAdapter && !ethernet)) return null;

  const current = networks.data?.find((n) => n.inUse) ?? null;
  const connected = radioEnabled && current != null;

  // A wired link takes visual priority over Wi-Fi when both are up.
  const label = ethernet
    ? 'Connected via Ethernet'
    : !radioEnabled
      ? 'Wi-Fi off'
      : connected
        ? `Wi-Fi connected to ${current.ssid}`
        : 'Wi-Fi not connected';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn(
            'size-7 rounded-md hover:bg-foreground/10 hover:text-foreground',
            radioEnabled || ethernet ? 'text-foreground/90' : 'text-muted-foreground',
          )}
        >
          {ethernet ? (
            <EthernetPort className="size-4.5" />
          ) : !radioEnabled ? (
            <WifiOff className="size-4.5" />
          ) : connected ? (
            <WifiSignalIcon signal={current.signal} className="size-4.5" />
          ) : (
            <WifiXIcon className="size-4.5" />
          )}
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-80 p-0">
        <WifiPopoverBody />
      </BarPopoverContent>
    </Popover>
  );
});

/** Account status item: avatar opens the account panel. */
export const AccountMenuItem = memo(function AccountMenuItem() {
  const { currentUser } = useLoggedInAccounts();
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [quickLoginPubkey, setQuickLoginPubkey] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ pubkey: string; name: string } | null>(null);
  const [powerAction, setPowerAction] = useState<PowerAction | null>(null);

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Account"
            className="grid size-7 place-items-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {currentUser ? (
              <Avatar className="size-4.5" shape={getAvatarShape(currentUser.metadata)}>
                <AvatarImage src={currentUser.metadata.picture} alt="" />
                <AvatarFallback className="text-[9px]">
                  {currentUser.metadata.name?.charAt(0) ?? '?'}
                </AvatarFallback>
              </Avatar>
            ) : (
              <CircleUserRound className="size-4.5 text-foreground/80" aria-hidden />
            )}
          </button>
        </PopoverTrigger>
        <BarPopoverContent align="end" className="w-80 overflow-hidden p-0">
          <AccountPanel
            onAddAccount={() => setAuthDialogOpen(true)}
            onJoin={() => setAuthDialogOpen(true)}
            onQuickLogin={setQuickLoginPubkey}
            onEditProfile={() => setEditProfileOpen(true)}
            onRemoveAccount={setRemoving}
            onPower={setPowerAction}
          />
        </BarPopoverContent>
      </Popover>

      <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />
      <PowerDialog action={powerAction} onClose={() => setPowerAction(null)} />

      <Dialog open={editProfileOpen} onOpenChange={setEditProfileOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>
              Update your public Nostr profile. Changes are published to your relays.
            </DialogDescription>
          </DialogHeader>
          <EditProfileForm onSaved={() => setEditProfileOpen(false)} />
        </DialogContent>
      </Dialog>

      {quickLoginPubkey && (
        <QuickLoginDialog
          isOpen={quickLoginPubkey !== null}
          pubkey={quickLoginPubkey}
          onClose={() => setQuickLoginPubkey(null)}
          onOtherLogin={() => {
            setQuickLoginPubkey(null);
            setAuthDialogOpen(true);
          }}
        />
      )}

      <AuthDialog
        isOpen={authDialogOpen}
        onClose={() => setAuthDialogOpen(false)}
      />
    </>
  );
});

/**
 * Lock, log out, restart, and shut down. Lock is DinOS's lock screen, which
 * takes the computer's password, so it's offered only where there's one to
 * take; log out only where Din is another Linux's login session; restart
 * and shut down only where logind lets this session do them.
 */
export function SystemButtons({ onPower }: { onPower: (action: PowerAction) => void }) {
  const lockBridge = getLockBridge();
  const powerBridge = getPowerBridge();
  const sessionBridge = getSessionBridge();
  const { data: loginSession = false } = useQuery({
    queryKey: ['session', 'login'],
    queryFn: () => sessionBridge?.isLoginSession() ?? false,
    enabled: !!sessionBridge,
    staleTime: Infinity,
  });
  const { data: lockAvailable = false } = useQuery({
    queryKey: ['lock', 'available'],
    queryFn: () => lockBridge?.available() ?? false,
    enabled: !!lockBridge,
    staleTime: 60_000,
  });
  const { data: power } = useQuery({
    queryKey: ['power', 'actions'],
    queryFn: () => powerBridge?.actions() ?? { reboot: false, powerOff: false },
    enabled: !!powerBridge,
    staleTime: 60_000,
  });
  const canLock = !!lockBridge && lockAvailable;
  if (!canLock && !loginSession && !power?.reboot && !power?.powerOff) return null;

  const item = (icon: ReactNode, label: string, onClick: () => void) => (
    <PopoverClose asChild>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        className="justify-start text-muted-foreground hover:text-foreground"
      >
        {icon}
        {label}
      </Button>
    </PopoverClose>
  );
  return (
    <>
      <Separator />
      <div className="flex flex-col gap-1 p-2">
        {canLock && item(<Lock aria-hidden />, 'Lock', () => void lockBridge?.lock())}
        {loginSession && item(<LogOut aria-hidden />, 'Log out…', () => onPower('logOut'))}
        {power?.reboot && item(<RotateCcw aria-hidden />, 'Restart…', () => onPower('reboot'))}
        {power?.powerOff && item(<Power aria-hidden />, 'Shut down…', () => onPower('powerOff'))}
      </div>
    </>
  );
}

/** One account nostrd holds, for the signed-out account panel. */
function ComputerAccountButton({ pubkey, onSelect }: { pubkey: string; onSelect: () => void }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.name ?? `${nip19.npubEncode(pubkey).slice(0, 12)}…`;

  return (
    <PopoverClose asChild>
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-8" shape={getAvatarShape(metadata)}>
          <AvatarImage src={metadata?.picture} alt="" />
          <AvatarFallback className="text-xs">
            {author.isLoading ? <Skeleton className="size-full rounded-full" /> : name.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm font-medium text-foreground">
          {author.isLoading && !metadata ? <Skeleton className="h-3.5 w-24" /> : name}
        </span>
      </button>
    </PopoverClose>
  );
}

/**
 * Menu-bar clock: weekday, date, and time. Clicking opens a calendar beside
 * the notification center; a dot beside the time marks unread notifications.
 * In the taskbar it's the time over the date, Windows style, at the corner
 * of the screen; down a taskbar at the side, the time over the day and month.
 */
export const ClockMenuItem = memo(function ClockMenuItem() {
  const { hasUnread, doNotDisturb } = useNotificationsBadge();
  const [open, setOpen] = useState(false);
  const edge = useTaskbarEdge();
  const taskbar = edge !== null;
  const vertical = edge !== null && isTaskbarVertical(edge);
  // The viewport can span several monitors (stacked ones make it taller than
  // any of them), so size the panel to the primary monitor's work area.
  const maxHeight = Math.round(primaryArea(useWorkAreas()).height * 0.85);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title={doNotDisturb ? 'Calendar and notifications (Do Not Disturb)' : undefined}
          className={cn(
            'gap-1.5 rounded-md px-2.5 font-medium text-foreground/90 hover:bg-foreground/10 hover:text-foreground',
            vertical ? 'h-auto w-full flex-col gap-0.5 px-0 py-1.5 text-xs' : taskbar ? 'h-full text-xs' : 'h-7 text-sm',
          )}
        >
          <ClockText stacked={taskbar} narrow={vertical} />
          {/* Named by the time it shows, then what it opens. */}
          <span className="sr-only">{hasUnread ? ', calendar and notifications, unread' : ', calendar and notifications'}</span>
          {doNotDisturb ? (
            <BellOff className="size-3.5 text-muted-foreground" aria-hidden />
          ) : (
            hasUnread && <span aria-hidden className="size-2 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <BarPopoverContent
        align={taskbar ? 'end' : 'center'}
        style={{ maxHeight }}
        className="flex w-96 flex-col overflow-hidden p-0 md:w-auto md:flex-row"
      >
        <CalendarSection onOpenSettings={() => setOpen(false)} />
        {/* Side by side, as in GNOME, the notifications sit left of the
            calendar and scroll within its height instead of stretching the
            panel; on narrow screens they stack below it. */}
        <div className="relative flex min-h-0 flex-1 flex-col border-t border-border/60 md:order-first md:w-96 md:flex-none md:border-t-0 md:border-r">
          <NotificationsPanel
            onNavigate={() => setOpen(false)}
            className="min-h-0 flex-1 md:absolute md:inset-0"
          />
        </div>
      </BarPopoverContent>
    </Popover>
  );
});

/** The clock's text. Its own component so only it re-renders as the time turns over. */
function ClockText({ stacked, narrow = false }: { stacked: boolean; narrow?: boolean }) {
  const { config } = useAppContext();
  const now = useClock(config.clockShowSeconds ? 'second' : 'minute');
  const time = now.toLocaleTimeString([], timeFormatOptions(config.clockFormat, config.clockShowSeconds));

  if (stacked) {
    return (
      <time dateTime={now.toISOString()} className="flex flex-col items-center leading-tight tabular-nums">
        <span>{time}</span>
        {config.clockShowDate && (
          <span>{narrow ? now.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) : now.toLocaleDateString()}</span>
        )}
      </time>
    );
  }

  return (
    <time dateTime={now.toISOString()} className="tabular-nums">
      {config.clockShowDate && (
        <>
          {now.toLocaleDateString([], { weekday: 'short' })}{' '}
          {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
        </>
      )}
      {time}
    </time>
  );
}

/**
 * Today's date and a month calendar, at the top of the clock's panel, with
 * the way into Settings → Date & Time.
 */
function CalendarSection({ onOpenSettings }: { onOpenSettings: () => void }) {
  // The panel mounts each time it opens, so this is today as of opening.
  const [today] = useState(() => new Date());
  const { open } = useWindowActions();

  return (
    <section aria-label="Calendar" className="shrink-0">
      <div className="px-4 pt-4">
        <p className="text-xs font-medium text-muted-foreground">
          {today.toLocaleDateString([], { weekday: 'long' })}
        </p>
        <p className="text-lg font-semibold text-foreground">
          {today.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}
        </p>
      </div>
      {/* Without a selection mode the days are plain cells rather than
          buttons, so they're sized here instead of by the day button. */}
      <Calendar
        defaultMonth={today}
        className="mx-auto [--cell-size:--spacing(9)]"
        classNames={{
          week: 'flex w-full',
          day: 'grid size-(--cell-size) place-items-center p-0 text-sm select-none',
          today: 'rounded-md bg-primary font-semibold text-primary-foreground',
        }}
      />
      <div className="px-1.5 pb-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => {
            onOpenSettings();
            open('calendar', { date: isoDate(today) });
          }}
        >
          <CalendarDays aria-hidden />
          Open Calendar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => {
            onOpenSettings();
            open('settings', { section: 'datetime' });
          }}
        >
          <Settings2 aria-hidden />
          Date & time settings
        </Button>
      </div>
    </section>
  );
}

/** Account header: current user, other accounts, add-account, sign out, lock and power. */
function AccountPanel({
  onAddAccount,
  onJoin,
  onQuickLogin,
  onEditProfile,
  onRemoveAccount,
  onPower,
}: {
  onAddAccount: () => void;
  onJoin: () => void;
  onQuickLogin: (pubkey: string) => void;
  onEditProfile: () => void;
  onRemoveAccount: (account: { pubkey: string; name: string }) => void;
  onPower: (action: PowerAction) => void;
}) {
  const {
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    signOut,
    signInWithNostrd: nostrdSignIn,
    removeLogin,
    isNostrdAccount,
  } = useLoggedInAccounts();
  const { status: nostrd } = useNostrd();
  const openUrl = useOpenUrl();

  const displayName = (account: Account): string =>
    account.metadata.name ?? 'Anonymous';

  const handleJoin = async () => {
    if (typeof window !== 'undefined' && 'nostr' in window) {
      const provider = (window as { nostr?: { getPublicKey?: () => Promise<string> } }).nostr;
      if (provider && typeof provider.getPublicKey === 'function') {
        try {
          const pubkey = await provider.getPublicKey();
          if (pubkey) {
            onQuickLogin(pubkey);
            return;
          }
        } catch {
          // Extension declined — fall through to the full dialog.
        }
      }
    }
    onJoin();
  };

  if (!currentUser) {
    // Accounts nostrd already holds sign in with a click; their keys never
    // left the computer.
    const onComputer = nostrd?.accounts ?? [];
    return (
      <div className="flex flex-col">
        {onComputer.length > 0 && (
          <>
            <p className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">
              Sign in as
            </p>
            <div className="flex flex-col gap-1 p-2">
              {onComputer.map((pubkey) => (
                <ComputerAccountButton
                  key={pubkey}
                  pubkey={pubkey}
                  onSelect={() => void nostrdSignIn(pubkey)}
                />
              ))}
            </div>
            <Separator />
          </>
        )}
        <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            {onComputer.length > 0
              ? 'Or use another Nostr account.'
              : 'Sign in with your Nostr account to sync your desktop.'}
          </p>
          <PopoverClose asChild>
            <Button onClick={handleJoin} className="rounded-full px-6">
              {onComputer.length > 0 ? 'Add account' : 'Join'}
            </Button>
          </PopoverClose>
        </div>
        <SystemButtons onPower={onPower} />
      </div>
    );
  }

  const pending = isLoading && !currentUser.metadata.name;
  const npub = nip19.npubEncode(currentUser.pubkey);
  const shortNpub = `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  const bannerUrl = currentUser.metadata.banner
    ? sanitizeImageUrl(currentUser.metadata.banner)
    : null;
  const about = currentUser.metadata.about?.trim();

  return (
    <div className="flex flex-col">
      {/* Real kind-0 profile header: banner, avatar, name, handle, bio. */}
      <div
        className={cn(
          'h-16 w-full',
          bannerUrl ? 'bg-cover bg-center' : 'bg-gradient-to-br from-primary/25 to-primary/5',
        )}
      >
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt=""
            aria-hidden
            className="size-full object-cover"
          />
        )}
      </div>
      <div className="px-3 pb-2">
        <Avatar
          className="-mt-8 size-16 border-4 border-popover shadow-sm"
          shape={getAvatarShape(currentUser.metadata)}
        >
          <AvatarImage src={currentUser.metadata.picture} alt="" />
          <AvatarFallback className="text-lg">
            {pending ? (
              <Skeleton className="size-full rounded-full" />
            ) : (
              displayName(currentUser).charAt(0)
            )}
          </AvatarFallback>
        </Avatar>

        <div className="mt-2 min-w-0">
          {pending ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <p className="truncate text-base font-semibold text-foreground">
              {displayName(currentUser)}
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {currentUser.metadata.nip05 ?? shortNpub}
          </p>
          {about && (
            <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
              {about}
            </p>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <PopoverClose asChild>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => openUrl(`https://ditto.pub/${npub}`)}
            >
              View profile
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={onEditProfile}
            >
              Edit profile
            </Button>
          </PopoverClose>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-1 p-2">
        {otherUsers.map((user) => {
          const userPending = isLoading && !user.metadata.name;
          const userNpub = nip19.npubEncode(user.pubkey);
          return (
            <ContextMenu key={user.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => void setLogin(user.id)}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="size-7" shape={getAvatarShape(user.metadata)}>
                    <AvatarImage src={user.metadata.picture} alt="" />
                    <AvatarFallback className="text-xs">
                      {userPending ? (
                        <Skeleton className="size-full rounded-full" />
                      ) : (
                        displayName(user).charAt(0)
                      )}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm text-foreground">
                    {userPending ? <Skeleton className="h-3.5 w-20" /> : displayName(user)}
                  </span>
                </button>
              </ContextMenuTrigger>
              {/* Items that leave the panel close it, as its own buttons do. */}
              <ContextMenuContent className="w-56">
                <ContextMenuItem onSelect={() => void setLogin(user.id)}>Switch to this account</ContextMenuItem>
                <PopoverClose asChild>
                  <ContextMenuItem onSelect={() => openUrl(`https://ditto.pub/${userNpub}`)}>
                    View profile
                  </ContextMenuItem>
                </PopoverClose>
                <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(userNpub).catch(() => {})}>
                  Copy npub
                </ContextMenuItem>
                <ContextMenuSeparator />
                {isNostrdAccount(user.id) ? (
                  <PopoverClose asChild>
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => onRemoveAccount({ pubkey: user.pubkey, name: displayName(user) })}
                    >
                      <UserMinus />
                      Remove from this computer…
                    </ContextMenuItem>
                  </PopoverClose>
                ) : (
                  <ContextMenuItem variant="destructive" onSelect={() => removeLogin(user.id)}>
                    <UserMinus />
                    Remove account
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        <Button
          variant="ghost"
          size="sm"
          onClick={onAddAccount}
          className="justify-start text-muted-foreground hover:text-foreground"
        >
          <UserPlus aria-hidden />
          Add another account
        </Button>
        {isNostrdAccount(currentUser.id) ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut(currentUser.id)}
              className="justify-start text-muted-foreground hover:text-foreground"
            >
              <LogOut aria-hidden />
              Sign out
            </Button>
            <PopoverClose asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onRemoveAccount({ pubkey: currentUser.pubkey, name: displayName(currentUser) })
                }
                className="justify-start text-muted-foreground hover:text-destructive"
              >
                <UserMinus aria-hidden />
                Remove from this computer…
              </Button>
            </PopoverClose>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => removeLogin(currentUser.id)}
            className="justify-start text-muted-foreground hover:text-destructive"
          >
            <UserMinus aria-hidden />
            Remove account
          </Button>
        )}
      </div>
      <SystemButtons onPower={onPower} />
    </div>
  );
}
