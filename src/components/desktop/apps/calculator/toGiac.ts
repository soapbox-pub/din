import { unparen, type Node } from './expr';

/** Helpers giac needs to behave like a TI-89; defined when a worker starts. */
export const GIAC_PRELUDE = [
  'dinfactor(e):={ if (type(e)==DOM_INT) return ifactor(e); return factor(e); }',
  'dinmod(a,b):=a-b*floor(a/b)',
  'dintaylor(f,v,n,a):=convert(taylor(f,v=a,n),polynom)',
  'dinvariance(l):=variance(l)*size(l)/(size(l)-1)',
  'dinavgrc(f,v,h):=(subst(f,v=v+h)-f)/h',
  'dintangent(f,v,a):=simplify(subst(diff(f,v),v=a)*(v-a)+subst(f,v=a))',
  'dinmedian(l):={ local s,n; s:=sort(l); n:=size(s); if (irem(n,2)==1) return s[(n-1)/2]; return (s[n/2-1]+s[n/2])/2; }',
];

/** Names the prelude and the evaluator use, hidden from the variable list. */
export const isInternalName = (name: string) => name.startsWith('din');

export class TranslateError extends Error {}

export interface GiacContext {
  angle: 'rad' | 'deg';
  /** The giac variable holding ans(k), the k-th most recent answer. */
  ans: (k: number) => string | undefined;
  /** The text of entry(k), the k-th most recent entry. */
  entry: (k: number) => Node | undefined;
  /** Whether a variable holds a list, so its arithmetic is element by element. */
  isList?: (name: string) => boolean;
}

/** TI-89 function names (lowercase) and the giac function that does the same. */
const RENAME: Record<string, string> = {
  d: 'diff',
  '∫': 'integrate',
  // Σ and Π, lowercased.
  σ: 'sum',
  π: 'product',
  approx: 'evalf',
  csolve: 'csolve',
  czeros: 'cZeros',
  cfactor: 'cfactor',
  texpand: 'texpand',
  tcollect: 'tcollect',
  getnum: 'numer',
  getdenom: 'denom',
  ceiling: 'ceil',
  real: 're',
  imag: 'im',
  angle: 'arg',
  eigvl: 'eigenvals',
  eigvc: 'eigenvects',
  dotp: 'dot',
  crossp: 'cross',
  unitv: 'normalize',
  identity: 'idn',
  ncr: 'comb',
  npr: 'perm',
  nint: 'nInt',
  nderiv: 'nDeriv',
  nsolve: 'fsolve',
  fmin: 'fMin',
  fmax: 'fMax',
  arclen: 'arcLen',
  propfrac: 'propFrac',
  comdenom: 'comDenom',
  desolve: 'desolve',
  ipart: 'iPart',
  fpart: 'fPart',
  isprime: 'isprime',
  cumsum: 'cumSum',
  stddev: 'stddevp',
  stddevpop: 'stddev',
  varpop: 'variance',
  variance: 'dinvariance',
  sorta: 'sort',
  dim: 'size',
  arcsin: 'asin',
  arccos: 'acos',
  arctan: 'atan',
  median: 'dinmedian',
  remain: 'irem',
  mod: 'dinmod',
  randint: 'randint',
  randnorm: 'randnorm',
  inv: 'inv',
  tran: 'transpose',
  normcdf: 'normald_cdf',
  invnorm: 'normald_icdf',
  normpdf: 'normald',
  binompdf: 'binomial',
  binomcdf: 'binomial_cdf',
  tcdf: 'studentd_cdf',
};

