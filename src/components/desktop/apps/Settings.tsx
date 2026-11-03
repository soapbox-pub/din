import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Airplay,
  BatteryFull,
  BellOff,
  Bluetooth,
  Bomb,
  Bot,
  Check,
  CircleArrowUp,
  Clock,
  Cpu,
  FolderOpen,
  GitBranch,
  Link2,
  CloudOff,
  Gauge,
  Globe,
  Headphones,
  KeyRound,
  Keyboard,
  Laptop,
  LayoutDashboard,
  Loader2,
  Mic,
  MicOff,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  Play,
  Power,
  Plug,
  Plus,
  RotateCw,
  Search,
  Sun,
  TriangleAlert,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  ZoomIn,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { findMatches, parseQuery } from '@/lib/settingsSearch';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { AppComponentProps } from '@/lib/apps';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { BluetoothDeviceIcon } from '@/components/desktop/BluetoothIndicator';
import {
  cleanBluetoothBridgeError,
  describeDevice,
  getBluetoothBridge,
  sortDevices,
} from '@/lib/bluetooth';
import type { BluetoothDevice } from '@/lib/bluetooth';
import { useBluetoothActions, useBluetoothDiscovery, useBluetoothState } from '@/hooks/useBluetooth';
import {
  cleanDisplayError,
  formatMode,
  formatRefresh,
  friendlyOutputName,
  getDisplayBridge,
  isInternalOutput,
  preferredMode,
  refreshRates,
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
import type { AudioDevice, AudioPort, AudioStream } from '@/lib/audio';
import {
  useAudioDeviceMutations,
  useAudioDevices,
  useAudioInputMutations,
  useAudioInputStatus,
  useAudioMutations,
  useAudioStatus,
  useAudioStreams,
} from '@/hooks/useAudio';
import { VolumeGlyph, VolumeSlider } from '@/components/desktop/VolumeIndicator';
import { getKeyboardBridge, layoutKey } from '@/lib/keyboard';
import { cleanLockError, getLockBridge, type SudoMode } from '@/lib/lock';
import { AdminPasswordDialog } from '@/components/desktop/AdminPrompt';
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
import {
  brightnessText,
  getBrightnessBridge,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  nightLightCaption,
} from '@/lib/brightness';
import type { NightLightSchedule, NightLightState } from '@/lib/brightness';
import { useBrightnessMutations, useBrightnessStatus } from '@/hooks/useBrightness';
import { BrightnessGlyph, BrightnessSlider } from '@/components/desktop/BrightnessIndicator';
import { Slider } from '@/components/ui/slider';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppDataSyncStatus } from '@/hooks/useAppData';
import { setDoNotDisturb, useNotificationCenter } from '@/lib/notificationCenter';
import { NotificationSitesList } from '@/components/desktop/apps/NotificationSitesList';
import { PushServiceSetting } from '@/components/desktop/apps/PushServiceSetting';
import { useToast } from '@/hooks/useToast';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import { getIconThemeBridge } from '@/lib/iconTheme';
import { IconThemePicker } from '@/components/desktop/apps/IconThemePicker';
import { AppIcon } from '@/components/desktop/AppIcon';
import type { SystemCursorTheme } from '@/lib/systemCursor';
import {
  useImportSystemCursor,
  useRemoveSystemCursor,
  useSetSystemCursor,
  useSystemCursorPreview,
  useSystemCursorStatus,
  useSystemCursorThemes,
} from '@/hooks/useSystemCursor';
import { RelayListManager } from '@/components/RelayListManager';
import { BlossomServerManager } from '@/components/BlossomServerManager';
import { NostrLinkSettings } from '@/components/desktop/NostrLinkSettings';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WindowEffectPicker } from '@/components/desktop/apps/WindowEffectPicker';
import { CursorEffectsSettings } from '@/components/desktop/apps/CursorEffectPicker';
import { PowerModeSettings } from '@/components/desktop/apps/PowerModeSettings';
import { PACKAGE_PREFIX, forgetPackage, forgetThumbnails } from '@/lib/cursorEffects';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  DEFAULT_UPDATE_BRANCH,
  DEFAULT_UPDATE_URL,
  getUpdaterBridge,
  shortRevision,
  UPDATE_STEP_LABELS,
} from '@/lib/updater';
import type { UpdateState } from '@/lib/updater';
import { cleanInstallerError } from '@/lib/installer';
import { useFixUpdateWithAssistant, useUpdateState } from '@/hooks/useUpdater';
import { getFirmwareBridge } from '@/lib/firmware';
import type { FirmwareState, FirmwareUpdate } from '@/lib/firmware';
import { useFirmwareState } from '@/hooks/useFirmware';
import { ConnectedAppsSection } from '@/components/desktop/apps/ConnectedAppsSection';
import { AssistantSettingsSection } from '@/components/desktop/apps/AssistantSettingsSection';
import { WifiSettingsSection } from '@/components/desktop/apps/WifiSettingsSection';
import { PrintersSettingsSection } from '@/components/desktop/apps/PrintersSettingsSection';
import { LoginSessionSection } from '@/components/desktop/apps/LoginSessionSection';
import { ThemeSettings } from '@/components/desktop/apps/ThemeSettings';
import { DockPreview } from '@/components/desktop/Dock';
import { DOCK_STYLES } from '@/lib/dockStyles';
import { WM_BINDING_HELP } from '@/lib/wmBindings';
import { SECTIONS, matchingSections } from '@/lib/settingsSections';
import type { SectionId } from '@/lib/settingsSections';

/**
 * Settings - system preferences for the shell.
 *
 * The Wi-Fi section drives NetworkManager through `window.dinos.wifi` (Electron
 * preload + nmcli in the main process): toggle the radio, scan, join,
 * disconnect and forget networks. Outside the Electron shell it renders an
 * explanatory fallback. The Bluetooth section pairs, connects and forgets
 * devices through `window.dinos.bluetooth` (BlueZ over D-Bus). The Display section arranges the monitors through
 * `window.dinos.display` (wlr-randr under din-shell, xrandr on bare X11), falling back
 * where neither can manage them. Battery & Power reads the battery through
 * `window.dinos.power` (/sys/class/power_supply), leaving it out on machines with
 * no battery, and switches the system power profile through the same bridge
 * (net.hadess.PowerProfiles over D-Bus: power-profiles-daemon / tuned-ppd),
 * falling back where no such daemon runs. The Sound
 * section drives the default sink's volume/mute through `window.dinos.audio`
 * (wpctl/PipeWire), including outputs on a sound card's inactive profile.
 * Keyboard picks the layout native Linux apps type with
 * through `window.dinos.keyboard`. Printers lists the printers CUPS can reach, sets
 * the default, and shows the queue (PrintersSettingsSection). Date & Time sets the time zone and clock
 * through `window.dinos.datetime`, and how Din's clocks show the time. Password changes the computer's one password
 * (disk, lock screen, Nostr keys) through `window.dinos.lock`. Nostr & Storage manages Din's encrypted app-data
 * sync, NIP-65 relay list, and Blossom server list. Connected apps lists the
 * sites and apps that may use the account through Din's signer
 * (ConnectedAppsSection). Assistant turns OpenCode, the AI agent, on or off
 * and connects its providers (AssistantSettingsSection). Appearance switches the
 * shell theme between light, dark and a custom one of colors, fonts and a
 * background picture, synced with the profile theme or kept on this computer
 * (ThemeSettings), and toggles desktop effects like wobbly windows.
 * Windows turns Hyprland-style tiling on or off, sets its gaps, and lists the
 * Super-key shortcuts for windows and workspaces (src/lib/wmBindings.ts).
 * Dock turns its magnification on or off and picks its backdrop, as its own
 * right-click menu does.
 * Developers holds debug utilities such as intentionally crashing the shell
 * to test the error boundary. About shows Din's logo and DinOS's version, and
 * the update it's building through `window.dinos.updater`, offers the restart
 * that finishes one and the repository it's built from, and firmware updates
 * through `window.dinos.firmware`; elsewhere on Linux, it puts Din on the login
 * screen (LoginSessionSection).
 */
const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/** Extract a valid SectionId from launch params, if present. */
function paramSection(params: AppComponentProps['params']): SectionId | undefined {
  const s = params?.section;
  // Updates used to be a section of its own.
  if (s === 'updates') return 'about';
  // So did Battery, apart from Power.
  if (s === 'battery') return 'power';
  return typeof s === 'string' && SECTION_IDS.has(s) ? (s as SectionId) : undefined;
}

const SIDEBAR_WIDTH_KEY = 'din.settings.sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 208;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 360;

const clampSidebarWidth = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));

