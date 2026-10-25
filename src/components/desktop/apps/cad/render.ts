/**
 * Drawing to the canvas: the model space with its grid and UCS icon, and
 * the overlay on top of it (highlights, grips, previews, the selection
 * window, object snap markers and the crosshairs).
 */
import { colorRgb, hex } from './aci';
import { CAP, flattenPath, type Geom, type Ink, type Prim } from './prims';
import { DESCENT } from './text';
import type { Vec } from './model';

export interface View {
  /** World point at the canvas center. */
  cx: number;
  cy: number;
  /** Pixels per drawing unit. */
  scale: number;
}

export interface Size {
  w: number;
  h: number;
  dpr: number;
}

export const toScreen = (v: View, s: Size, p: Vec): Vec => ({ x: s.w / 2 + (p.x - v.cx) * v.scale, y: s.h / 2 - (p.y - v.cy) * v.scale });
export const toWorld = (v: View, s: Size, p: Vec): Vec => ({ x: v.cx + (p.x - s.w / 2) / v.scale, y: v.cy - (p.y - s.h / 2) / v.scale });

export interface Theme {
  dark: boolean;
  bg: string;
  gridMinor: string;
  gridMajor: string;
  axisX: string;
  axisY: string;
  /** What color 7 draws in. */
  fg: number;
}

export const DARK: Theme = { dark: true, bg: '#212830', gridMinor: 'rgba(255,255,255,0.045)', gridMajor: 'rgba(255,255,255,0.095)', axisX: 'rgba(214, 74, 74, 0.55)', axisY: 'rgba(84, 186, 104, 0.55)', fg: 0xffffff };
export const LIGHT: Theme = { dark: false, bg: '#ffffff', gridMinor: 'rgba(0,0,0,0.05)', gridMajor: 'rgba(0,0,0,0.11)', axisX: 'rgba(200, 40, 40, 0.5)', axisY: 'rgba(40, 150, 60, 0.5)', fg: 0x000000 };

const inkColor = (ink: Ink, t: Theme) => {
  const rgb = colorRgb(ink.color, t.dark);
  // Pure black or white against the same background shows up the other way.
  if (t.dark && rgb === 0x000000) return '#ffffff';
  if (!t.dark && rgb === 0xffffff) return '#000000';
  return hex(rgb);
};

export interface DrawOpts {
  lineweights: boolean;
  theme: Theme;
}

/** Pixels for a lineweight, as AutoCAD shows them with LWT on (at its default display scale). */
const lwPx = (lw: number, on: boolean) => {
  if (!on || lw <= 25 || lw === -3) return 1;
  return Math.max(1, Math.min(12, Math.round((lw / 100) * 3.78)));
};

function setView(ctx: CanvasRenderingContext2D, v: View, s: Size) {
  const k = v.scale * s.dpr;
  ctx.setTransform(k, 0, 0, -k, (s.w / 2 - v.cx * v.scale) * s.dpr, (s.h / 2 + v.cy * v.scale) * s.dpr);
}

function addPath(ctx: CanvasRenderingContext2D, p: Extract<Prim, { k: 'path' }>) {
  for (const op of p.ops) {
    if (op.o === 'M') ctx.moveTo(op.x, op.y);
    else if (op.o === 'L') ctx.lineTo(op.x, op.y);
    else ctx.arc(op.c.x, op.c.y, op.r, op.a0, op.a1, !op.ccw);
  }
  if (p.closed) ctx.closePath();
}

/**
 * Strokes and fills prims, batching runs of the same look into one path.
 * `override` draws everything in one color (highlights).
 */
