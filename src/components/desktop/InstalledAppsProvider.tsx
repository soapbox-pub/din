import { useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { APPS } from '@/lib/apps';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import {
  createWebApp,
  DEFAULT_WEB_APPS,
  WEB_APP_DEFAULT_SIZE,
  WEB_APPS_KEY,
  WebAppsSchema,
  type WebApp,
} from '@/lib/webApps';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
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
  const cacheKey = `${webApp.id}\u0000${webApp.url}\u0000${webApp.themeColor ?? ''}`;
  let component = componentCache.get(cacheKey);
  if (!component) {
    const { url, themeColor } = webApp;
    component = function InstalledWebApp(_props: AppComponentProps) {
      return <WebAppFrame url={url} themeColor={themeColor} />;
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
    // AppIcon falls back to a Globe glyph when a favicon fails to load.
    icon: webApp.icon ?? Globe,
    component: webAppComponent(webApp),
    defaultSize: WEB_APP_DEFAULT_SIZE,
  };
}

/**
 * Provides the desktop app registry: the static built-in apps merged with
 * the user's installed web apps (persisted + roamed via encrypted app data).
 */
export function InstalledAppsProvider({ children }: { children: ReactNode }) {
  const [webApps, setWebApps] = useAppData<WebApp[]>(
    WEB_APPS_KEY,
    WebAppsSchema,
    DEFAULT_WEB_APPS,
  );

  const value = useMemo<InstalledAppsManager>(() => {
    const apps: AppDefinition[] = [...APPS, ...webApps.map(webAppToDefinition)];

    return {
      apps,
      webApps,
      getApp: (id) => apps.find((app) => app.id === id),
      findWebAppByUrl: (url) => webApps.find((webApp) => webApp.url === url),
      installWebApp: ({ name, url, icon, themeColor }) => {
        const safeUrl = sanitizeUrl(url);
        if (!safeUrl) return null;
        const safeIcon = icon ? (sanitizeUrl(icon) ?? undefined) : undefined;
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
  }, [webApps, setWebApps]);

  return (
    <InstalledAppsContext.Provider value={value}>
      {children}
    </InstalledAppsContext.Provider>
  );
}
