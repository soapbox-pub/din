import { useCallback } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { isNsiteUrl } from '@/lib/nsite';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { isWebviewAvailable } from '@/lib/isElectron';

/**
 * Open an http/https/nsite URL the way the rest of the desktop routes links: if an
 * installed app owns the URL - a web app by origin, an nsite by canonical host -
 * deep-link into that app's window (e.g. a `ditto.pub` link opens in the
 * installed Ditto app); otherwise open
 * it as a tab in the Web Browser app, launching a browser window first when
 * none is open.
 *
 * Outside the Electron shell (plain-browser build) the in-app browser can't
 * host webviews, so the link defers to the host browser via `window.open`.
 *
 * Must be used within the Desktop (needs the window-manager and installed-apps
 * contexts).
 */
export function useOpenUrl(): (url: string) => void {
  const { open } = useWindowActions();
  const { findAppIdForUrl } = useInstalledApps();

  return useCallback(
    (rawUrl: string) => {
      const url = sanitizeNavigationUrl(rawUrl);
      if (!url) return;

      // Route into an installed app that owns this URL. An nsite link only
      // matches on its canonical host: an `nsite://naddr1…/` opens in the Web
      // Browser, which redirects it.
      const appId = findAppIdForUrl(url);
      if (appId) {
        open(appId, { url });
        return;
      }

      // nsites are served by Din's own protocol handler; a host browser has
      // no handler for the scheme at all.
      const nsite = isNsiteUrl(url);

      // No in-app browser outside Electron — hand off to the host browser.
      if (!isWebviewAvailable()) {
        if (nsite) return;
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }

      // Open (or reuse) a Web Browser window and hand it the link as a new tab.
      if (!hasTabConsumer()) open('web-browser');
      publishTabCommand({ type: 'open', url });
    },
    [open, findAppIdForUrl],
  );
}
