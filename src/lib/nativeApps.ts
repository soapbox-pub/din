/**
 * Typed access to the native-app bridge exposed by the Electron preload
 * (`window.dinos.nativeApps`, see electron/preload.cjs + electron/native-apps.mts).
 *
 * Installed Linux apps run on Din's embedded display - a private X server
 * whose windows Din composites into its own (see src/lib/nativeDisplay.ts) -
 * so launching one ends with an ordinary Din window, not a foreign toplevel.
 *
 * Outside the Electron shell (`npm run dev:browser`) the bridge is absent and
 * the desktop shows no native apps. Where the embedded display can't run (no
 * Xvfb) the bridge reports `available: false` but still lists the apps, and
 * launching one notifies the user why it can't start.
 */

import { endLaunching, startLaunching } from '@/lib/appLaunches';
import { closeNotification, notify } from '@/lib/notificationCenter';
import { cleanPackageError, getSystemPackagesBridge, type SystemPackagesBridge } from '@/lib/systemPackages';
import { notifyWithFeature } from '@/lib/featureNotifications';

/** Registry id prefix for native apps, e.g. `native:org.gnome.Calculator`. */
export const NATIVE_APP_PREFIX = 'native:';

/** Whether an app registry id belongs to a native (non-Din) application. */
export function isNativeAppId(appId: string): boolean {
  return appId.startsWith(NATIVE_APP_PREFIX);
}

/** An installed Linux application, from its XDG desktop entry. */
export interface NativeApp {
  /** Desktop-registry id, namespaced so it can't collide with a Din app. */
  id: string;
  /** Desktop file id, e.g. "org.gnome.Calculator.desktop". */
  desktopId: string;
  name: string;
  /** The entry's Comment, shown as a tooltip. */
  comment: string | null;
  /** Icon as a data: URL, or null when none could be resolved. */
  icon: string | null;
  /** Whether the icon is a monochrome theme's glyph, which AppIcon draws on a tile. */
  iconGlyph?: boolean;
  /** Freedesktop categories, e.g. ["Utility", "Calculator"]. */
  categories: string[];
  /** Extra search terms from the entry's Keywords. */
  keywords: string[];
  /** Whether it runs in a terminal (htop): it opens in Din's Terminal. */
  terminal?: boolean;
  /** URL schemes it opens (its desktop entry's x-scheme-handler types), e.g. ["nostr"]. */
  schemes?: string[];
  /** A Windows program installed in Din's prefix, which Din can uninstall. */
  uninstallable?: boolean;
}

/** What `list()` reports. */
export interface NativeAppList {
  /** False where the embedded display can't run. */
  available: boolean;
  apps: NativeApp[];
}

export interface NativeAppsBridge {
  /** Installed desktop entries, with icons inlined as data URLs. */
  list(): Promise<NativeAppList>;
  /** Start an app by its registry id, with a link for it to open (one of its `schemes`). */
  launch(appId: string, uri?: string): Promise<void>;
  /**
   * The app a window belongs to, by its owner's pid and WM_CLASS, or null
   * when it can't be matched. One that isn't installed (a `nix run`
   * program, an AppImage, an .exe, found by where its process runs from) comes with
   * its record, for the desktop to register (`addUnlistedNativeApp`).
   */
  resolve(pid: number | null, wmClass: string[]): Promise<{ appId: string; app?: NativeApp } | null>;
  /**
   * Run a program file by absolute path: a Windows program (.exe, .msi,
   * .bat, .lnk) through Wine, set up on first use, or an AppImage. Rejects
   * with a user-facing message when it can't (e.g. Wine isn't installed).
   */
  runProgram(file: string): Promise<void>;
  /** Force quit the program owning a window, by pid (apps on Din's display only). */
  forceQuit(pid: number): Promise<void>;
  /**
   * Uninstall an `uninstallable` Windows program: run its own uninstaller,
   * in a window of its own, resolving once it's done ('uninstalled'), or,
   * for one without, take away its shortcut ('removed').
   */
  uninstall(appId: string): Promise<'uninstalled' | 'removed'>;
  /**
   * Start Windows apps over: close every Windows program and delete Din's
   * Windows installation (WINDOWS_RESET_CONSEQUENCE).
   */
  resetWindows(): Promise<void>;
  /**
   * The installed apps that open a file, by its type (Open With): Windows
   * programs' own types' first, then by name.
   */
  fileHandlers(file: string): Promise<NativeApp[]>;
  /** Open a file in one of its `fileHandlers`. */
  openFile(appId: string, file: string): Promise<void>;
  /** Subscribe to installed-app changes. Returns an unsubscribe fn. */
  onChanged(callback: () => void): () => void;
  /** Subscribe to links native apps open. Returns an unsubscribe fn. */
  onOpenUrl(callback: (url: string) => void): () => void;
  /**
   * Subscribe to folders and files native apps open (xdg-open) or ask to
   * show in a file manager ("Show in Folder"). Returns an unsubscribe fn.
   */
  onOpenPath(callback: (request: NativeOpenPath) => void): () => void;
}

/** A folder or file a native app opened, or asked to show `select`ed in its folder. */
export interface NativeOpenPath {
  path: string;
  kind: 'directory' | 'file';
  select?: boolean;
}

/**
 * File extensions run as programs when opened: Windows programs, through
 * Wine (electron/windows-apps.mts), and AppImages (electron/native-apps.mts).
 */
const PROGRAM_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.lnk', '.appimage'];

