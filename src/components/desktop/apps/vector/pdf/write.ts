import { zlibSync } from 'fflate';
import { visualBounds } from '../geom';
import {
  intersects,
  mul,
  type Artboard,
  type Doc,
  type FontEntry,
  type Gradient,
  type GroupItem,
  type ImageItem,
  type Item,
  type Layer,
  type Mat,
  type Paint,
  type PathItem,
  type Stroke,
  type SubPath,
  type TextItem,
  type TextRun,
} from '../model';
import { cssAdvanceOf, embeddedFor, layoutText, type LaidGlyph } from '../text';
import { toRgb, type Color } from './color';
import { winAnsiCode } from './encodings';
import { PdfDoc, PdfName, PdfRef, PdfStream, type PdfDict, type PdfValue } from './objects';

/**
 * Write a document as a PDF — which is also what a PDF-compatible
 * Illustrator file is, minus Illustrator's private editing data. That data
 * is undocumented, so like other apps that save .ai files this writes the
 * PDF part alone; Illustrator opens it as it opens any PDF, art and all.
 * Each artboard is a page; layers are optional content, so they come back
 * as layers here and show as layers in Acrobat.
 */

class Obj {
  constructor(public value: PdfValue | (() => PdfValue)) {}
}

const fmt = (n: number) => {
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

function strBytes(b: Uint8Array): string {
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

class Writer {
  objs: Obj[] = [];
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

  serialize(v: PdfValue): string | Uint8Array[] {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string') return strBytes(new TextEncoder().encode(v));
    if (v instanceof Uint8Array) return strBytes(v);
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
        push(this.serialize(d) as string);
        push('\nstream\n');
        push(v.raw);
        push('\nendstream');
      } else push(this.serialize(v as PdfValue) as string);
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

const N = (n: string) => new PdfName(n);

// ---- Fonts for type the file's fonts can't set -----------------------------------------------

const STANDARD: [RegExp, string, string, string, string][] = [
  [/courier|cousine|mono/i, 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  [/times|tinos|serif|minion|georgia|garamond/i, 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  [/arial|helvetica|arimo|liberation sans/i, 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
];

interface WriteFont {
  name: string;
  ref: PdfRef;
  /** Code → width in thousandths of an em, as the font declares it. */
  width(code: number): number;
  /** Text to codes. */
  encode(ch: string): { code: number; bytes: number } | null;
}

// ---- Page content -----------------------------------------------------------------------------

class Page {
  ops: string[] = [];
  res = {
    ExtGState: new Map<string, PdfValue>(),
    Shading: new Map<string, PdfValue>(),
    XObject: new Map<string, PdfValue>(),
    Font: new Map<string, PdfValue>(),
    ColorSpace: new Map<string, PdfValue>(),
    Properties: new Map<string, PdfValue>(),
  };
  private gsKeys = new Map<string, string>();
  constructor(
    readonly w: Writer,
    readonly ctx: WriteContext,
  ) {}

  op(s: string) {
    this.ops.push(s);
  }

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
        ['BM', N(BLEND_NAMES[blend] ?? 'Normal')],
      ]);
      this.res.ExtGState.set(n, this.w.add(d));
    }
    return n;
  }

  resourceDict(): PdfDict {
    const d: PdfDict = new Map();
    for (const [k, m] of Object.entries(this.res)) if (m.size) d.set(k, new Map(m));
    return d;
  }
}

const BLEND_NAMES: Record<string, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight',
  difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

interface WriteContext {
  doc: Doc;
  w: Writer;
  images: Map<string, PdfRef>;
  fonts: Map<string, WriteFont>;
  spots: Map<string, PdfRef>;
  notes: Set<string>;
}

function colorOps(page: Page, c: Color, stroke: boolean): string {
  if (c.spot && c.tint !== undefined && c.spotFull) {
    const key = `${c.spot}/${c.space}/${c.spotFull.join(',')}`;
    let ref = page.ctx.spots.get(key);
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
      ref = page.w.add([N('Separation'), N(c.spot), N(alt), fn]);
      page.ctx.spots.set(key, ref);
    }
    const name = `CS${[...page.ctx.spots.keys()].indexOf(key)}`;
    page.res.ColorSpace.set(name, ref);
    return `/${name} ${stroke ? 'CS' : 'cs'} ${fmt(c.tint)} ${stroke ? 'SCN' : 'scn'}`;
  }
  const v = c.c.map(fmt).join(' ');
  if (c.space === 'gray') return `${v} ${stroke ? 'G' : 'g'}`;
  if (c.space === 'cmyk') return `${v} ${stroke ? 'K' : 'k'}`;
  return `${v} ${stroke ? 'RG' : 'rg'}`;
}

function pathOps(paths: SubPath[]): string {
  const out: string[] = [];
  for (const sp of paths) {
    const ns = sp.nodes;
    if (!ns.length) continue;
    out.push(`${fmt(ns[0].x)} ${fmt(ns[0].y)} m`);
    const n = ns.length;
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = ns[i];
      const b = ns[(i + 1) % n];
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) out.push(`${fmt(b.x)} ${fmt(b.y)} l`);
      else out.push(`${fmt(a.ox)} ${fmt(a.oy)} ${fmt(b.ix)} ${fmt(b.iy)} ${fmt(b.x)} ${fmt(b.y)} c`);
    }
    if (sp.closed) out.push('h');
  }
  return out.join('\n');
}

