import { css, resolveColor, type RGB, type Swatches } from './colors';
import { caretX as caretXOf, lineAt, selectionRects, type Composition, type Line, type Look, type TableLayout } from './compose';
import { apply, mul, rectCorners, tracePath, type Mat, type PathSink, type Pt, type Rect } from './geom';
import type { ImageStore } from './images';
import { masterPageFor, masterToPage, type Item, type LayerInfo, type Model, type Page, type Spread } from './model';

/**
 * Drawing spreads onto the canvas: pages on the pasteboard, master items
 * under each page's own, then layers bottom to top; fills, strokes,
 * gradients, corners, opacity and blending, shadows, placed images clipped
 * to their frames, and composed text. Then, unless in Preview, what
 * InDesign draws over the work: margins, columns, bleed, guides, frame
 * edges, text threads, and the selection.
 */

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export const PASTEBOARD = '#535353';
export const PREVIEW_BG = '#535353';
const MARGIN = '#ff00ff';
const COLUMN = '#9c4fff';
const BLEED = '#ff3b3b';
const SELECT = '#4f99ff';

export interface TextSource {
  /** The composition for a story, as set on a given page (for page numbers). */
  comp(story: string, page: Page | null): Composition | null;
  /** Which frame of its thread an item is. */
  frameIndex(item: Item): number;
}

export interface SceneOptions {
  model: Model;
  spreads: Spread[];
  view: View;
  width: number;
  height: number;
  dpr: number;
  preview: boolean;
  showGuides: boolean;
  showFrameEdges: boolean;
  showThreads: boolean;
  images: ImageStore;
  text: TextSource;
  /** Items shown as they'd be mid-gesture. */
  overrides: Map<string, Item>;
  /** Items hidden mid-gesture (an image being moved inside its frame shows through the override). */
  partEls: (part: string) => XMLDocument | undefined;
}

export const BLENDS: Record<string, GlobalCompositeOperation> = {
  Multiply: 'multiply',
  Screen: 'screen',
  Overlay: 'overlay',
  SoftLight: 'soft-light',
  HardLight: 'hard-light',
  ColorDodge: 'color-dodge',
  ColorBurn: 'color-burn',
  Darken: 'darken',
  Lighten: 'lighten',
  Difference: 'difference',
  Exclusion: 'exclusion',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
};

/** Pasteboard to screen pixels for a spread. */
export function spreadToScreen(view: View, s: Spread): Mat {
  return [view.zoom, 0, 0, view.zoom, view.x, view.y + s.y * view.zoom];
}

export function drawScene(c: CanvasRenderingContext2D, o: SceneOptions) {
  const { view, width, height, dpr, model } = o;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = PASTEBOARD;
  c.fillRect(0, 0, width * dpr, height * dpr);
  const visibleLayers = model.layers.filter((l) => l.visible);
  const layerOrder = [...visibleLayers].reverse();
  for (const s of o.spreads) {
    const sm = spreadToScreen(view, s);
    const top = sm[5] + (s.bounds.y - 300) * view.zoom;
    const bottom = sm[5] + (s.bounds.y + s.bounds.h + 300) * view.zoom;
    if (bottom < 0 || top > height) continue;
    const base: Mat = mul([dpr, 0, 0, dpr, 0, 0], sm);
    drawSpread(c, o, s, base, layerOrder);
  }
  if (o.preview) {
    // Preview hides the pasteboard: only the pages (and their bleed) show.
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.rect(0, 0, width * dpr, height * dpr);
    for (const s of o.spreads) {
      const base = mul([dpr, 0, 0, dpr, 0, 0], spreadToScreen(view, s));
      for (const p of s.pages) {
        const r = rectCorners(p.bounds).map((q) => apply(base, q));
        c.moveTo(r[0].x, r[0].y);
        for (const q of r.slice(1)) c.lineTo(q.x, q.y);
        c.closePath();
      }
    }
    c.fillStyle = PREVIEW_BG;
    c.fill('evenodd');
    c.restore();
  }
}

function drawSpread(c: CanvasRenderingContext2D, o: SceneOptions, s: Spread, base: Mat, layers: LayerInfo[]) {
  // Pages: a shadow, then paper.
  for (const p of s.pages) {
    c.setTransform(...base);
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = 6 * o.dpr;
    c.shadowOffsetX = 2 * o.dpr;
    c.shadowOffsetY = 2 * o.dpr;
    c.fillStyle = '#ffffff';
    c.fillRect(p.bounds.x, p.bounds.y, p.bounds.w, p.bounds.h);
    c.restore();
  }
  // Master items, page by page, clipped to the page and its bleed.
  for (const p of s.pages) drawMasterOn(c, o, s, p, base, layers, 0);
  for (const layer of layers) {
    for (const it of s.items) {
      const item = o.overrides.get(it.self) ?? it;
      if (item.layer !== layer.self) continue;
      if (o.preview && item.nonprinting) continue;
      drawItem(c, o, item, mul(base, item.m), base, pageOfItem(s, item));
    }
  }
  if (!o.preview) drawGuides(c, o, s, base);
}

export function pageOfItem(s: Spread, it: Item): Page | null {
  if (s.pages.length === 1) return s.pages[0];
  const p = apply(it.m, { x: it.box.x + it.box.w / 2, y: it.box.y + it.box.h / 2 });
  let best: Page | null = null;
  let bd = Infinity;
  for (const pg of s.pages) {
    const b = pg.bounds;
    const d = Math.abs(p.x - (b.x + b.w / 2));
    if (d < bd) {
      bd = d;
      best = pg;
    }
  }
  return best;
}

