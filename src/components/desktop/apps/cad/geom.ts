import type { Entity, PlineVertex, Vec } from './model';

/** 2D vector math, curves, intersections and transforms for CAD's entities. */

export const TAU = Math.PI * 2;
export const EPS = 1e-9;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec): Vec => {
  const l = len(a);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const angleOf = (a: Vec) => Math.atan2(a.y, a.x);
export const angleTo = (a: Vec, b: Vec) => Math.atan2(b.y - a.y, b.x - a.x);
export const polar = (c: Vec, r: number, a: number): Vec => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
export const rotate = (p: Vec, c: Vec, a: number): Vec => {
  const s = Math.sin(a);
  const k = Math.cos(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * k - dy * s, y: c.y + dx * s + dy * k };
};
export const same = (a: Vec, b: Vec, tol = 1e-9) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
export const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU;
/** The counterclockwise sweep from a0 to a1, in (0, 2π]. */
export const sweep = (a0: number, a1: number) => {
  const s = wrapAngle(a1 - a0);
  return s < 1e-12 ? TAU : s;
};
/** Whether angle a lies on the counterclockwise arc from a0 to a1. */
export const onArc = (a: number, a0: number, a1: number, tol = 1e-9) => wrapAngle(a - a0) <= sweep(a0, a1) + tol;

// ---- Bulges ----------------------------------------------------------------------------

export interface ArcGeom {
  c: Vec;
  r: number;
  /** Counterclockwise from a0 to a1. */
  a0: number;
  a1: number;
}

/** The arc a polyline bulge describes, with whether it runs clockwise from p0 to p1. */
export function bulgeArc(p0: Vec, p1: Vec, b: number): ArcGeom & { cw: boolean } {
  const theta = 4 * Math.atan(b);
  const chord = dist(p0, p1);
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  const m = mid(p0, p1);
  const h = (r - Math.abs(b) * chord / 2) * Math.sign(b);
  const n = perp(norm(sub(p1, p0)));
  const c = add(m, mul(n, h));
  const s = angleTo(c, p0);
  const e = angleTo(c, p1);
  return b > 0 ? { c, r, a0: s, a1: e, cw: false } : { c, r, a0: e, a1: s, cw: true };
}

/** The bulge for an arc from p0 to p1 through a third point, or 0 if they're in line. */
export function bulgeThrough(p0: Vec, through: Vec, p1: Vec): number {
  const c = circleThrough(p0, through, p1);
  if (!c) return 0;
  const a0 = angleTo(c.c, p0);
  const am = angleTo(c.c, through);
  const a1 = angleTo(c.c, p1);
  const ccw = onArc(am, a0, a1);
  const s = ccw ? sweep(a0, a1) : -sweep(a1, a0);
  return Math.tan(s / 4);
}

export function circleThrough(a: Vec, b: Vec, c: Vec): { c: Vec; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const ctr = { x: ux, y: uy };
  return { c: ctr, r: dist(ctr, a) };
}

// ---- Segments ----------------------------------------------------------------------------

/** What editing tools see of a curve: lines and arcs (everything else is broken into lines). */
export type Seg = { k: 'line'; a: Vec; b: Vec } | { k: 'arc'; c: Vec; r: number; a0: number; a1: number; cw?: boolean };

export const segStart = (s: Seg): Vec => (s.k === 'line' ? s.a : polar(s.c, s.r, s.cw ? s.a1 : s.a0));
export const segEnd = (s: Seg): Vec => (s.k === 'line' ? s.b : polar(s.c, s.r, s.cw ? s.a0 : s.a1));
export const segMid = (s: Seg): Vec => (s.k === 'line' ? mid(s.a, s.b) : polar(s.c, s.r, s.a0 + sweep(s.a0, s.a1) / 2));
export const segLength = (s: Seg) => (s.k === 'line' ? dist(s.a, s.b) : s.r * sweep(s.a0, s.a1));

export function plineSegs(pts: PlineVertex[], closed: boolean): Seg[] {
  const out: Seg[] = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    if (same(p, q, 1e-12)) continue;
    if (Math.abs(p.b) > 1e-12) {
      const a = bulgeArc(p, q, p.b);
      out.push({ k: 'arc', c: a.c, r: a.r, a0: a.a0, a1: a.a1, cw: a.cw });
    } else out.push({ k: 'line', a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y } });
  }
  return out;
}

