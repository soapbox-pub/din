import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Code, Folder, Globe, Settings as SettingsIcon, SquareTerminal } from 'lucide-react';
import { WebBrowser } from '@/components/desktop/apps/WebBrowser';
import { FileBrowser } from '@/components/desktop/apps/FileBrowser';
import { Terminal } from '@/components/desktop/apps/Terminal';
import { Settings } from '@/components/desktop/apps/Settings';
import { DevTools } from '@/components/desktop/apps/DevTools';

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
   * Icon shown in the launcher and taskbar: either a Lucide component
   * (built-in apps) or an https image URL (installed web apps). Render
   * through <AppIcon>, never directly.
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
}

/** All apps installed on the desktop, in launcher order. */
export const APPS: readonly AppDefinition[] = [
  {
    id: 'web-browser',
    name: 'Web Browser',
    icon: Globe,
    component: WebBrowser,
    defaultSize: { width: 960, height: 640 },
  },
  {
    id: 'file-browser',
    name: 'Files',
    icon: Folder,
    component: FileBrowser,
    defaultSize: { width: 880, height: 600 },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    icon: SquareTerminal,
    component: Terminal,
    defaultSize: { width: 760, height: 480 },
  },
  {
    id: 'settings',
    name: 'Settings',
    icon: SettingsIcon,
    component: Settings,
    defaultSize: { width: 720, height: 520 },
  },
  {
    // The Web Browser's "undock into separate window" inspector. Hidden from
    // the launcher; opened by the browser with the tab's WebContents id in
    // its launch params.
    id: 'devtools',
    name: 'Developer Tools',
    icon: Code,
    component: DevTools,
    defaultSize: { width: 720, height: 560 },
    hidden: true,
  },
];

/** Look up an app definition by id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((app) => app.id === id);
}
