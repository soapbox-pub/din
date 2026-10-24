import { fontStack } from '../fonts';
import { cellKey, colName, intersects, isWholeCols, isWholeRows, MAX_COLS, MAX_ROWS, type Range } from './addr';
import { conditionalLook, type CfLook } from './cf';
import type { Calc } from './formulaEval';
import { colAxis, expandMerges, mergeAt, rowAxis, styleIdAt, type Axis, type BorderSide, type Cell, type Font, type Selection, type Sheet, type Style, type Workbook } from './model';
import { formatValue, type Formatted } from './numfmt';
import { CellError, type Scalar } from './values';

/**
 * Drawing a sheet on a canvas, Excel 365's way: gray headers that light up
 * green over the selection, light gridlines that text and fills cover, text
 * spilling into empty neighbours, "####" for numbers that don't fit, and
 * the selection with its green border and fill handle.
 */

export const GRID_COLOR = '#e1e1e1';
export const ACCENT = '#107c41';
export const REF_COLORS = ['#3c6fd1', '#d13438', '#8a3fb8', '#2e8b4a', '#c55a11', '#a07000', '#0f8a8a'];
const HEADER_BG = '#f5f5f5';
const HEADER_LINE = '#d4d4d4';
const HEADER_TEXT = '#424242';
const HEADER_SEL_BG = '#d9eee1';
const HEADER_FULL_BG = '#c0e2cc';
const SEL_FILL = 'rgba(33, 115, 70, 0.11)';
/** Space between a cell's edge and its text. */
const PAD = 2;
const INDENT = 9;

// ---- Geometry ----------------------------------------------------------------------------------

/** Where rows and columns are on screen, for a sheet at a zoom and scroll position. */
export class Geometry {
  readonly cols: Axis;
  readonly rows: Axis;
  readonly hw: number;
  readonly hh: number;
  readonly fr: number;
  readonly fc: number;
  /** Width and height of the frozen panes, on screen. */
  readonly fw: number;
  readonly fh: number;

  constructor(
    readonly sheet: Sheet,
    readonly z: number,
    readonly width: number,
    readonly height: number,
    /** Scroll offset (px at 100%) of the scrolling panes past the frozen ones. */
    readonly sx: number,
    readonly sy: number,
  ) {
    this.cols = colAxis(sheet);
    this.rows = rowAxis(sheet);
    this.fr = sheet.freeze.rows;
    this.fc = sheet.freeze.cols;
    const lastRow = this.rows.at(this.rows.pos(this.fr) + sy + height / z) + 1;
    const digits = Math.max(3, String(lastRow + 1).length);
    this.hw = sheet.headings ? Math.round((digits * 7 + 12) * z) : 0;
    this.hh = sheet.headings ? Math.round(20 * z) : 0;
    this.fw = Math.round(this.cols.pos(this.fc) * z);
    this.fh = Math.round(this.rows.pos(this.fr) * z);
  }

  colX(c: number): number {
    if (c < this.fc) return this.hw + Math.round(this.cols.pos(c) * this.z);
    return this.hw + this.fw + Math.round((this.cols.pos(c) - this.cols.pos(this.fc) - this.sx) * this.z);
  }

  rowY(r: number): number {
    if (r < this.fr) return this.hh + Math.round(this.rows.pos(r) * this.z);
    return this.hh + this.fh + Math.round((this.rows.pos(r) - this.rows.pos(this.fr) - this.sy) * this.z);
  }

  /** The right edge of a column (the last frozen one ends at the freeze line, whatever the scroll). */
  colEnd(c: number): number {
    return c === this.fc - 1 ? this.hw + this.fw : this.colX(c + 1);
  }

  rowEnd(r: number): number {
    return r === this.fr - 1 ? this.hh + this.fh : this.rowY(r + 1);
  }

  /** The column under screen x (-1 over the row headers). */
  colAt(x: number): number {
    if (x < this.hw) return -1;
    if (x < this.hw + this.fw) return this.cols.at((x - this.hw) / this.z);
    return Math.min(MAX_COLS - 1, this.cols.at((x - this.hw - this.fw) / this.z + this.cols.pos(this.fc) + this.sx));
  }

  rowAt(y: number): number {
    if (y < this.hh) return -1;
    if (y < this.hh + this.fh) return this.rows.at((y - this.hh) / this.z);
    return Math.min(MAX_ROWS - 1, this.rows.at((y - this.hh - this.fh) / this.z + this.rows.pos(this.fr) + this.sy));
  }

  /** The first and last scrolling rows and columns on screen. */
  get firstRow() {
    return Math.max(this.fr, this.rows.at(this.rows.pos(this.fr) + this.sy));
  }
  get lastRow() {
    return Math.min(MAX_ROWS - 1, this.rows.at(this.rows.pos(this.fr) + this.sy + (this.height - this.hh - this.fh) / this.z));
  }
  get firstCol() {
    return Math.max(this.fc, this.cols.at(this.cols.pos(this.fc) + this.sx));
  }
  get lastCol() {
    return Math.min(MAX_COLS - 1, this.cols.at(this.cols.pos(this.fc) + this.sx + (this.width - this.hw - this.fw) / this.z));
  }