export function drawPrims(
  ctx: CanvasRenderingContext2D,
  prims: Iterable<Prim>,
  v: View,
  s: Size,
  o: DrawOpts,
  override?: { color: string; width: number; dash?: number[]; alpha?: number },
) {
  let batchKey = '';
  let open = false;
  let dashPx: number[] = [];
  let strokeColor = '';
  let width = 1;
  const flush = () => {
    if (!open) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = width * s.dpr;
    ctx.setLineDash(dashPx);
    ctx.stroke();
    open = false;
    batchKey = '';
  };
  const begin = (key: string) => {
    if (key === batchKey && open) {
      setView(ctx, v, s);
      return;
    }
    flush();
    batchKey = key;
    open = true;
    ctx.beginPath();
    setView(ctx, v, s);
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of prims) {
    if (p.k === 'path' || p.k === 'segs') {
      const color = override?.color ?? inkColor(p.ink, o.theme);
      const w = override?.width ?? lwPx(p.ink.lw, o.lineweights);
      let dash: number[] = override?.dash ?? [];
      if (!override?.dash && p.k === 'path' && p.ink.dash) {
        const px = p.ink.dash.map((d) => d * v.scale * s.dpr);
        const total = px.reduce((a, b) => a + b, 0);
        // Too fine to see, or too coarse to matter: draw it solid.
        if (total > 3 * s.dpr && total < 1e5) dash = px.map((d) => Math.max(d, s.dpr * 0.75));
      }
      const key = `${color}|${w}|${dash.join(',')}`;
      begin(key);
      strokeColor = color;
      width = w;
      dashPx = dash;
      if (p.k === 'path') addPath(ctx, p);
      else {
        const a = p.pts;
        for (let i = 0; i + 3 < a.length; i += 4) {
          ctx.moveTo(a[i], a[i + 1]);
          ctx.lineTo(a[i + 2], a[i + 3]);
        }
      }
      continue;
    }
    if (p.k === 'fill') {
      flush();
      setView(ctx, v, s);
      ctx.beginPath();
      for (const l of p.loops) {
        l.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
      }
      ctx.globalAlpha = override?.alpha ?? p.ink.alpha ?? 1;
      ctx.fillStyle = override?.color ?? inkColor(p.ink, o.theme);
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
      continue;
    }
    if (p.k === 'dot') {
      flush();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const q = toScreen(v, s, p.p);
      ctx.fillStyle = override?.color ?? inkColor(p.ink, o.theme);
      ctx.fillRect((q.x - 1) * s.dpr, (q.y - 1) * s.dpr, 2 * s.dpr, 2 * s.dpr);
      continue;
    }
    if (p.k === 'text') {
      flush();
      drawText(ctx, p, v, s, override?.color ?? inkColor(p.ink, o.theme));
    }
  }
  flush();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setLineDash([]);
}

