import { decodeStream, PdfDoc, PdfName, PdfStream, type PdfDict, type PdfValue } from './objects';

/**
 * PDF functions (sampled, exponential, stitching and PostScript calculator)
 * and color spaces, turned into the colors the editor keeps: gray, RGB and
 * CMYK as the file has them, with spot colors' names kept beside what they
 * look like.
 */

export type Fn = (input: number[]) => number[];

export function makeFunction(doc: PdfDoc, v: PdfValue | undefined): Fn | null {
  const r = doc.resolve(v);
  if (Array.isArray(r)) {
    const fs = r.map((x) => makeFunction(doc, x)).filter((f): f is Fn => !!f);
    return (x) => fs.map((f) => f(x)[0] ?? 0);
  }
  const d = r instanceof PdfStream ? r.dict : r instanceof Map ? r : null;
  if (!d) return null;
  const type = doc.resolve(d.get('FunctionType'));
  const domain = doc.numbers(d.get('Domain'));
  const range = doc.numbers(d.get('Range'));
  const clipIn = (x: number[]) => x.map((xi, i) => (domain.length > 2 * i + 1 ? Math.min(domain[2 * i + 1], Math.max(domain[2 * i], xi)) : xi));
  const clipOut = (y: number[]) => y.map((yi, i) => (range.length > 2 * i + 1 ? Math.min(range[2 * i + 1], Math.max(range[2 * i], yi)) : yi));
  try {
    if (type === 0 && r instanceof PdfStream) return clipped(sampled(doc, r, domain, range));
    if (type === 2) {
      const c0 = d.has('C0') ? doc.numbers(d.get('C0')) : [0];
      const c1 = d.has('C1') ? doc.numbers(d.get('C1')) : [1];
      const n = doc.resolve(d.get('N'));
      const e = typeof n === 'number' ? n : 1;
      return clipped((x) => {
        const t = Math.pow(x[0], e);
        return c0.map((a, i) => a + t * ((c1[i] ?? 0) - a));
      });
    }
    if (type === 3) {
      const fns = doc.array(d.get('Functions')).map((f) => makeFunction(doc, f));
      const bounds = doc.numbers(d.get('Bounds'));
      const encode = doc.numbers(d.get('Encode'));
      const d0 = domain[0] ?? 0;
      const d1 = domain[1] ?? 1;
      return clipped((x) => {
        const t = x[0];
        let k = 0;
        while (k < bounds.length && t >= bounds[k]) k++;
        const lo = k === 0 ? d0 : bounds[k - 1];
        const hi = k === bounds.length ? d1 : bounds[k];
        const e0 = encode[2 * k] ?? 0;
        const e1 = encode[2 * k + 1] ?? 1;
        const u = hi === lo ? e0 : e0 + ((t - lo) * (e1 - e0)) / (hi - lo);
        return fns[k]?.([u]) ?? [0];
      });
    }
    if (type === 4 && r instanceof PdfStream) return clipped(postscript(decodeStream(doc, r).data));
  } catch {
    return null;
  }
  return null;
  function clipped(f: Fn): Fn {
    return (x) => clipOut(f(clipIn(x)));
  }
}

function sampled(doc: PdfDoc, s: PdfStream, domain: number[], range: number[]): Fn {
  const d = s.dict;
  const size = doc.numbers(d.get('Size'));
  const bps = (doc.resolve(d.get('BitsPerSample')) as number) || 8;
  const encode = d.has('Encode') ? doc.numbers(d.get('Encode')) : size.flatMap((n) => [0, n - 1]);
  const decode = d.has('Decode') ? doc.numbers(d.get('Decode')) : range;
  const data = decodeStream(doc, s).data;
  const nOut = range.length / 2;
  const max = Math.pow(2, bps) - 1;
  const sample = (idx: number, j: number) => {
    const bit = (idx * nOut + j) * bps;
    if (bps === 8) return data[bit >> 3] ?? 0;
    if (bps === 16) return ((data[bit >> 3] ?? 0) << 8) | (data[(bit >> 3) + 1] ?? 0);
    let v = 0;
    for (let b = 0; b < bps; b++) {
      const p = bit + b;
      v = (v << 1) | (((data[p >> 3] ?? 0) >> (7 - (p & 7))) & 1);
    }
    return v;
  };
  return (x) => {
    // Linear in the first input; nearest for the rest (2-D sampled functions are rare in art).
    const e = x.map((xi, i) => {
      const d0 = domain[2 * i] ?? 0;
      const d1 = domain[2 * i + 1] ?? 1;
      const v = (encode[2 * i] ?? 0) + ((xi - d0) * ((encode[2 * i + 1] ?? 1) - (encode[2 * i] ?? 0))) / (d1 - d0 || 1);
      return Math.min(size[i] - 1, Math.max(0, v));
    });
    let base = 0;
    let stride = 1;
    for (let i = 1; i < e.length; i++) {
      stride *= size[i - 1];
      base += Math.round(e[i]) * stride;
    }
    const i0 = Math.floor(e[0]);
    const i1 = Math.min(size[0] - 1, i0 + 1);
    const t = e[0] - i0;
    const out: number[] = [];
    for (let j = 0; j < nOut; j++) {
      const v = sample(base + i0, j) * (1 - t) + sample(base + i1, j) * t;
      out.push((decode[2 * j] ?? 0) + (v * ((decode[2 * j + 1] ?? 1) - (decode[2 * j] ?? 0))) / max);
    }
    return out;
  };
}

