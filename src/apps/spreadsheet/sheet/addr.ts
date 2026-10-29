/** Cell addresses: A1 names, ranges, and the numeric keys cells are stored under. */

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

/** Zero-based, inclusive on both ends. */
export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const cellKey = (r: number, c: number) => r * MAX_COLS + c;
export const keyRow = (k: number) => Math.floor(k / MAX_COLS);
export const keyCol = (k: number) => k % MAX_COLS;

export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const cellName = (r: number, c: number) => `${colName(c)}${r + 1}`;

export function rangeName(g: Range): string {
  if (g.r0 === 0 && g.r1 === MAX_ROWS - 1) return `${colName(g.c0)}:${colName(g.c1)}`;
  if (g.c0 === 0 && g.c1 === MAX_COLS - 1) return `${g.r0 + 1}:${g.r1 + 1}`;
  if (g.r0 === g.r1 && g.c0 === g.c1) return cellName(g.r0, g.c0);
  return `${cellName(g.r0, g.c0)}:${cellName(g.r1, g.c1)}`;
}

/** A sheet name as formulas write it: quoted when it isn't a plain word. */
export function quoteSheet(name: string): string {
  if (/^[A-Za-z_\u00c0-\uffff][\w.\u00c0-\uffff]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^R\d*C\d*$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseCell(text: string): { r: number; c: number } | null {
  const m = CELL_RE.exec(text.trim());
  if (!m) return null;
  const c = colIndex(m[1]);
  const r = parseInt(m[2], 10) - 1;
  if (c < 0 || c >= MAX_COLS || r < 0 || r >= MAX_ROWS) return null;
  return { r, c };
}

/** "A1", "A1:C3", "A:C", "2:5" → a range. */
export function parseRange(text: string): Range | null {
  const t = text.trim().replace(/\$/g, '');
  const parts = t.split(':');
  if (parts.length === 1) {
    const a = parseCell(t);
    return a ? { r0: a.r, c0: a.c, r1: a.r, c1: a.c } : null;
  }
  if (parts.length !== 2) return null;
  const [p, q] = parts;
  if (/^[A-Za-z]{1,3}$/.test(p) && /^[A-Za-z]{1,3}$/.test(q)) {
    const c0 = colIndex(p);
    const c1 = colIndex(q);
    if (c0 >= MAX_COLS || c1 >= MAX_COLS) return null;
    return normRange({ r0: 0, c0, r1: MAX_ROWS - 1, c1 });
  }
  if (/^\d+$/.test(p) && /^\d+$/.test(q)) {
    const r0 = parseInt(p, 10) - 1;
    const r1 = parseInt(q, 10) - 1;
    if (r0 < 0 || r1 < 0 || r0 >= MAX_ROWS || r1 >= MAX_ROWS) return null;
    return normRange({ r0, c0: 0, r1, c1: MAX_COLS - 1 });
  }
  const a = parseCell(p);
  const b = parseCell(q);
  if (!a || !b) return null;
  return normRange({ r0: a.r, c0: a.c, r1: b.r, c1: b.c });
}

export function normRange(g: Range): Range {
  return { r0: Math.min(g.r0, g.r1), c0: Math.min(g.c0, g.c1), r1: Math.max(g.r0, g.r1), c1: Math.max(g.c0, g.c1) };
}

export const single = (r: number, c: number): Range => ({ r0: r, c0: c, r1: r, c1: c });
export const inRange = (g: Range, r: number, c: number) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
export const rangeRows = (g: Range) => g.r1 - g.r0 + 1;
export const rangeCols = (g: Range) => g.c1 - g.c0 + 1;
export const sameRange = (a: Range, b: Range) => a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;
export const isWholeCols = (g: Range) => g.r0 === 0 && g.r1 === MAX_ROWS - 1;
export const isWholeRows = (g: Range) => g.c0 === 0 && g.c1 === MAX_COLS - 1;

export function intersects(a: Range, b: Range): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

export function intersection(a: Range, b: Range): Range | null {
  if (!intersects(a, b)) return null;
  return { r0: Math.max(a.r0, b.r0), c0: Math.max(a.c0, b.c0), r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1) };
}

export function contains(outer: Range, inner: Range): boolean {
  return inner.r0 >= outer.r0 && inner.r1 <= outer.r1 && inner.c0 >= outer.c0 && inner.c1 <= outer.c1;
}

export function union(a: Range, b: Range): Range {
  return { r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0), r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1) };
}
