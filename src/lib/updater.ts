/**
 * Typed access to the updater bridge exposed by the Electron preload
 * (`window.updater`, see electron/preload.cjs + electron/updater.mts).
 *
 * An installed DinOS looks for newer releases on its own and stages them for
 * the next boot; Settings shows where that's got to and offers the restart.
 * The bridge is absent outside the Electron shell and reports
 * `available: false` off DinOS.
 */

export type UpdateStep = 'download' | 'fetch' | 'install';

export interface UpdateState {
  available: boolean;
  /** Running from a USB stick, which isn't updated. */
  live: boolean;
  /** The running system's version. */
  current: string | null;
  /** The version the next boot starts, when it isn't the running one. */
  staged: string | null;
  phase: 'idle' | 'checking' | 'updating' | 'failed';
  /** The newer release being staged. */
  updatingTo: string | null;
  step: UpdateStep | null;
  /** Percent of the current step. */
  percent: number;
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
}

export interface UpdaterBridge {
  state(): Promise<UpdateState>;
  /** Look for a newer release now, and stage it. */
  check(): Promise<void>;
  reboot(): Promise<void>;
  onProgress(callback: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    updater?: UpdaterBridge;
  }
}

/** The updater bridge, or undefined outside the Electron shell. */
export function getUpdaterBridge(): UpdaterBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.updater;
}

export const UPDATE_STEP_LABELS: Record<UpdateStep, string> = {
  download: 'Downloading',
  fetch: 'Downloading system packages',
  install: 'Installing',
};