type PsCode = Array<string | number | PsCode>;

function postscript(src: Uint8Array): Fn {
  const text = new TextDecoder('latin1').decode(src);
  const tokens = text.match(/[{}]|[^\s{}]+/g) ?? [];
  let i = 0;
  const parse = (): PsCode => {
    const out: PsCode = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '{') out.push(parse());
      else if (t === '}') return out;
      else {
        const n = Number(t);
        out.push(Number.isFinite(n) ? n : t);
      }
    }
    return out;
  };
  while (i < tokens.length && tokens[i] !== '{') i++;
  i++;
  const prog = parse();
  return (x) => {
    const st: number[] = [...x];
    const run = (code: PsCode) => {
      for (let k = 0; k < code.length; k++) {
        const op = code[k];
        if (typeof op === 'number') {
          st.push(op);
          continue;
        }
        if (Array.isArray(op)) {
          const next = code[k + 1];
          const next2 = code[k + 2];
          if (next === 'if') {
            if (st.pop()) run(op);
            k++;
          } else if (Array.isArray(next) && next2 === 'ifelse') {
            run(st.pop() ? op : next);
            k += 2;
          }
          continue;
        }
        const b = () => st.pop() ?? 0;
        switch (op) {
          case 'add': st.push(b() + b()); break;
          case 'sub': { const y = b(); st.push(b() - y); break; }
          case 'mul': st.push(b() * b()); break;
          case 'div': { const y = b(); st.push(y ? b() / y : 0); break; }
          case 'idiv': { const y = b(); st.push(y ? Math.trunc(b() / y) : 0); break; }
          case 'mod': { const y = b(); st.push(y ? b() % y : 0); break; }
          case 'neg': st.push(-b()); break;
          case 'abs': st.push(Math.abs(b())); break;
          case 'sqrt': st.push(Math.sqrt(Math.max(0, b()))); break;
          case 'exp': { const e = b(); st.push(Math.pow(b(), e)); break; }
          case 'ln': st.push(Math.log(b())); break;
          case 'log': st.push(Math.log10(b())); break;
          case 'sin': st.push(Math.sin((b() * Math.PI) / 180)); break;
          case 'cos': st.push(Math.cos((b() * Math.PI) / 180)); break;
          case 'atan': { const den = b(); const a = (Math.atan2(b(), den) * 180) / Math.PI; st.push(a < 0 ? a + 360 : a); break; }
          case 'floor': st.push(Math.floor(b())); break;
          case 'ceiling': st.push(Math.ceil(b())); break;
          case 'round': st.push(Math.round(b())); break;
          case 'truncate': st.push(Math.trunc(b())); break;
          case 'cvi': st.push(Math.trunc(b())); break;
          case 'cvr': break;
          case 'dup': { const v = b(); st.push(v, v); break; }
          case 'pop': b(); break;
          case 'exch': { const y = b(); const z = b(); st.push(y, z); break; }
          case 'copy': { const n = b(); st.push(...st.slice(st.length - n)); break; }
          case 'index': { const n = b(); st.push(st[st.length - 1 - n] ?? 0); break; }
          case 'roll': {
            const j = b();
            const n = b();
            if (n > 0) {
              const part = st.splice(st.length - n, n);
              const s = ((j % n) + n) % n;
              st.push(...part.slice(n - s), ...part.slice(0, n - s));
            }
            break;
          }
          case 'eq': st.push(b() === b() ? 1 : 0); break;
          case 'ne': st.push(b() !== b() ? 1 : 0); break;
          case 'gt': { const y = b(); st.push(b() > y ? 1 : 0); break; }
          case 'ge': { const y = b(); st.push(b() >= y ? 1 : 0); break; }
          case 'lt': { const y = b(); st.push(b() < y ? 1 : 0); break; }
          case 'le': { const y = b(); st.push(b() <= y ? 1 : 0); break; }
          case 'and': st.push(b() & b()); break;
          case 'or': st.push(b() | b()); break;
          case 'xor': st.push(b() ^ b()); break;
          case 'not': st.push(b() ? 0 : 1); break;
          case 'true': st.push(1); break;
          case 'false': st.push(0); break;
          default: break;
        }
      }
    };
    run(prog);
    return st;
  };
}

