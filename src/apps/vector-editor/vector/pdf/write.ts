import { visualBounds } from '../geom';
import {
  intersects,
  mul,
  type Artboard,
  type Doc,
  type FontEntry,
  type Gradient,
  type GroupItem,
  type ImageItem,
  type Item,
  type Layer,
  type Paint,
  type PathItem,
  type Stroke,
  type SubPath,
  type TextItem,
  type TextRun,
} from '../model';
import { cssAdvanceOf, embeddedFor, layoutText, type LaidGlyph } from '../text';
import { toRgb, type Color } from '@/shared/pdf/color';
import { winAnsiCode } from '@/shared/pdf/encodings';
import { PdfRef, type PdfDict, type PdfValue } from '@/shared/pdf/objects';
import { fmt, hexString, imageXObject, matOps, N, PdfContent, pdfDate, pdfText, PdfWriter, splitRgba } from '@/shared/pdf/writer';

/**
 * Write a document as a PDF — which is also what a PDF-compatible
 * Illustrator file is, minus Illustrator's private editing data. That data
 * is undocumented, so like other apps that save .ai files this writes the
 * PDF part alone; Illustrator opens it as it opens any PDF, art and all.
 * Each artboard is a page; layers are optional content, so they come back
 * as layers here and show as layers in Acrobat.
 */


// ---- Fonts for type the file's fonts can't set -----------------------------------------------