/** giac names that are already right, by lowercase spelling (giac is case-sensitive). */
const CANONICAL = new Map(
  [
    'abs', 'acos', 'acosh', 'acot', 'acsc', 'asec', 'asin', 'asinh', 'atan', 'atanh', 'augment', 'ceil', 'comb',
    'conj', 'convert', 'cos', 'cosh', 'cot', 'coth', 'cross', 'csc', 'denom', 'det', 'diag', 'diff', 'dot',
    'eigenvals', 'eigenvects', 'evalf', 'exact', 'exp', 'expand', 'floor', 'gamma', 'gcd', 'ifactor', 'im',
    'integrate', 'lcm', 'left', 'limit', 'ln', 'log10', 'logb', 'max', 'mean', 'median', 'min', 'normal', 'numer',
    'partfrac', 'perm', 'piecewise', 'product', 'rand', 're', 'ref', 'right', 'round', 'rref', 'sec', 'sech',
    'seq', 'sign', 'simplify', 'sin', 'sinh', 'solve', 'sort', 'sqrt', 'string', 'subst', 'sum', 'surd', 'tan',
    'tanh', 'transpose', 'when', 'zeros', 'irem', 'iquo', 'quo', 'rem', 'lcoeff', 'degree', 'coeff', 'coeffs',
    'trace', 'rank', 'kernel', 'lu', 'qr', 'jordan', 'charpoly', 'pcoeff', 'proot', 'series', 'laplace',
    'ilaplace', 'fourier', 'linsolve', 'cumprod', 'count', 'quartiles', 'quantile', 'correlation', 'covariance',
    'linear_regression', 'exponential_regression', 'logarithmic_regression', 'power_regression',
    'polynomial_regression', 'normald', 'normald_cdf', 'normald_icdf', 'binomial', 'binomial_cdf',
    'binomial_icdf', 'poisson', 'poisson_cdf', 'studentd', 'studentd_cdf', 'chisquared_cdf', 'unapply', 'purge',
    'resultant', 'tlin', 'tsimplify', 'trigcos', 'trigsin', 'trigtan', 'halftan', 'lnexpand', 'lncollect',
    'exp2pow', 'pow2exp', 'factors', 'divisors', 'idivis', 'nextprime', 'prevprime', 'euler', 'powmod',
    'iegcd', 'egcd', 'collect', 'horner', 'canonical_form', 'curl', 'divergence', 'grad', 'hessian', 'jacobian',
    'potential', 'hypot', 'factorial', 'randpoly', 'mid', 'idn', 'fsolve', 'csolve', 'size', 'normalize',
    'texpand', 'tcollect', 'cfactor', 'stddev', 'variance', 'cZeros', 'nInt', 'nDeriv', 'fMin', 'fMax',
    'arcLen', 'propFrac', 'comDenom', 'desolve', 'iPart', 'fPart', 'isprime', 'cumSum', 'stddevp', 'inv',
    'atan2', 'randint', 'randnorm', 'rationalroot', 'crationalroot', 'tangent',
  ].map((name) => [name.toLowerCase(), name]),
);

/** The giac name for a function the user typed. User functions keep their spelling. */
export function giacFunctionName(name: string): string {
  const lower = name.toLowerCase();
  return RENAME[lower] ?? CANONICAL.get(lower) ?? name;
}

const IDENT_MAP: Record<string, string> = { inf: 'inf', infinity: 'inf', undef: 'undef' };

function atomic(node: Node): boolean {
  return node.t === 'num' || node.t === 'id' || node.t === 'call' || node.t === 'list' || node.t === 'str' || node.t === 'unit' || node.t === 'index';
}

/** Whether an operand is a TI list: {…}, or a variable holding one. */
function isListy(node: Node, ctx: GiacContext): boolean {
  const n = unparen(node);
  if (n.t === 'list') return n.kind === 'brace';
  if (n.t === 'id') return ctx.isList?.(n.name) ?? false;
  if (n.t === 'bin' && ['+', '-', '*', '/', '^'].includes(n.op)) return isListy(n.a, ctx) || isListy(n.b, ctx);
  if (n.t === 'neg') return isListy(n.a, ctx);
  return false;
}

