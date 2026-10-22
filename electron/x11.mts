// A minimal X11 client, spoken over the wire.
//
// Din's embedded display (native-display-worker.mts) is a window manager and
// compositor for a private X server, and talks to it with this: connection
// setup with MIT-MAGIC-COOKIE-1 auth, sequenced requests with promised
// replies, InternAtom/GetProperty/QueryExtension helpers, and a raw event
// hook. The requests themselves are encoded in x11-requests.mts.
//
// Why raw protocol instead of a native binding (xcb via an addon): no
// Electron-ABI rebuild in the Nix build, no runtime dependency, nothing to
// add to DinOS's closure, and the protocol surface a compositor needs is
// small. Replies arrive on the event loop like any other socket data.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** X11 request opcodes used here. */
const OP_CHANGE_WINDOW_ATTRIBUTES = 2;
const OP_INTERN_ATOM = 16;
const OP_GET_PROPERTY = 20;
const OP_QUERY_EXTENSION = 98;

/** Event codes (the low 7 bits of an event's first byte). */
const EVENT_PROPERTY_NOTIFY = 28;
/** XGE GenericEvent: variable length, like a reply. */
const EVENT_GENERIC = 35;

/** CW value-mask bit for the event mask. */
const CW_EVENT_MASK = 1 << 11;

/** A window id. Plain number - X resource ids are 29-bit. */
export type WindowId = number;

/** A property as returned by GetProperty. */
export interface X11Property {
  /** The property's type atom (0 when the property doesn't exist). */
  type: number;
  /** 8, 16 or 32 - the unit size of `value`. */
  format: number;
  /** Raw bytes of the property value. */
  value: Buffer;
}

/** One entry of an .Xauthority file. */
interface XAuthEntry {
  family: number;
  address: Buffer;
  display: string;
  name: string;
  data: Buffer;
}

/** Parse an .Xauthority file into its entries. */
function parseXAuthority(file: string): XAuthEntry[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const entries: XAuthEntry[] = [];
  let off = 0;
  const readChunk = (): Buffer | null => {
    if (off + 2 > buf.length) return null;
    const len = buf.readUInt16BE(off);
    off += 2;
    if (off + len > buf.length) return null;
    const chunk = buf.subarray(off, off + len);
    off += len;
    return chunk;
  };
  while (off + 2 <= buf.length) {
    const family = buf.readUInt16BE(off);
    off += 2;
    const address = readChunk();
    const display = readChunk();
    const name = readChunk();
    const data = readChunk();
    if (!address || !display || !name || !data) break;
    entries.push({
      family,
      address,
      display: display.toString('latin1'),
      name: name.toString('latin1'),
      data,
    });
  }
  return entries;
}

/**
 * The MIT-MAGIC-COOKIE-1 for a display number, or null when the server needs
 * no auth (entry absent).
 *
 * Xauthority records the connecting host for TCP connections; for our local
 * socket the matching entry is the one for this machine's hostname (family
 * 256 = FamilyLocal, or FamilyLocalHost). Match loosely: any cookie for the
 * right display number, preferring a local-family entry.
 */
function magicCookie(displayNumber: string, xauthority?: string): Buffer | null {
  const file =
    xauthority ?? process.env.XAUTHORITY ?? path.join(os.homedir(), '.Xauthority');
  const entries = parseXAuthority(file).filter(
    (e) => e.name === 'MIT-MAGIC-COOKIE-1' && e.display === displayNumber,
  );
  if (entries.length === 0) return null;
  const hostname = os.hostname();
  const local = entries.find(
    (e) => e.family === 256 || e.address.toString('latin1') === hostname,
  );
  return (local ?? entries[0]).data;
}

/** Pad a length to the protocol's 4-byte unit. */
function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

/** A pending request awaiting its reply. */
interface Pending {
  resolve: (reply: Buffer) => void;
  reject: (error: Error) => void;
}

/**
 * A connection to the X server.
 *
 * Every request that has a reply is sequenced: X numbers requests from 1 and
 * echoes the sequence in replies and errors, so a map of sequence -> promise
 * is all the bookkeeping needed. Requests without replies (SendEvent,
 * ChangeWindowAttributes) still consume a sequence number - they just have
 * nothing to settle, and any error they provoke arrives asynchronously and is
 * dropped (see `drain`).
 */
