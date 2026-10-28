import { createContext, useContext } from 'react';
import type { AppDefinition } from '@/lib/apps';
import type { WebApp } from '@/lib/webApps';
import type { NsiteAppEntry } from '@/lib/nsiteApps';
import type { NostrHandler } from '@/lib/nostrUri';

/**
 * The desktop app registry: built-in apps, user-installed web apps and nsites,
 * and the host's Linux apps.
 */
export interface InstalledAppsManager {
  /** Every launchable app, in launcher order (built-ins first). */
  apps: readonly AppDefinition[];
  /** Look up any app (built-in or installed) by id. */
  getApp: (id: string) => AppDefinition | undefined;
  /** The raw installed web-app entries. */
  webApps: readonly WebApp[];
  /**
   * Install a website as an app. The URL (and icon, if any) are sanitized to
   * https and the theme color to canonical `#rrggbb`; returns the created
   * entry, or `null` if the URL was invalid.
   */
  installWebApp: (
    input: { name: string; url: string; icon?: string; themeColor?: string; nostr?: NostrHandler },
  ) => WebApp | null;
  /** Find an installed web app by its exact start URL. */
  findWebAppByUrl: (url: string) => WebApp | undefined;
  /** The installed nsite entries (empty outside the Electron shell). */
  nsiteApps: readonly NsiteAppEntry[];
  /**
   * Install an nsite as an app by its canonical host. The OS-level nsite
   * store keeps it and downloads all of its files. Returns the entry, or
   * `null` if the host isn't canonical or nsites can't run here.
   */
  installNsiteApp: (host: string, name?: string) => NsiteAppEntry | null;
  /** Find an installed nsite by its canonical host. */
  findNsiteApp: (host: string) => NsiteAppEntry | undefined;
  /**
   * The installed app that owns a URL, if any: a web app sharing its origin,
   * or the nsite on its canonical host. Used to route a clicked link into its
   * app window rather than a browser tab.
   */
  findAppIdForUrl: (url: string) => string | undefined;
  /** Whether the user can uninstall an app (installed web apps and nsites). */
  canUninstall: (id: string) => boolean;
  /** Remove an installed web app or nsite. */
  uninstallApp: (id: string) => void;
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
