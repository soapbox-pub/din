import type { AdjustmentLayer, Color, CurvesAdjustmentChannel, LevelsAdjustmentChannel } from 'ag-psd';
import { ctx2d, makeCanvas } from './model';

/**
 * Adjustments, as pixel functions: the same code renders adjustment layers
 * and applies Image > Adjustments. Each rewrites RGB in place and leaves
 * alpha alone.
 */

type Lut = Uint8ClampedArray;

const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);

function lut(fn: (v: number) => number): Lut {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(fn(i));
  return t;
}

const IDENTITY = lut((v) => v);

function applyLuts(d: Uint8ClampedArray, r: Lut, g: Lut, b: Lut) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

function compose(a: Lut, b: Lut): Lut {
  return lut((v) => b[a[v]]);
}

export function colorToRgb(c: Color | undefined, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!c) return fallback;
  if ('r' in c) return [c.r, c.g, c.b];
  if ('fr' in c) return [c.fr * 255, c.fg * 255, c.fb * 255];
  if ('h' in c) return hsvToRgb(c.h, c.s, c.b);
  if ('k' in c && !('c' in c)) return [255 - c.k * 2.55, 255 - c.k * 2.55, 255 - c.k * 2.55];
  if ('c' in c) {
    const k = c.k / 100;
    return [255 * (1 - c.c / 100) * (1 - k), 255 * (1 - c.m / 100) * (1 - k), 255 * (1 - c.y / 100) * (1 - k)];
  }
  return fallback;
}

/** h 0-360, s and v 0-1 (ag-psd's HSB uses that range). */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hh = h / 360;
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function levelsLut(ch: LevelsAdjustmentChannel | undefined): Lut {
  if (!ch) return IDENTITY;
  const { shadowInput: si, highlightInput: hi, shadowOutput: so, highlightOutput: ho, midtoneInput: gamma } = ch;
  const g = gamma > 0 ? gamma : 1;
  return lut((v) => {
    const t = clamp((v - si) / Math.max(1, hi - si), 0, 1);
    return so + Math.pow(t, 1 / g) * (ho - so);
  });
}

/** A smooth curve through the points (monotone cubic, as Photoshop's curves look). */
export function curveLut(points: CurvesAdjustmentChannel | undefined): Lut {
  if (!points || points.length < 2) return IDENTITY;
  const p = [...points].sort((a, b) => a.input - b.input);
  const n = p.length;
  const xs = p.map((q) => q.input);
  const ys = p.map((q) => q.output);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return lut((v) => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (v > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (v - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    );
  });
}

