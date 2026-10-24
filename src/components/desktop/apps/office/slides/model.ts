import type { Theme } from '../theme';
import type { ChartData } from './chartData';

/**
 * The presentation as Slides edits it: plain immutable data, with lengths in
 * EMUs as the file has them. Slides hold only what the file says about them;
 * what a placeholder inherits from its layout and master is looked up when
 * it's drawn (see inherit.ts), so changing a slide's layout restyles it the
 * way PowerPoint does, and saving writes back no more than was there.
 */

/** XML children a model doesn't understand, kept by local name to write back verbatim. */
export type RawKids = Record<string, string>;

export interface Color {
  /** A theme slot as written (accent1, tx1, bg2, phClr...) or null for an RGB color. */
  scheme?: string;
  hex?: string;
  /** Transforms (lumMod, lumOff, tint, shade, alpha, satMod...) with their values. */
  mods?: [string, number][];
}

export interface GradStop {
  pos: number;
  color: Color;
}

export type Fill =
  | { type: 'none' }
  | { type: 'solid'; color: Color }
  | { type: 'grad'; stops: GradStop[]; angle: number; path?: 'circle' | 'rect' | 'shape'; raw?: string }
  | { type: 'blip'; media: string | null; tile?: boolean; crop?: Crop; duotone?: [Color, Color]; raw?: string }
  | { type: 'patt'; fg: Color; bg: Color; prst: string }
  /** Inherit the group's fill. */
  | { type: 'grp' };

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface LineEnd {
  type: string;
  w?: string;
  len?: string;
}

export interface Line {
  fill?: Fill;
  /** Width in EMU. */
  w?: number;
  dash?: string;
  cap?: string;
  head?: LineEnd;
  tail?: LineEnd;
  raw?: RawKids;
}

export interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
}

export interface Geometry {
  prst?: string;
  /** Adjust values (adj, adj1...) as written in avLst. */
  adj?: Record<string, number>;
  /** a:custGeom, kept as XML: it's drawn by the same formula engine. */
  cust?: string;
}

export interface StyleRef {
  idx: number | string;
  color?: Color;
}

export interface ShapeStyle {
  ln?: StyleRef;
  fill?: StyleRef;
  effect?: StyleRef;
  font?: StyleRef;
}

// ---- Text ------------------------------------------------------------------------

export type Spacing = { pct: number } | { pts: number };

export type Bullet =
  | { type: 'none' }
  | { type: 'char'; char: string }
  | { type: 'auto'; scheme: string; start?: number };

export interface RunProps {
  /** Hundredths of a point. */
  sz?: number;
  b?: boolean;
  i?: boolean;
  u?: string;
  strike?: string;
  /** A typeface, or a theme font (+mj-lt, +mn-lt). */
  font?: string;
  color?: Color;
  /** Percent: 30000 superscript, -25000 subscript. */
  baseline?: number;
  cap?: string;
  /** Character spacing in hundredths of a point. */
  spc?: number;
  link?: string;
  highlight?: Color;
  attrs?: Record<string, string>;
  raw?: RawKids;
}

export interface ParaProps {
  algn?: string;
  lvl?: number;
  marL?: number;
  indent?: number;
  lnSpc?: Spacing;
  spcBef?: Spacing;
  spcAft?: Spacing;
  bullet?: Bullet;
  buFont?: string;
  /** Follow the text's font (a:buFontTx). */
  buFontTx?: boolean;
  buClr?: Color;
  buClrTx?: boolean;
  /** Percent of text size, 100000 = 100%. */
  buSzPct?: number;
  defRPr?: RunProps;
  attrs?: Record<string, string>;
  raw?: RawKids;
}

export type Run =
  | { kind: 'text'; text: string; props: RunProps }
  | { kind: 'br'; props: RunProps }
  | { kind: 'field'; type: string; id: string; text: string; props: RunProps };

export interface Para {
  props: ParaProps;
  runs: Run[];
  end?: RunProps;
}

/** lvl1pPr..lvl9pPr (index 0..8), and defPPr. */
export interface ListStyle {
  def?: ParaProps;
  levels: (ParaProps | undefined)[];
}

