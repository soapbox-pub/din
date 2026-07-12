import { createContext, useContext } from 'react';
import type { AppDefinition } from '@/lib/apps';
import type { WebApp } from '@/lib/webApps';

/** The desktop app registry: built-in apps plus user-installed web apps. */
export interface InstalledAppsManager {
  /** Every launchable app, in launcher order (built-ins first). */
  apps: readonly AppDefinition[];
  /** Look up any app (built-in or installed web app) by id. */
  getApp: (id: string) => AppDefinition | undefined;
  /** The raw installed web-app entries. */
  webApps: readonly WebApp[];
  /**
   * Install a website as an app. The URL (and icon, if any) are sanitized to
   * https; returns the created entry, or `null` if the URL was invalid.
   */
  installWebApp: (input: { name: string; url: string; icon?: string }) => WebApp | null;
  /** Remove an installed web app. */
  uninstallWebApp: (id: string) => void;
  /** Find an installed web app by its exact start URL. */
  findWebAppByUrl: (url: string) => WebApp | undefined;
}

export const InstalledAppsContext = createContext<InstalledAppsManager | undefined>(
  undefined,
);

/** Access the desktop app registry. Must be used within the Desktop. */
export function useInstalledApps(): InstalledAppsManager {
  const ctx = useContext(InstalledAppsContext);
  if (!ctx) {
    throw new Error('useInstalledApps must be used within an InstalledAppsProvider');
  }
  return ctx;
}
