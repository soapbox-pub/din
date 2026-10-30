import { useEffect } from 'react';
import { getCrxBridge } from '@/lib/crx';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { WEB_POPUP_APP_ID, popupWindowSize } from '@/lib/webPopup';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { isNostrUri } from '@/lib/nostrUri';
import { isMailtoUrl } from '@/lib/mailto';

/**
 * Desktop-lifetime listener for Chrome-extension tab commands (window.dinos.crx).
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
 * A window.open that asked for a pop-up opens a pop-up window (WebPopup).
 *
 * Renders nothing. Does nothing outside the Electron shell.
 */
export function BrowserExtensionHost() {
  const { open } = useWindowActions();
  const { findAppIdForUrl } = useInstalledApps();
  const { openNostrUri } = useNostrLinks();

  useEffect(() => {
    const crx = getCrxBridge();
    if (!crx) return;

    return crx.onTabCommand((command) => {
      // A page asked for a pop-up window (a sign-in window, say): it gets
      // one, linked to its opener, wherever its URL would otherwise go.
      if (command.type === 'open' && command.popup) {
        open(WEB_POPUP_APP_ID, {
          url: command.url,
          openerWcId: command.openerWcId,
          private: command.popup.private,
          ...popupWindowSize(command.popup),
        });
        return;
      }
      // A page opened a link in a new window (target=_blank / window.open).
      // If the URL belongs to an installed web app, open it in that app's own
      // window (at the deep link) instead of a browser tab.
      // A nostr: link a page clicked opens in the default app for its kind,
      // or else as a preview tab beside the page.
      if (command.type === 'open' && isMailtoUrl(command.url)) {
        open('mail', { mailto: command.url });
        return;
      }
      if (command.type === 'open' && isNostrUri(command.url)) {
        void openNostrUri(command.url, (uri) => {
          if (!hasTabConsumer(command)) open('web-browser');
          publishTabCommand({ ...command, url: uri });
        });
        return;
      }
      if (command.type === 'open') {
        const appId = findAppIdForUrl(command.url);
        if (appId) {
          open(appId, { url: command.url });
          return;
        }
      }
      // select/close target existing tabs; nothing to do without a browser.
      const needsBrowser = command.type === 'create' || command.type === 'open';
      if (needsBrowser && !hasTabConsumer(command)) {
        open('web-browser');
      }
      publishTabCommand(command);
    });
  }, [open, findAppIdForUrl, openNostrUri]);

  return null;
}