function drawMasterOn(c: CanvasRenderingContext2D, o: SceneOptions, s: Spread, page: Page, base: Mat, layers: LayerInfo[], depth: number) {
  const { model } = o;
  if (!page.master || depth > 4 || !s.showMasterItems) return;
  const master = model.masters.find((m) => m.self === page.master);
  if (!master) return;
  const mp = masterPageFor(master, page);
  if (!mp) return;
  const t = masterToPage(page, mp);
  const b = model.prefs.bleed;
  c.save();
  c.setTransform(...base);
  c.beginPath();
  c.rect(page.bounds.x - b.inside, page.bounds.y - b.top, page.bounds.w + b.inside + b.outside, page.bounds.h + b.top + b.bottom);
  c.clip();
  // A master based on another master shows that one's items first.
  if (mp.master) {
    const parent = model.masters.find((m) => m.self === mp.master);
    if (parent) {
      const pmp = masterPageFor(parent, mp);
      if (pmp) {
        const t2 = mul(t, masterToPage(mp, pmp));
        drawMasterItems(c, o, parent, pmp, mul(base, t2), layers, page);
      }
    }
  }
  drawMasterItems(c, o, master, mp, mul(base, t), layers, page);
  c.restore();
}

function drawMasterItems(c: CanvasRenderingContext2D, o: SceneOptions, master: Spread, mp: Page, m: Mat, layers: LayerInfo[], docPage: Page) {
  for (const layer of layers) {
    for (const it of master.items) {
      if (it.layer !== layer.self) continue;
      if (docPage.overrides.has(it.self)) continue;
      if (o.preview && it.nonprinting) continue;
      // Each master item belongs to the master page under its middle.
      if (master.pages.length > 1) {
        const ctr = apply(it.m, { x: it.box.x + it.box.w / 2, y: it.box.y + it.box.h / 2 });
        let best = master.pages[0];
        let bd = Infinity;
        for (const pg of master.pages) {
          const d = Math.abs(ctr.x - (pg.bounds.x + pg.bounds.w / 2));
          if (d < bd) {
            bd = d;
            best = pg;
          }
        }
        if (best !== mp) continue;
      }
      drawItem(c, o, it, mul(m, it.m), m, docPage, true);
    }
  }
}

function paint(sw: Swatches, ref: string | null, tint: number): string | null {
  const rgb = resolveColor(sw, ref, tint);
  return rgb ? css(rgb) : null;
}

/** A gradient swatch's ramp as an item paints it, in the item's coordinates. */
export interface GradientSpec {
  type: 'Linear' | 'Radial';
  /** Linear: from (x0, y0) to (x1, y1). Radial: centered on (x0, y0), radius r. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  /** Offsets 0-1, midpoints included as stops of their own. */
  stops: { at: number; rgb: RGB }[];
}

/** The gradient an item paints with a swatch; null when the swatch isn't a gradient. */
export function gradientSpec(sw: Swatches, it: Item, ref: string | null): GradientSpec | null {
  const s = ref ? sw.bySelf.get(ref) : null;
  if (!s || s.kind !== 'gradient' || !s.gradient) return null;
  const b = it.box;
  let x0: number;
  let y0: number;
  let x1 = 0;
  let y1 = 0;
  let r = 0;
  if (s.gradient.type === 'Radial') {
    x0 = it.gradFill ? it.gradFill.start.x : b.x + b.w / 2;
    y0 = it.gradFill ? it.gradFill.start.y : b.y + b.h / 2;
    r = Math.max(0.1, it.gradFill ? it.gradFill.length : Math.hypot(b.w, b.h) / 2);
  } else if (it.gradFill) {
    const a = (-it.gradFill.angle * Math.PI) / 180;
    x0 = it.gradFill.start.x;
    y0 = it.gradFill.start.y;
    x1 = x0 + Math.cos(a) * it.gradFill.length;
    y1 = y0 + Math.sin(a) * it.gradFill.length;
  } else {
    x0 = b.x;
    y0 = b.y + b.h / 2;
    x1 = b.x + b.w;
    y1 = y0;
  }
  const stops: GradientSpec['stops'] = [];
  const src = s.gradient.stops;
  for (let i = 0; i < src.length; i++) {
    const st = src[i];
    stops.push({ at: Math.min(1, Math.max(0, st.location / 100)), rgb: st.rgb });
    const next = src[i + 1];
    if (next && Math.abs(st.midpoint - 50) > 1) {
      // The midpoint: where the two colors are half and half.
      const at = st.location + ((next.location - st.location) * st.midpoint) / 100;
      const mix: RGB = [0, 1, 2].map((k) => Math.round((st.rgb[k] + next.rgb[k]) / 2)) as RGB;
      stops.push({ at: Math.min(1, Math.max(0, at / 100)), rgb: mix });
    }
  }
  return { type: s.gradient.type, x0, y0, x1, y1, r, stops };
}

function gradientFor(c: CanvasRenderingContext2D, sw: Swatches, it: Item, ref: string | null): CanvasGradient | null {
  const spec = gradientSpec(sw, it, ref);
  if (!spec) return null;
  const g = spec.type === 'Radial' ? c.createRadialGradient(spec.x0, spec.y0, 0, spec.x0, spec.y0, spec.r) : c.createLinearGradient(spec.x0, spec.y0, spec.x1, spec.y1);
  for (const st of spec.stops) g.addColorStop(st.at, css(st.rgb));
  return g;
}

