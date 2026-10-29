import { unzlibSync } from 'fflate';
import { Bytes } from './blocks';
import type { PubImage } from './doc';

/**
 * Office Art ("Escher", MS-ODRAW), which Publisher 2002 and later keep their
 * shapes in: records with an 8-byte header (version and instance, type,
 * length), containers of more records, property tables (FOPT) and a store
 * of pictures (BLIPs) whose data sits in a stream of its own.
 */

export const T = {
  DGG: 0xf000,
  BSTORE: 0xf001,
  DG: 0xf002,
  SPGR: 0xf003,
  SP: 0xf004,
  BSE: 0xf007,
  FSPGR: 0xf009,
  FSP: 0xf00a,
  FOPT: 0xf00b,
  CHILD_ANCHOR: 0xf00f,
  CLIENT_ANCHOR: 0xf010,
  CLIENT_DATA: 0xf011,
  TERTIARY_FOPT: 0xf122,
} as const;

export interface Rec {
  ver: number;
  inst: number;
  type: number;
  /** Where the record's data starts. */
  at: number;
  len: number;
  /** After the record (and the 4 bytes Publisher puts after drawing containers). */
  end: number;
}

export function records(s: Bytes, start: number, end: number): Rec[] {
  const out: Rec[] = [];
  let o = start;
  end = Math.min(end, s.length);
  while (o + 8 <= end) {
    const vi = s.u16(o);
    const type = s.u16(o + 2);
    const len = s.u32(o + 4);
    if (type < 0xf000 || o + 8 + len > s.length) break;
    const tail = type === T.DGG || type === T.DG ? 4 : 0;
    out.push({ ver: vi & 0xf, inst: vi >> 4, type, at: o + 8, len, end: o + 8 + len + tail });
    o += 8 + len + tail;
  }
  return out;
}

export const kidsOf = (s: Bytes, r: Rec) => records(s, r.at, r.at + r.len);

export interface Props {
  /** Simple values by property id (with its blip and complex flags). */
  v: Map<number, number>;
  /** Complex values' data. */
  c: Map<number, Uint8Array>;
}

export function readFopt(s: Bytes, r: Rec): Props {
  const v = new Map<number, number>();
  const c = new Map<number, Uint8Array>();
  const complex: number[] = [];
  const n = r.inst;
  for (let i = 0; i < n && i * 6 + 6 <= r.len; i++) {
    const id = s.u16(r.at + i * 6);
    v.set(id, s.u32(r.at + i * 6 + 2));
    if (id & 0x8000) complex.push(id);
  }
  let o = r.at + n * 6;
  const end = r.at + r.len;
  for (const id of complex) {
    const size = v.get(id) ?? 0;
    if (!size || o >= end) continue;
    // Arrays: count, count again, element size (0xfff0 meaning 4), then the elements.
    const count = s.u16(o);
    let el = s.u16(o + 4);
    if (el === 0xfff0) el = 4;
    const arr = 6 + count * el;
    const take = el && (arr === size || arr === size + 6) ? arr : size;
    c.set(id, s.slice(o, Math.min(end - o, take)));
    o += take;
  }
  return { v, c };
}

/** The (id, value) pairs of client anchors and client data. */
export function readPairs(s: Bytes, r: Rec): Map<number, number> {
  const m = new Map<number, number>();
  for (let o = r.at + 4; o + 6 <= r.at + r.len; o += 6) m.set(s.u16(o), s.u32(o + 2));
  return m;
}

/** 16.16 fixed point. */
export const fixed = (v: number) => (v | 0) / 65536;

const BLIP_KIND: Record<number, PubImage['kind']> = {
  0xf01a: 'emf',
  0xf01b: 'wmf',
  0xf01c: 'pict',
  0xf01d: 'jpeg',
  0xf01e: 'png',
  0xf01f: 'bmp',
  0xf029: 'tiff',
  0xf02a: 'jpeg',
};

/** Instances of each BLIP type that carry one UID; the next one up carries two. */
const ONE_UID: Record<number, number[]> = {
  0xf01a: [0x3d4],
  0xf01b: [0x216],
  0xf01c: [0x542],
  0xf01d: [0x46a, 0x6e2],
  0xf01e: [0x6e0],
  0xf01f: [0x7a8],
  0xf029: [0x6e4],
  0xf02a: [0x46b, 0x6e3],
};

/** A BLIP record's picture. */
export function readBlip(s: Bytes, r: Rec): PubImage | null {
  const kind = BLIP_KIND[r.type];
  if (!kind) return null;
  const uids = ONE_UID[r.type].includes(r.inst) ? 1 : 2;
  const end = r.at + r.len;
  if (kind === 'emf' || kind === 'wmf' || kind === 'pict') {
    const h = r.at + 16 * uids;
    const compressed = s.u8(h + 32) === 0;
    const raw = s.slice(h + 34, end - h - 34);
    let data = raw;
    if (compressed) {
      try {
        data = unzlibSync(raw);
      } catch {
        return null;
      }
    }
    return { kind, data };
  }
  const extra = r.type === 0xf02a ? 17 : 1;
  const data = s.slice(r.at + 16 * uids + extra, end - (r.at + 16 * uids + extra));
  return { kind, data: kind === 'bmp' ? bmpFromDib(data) : data };
}

/** A DIB with the BMP file header browsers need in front of it. */
export function bmpFromDib(dib: Uint8Array): Uint8Array {
  if (dib.length < 40) return dib;
  const v = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const hdr = v.getUint32(0, true);
  const bpp = v.getUint16(14, true);
  let colors = hdr >= 36 ? v.getUint32(32, true) : 0;
  if (!colors && bpp <= 8) colors = 1 << bpp;
  const masks = hdr === 40 && v.getUint32(16, true) === 3 ? 12 : 0;
  const out = new Uint8Array(14 + dib.length);
  const o = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  o.setUint32(2, out.length, true);
  o.setUint32(10, 14 + hdr + masks + colors * 4, true);
  out.set(dib, 14);
  return out;
}
