/**
 * Paint's pixels. Everything draws with hard edges, one whole pixel at a
 * time, the way MS Paint did: no anti-aliasing, so sprites stay crisp and
 * the fill bucket fills what it looks like it should.
 *
 * Colors are packed into one number per pixel, in the byte order of an
 * ImageData's buffer seen through a Uint32Array (little-endian ABGR).
 * 0 is fully transparent.
 */

export type Packed = number;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** '#rrggbb' or 'transparent'. */
export type Color = string;

export const TRANSPARENT: Color = 'transparent';

export function pack(color: Color): Packed {
  if (color === TRANSPARENT) return 0;
  const n = parseInt(color.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function unpack(p: Packed): Color {
  if (((p >>> 24) & 255) < 128) return TRANSPARENT;
  const r = p & 255;
  const g = (p >>> 8) & 255;
  const b = (p >>> 16) & 255;
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function rgbOf(p: Packed): [number, number, number, number] {
  return [p & 255, (p >>> 8) & 255, (p >>> 16) & 255, (p >>> 24) & 255];
}

export function packRgba(r: number, g: number, b: number, a = 255): Packed {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function hsl(h: number, s: number, l: number): Packed {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return packRgba(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

/** A rectangle of pixels, and the part of it changed since last asked. */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly image: ImageData;
  readonly px: Uint32Array;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(width: number, height: number, image?: ImageData) {
    this.width = width;
    this.height = height;
    this.image = image ?? new ImageData(width, height);
    this.px = new Uint32Array(this.image.data.buffer);
  }

  static filled(width: number, height: number, color: Packed): Surface {
    const s = new Surface(width, height);
    s.px.fill(color);
    return s;
  }

  clone(): Surface {
    const s = new Surface(this.width, this.height);
    s.px.set(this.px);
    return s;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Packed {
    return this.inside(x, y) ? this.px[y * this.width + x] : 0;
  }

  set(x: number, y: number, c: Packed): void {
    if (!this.inside(x, y)) return;
    this.px[y * this.width + x] = c;
    this.touch(x, y, x, y);
  }

  /** Lay `c` over the pixel, keeping what shows through. */
  blend(x: number, y: number, c: Packed): void {
    if (!this.inside(x, y)) return;
    const a = (c >>> 24) & 255;
    if (a === 0) return;
    const i = y * this.width + x;
    if (a === 255) {
      this.px[i] = c;
    } else {
      const d = this.px[i];
      const da = (d >>> 24) & 255;
      const oa = a + (da * (255 - a)) / 255;
      const mix = (shift: number) =>
        Math.round((((c >>> shift) & 255) * a + ((d >>> shift) & 255) * da * (1 - a / 255)) / oa);
      this.px[i] = packRgba(mix(0), mix(8), mix(16), Math.round(oa));
    }
    this.touch(x, y, x, y);
  }

  touch(x0: number, y0: number, x1: number, y1: number): void {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(this.width - 1, x1);
    y1 = Math.min(this.height - 1, y1);
    if (x0 > x1 || y0 > y1) return;
    const d = this.dirty;
    if (!d) this.dirty = { x0, y0, x1, y1 };
    else {
      d.x0 = Math.min(d.x0, x0);
      d.y0 = Math.min(d.y0, y0);
      d.x1 = Math.max(d.x1, x1);
      d.y1 = Math.max(d.y1, y1);
    }
  }

  touchAll(): void {
    this.touch(0, 0, this.width - 1, this.height - 1);
  }

  /** The changed area since the last call, if any. */
  takeDirty(): Rect | null {
    const d = this.dirty;
    this.dirty = null;
    return d ? { x: d.x0, y: d.y0, w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 } : null;
  }

  fillRect(x: number, y: number, w: number, h: number, c: Packed | ((x: number, y: number) => Packed)): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    if (x0 >= x1 || y0 >= y1) return;
    for (let yy = y0; yy < y1; yy++) {
      if (typeof c === 'number') this.px.fill(c, yy * this.width + x0, yy * this.width + x1);
      else for (let xx = x0; xx < x1; xx++) this.px[yy * this.width + xx] = c(xx, yy);
    }
    this.touch(x0, y0, x1 - 1, y1 - 1);
  }

  span(y: number, x0: number, x1: number, c: Packed | ((x: number, y: number) => Packed)): void {
    if (x1 < x0) return;
    this.fillRect(x0, y, x1 - x0 + 1, 1, c);
  }

  /** Copy a region out as a surface of its own. */
  extract(r: Rect): Surface {
    const s = new Surface(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) s.px[y * r.w + x] = this.get(r.x + x, r.y + y);
    }
    return s;
  }

  /** Put another surface's pixels here, skipping `skip` if given. */
  paste(src: Surface, dx: number, dy: number, skip?: Packed, blend = false): void {
    for (let y = 0; y < src.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < src.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) continue;
        const c = src.px[y * src.width + x];
        if (skip !== undefined && c === skip) continue;
        if (blend) this.blend(tx, ty, c);
        else this.px[ty * this.width + tx] = c;
      }
    }
    this.touch(dx, dy, dx + src.width - 1, dy + src.height - 1);
  }

  /** Copy a region back from a same-sized earlier copy of this surface. */
  restore(from: Surface, r: Rect): void {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.width, r.x + r.w);
    const y1 = Math.min(this.height, r.y + r.h);
    for (let y = y0; y < y1; y++) {
      const i = y * this.width;
      this.px.set(from.px.subarray(i + x0, i + x1), i + x0);
    }
    if (x0 < x1 && y0 < y1) this.touch(x0, y0, x1 - 1, y1 - 1);
  }
}

/** Every point on the line between two pixels, both ends included. */
export function line(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export type BrushShape = 'round' | 'square' | 'slash' | 'backslash';

const masks = new Map<string, [number, number][]>();

/** Offsets covered by a brush tip centered on a pixel. */
export function brushMask(size: number, shape: BrushShape): [number, number][] {
  const key = `${shape}:${size}`;
  const cached = masks.get(key);
  if (cached) return cached;
  const out: [number, number][] = [];
  const lo = -Math.floor((size - 1) / 2);
  const hi = lo + size - 1;
  if (shape === 'slash' || shape === 'backslash') {
    for (let i = lo; i <= hi; i++) out.push(shape === 'slash' ? [i, -i] : [i, i]);
  } else {
    const c = (size - 1) / 2 + lo;
    const r2 = (size / 2) ** 2;
    for (let y = lo; y <= hi; y++) {
      for (let x = lo; x <= hi; x++) {
        if (shape === 'square' || size <= 2 || (x - c) ** 2 + (y - c) ** 2 <= r2) {
          out.push([x, y]);
        }
      }
    }
  }
  masks.set(key, out);
  return out;
}

/** Stamp a brush tip. */
export function dab(
  s: Surface,
  x: number,
  y: number,
  size: number,
  shape: BrushShape,
  c: Packed | ((x: number, y: number) => Packed),
): void {
  if (size <= 1) {
    s.set(x, y, typeof c === 'number' ? c : c(x, y));
    return;
  }
  if (shape === 'square') {
    const lo = -Math.floor((size - 1) / 2);
    s.fillRect(x + lo, y + lo, size, size, c);
    return;
  }
  for (const [dx, dy] of brushMask(size, shape)) {
    const px = x + dx;
    const py = y + dy;
    s.set(px, py, typeof c === 'number' ? c : c(px, py));
  }
}

/** Normalize two corners into a rect covering both, inclusive. */
export function rectFrom(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
  };
}

/** Horizontal extents of a shape on each row: [left, right] inclusive, or null. */
type SpanFn = (y: number) => [number, number] | null;

function ellipseSpans(r: Rect): SpanFn {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  return (y) => {
    if (rx <= 0 || ry <= 0) return null;
    const dy = (y + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) return null;
    const half = rx * Math.sqrt(1 - dy * dy);
    const l = Math.ceil(cx - half - 0.5);
    const rr = Math.floor(cx + half - 0.5);
    return l <= rr ? [l, rr] : null;
  };
}

function roundRectSpans(r: Rect, radius: number): SpanFn {
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  return (y) => {
    if (y < r.y || y >= r.y + r.h || r.w <= 0) return null;
    const py = y + 0.5;
    let inset = 0;
    const top = r.y + rad;
    const bottom = r.y + r.h - rad;
    if (py < top || py > bottom) {
      const dy = py < top ? top - py : py - bottom;
      inset = rad - Math.sqrt(Math.max(0, rad * rad - dy * dy));
    }
    const l = Math.ceil(r.x + inset - 0.5);
    const rr = Math.floor(r.x + r.w - inset - 0.5);
    return l <= rr ? [l, rr] : null;
  };
}

function rectSpans(r: Rect): SpanFn {
  return (y) => (y >= r.y && y < r.y + r.h && r.w > 0 ? [r.x, r.x + r.w - 1] : null);
}

function inset(r: Rect, t: number): Rect {
  return { x: r.x + t, y: r.y + t, w: r.w - 2 * t, h: r.h - 2 * t };
}

export type ShapeKind = 'rect' | 'ellipse' | 'roundrect';

/**
 * A rectangle, ellipse or rounded rectangle filling `r`: its outline
 * `thickness` thick in `stroke`, its inside in `fill`. Either may be null.
 */
export function shape(
  s: Surface,
  kind: ShapeKind,
  r: Rect,
  thickness: number,
  stroke: Packed | null,
  fill: Packed | null,
): void {
  const spans = (rr: Rect): SpanFn =>
    kind === 'ellipse' ? ellipseSpans(rr) : kind === 'roundrect' ? roundRectSpans(rr, Math.max(4, Math.min(rr.w, rr.h) / 5)) : rectSpans(rr);
  const outer = spans(r);
  const inner = stroke !== null ? spans(inset(r, thickness)) : outer;
  for (let y = r.y; y < r.y + r.h; y++) {
    const o = outer(y);
    if (!o) continue;
    const i = inner(y);
    if (stroke === null) {
      if (fill !== null) s.span(y, o[0], o[1], fill);
      continue;
    }
    if (!i) {
      s.span(y, o[0], o[1], stroke);
      continue;
    }
    s.span(y, o[0], i[0] - 1, stroke);
    s.span(y, i[1] + 1, o[1], stroke);
    if (fill !== null) s.span(y, i[0], i[1], fill);
  }
}

/** Fill a polygon (even-odd), sampling pixel centers. */
export function fillPolygon(s: Surface, pts: [number, number][], c: Packed): void {
  if (pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.max(0, minY); y <= Math.min(s.height - 1, maxY); y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const ayc = ay + 0.5;
      const byc = by + 0.5;
      if ((ayc <= py && byc > py) || (byc <= py && ayc > py)) {
        xs.push(ax + 0.5 + ((py - ayc) / (byc - ayc)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      s.span(y, Math.ceil(xs[i] - 0.5), Math.floor(xs[i + 1] - 0.5), c);
    }
  }
}

/** Points along a cubic Bézier, close enough together to join with lines. */
export function bezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
): [number, number][] {
  const len =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const steps = Math.max(2, Math.ceil(len / 2));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
    out.push([Math.round(x), Math.round(y)]);
  }
  return out;
}

/**
 * Flood the area of one color around (x, y), 4-connected, with `c` (a
 * color, or a function of position for patterns). Returns whether
 * anything changed.
 */
export function floodFill(
  s: Surface,
  x: number,
  y: number,
  c: Packed | ((x: number, y: number) => Packed),
): boolean {
  if (!s.inside(x, y)) return false;
  const { width: w, height: h, px } = s;
  const target = px[y * w + x];
  if (typeof c === 'number' && c === target) return false;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [x, y];
  let x0 = x;
  let x1 = x;
  let y0 = y;
  let y1 = y;
  while (stack.length) {
    const sy = stack.pop()!;
    let sx = stack.pop()!;
    let i = sy * w + sx;
    while (sx > 0 && !seen[i - 1] && px[i - 1] === target) {
      sx--;
      i--;
    }
    let up = false;
    let down = false;
    for (; sx < w && !seen[i] && px[i] === target; sx++, i++) {
      seen[i] = 1;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      if (sy > 0) {
        const j = i - w;
        const open = !seen[j] && px[j] === target;
        if (open && !up) stack.push(sx, sy - 1);
        up = open;
      }
      if (sy < h - 1) {
        const j = i + w;
        const open = !seen[j] && px[j] === target;
        if (open && !down) stack.push(sx, sy + 1);
        down = open;
      }
    }
    y0 = Math.min(y0, sy);
    y1 = Math.max(y1, sy);
  }
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const i = yy * w + xx;
      if (seen[i]) px[i] = typeof c === 'number' ? c : c(xx, yy);
    }
  }
  s.touch(x0, y0, x1, y1);
  return true;
}

