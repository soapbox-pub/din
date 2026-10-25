import {
  apply,
  cubicAt,
  EMPTY,
  isEmpty,
  matScale,
  mul,
  pathBounds,
  rectOfPoints,
  segments,
  union,
  type Gradient,
  type Item,
  type Mat,
  type Node,
  type Paint,
  type PathItem,
  type Point,
  type Rect,
  type Resources,
  type SubPath,
  type TextItem,
} from './model';
import type { GlyphCmd } from './pdf/glyphs';
import { layoutText } from './text';

/**
 * Geometry over the document: paths as canvas paths, bounding boxes (the
 * geometric bounds Illustrator shows, without stroke width), transforming
 * art, and finding what's under the pointer.
 */

const pathCache = new WeakMap<SubPath[], Path2D>();

export function toPath2D(paths: SubPath[]): Path2D {
  const hit = pathCache.get(paths);
  if (hit) return hit;
  const p = new Path2D();
  for (const sp of paths) {
    const ns = sp.nodes;
    if (!ns.length) continue;
    p.moveTo(ns[0].x, ns[0].y);
    for (const [a, b] of segments(sp)) {
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) p.lineTo(b.x, b.y);
      else p.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
    }
    if (sp.closed) p.closePath();
  }
  pathCache.set(paths, p);
  return p;
}

/** The four corners of a matrix's unit square (or a box) on the document. */
export function quad(m: Mat, x = 0, y = 0, w = 1, h = 1): Point[] {
  return [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)];
}

export function textQuad(t: TextItem, res: Resources): Point[] {
  const b = layoutText(t, res).box;
  return quad(t.matrix, b.x, b.y, b.w, b.h);
}

const boundsCache = new WeakMap<Item, Rect>();

export function itemBounds(it: Item, res: Resources): Rect {
  const hit = boundsCache.get(it);
  if (hit) return hit;
  let r: Rect;
  if (it.type === 'path') r = pathBounds(it.paths);
  else if (it.type === 'image') r = rectOfPoints(quad(it.matrix));
  else if (it.type === 'text') r = rectOfPoints(textQuad(it, res));
  else if (it.clip && it.children[0]) r = itemBounds(it.children[0], res);
  else r = it.children.reduce((acc, c) => union(acc, itemBounds(c, res)), EMPTY);
  boundsCache.set(it, r);
  return r;
}

export function boundsOf(items: Item[], res: Resources): Rect {
  return items.reduce((acc, it) => union(acc, itemBounds(it, res)), EMPTY);
}

/** Bounds including stroke width, for what's drawn. */
export function visualBounds(it: Item, res: Resources): Rect {
  const r = itemBounds(it, res);
  if (isEmpty(r)) return r;
  const sw = it.type === 'path' && it.stroke.paint.type !== 'none' ? it.stroke.width / 2 : 0;
  return { x: r.x - sw, y: r.y - sw, w: r.w + sw * 2, h: r.h + sw * 2 };
}

// ---- Transforms -------------------------------------------------------------------------

function tfNode(m: Mat, n: Node): Node {
  const p = apply(m, n.x, n.y);
  const i = apply(m, n.ix, n.iy);
  const o = apply(m, n.ox, n.oy);
  return { x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
}

export function transformPaths(paths: SubPath[], m: Mat): SubPath[] {
  return paths.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map((n) => tfNode(m, n)) }));
}

function tfPaint(p: Paint, m: Mat): Paint {
  if (p.type !== 'gradient') return p;
  const g: Gradient = { ...p.gradient, matrix: mul(p.gradient.matrix, m) };
  return { type: 'gradient', gradient: g };
}

export interface TransformOptions {
  /** Scale stroke widths along (Illustrator's Scale Strokes & Effects). */
  strokes: boolean;
}

/** Art moved, scaled, turned or skewed by `m` (document to document). */
export function transformItem(it: Item, m: Mat, opts: TransformOptions = { strokes: true }): Item {
  if (it.type === 'path') {
    const k = opts.strokes ? matScale(m) : 1;
    return {
      ...it,
      paths: transformPaths(it.paths, m),
      fill: tfPaint(it.fill, m),
      stroke: { ...it.stroke, paint: tfPaint(it.stroke.paint, m), width: it.stroke.width * k, dash: it.stroke.dash.map((d) => d * k) },
    };
  }
  if (it.type === 'group') return { ...it, children: it.children.map((c) => transformItem(c, m, opts)) };
  if (it.type === 'image') return { ...it, matrix: mul(it.matrix, m) };
  // Moving type keeps its glyphs where they are; anything more is still exact since the glyphs move with the matrix.
  return {
    ...it,
    matrix: mul(it.matrix, m),
    runs: it.runs.map((r) => ({ ...r, fill: tfPaint(r.fill, m), stroke: { ...r.stroke, paint: tfPaint(r.stroke.paint, m) } })),
  };
}

// ---- Hit testing ------------------------------------------------------------------------------

let hitCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  hitCtx ??= document.createElement('canvas').getContext('2d')!;
  return hitCtx;
}

/** Whether a document point touches a path: its fill (if filled, or `anyInside`) or within `tol` of its outline. */
export function hitPath(it: PathItem, p: Point, tol: number, anyInside = false): boolean {
  const c = ctx();
  const path = toPath2D(it.paths);
  const filled = it.fill.type !== 'none' || anyInside;
  if (filled && c.isPointInPath(path, p.x, p.y, it.evenOdd ? 'evenodd' : 'nonzero')) return true;
  c.lineWidth = Math.max(tol * 2, it.stroke.paint.type !== 'none' ? it.stroke.width : 0);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  return c.isPointInStroke(path, p.x, p.y);
}

