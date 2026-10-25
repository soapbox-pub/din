/**
 * Hatch patterns (a selection from acad.pat, in its own notation) and the
 * line work they make inside a boundary.
 */
import type { HatchLoop, PatternLine, Vec } from './model';
import { bulgeArc, ellipsePoint, plinePoints, polar, splinePoints, sweep, TAU, type Box } from './geom';

/** angle, x, y, dx, dy, dashes… per line, in inches, as acad.pat writes them. */
type PatDef = number[][];

export const PATTERNS: Record<string, { description: string; lines: PatDef }> = {
  ANSI31: { description: 'ANSI Iron, Brick, Stone masonry', lines: [[45, 0, 0, 0, 0.125]] },
  ANSI32: { description: 'ANSI Steel', lines: [[45, 0, 0, 0, 0.375], [45, 0.176776695, 0, 0, 0.375]] },
  ANSI33: { description: 'ANSI Bronze, Brass, Copper', lines: [[45, 0, 0, 0, 0.25], [45, 0.176776695, 0, 0, 0.25, 0.125, -0.0625]] },
  ANSI34: { description: 'ANSI Plastic, Rubber', lines: [[45, 0, 0, 0, 0.75], [45, 0.176776695, 0, 0, 0.75], [45, 0.353553391, 0, 0, 0.75], [45, 0.530330086, 0, 0, 0.75]] },
  ANSI35: { description: 'ANSI Fire brick, Refractory material', lines: [[45, 0, 0, 0, 0.25], [45, 0.176776695, 0, 0, 0.25, 0.3125, -0.0625, 0, -0.0625]] },
  ANSI36: { description: 'ANSI Marble, Slate, Glass', lines: [[45, 0, 0, 0.21875, 0.125, 0.3125, -0.0625, 0, -0.0625]] },
  ANSI37: { description: 'ANSI Lead, Zinc, Magnesium, Sound/Heat/Elec Insulation', lines: [[45, 0, 0, 0, 0.125], [135, 0, 0, 0, 0.125]] },
  ANSI38: { description: 'ANSI Aluminum', lines: [[45, 0, 0, 0, 0.125], [135, 0, 0, 0.25, 0.125, 0.3125, -0.1875]] },
  ANGLE: { description: 'Angle steel', lines: [[0, 0, 0, 0, 0.275, 0.2, -0.075], [90, 0, 0, 0, 0.275, 0.2, -0.075]] },
  BRICK: { description: 'Brick or masonry-type surface', lines: [[0, 0, 0, 0, 0.25], [90, 0, 0, 0, 0.5, 0.25, -0.25], [90, 0.25, 0, 0, 0.5, -0.25, 0.25]] },
  CROSS: { description: 'A series of crosses', lines: [[0, 0, 0, 0.25, 0.25, 0.125, -0.375], [90, 0.0625, -0.0625, 0.25, 0.25, 0.125, -0.375]] },
  DASH: { description: 'Dashed lines', lines: [[0, 0, 0, 0.125, 0.125, 0.125, -0.125]] },
  DOTS: { description: 'A series of dots', lines: [[0, 0, 0, 0.03125, 0.0625, 0, -0.0625]] },
  EARTH: {
    description: 'Earth or ground (subterranean)',
    lines: [
      [0, 0, 0, 0.25, 0.25, 0.25, -0.25],
      [0, 0, 0.09375, 0.25, 0.25, 0.25, -0.25],
      [0, 0, 0.1875, 0.25, 0.25, 0.25, -0.25],
      [90, 0.03125, 0.21875, 0.25, 0.25, 0.25, -0.25],
      [90, 0.125, 0.21875, 0.25, 0.25, 0.25, -0.25],
      [90, 0.21875, 0.21875, 0.25, 0.25, 0.25, -0.25],
    ],
  },
  GRASS: { description: 'Grass area', lines: [[90, 0, 0, 0.707106781, 0.707106781, 0.1875, -1.226713563], [45, 0, 0, 0, 1, 0.1875, -0.8125], [135, 0, 0, 0, 1, 0.1875, -0.8125]] },
  LINE: { description: 'Parallel horizontal lines', lines: [[0, 0, 0, 0, 0.125]] },
  NET: { description: 'Horizontal / vertical grid', lines: [[0, 0, 0, 0, 0.125], [90, 0, 0, 0, 0.125]] },
  SQUARE: { description: 'Small aligned squares', lines: [[0, 0, 0, 0, 0.125, 0.125, -0.125], [90, 0, 0, 0, 0.125, 0.125, -0.125]] },
  ZIGZAG: { description: 'Staircase effect', lines: [[0, 0, 0, 0.125, 0.125, 0.125, -0.125], [90, 0.125, 0, 0.125, 0.125, 0.125, -0.125]] },
};

/** The definition lines DWG stores for a pattern at an angle (radians) and scale; metric drawings use acadiso.pat's millimetres. */
export function patternLines(name: string, angle: number, scale: number, metric: boolean): PatternLine[] {
  const def = PATTERNS[name.toUpperCase()];
  if (!def) return [];
  const k = scale * (metric ? 25.4 : 1);
  return def.lines.map(([deg, x, y, dx, dy, ...dashes]) => {
    const a = (deg * Math.PI) / 180 + angle;
    const base = rot({ x: x * k, y: y * k }, angle);
    const offset = rot({ x: dx * k, y: dy * k }, a);
    return { angle: a, base, offset, dashes: dashes.map((d) => d * k) };
  });
}

