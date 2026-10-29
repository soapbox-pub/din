import { newId, segments, type Node, type PathItem, type Point, type SubPath } from './model';

/**
 * The Pathfinder's shape modes (Unite, Minus Front, Intersect, Exclude) and
 * Divide. The paths are cut wherever they cross into a planar arrangement;
 * an edge stays where the result's inside changes across it, and the edges
 * are chained back into paths. Each piece of edge remembers which original
 * curve and which stretch of it it came from, so the result is made of the
 * same Bézier curves, cut at the crossings, not a traced approximation.
 */

export type ShapeMode = 'unite' | 'minus-front' | 'intersect' | 'exclude';

interface Src {
  shape: number;
  sp: number;
  seg: number;
}

interface Edge {
  a: number;
  b: number;
  src: Src;
  ta: number;
  tb: number;
}

interface Poly {
  pts: Point[];
}

/** A cubic segment between two nodes. */
function bez(a: Node, b: Node): [Point, Point, Point, Point] {
  return [
    { x: a.x, y: a.y },
    { x: a.ox, y: a.oy },
    { x: b.ix, y: b.iy },
    { x: b.x, y: b.y },
  ];
}

const isLine = (a: Node, b: Node) => a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;

function at(c: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  };
}

/** The part of a cubic from t0 to t1 (either order). */
function sub(c: [Point, Point, Point, Point], t0: number, t1: number): [Point, Point, Point, Point] {
  const split = (cc: [Point, Point, Point, Point], t: number): [[Point, Point, Point, Point], [Point, Point, Point, Point]] => {
    const l = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const p01 = l(cc[0], cc[1]);
    const p12 = l(cc[1], cc[2]);
    const p23 = l(cc[2], cc[3]);
    const p012 = l(p01, p12);
    const p123 = l(p12, p23);
    const m = l(p012, p123);
    return [
      [cc[0], p01, p012, m],
      [m, p123, p23, cc[3]],
    ];
  };
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  let s = split(c, hi)[0];
  if (lo > 0) s = split(s, lo / hi)[1];
  return t0 <= t1 ? s : [s[3], s[2], s[1], s[0]];
}

function windingAt(polys: Poly[], p: Point): number {
  let w = 0;
  for (const poly of polys) {
    const pts = poly.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j];
      const b = pts[i];
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

/** Intersections of segment p1p2 with p3p4, as parameters on each (including collinear overlaps' ends). */
function cross(p1: Point, p2: Point, p3: Point, p4: Point, eps: number): [number, number][] {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  const ex = p3.x - p1.x;
  const ey = p3.y - p1.y;
  const l1 = d1x * d1x + d1y * d1y;
  const l2 = d2x * d2x + d2y * d2y;
  if (!l1 || !l2) return [];
  if (Math.abs(den) <= 1e-12 * Math.sqrt(l1 * l2)) {
    // Parallel: overlapping if collinear.
    if (Math.abs(ex * d1y - ey * d1x) / Math.sqrt(l1) > eps) return [];
    const out: [number, number][] = [];
    const proj1 = (q: Point) => ((q.x - p1.x) * d1x + (q.y - p1.y) * d1y) / l1;
    const proj2 = (q: Point) => ((q.x - p3.x) * d2x + (q.y - p3.y) * d2y) / l2;
    const s3 = proj1(p3);
    const s4 = proj1(p4);
    if (s3 > 0 && s3 < 1) out.push([s3, 0]);
    if (s4 > 0 && s4 < 1) out.push([s4, 1]);
    const u1 = proj2(p1);
    const u2 = proj2(p2);
    if (u1 > 0 && u1 < 1) out.push([0, u1]);
    if (u2 > 0 && u2 < 1) out.push([1, u2]);
    return out;
  }
  const t = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  const tol = 1e-9;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return [];
  return [[Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))]];
}

interface Shape {
  paths: SubPath[];
  evenOdd: boolean;
}

/** Inside-ness of each shape for a point. */
type Predicate = (inside: boolean[]) => boolean;

