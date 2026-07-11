import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Folder, Globe, Settings as SettingsIcon, SquareTerminal } from 'lucide-react';
import { WebBrowser } from '@/components/desktop/apps/WebBrowser';
import { FileBrowser } from '@/components/desktop/apps/FileBrowser';
import { Terminal } from '@/components/desktop/apps/Terminal';
import { Settings } from '@/components/desktop/apps/Settings';

/** Props every windowed app receives from the window manager. */
export interface AppComponentProps {
  /** The id of the window instance this app is rendered inside. */
  windowId: string;
}

/** A launchable desktop application. */
export interface AppDefinition {
  /** Stable unique identifier, used as a registry key. */
  id: string;
  /** Human-readable name shown in the launcher and window title bar. */
  name: string;
  /** Icon shown in the launcher and taskbar. */
  icon: LucideIcon;
  /** The component rendered inside the app's window. */
  component: ComponentType<AppComponentProps>;
  /** Default window size when the app is launched. */
  defaultSize?: { width: number; height: number };
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
];

/** Look up an app definition by id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS.find((app) => app.id === id);
}
