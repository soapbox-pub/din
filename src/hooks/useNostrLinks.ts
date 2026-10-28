import { useCallback, useMemo } from 'react';
import { useNostr } from '@nostrify/react';
import { z } from 'zod';

import { useAppData } from '@/hooks/useAppData';
import { fetchNostrTarget } from '@/hooks/useNostrTarget';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import type { AppDefinition } from '@/lib/apps';
import { launchNativeApp } from '@/lib/nativeApps';
import { handlerUrl, handlesKind, knownKind, parseNostrUri } from '@/lib/nostrUri';

/** The app each kind's nostr: links open in without asking, by kind. */
export type NostrLinkDefaults = Record<string, string>;

const NostrLinkDefaultsSchema: z.ZodType<NostrLinkDefaults> = z.record(
  z.string().regex(/^\d{1,5}$/),
  z.string().min(1).max(512),
);

const NO_DEFAULTS: NostrLinkDefaults = {};

/** App-data key: `computer.din.nostr-link-defaults`. */
const DEFAULTS_KEY = 'nostr-link-defaults';

/** How long a link waits to learn its kind before it shows the preview instead. */
const KIND_LOOKUP_MS = 3000;

/**
 * Which apps open nostr: links, the user's default app per kind, and opening
 * a link in one. Must be used within the Desktop.
 */
export function useNostrLinks() {
  const { nostr } = useNostr();
  const { apps, getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const [defaults, setDefaults] = useAppData(DEFAULTS_KEY, NostrLinkDefaultsSchema, NO_DEFAULTS);

  const handlers = useMemo(() => apps.filter((app) => app.nostr), [apps]);

  /** The apps that show a kind (null: not known yet, so every handler). */
  const handlersFor = useCallback(
    (kind: number | null) => handlers.filter((app) => handlesKind(app.nostr!.kinds, kind)),
    [handlers],
  );

  /** The default app for a kind, if it is still installed and still handles it. */
  const defaultFor = useCallback(
    (kind: number | null): AppDefinition | undefined => {
      if (kind === null) return undefined;
      const id = defaults[String(kind)];
      const app = id ? getApp(id) : undefined;
      return app?.nostr && handlesKind(app.nostr.kinds, kind) ? app : undefined;
    },
    [defaults, getApp],
  );

  const setDefault = useCallback(
    (kind: number, appId: string | null) =>
      setDefaults((prev) => {
        const next = { ...prev };
        if (appId) next[String(kind)] = appId;
        else delete next[String(kind)];
        return next;
      }),
    [setDefaults],
  );

  /** Open a link in an app that handles nostr: links. */
  const openWith = useCallback(
    (app: AppDefinition, uri: string) => {
      const parsed = parseNostrUri(uri);
      if (!parsed || !app.nostr) return;
      if (app.native) {
        launchNativeApp(app.id, parsed.uri);
        return;
      }
      if (app.nostr.url) open(app.id, { url: handlerUrl(app.nostr.url, parsed.uri) });
    },
    [open],
  );

  /**
   * Open a link the way clicking it should: in the default app for its kind,
   * when there is one, or else by `fallback` (the preview in the Web
   * Browser). A link that doesn't say its kind (`note1…`) is looked up first,
   * but only when there are defaults to look it up for.
   */
  const openNostrUri = useCallback(
    async (uri: string, fallback: (uri: string) => void) => {
      const parsed = parseNostrUri(uri);
      if (!parsed) return;
      let kind = knownKind(parsed.target);
      if (kind === null && Object.keys(defaults).length > 0) {
        const event = await fetchNostrTarget(nostr, parsed.target, AbortSignal.timeout(KIND_LOOKUP_MS)).catch(
          () => null,
        );
        kind = event?.kind ?? null;
      }
      const app = defaultFor(kind);
      if (app) openWith(app, parsed.uri);
      else fallback(parsed.uri);
    },
    [defaults, defaultFor, nostr, openWith],
  );

  return { handlers, handlersFor, defaults, defaultFor, setDefault, openWith, openNostrUri };
}
