import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Wallpaper } from './Wallpaper';
import { BootScreenSync } from './BootScreenSync';
import { Dock } from './Dock';
import { DesktopHotkeys } from './DesktopHotkeys';
import { MouseHost } from './MouseHost';
import { WorkspaceSwipeHost } from './WorkspaceSwipeHost';
import { DeviceBatteryHost } from './DeviceBatteryHost';
import { BatteryWarningHost } from './BatteryWarningHost';
import { ResourceAlertsHost } from './ResourceAlertsHost';
import { AssistantHost } from './AssistantHost';
import { DesktopAssistantHost } from './assistant/DesktopAssistantHost';
import { SecurityOptions } from './SecurityOptions';
import { ScreenshotHost } from './ScreenshotHost';
import { ScreenRecordingHost } from './ScreenRecordingHost';
import { MenuBar } from './MenuBar';
import { menuBarWindow, paintsBarStrip } from '@/lib/menuBarWindow';
import { Taskbar } from './Taskbar';
import { setPauseMediaWhileRecording } from '@/lib/mediaPause';
import { setSpeechVoice } from '@/lib/speech';
import { taskbarWorkspaceClass } from '@/lib/taskbarStyles';
import { cn } from '@/lib/utils';
import { getMouseBridge } from '@/lib/mouse';
import { VolumeOsd } from './VolumeOsd';
import { WorkspaceOsd } from './WorkspacesIndicator';
import { Announcer } from './Announcer';
import { DictationOverlay } from './DictationOverlay';
import { BrightnessOsd } from './BrightnessOsd';
import { KeyboardLayoutOsd } from './KeyboardIndicator';
import { ScreenDimmer } from './ScreenDimmer';
import { NotificationPopups } from './NotificationPopups';
import { SystemNotificationsHost } from './SystemNotificationsHost';
import { MailHost } from './MailHost';
import { PhoneHost } from './PhoneHost';
import { QuickShareHost } from './QuickShareHost';
import { ShareSheetHost } from './ShareSheetHost';
import { GuestInputHost } from './GuestInputHost';
import { MenuHost } from '@/components/desktop/MenuHost';
import { CursorEffectsLayer } from './CursorEffectsLayer';
import { DinDragOverlay } from './DinDragOverlay';
import { Window } from './Window';
import { WindowSwitcher } from './WindowSwitcher';
import { FilePickerProvider } from './FilePickerProvider';
import { FilePickerBridgeHost } from './FilePickerBridgeHost';
import { DesktopBackgroundProvider } from './DesktopBackgroundProvider';
import { DesktopMenu } from './DesktopMenu';
import { InstalledAppsProvider } from './InstalledAppsProvider';
import { BrowserExtensionHost } from './BrowserExtensionHost';
import { ExtensionPopupHost } from './ExtensionPopupHost';
import { PasskeyPrompt } from './PasskeyPrompt';
import { PasswordAutofillHost } from './PasswordAutofillHost';
import { NostrBridgeHost } from './NostrBridgeHost';
import { HighlightBridgeHost } from './HighlightBridgeHost';
import { NsiteBridgeHost } from './NsiteBridgeHost';
import { BlossomBridgeHost } from './BlossomBridgeHost';
import { PromptHost } from './PromptHost';
import { AdminPromptHost, PolkitPromptHost } from './AdminPrompt';
import { ProgramSignerHost } from './ProgramSignerPrompt';
import { ScreenSharePicker } from './ScreenShareHost';
import { EyeDropperHost } from './EyeDropperHost';
import { NativeDisplayHost } from './NativeDisplayHost';
import { SystemEventsHost } from './SystemEventsHost';
import { NativeLinksHost } from './NativeLinksHost';
import { LaunchHost } from './LaunchHost';
import { CommandHost } from './CommandHost';
import { CustomizeAutoOpen } from './CustomizeAutoOpen';
import { InstallerAutoOpen } from './InstallerAutoOpen';
import { UpdateNotifier } from './UpdateNotifier';
import { AirPlayOsd, AirPlayPromptHost } from './AirPlayIndicator';
import { BluetoothPromptHost } from './BluetoothIndicator';
import { VolumesHost } from './VolumesHost';
import { PrintHost } from './PrintHost';
import { PageFullscreenHost } from './PageFullscreenHost';
import { WindowSessionHost } from './WindowSessionHost';
import { GamePerformanceHost } from './GamePerformanceHost';
import { WidgetsProvider } from './widgets/WidgetsProvider';
import { WidgetLayer } from './widgets/WidgetLayer';
import { DesktopIconsProvider } from './icons/DesktopIconsProvider';
import { DesktopIconLayer } from './icons/DesktopIconLayer';
import { WINDOW_GESTURE_ATTR } from '@/shared/liquidGlass';
import { homeArea, isShown, SCRATCHPAD, SCRATCHPAD_BACKDROP_Z, useWindows, windowRect, windowStackZ, type TilingSettings, type WindowState } from '@/hooks/useWindows';
import { useAppContext } from '@/hooks/useAppContext';
import { useMovingWindows } from '@/lib/windowGestures';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { WindowActionsContext, WindowManagerContext } from '@/contexts/WindowManagerContext';
import { useMonitors, WorkAreasContext } from '@/contexts/MonitorsContext';
import { contains, primaryArea, rectStyle, workAreas, type WorkArea } from '@/lib/monitors';
import { restoreCursorTryOn } from '@/lib/cursorTryOn';

