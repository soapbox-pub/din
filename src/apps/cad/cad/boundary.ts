/**
 * HATCH's and BOUNDARY's "pick internal point": the smallest closed region
 * around a point, made of whatever lines, arcs and curves enclose it, with
 * the closed shapes inside it as islands.
 */
import type { Drawing, Entity, HatchLoop, Vec } from './model';
import { dist, ellipsePoints, plinePoints, pointInPolygon, polygonArea, splinePoints, TAU, sweep, type Seg } from './geom';
import { worldSegs } from './snap';

/** A closed entity's outline as a polygon and as a hatch loop. */
function closedShape(e: Entity): { poly: Vec[]; loop: HatchLoop } | null {
  switch (e.type) {
    case 'circle': {
      const pts = [
        { x: e.c.x + e.r, y: e.c.y, b: 1 },
        { x: e.c.x - e.r, y: e.c.y, b: 1 },
      ];
      return { poly: plinePoints(pts, true, 64), loop: { kind: 'poly', pts, closed: true, flags: 1 } };
    }
    case 'pline':
      if (!e.closed && !(e.pts.length > 2 && dist(e.pts[0], e.pts[e.pts.length - 1]) < 1e-9)) return null;
      return { poly: plinePoints(e.pts, true, 64), loop: { kind: 'poly', pts: e.pts.map((p) => ({ x: p.x, y: p.y, b: p.b })), closed: true, flags: 1 } };
    case 'ellipse': {
      if (Math.abs(sweep(e.start, e.end) - TAU) > 1e-9) return null;
      const poly = ellipsePoints(e.c, e.major, e.ratio, 0, TAU, 96);
      return { poly, loop: { kind: 'edges', edges: [{ t: 'ellipse', c: e.c, major: e.major, ratio: e.ratio, start: 0, end: TAU, ccw: true }], flags: 1 } };
    }
    case 'spline': {
      if (!e.closed) return null;
      const poly = splinePoints(e.degree, e.knots, e.ctrl, e.weights, 96);
      return { poly, loop: { kind: 'poly', pts: poly.map((p) => ({ x: p.x, y: p.y, b: 0 })), closed: true, flags: 1 } };
    }
    default:
      return null;
  }
}

export interface Region {
  loops: HatchLoop[];
  /** The outer outline, for previews. */
  outer: Vec[];
}

/**
 * The region around `p` among `entities`: first closed shapes (the smallest
 * holding the point), then a face of the network the open curves make.
 */
export function findRegion(d: Drawing, entities: Entity[], p: Vec): Region | null {
  const shapes = entities.map((e) => ({ e, s: closedShape(e) })).filter((x): x is { e: Entity; s: NonNullable<ReturnType<typeof closedShape>> } => !!x.s);
  const holding = shapes.filter((x) => pointInPolygon(p, x.s.poly)).sort((a, b) => Math.abs(polygonArea(a.s.poly)) - Math.abs(polygonArea(b.s.poly)));
  const face = traceFace(d, entities, p);
  const outerShape = holding[0];
  // A traced face smaller than the smallest closed shape wins (lines across a circle, say).
  let outer: Vec[] | null = null;
  let outerLoop: HatchLoop | null = null;
  if (face && (!outerShape || Math.abs(polygonArea(face)) < Math.abs(polygonArea(outerShape.s.poly)) - 1e-9)) {
    outer = face;
    outerLoop = { kind: 'poly', pts: face.map((q) => ({ x: q.x, y: q.y, b: 0 })), closed: true, flags: 1 | 16 };
  } else if (outerShape) {
    outer = outerShape.s.poly;
    outerLoop = { ...outerShape.s.loop, flags: 1 | 16 } as HatchLoop;
  }
  if (!outer || !outerLoop) return null;
  const loops: HatchLoop[] = [outerLoop];
  // Islands: closed shapes inside the outline that don't hold the point, outermost only.
  const area = Math.abs(polygonArea(outer));
  const inside = shapes.filter((x) => x !== outerShape && !pointInPolygon(p, x.s.poly) && Math.abs(polygonArea(x.s.poly)) < area && x.s.poly.every((q) => pointInPolygon(q, outer!)));
  for (const isl of inside) {
    const nested = inside.some((o) => o !== isl && Math.abs(polygonArea(o.s.poly)) > Math.abs(polygonArea(isl.s.poly)) && isl.s.poly.every((q) => pointInPolygon(q, o.s.poly)));
    if (!nested) loops.push({ ...isl.s.loop, flags: 0 } as HatchLoop);
  }
  return { loops, outer };
}

interface Node {
  p: Vec;
  out: number[];
}

/**
 * The face of the planar network of curves that contains `p`: split every
 * segment where it crosses another, cast a ray from the point to the
 * nearest edge, then walk the face keeping it on the left.
 */
