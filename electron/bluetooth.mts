// The Bluetooth bridge (window.dinos.bluetooth, for the menu bar and Settings →
// Bluetooth): turning the adapter on and off, finding devices nearby, and
// pairing, connecting, disconnecting and forgetting them.
//
// BlueZ is driven over the system bus with dbus.mts, on one connection kept
// for as long as Din runs: bluetoothd's ObjectManager lists the adapters and
// devices, its signals keep that list current, and the whole state is pushed
// to the shell whenever it changes (`bluetooth:changed`), so nothing polls.
// When bluetoothd restarts, the list is read again.
//
// Pairing goes through an agent this connection exports and makes the
// default one. When a device needs the user - to confirm a code shown on both
// screens, to type a PIN, or to see one to type on a keyboard - the request
// becomes part of the state, the shell asks, and the answer comes back
// through `bluetooth:answer`. The agent is only registered while the desktop
// is up to answer (`bluetooth:prompts`), so the login screen, where phone
// login uses Bluetooth too, behaves as if this bridge weren't here.
//
// Sound devices need little more: WirePlumber picks up a connected headset
// and it shows up in Settings → Sound (main.mts switches sound to it). Like a
// Mac, Din connects again by itself to the headphones last in use, when the
// desktop comes up, when Bluetooth is turned back on, and on waking, since
// many headsets wait to be called rather than calling. Headphones the user
// disconnects here, or forgets, are left alone until connected again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain, powerMonitor } from 'electron';
import { DBusConnection, DBusError, unwrap, Variant, type Message } from './dbus.mts';

const BLUEZ = 'org.bluez';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';
const AGENT_MANAGER = 'org.bluez.AgentManager1';
const AGENT = 'org.bluez.Agent1';

const AGENT_PATH = '/pub/din/bluetooth/agent';

/** Message Access Server: a phone that shares its texts (phone-map.mts). */
const MAS_UUID = '00001132-0000-1000-8000-00805f9b34fb';

const SYSTEM_BUS = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket';

/** How long a search runs unless the shell asks again. */
const DISCOVERY_MS = 2 * 60_000;
/** Pairing waits on the device, and on the user. */
const PAIR_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 45_000;
/** How long a pairing prompt waits for an answer. */
const REQUEST_TIMEOUT_MS = 60_000;
const EMIT_DELAY_MS = 100;
/** How long to try each remembered headset, which may well be switched off. */
const RECONNECT_TIMEOUT_MS = 15_000;
/** How long after waking the adapter takes to be back. */
const RESUME_DELAY_MS = 3_000;

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
  device: string;
  name: string;
  /**
   * confirm: does `code` match the device's? authorize: allow pairing at all?
   * pin / passkey: type what the device shows (or its manual says).
   * display-pin / display-passkey: type `code` on the device.
   */
  kind: BluetoothRequestKind;
  code: string | null;
}

export interface BluetoothState {
  /** False when bluetoothd isn't running (or there's no system bus). */
  available: boolean;
  /** The adapter in use, or null when there's none. */
  adapter: BluetoothAdapter | null;
  devices: BluetoothDevice[];
  request: BluetoothRequest | null;
}

type Interfaces = Map<string, Map<string, unknown>>;

let bus: DBusConnection | null = null;
let connecting: Promise<DBusConnection | null> | null = null;
let bluezOwner: string | null = null;
let unsubscribeBluez: (() => void) | null = null;
/** BlueZ's objects: path -> interface -> property -> value (unwrapped). */
const objects = new Map<string, Interfaces>();
const busy = new Map<string, BluetoothBusy>();

let promptsWanted = false;
let agentRegistered = false;

let discoveryTimer: NodeJS.Timeout | null = null;

interface PendingRequest {
  request: BluetoothRequest;
  resolve: (value: string) => void;
  reject: (error: DBusError) => void;
  timer: NodeJS.Timeout;
}
let pending: PendingRequest | null = null;
let nextRequestId = 1;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
const listeners = new Set<() => void>();
let emitTimer: NodeJS.Timeout | null = null;
let lastSent = '';

function unwrapProps(props: Map<string, unknown>): Map<string, unknown> {
  return new Map([...props].map(([key, value]) => [key, unwrap(value)]));
}