function arrange(shapes: Shape[], predicate: Predicate): SubPath[] {
  // Flatten each subpath, remembering where on its curve each piece is.
  const verts: Point[] = [];
  const rawEdges: { a: Point; b: Point; src: Src; ta: number; tb: number }[] = [];
  const polysOf: Poly[][] = shapes.map(() => []);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  shapes.forEach((s) => s.paths.forEach((sp) => sp.nodes.forEach((n) => {
    minX = Math.min(minX, n.x, n.ix, n.ox);
    minY = Math.min(minY, n.y, n.iy, n.oy);
    maxX = Math.max(maxX, n.x, n.ix, n.ox);
    maxY = Math.max(maxY, n.y, n.iy, n.oy);
  })));
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const tolFlat = diag / 4000;
  shapes.forEach((s, si) =>
    s.paths.forEach((sp0, spi) => {
      const sp = { ...sp0, closed: true };
      if (sp.nodes.length < 2) return;
      const pts: Point[] = [];
      segments(sp).forEach(([a, b], segi) => {
        const src = { shape: si, sp: spi, seg: segi };
        if (isLine(a, b)) {
          rawEdges.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, src, ta: 0, tb: 1 });
          pts.push({ x: a.x, y: a.y });
          return;
        }
        const c = bez(a, b);
        const len = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y) + Math.hypot(c[3].x - c[2].x, c[3].y - c[2].y);
        const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(len / tolFlat) * 2)));
        let prev = c[0];
        pts.push(prev);
        for (let k = 1; k <= n; k++) {
          const p = at(c, k / n);
          rawEdges.push({ a: prev, b: p, src, ta: (k - 1) / n, tb: k / n });
          if (k < n) pts.push(p);
          prev = p;
        }
      });
      polysOf[si].push({ pts });
    }),
  );
  const eps = diag * 1e-7;

  // Cut every edge where it meets another.
  const cuts: number[][] = rawEdges.map(() => []);
  const order = rawEdges.map((_, i) => i).sort((i, j) => Math.min(rawEdges[i].a.x, rawEdges[i].b.x) - Math.min(rawEdges[j].a.x, rawEdges[j].b.x));
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const e = rawEdges[i];
    const ex1 = Math.max(e.a.x, e.b.x) + eps;
    const ey0 = Math.min(e.a.y, e.b.y) - eps;
    const ey1 = Math.max(e.a.y, e.b.y) + eps;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      const f = rawEdges[j];
      if (Math.min(f.a.x, f.b.x) > ex1) break;
      if (Math.max(f.a.y, f.b.y) < ey0 || Math.min(f.a.y, f.b.y) > ey1) continue;
      for (const [t, u] of cross(e.a, e.b, f.a, f.b, eps * 10)) {
        if (t > 1e-9 && t < 1 - 1e-9) cuts[i].push(t);
        if (u > 1e-9 && u < 1 - 1e-9) cuts[j].push(u);
      }
    }
  }

  // Vertices, merged when they're the same point.
  const grid = new Map<string, number>();
  const cell = eps * 100;
  const vid = (p: Point): number => {
    const gx = Math.round(p.x / cell);
    const gy = Math.round(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = grid.get(`${gx + dx},${gy + dy}`);
        if (k !== undefined && Math.abs(verts[k].x - p.x) <= cell && Math.abs(verts[k].y - p.y) <= cell) return k;
      }
    }
    verts.push(p);
    grid.set(`${gx},${gy}`, verts.length - 1);
    return verts.length - 1;
  };
  const edges: Edge[] = [];
  const seen = new Set<string>();
  rawEdges.forEach((e, i) => {
    const ts = [0, ...cuts[i].sort((a, b) => a - b), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const p = { x: e.a.x + (e.b.x - e.a.x) * t0, y: e.a.y + (e.b.y - e.a.y) * t0 };
      const q = { x: e.a.x + (e.b.x - e.a.x) * t1, y: e.a.y + (e.b.y - e.a.y) * t1 };
      const a = vid(p);
      const b = vid(q);
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, src: e.src, ta: e.ta + (e.tb - e.ta) * t0, tb: e.ta + (e.tb - e.ta) * t1 });
    }
  });

  // Keep the edges the result's inside changes across, inside on the left.
  const insideAt = (p: Point) =>
    predicate(
      shapes.map((s, si) => {
        const w = windingAt(polysOf[si], p);
        return s.evenOdd ? Math.abs(w) % 2 === 1 : w !== 0;
      }),
    );
  const out: Edge[] = [];
  const off = diag * 2e-5;
  for (const e of edges) {
    const p = verts[e.a];
    const q = verts[e.b];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const d = Math.min(off, len / 4);
    const left = insideAt({ x: mx + nx * d, y: my + ny * d });
    const right = insideAt({ x: mx - nx * d, y: my - ny * d });
    if (left === right) continue;
    out.push(left ? e : { a: e.b, b: e.a, src: e.src, ta: e.tb, tb: e.ta });
  }

  // Chain them into loops, turning as tightly as possible at junctions.
  const from = new Map<number, Edge[]>();
  for (const e of out) {
    if (!from.has(e.a)) from.set(e.a, []);
    from.get(e.a)!.push(e);
  }
  const used = new Set<Edge>();
  const loops: Edge[][] = [];
  for (const start of out) {
    if (used.has(start)) continue;
    const loop: Edge[] = [];
    let e: Edge | undefined = start;
    while (e && !used.has(e)) {
      used.add(e);
      loop.push(e);
      const cur: Edge = e;
      const inDir = Math.atan2(verts[cur.b].y - verts[cur.a].y, verts[cur.b].x - verts[cur.a].x);
      const options: Edge[] = (from.get(cur.b) ?? []).filter((x) => !used.has(x));
      let best: Edge | undefined;
      let bestTurn = Infinity;
      for (const o of options) {
        const outDir = Math.atan2(verts[o.b].y - verts[o.a].y, verts[o.b].x - verts[o.a].x);
        // The sharpest left turn, keeping the inside on the left.
        let turn = outDir - inDir;
        while (turn <= -Math.PI) turn += 2 * Math.PI;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        const score = -turn;
        if (score < bestTurn) {
          bestTurn = score;
          best = o;
        }
      }
      e = best;
      if (e === start) break;
    }
    if (loop.length >= 2) loops.push(loop);
  }

  // Back to curves: runs of pieces from one original segment become that segment's stretch.
  const result: SubPath[] = [];
  for (const loop of loops) {
    const runs: { src: Src; ta: number; tb: number; a: number; b: number }[] = [];
    for (const e of loop) {
      const last = runs[runs.length - 1];
      if (last && last.src.shape === e.src.shape && last.src.sp === e.src.sp && last.src.seg === e.src.seg && Math.abs(last.tb - e.ta) < 1e-6) {
        last.tb = e.tb;
        last.b = e.b;
      } else runs.push({ src: e.src, ta: e.ta, tb: e.tb, a: e.a, b: e.b });
    }
    // Join the first and last runs if they continue each other.
    if (runs.length > 1) {
      const f = runs[0];
      const l = runs[runs.length - 1];
      if (f.src.shape === l.src.shape && f.src.sp === l.src.sp && f.src.seg === l.src.seg && Math.abs(l.tb - f.ta) < 1e-6) {
        runs[0] = { ...f, ta: l.ta, a: l.a };
        runs.pop();
      }
    }
    const nodes: Node[] = runs.map((r) => {
      const p = verts[r.a];
      return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
    });
    runs.forEach((r, i) => {
      const sp = shapes[r.src.shape].paths[r.src.sp];
      const ns = sp.nodes;
      const a = ns[r.src.seg];
      const b = ns[(r.src.seg + 1) % ns.length];
      if (isLine(a, b)) return;
      const c = sub(bez(a, b), r.ta, r.tb);
      const n0 = nodes[i];
      const n1 = nodes[(i + 1) % nodes.length];
      n0.ox = c[1].x;
      n0.oy = c[1].y;
      n1.ix = c[2].x;
      n1.iy = c[2].y;
    });
    if (nodes.length >= 2) result.push({ closed: true, nodes });
  }
  return result;
}