function loadSidebarWidth(): number {
  const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return width ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

export function Settings({ params, windowId }: AppComponentProps) {
  useOwnWindowHeader();
  const [section, setSection] = useState<SectionId>(
    () => paramSection(params) ?? 'wifi',
  );
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  useEffect(() => localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);
  // Search: once the query has two letters or digits, the pane shows every
  // matching section, one after the other, with the matches highlighted.
  // Only matching sections mount, since opening one can start work (a
  // Bluetooth scan, say).
  const [query, setQuery] = useState('');

  // The window is reused for this single-instance app, so a re-launch (e.g.
  // from a different tray indicator) updates params without remounting.
  // Follow the requested section on each launch, even one asking for the
  // section it asked for last time.
  const [launchParams, setLaunchParams] = useState(params);
  if (params !== launchParams) {
    setLaunchParams(params);
    const requested = paramSection(params);
    if (requested) {
      setSection(requested);
      setQuery('');
    }
  }

  const debouncedQuery = useDebouncedValue(query, 150);
  const terms = useMemo(() => parseQuery(query ? debouncedQuery : ''), [query, debouncedQuery]);
  const searching = terms.join('').length >= 2;
  const results = useMemo(
    () => (searching ? matchingSections(terms) : []),
    [searching, terms],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useSearchHighlight(paneRef, searching ? terms : NO_TERMS);

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  const renderSection = (id: SectionId) =>
    id === 'wifi' ? (
      <WifiSettingsSection
        join={typeof params?.join === 'string' ? { ssid: params.join, nonce: params.nonce } : undefined}
      />
    ) : id === 'bluetooth' ? (
      <BluetoothSection />
    ) : id === 'display' ? (
      <DisplaySection />
    ) : id === 'brightness' ? (
      <BrightnessSection />
    ) : id === 'power' ? (
      <PowerSection />
    ) : id === 'sound' ? (
      <SoundSection />
    ) : id === 'keyboard' ? (
      <KeyboardSection />
    ) : id === 'printers' ? (
      <PrintersSettingsSection />
    ) : id === 'datetime' ? (
      <DateTimeSection />
    ) : id === 'password' ? (
      <PasswordSection />
    ) : id === 'notifications' ? (
      <NotificationsSection />
    ) : id === 'nostr' ? (
      <NostrStorageSection />
    ) : id === 'connected' ? (
      <ConnectedAppsSection
        nostrconnect={typeof params?.nostrconnect === 'string' ? params.nostrconnect : undefined}
        nonce={params?.nonce}
      />
    ) : id === 'assistant' ? (
      <AssistantSettingsSection />
    ) : id === 'appearance' ? (
      <AppearanceSection windowId={windowId} />
    ) : id === 'windows' ? (
      <WindowsSection />
    ) : id === 'dock' ? (
      <DockSection />
    ) : id === 'developers' ? (
      <DevelopersSection />
    ) : (
      <AboutSection />
    );

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSidebarWidth(clampSidebarWidth(startWidth + ev.clientX - startX));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <div className="flex h-full w-full" onKeyDownCapture={onKeyDownCapture}>
      {/* Section sidebar */}
      <div
        style={{ width: sidebarWidth }}
        className="flex shrink-0 flex-col gap-2 border-r border-border/60 bg-muted/30 px-2 pb-2"
      >
        {/* The window's title bar runs across the sidebar's top, so it drags the window too. */}
        <WindowDragRegion className="-mx-2 -mb-2 flex h-9 shrink-0 items-center gap-2 px-3">
          <AppIcon icon="/icons/apps/settings.png" className="size-4 shrink-0 object-contain" />
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
            Settings
          </span>
        </WindowDragRegion>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-8 pr-2 pl-8 text-sm [&:placeholder-shown::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <nav aria-label="Settings sections" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {SECTIONS.map((s, i) => {
            const current = searching ? results.includes(s) : section === s.id;
            return (
              <Fragment key={s.id}>
                {s.group !== SECTIONS[i - 1]?.group && (
                  <h3
                    className={cn(
                      'px-2 pb-1 text-xs font-medium text-muted-foreground',
                      i > 0 && 'mt-3',
                    )}
                  >
                    {s.group}
                  </h3>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSection(s.id);
                    setQuery('');
                  }}
                  aria-current={!searching && section === s.id ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    current
                      ? 'bg-foreground/15 text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
                    searching && !current && 'opacity-50',
                  )}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{s.name}</span>
                </button>
              </Fragment>
            );
          })}
        </nav>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setSidebarWidth((w) => clampSidebarWidth(w - 16));
          else if (e.key === 'ArrowRight') setSidebarWidth((w) => clampSidebarWidth(w + 16));
          else return;
          e.preventDefault();
        }}
        className="z-30 -mx-1 w-2 shrink-0 cursor-col-resize touch-none hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none"
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <WindowDragRegion className="flex h-9 shrink-0 items-center justify-end pl-2 pr-3">
          <WindowControls />
        </WindowDragRegion>
        <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto">
          {!searching ? (
            renderSection(section)
          ) : results.length > 0 ? (
            results.map((s) => (
              <div key={s.id} className="border-b border-border/40 last:border-b-0">
                {renderSection(s.id)}
              </div>
            ))
          ) : (
            <div className="mx-auto max-w-2xl p-4">
              <FallbackCard icon={Search}>No settings match “{query.trim()}”.</FallbackCard>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const NO_TERMS: string[] = [];
const SEARCH_HIGHLIGHT = 'settings-search';

/**
 * Highlights where `terms` occur in the text under `paneRef`, with the CSS
 * Custom Highlight API so the sections' DOM stays untouched, and keeps the
 * highlights current as sections load their content. Scrolls the first match
 * into view once per search.
 */
function useSearchHighlight(paneRef: React.RefObject<HTMLElement | null>, terms: string[]) {
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || terms.length === 0 || typeof Highlight === 'undefined' || !CSS.highlights) return;
    pane.scrollTop = 0;
    let scrolled = false;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (!text?.trim() || node.parentElement?.closest('style, script')) continue;
        for (const [start, end] of findMatches(text, terms)) {
          const range = new Range();
          range.setStart(node, start);
          range.setEnd(node, end);
          ranges.push(range);
        }
      }
      CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges));
      if (!scrolled && ranges.length > 0) {
        scrolled = true;
        const top = ranges[0].getBoundingClientRect().top - pane.getBoundingClientRect().top;
        if (top > pane.clientHeight - 32) pane.scrollTop += top - 48;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      CSS.highlights.delete(SEARCH_HIGHLIGHT);
    };
  }, [paneRef, terms]);
}

// ---------------------------------------------------------------------------
// Device lists
// ---------------------------------------------------------------------------

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
// Bluetooth
// ---------------------------------------------------------------------------

/**
 * The adapter's on/off switch, the paired devices, and the ones nearby to
 * pair with, via the Bluetooth bridge (window.dinos.bluetooth -> BlueZ). Looks for
 * devices while it's open and Bluetooth is on. Prompts that pairing needs
 * appear from BluetoothPromptHost, wherever the pairing started.
 */
