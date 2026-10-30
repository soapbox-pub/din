/**
 * Typed access to the OS display bridge exposed by the Electron preload
 * (`window.dinos.display`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by wlr-randr under din-shell (DinOS, or Din's login session
 * elsewhere) and by xrandr on a bare X11 session - wherever Din is the whole
 * desktop and nothing else manages the outputs. Elsewhere, or in a plain browser, the
 * bridge is absent or `status()` resolves with `available: false`; callers
 * must feature-detect and render a fallback.
 *
 * The bridge models a full multi-output layout: each connected output has a
 * resolution, a position in the shared virtual screen, an on/off state and a
 * primary flag (the monitor with the menu bar and Dock). `applyLayout`
 * commits an entire desired arrangement in one atomic call, so the desktop
 * never passes through a half-configured state. Under din-shell, the arrangement
 * is remembered and reapplied when the same displays are connected again.
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
  /** Output (connector) name, e.g. "eDP-1", "HDMI-A-1". */
  name: string;
  connected: boolean;
  /** Whether this is the primary output. */
  primary: boolean;
  /** Whether the output is currently on (driving a mode). */
  enabled: boolean;
  /** The mode currently in use, or null if the output is off. */
  current: { width: number; height: number } | null;
  /** Top-left position in the shared virtual screen (px); {0,0} when off. */
  position: { x: number; y: number };
  /** Available modes, as the display tool reports them. */
  modes: DisplayMode[];
  /** The AirPlay receiver this display is (one added to extend the desktop). */
  airplay?: string;
}

export interface DisplayStatus {
  /** False where Din can't manage the outputs. */
  available: boolean;
  /** Connected outputs. */
  outputs: DisplayOutput[];
}

/** One output's slot in a desired layout, as sent to `applyLayout`. */
export interface DisplayPlacement {
  output: string;
  /** Turn the output on (true) or off (false). */
  enabled: boolean;
  /** Exactly one enabled output must be primary. */
  primary: boolean;
  /** Top-left position in the shared virtual screen (px). Ignored when off. */
  x: number;
  y: number;
  /** Chosen mode. Must be one the output reports. Ignored when off. */
  width: number;
  height: number;
}

export interface DisplayBridge {
  /** Connected outputs with their modes. `available: false` where unmanageable. */
  status(): Promise<DisplayStatus>;
  /**
   * Apply a complete output arrangement (resolution + position + on/off +
   * primary) in a single atomic call. Every field is re-validated
   * in the main process against the display tool's own report before use.
   */
  applyLayout(placements: DisplayPlacement[]): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    display?: DisplayBridge;
  }
}

/** The display bridge, or undefined when running outside the Electron shell. */
export function getDisplayBridge(): DisplayBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.display;
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

/** A friendlier label for common output names. */
export function friendlyOutputName(name: string): string {
  if (/^(eDP|LVDS|DSI)/i.test(name)) return 'Built-in display';
  if (/^HDMI/i.test(name)) return 'HDMI display';
  if (/^(DisplayPort|DP)/i.test(name)) return 'DisplayPort display';
  if (/^(VGA|DVI)/i.test(name)) return `${name.replace(/-.*/, '')} display`;
  return name;
}

/** True for a laptop's built-in panel (the one that goes off when the lid shuts). */
export function isInternalOutput(name: string): boolean {
  return /^(eDP|LVDS|DSI)/i.test(name);
}

/**
 * Collapse per-refresh-rate rows to unique resolutions, largest first,
 * carrying the current/native flags forward.
 */
export function uniqueModes(modes: DisplayMode[]): DisplayMode[] {
  const byResolution = new Map<string, DisplayMode>();
  for (const mode of modes) {
    const key = `${mode.width}x${mode.height}`;
    const existing = byResolution.get(key);
    byResolution.set(key, {
      width: mode.width,
      height: mode.height,
      current: (existing?.current ?? false) || mode.current,
      preferred: (existing?.preferred ?? false) || mode.preferred,
    });
  }
  return [...byResolution.values()].sort((a, b) => b.width - a.width || b.height - a.height);
}

/** The output's best default mode: preferred, else current, else the largest. */
export function preferredMode(output: DisplayOutput): DisplayMode | null {
  const modes = uniqueModes(output.modes);
  return (
    modes.find((m) => m.preferred) ?? modes.find((m) => m.current) ?? modes[0] ?? null
  );
}
