import type { Color } from '../vector/pdf/color';
import { PdfRef, type PdfDict, type PdfValue } from '../vector/pdf/objects';
import { fmt, hexString, imageXObject, jpegInfo, matOps, N, PdfContent, pdfDate, pdfText, PdfWriter, splitRgba } from '../vector/pdf/writer';
import { css, resolveColor, type RGB, type Swatches } from './colors';
import { measure, type Composition, type Line, type Look, type TableLayout } from './compose';
import { apply, intersects, invert, mul, transformRect, type Mat, type PathSink, type Rect } from './geom';
import type { ImageEntry, ImageStore } from './images';
import { masterPageFor, masterToPage, type Item, type LayerInfo, type Model, type Page, type Spread } from './model';
import { WebFonts } from './pdfFonts';
import { BLENDS, dashFor, findEl, gradientSpec, outlinePath, pageOfItem, traceOutline, type GradientSpec, type TextSource } from './render';
import type { EmbeddedFont } from '../vector/pdf/sfnt';

/**
 * Export to PDF, drawing what the canvas draws in Preview but as PDF does
 * it: frames and shapes as paths, swatches in their own color spaces
 * (process CMYK, spot colors as Separations), gradients as shadings, placed
 * pictures at their full resolution (JPEGs as they are), and type as text
 * in the fonts it was drawn with, embedded, set glyph by glyph where the
 * composer put it. Each document page is a PDF page. Drop shadows (blurred)
 * and characters none of the bundled fonts has are drawn as pictures.
 */

interface Ctx {
  model: Model;
  w: PdfWriter;
  c: PdfContent;
  images: ImageStore;
  text: TextSource;
  fonts: WebFonts;
  notes: Set<string>;
  imageRefs: Map<ImageEntry, PdfRef | null>;
  /** Text drawn as pictures, by what was drawn, so a run that repeats is stored once. */
  rasterRefs: Map<string, { ref: PdfRef; box: Rect } | null>;
  /** The page's height, for placing things in its y-down coordinates. */
  pageH: number;
}

/** What drawing inherits: item space to the PDF page, and the opacity and blend mode in effect. */
interface State {
  ctm: Mat;
  alpha: number;
  blend: string | null;
}

// ---- Paths ----------------------------------------------------------------------------------

/** A path traced as PDF path operators. Arcs become Béziers. */
class PdfPath implements PathSink {
  private out: string[] = [];
  private x = 0;
  private y = 0;
  private sx = 0;
  private sy = 0;
  private open = false;

  moveTo(x: number, y: number) {
    this.out.push(`${fmt(x)} ${fmt(y)} m`);
    this.x = this.sx = x;
    this.y = this.sy = y;
    this.open = true;
  }

  lineTo(x: number, y: number) {
    if (!this.open) return this.moveTo(x, y);
    this.out.push(`${fmt(x)} ${fmt(y)} l`);
    this.x = x;
    this.y = y;
  }

  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) {
    if (!this.open) this.moveTo(a, b);
    this.out.push(`${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(x)} ${fmt(y)} c`);
    this.x = x;
    this.y = y;
  }

  closePath() {
    if (!this.open) return;
    this.out.push('h');
    this.x = this.sx;
    this.y = this.sy;
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    const TAU = Math.PI * 2;
    let sweep: number;
    if (!ccw) sweep = a1 - a0 >= TAU ? TAU : ((((a1 - a0) % TAU) + TAU) % TAU);
    else sweep = a0 - a1 >= TAU ? -TAU : -((((a0 - a1) % TAU) + TAU) % TAU);
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    if (this.open) this.lineTo(x0, y0);
    else this.moveTo(x0, y0);
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4);
    let t = a0;
    for (let i = 0; i < n; i++) {
      const t2 = t + step;
      const c1 = { x: cx + r * (Math.cos(t) - k * Math.sin(t)), y: cy + r * (Math.sin(t) + k * Math.cos(t)) };
      const c2 = { x: cx + r * (Math.cos(t2) + k * Math.sin(t2)), y: cy + r * (Math.sin(t2) - k * Math.cos(t2)) };
      this.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, cx + r * Math.cos(t2), cy + r * Math.sin(t2));
      t = t2;
    }
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | DOMPointInit | Iterable<number | DOMPointInit>) {
    const first = typeof radii === 'number' ? radii : radii && Symbol.iterator in radii ? [...radii][0] : radii;
    const r0 = typeof first === 'number' ? first : (first?.x ?? 0);
    const r = Math.max(0, Math.min(r0, Math.abs(w) / 2, Math.abs(h) / 2));
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    if (r) this.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - r);
    if (r) this.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    this.lineTo(x + r, y + h);
    if (r) this.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    this.lineTo(x, y + r);
    if (r) this.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    this.closePath();
  }

  toString() {
    return this.out.join('\n');
  }
}