/** Whether a file name is a program Din runs when it's opened. */
export function isProgram(name: string): boolean {
  const lower = name.toLowerCase();
  return PROGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Apps known only because they're running: a program from `nix run`, an
// AppImage, a Windows .exe. Their windows get the app's name and icon from
// the desktop entry beside the program (an .exe's from its resources); the registry lists them, hidden from the
// launcher, for the rest of the session.

let unlisted: readonly NativeApp[] = [];
const unlistedListeners = new Set<() => void>();

/** Register a running app that isn't installed, replacing its old record. */
export function addUnlistedNativeApp(app: NativeApp): void {
  const old = unlisted.find((a) => a.id === app.id);
  if (old && old.name === app.name && old.icon === app.icon) return;
  unlisted = [...unlisted.filter((a) => a.id !== app.id), app];
  for (const listener of unlistedListeners) listener();
}

/** The running apps that aren't installed, for useSyncExternalStore. */
export function unlistedNativeApps(): readonly NativeApp[] {
  return unlisted;
}

/** Subscribe to unlisted apps' arrival. Returns an unsubscribe fn. */
export function subscribeUnlistedNativeApps(listener: () => void): () => void {
  unlistedListeners.add(listener);
  return () => unlistedListeners.delete(listener);
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    nativeApps?: NativeAppsBridge;
  }
}

/** The native-app bridge, or undefined outside the Electron shell. */
export function getNativeAppsBridge(): NativeAppsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.nativeApps;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
function cleanNativeAppError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/**
 * Launch a native app, notifying the user when it can't start.
 *
 * Launching is fire-and-forget by design: the app's window arrives on its
 * own, through the embedded display, and an app that fails to start
 * (uninstalled since the last scan, no Xvfb) shouldn't take down the click
 * handler that asked for it.
 */
export function launchNativeApp(app: { id: string; name: string; feature?: string }, uri?: string): void {
  const bridge = getNativeAppsBridge();
  if (!bridge) return;
  startLaunching(app.id);
  void bridge.launch(app.id, uri).catch(async (error: unknown) => {
    endLaunching(app.id);
    // Missing Xvfb, which Din can install from here: say so, with the button.
    const packages = getSystemPackagesBridge();
    const xvfb = await packages?.status('xvfb').catch(() => null);
    if (packages && xvfb && !xvfb.installed && xvfb.command) {
      notify({
        source: { name: 'Din' },
        title: `Couldn’t open ${app.name}`,
        body: 'Linux apps need Xvfb, which isn’t installed on this computer.',
        actions: [{ id: 'install', label: 'Install Xvfb' }],
        replaceKey: 'packages:xvfb',
        history: true,
        onActivate: (action) => {
          if (action === 'install') installXvfbThenLaunch(packages, app, uri);
        },
      });
      return;
    }
    // With the Install button for the optional feature it needs (Windows apps), if that's missing.
    await notifyWithFeature(
      {
        source: { name: 'Din' },
        title: `Couldn’t open ${app.name}`,
        body: cleanNativeAppError(error),
        history: true,
      },
      app.feature,
      () => launchNativeApp(app, uri),
    );
  });
}

/**
 * Open a file in the installed app for its type when Din has no app of its
 * own for it (`opensItself` false): a Windows program's project file in
 * that program, say. Resolves false when there's none, or no bridge.
 */
export async function openInInstalledApp(file: string): Promise<boolean> {
  const bridge = getNativeAppsBridge();
  if (!bridge) return false;
  const [app] = await bridge.fileHandlers(file).catch(() => []);
  if (!app) return false;
  try {
    await bridge.openFile(app.id, file);
  } catch (error) {
    throw new Error(cleanNativeAppError(error), { cause: error });
  }
  return true;
}

/** What resetting Windows apps does, for whatever asks first. */
export const WINDOWS_RESET_CONSEQUENCE =
  'Every Windows program closes, and every one installed is deleted, with its settings. Files in your Desktop, Documents, Downloads, Music, Pictures and Videos stay.';

/** Start Windows apps over (`resetWindows`), once the user has agreed to. */
export async function resetWindowsApps(): Promise<void> {
  const bridge = getNativeAppsBridge();
  if (!bridge) throw new Error('Windows apps run only in Din’s desktop app');
  try {
    await bridge.resetWindows();
  } catch (error) {
    throw new Error(cleanNativeAppError(error), { cause: error });
  }
}

/**
 * Uninstall a Windows program (`uninstallable`), notifying the user of what
 * came of it: its uninstaller's window says the rest.
 */
export function uninstallNativeApp(app: { id: string; name: string }): void {
  const bridge = getNativeAppsBridge();
  if (!bridge) return;
  bridge.uninstall(app.id).then(
    (result) => {
      if (result !== 'removed') return;
      notify({
        source: { name: 'Din' },
        title: `Removed ${app.name}`,
        body: 'It had no uninstaller, so only its shortcut is gone.',
        history: true,
      });
    },
    (error: unknown) =>
      notify({
        source: { name: 'Din' },
        title: `Couldn’t uninstall ${app.name}`,
        body: cleanNativeAppError(error),
        history: true,
      }),
  );
}

/** Install Xvfb, then open the app it was missing for. */
function installXvfbThenLaunch(packages: SystemPackagesBridge, app: { id: string; name: string; feature?: string }, uri?: string): void {
  const progress = notify({
    source: { name: 'Din' },
    title: 'Installing Xvfb…',
    body: `${app.name} opens once it’s installed.`,
    replaceKey: 'packages:xvfb',
    timeout: 0,
    history: false,
  });
  packages.install('xvfb').then(
    () => {
      closeNotification(progress, 'closed');
      launchNativeApp(app, uri);
    },
    (error: unknown) =>
      notify({
        source: { name: 'Din' },
        title: 'Couldn’t install Xvfb',
        body: cleanPackageError(error),
        replaceKey: 'packages:xvfb',
        history: true,
      }),
  );
}
