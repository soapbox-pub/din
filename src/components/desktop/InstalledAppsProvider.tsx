import { useEffect, useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APPS, NativeWindowView } from '@/lib/apps';
import { NATIVE_APP_ICON, WEB_APP_ICON } from '@/lib/appIcons';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { useNativeApps } from '@/hooks/useNativeApps';
import { useIsLiveBoot } from '@/hooks/useInstaller';
import type { NativeApp } from '@/lib/nativeApps';
import {
  createWebApp,
  DEFAULT_WEB_APPS,
  WEB_APP_DEFAULT_SIZE,
  WEB_APPS_KEY,
  WebAppsSchema,
  type WebApp,
} from '@/lib/webApps';
import { sanitizeImageUrl, sanitizeUrl, sameOrigin } from '@/lib/sanitizeUrl';
import { normalizeThemeColor } from '@/lib/themeColor';
import { useAppData } from '@/hooks/useAppData';
import {
  canonicalHostOfUrl,
  NO_NSITE_APPS,
  NSITE_APPS_KEY,
  NsiteAppsSchema,
  nsiteAppId,
  nsiteAppUrl,
  type NsiteAppEntry,
} from '@/lib/nsiteApps';
import { getNsiteStore, type NsiteSummary } from '@/lib/nsiteStore';
import { ensureNsiteAppInfo } from '@/lib/nsiteAppInfo';
import { parseCanonicalNsiteHost } from '@/lib/nsite';
import {
  InstalledAppsContext,
  type InstalledAppsManager,
} from '@/contexts/InstalledAppsContext';
import { WebAppFrame } from '@/components/desktop/apps/WebAppFrame';

/**
 * Per-web-app window components, cached so a given app keeps the same
 * component reference across re-renders. Window content is memoized on the
 * component identity — a fresh closure each render would remount the page
 * (losing the site's state) every time the installed-apps list changed.
 */
const componentCache = new Map<string, ComponentType<AppComponentProps>>();

function webAppComponent(webApp: WebApp): ComponentType<AppComponentProps> {
  const cacheKey = `${webApp.id}\u0000${webApp.url}\u0000${webApp.themeColor ?? ''}\u0000${webApp.name}\u0000${webApp.icon ?? ''}`;
  let component = componentCache.get(cacheKey);
  if (!component) {
    const { url, name, themeColor } = webApp;
    // AppIcon falls back to the globe icon when a favicon fails to load.
    const icon = webApp.icon ?? WEB_APP_ICON;
    component = function InstalledWebApp(props: AppComponentProps) {
      // A link routed into this app (see BrowserExtensionHost) arrives as a
      // `url` launch param, so the window opens at that deep link instead of
      // the app's home URL. WebAppFrame re-checks it shares the app's origin.
      const initialUrl =
        typeof props.params?.url === 'string' ? props.params.url : undefined;
      return (
        <WebAppFrame
          url={url}
          initialUrl={initialUrl}
          name={name}
          icon={icon}
          themeColor={themeColor}
        />
      );
    };
    componentCache.set(cacheKey, component);
  }
  return component;
}

/** Convert a stored WebApp entry into a launchable desktop app. */
function webAppToDefinition(webApp: WebApp): AppDefinition {
  return {
    id: webApp.id,
    name: webApp.name,
    // AppIcon falls back to the globe icon when a favicon fails to load.
    icon: webApp.icon ?? WEB_APP_ICON,
    component: webAppComponent(webApp),
    defaultSize: WEB_APP_DEFAULT_SIZE,
    // One window per installed web app: clicking a link that belongs to the
    // app navigates the existing window (via a changed `url` param) instead
    // of spawning a duplicate. See WebAppFrame for the deep-link handling.
    singleInstance: true,
    web: true,
  };
}

/**
 * Convert an installed nsite into a launchable desktop app. It runs in the
 * same frame as a web app, on its canonical host; its name, icon, and color
 * come from the nsite store, derived from the site's own files.
 */
function nsiteAppToDefinition(entry: NsiteAppEntry, summary: NsiteSummary | undefined): AppDefinition {
  const definition = webAppToDefinition({
    id: nsiteAppId(entry.host),
    name:
      entry.name ??
      summary?.app?.name ??
      summary?.title ??
      `${entry.host.slice(0, 12)}…`,
    url: nsiteAppUrl(entry.host),
    icon: summary?.app?.icon ?? undefined,
    themeColor: summary?.app?.themeColor ?? undefined,
  });
  return { ...definition, web: false };
}

/** Hosts this session has already asked the store to install. */
const installRequested = new Set<string>();

/** Ask the store to install a site, once per session. */
function requestInstall(host: string): void {
  const store = getNsiteStore();
  if (!store || installRequested.has(host)) return;
  installRequested.add(host);
  void store.install(host).catch(() => installRequested.delete(host));
}

/** Query key for the store's installed sites. */
const NSITE_INSTALLED_QUERY_KEY = ['nsite-store', 'installed'] as const;

/**
 * Convert an installed Linux app into a launchable desktop app.
 *
 * Every window it maps on Din's embedded display opens a Din window around
 * NativeWindowView. The icon is a data URL resolved from the icon theme by
 * the main process, falling back to a generic window icon.
 */