const rectOps = (r: Rect) => `${fmt(r.x)} ${fmt(r.y)} ${fmt(r.w)} ${fmt(r.h)} re`;

// ---- Color ----------------------------------------------------------------------------------

/** A swatch (and tint) as a PDF color: process colors in their own space, spot colors as Separations. */
export function swatchColor(sw: Swatches, ref: string | null | undefined, tint = -1): Color | null {
  if (!ref || ref === 'Swatch/None' || ref === 'n') return null;
  const s = sw.bySelf.get(ref) ?? (ref.startsWith('Color/') ? null : sw.bySelf.get(`Color/${ref}`));
  if (!s) return ref === 'Color/Black' ? { space: 'cmyk', c: [0, 0, 0, 1] } : null;
  const t = (tint >= 0 && tint < 100 ? tint / 100 : 1) * (s.kind === 'tint' && s.tint !== undefined && s.tint >= 0 && s.tint < 100 ? s.tint / 100 : 1);
  if (s.kind === 'none') return null;
  if (s.kind === 'paper') return { space: 'gray', c: [1] };
  if (s.kind === 'registration') return { space: 'cmyk', c: [t, t, t, t], spot: 'All', tint: t, spotFull: [1, 1, 1, 1] };
  const base = s.kind === 'tint' ? sw.bySelf.get(s.base ?? '') : s;
  if (!base || (base.kind !== 'color' && base.kind !== 'tint')) return rgbColor(t < 1 ? resolveColor(sw, ref, tint) ?? s.rgb : s.rgb);
  let full: Color;
  if (base.space === 'CMYK') full = { space: 'cmyk', c: [0, 1, 2, 3].map((i) => Math.min(1, Math.max(0, (base.values[i] ?? 0) / 100))) };
  else if (base.space === 'RGB') full = { space: 'rgb', c: [0, 1, 2].map((i) => Math.min(1, Math.max(0, (base.values[i] ?? 0) / 255))) };
  else full = rgbColor(base.rgb);
  const tinted = full.space === 'cmyk' ? full.c.map((v) => v * t) : full.c.map((v) => 1 - (1 - v) * t);
  if (base.model === 'Spot') return { space: full.space, c: tinted, spot: base.name, tint: t, spotFull: full.c };
  return { space: full.space, c: tinted };
}

const rgbColor = (rgb: RGB): Color => ({ space: 'rgb', c: rgb.map((v) => v / 255) });

function screenRgb(ctx: Ctx, ref: string | null, tint: number): RGB {
  return resolveColor(ctx.model.swatches, ref, tint) ?? [0, 0, 0];
}

