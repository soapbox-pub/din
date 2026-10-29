import { colIndex, colName, MAX_COLS, MAX_ROWS, quoteSheet } from './addr';
import { isErrCode, type ErrCode } from './values';

/**
 * Formulas as text: a tokenizer that keeps every character (so formulas can
 * be rewritten in place: references shifted by a copy, rows inserted, a sheet
 * renamed), and a parser that builds the tree the evaluator walks, with
 * Excel's operator precedence.
 */

export interface RefTok {
  sheet: string | null;
  kind: 'cell' | 'area' | 'cols' | 'rows';
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  /** $ on each part. */
  ar0: boolean;
  ac0: boolean;
  ar1: boolean;
  ac1: boolean;
}

export type TokType = 'num' | 'str' | 'bool' | 'err' | 'ref' | 'name' | 'func' | 'op' | 'lparen' | 'rparen' | 'comma' | 'semi' | 'lbrace' | 'rbrace' | 'ws' | 'bad';

export interface Token {
  type: TokType;
  text: string;
  start: number;
  end: number;
  ref?: RefTok;
  /** A sheet prefix that names no sheet's cells: `Sheet1!#REF!`. */
}

const SHEET_PREFIX = /^(?:'((?:[^']|'')+)'|([A-Za-z_\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*))!/;
const CELL_AREA = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?/;
const COLS = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/;
const ROWS = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})/;
const NAME = /^[A-Za-z_\\\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*/;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const ERROR = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)/i;
const AFTER_REF = /^[\w.(\u00C0-\uFFFF]/;

function refAt(s: string, sheet: string | null): { ref: RefTok; len: number } | null {
  let m = CELL_AREA.exec(s);
  if (m && !AFTER_REF.test(s.slice(m[0].length)) && !(m[5] === undefined && s[m[0].length] === ':' && /^:\$?\d/.test(s.slice(m[0].length)))) {
    const c0 = colIndex(m[2]);
    const r0 = parseInt(m[4], 10) - 1;
    if (c0 < MAX_COLS && r0 >= 0 && r0 < MAX_ROWS) {
      if (m[6] === undefined) {
        return { ref: { sheet, kind: 'cell', r0, c0, r1: r0, c1: c0, ar0: !!m[3], ac0: !!m[1], ar1: !!m[3], ac1: !!m[1] }, len: m[0].length };
      }
      const c1 = colIndex(m[6]);
      const r1 = parseInt(m[8], 10) - 1;
      if (c1 < MAX_COLS && r1 >= 0 && r1 < MAX_ROWS) {
        return { ref: { sheet, kind: 'area', r0, c0, r1, c1, ar0: !!m[3], ac0: !!m[1], ar1: !!m[7], ac1: !!m[5] }, len: m[0].length };
      }
    }
  }
  m = COLS.exec(s);
  if (m && !AFTER_REF.test(s.slice(m[0].length))) {
    const c0 = colIndex(m[2]);
    const c1 = colIndex(m[4]);
    if (c0 < MAX_COLS && c1 < MAX_COLS) return { ref: { sheet, kind: 'cols', r0: 0, c0, r1: MAX_ROWS - 1, c1, ar0: true, ac0: !!m[1], ar1: true, ac1: !!m[3] }, len: m[0].length };
  }
  m = ROWS.exec(s);
  if (m && !AFTER_REF.test(s.slice(m[0].length))) {
    const r0 = parseInt(m[2], 10) - 1;
    const r1 = parseInt(m[4], 10) - 1;
    if (r0 >= 0 && r1 >= 0 && r0 < MAX_ROWS && r1 < MAX_ROWS) return { ref: { sheet, kind: 'rows', r0, c0: 0, r1, c1: MAX_COLS - 1, ar0: !!m[1], ac0: true, ar1: !!m[3], ac1: true }, len: m[0].length };
  }
  return null;
}

/** Split a formula (without its leading '=') into tokens that cover every character. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokType, len: number, ref?: RefTok) => {
    out.push({ type, text: src.slice(i, i + len), start: i, end: i + len, ref });
    i += len;
  };
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (/\s/.test(ch)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      push('ws', j - i);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      push(j < src.length ? 'str' : 'bad', Math.min(src.length, j + 1) - i);
      continue;
    }
    if (ch === '#') {
      const m = ERROR.exec(rest);
      if (m) push('err', m[0].length);
      else push('bad', 1);
      continue;
    }
    // A sheet-qualified reference: Sheet1!A1, 'My Sheet'!A1:B2, Sheet1!#REF!
    const sp = SHEET_PREFIX.exec(rest);
    if (sp) {
      const sheet = sp[1] !== undefined ? sp[1].replace(/''/g, "'") : sp[2];
      const after = rest.slice(sp[0].length);
      const r = refAt(after, sheet);
      if (r) {
        push('ref', sp[0].length + r.len, r.ref);
        continue;
      }
      const e = ERROR.exec(after);
      if (e) {
        push('err', sp[0].length + e[0].length);
        continue;
      }
      // A name scoped to a sheet (Sheet1!Total).
      const n = NAME.exec(after);
      if (n) {
        push('name', sp[0].length + n[0].length);
        continue;
      }
    }
    if (/[A-Za-z$\d]/.test(ch)) {
      const r = refAt(rest, null);
      if (r) {
        push('ref', r.len, r.ref);
        continue;
      }
    }
    if (/[\d.]/.test(ch)) {
      const m = NUMBER.exec(rest);
      if (m) {
        push('num', m[0].length);
        continue;
      }
    }
    const nm = NAME.exec(rest);
    if (nm) {
      const after = src[i + nm[0].length];
      if (after === '(') {
        push('func', nm[0].length);
        continue;
      }
      const u = nm[0].toUpperCase();
      push(u === 'TRUE' || u === 'FALSE' ? 'bool' : 'name', nm[0].length);
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      push('op', 2);
      continue;
    }
    if ('+-*/^&=<>%:'.includes(ch)) push('op', 1);
    else if (ch === '(') push('lparen', 1);
    else if (ch === ')') push('rparen', 1);
    else if (ch === ',') push('comma', 1);
    else if (ch === ';') push('semi', 1);
    else if (ch === '{') push('lbrace', 1);
    else if (ch === '}') push('rbrace', 1);
    else push('bad', 1);
  }
  return out;
}

