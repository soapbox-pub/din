import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APPS, NativeWindowView } from '@/lib/apps';
import { NATIVE_APP_ICON, nsiteIconName, WEB_APP_ICON, webIconName } from '@/lib/appIcons';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { useNativeApps } from '@/hooks/useNativeApps';
import { useIsLiveBoot } from '@/hooks/useInstaller';
import { subscribeUnlistedNativeApps, uninstallNativeApp, unlistedNativeApps, type NativeApp } from '@/lib/nativeApps';
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
import { normalizeNostrHandler } from '@/lib/nostrUri';
import { useAppData } from '@/hooks/useAppData';
import {
  canonicalHostOfUrl,
  linkIntoNsite,
  NO_NSITE_APPS,
  NSITE_APPS_KEY,
  NsiteAppsSchema,
  nsiteAppId,
  nsiteAppUrl,
  type NsiteAppEntry,
} from '@/lib/nsiteApps';
import { getNsiteStore, type NsiteSummary } from '@/lib/nsiteStore';
import { launchedApp, launchedApps, subscribeLaunchedApps } from '@/lib/launchedApps';
import { getAppsBridge } from '@/lib/dinApps';
import { getPeriodicSyncBridge } from '@/lib/periodicSync';
import {
  FILE_APPS_KEY,
  fileAppDefinition,
  fileAppEntry,
  parseFileApps,
  type FileAppEntry,
  type OpenedFolder,
} from '@/lib/fileApps';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { ensureNsiteAppInfo } from '@/lib/nsiteAppInfo';
import { parseCanonicalNsiteHost } from '@/lib/nsite';
import {
  InstalledAppsContext,
  type InstalledAppsManager,
  type LinkedWebsite,
} from '@/contexts/InstalledAppsContext';
import { WebAppFrame } from '@/components/desktop/apps/WebAppFrame';
import { requestThemeIcons } from '@/lib/iconTheme';
import { themeIcon, useThemeIcons } from '@/shared/themeIcons';

/** A URL's origin, or null. */
function originOfUrl(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * Per-web-app window components, cached so a given app keeps the same
 * component reference across re-renders. Window content is memoized on the
 * component identity — a fresh closure each render would remount the page
 * (losing the site's state) every time the installed-apps list changed.
 */
const componentCache = new Map<string, ComponentType<AppComponentProps>>();

function webAppComponent(webApp: WebApp, favicon?: string, nsiteHost?: string): ComponentType<AppComponentProps> {
  const cacheKey = `${webApp.id}\u0000${webApp.url}\u0000${webApp.themeColor ?? ''}\u0000${webApp.name}\u0000${webApp.icon ?? ''}\u0000${favicon ?? ''}\u0000${nsiteHost ?? ''}`;
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
          favicon={favicon}
          themeColor={themeColor}
          nsiteHost={nsiteHost}
        />
      );
    };
    componentCache.set(cacheKey, component);
  }
  return component;
}

/**
 * Convert a stored WebApp entry into a launchable desktop app. `favicon`, if
 * given, stands in for the icon in the window's title bar; `nsiteHost` marks
 * an installed nsite.
 */
function webAppToDefinition(webApp: WebApp, favicon?: string, nsiteHost?: string): AppDefinition {
  return {
    id: webApp.id,
    name: webApp.name,
    // AppIcon falls back to the globe icon when a favicon fails to load.
    icon: webApp.icon ?? WEB_APP_ICON,
    component: webAppComponent(webApp, favicon, nsiteHost),
    defaultSize: WEB_APP_DEFAULT_SIZE,
    // One window per installed web app: clicking a link that belongs to the
    // app navigates the existing window (via a changed `url` param) instead
    // of spawning a duplicate. See WebAppFrame for the deep-link handling.
    singleInstance: true,
    web: true,
    // Only a handler on the app's own origin: the window is pinned to it.
    ...(webApp.nostr && sameOrigin(webApp.nostr.url, webApp.url) ? { nostr: webApp.nostr } : {}),
  };
}

/**
 * Convert an installed nsite into a launchable desktop app. It runs in the
 * same frame as a web app, on its canonical host; its name, icon, and color
 * come from the nsite store, derived from the site's own files, unless the
 * icon theme has an icon for it (`themed`).
 */
