import { cellKey, keyCol, keyRow, MAX_COLS, MAX_ROWS } from './addr';
import { clip, grid, isArr, isRef, scalar, type ArrValue, type Ctx, type EvalHost, type EvalValue, type RefValue } from './evalCore';
import { functionsIn, parseFormula, type Node } from './formula';
import { FUNCTIONS } from './functions';
import { cellsIn, sheetExtent, type Workbook } from './model';
import { CellError, compare, err, ERR, isErr, toNum, toText, type Scalar } from './values';

/** Formula text → parse tree (or the reason it doesn't parse), shared by every cell with the same text. */
const parsed = new Map<string, Node | Error>();

export function parseCached(src: string): Node | Error {
  let p = parsed.get(src);
  if (p === undefined) {
    try {
      p = parseFormula(src);
    } catch (e) {
      p = e instanceof Error ? e : new Error(String(e));
    }
    if (parsed.size > 50000) parsed.clear();
    parsed.set(src, p);
  }
  return p;
}

const unknownCache = new WeakMap<Node, boolean>();

/** Whether a formula calls something this engine doesn't implement (it then keeps the file's value). */
export function callsUnknown(node: Node): boolean {
  let u = unknownCache.get(node);
  if (u === undefined) {
    u = [...functionsIn(node)].some((f) => !FUNCTIONS[f]);
    unknownCache.set(node, u);
  }
  return u;
}

// ---- Evaluating a tree -------------------------------------------------------------------------

function arith(op: string, a: Scalar, b: Scalar): Scalar {
  if (op === '&') {
    const x = toText(a);
    if (isErr(x)) return x;
    const y = toText(b);
    if (isErr(y)) return y;
    return x + y;
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    const d = compare(a, b);
    switch (op) {
      case '=': return d === 0;
      case '<>': return d !== 0;
      case '<': return d < 0;
      case '>': return d > 0;
      case '<=': return d <= 0;
      default: return d >= 0;
    }
  }
  const x = toNum(a);
  if (isErr(x)) return x;
  const y = toNum(b);
  if (isErr(y)) return y;
  let r: number;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/':
      if (y === 0) return ERR.div0;
      r = x / y;
      break;
    case '^':
      if (x === 0 && y === 0) return ERR.num;
      if (x === 0 && y < 0) return ERR.div0;
      r = Math.pow(x, y);
      break;
    default:
      return ERR.value;
  }
  return Number.isFinite(r) ? r : ERR.num;
}

/** Element by element over arrays (broadcasting single rows and columns), as array formulas do. */
function lift(a: EvalValue, b: EvalValue, ctx: Ctx, f: (x: Scalar, y: Scalar) => Scalar): EvalValue {
  const multi = (v: EvalValue) => (ctx.arrays && isRef(v) && (v.r0 !== v.r1 || v.c0 !== v.c1)) || isArr(v);
  if (!ctx.arrays) {
    if (isRef(a)) a = scalar(a, ctx);
    if (isRef(b)) b = scalar(b, ctx);
  }
  if (!multi(a) && !multi(b)) return f(scalar(a, ctx), scalar(b, ctx));
  const ga = isRef(a) ? refGrid(a, ctx) : grid(a, ctx);
  const gb = isRef(b) ? refGrid(b, ctx) : grid(b, ctx);
  const rows = Math.max(ga.length, gb.length);
  const cols = Math.max(ga[0]?.length ?? 0, gb[0]?.length ?? 0);
  const pick = (g: Scalar[][], r: number, c: number): Scalar | undefined => {
    const rr = g.length === 1 ? 0 : r;
    const cc = g[0]?.length === 1 ? 0 : c;
    return g[rr]?.[cc];
  };
  const out: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const x = pick(ga, r, c);
      const y = pick(gb, r, c);
      row.push(x === undefined || y === undefined ? ERR.na : f(x, y));
    }
    out.push(row);
  }
  return { kind: 'arr', rows: out };
}