/** A gradient as a shading pattern, mapped onto the page by the current transform; the operators that select it. */
function gradientOps(ctx: Ctx, g: GradientSpec, st: State, stroke: boolean): string {
  const stops = [...g.stops].sort((a, b) => a.at - b.at);
  if (!stops.length) stops.push({ at: 0, rgb: [0, 0, 0] });
  if (stops[0].at > 0) stops.unshift({ at: 0, rgb: stops[0].rgb });
  if (stops[stops.length - 1].at < 1) stops.push({ at: 1, rgb: stops[stops.length - 1].rgb });
  const fns: PdfDict[] = [];
  const bounds: number[] = [];
  const encode: number[] = [];
  let last = 0;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    fns.push(
      new Map<string, PdfValue>([
        ['FunctionType', 2],
        ['Domain', [0, 1]],
        ['C0', a.rgb.map((v) => v / 255)],
        ['C1', b.rgb.map((v) => v / 255)],
        ['N', 1],
      ]),
    );
    if (i > 0) {
      // Bounds have to rise; stops at one place become a step.
      last = Math.min(1, Math.max(last + 1e-5, a.at));
      bounds.push(last);
    }
    encode.push(0, 1);
  }
  const fn: PdfValue =
    fns.length === 1
      ? fns[0]
      : new Map<string, PdfValue>([
          ['FunctionType', 3],
          ['Domain', [0, 1]],
          ['Functions', fns],
          ['Bounds', bounds],
          ['Encode', encode],
        ]);
  const shading: PdfDict = new Map<string, PdfValue>([
    ['ShadingType', g.type === 'Radial' ? 3 : 2],
    ['ColorSpace', N('DeviceRGB')],
    ['Coords', g.type === 'Radial' ? [g.x0, g.y0, 0, g.x0, g.y0, g.r] : [g.x0, g.y0, g.x1, g.y1]],
    ['Function', fn],
    ['Extend', [true, true]],
  ]);
  const pattern: PdfDict = new Map<string, PdfValue>([
    ['Type', N('Pattern')],
    ['PatternType', 2],
    ['Shading', ctx.w.add(shading)],
    ['Matrix', [...st.ctm]],
  ]);
  const name = `P${ctx.c.res.Pattern.size}`;
  ctx.c.res.Pattern.set(name, ctx.w.add(pattern));
  return stroke ? `/Pattern CS /${name} SCN` : `/Pattern cs /${name} scn`;
}

// ---- Pictures -------------------------------------------------------------------------------

function pixelsOf(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d')!;
  cx.drawImage(src, 0, 0, w, h);
  return cx.getImageData(0, 0, w, h).data;
}

function imageRef(ctx: Ctx, entry: ImageEntry): PdfRef | null {
  if (ctx.imageRefs.has(entry)) return ctx.imageRefs.get(entry)!;
  let ref: PdfRef | null = null;
  const info = entry.jpeg ? jpegInfo(entry.jpeg) : null;
  if (entry.jpeg && info && info.width > 0 && info.height > 0 && [1, 3, 4].includes(info.components)) {
    ref = imageXObject(ctx.w, { width: info.width, height: info.height, jpeg: entry.jpeg, jpegComponents: info.components, jpegDecode: info.decode });
  } else if (entry.image) {
    const { width, height } = entry.image;
    const px = splitRgba(pixelsOf(entry.image, width, height), width * height);
    ref = imageXObject(ctx.w, { width, height, rgb: px.rgb, alpha: px.alpha });
  }
  ctx.imageRefs.set(entry, ref);
  return ref;
}

/** Pixels drawn on a canvas as an image (null when nothing was drawn). */
function canvasImage(ctx: Ctx, cv: HTMLCanvasElement): PdfRef | null {
  const px = splitRgba(cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data, cv.width * cv.height);
  if (px.alpha && px.alpha.every((a) => a === 0)) return null;
  return imageXObject(ctx.w, { width: cv.width, height: cv.height, rgb: px.rgb, alpha: px.alpha });
}

/** An image placed over a rectangle of the current space. */
function placeImage(ctx: Ctx, ref: PdfRef | null, r: Rect) {
  if (!ref) return;
  const name = `Im${ctx.c.res.XObject.size}`;
  ctx.c.res.XObject.set(name, ref);
  ctx.c.op(`q\n${matOps([r.w, 0, 0, -r.h, r.x, r.y + r.h])}\n/${name} Do\nQ`);
}

