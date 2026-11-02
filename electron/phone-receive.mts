// Files a phone shares to this computer over Bluetooth (Android's share
// sheet → Bluetooth → this computer), saved to ~/Downloads.
//
// BlueZ's obexd already offers Object Push (phone-map.mts starts it for
// Messages), but refuses every push unless an OBEX agent says where it goes.
// This is that agent. A phone added in Settings → Phone, still paired, with
// "Receive files" on, is let in without asking, as AirDrop and Quick Share
// treat the user's own devices; anything else is turned away. obexd writes
// only inside its own folder (~/.cache/obexd, the session's Root), so a file
// arrives there and moves to Downloads once it's whole, under a name of its
// own (`photo (1).jpg` beside `photo.jpg`); one that doesn't arrive whole is
// deleted.
//
// One OBEX session is one share: Android sends several files in a row over a
// single connection, so they're one batch, reported to the desktop as it goes
// (phone:receive, a PhoneReceive) for one notification that shows progress
// and then what arrived.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DBusError, unwrap, type DBusConnection, type Message } from './dbus.mts';
import { obex, onObexd } from './phone-map.mts';
import { claim, freeBytes, safeFileName } from './received-files.mts';
import type { PhoneReceive } from '../src/lib/phone.ts';

const OBEX = 'org.bluez.obex';
const AGENT_MANAGER = 'org.bluez.obex.AgentManager1';
const AGENT = 'org.bluez.obex.Agent1';
const TRANSFER = 'org.bluez.obex.Transfer1';
const SESSION = 'org.bluez.obex.Session1';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const AGENT_PATH = '/pub/din/ObexAgent';

/** A batch whose session lingers after a file is done counts as finished after this long. */
const IDLE_MS = 10_000;
/** Progress goes to the desktop at most this often. */
const PROGRESS_MS = 250;
/** Room kept free on the disk beyond what a file needs. */
const SPARE_BYTES = 64 * 1024 * 1024;

export interface ReceiveDeps {
  /** The phone with this Bluetooth address, if it may send files here. */
  sender(address: string): Promise<{ phoneId: string; name: string } | null>;
  emit(update: PhoneReceive): void;
}

interface Current {
  transfer: string;
  name: string;
  /** Where obexd writes it, in its own folder. */
  path: string;
  size: number | null;
  transferred: number;
}

interface Batch {
  id: string;
  session: string;
  phoneId: string;
  phoneName: string;
  files: { name: string; path: string }[];
  failed: string[];
  current: Current | null;
  /** Files moving to Downloads, which the batch waits for before it's done. */
  moves: Promise<void>[];
  cancelled: boolean;
  error: string | null;
  idle: NodeJS.Timeout | null;
  lastEmit: number;
  emitTimer: NodeJS.Timeout | null;
}

let deps: ReceiveDeps;
let agentBus: DBusConnection | null = null;
let unfollow: (() => void) | null = null;
/** Batches by their OBEX session's path. */
const batches = new Map<string, Batch>();
let nextBatch = 1;

const rejected = (why: string) => new DBusError('org.bluez.obex.Error.Rejected', why);

function getAll(b: DBusConnection, objectPath: string, iface: string): Promise<Map<string, unknown>> {
  return b
    .call({ destination: OBEX, path: objectPath, interface: PROPERTIES, member: 'GetAll', signature: 's', body: [iface] })
    .then(([props]) => props as Map<string, unknown>);
}

function report(batch: Batch, status: PhoneReceive['status']): PhoneReceive {
  return {
    id: batch.id,
    phoneId: batch.phoneId,
    phoneName: batch.phoneName,
    status,
    files: batch.files,
    failed: batch.failed,
    current: batch.current ? { name: batch.current.name, transferred: batch.current.transferred, size: batch.current.size } : null,
    error: batch.error,
  };
}

function emitProgress(batch: Batch, now = false): void {
  if (batch.emitTimer) return;
  const wait = now ? 0 : Math.max(0, batch.lastEmit + PROGRESS_MS - Date.now());
  const send = () => {
    batch.emitTimer = null;
    if (batches.get(batch.session) !== batch) return;
    batch.lastEmit = Date.now();
    deps.emit(report(batch, 'receiving'));
  };
  if (wait === 0) send();
  else batch.emitTimer = setTimeout(send, wait);
}

