/**
 * The modify tools' geometry: offset, trim, extend, break, fillet, chamfer,
 * join, explode, stretch and grips, on lines, arcs, circles, polylines and
 * ellipses (splines are offset and broken as polylines).
 */
import {
  BYBLOCK,
  BYLAYER,
  findBlock,
  findTextStyle,
  newId,
  type Arc,
  type Drawing,
  type Entity,
  type EntityBase,
  type Pline,
  type PlineVertex,
  type Text,
  type Vec,
} from './model';
import {
  TAU,
  add,
  angleTo,
  apply,
  bulgeArc,
  closestOnSeg,
  compose,
  cross,
  dist,
  dot,
  ellipseParam,
  ellipsePoint,
  ellipsePoints,
  entitySegs,
  intersect,
  isSimilarity,
  len,
  lerp,
  lineLine,
  mid,
  mul,
  norm,
  perp,
  plinePoints,
  polar,
  rotation,
  same,
  scaleOf,
  segEnd,
  segStart,
  splinePoints,
  sub,
  sweep,
  transformEntity,
  translation,
  wrapAngle,
  type Mat,
  type Seg,
} from './geom';
import { worldSegs } from './snap';
import { dimGeometry, leaderArrow } from './dim';
import { mtextPlain } from './text';

type Base = Omit<EntityBase, 'id'>;
const baseOf = (e: Entity): Base => ({ layer: e.layer, color: e.color, linetype: e.linetype, lineweight: e.lineweight, ltscale: e.ltscale, ...(e.hidden ? { hidden: true } : {}) });

// ---- Curves as runs of segments --------------------------------------------------------

interface Curve {
  segs: Seg[];
  closed: boolean;
}

export function curveOf(e: Entity): Curve | null {
  switch (e.type) {
    case 'line':
      return { segs: [{ k: 'line', a: e.a, b: e.b }], closed: false };
    case 'arc':
      return { segs: [{ k: 'arc', c: e.c, r: e.r, a0: e.start, a1: e.end }], closed: false };
    case 'circle':
      return { segs: [{ k: 'arc', c: e.c, r: e.r, a0: 0, a1: TAU }], closed: true };
    case 'pline':
      return { segs: entitySegs(e), closed: e.closed };
    case 'spline':
    case 'ellipse': {
      const pts = e.type === 'spline' ? splinePoints(e.degree, e.knots, e.ctrl, e.weights, 128) : ellipsePoints(e.c, e.major, e.ratio, e.start, e.end, 128);
      const closed = e.type === 'spline' ? e.closed : Math.abs(sweep(e.start, e.end) - TAU) < 1e-9;
      const segs: Seg[] = [];
      for (let i = 0; i + 1 < pts.length; i++) if (!same(pts[i], pts[i + 1], 1e-12)) segs.push({ k: 'line', a: pts[i], b: pts[i + 1] });
      return { segs, closed };
    }
    default:
      return null;
  }
}

/** Where a point lies along a segment, 0 to 1 in its direction of travel. */
function fracOf(s: Seg, p: Vec): number {
  if (s.k === 'line') {
    const d = sub(s.b, s.a);
    return dot(sub(p, s.a), d) / (dot(d, d) || 1);
  }
  const a = angleTo(s.c, p);
  const sw = sweep(s.a0, s.a1);
  return s.cw ? wrapAngle(s.a1 - a) / sw : wrapAngle(a - s.a0) / sw;
}

function subSeg(s: Seg, f0: number, f1: number): Seg {
  if (s.k === 'line') return { k: 'line', a: lerp(s.a, s.b, f0), b: lerp(s.a, s.b, f1) };
  const sw = sweep(s.a0, s.a1);
  if (s.cw) {
    const start = s.a1 - sw * f0;
    const end = s.a1 - sw * f1;
    return { k: 'arc', c: s.c, r: s.r, a0: wrapAngle(end), a1: wrapAngle(start), cw: true };
  }
  return { k: 'arc', c: s.c, r: s.r, a0: wrapAngle(s.a0 + sw * f0), a1: wrapAngle(s.a0 + sw * f1) };
}

/** The curve's parameter (segment index plus fraction) nearest a point. */
function paramOf(c: Curve, p: Vec): number {
  let best = 0;
  let bd = Infinity;
  c.segs.forEach((s, i) => {
    const q = closestOnSeg(s, p);
    const d = dist(q, p);
    if (d < bd) {
      bd = d;
      best = i + Math.max(0, Math.min(1, fracOf(s, q)));
    }
  });
  return best;
}

/** The curve between two parameters (t0 < t1, or wrapping round a closed curve). */
function piece(c: Curve, t0: number, t1: number): Seg[] {
  const n = c.segs.length;
  const out: Seg[] = [];
  if (t1 < t0 && c.closed) return [...piece(c, t0, n), ...piece(c, 0, t1)];
  for (let i = Math.floor(t0); i < Math.min(n, Math.ceil(t1)); i++) {
    const f0 = Math.max(0, t0 - i);
    const f1 = Math.min(1, t1 - i);
    if (f1 - f0 > 1e-9) out.push(subSeg(c.segs[i], f0, f1));
  }
  return out;
}