/** A reference's full grid (not clipped: an array formula over A1:A10 means ten values). */
function refGrid(v: RefValue, ctx: Ctx): Scalar[][] {
  const big = (v.r1 - v.r0 + 1) * (v.c1 - v.c0 + 1) > 1_000_000;
  const g = big ? clip(v, ctx.host) : v;
  const rows: Scalar[][] = [];
  for (let r = g.r0; r <= g.r1; r++) {
    const row: Scalar[] = [];
    for (let c = g.c0; c <= g.c1; c++) row.push(ctx.host.value(g.sheet, r, c));
    rows.push(row);
  }
  return rows;
}

function mapValue(v: EvalValue, ctx: Ctx, f: (x: Scalar) => Scalar): EvalValue {
  if ((ctx.arrays && isRef(v) && (v.r0 !== v.r1 || v.c0 !== v.c1)) || isArr(v)) {
    const g = isRef(v) ? refGrid(v, ctx) : v.rows;
    return { kind: 'arr', rows: g.map((row) => row.map(f)) } satisfies ArrValue;
  }
  return f(scalar(v, ctx));
}

export function evaluate(node: Node, ctx: Ctx): EvalValue {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'str':
      return node.v;
    case 'bool':
      return node.v;
    case 'err':
      return err(node.v);
    case 'missing':
      return null;
    case 'ref': {
      const sheet = node.ref.sheet === null ? ctx.sheet : ctx.host.sheetIndex(node.ref.sheet);
      if (sheet < 0) return ERR.ref;
      const { r0, c0, r1, c1 } = node.ref;
      return { kind: 'ref', sheet, r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
    }
    case 'name': {
      const scope = node.sheet === null ? ctx.sheet : ctx.host.sheetIndex(node.sheet);
      const def = ctx.host.definedName(node.name, scope);
      if (!def) return ERR.name;
      return evaluate(def.node, { ...ctx, sheet: def.sheet });
    }
    case 'array':
      return { kind: 'arr', rows: node.rows.map((row) => row.map((n) => scalar(evaluate(n, ctx), ctx))) };
    case 'un': {
      const a = evaluate(node.a, ctx);
      if (node.op === '+') return isRef(a) && !ctx.arrays ? scalar(a, ctx) : a;
      return mapValue(a, ctx, (x) => {
        const n = toNum(x);
        if (isErr(n)) return n;
        return node.op === '-' ? -n : n / 100;
      });
    }
    case 'bin': {
      if (node.op === ':') {
        const a = evaluate(node.a, ctx);
        const b = evaluate(node.b, ctx);
        if (!isRef(a) || !isRef(b)) return isErr(a) ? a : isErr(b) ? b : ERR.value;
        if (a.sheet !== b.sheet) return ERR.value;
        return { kind: 'ref', sheet: a.sheet, r0: Math.min(a.r0, b.r0), c0: Math.min(a.c0, b.c0), r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1) };
      }
      const a = evaluate(node.a, ctx);
      const b = evaluate(node.b, ctx);
      return lift(a, b, ctx, (x, y) => arith(node.op, x, y));
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) return ERR.name;
      if (node.args.length < fn.min || node.args.length > fn.max) return ERR.value;
      if (fn.volatile) ctx.volatile = true;
      let inner = ctx;
      if (fn.arrays && !ctx.arrays) {
        const child: Ctx = { ...ctx, arrays: true, evaluate: (n) => evaluate(n, child) };
        inner = child;
      }
      if (fn.lazy) return fn.lazy(node.args, inner);
      const args = node.args.map((a) => evaluate(a, inner));
      return fn.fn!(args, inner);
    }
  }
}

/** A formula's result as a cell value. */
export function toCellValue(v: EvalValue, ctx: Ctx): Scalar {
  let s: Scalar;
  if (isRef(v)) s = ctx.host.value(v.sheet, v.r0, v.c0);
  else if (isArr(v)) s = v.rows[0]?.[0] ?? null;
  else s = v;
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) return ERR.num;
    if (Object.is(s, -0)) return 0;
  }
  // A formula pointing at an empty cell shows 0.
  if (s === null) return 0;
  return s;
}

// ---- The calculation engine ----------------------------------------------------------------------

