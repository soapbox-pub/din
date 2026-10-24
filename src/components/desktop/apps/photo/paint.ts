import { ctx2d, makeCanvas } from './model';
import type { Point } from './selection';

/** Brushes, the bucket and gradients: the painting half of the tools. */

const dabs = new Map<string, HTMLCanvasElement>();

/** One stamp of a round brush: `hardness` 0-1 is how much of it is solid. */
export function dab(diameter: number, hardness: number, color: string): HTMLCanvasElement {
  const d = Math.max(1, diameter);
  const key = `${d.toFixed(1)}:${hardness.toFixed(2)}:${color}`;
  const hit = dabs.get(key);
  if (hit) return hit;
  const size = Math.ceil(d) + 2;
  const c = makeCanvas(size, size);
  const x = ctx2d(c);
  const r = d / 2;
  const mid = size / 2;
  if (d <= 2) {
    x.fillStyle = color;
    x.beginPath();
    x.arc(mid, mid, r, 0, Math.PI * 2);
    x.fill();
  } else {
    const g = x.createRadialGradient(mid, mid, 0, mid, mid, r);
    const solid = Math.min(0.98, Math.max(0, hardness));
    g.addColorStop(0, color);
    g.addColorStop(solid, color);
    g.addColorStop(1, transparentOf(color));
    // Soft brushes fall off smoothly, the way Photoshop's do.
    if (solid < 0.9) g.addColorStop(solid + (1 - solid) * 0.5, withAlpha(color, 0.35));
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
  }
  if (dabs.size > 64) dabs.delete(dabs.keys().next().value!);
  dabs.set(key, c);
  return c;
}

function parseHex(color: string): [number, number, number] {
  const h = color.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const withAlpha = (color: string, a: number) => {
  const [r, g, b] = parseHex(color);
  return `rgba(${r},${g},${b},${a})`;
};
const transparentOf = (color: string) => withAlpha(color, 0);

/**
 * Call `stamp` every `spacing` pixels from `a` to `b`, starting `carry`
 * pixels along; returns how far past the last dab `b` is, for the next segment.
 */
export function stampLine(a: Point, b: Point, spacing: number, carry: number, stamp: (x: number, y: number) => void): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let t = carry;
  while (t <= len) {
    const f = len ? t / len : 0;
    stamp(a.x + dx * f, a.y + dy * f);
    t += spacing;
    if (!len) break;
  }
  return t - len;
}

/** A pencil dab: a hard-edged disc of whole pixels, no smoothing. */
export function hardDab(diameter: number, color: string): HTMLCanvasElement {
  const d = Math.max(1, Math.round(diameter));
  const key = `hard:${d}:${color}`;
  const hit = dabs.get(key);
  if (hit) return hit;
  const c = makeCanvas(d, d);
  const x = ctx2d(c);
  x.fillStyle = color;
  const r = d / 2;
  for (let py = 0; py < d; py++) {
    for (let px = 0; px < d; px++) {
      if (d <= 2 || (px + 0.5 - r) ** 2 + (py + 0.5 - r) ** 2 <= r * r) x.fillRect(px, py, 1, 1);
    }
  }
  dabs.set(key, c);
  return c;
}

/** Flood fill like Photoshop's bucket: returns a doc-sized mask of what fills. */
export function fillRegion(src: ImageData, x: number, y: number, tolerance: number, contiguous: boolean): ImageData {
  const { width: w, height: h, data: d } = src;
  const out = new ImageData(w, h);
  const o = out.data;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return out;
  const i0 = (y * w + x) * 4;
  const c0 = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const like = (i: number) =>
    Math.abs(d[i + 3] - c0[3]) <= tolerance &&
    ((c0[3] === 0 && d[i + 3] === 0) ||
      (Math.abs(d[i] - c0[0]) <= tolerance && Math.abs(d[i + 1] - c0[1]) <= tolerance && Math.abs(d[i + 2] - c0[2]) <= tolerance));
  const mark = (p: number) => {
    o[p * 4 + 3] = 255;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (like(p * 4)) mark(p);
    return out;
  }
  const seen = new Uint8Array(w * h);
  const stack = [y * w + x];
  seen[y * w + x] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    mark(p);
    const px = p % w;
    const visit = (q: number) => {
      if (!seen[q]) {
        seen[q] = 1;
        if (like(q * 4)) stack.push(q);
      }
    };
    if (px > 0) visit(p - 1);
    if (px < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }
  return out;
}

export type GradientKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export type GradientColors = 'fg-bg' | 'fg-transparent' | 'black-white';

/** Paint a gradient into a doc-sized canvas, from `a` to `b`. */
export function drawGradient(
  w: number,
  h: number,
  a: Point,
  b: Point,
  kind: GradientKind,
  from: string,
  to: string | null,
  reverse: boolean,
): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  const c = ctx2d(out);
  let c0 = from;
  let c1 = to ?? transparentOf(from);
  if (reverse) [c0, c1] = [c1, c0];
  const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  let g: CanvasGradient;
  if (kind === 'radial') {
    g = c.createRadialGradient(a.x, a.y, 0, a.x, a.y, len);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
  } else if (kind === 'angle') {
    g = c.createConicGradient(Math.atan2(b.y - a.y, b.x - a.x), a.x, a.y);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
  } else if (kind === 'reflected') {
    const ex = a.x - (b.x - a.x);
    const ey = a.y - (b.y - a.y);
    g = c.createLinearGradient(ex, ey, b.x, b.y);
    g.addColorStop(0, c1);
    g.addColorStop(0.5, c0);
    g.addColorStop(1, c1);
  } else if (kind === 'diamond') {
    // Four linear quadrants meeting at the start point.
    c.save();
    c.translate(a.x, a.y);
    c.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    for (let q = 0; q < 4; q++) {
      const lg = c.createLinearGradient(0, 0, len / 2, len / 2);
      lg.addColorStop(0, c0);
      lg.addColorStop(1, c1);
      c.fillStyle = lg;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.max(w, h) * 4, 0);
      c.lineTo(0, Math.max(w, h) * 4);
      c.closePath();
      c.fill();
      c.rotate(Math.PI / 2);
    }
    c.restore();
    return out;
  } else {
    g = c.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
  }
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  return parseHex(hex);
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
