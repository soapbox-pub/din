import { toCss, toHex, toRgb, type Color } from './pdf/color';
import type { GradStop, Gradient, Mat, Paint, Rect } from './model';

/** Paints as CSS (for swatches), Illustrator's default swatches, and gradient geometry. */

export function cssPaint(p: Paint): string {
  if (p.type === 'none') return 'transparent';
  if (p.type === 'color') return toCss(p.color);
  const stops = [...p.gradient.stops].sort((a, b) => a.t - b.t).map((s) => `${toCss(s.color, s.opacity)} ${Math.round(s.t * 100)}%`);
  if (stops.length === 1) stops.push(stops[0]);
  return p.gradient.type === 'linear' ? `linear-gradient(90deg, ${stops.join(', ')})` : `radial-gradient(circle, ${stops.join(', ')})`;
}

export function paintHex(p: Paint): string {
  if (p.type === 'color') return toHex(p.color);
  if (p.type === 'gradient') return toHex(p.gradient.stops[0]?.color ?? { space: 'gray', c: [0] });
  return '#ffffff';
}

const rgb = (r: number, g: number, b: number): Color => ({ space: 'rgb', c: [r / 255, g / 255, b / 255] });
const cmyk = (c: number, m: number, y: number, k: number): Color => ({ space: 'cmyk', c: [c / 100, m / 100, y / 100, k / 100] });

export interface Swatch {
  name: string;
  paint: Paint;
}

/** The default RGB document's swatches, near enough. */
export const RGB_SWATCHES: Swatch[] = [
  { name: '[None]', paint: { type: 'none' } },
  { name: 'White', paint: { type: 'color', color: rgb(255, 255, 255) } },
  { name: 'Black', paint: { type: 'color', color: rgb(0, 0, 0) } },
  ...(
    [
      ['R=255 G=0 B=0', 255, 0, 0], ['R=255 G=255 B=0', 255, 255, 0], ['R=0 G=255 B=0', 0, 255, 0], ['R=0 G=255 B=255', 0, 255, 255],
      ['R=0 G=0 B=255', 0, 0, 255], ['R=255 G=0 B=255', 255, 0, 255], ['R=193 G=39 B=45', 193, 39, 45], ['R=237 G=28 B=36', 237, 28, 36],
      ['R=241 G=90 B=36', 241, 90, 36], ['R=247 G=147 B=30', 247, 147, 30], ['R=251 G=176 B=59', 251, 176, 59], ['R=252 G=238 B=33', 252, 238, 33],
      ['R=217 G=224 B=33', 217, 224, 33], ['R=140 G=198 B=63', 140, 198, 63], ['R=57 G=181 B=74', 57, 181, 74], ['R=0 G=146 B=69', 0, 146, 69],
      ['R=0 G=104 B=55', 0, 104, 55], ['R=34 G=181 B=115', 34, 181, 115], ['R=0 G=169 B=157', 0, 169, 157], ['R=41 G=171 B=226', 41, 171, 226],
      ['R=0 G=113 B=188', 0, 113, 188], ['R=46 G=49 B=146', 46, 49, 146], ['R=27 G=20 B=100', 27, 20, 100], ['R=102 G=45 B=145', 102, 45, 145],
      ['R=147 G=39 B=143', 147, 39, 143], ['R=158 G=0 B=93', 158, 0, 93], ['R=212 G=20 B=90', 212, 20, 90], ['R=237 G=30 B=121', 237, 30, 121],
      ['R=199 G=178 B=153', 199, 178, 153], ['R=153 G=134 B=117', 153, 134, 117], ['R=115 G=99 B=87', 115, 99, 87], ['R=83 G=71 B=65', 83, 71, 65],
      ['R=198 G=156 B=109', 198, 156, 109], ['R=166 G=124 B=82', 166, 124, 82], ['R=140 G=98 B=57', 140, 98, 57], ['R=117 G=76 B=36', 117, 76, 36],
      ['R=96 G=56 B=19', 96, 56, 19], ['R=66 G=33 B=11', 66, 33, 11],
    ] as [string, number, number, number][]
  ).map(([name, r, g, b]) => ({ name, paint: { type: 'color', color: rgb(r, g, b) } as Paint })),
  ...[100, 90, 80, 70, 60, 50, 40, 30, 20, 10].map((k) => ({ name: `${k}% Gray`, paint: { type: 'color', color: rgb(255 - k * 2.55, 255 - k * 2.55, 255 - k * 2.55) } as Paint })),
];