function BluetoothSection() {
  const bridge = getBluetoothBridge();
  const status = useBluetoothState();
  const { setPowered, pair, connect, disconnect, forget } = useBluetoothActions();
  const [opError, setOpError] = useState<{ path: string; message: string } | null>(null);

  const data = status.data;
  const adapter = data?.adapter ?? null;
  const powered = adapter?.powered ?? false;
  useBluetoothDiscovery(powered);

  if (!bridge) {
    return (
      <SectionShell title="Bluetooth">
        <FallbackCard icon={Bluetooth}>
          Bluetooth settings need the Din desktop shell; they aren't available in
          a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const devices = sortDevices(data?.devices ?? []);
  const paired = devices.filter((d) => d.paired);
  const nearby = devices.filter((d) => !d.paired);

  const run = (path: string, action: typeof pair) => {
    setOpError(null);
    action.mutate(path, {
      onError: (error) => setOpError({ path, message: cleanBluetoothBridgeError(error) }),
    });
  };
  const rowProps = (device: BluetoothDevice) => ({
    device,
    error: opError?.path === device.path ? opError.message : null,
    onPair: () => run(device.path, pair),
    onConnect: () => run(device.path, connect),
    onDisconnect: () => run(device.path, disconnect),
    onForget: () => run(device.path, forget),
  });

  return (
    <SectionShell
      title="Bluetooth"
      actions={
        <Switch
          aria-label="Bluetooth"
          checked={powered}
          disabled={!adapter || setPowered.isPending}
          onCheckedChange={(on) => {
            setOpError(null);
            setPowered.mutate(on, {
              onError: (error) => setOpError({ path: '', message: cleanBluetoothBridgeError(error) }),
            });
          }}
        />
      }
    >
      {opError?.path === '' && (
        <p role="alert" className="text-xs text-destructive">
          {opError.message}
        </p>
      )}
      {status.isLoading ? (
        <NetworkListSkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read Bluetooth state: {cleanBluetoothBridgeError(status.error)}</FallbackCard>
      ) : !data?.available ? (
        <FallbackCard icon={Bluetooth}>
          The Bluetooth service isn't running on this system, so Bluetooth can't be
          managed here.
        </FallbackCard>
      ) : !adapter ? (
        <FallbackCard icon={Bluetooth}>No Bluetooth adapter was found on this computer.</FallbackCard>
      ) : !powered ? (
        <FallbackCard icon={Bluetooth}>Bluetooth is turned off.</FallbackCard>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Devices see this computer as “{adapter.name}”.
          </p>

          {paired.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>My devices</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="My devices">
                {paired.map((device) => (
                  <BluetoothDeviceRow key={device.path} {...rowProps(device)} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <SubHeading>Devices nearby</SubHeading>
              {adapter.discovering && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Searching" />
              )}
            </div>
            {nearby.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
                {adapter.discovering
                  ? 'Looking for devices… Put the one you want to pair in pairing mode.'
                  : 'No devices found nearby.'}
              </div>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Devices nearby">
                {nearby.map((device) => (
                  <BluetoothDeviceRow key={device.path} {...rowProps(device)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}

function BluetoothDeviceRow({
  device,
  error,
  onPair,
  onConnect,
  onDisconnect,
  onForget,
}: {
  device: BluetoothDevice;
  error: string | null;
  onPair: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onForget: () => void;
}) {
  const busy = device.busy !== null;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 px-3 py-2">
            <BluetoothDeviceIcon
              icon={device.icon}
              className={cn('size-5 shrink-0', device.connected ? 'text-primary' : 'text-muted-foreground')}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{device.name}</p>
              <p
                className={cn(
                  'flex items-center gap-1.5 truncate text-xs',
                  device.connected ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {busy && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
                {describeDevice(device)}
              </p>
            </div>

            {!device.paired ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={onPair}>
                Pair
              </Button>
            ) : device.connected ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={onDisconnect}>
                Disconnect
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={onConnect}>
                Connect
              </Button>
            )}
            {device.paired && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onForget}>
                Forget
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!device.paired ? (
            <ContextMenuItem disabled={busy} onSelect={onPair}>
              <Link2 aria-hidden />
              Pair
            </ContextMenuItem>
          ) : device.connected ? (
            <ContextMenuItem disabled={busy} onSelect={onDisconnect}>
              <Plug aria-hidden />
              Disconnect
            </ContextMenuItem>
          ) : (
            <ContextMenuItem disabled={busy} onSelect={onConnect}>
              <Plug aria-hidden />
              Connect
            </ContextMenuItem>
          )}
          {device.paired && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" disabled={busy} onSelect={onForget}>
                <Trash2 aria-hidden />
                Forget
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {error !== null && (
        <p role="alert" className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * A single output's slot in the editable draft layout the Display panel works
 * on: its chosen mode, position in the shared virtual screen, and on/off +
 * primary flags. `modes` is de-duplicated to unique resolutions; `allModes`
 * keeps every rate of each.
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
  /** Hz; 0 where the output doesn't say. */
  refresh: number;
  modes: DisplayMode[];
  allModes: DisplayMode[];
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
      refresh: output.current?.refresh ?? fallback?.refresh ?? 0,
      modes,
      allModes: output.modes,
    };
  });
}

/** A stable signature of the arrangement, for dirty-checking and re-seeding. */
function layoutSignature(drafts: DisplayDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => [d.name, d.enabled, d.primary, d.x, d.y, d.width, d.height, d.refresh]),
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
    ...(d.refresh > 0 && { refresh: d.refresh }),
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
 * page zoom (window.dinos.zoom preload bridge). Lives in AppConfig (persisted
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
 * The whole multi-output arrangement, via the display bridge (window.dinos.display:
 * wlr-randr under din-shell, xrandr on bare X11), where Din is the whole desktop:
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
  // A new resolution starts at its fastest rate.
  const setModeFor = (name: string, width: number, height: number) =>
    setDraft((ds) =>
      ds.map((d) => (d.name === name ? { ...d, width, height, refresh: refreshRates(d.allModes, width, height)[0] ?? 0 } : d)),
    );
  const setRefreshFor = (name: string, refresh: number) =>
    setDraft((ds) => ds.map((d) => (d.name === name ? { ...d, refresh } : d)));
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
      <DisplayArrange
        draft={draft}
        selected={selected}
        canDisable={enabledCount > 1}
        onSelect={setSelected}
        onMove={moveTo}
        onToggle={setEnabled}
        onPrimary={setPrimary}
      />

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
            onRefresh={setRefreshFor}
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
 * AirPlay receivers nearby: connect one as a separate display, which then
 * appears in the arrangement above, or switch it to mirroring. Hidden
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
  canDisable,
  onSelect,
  onMove,
  onToggle,
  onPrimary,
}: {
  draft: DisplayDraft[];
  selected: string | null;
  canDisable: boolean;
  onSelect: (name: string) => void;
  onMove: (name: string, x: number, y: number) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onPrimary: (name: string) => void;
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
    if (e.button !== 0 || scale === 0) return;
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
          <ContextMenu key={d.name}>
            <ContextMenuTrigger asChild>
              <button
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
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={d.primary} onSelect={() => onPrimary(d.name)}>
                <Monitor aria-hidden />
                Make primary
              </ContextMenuItem>
              <ContextMenuItem disabled={!canDisable} onSelect={() => onToggle(d.name, false)}>
                <Power aria-hidden />
                Turn off
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
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
  onRefresh,
}: {
  draft: DisplayDraft;
  canDisable: boolean;
  selected: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onPrimary: (name: string) => void;
  onMode: (name: string, width: number, height: number) => void;
  onRefresh: (name: string, refresh: number) => void;
}) {
  const d = draft;
  const Icon = d.internal ? Laptop : Monitor;
  const selectId = `resolution-${d.name}`;
  const refreshId = `refresh-${d.name}`;
  const currentValue = `${d.width}x${d.height}`;
  const rates = refreshRates(d.allModes, d.width, d.height);
  const selectClass = cn(
    'h-8 rounded-md border border-border/60 bg-background px-2 text-sm text-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'disabled:cursor-not-allowed disabled:opacity-60',
  );

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
              className={selectClass}
            >
              {d.modes.map((mode) => (
                <option key={`${mode.width}x${mode.height}`} value={`${mode.width}x${mode.height}`}>
                  {formatMode(mode.width, mode.height)}
                  {mode.preferred ? ' (native)' : ''}
                </option>
              ))}
            </select>
            {rates.length > 1 && (
              <>
                <Label htmlFor={refreshId} className="sr-only">
                  Refresh rate for {d.friendly}
                </Label>
                <select
                  id={refreshId}
                  value={String(rates.find((rate) => Math.abs(rate - d.refresh) < 0.01) ?? rates[0])}
                  onChange={(e) => onRefresh(d.name, Number(e.target.value))}
                  className={selectClass}
                >
                  {rates.map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {formatRefresh(rate)}
                    </option>
                  ))}
                </select>
              </>
            )}
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
// Battery & Power
// ---------------------------------------------------------------------------

/**
 * Battery state and the system power profile, both via the power bridge
 * (window.dinos.power). The battery comes from /sys/class/power_supply and is left
 * out on machines with none (desktops, the VM). The profile (power-saver /
 * balanced / performance) goes through net.hadess.PowerProfiles over D-Bus,
 * served by power-profiles-daemon or tuned-ppd, and falls back where no such
 * daemon is running.
 */
function PowerSection() {
  const bridge = getPowerBridge();
  const status = useBatteryStatus();
  const profiles = usePowerProfiles();

  if (!bridge) {
    return (
      <SectionShell title="Battery & Power">
        <FallbackCard icon={BatteryFull}>
          Battery status and power profiles need the Din desktop shell; they
          aren't available in a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

  const hasBattery = status.isLoading || status.isError || !!status.data?.available;

  return (
    <SectionShell
      title="Battery & Power"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          title="Refresh"
          disabled={!status.data?.available && !profiles.data?.available}
          onClick={() => {
            void status.refetch();
            void profiles.refetch();
          }}
        >
          <RotateCw
            className={cn('size-4', (status.isFetching || profiles.isFetching) && 'animate-spin')}
          />
        </Button>
      }
    >
      {hasBattery && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">Battery</h3>
          <BatteryPanel status={status} />
        </div>
      )}

      <div className={cn('space-y-3', hasBattery && 'border-t border-border/60 pt-4')}>
        <h3 className="text-sm font-medium text-foreground">Power mode</h3>
        <PowerProfilesPanel profiles={profiles} />
        {profiles.data?.profiles.includes('performance') && <GamePerformanceSwitch />}
      </div>
    </SectionShell>
  );
}

function GamePerformanceSwitch() {
  const { config, updateConfig } = useAppContext();
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
      <div className="min-w-0">
        <Label htmlFor="game-performance" className="cursor-pointer text-sm">
          Performance mode for games
        </Label>
        <p className="text-xs text-muted-foreground">
          While a game is in full screen, the computer runs in performance mode, and goes back to
          the mode it was in after.
        </p>
      </div>
      <Switch
        id="game-performance"
        checked={config.gamePerformance}
        onCheckedChange={(checked) => updateConfig((current) => ({ ...current, gamePerformance: checked }))}
      />
    </div>
  );
}

function BatteryPanel({ status }: { status: ReturnType<typeof useBatteryStatus> }) {
  const data = status.data;
  const summary = data ? summarizePower(data) : null;
  const critical =
    summary !== null &&
    !summary.charging &&
    summary.percent !== null &&
    summary.percent <= 15;

  return (
    <>
      {status.isLoading ? (
        <BatterySkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read battery state.</FallbackCard>
      ) : !data?.available ? null : (
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
    </>
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

function PowerProfilesPanel({ profiles }: { profiles: ReturnType<typeof usePowerProfiles> }) {
  const setProfile = useSetPowerProfile();

  const data = profiles.data;
  // While a switch is in flight, show the requested profile as selected.
  const selected = setProfile.isPending ? setProfile.variables : data?.active;

  return (
    <>
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
    </>
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
 * (window.dinos.brightness). Backlight rides on brightnessctl (/sys/class/backlight);
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
                    nightLight.active ? 'text-foreground/90' : 'text-muted-foreground',
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
              <>
                <NightLightSchedulePicker nightLight={nightLight} />
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
              </>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
}

const NIGHT_LIGHT_SCHEDULES: { value: NightLightSchedule; name: string }[] = [
  { value: 'sunset', name: 'Sunset to sunrise' },
  { value: 'custom', name: 'Custom hours' },
  { value: 'always', name: 'Always on' },
];

/** The hours "Sunset to sunrise" keeps where the time zone has no coordinates. */
const FALLBACK_NIGHT = { from: new Date(2000, 0, 1, 20, 0), to: new Date(2000, 0, 1, 7, 0) };

/** When night light runs, and what it's doing now. */
function NightLightSchedulePicker({ nightLight }: { nightLight: NightLightState }) {
  const { config } = useAppContext();
  const { setSchedule } = useBrightnessMutations();
  const timeOptions = timeFormatOptions(config.clockFormat);

  // Local copies so a half-typed time doesn't get overwritten by a poll.
  const [from, setFrom] = useState(nightLight.from);
  const [to, setTo] = useState(nightLight.to);
  const [lastSaved, setLastSaved] = useState(`${nightLight.from}-${nightLight.to}`);
  if (`${nightLight.from}-${nightLight.to}` !== lastSaved) {
    setLastSaved(`${nightLight.from}-${nightLight.to}`);
    setFrom(nightLight.from);
    setTo(nightLight.to);
  }

  const save = (change: Partial<{ schedule: NightLightSchedule; from: string; to: string }>) =>
    setSchedule.mutate({ schedule: nightLight.schedule, from, to, ...change });

  const caption = nightLightCaption(nightLight, timeOptions);
  let description: string;
  if (nightLight.schedule === 'always') {
    description = 'The screen stays warm until you turn Night Light off.';
  } else if (nightLight.schedule === 'custom') {
    description = 'Night Light turns on and off at these times every day.';
  } else if (nightLight.place) {
    description = `Follows sunset and sunrise in ${describeZone(nightLight.place).city}, from your time zone.`;
  } else {
    description = `Din can’t place your time zone, so Night Light runs from ${FALLBACK_NIGHT.from.toLocaleTimeString([], timeOptions)} to ${FALLBACK_NIGHT.to.toLocaleTimeString([], timeOptions)}.`;
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Night Light schedule">
        {NIGHT_LIGHT_SCHEDULES.map((option) => {
          const checked = nightLight.schedule === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => save({ schedule: option.value })}
              className={cn(
                'rounded-lg border px-3 py-2 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                checked
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              {option.name}
            </button>
          );
        })}
      </div>

      {nightLight.schedule === 'custom' && (
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="night-light-from" className="text-sm">
            From
          </Label>
          <Input
            id="night-light-from"
            type="time"
            value={from}
            className="w-32"
            onChange={(e) => {
              setFrom(e.target.value);
              if (e.target.value) save({ from: e.target.value });
            }}
          />
          <Label htmlFor="night-light-to" className="text-sm">
            to
          </Label>
          <Input
            id="night-light-to"
            type="time"
            value={to}
            className="w-32"
            onChange={(e) => {
              setTo(e.target.value);
              if (e.target.value) save({ to: e.target.value });
            }}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {description}
        {caption && <> {caption}.</>}
      </p>

      {setSchedule.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t change the schedule.
        </p>
      )}
    </div>
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
  const Icon = /head(set|phone)/.test(device.icon ?? '') ? Headphones : kind === 'input' ? Mic : Volume2;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
            <span className="min-w-0">
              <span className="block truncate text-sm">{device.name}</span>
              {device.callQuality && (
                <span className="block truncate text-xs text-muted-foreground">
                  Call quality while an app uses the mic
                </span>
              )}
            </span>
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={device.isDefault} onSelect={onSelect}>
          <Check aria-hidden />
          Set as default
        </ContextMenuItem>
        {onTest && (
          <ContextMenuItem disabled={testing} onSelect={onTest}>
            <Play aria-hidden />
            Test
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * An output/input on a sound card's inactive profile (e.g. the headphone jack
 * while the speakers are in use). Selecting it switches the card over, which
 * removes the card's current devices from the list.
 */
function AudioPortRow({
  port,
  kind,
  pending,
  onSelect,
}: {
  port: AudioPort;
  kind: 'output' | 'input';
  pending: boolean;
  onSelect: () => void;
}) {
  const Icon = kind === 'input' ? Mic : /headphone|headset/i.test(port.port) ? Headphones : Volume2;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 p-2.5">
          <button
            type="button"
            role="radio"
            aria-checked={false}
            onClick={onSelect}
            disabled={pending}
            className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50"
              aria-hidden
            >
              {pending && <Loader2 className="size-3 animate-spin" />}
            </span>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate text-sm">{port.name}</span>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={pending} onSelect={onSelect}>
          <Check aria-hidden />
          Set as default
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onMuted(!stream.muted)}>
          {stream.muted ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
          {stream.muted ? 'Unmute' : 'Mute'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The default input's volume and mute, the way the output volume row above
 * works: a smooth local drag committed on release, re-synced to changes made
 * elsewhere (the mic-mute key, pactl).
 */
function InputVolumeRow() {
  const status = useAudioInputStatus();
  const { setVolume, setMuted } = useAudioInputMutations();
  const serverVolume = status.data?.volume ?? 0;
  const muted = status.data?.muted ?? false;
  const [value, setValue] = useState(serverVolume);
  const [lastServer, setLastServer] = useState(serverVolume);
  if (serverVolume !== lastServer) {
    setLastServer(serverVolume);
    setValue(serverVolume);
  }
  if (!status.data?.available) return null;

  const shown = Math.min(MAX_VOLUME, value);
  const MicIcon = muted ? MicOff : Mic;
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background/40 p-2.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        title={muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={muted}
        onClick={() => setMuted.mutate(!muted)}
      >
        <MicIcon className={cn('size-4', muted && 'text-muted-foreground')} />
      </Button>
      <span className="w-28 shrink-0 truncate text-sm">Input volume</span>
      <VolumeSlider
        aria-label="Input volume"
        value={muted ? 0 : shown}
        className="flex-1"
        onValueChange={(v) => {
          if (muted) setMuted.mutate(false);
          setValue(v);
        }}
        onValueCommit={(v) => setVolume.mutate(v)}
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {muted ? 'Muted' : `${shown}%`}
      </span>
    </div>
  );
}

/** The quietest level the mic meter shows, in dBFS; it fills at 0 dBFS. */
const METER_FLOOR_DB = -60;

/**
 * A live microphone level meter driven by getUserMedia + an AnalyserNode - the
 * standard web way to test an input. It records the system default source, so
 * it reflects whichever input is selected above. The bar is in decibels, as on
 * other desktops' meters: a laptop's built-in mic peaks around -30 dBFS for
 * speech, which a linear bar shows as barely moving. Errors (no permission, no
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
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      let shown = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
          peak = Math.max(peak, Math.abs(buffer[i]));
        }
        const db = 20 * Math.log10(Math.max(peak, 1e-6));
        const next = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
        // Rise at once, fall back gently, so syllables don't flicker.
        shown = next > shown ? next : Math.max(next, shown - 0.02);
        setLevel(shown);
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
 * (window.dinos.audio, wpctl/PipeWire) is present, output/input device selection, a
 * per-output test tone, microphone volume/mute and a level test, and
 * per-application volume.
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
  const { setDefault, selectPort, setNodeVolume, setNodeMuted, test } = useAudioDeviceMutations();

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

  const choosePort = (port: AudioPort) =>
    selectPort.mutate(
      { card: port.card, port: port.port },
      {
        onError: (err) =>
          toast({
            title: `Couldn't switch to ${port.name}`,
            description: cleanAudioError(err),
            variant: 'destructive',
          }),
      },
    );
  const portPending = (port: AudioPort) =>
    selectPort.isPending &&
    selectPort.variables?.card === port.card &&
    selectPort.variables.port === port.port;

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
  const inactiveSinks = devices.data?.inactiveSinks ?? [];
  const inactiveSources = devices.data?.inactiveSources ?? [];
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
          {sinks.length + inactiveSinks.length > 0 ? (
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
              {inactiveSinks.map((port) => (
                <AudioPortRow
                  key={`${port.card} ${port.port}`}
                  port={port}
                  kind="output"
                  pending={portPending(port)}
                  onSelect={() => choosePort(port)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No output devices found.</p>
          )}

          {/* Input devices */}
          <SoundGroupHeading icon={Mic}>Input device</SoundGroupHeading>
          {sources.length + inactiveSources.length > 0 ? (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Input device">
              {sources.map((device) => (
                <AudioDeviceRow
                  key={device.id}
                  device={device}
                  kind="input"
                  onSelect={() => setDefault.mutate(device.id)}
                />
              ))}
              {inactiveSources.map((port) => (
                <AudioPortRow
                  key={`${port.card} ${port.port}`}
                  port={port}
                  kind="input"
                  pending={portPending(port)}
                  onSelect={() => choosePort(port)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No input devices found.</p>
          )}
          <InputVolumeRow />
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

/**
 * Scrolls a list so that one of its rows is in view. Unlike scrollIntoView,
 * it leaves the settings page itself where it is.
 */
function revealInList(row: HTMLElement | null) {
  const list = row?.parentElement;
  if (!row || !list) return;
  const outer = list.getBoundingClientRect();
  const inner = row.getBoundingClientRect();
  if (inner.top < outer.top) list.scrollTop += inner.top - outer.top;
  else if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * The system's keyboard layout (window.dinos.keyboard), which Din's own windows and
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
    if (showList) revealInList(selectedRef.current);
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
 * The system's time zone and clock, through `window.dinos.datetime` (changed on
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
    if (showList) revealInList(selectedRef.current);
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
 * Do Not Disturb, which applies to every notification and stays on this
 * computer, the apps and sites allowed to notify (NotificationSitesList), and
 * the push service websites' notifications come through (PushServiceSetting).
 */
function NotificationsSection() {
  const { doNotDisturb } = useNotificationCenter();

  return (
    <SectionShell title="Notifications">
      <div className="flex flex-col gap-4">
        <SettingSwitchRow
          id="notif-dnd"
          icon={BellOff}
          label="Do Not Disturb"
          description="Keep notifications in the list without popping them up. Urgent ones still show."
          checked={doNotDisturb}
          onCheckedChange={setDoNotDisturb}
        />
        <NotificationSitesList />
        <PushServiceSetting />
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

      <div className="border-t border-border/60 pt-4">
        <NostrLinkSettings />
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

function AppearanceSection({ windowId }: { windowId: string }) {
  const { config, updateConfig } = useAppContext();

  return (
    <SectionShell title="Appearance">
      <ThemeSettings />

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
      <div className="mt-3 flex flex-col gap-3">
        <WindowEffectPicker
          event="minimize"
          label="Minimize effect"
          description="How a window goes into the Dock. It plays backwards when the window comes back."
          windowId={windowId}
          value={config.minimizeEffect}
          onChange={(minimizeEffect) => updateConfig((current) => ({ ...current, minimizeEffect }))}
        />
        <WindowEffectPicker
          event="close"
          label="Close effect"
          description="How a window leaves when it closes."
          windowId={windowId}
          value={config.closeEffect}
          onChange={(closeEffect) => updateConfig((current) => ({ ...current, closeEffect }))}
        />
      </div>

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Icons</p>
      {getIconThemeBridge() ? (
        <IconThemePicker />
      ) : (
        <FallbackCard>Din uses its own icons in the browser.</FallbackCard>
      )}

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Cursor</p>
      <div className="flex flex-col gap-3">
        {getSystemCursorBridge() ? (
          <SystemCursorPicker />
        ) : (
          <FallbackCard>The cursor is your browser’s.</FallbackCard>
        )}
      </div>

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Cursor effects</p>
      <CursorEffectsSettings />

      <p className="mb-3 mt-4 text-sm text-muted-foreground">Typing</p>
      <PowerModeSettings />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/** The largest gap Settings offers between tiles, in pixels. */
const MAX_TILING_GAP = 32;

function WindowsSection() {
  const { config, updateConfig } = useAppContext();
  const [gap, setGap] = useState(config.tilingGap);
  const [lastGap, setLastGap] = useState(config.tilingGap);
  if (config.tilingGap !== lastGap) {
    setLastGap(config.tilingGap);
    setGap(config.tilingGap);
  }

  return (
    <SectionShell title="Windows">
      <SettingSwitchRow
        id="tiling-enabled"
        icon={LayoutDashboard}
        label="Tile windows"
        description="Windows share the screen side by side instead of overlapping, like Hyprland. Super+T floats one. Super+Shift+T turns tiling on or off."
        checked={config.tilingEnabled}
        onCheckedChange={(checked) => updateConfig((current) => ({ ...current, tilingEnabled: checked }))}
      />
      <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="tiling-gap" className="text-sm">Gaps</Label>
          <span className="text-xs tabular-nums text-muted-foreground">{gap} px</span>
        </div>
        <Slider
          id="tiling-gap"
          aria-label="Gaps"
          value={[gap]}
          min={0}
          max={MAX_TILING_GAP}
          step={2}
          onValueChange={([v]) => setGap(v)}
          onValueCommit={([v]) => updateConfig((current) => ({ ...current, tilingGap: v }))}
        />
        <p className="text-xs text-muted-foreground">Space between tiled windows, and around them.</p>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        Keyboard shortcuts work whether tiling is on or not. Each monitor has workspaces 1 to 10 of its own.
      </p>
      {WM_BINDING_HELP.map((group) => (
        <div key={group.group} className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{group.group}</p>
          <div className="divide-y divide-border/60 rounded-md border bg-muted/20">
            {group.bindings.map((b) => (
              <div key={b.label} className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="text-sm text-foreground">{b.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {b.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded border border-border/80 bg-background/60 px-1.5 py-0.5 font-sans text-xs text-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </SectionShell>
  );
}

/**
 * The Dock's size, magnification and backdrop. Its own right-click menu
 * offers the last two, less the magnification level.
 */
function DockSection() {
  const { config, updateConfig } = useAppContext();

  return (
    <SectionShell title="Dock">
      <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="dock-size" className="text-sm">Size</Label>
          <span className="text-xs tabular-nums text-muted-foreground">{config.dockSize} px</span>
        </div>
        <Slider
          id="dock-size"
          aria-label="Dock size"
          value={[config.dockSize]}
          min={48}
          max={128}
          step={4}
          onValueChange={([v]) => updateConfig((current) => ({ ...current, dockSize: v }))}
        />
      </div>
      <SettingSwitchRow
        id="dock-magnification"
        icon={ZoomIn}
        label="Magnification"
        description="Icons grow as the pointer passes over them. Always off while your system prefers reduced motion."
        checked={config.dockMagnification}
        onCheckedChange={(checked) => updateConfig((current) => ({ ...current, dockMagnification: checked }))}
      />
      <div
        className={cn(
          'flex flex-col gap-2 rounded-md border bg-muted/20 p-3',
          !config.dockMagnification && 'opacity-60',
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="dock-magnification-scale" className="text-sm">Magnification level</Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round(config.dockMagnificationScale * 100)}%
          </span>
        </div>
        <Slider
          id="dock-magnification-scale"
          aria-label="Magnification level"
          value={[config.dockMagnificationScale]}
          min={1.1}
          max={2.5}
          step={0.1}
          disabled={!config.dockMagnification}
          onValueChange={([v]) =>
            updateConfig((current) => ({ ...current, dockMagnificationScale: Math.round(v * 10) / 10 }))
          }
        />
        <p className="text-xs text-muted-foreground">How large the icon under the pointer grows.</p>
      </div>
      <SubHeading>Background</SubHeading>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Dock background">
        {DOCK_STYLES.map((option) => {
          const active = config.dockStyle === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => updateConfig((current) => ({ ...current, dockStyle: option.value }))}
              className={cn(
                'flex min-w-0 flex-col items-center gap-2 rounded-xl border p-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <span className="relative flex h-16 w-full items-end justify-center overflow-hidden rounded-lg bg-linear-to-br from-sky-400 via-indigo-500 to-fuchsia-500">
                <DockPreview variant={option.value} />
              </span>
              <span className="text-xs">{option.name}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Modern is the frosted panel of macOS today, and Classic the glass shelf of Mac OS X Leopard. You can also right-click the Dock between its icons to change these.
      </p>
    </SectionShell>
  );
}

const CURSOR_SIZE_NAMES: Record<number, string> = {
  24: 'Default',
  32: 'Medium',
  40: 'Large',
  48: 'Larger',
  64: 'Extra large',
  96: 'Largest',
};

/**
 * The system pointer: its XCursor theme and size, which apply everywhere
 * (Din, web pages and native apps) at once, and themes imported from other
 * formats. See electron/cursor.mts and electron/cursorImport.mts.
 */
function SystemCursorPicker() {
  const status = useSystemCursorStatus();
  const themes = useSystemCursorThemes();
  const setCursor = useSetSystemCursor();
  const importCursor = useImportSystemCursor();
  const removeCursor = useRemoveSystemCursor();
  const { pickFiles } = useFilePicker();
  const { toast } = useToast();
  const { updateConfig } = useAppContext();

  if (status.isLoading || themes.isLoading) {
    return <Skeleton className="h-40 w-full bg-foreground/10" aria-hidden />;
  }
  if (status.isError || !status.data || !themes.data) {
    return <FallbackCard>Could not read the cursor settings.</FallbackCard>;
  }

  const { canChange, shared, sizes, fixedSize } = status.data;
  // While a change is in flight, show the requested choice.
  const { theme, size } = setCursor.isPending ? setCursor.variables : status.data;
  const busy = importCursor.isPending || removeCursor.isPending;
  const choose = (choice: { theme: string; size: number }) => {
    if (choice.theme !== theme || choice.size !== size) setCursor.mutate(choice);
  };

  const importFrom = async (directory: boolean) => {
    const picked = await pickFiles({
      title: directory ? 'Import a cursor theme folder' : 'Import cursors',
      confirmLabel: 'Import',
      directory,
      filters: directory ? undefined : [CURSOR_IMPORT_FILTER],
    });
    const source = picked?.paths[0];
    if (!source) return;
    importCursor.mutate(source, {
      onSuccess: async (ids) => {
        // A file's effects and trail, newly imported: forget any older ones by the same name.
        for (const id of ids.effects) {
          forgetPackage(`${PACKAGE_PREFIX}${id}`);
          forgetThumbnails(`${PACKAGE_PREFIX}${id}`);
        }
        const packages = ids.effects.length ? ((await getSystemCursorBridge()?.effects()) ?? []) : [];
        const first = packages.find((p) => ids.effects.includes(p.id));
        const applyEffects = () => {
          if (!first) return;
          updateConfig((current) => ({
            ...current,
            cursorTrail: first.trail ? `${PACKAGE_PREFIX}${first.id}` : current.cursorTrail,
            cursorClick: first.effects.length ? `${PACKAGE_PREFIX}${first.id}` : current.cursorClick,
          }));
        };
        if (!ids.themes.length) {
          // Effects alone: they're what was wanted, so they're used at once.
          applyEffects();
          toast({
            title: 'Cursor effects imported',
            description: first ? `${first.name} is now your ${first.trail ? 'trail' : 'click effect'}.` : undefined,
          });
          return;
        }
        const names = ids.themes.map((id) => themes.data.find((t) => t.id === id)?.name ?? id);
        toast({
          title: ids.themes.length === 1 ? 'Cursor imported' : `${ids.themes.length} cursor styles imported`,
          description: first
            ? 'It came with its own cursor effects too.'
            : ids.themes.length === 1 ? 'It’s now your pointer.' : `Using ${names[0]}.`,
          actions: first ? [{ id: 'use-effects', label: 'Use them' }] : undefined,
          onAction: (action) => {
            if (action === 'use-effects') applyEffects();
          },
        });
      },
      onError: (error) => {
        toast({
          title: 'Couldn’t import the cursor',
          description: error instanceof Error ? cleanIpcError(error.message) : undefined,
          variant: 'destructive',
        });
      },
    });
  };

  const remove = (option: SystemCursorTheme) => {
    removeCursor.mutate(option.id, {
      onError: (error) => {
        toast({
          title: `Couldn’t remove ${option.name}`,
          description: error instanceof Error ? cleanIpcError(error.message) : undefined,
          variant: 'destructive',
        });
      },
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-md border bg-muted/20 p-3">
      <div>
        <p className="mb-2 text-sm text-foreground">Style</p>
        {themes.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">No cursor themes are installed.</p>
        ) : (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2"
            role="radiogroup"
            aria-label="Cursor style"
          >
            {themes.data.map((option) => (
              <SystemCursorOption
                key={option.id}
                option={option}
                selected={theme === option.id}
                disabled={!canChange || busy}
                onChoose={() => choose({ theme: option.id, size })}
                onRemove={() => remove(option)}
              />
            ))}
          </div>
        )}
      </div>

      {canChange && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void importFrom(false)}
            >
              {importCursor.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              Import file…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void importFrom(true)}
            >
              <FolderOpen aria-hidden />
              Import folder…
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            CursorXP (.CurXPTheme), CursorFX (.CursorFX), Mousecape (.cape), Windows (.cur, .ani), Hyprcursor
            and Linux cursor themes, as a file, a folder or an archive. Animated cursors play everywhere, and a
            CursorFX file’s effects and trails join the cursor effects below.
          </p>
        </div>
      )}

      <div>
        <p className="mb-2 text-sm text-foreground">Size</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cursor size">
          {sizes.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={size === option}
              disabled={!canChange || fixedSize}
              onClick={() => choose({ theme, size: option })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
                size === option
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/60 text-muted-foreground enabled:hover:bg-foreground/5 enabled:hover:text-foreground',
              )}
            >
              {CURSOR_SIZE_NAMES[option] ?? `${option} px`}
            </button>
          ))}
        </div>
        {fixedSize && canChange && (
          <p className="mt-2 text-xs text-muted-foreground">This style comes in one size only.</p>
        )}
      </div>

      {!canChange && (
        <p className="text-xs text-muted-foreground">
          Din uses your system’s cursor. Change it in your desktop’s settings.
        </p>
      )}
      {shared && (
        <p className="text-xs text-muted-foreground">This changes your desktop’s cursor too.</p>
      )}
      {setCursor.isError && (
        <p role="alert" className="text-sm text-destructive">
          {setCursor.error instanceof Error ? setCursor.error.message : 'Could not change the cursor.'}
        </p>
      )}
    </div>
  );
}

/** What the importer reads, for the file picker. */
const CURSOR_IMPORT_FILTER = {
  name: 'Cursor themes',
  patterns: ['*.CurXPTheme', '*.zip', '*.tar', '*.tar.gz', '*.tgz', '*.tar.xz', '*.txz', '*.tar.bz2', '*.tbz2', '*.CursorFX', '*.cape', '*.cur', '*.ani', '*.inf'],
  mimeTypes: [],
};

/** An IPC error's message without Electron's "Error invoking remote method" prefix. */
function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/**
 * One style in the cursor picker. Every style's right-click menu can use it;
 * imported ones can also be removed, from there or their ⋯ menu.
 */
function SystemCursorOption({
  option,
  selected,
  disabled,
  onChoose,
  onRemove,
}: {
  option: SystemCursorTheme;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
  onRemove: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <div className="relative">
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={onChoose}
            className={cn(
              'flex w-full flex-col items-start gap-2 rounded-xl border p-3 text-left',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-60',
              option.imported && 'pr-10',
              selected
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground enabled:hover:bg-foreground/5 enabled:hover:text-foreground',
            )}
          >
            <SystemCursorPreview id={option.id} />
            <span className="w-full truncate text-sm">{option.name}</span>
          </button>
          {option.imported && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  className="absolute right-1 top-1 size-8 text-muted-foreground"
                  aria-label={`More for ${option.name}`}
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={selected} onSelect={onChoose}>
                  <Check aria-hidden />
                  Use this cursor
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2 aria-hidden />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={selected} onSelect={onChoose}>
          <Check aria-hidden />
          Use this cursor
        </ContextMenuItem>
        {option.imported && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 aria-hidden />
              Remove
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A theme's arrow, hand, I-beam and resize cursors, side by side. */
function SystemCursorPreview({ id }: { id: string }) {
  const preview = useSystemCursorPreview(id);

  return (
    <div className="flex h-10 items-center gap-2" aria-hidden>
      {preview.data
        ? preview.data.map(({ role, src }) => (
            <img key={role} src={src} alt="" className="size-8 object-contain" />
          ))
        : <Skeleton className="h-8 w-36 bg-foreground/10" />}
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
 * The computer's password (window.dinos.lock): one password that unlocks the disk
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
      <SudoModeSetting />
    </SectionShell>
  );
}

const SUDO_MODES: { id: SudoMode; label: string; description: string }[] = [
  {
    id: 'approve',
    label: 'Ask me to approve',
    description: 'Programs that run as administrator, like the Assistant, ask first, and you allow them with a click.',
  },
  {
    id: 'password',
    label: 'Ask for the password',
    description: 'They ask for the computer’s password first.',
  },
  {
    id: 'skip',
    label: 'Don’t ask',
    description: 'They run as administrator without asking.',
  },
];

/** How much each asks, least first: asking less than now takes the password. */
const SUDO_STRICTNESS: Record<SudoMode, number> = { skip: 0, approve: 1, password: 2 };

/** What sudo asks for before it runs something as administrator. */
function SudoModeSetting() {
  const bridge = getLockBridge();
  const { data: mode, isLoading, refetch } = useQuery({
    queryKey: ['lock', 'sudo-mode'],
    queryFn: () => bridge?.sudoMode() ?? 'password',
    enabled: !!bridge,
  });
  const [confirming, setConfirming] = useState<SudoMode | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<SudoMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!bridge) return null;

  const choose = (next: SudoMode) => {
    if (!mode || next === mode) return;
    setError(null);
    if (SUDO_STRICTNESS[next] < SUDO_STRICTNESS[mode]) {
      setAttempt((n) => n + 1);
      setConfirming(next);
      return;
    }
    setSaving(next);
    bridge
      .setSudoMode(next)
      .catch((e: unknown) => setError(cleanLockError(e)))
      .finally(() => {
        setSaving(null);
        void refetch();
      });
  };

  const selected = saving ?? mode;

  return (
    <div className="flex flex-col gap-2">
      <SubHeading>Running as administrator</SubHeading>
      <div role="radiogroup" aria-label="Running as administrator" className="flex flex-col gap-2">
        {SUDO_MODES.map(({ id, label, description }) => {
          const active = selected === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isLoading || saving !== null}
              onClick={() => choose(id)}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
                active ? 'border-primary bg-primary/10' : 'border-border/60 bg-background/40 hover:bg-foreground/5',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
                )}
                aria-hidden
              >
                {active && <Check className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Without Din to ask, as on the text console, the password is always asked for.
      </p>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <AdminPasswordDialog
        key={attempt}
        open={confirming !== null}
        title={confirming === 'skip' ? 'Stop asking before running as administrator?' : 'Stop asking for the password?'}
        description={confirming === 'approve' ? 'You’ll allow programs with a click instead.' : undefined}
        confirmLabel={confirming === 'skip' ? 'Stop asking' : 'Ask to approve'}
        onCancel={() => setConfirming(null)}
        onSubmit={async (password) => {
          if (!confirming) return null;
          try {
            await bridge.setSudoMode(confirming, password);
          } catch (e) {
            return cleanLockError(e);
          }
          setConfirming(null);
          setError(null);
          void refetch();
          return null;
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

/**
 * Din's logo and DinOS's version, and its updates (window.dinos.updater). The
 * system builds them from Din's source by itself and stages them for the
 * next boot, so this mostly reports, and offers the restart. It also turns
 * that off, and changes the repository and branch they're built from.
 */
function AboutSection() {
  const bridge = getUpdaterBridge();
  const state = useUpdateState();
  const dinos = !!bridge && state?.available !== false;

  return (
    <SectionShell title="About">
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-6 py-8 text-center">
        <img src="/din-logo.svg" alt="Din" className="h-24 w-auto select-none" draggable={false} />
        {dinos && !state ? (
          <Skeleton className="h-4 w-24 bg-foreground/10" aria-hidden />
        ) : (
          <p className="text-sm font-medium text-foreground">
            {dinos ? `DinOS ${state?.version ?? ''}`.trim() : 'Din'}
          </p>
        )}
        {dinos && state?.current && (
          <p className="font-mono text-xs text-muted-foreground">Commit {shortRevision(state.current)}</p>
        )}
        {dinos && state?.custom && (
          <p className="text-xs text-muted-foreground">
            Customized
            {state.changes !== null && ` · ${state.changes} ${state.changes === 1 ? 'change' : 'changes'} of yours`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">A social computer.</p>
      </div>

      <SubHeading>Updates</SubHeading>
      {!dinos ? (
        <FallbackCard icon={CircleArrowUp}>
          Updates are for DinOS. Elsewhere, Din is updated along with the system
          it runs on.
        </FallbackCard>
      ) : !state ? (
        <div className="space-y-2 rounded-xl border border-border/60 p-4" aria-hidden>
          <Skeleton className="h-4 w-32 bg-foreground/10" />
          <Skeleton className="h-3 w-56 bg-foreground/10" />
        </div>
      ) : state.live ? (
        <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          Running from a USB stick. Install DinOS to get updates.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {state.auto
              ? 'DinOS builds its updates from source by itself, while the computer is plugged in, and installs them when you restart.'
              : 'DinOS builds an update from source when you check for one, and installs it when you restart.'}
            {state.custom && ' Your own changes, from ~/DinOS, are kept: each update merges into them.'}
          </p>
          <UpdateStatus state={state} />
          <UpdateAutoRow auto={state.auto} />
          <UpdateSourceCard state={state} />
        </>
      )}

      {!dinos && <LoginSessionSection />}

      <FirmwareSection />
    </SectionShell>
  );
}

/**
 * Firmware updates for the computer and its devices (window.dinos.firmware). Unlike
 * DinOS's, they're never installed by themselves: each waits for its Update
 * button.
 */
function FirmwareSection() {
  const bridge = getFirmwareBridge();
  const state = useFirmwareState();
  if (!bridge || state?.available === false) return null;

  return (
    <>
      <SubHeading>Firmware</SubHeading>
      {!state ? (
        <div className="space-y-2 rounded-xl border border-border/60 p-4" aria-hidden>
          <Skeleton className="h-4 w-32 bg-foreground/10" />
          <Skeleton className="h-3 w-56 bg-foreground/10" />
        </div>
      ) : (
        <FirmwareStatus state={state} />
      )}
    </>
  );
}

function FirmwareStatus({ state }: { state: FirmwareState }) {
  const [error, setError] = useState<string | null>(null);
  const [rebooting, setRebooting] = useState(false);
  const busy = state.phase === 'checking' || state.phase === 'installing';

  const check = () => {
    setError(null);
    getFirmwareBridge()?.check().catch((e: unknown) => setError(cleanInstallerError(e)));
  };

  const install = (deviceId: string) => {
    setError(null);
    getFirmwareBridge()?.install(deviceId).catch((e: unknown) => setError(cleanInstallerError(e)));
  };

  const reboot = () => {
    setRebooting(true);
    setError(null);
    getFirmwareBridge()
      ?.reboot()
      .catch((e: unknown) => {
        setRebooting(false);
        setError(cleanInstallerError(e));
      });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Firmware runs the computer's hardware. Updates come from its makers through LVFS, and are
        installed only when you choose. Keep the charger plugged in while one installs.
      </p>

      {state.pendingRestart.length > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              New firmware for {state.pendingRestart.join(', ')} is ready
            </p>
            <p className="text-xs text-muted-foreground">
              Restart to install it. The screen may stay dark for a few minutes; don't turn the
              computer off.
            </p>
          </div>
          <Button size="sm" disabled={rebooting || busy} onClick={reboot}>
            {rebooting && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Restart now
          </Button>
        </div>
      )}

      {state.updates.map((update) => (
        <FirmwareUpdateCard
          key={update.deviceId}
          update={update}
          installing={state.installing === update.deviceId}
          disabled={busy}
          onInstall={() => install(update.deviceId)}
        />
      ))}

      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {state.phase === 'checking'
            ? 'Looking for firmware updates…'
            : state.phase === 'installing'
              ? 'Updating firmware. Don’t turn the computer off.'
              : state.phase === 'failed'
                ? state.error ?? 'The last check didn’t finish.'
                : state.checkedAt
                  ? `${state.updates.length > 0 ? 'Checked' : 'Up to date. Checked'} ${new Date(state.checkedAt).toLocaleString()}.`
                  : 'Not checked yet.'}
        </p>
        <Button variant="outline" size="sm" disabled={busy} onClick={check}>
          <RotateCw className={cn('size-4', state.phase === 'checking' && 'motion-safe:animate-spin')} aria-hidden />
          Check now
        </Button>
      </div>

      {error && error !== state.error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function FirmwareUpdateCard({
  update,
  installing,
  disabled,
  onInstall,
}: {
  update: FirmwareUpdate;
  installing: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-4">
      <div className="flex items-start gap-3">
        <Cpu className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{update.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[update.vendor, `${update.current ?? 'Unknown'} → ${update.version}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button size="sm" disabled={disabled} onClick={onInstall}>
          {installing && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
          {installing ? 'Updating…' : 'Update'}
        </Button>
      </div>
      {update.summary && <p className="text-xs text-foreground">{update.summary}</p>}
      {update.needsRestart && (
        <p className="text-xs text-muted-foreground">Installed when the computer restarts.</p>
      )}
      {update.description && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            What's new
          </summary>
          <p className="mt-2 whitespace-pre-line">{update.description}</p>
        </details>
      )}
    </div>
  );
}

function UpdateStatus({ state }: { state: UpdateState }) {
  const [error, setError] = useState<string | null>(null);
  // The action under way: one at a time, and Din or the computer going down
  // keeps it until it does.
  const [pending, setPending] = useState<'apply' | 'restartDin' | 'reboot' | null>(null);
  const busy = state.phase === 'checking' || state.phase === 'updating';

  const check = () => {
    setError(null);
    getUpdaterBridge()?.check().catch((e: unknown) => setError(cleanInstallerError(e)));
  };

  const act = (action: 'apply' | 'restartDin' | 'reboot') => {
    const bridge = getUpdaterBridge();
    if (!bridge) return;
    setPending(action);
    setError(null);
    bridge[action]()
      .then(() => {
        if (action === 'apply') setPending(null);
      })
      .catch((e: unknown) => {
        setPending(null);
        setError(cleanInstallerError(e));
      });
  };

  // What finishing takes: the staged system applied (and maybe a restart
  // after), or the running one restarted into.
  const finish: { title: React.ReactNode; detail: string; action: 'apply' | 'restartDin' | 'reboot'; label: string } | null =
    state.staged
      ? {
          title: <>An update is ready: commit <span className="font-mono">{shortRevision(state.staged)}</span></>,
          ...(state.stagedNeeds === 'reboot'
            ? { detail: 'Restart the computer to finish updating.', action: 'reboot', label: 'Restart now' }
            : state.stagedNeeds === 'din'
              ? { detail: 'Apply it now, then restart Din to finish.', action: 'apply', label: 'Apply now' }
              : { detail: 'Apply it now. Nothing needs to restart.', action: 'apply', label: 'Apply now' }),
        }
      : state.restart === 'din'
        ? {
            title: 'Din has been updated',
            detail: 'Restart Din to start using it. Open apps will close.',
            action: 'restartDin',
            label: 'Restart Din',
          }
        : state.restart === 'reboot'
          ? {
              title: 'Restart to finish updating',
              detail: 'The system’s kernel loads when the computer starts.',
              action: 'reboot',
              label: 'Restart now',
            }
          : null;

  return (
    <div className="flex flex-col gap-3">
      {state.phase === 'updating' && state.updatingTo ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {UPDATE_STEP_LABELS[state.step ?? 'fetch']} commit{' '}
              <span className="font-mono">{shortRevision(state.updatingTo)}</span>
            </span>
            {state.step === 'build' && (
              <span className="tabular-nums text-muted-foreground">{state.percent}%</span>
            )}
          </div>
          {state.step === 'build' && (
            <>
              <Progress value={state.percent} aria-label="Update progress" />
              <p className="text-xs text-muted-foreground">
                This can take a while. You can keep using the computer.
              </p>
            </>
          )}
        </div>
      ) : finish ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{finish.title}</p>
            <p className="text-xs text-muted-foreground">{finish.detail}</p>
          </div>
          <Button size="sm" disabled={pending !== null} onClick={() => act(finish.action)}>
            {pending === finish.action && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
            {pending === 'apply' ? 'Applying…' : finish.label}
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {state.phase === 'checking'
            ? `Looking for updates on ${state.branch ?? 'the branch'}…`
            : state.phase === 'updating'
              ? `Found a new commit on ${state.branch ?? 'the branch'}.`
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

      {state.phase === 'failed' && state.reason && <UpdateFixCard state={state} />}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * An update your own changes stopped (`reason`): they conflict, weren't
 * committed, or don't build with the branch. The assistant can merge them
 * in ~/DinOS and build the result.
 */
function UpdateFixCard({ state }: { state: UpdateState }) {
  const fixer = useFixUpdateWithAssistant();
  const [error, setError] = useState<string | null>(null);
  const branch = state.branch ?? DEFAULT_UPDATE_BRANCH;

  const replace = () => {
    setError(null);
    getUpdaterBridge()?.replace().catch((e: unknown) => setError(cleanInstallerError(e)));
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Your changes need a hand</p>
          <p className="text-xs text-muted-foreground">
            {fixer.available
              ? 'The assistant can merge the update into your changes in ~/DinOS, and build the result.'
              : 'Turn the assistant on to have it bring ~/DinOS up to date, or merge the update there yourself.'}
          </p>
        </div>
        <Button size="sm" disabled={!fixer.available || fixer.pending} onClick={() => fixer.fix(state)}>
          {fixer.pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Bot className="size-4" aria-hidden />}
          Fix with assistant
        </Button>
      </div>
      {state.reason === 'missing' && (
        <div className="flex items-center justify-between gap-4 border-t border-destructive/20 pt-3">
          <p className="min-w-0 text-xs text-muted-foreground">
            Or leave those changes behind and build <span className="font-mono">{branch}</span> as it is.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">Use {branch} instead…</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Replace this system with {branch}?</AlertDialogTitle>
                <AlertDialogDescription>
                  DinOS was built from a commit the updater can't find, so it can't tell whether {branch} is
                  newer. Building {branch} as it is drops whatever changes that commit had, and may take DinOS
                  back to an older version. The current system stays in the boot menu.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={replace}>Replace</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Whether DinOS updates by itself (`din-update auto`). */
function UpdateAutoRow({ auto }: { auto: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);

  const change = (next: boolean) => {
    setError(null);
    setPending(next);
    getUpdaterBridge()
      ?.setAuto(next)
      .catch((e: unknown) => setError(cleanInstallerError(e)))
      .finally(() => setPending(null));
  };

  return (
    <div className="flex flex-col gap-2">
      <SettingSwitchRow
        id="update-automatically"
        icon={CircleArrowUp}
        label="Update automatically"
        description="Look for new commits every six hours, and build them while the computer is plugged in."
        checked={pending ?? auto}
        disabled={pending !== null}
        onCheckedChange={change}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The repository and branch DinOS builds its updates from. Changing them
 * goes through sudo, which asks first: whoever picks the source picks what
 * runs as root.
 */
function UpdateSourceCard({ state }: { state: UpdateState }) {
  const url = state.url ?? DEFAULT_UPDATE_URL;
  const branch = state.branch ?? DEFAULT_UPDATE_BRANCH;
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftBranch, setDraftBranch] = useState(branch);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDefault = url === DEFAULT_UPDATE_URL && branch === DEFAULT_UPDATE_BRANCH;
  const busy = state.phase === 'checking' || state.phase === 'updating';

  const edit = () => {
    setDraftUrl(url);
    setDraftBranch(branch);
    setError(null);
    setEditing(true);
  };

  const save = (nextUrl: string, nextBranch: string) => {
    setSaving(true);
    setError(null);
    const bridge = getUpdaterBridge();
    bridge
      ?.setSource(nextUrl, nextBranch)
      .then(() => {
        setEditing(false);
        return bridge.check();
      })
      .catch((e: unknown) => setError(cleanInstallerError(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Source</p>
            <p className="text-xs text-muted-foreground">
              {isDefault ? 'Din’s own repository, ' : 'A repository of your choosing, '}
              branch <span className="font-mono">{branch}</span>.
            </p>
            {!editing && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={url}>{url}</p>}
          </div>
        </div>
        {!editing && (
          <Button variant="outline" size="sm" disabled={busy} onClick={edit}>
            Change…
          </Button>
        )}
      </div>

      {editing && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save(draftUrl, draftBranch);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Updates are built from whatever this branch holds, and run with full control of the computer,
            so only follow a repository you trust. A nostr:// or https:// git URL.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="update-source-url">Repository</Label>
            <Input
              id="update-source-url"
              className="font-mono text-xs"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="update-source-branch">Branch</Label>
            <Input
              id="update-source-branch"
              className="font-mono text-xs"
              value={draftBranch}
              onChange={(e) => setDraftBranch(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!isDefault && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto"
                disabled={saving}
                onClick={() => save(DEFAULT_UPDATE_URL, DEFAULT_UPDATE_BRANCH)}
              >
                Use Din’s own
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving || !draftUrl.trim() || !draftBranch.trim() || (draftUrl.trim() === url && draftBranch.trim() === branch)}
            >
              {saving && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              Save
            </Button>
          </div>
        </form>
      )}

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
        <h2 className="font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * A labelled toggle row matching the rest of Settings' switch controls. Add a
 * new row's label to its section's `search` in SECTIONS (src/lib/settingsSections.ts) so search finds it.
 */
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