function finish(batch: Batch): void {
  if (batches.get(batch.session) !== batch) return;
  batches.delete(batch.session);
  clearTimeout(batch.idle ?? undefined);
  clearTimeout(batch.emitTimer ?? undefined);
  if (batch.current) fileFailed(batch);
  void Promise.all(batch.moves).then(() => {
    const status = batch.files.length ? 'done' : batch.cancelled ? 'cancelled' : 'failed';
    deps.emit(report(batch, status));
  });
}

/** Move a whole file from obexd's folder to Downloads. */
async function moveToDownloads(batch: Batch, from: string, name: string): Promise<void> {
  let to: string | null = null;
  try {
    to = claim(app.getPath('downloads'), name);
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.promises.copyFile(from, to);
      await fs.promises.rm(from, { force: true });
    }
    batch.files.push({ name: path.basename(to), path: to });
  } catch (error) {
    console.error('phone: saving a received file failed', error);
    batch.failed.push(name);
    batch.error = `Couldn’t save it in Downloads: ${error instanceof Error ? error.message : String(error)}`;
    if (to) fs.rm(to, { force: true }, () => {});
    fs.rm(from, { force: true }, () => {});
  }
}

/** The file arriving didn't: it goes, and the batch says so. */
function fileFailed(batch: Batch): void {
  const current = batch.current;
  if (!current) return;
  batch.current = null;
  batch.failed.push(current.name);
  fs.rm(current.path, { force: true }, () => {});
}

function batchByTransfer(transfer: string): Batch | undefined {
  for (const batch of batches.values()) if (batch.current?.transfer === transfer) return batch;
  return undefined;
}

/**
 * Whether the Bluetooth link to `address` is authenticated and encrypted,
 * from the kernel (HCIGETCONNINFO, as electron/quickshare-bt.py asks): only
 * the phone that holds the pairing's key can make it so, where its address
 * alone is anyone's to claim. Node has no Bluetooth sockets, so Python asks.
 */
const LINK_SECURED = `
import fcntl, socket, struct, sys
address = bytes(reversed([int(x, 16) for x in sys.argv[1].split(':')]))
for hci in range(8):
    try:
        s = socket.socket(31, socket.SOCK_RAW, 1)
        s.bind((hci,))
        request = bytearray(address + bytes([1, 0]) + bytes(16))
        fcntl.ioctl(s.fileno(), 0x800448D5, request, True)
        mode = struct.unpack_from('<I', request, 20)[0]
        if mode & 0x0002 and mode & 0x0004:
            print('secured')
            break
    except OSError:
        pass
`;

function linkSecured(address: string): Promise<boolean> {
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(address)) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(process.env.DIN_QUICKSHARE_PYTHON || 'python3', ['-I', '-c', LINK_SECURED, address], { timeout: 10_000 }, (error, stdout) =>
      resolve(!error && stdout.trim() === 'secured'),
    );
  });
}

async function authorize(b: DBusConnection, transfer: string): Promise<string> {
  const props = await getAll(b, transfer, TRANSFER);
  const session = String(unwrap(props.get('Session')) ?? '');
  const sessionProps = session ? await getAll(b, session, SESSION).catch(() => null) : null;
  const address = String(unwrap(sessionProps?.get('Destination')) ?? '');
  const who = address && (await linkSecured(address)) ? await deps.sender(address) : null;
  if (!who) {
    console.warn(`phone: turned away a file from ${address || 'an unknown device'}`);
    throw rejected('Not one of this computer’s phones');
  }

  let batch = batches.get(session);
  if (batch?.cancelled) throw rejected('Cancelled');
  if (!batch) {
    batch = {
      id: `receive-${nextBatch++}`,
      session,
      phoneId: who.phoneId,
      phoneName: who.name,
      files: [],
      failed: [],
      current: null,
      moves: [],
      cancelled: false,
      error: null,
      idle: null,
      lastEmit: 0,
      emitTimer: null,
    };
    batches.set(session, batch);
  }
  clearTimeout(batch.idle ?? undefined);
  batch.idle = null;
  if (batch.current) fileFailed(batch);

  const name = safeFileName(String(unwrap(props.get('Name')) ?? ''));
  const sizeValue = unwrap(props.get('Size'));
  const size = typeof sizeValue === 'bigint' || typeof sizeValue === 'number' ? Number(sizeValue) : null;
  const root = String(unwrap(sessionProps?.get('Root')) ?? '');
  if (!path.isAbsolute(root)) throw rejected('No folder to save in');
  const downloads = app.getPath('downloads');
  const free = Math.min(freeBytes(root) ?? Infinity, freeBytes(downloads) ?? freeBytes(path.dirname(downloads)) ?? Infinity);
  if (size !== null && size + SPARE_BYTES > free) {
    batch.failed.push(name);
    batch.error = 'There isn’t enough free space.';
    scheduleIdle(batch);
    throw rejected('Not enough space');
  }

  let file: string;
  try {
    file = claim(root, name);
  } catch (error) {
    batch.failed.push(name);
    batch.error = `Couldn’t save it: ${error instanceof Error ? error.message : String(error)}`;
    scheduleIdle(batch);
    throw rejected('Can’t save');
  }
  batch.current = { transfer, name, path: file, size, transferred: 0 };
  emitProgress(batch, true);
  return file;
}

