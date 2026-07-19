import { useEffect, useMemo, useState } from 'react';
import {
  BatteryFull,
  Bomb,
  Bug,
  Check,
  Cloud,
  CloudOff,
  Loader2,
  Lock,
  Monitor,
  Moon,
  MousePointer2,
  Palette,
  Plug,
  RotateCw,
  Sun,
  TriangleAlert,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { cleanWifiError, getWifiBridge, isSecured } from '@/lib/wifi';
import { WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import type { WifiNetwork } from '@/lib/wifi';
import {
  useSavedNetworks,
  useWifiMutations,
  useWifiNetworks,
  useWifiStatus,
} from '@/hooks/useWifi';
import { cleanDisplayError, formatMode, getDisplayBridge } from '@/lib/display';
import type { DisplayMode, DisplayOutput } from '@/lib/display';
import { useDisplayStatus, useSetDisplayMode } from '@/hooks/useDisplay';
import { formatTimeRemaining, getPowerBridge, summarizePower } from '@/lib/power';
import type { BatteryInfo } from '@/lib/power';
import { useBatteryStatus } from '@/hooks/usePower';
import { BatteryGlyph } from '@/components/desktop/BatteryIndicator';
import { useTheme } from '@/hooks/useTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppDataSyncStatus } from '@/hooks/useAppData';
import { useToast } from '@/hooks/useToast';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getFsBridge } from '@/lib/fs';
import { parseCurXPTheme } from '@/lib/cursorTheme';
import type { CursorTheme } from '@/lib/cursorTheme';
import { RelayListManager } from '@/components/RelayListManager';
import { BlossomServerManager } from '@/components/BlossomServerManager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';

type SectionId = 'wifi' | 'display' | 'battery' | 'nostr' | 'appearance' | 'developers';

const SECTIONS: { id: SectionId; name: string; icon: LucideIcon }[] = [
  { id: 'wifi', name: 'Wi-Fi', icon: Wifi },
  { id: 'display', name: 'Display', icon: Monitor },
  { id: 'battery', name: 'Battery', icon: BatteryFull },
  { id: 'nostr', name: 'Nostr & Storage', icon: Cloud },
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'developers', name: 'Developers', icon: Bug },
];

/**
 * Settings - system preferences for the shell.
 *
 * The Wi-Fi section drives NetworkManager through `window.wifi` (Electron
 * preload + nmcli in the main process): toggle the radio, scan, join,
 * disconnect and forget networks. Outside the Electron shell it renders an
 * explanatory fallback. The Display section changes screen resolution through
 * `window.display` (xrandr) for the bare-X11 standalone session; on Wayland it
 * shows a fallback. The Battery section reads `window.power`
 * (/sys/class/power_supply) and hides on machines with no battery. Nostr &
 * Storage manages Din's encrypted app-data
 * sync, NIP-65 relay list, and Blossom server list. Appearance switches the
 * shell theme (AppContext, persisted to localStorage and roamed via
 * encrypted sync) and toggles desktop effects like wobbly windows.
 * Developers holds debug utilities such as intentionally crashing the shell
 * to test the error boundary.
 */
