import type { PubPath, PubPoint } from './doc';

/**
 * Outlines for Office's preset shapes (the MSO shape types Publisher uses),
 * in the shape's own box from 0 to 1, from its adjust values (in Office's
 * 21600-unit space), and for freeforms from their vertex and segment
 * arrays. Shapes not here come back as null and are drawn as their box.
 */

const U = 21600;

const P = (x: number, y: number): PubPoint => ({ x: x / U, y: y / U });
const corner = (p: PubPoint) => ({ anchor: p, left: p, right: p });
const poly = (pts: [number, number][]): PubPath[] => [{ open: false, points: pts.map(([x, y]) => corner(P(x, y))) }];

function star(points: number, inner: number): PubPath[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : 1;
    pts.push([U / 2 + (Math.cos(a) * r * U) / 2, U / 2 + (Math.sin(a) * r * U) / 2]);
  }
  return poly(pts);
}

export type Preset = { kind: 'rect' } | { kind: 'ellipse' } | { kind: 'line' } | { kind: 'round'; radius: number } | { kind: 'path'; paths: PubPath[] };

/** Box-filling shapes Publisher uses for text boxes, pictures and plain rectangles. */
const RECTS = new Set([0, 1, 75, 201, 202]);

export function preset(type: number, adj: (i: number, d: number) => number): Preset | null {
  if (RECTS.has(type)) return { kind: 'rect' };
  switch (type) {
    case 2:
      return { kind: 'round', radius: adj(0, 3600) / U };
    case 3:
      return { kind: 'ellipse' };
    case 20:
    case 32:
      return { kind: 'line' };
    case 4:
      return { kind: 'path', paths: poly([[U / 2, 0], [U, U / 2], [U / 2, U], [0, U / 2]]) };
    case 5: {
      const a = adj(0, 10800);
      return { kind: 'path', paths: poly([[a, 0], [U, U], [0, U]]) };
    }
    case 6:
      return { kind: 'path', paths: poly([[0, 0], [U, U], [0, U]]) };
    case 7: {
      const a = adj(0, 5400);
      return { kind: 'path', paths: poly([[a, 0], [U, 0], [U - a, U], [0, U]]) };
    }
    case 8: {
      const a = adj(0, 5400);
      return { kind: 'path', paths: poly([[0, 0], [U, 0], [U - a, U], [a, U]]) };
    }
    case 9: {
      const a = adj(0, 5400);
      return { kind: 'path', paths: poly([[a, 0], [U - a, 0], [U, U / 2], [U - a, U], [a, U], [0, U / 2]]) };
    }
    case 10: {
      const a = adj(0, 6326);
      return { kind: 'path', paths: poly([[a, 0], [U - a, 0], [U, a], [U, U - a], [U - a, U], [a, U], [0, U - a], [0, a]]) };
    }
    case 11: {
      const a = adj(0, 5400);
      return { kind: 'path', paths: poly([[a, 0], [U - a, 0], [U - a, a], [U, a], [U, U - a], [U - a, U - a], [U - a, U], [a, U], [a, U - a], [0, U - a], [0, a], [a, a]]) };
    }
    case 12:
      return { kind: 'path', paths: star(5, 0.382) };
    case 92:
      return { kind: 'path', paths: star(24, 0.8) };
    case 58:
      return { kind: 'path', paths: star(8, 0.75) };
    case 59:
      return { kind: 'path', paths: star(16, 0.8) };
    case 60:
      return { kind: 'path', paths: star(32, 0.85) };
    case 187:
      return { kind: 'path', paths: star(4, 0.38) };
    case 13: {
      const a = adj(0, 16200);
      const b = adj(1, 5400);
      return { kind: 'path', paths: poly([[0, b], [a, b], [a, 0], [U, U / 2], [a, U], [a, U - b], [0, U - b]]) };
    }
    case 66: {
      const a = adj(0, 5400);
      const b = adj(1, 5400);
      return { kind: 'path', paths: poly([[U, b], [a, b], [a, 0], [0, U / 2], [a, U], [a, U - b], [U, U - b]]) };
    }
    case 67: {
      const a = adj(0, 16200);
      const b = adj(1, 5400);
      return { kind: 'path', paths: poly([[b, 0], [b, a], [0, a], [U / 2, U], [U, a], [U - b, a], [U - b, 0]]) };
    }
    case 68: {
      const a = adj(0, 5400);
      const b = adj(1, 5400);
      return { kind: 'path', paths: poly([[b, U], [b, a], [0, a], [U / 2, 0], [U, a], [U - b, a], [U - b, U]]) };
    }
    case 69: {
      const a = adj(0, 4320);
      const b = adj(1, 5400);
      return { kind: 'path', paths: poly([[0, U / 2], [a, 0], [a, b], [U - a, b], [U - a, 0], [U, U / 2], [U - a, U], [U - a, U - b], [a, U - b], [a, U]]) };
    }
    case 70: {
      const a = adj(0, 5400);
      const b = adj(1, 4320);
      return { kind: 'path', paths: poly([[U / 2, 0], [U, b], [U - a, b], [U - a, U - b], [U, U - b], [U / 2, U], [0, U - b], [a, U - b], [a, b], [0, b]]) };
    }
    case 15: {
      const a = adj(0, 16200);
      return { kind: 'path', paths: poly([[0, 0], [a, 0], [U, U / 2], [a, U], [0, U]]) };
    }
    case 55: {
      const a = adj(0, 16200);
      return { kind: 'path', paths: poly([[0, 0], [a, 0], [U, U / 2], [a, U], [0, U], [U - a, U / 2]]) };
    }
    case 56:
      return { kind: 'path', paths: poly([[U / 2, 0], [U, 8260], [17370, U], [4230, U], [0, 8260]]) };
    case 74:
      return {
        kind: 'path',
        paths: [{
          open: false,
          points: [
            { anchor: P(10800, 21600), left: P(10800, 21600), right: P(10800, 21600) },
            { anchor: P(0, 5400), left: P(2200, 13000), right: P(-600, 1200) },
            { anchor: P(10800, 4000), left: P(6000, -1800), right: P(10800, 4000) },
            { anchor: P(21600, 5400), left: P(22200, 1200), right: P(19400, 13000) },
          ],
        }],
      };
    case 73:
      return { kind: 'path', paths: poly([[8458, 0], [0, 3923], [7564, 8416], [4993, 9720], [12197, 13904], [9987, 14934], [21600, 21600], [14768, 12911], [16558, 12016], [11030, 6840], [12831, 6120], [8458, 0]]) };
  }
  return null;
}

