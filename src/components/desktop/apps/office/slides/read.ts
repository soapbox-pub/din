import { at, attr, kid, kids, NS, numAttr, OpcPackage, parseXml, REL, serialize, type Rel } from '../ooxml';
import { OFFICE_THEME, parseTheme, resolveColor } from '../theme';
import { rememberCustGeom } from './geometry';
import {
  DEFAULT_CLR_MAP,
  newUid,
  type Background,
  type BodyProps,
  type BorderSide,
  type Color,
  type Crop,
  type Deck,
  type Fill,
  type FmtScheme,
  type FrameShape,
  type Geometry,
  type Layout,
  type Line,
  type LineEnd,
  type ListStyle,
  type Master,
  type Para,
  type ParaProps,
  type Placeholder,
  type RawKids,
  type RunProps,
  type Shape,
  type ShapeStyle,
  type Slide,
  type Spacing,
  type StyleRef,
  type Table,
  type TableStyle,
  type TableStylePart,
  type TextBody,
  type Transition,
  type Xfrm,
} from './model';
import { MEDIUM_STYLE_2, tableStyleListXml, tableStyleXml } from './tableStyles';

/**
 * Reading a .pptx: presentation.xml's slide list and size, each slide with
 * its layout and master, the theme, notes, and table styles. Anything a
 * part holds that Slides doesn't model is kept as XML; relationship ids in
 * it become tokens naming their targets (see relToken), so a shape copied
 * to another slide or a slide written to a new part still points where it
 * pointed.
 */

export function relToken(rel: Rel): string {
  return `§${rel.type}§${rel.target}§${rel.external ? 1 : 0}§`;
}

class PartReader {
  private relMap: Map<string, Rel>;
  constructor(
    readonly pkg: OpcPackage,
    readonly part: string,
  ) {
    this.relMap = new Map(pkg.rels(part).map((r) => [r.id, r]));
  }
  rel(id: string | null): Rel | undefined {
    return id ? this.relMap.get(id) : undefined;
  }
  /** Package path an r:embed / r:id points at. */
  target(id: string | null): string | null {
    const r = this.rel(id);
    return r && !r.external ? r.target : null;
  }
  /** XML to carry along, with its relationship ids turned into tokens. */
  raw(el: Element): string {
    const copy = el.cloneNode(true) as Element;
    const all = [copy, ...Array.from(copy.getElementsByTagName('*'))];
    const originals = [el, ...Array.from(el.getElementsByTagName('*'))];
    all.forEach((e, i) => {
      // mc:Choice names namespaces by prefix in an attribute value, which a
      // serializer doesn't know to declare.
      const req = e.localName === 'Choice' ? e.getAttribute('Requires') : null;
      for (const prefix of req?.split(/\s+/) ?? []) {
        const uri = originals[i].lookupNamespaceURI(prefix);
        if (uri && !e.hasAttribute(`xmlns:${prefix}`)) e.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
      }
    });
    for (const e of all) {
      for (const a of Array.from(e.attributes)) {
        if (a.namespaceURI !== NS.r) continue;
        const r = this.rel(a.value);
        if (r) e.setAttributeNS(NS.r, a.name, relToken(r));
      }
    }
    return serialize(copy);
  }
}

// ---- DrawingML basics ----------------------------------------------------------------

