import { cellKey, intersects, isWholeCols, isWholeRows, keyCol, keyRow, MAX_COLS, MAX_ROWS, type Range } from './addr';
import { formatRef as formatRefFn, renameSheetInFormula, shiftFormula, tokenize as tokenizeForMove, translateFormula } from './formula';
import { dateSerial, DAYS, MONTHS, serialParts } from './dates';
import { cellsIn, freshSheetName, mergeAt, newSheet, sheetExtent, styleIdAt, type BorderStyle, type Cell, type ColInfo, type RowInfo, type Sheet, type Style, type Workbook } from './model';
import { isDateFormat } from './numfmt';
import { compare, type Scalar } from './values';

/**
 * Workbook edits as pure functions: each takes a workbook and returns a new
 * one, sharing what didn't change, so undo is just keeping the old one.
 */

export function updateSheet(wb: Workbook, i: number, fn: (s: Sheet) => Sheet): Workbook {
  const sheets = wb.sheets.slice();
  sheets[i] = fn(sheets[i]);
  return { ...wb, sheets };
}

/** A sheet with some cells replaced (null removes). */
export function withCells(sheet: Sheet, updates: Iterable<[number, Cell | null]>): Sheet {
  const cells = new Map(sheet.cells);
  for (const [k, c] of updates) {
    if (c === null || (c.v === null && c.f === undefined && !c.s)) cells.delete(k);
    else cells.set(k, c);
  }
  return { ...sheet, cells };
}

export function setCell(wb: Workbook, i: number, r: number, c: number, cell: Cell | null): Workbook {
  return updateSheet(wb, i, (s) => withCells(s, [[cellKey(r, c), cell]]));
}

// ---- Formatting ----------------------------------------------------------------------------------

/**
 * Change the format of every cell in some ranges. Whole columns and rows
 * take the format themselves (so new cells there get it too), like Excel.
 */
export function formatRanges(wb: Workbook, i: number, ranges: Range[], fn: (s: Style) => Style): Workbook {
  const st = wb.styles;
  const memo = new Map<number, number>();
  const derive = (id: number | undefined) => {
    const k = id ?? 0;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = st.derive(k, fn)));
    return v;
  };
  return updateSheet(wb, i, (sheet) => {
    const cells = new Map(sheet.cells);
    let cols = sheet.cols;
    let rows = sheet.rows;
    const touched = new Set<number>();
    for (const g of ranges) {
      if (isWholeCols(g)) {
        // Whole columns (the whole sheet included) take the format; so do rows formatted on their own.
        cols = new Map(cols);
        for (let c = g.c0; c <= g.c1; c++) {
          const info = cols.get(c) ?? {};
          cols.set(c, { ...info, s: derive(info.s) });
        }
        if (isWholeRows(g)) {
          rows = new Map(rows);
          for (const [r, info] of rows) if (info.s !== undefined) rows.set(r, { ...info, s: derive(info.s) });
        }
      } else if (isWholeRows(g)) {
        rows = new Map(rows);
        for (let r = g.r0; r <= g.r1 && r <= Math.max(sheetExtent(sheet).rows, g.r0 + 2000); r++) {
          const info = rows.get(r) ?? {};
          rows.set(r, { ...info, s: derive(info.s) });
        }
      }
      const whole = isWholeRows(g) || isWholeCols(g);
      if (whole) {
        cellsIn(sheet, g, (r, c, cell) => {
          const k = cellKey(r, c);
          if (touched.has(k)) return;
          touched.add(k);
          cells.set(k, { ...cell, s: derive(cell.s) });
        });
        // Cells in formatted rows/columns crossing these keep their own row/column format.
        continue;
      }
      for (let r = g.r0; r <= g.r1; r++)
        for (let c = g.c0; c <= g.c1; c++) {
          const k = cellKey(r, c);
          if (touched.has(k)) continue;
          touched.add(k);
          const cell = cells.get(k);
          const base = cell?.s ?? styleIdAt(sheet, r, c);
          const s = derive(base);
          if (cell) cells.set(k, { ...cell, s });
          else if (s !== 0) cells.set(k, { v: null, s });
        }
    }
    return { ...sheet, cells, cols, rows };
  });
}

/** Borders: Office's presets apply sides to the outline or inside of a range. */
export type BorderPreset = 'bottom' | 'top' | 'left' | 'right' | 'none' | 'all' | 'outside' | 'thickOutside' | 'thickBottom' | 'doubleBottom' | 'topBottom' | 'topThickBottom' | 'topDoubleBottom' | 'inside';

