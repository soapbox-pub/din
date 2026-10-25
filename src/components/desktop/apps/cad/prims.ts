/**
 * Entities turned into what the canvas draws and the pointer hits: paths
 * (lines and true arcs), fills, hatch strokes, text and points, in world
 * coordinates with their colors, lineweights and linetypes resolved through
 * layers and blocks. Results are cached per entity object until the
 * drawing's tables change.
 */
import {
  BYBLOCK,
  BYLAYER,
  CONTINUOUS,
  LW_BYBLOCK,
  LW_BYLAYER,
  LW_DEFAULT,
  findBlock,
  findLayer,
  findLinetype,
  findTextStyle,
  type Drawing,
  type Entity,
  type Layer,
  type Vec,
} from './model';
import {
  IDENTITY,
  apply,
  applyDir,
  arcBox,
  boxValid,
  bulgeArc,
  compose,
  dist,
  distToSegment,
  ellipsePoints,
  emptyBox,
  grow,
  isSimilarity,
  mirrored,
  norm,
  plinePoints,
  pointInPolygon,
  polar,
  rotation,
  scaleOf,
  splinePoints,
  sweep,
  translation,
  wrapAngle,
  TAU,
  type Box,
  type Mat,
  angleOfMat,
} from './geom';
import { CAP, DESCENT, fontFamily, layoutMText, layoutText, type TextLayout } from './text';
import { dimGeometry, leaderArrow } from './dim';
import { hatchSegments, loopPolygons } from './hatch';

export interface Ink {
  /** ACI 1-255 or TRUE_COLOR | rgb; 7 follows the background. */
  color: number;
  /** Hundredths of a millimetre. */
  lw: number;
  /** Dash pattern in world units, or null for continuous. */
  dash: number[] | null;
  /** Fills too dense to draw line by line are shown as a tint. */
  alpha?: number;
}

export type PathOp = { o: 'M'; x: number; y: number } | { o: 'L'; x: number; y: number } | { o: 'A'; c: Vec; r: number; a0: number; a1: number; ccw: boolean };

export type Prim =
  | { k: 'path'; ops: PathOp[]; closed: boolean; ink: Ink }
  | { k: 'fill'; loops: Vec[][]; ink: Ink }
  | { k: 'segs'; pts: Float64Array; ink: Ink; loops: Vec[][] }
  | { k: 'text'; m: Mat; layout: TextLayout; family: string; ink: Ink; mtext: boolean }
  | { k: 'dot'; p: Vec; ink: Ink };

export interface Geom {
  prims: Prim[];
  box: Box;
}

interface Inherit {
  layer: Layer | undefined;
  color: number;
  lw: number;
  linetype: string;
  m: Mat;
  depth: number;
}

/** Everything a drawing's geometry depends on besides the entity itself. */
export class GeomCache {
  private cache = new WeakMap<Entity, Geom>();
  private key: unknown[] = [];

  /** Start over if the tables entities are drawn through have changed. */
  sync(d: Drawing) {
    const key = [d.layers, d.linetypes, d.textStyles, d.dimStyles, d.blocks, d.header.ltscale, d.header.pdmode, d.header.pdsize, d.header.fillmode, d.header.lunits];
    if (key.length !== this.key.length || key.some((k, i) => k !== this.key[i])) {
      this.cache = new WeakMap();
      this.key = key;
    }
  }

  get(e: Entity, d: Drawing): Geom {
    let g = this.cache.get(e);
    if (!g) {
      g = entityGeom(e, d);
      this.cache.set(e, g);
    }
    return g;
  }
}

const ROOT = (): Inherit => ({ layer: undefined, color: 7, lw: LW_DEFAULT, linetype: CONTINUOUS, m: IDENTITY, depth: 0 });

export function entityGeom(e: Entity, d: Drawing): Geom {
  const prims: Prim[] = [];
  emit(e, d, ROOT(), prims, true);
  const box = emptyBox();
  for (const p of prims) primBox(p, box);
  return { prims, box: boxValid(box) ? box : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } } };
}

export function layerVisible(l: Layer | undefined) {
  return !l || (l.on && !l.frozen);
}

