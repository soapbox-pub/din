// A minimal D-Bus client, spoken over the wire.
//
// The tray (tray.mts) hosts StatusNotifierItems, which live on the session
// bus: it owns org.kde.StatusNotifierWatcher, calls into the apps' items and
// menus, and listens for their signals. This is the connection it does that
// on: SASL EXTERNAL auth, the little-endian message format, method calls with
// promised replies, signal subscriptions, and objects of its own that answer
// method calls.
//
// Why raw protocol instead of a library: the same reasons as x11.mts - no
// dependency to vendor or pin in the Nix build, and the surface the tray
// needs is small. Unix fd passing isn't supported (nothing here needs it).
//
// Values: integers are numbers (64-bit ones too: nothing here comes close
// to 2^53), `ay` is a Buffer, structs are arrays, dicts are Maps, and
// variants are Variant objects (see `unwrap`).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import net from 'node:net';
import os from 'node:os';

/** A value with its signature, as a `v` carries it. */
export class Variant {
  signature: string;
  value: unknown;
  constructor(signature: string, value: unknown) {
    this.signature = signature;
    this.value = value;
  }
}

/** A variant's value (variants of variants included); anything else as is. */
export function unwrap(value: unknown): unknown {
  while (value instanceof Variant) value = value.value;
  return value;
}

/** An error reply. */
export class DBusError extends Error {
  type: string;
  constructor(type: string, message: string) {
    super(message || type);
    this.type = type;
  }
}

/** Message types. */
const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;

/** Header flags. */
const NO_REPLY_EXPECTED = 1;

/** Header field codes. */
const FIELD_PATH = 1;
const FIELD_INTERFACE = 2;
const FIELD_MEMBER = 3;
const FIELD_ERROR_NAME = 4;
const FIELD_REPLY_SERIAL = 5;
const FIELD_DESTINATION = 6;
const FIELD_SENDER = 7;
const FIELD_SIGNATURE = 8;

/** The protocol's limit on a message; anything claiming more is garbage. */
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

/** How long a method call waits for its reply. */
const CALL_TIMEOUT_MS = 10_000;

