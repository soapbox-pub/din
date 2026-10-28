/**
 * Typed access to the Bluetooth bridge exposed by the Electron preload
 * (`window.dinos.bluetooth`, see electron/preload.cjs + electron/bluetooth.mts).
 *
 * Backed by BlueZ over the system bus. The main process pushes the whole
 * state whenever it changes; `available: false` where bluetoothd isn't
 * running. Absent in a plain browser; callers feature-detect via
 * `getBluetoothBridge()`.
 */

export interface BluetoothAdapter {
  /** What other devices see this computer as. */
  name: string;
  address: string;
  powered: boolean;
  discovering: boolean;
}

export type BluetoothBusy = 'pairing' | 'connecting' | 'disconnecting';

export interface BluetoothDevice {
  /** BlueZ's object path, which the actions take. */
  path: string;
  address: string;
  name: string;
  /** BlueZ's freedesktop icon name, e.g. "audio-headset", "input-keyboard". */
  icon: string | null;
  paired: boolean;
  connected: boolean;
  /** Battery level, 0-100, for devices that report one. */
  battery: number | null;
  busy: BluetoothBusy | null;
}

export type BluetoothRequestKind =
  | 'confirm'
  | 'authorize'
  | 'pin'
  | 'passkey'
  | 'display-pin'
  | 'display-passkey';

/** A pairing that needs the user. */
export interface BluetoothRequest {
  id: number;
  /** The device's path. */
  device: string;
  name: string;
  kind: BluetoothRequestKind;
  /** The code to compare (confirm) or to type on the device (display-*). */
  code: string | null;
}

export interface BluetoothState {
  available: boolean;
  adapter: BluetoothAdapter | null;
  devices: BluetoothDevice[];
  request: BluetoothRequest | null;
}

export interface BluetoothBridge {
  state(): Promise<BluetoothState>;
  setPowered(on: boolean): Promise<void>;
  /** Start or stop looking for devices; a search stops by itself after a while. */
  discover(on: boolean): Promise<void>;
  /** Pair with a device, then connect to it. */
  pair(path: string): Promise<void>;
  connect(path: string): Promise<void>;
  disconnect(path: string): Promise<void>;
  /** Remove a device and its pairing. */
  forget(path: string): Promise<void>;
  /** Stop a pairing in progress. */
  cancel(path: string): Promise<void>;
  answer(id: number, accept: boolean, value?: string): Promise<void>;
  /** Whether the shell is there to answer pairing prompts. */
  setPrompts(enabled: boolean): Promise<void>;
  onChanged(callback: (state: BluetoothState) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    bluetooth?: BluetoothBridge;
  }
}

/** The Bluetooth bridge, or undefined outside the Electron shell. */
export function getBluetoothBridge(): BluetoothBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.bluetooth;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanBluetoothBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** Paired devices first (connected ones on top), then the rest by name. */
export function sortDevices(devices: BluetoothDevice[]): BluetoothDevice[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) ||
      Number(b.paired) - Number(a.paired) ||
      a.name.localeCompare(b.name),
  );
}

/** What a device is doing, or what it is, in a few words. */
export function describeDevice(device: BluetoothDevice): string {
  if (device.busy === 'pairing') return 'Pairing…';
  if (device.busy === 'connecting') return 'Connecting…';
  if (device.busy === 'disconnecting') return 'Disconnecting…';
  const battery = device.battery !== null ? ` · ${device.battery}% battery` : '';
  if (device.connected) return `Connected${battery}`;
  if (device.paired) return `Not connected${battery}`;
  return deviceKind(device.icon);
}

/** A plain name for BlueZ's icon name. */
export function deviceKind(icon: string | null): string {
  switch (icon) {
    case 'audio-headset':
      return 'Headset';
    case 'audio-headphones':
      return 'Headphones';
    case 'audio-card':
      return 'Speaker';
    case 'input-keyboard':
      return 'Keyboard';
    case 'input-mouse':
      return 'Mouse';
    case 'input-tablet':
      return 'Tablet';
    case 'input-gaming':
      return 'Game controller';
    case 'phone':
      return 'Phone';
    case 'computer':
      return 'Computer';
    case 'video-display':
      return 'Display';
    case 'printer':
      return 'Printer';
    case 'camera-photo':
    case 'camera-video':
      return 'Camera';
    default:
      return 'Device';
  }
}
