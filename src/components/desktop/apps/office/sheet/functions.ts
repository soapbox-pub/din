import { cellName, colName, MAX_COLS, MAX_ROWS, quoteSheet } from './addr';
import { dateSerial, daysInMonth, nowSerial, serialParts, todaySerial } from './dates';
import {
  bool,
  clip,
  criterion,
  dims,
  fin,
  flatValues,
  grid,
  int,
  isArr,
  isRef,
  num,
  numbers,
  scalar,
  text,
  type ArrValue,
  type Ctx,
  type EvalValue,
  type Matcher,
} from './evalCore';
import { parseFormula, type Node } from './formula';
import { formatValue, parseEntry } from './numfmt';
import { CellError, compare, ERR, isErr, round15, toBool, toNum, toText, type Scalar } from './values';

/**
 * Excel's worksheet functions: what each computes, plus the category,
 * signature and description the Insert Function dialog and the formula
 * autocomplete show.
 */

export type Category = 'Financial' | 'Logical' | 'Text' | 'Date & Time' | 'Lookup & Reference' | 'Math & Trig' | 'Statistical' | 'Information';

export const CATEGORIES: Category[] = ['Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig', 'Statistical', 'Information'];

export interface FnDef {
  name: string;
  cat: Category;
  sig: string;
  desc: string;
  min: number;
  max: number;
  fn?: (args: EvalValue[], ctx: Ctx) => EvalValue;
  lazy?: (args: Node[], ctx: Ctx) => EvalValue;
  volatile?: boolean;
  /** Takes arrays: expressions in its arguments work on whole ranges. */
  arrays?: boolean;
}

export const FUNCTIONS: Record<string, FnDef> = {};

const MANY = 255;

function def(name: string, cat: Category, sig: string, desc: string, min: number, max: number, fn: FnDef['fn'], extra?: Partial<FnDef>) {
  FUNCTIONS[name] = { name, cat, sig, desc, min, max, fn, ...extra };
}

function lazy(name: string, cat: Category, sig: string, desc: string, min: number, max: number, fn: NonNullable<FnDef['lazy']>) {
  FUNCTIONS[name] = { name, cat, sig, desc, min, max, lazy: fn };
}

const isMulti = (v: EvalValue) => (isRef(v) && (v.r0 !== v.r1 || v.c0 !== v.c1)) || isArr(v);

/** A one-number function that maps over arrays when given one. */
function math1(f: (x: number) => number | CellError) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const one = (s: Scalar): Scalar => {
      const n = toNum(s);
      if (isErr(n)) return n;
      const r = f(n);
      return isErr(r) ? r : fin(r);
    };
    if (isArr(args[0]) || (ctx.arrays && isMulti(args[0]))) return { kind: 'arr', rows: grid(args[0], ctx).map((row) => row.map(one)) };
    return one(scalar(args[0], ctx));
  };
}

/** Two numbers in, one out. */
function math2(f: (x: number, y: number) => number | CellError, defaultY?: number) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const x = num(args[0], ctx);
    if (isErr(x)) return x;
    const y = args.length > 1 ? num(args[1], ctx) : (defaultY ?? 0);
    if (isErr(y)) return y;
    const r = f(x, y);
    return isErr(r) ? r : fin(r);
  };
}

function withNumbers(f: (xs: number[]) => number | CellError, opts?: { allA?: boolean }) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const xs = numbers(args, ctx, opts);
    if (isErr(xs)) return xs;
    const r = f(xs);
    return isErr(r) ? r : fin(r);
  };
}

const sum = (xs: number[]) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : ERR.div0);
const devsq = (xs: number[]) => {
  const m = sum(xs) / xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s;
};
const variance = (xs: number[], sample: boolean) => (xs.length < (sample ? 2 : 1) ? ERR.div0 : devsq(xs) / (xs.length - (sample ? 1 : 0)));
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

function median(xs: number[]): number | CellError {
  if (!xs.length) return ERR.num;
  const s = sorted(xs);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mode(xs: number[]): number | CellError {
  const counts = new Map<number, number>();
  let best: number | null = null;
  let bestN = 1;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) {
      bestN = n;
      best = x;
    }
  }
  if (best === null) return ERR.na;
  // Ties go to the value that appears first.
  for (const x of xs) if (counts.get(x) === bestN) return x;
  return best;
}

function percentileInc(xs: number[], p: number): number | CellError {
  if (!xs.length || p < 0 || p > 1) return ERR.num;
  const s = sorted(xs);
  const rank = p * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo] + (rank - lo) * (s[hi] - s[lo]);
}

function percentileExc(xs: number[], p: number): number | CellError {
  const n = xs.length;
  if (!n || p <= 0 || p >= 1) return ERR.num;
  const rank = p * (n + 1) - 1;
  if (rank < 0 || rank > n - 1) return ERR.num;
  const s = sorted(xs);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo] + (rank - lo) * (s[hi] - s[lo]);
}

function roundTo(x: number, digits: number, how: 'round' | 'up' | 'down'): number {
  const d = Math.trunc(digits);
  const f = Math.pow(10, d);
  const scaled = round15(Math.abs(x) * f);
  const r = how === 'round' ? Math.floor(scaled + 0.5) : how === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return (Math.sign(x) * r) / f;
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// ---- Math & Trig ---------------------------------------------------------------------------------

def('SUM', 'Math & Trig', 'SUM(number1, [number2], ...)', 'Adds all the numbers in a range of cells.', 1, MANY, withNumbers(sum));
def('PRODUCT', 'Math & Trig', 'PRODUCT(number1, [number2], ...)', 'Multiplies all the numbers given as arguments.', 1, MANY, withNumbers((xs) => (xs.length ? xs.reduce((a, b) => a * b, 1) : 0)));
def('SUMSQ', 'Math & Trig', 'SUMSQ(number1, [number2], ...)', 'Returns the sum of the squares of the arguments.', 1, MANY, withNumbers((xs) => sum(xs.map((x) => x * x))));
def('ABS', 'Math & Trig', 'ABS(number)', 'Returns the absolute value of a number, a number without its sign.', 1, 1, math1(Math.abs));
def('SQRT', 'Math & Trig', 'SQRT(number)', 'Returns the square root of a number.', 1, 1, math1((x) => (x < 0 ? ERR.num : Math.sqrt(x))));
def('SQRTPI', 'Math & Trig', 'SQRTPI(number)', 'Returns the square root of (number * Pi).', 1, 1, math1((x) => (x < 0 ? ERR.num : Math.sqrt(x * Math.PI))));
def('EXP', 'Math & Trig', 'EXP(number)', 'Returns e raised to the power of a given number.', 1, 1, math1(Math.exp));
def('LN', 'Math & Trig', 'LN(number)', 'Returns the natural logarithm of a number.', 1, 1, math1((x) => (x <= 0 ? ERR.num : Math.log(x))));
def('LOG10', 'Math & Trig', 'LOG10(number)', 'Returns the base-10 logarithm of a number.', 1, 1, math1((x) => (x <= 0 ? ERR.num : Math.log10(x))));
def('LOG', 'Math & Trig', 'LOG(number, [base])', 'Returns the logarithm of a number to the base you specify.', 1, 2, math2((x, b) => (x <= 0 || b <= 0 ? ERR.num : b === 1 ? ERR.div0 : Math.log(x) / Math.log(b)), 10));
def('PI', 'Math & Trig', 'PI()', 'Returns the value of Pi, 3.14159265358979, accurate to 15 digits.', 0, 0, () => Math.PI);
def('INT', 'Math & Trig', 'INT(number)', 'Rounds a number down to the nearest integer.', 1, 1, math1(Math.floor));
def('TRUNC', 'Math & Trig', 'TRUNC(number, [num_digits])', 'Truncates a number to an integer by removing the decimal, or fractional, part of the number.', 1, 2, math2((x, d) => roundTo(x, d, 'down')));
def('ROUND', 'Math & Trig', 'ROUND(number, num_digits)', 'Rounds a number to a specified number of digits.', 2, 2, math2((x, d) => roundTo(x, d, 'round')));
def('ROUNDUP', 'Math & Trig', 'ROUNDUP(number, num_digits)', 'Rounds a number up, away from zero.', 2, 2, math2((x, d) => roundTo(x, d, 'up')));
def('ROUNDDOWN', 'Math & Trig', 'ROUNDDOWN(number, num_digits)', 'Rounds a number down, toward zero.', 2, 2, math2((x, d) => roundTo(x, d, 'down')));
def('MROUND', 'Math & Trig', 'MROUND(number, multiple)', 'Returns a number rounded to the desired multiple.', 2, 2, math2((x, m) => (m === 0 ? 0 : x * m < 0 ? ERR.num : Math.round(round15(x / m)) * m)));
def('MOD', 'Math & Trig', 'MOD(number, divisor)', 'Returns the remainder after a number is divided by a divisor.', 2, 2, math2((x, d) => (d === 0 ? ERR.div0 : round15(x - d * Math.floor(x / d)))));
def('QUOTIENT', 'Math & Trig', 'QUOTIENT(numerator, denominator)', 'Returns the integer portion of a division.', 2, 2, math2((x, d) => (d === 0 ? ERR.div0 : Math.trunc(x / d))));
def('POWER', 'Math & Trig', 'POWER(number, power)', 'Returns the result of a number raised to a power.', 2, 2, math2((x, y) => (x === 0 && y < 0 ? ERR.div0 : x === 0 && y === 0 ? ERR.num : Math.pow(x, y))));
def('SIGN', 'Math & Trig', 'SIGN(number)', 'Returns the sign of a number: 1 if positive, zero if zero, or -1 if negative.', 1, 1, math1(Math.sign));
def('EVEN', 'Math & Trig', 'EVEN(number)', 'Rounds a positive number up and a negative number down to the nearest even integer.', 1, 1, math1((x) => Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2));
def('ODD', 'Math & Trig', 'ODD(number)', 'Rounds a positive number up and a negative number down to the nearest odd integer.', 1, 1, math1((x) => {
  const a = Math.ceil(Math.abs(x));
  return (Math.sign(x) || 1) * (a % 2 ? a : a + 1);
}));
def('FACT', 'Math & Trig', 'FACT(number)', 'Returns the factorial of a number, equal to 1*2*3*...*number.', 1, 1, math1((x) => (x < 0 ? ERR.num : factorial(Math.floor(x)))));
def('COMBIN', 'Math & Trig', 'COMBIN(number, number_chosen)', 'Returns the number of combinations for a given number of items.', 2, 2, math2((n, k) => {
  n = Math.trunc(n);
  k = Math.trunc(k);
  if (n < 0 || k < 0 || k > n) return ERR.num;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}));
def('PERMUT', 'Statistical', 'PERMUT(number, number_chosen)', 'Returns the number of permutations for a given number of objects that can be selected from the total objects.', 2, 2, math2((n, k) => {
  n = Math.trunc(n);
  k = Math.trunc(k);
  if (n < 0 || k < 0 || k > n) return ERR.num;
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}));
def('GCD', 'Math & Trig', 'GCD(number1, [number2], ...)', 'Returns the greatest common divisor.', 1, MANY, withNumbers((xs) => (xs.some((x) => x < 0) ? ERR.num : xs.map(Math.trunc).reduce(gcd, 0))));
def('LCM', 'Math & Trig', 'LCM(number1, [number2], ...)', 'Returns the least common multiple.', 1, MANY, withNumbers((xs) => (xs.some((x) => x < 0) ? ERR.num : xs.map(Math.trunc).reduce((a, b) => (a && b ? (a * b) / gcd(a, b) : 0), 1))));
def('DEGREES', 'Math & Trig', 'DEGREES(angle)', 'Converts radians to degrees.', 1, 1, math1((x) => (x * 180) / Math.PI));
def('RADIANS', 'Math & Trig', 'RADIANS(angle)', 'Converts degrees to radians.', 1, 1, math1((x) => (x * Math.PI) / 180));
for (const [name, f, desc] of [
  ['SIN', Math.sin, 'Returns the sine of an angle.'],
  ['COS', Math.cos, 'Returns the cosine of an angle.'],
  ['TAN', Math.tan, 'Returns the tangent of an angle.'],
  ['ATAN', Math.atan, 'Returns the arctangent of a number in radians, in the range -Pi/2 to Pi/2.'],
  ['SINH', Math.sinh, 'Returns the hyperbolic sine of a number.'],
  ['COSH', Math.cosh, 'Returns the hyperbolic cosine of a number.'],
  ['TANH', Math.tanh, 'Returns the hyperbolic tangent of a number.'],
  ['ASINH', Math.asinh, 'Returns the inverse hyperbolic sine of a number.'],
] as const) {
  def(name, 'Math & Trig', `${name}(number)`, desc, 1, 1, math1(f));
}
def('ASIN', 'Math & Trig', 'ASIN(number)', 'Returns the arcsine of a number in radians, in the range -Pi/2 to Pi/2.', 1, 1, math1((x) => (x < -1 || x > 1 ? ERR.num : Math.asin(x))));
def('ACOS', 'Math & Trig', 'ACOS(number)', 'Returns the arccosine of a number, in radians in the range 0 to Pi.', 1, 1, math1((x) => (x < -1 || x > 1 ? ERR.num : Math.acos(x))));
def('ACOSH', 'Math & Trig', 'ACOSH(number)', 'Returns the inverse hyperbolic cosine of a number.', 1, 1, math1((x) => (x < 1 ? ERR.num : Math.acosh(x))));
def('ATANH', 'Math & Trig', 'ATANH(number)', 'Returns the inverse hyperbolic tangent of a number.', 1, 1, math1((x) => (x <= -1 || x >= 1 ? ERR.num : Math.atanh(x))));
def('ATAN2', 'Math & Trig', 'ATAN2(x_num, y_num)', 'Returns the arctangent of the specified x- and y- coordinates, in radians between -Pi and Pi.', 2, 2, math2((x, y) => (x === 0 && y === 0 ? ERR.div0 : Math.atan2(y, x))));
def('RAND', 'Math & Trig', 'RAND()', 'Returns a random number greater than or equal to 0 and less than 1, evenly distributed (changes on recalculation).', 0, 0, () => Math.random(), { volatile: true });
def('RANDBETWEEN', 'Math & Trig', 'RANDBETWEEN(bottom, top)', 'Returns a random number between the numbers you specify.', 2, 2, math2((a, b) => {
  const lo = Math.ceil(a);
  const hi = Math.floor(b);
  return lo > hi ? ERR.num : lo + Math.floor(Math.random() * (hi - lo + 1));
}), { volatile: true });

function ceilFloor(up: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const x = num(args[0], ctx);
    if (isErr(x)) return x;
    const s = args.length > 1 ? num(args[1], ctx) : 1;
    if (isErr(s)) return s;
    if (s === 0 || x === 0) return up || x === 0 ? 0 : ERR.div0;
    if (x > 0 && s < 0) return ERR.num;
    const q = round15(x / s);
    return (up ? Math.ceil(q) : Math.floor(q)) * s;
  };
}
def('CEILING', 'Math & Trig', 'CEILING(number, significance)', 'Rounds a number up, to the nearest multiple of significance.', 1, 2, ceilFloor(true));
def('FLOOR', 'Math & Trig', 'FLOOR(number, significance)', 'Rounds a number down toward zero, to the nearest multiple of significance.', 1, 2, ceilFloor(false));
function ceilFloorMath(up: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const x = num(args[0], ctx);
    if (isErr(x)) return x;
    let s = args.length > 1 && args[1] !== null ? num(args[1], ctx) : 1;
    if (isErr(s)) return s;
    const mode = args.length > 2 ? num(args[2], ctx) : 0;
    if (isErr(mode)) return mode;
    s = Math.abs(s);
    if (s === 0) return 0;
    const q = round15(x / s);
    let r = up ? Math.ceil(q) : Math.floor(q);
    if (x < 0 && mode) r = up ? Math.floor(q) : Math.ceil(q);
    return r * s;
  };
}
def('CEILING.MATH', 'Math & Trig', 'CEILING.MATH(number, [significance], [mode])', 'Rounds a number up, to the nearest integer or to the nearest multiple of significance.', 1, 3, ceilFloorMath(true));
def('FLOOR.MATH', 'Math & Trig', 'FLOOR.MATH(number, [significance], [mode])', 'Rounds a number down, to the nearest integer or to the nearest multiple of significance.', 1, 3, ceilFloorMath(false));

