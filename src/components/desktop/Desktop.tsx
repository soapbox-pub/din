import { useRef } from 'react';
import { Wallpaper } from './Wallpaper';
import { Dock } from './Dock';
import { DesktopHotkeys } from './DesktopHotkeys';
import { MenuBar } from './MenuBar';
import { VolumeOsd } from './VolumeOsd';
import { BrightnessOsd } from './BrightnessOsd';
import { NotificationsOsd } from './NotificationsOsd';
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
import { NativeDisplayHost } from './NativeDisplayHost';
import { SystemEventsHost } from './SystemEventsHost';
import { useWindows } from '@/hooks/useWindows';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { WindowActionsContext, WindowManagerContext } from '@/contexts/WindowManagerContext';

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
  const manager = useWindows(getApp);
  // Shared with the Dock so it can translate window coordinates (which are
  // relative to the workspace) into viewport space for intersection checks.
  const workspaceRef = useRef<HTMLElement>(null);
  // Focus ring goes to the highest visible window; minimized and closing
  // ones don't count.
  const topZ = manager.windows.reduce(
    (max, w) => (w.minimized || w.closing ? max : Math.max(max, w.z)),
    0,
  );

  return (
    <WindowManagerContext.Provider value={manager}>
      <WindowActionsContext.Provider value={manager.actions}>
        <FilePickerProvider>
          <FilePickerBridgeHost />
          <BrowserExtensionHost />
          <ExtensionPopupHost />
          <NostrBridgeHost />
          <HighlightBridgeHost />
          <NsiteBridgeHost />
          <DesktopHotkeys />
          <SystemEventsHost />
          <Wallpaper>
            <MenuBar />

            {/* Workspace area - windows render here. The Dock overlays its
                bottom edge and auto-hides, so windows can use the full height.
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
              className="relative isolate flex-1 overflow-hidden"
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
            <NotificationsOsd />
            <NativeDisplayHost />
          </Wallpaper>
        </FilePickerProvider>
      </WindowActionsContext.Provider>
    </WindowManagerContext.Provider>
  );
}
