/**
 * Typed access to the native-app bridge exposed by the Electron preload
 * (`window.nativeApps`, see electron/preload.cjs + electron/native-apps.mts).
 *
 * Installed Linux apps run on Din's embedded display - a private X server
 * whose windows Din composites into its own (see src/lib/nativeDisplay.ts) -
 * so launching one ends with an ordinary Din window, not a foreign toplevel.
 *
 * Outside the Electron shell (`npm run dev:browser`), or where the embedded
 * display can't run (no Xvfb), the bridge is absent or reports
 * `available: false` and the desktop simply shows no native apps.
 */

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
  /** Freedesktop categories, e.g. ["Utility", "Calculator"]. */
  categories: string[];
  /** Extra search terms from the entry's Keywords. */
  keywords: string[];
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
  /** Start an app by its registry id. */
  launch(appId: string): Promise<void>;
  /**
   * The installed app a window belongs to, by its owner's pid and WM_CLASS,
   * or null when it can't be matched.
   */
  resolve(pid: number | null, wmClass: string[]): Promise<string | null>;
  /**
   * Open a Windows program (.exe, .msi, .bat, .lnk) by absolute path. It
   * runs through Wine, set up on first use; rejects with a user-facing
   * message when it can't (e.g. Wine isn't installed).
   */
  runWindowsProgram(file: string): Promise<void>;
  /** Force quit the program owning a window, by pid (apps on Din's display only). */
  forceQuit(pid: number): Promise<void>;
  /** Subscribe to installed-app changes. Returns an unsubscribe fn. */
  onChanged(callback: () => void): () => void;
}

/** File extensions opened as Windows programs (see electron/windows-apps.mts). */
const WINDOWS_PROGRAM_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.lnk'];

/** Whether a file name is a Windows program Din can open. */
export function isWindowsProgram(name: string): boolean {
  const lower = name.toLowerCase();
  return WINDOWS_PROGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    nativeApps?: NativeAppsBridge;
  }
}

/** The native-app bridge, or undefined outside the Electron shell. */
export function getNativeAppsBridge(): NativeAppsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.nativeApps;
}

/**
 * Launch a native app, ignoring failures.
 *
 * Launching is fire-and-forget by design: the app's window arrives on its
 * own, through the embedded display, and an app that fails to start
 * (uninstalled since the last scan) shouldn't take down the click handler
 * that asked for it.
 */
export function launchNativeApp(appId: string): void {
  void getNativeAppsBridge()?.launch(appId).catch(() => {});
}
