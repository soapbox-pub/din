import { z } from 'zod';

/**
 * User-installed web apps ("install this website as an app", like a PWA
 * install on other OSes). Each entry becomes a launchable desktop app that
 * opens its URL in a standalone, chrome-less browser window.
 *
 * The list is persisted through Din's encrypted app-data layer under the
 * `web-apps` key (see NIP.md), so installed apps roam across devices.
 */
export interface WebApp {
  /** Stable unique id, also used as the desktop app registry id. */
  id: string;
  /** Display name shown in the launcher, taskbar and window title bar. */
  name: string;
  /** The https start URL the app opens at. */
  url: string;
  /** Optional https favicon URL. */
  icon?: string;
  /**
   * The site's `<meta name="theme-color">` captured at install time, in
   * canonical `#rrggbb` form. Pre-tints the app window's chrome until the
   * live page reports its own color.
   */
  themeColor?: string;
}

/** Zod schema for the stored `web-apps` list. */
export const WebAppsSchema: z.ZodType<WebApp[]> = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    icon: z.string().url().optional(),
    themeColor: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
  }),
);

/** App-data key under which installed web apps are stored. */
export const WEB_APPS_KEY = 'web-apps';

/** Default (empty) list of installed web apps. Module-level for stability. */
export const DEFAULT_WEB_APPS: WebApp[] = [];

/** Default window size for installed web apps and nsites. */
export const WEB_APP_DEFAULT_SIZE = { width: 1280, height: 800 };

/** Create a new WebApp entry with a fresh unique id. */
export function createWebApp(input: Omit<WebApp, 'id'>): WebApp {
  const id = `webapp-${crypto.randomUUID()}`;
  return { id, ...input };
}
