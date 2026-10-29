import { useEffect, useLayoutEffect, useRef } from 'react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import {
  addLaunchedApp,
  getLaunchBridge,
  launchedApp,
  launchedApps,
  parseLaunchRequest,
  removeLaunchedApp,
} from '@/lib/launchedApps';

/**
 * Opens a window for each app the `din` command launches
 * (electron/din-launch.mts), closes it when the command goes, and tells main
 * when it closed and when the app has no windows left.
 */
export function LaunchHost() {
  const { windows, actions } = useWindowManager();
  const { getApp } = useInstalledApps();
  const live = useRef({ actions, getApp });
  useLayoutEffect(() => {
    live.current = { actions, getApp };
  });
  /** Each launch's window and app, by launch id; `seen` once the window is in the list. */
  const launchWindows = useRef(new Map<string, { windowId: string; appId: string; seen: boolean }>());

  useEffect(() => {
    const bridge = getLaunchBridge();
    if (!bridge) return;
    const offOpen = bridge.onOpen((raw) => {
      const request = parseLaunchRequest(raw);
      if (!request) return;
      const { actions, getApp } = live.current;
      if (getApp(request.appId) && !launchedApp(request.appId)) {
        void bridge.opened(request.launchId, `din://${request.appId} belongs to an app on this desktop`);
        return;
      }
      addLaunchedApp(request);
      const windowId = actions.open(request.appId, request.paths.length > 0 ? { paths: request.paths } : undefined);
      if (!windowId) {
        void bridge.opened(request.launchId, 'Din couldn’t open a window for it');
        return;
      }
      launchWindows.current.set(request.launchId, { windowId, appId: request.appId, seen: false });
      void bridge.opened(request.launchId, null);
    });
    const offClose = bridge.onClose((launchId) => {
      const launch = launchWindows.current.get(launchId);
      if (launch) live.current.actions.close(launch.windowId);
    });
    const launches = launchWindows.current;
    return () => {
      offOpen();
      offClose();
      // Signed out: every window is gone, and the commands should hear so.
      for (const launchId of launches.keys()) void bridge.ended(launchId);
      launches.clear();
      for (const app of launchedApps()) {
        void bridge.release(app.appId);
        removeLaunchedApp(app.appId);
      }
    };
  }, []);

  useEffect(() => {
    const bridge = getLaunchBridge();
    if (!bridge) return;
    const open = new Set(windows.map((w) => w.id));
    for (const [launchId, launch] of launchWindows.current) {
      // Opened but not drawn yet: this list is older than the window.
      if (open.has(launch.windowId)) launchWindows.current.set(launchId, { ...launch, seen: true });
      else if (launch.seen) {
        launchWindows.current.delete(launchId);
        void bridge.ended(launchId);
      }
    }
    const held = new Set(windows.map((w) => w.appId));
    for (const launch of launchWindows.current.values()) held.add(launch.appId);
    for (const app of launchedApps()) {
      if (held.has(app.appId)) continue;
      void bridge.release(app.appId);
      removeLaunchedApp(app.appId);
    }
  }, [windows]);

  return null;
}