export function applyBorders(wb: Workbook, i: number, g: Range, preset: BorderPreset, color = '000000', style: BorderStyle = 'thin'): Workbook {
  const side = (s: BorderStyle = style) => ({ style: s, color });
  let out = wb;
  const edge = (range: Range, fn: (st: Style, r: number, c: number) => Style) => {
    out = formatRangesAt(out, i, range, fn);
  };
  switch (preset) {
    case 'none':
      edge(g, (s) => ({ ...s, border: {} }));
      break;
    case 'bottom':
      edge({ ...g, r0: g.r1 }, (s) => ({ ...s, border: { ...s.border, b: side() } }));
      break;
    case 'top':
      edge({ ...g, r1: g.r0 }, (s) => ({ ...s, border: { ...s.border, t: side() } }));
      break;
    case 'left':
      edge({ ...g, c1: g.c0 }, (s) => ({ ...s, border: { ...s.border, l: side() } }));
      break;
    case 'right':
      edge({ ...g, c0: g.c1 }, (s) => ({ ...s, border: { ...s.border, r: side() } }));
      break;
    case 'all':
      edge(g, (s) => ({ ...s, border: { l: side(), r: side(), t: side(), b: side() } }));
      break;
    case 'inside':
      edge(g, (s, r, c) => ({
        ...s,
        border: { ...s.border, ...(c > g.c0 ? { l: side() } : {}), ...(c < g.c1 ? { r: side() } : {}), ...(r > g.r0 ? { t: side() } : {}), ...(r < g.r1 ? { b: side() } : {}) },
      }));
      break;
    case 'outside':
    case 'thickOutside': {
      const st = preset === 'thickOutside' ? 'thick' : style;
      edge(g, (s, r, c) => ({
        ...s,
        border: { ...s.border, ...(c === g.c0 ? { l: side(st) } : {}), ...(c === g.c1 ? { r: side(st) } : {}), ...(r === g.r0 ? { t: side(st) } : {}), ...(r === g.r1 ? { b: side(st) } : {}) },
      }));
      break;
    }
    case 'thickBottom':
      edge({ ...g, r0: g.r1 }, (s) => ({ ...s, border: { ...s.border, b: side('thick') } }));
      break;
    case 'doubleBottom':
      edge({ ...g, r0: g.r1 }, (s) => ({ ...s, border: { ...s.border, b: side('double') } }));
      break;
    case 'topBottom':
    case 'topThickBottom':
    case 'topDoubleBottom':
      edge({ ...g, r1: g.r0 }, (s) => ({ ...s, border: { ...s.border, t: side() } }));
      edge({ ...g, r0: g.r1 }, (s) => ({ ...s, border: { ...s.border, b: side(preset === 'topThickBottom' ? 'thick' : preset === 'topDoubleBottom' ? 'double' : style) } }));
      break;
  }
  return out;
}

/** Like formatRanges, with the cell's position (for borders that depend on it). */
function formatRangesAt(wb: Workbook, i: number, g: Range, fn: (s: Style, r: number, c: number) => Style): Workbook {
  const st = wb.styles;
  return updateSheet(wb, i, (sheet) => {
    const cells = new Map(sheet.cells);
    const r1 = Math.min(g.r1, Math.max(sheetExtent(sheet).rows + 1, g.r0 + 5000));
    const c1 = Math.min(g.c1, Math.max(sheetExtent(sheet).cols + 1, g.c0 + 200));
    for (let r = g.r0; r <= r1; r++)
      for (let c = g.c0; c <= c1; c++) {
        const k = cellKey(r, c);
        const cell = cells.get(k);
        const s = st.id(fn(st.get(cell?.s ?? styleIdAt(sheet, r, c)), r, c));
        if (cell) cells.set(k, { ...cell, s });
        else if (s !== 0) cells.set(k, { v: null, s });
      }
    return { ...sheet, cells };
  });
}

// ---- Clearing ----------------------------------------------------------------------------------

export function clearRanges(wb: Workbook, i: number, ranges: Range[], what: 'all' | 'contents' | 'formats'): Workbook {
  return updateSheet(wb, i, (sheet) => {
    const cells = new Map(sheet.cells);
    for (const g of ranges) {
      cellsIn(sheet, g, (r, c, cell) => {
        const k = cellKey(r, c);
        if (what === 'all') cells.delete(k);
        else if (what === 'contents') {
          if (cell.s) cells.set(k, { v: null, s: cell.s });
          else cells.delete(k);
        } else if (cell.v === null && cell.f === undefined) cells.delete(k);
        else cells.set(k, { v: cell.v, f: cell.f });
      });
    }
    let links = sheet.links;
    if (what === 'all' && links.size) {
      links = new Map(links);
      for (const k of [...links.keys()]) if (ranges.some((g) => keyRow(k) >= g.r0 && keyRow(k) <= g.r1 && keyCol(k) >= g.c0 && keyCol(k) <= g.c1)) links.delete(k);
    }
    let merges = sheet.merges;
    if (what !== 'contents') merges = merges.filter((m) => !ranges.some((g) => intersects(g, m) && m.r0 >= g.r0 && m.r1 <= g.r1 && m.c0 >= g.c0 && m.c1 <= g.c1));
    return { ...sheet, cells, merges, links };
  });
}

// ---- Inserting and deleting rows and columns ------------------------------------------------------

function shiftMap<T>(map: Map<number, T>, at: number, n: number): Map<number, T> {
  const out = new Map<number, T>();
  for (const [k, v] of map) {
    if (k < at) out.set(k, v);
    else if (n > 0) out.set(k + n, v);
    else if (k >= at - n) out.set(k + n, v);
  }
  return out;
}