/** The outline, with InDesign's corner options where the frame is a plain rectangle. */
export function outlinePath(it: Item): Path2D {
  return traceOutline(new Path2D(), it);
}

/** Traces an item's outline into a path (a Path2D, or anything that takes the same calls). */
export function traceOutline<P extends PathSink>(p: P, it: Item): P {
  const r = it.cornerRadius;
  const opt = it.cornerOption;
  const rectish = it.paths.length === 1 && it.paths[0].points.length === 4 && !it.paths[0].open && opt !== 'None' && r > 0 && it.kind !== 'line';
  if (rectish) {
    const b = it.box;
    const k = Math.min(r, b.w / 2, b.h / 2);
    if (opt === 'RoundedCorner') p.roundRect(b.x, b.y, b.w, b.h, k);
    else if (opt === 'BevelCorner') {
      p.moveTo(b.x + k, b.y);
      p.lineTo(b.x + b.w - k, b.y);
      p.lineTo(b.x + b.w, b.y + k);
      p.lineTo(b.x + b.w, b.y + b.h - k);
      p.lineTo(b.x + b.w - k, b.y + b.h);
      p.lineTo(b.x + k, b.y + b.h);
      p.lineTo(b.x, b.y + b.h - k);
      p.lineTo(b.x, b.y + k);
      p.closePath();
    } else if (opt === 'InverseRoundedCorner') {
      p.moveTo(b.x + k, b.y);
      p.lineTo(b.x + b.w - k, b.y);
      p.arc(b.x + b.w, b.y, k, Math.PI, Math.PI / 2, true);
      p.lineTo(b.x + b.w, b.y + b.h - k);
      p.arc(b.x + b.w, b.y + b.h, k, -Math.PI / 2, Math.PI, true);
      p.lineTo(b.x + k, b.y + b.h);
      p.arc(b.x, b.y + b.h, k, 0, -Math.PI / 2, true);
      p.lineTo(b.x, b.y + k);
      p.arc(b.x, b.y, k, Math.PI / 2, 0, true);
      p.closePath();
    } else if (opt === 'InsetCorner') {
      p.moveTo(b.x + k, b.y);
      p.lineTo(b.x + b.w - k, b.y);
      p.lineTo(b.x + b.w - k, b.y + k);
      p.lineTo(b.x + b.w, b.y + k);
      p.lineTo(b.x + b.w, b.y + b.h - k);
      p.lineTo(b.x + b.w - k, b.y + b.h - k);
      p.lineTo(b.x + b.w - k, b.y + b.h);
      p.lineTo(b.x + k, b.y + b.h);
      p.lineTo(b.x + k, b.y + b.h - k);
      p.lineTo(b.x, b.y + b.h - k);
      p.lineTo(b.x, b.y + k);
      p.lineTo(b.x + k, b.y + k);
      p.closePath();
    } else p.roundRect(b.x, b.y, b.w, b.h, k);
    return p;
  }
  tracePath(p, it.paths);
  return p;
}

export function dashFor(type: string, w: number): number[] {
  const t = type.replace(/^StrokeStyle\/(\$ID\/)?/, '');
  if (/dotted|dots/i.test(t)) return [0.001, Math.max(w * 2, 0.5)];
  if (/3x2/.test(t)) return [w * 3, w * 2];
  if (/4x4/.test(t)) return [w * 4, w * 4];
  if (/dash/i.test(t)) return [w * 3, w * 3];
  return [];
}