  rect(g: Range): { x: number; y: number; w: number; h: number } {
    const x = this.colX(g.c0);
    const y = this.rowY(g.r0);
    return { x, y, w: this.colEnd(g.c1) - x, h: this.rowEnd(g.r1) - y };
  }

  /** Scroll offsets that bring a cell fully into view (unchanged if it's already visible). */
  reveal(r: number, c: number): { sx: number; sy: number } {
    let { sx, sy } = this;
    if (c >= this.fc) {
      const left = this.cols.pos(c) - this.cols.pos(this.fc);
      const right = left + this.cols.size(c);
      const view = (this.width - this.hw - this.fw) / this.z;
      if (left < sx) sx = left;
      else if (right > sx + view) sx = Math.min(left, right - view);
    }
    if (r >= this.fr) {
      const top = this.rows.pos(r) - this.rows.pos(this.fr);
      const bottom = top + this.rows.size(r);
      const view = (this.height - this.hh - this.fh) / this.z;
      if (top < sy) sy = top;
      else if (bottom > sy + view) sy = Math.min(top, bottom - view);
    }
    return { sx: Math.max(0, sx), sy: Math.max(0, sy) };
  }
}

// ---- Text ------------------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

export function fontCss(f: Font, z: number): string {
  return fontAt(f, ((f.size * 96) / 72) * z * (f.vert ? 0.7 : 1));
}

function fontAt(f: Font, px: number): string {
  return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${px.toFixed(2)}px ${fontStack(f.name)}`;
}

/**
 * Text width as Excel lays it out: the font's true (unhinted) widths, with
 * the digit rounded to whole pixels the way Excel's renderer does (Calibri
 * 11's digits are 7px). Browsers on Linux hint glyph advances to their own
 * whole pixels, so canvas widths alone would make numbers overflow early.
 */
export function excelWidth(text: string, f: Font, z: number): number {
  const px = ((f.size * 96) / 72) * z * (f.vert ? 0.7 : 1);
  const big = fontAt(f, 100);
  const digit = (measure('0', big) * px) / 100;
  return ((measure(text, big) * px) / 100) * (digit > 0 ? Math.max(1, Math.round(digit)) / digit : 1);
}

/** Excel's maximum digit width for a font: the unit General formats count in. */
export function digitWidth(f: Font, z: number): number {
  const px = ((f.size * 96) / 72) * z * (f.vert ? 0.7 : 1);
  return Math.max(1, Math.round((measure('0', fontAt(f, 100)) * px) / 100));
}

export function measure(text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return text.length * 7;
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** Forget measured widths (after fonts finish loading). */
export function resetMeasures() {
  widthCache.clear();
}

/** Lines of wrapped text that fit a width. */
export function wrapLines(text: string, font: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line && measure(next.trimEnd(), font) > width && w.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
        // A single word wider than the cell breaks by character.
        while (measure(line, font) > width && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && measure(line.slice(0, k), font) > width) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface Display {
  text: string;
  color: string | null;
  align: 'left' | 'center' | 'right';
  /** Numbers and dates never spill over their neighbours; text does. */
  isText: boolean;
  fill?: Formatted['fill'];
}

/** What a cell shows and how it lines up, given its value and format. */
export function cellDisplay(v: Scalar, cell: Cell | undefined, style: Style, date1904: boolean, showFormulas: boolean, widthChars = 11): Display {
  if (showFormulas && cell?.f !== undefined) return { text: `=${cell.f}`, color: null, align: 'left', isText: true };
  const f = formatValue(v, style.numFmt, date1904, widthChars);
  let align: Display['align'];
  const h = style.h;
  if (h === 'left' || h === 'fill' || h === 'justify' || h === 'distributed') align = 'left';
  else if (h === 'center' || h === 'centerContinuous') align = 'center';
  else if (h === 'right') align = 'right';
  else if (typeof v === 'number') align = 'right';
  else if (typeof v === 'boolean' || v instanceof CellError) align = 'center';
  else align = 'left';
  return { text: f.text, color: f.color ?? null, align, isText: typeof v === 'string', fill: f.fill };
}

// ---- Drawing ---------------------------------------------------------------------------------

export interface Highlight {
  range: Range;
  color: string;
  /** Dashed: the range being pointed at right now. */
  dashed?: boolean;
}

export interface Scene {
  wb: Workbook;
  sheetIndex: number;
  calc: Calc;
  geo: Geometry;
  sel: Selection;
  /** The cell under the in-cell editor (its text isn't drawn). */
  editing: { r: number; c: number } | null;
  marquee: { ranges: Range[]; offset: number } | null;
  highlights: Highlight[];
  /** The range the fill handle is being dragged over. */
  fillPreview: Range | null;
  showFormulas: boolean;
  /** Hide the selection (while the sheet tabs or a dialog has focus, Excel keeps showing it, so mostly false). */
  hideSelection?: boolean;
}

function borderWidth(b: BorderSide): number {
  switch (b.style) {
    case 'medium':
    case 'mediumDashed':
    case 'mediumDashDot':
    case 'mediumDashDotDot':
    case 'slantDashDot':
      return 2;
    case 'thick':
      return 3;
    default:
      return 1;
  }
}

function borderDash(b: BorderSide): number[] {
  switch (b.style) {
    case 'dashed':
    case 'mediumDashed':
      return [3, 1];
    case 'dotted':
      return [1, 1];
    case 'hair':
      return [1, 1];
    case 'dashDot':
    case 'mediumDashDot':
    case 'slantDashDot':
      return [3, 1, 1, 1];
    case 'dashDotDot':
    case 'mediumDashDotDot':
      return [3, 1, 1, 1, 1, 1];
    default:
      return [];
  }
}

function drawBorderLine(ctx: CanvasRenderingContext2D, b: BorderSide, x0: number, y0: number, x1: number, y1: number) {
  const w = borderWidth(b);
  ctx.strokeStyle = `#${b.color}`;
  ctx.setLineDash(borderDash(b));
  if (b.style === 'double') {
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (y0 === y1) {
      ctx.moveTo(x0, y0 - 1.5);
      ctx.lineTo(x1, y1 - 1.5);
      ctx.moveTo(x0, y0 + 0.5);
      ctx.lineTo(x1, y1 + 0.5);
    } else {
      ctx.moveTo(x0 - 1.5, y0);
      ctx.lineTo(x1 - 1.5, y1);
      ctx.moveTo(x0 + 0.5, y0);
      ctx.lineTo(x1 + 0.5, y1);
    }
    ctx.stroke();
    return;
  }
  ctx.lineWidth = w;
  // Centered on the gridline's pixel, crisp at any width.
  const off = w % 2 ? -0.5 : 0;
  ctx.beginPath();
  if (y0 === y1) {
    ctx.moveTo(x0, y0 + off);
    ctx.lineTo(x1, y1 + off);
  } else {
    ctx.moveTo(x0 + off, y0);
    ctx.lineTo(x1 + off, y1);
  }
  ctx.stroke();
}