/** Pairs of arrays of the same size, as numbers (SUMX2MY2 and friends). */
function pairwise(f: (x: number, y: number) => number) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const a = grid(args[0], ctx).flat();
    const b = grid(args[1], ctx).flat();
    if (a.length !== b.length) return ERR.na;
    let s = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (isErr(a[i])) return a[i];
      if (isErr(b[i])) return b[i];
      if (typeof a[i] === 'number' && typeof b[i] === 'number') {
        s += f(a[i] as number, b[i] as number);
        n++;
      }
    }
    return n ? s : ERR.div0;
  };
}
def('SUMX2MY2', 'Math & Trig', 'SUMX2MY2(array_x, array_y)', 'Sums the differences between the squares of two corresponding ranges or arrays.', 2, 2, pairwise((x, y) => x * x - y * y));
def('SUMX2PY2', 'Math & Trig', 'SUMX2PY2(array_x, array_y)', 'Returns the sum total of the sums of squares of numbers in two corresponding ranges or arrays.', 2, 2, pairwise((x, y) => x * x + y * y));
def('SUMXMY2', 'Math & Trig', 'SUMXMY2(array_x, array_y)', 'Sums the squares of the differences in two corresponding ranges or arrays.', 2, 2, pairwise((x, y) => (x - y) * (x - y)));

def('SUMPRODUCT', 'Math & Trig', 'SUMPRODUCT(array1, [array2], [array3], ...)', 'Returns the sum of the products of corresponding ranges or arrays.', 1, MANY, (args, ctx) => {
  const grids = args.map((a) => (isRef(a) ? grid(clip(a, ctx.host), ctx) : grid(a, ctx)));
  const r = grids[0].length;
  const c = grids[0][0]?.length ?? 0;
  if (grids.some((g) => g.length !== r || (g[0]?.length ?? 0) !== c)) return ERR.value;
  let s = 0;
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++) {
      let p = 1;
      for (const g of grids) {
        const v = g[i][j];
        if (isErr(v)) return v;
        p *= typeof v === 'number' ? v : 0;
      }
      s += p;
    }
  return s;
});

/** Rows of a criteria range and its matching ranges, walked together. */
function ifsWalk(ctx: Ctx, pairs: [EvalValue, EvalValue][], target: EvalValue | null, cb: (v: Scalar) => void): CellError | null {
  const ranges = pairs.map(([r]) => r);
  const first = ranges[0];
  if (!isRef(first) && !isArr(first)) return ERR.value;
  const d = dims(first);
  for (const r of ranges) {
    const dd = dims(r);
    if (dd.rows !== d.rows || dd.cols !== d.cols) return ERR.value;
  }
  const matchers: Matcher[] = [];
  for (const [, c] of pairs) matchers.push(criterion(scalar(c, ctx)));
  // Bound the walk by the used part of the sheet (blank rows past it can still match "").
  let rows = d.rows;
  let cols = d.cols;
  if (isRef(first)) {
    const ext = ctx.host.extent(first.sheet);
    rows = Math.min(rows, Math.max(0, ext.rows - first.r0 + 1));
    cols = Math.min(cols, Math.max(0, ext.cols - first.c0 + 1));
  }
  const at = (v: EvalValue, i: number, j: number): Scalar => {
    if (isRef(v)) return ctx.host.value(v.sheet, v.r0 + i, v.c0 + j);
    if (isArr(v)) return v.rows[i]?.[j] ?? null;
    return v;
  };
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      let ok = true;
      for (let k = 0; k < ranges.length && ok; k++) ok = matchers[k](at(ranges[k], i, j));
      if (ok) cb(target ? at(target, i, j) : null);
    }
  return null;
}

/** A sum range the size of the criteria range, from its top-left cell (SUMIF's rule). */
function sizedLike(target: EvalValue, like: EvalValue): EvalValue {
  if (!isRef(target) || !isRef(like)) return target;
  return { ...target, r1: target.r0 + (like.r1 - like.r0), c1: target.c0 + (like.c1 - like.c0) };
}

function countBeyond(ctx: Ctx, range: EvalValue, m: Matcher): number {
  if (!isRef(range) || !m(null)) return 0;
  const ext = ctx.host.extent(range.sheet);
  const total = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
  const rows = Math.min(range.r1 - range.r0 + 1, Math.max(0, ext.rows - range.r0 + 1));
  const cols = Math.min(range.c1 - range.c0 + 1, Math.max(0, ext.cols - range.c0 + 1));
  return total - rows * cols;
}

def('SUMIF', 'Math & Trig', 'SUMIF(range, criteria, [sum_range])', 'Adds the cells specified by a given condition or criteria.', 2, 3, (args, ctx) => {
  const target = args.length > 2 ? sizedLike(args[2], args[0]) : args[0];
  let s = 0;
  let e: CellError | null = null;
  const bad = ifsWalk(ctx, [[args[0], args[1]]], target, (v) => {
    if (isErr(v)) e ??= v;
    else if (typeof v === 'number') s += v;
  });
  return bad ?? e ?? s;
});
def('SUMIFS', 'Math & Trig', 'SUMIFS(sum_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)', 'Adds the cells specified by a given set of conditions or criteria.', 3, MANY, (args, ctx) => {
  if (args.length % 2 === 0) return ERR.value;
  const pairs: [EvalValue, EvalValue][] = [];
  for (let i = 1; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  let s = 0;
  let e: CellError | null = null;
  const bad = ifsWalk(ctx, pairs, args[0], (v) => {
    if (isErr(v)) e ??= v;
    else if (typeof v === 'number') s += v;
  });
  return bad ?? e ?? s;
});
def('SUBTOTAL', 'Math & Trig', 'SUBTOTAL(function_num, ref1, ...)', 'Returns a subtotal in a list or database.', 2, MANY, (args, ctx) => {
  const n = int(args[0], ctx);
  if (isErr(n)) return n;
  const names: Record<number, string> = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV', 8: 'STDEVP', 9: 'SUM', 10: 'VAR', 11: 'VARP' };
  const f = FUNCTIONS[names[n > 100 ? n - 100 : n]];
  if (!f?.fn) return ERR.value;
  return f.fn(args.slice(1), ctx);
});

// ---- Statistical -----------------------------------------------------------------------------

def('AVERAGE', 'Statistical', 'AVERAGE(number1, [number2], ...)', 'Returns the average (arithmetic mean) of its arguments, which can be numbers or names, arrays, or references that contain numbers.', 1, MANY, withNumbers(mean));
def('AVERAGEA', 'Statistical', 'AVERAGEA(value1, [value2], ...)', 'Returns the average of its arguments, evaluating text and FALSE as 0 and TRUE as 1.', 1, MANY, withNumbers(mean, { allA: true }));
def('MIN', 'Statistical', 'MIN(number1, [number2], ...)', 'Returns the smallest number in a set of values. Ignores logical values and text.', 1, MANY, withNumbers((xs) => (xs.length ? Math.min(...xs) : 0)));
def('MAX', 'Statistical', 'MAX(number1, [number2], ...)', 'Returns the largest value in a set of values. Ignores logical values and text.', 1, MANY, withNumbers((xs) => (xs.length ? Math.max(...xs) : 0)));
def('MINA', 'Statistical', 'MINA(value1, [value2], ...)', 'Returns the smallest value in a set of values. Does not ignore logical values and text.', 1, MANY, withNumbers((xs) => (xs.length ? Math.min(...xs) : 0), { allA: true }));
def('MAXA', 'Statistical', 'MAXA(value1, [value2], ...)', 'Returns the largest value in a set of values. Does not ignore logical values and text.', 1, MANY, withNumbers((xs) => (xs.length ? Math.max(...xs) : 0), { allA: true }));
def('MEDIAN', 'Statistical', 'MEDIAN(number1, [number2], ...)', 'Returns the median, or the number in the middle of the set of given numbers.', 1, MANY, withNumbers(median));
const strictMode = (args: EvalValue[], ctx: Ctx): EvalValue => {
  if (args.some((a) => typeof a === 'string' || typeof a === 'boolean')) return ERR.value;
  return withNumbers(mode)(args, ctx);
};
def('MODE', 'Statistical', 'MODE(number1, [number2], ...)', 'Returns the most frequently occurring, or repetitive, value in an array or range of data.', 1, MANY, strictMode);
def('MODE.SNGL', 'Statistical', 'MODE.SNGL(number1, [number2], ...)', 'Returns the most frequently occurring, or repetitive, value in an array or range of data.', 1, MANY, strictMode);
for (const [name, sample, desc] of [
  ['STDEV', true, 'Estimates standard deviation based on a sample (ignores logical values and text in the sample).'],
  ['STDEV.S', true, 'Estimates standard deviation based on a sample (ignores logical values and text in the sample).'],
  ['STDEVP', false, 'Calculates standard deviation based on the entire population given as arguments (ignores logical values and text).'],
  ['STDEV.P', false, 'Calculates standard deviation based on the entire population given as arguments (ignores logical values and text).'],
] as const) {
  def(name, 'Statistical', `${name}(number1, [number2], ...)`, desc, 1, MANY, withNumbers((xs) => {
    const v = variance(xs, sample);
    return isErr(v) ? v : Math.sqrt(v);
  }));
}
for (const [name, sample, desc] of [
  ['VAR', true, 'Estimates variance based on a sample (ignores logical values and text in the sample).'],
  ['VAR.S', true, 'Estimates variance based on a sample (ignores logical values and text in the sample).'],
  ['VARP', false, 'Calculates variance based on the entire population (ignores logical values and text in the population).'],
  ['VAR.P', false, 'Calculates variance based on the entire population (ignores logical values and text in the population).'],
] as const) {
  def(name, 'Statistical', `${name}(number1, [number2], ...)`, desc, 1, MANY, withNumbers((xs) => variance(xs, sample)));
}
def('DEVSQ', 'Statistical', 'DEVSQ(number1, [number2], ...)', 'Returns the sum of squares of deviations of data points from their sample mean.', 1, MANY, withNumbers((xs) => (xs.length ? devsq(xs) : ERR.num)));
def('AVEDEV', 'Statistical', 'AVEDEV(number1, [number2], ...)', 'Returns the average of the absolute deviations of data points from their mean.', 1, MANY, withNumbers((xs) => {
  if (!xs.length) return ERR.num;
  const m = sum(xs) / xs.length;
  return sum(xs.map((x) => Math.abs(x - m))) / xs.length;
}));
def('GEOMEAN', 'Statistical', 'GEOMEAN(number1, [number2], ...)', 'Returns the geometric mean of an array or range of positive numeric data.', 1, MANY, withNumbers((xs) => (!xs.length || xs.some((x) => x <= 0) ? ERR.num : Math.exp(sum(xs.map(Math.log)) / xs.length))));
def('HARMEAN', 'Statistical', 'HARMEAN(number1, [number2], ...)', 'Returns the harmonic mean of a data set of positive numbers.', 1, MANY, withNumbers((xs) => (!xs.length || xs.some((x) => x <= 0) ? ERR.num : xs.length / sum(xs.map((x) => 1 / x)))));

function kth(largest: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const xs = numbers([args[0]], ctx);
    if (isErr(xs)) return xs;
    const k = num(args[1], ctx);
    if (isErr(k)) return k;
    const kk = Math.ceil(k);
    if (kk < 1 || kk > xs.length) return ERR.num;
    const s = sorted(xs);
    return largest ? s[s.length - kk] : s[kk - 1];
  };
}
def('LARGE', 'Statistical', 'LARGE(array, k)', 'Returns the k-th largest value in a data set. For example, the fifth largest number.', 2, 2, kth(true));
def('SMALL', 'Statistical', 'SMALL(array, k)', 'Returns the k-th smallest value in a data set. For example, the fifth smallest number.', 2, 2, kth(false));