function emit(e: Entity, d: Drawing, parent: Inherit, out: Prim[], top: boolean) {
  if (e.hidden) return;
  // Entities on layer 0 inside a block take the reference's layer.
  const own = findLayer(d, e.layer);
  const layer = !top && e.layer === '0' ? parent.layer : own;
  // Callers leave out top-level entities on hidden layers; inside a block,
  // only entities on layer 0 follow the reference's layer.
  if (!top && e.layer !== '0' && own && (own.frozen || !own.on)) return;
  const color = e.color === BYLAYER ? (layer?.color ?? 7) : e.color === BYBLOCK ? parent.color : e.color;
  const lw = e.lineweight === LW_BYLAYER ? (layer?.lineweight ?? LW_DEFAULT) : e.lineweight === LW_BYBLOCK ? parent.lw : e.lineweight;
  const ltName = /^bylayer$/i.test(e.linetype) ? (layer?.linetype ?? CONTINUOUS) : /^byblock$/i.test(e.linetype) ? parent.linetype : e.linetype;
  const m = parent.m;
  const scale = scaleOf(m);
  const lt = findLinetype(d, ltName);
  const ltScale = (d.header.ltscale || 1) * (e.ltscale || 1) * scale;
  const dash = lt && lt.pattern.length && lt.pattern.some((x) => x !== 0) ? lt.pattern.map((x) => Math.abs(x) * ltScale) : null;
  const ink: Ink = { color: color === BYBLOCK || color === BYLAYER ? 7 : color, lw: lw < 0 ? (lw === LW_DEFAULT ? LW_DEFAULT : 25) : lw, dash };
  const P = (p: Vec) => apply(m, p);
  const sim = isSimilarity(m);
  const mir = mirrored(m);

  const path = (pts: Vec[], closed: boolean, inkx = ink) => {
    if (pts.length < 2) return;
    const ops = pts.map((p, i) => ({ o: i ? 'L' : 'M', ...P(p) }) as PathOp);
    out.push({ k: 'path', ops, closed, ink: inkx });
  };
  const arc = (c: Vec, r: number, a0: number, a1: number) => {
    if (sim) {
      const rot = angleOfMat(m);
      const s0 = mir ? rot - a1 : rot + a0;
      const cc = P(c);
      const rr = r * scale;
      const p0 = polar(cc, rr, s0);
      out.push({ k: 'path', ops: [{ o: 'M', ...p0 }, { o: 'A', c: cc, r: rr, a0: s0, a1: s0 + sweep(a0, a1), ccw: true }], closed: false, ink });
    } else {
      // A circle under a non-uniform scale is an ellipse.
      const sw = sweep(a0, a1);
      const n = Math.max(16, Math.ceil((sw / TAU) * 96));
      const pts: Vec[] = [];
      for (let i = 0; i <= n; i++) pts.push(polar(c, r, a0 + (sw * i) / n));
      path(pts, false);
    }
  };

  switch (e.type) {
    case 'line':
      path([e.a, e.b], false);
      return;
    case 'circle':
      arc(e.c, e.r, 0, TAU);
      return;
    case 'arc':
      arc(e.c, e.r, e.start, e.end);
      return;
    case 'ellipse':
      path(ellipsePoints(e.c, e.major, e.ratio, e.start, e.end, 96), Math.abs(sweep(e.start, e.end) - TAU) < 1e-9);
      return;
    case 'spline':
      path(splinePoints(e.degree, e.knots, e.ctrl, e.weights, 64), e.closed);
      return;
    case 'pline': {
      const widths = e.width > 0 || e.pts.some((p) => (p.sw ?? 0) > 0 || (p.ew ?? 0) > 0);
      if (widths && d.header.fillmode) {
        out.push(...widePline(e, P, ink));
        return;
      }
      if (sim) {
        const ops: PathOp[] = [];
        const n = e.pts.length;
        const rot = angleOfMat(m);
        ops.push({ o: 'M', ...P(e.pts[0]) });
        for (let i = 0; i < (e.closed ? n : n - 1); i++) {
          const p = e.pts[i];
          const q = e.pts[(i + 1) % n];
          if (Math.abs(p.b) > 1e-12 && dist(p, q) > 1e-12) {
            const a = bulgeArc(p, q, p.b);
            const cc = P(a.c);
            const rr = a.r * scale;
            const sw = sweep(a.a0, a.a1);
            // From p to q: counterclockwise when the bulge is positive (and not mirrored).
            const fromAng = a.cw ? a.a1 : a.a0;
            const startW = mir ? rot - fromAng : rot + fromAng;
            const ccw = a.cw === mir;
            ops.push({ o: 'A', c: cc, r: rr, a0: startW, a1: ccw ? startW + sw : startW - sw, ccw });
          } else ops.push({ o: 'L', ...P(q) });
        }
        out.push({ k: 'path', ops, closed: e.closed, ink });
      } else path(plinePoints(e.pts, e.closed, 64), e.closed);
      return;
    }
    case 'point': {
      const pd = d.header.pdmode;
      const p = P(e.p);
      if (pd === 0 || pd === 1) {
        if (pd === 0) out.push({ k: 'dot', p, ink });
        return;
      }
      const size = (d.header.pdsize > 0 ? d.header.pdsize : 0.05 * (d.header.limmax.y - d.header.limmin.y || 1)) * scale;
      const h = size / 2;
      const shape = pd % 32;
      if (shape === 2) {
        path([{ x: e.p.x - h, y: e.p.y }, { x: e.p.x + h, y: e.p.y }], false);
        path([{ x: e.p.x, y: e.p.y - h }, { x: e.p.x, y: e.p.y + h }], false);
      }
      if (shape === 3) {
        path([{ x: e.p.x - h, y: e.p.y - h }, { x: e.p.x + h, y: e.p.y + h }], false);
        path([{ x: e.p.x - h, y: e.p.y + h }, { x: e.p.x + h, y: e.p.y - h }], false);
      }
      if (shape === 4) path([e.p, { x: e.p.x, y: e.p.y + h }], false);
      if (pd & 32) arc(e.p, h, 0, TAU);
      if (pd & 64) path([{ x: e.p.x - h, y: e.p.y - h }, { x: e.p.x + h, y: e.p.y - h }, { x: e.p.x + h, y: e.p.y + h }, { x: e.p.x - h, y: e.p.y + h }], true);
      if (shape === 0) out.push({ k: 'dot', p, ink });
      return;
    }
    case 'text':
    case 'attdef': {
      if (e.type === 'attdef' && top === false) return;
      const style = findTextStyle(d, e.style);
      const family = fontFamily(style);
      const label = e.type === 'attdef' ? e.tag : e.text;
      const lay = layoutText({ text: label }, family);
      out.push(textPrim(e, lay, family, m, ink));
      return;
    }
    case 'mtext': {
      const style = findTextStyle(d, e.style);
      const family = fontFamily(style);
      const lay = layoutMText(e.text, family, e.width > 0 ? e.width / e.h : 0, e.spacing);
      const col = Math.floor((e.attach - 1) % 3);
      const row = Math.floor((e.attach - 1) / 3);
      const boxW = e.width > 0 ? e.width / e.h : lay.width;
      // Text-space origin: top-left of the box, y down; place relative to the attachment point.
      const ox = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
      const oy = row === 0 ? 0 : row === 1 ? lay.height / 2 : lay.height;
      // Each line is aligned within the box as the attachment's column says.
      const lines = lay.lines.map((l) => {
        const dx = col === 1 ? (boxW - l.width) / 2 : col === 2 ? boxW - l.width : 0;
        return { ...l, runs: l.runs.map((r) => ({ ...r, x: r.x + dx })) };
      });
      const local: Mat = compose(compose(translation(e.p.x, e.p.y), rotation({ x: 0, y: 0 }, e.rot)), { a: e.h, b: 0, c: 0, d: e.h, e: ox * e.h, f: oy * e.h });
      // In layout space y runs down, so flip.
      const tm = compose(m, compose(local, { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }));
      out.push({ k: 'text', m: tm, layout: { ...lay, lines, width: boxW }, family, ink, mtext: true });
      return;
    }
    case 'insert': {
      const b = findBlock(d, e.block);
      if (!b || parent.depth > 12) return;
      const cols = Math.max(1, e.cols ?? 1);
      const rows = Math.max(1, e.rows ?? 1);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const off = { x: c * (e.dc ?? 0), y: r * (e.dr ?? 0) };
          const local = compose(compose(compose(translation(e.p.x, e.p.y), rotation({ x: 0, y: 0 }, e.rot)), translation(off.x, off.y)), {
            a: e.sx,
            b: 0,
            c: 0,
            d: e.sy,
            e: -b.base.x * e.sx,
            f: -b.base.y * e.sy,
          });
          const child: Inherit = { layer, color, lw, linetype: ltName, m: compose(m, local), depth: parent.depth + 1 };
          for (const be of b.entities) emit(be, d, child, out, false);
        }
      for (const a of e.attribs) {
        if (a.flags & 1) continue;
        const style = findTextStyle(d, a.style);
        const family = fontFamily(style);
        const attInk = { ...ink, color: a.color === BYLAYER ? (findLayer(d, a.layer)?.color ?? ink.color) : a.color === BYBLOCK ? ink.color : a.color };
        out.push(textPrim(a, layoutText({ text: a.text }, family), family, m, attInk));
      }
      return;
    }
    case 'dim': {
      const b = e.block ? findBlock(d, e.block) : undefined;
      const ents = b ? b.entities : dimGeometry(e, d);
      const child: Inherit = { layer, color, lw, linetype: ltName, m, depth: parent.depth + 1 };
      for (const be of ents) emit(be, d, child, out, false);
      return;
    }
    case 'leader': {
      path(e.pts, false);
      if (e.arrow) {
        const child: Inherit = { layer, color, lw, linetype: ltName, m, depth: parent.depth + 1 };
        for (const be of leaderArrow(e.pts, d, e.style)) emit(be, d, child, out, false);
      }
      return;
    }
    case 'hatch': {
      const polys = loopPolygons(e.loops).map((poly) => poly.map(P));
      if (!polys.length) return;
      if (e.solid || !e.lines.length) {
        if (d.header.fillmode) out.push({ k: 'fill', loops: polys, ink });
        return;
      }
      const lines = e.lines.map((l) => {
        const dir = applyDir(m, { x: Math.cos(l.angle), y: Math.sin(l.angle) });
        return { angle: Math.atan2(dir.y, dir.x), base: P(l.base), offset: applyDir(m, l.offset), dashes: l.dashes.map((x) => x * scale) };
      });
      const box = emptyBox();
      for (const poly of polys) for (const p of poly) grow(box, p);
      const segs = hatchSegments(lines, polys, box);
      if (segs) out.push({ k: 'segs', pts: segs, ink: { ...ink, dash: null }, loops: polys });
      else out.push({ k: 'fill', loops: polys, ink: { ...ink, alpha: 0.35 } });
      return;
    }
    case 'solid': {
      const q = [e.pts[0], e.pts[1], e.pts[3], e.pts[2]].map(P);
      if (d.header.fillmode) out.push({ k: 'fill', loops: [q], ink });
      else path(q, true);
      return;
    }
    case 'face': {
      const ops: PathOp[] = [];
      for (let i = 0; i < 4; i++) {
        const a = P(e.pts[i]);
        const b = P(e.pts[(i + 1) % 4]);
        if (e.invisible & (1 << i)) continue;
        ops.push({ o: 'M', ...a }, { o: 'L', ...b });
      }
      if (ops.length) out.push({ k: 'path', ops, closed: false, ink });
      return;
    }
    case 'xline':
    case 'ray': {
      const u = norm(e.dir);
      const far = 1e8;
      const a = e.type === 'ray' ? e.p : { x: e.p.x - u.x * far, y: e.p.y - u.y * far };
      path([a, { x: e.p.x + u.x * far, y: e.p.y + u.y * far }], false);
      return;
    }
  }
}