function drawItem(c: CanvasRenderingContext2D, o: SceneOptions, it: Item, m: Mat, parentBase: Mat, page: Page | null, fromMaster = false) {
  if (!it.visible) return;
  const sw = o.model.swatches;
  c.save();
  c.setTransform(...m);
  if (it.opacity < 1) c.globalAlpha *= it.opacity;
  const blend = BLENDS[it.blend];
  if (blend) c.globalCompositeOperation = blend;
  if (it.kind === 'group') {
    for (const ch of it.children) drawItem(c, o, ch, mul(m, ch.local), parentBase, page, fromMaster);
    c.restore();
    return;
  }
  if (it.kind === 'graphic') {
    drawGraphic(c, o, it, m);
    c.restore();
    return;
  }
  const path = outlinePath(it);
  const fillGrad = gradientFor(c, sw, it, it.fill);
  const fill = fillGrad ?? (it.kind === 'line' ? null : paint(sw, it.fill, it.fillTint));
  if (it.shadow) {
    const scale = Math.hypot(m[0], m[1]);
    const sc = resolveColor(sw, it.shadow.color, -1) ?? [0, 0, 0];
    c.shadowColor = css(sc, it.shadow.opacity);
    c.shadowBlur = it.shadow.blur * scale;
    const off = { x: it.shadow.x * Math.hypot(m[0], m[1]), y: it.shadow.y * Math.hypot(m[2], m[3]) };
    c.shadowOffsetX = off.x;
    c.shadowOffsetY = off.y;
  }
  if (fill) {
    c.fillStyle = fill;
    c.fill(path, 'evenodd');
    c.shadowColor = 'transparent';
  }
  // Contents: placed graphics and pasted-in frames, clipped to the frame.
  if (it.children.length) {
    c.save();
    c.clip(path, 'evenodd');
    // With no fill, the frame's shadow falls from its picture.
    if (fill || !it.shadow) c.shadowColor = 'transparent';
    for (const ch of it.children) {
      const item = o.overrides.get(ch.self) ?? ch;
      drawItem(c, o, item, mul(m, item.local), parentBase, page, fromMaster);
    }
    c.restore();
    c.shadowColor = 'transparent';
  }
  if (it.kind === 'text' && it.text) {
    c.shadowColor = 'transparent';
    const comp = o.text.comp(it.text.story, page);
    if (comp) drawText(c, o, comp, o.text.frameIndex(it));
  }
  c.shadowColor = 'transparent';
  const stroke = it.strokeWeight > 0 ? (gradientFor(c, sw, it, it.stroke) ?? paint(sw, it.stroke, it.strokeTint)) : null;
  if (stroke) {
    const w = it.strokeWeight;
    c.strokeStyle = stroke;
    c.lineJoin = it.join === 'RoundEndJoin' ? 'round' : it.join === 'BevelEndJoin' ? 'bevel' : 'miter';
    c.lineCap = it.cap === 'RoundEndCap' ? 'round' : it.cap === 'ProjectingEndCap' ? 'square' : 'butt';
    const dash = dashFor(it.strokeType, w);
    if (dash.length) {
      c.setLineDash(dash);
      if (dash[0] < 0.01) c.lineCap = 'round';
    }
    const gap = it.gap && dash.length ? paint(sw, it.gap, -1) : null;
    const closed = it.paths.every((p) => !p.open) && it.kind !== 'line';
    if (closed && it.strokeAlign === 'InsideAlignment') {
      c.save();
      c.clip(path, 'evenodd');
      c.lineWidth = w * 2;
      c.stroke(path);
      c.restore();
    } else if (closed && it.strokeAlign === 'OutsideAlignment') {
      c.save();
      const outside = new Path2D();
      const b = it.box;
      const pad = w * 4 + 10;
      outside.rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      outside.addPath(path);
      c.clip(outside, 'evenodd');
      c.lineWidth = w * 2;
      c.stroke(path);
      c.restore();
    } else {
      if (gap) {
        c.save();
        c.setLineDash([]);
        c.strokeStyle = gap;
        c.lineWidth = w;
        c.stroke(path);
        c.restore();
      }
      c.lineWidth = w;
      c.stroke(path);
    }
    c.setLineDash([]);
  }
  // An empty graphics frame shows InDesign's placeholder X.
  if (!o.preview && o.showFrameEdges && !fromMaster && it.contentType === 'GraphicType' && !it.children.length && it.kind !== 'line') {
    const layer = o.model.layers.find((l) => l.self === it.layer);
    c.strokeStyle = layer?.color ?? SELECT;
    c.lineWidth = 1 / Math.hypot(m[0], m[1]);
    const b = it.box;
    c.beginPath();
    c.moveTo(b.x, b.y);
    c.lineTo(b.x + b.w, b.y + b.h);
    c.moveTo(b.x + b.w, b.y);
    c.lineTo(b.x, b.y + b.h);
    c.stroke();
  }
  c.restore();
}

function drawGraphic(c: CanvasRenderingContext2D, o: SceneOptions, it: Item, m: Mat) {
  const g = it.graphic!;
  const el = (() => {
    const doc = o.partEls(it.part);
    if (!doc) return null;
    return findEl(doc, it.self);
  })();
  const entry = o.images.get(it.self, el, g.link);
  const b = g.bounds;
  c.setTransform(...m);
  if (entry.image) {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = Math.hypot(m[0], m[1]) < 0.5 ? 'medium' : 'high';
    c.drawImage(entry.image, b.x, b.y, b.w, b.h);
    return;
  }
  // No picture: InDesign's gray box.
  c.fillStyle = entry.state === 'loading' ? '#e6e6e6' : '#d0d0d0';
  c.fillRect(b.x, b.y, b.w, b.h);
  if (entry.state !== 'loading') {
    c.strokeStyle = '#9a9a9a';
    c.lineWidth = 1 / Math.hypot(m[0], m[1]);
    c.beginPath();
    c.moveTo(b.x, b.y);
    c.lineTo(b.x + b.w, b.y + b.h);
    c.moveTo(b.x + b.w, b.y);
    c.lineTo(b.x, b.y + b.h);
    c.stroke();
  }
}

const elCache = new WeakMap<XMLDocument, Map<string, Element>>();
export function findEl(doc: XMLDocument, self: string): Element | null {
  let m = elCache.get(doc);
  if (!m) {
    m = new Map();
    for (const tag of ['Image', 'PDF', 'EPS', 'ImportedPage', 'SVG', 'WMF', 'PICT']) {
      for (const e of Array.from(doc.getElementsByTagName(tag))) {
        const s = e.getAttribute('Self');
        if (s) m.set(s, e);
      }
    }
    elCache.set(doc, m);
  }
  return m.get(self) ?? null;
}

