/**
 * The Calculator's expression language: what a TI-89 accepts on its entry
 * line (→ to store, | for "with", ∫ and d( for calculus, {lists},
 * [matrices;rows], implied multiplication), plus everything giac prints back
 * (list[...], (x)->..., 3.2_m). One parser serves three readers: the
 * translation to giac (toGiac.ts), pretty printing (latex.ts) and graphing
 * (compile.ts).
 */

export type BinOp =
  | '+' | '-' | '*' | '/' | '^'
  | '=' | '≠' | '<' | '>' | '≤' | '≥'
  | 'and' | 'or' | 'xor'
  | '..' | '|' | '→' | ':=' | '▶' | '->';

export type ListKind = 'brace' | 'bracket' | 'list' | 'seq' | 'set' | 'matrix' | 'poly1' | 'tuple';

export type Node =
  | { t: 'num'; v: string }
  | { t: 'id'; name: string }
  | { t: 'str'; v: string }
  | { t: 'unit'; v: string }
  | { t: 'call'; f: string; args: Node[] }
  | { t: 'bin'; op: BinOp; a: Node; b: Node; implicit?: boolean }
  | { t: 'neg'; a: Node }
  | { t: 'not'; a: Node }
  | { t: 'post'; op: '!' | '°' | 'ᵀ' | "'"; a: Node; n?: number }
  | { t: 'list'; kind: ListKind; items: Node[] }
  | { t: 'index'; a: Node; idx: Node[] }
  | { t: 'paren'; a: Node }
  | { t: 'define'; lhs: Node; rhs: Node }
  | { t: 'cmd'; name: string; args: Node[] };

export class ParseError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

type Tok =
  | { k: 'num'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'unit'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'eof'; pos: number };

/** Names a TI-89 or giac knows as functions, lowercase. */
export const FUNCTION_NAMES = new Set([
  'abs', 'acos', 'acosh', 'acot', 'acsc', 'angle', 'ans', 'approx', 'arccos', 'arcsin', 'arctan', 'arclen',
  'arg', 'asec', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'augment', 'avgrc', 'binomial', 'ceil', 'ceiling',
  'cfactor', 'comb', 'comdenom', 'conj', 'convert', 'cos', 'cosh', 'cot', 'coth', 'crossp', 'cross', 'csc',
  'csolve', 'cumsum', 'czeros', 'd', 'denom', 'desolve', 'det', 'diag', 'diff', 'dim', 'dotp', 'dot',
  'eigenvals', 'eigenvects', 'eigvc', 'eigvl', 'entry', 'evalf', 'exact', 'exp', 'expand', 'factor', 'factorial',
  'fmax', 'fmin', 'floor', 'fpart', 'fsolve', 'gamma', 'gcd', 'getdenom', 'getnum', 'identity', 'idn', 'ifactor',
  'im', 'imag', 'int', 'integrate', 'inv', 'ipart', 'isprime', 'lcm', 'left', 'limit', 'ln', 'log', 'log10',
  'logb', 'max', 'mean', 'median', 'mid', 'min', 'mod', 'ncr', 'nderiv', 'nint', 'norm', 'normal', 'npr',
  'nsolve', 'numer', 'partfrac', 'perm', 'piecewise', 'product', 'propfrac', 'rand', 'randint', 'randnorm',
  'randpoly', 're', 'real', 'ref', 'remain', 'right', 'root', 'round', 'rref', 'sec', 'sech', 'seq', 'sign',
  'simplify', 'sin', 'sinh', 'solve', 'sort', 'sorta', 'sortd', 'sqrt', 'stddev', 'stddevp', 'string', 'subst',
  'sum', 'surd', 'tan', 'tanh', 'taylor', 'tcollect', 'texpand', 'transpose', 'unitv', 'variance', 'when',
  'zeros', 'irem', 'iquo', 'quo', 'rem', 'lcoeff', 'degree', 'coeff', 'coeffs', 'tran', 'trace', 'rank',
  'kernel', 'lu', 'qr', 'jordan', 'charpoly', 'pcoeff', 'proot', 'series', 'laplace', 'ilaplace', 'fourier',
  'linsolve', 'fsum', 'cumprod', 'count', 'quartiles', 'quantile', 'correlation', 'covariance',
  'linear_regression', 'exponential_regression', 'logarithmic_regression', 'power_regression',
  'polynomial_regression', 'normald', 'normald_cdf', 'normald_icdf', 'binomial_cdf', 'binomial_icdf',
  'poisson', 'poisson_cdf', 'studentd', 'studentd_cdf', 'chisquared_cdf', 'tcdf', 'normcdf', 'invnorm',
  'binompdf', 'binomcdf', 'normpdf', 'unapply', 'purge', 'resultant', 'rationalroot', 'crationalroot',
  'tlin', 'tsimplify', 'trigcos', 'trigsin', 'trigtan', 'halftan', 'lnexpand', 'lncollect', 'exp2pow',
  'pow2exp', 'factors', 'divisors', 'idivis', 'nextprime', 'prevprime', 'euler', 'powmod', 'iegcd', 'egcd',
  'collect', 'horner', 'canonical_form', 'tangent', 'curl', 'divergence', 'grad', 'hessian', 'jacobian',
  'potential', 'sto', 'hypot', 'cbrt', 'nroot', 'intersect',
]);

