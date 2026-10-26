import {
  AutoStyles,
  collapse,
  contentStyles,
  DRAWABLE_IMAGE,
  FontFaces,
  imageBytes,
  lengthPt,
  lengthPx,
  masterStyles,
  mergeProps,
  nestedList,
  ODF,
  ODF_MIME,
  odfColor,
  OdfDocument,
  OdfMedia,
  odfRoot,
  paragraphText,
  textXml,
  writeOdf,
  type OdfStyles,
  type Props,
} from '../odf';
import { attr, esc, extOfPath, kid, kids, mimeOf, OpcPackage } from '../ooxml';
import { isLineGeom, rememberCustGeom, shapePath } from './geometry';
import {
  newUid,
  type Bullet,
  type Color,
  type Deck,
  type Fill,
  type FrameShape,
  type GroupShape,
  type Layout,
  type Line,
  type Para,
  type ParaProps,
  type PicShape,
  type Placeholder,
  type Run,
  type RunProps,
  type Shape,
  type Slide,
  type SlideCtx,
  type SpShape,
  type Table,
  type TableCell,
  type TextBody,
  type Xfrm,
} from './model';
import { DESIGNS, newPackage } from './newDeck';
import { readDeck } from './read';
import {
  background,
  effectiveXfrm,
  fontName,
  inheritChain,
  layoutCtx,
  resolveColorModel,
  resolvePara,
  resolveRun,
  shapeFill,
  shapeLine,
  slideCtx,
  textChain,
  type Paint,
  type ResolvedPara,
  type Stroke,
  type TextStyleChain,
} from './resolve';
import { cellLook } from './table';

/**
 * OpenDocument presentations (.odp, and flat .fodp), LibreOffice Impress's
 * format. Reading builds a deck on Slides' default master: titles, outlines
 * and subtitles become placeholders, other frames text boxes, pictures and
 * tables, custom shapes their preset geometry, and every position, fill,
 * outline and text property is resolved from ODF's styles and written onto
 * the shapes. Writing resolves what each shape inherits from its layout and
 * master and writes it out as ODF draws it, one master page per layout.
 */

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const EMU = 9525;
const emu = (px: number) => Math.round(px * EMU);
const cmOf = (e: number) => `${Math.round((e / 360000) * 1000) / 1000}cm`;
const ptOf = (n: number) => `${Math.round(n * 100) / 100}pt`;

export interface LoadedOdp {
  pkg: OpcPackage;
  deck: Deck;
  /** What couldn't be brought over, for a message. */
  lost: string[];
}

// ---- Shape names ---------------------------------------------------------------------------------

/** LibreOffice's custom shape types and the presets they are. */
const LO_TYPES: Record<string, string> = {
  rectangle: 'rect',
  'round-rectangle': 'roundRect',
  ellipse: 'ellipse',
  circle: 'ellipse',
  'isosceles-triangle': 'triangle',
  'right-triangle': 'rtTriangle',
  diamond: 'diamond',
  parallelogram: 'parallelogram',
  trapezoid: 'trapezoid',
  pentagon: 'pentagon',
  hexagon: 'hexagon',
  octagon: 'octagon',
  cross: 'plus',
  star4: 'star4',
  star5: 'star5',
  star6: 'star6',
  star8: 'star8',
  star12: 'star12',
  star24: 'star24',
  heart: 'heart',
  smiley: 'smileyFace',
  sun: 'sun',
  moon: 'moon',
  lightning: 'lightningBolt',
  cloud: 'cloud',
  cube: 'cube',
  can: 'can',
  ring: 'donut',
  'block-arc': 'blockArc',
  'right-arrow': 'rightArrow',
  'left-arrow': 'leftArrow',
  'up-arrow': 'upArrow',
  'down-arrow': 'downArrow',
  'left-right-arrow': 'leftRightArrow',
  'up-down-arrow': 'upDownArrow',
  chevron: 'chevron',
  'pentagon-right': 'homePlate',
  'notched-right-arrow': 'notchedRightArrow',
  'striped-right-arrow': 'stripedRightArrow',
  'circular-arrow': 'circularArrow',
  'rectangular-callout': 'wedgeRectCallout',
  'round-rectangular-callout': 'wedgeRoundRectCallout',
  'round-callout': 'wedgeEllipseCallout',
  'cloud-callout': 'cloudCallout',
  'flowchart-process': 'flowChartProcess',
  'flowchart-decision': 'flowChartDecision',
  'flowchart-terminator': 'flowChartTerminator',
  'flowchart-alternate-process': 'flowChartAlternateProcess',
  'flowchart-data': 'flowChartInputOutput',
  'flowchart-document': 'flowChartDocument',
  'flowchart-connector': 'flowChartConnector',
  'flowchart-predefined-process': 'flowChartPredefinedProcess',
  'flowchart-manual-input': 'flowChartManualInput',
  'flowchart-preparation': 'flowChartPreparation',
  'flowchart-off-page-connector': 'flowChartOffpageConnector',
  frame: 'frame',
  'quad-bevel': 'bevel',
  paper: 'foldedCorner',
  'left-bracket': 'leftBracket',
  'right-bracket': 'rightBracket',
  'left-brace': 'leftBrace',
  'right-brace': 'rightBrace',
  'bracket-pair': 'bracketPair',
  'brace-pair': 'bracePair',
  'vertical-scroll': 'verticalScroll',
  'horizontal-scroll': 'horizontalScroll',
};

/** The presets written back under LibreOffice's own names; the rest go as paths. */
const PRESET_TO_LO: Record<string, string> = {};
for (const [lo, prst] of Object.entries(LO_TYPES)) if (!PRESET_TO_LO[prst] && lo !== 'circle') PRESET_TO_LO[prst] = lo;

const NUM_SCHEMES: Record<string, string> = { '1': 'arabic', a: 'alphaLc', A: 'alphaUc', i: 'romanLc', I: 'romanUc' };

// ---- Reading -------------------------------------------------------------------------------------

interface ReadCtx {
  odf: OdfDocument;
  styles: OdfStyles;
  pkg: OpcPackage;
  lost: Set<string>;
  media: Map<string, string>;
  nextId: number;
}

function placement(el: Element): Xfrm {
  const w = lengthPx(attr(el, 'width')) ?? 0;
  const h = lengthPx(attr(el, 'height')) ?? 0;
  let x = lengthPx(attr(el, 'x')) ?? 0;
  let y = lengthPx(attr(el, 'y')) ?? 0;
  let rot = 0;
  const t = attr(el, 'transform');
  if (t) {
    let angle = 0;
    let tx: number | null = null;
    let ty: number | null = null;
    for (const m of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
      const args = m[2].trim().split(/[\s,]+/);
      if (m[1] === 'rotate') angle += Number(args[0]) || 0;
      else if (m[1] === 'translate') {
        tx = (tx ?? 0) + (lengthPx(args[0]) ?? 0);
        ty = (ty ?? 0) + (lengthPx(args[1] ?? '0') ?? 0);
      }
    }
    if (angle) {
      // ODF turns the shape about its top left corner, counterclockwise, then moves it.
      const ox = tx ?? x;
      const oy = ty ?? y;
      const cx = ox + (w / 2) * Math.cos(angle) + (h / 2) * Math.sin(angle);
      const cy = oy - (w / 2) * Math.sin(angle) + (h / 2) * Math.cos(angle);
      x = cx - w / 2;
      y = cy - h / 2;
      rot = (((-angle * 180) / Math.PI) % 360 + 360) % 360;
    } else if (tx !== null && ty !== null) {
      x += tx;
      y += ty;
    }
  }
  const out: Xfrm = { x: emu(x), y: emu(y), w: emu(w), h: emu(h) };
  if (Math.round(rot * 100) / 100 && Math.round(rot) !== 360) out.rot = Math.round(rot * 100) / 100;
  return out;
}

/** A shape's style: its graphic style and presentation style, with the drawing defaults under them. */
function shapeProps(el: Element, styles: OdfStyles): Props {
  let props = styles.resolve('graphic', null);
  const ds = el.getAttributeNS(ODF.draw, 'style-name');
  if (ds) props = mergeProps(props, styles.resolve('graphic', ds));
  const ps = el.getAttributeNS(ODF.presentation, 'style-name');
  if (ps) props = mergeProps(props, styles.resolve('presentation', ps));
  return props;
}

function hexColor(v: string | null | undefined, opacity?: string): Color | undefined {
  const hex = odfColor(v);
  if (!hex) return undefined;
  const pct = opacity ? parseFloat(opacity) : 100;
  return pct < 100 ? { hex, mods: [['alpha', Math.round(pct * 1000)]] } : { hex };
}

function namedEl(ctx: ReadCtx, local: string, name: string | undefined): Element | undefined {
  if (!name) return undefined;
  for (const doc of [ctx.odf.styles, ctx.odf.content]) {
    const hit = kids(kid(doc.documentElement, 'styles'), local).find((e) => attr(e, 'name') === name);
    if (hit) return hit;
  }
  return undefined;
}

function mediaFor(ctx: ReadCtx, image: Element): string | null {
  const pic = imageBytes(ctx.odf, image);
  if (!pic) return null;
  if (!DRAWABLE_IMAGE.test(pic.ext)) {
    ctx.lost.add('pictures in formats that can’t be shown (EMF, WMF, SVM)');
    return null;
  }
  const key = image.getAttributeNS(ODF.xlink, 'href') ?? '';
  const hit = key ? ctx.media.get(key) : undefined;
  if (hit) return hit;
  const path = ctx.pkg.addMedia('ppt/media', pic.data, pic.ext);
  if (key) ctx.media.set(key, path);
  return path;
}