/** The least time between workspace steps from Super and the wheel, so one flick is one step. */
const WORKSPACE_WHEEL_MS = 200;

/** How long after a click a window it opens still counts as opened by it. */
const LAUNCH_POINTER_MS = 2000;


/**
 * The windows another one wholly covers: one above it, at rest, whose rect
 * contains its own. Nothing of a covered window shows but a blur of it
 * through the frosted chrome on top, so Window hides it, and its pages stop
 * painting and animating for nobody (a maximized terminal over a stack of
 * browser windows was the case that ran hot). Frameless windows don't
 * cover: they draw what they like, transparency included. A window mid-
 * gesture doesn't either, since its committed rect isn't where it's painted.
 */
function coveredWindows(
  windows: WindowState[],
  areas: WorkArea[],
  moving: ReadonlySet<string>,
): Set<string> {
  const shown = windows.filter(isShown);
  const covers = shown
    .filter((w) => !w.frameless && !moving.has(w.id))
    .map((w) => ({ z: windowStackZ(w), rect: windowRect(w, areas) }));
  const covered = new Set<string>();
  for (const w of shown) {
    if (moving.has(w.id)) continue;
    const r = windowRect(w, areas);
    const z = windowStackZ(w);
    const hidden = covers.some(
      (c) =>
        c.z > z &&
        c.rect.x <= r.x &&
        c.rect.y <= r.y &&
        c.rect.x + c.rect.width >= r.x + r.width &&
        c.rect.y + c.rect.height >= r.y + r.height,
    );
    if (hidden) covered.add(w.id);
  }
  return covered;
}

/**
 * The session's hosts and overlays take no props: memoized, so the session
 * re-rendering as windows open, move and raise doesn't re-render all of them
 * (and every dialog and menu in them). What reads the windows reads them
 * from context.
 */
const SessionHosts = memo(function SessionHosts() {
  return (
    <>
      <FilePickerBridgeHost />
      <BrowserExtensionHost />
      <ExtensionPopupHost />
      <PasswordAutofillHost />
      <PasskeyPrompt />
      <NostrBridgeHost />
      <HighlightBridgeHost />
      <NsiteBridgeHost />
      <BlossomBridgeHost />
      <PromptHost />
      <AdminPromptHost />
      <PolkitPromptHost />
      <ProgramSignerHost />
      <ScreenSharePicker />
      <EyeDropperHost />
      <DesktopHotkeys />
      <MouseHost />
      <WorkspaceSwipeHost />
      <BatteryWarningHost />
      <DeviceBatteryHost />
      <ResourceAlertsHost />
      <AssistantHost />
      <SecurityOptions />
      <ScreenshotHost />
      <ScreenRecordingHost />
      <SystemEventsHost />
      <NativeLinksHost />
      <LaunchHost />
      <CommandHost />
      <SystemNotificationsHost />
      <PhoneHost />
      <MailHost />
      <QuickShareHost />
      <ShareSheetHost />
      <GuestInputHost />
      <MenuHost />
      <CursorEffectsLayer />
      <DinDragOverlay />
      <InstallerAutoOpen />
      <CustomizeAutoOpen />
      <UpdateNotifier />
      <AirPlayPromptHost />
      <BluetoothPromptHost />
      <VolumesHost />
      <PrintHost />
      <PageFullscreenHost />
      <GamePerformanceHost />
      <BootScreenSync />
      <WindowSessionHost />
      <Announcer />
    </>
  );
});