export interface BodyProps {
  lIns?: number;
  tIns?: number;
  rIns?: number;
  bIns?: number;
  anchor?: string;
  anchorCtr?: boolean;
  wrap?: string;
  vert?: string;
  /** Text rotation in degrees. */
  rot?: number;
  autofit?: 'none' | 'norm' | 'shape';
  fontScale?: number;
  lnSpcReduction?: number;
  numCol?: number;
  attrs?: Record<string, string>;
  raw?: RawKids;
}

export interface TextBody {
  body: BodyProps;
  lst?: ListStyle;
  paras: Para[];
}

// ---- Shapes ----------------------------------------------------------------------

export interface Placeholder {
  type?: string;
  idx?: number;
  sz?: string;
  orient?: string;
  hasCustomPrompt?: boolean;
}

interface ShapeBase {
  /** Unique within the deck, for React and selection. */
  uid: string;
  /** cNvPr id, unique within its slide. */
  id: number;
  name: string;
  descr?: string;
  hidden?: boolean;
  /** Undefined: from the placeholder it inherits from. */
  xfrm?: Xfrm;
  /** Relationship-free XML pieces carried along (nvPr extLst, locks...). */
  raw?: RawKids;
}

export interface SpShape extends ShapeBase {
  kind: 'sp';
  /** p:cxnSp rather than p:sp. */
  connector?: boolean;
  txBox?: boolean;
  ph?: Placeholder;
  geom?: Geometry;
  fill?: Fill;
  line?: Line;
  style?: ShapeStyle;
  text?: TextBody;
  /** Any spPr children we don't model (effectLst, scene3d...). */
  spRaw?: RawKids;
  /** The raw a:cNvSpPr children (spLocks), and connection ends. */
  nvRaw?: string;
}

export interface PicShape extends ShapeBase {
  kind: 'pic';
  ph?: Placeholder;
  media: string | null;
  crop?: Crop;
  geom?: Geometry;
  line?: Line;
  fill?: Fill;
  style?: ShapeStyle;
  spRaw?: RawKids;
  /** Media for a video or sound, kept as XML with its relationships. */
  nvRaw?: string;
  blipRaw?: string;
}

export interface GroupShape extends ShapeBase {
  kind: 'grp';
  xfrm: Xfrm;
  /** The child coordinate space. */
  ch: { x: number; y: number; w: number; h: number };
  children: Shape[];
  fill?: Fill;
}

export interface TableCell {
  text: TextBody;
  gridSpan?: number;
  rowSpan?: number;
  hMerge?: boolean;
  vMerge?: boolean;
  /** a:tcPr, verbatim. */
  tcPr: string;
}

export interface Table {
  /** a:tblPr, verbatim. */
  tblPr: string;
  cols: number[];
  rows: { h: number; cells: TableCell[]; raw?: string }[];
}

/** A graphic frame: a table we draw and edit, or a chart, diagram or object we carry along. */
export interface FrameShape extends ShapeBase {
  kind: 'frame';
  xfrm: Xfrm;
  ph?: Placeholder;
  table?: Table;
  /** Charts, SmartArt and OLE objects: the whole p:graphicFrame, with relationships by id. */
  xml?: string;
  label?: string;
  /** Shapes to draw it with: SmartArt's cached drawing, an OLE object's picture. */
  preview?: Shape[];
  previewSpace?: { x: number; y: number; w: number; h: number };
  /** A chart's part, to draw it from its cached values. */
  chartPart?: string;
}

/** Something we don't understand (mc:AlternateContent, content parts): kept verbatim. */
export interface RawShape extends ShapeBase {
  kind: 'raw';
  xml: string;
  /** Its fallback, drawn in its place. */
  fallback?: Shape;
  /** Where the XML says it is, to move it by rewriting those numbers. */
  orig?: Xfrm;
}

export type Shape = SpShape | PicShape | GroupShape | FrameShape | RawShape;

// ---- Slides, layouts, masters ------------------------------------------------------

export type Background = { fill: Fill } | { ref: StyleRef };