const STANDARD: [RegExp, string, string, string, string][] = [
  [/courier|cousine|mono/i, 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  [/times|tinos|serif|minion|georgia|garamond/i, 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  [/arial|helvetica|arimo|liberation sans/i, 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
];

interface WriteFont {
  name: string;
  ref: PdfRef;
  /** Code → width in thousandths of an em, as the font declares it. */
  width(code: number): number;
  /** Text to codes. */
  encode(ch: string): { code: number; bytes: number } | null;
}

// ---- Page content -----------------------------------------------------------------------------

class Page extends PdfContent {
  constructor(
    w: PdfWriter,
    readonly ctx: WriteContext,
  ) {
    super(w);
  }

  /** A graphics state for an item's opacity and (CSS) blend mode. */
  blendState(opacity: number, blend: string): string {
    return this.gstate(opacity, opacity, BLEND_NAMES[blend] ?? 'Normal');
  }
}

const BLEND_NAMES: Record<string, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight',
  difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

interface WriteContext {
  doc: Doc;
  w: PdfWriter;
  images: Map<string, PdfRef>;
  fonts: Map<string, WriteFont>;
  notes: Set<string>;
}

function colorOps(page: Page, c: Color, stroke: boolean): string {
  return page.color(c, stroke);
}

function pathOps(paths: SubPath[]): string {
  const out: string[] = [];
  for (const sp of paths) {
    const ns = sp.nodes;
    if (!ns.length) continue;
    out.push(`${fmt(ns[0].x)} ${fmt(ns[0].y)} m`);
    const n = ns.length;
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = ns[i];
      const b = ns[(i + 1) % n];
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) out.push(`${fmt(b.x)} ${fmt(b.y)} l`);
      else out.push(`${fmt(a.ox)} ${fmt(a.oy)} ${fmt(b.ix)} ${fmt(b.iy)} ${fmt(b.x)} ${fmt(b.y)} c`);
    }
    if (sp.closed) out.push('h');
  }
  return out.join('\n');
}

/** A shading for a gradient in gradient space (drawn after `cm` by its matrix). */
function shading(page: Page, g: Gradient): string {
  const stops = [...g.stops].sort((a, b) => a.t - b.t);
  const space = stops.every((s) => s.color.space === 'cmyk') ? 'cmyk' : stops.every((s) => s.color.space === 'gray') ? 'gray' : 'rgb';
  const comps = (c: Color) => (space === 'rgb' ? toRgb(c) : c.c);
  const fns: PdfDict[] = [];
  const bounds: number[] = [];
  const encode: number[] = [];
  // Ramps between stops, with midpoints as exponents the way Illustrator writes them.
  const ext = stops.length === 1 ? [stops[0], stops[0]] : stops;
  for (let i = 0; i + 1 < ext.length; i++) {
    const a = ext[i];
    const b = ext[i + 1];
    const mid = a.mid ?? 0.5;
    const nExp = mid > 0 && mid < 1 ? Math.log(0.5) / Math.log(mid) : 1;
    fns.push(
      new Map<string, PdfValue>([
        ['FunctionType', 2],
        ['Domain', [0, 1]],
        ['C0', comps(a.color)],
        ['C1', comps(b.color)],
        ['N', Math.abs(nExp - 1) < 1e-3 ? 1 : nExp],
      ]),
    );
    if (i > 0) bounds.push(Math.min(1, Math.max(0, a.t)));
    encode.push(0, 1);
  }
  const t0 = Math.min(1, Math.max(0, ext[0].t));
  const t1 = Math.min(1, Math.max(0, ext[ext.length - 1].t));
  const fn: PdfDict =
    fns.length === 1 && t0 === 0 && t1 === 1
      ? fns[0]
      : new Map<string, PdfValue>([
          ['FunctionType', 3],
          ['Domain', [t0, t1 > t0 ? t1 : t0 + 1e-4]],
          ['Functions', fns],
          ['Bounds', bounds],
          ['Encode', encode],
        ]);
  const f = g.focal ?? { x: 0, y: 0, r: 0 };
  const d: PdfDict = new Map<string, PdfValue>([
    ['ShadingType', g.type === 'linear' ? 2 : 3],
    ['ColorSpace', N(space === 'cmyk' ? 'DeviceCMYK' : space === 'gray' ? 'DeviceGray' : 'DeviceRGB')],
    ['Coords', g.type === 'linear' ? [t0, 0, t1, 0] : [f.x, f.y, Math.max(0, f.r), 0, 0, 1]],
    ['Domain', [t0, t1 > t0 ? t1 : t0 + 1e-4]],
    ['Function', fn],
    ['Extend', [true, true]],
  ]);
  const name = `Sh${page.res.Shading.size}`;
  page.res.Shading.set(name, page.w.add(d));
  if (g.stops.some((s) => s.opacity < 1)) page.ctx.notes.add('Gradient stops’ opacity is saved as solid.');
  return name;
}

function paintOps(page: Page, paint: Paint, stroke: boolean): string | null {
  if (paint.type === 'color') return colorOps(page, paint.color, stroke);
  if (paint.type === 'gradient') {
    // Strokes can't take a gradient in PDF without outlining; they take its middle color.
    const stops = paint.gradient.stops;
    return colorOps(page, stops[Math.floor(stops.length / 2)]?.color ?? { space: 'gray', c: [0] }, stroke);
  }
  return null;
}

function strokeStateOps(s: Stroke): string {
  const dash = s.dash.length && s.dash.some((d) => d > 0) ? `[${s.dash.map(fmt).join(' ')}] ${fmt(s.dashOffset)} d` : '[] 0 d';
  return `${fmt(s.width)} w ${s.cap} J ${s.join} j ${fmt(s.miter)} M ${dash}`;
}

function writePath(page: Page, it: PathItem) {
  const fill = it.fill.type !== 'none';
  const stroke = it.stroke.paint.type !== 'none' && it.stroke.width > 0;
  if (!fill && !stroke) return;
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.blendState(it.opacity, it.blend)} gs`);
  const geometry = pathOps(it.paths);
  if (it.fill.type === 'gradient') {
    const sh = shading(page, it.fill.gradient);
    page.op(`q\n${geometry}\nW${it.evenOdd ? '*' : ''} n\n${matOps(it.fill.gradient.matrix)}\n/${sh} sh\nQ`);
  } else if (fill) {
    page.op(paintOps(page, it.fill, false)!);
    page.op(`${geometry}\nf${it.evenOdd ? '*' : ''}`);
  }
  if (stroke) {
    page.op(paintOps(page, it.stroke.paint, true)!);
    page.op(strokeStateOps(it.stroke));
    page.op(`${geometry}\nS`);
  }
  page.op('Q');
}

function writeImage(page: Page, it: ImageItem) {
  const ctx = page.ctx;
  let ref: PdfRef | null | undefined = ctx.images.get(it.image);
  const img = ctx.doc.res.images.get(it.image);
  if (!img) return;
  if (!ref) {
    if (img.jpeg || img.rgb) ref = imageXObject(page.w, img);
    else if (img.bitmap) {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext('2d')!;
      cx.drawImage(img.bitmap, 0, 0);
      const px = splitRgba(cx.getImageData(0, 0, img.width, img.height).data, img.width * img.height);
      ref = imageXObject(page.w, { width: img.width, height: img.height, rgb: px.rgb, alpha: img.alpha ?? px.alpha });
    } else ref = imageXObject(page.w, img);
    if (!ref) return;
    ctx.images.set(it.image, ref);
  }
  const name = `Im${[...ctx.images.keys()].indexOf(it.image)}`;
  page.res.XObject.set(name, ref);
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.blendState(it.opacity, it.blend)} gs`);
  page.op(matOps(mul([1, 0, 0, -1, 0, 1], it.matrix)));
  page.op(`/${name} Do\nQ`);
}

