import {
  apply,
  defaultStroke,
  IDENTITY,
  invert,
  isEmpty,
  matScale,
  mul,
  newId,
  newLayer,
  NONE,
  type Artboard,
  type Blend,
  type Doc,
  type FontEntry,
  type GradStop,
  type Gradient,
  type GroupItem,
  type ImageEntry,
  type Item,
  type Layer,
  type Mat,
  type Node,
  type Paint,
  type PathItem,
  type Stroke,
  type SubPath,
  type TextItem,
} from '../model';
import { cmykToRgb, colorSpace, DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, makeFunction, type Color, type ColorSpace } from '@/shared/pdf/color';
import { itemBounds, visualBounds } from '../geom';
import { loadFont } from './fonts';
import { decodeStream, Lexer, Parser, PdfDoc, PdfName, PdfOp, PdfRef, PdfStream, textString, type PdfDict, type PdfValue } from '@/shared/pdf/objects';

/**
 * Open a PDF — and so a PDF-compatible Illustrator file, which is a PDF
 * with Illustrator's private editing data beside its pages — as editable
 * art: each page an artboard, layers from its optional content (Illustrator
 * marks each layer that way), paths with their fills and strokes, clipping
 * groups, gradients (from shadings), type with the file's own glyphs, and
 * images. Illustrator's private data is undocumented, so like every other
 * app that opens .ai files this reads the PDF part.
 */

interface GState {
  ctm: Mat;
  fillCS: ColorSpace;
  strokeCS: ColorSpace;
  fill: Paint;
  stroke: Paint;
  lineWidth: number;
  cap: 0 | 1 | 2;
  join: 0 | 1 | 2;
  miter: number;
  dash: number[];
  dashOffset: number;
  fillAlpha: number;
  strokeAlpha: number;
  blend: Blend;
  font: FontEntry | null;
  fontSize: number;
  charSpace: number;
  wordSpace: number;
  hscale: number;
  leading: number;
  rise: number;
  render: number;
  /** Clip groups opened at this state's level, closed when it is restored. */
  opened: number;
}

interface Container {
  items: Item[];
  /** The group it fills, if any (its children are `items`). */
  group: GroupItem | null;
  /** The q depth at which it closes. */
  depth: number;
  /** A shading painted into a clip group: makes a gradient-filled path of the clip. */
  shading?: Gradient | null;
}

const BLENDS: Record<string, Blend> = {
  Normal: 'normal', Compatible: 'normal', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten',
  ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference',
  Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity',
};

function colorPaint(c: Color): Paint {
  return { type: 'color', color: c };
}

const BLACK: Paint = { type: 'color', color: { space: 'gray', c: [0] } };

function initialState(ctm: Mat): GState {
  return {
    ctm,
    fillCS: DEVICE_GRAY,
    strokeCS: DEVICE_GRAY,
    fill: BLACK,
    stroke: BLACK,
    lineWidth: 1,
    cap: 0,
    join: 0,
    miter: 10,
    dash: [],
    dashOffset: 0,
    fillAlpha: 1,
    strokeAlpha: 1,
    blend: 'normal',
    font: null,
    fontSize: 1,
    charSpace: 0,
    wordSpace: 0,
    hscale: 1,
    leading: 0,
    rise: 0,
    render: 0,
    opened: 0,
  };
}

// ---- Shadings to gradients -----------------------------------------------------------------

/** Stops of a shading's function, exact for Illustrator's stitched exponential ramps. */
function shadingStops(doc: PdfDoc, sh: PdfDict, cs: ColorSpace): GradStop[] | null {
  const fnVal = sh.get('Function');
  const fn = makeFunction(doc, fnVal);
  if (!fn) return null;
  const domain = sh.has('Domain') ? doc.numbers(sh.get('Domain')) : [0, 1];
  const d0 = domain[0] ?? 0;
  const d1 = domain[1] ?? 1;
  const at = (t: number): GradStop => ({ t, color: cs.toColor(fn([d0 + t * (d1 - d0)])), opacity: 1 });
  // A stitching function's bounds are where Illustrator's stops are.
  const fd = doc.dict(fnVal);
  let ts: number[];
  if (fd && doc.resolve(fd.get('FunctionType')) === 3) {
    const bounds = doc.numbers(fd.get('Bounds'));
    const fdom = doc.numbers(fd.get('Domain'));
    const f0 = fdom[0] ?? 0;
    const f1 = fdom[1] ?? 1;
    ts = [f0, ...bounds, f1].map((b) => (b - d0) / (d1 - d0 || 1));
    // Illustrator's midpoints come as exponents; sample between stops to keep the curve.
    const subs = doc.array(fd.get('Functions')).map((x) => doc.dict(x));
    const nonlinear = subs.some((s) => s && doc.resolve(s.get('FunctionType')) === 2 && doc.resolve(s.get('N')) !== 1);
    if (nonlinear || subs.some((s) => s && doc.resolve(s.get('FunctionType')) !== 2)) {
      const more: number[] = [];
      for (let i = 0; i + 1 < ts.length; i++) for (let k = 1; k < 4; k++) more.push(ts[i] + ((ts[i + 1] - ts[i]) * k) / 4);
      ts = [...ts, ...more].sort((a, b) => a - b);
    }
  } else if (fd && doc.resolve(fd.get('FunctionType')) === 2 && (doc.resolve(fd.get('N')) ?? 1) === 1) {
    ts = [0, 1];
  } else {
    ts = Array.from({ length: 17 }, (_, i) => i / 16);
  }
  const stops = ts.map((t) => at(Math.min(1, Math.max(0, t))));
  return stops;
}

