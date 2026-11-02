// Quick Share (the Quick Share app, din.system.quickShare): Android phones,
// tablets and Chromebooks share files and links to this computer from their
// share sheet, as they share with each other. This computer is visible while
// a Quick Share window is open, as with AirDrop's window or Android's Receive
// screen: the app calls `receive`, and closing its last window withdraws the
// announcements, closes the port and ends the shares it was showing.
//
// It's also visible for a little while when one of the user's own phones
// opens its share sheet: while a phone from Settings → Phone with "Receive
// files" on is connected over Bluetooth (phone.mts, connectedFilePhones),
// an LE scan listens for the beacon Quick Share sends then (service data
// 0xFE2C, "fast initiation"), and hearing it makes this computer visible
// over Bluetooth for NEARBY_MS more (not on the network, where a share can't
// say which phone it's from).
//
// Quick Share (once Nearby Share) runs on Google's Nearby Connections, which
// isn't published; this follows NearDrop's and rquickshare's reading of it,
// Google's open-source Nearby code, and the field numbers in its .proto
// files. No server is involved.
//
// - Discovery: on the network, this computer announces itself over mDNS
//   through Avahi (service _FC9F5ED42C8A._tcp, an endpoint id in the
//   service's name and its name and device type in the TXT record), and
//   listens on PORT, which DinOS's firewall lets in. Over Bluetooth, it sends
//   the LE advertisement Android receivers send (bleAdvertisement), which
//   carries its Bluetooth address (quickshare-bluetooth.mts).
// - Connection: the phone connects, over TCP or Bluetooth RFCOMM, and asks
//   to (ConnectionRequest), then the two run a UKEY2 handshake (ECDH on
//   P-256). Everything after it is encrypted with AES-256-CBC and signed with
//   HMAC-SHA256, in keys derived from the handshake, which also gives a
//   4-digit PIN both screens show.
// - Moving to Wi-Fi: Bluetooth manages tens of KB/s, so a phone that
//   connected over it is offered a Wi-Fi hotspot this computer hosts
//   (quickshare-hotspot.mts; Android phones leave their own Wi-Fi while the
//   share sheet is open). It joins it, connects to PORT there and says it's
//   the same phone (ClientIntroduction), then both sides finish with
//   Bluetooth and carry on over Wi-Fi, with the same keys. Without a hotspot
//   the share stays on Bluetooth.
// - Sharing: the phone offers files or a piece of text (Introduction).
//   Anyone could be sending, since only Google's own devices can prove
//   they're "yours" or a contact's, so the user is asked, with the PIN: in
//   the app, or in a notification from the desktop when no window is open
//   (`background`). Not for a phone from Settings → Phone with "Receive
//   files" on, connected over Bluetooth on a link with the pairing's key:
//   that proves which phone it is, so its share arrives without asking.
//   Accepted files are written straight into ~/Downloads, under a name of
//   their own (`photo (1).jpg` beside `photo.jpg`); one that doesn't arrive
//   whole is deleted. Text arrives as a .txt file, and a link is offered to
//   open.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain, webContents } from 'electron';
import { onBluetoothChanged } from './bluetooth.mts';
import { DBusConnection, DBusError, unwrap, Variant, type Message } from './dbus.mts';
import { connectedFilePhones, fileSender, onPhonesChanged } from './phone.mts';
import {
  advertiseOverBluetooth,
  advertisingOverBluetooth,
  bluetoothMayWork,
  onBluetooth,
  quitBluetooth,
  type BluetoothPeer,
} from './quickshare-bluetooth.mts';
import { holdHotspot, hotspot, quitHotspot } from './quickshare-hotspot.mts';
import { claim, freeBytes, safeFileName } from './received-files.mts';
import { Writer, big, bytes, decode, int, message, messages, str, type Fields } from './protobuf.mts';
import type { QuickShareDeviceType, QuickShareState, QuickShareTransfer } from '../src/lib/quickShare.ts';

/** The port Quick Share listens on; os/configuration.nix opens it in the firewall. */
const PORT = 47331;
const SERVICE_TYPE = '_FC9F5ED42C8A._tcp';
/** The first three bytes of SHA-256("NearbySharing"), Quick Share's service id in Nearby's announcements. */
const SERVICE_HASH = Buffer.from([0xfc, 0x9f, 0x5e]);
const SYSTEM_BUS = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket';
const AVAHI = 'org.freedesktop.Avahi';
const AVAHI_SERVER = 'org.freedesktop.Avahi.Server';
const AVAHI_GROUP = 'org.freedesktop.Avahi.EntryGroup';

/** The largest frame, or bytes payload, a device may send. */
const MAX_FRAME = 5 * 1024 * 1024;
/** Devices connected at once; more are turned away. */
const MAX_CONNECTIONS = 4;
const MAX_FILES = 1000;
/** A device has this long from connecting to say what it's sharing. */
const HANDSHAKE_MS = 30_000;
/** The user has this long to accept. */
const ASK_MS = 90_000;
/** An accepted share that goes quiet this long has failed. */
const IDLE_MS = 60_000;
/** Progress goes to the desktop at most this often. */
const PROGRESS_MS = 250;
/** Room kept free on the disk beyond what a share needs. */
const SPARE_BYTES = 64 * 1024 * 1024;
/** How long the share-sheet beacon of one of the user's phones keeps this computer visible. */
const NEARBY_MS = 90_000;
/** Quick Share's share-sheet beacon (fast initiation), as BlueZ names its service data. */
const FAST_INIT_UUID = '0000fe2c-0000-1000-8000-00805f9b34fb';
/** The weakest signal (dBm) the share-sheet scan hears: a phone in the room. */
const NEARBY_RSSI = -75;
const BLUEZ = 'org.bluez';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
/** How long to wait before trying Avahi again when it isn't there. */
const RETRY_MS = 10_000;

// Nearby Connections' OfflineFrame (offline_wire_formats.proto).
const FRAME = { connectionRequest: 1, connectionResponse: 2, payloadTransfer: 3, bandwidthUpgrade: 4, keepAlive: 5, disconnection: 6 } as const;
// BandwidthUpgradeNegotiationFrame's events and UpgradePathInfo's media.
const UPGRADE = { pathAvailable: 1, lastWrite: 2, safeToClose: 3, clientIntroduction: 4, failure: 5, clientIntroductionAck: 6 } as const;
const UPGRADE_MEDIUM = { wifiHotspot: 3 } as const;
const PAYLOAD = { bytes: 1, file: 2 } as const;
const PACKET = { data: 1, control: 2 } as const;
const LAST_CHUNK = 1;
// Nearby Sharing's Frame (wire_format.proto).
const SHARING = { introduction: 1, response: 2, pairedKeyEncryption: 3, pairedKeyResult: 4, cancel: 6 } as const;
const RESPONSE = { accept: 1, reject: 2, notEnoughSpace: 3, unsupported: 4, timedOut: 5 } as const;
const TEXT_TYPE = { text: 1, url: 2, address: 3, phoneNumber: 4 } as const;
// UKEY2 (ukey.proto).
const UKEY = { alert: 1, clientInit: 2, serverInit: 3, clientFinish: 4 } as const;
const ALERT = { badMessageType: 2, badMessageData: 4, badVersion: 100, badRandom: 101, badHandshakeCipher: 102, badNextProtocol: 103 } as const;
const P256_SHA512 = 100;
const NEXT_PROTOCOL = 'AES_256_CBC-HMAC_SHA256';
const D2D_SALT = Buffer.from('82AA55A0D397F88346CA1CEE8D3909B95F13FA7DEB1D4AB38376B8256DA85510', 'hex');
const SECURE_MESSAGE_SALT = crypto.createHash('sha256').update('SecureMessage').digest();
/** GcmMetadata { type: DEVICE_TO_DEVICE_MESSAGE, version: 1 }, in every SecureMessage's header. */
const GCM_METADATA = new Writer().int(1, 13).int(2, 1).finish();

