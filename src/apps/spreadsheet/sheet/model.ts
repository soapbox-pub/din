import { OFFICE_THEME, type Theme } from '@/shared/office/theme';
import { cellKey, keyCol, keyRow, MAX_COLS, MAX_ROWS, type Range } from './addr';
import type { Scalar } from './values';

/**
 * A workbook as the app holds it: immutable sheets (a change makes new
 * objects, so history keeps old ones), cells in a Map by numeric key, and
 * cell formats interned in a shared style table.
 */

export interface Cell {
  /** The value; for formulas, the last computed (or file-cached) result. */
  v: Scalar;
  /** Formula text without the leading '='. */
  f?: string;
  /** Style id in the workbook's style table; 0 or absent is Normal. */
  s?: number;
}

export interface ColInfo {
  /** Width in pixels at 100%. */
  w?: number;
  hidden?: boolean;
  s?: number;
}

export interface RowInfo {
  /** Height in pixels at 100%. */
  h?: number;
  /** Set by hand (Row Height, dragging), so it doesn't follow the row's contents. */
  custom?: boolean;
  hidden?: boolean;
  s?: number;
}

export interface Selection {
  active: { r: number; c: number };
  /** The ranges selected; the last holds the active cell. */
  ranges: Range[];
}

export interface Sheet {
  id: number;
  name: string;
  cells: Map<number, Cell>;
  cols: Map<number, ColInfo>;
  rows: Map<number, RowInfo>;
  defaultColWidth: number;
  defaultRowHeight: number;
  merges: Range[];
  /** Hyperlinks by cell key: a URL, or '#Sheet2!A1' for a place in the workbook. */
  links: Map<number, string>;
  freeze: { rows: number; cols: number };
  tabColor: string | null;
  hidden: boolean;
  gridlines: boolean;
  headings: boolean;
  zoom: number;
  sel: Selection;
  /** The first row and column scrolled to. */
  top: { r: number; c: number };
  /** Conditional formatting and data validation, carried through a save as written (not shown or edited). */
  kept?: { cf: string[]; dv: string | null };
  /** Page Layout settings carried through the file. */
  page: { orientation: 'portrait' | 'landscape'; margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number } };
}

export interface DefinedName {
  name: string;
  /** Formula text without '='. */
  formula: string;
  /** The sheet (index) it belongs to, or null for the workbook. */
  sheet: number | null;
  hidden?: boolean;
}

export interface Workbook {
  sheets: Sheet[];
  active: number;
  names: DefinedName[];
  date1904: boolean;
  theme: Theme;
  styles: StyleTable;
  /** The differential formats conditional formatting refers to, as the file had them. */
  dxfs?: string;
}

// ---- Styles ----------------------------------------------------------------------------------

export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double' | 'hair' | 'mediumDashed' | 'dashDot' | 'mediumDashDot' | 'dashDotDot' | 'mediumDashDotDot' | 'slantDashDot';

export interface BorderSide {
  style: BorderStyle;
  color: string;
}

export interface Font {
  name: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: 'single' | 'double' | 'singleAccounting' | 'doubleAccounting';
  strike?: boolean;
  /** Hex without '#'; absent is Automatic (black). */
  color?: string;
  vert?: 'superscript' | 'subscript';
}

export type HAlign = 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
export type VAlign = 'top' | 'center' | 'bottom' | 'justify' | 'distributed';

export interface Style {
  numFmt: string;
  font: Font;
  /** Solid fill color, hex. */
  fill: string | null;
  /** A pattern fill other than solid, kept so it survives a save. */
  pattern?: { type: string; fg: string | null; bg: string | null };
  border: { l?: BorderSide; r?: BorderSide; t?: BorderSide; b?: BorderSide };
  h: HAlign;
  v: VAlign;
  wrap?: boolean;
  indent?: number;
  rotate?: number;
  shrink?: boolean;
}

export const DEFAULT_FONT: Font = { name: 'Calibri', size: 11 };

export function defaultStyle(font: Font = DEFAULT_FONT): Style {
  return { numFmt: 'General', font, fill: null, border: {}, h: 'general', v: 'bottom' };
}

function styleKey(s: Style): string {
  return JSON.stringify([s.numFmt, s.font.name, s.font.size, !!s.font.bold, !!s.font.italic, s.font.underline ?? '', !!s.font.strike, s.font.color ?? '', s.font.vert ?? '', s.fill ?? '', s.pattern ?? null, s.border.l ?? null, s.border.r ?? null, s.border.t ?? null, s.border.b ?? null, s.h, s.v, !!s.wrap, s.indent ?? 0, s.rotate ?? 0, !!s.shrink]);
}

/** Every distinct cell format, by id. Ids never change, so old history states stay valid. */
export class StyleTable {
  private list: Style[] = [];
  private ids = new Map<string, number>();