/** A font for type the file's own fonts can't set: a standard one, or one named for the system to supply. */
function substituteFont(ctx: WriteContext, run: TextRun): WriteFont {
  const bold = /bold|black|heavy|semibold/i.test(run.font.style);
  const italic = /italic|oblique/i.test(run.font.style);
  const std = STANDARD.find(([re]) => re.test(run.font.family) || re.test(run.font.postscript));
  const baseName: string = std ? (std[1 + (bold ? 1 : 0) + (italic ? 2 : 0)] as string) : run.font.postscript.replace(/^[A-Z]{6}\+/, '') || run.font.family.replace(/\s+/g, '');
  const key = `sub:${baseName}`;
  const hit = ctx.fonts.get(key);
  if (hit) return hit;
  const widths: number[] = [];
  for (let c = 32; c < 256; c++) {
    const name = String.fromCharCode(c === 0x80 ? 0x20ac : c);
    widths.push(Math.round(cssAdvanceOf(run, name) * 1000));
  }
  const d: PdfDict = new Map<string, PdfValue>([
    ['Type', N('Font')],
    ['Subtype', N(std ? 'Type1' : 'TrueType')],
    ['BaseFont', N(baseName)],
    ['Encoding', N('WinAnsiEncoding')],
  ]);
  if (!std) {
    d.set('FirstChar', 32);
    d.set('LastChar', 255);
    d.set('Widths', widths);
    d.set(
      'FontDescriptor',
      ctx.w.add(
        new Map<string, PdfValue>([
          ['Type', N('FontDescriptor')],
          ['FontName', N(baseName)],
          ['Flags', (/serif|times|minion|georgia|garamond/i.test(run.font.family) ? 2 : 0) | 32 | (italic ? 64 : 0)],
          ['FontBBox', [-200, -250, 1200, 950]],
          ['ItalicAngle', italic ? -12 : 0],
          ['Ascent', 900],
          ['Descent', -250],
          ['CapHeight', 700],
          ['StemV', bold ? 140 : 80],
        ]),
      ),
    );
  }
  const ref = ctx.w.add(d);
  const f: WriteFont = {
    name: `F${ctx.fonts.size}`,
    ref,
    width: (code) => (std ? Math.round(cssAdvanceOf(run, String.fromCharCode(code === 0x80 ? 0x20ac : code)) * 1000) : (widths[code - 32] ?? 500)),
    encode: (ch) => {
      const c = winAnsiCode(ch);
      return c === null ? null : { code: c, bytes: 1 };
    },
  };
  ctx.fonts.set(key, f);
  return f;
}

function fileFont(ctx: WriteContext, entry: FontEntry): WriteFont | null {
  if (!entry.source) return null;
  const key = `file:${entry.key}`;
  const hit = ctx.fonts.get(key);
  if (hit) return hit;
  const v = ctx.w.import(entry.source.doc, entry.source.value);
  const ref = v instanceof PdfRef ? v : ctx.w.add(v);
  const f: WriteFont = {
    name: `F${ctx.fonts.size}`,
    ref,
    width: (code) => entry.width(code),
    encode: (ch) => {
      const e = entry.encode(ch);
      return e && e.length === 1 ? e[0] : null;
    },
  };
  ctx.fonts.set(key, f);
  return f;
}

function codeBytes(code: number, bytes: number): number[] {
  return bytes === 2 ? [code >> 8, code & 255] : [code & 255];
}

