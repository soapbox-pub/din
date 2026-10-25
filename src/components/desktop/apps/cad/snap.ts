/**
 * Object snaps: endpoints, midpoints, centers, quadrants, intersections,
 * perpendiculars, tangents, nodes, insertion points and nearest points on
 * what's under the cursor, AutoCAD's way.
 */
import { findBlock, type Drawing, type Entity, type Vec } from './model';
import {
  TAU,
  angleOfMat,
  apply,
  compose,
  dist,
  entitySegs,
  intersect,
  isSimilarity,
  mirrored,
  perpendicularFoot,
  polar,
  rotation,
  scaleOf,
  segEnd,
  segMid,
  segStart,
  closestOnSeg,
  tangentPoints,
  translation,
  sweep,
  type Mat,
  type Seg,
} from './geom';
import type { GeomCache } from './prims';
import type { SnapKind } from './render';
import { dimGeometry } from './dim';

export const OSNAP = {
  end: 1,
  mid: 2,
  cen: 4,
  nod: 8,
  qua: 16,
  int: 32,
  ins: 64,
  per: 128,
  tan: 256,
  nea: 512,
  app: 2048,
  ext: 4096,
} as const;

export const OSNAP_NAMES: [keyof typeof OSNAP, string][] = [
  ['end', 'Endpoint'],
  ['mid', 'Midpoint'],
  ['cen', 'Center'],
  ['nod', 'Node'],
  ['qua', 'Quadrant'],
  ['int', 'Intersection'],
  ['ext', 'Extension'],
  ['ins', 'Insertion'],
  ['per', 'Perpendicular'],
  ['tan', 'Tangent'],
  ['nea', 'Nearest'],
  ['app', 'Apparent intersection'],
];

export const SNAP_LABEL: Record<SnapKind, string> = {
  end: 'Endpoint',
  mid: 'Midpoint',
  cen: 'Center',
  qua: 'Quadrant',
  int: 'Intersection',
  per: 'Perpendicular',
  tan: 'Tangent',
  nea: 'Nearest',
  nod: 'Node',
  ins: 'Insertion',
  app: 'Apparent Intersection',
  ext: 'Extension',
  grid: 'Snap',
};

/** An entity's curves in world space, looking into blocks and dimensions. */
export function worldSegs(e: Entity, d: Drawing, m?: Mat, depth = 0): Seg[] {
  if (e.type === 'insert') {
    const b = findBlock(d, e.block);
    if (!b || depth > 8) return [];
    const local = compose(compose(translation(e.p.x, e.p.y), rotation({ x: 0, y: 0 }, e.rot)), { a: e.sx, b: 0, c: 0, d: e.sy, e: -b.base.x * e.sx, f: -b.base.y * e.sy });
    const mm = m ? compose(m, local) : local;
    return b.entities.flatMap((be) => worldSegs(be, d, mm, depth + 1));
  }
  if (e.type === 'dim') {
    const b = e.block ? findBlock(d, e.block) : undefined;
    const ents = b ? b.entities : dimGeometry(e, d);
    return ents.filter((x) => x.type === 'line' || x.type === 'arc').flatMap((x) => worldSegs(x, d, m, depth + 1));
  }
  const segs = entitySegs(e);
  return m ? segs.flatMap((s) => transformSeg(s, m)) : segs;
}

export function transformSeg(s: Seg, m: Mat): Seg[] {
  if (s.k === 'line') return [{ k: 'line', a: apply(m, s.a), b: apply(m, s.b) }];
  if (isSimilarity(m)) {
    const rot = angleOfMat(m);
    const mir = mirrored(m);
    const a0 = mir ? rot - s.a1 : rot + s.a0;
    const a1 = mir ? rot - s.a0 : rot + s.a1;
    return [{ k: 'arc', c: apply(m, s.c), r: s.r * scaleOf(m), a0, a1, cw: mir ? !s.cw : s.cw }];
  }
  const sw = sweep(s.a0, s.a1);
  const n = Math.max(8, Math.ceil((sw / TAU) * 64));
  const out: Seg[] = [];
  let prev = apply(m, polar(s.c, s.r, s.a0));
  for (let i = 1; i <= n; i++) {
    const p = apply(m, polar(s.c, s.r, s.a0 + (sw * i) / n));
    out.push({ k: 'line', a: prev, b: p });
    prev = p;
  }
  return out;
}