/** A shading for a gradient in gradient space (drawn after `cm` by its matrix). */
function shading(page: Page, g: Gradient): string {
  const stops = [...g.stops].sort((a, b) => a.t - b.t);
  const space = stops.every((s) => s.color.space === 'cmyk') ? 'cmyk' : stops.every((s) => s.color.space === 'gray') ? 'gray' : 'rgb';
  const comps = (c: Color) => (space === 'rgb' ? toRgb(c) : c.c);
  const fns: PdfDict[] = [];
  const bounds: number[] = [];
  const encode: number[] = [];
  // Ramps between stops, with midpoints as exponents the way Illustrator writes them.
  const ext = stops.length === 1 ? [stops[0], stops[0]] : stops;
  for (let i = 0; i + 1 < ext.length; i++) {
    const a = ext[i];
    const b = ext[i + 1];
    const mid = a.mid ?? 0.5;
    const nExp = mid > 0 && mid < 1 ? Math.log(0.5) / Math.log(mid) : 1;
    fns.push(
      new Map<string, PdfValue>([
        ['FunctionType', 2],
        ['Domain', [0, 1]],
        ['C0', comps(a.color)],
        ['C1', comps(b.color)],
        ['N', Math.abs(nExp - 1) < 1e-3 ? 1 : nExp],
      ]),
    );
    if (i > 0) bounds.push(Math.min(1, Math.max(0, a.t)));
    encode.push(0, 1);
  }
  const t0 = Math.min(1, Math.max(0, ext[0].t));
  const t1 = Math.min(1, Math.max(0, ext[ext.length - 1].t));
  const fn: PdfDict =
    fns.length === 1 && t0 === 0 && t1 === 1
      ? fns[0]
      : new Map<string, PdfValue>([
          ['FunctionType', 3],
          ['Domain', [t0, t1 > t0 ? t1 : t0 + 1e-4]],
          ['Functions', fns],
          ['Bounds', bounds],
          ['Encode', encode],
        ]);
  const f = g.focal ?? { x: 0, y: 0, r: 0 };
  const d: PdfDict = new Map<string, PdfValue>([
    ['ShadingType', g.type === 'linear' ? 2 : 3],
    ['ColorSpace', N(space === 'cmyk' ? 'DeviceCMYK' : space === 'gray' ? 'DeviceGray' : 'DeviceRGB')],
    ['Coords', g.type === 'linear' ? [t0, 0, t1, 0] : [f.x, f.y, Math.max(0, f.r), 0, 0, 1]],
    ['Domain', [t0, t1 > t0 ? t1 : t0 + 1e-4]],
    ['Function', fn],
    ['Extend', [true, true]],
  ]);
  const name = `Sh${page.res.Shading.size}`;
  page.res.Shading.set(name, page.w.add(d));
  if (g.stops.some((s) => s.opacity < 1)) page.ctx.notes.add('Gradient stops’ opacity is saved as solid.');
  return name;
}

const matOps = (m: Mat) => `${m.map(fmt).join(' ')} cm`;

function paintOps(page: Page, paint: Paint, stroke: boolean): string | null {
  if (paint.type === 'color') return colorOps(page, paint.color, stroke);
  if (paint.type === 'gradient') {
    // Strokes can't take a gradient in PDF without outlining; they take its middle color.
    const stops = paint.gradient.stops;
    return colorOps(page, stops[Math.floor(stops.length / 2)]?.color ?? { space: 'gray', c: [0] }, stroke);
  }
  return null;
}