type Deps = {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
};

let deps: Deps;
/** The windows receiving, by WebContents id, each with what stops following it. */
const leases = new Map<number, () => void>();
/** Until when a phone's share sheet keeps this computer visible (ms), and its timer. */
let nearbyUntil = 0;
let nearbyTimer: NodeJS.Timeout | null = null;
/** Keeps the hotspot up while a phone's share sheet keeps this computer visible. */
let nearbyHotspot: (() => void) | null = null;
/** The adapter scanning for share sheets, or null when not scanning. */
let scanning: string | null = null;
let unwatchScan: (() => void) | null = null;
let checkingPhones: Promise<void> = Promise.resolve();
let server: net.Server | null = null;
let listeningPort = 0;
let avahiBus: DBusConnection | null = null;
let group: string | null = null;
let unwatchGroup: (() => void) | null = null;
let advertised = false;
let error: string | null = null;
let retry: NodeJS.Timeout | null = null;
/** Start and stop one at a time, in order. */
let applying: Promise<void> = Promise.resolve();
const connections = new Map<string, Connection>();
let nextTransfer = 1;
/** Four letters and digits naming this computer to devices; a new one if another device has it. */
let endpointId = randomEndpointId();

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function randomEndpointId(): Buffer {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Buffer.from(Array.from(crypto.randomBytes(4), (b) => alphabet.charCodeAt(b % alphabet.length)));
}

function deviceName(): string {
  let name = os.hostname().trim() || 'Din';
  while (Buffer.byteLength(name) > 64) name = name.slice(0, -1);
  return name;
}

/** Version, visibility and device type (3, a laptop), 16 random bytes, then the name. */
function endpointInfo(): Buffer {
  const name = Buffer.from(deviceName(), 'utf8');
  return Buffer.concat([Buffer.from([3 << 1]), crypto.randomBytes(16), Buffer.from([name.length]), name]);
}

/**
 * The LE advertisement's service data (0xFEF3): Nearby's BLE medium
 * advertisement (version 2, socket version 2, not fast: the service hash,
 * the length, then the data and two random bytes) around a connections
 * advertisement (version 1, point to point: the service hash, endpoint id,
 * endpoint info, then the Bluetooth address phones connect to over RFCOMM,
 * and no UWB address or extra fields).
 */
function bleAdvertisement(address: string): Buffer {
  const info = endpointInfo();
  const mac = Buffer.from(address.split(':').map((byte) => parseInt(byte, 16)));
  const connections = Buffer.concat([Buffer.from([0x23]), SERVICE_HASH, endpointId, Buffer.from([info.length]), info, mac, Buffer.from([0, 0])]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(connections.length);
  return Buffer.concat([Buffer.from([(2 << 5) | (2 << 2)]), SERVICE_HASH, length, connections, crypto.randomBytes(2)]);
}

function offlineFrame(type: number, field?: number, body?: Writer): Buffer {
  const v1 = new Writer().int(1, type);
  if (field !== undefined) v1.bytes(field, body ?? new Writer());
  return new Writer().int(1, 1).bytes(2, v1).finish();
}

function sharingFrame(type: number, field?: number, body?: Writer): Buffer {
  const v1 = new Writer().int(1, type);
  if (field !== undefined) v1.bytes(field, body ?? new Writer());
  return new Writer().int(1, 1).bytes(2, v1).finish();
}

/** A positive big-endian integer as Java's BigInteger writes it: no leading zeros, but a zero byte before a high bit. */
function signedBytes(unsigned: Buffer): Buffer {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start++;
  const trimmed = unsigned.subarray(start);
  return trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
}

/** A coordinate from the other side, as 32 bytes. */
function coordinate(value: Buffer | undefined): Buffer {
  if (!value) throw new Error('missing key coordinate');
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  if (trimmed.length > 32) throw new Error('key coordinate too long');
  return Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]);
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer | string, length = 32): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, typeof info === 'string' ? Buffer.from(info) : info, length));
}

/** The 4-digit code both screens show, from the handshake's auth string. */
function pinCode(auth: Buffer): string {
  let hash = 0;
  let multiplier = 1;
  for (const byte of auth) {
    const signed = byte > 127 ? byte - 256 : byte;
    hash = (hash + signed * multiplier) % 9973;
    multiplier = (multiplier * 31) % 9973;
  }
  return String(Math.abs(hash)).padStart(4, '0');
}

function deviceType(raw: number): QuickShareDeviceType {
  return raw === 1 ? 'phone' : raw === 2 ? 'tablet' : raw === 3 ? 'computer' : 'unknown';
}

/** A name a device gives itself, made safe to show. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return cleaned.slice(0, 64) || 'A nearby device';
}

class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// A connection from a device
// ---------------------------------------------------------------------------

interface Keys {
  decrypt: Buffer;
  encrypt: Buffer;
  receiveHmac: Buffer;
  sendHmac: Buffer;
}

interface IncomingFile {
  name: string;
  size: number;
  path: string | null;
  stream: fs.WriteStream | null;
  written: number;
  /** Every byte has arrived. */
  whole: boolean;
  /** …and is on disk. */
  done: boolean;
}

class Connection {
  readonly id: string;
  private socket: net.Socket;
  private chunks: Buffer[] = [];
  private queued = 0;
  /** The device's endpoint id, from its connection request: how its upgraded channel names it. */
  remoteEndpointId = '';
  /** Moving to a faster channel: offered, then the new socket while the old one drains. */
  upgrade: 'none' | 'offered' | 'switching' | 'done' = 'none';
  private upgradeSocket: net.Socket | null = null;
  private upgradeChunks: Buffer[] = [];
  private stage: 'request' | 'client-init' | 'client-finish' | 'connection-response' | 'secure' = 'request';
  private sharing: 'paired-key' | 'paired-result' | 'introduction' | 'asking' | 'receiving' | 'over' = 'paired-key';
  private device = 'A nearby device';
  private type: QuickShareDeviceType = 'unknown';
  private clientInit: Buffer | null = null;
  private serverInit: Buffer | null = null;
  private commitment: Buffer | null = null;
  private ecdh: crypto.ECDH | null = null;
  private keys: Keys | null = null;
  private pin = '';
  private sendSequence = 0;
  private receiveSequence = 0;
  /** Bytes payloads (sharing frames, text) arriving, by payload id. */
  private buffers = new Map<bigint, { parts: Buffer[]; size: number }>();
  private files = new Map<bigint, IncomingFile>();
  private text: { id: bigint; kind: 'text' | 'url'; size: number; done: boolean } | null = null;
  private transfer: QuickShareTransfer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** The DISCONNECTION frame has been sent. */
  private saidGoodbye = false;
  /** Where it connected from over Bluetooth, or null over the network. */
  readonly bluetooth: BluetoothPeer | null;
  /** Only a phone's faster channel for another connection, so nothing but its introduction. */
  private readonly upgradeOnly: boolean;
  /** The phone from Settings → Phone it proved to be, whose shares arrive without asking. */
  private trusted: Promise<{ phoneId: string; name: string } | null>;
  private releaseHotspot: (() => void) | null = null;
  /**
   * Whether it may be offered the hotspot: one of the user's phones, proven,
   * or a share the user accepted. Its password lets a device onto the
   * network, so nothing in Bluetooth range gets it for connecting.
   */
  private upgradeAllowed = false;