function rank(avg: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const x = num(args[0], ctx);
    if (isErr(x)) return x;
    const xs = numbers([args[1]], ctx);
    if (isErr(xs)) return xs;
    const order = args.length > 2 ? num(args[2], ctx) : 0;
    if (isErr(order)) return order;
    if (!xs.includes(x)) return ERR.na;
    const better = xs.filter((v) => (order ? v < x : v > x)).length;
    const ties = xs.filter((v) => v === x).length;
    return avg ? better + (ties + 1) / 2 : better + 1;
  };
}
def('RANK', 'Statistical', 'RANK(number, ref, [order])', 'Returns the rank of a number in a list of numbers: its size relative to other values in the list.', 2, 3, rank(false));
def('RANK.EQ', 'Statistical', 'RANK.EQ(number, ref, [order])', 'Returns the rank of a number in a list of numbers; if more than one value has the same rank, the top rank of that set is returned.', 2, 3, rank(false));
def('RANK.AVG', 'Statistical', 'RANK.AVG(number, ref, [order])', 'Returns the rank of a number in a list of numbers; if more than one value has the same rank, the average rank is returned.', 2, 3, rank(true));

function pctFn(f: (xs: number[], p: number) => number | CellError, scale = 1) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const xs = numbers([args[0]], ctx);
    if (isErr(xs)) return xs;
    const p = num(args[1], ctx);
    if (isErr(p)) return p;
    if (scale !== 1 && (p < 0 || p > 4 || p % 1)) return ERR.num;
    return f(xs, p / scale);
  };
}
def('PERCENTILE', 'Statistical', 'PERCENTILE(array, k)', 'Returns the k-th percentile of values in a range.', 2, 2, pctFn(percentileInc));
def('PERCENTILE.INC', 'Statistical', 'PERCENTILE.INC(array, k)', 'Returns the k-th percentile of values in a range, where k is in the range 0..1, inclusive.', 2, 2, pctFn(percentileInc));
def('PERCENTILE.EXC', 'Statistical', 'PERCENTILE.EXC(array, k)', 'Returns the k-th percentile of values in a range, where k is in the range 0..1, exclusive.', 2, 2, pctFn(percentileExc));
def('QUARTILE', 'Statistical', 'QUARTILE(array, quart)', 'Returns the quartile of a data set.', 2, 2, pctFn(percentileInc, 4));
def('QUARTILE.INC', 'Statistical', 'QUARTILE.INC(array, quart)', 'Returns the quartile of a data set, based on percentile values from 0..1, inclusive.', 2, 2, pctFn(percentileInc, 4));

def('COUNT', 'Statistical', 'COUNT(value1, [value2], ...)', 'Counts the number of cells in a range that contain numbers.', 1, MANY, (args, ctx) => {
  let n = 0;
  for (const a of args) {
    if (isRef(a)) ctx.host.each(a.sheet, a.r0, a.c0, a.r1, a.c1, (_r, _c, v) => typeof v === 'number' && n++);
    else if (isArr(a)) {
      for (const row of a.rows) for (const v of row) if (typeof v === 'number') n++;
    } else if (typeof a === 'number' || typeof a === 'boolean' || (typeof a === 'string' && !isErr(toNum(a)))) n++;
  }
  return n;
});
def('COUNTA', 'Statistical', 'COUNTA(value1, [value2], ...)', 'Counts the number of cells in a range that are not empty.', 1, MANY, (args, ctx) => {
  let n = 0;
  for (const a of args) {
    if (isRef(a)) ctx.host.each(a.sheet, a.r0, a.c0, a.r1, a.c1, () => n++);
    else if (isArr(a)) {
      for (const row of a.rows) for (const v of row) if (v !== null) n++;
    } else n++;
  }
  return n;
});
def('COUNTBLANK', 'Statistical', 'COUNTBLANK(range)', 'Counts the number of empty cells in a specified range of cells.', 1, 1, (args, ctx) => {
  const a = args[0];
  if (!isRef(a)) return ERR.value;
  let filled = 0;
  ctx.host.each(a.sheet, a.r0, a.c0, a.r1, a.c1, (_r, _c, v) => v !== '' && filled++);
  return (a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1) - filled;
});
def('COUNTIF', 'Statistical', 'COUNTIF(range, criteria)', 'Counts the number of cells within a range that meet the given condition.', 2, 2, (args, ctx) => {
  let n = 0;
  const bad = ifsWalk(ctx, [[args[0], args[1]]], null, () => n++);
  if (bad) return bad;
  return n + countBeyond(ctx, args[0], criterion(scalar(args[1], ctx)));
});
def('COUNTIFS', 'Statistical', 'COUNTIFS(criteria_range1, criteria1, [criteria_range2, criteria2], ...)', 'Counts the number of cells specified by a given set of conditions or criteria.', 2, MANY, (args, ctx) => {
  if (args.length % 2) return ERR.value;
  const pairs: [EvalValue, EvalValue][] = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  let n = 0;
  return ifsWalk(ctx, pairs, null, () => n++) ?? n;
});
function ifsAgg(f: (xs: number[]) => number | CellError, sumFirst: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const xs: number[] = [];
    let e: CellError | null = null;
    const push = (v: Scalar) => {
      if (isErr(v)) e ??= v;
      else if (typeof v === 'number') xs.push(v);
    };
    let bad: CellError | null;
    if (sumFirst) {
      if (args.length % 2 === 0) return ERR.value;
      const pairs: [EvalValue, EvalValue][] = [];
      for (let i = 1; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
      bad = ifsWalk(ctx, pairs, args[0], push);
    } else {
      const target = args.length > 2 ? sizedLike(args[2], args[0]) : args[0];
      bad = ifsWalk(ctx, [[args[0], args[1]]], target, push);
    }
    return bad ?? e ?? f(xs);
  };
}
def('AVERAGEIF', 'Statistical', 'AVERAGEIF(range, criteria, [average_range])', 'Finds average (arithmetic mean) for the cells specified by a given condition or criteria.', 2, 3, ifsAgg(mean, false));
def('AVERAGEIFS', 'Statistical', 'AVERAGEIFS(average_range, criteria_range1, criteria1, ...)', 'Finds average (arithmetic mean) for the cells specified by a given set of conditions or criteria.', 3, MANY, ifsAgg(mean, true));
def('MAXIFS', 'Statistical', 'MAXIFS(max_range, criteria_range1, criteria1, ...)', 'Returns the maximum value among cells specified by a given set of conditions or criteria.', 3, MANY, ifsAgg((xs) => (xs.length ? Math.max(...xs) : 0), true));
def('MINIFS', 'Statistical', 'MINIFS(min_range, criteria_range1, criteria1, ...)', 'Returns the minimum value among cells specified by a given set of conditions or criteria.', 3, MANY, ifsAgg((xs) => (xs.length ? Math.min(...xs) : 0), true));

def('CORREL', 'Statistical', 'CORREL(array1, array2)', 'Returns the correlation coefficient between two data sets.', 2, 2, (args, ctx) => {
  const a = grid(args[0], ctx).flat();
  const b = grid(args[1], ctx).flat();
  if (a.length !== b.length) return ERR.na;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length; i++) if (typeof a[i] === 'number' && typeof b[i] === 'number') {
    xs.push(a[i] as number);
    ys.push(b[i] as number);
  }
  if (xs.length < 2) return ERR.div0;
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : ERR.div0;
});
def('POISSON', 'Statistical', 'POISSON(x, mean, cumulative)', 'Returns the Poisson distribution.', 3, 3, (args, ctx) => {
  const x = int(args[0], ctx);
  const m = num(args[1], ctx);
  const cum = bool(args[2], ctx);
  if (isErr(x)) return x;
  if (isErr(m)) return m;
  if (isErr(cum)) return cum;
  if (x < 0 || m < 0) return ERR.num;
  const pmf = (k: number) => Math.exp(-m + k * Math.log(m || 1e-300) - logFact(k));
  if (!cum) return m === 0 ? (x === 0 ? 1 : 0) : pmf(x);
  let s = 0;
  for (let k = 0; k <= x; k++) s += m === 0 ? (k === 0 ? 1 : 0) : pmf(k);
  return s;
});
function logFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26, refined with a series for small x.
  const sign = Math.sign(x);
  x = Math.abs(x);
  if (x < 2) {
    let term = x;
    let s = x;
    for (let n = 1; n < 60; n++) {
      term *= (-x * x) / n;
      s += term / (2 * n + 1);
    }
    return (sign * 2 * s) / Math.sqrt(Math.PI);
  }
  const t = 1 / (1 + 0.5 * x);
  const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return sign * y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
def('NORM.DIST', 'Statistical', 'NORM.DIST(x, mean, standard_dev, cumulative)', 'Returns the normal distribution for the specified mean and standard deviation.', 4, 4, (args, ctx) => {
  const [x, m, s] = [num(args[0], ctx), num(args[1], ctx), num(args[2], ctx)];
  const cum = bool(args[3], ctx);
  for (const v of [x, m, s, cum]) if (isErr(v)) return v;
  if ((s as number) <= 0) return ERR.num;
  const z = ((x as number) - (m as number)) / (s as number);
  return cum ? normCdf(z) : Math.exp(-0.5 * z * z) / ((s as number) * Math.sqrt(2 * Math.PI));
});
def('NORM.S.DIST', 'Statistical', 'NORM.S.DIST(z, cumulative)', 'Returns the standard normal distribution (has a mean of zero and a standard deviation of one).', 2, 2, (args, ctx) => {
  const z = num(args[0], ctx);
  const cum = bool(args[1], ctx);
  if (isErr(z)) return z;
  if (isErr(cum)) return cum;
  return cum ? normCdf(z) : Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
});

