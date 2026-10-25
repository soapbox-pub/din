import { parse, unparen, type Node } from './expr';
import { texText, toLatex, type NumberFormat } from './latex';

/** Functions whose results a TI-89 shows as {lists}. */
const LIST_FUNCTIONS = new Set([
  'zeros', 'czeros', 'seq', 'cumsum', 'sorta', 'sortd', 'augment', 'divisors', 'quartiles', 'eigvl', 'eigenvals',
]);

const SOLVERS = new Set(['solve', 'csolve', 'nsolve', 'fsolve', 'fmin', 'fmax']);

function hasBraceList(node: Node): boolean {
  switch (node.t) {
    case 'list':
      return node.kind === 'brace' || node.items.some(hasBraceList);
    case 'call':
      return node.args.some(hasBraceList);
    case 'bin':
      return hasBraceList(node.a) || hasBraceList(node.b);
    case 'neg':
    case 'not':
    case 'post':
    case 'paren':
      return hasBraceList(node.a);
    default:
      return false;
  }
}

/** The expression an entry computes, past →, := and |. */
function computed(input: Node): Node {
  const n = unparen(input);
  if (n.t === 'bin' && n.op === '→') return computed(n.a);
  if (n.t === 'bin' && n.op === ':=') return computed(n.b);
  if (n.t === 'bin' && n.op === '|') return computed(n.a);
  return n;
}

/** Whether an entry defines a function, which a TI-89 answers with “Done”. */
export function definesFunction(input: Node): boolean {
  const n = unparen(input);
  if (n.t === 'define' || n.t === 'cmd') return true;
  if (n.t === 'bin' && n.op === '→') return unparen(n.b).t === 'call';
  if (n.t === 'bin' && n.op === ':=') return unparen(n.a).t === 'call';
  return false;
}

const isRelation = (n: Node) =>
  n.t === 'bin' && ['=', '≠', '<', '>', '≤', '≥', 'and', 'or'].includes(n.op);

function joinWith(op: 'and' | 'or', items: Node[]): Node {
  return items.reduce((acc, item) => ({ t: 'bin', op, a: acc, b: item }));
}

/** giac's [2,3] from solve(…, x) as a TI-89 says it: x=2 or x=3. */
function asSolutions(result: Node, variable: Node): Node {
  const items =
    result.t === 'list' && result.kind !== 'tuple' ? result.items : [result];
  if (items.length === 0) return { t: 'id', name: 'false' };
  const vars = unparen(variable);
  const solutions = items.map((item): Node => {
    const value = unparen(item);
    if (vars.t === 'list' && value.t === 'list' && value.items.length === vars.items.length) {
      return joinWith('and', vars.items.map((v, i) => ({ t: 'bin', op: '=', a: v, b: value.items[i] })));
    }
    if (isRelation(value)) return value;
    if (vars.t === 'list') return value;
    return { t: 'bin', op: '=', a: vars, b: value };
  });
  return joinWith('or', solutions);
}

/** Series' order term, x^6*order_size(x), as O(x^6). */
function orderTerms(node: Node): Node {
  switch (node.t) {
    case 'bin': {
      const a = orderTerms(node.a);
      const b = orderTerms(node.b);
      if (node.op === '*' && b.t === 'call' && b.f === 'order_size') return { t: 'call', f: 'O', args: [a] };
      return { ...node, a, b };
    }
    case 'neg':
    case 'paren':
      return { ...node, a: orderTerms(node.a) };
    default:
      return node;
  }
}