export function Settings(_props: AppComponentProps) {
  const [section, setSection] = useState<SectionId>('wifi');

  return (
    <div className="flex h-full w-full">
      {/* Section sidebar */}
      <nav
        aria-label="Settings sections"
        className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 bg-background/30 p-2"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            aria-current={section === s.id ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              section === s.id
                ? 'bg-foreground/15 text-foreground'
                : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
            )}
          >
            <s.icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {section === 'wifi' ? (
          <WifiSection />
        ) : section === 'display' ? (
          <DisplaySection />
        ) : section === 'battery' ? (
          <BatterySection />
        ) : section === 'nostr' ? (
          <NostrStorageSection />
        ) : section === 'appearance' ? (
          <AppearanceSection />
        ) : (
          <DevelopersSection />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------

function WifiSection() {
  const bridge = getWifiBridge();
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const saved = useSavedNetworks();
  const { connect, disconnect, forget, setRadio } = useWifiMutations();

  // SSID whose inline password/connect form is open, if any.
  const [joining, setJoining] = useState<string | null>(null);
  // Last failed operation, keyed to the SSID it concerned.
  const [opError, setOpError] = useState<{ ssid: string; message: string } | null>(null);

  if (!bridge) {
    return (
      <SectionShell title="Wi-Fi">
        <FallbackCard>
          Wi-Fi settings need the Electron shell to talk to NetworkManager. Run{' '}
          <code className="rounded bg-foreground/10 px-1 py-0.5">make dev</code> or boot
          the VM; the bridge is not available in a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const joinNetwork = (network: WifiNetwork, password?: string) => {
    setOpError(null);
    connect.mutate(
      { ssid: network.ssid, password },
      {
        onSuccess: () => setJoining(null),
        onError: (error) =>
          setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
      },
    );
  };

  return (
    <SectionShell
      title="Wi-Fi"
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rescan for networks"
            title="Rescan for networks"
            disabled={!radioEnabled || !hasAdapter}
            onClick={() => networks.refetch()}
          >
            <RotateCw className={cn('size-4', networks.isFetching && 'animate-spin')} />
          </Button>
          <Switch
            aria-label="Wi-Fi radio"
            checked={radioEnabled}
            disabled={status.data === undefined || !status.data.available || setRadio.isPending}
            onCheckedChange={(checked) => setRadio.mutate(checked)}
          />
        </>
      }
    >
      {status.isLoading ? (
        <NetworkListSkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read Wi-Fi state: {cleanWifiError(status.error)}</FallbackCard>
      ) : !status.data?.available ? (
        <FallbackCard>
          NetworkManager is not available on this system, so Wi-Fi cannot be managed here.
        </FallbackCard>
      ) : !hasAdapter ? (
        <FallbackCard icon={WifiOff}>No Wi-Fi adapter was found on this system.</FallbackCard>
      ) : !radioEnabled ? (
        <FallbackCard icon={WifiOff}>Wi-Fi is turned off.</FallbackCard>
      ) : networks.isLoading ? (
        <NetworkListSkeleton />
      ) : networks.isError ? (
        <FallbackCard>Scan failed: {cleanWifiError(networks.error)}</FallbackCard>
      ) : (networks.data?.length ?? 0) === 0 ? (
        <FallbackCard icon={Wifi}>No networks found nearby.</FallbackCard>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Available networks">
          {networks.data?.map((network) => (
            <NetworkRow
              key={network.ssid}
              network={network}
              isSaved={saved.data?.includes(network.ssid) ?? false}
              isJoining={joining === network.ssid}
              connectPending={connect.isPending && connect.variables?.ssid === network.ssid}
              disconnectPending={disconnect.isPending}
              error={opError?.ssid === network.ssid ? opError.message : null}
              onOpenJoin={() => {
                setOpError(null);
                setJoining(network.ssid);
              }}
              onCancelJoin={() => setJoining(null)}
              onConnect={(password) => joinNetwork(network, password)}
              onDisconnect={() => {
                setOpError(null);
                disconnect.mutate(undefined, {
                  onError: (error) =>
                    setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                });
              }}
              onForget={() => {
                setOpError(null);
                forget.mutate(network.ssid, {
                  onError: (error) =>
                    setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                });
              }}
            />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

/** Signal-strength icon for a network (0-100). */
function SignalIcon({ network }: { network: WifiNetwork }) {
  return (
    <WifiSignalIcon
      signal={network.signal}
      className={cn(
        'size-5 shrink-0',
        network.inUse ? 'text-primary' : 'text-muted-foreground',
      )}
    />
  );
}

function NetworkRow({
  network,
  isSaved,
  isJoining,
  connectPending,
  disconnectPending,
  error,
  onOpenJoin,
  onCancelJoin,
  onConnect,
  onDisconnect,
  onForget,
}: {
  network: WifiNetwork;
  isSaved: boolean;
  isJoining: boolean;
  connectPending: boolean;
  disconnectPending: boolean;
  error: string | null;
  onOpenJoin: () => void;
  onCancelJoin: () => void;
  onConnect: (password?: string) => void;
  onDisconnect: () => void;
  onForget: () => void;
}) {
  const secured = isSecured(network);
  // A password prompt is only needed for secured networks we don't know yet.
  const needsPassword = secured && !isSaved;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <SignalIcon network={network} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{network.ssid}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {secured && <Lock className="size-3 shrink-0" aria-label="Secured" />}
            <span>{secured ? network.security : 'Open'}</span>
            {isSaved && !network.inUse && <span aria-hidden>·</span>}
            {isSaved && !network.inUse && <span>Saved</span>}
          </p>
        </div>

        {network.inUse ? (
          <>
            <span className="flex items-center gap-1 text-xs font-medium text-primary">
              <Check className="size-3.5" aria-hidden />
              Connected
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={disconnectPending}
              onClick={onDisconnect}
            >
              {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        ) : isJoining && !needsPassword ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={connectPending}
            onClick={() => {
              if (needsPassword) onOpenJoin();
              else onConnect();
            }}
          >
            {connectPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Connecting…
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}

        {isSaved && !network.inUse && (
          <Button variant="ghost" size="sm" onClick={onForget}>
            Forget
          </Button>
        )}
      </div>

      {isJoining && needsPassword && (
        <PasswordForm
          ssid={network.ssid}
          pending={connectPending}
          onSubmit={onConnect}
          onCancel={onCancelJoin}
        />
      )}

      {error !== null && (
        <p role="alert" className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** Inline password entry for joining a secured network. */
function PasswordForm({
  ssid,
  pending,
  onSubmit,
  onCancel,
}: {
  ssid: string;
  pending: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const valid = password.length >= 8;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSubmit(password);
      }}
      className="flex items-center gap-2 border-t border-border/60 px-3 py-2"
    >
      <Input
        type="password"
        aria-label={`Password for ${ssid}`}
        placeholder="Network password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        disabled={pending}
        autoFocus
        autoComplete="off"
        className="h-8 flex-1"
      />
      <Button type="submit" size="sm" disabled={!valid || pending}>
        {pending ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Connecting…
          </>
        ) : (
          'Join'
        )}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function NetworkListSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
        >
          <Skeleton className="size-5 rounded bg-foreground/10" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 bg-foreground/10" style={{ width: `${30 + ((i * 23) % 35)}%` }} />
            <Skeleton className="h-3 w-16 bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Screen resolution for each connected output, via the xrandr display bridge
 * (window.display). Meaningful on the bare-X11 standalone session where Din is
 * the whole desktop; on Wayland/cage or in a plain browser it renders a
 * fallback, since the compositor sizes Din to the display automatically.
 */
function DisplaySection() {
  const bridge = getDisplayBridge();
  const status = useDisplayStatus();
  const setMode = useSetDisplayMode();
  // Last failed operation, keyed to the output it concerned.
  const [opError, setOpError] = useState<{ output: string; message: string } | null>(null);

  if (!bridge) {
    return (
      <SectionShell title="Display">
        <FallbackCard icon={Monitor}>
          Display settings need the Din desktop shell. A plain browser has no
          screen resolution to manage.
        </FallbackCard>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Display"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh displays"
          title="Refresh displays"
          disabled={!status.data?.available}
          onClick={() => status.refetch()}
        >
          <RotateCw className={cn('size-4', status.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      {status.isLoading ? (
        <DisplayListSkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read display state: {cleanDisplayError(status.error)}</FallbackCard>
      ) : !status.data?.available ? (
        <FallbackCard icon={Monitor}>
          Screen resolution can't be changed here. This session uses a Wayland
          compositor (cage), which sizes Din to the display automatically.
        </FallbackCard>
      ) : status.data.outputs.length === 0 ? (
        <FallbackCard icon={Monitor}>No connected displays were found.</FallbackCard>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Displays">
          {status.data.outputs.map((output) => (
            <DisplayRow
              key={output.name}
              output={output}
              pending={setMode.isPending && setMode.variables?.output === output.name}
              error={opError?.output === output.name ? opError.message : null}
              onSetMode={(width, height) => {
                setOpError(null);
                setMode.mutate(
                  { output: output.name, width, height },
                  {
                    onError: (error) =>
                      setOpError({ output: output.name, message: cleanDisplayError(error) }),
                  },
                );
              }}
            />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

/** A friendlier label for common xrandr output names. */
function friendlyOutputName(name: string): string {
  if (/^(eDP|LVDS)/i.test(name)) return 'Built-in display';
  if (/^HDMI/i.test(name)) return 'HDMI display';
  if (/^(DisplayPort|DP)/i.test(name)) return 'DisplayPort display';
  if (/^(VGA|DVI)/i.test(name)) return `${name.replace(/-.*/, '')} display`;
  return name;
}

function DisplayRow({
  output,
  pending,
  error,
  onSetMode,
}: {
  output: DisplayOutput;
  pending: boolean;
  error: string | null;
  onSetMode: (width: number, height: number) => void;
}) {
  // Collapse xrandr's per-refresh-rate rows to unique resolutions, largest
  // first, carrying the current/native flags forward.
  const modes = useMemo(() => {
    const byResolution = new Map<string, DisplayMode>();
    for (const mode of output.modes) {
      const key = `${mode.width}x${mode.height}`;
      const existing = byResolution.get(key);
      byResolution.set(key, {
        width: mode.width,
        height: mode.height,
        current: (existing?.current ?? false) || mode.current,
        preferred: (existing?.preferred ?? false) || mode.preferred,
      });
    }
    return [...byResolution.values()].sort(
      (a, b) => b.width - a.width || b.height - a.height,
    );
  }, [output.modes]);

  const currentValue = output.current
    ? `${output.current.width}x${output.current.height}`
    : '';
  const friendly = friendlyOutputName(output.name);
  const selectId = `resolution-${output.name}`;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center gap-3">
        <Monitor className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm text-foreground">
            {friendly}
            {output.primary && (
              <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Primary
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{output.name}</p>
        </div>
        <div className="flex items-center gap-2">
          {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          <Label htmlFor={selectId} className="sr-only">
            Resolution for {friendly}
          </Label>
          <select
            id={selectId}
            value={currentValue}
            disabled={pending || modes.length === 0}
            onChange={(e) => {
              const [width, height] = e.target.value.split('x').map(Number);
              if (Number.isFinite(width) && Number.isFinite(height)) onSetMode(width, height);
            }}
            className={cn(
              'h-8 rounded-md border border-border/60 bg-background px-2 text-sm text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {currentValue === '' && <option value="">—</option>}
            {modes.map((mode) => (
              <option key={`${mode.width}x${mode.height}`} value={`${mode.width}x${mode.height}`}>
                {formatMode(mode.width, mode.height)}
                {mode.preferred ? ' (native)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function DisplayListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 2 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border/60 p-3"
        >
          <Skeleton className="size-5 rounded bg-foreground/10" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32 bg-foreground/10" />
            <Skeleton className="h-3 w-16 bg-foreground/10" />
          </div>
          <Skeleton className="h-8 w-28 rounded-md bg-foreground/10" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

/**
 * Battery and power state, via the power bridge (window.power, reading
 * /sys/class/power_supply). Works on any Linux session; hides behind a
 * fallback on machines with no battery (desktops, the VM) or in a plain
 * browser.
 */
function BatterySection() {
  const bridge = getPowerBridge();
  const status = useBatteryStatus();

  if (!bridge) {
    return (
      <SectionShell title="Battery">
        <FallbackCard icon={BatteryFull}>
          Battery status needs the Din desktop shell; it isn't available in a
          plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const data = status.data;
  const summary = data ? summarizePower(data) : null;
  const critical =
    summary !== null &&
    !summary.charging &&
    summary.percent !== null &&
    summary.percent <= 15;

  return (
    <SectionShell
      title="Battery"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh battery status"
          title="Refresh battery status"
          disabled={!data?.available}
          onClick={() => status.refetch()}
        >
          <RotateCw className={cn('size-4', status.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      {status.isLoading ? (
        <BatterySkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read battery state.</FallbackCard>
      ) : !data?.available ? (
        <FallbackCard icon={BatteryFull}>
          No battery was detected. This looks like a desktop or virtual machine.
        </FallbackCard>
      ) : (
        <div className="flex flex-col gap-4">
          {summary && (
            <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
              <BatteryGlyph
                percent={summary.percent}
                charging={summary.charging}
                className={cn('size-9 shrink-0', critical ? 'text-destructive' : 'text-foreground')}
              />
              <div className="min-w-0 flex-1">
                <p className="text-2xl font-semibold tabular-nums text-foreground">
                  {summary.percent !== null ? `${summary.percent}%` : '—'}
                </p>
                <p className={cn('text-sm', critical ? 'text-destructive' : 'text-muted-foreground')}>
                  {describeBattery(summary, data.acConnected)}
                </p>
              </div>
              {data.acConnected && (
                <span className="flex items-center gap-1.5 rounded-full bg-foreground/10 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  <Plug className="size-3.5" aria-hidden />
                  Plugged in
                </span>
              )}
            </div>
          )}

          <ul className="flex flex-col gap-2" aria-label="Batteries">
            {data.batteries.map((battery) => (
              <BatteryDetailRow key={battery.name} battery={battery} />
            ))}
          </ul>
        </div>
      )}
    </SectionShell>
  );
}

/** One-line description of the overall power state. */
function describeBattery(
  summary: NonNullable<ReturnType<typeof summarizePower>>,
  acConnected: boolean,
): string {
  if (summary.status === 'full' || summary.percent === 100) {
    return acConnected ? 'Fully charged' : 'Full';
  }
  if (summary.charging) {
    return summary.secondsRemaining !== null
      ? `Charging · ${formatTimeRemaining(summary.secondsRemaining)} until full`
      : 'Charging';
  }
  if (summary.secondsRemaining !== null) {
    return `${formatTimeRemaining(summary.secondsRemaining)} remaining`;
  }
  return acConnected ? 'Plugged in, not charging' : 'On battery';
}

/** Per-battery status text for the detail rows. */
function batteryRowStatus(battery: BatteryInfo): string {
  switch (battery.status) {
    case 'charging':
      return battery.secondsRemaining !== null
        ? `Charging · ${formatTimeRemaining(battery.secondsRemaining)} until full`
        : 'Charging';
    case 'discharging':
      return battery.secondsRemaining !== null
        ? `${formatTimeRemaining(battery.secondsRemaining)} remaining`
        : 'Discharging';
    case 'full':
      return 'Full';
    case 'not-charging':
      return 'Not charging';
    default:
      return 'Unknown';
  }
}

function BatteryDetailRow({ battery }: { battery: BatteryInfo }) {
  const charging = battery.status === 'charging';
  const critical = !charging && battery.percent !== null && battery.percent <= 15;
  const percent = battery.percent ?? 0;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <BatteryGlyph
            percent={battery.percent}
            charging={charging}
            className="size-4.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate text-sm text-foreground">{battery.name}</span>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {battery.percent !== null ? `${battery.percent}%` : '—'}
        </span>
      </div>

      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-valuenow={battery.percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${battery.name} charge`}
      >
        <div
          className={cn('h-full rounded-full', critical ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">{batteryRowStatus(battery)}</p>
    </li>
  );
}

function BatterySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex items-center gap-4 rounded-xl border border-border/60 p-4">
        <Skeleton className="size-9 rounded bg-foreground/10" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-6 w-16 bg-foreground/10" />
          <Skeleton className="h-3.5 w-32 bg-foreground/10" />
        </div>
      </div>
      <div className="rounded-lg border border-border/60 p-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3.5 w-20 bg-foreground/10" />
          <Skeleton className="h-3.5 w-8 bg-foreground/10" />
        </div>
        <Skeleton className="mt-2 h-2 w-full rounded-full bg-foreground/10" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nostr & Storage
// ---------------------------------------------------------------------------

/**
 * Manages where Din stores your data: encrypted app-data sync (NIP-78 +
 * NIP-44), the NIP-65 relay list, and the BUD-03 Blossom server list.
 */
function NostrStorageSection() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const syncStatus = useAppDataSyncStatus();

  const nip44Missing = Boolean(user) && !user?.signer.nip44;

  return (
    <SectionShell title="Nostr & Storage" actions={<SyncStatusBadge status={syncStatus} />}>
      {/* Encrypted sync master toggle */}
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="sync-to-nostr" className="cursor-pointer text-sm">
            Encrypted sync
          </Label>
          <p className="text-xs text-muted-foreground">
            Store desktop settings encrypted on your Nostr relays so they follow
            you across devices. Turn off to keep everything on this device only.
          </p>
        </div>
        <Switch
          id="sync-to-nostr"
          checked={config.syncToNostr}
          onCheckedChange={(checked) =>
            updateConfig((current) => ({ ...current, syncToNostr: checked }))
          }
        />
      </div>

      {!user && (
        <p className="text-xs text-muted-foreground">
          Log in to sync your settings, relays, and servers with Nostr.
        </p>
      )}

      {nip44Missing && config.syncToNostr && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Your signer doesn't support NIP-44 encryption, so settings stay on this
          device. Upgrade your signer to enable encrypted sync.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Relays</h3>
          <p className="text-xs text-muted-foreground">
            Nostr relays Din reads from and publishes to (NIP-65).
          </p>
        </div>
        <RelayListManager />
      </div>

      <div className="space-y-3 border-t border-border/60 pt-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Blossom servers</h3>
          <p className="text-xs text-muted-foreground">
            Servers where Din stores files like your avatar (BUD-03).
          </p>
        </div>
        <BlossomServerManager />
      </div>
    </SectionShell>
  );
}

/** Small pill showing the aggregate state of Din's encrypted app-data sync. */
function SyncStatusBadge({ status }: { status: ReturnType<typeof useAppDataSyncStatus> }) {
  const view = {
    local: { icon: CloudOff, label: 'Local only', className: 'text-muted-foreground' },
    syncing: { icon: Loader2, label: 'Syncing…', className: 'text-muted-foreground' },
    synced: { icon: Check, label: 'Synced', className: 'text-primary' },
    error: { icon: TriangleAlert, label: 'Sync error', className: 'text-destructive' },
  }[status];

  return (
    <span
      role="status"
      className={cn('flex items-center gap-1.5 text-xs font-medium', view.className)}
    >
      <view.icon
        className={cn('size-3.5', status === 'syncing' && 'animate-spin')}
        aria-hidden
      />
      {view.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { config, updateConfig } = useAppContext();

  return (
    <SectionShell title="Appearance">
      <p className="mb-3 text-sm text-muted-foreground">Theme</p>
      <div className="flex gap-2" role="radiogroup" aria-label="Theme">
        {(
          [
            { value: 'light', name: 'Light', icon: Sun },
            { value: 'dark', name: 'Dark', icon: Moon },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={theme === option.value}
            onClick={() => setTheme(option.value)}
            className={cn(
              'flex w-28 flex-col items-center gap-2 rounded-xl border p-4',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              theme === option.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <option.icon className="size-6" aria-hidden />
            <span className="text-sm">{option.name}</span>
          </button>
        ))}
      </div>

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Effects</p>
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="wobbly-windows" className="cursor-pointer text-sm">
            Wobbly windows
          </Label>
          <p className="text-xs text-muted-foreground">
            Windows wriggle like jelly while you drag them, Compiz style.
            Automatically disabled when your system prefers reduced motion.
          </p>
        </div>
        <Switch
          id="wobbly-windows"
          checked={config.wobblyWindows}
          onCheckedChange={(checked) =>
            updateConfig((current) => ({ ...current, wobblyWindows: checked }))
          }
        />
      </div>

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Cursor</p>
      <CursorThemePicker />
    </SectionShell>
  );
}

/**
 * Custom cursor theme picker. Uses Din's in-app file picker to choose a
 * `.CurXPTheme` file, reads it through the `window.fs` bridge, parses it in the
 * browser, and stores the resulting cursor frames in AppConfig (see
 * CursorThemeApplier for the animated DOM side). Other cursor formats can be
 * added later by extending src/lib/cursorTheme.ts.
 */
function CursorThemePicker() {
  const { config, updateConfig } = useAppContext();
  const { toast } = useToast();
  const { pickFile } = useFilePicker();
  const bridge = getFsBridge();
  const [busy, setBusy] = useState(false);

  const active = config.customCursor;

  const choose = async () => {
    const path = await pickFile({
      title: 'Choose a cursor theme',
      confirmLabel: 'Apply cursor',
      extensions: ['.CurXPTheme'],
    });
    if (!path) return;

    setBusy(true);
    try {
      const fs = getFsBridge();
      if (!fs) throw new Error('Filesystem is unavailable outside the Din shell.');
      const { data } = await fs.readFile(path);
      const fileName = path.split('/').pop() ?? 'Custom cursor';
      const theme = await parseCurXPTheme(data, fileName);
      updateConfig((current) => ({ ...current, customCursor: theme }));
      toast({
        title: 'Cursor applied',
        description: `"${theme.name}" is now your cursor.`,
      });
    } catch (error) {
      toast({
        title: "Couldn't load cursor theme",
        description:
          error instanceof Error
            ? error.message
            : 'The file could not be read as a .CurXPTheme.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    updateConfig((current) => ({ ...current, customCursor: null }));
  };

  const mappedCount = active ? Object.keys(active.cursors).length : 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Custom cursor</p>
          <p className="text-xs text-muted-foreground">
            Choose a{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              .CurXPTheme
            </code>{' '}
            file to replace the system cursor. Animated cursors play their full
            animation.
          </p>
        </div>
        <MousePointer2
          className={cn(
            'size-5 shrink-0',
            active ? 'text-primary' : 'text-muted-foreground/60',
          )}
          aria-hidden
        />
      </div>

      {active && (
        <div className="flex items-center gap-3 rounded-md border bg-background/60 p-2">
          <CursorThemePreview theme={active} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {active.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {mappedCount} cursor{mappedCount === 1 ? '' : 's'} mapped
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy || !bridge}
          onClick={choose}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Upload aria-hidden />
          )}
          {active ? 'Replace…' : 'Choose file…'}
        </Button>
        {active && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <Trash2 aria-hidden />
            Reset
          </Button>
        )}
      </div>

      {!bridge && (
        <p className="text-xs text-muted-foreground">
          Cursor themes require the Din desktop shell.
        </p>
      )}
    </div>
  );
}

/**
 * Small animated preview of a cursor theme's default (Arrow) cursor, so the
 * user can see the animation in Settings without moving their pointer.
 */
function CursorThemePreview({ theme }: { theme: CursorTheme }) {
  const cursor = theme.cursors.default ?? Object.values(theme.cursors)[0];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!cursor || cursor.frames.length <= 1) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      setFrame((f) => f + 1);
    }, cursor.intervalMs);
    return () => window.clearInterval(id);
  }, [cursor]);

  if (!cursor) return null;

  // Clamp into range so switching themes (with fewer frames) never over-indexes.
  const src = cursor.frames[frame % cursor.frames.length];

  return (
    <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted/40">
      <img
        src={src}
        alt=""
        className="max-h-8 max-w-8 object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Developers
// ---------------------------------------------------------------------------

/**
 * Developer utilities. Currently a single control that crashes the shell on
 * purpose: clicking "Crash" arms a state flag, and the next render throws.
 * Throwing during render (rather than in the click handler) matters — React
 * error boundaries only catch render errors, so this is the reliable way to
 * exercise the root <ErrorBoundary> death screen.
 */
function DevelopersSection() {
  const [armed, setArmed] = useState(false);

  if (armed) {
    throw new Error('Intentional crash triggered from Settings → Developers');
  }

  return (
    <SectionShell title="Developers">
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Trigger an error</p>
          <p className="text-xs text-muted-foreground">
            Throws an uncaught render error to crash the shell and show the
            death screen. Use TRY AGAIN there to recover.
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setArmed(true)}>
          <Bomb aria-hidden />
          Crash
        </Button>
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Shared layout bits
// ---------------------------------------------------------------------------

function SectionShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function FallbackCard({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      {Icon && <Icon className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />}
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
