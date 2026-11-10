/**
 * Typed access to the system packages bridge (`window.dinos.packages`, see
 * electron/preload.cjs + electron/system-packages.mts): installing what one
 * of Din's features needs from the host system's package manager, for the
 * button beside the message saying it's missing. Absent outside the
 * Electron shell.
 */

/**
 * A feature whose programs come from the system's packages
 * (electron/system-packages.mts's CATALOG): Xvfb for Linux apps, and the
 * rest Settings → Optional Features lists off DinOS.
 */
export type PackageFeature = 'xvfb' | 'windows' | 'vms' | 'containers' | 'webkit' | 'screen-recording' | 'archives' | 'phones' | 'printing';

export interface PackageStatus {
  installed: boolean;
  /** The command that installs it, to show; null where Din can't install it here. */
  command: string | null;
}

export interface SystemPackagesBridge {
  status(feature: PackageFeature): Promise<PackageStatus>;
  /** Install it, asking for the administrator password in Din. */
  install(feature: PackageFeature): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    packages?: SystemPackagesBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getSystemPackagesBridge(): SystemPackagesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.packages;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanPackageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