function textPrim(
  t: { p: Vec; a: Vec; h: number; rot: number; wf: number; oblique: number; halign: number; valign: number },
  lay: TextLayout,
  family: string,
  m: Mat,
  ink: Ink,
): Prim {
  const w = lay.width * t.h * t.wf;
  let h = t.h;
  let rot = t.rot;
  let wf = t.wf;
  let origin = t.p;
  if (t.halign === 3 || t.halign === 5) {
    // Aligned and fit: between the two points.
    const L = dist(t.p, t.a);
    rot = Math.atan2(t.a.y - t.p.y, t.a.x - t.p.x);
    if (lay.width > 0 && L > 0) {
      if (t.halign === 3) {
        h = L / (lay.width * t.wf);
      } else wf = L / (lay.width * t.h);
    }
  } else if (t.halign !== 0 || t.valign !== 0) {
    const a = t.a;
    const dx = t.halign === 1 || t.halign === 4 ? -w / 2 : t.halign === 2 ? -w : 0;
    const dy = t.halign === 4 ? -h / 2 : t.valign === 1 ? DESCENT * h : t.valign === 2 ? -h / 2 : t.valign === 3 ? -h : 0;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    origin = { x: a.x + dx * c - dy * s, y: a.y + dx * s + dy * c };
  }
  const local: Mat = compose(compose(translation(origin.x, origin.y), rotation({ x: 0, y: 0 }, rot)), { a: h * wf, b: 0, c: Math.tan(t.oblique) * h, d: h, e: 0, f: 0 });
  // Text space: baseline at y=0, height 1, y down for the layout.
  const tm = compose(m, compose(local, { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }));
  return { k: 'text', m: tm, layout: lay, family, ink, mtext: false };
}