export function parseColor(c: Element | null | undefined): Color | undefined {
  if (!c) return undefined;
  const mods = kids(c).map((m): [string, number] => [m.localName, numAttr(m, 'val') ?? 0]);
  const withMods = (base: Color): Color => (mods.length ? { ...base, mods } : base);
  switch (c.localName) {
    case 'srgbClr':
      return withMods({ hex: (attr(c, 'val') ?? '000000').toUpperCase() });
    case 'schemeClr':
      return withMods({ scheme: attr(c, 'val') ?? 'tx1' });
    case 'sysClr':
      return withMods({ hex: (attr(c, 'lastClr') ?? (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000')).toUpperCase() });
    case 'prstClr':
    case 'scrgbClr':
    case 'hslClr': {
      const r = resolveColor(c, OFFICE_THEME);
      return r ? { hex: r.hex, ...(r.alpha < 1 ? { mods: [['alpha', Math.round(r.alpha * 100000)]] } : {}) } : undefined;
    }
  }
  return undefined;
}

/** The color inside a fill-like wrapper (a:solidFill, a:buClr, a:lnRef...). */
const colorIn = (el: Element | null | undefined) => parseColor(el?.firstElementChild);

const FILL_NAMES = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);

function parseFillEl(f: Element, r: PartReader): Fill | undefined {
  switch (f.localName) {
    case 'noFill':
      return { type: 'none' };
    case 'solidFill': {
      const color = colorIn(f);
      return color ? { type: 'solid', color } : { type: 'none' };
    }
    case 'gradFill': {
      const stops = kids(kid(f, 'gsLst'), 'gs')
        .map((g) => ({ pos: (numAttr(g, 'pos') ?? 0) / 100000, color: colorIn(g) }))
        .filter((s): s is { pos: number; color: Color } => !!s.color)
        .sort((a, b) => a.pos - b.pos);
      const lin = kid(f, 'lin');
      const path = attr(kid(f, 'path'), 'path') as 'circle' | 'rect' | 'shape' | null;
      return { type: 'grad', stops, angle: (numAttr(lin, 'ang') ?? 5400000) / 60000, ...(path ? { path } : {}), raw: r.raw(f) };
    }
    case 'blipFill': {
      const blip = kid(f, 'blip');
      const media = r.target(attr(blip, 'embed') !== null ? blip!.getAttributeNS(NS.r, 'embed') || attr(blip, 'embed') : null);
      const duo = kids(kid(blip, 'duotone')).map(parseColor).filter((c): c is Color => !!c);
      return { type: 'blip', media, tile: !!kid(f, 'tile'), crop: parseCrop(kid(f, 'srcRect')), ...(duo.length === 2 ? { duotone: [duo[0], duo[1]] as [Color, Color] } : {}), raw: r.raw(f) };
    }
    case 'pattFill': {
      const fg = colorIn(kid(f, 'fgClr')) ?? { hex: '000000' };
      const bg = colorIn(kid(f, 'bgClr')) ?? { hex: 'FFFFFF' };
      return { type: 'patt', fg, bg, prst: attr(f, 'prst') ?? 'pct50' };
    }
    case 'grpFill':
      return { type: 'grp' };
  }
  return undefined;
}

function parseFill(container: Element | null | undefined, r: PartReader): Fill | undefined {
  for (const c of kids(container)) if (FILL_NAMES.has(c.localName)) return parseFillEl(c, r);
  return undefined;
}

function parseCrop(el: Element | null): Crop | undefined {
  if (!el) return undefined;
  const v = (k: string) => (numAttr(el, k) ?? 0) / 100000;
  const crop = { l: v('l'), t: v('t'), r: v('r'), b: v('b') };
  return crop.l || crop.t || crop.r || crop.b ? crop : undefined;
}

function lineEnd(el: Element | null): LineEnd | undefined {
  const type = attr(el, 'type');
  if (!el || !type || type === 'none') return undefined;
  return { type, ...(attr(el, 'w') ? { w: attr(el, 'w')! } : {}), ...(attr(el, 'len') ? { len: attr(el, 'len')! } : {}) };
}

function parseLine(ln: Element | null | undefined, r: PartReader): Line | undefined {
  if (!ln) return undefined;
  const line: Line = {};
  const w = numAttr(ln, 'w');
  if (w !== null) line.w = w;
  const cap = attr(ln, 'cap');
  if (cap) line.cap = cap;
  const raw: RawKids = {};
  for (const c of kids(ln)) {
    if (FILL_NAMES.has(c.localName)) {
      const f = parseFillEl(c, r);
      // Gradient outlines draw with their first color.
      line.fill = f?.type === 'grad' ? (f.stops[0] ? { type: 'solid', color: f.stops[0].color } : { type: 'none' }) : f;
    } else if (c.localName === 'prstDash') line.dash = attr(c, 'val') ?? 'solid';
    else if (c.localName === 'headEnd') line.head = lineEnd(c);
    else if (c.localName === 'tailEnd') line.tail = lineEnd(c);
    else raw[c.localName] = r.raw(c);
  }
  if (Object.keys(raw).length) line.raw = raw;
  return line;
}

export function parseXfrm(el: Element | null | undefined): Xfrm | undefined {
  if (!el) return undefined;
  const off = kid(el, 'off');
  const ext = kid(el, 'ext');
  if (!off && !ext) return undefined;
  const x: Xfrm = { x: numAttr(off, 'x') ?? 0, y: numAttr(off, 'y') ?? 0, w: numAttr(ext, 'cx') ?? 0, h: numAttr(ext, 'cy') ?? 0 };
  const rot = numAttr(el, 'rot');
  if (rot) x.rot = rot / 60000;
  if (attr(el, 'flipH') === '1' || attr(el, 'flipH') === 'true') x.flipH = true;
  if (attr(el, 'flipV') === '1' || attr(el, 'flipV') === 'true') x.flipV = true;
  return x;
}

function parseGeom(spPr: Element | null): Geometry | undefined {
  const prst = kid(spPr, 'prstGeom');
  if (prst) {
    const adj: Record<string, number> = {};
    for (const gd of kids(kid(prst, 'avLst'), 'gd')) {
      const m = /^val\s+(-?[\d.]+)/.exec(attr(gd, 'fmla') ?? '');
      if (m) adj[attr(gd, 'name') ?? 'adj'] = Number(m[1]);
    }
    return { prst: attr(prst, 'prst') ?? 'rect', ...(Object.keys(adj).length ? { adj } : {}) };
  }
  const cust = kid(spPr, 'custGeom');
  if (cust) {
    const xml = serialize(cust);
    rememberCustGeom(xml, cust);
    return { cust: xml };
  }
  return undefined;
}

function styleRef(el: Element | null): StyleRef | undefined {
  if (!el) return undefined;
  const idxRaw = attr(el, 'idx') ?? '0';
  const idx = /^\d+$/.test(idxRaw) ? Number(idxRaw) : idxRaw;
  const color = colorIn(el);
  return color ? { idx, color } : { idx };
}

function parseStyle(el: Element | null): ShapeStyle | undefined {
  if (!el) return undefined;
  const s: ShapeStyle = {};
  const ln = styleRef(kid(el, 'lnRef'));
  const fill = styleRef(kid(el, 'fillRef'));
  const effect = styleRef(kid(el, 'effectRef'));
  const font = styleRef(kid(el, 'fontRef'));
  if (ln) s.ln = ln;
  if (fill) s.fill = fill;
  if (effect) s.effect = effect;
  if (font) s.font = font;
  return s;
}

// ---- Text ---------------------------------------------------------------------------

const DROP_ATTRS = new Set(['dirty', 'err', 'smtClean', 'smtId', 'noProof', 'bmk']);

function restAttrs(el: Element, known: Set<string>): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('xmlns') || known.has(a.localName) || DROP_ATTRS.has(a.localName)) continue;
    (out ??= {})[a.name] = a.value;
  }
  return out;
}