export const CMYK_SWATCHES: Swatch[] = [
  { name: '[None]', paint: { type: 'none' } },
  { name: 'White', paint: { type: 'color', color: cmyk(0, 0, 0, 0) } },
  { name: 'Black', paint: { type: 'color', color: cmyk(0, 0, 0, 100) } },
  ...(
    [
      [0, 100, 100, 0], [0, 0, 100, 0], [100, 0, 100, 0], [100, 0, 0, 0], [100, 100, 0, 0], [0, 100, 0, 0], [15, 100, 90, 10], [0, 90, 85, 0],
      [0, 80, 95, 0], [0, 50, 100, 0], [0, 35, 85, 0], [5, 0, 90, 0], [20, 0, 100, 0], [50, 0, 100, 0], [75, 0, 100, 0], [85, 10, 100, 10],
      [90, 30, 95, 30], [75, 0, 75, 0], [80, 10, 45, 0], [70, 15, 0, 0], [85, 50, 0, 0], [100, 95, 5, 0], [100, 100, 25, 25], [75, 100, 0, 0],
      [50, 100, 0, 0], [35, 100, 35, 10], [10, 100, 50, 0], [0, 95, 20, 0], [25, 25, 40, 0], [40, 45, 50, 5], [50, 50, 60, 25], [55, 60, 65, 40],
      [25, 40, 65, 0], [30, 50, 75, 10], [35, 60, 80, 25], [40, 65, 90, 35], [40, 70, 100, 50], [50, 70, 80, 70],
    ] as [number, number, number, number][]
  ).map(([c, m, y, k]) => ({ name: `C=${c} M=${m} Y=${y} K=${k}`, paint: { type: 'color', color: cmyk(c, m, y, k) } as Paint })),
  ...[100, 90, 80, 70, 60, 50, 40, 30, 20, 10].map((k) => ({ name: `C=0 M=0 Y=0 K=${k}`, paint: { type: 'color', color: cmyk(0, 0, 0, k) } as Paint })),
];

const stop = (t: number, c: Color): GradStop => ({ t, color: c, opacity: 1 });

export const GRADIENT_SWATCHES: { name: string; type: Gradient['type']; stops: GradStop[] }[] = [
  { name: 'White, Black', type: 'linear', stops: [stop(0, rgb(255, 255, 255)), stop(1, rgb(0, 0, 0))] },
  { name: 'White, Black Radial', type: 'radial', stops: [stop(0, rgb(255, 255, 255)), stop(1, rgb(0, 0, 0))] },
  { name: 'Orange, Yellow', type: 'linear', stops: [stop(0, rgb(241, 90, 36)), stop(1, rgb(251, 176, 59))] },
  { name: 'Blue, Teal', type: 'linear', stops: [stop(0, rgb(46, 49, 146)), stop(1, rgb(0, 169, 157))] },
  { name: 'Purple, Pink', type: 'linear', stops: [stop(0, rgb(102, 45, 145)), stop(1, rgb(237, 30, 121))] },
  { name: 'Green, Yellow', type: 'linear', stops: [stop(0, rgb(0, 146, 69)), stop(1, rgb(252, 238, 33))] },
];

/** A gradient laid across a box the way Illustrator first lays one: left to right through the middle, or round its center. */
export function fitGradient(type: Gradient['type'], stops: GradStop[], b: Rect, angle = 0): Gradient {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (type === 'radial') {
    const r = Math.max(b.w, b.h) / 2 || 1;
    return { type, stops, matrix: [r, 0, 0, r, cx, cy] };
  }
  const a = (angle * Math.PI) / 180;
  const half = (Math.abs(b.w * Math.cos(a)) + Math.abs(b.h * Math.sin(a))) / 2 || 1;
  const dx = Math.cos(a) * half * 2;
  const dy = -Math.sin(a) * half * 2;
  return { type, stops, matrix: [dx, dy, -dy, dx, cx - dx / 2, cy - dy / 2] };
}

/** A linear gradient from p0 to p1 (the Gradient tool's drag). */
export function gradientBetween(g: Gradient, p0: { x: number; y: number }, p1: { x: number; y: number }): Gradient {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if (g.type === 'radial') {
    const r = Math.hypot(dx, dy) || 1;
    const a = Math.atan2(dy, dx);
    const m: Mat = [r * Math.cos(a), r * Math.sin(a), -r * Math.sin(a), r * Math.cos(a), p0.x, p0.y];
    return { ...g, matrix: m };
  }
  return { ...g, matrix: [dx, dy, -dy, dx, p0.x, p0.y] };
}

/** Angle of a gradient in degrees, counterclockwise as Illustrator's Gradient panel shows it. */
export function gradientAngle(g: Gradient): number {
  return Math.round((Math.atan2(-g.matrix[1], g.matrix[0]) * 180) / Math.PI * 10) / 10;
}

export function setGradientAngle(g: Gradient, deg: number): Gradient {
  const m = g.matrix;
  const len = Math.hypot(m[0], m[1]);
  const cx = m[4] + m[0] / 2;
  const cy = m[5] + m[1] / 2;
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a) * len;
  const dy = -Math.sin(a) * len;
  if (g.type === 'radial') return { ...g, matrix: [dx, dy, -dy, dx, m[4], m[5]] };
  return { ...g, matrix: [dx, dy, -dy, dx, cx - dx / 2, cy - dy / 2] };
}

/** Color at a point along a gradient's stops (for new stops). */
export function colorAt(stops: GradStop[], t: number): Color {
  const s = [...stops].sort((a, b) => a.t - b.t);
  if (t <= s[0].t) return s[0].color;
  for (let i = 0; i + 1 < s.length; i++) {
    if (t <= s[i + 1].t) {
      const k = (t - s[i].t) / (s[i + 1].t - s[i].t || 1);
      const a = s[i].color;
      const b = s[i + 1].color;
      if (a.space === b.space) return { space: a.space, c: a.c.map((v, j) => v + (b.c[j] - v) * k) };
      return a;
    }
  }
  return s[s.length - 1].color;
}

export function rgbToCmyk(col: Color): Color {
  const [r, g, b] = toRgb(col);
  const k = 1 - Math.max(r, g, b);
  const d = 1 - k || 1;
  const c01 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return { space: 'cmyk', c: [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k].map(c01) };
}
