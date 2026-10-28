import { unparen, type Node } from './expr';
import { UNIT_DISPLAY } from './toGiac';

/** How decimals are shown, as the TI-89's Display Digits mode. */
export interface NumberFormat {
  mode: 'float' | 'fix';
  digits: number;
}

export const DEFAULT_FORMAT: NumberFormat = { mode: 'float', digits: 6 };

/** A giac decimal as a TI-89 shows it: 1.41421, 2., 1.26765ᴇ30. Returns mantissa and exponent. */
export function formatDecimal(text: string, format: NumberFormat): { mantissa: string; exponent?: number } {
  const value = Number(text);
  if (!Number.isFinite(value)) return { mantissa: text };
  if (value === 0) return { mantissa: '0.' };
  const abs = Math.abs(value);
  const exp10 = Math.floor(Math.log10(abs));
  if (format.mode === 'fix' && exp10 < 12 && exp10 >= -format.digits) {
    return { mantissa: value.toFixed(format.digits) };
  }
  const digits = format.mode === 'fix' ? Math.max(format.digits + 1, 1) : format.digits;
  if (exp10 >= digits + 6 || exp10 >= 15 || exp10 < -4) {
    const [m, e] = value.toExponential(Math.max(digits - 1, 0)).split('e');
    return { mantissa: trimZeros(m), exponent: Number(e) };
  }
  const fixed = Number(value.toPrecision(Math.min(Math.max(digits, 1), 15)));
  let s = fixed.toString();
  if (s.includes('e')) {
    const [m, e] = fixed.toExponential(Math.max(digits - 1, 0)).split('e');
    return { mantissa: trimZeros(m), exponent: Number(e) };
  }
  if (!s.includes('.')) s += '.';
  return { mantissa: s };
}

function trimZeros(m: string): string {
  if (!m.includes('.')) return `${m}.`;
  const t = m.replace(/0+$/, '');
  return t;
}

/** A decimal as plain text, for tables and the graph's readouts. */
export function formatNumberText(value: number, format: NumberFormat = DEFAULT_FORMAT): string {
  if (Number.isNaN(value)) return 'undef';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  const { mantissa, exponent } = formatDecimal(String(value), format);
  const m = mantissa.endsWith('.') ? mantissa.slice(0, -1) : mantissa;
  return exponent === undefined ? m : `${m}ᴇ${exponent}`;
}

const GREEK: Record<string, string> = {
  pi: '\\pi', θ: '\\theta', theta: '\\theta', alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma',
  delta: '\\delta', lambda: '\\lambda', mu: '\\mu', sigma: '\\sigma', phi: '\\phi', omega: '\\omega',
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', λ: '\\lambda', μ: '\\mu',
  σ: '\\sigma', φ: '\\varphi', ω: '\\omega', ρ: '\\rho', τ: '\\tau', Δ: '\\Delta', Ω: '\\Omega',
};

const NAMED_FUNCTIONS: Record<string, string> = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan', sec: '\\sec', csc: '\\csc', cot: '\\cot',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', coth: '\\coth', ln: '\\ln', log10: '\\log',
  log: '\\log', det: '\\det', gcd: '\\gcd', max: '\\max', min: '\\min', arg: '\\arg', exp: '\\exp',
};

const TRIG_POWERS = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh']);

const INVERSE_TRIG: Record<string, string> = {
  asin: '\\sin^{-1}', acos: '\\cos^{-1}', atan: '\\tan^{-1}', asinh: '\\sinh^{-1}', acosh: '\\cosh^{-1}',
  atanh: '\\tanh^{-1}', asec: '\\sec^{-1}', acsc: '\\csc^{-1}', acot: '\\cot^{-1}',
};

/** Escape text for \text{}. */
export function texText(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\textbackslash{}';
      case '^':
        return '\\textasciicircum{}';
      case '~':
        return '\\textasciitilde{}';
      default:
        return `\\${c}`;
    }
  });
}

