/** One window in a Dock or taskbar tile. */
export interface DockWindow {
  id: string;
  /** Stacking order; the frontmost window has the highest. */
  z: number;
  minimized: boolean;
  /** What the window's app says it's showing, if anything. */
  title: string | null;
  /** The icon the window's app gave it, if any. */
  icon: string | null;
}

/** How a tile acts on its app and its windows. */
export interface DockControls {
  /** Launch a new instance. */
  open: (appId: string, params?: Record<string, unknown>) => void;
  /** Raise and focus a window. */
  focus: (id: string) => void;
  minimize: (id: string) => void;
  /** Close every window of the app. */
  closeAll: (appId: string, windows: DockWindow[]) => void;
}

/**
 * Raise the window `step` places from the active one among a tile's windows,
 * in launch order. If none of them is active, bring the frontmost forward
 * instead (preferring one that isn't minimized).
 */
export function cycleTile(
  windows: DockWindow[],
  activeWindowId: string | null,
  step: number,
  focus: (id: string) => void,
): void {
  if (windows.length === 0) return;
  const current = windows.findIndex((w) => w.id === activeWindowId);
  if (current === -1) {
    const frontmost = windows.reduce((top, w) =>
      (w.minimized === top.minimized ? w.z > top.z : top.minimized) ? w : top,
    );
    focus(frontmost.id);
    return;
  }
  const n = windows.length;
  focus(windows[(((current + step) % n) + n) % n].id);
}

/**
 * A click on a tile: with no windows it launches the app; with one it
 * focuses it, or minimizes it if it's already the active one; with several it
 * brings the app forward, then cycles which of its windows is on top.
 */
export function clickTile(
  appId: string,
  windows: DockWindow[],
  activeWindowId: string | null,
  controls: DockControls,
): void {
  if (windows.length === 0) {
    controls.open(appId);
  } else if (windows.length === 1) {
    const win = windows[0];
    if (win.id === activeWindowId) controls.minimize(win.id);
    else controls.focus(win.id);
  } else {
    cycleTile(windows, activeWindowId, 1, controls.focus);
  }
}