function drawGraphic(ctx: Ctx, it: Item) {
  const g = it.graphic!;
  const doc = ctx.model.pkg.xml.get(it.part);
  const entry = ctx.images.get(it.self, doc ? findEl(doc, it.self) : null, g.link);
  const b = g.bounds;
  const ref = entry.image ? imageRef(ctx, entry) : null;
  if (ref) {
    const name = `Im${ctx.c.res.XObject.size}`;
    ctx.c.res.XObject.set(name, ref);
    ctx.c.op(`q\n${matOps([b.w, 0, 0, -b.h, b.x, b.y + b.h])}\n/${name} Do\nQ`);
    return;
  }
  // No picture: InDesign's gray box, as the page shows it.
  ctx.notes.add('Pictures that couldn’t be found are gray boxes in the PDF.');
  ctx.c.op(`${ctx.c.color(rgbColor([208, 208, 208]), false)}\n${rectOps(b)}\nf`);
  ctx.c.op(`${ctx.c.color(rgbColor([154, 154, 154]), true)}\n0 w\n${fmt(b.x)} ${fmt(b.y)} m ${fmt(b.x + b.w)} ${fmt(b.y + b.h)} l ${fmt(b.x + b.w)} ${fmt(b.y)} m ${fmt(b.x)} ${fmt(b.y + b.h)} l S`);
}

/** A frame's drop shadow, blurred as the canvas blurs it, as a picture under the frame. */
function drawShadow(ctx: Ctx, it: Item, st: State) {
  const sh = it.shadow!;
  // Item space to the page, y down, in points.
  const md = mul([1, 0, 0, -1, 0, ctx.pageH], st.ctm);
  const sx = Math.hypot(md[0], md[1]);
  const sy = Math.hypot(md[2], md[3]);
  const blur = sh.blur * sx;
  const off = { x: sh.x * sx, y: sh.y * sy };
  const b0 = transformRect(md, it.box);
  const pad = blur * 1.5 + 2;
  const b = { x: b0.x + Math.min(0, off.x) - pad, y: b0.y + Math.min(0, off.y) - pad, w: b0.w + Math.abs(off.x) + pad * 2, h: b0.h + Math.abs(off.y) + pad * 2 };
  const res = Math.min(150 / 72, 3000 / Math.max(b.w, b.h, 1));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(b.w * res));
  cv.height = Math.max(1, Math.ceil(b.h * res));
  const cx = cv.getContext('2d')!;
  // The frame is drawn off the canvas; only its shadow lands on it.
  const far = cv.width + blur * res * 4 + 100;
  cx.setTransform(...mul([res, 0, 0, res, -b.x * res - far, -b.y * res], md));
  cx.shadowColor = css(resolveColor(ctx.model.swatches, sh.color, -1) ?? [0, 0, 0], sh.opacity);
  cx.shadowBlur = blur * res;
  cx.shadowOffsetX = off.x * res + far;
  cx.shadowOffsetY = off.y * res;
  cx.fillStyle = '#000';
  cx.fill(outlinePath(it), 'evenodd');
  ctx.notes.add('Drop shadows are pictures in the PDF.');
  // Back from the page to item space, where the picture is placed.
  const toItem = mul(invert(st.ctm), [1, 0, 0, -1, 0, ctx.pageH]);
  ctx.c.op(`q\n${matOps(toItem)}`);
  placeImage(ctx, canvasImage(ctx, cv), b);
  ctx.c.op('Q');
}

// ---- Text -----------------------------------------------------------------------------------

