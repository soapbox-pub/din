import { useRef } from 'react';
import { Wallpaper } from './Wallpaper';
import { Dock } from './Dock';
import { MenuBar } from './MenuBar';
import { Window } from './Window';
import { FilePickerProvider } from './FilePickerProvider';
import { InstalledAppsProvider } from './InstalledAppsProvider';
import { BrowserExtensionHost } from './BrowserExtensionHost';
import { useWindows } from '@/hooks/useWindows';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { WindowManagerContext } from '@/contexts/WindowManagerContext';

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
  // Focus ring goes to the highest visible window; minimized ones don't count.
  const topZ = manager.windows.reduce(
    (max, w) => (w.minimized ? max : Math.max(max, w.z)),
    0,
  );

  return (
    <WindowManagerContext.Provider value={manager}>
      <FilePickerProvider>
        <BrowserExtensionHost />
        <Wallpaper>
          <MenuBar />

          {/* Workspace area - windows render here. The Dock overlays its
              bottom edge and auto-hides, so windows can use the full height. */}
          <main
            ref={workspaceRef}
            aria-label="Desktop"
            className="relative flex-1 overflow-hidden"
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
        </Wallpaper>
      </FilePickerProvider>
    </WindowManagerContext.Provider>
  );
}
