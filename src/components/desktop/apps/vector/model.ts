import type { Color } from './pdf/color';
import type { GlyphCmd } from './pdf/glyphs';
import type { PdfDoc, PdfValue } from './pdf/objects';

/**
 * Vector Editor's document, the way Illustrator thinks of one: artboards
 * on a pasteboard, layers holding paths, groups (clipping or not), type and
 * placed images. Geometry is in document points, y down, with paths' anchor
 * and direction points stored where they are (no per-path transform), so
 * moving or rotating art rewrites its points as Illustrator's does. Type and
 * images keep a matrix of their own.
 *
 * Documents are immutable: edits make new objects and share the rest, so
 * history is a list of documents.
 */

export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export interface Point {
  x: number;
  y: number;
}

/** An anchor point with its direction points (equal to the anchor where there's no handle). */
export interface Node {
  x: number;
  y: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
}

export interface SubPath {
  nodes: Node[];
  closed: boolean;
}

export interface GradStop {
  /** 0–1 along the ramp. */
  t: number;
  color: Color;
  opacity: number;
  /** Where between this stop and the next the colors meet halfway (0–1, 0.5 even). */
  mid?: number;
}

/**
 * A gradient: linear runs from (0,0) to (1,0) and radial is the unit circle
 * round (0,0), both in a space `matrix` maps onto the document.
 */
export interface Gradient {
  type: 'linear' | 'radial';
  stops: GradStop[];
  matrix: Mat;
  /** Radial only: the focal point in gradient space, and its radius. */
  focal?: { x: number; y: number; r: number };
  name?: string;
}

export type Paint = { type: 'none' } | { type: 'color'; color: Color } | { type: 'gradient'; gradient: Gradient };

export const NONE: Paint = { type: 'none' };

export interface Stroke {
  paint: Paint;
  width: number;
  /** 0 butt, 1 round, 2 projecting. */
  cap: 0 | 1 | 2;
  /** 0 miter, 1 round, 2 bevel. */
  join: 0 | 1 | 2;
  miter: number;
  dash: number[];
  dashOffset: number;
}

export type Blend =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

interface ItemBase {
  id: number;
  /** What the Layers panel calls it; empty for the default (“<Path>”, “<Group>”…). */
  name: string;
  hidden?: boolean;
  locked?: boolean;
  opacity: number;
  blend: Blend;
}

export interface PathItem extends ItemBase {
  type: 'path';
  paths: SubPath[];
  fill: Paint;
  stroke: Stroke;
  evenOdd: boolean;
}

export interface GroupItem extends ItemBase {
  type: 'group';
  children: Item[];
  /** A clipping group: the first child is the clipping path. */
  clip: boolean;
}

/** How a font is named, and where its glyphs come from. */
export interface FontRef {
  /** Family as the Character panel shows it, e.g. "Myriad Pro". */
  family: string;
  /** Style, e.g. "Regular", "Bold Italic". */
  style: string;
  /** PostScript name, e.g. "MyriadPro-Regular". */
  postscript: string;
  /** A font read from the file, in the document's resources (draws its own glyphs). */
  embedded?: string;
}

export interface TextRun {
  text: string;
  font: FontRef;
  size: number;
  fill: Paint;
  stroke: Stroke;
  /** Tracking in thousandths of an em. */
  tracking: number;
  /** Horizontal scale, 1 = 100%. */
  hscale: number;
  /** Baseline shift, points up. */
  rise: number;
}

/** Glyphs placed exactly as the file had them, used while the text is unchanged. */
export interface PlacedGlyphs {
  /** The text this placement shows; any edit drops it. */
  text: string;
  font: string;
  size: number;
  /** Per glyph: its character code in the font (-1 for a space the file left as a gap) and x in the text's space. */
  glyphs: { code: number; bytes: number; x: number; ch: string }[];
  hscale: number;
  /** PDF text rendering mode: fill, stroke, both, or invisible. */
  render: 0 | 1 | 2 | 3;
}

export interface TextItem extends ItemBase {
  type: 'text';
  /** Text space (origin at the first baseline's start, y down) to document. */
  matrix: Mat;
  runs: TextRun[];
  align: 'left' | 'center' | 'right' | 'justify';
  /** Line spacing in points; 0 is Auto (120% of the size). */
  leading: number;
  /** Area type's box, its top-left at the text space's origin; point type has none (its origin is on the first baseline). */
  area?: { w: number; h: number };
  placed?: PlacedGlyphs;
}

export interface ImageItem extends ItemBase {
  type: 'image';
  /** The unit square (y down) to the document. */
  matrix: Mat;
  /** Key in the document's images. */
  image: string;
}

export type Item = PathItem | GroupItem | TextItem | ImageItem;