/** The first adapter, by path (hci0 before hci1). */
function adapterPath(): string | null {
  const paths = [...objects].filter(([, ifaces]) => ifaces.has(ADAPTER)).map(([path]) => path);
  return paths.sort()[0] ?? null;
}

function deviceProps(path: string): Map<string, unknown> | undefined {
  return objects.get(path)?.get(DEVICE);
}

/** A device's name to show: its alias, or what it calls itself. */
function deviceName(props: Map<string, unknown>): string {
  return String(props.get('Alias') ?? props.get('Name') ?? props.get('Address') ?? 'Unknown device');
}

function state(): BluetoothState {
  const path = adapterPath();
  const adapterProps = path ? objects.get(path)?.get(ADAPTER) : undefined;
  const adapter: BluetoothAdapter | null = adapterProps
    ? {
        name: String(adapterProps.get('Alias') ?? adapterProps.get('Name') ?? ''),
        address: String(adapterProps.get('Address') ?? ''),
        powered: adapterProps.get('Powered') === true,
        discovering: adapterProps.get('Discovering') === true,
      }
    : null;

  const devices: BluetoothDevice[] = [];
  if (path) {
    for (const [devicePath, ifaces] of objects) {
      const props = ifaces.get(DEVICE);
      if (!props || props.get('Adapter') !== path) continue;
      const paired = props.get('Paired') === true;
      const connected = props.get('Connected') === true;
      // Nameless devices nearby are mostly beacons nobody would pair with.
      if (!paired && !connected && props.get('Name') === undefined && !busy.has(devicePath)) continue;
      const battery = ifaces.get(BATTERY)?.get('Percentage');
      devices.push({
        path: devicePath,
        address: String(props.get('Address') ?? ''),
        name: deviceName(props),
        icon: typeof props.get('Icon') === 'string' ? (props.get('Icon') as string) : null,
        paired,
        connected,
        battery: typeof battery === 'number' ? battery : null,
        busy: busy.get(devicePath) ?? null,
      });
    }
  }

  return { available: bluezOwner !== null, adapter, devices, request: pending?.request ?? null };
}

/** Tell the shell, soon: a search sends a burst of changes. */
function changed(): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    for (const listener of listeners) listener();
    const current = state();
    const json = JSON.stringify(current);
    if (json === lastSent) return;
    lastSent = json;
    sendToShell('bluetooth:changed', current);
  }, EMIT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

async function connection(): Promise<DBusConnection | null> {
  if (bus) return bus;
  connecting ??= (async () => {
    const b = await DBusConnection.connect(SYSTEM_BUS);
    if (!b) return null;
    b.onClose = () => {
      if (bus !== b) return;
      bus = null;
      bluezOwner = null;
      unsubscribeBluez = null;
      agentRegistered = false;
      objects.clear();
      busy.clear();
      cancelRequest();
      changed();
    };
    exportAgent(b);
    b.subscribe({ sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' }, (message) => {
      if (message.body[0] === BLUEZ) void load(b);
    });
    bus = b;
    await load(b);
    return b;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Read BlueZ's objects afresh and follow their changes. */
async function load(b: DBusConnection): Promise<void> {
  unsubscribeBluez?.();
  unsubscribeBluez = null;
  objects.clear();
  agentRegistered = false;
  cancelRequest();

  const owner = await b
    .bus('GetNameOwner', 's', [BLUEZ])
    .then(([name]) => name as string)
    .catch(() => null);
  bluezOwner = owner;
  if (!owner) {
    changed();
    return;
  }

  const unsubscribers = [
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesAdded' }, (message: Message) => {
      const [path, ifaces] = message.body as [string, Map<string, Map<string, unknown>>];
      const entry = objects.get(path) ?? new Map();
      for (const [iface, props] of ifaces) entry.set(iface, unwrapProps(props));
      objects.set(path, entry);
      changed();
    }),
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesRemoved' }, (message: Message) => {
      const [path, ifaces] = message.body as [string, string[]];
      const entry = objects.get(path);
      if (!entry) return;
      for (const iface of ifaces) entry.delete(iface);
      if (entry.size === 0) {
        objects.delete(path);
        busy.delete(path);
      }
      changed();
    }),
    b.subscribe({ sender: owner, interface: PROPERTIES, member: 'PropertiesChanged' }, (message: Message) => {
      const [iface, values, invalidated] = message.body as [string, Map<string, unknown>, string[]];
      const props = message.path ? objects.get(message.path)?.get(iface) : undefined;
      if (!props) return;
      for (const [key, value] of values) props.set(key, unwrap(value));
      for (const key of invalidated) props.delete(key);
      // A device showing a code to type is done with it once it's paired.
      const request = pending?.request;
      if (iface === DEVICE && values.has('Paired') && request?.device === message.path && request?.kind.startsWith('display-')) {
        cancelRequest();
      }
      if (iface === DEVICE && props.get('Connected') === true && values.has('Connected') && isAudio(props)) {
        void remember(String(props.get('Address') ?? ''), true);
      }
      if (iface === ADAPTER && values.get('Powered') !== undefined && props.get('Powered') === true) void reconnectAudio();
      changed();
    }),
  ];
  unsubscribeBluez = () => unsubscribers.forEach((unsubscribe) => unsubscribe());

  try {
    const [managed] = await b.call({ destination: BLUEZ, path: '/', interface: OBJECT_MANAGER, member: 'GetManagedObjects' });
    for (const [path, ifaces] of managed as Map<string, Map<string, Map<string, unknown>>>) {
      objects.set(path, new Map([...ifaces].map(([iface, props]) => [iface, unwrapProps(props)])));
    }
  } catch (error) {
    console.error('bluetooth: reading BlueZ objects failed', error);
  }
  await syncAgent(b);
  changed();
  void reconnectAudio();
}