  /** Whether a window is showing this share (so closing the last one ends it). */
  get windowed(): boolean {
    return this.transfer !== null && !this.transfer.background;
  }

  constructor(socket: net.Socket, options: { bluetooth?: BluetoothPeer; upgradeOnly?: boolean } = {}) {
    this.id = `quickshare-${nextTransfer++}`;
    this.socket = socket;
    this.bluetooth = options.bluetooth ?? null;
    this.upgradeOnly = options.upgradeOnly ?? false;
    const peer = this.bluetooth;
    // A paired phone's address alone could be claimed by anything; the link's encryption can't.
    this.trusted = peer?.paired && peer.secured ? fileSender(peer.address).catch(() => null) : Promise.resolve(null);
    // One of the user's phones is offered the faster channel at once.
    if (peer) {
      void this.trusted.then((phone) => {
        if (phone) this.allowUpgrade();
      });
    }
    this.listenTo(socket);
    socket.resume();
    this.wait(HANDSHAKE_MS, () => this.fail(new ProtocolError('handshake timed out')));
  }

  private listenTo(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      if (socket === this.socket) this.ingest(chunk);
      else if (socket === this.upgradeSocket) this.upgradeChunks.push(chunk);
    });
    const gone = () => {
      if (socket === this.socket) this.lost();
      else if (socket === this.upgradeSocket) {
        console.warn(`quickshare: ${this.device}: the faster channel closed before it was used`);
        this.upgradeSocket = null;
        this.upgradeChunks = [];
        this.upgrade = 'none';
      }
    };
    socket.on('error', gone);
    socket.on('close', gone);
  }

  /** Bring the hotspot up for a Bluetooth peer it may have, and offer it once the channel is encrypted. */
  private allowUpgrade(): void {
    if (!this.bluetooth || this.closed || this.upgradeAllowed) return;
    this.upgradeAllowed = true;
    this.releaseHotspot ??= holdHotspot();
    if (this.stage === 'secure') void this.offerUpgrade();
  }

  /**
   * Offer the device the hotspot, once it's up: it joins it, connects to
   * PORT there and introduces itself (adopt), then both sides drain and close
   * this channel. UpgradePathInfo's 7 and 9: it needn't encrypt the new
   * channel again, and may introduce itself unencrypted on it.
   */
  private async offerUpgrade(): Promise<void> {
    const spot = await hotspot();
    await applying;
    if (!spot || !server || this.closed || this.upgrade !== 'none' || this.sharing === 'over') return;
    const credentials = new Writer().bytes(1, spot.ssid).bytes(2, spot.password).int(3, listeningPort).bytes(4, spot.gateway).int(5, spot.frequency);
    const path = new Writer().int(1, UPGRADE_MEDIUM.wifiHotspot).bytes(2, credentials).int(7, false).int(9, true);
    this.upgrade = 'offered';
    this.sendOffline(offlineFrame(FRAME.bandwidthUpgrade, 5, new Writer().int(1, UPGRADE.pathAvailable).bytes(2, path)));
  }

  /** The device connected again over the faster channel: answer it, and drain this one. */
  adopt(socket: net.Socket, leftover: Buffer[]): void {
    if (this.upgrade !== 'offered' || this.closed) {
      socket.destroy();
      return;
    }
    this.upgrade = 'switching';
    this.upgradeSocket = socket;
    this.upgradeChunks = leftover;
    this.listenTo(socket);
    const ack = new Writer().int(1, 1).bytes(2, new Writer().int(1, FRAME.bandwidthUpgrade).bytes(5, new Writer().int(1, UPGRADE.clientIntroductionAck).bytes(4, new Writer()))).finish();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(ack.length);
    socket.write(Buffer.concat([length, ack]));
    this.sendOffline(offlineFrame(FRAME.bandwidthUpgrade, 5, new Writer().int(1, UPGRADE.lastWrite)));
  }

  /** Both sides are done with the old channel: say goodbye on it, unencrypted, and carry on over the new one. */
  private switchChannel(): void {
    const old = this.socket;
    const next = this.upgradeSocket;
    if (!next) return;
    const goodbye = offlineFrame(FRAME.disconnection, 7, new Writer().int(1, false).int(2, false));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(goodbye.length);
    this.socket = next;
    this.upgradeSocket = null;
    this.upgrade = 'done';
    old.removeAllListeners('data');
    old.end(Buffer.concat([length, goodbye]));
    setTimeout(() => old.destroy(), 2000).unref();
    this.chunks = this.upgradeChunks;
    this.queued = this.chunks.reduce((n, c) => n + c.length, 0);
    this.upgradeChunks = [];
    this.ingest(Buffer.alloc(0));
  }

  // --- Framing -------------------------------------------------------------

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.queued += chunk.length;
    try {
      while (!this.closed && this.queued >= 4) {
        if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
        const buffer = this.chunks[0];
        const length = buffer.readUInt32BE(0);
        if (length > MAX_FRAME) throw new ProtocolError(`frame of ${length} bytes`);
        if (buffer.length < 4 + length) return;
        const frame = buffer.subarray(4, 4 + length);
        this.chunks = buffer.length > 4 + length ? [buffer.subarray(4 + length)] : [];
        this.queued -= 4 + length;
        this.frame(frame);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private write(frame: Buffer): void {
    if (this.closed) return;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(frame.length);
    this.socket.write(Buffer.concat([length, frame]));
  }

  private frame(frame: Buffer): void {
    switch (this.stage) {
      case 'request':
        return this.connectionRequest(decode(frame));
      case 'client-init':
        return this.ukeyClientInit(frame);
      case 'client-finish':
        return this.ukeyClientFinish(frame);
      case 'connection-response':
        return this.connectionResponse(decode(frame));
      case 'secure':
        return this.offline(this.unseal(frame));
    }
  }

  // --- The handshake -------------------------------------------------------

  private connectionRequest(frame: Fields): void {
    const v1 = message(frame, 2);
    if (v1 && int(v1, 1) === FRAME.bandwidthUpgrade) return this.handOver(message(v1, 5) ?? new Map());
    if (this.upgradeOnly) throw new ProtocolError('expected an upgrade’s introduction');
    if (!v1 || int(v1, 1) !== FRAME.connectionRequest) throw new ProtocolError('expected a connection request');
    this.remoteEndpointId = str(message(v1, 2) ?? new Map(), 1) ?? '';
    const info = bytes(message(v1, 2) ?? new Map(), 6);
    if (!info || info.length < 18) throw new ProtocolError('no endpoint info');
    this.type = deviceType((info[0] >> 1) & 7);
    const hasName = (info[0] & 0x10) === 0;
    const length = info[17];
    if (hasName && info.length >= 18 + length) {
      const name = info.subarray(18, 18 + length);
      this.device = cleanName(new TextDecoder('utf-8', { fatal: false }).decode(name));
    }
    this.stage = 'client-init';
  }

  private alert(type: number, why: string): never {
    this.write(new Writer().int(1, UKEY.alert).bytes(2, new Writer().int(1, type)).finish());
    throw new ProtocolError(why);
  }

  private ukeyClientInit(raw: Buffer): void {
    const msg = decode(raw);
    if (int(msg, 1) !== UKEY.clientInit) this.alert(ALERT.badMessageType, 'expected UKEY2 ClientInit');
    let init: Fields;
    try {
      init = decode(bytes(msg, 2) ?? Buffer.alloc(0));
    } catch {
      this.alert(ALERT.badMessageData, 'bad ClientInit');
    }
    if (int(init, 1) !== 1) this.alert(ALERT.badVersion, 'UKEY2 version');
    if (bytes(init, 2)?.length !== 32) this.alert(ALERT.badRandom, 'UKEY2 random');
    const commitment = messages(init, 3).find((c) => int(c, 1) === P256_SHA512);
    const hash = commitment && bytes(commitment, 2);
    if (!hash) this.alert(ALERT.badHandshakeCipher, 'no P-256 commitment');
    if (str(init, 4) !== NEXT_PROTOCOL) this.alert(ALERT.badNextProtocol, `next protocol ${str(init, 4)}`);

    this.commitment = Buffer.from(hash);
    this.clientInit = Buffer.from(raw);
    this.ecdh = crypto.createECDH('prime256v1');
    const point = this.ecdh.generateKeys();
    const publicKey = new Writer()
      .int(1, 1)
      .bytes(2, new Writer().bytes(1, signedBytes(point.subarray(1, 33))).bytes(2, signedBytes(point.subarray(33, 65))));
    const serverInit = new Writer().int(1, 1).bytes(2, crypto.randomBytes(32)).int(3, P256_SHA512).bytes(4, publicKey);
    this.serverInit = new Writer().int(1, UKEY.serverInit).bytes(2, serverInit).finish();
    this.write(this.serverInit);
    this.stage = 'client-finish';
  }

  private ukeyClientFinish(raw: Buffer): void {
    const msg = decode(raw);
    if (int(msg, 1) !== UKEY.clientFinish) throw new ProtocolError('expected UKEY2 ClientFinish');
    const hash = crypto.createHash('sha512').update(raw).digest();
    if (!this.commitment || hash.length !== this.commitment.length || !crypto.timingSafeEqual(hash, this.commitment)) {
      throw new ProtocolError('ClientFinish doesn’t match its commitment');
    }
    const finish = decode(bytes(msg, 2) ?? Buffer.alloc(0));
    const key = message(decode(bytes(finish, 1) ?? Buffer.alloc(0)), 2);
    if (!key || !this.ecdh || !this.clientInit || !this.serverInit) throw new ProtocolError('no public key');
    const peer = Buffer.concat([Buffer.from([4]), coordinate(bytes(key, 1)), coordinate(bytes(key, 2))]);
    const secret = crypto.createHash('sha256').update(this.ecdh.computeSecret(peer)).digest();
    this.ecdh = null;

    const info = Buffer.concat([this.clientInit, this.serverInit]);
    const auth = hkdf(secret, Buffer.from('UKEY2 v1 auth'), info);
    const next = hkdf(secret, Buffer.from('UKEY2 v1 next'), info);
    const client = hkdf(next, D2D_SALT, 'client');
    const server = hkdf(next, D2D_SALT, 'server');
    this.keys = {
      decrypt: hkdf(client, SECURE_MESSAGE_SALT, 'ENC:2'),
      receiveHmac: hkdf(client, SECURE_MESSAGE_SALT, 'SIG:1'),
      encrypt: hkdf(server, SECURE_MESSAGE_SALT, 'ENC:2'),
      sendHmac: hkdf(server, SECURE_MESSAGE_SALT, 'SIG:1'),
    };
    this.pin = pinCode(auth);
    this.stage = 'connection-response';
  }

  /** This socket is another connection's faster channel: give it to that connection. */
  private handOver(upgrade: Fields): void {
    const introduction = message(upgrade, 3);
    const endpoint = introduction && str(introduction, 1);
    const target = [...connections.values()].find((c) => c !== this && c.upgrade === 'offered' && c.remoteEndpointId === endpoint);
    if (int(upgrade, 1) !== UPGRADE.clientIntroduction || !target) throw new ProtocolError('an upgrade nobody offered');
    const socket = this.socket;
    const leftover = this.chunks;
    this.chunks = [];
    this.queued = 0;
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    this.closed = true;
    clearTimeout(this.timer ?? undefined);
    connections.delete(this.id);
    target.adopt(socket, leftover);
  }

  private connectionResponse(frame: Fields): void {
    const v1 = message(frame, 2);
    if (!v1 || int(v1, 1) !== FRAME.connectionResponse) throw new ProtocolError('expected a connection response');
    const osInfo = new Writer().int(1, 100); // LINUX
    this.write(offlineFrame(FRAME.connectionResponse, 3, new Writer().int(1, 0).int(3, 1).bytes(4, osInfo)));
    this.stage = 'secure';
    // The paired-key exchange proves devices are the same account's or contacts'; there's no
    // Google account here to prove anything with, so this says nothing and the user is asked.
    this.sendSharing(
      sharingFrame(SHARING.pairedKeyEncryption, 4, new Writer().bytes(1, crypto.randomBytes(72)).bytes(2, crypto.randomBytes(6))),
    );
    if (this.upgradeAllowed) void this.offerUpgrade();
  }

  // --- Encryption ----------------------------------------------------------

  private unseal(frame: Buffer): Fields {
    const keys = this.keys!;
    const secure = decode(frame);
    const headerAndBody = bytes(secure, 1);
    const signature = bytes(secure, 2);
    if (!headerAndBody || !signature) throw new ProtocolError('not a SecureMessage');
    const expected = crypto.createHmac('sha256', keys.receiveHmac).update(headerAndBody).digest();
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) throw new ProtocolError('bad signature');
    const parsed = decode(headerAndBody);
    const iv = bytes(message(parsed, 1) ?? new Map(), 5);
    const body = bytes(parsed, 2);
    if (!iv || iv.length !== 16 || !body) throw new ProtocolError('no IV or body');
    const decipher = crypto.createDecipheriv('aes-256-cbc', keys.decrypt, iv);
    const d2d = decode(Buffer.concat([decipher.update(body), decipher.final()]));
    if (int(d2d, 2) !== ++this.receiveSequence) throw new ProtocolError('out of sequence');
    return decode(bytes(d2d, 1) ?? Buffer.alloc(0));
  }

  private sendOffline(frame: Buffer): void {
    if (this.closed) return;
    const keys = this.keys;
    if (!keys || this.stage !== 'secure') return this.write(frame);
    const d2d = new Writer().bytes(1, frame).int(2, ++this.sendSequence).finish();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', keys.encrypt, iv);
    const body = Buffer.concat([cipher.update(d2d), cipher.final()]);
    const header = new Writer().int(1, 1).int(2, 2).bytes(5, iv).bytes(6, GCM_METADATA); // HMAC_SHA256, AES_256_CBC
    const headerAndBody = new Writer().bytes(1, header).bytes(2, body).finish();
    const signature = crypto.createHmac('sha256', keys.sendHmac).update(headerAndBody).digest();
    this.write(new Writer().bytes(1, headerAndBody).bytes(2, signature).finish());
  }

  /** A sharing frame, as a bytes payload in one chunk and an empty last one. */
  private sendSharing(frame: Buffer): void {
    const id = crypto.randomBytes(8).readBigInt64BE();
    const header = new Writer().int(1, id).int(2, PAYLOAD.bytes).int(3, frame.length).int(4, false);
    const chunk = (flags: number, offset: number, body?: Buffer) =>
      offlineFrame(
        FRAME.payloadTransfer,
        4,
        new Writer().int(1, PACKET.data).bytes(2, header).bytes(3, new Writer().int(1, flags).int(2, offset).bytes(3, body)),
      );
    this.sendOffline(chunk(0, 0, frame));
    this.sendOffline(chunk(LAST_CHUNK, frame.length));
  }

  // --- Frames once encrypted -----------------------------------------------

  private offline(frame: Fields): void {
    const v1 = message(frame, 2);
    if (!v1) return;
    switch (int(v1, 1)) {
      case FRAME.payloadTransfer:
        return this.payload(message(v1, 4) ?? new Map());
      case FRAME.keepAlive:
        if (int(message(v1, 6) ?? new Map(), 1) !== 1) {
          this.sendOffline(offlineFrame(FRAME.keepAlive, 6, new Writer().int(1, true)));
        }
        return;
      case FRAME.bandwidthUpgrade: {
        const event = int(message(v1, 5) ?? new Map(), 1);
        if (event === UPGRADE.lastWrite && this.upgrade === 'switching') {
          this.sendOffline(offlineFrame(FRAME.bandwidthUpgrade, 5, new Writer().int(1, UPGRADE.safeToClose)));
        } else if (event === UPGRADE.safeToClose && this.upgrade === 'switching') {
          this.switchChannel();
        } else if (event === UPGRADE.failure) {
          console.warn(`quickshare: ${this.device}: couldn't move to the faster channel; staying on this one`);
          this.upgrade = 'done';
        }
        return;
      }
      case FRAME.disconnection:
        return this.lost();
    }
  }

  private payload(transfer: Fields): void {
    const header = message(transfer, 2);
    const id = header && big(header, 1);
    if (!header || id === undefined) throw new ProtocolError('payload without an id');
    if (int(transfer, 1) === PACKET.control) {
      // The sender gave up on this payload.
      if (this.files.has(id) || this.text?.id === id) this.finish('cancelled');
      return;
    }
    const chunk = message(transfer, 3);
    if (!chunk) throw new ProtocolError('payload without a chunk');
    const offset = Number(big(chunk, 2) ?? 0n);
    const body = bytes(chunk, 3) ?? Buffer.alloc(0);
    const last = ((int(chunk, 1) ?? 0) & LAST_CHUNK) !== 0;
    const type = int(header, 2);
    if (type === PAYLOAD.bytes) {
      const total = Number(big(header, 3) ?? 0n);
      if (total > MAX_FRAME) throw new ProtocolError(`bytes payload of ${total}`);
      let buffer = this.buffers.get(id);
      if (!buffer) {
        if (this.buffers.size >= 8) throw new ProtocolError('too many payloads at once');
        buffer = { parts: [], size: 0 };
        this.buffers.set(id, buffer);
      }
      if (offset !== buffer.size || buffer.size + body.length > MAX_FRAME) throw new ProtocolError('bad bytes payload chunk');
      buffer.parts.push(body);
      buffer.size += body.length;
      if (this.text?.id === id) this.progress(body.length);
      if (!last) return;
      this.buffers.delete(id);
      const data = Buffer.concat(buffer.parts);
      if (this.text?.id === id) return this.textArrived(data);
      return this.sharingFrame(decode(data));
    }
    if (type === PAYLOAD.file) {
      const file = this.files.get(id);
      if (!file) throw new ProtocolError('unknown file payload');
      return this.fileChunk(file, offset, body, last);
    }
  }

  private sharingFrame(frame: Fields): void {
    const v1 = message(frame, 2);
    if (!v1) return;
    const type = int(v1, 1);
    if (type === SHARING.cancel) return this.finish('cancelled');
    if (this.sharing === 'paired-key' && type === SHARING.pairedKeyEncryption) {
      this.sendSharing(sharingFrame(SHARING.pairedKeyResult, 5, new Writer().int(1, 3))); // UNABLE
      this.sharing = 'paired-result';
    } else if (this.sharing === 'paired-result' && type === SHARING.pairedKeyResult) {
      this.sharing = 'introduction';
    } else if (this.sharing === 'introduction' && type === SHARING.introduction) {
      this.introduction(message(v1, 2) ?? new Map());
    }
  }

  private introduction(intro: Fields): void {
    const files = messages(intro, 1).map((f) => ({
      id: big(f, 3),
      name: safeFileName(str(f, 1) ?? ''),
      size: Number(big(f, 4) ?? -1n),
    }));
    const texts = messages(intro, 2);
    this.transfer = {
      id: this.id,
      device: this.device,
      deviceType: this.type,
      pin: this.pin,
      status: 'asking',
      offer: { files: files.map(({ name, size }) => ({ name, size: Math.max(0, size) })), text: null },
      files: [],
      failed: [],
      url: null,
      transferred: 0,
      total: 0,
      error: null,
      // No window to show it in: the desktop asks.
      background: leases.size === 0,
    };
    const unsupported = (why: string) => {
      this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.unsupported)));
      this.finish('failed', why);
    };

    if (files.length && !texts.length) {
      if (files.length > MAX_FILES) return unsupported('That’s too many files at once.');
      for (const file of files) {
        if (file.id === undefined || file.size < 0 || this.files.has(file.id)) throw new ProtocolError('bad file metadata');
        this.files.set(file.id, { name: file.name, size: file.size, path: null, stream: null, written: 0, whole: false, done: false });
      }
      this.transfer.total = files.reduce((sum, f) => sum + f.size, 0);
    } else if (texts.length === 1 && !files.length) {
      const text = texts[0];
      const id = big(text, 4);
      const size = Number(big(text, 5) ?? 0n);
      const kind = int(text, 3) === TEXT_TYPE.url ? 'url' : 'text';
      if (id === undefined || size < 0 || size > MAX_FRAME) throw new ProtocolError('bad text metadata');
      this.text = { id, kind, size, done: false };
      this.transfer.offer.text = { kind, title: cleanTitle(str(text, 2) ?? '') };
      this.transfer.total = size;
    } else if (messages(intro, 4).length) {
      return unsupported('Din can’t take Wi-Fi networks shared this way yet.');
    } else {
      return unsupported('Din can only take files, text and links.');
    }

    const downloads = app.getPath('downloads');
    const free = freeBytes(downloads) ?? freeBytes(path.dirname(downloads));
    if (free !== null && this.transfer.total + SPARE_BYTES > free) {
      this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.notEnoughSpace)));
      return this.finish('failed', 'There isn’t enough free space.');
    }

    this.sharing = 'asking';
    this.wait(ASK_MS, () => {
      this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.timedOut)));
      this.finish('failed', 'Nobody accepted it in time.');
    });
    void this.trusted.then((phone) => {
      if (this.sharing !== 'asking' || !this.transfer) return;
      if (!phone) return this.emit(true);
      // One of the user's phones, proven: it arrives under the name Settings gives it, without asking.
      this.device = phone.name;
      this.transfer.device = phone.name;
      this.respond(true);
    });
  }

  // --- Accepting, and what arrives -----------------------------------------

  respond(accept: boolean): void {
    if (this.sharing !== 'asking' || !this.transfer) return;
    if (!accept) {
      this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.reject)));
      return this.finish('declined');
    }
    try {
      const downloads = app.getPath('downloads');
      for (const file of this.files.values()) {
        file.path = claim(downloads, file.name);
        file.stream = fs.createWriteStream(file.path);
        file.stream.on('error', (e) => this.finish('failed', `Couldn’t save ${file.name}: ${e.message}`));
      }
    } catch (e) {
      this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.reject)));
      return this.finish('failed', `Couldn’t save it in Downloads: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.sharing = 'receiving';
    this.transfer.status = 'receiving';
    this.sendSharing(sharingFrame(SHARING.response, 3, new Writer().int(1, RESPONSE.accept)));
    this.wait(IDLE_MS, () => this.finish('failed', `${this.device} stopped sending.`));
    this.emit(true);
    this.allowUpgrade();
  }

  /** Stop the share, or the connection if it hasn't offered anything yet. */
  cancel(): void {
    if (this.sharing === 'receiving' || this.sharing === 'asking') {
      this.sendSharing(sharingFrame(SHARING.cancel));
      this.finish('cancelled');
    } else {
      this.close();
    }
  }

  private fileChunk(file: IncomingFile, offset: number, body: Buffer, last: boolean): void {
    if (this.sharing !== 'receiving' || !file.stream || file.whole) throw new ProtocolError('file payload not accepted');
    if (offset !== file.written || file.written + body.length > file.size) throw new ProtocolError('bad file chunk');
    if (body.length) {
      file.written += body.length;
      if (!file.stream.write(body)) {
        this.socket.pause();
        file.stream.once('drain', () => this.socket.resume());
      }
      this.progress(body.length);
    }
    if (!last) return;
    if (file.written !== file.size) throw new ProtocolError(`${file.name} ended short`);
    file.whole = true;
    const { stream } = file;
    file.stream = null;
    stream.end(() => {
      if (this.sharing !== 'receiving' || !this.transfer) return;
      file.done = true;
      this.transfer.files.push({ name: path.basename(file.path!), path: file.path! });
      this.checkDone();
    });
  }

  private textArrived(data: Buffer): void {
    const text = this.text;
    if (!text || !this.transfer || this.sharing !== 'receiving') throw new ProtocolError('text not accepted');
    const value = data.toString('utf8');
    if (text.kind === 'url') {
      this.transfer.url = value.trim();
      text.done = true;
      return this.checkDone();
    }
    let file: string | null = null;
    try {
      file = claim(app.getPath('downloads'), safeFileName(`Text from ${this.device}.txt`));
      fs.writeFileSync(file, value);
    } catch (e) {
      if (file) fs.rm(file, { force: true }, () => {});
      return this.finish('failed', `Couldn’t save it in Downloads: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.transfer.files.push({ name: path.basename(file), path: file });
    text.done = true;
    this.checkDone();
  }

  private progress(received: number): void {
    if (!this.transfer) return;
    this.transfer.transferred += received;
    this.wait(IDLE_MS, () => this.finish('failed', `${this.device} stopped sending.`));
    this.emit();
  }

  private checkDone(): void {
    if (this.sharing !== 'receiving') return;
    if ([...this.files.values()].some((f) => !f.done)) return;
    if (this.text && !this.text.done) return;
    this.finish('done');
  }

  // --- Ending --------------------------------------------------------------

  private wait(ms: number, then: () => void): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(then, ms);
  }

  private emit(now = false): void {
    if (!this.transfer || this.emitTimer) return;
    const wait = now ? 0 : Math.max(0, this.lastEmit + PROGRESS_MS - Date.now());
    const send = () => {
      this.emitTimer = null;
      if (!this.transfer || this.sharing === 'over') return;
      this.lastEmit = Date.now();
      deps.sendToShell('quickshare:transfer', { ...this.transfer });
    };
    if (wait === 0) send();
    else this.emitTimer = setTimeout(send, wait);
  }

  /** The share is over: say how it went, keep what arrived whole, and hang up. */
  private finish(status: QuickShareTransfer['status'], why: string | null = null): void {
    if (this.sharing === 'over') return;
    const wasReceiving = this.sharing === 'receiving';
    this.sharing = 'over';
    clearTimeout(this.timer ?? undefined);
    clearTimeout(this.emitTimer ?? undefined);
    for (const file of this.files.values()) {
      if (file.done) continue;
      file.stream?.destroy();
      file.stream = null;
      if (file.path) fs.rm(file.path, { force: true }, () => {});
      if (wasReceiving) this.transfer?.failed.push(file.name);
    }
    if (this.transfer) {
      // Whatever arrived before it ended is there to open.
      this.transfer.status = this.transfer.files.length || this.transfer.url ? 'done' : status;
      this.transfer.error = why;
      deps.sendToShell('quickshare:transfer', { ...this.transfer });
    }
    this.close();
  }

  private fail(e: unknown): void {
    if (this.closed) return;
    console.warn(`quickshare: ${this.device}: ${e instanceof Error ? e.message : String(e)}`);
    if (this.transfer && this.sharing !== 'over') this.finish('failed', `Something went wrong talking to ${this.device}.`);
    else this.close();
  }

  /** The other side hung up. */
  private lost(): void {
    if (this.closed) return;
    if (this.transfer && this.sharing === 'asking') this.finish('cancelled');
    else if (this.transfer && this.sharing === 'receiving') {
      // Some senders send nothing at all for an empty file, and hang up once the rest is sent.
      for (const file of this.files.values()) if (file.size === 0 && !file.whole) this.fileChunk(file, 0, Buffer.alloc(0), true);
      const whole = [...this.files.values()].every((f) => f.whole) && (!this.text || this.text.done);
      // What's still being written finishes on its own (checkDone).
      if (!whole) this.finish('failed', `The connection to ${this.device} was lost.`);
    }
    this.close();
  }

  /**
   * Hang up, saying so first once the channel is encrypted: a phone that
   * isn't told keeps the connection open on its side, and won't connect to
   * this computer over Bluetooth again until it gives up on it.
   */
  private close(): void {
    if (this.closed) return;
    if (this.stage === 'secure' && !this.saidGoodbye && !this.socket.destroyed) {
      this.saidGoodbye = true;
      this.sendOffline(offlineFrame(FRAME.disconnection, 7));
    }
    this.closed = true;
    clearTimeout(this.timer ?? undefined);
    connections.delete(this.id);
    this.upgradeSocket?.destroy();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.releaseHotspot?.();
    this.releaseHotspot = null;
    if (this.bluetooth) void apply();
  }
}