function drawText(ctx: CanvasRenderingContext2D, p: Extract<Prim, { k: 'text' }>, v: View, s: Size, color: string) {
  // Text space to device pixels.
  const m = p.m;
  const k = v.scale * s.dpr;
  const a = m.a * k;
  const b = -m.b * k;
  const c = m.c * k;
  const d = -m.d * k;
  const e = (s.w / 2 + (m.e - v.cx) * v.scale) * s.dpr;
  const f = (s.h / 2 - (m.f - v.cy) * v.scale) * s.dpr;
  const heightPx = Math.hypot(c, d);
  if (heightPx < 1.2) {
    // Too small to read: a faint bar where it is.
    if (heightPx < 0.05) return;
    ctx.setTransform(a, b, c, d, e, f);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    for (const l of p.layout.lines) ctx.fillRect(0, l.y - 0.7, l.width, 0.6);
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  // Draw at a font size near the real pixel size, so hinting and AA look right.
  const fs = Math.max(1, heightPx / CAP);
  const inv = 1 / fs;
  ctx.setTransform(a * inv, b * inv, c * inv, d * inv, e, f);
  ctx.textBaseline = 'alphabetic';
  for (const line of p.layout.lines) {
    for (const r of line.runs) {
      if (!r.text) continue;
      const size = (r.size / CAP) * fs;
      ctx.font = `${r.italic ? 'italic ' : ''}${r.bold ? 'bold ' : ''}${size}px ${r.family}`;
      if (r.color !== undefined) ctx.fillStyle = hex(colorRgb(r.color, true));
      const x = r.x * fs;
      const y = (line.y + (r.dy ?? 0)) * fs;
      ctx.fillText(r.text, x, y);
      if (r.underline || r.overline || r.strike) {
        ctx.lineWidth = Math.max(1, size * 0.05);
        ctx.beginPath();
        if (r.underline) {
          ctx.moveTo(x, y + size * 0.12);
          ctx.lineTo(x + r.width * fs, y + size * 0.12);
        }
        if (r.overline) {
          ctx.moveTo(x, y - size * CAP * 1.18);
          ctx.lineTo(x + r.width * fs, y - size * CAP * 1.18);
        }
        if (r.strike) {
          ctx.moveTo(x, y - size * CAP * 0.5);
          ctx.lineTo(x + r.width * fs, y - size * CAP * 0.5);
        }
        ctx.stroke();
      }
      if (r.color !== undefined) ctx.fillStyle = color;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  void DESCENT;
}

/** A grid spacing that keeps lines at least ~12px apart, in steps of the base spacing times 1, 2, 5, 10… */
export function gridStep(base: number, scale: number): number {
  let step = base;
  if (step * scale < 12) while (step * scale < 12) step *= step * scale < 6 ? 10 : 5;
  else while (step * scale > 120) step /= 5;
  return step;
}

export function drawGrid(ctx: CanvasRenderingContext2D, v: View, s: Size, t: Theme, base: number, major: number) {
  const step = gridStep(base, v.scale);
  const tl = toWorld(v, s, { x: 0, y: 0 });
  const br = toWorld(v, s, { x: s.w, y: s.h });
  const x0 = Math.floor(tl.x / step);
  const x1 = Math.ceil(br.x / step);
  const y0 = Math.floor(br.y / step);
  const y1 = Math.ceil(tl.y / step);
  if ((x1 - x0) * (y1 - y0) > 4e6) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = s.dpr;
  for (const pass of ['minor', 'major'] as const) {
    ctx.beginPath();
    ctx.strokeStyle = pass === 'minor' ? t.gridMinor : t.gridMajor;
    for (let i = x0; i <= x1; i++) {
      if ((i % major === 0) !== (pass === 'major')) continue;
      const x = Math.round(toScreen(v, s, { x: i * step, y: 0 }).x * s.dpr) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, s.h * s.dpr);
    }
    for (let j = y0; j <= y1; j++) {
      if ((j % major === 0) !== (pass === 'major')) continue;
      const y = Math.round(toScreen(v, s, { x: 0, y: j * step }).y * s.dpr) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(s.w * s.dpr, y);
    }
    ctx.stroke();
  }
  // The axes through the origin, tinted X red and Y green as AutoCAD does.
  const o = toScreen(v, s, { x: 0, y: 0 });
  ctx.lineWidth = s.dpr;
  if (o.y >= 0 && o.y <= s.h) {
    ctx.strokeStyle = t.axisX;
    ctx.beginPath();
    ctx.moveTo(Math.max(0, o.x) * s.dpr, Math.round(o.y * s.dpr) + 0.5);
    ctx.lineTo(s.w * s.dpr, Math.round(o.y * s.dpr) + 0.5);
    ctx.stroke();
  }
  if (o.x >= 0 && o.x <= s.w) {
    ctx.strokeStyle = t.axisY;
    ctx.beginPath();
    ctx.moveTo(Math.round(o.x * s.dpr) + 0.5, Math.min(s.h, o.y) * s.dpr);
    ctx.lineTo(Math.round(o.x * s.dpr) + 0.5, 0);
    ctx.stroke();
  }
}

/** The 2D UCS icon in the lower-left corner. */
export function drawUcsIcon(ctx: CanvasRenderingContext2D, s: Size, t: Theme) {
  const d = s.dpr;
  const x = 28 * d;
  const y = (s.h - 30) * d;
  const L = 38 * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 2 * d;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#d64a4a';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + L, y);
  ctx.stroke();
  ctx.fillStyle = '#d64a4a';
  ctx.beginPath();
  ctx.moveTo(x + L + 6 * d, y);
  ctx.lineTo(x + L - 2 * d, y - 4 * d);
  ctx.lineTo(x + L - 2 * d, y + 4 * d);
  ctx.fill();
  ctx.strokeStyle = '#54ba68';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - L);
  ctx.stroke();
  ctx.fillStyle = '#54ba68';
  ctx.beginPath();
  ctx.moveTo(x, y - L - 6 * d);
  ctx.lineTo(x - 4 * d, y - L + 2 * d);
  ctx.lineTo(x + 4 * d, y - L + 2 * d);
  ctx.fill();
  ctx.font = `600 ${11 * d}px "Inter Variable", sans-serif`;
  ctx.fillStyle = t.dark ? '#d0d6e0' : '#3a3f47';
  ctx.fillText('X', x + L + 9 * d, y + 4 * d);
  ctx.fillText('Y', x - 4 * d, y - L - 10 * d);
  ctx.fillStyle = t.dark ? '#d0d6e0' : '#3a3f47';
  ctx.fillRect(x - 3 * d, y - 3 * d, 6 * d, 6 * d);
}

// ---- Overlay -------------------------------------------------------------------------------

export type SnapKind = 'end' | 'mid' | 'cen' | 'qua' | 'int' | 'per' | 'tan' | 'nea' | 'nod' | 'ins' | 'app' | 'ext' | 'grid';

export function drawSnapMarker(ctx: CanvasRenderingContext2D, s: Size, p: Vec, kind: SnapKind, label: string) {
  const d = s.dpr;
  const x = p.x * d;
  const y = p.y * d;
  const r = 6 * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = '#3fa9f5';
  ctx.fillStyle = '#3fa9f5';
  ctx.lineWidth = 2 * d;
  ctx.setLineDash([]);
  ctx.beginPath();
  switch (kind) {
    case 'end':
      ctx.rect(x - r, y - r, 2 * r, 2 * r);
      break;
    case 'mid':
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.1, y + r * 0.75);
      ctx.lineTo(x - r * 1.1, y + r * 0.75);
      ctx.closePath();
      break;
    case 'cen':
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case 'qua':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case 'int':
    case 'app':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      if (kind === 'app') ctx.rect(x - r, y - r, 2 * r, 2 * r);
      break;
    case 'per':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + r);
      break;
    case 'tan':
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      ctx.moveTo(x - r, y - r * 0.8);
      ctx.lineTo(x + r, y - r * 0.8);
      break;
    case 'nea':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x + r, y + r);
      ctx.closePath();
      break;
    case 'nod':
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - r * 0.7, y - r * 0.7);
      ctx.lineTo(x + r * 0.7, y + r * 0.7);
      ctx.moveTo(x + r * 0.7, y - r * 0.7);
      ctx.lineTo(x - r * 0.7, y + r * 0.7);
      break;
    case 'ins':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x, y - r);
      ctx.lineTo(x, y);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case 'ext':
      ctx.arc(x - r * 0.6, y, d * 1.5, 0, Math.PI * 2);
      ctx.arc(x + r * 0.6, y, d * 1.5, 0, Math.PI * 2);
      break;
    case 'grid':
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      break;
  }
  ctx.stroke();
  if (label) tooltip(ctx, s, { x: p.x + 14, y: p.y + 22 }, label);
}