async function drawPiece(ctx: Ctx, text: string, x0: number, y: number, look: Look) {
  const sw = ctx.model.swatches;
  const fill = swatchColor(sw, look.fill, look.fillTint);
  const stroke = look.stroke ? swatchColor(sw, look.stroke, look.strokeTint) : null;
  if (!fill && !stroke) return;
  const chars = [...text];
  // Where the canvas put each character: advances measured as it measured them, kerning and tracking included.
  const xs: number[] = [0];
  for (let k = 1; k <= chars.length; k++) xs.push(measure(look, chars.slice(0, k).join('')));
  const picks: (EmbeddedFont | null)[] = [];
  for (const ch of chars) picks.push(await ctx.fonts.pick(look.font, ch));
  const hs = look.hscale || 1;
  const vs = look.vscale || 1;
  const skew = look.skew ? Math.tan((look.skew * Math.PI) / 180) : 0;
  const c = ctx.c;
  for (let i = 0; i < chars.length; ) {
    const font = picks[i];
    let j = i + 1;
    while (j < chars.length && picks[j] === font) j++;
    if (font) {
      const name = ctx.fonts.name(font);
      c.res.Font.set(name, font.ref);
      const mode = fill && stroke ? 2 : stroke ? 1 : 0;
      const ops = ['BT'];
      if (fill) ops.push(c.color(fill, false));
      if (stroke) ops.push(c.color(stroke, true), `${fmt(look.strokeWeight)} w 0 J 0 j [] 0 d`);
      ops.push(`${mode} Tr /${name} ${fmt(look.size)} Tf ${fmt(hs * 100)} Tz 0 Tc 0 Tw`);
      ops.push(`1 0 ${fmt(skew * vs)} ${fmt(-vs)} ${fmt(x0 + xs[i])} ${fmt(y)} Tm`);
      const parts: string[] = [];
      let run: number[] = [];
      let pen = 0;
      const em = look.size * hs;
      for (let k = i; k < j; k++) {
        const gid = font.glyph(chars[k]);
        const at = xs[k] - xs[i];
        const adj = ((at - pen) * 1000) / (em || 1);
        if (Math.abs(adj) > 0.05) {
          if (run.length) parts.push(hexString(run));
          run = [];
          parts.push(fmt(-adj));
        }
        run.push(gid >> 8, gid & 255);
        pen = at + (font.width(gid) / 1000) * em;
      }
      if (run.length) parts.push(hexString(run));
      ops.push(`[${parts.join(' ')}] TJ`, 'ET');
      c.op(ops.join('\n'));
    } else {
      const s = chars.slice(i, j).join('');
      if (s.trim()) rasterRun(ctx, s, x0 + xs[i], y, look, skew);
    }
    i = j;
  }
}

/** Characters no bundled font has, drawn by the canvas (with whatever font it found) as a picture. */
function rasterRun(ctx: Ctx, s: string, x: number, y: number, look: Look, skew: number) {
  const fill = look.fill ? resolveColor(ctx.model.swatches, look.fill, look.fillTint) : null;
  const stroke = look.stroke ? screenRgb(ctx, look.stroke, look.strokeTint) : null;
  const key = JSON.stringify([s, look.font, look.size, look.hscale, look.vscale, look.tracking, look.strokeWeight, fill, stroke]);
  let hit = ctx.rasterRefs.get(key);
  if (hit === undefined) {
    const k = look.size / 100;
    const hs = look.hscale || 1;
    const vs = look.vscale || 1;
    const pad = look.size * 0.3;
    const asc = look.size * 1.2 * vs;
    const box = { x: -pad, y: -asc, w: measure(look, s) + pad * 2, h: asc + look.size * 0.5 * vs };
    const res = 600 / 72;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(box.w * res));
    cv.height = Math.max(1, Math.ceil(box.h * res));
    const cx = cv.getContext('2d')!;
    cx.setTransform(res * k * hs, 0, 0, res * k * vs, pad * res, asc * res);
    cx.font = look.font;
    cx.fontKerning = 'normal';
    cx.letterSpacing = `${(look.tracking * 100) / hs}px`;
    cx.textBaseline = 'alphabetic';
    if (fill) {
      cx.fillStyle = css(fill);
      cx.fillText(s, 0, 0);
    }
    if (stroke) {
      cx.strokeStyle = css(stroke);
      cx.lineWidth = look.strokeWeight / (k || 1);
      cx.strokeText(s, 0, 0);
    }
    const ref = canvasImage(ctx, cv);
    hit = ref ? { ref, box } : null;
    ctx.rasterRefs.set(key, hit);
  }
  if (!hit) return;
  ctx.notes.add('Characters none of the bundled fonts has are pictures in the PDF.');
  ctx.c.op(`q\n${matOps([1, 0, -skew, 1, x, y])}`);
  placeImage(ctx, hit.ref, hit.box);
  ctx.c.op('Q');
}

function fillRect(ctx: Ctx, color: Color | null, r: Rect) {
  if (!color || !(r.w > 0) || !(r.h > 0)) return;
  ctx.c.op(`${ctx.c.color(color, false)}\n${rectOps(r)}\nf`);
}

