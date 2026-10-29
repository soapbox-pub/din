/** What a cell can hold, and Excel's rules for turning one kind into another. */

export type ErrCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#SPILL!' | '#CALC!' | '#GETTING_DATA';

export const ERR_CODES: ErrCode[] = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!'];

export class CellError {
  constructor(readonly code: ErrCode) {}
  toString() {
    return this.code;
  }
}

const interned = new Map<string, CellError>(ERR_CODES.map((c) => [c, new CellError(c)]));
export const err = (code: ErrCode): CellError => interned.get(code)!;
export const isErrCode = (s: string): s is ErrCode => interned.has(s.toUpperCase());
export const errOf = (s: string): CellError | null => interned.get(s.toUpperCase()) ?? null;

export const ERR = {
  null: err('#NULL!'),
  div0: err('#DIV/0!'),
  value: err('#VALUE!'),
  ref: err('#REF!'),
  name: err('#NAME?'),
  num: err('#NUM!'),
  na: err('#N/A'),
  calc: err('#CALC!'),
};

/** A cell's value. null is an empty cell. */
export type Scalar = number | string | boolean | CellError | null;

export const isErr = (v: unknown): v is CellError => v instanceof CellError;

/** A number for arithmetic: text that reads as a number counts, other text is #VALUE!. */
export function toNum(v: Scalar, parseText: (s: string) => number | null = parseNumberText): number | CellError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof CellError) return v;
  const n = parseText(v);
  return n === null ? ERR.value : n;
}

export function parseNumberText(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  let m = /^([+-])?\$?\s*([\d,]*\.?\d+(?:[eE][+-]?\d+)?)\s*(%?)$/.exec(t);
  if (m && (!m[2].includes(',') || /^\d{1,3}(,\d{3})*(\.\d*)?$/.test(m[2]))) {
    let n = parseFloat(m[2].replace(/,/g, ''));
    if (m[1] === '-') n = -n;
    if (m[3]) n /= 100;
    return n;
  }
  m = /^\(\$?([\d,]*\.?\d+)\)$/.exec(t);
  if (m) return -parseFloat(m[1].replace(/,/g, ''));
  return null;
}

/** Text as Excel prints a value into a formula result (TRUE, 0.1, #N/A). */
export function toText(v: Scalar): string | CellError {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof CellError) return v;
  return numberToText(v);
}

/** A number the way General format writes it, up to 15 significant digits. */
export function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e21 || abs < 1e-19) return n.toExponential(14).replace(/\.?0+e/, 'E').replace('E+', 'E+').toUpperCase();
  const s = Number(n.toPrecision(15)).toString();
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    const exp = parseInt(e, 10);
    return `${m}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return s;
}

export function toBool(v: Scalar): boolean | CellError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof CellError) return v;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return ERR.value;
}

/** Ordering for comparison operators: numbers < text < logicals; text without case. */
function typeRank(v: Scalar): number {
  if (typeof v === 'number' || v === null) return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

export function compare(a: Scalar, b: Scalar): number {
  if (a === null && typeof b === 'string') a = '';
  if (b === null && typeof a === 'string') b = '';
  if (a === null && typeof b === 'boolean') a = false;
  if (b === null && typeof a === 'boolean') b = false;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = (a as number | null) ?? 0;
  const y = (b as number | null) ?? 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Floating-point noise below Excel's 15 digits doesn't count. */
export function round15(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(15));
}
