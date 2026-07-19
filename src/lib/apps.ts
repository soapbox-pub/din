import { lazy } from 'react';
import type { ComponentType } from 'react';
import { Camera, Store, type LucideIcon } from 'lucide-react';

// Built-in apps are code-split: each is its own chunk, loaded the first time
// it's launched (windows render app content inside <Suspense>). Statically
// importing them shipped every app - including xterm + its WebGL addon -
// in the main bundle, which slowed boot and first paint of the desktop.
const WebBrowser = lazy(() =>
  import('@/components/desktop/apps/WebBrowser').then((m) => ({ default: m.WebBrowser })),
);
const FileBrowser = lazy(() =>
  import('@/components/desktop/apps/FileBrowser').then((m) => ({ default: m.FileBrowser })),
);
const Terminal = lazy(() =>
  import('@/components/desktop/apps/Terminal').then((m) => ({ default: m.Terminal })),
);
const Settings = lazy(() =>
  import('@/components/desktop/apps/Settings').then((m) => ({ default: m.Settings })),
);
const Screenshot = lazy(() =>
  import('@/components/desktop/apps/Screenshot').then((m) => ({ default: m.Screenshot })),
);
const DevTools = lazy(() =>
  import('@/components/desktop/apps/DevTools').then((m) => ({ default: m.DevTools })),
);
const AppStore = lazy(() =>
  import('@/components/desktop/apps/AppStore').then((m) => ({ default: m.AppStore })),
);

/** Props every windowed app receives from the window manager. */
export interface AppComponentProps {
  /** The id of the window instance this app is rendered inside. */
  windowId: string;
  /** Launch parameters passed to open(), or undefined. App-defined shape. */
  params?: Record<string, unknown>;
}

/** A launchable desktop application. */
export interface AppDefinition {
  /** Stable unique identifier, used as a registry key. */
  id: string;
  /** Human-readable name shown in the launcher and window title bar. */
  name: string;
  /**
   * Icon shown in the launcher and taskbar: a root-relative image path
   * (built-in apps, served from public/), an https image URL (installed
   * web apps), or a Lucide component. Render through <AppIcon>, never
   * directly.
   */
  icon: LucideIcon | string;
  /** The component rendered inside the app's window. */
  component: ComponentType<AppComponentProps>;
  /** Default window size when the app is launched. */
  defaultSize?: { width: number; height: number };
  /**
   * Hidden apps are resolvable by id (so a window can host them) but never
   * shown in the launcher or taskbar; they're opened programmatically with
   * launch params. E.g. the browser's undocked DevTools window.
   */
  hidden?: boolean;
  /**
   * Single-instance apps only ever have one window. Launching one while it's
   * already open just focuses (and un-minimizes) the existing window instead
   * of spawning a duplicate. E.g. Settings.
   */
  singleInstance?: boolean;
}

/** All apps installed on the desktop, in launcher order. */
export const APPS: readonly AppDefinition[] = [
  {
    id: 'web-browser',
    name: 'Web Browser',
    icon: '/icons/apps/web-browser.png',
    component: WebBrowser,
    defaultSize: { width: 960, height: 640 },
  },
  {
    id: 'file-browser',
    name: 'Files',
    icon: '/icons/apps/file-browser.png',
    component: FileBrowser,
    defaultSize: { width: 880, height: 600 },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    icon: '/icons/apps/terminal.png',
    component: Terminal,
    defaultSize: { width: 760, height: 480 },
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: '/icons/apps/settings.png',
    component: Settings,
    defaultSize: { width: 720, height: 520 },
    singleInstance: true,
  },
  {
    id: 'app-store',
    name: 'App Store',
    icon: Store,
    component: AppStore,
    defaultSize: { width: 900, height: 640 },
  },
  {
    id: 'screenshot',
    name: 'Screenshot',
    icon: Camera,
    component: Screenshot,
    defaultSize: { width: 720, height: 560 },
  },
  {
    // The Web Browser's "undock into separate window" inspector. Hidden from
    // the launcher; opened by the browser with the tab's WebContents id in
    // its launch params.
    id: 'devtools',
    name: 'Developer Tools',
    icon: '/icons/apps/devtools.png',
    component: DevTools,
    defaultSize: { width: 720, height: 560 },
    hidden: true,
  },
];

/** Look up an app definition by id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((app) => app.id === id);
}
