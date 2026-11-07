/**
 * Typed access to the Drive bridge exposed by the Electron preload
 * (`window.dinos.drive`, see electron/preload.cjs + electron/drive.mts):
 * Din Drive, the encrypted drive on Nostr and Blossom that din-drive mounts
 * at ~/Drive. Absent in a plain browser; callers feature-detect via
 * `getDriveBridge()`.
 */

export interface DriveStatus {
  pubkey: string;
  drive_id: string;
  /** Where it's mounted. */
  mountpoint: string;
  relays: string[];
  servers: string[];
  connected_relays: number;
  /** Files and folders, including trashed ones. */
  items: number;
  /** Files saved here that aren't uploaded yet. */
  pending_uploads: number;
  /** Changes not yet published to the relays. */
  pending_publish: number;
  trash: number;
  /** When it last fetched changes, in unix seconds. */
  last_sync: number | null;
  last_error: string | null;
}

export interface DriveTrashItem {
  id: string;
  name: string;
  dir: boolean;
  size: number;
  /** When it was trashed, in unix seconds. */
  trashed: number;
}

export interface DriveState {
  /** din-drive is on this computer. */
  available: boolean;
  /** The drive is mounted, and this is what it says; null when it isn't running. */
  status: DriveStatus | null;
}

/** What an app granted the `drive` permission has (`din.system.drive`): seeing whether it's on, and turning it on. */
export interface DriveSetupBridge {
  state(): Promise<DriveState>;
  setUp(): Promise<DriveStatus>;
}

export interface DriveBridge extends DriveSetupBridge {
  trash(): Promise<DriveTrashItem[]>;
  restore(id: string): Promise<void>;
  emptyTrash(): Promise<number>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    drive?: DriveBridge;
  }
}

/** The Drive bridge, or undefined outside the Electron shell. */
export function getDriveBridge(): DriveBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.drive;
}

/** Checking on and turning on Drive, from the desktop or an app granted `drive` (Files). */
export function getDriveSetupBridge(): DriveSetupBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.din?.system.drive ?? window.dinos?.drive;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanDriveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** What the drive is doing, in a few words. */
export function describeDrive(status: DriveStatus): string {
  if (status.last_error) return 'Having trouble syncing';
  if (status.connected_relays === 0) return 'Offline: changes sync when you’re back online';
  const pending = status.pending_uploads + status.pending_publish;
  if (pending > 0) return `Syncing ${pending} ${pending === 1 ? 'change' : 'changes'}`;
  return 'Up to date';
}