function strokeStateOps(s: Stroke): string {
  const dash = s.dash.length && s.dash.some((d) => d > 0) ? `[${s.dash.map(fmt).join(' ')}] ${fmt(s.dashOffset)} d` : '[] 0 d';
  return `${fmt(s.width)} w ${s.cap} J ${s.join} j ${fmt(s.miter)} M ${dash}`;
}

function writePath(page: Page, it: PathItem) {
  const fill = it.fill.type !== 'none';
  const stroke = it.stroke.paint.type !== 'none' && it.stroke.width > 0;
  if (!fill && !stroke) return;
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.gstate(it.opacity, it.opacity, it.blend)} gs`);
  const geometry = pathOps(it.paths);
  if (it.fill.type === 'gradient') {
    const sh = shading(page, it.fill.gradient);
    page.op(`q\n${geometry}\nW${it.evenOdd ? '*' : ''} n\n${matOps(it.fill.gradient.matrix)}\n/${sh} sh\nQ`);
  } else if (fill) {
    page.op(paintOps(page, it.fill, false)!);
    page.op(`${geometry}\nf${it.evenOdd ? '*' : ''}`);
  }
  if (stroke) {
    page.op(paintOps(page, it.stroke.paint, true)!);
    page.op(strokeStateOps(it.stroke));
    page.op(`${geometry}\nS`);
  }
  page.op('Q');
}

function writeImage(page: Page, it: ImageItem) {
  const ctx = page.ctx;
  let ref = ctx.images.get(it.image);
  const img = ctx.doc.res.images.get(it.image);
  if (!img) return;
  if (!ref) {
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
      d.set('SMask', page.w.stream(sm, img.alpha));
    }
    if (img.jpeg) {
      const comps = img.jpegComponents ?? 3;
      d.set('ColorSpace', N(comps === 4 ? 'DeviceCMYK' : comps === 1 ? 'DeviceGray' : 'DeviceRGB'));
      d.set('Filter', N('DCTDecode'));
      if (img.jpegDecode) d.set('Decode', img.jpegDecode);
      ref = page.w.add(new PdfStream(d, img.jpeg));
    } else if (img.rgb) {
      d.set('ColorSpace', N(img.gray ? 'DeviceGray' : 'DeviceRGB'));
      ref = page.w.stream(d, img.rgb);
    } else if (img.bitmap) {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext('2d')!;
      cx.drawImage(img.bitmap, 0, 0);
      const px = cx.getImageData(0, 0, img.width, img.height).data;
      const rgb = new Uint8Array(img.width * img.height * 3);
      const a = new Uint8Array(img.width * img.height);
      let anyAlpha = false;
      for (let i = 0; i < img.width * img.height; i++) {
        rgb[i * 3] = px[i * 4];
        rgb[i * 3 + 1] = px[i * 4 + 1];
        rgb[i * 3 + 2] = px[i * 4 + 2];
        a[i] = px[i * 4 + 3];
        if (a[i] < 255) anyAlpha = true;
      }
      d.set('ColorSpace', N('DeviceRGB'));
      if (anyAlpha && !img.alpha) {
        const sm: PdfDict = new Map<string, PdfValue>([
          ['Type', N('XObject')],
          ['Subtype', N('Image')],
          ['Width', img.width],
          ['Height', img.height],
          ['BitsPerComponent', 8],
          ['ColorSpace', N('DeviceGray')],
        ]);
        d.set('SMask', page.w.stream(sm, a));
      }
      ref = page.w.stream(d, rgb);
    } else return;
    ctx.images.set(it.image, ref);
  }
  const name = `Im${[...ctx.images.keys()].indexOf(it.image)}`;
  page.res.XObject.set(name, ref);
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.gstate(it.opacity, it.opacity, it.blend)} gs`);
  page.op(matOps(mul([1, 0, 0, -1, 0, 1], it.matrix)));
  page.op(`/${name} Do\nQ`);
}

