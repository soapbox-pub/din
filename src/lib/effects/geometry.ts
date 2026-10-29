/**
 * Building blocks for effects, after the two kinds Compiz's animation
 * plugins draw: a window deformed as one grid mesh (`grid`), and a window
 * cut into polygons that each move on their own (`pieces`, Compiz's
 * PolygonSet).
 */

import type { EffectSetup, Scene } from '@/lib/effects/engine';

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Where `p` is between `a` and `b`, 0 to 1. */
export const segment = (p: number, a: number, b: number): number => clamp((p - a) / (b - a));
export const easeIn = (t: number): number => t * t;
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeInOut = (t: number): number => t * t * (3 - 2 * t);

/** A grid vertex, as a grid function leaves it. */
export interface GridPoint {
  x: number;
  y: number;
  z: number;
  alpha: number;
  shade: number;
}

/** The window region a grid covers, as fractions of it. */
export interface GridRegion {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

const WHOLE: GridRegion = { u0: 0, u1: 1, v0: 0, v1: 1 };

/**
 * Draw `region` of the window (all of it by default) as a `cols` × `rows`
 * mesh. `fn` places the vertex showing window point (`u`, `v`); it gets the
 * point where it lies at rest, unlit and opaque, to change. Region edges on
 * the window's own edges reach into the snapshot's transparent border.
 */
export function grid(
  scene: Scene,
  setup: EffectSetup,
  cols: number,
  rows: number,
  fn: (u: number, v: number, out: GridPoint) => void,
  region: GridRegion = WHOLE,
): void {
  const { win, pad } = setup;
  const u0 = region.u0 === 0 ? -pad.x : region.u0;
  const u1 = region.u1 === 1 ? 1 + pad.x : region.u1;
  const v0 = region.v0 === 0 ? -pad.y : region.v0;
  const v1 = region.v1 === 1 ? 1 + pad.y : region.v1;
  const stride = cols + 1;
  const pts = new Float32Array(stride * (rows + 1) * 7);
  const pt: GridPoint = { x: 0, y: 0, z: 0, alpha: 1, shade: 1 };
  for (let r = 0; r <= rows; r++) {
    const v = lerp(v0, v1, r / rows);
    for (let c = 0; c <= cols; c++) {
      const u = lerp(u0, u1, c / cols);
      pt.x = win.x + u * win.width;
      pt.y = win.y + v * win.height;
      pt.z = 0;
      pt.alpha = 1;
      pt.shade = 1;
      fn(u, v, pt);
      const i = (r * stride + c) * 7;
      pts[i] = pt.x;
      pts[i + 1] = pt.y;
      pts[i + 2] = pt.z;
      pts[i + 3] = u;
      pts[i + 4] = v;
      pts[i + 5] = pt.alpha;
      pts[i + 6] = pt.shade;
    }
  }
  const put = (r: number, c: number) => {
    const i = (r * stride + c) * 7;
    scene.vertex(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5], pts[i + 6]);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      put(r, c);
      put(r, c + 1);
      put(r + 1, c);
      put(r + 1, c);
      put(r, c + 1);
      put(r + 1, c + 1);
    }
  }
}

/** A polygon cut from the window, in workspace pixels. */
export interface Piece {
  /** Its center (centroid), which it turns about by default. */
  cx: number;
  cy: number;
  /** Its corners, around the outline: offsets from the center, and the window point (u, v) each shows. */
  corners: { x: number; y: number; u: number; v: number }[];
  /** Its column and row, for pieces cut on a grid. */
  col: number;
  row: number;
}

/** Cut the window into a `cols` × `rows` grid of rectangles. */
export function rectPieces(setup: EffectSetup, cols: number, rows: number): Piece[] {
  const pieces: Piece[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ua = col / cols;
      const ub = (col + 1) / cols;
      const va = row / rows;
      const vb = (row + 1) / rows;
      pieces.push(polygon([[ua, va], [ub, va], [ub, vb], [ua, vb]], setup, col, row));
    }
  }
  return pieces;
}

/**
 * Cut the window into triangular shards: a `cols` × `rows` grid whose inner
 * points are jittered, each cell split along a random diagonal (Compiz's
 * "glass" tessellation, by another route).
 */