/**
 * Calculates every formula in a workbook: each cell's precedents first
 * (walked with an explicit stack, so long chains don't overflow), cycles
 * caught and shown as 0 with a warning, Excel's way.
 */
export class Calc implements EvalHost {
  readonly date1904: boolean;
  private values: Map<number, Scalar>[];
  private computing: Set<number>[];
  private formulaKeys: number[][];
  readonly circular: { sheet: number; r: number; c: number }[] = [];
  private names = new Map<string, { node: Node; sheet: number } | null>();
  /** Cells found to depend on themselves: they show 0, as in Excel. */
  private inCycle = new Set<string>();

  constructor(readonly wb: Workbook) {
    this.date1904 = wb.date1904;
    this.values = wb.sheets.map(() => new Map());
    this.computing = wb.sheets.map(() => new Set());
    this.formulaKeys = wb.sheets.map((s) => {
      const keys: number[] = [];
      for (const [k, c] of s.cells) if (c.f !== undefined) keys.push(k);
      return keys.sort((a, b) => a - b);
    });
  }

  /** Calculate everything now (for saving, the status bar, and the circular reference warning). */
  all(): this {
    this.wb.sheets.forEach((s, i) => {
      for (const k of this.formulaKeys[i]) this.value(i, keyRow(k), keyCol(k));
    });
    return this;
  }

  sheetIndex(name: string): number {
    const n = name.toLowerCase();
    return this.wb.sheets.findIndex((s) => s.name.toLowerCase() === n);
  }

  sheetName(i: number): string {
    return this.wb.sheets[i]?.name ?? '';
  }

  sheetCount(): number {
    return this.wb.sheets.length;
  }

  extent(sheet: number) {
    const s = this.wb.sheets[sheet];
    return s ? sheetExtent(s) : { rows: -1, cols: -1 };
  }

  each(sheet: number, r0: number, c0: number, r1: number, c1: number, cb: (r: number, c: number, v: Scalar) => void): void {
    const s = this.wb.sheets[sheet];
    if (!s) return;
    cellsIn(s, { r0, c0, r1, c1 }, (r, c, cell) => {
      const v = cell.f !== undefined ? this.value(sheet, r, c) : cell.v;
      if (v !== null) cb(r, c, v);
    });
  }

  formulaText(sheet: number, r: number, c: number): string | null {
    const f = this.wb.sheets[sheet]?.cells.get(cellKey(r, c))?.f;
    return f === undefined ? null : `=${f}`;
  }

  definedName(name: string, sheet: number) {
    const key = `${sheet}:${name.toLowerCase()}`;
    if (this.names.has(key)) return this.names.get(key)!;
    const n = name.toLowerCase();
    const def = this.wb.names.find((d) => d.name.toLowerCase() === n && d.sheet === sheet) ?? this.wb.names.find((d) => d.name.toLowerCase() === n && d.sheet === null);
    let out: { node: Node; sheet: number } | null = null;
    if (def) {
      const p = parseCached(def.formula);
      if (!(p instanceof Error)) out = { node: p, sheet: def.sheet ?? sheet };
    }
    this.names.set(key, out);
    return out;
  }

  value(sheet: number, r: number, c: number): Scalar {
    const s = this.wb.sheets[sheet];
    if (!s) return ERR.ref;
    const k = cellKey(r, c);
    const cell = s.cells.get(k);
    if (!cell) return null;
    if (cell.f === undefined) return cell.v;
    const memo = this.values[sheet].get(k);
    if (memo !== undefined) return memo;
    if (this.computing[sheet].has(k)) {
      this.circular.push({ sheet, r, c });
      this.inCycle.add(`${sheet}:${k}`);
      return 0;
    }
    this.prepare(sheet, k);
    return this.compute(sheet, k, cell.f, cell.v);
  }

  /** Has this cell been calculated (so value() is cheap)? */
  private done(sheet: number, k: number): boolean {
    return this.values[sheet].has(k);
  }

