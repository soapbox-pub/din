import type { BlendMode, LayerEffectsInfo, UnitsValue } from 'ag-psd';
import { applyAdjustment, canRender, colorToRgb } from './adjust';
import { ctx2d, makeCanvas, type Doc, type Layer, type Mask } from './model';

/**
 * Compositing: draws a document's layers into one picture, the way
 * Photoshop would, within what a 2D canvas can do. Blend modes canvas lacks
 * fall back to their nearest relative; layer effects beyond shadows, glows,
 * strokes and color overlays are kept in the file but not drawn.
 */

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  'pass through': 'source-over',
  normal: 'source-over',
  dissolve: 'source-over',
  darken: 'darken',
  multiply: 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'multiply',
  'darker color': 'darken',
  lighten: 'lighten',
  screen: 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'lighter',
  'lighter color': 'lighten',
  overlay: 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'color-dodge',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  'hard mix': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: 'difference',
  divide: 'color-dodge',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'linear height': 'source-over',
  height: 'source-over',
  subtraction: 'difference',
};

export const compositeOp = (m: BlendMode): GlobalCompositeOperation => COMPOSITE[m] ?? 'source-over';

/** Photoshop's blend mode menu, in its groups. */
export const BLEND_GROUPS: BlendMode[][] = [
  ['normal', 'dissolve'],
  ['darken', 'multiply', 'color burn', 'linear burn', 'darker color'],
  ['lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color'],
  ['overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix'],
  ['difference', 'exclusion', 'subtract', 'divide'],
  ['hue', 'saturation', 'color', 'luminosity'],
];

export function blendLabel(m: BlendMode): string {
  if (m === 'linear dodge') return 'Linear Dodge (Add)';
  return m.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Scratch canvases, reused between frames so painting doesn't churn memory.
const pool: HTMLCanvasElement[] = [];
function acquire(w: number, h: number): HTMLCanvasElement {
  const c = pool.pop() ?? makeCanvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else {
    const x = ctx2d(c);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, w, h);
  }
  return c;
}
function release(c: HTMLCanvasElement) {
  if (pool.length < 8) pool.push(c);
}

/**
 * Masks as alpha, by mask canvas. Committed canvases never change, so the
 * cache holds; one being painted right now is passed as `live` to skip it.
 */
const maskAlpha = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

function alphaOf(mask: Mask, live: boolean): HTMLCanvasElement {
  const cached = live ? undefined : maskAlpha.get(mask.canvas);
  if (cached) return cached;
  const { width: w, height: h } = mask.canvas;
  const out = makeCanvas(w, h);
  const src = mask.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i];
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  ctx2d(out).putImageData(src, 0, 0);
  if (!live) maskAlpha.set(mask.canvas, out);
  return out;
}

/** Cut a doc-sized canvas down to what a mask shows. */
function applyMask(c: CanvasRenderingContext2D, mask: Mask, w: number, h: number, live: boolean) {
  c.globalCompositeOperation = 'destination-in';
  c.globalAlpha = 1;
  if (mask.defaultColor === 0) {
    c.drawImage(alphaOf(mask, live), mask.left, mask.top);
  } else {
    // Outside the mask's own canvas everything shows: punch only its area.
    const tmp = acquire(w, h);
    const t = ctx2d(tmp);
    t.fillStyle = '#fff';
    t.fillRect(0, 0, w, h);
    t.clearRect(mask.left, mask.top, mask.canvas.width, mask.canvas.height);
    t.drawImage(alphaOf(mask, live), mask.left, mask.top);
    c.drawImage(tmp, 0, 0);
    release(tmp);
  }
  c.globalCompositeOperation = 'source-over';
}

const px = (u: UnitsValue | undefined, fallback: number) => (u ? u.value : fallback);
const rgba = (c: Parameters<typeof colorToRgb>[0], a: number, fallback: [number, number, number] = [0, 0, 0]) => {
  const [r, g, b] = colorToRgb(c, fallback);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
};