/** A decoded message. */
export interface Message {
  type: number;
  flags: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: unknown[];
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** The length of the single complete type at `start` in a signature. */
function typeLength(signature: string, start: number): number {
  const c = signature[start];
  if (c === 'a') return 1 + typeLength(signature, start + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let i = start + 1;
    while (signature[i] !== close) {
      if (i >= signature.length) throw new Error(`Bad signature: ${signature}`);
      i += typeLength(signature, i);
    }
    return i - start + 1;
  }
  if (!c || !'ybnqiuxtdsogvh'.includes(c)) throw new Error(`Bad signature: ${signature}`);
  return 1;
}

/** Split a signature into its complete types. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  for (let i = 0; i < signature.length; ) {
    const length = typeLength(signature, i);
    types.push(signature.slice(i, i + length));
    i += length;
  }
  return types;
}

function alignmentOf(type: string): number {
  switch (type[0]) {
    case 'y': case 'g': case 'v':
      return 1;
    case 'n': case 'q':
      return 2;
    case 'x': case 't': case 'd': case '(': case '{':
      return 8;
    default:
      return 4;
  }
}

// ---------------------------------------------------------------------------
// Marshalling
// ---------------------------------------------------------------------------

class Writer {
  buffer = Buffer.alloc(256);
  offset = 0;

  private reserve(n: number): void {
    if (this.offset + n <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.offset + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }

  align(n: number): void {
    const padding = (n - (this.offset % n)) % n;
    this.reserve(padding);
    this.buffer.fill(0, this.offset, this.offset + padding);
    this.offset += padding;
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.buffer.set(data, this.offset);
    this.offset += data.length;
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer.writeUInt8(value & 0xff, this.offset);
    this.offset += 1;
  }

  u32(value: number): void {
    this.align(4);
    this.reserve(4);
    this.buffer.writeUInt32LE(value >>> 0, this.offset);
    this.offset += 4;
  }

  /** Write one value of a complete type. */
  write(type: string, value: unknown): void {
    const c = type[0];
    switch (c) {
      case 'y':
        return this.u8(Number(value));
      case 'b':
        return this.u32(value ? 1 : 0);
      case 'n': case 'q': {
        this.align(2);
        this.reserve(2);
        if (c === 'n') this.buffer.writeInt16LE(Number(value), this.offset);
        else this.buffer.writeUInt16LE(Number(value), this.offset);
        this.offset += 2;
        return;
      }
      case 'i': case 'h': {
        this.align(4);
        this.reserve(4);
        this.buffer.writeInt32LE(Number(value) | 0, this.offset);
        this.offset += 4;
        return;
      }
      case 'u':
        return this.u32(Number(value));
      case 'x': case 't': {
        this.align(8);
        this.reserve(8);
        if (c === 'x') this.buffer.writeBigInt64LE(BigInt(Math.trunc(Number(value))), this.offset);
        else this.buffer.writeBigUInt64LE(BigInt(Math.trunc(Number(value))), this.offset);
        this.offset += 8;
        return;
      }
      case 'd': {
        this.align(8);
        this.reserve(8);
        this.buffer.writeDoubleLE(Number(value), this.offset);
        this.offset += 8;
        return;
      }
      case 's': case 'o': {
        const data = Buffer.from(String(value), 'utf8');
        this.u32(data.length);
        this.bytes(data);
        return this.u8(0);
      }
      case 'g': {
        const data = Buffer.from(String(value), 'utf8');
        this.u8(data.length);
        this.bytes(data);
        return this.u8(0);
      }
      case 'v': {
        if (!(value instanceof Variant)) throw new Error('A variant needs a Variant');
        this.write('g', value.signature);
        return this.write(value.signature, value.value);
      }
      case '(': {
        this.align(8);
        const fields = splitSignature(type.slice(1, -1));
        const values = value as unknown[];
        fields.forEach((field, i) => this.write(field, values[i]));
        return;
      }
      case 'a': {
        const element = type.slice(1);
        this.u32(0);
        const lengthAt = this.offset - 4;
        // Padding to the first element doesn't count toward the length.
        this.align(alignmentOf(element));
        const start = this.offset;
        if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          const entries =
            value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);
          for (const [k, v] of entries) {
            this.align(8);
            this.write(keyType, k);
            this.write(valueType, v);
          }
        } else if (element === 'y' && value instanceof Uint8Array) {
          this.bytes(value);
        } else {
          for (const item of value as unknown[]) this.write(element, item);
        }
        this.buffer.writeUInt32LE(this.offset - start, lengthAt);
        return;
      }
      default:
        throw new Error(`Can't marshal type ${type}`);
    }
  }
}

class Reader {
  buffer: Buffer;
  offset: number;

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  align(n: number): void {
    this.offset += (n - (this.offset % n)) % n;
  }

  private need(n: number): void {
    if (this.offset + n > this.buffer.length) throw new Error('Truncated message');
  }

  u8(): number {
    this.need(1);
    return this.buffer.readUInt8(this.offset++);
  }