export class X11Client {
  private socket: net.Socket;
  /**
   * Unparsed input, as the socket delivered it. Kept as a chunk list rather
   * than one growing Buffer: a window-sized GetImage reply arrives in dozens
   * of 64 KiB reads, and re-concatenating on each would be quadratic.
   */
  private chunks: Buffer[] = [];
  private queued = 0;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private atoms = new Map<string, Promise<number>>();
  private closed = false;

  /** The root window of screen 0. */
  root: WindowId;

  /**
   * The most recent server timestamp seen on an event, or 0 (CurrentTime).
   *
   * ICCCM messages like WM_TAKE_FOCUS want the timestamp of the user action
   * behind them. Din's input comes from its own renderer, whose timestamps
   * are not X timestamps - but every PropertyNotify carries one, and the
   * root window is chatty, so the last one seen is a close enough "now".
   */
  lastTimestamp = 0;

  /** Called once when the connection drops (server exit, socket error). */
  onClose: (() => void) | null = null;

  /**
   * Called for every event with its code (SendEvent bit masked off) and the
   * raw packet.
   */
  onEvent: ((code: number, packet: Buffer) => void) | null = null;

  /** Errors from no-reply requests: (error code, major opcode, minor opcode). */
  onError: ((code: number, major: number, minor: number) => void) | null = null;

  /** Visual and depth of the root window, from the setup reply. */
  rootDepth = 24;
  /** Width and height of screen 0 in pixels. */
  screenWidth = 0;
  screenHeight = 0;

  /** Next client-allocated resource id (windows, damages, ...). */
  private nextResource = 1;
  private resourceBase = 0;
  private resourceMask = 0;

  private constructor(socket: net.Socket, root: WindowId) {
    this.socket = socket;
    this.root = root;
    socket.on('data', (chunk) => this.ingest(chunk));
    socket.on('error', () => this.shutdown());
    socket.on('close', () => this.shutdown());
  }

  /**
   * Open a connection to $DISPLAY, or null when there is no X server to talk
   * to (Wayland-only session, headless, auth refused).
   *
   * Only unix-socket displays are supported - Din runs on the machine it
   * manages, and a remote X server has no local apps to list.
   */
  static async connect(
    options: { display?: string; xauthority?: string } = {},
  ): Promise<X11Client | null> {
    const display = options.display ?? process.env.DISPLAY;
    if (!display) return null;
    // ":1", "localhost:1.0", ":1.0" -> display number "1".
    const match = /^[^:]*:(\d+)(?:\.\d+)?$/.exec(display);
    if (!match) return null;
    const displayNumber = match[1];
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    if (!fs.existsSync(socketPath)) return null;

    const cookie = magicCookie(displayNumber, options.xauthority);
    const socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.connect(socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (!socket) return null;
    socket.on('error', () => {});

    const authName = cookie ? 'MIT-MAGIC-COOKIE-1' : '';
    const authData = cookie ?? Buffer.alloc(0);
    const header = Buffer.alloc(12);
    header.write('l', 0, 'latin1'); // little-endian
    header.writeUInt16LE(11, 2); // protocol major
    header.writeUInt16LE(0, 4); // protocol minor
    header.writeUInt16LE(authName.length, 6);
    header.writeUInt16LE(authData.length, 8);
    socket.write(
      Buffer.concat([
        header,
        Buffer.from(authName, 'latin1'),
        Buffer.alloc(pad4(authName.length)),
        authData,
        Buffer.alloc(pad4(authData.length)),
      ]),
    );

    const setup = await readSetupReply(socket);
    if (!setup) {
      socket.destroy();
      return null;
    }
    const screen = parseScreen(setup);
    if (screen === null) {
      socket.destroy();
      return null;
    }
    const client = new X11Client(socket, screen.root);
    client.rootDepth = screen.depth;
    client.screenWidth = screen.width;
    client.screenHeight = screen.height;
    client.resourceBase = setup.readUInt32LE(12);
    client.resourceMask = setup.readUInt32LE(16);
    return client;
  }

  /** Allocate a fresh resource id for a window, damage, etc. */
  allocateId(): number {
    // The mask's lowest set bit is the id increment.
    const step = this.resourceMask & -this.resourceMask;
    const id = (this.resourceBase | ((this.nextResource * step) & this.resourceMask)) >>> 0;
    this.nextResource += 1;
    return id;
  }

  /** Whether the connection is still usable. */
  get connected(): boolean {
    return !this.closed;
  }

  close(): void {
    this.socket.destroy();
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.reject(new Error('X11 connection closed'));
    }
    this.pending.clear();
    this.onClose?.();
  }

