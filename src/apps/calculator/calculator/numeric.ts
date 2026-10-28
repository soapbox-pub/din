/** The graph screen's Math tools, done numerically on a compiled function. */

import type { GraphWindow } from './state';

export type Fn = (x: number) => number;

const ok = (v: number) => Number.isFinite(v);

/** A root of f in [a,b] by bisection on the first sign change found, or a touching root. */
export function findZero(f: Fn, a: number, b: number): number | undefined {
  const n = 400;
  const h = (b - a) / n;
  let x0 = a;
  let y0 = f(a);
  if (y0 === 0) return a;
  for (let i = 1; i <= n; i++) {
    const x1 = a + i * h;
    const y1 = f(x1);
    if (y1 === 0) return x1;
    if (ok(y0) && ok(y1) && Math.sign(y0) !== Math.sign(y1)) {
      const root = bisect(f, x0, x1, y0);
      // A jump across an asymptote (tan at π/2) isn't a zero.
      if (Math.abs(f(root)) < 1e-6 * Math.max(1, Math.abs(y0), Math.abs(y1)) || Math.abs(f(root)) < 1e-9) return root;
    }
    x0 = x1;
    y0 = y1;
  }
  // x^2 touches zero without crossing: look for a minimum of |f| that is zero.
  const x = extremum((x) => Math.abs(f(x)), a, b, false);
  if (x !== undefined && Math.abs(f(x)) < 1e-7) return x;
  return undefined;
}

function bisect(f: Fn, lo: number, hi: number, flo: number): number {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === 0 || hi - lo < 1e-15 * Math.max(1, Math.abs(mid))) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/** Where f is smallest (or largest) in [a,b]: a scan, then golden-section search. */
export function extremum(f: Fn, a: number, b: number, max: boolean): number | undefined {
  const g = max ? (x: number) => -f(x) : f;
  const n = 400;
  const h = (b - a) / n;
  let best = NaN;
  let bestX = NaN;
  for (let i = 0; i <= n; i++) {
    const x = a + i * h;
    const y = g(x);
    if (ok(y) && (!ok(best) || y < best)) {
      best = y;
      bestX = x;
    }
  }
  if (!ok(bestX)) return undefined;
  let lo = Math.max(a, bestX - h);
  let hi = Math.min(b, bestX + h);
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  for (let i = 0; i < 200 && hi - lo > 1e-12 * Math.max(1, Math.abs(c)); i++) {
    if (g(c) < g(d)) hi = d;
    else lo = c;
    c = hi - phi * (hi - lo);
    d = lo + phi * (hi - lo);
  }
  return (lo + hi) / 2;
}

/** f′(x) by Richardson-extrapolated central differences. */
export function derivative(f: Fn, x: number): number {
  const h = 1e-3 * Math.max(1, Math.abs(x));
  const d = (step: number) => (f(x + step) - f(x - step)) / (2 * step);
  return (4 * d(h / 2) - d(h)) / 3;
}

/** f″(x). */
export function secondDerivative(f: Fn, x: number): number {
  const h = 1e-3 * Math.max(1, Math.abs(x));
  return (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
}

/** ∫ f from a to b by adaptive Simpson's rule. */
export function integrate(f: Fn, a: number, b: number): number {
  const simpson = (lo: number, hi: number, flo: number, fmid: number, fhi: number) => ((hi - lo) / 6) * (flo + 4 * fmid + fhi);
  const recurse = (lo: number, hi: number, flo: number, fmid: number, fhi: number, whole: number, eps: number, depth: number): number => {
    const mid = (lo + hi) / 2;
    const lm = (lo + mid) / 2;
    const rm = (mid + hi) / 2;
    const flm = f(lm);
    const frm = f(rm);
    const left = simpson(lo, mid, flo, flm, fmid);
    const right = simpson(mid, hi, fmid, frm, fhi);
    if (depth <= 0 || Math.abs(left + right - whole) <= 15 * eps) return left + right + (left + right - whole) / 15;
    return recurse(lo, mid, flo, flm, fmid, left, eps / 2, depth - 1) + recurse(mid, hi, fmid, frm, fhi, right, eps / 2, depth - 1);
  };
  const fa = f(a);
  const fb = f(b);
  const fm = f((a + b) / 2);
  return recurse(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), 1e-10, 40);
}

/** Where f″ changes sign in [a,b]. */
export function inflection(f: Fn, a: number, b: number): number | undefined {
  return findZero((x) => secondDerivative(f, x), a, b);
}

/** A "nice" step near `rough`: 1, 2 or 5 times a power of ten. */
export function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

/** A window that shows every data point, with a margin (ZoomData). */
export function dataWindow(points: { x: number; y: number }[]): Pick<GraphWindow, 'xmin' | 'xmax' | 'ymin' | 'ymax' | 'xscl' | 'yscl'> {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const px = (x1 - x0 || 2) * 0.1;
  const py = (y1 - y0 || 2) * 0.1;
  return { xmin: x0 - px, xmax: x1 + px, ymin: y0 - py, ymax: y1 + py, xscl: niceStep((x1 - x0 || 2) / 8), yscl: niceStep((y1 - y0 || 2) / 8) };
}
