import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Airplay,
  BatteryFull,
  Bell,
  BellOff,
  Bomb,
  Bug,
  Check,
  CircleArrowUp,
  Clock,
  Cloud,
  CloudOff,
  EthernetPort,
  Gauge,
  Globe,
  KeyRound,
  Keyboard,
  Laptop,
  Loader2,
  Lock,
  Mic,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Play,
  Palette,
  Plug,
  Plus,
  RotateCw,
  Search,
  Sun,
  TriangleAlert,
  Trash2,
  Upload,
  Volume2,
  Wifi,
  WifiOff,
  ZoomIn,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { cleanWifiError, getWifiBridge, isEthernetConnected, isSecured } from '@/lib/wifi';
import { WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { VpnControls } from '@/components/desktop/VpnControls';
import type { WifiNetwork } from '@/lib/wifi';
import {
  useSavedNetworks,
  useWifiMutations,
  useWifiNetworks,
  useWifiStatus,
} from '@/hooks/useWifi';
import {
  cleanDisplayError,
  formatMode,
  friendlyOutputName,
  getDisplayBridge,
  isInternalOutput,
  preferredMode,
  uniqueModes,
} from '@/lib/display';
import type { DisplayMode, DisplayOutput, DisplayPlacement } from '@/lib/display';
import { getZoomBridge } from '@/lib/zoom';
import { useApplyDisplayLayout, useDisplayStatus } from '@/hooks/useDisplay';
import { useAirPlayState } from '@/hooks/useAirPlay';
import { getAirPlayBridge } from '@/lib/airplay';
import { AirPlayReceiverList } from '@/components/desktop/AirPlayIndicator';
import {
  describePowerProfile,
  formatTimeRemaining,
  getPowerBridge,
  summarizePower,
} from '@/lib/power';
import type { BatteryInfo } from '@/lib/power';
import {
  useBatteryStatus,
  usePowerProfiles,
  useSetPowerProfile,
} from '@/hooks/usePower';
import { BatteryGlyph } from '@/components/desktop/BatteryIndicator';
import { MAX_VOLUME, cleanAudioError, getAudioBridge } from '@/lib/audio';
import type { AudioDevice, AudioStream } from '@/lib/audio';
import {
  useAudioDeviceMutations,
  useAudioDevices,
  useAudioMutations,
  useAudioStatus,
  useAudioStreams,
} from '@/hooks/useAudio';
import { VolumeGlyph, VolumeSlider } from '@/components/desktop/VolumeIndicator';
import { getKeyboardBridge, layoutKey } from '@/lib/keyboard';
import { cleanLockError, getLockBridge } from '@/lib/lock';
import { useQuery } from '@tanstack/react-query';
import {
  describeZone,
  getDateTimeBridge,
  timeFormatOptions,
  zoneLongName,
  zoneOffset,
} from '@/lib/datetime';
import {
  useDateTimeStatus,
  useSetAutomaticTime,
  useSetTime,
  useSetTimeZone,
  useTimeZones,
} from '@/hooks/useDateTime';
import { useClock } from '@/hooks/useClock';
import type { ClockFormat } from '@/contexts/AppContext';
import {
  useKeyboardLayouts,
  useKeyboardStatus,
  useRestartForKeyboardLayout,
  useSetKeyboardLayout,
} from '@/hooks/useKeyboardLayout';
import { brightnessText, getBrightnessBridge, MAX_TEMPERATURE, MIN_TEMPERATURE } from '@/lib/brightness';
import { useBrightnessMutations, useBrightnessStatus } from '@/hooks/useBrightness';
import { BrightnessGlyph, BrightnessSlider } from '@/components/desktop/BrightnessIndicator';
import { Slider } from '@/components/ui/slider';
import { useTheme } from '@/hooks/useTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppDataSyncStatus } from '@/hooks/useAppData';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { setDoNotDisturb, useNotificationCenter } from '@/lib/notificationCenter';
import { NOTIFICATION_CATEGORY_META, type NotificationPreferences } from '@/lib/notifications';
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
import { Progress } from '@/components/ui/progress';
import { getUpdaterBridge, UPDATE_STEP_LABELS } from '@/lib/updater';
import type { UpdateState } from '@/lib/updater';
import { cleanInstallerError } from '@/lib/installer';
import { useUpdateState } from '@/hooks/useUpdater';

type SectionId =
  | 'wifi'
  | 'display'
  | 'brightness'
  | 'battery'
  | 'power'
  | 'sound'
  | 'keyboard'
  | 'datetime'
  | 'password'
  | 'notifications'
  | 'nostr'
  | 'appearance'
  | 'updates'
  | 'developers';

const SECTIONS: { id: SectionId; name: string; icon: LucideIcon }[] = [
  { id: 'wifi', name: 'Wi-Fi', icon: Wifi },
  { id: 'display', name: 'Display', icon: Monitor },
  { id: 'brightness', name: 'Brightness', icon: Sun },
  { id: 'battery', name: 'Battery', icon: BatteryFull },
  { id: 'power', name: 'Power', icon: Gauge },
  { id: 'sound', name: 'Sound', icon: Volume2 },
  { id: 'keyboard', name: 'Keyboard', icon: Keyboard },
  { id: 'datetime', name: 'Date & Time', icon: Clock },
  { id: 'password', name: 'Password', icon: KeyRound },
  { id: 'notifications', name: 'Notifications', icon: Bell },
  { id: 'nostr', name: 'Nostr & Storage', icon: Cloud },
  { id: 'appearance', name: 'Appearance', icon: Palette },
  { id: 'updates', name: 'Updates', icon: CircleArrowUp },
  { id: 'developers', name: 'Developers', icon: Bug },
];

/**
 * Settings - system preferences for the shell.
 *
 * The Wi-Fi section drives NetworkManager through `window.wifi` (Electron
 * preload + nmcli in the main process): toggle the radio, scan, join,
 * disconnect and forget networks. Outside the Electron shell it renders an
 * explanatory fallback. The Display section arranges the monitors through
 * `window.display` (wlr-randr under cage, xrandr on bare X11), falling back
 * where neither can manage them. The Battery section reads `window.power`
 * (/sys/class/power_supply) and hides on machines with no battery. The Power
 * section switches the system power profile through the same bridge
 * (net.hadess.PowerProfiles over D-Bus: power-profiles-daemon / tuned-ppd),
 * falling back where no such daemon runs. The Sound
 * section drives the default sink's volume/mute through `window.audio`
 * (wpctl/PipeWire). Keyboard picks the layout native Linux apps type with
 * through `window.keyboard`. Date & Time sets the time zone and clock
 * through `window.datetime`, and how Din's clocks show the time. Password changes the computer's one password
 * (disk, lock screen, Nostr keys) through `window.lock`. Nostr & Storage manages Din's encrypted app-data
 * sync, NIP-65 relay list, and Blossom server list. Appearance switches the
 * shell theme (AppContext, persisted to localStorage and roamed via
 * encrypted sync) and toggles desktop effects like wobbly windows.
 * Updates shows DinOS's version and the update it's staging through
 * `window.updater`, and offers the restart that finishes one.
 * Developers holds debug utilities such as intentionally crashing the shell
 * to test the error boundary.
 */
const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/** Extract a valid SectionId from launch params, if present. */
function paramSection(params: AppComponentProps['params']): SectionId | undefined {
  const s = params?.section;
  return typeof s === 'string' && SECTION_IDS.has(s) ? (s as SectionId) : undefined;
}

export function Settings({ params }: AppComponentProps) {
  const [section, setSection] = useState<SectionId>(
    () => paramSection(params) ?? 'wifi',
  );

  // The window is reused for this single-instance app, so a re-launch (e.g.
  // from a different tray indicator) updates params without remounting.
  // Follow the requested section when it changes.
  const requested = paramSection(params);
  const lastRequested = useRef(requested);
  useEffect(() => {
    if (requested && requested !== lastRequested.current) {
      lastRequested.current = requested;
      setSection(requested);
    }
  }, [requested]);

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
        ) : section === 'brightness' ? (
          <BrightnessSection />
        ) : section === 'battery' ? (
          <BatterySection />
        ) : section === 'power' ? (
          <PowerSection />
        ) : section === 'sound' ? (
          <SoundSection />
        ) : section === 'keyboard' ? (
          <KeyboardSection />
        ) : section === 'datetime' ? (
          <DateTimeSection />
        ) : section === 'password' ? (
          <PasswordSection />
        ) : section === 'notifications' ? (
          <NotificationsSection />
        ) : section === 'nostr' ? (
          <NostrStorageSection />
        ) : section === 'appearance' ? (
          <AppearanceSection />
        ) : section === 'updates' ? (
          <UpdatesSection />
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
  const ethernet = isEthernetConnected(status.data);
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
      {ethernet && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-border/60 bg-accent/40 px-3 py-2.5">
          <EthernetPort className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Connected via Ethernet</p>
            {status.data?.ethernet?.iface && (
              <p className="truncate text-xs text-muted-foreground">
                {status.data.ethernet.iface}
                {status.data.ethernet.connection ? ` · ${status.data.ethernet.connection}` : ''}
              </p>
            )}
          </div>
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
        </div>
      )}
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
      <VpnControls />
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
 * A single output's slot in the editable draft layout the Display panel works
 * on: its chosen mode, position in the shared virtual screen, and on/off +
 * primary flags. `modes` is de-duplicated to unique resolutions.
 */
interface DisplayDraft {
  name: string;
  friendly: string;
  internal: boolean;
  enabled: boolean;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  modes: DisplayMode[];
}

/** Seed the editable draft from the reported outputs. */
function draftFromOutputs(outputs: DisplayOutput[]): DisplayDraft[] {
  return outputs.map((output) => {
    const modes = uniqueModes(output.modes);
    const fallback = preferredMode(output) ?? modes[0] ?? null;
    return {
      name: output.name,
      friendly: output.airplay ? `${output.airplay} (AirPlay)` : friendlyOutputName(output.name),
      internal: isInternalOutput(output.name),
      enabled: output.enabled,
      primary: output.primary,
      x: output.position.x,
      y: output.position.y,
      width: output.current?.width ?? fallback?.width ?? 0,
      height: output.current?.height ?? fallback?.height ?? 0,
      modes,
    };
  });
}

/** A stable signature of the arrangement, for dirty-checking and re-seeding. */
function layoutSignature(drafts: DisplayDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => [d.name, d.enabled, d.primary, d.x, d.y, d.width, d.height]),
  );
}