// ---- Writing references -----------------------------------------------------------------

export function formatRef(ref: RefTok): string {
  const prefix = ref.sheet !== null ? `${quoteSheet(ref.sheet)}!` : '';
  const d = (b: boolean) => (b ? '$' : '');
  switch (ref.kind) {
    case 'cell':
      return `${prefix}${d(ref.ac0)}${colName(ref.c0)}${d(ref.ar0)}${ref.r0 + 1}`;
    case 'area':
      return `${prefix}${d(ref.ac0)}${colName(ref.c0)}${d(ref.ar0)}${ref.r0 + 1}:${d(ref.ac1)}${colName(ref.c1)}${d(ref.ar1)}${ref.r1 + 1}`;
    case 'cols':
      return `${prefix}${d(ref.ac0)}${colName(ref.c0)}:${d(ref.ac1)}${colName(ref.c1)}`;
    case 'rows':
      return `${prefix}${d(ref.ar0)}${ref.r0 + 1}:${d(ref.ar1)}${ref.r1 + 1}`;
  }
}

/** Rebuild a formula with some references replaced (by a new ref, or by #REF!). */
function rewrite(src: string, fn: (ref: RefTok, tok: Token) => RefTok | 'ref-error' | null): string {
  const toks = tokenize(src);
  let out = '';
  for (const t of toks) {
    if (t.type === 'ref' && t.ref) {
      const r = fn(t.ref, t);
      if (r === null) out += t.text;
      else if (r === 'ref-error') out += t.ref.sheet !== null ? `${quoteSheet(t.ref.sheet)}!#REF!` : '#REF!';
      else out += formatRef(r);
    } else out += t.text;
  }
  return out;
}