function shadingGradient(doc: PdfDoc, shVal: PdfValue, resources: PdfDict | null, ctm: Mat): Gradient | null {
  const sh = doc.dict(shVal);
  if (!sh) return null;
  const type = doc.resolve(sh.get('ShadingType'));
  if (type !== 2 && type !== 3) return null;
  const cs = colorSpace(doc, sh.get('ColorSpace'), resources);
  const stops = shadingStops(doc, sh, cs);
  if (!stops) return null;
  const c = doc.numbers(sh.get('Coords'));
  if (type === 2) {
    const [x0, y0, x1, y1] = c;
    const dx = x1 - x0;
    const dy = y1 - y0;
    return { type: 'linear', stops, matrix: mul([dx, dy, -dy, dx, x0, y0], ctm) };
  }
  const [x0, y0, r0, x1, y1, r1] = c;
  const r = r1 || 1;
  return {
    type: 'radial',
    stops,
    matrix: mul([r, 0, 0, r, x1, y1], ctm),
    focal: { x: (x0 - x1) / r, y: (y0 - y1) / r, r: r0 / r },
  };
}

// ---- Images --------------------------------------------------------------------------------

async function decodeImage(doc: PdfDoc, s: PdfStream, resources: PdfDict | null, stencilColor: Color | null): Promise<ImageEntry | null> {
  const d = s.dict;
  const w = doc.resolve(d.get('Width') ?? d.get('W'));
  const h = doc.resolve(d.get('Height') ?? d.get('H'));
  if (typeof w !== 'number' || typeof h !== 'number' || w < 1 || h < 1 || w * h > 100_000_000) return null;
  const isMask = doc.resolve(d.get('ImageMask') ?? d.get('IM')) === true;
  const bpc = isMask ? 1 : ((doc.resolve(d.get('BitsPerComponent') ?? d.get('BPC')) as number) || 8);
  const cs = isMask ? DEVICE_GRAY : colorSpace(doc, d.get('ColorSpace') ?? d.get('CS'), resources);
  const { data, codec } = decodeStream(doc, s);
  const entry: ImageEntry = { width: w, height: h, bitmap: null };

  // Soft mask
  let alpha: Uint8Array | null = null;
  const smask = doc.resolve(d.get('SMask'));
  if (smask instanceof PdfStream) {
    const sm = await decodeImage(doc, smask, resources, null);
    if (sm?.rgb || sm?.gray) alpha = resampleGray(sm, w, h);
    else if (sm?.bitmap) alpha = bitmapGray(sm.bitmap, w, h);
  }

  if (codec === 'DCTDecode') {
    entry.jpeg = data;
    const comps = cs.kind === 'cmyk' || cs.n === 4 ? 4 : cs.n === 1 ? 1 : 3;
    entry.jpegComponents = comps;
    const dec = doc.numbers(d.get('Decode') ?? d.get('D'));
    if (dec.length) entry.jpegDecode = dec;
    try {
      const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }));
      if (comps === 4 || alpha) {
        // Chromium shows CMYK JPEGs inverted when Adobe wrote them; draw and fix, and add the mask.
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h);
        if (alpha) for (let i = 0; i < w * h; i++) px.data[i * 4 + 3] = alpha[i];
        ctx.putImageData(px, 0, 0);
        entry.bitmap = c;
        if (alpha) entry.alpha = alpha;
      } else entry.bitmap = bmp;
    } catch {
      entry.bitmap = null;
    }
    return entry;
  }
  if (codec) return null;

  const decodeArr = doc.numbers(d.get('Decode') ?? d.get('D'));
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rgb = new Uint8Array(w * h * 3);
  const gray = cs.kind === 'gray' && !isMask;
  const n = cs.n;
  const rowBits = w * n * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  const maxV = (1 << bpc) - 1;
  const sample = (row: number, i: number) => {
    const bit = i * bpc;
    const p = row * rowBytes + (bit >> 3);
    if (bpc === 8) return data[p] ?? 0;
    if (bpc === 16) return data[p] ?? 0;
    if (bpc === 1) return ((data[p] ?? 0) >> (7 - (bit & 7))) & 1;
    if (bpc === 2) return ((data[p] ?? 0) >> (6 - (bit & 7))) & 3;
    if (bpc === 4) return ((data[p] ?? 0) >> (4 - (bit & 7))) & 15;
    return 0;
  };
  const max16 = bpc === 16 ? 255 : maxV;
  const colorKey = doc.resolve(d.get('Mask'));
  const keyRanges = Array.isArray(colorKey) ? doc.numbers(colorKey) : null;
  const stencilRgb = stencilColor ? toRgb255(stencilColor) : [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const comps: number[] = [];
      for (let k = 0; k < n; k++) comps.push(sample(y, x * n + k));
      if (isMask) {
        const v = decodeArr[0] === 1 ? 1 - comps[0] : comps[0];
        rgba[o] = stencilRgb[0];
        rgba[o + 1] = stencilRgb[1];
        rgba[o + 2] = stencilRgb[2];
        rgba[o + 3] = v ? 0 : 255;
        continue;
      }
      let a = 255;
      if (keyRanges && keyRanges.length >= 2 * n && comps.every((c, k) => c >= keyRanges[2 * k] && c <= keyRanges[2 * k + 1])) a = 0;
      let col: Color;
      if (cs.kind === 'indexed') col = cs.toColor([comps[0]]);
      else {
        const vals = comps.map((c, k) => {
          const lo = decodeArr[2 * k] ?? 0;
          const hi = decodeArr[2 * k + 1] ?? (cs.kind === 'lab' ? 100 : 1);
          return lo + (c / max16) * (hi - lo);
        });
        col = cs.toColor(vals);
      }
      const [r, g, b] = toRgb255(col);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = alpha ? alpha[y * w + x] : a;
      rgb[(y * w + x) * 3] = r;
      rgb[(y * w + x) * 3 + 1] = g;
      rgb[(y * w + x) * 3 + 2] = b;
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
  entry.bitmap = c;
  if (gray) {
    entry.gray = true;
    entry.rgb = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) entry.rgb[i] = rgb[i * 3];
  } else entry.rgb = rgb;
  if (isMask || keyRanges || alpha) {
    entry.alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) entry.alpha[i] = rgba[i * 4 + 3];
  }
  return entry;
}

