import { all, docVersion, kids, num, partRoot } from './idml';

/**
 * Swatches from Resources/Graphic.xml: process and spot colors in CMYK, RGB
 * or Lab, tints of them, gradients, None, Paper and Registration. Screen
 * colors come from an approximation of InDesign's default CMYK profile
 * (U.S. Web Coated SWOP), so process colors look as muted as they do there.
 */

export type RGB = [number, number, number];

export interface GradientStop {
  rgb: RGB;
  /** 0-100 */
  location: number;
  midpoint: number;
}

export interface Swatch {
  self: string;
  name: string;
  kind: 'none' | 'paper' | 'registration' | 'color' | 'tint' | 'gradient' | 'mixed';
  rgb: RGB;
  /** Process or Spot. */
  model: string;
  space: string;
  values: number[];
  /** Tints: the color they're of, and how much. */
  base?: string;
  tint?: number;
  gradient?: { type: 'Linear' | 'Radial'; stops: GradientStop[] };
  visible: boolean;
  editable: boolean;
}

/** Trilinear blend of the SWOP primaries and their overprints, then black on top. */
const CORNERS: Record<string, RGB> = {
  w: [255, 255, 255],
  c: [0, 174, 239],
  m: [236, 0, 140],
  y: [255, 242, 0],
  cm: [46, 49, 146],
  cy: [0, 166, 81],
  my: [237, 28, 36],
  cmy: [54, 47, 48],
};
const K: RGB = [35, 31, 32];

export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const C = Math.min(1, Math.max(0, c / 100));
  const M = Math.min(1, Math.max(0, m / 100));
  const Y = Math.min(1, Math.max(0, y / 100));
  const Kk = Math.min(1, Math.max(0, k / 100));
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v =
      CORNERS.w[i] * (1 - C) * (1 - M) * (1 - Y) +
      CORNERS.c[i] * C * (1 - M) * (1 - Y) +
      CORNERS.m[i] * (1 - C) * M * (1 - Y) +
      CORNERS.y[i] * (1 - C) * (1 - M) * Y +
      CORNERS.cm[i] * C * M * (1 - Y) +
      CORNERS.cy[i] * C * (1 - M) * Y +
      CORNERS.my[i] * (1 - C) * M * Y +
      CORNERS.cmy[i] * C * M * Y;
    out[i] = Math.round(v * (1 - Kk + (Kk * K[i]) / 255));
  }
  return out;
}

/** The inverse, near enough for the Color panel's CMYK sliders. */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k0 = 1 - Math.max(r, g, b) / 255;
  const c0 = k0 >= 1 ? 0 : (1 - r / 255 - k0) / (1 - k0);
  const m0 = k0 >= 1 ? 0 : (1 - g / 255 - k0) / (1 - k0);
  const y0 = k0 >= 1 ? 0 : (1 - b / 255 - k0) / (1 - k0);
  let best: [number, number, number, number] = [c0 * 100, m0 * 100, y0 * 100, k0 * 100];
  // A few rounds of refinement against the forward conversion.
  for (let round = 0; round < 24; round++) {
    const f = cmykToRgb(...best);
    const err = [r - f[0], g - f[1], b - f[2]];
    if (Math.abs(err[0]) + Math.abs(err[1]) + Math.abs(err[2]) < 3) break;
    best = [
      Math.min(100, Math.max(0, best[0] - err[0] * 0.25)),
      Math.min(100, Math.max(0, best[1] - err[1] * 0.25)),
      Math.min(100, Math.max(0, best[2] - err[2] * 0.25)),
      best[3],
    ];
  }
  return best.map((v) => Math.round(v)) as [number, number, number, number];
}

export function labToRgb(L: number, a: number, b: number): RGB {
  // Lab (D50) to XYZ, Bradford to D65, then sRGB.
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.9642 * f(fx);
  const Y = f(fy);
  const Z = 0.8251 * f(fz);
  const x = 0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z;
  const y = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z;
  const z = 0.0122982 * X - 0.020483 * Y + 1.3299098 * Z;
  const lin = [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  }) as RGB;
}