/** A polyline with width, as filled outlines (segment by segment, arcs as rings). */
function widePline(e: Extract<Entity, { type: 'pline' }>, P: (p: Vec) => Vec, ink: Ink): Prim[] {
  const out: Prim[] = [];
  const n = e.pts.length;
  for (let i = 0; i < (e.closed ? n : n - 1); i++) {
    const p = e.pts[i];
    const q = e.pts[(i + 1) % n];
    const w0 = (p.sw ?? e.width) / 2;
    const w1 = (p.ew ?? e.width) / 2;
    if (Math.abs(p.b) > 1e-12) {
      const a = bulgeArc(p, q, p.b);
      const sw = sweep(a.a0, a.a1);
      const steps = Math.max(8, Math.ceil((sw / TAU) * 64));
      const outer: Vec[] = [];
      const inner: Vec[] = [];
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        const t = a.cw ? a.a1 - sw * f : a.a0 + sw * f;
        const ww = w0 + (w1 - w0) * f;
        outer.push(P(polar(a.c, a.r + ww, t)));
        inner.push(P(polar(a.c, Math.max(0, a.r - ww), t)));
      }
      out.push({ k: 'fill', loops: [[...outer, ...inner.reverse()]], ink });
    } else {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L;
      const ny = dx / L;
      out.push({
        k: 'fill',
        loops: [[P({ x: p.x + nx * w0, y: p.y + ny * w0 }), P({ x: q.x + nx * w1, y: q.y + ny * w1 }), P({ x: q.x - nx * w1, y: q.y - ny * w1 }), P({ x: p.x - nx * w0, y: p.y - ny * w0 })]],
        ink,
      });
    }
  }
  return out;
}