export interface Layer {
  id: number;
  name: string;
  /** Selection color, as Illustrator gives each layer. */
  color: string;
  hidden: boolean;
  locked: boolean;
  children: Item[];
}

export interface Artboard {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A picture placed in the document. */
export interface ImageEntry {
  width: number;
  height: number;
  /** How to show it. */
  bitmap: ImageBitmap | HTMLCanvasElement | null;
  /** How to write it: a JPEG as it was, or 8-bit RGB(A) pixels. */
  jpeg?: Uint8Array;
  /** CMYK JPEGs show and save differently. */
  jpegComponents?: number;
  /** The JPEG's Decode array in the file it came from (inverted CMYK). */
  jpegDecode?: number[];
  rgb?: Uint8Array;
  alpha?: Uint8Array;
  /** Gray images stay gray. */
  gray?: boolean;
}

/** A font read from a file: its glyph outlines, how codes map to them, and what to write back. */
export interface FontEntry {
  key: string;
  ref: FontRef;
  /** Code to glyph path in a 1000-unit em, y up. Null where the glyph has no outline. */
  glyph(code: number): Path2D | null;
  /** The same outline as commands, for Create Outlines. */
  outline(code: number): GlyphCmd[] | null;
  /** Code to advance in thousandths of an em. */
  width(code: number): number;
  /** Code to text. */
  toUnicode(code: number): string;
  /** Text to codes, when every character has one; else null. */
  encode(text: string): { code: number; bytes: number }[] | null;
  /** Bytes per code (1, or 2 for CID fonts). */
  bytes: 1 | 2;
  /** Where it came from, to copy into a PDF being written. */
  source: { doc: PdfDoc; value: PdfValue } | null;
  /** Whether it draws its own glyphs (else a substitute font draws the text). */
  outlines: boolean;
  /** The font's matrix, for Type 3 fonts; 1000-unit em otherwise. */
  ascent: number;
  descent: number;
}

export interface Resources {
  images: Map<string, ImageEntry>;
  fonts: Map<string, FontEntry>;
}

export interface Doc {
  artboards: Artboard[];
  layers: Layer[];
  /** Shared across history; only added to. */
  res: Resources;
  /** The color mode it was made in. */
  mode: 'rgb' | 'cmyk';
  units: Units;
  /** Things the reader couldn't bring in, to say so once. */
  notes: string[];
}

export type Units = 'pt' | 'px' | 'in' | 'mm' | 'cm' | 'pc';

export const UNIT_PT: Record<Units, number> = { pt: 1, px: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, pc: 12 };

// ---- Ids and names ------------------------------------------------------------------

let nextId = 1;
export const newId = () => nextId++;

export const LAYER_COLORS = ['#4f80ff', '#ff4f4f', '#4fff4f', '#4f4fff', '#ffff4f', '#ff4fff', '#4fffff', '#808080', '#000000', '#ff7f00'];

export function newLayer(name: string, index: number): Layer {
  return { id: newId(), name, color: LAYER_COLORS[index % LAYER_COLORS.length], hidden: false, locked: false, children: [] };
}

export function newDoc(w: number, h: number, mode: 'rgb' | 'cmyk' = 'rgb', units: Units = 'pt', count = 1): Doc {
  const artboards: Artboard[] = [];
  for (let i = 0; i < count; i++) artboards.push({ id: newId(), name: `Artboard ${i + 1}`, x: i * (w + 20), y: 0, w, h });
  return { artboards, layers: [newLayer('Layer 1', 0)], res: { images: new Map(), fonts: new Map() }, mode, units, notes: [] };
}

export function defaultStroke(paint: Paint = NONE, width = 1): Stroke {
  return { paint, width, cap: 0, join: 0, miter: 10, dash: [], dashOffset: 0 };
}

export function itemLabel(it: Item): string {
  if (it.name) return it.name;
  if (it.type === 'path') {
    if (it.paths.length > 1) return '<Compound Path>';
    return '<Path>';
  }
  if (it.type === 'group') return it.clip ? '<Clip Group>' : '<Group>';
  if (it.type === 'text') {
    const t = it.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    return t ? (t.length > 28 ? `${t.slice(0, 28)}…` : t) : '<Type>';
  }
  return '<Image>';
}

// ---- Matrices --------------------------------------------------------------------------

/** a then b: apply a, then b. */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m: Mat, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export const translate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy];
export const scaleAbout = (sx: number, sy: number, cx: number, cy: number): Mat => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
export function rotateAbout(rad: number, cx: number, cy: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
/** Mean scale of a matrix, for stroke widths. */
export const matScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

// ---- Rects ------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EMPTY: Rect = { x: Infinity, y: Infinity, w: -Infinity, h: -Infinity };
export const isEmpty = (r: Rect) => !(r.w >= 0 && r.h >= 0) || !Number.isFinite(r.x);

export function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectOfPoints(pts: Point[]): Rect {
  if (!pts.length) return EMPTY;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** Extremes of a cubic in one dimension. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

export function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Each segment of a subpath: from node i to the next. */
export function segments(sp: SubPath): [Node, Node][] {
  const out: [Node, Node][] = [];
  const n = sp.nodes.length;
  for (let i = 0; i + 1 < n; i++) out.push([sp.nodes[i], sp.nodes[i + 1]]);
  if (sp.closed && n > 1) out.push([sp.nodes[n - 1], sp.nodes[0]]);
  return out;
}

export function pathBounds(paths: SubPath[]): Rect {
  const pts: Point[] = [];
  for (const sp of paths) {
    for (const nd of sp.nodes) pts.push({ x: nd.x, y: nd.y });
    for (const [a, b] of segments(sp)) {
      for (const t of cubicExtrema(a.x, a.ox, b.ix, b.x)) pts.push({ x: cubicAt(a.x, a.ox, b.ix, b.x, t), y: cubicAt(a.y, a.oy, b.iy, b.y, t) });
      for (const t of cubicExtrema(a.y, a.oy, b.iy, b.y)) pts.push({ x: cubicAt(a.x, a.ox, b.ix, b.x, t), y: cubicAt(a.y, a.oy, b.iy, b.y, t) });
    }
  }
  return rectOfPoints(pts);
}

// ---- Tree helpers --------------------------------------------------------------------------

export function walk(items: Item[], fn: (it: Item, parents: GroupItem[]) => void, parents: GroupItem[] = []) {
  for (const it of items) {
    fn(it, parents);
    if (it.type === 'group') walk(it.children, fn, [...parents, it]);
  }
}

export function allItems(doc: Doc): Item[] {
  const out: Item[] = [];
  for (const l of doc.layers) walk(l.children, (it) => out.push(it));
  return out;
}

export interface Place {
  layer: Layer;
  /** The groups from the layer down to the item's parent. */
  parents: GroupItem[];
  item: Item;
  index: number;
}

export function findItem(doc: Doc, id: number): Place | null {
  for (const layer of doc.layers) {
    const r = findIn(layer.children, id, []);
    if (r) return { layer, ...r };
  }
  return null;
}

function findIn(items: Item[], id: number, parents: GroupItem[]): Omit<Place, 'layer'> | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.id === id) return { parents, item: it, index: i };
    if (it.type === 'group') {
      const r = findIn(it.children, id, [...parents, it]);
      if (r) return r;
    }
  }
  return null;
}