const SessionOverlays = memo(function SessionOverlays() {
  return (
    <>
      <WindowSwitcher />
      <VolumeOsd />
      <WorkspaceOsd />
      <BrightnessOsd />
      <KeyboardLayoutOsd />
      <AirPlayOsd />
      <DictationOverlay />
      <ScreenDimmer />
      <NotificationPopups />
      <NativeDisplayHost />
    </>
  );
});

/**
 * The desktop session: top menu bar, wallpaper workspace, bottom dock; or
 * the workspace beside a taskbar along the bottom, top or left (AppConfig's
 * desktopLayout and taskbarPosition).
 */
export function Desktop() {
  // A pointer the App Store was trying on when Din last quit goes back.
  useEffect(() => void restoreCursorTryOn(), []);
  return (
    <InstalledAppsProvider>
      <DesktopSession />
    </InstalledAppsProvider>
  );
}

/** Inner session so the window manager can resolve installed web apps. */
function DesktopSession() {
  const { getApp } = useInstalledApps();
  const { monitors } = useMonitors();
  // Shared with the Dock so it can translate window coordinates (which are
  // relative to the workspace) into viewport space for intersection checks.
  const workspaceRef = useRef<HTMLElement>(null);

  // Each monitor's work area in workspace coordinates. The workspace's
  // origin is where the primary monitor's menu bar or taskbar ends, and its
  // bottom and right edges where a taskbar along the bottom or down the
  // right starts (the Dock overlays it instead), measured once laid out and
  // again whenever the monitors or the workspace's size change. Measured
  // against the Wallpaper's full-screen root rather than the viewport: <body>
  // may not have moved to the primary monitor yet (MonitorsProvider's effect
  // runs after this one), but the offset between the two is already final.
  const [areas, setAreas] = useState<WorkArea[]>(() => workAreas(monitors, { x: 0, y: 0 }));
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const measure = () => {
      const rect = workspace?.getBoundingClientRect();
      const screen = workspace?.closest('[data-screen-root]')?.getBoundingClientRect();
      const primary = monitors.find((m) => m.primary);
      const bottom = rect && screen && primary
        ? Math.round(primary.y + primary.height - (rect.bottom - screen.top))
        : 0;
      const right = rect && screen && primary
        ? Math.round(primary.x + primary.width - (rect.right - screen.left))
        : 0;
      const next = workAreas(monitors, {
        x: (rect?.left ?? 0) - (screen?.left ?? 0),
        y: (rect?.top ?? 0) - (screen?.top ?? 0),
      }, { bottom, right });
      setAreas((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (workspace) observer.observe(workspace);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [monitors]);
  const areasRef = useRef(areas);
  useLayoutEffect(() => {
    areasRef.current = areas;
  }, [areas]);
  const getAreas = useCallback(() => areasRef.current, []);

  // The monitor the last click or tap in the shell landed on. Launchers (the
  // Dock, the apps menu) live on the primary monitor, so a window opened
  // from them belongs there, not wherever the focused window happens to be.
  // Clicks inside web pages never reach the shell; those launches fall back
  // to the focused window's monitor.
  const lastPointer = useRef<{ monitor: string; time: number } | null>(null);
  const monitorsRef = useRef(monitors);
  useLayoutEffect(() => {
    monitorsRef.current = monitors;
  }, [monitors]);
  const getLaunchMonitor = useCallback(() => {
    const last = lastPointer.current;
    return last && performance.now() - last.time < LAUNCH_POINTER_MS ? last.monitor : null;
  }, []);

  const { config } = useAppContext();
  const tiling = useMemo<TilingSettings>(
    () => ({ enabled: config.tilingEnabled, gap: config.tilingGap, outerGap: config.tilingOuterGap ?? config.tilingGap }),
    [config.tilingEnabled, config.tilingGap, config.tilingOuterGap],
  );
  const taskbar = config.desktopLayout === 'taskbar';
  useEffect(() => setPauseMediaWhileRecording(config.pauseMediaWhileRecording !== false), [config.pauseMediaWhileRecording]);
  useEffect(() => setSpeechVoice(config.speechVoice ?? ''), [config.speechVoice]);
  const tilingRef = useRef(tiling);
  const getTiling = useCallback(() => tilingRef.current, []);

  // Where the pointer last was, in the viewport: a floating window tiled
  // again goes beside the tile under it, as on Hyprland.
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const getPointer = useCallback(() => {
    const at = pointerAt.current;
    const origin = workspaceRef.current?.getBoundingClientRect();
    return at && origin ? { x: at.x - origin.left, y: at.y - origin.top } : null;
  }, []);

  const jumpPointer = useCallback(({ x, y }: { x: number; y: number }) => {
    const workspace = workspaceRef.current;
    const origin = workspace?.getBoundingClientRect();
    const screen = workspace?.closest('[data-screen-root]')?.getBoundingClientRect();
    if (!origin || !screen) return;
    void getMouseBridge()?.jump(x + origin.left - screen.left, y + origin.top - screen.top)
      .catch(console.warn);
  }, []);
  const manager = useWindows(getApp, getAreas, getLaunchMonitor, getTiling, getPointer, jumpPointer);
  const { fitToAreas, relayout, setCurrentMonitor, focus, stepWorkspace, getSession } = manager.actions;
  // While windows tile, focus follows the pointer onto floating windows too
  // (Hyprland's follow_mouse; tiles handle it themselves, in Window). Only a
  // real move counts, so a layout change sliding another window under a
  // resting pointer doesn't take focus, nor does a drag passing over one.
  const followMouse = config.tilingEnabled && config.focusFollowsPointer;
  const hovered = useRef<string | null>(null);
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      pointerAt.current = { x: e.clientX, y: e.clientY };
      if (!followMouse || e.buttons !== 0 || e.pointerType === 'touch') return;
      if (document.documentElement.hasAttribute(WINDOW_GESTURE_ATTR)) return;
      const id = e.target instanceof Element ? (e.target.closest<HTMLElement>('[data-window-id]')?.dataset.windowId ?? null) : null;
      if (id === hovered.current) return;
      hovered.current = id;
      if (id) {
        const session = getSession();
        const target = session.windows.find((w) => w.id === id);
        // The window itself handles tiled surfaces, including guest pointer events.
        if (!target || (target.tiled && !target.maximized)) return;
        if (session.scratchpad && target.workspace !== SCRATCHPAD && homeArea(areasRef.current, target)?.id === session.scratchpad) return;
        focus(id);
      }
    };
    window.addEventListener('pointermove', onPointerMove, true);
    return () => window.removeEventListener('pointermove', onPointerMove, true);
  }, [followMouse, focus, getSession]);
  // Super and the wheel go through the workspaces with windows, as
  // Omarchy's Super+scroll: down to the next, up to the one before.
  useEffect(() => {
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.deltaY === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.timeStamp - last < WORKSPACE_WHEEL_MS) return;
      last = e.timeStamp;
      stepWorkspace(e.deltaY > 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, true);
  }, [stepWorkspace]);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const monitor = monitorsRef.current.find((m) => contains(m, e.clientX, e.clientY));
      lastPointer.current = monitor ? { monitor: monitor.id, time: e.timeStamp } : null;
      // Keyboard commands (Super+1, new windows from Super+Enter) act on
      // the monitor last clicked on.
      if (monitor) setCurrentMonitor(monitor.id);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [setCurrentMonitor]);
  // Turning tiling on or off, or changing the gaps, lays the windows out again.
  useLayoutEffect(() => {
    if (tilingRef.current === tiling) return;
    tilingRef.current = tiling;
    relayout();
  }, [tiling, relayout]);
  // Windows stranded by a monitor going away (or shrinking) come home.
  useEffect(() => {
    fitToAreas(areas);
  }, [areas, fitToAreas]);
  const scratchpadArea = areas.find((area) => area.id === manager.scratchpad);
  const scratchpadEmpty = scratchpadArea !== undefined && !manager.windows.some((w) => w.workspace === SCRATCHPAD && isShown(w));
  const scratchpadBackdrop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (scratchpadEmpty) scratchpadBackdrop.current?.focus({ preventScroll: true });
  }, [scratchpadEmpty, scratchpadArea?.id]);
  // The backdrop takes focus when there are no scratchpad windows to focus.
  const topZ = manager.windows.reduce(
    (max, w) => (isShown(w) ? Math.max(max, w.z) : max),
    0,
  );
  const moving = useMovingWindows();
  const covered = coveredWindows(manager.windows, areas, moving);
  const barArea = primaryArea(areas);
  const barWindow = taskbar ? null : menuBarWindow(manager.windows, barArea);
  const primaryFullscreen = manager.windows.some((w) => isShown(w) && w.presentation === 'screen' && homeArea(areas, w)?.primary);

  return (
    <WindowManagerContext.Provider value={manager}>
      <WindowActionsContext.Provider value={manager.actions}>
        <WorkAreasContext.Provider value={areas}>
          <WidgetsProvider>
            <DesktopIconsProvider>
              <FilePickerProvider>
                <DesktopBackgroundProvider>
                  <DesktopAssistantHost>
                    <SessionHosts />
                    <Wallpaper backdrop={<DesktopMenu />}>
                      {!taskbar && <div className={cn('contents', primaryFullscreen && 'invisible')}><MenuBar /></div>}

                      {/* Workspace area - windows render here. It's the primary
                          monitor below the menu bar, but windows may sit outside it on
                          the other monitors (the Wallpaper clips to the whole screen,
                          not to this). The Dock overlays its bottom edge and
                          auto-hides, so windows can use the full height; the
                          taskbar takes its own room below, above or beside it
                          instead (the taskbar comes after it in either case, so
                          moving the bar never remounts the windows).
                          `isolate` gives the window stack its own stacking context so
                          each window's inline z-index (a counter that only climbs as
                          windows are raised) stays contained here. Without it, a window
                          whose z grew past a menu's z-50 or the top bar's z-20 would
                          paint over the portaled app/menu-bar dropdowns and the top bar
                          itself; isolation keeps those layers - and the Dock - on top no
                          matter how high the window counter climbs. */}
                      <main
                        ref={workspaceRef}
                        aria-label="Desktop"
                        className={cn('relative isolate flex-1', taskbar && taskbarWorkspaceClass(config))}
                      >
                        <DesktopMenu />
                        {/* ~/Desktop's icons and the widgets: over the wallpaper, under every window. */}
                        <DesktopIconLayer />
                        <WidgetLayer />
                        {/* A dim, not a blur: one over the whole monitor redraws whatever moves behind it. */}
                        {scratchpadArea && (
                          <button
                            ref={scratchpadBackdrop}
                            type="button"
                            aria-label="Hide scratchpad"
                            className="flex justify-center bg-black/55 pt-3 text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
                            style={{ ...rectStyle(scratchpadArea), zIndex: SCRATCHPAD_BACKDROP_Z }}
                            onClick={() => manager.toggleScratchpad(scratchpadArea.id)}
                            onKeyDown={(event) => {
                              if (event.key !== 'Escape') return;
                              event.stopPropagation();
                              manager.toggleScratchpad(scratchpadArea.id);
                            }}
                          >
                            <span className="flex h-fit flex-col items-center gap-2">
                              <span className="rounded-full bg-black/60 px-3 py-1 text-xs font-medium">
                                Scratchpad
                              </span>
                              {scratchpadEmpty && <span className="text-sm">Open an app to add a window here</span>}
                            </span>
                          </button>
                        )}
                        {manager.windows.map((win) => (
                          <Window
                            key={win.id}
                            window={win}
                            stackZ={windowStackZ(win)}
                            isTop={isShown(win) && win.z === topZ &&
                              !(scratchpadEmpty && homeArea(areas, win)?.id === scratchpadArea?.id)}
                            covered={covered.has(win.id)}
                            onBar={!taskbar && paintsBarStrip(win, barWindow, barArea)}
                          />
                        ))}
                      </main>

                      <div className={cn('contents', primaryFullscreen && 'invisible')}>
                        {taskbar ? <Taskbar /> : <Dock workspaceRef={workspaceRef} />}
                      </div>
                      <SessionOverlays />
                    </Wallpaper>
                  </DesktopAssistantHost>
                </DesktopBackgroundProvider>
              </FilePickerProvider>
            </DesktopIconsProvider>
          </WidgetsProvider>
        </WorkAreasContext.Provider>
      </WindowActionsContext.Provider>
    </WindowManagerContext.Provider>
  );
}
