// Typed encoders for the X11 requests Din's embedded display needs, on top of
// the raw request()/requestNoReply() primitives in x11.mts.
//
// The embedded display (native-display-worker.mts) is a window manager and a
// compositor at once: it redirects every toplevel offscreen (Composite),
// learns what changed (DAMAGE), reads pixels back (GetImage), injects input
// (XTEST), and follows the cursor and the clipboard (XFIXES). Each function
// here is one request, laid out per the protocol spec; nothing is batched
// or cached.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import type { WindowId, X11Client } from './x11.mts';

/** Core request opcodes. */
const OP_CREATE_WINDOW = 1;
const OP_MAP_WINDOW = 8;
const OP_CONFIGURE_WINDOW = 12;
const OP_GET_GEOMETRY = 14;
const OP_CHANGE_PROPERTY = 18;
const OP_DELETE_PROPERTY = 19;
const OP_SET_SELECTION_OWNER = 22;
const OP_CONVERT_SELECTION = 24;
const OP_SEND_EVENT = 25;
const OP_SET_INPUT_FOCUS = 42;
const OP_GET_IMAGE = 73;
const OP_KILL_CLIENT = 113;

/** ConfigureWindow value-mask bits. */
export const CONFIG_X = 1;
export const CONFIG_Y = 2;
export const CONFIG_WIDTH = 4;
export const CONFIG_HEIGHT = 8;
export const CONFIG_BORDER = 16;
export const CONFIG_SIBLING = 32;
export const CONFIG_STACK_MODE = 64;
/** Stack mode Above. */
export const STACK_ABOVE = 0;

/** XTEST FakeInput event types. */
export const FAKE_KEY_PRESS = 2;
export const FAKE_KEY_RELEASE = 3;
export const FAKE_BUTTON_PRESS = 4;
export const FAKE_BUTTON_RELEASE = 5;
export const FAKE_MOTION = 6;

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

/** One extension's major opcode and event base, as QueryExtension reports. */
export interface Extension {
  opcode: number;
  firstEvent: number;
}

/** Create a 1x1 InputOutput child of root that is never mapped. */
export function createHiddenWindow(x: X11Client, id: WindowId): void {
  const body = Buffer.alloc(28);
  body.writeUInt32LE(id, 0);
  body.writeUInt32LE(x.root, 4);
  body.writeInt16LE(-10, 8);
  body.writeInt16LE(-10, 10);
  body.writeUInt16LE(1, 12);
  body.writeUInt16LE(1, 14);
  body.writeUInt16LE(0, 16); // border
  body.writeUInt16LE(1, 18); // InputOutput
  body.writeUInt32LE(0, 20); // CopyFromParent visual
  body.writeUInt32LE(0, 24); // no values
  x.requestNoReply(OP_CREATE_WINDOW, 0, body); // depth CopyFromParent
}

/** A window's geometry relative to its parent (root, for toplevels). */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export async function getGeometry(x: X11Client, drawable: number): Promise<Geometry> {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(drawable, 0);
  const reply = await x.request(OP_GET_GEOMETRY, 0, body);
  return {
    depth: reply.readUInt8(1),
    x: reply.readInt16LE(12),
    y: reply.readInt16LE(14),
    width: reply.readUInt16LE(16),
    height: reply.readUInt16LE(18),
  };
}

export function mapWindow(x: X11Client, window: WindowId): void {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(window, 0);
  x.requestNoReply(OP_MAP_WINDOW, 0, body);
}

/**
 * ConfigureWindow with the given fields. Values are written in mask-bit
 * order, as the protocol requires.
 */