/** Segments back into an entity: a line, an arc, or a polyline. */
function fromSegs(segs: Seg[], base: Base, closed = false): Entity | null {
  if (!segs.length) return null;
  if (segs.length === 1 && !closed) {
    const s = segs[0];
    if (s.k === 'line') return dist(s.a, s.b) < 1e-9 ? null : { ...base, id: newId(), type: 'line', a: s.a, b: s.b };
    if (sweep(s.a0, s.a1) < 1e-9) return null;
    return { ...base, id: newId(), type: 'arc', c: s.c, r: s.r, start: s.a0, end: s.a1 };
  }
  const pts: PlineVertex[] = [];
  for (const s of segs) {
    const a = segStart(s);
    const b = s.k === 'arc' ? Math.tan(sweep(s.a0, s.a1) / 4) * (s.cw ? -1 : 1) : 0;
    pts.push({ x: a.x, y: a.y, b });
  }
  if (!closed) {
    const e = segEnd(segs[segs.length - 1]);
    pts.push({ x: e.x, y: e.y, b: 0 });
  }
  return { ...base, id: newId(), type: 'pline', pts, closed, width: 0 };
}

/** Rebuild a curve-like entity of the same kind where that's possible. */
function rebuild(e: Entity, segs: Seg[], closed = false): Entity | null {
  if (e.type === 'pline') {
    const r = fromSegs(segs, baseOf(e), closed);
    if (r && r.type !== 'pline') return { ...baseOf(e), id: newId(), type: 'pline', pts: plinePts(segs), closed, width: e.width };
    return r && r.type === 'pline' ? { ...r, width: e.width } : r;
  }
  if (e.type === 'ellipse' && segs.length) {
    // Keep it an ellipse: map the ends back to parameters.
    const s0 = ellipseParam(e.c, e.major, e.ratio, segStart(segs[0]));
    const s1 = ellipseParam(e.c, e.major, e.ratio, segEnd(segs[segs.length - 1]));
    return { ...e, id: newId(), start: s0, end: s1 };
  }
  return fromSegs(segs, baseOf(e), closed);
}

function plinePts(segs: Seg[]): PlineVertex[] {
  const pts: PlineVertex[] = segs.map((s) => {
    const a = segStart(s);
    return { x: a.x, y: a.y, b: s.k === 'arc' ? Math.tan(sweep(s.a0, s.a1) / 4) * (s.cw ? -1 : 1) : 0 };
  });
  const e = segEnd(segs[segs.length - 1]);
  pts.push({ x: e.x, y: e.y, b: 0 });
  return pts;
}

// ---- Trim and extend -------------------------------------------------------------------

/** Params where the curve meets the edges, sorted. */
function crossings(c: Curve, edges: Seg[]): number[] {
  const ts: number[] = [];
  c.segs.forEach((s, i) => {
    for (const ed of edges) for (const p of intersect(s, ed)) ts.push(i + Math.max(0, Math.min(1, fracOf(s, p))));
  });
  ts.sort((a, b) => a - b);
  // Tangent edges land as two crossings a hair apart; count them once.
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-6);
}

/**
 * Trim the piece of `e` picked at `p` back to the nearest cutting edges.
 * Returns what replaces it ([] erases it), or null if it can't be trimmed.
 */
export function trim(e: Entity, p: Vec, edges: Seg[]): Entity[] | null {
  if (e.type === 'xline' || e.type === 'ray') return trimInfinite(e, p, edges);
  const c = curveOf(e);
  if (!c || !c.segs.length) return null;
  const n = c.segs.length;
  const ts = crossings(c, edges).filter((t) => (c.closed ? true : t > 1e-9 && t < n - 1e-9));
  const tp = paramOf(c, p);
  if (!ts.length) return [];
  if (c.closed) {
    if (ts.length < 2 && e.type !== 'pline') return null;
    let lo = -Infinity;
    let hi = Infinity;
    for (const t of ts) {
      if (t < tp && t > lo) lo = t;
      if (t > tp && t < hi) hi = t;
    }
    if (lo === -Infinity) lo = ts[ts.length - 1];
    if (hi === Infinity) hi = ts[0];
    if (Math.abs(hi - lo) < 1e-9) return [];
    const segs = piece(c, hi, lo);
    const r = rebuild(e, segs);
    return r ? [r] : [];
  }
  let lo = 0;
  let hi = n;
  for (const t of ts) {
    if (t < tp && t > lo) lo = t;
    if (t > tp && t < hi) hi = t;
  }
  const out: Entity[] = [];
  if (lo > 1e-9) {
    const r = rebuild(e, piece(c, 0, lo));
    if (r) out.push(r);
  }
  if (hi < n - 1e-9) {
    const r = rebuild(e, piece(c, hi, n));
    if (r) out.push(r);
  }
  return out;
}

