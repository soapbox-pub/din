import { toCss, type Color } from '@/shared/pdf/color';
import { quad, toPath2D } from './geom';
import { invert, mul, type Doc, type GradStop, type Gradient, type Item, type Mat, type Paint, type PathItem, type Resources, type Stroke, type TextItem } from './model';
import { cssFont, embeddedFor, layoutText } from './text';

/**
 * Drawing documents on a canvas: artboards on the pasteboard, then each
 * layer's art bottom up, in Preview or Outline view as Illustrator's View
 * menu has them.
 */

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export interface DrawOptions {
  outline: boolean;
  /** Items to leave out (being dragged, drawn live elsewhere). */
  skip?: Set<number>;
  /** Show artboard edges and the pasteboard. */
  artboards: boolean;
  /** Transparent artboards (View > Show Transparency Grid). */
  grid?: boolean;
}

export const viewMat = (v: View, dpr = 1): Mat => [v.zoom * dpr, 0, 0, v.zoom * dpr, v.x * dpr, v.y * dpr];

const setM = (c: CanvasRenderingContext2D, m: Mat) => c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

function stopColor(s: GradStop): string {
  return toCss(s.color, s.opacity);
}

function addStops(g: CanvasGradient, stops: GradStop[]) {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    g.addColorStop(Math.min(1, Math.max(0, s.t)), stopColor(s));
    const next = sorted[i + 1];
    // A midpoint away from halfway: an extra stop where the colors are evenly mixed.
    if (next && s.mid !== undefined && Math.abs(s.mid - 0.5) > 0.01) {
      const t = s.t + (next.t - s.t) * s.mid;
      g.addColorStop(Math.min(1, Math.max(0, t)), mixCss(s, next));
    }
  }
}

function mixCss(a: GradStop, b: GradStop): string {
  const [ar, ag, ab] = rgb255(a.color);
  const [br, bg, bb] = rgb255(b.color);
  return `rgba(${(ar + br) / 2},${(ag + bg) / 2},${(ab + bb) / 2},${(a.opacity + b.opacity) / 2})`;
}