const RUN_ATTRS = new Set(['sz', 'b', 'i', 'u', 'strike', 'baseline', 'cap', 'spc']);

export function parseRunProps(el: Element | null | undefined, r: PartReader): RunProps {
  const p: RunProps = {};
  if (!el) return p;
  const sz = numAttr(el, 'sz');
  if (sz !== null) p.sz = sz;
  const b = attr(el, 'b');
  if (b !== null) p.b = b === '1' || b === 'true';
  const i = attr(el, 'i');
  if (i !== null) p.i = i === '1' || i === 'true';
  const u = attr(el, 'u');
  if (u !== null) p.u = u;
  const strike = attr(el, 'strike');
  if (strike !== null) p.strike = strike;
  const baseline = numAttr(el, 'baseline');
  if (baseline !== null) p.baseline = baseline;
  const cap = attr(el, 'cap');
  if (cap !== null) p.cap = cap;
  const spc = numAttr(el, 'spc');
  if (spc !== null) p.spc = spc;
  const attrs = restAttrs(el, RUN_ATTRS);
  if (attrs) p.attrs = attrs;
  const raw: RawKids = {};
  for (const c of kids(el)) {
    switch (c.localName) {
      case 'solidFill': {
        const color = colorIn(c);
        if (color) p.color = color;
        break;
      }
      case 'gradFill': {
        const g = parseFillEl(c, r);
        if (g?.type === 'grad' && g.stops[0]) p.color = g.stops[0].color;
        break;
      }
      case 'highlight': {
        const color = colorIn(c);
        if (color) p.highlight = color;
        break;
      }
      case 'latin':
        p.font = attr(c, 'typeface') ?? undefined;
        break;
      case 'hlinkClick': {
        const rel = r.rel(c.getAttributeNS(NS.r, 'id') || attr(c, 'id'));
        if (rel?.external && /^(https?:|mailto:)/i.test(rel.target) && !attr(c, 'action')) p.link = rel.target;
        else raw.hlinkClick = r.raw(c);
        break;
      }
      default:
        raw[c.localName] = r.raw(c);
    }
  }
  if (Object.keys(raw).length) p.raw = raw;
  return p;
}

const PARA_ATTRS = new Set(['marL', 'lvl', 'indent', 'algn']);

function spacing(el: Element | null): Spacing | undefined {
  if (!el) return undefined;
  const pct = kid(el, 'spcPct');
  if (pct) return { pct: (numAttr(pct, 'val') ?? 100000) / 100000 };
  const pts = kid(el, 'spcPts');
  if (pts) return { pts: (numAttr(pts, 'val') ?? 0) / 100 };
  return undefined;
}

export function parseParaProps(el: Element | null | undefined, r: PartReader): ParaProps {
  const p: ParaProps = {};
  if (!el) return p;
  const marL = numAttr(el, 'marL');
  if (marL !== null) p.marL = marL;
  const lvl = numAttr(el, 'lvl');
  if (lvl !== null) p.lvl = lvl;
  const indent = numAttr(el, 'indent');
  if (indent !== null) p.indent = indent;
  const algn = attr(el, 'algn');
  if (algn) p.algn = algn;
  const attrs = restAttrs(el, PARA_ATTRS);
  if (attrs) p.attrs = attrs;
  const raw: RawKids = {};
  for (const c of kids(el)) {
    switch (c.localName) {
      case 'lnSpc': p.lnSpc = spacing(c); break;
      case 'spcBef': p.spcBef = spacing(c); break;
      case 'spcAft': p.spcAft = spacing(c); break;
      case 'buClrTx': p.buClrTx = true; break;
      case 'buClr': p.buClr = colorIn(c); break;
      case 'buSzPct': p.buSzPct = numAttr(c, 'val') ?? 100000; break;
      case 'buFontTx': p.buFontTx = true; break;
      case 'buFont': p.buFont = attr(c, 'typeface') ?? undefined; break;
      case 'buNone': p.bullet = { type: 'none' }; break;
      case 'buChar': p.bullet = { type: 'char', char: attr(c, 'char') ?? '•' }; break;
      case 'buAutoNum': {
        const start = numAttr(c, 'startAt');
        p.bullet = { type: 'auto', scheme: attr(c, 'type') ?? 'arabicPeriod', ...(start !== null ? { start } : {}) };
        break;
      }
      case 'defRPr': p.defRPr = parseRunProps(c, r); break;
      default: raw[c.localName] = r.raw(c);
    }
  }
  if (Object.keys(raw).length) p.raw = raw;
  return p;
}

export function parseListStyle(el: Element | null | undefined, r: PartReader): ListStyle {
  const ls: ListStyle = { levels: [] };
  if (!el) return ls;
  const def = kid(el, 'defPPr');
  if (def) ls.def = parseParaProps(def, r);
  for (let i = 0; i < 9; i++) {
    const lvl = kid(el, `lvl${i + 1}pPr`);
    if (lvl) ls.levels[i] = parseParaProps(lvl, r);
  }
  return ls;
}

const BODY_ATTRS = new Set(['lIns', 'tIns', 'rIns', 'bIns', 'anchor', 'anchorCtr', 'wrap', 'vert', 'rot', 'numCol']);