function trimInfinite(e: Extract<Entity, { type: 'xline' | 'ray' }>, p: Vec, edges: Seg[]): Entity[] {
  const u = norm(e.dir);
  const far = 1e8;
  const line: Seg = { k: 'line', a: e.type === 'ray' ? e.p : sub(e.p, mul(u, far)), b: add(e.p, mul(u, far)) };
  const ts = edges.flatMap((ed) => intersect(line, ed)).map((q) => dot(sub(q, e.p), u)).sort((a, b) => a - b);
  const tp = dot(sub(p, e.p), u);
  const lo = ts.filter((t) => t < tp).pop();
  const hi = ts.find((t) => t > tp);
  const base = baseOf(e);
  const out: Entity[] = [];
  if (lo !== undefined) {
    const end = add(e.p, mul(u, lo));
    if (e.type === 'ray') {
      if (lo > 0) out.push({ ...base, id: newId(), type: 'line', a: e.p, b: end });
    } else out.push({ ...base, id: newId(), type: 'ray', p: end, dir: mul(u, -1) });
  }
  if (hi !== undefined) out.push({ ...base, id: newId(), type: 'ray', p: add(e.p, mul(u, hi)), dir: u });
  return out;
}

/** Lengthen the end of `e` nearest `p` to the nearest boundary edge. */
export function extend(e: Entity, p: Vec, edges: Seg[]): Entity | null {
  if (e.type === 'line') {
    const atStart = dist(p, e.a) < dist(p, e.b);
    const from = atStart ? e.b : e.a;
    const end = atStart ? e.a : e.b;
    const u = norm(sub(end, from));
    const ray: Seg = { k: 'line', a: end, b: add(end, mul(u, 1e8)) };
    let best: Vec | null = null;
    let bd = Infinity;
    for (const ed of edges)
      for (const q of intersect(ray, ed)) {
        const t = dot(sub(q, end), u);
        if (t > 1e-9 && t < bd) {
          bd = t;
          best = q;
        }
      }
    if (!best) return null;
    return atStart ? { ...e, id: newId(), a: best } : { ...e, id: newId(), b: best };
  }
  if (e.type === 'arc') {
    const a0 = polar(e.c, e.r, e.start);
    const a1 = polar(e.c, e.r, e.end);
    const atStart = dist(p, a0) < dist(p, a1);
    const circle: Seg = { k: 'arc', c: e.c, r: e.r, a0: 0, a1: TAU };
    let best: number | null = null;
    let bd = Infinity;
    for (const ed of edges)
      for (const q of intersect(circle, ed)) {
        const a = angleTo(e.c, q);
        // How far beyond the end, going away from the arc.
        const gap = atStart ? wrapAngle(e.start - a) : wrapAngle(a - e.end);
        if (gap > 1e-9 && gap < sweep(e.end, e.start) - 1e-9 && gap < bd) {
          bd = gap;
          best = a;
        }
      }
    if (best === null) return null;
    return atStart ? { ...e, id: newId(), start: best } : { ...e, id: newId(), end: best };
  }
  if (e.type === 'pline' && !e.closed && e.pts.length >= 2) {
    const n = e.pts.length;
    const atStart = dist(p, e.pts[0]) < dist(p, e.pts[n - 1]);
    const i0 = atStart ? 1 : n - 2;
    const i1 = atStart ? 0 : n - 1;
    const seg = (atStart ? e.pts[0].b : e.pts[n - 2].b) === 0;
    if (!seg) return null;
    const line: Extract<Entity, { type: 'line' }> = { ...baseOf(e), id: 0, type: 'line', a: e.pts[i0], b: e.pts[i1] };
    const r = extend(line, e.pts[i1], edges);
    if (!r || r.type !== 'line') return null;
    const pts = e.pts.map((q) => ({ ...q }));
    pts[i1] = { ...pts[i1], x: r.b.x, y: r.b.y };
    return { ...e, id: newId(), pts };
  }
  return null;
}

/** The cutting or boundary edges of a set of entities. */
export function edgesOf(list: Entity[], d: Drawing): Seg[] {
  return list.flatMap((e) => worldSegs(e, d));
}

// ---- Offset ----------------------------------------------------------------------------

/** A copy of `e` offset by `distance` toward `side`. */
export function offset(e: Entity, distance: number, side: Vec): Entity | null {
  switch (e.type) {
    case 'line': {
      const n = norm(perp(sub(e.b, e.a)));
      const s = Math.sign(dot(sub(side, e.a), n)) || 1;
      const o = mul(n, distance * s);
      return { ...e, id: newId(), a: add(e.a, o), b: add(e.b, o) };
    }
    case 'circle':
    case 'arc': {
      const out = dist(side, e.c) > e.r;
      const r = e.r + (out ? distance : -distance);
      if (r <= 1e-9) return null;
      return { ...e, id: newId(), r };
    }
    case 'xline':
    case 'ray': {
      const n = norm(perp(e.dir));
      const s = Math.sign(dot(sub(side, e.p), n)) || 1;
      return { ...e, id: newId(), p: add(e.p, mul(n, distance * s)) };
    }
    case 'pline':
      return offsetPline(e, distance, side);
    case 'ellipse':
    case 'spline': {
      const pts = e.type === 'ellipse' ? ellipsePoints(e.c, e.major, e.ratio, e.start, e.end, 96) : splinePoints(e.degree, e.knots, e.ctrl, e.weights, 96);
      const closed = e.type === 'spline' ? e.closed : Math.abs(sweep(e.start, e.end) - TAU) < 1e-9;
      const pl: Pline = { ...baseOf(e), id: 0, type: 'pline', pts: pts.map((p) => ({ x: p.x, y: p.y, b: 0 })), closed, width: 0 };
      return offsetPline(pl, distance, side);
    }
    default:
      return null;
  }
}