/** An entity's own curves (not blocks, text or dimensions). */
export function entitySegs(e: Entity): Seg[] {
  switch (e.type) {
    case 'line':
      return [{ k: 'line', a: e.a, b: e.b }];
    case 'circle':
      return [{ k: 'arc', c: e.c, r: e.r, a0: 0, a1: TAU }];
    case 'arc':
      return [{ k: 'arc', c: e.c, r: e.r, a0: e.start, a1: e.end }];
    case 'pline':
      return plineSegs(e.pts, e.closed);
    case 'ellipse':
      return polySegs(ellipsePoints(e.c, e.major, e.ratio, e.start, e.end, 96), false);
    case 'spline':
      return polySegs(splinePoints(e.degree, e.knots, e.ctrl, e.weights, 96), false);
    case 'solid':
    case 'face':
      return polySegs(e.type === 'solid' ? [e.pts[0], e.pts[1], e.pts[3], e.pts[2]] : e.pts, true);
    case 'leader':
      return polySegs(e.pts, false);
    case 'xline':
      return [{ k: 'line', a: sub(e.p, mul(norm(e.dir), 1e7)), b: add(e.p, mul(norm(e.dir), 1e7)) }];
    case 'ray':
      return [{ k: 'line', a: e.p, b: add(e.p, mul(norm(e.dir), 1e7)) }];
    default:
      return [];
  }
}

export function polySegs(pts: Vec[], closed: boolean): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!same(a, b, 1e-12)) out.push({ k: 'line', a, b });
  }
  return out;
}

// ---- Intersections ------------------------------------------------------------------------

/** Where two infinite lines cross. */
export function lineLine(a1: Vec, a2: Vec, b1: Vec, b2: Vec): { p: Vec; t: number; u: number } | null {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-14 * (len(d1) * len(d2) || 1)) return null;
  const w = sub(b1, a1);
  const t = cross(w, d2) / den;
  const u = cross(w, d1) / den;
  return { p: add(a1, mul(d1, t)), t, u };
}

/** Where an infinite line meets a full circle, as line parameters. */
export function lineCircle(a: Vec, b: Vec, c: Vec, r: number): number[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (A < 1e-24 || disc < -1e-12 * A * r * r) return [];
  if (disc <= 0) return [-B / (2 * A)];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

export function circleCircle(c1: Vec, r1: number, c2: Vec, r2: number): Vec[] {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m = add(c1, mul(sub(c2, c1), a / d));
  const off = mul(perp(sub(c2, c1)), h / d);
  return h < 1e-12 ? [m] : [add(m, off), sub(m, off)];
}

/**
 * Where two segments meet. With `extend`, lines run on forever and arcs go
 * all the way round, for EXTEND, FILLET and apparent intersections.
 */
export function intersect(s1: Seg, s2: Seg, extend = false): Vec[] {
  const tol = 1e-9;
  const onSeg = (s: Seg, p: Vec) => {
    if (extend) return true;
    if (s.k === 'line') {
      const d = sub(s.b, s.a);
      const t = dot(sub(p, s.a), d) / (dot(d, d) || 1);
      return t >= -tol && t <= 1 + tol;
    }
    return onArc(angleTo(s.c, p), s.a0, s.a1, 1e-9);
  };
  let pts: Vec[] = [];
  if (s1.k === 'line' && s2.k === 'line') {
    const x = lineLine(s1.a, s1.b, s2.a, s2.b);
    if (x) pts = [x.p];
  } else if (s1.k === 'line' || s2.k === 'line') {
    const l = (s1.k === 'line' ? s1 : s2) as Extract<Seg, { k: 'line' }>;
    const c = (s1.k === 'arc' ? s1 : s2) as Extract<Seg, { k: 'arc' }>;
    pts = lineCircle(l.a, l.b, c.c, c.r).map((t) => lerp(l.a, l.b, t));
  } else {
    const a = s1 as Extract<Seg, { k: 'arc' }>;
    const b = s2 as Extract<Seg, { k: 'arc' }>;
    pts = circleCircle(a.c, a.r, b.c, b.r);
  }
  return pts.filter((p) => onSeg(s1, p) && onSeg(s2, p));
}

export function closestOnSeg(s: Seg, p: Vec): Vec {
  if (s.k === 'line') {
    const d = sub(s.b, s.a);
    const L = dot(d, d);
    const t = L < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(p, s.a), d) / L));
    return add(s.a, mul(d, t));
  }
  const a = angleTo(s.c, p);
  if (onArc(a, s.a0, s.a1)) return polar(s.c, s.r, a);
  const p0 = polar(s.c, s.r, s.a0);
  const p1 = polar(s.c, s.r, s.a1);
  return dist(p, p0) < dist(p, p1) ? p0 : p1;
}

