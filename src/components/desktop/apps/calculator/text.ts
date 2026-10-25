import { unparen, type Node } from './expr';
import { UNIT_DISPLAY } from './toGiac';

/** Binding strength for the text form; mirrors the parser's levels. */
function level(node: Node): number {
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
        default:
          return 5;
      }
    case 'not':
      return 4;
    case 'neg':
      return 9;
    case 'post':
      return 11;
    default:
      return 12;
  }
}

const NAMES: Record<string, string> = { pi: 'π', inf: '∞', infinity: '∞' };
const FUNCTIONS: Record<string, string> = {
  sqrt: '√', exp: 'e^', log10: 'log', asin: 'sin⁻¹', acos: 'cos⁻¹', atan: 'tan⁻¹', diff: 'd',
  integrate: '∫', comb: 'nCr', perm: 'nPr', re: 'real', im: 'imag', arg: 'angle', ceil: 'ceiling',
};

/**
 * An expression as you'd type it on the entry line (TI-89 spelling: {lists},
 * √(, π, ∞), for putting a result back into a new entry.
 */
export function toText(node: Node): string {
  const t = (n: Node) => toText(n);
  const wrap = (n: Node, min: number) => (level(unparen(n)) < min ? `(${t(unparen(n))})` : t(unparen(n)));
  switch (node.t) {
    case 'num':
      return node.v;
    case 'id':
      return NAMES[node.name] ?? node.name;
    case 'str':
      return `"${node.v}"`;
    case 'unit': {
      const v = node.v.startsWith('(') ? node.v.slice(1, -1) : node.v;
      return `_${v.replace(/[A-Za-zµ°]+/g, (name) => UNIT_DISPLAY[name] ?? name)}`;
    }
    case 'paren':
      return t(node.a);
    case 'neg':
      return `-${wrap(node.a, 9)}`;
    case 'not':
      return `not ${wrap(node.a, 4)}`;
    case 'post':
      return `${wrap(node.a, 12)}${node.op === "'" ? "'".repeat(node.n ?? 1) : node.op}`;
    case 'list': {
      const items = node.items.map(t).join(',');
      switch (node.kind) {
        case 'brace':
        case 'list':
        case 'set':
          return `{${items}}`;
        case 'tuple':
        case 'seq':
          return items;
        default:
          return `[${items}]`;
      }
    }
    case 'index':
      return `${wrap(node.a, 12)}[${node.idx.map(t).join(',')}]`;
    case 'define':
      return `Define ${t(node.lhs)}=${t(node.rhs)}`;
    case 'cmd':
      return `${node.name} ${node.args.map(t).join(',')}`.trim();
    case 'call': {
      if (node.f === '∠' && node.args.length === 2) return `(${t(node.args[0])}∠${t(node.args[1])})`;
      const name = FUNCTIONS[node.f] ?? node.f;
      if (node.f === 'exp' && node.args.length === 1) return `e^(${t(node.args[0])})`;
      return `${name}(${node.args.map(t).join(',')})`;
    }
    case 'bin': {
      const p = level(node);
      const op = node.op;
      switch (op) {
        case '^':
          return `${wrap(node.a, 11)}^${wrap(node.b, 10)}`;
        case '-':
        case '/':
          return `${wrap(node.a, p)}${op}${wrap(node.b, p + 1)}`;
        case '*': {
          const right = wrap(node.b, p);
          // Units attach to their number: 3_m.
          if (unparen(node.b).t === 'unit') return `${wrap(node.a, p)}${right}`;
          return `${wrap(node.a, p)}*${right}`;
        }
        case 'and':
        case 'or':
        case 'xor':
          return `${wrap(node.a, p)} ${op} ${wrap(node.b, p + 1)}`;
        case '->':
          return `${t(node.a)}->${wrap(node.b, 0)}`;
        default:
          return `${wrap(node.a, p)}${op}${wrap(node.b, p + 1)}`;
      }
    }
  }
}