// ---- Logical ------------------------------------------------------------------------------------

lazy('IF', 'Logical', 'IF(logical_test, [value_if_true], [value_if_false])', 'Checks whether a condition is met, and returns one value if TRUE, and another value if FALSE.', 1, 3, (args, ctx) => {
  const c = bool(ctx.evaluate(args[0]), ctx);
  if (isErr(c)) return c;
  if (c) return args.length > 1 ? ctx.evaluate(args[1]) : true;
  return args.length > 2 ? ctx.evaluate(args[2]) : false;
});
lazy('IFS', 'Logical', 'IFS(logical_test, value_if_true, ...)', 'Checks whether one or more conditions are met and returns a value corresponding to the first TRUE condition.', 2, MANY, (args, ctx) => {
  for (let i = 0; i + 1 < args.length; i += 2) {
    const c = bool(ctx.evaluate(args[i]), ctx);
    if (isErr(c)) return c;
    if (c) return ctx.evaluate(args[i + 1]);
  }
  return ERR.na;
});
lazy('IFERROR', 'Logical', 'IFERROR(value, value_if_error)', 'Returns value_if_error if expression is an error and the value of the expression itself otherwise.', 2, 2, (args, ctx) => {
  const v = ctx.evaluate(args[0]);
  return isErr(scalar(v, ctx)) ? ctx.evaluate(args[1]) : v;
});
lazy('IFNA', 'Logical', 'IFNA(value, value_if_na)', 'Returns the value you specify if the expression resolves to #N/A, otherwise returns the result of the expression.', 2, 2, (args, ctx) => {
  const v = ctx.evaluate(args[0]);
  return scalar(v, ctx) === ERR.na ? ctx.evaluate(args[1]) : v;
});
lazy('SWITCH', 'Logical', 'SWITCH(expression, value1, result1, [default_or_value2, result2], ...)', 'Evaluates an expression against a list of values and returns the result corresponding to the first matching value.', 3, MANY, (args, ctx) => {
  const v = scalar(ctx.evaluate(args[0]), ctx);
  if (isErr(v)) return v;
  let i = 1;
  for (; i + 1 < args.length; i += 2) {
    const w = scalar(ctx.evaluate(args[i]), ctx);
    if (compare(v, w) === 0 && typeof v === typeof w) return ctx.evaluate(args[i + 1]);
  }
  return i < args.length ? ctx.evaluate(args[i]) : ERR.na;
});
function logical(f: (bs: boolean[]) => boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const bs: boolean[] = [];
    for (const a of args) {
      if (isRef(a) || isArr(a)) {
        for (const v of flatValues([a], ctx)) {
          if (isErr(v)) return v;
          if (typeof v === 'boolean') bs.push(v);
          else if (typeof v === 'number') bs.push(v !== 0);
        }
      } else {
        const b = toBool(a);
        if (isErr(b)) return b;
        bs.push(b);
      }
    }
    return bs.length ? f(bs) : ERR.value;
  };
}
def('AND', 'Logical', 'AND(logical1, [logical2], ...)', 'Checks whether all arguments are TRUE, and returns TRUE if all arguments are TRUE.', 1, MANY, logical((bs) => bs.every(Boolean)));
def('OR', 'Logical', 'OR(logical1, [logical2], ...)', 'Checks whether any of the arguments are TRUE, and returns TRUE or FALSE. Returns FALSE only if all arguments are FALSE.', 1, MANY, logical((bs) => bs.some(Boolean)));
def('XOR', 'Logical', 'XOR(logical1, [logical2], ...)', 'Returns a logical Exclusive Or of all arguments.', 1, MANY, logical((bs) => bs.filter(Boolean).length % 2 === 1));
def('NOT', 'Logical', 'NOT(logical)', 'Changes FALSE to TRUE, or TRUE to FALSE.', 1, 1, (args, ctx) => {
  const b = bool(args[0], ctx);
  return isErr(b) ? b : !b;
});
def('TRUE', 'Logical', 'TRUE()', 'Returns the logical value TRUE.', 0, 0, () => true);
def('FALSE', 'Logical', 'FALSE()', 'Returns the logical value FALSE.', 0, 0, () => false);

// ---- Lookup & Reference -----------------------------------------------------------------------

lazy('CHOOSE', 'Lookup & Reference', 'CHOOSE(index_num, value1, [value2], ...)', 'Chooses a value or action to perform from a list of values, based on an index number.', 2, MANY, (args, ctx) => {
  const i = int(ctx.evaluate(args[0]), ctx);
  if (isErr(i)) return i;
  if (i < 1 || i >= args.length) return ERR.value;
  return ctx.evaluate(args[i]);
});

/** Does a lookup value equal a cell, Excel's way (text without case, wildcards when asked)? */
function lookupEq(x: Scalar, v: Scalar, wild: boolean): boolean {
  if (typeof x === 'string' && typeof v === 'string') {
    if (wild && /[*?~]/.test(x)) return criterion(x)(v);
    return x.toLowerCase() === v.toLowerCase();
  }
  if (typeof x === 'number' && typeof v === 'number') return x === v;
  return x === v;
}

const sameKind = (a: Scalar, b: Scalar) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string') || (typeof a === 'boolean' && typeof b === 'boolean');

/** Approximate match over sorted values: the last one ≤ x (binary search, as Excel does). */
function approxIndex(values: Scalar[], x: Scalar, descending = false): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let m = mid;
    // Step over blanks and other kinds.
    while (m >= lo && !sameKind(values[m], x)) m--;
    if (m < lo) {
      lo = mid + 1;
      continue;
    }
    const d = compare(values[m], x);
    if (descending ? d >= 0 : d <= 0) {
      found = m;
      lo = mid + 1;
    } else hi = m - 1;
  }
  return found;
}

/** The values of one row or column of a reference or array. */
function vector(v: EvalValue, ctx: Ctx, which: 'col' | 'row', index = 0): Scalar[] {
  if (isRef(v)) {
    const c = clip(v, ctx.host);
    const out: Scalar[] = [];
    if (which === 'col') for (let r = c.r0; r <= c.r1; r++) out.push(ctx.host.value(c.sheet, r, c.c0 + index));
    else for (let col = c.c0; col <= c.c1; col++) out.push(ctx.host.value(c.sheet, c.r0 + index, col));
    return out;
  }
  const g = grid(v, ctx);
  return which === 'col' ? g.map((row) => row[index] ?? null) : (g[index] ?? []);
}

function vlookup(horizontal: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const x = scalar(args[0], ctx);
    if (isErr(x)) return x;
    const table = args[1];
    const n = int(args[2], ctx);
    if (isErr(n)) return n;
    const approx = args.length > 3 ? bool(args[3], ctx) : true;
    if (isErr(approx)) return approx;
    const d = dims(table);
    if (n < 1) return ERR.value;
    if (n > (horizontal ? d.rows : d.cols)) return ERR.ref;
    const keys = vector(table, ctx, horizontal ? 'row' : 'col');
    const i = approx ? approxIndex(keys, x) : keys.findIndex((v) => lookupEq(x, v, true));
    if (i < 0) return ERR.na;
    if (isRef(table)) return horizontal ? ctx.host.value(table.sheet, table.r0 + n - 1, table.c0 + i) : ctx.host.value(table.sheet, table.r0 + i, table.c0 + n - 1);
    const g = grid(table, ctx);
    return (horizontal ? g[n - 1]?.[i] : g[i]?.[n - 1]) ?? ERR.na;
  };
}
def('VLOOKUP', 'Lookup & Reference', 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])', 'Looks for a value in the leftmost column of a table, and then returns a value in the same row from a column you specify.', 3, 4, vlookup(false));
def('HLOOKUP', 'Lookup & Reference', 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])', 'Looks for a value in the top row of a table or array of values and returns the value in the same column from a row you specify.', 3, 4, vlookup(true));

/** A cell of a 1-D reference or array by position, as a reference when it is one. */
function itemOf(v: EvalValue, i: number, ctx: Ctx): EvalValue {
  if (isRef(v)) {
    const vertical = v.c0 === v.c1 || v.r1 - v.r0 > 0;
    if (v.r0 === v.r1) return { ...v, c0: v.c0 + i, c1: v.c0 + i };
    if (vertical && v.c0 === v.c1) return { ...v, r0: v.r0 + i, r1: v.r0 + i };
    return { ...v, r0: v.r0 + i, r1: v.r0 + i };
  }
  const g = grid(v, ctx);
  return g.length === 1 ? (g[0][i] ?? ERR.na) : (g[i]?.[0] ?? ERR.na);
}

function matchIn(values: Scalar[], x: Scalar, type: number): number {
  if (type === 0) return values.findIndex((v) => lookupEq(x, v, true));
  if (type > 0) return approxIndex(values, x);
  // Descending: the smallest value ≥ x.
  let found = -1;
  for (let i = 0; i < values.length; i++) {
    if (!sameKind(values[i], x)) continue;
    if (compare(values[i], x) >= 0) found = i;
    else break;
  }
  return found;
}

const isRowShaped = (v: EvalValue) => {
  const d = dims(v);
  return d.rows === 1 && d.cols > 1;
};

def('MATCH', 'Lookup & Reference', 'MATCH(lookup_value, lookup_array, [match_type])', 'Returns the relative position of an item in an array that matches a specified value in a specified order.', 2, 3, (args, ctx) => {
  const x = scalar(args[0], ctx);
  if (isErr(x)) return x;
  const type = args.length > 2 ? num(args[2], ctx) : 1;
  if (isErr(type)) return type;
  const values = vector(args[1], ctx, isRowShaped(args[1]) ? 'row' : 'col');
  const i = matchIn(values, x, type);
  return i < 0 ? ERR.na : i + 1;
});

function xfind(values: Scalar[], x: Scalar, matchMode: number, searchMode: number): number {
  const order = searchMode < 0 ? values.map((_, i) => values.length - 1 - i) : values.map((_, i) => i);
  if (Math.abs(searchMode) === 2) {
    if (matchMode === 0) {
      const i = approxIndex(values, x, searchMode < 0);
      return i >= 0 && lookupEq(x, values[i], false) ? i : -1;
    }
  }
  let best = -1;
  for (const i of order) {
    const v = values[i];
    if (lookupEq(x, v, matchMode === 2)) return i;
    if (matchMode === -1 && sameKind(v, x) && compare(v, x) < 0 && (best < 0 || compare(v, values[best]) > 0)) best = i;
    if (matchMode === 1 && sameKind(v, x) && compare(v, x) > 0 && (best < 0 || compare(v, values[best]) < 0)) best = i;
  }
  return best;
}