export interface Transition {
  type: 'none' | 'fade' | 'push' | 'wipe' | 'cut' | string;
  /** Duration in ms. */
  dur?: number;
  dir?: string;
  /** The whole p:transition when it's one we don't redraw (we still play it as a fade). */
  raw?: string;
  advClick?: boolean;
  advTm?: number;
}

export interface Slide {
  uid: string;
  layout: string;
  shapes: Shape[];
  bg?: Background;
  hidden?: boolean;
  name?: string;
  showMasterSp?: boolean;
  /** p:clrMapOvr content when it overrides. */
  clrMapOvr?: Record<string, string>;
  notes: string;
  transition?: Transition;
  /** p:timing, kept if every shape it animates is still there. */
  timing?: string;
  /** The part it was read from, to keep its notes slide. */
  part?: string;
  /** Its p:sldId id, which sections refer to. */
  sldId?: number;
}

export interface Layout {
  part: string;
  name: string;
  type?: string;
  master: string;
  shapes: Shape[];
  bg?: Background;
  showMasterSp: boolean;
  clrMapOvr?: Record<string, string>;
}

export interface FmtScheme {
  fills: Fill[];
  lines: Line[];
  bgFills: Fill[];
}

export interface Master {
  part: string;
  shapes: Shape[];
  bg?: Background;
  clrMap: Record<string, string>;
  title: ListStyle;
  body: ListStyle;
  other: ListStyle;
  theme: Theme;
  themePart: string;
  fmt: FmtScheme;
  layouts: string[];
  /** Theme colors or fonts, or the background, changed (Design tab): written back on save. */
  themeDirty?: boolean;
  bgDirty?: boolean;
}

export type BorderSide = 'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV';

export interface TableStylePart {
  fill?: Fill;
  borders: Partial<Record<BorderSide, Line>>;
  b?: boolean;
  i?: boolean;
  color?: Color;
}

export interface TableStyle {
  id: string;
  name: string;
  /** Parts by name: wholeTbl, firstRow, lastRow, firstCol, lastCol, band1H, band2H, band1V, band2V. */
  parts: Record<string, TableStylePart>;
}

export interface Deck {
  /** Slide size in EMU. */
  w: number;
  h: number;
  slides: Slide[];
  masters: Record<string, Master>;
  layouts: Record<string, Layout>;
  defaultText: ListStyle;
  tableStyles: Record<string, TableStyle>;
}

/** Context everything about drawing a slide needs. */
export interface SlideCtx {
  deck: Deck;
  slide: Slide;
  layout: Layout;
  master: Master;
  theme: Theme;
  clrMap: Record<string, string>;
  slideNumber: number;
  media: (path: string | null) => string | null;
  /** A chart part's cached data, when the package is at hand. */
  chart?: (part: string) => ChartData | null;
}

// ---- Helpers -----------------------------------------------------------------------

let uidCounter = 0;
export const newUid = (prefix = 's') => `${prefix}${++uidCounter}${Math.random().toString(36).slice(2, 6)}`;

export const EMU_PER_INCH = 914400;
/** Slides draw at 96 dpi: an EMU is this many CSS pixels. */
export const PX = 96 / EMU_PER_INCH;

export const SIZE_16_9 = { w: 12192000, h: 6858000 };
export const SIZE_4_3 = { w: 9144000, h: 6858000 };

export const DEFAULT_CLR_MAP: Record<string, string> = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hlink: 'hlink', folHlink: 'folHlink',
};

export function plainText(paras: Para[]): string {
  return paras.map((p) => p.runs.map((r) => (r.kind === 'br' ? '\n' : r.text)).join('')).join('\n');
}

export function hasText(body: TextBody | undefined): boolean {
  return !!body?.paras.some((p) => p.runs.some((r) => r.kind !== 'br' && r.text.length > 0) || p.runs.some((r) => r.kind === 'br'));
}

export function walkShapes(shapes: Shape[], fn: (s: Shape) => void): void {
  for (const s of shapes) {
    fn(s);
    if (s.kind === 'grp') walkShapes(s.children, fn);
  }
}

export function maxShapeId(shapes: Shape[]): number {
  let max = 1;
  walkShapes(shapes, (s) => {
    if (s.id > max) max = s.id;
  });
  return max;
}