/** True if an AST is a relation joined by and: x=1 and y=2. */
function conjuncts(node: Node): Node[] {
  const n = unparen(node);
  if (n.t === 'bin' && n.op === 'and') return [...conjuncts(n.a), ...conjuncts(n.b)];
  return [n];
}

const SOLVERS = new Set(['solve', 'csolve', 'zeros', 'czeros', 'nsolve', 'fsolve', 'desolve']);

export function toGiac(node: Node, ctx: GiacContext): string {
  const g = (n: Node) => toGiac(n, ctx);
  const w = (n: Node) => (atomic(unparen(n)) ? g(unparen(n)) : `(${g(n)})`);

  switch (node.t) {
    case 'num':
      return node.v.startsWith('.') ? `0${node.v}` : node.v;
    case 'id':
      return IDENT_MAP[node.name] ?? node.name;
    case 'str':
      return `"${node.v.replace(/"/g, '\\"')}"`;
    case 'unit':
      return `_${UNIT_ALIASES[node.v] ?? node.v}`;
    case 'paren':
      return `(${g(node.a)})`;
    case 'neg':
      return `-${w(node.a)}`;
    case 'not':
      return `not(${g(node.a)})`;
    case 'post':
      switch (node.op) {
        case '!':
          return `${w(node.a)}!`;
        case '°':
          return ctx.angle === 'rad' ? `(${w(node.a)}*pi/180)` : w(node.a);
        case 'ᵀ':
          return `transpose(${g(node.a)})`;
        case "'":
          return `${w(node.a)}${"'".repeat(node.n ?? 1)}`;
      }
      break;
    case 'list': {
      const items = node.items.map(g).join(',');
      switch (node.kind) {
        case 'tuple':
          return `(${items})`;
        case 'seq':
          return `seq[${items}]`;
        case 'set':
          return `set[${items}]`;
        default:
          return `[${items}]`;
      }
    }
    case 'index':
      // TI lists count from 1, giac's from 0.
      return `${w(node.a)}[${node.idx.map((i) => `(${g(i)})-1`).join(',')}]`;
    case 'define':
      return `${g(node.lhs)}:=${g(node.rhs)}`;
    case 'cmd':
      if (node.name === 'delvar') return `purge(${node.args.map(g).join(',')})`;
      throw new TranslateError(`${node.name} can't be used inside an expression`);
    case 'call':
      return callToGiac(node, ctx);
    case 'bin':
      return binToGiac(node, ctx);
  }
  throw new TranslateError('Unsupported expression');
}