def('XLOOKUP', 'Lookup & Reference', 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])', 'Searches a range or an array for a match and returns the corresponding item from a second range or array. By default, an exact match is used.', 3, 6, (args, ctx) => {
  const x = scalar(args[0], ctx);
  if (isErr(x)) return x;
  const row = isRowShaped(args[1]);
  const values = vector(args[1], ctx, row ? 'row' : 'col');
  const mm = args.length > 4 && args[4] !== null ? num(args[4], ctx) : 0;
  const sm = args.length > 5 && args[5] !== null ? num(args[5], ctx) : 1;
  if (isErr(mm)) return mm;
  if (isErr(sm)) return sm;
  const i = xfind(values, x, mm, sm);
  if (i < 0) return args.length > 3 && args[3] !== null ? args[3] : ERR.na;
  const ret = args[2];
  if (isRef(ret)) return row ? { ...ret, c0: ret.c0 + i, c1: ret.c0 + i } : { ...ret, r0: ret.r0 + i, r1: ret.r0 + i };
  const g = grid(ret, ctx);
  return row ? { kind: 'arr', rows: g.map((r) => [r[i] ?? ERR.na]) } : { kind: 'arr', rows: [g[i] ?? [ERR.na]] };
});
def('XMATCH', 'Lookup & Reference', 'XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])', 'Returns the relative position of an item in an array. By default, an exact match is required.', 2, 4, (args, ctx) => {
  const x = scalar(args[0], ctx);
  if (isErr(x)) return x;
  const values = vector(args[1], ctx, isRowShaped(args[1]) ? 'row' : 'col');
  const mm = args.length > 2 && args[2] !== null ? num(args[2], ctx) : 0;
  const sm = args.length > 3 && args[3] !== null ? num(args[3], ctx) : 1;
  if (isErr(mm)) return mm;
  if (isErr(sm)) return sm;
  const i = xfind(values, x, mm, sm);
  return i < 0 ? ERR.na : i + 1;
});
def('LOOKUP', 'Lookup & Reference', 'LOOKUP(lookup_value, lookup_vector, [result_vector])', 'Looks up a value either from a one-row or one-column range or from an array.', 2, 3, (args, ctx) => {
  const x = scalar(args[0], ctx);
  if (isErr(x)) return x;
  const d = dims(args[1]);
  let keys: Scalar[];
  let fromArray: Scalar[] | null = null;
  if (args.length === 2 && (isArr(args[1]) || isRef(args[1])) && d.rows > 1 && d.cols > 1) {
    // Array form: search the first row or column (the longer side), return from the last.
    const byRow = d.cols > d.rows;
    keys = vector(args[1], ctx, byRow ? 'row' : 'col');
    fromArray = vector(args[1], ctx, byRow ? 'row' : 'col', byRow ? d.rows - 1 : d.cols - 1);
  } else keys = vector(args[1], ctx, isRowShaped(args[1]) ? 'row' : 'col');
  const i = approxIndex(keys, x);
  if (i < 0) return ERR.na;
  if (fromArray) return fromArray[i] ?? ERR.na;
  const res = args.length > 2 ? args[2] : args[1];
  return itemOf(res, i, ctx);
});
def('INDEX', 'Lookup & Reference', 'INDEX(array, row_num, [column_num])', 'Returns a value or reference of the cell at the intersection of a particular row and column, in a given range.', 2, 4, (args, ctx) => {
  const a = args[0];
  const d = dims(a);
  let r = args[1] === null ? 0 : int(args[1], ctx);
  if (isErr(r)) return r;
  let c = args.length > 2 && args[2] !== null ? int(args[2], ctx) : 0;
  if (isErr(c)) return c;
  // A single row or column takes one index for either.
  if (args.length === 2 && d.rows === 1 && d.cols > 1) [r, c] = [1, r];
  else if (args.length === 2 && d.cols === 1) c = 1;
  if (r < 0 || c < 0 || r > d.rows || c > d.cols) return ERR.ref;
  if (isRef(a)) {
    return {
      ...a,
      r0: r ? a.r0 + r - 1 : a.r0,
      r1: r ? a.r0 + r - 1 : a.r1,
      c0: c ? a.c0 + c - 1 : a.c0,
      c1: c ? a.c0 + c - 1 : a.c1,
    };
  }
  const g = grid(a, ctx);
  if (r && c) return g[r - 1]?.[c - 1] ?? ERR.ref;
  if (r) return { kind: 'arr', rows: [g[r - 1]] };
  return { kind: 'arr', rows: g.map((row) => [row[c - 1]]) };
});
def('OFFSET', 'Lookup & Reference', 'OFFSET(reference, rows, cols, [height], [width])', 'Returns a reference to a range that is a given number of rows and columns from a given reference.', 3, 5, (args, ctx) => {
  const ref = args[0];
  if (!isRef(ref)) return ERR.value;
  const dr = int(args[1], ctx);
  const dc = int(args[2], ctx);
  if (isErr(dr)) return dr;
  if (isErr(dc)) return dc;
  const h = args.length > 3 && args[3] !== null ? int(args[3], ctx) : ref.r1 - ref.r0 + 1;
  const w = args.length > 4 && args[4] !== null ? int(args[4], ctx) : ref.c1 - ref.c0 + 1;
  if (isErr(h)) return h;
  if (isErr(w)) return w;
  if (h === 0 || w === 0) return ERR.ref;
  const r0 = ref.r0 + dr + (h < 0 ? h + 1 : 0);
  const c0 = ref.c0 + dc + (w < 0 ? w + 1 : 0);
  const r1 = r0 + Math.abs(h) - 1;
  const c1 = c0 + Math.abs(w) - 1;
  if (r0 < 0 || c0 < 0 || r1 >= MAX_ROWS || c1 >= MAX_COLS) return ERR.ref;
  return { kind: 'ref', sheet: ref.sheet, r0, c0, r1, c1 };
}, { volatile: true });
lazy('ROW', 'Lookup & Reference', 'ROW([reference])', 'Returns the row number of a reference.', 0, 1, (args, ctx) => {
  if (!args.length) return ctx.r + 1;
  const v = ctx.evaluate(args[0]);
  if (!isRef(v)) return isErr(v) ? v : ERR.value;
  if (v.r0 === v.r1) return v.r0 + 1;
  return { kind: 'arr', rows: Array.from({ length: Math.min(v.r1 - v.r0 + 1, 100000) }, (_, i) => [v.r0 + i + 1]) };
});
lazy('COLUMN', 'Lookup & Reference', 'COLUMN([reference])', 'Returns the column number of a reference.', 0, 1, (args, ctx) => {
  if (!args.length) return ctx.c + 1;
  const v = ctx.evaluate(args[0]);
  if (!isRef(v)) return isErr(v) ? v : ERR.value;
  if (v.c0 === v.c1) return v.c0 + 1;
  return { kind: 'arr', rows: [Array.from({ length: v.c1 - v.c0 + 1 }, (_, i) => v.c0 + i + 1)] };
});
def('ROWS', 'Lookup & Reference', 'ROWS(array)', 'Returns the number of rows in a reference or array.', 1, 1, (args) => (isErr(args[0]) ? args[0] : dims(args[0]).rows));
def('COLUMNS', 'Lookup & Reference', 'COLUMNS(array)', 'Returns the number of columns in an array or reference.', 1, 1, (args) => (isErr(args[0]) ? args[0] : dims(args[0]).cols));
def('INDIRECT', 'Lookup & Reference', 'INDIRECT(ref_text, [a1])', 'Returns the reference specified by a text string.', 1, 2, (args, ctx) => {
  const t = text(args[0], ctx);
  if (isErr(t)) return t;
  try {
    const node = parseFormula(t.trim());
    if (node.t !== 'ref' && node.t !== 'name') return ERR.ref;
    const v = ctx.evaluate(node);
    return isRef(v) ? v : ERR.ref;
  } catch {
    return ERR.ref;
  }
}, { volatile: true });
def('ADDRESS', 'Lookup & Reference', 'ADDRESS(row_num, column_num, [abs_num], [a1], [sheet_text])', 'Creates a cell reference as text, given specified row and column numbers.', 2, 5, (args, ctx) => {
  const r = int(args[0], ctx);
  const c = int(args[1], ctx);
  if (isErr(r)) return r;
  if (isErr(c)) return c;
  const abs = args.length > 2 && args[2] !== null ? int(args[2], ctx) : 1;
  if (isErr(abs)) return abs;
  const a1 = args.length > 3 && args[3] !== null ? bool(args[3], ctx) : true;
  if (isErr(a1)) return a1;
  if (r < 1 || c < 1 || r > MAX_ROWS || c > MAX_COLS || abs < 1 || abs > 4) return ERR.value;
  let s: string;
  if (a1) s = `${abs === 1 || abs === 3 ? '$' : ''}${colName(c - 1)}${abs === 1 || abs === 2 ? '$' : ''}${r}`;
  else s = `R${abs === 1 || abs === 2 ? r : `[${r}]`}C${abs === 1 || abs === 3 ? c : `[${c}]`}`;
  if (args.length > 4) {
    const sh = text(args[4], ctx);
    if (isErr(sh)) return sh;
    s = `${sh.startsWith('[') ? sh : quoteSheet(sh)}!${s}`;
  }
  return s;
});
def('TRANSPOSE', 'Lookup & Reference', 'TRANSPOSE(array)', 'Converts a vertical range of cells to a horizontal range, or vice versa.', 1, 1, (args, ctx) => {
  const g = grid(args[0], ctx);
  return { kind: 'arr', rows: (g[0] ?? []).map((_, j) => g.map((row) => row[j])) };
});
def('HYPERLINK', 'Lookup & Reference', 'HYPERLINK(link_location, [friendly_name])', 'Creates a shortcut or jump that opens a document stored on your hard drive, a network server, or on the Internet.', 1, 2, (args, ctx) => scalar(args.length > 1 ? args[1] : args[0], ctx));
def('FORMULATEXT', 'Lookup & Reference', 'FORMULATEXT(reference)', 'Returns a formula as a string.', 1, 1, (args, ctx) => {
  const v = args[0];
  if (!isRef(v)) return ERR.value;
  return ctx.host.formulaText(v.sheet, v.r0, v.c0) ?? ERR.na;
});
def('UNIQUE', 'Lookup & Reference', 'UNIQUE(array, [by_col], [exactly_once])', 'Returns the unique values from a range or array.', 1, 3, (args, ctx) => {
  const g = grid(args[0], ctx);
  const seen = new Map<string, number>();
  for (const row of g) {
    const k = JSON.stringify(row.map((v) => (typeof v === 'string' ? v.toLowerCase() : String(v))));
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const once = args.length > 2 && bool(args[2], ctx) === true;
  const out: Scalar[][] = [];
  const added = new Set<string>();
  for (const row of g) {
    const k = JSON.stringify(row.map((v) => (typeof v === 'string' ? v.toLowerCase() : String(v))));
    if (added.has(k) || (once && seen.get(k) !== 1)) continue;
    added.add(k);
    out.push(row);
  }
  return out.length ? { kind: 'arr', rows: out } : ERR.calc;
});
def('SORT', 'Lookup & Reference', 'SORT(array, [sort_index], [sort_order], [by_col])', 'Sorts a range or array.', 1, 4, (args, ctx) => {
  const g = grid(args[0], ctx).map((r) => [...r]);
  const i = args.length > 1 && args[1] !== null ? int(args[1], ctx) : 1;
  const o = args.length > 2 && args[2] !== null ? int(args[2], ctx) : 1;
  if (isErr(i)) return i;
  if (isErr(o)) return o;
  g.sort((a, b) => compare(a[i - 1] ?? null, b[i - 1] ?? null) * (o < 0 ? -1 : 1));
  return { kind: 'arr', rows: g };
});
def('FILTER', 'Lookup & Reference', 'FILTER(array, include, [if_empty])', 'Filters a range or array.', 2, 3, (args, ctx) => {
  const g = grid(args[0], ctx);
  const inc = grid(args[1], ctx).flat();
  const out = g.filter((_, i) => toBool(inc[i] ?? false) === true);
  if (!out.length) return args.length > 2 ? scalar(args[2], ctx) : ERR.calc;
  return { kind: 'arr', rows: out };
});
def('SEQUENCE', 'Math & Trig', 'SEQUENCE(rows, [columns], [start], [step])', 'Returns a sequence of numbers.', 1, 4, (args, ctx) => {
  const [r, c, s, st] = [int(args[0], ctx), args.length > 1 && args[1] !== null ? int(args[1], ctx) : 1, args.length > 2 && args[2] !== null ? num(args[2], ctx) : 1, args.length > 3 && args[3] !== null ? num(args[3], ctx) : 1];
  for (const v of [r, c, s, st]) if (isErr(v)) return v;
  const rows: Scalar[][] = [];
  for (let i = 0; i < Math.min(r as number, 100000); i++) rows.push(Array.from({ length: c as number }, (_, j) => (s as number) + (i * (c as number) + j) * (st as number)));
  return { kind: 'arr', rows } satisfies ArrValue;
});

// ---- Text ------------------------------------------------------------------------------------

function textFn(f: (s: string, rest: Scalar[]) => Scalar) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const s = text(args[0], ctx);
    if (isErr(s)) return s;
    const rest = args.slice(1).map((a) => scalar(a, ctx));
    for (const r of rest) if (isErr(r)) return r;
    return f(s, rest);
  };
}
const optNum = (v: Scalar | undefined, d: number): number | CellError => (v === undefined ? d : toNum(v));