export const distToSeg = (s: Seg, p: Vec) => dist(p, closestOnSeg(s, p));

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  return distToSeg({ k: 'line', a, b }, p);
}

/** The foot of the perpendicular from p to the segment's line or circle. */
export function perpendicularFoot(s: Seg, p: Vec): Vec | null {
  if (s.k === 'line') {
    const d = sub(s.b, s.a);
    const L = dot(d, d);
    if (L < 1e-24) return null;
    return add(s.a, mul(d, dot(sub(p, s.a), d) / L));
  }
  if (same(p, s.c)) return null;
  return polar(s.c, s.r, angleTo(s.c, p));
}

/** Points on a circle where a line from p would touch it. */
export function tangentPoints(c: Vec, r: number, p: Vec): Vec[] {
  const d = dist(c, p);
  if (d <= r + 1e-12) return [];
  const a = angleTo(c, p);
  const b = Math.acos(r / d);
  return [polar(c, r, a + b), polar(c, r, a - b)];
}

/** Does the segment cross or touch the box? */
export function segHitsBox(s: Seg, min: Vec, max: Vec): boolean {
  const inside = (p: Vec) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
  if (inside(segStart(s)) || inside(segEnd(s))) return true;
  const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
  for (let i = 0; i < 4; i++) if (intersect(s, { k: 'line', a: corners[i], b: corners[(i + 1) % 4] }).length) return true;
  return false;
}

// ---- Curves ---------------------------------------------------------------------------------

export function ellipsePoint(c: Vec, major: Vec, ratio: number, t: number): Vec {
  const minor = mul(perp(major), ratio);
  return { x: c.x + major.x * Math.cos(t) + minor.x * Math.sin(t), y: c.y + major.y * Math.cos(t) + minor.y * Math.sin(t) };
}

export function ellipsePoints(c: Vec, major: Vec, ratio: number, start: number, end: number, n = 64): Vec[] {
  const sw = sweep(start, end);
  const steps = Math.max(8, Math.ceil((n * sw) / TAU));
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i++) out.push(ellipsePoint(c, major, ratio, start + (sw * i) / steps));
  return out;
}

/** The ellipse parameter for a point (an angle measured in the ellipse's own frame). */
export function ellipseParam(c: Vec, major: Vec, ratio: number, p: Vec): number {
  const u = norm(major);
  const d = sub(p, c);
  const x = dot(d, u) / len(major);
  const y = dot(d, perp(u)) / (len(major) * ratio);
  return wrapAngle(Math.atan2(y, x));
}

/** A point on a NURBS curve at parameter u (de Boor). */
export function splinePoint(degree: number, knots: number[], ctrl: Vec[], weights: number[] | undefined, u: number): Vec {
  const n = ctrl.length - 1;
  const p = degree;
  let k = p;
  while (k < n && u >= knots[k + 1]) k++;
  const d: { x: number; y: number; w: number }[] = [];
  for (let j = 0; j <= p; j++) {
    const i = Math.min(n, Math.max(0, j + k - p));
    const w = weights?.[i] ?? 1;
    d.push({ x: ctrl[i].x * w, y: ctrl[i].y * w, w });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = knots[i + p - r + 1] - knots[i];
      const a = den === 0 ? 0 : (u - knots[i]) / den;
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
    }
  }
  const q = d[p];
  return { x: q.x / (q.w || 1), y: q.y / (q.w || 1) };
}

export function splinePoints(degree: number, knots: number[], ctrl: Vec[], weights?: number[], n = 64): Vec[] {
  if (ctrl.length < 2 || knots.length < ctrl.length + degree + 1) return ctrl;
  const u0 = knots[degree];
  const u1 = knots[ctrl.length];
  const steps = Math.max(n, ctrl.length * 8);
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i++) out.push(splinePoint(degree, knots, ctrl, weights, u0 + ((u1 - u0) * i) / steps));
  return out;
}

/**
 * A cubic B-spline through the given points (global interpolation with
 * chord-length parameters and averaged knots, The NURBS Book A9.1).
 */
