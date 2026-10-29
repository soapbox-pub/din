import type { BlendMode, Psd } from 'ag-psd';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { blankLayer, ctx2d, groupLayer, makeCanvas, opaqueBounds, type Doc, type Layer, type Mask, type TextData } from './model';
import { flatten, renderLayerAlone, renderLayers } from './render';

/**
 * OpenRaster (.ora), the layered format GIMP, Krita, MyPaint and Pinta share:
 * a zip of stack.xml (the layer tree), a PNG per layer, a thumbnail and the
 * flattened picture. https://www.openraster.org/
 *
 * Layers are pixels and stacks only, so anything else is drawn into a
 * layer's pixels on save: masks, effects, fill opacity, clipping, and
 * adjustment layers (as what they make of the layers under them). Type
 * layers keep their text in a Din attribute the other apps leave alone.
 */

export const ORA_MIME = 'image/openraster';
const DIN_NS = 'urn:x-din:photo-editor';
const MAX_SIDE = 16384;
const THUMB_SIDE = 256;

// ---- Blend modes -------------------------------------------------------------

/** OpenRaster's own (svg:) modes, and Krita's names for the rest. */
const TO_ORA: Partial<Record<BlendMode, string>> = {
  normal: 'svg:src-over',
  multiply: 'svg:multiply',
  screen: 'svg:screen',
  overlay: 'svg:overlay',
  darken: 'svg:darken',
  lighten: 'svg:lighten',
  'color dodge': 'svg:color-dodge',
  'color burn': 'svg:color-burn',
  'hard light': 'svg:hard-light',
  'soft light': 'svg:soft-light',
  difference: 'svg:difference',
  color: 'svg:color',
  luminosity: 'svg:luminosity',
  hue: 'svg:hue',
  saturation: 'svg:saturation',
  'linear dodge': 'svg:plus',
  dissolve: 'krita:dissolve',
  'linear burn': 'krita:linear_burn',
  'darker color': 'krita:darker color',
  'lighter color': 'krita:lighter color',
  'vivid light': 'krita:vivid_light',
  'linear light': 'krita:linear light',
  'pin light': 'krita:pin_light',
  'hard mix': 'krita:hard mix',
  exclusion: 'krita:exclusion',
  subtract: 'krita:subtract',
  divide: 'krita:divide',
};

const FROM_ORA = new Map<string, BlendMode>(Object.entries(TO_ORA).map(([mode, op]) => [op, mode as BlendMode]));
for (const [op, mode] of [
  ['krita:add', 'linear dodge'],
  ['krita:linear_dodge', 'linear dodge'],
  ['krita:hard_mix_photoshop', 'hard mix'],
  ['krita:hard_mix', 'hard mix'],
  ['krita:linear_light', 'linear light'],
  ['krita:darker_color', 'darker color'],
  ['krita:lighter_color', 'lighter color'],
] as const) {
  FROM_ORA.set(op, mode);
}
for (const op of Object.values(TO_ORA)) {
  // Krita names its svg: modes plainly too ("krita:multiply").
  if (op.startsWith('svg:')) FROM_ORA.set(`krita:${op.slice(4)}`, FROM_ORA.get(op)!);
}

/** A composite-op as a blend mode; ones the editor doesn't have draw as normal. */
export const blendFromOra = (op: string | null): BlendMode => (op && FROM_ORA.get(op.trim().toLowerCase())) || 'normal';
export const blendToOra = (mode: BlendMode): string => TO_ORA[mode] ?? 'svg:src-over';

// ---- stack.xml ---------------------------------------------------------------

interface OraCommon {
  name: string;
  opacity: number;
  hidden: boolean;
  op: string;
  locked: boolean;
}

export type OraNode =
  | (OraCommon & { type: 'stack'; isolated: boolean; children: OraNode[] })
  | (OraCommon & { type: 'layer'; src: string; x: number; y: number; text: TextData | null });

export interface OraImage {
  width: number;
  height: number;
  /** Pixels per inch. */
  xres: number;
  yres: number;
  /** Top of the stack first, as in the file. */
  nodes: OraNode[];
}