export function drawText(c: CanvasRenderingContext2D, o: { model: Model }, comp: Composition, frame: number) {
  const lines = comp.byFrame[frame];
  if (!lines?.length) return;
  const sw = o.model.swatches;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fontKerning = 'normal';
  let lastFont = '';
  let lastFill = '';
  let lastLs = '';
  c.letterSpacing = '0px';
  for (const l of lines) {
    if (l.shading) {
      const col = paint(sw, l.shading.color, l.shading.tint);
      if (col) {
        c.fillStyle = col;
        lastFill = col;
        c.fillRect(l.shading.x0, l.shading.y0, l.shading.x1 - l.shading.x0, l.shading.y1 - l.shading.y0);
      }
    }
    drawRule(c, sw, l.ruleAbove);
    drawRule(c, sw, l.ruleBelow);
    if (l.ruleAbove || l.ruleBelow) lastFill = '';
    for (const p of l.pieces) {
      if (p.table) {
        drawTable(c, o, p.table, p.x, l.y - p.table.h);
        lastFont = '';
        lastFill = '';
        lastLs = '';
        c.letterSpacing = '0px';
        continue;
      }
      if (!p.text) continue;
      const look = p.look;
      const fill = paint(sw, look.fill, look.fillTint);
      const strokeCol = look.stroke ? paint(sw, look.stroke, look.strokeTint) : null;
      if (!fill && !strokeCol) continue;
      // Glyphs are drawn at the size they were measured at (100px) and scaled down, so small
      // type keeps the advances the composer used instead of hinted ones.
      if (look.font !== lastFont) {
        c.font = look.font;
        lastFont = look.font;
      }
      const ls = `${(look.tracking * 100) / (look.hscale || 1)}px`;
      if (ls !== lastLs) {
        c.letterSpacing = ls;
        lastLs = ls;
      }
      const y = l.y - look.shift;
      const k = look.size / 100;
      if (fill && fill !== lastFill) {
        c.fillStyle = fill;
        lastFill = fill;
      }
      c.save();
      c.translate(p.x, y);
      if (look.skew) c.transform(1, 0, -Math.tan((look.skew * Math.PI) / 180), 1, 0, 0);
      c.scale(k * look.hscale, k * look.vscale);
      if (fill) c.fillText(p.text, 0, 0);
      if (strokeCol) {
        c.strokeStyle = strokeCol;
        c.lineWidth = look.strokeWeight / (k || 1);
        c.strokeText(p.text, 0, 0);
      }
      c.restore();
      if (look.underline || look.strike) decorate(c, p.x, p.w, y, look, fill ?? strokeCol ?? '#000');
    }
  }
  c.letterSpacing = '0px';
}

function drawTable(c: CanvasRenderingContext2D, o: { model: Model }, t: TableLayout, x: number, y: number) {
  const sw = o.model.swatches;
  for (const cell of t.cells) {
    const fill = paint(sw, cell.fill, cell.fillTint);
    if (fill) {
      c.fillStyle = fill;
      c.fillRect(x + cell.x, y + cell.y, cell.w, cell.h);
    }
  }
  for (const cell of t.cells) {
    c.save();
    c.translate(x + cell.x + cell.tx, y + cell.y + cell.ty);
    drawText(c, o, cell.comp, 0);
    c.restore();
  }
  for (const cell of t.cells) {
    const x0 = x + cell.x;
    const y0 = y + cell.y;
    const lines: [number, number, number, number][] = [
      [x0, y0, x0 + cell.w, y0],
      [x0, y0, x0, y0 + cell.h],
      [x0, y0 + cell.h, x0 + cell.w, y0 + cell.h],
      [x0 + cell.w, y0, x0 + cell.w, y0 + cell.h],
    ];
    cell.edges.forEach((e, i) => {
      const col = e.weight > 0 ? paint(sw, e.color, e.tint) : null;
      if (!col) return;
      c.strokeStyle = col;
      c.lineWidth = e.weight;
      c.beginPath();
      c.moveTo(lines[i][0], lines[i][1]);
      c.lineTo(lines[i][2], lines[i][3]);
      c.stroke();
    });
  }
}

function decorate(c: CanvasRenderingContext2D, x: number, w: number, y: number, look: Look, color: string) {
  c.save();
  c.fillStyle = color;
  const t = Math.max(0.25, look.size * 0.05);
  if (look.underline) c.fillRect(x, y + look.size * 0.1, w, t);
  if (look.strike) c.fillRect(x, y - look.size * 0.28, w, t);
  c.restore();
}

function drawRule(c: CanvasRenderingContext2D, sw: Swatches, r: Line['ruleAbove']) {
  if (!r) return;
  const col = paint(sw, r.color, r.tint);
  if (!col) return;
  c.fillStyle = col;
  c.fillRect(r.x0, r.y - r.weight / 2, r.x1 - r.x0, r.weight);
}

function hairline(c: CanvasRenderingContext2D, m: Mat) {
  c.lineWidth = 1 / Math.hypot(m[0], m[1]);
}