interface Pane {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function panes(geo: Geometry): Pane[] {
  const out: Pane[] = [];
  const { hw, hh, fw, fh, fr, fc, width, height } = geo;
  const rowsTop = fr > 0 ? [0, fr - 1] : null;
  const colsLeft = fc > 0 ? [0, fc - 1] : null;
  const rowsMain = [geo.firstRow, geo.lastRow];
  const colsMain = [geo.firstCol, geo.lastCol];
  if (rowsTop && colsLeft) out.push({ r0: rowsTop[0], r1: rowsTop[1], c0: colsLeft[0], c1: colsLeft[1], x: hw, y: hh, w: fw, h: fh });
  if (rowsTop) out.push({ r0: rowsTop[0], r1: rowsTop[1], c0: colsMain[0], c1: colsMain[1], x: hw + fw, y: hh, w: width - hw - fw, h: fh });
  if (colsLeft) out.push({ r0: rowsMain[0], r1: rowsMain[1], c0: colsLeft[0], c1: colsLeft[1], x: hw, y: hh + fh, w: fw, h: height - hh - fh });
  out.push({ r0: rowsMain[0], r1: rowsMain[1], c0: colsMain[0], c1: colsMain[1], x: hw + fw, y: hh + fh, w: width - hw - fw, h: height - hh - fh });
  return out;
}

/** How far to look left and right of the screen for text spilling into it. */
const SPILL_REACH = 24;

interface RowText {
  c: number;
  x0: number;
  x1: number;
  /** The clip span (covering spilled-into neighbours). */
  cx0: number;
  cx1: number;
  disp: Display;
  style: Style;
  cell: Cell | undefined;
  font: string;
}

function drawPane(ctx: CanvasRenderingContext2D, s: Scene, p: Pane) {
  const { geo, wb, calc, sheetIndex } = s;
  const sheet = geo.sheet;
  const z = geo.z;
  const styles = wb.styles;
  const date1904 = wb.date1904;
  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, p.y, p.w, p.h);
  ctx.clip();

  const value = (r: number, c: number, cell: Cell | undefined): Scalar => (cell ? (cell.f !== undefined ? calc.value(sheetIndex, r, c) : cell.v) : null);
  // Conditional formatting kept from the file.
  const hasCf = !!sheet.kept?.cf.length;
  const looks = new Map<number, CfLook | null>();
  const cfAt = (r: number, c: number): CfLook | null => {
    if (!hasCf) return null;
    const k = cellKey(r, c);
    let l = looks.get(k);
    if (l === undefined) {
      l = conditionalLook(wb, sheetIndex, calc, r, c, value(r, c, sheet.cells.get(k)));
      looks.set(k, l);
    }
    return l;
  };
  const merged = new Set<Range>();
  const rowTexts: { r: number; y: number; h: number; texts: RowText[]; covered: Set<number> }[] = [];

