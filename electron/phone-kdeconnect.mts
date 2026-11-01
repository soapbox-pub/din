// Android phones, for Messages (phone.mts): KDE Connect's protocol, spoken
// here to the free KDE Connect app on the phone, on the same network.
//
// Why not KDE's own kdeconnectd: it brings Qt and KDE's libraries and wants a
// desktop session (a tray, KDE's notifications) din-shell doesn't provide;
// what Messages needs of the protocol is small.
//
// The protocol (version 7): each side announces itself with an identity
// packet, broadcast over UDP to port 1716. Whoever hears an announcement opens
// a TCP connection to the port it names and sends its own identity in the
// clear; then the connection becomes TLS, the side that opened it acting as
// the TLS server. Both sides use self-signed certificates: this computer's is
// made once (CN = its device id, as the app expects) and kept with its key in
// userData/phone/kdeconnect.json, the key sealed by safeStorage. Pairing is
// trust on first use, confirmed by the user on both screens with a key both
// show (a hash of the two public keys); after that a phone is known by its
// certificate, and a connection whose certificate doesn't match is dropped.
// Packets are JSON, one per line.
//
// Din listens only while an Android phone is paired (to reconnect) or
// Settings → Phone is looking for one, and takes pairing requests only
// while it's looking, so a stranger on the network can't put one on screen.
//
// What Messages uses: the SMS plugin's conversations, threads and sending,
// with pictures as the thumbnails the phone sends along; the contacts
// plugin's vCards; and the battery. Full-size pictures (a payload transfer)
// aren't fetched.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { app, safeStorage } from 'electron';
import { parseVCards } from './phone-vcard.mts';
import type { BackendMessage, PhoneConnection, PhoneHooks } from './phone.mts';
import type { PhoneCandidate, PhonePairing } from '../src/lib/phone.ts';

const UDP_PORT = 1716;
const TCP_MIN = 1716;
const TCP_MAX = 1764;
const PROTOCOL_VERSION = 7;
/** Announce while Settings looks for phones, this often. */
const DISCOVER_ANNOUNCE_MS = 5_000;
/** Announce while a paired phone is away, this often, so it connects when it's back. */
const AWAY_ANNOUNCE_MS = 60_000;
/** A phone heard announcing is listed for this long. */
const SEEN_MS = 30_000;
const PAIR_TIMEOUT_MS = 30_000;
/** The most a packet may be (a phone's contacts can be big). */
const MAX_PACKET = 64 * 1024 * 1024;
const MAX_THUMBNAIL = 512 * 1024;
const THREAD_COUNT = 100;

const INCOMING = [
  'kdeconnect.sms.messages',
  'kdeconnect.contacts.response_uids_timestamps',
  'kdeconnect.contacts.response_vcards',
  'kdeconnect.battery',
];
const OUTGOING = [
  'kdeconnect.sms.request',
  'kdeconnect.sms.request_conversations',
  'kdeconnect.sms.request_conversation',
  'kdeconnect.contacts.request_all_uids_timestamps',
  'kdeconnect.contacts.request_vcards_by_uid',
];

interface Packet {
  id: number;
  type: string;
  body: Record<string, unknown>;
}

interface Identity {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  protocolVersion: number;
  tcpPort?: number;
}

const DEVICE_ID = /^[a-zA-Z0-9_-]{16,64}$/;

// ---------------------------------------------------------------------------
// This computer's certificate
// ---------------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => der(0x31, Buffer.concat(parts));

