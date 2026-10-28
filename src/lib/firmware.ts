/**
 * Typed access to the firmware bridge exposed by the Electron preload
 * (`window.dinos.firmware`, see electron/preload.cjs + electron/firmware.mts).
 *
 * DinOS looks for firmware updates through fwupd, and Settings lists them
 * and installs the ones the user picks. The bridge is absent outside the
 * Electron shell and reports `available: false` off DinOS.
 */

export interface FirmwareUpdate {
  deviceId: string;
  /** The device, e.g. "System Firmware" or "UEFI dbx". */
  name: string;
  vendor: string | null;
  /** The version the device has. */
  current: string | null;
  /** The newest release's. */
  version: string;
  summary: string | null;
  /** The release notes, as plain text. */
  description: string | null;
  /** Applied by the next restart rather than right away. */
  needsRestart: boolean;
}

export interface FirmwareState {
  available: boolean;
  phase: 'idle' | 'checking' | 'installing' | 'failed';
  updates: FirmwareUpdate[];
  /** The device being updated. */
  installing: string | null;
  /** Devices whose new firmware the next restart applies. */
  pendingRestart: string[];
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
}

export interface FirmwareBridge {
  state(): Promise<FirmwareState>;
  /** Get LVFS's newest releases and look for updates. */
  check(): Promise<void>;
  /** Install the newest firmware for a device. */
  install(deviceId: string): Promise<void>;
  reboot(): Promise<void>;
  onProgress(callback: (state: FirmwareState) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    firmware?: FirmwareBridge;
  }
}

/** The firmware bridge, or undefined outside the Electron shell. */
export function getFirmwareBridge(): FirmwareBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.firmware;
}
