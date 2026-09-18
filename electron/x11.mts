// A minimal X11 client, spoken over the wire, for EWMH window management.
//
// Din needs to see and steer the windows of ordinary Linux apps (see
// native-apps.mts): which ones exist, what they're called, which is focused,
// and the ability to raise/minimize/close them. That is exactly the
// EWMH/ICCCM surface a taskbar uses.
//
// Why raw protocol instead of shelling out to wmctrl/xdotool, as the wifi and
// display bridges shell out to nmcli/xrandr: a taskbar needs a live event
// stream, not a poll loop, and neither tool is reliably installed (this box
// has xdotool but no wmctrl). Talking to the display socket directly costs
// ~300 lines, adds no runtime dependency - nothing to add to Aladdin's Nix
// closure later - and gives us PropertyNotify events for free.
//
// The scope is deliberately tiny: connection setup with MIT-MAGIC-COOKIE-1
// auth, InternAtom, GetProperty, ChangeWindowAttributes (to select events)
// and SendEvent (to post client messages to the root window). No drawing, no
// extensions, no XCB-style cookies.
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
const OP_SEND_EVENT = 25;

/** Event codes (the low 7 bits of an event's first byte). */
const EVENT_PROPERTY_NOTIFY = 28;

/** Event mask bits. */
const SUBSTRUCTURE_NOTIFY = 1 << 19;
const SUBSTRUCTURE_REDIRECT = 1 << 20;
const PROPERTY_CHANGE = 1 << 22;

/** CW value-mask bit for the event mask. */
const CW_EVENT_MASK = 1 << 11;

/** ICCCM WM_STATE values. */
export const WITHDRAWN_STATE = 0;
export const NORMAL_STATE = 1;
export const ICONIC_STATE = 3;

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
function magicCookie(displayNumber: string): Buffer | null {
  const file =
    process.env.XAUTHORITY ?? path.join(os.homedir(), '.Xauthority');
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

/** Events surfaced to callers. */
export interface PropertyNotifyEvent {
  window: WindowId;
  atom: number;
  /** 0 = NewValue, 1 = Deleted. */
  state: number;
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
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private atoms = new Map<string, Promise<number>>();
  private closed = false;

  /** The root window of screen 0. */
  root: WindowId;

  /** Called for every PropertyNotify on a window we've selected events on. */
  onPropertyNotify: ((event: PropertyNotifyEvent) => void) | null = null;

  /**
   * The most recent server timestamp seen on an event, or 0 (CurrentTime).
   *
   * EWMH messages that change focus want the timestamp of the user action
   * behind them, so window managers can apply focus-stealing prevention.
   * Din's requests come from clicks it observes in its own renderer, whose
   * timestamps are not X timestamps - but every PropertyNotify carries one,
   * and the root window is chatty, so the last one seen is a close enough
   * "now" for mutter et al. to accept the request.
   */
  lastTimestamp = 0;

  /** Called once when the connection drops (server exit, socket error). */
  onClose: (() => void) | null = null;

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
  static async connect(): Promise<X11Client | null> {
    const display = process.env.DISPLAY;
    if (!display) return null;
    // ":1", "localhost:1.0", ":1.0" -> display number "1".
    const match = /^[^:]*:(\d+)(?:\.\d+)?$/.exec(display);
    if (!match) return null;
    const displayNumber = match[1];
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    if (!fs.existsSync(socketPath)) return null;

    const cookie = magicCookie(displayNumber);
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
    const root = parseRootWindow(setup);
    if (root === null) {
      socket.destroy();
      return null;
    }
    return new X11Client(socket, root);
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
  private request(opcode: number, data: number, body: Buffer): Promise<Buffer> {
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
  private requestNoReply(opcode: number, data: number, body: Buffer): void {
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

  /** Ask the server to report property changes on a window. */
  watchProperties(window: WindowId): void {
    this.selectInput(window, PROPERTY_CHANGE);
  }

  /** Watch the root window for both its own properties and child changes. */
  watchRoot(): void {
    this.selectInput(this.root, PROPERTY_CHANGE | SUBSTRUCTURE_NOTIFY);
  }

  /**
   * Post a ClientMessage to the root window - how EWMH asks the window
   * manager to do something (activate, close, iconify). `data` is up to five
   * 32-bit words; the rest are zero-filled.
   */
  sendClientMessage(window: WindowId, type: number, data: number[]): void {
    const event = Buffer.alloc(32);
    event.writeUInt8(33, 0); // ClientMessage
    event.writeUInt8(32, 1); // format
    event.writeUInt16LE(0, 2); // sequence (ignored)
    event.writeUInt32LE(window, 4);
    event.writeUInt32LE(type, 8);
    for (let i = 0; i < 5; i += 1) {
      // >>> 0: timestamps and ids are conceptually unsigned 32-bit, but
      // arrive here as JS numbers that may have gone negative.
      event.writeUInt32LE((data[i] ?? 0) >>> 0, 12 + i * 4);
    }
    const body = Buffer.alloc(8 + 32);
    body.writeUInt32LE(this.root, 0);
    body.writeUInt32LE(SUBSTRUCTURE_NOTIFY | SUBSTRUCTURE_REDIRECT, 4);
    event.copy(body, 8);
    this.requestNoReply(OP_SEND_EVENT, 0, body);
  }

  /** Accumulate socket data and dispatch whole replies/errors/events. */
  private ingest(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Every packet is at least 32 bytes; replies may carry more.
    while (this.buffer.length >= 32) {
      const kind = this.buffer.readUInt8(0);
      let size = 32;
      if (kind === 1) {
        // Reply: an extra `length` 4-byte units follow the fixed 32.
        size = 32 + this.buffer.readUInt32LE(4) * 4;
        if (this.buffer.length < size) return;
      }
      const packet = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.dispatch(kind, packet);
    }
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
    if ((kind & 0x7f) === EVENT_PROPERTY_NOTIFY) {
      this.lastTimestamp = packet.readUInt32LE(12);
      this.onPropertyNotify?.({
        window: packet.readUInt32LE(4),
        atom: packet.readUInt32LE(8),
        state: packet.readUInt8(20),
      });
    }
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
 * The root window of the first screen, dug out of the setup reply.
 *
 * The screen list sits after the variable-length vendor string and the pixmap
 * format list, so its offset has to be computed rather than hardcoded.
 */
function parseRootWindow(setup: Buffer): WindowId | null {
  const vendorLength = setup.readUInt16LE(24);
  const numFormats = setup.readUInt8(29);
  const offset = 40 + vendorLength + pad4(vendorLength) + numFormats * 8;
  if (offset + 4 > setup.length) return null;
  return setup.readUInt32LE(offset);
}