/** Text drawn with the browser's fonts, then snapped to hard pixels if `crisp`. */
export function textSurface(
  text: string,
  font: string,
  size: number,
  color: Packed,
  crisp: boolean,
): Surface | null {
  const lines = text.split('\n');
  const lineHeight = Math.round(size * 1.25);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = font;
  const width = Math.ceil(Math.max(1, ...lines.map((l) => ctx.measureText(l).width))) + 2;
  const height = lineHeight * lines.length + 2;
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  ctx.textBaseline = 'top';
  const [r, g, b] = rgbOf(color);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  lines.forEach((l, i) => ctx.fillText(l, 0, i * lineHeight + Math.round((lineHeight - size) / 2)));
  const out = new Surface(width, height, ctx.getImageData(0, 0, width, height));
  if (crisp) {
    const solid = color | 0xff000000;
    for (let i = 0; i < out.px.length; i++) out.px[i] = (out.px[i] >>> 24) >= 110 ? solid >>> 0 : 0;
  }
  return out;
}

/** An emoji (or any text) rendered as a stamp `size` pixels tall. */
export function glyphSurface(glyph: string, size: number, crisp: boolean): Surface | null {
  const canvas = document.createElement('canvas');
  const pad = Math.ceil(size * 0.25);
  canvas.width = size + pad * 2;
  canvas.height = size + pad * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = `${size}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, canvas.width / 2, canvas.height / 2 + size * 0.06);
  const out = new Surface(canvas.width, canvas.height, ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (crisp) {
    for (let i = 0; i < out.px.length; i++) {
      const p = out.px[i];
      out.px[i] = (p >>> 24) >= 128 ? (p | 0xff000000) >>> 0 : 0;
    }
  }
  return out;
}