  /** Send a request; resolve with its reply, or reject on an X error. */
  request(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('X11 connection closed'));
    const seq = this.nextSequence();
    const header = Buffer.alloc(4);
    header.writeUInt8(opcode, 0);
    header.writeUInt8(data, 1);
    header.writeUInt16LE((body.length + 4) / 4, 2);
    this.socket.write(Buffer.concat([header, body]));
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
    });
  }

  /** Send a request that produces no reply (errors arrive asynchronously). */
  requestNoReply(opcode: number, data: number, body: Buffer): void {
    if (this.closed) return;
    this.nextSequence();
    const header = Buffer.alloc(4);
    header.writeUInt8(opcode, 0);
    header.writeUInt8(data, 1);
    header.writeUInt16LE((body.length + 4) / 4, 2);
    this.socket.write(Buffer.concat([header, body]));
  }

  /** Sequence numbers wrap at 16 bits, matching what replies carry. */
  private nextSequence(): number {
    this.sequence = (this.sequence + 1) & 0xffff;
    return this.sequence;
  }

  /** Intern an atom by name (memoized - atoms are stable per server). */
  atom(name: string): Promise<number> {
    const cached = this.atoms.get(name);
    if (cached) return cached;
    const body = Buffer.alloc(4 + name.length + pad4(name.length));
    body.writeUInt16LE(name.length, 0);
    body.write(name, 4, 'latin1');
    const promise = this.request(OP_INTERN_ATOM, 0, body)
      .then((reply) => reply.readUInt32LE(8))
      .catch((error: unknown) => {
        this.atoms.delete(name);
        throw error;
      });
    this.atoms.set(name, promise);
    return promise;
  }

  /**
   * Read a window property. Returns a zero-length value when the property is
   * absent, which is the common case for optional EWMH hints.
   *
   * `length` is in 4-byte units, matching the protocol; the default covers
   * any realistic title or hint, and icon reads pass a larger cap.
   */
  async getProperty(
    window: WindowId,
    property: number,
    length = 1024,
  ): Promise<X11Property> {
    const body = Buffer.alloc(20);
    body.writeUInt32LE(window, 0);
    body.writeUInt32LE(property, 4);
    body.writeUInt32LE(0, 8); // AnyPropertyType
    body.writeUInt32LE(0, 12); // long-offset
    body.writeUInt32LE(length, 16); // long-length
    const reply = await this.request(OP_GET_PROPERTY, 0, body);
    const format = reply.readUInt8(1);
    const type = reply.readUInt32LE(8);
    const valueLen = reply.readUInt32LE(16);
    const bytes = valueLen * (format === 0 ? 0 : format / 8);
    return { type, format, value: reply.subarray(32, 32 + bytes) };
  }

  /** A property read as a list of 32-bit values (windows, atoms, cardinals). */
  async getCardinals(
    window: WindowId,
    property: number,
    length = 1024,
  ): Promise<number[]> {
    const prop = await this.getProperty(window, property, length);
    if (prop.format !== 32) return [];
    const out: number[] = [];
    for (let i = 0; i + 4 <= prop.value.length; i += 4) {
      out.push(prop.value.readUInt32LE(i));
    }
    return out;
  }

  /**
   * A text property, decoding both UTF8_STRING (_NET_WM_*) and the Latin-1
   * STRING that ICCCM properties like WM_NAME still use.
   */
  async getText(
    window: WindowId,
    property: number,
    utf8Atom: number,
  ): Promise<string | null> {
    const prop = await this.getProperty(window, property);
    if (prop.type === 0 || prop.value.length === 0) return null;
    const text =
      prop.type === utf8Atom
        ? prop.value.toString('utf8')
        : prop.value.toString('latin1');
    // Some properties (WM_CLASS) are NUL-separated lists; callers split.
    return text;
  }

  /** Select which events this client wants from a window. */
  selectInput(window: WindowId, mask: number): void {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(window, 0);
    body.writeUInt32LE(CW_EVENT_MASK, 4);
    body.writeUInt32LE(mask, 8);
    this.requestNoReply(OP_CHANGE_WINDOW_ATTRIBUTES, 0, body);
  }

  /**
   * Look up an extension: its major opcode and first event code, or null
   * when the server doesn't have it.
   */
  async queryExtension(
    name: string,
  ): Promise<{ opcode: number; firstEvent: number; firstError: number } | null> {
    const body = Buffer.alloc(4 + name.length + pad4(name.length));
    body.writeUInt16LE(name.length, 0);
    body.write(name, 4, 'latin1');
    const reply = await this.request(OP_QUERY_EXTENSION, 0, body);
    if (!reply.readUInt8(8)) return null;
    return {
      opcode: reply.readUInt8(9),
      firstEvent: reply.readUInt8(10),
      firstError: reply.readUInt8(11),
    };
  }

  /** Accumulate socket data and dispatch whole replies/errors/events. */
  private ingest(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.queued += chunk.length;
    // Every packet is at least 32 bytes; replies may carry more.
    while (this.queued >= 32) {
      const head = this.peek(8);
      const kind = head.readUInt8(0);
      let size = 32;
      if (kind === 1 || (kind & 0x7f) === EVENT_GENERIC) {
        // Reply (or XGE event): `length` 4-byte units follow the fixed 32.
        size = 32 + head.readUInt32LE(4) * 4;
        if (this.queued < size) return;
      }
      this.dispatch(kind, this.take(size));
    }
  }

  /** The first `n` queued bytes, contiguous (n is always small). */
  private peek(n: number): Buffer {
    if (this.chunks[0].length < n) {
      this.chunks = [Buffer.concat(this.chunks)];
    }
    return this.chunks[0];
  }

  /** Remove and return the next `n` queued bytes. */
  private take(n: number): Buffer {
    this.queued -= n;
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    return out;
  }

  private dispatch(kind: number, packet: Buffer): void {
    if (kind === 0) {
      // Error. Settle the matching request; unmatched errors come from
      // no-reply requests (e.g. selecting input on a window that just died)
      // and are safely ignored.
      const seq = packet.readUInt16LE(2);
      const code = packet.readUInt8(1);
      const p = this.pending.get(seq);
      if (p) {
        this.pending.delete(seq);
        p.reject(new Error(`X11 error ${code}`));
      } else {
        this.onError?.(code, packet.readUInt8(10), packet.readUInt16LE(8));
      }
      return;
    }
    if (kind === 1) {
      const seq = packet.readUInt16LE(2);
      const p = this.pending.get(seq);
      if (p) {
        this.pending.delete(seq);
        p.resolve(packet);
      }
      return;
    }
    // Events: the high bit marks a SendEvent-generated event; mask it off.
    const code = kind & 0x7f;
    if (code === EVENT_PROPERTY_NOTIFY) this.lastTimestamp = packet.readUInt32LE(12);
    this.onEvent?.(code, packet);
  }
}