function offsetPline(e: Pline, distance: number, side: Vec): Entity | null {
  const segs = entitySegs(e);
  if (!segs.length) return null;
  // Which side: the side point relative to the nearest segment.
  let near = segs[0];
  let nd = Infinity;
  for (const s of segs) {
    const d = dist(closestOnSeg(s, side), side);
    if (d < nd) {
      nd = d;
      near = s;
    }
  }
  const leftOf = (s: Seg, p: Vec) => {
    if (s.k === 'line') return cross(sub(s.b, s.a), sub(p, s.a)) > 0;
    // Left of travel on a counterclockwise arc is inside.
    const inside = dist(p, s.c) < s.r;
    return s.cw ? !inside : inside;
  };
  const sign = leftOf(near, side) ? 1 : -1;
  const shifted: Seg[] = [];
  for (const s of segs) {
    if (s.k === 'line') {
      const n = norm(perp(sub(s.b, s.a)));
      const o = mul(n, distance * sign);
      shifted.push({ k: 'line', a: add(s.a, o), b: add(s.b, o) });
    } else {
      // Left of a counterclockwise arc is toward the center.
      const toward = (sign > 0) !== !!s.cw;
      const r = s.r + (toward ? -distance : distance);
      if (r <= 1e-9) return null;
      shifted.push({ ...s, r });
    }
  }
  // Join neighbours at their intersections (or with a straight bridge).
  const pts: PlineVertex[] = [];
  const n = shifted.length;
  const corner = (a: Seg, b: Seg): Vec => {
    const ea = segEnd(a);
    const sb = segStart(b);
    if (same(ea, sb, 1e-9)) return ea;
    const xs = intersect(a, b, true);
    if (!xs.length) return mid(ea, sb);
    return xs.reduce((best, q) => (dist(q, ea) < dist(best, ea) ? q : best));
  };
  const starts: Vec[] = [];
  const ends: Vec[] = [];
  for (let i = 0; i < n; i++) {
    starts.push(i === 0 && !e.closed ? segStart(shifted[0]) : corner(shifted[(i - 1 + n) % n], shifted[i]));
    ends.push(i === n - 1 && !e.closed ? segEnd(shifted[n - 1]) : corner(shifted[i], shifted[(i + 1) % n]));
  }
  for (let i = 0; i < n; i++) {
    const s = shifted[i];
    let b = 0;
    if (s.k === 'arc') {
      const a0 = angleTo(s.c, starts[i]);
      const a1 = angleTo(s.c, ends[i]);
      const sw = s.cw ? -sweep(a1, a0) : sweep(a0, a1);
      b = Math.tan(sw / 4);
    }
    pts.push({ x: starts[i].x, y: starts[i].y, b });
  }
  if (!e.closed) pts.push({ x: ends[n - 1].x, y: ends[n - 1].y, b: 0 });
  return { ...e, id: newId(), pts };
}

// ---- Fillet and chamfer ----------------------------------------------------------------

interface Corner {
  x: Vec;
  /** Unit directions from the corner along each line, toward what's kept. */
  u1: Vec;
  u2: Vec;
  far1: Vec;
  far2: Vec;
}

function corner(l1: Extract<Entity, { type: 'line' }>, p1: Vec, l2: Extract<Entity, { type: 'line' }>, p2: Vec): Corner | string {
  const x = lineLine(l1.a, l1.b, l2.a, l2.b);
  if (!x) return 'The lines are parallel.';
  const side = (l: { a: Vec; b: Vec }, pick: Vec) => {
    const u = norm(sub(l.b, l.a));
    const pp = dot(sub(pick, x.p), u);
    const dir = pp >= 0 ? u : mul(u, -1);
    const ta = dot(sub(l.a, x.p), dir);
    const tb = dot(sub(l.b, x.p), dir);
    return { dir, far: ta > tb ? l.a : l.b };
  };
  const s1 = side(l1, p1);
  const s2 = side(l2, p2);
  return { x: x.p, u1: s1.dir, u2: s2.dir, far1: s1.far, far2: s2.far };
}

/** Round the corner between two lines; returns the two lines and the arc, or a reason it can't. */
export function fillet(l1: Entity, p1: Vec, l2: Entity, p2: Vec, r: number): Entity[] | string {
  if (l1.type !== 'line' || l2.type !== 'line') return 'Fillet works on lines here.';
  const c = corner(l1, p1, l2, p2);
  if (typeof c === 'string') return c;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(c.u1, c.u2))));
  if (theta < 1e-9 || theta > Math.PI - 1e-9) return 'The lines are parallel.';
  const t = r / Math.tan(theta / 2);
  const t1 = add(c.x, mul(c.u1, t));
  const t2 = add(c.x, mul(c.u2, t));
  if (dot(sub(c.far1, c.x), c.u1) < t - 1e-9 || dot(sub(c.far2, c.x), c.u2) < t - 1e-9) return 'The radius is too large.';
  const out: Entity[] = [
    { ...l1, id: newId(), a: c.far1, b: t1 },
    { ...l2, id: newId(), a: c.far2, b: t2 },
  ];
  if (r > 1e-12) {
    const bis = norm(add(c.u1, c.u2));
    const center = add(c.x, mul(bis, r / Math.sin(theta / 2)));
    let a0 = angleTo(center, t1);
    let a1 = angleTo(center, t2);
    if (sweep(a0, a1) > Math.PI) [a0, a1] = [a1, a0];
    out.push({ ...baseOf(l1), id: newId(), type: 'arc', c: center, r, start: a0, end: a1 } as Arc);
  }
  return out;
}