function rgb255(c: Color): number[] {
  const css = toCss(c);
  const v = parseInt(css.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** A canvas gradient in gradient space (set the context's transform to the gradient's matrix before using it). */
function canvasGradient(c: CanvasRenderingContext2D, g: Gradient): CanvasGradient {
  let cg: CanvasGradient;
  if (g.type === 'linear') cg = c.createLinearGradient(0, 0, 1, 0);
  else {
    const f = g.focal ?? { x: 0, y: 0, r: 0 };
    cg = c.createRadialGradient(f.x, f.y, Math.max(0, f.r), 0, 0, 1);
  }
  addStops(cg, g.stops);
  return cg;
}

/** Fill the current clip with a gradient. */
function fillGradient(c: CanvasRenderingContext2D, base: Mat, g: Gradient) {
  const m = mul(g.matrix, base);
  // A degenerate matrix draws its last color.
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) {
    c.fillStyle = stopColor(g.stops[g.stops.length - 1]);
    setM(c, [1, 0, 0, 1, 0, 0]);
    c.fillRect(-1e5, -1e5, 2e5, 2e5);
    return;
  }
  setM(c, m);
  c.fillStyle = canvasGradient(c, g);
  // Cover the clip in gradient space.
  const inv = invert(m);
  const corners = [
    [0, 0],
    [c.canvas.width, 0],
    [0, c.canvas.height],
    [c.canvas.width, c.canvas.height],
  ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  c.fillRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function strokeStyle(c: CanvasRenderingContext2D, s: Stroke, base: Mat): void {
  c.lineWidth = s.width;
  c.lineCap = (['butt', 'round', 'square'] as const)[s.cap];
  c.lineJoin = (['miter', 'round', 'bevel'] as const)[s.join];
  c.miterLimit = s.miter;
  c.setLineDash(s.dash.length && s.dash.some((d) => d > 0) ? s.dash : []);
  c.lineDashOffset = s.dashOffset;
  if (s.paint.type === 'color') c.strokeStyle = toCss(s.paint.color);
  else if (s.paint.type === 'gradient') {
    // Strokes take the gradient laid flat in document space.
    const g = s.paint.gradient;
    const m = g.matrix;
    let cg: CanvasGradient;
    if (g.type === 'linear') cg = c.createLinearGradient(m[4], m[5], m[0] + m[4], m[1] + m[5]);
    else cg = c.createRadialGradient(m[4], m[5], 0, m[4], m[5], Math.hypot(m[0], m[1]));
    addStops(cg, g.stops);
    c.strokeStyle = cg;
  }
  void base;
}

function drawPath(c: CanvasRenderingContext2D, it: PathItem, base: Mat, outline: boolean) {
  const p = toPath2D(it.paths);
  setM(c, base);
  if (outline) {
    c.strokeStyle = '#000';
    c.lineWidth = 1 / Math.sqrt(Math.abs(base[0] * base[3] - base[1] * base[2]));
    c.setLineDash([]);
    c.stroke(p);
    return;
  }
  const rule = it.evenOdd ? 'evenodd' : 'nonzero';
  if (it.fill.type === 'color') {
    c.fillStyle = toCss(it.fill.color);
    c.fill(p, rule);
  } else if (it.fill.type === 'gradient') {
    c.save();
    c.clip(p, rule);
    fillGradient(c, base, it.fill.gradient);
    c.restore();
    setM(c, base);
  }
  if (it.stroke.paint.type !== 'none' && it.stroke.width > 0) {
    strokeStyle(c, it.stroke, base);
    c.stroke(p);
  }
}

function paintFill(c: CanvasRenderingContext2D, paint: Paint): boolean {
  if (paint.type === 'color') {
    c.fillStyle = toCss(paint.color);
    return true;
  }
  if (paint.type === 'gradient') {
    c.fillStyle = toCss(paint.gradient.stops[0]?.color ?? { space: 'gray', c: [0] });
    return true;
  }
  return false;
}

function drawText(c: CanvasRenderingContext2D, t: TextItem, res: Resources, base: Mat, outline: boolean) {
  const layout = layoutText(t, res);
  const m = mul(t.matrix, base);
  const placedFont = t.placed && layout.lines[0]?.glyphs.every((g) => g.code !== undefined || g.ch === ' ') ? res.fonts.get(t.placed.font) : null;
  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (g.ch === ' ' || g.ch === '\n') continue;
      const run = t.runs[g.run];
      if (!run) continue;
      const font = placedFont ?? embeddedFor(res, run);
      const path = g.code !== undefined && font ? font.glyph(g.code) : null;
      const hs = t.placed && placedFont ? t.placed.hscale : run.hscale;
      const fill = outline ? ({ type: 'color', color: { space: 'gray', c: [0] } } as Paint) : run.fill;
      const stroke = outline ? null : run.stroke.paint.type !== 'none' ? run.stroke : null;
      if (path) {
        const k = run.size / 1000;
        setM(c, mul([k * hs, 0, 0, -k, g.x, line.y], m));
        if (paintFill(c, fill)) c.fill(path);
        if (stroke) {
          strokeStyle(c, { ...stroke, width: stroke.width / k }, base);
          c.stroke(path);
        }
      } else {
        setM(c, mul([hs, 0, 0, 1, g.x, line.y], m));
        c.font = cssFont(run);
        c.textBaseline = 'alphabetic';
        if (paintFill(c, fill)) c.fillText(g.ch, 0, 0);
        if (stroke) {
          strokeStyle(c, stroke, base);
          c.strokeText(g.ch, 0, 0);
        }
      }
    }
  }
}

function drawImage(c: CanvasRenderingContext2D, it: Item & { type: 'image' }, res: Resources, base: Mat, outline: boolean) {
  const img = res.images.get(it.image);
  const m = mul(it.matrix, base);
  if (outline || !img?.bitmap) {
    setM(c, base);
    const q = quad(it.matrix);
    c.beginPath();
    c.moveTo(q[0].x, q[0].y);
    for (const p of q.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.moveTo(q[0].x, q[0].y);
    c.lineTo(q[2].x, q[2].y);
    c.moveTo(q[1].x, q[1].y);
    c.lineTo(q[3].x, q[3].y);
    c.strokeStyle = outline ? '#000' : '#999';
    c.lineWidth = 1 / Math.sqrt(Math.abs(base[0] * base[3]));
    c.setLineDash([]);
    c.stroke();
    return;
  }
  setM(c, m);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(img.bitmap, 0, 0, 1, 1);
}

export function drawItem(c: CanvasRenderingContext2D, it: Item, res: Resources, base: Mat, opts: DrawOptions) {
  if (it.hidden || opts.skip?.has(it.id)) return;
  const isolated = !opts.outline && it.type === 'group' && (it.opacity < 1 || it.blend !== 'normal');
  if (isolated) {
    // Groups with opacity or blending composite as one.
    const layer = document.createElement('canvas');
    layer.width = c.canvas.width;
    layer.height = c.canvas.height;
    const lc = layer.getContext('2d')!;
    for (const ch of it.children) drawItem(lc, ch, res, base, opts);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha *= it.opacity;
    c.globalCompositeOperation = it.blend === 'normal' ? 'source-over' : it.blend;
    c.drawImage(layer, 0, 0);
    c.restore();
    return;
  }
  c.save();
  if (!opts.outline) {
    c.globalAlpha *= it.opacity;
    if (it.blend !== 'normal') c.globalCompositeOperation = it.blend;
  }
  if (it.type === 'path') drawPath(c, it, base, opts.outline);
  else if (it.type === 'text') drawText(c, it, res, base, opts.outline);
  else if (it.type === 'image') drawImage(c, it, res, base, opts.outline);
  else if (it.clip && it.children[0]?.type === 'path') {
    const clip = it.children[0];
    if (opts.outline) drawPath(c, clip, base, true);
    setM(c, base);
    c.clip(toPath2D(clip.paths), clip.evenOdd ? 'evenodd' : 'nonzero');
    for (const ch of it.children.slice(1)) drawItem(c, ch, res, base, opts);
  } else for (const ch of it.children) drawItem(c, ch, res, base, opts);
  c.restore();
}

export const PASTEBOARD = '#535353';

/** The whole document: pasteboard, artboards, art. */
export function drawDoc(c: CanvasRenderingContext2D, doc: Doc, view: View, dpr: number, opts: DrawOptions) {
  const base = viewMat(view, dpr);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = PASTEBOARD;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  if (opts.artboards) {
    for (const ab of doc.artboards) {
      setM(c, base);
      c.shadowColor = 'rgba(0,0,0,0.35)';
      c.shadowBlur = 6 * dpr;
      c.shadowOffsetY = 1 * dpr;
      c.fillStyle = '#ffffff';
      c.fillRect(ab.x, ab.y, ab.w, ab.h);
      c.shadowColor = 'transparent';
      if (opts.grid) {
        c.save();
        c.beginPath();
        c.rect(ab.x, ab.y, ab.w, ab.h);
        c.clip();
        const s = 8 / view.zoom;
        c.fillStyle = '#cccccc';
        for (let y = ab.y, r = 0; y < ab.y + ab.h; y += s, r++) for (let x = ab.x + ((r % 2) * s); x < ab.x + ab.w; x += 2 * s) c.fillRect(x, y, s, s);
        c.restore();
      }
    }
  }
  for (const layer of doc.layers) {
    if (layer.hidden) continue;
    for (const it of layer.children) drawItem(c, it, doc.res, base, opts);
  }
  if (opts.artboards) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.lineWidth = 1;
    c.strokeStyle = '#000000';
    c.setLineDash([]);
    for (const ab of doc.artboards) {
      const x = Math.round(ab.x * view.zoom * dpr + view.x * dpr) + 0.5;
      const y = Math.round(ab.y * view.zoom * dpr + view.y * dpr) + 0.5;
      c.strokeRect(x, y, Math.round(ab.w * view.zoom * dpr), Math.round(ab.h * view.zoom * dpr));
    }
  }
}

/** One artboard (or the art's bounds) drawn at a scale, for export. */
export function renderArea(doc: Doc, area: { x: number; y: number; w: number; h: number }, scale: number, background: string | null): HTMLCanvasElement {
  const w = Math.max(1, Math.round(area.w * scale));
  const h = Math.max(1, Math.round(area.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  if (background) {
    c.fillStyle = background;
    c.fillRect(0, 0, w, h);
  }
  const base: Mat = [scale, 0, 0, scale, -area.x * scale, -area.y * scale];
  for (const layer of doc.layers) {
    if (layer.hidden) continue;
    for (const it of layer.children) drawItem(c, it, doc.res, base, { outline: false, artboards: false });
  }
  return canvas;
}