def('LEN', 'Text', 'LEN(text)', 'Returns the number of characters in a text string.', 1, 1, textFn((s) => s.length));
def('UPPER', 'Text', 'UPPER(text)', 'Converts a text string to all uppercase letters.', 1, 1, textFn((s) => s.toUpperCase()));
def('LOWER', 'Text', 'LOWER(text)', 'Converts all letters in a text string to lowercase.', 1, 1, textFn((s) => s.toLowerCase()));
def('PROPER', 'Text', 'PROPER(text)', 'Converts a text string to proper case; the first letter in each word to uppercase, and all other letters to lowercase.', 1, 1, textFn((s) => s.toLowerCase().replace(/(^|[^a-zA-ZÀ-ÿ])([a-zà-ÿ])/g, (_m, a: string, b: string) => a + b.toUpperCase())));
def('TRIM', 'Text', 'TRIM(text)', 'Removes all spaces from a text string except for single spaces between words.', 1, 1, textFn((s) => s.replace(/ +/g, ' ').replace(/^ | $/g, '')));
// eslint-disable-next-line no-control-regex
def('CLEAN', 'Text', 'CLEAN(text)', 'Removes all nonprintable characters from text.', 1, 1, textFn((s) => s.replace(/[\x00-\x1f]/g, '')));
def('T', 'Text', 'T(value)', 'Checks whether a value is text, and returns the text if it is, or returns double quotes (empty text) if it is not.', 1, 1, (args, ctx) => {
  if (isRef(args[0]) && isMulti(args[0])) return '';
  const v = scalar(args[0], ctx);
  return isErr(v) ? v : typeof v === 'string' ? v : '';
});
def('LEFT', 'Text', 'LEFT(text, [num_chars])', 'Returns the specified number of characters from the start of a text string.', 1, 2, textFn((s, [n]) => {
  const k = optNum(n, 1);
  return isErr(k) ? k : k < 0 ? ERR.value : s.slice(0, Math.trunc(k));
}));
def('RIGHT', 'Text', 'RIGHT(text, [num_chars])', 'Returns the specified number of characters from the end of a text string.', 1, 2, textFn((s, [n]) => {
  const k = optNum(n, 1);
  return isErr(k) ? k : k < 0 ? ERR.value : Math.trunc(k) === 0 ? '' : s.slice(-Math.trunc(k));
}));
def('MID', 'Text', 'MID(text, start_num, num_chars)', 'Returns the characters from the middle of a text string, given a starting position and length.', 3, 3, textFn((s, [a, n]) => {
  const st = toNum(a);
  const k = toNum(n);
  if (isErr(st)) return st;
  if (isErr(k)) return k;
  if (st < 1 || k < 0) return ERR.value;
  return s.substr(Math.trunc(st) - 1, Math.trunc(k));
}));
function findFn(caseless: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const f = text(args[0], ctx);
    const w = text(args[1], ctx);
    if (isErr(f)) return f;
    if (isErr(w)) return w;
    const st = args.length > 2 ? num(args[2], ctx) : 1;
    if (isErr(st)) return st;
    if (st < 1 || st > w.length + 1) return ERR.value;
    let i: number;
    if (caseless) {
      if (/[*?~]/.test(f)) {
        const re = new RegExp(f.split('').map((ch, k, arr) => (arr[k - 1] === '~' ? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ch === '~' ? '' : ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(''), 'i');
        const m = re.exec(w.slice(Math.trunc(st) - 1));
        i = m ? m.index + Math.trunc(st) - 1 : -1;
      } else i = w.toLowerCase().indexOf(f.toLowerCase(), Math.trunc(st) - 1);
    } else i = w.indexOf(f, Math.trunc(st) - 1);
    return i < 0 ? ERR.value : i + 1;
  };
}
def('FIND', 'Text', 'FIND(find_text, within_text, [start_num])', 'Returns the starting position of one text string within another text string. FIND is case-sensitive.', 2, 3, findFn(false));
def('SEARCH', 'Text', 'SEARCH(find_text, within_text, [start_num])', 'Returns the number of the character at which a specific character or text string is first found, reading left to right (not case-sensitive).', 2, 3, findFn(true));
def('SUBSTITUTE', 'Text', 'SUBSTITUTE(text, old_text, new_text, [instance_num])', 'Replaces existing text with new text in a text string.', 3, 4, (args, ctx) => {
  const [s, o, n] = [text(args[0], ctx), text(args[1], ctx), text(args[2], ctx)];
  if (isErr(s)) return s;
  if (isErr(o)) return o;
  if (isErr(n)) return n;
  if (!o) return s;
  if (args.length < 4) return s.split(o).join(n);
  const k = int(args[3], ctx);
  if (isErr(k)) return k;
  if (k < 1) return ERR.value;
  let idx = -1;
  for (let i = 0; i < k; i++) {
    idx = s.indexOf(o, idx + 1);
    if (idx < 0) return s;
  }
  return s.slice(0, idx) + n + s.slice(idx + o.length);
});
def('REPLACE', 'Text', 'REPLACE(old_text, start_num, num_chars, new_text)', 'Replaces part of a text string with a different text string.', 4, 4, textFn((s, [a, k, n]) => {
  const st = toNum(a);
  const len = toNum(k);
  const nt = toText(n);
  if (isErr(st)) return st;
  if (isErr(len)) return len;
  if (isErr(nt)) return nt;
  if (st < 1 || len < 0) return ERR.value;
  return s.slice(0, Math.trunc(st) - 1) + nt + s.slice(Math.trunc(st) - 1 + Math.trunc(len));
}));
def('REPT', 'Text', 'REPT(text, number_times)', 'Repeats text a given number of times.', 2, 2, textFn((s, [n]) => {
  const k = toNum(n);
  if (isErr(k)) return k;
  if (k < 0 || s.length * k > 32767) return ERR.value;
  return s.repeat(Math.trunc(k));
}));
def('EXACT', 'Text', 'EXACT(text1, text2)', 'Checks whether two text strings are exactly the same, and returns TRUE or FALSE. EXACT is case-sensitive.', 2, 2, (args, ctx) => {
  const a = text(args[0], ctx);
  const b = text(args[1], ctx);
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  return a === b;
});
def('CONCATENATE', 'Text', 'CONCATENATE(text1, [text2], ...)', 'Joins several text strings into one text string.', 1, MANY, (args, ctx) => {
  let s = '';
  for (const a of args) {
    const t = text(a, ctx);
    if (isErr(t)) return t;
    s += t;
  }
  return s;
});
def('CONCAT', 'Text', 'CONCAT(text1, ...)', 'Concatenates a list or range of text strings.', 1, MANY, (args, ctx) => {
  let s = '';
  for (const v of flatValues(args, ctx)) {
    const t = toText(v);
    if (isErr(t)) return t;
    s += t;
  }
  return s;
});
def('TEXTJOIN', 'Text', 'TEXTJOIN(delimiter, ignore_empty, text1, ...)', 'Concatenates a list or range of text strings using a delimiter.', 3, MANY, (args, ctx) => {
  const d = text(args[0], ctx);
  if (isErr(d)) return d;
  const ignore = bool(args[1], ctx);
  if (isErr(ignore)) return ignore;
  const parts: string[] = [];
  for (const a of args.slice(2)) {
    const vals = isRef(a) ? grid(a, ctx).flat() : flatValues([a], ctx);
    for (const v of vals) {
      const t = toText(v);
      if (isErr(t)) return t;
      if (!ignore || t !== '') parts.push(t);
    }
  }
  return parts.join(d);
});
const CP1252: Record<number, number> = { 128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160, 139: 0x2039, 140: 0x152, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x2dc, 153: 0x2122, 154: 0x161, 155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178 };
def('CHAR', 'Text', 'CHAR(number)', 'Returns the character specified by the code number from the character set for your computer.', 1, 1, math1Text((n) => (n < 1 || n > 255 ? ERR.value : String.fromCharCode(CP1252[Math.trunc(n)] ?? Math.trunc(n)))));
def('CODE', 'Text', 'CODE(text)', 'Returns a numeric code for the first character in a text string, in the character set used by your computer.', 1, 1, textFn((s) => {
  if (!s) return ERR.value;
  const cp = s.charCodeAt(0);
  const back = Object.entries(CP1252).find(([, u]) => u === cp);
  return back ? Number(back[0]) : cp > 255 ? 63 : cp;
}));
def('UNICHAR', 'Text', 'UNICHAR(number)', 'Returns the Unicode character referenced by the given numeric value.', 1, 1, math1Text((n) => (n < 1 || n > 0x10ffff ? ERR.value : String.fromCodePoint(Math.trunc(n)))));
def('UNICODE', 'Text', 'UNICODE(text)', 'Returns the number (code point) corresponding to the first character of the text.', 1, 1, textFn((s) => (s ? s.codePointAt(0)! : ERR.value)));
function math1Text(f: (n: number) => Scalar) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const n = num(args[0], ctx);
    return isErr(n) ? n : f(n);
  };
}
def('TEXT', 'Text', 'TEXT(value, format_text)', 'Converts a value to text in a specific number format.', 2, 2, (args, ctx) => {
  let v = scalar(args[0], ctx);
  if (isErr(v)) return v;
  const f = text(args[1], ctx);
  if (isErr(f)) return f;
  if (typeof v === 'string') {
    const p = parseEntry(v, ctx.host.date1904);
    if (typeof p.value === 'number') v = p.value;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return formatValue(v, f, ctx.host.date1904, 255).text;
});
def('VALUE', 'Text', 'VALUE(text)', 'Converts a text string that represents a number to a number.', 1, 1, (args, ctx) => {
  const v = scalar(args[0], ctx);
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  const p = parseEntry(String(v).trim(), ctx.host.date1904);
  return typeof p.value === 'number' ? p.value : ERR.value;
});
function fixedText(n: number, d: number, commas: boolean): string {
  const r = d >= 0 ? roundTo(n, d, 'round') : roundTo(n, d, 'round');
  const s = Math.abs(r).toFixed(Math.max(0, Math.trunc(d)));
  const [i, f] = s.split('.');
  const ig = commas ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i;
  return f !== undefined ? `${ig}.${f}` : ig;
}
def('FIXED', 'Text', 'FIXED(number, [decimals], [no_commas])', 'Rounds a number to the specified number of decimals and returns the result as text with or without commas.', 1, 3, (args, ctx) => {
  const n = num(args[0], ctx);
  if (isErr(n)) return n;
  const d = args.length > 1 && args[1] !== null ? int(args[1], ctx) : 2;
  if (isErr(d)) return d;
  const nc = args.length > 2 ? bool(args[2], ctx) : false;
  if (isErr(nc)) return nc;
  const s = fixedText(n, d, !nc);
  return roundTo(n, d, 'round') < 0 ? `-${s}` : s;
});
def('DOLLAR', 'Text', 'DOLLAR(number, [decimals])', 'Converts a number to text, using currency format.', 1, 2, (args, ctx) => {
  const n = num(args[0], ctx);
  if (isErr(n)) return n;
  const d = args.length > 1 ? int(args[1], ctx) : 2;
  if (isErr(d)) return d;
  const s = `$${fixedText(n, d, true)}`;
  return roundTo(n, d, 'round') < 0 ? `(${s})` : s;
});
def('NUMBERVALUE', 'Text', 'NUMBERVALUE(text, [decimal_separator], [group_separator])', 'Converts text to number in a locale-independent manner.', 1, 3, (args, ctx) => {
  const t = text(args[0], ctx);
  if (isErr(t)) return t;
  const dec = args.length > 1 ? text(args[1], ctx) : '.';
  const grp = args.length > 2 ? text(args[2], ctx) : ',';
  if (isErr(dec)) return dec;
  if (isErr(grp)) return grp;
  let s = t.replace(/\s/g, '').split(grp[0] ?? ',').join('');
  if (dec[0] && dec[0] !== '.') s = s.replace(dec[0], '.');
  const pct = (s.match(/%/g) ?? []).length;
  const n = Number(s.replace(/%/g, ''));
  return Number.isFinite(n) && s !== '' ? n / Math.pow(100, pct) : ERR.value;
});
def('TEXTBEFORE', 'Text', 'TEXTBEFORE(text, delimiter, [instance_num])', 'Returns text that occurs before delimiting characters.', 2, 3, textFn((s, [d, k]) => {
  const dl = toText(d);
  const n = optNum(k, 1);
  if (isErr(dl)) return dl;
  if (isErr(n)) return n;
  const parts = s.split(dl);
  return parts.length - 1 < Math.abs(n) ? ERR.na : n > 0 ? parts.slice(0, n).join(dl) : parts.slice(0, parts.length + n).join(dl);
}));
def('TEXTAFTER', 'Text', 'TEXTAFTER(text, delimiter, [instance_num])', 'Returns text that occurs after delimiting characters.', 2, 3, textFn((s, [d, k]) => {
  const dl = toText(d);
  const n = optNum(k, 1);
  if (isErr(dl)) return dl;
  if (isErr(n)) return n;
  const parts = s.split(dl);
  return parts.length - 1 < Math.abs(n) ? ERR.na : n > 0 ? parts.slice(n).join(dl) : parts.slice(parts.length + n).join(dl);
}));

// ---- Information -------------------------------------------------------------------------------

function is(f: (v: Scalar) => boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => f(scalar(args[0], ctx));
}
def('ISBLANK', 'Information', 'ISBLANK(value)', 'Checks whether a reference is to an empty cell, and returns TRUE or FALSE.', 1, 1, (args, ctx) => isRef(args[0]) && scalar(args[0], ctx) === null);
def('ISNUMBER', 'Information', 'ISNUMBER(value)', 'Checks whether a value is a number, and returns TRUE or FALSE.', 1, 1, is((v) => typeof v === 'number'));
def('ISTEXT', 'Information', 'ISTEXT(value)', 'Checks whether a value is text, and returns TRUE or FALSE.', 1, 1, is((v) => typeof v === 'string'));
def('ISNONTEXT', 'Information', 'ISNONTEXT(value)', 'Checks whether a value is not text (blank cells are not text), and returns TRUE or FALSE.', 1, 1, is((v) => typeof v !== 'string'));
def('ISLOGICAL', 'Information', 'ISLOGICAL(value)', 'Checks whether a value is a logical value (TRUE or FALSE), and returns TRUE or FALSE.', 1, 1, is((v) => typeof v === 'boolean'));
def('ISERROR', 'Information', 'ISERROR(value)', 'Checks whether a value is an error, and returns TRUE or FALSE.', 1, 1, is((v) => isErr(v)));
def('ISERR', 'Information', 'ISERR(value)', 'Checks whether a value is an error other than #N/A, and returns TRUE or FALSE.', 1, 1, is((v) => isErr(v) && v !== ERR.na));
def('ISNA', 'Information', 'ISNA(value)', 'Checks whether a value is #N/A, and returns TRUE or FALSE.', 1, 1, is((v) => v === ERR.na));
lazy('ISREF', 'Information', 'ISREF(value)', 'Checks whether a value is a reference, and returns TRUE or FALSE.', 1, 1, (args, ctx) => isRef(ctx.evaluate(args[0])));
lazy('ISFORMULA', 'Information', 'ISFORMULA(reference)', 'Checks whether a reference is to a cell containing a formula, and returns TRUE or FALSE.', 1, 1, (args, ctx) => {
  const v = ctx.evaluate(args[0]);
  return isRef(v) ? ctx.host.formulaText(v.sheet, v.r0, v.c0) !== null : ERR.value;
});
function parity(odd: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const n = num(args[0], ctx);
    if (isErr(n)) return n;
    return (Math.abs(Math.trunc(n)) % 2 === 1) === odd;
  };
}
def('ISEVEN', 'Information', 'ISEVEN(number)', 'Returns TRUE if the number is even.', 1, 1, parity(false));
def('ISODD', 'Information', 'ISODD(number)', 'Returns TRUE if the number is odd.', 1, 1, parity(true));
def('NA', 'Information', 'NA()', 'Returns the error value #N/A (value not available).', 0, 0, () => ERR.na);
def('ERROR.TYPE', 'Information', 'ERROR.TYPE(error_val)', 'Returns a number matching an error value.', 1, 1, (args, ctx) => {
  const v = scalar(args[0], ctx);
  if (!isErr(v)) return ERR.na;
  const i = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA'].indexOf(v.code);
  return i < 0 ? ERR.na : i + 1;
});
def('N', 'Information', 'N(value)', 'Converts non-number values to numbers, dates to serial numbers, TRUE to 1, anything else to 0 (zero).', 1, 1, (args, ctx) => {
  const v = scalar(args[0], ctx);
  return isErr(v) ? v : typeof v === 'number' ? v : v === true ? 1 : 0;
});
def('TYPE', 'Information', 'TYPE(value)', 'Returns an integer representing the data type of a value: number = 1; text = 2; logical value = 4; error value = 16; array = 64.', 1, 1, (args, ctx) => {
  if (isArr(args[0]) || (isRef(args[0]) && isMulti(args[0]))) return 64;
  const v = scalar(args[0], ctx);
  return typeof v === 'number' || v === null ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 4 : 16;
});
def('SHEET', 'Information', 'SHEET([value])', 'Returns the sheet number of the referenced sheet.', 0, 1, (args, ctx) => (args.length && isRef(args[0]) ? args[0].sheet + 1 : ctx.sheet + 1));
def('SHEETS', 'Information', 'SHEETS([reference])', 'Returns the number of sheets in a reference.', 0, 1, (args, ctx) => (args.length ? 1 : ctx.host.sheetCount()));

