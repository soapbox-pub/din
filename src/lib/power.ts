/**
 * Typed access to the OS power bridge exposed by the Electron preload
 * (`window.dinos.power`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by /sys/class/power_supply in the main process, so it works on any
 * Linux session (din-shell/Wayland or bare X11) with no external dependency. On
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
  /** What to call it: "Battery" (or "Battery 2"), or a device's model, e.g. "Magic Mouse". */
  label: string;
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
  /** The computer's own batteries: all the summary and warnings count. */
  batteries: BatteryInfo[];
  /** Batteries in devices connected to it (a Bluetooth mouse), by model. */
  devices: BatteryInfo[];
}

export interface PowerProfilesStatus {
  /**
   * False when no power-profiles daemon (power-profiles-daemon / tuned-ppd) is
   * reachable, e.g. in a plain browser or on a session without one.
   */
  available: boolean;
  /** The active profile id (e.g. "balanced"), or null when unavailable. */
  active: string | null;
  /** Profile ids offered by the daemon, ordered low -> high power. */
  profiles: string[];
}

export interface PowerBridge {
  /** Battery/AC state. `available: false` when no battery is present. */
  status(): Promise<PowerStatus>;
  /** Available power profiles + the active one. `available: false` with no daemon. */
  profiles(): Promise<PowerProfilesStatus>;
  /** Switch the active power profile; resolves to the new profiles state. */
  setProfile(name: string): Promise<PowerProfilesStatus>;
  /** Which of restart and shut down this session may do without a password. */
  actions(): Promise<PowerActions>;
  /** Restart the computer. Rejects while an update or install is running. */
  reboot(): Promise<void>;
  /** Shut the computer down. Rejects while an update or install is running. */
  powerOff(): Promise<void>;
}

export interface PowerActions {
  reboot: boolean;
  powerOff: boolean;
}

/** Strip Electron's IPC wrapper from an error message. */
export function cleanPowerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    power?: PowerBridge;
  }
}

/** The power bridge, or undefined when running outside the Electron shell. */
export function getPowerBridge(): PowerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.power;
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

export interface PowerProfileMeta {
  id: string;
  label: string;
  description: string;
}

/** Presentation for the three standard power-profiles-daemon profiles. */
const PROFILE_META: Record<string, Omit<PowerProfileMeta, 'id'>> = {
  'power-saver': {
    label: 'Power Saver',
    description: 'Reduces performance and background activity to extend battery life.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Standard performance with sensible energy use.',
  },
  performance: {
    label: 'Performance',
    description: 'Highest performance; uses more energy and may run warmer.',
  },
};

/**
 * Human-readable label + description for a power-profile id. Unknown ids
 * (a driver could expose others) fall back to a title-cased label.
 */
export function describePowerProfile(id: string): PowerProfileMeta {
  const meta = PROFILE_META[id];
  if (meta) return { id, ...meta };
  const label = id
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
  return { id, label: label || id, description: '' };
}