  for (let r = p.r0; r <= p.r1; r++) {
    const h = geo.rowEnd(r) - geo.rowY(r);
    if (h <= 0) continue;
    const y = geo.rowY(r);
    const texts: RowText[] = [];
    const covered = new Set<number>();
    const lo = Math.max(p.c0 === 0 || p.c0 < geo.fc ? p.c0 : Math.max(geo.fc, p.c0 - SPILL_REACH), 0);
    const hi = Math.min(p.c1 + SPILL_REACH, MAX_COLS - 1);
    const isEmpty = (c: number) => {
      const cell = sheet.cells.get(cellKey(r, c));
      return (!cell || (cell.v === null && cell.f === undefined)) && !mergeAt(sheet, r, c) && !(s.editing && s.editing.r === r && s.editing.c === c);
    };
    for (let c = lo; c <= hi; c++) {
      const m = mergeAt(sheet, r, c);
      if (m) {
        merged.add(m);
        continue;
      }
      const cell = sheet.cells.get(cellKey(r, c));
      if (!cell || (cell.v === null && cell.f === undefined)) continue;
      if (s.editing && s.editing.r === r && s.editing.c === c) continue;
      const x0 = geo.colX(c);
      const x1 = geo.colEnd(c);
      if (x1 - x0 <= 0) continue;
      let style = styles.get(cell.s ?? styleIdAt(sheet, r, c));
      const look = cfAt(r, c);
      if (look && (look.color || look.bold || look.italic || look.strike)) {
        style = { ...style, font: { ...style.font, color: look.color ?? style.font.color, bold: look.bold ?? style.font.bold, italic: look.italic ?? style.font.italic, strike: look.strike ?? style.font.strike } };
      }
      const font = fontCss(style.font, z);
      const v = value(r, c, cell);
      const avail = x1 - x0 - 2 * PAD * z - 1;
      const disp = cellDisplay(v, cell, style, date1904, s.showFormulas, Math.max(1, Math.floor(avail / digitWidth(style.font, z))));
      let cx0 = x0;
      let cx1 = x1;
      const tw = excelWidth(disp.text, style.font, z) + (style.indent ? style.indent * INDENT * z : 0);
      if (!disp.isText && !s.showFormulas) {
        // Numbers that don't fit become ####.
        if (tw > avail + 2 && !style.wrap && !style.shrink) hashes(disp, avail, style.font, z);
      } else if (!style.wrap && !style.rotate && tw > avail && style.h !== 'fill') {
        // Text spills into empty neighbours.
        const need = tw + 2 * PAD * z;
        if (disp.align === 'left' || disp.align === 'center') {
          let right = c;
          let reach = disp.align === 'center' ? x0 + (x1 - x0) / 2 + need / 2 : x0 + need;
          while (cx1 < reach && right + 1 < MAX_COLS && isEmpty(right + 1)) {
            covered.add(right);
            right++;
            cx1 = geo.colEnd(right);
            reach = Math.max(reach, 0);
          }
        }
        if (disp.align === 'right' || disp.align === 'center') {
          let left = c;
          const reach = disp.align === 'center' ? x0 + (x1 - x0) / 2 - need / 2 : x1 - need;
          while (cx0 > reach && left - 1 >= 0 && isEmpty(left - 1)) {
            left--;
            covered.add(left);
            cx0 = geo.colX(left);
          }
        }
      }
      if (cx1 < p.x || cx0 > p.x + p.w) continue;
      texts.push({ c, x0, x1, cx0, cx1, disp, style, cell, font });
    }
    rowTexts.push({ r, y, h, texts, covered });
  }