/** A font for type the file's own fonts can't set: a standard one, or one named for the system to supply. */
function substituteFont(ctx: WriteContext, run: TextRun): WriteFont {
  const bold = /bold|black|heavy|semibold/i.test(run.font.style);
  const italic = /italic|oblique/i.test(run.font.style);
  const std = STANDARD.find(([re]) => re.test(run.font.family) || re.test(run.font.postscript));
  const baseName: string = std ? (std[1 + (bold ? 1 : 0) + (italic ? 2 : 0)] as string) : run.font.postscript.replace(/^[A-Z]{6}\+/, '') || run.font.family.replace(/\s+/g, '');
  const key = `sub:${baseName}`;
  const hit = ctx.fonts.get(key);
  if (hit) return hit;
  const widths: number[] = [];
  for (let c = 32; c < 256; c++) {
    const name = String.fromCharCode(c === 0x80 ? 0x20ac : c);
    widths.push(Math.round(cssAdvanceOf(run, name) * 1000));
  }
  const d: PdfDict = new Map<string, PdfValue>([
    ['Type', N('Font')],
    ['Subtype', N(std ? 'Type1' : 'TrueType')],
    ['BaseFont', N(baseName)],
    ['Encoding', N('WinAnsiEncoding')],
  ]);
  if (!std) {
    d.set('FirstChar', 32);
    d.set('LastChar', 255);
    d.set('Widths', widths);
    d.set(
      'FontDescriptor',
      ctx.w.add(
        new Map<string, PdfValue>([
          ['Type', N('FontDescriptor')],
          ['FontName', N(baseName)],
          ['Flags', (/serif|times|minion|georgia|garamond/i.test(run.font.family) ? 2 : 0) | 32 | (italic ? 64 : 0)],
          ['FontBBox', [-200, -250, 1200, 950]],
          ['ItalicAngle', italic ? -12 : 0],
          ['Ascent', 900],
          ['Descent', -250],
          ['CapHeight', 700],
          ['StemV', bold ? 140 : 80],
        ]),
      ),
    );
  }
  const ref = ctx.w.add(d);
  const f: WriteFont = {
    name: `F${ctx.fonts.size}`,
    ref,
    width: (code) => (std ? Math.round(cssAdvanceOf(run, String.fromCharCode(code === 0x80 ? 0x20ac : code)) * 1000) : (widths[code - 32] ?? 500)),
    encode: (ch) => {
      const c = winAnsiCode(ch);
      return c === null ? null : { code: c, bytes: 1 };
    },
  };
  ctx.fonts.set(key, f);
  return f;
}

function fileFont(ctx: WriteContext, entry: FontEntry): WriteFont | null {
  if (!entry.source) return null;
  const key = `file:${entry.key}`;
  const hit = ctx.fonts.get(key);
  if (hit) return hit;
  const v = ctx.w.import(entry.source.doc, entry.source.value);
  const ref = v instanceof PdfRef ? v : ctx.w.add(v);
  const f: WriteFont = {
    name: `F${ctx.fonts.size}`,
    ref,
    width: (code) => entry.width(code),
    encode: (ch) => {
      const e = entry.encode(ch);
      return e && e.length === 1 ? e[0] : null;
    },
  };
  ctx.fonts.set(key, f);
  return f;
}

function codeBytes(code: number, bytes: number): number[] {
  return bytes === 2 ? [code >> 8, code & 255] : [code & 255];
}