function readFill(g: Record<string, string>, ctx: ReadCtx): Fill | undefined {
  const kind = g.fill;
  if (!kind) return undefined;
  if (kind === 'none') return { type: 'none' };
  if (kind === 'gradient') {
    const grad = namedEl(ctx, 'gradient', g['fill-gradient-name']);
    const start = hexColor(attr(grad, 'start-color')) ?? { hex: '000000' };
    const end = hexColor(attr(grad, 'end-color')) ?? { hex: 'FFFFFF' };
    const rawAngle = attr(grad, 'angle') ?? '0';
    const deg = /deg$/.test(rawAngle) ? parseFloat(rawAngle) : /rad$/.test(rawAngle) ? (parseFloat(rawAngle) * 180) / Math.PI : parseFloat(rawAngle) / 10;
    const style = attr(grad, 'style') ?? 'linear';
    const stops = style === 'axial' ? [{ pos: 0, color: end }, { pos: 0.5, color: start }, { pos: 1, color: end }] : [{ pos: 0, color: start }, { pos: 1, color: end }];
    if (style === 'radial' || style === 'ellipsoid') return { type: 'grad', stops: [{ pos: 0, color: end }, { pos: 1, color: start }], angle: 0, path: 'circle' };
    if (style === 'square' || style === 'rectangular') return { type: 'grad', stops: [{ pos: 0, color: end }, { pos: 1, color: start }], angle: 0, path: 'rect' };
    return { type: 'grad', stops, angle: (((90 - (deg || 0)) % 360) + 360) % 360 };
  }
  if (kind === 'bitmap') {
    const img = namedEl(ctx, 'fill-image', g['fill-image-name']);
    const media = img ? mediaFor(ctx, img) : null;
    if (media) return { type: 'blip', media, tile: g.repeat === 'repeat' };
    return undefined;
  }
  const color = hexColor(g['fill-color'], g.opacity);
  if (kind === 'hatch') {
    const hatch = namedEl(ctx, 'hatch', g['fill-hatch-name']);
    const fg = hexColor(attr(hatch, 'color')) ?? { hex: '000000' };
    return { type: 'patt', fg, bg: g['fill-hatch-solid'] === 'true' && color ? color : { hex: 'FFFFFF' }, prst: 'ltUpDiag' };
  }
  return color ? { type: 'solid', color } : undefined;
}

function readLine(g: Record<string, string>): Line | undefined {
  const stroke = g.stroke;
  if (!stroke) return undefined;
  if (stroke === 'none') return { fill: { type: 'none' } };
  const color = hexColor(g['stroke-color'], g['stroke-opacity']) ?? { hex: '000000' };
  const w = lengthPx(g['stroke-width']);
  const line: Line = { fill: { type: 'solid', color }, w: Math.max(EMU, emu(w ?? 0)) };
  if (stroke === 'dash') line.dash = 'dash';
  if (g['marker-start']) line.head = { type: 'triangle' };
  if (g['marker-end']) line.tail = { type: 'triangle' };
  return line;
}

const ALIGN_IN: Record<string, string> = { start: 'l', left: 'l', center: 'ctr', end: 'r', right: 'r', justify: 'just' };

function runPropsOf(t: Record<string, string> | undefined, styles: OdfStyles, parentPt: number): RunProps {
  const r: RunProps = {};
  if (!t) return r;
  const size = t['font-size'];
  if (size) {
    const pct = /^([\d.]+)%$/.exec(size);
    const v = pct ? (parentPt * parseFloat(pct[1])) / 100 : lengthPt(size);
    if (v) r.sz = Math.round(v * 100);
  }
  const w = t['font-weight'];
  if (w) r.b = w === 'bold' || (/^\d+$/.test(w) && Number(w) >= 600);
  const st = t['font-style'];
  if (st) r.i = st === 'italic' || st === 'oblique';
  const u = t['text-underline-style'];
  if (u) r.u = u === 'none' ? 'none' : t['text-underline-type'] === 'double' ? 'dbl' : 'sng';
  const lt = t['text-line-through-style'];
  if (lt) r.strike = lt === 'none' ? 'noStrike' : 'sngStrike';
  const font = styles.fontOf(t);
  if (font) r.font = font;
  const color = hexColor(t.color);
  if (color) r.color = color;
  const pos = t['text-position']?.split(/\s+/)[0];
  if (pos === 'super') r.baseline = 30000;
  else if (pos === 'sub') r.baseline = -25000;
  else if (pos?.endsWith('%')) {
    const v = parseFloat(pos);
    if (v) r.baseline = Math.round(v * 1000);
  }
  const ls = lengthPt(t['letter-spacing']);
  if (ls) r.spc = Math.round(ls * 100);
  if (t['text-transform'] === 'uppercase') r.cap = 'all';
  else if (t['font-variant'] === 'small-caps') r.cap = 'small';
  const bg = hexColor(t['background-color']);
  if (bg) r.highlight = bg;
  return r;
}

function paraPropsOf(p: Record<string, string> | undefined): ParaProps {
  const out: ParaProps = {};
  if (!p) return out;
  const al = ALIGN_IN[p['text-align'] ?? ''];
  if (al) out.algn = al;
  const ml = lengthPx(p['margin-left']);
  if (ml !== null) out.marL = emu(ml);
  const ti = lengthPx(p['text-indent']);
  if (ti !== null) out.indent = emu(ti);
  const mt = lengthPt(p['margin-top']);
  if (mt !== null) out.spcBef = { pts: Math.round(mt * 100) / 100 };
  const mb = lengthPt(p['margin-bottom']);
  if (mb !== null) out.spcAft = { pts: Math.round(mb * 100) / 100 };
  const lh = p['line-height'];
  if (lh) {
    const pct = /^([\d.]+)%$/.exec(lh);
    if (pct) out.lnSpc = { pct: parseFloat(pct[1]) / 100 };
    else {
      const v = lengthPt(lh);
      if (v) out.lnSpc = { pts: Math.round(v * 100) / 100 };
    }
  }
  return out;
}

interface ListLevel {
  bullet: Bullet;
  props: ParaProps;
}

function listLevel(style: Element | null | undefined, depth: number, styles: OdfStyles): ListLevel | null {
  if (!style) return null;
  const el = kids(style).find((e) => Number(attr(e, 'level')) === depth + 1);
  if (!el) return null;
  const props: ParaProps = {};
  const lp = kid(el, 'list-level-properties');
  const align = kid(lp, 'list-level-label-alignment');
  if (align) {
    const ml = lengthPx(attr(align, 'margin-left'));
    const ti = lengthPx(attr(align, 'text-indent'));
    if (ml !== null) props.marL = emu(ml);
    if (ti !== null) props.indent = emu(ti);
  } else if (lp) {
    const before = lengthPx(attr(lp, 'space-before')) ?? 0;
    const width = lengthPx(attr(lp, 'min-label-width')) ?? 0;
    props.marL = emu(before + width);
    props.indent = -emu(width);
  }
  const tp = kid(el, 'text-properties');
  const color = hexColor(attr(tp, 'color'));
  if (color && attr(tp, 'use-window-font-color') !== 'true') props.buClr = color;
  const rel = attr(tp, 'font-size') ?? attr(el, 'bullet-relative-size');
  if (rel?.endsWith('%')) props.buSzPct = Math.round(parseFloat(rel) * 1000);
  const font = styles.fontOf(tp ? { 'font-name': attr(tp, 'font-name') ?? '', 'font-family': attr(tp, 'font-family') ?? '' } : undefined);
  if (font) props.buFont = font;
  if (el.localName === 'list-level-style-number') {
    const fmt = attr(el, 'num-format') ?? '1';
    const kind = NUM_SCHEMES[fmt];
    if (!kind) return { bullet: { type: 'none' }, props };
    const pre = attr(el, 'num-prefix') ?? '';
    const suf = attr(el, 'num-suffix') ?? '';
    const tail = pre === '(' && suf === ')' ? 'ParenBoth' : suf === ')' ? 'ParenR' : suf === '.' ? 'Period' : 'Plain';
    const start = Number(attr(el, 'start-value') ?? 1);
    return { bullet: { type: 'auto', scheme: `${kind}${tail}`, ...(start !== 1 ? { start } : {}) }, props };
  }
  if (el.localName === 'list-level-style-bullet') {
    const char = attr(el, 'bullet-char') ?? '•';
    return { bullet: { type: 'char', char: char.trim() ? char : '•' }, props };
  }
  return { bullet: { type: 'char', char: '•' }, props };
}

/** The list style a shape's own style carries, for paragraphs whose list doesn't name one. */
function shapeListStyle(el: Element, styles: OdfStyles): Element | null {
  for (const [family, local] of [['presentation', 'style-name'], ['graphic', 'style-name']] as const) {
    let s = styles.get(family, el.getAttributeNS(family === 'presentation' ? ODF.presentation : ODF.draw, local));
    const seen = new Set<string>();
    while (s && !seen.has(s.name)) {
      seen.add(s.name);
      const ls = kid(kid(s.el, 'graphic-properties'), 'list-style');
      if (ls) return ls;
      s = styles.get(family, s.parent);
    }
  }
  return null;
}

interface TextEnv {
  ctx: ReadCtx;
  /** Paragraph and text properties for a list depth (outline levels have styles of their own). */
  base: (depth: number) => Props;
  listStyle: Element | null;
}

