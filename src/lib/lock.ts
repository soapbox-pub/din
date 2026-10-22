/**
 * Typed access to DinOS's lock screen (`window.lock`, see
 * electron/preload.cjs + electron/lock.mts). Absent in a plain browser.
 */

export interface LockBridge {
  available(): Promise<boolean>;
  lock(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
}

declare global {
  interface Window {
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
  return window.lock;
}