function parseBodyProps(el: Element | null, r: PartReader): BodyProps {
  const b: BodyProps = {};
  if (!el) return b;
  for (const k of ['lIns', 'tIns', 'rIns', 'bIns', 'numCol'] as const) {
    const v = numAttr(el, k);
    if (v !== null) b[k] = v;
  }
  const anchor = attr(el, 'anchor');
  if (anchor) b.anchor = anchor;
  const anchorCtr = attr(el, 'anchorCtr');
  if (anchorCtr !== null) b.anchorCtr = anchorCtr === '1' || anchorCtr === 'true';
  const wrap = attr(el, 'wrap');
  if (wrap) b.wrap = wrap;
  const vert = attr(el, 'vert');
  if (vert) b.vert = vert;
  const rot = numAttr(el, 'rot');
  if (rot) b.rot = rot / 60000;
  const attrs = restAttrs(el, BODY_ATTRS);
  if (attrs) b.attrs = attrs;
  const raw: RawKids = {};
  for (const c of kids(el)) {
    if (c.localName === 'noAutofit') b.autofit = 'none';
    else if (c.localName === 'spAutoFit') b.autofit = 'shape';
    else if (c.localName === 'normAutofit') {
      b.autofit = 'norm';
      const fs = numAttr(c, 'fontScale');
      const ls = numAttr(c, 'lnSpcReduction');
      if (fs !== null) b.fontScale = fs;
      if (ls !== null) b.lnSpcReduction = ls;
    } else raw[c.localName] = r.raw(c);
  }
  if (Object.keys(raw).length) b.raw = raw;
  return b;
}

function parseParagraph(p: Element, r: PartReader): Para {
  const para: Para = { props: parseParaProps(kid(p, 'pPr'), r), runs: [] };
  for (const c of kids(p)) {
    if (c.localName === 'r') {
      para.runs.push({ kind: 'text', text: kid(c, 't')?.textContent ?? '', props: parseRunProps(kid(c, 'rPr'), r) });
    } else if (c.localName === 'br') {
      para.runs.push({ kind: 'br', props: parseRunProps(kid(c, 'rPr'), r) });
    } else if (c.localName === 'fld') {
      para.runs.push({ kind: 'field', type: attr(c, 'type') ?? '', id: attr(c, 'id') ?? '{00000000-0000-0000-0000-000000000000}', text: kid(c, 't')?.textContent ?? '', props: parseRunProps(kid(c, 'rPr'), r) });
    } else if (c.localName === 'endParaRPr') {
      para.end = parseRunProps(c, r);
    } else if (c.localName === 'AlternateContent') {
      // Equations: draw the fallback's text.
      const fb = kid(c, 'Fallback');
      for (const fr of kids(fb, 'r')) para.runs.push({ kind: 'text', text: kid(fr, 't')?.textContent ?? '', props: parseRunProps(kid(fr, 'rPr'), r) });
    }
  }
  return para;
}

export function parseTextBody(el: Element | null | undefined, r: PartReader): TextBody | undefined {
  if (!el) return undefined;
  const lst = kid(el, 'lstStyle');
  const body: TextBody = { body: parseBodyProps(kid(el, 'bodyPr'), r), paras: kids(el, 'p').map((p) => parseParagraph(p, r)) };
  if (lst && kids(lst).length) body.lst = parseListStyle(lst, r);
  if (!body.paras.length) body.paras.push({ props: {}, runs: [] });
  return body;
}

// ---- Shapes -------------------------------------------------------------------------

function parsePh(nvPr: Element | null): Placeholder | undefined {
  const ph = kid(nvPr, 'ph');
  if (!ph) return undefined;
  const out: Placeholder = {};
  const type = attr(ph, 'type');
  if (type) out.type = type;
  const idx = numAttr(ph, 'idx');
  if (idx !== null) out.idx = idx;
  const sz = attr(ph, 'sz');
  if (sz) out.sz = sz;
  const orient = attr(ph, 'orient');
  if (orient) out.orient = orient;
  if (attr(ph, 'hasCustomPrompt') === '1') out.hasCustomPrompt = true;
  return out;
}

function base(nv: Element | null, r: PartReader) {
  const c = kid(nv, 'cNvPr');
  const raw: RawKids = {};
  for (const k of kids(c)) raw[`cNvPr.${k.localName}`] = r.raw(k);
  const nvPr = kid(nv, 'nvPr');
  for (const k of kids(nvPr)) if (k.localName !== 'ph') raw[`nvPr.${k.localName}`] = r.raw(k);
  return {
    uid: newUid(),
    id: numAttr(c, 'id') ?? 0,
    name: attr(c, 'name') ?? '',
    ...(attr(c, 'descr') ? { descr: attr(c, 'descr')! } : {}),
    ...(attr(c, 'hidden') === '1' || attr(c, 'hidden') === 'true' ? { hidden: true } : {}),
    ...(Object.keys(raw).length ? { raw } : {}),
  };
}

const SP_PR_KNOWN = new Set(['xfrm', 'prstGeom', 'custGeom', 'ln', ...FILL_NAMES]);

function spRaw(spPr: Element | null, r: PartReader): RawKids | undefined {
  const raw: RawKids = {};
  for (const c of kids(spPr)) if (!SP_PR_KNOWN.has(c.localName)) raw[c.localName] = r.raw(c);
  return Object.keys(raw).length ? raw : undefined;
}