/** Rows (axis 'row') or columns inserted (n > 0) or deleted (n < 0) at `at`, formulas everywhere following along. */
export function shiftAxis(wb: Workbook, i: number, axis: 'row' | 'col', at: number, n: number): Workbook {
  const target = wb.sheets[i].name;
  const sheets = wb.sheets.map((sheet, si) => {
    let cells: Map<number, Cell>;
    if (si === i) {
      cells = new Map();
      for (const [k, cell] of sheet.cells) {
        let r = keyRow(k);
        let c = keyCol(k);
        const p = axis === 'row' ? r : c;
        if (n < 0 && p >= at && p < at - n) continue;
        if (p >= at) {
          if (axis === 'row') r += n;
          else c += n;
        }
        if (r >= MAX_ROWS || c >= MAX_COLS) continue;
        const f = cell.f !== undefined ? shiftFormula(cell.f, sheet.name, target, axis, at, n) : undefined;
        cells.set(cellKey(r, c), f !== undefined ? { ...cell, f } : cell);
      }
    } else {
      let changed = false;
      cells = new Map(sheet.cells);
      for (const [k, cell] of sheet.cells) {
        if (cell.f === undefined || !cell.f.includes('!')) continue;
        const f = shiftFormula(cell.f, sheet.name, target, axis, at, n);
        if (f !== cell.f) {
          cells.set(k, { ...cell, f });
          changed = true;
        }
      }
      if (!changed) return sheet;
    }
    if (si !== i) return { ...sheet, cells };
    const lo = (g: Range) => (axis === 'row' ? g.r0 : g.c0);
    const hi = (g: Range) => (axis === 'row' ? g.r1 : g.c1);
    const set = (g: Range, a: number, b: number): Range => (axis === 'row' ? { ...g, r0: a, r1: b } : { ...g, c0: a, c1: b });
    const merges: Range[] = [];
    for (const m of sheet.merges) {
      let a = lo(m);
      let b = hi(m);
      if (n > 0) {
        if (a >= at) a += n;
        if (b >= at) b += n;
      } else {
        const end = at - n - 1;
        if (a >= at && b <= end) continue;
        a = a < at ? a : a > end ? a + n : at;
        b = b < at ? b : b > end ? b + n : at - 1;
        if (b < a) continue;
      }
      const g = set(m, a, b);
      if (g.r0 !== g.r1 || g.c0 !== g.c1) merges.push(g);
    }
    const links = new Map<number, string>();
    for (const [k, url] of sheet.links) {
      let r = keyRow(k);
      let c = keyCol(k);
      const p = axis === 'row' ? r : c;
      if (n < 0 && p >= at && p < at - n) continue;
      if (p >= at) {
        if (axis === 'row') r += n;
        else c += n;
      }
      if (r < MAX_ROWS && c < MAX_COLS) links.set(cellKey(r, c), url);
    }
    const rows: Map<number, RowInfo> = axis === 'row' ? shiftMap(sheet.rows, at, n) : sheet.rows;
    const cols: Map<number, ColInfo> = axis === 'col' ? shiftMap(sheet.cols, at, n) : sheet.cols;
    // New rows and columns take the format of the one before them, as in Excel.
    if (n > 0 && at > 0) {
      const prevCells: [number, Cell][] = [];
      cellsIn(sheet, axis === 'row' ? { r0: at - 1, c0: 0, r1: at - 1, c1: MAX_COLS - 1 } : { r0: 0, c0: at - 1, r1: MAX_ROWS - 1, c1: at - 1 }, (r, c, cell) => {
        if (cell.s) prevCells.push([axis === 'row' ? c : r, cell]);
      });
      for (const [pos, cell] of prevCells)
        for (let k = 0; k < n; k++) cells.set(axis === 'row' ? cellKey(at + k, pos) : cellKey(pos, at + k), { v: null, s: cell.s });
    }
    let freeze = sheet.freeze;
    const fp = axis === 'row' ? freeze.rows : freeze.cols;
    if (fp > at) {
      const nf = n > 0 ? fp + n : Math.max(at, fp + n);
      freeze = axis === 'row' ? { ...freeze, rows: nf } : { ...freeze, cols: nf };
    }
    return { ...sheet, cells, rows, cols, merges, freeze, links };
  });
  const names = wb.names.map((d) => ({ ...d, formula: shiftFormula(d.formula, d.sheet !== null ? wb.sheets[d.sheet].name : target, target, axis, at, n) }));
  return { ...wb, sheets, names };
}

/** Insert or delete cells, shifting the rest of their rows right/left or columns down/up. */
export function shiftCells(wb: Workbook, i: number, g: Range, dir: 'right' | 'down' | 'left' | 'up'): Workbook {
  return updateSheet(wb, i, (sheet) => {
    const cells = new Map<number, Cell>();
    const h = g.r1 - g.r0 + 1;
    const w = g.c1 - g.c0 + 1;
    for (const [k, cell] of sheet.cells) {
      let r = keyRow(k);
      let c = keyCol(k);
      const inRows = r >= g.r0 && r <= g.r1;
      const inCols = c >= g.c0 && c <= g.c1;
      if (dir === 'right' && inRows && c >= g.c0) c += w;
      else if (dir === 'down' && inCols && r >= g.r0) r += h;
      else if (dir === 'left' && inRows && c >= g.c0) {
        if (c <= g.c1) continue;
        c -= w;
      } else if (dir === 'up' && inCols && r >= g.r0) {
        if (r <= g.r1) continue;
        r -= h;
      }
      if (r < MAX_ROWS && c < MAX_COLS) cells.set(cellKey(r, c), cell);
    }
    return { ...sheet, cells };
  });
}

// ---- Merging ------------------------------------------------------------------------------------

export function mergeCells(wb: Workbook, i: number, g: Range, how: 'center' | 'across' | 'merge'): Workbook {
  const pieces: Range[] = how === 'across' ? Array.from({ length: g.r1 - g.r0 + 1 }, (_, k) => ({ r0: g.r0 + k, r1: g.r0 + k, c0: g.c0, c1: g.c1 })) : [g];
  let out = updateSheet(wb, i, (sheet) => {
    const merges = sheet.merges.filter((m) => !pieces.some((p) => intersects(p, m)));
    const cells = new Map(sheet.cells);
    for (const p of pieces) {
      if (p.r0 === p.r1 && p.c0 === p.c1) continue;
      merges.push(p);
      // Only the upper-left value is kept.
      let kept = false;
      cellsIn(sheet, p, (r, c, cell) => {
        const k = cellKey(r, c);
        if (!kept && (cell.v !== null || cell.f !== undefined)) {
          kept = true;
          if (r !== p.r0 || c !== p.c0) {
            cells.set(cellKey(p.r0, p.c0), { ...cell, s: cells.get(cellKey(p.r0, p.c0))?.s ?? cell.s });
            cells.set(k, { v: null, s: cell.s });
          }
        } else if (r !== p.r0 || c !== p.c0) cells.set(k, { v: null, s: cell.s });
      });
    }
    return { ...sheet, merges, cells };
  });
  if (how === 'center') out = formatRanges(out, i, [g], (s) => ({ ...s, h: 'center' }));
  return out;
}

