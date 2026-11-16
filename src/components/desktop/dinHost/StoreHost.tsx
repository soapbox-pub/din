import { useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { nip19 } from 'nostr-tools';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { canTryOn, useTryOn } from '@/components/desktop/dinHost/storeTryOn';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { InstalledAppsContext } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useChooseAppFolder } from '@/hooks/useChooseAppFolder';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDesktopThemeEditor, type ThemeSnapshot } from '@/hooks/useDesktopTheme';
import { useIconThemeStatus } from '@/hooks/useIconTheme';
import { useManifestRelays } from '@/hooks/useNsiteCatalog';
import { installFlatpak, removeFlatpak, useFlatpaksBusy, useFlatpakStatus, useInstalledFlatpaks } from '@/hooks/useNostrFlatpaks';
import { useSystemCursorStatus } from '@/hooks/useSystemCursor';
import { canKeepPackages, useInstalledPackages, useThemePackageActions } from '@/hooks/useThemePackages';
import { useThemeActions } from '@/hooks/useThemes';
import { canAddFileApps } from '@/lib/fileApps';
import { FOLDER_APP_WINDOW_ID } from '@/lib/settingsWindows';
import { NATIVE_APP_PREFIX } from '@/lib/nativeApps';
import { NSITE_CATALOG_RELAY } from '@/lib/nsiteCatalog';
import { nsiteAppId } from '@/lib/nsiteApps';
import { getNsiteStore } from '@/lib/nsiteStore';
import { chosenFormat, cleanFlatpakError, fetchFlatpakApp, formatName, isOutdated, parseAppNaddr } from '@/lib/nostrFlatpaks';
import { isSkinFileName } from '@/lib/skinPackages';
import { fetchThemeDefinition, parseThemeNaddr, themeCoordinate, themeNaddr, type ThemeDefinition } from '@/lib/themeDefinition';
import { fetchThemePackage, packageCoordinate, packageNaddr, parsePackageNaddr, type ThemePackage } from '@/lib/themePackages';
import { sameThemeLook } from '@/lib/profileTheme';
import type { StoreItem, StorePackageType, StoreState } from '@/sdk/din';
import type { Push } from '@/sdk/protocol';
import type { StoreHandlers } from '@/components/desktop/dinHost/storeMethods';

/**
 * The desktop's half of `din.store`, for an app with the `store` permission
 * (the App Store): what it shows of this computer, pushed whenever that
 * changes, and what it asks the desktop to do.
 *
 * The store names what to install by where it's published, and everything
 * is looked up here again, on the user's relays, filtered by its author: the
 * store renders strangers' listings in a process of its own, so what it says
 * about them is never what's installed. A Linux app runs as the user, so it
 * also asks on screen first, from here, where the store can't answer for
 * the user; so does deleting from Nostr, which can't be undone.
 *
 * What a window tries on (a pointer, icons, a theme) comes off when it
 * closes, and a theme it used is published then, as the App Store did when
 * it was the desktop's own.
 */