export function chamfer(l1: Entity, p1: Vec, l2: Entity, p2: Vec, d1: number, d2: number): Entity[] | string {
  if (l1.type !== 'line' || l2.type !== 'line') return 'Chamfer works on lines here.';
  const c = corner(l1, p1, l2, p2);
  if (typeof c === 'string') return c;
  if (dot(sub(c.far1, c.x), c.u1) < d1 - 1e-9 || dot(sub(c.far2, c.x), c.u2) < d2 - 1e-9) return 'The distances are too large.';
  const t1 = add(c.x, mul(c.u1, d1));
  const t2 = add(c.x, mul(c.u2, d2));
  const out: Entity[] = [
    { ...l1, id: newId(), a: c.far1, b: t1 },
    { ...l2, id: newId(), a: c.far2, b: t2 },
  ];
  if (d1 > 1e-12 || d2 > 1e-12) out.push({ ...baseOf(l1), id: newId(), type: 'line', a: t1, b: t2 });
  return out;
}

// ---- Break and join --------------------------------------------------------------------

/** Break `e` between two points on it (the same point splits it in two). */
export function breakAt(e: Entity, a: Vec, b: Vec): Entity[] | null {
  const c = curveOf(e);
  if (!c) return null;
  const n = c.segs.length;
  let t0 = paramOf(c, a);
  let t1 = paramOf(c, b);
  if (c.closed) {
    if (Math.abs(t1 - t0) < 1e-9) return null;
    if (e.type === 'circle') {
      // AutoCAD breaks circles counterclockwise from the first point.
      const seg = c.segs[0] as Extract<Seg, { k: 'arc' }>;
      const a0 = angleTo(seg.c, a);
      const a1 = angleTo(seg.c, b);
      return [{ ...baseOf(e), id: newId(), type: 'arc', c: e.c, r: e.r, start: a1, end: a0 }];
    }
    const r = rebuild(e, piece(c, t1, t0));
    return r ? [r] : [];
  }
  if (t1 < t0) [t0, t1] = [t1, t0];
  const out: Entity[] = [];
  const first = t0 > 1e-9 ? rebuild(e, piece(c, 0, t0)) : null;
  const second = t1 < n - 1e-9 ? rebuild(e, piece(c, t1, n)) : null;
  if (first) out.push(first);
  if (second) out.push(second);
  return out;
}

/** Join lines, arcs and open polylines that meet end to end into one polyline (or one line, if they're in line). */
export function join(list: Entity[], tol = 1e-6): Entity | null {
  const curves = list.filter((e) => e.type === 'line' || e.type === 'arc' || (e.type === 'pline' && !e.closed));
  if (curves.length < 2) return null;
  const segRuns = curves.map((e) => curveOf(e)!.segs);
  let chain = segRuns.shift()!;
  let changed = true;
  while (segRuns.length && changed) {
    changed = false;
    for (let i = 0; i < segRuns.length; i++) {
      const run = segRuns[i];
      const cs = segStart(chain[0]);
      const ce = segEnd(chain[chain.length - 1]);
      const rs = segStart(run[0]);
      const re = segEnd(run[run.length - 1]);
      if (dist(ce, rs) <= tol) chain = [...chain, ...run];
      else if (dist(ce, re) <= tol) chain = [...chain, ...reverseSegs(run)];
      else if (dist(cs, re) <= tol) chain = [...run, ...chain];
      else if (dist(cs, rs) <= tol) chain = [...reverseSegs(run), ...chain];
      else continue;
      segRuns.splice(i, 1);
      changed = true;
      break;
    }
  }
  if (segRuns.length) return null;
  const base = baseOf(curves[0]);
  // All collinear lines make one line.
  if (chain.every((s) => s.k === 'line')) {
    const a = segStart(chain[0]);
    const b = segEnd(chain[chain.length - 1]);
    const u = norm(sub(b, a));
    if (chain.every((s) => Math.abs(cross(u, sub(segEnd(s), a))) < tol * 10)) return { ...base, id: newId(), type: 'line', a, b };
  }
  const closed = dist(segStart(chain[0]), segEnd(chain[chain.length - 1])) <= tol;
  return fromSegs(chain, base, closed) ?? null;
}

function reverseSegs(segs: Seg[]): Seg[] {
  return [...segs].reverse().map((s) => (s.k === 'line' ? { k: 'line', a: s.b, b: s.a } : { ...s, cw: !s.cw }));
}

// ---- Explode ---------------------------------------------------------------------------