function writeText(page: Page, it: TextItem) {
  const ctx = page.ctx;
  const res = ctx.doc.res;
  const layout = layoutText(it, res);
  const placedFont = it.placed && it.placed.text === it.runs.map((r) => r.text).join('') ? res.fonts.get(it.placed.font) : null;
  page.op('q');
  if (it.opacity < 1 || it.blend !== 'normal') page.op(`/${page.blendState(it.opacity, it.blend)} gs`);
  for (const line of layout.lines) {
    // Runs of glyphs set in one font and style.
    let seg: { font: WriteFont; run: TextRun; hs: number; glyphs: { g: LaidGlyph; code: number; bytes: number }[] } | null = null;
    const flush = () => {
      if (!seg || !seg.glyphs.length) return;
      const { font, run, hs, glyphs } = seg;
      page.res.Font.set(font.name, font.ref);
      const render = run.fill.type !== 'none' && run.stroke.paint.type !== 'none' ? 2 : run.stroke.paint.type !== 'none' ? 1 : run.fill.type !== 'none' ? 0 : 3;
      page.op('BT');
      if (run.fill.type !== 'none') page.op(paintOps(page, run.fill, false)!);
      if (render === 1 || render === 2) {
        page.op(paintOps(page, run.stroke.paint, true)!);
        page.op(strokeStateOps(run.stroke));
      }
      page.op(`${render} Tr /${font.name} ${fmt(run.size)} Tf ${fmt(hs * 100)} Tz 0 Tc 0 Tw`);
      const first = glyphs[0].g;
      page.op(`${matOps(mul([1, 0, 0, -1, first.x, line.y], it.matrix)).replace(/cm$/, 'Tm')}`);
      const parts: string[] = [];
      let bytes: number[] = [];
      let x = first.x;
      for (const { g, code, bytes: nb } of glyphs) {
        const adj = ((g.x - x) * 1000) / (run.size * hs);
        if (Math.abs(adj) > 0.5) {
          if (bytes.length) parts.push(hexString(Uint8Array.from(bytes)));
          bytes = [];
          parts.push(fmt(-adj));
        }
        bytes.push(...codeBytes(code, nb));
        x = g.x + (font.width(code) / 1000) * run.size * hs;
      }
      if (bytes.length) parts.push(hexString(Uint8Array.from(bytes)));
      page.op(`[${parts.join(' ')}] TJ\nET`);
      seg = null;
    };
    for (const g of line.glyphs) {
      if (g.ch === '\n' || g.ch === '\r') continue;
      const run = it.runs[g.run];
      if (!run) continue;
      let font: WriteFont | null = null;
      let code: { code: number; bytes: number } | null = null;
      let hs = run.hscale;
      if (placedFont && g.code !== undefined) {
        font = fileFont(ctx, placedFont);
        code = { code: g.code, bytes: placedFont.bytes };
        hs = it.placed!.hscale;
      } else if (placedFont && g.ch === ' ') continue;
      else {
        const emb = embeddedFor(res, run);
        if (emb && g.code !== undefined) {
          font = fileFont(ctx, emb);
          code = { code: g.code, bytes: emb.bytes };
        }
      }
      if (!font || !code) {
        font = substituteFont(ctx, run);
        code = font.encode(g.ch);
        if (!code) {
          ctx.notes.add('Characters outside Western European type are saved as “?”.');
          code = { code: 63, bytes: 1 };
        }
      }
      if (!seg || seg.font !== font || seg.run !== run) {
        flush();
        seg = { font, run, hs, glyphs: [] };
      }
      seg.glyphs.push({ g, code: code.code, bytes: code.bytes });
    }
    flush();
  }
  page.op('Q');
}

function writeGroup(page: Page, it: GroupItem) {
  const kids = it.clip ? it.children.slice(1) : it.children;
  const clip = it.clip && it.children[0]?.type === 'path' ? (it.children[0] as PathItem) : null;
  const isolated = it.opacity < 1 || it.blend !== 'normal';
  page.op('q');
  if (clip) page.op(`${pathOps(clip.paths)}\nW${clip.evenOdd ? '*' : ''} n`);
  if (isolated) {
    // A transparency group, so the group fades as one.
    const sub = new Page(page.w, page.ctx);
    for (const k of kids) writeItem(sub, k);
    const b = visualBounds(it, page.ctx.doc.res);
    const form: PdfDict = new Map<string, PdfValue>([
      ['Type', N('XObject')],
      ['Subtype', N('Form')],
      ['BBox', [b.x - 1, b.y - 1, b.x + b.w + 1, b.y + b.h + 1]],
      ['Group', new Map<string, PdfValue>([['S', N('Transparency')]])],
      ['Resources', sub.resourceDict()],
    ]);
    const ref = page.w.stream(form, new TextEncoder().encode(sub.ops.join('\n')));
    const name = `Fm${page.res.XObject.size}`;
    page.res.XObject.set(name, ref);
    page.op(`/${page.blendState(it.opacity, it.blend)} gs\n/${name} Do`);
  } else for (const k of kids) writeItem(page, k);
  page.op('Q');
}

function writeItem(page: Page, it: Item) {
  if (it.hidden) return;
  if (it.type === 'path') writePath(page, it);
  else if (it.type === 'image') writeImage(page, it);
  else if (it.type === 'text') writeText(page, it);
  else writeGroup(page, it);
}

