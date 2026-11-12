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

/** What a device is, where Din can tell more than BlueZ's icon says. */
export type BluetoothDeviceKind = 'iphone' | 'android' | 'trezor';

export interface BluetoothDevice {
  /** BlueZ's object path, which the actions take. */
  path: string;
  address: string;
  name: string;
  /** BlueZ's freedesktop icon name, e.g. "audio-headset", "input-keyboard". */
  icon: string | null;
  kind: BluetoothDeviceKind | null;
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

/** A device in a list of ones nearby, which stays put once it's there. */
export interface NearbyDevice extends BluetoothDevice {
  /** BlueZ has stopped hearing from it (it forgets one in about 30 s). */
  gone: boolean;
}

/**
 * The devices nearby to pair with, in a list that holds still while it's
 * looked at, as Android's Pair new device does: the ones already listed keep
 * their places, updated where they are (a name arriving doesn't re-sort
 * them); new ones join at the bottom (a batch of them by name); and one
 * BlueZ forgets stays, as `gone`, until it's back or the list closes. Only
 * pairing one takes it off (it moves up to the paired ones). Otherwise a
 * device found, or one going quiet, moves the rows under the pointer as
 * it's about to click one. `devices` is all of them, paired too.
 */
export function holdNearby(previous: readonly NearbyDevice[], devices: readonly BluetoothDevice[]): NearbyDevice[] {
  const byPath = new Map(devices.map((d) => [d.path, d]));
  const held: NearbyDevice[] = [];
  for (const old of previous) {
    const now = byPath.get(old.path);
    if (!now) held.push(old.gone ? old : { ...old, gone: true, busy: null });
    else if (!now.paired) held.push({ ...now, gone: false });
  }
  const listed = new Set(previous.map((d) => d.path));
  const found = devices
    .filter((d) => !d.paired && !listed.has(d.path))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ ...d, gone: false }));
  return [...held, ...found];
}

/** What a device is doing, or what it is, in a few words. */
export function describeDevice(device: BluetoothDevice): string {
  if (device.busy === 'pairing') return 'Pairing…';
  if (device.busy === 'connecting') return 'Connecting…';
  if (device.busy === 'disconnecting') return 'Disconnecting…';
  const battery = device.battery !== null ? ` · ${device.battery}% battery` : '';
  if (device.connected) return `Connected${battery}`;
  if (device.paired) return `Not connected${battery}`;
  return deviceKind(device);
}

/** A plain name for what a device is. */
export function deviceKind({ icon, kind }: Pick<BluetoothDevice, 'icon' | 'kind'>): string {
  if (kind === 'iphone') return 'iPhone';
  if (kind === 'android') return 'Android phone';
  if (kind === 'trezor') return 'Trezor';
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
    case 'multimedia-player':
      return 'Media player';
    case 'scanner':
      return 'Scanner';
    case 'modem':
      return 'Modem';
    case 'network-wireless':
      return 'Network access point';
    default:
      return 'Device';
  }
}