/** A formula copied from one cell to another: relative parts move by the offset. */
export function translateFormula(src: string, dr: number, dc: number): string {
  if (!dr && !dc) return src;
  return rewrite(src, (ref) => {
    const n = { ...ref };
    if (ref.kind !== 'cols') {
      if (!ref.ar0) n.r0 += dr;
      if (!ref.ar1) n.r1 += dr;
    }
    if (ref.kind !== 'rows') {
      if (!ref.ac0) n.c0 += dc;
      if (!ref.ac1) n.c1 += dc;
    }
    if (n.r0 < 0 || n.r1 < 0 || n.c0 < 0 || n.c1 < 0 || n.r0 >= MAX_ROWS || n.r1 >= MAX_ROWS || n.c0 >= MAX_COLS || n.c1 >= MAX_COLS) return 'ref-error';
    return n;
  });
}

/**
 * Rows or columns inserted (count > 0) or deleted (count < 0) at `at` on
 * `target`: references into it follow the cells they pointed at.
 */
export function shiftFormula(src: string, ownSheet: string, target: string, axis: 'row' | 'col', at: number, count: number): string {
  const same = (s: string | null) => (s ?? ownSheet).toLowerCase() === target.toLowerCase();
  return rewrite(src, (ref) => {
    if (!same(ref.sheet)) return null;
    if (axis === 'row' && ref.kind === 'cols') return null;
    if (axis === 'col' && ref.kind === 'rows') return null;
    const lo = axis === 'row' ? ref.r0 : ref.c0;
    const hi = axis === 'row' ? ref.r1 : ref.c1;
    let a = lo;
    let b = hi;
    if (count > 0) {
      if (a >= at) a += count;
      if (b >= at) b += count;
      const max = (axis === 'row' ? MAX_ROWS : MAX_COLS) - 1;
      if (a > max) return 'ref-error';
      b = Math.min(b, max);
    } else {
      const n = -count;
      const end = at + n - 1;
      if (a >= at && b <= end) return 'ref-error';
      const map = (i: number, isEnd: boolean) => (i < at ? i : i > end ? i - n : isEnd ? at - 1 : at);
      a = map(a, false);
      b = map(b, true);
      if (b < a) return 'ref-error';
    }
    if (a === lo && b === hi) return null;
    return axis === 'row' ? { ...ref, r0: a, r1: b } : { ...ref, c0: a, c1: b };
  });
}

/** A sheet renamed (to a new name) or deleted (to null). */
export function renameSheetInFormula(src: string, from: string, to: string | null): string {
  if (!src.includes('!')) return src;
  const toks = tokenize(src);
  let out = '';
  const f = from.toLowerCase();
  for (const t of toks) {
    if (t.type === 'ref' && t.ref?.sheet?.toLowerCase() === f) {
      out += to === null ? '#REF!' : formatRef({ ...t.ref, sheet: to });
    } else if ((t.type === 'name' || t.type === 'err') && t.text.includes('!')) {
      const sp = SHEET_PREFIX.exec(t.text);
      const name = sp ? (sp[1] !== undefined ? sp[1].replace(/''/g, "'") : sp[2]) : null;
      if (name?.toLowerCase() === f) out += to === null ? '#REF!' : `${quoteSheet(to)}!${t.text.slice(sp![0].length)}`;
      else out += t.text;
    } else out += t.text;
  }
  return out;
}

/** F4: cycle the reference at the caret through $A$1, A$1, $A1, A1. */
export function cycleAbsolute(src: string, caret: number): { text: string; start: number; end: number } | null {
  // `src` is the whole edit text, starting with '='.
  const body = src.slice(1);
  const toks = tokenize(body);
  const pos = caret - 1;
  const t = toks.find((k) => k.type === 'ref' && pos >= k.start && pos <= k.end);
  if (!t || !t.ref) return null;
  const r = t.ref;
  const state = r.ar0 && r.ac0 ? 0 : r.ar0 ? 1 : r.ac0 ? 2 : 3;
  const next = (state + 1) % 4;
  const ar = next === 0 || next === 1;
  const ac = next === 0 || next === 2;
  const n: RefTok = { ...r, ar0: r.kind === 'cols' ? r.ar0 : ar, ar1: r.kind === 'cols' ? r.ar1 : ar, ac0: r.kind === 'rows' ? r.ac0 : ac, ac1: r.kind === 'rows' ? r.ac1 : ac };
  if (r.kind === 'cols' || r.kind === 'rows') {
    const on = !(r.kind === 'cols' ? r.ac0 : r.ar0);
    if (r.kind === 'cols') Object.assign(n, { ac0: on, ac1: on });
    else Object.assign(n, { ar0: on, ar1: on });
  }
  const text = formatRef(n);
  return { text: `=${body.slice(0, t.start)}${text}${body.slice(t.end)}`, start: t.start + 1, end: t.start + 1 + text.length };
}

