/**
 * Typed access to the volumes bridge exposed by the Electron preload
 * (`window.dinos.volumes`, see electron/preload.cjs + electron/volumes.mts).
 *
 * Backed by UDisks2 over the system bus: removable disks are mounted as
 * they're plugged in, and the main process pushes the whole state whenever
 * it changes. Absent in a plain browser; callers feature-detect via
 * `getVolumesBridge()`.
 */

export type VolumeBusy = 'mounting' | 'ejecting';

export interface Volume {
  /** udisks' object path for the filesystem, which the actions take. */
  id: string;
  name: string;
  /** Where it's mounted, or null when it isn't. */
  mountPoint: string | null;
  /** The device node, e.g. /dev/sdb1. */
  device: string;
  sizeBytes: number;
  /** The filesystem type, e.g. vfat, exfat, ntfs, ext4. */
  fsType: string;
  readOnly: boolean;
  /** "usb", "sdio" (an SD card), or "" when udisks doesn't say. */
  bus: string;
  busy: VolumeBusy | null;
}

export interface VolumesState {
  /** False when udisksd isn't running. */
  available: boolean;
  volumes: Volume[];
}

export type VolumeEvent =
  | { type: 'mounted'; name: string; mountPoint: string }
  | { type: 'ejected'; name: string }
  | { type: 'pulled'; name: string }
  | { type: 'unreadable'; name: string; error: string };

export interface VolumesBridge {
  state(): Promise<VolumesState>;
  /** Mount a volume; resolves to where. */
  mount(id: string): Promise<string>;
  /** Unmount everything on a volume's disk and power it off. */
  eject(id: string): Promise<void>;
  onChanged(callback: (state: VolumesState) => void): () => void;
  onEvent(callback: (event: VolumeEvent) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    volumes?: VolumesBridge;
  }
}

/** The volumes bridge, or undefined outside the Electron shell. */
export function getVolumesBridge(): VolumesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  // An app granted it has it through window.din; the desktop, through window.dinos.
  return window.din?.system.volumes ?? window.dinos?.volumes;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanVolumesError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
