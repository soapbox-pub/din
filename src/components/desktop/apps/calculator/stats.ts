/** One- and two-variable statistics and the TI-89's regressions, numerically. */

export interface OneVarStats {
  n: number;
  mean: number;
  sum: number;
  sumSq: number;
  sx: number;
  σx: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function oneVar(values: number[]): OneVarStats {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  const mean = sum / n;
  const ss = values.reduce((a, b) => a + (b - mean) ** 2, 0);
  // Quartiles as a TI calculator takes them: medians of the lower and upper halves.
  const half = Math.floor(n / 2);
  return {
    n,
    mean,
    sum,
    sumSq,
    sx: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN,
    σx: Math.sqrt(ss / n),
    min: sorted[0],
    q1: medianOf(sorted.slice(0, half)),
    median: medianOf(sorted),
    q3: medianOf(sorted.slice(n % 2 ? half + 1 : half)),
    max: sorted[n - 1],
  };
}

export type Model = 'linear' | 'quadratic' | 'cubic' | 'quartic' | 'exponential' | 'logarithmic' | 'power';

export const MODELS: { id: Model; label: string; form: string }[] = [
  { id: 'linear', label: 'Linear', form: 'y = a·x + b' },
  { id: 'quadratic', label: 'Quadratic', form: 'y = a·x² + b·x + c' },
  { id: 'cubic', label: 'Cubic', form: 'y = a·x³ + b·x² + c·x + d' },
  { id: 'quartic', label: 'Quartic', form: 'y = a·x⁴ + b·x³ + c·x² + d·x + e' },
  { id: 'exponential', label: 'Exponential', form: 'y = a·bˣ' },
  { id: 'logarithmic', label: 'Logarithmic', form: 'y = a + b·ln(x)' },
  { id: 'power', label: 'Power', form: 'y = a·xᵇ' },
];

export interface Regression {
  /** Named coefficients, in the order of the model's form. */
  coefficients: [string, number][];
  /** The fitted equation, as entry-line text in x. */
  equation: string;
  /** Correlation coefficient (linear and transformed models). */
  r?: number;
  /** Coefficient of determination. */
  r2: number;
  predict: (x: number) => number;
}

/** Least-squares polynomial coefficients, highest power first. */
function polyfit(xs: number[], ys: number[], degree: number): number[] {
  const m = degree + 1;
  // Normal equations, solved by Gaussian elimination with partial pivoting.
  const a: number[][] = Array.from({ length: m }, () => Array(m + 1).fill(0));
  for (let i = 0; i < xs.length; i++) {
    const powers = Array.from({ length: 2 * degree + 1 }, (_, k) => xs[i] ** k);
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) a[r][c] += powers[r + c];
      a[r][m] += ys[i] * powers[r];
    }
  }
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < m; r++) {
      if (r === col || a[col][col] === 0) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= m; c++) a[r][c] -= f * a[col][c];
    }
  }
  const lowFirst = a.map((row, i) => row[m] / row[i]);
  return lowFirst.reverse();
}

function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function determination(xs: number[], ys: number[], predict: (x: number) => number): number {
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < xs.length; i++) {
    ssRes += (ys[i] - predict(xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return 1 - ssRes / ssTot;
}

const num = (v: number) => {
  const s = Number(v.toPrecision(10)).toString();
  return s.includes('e') ? `(${s.replace('e', 'ᴇ')})` : s;
};
const signed = (v: number) => (v < 0 ? `-${num(-v)}` : `+${num(v)}`);

export function regress(model: Model, xs: number[], ys: number[]): Regression | string {
  const n = xs.length;
  if (n !== ys.length) return 'The lists have different lengths.';
  const degree = { linear: 1, quadratic: 2, cubic: 3, quartic: 4 }[model as 'linear'];
  if (degree !== undefined) {
    if (n < degree + 1) return `${model} regression needs at least ${degree + 1} points.`;
    const c = polyfit(xs, ys, degree);
    const names = ['a', 'b', 'c', 'd', 'e'];
    const predict = (x: number) => c.reduce((acc, k) => acc * x + k, 0);
    const terms = c.map((k, i) => {
      const p = degree - i;
      const v = p === 0 ? '' : p === 1 ? '*x' : `*x^${p}`;
      return i === 0 ? `${num(k)}${v}` : `${signed(k)}${v}`;
    });
    return {
      coefficients: c.map((k, i) => [names[i], k]),
      equation: terms.join(''),
      r: model === 'linear' ? correlation(xs, ys) : undefined,
      r2: determination(xs, ys, predict),
      predict,
    };
  }
  if (n < 2) return 'Regression needs at least 2 points.';
  if (model === 'exponential') {
    if (ys.some((y) => y <= 0)) return 'Exponential regression needs every y > 0.';
    const [m, k] = polyfit(xs, ys.map(Math.log), 1);
    const a = Math.exp(k);
    const b = Math.exp(m);
    const predict = (x: number) => a * b ** x;
    return { coefficients: [['a', a], ['b', b]], equation: `${num(a)}*${num(b)}^x`, r: correlation(xs, ys.map(Math.log)), r2: determination(xs, ys, predict), predict };
  }
  if (model === 'logarithmic') {
    if (xs.some((x) => x <= 0)) return 'Logarithmic regression needs every x > 0.';
    const [b, a] = polyfit(xs.map(Math.log), ys, 1);
    const predict = (x: number) => a + b * Math.log(x);
    return { coefficients: [['a', a], ['b', b]], equation: `${num(a)}${signed(b)}*ln(x)`, r: correlation(xs.map(Math.log), ys), r2: determination(xs, ys, predict), predict };
  }
  if (xs.some((x) => x <= 0) || ys.some((y) => y <= 0)) return 'Power regression needs every x and y > 0.';
  const [b, k] = polyfit(xs.map(Math.log), ys.map(Math.log), 1);
  const a = Math.exp(k);
  const predict = (x: number) => a * x ** b;
  return { coefficients: [['a', a], ['b', b]], equation: `${num(a)}*x^${num(b)}`, r: correlation(xs.map(Math.log), ys.map(Math.log)), r2: determination(xs, ys, predict), predict };
}