export function primBox(p: Prim, b: Box) {
  switch (p.k) {
    case 'path':
      for (const op of p.ops) {
        if (op.o === 'A') {
          const ccw = op.ccw;
          const a0 = ccw ? op.a0 : op.a1;
          const a1 = ccw ? op.a1 : op.a0;
          arcBox(op.c, op.r, wrapAngle(a0), wrapAngle(a1) + (Math.abs(a1 - a0) >= TAU - 1e-9 ? TAU : 0), b);
          if (Math.abs(op.a1 - op.a0) >= TAU - 1e-9) {
            grow(b, { x: op.c.x - op.r, y: op.c.y - op.r });
            grow(b, { x: op.c.x + op.r, y: op.c.y + op.r });
          }
        } else grow(b, op);
      }
      return;
    case 'fill':
    case 'segs':
      for (const l of p.loops) for (const q of l) grow(b, q);
      return;
    case 'text':
      for (const c of textCorners(p)) grow(b, c);
      return;
    case 'dot':
      grow(b, p.p);
  }
}

export function textCorners(p: Extract<Prim, { k: 'text' }>): Vec[] {
  const lay = p.layout;
  const top = p.mtext ? 0 : -1;
  const bottom = p.mtext ? lay.height : DESCENT;
  const w = Math.max(lay.width, 0.01);
  return [
    { x: 0, y: top },
    { x: w, y: top },
    { x: w, y: bottom },
    { x: 0, y: bottom },
  ].map((c) => apply(p.m, c));
}

