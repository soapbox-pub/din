/**
 * Typed access to DinOS's lock screen (`window.dinos.lock`, see
 * electron/preload.cjs + electron/lock.mts). Absent in a plain browser.
 */

export interface LockBridge {
  available(): Promise<boolean>;
  lock(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  /** Whether sudo asks for the password. */
  sudoAsks(): Promise<boolean>;
  /** Make sudo ask for the password, or stop it asking, which takes the password. */
  setSudoAsks(ask: boolean, password?: string): Promise<void>;
}

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