function call(member: string, path: string, iface: string, signature = '', body: unknown[] = [], timeout?: number) {
  if (!bus) return Promise.reject(new Error("Can't reach Bluetooth."));
  return bus.call({ destination: BLUEZ, path, interface: iface, member, signature, body, timeout });
}

function setProperty(path: string, iface: string, name: string, value: Variant) {
  return call('Set', path, PROPERTIES, 'ssv', [iface, name, value]);
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/** Register the agent while the shell can answer it, and only then. */
async function syncAgent(b: DBusConnection): Promise<void> {
  if (!bluezOwner || promptsWanted === agentRegistered) return;
  const manager = (member: string, signature: string, body: unknown[]) =>
    b.call({ destination: BLUEZ, path: '/org/bluez', interface: AGENT_MANAGER, member, signature, body });
  try {
    if (promptsWanted) {
      await manager('RegisterAgent', 'os', [AGENT_PATH, 'KeyboardDisplay']).catch((error) => {
        if (!(error instanceof DBusError && error.type === 'org.bluez.Error.AlreadyExists')) throw error;
      });
      await manager('RequestDefaultAgent', 'o', [AGENT_PATH]);
      agentRegistered = true;
    } else {
      agentRegistered = false;
      cancelRequest();
      await manager('UnregisterAgent', 'o', [AGENT_PATH]);
    }
  } catch (error) {
    console.error('bluetooth: agent registration failed', error);
  }
}

const rejected = () => new DBusError('org.bluez.Error.Rejected', 'Rejected');
const canceled = () => new DBusError('org.bluez.Error.Canceled', 'Canceled');

function cancelRequest(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.reject(canceled());
  pending = null;
  changed();
}

/** Put a request to the user; resolves to their answer. */
function ask(device: string, kind: BluetoothRequestKind, code: string | null = null): Promise<string> {
  cancelRequest();
  const props = deviceProps(device);
  const request: BluetoothRequest = {
    id: nextRequestId++,
    device,
    name: props ? deviceName(props) : 'A device',
    kind,
    code,
  };
  return new Promise((resolve, reject) => {
    const entry: PendingRequest = {
      request,
      resolve,
      reject,
      timer: setTimeout(() => {
        if (pending !== entry) return;
        pending = null;
        reject(canceled());
        changed();
      }, REQUEST_TIMEOUT_MS),
    };
    pending = entry;
    changed();
  });
}

/** Show a code for the user to type on the device; nothing to answer. */
function show(device: string, kind: 'display-pin' | 'display-passkey', code: string): void {
  void ask(device, kind, code).catch(() => {});
}

function exportAgent(b: DBusConnection): void {
  b.export(AGENT_PATH, async (agentCall) => {
    if (agentCall.interface !== AGENT) {
      throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', agentCall.member);
    }
    const [device] = agentCall.body as [string];
    switch (agentCall.member) {
      case 'Release':
        agentRegistered = false;
        return;
      case 'Cancel':
        cancelRequest();
        return;
      case 'RequestPinCode':
        return ['s', [await ask(device, 'pin')]];
      case 'RequestPasskey':
        return ['u', [Number(await ask(device, 'passkey'))]];
      case 'DisplayPinCode':
        show(device, 'display-pin', String(agentCall.body[1]));
        return;
      case 'DisplayPasskey':
        // Called again as each digit is typed; the code stays the same.
        if (pending?.request.device !== device || pending.request.kind !== 'display-passkey') {
          show(device, 'display-passkey', String(agentCall.body[1]).padStart(6, '0'));
        }
        return;
      case 'RequestConfirmation':
        await ask(device, 'confirm', String(agentCall.body[1]).padStart(6, '0'));
        return;
      case 'RequestAuthorization':
        await ask(device, 'authorize');
        return;
      case 'AuthorizeService': {
        // A device that's already paired may use what it paired for.
        const props = deviceProps(device);
        if (props?.get('Paired') === true || props?.get('Trusted') === true) return;
        throw rejected();
      }
      default:
        throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', agentCall.member);
    }
  });
}

function answer(id: unknown, accept: unknown, value: unknown): void {
  if (!pending || pending.request.id !== id) return;
  const { request, resolve, reject, timer } = pending;
  clearTimeout(timer);
  pending = null;
  changed();
  if (accept !== true) {
    reject(rejected());
    return;
  }
  if (request.kind === 'pin') {
    if (typeof value !== 'string' || !/^[\x20-\x7e]{1,16}$/.test(value)) return reject(rejected());
    resolve(value);
  } else if (request.kind === 'passkey') {
    if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return reject(rejected());
    resolve(value);
  } else {
    resolve('');
  }
}

// ---------------------------------------------------------------------------
// Reconnecting headphones
// ---------------------------------------------------------------------------

function isAudio(props: Map<string, unknown>): boolean {
  return /^audio-/.test(String(props.get('Icon') ?? ''));
}

function rememberedPath(): string {
  return path.join(app.getPath('userData'), 'bluetooth-audio.json');
}

/** Addresses of the headphones to connect again, last used first. */
async function remembered(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(rememberedPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember (or stop remembering) a headset to connect again. */
async function remember(address: string, on: boolean): Promise<void> {
  if (!address) return;
  const before = await remembered();
  const after = on ? [address, ...before.filter((a) => a !== address)].slice(0, 8) : before.filter((a) => a !== address);
  if (after.join() === before.join()) return;
  await fs.writeFile(rememberedPath(), JSON.stringify(after)).catch(() => {});
}

let reconnecting = false;

/**
 * Call the remembered headphones that aren't connected, one at a time and
 * quietly: they may be off, or away. Only once the desktop is up.
 */
async function reconnectAudio(): Promise<void> {
  const adapter = adapterPath();
  if (reconnecting || !promptsWanted || !adapter || objects.get(adapter)?.get(ADAPTER)?.get('Powered') !== true) return;
  reconnecting = true;
  try {
    for (const address of await remembered()) {
      const found = [...objects].find(([, ifaces]) => ifaces.get(DEVICE)?.get('Address') === address);
      const props = found?.[1].get(DEVICE);
      if (!found || props?.get('Paired') !== true || props.get('Connected') === true || busy.has(found[0])) continue;
      await call('Connect', found[0], DEVICE, '', [], RECONNECT_TIMEOUT_MS).catch(() => {});
    }
  } finally {
    reconnecting = false;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Friendlier words for what BlueZ says went wrong. */
function explain(error: unknown): Error {
  if (!(error instanceof DBusError)) return error instanceof Error ? error : new Error(String(error));
  const name = error.type.replace(/^org\.bluez\.Error\./, '');
  const message = error.message;
  const text =
    name === 'AuthenticationCanceled' || name === 'Canceled'
      ? 'Pairing was canceled.'
      : name === 'AuthenticationRejected' || name === 'Rejected'
        ? 'Pairing was turned down.'
        : name === 'AuthenticationFailed'
          ? 'Pairing failed. Put the device in pairing mode and try again.'
          : name === 'AuthenticationTimeout' || name === 'ConnectionAttemptFailed' || /timed? ?out|page-timeout/i.test(message)
            ? "The device didn't answer. Make sure it's on and nearby."
            : name === 'NotReady'
              ? 'Bluetooth is off.'
              : name === 'InProgress'
                ? 'Already in progress.'
                : /profile-unavailable/.test(message)
                  ? 'This device has nothing this computer can connect to.'
                  : `Bluetooth said: ${message}`;
  return new Error(text, { cause: error });
}

function requireAdapter(): string {
  const path = adapterPath();
  if (!path) throw new Error('This computer has no Bluetooth adapter.');
  return path;
}

function requireDevice(path: unknown): string {
  if (typeof path !== 'string' || !deviceProps(path)) throw new Error('No such device.');
  return path;
}

/** Run an action on a device, showing it as busy meanwhile. */
async function withBusy<T>(path: string, what: BluetoothBusy, task: () => Promise<T>): Promise<T> {
  if (busy.has(path)) throw new Error('Already in progress.');
  busy.set(path, what);
  changed();
  try {
    return await task();
  } catch (error) {
    throw explain(error);
  } finally {
    busy.delete(path);
    changed();
  }
}

/**
 * Lift a soft rfkill block on Bluetooth: `din` may write /dev/rfkill (it's
 * the seat's user), and BlueZ won't power a blocked adapter.
 */
async function unblockRfkill(): Promise<void> {
  // struct rfkill_event { u32 idx; u8 type; u8 op; u8 soft; u8 hard; }:
  // RFKILL_TYPE_BLUETOOTH (2), RFKILL_OP_CHANGE_ALL (3), unblocked.
  await fs.writeFile('/dev/rfkill', Buffer.from([0, 0, 0, 0, 2, 3, 0, 0]));
}

async function setPowered(on: boolean): Promise<void> {
  const adapter = requireAdapter();
  try {
    await setProperty(adapter, ADAPTER, 'Powered', new Variant('b', on));
  } catch (error) {
    if (!(on && error instanceof DBusError && /Blocked|rfkill/i.test(error.type + error.message))) throw explain(error);
    await unblockRfkill().catch(() => {
      throw new Error('Bluetooth is turned off by a switch on this computer.');
    });
    // The adapter takes a moment to come back once unblocked.
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        await setProperty(requireAdapter(), ADAPTER, 'Powered', new Variant('b', true));
        return;
      } catch (retryError) {
        if (attempt >= 9) throw explain(retryError);
      }
    }
  }
}

/** Accept pairings while the user is pairing something, or might. */
function setPairable(on: boolean): void {
  const adapter = adapterPath();
  if (adapter) void setProperty(adapter, ADAPTER, 'Pairable', new Variant('b', on)).catch(() => {});
}

async function discover(on: boolean): Promise<void> {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  const adapter = adapterPath();
  if (!adapter) return;
  const discovering = objects.get(adapter)?.get(ADAPTER)?.get('Discovering') === true;
  if (on) {
    discoveryTimer = setTimeout(() => void discover(false), DISCOVERY_MS);
    setPairable(true);
    if (!discovering) {
      await call('StartDiscovery', adapter, ADAPTER).catch((error) => {
        if (!(error instanceof DBusError && error.type === 'org.bluez.Error.InProgress')) throw explain(error);
      });
    }
  } else {
    if (![...busy.values()].includes('pairing')) setPairable(false);
    // Only stops a search this connection started.
    await call('StopDiscovery', adapter, ADAPTER).catch(() => {});
  }
}

async function pair(path: string): Promise<void> {
  await withBusy(path, 'pairing', async () => {
    setPairable(true);
    if (deviceProps(path)?.get('Paired') !== true) {
      try {
        await call('Pair', path, DEVICE, '', [], PAIR_TIMEOUT_MS);
      } catch (error) {
        if (!(error instanceof DBusError && error.type === 'org.bluez.Error.AlreadyExists')) throw error;
      } finally {
        if (pending?.request.device === path) cancelRequest();
      }
    }
    // Trusted devices may reconnect by themselves (a headset turned on).
    await setProperty(path, DEVICE, 'Trusted', new Variant('b', true)).catch(() => {});
  });
  if (deviceProps(path)?.get('Connected') !== true) await connect(path);
}

async function connect(path: string): Promise<void> {
  try {
    await withBusy(path, 'connecting', () => call('Connect', path, DEVICE, '', [], CONNECT_TIMEOUT_MS));
  } catch (error) {
    // The device no longer has this computer's key (it was reset, or paired
    // with too many others and dropped it), so the pairing here is dead and
    // no retry will work. Forget it and look for the device to pair afresh.
    if (!(error instanceof Error && error.cause instanceof DBusError && /key-missing/.test(error.cause.message))) throw error;
    const name = deviceProps(path)?.get('Alias') ?? deviceProps(path)?.get('Name');
    await forget(path).catch(() => {});
    await discover(true).catch(() => {});
    throw new Error(
      `${typeof name === 'string' ? name : 'This device'} has forgotten this computer. Put it in pairing mode to pair it again.`,
      { cause: error },
    );
  }
}

async function disconnect(path: string): Promise<void> {
  // Disconnected on purpose: not to be called back.
  await remember(String(deviceProps(path)?.get('Address') ?? ''), false);
  await withBusy(path, 'disconnecting', () => call('Disconnect', path, DEVICE, '', [], CONNECT_TIMEOUT_MS));
}

async function forget(path: string): Promise<void> {
  const adapter = deviceProps(path)?.get('Adapter');
  if (typeof adapter !== 'string') throw new Error('No such device.');
  await remember(String(deviceProps(path)?.get('Address') ?? ''), false);
  await call('RemoveDevice', adapter, ADAPTER, 'o', [path]).catch((error) => {
    throw explain(error);
  });
}

async function cancelPairing(path: string): Promise<void> {
  if (pending?.request.device === path) cancelRequest();
  if (busy.get(path) === 'pairing') await call('CancelPairing', path, DEVICE).catch(() => {});
}

// ---------------------------------------------------------------------------
// Phones, for Messages (phone.mts)
// ---------------------------------------------------------------------------

export interface BluetoothPhone {
  address: string;
  name: string;
  connected: boolean;
}

/**
 * Paired phones that may share their texts: those offering a Message Access
 * Server, or calling themselves a phone (an iPhone lists its services only
 * once it's connected). Null when Bluetooth can't be reached.
 */
export async function bluetoothPhones(): Promise<BluetoothPhone[] | null> {
  if (!(await connection()) || !bluezOwner) return null;
  const phones: BluetoothPhone[] = [];
  for (const [, ifaces] of objects) {
    const props = ifaces.get(DEVICE);
    if (!props || props.get('Paired') !== true) continue;
    const uuids = props.get('UUIDs');
    const mas = Array.isArray(uuids) && uuids.includes(MAS_UUID);
    if (!mas && props.get('Icon') !== 'phone') continue;
    phones.push({ address: String(props.get('Address') ?? ''), name: deviceName(props), connected: props.get('Connected') === true });
  }
  return phones;
}

/** Hear when anything about Bluetooth's devices changes. */
export function onBluetoothChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerBluetoothHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;

  /** An action that needs bluetoothd, once it's been reached. */
  const handle = (channel: string, action: (...args: unknown[]) => Promise<void> | void) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertShellSender(event);
      if (!(await connection()) || !bluezOwner) throw new Error("Can't reach Bluetooth.");
      await action(...args);
    });
  };

  ipcMain.handle('bluetooth:state', async (event) => {
    assertShellSender(event);
    await connection();
    lastSent = '';
    return state();
  });

  ipcMain.handle('bluetooth:prompts', async (event, enabled: unknown) => {
    assertShellSender(event);
    promptsWanted = enabled === true;
    const b = await connection();
    if (b) await syncAgent(b);
    void reconnectAudio();
  });

  powerMonitor.on('resume', () => setTimeout(() => void reconnectAudio(), RESUME_DELAY_MS));

  handle('bluetooth:setPowered', (on) => setPowered(on === true));
  handle('bluetooth:discover', (on) => discover(on === true));
  handle('bluetooth:pair', (path) => pair(requireDevice(path)));
  handle('bluetooth:connect', (path) => connect(requireDevice(path)));
  handle('bluetooth:disconnect', (path) => disconnect(requireDevice(path)));
  handle('bluetooth:forget', (path) => forget(requireDevice(path)));
  handle('bluetooth:cancel', (path) => cancelPairing(requireDevice(path)));
  handle('bluetooth:answer', (id, accept, value) => answer(id, accept, value));
}