function drawGuides(c: CanvasRenderingContext2D, o: SceneOptions, s: Spread, base: Mat) {
  const { model } = o;
  c.save();
  c.setTransform(...base);
  hairline(c, base);
  const b = model.prefs.bleed;
  if (o.showGuides && (b.top || b.bottom || b.inside || b.outside) && s.pages.length) {
    // Bleed: one box around the spread, outside edges by the outside bleed.
    const first = s.pages[0];
    const last = s.pages[s.pages.length - 1];
    const left = first.side === 'right' && s.pages.length === 1 ? b.inside : b.outside;
    const right = last.side === 'left' && s.pages.length === 1 ? b.inside : b.outside;
    const sb = s.bounds;
    c.strokeStyle = BLEED;
    c.strokeRect(sb.x - left, sb.y - b.top, sb.w + left + right, sb.h + b.top + b.bottom);
  }
  for (const p of s.pages) {
    if (o.showGuides) {
      // Margins and columns, in the page's own coordinates.
      c.save();
      c.setTransform(...mul(base, p.m));
      hairline(c, mul(base, p.m));
      const g = p.geom;
      const mg = p.margins;
      const ml = p.side === 'left' ? mg.right : mg.left;
      const mr = p.side === 'left' ? mg.left : mg.right;
      const inner = { x: g.x + ml, y: g.y + mg.top, w: g.w - ml - mr, h: g.h - mg.top - mg.bottom };
      c.strokeStyle = MARGIN;
      c.strokeRect(inner.x, inner.y, inner.w, inner.h);
      if (mg.columns > 1) {
        c.strokeStyle = COLUMN;
        const pos = mg.positions.length === mg.columns * 2 ? mg.positions : null;
        const cw = (inner.w - mg.gutter * (mg.columns - 1)) / mg.columns;
        c.beginPath();
        for (let i = 0; i < mg.columns; i++) {
          const a = pos ? inner.x + pos[i * 2] : inner.x + i * (cw + mg.gutter);
          const z = pos ? inner.x + pos[i * 2 + 1] : a + cw;
          if (i > 0) {
            c.moveTo(a, inner.y);
            c.lineTo(a, inner.y + inner.h);
          }
          if (i < mg.columns - 1) {
            c.moveTo(z, inner.y);
            c.lineTo(z, inner.y + inner.h);
          }
        }
        c.stroke();
      }
      c.restore();
    }
  }
  if (o.showGuides) {
    for (const gd of s.guides) {
      const p = gd.page ? s.pages.find((q) => q.self === gd.page) : null;
      c.strokeStyle = gd.color;
      c.beginPath();
      if (p) {
        // Page guides span the page, in the page's coordinates.
        const a = apply(p.m, gd.vertical ? { x: gd.location, y: p.geom.y } : { x: p.geom.x, y: gd.location });
        const z = apply(p.m, gd.vertical ? { x: gd.location, y: p.geom.y + p.geom.h } : { x: p.geom.x + p.geom.w, y: gd.location });
        c.moveTo(a.x, a.y);
        c.lineTo(z.x, z.y);
      } else {
        const sb = s.bounds;
        if (gd.vertical) {
          c.moveTo(gd.location, sb.y - 2000);
          c.lineTo(gd.location, sb.y + sb.h + 2000);
        } else {
          c.moveTo(sb.x - 2000, gd.location);
          c.lineTo(sb.x + sb.w + 2000, gd.location);
        }
      }
      c.stroke();
    }
  }
  if (o.showFrameEdges) {
    for (const it of s.items) drawEdges(c, o, o.overrides.get(it.self) ?? it, base);
  }
  if (o.showThreads) drawThreads(c, o, s, base);
  c.restore();
}

function drawEdges(c: CanvasRenderingContext2D, o: SceneOptions, it: Item, base: Mat) {
  if (!it.visible) return;
  const layer = o.model.layers.find((l) => l.self === it.layer);
  if (layer && !layer.visible) return;
  if (it.kind === 'group') {
    for (const ch of it.children) drawEdges(c, o, ch, base);
    return;
  }
  if (it.kind !== 'text' && it.kind !== 'rect' && it.kind !== 'oval' && it.kind !== 'polygon') return;
  // Frames with a visible stroke don't need an edge drawn.
  if (it.stroke && it.strokeWeight > 0 && it.kind !== 'text') return;
  const m = mul(base, it.m);
  c.save();
  c.setTransform(...m);
  c.strokeStyle = it.kind === 'text' ? 'rgba(130,130,130,0.8)' : (layer?.color ?? SELECT);
  hairline(c, m);
  c.stroke(outlinePath(it));
  c.restore();
}

function drawThreads(c: CanvasRenderingContext2D, o: SceneOptions, s: Spread, base: Mat) {
  for (const [, frames] of o.model.threads) {
    for (let i = 0; i + 1 < frames.length; i++) {
      const a = o.overrides.get(frames[i].self) ?? frames[i];
      const b = o.overrides.get(frames[i + 1].self) ?? frames[i + 1];
      const sa = o.model.spreadOf.get(a.self);
      const sb = o.model.spreadOf.get(b.self);
      if (sa !== s) continue;
      const pa = apply(a.m, { x: a.box.x + a.box.w, y: a.box.y + a.box.h - 4 });
      let pb = apply(b.m, { x: b.box.x, y: b.box.y + 4 });
      if (sb && sb !== s) pb = { x: pb.x, y: pb.y + sb.y - s.y };
      const layer = o.model.layers.find((l) => l.self === a.layer);
      c.strokeStyle = layer?.color ?? SELECT;
      hairline(c, base);
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.bezierCurveTo(pa.x + 40, pa.y, pb.x - 40, pb.y, pb.x, pb.y);
      c.stroke();
    }
  }
}

// ---- Selection overlay -----------------------------------------------------------------------

export interface OverlayItem {
  item: Item;
  spread: Spread;
  /** Content (direct selection): drawn in InDesign's brown. */
  content?: boolean;
}

export interface Overlay {
  selected: OverlayItem[];
  /** One box around several items. */
  groupBox: { corners: Pt[]; spread: Spread } | null;
  showHandles: boolean;
  hover: OverlayItem | null;
  text: { comp: Composition; frames: { item: Item; spread: Spread; index: number }[]; a: number; b: number; caret: boolean } | null;
  marquee: Rect | null;
  draft: { kind: 'rect' | 'oval' | 'line' | 'polygon' | 'frame' | 'text'; a: Pt; b: Pt } | null;
  guide: { vertical: boolean; pos: number } | null;
  pen: Pt[] | null;
  pivot: Pt | null;
  /** Frames whose story didn't all fit. */
  overset: Set<string>;
}

