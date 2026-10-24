import type { Node } from './formula';
import { CellError, compare, ERR, isErr, toBool, toNum, toText, type Scalar } from './values';

/** What evaluating part of a formula gives: a value, a reference to cells, or an array. */
export interface RefValue {
  kind: 'ref';
  sheet: number;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface ArrValue {
  kind: 'arr';
  rows: Scalar[][];
}

export type EvalValue = Scalar | RefValue | ArrValue;

export const isRef = (v: EvalValue): v is RefValue => typeof v === 'object' && v !== null && !(v instanceof CellError) && v.kind === 'ref';
export const isArr = (v: EvalValue): v is ArrValue => typeof v === 'object' && v !== null && !(v instanceof CellError) && v.kind === 'arr';

/** The workbook as formulas see it. */
export interface EvalHost {
  sheetIndex(name: string): number;
  sheetName(index: number): string;
  sheetCount(): number;
  /** The computed value of a cell. */
  value(sheet: number, r: number, c: number): Scalar;
  /** The last used row and column of a sheet (-1 when empty), to bound A:A. */
  extent(sheet: number): { rows: number; cols: number };
  /** Non-empty cells in a range, in row order. */
  each(sheet: number, r0: number, c0: number, r1: number, c1: number, cb: (r: number, c: number, v: Scalar) => void): void;
  definedName(name: string, sheet: number): { node: Node; sheet: number } | null;
  formulaText(sheet: number, r: number, c: number): string | null;
  date1904: boolean;
}

export interface Ctx {
  host: EvalHost;
  sheet: number;
  r: number;
  c: number;
  evaluate(node: Node): EvalValue;
  /** Set by RAND, NOW, OFFSET...: recalculate every time. */
  volatile: boolean;
  /**
   * Inside an argument that takes arrays (SUMPRODUCT's, SUM's...), ranges in
   * expressions stay whole; elsewhere a range where one value belongs gives the
   * cell in the formula's own row or column (implicit intersection).
   */
  arrays: boolean;
}

/** A reference clipped to the part of the sheet that has anything in it. */
export function clip(ref: RefValue, host: EvalHost): RefValue {
  const ext = host.extent(ref.sheet);
  return { ...ref, r1: Math.min(ref.r1, Math.max(ref.r0, ext.rows)), c1: Math.min(ref.c1, Math.max(ref.c0, ext.cols)) };
}

/** A value for a scalar context: one cell of a reference (implicit intersection), the first of an array. */
export function scalar(v: EvalValue, ctx: Ctx): Scalar {
  if (isRef(v)) {
    if (v.r0 === v.r1 && v.c0 === v.c1) return ctx.host.value(v.sheet, v.r0, v.c0);
    if (v.c0 === v.c1 && ctx.r >= v.r0 && ctx.r <= v.r1) return ctx.host.value(v.sheet, ctx.r, v.c0);
    if (v.r0 === v.r1 && ctx.c >= v.c0 && ctx.c <= v.c1) return ctx.host.value(v.sheet, v.r0, ctx.c);
    return ERR.value;
  }
  if (isArr(v)) return v.rows[0]?.[0] ?? null;
  return v;
}

/** A 2D grid of values from a reference, array or single value. */
export function grid(v: EvalValue, ctx: Ctx): Scalar[][] {
  if (isRef(v)) {
    const c = clip(v, ctx.host);
    const rows: Scalar[][] = [];
    for (let r = c.r0; r <= c.r1; r++) {
      const row: Scalar[] = [];
      for (let col = c.c0; col <= c.c1; col++) row.push(ctx.host.value(c.sheet, r, col));
      rows.push(row);
    }
    return rows;
  }
  if (isArr(v)) return v.rows;
  return [[v]];
}

/** The size a reference or array has (before clipping). */
export function dims(v: EvalValue): { rows: number; cols: number } {
  if (isRef(v)) return { rows: v.r1 - v.r0 + 1, cols: v.c1 - v.c0 + 1 };
  if (isArr(v)) return { rows: v.rows.length, cols: v.rows[0]?.length ?? 0 };
  return { rows: 1, cols: 1 };
}

/**
 * The numbers in a list of arguments, SUM's way: from references and arrays only
 * numbers count; values typed straight into the call (text that reads as a
 * number, TRUE) count too. The first error wins.
 */
export function numbers(args: EvalValue[], ctx: Ctx, opts: { allA?: boolean } = {}): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (isRef(a)) {
      let e: CellError | null = null;
      ctx.host.each(a.sheet, a.r0, a.c0, a.r1, a.c1, (_r, _c, v) => {
        if (e) return;
        if (typeof v === 'number') out.push(v);
        else if (isErr(v)) e = v;
        else if (opts.allA) out.push(v === true ? 1 : 0);
      });
      if (e) return e;
    } else if (isArr(a)) {
      for (const row of a.rows)
        for (const v of row) {
          if (typeof v === 'number') out.push(v);
          else if (isErr(v)) return v;
          else if (opts.allA && v !== null) out.push(v === true ? 1 : 0);
        }
    } else if (a !== null) {
      const n = toNum(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Every value in the arguments, flattened (references clipped to used cells). */
export function flatValues(args: EvalValue[], ctx: Ctx, includeBlanks = false): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    if (isRef(a)) {
      if (includeBlanks) for (const row of grid(a, ctx)) out.push(...row);
      else ctx.host.each(a.sheet, a.r0, a.c0, a.r1, a.c1, (_r, _c, v) => out.push(v));
    } else if (isArr(a)) for (const row of a.rows) out.push(...row);
    else out.push(a);
  }
  return out;
}

export function num(v: EvalValue, ctx: Ctx): number | CellError {
  return toNum(scalar(v, ctx));
}

export function text(v: EvalValue, ctx: Ctx): string | CellError {
  return toText(scalar(v, ctx));
}

export function bool(v: EvalValue, ctx: Ctx): boolean | CellError {
  return toBool(scalar(v, ctx));
}

export function int(v: EvalValue, ctx: Ctx): number | CellError {
  const n = num(v, ctx);
  return isErr(n) ? n : Math.trunc(n);
}

/** A function result as a number, with Excel's #NUM! for infinities and NaN. */
export function fin(n: number): number | CellError {
  return Number.isFinite(n) ? n : ERR.num;
}

// ---- Criteria (COUNTIF, SUMIF...) --------------------------------------------------------------

export type Matcher = (v: Scalar) => boolean;

function wildcard(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function criterion(c: Scalar): Matcher {
  if (typeof c === 'number') return (v) => typeof v === 'number' ? v === c : typeof v === 'string' && v.trim() !== '' && Number(v) === c;
  if (typeof c === 'boolean') return (v) => v === c;
  if (isErr(c)) return (v) => v === c;
  if (c === null) return (v) => v === 0 || v === null;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? '=';
  const rhs = m[2];
  const n = rhs.trim() !== '' && Number.isFinite(Number(rhs)) ? Number(rhs) : null;
  const upper = rhs.toUpperCase();
  const b = upper === 'TRUE' ? true : upper === 'FALSE' ? false : null;
  if (op === '=' || op === '<>') {
    let test: Matcher;
    if (rhs === '') test = (v) => v === null || v === '';
    else if (n !== null) test = (v) => typeof v === 'number' && v === n;
    else if (b !== null) test = (v) => v === b;
    else if (/^#/.test(rhs)) test = (v) => isErr(v) && v.code === upper;
    else {
      const re = /[*?~]/.test(rhs) ? wildcard(rhs) : null;
      test = (v) => typeof v === 'string' && (re ? re.test(v) : v.toLowerCase() === rhs.toLowerCase());
    }
    if (op === '<>') return (v) => !test(v);
    return test;
  }
  const cmp = (d: number) => (op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d >= 0);
  if (n !== null) return (v) => typeof v === 'number' && cmp(v - n);
  return (v) => typeof v === 'string' && cmp(compare(v, rhs));
}