function innerRaw(el: Element | null, r: PartReader): string | undefined {
  if (!el || !el.firstElementChild) return undefined;
  return kids(el).map((c) => r.raw(c)).join('');
}

function parseSp(el: Element, r: PartReader, connector: boolean): Shape {
  const nv = kid(el, connector ? 'nvCxnSpPr' : 'nvSpPr');
  const cNv = kid(nv, connector ? 'cNvCxnSpPr' : 'cNvSpPr');
  const spPr = kid(el, 'spPr');
  const shape: Shape = {
    kind: 'sp',
    ...base(nv, r),
    ...(connector ? { connector: true } : {}),
    ...(attr(cNv, 'txBox') === '1' ? { txBox: true } : {}),
  };
  const ph = parsePh(kid(nv, 'nvPr'));
  if (ph) shape.ph = ph;
  const nvRaw = innerRaw(cNv, r);
  if (nvRaw) shape.nvRaw = nvRaw;
  const xfrm = parseXfrm(kid(spPr, 'xfrm'));
  if (xfrm) shape.xfrm = xfrm;
  const geom = parseGeom(spPr);
  if (geom) shape.geom = geom;
  const fill = parseFill(spPr, r);
  if (fill) shape.fill = fill;
  const line = parseLine(kid(spPr, 'ln'), r);
  if (line) shape.line = line;
  const extra = spRaw(spPr, r);
  if (extra) shape.spRaw = extra;
  const style = parseStyle(kid(el, 'style'));
  if (style) shape.style = style;
  const text = parseTextBody(kid(el, 'txBody'), r);
  if (text) shape.text = text;
  return shape;
}

function parsePic(el: Element, r: PartReader): Shape {
  const nv = kid(el, 'nvPicPr');
  // Mac PowerPoint wraps a PDF picture in mc:AlternateContent, with a bitmap fallback.
  const blipFill = kid(el, 'blipFill') ?? at(el, 'AlternateContent', 'Fallback', 'blipFill');
  const blip = kid(blipFill, 'blip');
  const spPr = kid(el, 'spPr');
  const embed = blip ? blip.getAttributeNS(NS.r, 'embed') || attr(blip, 'embed') : null;
  const shape: Shape = { kind: 'pic', ...base(nv, r), media: r.target(embed) };
  const ph = parsePh(kid(nv, 'nvPr'));
  if (ph) shape.ph = ph;
  const nvRaw = innerRaw(kid(nv, 'cNvPicPr'), r);
  if (nvRaw) shape.nvRaw = nvRaw;
  const blipRaw = innerRaw(blip, r);
  if (blipRaw) shape.blipRaw = blipRaw;
  const crop = parseCrop(kid(blipFill, 'srcRect'));
  if (crop) shape.crop = crop;
  const xfrm = parseXfrm(kid(spPr, 'xfrm'));
  if (xfrm) shape.xfrm = xfrm;
  const geom = parseGeom(spPr);
  if (geom) shape.geom = geom;
  const fill = parseFill(spPr, r);
  if (fill) shape.fill = fill;
  const line = parseLine(kid(spPr, 'ln'), r);
  if (line) shape.line = line;
  const extra = spRaw(spPr, r);
  if (extra) shape.spRaw = extra;
  const style = parseStyle(kid(el, 'style'));
  if (style) shape.style = style;
  return shape;
}

function parseGroup(el: Element, r: PartReader): Shape {
  const nv = kid(el, 'nvGrpSpPr');
  const grpSpPr = kid(el, 'grpSpPr');
  const xf = kid(grpSpPr, 'xfrm');
  const xfrm = parseXfrm(xf) ?? { x: 0, y: 0, w: 0, h: 0 };
  const chOff = kid(xf, 'chOff');
  const chExt = kid(xf, 'chExt');
  const ch = {
    x: numAttr(chOff, 'x') ?? xfrm.x,
    y: numAttr(chOff, 'y') ?? xfrm.y,
    w: numAttr(chExt, 'cx') ?? xfrm.w,
    h: numAttr(chExt, 'cy') ?? xfrm.h,
  };
  const fill = parseFill(grpSpPr, r);
  return { kind: 'grp', ...base(nv, r), xfrm, ch, children: parseShapes(el, r), ...(fill ? { fill } : {}) };
}

const FRAME_LABELS: [RegExp, string][] = [
  [/chart/, 'Chart'],
  [/diagram/, 'SmartArt'],
  [/ole/, 'Object'],
  [/video|media/, 'Media'],
];

function parseFrame(el: Element, r: PartReader): Shape {
  const nv = kid(el, 'nvGraphicFramePr');
  const xfrm = parseXfrm(kid(el, 'xfrm')) ?? { x: 0, y: 0, w: 0, h: 0 };
  const data = at(el, 'graphic', 'graphicData');
  const uri = attr(data, 'uri') ?? '';
  const frame: FrameShape = { kind: 'frame', ...base(nv, r), xfrm };
  const ph = parsePh(kid(nv, 'nvPr'));
  if (ph) frame.ph = ph;
  const tbl = kid(data, 'tbl');
  if (tbl) {
    frame.table = parseTable(tbl, r);
    return frame;
  }
  frame.xml = r.raw(el);
  frame.label = FRAME_LABELS.find(([re]) => re.test(uri))?.[1] ?? 'Object';
  if (/diagram/.test(uri)) {
    const preview = diagramPreview(data, r);
    if (preview) {
      frame.preview = preview;
      frame.previewSpace = { x: 0, y: 0, w: xfrm.w, h: xfrm.h };
    }
  } else {
    const pic = Array.from(el.getElementsByTagName('*')).find((e) => e.localName === 'pic');
    if (pic) {
      const shape = parsePic(pic, r);
      if (shape.xfrm) {
        frame.preview = [{ ...shape, xfrm: { ...shape.xfrm, x: shape.xfrm.x - xfrm.x, y: shape.xfrm.y - xfrm.y } }];
        frame.previewSpace = { x: 0, y: 0, w: xfrm.w, h: xfrm.h };
      }
    }
  }
  if (/chart/.test(uri)) {
    const chartEl = kid(data, 'chart');
    const target = r.target(chartEl ? chartEl.getAttributeNS(NS.r, 'id') || attr(chartEl, 'id') : null);
    if (target) frame.chartPart = target;
  }
  return frame;
}

