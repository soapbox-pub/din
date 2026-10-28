import { parse, unparen, type Node } from './expr';

/**
 * Graphs and tables need thousands of values a second, far more than a round
 * trip to giac per point allows. Giac first simplifies an expression to its
 * plain form (user functions and stored values substituted); this compiles
 * that form to a tree of closures. No eval: the shell's CSP forbids it.
 * Anything it doesn't know (rootof, special functions) throws, and the
 * caller falls back to sampling through giac.
 */

export type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

export class CompileError extends Error {}

const DEG = Math.PI / 180;

type Fn1 = (x: number) => number;

function gamma(x: number): number {
  // Lanczos approximation.
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

/** Real nth root: the cube root of -8 is -2. */
function realRoot(x: number, n: number): number {
  if (x >= 0) return Math.pow(x, 1 / n);
  return Number.isInteger(n) && n % 2 === 1 ? -Math.pow(-x, 1 / n) : NaN;
}

function functions(degrees: boolean): Record<string, Fn1> {
  const toRad = degrees ? (x: number) => x * DEG : (x: number) => x;
  const fromRad = degrees ? (x: number) => x / DEG : (x: number) => x;
  return {
    sin: (x) => Math.sin(toRad(x)),
    cos: (x) => Math.cos(toRad(x)),
    tan: (x) => Math.tan(toRad(x)),
    sec: (x) => 1 / Math.cos(toRad(x)),
    csc: (x) => 1 / Math.sin(toRad(x)),
    cot: (x) => 1 / Math.tan(toRad(x)),
    asin: (x) => fromRad(Math.asin(x)),
    acos: (x) => fromRad(Math.acos(x)),
    atan: (x) => fromRad(Math.atan(x)),
    asec: (x) => fromRad(Math.acos(1 / x)),
    acsc: (x) => fromRad(Math.asin(1 / x)),
    acot: (x) => fromRad(Math.atan(1 / x)),
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    sech: (x) => 1 / Math.cosh(x),
    csch: (x) => 1 / Math.sinh(x),
    coth: (x) => 1 / Math.tanh(x),
    asinh: Math.asinh,
    acosh: Math.acosh,
    atanh: Math.atanh,
    exp: Math.exp,
    ln: Math.log,
    log10: Math.log10,
    // As typed on the entry line, log is base 10.
    log: Math.log10,
    sqrt: Math.sqrt,
    abs: Math.abs,
    sign: Math.sign,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    iPart: Math.trunc,
    fPart: (x) => x - Math.trunc(x),
    gamma,
    factorial: (x) => gamma(x + 1),
    cbrt: Math.cbrt,
    re: (x) => x,
    im: () => 0,
    conj: (x) => x,
    evalf: (x) => x,
    approx: (x) => x,
  };
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, inf: Infinity, infinity: Infinity, undef: NaN };

/** The exponent as p/q when it's a literal fraction, for real roots: x^(1/3). */
function rationalExponent(node: Node): { p: number; q: number } | undefined {
  const n = unparen(node);
  if (n.t === 'bin' && n.op === '/') {
    const a = unparen(n.a);
    const b = unparen(n.b);
    const sign = a.t === 'neg' ? -1 : 1;
    const num = a.t === 'neg' ? unparen(a.a) : a;
    if (num.t === 'num' && b.t === 'num' && /^\d+$/.test(num.v) && /^\d+$/.test(b.v)) {
      return { p: sign * Number(num.v), q: Number(b.v) };
    }
  }
  if (n.t === 'neg') {
    const inner = rationalExponent(n.a);
    return inner && { p: -inner.p, q: inner.q };
  }
  return undefined;
}

export interface CompileOptions {
  degrees?: boolean;
  /** Names that are inputs (x, t, θ, ...); anything else is an error. */
  variables: readonly string[];
}

export function compile(node: Node, opts: CompileOptions): Compiled {
  const fns = functions(opts.degrees ?? false);
  const vars = new Set(opts.variables);

  const build = (n: Node): Compiled => {
    switch (n.t) {
      case 'num': {
        const v = Number(n.v);
        return () => v;
      }
      case 'id': {
        if (vars.has(n.name)) {
          const name = n.name;
          return (s) => s[name];
        }
        if (n.name in CONSTANTS) {
          const v = CONSTANTS[n.name];
          return () => v;
        }
        throw new CompileError(`Unknown name ${n.name}`);
      }
      case 'paren':
        return build(n.a);
      case 'neg': {
        const a = build(n.a);
        return (s) => -a(s);
      }
      case 'not': {
        const a = build(n.a);
        return (s) => (a(s) ? 0 : 1);
      }
      case 'post': {
        const a = build(n.a);
        if (n.op === '!') return (s) => gamma(a(s) + 1);
        if (n.op === '°') return opts.degrees ? a : (s) => a(s) * DEG;
        throw new CompileError('Unsupported postfix');
      }
      case 'bin':
        return buildBin(n);
      case 'call':
        return buildCall(n);
      default:
        throw new CompileError(`Can't graph ${n.t}`);
    }
  };

  const buildBin = (n: Extract<Node, { t: 'bin' }>): Compiled => {
    const a = build(n.a);
    if (n.op === '^') {
      const ratio = rationalExponent(n.b);
      if (ratio && ratio.q % 2 === 1) {
        const { p, q } = ratio;
        return (s) => {
          const base = a(s);
          const root = realRoot(base, q);
          return Math.pow(root, p);
        };
      }
      const b = build(n.b);
      return (s) => Math.pow(a(s), b(s));
    }
    const b = build(n.b);
    switch (n.op) {
      case '+':
        return (s) => a(s) + b(s);
      case '-':
        return (s) => a(s) - b(s);
      case '*':
        return (s) => a(s) * b(s);
      case '/':
        return (s) => a(s) / b(s);
      case '=':
        return (s) => (a(s) === b(s) ? 1 : 0);
      case '≠':
        return (s) => (a(s) !== b(s) ? 1 : 0);
      case '<':
        return (s) => (a(s) < b(s) ? 1 : 0);
      case '>':
        return (s) => (a(s) > b(s) ? 1 : 0);
      case '≤':
        return (s) => (a(s) <= b(s) ? 1 : 0);
      case '≥':
        return (s) => (a(s) >= b(s) ? 1 : 0);
      case 'and':
        return (s) => (a(s) && b(s) ? 1 : 0);
      case 'or':
        return (s) => (a(s) || b(s) ? 1 : 0);
      case 'xor':
        return (s) => (!a(s) !== !b(s) ? 1 : 0);
      default:
        throw new CompileError(`Can't graph ${n.op}`);
    }
  };

  const buildCall = (n: Extract<Node, { t: 'call' }>): Compiled => {
    const args = n.args.map(build);
    const f = n.f;
    if (fns[f] && args.length === 1) {
      const fn = fns[f];
      const a = args[0];
      return (s) => fn(a(s));
    }
    switch (f) {
      case 'when':
      case 'ifte':
      case 'piecewise': {
        return (s) => {
          let i = 0;
          for (; i + 1 < args.length; i += 2) {
            if (args[i](s)) return args[i + 1](s);
          }
          return i < args.length ? args[i](s) : NaN;
        };
      }
      case 'surd':
      case 'root': {
        const [x, k] = args;
        return (s) => realRoot(x(s), k(s));
      }
      case 'max':
        return (s) => Math.max(...args.map((a) => a(s)));
      case 'min':
        return (s) => Math.min(...args.map((a) => a(s)));
      case 'atan2':
        return (s) => Math.atan2(args[0](s), args[1](s));
      case 'logb':
        return (s) => Math.log(args[0](s)) / Math.log(args[1](s));
      case 'round':
        if (args.length === 2) {
          return (s) => {
            const k = 10 ** args[1](s);
            return Math.round(args[0](s) * k) / k;
          };
        }
        break;
      case 'irem':
      case 'rem':
        return (s) => args[0](s) % args[1](s);
      case 'dinmod':
      case 'mod':
        return (s) => {
          const x = args[0](s);
          const m = args[1](s);
          return x - m * Math.floor(x / m);
        };
    }
    throw new CompileError(`Can't graph ${f}()`);
  };

  return build(node);
}

/** A plain number from text like 2π, -10 or √(2)/2; undefined if it isn't one. */
export function evaluateNumber(text: string, degrees = false): number | undefined {
  try {
    const value = compile(parse(text.trim()), { variables: [], degrees })({});
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