function integer(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1);
  return der(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${s}Z`, 'ascii'));
}

/** A self-signed certificate (PEM) for a key, as KDE Connect makes them. */
function selfSigned(privateKey: crypto.KeyObject, deviceId: string): string {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const name = seq(
    set(seq(oid('2.5.4.10'), der(0x0c, Buffer.from('KDE')))),
    set(seq(oid('2.5.4.11'), der(0x0c, Buffer.from('KDE Connect')))),
    set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(deviceId)))),
  );
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const now = Date.now();
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    algorithm,
    name,
    seq(utcTime(new Date(now - 365 * 86_400_000)), utcTime(new Date(now + 10 * 365 * 86_400_000))),
    name,
    spki,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = cert.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

interface Self {
  deviceId: string;
  key: string;
  cert: string;
}

function loadSelf(): Self {
  const file = path.join(app.getPath('userData'), 'phone', 'kdeconnect.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { deviceId: string; key: string; cert: string };
    const key = saved.key.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(saved.key.slice(4), 'base64'))
      : Buffer.from(saved.key.replace(/^plain:/, ''), 'base64').toString('utf8');
    if (DEVICE_ID.test(saved.deviceId) && key.includes('PRIVATE KEY')) return { deviceId: saved.deviceId, key, cert: saved.cert };
  } catch {
    // Made below.
  }
  const deviceId = crypto.randomUUID().replace(/-/g, '_');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const cert = selfSigned(privateKey, deviceId);
  const sealed = safeStorage.isEncryptionAvailable()
    ? `enc:${safeStorage.encryptString(key).toString('base64')}`
    : `plain:${Buffer.from(key, 'utf8').toString('base64')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ deviceId, key: sealed, cert }, null, 2), { mode: 0o600 });
  return { deviceId, key, cert };
}

function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function derToPem(cert: Buffer): string {
  const lines = cert.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** The key both screens show while pairing: a hash of the two public keys, bigger first. */
function verificationKey(ownCertPem: string, peerCert: Buffer): string {
  const spki = (cert: Buffer) => new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  let a = spki(pemToDer(ownCertPem));
  let b = spki(peerCert);
  if (Buffer.compare(a, b) < 0) [a, b] = [b, a];
  return crypto.createHash('sha256').update(a).update(b).digest('hex').slice(0, 8).toUpperCase();
}

// ---------------------------------------------------------------------------
// Links: one TLS connection to a phone
// ---------------------------------------------------------------------------

class Link {
  identity: Identity;
  cert: Buffer;
  socket: tls.TLSSocket;
  onPacket: (packet: Packet) => void = () => {};
  onClose: () => void = () => {};
  private buffer = '';
  private closed = false;

  constructor(socket: tls.TLSSocket, identity: Identity, cert: Buffer) {
    this.socket = socket;
    this.identity = identity;
    this.cert = cert;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (chunk: string) => this.ingest(chunk));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }

  send(type: string, body: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.socket.write(`${JSON.stringify({ id: Date.now(), type, body })}\n`);
  }

  close(): void {
    this.socket.destroy();
    this.end();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PACKET) return this.close();
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const packet = parsePacket(line);
      if (packet) this.onPacket(packet);
    }
  }
}

function parsePacket(line: string): Packet | null {
  try {
    const p = JSON.parse(line) as Partial<Packet>;
    if (typeof p.type !== 'string' || typeof p.body !== 'object' || p.body === null) return null;
    return { id: Number(p.id) || 0, type: p.type, body: p.body };
  } catch {
    return null;
  }
}

function parseIdentity(packet: Packet | null): Identity | null {
  if (!packet || packet.type !== 'kdeconnect.identity') return null;
  const b = packet.body;
  if (typeof b.deviceId !== 'string' || !DEVICE_ID.test(b.deviceId)) return null;
  return {
    deviceId: b.deviceId,
    deviceName: typeof b.deviceName === 'string' ? b.deviceName.slice(0, 64) : 'Android phone',
    deviceType: typeof b.deviceType === 'string' ? b.deviceType : 'phone',
    protocolVersion: Number(b.protocolVersion) || 0,
    tcpPort: Number.isInteger(b.tcpPort) ? (b.tcpPort as number) : undefined,
  };
}

// ---------------------------------------------------------------------------
// A paired phone
// ---------------------------------------------------------------------------

interface SmsMessage {
  _id?: unknown;
  thread_id?: unknown;
  body?: unknown;
  date?: unknown;
  type?: unknown;
  read?: unknown;
  addresses?: unknown;
  attachments?: unknown;
}

class KdePhone implements PhoneConnection {
  deviceId: string;
  cert: Buffer;
  link: Link | null = null;
  private hooks: PhoneHooks;
  private service: KdeConnect;
  private stopped = false;

