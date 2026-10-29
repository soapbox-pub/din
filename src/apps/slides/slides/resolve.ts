import { hexToRgb, hslToRgb, rgbToHex, rgbToHsl, schemeName, type Theme } from '@/shared/office/theme';
import {
  DEFAULT_CLR_MAP,
  type Background,
  type BodyProps,
  type Color,
  type Deck,
  type Fill,
  type Layout,
  type Line,
  type ListStyle,
  type Master,
  type ParaProps,
  type Placeholder,
  type RunProps,
  type Shape,
  type ShapeStyle,
  type Slide,
  type SlideCtx,
  type SpShape,
  type Xfrm,
} from './model';

/**
 * What a shape looks like once everything it inherits is applied: a slide
 * placeholder takes its position and text styles from the matching
 * placeholder on its layout, which takes them from the master; text falls
 * back to the master's title/body/other styles and the presentation's
 * defaults; fills and outlines can come from the theme through p:style.
 */

export function slideCtx(deck: Deck, slide: Slide, index: number, media: SlideCtx['media']): SlideCtx | null {
  const layout = deck.layouts[slide.layout] ?? Object.values(deck.layouts)[0];
  if (!layout) return null;
  const master = deck.masters[layout.master] ?? Object.values(deck.masters)[0];
  if (!master) return null;
  const clrMap = slide.clrMapOvr ?? layout.clrMapOvr ?? master.clrMap ?? DEFAULT_CLR_MAP;
  return { deck, slide, layout, master, theme: master.theme, clrMap, slideNumber: index + 1, media };
}

// ---- Colors -------------------------------------------------------------------------

export interface Rgba {
  hex: string;
  alpha: number;
}

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const fromLinear = (l: number) => {
  const v = Math.max(0, Math.min(1, l));
  return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
};

export function resolveColorModel(c: Color | undefined, theme: Theme, clrMap: Record<string, string>, phClr?: Rgba): Rgba | null {
  if (!c) return null;
  let hex: string;
  let alpha = 1;
  if (c.scheme === 'phClr') {
    hex = phClr?.hex ?? '000000';
    alpha = phClr?.alpha ?? 1;
  } else if (c.scheme) {
    const name = schemeName(c.scheme, clrMap);
    hex = name ? theme.colors[name] : '000000';
  } else hex = c.hex ?? '000000';
  if (!c.mods?.length) return { hex, alpha };
  let [r, g, b] = hexToRgb(hex);
  let lumMod = 1;
  let lumOff = 0;
  let satMod = 1;
  for (const [name, raw] of c.mods) {
    const v = raw / 100000;
    switch (name) {
      case 'alpha': alpha = v; break;
      case 'alphaModFix': case 'alphaMod': alpha *= v; break;
      case 'lumMod': lumMod = v; break;
      case 'lumOff': lumOff = v; break;
      case 'satMod': satMod = v; break;
      // Office tints and shades in linear light, not in sRGB.
      case 'tint': [r, g, b] = [r, g, b].map((c) => fromLinear(1 - (1 - toLinear(c)) * v)) as [number, number, number]; break;
      case 'shade': [r, g, b] = [r, g, b].map((c) => fromLinear(toLinear(c) * v)) as [number, number, number]; break;
    }
  }
  hex = rgbToHex(r, g, b);
  if (lumMod !== 1 || lumOff !== 0 || satMod !== 1) {
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    hex = rgbToHex(...hslToRgb(h, Math.min(1, s * satMod), Math.max(0, Math.min(1, l * lumMod + lumOff))));
  }
  return { hex, alpha };
}

