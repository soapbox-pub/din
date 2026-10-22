import { Airplay, BellOff, CircleUserRound, EthernetPort, LayoutGrid, Lock, LogOut, Search, Settings2, Trash2, UserMinus, UserPlus, WifiOff, WifiZero } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarShape } from '@/lib/avatarShape';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Popover,
  PopoverClose,
  PopoverContent,
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
import { WifiPopoverBody, WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { BatteryGlyph, BatteryPopoverBody } from '@/components/desktop/BatteryIndicator';
import { VolumeGlyph, VolumePopoverBody } from '@/components/desktop/VolumeIndicator';
import { BrightnessGlyph, BrightnessPopoverBody } from '@/components/desktop/BrightnessIndicator';
import { AirPlayPopoverBody } from '@/components/desktop/AirPlayIndicator';
import { useAirPlayState } from '@/hooks/useAirPlay';
import { getAirPlayBridge } from '@/lib/airplay';
import { NotificationsPanel } from '@/components/desktop/NotificationsIndicator';
import { useNotificationsBadge } from '@/hooks/useNotificationsBadge';
import { Calendar } from '@/components/ui/calendar';
import { TrayItems } from '@/components/desktop/TrayMenu';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { onToggleAppsMenu } from '@/lib/appsMenu';
import { useClock } from '@/hooks/useClock';
import { useAppContext } from '@/hooks/useAppContext';
import { timeFormatOptions } from '@/lib/datetime';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
import { useNostrd } from '@/hooks/useNostrd';
import { useQuery } from '@tanstack/react-query';
import { getLockBridge } from '@/lib/lock';
import { useAuthor } from '@/hooks/useAuthor';
import { useWifiNetworks, useWifiStatus } from '@/hooks/useWifi';
import { useBatteryStatus } from '@/hooks/usePower';
import { useAudioStatus } from '@/hooks/useAudio';
import { useBrightnessStatus } from '@/hooks/useBrightness';
import { getWifiBridge, isEthernetConnected } from '@/lib/wifi';
import { getPowerBridge, summarizePower } from '@/lib/power';
import { getAudioBridge } from '@/lib/audio';
import { getBrightnessBridge } from '@/lib/brightness';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { primaryArea } from '@/lib/monitors';
import type { AppDefinition } from '@/lib/apps';
import type { WebApp } from '@/lib/webApps';

/**
 * Menu bar along the top of the desktop.
 *
 * The apps menu (the full launcher with search) and the focused app's name
 * sit on the left. The clock sits in the center and opens a calendar above
 * the notification center, GNOME style. Ambient indicators — apps' status
 * icons, hardware, Wi-Fi, and the signed-in account — sit on the right, each
 * behind its own affordance.
 *
 * The bar itself is borderless and transparent, fading from a soft scrim
 * into the wallpaper so it reads as part of the desktop rather than a
 * separate chrome strip. When a window is fullscreened it turns solid —
 * white in light mode, black in dark mode — so it reads as system chrome
 * above the fullscreen window.
 */
export function MenuBar() {
  // Subscribes to window state (needed for the fullscreen scrim), so this
  // re-renders on every window commit - all children are memoized so the
  // re-render stops at this component's own <header> element.
  const { windows } = useWindowManager();
  // Only a window maximized beneath it - on the primary monitor - counts.
  const primaryId = primaryArea(useWorkAreas()).id;
  const fullscreen = windows.some(
    (w) => w.maximized && !w.minimized && (w.monitor === null || w.monitor === primaryId),
  );
  // The focused window is the highest visible one, as for its focus ring.
  const focused = windows.reduce<(typeof windows)[number] | null>(
    (top, w) => (w.minimized || w.closing || (top && top.z > w.z) ? top : w),
    null,
  );

  return (
    <header
      className={cn(
        // Equal side columns keep the clock centered on the screen however
        // much each side holds.
        // tracking-tight approximates SF Pro's optical spacing at menu-bar sizes.
        'relative z-20 grid h-9 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 tracking-tight transition-colors',
        fullscreen
          ? 'bg-white dark:bg-black'
          : 'bg-gradient-to-b from-background/60 via-background/25 to-transparent',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AppsMenu />
        <FocusedAppName appId={focused?.appId ?? null} />
      </div>
      <ClockMenuItem />
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        <TrayItems />
        <AirPlayMenuItem />
        <BrightnessMenuItem />
        <VolumeMenuItem />
        <BatteryMenuItem />
        <WifiMenuItem />
        <AccountMenuItem />
      </div>
    </header>
  );
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
  const { apps, uninstallWebApp, webApps } = useInstalledApps();
  // Actions only: keeps the launcher (a large Radix popover tree) out of
  // the per-window-commit re-render cascade.
  const { open, closeApp } = useWindowActions();
  const [menuOpen, setMenuOpenState] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const menuOpenRef = useRef(menuOpen);

  /** Open or close the menu; it always opens on a fresh search. */
  const setMenuOpen = useCallback((next: boolean) => {
    if (next && !menuOpenRef.current) setQuery('');
    menuOpenRef.current = next;
    setMenuOpenState(next);
  }, []);

  // Super+Space (see DesktopHotkeys) toggles the menu.
  useEffect(
    () => onToggleAppsMenu(() => setMenuOpen(!menuOpenRef.current)),
    [setMenuOpen],
  );

  /** Uninstall a web app: close its windows, then drop the entry. */
  const uninstall = (appId: string) => {
    closeApp(appId);
    uninstallWebApp(appId);
  };

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

  /** Enter in the search launches the first match, as shown. */
  const launchFirst = () => {
    const first = dinApps[0] ?? nativeApps[0];
    if (!first) return;
    setMenuOpen(false);
    open(first.id);
  };

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
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-96 rounded-2xl p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
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
        <div className="max-h-96 overflow-y-auto p-3">
          {launcherApps.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              No apps match “{query}”.
            </p>
          ) : (
            <>
              <AppGrid
                apps={dinApps}
                onOpen={open}
                onUninstall={uninstall}
                webApps={webApps}
              />
              {nativeApps.length > 0 && (
                <>
                  {dinApps.length > 0 && (
                    <h2 className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      System
                    </h2>
                  )}
                  <AppGrid
                    apps={nativeApps}
                    onOpen={open}
                    onUninstall={uninstall}
                    webApps={webApps}
                  />
                </>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});

/** One section of launcher tiles. */
function AppGrid({
  apps,
  onOpen,
  onUninstall,
  webApps,
}: {
  apps: AppDefinition[];
  onOpen: (appId: string) => void;
  onUninstall: (appId: string) => void;
  /** Installed web apps, the only kind the launcher can uninstall. */
  webApps: readonly WebApp[];
}) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {apps.map((app) => (
        <ContextMenu key={app.id}>
          <ContextMenuTrigger asChild>
            <PopoverClose asChild>
              <button
                type="button"
                onClick={() => onOpen(app.id)}
                className="flex flex-col items-center gap-2 rounded-xl p-3 text-center transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <AppIcon icon={app.icon} className="size-9 text-foreground" />
                <span className="line-clamp-2 text-xs leading-tight text-foreground">
                  {app.name}
                </span>
              </button>
            </PopoverClose>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => onOpen(app.id)}>Open</ContextMenuItem>
            {webApps.some((webApp) => webApp.id === app.id) && (
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onUninstall(app.id)}
              >
                <Trash2 aria-hidden /> Uninstall
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

/**
 * AirPlay status item: shows once a receiver is nearby, and lights up while
 * the screen is shared; clicking lists the receivers to mirror or extend
 * the desktop to. Renders nothing outside the Electron shell or without
 * deckmon, like the hardware indicators.
 */
const AirPlayMenuItem = memo(function AirPlayMenuItem() {
  const bridge = getAirPlayBridge();
  const { data } = useAirPlayState();

  if (!bridge || !data?.available) return null;
  const sharing = data.sessions.filter((s) => s.state === 'streaming');
  if (data.receivers.length === 0 && data.sessions.length === 0) return null;

  const label =
    sharing.length > 0
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
            sharing.length > 0 ? 'bg-primary/15 text-primary' : 'text-foreground/90',
          )}
        >
          <Airplay className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-80 p-0">
        <AirPlayPopoverBody />
      </PopoverContent>
    </Popover>
  );
});

/**
 * Brightness status item: sun glyph; clicking opens a backlight slider plus a
 * night-light (red shift) toggle. Renders nothing outside the Electron shell
 * or where neither the backlight nor a gamma tool is present, like the other
 * hardware indicators.
 */
const BrightnessMenuItem = memo(function BrightnessMenuItem() {
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
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-72 p-0">
        <BrightnessPopoverBody />
      </PopoverContent>
    </Popover>
  );
});

/**
 * Volume status item: speaker glyph; clicking opens a slider + mute popover.
 * Renders nothing outside the Electron shell or where PipeWire/wpctl is
 * absent, like the other hardware indicators.
 */
const VolumeMenuItem = memo(function VolumeMenuItem() {
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
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-72 p-0">
        <VolumePopoverBody />
      </PopoverContent>
    </Popover>
  );
});

/**
 * Battery status item: a macOS-style solid-fill glyph (bolt when charging);
 * clicking opens a details popover. Renders nothing outside the Electron
 * shell or on machines with no battery (desktops, the VM), like the other
 * hardware indicators.
 */
const BatteryMenuItem = memo(function BatteryMenuItem() {
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
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-72 p-0">
        <BatteryPopoverBody />
      </PopoverContent>
    </Popover>
  );
});

/**
 * Wi-Fi status item: glyph mirrors the adapter state; clicking opens the
 * quick-connect panel. Renders nothing outside the Electron shell or on
 * systems without an adapter, like hardware indicators do.
 */
const WifiMenuItem = memo(function WifiMenuItem() {
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
            ethernet || connected ? 'text-foreground/90' : 'text-muted-foreground',
          )}
        >
          {ethernet ? (
            <EthernetPort className="size-4.5" />
          ) : !radioEnabled ? (
            <WifiOff className="size-4.5" />
          ) : connected ? (
            <WifiSignalIcon signal={current.signal} className="size-4.5" />
          ) : (
            <WifiZero className="size-4.5" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-80 p-0">
        <WifiPopoverBody />
      </PopoverContent>
    </Popover>
  );
});

/** Account status item: avatar opens the account panel. */
const AccountMenuItem = memo(function AccountMenuItem() {
  const { currentUser } = useLoggedInAccounts();
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [quickLoginPubkey, setQuickLoginPubkey] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ pubkey: string; name: string } | null>(null);

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
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={8}
          className="w-80 overflow-hidden p-0"
        >
          <AccountPanel
            onAddAccount={() => setAuthDialogOpen(true)}
            onJoin={() => setAuthDialogOpen(true)}
            onQuickLogin={setQuickLoginPubkey}
            onEditProfile={() => setEditProfileOpen(true)}
            onRemoveAccount={setRemoving}
          />
        </PopoverContent>
      </Popover>

      <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />

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
 * Lock the computer: DinOS's lock screen, which takes the computer's
 * password. Only where there's one to take.
 */
function LockButton({ separated = false }: { separated?: boolean }) {
  const bridge = getLockBridge();
  const { data: available = false } = useQuery({
    queryKey: ['lock', 'available'],
    queryFn: () => bridge?.available() ?? false,
    enabled: !!bridge,
    staleTime: 60_000,
  });
  if (!bridge || !available) return null;

  const button = (
    <PopoverClose asChild>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void bridge.lock()}
        className="justify-start text-muted-foreground hover:text-foreground"
      >
        <Lock aria-hidden />
        Lock
      </Button>
    </PopoverClose>
  );
  if (!separated) return button;
  return (
    <>
      <Separator />
      <div className="flex flex-col p-2">{button}</div>
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
 * Menu-bar clock: weekday, date, and time. Clicking opens a calendar above
 * the notification center; a dot beside the time marks unread notifications.
 */
const ClockMenuItem = memo(function ClockMenuItem() {
  const { hasUnread, doNotDisturb } = useNotificationsBadge();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={hasUnread ? 'Calendar and notifications, unread' : 'Calendar and notifications'}
          title={doNotDisturb ? 'Calendar and notifications (Do Not Disturb)' : undefined}
          className="h-7 gap-1.5 rounded-md px-2.5 text-sm font-medium text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
        >
          <ClockText />
          {doNotDisturb ? (
            <BellOff className="size-3.5 text-muted-foreground" aria-hidden />
          ) : (
            hasUnread && <span aria-hidden className="size-2 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        className="flex max-h-[85vh] w-96 flex-col overflow-hidden p-0"
      >
        <CalendarSection onOpenSettings={() => setOpen(false)} />
        <NotificationsPanel
          onNavigate={() => setOpen(false)}
          className="min-h-0 flex-1 border-t border-border/60"
        />
      </PopoverContent>
    </Popover>
  );
});

/** The clock's text. Its own component so only it re-renders every second. */
function ClockText() {
  const now = useClock();
  const { config } = useAppContext();

  return (
    <time dateTime={now.toISOString()} className="tabular-nums">
      {config.clockShowDate && (
        <>
          {now.toLocaleDateString([], { weekday: 'short' })}{' '}
          {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
        </>
      )}
      {now.toLocaleTimeString([], timeFormatOptions(config.clockFormat, config.clockShowSeconds))}
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

/** Account header: current user, other accounts, add-account, sign out. */
function AccountPanel({
  onAddAccount,
  onJoin,
  onQuickLogin,
  onEditProfile,
  onRemoveAccount,
}: {
  onAddAccount: () => void;
  onJoin: () => void;
  onQuickLogin: (pubkey: string) => void;
  onEditProfile: () => void;
  onRemoveAccount: (account: { pubkey: string; name: string }) => void;
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
        <LockButton separated />
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
          return (
            <button
              key={user.id}
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
        <LockButton />
      </div>
    </div>
  );
}