function scheduleIdle(batch: Batch): void {
  clearTimeout(batch.idle ?? undefined);
  batch.idle = setTimeout(() => finish(batch), IDLE_MS);
}

function onTransferChanged(transfer: string, values: Map<string, unknown>): void {
  const batch = batchByTransfer(transfer);
  if (!batch?.current) return;
  const transferred = unwrap(values.get('Transferred'));
  if (typeof transferred === 'bigint' || typeof transferred === 'number') {
    batch.current.transferred = Number(transferred);
    emitProgress(batch);
  }
  const size = unwrap(values.get('Size'));
  if (typeof size === 'bigint' || typeof size === 'number') batch.current.size = Number(size);
  const status = unwrap(values.get('Status'));
  if (status === 'complete') {
    const { name, path: file } = batch.current;
    batch.current = null;
    batch.moves.push(moveToDownloads(batch, file, name).then(() => emitProgress(batch, true)));
    scheduleIdle(batch);
  } else if (status === 'error') {
    fileFailed(batch);
    if (!batch.cancelled) batch.error ??= 'The connection to the phone was lost.';
    scheduleIdle(batch);
  }
}

function onRemoved(objectPath: string, ifaces: string[]): void {
  if (ifaces.includes(SESSION)) {
    const batch = batches.get(objectPath);
    if (batch) finish(batch);
  } else if (ifaces.includes(TRANSFER)) {
    const batch = batchByTransfer(objectPath);
    if (batch) finish(batch);
  }
}

function exportAgent(b: DBusConnection): void {
  b.export(AGENT_PATH, async (agentCall) => {
    if (agentCall.interface !== AGENT) throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', agentCall.member);
    switch (agentCall.member) {
      case 'AuthorizePush':
        return ['s', [await authorize(b, String(agentCall.body[0]))]];
      case 'Release':
      case 'Cancel':
        return;
      default:
        throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', agentCall.member);
    }
  });
}

/** Follow a new obexd: hear its transfers, and be its agent. */
function attach(b: DBusConnection, owner: string | null): void {
  if (agentBus !== b) {
    agentBus = b;
    exportAgent(b);
  }
  unfollow?.();
  unfollow = null;
  // Whatever was arriving from the old obexd is gone with it.
  for (const batch of [...batches.values()]) finish(batch);
  if (!owner) return;
  const subscriptions = [
    b.subscribe({ sender: owner, interface: PROPERTIES, member: 'PropertiesChanged' }, (message: Message) => {
      if (message.body[0] !== TRANSFER || !message.path) return;
      onTransferChanged(message.path, message.body[1] as Map<string, unknown>);
    }),
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesRemoved' }, (message: Message) => {
      const [objectPath, ifaces] = message.body as [string, string[]];
      onRemoved(objectPath, ifaces);
    }),
  ];
  unfollow = () => subscriptions.forEach((unsubscribe) => unsubscribe());
  b.call({ destination: OBEX, path: '/org/bluez/obex', interface: AGENT_MANAGER, member: 'RegisterAgent', signature: 'o', body: [AGENT_PATH] }).catch(
    (error) => {
      if (error instanceof DBusError && error.type === 'org.bluez.obex.Error.AlreadyExists') return;
      console.error('phone: registering the file agent failed', error);
    },
  );
}

/** Cancel a batch: the file arriving stops, and nothing more from that share is taken. */
export function cancelReceive(id: string): void {
  const batch = [...batches.values()].find((b) => b.id === id);
  if (!batch) return;
  batch.cancelled = true;
  const transfer = batch.current?.transfer;
  if (transfer && agentBus) {
    agentBus.call({ destination: OBEX, path: transfer, interface: TRANSFER, member: 'Cancel' }).catch(() => finish(batch));
  } else {
    finish(batch);
  }
}

/** Be obexd's agent from now on, starting obexd if need be. */
export function startReceiving(options: ReceiveDeps): void {
  deps = options;
  onObexd(attach);
  void obex();
}