  constructor(service: KdeConnect, deviceId: string, certPem: string, hooks: PhoneHooks) {
    this.service = service;
    this.deviceId = deviceId;
    this.cert = pemToDer(certPem);
    this.hooks = hooks;
    hooks.status({ status: 'offline' });
  }

  attach(link: Link): void {
    if (this.stopped) return link.close();
    this.link?.close();
    this.link = link;
    link.onPacket = (packet) => this.handle(packet);
    link.onClose = () => {
      if (this.link !== link) return;
      this.link = null;
      this.hooks.status({ status: 'offline' });
      this.service.awayChanged();
    };
    this.hooks.status({ status: 'connected', error: null });
    this.service.awayChanged();
    this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.link?.close();
    this.link = null;
    this.service.drop(this.deviceId);
  }

  refresh(): void {
    if (!this.link) {
      this.service.announce();
      return;
    }
    this.link.send('kdeconnect.sms.request_conversations');
    this.link.send('kdeconnect.contacts.request_all_uids_timestamps');
  }

  loadThread(threadId: string): void {
    const id = Number(threadId);
    if (!Number.isFinite(id)) return;
    this.link?.send('kdeconnect.sms.request_conversation', { threadID: id, numberToRequest: THREAD_COUNT });
  }

  async send(addresses: string[], body: string): Promise<void> {
    if (!this.link) throw new Error('The phone isn’t connected.');
    this.link.send('kdeconnect.sms.request', {
      version: 2,
      addresses: addresses.map((address) => ({ address })),
      messageBody: body,
      // For older versions of the app.
      phoneNumber: addresses[0],
    });
  }

  private handle(packet: Packet): void {
    const b = packet.body;
    switch (packet.type) {
      case 'kdeconnect.pair':
        // Already paired with this certificate: say yes again; a no is the phone forgetting this computer.
        if (b.pair === true) this.link?.send('kdeconnect.pair', { pair: true });
        else this.service.forgotten(this.deviceId);
        return;
      case 'kdeconnect.battery':
        this.hooks.status({
          battery: Number.isFinite(Number(b.currentCharge)) ? Math.max(0, Math.min(100, Number(b.currentCharge))) : null,
          charging: typeof b.isCharging === 'boolean' ? b.isCharging : null,
        });
        return;
      case 'kdeconnect.sms.messages':
        if (Array.isArray(b.messages)) this.hooks.messages(b.messages.map((m) => toMessage(m as SmsMessage)).filter((m): m is BackendMessage => m !== null));
        return;
      case 'kdeconnect.contacts.response_uids_timestamps': {
        const uids = Array.isArray(b.uids) ? b.uids.filter((u): u is string => typeof u === 'string') : [];
        if (uids.length) this.link?.send('kdeconnect.contacts.request_vcards_by_uid', { uids });
        return;
      }
      case 'kdeconnect.contacts.response_vcards': {
        const uids = Array.isArray(b.uids) ? b.uids.filter((u): u is string => typeof u === 'string') : [];
        const text = uids.map((uid) => (typeof b[uid] === 'string' ? (b[uid] as string) : '')).join('\n');
        const contacts = parseVCards(text);
        if (contacts.length) this.hooks.contacts(contacts);
        return;
      }
    }
  }
}

