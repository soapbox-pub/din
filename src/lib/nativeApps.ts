/**
 * Typed access to the native-app bridge exposed by the Electron preload
 * (`window.nativeApps`, see electron/preload.cjs + electron/native-apps.mts).
 *
 * Ordinary Linux apps can't live inside Din's single window - they're
 * separate X11 clients with their own toplevel windows. Din leaves those to
 * the host window manager, which stacks them above the shell, and acts as
 * their taskbar: it lists them in the launcher and the Dock, starts them, and
 * raises/minimizes/closes their windows over EWMH.
 *
 * Outside the Electron shell (`npm run dev:browser`), or in a session with no
 * X11 server (Wayland-only, or Aladdin's cage, which has no window manager at
 * all), the bridge is absent or reports `available: false` and the desktop
 * simply shows no native apps.
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

/** One toplevel window of a native app, as the window manager reports it. */
export interface NativeWindow {
  /** X11 window id; the handle for activate/minimize/close. */
  id: number;
  /** The owning app's registry id, or null when it couldn't be matched. */
  appId: string | null;
  title: string;
  minimized: boolean;
  /** Whether this is the session's focused window. */
  active: boolean;
}

/** What `list()` reports. */
export interface NativeAppList {
  /** False without an X11 session Din can manage windows in. */
  available: boolean;
  apps: NativeApp[];
}

export interface NativeAppsBridge {
  /** Installed desktop entries, with icons inlined as data URLs. */
  list(): Promise<NativeAppList>;
  /** The session's current toplevel windows. */
  windows(): Promise<NativeWindow[]>;
  /** Start an app by its registry id. */
  launch(appId: string): Promise<void>;
  /** Raise a window and focus it (un-minimizing it first). */
  activate(windowId: number): Promise<void>;
  /** Minimize a window. */
  minimize(windowId: number): Promise<void>;
  /** Ask a window to close (the app may still prompt to save). */
  close(windowId: number): Promise<void>;
  /** Subscribe to window-list changes. Returns an unsubscribe fn. */
  onWindows(callback: (windows: NativeWindow[]) => void): () => void;
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
 * Launching is fire-and-forget by design: the window manager, not Din, owns
 * what happens next, and an app that fails to start (uninstalled since the
 * last scan) shouldn't take down the click handler that asked for it.
 */
export function launchNativeApp(appId: string): void {
  void getNativeAppsBridge()?.launch(appId).catch(() => {});
}

/**
 * Raise a native window and focus it. The host window manager stacks it
 * above Din's own window, so the shell visibly recedes behind the app.
 */
export function activateNativeWindow(windowId: number): void {
  void getNativeAppsBridge()?.activate(windowId).catch(() => {});
}

/** Minimize a native window. */
export function minimizeNativeWindow(windowId: number): void {
  void getNativeAppsBridge()?.minimize(windowId).catch(() => {});
}

/** Ask a native window to close. */
export function closeNativeWindow(windowId: number): void {
  void getNativeAppsBridge()?.close(windowId).catch(() => {});
}
