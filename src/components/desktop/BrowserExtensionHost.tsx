import { useEffect } from 'react';
import { getCrxBridge } from '@/lib/crx';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { useWindowManager } from '@/contexts/WindowManagerContext';

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
 * Renders nothing. Does nothing outside the Electron shell.
 */
export function BrowserExtensionHost() {
  const { open } = useWindowManager();

  useEffect(() => {
    const crx = getCrxBridge();
    if (!crx) return;

    return crx.onTabCommand((command) => {
      // select/close target existing tabs; nothing to do without a browser.
      const needsBrowser = command.type === 'create' || command.type === 'open';
      if (needsBrowser && !hasTabConsumer()) {
        open('web-browser');
      }
      publishTabCommand(command);
    });
  }, [open]);

  return null;
}
