// Log in with a phone (window.dinos.bluetoothLogin, for the login screen).
//
// Typing an nsec on a computer that just booted is the worst part of a first
// login. This lets a phone that already holds the key (Tenna, on Android)
// hand it over across the room instead: Din advertises a Bluetooth LE GATT
// service, the phone connects to it, and the two agree on a key and a
// six-digit code. The user checks that the code on the phone matches the one
// on screen, approves on the phone, and the phone sends the account key
// encrypted to Din.
//
// Bluetooth's own pairing isn't used: "Just Works" pairing, the only kind a
// computer and a phone can do without one of them typing a PIN, is no
// defense against someone in radio range sitting between the two. So the
// link is plain and the protocol carries its own protection, the way BLE
// Secure Connections numeric comparison does:
//
//   1. Din's characteristic `session` reads as D || name, where D is an
//      ephemeral x-only secp256k1 key the renderer made for this login.
//   2. The phone writes `hello`: P || SHA-256(Np), its own ephemeral key
//      and a commitment to a 32-byte nonce it hasn't revealed yet.
//   3. The phone reads `nonce`: Nd, Din's nonce, made only now.
//   4. The phone writes `reveal`: Np, which has to match the commitment.
//   5. Both sides show SHA-256("din-login-v1" || D || P || Nd || Np) as a
//      six-digit number. Someone in the middle would have to choose their
//      keys before seeing both nonces, so their two codes match by chance
//      (one in a million), not by choice.
//   6. On approval, the phone writes `key`: a two-byte length and a NIP-44
//      payload, under the conversation key of D and P, of the hex secret key.
//
// This side only moves bytes and checks the commitment. The renderer holds
// D's secret, decrypts the payload, and logs in, so the account key is never
// in this process.
//
// BlueZ is driven over the system bus with dbus.mts: the service and the
// advertisement are objects this connection exports, which bluetoothd reads
// back through ObjectManager and Properties. Nothing is advertised until the
// login screen asks, and it stops when a key arrives, the user cancels, or
// SESSION_MS passes.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import os from 'node:os';
import { ipcMain } from 'electron';
import { DBusConnection, DBusError, unwrap, Variant, type MethodCall, type Message } from './dbus.mts';

/** The service, and its characteristics. Tenna's NearbyLogin.java has the same ones. */
const SERVICE_UUID = '52687ca1-3eb0-4325-a3dc-cd3738f77499';
const SESSION_UUID = '52687ca2-3eb0-4325-a3dc-cd3738f77499';
const HELLO_UUID = '52687ca3-3eb0-4325-a3dc-cd3738f77499';
const NONCE_UUID = '52687ca4-3eb0-4325-a3dc-cd3738f77499';
const REVEAL_UUID = '52687ca5-3eb0-4325-a3dc-cd3738f77499';
const KEY_UUID = '52687ca6-3eb0-4325-a3dc-cd3738f77499';

const CODE_CONTEXT = Buffer.from('din-login-v1', 'utf8');

/** How long the computer advertises before giving up. */
const SESSION_MS = 5 * 60_000;

/** The most a `key` write may assemble: a NIP-44 payload of a hex key is ~130 bytes. */
const MAX_KEY_BYTES = 512;

const BLUEZ = 'org.bluez';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
const GATT_MANAGER = 'org.bluez.GattManager1';
const ADVERTISING_MANAGER = 'org.bluez.LEAdvertisingManager1';
const GATT_SERVICE = 'org.bluez.GattService1';
const GATT_CHARACTERISTIC = 'org.bluez.GattCharacteristic1';
const ADVERTISEMENT = 'org.bluez.LEAdvertisement1';

const APP_PATH = '/pub/din/login';
const SERVICE_PATH = `${APP_PATH}/service0`;
const ADVERT_PATH = `${APP_PATH}/advert0`;

type Chrc = 'session' | 'hello' | 'nonce' | 'reveal' | 'key';

const CHARACTERISTICS: { name: Chrc; uuid: string; flags: string[] }[] = [
  { name: 'session', uuid: SESSION_UUID, flags: ['read'] },
  { name: 'hello', uuid: HELLO_UUID, flags: ['write'] },
  { name: 'nonce', uuid: NONCE_UUID, flags: ['read'] },
  { name: 'reveal', uuid: REVEAL_UUID, flags: ['write'] },
  { name: 'key', uuid: KEY_UUID, flags: ['write'] },
];

const chrcPath = (index: number) => `${SERVICE_PATH}/char${index}`;