  private compute(sheet: number, k: number, f: string, cached: Scalar): Scalar {
    const memo = this.values[sheet].get(k);
    if (memo !== undefined) return memo;
    const node = parseCached(f);
    let result: Scalar;
    if (node instanceof Error) result = cached ?? ERR.name;
    else if (callsUnknown(node)) result = cached ?? ERR.name;
    else {
      this.computing[sheet].add(k);
      const ctx: Ctx = { host: this, sheet, r: keyRow(k), c: keyCol(k), evaluate: (n) => evaluate(n, ctx), volatile: false, arrays: false };
      try {
        result = toCellValue(evaluate(node, ctx), ctx);
      } catch (e) {
        if (e instanceof RangeError) result = ERR.calc;
        else throw e;
      }
      this.computing[sheet].delete(k);
      if (this.inCycle.has(`${sheet}:${k}`)) result = 0;
    }
    this.values[sheet].set(k, result);
    return result;
  }

  /** Calculate the formulas a cell depends on (statically) before it, deepest first. */
  private prepare(sheet: number, k: number): void {
    const stack: [number, number, boolean][] = [[sheet, k, false]];
    const seen = new Set<string>();
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [s, key, expanded] = top;
      if (this.done(s, key)) {
        stack.pop();
        continue;
      }
      if (expanded) {
        stack.pop();
        if (s === sheet && key === k) continue;
        const cell = this.wb.sheets[s].cells.get(key);
        if (cell?.f !== undefined && !this.computing[s].has(key)) this.compute(s, key, cell.f, cell.v);
        continue;
      }
      top[2] = true;
      const id = `${s}:${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const cell = this.wb.sheets[s].cells.get(key);
      if (cell?.f === undefined) continue;
      const node = parseCached(cell.f);
      if (node instanceof Error) continue;
      this.precedents(node, s, (ps, pk) => {
        if (!this.done(ps, pk) && !seen.has(`${ps}:${pk}`)) stack.push([ps, pk, false]);
      });
    }
  }

  private precedents(node: Node, sheet: number, cb: (sheet: number, key: number) => void): void {
    const visit = (n: Node) => {
      switch (n.t) {
        case 'ref': {
          const s = n.ref.sheet === null ? sheet : this.sheetIndex(n.ref.sheet);
          if (s < 0) return;
          const r0 = Math.min(n.ref.r0, n.ref.r1);
          const r1 = Math.max(n.ref.r0, n.ref.r1);
          const c0 = Math.min(n.ref.c0, n.ref.c1);
          const c1 = Math.max(n.ref.c0, n.ref.c1);
          if (r0 === r1 && c0 === c1) {
            cb(s, cellKey(r0, c0));
            return;
          }
          const keys = this.formulaKeys[s];
          // Formula cells inside the range, found among the sheet's formulas.
          const lo = cellKey(r0, 0);
          const hi = cellKey(Math.min(r1, MAX_ROWS - 1), MAX_COLS - 1);
          let a = 0;
          let b = keys.length;
          while (a < b) {
            const m = (a + b) >> 1;
            if (keys[m] < lo) a = m + 1;
            else b = m;
          }
          for (let i = a; i < keys.length && keys[i] <= hi; i++) {
            const c = keyCol(keys[i]);
            if (c >= c0 && c <= c1) cb(s, keys[i]);
          }
          return;
        }
        case 'un':
          visit(n.a);
          return;
        case 'bin':
          visit(n.a);
          visit(n.b);
          return;
        case 'call':
          for (const a of n.args) visit(a);
          return;
        case 'name': {
          const def = this.definedName(n.name, n.sheet === null ? sheet : this.sheetIndex(n.sheet));
          if (def && def.node.t === 'ref') visit(def.node);
          return;
        }
      }
    };
    visit(node);
  }
}

/** Evaluate a formula typed somewhere that isn't a cell (Go To, Name Manager previews). */
export function evaluateText(calc: Calc, src: string, sheet: number): EvalValue | CellError {
  const node = parseCached(src);
  if (node instanceof Error) return ERR.name;
  const ctx: Ctx = { host: calc, sheet, r: 0, c: 0, evaluate: (n) => evaluate(n, ctx), volatile: false, arrays: false };
  return evaluate(node, ctx);
}