export interface WriteOptions {
  title: string;
  /** Only these artboards (indexes); all by default. */
  artboards?: number[];
}

/** The document as PDF bytes, with notes on what didn't carry over exactly. */
export function writePdf(doc: Doc, opts: WriteOptions): { bytes: Uint8Array; notes: string[] } {
  const w = new PdfWriter();
  const ctx: WriteContext = { doc, w, images: new Map(), fonts: new Map(), notes: new Set() };
  const catalog = w.add(null);
  const pagesRef = w.add(null);
  const ocgs = new Map<Layer, PdfRef>();
  for (const l of doc.layers) {
    ocgs.set(
      l,
      w.add(
        new Map<string, PdfValue>([
          ['Type', N('OCG')],
          ['Name', pdfText(l.name)],
          [
            'Usage',
            new Map<string, PdfValue>([
              ['CreatorInfo', new Map<string, PdfValue>([['Creator', pdfText('Din Vector Editor')], ['Subtype', N('Artwork')]])],
            ]),
          ],
        ]),
      ),
    );
  }
  const pageRefs: PdfRef[] = [];
  const boards: Artboard[] = (opts.artboards ?? doc.artboards.map((_, i) => i)).map((i) => doc.artboards[i]).filter(Boolean);
  // Art on more than one artboard is drawn on each page; an id lets this app open it once.
  const pagesOf = new Map<number, number>();
  for (const ab of boards) for (const l of doc.layers) for (const it of l.children) if (!it.hidden && intersects(visualBounds(it, doc.res), ab)) pagesOf.set(it.id, (pagesOf.get(it.id) ?? 0) + 1);
  for (const ab of boards) {
    const page = new Page(w, ctx);
    // Document space (y down) to the page (y up).
    page.op(matOps([1, 0, 0, -1, -ab.x, ab.y + ab.h]));
    const area = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
    doc.layers.forEach((layer, li) => {
      const items = layer.children.filter((it) => !it.hidden && intersects(visualBounds(it, doc.res), area));
      if (!items.length) return;
      const mc = `MC${li}`;
      page.res.Properties.set(mc, ocgs.get(layer)!);
      page.op(`/OC /${mc} BDC`);
      for (const it of items) {
        const shared = (pagesOf.get(it.id) ?? 0) > 1;
        if (shared) page.op(`/DinObject <</Id ${it.id}>> BDC`);
        writeItem(page, it);
        if (shared) page.op('EMC');
      }
      page.op('EMC');
    });
    const content = w.stream(new Map(), new TextEncoder().encode(page.ops.join('\n')));
    const box = [0, 0, ab.w, ab.h];
    pageRefs.push(
      w.add(
        new Map<string, PdfValue>([
          ['Type', N('Page')],
          ['Parent', pagesRef],
          ['MediaBox', box],
          ['CropBox', box],
          ['TrimBox', box],
          ['ArtBox', box],
          // Where the artboard sits among the others, and its name, for this app to open it as it was.
          ['DinArtboard', new Map<string, PdfValue>([['X', ab.x], ['Y', ab.y], ['Name', pdfText(ab.name)]])],
          ['Resources', page.resourceDict()],
          ['Contents', content],
        ]),
      ),
    );
  }
  w.set(
    pagesRef,
    new Map<string, PdfValue>([
      ['Type', N('Pages')],
      ['Kids', pageRefs],
      ['Count', pageRefs.length],
    ]),
  );
  const order = [...doc.layers].reverse().map((l) => ocgs.get(l)!);
  const off = doc.layers.filter((l) => l.hidden).map((l) => ocgs.get(l)!);
  w.set(
    catalog,
    new Map<string, PdfValue>([
      ['Type', N('Catalog')],
      ['Pages', pagesRef],
      [
        'OCProperties',
        new Map<string, PdfValue>([
          ['OCGs', [...ocgs.values()]],
          [
            'D',
            new Map<string, PdfValue>([
              ['Order', order],
              ['ON', doc.layers.filter((l) => !l.hidden).map((l) => ocgs.get(l)!)],
              ['OFF', off],
              ['RBGroups', []],
            ]),
          ],
        ]),
      ],
    ]),
  );
  const date = pdfDate();
  const info = w.add(
    new Map<string, PdfValue>([
      ['Title', pdfText(opts.title)],
      ['Creator', pdfText('Din Vector Editor')],
      ['Producer', pdfText('Din Vector Editor')],
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
  return { bytes, notes: [...ctx.notes] };
}