function rot(p: Vec, a: number): Vec {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** A hatch boundary as closed polygons. */
export function loopPolygons(loops: HatchLoop[]): Vec[][] {
  const out: Vec[][] = [];
  for (const l of loops) {
    if (l.kind === 'poly') {
      const pts = plinePoints(l.pts, true, 48);
      if (pts.length > 2) out.push(pts);
      continue;
    }
    const pts: Vec[] = [];
    for (const e of l.edges) {
      if (e.t === 'line') pts.push(e.a, e.b);
      else if (e.t === 'arc') {
        const a0 = e.ccw ? e.start : -e.start;
        const a1 = e.ccw ? e.end : -e.end;
        const sw = e.ccw ? sweep(a0, a1) : -sweep(a1, a0);
        const n = Math.max(4, Math.ceil((Math.abs(sw) / TAU) * 64));
        for (let i = 0; i <= n; i++) pts.push(polar(e.c, e.r, a0 + (sw * i) / n));
      } else if (e.t === 'ellipse') {
        const a0 = e.ccw ? e.start : -e.start;
        const a1 = e.ccw ? e.end : -e.end;
        const sw = e.ccw ? sweep(a0, a1) : -sweep(a1, a0);
        const n = Math.max(8, Math.ceil((Math.abs(sw) / TAU) * 64));
        for (let i = 0; i <= n; i++) pts.push(ellipsePoint(e.c, e.major, e.ratio, a0 + (sw * i) / n));
      } else pts.push(...splinePoints(e.degree, e.knots, e.ctrl, e.weights, 48));
    }
    if (pts.length > 2) out.push(pts);
  }
  return out;
}

/** Most line segments one hatch draws before it's shown as a tint instead. */
export const MAX_HATCH_SEGMENTS = 40000;

/**
 * The pattern's line segments inside the polygons (even-odd), as flat
 * [x0, y0, x1, y1, …], or null if there would be too many to draw.
 */
export function hatchSegments(lines: PatternLine[], polys: Vec[][], box: Box): Float64Array | null {
  const out: number[] = [];
  const edges: [Vec, Vec][] = [];
  for (const p of polys) for (let i = 0; i < p.length; i++) edges.push([p[i], p[(i + 1) % p.length]]);
  for (const pl of lines) {
    const u = { x: Math.cos(pl.angle), y: Math.sin(pl.angle) };
    const n = { x: -u.y, y: u.x };
    const spacing = pl.offset.x * n.x + pl.offset.y * n.y;
    if (Math.abs(spacing) < 1e-9) continue;
    const shift = pl.offset.x * u.x + pl.offset.y * u.y;
    const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
    const proj = corners.map((c) => ((c.x - pl.base.x) * n.x + (c.y - pl.base.y) * n.y) / spacing);
    const k0 = Math.floor(Math.min(...proj));
    const k1 = Math.ceil(Math.max(...proj));
    if ((k1 - k0) * (pl.dashes.length || 1) > MAX_HATCH_SEGMENTS * 4) return null;
    const total = pl.dashes.reduce((s, d) => s + Math.abs(d), 0);
    for (let k = k0; k <= k1; k++) {
      const o = { x: pl.base.x + pl.offset.x * k, y: pl.base.y + pl.offset.y * k };
      // Crossings of this line with the boundary, as distances along it.
      const ts: number[] = [];
      for (const [a, b] of edges) {
        const da = (a.x - o.x) * n.x + (a.y - o.y) * n.y;
        const db = (b.x - o.x) * n.x + (b.y - o.y) * n.y;
        if ((da > 0) === (db > 0) || da === db) continue;
        const t = da / (da - db);
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        ts.push((px - o.x) * u.x + (py - o.y) * u.y);
      }
      if (ts.length < 2) continue;
      ts.sort((p, q) => p - q);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i];
        const t1 = ts[i + 1];
        if (!pl.dashes.length || total < 1e-12) {
          out.push(o.x + u.x * t0, o.y + u.y * t0, o.x + u.x * t1, o.y + u.y * t1);
        } else {
          // Dash phase: the pattern starts at the line's origin, shifted per row.
          const phase = shift * k;
          let s = t0 - ((((t0 - phase) % total) + total) % total);
          let di = 0;
          while (s < t1) {
            const dl = pl.dashes[di % pl.dashes.length];
            const e = s + Math.abs(dl);
            if (dl >= 0) {
              const a0 = Math.max(s, t0);
              const a1 = Math.min(dl === 0 ? s : e, t1);
              if (dl === 0 && s >= t0 && s <= t1) out.push(o.x + u.x * s, o.y + u.y * s, o.x + u.x * s, o.y + u.y * s);
              else if (a1 > a0) out.push(o.x + u.x * a0, o.y + u.y * a0, o.x + u.x * a1, o.y + u.y * a1);
            }
            s = e;
            di++;
            if (out.length > MAX_HATCH_SEGMENTS * 4) return null;
          }
        }
        if (out.length > MAX_HATCH_SEGMENTS * 4) return null;
      }
    }
  }
  return Float64Array.from(out);
}

export { bulgeArc };