export function colorRgb(space: string, values: number[]): RGB {
  if (space === 'RGB') return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0].map((v) => Math.round(Math.min(255, Math.max(0, v)))) as RGB;
  if (space === 'LAB') return labToRgb(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
  return cmykToRgb(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0);
}

export const tintRgb = (rgb: RGB, tint: number): RGB => {
  const t = tint < 0 || tint > 100 ? 1 : tint / 100;
  return rgb.map((v) => Math.round(255 - (255 - v) * t)) as RGB;
};

export const css = (rgb: RGB, alpha = 1) => (alpha >= 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
export const hex = (rgb: RGB) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const fromHex = (h: string): RGB => {
  const m = h.replace('#', '');
  return [parseInt(m.slice(0, 2), 16) || 0, parseInt(m.slice(2, 4), 16) || 0, parseInt(m.slice(4, 6), 16) || 0];
};

const values = (s: string | null) => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);

const NONE: Swatch = { self: 'Swatch/None', name: 'None', kind: 'none', rgb: [255, 255, 255], model: '', space: '', values: [], visible: true, editable: false };

export interface Swatches {
  bySelf: Map<string, Swatch>;
  /** As the Swatches panel lists them. */
  list: Swatch[];
}

const CACHE = new WeakMap<XMLDocument, { version: number; swatches: Swatches }>();

