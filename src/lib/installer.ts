/**
 * Typed access to the installer bridge exposed by the Electron preload
 * (`window.installer`, see electron/preload.cjs + electron/installer.mts).
 *
 * DinOS written to a USB stick boots as a live system; the Installer app
 * copies it onto the computer's own disk. The bridge is absent outside the
 * Electron shell and reports `available: false` off DinOS, and the app is
 * only offered when `live` is true.
 */

export interface InstallerPartition {
  path: string;
  label: string;
  fsType: string;
  sizeBytes: number;
}

export interface InstallerDisk {
  /** Device node, e.g. "/dev/nvme0n1". */
  path: string;
  /** Vendor and model, possibly empty. */
  model: string;
  sizeBytes: number;
  /** "nvme", "sata", "usb", ... or empty. */
  transport: string;
  removable: boolean;
  /** "gpt", "dos", or null for a blank disk. */
  partitionTable: string | null;
  /** The largest stretch of unpartitioned space (GPT disks only). */
  largestFreeBytes: number;
  /** A partition on it is mounted; it can't be installed on. */
  inUse: boolean;
  /** It holds another Linux system, which rules out installing alongside. */
  hasLinuxRoot: boolean;
  partitions: InstallerPartition[];
}

export type InstallerStatus =
  | { available: false }
  | {
      available: true;
      /** Running from a USB stick or other removable media. */
      live: boolean;
      bootDisk: string;
      /** Space an install needs, including room to use it. */
      requiredBytes: number;
      disks: InstallerDisk[];
    };

export type InstallMode = 'wipe' | 'free';

export type InstallStep = 'partition' | 'format' | 'copy' | 'boot';

export interface InstallState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  disk: string | null;
  mode: InstallMode | null;
  step: InstallStep | null;
  /** Percent of the copy step. */
  percent: number;
  error: string | null;
}

export interface InstallerBridge {
  status(): Promise<InstallerStatus>;
  state(): Promise<InstallState>;
  install(disk: string, mode: InstallMode): Promise<void>;
  reboot(): Promise<void>;
  onProgress(callback: (state: InstallState) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    installer?: InstallerBridge;
  }
}

/** The installer bridge, or undefined outside the Electron shell. */
export function getInstallerBridge(): InstallerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.installer;
}

/** Strip Electron's IPC wrapper from an error message. */
export function cleanInstallerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Disk sizes the way drives are sold: decimal GB/TB. */
export function formatDiskSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(bytes >= 1e13 ? 0 : 1)} TB`;
  if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