// ---- Date & Time -------------------------------------------------------------------------------

/** A date argument: a serial, or text that reads as a date. */
function dateArg(v: EvalValue, ctx: Ctx): number | CellError {
  const s = scalar(v, ctx);
  if (typeof s === 'string') {
    const p = parseEntry(s, ctx.host.date1904);
    return typeof p.value === 'number' ? p.value : ERR.value;
  }
  const n = toNum(s);
  if (isErr(n)) return n;
  return n < 0 ? ERR.num : n;
}

function datePart(f: (p: ReturnType<typeof serialParts>) => number) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const d = dateArg(args[0], ctx);
    if (isErr(d)) return d;
    if (d > 2958465.99999) return ERR.num;
    return f(serialParts(d, ctx.host.date1904));
  };
}
def('TODAY', 'Date & Time', 'TODAY()', 'Returns the current date formatted as a date.', 0, 0, (_a, ctx) => todaySerial(ctx.host.date1904), { volatile: true });
def('NOW', 'Date & Time', 'NOW()', 'Returns the current date and time formatted as a date and time.', 0, 0, (_a, ctx) => nowSerial(ctx.host.date1904), { volatile: true });
def('DATE', 'Date & Time', 'DATE(year, month, day)', 'Returns the number that represents the date in Microsoft Excel date-time code.', 3, 3, (args, ctx) => {
  let y = int(args[0], ctx);
  const m = int(args[1], ctx);
  const d = int(args[2], ctx);
  if (isErr(y)) return y;
  if (isErr(m)) return m;
  if (isErr(d)) return d;
  if (y < 0 || y > 9999) return ERR.num;
  if (y < 1900) y += 1900;
  const s = dateSerial(y, m, d, ctx.host.date1904);
  return s < 0 || s > 2958465 ? ERR.num : s;
});
def('TIME', 'Date & Time', 'TIME(hour, minute, second)', 'Converts hours, minutes, and seconds given as numbers to an Excel serial number, formatted with a time format.', 3, 3, (args, ctx) => {
  const [h, m, s] = [int(args[0], ctx), int(args[1], ctx), int(args[2], ctx)];
  if (isErr(h)) return h;
  if (isErr(m)) return m;
  if (isErr(s)) return s;
  const t = (h * 3600 + m * 60 + s) / 86400;
  if (t < 0) return ERR.num;
  return t - Math.floor(t);
});
def('YEAR', 'Date & Time', 'YEAR(serial_number)', 'Returns the year of a date, an integer in the range 1900-9999.', 1, 1, datePart((p) => p.y));
def('MONTH', 'Date & Time', 'MONTH(serial_number)', 'Returns the month, a number from 1 (January) to 12 (December).', 1, 1, datePart((p) => p.m));
def('DAY', 'Date & Time', 'DAY(serial_number)', 'Returns the day of the month, a number from 1 to 31.', 1, 1, datePart((p) => p.d));
def('HOUR', 'Date & Time', 'HOUR(serial_number)', 'Returns the hour as a number from 0 (12:00 A.M.) to 23 (11:00 P.M.).', 1, 1, datePart((p) => p.hh));
def('MINUTE', 'Date & Time', 'MINUTE(serial_number)', 'Returns the minute, a number from 0 to 59.', 1, 1, datePart((p) => p.mm));
def('SECOND', 'Date & Time', 'SECOND(serial_number)', 'Returns the second, a number from 0 to 59.', 1, 1, datePart((p) => p.ss + (p.ms >= 500 ? 1 : 0)));
def('WEEKDAY', 'Date & Time', 'WEEKDAY(serial_number, [return_type])', 'Returns a number from 1 to 7 identifying the day of the week of a date.', 1, 2, (args, ctx) => {
  const d = dateArg(args[0], ctx);
  if (isErr(d)) return d;
  const t = args.length > 1 && args[1] !== null ? int(args[1], ctx) : 1;
  if (isErr(t)) return t;
  const dow = serialParts(d, ctx.host.date1904).dow;
  if (t === 1) return dow + 1;
  if (t === 2) return ((dow + 6) % 7) + 1;
  if (t === 3) return (dow + 6) % 7;
  if (t >= 11 && t <= 17) return ((dow - (t - 10) + 7) % 7) + 1;
  return ERR.num;
});
def('WEEKNUM', 'Date & Time', 'WEEKNUM(serial_number, [return_type])', 'Returns the week number in the year.', 1, 2, (args, ctx) => {
  const d = dateArg(args[0], ctx);
  if (isErr(d)) return d;
  const t = args.length > 1 && args[1] !== null ? int(args[1], ctx) : 1;
  if (isErr(t)) return t;
  const p = serialParts(d, ctx.host.date1904);
  if (t === 21) return isoWeek(d, ctx);
  const start = t === 1 || t === 17 ? 0 : t === 2 || t === 11 ? 1 : t >= 12 && t <= 16 ? t - 10 : -1;
  if (start < 0) return ERR.num;
  const jan1 = dateSerial(p.y, 1, 1, ctx.host.date1904);
  const jan1dow = serialParts(jan1, ctx.host.date1904).dow;
  const offset = (jan1dow - start + 7) % 7;
  return Math.floor((Math.floor(d) - jan1 + offset) / 7) + 1;
});
function isoWeek(d: number, ctx: Ctx): number {
  const p = serialParts(d, ctx.host.date1904);
  const dow = (p.dow + 6) % 7;
  const thursday = Math.floor(d) - dow + 3;
  const ty = serialParts(thursday, ctx.host.date1904).y;
  const jan1 = dateSerial(ty, 1, 1, ctx.host.date1904);
  return Math.floor((thursday - jan1) / 7) + 1;
}
def('ISOWEEKNUM', 'Date & Time', 'ISOWEEKNUM(date)', 'Returns the ISO week number in the year for a given date.', 1, 1, (args, ctx) => {
  const d = dateArg(args[0], ctx);
  return isErr(d) ? d : isoWeek(d, ctx);
});
function monthsFn(end: boolean) {
  return (args: EvalValue[], ctx: Ctx): EvalValue => {
    const d = dateArg(args[0], ctx);
    if (isErr(d)) return d;
    const m = int(args[1], ctx);
    if (isErr(m)) return m;
    const p = serialParts(d, ctx.host.date1904);
    const total = p.y * 12 + (p.m - 1) + m;
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    const day = end ? daysInMonth(y, mo) : Math.min(p.d, daysInMonth(y, mo));
    const s = dateSerial(y, mo, day, ctx.host.date1904);
    return s < 0 ? ERR.num : s;
  };
}
def('EDATE', 'Date & Time', 'EDATE(start_date, months)', 'Returns the serial number of the date that is the indicated number of months before or after the start date.', 2, 2, monthsFn(false));
def('EOMONTH', 'Date & Time', 'EOMONTH(start_date, months)', 'Returns the serial number of the last day of the month before or after a specified number of months.', 2, 2, monthsFn(true));
def('DAYS', 'Date & Time', 'DAYS(end_date, start_date)', 'Returns the number of days between the two dates.', 2, 2, (args, ctx) => {
  const e = dateArg(args[0], ctx);
  const s = dateArg(args[1], ctx);
  if (isErr(e)) return e;
  if (isErr(s)) return s;
  return Math.floor(e) - Math.floor(s);
});
def('DAYS360', 'Date & Time', 'DAYS360(start_date, end_date, [method])', 'Returns the number of days between two dates based on a 360-day year (twelve 30-day months).', 2, 3, (args, ctx) => {
  const s = dateArg(args[0], ctx);
  const e = dateArg(args[1], ctx);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  const eu = args.length > 2 ? bool(args[2], ctx) : false;
  if (isErr(eu)) return eu;
  const a = serialParts(s, ctx.host.date1904);
  const b = serialParts(e, ctx.host.date1904);
  let d1 = a.d;
  let d2 = b.d;
  if (eu) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    const lastFeb = (p: typeof a) => p.m === 2 && p.d === daysInMonth(p.y, 2);
    if (lastFeb(a)) {
      if (lastFeb(b)) d2 = 30;
      d1 = 30;
    }
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
});
def('DATEDIF', 'Date & Time', 'DATEDIF(start_date, end_date, unit)', 'Calculates the number of days, months, or years between two dates.', 3, 3, (args, ctx) => {
  const s = dateArg(args[0], ctx);
  const e = dateArg(args[1], ctx);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  const u = text(args[2], ctx);
  if (isErr(u)) return u;
  if (s > e) return ERR.num;
  const a = serialParts(s, ctx.host.date1904);
  const b = serialParts(e, ctx.host.date1904);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months--;
  switch (u.toUpperCase()) {
    case 'Y':
      return Math.floor(months / 12);
    case 'M':
      return months;
    case 'D':
      return Math.floor(e) - Math.floor(s);
    case 'YM':
      return months % 12;
    case 'MD': {
      if (b.d >= a.d) return b.d - a.d;
      const pm = b.m === 1 ? 12 : b.m - 1;
      const py = b.m === 1 ? b.y - 1 : b.y;
      return daysInMonth(py, pm) - a.d + b.d;
    }
    case 'YD': {
      let start = dateSerial(b.y, a.m, a.d, ctx.host.date1904);
      if (start > Math.floor(e)) start = dateSerial(b.y - 1, a.m, a.d, ctx.host.date1904);
      return Math.floor(e) - start;
    }
  }
  return ERR.num;
});
function holidaysOf(v: EvalValue | undefined, ctx: Ctx): Set<number> {
  const out = new Set<number>();
  if (v === undefined) return out;
  for (const x of flatValues([v], ctx)) if (typeof x === 'number') out.add(Math.floor(x));
  return out;
}
const isWorkday = (d: number, ctx: Ctx, hol: Set<number>) => {
  const dow = serialParts(d, ctx.host.date1904).dow;
  return dow !== 0 && dow !== 6 && !hol.has(d);
};
def('NETWORKDAYS', 'Date & Time', 'NETWORKDAYS(start_date, end_date, [holidays])', 'Returns the number of whole workdays between two dates.', 2, 3, (args, ctx) => {
  const s = dateArg(args[0], ctx);
  const e = dateArg(args[1], ctx);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  const hol = holidaysOf(args[2], ctx);
  const [a, b] = [Math.floor(Math.min(s, e)), Math.floor(Math.max(s, e))];
  let n = 0;
  for (let d = a; d <= b; d++) if (isWorkday(d, ctx, hol)) n++;
  return s > e ? -n : n;
});
def('WORKDAY', 'Date & Time', 'WORKDAY(start_date, days, [holidays])', 'Returns the serial number of the date before or after a specified number of workdays.', 2, 3, (args, ctx) => {
  const s = dateArg(args[0], ctx);
  const n = int(args[1], ctx);
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  const hol = holidaysOf(args[2], ctx);
  let d = Math.floor(s);
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d += step;
    if (isWorkday(d, ctx, hol)) left--;
  }
  return d;
});
def('DATEVALUE', 'Date & Time', 'DATEVALUE(date_text)', 'Converts a date in the form of text to a number that represents the date in Microsoft Excel date-time code.', 1, 1, (args, ctx) => {
  const t = text(args[0], ctx);
  if (isErr(t)) return t;
  const p = parseEntry(t.trim(), ctx.host.date1904);
  return typeof p.value === 'number' && p.format && /[dmy]/.test(p.format) ? Math.floor(p.value) : ERR.value;
});
def('TIMEVALUE', 'Date & Time', 'TIMEVALUE(time_text)', 'Converts a text time to an Excel serial number for a time.', 1, 1, (args, ctx) => {
  const t = text(args[0], ctx);
  if (isErr(t)) return t;
  const p = parseEntry(t.trim(), ctx.host.date1904);
  return typeof p.value === 'number' && p.format && /h/.test(p.format) ? p.value - Math.floor(p.value) : ERR.value;
});
def('YEARFRAC', 'Date & Time', 'YEARFRAC(start_date, end_date, [basis])', 'Returns the year fraction representing the number of whole days between start_date and end_date.', 2, 3, (args, ctx) => {
  const s = dateArg(args[0], ctx);
  const e = dateArg(args[1], ctx);
  if (isErr(s)) return s;
  if (isErr(e)) return e;
  const basis = args.length > 2 ? int(args[2], ctx) : 0;
  if (isErr(basis)) return basis;
  const [a, b] = [Math.min(s, e), Math.max(s, e)];
  if (basis === 0 || basis === 4) {
    const d = FUNCTIONS.DAYS360.fn!([a, b, basis === 4], ctx);
    return typeof d === 'number' ? d / 360 : d;
  }
  if (basis === 2) return (b - a) / 360;
  if (basis === 3) return (b - a) / 365;
  const ya = serialParts(a, ctx.host.date1904).y;
  const yb = serialParts(b, ctx.host.date1904).y;
  let days = 0;
  for (let y = ya; y <= yb; y++) days += daysInMonth(y, 2) === 29 ? 366 : 365;
  return (b - a) / (days / (yb - ya + 1));
});