function binToGiac(node: Extract<Node, { t: 'bin' }>, ctx: GiacContext): string {
  const g = (n: Node) => toGiac(n, ctx);
  const w = (n: Node) => (atomic(unparen(n)) ? g(unparen(n)) : `(${g(n)})`);
  const { a, b } = node;
  switch (node.op) {
    case '+':
    case '-':
    case '*':
    case '/':
    case '^':
      // {1,2,3}+1 is {2,3,4} on a TI-89; giac's plain + would treat the list as a polynomial.
      if (isListy(a, ctx) || isListy(b, ctx)) return `${w(a)} .${node.op} ${w(b)}`;
      return `${w(a)}${node.op}${w(b)}`;
    case '=':
    case '<':
    case '>':
      return `${w(a)}${node.op}${w(b)}`;
    case '≠':
      return `${w(a)}!=${w(b)}`;
    case '≤':
      return `${w(a)}<=${w(b)}`;
    case '≥':
      return `${w(a)}>=${w(b)}`;
    case 'and':
    case 'or':
    case 'xor':
      return `${w(a)} ${node.op} ${w(b)}`;
    case '..':
      return `${w(a)}..${w(b)}`;
    case '→':
    case ':=': {
      const target = node.op === '→' ? unparen(b) : unparen(a);
      const value = node.op === '→' ? a : b;
      if (target.t !== 'id' && target.t !== 'call') throw new TranslateError('Can only store to a name, like 5→a');
      return `${g(target)}:=(${g(value)})`;
    }
    case '|': {
      const conditions = conjuncts(b);
      const target = unparen(a);
      if (conditions.every((c) => c.t === 'bin' && c.op === '=')) {
        return `subst(${g(a)},[${conditions.map(g).join(',')}])`;
      }
      // solve(x^2=4,x)|x>0: the condition joins the equation.
      if (target.t === 'call' && SOLVERS.has(target.f.toLowerCase()) && target.args.length >= 1) {
        const [first, ...rest] = target.args;
        const merged: Node = { t: 'bin', op: 'and', a: first, b };
        return toGiac({ ...target, args: [merged, ...rest] }, ctx);
      }
      throw new TranslateError('After | use equations like x=2, or a condition on solve()');
    }
    case '▶': {
      const target = unparen(b);
      if (target.t === 'unit' && TEMPERATURES[target.v] && temperatureUnit(a)) return temperature(a, target, ctx);
      if (isUnitExpression(target)) return `convert(${g(a)},${g(target)})`;
      if (target.t === 'id') {
        switch (target.name.toLowerCase()) {
          case 'dec':
            return `evalf(${g(a)})`;
          case 'rect':
            return `rectangular(${g(a)})`;
          case 'polar':
            return `polar(${g(a)})`;
          case 'rad':
            return `(${g(a)})*pi/180`;
          case 'deg':
            return `(${g(a)})*180/pi`;
        }
      }
      throw new TranslateError('▶ converts to a unit (▶_ft) or ▶Dec, ▶Rect, ▶Polar');
    }
    case '->':
      return `(${g(a)})->${w(b)}`;
  }
}

function callToGiac(node: Extract<Node, { t: 'call' }>, ctx: GiacContext): string {
  const g = (n: Node) => toGiac(n, ctx);
  const lower = node.f.toLowerCase();
  const args = node.args;
  const list = (items: Node[]) => items.map(g).join(',');

  switch (lower) {
    case 'ans': {
      const k = args.length ? Number((unparen(args[0]) as { v?: string }).v ?? NaN) : 1;
      const name = Number.isInteger(k) ? ctx.ans(k) : undefined;
      if (!name) throw new TranslateError(`There is no ans(${args.length ? g(args[0]) : 1})`);
      return name;
    }
    case 'entry': {
      const k = args.length ? Number((unparen(args[0]) as { v?: string }).v ?? NaN) : 1;
      const entry = Number.isInteger(k) ? ctx.entry(k) : undefined;
      if (!entry) throw new TranslateError(`There is no entry(${args.length ? g(args[0]) : 1})`);
      return `(${g(entry)})`;
    }
    case 'log':
      if (args.length === 2) return `logb(${list(args)})`;
      return `log10(${list(args)})`;
    case 'int':
      // A TI-89's int() is the greatest integer; with a variable, it's an integral.
      return args.length === 1 ? `floor(${list(args)})` : `integrate(${list(args)})`;
    case 'factor':
      return args.length === 1 ? `dinfactor(${list(args)})` : `factor(${list(args)})`;
    case 'taylor': {
      if (args.length < 3) throw new TranslateError('taylor(expression, variable, order [, point])');
      const point = args[3] ? g(args[3]) : '0';
      return `dintaylor(${g(args[0])},${g(args[1])},${g(args[2])},${point})`;
    }
    case 'avgrc': {
      if (args.length < 2) throw new TranslateError('avgRC(expression, variable [, h])');
      return `dinavgrc(${g(args[0])},${g(args[1])},${args[2] ? g(args[2]) : '0.001'})`;
    }
    case 'sortd':
      return `revlist(sort(${list(args)}))`;
    case 'root':
    case 'nroot':
      return `simplify(surd(${list(args)}))`;
    case 'tangentline': {
      if (args.length < 3) throw new TranslateError('tangentLine(expression, variable, point)');
      return `dintangent(${list(args.slice(0, 3))})`;
    }
    case 'tmpcnv':
      if (args.length === 2) return temperature(args[0], args[1], ctx);
      throw new TranslateError('tmpCnv(temperature, unit), like tmpCnv(100_°C, _°F)');
    case 'solve':
    case 'csolve':
    case 'zeros':
    case 'czeros': {
      // solve(x+y=3 and x-y=1, {x,y}) is a system.
      const vars = args[1] ? unparen(args[1]) : undefined;
      if (args.length >= 2 && vars?.t === 'list') {
        const equations = conjuncts(args[0]);
        const name = giacFunctionName(node.f);
        return `${name}([${equations.map(g).join(',')}],[${vars.items.map(g).join(',')}])`;
      }
      return `${giacFunctionName(node.f)}(${list(args)})`;
    }
    case 'sqrt':
      return `sqrt(${list(args)})`;
    case '∠': {
      const angle = ctx.angle === 'deg' ? `(${g(args[1])})*pi/180` : `(${g(args[1])})`;
      return `(${g(args[0])})*exp(i*${angle})`;
    }
  }
  // y'(0)=1 inside deSolve stays as it is.
  return `${giacFunctionName(node.f)}(${list(args)})`;
}