function drawRule(ctx: Ctx, r: Line['ruleAbove']) {
  if (!r) return;
  fillRect(ctx, swatchColor(ctx.model.swatches, r.color, r.tint), { x: r.x0, y: r.y - r.weight / 2, w: r.x1 - r.x0, h: r.weight });
}

async function drawText(ctx: Ctx, comp: Composition, frame: number) {
  const lines = comp.byFrame[frame];
  if (!lines?.length) return;
  const sw = ctx.model.swatches;
  for (const l of lines) {
    if (l.shading) fillRect(ctx, swatchColor(sw, l.shading.color, l.shading.tint), { x: l.shading.x0, y: l.shading.y0, w: l.shading.x1 - l.shading.x0, h: l.shading.y1 - l.shading.y0 });
    drawRule(ctx, l.ruleAbove);
    drawRule(ctx, l.ruleBelow);
    for (const p of l.pieces) {
      if (p.table) {
        await drawTable(ctx, p.table, p.x, l.y - p.table.h);
        continue;
      }
      if (!p.text) continue;
      const look = p.look;
      const y = l.y - look.shift;
      await drawPiece(ctx, p.text, p.x, y, look);
      if (look.underline || look.strike) {
        const color = swatchColor(sw, look.fill, look.fillTint) ?? (look.stroke ? swatchColor(sw, look.stroke, look.strokeTint) : null) ?? { space: 'gray', c: [0] };
        const t = Math.max(0.25, look.size * 0.05);
        if (look.underline) fillRect(ctx, color, { x: p.x, y: y + look.size * 0.1, w: p.w, h: t });
        if (look.strike) fillRect(ctx, color, { x: p.x, y: y - look.size * 0.28, w: p.w, h: t });
      }
    }
  }
}

async function drawTable(ctx: Ctx, t: TableLayout, x: number, y: number) {
  const sw = ctx.model.swatches;
  for (const cell of t.cells) fillRect(ctx, swatchColor(sw, cell.fill, cell.fillTint), { x: x + cell.x, y: y + cell.y, w: cell.w, h: cell.h });
  for (const cell of t.cells) {
    ctx.c.op(`q\n${matOps([1, 0, 0, 1, x + cell.x + cell.tx, y + cell.y + cell.ty])}`);
    await drawText(ctx, cell.comp, 0);
    ctx.c.op('Q');
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
      const col = e.weight > 0 ? swatchColor(sw, e.color, e.tint) : null;
      if (!col) return;
      const [a, b, c2, d] = lines[i];
      ctx.c.op(`${ctx.c.color(col, true)}\n${fmt(e.weight)} w 0 J 0 j [] 0 d\n${fmt(a)} ${fmt(b)} m ${fmt(c2)} ${fmt(d)} l S`);
    });
  }
}

// ---- Items ----------------------------------------------------------------------------------