export function unmergeCells(wb: Workbook, i: number, g: Range): Workbook {
  return updateSheet(wb, i, (sheet) => ({ ...sheet, merges: sheet.merges.filter((m) => !intersects(m, g)) }));
}

// ---- Fill series ------------------------------------------------------------------------------

const SERIES_LISTS = [
  DAYS.map((d) => d.slice(0, 3)),
  DAYS,
  MONTHS.map((m) => m.slice(0, 3)),
  MONTHS,
];

function matchCase(word: string, like: string): string {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (like === like.toLowerCase()) return word.toLowerCase();
  return word;
}

/** The next values of a run of source values, extending it `count` steps (negative: backwards). */
function extend(values: Cell[], count: number, date1904: boolean, isDate: boolean, src: { r: number; c: number }[], target: (k: number) => { r: number; c: number }): Cell[] {
  const out: Cell[] = [];
  const n = values.length;
  const nums = values.map((v) => (v.f === undefined && typeof v.v === 'number' ? v.v : null));
  const allNums = nums.every((x) => x !== null);
  // Linear trend (least squares) through numbers; one date steps by a day.
  if (allNums && (n > 1 || isDate)) {
    let step = 1;
    let base = nums[n - 1]!;
    if (n > 1) {
      const xs = nums.map((_, i) => i);
      const mx = (n - 1) / 2;
      const my = nums.reduce((a, b) => a + b!, 0) / n;
      let sxy = 0;
      let sxx = 0;
      xs.forEach((x, i) => {
        sxy += (x - mx) * (nums[i]! - my);
        sxx += (x - mx) ** 2;
      });
      step = sxy / sxx;
      base = my + step * (n - 1 - mx);
      // Month steps between dates on the same day of the month go by month.
      if (isDate && n > 1) {
        const parts = nums.map((x) => serialParts(x!, date1904));
        if (parts.every((p) => p.d === parts[0].d)) {
          const months = parts.map((p) => p.y * 12 + p.m - 1);
          const ms = months[1] - months[0];
          if (ms && months.every((m, i) => m === months[0] + i * ms)) {
            for (let k = 1; k <= Math.abs(count); k++) {
              const idx = count > 0 ? n - 1 + k : -k;
              const total = months[0] + idx * ms;
              out.push({ ...values[((count > 0 ? k - 1 : -k) % n + n) % n], v: dateSerial(Math.floor(total / 12), (total % 12) + 1, parts[0].d, date1904), f: undefined });
            }
            return out;
          }
        }
      }
    }
    for (let k = 1; k <= Math.abs(count); k++) {
      const v = count > 0 ? base + step * k : nums[0]! - step * k;
      const proto = values[((count > 0 ? k - 1 : -k) % n + n) % n];
      out.push({ ...proto, v: Number(v.toPrecision(15)), f: undefined });
    }
    return out;
  }
  // Text with a number at its end (Item 1, Q3) counts up; day and month names go round.
  const series = values.map((v) => {
    if (v.f !== undefined || typeof v.v !== 'string') return null;
    for (const list of SERIES_LISTS) {
      const i = list.findIndex((w) => w.toLowerCase() === (v.v as string).toLowerCase());
      if (i >= 0) return { list, i, like: v.v as string };
    }
    return null;
  });
  if (series.every((s) => s && s.list === series[0]!.list)) {
    const list = series[0]!.list;
    const step = n > 1 ? series[1]!.i - series[0]!.i : 1;
    for (let k = 1; k <= Math.abs(count); k++) {
      const i = count > 0 ? series[n - 1]!.i + step * k : series[0]!.i - step * k;
      const idx = ((i % list.length) + list.length) % list.length;
      out.push({ ...values[((count > 0 ? k - 1 : -k) % n + n) % n], v: matchCase(list[idx], series[0]!.like) });
    }
    return out;
  }
  const numbered = values.map((v) => (v.f === undefined && typeof v.v === 'string' ? /^(.*?)(\d+)$/.exec(v.v) : null));
  if (numbered.every((m) => m && m[1] === numbered[0]![1])) {
    const ns = numbered.map((m) => parseInt(m![2], 10));
    const step = n > 1 ? ns[1] - ns[0] : 1;
    const width = numbered[0]![2].startsWith('0') ? numbered[0]![2].length : 0;
    for (let k = 1; k <= Math.abs(count); k++) {
      const x = Math.abs(count > 0 ? ns[n - 1] + step * k : ns[0] - step * k);
      out.push({ ...values[((count > 0 ? k - 1 : -k) % n + n) % n], v: `${numbered[0]![1]}${String(x).padStart(width, '0')}` });
    }
    return out;
  }
  // Anything else repeats, formulas moving with their cells.
  for (let k = 1; k <= Math.abs(count); k++) {
    const si = ((count > 0 ? k - 1 : -k) % n + n) % n;
    const proto = values[si];
    if (proto.f !== undefined) {
      const from = src[si];
      const to = target(k);
      out.push({ ...proto, f: translateFormula(proto.f, to.r - from.r, to.c - from.c) });
    } else out.push(proto);
  }
  return out;
}