// ---- Colors ---------------------------------------------------------------------------

/** A color as the editor keeps it. Components are 0–1. */
export interface Color {
  space: 'gray' | 'rgb' | 'cmyk';
  c: number[];
  /** A spot (Separation) color's name; `c` is then what it looks like at full tint. */
  spot?: string;
  /** For spot colors, the tint (0–1). */
  tint?: number;
  /** For spot colors, `c` at full tint. */
  spotFull?: number[];
}

export interface ColorSpace {
  kind: 'gray' | 'rgb' | 'cmyk' | 'lab' | 'indexed' | 'separation' | 'devicen' | 'pattern';
  n: number;
  /** To a color the editor keeps. */
  toColor(c: number[]): Color;
  /** Default component values (initial color when the space is set). */
  initial: number[];
  /** For indexed: the base and lookup table. */
  base?: ColorSpace;
  hival?: number;
  lookup?: Uint8Array;
  /** The space as it is in the file, to write back unchanged. */
  source?: PdfValue;
  /** Separation name. */
  spot?: string;
  /** For patterns with an underlying space. */
  under?: ColorSpace | null;
}

export const DEVICE_GRAY: ColorSpace = { kind: 'gray', n: 1, initial: [0], toColor: (c) => ({ space: 'gray', c: [c[0] ?? 0] }) };
export const DEVICE_RGB: ColorSpace = { kind: 'rgb', n: 3, initial: [0, 0, 0], toColor: (c) => ({ space: 'rgb', c: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0] }) };
export const DEVICE_CMYK: ColorSpace = {
  kind: 'cmyk',
  n: 4,
  initial: [0, 0, 0, 1],
  toColor: (c) => ({ space: 'cmyk', c: [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0] }),
};
const PATTERN: ColorSpace = { kind: 'pattern', n: 0, initial: [], toColor: () => ({ space: 'gray', c: [0] }), under: null };