  // Fills.
  for (const row of rowTexts) {
    for (let c = p.c0; c <= p.c1; c++) {
      if (mergeAt(sheet, row.r, c)) continue;
      const sid = sheet.cells.get(cellKey(row.r, c))?.s ?? styleIdAt(sheet, row.r, c);
      const look = cfAt(row.r, c);
      if (!sid && !look) continue;
      const st = styles.get(sid);
      const x0 = geo.colX(c);
      const x1 = geo.colEnd(c);
      if (x1 <= x0) continue;
      if (look?.fill || st.fill || st.pattern) {
        ctx.fillStyle = look?.fill ? `#${look.fill}` : st.fill ? `#${st.fill}` : patternColor(st);
        ctx.fillRect(x0, row.y, x1 - x0, row.h);
      }
      if (look?.bar) {
        // Data bars: a gradient from the bar color to white.
        const w = Math.max(1, (x1 - x0 - 4) * look.bar.frac);
        const grad = ctx.createLinearGradient(x0 + 2, 0, x0 + 2 + w, 0);
        grad.addColorStop(0, `#${look.bar.color}`);
        grad.addColorStop(1, '#ffffff');
        ctx.fillStyle = grad;
        ctx.fillRect(x0 + 2, row.y + 2, w, row.h - 5);
        ctx.strokeStyle = `#${look.bar.color}`;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 2.5, row.y + 2.5, w - 1, row.h - 6);
      }
    }
  }

  // Gridlines, broken where text spills over them or a fill covers them.
  if (sheet.gridlines) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const row of rowTexts) {
      const yb = row.y + row.h - 0.5;
      for (let c = p.c0; c <= p.c1; c++) {
        const x0 = geo.colX(c);
        const x1 = geo.colEnd(c);
        if (x1 <= x0) continue;
        const sid = sheet.cells.get(cellKey(row.r, c))?.s ?? styleIdAt(sheet, row.r, c);
        const filled = (sid ? !!styles.get(sid).fill : false) || !!cfAt(row.r, c)?.fill;
        if (!filled) {
          ctx.moveTo(x0, yb);
          ctx.lineTo(x1, yb);
          if (!row.covered.has(c)) {
            ctx.moveTo(x1 - 0.5, row.y);
            ctx.lineTo(x1 - 0.5, row.y + row.h);
          }
        }
      }
    }
    ctx.stroke();
  }

  // Merged areas: one cell's worth of fill and content.
  for (const m of merged) {
    const rc = geo.rect(m);
    const st = styles.get(sheet.cells.get(cellKey(m.r0, m.c0))?.s ?? styleIdAt(sheet, m.r0, m.c0));
    ctx.fillStyle = st.fill ? `#${st.fill}` : st.pattern ? patternColor(st) : '#ffffff';
    ctx.fillRect(rc.x, rc.y, rc.w - (st.fill ? 0 : 1), rc.h - (st.fill ? 0 : 1));
  }

  // Text.
  for (const row of rowTexts) {
    for (const t of row.texts) drawText(ctx, s, t.disp, t.style, t.font, { x: t.x0, y: row.y, w: t.x1 - t.x0, h: row.h }, { x: t.cx0, w: t.cx1 - t.cx0 });
  }
  for (const m of merged) {
    if (s.editing && s.editing.r === m.r0 && s.editing.c === m.c0) continue;
    const cell = sheet.cells.get(cellKey(m.r0, m.c0));
    if (!cell || (cell.v === null && cell.f === undefined)) continue;
    const rc = geo.rect(m);
    const style = styles.get(cell.s ?? styleIdAt(sheet, m.r0, m.c0));
    const font = fontCss(style.font, z);
    const avail = rc.w - 2 * PAD * z - 1;
    const disp = cellDisplay(value(m.r0, m.c0, cell), cell, style, date1904, s.showFormulas, Math.max(1, Math.floor(avail / digitWidth(style.font, z))));
    if (!disp.isText && excelWidth(disp.text, style.font, z) > avail + 2) hashes(disp, avail, style.font, z);
    drawText(ctx, s, disp, style, font, rc, { x: rc.x, w: rc.w });
  }

  // Borders.
  for (const row of rowTexts) {
    for (let c = p.c0; c <= p.c1; c++) {
      const sid = sheet.cells.get(cellKey(row.r, c))?.s ?? styleIdAt(sheet, row.r, c);
      if (!sid) continue;
      const b = styles.get(sid).border;
      if (!b.l && !b.r && !b.t && !b.b) continue;
      const x0 = geo.colX(c);
      const x1 = geo.colEnd(c);
      const m = mergeAt(sheet, row.r, c);
      const y0 = row.y;
      const y1 = row.y + row.h;
      if (b.t && (!m || m.r0 === row.r)) drawBorderLine(ctx, b.t, x0 - 1, y0, x1, y0);
      if (b.b && (!m || m.r1 === row.r)) drawBorderLine(ctx, b.b, x0 - 1, y1, x1, y1);
      if (b.l && (!m || m.c0 === c)) drawBorderLine(ctx, b.l, x0, y0 - 1, x0, y1);
      if (b.r && (!m || m.c1 === c)) drawBorderLine(ctx, b.r, x1, y0 - 1, x1, y1);
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/** A number too wide for its cell shows as ####, as many as fit. */
function hashes(disp: Display, avail: number, f: Font, z: number) {
  disp.text = '#'.repeat(Math.max(1, Math.floor(avail / Math.max(1, excelWidth('#', f, z)))));
  disp.fill = undefined;
}

function patternColor(st: Style): string {
  const p = st.pattern!;
  // Shading patterns show as a blend of their two colors.
  const fg = p.fg ?? '000000';
  const bg = p.bg ?? 'FFFFFF';
  const amount = /^gray0625/.test(p.type) ? 0.06 : /gray125/.test(p.type) ? 0.125 : /lightGray/.test(p.type) ? 0.25 : /mediumGray/.test(p.type) ? 0.5 : /darkGray/.test(p.type) ? 0.75 : 0.35;
  const mix = (a: string, b: string, t: number) => {
    const pa = parseInt(a, 16);
    const pb = parseInt(b, 16);
    const ch = (sh: number) => Math.round(((pa >> sh) & 255) * t + ((pb >> sh) & 255) * (1 - t));
    return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
  };
  return mix(fg, bg, amount);
}

function drawText(ctx: CanvasRenderingContext2D, s: Scene, disp: Display, style: Style, font: string, cell: { x: number; y: number; w: number; h: number }, clip: { x: number; w: number }) {
  const z = s.geo.z;
  const f = style.font;
  const px = ((f.size * 96) / 72) * z;
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, cell.y, clip.w - 1, cell.h - 1);
  ctx.clip();
  ctx.font = font;
  ctx.fillStyle = disp.color ?? (f.color ? `#${f.color}` : '#000000');
  ctx.textBaseline = 'alphabetic';
  const pad = PAD * z;
  const indent = (style.indent ?? 0) * INDENT * z;
  const lineH = Math.round(px * 1.22);
  const descent = px * 0.24;
  let lines: string[];
  if (style.wrap && !style.rotate) lines = wrapLines(disp.text, font, Math.max(1, cell.w - 2 * pad - indent));
  else lines = [disp.text.replace(/\n/g, ' ')];
  if (style.h === 'fill' && disp.text) {
    const one = measure(disp.text, font);
    const n = one > 0 ? Math.max(1, Math.floor((cell.w - 2 * pad) / one)) : 1;
    lines = [disp.text.repeat(n)];
  }
  const blockH = lines.length * lineH;
  let top: number;
  if (style.v === 'top') top = cell.y + 1;
  else if (style.v === 'center' || style.v === 'justify' || style.v === 'distributed') top = cell.y + (cell.h - blockH) / 2;
  else top = cell.y + cell.h - blockH - 1;
  if (style.rotate && !style.wrap) {
    drawRotated(ctx, disp.text, style, cell, pad, px);
    ctx.restore();
    return;
  }
  lines.forEach((line, i) => {
    const baseline = Math.round(top + (i + 1) * lineH - descent - (lineH - px * 1.0) / 2 + px * 0.06);
    let x: number;
    const w = measure(line, font);
    if (disp.fill && lines.length === 1) {
      // Accounting: currency at the left edge, the number at the right.
      const left = line.slice(0, disp.fill.at);
      const right = line.slice(disp.fill.at);
      ctx.textAlign = 'left';
      ctx.fillText(left, cell.x + pad + indent, baseline);
      const lw = measure(left, font);
      const rw = measure(right, font);
      const room = cell.w - 2 * pad - 1 - lw;
      ctx.textAlign = 'right';
      if (rw > room && room > 0) {
        ctx.save();
        ctx.translate(cell.x + cell.w - pad - 1, 0);
        ctx.scale(room / rw, 1);
        ctx.fillText(right, 0, baseline);
        ctx.restore();
      } else ctx.fillText(right, cell.x + cell.w - pad - 1, baseline);
      ctx.textAlign = 'left';
      return;
    }
    // Numbers that fit by Excel's measure but not by the browser's hinted glyphs are narrowed a little.
    const room = cell.w - 2 * pad - 1 - indent;
    const squeeze = !disp.isText && w > room && room > 0 ? room / w : 1;
    const drawn = w * squeeze;
    if (disp.align === 'left') x = cell.x + pad + indent;
    else if (disp.align === 'right') x = cell.x + cell.w - pad - 1 - drawn - indent;
    else x = cell.x + (cell.w - drawn) / 2;
    if (squeeze < 1) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(squeeze, 1);
      ctx.fillText(line, 0, baseline);
      ctx.restore();
    } else ctx.fillText(line, x, baseline);
    if (f.underline || f.strike) {
      ctx.fillRect(x, 0, 0, 0);
      const thick = Math.max(1, Math.round(px / 14));
      if (f.underline) {
        const uy = baseline + Math.max(1, Math.round(px * 0.1));
        ctx.fillRect(Math.round(x), uy, Math.round(w), thick);
        if (f.underline === 'double' || f.underline === 'doubleAccounting') ctx.fillRect(Math.round(x), uy + thick + 1, Math.round(w), thick);
      }
      if (f.strike) ctx.fillRect(Math.round(x), Math.round(baseline - px * 0.3), Math.round(w), thick);
    }
  });
  ctx.restore();
}