/** A variable name: x, y_{1}, c_{0}, \theta, \mathit{abc}. */
function identifier(name: string): string {
  if (GREEK[name]) return GREEK[name];
  if (name === 'inf' || name === 'infinity') return '\\infty';
  if (name === 'undef') return '\\text{undef}';
  if (name === 'true' || name === 'false') return `\\text{${name}}`;
  if (name === 'e') return '\\mathrm{e}';
  if (name === 'i') return '\\mathrm{i}';
  const sub = /^([A-Za-zÀ-ɏͰ-Ͽ]+)_?(\d+)$/.exec(name) ?? /^([A-Za-zÀ-ɏͰ-Ͽ]+)_([A-Za-z0-9]+)$/.exec(name);
  if (sub) return `${identifier(sub[1])}_{${sub[2]}}`;
  if (name.length === 1) return name;
  return `\\mathit{${texText(name)}}`;
}

/** Binding strength, for deciding where parentheses go. */
function precedence(node: Node): number {
  switch (node.t) {
    case 'bin':
      switch (node.op) {
        case '→':
        case ':=':
        case '▶':
        case '->':
          return 0;
        case '|':
          return 1;
        case 'or':
        case 'xor':
          return 2;
        case 'and':
          return 3;
        case '=':
        case '≠':
        case '<':
        case '>':
        case '≤':
        case '≥':
          return 5;
        case '..':
          return 6;
        case '+':
        case '-':
          return 7;
        case '*':
        case '/':
          return 8;
        case '^':
          return 10;
      }
      break;
    case 'not':
      return 4;
    case 'neg':
      return 9;
    case 'post':
      return 11;
    case 'num':
      return node.v.startsWith('-') ? 9 : 12;
    default:
      return 12;
  }
  return 12;
}

export interface LatexOptions {
  /** Format decimals (results); leave them as typed (input) when unset. */
  format?: NumberFormat;
}

const paren = (s: string) => `\\left(${s}\\right)`;

export function toLatex(node: Node, opts: LatexOptions = {}): string {
  const tex = (n: Node) => toLatex(n, opts);
  const wrap = (n: Node, min: number) => (precedence(n) < min ? paren(tex(unparen(n))) : tex(n));

  switch (node.t) {
    case 'num':
      return number(node.v, opts);
    case 'id':
      return identifier(node.name);
    case 'str':
      return `\\text{“${texText(node.v)}”}`;
    case 'unit':
      return `\\,\\mathrm{${unitLatex(node.v)}}`;
    case 'paren':
      return paren(tex(node.a));
    case 'neg':
      return `-${wrap(node.a, 8)}`;
    case 'not':
      return `\\text{not }${wrap(node.a, 4)}`;
    case 'post':
      switch (node.op) {
        case '!':
          return `${wrap(node.a, 12)}!`;
        case '°':
          return `${wrap(node.a, 12)}^{\\circ}`;
        case 'ᵀ':
          return `${wrap(node.a, 12)}^{\\mathsf{T}}`;
        case "'":
          return `${wrap(node.a, 12)}${"'".repeat(node.n ?? 1)}`;
      }
      break;
    case 'list':
      return listLatex(node, opts);
    case 'index':
      return `${wrap(node.a, 12)}\\left[${node.idx.map(tex).join(',')}\\right]`;
    case 'define':
      return `\\text{Define }${tex(node.lhs)}=${tex(node.rhs)}`;
    case 'cmd':
      return `\\text{${texText(cmdName(node.name))}}${node.args.length ? '\\ ' + node.args.map(tex).join(',') : ''}`;
    case 'call':
      return callLatex(node, opts);
    case 'bin':
      return binLatex(node, opts);
  }
  return '';
}

function cmdName(name: string): string {
  return { delvar: 'DelVar', newprob: 'NewProb', clrhome: 'ClrHome' }[name] ?? name;
}

function number(v: string, opts: LatexOptions): string {
  const isDecimal = /[.e]/i.test(v);
  if (opts.format && isDecimal) {
    const { mantissa, exponent } = formatDecimal(v, opts.format);
    return exponent === undefined ? mantissa : `${mantissa}\\times10^{${exponent}}`;
  }
  const exp = /^(.*?)e([+-]?\d+)$/i.exec(v);
  if (exp) return `${exp[1]}\\mathrm{E}${exp[2].replace('+', '')}`;
  // Long integers break across lines instead of running off the edge.
  if (/^\d{16,}$/.test(v)) return v.replace(/(\d{3})(?=\d)/g, '$1\\allowbreak ');
  return v;
}

function unitLatex(v: string): string {
  const inner = (v.startsWith('(') && v.endsWith(')') ? v.slice(1, -1) : v)
    .replace(/\^\(?(-?\d+)\.0\)?/g, '^$1')
    .replace(/[A-Za-zµ°]+/g, (name) => UNIT_DISPLAY[name] ?? name);
  return texText(inner)
    .replace(/\*/g, '\\cdot ')
    .replace(/\\textasciicircum\{\}\(?(-?\d+)\)?/g, '^{$1}');
}