function toRgb255(c: Color): number[] {
  if (c.space === 'gray') return [c.c[0] * 255, c.c[0] * 255, c.c[0] * 255];
  if (c.space === 'cmyk') return cmykToRgb(c.c[0], c.c[1], c.c[2], c.c[3]).map((v) => v * 255);
  return [c.c[0] * 255, c.c[1] * 255, c.c[2] * 255];
}

function resampleGray(src: ImageEntry, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const g = src.gray ? src.rgb! : null;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const i = sy * src.width + sx;
      out[y * w + x] = g ? g[i] : (src.rgb?.[i * 3] ?? 255);
    }
  }
  return out;
}

function bitmapGray(b: ImageBitmap | HTMLCanvasElement, w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(b, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = px[i * 4];
  return out;
}

// ---- The interpreter ------------------------------------------------------------------------

interface ReadContext {
  doc: PdfDoc;
  out: Doc;
  layersByName: Map<string, Layer>;
  defaultLayer: Layer | null;
  pending: Promise<void>[];
  images: Map<string, string>;
  notes: Set<string>;
  pageBase: Mat;
  /** DinObject ids already read. */
  objects: Set<number>;
}

const INLINE_ABBREV: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate',
  W: 'Width', G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', DCT: 'DCTDecode', LZW: 'LZWDecode',
};