/** TI-89 unit spellings giac knows by another name. */
const UNIT_ALIASES: Record<string, string> = {
  in: 'inch',
  hr: 'h',
  gal: 'galUS',
  floz: 'ozfl',
  um: 'µm',
  '°C': 'degC',
  '°F': 'degF',
  '°K': 'K',
  sec: 's',
};

/** giac unit names shown the way a TI-89 spells them. */
export const UNIT_DISPLAY: Record<string, string> = { inch: 'in', h: 'hr', galUS: 'gal', ozfl: 'floz', degC: '°C', degF: '°F' };

function isUnitExpression(node: Node): boolean {
  const n = unparen(node);
  if (n.t === 'unit') return true;
  if (n.t === 'bin' && (n.op === '*' || n.op === '/')) {
    const a = unparen(n.a);
    const aIsOne = a.t === 'num' && a.v === '1';
    return (aIsOne || isUnitExpression(a)) && isUnitExpression(n.b);
  }
  if (n.t === 'bin' && n.op === '^') return isUnitExpression(n.a) && unparen(n.b).t !== 'unit';
  return false;
}

/** Temperatures convert with an offset, which giac's convert() doesn't do. */
const TEMPERATURES: Record<string, 'C' | 'F' | 'K'> = { '°C': 'C', degC: 'C', '°F': 'F', degF: 'F', K: 'K', '°K': 'K' };

/** The value and unit of `100_°C`. */
function temperatureUnit(node: Node): { value: Node; unit: 'C' | 'F' | 'K' } | undefined {
  const n = unparen(node);
  if (n.t === 'unit' && TEMPERATURES[n.v]) return { value: { t: 'num', v: '1' }, unit: TEMPERATURES[n.v] };
  if (n.t === 'bin' && n.op === '*') {
    const b = unparen(n.b);
    if (b.t === 'unit' && TEMPERATURES[b.v]) return { value: n.a, unit: TEMPERATURES[b.v] };
  }
  return undefined;
}

function temperature(from: Node, to: Node, ctx: GiacContext): string {
  const source = temperatureUnit(from);
  const target = unparen(to);
  if (!source || target.t !== 'unit' || !TEMPERATURES[target.v]) {
    throw new TranslateError('Convert temperatures like 100_°C▶_°F');
  }
  const v = `(${toGiac(source.value, ctx)})`;
  const kelvin = { C: `${v}+5463/20`, F: `(${v}-32)*5/9+5463/20`, K: v }[source.unit];
  const out = { C: `(${kelvin})-5463/20`, F: `((${kelvin})-5463/20)*9/5+32`, K: `(${kelvin})` }[TEMPERATURES[target.v]];
  return `(${out})*_${UNIT_ALIASES[target.v] ?? target.v}`;
}
