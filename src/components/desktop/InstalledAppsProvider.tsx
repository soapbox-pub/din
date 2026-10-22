import { useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
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
  };
}

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
 * installed web apps (persisted + roamed via encrypted app data), and the
 * Linux apps installed on the host system.
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

  const value = useMemo<InstalledAppsManager>(() => {
    const apps: AppDefinition[] = [
      ...APPS.map((app) => (app.id === 'installer' && live ? { ...app, hidden: false } : app)),
      ...webApps.map(webAppToDefinition),
      ...nativeApps.map(nativeAppToDefinition),
    ];

    return {
      apps,
      webApps,
      getApp: (id) => apps.find((app) => app.id === id),
      findWebAppByUrl: (url) => webApps.find((webApp) => webApp.url === url),
      findWebAppForUrl: (url) =>
        webApps.find((webApp) => sameOrigin(webApp.url, url)),
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
      uninstallWebApp: (id) => {
        setWebApps((prev) => prev.filter((webApp) => webApp.id !== id));
      },
    };
  }, [webApps, setWebApps, nativeApps, live]);

  return (
    <InstalledAppsContext.Provider value={value}>
      {children}
    </InstalledAppsContext.Provider>
  );
}