export function css(c: Rgba | null | undefined): string | undefined {
  if (!c) return undefined;
  if (c.alpha >= 1) return `#${c.hex}`;
  const [r, g, b] = hexToRgb(c.hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, c.alpha).toFixed(3)})`;
}

export function colorCss(c: Color | undefined, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>, phClr?: Rgba): string | undefined {
  return css(resolveColorModel(c, ctx.theme, ctx.clrMap, phClr));
}

/** Darken / lighten a resolved color the way cube and can sides shade it. */
export function shade(hex: string, kind: string): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const f = { darken: 0.6, darkenLess: 0.8, lighten: 1.4, lightenLess: 1.2 }[kind] ?? 1;
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(1, f > 1 ? l + (1 - l) * (f - 1) : l * f))));
}

export function fontName(font: string | undefined, theme: Theme): string | undefined {
  if (!font) return undefined;
  if (font.startsWith('+mj')) return theme.majorFont;
  if (font.startsWith('+mn')) return theme.minorFont;
  return font;
}

// ---- Placeholders -------------------------------------------------------------------

const phType = (ph: Placeholder) => ph.type ?? 'obj';

function matchPh(shapes: Shape[], ph: Placeholder, byIdx: boolean): Shape | undefined {
  const withPh = shapes.filter((s): s is Shape & { ph: Placeholder } => 'ph' in s && !!s.ph);
  const type = phType(ph);
  if (byIdx && ph.idx !== undefined) {
    const hit = withPh.find((s) => s.ph.idx === ph.idx);
    if (hit) return hit;
  }
  const same = withPh.find((s) => phType(s.ph) === type);
  if (same) return same;
  const alias: Record<string, string> = { ctrTitle: 'title', title: 'ctrTitle', subTitle: 'body', obj: 'body', body: 'obj' };
  if (alias[type]) {
    const a = withPh.find((s) => phType(s.ph) === alias[type]);
    if (a) return a;
  }
  // Content placeholders (pictures, charts...) borrow a body placeholder's place.
  if (!['title', 'ctrTitle', 'dt', 'ftr', 'sldNum', 'hdr'].includes(type) && byIdx && ph.idx !== undefined) return undefined;
  return undefined;
}

function masterPh(master: Master, ph: Placeholder): Shape | undefined {
  const type = phType(ph);
  const t = type === 'ctrTitle' ? 'title' : ['subTitle', 'obj', 'pic', 'chart', 'tbl', 'dgm', 'media', 'clipArt'].includes(type) ? 'body' : type;
  return matchPh(master.shapes, { type: t }, false);
}

/** The layout and master placeholders a slide shape inherits from, nearest first. */
export function inheritChain(shape: Shape, ctx: Pick<SlideCtx, 'layout' | 'master'>, onLayout = false): Shape[] {
  const ph = 'ph' in shape ? shape.ph : undefined;
  if (!ph) return [];
  if (onLayout) {
    const m = masterPh(ctx.master, ph);
    return m ? [m] : [];
  }
  const out: Shape[] = [];
  const l = matchPh(ctx.layout.shapes, ph, true);
  if (l) out.push(l);
  const m = masterPh(ctx.master, (l && 'ph' in l && l.ph) || ph);
  if (m) out.push(m);
  return out;
}

export function effectiveXfrm(shape: Shape, chain: Shape[]): Xfrm | undefined {
  if (shape.xfrm) return shape.xfrm;
  for (const s of chain) if (s.xfrm) return s.xfrm;
  return undefined;
}

// ---- Text styles ----------------------------------------------------------------------

export interface TextStyleChain {
  /** List styles nearest first: the shape's own, its placeholders', the master's. */
  lists: ListStyle[];
  body: BodyProps;
  /** The theme font and color p:style's fontRef gives a shape's text. */
  fontRef?: { font?: string; color?: Color };
  /** How many of `lists` belong to the shape and its placeholders (the rest are the master's). */
  own: number;
  isTitle: boolean;
}

function masterListFor(ph: Placeholder | undefined, master: Master): ListStyle {
  if (!ph) return master.other;
  const t = phType(ph);
  if (t === 'title' || t === 'ctrTitle') return master.title;
  if (['dt', 'ftr', 'sldNum', 'hdr'].includes(t)) return master.other;
  return master.body;
}

const DEFAULT_BODY: BodyProps = { lIns: 91440, tIns: 45720, rIns: 91440, bIns: 45720, anchor: 't', wrap: 'square' };

export function textChain(shape: Shape, chain: Shape[], ctx: Pick<SlideCtx, 'master' | 'deck'>, own?: { lst?: ListStyle; body?: BodyProps }): TextStyleChain {
  const lists: ListStyle[] = [];
  const bodies: BodyProps[] = [];
  const sp = shape.kind === 'sp' ? shape : null;
  const ownLst = own?.lst ?? sp?.text?.lst;
  if (ownLst) lists.push(ownLst);
  const ownBody = own?.body ?? sp?.text?.body;
  if (ownBody) bodies.push(ownBody);
  for (const s of chain) {
    if (s.kind === 'sp' && s.text) {
      if (s.text.lst) lists.push(s.text.lst);
      bodies.push(s.text.body);
    }
  }
  const ph = 'ph' in shape ? shape.ph : undefined;
  const ownCount = lists.length;
  lists.push(masterListFor(ph, ctx.master));
  lists.push(ctx.deck.defaultText);
  const body: BodyProps = { ...DEFAULT_BODY };
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    for (const [k, v] of Object.entries(b)) if (v !== undefined && k !== 'raw' && k !== 'attrs') (body as Record<string, unknown>)[k] = v;
    // Autofit's numbers belong to the box that measured them.
    if (i > 0 && b.autofit === 'norm') {
      delete body.fontScale;
      delete body.lnSpcReduction;
    }
  }
  if (!ownBody?.autofit && bodies.length) {
    // fontScale only applies to the shape's own text.
    delete body.fontScale;
    delete body.lnSpcReduction;
  }
  const style = shapeStyle(shape, chain);
  const fontRef = style?.font
    ? { font: style.font.idx === 'major' ? '+mj-lt' : style.font.idx === 'minor' ? '+mn-lt' : undefined, color: style.font.color }
    : undefined;
  return { lists, body, fontRef, own: ownCount, isTitle: ph?.type === 'title' || ph?.type === 'ctrTitle' };
}

function mergeRun(into: RunProps, from: RunProps | undefined): RunProps {
  if (!from) return into;
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined || k === 'raw' || k === 'attrs' || k === 'link') continue;
    if (!(k in out) || (out as Record<string, unknown>)[k] === undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface ResolvedPara {
  algn: string;
  marL: number;
  indent: number;
  lnSpc?: ParaProps['lnSpc'];
  spcBef?: ParaProps['spcBef'];
  spcAft?: ParaProps['spcAft'];
  bullet: ParaProps['bullet'];
  buFont?: string;
  buClr?: Color;
  buSzPct?: number;
  /** Run defaults for this paragraph: what runs without their own props look like. */
  run: RunProps;
}

/** A paragraph's properties with its level's styles filled in. */
export function resolvePara(props: ParaProps, chain: TextStyleChain): ResolvedPara {
  const lvl = Math.max(0, Math.min(8, props.lvl ?? 0));
  const levels: ParaProps[] = [props];
  let ownLevels = 1;
  chain.lists.forEach((l, i) => {
    const p = l.levels[lvl];
    if (p) levels.push(p);
    if (l.def) levels.push(l.def);
    if (i < chain.own) ownLevels = levels.length;
  });
  const pick = <K extends keyof ParaProps>(k: K): ParaProps[K] | undefined => {
    for (const p of levels) if (p[k] !== undefined) return p[k];
    return undefined;
  };
  let run: RunProps = {};
  levels.slice(0, ownLevels).forEach((p) => (run = mergeRun(run, p.defRPr)));
  // fontRef sits under the shape's own list styles but over the master's.
  if (chain.fontRef?.color && run.color === undefined) run.color = chain.fontRef.color;
  if (chain.fontRef?.font && run.font === undefined) run.font = chain.fontRef.font;
  levels.slice(ownLevels).forEach((p) => (run = mergeRun(run, p.defRPr)));
  let bullet = pick('bullet');
  if (props.bullet === undefined && bullet === undefined) bullet = { type: 'none' };
  return {
    algn: pick('algn') ?? 'l',
    marL: pick('marL') ?? 0,
    indent: pick('indent') ?? 0,
    lnSpc: pick('lnSpc'),
    spcBef: pick('spcBef'),
    spcAft: pick('spcAft'),
    bullet,
    buFont: pick('buFontTx') ? undefined : pick('buFont'),
    buClr: pick('buClrTx') ? undefined : pick('buClr'),
    buSzPct: pick('buSzPct'),
    run,
  };
}

export function resolveRun(props: RunProps, para: ResolvedPara): RunProps {
  return mergeRun({ ...props }, para.run);
}

// ---- Fill and outline -------------------------------------------------------------------

export function shapeStyle(shape: Shape, chain: Shape[]): ShapeStyle | undefined {
  const own = shape.kind === 'sp' || shape.kind === 'pic' ? shape.style : undefined;
  if (own) return own;
  for (const s of chain) if ((s.kind === 'sp' || s.kind === 'pic') && s.style) return s.style;
  return undefined;
}

export interface Paint {
  fill: Fill;
  /** The color phClr stands for in a theme fill. */
  phClr?: Rgba;
}

export function themeFill(master: Master, idx: number, color: Color | undefined, ctx: Pick<SlideCtx, 'theme' | 'clrMap'>): Paint | null {
  if (!idx) return null;
  const list = idx >= 1000 ? master.fmt.bgFills : master.fmt.fills;
  const f = list[(idx >= 1000 ? idx - 1000 : idx) - 1];
  if (!f) return color ? { fill: { type: 'solid', color } } : null;
  return { fill: f, phClr: resolveColorModel(color, ctx.theme, ctx.clrMap) ?? undefined };
}

export function shapeFill(shape: SpShape | Shape, chain: Shape[], ctx: SlideCtx): Paint | null {
  for (const s of [shape, ...chain]) {
    if ((s.kind === 'sp' || s.kind === 'pic' || s.kind === 'grp') && s.fill) return { fill: s.fill };
  }
  const st = shapeStyle(shape, chain);
  if (st?.fill && typeof st.fill.idx === 'number') return themeFill(ctx.master, st.fill.idx, st.fill.color, ctx);
  return null;
}

export interface Stroke {
  line: Line;
  phClr?: Rgba;
}

export function shapeLine(shape: Shape, chain: Shape[], ctx: SlideCtx): Stroke | null {
  let own: Line | undefined;
  for (const s of [shape, ...chain]) {
    if ((s.kind === 'sp' || s.kind === 'pic') && s.line) {
      own = { ...s.line, ...own };
      if (own.fill) break;
    }
  }
  const st = shapeStyle(shape, chain);
  let base: Line | undefined;
  let phClr: Rgba | undefined;
  if (st?.ln && typeof st.ln.idx === 'number' && st.ln.idx > 0) {
    base = ctx.master.fmt.lines[st.ln.idx - 1];
    phClr = resolveColorModel(st.ln.color, ctx.theme, ctx.clrMap) ?? undefined;
    if (!base && st.ln.color) base = { fill: { type: 'solid', color: st.ln.color }, w: 12700 };
  }
  if (!own && !base) return null;
  const line: Line = { ...base, ...own };
  if (!line.fill) return null;
  return phClr ? { line, phClr } : { line };
}

export function background(ctx: SlideCtx): Paint | null {
  const pick = (bg: Background | undefined): Paint | null => {
    if (!bg) return null;
    if ('fill' in bg) return { fill: bg.fill };
    const idx = typeof bg.ref.idx === 'number' ? bg.ref.idx : 0;
    return themeFill(ctx.master, idx, bg.ref.color, ctx);
  };
  return pick(ctx.slide.bg) ?? pick(ctx.layout.bg) ?? pick(ctx.master.bg) ?? { fill: { type: 'solid', color: { scheme: 'bg1' } } };
}

/** Text shown in an empty placeholder while editing. */
export function promptText(shape: Shape, chain: Shape[]): string | null {
  if (!('ph' in shape) || !shape.ph) return null;
  const layoutPh = chain[0];
  if (shape.ph.hasCustomPrompt || (layoutPh && 'ph' in layoutPh && layoutPh.ph?.hasCustomPrompt)) {
    if (layoutPh?.kind === 'sp' && layoutPh.text) {
      const t = layoutPh.text.paras.map((p) => p.runs.map((r) => (r.kind === 'br' ? '\n' : r.text)).join('')).join('\n');
      if (t.trim()) return t;
    }
  }
  switch (shape.ph.type) {
    case 'title':
    case 'ctrTitle':
      return 'Click to add title';
    case 'subTitle':
      return 'Click to add subtitle';
    case 'dt':
    case 'ftr':
    case 'sldNum':
    case 'hdr':
      return null;
    case 'pic':
      return 'Click icon to add picture';
    case 'body':
    case 'obj':
    case undefined:
      return 'Click to add text';
  }
  return 'Click to add text';
}

/** The layout a shape is on, when a layout itself is drawn. */
export function layoutCtx(deck: Deck, layout: Layout): SlideCtx | null {
  const master = deck.masters[layout.master];
  if (!master) return null;
  const slide: Slide = { uid: `layout:${layout.part}`, layout: layout.part, shapes: layout.shapes, notes: '' };
  return { deck, slide, layout, master, theme: master.theme, clrMap: layout.clrMapOvr ?? master.clrMap, slideNumber: 1, media: () => null };
}
