/**
 * Typed access to the OS power bridge exposed by the Electron preload
 * (`window.power`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by /sys/class/power_supply in the main process, so it works on any
 * Linux session (cage/Wayland or bare X11) with no external dependency. On
 * machines with no battery (desktops, the QEMU VM) or in a plain browser the
 * bridge is absent or `status()` resolves with `available: false`; callers
 * must feature-detect and render nothing / a fallback.
 */

export type BatteryStatus =
  | 'charging'
  | 'discharging'
  | 'full'
  | 'not-charging'
  | 'unknown';

export interface BatteryInfo {
  /** Kernel name, e.g. "BAT0". */
  name: string;
  /** Charge level 0-100, or null if the kernel didn't report one. */
  percent: number | null;
  status: BatteryStatus;
  /**
   * Seconds until empty (discharging) or full (charging), or null when the
   * kernel reports no draw/charge rate (e.g. idle at 100%).
   */
  secondsRemaining: number | null;
}

export interface PowerStatus {
  /** False when no battery is present. */
  available: boolean;
  /** Whether external power (AC adapter or USB-PD) is connected. */
  acConnected: boolean;
  batteries: BatteryInfo[];
}

export interface PowerBridge {
  /** Battery/AC state. `available: false` when no battery is present. */
  status(): Promise<PowerStatus>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    power?: PowerBridge;
  }
}

/** The power bridge, or undefined when running outside the Electron shell. */
export function getPowerBridge(): PowerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.power;
}

export interface PowerSummary {
  /** Aggregate charge level across batteries, or null if none reported one. */
  percent: number | null;
  charging: boolean;
  status: BatteryStatus;
  /** Time estimate, only when a single battery is present (else ambiguous). */
  secondsRemaining: number | null;
}

/**
 * Collapse a machine's batteries into one summary for the menu-bar indicator.
 * Returns null when there are no batteries.
 */
export function summarizePower(status: PowerStatus): PowerSummary | null {
  if (status.batteries.length === 0) return null;

  const levels = status.batteries
    .map((b) => b.percent)
    .filter((p): p is number => p !== null);
  const percent =
    levels.length > 0
      ? Math.round(levels.reduce((sum, p) => sum + p, 0) / levels.length)
      : null;

  const charging = status.batteries.some((b) => b.status === 'charging');
  const discharging = status.batteries.some((b) => b.status === 'discharging');
  const overall: BatteryStatus = charging
    ? 'charging'
    : discharging
      ? 'discharging'
      : status.batteries.some((b) => b.status === 'full')
        ? 'full'
        : status.batteries[0].status;

  // A time estimate only makes sense for a single battery; averaging two
  // batteries' remaining times would be meaningless.
  const secondsRemaining =
    status.batteries.length === 1 ? status.batteries[0].secondsRemaining : null;

  return { percent, charging, status: overall, secondsRemaining };
}

/** Human-readable time estimate, e.g. "2 hr 15 min", "45 min". */
export function formatTimeRemaining(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Less than a minute';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}