/** Drag the fill handle from `src` to cover `dest` (which contains it). Ctrl copies instead of extending a single value series. */
export function fillRange(wb: Workbook, i: number, src: Range, dest: Range, copyOnly = false): Workbook {
  const sheet = wb.sheets[i];
  const updates: [number, Cell | null][] = [];
  const vertical = dest.r0 !== src.r0 || dest.r1 !== src.r1;
  const get = (r: number, c: number): Cell => sheet.cells.get(cellKey(r, c)) ?? { v: null };
  if (vertical) {
    for (let c = src.c0; c <= src.c1; c++) {
      const values: Cell[] = [];
      const pos: { r: number; c: number }[] = [];
      for (let r = src.r0; r <= src.r1; r++) {
        values.push(get(r, c));
        pos.push({ r, c });
      }
      const isDate = values.length > 0 && isDateFormat(wb.styles.get(values[0].s).numFmt);
      const down = dest.r1 - src.r1;
      const up = src.r0 - dest.r0;
      const fill = (count: number, at: (k: number) => number) => {
        const vals = copyOnly ? copyCycle(values, count, pos, (k) => ({ r: at(k), c })) : extend(values, count, wb.date1904, isDate, pos, (k) => ({ r: at(k), c }));
        vals.forEach((v, k) => updates.push([cellKey(at(k + 1), c), v]));
      };
      if (down > 0) fill(down, (k) => src.r1 + k);
      if (up > 0) fill(-up, (k) => src.r0 - k);
    }
  } else {
    for (let r = src.r0; r <= src.r1; r++) {
      const values: Cell[] = [];
      const pos: { r: number; c: number }[] = [];
      for (let c = src.c0; c <= src.c1; c++) {
        values.push(get(r, c));
        pos.push({ r, c });
      }
      const isDate = values.length > 0 && isDateFormat(wb.styles.get(values[0].s).numFmt);
      const right = dest.c1 - src.c1;
      const left = src.c0 - dest.c0;
      const fill = (count: number, at: (k: number) => number) => {
        const vals = copyOnly ? copyCycle(values, count, pos, (k) => ({ r, c: at(k) })) : extend(values, count, wb.date1904, isDate, pos, (k) => ({ r, c: at(k) }));
        vals.forEach((v, k) => updates.push([cellKey(r, at(k + 1)), v]));
      };
      if (right > 0) fill(right, (k) => src.c1 + k);
      if (left > 0) fill(-left, (k) => src.c0 - k);
    }
  }
  return updateSheet(wb, i, (s) => withCells(s, updates));
}

function copyCycle(values: Cell[], count: number, src: { r: number; c: number }[], target: (k: number) => { r: number; c: number }): Cell[] {
  const n = values.length;
  const out: Cell[] = [];
  for (let k = 1; k <= Math.abs(count); k++) {
    const si = ((count > 0 ? k - 1 : -k) % n + n) % n;
    const proto = values[si];
    if (proto.f !== undefined) {
      const to = target(k);
      out.push({ ...proto, f: translateFormula(proto.f, to.r - src[si].r, to.c - src[si].c) });
    } else out.push(proto);
  }
  return out;
}

/** Ctrl+D / Ctrl+R: the first row (column) of a range copied down (right) through it. */
export function fillDownRight(wb: Workbook, i: number, g: Range, dir: 'down' | 'right'): Workbook {
  if (dir === 'down') {
    if (g.r0 === g.r1) return g.r0 === 0 ? wb : fillRange(wb, i, { ...g, r0: g.r0 - 1, r1: g.r0 - 1 }, { ...g, r0: g.r0 - 1 }, true);
    return fillRange(wb, i, { ...g, r1: g.r0 }, g, true);
  }
  if (g.c0 === g.c1) return g.c0 === 0 ? wb : fillRange(wb, i, { ...g, c0: g.c0 - 1, c1: g.c0 - 1 }, { ...g, c0: g.c0 - 1 }, true);
  return fillRange(wb, i, { ...g, c1: g.c0 }, g, true);
}

// ---- Clipboard ----------------------------------------------------------------------------------

export interface Clip {
  rows: number;
  cols: number;
  /** Cells as copied (formulas, formats), row by row; null for empty. */
  cells: (Cell | null)[][];
  /** Computed values, for Paste Values. */
  values: Scalar[][];
  /** Where it was copied from, for moving formulas. */
  origin: { sheet: number; r: number; c: number };
  merges: Range[];
  /** The text put on the system clipboard, to recognise our own copy coming back. */
  text: string;
  cut: boolean;
}

export type PasteMode = 'all' | 'values' | 'formulas' | 'formats' | 'transpose' | 'noBorders' | 'valuesFormats';