function writeText(page: Page, it: TextItem) {
  const ctx = page.ctx;
  const res = ctx.doc.res;
  const layout = layoutText(it, res);
  const placedFont = it.placed && it.placed.text === it.runs.map((r) => r.text).join('') ? res.fonts.get(it.placed.font) : null;
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.gstate(it.opacity, it.opacity, it.blend)} gs`);
  for (const line of layout.lines) {
    // Runs of glyphs set in one font and style.
    let seg: { font: WriteFont; run: TextRun; hs: number; glyphs: { g: LaidGlyph; code: number; bytes: number }[] } | null = null;
    const flush = () => {
      if (!seg || !seg.glyphs.length) return;
      const { font, run, hs, glyphs } = seg;
      page.res.Font.set(font.name, font.ref);
      const render = run.fill.type !== 'none' && run.stroke.paint.type !== 'none' ? 2 : run.stroke.paint.type !== 'none' ? 1 : run.fill.type !== 'none' ? 0 : 3;
      page.op('BT');
      if (run.fill.type !== 'none') page.op(paintOps(page, run.fill, false)!);
      if (render === 1 || render === 2) {
        page.op(paintOps(page, run.stroke.paint, true)!);
        page.op(strokeStateOps(run.stroke));
      }
      page.op(`${render} Tr /${font.name} ${fmt(run.size)} Tf ${fmt(hs * 100)} Tz 0 Tc 0 Tw`);
      const first = glyphs[0].g;
      page.op(`${matOps(mul([1, 0, 0, -1, first.x, line.y], it.matrix)).replace(/cm$/, 'Tm')}`);
      const parts: string[] = [];
      let bytes: number[] = [];
      let x = first.x;
      for (const { g, code, bytes: nb } of glyphs) {
        const adj = ((g.x - x) * 1000) / (run.size * hs);
        if (Math.abs(adj) > 0.5) {
          if (bytes.length) parts.push(strBytes(Uint8Array.from(bytes)));
          bytes = [];
          parts.push(fmt(-adj));
        }
        bytes.push(...codeBytes(code, nb));
        x = g.x + (font.width(code) / 1000) * run.size * hs;
      }
      if (bytes.length) parts.push(strBytes(Uint8Array.from(bytes)));
      page.op(`[${parts.join(' ')}] TJ\nET`);
      seg = null;
    };
    for (const g of line.glyphs) {
      if (g.ch === '\n' || g.ch === '\r') continue;
      const run = it.runs[g.run];
      if (!run) continue;
      let font: WriteFont | null = null;
      let code: { code: number; bytes: number } | null = null;
      let hs = run.hscale;
      if (placedFont && g.code !== undefined) {
        font = fileFont(ctx, placedFont);
        code = { code: g.code, bytes: placedFont.bytes };
        hs = it.placed!.hscale;
      } else if (placedFont && g.ch === ' ') continue;
      else {
        const emb = embeddedFor(res, run);
        if (emb && g.code !== undefined) {
          font = fileFont(ctx, emb);
          code = { code: g.code, bytes: emb.bytes };
        }
      }
      if (!font || !code) {
        font = substituteFont(ctx, run);
        code = font.encode(g.ch);
        if (!code) {
          ctx.notes.add('Characters outside Western European type are saved as “?”.');
          code = { code: 63, bytes: 1 };
        }
      }
      if (!seg || seg.font !== font || seg.run !== run) {
        flush();
        seg = { font, run, hs, glyphs: [] };
      }
      seg.glyphs.push({ g, code: code.code, bytes: code.bytes });
    }
    flush();
  }
  page.op('Q');
}

function writeGroup(page: Page, it: GroupItem) {
  const kids = it.clip ? it.children.slice(1) : it.children;
  const clip = it.clip && it.children[0]?.type === 'path' ? (it.children[0] as PathItem) : null;
  const isolated = it.opacity < 1 || it.blend !== 'normal';
  page.op('q');
  if (clip) page.op(`${pathOps(clip.paths)}\nW${clip.evenOdd ? '*' : ''} n`);
  if (isolated) {
    // A transparency group, so the group fades as one.
    const sub = new Page(page.w, page.ctx);
    for (const k of kids) writeItem(sub, k);
    const b = visualBounds(it, page.ctx.doc.res);
    const form: PdfDict = new Map<string, PdfValue>([
      ['Type', N('XObject')],
      ['Subtype', N('Form')],
      ['BBox', [b.x - 1, b.y - 1, b.x + b.w + 1, b.y + b.h + 1]],
      ['Group', new Map<string, PdfValue>([['S', N('Transparency')]])],
      ['Resources', sub.resourceDict()],
    ]);
    const ref = page.w.stream(form, new TextEncoder().encode(sub.ops.join('\n')));
    const name = `Fm${page.res.XObject.size}`;
    page.res.XObject.set(name, ref);
    page.op(`/${page.gstate(it.opacity, it.opacity, it.blend)} gs\n/${name} Do`);
  } else for (const k of kids) writeItem(page, k);
  page.op('Q');
}

function writeItem(page: Page, it: Item) {
  if (it.hidden) return;
  if (it.type === 'path') writePath(page, it);
  else if (it.type === 'image') writeImage(page, it);
  else if (it.type === 'text') writeText(page, it);
  else writeGroup(page, it);
}

export interface WriteOptions {
  title: string;
  /** Only these artboards (indexes); all by default. */
  artboards?: number[];
}

/** The document as PDF bytes, with notes on what didn't carry over exactly. */
export function writePdf(doc: Doc, opts: WriteOptions): { bytes: Uint8Array; notes: string[] } {
  const w = new Writer();
  const ctx: WriteContext = { doc, w, images: new Map(), fonts: new Map(), spots: new Map(), notes: new Set() };
  const catalog = w.add(null);
  const pagesRef = w.add(null);
  const ocgs = new Map<Layer, PdfRef>();
  for (const l of doc.layers) {
    ocgs.set(
      l,
      w.add(
        new Map<string, PdfValue>([
          ['Type', N('OCG')],
          ['Name', pdfText(l.name)],
          [
            'Usage',
            new Map<string, PdfValue>([
              ['CreatorInfo', new Map<string, PdfValue>([['Creator', pdfText('Din Vector Editor')], ['Subtype', N('Artwork')]])],
            ]),
          ],
        ]),
      ),
    );
  }
  const pageRefs: PdfRef[] = [];
  const boards: Artboard[] = (opts.artboards ?? doc.artboards.map((_, i) => i)).map((i) => doc.artboards[i]).filter(Boolean);
  // Art on more than one artboard is drawn on each page; an id lets this app open it once.
  const pagesOf = new Map<number, number>();
  for (const ab of boards) for (const l of doc.layers) for (const it of l.children) if (!it.hidden && intersects(visualBounds(it, doc.res), ab)) pagesOf.set(it.id, (pagesOf.get(it.id) ?? 0) + 1);
  for (const ab of boards) {
    const page = new Page(w, ctx);
    // Document space (y down) to the page (y up).
    page.op(matOps([1, 0, 0, -1, -ab.x, ab.y + ab.h]));
    const area = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
    doc.layers.forEach((layer, li) => {
      const items = layer.children.filter((it) => !it.hidden && intersects(visualBounds(it, doc.res), area));
      if (!items.length) return;
      const mc = `MC${li}`;
      page.res.Properties.set(mc, ocgs.get(layer)!);
      page.op(`/OC /${mc} BDC`);
      for (const it of items) {
        const shared = (pagesOf.get(it.id) ?? 0) > 1;
        if (shared) page.op(`/DinObject <</Id ${it.id}>> BDC`);
        writeItem(page, it);
        if (shared) page.op('EMC');
      }
      page.op('EMC');
    });
    const content = w.stream(new Map(), new TextEncoder().encode(page.ops.join('\n')));
    const box = [0, 0, ab.w, ab.h];
    pageRefs.push(
      w.add(
        new Map<string, PdfValue>([
          ['Type', N('Page')],
          ['Parent', pagesRef],
          ['MediaBox', box],
          ['CropBox', box],
          ['TrimBox', box],
          ['ArtBox', box],
          // Where the artboard sits among the others, and its name, for this app to open it as it was.
          ['DinArtboard', new Map<string, PdfValue>([['X', ab.x], ['Y', ab.y], ['Name', pdfText(ab.name)]])],
          ['Resources', page.resourceDict()],
          ['Contents', content],
        ]),
      ),
    );
  }
  w.set(
    pagesRef,
    new Map<string, PdfValue>([
      ['Type', N('Pages')],
      ['Kids', pageRefs],
      ['Count', pageRefs.length],
    ]),
  );
  const order = [...doc.layers].reverse().map((l) => ocgs.get(l)!);
  const off = doc.layers.filter((l) => l.hidden).map((l) => ocgs.get(l)!);
  w.set(
    catalog,
    new Map<string, PdfValue>([
      ['Type', N('Catalog')],
      ['Pages', pagesRef],
      [
        'OCProperties',
        new Map<string, PdfValue>([
          ['OCGs', [...ocgs.values()]],
          [
            'D',
            new Map<string, PdfValue>([
              ['Order', order],
              ['ON', doc.layers.filter((l) => !l.hidden).map((l) => ocgs.get(l)!)],
              ['OFF', off],
              ['RBGroups', []],
            ]),
          ],
        ]),
      ],
    ]),
  );
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const date = `D:${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}Z`;
  const info = w.add(
    new Map<string, PdfValue>([
      ['Title', pdfText(opts.title)],
      ['Creator', pdfText('Din Vector Editor')],
      ['Producer', pdfText('Din Vector Editor')],
      ['CreationDate', pdfText(date)],
      ['ModDate', pdfText(date)],
    ]),
  );
  const bytes = w.bytes(
    new Map<string, PdfValue>([
      ['Root', catalog],
      ['Info', info],
    ]),
  );
  return { bytes, notes: [...ctx.notes] };
}