/** Run an adjustment over RGBA pixels. Ones Photo Editor can't draw leave them alone. */
export function applyAdjustment(adj: AdjustmentLayer, d: Uint8ClampedArray): void {
  switch (adj.type) {
    case 'brightness/contrast': {
      const b = adj.brightness ?? 0;
      const c = adj.contrast ?? 0;
      const mean = adj.meanValue ?? 127;
      const k = c >= 0 ? 1 + c / 33 : 1 + c / 100;
      // Photoshop's modern brightness bends midtones rather than shifting everything.
      const gamma = b >= 0 ? 1 + b / 100 : 1 / (1 - b / 100);
      const t = lut((v) => {
        const bright = 255 * Math.pow(v / 255, 1 / gamma);
        return mean + (bright - mean) * k;
      });
      applyLuts(d, t, t, t);
      return;
    }
    case 'levels': {
      const all = levelsLut(adj.rgb);
      applyLuts(d, compose(levelsLut(adj.red), all), compose(levelsLut(adj.green), all), compose(levelsLut(adj.blue), all));
      return;
    }
    case 'curves': {
      const all = curveLut(adj.rgb);
      applyLuts(d, compose(curveLut(adj.red), all), compose(curveLut(adj.green), all), compose(curveLut(adj.blue), all));
      return;
    }
    case 'exposure': {
      const e = Math.pow(2, adj.exposure ?? 0);
      const o = adj.offset ?? 0;
      const g = adj.gamma ?? 1;
      const t = lut((v) => 255 * Math.pow(clamp((v / 255) * e + o, 0, 1), 1 / g));
      applyLuts(d, t, t, t);
      return;
    }
    case 'invert': {
      const t = lut((v) => 255 - v);
      applyLuts(d, t, t, t);
      return;
    }
    case 'posterize': {
      const n = clamp(adj.levels ?? 4, 2, 255);
      const t = lut((v) => Math.round(Math.round((v / 255) * (n - 1)) * (255 / (n - 1))));
      applyLuts(d, t, t, t);
      return;
    }
    case 'threshold': {
      const level = adj.level ?? 128;
      for (let i = 0; i < d.length; i += 4) {
        const v = luma(d[i], d[i + 1], d[i + 2]) >= level ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return;
    }
    case 'hue/saturation': {
      const m = adj.master;
      if (!m) return;
      const dh = m.hue;
      const ds = m.saturation / 100;
      const dl = m.lightness / 100;
      for (let i = 0; i < d.length; i += 4) {
        const [h, s0, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        const s = clamp(ds >= 0 ? s0 + (1 - s0) * ds * s0 : s0 * (1 + ds), 0, 1);
        let [r, g, b] = hslToRgb(h + dh, s, l);
        if (dl > 0) {
          r += (255 - r) * dl;
          g += (255 - g) * dl;
          b += (255 - b) * dl;
        } else if (dl < 0) {
          r *= 1 + dl;
          g *= 1 + dl;
          b *= 1 + dl;
        }
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
      return;
    }
    case 'vibrance': {
      const vib = (adj.vibrance ?? 0) / 100;
      const sat = (adj.saturation ?? 0) / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const max = Math.max(r, g, b);
        const avg = (r + g + b) / 3;
        // Vibrance pushes dull colors more than vivid ones.
        const amt = sat + vib * (1 - (max - Math.min(r, g, b)) / 255);
        d[i] = avg + (r - avg) * (1 + amt);
        d[i + 1] = avg + (g - avg) * (1 + amt);
        d[i + 2] = avg + (b - avg) * (1 + amt);
      }
      return;
    }
    case 'color balance': {
      const s = adj.shadows;
      const m = adj.midtones;
      const h = adj.highlights;
      const ch = (k: 'cyanRed' | 'magentaGreen' | 'yellowBlue') =>
        lut((v) => {
          const t = v / 255;
          const ws = clamp(1 - t * 3.3, 0, 1) * 0.7 + 0.3 * (1 - t);
          const wm = 1 - Math.abs(t - 0.5) * 2;
          const wh = clamp((t - 0.7) * 3.3, 0, 1) * 0.7 + 0.3 * t;
          return v + ((s?.[k] ?? 0) * ws + (m?.[k] ?? 0) * wm + (h?.[k] ?? 0) * wh) * 0.7;
        });
      applyLuts(d, ch('cyanRed'), ch('magentaGreen'), ch('yellowBlue'));
      return;
    }
    case 'black & white': {
      // Photoshop's B&W weighs each hue band; interpolate between neighbors.
      const w = [adj.reds ?? 40, adj.yellows ?? 60, adj.greens ?? 40, adj.cyans ?? 60, adj.blues ?? 20, adj.magentas ?? 80];
      const tint = adj.useTint ? colorToRgb(adj.tintColor, [225, 211, 179]) : null;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const min = Math.min(r, g, b);
        const max = Math.max(r, g, b);
        const [h] = rgbToHsv(r, g, b);
        const pos = h / 60;
        const i0 = Math.floor(pos) % 6;
        const f = pos - Math.floor(pos);
        const weight = (w[i0] * (1 - f) + w[(i0 + 1) % 6] * f) / 100;
        let v = min + (max - min) * weight;
        v = clamp(v);
        if (tint) {
          const t = v / 255;
          d[i] = t < 0.5 ? 2 * t * tint[0] : 255 - 2 * (1 - t) * (255 - tint[0]);
          d[i + 1] = t < 0.5 ? 2 * t * tint[1] : 255 - 2 * (1 - t) * (255 - tint[1]);
          d[i + 2] = t < 0.5 ? 2 * t * tint[2] : 255 - 2 * (1 - t) * (255 - tint[2]);
        } else {
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
      return;
    }
    case 'photo filter': {
      const [fr, fg, fb] = colorToRgb(adj.color, [236, 138, 0]);
      const k = (adj.density ?? 25) / 100;
      const keep = adj.preserveLuminosity ?? true;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        let nr = r * (1 - k) + ((r * fr) / 255) * k * 2;
        let ng = g * (1 - k) + ((g * fg) / 255) * k * 2;
        let nb = b * (1 - k) + ((b * fb) / 255) * k * 2;
        if (keep) {
          const before = luma(r, g, b);
          const after = luma(nr, ng, nb) || 1;
          nr *= before / after;
          ng *= before / after;
          nb *= before / after;
        }
        d[i] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
      }
      return;
    }
    case 'channel mixer': {
      const mono = adj.monochrome;
      const mix = (c: typeof adj.red, r: number, g: number, b: number) =>
        c ? (c.red * r + c.green * g + c.blue * b) / 100 + c.constant * 2.55 : 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (mono) {
          d[i] = d[i + 1] = d[i + 2] = mix(adj.gray, r, g, b);
        } else {
          d[i] = adj.red ? mix(adj.red, r, g, b) : r;
          d[i + 1] = adj.green ? mix(adj.green, r, g, b) : g;
          d[i + 2] = adj.blue ? mix(adj.blue, r, g, b) : b;
        }
      }
      return;
    }
    case 'gradient map': {
      const stops = (adj.colorStops ?? []).map((s) => ({ at: s.location / 4096, rgb: colorToRgb(s.color) }));
      if (stops.length === 0) return;
      stops.sort((a, b) => a.at - b.at);
      const table: [number, number, number][] = [];
      for (let v = 0; v < 256; v++) {
        const t = adj.reverse ? 1 - v / 255 : v / 255;
        let j = 0;
        while (j < stops.length - 1 && stops[j + 1].at < t) j++;
        const a = stops[j];
        const b = stops[Math.min(j + 1, stops.length - 1)];
        const f = b.at > a.at ? clamp((t - a.at) / (b.at - a.at), 0, 1) : 0;
        table.push([a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f]);
      }
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = table[Math.round(luma(d[i], d[i + 1], d[i + 2]))];
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
      return;
    }
    default:
      return;
  }
}

/** Whether Photo Editor draws this kind of adjustment (others pass through untouched). */
export function canRender(adj: AdjustmentLayer): boolean {
  return adj.type !== 'selective color' && adj.type !== 'color lookup';
}

export const ADJUSTMENT_NAMES: Record<string, string> = {
  'brightness/contrast': 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  'hue/saturation': 'Hue/Saturation',
  'color balance': 'Color Balance',
  'black & white': 'Black & White',
  'photo filter': 'Photo Filter',
  'channel mixer': 'Channel Mixer',
  'color lookup': 'Color Lookup',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  'gradient map': 'Gradient Map',
  'selective color': 'Selective Color',
};

/** The adjustments Photo Editor offers, with Photoshop's starting values. */
export function defaultAdjustment(type: AdjustmentLayer['type']): AdjustmentLayer {
  const level = { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 };
  const hue = { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 };
  switch (type) {
    case 'brightness/contrast':
      return { type, brightness: 0, contrast: 0, meanValue: 127, useLegacy: false, labColorOnly: false, auto: false };
    case 'levels':
      return { type, rgb: level, red: { ...level }, green: { ...level }, blue: { ...level } };
    case 'curves':
      return { type, rgb: [{ input: 0, output: 0 }, { input: 255, output: 255 }] };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'hue/saturation':
      return { type, master: { ...hue }, reds: { ...hue, a: 315, b: 345, c: 15, d: 45 }, yellows: { ...hue, a: 15, b: 45, c: 75, d: 105 }, greens: { ...hue, a: 75, b: 105, c: 135, d: 165 }, cyans: { ...hue, a: 135, b: 165, c: 195, d: 225 }, blues: { ...hue, a: 195, b: 225, c: 255, d: 285 }, magentas: { ...hue, a: 255, b: 285, c: 315, d: 345 } };
    case 'color balance': {
      const zero = { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
      return { type, shadows: { ...zero }, midtones: { ...zero }, highlights: { ...zero }, preserveLuminosity: true };
    }
    case 'black & white':
      return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, useTint: false, tintColor: { r: 225, g: 211, b: 179 } };
    case 'photo filter':
      return { type, color: { r: 236, g: 138, b: 0 }, density: 25, preserveLuminosity: true };
    case 'invert':
      return { type };
    case 'posterize':
      return { type, levels: 4 };
    case 'threshold':
      return { type, level: 128 };
    case 'gradient map':
      return {
        type,
        gradientType: 'solid',
        name: 'Foreground to Background',
        colorStops: [
          { color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 50 },
          { color: { r: 255, g: 255, b: 255 }, location: 4096, midpoint: 50 },
        ],
        opacityStops: [
          { opacity: 1, location: 0, midpoint: 50 },
          { opacity: 1, location: 4096, midpoint: 50 },
        ],
      };
    default:
      return { type: 'invert' };
  }
}

export const MENU_ADJUSTMENTS: AdjustmentLayer['type'][] = [
  'brightness/contrast',
  'levels',
  'curves',
  'exposure',
  'vibrance',
  'hue/saturation',
  'color balance',
  'black & white',
  'photo filter',
  'invert',
  'posterize',
  'threshold',
  'gradient map',
];

// ---- Filters -----------------------------------------------------------------

export type FilterSpec =
  | { type: 'gaussian'; radius: number }
  | { type: 'unsharp'; amount: number; radius: number; threshold: number }
  | { type: 'noise'; amount: number; mono: boolean }
  | { type: 'mosaic'; size: number }
  | { type: 'motion'; angle: number; distance: number }
  | { type: 'sharpen' }
  | { type: 'emboss' }
  | { type: 'desaturate' };

export const FILTER_NAMES: Record<FilterSpec['type'], string> = {
  gaussian: 'Gaussian Blur',
  unsharp: 'Unsharp Mask',
  noise: 'Add Noise',
  mosaic: 'Mosaic',
  motion: 'Motion Blur',
  sharpen: 'Sharpen',
  emboss: 'Emboss',
  desaturate: 'Desaturate',
};

function blurred(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  // Pad with the edge pixels stretched outward, so an opaque picture's edges
  // blur against themselves rather than fading into transparency.
  const w = src.width;
  const h = src.height;
  const p = Math.ceil(radius * 1.5) + 1;
  const padded = makeCanvas(w + 2 * p, h + 2 * p);
  const pc = ctx2d(padded);
  pc.drawImage(src, p, p);
  pc.drawImage(src, 0, 0, w, 1, p, 0, w, p);
  pc.drawImage(src, 0, h - 1, w, 1, p, p + h, w, p);
  pc.drawImage(padded, p, 0, 1, h + 2 * p, 0, 0, p, h + 2 * p);
  pc.drawImage(padded, p + w - 1, 0, 1, h + 2 * p, p + w, 0, p, h + 2 * p);
  const out = makeCanvas(w, h);
  const c = ctx2d(out);
  c.filter = `blur(${radius / 2}px)`;
  c.drawImage(padded, -p, -p);
  return out;
}

/** Run a filter over a canvas; returns a new one the same size. */
export function applyFilter(src: HTMLCanvasElement, f: FilterSpec): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  if (f.type === 'gaussian') return f.radius > 0 ? blurred(src, f.radius * 2) : copy(src);
  if (f.type === 'motion') {
    const out = makeCanvas(w, h);
    const c = ctx2d(out);
    const steps = Math.max(2, Math.min(64, Math.round(f.distance)));
    const rad = (f.angle * Math.PI) / 180;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1) - 0.5;
      c.globalAlpha = 1 / (i + 1);
      c.drawImage(src, Math.cos(rad) * f.distance * t, -Math.sin(rad) * f.distance * t);
    }
    return out;
  }
  if (f.type === 'mosaic') {
    const s = Math.max(2, Math.round(f.size));
    const small = makeCanvas(Math.ceil(w / s), Math.ceil(h / s));
    const sc = ctx2d(small);
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(src, 0, 0, small.width, small.height);
    const out = makeCanvas(w, h);
    const c = ctx2d(out);
    c.imageSmoothingEnabled = false;
    c.drawImage(small, 0, 0, small.width * s, small.height * s);
    return out;
  }
  const out = copy(src);
  const oc = out.getContext('2d', { willReadFrequently: true })!;
  const img = oc.getImageData(0, 0, w, h);
  const d = img.data;
  if (f.type === 'noise') {
    const amt = (f.amount / 100) * 255;
    for (let i = 0; i < d.length; i += 4) {
      if (f.mono) {
        const n = (Math.random() - 0.5) * amt;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
      } else {
        d[i] += (Math.random() - 0.5) * amt;
        d[i + 1] += (Math.random() - 0.5) * amt;
        d[i + 2] += (Math.random() - 0.5) * amt;
      }
    }
  } else if (f.type === 'desaturate') {
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.max(d[i], d[i + 1], d[i + 2]) + Math.min(d[i], d[i + 1], d[i + 2])) / 2;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (f.type === 'unsharp' || f.type === 'sharpen') {
    const amount = f.type === 'unsharp' ? f.amount / 100 : 0.6;
    const radius = f.type === 'unsharp' ? f.radius : 1;
    const threshold = f.type === 'unsharp' ? f.threshold : 0;
    const b = blurred(src, radius * 2).getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const diff = d[i + k] - b[i + k];
        if (Math.abs(diff) >= threshold) d[i + k] = d[i + k] + diff * amount;
      }
    }
  } else if (f.type === 'emboss') {
    const s = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = ((Math.max(0, y - 1) * w + Math.max(0, x - 1)) * 4);
        const b = ((Math.min(h - 1, y + 1) * w + Math.min(w - 1, x + 1)) * 4);
        const v = 128 + (luma(s[b], s[b + 1], s[b + 2]) - luma(s[a], s[a + 1], s[a + 2])) * 2;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  oc.putImageData(img, 0, 0);
  return out;
}

function copy(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  ctx2d(out).drawImage(src, 0, 0);
  return out;
}

/** Apply an adjustment to a canvas destructively; returns a new canvas. */
export function adjustCanvas(src: HTMLCanvasElement, adj: AdjustmentLayer): HTMLCanvasElement {
  const out = copy(src);
  const c = out.getContext('2d', { willReadFrequently: true })!;
  const img = c.getImageData(0, 0, out.width, out.height);
  applyAdjustment(adj, img.data);
  c.putImageData(img, 0, 0);
  return out;
}