export function paste(wb: Workbook, i: number, at: { r: number; c: number }, clip: Clip, mode: PasteMode = 'all', target?: Range): Workbook {
  const sheet = wb.sheets[i];
  const updates: [number, Cell | null][] = [];
  const transpose = mode === 'transpose';
  const h = transpose ? clip.cols : clip.rows;
  const w = transpose ? clip.rows : clip.cols;
  // A copied block pasted into a bigger selection that's a multiple of it repeats, like Excel.
  const reps = target && (target.r1 - target.r0 + 1) % h === 0 && (target.c1 - target.c0 + 1) % w === 0 ? { r: (target.r1 - target.r0 + 1) / h, c: (target.c1 - target.c0 + 1) / w } : { r: 1, c: 1 };
  for (let ry = 0; ry < reps.r; ry++)
    for (let rx = 0; rx < reps.c; rx++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sy = transpose ? x : y;
          const sx = transpose ? y : x;
          const src = clip.cells[sy][sx];
          const r = at.r + ry * h + y;
          const c = at.c + rx * w + x;
          if (r >= MAX_ROWS || c >= MAX_COLS) continue;
          const k = cellKey(r, c);
          const existing = sheet.cells.get(k);
          const dr = r - (clip.origin.r + sy);
          const dc = c - (clip.origin.c + sx);
          let cell: Cell | null;
          switch (mode) {
            case 'values':
              cell = clip.values[sy][sx] === null ? (existing?.s ? { v: null, s: existing.s } : null) : { v: clip.values[sy][sx], s: existing?.s };
              break;
            case 'valuesFormats':
              cell = clip.values[sy][sx] === null && !src?.s ? null : { v: clip.values[sy][sx], s: src?.s };
              break;
            case 'formulas':
              cell = src ? { v: src.v, f: src.f !== undefined ? (clip.cut ? src.f : translateFormula(src.f, dr, dc)) : undefined, s: existing?.s } : existing?.s ? { v: null, s: existing.s } : null;
              break;
            case 'formats':
              cell = existing ? { ...existing, s: src?.s } : src?.s ? { v: null, s: src.s } : null;
              break;
            case 'noBorders': {
              const s = src?.s ? wb.styles.derive(src.s, (st) => ({ ...st, border: {} })) : undefined;
              cell = src ? { ...src, s, f: src.f !== undefined ? (clip.cut ? src.f : translateFormula(src.f, dr, dc)) : undefined } : null;
              break;
            }
            default:
              cell = src ? { ...src, f: src.f !== undefined ? (clip.cut ? src.f : translateFormula(src.f, dr, dc)) : undefined } : null;
          }
          if (cell && cell.f === undefined) delete cell.f;
          updates.push([k, cell]);
        }
  let out = wb;
  if (clip.cut) {
    // Moving: the source is emptied first (where it doesn't overlap the destination).
    out = updateSheet(out, clip.origin.sheet, (s) => {
      const cells = new Map(s.cells);
      for (let y = 0; y < clip.rows; y++) for (let x = 0; x < clip.cols; x++) cells.delete(cellKey(clip.origin.r + y, clip.origin.c + x));
      return { ...s, cells };
    });
    // Formulas elsewhere that pointed at the moved cells follow them.
    out = moveReferences(out, clip.origin.sheet, { r0: clip.origin.r, c0: clip.origin.c, r1: clip.origin.r + clip.rows - 1, c1: clip.origin.c + clip.cols - 1 }, i, at);
  }
  out = updateSheet(out, i, (s) => withCells(s, updates));
  if ((mode === 'all' || mode === 'formats') && clip.merges.length && !transpose) {
    out = updateSheet(out, i, (s) => ({
      ...s,
      merges: [
        ...s.merges.filter((m) => !intersects(m, { r0: at.r, c0: at.c, r1: at.r + h - 1, c1: at.c + w - 1 })),
        ...clip.merges.map((m) => ({ r0: m.r0 + at.r, c0: m.c0 + at.c, r1: m.r1 + at.r, c1: m.c1 + at.c })),
      ],
    }));
  }
  return out;
}

/** After a cut and paste, references to the moved block point at its new place. */
function moveReferences(wb: Workbook, fromSheet: number, from: Range, toSheet: number, to: { r: number; c: number }): Workbook {
  const dr = to.r - from.r0;
  const dc = to.c - from.c0;
  if (!dr && !dc && fromSheet === toSheet) return wb;
  const fromName = wb.sheets[fromSheet].name;
  const sheets = wb.sheets.map((sheet) => {
    let cells: Map<number, Cell> | null = null;
    for (const [k, cell] of sheet.cells) {
      if (cell.f === undefined) continue;
      const f = moveRefsInFormula(cell.f, sheet.name, fromName, from, dr, dc, fromSheet !== toSheet ? wb.sheets[toSheet].name : null);
      if (f !== cell.f) {
        cells ??= new Map(sheet.cells);
        cells.set(k, { ...cell, f });
      }
    }
    return cells ? { ...sheet, cells } : sheet;
  });
  return { ...wb, sheets };
}

function moveRefsInFormula(src: string, own: string, fromName: string, from: Range, dr: number, dc: number, newSheet: string | null): string {
  // Rewrite by translating only references wholly inside the moved block.
  const toks = tokenizeForMove(src);
  let out = '';
  for (const t of toks) {
    if (t.ref && (t.ref.sheet ?? own).toLowerCase() === fromName.toLowerCase() && t.ref.kind !== 'cols' && t.ref.kind !== 'rows' && t.ref.r0 >= from.r0 && t.ref.r1 <= from.r1 && t.ref.c0 >= from.c0 && t.ref.c1 <= from.c1) {
      out += formatRefFn({ ...t.ref, r0: t.ref.r0 + dr, r1: t.ref.r1 + dr, c0: t.ref.c0 + dc, c1: t.ref.c1 + dc, sheet: newSheet ?? t.ref.sheet });
    } else out += t.text;
  }
  return out;
}


// ---- Sorting ---------------------------------------------------------------------------------

/** Does the first row of a range look like headers (text over numbers, or bold)? */
export function hasHeader(wb: Workbook, i: number, g: Range): boolean {
  if (g.r1 <= g.r0) return false;
  const sheet = wb.sheets[i];
  let textTop = 0;
  let numbersBelow = 0;
  let boldTop = 0;
  for (let c = g.c0; c <= g.c1; c++) {
    const top = sheet.cells.get(cellKey(g.r0, c));
    const below = sheet.cells.get(cellKey(g.r0 + 1, c));
    if (typeof top?.v === 'string') textTop++;
    if (below && typeof below.v !== 'string' && below.v !== null) numbersBelow++;
    if (wb.styles.get(top?.s).font.bold && !wb.styles.get(below?.s).font.bold) boldTop++;
  }
  return boldTop > 0 || (textTop === g.c1 - g.c0 + 1 && numbersBelow > 0);
}