function labToRgb(l: number, a: number, b: number): number[] {
  let y = (l + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  x = 0.9642 * f(x);
  y = f(y);
  z = 0.8249 * f(z);
  // D50 → linear sRGB (Bradford-adapted)
  const r = 3.1339 * x - 1.6169 * y - 0.4906 * z;
  const g = -0.9788 * x + 1.916 * y + 0.0334 * z;
  const bl = 0.0719 * x - 0.229 * y + 1.4057 * z;
  const gamma = (v: number) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  return [gamma(r), gamma(g), gamma(bl)];
}

export function colorSpace(doc: PdfDoc, v: PdfValue | undefined, resources: PdfDict | null, depth = 0): ColorSpace {
  if (depth > 8) return DEVICE_RGB;
  let r = doc.resolve(v);
  if (r instanceof PdfName) {
    const n = r.name;
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return DEVICE_GRAY;
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return DEVICE_RGB;
    if (n === 'DeviceCMYK' || n === 'CMYK') return DEVICE_CMYK;
    if (n === 'Pattern') return PATTERN;
    const named = doc.dict(resources?.get('ColorSpace'))?.get(n);
    if (named !== undefined) return { ...colorSpace(doc, named, resources, depth + 1), source: named };
    return DEVICE_RGB;
  }
  if (!Array.isArray(r) || !r.length) return DEVICE_RGB;
  r = r.map((x) => doc.resolve(x));
  const fam = r[0] instanceof PdfName ? r[0].name : '';
  if (fam === 'ICCBased') {
    const s = r[1];
    const d = s instanceof PdfStream ? s.dict : null;
    const n = d ? (doc.resolve(d.get('N')) as number) : 3;
    if (d?.get('Alternate')) {
      const alt = colorSpace(doc, d.get('Alternate'), resources, depth + 1);
      if (alt.n === n) return alt;
    }
    return n === 1 ? DEVICE_GRAY : n === 4 ? DEVICE_CMYK : DEVICE_RGB;
  }
  if (fam === 'CalRGB') return DEVICE_RGB;
  if (fam === 'CalGray') return DEVICE_GRAY;
  if (fam === 'Lab') {
    return {
      kind: 'lab',
      n: 3,
      initial: [0, 0, 0],
      toColor: (c) => ({ space: 'rgb', c: labToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0) }),
    };
  }
  if (fam === 'Indexed' || fam === 'I') {
    const base = colorSpace(doc, r[1], resources, depth + 1);
    const hival = typeof r[2] === 'number' ? r[2] : 255;
    const lk = r[3];
    const lookup = lk instanceof Uint8Array ? lk : lk instanceof PdfStream ? decodeStream(doc, lk).data : typeof lk === 'string' ? new TextEncoder().encode(lk) : new Uint8Array(0);
    return {
      kind: 'indexed',
      n: 1,
      initial: [0],
      base,
      hival,
      lookup,
      toColor: (c) => {
        const i = Math.max(0, Math.min(hival, Math.round(c[0] ?? 0)));
        const comps: number[] = [];
        for (let k = 0; k < base.n; k++) comps.push((lookup[i * base.n + k] ?? 0) / 255);
        return base.toColor(comps);
      },
    };
  }
  if (fam === 'Separation') {
    const spot = r[1] instanceof PdfName ? r[1].name : 'Spot';
    const alt = colorSpace(doc, r[2], resources, depth + 1);
    const fn = makeFunction(doc, r[3]);
    if (spot === 'None') return { kind: 'separation', n: 1, initial: [1], spot, toColor: () => ({ space: 'gray', c: [1] }) };
    if (spot === 'All') return { kind: 'separation', n: 1, initial: [1], spot, toColor: (c) => ({ space: 'gray', c: [1 - (c[0] ?? 1)] }) };
    return {
      kind: 'separation',
      n: 1,
      initial: [1],
      spot,
      toColor: (c) => {
        const tint = c[0] ?? 1;
        const full = alt.toColor(fn ? fn([1]) : [1]);
        const at = alt.toColor(fn ? fn([tint]) : [tint]);
        return { ...at, spot, tint, spotFull: full.space === at.space ? full.c : undefined };
      },
    };
  }
  if (fam === 'DeviceN') {
    const names = Array.isArray(r[1]) ? r[1] : [];
    const alt = colorSpace(doc, r[2], resources, depth + 1);
    const fn = makeFunction(doc, r[3]);
    return {
      kind: 'devicen',
      n: names.length,
      initial: names.map(() => 1),
      toColor: (c) => alt.toColor(fn ? fn(c) : c),
    };
  }
  if (fam === 'Pattern') return { ...PATTERN, under: r[1] ? colorSpace(doc, r[1], resources, depth + 1) : null };
  if (fam === 'DeviceGray') return DEVICE_GRAY;
  if (fam === 'DeviceCMYK') return DEVICE_CMYK;
  return DEVICE_RGB;
}

// ---- To the screen -------------------------------------------------------------------

/**
 * CMYK to sRGB, by a polynomial fitted to the U.S. Web Coated (SWOP)
 * profile Illustrator uses by default (the fit pdf.js uses), so process
 * colors look as they do there rather than the neon of 1 − (C + K).
 */
export function cmykToRgb(c: number, m: number, y: number, k: number): number[] {
  const r =
    255 +
    c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 285.2331026137004) +
    m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 5.497006427196366) +
    y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
    k * (-21.86122147463605 * k - 189.48180835922747);
  const g =
    255 +
    c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 79.2970844816548) +
    m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
    y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
    k * (-20.737325471181034 * k - 187.80453709719578);
  const b =
    255 +
    c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k - 14.183576799673286) +
    m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
    y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
    k * (-22.33816807309886 * k - 180.12613974708367);
  return [r, g, b].map((v) => Math.min(1, Math.max(0, v / 255)));
}

export function toRgb(col: Color): [number, number, number] {
  if (col.space === 'gray') return [col.c[0], col.c[0], col.c[0]];
  if (col.space === 'cmyk') {
    const [r, g, b] = cmykToRgb(col.c[0], col.c[1], col.c[2], col.c[3]);
    return [r, g, b];
  }
  return [col.c[0], col.c[1], col.c[2]];
}

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

export function toHex(col: Color): string {
  const [r, g, b] = toRgb(col);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function toCss(col: Color, alpha = 1): string {
  const [r, g, b] = toRgb(col);
  return alpha >= 1 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

export function hexColor(hex: string): Color {
  const v = parseInt(hex.slice(1), 16);
  return { space: 'rgb', c: [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255] };
}

export function sameColor(a: Color, b: Color): boolean {
  return a.space === b.space && a.spot === b.spot && a.c.length === b.c.length && a.c.every((v, i) => Math.abs(v - b.c[i]) < 1e-4);
}

export function nameOf(d: PdfDict, key: string): string | null {
  const v = d.get(key);
  return v instanceof PdfName ? v.name : null;
}
