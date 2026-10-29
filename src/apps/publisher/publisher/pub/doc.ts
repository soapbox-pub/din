/**
 * A Publisher document as read out of a .pub, before it becomes IDML:
 * pages and master pages with their shapes, the stories in text boxes and
 * the pictures. Lengths are in points, positions from the page's top left.
 */

export interface PubRun {
  text: string;
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: 'single' | 'double' | 'dotted' | 'dashed' | 'thick' | 'wave' | 'words';
  /** '#rrggbb'. */
  color?: string;
  caps?: 'all' | 'small';
  position?: 'super' | 'sub';
  outline?: boolean;
  shadow?: boolean;
  /** Character scaling, percent. */
  scale?: number;
}

export interface PubPara {
  runs: PubRun[];
  align?: 'left' | 'center' | 'right' | 'justify';
  spaceBefore?: number;
  spaceAfter?: number;
  leftIndent?: number;
  rightIndent?: number;
  firstIndent?: number;
  /** Exact points, or a multiple of single spacing. */
  lineSpacing?: { pt: number } | { lines: number };
  bullet?: string;
  numbered?: { start: number };
  dropCap?: { lines: number; chars: number };
  tabs?: number[];
}

export type PubFill =
  | { type: 'solid'; color: string; opacity: number }
  | { type: 'gradient'; stops: { color: string; at: number; opacity: number }[]; angle: number; radial: boolean }
  | { type: 'picture'; image: number };

export interface PubLine {
  color: string;
  /** Points. */
  width: number;
  dash?: 'dash' | 'dot' | 'dashdot';
}

export interface PubPoint {
  x: number;
  y: number;
}

/** A path in the shape's own box, 0..1 across and down. */
export interface PubPath {
  points: { anchor: PubPoint; left: PubPoint; right: PubPoint }[];
  open: boolean;
}

export interface PubTable {
  /** Row heights and column widths, points. */
  rows: number[];
  cols: number[];
  cells: { row: number; col: number; rows: number; cols: number; paras: PubPara[] }[];
}

export interface PubShape {
  kind: 'rect' | 'ellipse' | 'line' | 'path' | 'group';
  /** The unrotated box on the page. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** For 'path' (and odd shapes drawn as one). */
  paths?: PubPath[];
  /** Rounded corners, points. */
  corner?: number;
  fill?: PubFill | null;
  line?: PubLine | null;
  /** Inside the box, as Publisher draws its borders on text boxes and pictures. */
  lineInside?: boolean;
  /** Per-side borders (top, right, bottom, left) when they differ. */
  sides?: (PubLine | null)[];
  image?: number;
  /** Fractions of the picture cropped away: left, top, right, bottom. */
  crop?: [number, number, number, number];
  text?: {
    story: number;
    /** Left, top, right, bottom. */
    margins: [number, number, number, number];
    columns: number;
    gutter: number;
    valign: 'top' | 'middle' | 'bottom';
    /** Its place in the chain of boxes the story flows through. */
    link: number;
    /** Text here flows over shapes rather than around them. */
    ignoreWrap?: boolean;
  };
  /** Text in boxes that wrap around this shape keeps this far away: top, left, bottom, right. */
  wrap?: [number, number, number, number];
  table?: PubTable;
  shadow?: { color: string; x: number; y: number; opacity: number };
  arrows?: { start: boolean; end: boolean };
  children?: PubShape[];
}

export interface PubPage {
  shapes: PubShape[];
  background?: PubFill | null;
  /** Index into PubDoc.masters. */
  master: number | null;
}

export interface PubImage {
  kind: 'png' | 'jpeg' | 'bmp' | 'tiff' | 'gif' | 'wmf' | 'emf' | 'pict' | 'unknown';
  data: Uint8Array;
}

export interface PubDoc {
  width: number;
  height: number;
  pages: PubPage[];
  masters: PubPage[];
  /** Text by story; text boxes linked together share one. */
  stories: Map<number, PubPara[]>;
  images: PubImage[];
  /** What couldn't be carried over, in words for the person opening it. */
  warnings: Set<string>;
  version: string;
}