/** SmartArt keeps a drawing of itself (ppt/diagrams/drawingN.xml) for apps that can't lay it out. */
function diagramPreview(data: Element | null, r: PartReader): Shape[] | null {
  const ids = kid(data, 'relIds');
  const dm = r.target(ids ? ids.getAttributeNS(NS.r, 'dm') || attr(ids, 'dm') : null);
  if (!dm) return null;
  const dmDoc = r.pkg.xml(dm);
  const ext = dmDoc ? Array.from(dmDoc.getElementsByTagName('*')).find((e) => e.localName === 'dataModelExt') : null;
  const drawingPath = r.target(attr(ext, 'relId'));
  if (!drawingPath) return null;
  const doc = r.pkg.xml(drawingPath);
  const tree = doc ? Array.from(doc.getElementsByTagName('*')).find((e) => e.localName === 'spTree') : null;
  if (!tree) return null;
  return parseShapes(tree, new PartReader(r.pkg, drawingPath));
}

function parseTable(tbl: Element, r: PartReader): Table {
  const tblPr = kid(tbl, 'tblPr');
  return {
    tblPr: tblPr ? r.raw(tblPr) : '<a:tblPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>',
    cols: kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => numAttr(c, 'w') ?? 0),
    rows: kids(tbl, 'tr').map((tr) => ({
      h: numAttr(tr, 'h') ?? 0,
      cells: kids(tr, 'tc').map((tc) => {
        const tcPr = kid(tc, 'tcPr');
        return {
          text: parseTextBody(kid(tc, 'txBody'), r) ?? { body: {}, paras: [{ props: {}, runs: [] }] },
          ...(numAttr(tc, 'gridSpan') ? { gridSpan: numAttr(tc, 'gridSpan')! } : {}),
          ...(numAttr(tc, 'rowSpan') ? { rowSpan: numAttr(tc, 'rowSpan')! } : {}),
          ...(attr(tc, 'hMerge') === '1' ? { hMerge: true } : {}),
          ...(attr(tc, 'vMerge') === '1' ? { vMerge: true } : {}),
          tcPr: tcPr ? r.raw(tcPr) : '',
        };
      }),
    })),
  };
}

function parseAlternate(el: Element, r: PartReader): Shape | null {
  const fallback = kid(el, 'Fallback');
  const inner = kids(fallback).map((c) => parseShape(c, r)).find((s): s is Shape => !!s);
  const choice = kid(el, 'Choice');
  const choiceShape = inner ? null : kids(choice).map((c) => parseShape(c, r)).find((s): s is Shape => !!s);
  const shown = inner ?? choiceShape ?? undefined;
  return {
    kind: 'raw',
    uid: newUid(),
    id: shown?.id ?? 0,
    name: shown?.name ?? '',
    xml: r.raw(el),
    ...(shown ? { fallback: shown } : {}),
    ...(shown && 'xfrm' in shown && shown.xfrm ? { xfrm: shown.xfrm, orig: shown.xfrm } : {}),
  };
}

export function parseShape(el: Element, r: PartReader): Shape | null {
  switch (el.localName) {
    case 'sp': return parseSp(el, r, false);
    case 'cxnSp': return parseSp(el, r, true);
    case 'pic': return parsePic(el, r);
    case 'grpSp': return parseGroup(el, r);
    case 'graphicFrame': return parseFrame(el, r);
    case 'AlternateContent': return parseAlternate(el, r);
    case 'contentPart': return { kind: 'raw', uid: newUid(), id: 0, name: 'Ink', xml: r.raw(el) };
  }
  return null;
}

function parseShapes(tree: Element, r: PartReader): Shape[] {
  return kids(tree).map((c) => parseShape(c, r)).filter((s): s is Shape => !!s);
}

// ---- Parts ----------------------------------------------------------------------------

function parseBg(cSld: Element | null, r: PartReader): Background | undefined {
  const bg = kid(cSld, 'bg');
  if (!bg) return undefined;
  const bgPr = kid(bg, 'bgPr');
  if (bgPr) {
    const fill = parseFill(bgPr, r);
    return fill ? { fill } : undefined;
  }
  const ref = styleRef(kid(bg, 'bgRef'));
  return ref ? { ref } : undefined;
}

function clrMapOf(el: Element | null): Record<string, string> | undefined {
  if (!el) return undefined;
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (!a.name.startsWith('xmlns')) out[a.localName] = a.value;
  return Object.keys(out).length ? out : undefined;
}