/** Names that are values, never functions: `e(x)` means e·x. */
const CONSTANT_NAMES = new Set(['pi', 'e', 'i', 'inf', 'infinity', 'undef', 'true', 'false', 'θ']);

/** Single letters that are usually functions in homework: f(x), y(0)=1. */
const FUNCTION_LETTERS = new Set(['f', 'g', 'h', 'y']);

const TYPED_LISTS = new Set(['list', 'seq', 'set', 'matrix', 'poly1', 'vector']);

const SUPERSCRIPT_DIGITS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

const LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF]/;
const WORD = /[A-Za-z0-9_\u00C0-\u024F\u0370-\u03FF]/;

/** Unicode the keypad and catalog insert, folded to one spelling. */
const CHAR_MAP: Record<string, string> = {
  '−': '-', '‐': '-', '–': '-', '×': '*', '·': '*', '∙': '*', '÷': '/', '≤': '<=', '≥': '>=', '≠': '!=',
  'π': 'pi', 'ℯ': 'e', '∞': 'inf', '𝑖': 'i', '∑': 'Σ', '∏': 'Π', '⁄': '/',
};

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const pos = i;
    const mapped = CHAR_MAP[ch];
    if (mapped !== undefined) {
      i++;
      if (/^[A-Za-zΣΠ]/.test(mapped)) toks.push({ k: 'id', v: mapped, pos });
      else pushOps(toks, mapped, pos);
      continue;
    }
    // Numbers, with E/ᴇ exponents. `2e^x` is 2·e^x, `2e5` is 200000.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9]/.test(source[j])) j++;
      if (source[j] === '.' && source[j + 1] !== '.') {
        j++;
        while (j < n && /[0-9]/.test(source[j])) j++;
      }
      const e = source[j];
      if (e === 'e' || e === 'E' || e === 'ᴇ') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-' || source[k] === '−') k++;
        if (/[0-9]/.test(source[k] ?? '')) {
          while (k < n && /[0-9]/.test(source[k])) k++;
          toks.push({ k: 'num', v: source.slice(i, j) + 'e' + source.slice(j + 1, k).replace('−', '-'), pos });
          i = k;
          continue;
        }
      }
      toks.push({ k: 'num', v: source.slice(i, j), pos });
      i = j;
      continue;
    }
    if (ch === 'ᴇ') {
      // A bare exponent marker (1ᴇ5 is handled above): ᴇ5 alone means 10^5.
      let k = i + 1;
      if (source[k] === '-' || source[k] === '−') k++;
      const start = k;
      while (k < n && /[0-9]/.test(source[k])) k++;
      if (k === start) throw new ParseError('Expected an exponent after ᴇ', pos);
      toks.push({ k: 'num', v: `1e${source.slice(i + 1, k).replace('−', '-')}`, pos });
      i = k;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < n) {
        if (source[j] === '"' && source[j + 1] === '"') {
          text += '"';
          j += 2;
        } else if (source[j] === '\\' && source[j + 1] === '"') {
          text += '"';
          j += 2;
        } else if (source[j] === '"') {
          break;
        } else {
          text += source[j++];
        }
      }
      if (j >= n) throw new ParseError('Unterminated string', pos);
      toks.push({ k: 'str', v: text, pos });
      i = j + 1;
      continue;
    }
    // Units: _m, _km, _(m*s), _°C.
    if (ch === '_') {
      let j = i + 1;
      if (source[j] === '(') {
        let depth = 0;
        for (; j < n; j++) {
          if (source[j] === '(') depth++;
          else if (source[j] === ')' && --depth === 0) break;
        }
        j++;
      } else {
        while (j < n && (WORD.test(source[j]) || source[j] === '°' || source[j] === 'µ' || source[j] === 'Ω')) j++;
      }
      if (j === i + 1) throw new ParseError('Expected a unit after _', pos);
      toks.push({ k: 'unit', v: source.slice(i + 1, j), pos });
      i = j;
      continue;
    }
    if (LETTER.test(ch)) {
      let j = i + 1;
      while (j < n && WORD.test(source[j])) j++;
      let word = source.slice(i, j);
      // sin⁻¹( is asin(.
      if (source.startsWith('⁻¹', j) && /^(sin|cos|tan|sinh|cosh|tanh|sec|csc|cot)$/i.test(word)) {
        word = 'a' + word.toLowerCase();
        j += 2;
      }
      if (TYPED_LISTS.has(word) && source[j] === '[') {
        toks.push({ k: 'op', v: `${word}[`, pos });
        i = j + 1;
        continue;
      }
      toks.push({ k: 'id', v: word, pos });
      i = j;
      continue;
    }
    if (ch === '∫' || ch === 'Σ' || ch === 'Π' || ch === '∂') {
      toks.push({ k: 'id', v: ch === '∂' ? 'd' : ch, pos });
      i++;
      continue;
    }
    if (ch === '⁻' && source[i + 1] === '¹') {
      pushOps(toks, '^', pos);
      toks.push({ k: 'num', v: '-1', pos });
      i += 2;
      continue;
    }
    if (SUPERSCRIPT_DIGITS[ch]) {
      let j = i;
      let digits = '';
      while (j < n && SUPERSCRIPT_DIGITS[source[j]]) digits += SUPERSCRIPT_DIGITS[source[j++]];
      pushOps(toks, '^', pos);
      toks.push({ k: 'num', v: digits, pos });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if ([':=', '<=', '>=', '!=', '==', '->', '=>', '..', '&&', '||', '<>'].includes(two)) {
      pushOps(toks, two, pos);
      i += 2;
      continue;
    }
    if ('+-*/^()[]{},;=<>!|\'°ᵀ→▶√%:@$?∠'.includes(ch)) {
      toks.push({ k: 'op', v: ch, pos });
      i++;
      continue;
    }
    throw new ParseError(`Unexpected “${ch}”`, pos);
  }
  toks.push({ k: 'eof', pos: n });
  return toks;
}