function runContent(ctx: ReadContext, data: Uint8Array, resources: PdfDict | null, base: GState, root: Container, layer: { current: Layer | null; page: boolean }) {
  const { doc } = ctx;
  let gs: GState = { ...base, opened: 0 };
  const stack: GState[] = [];
  const containers: Container[] = [root];
  const cur = () => containers[containers.length - 1];
  let path: SubPath[] = [];
  let sub: SubPath | null = null;
  let pendingClip: 'nonzero' | 'evenodd' | null = null;
  let tm: Mat = IDENTITY;
  let tlm: Mat = IDENTITY;
  let textLine: { item: TextItem; font: FontEntry; size: number; baseInv: Mat; lineY: number; endX: number } | null = null;
  const markStack: (Layer | null | undefined)[] = [];
  // Inside art drawn on an earlier page too (DinObject marks).
  const suppress: boolean[] = [];
  const res = (cat: string, n: string) => doc.dict(resources?.get(cat))?.get(n);

  const pt = (x: number, y: number) => apply(gs.ctm, x, y);
  const node = (x: number, y: number): Node => {
    const p = pt(x, y);
    return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
  };
  // Where each group went, to replace it once it closes (layers can change in between).
  const homes = new Map<GroupItem, Item[]>();
  const emit = (it: Item) => {
    if (suppress.includes(true)) return;
    const c = cur();
    const list = c === root && layer.page ? (layer.current ??= layerNamed(ctx, 'Layer 1')).children : c.items;
    list.push(it);
    if (it.type === 'group') homes.set(it, list);
  };

  const closeContainer = () => {
    const c = containers.pop()!;
    if (!c.group) return;
    const g = c.group;
    g.children = c.items;
    if (c.shading && g.clip && g.children.length === 1 && g.children[0].type === 'path') {
      // clip + sh: a gradient-filled path, as Illustrator writes gradient fills.
      const p = g.children[0] as PathItem;
      const filled: PathItem = { ...p, fill: { type: 'gradient', gradient: c.shading }, opacity: g.opacity, blend: g.blend };
      replaceLast(g, filled);
      return;
    }
    if (g.clip && g.children.length === 1) {
      replaceLast(g, null);
      return;
    }
    // A clip that only covers the page (Illustrator clips each layer's art to its artboard) isn't art: unwrap it.
    if (g.clip && coversPage(g.children[0]) && insideClip(g)) {
      const list = homes.get(g);
      const i = list ? list.lastIndexOf(g) : -1;
      if (list && i >= 0) {
        const kids = g.children.slice(1);
        list.splice(i, 1, ...kids);
        for (const k of kids) if (k.type === 'group') homes.set(k, list);
      }
      return;
    }
    if (g.children.length === 0) replaceLast(g, null);
  };
  const coversPage = (clip: Item | undefined): boolean => {
    const ab = ctx.out.artboards[ctx.out.artboards.length - 1];
    if (!ab || clip?.type !== 'path' || clip.paths.length !== 1) return false;
    const ns = clip.paths[0].nodes;
    if (ns.length !== 4 || ns.some((n) => n.ix !== n.x || n.iy !== n.y || n.ox !== n.x || n.oy !== n.y)) return false;
    const xs = ns.map((n) => n.x);
    const ys = ns.map((n) => n.y);
    const axis = ns.every((n, i) => {
      const m = ns[(i + 1) % 4];
      return Math.abs(n.x - m.x) < 0.01 || Math.abs(n.y - m.y) < 0.01;
    });
    const tol = 1;
    return axis && Math.min(...xs) <= ab.x + tol && Math.min(...ys) <= ab.y + tol && Math.max(...xs) >= ab.x + ab.w - tol && Math.max(...ys) >= ab.y + ab.h - tol;
  };
  // Whether the art in a clip group stays within its clip anyway (so the clip cuts nothing off).
  const insideClip = (g: GroupItem): boolean => {
    const c = itemBounds(g.children[0], ctx.out.res);
    const tol = 2;
    return g.children.slice(1).every((k) => {
      const b = visualBounds(k, ctx.out.res);
      return isEmpty(b) || (b.x >= c.x - tol && b.y >= c.y - tol && b.x + b.w <= c.x + c.w + tol && b.y + b.h <= c.y + c.h + tol);
    });
  };
  const replaceLast = (g: GroupItem, by: Item | null) => {
    const list = homes.get(g);
    const i = list ? list.lastIndexOf(g) : -1;
    if (list && i >= 0) {
      if (by) list[i] = by;
      else list.splice(i, 1);
    }
  };

  const openClip = (evenOdd: boolean) => {
    if (!path.length) return;
    const clipPath: PathItem = { id: newId(), type: 'path', name: '', opacity: 1, blend: 'normal', paths: path, fill: NONE, stroke: defaultStroke(), evenOdd };
    const g: GroupItem = { id: newId(), type: 'group', name: '', opacity: 1, blend: 'normal', clip: true, children: [] };
    emit(g);
    containers.push({ items: [clipPath], group: g, depth: stack.length });
    gs.opened++;
  };

  const strokeOf = (): Stroke => {
    const k = matScale(gs.ctm);
    return {
      paint: gs.stroke,
      width: gs.lineWidth * k || (gs.lineWidth === 0 ? 0 : 0.1),
      cap: gs.cap,
      join: gs.join,
      miter: gs.miter,
      dash: gs.dash.map((d) => d * k),
      dashOffset: gs.dashOffset * k,
    };
  };

  const paint = (fill: boolean, stroke: boolean, evenOdd: boolean, close: boolean) => {
    if (close && sub) sub.closed = true;
    const paths = path.filter((s) => s.nodes.length > 0);
    if (paths.length && (fill || stroke)) {
      const it: PathItem = {
        id: newId(),
        type: 'path',
        name: '',
        opacity: fill ? gs.fillAlpha : gs.strokeAlpha,
        blend: gs.blend,
        paths,
        fill: fill ? gs.fill : NONE,
        stroke: stroke ? strokeOf() : { ...strokeOf(), paint: NONE },
        evenOdd,
      };
      emit(it);
    }
    if (pendingClip) openClip(pendingClip === 'evenodd');
    pendingClip = null;
    path = [];
    sub = null;
  };

  const setColor = (which: 'fill' | 'stroke', ops: PdfValue[]) => {
    const cs = which === 'fill' ? gs.fillCS : gs.strokeCS;
    const last = ops[ops.length - 1];
    if (cs.kind === 'pattern' && last instanceof PdfName) {
      const pat = doc.dict(res('Pattern', last.name));
      const p = pat ? patternPaint(pat) : null;
      gs = { ...gs, [which]: p ?? colorPaint({ space: 'gray', c: [0.5] }) };
      return;
    }
    const nums = ops.filter((v): v is number => typeof v === 'number');
    gs = { ...gs, [which]: colorPaint(cs.toColor(nums)) };
  };

  const patternPaint = (pat: PdfDict): Paint | null => {
    const type = doc.resolve(pat.get('PatternType'));
    const m = doc.numbers(pat.get('Matrix'));
    const pm: Mat = m.length === 6 ? (m as Mat) : IDENTITY;
    if (type === 2) {
      const g = shadingGradient(doc, pat.get('Shading') ?? null, resources, mul(pm, ctx.pageBase));
      if (g) return { type: 'gradient', gradient: g };
    }
    ctx.notes.add('Pattern fills show as gray.');
    return null;
  };

  const setGState = (d: PdfDict) => {
    const next = { ...gs };
    for (const [k, v0] of d) {
      const v = doc.resolve(v0);
      if (k === 'LW' && typeof v === 'number') next.lineWidth = v;
      else if (k === 'LC' && typeof v === 'number') next.cap = Math.min(2, Math.max(0, v)) as 0 | 1 | 2;
      else if (k === 'LJ' && typeof v === 'number') next.join = Math.min(2, Math.max(0, v)) as 0 | 1 | 2;
      else if (k === 'ML' && typeof v === 'number') next.miter = v;
      else if (k === 'D' && Array.isArray(v)) {
        next.dash = doc.numbers(v[0]);
        next.dashOffset = typeof v[1] === 'number' ? v[1] : 0;
      } else if (k === 'CA' && typeof v === 'number') next.strokeAlpha = v;
      else if (k === 'ca' && typeof v === 'number') next.fillAlpha = v;
      else if (k === 'BM') {
        const n = v instanceof PdfName ? v.name : Array.isArray(v) && v[0] instanceof PdfName ? v[0].name : 'Normal';
        next.blend = BLENDS[n] ?? 'normal';
      } else if (k === 'SMask' && v instanceof Map) ctx.notes.add('Opacity masks show without their masks.');
      else if (k === 'Font' && Array.isArray(v)) {
        next.font = loadFont(doc, v[0] ?? null, ctx.out.res.fonts);
        next.fontSize = typeof v[1] === 'number' ? v[1] : 1;
      }
    }
    gs = next;
  };

  // ---- Text ----
  const showText = (str: Uint8Array) => {
    const font = gs.font;
    if (!font) return;
    const fs = gs.fontSize;
    const th = gs.hscale;
    // Text space → device: [fs*th 0 0 fs 0 rise] × Tm × CTM. The item keeps Tm×CTM without the size.
    const trm = mul(tm, gs.ctm);
    const scale = Math.hypot(trm[2], trm[3]) || 1;
    const size = fs * scale;
    // Text item space: y down, in points at `size`.
    const flip: Mat = [1, 0, 0, -1, 0, 0];
    const itemM = mul(mul(flip, [1 / scale, 0, 0, 1 / scale, 0, 0]), trm);
    const lineY = tm[5];
    const render = gs.render;
    const fill = render === 0 || render === 2 || render === 4 || render === 6 ? gs.fill : NONE;
    const stroke = render === 1 || render === 2 || render === 5 || render === 6 ? strokeOf() : { ...strokeOf(), paint: NONE };
    const sameStyle = (t: NonNullable<typeof textLine>) =>
      t.font === font && Math.abs(t.size - size) < 1e-3 && Math.abs(t.lineY - lineY) < 1e-3 && t.item.placed?.render === render && samePaint(t.item.runs[0].fill, fill);
    let line = textLine;
    if (line) {
      // Another string far along the same baseline is another piece of type.
      const p = apply(mul(tm, gs.ctm), 0, gs.rise);
      const o = apply(line.baseInv, p.x, p.y);
      if (line.item.placed?.glyphs.length && (o.x - line.endX > size * 1.5 || o.x < line.endX - size * 0.6)) line = null;
    }
    if (!line || !sameStyle(line)) {
      const item: TextItem = {
        id: newId(),
        type: 'text',
        name: '',
        opacity: render === 1 ? gs.strokeAlpha : gs.fillAlpha,
        blend: gs.blend,
        matrix: itemM,
        align: 'left',
        leading: 0,
        runs: [
          {
            text: '',
            font: font.ref,
            size,
            fill,
            stroke,
            tracking: size ? (gs.charSpace * scale * 1000) / size : 0,
            hscale: th,
            rise: gs.rise * scale,
          },
        ],
        placed: { text: '', font: font.key, size, glyphs: [], hscale: th, render: (render > 3 ? render - 4 : render) as 0 | 1 | 2 | 3 },
      };
      if (render !== 7) emit(item);
      line = { item, font, size, baseInv: invert(itemM), lineY, endX: 0 };
      textLine = line;
    }
    const item = line.item;
    const run = item.runs[0];
    const placed = item.placed!;
    const adv = (tx: number) => {
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    };
    const pushGlyph = (code: number, bytes: number) => {
      const ch = font.toUnicode(code);
      const origin = apply(mul(tm, gs.ctm), 0, gs.rise);
      const local = apply(line!.baseInv, origin.x, origin.y);
      placed.glyphs.push({ code, bytes, x: local.x, ch });
      run.text += ch;
      placed.text += ch;
      const w0 = font.width(code) / 1000;
      const wordSp = bytes === 1 && code === 32 ? gs.wordSpace : 0;
      adv((w0 * fs + gs.charSpace + wordSp) * th);
      const end = apply(mul(tm, gs.ctm), 0, gs.rise);
      line!.endX = apply(line!.baseInv, end.x, end.y).x;
    };
    const step = font.bytes;
    for (let i = 0; i + step <= str.length; i += step) {
      const code = step === 2 ? (str[i] << 8) | str[i + 1] : str[i];
      pushGlyph(code, step);
    }
  };

  const showArray = (arr: PdfValue[]) => {
    for (const v of arr) {
      if (v instanceof Uint8Array) showText(v);
      else if (typeof v === 'number') {
        const tx = (-v / 1000) * gs.fontSize * gs.hscale;
        // A big negative kern is a word space in disguise: a space in the text that draws nothing.
        const line = textLine;
        if (line && gs.font && -v > 200 && !line.item.runs[0].text.endsWith(' ')) {
          const origin = apply(mul(tm, gs.ctm), 0, gs.rise);
          const local = apply(line.baseInv, origin.x, origin.y);
          line.item.runs[0].text += ' ';
          if (line.item.placed) {
            line.item.placed.text += ' ';
            line.item.placed.glyphs.push({ code: -1, bytes: 0, x: local.x, ch: ' ' });
          }
        }
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
  };

  const doXObject = (n: string) => {
    const xo = doc.resolve(res('XObject', n));
    if (!(xo instanceof PdfStream)) return;
    const sub = doc.name(xo.dict.get('Subtype'));
    if (sub === 'Image') {
      const key = n + ':' + (res('XObject', n) instanceof PdfRef ? (res('XObject', n) as PdfRef).key : String(newId()));
      let imgKey = ctx.images.get(key);
      if (!imgKey) {
        imgKey = `img${newId()}`;
        ctx.images.set(key, imgKey);
        const k = imgKey;
        const stencil = doc.resolve(xo.dict.get('ImageMask')) === true && gs.fill.type === 'color' ? gs.fill.color : null;
        ctx.pending.push(
          decodeImage(doc, xo, resources, stencil).then((e) => {
            if (e) ctx.out.res.images.set(k, e);
          }),
        );
      }
      emit({ id: newId(), type: 'image', name: '', opacity: gs.fillAlpha, blend: gs.blend, matrix: mul([1, 0, 0, -1, 0, 1], gs.ctm), image: imgKey });
      return;
    }
    if (sub === 'Form') {
      const fm = doc.numbers(xo.dict.get('Matrix'));
      const m: Mat = fm.length === 6 ? (fm as Mat) : IDENTITY;
      const formRes = doc.dict(xo.dict.get('Resources')) ?? resources;
      const isGroup = !!doc.dict(xo.dict.get('Group'));
      const data = decodeStream(doc, xo).data;
      const inner = { ...gs, ctm: mul(m, gs.ctm), opened: 0 };
      if (isGroup && (gs.fillAlpha < 1 || gs.blend !== 'normal')) {
        const g: GroupItem = { id: newId(), type: 'group', name: '', opacity: gs.fillAlpha, blend: gs.blend, clip: false, children: [] };
        emit(g);
        const c: Container = { items: [], group: g, depth: -1 };
        const st = { ...inner, fillAlpha: 1, strokeAlpha: 1, blend: 'normal' as Blend };
        runContent(ctx, data, formRes, st, c, { current: null, page: false });
        g.children = c.items;
        if (!g.children.length) replaceLast(g, null);
      } else {
        const c: Container = { items: [], group: null, depth: -1 };
        runContent(ctx, data, formRes, inner, c, { current: null, page: false });
        for (const it of c.items) emit(it);
      }
    }
  };

  const lex = new Lexer(data);
  const parser = new Parser(lex);
  let operands: PdfValue[] = [];
  let guard = 0;
  for (;;) {
    if (++guard > 5_000_000) break;
    const t = parser.value();
    if (t === undefined) break;
    if (!(t instanceof PdfOp)) {
      operands.push(t);
      continue;
    }
    const op = t.op;
    const o = operands;
    operands = [];
    const n = (i: number) => (typeof o[i] === 'number' ? (o[i] as number) : 0);
    switch (op) {
      case 'q':
        stack.push(gs);
        gs = { ...gs, opened: 0 };
        break;
      case 'Q': {
        // Clip groups opened at the level being left end here.
        while (containers.length > 1 && cur().depth >= stack.length && cur().depth >= 0) closeContainer();
        gs = stack.pop() ?? gs;
        break;
      }
      case 'cm':
        gs = { ...gs, ctm: mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm) };
        break;
      case 'w': gs = { ...gs, lineWidth: n(0) }; break;
      case 'J': gs = { ...gs, cap: Math.min(2, Math.max(0, n(0))) as 0 | 1 | 2 }; break;
      case 'j': gs = { ...gs, join: Math.min(2, Math.max(0, n(0))) as 0 | 1 | 2 }; break;
      case 'M': gs = { ...gs, miter: n(0) }; break;
      case 'd': gs = { ...gs, dash: Array.isArray(o[0]) ? (o[0] as PdfValue[]).filter((x): x is number => typeof x === 'number') : [], dashOffset: n(1) }; break;
      case 'gs': {
        const d = doc.dict(o[0] instanceof PdfName ? res('ExtGState', o[0].name) : null);
        if (d) setGState(d);
        break;
      }
      case 'm':
        sub = { nodes: [node(n(0), n(1))], closed: false };
        path.push(sub);
        break;
      case 'l':
        if (!sub) {
          sub = { nodes: [], closed: false };
          path.push(sub);
        }
        sub.nodes.push(node(n(0), n(1)));
        break;
      case 'c': case 'v': case 'y': {
        if (!sub || !sub.nodes.length) break;
        const prev = sub.nodes[sub.nodes.length - 1];
        let c1: { x: number; y: number };
        let c2: { x: number; y: number };
        let end: { x: number; y: number };
        if (op === 'c') {
          c1 = pt(n(0), n(1));
          c2 = pt(n(2), n(3));
          end = pt(n(4), n(5));
        } else if (op === 'v') {
          c1 = { x: prev.x, y: prev.y };
          c2 = pt(n(0), n(1));
          end = pt(n(2), n(3));
        } else {
          c1 = pt(n(0), n(1));
          end = pt(n(2), n(3));
          c2 = end;
        }
        prev.ox = c1.x;
        prev.oy = c1.y;
        sub.nodes.push({ x: end.x, y: end.y, ix: c2.x, iy: c2.y, ox: end.x, oy: end.y });
        break;
      }
      case 'h':
        if (sub) {
          sub.closed = true;
          // A closing point on the start merges into it.
          const a = sub.nodes[0];
          const z = sub.nodes[sub.nodes.length - 1];
          if (sub.nodes.length > 2 && Math.abs(a.x - z.x) < 1e-6 && Math.abs(a.y - z.y) < 1e-6) {
            a.ix = z.ix;
            a.iy = z.iy;
            sub.nodes.pop();
          }
          sub = null;
        }
        break;
      case 're': {
        const [x, y, w, h] = [n(0), n(1), n(2), n(3)];
        path.push({ nodes: [node(x, y), node(x + w, y), node(x + w, y + h), node(x, y + h)], closed: true });
        sub = null;
        break;
      }
      case 'S': paint(false, true, false, false); break;
      case 's': paint(false, true, false, true); break;
      case 'f': case 'F': paint(true, false, false, false); break;
      case 'f*': paint(true, false, true, false); break;
      case 'B': paint(true, true, false, false); break;
      case 'B*': paint(true, true, true, false); break;
      case 'b': paint(true, true, false, true); break;
      case 'b*': paint(true, true, true, true); break;
      case 'n': paint(false, false, false, false); break;
      case 'W': pendingClip = 'nonzero'; break;
      case 'W*': pendingClip = 'evenodd'; break;
      case 'CS': case 'cs': {
        const cs = colorSpace(doc, o[0] ?? null, resources);
        const p = cs.kind === 'pattern' ? colorPaint({ space: 'gray', c: [0.5] }) : colorPaint(cs.toColor(cs.initial));
        gs = op === 'CS' ? { ...gs, strokeCS: cs, stroke: p } : { ...gs, fillCS: cs, fill: p };
        break;
      }
      case 'SC': case 'SCN': setColor('stroke', o); break;
      case 'sc': case 'scn': setColor('fill', o); break;
      case 'G': gs = { ...gs, strokeCS: DEVICE_GRAY, stroke: colorPaint(DEVICE_GRAY.toColor([n(0)])) }; break;
      case 'g': gs = { ...gs, fillCS: DEVICE_GRAY, fill: colorPaint(DEVICE_GRAY.toColor([n(0)])) }; break;
      case 'RG': gs = { ...gs, strokeCS: DEVICE_RGB, stroke: colorPaint(DEVICE_RGB.toColor([n(0), n(1), n(2)])) }; break;
      case 'rg': gs = { ...gs, fillCS: DEVICE_RGB, fill: colorPaint(DEVICE_RGB.toColor([n(0), n(1), n(2)])) }; break;
      case 'K': gs = { ...gs, strokeCS: DEVICE_CMYK, stroke: colorPaint(DEVICE_CMYK.toColor([n(0), n(1), n(2), n(3)])) }; break;
      case 'k': gs = { ...gs, fillCS: DEVICE_CMYK, fill: colorPaint(DEVICE_CMYK.toColor([n(0), n(1), n(2), n(3)])) }; break;
      case 'sh': {
        const g = o[0] instanceof PdfName ? shadingGradient(doc, res('Shading', o[0].name) ?? null, resources, gs.ctm) : null;
        const c = cur();
        if (g && c.group?.clip && c.items.length === 1) c.shading = g;
        else if (g) {
          // A shading over everything: fill the page with it.
          const ab = ctx.out.artboards[ctx.out.artboards.length - 1];
          const r = ab ?? { x: 0, y: 0, w: 612, h: 792 };
          const pts: Node[] = [
            [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
          ].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y }));
          emit({ id: newId(), type: 'path', name: '', opacity: gs.fillAlpha, blend: gs.blend, paths: [{ nodes: pts, closed: true }], fill: { type: 'gradient', gradient: g }, stroke: defaultStroke(), evenOdd: false });
        } else ctx.notes.add('Some shadings (gradient meshes) can’t be shown yet.');
        break;
      }
      case 'Do':
        if (o[0] instanceof PdfName) doXObject(o[0].name);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        textLine = null;
        break;
      case 'ET':
        textLine = null;
        break;
      case 'Tc': gs = { ...gs, charSpace: n(0) }; break;
      case 'Tw': gs = { ...gs, wordSpace: n(0) }; break;
      case 'Tz': gs = { ...gs, hscale: n(0) / 100 }; break;
      case 'TL': gs = { ...gs, leading: n(0) }; break;
      case 'Ts': gs = { ...gs, rise: n(0) }; break;
      case 'Tr': gs = { ...gs, render: n(0) }; break;
      case 'Tf': {
        const f = o[0] instanceof PdfName ? res('Font', o[0].name) : undefined;
        gs = { ...gs, font: f !== undefined ? loadFont(doc, f, ctx.out.res.fonts) : null, fontSize: n(1) };
        break;
      }
      case 'Td':
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        gs = { ...gs, leading: -n(1) };
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        tm = tlm;
        textLine = null;
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        break;
      case 'Tj':
        if (o[0] instanceof Uint8Array) showText(o[0]);
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        if (o[0] instanceof Uint8Array) showText(o[0]);
        break;
      case '"':
        gs = { ...gs, wordSpace: n(0), charSpace: n(1) };
        tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        if (o[2] instanceof Uint8Array) showText(o[2]);
        break;
      case 'TJ':
        if (Array.isArray(o[0])) showArray(o[0]);
        break;
      case 'BDC': case 'BMC': {
        if (op === 'BDC' && o[0] instanceof PdfName && o[0].name === 'DinObject') {
          const id = doc.dict(o[1] ?? null)?.get('Id');
          const seen = typeof id === 'number' && ctx.objects.has(id);
          if (typeof id === 'number') ctx.objects.add(id);
          markStack.push(undefined);
          suppress.push(seen);
          break;
        }
        suppress.push(false);
        let l: Layer | null = null;
        if (op === 'BDC' && o[0] instanceof PdfName && o[0].name === 'OC' && layer.page) {
          const prop = o[1] instanceof PdfName ? doc.dict(res('Properties', o[1].name)) : doc.dict(o[1] ?? null);
          const nm = prop ? textString(doc.resolve(prop.get('Name')) ?? undefined) : '';
          if (nm) l = layerNamed(ctx, nm);
        }
        markStack.push(l ? layer.current : undefined);
        if (l) layer.current = l;
        break;
      }
      case 'EMC': {
        suppress.pop();
        const prev = markStack.pop();
        if (prev !== undefined) layer.current = prev;
        break;
      }
      case 'BI': {
        // Inline image: dict until ID, data until EI.
        const d: PdfDict = new Map();
        for (;;) {
          const k = parser.value();
          if (k === undefined || (k instanceof PdfOp && k.op === 'ID')) break;
          if (!(k instanceof PdfName)) continue;
          const v = parser.value();
          if (v === undefined || v instanceof PdfOp) break;
          const full = INLINE_ABBREV[k.name] ?? k.name;
          d.set(full, v instanceof PdfName && INLINE_ABBREV[v.name] ? new PdfName(INLINE_ABBREV[v.name]) : v);
        }
        parser.sync();
        let start = lex.pos;
        if (data[start] === 32 || data[start] === 10 || data[start] === 13) start++;
        let end = start;
        while (end < data.length - 2) {
          if (data[end] === 69 && data[end + 1] === 73 && (end + 2 >= data.length || data[end + 2] <= 32) && (data[end - 1] <= 32)) break;
          end++;
        }
        lex.pos = end + 2;
        const s = new PdfStream(d, data.subarray(start, Math.max(start, end - 1)));
        const imgKey = `img${newId()}`;
        const stencil = d.get('ImageMask') === true && gs.fill.type === 'color' ? gs.fill.color : null;
        ctx.pending.push(
          decodeImage(doc, s, resources, stencil).then((e) => {
            if (e) ctx.out.res.images.set(imgKey, e);
          }),
        );
        emit({ id: newId(), type: 'image', name: '', opacity: gs.fillAlpha, blend: gs.blend, matrix: mul([1, 0, 0, -1, 0, 1], gs.ctm), image: imgKey });
        break;
      }
      default:
        break;
    }
  }
  while (containers.length > 1) closeContainer();
}