/** What an entity breaks down into, or null if it doesn't. */
export function explode(e: Entity, d: Drawing): Entity[] | null {
  switch (e.type) {
    case 'pline': {
      const segs = entitySegs(e);
      return segs.map((s) => fromSegs([s], baseOf(e))).filter((x): x is Entity => !!x);
    }
    case 'insert': {
      const b = findBlock(d, e.block);
      if (!b) return null;
      const out: Entity[] = [];
      const cols = Math.max(1, e.cols ?? 1);
      const rows = Math.max(1, e.rows ?? 1);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const m: Mat = compose(compose(compose(translation(e.p.x, e.p.y), rotation({ x: 0, y: 0 }, e.rot)), translation(c * (e.dc ?? 0), r * (e.dr ?? 0))), { a: e.sx, b: 0, c: 0, d: e.sy, e: -b.base.x * e.sx, f: -b.base.y * e.sy });
          for (const be of b.entities) {
            if (be.type === 'attdef') continue;
            const inherit = (x: Entity): Entity => ({
              ...x,
              layer: x.layer === '0' ? e.layer : x.layer,
              color: x.color === BYBLOCK ? e.color : x.color,
              linetype: /^byblock$/i.test(x.linetype) ? e.linetype : x.linetype,
            });
            for (const t of transformAny(be, m)) out.push(inherit(t));
          }
        }
      for (const a of e.attribs) {
        if (a.flags & 1) continue;
        const { tag: _tag, flags: _flags, ...rest } = a;
        out.push({ ...rest, id: newId(), type: 'text' } as Text);
      }
      return out;
    }
    case 'dim': {
      const b = e.block ? findBlock(d, e.block) : undefined;
      const ents = b ? b.entities : dimGeometry(e, d);
      return ents.map((x) => ({ ...x, id: newId(), layer: x.layer === '0' ? e.layer : x.layer, color: x.color === BYBLOCK ? e.color : x.color }));
    }
    case 'leader': {
      const lines: Entity[] = [];
      for (let i = 0; i + 1 < e.pts.length; i++) lines.push({ ...baseOf(e), id: newId(), type: 'line', a: e.pts[i], b: e.pts[i + 1] });
      if (e.arrow) lines.push(...leaderArrow(e.pts, d, e.style).map((x) => ({ ...x, id: newId(), layer: e.layer, color: e.color })));
      return lines;
    }
    case 'mtext': {
      const style = findTextStyle(d, e.style);
      void style;
      const lines = mtextPlain(e.text).split('\n');
      const pitch = (5 / 3) * e.h * (e.spacing || 1);
      const dir = { x: Math.cos(e.rot), y: Math.sin(e.rot) };
      const down = { x: Math.sin(e.rot), y: -Math.cos(e.rot) };
      const halign = (((e.attach - 1) % 3) as 0 | 1 | 2);
      return lines.map((s, i) => {
        const p = add(e.p, mul(down, e.h + pitch * i));
        void dir;
        return { ...baseOf(e), id: newId(), type: 'text', p, a: p, h: e.h, rot: e.rot, text: s, style: e.style, wf: 1, oblique: 0, halign, valign: 0 } as Text;
      });
    }
    case 'hatch':
      return null;
    default:
      return null;
  }
}

/** Transform anything, turning circles and arcs into ellipses under a non-uniform scale. */
export function transformAny(e: Entity, m: Mat): Entity[] {
  if (isSimilarity(m)) return [transformEntity({ ...e, id: newId() }, m)];
  if (e.type === 'circle' || e.type === 'arc') {
    const c = apply(m, e.c);
    const xa = sub(apply(m, add(e.c, { x: e.r, y: 0 })), c);
    const ya = sub(apply(m, add(e.c, { x: 0, y: e.r })), c);
    const major = len(xa) >= len(ya) ? xa : ya;
    const ratio = Math.min(len(xa), len(ya)) / Math.max(len(xa), len(ya));
    if (e.type === 'circle') return [{ ...baseOf(e), id: newId(), type: 'ellipse', c, major, ratio, start: 0, end: TAU }];
    const pts = plinePoints([{ ...polar(e.c, e.r, e.start), b: Math.tan(sweep(e.start, e.end) / 4) }, { ...polar(e.c, e.r, e.end), b: 0 }], false, 64).map((p) => apply(m, p));
    return [{ ...baseOf(e), id: newId(), type: 'pline', pts: pts.map((p) => ({ ...p, b: 0 })), closed: false, width: 0 }];
  }
  if (e.type === 'pline' && e.pts.some((p) => p.b !== 0)) {
    const pts = plinePoints(e.pts, e.closed, 64).map((p) => apply(m, p));
    if (e.closed) pts.pop();
    return [{ ...e, id: newId(), pts: pts.map((p) => ({ ...p, b: 0 })) }];
  }
  if (e.type === 'line') return [{ ...e, id: newId(), a: apply(m, e.a), b: apply(m, e.b) }];
  if (e.type === 'pline') return [{ ...e, id: newId(), pts: e.pts.map((p) => ({ ...p, ...apply(m, p) })) }];
  if (e.type === 'ellipse') {
    const pts = ellipsePoints(e.c, e.major, e.ratio, e.start, e.end, 96).map((p) => apply(m, p));
    return [{ ...baseOf(e), id: newId(), type: 'pline', pts: pts.map((p) => ({ ...p, b: 0 })), closed: false, width: 0 }];
  }
  if (e.type === 'spline') return [{ ...e, id: newId(), ctrl: e.ctrl.map((p) => apply(m, p)) }];
  if (e.type === 'point') return [{ ...e, id: newId(), p: apply(m, e.p) }];
  if (e.type === 'solid' || e.type === 'face') return [{ ...e, id: newId(), pts: e.pts.map((p) => apply(m, p)) as [Vec, Vec, Vec, Vec] }];
  // Text and the rest: place by the transform's rotation and average scale.
  const s = scaleOf(m);
  const ang = Math.atan2(m.b, m.a);
  const sim: Mat = compose(translation(m.e, m.f), compose(rotation({ x: 0, y: 0 }, ang), { a: s, b: 0, c: 0, d: s, e: 0, f: 0 }));
  return [transformEntity({ ...e, id: newId() }, sim)];
}