function pushOps(toks: Tok[], text: string, pos: number) {
  const normalized: Record<string, string> = { '<=': '≤', '>=': '≥', '!=': '≠', '<>': '≠', '==': '=', '&&': 'and', '||': 'or' };
  const v = normalized[text] ?? text;
  if (v === 'and' || v === 'or') toks.push({ k: 'id', v, pos });
  else toks.push({ k: 'op', v, pos });
}

export interface ParseOptions {
  /** Parsing giac's output: every name( is a call, and -> is a function. */
  giac?: boolean;
  /** Functions the user defined, so f(x) isn't read as f·x. */
  userFunctions?: ReadonlySet<string>;
}

const KEYWORDS = new Set(['and', 'or', 'xor', 'not']);

class Parser {
  private i = 0;

  constructor(private readonly toks: Tok[], private readonly opts: ParseOptions) {}

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }

  private next(): Tok {
    return this.toks[this.i++];
  }

  private isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.k === 'op' && t.v === v;
  }

  private isWord(v: string): boolean {
    const t = this.peek();
    return t.k === 'id' && t.v === v;
  }

  private expect(v: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) {
      throw new ParseError(t.k === 'eof' ? `Missing “${v}”` : `Expected “${v}”`, t.pos);
    }
  }

  parseStatement(): Node {
    const t = this.peek();
    if (t.k === 'id' && /^define$/i.test(t.v)) {
      this.next();
      const body = this.parseStore();
      if (body.t === 'bin' && (body.op === '=' || body.op === ':=')) return { t: 'define', lhs: body.a, rhs: body.b };
      throw new ParseError('Define needs name(args) = expression', t.pos);
    }
    if (t.k === 'id' && /^(delvar|newprob|clrhome)$/i.test(t.v)) {
      this.next();
      const args: Node[] = [];
      while (this.peek().k !== 'eof') {
        args.push(this.parseStore());
        if (this.isOp(',')) this.next();
      }
      return { t: 'cmd', name: t.v.toLowerCase(), args };
    }
    const node = this.parseStore();
    return node;
  }

  parseAll(): Node {
    let node = this.parseStatement();
    // giac prints sequences bare: eigenvals gives `2,3`.
    if (this.opts.giac && this.isOp(',')) {
      const items = [node];
      while (this.isOp(',')) {
        this.next();
        items.push(this.parseStore());
      }
      node = { t: 'list', kind: 'seq', items };
    }
    const t = this.peek();
    if (t.k !== 'eof') {
      if (t.k === 'op' && t.v === ')') throw new ParseError('Too many “)”', t.pos);
      throw new ParseError(`Unexpected “${tokText(t)}”`, t.pos);
    }
    return node;
  }

  private parseStore(): Node {
    let node = this.parseWith();
    // giac prints when(c,a,b) as ((c)? a : b).
    if (this.opts.giac && this.isOp('?')) {
      this.next();
      const yes = this.parseStore();
      this.expect(':');
      const no = this.parseStore();
      return { t: 'call', f: 'when', args: [node, yes, no] };
    }
    for (;;) {
      if (this.isOp('→') || this.isOp('=>') || (!this.opts.giac && this.isOp('->'))) {
        this.next();
        node = { t: 'bin', op: '→', a: node, b: this.parseWith() };
      } else if (this.isOp('▶')) {
        this.next();
        node = { t: 'bin', op: '▶', a: node, b: this.parseWith() };
      } else if (this.isOp(':=')) {
        this.next();
        return { t: 'bin', op: ':=', a: node, b: this.parseStore() };
      } else if (this.opts.giac && this.isOp('->')) {
        this.next();
        return { t: 'bin', op: '->', a: node, b: this.parseStore() };
      } else {
        return node;
      }
    }
  }

  private parseWith(): Node {
    let node = this.parseOr();
    while (this.isOp('|')) {
      this.next();
      node = { t: 'bin', op: '|', a: node, b: this.parseOr() };
    }
    return node;
  }

  private parseOr(): Node {
    let node = this.parseAnd();
    while (this.isWord('or') || this.isWord('xor')) {
      const op = this.isWord('xor') ? 'xor' : 'or';
      this.next();
      node = { t: 'bin', op, a: node, b: this.parseAnd() };
    }
    return node;
  }

  private parseAnd(): Node {
    let node = this.parseNot();
    while (this.isWord('and')) {
      this.next();
      node = { t: 'bin', op: 'and', a: node, b: this.parseNot() };
    }
    return node;
  }

  private parseNot(): Node {
    if (this.isWord('not')) {
      this.next();
      return { t: 'not', a: this.parseNot() };
    }
    return this.parseRel();
  }

  private relOp(): BinOp | undefined {
    const t = this.peek();
    if (t.k !== 'op') return undefined;
    return (['=', '≠', '<', '>', '≤', '≥'] as const).find((op) => op === t.v);
  }

  private parseRel(): Node {
    const a = this.parseRange();
    const op = this.relOp();
    if (!op) return a;
    this.next();
    const b = this.parseRange();
    const op2 = this.relOp();
    if (!op2) return { t: 'bin', op, a, b };
    // a < x < b
    this.next();
    const c = this.parseRange();
    return { t: 'bin', op: 'and', a: { t: 'bin', op, a, b }, b: { t: 'bin', op: op2, a: b, b: c } };
  }

  private parseRange(): Node {
    const a = this.parseAdd();
    if (this.isOp('..')) {
      this.next();
      return { t: 'bin', op: '..', a, b: this.parseAdd() };
    }
    return a;
  }

  private parseAdd(): Node {
    let node = this.parseMul();
    for (;;) {
      if (this.isOp('+') || this.isOp('-')) {
        const op = (this.next() as { v: string }).v as '+' | '-';
        node = { t: 'bin', op, a: node, b: this.parseMul() };
      } else {
        return node;
      }
    }
  }

  private startsFactor(): boolean {
    const t = this.peek();
    switch (t.k) {
      case 'num':
      case 'unit':
      case 'str':
        return true;
      case 'id':
        return !KEYWORDS.has(t.v) && !/^(mod)$/.test(t.v);
      case 'op':
        return t.v === '(' || t.v === '{' || t.v === '√' || (t.v.endsWith('[') && t.v.length > 1);
      default:
        return false;
    }
  }

  private parseMul(): Node {
    let node = this.parseUnary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.next() as { v: string }).v as '*' | '/';
        node = { t: 'bin', op, a: node, b: this.parseUnary() };
      } else if (this.isOp('%') && this.opts.giac) {
        // giac prints `2 % 5` for 2 mod 5.
        this.next();
        node = { t: 'call', f: 'mod', args: [node, this.parseUnary()] };
      } else if (this.isOp('∠')) {
        // Polar form: (2∠π/3)
        this.next();
        node = { t: 'call', f: '∠', args: [node, this.parseUnary()] };
      } else if (this.isWord('mod')) {
        this.next();
        node = { t: 'call', f: 'mod', args: [node, this.parseUnary()] };
      } else if (this.startsFactor()) {
        node = { t: 'bin', op: '*', a: node, b: this.parsePower(), implicit: true };
      } else {
        return node;
      }
    }
  }

  private parseUnary(): Node {
    if (this.isOp('-')) {
      this.next();
      return { t: 'neg', a: this.parseUnary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      let exponent: Node;
      if (this.isOp('-')) {
        this.next();
        exponent = { t: 'neg', a: this.parsePowerOperand() };
      } else if (this.isOp('+')) {
        this.next();
        exponent = this.parsePowerOperand();
      } else {
        exponent = this.parsePowerOperand();
      }
      return { t: 'bin', op: '^', a: base, b: exponent };
    }
    return base;
  }

  /** The right side of ^: right-associative, so 2^3^2 is 2^9. */
  private parsePowerOperand(): Node {
    return this.parsePower();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isOp('!')) {
        this.next();
        node = { t: 'post', op: '!', a: node };
      } else if (this.isOp("'")) {
        let n = 0;
        while (this.isOp("'")) {
          this.next();
          n++;
        }
        node = { t: 'post', op: "'", a: node, n };
        // y'(0) = 1
        if (this.isOp('(') && node.a.t === 'id') {
          this.next();
          node = { t: 'call', f: node.a.name + "'".repeat(n), args: this.parseArgs(')') };
        }
      } else if (this.isOp('°')) {
        this.next();
        node = { t: 'post', op: '°', a: node };
      } else if (this.isOp('ᵀ')) {
        this.next();
        node = { t: 'post', op: 'ᵀ', a: node };
      } else if (this.isOp('[') && node.t !== 'num') {
        this.next();
        node = { t: 'index', a: node, idx: this.parseArgs(']') };
      } else {
        return node;
      }
    }
  }

  private parseArgs(close: string): Node[] {
    const args: Node[] = [];
    if (this.isOp(close)) {
      this.next();
      return args;
    }
    for (;;) {
      args.push(this.parseStore());
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.peek().k === 'eof') return args; // forgive missing ) at the end, like a TI-89
      this.expect(close);
      return args;
    }
  }

  private isCall(name: string): boolean {
    if (this.opts.giac) return true;
    if (CONSTANT_NAMES.has(name)) return false;
    if (this.opts.userFunctions?.has(name)) return true;
    if (FUNCTION_NAMES.has(name.toLowerCase())) return true;
    if (name === '∫' || name === 'Σ' || name === 'Π') return true;
    return name.length > 1 || FUNCTION_LETTERS.has(name);
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v };
      case 'str':
        return { t: 'str', v: t.v };
      case 'unit':
        return { t: 'unit', v: t.v };
      case 'id': {
        if (KEYWORDS.has(t.v)) throw new ParseError(`Unexpected “${t.v}”`, t.pos);
        if (this.isOp('(') && this.isCall(t.v)) {
          this.next();
          return { t: 'call', f: t.v, args: this.parseArgs(')') };
        }
        return { t: 'id', name: t.v };
      }
      case 'op': {
        if (t.v === '(') {
          if (this.isOp(')')) {
            this.next();
            return { t: 'list', kind: 'tuple', items: [] };
          }
          const first = this.parseStore();
          if (this.isOp(',')) {
            const items = [first];
            while (this.isOp(',')) {
              this.next();
              items.push(this.parseStore());
            }
            if (this.peek().k !== 'eof') this.expect(')');
            return { t: 'list', kind: 'tuple', items };
          }
          if (this.peek().k !== 'eof') this.expect(')');
          return { t: 'paren', a: first };
        }
        if (t.v === '{') return { t: 'list', kind: 'brace', items: this.parseArgs('}') };
        if (t.v === '[') return this.parseBracket('bracket');
        if (t.v.endsWith('[') && t.v.length > 1) {
          const word = t.v.slice(0, -1);
          const kind: ListKind = word === 'vector' ? 'bracket' : (word as ListKind);
          return this.parseBracket(kind);
        }
        if (t.v === '√') {
          if (this.isOp('(')) {
            this.next();
            return { t: 'call', f: 'sqrt', args: this.parseArgs(')') };
          }
          return { t: 'call', f: 'sqrt', args: [this.parsePostfix()] };
        }
        if (t.v === '-') return { t: 'neg', a: this.parseUnary() };
        throw new ParseError(`Unexpected “${t.v}”`, t.pos);
      }
      case 'eof':
        throw new ParseError('Incomplete expression', t.pos);
    }
  }

  /** [a,b,c], [[1,2],[3,4]] or TI rows: [1,2;3,4]. */
  private parseBracket(kind: ListKind): Node {
    const rows: Node[][] = [[]];
    if (this.isOp(']')) {
      this.next();
      return { t: 'list', kind, items: [] };
    }
    for (;;) {
      rows[rows.length - 1].push(this.parseStore());
      if (this.isOp(',')) {
        this.next();
      } else if (this.isOp(';')) {
        this.next();
        rows.push([]);
      } else {
        if (this.peek().k !== 'eof') this.expect(']');
        break;
      }
    }
    if (rows.length === 1) return { t: 'list', kind, items: rows[0] };
    return {
      t: 'list',
      kind: kind === 'bracket' ? 'matrix' : kind,
      items: rows.map((items) => ({ t: 'list', kind: 'bracket', items }) as Node),
    };
  }
}

