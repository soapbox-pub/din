/**
 * Typed access to DinOS's lock screen (`window.dinos.lock`, see
 * electron/preload.cjs + electron/lock.mts). Absent in a plain browser.
 */

export interface LockBridge {
  available(): Promise<boolean>;
  lock(): Promise<void>;
  fingerprintStatus(): Promise<FingerprintStatus>;
  setFingerprintUnlock(enabled: boolean, password?: string): Promise<void>;
  removeFingerprint(finger: string): Promise<void>;
  enrollFingerprint(id: string, finger: string, password: string): Promise<void>;
  cancelFingerprint(id: string): Promise<void>;
  onFingerprintProgress(listener: (id: string, progress: FingerprintProgress) => void): () => void;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  /** What sudo asks for. */
  sudoMode(): Promise<SudoMode>;
  /**
   * Change what sudo asks for. Loosening it - from the password to
   * approval, or to nothing - takes the password.
   */
  setSudoMode(mode: SudoMode, password?: string): Promise<void>;
}

export interface FingerprintStatus {
  reader: string | null;
  fingers: string[];
  enabled: boolean;
}

export interface FingerprintProgress {
  status: string;
  passed: number;
  stages: number;
  swipe: boolean;
}

export const FINGERPRINT_STATUS_KEY = ['lock', 'fingerprints'] as const;
export const FINGERPRINT_SETUP_APP_ID = 'fingerprint-setup';
export const FINGERS = ['right', 'left'].flatMap((side) =>
  ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'little-finger'].map((finger) => ({
    id: `${side}-${finger}`,
    label: `${side === 'right' ? 'Right' : 'Left'} ${finger.replace('-finger', ' finger')}`,
  })),
);

/**
 * What sudo asks for before it runs something as administrator: approval
 * with a click in Din, the computer's password, or nothing.
 */
export type SudoMode = 'approve' | 'password' | 'skip';

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    lock?: LockBridge;
  }
}

/** Strip Electron's IPC wrapper from an error message. */
export function cleanLockError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The bridge, or undefined outside the Electron shell. */
export function getLockBridge(): LockBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.lock;
}
