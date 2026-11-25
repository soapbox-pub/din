import { useCallback, useMemo } from 'react';
import { z } from 'zod';

import { useAppData } from '@/hooks/useAppData';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import type { AppDefinition } from '@/lib/apps';
import { launchNativeApp } from '@/lib/nativeApps';
import { handlerUrl } from '@/lib/nostrUri';
import { appLinkScheme, isClaimableScheme } from '@/lib/schemeLinks';
import { OPEN_WITH_APP_ID, openWithParams } from '@/lib/settingsWindows';

/** App-data key: `computer.din.link-defaults`, the app each scheme opens in ('' to ask). */
const DEFAULTS_KEY = 'link-defaults';
/** Before every scheme had one: the app `bitcoin:` links opened in. */
const LEGACY_BITCOIN_KEY = 'bitcoin-link-default';

const DefaultsSchema: z.ZodType<Record<string, string>> = z.record(z.string().max(64), z.string().max(512));
const LegacySchema: z.ZodType<string> = z.string().max(512);

/**
 * Which apps open links of each scheme (src/lib/schemeLinks.ts), the one
 * each opens in without asking, and opening a link in one. Must be used
 * within the Desktop.
 */
export function useSchemeLinks() {
  const { apps, getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const [stored, setStored] = useAppData(DEFAULTS_KEY, DefaultsSchema, {});
  const [legacyBitcoin] = useAppData(LEGACY_BITCOIN_KEY, LegacySchema, '');

  /** The apps that open each scheme, by scheme. */
  const byScheme = useMemo(() => {
    const map: Record<string, AppDefinition[]> = {};
    for (const app of apps) for (const scheme of Object.keys(app.protocols ?? {})) (map[scheme] ??= []).push(app);
    return map;
  }, [apps]);

  const handlersFor = useCallback((scheme: string): AppDefinition[] => byScheme[scheme] ?? [], [byScheme]);

  /** The schemes some app opens, sorted. */
  const schemes = useMemo(() => Object.keys(byScheme).sort(), [byScheme]);

  /** The app chosen with "Always" for a scheme, if it's still installed and still opens them. */
  const defaultFor = useCallback(
    (scheme: string): AppDefinition | undefined => {
      const id = stored[scheme] ?? (scheme === 'bitcoin' ? legacyBitcoin : '');
      const app = id ? getApp(id) : undefined;
      return app?.protocols?.[scheme] ? app : undefined;
    },
    [stored, legacyBitcoin, getApp],
  );

  /** Make an app the one a scheme's links open in without asking, or (null) ask again. */
  const setDefault = useCallback(
    (scheme: string, appId: string | null) => setStored((prev) => ({ ...prev, [scheme]: appId ?? '' })),
    [setStored],
  );

  /** Open a link in an app that opens its scheme. */
  const openWith = useCallback(
    (app: AppDefinition, uri: string) => {
      const link = uri.trim();
      const scheme = appLinkScheme(link);
      const handler = scheme ? app.protocols?.[scheme] : undefined;
      if (!handler) return;
      if (app.native) launchNativeApp(app, link);
      else if (handler.url) open(app.id, { url: handlerUrl(handler.url, link) });
      else if (handler.params) {
        const params = Object.fromEntries(
          Object.entries(handler.params).map(([key, value]) => [key, value.replace('%s', link)]),
        );
        open(app.id, params);
      }
    },
    [open],
  );

  /**
   * Open a link the way clicking it should: in the app chosen with "Always",
   * in the only app that opens its scheme (Wallet, for bitcoin:, on its
   * own), or else in Open With, which asks which, or says no app opens it.
   */
  const openSchemeUri = useCallback(
    (uri: string) => {
      const link = uri.trim();
      const scheme = appLinkScheme(link);
      if (!scheme) return;
      const handlers = isClaimableScheme(scheme) ? handlersFor(scheme) : [];
      const app = defaultFor(scheme) ?? (handlers.length === 1 ? handlers[0] : undefined);
      if (app) openWith(app, link);
      else open(OPEN_WITH_APP_ID, openWithParams(link));
    },
    [defaultFor, handlersFor, openWith, open],
  );

  return { schemes, handlersFor, defaultFor, setDefault, openWith, openSchemeUri };
}
