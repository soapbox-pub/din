/**
 * Typed access to erasing DinOS (`window.dinos.erase`, see
 * electron/preload.cjs + electron/erase.mts), and the Setup screen that
 * gives an erased computer its password. Absent in a plain browser.
 */

export interface EraseStatus {
  available: boolean;
  /** Why it isn't: a live USB stick, a disk installed before Btrfs, or not DinOS. */
  reason: 'live' | 'layout' | 'unsupported' | null;
  /** Whether the disk is encrypted, so Setup asks for a new password after. */
  encrypted: boolean;
  /** Whether the computer has a password, which erasing takes. */
  password: boolean;
  /** Whether the system the next boot starts is official DinOS, which erasing needs. */
  official: boolean;
}

export interface EraseBridge {
  status(): Promise<EraseStatus>;
  /** Erase the computer. It restarts; this resolves only if it can't. */
  start(password?: string): Promise<void>;
  /** Whether the computer was erased and needs its password from Setup. */
  setupNeeded(): Promise<boolean>;
  /** Give the erased computer its password, everywhere the computer's is kept. */
  setUp(password: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    erase?: EraseBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getEraseBridge(): EraseBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.erase;
}