  constructor(base: Style = defaultStyle()) {
    this.id(base);
  }

  get(id: number | undefined): Style {
    return this.list[id ?? 0] ?? this.list[0];
  }

  id(style: Style): number {
    const k = styleKey(style);
    let id = this.ids.get(k);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(style);
      this.ids.set(k, id);
    }
    return id;
  }

  /** The id of a style changed by `fn`. */
  derive(id: number | undefined, fn: (s: Style) => Style): number {
    return this.id(fn(this.get(id)));
  }

  get base(): Style {
    return this.list[0];
  }
}

// ---- Construction -----------------------------------------------------------------------------

let nextSheetId = 1;

export function newSheet(name: string, defaults?: Partial<Sheet>): Sheet {
  return {
    id: nextSheetId++,
    name,
    cells: new Map(),
    cols: new Map(),
    rows: new Map(),
    defaultColWidth: 64,
    defaultRowHeight: 20,
    merges: [],
    links: new Map(),
    freeze: { rows: 0, cols: 0 },
    tabColor: null,
    hidden: false,
    gridlines: true,
    headings: true,
    zoom: 100,
    sel: { active: { r: 0, c: 0 }, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }] },
    top: { r: 0, c: 0 },
    page: { orientation: 'portrait', margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
    ...defaults,
  };
}

export function newWorkbook(): Workbook {
  return { sheets: [newSheet('Sheet1')], active: 0, names: [], date1904: false, theme: OFFICE_THEME, styles: new StyleTable() };
}

/** A name for a new sheet: Sheet2, Sheet3... */
export function freshSheetName(wb: Workbook, base = 'Sheet'): string {
  const used = new Set(wb.sheets.map((s) => s.name.toLowerCase()));
  let n = wb.sheets.length + 1;
  while (used.has(`${base}${n}`.toLowerCase())) n++;
  return `${base}${n}`;
}

// ---- Geometry -----------------------------------------------------------------------------------

/**
 * Positions along rows or columns where most have the default size: a
 * position is i × default plus the differences of the custom sizes before
 * it, found by binary search.
 */
export class Axis {
  private idx: number[] = [];
  private delta: number[] = [];
  /** delta prefix sums: cum[k] is the sum of delta[0..k). */
  private cum: number[] = [0];

  constructor(
    readonly def: number,
    sizes: Map<number, { w?: number; h?: number; hidden?: boolean }>,
    readonly count: number,
    which: 'w' | 'h',
  ) {
    const entries = [...sizes.entries()]
      .map(([i, info]) => [i, info.hidden ? 0 : (info[which] ?? def)] as const)
      .filter(([, size]) => size !== def)
      .sort((a, b) => a[0] - b[0]);
    for (const [i, size] of entries) {
      this.idx.push(i);
      this.delta.push(size - def);
      this.cum.push(this.cum[this.cum.length - 1] + size - def);
    }
  }

  /** How many custom entries come before index i. */
  private before(i: number): number {
    let lo = 0;
    let hi = this.idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.idx[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  pos(i: number): number {
    return i * this.def + this.cum[this.before(i)];
  }

  size(i: number): number {
    const k = this.before(i);
    return this.idx[k] === i ? this.def + this.delta[k] : this.def;
  }

  /** The index whose span holds position p. */
  at(p: number): number {
    if (p <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pos(mid) <= p) lo = mid;
      else hi = mid - 1;
    }
    // Skip hidden (zero-size) entries.
    while (lo < this.count - 1 && this.size(lo) === 0) lo++;
    return lo;
  }

  get total(): number {
    return this.pos(this.count);
  }
}

const colAxes = new WeakMap<Map<number, ColInfo>, Map<number, Axis>>();
const rowAxes = new WeakMap<Map<number, RowInfo>, Map<number, Axis>>();

export function colAxis(sheet: Sheet): Axis {
  let byDef = colAxes.get(sheet.cols);
  if (!byDef) colAxes.set(sheet.cols, (byDef = new Map()));
  let a = byDef.get(sheet.defaultColWidth);
  if (!a) byDef.set(sheet.defaultColWidth, (a = new Axis(sheet.defaultColWidth, sheet.cols, MAX_COLS, 'w')));
  return a;
}

export function rowAxis(sheet: Sheet): Axis {
  let byDef = rowAxes.get(sheet.rows);
  if (!byDef) rowAxes.set(sheet.rows, (byDef = new Map()));
  let a = byDef.get(sheet.defaultRowHeight);
  if (!a) byDef.set(sheet.defaultRowHeight, (a = new Axis(sheet.defaultRowHeight, sheet.rows, MAX_ROWS, 'h')));
  return a;
}

const mergeIndexes = new WeakMap<Range[], Map<number, Range>>();

/** The merged area covering a cell, if any. */
export function mergeAt(sheet: Sheet, r: number, c: number): Range | null {
  if (!sheet.merges.length) return null;
  let index = mergeIndexes.get(sheet.merges);
  if (!index) {
    index = new Map();
    for (const m of sheet.merges) for (let rr = m.r0; rr <= m.r1; rr++) for (let cc = m.c0; cc <= m.c1; cc++) index.set(cellKey(rr, cc), m);
    mergeIndexes.set(sheet.merges, index);
  }
  return index.get(cellKey(r, c)) ?? null;
}

/** A range grown to cover every merged area it touches. */
export function expandMerges(sheet: Sheet, g: Range): Range {
  if (!sheet.merges.length) return g;
  let out = { ...g };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of sheet.merges) {
      if (m.r0 <= out.r1 && out.r0 <= m.r1 && m.c0 <= out.c1 && out.c0 <= m.c1) {
        const n = { r0: Math.min(out.r0, m.r0), c0: Math.min(out.c0, m.c0), r1: Math.max(out.r1, m.r1), c1: Math.max(out.c1, m.c1) };
        if (n.r0 !== out.r0 || n.c0 !== out.c0 || n.r1 !== out.r1 || n.c1 !== out.c1) {
          out = n;
          changed = true;
        }
      }
    }
  }
  return out;
}