/** A preview of shared text, made safe to show on one line. */
function cleanTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const line = title.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

// ---------------------------------------------------------------------------
// Being visible: the server, the mDNS announcement and the Bluetooth one
// ---------------------------------------------------------------------------

/** Whether a window is receiving, so this computer is visible on the network. */
function receiving(): boolean {
  return leases.size > 0;
}

/** Whether this computer should be visible over Bluetooth: a window is receiving, or a phone's share sheet is open. */
function listening(): boolean {
  return receiving() || nearbyUntil > Date.now();
}

/** Whether the server should be up: devices may connect over the network, or phones move over to the hotspot. */
function serving(): boolean {
  return listening() || [...connections.values()].some((c) => c.bluetooth);
}

function state(): QuickShareState {
  const visible = (advertised && server !== null) || advertisingOverBluetooth();
  return { listening: receiving(), name: deviceName(), visible: listening() && visible, error: receiving() ? error : null };
}

function changed(): void {
  deps.sendToShell('quickshare:changed', state());
}

function track(connection: Connection): void {
  connections.set(connection.id, connection);
}

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((socket) => {
      if (connections.size >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
      }
      if (receiving()) return track(new Connection(socket));
      // Not visible on the network: only a phone moving over from Bluetooth, to the hotspot.
      if (![...connections.values()].some((c) => c.upgrade === 'offered')) {
        socket.destroy();
        return;
      }
      track(new Connection(socket, { upgradeOnly: true }));
    });
    s.once('error', reject);
    s.listen(port, () => {
      s.off('error', reject);
      s.on('error', (e) => console.error('quickshare: server error', e));
      resolve(s);
    });
  });
}