function listLatex(node: Extract<Node, { t: 'list' }>, opts: LatexOptions): string {
  const tex = (n: Node) => toLatex(n, opts);
  const items = node.items;
  const isMatrix =
    node.kind === 'matrix' ||
    (node.kind === 'bracket' &&
      items.length > 0 &&
      items.every((r) => r.t === 'list' && (r.kind === 'bracket' || r.kind === 'list') && r.items.length === (items[0] as { items: Node[] }).items.length && r.items.length > 0));
  if (isMatrix && items.every((r) => r.t === 'list')) {
    const rows = items.map((r) => (r as Extract<Node, { t: 'list' }>).items.map(tex).join(' & '));
    return `\\begin{bmatrix}${rows.join(' \\\\ ')}\\end{bmatrix}`;
  }
  const joined = items.map(tex).join(',\\ ');
  switch (node.kind) {
    case 'brace':
    case 'list':
    case 'set':
      return `\\left\\{${joined}\\right\\}`;
    case 'seq':
      return joined;
    case 'tuple':
      return paren(joined);
    default:
      return `\\left[${joined}\\right]`;
  }
}

/** Does this render starting with a digit (so juxtaposing it needs a ·)? */
function startsWithDigit(node: Node): boolean {
  const n = node;
  switch (n.t) {
    case 'num':
      return true;
    case 'bin':
      return n.op === '/' ? false : startsWithDigit(n.a);
    case 'post':
      return startsWithDigit(n.a);
    default:
      return false;
  }
}

function binLatex(node: Extract<Node, { t: 'bin' }>, opts: LatexOptions): string {
  const tex = (n: Node) => toLatex(n, opts);
  const wrap = (n: Node, min: number) => (precedence(n) < min ? paren(tex(unparen(n))) : tex(n));
  const { a, b } = node;
  switch (node.op) {
    case '+': {
      const rb = unparen(b);
      if (rb.t === 'neg') return `${wrap(a, 7)}-${wrap(rb.a, 8)}`;
      const right = wrap(b, 7);
      return right.startsWith('-') ? `${wrap(a, 7)}${right}` : `${wrap(a, 7)}+${right}`;
    }
    case '-':
      return `${wrap(a, 7)}-${wrap(b, 8)}`;
    case '*': {
      const ra = unparen(a);
      const rb = unparen(b);
      if (rb.t === 'unit') return `${wrap(a, 8)}${tex(rb)}`;
      // -x·y reads as −(x·y): the sign leads.
      if (ra.t === 'neg') return `-${toLatex({ ...node, a: ra.a }, opts)}`;
      const left = wrap(a, 8);
      const right = rb.t === 'neg' ? paren(tex(rb)) : wrap(b, 8);
      // Juxtapose (2x, 3√2, x sin(x)) unless the right side starts with a
      // digit, or either side is a list or matrix.
      const needsDot =
        /^[0-9.]/.test(right) || (startsWithDigit(rb) && !right.startsWith('\\left(')) ||
        ra.t === 'list' || rb.t === 'list' ||
        (ra.t === 'call' && /^[a-zA-Z]/.test(right));
      return needsDot ? `${left}\\cdot ${right}` : `${left}\\,${right}`;
    }
    case '/': {
      const num = unparen(a);
      // −1/2 is −½; a/b/c is one fraction a/(b·c).
      if (num.t === 'neg') return `-${toLatex({ ...node, a: num.a }, opts)}`;
      if (num.t === 'bin' && num.op === '/') {
        return toLatex({ t: 'bin', op: '/', a: num.a, b: { t: 'bin', op: '*', a: num.b, b } }, opts);
      }
      return `\\frac{${tex(num)}}{${tex(unparen(b))}}`;
    }
    case '^': {
      const base = unparen(a);
      const exponent = tex(unparen(b));
      // sin(x)^2 as sin²(x)
      const power = unparen(b);
      if (base.t === 'call' && TRIG_POWERS.has(base.f) && base.args.length === 1 && power.t === 'num' && /^\d+$/.test(power.v)) {
        return `${NAMED_FUNCTIONS[base.f]}^{${power.v}}${paren(tex(base.args[0]))}`;
      }
      // sqrt(x)^3 or (x+1)^2 need their brackets; e^x is the exponential.
      const baseTex =
        precedence(base) <= 11 || (base.t === 'num' && /[.e-]/i.test(base.v)) || base.t === 'call'
          ? base.t === 'call' && (base.f === 'sqrt' || base.f === 'abs')
            ? tex(base)
            : paren(tex(base))
          : tex(base);
      return `{${baseTex}}^{${exponent}}`;
    }
    case '=':
      return `${wrap(a, 6)}=${wrap(b, 6)}`;
    case '≠':
      return `${wrap(a, 6)}\\ne ${wrap(b, 6)}`;
    case '<':
      return `${wrap(a, 6)}<${wrap(b, 6)}`;
    case '>':
      return `${wrap(a, 6)}>${wrap(b, 6)}`;
    case '≤':
      return `${wrap(a, 6)}\\le ${wrap(b, 6)}`;
    case '≥':
      return `${wrap(a, 6)}\\ge ${wrap(b, 6)}`;
    case 'and': {
      const between = chainedInequality(node, opts);
      if (between) return between;
      return `${wrap(a, 3)}\\ \\text{and}\\ ${wrap(b, 4)}`;
    }
    case 'or':
      return `${wrap(a, 2)}\\ \\text{or}\\ ${wrap(b, 3)}`;
    case 'xor':
      return `${wrap(a, 2)}\\ \\text{xor}\\ ${wrap(b, 3)}`;
    case '..':
      return `${wrap(a, 7)}\\,..\\,${wrap(b, 7)}`;
    case '|':
      return `${wrap(a, 2)}\\,\\big|\\,${wrap(b, 2)}`;
    case '→':
      return `${wrap(a, 1)}\\rightarrow ${wrap(b, 1)}`;
    case ':=':
      return `${wrap(a, 1)}:=${wrap(b, 0)}`;
    case '▶': {
      // ▶Dec, ▶Polar: a conversion's name, not a variable.
      const target = unparen(b);
      const right = target.t === 'id' ? `\\mathrm{${texText(target.name)}}` : wrap(b, 1);
      return `${wrap(a, 1)}\\blacktriangleright ${right}`;
    }
    case '->':
      return `${tex(unparen(a))}\\mapsto ${wrap(b, 0)}`;
  }
}