function tokText(t: Tok): string {
  return t.k === 'eof' ? 'end' : t.v;
}

/** Parse one entry. Throws ParseError. */
export function parse(source: string, opts: ParseOptions = {}): Node {
  return new Parser(tokenize(source), opts).parseAll();
}

/** Parse, or undefined if it doesn't parse. */
export function tryParse(source: string, opts: ParseOptions = {}): Node | undefined {
  try {
    return parse(source, opts);
  } catch {
    return undefined;
  }
}

/** Strip redundant parentheses nodes. */
export function unparen(node: Node): Node {
  return node.t === 'paren' ? unparen(node.a) : node;
}

/** Every identifier name in a tree (not function names). */
export function identifiers(node: Node, into = new Set<string>()): Set<string> {
  switch (node.t) {
    case 'id':
      into.add(node.name);
      break;
    case 'call':
      node.args.forEach((a) => identifiers(a, into));
      break;
    case 'bin':
      identifiers(node.a, into);
      identifiers(node.b, into);
      break;
    case 'neg':
    case 'not':
    case 'post':
    case 'paren':
      identifiers(node.a, into);
      break;
    case 'list':
      node.items.forEach((a) => identifiers(a, into));
      break;
    case 'index':
      identifiers(node.a, into);
      node.idx.forEach((a) => identifiers(a, into));
      break;
    case 'define':
      identifiers(node.lhs, into);
      identifiers(node.rhs, into);
      break;
    case 'cmd':
      node.args.forEach((a) => identifiers(a, into));
      break;
  }
  return into;
}