function drawRotated(ctx: CanvasRenderingContext2D, text: string, style: Style, cell: { x: number; y: number; w: number; h: number }, pad: number, px: number) {
  const rot = style.rotate ?? 0;
  if (rot === 255) {
    // Stacked letters.
    const chars = [...text];
    const lh = px * 1.1;
    const total = chars.length * lh;
    let y = style.v === 'top' ? cell.y + pad : style.v === 'center' ? cell.y + (cell.h - total) / 2 : cell.y + cell.h - total - pad;
    ctx.textAlign = 'center';
    for (const ch of chars) {
      y += lh;
      ctx.fillText(ch, cell.x + cell.w / 2, y - px * 0.25);
    }
    ctx.textAlign = 'left';
    return;
  }
  // 1–90 turn counterclockwise, 91–180 clockwise; the text turns about the cell's center.
  const angle = rot <= 90 ? -(rot * Math.PI) / 180 : ((rot - 90) * Math.PI) / 180;
  const w = ctx.measureText(text).width;
  ctx.translate(cell.x + cell.w / 2, cell.y + cell.h / 2);
  ctx.rotate(angle);
  ctx.textAlign = 'left';
  ctx.fillText(text, -w / 2, px * 0.35);
}

function drawHeaders(ctx: CanvasRenderingContext2D, s: Scene) {
  const { geo, sel } = s;
  const { hw, hh, width, height } = geo;
  if (!hw && !hh) return;
  const font = fontCss(s.wb.styles.base.font, geo.z);
  const highlightedCol = (c: number) => sel.ranges.some((g) => c >= g.c0 && c <= g.c1);
  const fullCol = (c: number) => sel.ranges.some((g) => isWholeCols(g) && c >= g.c0 && c <= g.c1);
  const highlightedRow = (r: number) => sel.ranges.some((g) => r >= g.r0 && r <= g.r1);
  const fullRow = (r: number) => sel.ranges.some((g) => isWholeRows(g) && r >= g.r0 && r <= g.r1);
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  // Column headers.
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(hw, 0, width - hw, hh);
  const colRanges: [number, number, number][] = [];
  if (geo.fc > 0) colRanges.push([0, geo.fc - 1, hw]);
  colRanges.push([geo.firstCol, geo.lastCol, hw + geo.fw]);
  for (const [a, b, clipX] of colRanges) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, 0, a < geo.fc ? geo.fw : width - clipX, hh);
    ctx.clip();
    for (let c = a; c <= b; c++) {
      const x0 = geo.colX(c);
      const x1 = geo.colEnd(c);
      if (x1 <= x0) {
        // A hidden column shows as a double line.
        ctx.fillStyle = '#a6a6a6';
        ctx.fillRect(x0 - 1, 2, 1, hh - 4);
        continue;
      }
      const hl = !s.hideSelection && highlightedCol(c);
      const full = hl && fullCol(c);
      if (hl) {
        ctx.fillStyle = full ? HEADER_FULL_BG : HEADER_SEL_BG;
        ctx.fillRect(x0, 0, x1 - x0, hh);
        ctx.fillStyle = ACCENT;
        ctx.fillRect(x0, hh - 2, x1 - x0, 2);
      }
      ctx.fillStyle = HEADER_LINE;
      ctx.fillRect(x1 - 1, 0, 1, hh);
      ctx.fillStyle = hl ? (full ? '#0b5a2e' : ACCENT) : HEADER_TEXT;
      ctx.font = hl ? font.replace(/^(italic )?/, '$1bold ') : font;
      ctx.fillText(colName(c), (x0 + x1) / 2, hh / 2 + 0.5);
    }
    ctx.restore();
  }
  ctx.fillStyle = HEADER_LINE;
  ctx.fillRect(hw, hh - 1, width - hw, 1);
  // Row headers.
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, hh, hw, height - hh);
  ctx.textAlign = 'center';
  const rowRanges: [number, number, number][] = [];
  if (geo.fr > 0) rowRanges.push([0, geo.fr - 1, hh]);
  rowRanges.push([geo.firstRow, geo.lastRow, hh + geo.fh]);
  for (const [a, b, clipY] of rowRanges) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipY, hw, a < geo.fr ? geo.fh : height - clipY);
    ctx.clip();
    for (let r = a; r <= b; r++) {
      const y0 = geo.rowY(r);
      const y1 = geo.rowEnd(r);
      if (y1 <= y0) {
        ctx.fillStyle = '#a6a6a6';
        ctx.fillRect(2, y0 - 1, hw - 4, 1);
        continue;
      }
      const hl = !s.hideSelection && highlightedRow(r);
      const full = hl && fullRow(r);
      if (hl) {
        ctx.fillStyle = full ? HEADER_FULL_BG : HEADER_SEL_BG;
        ctx.fillRect(0, y0, hw, y1 - y0);
        ctx.fillStyle = ACCENT;
        ctx.fillRect(hw - 2, y0, 2, y1 - y0);
      }
      ctx.fillStyle = HEADER_LINE;
      ctx.fillRect(0, y1 - 1, hw, 1);
      ctx.fillStyle = hl ? (full ? '#0b5a2e' : ACCENT) : HEADER_TEXT;
      ctx.font = hl ? font.replace(/^(italic )?/, '$1bold ') : font;
      if (y1 - y0 > 6) ctx.fillText(String(r + 1), hw / 2, (y0 + y1) / 2 + 0.5);
    }
    ctx.restore();
  }
  ctx.fillStyle = HEADER_LINE;
  ctx.fillRect(hw - 1, hh, 1, height - hh);
  // The corner: Select All, with its triangle.
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, hw, hh);
  ctx.fillStyle = HEADER_LINE;
  ctx.fillRect(hw - 1, 0, 1, hh);
  ctx.fillRect(0, hh - 1, hw, 1);
  ctx.fillStyle = '#b4b4b4';
  ctx.beginPath();
  const t = Math.round(10 * geo.z);
  ctx.moveTo(hw - 4, hh - 4 - t);
  ctx.lineTo(hw - 4, hh - 4);
  ctx.lineTo(hw - 4 - t, hh - 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawOverlays(ctx: CanvasRenderingContext2D, s: Scene) {
  const { geo, sel } = s;
  const sheet = geo.sheet;
  ctx.save();
  ctx.beginPath();
  ctx.rect(geo.hw, geo.hh, geo.width - geo.hw, geo.height - geo.hh);
  ctx.clip();
  // Formula references while editing, in their colors.
  for (const h of s.highlights) {
    const rc = geo.rect(clampRange(h.range, geo));
    ctx.fillStyle = h.color + '1a';
    ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(h.dashed ? [4, 3] : []);
    ctx.strokeRect(rc.x + 0.25, rc.y + 0.25, rc.w - 1, rc.h - 1);
    ctx.setLineDash([]);
    if (!h.dashed) {
      ctx.fillStyle = h.color;
      for (const [cx, cy] of [[rc.x, rc.y], [rc.x + rc.w - 1, rc.y], [rc.x, rc.y + rc.h - 1], [rc.x + rc.w - 1, rc.y + rc.h - 1]]) ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }
  }
  if (!s.hideSelection) {
    // Selection fill; the active cell stays white.
    const active = mergeAt(sheet, sel.active.r, sel.active.c) ?? { r0: sel.active.r, c0: sel.active.c, r1: sel.active.r, c1: sel.active.c };
    const ar = geo.rect(active);
    ctx.fillStyle = SEL_FILL;
    const ranges = sel.ranges.map((g) => expandMerges(sheet, g));
    for (const g of ranges) {
      if (g.r0 === g.r1 && g.c0 === g.c1) continue;
      const m = mergeAt(sheet, g.r0, g.c0);
      if (m && m.r0 === g.r0 && m.c0 === g.c0 && m.r1 === g.r1 && m.c1 === g.c1) continue;
      const rc = geo.rect(clampRange(g, geo));
      ctx.save();
      ctx.beginPath();
      ctx.rect(rc.x, rc.y, rc.w, rc.h);
      ctx.rect(ar.x + ar.w, ar.y, -ar.w, ar.h);
      ctx.clip('evenodd');
      ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
      ctx.restore();
    }
    // The border goes round the range holding the active cell.
    const last = clampRange(ranges[ranges.length - 1], geo);
    const rc = geo.rect(last);
    {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.strokeRect(rc.x - 0.5 + 0.5, rc.y - 0.5 + 0.5, rc.w - 1, rc.h - 1);
      if (!s.editing && sel.ranges.length === 1) {
        // The fill handle.
        const hx = rc.x + rc.w - 1;
        const hy = rc.y + rc.h - 1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
        ctx.fillStyle = ACCENT;
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }
  }
  if (s.fillPreview) {
    const rc = geo.rect(s.fillPreview);
    ctx.strokeStyle = '#7a7a7a';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(rc.x + 0.5, rc.y + 0.5, rc.w - 1, rc.h - 1);
    ctx.setLineDash([]);
  }
  if (s.marquee) {
    for (const g of s.marquee.ranges) {
      const rc = geo.rect(clampRange(g, geo));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([]);
      ctx.strokeRect(rc.x + 0.5, rc.y + 0.5, rc.w - 2, rc.h - 2);
      ctx.strokeStyle = ACCENT;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -s.marquee.offset;
      ctx.strokeRect(rc.x + 0.5, rc.y + 0.5, rc.w - 2, rc.h - 2);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

/** Whole rows and columns drawn only as far as the screen goes. */
function clampRange(g: Range, geo: Geometry): Range {
  const lastR = Math.max(geo.lastRow + 1, geo.fr);
  const lastC = Math.max(geo.lastCol + 1, geo.fc);
  const firstR = g.r0 >= geo.fr ? Math.max(g.r0, geo.firstRow - 1) : g.r0;
  const firstC = g.c0 >= geo.fc ? Math.max(g.c0, geo.firstCol - 1) : g.c0;
  return { r0: Math.min(firstR, g.r1), c0: Math.min(firstC, g.c1), r1: Math.min(g.r1, lastR), c1: Math.min(g.c1, lastC) };
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const { geo } = s;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, geo.width, geo.height);
  for (const p of panes(geo)) drawPane(ctx, s, p);
  // Frozen pane lines.
  ctx.fillStyle = '#9e9e9e';
  if (geo.fr > 0) ctx.fillRect(geo.hw, geo.hh + geo.fh - 1, geo.width - geo.hw, 1);
  if (geo.fc > 0) ctx.fillRect(geo.hw + geo.fw - 1, geo.hh, 1, geo.height - geo.hh);
  drawOverlays(ctx, s);
  drawHeaders(ctx, s);
}

/** Does a range touch anything on screen? */
export function onScreen(geo: Geometry, g: Range): boolean {
  return intersects(g, { r0: 0, c0: 0, r1: geo.lastRow, c1: geo.lastCol });
}