function parseTransition(root: Element, r: PartReader): Transition | undefined {
  let el = kid(root, 'transition');
  let rawEl: Element | null = el;
  if (!el) {
    const alt = kids(root, 'AlternateContent').find((a) => descendantsLocal(a, 'transition').length);
    if (alt) {
      rawEl = alt;
      el = descendantsLocal(kid(alt, 'Choice'), 'transition')[0] ?? descendantsLocal(alt, 'transition')[0];
    }
  }
  if (!el || !rawEl) return undefined;
  const effect = el.firstElementChild;
  const durAttr = Array.from(el.attributes).find((a) => a.localName === 'dur');
  const spd = attr(el, 'spd');
  const dur = durAttr ? Number(durAttr.value) : spd === 'slow' ? 1000 : spd === 'fast' ? 300 : 700;
  const advTm = numAttr(el, 'advTm');
  return {
    type: effect?.localName ?? 'none',
    dur,
    ...(attr(effect, 'dir') ? { dir: attr(effect, 'dir')! } : {}),
    ...(attr(el, 'advClick') === '0' ? { advClick: false } : {}),
    ...(advTm !== null ? { advTm } : {}),
    raw: r.raw(rawEl),
  };
}

function descendantsLocal(el: Element | null, local: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagName('*')).filter((d) => d.localName === local);
}

function parseFmt(doc: Document | null, r: PartReader): FmtScheme {
  const fmt = at(doc?.documentElement, 'themeElements', 'fmtScheme');
  const fills = (list: Element | null) => kids(list).map((f) => parseFillEl(f, r) ?? { type: 'none' as const });
  return {
    fills: fills(kid(fmt, 'fillStyleLst')),
    lines: kids(kid(fmt, 'lnStyleLst'), 'ln').map((l) => parseLine(l, r) ?? {}),
    bgFills: fills(kid(fmt, 'bgFillStyleLst')),
  };
}

function readMaster(pkg: OpcPackage, part: string): Master {
  const doc = pkg.xml(part);
  if (!doc) throw new Error('The presentation’s slide master is missing.');
  const root = doc.documentElement;
  const r = new PartReader(pkg, part);
  const cSld = kid(root, 'cSld');
  const themePart = pkg.relOfType(part, REL.theme)?.target ?? '';
  const themeDoc = themePart ? pkg.xml(themePart) : null;
  const tx = kid(root, 'txStyles');
  const layoutIds = kids(kid(root, 'sldLayoutIdLst'), 'sldLayoutId').map((l) => r.target(l.getAttributeNS(NS.r, 'id') || attr(l, 'id')));
  return {
    part,
    shapes: parseShapes(kid(cSld, 'spTree')!, r),
    bg: parseBg(cSld, r),
    clrMap: clrMapOf(kid(root, 'clrMap')) ?? DEFAULT_CLR_MAP,
    title: parseListStyle(kid(tx, 'titleStyle'), r),
    body: parseListStyle(kid(tx, 'bodyStyle'), r),
    other: parseListStyle(kid(tx, 'otherStyle'), r),
    theme: parseTheme(themeDoc),
    themePart,
    fmt: parseFmt(themeDoc, new PartReader(pkg, themePart)),
    layouts: layoutIds.filter((l): l is string => !!l && pkg.has(l)),
  };
}

function readLayout(pkg: OpcPackage, part: string, master: string): Layout {
  const doc = pkg.xml(part);
  const root = doc?.documentElement ?? null;
  const r = new PartReader(pkg, part);
  const cSld = kid(root, 'cSld');
  const tree = kid(cSld, 'spTree');
  return {
    part,
    name: attr(cSld, 'name') ?? 'Layout',
    ...(attr(root, 'type') ? { type: attr(root, 'type')! } : {}),
    master,
    shapes: tree ? parseShapes(tree, r) : [],
    bg: parseBg(cSld, r),
    showMasterSp: attr(root, 'showMasterSp') !== '0',
    clrMapOvr: clrMapOf(at(root, 'clrMapOvr', 'overrideClrMapping')),
  };
}

function readNotes(pkg: OpcPackage, slidePart: string): string {
  const part = pkg.relOfType(slidePart, REL.notesSlide)?.target;
  const doc = part ? pkg.xml(part) : null;
  if (!doc || !part) return '';
  const r = new PartReader(pkg, part);
  const sp = descendantsLocal(doc.documentElement, 'sp').find((s) => {
    const ph = descendantsLocal(s, 'ph')[0];
    return ph && attr(ph, 'type') === 'body';
  });
  const body = parseTextBody(kid(sp ?? null, 'txBody'), r);
  if (!body) return '';
  return body.paras.map((p) => p.runs.map((x) => (x.kind === 'br' ? '\n' : x.text)).join('')).join('\n');
}

function readSlide(pkg: OpcPackage, part: string, fallbackLayout: string): Slide {
  const doc = pkg.xml(part);
  if (!doc) throw new Error(`A slide (${part}) is missing.`);
  const root = doc.documentElement;
  const r = new PartReader(pkg, part);
  const cSld = kid(root, 'cSld');
  const tree = kid(cSld, 'spTree');
  const timing = kid(root, 'timing');
  const slide: Slide = {
    uid: newUid('slide'),
    layout: pkg.relOfType(part, REL.slideLayout)?.target ?? fallbackLayout,
    shapes: tree ? parseShapes(tree, r) : [],
    bg: parseBg(cSld, r),
    notes: readNotes(pkg, part),
    part,
  };
  if (attr(root, 'show') === '0') slide.hidden = true;
  if (attr(root, 'showMasterSp') === '0') slide.showMasterSp = false;
  const name = attr(cSld, 'name');
  if (name) slide.name = name;
  const ovr = clrMapOf(at(root, 'clrMapOvr', 'overrideClrMapping'));
  if (ovr) slide.clrMapOvr = ovr;
  const transition = parseTransition(root, r);
  if (transition) slide.transition = transition;
  if (timing) slide.timing = r.raw(timing);
  return slide;
}