  u32(): number {
    this.align(4);
    this.need(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Read one value of a complete type. */
  read(type: string, depth = 0): unknown {
    if (depth > 64) throw new Error('Message nested too deeply');
    const c = type[0];
    switch (c) {
      case 'y':
        return this.u8();
      case 'b':
        return this.u32() !== 0;
      case 'n': case 'q': {
        this.align(2);
        this.need(2);
        const value = c === 'n' ? this.buffer.readInt16LE(this.offset) : this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
      }
      case 'i': case 'h': {
        this.align(4);
        this.need(4);
        const value = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return value;
      }
      case 'u':
        return this.u32();
      case 'x': case 't': {
        this.align(8);
        this.need(8);
        const value = c === 'x' ? this.buffer.readBigInt64LE(this.offset) : this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return Number(value);
      }
      case 'd': {
        this.align(8);
        this.need(8);
        const value = this.buffer.readDoubleLE(this.offset);
        this.offset += 8;
        return value;
      }
      case 's': case 'o': {
        const length = this.u32();
        this.need(length + 1);
        const value = this.buffer.toString('utf8', this.offset, this.offset + length);
        this.offset += length + 1;
        return value;
      }
      case 'g': {
        const length = this.u8();
        this.need(length + 1);
        const value = this.buffer.toString('utf8', this.offset, this.offset + length);
        this.offset += length + 1;
        return value;
      }
      case 'v': {
        const signature = this.read('g') as string;
        if (splitSignature(signature).length !== 1) throw new Error('Bad variant');
        return new Variant(signature, this.read(signature, depth + 1));
      }
      case '(': {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((field) => this.read(field, depth + 1));
      }
      case 'a': {
        const element = type.slice(1);
        const length = this.u32();
        this.align(alignmentOf(element));
        const end = this.offset + length;
        if (end > this.buffer.length) throw new Error('Truncated message');
        if (element === 'y') {
          const value = Buffer.from(this.buffer.subarray(this.offset, end));
          this.offset = end;
          return value;
        }
        if (element[0] === '{') {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          const map = new Map<unknown, unknown>();
          while (this.offset < end) {
            this.align(8);
            const key = this.read(keyType, depth + 1);
            map.set(key, this.read(valueType, depth + 1));
          }
          return map;
        }
        const items: unknown[] = [];
        while (this.offset < end) items.push(this.read(element, depth + 1));
        return items;
      }
      default:
        throw new Error(`Can't unmarshal type ${type}`);
    }
  }
}

function encodeMessage(message: Omit<Message, 'sender'>): Buffer {
  const body = new Writer();
  splitSignature(message.signature).forEach((type, i) => body.write(type, message.body[i]));

  const fields: [number, Variant][] = [];
  if (message.path) fields.push([FIELD_PATH, new Variant('o', message.path)]);
  if (message.interface) fields.push([FIELD_INTERFACE, new Variant('s', message.interface)]);
  if (message.member) fields.push([FIELD_MEMBER, new Variant('s', message.member)]);
  if (message.errorName) fields.push([FIELD_ERROR_NAME, new Variant('s', message.errorName)]);
  if (message.replySerial !== undefined) fields.push([FIELD_REPLY_SERIAL, new Variant('u', message.replySerial)]);
  if (message.destination) fields.push([FIELD_DESTINATION, new Variant('s', message.destination)]);
  if (message.signature) fields.push([FIELD_SIGNATURE, new Variant('g', message.signature)]);

  const header = new Writer();
  header.u8(0x6c); // 'l': little-endian
  header.u8(message.type);
  header.u8(message.flags);
  header.u8(1); // protocol version
  header.u32(body.offset);
  header.u32(message.serial);
  header.write('a(yv)', fields);
  header.align(8);
  return Buffer.concat([header.buffer.subarray(0, header.offset), body.buffer.subarray(0, body.offset)]);
}

/** The size of the message at the start of `buffer`, or null if unknown yet. */
function messageLength(buffer: Buffer): number | null {
  if (buffer.length < 16) return null;
  const little = buffer[0] === 0x6c;
  const bodyLength = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const fieldsLength = little ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
  const headerLength = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8);
  return headerLength + bodyLength;
}

function decodeMessage(buffer: Buffer): Message {
  // The bus daemon is little-endian on every machine Din runs on, and it
  // re-marshals messages in its own byte order.
  if (buffer[0] !== 0x6c) throw new Error('Big-endian messages are not supported');
  const reader = new Reader(buffer, 12);
  const fields = reader.read('a(yv)') as [number, Variant][];
  reader.align(8);
  const message: Message = {
    type: buffer[1],
    flags: buffer[2],
    serial: buffer.readUInt32LE(8),
    signature: '',
    body: [],
  };
  for (const [code, variant] of fields) {
    const value = variant.value;
    if (code === FIELD_PATH) message.path = value as string;
    else if (code === FIELD_INTERFACE) message.interface = value as string;
    else if (code === FIELD_MEMBER) message.member = value as string;
    else if (code === FIELD_ERROR_NAME) message.errorName = value as string;
    else if (code === FIELD_REPLY_SERIAL) message.replySerial = value as number;
    else if (code === FIELD_DESTINATION) message.destination = value as string;
    else if (code === FIELD_SENDER) message.sender = value as string;
    else if (code === FIELD_SIGNATURE) message.signature = value as string;
  }
  message.body = splitSignature(message.signature).map((type) => reader.read(type));
  return message;
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** What a signal subscription matches; unset fields match anything. */
export interface SignalMatch {
  /** A unique name (":1.42"): well-known names aren't resolved locally. */
  sender?: string;
  path?: string;
  interface?: string;
  member?: string;
}

/** A method call to an object this connection exports. */
export interface MethodCall {
  sender: string;
  path: string;
  interface: string;
  member: string;
  signature: string;
  body: unknown[];
}

/** What a method handler replies: [signature, body], or nothing. */
export type MethodReply = [string, unknown[]] | void;

export type MethodHandler = (call: MethodCall) => MethodReply | Promise<MethodReply>;

interface Pending {
  resolve: (body: unknown[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Subscription {
  match: SignalMatch;
  rule: string;
  handler: (message: Message) => void;
}

/** A match rule's value, quoted per the spec. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function matchRule(match: SignalMatch): string {
  const parts = ["type='signal'"];
  if (match.sender) parts.push(`sender=${quote(match.sender)}`);
  if (match.path) parts.push(`path=${quote(match.path)}`);
  if (match.interface) parts.push(`interface=${quote(match.interface)}`);
  if (match.member) parts.push(`member=${quote(match.member)}`);
  return parts.join(',');
}

/** The socket path of a unix: bus address, or null. */
function socketPath(address: string): string | null {
  for (const candidate of address.split(';')) {
    const [transport, params = ''] = candidate.split(/:(.*)/s);
    if (transport !== 'unix') continue;
    const values = new Map(
      params.split(',').map((pair) => {
        const eq = pair.indexOf('=');
        return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))] as const;
      }),
    );
    const file = values.get('path');
    if (file) return file;
    // Abstract sockets: Node takes them with a leading NUL.
    const abstract = values.get('abstract');
    if (abstract) return `\0${abstract}`;
  }
  return null;
}

export class DBusConnection {
  private socket: net.Socket;
  private chunks: Buffer[] = [];
  private queued = 0;
  private serial = 0;
  private pending = new Map<number, Pending>();
  private subscriptions = new Set<Subscription>();
  private objects = new Map<string, MethodHandler>();
  private closed = false;

  /** This connection's unique bus name (":1.42"). */
  uniqueName = '';

  /** Called once when the connection drops. */
  onClose: (() => void) | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  /**
   * Connect to a bus and say Hello, or null when there's no bus to talk to
   * (no address, nothing listening, auth refused).
   */
  static async connect(address: string | undefined): Promise<DBusConnection | null> {
    const file = address ? socketPath(address) : null;
    if (!file) return null;
    const socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.createConnection(file);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (!socket) return null;
    if (!(await authenticate(socket))) {
      socket.destroy();
      return null;
    }
    const connection = new DBusConnection(socket);
    socket.on('data', (chunk) => connection.ingest(chunk));
    socket.on('error', () => connection.shutdown());
    socket.on('close', () => connection.shutdown());
    try {
      const [name] = await connection.call({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'Hello',
      });
      connection.uniqueName = name as string;
    } catch {
      connection.close();
      return null;
    }
    return connection;
  }

  /** Call a method; resolves to the reply's body, rejects with a DBusError. */
  call(options: {
    destination: string;
    path: string;
    interface: string;
    member: string;
    signature?: string;
    body?: unknown[];
    timeout?: number;
  }): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new Error('D-Bus connection closed'));
    const serial = this.nextSerial();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new DBusError('org.freedesktop.DBus.Error.Timeout', `${options.member} timed out`));
      }, options.timeout ?? CALL_TIMEOUT_MS);
      this.pending.set(serial, { resolve, reject, timer });
      try {
        this.send({
          type: METHOD_CALL,
          flags: 0,
          serial,
          destination: options.destination,
          path: options.path,
          interface: options.interface,
          member: options.member,
          signature: options.signature ?? '',
          body: options.body ?? [],
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(serial);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** A call to the bus itself. */
  bus(member: string, signature = '', body: unknown[] = []): Promise<unknown[]> {
    return this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member,
      signature,
      body,
    });
  }

  /** Emit a signal from one of this connection's objects. */
  emit(path: string, iface: string, member: string, signature = '', body: unknown[] = []): void {
    if (this.closed) return;
    this.send({
      type: SIGNAL,
      flags: NO_REPLY_EXPECTED,
      serial: this.nextSerial(),
      path,
      interface: iface,
      member,
      signature,
      body,
    });
  }

  /** Subscribe to signals. Returns an unsubscribe fn. */
  subscribe(match: SignalMatch, handler: (message: Message) => void): () => void {
    const subscription: Subscription = { match, rule: matchRule(match), handler };
    this.subscriptions.add(subscription);
    this.bus('AddMatch', 's', [subscription.rule]).catch(() => {});
    return () => {
      if (!this.subscriptions.delete(subscription)) return;
      if (!this.closed) this.bus('RemoveMatch', 's', [subscription.rule]).catch(() => {});
    };
  }

  /**
   * Answer method calls to an object path. The handler throws a DBusError to
   * reply with an error; unhandled members should throw UnknownMethod.
   */
  export(path: string, handler: MethodHandler): void {
    this.objects.set(path, handler);
  }

  close(): void {
    this.socket.destroy();
    this.shutdown();
  }

  private nextSerial(): number {
    this.serial = (this.serial % 0xffffffff) + 1;
    return this.serial;
  }

  private send(message: Omit<Message, 'sender'>): void {
    this.socket.write(encodeMessage(message));
  }

  private ingest(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.queued += chunk.length;
    for (;;) {
      if (this.queued < 16) return;
      if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
      const buffer = this.chunks[0];
      const length = messageLength(buffer);
      if (length === null) return;
      if (length > MAX_MESSAGE_BYTES) return this.close();
      if (buffer.length < length) return;
      const packet = buffer.subarray(0, length);
      this.chunks = buffer.length > length ? [buffer.subarray(length)] : [];
      this.queued -= length;
      let message: Message;
      try {
        message = decodeMessage(packet);
      } catch {
        continue; // one malformed message shouldn't take the connection down
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Message): void {
    if (message.type === METHOD_RETURN || message.type === ERROR) {
      const pending = message.replySerial !== undefined ? this.pending.get(message.replySerial) : undefined;
      if (!pending) return;
      this.pending.delete(message.replySerial!);
      clearTimeout(pending.timer);
      if (message.type === METHOD_RETURN) pending.resolve(message.body);
      else {
        const text = typeof message.body[0] === 'string' ? message.body[0] : '';
        pending.reject(new DBusError(message.errorName ?? 'org.freedesktop.DBus.Error.Failed', text));
      }
      return;
    }
    if (message.type === SIGNAL) {
      for (const { match, handler } of this.subscriptions) {
        if (match.sender && match.sender !== message.sender) continue;
        if (match.path && match.path !== message.path) continue;
        if (match.interface && match.interface !== message.interface) continue;
        if (match.member && match.member !== message.member) continue;
        try {
          handler(message);
        } catch (error) {
          console.error('dbus: signal handler failed', error);
        }
      }
      return;
    }
    if (message.type === METHOD_CALL) void this.answer(message);
  }

  private async answer(message: Message): Promise<void> {
    const reply = (fields: Partial<Message>) => {
      if (message.flags & NO_REPLY_EXPECTED || this.closed) return;
      this.send({
        type: METHOD_RETURN,
        flags: NO_REPLY_EXPECTED,
        serial: this.nextSerial(),
        replySerial: message.serial,
        destination: message.sender,
        signature: '',
        body: [],
        ...fields,
      });
    };
    const fail = (name: string, text: string) =>
      reply({ type: ERROR, errorName: name, signature: 's', body: [text] });

    if (message.interface === 'org.freedesktop.DBus.Peer') {
      if (message.member === 'Ping') return reply({});
      if (message.member === 'GetMachineId') {
        return fail('org.freedesktop.DBus.Error.NotSupported', 'No machine id');
      }
    }
    const handler = message.path ? this.objects.get(message.path) : undefined;
    if (!handler) {
      return fail('org.freedesktop.DBus.Error.UnknownObject', `No object at ${message.path ?? '?'}`);
    }
    try {
      const result = await handler({
        sender: message.sender ?? '',
        path: message.path ?? '',
        interface: message.interface ?? '',
        member: message.member ?? '',
        signature: message.signature,
        body: message.body,
      });
      const [signature, body] = result ?? ['', []];
      reply({ signature, body });
    } catch (error) {
      if (error instanceof DBusError) fail(error.type, error.message);
      else fail('org.freedesktop.DBus.Error.Failed', error instanceof Error ? error.message : String(error));
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('D-Bus connection closed'));
    }
    this.pending.clear();
    this.subscriptions.clear();
    this.onClose?.();
  }
}

/** SASL EXTERNAL: the bus knows who we are from the socket's credentials. */
function authenticate(socket: net.Socket): Promise<boolean> {
  return new Promise((resolve) => {
    let received = '';
    const done = (ok: boolean) => {
      socket.off('data', onData);
      clearTimeout(timer);
      resolve(ok);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (!received.includes('\r\n')) return;
      if (received.startsWith('OK ')) {
        socket.write('BEGIN\r\n');
        done(true);
      } else {
        done(false);
      }
    };
    const timer = setTimeout(() => done(false), 5_000);
    socket.on('data', onData);
    const uid = Buffer.from(String(os.userInfo().uid), 'ascii').toString('hex');
    socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
  });
}