function toMessage(m: SmsMessage): BackendMessage | null {
  const thread = m.thread_id;
  if (thread === undefined || thread === null) return null;
  const type = Number(m.type);
  const outgoing = type !== 1 && type !== 0;
  const addresses = Array.isArray(m.addresses)
    ? m.addresses.map((a) => (typeof a?.address === 'string' ? (a.address as string) : '')).filter(Boolean).slice(0, 50)
    : [];
  const time = Number(m.date) || Date.now();
  const images = Array.isArray(m.attachments)
    ? m.attachments
        .filter((a) => typeof a?.mime_type === 'string' && a.mime_type.startsWith('image/') && typeof a.encoded_thumbnail === 'string' && a.encoded_thumbnail.length < MAX_THUMBNAIL)
        .slice(0, 8)
        .map((a) => `data:image/jpeg;base64,${(a.encoded_thumbnail as string).replace(/[^A-Za-z0-9+/=]/g, '')}`)
    : [];
  return {
    id: `kde:${String(m._id)}:${time}`,
    threadId: String(thread),
    addresses,
    sender: outgoing ? null : addresses[0] ?? null,
    body: typeof m.body === 'string' ? m.body : '',
    time,
    outgoing,
    read: outgoing || Number(m.read) === 1,
    status: !outgoing ? null : type === 5 ? 'failed' : type === 4 || type === 6 ? 'sending' : 'sent',
    images,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

interface ServiceHooks {
  changed(): void;
  paired(deviceId: string, name: string, cert: string): void;
  unpaired(deviceId: string): void;
}

interface Pending {
  link: Link;
  pairing: PhonePairing;
  timer: NodeJS.Timeout;
}

export class KdeConnect {
  private hooks: ServiceHooks;
  private self: Self | null = null;
  private udp: dgram.Socket | null = null;
  private server: net.Server | null = null;
  private tcpPort = 0;
  private error: string | null = null;
  private active = false;
  private discovering = false;
  private announceTimer: NodeJS.Timeout | null = null;
  private phones = new Map<string, KdePhone>();
  /** Links to phones that aren't paired, while looking for them. */
  private strangers = new Map<string, Link>();
  /** Phones heard announcing: when, and what they're called. */
  private seen = new Map<string, { name: string; at: number }>();
  private pending: Pending | null = null;

  constructor(hooks: ServiceHooks) {
    this.hooks = hooks;
  }

  static phoneId(deviceId: string): string {
    return `kde-${deviceId}`;
  }

  /** What phones see this computer as. */
  static deviceName(): string {
    const name = os.hostname().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 32).trim();
    return name || 'Din';
  }

  network(): { listening: boolean; error: string | null } {
    return { listening: !!this.server, error: this.error };
  }

  candidates(): PhoneCandidate[] {
    if (!this.discovering) return [];
    const now = Date.now();
    const list = new Map<string, PhoneCandidate>();
    for (const [deviceId, s] of this.seen) {
      if (now - s.at < SEEN_MS && !this.phones.has(deviceId)) list.set(deviceId, { id: KdeConnect.phoneId(deviceId), kind: 'kdeconnect', name: s.name });
    }
    for (const [deviceId, link] of this.strangers) {
      list.set(deviceId, { id: KdeConnect.phoneId(deviceId), kind: 'kdeconnect', name: link.identity.deviceName });
    }
    return [...list.values()];
  }

  pairing(): PhonePairing | null {
    return this.pending?.pairing ?? null;
  }

  connection(deviceId: string, certPem: string, hooks: PhoneHooks): PhoneConnection {
    const phone = new KdePhone(this, deviceId, certPem, hooks);
    this.phones.set(deviceId, phone);
    // A link that came up while pairing carries on as the phone's.
    const stranger = this.strangers.get(deviceId);
    if (stranger && stranger.cert.equals(phone.cert)) {
      this.strangers.delete(deviceId);
      phone.attach(stranger);
    }
    return phone;
  }

  drop(deviceId: string): void {
    this.phones.delete(deviceId);
  }

  setActive(on: boolean): void {
    this.active = on;
    this.sync();
  }

  setDiscovering(on: boolean): void {
    this.discovering = on;
    if (!on) {
      for (const link of this.strangers.values()) link.close();
      this.strangers.clear();
      if (this.pending) this.endPairing();
    }
    this.sync();
    this.hooks.changed();
  }

  async pair(candidateId: string): Promise<void> {
    const deviceId = candidateId.replace(/^kde-/, '');
    let link = this.strangers.get(deviceId);
    if (!link) {
      this.announce();
      link = await new Promise<Link | undefined>((resolve) => {
        let tries = 0;
        const check = setInterval(() => {
          const found = this.strangers.get(deviceId);
          if (found || ++tries > 20) {
            clearInterval(check);
            resolve(found);
          }
        }, 250);
      });
    }
    if (!link || !this.self) throw new Error('The phone didn’t answer. Make sure KDE Connect is open on it, on the same network.');
    link.send('kdeconnect.pair', { pair: true });
    this.startPairing(link, false);
  }

  answer(id: string, accept: boolean): void {
    const pending = this.pending;
    if (!pending || pending.pairing.id !== id) return;
    if (accept) {
      pending.link.send('kdeconnect.pair', { pair: true });
      this.finishPairing(pending.link);
    } else {
      pending.link.send('kdeconnect.pair', { pair: false });
      this.endPairing();
    }
  }

  unpair(deviceId: string): void {
    const phone = this.phones.get(deviceId);
    phone?.link?.send('kdeconnect.pair', { pair: false });
    phone?.stop();
  }

  forgotten(deviceId: string): void {
    this.hooks.unpaired(deviceId);
  }

  /** Whether a paired phone is away, which changes how often to announce. */
  awayChanged(): void {
    this.scheduleAnnounce();
  }

  /** Tell the network this computer is here. */
  announce(): void {
    const udp = this.udp;
    if (!udp || !this.self) return;
    const packet = Buffer.from(`${JSON.stringify(this.identityPacket())}\n`);
    const targets = new Set(['255.255.255.255']);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const a of addresses ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        targets.add(ip.map((octet, i) => (octet | (~mask[i] & 0xff)) & 0xff).join('.'));
      }
    }
    for (const target of targets) udp.send(packet, UDP_PORT, target, () => {});
  }

  private identityPacket(): Packet {
    return {
      id: Date.now(),
      type: 'kdeconnect.identity',
      body: {
        deviceId: this.self?.deviceId,
        deviceName: KdeConnect.deviceName(),
        deviceType: 'desktop',
        protocolVersion: PROTOCOL_VERSION,
        incomingCapabilities: INCOMING,
        outgoingCapabilities: OUTGOING,
        tcpPort: this.tcpPort,
      },
    };
  }

  private sync(): void {
    const want = this.active || this.discovering;
    if (want && !this.server) void this.listen();
    else if (!want && this.server) this.shutdown();
    this.scheduleAnnounce();
  }

  private scheduleAnnounce(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (!this.server) return;
    const away = [...this.phones.values()].some((p) => !p.link);
    const every = this.discovering ? DISCOVER_ANNOUNCE_MS : away ? AWAY_ANNOUNCE_MS : 0;
    if (every) this.announceTimer = setInterval(() => this.announce(), every);
  }

  private async listen(): Promise<void> {
    try {
      this.self ??= loadSelf();
    } catch (error) {
      this.error = `Couldn’t make this computer’s certificate: ${error instanceof Error ? error.message : String(error)}`;
      this.hooks.changed();
      return;
    }
    const server = net.createServer((socket) => this.incoming(socket));
    let port = TCP_MIN;
    for (; port <= TCP_MAX; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, () => resolve(true));
      });
      if (ok) break;
    }
    if (port > TCP_MAX) {
      this.error = 'Every port KDE Connect uses is taken. Is KDE Connect itself running on this computer?';
      this.hooks.changed();
      return;
    }
    if (!(this.active || this.discovering)) {
      server.close();
      return;
    }
    this.server = server;
    this.tcpPort = port;
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (data, from) => this.heard(data, from));
    udp.on('error', () => {});
    await new Promise<void>((resolve) => {
      udp.once('error', () => {
        this.error = 'Couldn’t listen for phones on the network (port 1716 is taken).';
        resolve();
      });
      udp.bind(UDP_PORT, () => {
        udp.setBroadcast(true);
        this.error = null;
        resolve();
      });
    });
    this.udp = udp;
    this.hooks.changed();
    this.scheduleAnnounce();
    this.announce();
  }

  private shutdown(): void {
    this.server?.close();
    this.server = null;
    this.udp?.close();
    this.udp = null;
    for (const phone of this.phones.values()) phone.link?.close();
    for (const link of this.strangers.values()) link.close();
    this.strangers.clear();
    this.hooks.changed();
  }

  /** A phone announced itself: connect to it, if it's one of ours or we're looking. */
  private heard(data: Buffer, from: dgram.RemoteInfo): void {
    const identity = parseIdentity(parsePacket(data.toString('utf8').trim()));
    if (!identity || identity.deviceId === this.self?.deviceId || !identity.tcpPort) return;
    const phone = this.phones.get(identity.deviceId);
    if (!phone && !this.discovering) return;
    this.seen.set(identity.deviceId, { name: identity.deviceName, at: Date.now() });
    if (phone?.link || this.strangers.has(identity.deviceId)) return;
    if (!phone) this.hooks.changed();
    const socket = net.connect(identity.tcpPort, from.address);
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.write(`${JSON.stringify(this.identityPacket())}\n`);
      // Who opened the connection is the TLS server.
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        requestCert: true,
        rejectUnauthorized: false,
        secureContext: tls.createSecureContext({ key: this.self?.key, cert: this.self?.cert }),
      });
      secure.on('error', () => secure.destroy());
      secure.once('secure', () => this.secured(secure, identity));
    });
  }

  /** A phone that heard us connected: read its identity, then start TLS as the client. */
  private incoming(socket: net.Socket): void {
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let text = '';
    const onData = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.length > 64 * 1024) return socket.destroy();
      const nl = text.indexOf('\n');
      if (nl < 0) return;
      socket.removeListener('data', onData);
      socket.pause();
      const identity = parseIdentity(parsePacket(text.slice(0, nl)));
      if (!identity || identity.deviceId === this.self?.deviceId || (!this.phones.has(identity.deviceId) && !this.discovering)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(0);
      const secure = tls.connect({
        socket,
        key: this.self?.key,
        cert: this.self?.cert,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      secure.on('error', () => secure.destroy());
      secure.once('secureConnect', () => this.secured(secure, identity));
    };
    socket.on('data', onData);
  }

  /** TLS is up: a known phone's certificate must match; a stranger may only pair. */
  private secured(socket: tls.TLSSocket, identity: Identity): void {
    const raw = socket.getPeerCertificate(true)?.raw;
    if (!raw?.length) return void socket.destroy();
    const link = new Link(socket, identity, Buffer.from(raw));
    const phone = this.phones.get(identity.deviceId);
    if (phone) {
      if (!phone.cert.equals(link.cert)) return link.close();
      phone.attach(link);
      return;
    }
    if (!this.discovering) return link.close();
    this.strangers.get(identity.deviceId)?.close();
    this.strangers.set(identity.deviceId, link);
    link.onClose = () => {
      if (this.strangers.get(identity.deviceId) === link) this.strangers.delete(identity.deviceId);
      if (this.pending?.link === link) this.endPairing();
      this.hooks.changed();
    };
    link.onPacket = (packet) => {
      if (packet.type !== 'kdeconnect.pair') return;
      const pending = this.pending?.link === link ? this.pending : null;
      if (packet.body.pair === true) {
        // The answer to ours, or the phone asking.
        if (pending && !pending.pairing.incoming) this.finishPairing(link);
        else if (!pending) this.startPairing(link, true);
      } else if (pending) {
        this.endPairing();
      }
    };
    this.hooks.changed();
  }

  private startPairing(link: Link, incoming: boolean): void {
    if (!this.self) return;
    if (this.pending) this.endPairing();
    const pairing: PhonePairing = {
      id: KdeConnect.phoneId(link.identity.deviceId),
      name: link.identity.deviceName,
      key: verificationKey(this.self.cert, link.cert),
      incoming,
    };
    this.pending = {
      link,
      pairing,
      timer: setTimeout(() => {
        if (this.pending?.link !== link) return;
        link.send('kdeconnect.pair', { pair: false });
        this.endPairing();
      }, PAIR_TIMEOUT_MS),
    };
    this.hooks.changed();
  }

  private finishPairing(link: Link): void {
    this.endPairing();
    this.hooks.paired(link.identity.deviceId, link.identity.deviceName, derToPem(link.cert));
  }

  private endPairing(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.hooks.changed();
  }
}
