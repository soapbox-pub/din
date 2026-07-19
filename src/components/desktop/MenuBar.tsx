import { EthernetPort, LayoutGrid, LogOut, Search, Trash2, UserPlus, WifiOff, WifiZero } from 'lucide-react';
import { memo, useState } from 'react';
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
import { EditProfileForm } from '@/components/EditProfileForm';
import { AppIcon } from '@/components/desktop/AppIcon';
import { WifiPopoverBody, WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { BatteryGlyph, BatteryPopoverBody } from '@/components/desktop/BatteryIndicator';
import { VolumeGlyph, VolumePopoverBody } from '@/components/desktop/VolumeIndicator';
import { BrightnessGlyph, BrightnessPopoverBody } from '@/components/desktop/BrightnessIndicator';
import { NotificationsMenuItem } from '@/components/desktop/NotificationsIndicator';
import { useClock } from '@/hooks/useClock';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
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

/**
 * macOS-style menu bar along the top of the desktop.
 *
 * The apps menu (the full launcher with search) sits on the left; ambient
 * indicators — Wi-Fi, the signed-in account, and the clock — sit on the
 * right, each behind its own affordance like the macOS status items.
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
  const fullscreen = windows.some((w) => w.maximized && !w.minimized);

  return (
    <header
      className={cn(
        // tracking-tight approximates SF Pro's optical spacing at menu-bar sizes.
        'relative z-20 flex h-9 items-center justify-between px-2 tracking-tight transition-colors',
        fullscreen
          ? 'bg-white dark:bg-black'
          : 'bg-gradient-to-b from-background/60 via-background/25 to-transparent',
      )}
    >
      <AppsMenu />
      <div className="flex items-center gap-1.5">
        <BrightnessMenuItem />
        <VolumeMenuItem />
        <BatteryMenuItem />
        <WifiMenuItem />
        <NotificationsMenuItem />
        <AccountMenuItem />
        <ClockDisplay />
      </div>
    </header>
  );
}

/** Left menu: the full searchable apps launcher. */
const AppsMenu = memo(function AppsMenu() {
  const { apps, uninstallWebApp, webApps } = useInstalledApps();
  // Actions only: keeps the launcher (a large Radix popover tree) out of
  // the per-window-commit re-render cascade.
  const { open, closeApp } = useWindowActions();
  const [query, setQuery] = useState('');

  /** Uninstall a web app: close its windows, then drop the entry. */
  const uninstall = (appId: string) => {
    closeApp(appId);
    uninstallWebApp(appId);
  };

  const launcherApps = apps.filter(
    (app) =>
      !app.hidden && app.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <Popover>
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
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
            <div className="grid grid-cols-4 gap-1">
              {launcherApps.map((app) => (
                <ContextMenu key={app.id}>
                  <ContextMenuTrigger asChild>
                    <PopoverClose asChild>
                      <button
                        type="button"
                        onClick={() => open(app.id)}
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
                    <ContextMenuItem onSelect={() => open(app.id)}>
                      Open
                    </ContextMenuItem>
                    {webApps.some((webApp) => webApp.id === app.id) && (
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => uninstall(app.id)}
                      >
                        <Trash2 aria-hidden /> Uninstall
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          )}
        </div>
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

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Account"
            className="grid size-7 place-items-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Avatar className="size-4.5" shape={getAvatarShape(currentUser?.metadata)}>
              <AvatarImage src={currentUser?.metadata.picture} alt="" />
              <AvatarFallback className="text-[9px]">
                {currentUser?.metadata.name?.charAt(0) ?? '?'}
              </AvatarFallback>
            </Avatar>
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
          />
        </PopoverContent>
      </Popover>

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

/** Menu-bar clock: weekday, date, and time, macOS style. */
const ClockDisplay = memo(function ClockDisplay() {
  const now = useClock();

  return (
    <time
      dateTime={now.toISOString()}
      className="px-2 text-sm font-medium tabular-nums text-foreground/90"
    >
      {now.toLocaleDateString([], { weekday: 'short' })}{' '}
      {now.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
      {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  );
});

/** Account header: current user, other accounts, add-account, log out. */
function AccountPanel({
  onAddAccount,
  onJoin,
  onQuickLogin,
  onEditProfile,
}: {
  onAddAccount: () => void;
  onJoin: () => void;
  onQuickLogin: (pubkey: string) => void;
  onEditProfile: () => void;
}) {
  const { currentUser, otherUsers, isLoading, setLogin, removeLogin } =
    useLoggedInAccounts();

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
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          Sign in with your Nostr account to sync your desktop.
        </p>
        <PopoverClose asChild>
          <Button onClick={handleJoin} className="rounded-full px-6">
            Join
          </Button>
        </PopoverClose>
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
            <Button asChild variant="secondary" size="sm" className="flex-1">
              <a
                href={`https://ditto.pub/${npub}`}
                target="_blank"
                rel="noreferrer"
              >
                View profile
              </a>
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
              onClick={() => setLogin(user.id)}
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => removeLogin(currentUser.id)}
          className="justify-start text-muted-foreground hover:text-destructive"
        >
          <LogOut aria-hidden />
          Log out
        </Button>
      </div>
    </div>
  );
}
