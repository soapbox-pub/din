/**
 * Typed access to the OS display bridge exposed by the Electron preload
 * (`window.display`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by xrandr in the main process. It is meaningful only on a bare X11
 * session (the os/x11 standalone launcher), where Din is the whole desktop and
 * nothing else manages screen resolution. Where xrandr doesn't apply
 * (Wayland/cage on Aladdin) or in a plain browser the bridge is absent or
 * `status()` resolves with `available: false`; callers must feature-detect and
 * render a fallback.
 */

export interface DisplayMode {
  width: number;
  height: number;
  /** The mode currently in use on this output. */
  current: boolean;
  /** The output's preferred (native) mode. */
  preferred: boolean;
}

export interface DisplayOutput {
  /** xrandr output name, e.g. "eDP", "HDMI-A-0". */
  name: string;
  connected: boolean;
  /** Whether this is the primary output. */
  primary: boolean;
  /** The mode currently in use, or null if the output is off. */
  current: { width: number; height: number } | null;
  /** Available modes, as xrandr reports them (one entry per resolution). */
  modes: DisplayMode[];
}

export interface DisplayStatus {
  /** False when xrandr is not present (e.g. a Wayland session). */
  available: boolean;
  /** Connected outputs. */
  outputs: DisplayOutput[];
}

export interface DisplayBridge {
  /** Connected outputs with their modes. `available: false` when xrandr is absent. */
  status(): Promise<DisplayStatus>;
  /** Set an output's resolution (validated in main against its reported modes). */
  setMode(output: string, width: number, height: number): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    display?: DisplayBridge;
  }
}

/** The display bridge, or undefined when running outside the Electron shell. */
export function getDisplayBridge(): DisplayBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.display;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanDisplayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** A stable "1920 × 1200" label for a mode/resolution. */
export function formatMode(width: number, height: number): string {
  return `${width} \u00d7 ${height}`;
}