function samePaint(a: Paint, b: Paint): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'color' && b.type === 'color') return a.color.space === b.color.space && a.color.c.every((v, i) => v === b.color.c[i]);
  return a.type !== 'gradient';
}

function boxOf(doc: PdfDoc, page: PdfDict): number[] {
  for (const k of ['TrimBox', 'CropBox', 'MediaBox']) {
    const b = doc.numbers(page.get(k));
    if (b.length === 4 && b[2] !== b[0] && b[3] !== b[1]) return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  }
  return [0, 0, 612, 792];
}

/** Read a PDF (or PDF-compatible .ai) into a document. Throws a sentence a person can read. */
export async function readPdf(bytes: Uint8Array): Promise<Doc> {
  const pdf = new PdfDoc(bytes);
  const pages = pdf.pages();
  if (!pages.length) throw new Error('It has no pages.');
  const out: Doc = { artboards: [], layers: [], res: { images: new Map(), fonts: new Map() }, mode: 'rgb', units: 'pt', notes: [] };
  const ctx: ReadContext = { doc: pdf, out, layersByName: new Map(), defaultLayer: null, pending: [], images: new Map(), notes: new Set(), pageBase: IDENTITY, objects: new Set() };
  const isAi = !!pdf.dict(pages[0].get('PieceInfo'))?.get('Illustrator');
  let x = 0;
  let cmykSeen = 0;
  for (let i = 0; i < pages.length && i < 1000; i++) {
    const page = pages[i];
    const [x0, y0, x1, y1] = boxOf(pdf, page);
    const w = x1 - x0;
    const h = y1 - y0;
    const din = pdf.dict(page.get('DinArtboard'));
    const dx = din ? pdf.resolve(din.get('X')) : null;
    const dy = din ? pdf.resolve(din.get('Y')) : null;
    const ax = typeof dx === 'number' ? dx : x;
    const ay = typeof dy === 'number' ? dy : 0;
    const name = din?.get('Name') !== undefined ? textString(pdf.resolve(din.get('Name')) ?? undefined) : pages.length > 1 || isAi ? `Artboard ${i + 1}` : 'Artboard 1';
    const ab: Artboard = { id: newId(), name, x: ax, y: ay, w, h };
    out.artboards.push(ab);
    const base: Mat = [1, 0, 0, -1, ax - x0, ay + y1];
    ctx.pageBase = base;
    x = Math.max(x, ax + w + 20);
    const resources = pdf.dict(page.get('Resources'));
    const contents = pdf.resolve(page.get('Contents'));
    const streams = Array.isArray(contents) ? contents.map((c) => pdf.resolve(c)) : [contents];
    const parts: Uint8Array[] = [];
    for (const s of streams) {
      if (s instanceof PdfStream) {
        try {
          parts.push(decodeStream(pdf, s).data);
        } catch (e) {
          ctx.notes.add(e instanceof Error ? e.message : 'Part of a page couldn’t be read.');
        }
      }
    }
    const total = parts.reduce((s, p) => s + p.length + 1, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
      data[o++] = 10;
    }
    const s = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 200000)));
    cmykSeen += (s.match(/\bk\b|\bK\b/g) ?? []).length - (s.match(/\brg\b|\bRG\b/g) ?? []).length;
    const layer = { current: null, page: true };
    runContent(ctx, data, resources, initialState(base), { items: [], group: null, depth: -1 }, layer);
  }
  await Promise.all(ctx.pending);
  // Layers that start hidden.
  const ocp = pdf.dict(pdf.catalog.get('OCProperties'));
  const off = pdf.array(pdf.dict(ocp?.get('D'))?.get('OFF'));
  for (const r of off) {
    const nm = textString(pdf.resolve(pdf.dict(r)?.get('Name')) ?? undefined);
    const l = ctx.layersByName.get(nm);
    if (l) l.hidden = true;
  }
  // Illustrator lists layers top first; content streams draw bottom first, which is our order.
  out.layers = out.layers.filter((l) => l.children.length || out.layers.length === 1);
  if (!out.layers.length) out.layers.push(newLayer('Layer 1', 0));
  out.mode = cmykSeen > 0 ? 'cmyk' : 'rgb';
  out.notes = [...ctx.notes];
  return out;
}

function layerNamed(ctx: ReadContext, name: string): Layer {
  let l = ctx.layersByName.get(name);
  if (!l) {
    l = newLayer(name, ctx.out.layers.length);
    ctx.layersByName.set(name, l);
    ctx.out.layers.push(l);
  }
  return l;
}