// ---- Stretch ---------------------------------------------------------------------------

/** STRETCH: points inside the window move by `delta`; entities wholly inside move entirely. */
export function stretch(e: Entity, min: Vec, max: Vec, delta: Vec): Entity {
  const inside = (p: Vec) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
  const mv = (p: Vec) => (inside(p) ? add(p, delta) : p);
  const all = transformEntity({ ...e, id: newId() }, translation(delta.x, delta.y));
  switch (e.type) {
    case 'line':
      return { ...e, id: newId(), a: mv(e.a), b: mv(e.b) };
    case 'pline':
      return { ...e, id: newId(), pts: e.pts.map((p) => ({ ...p, ...mv(p) })) };
    case 'arc': {
      const a = polar(e.c, e.r, e.start);
      const b = polar(e.c, e.r, e.end);
      if (inside(a) && inside(b)) return all;
      if (!inside(a) && !inside(b)) return e;
      const m = polar(e.c, e.r, e.start + sweep(e.start, e.end) / 2);
      const na = mv(a);
      const nb = mv(b);
      const c = circleFrom3(na, m, nb);
      if (!c) return e;
      return { ...e, id: newId(), c: c.c, r: c.r, start: angleTo(c.c, na), end: angleTo(c.c, nb) };
    }
    case 'dim':
      return { ...e, id: newId(), p10: mv(e.p10), p13: mv(e.p13), p14: mv(e.p14), p15: mv(e.p15), text: mv(e.text), block: undefined };
    case 'solid':
    case 'face':
      return { ...e, id: newId(), pts: e.pts.map(mv) as [Vec, Vec, Vec, Vec] };
    case 'leader':
      return { ...e, id: newId(), pts: e.pts.map(mv) };
    default: {
      const anchor = anchorOf(e);
      return anchor && inside(anchor) ? all : e;
    }
  }
}

function circleFrom3(a: Vec, b: Vec, c: Vec) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ctr = { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
  return { c: ctr, r: dist(ctr, a) };
}

/** The point an entity hangs on, for STRETCH and the like. */
export function anchorOf(e: Entity): Vec | null {
  switch (e.type) {
    case 'circle':
    case 'arc':
    case 'ellipse':
      return e.c;
    case 'text':
    case 'attdef':
    case 'mtext':
    case 'insert':
    case 'point':
      return e.p;
    case 'xline':
    case 'ray':
      return e.p;
    case 'spline':
      return e.ctrl[0] ?? null;
    case 'hatch': {
      const l = e.loops[0];
      if (!l) return null;
      return l.kind === 'poly' ? l.pts[0] ?? null : l.edges[0] ? (l.edges[0].t === 'line' ? l.edges[0].a : l.edges[0].t === 'spline' ? l.edges[0].ctrl[0] : l.edges[0].c) : null;
    }
    default:
      return null;
  }
}

// ---- Grips -----------------------------------------------------------------------------

export interface Grip {
  p: Vec;
  /** The entity with this grip moved to `to`. */
  move: (to: Vec) => Entity;
}