/** Replace items by id (fn returns the new item, or null to remove it, or an array to splice in). */
export function mapItems(doc: Doc, fn: (it: Item) => Item | Item[] | null | undefined): Doc {
  let changed = false;
  const mapList = (items: Item[]): Item[] => {
    const out: Item[] = [];
    let local = false;
    for (const it of items) {
      const r = fn(it);
      if (r === undefined) {
        if (it.type === 'group') {
          const kids = mapList(it.children);
          if (kids !== it.children) {
            local = true;
            out.push({ ...it, children: kids });
            continue;
          }
        }
        out.push(it);
        continue;
      }
      local = true;
      if (r === null) continue;
      if (Array.isArray(r)) out.push(...r);
      else out.push(r);
    }
    if (local) changed = true;
    return local ? out : items;
  };
  const layers = doc.layers.map((l) => {
    const kids = mapList(l.children);
    return kids === l.children ? l : { ...l, children: kids };
  });
  return changed ? { ...doc, layers } : doc;
}

export function updateItem(doc: Doc, id: number, fn: (it: Item) => Item): Doc {
  return mapItems(doc, (it) => (it.id === id ? fn(it) : undefined));
}

export function updateLayer(doc: Doc, id: number, fn: (l: Layer) => Layer): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? fn(l) : l)) };
}

export function layerOf(doc: Doc, id: number): Layer | null {
  return findItem(doc, id)?.layer ?? null;
}

/** Whether an item can be selected: it and its layer and groups shown and unlocked. */
export function selectable(p: Place): boolean {
  if (p.layer.hidden || p.layer.locked) return false;
  if (p.item.hidden || p.item.locked) return false;
  return !p.parents.some((g) => g.hidden || g.locked);
}

/** Deep copy with fresh ids (for duplicating). */
export function cloneItem(it: Item): Item {
  if (it.type === 'group') return { ...it, id: newId(), children: it.children.map(cloneItem) };
  return { ...it, id: newId() };
}