/** Turn the draft into placements, normalized so the top-left sits at the origin. */
function toPlacements(drafts: DisplayDraft[]): DisplayPlacement[] {
  const on = drafts.filter((d) => d.enabled);
  const minX = on.length ? Math.min(...on.map((d) => d.x)) : 0;
  const minY = on.length ? Math.min(...on.map((d) => d.y)) : 0;
  return drafts.map((d) => ({
    output: d.name,
    enabled: d.enabled,
    primary: d.primary,
    x: d.enabled ? d.x - minX : 0,
    y: d.enabled ? d.y - minY : 0,
    width: d.width,
    height: d.height,
  }));
}

const MIN_ZOOM = 50; // %
const MAX_ZOOM = 200; // %
const ZOOM_STEP = 10; // %

/** Clamp a zoom percentage to the supported range and round to an integer. */
function clampZoom(percent: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent)));
}

/**
 * Interface zoom - DPI-style scaling of the whole desktop through Chromium
 * page zoom (window.zoom preload bridge). Lives in AppConfig (persisted
 * locally) and works in every Electron session, including ones where the
 * arrangement below is unavailable. In a plain browser there is no
 * bridge, so the control points at the browser's own zoom instead.
 */
function DisplayZoomControl({
  available,
  value,
  onChange,
}: {
  available: boolean;
  value: number;
  onChange: (percent: number) => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
      <div className="flex items-center gap-3">
        <ZoomIn className="size-6 shrink-0 text-foreground/90" aria-hidden />
        <div className="min-w-0">
          <Label htmlFor="interface-zoom" className="text-sm">
            Zoom
          </Label>
          <p className="text-xs text-muted-foreground">
            Scale everything on the desktop up or down.
          </p>
        </div>
      </div>
      {available ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="icon"
            aria-label="Zoom out"
            disabled={value <= MIN_ZOOM}
            onClick={() => onChange(clampZoom(value - ZOOM_STEP))}
          >
            <Minus className="size-4" />
          </Button>
          <span className="w-16 text-center text-sm tabular-nums font-medium">
            {value}%
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Zoom in"
            disabled={value >= MAX_ZOOM}
            onClick={() => onChange(clampZoom(value + ZOOM_STEP))}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Zoom needs the Din desktop shell. In a browser, use the browser's own
          zoom instead (Ctrl and + / -).
        </p>
      )}
    </div>
  );
}

/**
 * The whole multi-output arrangement, via the display bridge (window.display:
 * wlr-randr under cage, xrandr on bare X11), where Din is the whole desktop:
 * drag displays to position them, pick a resolution, choose the primary (the
 * one with the menu bar and Dock), and switch any output on or off; "Apply"
 * commits the layout in one atomic call. Where the outputs can't be managed,
 * or in a plain browser, the arrangement falls back to a note - but the zoom
 * control above always applies.
 */