function avahiError(e: unknown): string {
  if (e instanceof DBusError) {
    if (e.type === 'org.freedesktop.DBus.Error.ServiceUnknown' || e.type === 'org.freedesktop.DBus.Error.NameHasNoOwner') {
      return 'This computer can’t announce itself on the network: Avahi isn’t running.';
    }
    if (e.type === 'org.freedesktop.Avahi.NotPermittedError') {
      return 'This computer can’t announce itself on the network: Avahi doesn’t allow publishing.';
    }
  }
  return `This computer can’t announce itself on the network: ${e instanceof Error ? e.message : String(e)}`;
}

async function systemBus(): Promise<DBusConnection> {
  if (avahiBus) return avahiBus;
  const bus = await DBusConnection.connect(SYSTEM_BUS);
  if (!bus) throw new Error('there’s no system bus.');
  avahiBus = bus;
  bus.onClose = () => {
    if (avahiBus !== bus) return;
    avahiBus = null;
    group = null;
    unwatchGroup = null;
    advertised = false;
    scanning = null;
    unwatchScan = null;
    changed();
    scheduleRetry();
    checkPhones();
  };
  // Avahi starting again (or for the first time) takes everything published with it.
  bus.subscribe({ sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' }, (m: Message) => {
    if (m.body[0] === BLUEZ) {
      // BlueZ starting again ends every search; start ours afresh.
      unwatchScan?.();
      unwatchScan = null;
      scanning = null;
      checkPhones();
      return;
    }
    if (m.body[0] !== AVAHI) return;
    unwatchGroup?.();
    unwatchGroup = null;
    group = null;
    advertised = false;
    if (m.body[2]) void apply();
    else {
      error = avahiError(new DBusError('org.freedesktop.DBus.Error.ServiceUnknown', ''));
      changed();
    }
  });
  return bus;
}

