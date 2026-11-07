import { useCallback } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { isNsiteUrl } from '@/lib/nsite';
import { isNostrUri } from '@/lib/nostrUri';
import { isBlossomUri } from '@/lib/blossomUri';
import { isMailtoUrl } from '@/lib/mailto';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { isWebviewAvailable } from '@/lib/isElectron';

/**
 * Open an http/https/nsite URL the way the rest of the desktop routes links: if an
 * installed app owns the URL - a web app by origin, an nsite by canonical host,
 * or an nsite a website names as its own (e.g. a `ditto.pub` link opens in
 * the installed Ditto nsite, which ditto.pub's web-app-origin-association
 * names) - deep-link into that app's window; otherwise open it as a tab in
 * the Web Browser app, launching a browser window first when none is open.
 *
 * A `mailto:` link opens a new message in Mail.
 *
 * A `nostr:` link opens in the default app for its kind, or else as a
 * preview in the Web Browser, with buttons to open it in an app. A `blossom:`
 * link (BUD-10) opens as a tab showing its file, which Din fetches and checks
 * against its hash (electron/blossom.mts).
 *
 * Outside the Electron shell (plain-browser build) the in-app browser can't
 * host webviews, so the link defers to the host browser via `window.open`.
 *
 * Must be used within the Desktop (needs the window-manager and installed-apps
 * contexts).
 */
export function useOpenUrl(): (url: string) => void {
  const { open } = useWindowActions();
  const { findAppForLink } = useInstalledApps();
  const { openNostrUri } = useNostrLinks();

  return useCallback(
    (rawUrl: string) => {
      if (isMailtoUrl(rawUrl)) {
        open('mail', { mailto: rawUrl });
        return;
      }

      // The preview is the browser's own page, so it works without webviews.
      if (isNostrUri(rawUrl)) {
        void openNostrUri(rawUrl, (uri) => {
          if (!hasTabConsumer()) open('web-browser');
          publishTabCommand({ type: 'open', url: uri });
        });
        return;
      }

      const url = sanitizeNavigationUrl(rawUrl);
      if (!url) return;

      // Route into an installed app that owns this URL. An nsite link only
      // matches on its canonical host: an `nsite://naddr1…/` opens in the Web
      // Browser, which redirects it.
      const target = findAppForLink(url);
      if (target) {
        open(target.appId, { url: target.url });
        return;
      }

      // nsites and blossom: files are served by Din's own protocol handlers;
      // a host browser has no handler for either scheme at all.
      const dinOnly = isNsiteUrl(url) || isBlossomUri(url);

      // No in-app browser outside Electron — hand off to the host browser.
      if (!isWebviewAvailable()) {
        if (dinOnly) return;
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }

      // Open (or reuse) a Web Browser window and hand it the link as a new tab.
      if (!hasTabConsumer()) open('web-browser');
      publishTabCommand({ type: 'open', url });
    },
    [open, findAppForLink, openNostrUri],
  );
}
