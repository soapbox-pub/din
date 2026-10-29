import { zlibSync } from 'fflate';
import type { Color } from './color';
import { PdfDoc, PdfName, PdfRef, PdfStream, type PdfDict, type PdfValue } from './objects';

/**
 * Writing PDF, the parts every app that saves one needs: numbered objects
 * and their serialization, compressed streams, page content with its
 * resources (graphics states, colors, spot colors), and images as XObjects.
 * Vector Editor and Publisher both write through this.
 */

class Obj {
  constructor(public value: PdfValue | (() => PdfValue)) {}
}

/** A number as content streams want it: short, finite, no exponent. */
export const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

const NAME_SAFE = /^[A-Za-z0-9_.+\-:*]$/;
function nameStr(n: string): string {
  let s = '/';
  for (const ch of new TextEncoder().encode(n)) {
    const c = String.fromCharCode(ch);
    s += ch > 32 && ch < 127 && NAME_SAFE.test(c) ? c : `#${ch.toString(16).padStart(2, '0')}`;
  }
  return s;
}

/** Bytes as a hex string, `<…>`. */
export function hexString(b: Uint8Array | number[]): string {
  let s = '<';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s + '>';
}

/** A text string, UTF-16 when it isn't plain ASCII. */
export function pdfText(s: string): Uint8Array {
  if (/^[\x20-\x7e]*$/.test(s)) return new TextEncoder().encode(s);
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) >> 8;
    out[3 + i * 2] = s.charCodeAt(i) & 255;
  }
  return out;
}

/** Now, as a PDF date string. */
export function pdfDate(now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `D:${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}Z`;
}

export const N = (n: string) => new PdfName(n);

export class PdfWriter {
  objs: Obj[] = [];
  /** Separation color spaces, one per spot color. */
  spots = new Map<string, PdfRef>();
  private imported = new Map<PdfDoc, Map<string, PdfRef>>();

  add(v: PdfValue | (() => PdfValue)): PdfRef {
    this.objs.push(new Obj(v));
    return new PdfRef(this.objs.length, 0);
  }

  set(ref: PdfRef, v: PdfValue) {
    this.objs[ref.num - 1].value = v;
  }

  stream(dict: PdfDict, data: Uint8Array, compress = true): PdfRef {
    if (compress && data.length > 64) {
      const z = zlibSync(data, { level: 6 });
      const d = new Map(dict);
      d.set('Filter', new PdfName('FlateDecode'));
      return this.add(new PdfStream(d, z));
    }
    return this.add(new PdfStream(dict, data));
  }

  /** Copy an object (and everything it refers to) from another PDF. */
  import(src: PdfDoc, v: PdfValue): PdfValue {
    let map = this.imported.get(src);
    if (!map) this.imported.set(src, (map = new Map()));
    const walk = (x: PdfValue): PdfValue => {
      if (x instanceof PdfRef) {
        const hit = map!.get(x.key);
        if (hit) return hit;
        const ref = this.add(null);
        map!.set(x.key, ref);
        this.set(ref, walk(src.get(x.num)));
        return ref;
      }
      if (Array.isArray(x)) return x.map(walk);
      if (x instanceof PdfStream) {
        const d: PdfDict = new Map();
        for (const [k, val] of x.dict) if (k !== 'Length') d.set(k, walk(val));
        return new PdfStream(d, x.raw);
      }
      if (x instanceof Map) {
        const d: PdfDict = new Map();
        for (const [k, val] of x) d.set(k, walk(val));
        return d;
      }
      return x;
    };
    return walk(v);
  }