/** A small dark tooltip with its top-left at p (in CSS pixels). */
export function tooltip(ctx: CanvasRenderingContext2D, s: Size, p: Vec, text: string) {
  const d = s.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${11.5 * d}px "Inter Variable", sans-serif`;
  const w = ctx.measureText(text).width + 12 * d;
  const h = 20 * d;
  let x = p.x * d;
  let y = p.y * d;
  if (x + w > s.w * d) x = s.w * d - w - 2 * d;
  if (y + h > s.h * d) y = p.y * d - 44 * d;
  ctx.fillStyle = 'rgba(52, 58, 68, 0.96)';
  ctx.strokeStyle = 'rgba(160, 172, 190, 0.45)';
  ctx.lineWidth = d;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3 * d);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#eef2f7';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6 * d, y + h / 2 + 0.5 * d);
  ctx.textBaseline = 'alphabetic';
}

export function drawCrosshair(ctx: CanvasRenderingContext2D, s: Size, p: Vec, t: Theme, pickbox: boolean, size = 0.05) {
  const d = s.dpr;
  const x = Math.round(p.x * d) + 0.5;
  const y = Math.round(p.y * d) + 0.5;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = d;
  ctx.setLineDash([]);
  const L = Math.max(s.w, s.h) * size * d;
  const box = pickbox ? 5 * d : 0;
  ctx.strokeStyle = t.dark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.9)';
  ctx.beginPath();
  ctx.moveTo(x - L, y);
  ctx.lineTo(x - box, y);
  ctx.moveTo(x + box, y);
  ctx.lineTo(x + L, y);
  ctx.moveTo(x, y - L);
  ctx.lineTo(x, y - box);
  ctx.moveTo(x, y + box);
  ctx.lineTo(x, y + L);
  if (pickbox) ctx.rect(x - box, y - box, 2 * box, 2 * box);
  ctx.stroke();
}

export function drawGrip(ctx: CanvasRenderingContext2D, s: Size, p: Vec, state: 'cold' | 'hover' | 'hot') {
  const d = s.dpr;
  const r = 4.5 * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = state === 'hot' ? '#e8393b' : state === 'hover' ? '#ff7f9a' : '#2b8ef0';
  ctx.strokeStyle = 'rgba(10, 20, 35, 0.85)';
  ctx.lineWidth = d;
  ctx.beginPath();
  ctx.rect(Math.round(p.x * d - r) + 0.5, Math.round(p.y * d - r) + 0.5, Math.round(2 * r), Math.round(2 * r));
  ctx.fill();
  ctx.stroke();
}

export function drawSelectionWindow(ctx: CanvasRenderingContext2D, s: Size, a: Vec, b: Vec, crossing: boolean) {
  const d = s.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const x = Math.min(a.x, b.x) * d;
  const y = Math.min(a.y, b.y) * d;
  const w = Math.abs(a.x - b.x) * d;
  const h = Math.abs(a.y - b.y) * d;
  ctx.fillStyle = crossing ? 'rgba(68, 190, 92, 0.22)' : 'rgba(64, 128, 230, 0.22)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = crossing ? 'rgba(120, 230, 140, 0.95)' : 'rgba(120, 170, 255, 0.95)';
  ctx.lineWidth = d;
  ctx.setLineDash(crossing ? [5 * d, 4 * d] : []);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
}

/** The geometry's outline in screen space, for tracking lines and the like. */
export function screenLine(ctx: CanvasRenderingContext2D, s: Size, a: Vec, b: Vec, color: string, dash: number[] = []) {
  const d = s.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = d;
  ctx.setLineDash(dash.map((x) => x * d));
  ctx.beginPath();
  ctx.moveTo(a.x * d, a.y * d);
  ctx.lineTo(b.x * d, b.y * d);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function geomPrims(list: Iterable<Geom>): Iterable<Prim> {
  return (function* () {
    for (const g of list) yield* g.prims;
  })();
}

export { flattenPath };
