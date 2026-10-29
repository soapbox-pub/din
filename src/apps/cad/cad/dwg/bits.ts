/**
 * DWG's bit-level encodings (Open Design Specification for .dwg files,
 * chapter 2): bit-coded shorts, longs and doubles, handle references,
 * modular chars and shorts, and the CRC-16 the file uses everywhere.
 */

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc16(seed: number, data: Uint8Array, start = 0, end = data.length): number {
  let crc = seed;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return crc & 0xffff;
}

/** Handle reference codes. */
export const SOFT_OWNER = 2;
export const HARD_OWNER = 3;
export const SOFT_POINTER = 4;
export const HARD_POINTER = 5;

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

/** A growable buffer written a bit at a time, most significant bit first. */
export class BitWriter {
  private buf = new Uint8Array(256);
  /** Position in bits. */
  pos = 0;

  get bytes(): Uint8Array {
    return this.buf.subarray(0, Math.ceil(this.pos / 8));
  }

  get length(): number {
    return Math.ceil(this.pos / 8);
  }

  private ensure(bits: number) {
    const need = Math.ceil((this.pos + bits) / 8) + 1;
    if (need <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < need) n *= 2;
    const b = new Uint8Array(n);
    b.set(this.buf);
    this.buf = b;
  }

  bit(v: boolean | number) {
    this.ensure(1);
    if (v) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
    this.pos++;
  }

  /** `n` bits of `v`, high bit first. */
  bits(v: number, n: number) {
    for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1);
  }

  /** RC */
  byte(v: number) {
    this.ensure(8);
    v &= 0xff;
    const o = this.pos & 7;
    const i = this.pos >> 3;
    if (o === 0) this.buf[i] = v;
    else {
      this.buf[i] |= v >> o;
      this.buf[i + 1] = (v << (8 - o)) & 0xff;
    }
    this.pos += 8;
  }

  raw(data: Uint8Array) {
    if ((this.pos & 7) === 0) {
      this.ensure(data.length * 8);
      this.buf.set(data, this.pos >> 3);
      this.pos += data.length * 8;
    } else for (const b of data) this.byte(b);
  }

  /** RS */
  rs(v: number) {
    this.byte(v);
    this.byte(v >> 8);
  }

  /** RL */
  rl(v: number) {
    this.byte(v);
    this.byte(v >> 8);
    this.byte(v >> 16);
    this.byte(v >>> 24);
  }

  /** RD */
  rd(v: number) {
    f64[0] = v;
    for (let i = 0; i < 8; i++) this.byte(f64b[i]);
  }

  rd2(p: { x: number; y: number }) {
    this.rd(p.x);
    this.rd(p.y);
  }

  /** BS */
  bs(v: number) {
    v = Math.trunc(v);
    if (v === 0) this.bits(2, 2);
    else if (v === 256) this.bits(3, 2);
    else if (v > 0 && v < 256) {
      this.bits(1, 2);
      this.byte(v);
    } else {
      this.bits(0, 2);
      this.rs(v & 0xffff);
    }
  }

  /** BL */
  bl(v: number) {
    v = Math.trunc(v);
    if (v === 0) this.bits(2, 2);
    else if (v > 0 && v < 256) {
      this.bits(1, 2);
      this.byte(v);
    } else {
      this.bits(0, 2);
      this.rl(v);
    }
  }

  /** BD */
  bd(v: number) {
    if (!Number.isFinite(v)) v = 0;
    if (v === 0 && !Object.is(v, -0)) this.bits(2, 2);
    else if (v === 1) this.bits(1, 2);
    else {
      this.bits(0, 2);
      this.rd(v);
    }
  }

  bd2(p: { x: number; y: number }) {
    this.bd(p.x);
    this.bd(p.y);
  }

  /** 3BD, with z. */
  bd3(x: number, y: number, z: number) {
    this.bd(x);
    this.bd(y);
    this.bd(z);
  }

  /** DD: a double with a default; only "same" or a whole RD, which every reader takes. */
  dd(v: number, def: number) {
    if (v === def) this.bits(0, 2);
    else {
      this.bits(3, 2);
      this.rd(v);
    }
  }

  /** BT, R2000: thickness. */
  bt(v: number) {
    if (v === 0) this.bit(1);
    else {
      this.bit(0);
      this.bd(v);
    }
  }

  /** BE, R2000: extrusion, always +Z here. */
  be() {
    this.bit(1);
  }

  /** H: a handle reference with its code. */
  h(code: number, handle: number) {
    const bytes: number[] = [];
    let v = handle;
    while (v > 0) {
      bytes.unshift(v % 256);
      v = Math.floor(v / 256);
    }
    this.byte((code << 4) | bytes.length);
    for (const b of bytes) this.byte(b);
  }

  /** TV, in the drawing's 8-bit code page. */
  tv(s: string, encode: (s: string) => Uint8Array) {
    if (!s) {
      this.bs(0);
      return;
    }
    // AutoCAD counts the terminating zero in R2000 strings.
    const b = encode(s);
    this.bs(b.length + 1);
    this.raw(b);
    this.byte(0);
  }

  /** CMC, R2000: just the color index. */
  cmc(aci: number) {
    this.bs(aci);
  }

  /** Pad to a byte boundary with zero bits. */
  align() {
    this.pos = (this.pos + 7) & ~7;
    this.ensure(0);
  }

  /** Overwrite a raw long at a byte offset. */
  patchRl(byteOffset: number, v: number) {
    this.buf[byteOffset] = v & 0xff;
    this.buf[byteOffset + 1] = (v >> 8) & 0xff;
    this.buf[byteOffset + 2] = (v >> 16) & 0xff;
    this.buf[byteOffset + 3] = (v >>> 24) & 0xff;
  }

  /** Overwrite 32 bits starting at any bit. */
  patchRlAtBit(bitPos: number, v: number) {
    const save = this.pos;
    this.pos = bitPos;
    // Clear the 32 bits first: `byte` ORs into partial bytes.
    for (let i = 0; i < 32; i++) {
      const p = bitPos + i;
      this.buf[p >> 3] &= ~(0x80 >> (p & 7));
    }
    const tail = this.buf[(bitPos + 32) >> 3];
    this.rl(v);
    // `byte` overwrote the byte after a misaligned write; restore its other bits.
    if (bitPos & 7) {
      const keepMask = 0xff >> ((bitPos + 32) & 7);
      const i = (bitPos + 32) >> 3;
      this.buf[i] = (this.buf[i] & ~keepMask) | (tail & keepMask);
    }
    this.pos = save;
  }
}

