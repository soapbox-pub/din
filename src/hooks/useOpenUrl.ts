import { useCallback } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { isNsiteUrl } from '@/lib/nsite';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { isWebviewAvailable } from '@/lib/isElectron';

/**
 * Open an http/https/nsite URL the way the rest of the desktop routes links: if an
 * installed web app owns the URL's origin, deep-link into that app's window
 * (e.g. a `ditto.pub` link opens in the installed Ditto app); otherwise open
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
  const { findWebAppForUrl } = useInstalledApps();

  return useCallback(
    (rawUrl: string) => {
      const url = sanitizeNavigationUrl(rawUrl);
      if (!url) return;

      // nsites are served by Din's own protocol handler, so they always belong
      // in the Web Browser: no installed app owns an nsite origin, and a host
      // browser has no handler for the scheme at all.
      const nsite = isNsiteUrl(url);

      // Route into an installed web app that owns this origin.
      const webApp = nsite ? undefined : findWebAppForUrl(url);
      if (webApp) {
        open(webApp.id, { url });
        return;
      }

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
    [open, findWebAppForUrl],
  );
}