function traceFace(d: Drawing, entities: Entity[], p: Vec): Vec[] | null {
  const raw: [Vec, Vec][] = [];
  for (const e of entities) {
    if (e.type === 'text' || e.type === 'mtext' || e.type === 'hatch' || e.type === 'point' || e.type === 'attdef') continue;
    for (const s of worldSegs(e, d)) for (const l of toLines(s)) raw.push(l);
    if (raw.length > 6000) return null;
  }
  if (raw.length < 2) return null;
  // Split at intersections (a grid of buckets keeps this from being all pairs).
  const cuts: number[][] = raw.map(() => []);
  const box = raw.reduce(
    (b, [a, c]) => ({ x0: Math.min(b.x0, a.x, c.x), y0: Math.min(b.y0, a.y, c.y), x1: Math.max(b.x1, a.x, c.x), y1: Math.max(b.y1, a.y, c.y) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const G = 64;
  const cw = (box.x1 - box.x0) / G || 1;
  const ch = (box.y1 - box.y0) / G || 1;
  const buckets = new Map<number, number[]>();
  raw.forEach(([a, b], i) => {
    const gx0 = Math.max(0, Math.min(G - 1, Math.floor((Math.min(a.x, b.x) - box.x0) / cw)));
    const gx1 = Math.max(0, Math.min(G - 1, Math.floor((Math.max(a.x, b.x) - box.x0) / cw)));
    const gy0 = Math.max(0, Math.min(G - 1, Math.floor((Math.min(a.y, b.y) - box.y0) / ch)));
    const gy1 = Math.max(0, Math.min(G - 1, Math.floor((Math.max(a.y, b.y) - box.y0) / ch)));
    for (let x = gx0; x <= gx1; x++)
      for (let y = gy0; y <= gy1; y++) {
        const k = x * G + y;
        let l = buckets.get(k);
        if (!l) buckets.set(k, (l = []));
        l.push(i);
      }
  });
  const seen = new Set<number>();
  for (const list of buckets.values()) {
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x];
        const j = list[y];
        const key = i * raw.length + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const [a, b] = raw[i];
        const [c, e] = raw[j];
        const r = segParams(a, b, c, e);
        if (r) {
          cuts[i].push(r[0]);
          cuts[j].push(r[1]);
        }
      }
  }
  // Nodes, merging points that are the same.
  const tol = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1e-9 + 1e-9;
  const nodes: Node[] = [];
  const nodeMap = new Map<string, number>();
  const nodeOf = (q: Vec) => {
    const k = `${Math.round(q.x / (tol * 1000))},${Math.round(q.y / (tol * 1000))}`;
    let n = nodeMap.get(k);
    if (n === undefined) {
      n = nodes.length;
      nodes.push({ p: q, out: [] });
      nodeMap.set(k, n);
    }
    return n;
  };
  const edges: { a: number; b: number }[] = [];
  raw.forEach(([a, b], i) => {
    const ts = [0, 1, ...cuts[i]].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-12) continue;
      const pa = nodeOf({ x: a.x + (b.x - a.x) * ts[k], y: a.y + (b.y - a.y) * ts[k] });
      const pb = nodeOf({ x: a.x + (b.x - a.x) * ts[k + 1], y: a.y + (b.y - a.y) * ts[k + 1] });
      if (pa === pb) continue;
      const ei = edges.length;
      edges.push({ a: pa, b: pb }, { a: pb, b: pa });
      nodes[pa].out.push(ei);
      nodes[pb].out.push(ei + 1);
    }
  });
  // Dangling ends can't bound anything; prune them.
  const alive = new Array(edges.length).fill(true);
  let changed = true;
  while (changed) {
    changed = false;
    nodes.forEach((n) => {
      const live = n.out.filter((e) => alive[e]);
      if (live.length === 1) {
        alive[live[0]] = false;
        alive[live[0] ^ 1] = false;
        changed = true;
      }
    });
  }
  // The nearest edge to the right of the point.
  let start = -1;
  let bestX = Infinity;
  edges.forEach((e, i) => {
    if (!alive[i] || i & 1) return;
    const a = nodes[e.a].p;
    const b = nodes[e.b].p;
    if ((a.y > p.y) === (b.y > p.y)) return;
    const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
    if (x > p.x && x < bestX) {
      bestX = x;
      // Walk it so the point is on the left: upward edges have it on the left.
      start = b.y > a.y ? i : i + 1;
    }
  });
  if (start < 0) return null;
  const poly: Vec[] = [];
  let e = start;
  for (let guard = 0; guard < 20000; guard++) {
    const cur = edges[e];
    poly.push(nodes[cur.a].p);
    const at = nodes[cur.b];
    const inAng = Math.atan2(nodes[cur.a].p.y - at.p.y, nodes[cur.a].p.x - at.p.x);
    // Next: the outgoing edge turning most to the left... i.e. the first counterclockwise... keep the face on the left by taking the smallest clockwise turn from the reverse direction.
    let best = -1;
    let bestTurn = Infinity;
    for (const o of at.out) {
      if (!alive[o] || o === (e ^ 1)) continue;
      const q = nodes[edges[o].b].p;
      const ang = Math.atan2(q.y - at.p.y, q.x - at.p.x);
      let turn = inAng - ang;
      while (turn <= 1e-12) turn += TAU;
      while (turn > TAU) turn -= TAU;
      if (turn < bestTurn) {
        bestTurn = turn;
        best = o;
      }
    }
    if (best < 0) best = e ^ 1;
    e = best;
    if (e === start) break;
  }
  if (poly.length < 3 || !pointInPolygon(p, poly)) return null;
  // Positive area means a bounded face; the outside of everything comes out clockwise.
  if (polygonArea(poly) <= 0) return null;
  return poly;
}

function toLines(s: Seg): [Vec, Vec][] {
  if (s.k === 'line') return [[s.a, s.b]];
  const sw = sweep(s.a0, s.a1);
  const n = Math.max(4, Math.ceil((sw / TAU) * 72));
  const out: [Vec, Vec][] = [];
  let prev = { x: s.c.x + s.r * Math.cos(s.a0), y: s.c.y + s.r * Math.sin(s.a0) };
  for (let i = 1; i <= n; i++) {
    const a = s.a0 + (sw * i) / n;
    const q = { x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) };
    out.push([prev, q]);
    prev = q;
  }
  return out;
}

function segParams(a: Vec, b: Vec, c: Vec, d: Vec): [number, number] | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-18) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, u))];
}