export const HANDLES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

export function handlePoints(corners: Pt[]): Pt[] {
  const [a, b, c2, d] = corners;
  const mid = (p: Pt, q: Pt) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  return [a, mid(a, b), b, mid(b, c2), c2, mid(c2, d), d, mid(d, a)];
}

export function drawOverlay(c: CanvasRenderingContext2D, o: SceneOptions, ov: Overlay) {
  const { view, dpr } = o;
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (s: Spread, p: Pt): Pt => apply(spreadToScreen(view, s), p);
  // Text selection and caret.
  if (ov.text) {
    const { comp, frames, a, b, caret } = ov.text;
    for (const f of frames) {
      const m = mul([dpr, 0, 0, dpr, 0, 0], mul(spreadToScreen(view, f.spread), f.item.m));
      c.save();
      c.setTransform(...m);
      if (b > a) {
        c.fillStyle = 'rgba(80,140,255,0.35)';
        const rects = comp.lines.length ? selectRects(comp, a, b, f.index) : [];
        for (const r of rects) c.fillRect(r.x, r.y, r.w, r.h);
      } else if (caret) {
        const line = lineForCaret(comp, a, f.index);
        if (line) {
          const x = caretXOf(line, a);
          c.fillStyle = '#000';
          const w = (1 / Math.hypot(m[0], m[1])) * dpr;
          c.fillRect(x - w / 2, line.y - Math.max(line.ascent, line.leading * 0.75), w, Math.max(line.ascent, line.leading * 0.75) + line.descent);
        } else if (f.index === 0 && !comp.lines.length) {
          const fr = f.item.box;
          const ins = f.item.text?.prefs.inset ?? [0, 0, 0, 0];
          const w = (1 / Math.hypot(m[0], m[1])) * dpr;
          c.fillStyle = '#000';
          c.fillRect(fr.x + ins[1], fr.y + ins[0], w, 12);
        }
      }
      c.restore();
    }
  }
  // Hover: the frame under the pointer, outlined.
  if (ov.hover && !ov.selected.some((s) => s.item.self === ov.hover!.item.self)) {
    const it = ov.hover.item;
    const m = mul(spreadToScreen(view, ov.hover.spread), it.m);
    c.save();
    c.setTransform(...mul([dpr, 0, 0, dpr, 0, 0], m));
    const layer = o.model.layers.find((l) => l.self === it.layer);
    c.strokeStyle = layer?.color ?? SELECT;
    c.lineWidth = (1.5 / Math.hypot(m[0], m[1]));
    c.stroke(it.kind === 'group' || it.kind === 'graphic' ? boxPath(it.box) : outlinePath(it));
    c.restore();
  }
  // The content grabber: a donut in the middle of a graphics frame, for moving the picture inside.
  for (const g of [ov.hover, ...ov.selected]) {
    if (!g || g.content || g.item.kind === 'group' || !g.item.children.some((c) => c.kind === 'graphic')) continue;
    const ctr = apply(mul(spreadToScreen(view, g.spread), g.item.m), { x: g.item.box.x + g.item.box.w / 2, y: g.item.box.y + g.item.box.h / 2 });
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.beginPath();
    c.arc(ctr.x, ctr.y, 8, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(80,80,80,0.9)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(ctr.x, ctr.y, 5.5, 0, Math.PI * 2);
    c.stroke();
  }
  for (const sel of ov.selected) {
    const it = sel.item;
    const layer = o.model.layers.find((l) => l.self === it.layer);
    const color = sel.content ? '#c47a2c' : (layer?.color ?? SELECT);
    const m = mul(spreadToScreen(view, sel.spread), it.m);
    // The path itself.
    if (it.kind !== 'group' && it.kind !== 'graphic') {
      c.save();
      c.setTransform(...mul([dpr, 0, 0, dpr, 0, 0], m));
      c.strokeStyle = color;
      c.lineWidth = 1 / Math.hypot(m[0], m[1]);
      c.stroke(outlinePath(it));
      c.restore();
    }
    if (ov.groupBox) continue;
    const corners = rectCorners(it.box).map((p) => apply(m, p));
    drawBox(c, corners, color, ov.showHandles, sel.content ? false : true, it.kind === 'group');
    if (it.kind === 'text' && !sel.content) drawPorts(c, it, m, color, ov.overset.has(it.self));
  }
  if (ov.groupBox) {
    const corners = ov.groupBox.corners.map((p) => toScreen(ov.groupBox!.spread, p));
    const color = SELECT;
    drawBox(c, corners, color, ov.showHandles, true, true);
  }
  if (ov.marquee) {
    const a = { x: view.x + ov.marquee.x * view.zoom, y: view.y + ov.marquee.y * view.zoom };
    c.strokeStyle = '#000';
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(ov.marquee.w * view.zoom), Math.round(ov.marquee.h * view.zoom));
    c.setLineDash([]);
  }
  if (ov.draft) {
    const { a, b, kind } = ov.draft;
    const pa = { x: view.x + a.x * view.zoom, y: view.y + a.y * view.zoom };
    const pb = { x: view.x + b.x * view.zoom, y: view.y + b.y * view.zoom };
    c.strokeStyle = SELECT;
    c.lineWidth = 1;
    c.beginPath();
    if (kind === 'line') {
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
    } else if (kind === 'oval') c.ellipse((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, Math.abs(pb.x - pa.x) / 2, Math.abs(pb.y - pa.y) / 2, 0, 0, Math.PI * 2);
    else c.rect(Math.min(pa.x, pb.x) + 0.5, Math.min(pa.y, pb.y) + 0.5, Math.abs(pb.x - pa.x), Math.abs(pb.y - pa.y));
    c.stroke();
  }
  if (ov.pen && ov.pen.length) {
    c.strokeStyle = SELECT;
    c.lineWidth = 1;
    c.beginPath();
    ov.pen.forEach((p, i) => {
      const q = { x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom };
      if (i) c.lineTo(q.x, q.y);
      else c.moveTo(q.x, q.y);
    });
    c.stroke();
    for (const p of ov.pen) {
      const q = { x: view.x + p.x * view.zoom, y: view.y + p.y * view.zoom };
      c.fillStyle = '#fff';
      c.fillRect(q.x - 3, q.y - 3, 6, 6);
      c.strokeRect(q.x - 2.5, q.y - 2.5, 5, 5);
    }
  }
  if (ov.guide) {
    c.strokeStyle = '#4ad3ff';
    c.lineWidth = 1;
    c.beginPath();
    if (ov.guide.vertical) {
      const x = Math.round(view.x + ov.guide.pos * view.zoom) + 0.5;
      c.moveTo(x, 0);
      c.lineTo(x, o.height);
    } else {
      const y = Math.round(view.y + ov.guide.pos * view.zoom) + 0.5;
      c.moveTo(0, y);
      c.lineTo(o.width, y);
    }
    c.stroke();
  }
  if (ov.pivot) {
    const p = { x: view.x + ov.pivot.x * view.zoom, y: view.y + ov.pivot.y * view.zoom };
    c.strokeStyle = '#000';
    c.fillStyle = '#fff';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(p.x, p.y, 5, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.moveTo(p.x - 8, p.y);
    c.lineTo(p.x + 8, p.y);
    c.moveTo(p.x, p.y - 8);
    c.lineTo(p.x, p.y + 8);
    c.stroke();
  }
  c.restore();
}

function boxPath(b: Rect): Path2D {
  const p = new Path2D();
  p.rect(b.x, b.y, b.w, b.h);
  return p;
}

function drawBox(c: CanvasRenderingContext2D, corners: Pt[], color: string, handles: boolean, center: boolean, dashed: boolean) {
  c.strokeStyle = color;
  c.lineWidth = 1;
  if (dashed) c.setLineDash([4, 2]);
  c.beginPath();
  corners.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  c.stroke();
  c.setLineDash([]);
  if (handles) {
    for (const h of handlePoints(corners)) {
      c.fillStyle = '#fff';
      c.fillRect(Math.round(h.x) - 3, Math.round(h.y) - 3, 7, 7);
      c.strokeStyle = color;
      c.strokeRect(Math.round(h.x) - 2.5, Math.round(h.y) - 2.5, 6, 6);
    }
  }
  if (center) {
    const cx = (corners[0].x + corners[2].x) / 2;
    const cy = (corners[0].y + corners[2].y) / 2;
    c.fillStyle = color;
    c.fillRect(Math.round(cx) - 2, Math.round(cy) - 2, 5, 5);
  }
}

/** In and out ports at a text frame's top left and bottom right; the out port turns into a red + when text is overset. */
export function portPoints(it: Item, m: Mat): { inPort: Pt; outPort: Pt } {
  const b = it.box;
  const a = apply(m, { x: b.x, y: b.y });
  const z = apply(m, { x: b.x + b.w, y: b.y + b.h });
  const ux = apply(m, { x: b.x + 1, y: b.y });
  const len = Math.hypot(ux.x - a.x, ux.y - a.y) || 1;
  const n = { x: (ux.x - a.x) / len, y: (ux.y - a.y) / len };
  return { inPort: { x: a.x + n.x * 16, y: a.y + n.y * 16 }, outPort: { x: z.x - n.x * 16, y: z.y - n.y * 16 } };
}

function drawPorts(c: CanvasRenderingContext2D, it: Item, m: Mat, color: string, overset: boolean) {
  const { inPort, outPort } = portPoints(it, m);
  const box = (p: Pt, kind: 'empty' | 'threaded' | 'overset') => {
    const x = Math.round(p.x) - 4;
    const y = Math.round(p.y) - 4;
    c.fillStyle = '#fff';
    c.fillRect(x, y, 9, 9);
    c.strokeStyle = kind === 'overset' ? '#e00' : color;
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, 8, 8);
    if (kind === 'overset') {
      c.fillStyle = '#e00';
      c.fillRect(x + 2, y + 4, 5, 1);
      c.fillRect(x + 4, y + 2, 1, 5);
    } else if (kind === 'threaded') {
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(x + 3, y + 2);
      c.lineTo(x + 7, y + 4.5);
      c.lineTo(x + 3, y + 7);
      c.fill();
    }
  };
  box(inPort, it.text?.prev ? 'threaded' : 'empty');
  box(outPort, overset ? 'overset' : it.text?.next ? 'threaded' : 'empty');
}


function lineForCaret(comp: Composition, pos: number, frame: number): Line | null {
  const l = lineAt(comp, pos);
  if (l && l.frame === frame) return l;
  if (!l && frame === comp.byFrame.length - 1) {
    const ls = comp.byFrame[frame];
    return ls?.[ls.length - 1] ?? null;
  }
  return null;
}

function selectRects(comp: Composition, a: number, b: number, frame: number): Rect[] {
  return selectionRects(comp, a, b)
    .filter((r) => r.frame === frame)
    .map((r) => r.rect);
}
