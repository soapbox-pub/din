/**
 * Publisher's geometry: IDML's affine transforms ("a b c d tx ty", the
 * same order as a canvas matrix), points, rectangles and the paths frames
 * are made of (anchors with their two direction handles, as InDesign keeps
 * them).
 */

export type Mat = readonly [number, number, number, number, number, number];
export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `a` after `b`: points go through b first. */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** A direction (no translation). */
export function applyVec(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y };
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}
/** A transform about a point. */
export const about = (m: Mat, p: Pt): Mat => mul(translate(p.x, p.y), mul(m, translate(-p.x, -p.y)));

export function parseMat(s: string | null | undefined): Mat {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 6 && n.every(Number.isFinite) ? (n as unknown as Mat) : IDENTITY;
}

const num = (v: number) => {
  const r = Math.round(v * 1e9) / 1e9;
  return Object.is(r, -0) ? '0' : String(r);
};
export const fmtMat = (m: Mat) => m.map(num).join(' ');
export const fmtPt = (p: Pt) => `${num(p.x)} ${num(p.y)}`;
export const fmtNum = num;

/** What the transform does, as InDesign's Control panel shows it. */
export function decompose(m: Mat): { sx: number; sy: number; rotation: number; shear: number } {
  const sx = Math.hypot(m[0], m[1]);
  const rotation = Math.atan2(m[1], m[0]);
  const det = m[0] * m[3] - m[1] * m[2];
  const sy = det / (sx || 1);
  const shear = Math.atan2(m[0] * m[2] + m[1] * m[3], det);
  return { sx, sy, rotation, shear };
}

export function rectCorners(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function boundsOf(pts: Pt[]): Rect {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const transformRect = (m: Mat, r: Rect) => boundsOf(rectCorners(r).map((p) => apply(m, p)));

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export const inRect = (p: Pt, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

// ---- Paths -----------------------------------------------------------------------

export interface PathPoint {
  anchor: Pt;
  left: Pt;
  right: Pt;
}
export interface SubPath {
  points: PathPoint[];
  open: boolean;
}

export const corner = (p: Pt): PathPoint => ({ anchor: p, left: p, right: p });

export function rectPath(r: Rect): SubPath {
  // InDesign's order: top left, bottom left, bottom right, top right.
  return {
    open: false,
    points: [
      corner({ x: r.x, y: r.y }),
      corner({ x: r.x, y: r.y + r.h }),
      corner({ x: r.x + r.w, y: r.y + r.h }),
      corner({ x: r.x + r.w, y: r.y }),
    ],
  };
}

/** An ellipse in four Bézier segments, starting at the left, as InDesign draws ovals. */
export function ovalPath(r: Rect): SubPath {
  const k = 0.5522847498;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  const pt = (x: number, y: number): Pt => ({ x, y });
  return {
    open: false,
    points: [
      { anchor: pt(r.x, cy), left: pt(r.x, cy - ry * k), right: pt(r.x, cy + ry * k) },
      { anchor: pt(cx, r.y + r.h), left: pt(cx - rx * k, r.y + r.h), right: pt(cx + rx * k, r.y + r.h) },
      { anchor: pt(r.x + r.w, cy), left: pt(r.x + r.w, cy + ry * k), right: pt(r.x + r.w, cy - ry * k) },
      { anchor: pt(cx, r.y), left: pt(cx + rx * k, r.y), right: pt(cx - rx * k, r.y) },
    ],
  };
}

/** A regular polygon (or star, with an inset) fitting the rectangle. */
export function polygonPath(r: Rect, sides: number, inset = 0): SubPath {
  const n = Math.max(3, Math.round(sides));
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const pts: PathPoint[] = [];
  const count = inset > 0 ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    const k = inset > 0 && i % 2 ? 1 - inset : 1;
    pts.push(corner({ x: cx + Math.cos(a) * (r.w / 2) * k, y: cy + Math.sin(a) * (r.h / 2) * k }));
  }
  // Stretch it to touch every side of the box, as InDesign does.
  const b = boundsOf(pts.map((p) => p.anchor));
  const fx = (x: number) => r.x + ((x - b.x) / (b.w || 1)) * r.w;
  const fy = (y: number) => r.y + ((y - b.y) / (b.h || 1)) * r.h;
  return { open: false, points: pts.map((p) => corner({ x: fx(p.anchor.x), y: fy(p.anchor.y) })) };
}

export function pathBounds(paths: SubPath[]): Rect {
  const pts: Pt[] = [];
  for (const sp of paths) for (const p of sp.points) pts.push(p.anchor, p.left, p.right);
  return boundsOf(pts);
}

/** Adds the paths to a canvas path (already transformed by the context). */
export function tracePath(c: CanvasRenderingContext2D | Path2D, paths: SubPath[]) {
  for (const sp of paths) {
    const pts = sp.points;
    if (!pts.length) continue;
    c.moveTo(pts[0].anchor.x, pts[0].anchor.y);
    const n = sp.open ? pts.length - 1 : pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const straight = a.right.x === a.anchor.x && a.right.y === a.anchor.y && b.left.x === b.anchor.x && b.left.y === b.anchor.y;
      if (straight) c.lineTo(b.anchor.x, b.anchor.y);
      else c.bezierCurveTo(a.right.x, a.right.y, b.left.x, b.left.y, b.anchor.x, b.anchor.y);
    }
    if (!sp.open) c.closePath();
  }
}

export function mapPaths(paths: SubPath[], f: (p: Pt) => Pt): SubPath[] {
  return paths.map((sp) => ({ open: sp.open, points: sp.points.map((p) => ({ anchor: f(p.anchor), left: f(p.left), right: f(p.right) })) }));
}

/** Every path is the frame's bounding rectangle, with straight sides. */
export function isRectPath(paths: SubPath[]): boolean {
  if (paths.length !== 1 || paths[0].open || paths[0].points.length !== 4) return false;
  const pts = paths[0].points;
  if (pts.some((p) => p.left.x !== p.anchor.x || p.left.y !== p.anchor.y || p.right.x !== p.anchor.x || p.right.y !== p.anchor.y)) return false;
  for (let i = 0; i < 4; i++) {
    const a = pts[i].anchor;
    const b = pts[(i + 1) % 4].anchor;
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false;
  }
  return true;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** How far a point is from a segment. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** The path as straight segments (curves flattened), for hit testing. */
export function flatten(paths: SubPath[], steps = 8): Pt[][] {
  const out: Pt[][] = [];
  for (const sp of paths) {
    const pts = sp.points;
    const poly: Pt[] = [];
    if (!pts.length) continue;
    poly.push(pts[0].anchor);
    const n = sp.open ? pts.length - 1 : pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        poly.push({
          x: u * u * u * a.anchor.x + 3 * u * u * t * a.right.x + 3 * u * t * t * b.left.x + t * t * t * b.anchor.x,
          y: u * u * u * a.anchor.y + 3 * u * u * t * a.right.y + 3 * u * t * t * b.left.y + t * t * t * b.anchor.y,
        });
      }
    }
    out.push(poly);
  }
  return out;
}

export function pointInPolys(p: Pt, polys: Pt[][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}