interface Question {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

/** A theme being tried on, and what was worn before it. */
interface Trial {
  theme: ThemeDefinition;
  previous: ThemeSnapshot;
}

/** What was worn before a run of themes was used, and what that run added to the user's themes. */
interface Streak {
  previous: ThemeSnapshot;
  added: ThemeDefinition[];
  current: ThemeDefinition;
}

const PACKAGE_TYPES: readonly StorePackageType[] = ['cursor', 'icon', 'skin'];

function fail(message: string): never {
  throw new Error(message);
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** A published cursor theme, icon set or skin, by its address. */
function packageAddress(address: string) {
  const parsed = parsePackageNaddr(String(address));
  if (!parsed || parsed.type === 'extension') fail('That isn’t the address of a cursor theme, icon set or skin');
  return parsed;
}

export function StoreHost({ api, push, appName }: { api: Ref<StoreHandlers>; push: (message: Push) => void; appName: string }) {
  const installedApps = useContext(InstalledAppsContext);
  const actions = useWindowActions();
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const relays = useManifestRelays();
  const packageActions = useThemePackageActions();
  const editor = useDesktopThemeEditor();
  const themeActions = useThemeActions();
  const cursorStatus = useSystemCursorStatus();
  const iconStatus = useIconThemeStatus();
  const installedCursors = useInstalledPackages('cursor');
  const installedIcons = useInstalledPackages('icon');
  const installedSkins = useInstalledPackages('skin');
  const linuxStatus = useFlatpakStatus();
  const linuxInstalled = useInstalledFlatpaks();
  const linuxBusy = useFlatpaksBusy();
  const { choose: chooseAppFolder } = useChooseAppFolder();
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);
  const [asking, setAsking] = useState<Question[]>([]);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [streak, setStreak] = useState<Streak | null>(null);
  /** Nsites installed by Get, to open once they're in the launcher (a render after installing). */
  const openOnInstall = useRef(new Set<string>());

  const installedOf = (type: StorePackageType) =>
    type === 'cursor' ? installedCursors.data : type === 'icon' ? installedIcons.data : installedSkins.data;
  const installedId = (pkg: ThemePackage) =>
    pkg.type === 'extension' ? null : (installedOf(pkg.type)?.get(packageCoordinate(pkg))?.id ?? null);
  const tryOn = useTryOn(installedId);

  // ---- what the store shows ----
  const readRelays = config.relayMetadata.relays;
  const state = useMemo((): StoreState => {
    const relayUrls = [...new Set([...readRelays.filter((r) => r.read).map((r) => r.url), NSITE_CATALOG_RELAY])];
    const current = { cursor: cursorStatus.data?.theme ?? null, icon: iconStatus.data?.theme ?? null, skin: null };
    const canChange = { cursor: cursorStatus.data?.canChange !== false, icon: iconStatus.data?.canChange !== false, skin: true };
    const packages = Object.fromEntries(PACKAGE_TYPES.map((type) => [type, {
      canInstall: canKeepPackages(type) && canChange[type],
      current: current[type],
      installed: [...(installedOf(type) ?? new Map()).entries()].map(([coordinate, entry]) => ({
        coordinate,
        id: entry.id,
        publishedAt: entry.publishedAt,
      })),
    }])) as StoreState['packages'];
    const status = linuxStatus.data;
    const installedLinux = [...(linuxInstalled.data?.values() ?? [])];
    const worn = editor.theme;
    return {
      pubkey: user?.pubkey ?? null,
      relays: relayUrls,
      nsites: {
        canInstall: Boolean(getNsiteStore()),
        installed: (installedApps?.nsiteApps ?? []).map((entry) => entry.host),
      },
      packages,
      linux: status
        ? {
            ...status,
            installed: installedLinux,
            busy: linuxBusy,
            launchable: installedLinux.filter((app) => installedApps?.getApp(NATIVE_APP_PREFIX + app.appId)).map((app) => app.appId),
          }
        : null,
      tryingOn: tryOn.trying ? { address: packageNaddr(tryOn.trying), loading: tryOn.loading } : null,
      themes: {
        worn: worn ? { pubkey: worn.source?.pubkey ?? null, identifier: worn.source?.identifier ?? null, look: worn } : null,
        library: themeActions.library,
        trying: trial ? themeNaddr(trial.theme) : null,
        using: streak ? themeNaddr(streak.current) : null,
      },
      canAddFolderApps: canAddFileApps(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- installedOf reads the three queries listed.
  }, [readRelays, user?.pubkey, cursorStatus.data, iconStatus.data, installedCursors.data, installedIcons.data, installedSkins.data,
    linuxStatus.data, linuxInstalled.data, linuxBusy, installedApps, tryOn.trying, tryOn.loading, editor.theme, themeActions.library, trial, streak]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
    push({ type: 'store', state });
  }, [state, push]);

  // Get opens an nsite once it's in the launcher.
  useEffect(() => {
    for (const host of openOnInstall.current) {
      if (!installedApps?.findNsiteApp(host)) continue;
      openOnInstall.current.delete(host);
      actions.open(nsiteAppId(host));
    }
  }, [installedApps, actions]);

  // ---- themes, as the App Store's Themes wore them ----
  const live = useRef({ trial, streak, editor });
  useEffect(() => {
    live.current = { trial, streak, editor };
  });
  // Closing the store takes off what's tried on, and sends what was used.
  useEffect(() => () => {
    const { trial: t, editor: e } = live.current;
    if (t) e.restore(t.previous);
    else e.commit();
  }, []);

  const isWorn = (theme: ThemeDefinition) =>
    !!editor.theme &&
    editor.theme.source?.pubkey === theme.pubkey &&
    editor.theme.source.identifier === theme.identifier &&
    sameThemeLook(editor.theme, theme.theme);

  const lookUpTheme = async (address: string): Promise<ThemeDefinition> => {
    const parsed = parseThemeNaddr(String(address));
    if (!parsed) fail('That isn’t a theme’s address');
    return (await fetchThemeDefinition(parsed, relays)) ?? fail('No theme is published at that address on your relays');
  };

  // ---- asking the user ----
  const confirm = (question: Omit<Question, 'resolve'>) =>
    new Promise<boolean>((resolve) => setAsking((queue) => [...queue, { ...question, resolve }]));
  const current = asking[0];
  const settle = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    setAsking((queue) => queue.slice(1));
  };
  // Questions left when the store goes are answered no.
  const askingRef = useRef(asking);
  useEffect(() => {
    askingRef.current = asking;
  });
  useEffect(() => () => askingRef.current.forEach((q) => q.resolve(false)), []);

  const query = (filters: Parameters<typeof relays.query>[0]) => relays.query(filters, { signal: AbortSignal.timeout(8000) });

  const install = async (item: StoreItem): Promise<string> => {
    if (item?.type === 'nsite') {
      const host = String(item.host);
      if (!installedApps) fail('Apps can’t be installed here');
      const had = installedApps.findNsiteApp(host);
      if (had) return nsiteAppId(had.host);
      const entry = installedApps.installNsiteApp(host) ?? fail('This site’s address is not one Din can install');
      openOnInstall.current.add(entry.host);
      return nsiteAppId(entry.host);
    }
    if (item?.type === 'package') {
      const address = packageAddress(item.address);
      const pkg = (await fetchThemePackage(address, query)) ?? fail('That isn’t published on your relays any more');
      try {
        return await packageActions.install(pkg);
      } catch (error) {
        fail(cleanError(error));
      }
    }
    if (item?.type === 'linux') {
      const address = parseAppNaddr(String(item.address)) ?? fail('That isn’t a Linux app’s address');
      const status = stateRef.current.linux;
      if (!status?.available || !status.platform) fail('Linux apps from Nostr don’t install on this computer');
      const app = (await fetchFlatpakApp(address, status.platform, query))
        ?? fail('No Linux app with a Flatpak or an AppImage for this computer is published at that address on your relays');
      const installed = status.installed.find((a) => a.appId === app.identifier);
      const format = item.format === 'flatpak' || item.format === 'appimage' ? item.format : chosenFormat(app, status.formats, installed);
      if (installed && installed.format !== format) fail(`${app.name} is installed as ${installed.format === 'appimage' ? 'an AppImage' : 'a Flatpak'}; remove it first`);
      if (!app.assets[format]) fail(`${app.name} has no ${formatName(format)} for this computer`);
      if (!status.formats.includes(format)) fail(`${formatName(format)}s don’t install on this computer`);
      if (installed && !isOutdated(installed, app)) return installed.appId;
      const author = nip19.npubEncode(app.pubkey);
      const ok = await confirm({
        title: installed ? `Update ${app.name}?` : `Install ${app.name}?`,
        description: `${app.name} ${app.release.version} (${app.identifier}) is published on Nostr by ${author.slice(0, 16)}…. ${
          format === 'appimage'
            ? 'It runs on this computer as an AppImage, outside Flatpak’s sandbox, with everything you can reach.'
            : 'It runs on this computer as a Flatpak.'
        } Install it only if you trust whoever published it.`,
        action: installed ? 'Update' : 'Install',
      });
      if (!ok) {
        const error = new Error('You didn’t allow it');
        error.name = 'AbortError';
        throw error;
      }
      try {
        return (await installFlatpak(app, format)).appId;
      } catch (error) {
        fail(cleanFlatpakError(error));
      } finally {
        void linuxInstalled.refetch();
      }
    }
    fail('The App Store can’t install that');
  };

  const handlers: StoreHandlers = {
    'store.state': async () => stateRef.current,
    'store.install': ({ item }) => install(item),
    'store.use': async ({ type, id }) => {
      if (!PACKAGE_TYPES.includes(type)) fail('Not a cursor theme, icon set or skin');
      const known = stateRef.current.packages[type].installed.some((p) => p.id === id);
      if (!known) fail('That isn’t installed from the App Store');
      try {
        await packageActions.use(type, String(id));
      } catch (error) {
        fail(cleanError(error));
      }
    },
    'store.remove': async ({ item }) => {
      if (item?.type === 'linux') {
        const appId = String(item.appId);
        if (!stateRef.current.linux?.installed.some((a) => a.appId === appId)) fail('That isn’t installed from Nostr');
        try {
          await removeFlatpak(appId);
        } catch (error) {
          fail(cleanFlatpakError(error));
        } finally {
          void linuxInstalled.refetch();
        }
        return;
      }
      if (!item || !PACKAGE_TYPES.includes(item.type)) fail('Not a cursor theme, icon set or skin');
      // Only what was got from the App Store; the rest is Settings'.
      if (!stateRef.current.packages[item.type].installed.some((p) => p.id === item.id)) fail('That isn’t installed from the App Store');
      try {
        await packageActions.remove(item.type, String(item.id));
      } catch (error) {
        fail(cleanError(error));
      }
    },
    'store.open': async ({ item }) => {
      if (item?.type === 'nsite') {
        const entry = installedApps?.findNsiteApp(String(item.host)) ?? fail('That app isn’t installed');
        actions.open(nsiteAppId(entry.host));
        return;
      }
      if (item?.type === 'linux') {
        const id = NATIVE_APP_PREFIX + String(item.appId);
        if (!stateRef.current.linux?.installed.some((a) => a.appId === item.appId) || !installedApps?.getApp(id)) {
          fail('It isn’t in the launcher yet');
        }
        actions.open(id);
        return;
      }
      fail('The App Store can’t open that');
    },
    'store.tryOn': async ({ address }) => {
      const parsed = packageAddress(address);
      const pkg = (await fetchThemePackage(parsed, query)) ?? fail('That isn’t published on your relays any more');
      if (!canTryOn(pkg)) fail('That can’t be tried on here');
      tryOn.start(pkg);
    },
    'store.endTryOn': async ({ keep }) => {
      if (keep) tryOn.keep();
      else tryOn.stop();
    },
    'store.themes.tryOn': async ({ address }) => {
      const theme = await lookUpTheme(address);
      const { trial: t, editor: e } = live.current;
      if ((t && themeCoordinate(t.theme) === themeCoordinate(theme)) || isWorn(theme)) return;
      const previous = t?.previous ?? e.snapshot();
      e.apply(theme.theme, { hold: 'until-commit' });
      setTrial({ theme, previous });
    },
    'store.themes.stopTrying': async () => {
      const { trial: t, editor: e } = live.current;
      if (!t) return;
      e.restore(t.previous);
      setTrial(null);
    },
    'store.themes.use': async ({ address }) => {
      const theme = await lookUpTheme(address);
      if (isWorn(theme)) return;
      const { trial: t, editor: e } = live.current;
      // What was worn before trying on is what Revert puts back.
      const previous = t?.previous ?? e.snapshot();
      e.apply(theme.theme, { hold: true });
      setTrial(null);
      const adds = !themeActions.isAdded(theme);
      if (adds) themeActions.add(theme);
      setStreak((prev) => ({
        previous: prev?.previous ?? previous,
        added: adds ? [...(prev?.added ?? []), theme] : (prev?.added ?? []),
        current: theme,
      }));
    },
    'store.themes.revert': async () => {
      const { streak: s, editor: e } = live.current;
      if (!s) return;
      e.restore(s.previous);
      for (const theme of s.added) themeActions.removeFromLibrary(theme);
      setStreak(null);
    },
    'store.themes.done': async () => {
      live.current.editor.commit();
      setStreak(null);
    },
    'store.themes.removeFromLibrary': async ({ address }) => {
      const parsed = parseThemeNaddr(String(address)) ?? fail('That isn’t a theme’s address');
      if (parsed.pubkey === user?.pubkey) fail('Your own themes stay in your library');
      themeActions.removeFromLibrary(parsed);
    },
    'store.deletePublished': async ({ address }) => {
      const parsed = packageAddress(address);
      if (!user || parsed.pubkey !== user.pubkey) fail('Only your own can be deleted');
      const pkg = (await fetchThemePackage(parsed, query)) ?? fail('That isn’t on your relays any more');
      const ok = await confirm({
        title: `Delete ${pkg.title} from Nostr?`,
        description: `${appName} asks to delete it from your relays, so it leaves the App Store. Anyone who already has it keeps it.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) return false;
      try {
        await packageActions.deleteOwn(pkg);
      } catch (error) {
        fail(cleanError(error));
      }
      return true;
    },
    'store.publishSkin': async ({ fileName }) => {
      const name = String(fileName);
      if (!isSkinFileName(name)) fail('That isn’t a skin’s file name');
      if (!user) fail('Sign in to publish to Nostr');
      setPublishing({ type: 'skin', id: name, name: name.replace(/\.[^.]+$/, '').replace(/_/g, ' ') });
    },
    'store.addFolderApp': async () => {
      if (!canAddFileApps()) fail('Apps can’t be added from folders here');
      const opened = await chooseAppFolder();
      if (opened) actions.open(FOLDER_APP_WINDOW_ID, { path: opened.path, at: Date.now() });
    },
  };
  useImperativeHandle(api, () => handlers);

  return (
    <>
      <PublishThemePackage target={publishing} onClose={() => setPublishing(null)} />
      <AlertDialog open={!!current} onOpenChange={(open) => !open && settle(false)}>
        {current && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{current.title}</AlertDialogTitle>
              <AlertDialogDescription>{current.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => settle(false)}>Don’t Allow</AlertDialogCancel>
              <AlertDialogAction
                className={current.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
                onClick={() => settle(true)}
              >
                {current.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