export function configureWindow(
  x: X11Client,
  window: WindowId,
  values: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    border?: number;
    sibling?: number;
    stackMode?: number;
  },
): void {
  const fields: [number, number | undefined][] = [
    [CONFIG_X, values.x],
    [CONFIG_Y, values.y],
    [CONFIG_WIDTH, values.width],
    [CONFIG_HEIGHT, values.height],
    [CONFIG_BORDER, values.border],
    [CONFIG_SIBLING, values.sibling],
    [CONFIG_STACK_MODE, values.stackMode],
  ];
  const present = fields.filter(([, value]) => value !== undefined);
  if (present.length === 0) return;
  const body = Buffer.alloc(8 + present.length * 4);
  body.writeUInt32LE(window, 0);
  let mask = 0;
  present.forEach(([bit, value], i) => {
    mask |= bit;
    // INT16/CARD16 values travel sign-extended in a 32-bit slot.
    body.writeInt32LE(Math.round(value as number), 8 + i * 4);
  });
  body.writeUInt16LE(mask, 4);
  x.requestNoReply(OP_CONFIGURE_WINDOW, 0, body);
}

/** ChangeProperty (mode Replace) with 8- or 32-bit data. */
export function changeProperty(
  x: X11Client,
  window: WindowId,
  property: number,
  type: number,
  format: 8 | 32,
  data: Buffer | number[],
): void {
  const bytes = Array.isArray(data)
    ? (() => {
        const b = Buffer.alloc(data.length * 4);
        data.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        return b;
      })()
    : data;
  const units = format === 32 ? bytes.length / 4 : bytes.length;
  const body = Buffer.alloc(20 + bytes.length + pad4(bytes.length));
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(property, 4);
  body.writeUInt32LE(type, 8);
  body.writeUInt8(format, 12);
  body.writeUInt32LE(units, 16);
  bytes.copy(body, 20);
  x.requestNoReply(OP_CHANGE_PROPERTY, 0, body); // mode 0 = Replace
}

export function deleteProperty(x: X11Client, window: WindowId, property: number): void {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(property, 4);
  x.requestNoReply(OP_DELETE_PROPERTY, 0, body);
}

export function setSelectionOwner(
  x: X11Client,
  owner: WindowId,
  selection: number,
  time: number,
): void {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(owner, 0);
  body.writeUInt32LE(selection, 4);
  body.writeUInt32LE(time >>> 0, 8);
  x.requestNoReply(OP_SET_SELECTION_OWNER, 0, body);
}

export function convertSelection(
  x: X11Client,
  requestor: WindowId,
  selection: number,
  target: number,
  property: number,
  time: number,
): void {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(requestor, 0);
  body.writeUInt32LE(selection, 4);
  body.writeUInt32LE(target, 8);
  body.writeUInt32LE(property, 12);
  body.writeUInt32LE(time >>> 0, 16);
  x.requestNoReply(OP_CONVERT_SELECTION, 0, body);
}

/** SendEvent of a prebuilt 32-byte event to one window, no propagation. */
export function sendEvent(
  x: X11Client,
  destination: WindowId,
  eventMask: number,
  event: Buffer,
): void {
  const body = Buffer.alloc(40);
  body.writeUInt32LE(destination, 0);
  body.writeUInt32LE(eventMask, 4);
  event.copy(body, 8, 0, 32);
  x.requestNoReply(OP_SEND_EVENT, 0, body); // propagate = False
}

/** SetInputFocus, reverting to PointerRoot if the window goes away. */
export function setInputFocus(x: X11Client, window: WindowId, time: number): void {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(time >>> 0, 4);
  x.requestNoReply(OP_SET_INPUT_FOCUS, 1, body); // revert-to PointerRoot
}

/** The pixels of a window region, ZPixmap, as the server lays them out. */
export interface Image {
  depth: number;
  /** width * height 32-bit pixels, BGRX/BGRA on a little-endian server. */
  data: Buffer;
}

export async function getImage(
  x: X11Client,
  drawable: number,
  rx: number,
  ry: number,
  width: number,
  height: number,
): Promise<Image> {
  const body = Buffer.alloc(16);
  body.writeUInt32LE(drawable, 0);
  body.writeInt16LE(rx, 4);
  body.writeInt16LE(ry, 6);
  body.writeUInt16LE(width, 8);
  body.writeUInt16LE(height, 10);
  body.writeUInt32LE(0xffffffff, 12);
  const reply = await x.request(OP_GET_IMAGE, 2, body); // 2 = ZPixmap
  return { depth: reply.readUInt8(1), data: reply.subarray(32) };
}

export function killClient(x: X11Client, resource: number): void {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(resource, 0);
  x.requestNoReply(OP_KILL_CLIENT, 0, body);
}