const esc = (s: string) =>
  s.replace(/[&<>"\n\r\t]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' })[c]!);

function attrs(pairs: [string, string | number | null][]): string {
  return pairs
    .filter((p): p is [string, string | number] => p[1] !== null)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
}

function nodeXml(n: OraNode, indent: string): string {
  const common: [string, string | number | null][] = [
    ['name', n.name],
    ['visibility', n.hidden ? 'hidden' : 'visible'],
    ['opacity', Number(n.opacity.toFixed(4))],
  ];
  if (n.type === 'layer') {
    const a = attrs([
      ...common,
      ['src', n.src],
      ['x', Math.round(n.x)],
      ['y', Math.round(n.y)],
      ['composite-op', n.op],
      ['edit-locked', n.locked ? 'true' : null],
      ['din:text', n.text ? JSON.stringify(n.text) : null],
    ]);
    return `${indent}<layer${a}/>\n`;
  }
  const a = attrs([...common, ['isolation', n.isolated ? 'isolate' : 'auto'], ['composite-op', n.op], ['edit-locked', n.locked ? 'true' : null]]);
  return `${indent}<stack${a}>\n${n.children.map((c) => nodeXml(c, `${indent}  `)).join('')}${indent}</stack>\n`;
}

export function stackXml(img: OraImage): string {
  const head = attrs([
    ['version', '0.0.6'],
    ['w', img.width],
    ['h', img.height],
    ['xres', Math.max(1, Math.round(img.xres))],
    ['yres', Math.max(1, Math.round(img.yres))],
  ]);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<image${head} xmlns:din="${DIN_NS}">\n  <stack>\n` +
    img.nodes.map((n) => nodeXml(n, '    ')).join('') +
    '  </stack>\n</image>\n'
  );
}

function num(v: string | null, fallback: number): number {
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function textAttr(v: string | null): TextData | null {
  if (!v) return null;
  try {
    const t: unknown = JSON.parse(v);
    if (typeof t !== 'object' || t === null) return null;
    const o = t as Record<string, unknown>;
    if (typeof o.text !== 'string' || typeof o.font !== 'string' || typeof o.size !== 'number' || typeof o.color !== 'string') return null;
    if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
    return {
      text: o.text,
      font: o.font,
      size: o.size,
      color: o.color,
      bold: o.bold === true,
      italic: o.italic === true,
      align: o.align === 'center' || o.align === 'right' ? o.align : 'left',
      x: o.x,
      y: o.y,
    };
  } catch {
    return null;
  }
}

function parseNodes(parent: Element): OraNode[] {
  const out: OraNode[] = [];
  for (const el of Array.from(parent.children)) {
    const common: OraCommon = {
      name: el.getAttribute('name') ?? '',
      opacity: Math.min(1, Math.max(0, num(el.getAttribute('opacity'), 1))),
      hidden: el.getAttribute('visibility') === 'hidden',
      op: el.getAttribute('composite-op') ?? 'svg:src-over',
      locked: el.getAttribute('edit-locked') === 'true',
    };
    if (el.localName === 'stack') {
      out.push({ ...common, type: 'stack', isolated: el.getAttribute('isolation') !== 'auto', children: parseNodes(el) });
    } else if (el.localName === 'layer') {
      const src = el.getAttribute('src');
      if (!src) continue;
      out.push({
        ...common,
        type: 'layer',
        src,
        x: Math.round(num(el.getAttribute('x'), 0)),
        y: Math.round(num(el.getAttribute('y'), 0)),
        text: textAttr(el.getAttributeNS(DIN_NS, 'text')),
      });
    }
  }
  return out;
}

export function parseStackXml(xml: string): OraImage {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const image = dom.documentElement;
  if (dom.getElementsByTagName('parsererror').length || image.localName !== 'image') {
    throw new Error('Its stack.xml isn’t well-formed.');
  }
  const width = Math.round(num(image.getAttribute('w'), 0));
  const height = Math.round(num(image.getAttribute('h'), 0));
  if (width < 1 || height < 1) throw new Error('Its stack.xml has no size.');
  const root = Array.from(image.children).find((e) => e.localName === 'stack');
  return {
    width,
    height,
    xres: num(image.getAttribute('xres'), 72),
    yres: num(image.getAttribute('yres'), 72),
    nodes: root ? parseNodes(root) : [],
  };
}

// ---- The zip -----------------------------------------------------------------

export interface OraParts {
  stack: string;
  /** Layer pictures by path. */
  data: Map<string, Uint8Array>;
  thumbnail: Uint8Array;
  merged: Uint8Array;
}

export function packOra(parts: OraParts): Uint8Array {
  // mimetype first and stored, so the file identifies itself like an ODF.
  // PNGs are compressed already; deflating them again only costs time.
  const out: Zippable = {
    mimetype: [strToU8(ORA_MIME), { level: 0 }],
    'stack.xml': [strToU8(parts.stack), { level: 6 }],
  };
  for (const [path, bytes] of parts.data) out[path] = [bytes, { level: 0 }];
  out['Thumbnails/thumbnail.png'] = [parts.thumbnail, { level: 0 }];
  out['mergedimage.png'] = [parts.merged, { level: 0 }];
  return zipSync(out);
}

export function unpackOra(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('It isn’t an OpenRaster file.');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error('It isn’t a valid OpenRaster file (it couldn’t be unzipped).', { cause: error });
  }
  if (!entries['stack.xml']) throw new Error('It isn’t an OpenRaster file (there’s no stack.xml).');
  return entries;
}

// ---- Pixels ------------------------------------------------------------------

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

async function decode(bytes: Uint8Array, path: string): Promise<HTMLCanvasElement> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_MIME[ext] ?? 'image/png' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`Its layer ${path} is too big (${w} × ${h}).`);
    const canvas = makeCanvas(w, h);
    ctx2d(canvas).drawImage(img, 0, 0, w, h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture couldn’t be encoded.'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// ---- Reading -----------------------------------------------------------------

async function toLayers(nodes: OraNode[], entries: Record<string, Uint8Array>): Promise<Layer[]> {
  const layers = await Promise.all(
    nodes.map(async (n): Promise<Layer | null> => {
      const props = { opacity: n.opacity, hidden: n.hidden, locked: n.locked };
      if (n.type === 'stack') {
        // A non-isolated stack draws straight onto what's under it, as a pass-through group does.
        const blendMode = n.isolated ? blendFromOra(n.op) : 'pass through';
        return groupLayer(n.name || 'Group', await toLayers(n.children, entries), { ...props, blendMode, open: false });
      }
      const path = n.src.replace(/^\.?\//, '');
      const bytes = entries[path];
      if (!bytes) return null;
      let canvas: HTMLCanvasElement;
      try {
        canvas = await decode(bytes, path);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Its layer')) throw error;
        throw new Error(`Its layer “${n.name || path}” couldn’t be read.`, { cause: error });
      }
      return blankLayer(n.name || 'Layer', canvas, {
        ...props,
        kind: n.text ? 'text' : 'pixel',
        text: n.text,
        canvas,
        left: n.x,
        top: n.y,
        blendMode: blendFromOra(n.op),
      });
    }),
  );
  // The file lists the top first; the editor keeps the bottom first.
  return layers.filter((l): l is Layer => l !== null).reverse();
}

/** Read an OpenRaster file into a document. Throws a sentence a person can read. */
export async function readOraDoc(bytes: Uint8Array): Promise<Doc> {
  const entries = unpackOra(bytes);
  const img = parseStackXml(strFromU8(entries['stack.xml']));
  if (img.width > MAX_SIDE || img.height > MAX_SIDE) {
    throw new Error(`It’s too big (${img.width} × ${img.height}; up to ${MAX_SIDE} on a side).`);
  }
  let layers = await toLayers(img.nodes, entries);
  if (layers.length === 0) {
    const bg = blankLayer('Background', img);
    const merged = entries['mergedimage.png'];
    if (merged) ctx2d(bg.canvas!).drawImage(await decode(merged, 'mergedimage.png'), 0, 0);
    layers = [bg];
  }
  const source: Psd = {
    width: img.width,
    height: img.height,
    imageResources: {
      resolutionInfo: {
        horizontalResolution: img.xres,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: img.yres,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
    },
  };
  return { width: img.width, height: img.height, layers, source };
}

// ---- Writing -----------------------------------------------------------------

const shows = (m: Mask | null): m is Mask => !!m && !m.disabled;

interface WriteCtx {
  w: number;
  h: number;
  data: Map<string, Promise<Uint8Array>>;
}

/** A doc-sized picture cut down to what's in it. */
function cropped(c: HTMLCanvasElement): { canvas: HTMLCanvasElement; left: number; top: number } | null {
  const r = opaqueBounds(c);
  if (!r) return null;
  if (r.x === 0 && r.y === 0 && r.w === c.width && r.h === c.height) return { canvas: c, left: 0, top: 0 };
  const out = makeCanvas(r.w, r.h);
  ctx2d(out).drawImage(c, -r.x, -r.y);
  return { canvas: out, left: r.x, top: r.y };
}

/** A layer inside groups that carry these masks, so drawing it applies them too. */
function wrapped(l: Layer, masks: Mask[]): Layer {
  let out = l;
  for (const mask of masks) out = groupLayer('', [out], { blendMode: 'normal', mask });
  return out;
}

/** The pixels a layer stands for in the file: its own, or what drawing it makes. */
function layerPixels(list: Layer[], i: number, masks: Mask[], ctx: WriteCtx) {
  const l = list[i];
  const flat = { opacity: 1, blendMode: 'normal' as const, hidden: false, clipping: false };
  if (l.kind === 'adjustment') {
    // What it makes of the layers under it, which then covers them.
    const below = renderLayers([...list.slice(0, i), { ...l, hidden: false, opacity: 1 }], ctx.w, ctx.h);
    return cropped(renderLayerAlone(wrapped(blankLayer('', below, { canvas: below }), masks), ctx.w, ctx.h));
  }
  let base: Layer | null = null;
  if (l.clipping) {
    for (let j = i - 1; j >= 0 && !base; j--) if (!list[j].clipping) base = list[j];
  }
  const plain = !masks.length && !base && !shows(l.mask) && !shows(l.vectorMask) && !(l.effects && !l.effects.disabled) && l.fill >= 1;
  if (plain) return l.canvas ? { canvas: l.canvas, left: l.left, top: l.top } : null;
  const img = renderLayerAlone(wrapped({ ...l, ...flat }, masks), ctx.w, ctx.h);
  if (base) {
    // Clipped: only where the layer it clips to has pixels.
    const c = ctx2d(img);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(renderLayerAlone({ ...base, ...flat }, ctx.w, ctx.h), 0, 0);
    c.globalCompositeOperation = 'source-over';
  }
  return cropped(img);
}

function toNodes(list: Layer[], masks: Mask[], ctx: WriteCtx): OraNode[] {
  const nodes = list.map((l, i): OraNode => {
    const common: OraCommon = { name: l.name, opacity: l.opacity, hidden: l.hidden, op: blendToOra(l.blendMode), locked: l.locked };
    if (l.kind === 'group') {
      // Stacks have no masks of their own: each layer in it takes the group's.
      const inner = [...masks, ...[l.mask, l.vectorMask].filter(shows)];
      const isolated = l.blendMode !== 'pass through';
      return { ...common, op: isolated ? common.op : 'svg:src-over', type: 'stack', isolated, children: toNodes(l.children, inner, ctx) };
    }
    const px = layerPixels(list, i, masks, ctx);
    const src = `data/layer${ctx.data.size + 1}.png`;
    ctx.data.set(src, png(px?.canvas ?? makeCanvas(1, 1)));
    const plainText = l.kind === 'text' && px?.canvas === l.canvas ? l.text : null;
    return { ...common, type: 'layer', src, x: px?.left ?? 0, y: px?.top ?? 0, text: plainText };
  });
  return nodes.reverse();
}

function ppi(doc: Doc): { xres: number; yres: number } {
  const r = doc.source?.imageResources?.resolutionInfo;
  if (!r) return { xres: 72, yres: 72 };
  const per = (v: number, unit: 'PPI' | 'PPCM') => (unit === 'PPCM' ? v * 2.54 : v);
  return { xres: per(r.horizontalResolution, r.horizontalResolutionUnit), yres: per(r.verticalResolution, r.verticalResolutionUnit) };
}

/** An OpenRaster file of the document, with the thumbnail and merged image viewers want. */
export async function writeOraDoc(doc: Doc): Promise<Uint8Array> {
  const ctx: WriteCtx = { w: doc.width, h: doc.height, data: new Map() };
  const nodes = toNodes(doc.layers, [], ctx);
  const merged = flatten(doc);
  const scale = Math.min(1, THUMB_SIDE / Math.max(doc.width, doc.height));
  const thumb = makeCanvas(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
  const t = ctx2d(thumb);
  t.imageSmoothingQuality = 'high';
  t.drawImage(merged, 0, 0, thumb.width, thumb.height);
  const data = new Map<string, Uint8Array>();
  for (const [path, bytes] of ctx.data) data.set(path, await bytes);
  return packOra({
    stack: stackXml({ width: doc.width, height: doc.height, ...ppi(doc), nodes }),
    data,
    thumbnail: await png(thumb),
    merged: await png(merged),
  });
}