function nativeAppToDefinition(app: NativeApp): AppDefinition {
  return {
    id: app.id,
    name: app.name,
    icon: app.icon ?? NATIVE_APP_ICON,
    component: NativeWindowView,
    native: true,
    terminal: app.terminal,
    keywords: [...app.keywords, ...app.categories],
  };
}

/**
 * Provides the desktop app registry: the static built-in apps, the user's
 * installed web apps and nsites (persisted + roamed via encrypted app data;
 * an nsite's files live in the OS-level nsite store), and the Linux apps
 * installed on the host system.
 */
export function InstalledAppsProvider({ children }: { children: ReactNode }) {
  const [webApps, setWebApps] = useAppData<WebApp[]>(
    WEB_APPS_KEY,
    WebAppsSchema,
    DEFAULT_WEB_APPS,
  );
  // Empty in a plain browser, and wherever Din's embedded display can't run.
  const { apps: nativeApps } = useNativeApps();
  // The Installer is only offered when running from a USB stick.
  const live = useIsLiveBoot();

  // Installed nsites: the roaming list of hosts, and what this device's nsite
  // store has for them. Both are empty outside the Electron shell.
  const store = getNsiteStore();
  const [nsiteEntries, setNsiteEntries] = useAppData<NsiteAppEntry[]>(
    NSITE_APPS_KEY,
    NsiteAppsSchema,
    NO_NSITE_APPS,
  );
  const nsiteApps = store ? nsiteEntries : NO_NSITE_APPS;
  const queryClient = useQueryClient();
  const { data: storedSites } = useQuery({
    queryKey: NSITE_INSTALLED_QUERY_KEY,
    queryFn: () => store!.installed(),
    enabled: Boolean(store),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!store) return;
    return store.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ['nsite-store'] });
    });
  }, [store, queryClient]);

  // Install what the list names and this device doesn't have yet (the list
  // roams; the files don't), and keep each app's name and icon current with
  // its manifest.
  useEffect(() => {
    if (!store || !storedSites) return;
    const installed = new Set(storedSites.map((site) => site.host));
    for (const entry of nsiteApps) {
      if (!installed.has(entry.host)) requestInstall(entry.host);
    }
    for (const site of storedSites) void ensureNsiteAppInfo(store, site);
  }, [store, storedSites, nsiteApps]);

  const value = useMemo<InstalledAppsManager>(() => {
    const apps: AppDefinition[] = [
      ...APPS.map((app) => (app.id === 'installer' && live ? { ...app, hidden: false } : app)),
      ...webApps.map(webAppToDefinition),
      ...nsiteApps.map((entry) =>
        nsiteAppToDefinition(entry, storedSites?.find((site) => site.host === entry.host)),
      ),
      ...nativeApps.map(nativeAppToDefinition),
    ];

    const nsiteEntryFor = (id: string) =>
      nsiteApps.find((entry) => nsiteAppId(entry.host) === id);

    return {
      apps,
      webApps,
      nsiteApps,
      getApp: (id) => apps.find((app) => app.id === id),
      findWebAppByUrl: (url) => webApps.find((webApp) => webApp.url === url),
      findNsiteApp: (host) => nsiteApps.find((entry) => entry.host === host),
      findAppIdForUrl: (url) => {
        const host = canonicalHostOfUrl(url);
        if (host) {
          return nsiteApps.some((entry) => entry.host === host) ? nsiteAppId(host) : undefined;
        }
        return webApps.find((webApp) => sameOrigin(webApp.url, url))?.id;
      },
      canUninstall: (id) =>
        webApps.some((webApp) => webApp.id === id) || nsiteEntryFor(id) !== undefined,
      installNsiteApp: (host, name) => {
        if (!store || !parseCanonicalNsiteHost(host)) return null;
        const existing = nsiteApps.find((entry) => entry.host === host);
        if (existing) return existing;
        const trimmed = name?.trim().slice(0, 64);
        const entry: NsiteAppEntry = {
          host,
          installedAt: Math.floor(Date.now() / 1000),
          ...(trimmed ? { name: trimmed } : {}),
        };
        setNsiteEntries((prev) => [...prev.filter((e) => e.host !== host), entry]);
        requestInstall(host);
        return entry;
      },
      installWebApp: ({ name, url, icon, themeColor }) => {
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) return null;
        const safeIcon = icon ? (sanitizeImageUrl(icon) ?? undefined) : undefined;
        const safeThemeColor = normalizeThemeColor(themeColor) ?? undefined;
        const trimmedName = name.trim() || new URL(safeUrl).hostname;
        const webApp = createWebApp({
          name: trimmedName,
          url: safeUrl,
          icon: safeIcon,
          themeColor: safeThemeColor,
        });
        setWebApps((prev) => [...prev, webApp]);
        return webApp;
      },
      uninstallApp: (id) => {
        const entry = nsiteEntryFor(id);
        if (entry) {
          setNsiteEntries((prev) => prev.filter((e) => e.host !== entry.host));
          installRequested.delete(entry.host);
          void store?.uninstall(entry.host);
          return;
        }
        setWebApps((prev) => prev.filter((webApp) => webApp.id !== id));
      },
    };
  }, [webApps, setWebApps, nsiteApps, setNsiteEntries, storedSites, store, nativeApps, live]);

  return (
    <InstalledAppsContext.Provider value={value}>
      {children}
    </InstalledAppsContext.Provider>
  );
}