export function sortRange(wb: Workbook, i: number, g: Range, keys: { col: number; asc: boolean }[], header: boolean, value: (r: number, c: number) => Scalar): Workbook {
  const sheet = wb.sheets[i];
  const r0 = header ? g.r0 + 1 : g.r0;
  if (r0 >= g.r1 + 1) return wb;
  const rows: number[] = [];
  for (let r = r0; r <= g.r1; r++) rows.push(r);
  const rank = (v: Scalar) => (v === null || v === '' ? 1 : 0);
  rows.sort((a, b) => {
    for (const k of keys) {
      const va = value(a, k.col);
      const vb = value(b, k.col);
      // Blanks always go last.
      const ba = rank(va);
      const bb = rank(vb);
      if (ba !== bb) return ba - bb;
      const d = compare(va, vb);
      if (d) return k.asc ? d : -d;
    }
    return a - b;
  });
  const updates: [number, Cell | null][] = [];
  rows.forEach((from, idx) => {
    const to = r0 + idx;
    for (let c = g.c0; c <= g.c1; c++) {
      const cell = sheet.cells.get(cellKey(from, c));
      updates.push([cellKey(to, c), cell ? (cell.f !== undefined ? { ...cell, f: translateFormula(cell.f, to - from, 0) } : cell) : null]);
    }
  });
  return updateSheet(wb, i, (s) => withCells(s, updates));
}

export function removeDuplicates(wb: Workbook, i: number, g: Range, cols: number[], header: boolean, value: (r: number, c: number) => Scalar): { wb: Workbook; removed: number; left: number } {
  const sheet = wb.sheets[i];
  const seen = new Set<string>();
  const keep: number[] = [];
  const r0 = header ? g.r0 + 1 : g.r0;
  for (let r = r0; r <= g.r1; r++) {
    const key = JSON.stringify(cols.map((c) => {
      const v = value(r, c);
      return typeof v === 'string' ? v.toLowerCase() : String(v);
    }));
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(r);
  }
  const updates: [number, Cell | null][] = [];
  for (let r = r0; r <= g.r1; r++) {
    const from = keep[r - r0];
    for (let c = g.c0; c <= g.c1; c++) updates.push([cellKey(r, c), from !== undefined ? (sheet.cells.get(cellKey(from, c)) ?? null) : null]);
  }
  return { wb: updateSheet(wb, i, (s) => withCells(s, updates)), removed: g.r1 - r0 + 1 - keep.length, left: keep.length };
}

// ---- Sheets ----------------------------------------------------------------------------------------

export function addSheet(wb: Workbook, at: number, name?: string): Workbook {
  const sheet = newSheet(name ?? freshSheetName(wb));
  const sheets = wb.sheets.slice();
  sheets.splice(at, 0, sheet);
  const names = wb.names.map((n) => (n.sheet !== null && n.sheet >= at ? { ...n, sheet: n.sheet + 1 } : n));
  return { ...wb, sheets, names, active: at };
}

export function deleteSheet(wb: Workbook, i: number): Workbook {
  const name = wb.sheets[i].name;
  const sheets = wb.sheets.filter((_, k) => k !== i).map((s) => {
    let cells: Map<number, Cell> | null = null;
    for (const [k, cell] of s.cells) {
      if (cell.f === undefined || !cell.f.includes('!')) continue;
      const f = renameSheetInFormula(cell.f, name, null);
      if (f !== cell.f) {
        cells ??= new Map(s.cells);
        cells.set(k, { ...cell, f });
      }
    }
    return cells ? { ...s, cells } : s;
  });
  const names = wb.names.filter((n) => n.sheet !== i).map((n) => ({ ...n, sheet: n.sheet !== null && n.sheet > i ? n.sheet - 1 : n.sheet, formula: renameSheetInFormula(n.formula, name, null) }));
  let active = wb.active >= i ? Math.max(0, wb.active - 1) : wb.active;
  if (sheets[active]?.hidden) active = Math.max(0, sheets.findIndex((s) => !s.hidden));
  return { ...wb, sheets, names, active };
}

export function renameSheet(wb: Workbook, i: number, to: string): Workbook {
  const from = wb.sheets[i].name;
  const sheets = wb.sheets.map((s, k) => {
    let cells: Map<number, Cell> | null = null;
    for (const [key, cell] of s.cells) {
      if (cell.f === undefined || !cell.f.includes('!')) continue;
      const f = renameSheetInFormula(cell.f, from, to);
      if (f !== cell.f) {
        cells ??= new Map(s.cells);
        cells.set(key, { ...cell, f });
      }
    }
    const base = k === i ? { ...s, name: to } : s;
    return cells ? { ...base, cells } : base;
  });
  const names = wb.names.map((n) => ({ ...n, formula: renameSheetInFormula(n.formula, from, to) }));
  return { ...wb, sheets, names };
}

export function moveSheet(wb: Workbook, from: number, to: number): Workbook {
  const sheets = wb.sheets.slice();
  const [s] = sheets.splice(from, 1);
  sheets.splice(to, 0, s);
  const map = (k: number) => {
    if (k === from) return to;
    if (from < to && k > from && k <= to) return k - 1;
    if (from > to && k >= to && k < from) return k + 1;
    return k;
  };
  return { ...wb, sheets, active: map(wb.active), names: wb.names.map((n) => (n.sheet !== null ? { ...n, sheet: map(n.sheet) } : n)) };
}

