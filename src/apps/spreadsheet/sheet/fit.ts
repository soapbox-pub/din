import { cellKey, type Range } from './addr';
import { charsToPx, colWidth as colWidthOf, mergeAt, sheetExtent, styleIdAt, type RowInfo, type Workbook } from './model';
import { formatValue } from './numfmt';
import { excelWidth, fontCss, wrapLines } from './render';
import type { Scalar } from './values';

/** Where computed values come from (the calculation engine, or a file's cached values). */
export interface Values {
  value(sheet: number, r: number, c: number): Scalar;
}

/** Column width that fits a column's contents (Excel's AutoFit). */
export function autofitWidth(wb: Workbook, si: number, calc: Values, c: number, rows?: Range): number {
  const sheet = wb.sheets[si];
  let max = 0;
  const ext = sheetExtent(sheet);
  const r0 = rows ? rows.r0 : 0;
  const r1 = rows ? Math.min(rows.r1, ext.rows) : ext.rows;
  for (let r = r0; r <= r1; r++) {
    const cell = sheet.cells.get(cellKey(r, c));
    if (!cell || (cell.v === null && cell.f === undefined) || mergeAt(sheet, r, c)) continue;
    const style = wb.styles.get(cell.s ?? styleIdAt(sheet, r, c));
    const v = cell.f !== undefined ? calc.value(si, r, c) : cell.v;
    const text = formatForFit(v, style.numFmt, wb.date1904);
    const lines = text.split('\n');
    const w = Math.max(...lines.map((l) => excelWidth(l, style.font, 1))) + (style.indent ?? 0) * 9;
    if (w > max) max = w;
  }
  if (max === 0) return sheet.defaultColWidth;
  return Math.min(charsToPx(255), Math.ceil(max + 7));
}


function formatForFit(v: Scalar, fmt: string, date1904: boolean): string {
  return formatValue(v, fmt, date1904, 11).text;
}

/** Row height that fits a row's contents: its tallest font, wrapped text's lines. */
export function autofitHeight(wb: Workbook, si: number, calc: Values, r: number, colWidth: (c: number) => number): number {
  const sheet = wb.sheets[si];
  let max = 0;
  const ext = sheetExtent(sheet);
  for (let c = 0; c <= ext.cols; c++) {
    const cell = sheet.cells.get(cellKey(r, c));
    const sid = cell?.s ?? styleIdAt(sheet, r, c);
    if (!cell && !sid) continue;
    const style = wb.styles.get(sid);
    const px = (style.font.size * 96) / 72;
    const lineH = Math.round(px * 1.22);
    let lines = 1;
    let extra = 0;
    if (cell && (cell.v !== null || cell.f !== undefined)) {
      const v = cell.f !== undefined ? calc.value(si, r, c) : cell.v;
      const text = formatForFit(v, style.numFmt, wb.date1904);
      if (mergeAt(sheet, r, c)) lines = 1;
      else if (style.rotate) {
        // Turned text needs the height of its slant.
        const a = style.rotate === 255 ? Math.PI / 2 : ((style.rotate <= 90 ? style.rotate : style.rotate - 90) * Math.PI) / 180;
        const w = style.rotate === 255 ? text.length * lineH : excelWidth(text, style.font, 1);
        extra = Math.abs(w * Math.sin(a)) + Math.abs(lineH * Math.cos(a)) - lineH + 4;
      } else if (style.wrap) lines = wrapLines(text, fontCss(style.font, 1), Math.max(1, colWidth(c) - 6)).length;
    } else if (!cell) continue;
    max = Math.max(max, lines * lineH + 2 + extra);
  }
  return Math.max(sheet.defaultRowHeight, Math.round(max)) || sheet.defaultRowHeight;
}


/** Rows without a stored height grow to fit wrapped, turned and large text when a file opens, as in Excel. */
export function fitRowsOnLoad(wb: Workbook): Workbook {
  const calc = new CalcLite(wb);
  const sheets = wb.sheets.map((sheet, si) => {
    const candidates = new Set<number>();
    for (const [k, cell] of sheet.cells) {
      if (cell.v === null && cell.f === undefined) continue;
      const st = wb.styles.get(cell.s);
      if (st.wrap || st.rotate || st.font.size > 11.5) candidates.add(Math.floor(k / 16384));
    }
    if (!candidates.size) return sheet;
    let rows: Map<number, RowInfo> | null = null;
    for (const r of candidates) {
      const info = sheet.rows.get(r);
      if (info?.h !== undefined || info?.hidden) continue;
      const h = autofitHeight(wb, si, calc, r, (c) => colWidthOf(sheet, c));
      if (h > sheet.defaultRowHeight) {
        rows ??= new Map(sheet.rows);
        rows.set(r, { ...info, h });
      }
    }
    return rows ? { ...sheet, rows } : sheet;
  });
  return { ...wb, sheets };
}

/** Values as the file cached them: enough to measure rows before anything is calculated. */
class CalcLite implements Values {
  constructor(private wb: Workbook) {}
  value(s: number, r: number, c: number) {
    return this.wb.sheets[s]?.cells.get(cellKey(r, c))?.v ?? null;
  }
}