// ---- Financial ---------------------------------------------------------------------------------

function nums(args: EvalValue[], ctx: Ctx, defaults: number[]): number[] | CellError {
  const out: number[] = [];
  for (let i = 0; i < defaults.length; i++) {
    if (i >= args.length || args[i] === null) {
      if (Number.isNaN(defaults[i])) return ERR.value;
      out.push(defaults[i]);
      continue;
    }
    const n = num(args[i], ctx);
    if (isErr(n)) return n;
    out.push(n);
  }
  return out;
}
const REQ = NaN;
function pmtOf(r: number, n: number, pv: number, fv: number, type: number): number {
  if (r === 0) return -(pv + fv) / n;
  const f = Math.pow(1 + r, n);
  return -(r * (pv * f + fv)) / ((1 + r * type) * (f - 1));
}
function fvOf(r: number, n: number, pmt: number, pv: number, type: number): number {
  if (r === 0) return -(pv + pmt * n);
  const f = Math.pow(1 + r, n);
  return -(pv * f + (pmt * (1 + r * type) * (f - 1)) / r);
}
def('PMT', 'Financial', 'PMT(rate, nper, pv, [fv], [type])', 'Calculates the payment for a loan based on constant payments and a constant interest rate.', 3, 5, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, n, pv, fv, t] = v;
  if (n === 0) return ERR.num;
  return fin(pmtOf(r, n, pv, fv, t ? 1 : 0));
});
def('FV', 'Financial', 'FV(rate, nper, pmt, [pv], [type])', 'Returns the future value of an investment based on periodic, constant payments and a constant interest rate.', 3, 5, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, n, pmt, pv, t] = v;
  return fin(fvOf(r, n, pmt, pv, t ? 1 : 0));
});
def('PV', 'Financial', 'PV(rate, nper, pmt, [fv], [type])', 'Returns the present value of an investment: the total amount that a series of future payments is worth now.', 3, 5, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, n, pmt, fv, t] = v;
  if (r === 0) return -(fv + pmt * n);
  const f = Math.pow(1 + r, n);
  return fin(-(fv + (pmt * (1 + r * (t ? 1 : 0)) * (f - 1)) / r) / f);
});
def('NPER', 'Financial', 'NPER(rate, pmt, pv, [fv], [type])', 'Returns the number of periods for an investment based on periodic, constant payments and a constant interest rate.', 3, 5, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, pmt, pv, fv, t] = v;
  if (r === 0) return pmt === 0 ? ERR.num : -(pv + fv) / pmt;
  const k = pmt * (1 + r * (t ? 1 : 0));
  const x = (k - fv * r) / (k + pv * r);
  return x <= 0 ? ERR.num : fin(Math.log(x) / Math.log(1 + r));
});
def('NPV', 'Financial', 'NPV(rate, value1, [value2], ...)', 'Returns the net present value of an investment based on a discount rate and a series of future payments (negative values) and income (positive values).', 2, MANY, (args, ctx) => {
  const r = num(args[0], ctx);
  if (isErr(r)) return r;
  const xs = numbers(args.slice(1), ctx);
  if (isErr(xs)) return xs;
  let s = 0;
  xs.forEach((x, i) => (s += x / Math.pow(1 + r, i + 1)));
  return fin(s);
});
function solve(f: (r: number) => number, guess: number): number | CellError {
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(r);
    const h = 1e-7;
    const d = (f(r + h) - y) / h;
    if (!Number.isFinite(d) || d === 0) return ERR.num;
    const next = r - y / d;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  return ERR.num;
}
def('RATE', 'Financial', 'RATE(nper, pmt, pv, [fv], [type], [guess])', 'Returns the interest rate per period of a loan or an investment.', 3, 6, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, 0, 0, 0.1]);
  if (isErr(v)) return v;
  const [n, pmt, pv, fv, t, g] = v;
  return solve((r) => (r === 0 ? pv + pmt * n + fv : pv * Math.pow(1 + r, n) + (pmt * (1 + r * (t ? 1 : 0)) * (Math.pow(1 + r, n) - 1)) / r + fv), g);
});
def('IRR', 'Financial', 'IRR(values, [guess])', 'Returns the internal rate of return for a series of cash flows.', 1, 2, (args, ctx) => {
  const xs = numbers([args[0]], ctx);
  if (isErr(xs)) return xs;
  const g = args.length > 1 ? num(args[1], ctx) : 0.1;
  if (isErr(g)) return g;
  if (!xs.some((x) => x > 0) || !xs.some((x) => x < 0)) return ERR.num;
  return solve((r) => xs.reduce((s, x, i) => s + x / Math.pow(1 + r, i), 0), g);
});
function ipmtOf(r: number, per: number, n: number, pv: number, fv: number, t: number): number {
  const pmt = pmtOf(r, n, pv, fv, t);
  if (per === 1 && t) return 0;
  const ip = fvOf(r, per - 1, pmt, pv, t) * r;
  return t ? ip / (1 + r) : ip;
}
def('IPMT', 'Financial', 'IPMT(rate, per, nper, pv, [fv], [type])', 'Returns the interest payment for a given period for an investment, based on periodic, constant payments and a constant interest rate.', 4, 6, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, per, n, pv, fv, t] = v;
  if (per < 1 || per > n) return ERR.num;
  return fin(ipmtOf(r, per, n, pv, fv, t ? 1 : 0));
});
def('PPMT', 'Financial', 'PPMT(rate, per, nper, pv, [fv], [type])', 'Returns the payment on the principal for a given investment based on periodic, constant payments and a constant interest rate.', 4, 6, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ, REQ, 0, 0]);
  if (isErr(v)) return v;
  const [r, per, n, pv, fv, t] = v;
  if (per < 1 || per > n) return ERR.num;
  return fin(pmtOf(r, n, pv, fv, t ? 1 : 0) - ipmtOf(r, per, n, pv, fv, t ? 1 : 0));
});
def('SLN', 'Financial', 'SLN(cost, salvage, life)', 'Returns the straight-line depreciation of an asset for one period.', 3, 3, (args, ctx) => {
  const v = nums(args, ctx, [REQ, REQ, REQ]);
  if (isErr(v)) return v;
  return v[2] === 0 ? ERR.div0 : (v[0] - v[1]) / v[2];
});

for (const name of [
  'SUMPRODUCT', 'SUM', 'PRODUCT', 'SUMSQ', 'AVERAGE', 'AVERAGEA', 'MIN', 'MAX', 'MINA', 'MAXA', 'MEDIAN', 'MODE', 'MODE.SNGL',
  'STDEV', 'STDEV.S', 'STDEVP', 'STDEV.P', 'VAR', 'VAR.S', 'VARP', 'VAR.P', 'DEVSQ', 'AVEDEV', 'GEOMEAN', 'HARMEAN', 'LARGE',
  'SMALL', 'PERCENTILE', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE', 'QUARTILE.INC', 'COUNT', 'COUNTA', 'AND', 'OR', 'XOR',
  'CONCAT', 'TEXTJOIN', 'INDEX', 'MATCH', 'XMATCH', 'XLOOKUP', 'LOOKUP', 'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2', 'CORREL', 'NPV',
  'IRR', 'TRANSPOSE', 'UNIQUE', 'SORT', 'FILTER', 'ROWS', 'COLUMNS', 'GCD', 'LCM',
]) {
  FUNCTIONS[name].arrays = true;
}

/** Function names for autocomplete, alphabetically. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

/** A reference written for the formula a user is building (used by AutoSum). */
export const refText = (r0: number, c0: number, r1: number, c1: number) => (r0 === r1 && c0 === c1 ? cellName(r0, c0) : `${cellName(r0, c0)}:${cellName(r1, c1)}`);