/** MC: modular char, signed. */
export function modularChar(v: number): number[] {
  const out: number[] = [];
  const neg = v < 0;
  let n = Math.abs(v);
  for (;;) {
    if (n < 0x40) {
      out.push(n | (neg ? 0x40 : 0));
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
}

/** UMC: unsigned modular char. */
export function unsignedModularChar(v: number): number[] {
  const out: number[] = [];
  let n = v;
  for (;;) {
    if (n < 0x80) {
      out.push(n);
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
}

/** MS: modular short, used for object sizes. */
export function modularShort(v: number): number[] {
  const out: number[] = [];
  let n = v;
  for (;;) {
    if (n < 0x8000) {
      out.push(n & 0xff, n >> 8);
      return out;
    }
    out.push(n & 0xff, ((n >> 8) & 0x7f) | 0x80);
    n = Math.floor(n / 32768);
  }
}

/** Bytes for 8-bit DWG text. Characters outside the code page become \U+XXXX, as AutoCAD writes them. */
export function encoder(codepage: number): (s: string) => Uint8Array {
  const table = codepage === 1252 ? CP1252_HIGH : null;
  return (s: string) => {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) out.push(c);
      else if (table && table.has(c)) out.push(table.get(c)!);
      else if (!table && c < 0x100) out.push(c);
      else for (const b of `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`) out.push(b.charCodeAt(0));
    }
    return Uint8Array.from(out);
  };
}

const CP1252_HIGH = (() => {
  const m = new Map<number, number>();
  const specials = [
    0x20ac, -1, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, -1, 0x017d, -1,
    -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, -1, 0x017e, 0x0178,
  ];
  specials.forEach((u, i) => u > 0 && m.set(u, 0x80 + i));
  for (let c = 0xa0; c < 0x100; c++) m.set(c, c);
  return m;
})();