export function pointInQuad(q: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i];
    const b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether an item is under a point, as Illustrator's Selection tool sees it (outline mode: only outlines). */
export function hitItem(it: Item, p: Point, tol: number, res: Resources, outline = false): boolean {
  if (it.hidden) return false;
  const b = visualBounds(it, res);
  if (isEmpty(b) || p.x < b.x - tol || p.y < b.y - tol || p.x > b.x + b.w + tol || p.y > b.y + b.h + tol) return false;
  if (it.type === 'path') return outline ? hitPath({ ...it, fill: { type: 'none' } }, p, tol) : hitPath(it, p, tol);
  if (it.type === 'image') return pointInQuad(quad(it.matrix), p);
  if (it.type === 'text') return pointInQuad(textQuad(it, res), p);
  if (it.clip) {
    const clip = it.children[0];
    if (clip?.type === 'path' && !hitPath(clip, p, tol, true)) return false;
    return it.children.slice(1).some((c) => hitItem(c, p, tol, res, outline)) || (clip ? hitItem(clip, p, tol, res, true) : false);
  }
  return it.children.some((c) => hitItem(c, p, tol, res, outline));
}

/** Point on a segment nearest p, with its parameter. */
export function nearestOnSegment(a: Node, b: Node, p: Point): { t: number; x: number; y: number; d: number } {
  let best = { t: 0, x: a.x, y: a.y, d: Infinity };
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = cubicAt(a.x, a.ox, b.ix, b.x, t);
    const y = cubicAt(a.y, a.oy, b.iy, b.y, t);
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < best.d) best = { t, x, y, d };
  }
  // Refine
  let step = 1 / N;
  for (let k = 0; k < 12; k++) {
    step /= 2;
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) continue;
      const x = cubicAt(a.x, a.ox, b.ix, b.x, t);
      const y = cubicAt(a.y, a.oy, b.iy, b.y, t);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < best.d) best = { t, x, y, d };
    }
  }
  return best;
}

/** Split a cubic segment at t: the new middle node, and the handles of its neighbors. */
export function splitSegment(a: Node, b: Node, t: number): { a: Node; mid: Node; b: Node } {
  const lerp = (p: number, q: number) => p + (q - p) * t;
  const x01 = lerp(a.x, a.ox);
  const y01 = lerp(a.y, a.oy);
  const x12 = lerp(a.ox, b.ix);
  const y12 = lerp(a.oy, b.iy);
  const x23 = lerp(b.ix, b.x);
  const y23 = lerp(b.iy, b.y);
  const x012 = lerp(x01, x12);
  const y012 = lerp(y01, y12);
  const x123 = lerp(x12, x23);
  const y123 = lerp(y12, y23);
  const x = lerp(x012, x123);
  const y = lerp(y012, y123);
  return {
    a: { ...a, ox: x01, oy: y01 },
    mid: { x, y, ix: x012, iy: y012, ox: x123, oy: y123 },
    b: { ...b, ix: x23, iy: y23 },
  };
}

/** Flatten paths to polygons (for lasso, offset and the like). */
export function flatten(sp: SubPath, tol = 0.5): Point[] {
  const pts: Point[] = [];
  if (!sp.nodes.length) return pts;
  pts.push({ x: sp.nodes[0].x, y: sp.nodes[0].y });
  for (const [a, b] of segments(sp)) {
    const straight = a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;
    if (straight) {
      pts.push({ x: b.x, y: b.y });
      continue;
    }
    const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
    const n = Math.max(2, Math.min(200, Math.ceil(len / (tol * 4))));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      pts.push({ x: cubicAt(a.x, a.ox, b.ix, b.x, t), y: cubicAt(a.y, a.oy, b.iy, b.y, t) });
    }
  }
  return pts;
}

export const mid = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Glyph outline commands as subpaths, mapped by `m`. */
export function cmdsToSubPaths(cmds: GlyphCmd[], m: Mat): SubPath[] {
  const out: SubPath[] = [];
  let sp: SubPath | null = null;
  const pt = (x: number, y: number) => apply(m, x, y);
  for (const c of cmds) {
    if (c[0] === 'M') {
      const p = pt(c[1], c[2]);
      sp = { closed: false, nodes: [{ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y }] };
      out.push(sp);
    } else if (!sp) continue;
    else if (c[0] === 'L') {
      const p = pt(c[1], c[2]);
      sp.nodes.push({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });
    } else if (c[0] === 'C') {
      const a = pt(c[1], c[2]);
      const b = pt(c[3], c[4]);
      const p = pt(c[5], c[6]);
      const last = sp.nodes[sp.nodes.length - 1];
      last.ox = a.x;
      last.oy = a.y;
      sp.nodes.push({ x: p.x, y: p.y, ix: b.x, iy: b.y, ox: p.x, oy: p.y });
    } else {
      sp.closed = true;
      const a = sp.nodes[0];
      const z = sp.nodes[sp.nodes.length - 1];
      if (sp.nodes.length > 1 && Math.abs(a.x - z.x) < 1e-6 && Math.abs(a.y - z.y) < 1e-6) {
        a.ix = z.ix;
        a.iy = z.iy;
        sp.nodes.pop();
      }
      sp = null;
    }
  }
  return out.filter((s) => s.nodes.length > 1);
}