/** What the renderer hears about, as `bluetooth-login:event`. */
type LoginEvent =
  | { type: 'waiting' }
  | { type: 'connected' }
  | { type: 'code'; code: string }
  | { type: 'key'; phone: string; payload: string }
  | { type: 'ended'; reason: 'timeout' | 'error'; message?: string };

/** One phone's run through the handshake. */
interface Attempt {
  device: string;
  phone: Buffer;
  commitment: Buffer;
  dinNonce: Buffer;
  phoneNonce: Buffer | null;
  key: Buffer;
}

interface Session {
  bus: DBusConnection;
  adapter: string;
  /** D || name: what `session` reads as. */
  intro: Buffer;
  din: Buffer;
  attempt: Attempt | null;
  timer: NodeJS.Timeout;
  unsubscribe: () => void;
}

let session: Session | null = null;

const SYSTEM_BUS = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket';

const bluezError = (name: string, message: string) => new DBusError(`org.bluez.Error.${name}`, message);

/** The six digits both sides show. */
export function comparisonCode(din: Buffer, phone: Buffer, dinNonce: Buffer, phoneNonce: Buffer): string {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.concat([CODE_CONTEXT, din, phone, dinNonce, phoneNonce]))
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** The first adapter that can host a GATT service and advertise it, and its state. */
async function findAdapter(bus: DBusConnection): Promise<{ path: string; powered: boolean } | null> {
  const [objects] = await bus.call({
    destination: BLUEZ,
    path: '/',
    interface: OBJECT_MANAGER,
    member: 'GetManagedObjects',
  });
  for (const [path, interfaces] of objects as Map<string, Map<string, Map<string, unknown>>>) {
    if (!interfaces.has(GATT_MANAGER) || !interfaces.has(ADVERTISING_MANAGER)) continue;
    return { path, powered: unwrap(interfaces.get(ADAPTER)?.get('Powered')) === true };
  }
  return null;
}

/** Whether this computer has a Bluetooth adapter Din can log in through. */
async function available(): Promise<boolean> {
  const bus = await DBusConnection.connect(SYSTEM_BUS);
  if (!bus) return false;
  try {
    return (await findAdapter(bus)) !== null;
  } catch {
    // No bluetoothd on the bus.
    return false;
  } finally {
    bus.close();
  }
}

function properties(iface: string, values: Record<string, Variant>) {
  return (call: MethodCall) => {
    if (call.interface === PROPERTIES && call.member === 'GetAll') {
      return ['a{sv}', [call.body[0] === iface ? values : {}]] as [string, unknown[]];
    }
    if (call.interface === PROPERTIES && call.member === 'Get') {
      const value = call.body[0] === iface ? values[call.body[1] as string] : undefined;
      if (!value) throw new DBusError('org.freedesktop.DBus.Error.InvalidArgs', 'No such property');
      return ['v', [value]] as [string, unknown[]];
    }
    return null;
  };
}

/** Export the GATT application and the advertisement on `bus`. */
function exportObjects(bus: DBusConnection, emit: (event: LoginEvent) => void): void {
  const serviceProps = {
    UUID: new Variant('s', SERVICE_UUID),
    Primary: new Variant('b', true),
  };
  const chrcProps = CHARACTERISTICS.map(({ uuid, flags }) => ({
    UUID: new Variant('s', uuid),
    Service: new Variant('o', SERVICE_PATH),
    Flags: new Variant('as', flags),
  }));
  const advertProps = {
    Type: new Variant('s', 'peripheral'),
    ServiceUUIDs: new Variant('as', [SERVICE_UUID]),
  };

  bus.export(APP_PATH, (call) => {
    if (call.interface === OBJECT_MANAGER && call.member === 'GetManagedObjects') {
      const objects = new Map<string, Map<string, Record<string, Variant>>>();
      objects.set(SERVICE_PATH, new Map([[GATT_SERVICE, serviceProps]]));
      chrcProps.forEach((props, i) => objects.set(chrcPath(i), new Map([[GATT_CHARACTERISTIC, props]])));
      return ['a{oa{sa{sv}}}', [objects]];
    }
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', call.member);
  });

  const serviceProperties = properties(GATT_SERVICE, serviceProps);
  bus.export(SERVICE_PATH, (call) => {
    const reply = serviceProperties(call);
    if (reply) return reply;
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', call.member);
  });

  CHARACTERISTICS.forEach(({ name }, i) => {
    const chrcProperties = properties(GATT_CHARACTERISTIC, chrcProps[i]);
    bus.export(chrcPath(i), (call) => {
      const reply = chrcProperties(call);
      if (reply) return reply;
      if (call.interface === GATT_CHARACTERISTIC && call.member === 'ReadValue') {
        const options = call.body[0] as Map<string, unknown>;
        return ['ay', [read(name, options)]];
      }
      if (call.interface === GATT_CHARACTERISTIC && call.member === 'WriteValue') {
        const [value, options] = call.body as [Buffer, Map<string, unknown>];
        write(name, value, options, emit);
        return;
      }
      throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    });
  });

  const advertProperties = properties(ADVERTISEMENT, advertProps);
  bus.export(ADVERT_PATH, (call) => {
    const reply = advertProperties(call);
    if (reply) return reply;
    if (call.interface === OBJECT_MANAGER && call.member === 'GetManagedObjects') {
      return ['a{oa{sa{sv}}}', [new Map([[ADVERT_PATH, new Map([[ADVERTISEMENT, advertProps]])]])]];
    }
    if (call.interface === ADVERTISEMENT && call.member === 'Release') return;
    throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', call.member);
  });
}