export function interpolateSpline(fit: Vec[], _t0?: Vec, _t1?: Vec): { degree: number; knots: number[]; ctrl: Vec[] } {
  const pts = fit.filter((p, i) => i === 0 || !same(p, fit[i - 1], 1e-12));
  if (pts.length < 4) {
    const degree = Math.max(1, pts.length - 1);
    return { degree, knots: [...Array(degree + 1).fill(0), ...Array(degree + 1).fill(1)], ctrl: pts.length ? pts : [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
  }
  const degree = 3;
  const n = pts.length;
  const chords = [0];
  for (let i = 1; i < n; i++) chords.push(chords[i - 1] + dist(pts[i], pts[i - 1]));
  const total = chords[n - 1] || 1;
  const u = chords.map((c) => c / total);
  const knots: number[] = [0, 0, 0, 0];
  for (let j = 1; j <= n - 4; j++) knots.push((u[j] + u[j + 1] + u[j + 2]) / 3);
  knots.push(1, 1, 1, 1);
  const A = u.map((uu) => Array.from({ length: n }, (_, i) => basisFn(i, degree, uu, knots)));
  const xs = solve(A.map((r) => [...r]), pts.map((p) => p.x));
  const ys = solve(A.map((r) => [...r]), pts.map((p) => p.y));
  if (!xs || !ys) return { degree: 1, knots: [0, ...u, 1], ctrl: pts };
  return { degree, knots, ctrl: xs.map((x, i) => ({ x, y: ys[i] })) };
}

function basisFn(i: number, p: number, u: number, U: number[]): number {
  const m = U.length - 1;
  if ((i === 0 && u === U[0]) || (i === m - p - 1 && u === U[m])) return 1;
  if (u < U[i] || u >= U[i + p + 1]) return 0;
  const N: number[] = [];
  for (let j = 0; j <= p; j++) N[j] = u >= U[i + j] && u < U[i + j + 1] ? 1 : 0;
  for (let k = 1; k <= p; k++) {
    let saved = N[0] === 0 ? 0 : ((u - U[i]) * N[0]) / (U[i + k] - U[i]);
    for (let j = 0; j < p - k + 1; j++) {
      const Ul = U[i + j + 1];
      const Ur = U[i + j + k + 1];
      if (N[j + 1] === 0) {
        N[j] = saved;
        saved = 0;
      } else {
        const t = N[j + 1] / (Ur - Ul);
        N[j] = saved + (Ur - u) * t;
        saved = (u - Ul) * t;
      }
    }
  }
  return N[0];
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const x = [...b];
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [x[c], x[p]] = [x[p], x[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

// ---- Transforms ----------------------------------------------------------------------------

/** An affine transform: x' = a x + c y + e, y' = b x + d y + f. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const apply = (m: Mat, p: Vec): Vec => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
export const applyDir = (m: Mat, p: Vec): Vec => ({ x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y });
export const compose = (m: Mat, n: Mat): Mat => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
export const translation = (dx: number, dy: number): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export const rotation = (c: Vec, ang: number): Mat => {
  const k = Math.cos(ang);
  const s = Math.sin(ang);
  return { a: k, b: s, c: -s, d: k, e: c.x - k * c.x + s * c.y, f: c.y - s * c.x - k * c.y };
};
export const scaling = (c: Vec, sx: number, sy = sx): Mat => ({ a: sx, b: 0, c: 0, d: sy, e: c.x - sx * c.x, f: c.y - sy * c.y });
export function mirroring(p1: Vec, p2: Vec): Mat {
  const ang = angleTo(p1, p2);
  const k = Math.cos(2 * ang);
  const s = Math.sin(2 * ang);
  const m: Mat = { a: k, b: s, c: s, d: -k, e: 0, f: 0 };
  const q = apply(m, p1);
  return { ...m, e: p1.x - q.x, f: p1.y - q.y };
}
export const det = (m: Mat) => m.a * m.d - m.b * m.c;
/** The (uniform) scale of a similarity transform. */
export const scaleOf = (m: Mat) => Math.sqrt(Math.abs(det(m)));
export const mirrored = (m: Mat) => det(m) < 0;
export const angleOfMat = (m: Mat) => Math.atan2(m.b, m.a);
export function invert(m: Mat): Mat {
  const D = det(m) || 1e-300;
  return {
    a: m.d / D,
    b: -m.b / D,
    c: -m.c / D,
    d: m.a / D,
    e: (m.c * m.f - m.d * m.e) / D,
    f: (m.b * m.e - m.a * m.f) / D,
  };
}
/** Whether the transform keeps circles circles. */
export const isSimilarity = (m: Mat) => Math.abs(m.a * m.a + m.b * m.b - (m.c * m.c + m.d * m.d)) < 1e-9 * (m.a * m.a + m.b * m.b + 1) && Math.abs(m.a * m.c + m.b * m.d) < 1e-9 * (m.a * m.a + m.b * m.b + 1);

/**
 * An entity moved, turned, scaled or mirrored by a similarity transform.
 * Text stays readable when mirrored (MIRRTEXT off), as AutoCAD's default.
 */
export function transformEntity<T extends Entity>(e: T, m: Mat): T {
  const P = (p: Vec) => apply(m, p);
  const s = scaleOf(m);
  const rot = angleOfMat(m);
  const mir = mirrored(m);
  const ang = (a: number) => (mir ? rot - a : rot + a);
  switch (e.type) {
    case 'line':
      return { ...e, a: P(e.a), b: P(e.b) };
    case 'circle':
      return { ...e, c: P(e.c), r: e.r * s };
    case 'arc':
      return mir ? { ...e, c: P(e.c), r: e.r * s, start: wrapAngle(ang(e.end)), end: wrapAngle(ang(e.start)) } : { ...e, c: P(e.c), r: e.r * s, start: wrapAngle(ang(e.start)), end: wrapAngle(ang(e.end)) };
    case 'ellipse': {
      const major = applyDir(m, e.major);
      return mir ? { ...e, c: P(e.c), major, start: wrapAngle(-e.end), end: wrapAngle(-e.start) || TAU } : { ...e, c: P(e.c), major };
    }
    case 'pline':
      return { ...e, pts: e.pts.map((p) => ({ ...p, ...P(p), b: mir ? -p.b : p.b, ...(p.sw !== undefined ? { sw: p.sw * s, ew: (p.ew ?? 0) * s } : {}) })), width: e.width * s };
    case 'spline':
      return { ...e, ctrl: e.ctrl.map(P), ...(e.fit ? { fit: e.fit.map(P) } : {}) };
    case 'point':
      return { ...e, p: P(e.p) };
    case 'text':
    case 'attdef': {
      const t = transformText(e, m);
      return { ...e, ...t };
    }
    case 'mtext': {
      const dir = applyDir(m, { x: Math.cos(e.rot), y: Math.sin(e.rot) });
      const r = mir ? angleOf({ x: -dir.x, y: -dir.y }) : angleOf(dir);
      return { ...e, p: P(e.p), h: e.h * s, width: e.width * s, rot: mir ? readable(r) : r };
    }
    case 'insert': {
      const xdir = applyDir(m, { x: Math.cos(e.rot), y: Math.sin(e.rot) });
      const r = angleOf(xdir);
      return {
        ...e,
        p: P(e.p),
        rot: r,
        sx: e.sx * s,
        sy: (mir ? -e.sy : e.sy) * s,
        attribs: e.attribs.map((a) => ({ ...a, ...transformText(a, m) })),
        ...(e.dc !== undefined ? { dc: (e.dc ?? 0) * s, dr: (e.dr ?? 0) * s } : {}),
      };
    }
    case 'dim':
      return {
        ...e,
        p10: P(e.p10),
        p13: P(e.p13),
        p14: P(e.p14),
        p15: P(e.p15),
        ...(e.p16 ? { p16: P(e.p16) } : {}),
        text: P(e.text),
        rot: e.kind === 'linear' ? (mir ? rot - e.rot : rot + e.rot) : e.rot,
        block: undefined,
      };
    case 'hatch':
      return {
        ...e,
        loops: e.loops.map((l) =>
          l.kind === 'poly'
            ? { ...l, pts: l.pts.map((p) => ({ ...p, ...P(p), b: mir ? -p.b : p.b })) }
            : {
                ...l,
                edges: l.edges.map((ed) => {
                  if (ed.t === 'line') return { ...ed, a: P(ed.a), b: P(ed.b) };
                  if (ed.t === 'arc') {
                    const st = ed.ccw ? ed.start : -ed.start;
                    const en = ed.ccw ? ed.end : -ed.end;
                    // Normalize to counterclockwise, then transform.
                    const a0 = mir ? ang(en) : ang(st);
                    const a1 = mir ? ang(st) : ang(en);
                    return { t: 'arc' as const, c: P(ed.c), r: ed.r * s, start: wrapAngle(a0), end: wrapAngle(a1), ccw: true };
                  }
                  if (ed.t === 'ellipse') return { ...ed, c: P(ed.c), major: applyDir(m, ed.major), ccw: mir ? !ed.ccw : ed.ccw };
                  return { ...ed, ctrl: ed.ctrl.map(P) };
                }),
              },
        ),
        lines: e.lines.map((l) => ({ ...l, angle: mir ? rot - l.angle : rot + l.angle, base: P(l.base), offset: applyDir(m, l.offset), dashes: l.dashes.map((x) => x * s) })),
        angle: mir ? rot - e.angle : rot + e.angle,
        scale: e.scale * s,
      };
    case 'solid':
    case 'face':
      return { ...e, pts: e.pts.map(P) as [Vec, Vec, Vec, Vec] };
    case 'leader':
      return { ...e, pts: e.pts.map(P) };
    case 'xline':
    case 'ray':
      return { ...e, p: P(e.p), dir: norm(applyDir(m, e.dir)) };
  }
  return e;
}

/** Text placed by a transform, flipped back to read left to right when mirrored. */
function transformText<T extends { p: Vec; a: Vec; h: number; rot: number; halign: number; valign: number }>(t: T, m: Mat): Pick<T, 'p' | 'a' | 'h' | 'rot'> & { halign: T['halign'] } {
  const s = scaleOf(m);
  const dir = applyDir(m, { x: Math.cos(t.rot), y: Math.sin(t.rot) });
  let rot = angleOf(dir);
  const p = apply(m, t.p);
  const a = apply(m, t.a);
  if (mirrored(m)) {
    rot = readable(rot + Math.PI);
    // Swap left and right alignment, so the text sits where it did.
    const h = t.halign === 0 ? 2 : t.halign === 2 ? 0 : t.halign;
    if (t.halign === 0 && t.valign === 0) return { p, a: p, h: t.h * s, rot, halign: 2 as T['halign'] } as never;
    return { p, a, h: t.h * s, rot, halign: h as T['halign'] };
  }
  return { p, a, h: t.h * s, rot, halign: t.halign };
}

/** An angle turned so text along it reads left to right. */
function readable(a: number): number {
  const w = wrapAngle(a);
  return w > Math.PI / 2 + 1e-9 && w <= (3 * Math.PI) / 2 + 1e-9 ? wrapAngle(w - Math.PI) : w;
}

// ---- Bounds ----------------------------------------------------------------------------------

export interface Box {
  min: Vec;
  max: Vec;
}

export const emptyBox = (): Box => ({ min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } });
export function grow(b: Box, p: Vec) {
  if (p.x < b.min.x) b.min.x = p.x;
  if (p.y < b.min.y) b.min.y = p.y;
  if (p.x > b.max.x) b.max.x = p.x;
  if (p.y > b.max.y) b.max.y = p.y;
}
export const boxValid = (b: Box) => b.min.x <= b.max.x && b.min.y <= b.max.y;
export const boxesOverlap = (a: Box, b: Box) => a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y;
export const boxInside = (inner: Box, outer: Box) => inner.min.x >= outer.min.x && inner.max.x <= outer.max.x && inner.min.y >= outer.min.y && inner.max.y <= outer.max.y;

export function arcBox(c: Vec, r: number, a0: number, a1: number, b: Box) {
  grow(b, polar(c, r, a0));
  grow(b, polar(c, r, a1));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    if (onArc(a, a0, a1)) grow(b, polar(c, r, a));
  }
}

/** Polygon area (positive counterclockwise). */
export function polygonArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return s / 2;
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Points along a polyline, arcs broken into short lines. */
export function plinePoints(pts: PlineVertex[], closed: boolean, perArc = 32): Vec[] {
  const out: Vec[] = [];
  const n = pts.length;
  if (!n) return out;
  out.push({ x: pts[0].x, y: pts[0].y });
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    if (Math.abs(p.b) > 1e-12 && !same(p, q, 1e-12)) {
      const a = bulgeArc(p, q, p.b);
      const sw = sweep(a.a0, a.a1);
      const steps = Math.max(2, Math.ceil((perArc * sw) / TAU));
      for (let k = 1; k <= steps; k++) {
        const t = a.cw ? a.a1 - (sw * k) / steps : a.a0 + (sw * k) / steps;
        out.push(polar(a.c, a.r, t));
      }
    } else out.push({ x: q.x, y: q.y });
  }
  return out;
}