  serialize(v: PdfValue): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string') return hexString(new TextEncoder().encode(v));
    if (v instanceof Uint8Array) return hexString(v);
    if (v instanceof PdfName) return nameStr(v.name);
    if (v instanceof PdfRef) return `${v.num} 0 R`;
    if (Array.isArray(v)) return `[${v.map((x) => this.serialize(x)).join(' ')}]`;
    if (v instanceof Map) return `<<${[...v].map(([k, x]) => `${nameStr(k)} ${this.serialize(x)}`).join(' ')}>>`;
    return 'null';
  }

  bytes(trailer: PdfDict): Uint8Array {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let len = 0;
    const push = (b: Uint8Array | string) => {
      const u = typeof b === 'string' ? enc.encode(b) : b;
      chunks.push(u);
      len += u.length;
    };
    push('%PDF-1.7\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const offsets: number[] = [];
    this.objs.forEach((o, i) => {
      offsets.push(len);
      let v = o.value;
      if (typeof v === 'function') v = v();
      push(`${i + 1} 0 obj\n`);
      if (v instanceof PdfStream) {
        const d = new Map(v.dict);
        d.set('Length', v.raw.length);
        push(this.serialize(d));
        push('\nstream\n');
        push(v.raw);
        push('\nendstream');
      } else push(this.serialize(v as PdfValue));
      push('\nendobj\n');
    });
    const xref = len;
    let x = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) x += `${String(off).padStart(10, '0')} 00000 n \n`;
    push(x);
    const t = new Map(trailer);
    t.set('Size', this.objs.length + 1);
    push(`trailer\n${this.serialize(t)}\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** A matrix as a `cm` operator. */
export const matOps = (m: readonly number[]) => `${m.map(fmt).join(' ')} cm`;

/** A page's (or form's) content stream as it's built, and the resources it uses. */
export class PdfContent {
  ops: string[] = [];
  res = {
    ExtGState: new Map<string, PdfValue>(),
    Shading: new Map<string, PdfValue>(),
    Pattern: new Map<string, PdfValue>(),
    XObject: new Map<string, PdfValue>(),
    Font: new Map<string, PdfValue>(),
    ColorSpace: new Map<string, PdfValue>(),
    Properties: new Map<string, PdfValue>(),
  };
  private gsKeys = new Map<string, string>();
  constructor(readonly w: PdfWriter) {}

  op(s: string) {
    this.ops.push(s);
  }

  /** A graphics state with these opacities and blend mode (a PDF blend name); its resource name. */
  gstate(fill: number, stroke: number, blend: string): string {
    const key = `${fill}/${stroke}/${blend}`;
    let n = this.gsKeys.get(key);
    if (!n) {
      n = `GS${this.gsKeys.size}`;
      this.gsKeys.set(key, n);
      const d: PdfDict = new Map<string, PdfValue>([
        ['Type', N('ExtGState')],
        ['CA', stroke],
        ['ca', fill],
        ['BM', N(blend)],
      ]);
      this.res.ExtGState.set(n, this.w.add(d));
    }
    return n;
  }

  /** Operators setting the fill or stroke color; spot colors become Separation spaces. */
  color(c: Color, stroke: boolean): string {
    if (c.spot && c.tint !== undefined && c.spotFull) {
      const spots = this.w.spots;
      const key = `${c.spot}/${c.space}/${c.spotFull.join(',')}`;
      let ref = spots.get(key);
      if (!ref) {
        const alt = c.space === 'cmyk' ? 'DeviceCMYK' : c.space === 'gray' ? 'DeviceGray' : 'DeviceRGB';
        const zeros = c.space === 'gray' ? [1] : c.space === 'rgb' ? [1, 1, 1] : [0, 0, 0, 0];
        const fn: PdfDict = new Map<string, PdfValue>([
          ['FunctionType', 2],
          ['Domain', [0, 1]],
          ['C0', zeros],
          ['C1', c.spotFull],
          ['N', 1],
        ]);
        ref = this.w.add([N('Separation'), N(c.spot), N(alt), fn]);
        spots.set(key, ref);
      }
      const name = `CS${[...spots.keys()].indexOf(key)}`;
      this.res.ColorSpace.set(name, ref);
      return `/${name} ${stroke ? 'CS' : 'cs'} ${fmt(c.tint)} ${stroke ? 'SCN' : 'scn'}`;
    }
    const v = c.c.map(fmt).join(' ');
    if (c.space === 'gray') return `${v} ${stroke ? 'G' : 'g'}`;
    if (c.space === 'cmyk') return `${v} ${stroke ? 'K' : 'k'}`;
    return `${v} ${stroke ? 'RG' : 'rg'}`;
  }

  resourceDict(): PdfDict {
    const d: PdfDict = new Map();
    for (const [k, m] of Object.entries(this.res)) if (m.size) d.set(k, new Map(m));
    return d;
  }
}

// ---- Images ---------------------------------------------------------------------------------

export interface PdfImage {
  width: number;
  height: number;
  /** A JPEG, written as it is. */
  jpeg?: Uint8Array;
  jpegComponents?: number;
  /** Decode array for the JPEG (inverted CMYK from Photoshop). */
  jpegDecode?: number[];
  /** 8-bit pixels, RGB or (with `gray`) one channel. */
  rgb?: Uint8Array;
  gray?: boolean;
  /** 8-bit coverage, one per pixel. */
  alpha?: Uint8Array | null;
}

/** An image XObject (with its soft mask when it has alpha). */
export function imageXObject(w: PdfWriter, img: PdfImage): PdfRef | null {
  const d: PdfDict = new Map<string, PdfValue>([
    ['Type', N('XObject')],
    ['Subtype', N('Image')],
    ['Width', img.width],
    ['Height', img.height],
    ['BitsPerComponent', 8],
  ]);
  if (img.alpha) {
    const sm: PdfDict = new Map<string, PdfValue>([
      ['Type', N('XObject')],
      ['Subtype', N('Image')],
      ['Width', img.width],
      ['Height', img.height],
      ['BitsPerComponent', 8],
      ['ColorSpace', N('DeviceGray')],
    ]);
    d.set('SMask', w.stream(sm, img.alpha));
  }
  if (img.jpeg) {
    const comps = img.jpegComponents ?? 3;
    d.set('ColorSpace', N(comps === 4 ? 'DeviceCMYK' : comps === 1 ? 'DeviceGray' : 'DeviceRGB'));
    d.set('Filter', N('DCTDecode'));
    if (img.jpegDecode) d.set('Decode', img.jpegDecode);
    return w.add(new PdfStream(d, img.jpeg));
  }
  if (img.rgb) {
    d.set('ColorSpace', N(img.gray ? 'DeviceGray' : 'DeviceRGB'));
    return w.stream(d, img.rgb);
  }
  return null;
}

/** RGBA pixels split into RGB and alpha (null when every pixel is opaque). */
export function splitRgba(px: Uint8ClampedArray | Uint8Array, count: number): { rgb: Uint8Array; alpha: Uint8Array | null } {
  const rgb = new Uint8Array(count * 3);
  const a = new Uint8Array(count);
  let anyAlpha = false;
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = px[i * 4];
    rgb[i * 3 + 1] = px[i * 4 + 1];
    rgb[i * 3 + 2] = px[i * 4 + 2];
    a[i] = px[i * 4 + 3];
    if (a[i] < 255) anyAlpha = true;
  }
  return { rgb, alpha: anyAlpha ? a : null };
}

/** What a JPEG holds: its component count, and the Decode array an Adobe CMYK JPEG needs. */
export function jpegInfo(b: Uint8Array): { width: number; height: number; components: number; decode?: number[] } | null {
  let p = 2;
  let adobe = false;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xee && String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7], b[p + 8]) === 'Adobe') adobe = true;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[p + 5] << 8) | b[p + 6];
      const width = (b[p + 7] << 8) | b[p + 8];
      const components = b[p + 9];
      return { width, height, components, decode: components === 4 && adobe ? [1, 0, 1, 0, 1, 0, 1, 0] : undefined };
    }
    if (marker === 0xda) return null;
    p += 2 + len;
  }
  return null;
}