/** A shape mode over paths (bottom first), as one compound path. Null when nothing is left. */
export function shapeMode(items: PathItem[], mode: ShapeMode): PathItem | null {
  if (items.length < 2) return null;
  const shapes = items.map((p) => ({ paths: p.paths, evenOdd: p.evenOdd }));
  const pred: Predicate =
    mode === 'unite'
      ? (ins) => ins.some(Boolean)
      : mode === 'intersect'
        ? (ins) => ins.every(Boolean)
        : mode === 'exclude'
          ? (ins) => ins.filter(Boolean).length % 2 === 1
          : (ins) => ins[0] && !ins.slice(1).some(Boolean);
  const paths = arrange(shapes, pred);
  if (!paths.length) return null;
  // Minus Front keeps the back object's paint; the others the front one's.
  const style = mode === 'minus-front' ? items[0] : items[items.length - 1];
  return { ...style, id: newId(), name: '', paths, evenOdd: false };
}

/** Divide: every region the paths make, as its own path, painted like the topmost path covering it. */
export function divide(items: PathItem[]): PathItem[] {
  const shapes = items.map((p) => ({ paths: p.paths, evenOdd: p.evenOdd }));
  const out: PathItem[] = [];
  // Regions are told apart by which shapes cover them; one arrangement per combination present.
  const n = items.length;
  if (n > 12) return [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const paths = arrange(shapes, (ins) => ins.every((v, i) => v === !!(mask & (1 << i))));
    if (!paths.length) continue;
    let top = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) top = i;
    for (const sp of paths) out.push({ ...items[top], id: newId(), name: '', paths: [sp], evenOdd: false });
  }
  return out;
}