function readRuns(el: Element, env: TextEnv, run: RunProps, sizePt: number, link: string | undefined, out: Run[], state: { space: boolean }): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const c = collapse(n.nodeValue ?? '', state.space);
      state.space = c.endsSpace;
      if (c.text) out.push({ kind: 'text', text: c.text, props: link ? { ...run, link } : { ...run } });
      continue;
    }
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    switch (e.localName) {
      case 's':
        out.push({ kind: 'text', text: ' '.repeat(Math.max(1, Number(attr(e, 'c') ?? 1) || 1)), props: { ...run } });
        state.space = true;
        break;
      case 'tab':
        out.push({ kind: 'text', text: '\t', props: { ...run } });
        state.space = false;
        break;
      case 'line-break':
        out.push({ kind: 'br', props: { ...run } });
        state.space = true;
        break;
      case 'span':
      case 'a': {
        const t = env.ctx.styles.resolve('text', attr(e, 'style-name'), false).text;
        const own = runPropsOf(t, env.ctx.styles, sizePt);
        const merged = { ...run, ...own };
        const href = e.localName === 'a' ? e.getAttributeNS(ODF.xlink, 'href') : null;
        readRuns(e, env, merged, merged.sz ? merged.sz / 100 : sizePt, href && /^(https?:|mailto:)/i.test(href) ? href : link, out, state);
        break;
      }
      case 'page-number':
        out.push({ kind: 'field', type: 'slidenum', id: '{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', text: e.textContent || '1', props: { ...run } });
        break;
      case 'date':
      case 'time':
        out.push({ kind: 'field', type: 'datetime1', id: '{8C8F0D3D-2D3E-4C1E-9B1B-1B1E1E1E1E1E}', text: e.textContent ?? '', props: { ...run } });
        break;
      case 'note':
      case 'annotation':
      case 'bookmark':
      case 'bookmark-start':
      case 'bookmark-end':
        break;
      default:
        readRuns(e, env, run, sizePt, link, out, state);
    }
  }
}

function readParagraph(p: Element, env: TextEnv, depth: number, level: ListLevel | null, numbered: boolean): Para {
  const styles = env.ctx.styles;
  const props = mergeProps(env.base(depth), styles.resolve('paragraph', attr(p, 'style-name'), false));
  const pp: ParaProps = { ...paraPropsOf(props.paragraph) };
  if (depth > 0) pp.lvl = Math.min(8, depth);
  if (level && numbered) {
    // Impress takes a list item's indents from its list level.
    Object.assign(pp, level.props);
    pp.bullet = level.bullet;
  } else pp.bullet = { type: 'none' };
  const run = runPropsOf(props.text, styles, 18);
  const runs: Run[] = [];
  readRuns(p, env, run, run.sz ? run.sz / 100 : 18, undefined, runs, { space: true });
  const last = runs[runs.length - 1];
  if (last?.kind === 'text' && last.text.endsWith(' ') && last.text.trim()) last.text = last.text.replace(/ $/, '');
  return { props: pp, runs, end: { ...run } };
}

function readParas(container: Element, env: TextEnv): Para[] {
  const out: Para[] = [];
  const walk = (el: Element, depth: number, listStyle: Element | null) => {
    for (const c of kids(el)) {
      if (c.localName === 'p' || c.localName === 'h') out.push(readParagraph(c, env, Math.max(0, depth - 1), depth ? listLevel(listStyle, depth - 1, env.ctx.styles) : null, depth > 0 && el.localName === 'list-item' && c === kids(el).find((k) => k.localName === 'p' || k.localName === 'h')));
      else if (c.localName === 'list') {
        const style = env.ctx.styles.listStyles.get(attr(c, 'style-name') ?? '') ?? listStyle ?? env.listStyle;
        for (const item of kids(c)) {
          if (item.localName === 'list-item') walk(item, depth + 1, style);
          else if (item.localName === 'list-header') {
            for (const hc of kids(item)) if (hc.localName === 'p' || hc.localName === 'h') out.push(readParagraph(hc, env, depth, null, false));
          }
        }
      }
    }
  };
  walk(container, 0, null);
  if (!out.length) out.push({ props: {}, runs: [] });
  return out;
}

function bodyOf(g: Record<string, string>): TextBody['body'] {
  const b: TextBody['body'] = {};
  const va = g['textarea-vertical-align'];
  b.anchor = va === 'middle' ? 'ctr' : va === 'bottom' ? 'b' : 't';
  const ins = (k: string) => {
    const v = lengthPx(g[k] ?? g.padding);
    return v === null ? undefined : emu(v);
  };
  b.lIns = ins('padding-left') ?? 91440;
  b.rIns = ins('padding-right') ?? 91440;
  b.tIns = ins('padding-top') ?? 45720;
  b.bIns = ins('padding-bottom') ?? 45720;
  b.wrap = g['wrap-option'] === 'no-wrap' ? 'none' : 'square';
  b.autofit = g['fit-to-size'] === 'shrink-to-fit' || g['shrink-to-fit'] === 'true' ? 'norm' : 'none';
  return b;
}

function textOf(container: Element, el: Element, props: Props, ctx: ReadCtx, outlineMaster: string | null): TextBody {
  const env: TextEnv = {
    ctx,
    listStyle: shapeListStyle(el, ctx.styles),
    base: (depth) => {
      // Outline levels after the first take their look from the master's outline styles.
      if (outlineMaster && depth > 0) {
        const lvl = ctx.styles.resolve('presentation', `${outlineMaster}-outline${depth + 1}`);
        if (Object.keys(lvl).length) return mergeProps(ctx.styles.resolve('graphic', null), lvl);
      }
      return props;
    },
  };
  return { body: bodyOf(props.graphic ?? {}), paras: readParas(container, env) };
}

const geomPath = (pts: string, close: boolean, vb: number[], w: number, h: number): string | null => {
  const nums = pts.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const sx = vb[2] ? w / vb[2] : 1;
  const sy = vb[3] ? h / vb[3] : 1;
  const ptXml = (i: number) => `<a:pt x="${Math.round((nums[i] - vb[0]) * sx)}" y="${Math.round((nums[i + 1] - vb[1]) * sy)}"/>`;
  let path = `<a:moveTo>${ptXml(0)}</a:moveTo>`;
  for (let i = 2; i + 1 < nums.length; i += 2) path += `<a:lnTo>${ptXml(i)}</a:lnTo>`;
  if (close) path += '<a:close/>';
  return `<a:custGeom xmlns:a="${A}"><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${close ? '' : ' fill="none"'}>${path}</a:path></a:pathLst></a:custGeom>`;
};

/** An SVG path (svg:d) as a custom geometry: straight and curved segments, arcs as lines. */
function svgPathGeom(d: string, vb: number[], w: number, h: number): string | null {
  const sx = vb[2] ? w / vb[2] : 1;
  const sy = vb[3] ? h / vb[3] : 1;
  const P = (x: number, y: number) => `<a:pt x="${Math.round((x - vb[0]) * sx)}" y="${Math.round((y - vb[1]) * sy)}"/>`;
  const toks = d.match(/[a-zA-Z]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx0 = 0;
  let sy0 = 0;
  let out = '';
  let closed = false;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ax = (v: number) => (rel ? x + v : v);
    const ay = (v: number) => (rel ? y + v : v);
    if (C === 'M') {
      x = ax(num());
      y = ay(num());
      sx0 = x;
      sy0 = y;
      out += `<a:moveTo>${P(x, y)}</a:moveTo>`;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L' || C === 'T') {
      x = ax(num());
      y = ay(num());
      out += `<a:lnTo>${P(x, y)}</a:lnTo>`;
    } else if (C === 'H') {
      x = rel ? x + num() : num();
      out += `<a:lnTo>${P(x, y)}</a:lnTo>`;
    } else if (C === 'V') {
      y = rel ? y + num() : num();
      out += `<a:lnTo>${P(x, y)}</a:lnTo>`;
    } else if (C === 'C') {
      const x1 = ax(num()), y1 = ay(num()), x2 = ax(num()), y2 = ay(num());
      x = ax(num());
      y = ay(num());
      out += `<a:cubicBezTo>${P(x1, y1)}${P(x2, y2)}${P(x, y)}</a:cubicBezTo>`;
    } else if (C === 'S') {
      const x2 = ax(num()), y2 = ay(num());
      x = ax(num());
      y = ay(num());
      out += `<a:cubicBezTo>${P(x2, y2)}${P(x2, y2)}${P(x, y)}</a:cubicBezTo>`;
    } else if (C === 'Q') {
      const x1 = ax(num()), y1 = ay(num());
      x = ax(num());
      y = ay(num());
      out += `<a:quadBezTo>${P(x1, y1)}${P(x, y)}</a:quadBezTo>`;
    } else if (C === 'A') {
      i += 5;
      x = ax(num());
      y = ay(num());
      out += `<a:lnTo>${P(x, y)}</a:lnTo>`;
    } else if (C === 'Z') {
      out += '<a:close/>';
      closed = true;
      x = sx0;
      y = sy0;
    } else return null;
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
  }
  if (!out) return null;
  return `<a:custGeom xmlns:a="${A}"><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${closed ? '' : ' fill="none"'}>${out}</a:path></a:pathLst></a:custGeom>`;
}

function custGeom(xml: string | null): SpShape['geom'] {
  if (!xml) return { prst: 'rect' };
  try {
    rememberCustGeom(xml, new DOMParser().parseFromString(xml, 'application/xml').documentElement);
  } catch {
    return { prst: 'rect' };
  }
  return { cust: xml };
}