/** Reshape giac's answer the way a TI-89 shows it, for the given entry. */
export function shapeResult(result: Node, input: Node | undefined): Node {
  let shaped = orderTerms(result);
  if (!input) return shaped;
  // z▶Polar: giac gives r,θ; a TI-89 shows (r∠θ).
  const outer = unparen(input);
  if (outer.t === 'bin' && outer.op === '▶' && unparen(outer.b).t === 'id' && /^polar$/i.test((unparen(outer.b) as { name: string }).name)) {
    if (shaped.t === 'list' && shaped.items.length === 2) return { t: 'call', f: '∠', args: shaped.items };
  }
  const top = computed(input);
  if (top.t === 'call') {
    const name = top.f.toLowerCase();
    if (SOLVERS.has(name) && top.args[1]) {
      const variable = unparen(top.args[1]);
      // nSolve(eq, x=guess)
      const v = variable.t === 'bin' && variable.op === '=' ? variable.a : variable;
      return asSolutions(shaped, v);
    }
    if (name === 'desolve' && top.args[2]) {
      const items = shaped.t === 'list' ? shaped.items : [shaped];
      if (items.length === 0) return { t: 'id', name: 'false' };
      return joinWith('or', items.map((item) => (isRelation(item) ? item : { t: 'bin', op: '=', a: top.args[2], b: item })));
    }
  }
  const listy = hasBraceList(input) || (top.t === 'call' && LIST_FUNCTIONS.has(top.f.toLowerCase()));
  if (listy && shaped.t === 'list' && shaped.kind === 'bracket' && !shaped.items.some((i) => i.t === 'list')) {
    shaped = { ...shaped, kind: 'brace' };
  }
  return shaped;
}

const FLIPPED: Record<string, '<' | '>' | '≤' | '≥'> = { '<': '>', '>': '<', '≤': '≥', '≥': '≤' };

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** p/q in lowest terms, or undefined if it already is. */
function reduceFraction(p: bigint, q: bigint): Node | undefined {
  const d = gcd(p, q);
  if (d <= 1n || q === 0n) return undefined;
  const [np, nq] = [p / d, q / d];
  if (nq === 1n) return { t: 'num', v: np.toString() };
  return { t: 'bin', op: '/', a: { t: 'num', v: np.toString() }, b: { t: 'num', v: nq.toString() } };
}

/** giac's output without its redundant parentheses, and with 5>x as x<5. */
export function tidy(node: Node): Node {
  switch (node.t) {
    case 'paren':
      return tidy(node.a);
    case 'bin': {
      const a = tidy(node.a);
      const b = tidy(node.b);
      // 2/2*tan(x): giac doesn't always reduce its coefficients.
      if (node.op === '/' && a.t === 'num' && b.t === 'num' && /^\d+$/.test(a.v) && /^\d+$/.test(b.v)) {
        const reduced = reduceFraction(BigInt(a.v), BigInt(b.v));
        if (reduced) return reduced;
      }
      if (node.op === '*' && a.t === 'num' && a.v === '1') return b;
      const flipped = FLIPPED[node.op];
      if (flipped && a.t === 'num' && b.t !== 'num') return { t: 'bin', op: flipped, a: b, b: a };
      // Keep a lambda's parameter list: (x)->…
      if (node.op === '->') return { ...node, b };
      // giac's 5/6*pi reads better as 5π/6, and 1/2*x^2 as x²/2.
      if (node.op === '*' && a.t === 'bin' && a.op === '/' && a.b.t === 'num' && (b.t === 'id' || (b.t === 'bin' && b.op === '^' && b.a.t === 'id'))) {
        const negative = a.a.t === 'neg';
        const p = negative ? (a.a as { a: Node }).a : a.a;
        if (p.t === 'num') {
          const top: Node = p.v === '1' ? b : { t: 'bin', op: '*', a: p, b };
          const fraction: Node = { t: 'bin', op: '/', a: top, b: a.b };
          return negative ? { t: 'neg', a: fraction } : fraction;
        }
      }
      return { ...node, a, b };
    }
    case 'neg':
    case 'not':
    case 'post':
      return { ...node, a: tidy(node.a) };
    case 'call':
      return { ...node, args: node.args.map(tidy) };
    case 'list':
      return { ...node, items: node.items.map(tidy) };
    case 'index':
      return { ...node, a: tidy(node.a), idx: node.idx.map(tidy) };
    default:
      return node;
  }
}

/** LaTeX for giac's printed result; unparseable output shows as text. */
export function resultLatex(text: string, input: Node | undefined, format: NumberFormat): string {
  let node: Node;
  try {
    node = tidy(parse(text, { giac: true }));
  } catch {
    return `\\texttt{${texText(text)}}`;
  }
  return toLatex(shapeResult(node, input), { format });
}