export function readSwatches(graphic: XMLDocument | undefined): Swatches {
  if (!graphic) return fallbackSwatches();
  const hit = CACHE.get(graphic);
  if (hit && hit.version === docVersion(graphic)) return hit.swatches;
  const root = partRoot(graphic) ?? graphic.documentElement;
  const bySelf = new Map<string, Swatch>();
  bySelf.set(NONE.self, NONE);
  for (const c of all(root, 'Color')) {
    const self = c.getAttribute('Self') ?? '';
    const space = c.getAttribute('Space') ?? 'CMYK';
    const vals = values(c.getAttribute('ColorValue'));
    const name = c.getAttribute('Name') ?? self.replace(/^Color\//, '');
    const isPaper = self === 'Color/Paper';
    const isReg = self === 'Color/Registration';
    bySelf.set(self, {
      self,
      name: isPaper ? 'Paper' : isReg ? 'Registration' : name,
      kind: isPaper ? 'paper' : isReg ? 'registration' : 'color',
      rgb: isPaper ? [255, 255, 255] : isReg ? [0, 0, 0] : colorRgb(space, vals),
      model: c.getAttribute('Model') ?? 'Process',
      space,
      values: vals,
      visible: c.getAttribute('Visible') !== 'false',
      editable: c.getAttribute('ColorEditable') !== 'false',
    });
  }
  for (const t of all(root, 'Tint')) {
    const self = t.getAttribute('Self') ?? '';
    const base = t.getAttribute('BaseColor') ?? '';
    const tint = num(t.getAttribute('TintValue'), 100);
    const b = bySelf.get(base);
    bySelf.set(self, {
      self,
      name: `${b?.name ?? base} ${Math.round(tint)}%`,
      kind: 'tint',
      rgb: tintRgb(b?.rgb ?? [0, 0, 0], tint),
      model: b?.model ?? 'Process',
      space: b?.space ?? 'CMYK',
      values: b?.values ?? [],
      base,
      tint,
      visible: true,
      editable: true,
    });
  }
  for (const g of all(root, 'Gradient')) {
    const self = g.getAttribute('Self') ?? '';
    const stops: GradientStop[] = kids(g, 'GradientStop').map((s) => {
      const sw = bySelf.get(s.getAttribute('StopColor') ?? '');
      return { rgb: sw?.rgb ?? [0, 0, 0], location: num(s.getAttribute('Location')), midpoint: num(s.getAttribute('Midpoint'), 50) };
    });
    bySelf.set(self, {
      self,
      name: g.getAttribute('Name') ?? self,
      kind: 'gradient',
      rgb: stops[0]?.rgb ?? [0, 0, 0],
      model: '',
      space: '',
      values: [],
      gradient: { type: g.getAttribute('Type') === 'Radial' ? 'Radial' : 'Linear', stops },
      visible: g.getAttribute('Visible') !== 'false',
      editable: true,
    });
  }
  for (const m of all(root, 'MixedInk')) {
    const self = m.getAttribute('Self') ?? '';
    bySelf.set(self, { self, name: m.getAttribute('Name') ?? self, kind: 'mixed', rgb: [128, 128, 128], model: '', space: '', values: [], visible: true, editable: false });
  }
  // The panel's order: None, Registration, Paper, Black, then the document's own.
  const list: Swatch[] = [NONE];
  for (const s of ['Color/Registration', 'Color/Paper', 'Color/Black']) {
    const sw = bySelf.get(s);
    if (sw) list.push(sw);
  }
  const listed = new Set(list.map((s) => s.self));
  for (const sw of bySelf.values()) {
    if (listed.has(sw.self) || !sw.visible || sw.kind === 'mixed') continue;
    if (sw.kind === 'color' && /^Color\/(Cyan|Magenta|Yellow)$/.test(sw.self) && !sw.editable) continue;
    list.push(sw);
  }
  const out = { bySelf, list };
  CACHE.set(graphic, { version: docVersion(graphic), swatches: out });
  return out;
}

function fallbackSwatches(): Swatches {
  const black: Swatch = { self: 'Color/Black', name: 'Black', kind: 'color', rgb: K, model: 'Process', space: 'CMYK', values: [0, 0, 0, 100], visible: true, editable: false };
  const paper: Swatch = { self: 'Color/Paper', name: 'Paper', kind: 'paper', rgb: [255, 255, 255], model: 'Process', space: 'CMYK', values: [0, 0, 0, 0], visible: true, editable: true };
  const bySelf = new Map([NONE, black, paper].map((s) => [s.self, s]));
  return { bySelf, list: [NONE, paper, black] };
}

/** A screen color for a swatch reference and tint; null for None. */
export function resolveColor(sw: Swatches, ref: string | null | undefined, tint = -1): RGB | null {
  if (!ref || ref === 'Swatch/None' || ref === 'n') return null;
  const s = sw.bySelf.get(ref) ?? (ref.startsWith('Color/') ? null : sw.bySelf.get(`Color/${ref}`));
  if (!s) return ref === 'Color/Black' ? K : null;
  if (s.kind === 'none') return null;
  return tint >= 0 && tint < 100 ? tintRgb(s.rgb, tint) : s.rgb;
}

/** A swatch's label in the panel: "C=0 M=0 Y=0 K=100"-style for unnamed colors. */
export function swatchLabel(s: Swatch): string {
  if (s.kind === 'none') return '[None]';
  if (s.kind === 'paper') return '[Paper]';
  if (s.kind === 'registration') return '[Registration]';
  if (s.self === 'Color/Black') return '[Black]';
  if (!s.name || /^u[0-9a-f]+$/.test(s.name)) {
    if (s.space === 'CMYK') return `C=${Math.round(s.values[0] ?? 0)} M=${Math.round(s.values[1] ?? 0)} Y=${Math.round(s.values[2] ?? 0)} K=${Math.round(s.values[3] ?? 0)}`;
    if (s.space === 'RGB') return `R=${Math.round(s.values[0] ?? 0)} G=${Math.round(s.values[1] ?? 0)} B=${Math.round(s.values[2] ?? 0)}`;
  }
  return s.name;
}

/** The Graphic part's root, for adding colors. */
export const graphicRoot = (doc: XMLDocument) => partRoot(doc) ?? doc.documentElement;