function readShape(el: Element, ctx: ReadCtx, ph: Placeholder | undefined, outlineMaster: string | null): Shape | null {
  const props = shapeProps(el, ctx.styles);
  const g = props.graphic ?? {};
  const base = { uid: newUid(), id: ctx.nextId++, name: el.getAttributeNS(ODF.draw, 'name') || `Shape ${ctx.nextId - 2}` };
  const descr = kid(el, 'desc')?.textContent ?? kid(el, 'title')?.textContent ?? undefined;
  switch (el.localName) {
    case 'frame': {
      const image = kid(el, 'image');
      const box = kid(el, 'text-box');
      const table = kid(el, 'table');
      const xfrm = placement(el);
      if (table) return readTable(table, el, xfrm, ctx, base);
      if (box) {
        const text = textOf(box, el, props, ctx, outlineMaster);
        const shape: SpShape = { kind: 'sp', ...base, xfrm, geom: { prst: 'rect' }, fill: readFill(g, ctx) ?? { type: 'none' }, line: readLine(g) ?? { fill: { type: 'none' } }, text };
        if (ph) {
          shape.ph = ph;
          shape.nvRaw = '<a:spLocks noGrp="1"/>';
        } else shape.txBox = true;
        return shape;
      }
      if (image) {
        const media = mediaFor(ctx, image);
        if (!media) {
          if (kid(el, 'object') || kid(el, 'object-ole')) ctx.lost.add('charts and embedded objects');
          return null;
        }
        const pic: PicShape = { kind: 'pic', ...base, xfrm, media, geom: { prst: 'rect' }, nvRaw: '<a:picLocks noChangeAspect="1"/>' };
        if (descr) pic.descr = descr;
        const line = readLine(g);
        if (line && line.fill?.type !== 'none') pic.line = line;
        return pic;
      }
      if (kid(el, 'object') || kid(el, 'object-ole')) ctx.lost.add('charts and embedded objects');
      if (kid(el, 'plugin')) ctx.lost.add('sound and video');
      return null;
    }
    case 'custom-shape':
    case 'rect':
    case 'ellipse':
    case 'circle':
    case 'polygon':
    case 'polyline':
    case 'path': {
      const xfrm = placement(el);
      let geom: SpShape['geom'] = { prst: 'rect' };
      if (el.localName === 'ellipse' || el.localName === 'circle') geom = { prst: 'ellipse' };
      else if (el.localName === 'rect') geom = { prst: attr(el, 'corner-radius') ? 'roundRect' : 'rect' };
      else if (el.localName === 'polygon' || el.localName === 'polyline') {
        const vb = (attr(el, 'viewBox') ?? `0 0 ${xfrm.w} ${xfrm.h}`).split(/\s+/).map(Number);
        geom = custGeom(geomPath(attr(el, 'points') ?? '', el.localName === 'polygon', vb, xfrm.w, xfrm.h));
      } else if (el.localName === 'path') {
        const vb = (attr(el, 'viewBox') ?? `0 0 ${xfrm.w} ${xfrm.h}`).split(/\s+/).map(Number);
        geom = custGeom(svgPathGeom(attr(el, 'd') ?? '', vb, xfrm.w, xfrm.h));
      } else {
        const eg = kid(el, 'enhanced-geometry');
        const type = attr(eg, 'type') ?? 'rectangle';
        const prst = type.startsWith('ooxml-') ? type.slice(6) : LO_TYPES[type];
        if (prst) {
          geom = { prst };
          // OOXML presets keep their adjust values as the modifiers, in order.
          const mods = type.startsWith('ooxml-') ? (attr(eg, 'modifiers') ?? '').trim().split(/\s+/).filter(Boolean).map(Number) : [];
          if (mods.length && mods.every(Number.isFinite)) geom.adj = Object.fromEntries(mods.map((v, i) => [mods.length === 1 ? 'adj' : `adj${i + 1}`, v]));
        } else {
          const path = attr(eg, 'enhanced-path');
          const vb = (attr(eg, 'viewBox') ?? '0 0 21600 21600').split(/\s+/).map(Number);
          const svg = path && !/[?$]/.test(path) ? svgPathGeom(path.replace(/[NFS]/g, ''), vb, xfrm.w, xfrm.h) : null;
          if (svg) geom = custGeom(svg);
          else ctx.lost.add('some shapes (drawn as rectangles)');
        }
        if (attr(eg, 'mirror-horizontal') === 'true') xfrm.flipH = true;
        if (attr(eg, 'mirror-vertical') === 'true') xfrm.flipV = true;
      }
      const hasText = kids(el).some((c) => c.localName === 'p' || c.localName === 'list' || c.localName === 'h');
      const shape: SpShape = {
        kind: 'sp',
        ...base,
        xfrm,
        geom,
        fill: el.localName === 'polyline' ? { type: 'none' } : (readFill(g, ctx) ?? { type: 'none' }),
        line: readLine(g) ?? { fill: { type: 'none' } },
        text: hasText ? textOf(el, el, props, ctx, null) : { body: { ...bodyOf(g), anchor: 'ctr' }, paras: [{ props: { algn: 'ctr' }, runs: [] }] },
      };
      if (descr) shape.descr = descr;
      return shape;
    }
    case 'line':
    case 'connector': {
      const x1 = lengthPx(attr(el, 'x1')) ?? 0;
      const y1 = lengthPx(attr(el, 'y1')) ?? 0;
      const x2 = lengthPx(attr(el, 'x2')) ?? 0;
      const y2 = lengthPx(attr(el, 'y2')) ?? 0;
      const xfrm: Xfrm = { x: emu(Math.min(x1, x2)), y: emu(Math.min(y1, y2)), w: emu(Math.abs(x2 - x1)), h: emu(Math.abs(y2 - y1)) };
      if (x2 < x1) xfrm.flipH = true;
      if (y2 < y1) xfrm.flipV = true;
      const line = readLine(g) ?? { fill: { type: 'solid', color: { hex: '000000' } }, w: EMU };
      return { kind: 'sp', ...base, connector: true, xfrm, geom: { prst: 'line' }, line };
    }
    case 'g': {
      const children = kids(el)
        .map((c) => readShape(c, ctx, undefined, null))
        .filter((s): s is Shape => !!s);
      if (!children.length) return null;
      const boxes = children.map((c) => c.xfrm).filter((x): x is Xfrm => !!x);
      const l = Math.min(...boxes.map((b) => b.x));
      const t = Math.min(...boxes.map((b) => b.y));
      const r = Math.max(...boxes.map((b) => b.x + b.w));
      const b = Math.max(...boxes.map((bb) => bb.y + bb.h));
      const box = { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
      const grp: GroupShape = { kind: 'grp', ...base, xfrm: box, ch: { ...box }, children };
      return grp;
    }
    case 'measure':
    case 'caption':
    case 'regular-polygon':
    case 'scene':
    case 'control':
    case 'page-thumbnail':
      if (el.localName !== 'page-thumbnail') ctx.lost.add('some shapes');
      return null;
  }
  return null;
}

function tcPrXml(props: Props): string {
  const g = props.graphic ?? {};
  // LibreOffice writes a cell's borders as its paragraph's.
  const c = { ...props.paragraph, ...props['table-cell'] };
  const side = (tag: string, v: string | undefined) => {
    if (!v || v === 'none') return `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
    const parts = v.split(/\s+/);
    const color = parts.map(odfColor).find(Boolean) ?? '000000';
    const w = parts.map(lengthPx).find((n) => n !== null) ?? 1;
    return `<a:${tag} w="${emu(w)}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:${tag}>`;
  };
  const all = c.border ?? g.border;
  const fillColor = odfColor(c['background-color']) ?? (g.fill === 'solid' || (!g.fill && g['fill-color']) ? odfColor(g['fill-color']) : null);
  const anchor = c['vertical-align'] ?? g['textarea-vertical-align'];
  return (
    `<a:tcPr xmlns:a="${A}"${anchor === 'middle' ? ' anchor="ctr"' : anchor === 'bottom' ? ' anchor="b"' : ''}>` +
    side('lnL', c['border-left'] ?? g['border-left'] ?? all) +
    side('lnR', c['border-right'] ?? g['border-right'] ?? all) +
    side('lnT', c['border-top'] ?? g['border-top'] ?? all) +
    side('lnB', c['border-bottom'] ?? g['border-bottom'] ?? all) +
    (fillColor ? `<a:solidFill><a:srgbClr val="${fillColor}"/></a:solidFill>` : '<a:noFill/>') +
    '</a:tcPr>'
  );
}

function readTable(tbl: Element, frame: Element, xfrm: Xfrm, ctx: ReadCtx, base: { uid: string; id: number; name: string }): FrameShape {
  const cols: number[] = [];
  const colStyles: (string | null)[] = [];
  for (const c of kids(tbl).flatMap((e) => (e.localName === 'table-columns' ? kids(e) : [e]))) {
    if (c.localName !== 'table-column') continue;
    const n = Math.min(64, Number(attr(c, 'number-columns-repeated') ?? 1) || 1);
    const w = lengthPx(ctx.styles.resolve('table-column', attr(c, 'style-name'))['table-column']?.['column-width']);
    for (let i = 0; i < n; i++) {
      cols.push(emu(w ?? 0));
      colStyles.push(attr(c, 'default-cell-style-name'));
    }
  }
  const rowEls = kids(tbl).flatMap((e) => (e.localName === 'table-rows' || e.localName === 'table-header-rows' ? kids(e) : [e])).filter((e) => e.localName === 'table-row');
  const spans: { r0: number; until: number; c0: number; c1: number }[] = [];
  const rows: Table['rows'] = rowEls.map((tr, r) => {
    const rp = ctx.styles.resolve('table-row', attr(tr, 'style-name'))['table-row'] ?? {};
    const h = lengthPx(rp['row-height'] ?? rp['min-row-height']) ?? 30;
    const cells: TableCell[] = [];
    let c = 0;
    for (const tc of kids(tr)) {
      if (tc.localName !== 'table-cell' && tc.localName !== 'covered-table-cell') continue;
      const empty = (): TableCell => ({ text: { body: {}, paras: [{ props: {}, runs: [] }] }, tcPr: '' });
      if (tc.localName === 'covered-table-cell') {
        const owner = spans.find((s) => c >= s.c0 && c <= s.c1 && r <= s.until);
        const cell = empty();
        if (owner && r > owner.r0) cell.vMerge = true;
        else cell.hMerge = true;
        cells.push(cell);
        c++;
        continue;
      }
      const cellStyle = attr(tc, 'style-name') ?? attr(tr, 'default-cell-style-name') ?? colStyles[c] ?? null;
      const props = mergeProps(ctx.styles.resolve('graphic', null), ctx.styles.resolve('table-cell', cellStyle));
      const env: TextEnv = { ctx, listStyle: null, base: () => props };
      const cell: TableCell = { text: { body: {}, paras: readParas(tc, env) }, tcPr: tcPrXml(props) };
      const cs = Number(attr(tc, 'number-columns-spanned') ?? 1) || 1;
      const rs = Number(attr(tc, 'number-rows-spanned') ?? 1) || 1;
      if (cs > 1) cell.gridSpan = cs;
      if (rs > 1) cell.rowSpan = rs;
      if (cs > 1 || rs > 1) spans.push({ r0: r, until: r + rs - 1, c0: c, c1: c + cs - 1 });
      cells.push(cell);
      c++;
    }
    return { h: emu(h), cells };
  });
  const width = Math.max(1, ...rows.map((row) => row.cells.length));
  while (cols.length < width) cols.push(Math.round(xfrm.w / width));
  if (attr(tbl, 'template-name')) ctx.lost.add('table designs (tables keep their cell colors only)');
  return {
    kind: 'frame',
    ...base,
    name: frame.getAttributeNS(ODF.draw, 'name') || base.name,
    xfrm,
    // No table style: without one named, PowerPoint would apply its default.
    table: { tblPr: `<a:tblPr xmlns:a="${A}"><a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr>`, cols: cols.slice(0, width), rows },
  };
}

const PH_CLASSES = new Set(['title', 'subtitle', 'outline']);
const SKIP_CLASSES = new Set(['header', 'footer', 'date-time', 'page-number', 'page', 'handout']);

/** Slides opened from an .odp, on a new presentation package of the same slide size. */
export function readOdp(bytes: Uint8Array): LoadedOdp {
  const odf = OdfDocument.read(bytes, 'presentation', 'presentation');
  const cs = contentStyles(odf);
  const ms = masterStyles(odf);
  const masters = kids(kid(odf.styles.documentElement, 'master-styles'), 'master-page');
  const layoutOf = (m: Element | undefined) => kids(kid(odf.styles.documentElement, 'automatic-styles'), 'page-layout').find((l) => attr(l, 'name') === attr(m, 'page-layout-name'));
  const pp = kid(layoutOf(masters[0]), 'page-layout-properties');
  const size = { w: emu(lengthPx(attr(pp, 'page-width')) ?? 1280), h: emu(lengthPx(attr(pp, 'page-height')) ?? 720) };
  const pkg = newPackage(DESIGNS[0], size);
  const deck = readDeck(pkg);
  const layouts = Object.values(deck.layouts);
  const layoutFor = (type: string) => (layouts.find((l) => l.type === type) ?? layouts.find((l) => l.type === 'blank') ?? layouts[0]).part;
  const ctx: ReadCtx = { odf, styles: cs, pkg, lost: new Set(), media: new Map(), nextId: 2 };

  // Shapes on master pages that aren't placeholders show behind every slide that uses them.
  const decor = new Map<string, Shape[]>();
  for (const m of masters) {
    const mctx: ReadCtx = { ...ctx, styles: ms, nextId: 2 };
    const shapes: Shape[] = [];
    for (const el of kids(m)) {
      const cls = el.getAttributeNS(ODF.presentation, 'class');
      if (cls || el.localName === 'notes') continue;
      const s = readShape(el, mctx, undefined, null);
      if (s) shapes.push(s);
    }
    decor.set(attr(m, 'name') ?? '', shapes);
  }

  const slides: Slide[] = [];
  for (const page of kids(odf.body('presentation'), 'page')) {
    ctx.nextId = 2;
    const masterName = page.getAttributeNS(ODF.draw, 'master-page-name') ?? attr(masters[0], 'name') ?? 'Default';
    const master = masters.find((m) => attr(m, 'name') === masterName) ?? masters[0];
    const dp = mergeProps(ms.resolve('drawing-page', master?.getAttributeNS(ODF.draw, 'style-name')), cs.resolve('drawing-page', page.getAttributeNS(ODF.draw, 'style-name')));
    const dpp = dp['drawing-page'] ?? {};
    const classes = kids(page).map((e) => e.getAttributeNS(ODF.presentation, 'class') ?? '');
    const type = classes.includes('title') && classes.includes('outline') ? (classes.filter((c) => c === 'outline').length > 1 ? 'twoObj' : 'obj') : classes.includes('title') && classes.includes('subtitle') ? 'title' : classes.includes('title') ? 'titleOnly' : 'blank';
    const shapes: Shape[] = [];
    if (dpp['background-objects-visible'] !== 'false') {
      for (const s of decor.get(attr(master, 'name') ?? '') ?? []) {
        const copy = JSON.parse(JSON.stringify(s)) as Shape;
        const renew = (x: Shape) => {
          x.uid = newUid();
          x.id = ctx.nextId++;
          if (x.kind === 'grp') x.children.forEach(renew);
        };
        renew(copy);
        shapes.push(copy);
      }
    }
    let bodyIdx = 1;
    for (const el of kids(page)) {
      const cls = el.getAttributeNS(ODF.presentation, 'class');
      if (el.localName === 'notes' || el.localName === 'forms' || (cls && SKIP_CLASSES.has(cls))) continue;
      let ph: Placeholder | undefined;
      if (cls && PH_CLASSES.has(cls) && kid(el, 'text-box')) {
        if (cls === 'title') ph = { type: type === 'title' ? 'ctrTitle' : 'title' };
        else if (cls === 'subtitle') ph = { type: 'subTitle', idx: 1 };
        else ph = { idx: bodyIdx++ };
      }
      const s = readShape(el, ctx, ph, cls === 'outline' ? masterName : null);
      if (s) shapes.push(s);
    }
    const slide: Slide = { uid: newUid('slide'), layout: layoutFor(type), shapes, notes: '' };
    const notes = kid(page, 'notes');
    const nf = kids(notes).find((e) => e.getAttributeNS(ODF.presentation, 'class') === 'notes');
    const box = kid(nf, 'text-box');
    if (box) slide.notes = Array.from(box.getElementsByTagNameNS(ODF.text, 'p')).map(paragraphText).join('\n').trim();
    const bg = readFill(dpp, ctx);
    if (bg && bg.type !== 'none' && dpp['background-visible'] !== 'false') slide.bg = { fill: bg };
    else slide.bg = { fill: { type: 'solid', color: { hex: 'FFFFFF' } } };
    if (dpp.visibility === 'hidden') slide.hidden = true;
    const name = page.getAttributeNS(ODF.draw, 'name');
    if (name && !/^page\d+$/i.test(name) && !/^Slide \d+$/.test(name)) slide.name = name;
    if (kids(page).some((e) => e.localName === 'animations' || e.localName === 'par')) ctx.lost.add('animations');
    slides.push(slide);
  }
  if (odf.hasPrefix('Object ')) ctx.lost.add('charts and embedded objects');
  return { pkg, deck: { ...deck, slides }, lost: [...ctx.lost] };
}

// ---- Writing -------------------------------------------------------------------------------------

/** A path's coordinates mirrored (flips are drawn into the path, as ODF paths have none). */
function mirror(d: string, w: number, h: number, fh: boolean, fv: boolean): string {
  if (!fh && !fv) return d;
  return d.replace(/([MLCQA])([^MLCQAZ]*)/g, (_m, cmd: string, args: string) => {
    const n = args.trim().split(/\s+/).map(Number);
    if (cmd === 'A') {
      const sweep = fh !== fv ? (n[4] ? 0 : 1) : n[4];
      return `A${n[0]} ${n[1]} ${n[2]} ${n[3]} ${sweep} ${fh ? w - n[5] : n[5]} ${fv ? h - n[6] : n[6]} `;
    }
    return `${cmd}${n.map((v, i) => (i % 2 === 0 ? (fh ? w - v : v) : fv ? h - v : v)).join(' ')} `;
  });
}

interface Named {
  gradients: Map<string, string>;
  images: Map<string, string>;
  xml: string[];
}

class OdpWriter {
  graphic: AutoStyles;
  pres: AutoStyles;
  para: AutoStyles;
  text: AutoStyles;
  page: AutoStyles;
  cells: AutoStyles;
  private lists: string[] = [];
  private listKeys = new Map<string, string>();

  constructor(
    private deck: Deck,
    private pkg: OpcPackage,
    private fonts: FontFaces,
    private media: OdfMedia,
    private named: Named,
    private prefix: string,
  ) {
    this.graphic = new AutoStyles(`${prefix}gr`);
    this.pres = new AutoStyles(`${prefix}pr`);
    this.para = new AutoStyles(`${prefix}P`);
    this.text = new AutoStyles(`${prefix}T`);
    this.page = new AutoStyles(`${prefix}dp`);
    this.cells = new AutoStyles(`${prefix}ce`);
  }

  autoStylesXml(): string {
    return this.page.xml() + this.graphic.xml() + this.pres.xml() + this.cells.xml() + this.para.xml() + this.text.xml() + this.lists.join('');
  }

  private color(c: Color | undefined, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>, ph?: Paint['phClr']) {
    return resolveColorModel(c, ctx.theme, ctx.clrMap, ph);
  }

  private mediaPath(path: string | null): string | null {
    if (!path) return null;
    const data = this.pkg.bytes(path);
    return data ? this.media.add(data, extOfPath(path) || 'png') : null;
  }

  fillAttrs(paint: Paint | null, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>): string[] {
    const f = paint?.fill;
    if (!f || f.type === 'none' || f.type === 'grp') return ['draw:fill="none"'];
    if (f.type === 'solid' || f.type === 'patt') {
      const c = this.color(f.type === 'solid' ? f.color : f.fg, ctx, paint.phClr);
      if (!c) return ['draw:fill="none"'];
      return ['draw:fill="solid"', `draw:fill-color="#${c.hex}"`, ...(c.alpha < 1 ? [`draw:opacity="${Math.round(c.alpha * 100)}%"`] : [])];
    }
    if (f.type === 'grad') {
      const first = this.color(f.stops[0]?.color, ctx, paint.phClr);
      const last = this.color(f.stops[f.stops.length - 1]?.color, ctx, paint.phClr);
      if (!first || !last) return ['draw:fill="none"'];
      const radial = f.path === 'circle' || f.path === 'shape';
      const rect = f.path === 'rect';
      const angle = radial || rect ? 0 : (((90 - f.angle) % 360) + 360) % 360;
      const def = `${radial ? 'radial' : rect ? 'rectangular' : 'linear'}|${radial || rect ? last.hex : first.hex}|${radial || rect ? first.hex : last.hex}|${Math.round(angle)}`;
      let name = this.named.gradients.get(def);
      if (!name) {
        name = `Gradient_${this.named.gradients.size + 1}`;
        this.named.gradients.set(def, name);
        const [style, start, end, ang] = def.split('|');
        this.named.xml.push(`<draw:gradient draw:name="${name}" draw:style="${style}"${style !== 'linear' ? ' draw:cx="50%" draw:cy="50%"' : ''} draw:start-color="#${start}" draw:end-color="#${end}" draw:start-intensity="100%" draw:end-intensity="100%" draw:angle="${ang}deg" draw:border="0%"/>`);
      }
      return ['draw:fill="gradient"', `draw:fill-gradient-name="${name}"`, `draw:fill-color="#${first.hex}"`];
    }
    if (f.type === 'blip') {
      const path = this.mediaPath(f.media);
      if (!path) return ['draw:fill="none"'];
      let name = this.named.images.get(path);
      if (!name) {
        name = `Image_${this.named.images.size + 1}`;
        this.named.images.set(path, name);
        this.named.xml.push(`<draw:fill-image draw:name="${name}" xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`);
      }
      return ['draw:fill="bitmap"', `draw:fill-image-name="${name}"`, `style:repeat="${f.tile ? 'repeat' : 'stretch'}"`];
    }
    return ['draw:fill="none"'];
  }

  strokeAttrs(stroke: Stroke | null, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>): string[] {
    const line = stroke?.line;
    const f = line?.fill;
    if (!line || !f || f.type === 'none') return ['draw:stroke="none"'];
    const color = f.type === 'solid' ? this.color(f.color, ctx, stroke.phClr) : f.type === 'grad' ? this.color(f.stops[0]?.color, ctx, stroke.phClr) : null;
    if (!color) return ['draw:stroke="none"'];
    const out = [`draw:stroke="${line.dash && line.dash !== 'solid' ? 'dash' : 'solid'}"`, `svg:stroke-color="#${color.hex}"`, `svg:stroke-width="${cmOf(line.w ?? 12700)}"`];
    if (line.dash && line.dash !== 'solid') out.push('draw:stroke-dash="Din_Dash"');
    if (color.alpha < 1) out.push(`svg:stroke-opacity="${Math.round(color.alpha * 100)}%"`);
    const width = cmOf(Math.max(90000, (line.w ?? 12700) * 3));
    if (line.head && line.head.type !== 'none') out.push('draw:marker-start="Din_Arrow"', `draw:marker-start-width="${width}"`);
    if (line.tail && line.tail.type !== 'none') out.push('draw:marker-end="Din_Arrow"', `draw:marker-end-width="${width}"`);
    return out;
  }

  private textArea(body: TextStyleChain['body']): string[] {
    return [
      `draw:textarea-vertical-align="${body.anchor === 'ctr' ? 'middle' : body.anchor === 'b' ? 'bottom' : 'top'}"`,
      `fo:padding-left="${cmOf(body.lIns ?? 91440)}"`,
      `fo:padding-right="${cmOf(body.rIns ?? 91440)}"`,
      `fo:padding-top="${cmOf(body.tIns ?? 45720)}"`,
      `fo:padding-bottom="${cmOf(body.bIns ?? 45720)}"`,
      `fo:wrap-option="${body.wrap === 'none' ? 'no-wrap' : 'wrap'}"`,
      'draw:auto-grow-height="false"',
      'draw:auto-grow-width="false"',
      ...(body.autofit === 'norm' ? ['draw:fit-to-size="shrink-to-fit"'] : []),
    ];
  }

  private runProps(r: RunProps, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>): string {
    const a: string[] = [];
    const font = this.fonts.use(fontName(r.font, ctx.theme) ?? ctx.theme.minorFont);
    if (font) a.push(`style:font-name="${esc(font)}"`);
    const size = (r.sz ?? 1800) / 100;
    a.push(`fo:font-size="${ptOf(size)}" style:font-size-asian="${ptOf(size)}" style:font-size-complex="${ptOf(size)}"`);
    const b = r.b ? 'bold' : 'normal';
    a.push(`fo:font-weight="${b}" style:font-weight-asian="${b}" style:font-weight-complex="${b}"`);
    const i = r.i ? 'italic' : 'normal';
    a.push(`fo:font-style="${i}" style:font-style-asian="${i}" style:font-style-complex="${i}"`);
    if (r.u && r.u !== 'none') a.push(`style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"${r.u.startsWith('dbl') ? ' style:text-underline-type="double"' : ''}`);
    else a.push('style:text-underline-style="none"');
    a.push(r.strike && r.strike !== 'noStrike' ? 'style:text-line-through-style="solid"' : 'style:text-line-through-style="none"');
    const c = this.color(r.color, ctx);
    if (c) a.push(`fo:color="#${c.hex}"`);
    if (r.baseline) a.push(`style:text-position="${Math.round(r.baseline / 1000)}% 58%"`);
    if (r.spc) a.push(`fo:letter-spacing="${ptOf(r.spc / 100)}"`);
    if (r.cap === 'all') a.push('fo:text-transform="uppercase"');
    else if (r.cap === 'small') a.push('fo:font-variant="small-caps"');
    const hl = this.color(r.highlight, ctx);
    if (hl) a.push(`fo:background-color="#${hl.hex}"`);
    return `<style:text-properties ${a.join(' ')}/>`;
  }

  private paraProps(rp: ResolvedPara, size: number): string {
    const sp = (s: ResolvedPara['spcBef']) => (!s ? '0pt' : 'pts' in s ? ptOf(s.pts) : ptOf(s.pct * size * 1.2));
    const a = [
      `fo:text-align="${rp.algn === 'ctr' ? 'center' : rp.algn === 'r' ? 'end' : rp.algn === 'just' || rp.algn === 'dist' ? 'justify' : 'start'}"`,
      `fo:margin-left="${cmOf(rp.marL)}"`,
      'fo:margin-right="0cm"',
      `fo:text-indent="${cmOf(rp.indent)}"`,
      `fo:margin-top="${sp(rp.spcBef)}"`,
      `fo:margin-bottom="${sp(rp.spcAft)}"`,
    ];
    if (rp.lnSpc && 'pts' in rp.lnSpc) a.push(`fo:line-height="${ptOf(rp.lnSpc.pts)}"`);
    else a.push(`fo:line-height="${Math.round((rp.lnSpc && 'pct' in rp.lnSpc ? rp.lnSpc.pct : 1) * 100)}%"`);
    return `<style:paragraph-properties ${a.join(' ')}/>`;
  }

  private listStyle(levels: Map<number, ResolvedPara>, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>): string {
    const body = [...levels]
      .sort((a, b) => a[0] - b[0])
      .map(([lvl, rp]) => {
        // Impress places the label at space-before and the text min-label-width after it.
        const width = Math.max(0, -rp.indent);
        const align = `<style:list-level-properties text:space-before="${cmOf(Math.max(0, rp.marL + Math.min(0, rp.indent)))}" text:min-label-width="${cmOf(width)}"/>`;
        const color = this.color(rp.buClr, ctx);
        const tp = `<style:text-properties fo:font-size="${Math.round((rp.buSzPct ?? 100000) / 1000)}%"${color ? ` fo:color="#${color.hex}"` : ' style:use-window-font-color="true"'}${rp.buFont ? ` style:font-name="${esc(this.fonts.use(fontName(rp.buFont, ctx.theme))!)}"` : ''}/>`;
        const b = rp.bullet;
        if (b?.type === 'auto') {
          const m = /^(arabic|romanUc|romanLc|alphaUc|alphaLc)(.*)$/.exec(b.scheme);
          const fmt = { arabic: '1', romanUc: 'I', romanLc: 'i', alphaUc: 'A', alphaLc: 'a' }[(m?.[1] ?? 'arabic') as 'arabic'] ?? '1';
          const tail = m?.[2] ?? 'Period';
          const pre = tail.startsWith('ParenBoth') ? '(' : '';
          const suf = tail.startsWith('Paren') ? ')' : tail.startsWith('Period') ? '.' : '';
          return `<text:list-level-style-number text:level="${lvl + 1}"${pre ? ` style:num-prefix="${pre}"` : ''}${suf ? ` style:num-suffix="${suf}"` : ''} style:num-format="${fmt}"${b.start && b.start !== 1 ? ` text:start-value="${b.start}"` : ''}>${align}${tp}</text:list-level-style-number>`;
        }
        const char = b?.type === 'char' ? b.char : '•';
        return `<text:list-level-style-bullet text:level="${lvl + 1}" text:bullet-char="${esc(char)}">${align}${tp}</text:list-level-style-bullet>`;
      })
      .join('');
    let name = this.listKeys.get(body);
    if (!name) {
      name = `${this.prefix}L${this.listKeys.size + 1}`;
      this.listKeys.set(body, name);
      this.lists.push(`<text:list-style style:name="${name}">${body}</text:list-style>`);
    }
    return name;
  }

  private run(r: Run, rp: ResolvedPara, ctx: SlideCtx): string {
    const props = resolveRun(r.props, rp);
    if (r.kind === 'br') return '<text:line-break/>';
    const style = this.text.name('text', this.runProps(props, ctx));
    let inner: string;
    if (r.kind === 'field') {
      if (r.type === 'slidenum') inner = `<text:page-number>${ctx.slideNumber}</text:page-number>`;
      else if (r.type.startsWith('datetime')) inner = `<text:date>${esc(r.text)}</text:date>`;
      else inner = textXml(r.text);
    } else inner = textXml(r.text);
    const link = r.props.link && /^(https?:|mailto:)/i.test(r.props.link) ? r.props.link : null;
    return `<text:span text:style-name="${style}">${link ? `<text:a xlink:href="${esc(link)}" xlink:type="simple">${inner}</text:a>` : inner}</text:span>`;
  }

  /** A text body's paragraphs, bulleted runs of them as lists. */
  paragraphs(paras: Para[], chain: TextStyleChain, ctx: SlideCtx): string {
    const resolved = paras.map((p) => resolvePara(p.props, chain));
    const out: string[] = [];
    let i = 0;
    const one = (k: number, listed = false) => {
      const p = paras[k];
      const rp = resolved[k];
      const first = p.runs.find((r) => r.kind !== 'br');
      const firstProps = resolveRun(first ? first.props : (p.end ?? {}), rp);
      const size = (firstProps.sz ?? 1800) / 100;
      // A list item's indents are its list level's.
      const style = this.para.name('paragraph', this.paraProps(listed ? { ...rp, marL: 0, indent: 0 } : rp, size) + this.runProps(firstProps, ctx));
      return `<text:p text:style-name="${style}">${p.runs.map((r) => this.run(r, rp, ctx)).join('')}</text:p>`;
    };
    while (i < paras.length) {
      const b = resolved[i].bullet;
      if (!b || b.type === 'none' || !paras[i].runs.length) {
        out.push(one(i));
        i++;
        continue;
      }
      const items: { level: number; xml: string }[] = [];
      const levels = new Map<number, ResolvedPara>();
      const look = (rp: ResolvedPara) => JSON.stringify([rp.bullet, rp.marL, rp.indent, rp.buClr, rp.buSzPct, rp.buFont]);
      while (i < paras.length && resolved[i].bullet && resolved[i].bullet!.type !== 'none' && paras[i].runs.length) {
        const lvl = Math.max(0, Math.min(8, paras[i].props.lvl ?? 0));
        const known = levels.get(lvl);
        // A level that changes its bullet (• then 1.) starts a list of its own.
        if (known && look(known) !== look(resolved[i])) break;
        if (!known) levels.set(lvl, resolved[i]);
        items.push({ level: lvl, xml: one(i, true) });
        i++;
      }
      for (let l = 0; l < 9; l++) if (!levels.has(l)) levels.set(l, { ...[...levels.values()][0], marL: 0, indent: 0 });
      out.push(nestedList(items, ` text:style-name="${this.listStyle(levels, ctx)}"`));
    }
    return out.join('');
  }

  private box(x: Xfrm): string {
    const w = cmOf(x.w);
    const h = cmOf(x.h);
    if (!x.rot) return ` svg:width="${w}" svg:height="${h}" svg:x="${cmOf(x.x)}" svg:y="${cmOf(x.y)}"`;
    const a = (-x.rot * Math.PI) / 180;
    const cx = x.x + x.w / 2;
    const cy = x.y + x.h / 2;
    const tx = cx - ((x.w / 2) * Math.cos(a) + (x.h / 2) * Math.sin(a));
    const ty = cy - (-(x.w / 2) * Math.sin(a) + (x.h / 2) * Math.cos(a));
    const ang = (((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toFixed(6);
    return ` svg:width="${w}" svg:height="${h}" draw:transform="rotate (${ang}) translate (${cmOf(tx)} ${cmOf(ty)})"`;
  }

  shape(s: Shape, ctx: SlideCtx, place: (x: Xfrm) => Xfrm, onMaster: boolean): string {
    const chain = onMaster ? [] : inheritChain(s, ctx);
    const own = effectiveXfrm(s, chain);
    if (s.hidden) return '';
    const name = s.name ? ` draw:name="${esc(s.name)}"` : '';
    const desc = s.descr ? `<svg:desc>${esc(s.descr)}</svg:desc>` : '';
    switch (s.kind) {
      case 'grp': {
        const g = place(s.xfrm);
        const sx = s.ch.w ? g.w / s.ch.w : 1;
        const sy = s.ch.h ? g.h / s.ch.h : 1;
        const inner = (x: Xfrm): Xfrm => ({ ...x, x: g.x + (x.x - s.ch.x) * sx, y: g.y + (x.y - s.ch.y) * sy, w: x.w * sx, h: x.h * sy });
        return `<draw:g${name}>${s.children.map((c) => this.shape(c, ctx, inner, true)).join('')}</draw:g>`;
      }
      case 'raw':
        return s.fallback ? this.shape(s.fallback, ctx, place, onMaster) : '';
      case 'frame': {
        if (!own) return '';
        const x = place(own);
        if (s.table) return this.table(s as FrameShape, x, ctx, name);
        if (s.preview?.length && s.previewSpace) {
          const sp = s.previewSpace;
          const sx = sp.w ? x.w / sp.w : 1;
          const sy = sp.h ? x.h / sp.h : 1;
          const inner = (c: Xfrm): Xfrm => ({ ...c, x: x.x + (c.x - sp.x) * sx, y: x.y + (c.y - sp.y) * sy, w: c.w * sx, h: c.h * sy });
          return `<draw:g${name}>${s.preview.map((c) => this.shape(c, ctx, inner, true)).join('')}</draw:g>`;
        }
        return '';
      }
      case 'pic': {
        if (!own) return '';
        const path = this.mediaPath(s.media);
        if (!path) return '';
        const x = place(own);
        const style = this.graphic.name('graphic', `<style:graphic-properties ${[...this.strokeAttrs(shapeLine(s, chain, ctx), ctx), 'draw:fill="none"'].join(' ')}/>`);
        return `<draw:frame draw:style-name="${style}"${name} draw:layer="layout"${this.box(x)}><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="${mimeOf(path)}"><text:p/></draw:image>${desc}</draw:frame>`;
      }
      case 'sp':
        return this.sp(s, chain, ctx, place, own, name, desc);
    }
  }

  private sp(s: SpShape, chain: Shape[], ctx: SlideCtx, place: (x: Xfrm) => Xfrm, own: Xfrm | undefined, name: string, desc: string): string {
    if (!own) return '';
    const x = place(own);
    const stroke = shapeLine(s, chain, ctx);
    if (s.connector || isLineGeom(s.geom)) {
      const style = this.graphic.name('graphic', `<style:graphic-properties ${[...this.strokeAttrs(stroke, ctx), 'draw:fill="none"'].join(' ')}/>`);
      let [x1, y1, x2, y2] = [x.flipH ? x.x + x.w : x.x, x.flipV ? x.y + x.h : x.y, x.flipH ? x.x : x.x + x.w, x.flipV ? x.y : x.y + x.h];
      if (x.rot) {
        const a = (x.rot * Math.PI) / 180;
        const cx = x.x + x.w / 2;
        const cy = x.y + x.h / 2;
        const turn = (px: number, py: number): [number, number] => [cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a), cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a)];
        [x1, y1] = turn(x1, y1);
        [x2, y2] = turn(x2, y2);
      }
      return `<draw:line draw:style-name="${style}"${name} draw:layer="layout" svg:x1="${cmOf(x1)}" svg:y1="${cmOf(y1)}" svg:x2="${cmOf(x2)}" svg:y2="${cmOf(y2)}"><text:p/>${desc}</draw:line>`;
    }
    const fill = shapeFill(s, chain, ctx);
    const tchain = textChain(s, chain, ctx);
    const text = s.text ? this.paragraphs(s.text.paras, tchain, ctx) : '';
    const props = `<style:graphic-properties ${[...this.fillAttrs(fill, ctx), ...this.strokeAttrs(stroke, ctx), ...this.textArea(tchain.body)].join(' ')}/>`;
    const phType = s.ph ? (s.ph.type ?? 'obj') : null;
    const cls = phType === 'title' || phType === 'ctrTitle' ? 'title' : phType === 'subTitle' ? 'subtitle' : phType === 'body' || phType === 'obj' ? 'outline' : null;
    const rect = !s.geom || (!s.geom.cust && (s.geom.prst ?? 'rect') === 'rect');
    if (cls) {
      const style = this.pres.name('presentation', props, { 'style:parent-style-name': `${this.masterName}-${cls === 'outline' ? 'outline1' : cls}` });
      return `<draw:frame presentation:style-name="${style}"${name} draw:layer="layout"${this.box(x)} presentation:class="${cls}"${text ? ' presentation:user-transformed="true"' : ' presentation:placeholder="true"'}><draw:text-box>${text}</draw:text-box>${desc}</draw:frame>`;
    }
    const style = this.graphic.name('graphic', props);
    if (rect && (s.txBox || !fill || fill.fill.type === 'none') && !x.flipH && !x.flipV) {
      return `<draw:frame draw:style-name="${style}"${name} draw:layer="layout"${this.box(x)}><draw:text-box>${text}</draw:text-box>${desc}</draw:frame>`;
    }
    const lo = s.geom?.prst && !s.geom.cust ? PRESET_TO_LO[s.geom.prst] : undefined;
    if (lo && !s.geom?.adj) {
      const mirrorAttrs = `${x.flipH ? ' draw:mirror-horizontal="true"' : ''}${x.flipV ? ' draw:mirror-vertical="true"' : ''}`;
      return `<draw:custom-shape draw:style-name="${style}"${name} draw:layer="layout"${this.box(x)}>${text}<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="${lo}"${mirrorAttrs}/>${desc}</draw:custom-shape>`;
    }
    // Other presets and custom geometry go as their outline.
    const W = Math.max(1, Math.round(x.w / 360));
    const H = Math.max(1, Math.round(x.h / 360));
    const path = shapePath(s.geom, W, H);
    const d = mirror(path.paths.filter((p) => p.d).map((p) => p.d).join(' '), W, H, !!x.flipH, !!x.flipV);
    return `<draw:path draw:style-name="${style}"${name} draw:layer="layout"${this.box(x)} svg:viewBox="0 0 ${W} ${H}" svg:d="${esc(d)}">${text}${desc}</draw:path>`;
  }

  private table(s: FrameShape, x: Xfrm, ctx: SlideCtx, name: string): string {
    const t = s.table!;
    const cols = t.cols.map((w) => `<table:table-column table:style-name="${this.cells.name('table-column', `<style:table-column-properties style:column-width="${cmOf(w)}"/>`)}"/>`).join('');
    const rows = t.rows
      .map((row, r) => {
        const rs = this.cells.name('table-row', `<style:table-row-properties style:row-height="${cmOf(row.h)}"/>`);
        const cells = row.cells
          .map((cell, c) => {
            if (cell.hMerge || cell.vMerge) return '<table:covered-table-cell/>';
            const look = cellLook(s, r, c, ctx);
            const border = (l: Line | null | undefined) => {
              const f = l?.fill;
              if (!l || !f || f.type !== 'solid') return 'none';
              const col = this.color(f.color, ctx);
              return col ? `${cmOf(l.w ?? 12700)} solid #${col.hex}` : 'none';
            };
            const fill = this.fillAttrs(look.fill ? { fill: look.fill } : null, ctx);
            const [ml, mt, mr, mb] = look.margins;
            const style = this.cells.name(
              'table-cell',
              `<style:graphic-properties ${fill.join(' ')} draw:textarea-vertical-align="${look.anchor === 'ctr' ? 'middle' : look.anchor === 'b' ? 'bottom' : 'top'}" fo:padding-left="${cmOf(ml)}" fo:padding-top="${cmOf(mt)}" fo:padding-right="${cmOf(mr)}" fo:padding-bottom="${cmOf(mb)}"/>` +
                `<style:table-cell-properties fo:border-left="${border(look.borders.l)}" fo:border-right="${border(look.borders.r)}" fo:border-top="${border(look.borders.t)}" fo:border-bottom="${border(look.borders.b)}"${fill[0] === 'draw:fill="solid"' ? ` fo:background-color="${/#\w+/.exec(fill[1])?.[0]}"` : ''}/>`,
            );
            return `<table:table-cell table:style-name="${style}"${cell.gridSpan && cell.gridSpan > 1 ? ` table:number-columns-spanned="${cell.gridSpan}"` : ''}${cell.rowSpan && cell.rowSpan > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : ''}>${this.paragraphs(cell.text.paras, look.chain, ctx) || '<text:p/>'}</table:table-cell>`;
          })
          .join('');
        return `<table:table-row table:style-name="${rs}">${cells}</table:table-row>`;
      })
      .join('');
    const style = this.graphic.name('graphic', '<style:graphic-properties draw:fill="none" draw:stroke="none"/>');
    return `<draw:frame draw:style-name="${style}"${name} draw:layer="layout"${this.box(x)}><table:table>${cols}${rows}</table:table></draw:frame>`;
  }

  masterName = 'Default';

  pageStyle(ctx: SlideCtx, slide: Slide): string {
    const fill = this.fillAttrs(background(ctx), ctx);
    return this.page.name(
      'drawing-page',
      `<style:drawing-page-properties ${fill.join(' ')} draw:background-size="full" presentation:background-visible="true" presentation:background-objects-visible="true" presentation:display-footer="false" presentation:display-page-number="false" presentation:display-date-time="false"${slide.hidden ? ' presentation:visibility="hidden"' : ''}/>`,
    );
  }
}

const FOOTER_PH = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/** Presentation styles every master page needs by name (title, outline levels...). */
function masterPresStyles(name: string, theme: { majorFont: string; minorFont: string }, fonts: FontFaces): string {
  const major = esc(fonts.use(theme.majorFont)!);
  const minor = esc(fonts.use(theme.minorFont)!);
  const g = '<style:graphic-properties draw:stroke="none" draw:fill="none"/>';
  const out = [
    `<style:style style:name="${name}-title" style:family="presentation">${g}<style:paragraph-properties fo:text-align="start"/><style:text-properties style:font-name="${major}" fo:font-size="44pt"/></style:style>`,
    `<style:style style:name="${name}-subtitle" style:family="presentation">${g}<style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="${minor}" fo:font-size="24pt"/></style:style>`,
    `<style:style style:name="${name}-notes" style:family="presentation">${g}<style:text-properties style:font-name="${minor}" fo:font-size="12pt"/></style:style>`,
    `<style:style style:name="${name}-background" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>`,
    `<style:style style:name="${name}-backgroundobjects" style:family="presentation"><style:graphic-properties draw:shadow="hidden"/></style:style>`,
  ];
  for (let i = 1; i <= 9; i++) {
    out.push(`<style:style style:name="${name}-outline${i}" style:family="presentation"${i > 1 ? ` style:parent-style-name="${name}-outline${i - 1}"` : ''}>${i === 1 ? g : ''}<style:text-properties style:font-name="${minor}" fo:font-size="${[28, 24, 20, 18, 18, 18, 18, 18, 18][i - 1]}pt"/></style:style>`);
  }
  return out.join('');
}

/** The deck as .odp bytes (or .otp, .fodp by `ext`). */
export function writeOdp(pkg: OpcPackage, deck: Deck, ext = 'odp'): Uint8Array {
  const fonts = new FontFaces();
  const media = new OdfMedia();
  const named: Named = { gradients: new Map(), images: new Map(), xml: [] };
  const body = new OdpWriter(deck, pkg, fonts, media, named, '');
  const master = new OdpWriter(deck, pkg, fonts, media, named, 'M');
  const masters = new Map<string, { name: string; xml: string }>();
  const masterFor = (slide: Slide, ctx: SlideCtx): string => {
    const layout: Layout = ctx.layout;
    const showMaster = layout.showMasterSp !== false && slide.showMasterSp !== false;
    const key = `${layout.part}|${showMaster}`;
    let m = masters.get(key);
    if (!m) {
      const name = masters.size ? `Din${masters.size + 1}` : 'Default';
      const lctx = layoutCtx(deck, layout);
      const deco = (shapes: Shape[]) => shapes.filter((s) => !('ph' in s && s.ph)).map((s) => (lctx ? master.shape(s, lctx, (x) => x, true) : '')).join('');
      master.masterName = name;
      const shapes = (showMaster ? deco(ctx.master.shapes) : '') + deco(layout.shapes);
      const bg = lctx ? master.pageStyle(lctx, { ...slide, hidden: false }) : '';
      m = {
        name,
        xml: `<style:master-page style:name="${name}" style:display-name="${esc(layout.name || name)}" style:page-layout-name="PM1"${bg ? ` draw:style-name="${bg}"` : ''}>${shapes}</style:master-page>`,
      };
      masters.set(key, m);
    }
    return m.name;
  };

  const pages = deck.slides.map((slide, i) => {
    const ctx = slideCtx(deck, slide, i, () => null);
    if (!ctx) return '';
    const mName = masterFor(slide, ctx);
    body.masterName = mName;
    const shapes = slide.shapes
      .map((s) => {
        // Footer placeholders keep their text as ordinary text boxes.
        if ('ph' in s && s.ph && FOOTER_PH.has(s.ph.type ?? '')) {
          if (s.kind !== 'sp' || !s.text?.paras.some((p) => p.runs.length)) return '';
        }
        return body.shape(s, ctx, (x) => x, false);
      })
      .join('');
    const notes = slide.notes
      ? `<presentation:notes><draw:frame presentation:style-name="${body.pres.name('presentation', '<style:graphic-properties draw:fill="none" draw:stroke="none"/>', { 'style:parent-style-name': `${mName}-notes` })}" draw:layer="layout" svg:width="17.5cm" svg:height="13cm" svg:x="2cm" svg:y="13.5cm" presentation:class="notes"><draw:text-box>${slide.notes
          .split('\n')
          .map((l) => `<text:p>${textXml(l)}</text:p>`)
          .join('')}</draw:text-box></draw:frame></presentation:notes>`
      : '';
    return `<draw:page draw:name="${esc(slide.name ?? `Slide ${i + 1}`)}" draw:style-name="${body.pageStyle(ctx, slide)}" draw:master-page-name="${mName}">${shapes}${notes}</draw:page>`;
  });
  if (!masters.size) masters.set('', { name: 'Default', xml: '<style:master-page style:name="Default" style:page-layout-name="PM1"/>' });

  const theme = Object.values(deck.masters)[0]?.theme ?? { majorFont: 'Calibri Light', minorFont: 'Calibri' };
  const presStyles = [...masters.values()].map((m) => masterPresStyles(m.name, theme, fonts)).join('');
  const layout = `<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${cmOf(deck.w)}" fo:page-height="${cmOf(deck.h)}" style:print-orientation="${deck.w >= deck.h ? 'landscape' : 'portrait'}"/></style:page-layout>`;
  const minor = esc(fonts.use(theme.minorFont)!);
  const defaults =
    `<style:default-style style:family="graphic"><style:graphic-properties svg:stroke-width="0cm" svg:stroke-color="#000000" draw:fill-color="#4472C4" draw:shadow="hidden"/><style:paragraph-properties style:writing-mode="lr-tb"/><style:text-properties style:font-name="${minor}" fo:font-size="18pt" fo:language="en" fo:country="US"/></style:default-style>` +
    '<draw:marker draw:name="Din_Arrow" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>' +
    '<draw:stroke-dash draw:name="Din_Dash" draw:style="rect" draw:dots1="1" draw:dots1-length="0.3cm" draw:distance="0.2cm"/>';
  const masterXml = [...masters.values()].map((m) => m.xml).join('');
  const stylesXml = odfRoot(
    'office:document-styles',
    `${fonts.xml()}<office:styles>${defaults}${named.xml.join('')}${presStyles}</office:styles><office:automatic-styles>${layout}${master.autoStylesXml()}</office:automatic-styles><office:master-styles>${masterXml}</office:master-styles>`,
  );
  const contentXml = odfRoot(
    'office:document-content',
    `${fonts.xml()}<office:automatic-styles>${body.autoStylesXml()}</office:automatic-styles><office:body><office:presentation>${pages.join('')}</office:presentation></office:body>`,
  );
  return writeOdf({
    mimetype: ext === 'otp' ? ODF_MIME.presentationTemplate : ODF_MIME.presentation,
    content: contentXml,
    styles: stylesXml,
    files: media.files,
    generator: 'Din Slides',
    flat: ext === 'fodp',
  });
}