function optionOf(options: Map<string, unknown>, name: string): unknown {
  return unwrap(options.get(name));
}

/** The attempt `device` is in, or a refusal. */
function attemptOf(device: unknown): Attempt {
  const attempt = session?.attempt;
  if (!attempt) throw bluezError('NotPermitted', 'Say hello first');
  if (attempt.device !== device) throw bluezError('NotPermitted', 'Another phone is logging in');
  return attempt;
}

function read(name: Chrc, options: Map<string, unknown>): Buffer {
  if (!session) throw bluezError('Failed', 'Not logging in');
  const offset = Number(optionOf(options, 'offset') ?? 0);
  let value: Buffer;
  if (name === 'session') value = session.intro;
  else if (name === 'nonce') value = attemptOf(optionOf(options, 'device')).dinNonce;
  else throw bluezError('NotPermitted', 'Not readable');
  if (offset > value.length) throw bluezError('InvalidOffset', 'Past the end');
  return value.subarray(offset);
}

function write(name: Chrc, value: Buffer, options: Map<string, unknown>, emit: (event: LoginEvent) => void): void {
  const current = session;
  if (!current) throw bluezError('Failed', 'Not logging in');
  const device = optionOf(options, 'device');
  const offset = Number(optionOf(options, 'offset') ?? 0);
  if (typeof device !== 'string') throw bluezError('NotPermitted', 'No device');

  if (name === 'hello') {
    // A phone that starts over gets a fresh attempt; a second phone waits
    // until the first one disconnects.
    if (current.attempt && current.attempt.device !== device) {
      throw bluezError('NotPermitted', 'Another phone is logging in');
    }
    if (offset !== 0 || value.length !== 64) throw bluezError('InvalidValueLength', 'Expected 64 bytes');
    current.attempt = {
      device,
      phone: Buffer.from(value.subarray(0, 32)),
      commitment: Buffer.from(value.subarray(32)),
      dinNonce: crypto.randomBytes(32),
      phoneNonce: null,
      key: Buffer.alloc(0),
    };
    emit({ type: 'connected' });
    return;
  }

  const attempt = attemptOf(device);

  if (name === 'reveal') {
    if (attempt.phoneNonce) throw bluezError('NotPermitted', 'Already revealed');
    if (offset !== 0 || value.length !== 32) throw bluezError('InvalidValueLength', 'Expected 32 bytes');
    const digest = crypto.createHash('sha256').update(value).digest();
    if (!crypto.timingSafeEqual(digest, attempt.commitment)) {
      current.attempt = null;
      emit({ type: 'waiting' });
      throw bluezError('Failed', 'Nonce does not match its commitment');
    }
    attempt.phoneNonce = Buffer.from(value);
    emit({ type: 'code', code: comparisonCode(current.din, attempt.phone, attempt.dinNonce, attempt.phoneNonce) });
    return;
  }

  if (name === 'key') {
    if (!attempt.phoneNonce) throw bluezError('NotPermitted', 'Compare codes first');
    if (offset + value.length > MAX_KEY_BYTES) throw bluezError('InvalidValueLength', 'Too long');
    // Long writes arrive in pieces, each with its offset.
    const assembled = Buffer.alloc(Math.max(attempt.key.length, offset + value.length));
    attempt.key.copy(assembled);
    value.copy(assembled, offset);
    attempt.key = assembled;
    if (assembled.length < 2) return;
    const length = assembled.readUInt16BE(0);
    if (assembled.length < 2 + length) return;
    emit({
      type: 'key',
      phone: attempt.phone.toString('hex'),
      payload: assembled.subarray(2, 2 + length).toString('base64'),
    });
    // After this reply has gone out.
    setImmediate(() => void stop(current));
    return;
  }

  throw bluezError('NotPermitted', 'Not writable');
}

