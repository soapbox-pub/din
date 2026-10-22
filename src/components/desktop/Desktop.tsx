import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Wallpaper } from './Wallpaper';
import { BootScreenSync } from './BootScreenSync';
import { Dock } from './Dock';
import { DesktopHotkeys } from './DesktopHotkeys';
import { MenuBar } from './MenuBar';
import { VolumeOsd } from './VolumeOsd';
import { BrightnessOsd } from './BrightnessOsd';
import { ScreenDimmer } from './ScreenDimmer';
import { NostrNotifications } from './NostrNotifications';
import { NotificationPopups } from './NotificationPopups';
import { SystemNotificationsHost } from './SystemNotificationsHost';
import { GuestInputHost } from './GuestInputHost';
import { Window } from './Window';
import { WindowSwitcher } from './WindowSwitcher';
import { FilePickerProvider } from './FilePickerProvider';
import { FilePickerBridgeHost } from './FilePickerBridgeHost';
import { InstalledAppsProvider } from './InstalledAppsProvider';
import { BrowserExtensionHost } from './BrowserExtensionHost';
import { ExtensionPopupHost } from './ExtensionPopupHost';
import { NostrBridgeHost } from './NostrBridgeHost';
import { HighlightBridgeHost } from './HighlightBridgeHost';
import { NsiteBridgeHost } from './NsiteBridgeHost';
import { PromptHost } from './PromptHost';
import { NativeDisplayHost } from './NativeDisplayHost';
import { SystemEventsHost } from './SystemEventsHost';
import { InstallerAutoOpen } from './InstallerAutoOpen';
import { UpdateNotifier } from './UpdateNotifier';
import { AirPlayPromptHost } from './AirPlayIndicator';
import { BluetoothPromptHost } from './BluetoothIndicator';
import { PageFullscreenHost } from './PageFullscreenHost';
import { useWindows } from '@/hooks/useWindows';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { WindowActionsContext, WindowManagerContext } from '@/contexts/WindowManagerContext';
import { useMonitors, WorkAreasContext } from '@/contexts/MonitorsContext';
import { contains, workAreas, type WorkArea } from '@/lib/monitors';

/** How long after a click a window it opens still counts as opened by it. */
const LAUNCH_POINTER_MS = 2000;

/** The desktop session: top menu bar, wallpaper workspace, bottom dock. */
export function Desktop() {
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
  // origin is where the primary monitor's menu bar ends, measured once
  // laid out (and again whenever the monitors change). Measured against the
  // Wallpaper's full-screen root rather than the viewport: <body> may not
  // have moved to the primary monitor yet (MonitorsProvider's effect runs
  // after this one), but the offset between the two is already final.
  const [areas, setAreas] = useState<WorkArea[]>(() => workAreas(monitors, { x: 0, y: 0 }));
  useLayoutEffect(() => {
    const measure = () => {
      const workspace = workspaceRef.current;
      const rect = workspace?.getBoundingClientRect();
      const screen = workspace?.closest('[data-screen-root]')?.getBoundingClientRect();
      const next = workAreas(monitors, {
        x: (rect?.left ?? 0) - (screen?.left ?? 0),
        y: (rect?.top ?? 0) - (screen?.top ?? 0),
      });
      setAreas((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
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
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const monitor = monitorsRef.current.find((m) => contains(m, e.clientX, e.clientY));
      lastPointer.current = monitor ? { monitor: monitor.id, time: e.timeStamp } : null;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
  const getLaunchMonitor = useCallback(() => {
    const last = lastPointer.current;
    return last && performance.now() - last.time < LAUNCH_POINTER_MS ? last.monitor : null;
  }, []);

  const manager = useWindows(getApp, getAreas, getLaunchMonitor);
  const { fitToAreas } = manager.actions;
  // Windows stranded by a monitor going away (or shrinking) come home.
  useEffect(() => {
    fitToAreas(areas);
  }, [areas, fitToAreas]);
  // Focus ring goes to the highest visible window; minimized and closing
  // ones don't count.
  const topZ = manager.windows.reduce(
    (max, w) => (w.minimized || w.closing ? max : Math.max(max, w.z)),
    0,
  );

  return (
    <WindowManagerContext.Provider value={manager}>
      <WindowActionsContext.Provider value={manager.actions}>
        <WorkAreasContext.Provider value={areas}>
          <FilePickerProvider>
            <FilePickerBridgeHost />
            <BrowserExtensionHost />
            <ExtensionPopupHost />
            <NostrBridgeHost />
            <HighlightBridgeHost />
            <NsiteBridgeHost />
            <PromptHost />
            <DesktopHotkeys />
            <SystemEventsHost />
            <SystemNotificationsHost />
            <GuestInputHost />
            <InstallerAutoOpen />
            <UpdateNotifier />
            <AirPlayPromptHost />
            <BluetoothPromptHost />
            <PageFullscreenHost />
            <BootScreenSync />
            <Wallpaper>
              <MenuBar />

              {/* Workspace area - windows render here. It's the primary
                  monitor below the menu bar, but windows may sit outside it on
                  the other monitors (the Wallpaper clips to the whole screen,
                  not to this). The Dock overlays its bottom edge and
                  auto-hides, so windows can use the full height.
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
                className="relative isolate flex-1"
              >
                {manager.windows.map((win) => (
                  <Window
                    key={win.id}
                    window={win}
                    isTop={!win.minimized && win.z === topZ}
                  />
                ))}
              </main>

              <Dock workspaceRef={workspaceRef} />
              <WindowSwitcher />
              <VolumeOsd />
              <BrightnessOsd />
              <ScreenDimmer />
              <NostrNotifications />
              <NotificationPopups />
              <NativeDisplayHost />
            </Wallpaper>
          </FilePickerProvider>
        </WorkAreasContext.Provider>
      </WindowActionsContext.Provider>
    </WindowManagerContext.Provider>
  );
}
