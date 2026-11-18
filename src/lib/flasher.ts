/**
 * USB Flasher (din.system.flasher, for the USB Flasher app in
 * src/apps/usb-flasher/, and window.dinos.flasher for `din flasher`):
 * writing a disk image (an ISO, a .img, compressed or not) to a USB drive or
 * memory card, or DinOS, built from the commit this computer runs. Backed by
 * electron/usb-flasher.mts, which keeps the one job there is, so it goes on
 * with the app closed.
 */

/** A drive an image can be written to: a whole USB drive or memory card. */
export interface FlashDrive {
  /** The whole disk's device node, e.g. /dev/sdb. */
  path: string;
  /** Its vendor and model, or what it is ("USB drive", "Memory card"). */
  name: string;
  sizeBytes: number;
  /** "usb", "mmc" (a memory card), or "" when the kernel doesn't say. */
  transport: string;
  /** The labels of what's on it now, to tell drives apart. */
  labels: string[];
  /** Something on it is open in Files: it's unmounted before it's written. */
  mounted: boolean;
  mountPoints: string[];
}

export type FlashCompression = 'xz' | 'gzip' | 'zstd' | 'bzip2';

/** What's in an image file. */
export interface FlashImageInfo {
  path: string;
  name: string;
  fileBytes: number;
  compression: FlashCompression | null;
  /** What gets written: the file's size, or what it decompresses to where that's known. */
  imageBytes: number | null;
  /** An ISO 9660 disc image. */
  iso: boolean;
  /** A disc image with no partition table, which most computers won't start from a USB drive. */
  notBootableFromUsb: boolean;
}

/** Whether DinOS can be made here, from the commit running. */
export interface FlashDinosStatus {
  available: boolean;
  /** Why not, said to the user as it is. */
  reason: string | null;
  /** The release (os/version) and commit running, which the drive will have. */
  version: string | null;
  commit: string | null;
  /** How big its image is. */
  imageBytes: number;
}

export type FlashSource = { kind: 'file'; path: string } | { kind: 'dinos' };

export type FlashPhase =
  | 'idle'
  /** Fetching DinOS's source and building its image. */
  | 'building'
  /** Unmounting the drive, and asking for the password where it's asked for. */
  | 'preparing'
  | 'writing'
  /** Reading it back to check every byte. */
  | 'verifying'
  /** Powering the drive off. */
  | 'ejecting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface FlashState {
  phase: FlashPhase;
  /** What's written: the file's name, or "DinOS 0.2.0". */
  sourceName: string | null;
  sourceKind: FlashSource['kind'] | null;
  drive: { path: string; name: string; sizeBytes: number } | null;
  /** How far the phase has got, 0 to 1, or null while there's no telling. */
  progress: number | null;
  /** Bytes written, or checked, so far. */
  bytes: number;
  /** Of how many, where that's known. */
  totalBytes: number | null;
  /** Bytes a second, while writing or checking. */
  rate: number | null;
  /** What the DinOS build is doing, in its own words. */
  detail: string | null;
  error: string | null;
  /** The phase it was in when it failed. */
  failedAt: FlashPhase | null;
  /** Whether the drive was powered off once it was done, so it can be unplugged. */
  ejected: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface FlasherStatus {
  /** Whether drives can be written here at all. */
  available: boolean;
  reason: string | null;
  /** Writing asks for the administrator password (everywhere but DinOS). */
  asksPassword: boolean;
  dinos: FlashDinosStatus;
  drives: FlashDrive[];
  state: FlashState;
}

/** What `onChanged` hears: the drives plugged in, and the job. */
export interface FlasherChange {
  drives: FlashDrive[];
  state: FlashState;
}

export interface FlasherBridge {
  status(): Promise<FlasherStatus>;
  /** Look at an image file before writing it: its size, compression, and whether it's a disc's. */
  inspect(path: string): Promise<FlashImageInfo>;
  /**
   * Erase a drive and write an image to it, then read it back to check it and
   * power the drive off. Resolves once it's started; how it goes is pushed.
   */
  flash(source: FlashSource, drive: string): Promise<void>;
  /** Stop writing (or building), leaving the drive unusable until it's written again. */
  cancel(): Promise<void>;
  /** Done with a finished job: back to idle. */
  reset(): Promise<void>;
  onChanged(callback: (change: FlasherChange) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    flasher?: FlasherBridge;
  }
}

/** The desktop's flasher bridge, for `din flasher`. */
export function getFlasherBridge(): FlasherBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.flasher;
}

/** Sizes as a drive's box prints them: 16 GB, not 14.9 GiB. */
export function formatDriveSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Why an image can't go on a drive, or null if it can. */
export function driveProblem(drive: FlashDrive, imageBytes: number | null, imagePath?: string): string | null {
  if (imageBytes !== null && imageBytes > drive.sizeBytes) return `Too small: needs ${formatDriveSize(imageBytes)}`;
  if (imagePath && drive.mountPoints.some((m) => imagePath === m || imagePath.startsWith(`${m}/`))) {
    return 'The image is on this drive';
  }
  return null;
}

/** What a phase is called, as it goes. */
export const PHASE_LABELS: Record<FlashPhase, string> = {
  idle: 'Ready',
  building: 'Making DinOS',
  preparing: 'Getting the drive ready',
  writing: 'Writing',
  verifying: 'Checking',
  ejecting: 'Ejecting',
  done: 'Done',
  failed: 'Didn’t finish',
  cancelled: 'Stopped',
};

/** Whether a job is still going. */
export function flashRunning(state: FlashState): boolean {
  return state.phase === 'building' || state.phase === 'preparing' || state.phase === 'writing' || state.phase === 'verifying' || state.phase === 'ejecting';
}

/** About how long until the phase is done, in words, or null. */
export function timeLeft(state: FlashState): string | null {
  if (!state.rate || state.rate <= 0 || state.progress === null || state.progress <= 0.01) return null;
  const total = state.totalBytes ?? null;
  if (total === null) return null;
  const seconds = Math.max(0, (total - state.bytes) / state.rate);
  if (seconds < 60) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'About a minute left' : `About ${minutes} minutes left`;
}

/** An error as the user should read it: without Electron's IPC prefix. */
export function cleanFlasherError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
