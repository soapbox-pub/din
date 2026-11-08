import { Fragment, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Airplay,
  ArrowDown,
  ArrowUp,
  Blend,
  Contrast,
  Type,
  Zap,
  BatteryFull,
  BellOff,
  Bomb,
  Bot,
  Check,
  RotateCcw,
  SpellCheck,
  CircleArrowUp,
  Clock,
  Cpu,
  FolderOpen,
  GitBranch,
  Grid2x2,
  CloudOff,
  Gauge,
  Globe,
  Headphones,
  History,
  KeyRound,
  Keyboard,
  Laptop,
  LayoutDashboard,
  Loader2,
  Mic,
  Pause,
  MicOff,
  Minus,
  Monitor,
  Moon,
  Mouse,
  MoreHorizontal,
  Play,
  Power,
  Plug,
  Plus,
  RotateCw,
  Search,
  Share,
  ShieldAlert,
  Store,
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
import { ContentPane, SearchField, SegmentedControl, SidebarTitle, StatusPill } from '@/shared/appChrome';
import { SIDEBAR_WIDTH, focusRing, sidebarHeadingClass, sidebarRowClass, titleSearch } from '@/shared/appChromeStyles';
import { RadioMark, SettingsToken } from '@/shared/settingsChrome';
import { settingsAlert, settingsCard, settingsChoiceClass, settingsGroup, settingsNotice, settingsRowButton, settingsTokenClass } from '@/shared/settingsChromeStyles';
import {
  SettingsFallback as FallbackCard,
  SettingsGroup,
  SettingsSection as SectionShell,
  SettingsSubHeading as SubHeading,
} from '@/shared/settingsSection';
import { SettingsGroupContext, SettingsSearchingContext } from '@/shared/settingsContexts';
import { findMatches, parseQuery } from '@/lib/settingsSearch';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { AppComponentProps } from '@/lib/apps';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { BluetoothSettingsSection } from '@/components/desktop/apps/BluetoothSettingsSection';
import {
  cleanDisplayError,
  DISPLAY_ROTATIONS,
  formatMode,
  formatRefresh,
  friendlyOutputName,
  getDisplayBridge,
  isInternalOutput,
  layoutSize,
  preferredMode,
  refreshRates,
  rotatedSize,
  rotateInLayout,
  rotationLabel,
  uniqueModes,
} from '@/lib/display';
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, clampZoom, withDisplayZoom, zoomOf } from '@/lib/displayZoom';
import type { DisplayMode, DisplayOutput, DisplayPlacement, DisplayRotation } from '@/lib/display';
import { getZoomBridge } from '@/lib/zoom';
import {
  COLOR_FILTERS,
  COLOR_FILTER_NAMES,
  MAX_TEXT_SIZE,
  MIN_TEXT_SIZE,
  TEXT_SIZE_STEP,
  clampTextSize,
  getAccessibilityBridge,
} from '@/lib/accessibility';
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
import {
  LAYOUT_SWITCH_KEYS,
  MAX_KEYBOARD_LAYOUTS,
  getKeyboardBridge,
  layoutKey,
  layoutTag,
  withLayoutAdded,
  withLayoutMoved,
  withLayoutRemoved,
  type KeyboardLayout,
  type KeyboardLayoutChoice,
} from '@/lib/keyboard';
import { getMouseBridge } from '@/lib/mouse';
import { cleanLockError, getLockBridge, type SudoMode } from '@/lib/lock';
import { AdminPasswordDialog } from '@/components/desktop/AdminPrompt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GRAMMAR_DIALECTS, getGrammarBridge, ruleDescription, ruleName, type GrammarDialect, type GrammarRule, type GrammarState } from '@/lib/grammar';
import {
  describeZone,
  getDateTimeBridge,
  timeFormatOptions,
  zoneLongName,
  zoneOffset,
  type DateTimeStatus,
} from '@/lib/datetime';
import {
  useDateTimeStatus,
  useSetAutomaticTime,
  useSetTime,
  useSetTimeZone,
  useTimeZones,
  useZonePlaces,
} from '@/hooks/useDateTime';
import { TimeZoneMap } from '@/components/desktop/apps/TimeZoneMap';
import { useClock } from '@/hooks/useClock';
import type { AppConfig, ClockFormat, DesktopLayout, TaskbarButtons, TaskbarPosition, TaskbarStyle } from '@/contexts/AppContext';
import { useDesktopIcons } from '@/contexts/DesktopIconsContext';
import { DESKTOP_ICON_SORTS, type DesktopIconSize } from '@/lib/desktopIcons';
import {
  useKeyboardLayouts,
  useKeyboardStatus,
  useRestartForKeyboardLayout,
  useSelectKeyboardLayout,
  useSetKeyboardLayouts,
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
import { BackgroundActivity } from '@/components/desktop/apps/BackgroundActivity';
import { PushServiceSetting } from '@/components/desktop/apps/PushServiceSetting';
import { useToast } from '@/hooks/useToast';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import { getIconThemeBridge } from '@/lib/iconTheme';
import { IconThemePicker } from '@/components/desktop/apps/IconThemePicker';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { useWindowActions } from '@/contexts/WindowManagerContext';
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
import { WebsiteLinkSettings } from '@/components/desktop/WebsiteLinkSettings';
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
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import { NativeSelect } from '@/components/ui/native-select';
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
import { dismissUpdateNotice, useUpdateNoticePending } from '@/lib/updateNotice';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { cleanInstallerError } from '@/lib/installer';
import { useFixUpdateWithAssistant, useUpdateState } from '@/hooks/useUpdater';
import { getFirmwareBridge } from '@/lib/firmware';
import type { FirmwareState, FirmwareUpdate } from '@/lib/firmware';
import { useFirmwareState } from '@/hooks/useFirmware';
import { ConnectedAppsSection } from '@/components/desktop/apps/ConnectedAppsSection';
import { DriveSettingsSection } from '@/components/desktop/apps/DriveSettingsSection';
import { AssistantSettingsSection } from '@/components/desktop/apps/AssistantSettingsSection';
import { WifiSettingsSection } from '@/components/desktop/apps/WifiSettingsSection';
import { PrintersSettingsSection } from '@/components/desktop/apps/PrintersSettingsSection';
import { FirewallSettingsSection } from '@/components/desktop/apps/FirewallSettingsSection';
import { OptionalFeaturesSection } from '@/components/desktop/apps/OptionalFeaturesSection';
import { PhoneSettingsSection } from '@/components/desktop/apps/PhoneSettingsSection';
import { LoginSessionSection } from '@/components/desktop/apps/LoginSessionSection';
import { EraseSection } from '@/components/desktop/apps/EraseSection';
import { ThemeSettings } from '@/components/desktop/apps/ThemeSettings';
import { DockPreview } from '@/components/desktop/Dock';
import { DOCK_STYLES } from '@/lib/dockStyles';
import { isTaskbarVertical, TASKBAR_BUTTONS, TASKBAR_POSITIONS, TASKBAR_STYLES } from '@/lib/taskbarStyles';
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
 * devices through `window.dinos.bluetooth` (BlueZ over D-Bus), each paired one
 * with its own page (BluetoothSettingsSection). Phone adds the
 * phones whose texts Messages shows (PhoneSettingsSection). Firewall lets in
 * the ports the user chooses, on DinOS, through `window.dinos.firewall`
 * (FirewallSettingsSection). The Display section arranges the monitors through
 * `window.dinos.display` (wlr-randr under din-shell, xrandr on bare X11), falling back
 * where neither can manage them. Battery & Power reads the battery through
 * `window.dinos.power` (/sys/class/power_supply), leaving it out on machines with
 * no battery, and switches the system power profile through the same bridge
 * (net.hadess.PowerProfiles over D-Bus: power-profiles-daemon / tuned-ppd),
 * falling back where no such daemon runs. The Sound
 * section drives the default sink's volume/mute through `window.dinos.audio`
 * (wpctl/PipeWire), including outputs on a sound card's inactive profile.
 * Keyboard picks the layouts everything types with, and which one's
 * typing, through `window.dinos.keyboard`. Printers lists the printers CUPS can reach, sets
 * the default, and shows the queue (PrintersSettingsSection). Optional Features installs and removes the
 * parts of DinOS kept off the disk until wanted, like Wine and QEMU (OptionalFeaturesSection). Date & Time sets the time zone and clock
 * through `window.dinos.datetime`, and how Din's clocks show the time. Password changes the computer's one password
 * (disk, lock screen, Nostr keys) through `window.dinos.lock`. Nostr & Storage manages Din's encrypted app-data
 * sync, NIP-65 relay list, and Blossom server list. Drive sets up Din Drive, the encrypted drive at ~/Drive,
 * and shows whether it's in sync and its trash (DriveSettingsSection). Connected apps lists the
 * sites and apps that may use the account through Din's signer
 * (ConnectedAppsSection). Assistant turns OpenCode, the AI agent, on or off
 * and connects its providers (AssistantSettingsSection). The Appearance group's
 * Themes switches the shell theme between light, dark and a custom one of
 * colors, fonts and a background picture, synced with the profile theme or
 * kept on this computer (ThemeSettings); Cursors picks the pointer and its
 * effects; Icons the icon theme; and Effects toggles desktop effects like
 * wobbly windows.
 * Windows turns Hyprland-style tiling on or off, sets its gaps, and lists the
 * Super-key shortcuts for windows and workspaces (src/lib/wmBindings.ts).
 * Dock turns its magnification on or off and picks its backdrop, as its own
 * right-click menu does.
 * Developers holds debug utilities: restarting Din (DinOS) and intentionally
 * crashing the shell to test the error boundary. About shows Din's logo and DinOS's version, and
 * the update it's building through `window.dinos.updater`, offers the restart
 * that finishes one and the repository it's built from, firmware updates
 * through `window.dinos.firmware`, and erasing the computer (EraseSection); elsewhere on Linux, it puts Din on the login
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
  // And Appearance, before its pages were sections of their own.
  if (s === 'appearance') return 'themes';
  return typeof s === 'string' && SECTION_IDS.has(s) ? (s as SectionId) : undefined;
}

const SIDEBAR_WIDTH_KEY = 'din.settings.sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = SIDEBAR_WIDTH;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 360;

const clampSidebarWidth = (width: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));

