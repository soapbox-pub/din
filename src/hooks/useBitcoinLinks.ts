import { useCallback, useMemo } from 'react';
import { z } from 'zod';

import { useAppData } from '@/hooks/useAppData';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import type { AppDefinition } from '@/lib/apps';
import { isBitcoinUri } from '@/lib/bitcoinUri';
import { launchNativeApp } from '@/lib/nativeApps';
import { handlerUrl } from '@/lib/nostrUri';
import { OPEN_WITH_APP_ID, openWithParams } from '@/lib/settingsWindows';

/** App-data key: `computer.din.bitcoin-link-default`, the app's id ('' for none). */
const DEFAULT_KEY = 'bitcoin-link-default';

const DefaultSchema: z.ZodType<string> = z.string().max(512);

/**
 * Which apps open `bitcoin:` links (src/lib/bitcoinUri.ts), the one they open
 * in without asking, and opening a link in one. Must be used within the
 * Desktop.
 */
export function useBitcoinLinks() {
  const { apps, getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const [defaultId, setDefaultId] = useAppData(DEFAULT_KEY, DefaultSchema, '');

  const handlers = useMemo(() => apps.filter((app) => app.bitcoin), [apps]);

  /** The app chosen with "Always", if it's still installed and still opens them. */
  const defaultApp = useMemo((): AppDefinition | undefined => {
    const app = defaultId ? getApp(defaultId) : undefined;
    return app?.bitcoin ? app : undefined;
  }, [defaultId, getApp]);

  /** Make an app the one links open in without asking, or (null) ask again. */
  const setDefault = useCallback((appId: string | null) => setDefaultId(appId ?? ''), [setDefaultId]);

  /** Open a link in an app that opens bitcoin: links. */
  const openWith = useCallback(
    (app: AppDefinition, uri: string) => {
      const link = uri.trim();
      if (!isBitcoinUri(link) || !app.bitcoin) return;
      if (app.native) launchNativeApp(app, link);
      else if (app.bitcoin.url) open(app.id, { url: handlerUrl(app.bitcoin.url, link) });
      else if (app.bitcoin.params) {
        const params = Object.fromEntries(
          Object.entries(app.bitcoin.params).map(([key, value]) => [key, value.replace('%s', link)]),
        );
        open(app.id, params);
      }
    },
    [open],
  );

  /**
   * Open a link the way clicking it should: in the app chosen with "Always",
   * in the only app that opens them (Wallet, on its own), or else in the
   * Open With chooser.
   */
  const openBitcoinUri = useCallback(
    (uri: string) => {
      const link = uri.trim();
      if (!isBitcoinUri(link)) return;
      const app = defaultApp ?? (handlers.length === 1 ? handlers[0] : undefined);
      if (app) openWith(app, link);
      else if (handlers.length > 1) open(OPEN_WITH_APP_ID, openWithParams(link));
    },
    [defaultApp, handlers, openWith, open],
  );

  return { handlers, defaultApp, setDefault, openWith, openBitcoinUri };
}