function scheduleRetry(): void {
  if (!receiving() || retry) return;
  retry = setTimeout(() => {
    retry = null;
    void apply();
  }, RETRY_MS);
}

async function publish(): Promise<void> {
  const bus = await systemBus();
  if (!group) {
    const [created] = await bus.call({ destination: AVAHI, path: '/', interface: AVAHI_SERVER, member: 'EntryGroupNew' });
    group = String(created);
    const path = group;
    unwatchGroup = bus.subscribe({ path, interface: AVAHI_GROUP, member: 'StateChanged' }, (m: Message) => {
      const groupState = Number(m.body[0]);
      if (groupState === 2) {
        advertised = true;
        error = null;
        changed();
      } else if (groupState === 3) {
        // Another device took this name: take another.
        endpointId = randomEndpointId();
        advertised = false;
        void apply(true);
      } else if (groupState === 4) {
        advertised = false;
        error = avahiError(new Error(String(m.body[1] || 'it failed.')));
        changed();
      }
    });
  }
  const name = Buffer.concat([Buffer.from([0x23]), endpointId, SERVICE_HASH, Buffer.from([0, 0])]).toString('base64url');
  const txt = [Buffer.from(`n=${endpointInfo().toString('base64url')}`)];
  await bus.call({ destination: AVAHI, path: group, interface: AVAHI_GROUP, member: 'Reset' });
  await bus.call({
    destination: AVAHI,
    path: group,
    interface: AVAHI_GROUP,
    member: 'AddService',
    signature: 'iiussssqaay',
    body: [-1, -1, 0, name, SERVICE_TYPE, '', '', listeningPort, txt],
  });
  await bus.call({ destination: AVAHI, path: group, interface: AVAHI_GROUP, member: 'Commit' });
}

