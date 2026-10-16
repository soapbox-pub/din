/**
 * Typed access to the OS Bluetooth bridge exposed by the Electron preload
 * (`window.bluetooth`, see electron/preload.cjs + electron/main.mts).
 *
 * Backed by BlueZ over D-Bus in the main process. Without BlueZ or an
 * adapter `status()` resolves with `available: false`; in a plain browser the
 * bridge is absent. Callers must feature-detect and render a fallback.
 */

export interface BluetoothDevice {
  /** MAC address, e.g. "50:5E:5C:94:E5:09". */
  address: string;
  name: string;
  /** BlueZ's freedesktop icon name, e.g. "audio-headphones", or null. */
  icon: string | null;
  paired: boolean;
  connected: boolean;
  /** Battery percentage the device reports, or null. */
  battery: number | null;
}

export interface BluetoothStatus {
  /** False when BlueZ or a Bluetooth adapter isn't present. */
  available: boolean;
  powered: boolean;
  /** True while a scan for nearby devices runs. */
  discovering: boolean;
  /** Connected first, then paired, then nearby. */
  devices: BluetoothDevice[];
}

export interface BluetoothBridge {
  status(): Promise<BluetoothStatus>;
  /** Turn the adapter on or off. Resolves to the new status. */
  setPowered(powered: boolean): Promise<BluetoothStatus>;
  /** Look for nearby devices for a short while. */
  scan(): Promise<void>;
  /** Pair with, trust and connect to a nearby device. */
  pair(address: string): Promise<void>;
  /** Connect to a paired device. */
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  /** Unpair and forget a device. */
  remove(address: string): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    bluetooth?: BluetoothBridge;
  }
}

/** The Bluetooth bridge, or undefined when running outside the Electron shell. */
export function getBluetoothBridge(): BluetoothBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.bluetooth;
}

/**
 * Strip Electron's IPC error prefix and busctl's "Call failed: " so users
 * see just the underlying message.
 */
export function cleanBluetoothError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
    .replace(/^Call failed:\s*/, '');
}