/** Every reference in an edit text ('=...'), with where it sits, for coloring. */
export function refSpans(src: string): { start: number; end: number; ref: RefTok }[] {
  if (!src.startsWith('=')) return [];
  return tokenize(src.slice(1))
    .filter((t) => t.type === 'ref' && t.ref)
    .map((t) => ({ start: t.start + 1, end: t.end + 1, ref: t.ref! }));
}

/** Whether a reference can be pointed at with the mouse/arrows at this caret: after an operator, '(', ',' or '='. */
export function canInsertRef(src: string, caret: number): boolean {
  if (!src.startsWith('=') || caret < 1) return false;
  const before = src.slice(1, caret).replace(/\s+$/, '');
  if (!before) return true;
  const last = before[before.length - 1];
  return '+-*/^&=<>(,:;%'.includes(last) && !(last === '%' && before.length > 0);
}

// ---- Parsing ---------------------------------------------------------------------------------

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrCode }
  | { t: 'ref'; ref: RefTok }
  | { t: 'name'; name: string; sheet: string | null }
  | { t: 'un'; op: '-' | '+' | '%'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'array'; rows: Node[][] }
  | { t: 'missing' };

export class ParseError extends Error {}

/** Names the files store with a prefix (_xlfn.XLOOKUP) that Excel shows without one. */
export function stripPrefixes(src: string): string {
  return src.replace(/_xlfn\.(?:_xlws\.)?|_xlws\.|_xludf\./gi, '');
}