export function parseTableStyles(doc: Document | null, r: PartReader | null): Record<string, TableStyle> {
  const out: Record<string, TableStyle> = {};
  if (!doc) return out;
  const reader = r ?? new PartReader(new OpcPackage(), '');
  for (const st of kids(doc.documentElement, 'tblStyle')) {
    const id = attr(st, 'styleId') ?? '';
    const parts: Record<string, TableStylePart> = {};
    for (const p of kids(st)) {
      const part: TableStylePart = { borders: {} };
      const tx = kid(p, 'tcTxStyle');
      if (tx) {
        if (attr(tx, 'b') === 'on') part.b = true;
        if (attr(tx, 'i') === 'on') part.i = true;
        const c = kids(tx).find((k) => k.localName !== 'fontRef' && k.localName !== 'font');
        const color = parseColor(c) ?? colorIn(kid(tx, 'fontRef'));
        if (color) part.color = color;
      }
      const tc = kid(p, 'tcStyle');
      const fill = parseFill(kid(tc, 'fill'), reader);
      if (fill) part.fill = fill;
      for (const side of kids(kid(tc, 'tcBdr'))) {
        const ln = parseLine(kid(side, 'ln'), reader);
        if (ln) part.borders[side.localName as BorderSide] = ln;
      }
      parts[p.localName] = part;
    }
    out[id] = { id, name: attr(st, 'styleName') ?? '', parts };
  }
  return out;
}

let builtins: Record<string, TableStyle> | null = null;

function builtinTableStyles(): Record<string, TableStyle> {
  builtins ??= parseTableStyles(parseXml(tableStyleListXml(Object.keys(MEDIUM_STYLE_2).map(tableStyleXml).join(''))), null);
  return builtins;
}

/** Read a presentation package into a deck. */
export function readDeck(pkg: OpcPackage): Deck {
  const main = pkg.mainPart();
  if (!main || !pkg.has(main)) throw new Error('This isn’t a PowerPoint presentation.');
  const doc = pkg.xml(main)!;
  const root = doc.documentElement;
  if (root.localName !== 'presentation') throw new Error('This isn’t a PowerPoint presentation.');
  const r = new PartReader(pkg, main);
  const masters: Record<string, Master> = {};
  const layouts: Record<string, Layout> = {};
  for (const m of kids(kid(root, 'sldMasterIdLst'), 'sldMasterId')) {
    const part = r.target(m.getAttributeNS(NS.r, 'id') || attr(m, 'id'));
    if (!part || masters[part]) continue;
    const master = readMaster(pkg, part);
    masters[part] = master;
    // Layouts the master's list leaves out still count if it relates them.
    const related = pkg.rels(part).filter((rel) => rel.type === REL.slideLayout).map((rel) => rel.target);
    for (const l of [...master.layouts, ...related.filter((t) => !master.layouts.includes(t))]) {
      if (!layouts[l] && pkg.has(l)) layouts[l] = readLayout(pkg, l, part);
    }
    master.layouts = [...master.layouts, ...related.filter((t) => !master.layouts.includes(t) && pkg.has(t))];
  }
  if (!Object.keys(masters).length) throw new Error('The presentation has no slide master.');
  const firstLayout = Object.keys(layouts)[0] ?? '';
  const slides: Slide[] = [];
  for (const s of kids(kid(root, 'sldIdLst'), 'sldId')) {
    const part = r.target(s.getAttributeNS(NS.r, 'id') || attr(s, 'id'));
    if (!part || !pkg.has(part)) continue;
    const slide = readSlide(pkg, part, firstLayout);
    const sldId = numAttr(s, 'id');
    if (sldId !== null) slide.sldId = sldId;
    if (!layouts[slide.layout]) {
      // A slide whose layout belongs to no listed master.
      const mPart = pkg.relOfType(slide.layout, REL.slideMaster)?.target;
      if (mPart && !masters[mPart] && pkg.has(mPart)) masters[mPart] = readMaster(pkg, mPart);
      if (mPart && masters[mPart] && pkg.has(slide.layout)) layouts[slide.layout] = readLayout(pkg, slide.layout, mPart);
      else slide.layout = firstLayout;
    }
    slides.push(slide);
  }
  const sz = kid(root, 'sldSz');
  const tsPart = pkg.relOfType(main, REL.tableStyles)?.target;
  const tsDoc = tsPart ? pkg.xml(tsPart) : null;
  return {
    w: numAttr(sz, 'cx') ?? 9144000,
    h: numAttr(sz, 'cy') ?? 6858000,
    slides,
    masters,
    layouts,
    defaultText: parseListStyle(kid(root, 'defaultTextStyle'), r),
    tableStyles: { ...builtinTableStyles(), ...parseTableStyles(tsDoc, tsPart ? new PartReader(pkg, tsPart) : null) },
  };
}

export { PartReader };

/** Parse an XML fragment string (with namespace declarations) to its element. */
export function fragment(xml: string): Element {
  return parseXml(xml).documentElement;
}