async function drawItem(ctx: Ctx, it: Item, local: Mat, parent: State, page: Page | null) {
  if (!it.visible) return;
  const c = ctx.c;
  const sw = ctx.model.swatches;
  const st: State = {
    ctm: mul(parent.ctm, local),
    alpha: parent.alpha * (it.opacity < 1 ? it.opacity : 1),
    blend: BLENDS[it.blend] ? it.blend : parent.blend,
  };
  c.op(`q\n${matOps(local)}`);
  if (st.alpha !== parent.alpha || st.blend !== parent.blend) c.op(`/${c.gstate(st.alpha, st.alpha, st.blend ?? 'Normal')} gs`);
  if (it.kind === 'group') {
    for (const ch of it.children) await drawItem(ctx, ch, ch.local, st, page);
    c.op('Q');
    return;
  }
  if (it.kind === 'graphic') {
    drawGraphic(ctx, it);
    c.op('Q');
    return;
  }
  const path = traceOutline(new PdfPath(), it).toString();
  const fillGrad = gradientSpec(sw, it, it.fill);
  const fill = fillGrad ? null : it.kind === 'line' ? null : swatchColor(sw, it.fill, it.fillTint);
  if (path && (fillGrad || fill)) {
    if (it.shadow) drawShadow(ctx, it, st);
    c.op(`${fillGrad ? gradientOps(ctx, fillGrad, st, false) : c.color(fill!, false)}\n${path}\nf*`);
  }
  // Contents: placed graphics and pasted-in frames, clipped to the frame.
  if (it.children.length && path) {
    c.op(`q\n${path}\nW* n`);
    for (const ch of it.children) await drawItem(ctx, ch, ch.local, st, page);
    c.op('Q');
  }
  if (it.kind === 'text' && it.text) {
    const comp = ctx.text.comp(it.text.story, page);
    if (comp) await drawText(ctx, comp, ctx.text.frameIndex(it));
  }
  const strokeGrad = it.strokeWeight > 0 ? gradientSpec(sw, it, it.stroke) : null;
  const stroke = it.strokeWeight > 0 && !strokeGrad ? swatchColor(sw, it.stroke, it.strokeTint) : null;
  if (path && (strokeGrad || stroke)) {
    const w = it.strokeWeight;
    const join = it.join === 'RoundEndJoin' ? 1 : it.join === 'BevelEndJoin' ? 2 : 0;
    let cap = it.cap === 'RoundEndCap' ? 1 : it.cap === 'ProjectingEndCap' ? 2 : 0;
    const dash = dashFor(it.strokeType, w);
    if (dash.length && dash[0] < 0.01) cap = 1;
    const paint = strokeGrad ? gradientOps(ctx, strokeGrad, st, true) : c.color(stroke!, true);
    const dashOps = dash.length ? `[${dash.map((d) => fmt(d < 0.01 ? 0 : d)).join(' ')}] 0 d` : '[] 0 d';
    const state = (width: number, d: string) => `${fmt(width)} w ${cap} J ${join} j 10 M ${d}`;
    const closed = it.paths.every((p) => !p.open) && it.kind !== 'line';
    if (closed && it.strokeAlign === 'InsideAlignment') {
      c.op(`q\n${path}\nW* n\n${paint}\n${state(w * 2, dashOps)}\n${path}\nS\nQ`);
    } else if (closed && it.strokeAlign === 'OutsideAlignment') {
      const b = it.box;
      const pad = w * 4 + 10;
      c.op(`q\n${rectOps({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })}\n${path}\nW* n\n${paint}\n${state(w * 2, dashOps)}\n${path}\nS\nQ`);
    } else {
      const gap = it.gap && dash.length ? swatchColor(sw, it.gap, -1) : null;
      if (gap) c.op(`${c.color(gap, true)}\n${state(w, '[] 0 d')}\n${path}\nS`);
      c.op(`${paint}\n${state(w, dashOps)}\n${path}\nS`);
    }
  }
  c.op('Q');
}

async function drawMasterItems(ctx: Ctx, master: Spread, mp: Page, m: Mat, layers: LayerInfo[], docPage: Page, st: State) {
  for (const layer of layers) {
    for (const it of master.items) {
      if (it.layer !== layer.self || docPage.overrides.has(it.self) || it.nonprinting) continue;
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
      await drawItem(ctx, it, mul(m, it.m), st, docPage);
    }
  }
}

async function drawMaster(ctx: Ctx, s: Spread, page: Page, layers: LayerInfo[], st: State) {
  const { model } = ctx;
  if (!page.master || !s.showMasterItems) return;
  const master = model.masters.find((m) => m.self === page.master);
  if (!master) return;
  const mp = masterPageFor(master, page);
  if (!mp) return;
  const t = masterToPage(page, mp);
  // A master based on another master shows that one's items first.
  if (mp.master) {
    const parent = model.masters.find((m) => m.self === mp.master);
    const pmp = parent ? masterPageFor(parent, mp) : null;
    if (parent && pmp) await drawMasterItems(ctx, parent, pmp, mul(t, masterToPage(mp, pmp)), layers, page, st);
  }
  await drawMasterItems(ctx, master, mp, t, layers, page, st);
}

