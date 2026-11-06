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
 * resolution, a rotation, a position in the shared virtual screen (where a
 * display turned on its side takes its height across), an on/off state and a
 * primary flag (the monitor with the menu bar and Dock). `applyLayout`
 * commits an entire desired arrangement in one atomic call, so the desktop
 * never passes through a half-configured state. Under din-shell, the arrangement
 * is remembered and reapplied when the same displays are connected again.
 */

export interface DisplayMode {
  width: number;
  height: number;
  /** Refresh rate in Hz; 0 where the display tool didn't say. */
  refresh: number;
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
  current: { width: number; height: number; refresh: number } | null;
  /** Top-left position in the shared virtual screen (px); {0,0} when off. */
  position: { x: number; y: number };
  /** Available modes, as the display tool reports them. */
  modes: DisplayMode[];
  /** Its size in millimetres, where the display reports one. */
  physicalSize?: { width: number; height: number };
  /** The AirPlay receiver this display is (one added to extend the desktop). */
  airplay?: string;
  /** How far it's turned (see DisplayRotation); 0 while off. */
  rotation: DisplayRotation;
  /**
   * Layout units per pixel's worth: its zoom, under din-shell (1 = 100%).
   * The display takes up its mode over this in the virtual screen.
   */
  scale?: number;
  /** Which display this is wherever it's plugged in (make, model, serial), under Wayland. */
  id?: string;
}

/**
 * How far a display's picture is turned, in degrees, as Wayland counts an
 * output's transform (xrandr's left, inverted and right): 90 and 270 are the
 * two ways of standing a monitor on its side.
 */
export type DisplayRotation = 0 | 90 | 180 | 270;

export const DISPLAY_ROTATIONS: readonly DisplayRotation[] = [0, 90, 180, 270];

/**
 * What a rotation is called, as GNOME's Settings names it: a display whose
 * own mode (WIDTH x HEIGHT) is tall, like a phone's or a tablet's panel,
 * starts out portrait.
 */
export function rotationLabel(rotation: DisplayRotation, width = 1, height = 0): string {
  const tall = height > width;
  switch (rotation) {
    case 0: return tall ? 'Portrait' : 'Landscape';
    case 90: return tall ? 'Landscape (right)' : 'Portrait (right)';
    case 180: return tall ? 'Portrait (flipped)' : 'Landscape (flipped)';
    case 270: return tall ? 'Landscape (left)' : 'Portrait (left)';
  }
}

/** The width and height a display takes on the shared screen: its mode, on its side at 90 and 270. */
export function rotatedSize(width: number, height: number, rotation: DisplayRotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/** A display's slot in a layout, as far as turning it is concerned. */
interface Turnable {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: DisplayRotation;
  /** Its zoom (din-shell), which its size on the shared screen is over. */
  scale?: number;
}

/**
 * LAYOUT with TARGET turned to ROTATION. It keeps its top-left corner, and
 * the displays beyond its right or bottom edge move with that edge, so ones
 * beside it stay beside it instead of overlapping it or leaving a gap.
 */
export function rotateInLayout<T extends Turnable>(layout: T[], target: T, rotation: DisplayRotation): T[] {
  const before = layoutSize(target.width, target.height, target.rotation ?? 0, target.scale);
  const after = layoutSize(target.width, target.height, rotation, target.scale);
  const right = target.x + before.width;
  const bottom = target.y + before.height;
  return layout.map((d) => {
    if (d === target) return { ...d, rotation };
    if (!d.enabled || !target.enabled) return d;
    return {
      ...d,
      x: d.x >= right ? d.x + after.width - before.width : d.x,
      y: d.y >= bottom ? d.y + after.height - before.height : d.y,
    };
  });
}

export interface DisplayStatus {
  /** False where Din can't manage the outputs. */
  available: boolean;
  /** Connected outputs. */
  outputs: DisplayOutput[];
  /**
   * Whether each display has a zoom of its own (din-shell): set with
   * `setScales`, and the page itself isn't zoomed. Elsewhere the zoom is
   * one for the whole desktop (src/lib/zoom.ts).
   */
  perDisplayZoom?: boolean;
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
  /** Chosen mode, before any rotation. Must be one the output reports. Ignored when off. */
  width: number;
  height: number;
  /** Refresh rate in Hz, one the output offers at that size. Omitted keeps the current one. */
  refresh?: number;
  /** Omitted keeps the current rotation. */
  rotation?: DisplayRotation;
  /** Its zoom (din-shell). Omitted keeps the current one. */
  scale?: number;
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
  /**
   * Zoom displays one by one, by output name (1 = 100%, 0.5 to 3), where
   * `status().perDisplayZoom`. The others move to stay beside them.
   */
  setScales(scales: Record<string, number>): Promise<void>;
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
      // The fastest the resolution goes.
      refresh: Math.max(existing?.refresh ?? 0, mode.refresh),
      current: (existing?.current ?? false) || mode.current,
      preferred: (existing?.preferred ?? false) || mode.preferred,
    });
  }
  return [...byResolution.values()].sort((a, b) => b.width - a.width || b.height - a.height);
}

/** The refresh rates an output offers at a resolution, fastest first (none where unknown). */
export function refreshRates(modes: DisplayMode[], width: number, height: number): number[] {
  const rates = modes.filter((m) => m.width === width && m.height === height && m.refresh > 0).map((m) => m.refresh);
  return [...new Set(rates)].sort((a, b) => b - a);
}

/** "165 Hz", "59.94 Hz": a rate as people know it. */
export function formatRefresh(hz: number): string {
  const rounded = Math.round(hz);
  // 59.999 is "60"; 59.94 (NTSC) stays itself.
  return `${Math.abs(hz - rounded) < 0.05 ? rounded : hz.toFixed(2)} Hz`;
}

/** The output's best default mode: preferred, else current, else the largest. */
export function preferredMode(output: DisplayOutput): DisplayMode | null {
  const modes = uniqueModes(output.modes);
  return (
    modes.find((m) => m.preferred) ?? modes.find((m) => m.current) ?? modes[0] ?? null
  );
}

/**
 * How much of the shared screen a display takes up: its mode, on its side at
 * 90 and 270, over its zoom (din-shell), as the compositor rounds it.
 */
export function layoutSize(width: number, height: number, rotation: DisplayRotation = 0, scale = 1): { width: number; height: number } {
  const turned = rotatedSize(width, height, rotation);
  return { width: Math.round(turned.width / scale), height: Math.round(turned.height / scale) };
}