async function withdraw(): Promise<void> {
  advertised = false;
  if (!avahiBus || !group) return;
  await avahiBus.call({ destination: AVAHI, path: group, interface: AVAHI_GROUP, member: 'Reset' }).catch(() => {});
}

/**
 * Bring the server and the announcements in line with whether a window is
 * receiving, a phone's share sheet is open, and shares over Bluetooth may
 * move to the hotspot; `again` announces anew.
 */
function apply(again = false): Promise<void> {
  applying = applying.then(async () => {
    advertiseOverBluetooth(listening() ? bleAdvertisement : null);
    if (!receiving()) {
      clearTimeout(retry ?? undefined);
      retry = null;
      await withdraw();
      error = null;
    }
    if (!serving()) {
      // Stops listening for new devices; shares already connected go on.
      server?.close();
      server = null;
      changed();
      return;
    }
    try {
      if (!server) {
        server = await listen(PORT).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EADDRINUSE') throw e;
          console.warn(`quickshare: port ${PORT} is taken; using another, which a firewall may block`);
          return listen(0);
        });
        listeningPort = (server.address() as net.AddressInfo).port;
      }
    } catch (e) {
      error = `Couldn’t listen for devices: ${e instanceof Error ? e.message : String(e)}`;
      changed();
      return;
    }
    if (!receiving()) {
      changed();
      return;
    }
    if (advertised && group && !again) return;
    try {
      await publish();
    } catch (e) {
      console.warn('quickshare: announcing failed', e);
      advertised = false;
      error = avahiError(e);
      scheduleRetry();
    }
    changed();
  });
  return applying;
}

