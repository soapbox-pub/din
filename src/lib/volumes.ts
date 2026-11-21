/**
 * Typed access to the volumes bridge exposed by the Electron preload
 * (`window.dinos.volumes`, see electron/preload.cjs + electron/volumes.mts).
 *
 * Backed by UDisks2 over the system bus: removable disks are mounted as
 * they're plugged in, while fixed disks mount on request. USB phones use
 * electron/phone-usb.mts. The main process pushes state changes. The bridge
 * is absent in a plain browser; callers feature-detect via `getVolumesBridge()`.
 */

export type VolumeBusy = 'mounting' | 'unlocking' | 'ejecting';

export interface Volume {
  /** udisks' object path for the filesystem, which the actions take. */
  id: string;
  name: string;
  /** Where it's mounted, or null when it isn't. */
  mountPoint: string | null;
  /** The device node, e.g. /dev/sdb1. */
  device: string;
  sizeBytes: number;
  /** The filesystem type, e.g. vfat, exfat, ntfs, ext4; crypto_LUKS when locked. */
  fsType: string;
  /** Encrypted and not unlocked yet: unlock it with its passphrase to open it. */
  locked: boolean;
  readOnly: boolean;
  /** False for volumes that mount on request and unmount individually. */
  removable: boolean;
  /** "usb", "sdio" (an SD card), or "" when udisks doesn't say. */
  bus: string;
  busy: VolumeBusy | null;
  /** A phone plugged in by USB rather than a disk, and which kind. */
  phone?: 'android' | 'iphone';
  /** What a phone is waiting on the user for before it opens, e.g. "Unlock the iPhone and tap Trust." */
  needs?: string | null;
  /** The optional feature it's waiting on ("phones": jmtpfs and ifuse), for its Install button. */
  needsFeature?: string | null;
}

export interface VolumesState {
  /** False when udisksd isn't running. */
  available: boolean;
  volumes: Volume[];
}

export type VolumeEvent =
  | { type: 'mounted'; name: string; mountPoint: string }
  | { type: 'locked'; id: string; name: string }
  | { type: 'ejected'; name: string }
  | { type: 'pulled'; name: string }
  | { type: 'unreadable'; name: string; error: string }
  | { type: 'waiting'; id: string; name: string; needs: string; feature: string | null };

export interface VolumesBridge {
  state(): Promise<VolumesState>;
  /** Mount a volume; resolves to where. */
  mount(id: string): Promise<string>;
  /** Unlock an encrypted volume and mount what's in it; resolves to where. */
  unlock(id: string, passphrase: string): Promise<string>;
  /** Eject a removable device, or unmount just the selected volume on a fixed disk. */
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