/** How far a point is from what a prim draws (0 inside fills and text). */
export function primDistance(p: Prim, q: Vec): number {
  switch (p.k) {
    case 'path': {
      let best = Infinity;
      let last: Vec | null = null;
      let first: Vec | null = null;
      for (const op of p.ops) {
        if (op.o === 'M') {
          last = op;
          first = op;
        } else if (op.o === 'L') {
          if (last) best = Math.min(best, distToSegment(q, last, op));
          last = op;
        } else {
          const a0 = op.ccw ? op.a0 : op.a1;
          const a1 = op.ccw ? op.a1 : op.a0;
          const ang = Math.atan2(q.y - op.c.y, q.x - op.c.x);
          const full = Math.abs(op.a1 - op.a0) >= TAU - 1e-9;
          const on = full || wrapAngle(ang - a0) <= wrapAngle(a1 - a0) + 1e-9;
          const dd = on ? Math.abs(dist(q, op.c) - op.r) : Math.min(dist(q, polar(op.c, op.r, op.a0)), dist(q, polar(op.c, op.r, op.a1)));
          best = Math.min(best, dd);
          last = polar(op.c, op.r, op.a1);
        }
      }
      if (p.closed && last && first) best = Math.min(best, distToSegment(q, last, first));
      return best;
    }
    case 'fill': {
      let inside = false;
      for (const l of p.loops) if (pointInPolygon(q, l)) inside = !inside;
      if (inside) return 0;
      let best = Infinity;
      for (const l of p.loops) for (let i = 0; i < l.length; i++) best = Math.min(best, distToSegment(q, l[i], l[(i + 1) % l.length]));
      return best;
    }
    case 'segs': {
      let inside = false;
      for (const l of p.loops) if (pointInPolygon(q, l)) inside = !inside;
      if (inside) return 0;
      let best = Infinity;
      for (const l of p.loops) for (let i = 0; i < l.length; i++) best = Math.min(best, distToSegment(q, l[i], l[(i + 1) % l.length]));
      return best;
    }
    case 'text': {
      const c = textCorners(p);
      if (pointInPolygon(q, c)) return 0;
      let best = Infinity;
      for (let i = 0; i < 4; i++) best = Math.min(best, distToSegment(q, c[i], c[(i + 1) % 4]));
      return best;
    }
    case 'dot':
      return dist(p.p, q);
  }
}

export function geomDistance(g: Geom, q: Vec, tol: number): number {
  if (q.x < g.box.min.x - tol || q.x > g.box.max.x + tol || q.y < g.box.min.y - tol || q.y > g.box.max.y + tol) return Infinity;
  let best = Infinity;
  for (const p of g.prims) {
    best = Math.min(best, primDistance(p, q));
    if (best === 0) break;
  }
  return best;
}

/** Whether any part of the geometry lies in the box (crossing selection). */
export function geomCrosses(g: Geom, min: Vec, max: Vec): boolean {
  if (g.box.max.x < min.x || g.box.min.x > max.x || g.box.max.y < min.y || g.box.min.y > max.y) return false;
  if (g.box.min.x >= min.x && g.box.max.x <= max.x && g.box.min.y >= min.y && g.box.max.y <= max.y) return true;
  const inBox = (p: Vec) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
  const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
  const segHits = (a: Vec, b: Vec) => {
    if (inBox(a) || inBox(b)) return true;
    for (let i = 0; i < 4; i++) if (segsCross(a, b, corners[i], corners[(i + 1) % 4])) return true;
    return false;
  };
  for (const p of g.prims) {
    if (p.k === 'dot') {
      if (inBox(p.p)) return true;
      continue;
    }
    if (p.k === 'text') {
      const c = textCorners(p);
      for (let i = 0; i < 4; i++) if (segHits(c[i], c[(i + 1) % 4])) return true;
      if (pointInPolygon(corners[0], c)) return true;
      continue;
    }
    if (p.k === 'fill' || p.k === 'segs') {
      for (const l of p.loops) for (let i = 0; i < l.length; i++) if (segHits(l[i], l[(i + 1) % l.length])) return true;
      for (const l of p.loops) if (pointInPolygon(corners[0], l)) return true;
      continue;
    }
    const pts = flattenPath(p.ops);
    for (const run of pts) for (let i = 0; i + 1 < run.length; i++) if (segHits(run[i], run[i + 1])) return true;
    if (p.closed) for (const run of pts) if (run.length > 1 && segHits(run[run.length - 1], run[0])) return true;
  }
  return false;
}

function segsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o = (p: Vec, q: Vec, r: Vec) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** A path as point runs, arcs broken up. */
export function flattenPath(ops: PathOp[]): Vec[][] {
  const runs: Vec[][] = [];
  let cur: Vec[] = [];
  for (const op of ops) {
    if (op.o === 'M') {
      if (cur.length) runs.push(cur);
      cur = [{ x: op.x, y: op.y }];
    } else if (op.o === 'L') cur.push({ x: op.x, y: op.y });
    else {
      const sw = op.a1 - op.a0;
      const n = Math.max(4, Math.ceil((Math.abs(sw) / TAU) * 64));
      for (let i = 1; i <= n; i++) cur.push(polar(op.c, op.r, op.a0 + (sw * i) / n));
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

export { CAP };