const extents = new WeakMap<Map<number, Cell>, { rows: number; cols: number }>();

/** The last row and column with a cell in them (-1 for an empty sheet). */
export function sheetExtent(sheet: Sheet): { rows: number; cols: number } {
  let e = extents.get(sheet.cells);
  if (!e) {
    let rows = -1;
    let cols = -1;
    for (const k of sheet.cells.keys()) {
      const r = keyRow(k);
      const c = keyCol(k);
      if (r > rows) rows = r;
      if (c > cols) cols = c;
    }
    e = { rows, cols };
    extents.set(sheet.cells, e);
  }
  return e;
}

/** Cells in a range, by key (iterating whichever is smaller: the range or the sheet). */
export function cellsIn(sheet: Sheet, g: Range, cb: (r: number, c: number, cell: Cell) => void): void {
  const ext = sheetExtent(sheet);
  const r1 = Math.min(g.r1, ext.rows);
  const c1 = Math.min(g.c1, ext.cols);
  if (r1 < g.r0 || c1 < g.c0) return;
  const area = (r1 - g.r0 + 1) * (c1 - g.c0 + 1);
  if (area <= sheet.cells.size * 2) {
    for (let r = g.r0; r <= r1; r++)
      for (let c = g.c0; c <= c1; c++) {
        const cell = sheet.cells.get(cellKey(r, c));
        if (cell) cb(r, c, cell);
      }
    return;
  }
  const hits: [number, Cell][] = [];
  for (const [k, cell] of sheet.cells) {
    const r = keyRow(k);
    const c = keyCol(k);
    if (r >= g.r0 && r <= r1 && c >= g.c0 && c <= c1) hits.push([k, cell]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  for (const [k, cell] of hits) cb(keyRow(k), keyCol(k), cell);
}

export function colWidth(sheet: Sheet, c: number): number {
  const info = sheet.cols.get(c);
  if (info?.hidden) return 0;
  return info?.w ?? sheet.defaultColWidth;
}

export function rowHeight(sheet: Sheet, r: number): number {
  const info = sheet.rows.get(r);
  if (info?.hidden) return 0;
  return info?.h ?? sheet.defaultRowHeight;
}

/** The style id that applies to a cell: its own, else its row's, else its column's. */
export function styleIdAt(sheet: Sheet, r: number, c: number): number {
  const cell = sheet.cells.get(cellKey(r, c));
  if (cell?.s !== undefined) return cell.s;
  return sheet.rows.get(r)?.s ?? sheet.cols.get(c)?.s ?? 0;
}

// ---- Column width units -----------------------------------------------------------------------

/** Calibri 11's maximum digit width, which column widths are measured in. */
export const MDW = 7;

/** File width (characters, padding included) → pixels. */
export const widthToPx = (w: number) => Math.trunc(((256 * w + Math.trunc(128 / MDW)) / 256) * MDW);
/** Pixels → file width. */
export const pxToWidth = (px: number) => Math.trunc((px / MDW) * 256) / 256;
/** Pixels → the width Excel shows in Column Width (characters, without padding). */
export const pxToChars = (px: number) => Math.max(0, Math.trunc(((px - 5) / MDW) * 100 + 0.5) / 100);
export const charsToPx = (chars: number) => (chars <= 0 ? 0 : Math.trunc(((256 * chars + Math.trunc(128 / MDW)) / 256) * MDW) + 5);
export const ptToPx = (pt: number) => Math.round((pt * 4) / 3);
export const pxToPt = (px: number) => Math.round(px * 0.75 * 100) / 100;
