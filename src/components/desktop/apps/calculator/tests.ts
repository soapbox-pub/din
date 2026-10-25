/**
 * Hypothesis tests and confidence intervals, as in the TI-89's Stats/List
 * Editor (Z-Test, T-Test, 2-SampTTest, 1-PropZTest, 2-PropZTest and their
 * intervals), with the distributions they need.
 */

function logGamma(x: number): number {
  const c = [76.180091729471, -86.505320329417, 24.014098240831, -1.2317395724502, 0.0012086509738662, -5.395239384953e-6];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.00000000019;
  for (const k of c) s += k / ++y;
  return -t + Math.log((Math.sqrt(2 * Math.PI) * s) / x);
}

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const front = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * front;
  }
  // Continued fraction for Q, by Lentz's method.
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - front * h;
}

/** Regularized incomplete beta I_x(a, b). */
function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const fraction = (x: number, a: number, b: number) => {
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 500; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d;
      if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-16) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return (front * fraction(x, a, b)) / a;
  return 1 - (front * fraction(1 - x, b, a)) / b;
}

/** P(Z ≤ z) for the standard normal. */
export function normalCdf(z: number): number {
  const p = gammaP(0.5, (z * z) / 2) / 2;
  return z >= 0 ? 0.5 + p : 0.5 - p;
}

/** P(T ≤ t) for Student's t with df degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const tail = betaI(df / (df + t * t), df / 2, 0.5) / 2;
  return t >= 0 ? 1 - tail : tail;
}

/** The value with `area` to its left, by bisection on a CDF. */
function inverse(cdf: (x: number) => number, area: number): number {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < area) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export const invNorm = (area: number) => inverse(normalCdf, area);
export const invT = (area: number, df: number) => inverse((t) => tCdf(t, df), area);

export type Alternative = '≠' | '<' | '>';

function pValue(stat: number, alt: Alternative, cdf: (x: number) => number): number {
  if (alt === '<') return cdf(stat);
  if (alt === '>') return 1 - cdf(stat);
  return 2 * Math.min(cdf(stat), 1 - cdf(stat));
}

export type TestId = 'ztest' | 'ttest' | 'tsamp2' | 'prop1' | 'prop2';

export const TESTS: { id: TestId; label: string; fields: { key: string; label: string; data?: boolean }[] }[] = [
  {
    id: 'ztest',
    label: 'Z-Test / ZInterval (σ known)',
    fields: [
      { key: 'mu0', label: 'μ₀' },
      { key: 'sigma', label: 'σ' },
      { key: 'mean', label: 'x̄', data: true },
      { key: 'n', label: 'n', data: true },
    ],
  },
  {
    id: 'ttest',
    label: 'T-Test / TInterval',
    fields: [
      { key: 'mu0', label: 'μ₀' },
      { key: 'mean', label: 'x̄', data: true },
      { key: 'sx', label: 'Sx', data: true },
      { key: 'n', label: 'n', data: true },
    ],
  },
  {
    id: 'tsamp2',
    label: '2-SampTTest / 2-SampTInt',
    fields: [
      { key: 'mean1', label: 'x̄1', data: true },
      { key: 'sx1', label: 'Sx1', data: true },
      { key: 'n1', label: 'n1', data: true },
      { key: 'mean2', label: 'x̄2', data: true },
      { key: 'sx2', label: 'Sx2', data: true },
      { key: 'n2', label: 'n2', data: true },
    ],
  },
  {
    id: 'prop1',
    label: '1-PropZTest / 1-PropZInt',
    fields: [
      { key: 'p0', label: 'p₀' },
      { key: 'x', label: 'successes x' },
      { key: 'n', label: 'n' },
    ],
  },
  {
    id: 'prop2',
    label: '2-PropZTest / 2-PropZInt',
    fields: [
      { key: 'x1', label: 'x1' },
      { key: 'n1', label: 'n1' },
      { key: 'x2', label: 'x2' },
      { key: 'n2', label: 'n2' },
    ],
  },
];