/** Read and validate the connection setup reply. */
function readSetupReply(socket: net.Socket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const status = buf.readUInt8(0);
      const total = 8 + buf.readUInt16LE(6) * 4;
      if (buf.length < total) return;
      cleanup();
      if (status !== 1) {
        resolve(null); // failed / authenticate
        return;
      }
      // Hand back only the setup packet; anything after it (events) would be
      // lost, but nothing can arrive before we've sent a request.
      resolve(buf.subarray(0, total));
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onError);
  });
}

/**
 * The first screen's root window, size and depth, dug out of the setup reply.
 *
 * The screen list sits after the variable-length vendor string and the pixmap
 * format list, so its offset has to be computed rather than hardcoded.
 */
function parseScreen(
  setup: Buffer,
): { root: WindowId; width: number; height: number; depth: number } | null {
  const vendorLength = setup.readUInt16LE(24);
  const numFormats = setup.readUInt8(29);
  const offset = 40 + vendorLength + pad4(vendorLength) + numFormats * 8;
  if (offset + 40 > setup.length) return null;
  return {
    root: setup.readUInt32LE(offset),
    width: setup.readUInt16LE(offset + 20),
    height: setup.readUInt16LE(offset + 22),
    depth: setup.readUInt8(offset + 38),
  };
}