export function grips(e: Entity): Grip[] {
  const mv = (d: Vec) => transformEntity({ ...e, id: e.id }, translation(d.x, d.y));
  switch (e.type) {
    case 'line':
      return [
        { p: e.a, move: (to) => ({ ...e, a: to }) },
        { p: mid(e.a, e.b), move: (to) => mv(sub(to, mid(e.a, e.b))) },
        { p: e.b, move: (to) => ({ ...e, b: to }) },
      ];
    case 'circle':
      return [
        { p: e.c, move: (to) => ({ ...e, c: to }) },
        ...[0, 1, 2, 3].map((k) => {
          const p = polar(e.c, e.r, (k * Math.PI) / 2);
          return { p, move: (to: Vec) => ({ ...e, r: Math.max(1e-9, dist(e.c, to)) }) };
        }),
      ];
    case 'arc': {
      const a = polar(e.c, e.r, e.start);
      const b = polar(e.c, e.r, e.end);
      const m = polar(e.c, e.r, e.start + sweep(e.start, e.end) / 2);
      const refit = (na: Vec, nm: Vec, nb: Vec): Entity => {
        const c = circleFrom3(na, nm, nb);
        if (!c) return e;
        const s = angleTo(c.c, na);
        const en = angleTo(c.c, nb);
        const am = angleTo(c.c, nm);
        const ccw = wrapAngle(am - s) <= sweep(s, en);
        return ccw ? { ...e, c: c.c, r: c.r, start: s, end: en } : { ...e, c: c.c, r: c.r, start: en, end: s };
      };
      return [
        { p: a, move: (to) => refit(to, m, b) },
        { p: m, move: (to) => refit(a, to, b) },
        { p: b, move: (to) => refit(a, m, to) },
        { p: e.c, move: (to) => ({ ...e, c: to }) },
      ];
    }
    case 'ellipse':
      return [
        { p: e.c, move: (to) => ({ ...e, c: to }) },
        { p: add(e.c, e.major), move: (to) => ({ ...e, major: sub(to, e.c) }) },
        { p: ellipsePoint(e.c, e.major, e.ratio, Math.PI / 2), move: (to) => ({ ...e, ratio: Math.max(1e-6, Math.min(1, dist(e.c, to) / len(e.major))) }) },
      ];
    case 'pline': {
      const out: Grip[] = e.pts.map((p, i) => ({ p, move: (to: Vec) => ({ ...e, pts: e.pts.map((q, j) => (j === i ? { ...q, x: to.x, y: to.y } : q)) }) }));
      const n = e.pts.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const p = e.pts[i];
        const q = e.pts[(i + 1) % n];
        if (p.b !== 0) {
          const a = bulgeArc(p, q, p.b);
          const m = polar(a.c, a.r, a.a0 + sweep(a.a0, a.a1) / 2);
          out.push({
            p: m,
            move: (to) => {
              const c = circleFrom3(p, to, q);
              if (!c) return { ...e, pts: e.pts.map((v, j) => (j === i ? { ...v, b: 0 } : v)) };
              const a0 = angleTo(c.c, p);
              const a1 = angleTo(c.c, q);
              const ccw = wrapAngle(angleTo(c.c, to) - a0) <= sweep(a0, a1);
              const b = Math.tan((ccw ? sweep(a0, a1) : -sweep(a1, a0)) / 4);
              return { ...e, pts: e.pts.map((v, j) => (j === i ? { ...v, b } : v)) };
            },
          });
        } else {
          const m = mid(p, q);
          out.push({ p: m, move: (to) => ({ ...e, pts: e.pts.map((v, j) => (j === i ? { ...v, x: v.x + to.x - m.x, y: v.y + to.y - m.y } : j === (i + 1) % n ? { ...v, x: v.x + to.x - m.x, y: v.y + to.y - m.y } : v)) }) });
        }
      }
      return out;
    }
    case 'spline':
      return e.ctrl.map((p, i) => ({ p, move: (to: Vec) => ({ ...e, fit: undefined, ctrl: e.ctrl.map((q, j) => (j === i ? to : q)) }) }));
    case 'point':
      return [{ p: e.p, move: (to) => ({ ...e, p: to }) }];
    case 'text':
    case 'attdef': {
      const aligned = e.halign !== 0 || e.valign !== 0;
      const g: Grip[] = [{ p: e.p, move: (to) => mv(sub(to, e.p)) }];
      if (aligned) g.push({ p: e.a, move: (to) => (e.halign === 3 || e.halign === 5 ? { ...e, a: to } : mv(sub(to, e.a))) });
      return g;
    }
    case 'mtext':
      return [{ p: e.p, move: (to) => ({ ...e, p: to }) }];
    case 'insert':
      return [{ p: e.p, move: (to) => mv(sub(to, e.p)) }, ...e.attribs.map((a, i) => ({ p: a.p, move: (to: Vec) => ({ ...e, attribs: e.attribs.map((x, j) => (j === i ? { ...x, p: add(x.p, sub(to, a.p)), a: add(x.a, sub(to, a.p)) } : x)) }) }))];
    case 'dim':
      return [
        { p: e.p13, move: (to) => ({ ...e, p13: to, block: undefined }) },
        { p: e.p14, move: (to) => ({ ...e, p14: to, block: undefined }) },
        { p: e.p10, move: (to) => ({ ...e, p10: to, block: undefined }) },
        { p: e.text, move: (to) => ({ ...e, text: to, textMoved: true, block: undefined }) },
      ];
    case 'leader':
      return e.pts.map((p, i) => ({ p, move: (to: Vec) => ({ ...e, pts: e.pts.map((q, j) => (j === i ? to : q)) }) }));
    case 'solid':
    case 'face':
      return e.pts.map((p, i) => ({ p, move: (to: Vec) => ({ ...e, pts: e.pts.map((q, j) => (j === i ? to : q)) as [Vec, Vec, Vec, Vec] }) }));
    case 'xline':
    case 'ray':
      return [
        { p: e.p, move: (to) => ({ ...e, p: to }) },
        { p: add(e.p, norm(e.dir)), move: (to) => ({ ...e, dir: norm(sub(to, e.p)) }) },
      ];
    case 'hatch': {
      const a = anchorOf(e);
      return a ? [{ p: a, move: (to) => mv(sub(to, a)) }] : [];
    }
  }
  return [];
}

export { BYLAYER };