/** x>-1 and x<5 reads as -1<x<5. */
function chainedInequality(node: Extract<Node, { t: 'bin' }>, opts: LatexOptions): string | undefined {
  const a = unparen(node.a);
  const b = unparen(node.b);
  if (a.t !== 'bin' || b.t !== 'bin') return undefined;
  const lower = new Set(['>', '≥']);
  const upper = new Set(['<', '≤']);
  const flip: Record<string, string> = { '>': '<', '≥': '\\le ', '<': '<', '≤': '\\le ' };
  const same = (x: Node, y: Node) => JSON.stringify(unparen(x)) === JSON.stringify(unparen(y));
  // x>lo and x<hi
  if (lower.has(a.op) && upper.has(b.op) && same(a.a, b.a)) {
    return `${toLatex(a.b, opts)}${flip[a.op]}${toLatex(a.a, opts)}${flip[b.op]}${toLatex(b.b, opts)}`;
  }
  // lo<x and x<hi
  if (upper.has(a.op) && upper.has(b.op) && same(a.b, b.a)) {
    return `${toLatex(a.a, opts)}${flip[a.op]}${toLatex(a.b, opts)}${flip[b.op]}${toLatex(b.b, opts)}`;
  }
  return undefined;
}

function callLatex(node: Extract<Node, { t: 'call' }>, opts: LatexOptions): string {
  const tex = (n: Node) => toLatex(n, opts);
  const args = node.args;
  const f = node.f;
  const lower = f.toLowerCase();
  const argList = () => paren(args.map(tex).join(',\\ '));

  if (f === '∠' && args.length === 2) return paren(`${tex(args[0])}\\angle ${tex(args[1])}`);
  // A series' order term (present.ts).
  if (f === 'O' && args.length === 1) return `\\mathcal{O}${argList()}`;

  switch (lower) {
    case 'sqrt':
      if (args.length === 1) return `\\sqrt{${tex(unparen(args[0]))}}`;
      break;
    case 'surd':
    case 'root':
    case 'nroot':
      if (args.length === 2) return `\\sqrt[${tex(args[1])}]{${tex(unparen(args[0]))}}`;
      break;
    case 'abs':
      if (args.length === 1) return `\\left|${tex(unparen(args[0]))}\\right|`;
      break;
    case 'exp':
      if (args.length === 1 && unparen(args[0]).t === 'num' && (unparen(args[0]) as { v: string }).v === '1') return '\\mathrm{e}';
      if (args.length === 1) return `\\mathrm{e}^{${tex(unparen(args[0]))}}`;
      break;
    case 'floor':
      if (args.length === 1) return `\\left\\lfloor ${tex(unparen(args[0]))}\\right\\rfloor`;
      break;
    case 'ceil':
    case 'ceiling':
      if (args.length === 1) return `\\left\\lceil ${tex(unparen(args[0]))}\\right\\rceil`;
      break;
    case 'conj':
      if (args.length === 1) return `\\overline{${tex(unparen(args[0]))}}`;
      break;
    case 'factorial':
      if (args.length === 1) return `${tex(args[0])}!`;
      break;
    case 'logb':
      if (args.length === 2) return `\\log_{${tex(args[1])}}${paren(tex(args[0]))}`;
      break;
    case 'log':
      if (args.length === 2) return `\\log_{${tex(args[1])}}${paren(tex(args[0]))}`;
      break;
    case 'd':
    case 'diff': {
      if (args.length < 2) break;
      const v = tex(args[1]);
      const order = args[2] ? tex(args[2]) : undefined;
      const op = order ? `\\frac{d^{${order}}}{d${v}^{${order}}}` : `\\frac{d}{d${v}}`;
      return `${op}${paren(tex(unparen(args[0])))}`;
    }
    case '∫':
    case 'integrate':
    case 'int': {
      if (args.length < 2) break;
      const v = tex(args[1]);
      const bounds = args.length >= 4 ? `_{${tex(args[2])}}^{${tex(args[3])}}` : '';
      return `\\int${bounds}${tex(args[0])}\\,d${v}`;
    }
    case 'nint':
      if (args.length === 4) return `\\int_{${tex(args[2])}}^{${tex(args[3])}}${tex(args[0])}\\,d${tex(args[1])}\\ (\\approx)`;
      break;
    // Σ( and Π(, lowercased.
    case 'σ':
    case 'sum':
    case 'π':
    case 'product': {
      if (args.length < 4) break;
      const sym = lower === 'σ' || lower === 'sum' ? '\\sum' : '\\prod';
      const body = unparen(args[0]);
      const bodyTex = body.t === 'bin' && (body.op === '+' || body.op === '-') ? paren(tex(body)) : tex(body);
      return `${sym}_{${tex(args[1])}=${tex(args[2])}}^{${tex(args[3])}}${bodyTex}`;
    }
    case 'limit': {
      if (args.length < 3) break;
      let dir = '';
      if (args[3]) {
        const d = unparen(args[3]);
        const negative = d.t === 'neg' || (d.t === 'num' && d.v.startsWith('-'));
        dir = negative ? '^{-}' : '^{+}';
      }
      return `\\lim_{${tex(args[1])}\\to ${tex(args[2])}${dir}}${tex(args[0])}`;
    }
    case 'when':
    case 'piecewise': {
      if (args.length < 2) break;
      const rows: string[] = [];
      for (let i = 0; i + 1 < args.length; i += 2) rows.push(`${tex(args[i + 1])} & \\text{if } ${tex(args[i])}`);
      if (args.length % 2 === 1) rows.push(`${tex(args[args.length - 1])} & \\text{otherwise}`);
      return `\\begin{cases}${rows.join(' \\\\ ')}\\end{cases}`;
    }
    case 'comb':
    case 'ncr':
      if (args.length === 2) return `\\binom{${tex(args[0])}}{${tex(args[1])}}`;
      break;
  }
  if (INVERSE_TRIG[lower]) return `${INVERSE_TRIG[lower]}${argList()}`;
  if (NAMED_FUNCTIONS[lower]) return `${NAMED_FUNCTIONS[lower]}${argList()}`;
  const name = f.endsWith("'") ? `${identifier(f.replace(/'+$/, ''))}${f.match(/'+$/)?.[0] ?? ''}` : f.length === 1 ? f : `\\operatorname{${texText(f)}}`;
  return `${name}${argList()}`;
}