export function shardPieces(setup: EffectSetup, cols: number, rows: number): Piece[] {
  const { random } = setup;
  const pts: [number, number][] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const jx = c > 0 && c < cols ? (random() - 0.5) * 0.7 : 0;
      const jy = r > 0 && r < rows ? (random() - 0.5) * 0.7 : 0;
      pts.push([(c + jx) / cols, (r + jy) / rows]);
    }
  }
  const at = (r: number, c: number) => pts[r * (cols + 1) + c];
  const pieces: Piece[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = at(r, c);
      const b = at(r, c + 1);
      const d = at(r + 1, c);
      const e = at(r + 1, c + 1);
      if (random() < 0.5) {
        pieces.push(polygon([a, b, e], setup, c, r));
        pieces.push(polygon([a, e, d], setup, c, r));
      } else {
        pieces.push(polygon([a, b, d], setup, c, r));
        pieces.push(polygon([b, e, d], setup, c, r));
      }
    }
  }
  return pieces;
}

function polygon(uv: [number, number][], setup: EffectSetup, col: number, row: number): Piece {
  const { win } = setup;
  let cu = 0;
  let cv = 0;
  for (const [u, v] of uv) {
    cu += u / uv.length;
    cv += v / uv.length;
  }
  const cx = win.x + cu * win.width;
  const cy = win.y + cv * win.height;
  return {
    cx,
    cy,
    col,
    row,
    corners: uv.map(([u, v]) => ({ x: win.x + u * win.width - cx, y: win.y + v * win.height - cy, u, v })),
  };
}

/** Where a piece is at one moment: turned about an axis, then moved. */
export interface PieceMotion {
  /** Movement, in pixels (z toward the viewer). */
  dx: number;
  dy: number;
  dz: number;
  /** The axis it turns about (needn't be unit length) and the angle, in radians. */
  ax: number;
  ay: number;
  az: number;
  angle: number;
  /** The point it turns about, relative to its center. */
  px: number;
  py: number;
  pz: number;
  alpha: number;
}

/**
 * Draw `pieces`, each placed by `motion`, which gets it at rest (unmoved and
 * opaque) to change. Shaded by how far each faces away, and drawn back to
 * front.
 */
export function drawPieces(
  scene: Scene,
  pieces: Piece[],
  motion: (piece: Piece, index: number, out: PieceMotion) => void,
): void {
  const placed: { z: number; alpha: number; shade: number; pts: number[]; piece: Piece }[] = [];
  const m: PieceMotion = { dx: 0, dy: 0, dz: 0, ax: 0, ay: 0, az: 1, angle: 0, px: 0, py: 0, pz: 0, alpha: 1 };
  pieces.forEach((piece, index) => {
    m.dx = m.dy = m.dz = 0;
    m.ax = m.ay = 0;
    m.az = 1;
    m.angle = 0;
    m.px = m.py = m.pz = 0;
    m.alpha = 1;
    motion(piece, index, m);
    if (m.alpha <= 0.002) return;
    const len = Math.hypot(m.ax, m.ay, m.az) || 1;
    const kx = m.ax / len;
    const ky = m.ay / len;
    const kz = m.az / len;
    const cos = Math.cos(m.angle);
    const sin = Math.sin(m.angle);
    const rotate = (x: number, y: number, z: number): [number, number, number] => {
      // Rodrigues' rotation formula.
      const dot = kx * x + ky * y + kz * z;
      return [
        x * cos + (ky * z - kz * y) * sin + kx * dot * (1 - cos),
        y * cos + (kz * x - kx * z) * sin + ky * dot * (1 - cos),
        z * cos + (kx * y - ky * x) * sin + kz * dot * (1 - cos),
      ];
    };
    const pts: number[] = [];
    let zSum = 0;
    for (const c of piece.corners) {
      const [x, y, z] = rotate(c.x - m.px, c.y - m.py, -m.pz);
      const wz = z + m.pz + m.dz;
      pts.push(piece.cx + x + m.px + m.dx, piece.cy + y + m.py + m.dy, wz);
      zSum += wz;
    }
    const nz = Math.abs(rotate(0, 0, 1)[2]);
    placed.push({ z: zSum / piece.corners.length, alpha: m.alpha, shade: 0.45 + 0.55 * nz, pts, piece });
  });
  placed.sort((a, b) => a.z - b.z);
  for (const { alpha, shade, pts, piece } of placed) {
    const c = piece.corners;
    const put = (i: number) => scene.vertex(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], c[i].u, c[i].v, alpha, shade);
    for (let i = 1; i < c.length - 1; i++) {
      put(0);
      put(i);
      put(i + 1);
    }
  }
}

/** Pieces of a sensible size for the window: about `size` pixels across. */
export function cuts(setup: EffectSetup, size: number, min = 3, max = 18): { cols: number; rows: number } {
  const { win } = setup;
  return {
    cols: Math.round(clamp(win.width / size, min, max)),
    rows: Math.round(clamp(win.height / size, min, max)),
  };
}