export function parseFormula(src: string): Node {
  const toks = tokenize(src).filter((t) => t.type !== 'ws');
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const isOp = (...ops: string[]) => peek()?.type === 'op' && ops.includes(peek().text);
  const expect = (type: TokType) => {
    const t = next();
    if (!t || t.type !== type) throw new ParseError(`Expected ${type}`);
    return t;
  };

  const primary = (): Node => {
    const t = next();
    if (!t) throw new ParseError('Unexpected end');
    switch (t.type) {
      case 'num':
        return { t: 'num', v: parseFloat(t.text) };
      case 'str':
        return { t: 'str', v: t.text.slice(1, -1).replace(/""/g, '"') };
      case 'bool':
        return { t: 'bool', v: t.text.toUpperCase() === 'TRUE' };
      case 'err': {
        const code = t.text.slice(t.text.indexOf('#')).toUpperCase();
        return { t: 'err', v: isErrCode(code) ? (code as ErrCode) : '#REF!' };
      }
      case 'ref':
        return { t: 'ref', ref: t.ref! };
      case 'name': {
        const bang = t.text.lastIndexOf('!');
        if (bang > 0) {
          const sp = SHEET_PREFIX.exec(t.text);
          const sheet = sp ? (sp[1] !== undefined ? sp[1].replace(/''/g, "'") : sp[2]) : null;
          return { t: 'name', name: t.text.slice(bang + 1), sheet };
        }
        return { t: 'name', name: t.text, sheet: null };
      }
      case 'func': {
        const name = stripPrefixes(t.text).toUpperCase();
        expect('lparen');
        const args: Node[] = [];
        if (peek()?.type === 'rparen') {
          next();
          return { t: 'call', name, args };
        }
        for (;;) {
          if (peek()?.type === 'comma' || peek()?.type === 'rparen') args.push({ t: 'missing' });
          else args.push(expr());
          const sep = next();
          if (!sep) throw new ParseError('Missing )');
          if (sep.type === 'rparen') break;
          if (sep.type !== 'comma') throw new ParseError('Expected , or )');
        }
        return { t: 'call', name, args };
      }
      case 'lparen': {
        const e = expr();
        expect('rparen');
        return e;
      }
      case 'lbrace': {
        const rows: Node[][] = [[]];
        for (;;) {
          let neg = false;
          if (isOp('-')) {
            next();
            neg = true;
          }
          const v = primary();
          rows[rows.length - 1].push(neg && v.t === 'num' ? { t: 'num', v: -v.v } : v);
          const sep = next();
          if (!sep) throw new ParseError('Missing }');
          if (sep.type === 'rbrace') break;
          if (sep.type === 'semi') rows.push([]);
          else if (sep.type !== 'comma') throw new ParseError('Bad array');
        }
        return { t: 'array', rows };
      }
      case 'op':
        if (t.text === '-' || t.text === '+') return { t: 'un', op: t.text, a: unary() };
        break;
    }
    throw new ParseError(`Unexpected ${t.text}`);
  };

  const range = (): Node => {
    let a = primary();
    while (isOp(':')) {
      next();
      a = { t: 'bin', op: ':', a, b: primary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-', '+')) {
      const op = next().text as '-' | '+';
      return { t: 'un', op, a: unary() };
    }
    return range();
  };
  const percent = (): Node => {
    let a = unary();
    while (isOp('%')) {
      next();
      a = { t: 'un', op: '%', a };
    }
    return a;
  };
  const binary = (sub: () => Node, ops: string[]) => (): Node => {
    let a = sub();
    while (isOp(...ops)) {
      const op = next().text;
      a = { t: 'bin', op, a, b: sub() };
    }
    return a;
  };
  const pow = binary(percent, ['^']);
  const mul = binary(pow, ['*', '/']);
  const add = binary(mul, ['+', '-']);
  const concat = binary(add, ['&']);
  const cmp = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  function expr(): Node {
    return cmp();
  }

  if (toks.some((t) => t.type === 'bad')) throw new ParseError('Bad character');
  const root = expr();
  if (i < toks.length) throw new ParseError(`Unexpected ${toks[i].text}`);
  return root;
}

/** Every function a formula calls. */
export function functionsIn(node: Node, out = new Set<string>()): Set<string> {
  switch (node.t) {
    case 'call':
      out.add(node.name);
      for (const a of node.args) functionsIn(a, out);
      break;
    case 'un':
      functionsIn(node.a, out);
      break;
    case 'bin':
      functionsIn(node.a, out);
      functionsIn(node.b, out);
      break;
    case 'array':
      for (const r of node.rows) for (const a of r) functionsIn(a, out);
      break;
  }
  return out;
}

/** Functions newer than Excel 2007, which files store with a _xlfn. prefix. */
const XLFN = new Set([
  'XLOOKUP', 'XMATCH', 'IFS', 'SWITCH', 'CONCAT', 'TEXTJOIN', 'MAXIFS', 'MINIFS', 'IFNA', 'DAYS', 'STDEV.S', 'STDEV.P',
  'VAR.S', 'VAR.P', 'MODE.SNGL', 'MODE.MULT', 'RANK.EQ', 'RANK.AVG', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC',
  'QUARTILE.EXC', 'CEILING.MATH', 'FLOOR.MATH', 'ISOWEEKNUM', 'XOR', 'UNIQUE', 'SORT', 'SORTBY', 'FILTER', 'SEQUENCE',
  'RANDARRAY', 'LET', 'NORM.DIST', 'NORM.S.DIST', 'NORM.INV', 'NORM.S.INV', 'T.TEST', 'CHISQ.TEST', 'COVARIANCE.P',
  'COVARIANCE.S', 'SHEET', 'SHEETS', 'FORMULATEXT', 'ARABIC', 'BASE', 'DECIMAL', 'NUMBERVALUE', 'UNICHAR', 'UNICODE',
  'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'CHOOSECOLS', 'CHOOSEROWS', 'TOCOL', 'TOROW',
]);
const XLWS = new Set(['SORT', 'FILTER', 'SORTBY']);

/** Add the _xlfn. prefixes back for saving. */
export function addPrefixes(src: string): string {
  const toks = tokenize(src);
  let out = '';
  for (const t of toks) {
    const u = t.text.toUpperCase();
    if (t.type === 'func' && XLFN.has(u)) out += `_xlfn.${XLWS.has(u) ? '_xlws.' : ''}${t.text}`;
    else out += t.text;
  }
  return out;
}