/**
 * Be visible for as long as this window (an app's, or the desktop) is
 * there: until it closes, reloads or goes elsewhere, or calls stop.
 */
function receive(sender: { id: number }): Promise<QuickShareState> {
  if (!leases.has(sender.id)) {
    const contents = webContents.fromId(sender.id);
    if (!contents || contents.isDestroyed()) throw new Error('No such window.');
    const end = () => release(sender.id);
    const navigated = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) end();
    };
    contents.once('destroyed', end);
    contents.on('did-start-navigation', navigated);
    leases.set(sender.id, () => {
      contents.off('destroyed', end);
      contents.off('did-start-navigation', navigated);
    });
  }
  return apply().then(state);
}

function release(id: number): Promise<void> {
  const drop = leases.get(id);
  if (!drop) return applying;
  drop();
  leases.delete(id);
  // Closing the last window ends the shares it was showing, asking or arriving.
  if (leases.size === 0) for (const connection of [...connections.values()]) if (connection.windowed) connection.cancel();
  return apply();
}

// ---------------------------------------------------------------------------
// The user's phones opening their share sheet
// ---------------------------------------------------------------------------

function hasFastInit(serviceData: unknown): boolean {
  const map = unwrap(serviceData);
  return map instanceof Map && map.has(FAST_INIT_UUID);
}

/**
 * One of the user's phones opened its share sheet: be visible over
 * Bluetooth for a while, with the hotspot ready for the share to move to.
 */
function shareSheetOpened(): void {
  const wasVisible = listening();
  nearbyUntil = Date.now() + NEARBY_MS;
  nearbyHotspot ??= holdHotspot();
  clearTimeout(nearbyTimer ?? undefined);
  nearbyTimer = setTimeout(() => {
    nearbyTimer = null;
    nearbyHotspot?.();
    nearbyHotspot = null;
    void apply();
  }, NEARBY_MS + 100);
  if (!wasVisible) void apply();
}

/** A phone connected over Bluetooth (quickshare-bluetooth.mts). */
function bluetoothConnected(socket: net.Socket, peer: BluetoothPeer): void {
  if (!listening() || connections.size >= MAX_CONNECTIONS) {
    socket.destroy();
    return;
  }
  track(new Connection(socket, { bluetooth: peer }));
  // The server, for the hotspot it'll be offered.
  void apply();
}

async function startScan(): Promise<void> {
  const bus = await systemBus();
  const [objects] = (await bus.call({ destination: BLUEZ, path: '/', interface: 'org.freedesktop.DBus.ObjectManager', member: 'GetManagedObjects' })) as [
    Map<string, Map<string, Map<string, unknown>>>,
  ];
  const adapter = [...objects].find(([, ifaces]) => unwrap(ifaces.get(ADAPTER)?.get('Powered')) === true)?.[0];
  if (!adapter) return;
  const [owner] = await bus.bus('GetNameOwner', 's', [BLUEZ]);
  const subscriptions = [
    bus.subscribe({ sender: String(owner), interface: 'org.freedesktop.DBus.ObjectManager', member: 'InterfacesAdded' }, (m: Message) => {
      const ifaces = m.body[1] as Map<string, Map<string, unknown>>;
      if (hasFastInit(ifaces.get(DEVICE)?.get('ServiceData'))) shareSheetOpened();
    }),
    bus.subscribe({ sender: String(owner), interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' }, (m: Message) => {
      if (m.body[0] === DEVICE && hasFastInit((m.body[1] as Map<string, unknown>).get('ServiceData'))) shareSheetOpened();
    }),
  ];
  unwatchScan = () => subscriptions.forEach((unsubscribe) => unsubscribe());
  // This connection's own search, with its own filter: BlueZ merges it with
  // Settings' searches, and stops it alone. Not by UUID: BlueZ matches that
  // against advertised services, and the beacon has its UUID only as
  // service data, so it would never get through. Close by instead: the phone
  // is in the user's hand, and devices further off stay out of Settings'
  // list of devices nearby.
  const filter = new Map<string, Variant>([
    ['Transport', new Variant('s', 'le')],
    ['DuplicateData', new Variant('b', true)],
    ['RSSI', new Variant('n', NEARBY_RSSI)],
  ]);
  await bus.call({ destination: BLUEZ, path: adapter, interface: ADAPTER, member: 'SetDiscoveryFilter', signature: 'a{sv}', body: [filter] });
  await bus.call({ destination: BLUEZ, path: adapter, interface: ADAPTER, member: 'StartDiscovery' }).catch((e: unknown) => {
    if (!(e instanceof DBusError && e.type === 'org.bluez.Error.InProgress')) throw e;
  });
  scanning = adapter;
}

async function stopScan(): Promise<void> {
  const adapter = scanning;
  scanning = null;
  unwatchScan?.();
  unwatchScan = null;
  if (adapter && avahiBus) await avahiBus.call({ destination: BLUEZ, path: adapter, interface: ADAPTER, member: 'StopDiscovery' }).catch(() => {});
}

let checkTimer: NodeJS.Timeout | null = null;

/** Listen for share sheets while one of the user's phones may send and is connected; not otherwise. */
function checkPhones(): void {
  if (checkTimer) return;
  checkTimer = setTimeout(() => {
    checkTimer = null;
    checkingPhones = checkingPhones.then(async () => {
      const phones = await connectedFilePhones().catch(() => []);
      try {
        if (phones.length && !scanning) await startScan();
        else if (!phones.length && scanning) await stopScan();
      } catch (e) {
        console.warn('quickshare: listening for share sheets failed', e);
        await stopScan();
      }
    });
  }, 500);
}

function transferArg(id: unknown): Connection {
  const connection = typeof id === 'string' ? connections.get(id) : undefined;
  if (!connection) throw new Error('That share is over.');
  return connection;
}

export function registerQuickShareHandlers(options: Deps): void {
  deps = options;
  const handle = (channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      options.assertShellSender(event);
      return fn(event, ...args);
    });
  };
  handle('quickshare:state', () => state());
  handle('quickshare:receive', (event) => receive(event.sender));
  handle('quickshare:stop', (event) => release(event.sender.id));
  handle('quickshare:respond', (_event, id, accept) => transferArg(id).respond(accept === true));
  handle('quickshare:cancel', (_event, id) => transferArg(id).cancel());

  onBluetooth(bluetoothConnected, changed);
  onPhonesChanged(checkPhones);
  // A phone connecting or going, Bluetooth turned on or off, BlueZ starting again.
  onBluetoothChanged(() => {
    checkPhones();
    bluetoothMayWork();
  });
  checkPhones();
  app.on('will-quit', () => {
    quitBluetooth();
    quitHotspot();
  });
}