function loadSidebarWidth(): number {
  const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  // 208 was the default, saved whether or not it was ever dragged.
  return width && width !== 208 ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

export function Settings({ params, windowId }: AppComponentProps) {
  useOwnWindowHeader();
  const [section, setSection] = useState<SectionId>(
    () => paramSection(params) ?? 'wifi',
  );
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  // Only a width dragged to is kept, so the default can change.
  useEffect(() => (sidebarWidth === DEFAULT_SIDEBAR_WIDTH ? localStorage.removeItem(SIDEBAR_WIDTH_KEY) : localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))), [sidebarWidth]);
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
  // The pane outlives its sections, so a new one would open at the last one's scroll.
  useLayoutEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [section, searching]);

  // A DinOS update's notice dots About until About is seen.
  const updatePending = useUpdateNoticePending();
  const isTop = useWindowIsTop();
  const seeingAbout = !searching && section === 'about' && isTop;
  useEffect(() => {
    if (seeingAbout && updatePending) dismissUpdateNotice();
  }, [seeingAbout, updatePending]);

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
      <BluetoothSettingsSection />
    ) : id === 'phone' ? (
      <PhoneSettingsSection addRequest={params?.add === true ? params.nonce ?? true : undefined} />
    ) : id === 'firewall' ? (
      <FirewallSettingsSection />
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
    ) : id === 'mouse' ? (
      <MouseSection />
    ) : id === 'printers' ? (
      <PrintersSettingsSection />
    ) : id === 'features' ? (
      <OptionalFeaturesSection />
    ) : id === 'datetime' ? (
      <DateTimeSection />
    ) : id === 'accessibility' ? (
      <AccessibilitySection />
    ) : id === 'password' ? (
      <PasswordSection />
    ) : id === 'notifications' ? (
      <NotificationsSection />
    ) : id === 'background' ? (
      <SectionShell title="Background Activity">
        <BackgroundActivity />
      </SectionShell>
    ) : id === 'nostr' ? (
      <NostrStorageSection />
    ) : id === 'drive' ? (
      <DriveSettingsSection />
    ) : id === 'connected' ? (
      <ConnectedAppsSection />
    ) : id === 'assistant' ? (
      <AssistantSettingsSection />
    ) : id === 'themes' ? (
      <ThemesSection />
    ) : id === 'cursors' ? (
      <CursorsSection />
    ) : id === 'icons' ? (
      <IconsSection />
    ) : id === 'effects' ? (
      <EffectsSection windowId={windowId} />
    ) : id === 'windows' ? (
      <WindowsSection />
    ) : id === 'desktop' ? (
      <DesktopSection />
    ) : id === 'dock' ? (
      <DockSection />
    ) : id === 'developers' ? (
      <DevelopersSection />
    ) : (
      <AboutSection eraseRequest={typeof params?.erase === 'number' ? params.erase : undefined} />
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
        className="flex shrink-0 flex-col pb-2"
      >
        {/* The window's title bar runs across the sidebar's top, so it drags the window too. */}
        <SidebarTitle
          region={WindowDragRegion}
          icon={<AppIcon icon="/icons/apps/settings.png" className="size-6 shrink-0 object-contain" />}
          title="Settings"
        />
        <nav aria-label="Settings sections" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pt-2 [&>*]:shrink-0">
          {SECTIONS.map((s, i) => {
            const current = searching ? results.includes(s) : section === s.id;
            return (
              <Fragment key={s.id}>
                {s.group !== SECTIONS[i - 1]?.group && (
                  <h3
                    className={cn(sidebarHeadingClass, i > 0 && 'mt-3')}
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
                  className={cn(sidebarRowClass(current), searching && !current && 'opacity-50')}
                >
                  <s.icon className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
                  <span className="truncate">{s.name}</span>
                  {s.id === 'about' && updatePending && (
                    <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" aria-label="Update available" />
                  )}
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

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The search across the title bar, as Mail's. */}
        <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pl-2 pr-3">
          <SearchField ref={searchRef} value={query} onValueChange={setQuery} placeholder="Search settings" aria-label="Search settings" className={titleSearch} />
          <div className="min-w-2 flex-1" />
          <WindowControls />
        </WindowDragRegion>
        <ContentPane>
          <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto">
            {!searching ? (
              renderSection(section)
            ) : results.length > 0 ? (
              <SettingsSearchingContext value>
                {results.map((s, i) => (
                  <Fragment key={s.id}>
                    {i > 0 && (
                      <div aria-hidden className="mx-auto max-w-2xl px-4">
                        <div className="h-px bg-border/70" />
                      </div>
                    )}
                    {renderSection(s.id)}
                  </Fragment>
                ))}
              </SettingsSearchingContext>
            ) : (
              <div className="mx-auto max-w-2xl p-4">
                <FallbackCard icon={Search}>No settings match “{query.trim()}”.</FallbackCard>
              </div>
            )}
          </div>
        </ContentPane>
      </div>
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
  rotation: DisplayRotation;
  /** Its zoom (din-shell): its size on the shared screen is over this. */
  scale: number;
  modes: DisplayMode[];
  allModes: DisplayMode[];
}

/** The space a draft display takes on the shared screen, turned as it's to be, over its zoom. */
function draftSize(d: DisplayDraft): { width: number; height: number } {
  return layoutSize(d.width, d.height, d.rotation, d.scale);
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
      rotation: output.rotation ?? 0,
      scale: output.scale ?? 1,
      modes,
      allModes: output.modes,
    };
  });
}

/** A stable signature of the arrangement, for dirty-checking and re-seeding. */
function layoutSignature(drafts: DisplayDraft[]): string {
  return JSON.stringify(
    drafts.map((d) => [d.name, d.enabled, d.primary, d.x, d.y, d.width, d.height, d.refresh, d.rotation, d.scale]),
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
    rotation: d.rotation,
  }));
}

/** The config without a zoom of the user's, so the display's own applies. */
function automaticZoom(config: Partial<AppConfig>): Partial<AppConfig> {
  const { zoomLevel: _, ...rest } = config;
  return rest;
}

/**
 * Zoom: per display under din-shell (src/lib/displayZoom.ts), else one
 * for the whole desktop.
 */
function InterfaceZoom() {
  const { config, updateConfig, zoomAutomatic, perDisplayZoom } = useAppContext();
  if (perDisplayZoom) return <PerDisplayZoomControl />;
  return (
    <DisplayZoomControl
      available={getZoomBridge() !== undefined}
      value={config.zoomLevel}
      automatic={zoomAutomatic}
      onChange={(percent) => updateConfig((c) => ({ ...c, zoomLevel: clampZoom(percent) }))}
      onAutomatic={() => updateConfig(automaticZoom)}
    />
  );
}

/** − 125% + for a zoom, with "Use automatic" once the user has chosen one. */
function ZoomStepper({
  label,
  value,
  automatic,
  onChange,
  onAutomatic,
}: {
  /** What's zoomed, for the buttons' labels ("Zoom out Built-in display"). */
  label?: string;
  value: number;
  /** Whether VALUE is the display's own, the user having set none. */
  automatic: boolean;
  onChange: (percent: number) => void;
  /** Go back to the display's own zoom. */
  onAutomatic: () => void;
}) {
  const of = label ? ` ${label}` : '';
  return (
    <div className="flex items-center justify-center gap-3">
      <Button
        variant="outline"
        size="icon"
        aria-label={`Zoom out${of}`}
        disabled={value <= MIN_ZOOM}
        onClick={() => onChange(clampZoom(value - ZOOM_STEP))}
      >
        <Minus className="size-4.5" strokeWidth={1.75} />
      </Button>
      <span className="flex w-24 flex-col items-center text-center" aria-live="polite">
        <span className="text-sm tabular-nums font-medium">{value}%</span>
        {automatic && <span className="text-xs text-muted-foreground">Automatic</span>}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label={`Zoom in${of}`}
        disabled={value >= MAX_ZOOM}
        onClick={() => onChange(clampZoom(value + ZOOM_STEP))}
      >
        <Plus className="size-4.5" strokeWidth={1.75} />
      </Button>
      <Button variant="ghost" size="sm" className={cn(automatic && 'invisible')} onClick={onAutomatic}>
        Use automatic
      </Button>
    </div>
  );
}

/**
 * Interface zoom - DPI-style scaling of the whole desktop through Chromium
 * page zoom (window.dinos.zoom preload bridge), where displays can't each
 * have their own. Lives in AppConfig (persisted locally) and works in every
 * Electron session, including ones where the arrangement below is
 * unavailable. In a plain browser there is no bridge, so the control points
 * at the browser's own zoom instead.
 */
function DisplayZoomControl({
  available,
  value,
  automatic,
  onChange,
  onAutomatic,
}: {
  available: boolean;
  value: number;
  /** Whether VALUE is the display's own, the user having set none. */
  automatic: boolean;
  onChange: (percent: number) => void;
  /** Go back to the display's own zoom. */
  onAutomatic: () => void;
}) {
  return (
    <div className={cn(settingsCard, 'flex flex-col gap-4 p-4')}>
      <div className="flex items-center gap-3">
        <SettingsToken icon={ZoomIn} />
        <div className="min-w-0">
          <p className="text-sm font-medium">Zoom</p>
          <p className="text-xs text-muted-foreground">
            Scale everything on the desktop up or down. Automatic suits the
            main display's sharpness.
          </p>
        </div>
      </div>
      {available ? (
        <ZoomStepper value={value} automatic={automatic} onChange={onChange} onAutomatic={onAutomatic} />
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
 * Zoom display by display, under din-shell: each is zoomed to suit its own
 * sharpness until the user picks a zoom for it, which is remembered for that
 * display (src/lib/displayZoom.ts).
 */
function PerDisplayZoomControl() {
  const { config, updateConfig } = useAppContext();
  const status = useDisplayStatus();
  const outputs = (status.data?.available ? status.data.outputs : []).filter((o) => o.enabled);
  const several = outputs.length > 1;

  return (
    <div className={cn(settingsCard, 'flex flex-col gap-4 p-4')}>
      <div className="flex items-center gap-3">
        <SettingsToken icon={ZoomIn} />
        <div className="min-w-0">
          <p className="text-sm font-medium">Zoom</p>
          <p className="text-xs text-muted-foreground">
            {several
              ? 'Each display is zoomed to suit its sharpness, so the desktop is the same size on all of them. A zoom you pick is remembered for that display.'
              : 'Scale everything on the desktop up or down. Automatic suits the display’s sharpness, and a zoom you pick is remembered for this display.'}
          </p>
        </div>
      </div>
      {status.isLoading ? (
        <Skeleton className="mx-auto h-9 w-64 rounded-md bg-foreground/10" />
      ) : outputs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No displays are on.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Zoom by display">
          {outputs.map((output) => {
            const { percent, automatic } = zoomOf(output, config.displayZoom);
            const name = output.airplay ? `${output.airplay} (AirPlay)` : friendlyOutputName(output.name);
            const Icon = isInternalOutput(output.name) ? Laptop : Monitor;
            return (
              <li key={output.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                {several && (
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <Icon className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{name}</span>
                  </span>
                )}
                <div className={cn(!several && 'mx-auto')}>
                  <ZoomStepper
                    label={several ? name : undefined}
                    value={percent}
                    automatic={automatic}
                    onChange={(next) => updateConfig((c) => withDisplayZoom(c, output, next))}
                    onAutomatic={() => updateConfig((c) => withDisplayZoom(c, output, null))}
                  />
                </div>
              </li>
            );
          })}
        </ul>
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
  const setRotationFor = (name: string, rotation: DisplayRotation) =>
    setDraft((ds) => {
      const target = ds.find((d) => d.name === name);
      return target ? rotateInLayout(ds, target, rotation) : ds;
    });
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
        onRotation={setRotationFor}
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
            onRotation={setRotationFor}
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
          <RotateCw strokeWidth={1.75} className={cn('size-4.5', status.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      <InterfaceZoom />
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
    <div className="flex flex-col gap-3">
      <SoundGroupHeading icon={Airplay}>AirPlay</SoundGroupHeading>
      <p className="px-1 text-xs text-muted-foreground">
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
    const size = draftSize(o);
    // align left / align right / place to the right / place to the left
    xEdges.push(o.x, o.x + size.width - w, o.x + size.width, o.x - w);
    // align top / align bottom / place below / place above
    yEdges.push(o.y, o.y + size.height - h, o.y + size.height, o.y - h);
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
  onRotation,
}: {
  draft: DisplayDraft[];
  selected: string | null;
  canDisable: boolean;
  onSelect: (name: string) => void;
  onMove: (name: string, x: number, y: number) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onPrimary: (name: string) => void;
  onRotation: (name: string, rotation: DisplayRotation) => void;
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
  const maxX = on.length ? Math.max(...on.map((d) => d.x + draftSize(d).width)) : 1;
  const maxY = on.length ? Math.max(...on.map((d) => d.y + draftSize(d).height)) : 1;
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
    const size = draftSize(moving);
    const [sx, sy] = snapPosition(nx, ny, size.width, size.height, others, 24 / scale);
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
      className="relative w-full rounded-xl bg-foreground/[0.04]"
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
                  'absolute flex select-none flex-col items-center justify-center overflow-hidden rounded-lg bg-card text-center clay',
                  'cursor-grab touch-none active:cursor-grabbing',
                  focusRing,
                  selected === d.name && 'ring-2 ring-ring/60',
                )}
                style={{
                  left: offX + (d.x - minX) * scale,
                  top: offY + (d.y - minY) * scale,
                  width: Math.max(draftSize(d).width * scale, 8),
                  height: Math.max(draftSize(d).height * scale, 8),
                }}
              >
                <span className="truncate px-1 text-[11px] font-medium text-foreground">
                  {d.friendly}
                </span>
                <span className="truncate px-1 text-[10px] text-muted-foreground">
                  {rotatedSize(d.width, d.height, d.rotation).width} × {rotatedSize(d.width, d.height, d.rotation).height}
                  {Math.abs(d.scale - 1) > 0.005 && ` at ${Math.round(d.scale * 100)}%`}
                </span>
                {d.primary && (
                  <span className="text-[10px] font-medium text-ink-accent">
                    Primary
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={d.primary} onSelect={() => onPrimary(d.name)}>
                <Monitor aria-hidden />
                Make Primary
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <RotateCw aria-hidden />
                  Rotation
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuRadioGroup
                    value={String(d.rotation)}
                    onValueChange={(value) => onRotation(d.name, Number(value) as DisplayRotation)}
                  >
                    {DISPLAY_ROTATIONS.map((rotation) => (
                      <ContextMenuRadioItem key={rotation} value={String(rotation)}>
                        {rotationLabel(rotation, d.width, d.height)}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
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
  onRotation,
}: {
  draft: DisplayDraft;
  canDisable: boolean;
  selected: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onPrimary: (name: string) => void;
  onMode: (name: string, width: number, height: number) => void;
  onRefresh: (name: string, refresh: number) => void;
  onRotation: (name: string, rotation: DisplayRotation) => void;
}) {
  const d = draft;
  const Icon = d.internal ? Laptop : Monitor;
  const selectId = `resolution-${d.name}`;
  const refreshId = `refresh-${d.name}`;
  const rotationId = `rotation-${d.name}`;
  const currentValue = `${d.width}x${d.height}`;
  const rates = refreshRates(d.allModes, d.width, d.height);

  return (
    <li
      className={cn(settingsCard, 'px-4 py-3', selected && 'ring-2 ring-ring/60')}
    >
      <div className="flex items-center gap-3">
        <SettingsToken icon={Icon} active={d.enabled} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm text-foreground">
            {d.friendly}
            {d.primary && <StatusPill>Primary</StatusPill>}
            {!d.enabled && <StatusPill>Off</StatusPill>}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {d.name}
            {d.enabled && !canDisable && ' · Your only display that’s on'}
          </p>
        </div>
        <Switch
          id={`enabled-${d.name}`}
          checked={d.enabled}
          disabled={d.enabled && !canDisable}
          onCheckedChange={(value) => onToggle(d.name, value)}
          aria-label={d.friendly}
          title={d.enabled && !canDisable ? 'Turn another display on to turn this one off' : undefined}
        />
      </div>

      {d.enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!d.primary && (
            <Button type="button" variant="outline" size="sm" onClick={() => onPrimary(d.name)}>
              Make Primary
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Label htmlFor={selectId} className="sr-only">
              Resolution for {d.friendly}
            </Label>
            <NativeSelect
              size="sm"
              id={selectId}
              value={currentValue}
              disabled={d.modes.length === 0}
              onChange={(e) => {
                const [width, height] = e.target.value.split('x').map(Number);
                if (Number.isFinite(width) && Number.isFinite(height)) onMode(d.name, width, height);
              }}
            >
              {d.modes.map((mode) => (
                <option key={`${mode.width}x${mode.height}`} value={`${mode.width}x${mode.height}`}>
                  {formatMode(mode.width, mode.height)}
                  {mode.preferred ? ' (native)' : ''}
                </option>
              ))}
            </NativeSelect>
            {rates.length > 1 && (
              <>
                <Label htmlFor={refreshId} className="sr-only">
                  Refresh rate for {d.friendly}
                </Label>
                <NativeSelect
                  size="sm"
                  id={refreshId}
                  value={String(rates.find((rate) => Math.abs(rate - d.refresh) < 0.01) ?? rates[0])}
                  onChange={(e) => onRefresh(d.name, Number(e.target.value))}
                    >
                  {rates.map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {formatRefresh(rate)}
                    </option>
                  ))}
                </NativeSelect>
              </>
            )}
            <Label htmlFor={rotationId} className="sr-only">
              Rotation for {d.friendly}
            </Label>
            <NativeSelect
              size="sm"
              id={rotationId}
              value={String(d.rotation)}
              onChange={(e) => onRotation(d.name, Number(e.target.value) as DisplayRotation)}
            >
              {DISPLAY_ROTATIONS.map((rotation) => (
                <option key={rotation} value={String(rotation)}>
                  {rotationLabel(rotation, d.width, d.height)}
                </option>
              ))}
            </NativeSelect>
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
          className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')}
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
            className={cn('size-4.5', (status.isFetching || profiles.isFetching) && 'animate-spin')}
            strokeWidth={1.75}
          />
        </Button>
      }
    >
      {hasBattery && (
        <div className="space-y-3">
          <SubHeading>Battery</SubHeading>
          <BatteryPanel status={status} />
        </div>
      )}

      <div className="space-y-3">
        <SubHeading>Power mode</SubHeading>
        <PowerProfilesPanel profiles={profiles} />
        {profiles.data?.profiles.includes('performance') && <GamePerformanceSwitch />}
      </div>
    </SectionShell>
  );
}

function GamePerformanceSwitch() {
  const { config, updateConfig } = useAppContext();
  return (
    <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
            <div className={cn(settingsCard, 'flex items-center gap-4 p-4')}>
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
                <StatusPill>
                  <Plug className="size-3.5" aria-hidden />
                  Plugged in
                </StatusPill>
              )}
            </div>
          )}

          <ul className={settingsGroup} aria-label="Batteries">
            {data.batteries.map((battery) => (
              <BatteryDetailRow key={battery.name} battery={battery} />
            ))}
          </ul>

          {data.devices.length > 0 && (
            <div className="space-y-2">
              <h4 className="px-1 text-xs font-semibold text-muted-foreground">Devices</h4>
              <ul className={settingsGroup} aria-label="Devices">
                {data.devices.map((battery) => (
                  <BatteryDetailRow key={battery.name} battery={battery} />
                ))}
              </ul>
            </div>
          )}
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
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className={settingsTokenClass(charging)}>
            <BatteryGlyph percent={battery.percent} charging={charging} />
          </span>
          <span className="truncate text-sm text-foreground">{battery.label}</span>
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
        aria-label={`${battery.label} charge`}
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
      <div className={cn(settingsCard, 'flex items-center gap-4 p-4')}>
        <Skeleton className="size-9 rounded bg-foreground/10" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-6 w-16 bg-foreground/10" />
          <Skeleton className="h-3.5 w-32 bg-foreground/10" />
        </div>
      </div>
      <div className={cn(settingsCard, 'px-4 py-3')}>
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
          <div role="radiogroup" aria-label="Power profile" className={settingsGroup}>
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
                  className={cn(settingsRowButton, 'items-start py-3 disabled:opacity-60')}
                >
                  <RadioMark checked={active} className="mt-0.5" />
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
        <div key={i} className={cn(settingsCard, 'flex items-start gap-3 p-4')}>
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
      <RotateCw strokeWidth={1.75} className={cn('size-4.5', status.isFetching && 'animate-spin')} />
    </Button>
  );

  if (status.isLoading) {
    return (
      <SectionShell title="Brightness" actions={refresh}>
        <div className={cn(settingsCard, 'h-20')} aria-hidden>
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
          <div className={cn(settingsCard, 'flex items-center gap-4 p-4')}>
            <span aria-hidden className={settingsTokenClass()}>
              <BrightnessGlyph brightness={value} />
            </span>
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
          <div className={cn(settingsCard, 'flex flex-col gap-4 p-4')}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <SettingsToken icon={Moon} active={nightLight.active} />
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
                <div className="flex items-center gap-3">
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
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Night Light schedule"
        size="md"
        value={nightLight.schedule}
        options={NIGHT_LIGHT_SCHEDULES.map((option) => ({ value: option.value, label: option.name }))}
        onValueChange={(schedule) => save({ schedule })}
        className="self-start"
      />

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
    <div className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold text-foreground">
      <Icon className="size-4.5 text-ink-accent" strokeWidth={1.75} aria-hidden />
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
        <div className="flex items-center gap-1 pr-2">
          <button
            type="button"
            role="radio"
            aria-checked={device.isDefault}
            onClick={onSelect}
            className={cn(settingsRowButton, 'min-w-0 flex-1')}
          >
            <SettingsToken icon={Icon} active={device.isDefault} />
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
        <div>
          <button
            type="button"
            role="radio"
            aria-checked={false}
            onClick={onSelect}
            disabled={pending}
            className={settingsRowButton}
          >
            <SettingsToken icon={pending ? Loader2 : Icon} className={cn(pending && '[&_svg]:animate-spin')} />
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
        <div className="flex items-center gap-3 px-2.5 py-2">
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
              className={cn('size-4.5', stream.muted && 'text-muted-foreground')}
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
    <div className={cn(settingsCard, 'flex items-center gap-3 p-2.5')}>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        title={muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={muted}
        onClick={() => setMuted.mutate(!muted)}
      >
        <MicIcon className={cn('size-4.5', muted && 'text-muted-foreground')} strokeWidth={1.75} />
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
      <div className={cn(settingsCard, 'flex items-center gap-3 p-2.5')}>
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
  const { config, updateConfig } = useAppContext();
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
            strokeWidth={1.75}
            className={cn(
              'size-4.5',
              (status.isFetching || devices.isFetching || streams.isFetching) &&
                'animate-spin',
            )}
          />
        </Button>
      }
    >
      {status.isLoading ? (
        <div className={cn(settingsCard, 'h-20')} aria-hidden>
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
          <div className={cn(settingsCard, 'flex items-center gap-4 p-4')}>
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

          <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
            <div className={settingsGroup} role="radiogroup" aria-label="Output device">
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
            <div className={settingsGroup} role="radiogroup" aria-label="Input device">
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
          <SettingSwitchRow
            id="pause-media-recording"
            icon={Pause}
            label="Pause media while recording"
            description="Music, videos and other apps pause while dictation or the assistant’s Record Audio listens, and play again when it’s done."
            checked={config.pauseMediaWhileRecording !== false}
            onCheckedChange={(checked) => updateConfig((current) => ({ ...current, pauseMediaWhileRecording: checked }))}
          />

          {/* Per-application volume */}
          <SoundGroupHeading icon={Volume2}>App volume</SoundGroupHeading>
          {appStreams.length > 0 ? (
            <div className={settingsGroup}>
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

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

/** The scrolling speeds the slider steps through, 1 as the mouse sends it. */
const SCROLL_SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * Settings → Mouse (window.dinos.mouse): how the pointer and scrolling go,
 * which din-shell applies to every mouse, and a Magic Mouse's own. Only under
 * din-shell; elsewhere the desktop Din runs in has its own.
 */
function MouseSection() {
  const { config, updateConfig } = useAppContext();
  const set = (patch: Partial<AppConfig>) => updateConfig((current) => ({ ...current, ...patch }));
  const [available, setAvailable] = useState<boolean | null>(() => (getMouseBridge() ? null : false));
  useEffect(() => {
    getMouseBridge()?.status().then((s) => setAvailable(s.available), () => setAvailable(false));
  }, []);
  const [tracking, setTracking] = useState(config.mouseTrackingSpeed);
  const [lastTracking, setLastTracking] = useState(config.mouseTrackingSpeed);
  if (config.mouseTrackingSpeed !== lastTracking) {
    setLastTracking(config.mouseTrackingSpeed);
    setTracking(config.mouseTrackingSpeed);
  }
  const scrollIndex = Math.max(0, SCROLL_SPEEDS.findIndex((s) => s >= config.mouseScrollSpeed));

  if (available === null) return <SectionShell title="Mouse"><Skeleton className="h-40 w-full" /></SectionShell>;
  if (!available) {
    return (
      <SectionShell title="Mouse">
        <FallbackCard icon={Mouse}>
          Din’s mouse settings are for DinOS. Here, the mouse is set up in the settings of the desktop Din runs in.
        </FallbackCard>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Mouse">
      <div className={cn(settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="mouse-tracking" className="text-sm">Tracking speed</Label>
          <span className="text-xs text-muted-foreground">{tracking === 0 ? 'Normal' : tracking < 0 ? 'Slower' : 'Faster'}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Slow</span>
          <Slider
            id="mouse-tracking"
            aria-label="Tracking speed"
            value={[tracking]}
            min={-1}
            max={1}
            step={0.1}
            onValueChange={([v]) => setTracking(v)}
            onValueCommit={([v]) => set({ mouseTrackingSpeed: Math.round(v * 10) / 10 })}
          />
          <span className="text-xs text-muted-foreground">Fast</span>
        </div>
      </div>
      <div className={cn(settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="mouse-scroll-speed" className="text-sm">Scrolling speed</Label>
          <span className="text-xs tabular-nums text-muted-foreground">{SCROLL_SPEEDS[scrollIndex]}×</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Slow</span>
          <Slider
            id="mouse-scroll-speed"
            aria-label="Scrolling speed"
            value={[scrollIndex]}
            min={0}
            max={SCROLL_SPEEDS.length - 1}
            step={1}
            onValueChange={([i]) => set({ mouseScrollSpeed: SCROLL_SPEEDS[i] })}
          />
          <span className="text-xs text-muted-foreground">Fast</span>
        </div>
      </div>
      <SettingsGroup>
        <ChoiceRow
          label="Scroll direction"
          description="Natural moves the page along with your finger, as on a phone. Automatic is natural on a touchpad and a Magic Mouse, and a scroll wheel’s way with a wheel."
          value={config.mouseScrollDirection}
          choices={[
            { value: 'auto', name: 'Automatic' },
            { value: 'natural', name: 'Natural' },
            { value: 'traditional', name: 'Traditional' },
          ]}
          onChange={(mouseScrollDirection) => set({ mouseScrollDirection })}
        />
        <ChoiceRow
          label="Secondary click"
          description="The click that opens a right-click menu. Left swaps the buttons, for the left hand."
          value={config.mouseSecondaryClick}
          choices={[
            { value: 'right', name: 'Right side' },
            { value: 'left', name: 'Left side' },
            { value: 'off', name: 'Off' },
          ]}
          onChange={(mouseSecondaryClick) => set({ mouseSecondaryClick })}
        />
      </SettingsGroup>

      <SubHeading>Magic Mouse</SubHeading>
      <SettingsGroup>
        <ChoiceRow
          label="Swipe with two fingers"
          description="Swiping two fingers sideways goes Back and Forward in the Web Browser, or to the workspace beside. One finger scrolls, and a quick flick keeps going."
          value={config.mouseSwipe}
          choices={[
            { value: 'pages', name: 'Between pages' },
            { value: 'workspaces', name: 'Between workspaces' },
            { value: 'off', name: 'Off' },
          ]}
          onChange={(mouseSwipe) => set({ mouseSwipe })}
        />
        <SettingSwitchRow
          id="mouse-middle-click"
          label="Middle click"
          description="Clicking the middle of the mouse is a middle click, which opens links in new tabs and pastes the selection in a terminal. On a Mac it’s a click."
          checked={config.mouseMiddleClick}
          onCheckedChange={(mouseMiddleClick) => set({ mouseMiddleClick })}
        />
      </SettingsGroup>
    </SectionShell>
  );
}

/**
 * The system's keyboard layouts (window.dinos.keyboard), which Din's own
 * windows and the native Linux apps it runs both type with: up to four, the
 * first the one the computer starts with (and the boot screen and text
 * consoles use). Where Din can (DinOS, GNOME) they're added from
 * xkeyboard-config's list, removed and reordered; on DinOS, with more than
 * one, the menu bar and Ctrl+Space switch between them.
 */
/**
 * Settings → Keyboard: the keyboard's layouts, and checking grammar as you
 * type in every text field.
 */
function KeyboardSection() {
  return (
    <SectionShell title="Keyboard">
      <KeyboardLayouts />
      <GrammarSettings />
    </SectionShell>
  );
}

/**
 * Checking grammar as you type, in every text field on Din (electron/grammar.mts):
 * on or off, style suggestions, which English, the rules turned off from a
 * right-click's Turn Off This Rule, and the issues ignored. `din grammar`
 * does the same.
 */
function GrammarSettings() {
  const bridge = getGrammarBridge();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['grammar-state'], queryFn: () => bridge!.state(), enabled: !!bridge });
  const [error, setError] = useState<string | null>(null);
  if (!bridge) return null;

  const change = (run: () => Promise<GrammarState>) => {
    setError(null);
    run().then(
      (next) => queryClient.setQueryData(['grammar-state'], next),
      (e: unknown) => setError(cleanBridgeError(e)),
    );
  };

  return (
    <>
      <SubHeading>Grammar</SubHeading>
      {state.isLoading || !state.data ? (
        <div className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')} aria-hidden>
          <Skeleton className="size-4 bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40 bg-foreground/10" />
            <Skeleton className="h-3 w-64 bg-foreground/10" />
          </div>
        </div>
      ) : (
        <GrammarControls state={state.data} change={change} bridge={bridge} />
      )}
      {(error || state.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? 'Could not read the grammar settings.'}
        </p>
      )}
    </>
  );
}

function cleanBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

function GrammarControls({
  state,
  change,
  bridge,
}: {
  state: GrammarState;
  change: (run: () => Promise<GrammarState>) => void;
  bridge: NonNullable<ReturnType<typeof getGrammarBridge>>;
}) {
  return (
    <>
      <SettingsGroup>
        <SettingSwitchRow
          id="grammar-enabled"
          icon={SpellCheck}
          label="Check grammar as you type"
          description="Grammar problems get a blue underline in any text field, as misspellings get a red one. Right-click one to fix it. Checked on this computer: what you type never leaves it."
          checked={state.enabled}
          onCheckedChange={(enabled) => change(() => bridge.configure({ enabled }))}
        />
        <SettingSwitchRow
          id="grammar-style"
          label="Suggest style improvements"
          description="Wordy, redundant or hard-to-read phrasing too, not just what’s wrong."
          checked={state.style}
          disabled={!state.enabled}
          onCheckedChange={(style) => change(() => bridge.configure({ style }))}
        />
        <ChoiceRow<GrammarDialect>
          label="English"
          description="Spellings and usage differ between them: colour or color, at the weekend or on the weekend."
          value={state.dialect}
          choices={GRAMMAR_DIALECTS}
          onChange={(dialect) => change(() => bridge.configure({ dialect }))}
        />
      </SettingsGroup>

      {state.disabledRuleInfo.length > 0 && (
        <>
          <p className="px-1 text-xs text-muted-foreground">Rules you turned off from a right-click menu:</p>
          <ul aria-label="Grammar rules turned off" className={settingsGroup}>
            {state.disabledRuleInfo.map((rule) => (
              <GrammarRuleRow key={rule.name} rule={rule} onTurnOn={() => change(() => bridge.setRule(rule.name, true))} />
            ))}
          </ul>
        </>
      )}

      {state.ignored > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => change(() => bridge.forgetIgnored())}>
            <RotateCcw aria-hidden />
            Forget Ignored Issues
          </Button>
          <p className="text-xs text-muted-foreground">
            {state.ignored === 1 ? 'One issue you ignored isn’t underlined.' : `${state.ignored} issues you ignored aren’t underlined.`}
          </p>
        </div>
      )}
    </>
  );
}

/** A rule turned off: what it looks for, and turning it back on, from its button or a right-click. */
function GrammarRuleRow({ rule, onTurnOn }: { rule: GrammarRule; onTurnOn: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{ruleName(rule.name)}</span>
            {rule.description && <span className="block text-xs text-muted-foreground">{ruleDescription(rule.description)}</span>}
          </span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onTurnOn}>
            Turn On
          </Button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onTurnOn}>
          <Check aria-hidden />
          Turn On
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function KeyboardLayouts() {
  const bridge = getKeyboardBridge();
  const status = useKeyboardStatus();
  const setLayouts = useSetKeyboardLayouts();
  const selectLayout = useSelectKeyboardLayout();
  const restart = useRestartForKeyboardLayout();
  const [adding, setAdding] = useState(false);

  if (!bridge) {
    return (
      <>
        <FallbackCard icon={Keyboard}>
          Keyboard layouts need the Din desktop shell; they aren't available in
          a plain browser.
        </FallbackCard>
      </>
    );
  }

  if (status.isLoading) {
    return (
      <>
        <div className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')} aria-hidden>
          <Skeleton className="size-4 bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32 bg-foreground/10" />
            <Skeleton className="h-3 w-56 bg-foreground/10" />
          </div>
        </div>
      </>
    );
  }

  if (status.isError || !status.data) {
    return (
      <>
        <FallbackCard>Could not read the keyboard layout.</FallbackCard>
      </>
    );
  }

  const { layout, canChange, canSwitch, restartNeeded } = status.data;
  // While a change is in flight, show the requested list.
  const layouts: KeyboardLayout[] = setLayouts.isPending
    ? setLayouts.variables.map((choice) => ({ ...choice, name: nameOf(choice, status.data.layouts) }))
    : status.data.layouts;
  const active = selectLayout.isPending ? selectLayout.variables : status.data.active;
  const full = layouts.length >= MAX_KEYBOARD_LAYOUTS;
  const change = (next: KeyboardLayoutChoice[] | null) => {
    if (next) setLayouts.mutate(next);
  };
  /** A menu item's action, when the change it makes can be made. */
  const changer = (next: KeyboardLayoutChoice[] | null) => (canChange && next ? () => change(next) : undefined);

  return (
    <>
      <div className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')}>
        <SettingsToken icon={Keyboard} />
        <div className="min-w-0">
          <p className="text-sm text-foreground">{layout.name}</p>
          <p className="text-xs text-muted-foreground">
            {!canChange
              ? 'Din uses your system’s layout. Change it in your desktop’s keyboard settings.'
              : layouts.length > 1
                ? 'The layout typing now.'
                : 'The layout everything on this computer types with.'}
          </p>
        </div>
      </div>

      {restartNeeded && (
        <div className={cn(settingsNotice, 'flex items-center justify-between gap-4 p-4')}>
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

      <SubHeading>Layouts</SubHeading>
      <ul aria-label="Keyboard layouts" className={settingsGroup}>
        {layouts.map((entry, index) => (
          <KeyboardLayoutRow
            key={layoutKey(entry)}
            entry={entry}
            tag={layoutTag(entry, layouts)}
            first={index === 0}
            typing={layouts.length > 1 && index === active}
            onUse={canSwitch && index !== active ? () => selectLayout.mutate(index) : undefined}
            onMoveUp={changer(withLayoutMoved(layouts, index, -1))}
            onMoveDown={changer(withLayoutMoved(layouts, index, 1))}
            onRemove={changer(withLayoutRemoved(layouts, index))}
            editable={canChange}
          />
        ))}
      </ul>

      {canChange && !adding && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={full} onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add Layout…
          </Button>
          {full && (
            <p className="text-xs text-muted-foreground">
              A keyboard can have {MAX_KEYBOARD_LAYOUTS} layouts at once. Remove one to add another.
            </p>
          )}
        </div>
      )}

      {canChange && adding && (
        <KeyboardLayoutPicker
          configured={layouts}
          onPick={(choice) => {
            change(withLayoutAdded(layouts, choice));
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {canSwitch && (
        <p className="text-xs text-muted-foreground">
          Switch layouts from the menu bar, or press{' '}
          <kbd className="rounded-md bg-foreground/[0.07] px-1 font-mono">{LAYOUT_SWITCH_KEYS.previous}</kbd>{' '}
          for the one you used last and{' '}
          <kbd className="rounded-md bg-foreground/[0.07] px-1 font-mono">{LAYOUT_SWITCH_KEYS.next}</kbd>{' '}
          for the next. Keep Ctrl held and press Space again to go further back.
        </p>
      )}
      {canChange && layouts.length > 1 && (
        <p className="text-xs text-muted-foreground">
          The first layout is the one the computer starts with, and the one its password is typed with.
        </p>
      )}

      {(setLayouts.isError || selectLayout.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(setLayouts.error ?? selectLayout.error) instanceof Error
            ? (setLayouts.error ?? selectLayout.error)!.message
            : 'Could not change the keyboard layout.'}
        </p>
      )}

      {restart.isError && (
        <p role="alert" className="text-sm text-destructive">
          {restart.error instanceof Error ? restart.error.message : 'Could not restart Din.'}
        </p>
      )}
    </>
  );
}

/** A layout's name, from the list it's in, or its XKB name. */
function nameOf(choice: KeyboardLayoutChoice, layouts: KeyboardLayout[]): string {
  const found = layouts.find((entry) => layoutKey(entry) === layoutKey(choice));
  return found?.name ?? (choice.variant ? `${choice.layout} (${choice.variant})` : choice.layout);
}

/**
 * One of the system's layouts: its tag, its name, and, in its ⋯ and
 * right-click menus, typing with it, moving it and removing it.
 */
function KeyboardLayoutRow({
  entry,
  tag,
  first,
  typing,
  editable,
  onUse,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  entry: KeyboardLayout;
  tag: string;
  first: boolean;
  typing: boolean;
  editable: boolean;
  onUse?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
}) {
  const actions: { label: string; icon: LucideIcon; onSelect?: () => void; destructive?: boolean; separated?: boolean }[] = [
    ...(onUse ? [{ label: 'Type with This Layout', icon: Check, onSelect: onUse }] : []),
    ...(editable
      ? [
          { label: 'Move Up', icon: ArrowUp, onSelect: onMoveUp },
          { label: 'Move Down', icon: ArrowDown, onSelect: onMoveDown },
          { label: 'Remove', icon: Trash2, onSelect: onRemove, destructive: true, separated: true },
        ]
      : []),
  ];
  const row = (
    <li
      className="flex items-center gap-3 px-4 py-2.5"
    >
      <span
        aria-hidden
        className="flex h-6 min-w-9 shrink-0 items-center justify-center rounded-md bg-foreground/10 px-1 text-[0.6875rem] font-semibold tracking-wide text-foreground/90"
      >
        {tag}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{entry.name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {entry.variant ? `${entry.layout}(${entry.variant})` : entry.layout}
        </span>
      </span>
      {typing && <span className="shrink-0 text-xs font-medium text-ink-accent">Typing</span>}
      {first && <span className="shrink-0 text-xs text-muted-foreground">Default</span>}
      {actions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`${entry.name}: more`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map((action) => (
              <Fragment key={action.label}>
                {action.separated && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={!action.onSelect}
                  variant={action.destructive ? 'destructive' : undefined}
                  onSelect={action.onSelect}
                >
                  <action.icon aria-hidden />
                  {action.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
  if (actions.length === 0) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => (
          <Fragment key={action.label}>
            {action.separated && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={!action.onSelect}
              variant={action.destructive ? 'destructive' : undefined}
              onSelect={action.onSelect}
            >
              <action.icon aria-hidden />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** xkeyboard-config's layouts, searchable; picking one adds it. */
function KeyboardLayoutPicker({
  configured,
  onPick,
  onCancel,
}: {
  configured: KeyboardLayoutChoice[];
  onPick: (choice: KeyboardLayoutChoice) => void;
  onCancel: () => void;
}) {
  const layouts = useKeyboardLayouts();
  const [query, setQuery] = useState('');
  const have = useMemo(() => new Set(configured.map(layoutKey)), [configured]);

  const filtered = useMemo(() => {
    const all = layouts.data ?? [];
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return all;
    return all.filter((entry) => {
      const haystack = `${entry.name} ${entry.layout} ${entry.variant}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [layouts.data, query]);

  return (
    <div className={cn(settingsCard, 'flex flex-col gap-2 p-2')}>
      <div className="flex items-center gap-2">
        <SearchField
          size="sm"
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel();
          }}
          placeholder="Search layouts"
          aria-label="Search keyboard layouts"
          className="flex-1"
        />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
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
        <ul aria-label="Layouts to add" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0">
          {filtered.map((entry) => {
            const key = layoutKey(entry);
            const added = have.has(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  disabled={added}
                  onClick={() => onPick({ layout: entry.layout, variant: entry.variant })}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                    focusRing,
                    added ? 'opacity-60' : 'hover:bg-foreground/5',
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                    {added ? <Check className="size-3.5" /> : <Plus className="size-3.5 text-muted-foreground" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {entry.name}
                    {added && <span className="sr-only"> (added)</span>}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {entry.variant ? `${entry.layout}(${entry.variant})` : entry.layout}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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

/** The time and date right now. Its own component so only it re-renders every second. */
function DateTimeNow() {
  const now = useClock();
  const { config } = useAppContext();

  return (
    <div className={cn(settingsCard, 'flex items-center gap-4 p-4')}>
      <SettingsToken icon={Clock} className="size-10 [&_svg]:size-5" />
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

  const { timeZone, automatic, synchronized, canChange, canAutomatic, zoneDetection } = status.data;
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
                  ? zoneDetection !== null
                    ? 'The clock follows internet time servers, and the time zone where you are.'
                    : 'Kept in step with internet time servers.'
                  : 'Waiting to reach an internet time server.'
                : 'The clock and time zone stay as you set them.'
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
      <TimeZonePicker
        current={timeZone}
        canChange={canChange}
        // While Din sets it, it isn't picked by hand.
        detection={isAutomatic && zoneDetection !== null ? zoneDetection : null}
      />
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
      className={cn(settingsCard, 'flex flex-col gap-3 px-4 py-3')}
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

/** What the time zone card says while the time zone is set automatically. */
const DETECTION_NOTE: Record<NonNullable<DateTimeStatus['zoneDetection']>, string> = {
  pending: 'Finding where you are…',
  detecting: 'Finding where you are…',
  found: 'Set from where you are.',
  failed: 'Couldn’t find where you are yet; it tries again once you’re online. To choose it yourself, turn off Set time automatically.',
};

function TimeZonePicker({
  current,
  canChange: systemCanChange,
  detection,
}: {
  current: string;
  canChange: boolean;
  /** How finding it is going, while it's set automatically; null while it's picked by hand. */
  detection: DateTimeStatus['zoneDetection'];
}) {
  const automatic = detection !== null;
  const canChange = systemCanChange && !automatic;
  const zones = useTimeZones();
  const places = useZonePlaces();
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
    // Countries and parts of them, so "Texas" won't find it but "United States" or "Central" will.
    const placeOf = new Map((places.data ?? []).map((place) => [place.zone, place]));
    let countryName: (code: string) => string = (code) => code;
    try {
      const names = new Intl.DisplayNames([], { type: 'region' });
      countryName = (code) => names.of(code) ?? code;
    } catch {
      // codes, then
    }
    return (zones.data ?? []).map((zone) => {
      const place = placeOf.get(zone);
      const where = place ? `${place.countries.map(countryName).join(' ')} ${place.comment}` : '';
      return { zone, ...describeZone(zone), offset: zoneOffset(zone, at), where: `${where} ${zoneLongName(zone, at)}` };
    });
  }, [zones.data, places.data]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((entry) => {
      const haystack = `${entry.city} ${entry.region} ${entry.zone} ${entry.offset} ${entry.where}`.toLowerCase();
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
      <div className={cn(settingsCard, 'flex items-center gap-3 px-4 py-3')}>
        <SettingsToken icon={Globe} />
        <div className="min-w-0">
          <p className="text-sm text-foreground">
            {city}
            {region && <span className="text-muted-foreground"> · {region}</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {[longName, offset].filter(Boolean).join(', ')}
          </p>
          {detection && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              {(detection === 'pending' || detection === 'detecting') && (
                <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
              )}
              {DETECTION_NOTE[detection]}
            </p>
          )}
        </div>
      </div>

      {systemCanChange && (places.data?.length ?? 0) > 0 && (
        <TimeZoneMap
          current={selected ?? current}
          places={places.data ?? []}
          disabled={automatic}
          onPick={(zone) => setZone.mutate(zone)}
        />
      )}

      {canChange && (
        <>
          <p className="text-xs text-muted-foreground">
            Click where you are on the map, or search for a city in your time zone.
          </p>
          <SearchField
            size="sm"
            value={query}
            onValueChange={setQuery}
            placeholder="Search cities and regions"
            aria-label="Search time zones"
          />

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
              className={cn(settingsCard, 'flex max-h-80 flex-col gap-0.5 overflow-y-auto p-1 [&>*]:shrink-0')}
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
                      focusRing,
                      active ? 'bg-selected' : 'hover:bg-foreground/5',
                    )}
                  >
                    <RadioMark checked={active} />
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
        <SegmentedControl
          label="Clock format"
          size="md"
          value={config.clockFormat}
          options={formats.map((option) => ({
            value: option.value,
            label: `${option.name} · ${SAMPLE_TIME.toLocaleTimeString([], timeFormatOptions(option.value))}`,
          }))}
          onValueChange={(clockFormat) => updateConfig((current) => ({ ...current, clockFormat }))}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground">
          Automatic follows your language’s custom. The menu bar, boot screen, and lock screen all use it.
        </p>
        <SettingsGroup>
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
        </SettingsGroup>
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
  const { config, updateConfig } = useAppContext();

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
        <SettingSwitchRow
          id="notif-resource-alerts"
          icon={Gauge}
          label="Warn about programs slowing the computer down"
          description="The System Monitor tells you when a program keeps the processor busy for a minute, or holds the most memory while it's running out, and offers to stop it."
          checked={config.resourceAlerts}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, resourceAlerts: checked }))}
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
      <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
        <p role="alert" className={cn(settingsAlert, 'flex items-start gap-2 px-4 py-3 text-xs text-foreground')}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Your signer doesn't support NIP-44 encryption, so settings stay on this
          device. Upgrade your signer to enable encrypted sync.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <SubHeading>Relays</SubHeading>
          <p className="px-1 text-xs text-muted-foreground">
            Nostr relays Din reads from and publishes to (NIP-65).
          </p>
        </div>
        <RelayListManager />
      </div>

      <div className="space-y-3">
        <div>
          <SubHeading>Blossom servers</SubHeading>
          <p className="px-1 text-xs text-muted-foreground">
            Servers where Din stores files like your avatar (BUD-03).
          </p>
        </div>
        <BlossomServerManager />
      </div>

      <NostrLinkSettings />
      <WebsiteLinkSettings />
    </SectionShell>
  );
}

/** Small pill showing the aggregate state of Din's encrypted app-data sync. */
function SyncStatusBadge({ status }: { status: ReturnType<typeof useAppDataSyncStatus> }) {
  const view = {
    local: { icon: CloudOff, label: 'Local only', className: 'text-muted-foreground' },
    syncing: { icon: Loader2, label: 'Syncing…', className: 'text-muted-foreground' },
    synced: { icon: Check, label: 'Synced', className: 'text-ink-accent' },
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

/** The wallpaper of the desktops Settings draws in miniature, in the theme's primary. */
const PREVIEW_WALLPAPER = 'bg-linear-to-br from-primary/85 via-primary/55 to-foreground/35';

/** The stand-in apps on the miniature desktops' Docks and taskbars. */
const PREVIEW_APPS = ['bg-card', 'bg-card/75', 'bg-card/50'];

type GlassChoice = 'liquid' | 'frosted' | 'solid';

const GLASS_CHOICES: { value: GlassChoice; name: string }[] = [
  { value: 'liquid', name: 'Liquid' },
  { value: 'frosted', name: 'Frosted' },
  { value: 'solid', name: 'Solid' },
];

/** A menu of the given glass over shapes for it to blur and bend; the wrapper names the material, so it shows whatever's chosen. */
function GlassPreview({ material }: { material: GlassChoice }) {
  return (
    <span className="absolute inset-0" style={{ '--glass-material': material } as React.CSSProperties}>
      <span className="absolute top-1 left-2 size-8 rounded-full bg-amber-300" />
      <span className="absolute right-3 bottom-1 h-6 w-12 rotate-12 rounded-md bg-emerald-300" />
      <span className="absolute top-5 left-1/2 h-1.5 w-full -translate-x-1/2 -rotate-6 bg-white/70" />
      <span className="glass-surface absolute inset-x-5 top-2.5 bottom-2.5 flex flex-col justify-center gap-1 rounded-lg px-2">
        <span className="h-1 w-3/4 rounded-full bg-foreground/60" />
        <span className="h-1 w-1/2 rounded-full bg-foreground/40" />
        <span className="h-1 w-2/3 rounded-full bg-foreground/40" />
      </span>
    </span>
  );
}

function ThemesSection() {
  const { config, updateConfig } = useAppContext();
  // Solid is Accessibility's Reduce transparency, which Increase contrast implies.
  const material: GlassChoice = config.reduceTransparency || config.increaseContrast ? 'solid' : config.glass;
  return (
    <SectionShell title="Themes">
      <ThemeSettings />
      <SubHeading>Glass</SubHeading>
      <PicturedChoices
        label="Glass"
        options={GLASS_CHOICES}
        value={material}
        onChange={(value) =>
          updateConfig((current) =>
            value === 'solid' ? { ...current, reduceTransparency: true } : { ...current, reduceTransparency: false, glass: value },
          )
        }
        preview={(value) => <GlassPreview material={value} />}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        What menus, popovers, notifications, the menu bar’s panels and windows’ frames are made of.
        {config.increaseContrast && ' Solid while Increase contrast is on, in Accessibility.'}
      </p>
    </SectionShell>
  );
}

function CursorsSection() {
  return (
    <SectionShell title="Cursors">
      {getSystemCursorBridge() ? (
        <SystemCursorPicker />
      ) : (
        <FallbackCard>The cursor is your browser’s.</FallbackCard>
      )}

      <SubHeading>Cursor effects</SubHeading>
      <CursorEffectsSettings />
    </SectionShell>
  );
}

function IconsSection() {
  return (
    <SectionShell title="Icons">
      {getIconThemeBridge() ? (
        <IconThemePicker />
      ) : (
        <FallbackCard>Din uses its own icons in the browser.</FallbackCard>
      )}
    </SectionShell>
  );
}

function EffectsSection({ windowId }: { windowId: string }) {
  const { config, updateConfig } = useAppContext();

  return (
    <SectionShell title="Effects">
      <SubHeading>Windows</SubHeading>
      <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
        <div className="min-w-0">
          <Label htmlFor="wobbly-windows" className="cursor-pointer text-sm">
            Wobbly windows
          </Label>
          <p className="text-xs text-muted-foreground">
            Windows wriggle like jelly while you drag them, Compiz style.
            Off while Reduce motion is on, in Accessibility or the system.
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

      <SubHeading>Typing</SubHeading>
      <PowerModeSettings />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

/**
 * Din's own accessibility preferences (src/lib/accessibility.ts), which
 * reach its apps with the theme and, on DinOS, Linux apps through GSettings.
 */
function AccessibilitySection() {
  const { config, updateConfig } = useAppContext();
  const set = (patch: Partial<AppConfig>) => updateConfig((current) => ({ ...current, ...patch }));
  const textSize = clampTextSize(config.textSize);
  // Zoom, colour filters and the keyboard aids are din-shell's.
  const [screen, setScreen] = useState(false);
  useEffect(() => {
    getAccessibilityBridge()?.status().then((s) => setScreen(s.screen), () => setScreen(false));
  }, []);

  return (
    <SectionShell title="Accessibility">
      <SubHeading>Display</SubHeading>
      <SettingsGroup>
        <SettingSwitchRow
          id="reduce-motion"
          icon={Zap}
          label="Reduce motion"
          description="Windows, the Dock and menus appear and move without animating, and effects like wobbly windows and cursor trails stay still. Apps are asked to do the same."
          checked={config.reduceMotion}
          onCheckedChange={(reduceMotion) => set({ reduceMotion })}
        />
        <SettingSwitchRow
          id="reduce-transparency"
          icon={Blend}
          label="Reduce transparency"
          description="The menu bar, Dock, windows and panels are solid instead of frosted glass."
          checked={config.reduceTransparency || config.increaseContrast}
          disabled={config.increaseContrast}
          onCheckedChange={(reduceTransparency) => set({ reduceTransparency })}
        />
        <SettingSwitchRow
          id="increase-contrast"
          icon={Contrast}
          label="Increase contrast"
          description="Borders, fields and secondary text are darker in a light theme and lighter in a dark one, and the focused control gets a thick outline. Also reduces transparency."
          checked={config.increaseContrast}
          onCheckedChange={(increaseContrast) => set({ increaseContrast })}
        />
      </SettingsGroup>

      <SubHeading>Size</SubHeading>
      <div className={cn(settingsCard, 'flex flex-col gap-3 px-4 py-3')}>
        <div className="flex items-center gap-3">
          <SettingsToken icon={Type} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="text-size" className="text-sm">Text size</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{textSize}%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Makes text larger without zooming everything else.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" aria-hidden>A</span>
          <Slider
            id="text-size"
            aria-label="Text size"
            value={[textSize]}
            min={MIN_TEXT_SIZE}
            max={MAX_TEXT_SIZE}
            step={TEXT_SIZE_STEP}
            onValueChange={([value]) => set({ textSize: clampTextSize(value) })}
          />
          <span className="text-lg text-muted-foreground" aria-hidden>A</span>
        </div>
      </div>
      <InterfaceZoom />

      {screen ? (
        <>
          <SubHeading>Zoom</SubHeading>
          <SettingSwitchRow
            id="screen-zoom-keys"
            icon={ZoomIn}
            label="Zoom the screen with the keyboard"
            description="Super+Alt+8 zooms in on the display the pointer’s on, or back out, and Super+Alt+= and Super+Alt+− zoom further in or out. Move the pointer to an edge to see what’s there."
            checked={config.screenZoomKeys}
            onCheckedChange={(screenZoomKeys) => set({ screenZoomKeys })}
          />

          <SubHeading>Color filters</SubHeading>
          <ChoiceRow
            label="Color filter"
            description="Changes the colors of everything on the screen, Linux apps included. Screenshots keep the real colors. The color blindness filters move the colors you can’t tell apart to ones you can."
            value={config.colorFilter}
            choices={COLOR_FILTERS.map((value) => ({ value, name: COLOR_FILTER_NAMES[value] }))}
            onChange={(colorFilter) => set({ colorFilter })}
          />

          <SubHeading>Keyboard</SubHeading>
          <SettingsGroup>
            <SettingSwitchRow
              id="sticky-keys"
              icon={Keyboard}
              label="Sticky keys"
              description="Press Shift, Ctrl, Alt or Super and let go, and it stays down for the next key, so shortcuts need one key at a time. Press it twice to keep it down until you press it again."
              checked={config.stickyKeys}
              onCheckedChange={(stickyKeys) => set({ stickyKeys })}
            />
            <SettingSwitchRow
              id="slow-keys"
              icon={Keyboard}
              label="Slow keys"
              description="A key only types once it’s been held for a moment, so brushing past one doesn’t."
              checked={config.slowKeys}
              onCheckedChange={(slowKeys) => set({ slowKeys })}
            />
            <SettingSwitchRow
              id="bounce-keys"
              icon={Keyboard}
              label="Bounce keys"
              description="A key pressed again just after it came up is ignored, so a shaky press types once."
              checked={config.bounceKeys}
              onCheckedChange={(bounceKeys) => set({ bounceKeys })}
            />
          </SettingsGroup>
        </>
      ) : (
        <FallbackCard icon={ZoomIn}>
          Zooming the screen, color filters, and sticky, slow and bounce keys are for DinOS. Here, the desktop Din runs in has its own.
        </FallbackCard>
      )}
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
      <SettingsGroup>
        <SettingSwitchRow
          id="tiling-enabled"
          icon={LayoutDashboard}
          label="Tile windows"
          description="Windows share the screen side by side instead of overlapping, like Hyprland. Super+T floats one. Super+Shift+T turns tiling on or off."
          checked={config.tilingEnabled}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, tilingEnabled: checked }))}
        />
        <SettingSwitchRow
          id="restore-windows"
          icon={History}
          label="Reopen windows when Din starts"
          description="After Din restarts, updates or the computer starts up, your windows come back where they were, with their tabs and folders. Anything unsaved in them is still lost."
          checked={config.restoreWindows}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, restoreWindows: checked }))}
        />
      </SettingsGroup>
      <div className={cn(settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
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
        <div key={group.group} className="flex flex-col gap-2">
          <SubHeading>{group.group}</SubHeading>
          <div className={settingsGroup}>
            {group.bindings.map((b) => (
              <div key={b.label} className="flex items-center justify-between gap-4 px-4 py-2">
                <span className="text-sm text-foreground">{b.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {b.keys.map((k) => (
                    <kbd
                      key={k}
                      className="rounded-md bg-foreground/[0.07] px-1.5 py-0.5 font-sans text-xs text-foreground"
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

const DESKTOP_ICON_SIZE_CHOICES: { value: DesktopIconSize; name: string }[] = [
  { value: 'small', name: 'Small' },
  { value: 'medium', name: 'Medium' },
  { value: 'large', name: 'Large' },
];

/**
 * Desktop icons: whether what's in ~/Desktop shows on the wallpaper, how
 * large, and arranging them, as the desktop's right-click menu does.
 */
function DesktopSection() {
  const { config, updateConfig } = useAppContext();
  const icons = useDesktopIcons();

  return (
    <SectionShell title="Desktop">
      <SettingSwitchRow
        id="desktop-icons"
        icon={Grid2x2}
        label="Show desktop icons"
        description="Files, folders and app shortcuts in your Desktop folder show on the wallpaper. Drop files there to put them on the desktop, or drag an app out of the apps menu."
        checked={config.desktopIcons}
        onCheckedChange={(checked) => updateConfig((current) => ({ ...current, desktopIcons: checked }))}
      />
      <SubHeading>Icon size</SubHeading>
      <PicturedChoices
        label="Icon size"
        options={DESKTOP_ICON_SIZE_CHOICES}
        value={config.desktopIconSize}
        onChange={(value) => updateConfig((current) => ({ ...current, desktopIconSize: value }))}
        preview={(value) => <DesktopIconSizePreview size={value} />}
      />
      <SubHeading>Arrange</SubHeading>
      <div className="flex flex-wrap gap-2">
        {DESKTOP_ICON_SORTS.map((sort) => (
          <Button key={sort.value} variant="outline" size="sm" disabled={!icons.shown} onClick={() => icons.arrange(sort.value)}>
            By {sort.name.toLowerCase()}
          </Button>
        ))}
        <Button variant="outline" size="sm" disabled={!icons.shown} onClick={() => icons.arrange()}>
          Clean up
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sorting lays the icons out again from the top-left corner. You can also right-click the desktop to sort or clean up.
      </p>
      {icons.dir && (
        <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
          <div className="min-w-0">
            <p className="text-sm">Desktop folder</p>
            <p className="truncate text-xs text-muted-foreground select-text">{icons.dir}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => icons.showInFiles()}>
            Show in Files
          </Button>
        </div>
      )}
    </SectionShell>
  );
}

/** A few icons on a wallpaper, at a size. */
function DesktopIconSizePreview({ size }: { size: DesktopIconSize }) {
  const px = size === 'small' ? 'size-2.5' : size === 'medium' ? 'size-3.5' : 'size-5';
  return (
    <span className="absolute inset-0 flex flex-col gap-1.5 p-2">
      {PREVIEW_APPS.map((color) => (
        <span key={color} className={cn('rounded-[3px] shadow-sm', px, color)} />
      ))}
    </span>
  );
}

/** The desktop's layouts, for the picker at the top of the Dock & Taskbar section. */
const DESKTOP_LAYOUTS: { value: DesktopLayout; name: string }[] = [
  { value: 'dock', name: 'Menu bar and Dock' },
  { value: 'taskbar', name: 'Taskbar' },
];

/**
 * The desktop's layout, then the Dock's size, magnification and backdrop,
 * or the taskbar's position, size and whether it combines windows. The
 * Dock's own right-click menu offers the last two, less the magnification
 * level; the taskbar's offers its three and the way back to the Dock.
 */
function DockSection() {
  const { config, updateConfig } = useAppContext();

  return (
    <SectionShell title="Dock & Taskbar">
      <SubHeading>Layout</SubHeading>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Desktop layout">
        {DESKTOP_LAYOUTS.map((option) => {
          const active = config.desktopLayout === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => updateConfig((current) => ({ ...current, desktopLayout: option.value }))}
              className={cn(
                settingsChoiceClass(active),
                'flex min-w-0 flex-col items-center gap-2 p-2',
              )}
            >
              <LayoutPreview layout={option.value} />
              <span className="text-xs">{option.name}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        The taskbar puts the Start menu, your apps and windows, and the status icons and clock in one bar along an edge of the screen, Windows style. It keeps the Dock’s pinned apps, and apps’ menus move into their windows.
      </p>
      {config.desktopLayout === 'dock' ? <DockOptions /> : <TaskbarOptions />}
    </SectionShell>
  );
}

/** A small picture of a desktop layout over a wallpaper, for its choice in the picker. */
function LayoutPreview({ layout }: { layout: DesktopLayout }) {
  return (
    <span aria-hidden className={cn('relative flex h-20 w-full flex-col overflow-hidden rounded-lg', PREVIEW_WALLPAPER)}>
      {layout === 'dock' && <span className="h-2 w-full shrink-0 bg-linear-to-b from-black/30 to-transparent" />}
      <span className="relative flex-1">
        <span className="absolute top-3 left-1/4 h-8 w-1/2 rounded-sm bg-white/80 shadow" />
      </span>
      {layout === 'dock' ? (
        <span className="mx-auto mb-1 flex gap-1 rounded-md bg-white/30 px-1.5 py-1 backdrop-blur">
          {PREVIEW_APPS.map((color) => (
            <span key={color} className={cn('size-3 rounded-[3px]', color)} />
          ))}
        </span>
      ) : (
        <span className="flex h-4 w-full shrink-0 items-center gap-1 bg-black/45 px-1">
          <span className="size-3 rounded-full bg-card ring-1 ring-white/40" />
          {PREVIEW_APPS.map((color) => (
            <span key={color} className={cn('size-2.5 rounded-[2px]', color)} />
          ))}
          <span className="ml-auto h-1.5 w-4 rounded-full bg-white/60" />
        </span>
      )}
    </span>
  );
}

/** The Dock's size, magnification and backdrop. */
function DockOptions() {
  const { config, updateConfig } = useAppContext();

  return (
    <>
      <SubHeading>Dock</SubHeading>
      <div className={cn(settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
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
          settingsCard,
          'flex flex-col gap-2 px-4 py-3',
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
                settingsChoiceClass(active),
                'flex min-w-0 flex-col items-center gap-2 p-2',
              )}
            >
              <span className={cn('relative flex h-16 w-full items-end justify-center overflow-hidden rounded-lg', PREVIEW_WALLPAPER)}>
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
    </>
  );
}

/** A radio group of pictured choices, as the Dock's and taskbar's options are offered. */
function PicturedChoices<T extends string>({
  label,
  options,
  value,
  onChange,
  preview,
}: {
  label: string;
  options: { value: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
  preview: (value: T) => React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-2', options.length === 4 ? 'grid-cols-4' : options.length === 3 ? 'grid-cols-3' : 'grid-cols-2')} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              settingsChoiceClass(active),
              'flex min-w-0 flex-col items-center gap-2 p-2',
            )}
          >
            <span aria-hidden className={cn('relative flex h-16 w-full flex-col justify-end overflow-hidden rounded-lg', PREVIEW_WALLPAPER)}>
              {preview(option.value)}
            </span>
            <span className="text-xs">{option.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A small taskbar along the bottom, top or left of a desktop, Din's logo as its Start button. */
function TaskbarPositionPreview({ position }: { position: TaskbarPosition }) {
  const vertical = isTaskbarVertical(position);
  return (
    <span
      className={cn(
        'absolute flex items-center gap-1 bg-black/45',
        vertical ? 'inset-y-0 w-4 flex-col py-1' : 'inset-x-0 h-4 px-1',
        position === 'left' && 'left-0',
        position === 'right' && 'right-0',
        position === 'bottom' && 'bottom-0',
        position === 'top' && 'top-0',
      )}
    >
      <img src="/din-logo.svg" alt="" className="h-2.5 w-auto max-w-3" draggable={false} />
      {PREVIEW_APPS.map((color) => (
        <span key={color} className={cn('size-2.5 rounded-[2px]', color)} />
      ))}
      <span className={cn('rounded-full bg-white/60', vertical ? 'mt-auto h-3 w-1.5' : 'ml-auto h-1.5 w-4')} />
    </span>
  );
}

/** A small taskbar of either build, Din's logo as its Start button. */
function TaskbarStylePreview({ style }: { style: TaskbarStyle }) {
  const slim = style === 'slim';
  return (
    <span className={cn('flex w-full shrink-0 items-center gap-1 bg-black/45 px-1', slim ? 'h-4' : 'h-6')}>
      <img src="/din-logo.svg" alt="" className={cn('mr-1 w-auto', slim ? 'h-2.5' : 'h-3.5')} draggable={false} />
      {PREVIEW_APPS.map((color) => (
        <span key={color} className={cn('rounded-[2px]', color, slim ? 'size-2.5' : 'size-3.5')} />
      ))}
      <span className="ml-auto h-1.5 w-4 rounded-full bg-white/60" />
    </span>
  );
}

/** A small taskbar with a button per app, or a labeled one per window. */
function TaskbarButtonsPreview({ buttons }: { buttons: TaskbarButtons }) {
  return (
    <span className="flex h-5 w-full shrink-0 items-center gap-1 bg-black/45 px-1">
      <img src="/din-logo.svg" alt="" className="h-3 w-auto shrink-0" draggable={false} />
      {buttons === 'combine'
        ? PREVIEW_APPS.map((color) => (
            <span key={color} className="grid h-4 w-5 place-items-center rounded-[3px] bg-white/15">
              <span className={cn('size-2.5 rounded-[2px]', color)} />
            </span>
          ))
        : PREVIEW_APPS.slice(0, 2).map((color) => (
            <span key={color} className="flex h-4 w-9 min-w-0 items-center gap-0.5 rounded-[3px] bg-white/15 px-0.5">
              <span className={cn('size-2 shrink-0 rounded-[2px]', color)} />
              <span className="h-1 flex-1 rounded-full bg-white/60" />
            </span>
          ))}
    </span>
  );
}

/** The taskbar's position, its size, and whether it combines an app's windows into one button. */
function TaskbarOptions() {
  const { config, updateConfig } = useAppContext();

  return (
    <>
      <SubHeading>Taskbar position</SubHeading>
      <PicturedChoices
        label="Taskbar position"
        options={TASKBAR_POSITIONS}
        value={config.taskbarPosition}
        onChange={(value) => updateConfig((current) => ({ ...current, taskbarPosition: value }))}
        preview={(value) => <TaskbarPositionPreview position={value} />}
      />
      <p className="text-xs text-muted-foreground">
        Along the bottom of the screen as on Windows, along the top, down the left side as on Ubuntu, or down the right. Down a side, each window’s button is its icon alone.
      </p>
      <SubHeading>Taskbar size</SubHeading>
      <PicturedChoices
        label="Taskbar size"
        options={TASKBAR_STYLES}
        value={config.taskbarStyle}
        onChange={(value) => updateConfig((current) => ({ ...current, taskbarStyle: value }))}
        preview={(value) => <TaskbarStylePreview style={value} />}
      />
      <p className="text-xs text-muted-foreground">
        Tall is the roomier bar of Windows 7, with bigger icons, and Slim the thinner bar of Windows Vista.
      </p>
      <SubHeading>Taskbar buttons</SubHeading>
      <PicturedChoices
        label="Taskbar buttons"
        options={TASKBAR_BUTTONS}
        value={config.taskbarButtons}
        onChange={(value) => updateConfig((current) => ({ ...current, taskbarButtons: value }))}
        preview={(value) => <TaskbarButtonsPreview buttons={value} />}
      />
      <p className="text-xs text-muted-foreground">
        Combined, each app has one button for all its windows, as on Windows 7. Separate, each window has its own button with its title, as on Windows XP and Vista, and pinned apps keep their icons until they open. You can also right-click the taskbar between its buttons to change these, and its position.
      </p>
    </>
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
  const { config, updateConfig } = useAppContext();
  const { open } = useWindowActions();
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);

  if (status.isLoading || themes.isLoading) {
    return <Skeleton className="h-40 w-full bg-foreground/10" aria-hidden />;
  }
  if (status.isError || !status.data || !themes.data) {
    return <FallbackCard>Could not read the cursor settings.</FallbackCard>;
  }

  const { canChange, shared, sizes, fixedSize } = status.data;
  // The zoom the pointer grows with, where it does (electron/cursor.mts).
  const scale = status.data.followsZoom ? config.zoomLevel / 100 : 1;
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
    <div className={cn(settingsCard, 'flex flex-col gap-4 px-4 py-3')}>
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
                onPublish={() => setPublishing({ type: 'cursor', id: option.id, name: option.name })}
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
            <Button type="button" variant="ghost" size="sm" onClick={() => open('app-store', { tab: 'cursors' })}>
              <Store aria-hidden />
              Find Cursors
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
        <SegmentedControl
          label="Cursor size"
          size="md"
          value={String(size)}
          options={sizes.map((option) => ({ value: String(option), label: CURSOR_SIZE_NAMES[option] ?? `${option} px` }))}
          onValueChange={(option) => choose({ theme, size: Number(option) })}
          disabled={!canChange || fixedSize}
          className="max-w-full self-start"
        />
        {fixedSize && canChange && (
          <p className="mt-2 text-xs text-muted-foreground">This style comes in one size only.</p>
        )}
        {!fixedSize && scale !== 1 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Drawn at {Math.round(scale * 100)}%, to match the display’s zoom.
          </p>
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
      <PublishThemePackage target={publishing} onClose={() => setPublishing(null)} />
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
 * One style in the cursor picker. Its ⋯ and right-click menus can use it
 * and publish it to Nostr; imported ones can also be removed.
 */
function SystemCursorOption({
  option,
  selected,
  disabled,
  onChoose,
  onPublish,
  onRemove,
}: {
  option: SystemCursorTheme;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
  onPublish: () => void;
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
              settingsChoiceClass(selected),
              'flex w-full flex-col items-start gap-2 p-3 text-left',
              'pr-10',
            )}
          >
            <SystemCursorPreview id={option.id} />
            <span className="w-full truncate text-sm">{option.name}</span>
          </button>
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
              <DropdownMenuItem onSelect={onPublish}>
                <Share aria-hidden />
                Publish to Nostr…
              </DropdownMenuItem>
              {option.imported && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                    <Trash2 aria-hidden />
                    Remove
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={selected} onSelect={onChoose}>
          <Check aria-hidden />
          Use this cursor
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPublish}>
          <Share aria-hidden />
          Publish to Nostr…
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
 * Developer utilities. Restart Din does what About's does after an update
 * (DinOS only). Crash crashes the shell on purpose: clicking it arms a state
 * flag, and the next render throws. Throwing during render (rather than in
 * the click handler) matters — React error boundaries only catch render
 * errors, so this is the reliable way to exercise the root <ErrorBoundary>
 * death screen.
 */
function DevelopersSection() {
  const [armed, setArmed] = useState(false);
  const updateState = useUpdateState();
  // Din going down keeps it pending until it does.
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  if (armed) {
    throw new Error('Intentional crash triggered from Settings → Developers');
  }

  const restartDin = () => {
    const bridge = getUpdaterBridge();
    if (!bridge) return;
    setRestarting(true);
    setRestartError(null);
    bridge.restartDin().catch((e: unknown) => {
      setRestarting(false);
      setRestartError(cleanInstallerError(e));
    });
  };

  return (
    <SectionShell title="Developers">
      {updateState?.available && (
        <div className={cn(settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-foreground">Restart Din</p>
              <p className="text-xs text-muted-foreground">
                Restarts Din as an update does, to load a new build. Open apps
                will close.
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={restarting} onClick={restartDin}>
              {restarting ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
              Restart Din
            </Button>
          </div>
          {restartError && <p className="text-xs text-destructive">{restartError}</p>}
        </div>
      )}
      <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
        className={cn(settingsCard, 'flex flex-col gap-4 p-4')}
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
      <div role="radiogroup" aria-label="Running as administrator" className={settingsGroup}>
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
              className={cn(settingsRowButton, 'items-start py-3 disabled:opacity-60')}
            >
              <RadioMark checked={active} className="mt-0.5" />
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
function AboutSection({ eraseRequest }: { eraseRequest?: number }) {
  const bridge = getUpdaterBridge();
  const state = useUpdateState();
  const dinos = !!bridge && state?.available !== false;

  return (
    <SectionShell title="About">
      <div className={cn(settingsCard, 'flex flex-col items-center gap-2 px-6 py-8 text-center')}>
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
        <div className={cn(settingsCard, 'space-y-2 p-4')} aria-hidden>
          <Skeleton className="h-4 w-32 bg-foreground/10" />
          <Skeleton className="h-3 w-56 bg-foreground/10" />
        </div>
      ) : state.live ? (
        <p className={cn(settingsCard, 'px-4 py-3 text-xs text-muted-foreground')}>
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

      {dinos && state && !state.live && <EraseSection request={eraseRequest} />}
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
        <div className={cn(settingsCard, 'space-y-2 p-4')} aria-hidden>
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
        <div className={cn(settingsNotice, 'flex items-center justify-between gap-4 p-4')}>
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

      <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
          <RotateCw strokeWidth={1.75} className={cn('size-4.5', state.phase === 'checking' && 'motion-safe:animate-spin')} aria-hidden />
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
    <div className={cn(settingsCard, 'flex flex-col gap-2 p-4')}>
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
          <summary className="cursor-pointer rounded-sm select-none hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
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
        <div className={cn(settingsCard, 'flex flex-col gap-2 p-4')}>
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
        <div className={cn(settingsNotice, 'flex items-center justify-between gap-4 p-4')}>
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

      <div className={cn(settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
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
          <RotateCw strokeWidth={1.75} className={cn('size-4.5', state.phase === 'checking' && 'motion-safe:animate-spin')} aria-hidden />
          Check now
        </Button>
      </div>

      {state.security.length > 0 && !busy && (
        <UpdateSecurityCard state={state} onUpdate={check} canUpdate={!(state.phase === 'failed' && state.reason)} />
      )}

      {state.phase === 'failed' && state.reason && <UpdateFixCard state={state} />}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The security fixes on the branch the system lacks (the branch's commits
 * that say so, os/din-update.sh). Updating brings them in, unless the
 * user's changes stopped it, which the fix card below is for.
 */
function UpdateSecurityCard({ state, onUpdate, canUpdate }: { state: UpdateState; onUpdate: () => void; canUpdate: boolean }) {
  const count = state.security.length;
  return (
    <div className={cn(settingsAlert, 'flex flex-col gap-3 p-4')}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {count === 1 ? 'A security fix is waiting' : `${count} security fixes are waiting`}
            </p>
            <p className="text-xs text-muted-foreground">
              {canUpdate
                ? `${state.branch ?? DEFAULT_UPDATE_BRANCH} has ${count === 1 ? 'a fix' : 'fixes'} this system doesn’t. Updating installs ${count === 1 ? 'it' : 'them'}.`
                : `Your changes have to be brought up to date before ${count === 1 ? 'it' : 'they'} can be installed.`}
            </p>
          </div>
        </div>
        {canUpdate && (
          <Button size="sm" onClick={onUpdate}>
            Update now
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {state.security.map((fix) => (
          <li key={fix.commit} className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
            <span className="shrink-0 font-mono">{shortRevision(fix.commit)}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{fix.subject}</span>
            {fix.severity && <span className="shrink-0 capitalize">{fix.severity}</span>}
          </li>
        ))}
      </ul>
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
    <div className={cn(settingsAlert, 'flex flex-col gap-3 p-4')}>
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
          {fixer.pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Bot className="size-4.5" strokeWidth={1.75} aria-hidden />}
          Fix with assistant
        </Button>
      </div>
      {state.reason === 'missing' && (
        <div className="flex items-center justify-between gap-4">
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
    <div className={cn(settingsCard, 'flex flex-col gap-3 px-4 py-3')}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <SettingsToken icon={GitBranch} />
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
  const inGroup = use(SettingsGroupContext);
  return (
    <div className={cn(!inGroup && settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <SettingsToken icon={Icon} active={checked} />}
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

/**
 * A setting that's one of a few named choices: its label, the choices as a
 * segmented control, and what it does.
 */
function ChoiceRow<T extends string>({
  label,
  description,
  value,
  choices,
  onChange,
}: {
  label: string;
  description: string;
  value: T;
  choices: { value: T; name: string }[];
  onChange: (value: T) => void;
}) {
  const inGroup = use(SettingsGroupContext);
  return (
    <div className={cn(!inGroup && settingsCard, 'flex flex-col gap-2 px-4 py-3')}>
      <p className="text-sm">{label}</p>
      <SegmentedControl label={label} size="md" value={value} options={choices.map((c) => ({ value: c.value, label: c.name }))} onValueChange={onChange} className="self-start" />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