// ---------------------------------------------------------------------------
// Extensions. Each needs its QueryVersion sent before any other request -
// DAMAGE and XFIXES refuse to work otherwise.
// ---------------------------------------------------------------------------

/**
 * Negotiate an extension version: minor opcode 0 with two CARD32s, which is
 * the shape Composite, DAMAGE and XFIXES share.
 */
export async function queryVersion(
  x: X11Client,
  ext: Extension,
  major: number,
  minor: number,
): Promise<void> {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(major, 0);
  body.writeUInt32LE(minor, 4);
  await x.request(ext.opcode, 0, body);
}

/** XTEST's GetVersion packs CARD8 major, pad, CARD16 minor instead. */
export async function queryXTestVersion(x: X11Client, ext: Extension): Promise<void> {
  const body = Buffer.alloc(4);
  body.writeUInt8(2, 0);
  body.writeUInt16LE(2, 2);
  await x.request(ext.opcode, 0, body);
}

/** Composite RedirectSubwindows: every child of `window` goes offscreen. */
export function compositeRedirectSubwindows(
  x: X11Client,
  ext: Extension,
  window: WindowId,
): void {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(window, 0);
  body.writeUInt8(1, 4); // Manual: nothing is painted to the screen
  x.requestNoReply(ext.opcode, 2, body);
}

/** DAMAGE Create, reporting every damaged rectangle (RawRectangles). */
export function damageCreate(
  x: X11Client,
  ext: Extension,
  damage: number,
  drawable: number,
): void {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(damage, 0);
  body.writeUInt32LE(drawable, 4);
  body.writeUInt8(0, 8); // RawRectangles
  x.requestNoReply(ext.opcode, 1, body);
}

export function damageDestroy(x: X11Client, ext: Extension, damage: number): void {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(damage, 0);
  x.requestNoReply(ext.opcode, 2, body);
}

/** XTEST FakeInput: inject one device event as if from real hardware. */
export function fakeInput(
  x: X11Client,
  ext: Extension,
  type: number,
  detail: number,
  rootX = 0,
  rootY = 0,
): void {
  const body = Buffer.alloc(32);
  body.writeUInt8(type, 0);
  body.writeUInt8(detail, 1);
  body.writeUInt32LE(0, 4); // CurrentTime
  body.writeUInt32LE(type === FAKE_MOTION ? x.root : 0, 8);
  body.writeInt16LE(rootX, 20);
  body.writeInt16LE(rootY, 22);
  x.requestNoReply(ext.opcode, 2, body);
}

/** XFIXES SelectSelectionInput: hear about owner changes of a selection. */
export function xfixesSelectSelectionInput(
  x: X11Client,
  ext: Extension,
  window: WindowId,
  selection: number,
): void {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(selection, 4);
  body.writeUInt32LE(1, 8); // SetSelectionOwnerNotifyMask
  x.requestNoReply(ext.opcode, 2, body);
}

/** XFIXES SelectCursorInput: hear about every change of the displayed cursor. */
export function xfixesSelectCursorInput(x: X11Client, ext: Extension, window: WindowId): void {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(window, 0);
  body.writeUInt32LE(1, 4); // DisplayCursorNotifyMask
  x.requestNoReply(ext.opcode, 3, body);
}

/** The displayed cursor: hotspot, size and premultiplied ARGB pixels. */
export interface CursorImage {
  width: number;
  height: number;
  xhot: number;
  yhot: number;
  serial: number;
  /** width * height CARD32 ARGB, i.e. BGRA bytes. */
  pixels: Buffer;
}

export async function xfixesGetCursorImage(x: X11Client, ext: Extension): Promise<CursorImage> {
  const reply = await x.request(ext.opcode, 4, Buffer.alloc(0));
  const width = reply.readUInt16LE(12);
  const height = reply.readUInt16LE(14);
  return {
    width,
    height,
    xhot: reply.readUInt16LE(16),
    yhot: reply.readUInt16LE(18),
    serial: reply.readUInt32LE(20),
    pixels: reply.subarray(32, 32 + width * height * 4),
  };
}