function nsiteAppToDefinition(
  entry: NsiteAppEntry,
  summary: NsiteSummary | undefined,
  themed: string | null,
): AppDefinition {
  const definition = webAppToDefinition({
    id: nsiteAppId(entry.host),
    name:
      entry.name ??
      summary?.app?.name ??
      summary?.title ??
      `${entry.host.slice(0, 12)}…`,
    url: nsiteAppUrl(entry.host),
    icon: themed ?? summary?.app?.icon ?? undefined,
    themeColor: summary?.app?.themeColor ?? undefined,
  }, themed ?? summary?.app?.favicon ?? undefined, entry.host);
  const handler = summary?.app?.nostr;
  return {
    ...definition,
    web: false,
    ...(handler
      ? { nostr: { url: `${nsiteAppUrl(entry.host).slice(0, -1)}${handler.path}`, kinds: handler.kinds } }
      : {}),
  };
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
    // Desktop entries can't say which kinds they show.
    ...(app.schemes?.includes('nostr') && !app.terminal ? { nostr: { kinds: null } } : {}),
  };
}

/**
 * Provides the desktop app registry: the static built-in apps, the user's
 * installed web apps and nsites (persisted + roamed via encrypted app data;
 * an nsite's files live in the OS-level nsite store), the Linux apps
 * installed on the host system, apps from folders on this computer, and the
 * apps the `din` command is running.
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
  // Apps the `din` command is running (src/lib/launchedApps.ts).
  const launched = useSyncExternalStore(subscribeLaunchedApps, launchedApps);
  // Linux apps running without being installed (`nix run`, an AppImage).
  const unlisted = useSyncExternalStore(subscribeUnlistedNativeApps, unlistedNativeApps);
  // Apps from folders on this computer (src/lib/fileApps.ts).
  const [storedFileApps, setStoredFileApps] = useLocalStorage<unknown>(FILE_APPS_KEY, []);
  const fileApps = useMemo(() => parseFileApps(storedFileApps), [storedFileApps]);
  const fileAppsRef = useRef(fileApps);
  useEffect(() => {
    fileAppsRef.current = fileApps;
  });
  const saveFileApp = useCallback((opened: OpenedFolder, install: boolean): FileAppEntry | null => {
    const existing = fileAppsRef.current.find((e) => e.appId === opened.appId);
    if (!existing && !install) return null;
    const entry = fileAppEntry(opened, existing?.addedAt);
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return existing;
    setStoredFileApps((prev: unknown) => {
      const list = parseFileApps(prev);
      if (!install && !list.some((e) => e.appId === entry.appId)) return prev;
      return [...list.filter((e) => e.appId !== entry.appId), entry];
    });
    return entry;
  }, [setStoredFileApps]);

  // Main serves only folders it was asked for since it started: open each
  // again (reading its manifest afresh), and again whenever it changes.
  const fileAppPaths = fileApps.map((e) => e.path).join('\0');
  useEffect(() => {
    const bridge = getAppsBridge();
    if (!bridge || !fileAppPaths) return;
    for (const path of fileAppPaths.split('\0')) {
      bridge.folder(path).then((opened) => saveFileApp(opened, false), () => {});
    }
  }, [fileAppPaths, saveFileApp]);
  useEffect(() => {
    const bridge = getAppsBridge();
    return bridge?.onFolderChanged(({ appId }) => {
      const entry = fileAppsRef.current.find((e) => e.appId === appId);
      if (entry) bridge.folder(entry.path).then((opened) => saveFileApp(opened, false), () => {});
    });
  }, [saveFileApp]);

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

  // An icon theme can replace installed nsites' and websites' icons, by
  // names Din gives them (nsiteIconName, webIconName).
  const themeIcons = useThemeIcons();
  useEffect(() => {
    requestThemeIcons([
      ...nsiteApps.map((entry) => nsiteIconName(entry.host)),
      ...webApps.map((webApp) => webIconName(webApp.url)),
    ].filter((name): name is string => name !== null));
  }, [nsiteApps, webApps]);

  const value = useMemo<InstalledAppsManager>(() => {
    const themed = (name: string | null) => (name ? themeIcon(themeIcons, [name]) : null);
    const apps: AppDefinition[] = [
      ...APPS.map((app) => (app.id === 'installer' && live ? { ...app, hidden: false } : app)),
      ...webApps.map((webApp) => {
        const icon = themed(webIconName(webApp.url));
        return webAppToDefinition(icon ? { ...webApp, icon } : webApp, icon ?? undefined);
      }),
      ...nsiteApps.map((entry) =>
        nsiteAppToDefinition(
          entry,
          storedSites?.find((site) => site.host === entry.host),
          themed(nsiteIconName(entry.host)),
        ),
      ),
      ...nativeApps.map(nativeAppToDefinition),
      // Kept out of the launcher: they're here only while they run.
      ...unlisted.map((app) => ({ ...nativeAppToDefinition(app), hidden: true })),
      ...fileApps.map(fileAppDefinition),
      ...launched.map((app) => app.definition),
    ];

    const nsiteEntryFor = (id: string) =>
      nsiteApps.find((entry) => nsiteAppId(entry.host) === id);

    const linkedWebsites: LinkedWebsite[] = nsiteApps.flatMap((entry) =>
      (storedSites?.find((site) => site.host === entry.host)?.links ?? []).map((link) => ({
        appId: nsiteAppId(entry.host),
        ...link,
        on: entry.openLinks !== false,
      })),
    );

    const findAppIdForUrl = (url: string) => {
      const host = canonicalHostOfUrl(url);
      if (host) {
        return nsiteApps.some((entry) => entry.host === host) ? nsiteAppId(host) : undefined;
      }
      return webApps.find((webApp) => sameOrigin(webApp.url, url))?.id;
    };

    return {
      apps,
      webApps,
      nsiteApps,
      fileApps,
      // A launch opens its window as soon as it's registered, before this list has it.
      getApp: (id) => {
        const found = apps.find((app) => app.id === id) ?? launchedApp(id)?.definition;
        if (found) return found;
        const running = unlistedNativeApps().find((app) => app.id === id);
        return running && { ...nativeAppToDefinition(running), hidden: true };
      },
      findWebAppByUrl: (url) => webApps.find((webApp) => webApp.url === url),
      findNsiteApp: (host) => nsiteApps.find((entry) => entry.host === host),
      findAppIdForUrl,
      findAppForLink: (url) => {
        const appId = findAppIdForUrl(url);
        if (appId) return { appId, url };
        for (const linked of linkedWebsites) {
          if (!linked.on) continue;
          const entry = nsiteEntryFor(linked.appId);
          const target = entry && linkIntoNsite(url, entry.host, linked);
          if (target) return { appId: linked.appId, url: target };
        }
        return undefined;
      },
      linkedWebsites,
      setOpensLinks: (appId, on) => {
        const entry = nsiteEntryFor(appId);
        if (!entry) return;
        setNsiteEntries((prev) =>
          prev.map((e) => {
            if (e.host !== entry.host) return e;
            const { openLinks: _openLinks, ...rest } = e;
            return on ? rest : { ...rest, openLinks: false };
          }),
        );
      },
      canUninstall: (id) =>
        nativeApps.some((app) => app.id === id && app.uninstallable) ||
        webApps.some((webApp) => webApp.id === id) ||
        nsiteEntryFor(id) !== undefined ||
        fileApps.some((entry) => entry.appId === id),
      installFileApp: (opened) => saveFileApp(opened, true)!,
      refreshFileApp: (opened) => saveFileApp(opened, false),
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
      installWebApp: ({ name, url, icon, themeColor, nostr }) => {
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) return null;
        const safeIcon = icon ? (sanitizeImageUrl(icon) ?? undefined) : undefined;
        const safeThemeColor = normalizeThemeColor(themeColor) ?? undefined;
        const trimmedName = name.trim() || new URL(safeUrl).hostname;
        const handler = normalizeNostrHandler(nostr);
        const webApp = createWebApp({
          name: trimmedName,
          url: safeUrl,
          icon: safeIcon,
          themeColor: safeThemeColor,
          ...(handler && sameOrigin(handler.url, safeUrl) ? { nostr: handler } : {}),
        });
        setWebApps((prev) => [...prev, webApp]);
        return webApp;
      },
      uninstallApp: (id) => {
        const native = nativeApps.find((app) => app.id === id && app.uninstallable);
        if (native) {
          uninstallNativeApp(native);
          return;
        }
        if (fileApps.some((e) => e.appId === id)) {
          setStoredFileApps((prev: unknown) => parseFileApps(prev).filter((e) => e.appId !== id));
          void getAppsBridge()?.closeFolder(id);
          void getPeriodicSyncBridge()?.forget(`din+file://${id.slice('file-'.length)}`);
          return;
        }
        const entry = nsiteEntryFor(id);
        if (entry) {
          setNsiteEntries((prev) => prev.filter((e) => e.host !== entry.host));
          installRequested.delete(entry.host);
          void store?.uninstall(entry.host);
          return;
        }
        // What it scheduled goes too, unless another installed app is the same site.
        const origin = originOfUrl(webApps.find((w) => w.id === id)?.url);
        if (origin && !webApps.some((w) => w.id !== id && originOfUrl(w.url) === origin)) {
          void getPeriodicSyncBridge()?.forget(origin);
        }
        setWebApps((prev) => prev.filter((webApp) => webApp.id !== id));
      },
    };
  }, [webApps, setWebApps, nsiteApps, setNsiteEntries, storedSites, store, nativeApps, unlisted, live, launched, themeIcons, fileApps, saveFileApp, setStoredFileApps]);

  return (
    <InstalledAppsContext.Provider value={value}>
      {children}
    </InstalledAppsContext.Provider>
  );
}