/** A silhouette of `src` in one color, grown by `radius` pixels. */
function grown(src: HTMLCanvasElement, radius: number, color: string, w: number, h: number): HTMLCanvasElement {
  const out = acquire(w, h);
  const c = ctx2d(out);
  const r = Math.max(0, radius);
  c.drawImage(src, 0, 0);
  if (r >= 0.5) {
    const rings = Math.ceil(r);
    for (let ring = 1; ring <= rings; ring++) {
      const rr = Math.min(r, ring);
      const steps = Math.max(8, Math.ceil(rr * 4));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        c.drawImage(src, Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
  }
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Draw a layer's effects around its picture (`img`, doc-sized) into `out`.
 * Effects under the layer go first, then the layer at its fill opacity,
 * then effects over it.
 */
function drawWithEffects(out: CanvasRenderingContext2D, img: HTMLCanvasElement, fx: LayerEffectsInfo, fill: number, w: number, h: number) {
  const scale = fx.scale ?? 1;
  for (const s of fx.dropShadow ?? []) {
    if (s.enabled === false) continue;
    const angle = ((s.angle ?? 120) * Math.PI) / 180;
    const dist = px(s.distance, 5) * scale;
    out.save();
    out.globalCompositeOperation = compositeOp(s.blendMode ?? 'multiply');
    out.shadowColor = rgba(s.color, s.opacity ?? 0.75);
    out.shadowBlur = px(s.size, 5) * scale;
    // Draw the layer far off the canvas so only its shadow lands.
    out.shadowOffsetX = -Math.cos(angle) * dist + w * 4;
    out.shadowOffsetY = Math.sin(angle) * dist;
    out.drawImage(img, -w * 4, 0);
    out.restore();
  }
  const glow = fx.outerGlow;
  if (glow && glow.enabled !== false) {
    out.save();
    out.globalCompositeOperation = compositeOp(glow.blendMode ?? 'screen');
    out.shadowColor = rgba(glow.color, glow.opacity ?? 0.75, [255, 255, 190]);
    out.shadowBlur = px(glow.size, 5) * scale;
    out.shadowOffsetX = w * 4;
    out.drawImage(img, -w * 4, 0);
    out.restore();
  }
  for (const s of fx.stroke ?? []) {
    if (s.enabled === false || (s.fillType && s.fillType !== 'color')) continue;
    if (s.position === 'inside') continue;
    const size = px(s.size, 3) * scale;
    const ring = grown(img, s.position === 'center' ? size / 2 : size, rgba(s.color, 1, [255, 0, 0]), w, h);
    out.save();
    out.globalAlpha = s.opacity ?? 1;
    out.globalCompositeOperation = compositeOp(s.blendMode ?? 'normal');
    out.drawImage(ring, 0, 0);
    out.restore();
    release(ring);
  }

  // The layer itself, then what paints over it, clipped to its pixels.
  const body = acquire(w, h);
  const b = ctx2d(body);
  b.drawImage(img, 0, 0);
  for (const f of fx.solidFill ?? []) {
    if (f.enabled === false) continue;
    b.globalCompositeOperation = 'source-atop';
    b.globalAlpha = f.opacity ?? 1;
    b.fillStyle = rgba(f.color, 1, [255, 0, 0]);
    b.fillRect(0, 0, w, h);
  }
  for (const s of fx.stroke ?? []) {
    if (s.enabled === false || s.position !== 'inside' || (s.fillType && s.fillType !== 'color')) continue;
    // Inside: the layer's pixels minus a shrunk copy of them.
    const size = px(s.size, 3) * scale;
    const hole = acquire(w, h);
    const hc = ctx2d(hole);
    hc.fillStyle = '#000';
    hc.fillRect(0, 0, w, h);
    hc.globalCompositeOperation = 'destination-out';
    hc.drawImage(img, 0, 0);
    const edge = grown(hole, size, rgba(s.color, 1, [255, 0, 0]), w, h);
    b.globalCompositeOperation = 'source-atop';
    b.globalAlpha = s.opacity ?? 1;
    b.drawImage(edge, 0, 0);
    release(edge);
    release(hole);
  }
  out.globalAlpha = fill;
  out.drawImage(body, 0, 0);
  out.globalAlpha = 1;
  release(body);
}

const hasDrawnEffects = (fx: LayerEffectsInfo | null): fx is LayerEffectsInfo =>
  !!fx &&
  !fx.disabled &&
  !!(
    fx.dropShadow?.some((s) => s.enabled !== false) ||
    (fx.outerGlow && fx.outerGlow.enabled !== false) ||
    fx.stroke?.some((s) => s.enabled !== false) ||
    fx.solidFill?.some((s) => s.enabled !== false)
  );

export interface RenderOptions {
  /** Mask canvases being painted on right now, which mustn't be cached. */
  liveMasks?: Set<HTMLCanvasElement>;
}

/** A layer's own picture: pixels (or a group's flattened contents), mask and effects, doc-sized. */
function layerImage(layer: Layer, w: number, h: number, opts: RenderOptions): HTMLCanvasElement | null {
  let img: HTMLCanvasElement;
  if (layer.kind === 'group') {
    img = acquire(w, h);
    renderList(ctx2d(img), layer.children, w, h, opts);
  } else if (layer.canvas) {
    img = acquire(w, h);
    ctx2d(img).drawImage(layer.canvas, layer.left, layer.top);
  } else {
    return null;
  }
  const c = ctx2d(img);
  if (layer.mask && !layer.mask.disabled) applyMask(c, layer.mask, w, h, !!opts.liveMasks?.has(layer.mask.canvas));
  if (layer.vectorMask && !layer.vectorMask.disabled) applyMask(c, layer.vectorMask, w, h, false);
  if (layer.kind !== 'group' && (hasDrawnEffects(layer.effects) || layer.fill < 1)) {
    const out = acquire(w, h);
    if (hasDrawnEffects(layer.effects)) drawWithEffects(ctx2d(out), img, layer.effects, layer.fill, w, h);
    else {
      const o = ctx2d(out);
      o.globalAlpha = layer.fill;
      o.drawImage(img, 0, 0);
    }
    release(img);
    return out;
  }
  return img;
}

function drawAdjustment(ctx: CanvasRenderingContext2D, layer: Layer, w: number, h: number, opts: RenderOptions) {
  const adj = layer.adjustment;
  if (!adj || !canRender(adj) || layer.opacity <= 0) return;
  const below = ctx.getImageData(0, 0, w, h);
  applyAdjustment(adj, below.data);
  const tmp = acquire(w, h);
  const t = tmp.getContext('2d', { willReadFrequently: true })!;
  t.putImageData(below, 0, 0);
  if (layer.mask && !layer.mask.disabled) applyMask(t, layer.mask, w, h, !!opts.liveMasks?.has(layer.mask.canvas));
  ctx.save();
  // Only where there's something under it: adjustments don't fill transparency.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = layer.opacity;
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  release(tmp);
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, clipped: Layer[], w: number, h: number, opts: RenderOptions) {
  if (layer.kind === 'adjustment') {
    drawAdjustment(ctx, layer, w, h, opts);
    return;
  }
  // A plain pass-through group just draws its layers in place.
  if (
    layer.kind === 'group' &&
    layer.blendMode === 'pass through' &&
    layer.opacity >= 1 &&
    (!layer.mask || layer.mask.disabled) &&
    clipped.length === 0
  ) {
    renderList(ctx, layer.children, w, h, opts);
    return;
  }
  const img = layerImage(layer, w, h, opts);
  if (!img) return;
  if (clipped.length) {
    // Clipped layers draw onto the base, inside its pixels.
    const ic = ctx2d(img);
    for (const c of clipped) {
      if (c.hidden) continue;
      if (c.kind === 'adjustment') {
        drawAdjustment(ic, c, w, h, opts);
        continue;
      }
      const ci = layerImage(c, w, h, opts);
      if (!ci) continue;
      const cc = ctx2d(ci);
      cc.globalCompositeOperation = 'destination-in';
      cc.drawImage(img, 0, 0);
      ic.globalAlpha = c.opacity;
      ic.globalCompositeOperation = compositeOp(c.blendMode);
      ic.drawImage(ci, 0, 0);
      ic.globalAlpha = 1;
      ic.globalCompositeOperation = 'source-over';
      release(ci);
    }
  }
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = compositeOp(layer.blendMode);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  release(img);
}

function renderList(ctx: CanvasRenderingContext2D, layers: Layer[], w: number, h: number, opts: RenderOptions) {
  let i = 0;
  while (i < layers.length) {
    const base = layers[i];
    let j = i + 1;
    const clipped: Layer[] = [];
    while (j < layers.length && layers[j].clipping) clipped.push(layers[j++]);
    if (!base.hidden) drawLayer(ctx, base, clipped, w, h, opts);
    i = j;
  }
}

/** Composite a document into `target` (resized to the document). */
export function renderDoc(doc: Doc, target: HTMLCanvasElement, opts: RenderOptions = {}): void {
  if (target.width !== doc.width || target.height !== doc.height) {
    target.width = doc.width;
    target.height = doc.height;
  }
  const ctx = target.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, doc.width, doc.height);
  renderList(ctx, doc.layers, doc.width, doc.height, opts);
}

/** A fresh flattened copy of the document. */
export function flatten(doc: Doc): HTMLCanvasElement {
  const c = makeCanvas(doc.width, doc.height);
  renderDoc(doc, c);
  return c;
}

/** A single layer (group, effects and mask included) as it would draw, doc-sized. */
export function renderLayerAlone(layer: Layer, w: number, h: number): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  renderList(ctx2d(out), [{ ...layer, hidden: false, clipping: false }], w, h, {});
  return out;
}

/** A list of layers merged into one picture, doc-sized. */
export function renderLayers(layers: Layer[], w: number, h: number): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  renderList(ctx2d(out), layers, w, h, {});
  return out;
}