/**
 * A freeform's outline from its vertices (pairs of numbers in a
 * `geoW` x `geoH` space) and segment commands (MS-ODRAW MSOPATHINFO).
 */
export function freeform(vertices: PubPoint[], segments: number[], geoW: number, geoH: number, closedByDefault: boolean): PubPath[] {
  const sx = 1 / (geoW || U);
  const sy = 1 / (geoH || U);
  const at = (i: number) => {
    const v = vertices[Math.min(i, vertices.length - 1)] ?? { x: 0, y: 0 };
    return { x: v.x * sx, y: v.y * sy };
  };
  if (!vertices.length) return [];
  if (!segments.length) return [{ open: !closedByDefault, points: vertices.map((_, i) => corner(at(i))) }];
  const out: PubPath[] = [];
  let cur: PubPath | null = null;
  let vi = 0;
  const start = (p: PubPoint) => {
    cur = { open: true, points: [corner(p)] };
    out.push(cur);
  };
  for (const seg of segments) {
    const type = seg >> 13;
    const count = seg & 0x1fff;
    if (type === 2) {
      start(at(vi++));
    } else if (type === 0) {
      for (let k = 0; k < Math.max(1, count); k++) {
        const p = at(vi++);
        if (!cur) start(p);
        else (cur as PubPath).points.push(corner(p));
      }
    } else if (type === 1) {
      for (let k = 0; k < Math.max(1, count); k++) {
        const c1 = at(vi);
        const c2 = at(vi + 1);
        const p = at(vi + 2);
        vi += 3;
        if (!cur) start(c1);
        const c = cur as unknown as PubPath;
        const last = c.points[c.points.length - 1];
        last.right = c1;
        c.points.push({ anchor: p, left: c2, right: p });
      }
    } else if (type === 3) {
      if (cur) {
        const c = cur as PubPath;
        c.open = false;
        // A closing point on top of the first merges into it.
        const a = c.points[0];
        const z = c.points[c.points.length - 1];
        if (c.points.length > 1 && Math.abs(a.anchor.x - z.anchor.x) < 1e-6 && Math.abs(a.anchor.y - z.anchor.y) < 1e-6) {
          a.left = z.left;
          c.points.pop();
        }
      }
    } else if (type === 4) {
      cur = null;
    } else if (type === 5) {
      // Escapes (arcs and the like) consume vertices without a simple equivalent; keep the count right.
      vi += count & 0xff;
    }
  }
  return out.filter((p) => p.points.length > 1);
}