/** Points an entity offers besides its curves' ends and middles. */
function extraPoints(e: Entity): { p: Vec; kind: SnapKind }[] {
  switch (e.type) {
    case 'point':
      return [{ p: e.p, kind: 'nod' }];
    case 'text':
    case 'attdef':
      return [{ p: e.p, kind: 'ins' }];
    case 'mtext':
      return [{ p: e.p, kind: 'ins' }];
    case 'insert':
      return [{ p: e.p, kind: 'ins' }, ...e.attribs.map((a) => ({ p: a.p, kind: 'ins' as const }))];
    case 'dim':
      return [e.p13, e.p14, e.p10].map((p) => ({ p, kind: 'nod' as const }));
    case 'ellipse':
      return [{ p: e.c, kind: 'cen' }];
    default:
      return [];
  }
}

export interface SnapHit {
  p: Vec;
  kind: SnapKind;
}

/**
 * The best snap near the cursor, within `aperture` drawing units. `from`
 * is the point being drawn from, for perpendicular and tangent.
 */
export function findSnap(
  d: Drawing,
  entities: Entity[],
  cache: GeomCache,
  cursor: Vec,
  aperture: number,
  mode: number,
  from: Vec | null,
): SnapHit | null {
  const near: { e: Entity; segs: Seg[] }[] = [];
  for (const e of entities) {
    const g = cache.get(e, d);
    const b = g.box;
    if (cursor.x < b.min.x - aperture || cursor.x > b.max.x + aperture || cursor.y < b.min.y - aperture || cursor.y > b.max.y + aperture) continue;
    near.push({ e, segs: worldSegs(e, d) });
    if (near.length > 400) break;
  }
  const cands: (SnapHit & { d: number; pri: number })[] = [];
  const add = (p: Vec, kind: SnapKind, pri: number) => {
    const dd = dist(p, cursor);
    if (dd <= aperture) cands.push({ p, kind, d: dd, pri });
  };
  // Only segments the cursor is actually near count for most snaps.
  const close = (s: Seg) => dist(closestOnSeg(s, cursor), cursor) <= aperture;
  const hotSegs: Seg[] = [];
  for (const { e, segs } of near) {
    for (const s of segs) {
      const isClose = close(s);
      if (mode & OSNAP.end) {
        add(segStart(s), 'end', 1);
        add(segEnd(s), 'end', 1);
      }
      if (!isClose) {
        if (s.k === 'arc' && mode & OSNAP.cen) add(s.c, 'cen', 3);
        continue;
      }
      hotSegs.push(s);
      if (mode & OSNAP.mid && !(s.k === 'arc' && sweep(s.a0, s.a1) >= TAU - 1e-9)) add(segMid(s), 'mid', 2);
      if (s.k === 'arc') {
        if (mode & OSNAP.cen) add(s.c, 'cen', 3);
        if (mode & OSNAP.qua) for (let k = 0; k < 4; k++) if (sweep(s.a0, s.a1) >= TAU - 1e-9 || isOnArc(s, (k * Math.PI) / 2)) add(polar(s.c, s.r, (k * Math.PI) / 2), 'qua', 2);
        if (from && mode & OSNAP.tan) for (const t of tangentPoints(s.c, s.r, from)) if (isOnArc(s, Math.atan2(t.y - s.c.y, t.x - s.c.x))) add(t, 'tan', 4);
      }
      if (from && mode & OSNAP.per) {
        const f = perpendicularFoot(s, from);
        if (f && dist(closestOnSeg(s, f), f) < aperture * 0.01 + 1e-9) add(f, 'per', 4);
      }
    }
    for (const x of extraPoints(e)) if (mode & (x.kind === 'nod' ? OSNAP.nod : x.kind === 'ins' ? OSNAP.ins : OSNAP.cen)) add(x.p, x.kind, 1);
  }
  if (mode & OSNAP.int && hotSegs.length > 1 && hotSegs.length < 300) {
    for (let i = 0; i < hotSegs.length; i++)
      for (let j = i + 1; j < hotSegs.length; j++) for (const p of intersect(hotSegs[i], hotSegs[j])) add(p, 'int', 0);
  }
  if (!cands.length && mode & OSNAP.nea) {
    let best: Vec | null = null;
    let bd = Infinity;
    for (const { segs } of near)
      for (const s of segs) {
        const p = closestOnSeg(s, cursor);
        const dd = dist(p, cursor);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
    if (best && bd <= aperture) return { p: best, kind: 'nea' };
  }
  if (!cands.length) return null;
  // Closest wins, with intersections and endpoints preferred when nearly as close.
  cands.sort((a, b) => a.d + a.pri * aperture * 0.15 - (b.d + b.pri * aperture * 0.15));
  return { p: cands[0].p, kind: cands[0].kind };
}

function isOnArc(s: Extract<Seg, { k: 'arc' }>, a: number) {
  const w = (((a - s.a0) % TAU) + TAU) % TAU;
  return w <= sweep(s.a0, s.a1) + 1e-9;
}