export function duplicateSheet(wb: Workbook, i: number, to: number): Workbook {
  const src = wb.sheets[i];
  let name = `${src.name} (2)`;
  for (let k = 3; wb.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()); k++) name = `${src.name} (${k})`;
  const copy: Sheet = { ...newSheet(name), ...src, id: newSheet(name).id, name, cells: new Map(src.cells), links: new Map(src.links) };
  const sheets = wb.sheets.slice();
  sheets.splice(to, 0, copy);
  return { ...wb, sheets, active: to };
}

export const SHEET_NAME_BAD = /[[\]:*?/\\]/;

export function validSheetName(wb: Workbook, name: string, except: number): string | null {
  const n = name.trim();
  if (!n) return 'The sheet name can’t be blank.';
  if (n.length > 31) return 'The sheet name can be at most 31 characters.';
  if (SHEET_NAME_BAD.test(n) || n.startsWith("'") || n.endsWith("'")) return 'The sheet name can’t contain : \\ / ? * [ or ], or begin or end with an apostrophe.';
  if (n.toLowerCase() === 'history') return '“History” is a reserved name.';
  if (wb.sheets.some((s, k) => k !== except && s.name.toLowerCase() === n.toLowerCase())) return 'That name is already taken. Try a different one.';
  return null;
}

// ---- Navigation ------------------------------------------------------------------------------

const filled = (sheet: Sheet, r: number, c: number) => {
  const cell = sheet.cells.get(cellKey(r, c));
  return !!cell && (cell.v !== null || cell.f !== undefined);
};

/** Ctrl+Arrow: the edge of the data block in a direction. */
export function dataEdge(sheet: Sheet, r: number, c: number, dr: number, dc: number): { r: number; c: number } {
  const maxR = MAX_ROWS - 1;
  const maxC = MAX_COLS - 1;
  const ext = sheetExtent(sheet);
  const inBounds = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= maxR && cc <= maxC;
  let rr = r + dr;
  let cc = c + dc;
  if (!inBounds(rr, cc)) return { r, c };
  const here = filled(sheet, r, c);
  const next = filled(sheet, rr, cc);
  if (here && next) {
    // Run to the last filled cell.
    while (inBounds(rr + dr, cc + dc) && filled(sheet, rr + dr, cc + dc)) {
      rr += dr;
      cc += dc;
    }
    return { r: rr, c: cc };
  }
  // Skip blanks to the next filled cell, or the sheet's edge.
  while (inBounds(rr, cc) && !filled(sheet, rr, cc)) {
    if ((dr > 0 && rr > ext.rows) || (dc > 0 && cc > ext.cols)) return { r: dr > 0 ? maxR : rr - dr * 0, c: dc > 0 ? maxC : cc };
    rr += dr;
    cc += dc;
  }
  if (!inBounds(rr, cc)) return { r: Math.max(0, Math.min(maxR, rr - dr)), c: Math.max(0, Math.min(maxC, cc - dc)) };
  return { r: rr, c: cc };
}

/** The contiguous block of data around a cell (Ctrl+A in data, AutoSum, Sort). */
export function currentRegion(sheet: Sheet, r: number, c: number): Range {
  let g: Range = { r0: r, c0: c, r1: r, c1: c };
  for (let changed = true; changed; ) {
    changed = false;
    const grow = (test: (rr: number, cc: number) => boolean, apply: () => void, range: () => [number, number, number, number]) => {
      const [a0, a1, b0, b1] = range();
      for (let rr = a0; rr <= a1; rr++)
        for (let cc = b0; cc <= b1; cc++)
          if (rr >= 0 && cc >= 0 && rr < MAX_ROWS && cc < MAX_COLS && test(rr, cc)) {
            apply();
            changed = true;
            return;
          }
    };
    const f = (rr: number, cc: number) => filled(sheet, rr, cc) || !!mergeAt(sheet, rr, cc);
    grow(f, () => g.r0--, () => [g.r0 - 1, g.r0 - 1, g.c0 - 1, g.c1 + 1]);
    grow(f, () => g.r1++, () => [g.r1 + 1, g.r1 + 1, g.c0 - 1, g.c1 + 1]);
    grow(f, () => g.c0--, () => [g.r0, g.r1, g.c0 - 1, g.c0 - 1]);
    grow(f, () => g.c1++, () => [g.r0, g.r1, g.c1 + 1, g.c1 + 1]);
    g = { r0: Math.max(0, g.r0), c0: Math.max(0, g.c0), r1: Math.min(MAX_ROWS - 1, g.r1), c1: Math.min(MAX_COLS - 1, g.c1) };
  }
  return g;
}

/** The range AutoSum adds up for a cell: the numbers above it, else to its left. */
export function autoSumRange(sheet: Sheet, r: number, c: number, value: (r: number, c: number) => Scalar): Range | null {
  const isNum = (rr: number, cc: number) => typeof value(rr, cc) === 'number';
  let rr = r - 1;
  while (rr >= 0 && value(rr, c) === null) rr--;
  if (rr >= 0 && isNum(rr, c)) {
    let top = rr;
    while (top - 1 >= 0 && (isNum(top - 1, c) || value(top - 1, c) === null) && !(value(top - 1, c) === null && top - 2 >= 0 && value(top - 2, c) === null)) top--;
    while (top < rr && value(top, c) === null) top++;
    return { r0: top, c0: c, r1: rr, c1: c };
  }
  let cc = c - 1;
  while (cc >= 0 && value(r, cc) === null) cc--;
  if (cc >= 0 && isNum(r, cc)) {
    let left = cc;
    while (left - 1 >= 0 && isNum(r, left - 1)) left--;
    return { r0: r, c0: left, r1: r, c1: cc };
  }
  return null;
}