export interface TestResult {
  rows: [string, number][];
  interval: [number, number];
}

/** Run a test and its interval; `level` is the confidence level (0.95). */
export function runTest(id: TestId, v: Record<string, number>, alt: Alternative, level: number): TestResult | string {
  const need = (...keys: string[]) => keys.find((k) => !Number.isFinite(v[k]));
  const tail = (1 + level) / 2;
  switch (id) {
    case 'ztest': {
      const missing = need('mu0', 'sigma', 'mean', 'n');
      if (missing) return 'Fill in every value.';
      const se = v.sigma / Math.sqrt(v.n);
      const z = (v.mean - v.mu0) / se;
      const m = invNorm(tail) * se;
      return { rows: [['z', z], ['p', pValue(z, alt, normalCdf)], ['x̄', v.mean], ['n', v.n], ['ME', m]], interval: [v.mean - m, v.mean + m] };
    }
    case 'ttest': {
      if (need('mu0', 'mean', 'sx', 'n')) return 'Fill in every value.';
      if (v.n < 2) return 'n must be at least 2.';
      const df = v.n - 1;
      const se = v.sx / Math.sqrt(v.n);
      const t = (v.mean - v.mu0) / se;
      const m = invT(tail, df) * se;
      return { rows: [['t', t], ['p', pValue(t, alt, (x) => tCdf(x, df))], ['df', df], ['x̄', v.mean], ['Sx', v.sx], ['n', v.n], ['ME', m]], interval: [v.mean - m, v.mean + m] };
    }
    case 'tsamp2': {
      if (need('mean1', 'sx1', 'n1', 'mean2', 'sx2', 'n2')) return 'Fill in every value.';
      // Welch's t, as the TI-89 does with Pooled: No.
      const a = (v.sx1 * v.sx1) / v.n1;
      const b = (v.sx2 * v.sx2) / v.n2;
      const se = Math.sqrt(a + b);
      const df = (a + b) ** 2 / (a * a / (v.n1 - 1) + (b * b) / (v.n2 - 1));
      const diff = v.mean1 - v.mean2;
      const t = diff / se;
      const m = invT(tail, df) * se;
      return { rows: [['t', t], ['p', pValue(t, alt, (x) => tCdf(x, df))], ['df', df], ['x̄1−x̄2', diff], ['ME', m]], interval: [diff - m, diff + m] };
    }
    case 'prop1': {
      if (need('p0', 'x', 'n')) return 'Fill in every value.';
      const p = v.x / v.n;
      const z = (p - v.p0) / Math.sqrt((v.p0 * (1 - v.p0)) / v.n);
      const m = invNorm(tail) * Math.sqrt((p * (1 - p)) / v.n);
      return { rows: [['z', z], ['p-value', pValue(z, alt, normalCdf)], ['p̂', p], ['n', v.n], ['ME', m]], interval: [p - m, p + m] };
    }
    case 'prop2': {
      if (need('x1', 'n1', 'x2', 'n2')) return 'Fill in every value.';
      const p1 = v.x1 / v.n1;
      const p2 = v.x2 / v.n2;
      const pooled = (v.x1 + v.x2) / (v.n1 + v.n2);
      const z = (p1 - p2) / Math.sqrt(pooled * (1 - pooled) * (1 / v.n1 + 1 / v.n2));
      const m = invNorm(tail) * Math.sqrt((p1 * (1 - p1)) / v.n1 + (p2 * (1 - p2)) / v.n2);
      return {
        rows: [['z', z], ['p-value', pValue(z, alt, normalCdf)], ['p̂1', p1], ['p̂2', p2], ['p̂ pooled', pooled], ['ME', m]],
        interval: [p1 - p2 - m, p1 - p2 + m],
      };
    }
  }
}
