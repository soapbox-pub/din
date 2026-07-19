import { useEffect } from 'react';
import { getCrxBridge } from '@/lib/crx';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';

/**
 * Desktop-lifetime listener for Chrome-extension tab commands (window.crx).
 *
 * Extensions can request tabs while no browser window exists (e.g. a
 * background script calls chrome.tabs.create, or an extension opens its
 * options page right after installing). This host forwards every command to
 * the browserTabBus - where the mounted Web Browser consumes it - and opens
 * a browser window first when none is listening (the command is queued and
 * drained on mount).
 *
 * It also routes plain link opens (target=_blank / window.open) whose URL
 * belongs to an installed web app into that app's own window, so e.g. a
 * ditto.pub link opens in the Ditto app rather than a generic browser tab.
 *
 * Renders nothing. Does nothing outside the Electron shell.
 */
export function BrowserExtensionHost() {
  const { open } = useWindowActions();
  const { findWebAppForUrl } = useInstalledApps();

  useEffect(() => {
    const crx = getCrxBridge();
    if (!crx) return;

    return crx.onTabCommand((command) => {
      // A page opened a link in a new window (target=_blank / window.open).
      // If the URL belongs to an installed web app, open it in that app's own
      // window (at the deep link) instead of a browser tab.
      if (command.type === 'open') {
        const webApp = findWebAppForUrl(command.url);
        if (webApp) {
          open(webApp.id, { url: command.url });
          return;
        }
      }
      // select/close target existing tabs; nothing to do without a browser.
      const needsBrowser = command.type === 'create' || command.type === 'open';
      if (needsBrowser && !hasTabConsumer()) {
        open('web-browser');
      }
      publishTabCommand(command);
    });
  }, [open, findWebAppForUrl]);

  return null;
}