/** Stop advertising and take the service down. */
async function stop(target: Session | null = session): Promise<void> {
  if (!target) return;
  if (session === target) session = null;
  clearTimeout(target.timer);
  target.unsubscribe();
  const call = (iface: string, member: string, path: string) =>
    target.bus
      .call({ destination: BLUEZ, path: target.adapter, interface: iface, member, signature: 'o', body: [path] })
      .catch(() => {});
  await call(ADVERTISING_MANAGER, 'UnregisterAdvertisement', ADVERT_PATH);
  await call(GATT_MANAGER, 'UnregisterApplication', APP_PATH);
  target.bus.close();
}

/** Start advertising for a login under the renderer's ephemeral key `din` (hex). */
async function start(din: string, emit: (event: LoginEvent) => void): Promise<void> {
  await stop();

  const bus = await DBusConnection.connect(SYSTEM_BUS);
  if (!bus) throw new Error("Can't reach the system bus.");

  try {
    const adapter = await findAdapter(bus).catch(() => null);
    if (!adapter) throw new Error('This computer has no Bluetooth adapter Din can use.');
    if (!adapter.powered) {
      await bus
        .call({
          destination: BLUEZ,
          path: adapter.path,
          interface: PROPERTIES,
          member: 'Set',
          signature: 'ssv',
          body: [ADAPTER, 'Powered', new Variant('b', true)],
        })
        .catch(() => {
          throw new Error("Bluetooth is off, and Din couldn't turn it on.");
        });
    }

    const name = Buffer.from(os.hostname(), 'utf8').subarray(0, 64);
    const dinKey = Buffer.from(din, 'hex');
    const current: Session = {
      bus,
      adapter: adapter.path,
      din: dinKey,
      intro: Buffer.concat([dinKey, name]),
      attempt: null,
      timer: setTimeout(() => {
        emit({ type: 'ended', reason: 'timeout' });
        void stop(current);
      }, SESSION_MS),
      // A phone that walks away mid-handshake frees the computer for another.
      unsubscribe: bus.subscribe({ interface: PROPERTIES, member: 'PropertiesChanged' }, (message: Message) => {
        const [iface, changed] = message.body as [string, Map<string, unknown>];
        if (iface !== DEVICE || unwrap(changed.get('Connected')) !== false) return;
        if (current.attempt?.device !== message.path) return;
        current.attempt = null;
        emit({ type: 'waiting' });
      }),
    };
    session = current;
    bus.onClose = () => {
      if (session !== current) return;
      emit({ type: 'ended', reason: 'error', message: 'Lost the connection to Bluetooth.' });
      void stop(current);
    };

    exportObjects(bus, emit);
    const register = (iface: string, member: string, path: string) =>
      bus.call({
        destination: BLUEZ,
        path: adapter.path,
        interface: iface,
        member,
        signature: 'oa{sv}',
        body: [path, {}],
      });
    await register(GATT_MANAGER, 'RegisterApplication', APP_PATH);
    await register(ADVERTISING_MANAGER, 'RegisterAdvertisement', ADVERT_PATH);
    emit({ type: 'waiting' });
  } catch (error) {
    await stop();
    bus.close();
    if (error instanceof DBusError) throw new Error(`Bluetooth said: ${error.message}`, { cause: error });
    throw error;
  }
}

export function registerBluetoothLoginHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender, sendToShell } = options;
  const emit = (event: LoginEvent) => sendToShell('bluetooth-login:event', event);

  // One at a time: a stop that ran while a start was still registering would
  // find no session and leave that one advertising.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  ipcMain.handle('bluetooth-login:available', (event) => {
    assertShellSender(event);
    return available();
  });

  ipcMain.handle('bluetooth-login:start', (event, din: unknown) => {
    assertShellSender(event);
    if (typeof din !== 'string' || !/^[0-9a-f]{64}$/.test(din)) throw new Error('A 32-byte hex key is required');
    return serially(() => start(din, emit));
  });

  ipcMain.handle('bluetooth-login:stop', (event) => {
    assertShellSender(event);
    return serially(() => stop());
  });
}