function DisplaySection() {
  const bridge = getDisplayBridge();
  const status = useDisplayStatus();
  const apply = useApplyDisplayLayout();
  const { config, updateConfig } = useAppContext();

  const outputs = status.data?.available ? status.data.outputs : undefined;
  const baseline = useMemo(() => (outputs ? draftFromOutputs(outputs) : []), [outputs]);
  const baseSignature = useMemo(() => layoutSignature(baseline), [baseline]);

  const [draft, setDraft] = useState<DisplayDraft[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seededSignature = useRef<string>('');

  // Re-seed the draft only when the real arrangement changes (first load,
  // hotplug, an applied layout, or a change made from elsewhere) - not on
  // every poll, so in-progress edits survive the 5s refetch.
  useEffect(() => {
    if (outputs && baseSignature !== seededSignature.current) {
      seededSignature.current = baseSignature;
      setDraft(draftFromOutputs(outputs));
      setError(null);
    }
  }, [outputs, baseSignature]);

  const enabledCount = draft.filter((d) => d.enabled).length;
  const dirty = draft.length > 0 && layoutSignature(draft) !== baseSignature;
  const canApply = dirty && !apply.isPending;

  const setEnabled = (name: string, enabled: boolean) => {
    setDraft((ds) => {
      const next = ds.map((d) => (d.name === name ? { ...d, enabled } : d));
      // Keep exactly one primary among the outputs that stay on.
      const on = next.filter((d) => d.enabled);
      if (on.length > 0 && !on.some((d) => d.primary)) {
        const promote = on[0].name;
        return next.map((d) => ({ ...d, primary: d.name === promote }));
      }
      return next;
    });
  };
  const setPrimary = (name: string) =>
    setDraft((ds) => ds.map((d) => ({ ...d, primary: d.name === name })));
  const setModeFor = (name: string, width: number, height: number) =>
    setDraft((ds) => ds.map((d) => (d.name === name ? { ...d, width, height } : d)));
  const moveTo = (name: string, x: number, y: number) =>
    setDraft((ds) => ds.map((d) => (d.name === name ? { ...d, x, y } : d)));

  const onApply = () => {
    setError(null);
    apply.mutate(toPlacements(draft), { onError: (e) => setError(cleanDisplayError(e)) });
  };
  const onRevert = () => {
    if (outputs) setDraft(draftFromOutputs(outputs));
    setError(null);
  };

  const setZoom = (percent: number) =>
    updateConfig((c) => ({ ...c, zoomLevel: clampZoom(percent) }));

  const arrangement = !bridge ? (
    <FallbackCard icon={Monitor}>
      Displays can't be arranged in a plain browser - it has none to arrange.
    </FallbackCard>
  ) : status.isLoading ? (
    <DisplayListSkeleton />
  ) : status.isError ? (
    <FallbackCard>Could not read display state: {cleanDisplayError(status.error)}</FallbackCard>
  ) : !status.data?.available ? (
    <FallbackCard icon={Monitor}>
      Displays can't be arranged here. This session's display server doesn't
      let Din manage its outputs.
    </FallbackCard>
  ) : draft.length === 0 ? (
    <FallbackCard icon={Monitor}>No connected displays were found.</FallbackCard>
  ) : (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Drag a display to position it. Changes preview below and take effect
        when you apply them.
      </p>
      <DisplayArrange draft={draft} selected={selected} onSelect={setSelected} onMove={moveTo} />

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={!dirty || apply.isPending} onClick={onRevert}>
          Revert
        </Button>
        <Button size="sm" disabled={!canApply} onClick={onApply}>
          {apply.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Apply
        </Button>
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-2" aria-label="Displays">
        {draft.map((d) => (
          <DisplayControlRow
            key={d.name}
            draft={d}
            canDisable={enabledCount > 1}
            selected={selected === d.name}
            onToggle={setEnabled}
            onPrimary={setPrimary}
            onMode={setModeFor}
          />
        ))}
      </ul>
    </div>
  );

  return (
    <SectionShell
      title="Display"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh displays"
          title="Refresh displays"
          disabled={!bridge || !status.data?.available}
          onClick={() => status.refetch()}
        >
          <RotateCw className={cn('size-4', status.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      <DisplayZoomControl
        available={getZoomBridge() !== undefined}
        value={config.zoomLevel}
        onChange={setZoom}
      />
      {arrangement}
      <AirPlayDisplays />
    </SectionShell>
  );
}

/**
 * AirPlay receivers nearby: mirror the screen to one, or add it as a
 * separate display, which then appears in the arrangement above. Hidden
 * where AirPlay isn't available.
 */
function AirPlayDisplays() {
  const { data } = useAirPlayState();
  if (!getAirPlayBridge() || !data?.available) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <SoundGroupHeading icon={Airplay}>AirPlay</SoundGroupHeading>
      <p className="text-xs text-muted-foreground">
        Share the screen with an Apple TV, AirPlay TV or other receiver on this
        network. Sound plays there too, and the volume keys control it.
      </p>
      <AirPlayReceiverList />
    </div>
  );
}

/** Nudge an axis onto the nearest candidate edge within `threshold` virtual px. */
function snapAxis(value: number, edges: number[], threshold: number): number {
  let best = value;
  let bestDist = threshold;
  for (const edge of edges) {
    const dist = Math.abs(edge - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = edge;
    }
  }
  return best;
}

/** Snap a dragged rect's top-left so its edges abut/align with the other rects. */
function snapPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  others: DisplayDraft[],
  threshold: number,
): [number, number] {
  const xEdges: number[] = [];
  const yEdges: number[] = [];
  for (const o of others) {
    // align left / align right / place to the right / place to the left
    xEdges.push(o.x, o.x + o.width - w, o.x + o.width, o.x - w);
    // align top / align bottom / place below / place above
    yEdges.push(o.y, o.y + o.height - h, o.y + o.height, o.y - h);
  }
  return [
    Math.round(snapAxis(x, xEdges, threshold)),
    Math.round(snapAxis(y, yEdges, threshold)),
  ];
}

const ARRANGE_HEIGHT = 224; // px (h-56)
const ARRANGE_PAD = 16; // px inset around the scaled arrangement

/**
 * A scaled, draggable map of the enabled outputs. The arrangement is fit into a
 * fixed-height box; dragging a display updates its position in the draft, with
 * edge-snapping against the other displays.
 */
function DisplayArrange({
  draft,
  selected,
  onSelect,
  onMove,
}: {
  draft: DisplayDraft[];
  selected: string | null;
  onSelect: (name: string) => void;
  onMove: (name: string, x: number, y: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<{ name: string; px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const on = draft.filter((d) => d.enabled);
  const minX = on.length ? Math.min(...on.map((d) => d.x)) : 0;
  const minY = on.length ? Math.min(...on.map((d) => d.y)) : 0;
  const maxX = on.length ? Math.max(...on.map((d) => d.x + d.width)) : 1;
  const maxY = on.length ? Math.max(...on.map((d) => d.y + d.height)) : 1;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const rawScale = Math.min(
    (width - ARRANGE_PAD * 2) / spanX,
    (ARRANGE_HEIGHT - ARRANGE_PAD * 2) / spanY,
  );
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 0;
  const offX = (width - spanX * scale) / 2;
  const offY = (ARRANGE_HEIGHT - spanY * scale) / 2;

  const onPointerDown = (e: React.PointerEvent, d: DisplayDraft) => {
    onSelect(d.name);
    if (scale === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { name: d.name, px: e.clientX, py: e.clientY, ox: d.x, oy: d.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const st = drag.current;
    if (!st || scale === 0) return;
    const nx = Math.round(st.ox + (e.clientX - st.px) / scale);
    const ny = Math.round(st.oy + (e.clientY - st.py) / scale);
    const moving = draft.find((d) => d.name === st.name);
    if (!moving) return;
    const others = on.filter((d) => d.name !== st.name);
    const [sx, sy] = snapPosition(nx, ny, moving.width, moving.height, others, 24 / scale);
    onMove(st.name, sx, sy);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be gone; ignore.
    }
    drag.current = null;
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-lg border border-border/60 bg-background/40"
      style={{ height: ARRANGE_HEIGHT, touchAction: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {on.length === 0 ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          All displays are off.
        </p>
      ) : (
        on.map((d) => (
          <button
            key={d.name}
            type="button"
            aria-label={`Position ${d.friendly}`}
            onPointerDown={(e) => onPointerDown(e, d)}
            className={cn(
              'absolute flex select-none flex-col items-center justify-center overflow-hidden rounded-md border text-center',
              'cursor-grab touch-none active:cursor-grabbing',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              d.primary ? 'border-primary bg-primary/15' : 'border-border bg-foreground/10',
              selected === d.name && 'ring-2 ring-ring',
            )}
            style={{
              left: offX + (d.x - minX) * scale,
              top: offY + (d.y - minY) * scale,
              width: Math.max(d.width * scale, 8),
              height: Math.max(d.height * scale, 8),
            }}
          >
            <span className="truncate px-1 text-[11px] font-medium text-foreground">
              {d.friendly}
            </span>
            <span className="truncate px-1 text-[10px] text-muted-foreground">
              {d.width} × {d.height}
            </span>
            {d.primary && (
              <span className="text-[9px] font-medium uppercase tracking-wide text-primary">
                Primary
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

function DisplayControlRow({
  draft,
  canDisable,
  selected,
  onToggle,
  onPrimary,
  onMode,
}: {
  draft: DisplayDraft;
  canDisable: boolean;
  selected: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onPrimary: (name: string) => void;
  onMode: (name: string, width: number, height: number) => void;
}) {
  const d = draft;
  const Icon = d.internal ? Laptop : Monitor;
  const selectId = `resolution-${d.name}`;
  const currentValue = `${d.width}x${d.height}`;

  return (
    <li
      className={cn(
        'rounded-lg border bg-background/40 p-3',
        selected ? 'border-ring' : 'border-border/60',
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm text-foreground">
            {d.friendly}
            {d.primary && (
              <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Primary
              </span>
            )}
            {!d.enabled && (
              <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Off
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{d.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`enabled-${d.name}`} className="text-xs text-muted-foreground">
            On
          </Label>
          <Switch
            id={`enabled-${d.name}`}
            checked={d.enabled}
            disabled={d.enabled && !canDisable}
            onCheckedChange={(value) => onToggle(d.name, value)}
            aria-label={`Turn ${d.friendly} ${d.enabled ? 'off' : 'on'}`}
          />
        </div>
      </div>

      {d.enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={d.primary ? 'secondary' : 'outline'}
            size="sm"
            disabled={d.primary}
            onClick={() => onPrimary(d.name)}
          >
            {d.primary ? 'Primary display' : 'Make primary'}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Label htmlFor={selectId} className="sr-only">
              Resolution for {d.friendly}
            </Label>
            <select
              id={selectId}
              value={currentValue}
              disabled={d.modes.length === 0}
              onChange={(e) => {
                const [width, height] = e.target.value.split('x').map(Number);
                if (Number.isFinite(width) && Number.isFinite(height)) onMode(d.name, width, height);
              }}
              className={cn(
                'h-8 rounded-md border border-border/60 bg-background px-2 text-sm text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {d.modes.map((mode) => (
                <option key={`${mode.width}x${mode.height}`} value={`${mode.width}x${mode.height}`}>
                  {formatMode(mode.width, mode.height)}
                  {mode.preferred ? ' (native)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
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
// Power
// ---------------------------------------------------------------------------

/**
 * System power profile (power-saver / balanced / performance), via the power
 * bridge (window.power -> net.hadess.PowerProfiles over D-Bus, served by
 * power-profiles-daemon or tuned-ppd). Independent of battery presence, so it
 * shows on desktops too. Falls back in a plain browser or where no such daemon
 * is running.
 */
function PowerSection() {
  const bridge = getPowerBridge();
  const profiles = usePowerProfiles();
  const setProfile = useSetPowerProfile();

  if (!bridge) {
    return (
      <SectionShell title="Power">
        <FallbackCard icon={Gauge}>
          Power profiles need the Din desktop shell; they aren't available in a
          plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const data = profiles.data;
  // While a switch is in flight, show the requested profile as selected.
  const selected = setProfile.isPending ? setProfile.variables : data?.active;

  return (
    <SectionShell
      title="Power"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh power profiles"
          title="Refresh power profiles"
          disabled={!data?.available}
          onClick={() => profiles.refetch()}
        >
          <RotateCw className={cn('size-4', profiles.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      {profiles.isLoading ? (
        <PowerSkeleton />
      ) : profiles.isError ? (
        <FallbackCard>Could not read power profiles.</FallbackCard>
      ) : !data?.available ? (
        <FallbackCard icon={Gauge}>
          No power-profile daemon was detected. Enable power-profiles-daemon (or
          tuned-ppd on Fedora) to switch profiles.
        </FallbackCard>
      ) : (
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Power profile" className="flex flex-col gap-2">
            {data.profiles.map((id) => {
              const meta = describePowerProfile(id);
              const active = selected === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={setProfile.isPending}
                  onClick={() => {
                    if (id !== data.active) setProfile.mutate(id);
                  }}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    active
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 bg-background/40 hover:bg-foreground/5',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/50',
                    )}
                    aria-hidden
                  >
                    {active && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{meta.label}</span>
                    {meta.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {meta.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {setProfile.isError && (
            <p className="text-sm text-destructive">
              {setProfile.error instanceof Error
                ? setProfile.error.message
                : 'Could not switch power profile.'}
            </p>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function PowerSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-xl border border-border/60 p-4">
          <Skeleton className="size-5 shrink-0 rounded-full bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24 bg-foreground/10" />
            <Skeleton className="h-3 w-48 bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/**
 * Screen backlight and night light (red shift), via the brightness bridge
 * (window.brightness). Backlight rides on brightnessctl (/sys/class/backlight);
 * night light on a Wayland/X11 gamma tool (gammastep/wlsunset). Each half falls
 * back independently, and the whole section falls back in a plain browser.
 * Media keys drive the backlight and show the brightness OSD.
 */
function BrightnessSection() {
  const bridge = getBrightnessBridge();
  const status = useBrightnessStatus();
  const { setBrightness, setNightLight, setTemperature } = useBrightnessMutations();

  const backlightAvailable = status.data?.available ?? false;
  const serverBrightness = status.data?.brightness ?? 0;
  const nightLight = status.data?.nightLight;

  // Local values for smooth drags; committed on release, re-synced to the
  // server value by adjusting state during render rather than in an effect.
  const [value, setValue] = useState(serverBrightness);
  const [lastServer, setLastServer] = useState(serverBrightness);
  if (serverBrightness !== lastServer) {
    setLastServer(serverBrightness);
    setValue(serverBrightness);
  }

  const serverTemp = nightLight?.temperature ?? MAX_TEMPERATURE;
  const [temp, setTemp] = useState(serverTemp);
  const [lastTemp, setLastTemp] = useState(serverTemp);
  if (serverTemp !== lastTemp) {
    setLastTemp(serverTemp);
    setTemp(serverTemp);
  }

  if (!bridge) {
    return (
      <SectionShell title="Brightness">
        <FallbackCard icon={Sun}>
          Brightness settings need the Din desktop shell; the screen backlight
          can't be controlled in a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const refresh = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Refresh brightness status"
      title="Refresh brightness status"
      onClick={() => status.refetch()}
    >
      <RotateCw className={cn('size-4', status.isFetching && 'animate-spin')} />
    </Button>
  );

  if (status.isLoading) {
    return (
      <SectionShell title="Brightness" actions={refresh}>
        <div className="h-20 rounded-xl border border-border/60" aria-hidden>
          <div className="flex h-full items-center gap-4 px-4">
            <Skeleton className="size-8 rounded bg-foreground/10" />
            <Skeleton className="h-2 flex-1 rounded-full bg-foreground/10" />
          </div>
        </div>
      </SectionShell>
    );
  }

  if (!backlightAvailable && !nightLight?.available) {
    return (
      <SectionShell title="Brightness" actions={refresh}>
        <FallbackCard icon={Sun}>
          No backlight or gamma tool was found. Neither brightnessctl nor a
          night-light tool (gammastep/wlsunset) is available on this system.
        </FallbackCard>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Brightness" actions={refresh}>
      <div className="flex flex-col gap-4">
        {backlightAvailable && (
          <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <BrightnessGlyph brightness={value} className="size-6 shrink-0 text-foreground/90" />
            <BrightnessSlider
              aria-label="Screen brightness"
              value={value}
              className="flex-1"
              onValueChange={setValue}
              onValueCommit={(v) => setBrightness.mutate(v)}
            />
            <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
              {brightnessText(value)}
            </span>
          </div>
        )}

        {nightLight?.available && (
          <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <Moon
                  className={cn(
                    'size-6 shrink-0',
                    nightLight.enabled ? 'text-foreground/90' : 'text-muted-foreground',
                  )}
                  aria-hidden
                />
                <div className="min-w-0">
                  <Label htmlFor="night-light" className="cursor-pointer text-sm">
                    Night Light
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Warm the display's colors to reduce blue light.
                  </p>
                </div>
              </div>
              <Switch
                id="night-light"
                checked={nightLight.enabled}
                onCheckedChange={(checked) => setNightLight.mutate(checked)}
              />
            </div>

            {nightLight.enabled && (
              <div className="flex items-center gap-3 border-t border-border/60 pt-4">
                <span className="text-xs text-muted-foreground">Cooler</span>
                {/* Invert the axis so dragging right warms the screen. */}
                <Slider
                  aria-label="Color temperature"
                  value={[MIN_TEMPERATURE + MAX_TEMPERATURE - temp]}
                  min={MIN_TEMPERATURE}
                  max={MAX_TEMPERATURE}
                  step={100}
                  className="flex-1"
                  onValueChange={([v]) => setTemp(MIN_TEMPERATURE + MAX_TEMPERATURE - v)}
                  onValueCommit={() => setTemperature.mutate(temp)}
                />
                <span className="text-xs text-muted-foreground">Warmer</span>
                <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
                  {temp}K
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
}

/** A small heading that groups a subsection within a panel (Sound, Display). */
function SoundGroupHeading({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1 text-sm font-medium text-foreground">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </div>
  );
}

/**
 * One selectable output/input device row: a radio to make it the default plus,
 * for outputs, a button that plays a test tone through it.
 */
function AudioDeviceRow({
  device,
  kind,
  onSelect,
  onTest,
  testing,
}: {
  device: AudioDevice;
  kind: 'output' | 'input';
  onSelect: () => void;
  onTest?: () => void;
  testing?: boolean;
}) {
  const Icon = kind === 'input' ? Mic : Volume2;
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border p-2.5',
        device.isDefault
          ? 'border-primary/50 bg-primary/5'
          : 'border-border/60 bg-background/40',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={device.isDefault}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border',
            device.isDefault ? 'border-primary' : 'border-muted-foreground/50',
          )}
          aria-hidden
        >
          {device.isDefault && <span className="size-2 rounded-full bg-primary" />}
        </span>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-sm">{device.name}</span>
        {device.isDefault && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">Default</span>
        )}
      </button>
      {onTest && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={onTest}
          disabled={testing}
          aria-label={`Test ${device.name}`}
          title="Play a test tone"
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="size-3.5" aria-hidden />
          )}
          Test
        </Button>
      )}
    </div>
  );
}

/** A per-application volume row with a smooth local drag committed on release. */
function AudioStreamRow({
  stream,
  onVolume,
  onMuted,
}: {
  stream: AudioStream;
  onVolume: (percent: number) => void;
  onMuted: (muted: boolean) => void;
}) {
  const [value, setValue] = useState(stream.volume);
  const [lastServer, setLastServer] = useState(stream.volume);
  if (stream.volume !== lastServer) {
    setLastServer(stream.volume);
    setValue(stream.volume);
  }
  const shown = Math.min(MAX_VOLUME, value);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background/40 p-2.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={stream.muted ? `Unmute ${stream.name}` : `Mute ${stream.name}`}
        onClick={() => onMuted(!stream.muted)}
      >
        <VolumeGlyph
          volume={shown}
          muted={stream.muted}
          className={cn('size-4', stream.muted && 'text-muted-foreground')}
        />
      </Button>
      <span className="w-28 shrink-0 truncate text-sm" title={stream.name}>
        {stream.name}
      </span>
      <VolumeSlider
        aria-label={`${stream.name} volume`}
        value={stream.muted ? 0 : shown}
        className="flex-1"
        onValueChange={(v) => {
          if (stream.muted) onMuted(false);
          setValue(v);
        }}
        onValueCommit={(v) => onVolume(v)}
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {stream.muted ? 'Muted' : `${shown}%`}
      </span>
    </div>
  );
}

/**
 * A live microphone level meter driven by getUserMedia + an AnalyserNode - the
 * standard web way to test an input. It records the system default source, so
 * it reflects whichever input is selected above. Errors (no permission, no
 * device) surface inline rather than throwing.
 */
function MicTest() {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
          peak = Math.max(peak, Math.abs(buffer[i] - 128));
        }
        setLevel(Math.min(1, peak / 128));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setActive(true);
    } catch (err) {
      setError(cleanAudioError(err));
      setActive(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background/40 p-2.5">
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => {
            if (active) {
              stop();
              setActive(false);
            } else {
              void start();
            }
          }}
        >
          <Mic className="size-3.5" aria-hidden />
          {active ? 'Stop' : 'Test mic'}
        </Button>
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="Microphone input level"
          aria-valuenow={Math.round(level * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Sound: the default sink's volume/mute plus, when the audio bridge
 * (window.audio, wpctl/PipeWire) is present, output/input device selection, a
 * per-output test tone, a microphone level test, and per-application volume.
 * Falls back where PipeWire/wpctl is absent or in a plain browser. Media keys
 * drive the same default sink and show the volume OSD.
 */
function SoundSection() {
  const bridge = getAudioBridge();
  const { toast } = useToast();
  const status = useAudioStatus();
  const { setVolume, setMuted } = useAudioMutations();
  const devices = useAudioDevices();
  const streams = useAudioStreams();
  const { setDefault, setNodeVolume, setNodeMuted, test } = useAudioDeviceMutations();

  const serverVolume = status.data?.volume ?? 0;
  const muted = status.data?.muted ?? false;

  // Local value for a smooth drag; committed to wpctl on release, re-synced to
  // the server value (media keys, external wpctl) by adjusting state during
  // render rather than in an effect.
  const [value, setValue] = useState(serverVolume);
  const [lastServer, setLastServer] = useState(serverVolume);
  if (serverVolume !== lastServer) {
    setLastServer(serverVolume);
    setValue(serverVolume);
  }

  const runTest = (device: AudioDevice) =>
    test.mutate(device.id, {
      onError: (err) =>
        toast({
          title: 'Test tone failed',
          description: cleanAudioError(err),
          variant: 'destructive',
        }),
    });

  if (!bridge) {
    return (
      <SectionShell title="Sound">
        <FallbackCard icon={Volume2}>
          Sound settings need the Din desktop shell; volume can't be controlled
          in a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const sinks = devices.data?.sinks ?? [];
  const sources = devices.data?.sources ?? [];
  const appStreams = streams.data?.streams ?? [];

  return (
    <SectionShell
      title="Sound"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh sound status"
          title="Refresh sound status"
          disabled={!status.data?.available}
          onClick={() => {
            void status.refetch();
            void devices.refetch();
            void streams.refetch();
          }}
        >
          <RotateCw
            className={cn(
              'size-4',
              (status.isFetching || devices.isFetching || streams.isFetching) &&
                'animate-spin',
            )}
          />
        </Button>
      }
    >
      {status.isLoading ? (
        <div className="h-20 rounded-xl border border-border/60" aria-hidden>
          <div className="flex h-full items-center gap-4 px-4">
            <Skeleton className="size-8 rounded bg-foreground/10" />
            <Skeleton className="h-2 flex-1 rounded-full bg-foreground/10" />
          </div>
        </div>
      ) : !status.data?.available ? (
        <FallbackCard icon={Volume2}>
          No audio output was found. PipeWire (wpctl) isn't available on this
          system, so volume can't be managed here.
        </FallbackCard>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
            <Button
              variant="ghost"
              size="icon"
              aria-label={muted ? 'Unmute' : 'Mute'}
              title={muted ? 'Unmute' : 'Mute'}
              className="size-9 shrink-0 text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
              onClick={() => setMuted.mutate(!muted)}
            >
              <VolumeGlyph
                volume={value}
                muted={muted}
                className={cn('size-6', muted && 'text-muted-foreground')}
              />
            </Button>
            <VolumeSlider
              aria-label="Output volume"
              value={muted ? 0 : value}
              className="flex-1"
              onValueChange={(v) => {
                if (muted) setMuted.mutate(false);
                setValue(v);
              }}
              onValueCommit={(v) => setVolume.mutate(v)}
            />
            <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
              {muted ? 'Muted' : `${value}%`}
            </span>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
            <div className="min-w-0">
              <Label htmlFor="mute-output" className="cursor-pointer text-sm">
                Mute
              </Label>
              <p className="text-xs text-muted-foreground">
                Silence all output without losing your volume level.
              </p>
            </div>
            <Switch
              id="mute-output"
              checked={muted}
              onCheckedChange={(checked) => setMuted.mutate(checked)}
            />
          </div>

          {/* Output devices */}
          <SoundGroupHeading icon={Volume2}>Output device</SoundGroupHeading>
          {sinks.length > 0 ? (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Output device">
              {sinks.map((device) => (
                <AudioDeviceRow
                  key={device.id}
                  device={device}
                  kind="output"
                  onSelect={() => setDefault.mutate(device.id)}
                  onTest={() => runTest(device)}
                  testing={test.isPending && test.variables === device.id}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No output devices found.</p>
          )}

          {/* Input devices */}
          <SoundGroupHeading icon={Mic}>Input device</SoundGroupHeading>
          {sources.length > 0 ? (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Input device">
              {sources.map((device) => (
                <AudioDeviceRow
                  key={device.id}
                  device={device}
                  kind="input"
                  onSelect={() => setDefault.mutate(device.id)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No input devices found.</p>
          )}
          <MicTest />

          {/* Per-application volume */}
          <SoundGroupHeading icon={Volume2}>App volume</SoundGroupHeading>
          {appStreams.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {appStreams.map((stream) => (
                <AudioStreamRow
                  key={stream.id}
                  stream={stream}
                  onVolume={(percent) => setNodeVolume.mutate({ id: stream.id, percent })}
                  onMuted={(m) => setNodeMuted.mutate({ id: stream.id, muted: m })}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing is playing. Apps appear here with their own volume while
              they play audio.
            </p>
          )}
        </div>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * The system's keyboard layout (window.keyboard), which Din's own windows and
 * the native Linux apps it runs both type with. Picking one from
 * xkeyboard-config's list changes the system's, where Din can (DinOS, GNOME).
 */
function KeyboardSection() {
  const bridge = getKeyboardBridge();
  const status = useKeyboardStatus();
  const layouts = useKeyboardLayouts();
  const setLayout = useSetKeyboardLayout();
  const restart = useRestartForKeyboardLayout();
  const [query, setQuery] = useState('');
  const selectedRef = useRef<HTMLButtonElement>(null);

  // While a change is in flight, show the requested choice.
  const selected = setLayout.isPending ? setLayout.variables : status.data?.layout ?? null;
  const selectedKey = selected ? layoutKey(selected) : null;

  const filtered = useMemo(() => {
    const all = layouts.data ?? [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;
    return all.filter((entry) => {
      const haystack = `${entry.name} ${entry.layout} ${entry.variant}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [layouts.data, query]);

  // Bring the system's layout into view when the list first appears.
  const showList = status.data?.canChange === true && Boolean(layouts.data);
  useEffect(() => {
    if (showList) selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showList]);

  if (!bridge) {
    return (
      <SectionShell title="Keyboard">
        <FallbackCard icon={Keyboard}>
          Keyboard layouts need the Din desktop shell; they aren't available in
          a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  if (status.isLoading) {
    return (
      <SectionShell title="Keyboard">
        <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3" aria-hidden>
          <Skeleton className="size-4 bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32 bg-foreground/10" />
            <Skeleton className="h-3 w-56 bg-foreground/10" />
          </div>
        </div>
      </SectionShell>
    );
  }

  if (status.isError || !status.data) {
    return (
      <SectionShell title="Keyboard">
        <FallbackCard>Could not read the keyboard layout.</FallbackCard>
      </SectionShell>
    );
  }

  const { layout, canChange, restartNeeded } = status.data;

  return (
    <SectionShell title="Keyboard">
      <div className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
        <Keyboard className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm text-foreground">{layout.name}</p>
          <p className="text-xs text-muted-foreground">
            {canChange
              ? 'The layout everything on this computer types with.'
              : 'Din uses your system’s layout. Change it in your desktop’s keyboard settings.'}
          </p>
        </div>
      </div>

      {restartNeeded && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Restart Din to finish switching</p>
            <p className="text-xs text-muted-foreground">
              Apps already use {layout.name}; Din’s own windows will after a restart. Open apps close.
            </p>
          </div>
          <Button size="sm" disabled={restart.isPending} onClick={() => restart.mutate()}>
            {restart.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Restart Din
          </Button>
        </div>
      )}

      {canChange && (
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search layouts"
              aria-label="Search keyboard layouts"
              className="pl-8"
            />
          </div>

          {layouts.isLoading ? (
            <div className="flex flex-col gap-1" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full bg-foreground/10" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <FallbackCard>
              {layouts.data?.length
                ? 'No layouts match your search.'
                : 'No keyboard layouts were found. Install xkeyboard-config to choose one.'}
            </FallbackCard>
          ) : (
            <div
              role="radiogroup"
              aria-label="Keyboard layout"
              className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-md border bg-muted/20 p-1"
            >
              {filtered.map((entry) => {
                const key = layoutKey(entry);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    ref={active ? selectedRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      if (!active) setLayout.mutate({ layout: entry.layout, variant: entry.variant });
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-2 py-1.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/10' : 'hover:bg-foreground/5',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-full border',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/50',
                      )}
                      aria-hidden
                    >
                      {active && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.name}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {entry.variant ? `${entry.layout}(${entry.variant})` : entry.layout}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {setLayout.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setLayout.error instanceof Error
            ? setLayout.error.message
            : 'Could not change the keyboard layout.'}
        </p>
      )}

      {restart.isError && (
        <p role="alert" className="text-sm text-destructive">
          {restart.error instanceof Error ? restart.error.message : 'Could not restart Din.'}
        </p>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Date & Time
// ---------------------------------------------------------------------------

/**
 * The system's time zone and clock, through `window.datetime` (changed on
 * DinOS, shown elsewhere), and how Din's clocks show the time. The latter is
 * this computer's own (AppConfig, kept local) and works in a plain browser
 * too; the boot and lock screens follow its 12/24-hour choice
 * (BootScreenSync).
 */
function DateTimeSection() {
  const bridge = getDateTimeBridge();

  return (
    <SectionShell title="Date & Time">
      <DateTimeNow />
      {bridge ? (
        <SystemDateTime />
      ) : (
        <p className="text-sm text-muted-foreground">
          Din uses this computer’s time zone,{' '}
          {describeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).city}. Setting the
          time and time zone needs the Din desktop shell.
        </p>
      )}
      <ClockOptions />
    </SectionShell>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-sm font-medium text-muted-foreground">{children}</h3>;
}

/** The time and date right now. Its own component so only it re-renders every second. */
function DateTimeNow() {
  const now = useClock();
  const { config } = useAppContext();

  return (
    <div className="flex items-center gap-4 rounded-xl border bg-muted/20 p-4">
      <Clock className="size-8 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {now.toLocaleTimeString([], timeFormatOptions(config.clockFormat, true))}
        </p>
        <p className="text-sm text-muted-foreground">
          {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </p>
      </div>
    </div>
  );
}

function SystemDateTime() {
  const status = useDateTimeStatus();
  const setAutomatic = useSetAutomaticTime();

  if (status.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-16 w-full bg-foreground/10" />
        <Skeleton className="h-16 w-full bg-foreground/10" />
      </div>
    );
  }

  if (status.isError || !status.data) {
    return <FallbackCard>Could not read the date and time.</FallbackCard>;
  }

  const { timeZone, automatic, synchronized, canChange, canAutomatic } = status.data;
  // While a change is in flight, show the requested choice.
  const isAutomatic = setAutomatic.isPending ? setAutomatic.variables : automatic;

  return (
    <>
      <SubHeading>Time</SubHeading>
      <div className="flex flex-col gap-2">
        {isAutomatic !== null && (
          <SettingSwitchRow
            id="automatic-time"
            icon={Globe}
            label="Set time automatically"
            description={
              isAutomatic
                ? synchronized
                  ? 'Kept in step with internet time servers.'
                  : 'Waiting to reach an internet time server.'
                : 'The clock keeps the time you set.'
            }
            checked={isAutomatic}
            disabled={!canAutomatic || setAutomatic.isPending}
            onCheckedChange={(checked) => setAutomatic.mutate(checked)}
          />
        )}
        {canChange && isAutomatic === false && <ManualTimeForm />}
        {!canChange && (
          <p className="text-xs text-muted-foreground">
            Din uses your system’s date and time. Change them in your desktop’s settings.
          </p>
        )}
        {setAutomatic.isError && (
          <p role="alert" className="text-sm text-destructive">
            {setAutomatic.error instanceof Error
              ? setAutomatic.error.message
              : 'Could not change how the time is set.'}
          </p>
        )}
      </div>

      <SubHeading>Time zone</SubHeading>
      <TimeZonePicker current={timeZone} canChange={canChange} />
    </>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Setting the clock by hand, while it isn't set from the network. */
function ManualTimeForm() {
  const setTime = useSetTime();
  const [date, setDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  });
  const [time, setTimeOfDay] = useState(() => {
    const now = new Date();
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}(:\d{2})?$/.test(time);

  return (
    <form
      className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) setTime.mutate(`${date} ${time.length === 5 ? `${time}:00` : time}`);
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-date" className="text-xs text-muted-foreground">Date</Label>
          <Input
            id="manual-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-44"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-time" className="text-xs text-muted-foreground">Time</Label>
          <Input
            id="manual-time"
            type="time"
            value={time}
            onChange={(event) => setTimeOfDay(event.target.value)}
            className="w-36"
          />
        </div>
        <Button type="submit" size="sm" className="h-9" disabled={!valid || setTime.isPending}>
          {setTime.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
          Set date & time
        </Button>
      </div>
      {setTime.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setTime.error instanceof Error ? setTime.error.message : 'Could not set the date and time.'}
        </p>
      )}
    </form>
  );
}

function TimeZonePicker({ current, canChange }: { current: string; canChange: boolean }) {
  const zones = useTimeZones();
  const setZone = useSetTimeZone();
  const [query, setQuery] = useState('');
  const selectedRef = useRef<HTMLButtonElement>(null);

  // While a change is in flight, show the requested choice.
  const selected = setZone.isPending ? setZone.variables : current;
  const { city, region } = describeZone(current);
  const longName = zoneLongName(current);
  const offset = zoneOffset(current);

  const entries = useMemo(() => {
    const at = new Date();
    return (zones.data ?? []).map((zone) => ({ zone, ...describeZone(zone), offset: zoneOffset(zone, at) }));
  }, [zones.data]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((entry) => {
      const haystack = `${entry.city} ${entry.region} ${entry.zone} ${entry.offset}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [entries, query]);

  // Bring the system's zone into view when the list first appears.
  const showList = canChange && entries.length > 0;
  useEffect(() => {
    if (showList) selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showList]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
        <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm text-foreground">
            {city}
            {region && <span className="text-muted-foreground"> · {region}</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {[longName, offset].filter(Boolean).join(', ')}
          </p>
        </div>
      </div>

      {canChange && (
        <>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search cities and regions"
              aria-label="Search time zones"
              className="pl-8"
            />
          </div>

          {zones.isLoading ? (
            <div className="flex flex-col gap-1" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full bg-foreground/10" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <FallbackCard>
              {entries.length ? 'No time zones match your search.' : 'No time zones were found.'}
            </FallbackCard>
          ) : (
            <div
              role="radiogroup"
              aria-label="Time zone"
              className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-md border bg-muted/20 p-1"
            >
              {filtered.map((entry) => {
                const active = entry.zone === selected;
                return (
                  <button
                    key={entry.zone}
                    ref={active ? selectedRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      if (!active) setZone.mutate(entry.zone);
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-2 py-1.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/10' : 'hover:bg-foreground/5',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-full border',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/50',
                      )}
                      aria-hidden
                    >
                      {active && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {entry.city}
                      {entry.region && <span className="text-muted-foreground"> · {entry.region}</span>}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{entry.offset}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {setZone.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setZone.error instanceof Error ? setZone.error.message : 'Could not change the time zone.'}
        </p>
      )}
    </div>
  );
}

/** A time of day to show each clock format with. */
const SAMPLE_TIME = new Date(2000, 0, 1, 13, 30);

/** How Din's clocks show the time. */
function ClockOptions() {
  const { config, updateConfig } = useAppContext();
  const formats: { value: ClockFormat; name: string }[] = [
    { value: 'auto', name: 'Automatic' },
    { value: '12', name: '12-hour' },
    { value: '24', name: '24-hour' },
  ];

  return (
    <>
      <SubHeading>Clock</SubHeading>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Clock format">
          {formats.map((option) => {
            const active = config.clockFormat === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => updateConfig((current) => ({ ...current, clockFormat: option.value }))}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-xl border p-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                <span className="text-lg font-semibold tabular-nums">
                  {SAMPLE_TIME.toLocaleTimeString([], timeFormatOptions(option.value))}
                </span>
                <span className="text-xs">{option.name}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Automatic follows your language’s custom. The menu bar, boot screen, and lock screen all use it.
        </p>
        <SettingSwitchRow
          id="clock-show-date"
          label="Show the date in the menu bar"
          description="The weekday and date, beside the time."
          checked={config.clockShowDate}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, clockShowDate: checked }))}
        />
        <SettingSwitchRow
          id="clock-show-seconds"
          label="Show seconds in the menu bar"
          description="The clock ticks every second."
          checked={config.clockShowSeconds}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, clockShowSeconds: checked }))}
        />
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Notification preferences. Do Not Disturb applies to every notification and
 * stays on this computer. The rest is about Nostr: which interactions
 * (mentions, comments, reposts, reactions, zaps) surface as notifications,
 * whether to gate them to people you follow, and whether they pop up. Those
 * are stored through Din's encrypted app-data layer, so they roam across
 * devices. The notification center and the popups read the same settings.
 */
function NotificationsSection() {
  const { user } = useCurrentUser();
  const { preferences, setPreferences } = useNotificationSettings();
  const { doNotDisturb } = useNotificationCenter();

  const dndRow = (
    <SettingSwitchRow
      id="notif-dnd"
      icon={BellOff}
      label="Do Not Disturb"
      description="Keep notifications in the list without popping them up. Urgent ones still show."
      checked={doNotDisturb}
      onCheckedChange={setDoNotDisturb}
    />
  );

  if (!user) {
    return (
      <SectionShell title="Notifications">
        <div className="flex flex-col gap-4">
          {dndRow}
          <FallbackCard icon={Bell}>
            Log in with your Nostr account to also be notified when people
            mention, react to, repost, comment on, or zap you.
          </FallbackCard>
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Notifications">
      <div className="flex flex-col gap-4">
        {dndRow}
        <div className="border-t border-border/60 pt-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Nostr</h3>
          <div className="flex flex-col gap-2">
            <SettingSwitchRow
              id="notif-osd"
              label="On-screen alerts"
              description="Pop up new mentions, reactions, reposts, comments and zaps in the corner."
              checked={preferences.osd}
              onCheckedChange={(checked) => setPreferences({ osd: checked })}
            />
            <SettingSwitchRow
              id="notif-only-following"
              label="Only from people you follow"
              description="Ignore interactions from accounts you don't follow."
              checked={preferences.onlyFollowing}
              onCheckedChange={(checked) => setPreferences({ onlyFollowing: checked })}
            />
          </div>
        </div>

        <div className="border-t border-border/60 pt-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Notify me about</h3>
          <div className="flex flex-col gap-2">
            {NOTIFICATION_CATEGORY_META.map((category) => (
              <SettingSwitchRow
                key={category.id}
                id={`notif-${category.id}`}
                icon={category.icon}
                label={category.label}
                description={category.description}
                checked={preferences[category.id]}
                onCheckedChange={(checked) =>
                  setPreferences({ [category.id]: checked } as Partial<NotificationPreferences>)
                }
              />
            ))}
          </div>
        </div>
      </div>
    </SectionShell>
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
// Password
// ---------------------------------------------------------------------------

/**
 * The computer's password (window.lock): one password that unlocks the disk
 * at boot, the lock screen, sudo, and the Nostr keys in nostrd, so it changes
 * everywhere at once. Only a computer that has one (an encrypted DinOS
 * install) shows the form.
 */
function PasswordSection() {
  const bridge = getLockBridge();
  const { data: available, isLoading } = useQuery({
    queryKey: ['lock', 'available'],
    queryFn: () => bridge?.available() ?? false,
    enabled: !!bridge,
    staleTime: 60_000,
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  if (!bridge || (!isLoading && !available)) {
    return (
      <SectionShell title="Password">
        <FallbackCard icon={KeyRound}>
          {bridge
            ? 'This computer has no password. DinOS installed with an encrypted disk has one, which unlocks the disk, the lock screen and your Nostr keys.'
            : 'The computer’s password is for DinOS. Elsewhere, it’s set where the system’s own settings are.'}
        </FallbackCard>
      </SectionShell>
    );
  }

  const tooShort = next.length > 0 && next.length < 8;
  const notAscii = /[^\x20-\x7e]/.test(next);
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = current.length > 0 && next.length >= 8 && !notAscii && confirm === next && !saving;

  const save = () => {
    setSaving(true);
    setError(null);
    setDone(false);
    bridge
      .changePassword(current, next)
      .then(() => {
        setCurrent('');
        setNext('');
        setConfirm('');
        setDone(true);
      })
      .catch((e: unknown) => setError(cleanLockError(e)))
      .finally(() => setSaving(false));
  };

  return (
    <SectionShell title="Password">
      <p className="text-sm text-muted-foreground">
        One password unlocks this computer: the disk when it starts, the lock screen, and the
        Nostr accounts kept on it. Changing it here changes it everywhere.
      </p>
      <form
        className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-current">Current password</Label>
          <Input
            id="password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-new">New password</Label>
          <Input
            id="password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            aria-invalid={tooShort || notAscii || undefined}
            aria-describedby="password-new-hint"
            onChange={(e) => setNext(e.target.value)}
          />
          <p id="password-new-hint" className="text-xs text-muted-foreground">
            {notAscii
              ? 'Use only letters, numbers, spaces and symbols on a standard keyboard: it’s typed before anything else is running.'
              : 'At least 8 characters.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-confirm">Type it again</Label>
          <Input
            id="password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            aria-invalid={mismatch || undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="text-xs text-destructive">The passwords don’t match.</p>}
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p className="text-sm text-foreground" role="status">
            The password is changed.
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!ready}>
            {saving && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
            Change password
          </Button>
        </div>
      </form>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * DinOS's version, and its updates (window.updater). The system looks for
 * them by itself and stages what it finds for the next boot, so this mostly
 * reports, and offers the restart.
 */
function UpdatesSection() {
  const bridge = getUpdaterBridge();
  const state = useUpdateState();

  if (!bridge || (state && !state.available)) {
    return (
      <SectionShell title="Updates">
        <FallbackCard icon={CircleArrowUp}>
          Updates are for DinOS. Elsewhere, Din is updated along with the system
          it runs on.
        </FallbackCard>
      </SectionShell>
    );
  }

  if (!state) {
    return (
      <SectionShell title="Updates">
        <div className="space-y-2 rounded-xl border border-border/60 p-4" aria-hidden>
          <Skeleton className="h-4 w-32 bg-foreground/10" />
          <Skeleton className="h-3 w-56 bg-foreground/10" />
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Updates">
      <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-background/40 p-4">
        <p className="text-sm font-medium text-foreground">
          DinOS {state.current ?? '(unknown version)'}
        </p>
        <p className="text-xs text-muted-foreground">
          {state.live
            ? 'Running from a USB stick. Install DinOS to get updates.'
            : 'Updates are downloaded by themselves and installed when you restart.'}
        </p>
      </div>
      {!state.live && <UpdateStatus state={state} />}
    </SectionShell>
  );
}

function UpdateStatus({ state }: { state: UpdateState }) {
  const [error, setError] = useState<string | null>(null);
  const [rebooting, setRebooting] = useState(false);
  const busy = state.phase === 'checking' || state.phase === 'updating';

  const check = () => {
    setError(null);
    getUpdaterBridge()?.check().catch((e: unknown) => setError(cleanInstallerError(e)));
  };

  const reboot = () => {
    setRebooting(true);
    setError(null);
    getUpdaterBridge()
      ?.reboot()
      .catch((e: unknown) => {
        setRebooting(false);
        setError(cleanInstallerError(e));
      });
  };

  return (
    <div className="flex flex-col gap-3">
      {state.phase === 'updating' && state.updatingTo ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {state.step ? UPDATE_STEP_LABELS[state.step] : 'Getting'} DinOS {state.updatingTo}
            </span>
            {state.step && state.step !== 'install' && (
              <span className="tabular-nums text-muted-foreground">{state.percent}%</span>
            )}
          </div>
          {state.step && state.step !== 'install' && (
            <Progress value={state.percent} aria-label="Update progress" />
          )}
        </div>
      ) : state.staged ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">DinOS {state.staged} is ready</p>
            <p className="text-xs text-muted-foreground">Restart to finish updating.</p>
          </div>
          <Button size="sm" disabled={rebooting} onClick={reboot}>
            {rebooting && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Restart now
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {state.phase === 'checking'
            ? 'Looking for updates…'
            : state.phase === 'failed'
              ? state.error ?? 'The last check didn’t finish.'
              : state.checkedAt
                ? `${state.staged ? 'Checked' : 'Up to date. Checked'} ${new Date(state.checkedAt).toLocaleString()}.`
                : 'Not checked yet.'}
        </p>
        <Button variant="outline" size="sm" disabled={busy} onClick={check}>
          <RotateCw className={cn('size-4', state.phase === 'checking' && 'motion-safe:animate-spin')} aria-hidden />
          Check now
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
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

/** A labelled toggle row matching the rest of Settings' switch controls. */
function SettingSwitchRow({
  id,
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon?: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer text-sm">
            {label}
          </Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
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
