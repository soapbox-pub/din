/**
 * The block structure of Publisher's Contents and Quill streams (2002 and
 * later): each block is an id byte and a type byte, then data whose length
 * the type fixes, or a 32-bit length (counting itself) for strings and
 * containers of more blocks.
 */

export class Bytes {
  readonly v: DataView;
  constructor(readonly b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get length() {
    return this.b.length;
  }
  u8 = (o: number) => (o >= 0 && o < this.b.length ? this.b[o] : 0);
  u16 = (o: number) => (o >= 0 && o + 2 <= this.b.length ? this.v.getUint16(o, true) : 0);
  i16 = (o: number) => (o >= 0 && o + 2 <= this.b.length ? this.v.getInt16(o, true) : 0);
  u32 = (o: number) => (o >= 0 && o + 4 <= this.b.length ? this.v.getUint32(o, true) : 0);
  i32 = (o: number) => (o >= 0 && o + 4 <= this.b.length ? this.v.getInt32(o, true) : 0);
  ascii(o: number, n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8(o + i));
    return s;
  }
  utf16(o: number, chars: number): string {
    let s = '';
    for (let i = 0; i < chars; i++) s += String.fromCharCode(this.u16(o + i * 2));
    return s;
  }
  slice(o: number, n: number): Uint8Array {
    return this.b.subarray(Math.max(0, o), Math.min(this.b.length, o + Math.max(0, n)));
  }
}

const FIXED: Record<number, number> = {
  0x78: 0, 0x05: 0, 0x08: 0, 0x0a: 0,
  0x10: 2, 0x12: 2, 0x18: 2, 0x1a: 2, 0x07: 2,
  0x20: 4, 0x22: 4, 0x58: 4, 0x68: 4, 0x70: 4, 0xb8: 4,
  0x28: 8, 0x38: 16, 0x48: 24,
};
const VARIABLE = new Set([0xc0, 0x80, 0x82, 0x88, 0x8a, 0x90, 0x98, 0xa0]);

export const STRING = 0xc0;
export const CONTAINER = 0x88;
export const EMPTY = 0x78;
export const SEQNUM = 0x70;

export interface Block {
  id: number;
  type: number;
  /** Where the block starts (its id byte). */
  at: number;
  /** The block's data: an integer for fixed-size ones. */
  value: number;
  /** For variable-length blocks: where the 32-bit length is, and the length. */
  dataAt: number;
  dataLength: number;
  /** After the block. */
  end: number;
}

export function isContainer(b: Block) {
  return VARIABLE.has(b.type) && b.type !== STRING;
}

/** The blocks from `start` to `end`, one level deep. */
export function blocks(s: Bytes, start: number, end: number): Block[] {
  const out: Block[] = [];
  let o = start;
  end = Math.min(end, s.length);
  while (o + 2 <= end) {
    const id = s.u8(o);
    const type = s.u8(o + 1);
    const at = o;
    o += 2;
    if (VARIABLE.has(type)) {
      const len = s.u32(o);
      if (len < 4 || o + len > end) break;
      out.push({ id, type, at, value: 0, dataAt: o, dataLength: len, end: o + len });
      o += len;
    } else {
      const n = FIXED[type] ?? 0;
      const value = n === 2 ? s.u16(o) : n === 4 ? s.u32(o) : 0;
      out.push({ id, type, at, value, dataAt: o, dataLength: n, end: o + n });
      o += n;
    }
  }
  return out;
}

/** A container's children. */
export const children = (s: Bytes, b: Block) => (isContainer(b) ? blocks(s, b.dataAt + 4, b.end) : []);

/** A chunk's blocks: chunks start with their own 32-bit length. */
export const chunk = (s: Bytes, at: number) => blocks(s, at + 4, at + s.u32(at));

/** A string block's UTF-16 text, without the terminating NUL. */
export function str(s: Bytes, b: Block): string {
  if (b.type !== STRING) return '';
  return s.utf16(b.dataAt + 4, Math.floor((b.dataLength - 4) / 2)).replace(/\0+$/, '');
}

export const find = (list: Block[], id: number) => list.find((b) => b.id === id);