/** How far past its box an item can draw: strokes, shadows, a little type hanging out. */
function reach(it: Item): Rect {
  const b = transformRect(it.m, it.box);
  const pad = it.strokeWeight * 2 + (it.shadow ? Math.abs(it.shadow.x) + Math.abs(it.shadow.y) + it.shadow.blur * 2 : 0) + (it.kind === 'text' ? 24 : 2);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

// ---- The document ---------------------------------------------------------------------------

export interface PdfExport {
  model: Model;
  images: ImageStore;
  text: TextSource;
  title: string;
}

/** Ask for every placed picture, so they've all loaded before the pages are written. */
export async function loadPictures(model: Model, images: ImageStore) {
  const visit = (items: Item[]) => {
    for (const it of items) {
      if (it.kind === 'graphic' && it.graphic) {
        const doc = model.pkg.xml.get(it.part);
        images.get(it.self, doc ? findEl(doc, it.self) : null, it.graphic.link);
      }
      visit(it.children);
    }
  };
  for (const s of [...model.masters, ...model.spreads]) visit(s.items);
  await images.settled();
}

export async function writePublisherPdf(o: PdfExport): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const { model } = o;
  const w = new PdfWriter();
  const notes = new Set<string>();
  const fonts = new WebFonts(w, notes);
  await loadPictures(model, o.images);
  const catalog = w.add(null);
  const pagesRef = w.add(null);
  const pageRefs: PdfRef[] = [];
  const labels: PdfValue[] = [];
  const imageRefs = new Map<ImageEntry, PdfRef | null>();
  const rasterRefs = new Map<string, { ref: PdfRef; box: Rect } | null>();
  // Layers bottom to top, as the page shows them; layers set not to print stay out.
  const layers = model.layers.filter((l) => l.visible && l.printable).reverse();
  for (const s of model.spreads) {
    for (const p of s.pages) {
      const c = new PdfContent(w);
      const ctx: Ctx = { model, w, c, images: o.images, text: o.text, fonts, notes, imageRefs, rasterRefs, pageH: p.bounds.h };
      // Spread coordinates (y down) to the page (y up).
      const base: Mat = [1, 0, 0, -1, -p.bounds.x, p.bounds.y + p.bounds.h];
      c.op(matOps(base));
      const st: State = { ctm: base, alpha: 1, blend: null };
      await drawMaster(ctx, s, p, layers, st);
      for (const layer of layers) {
        for (const it of s.items) {
          if (it.layer !== layer.self || it.nonprinting || !intersects(reach(it), p.bounds)) continue;
          await drawItem(ctx, it, it.m, st, pageOfItem(s, it));
        }
      }
      const content = w.stream(new Map(), new TextEncoder().encode(c.ops.join('\n')));
      const box = [0, 0, p.bounds.w, p.bounds.h];
      labels.push(pageRefs.length, new Map<string, PdfValue>([['P', pdfText(p.name)]]));
      pageRefs.push(
        w.add(
          new Map<string, PdfValue>([
            ['Type', N('Page')],
            ['Parent', pagesRef],
            ['MediaBox', box],
            ['TrimBox', box],
            ['Resources', c.resourceDict()],
            ['Contents', content],
          ]),
        ),
      );
    }
  }
  await fonts.finish();
  w.set(
    pagesRef,
    new Map<string, PdfValue>([
      ['Type', N('Pages')],
      ['Kids', pageRefs],
      ['Count', pageRefs.length],
    ]),
  );
  w.set(
    catalog,
    new Map<string, PdfValue>([
      ['Type', N('Catalog')],
      ['Pages', pagesRef],
      ['PageLabels', new Map<string, PdfValue>([['Nums', labels]])],
    ]),
  );
  const date = pdfDate();
  const info = w.add(
    new Map<string, PdfValue>([
      ['Title', pdfText(o.title)],
      ['Creator', pdfText('Din Publisher')],
      ['Producer', pdfText('Din Publisher')],
      ['CreationDate', pdfText(date)],
      ['ModDate', pdfText(date)],
    ]),
  );
  const bytes = w.bytes(
    new Map<string, PdfValue>([
      ['Root', catalog],
      ['Info', info],
    ]),
  );
  return { bytes, notes: [...notes] };
}
