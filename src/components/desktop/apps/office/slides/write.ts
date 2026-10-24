import { esc, kid, kids, NS, OpcPackage, parseXml, REL, serialize, touchModified, XML_HEADER, x, type Rel } from '../ooxml';
import {
  type Background,
  type BodyProps,
  type Color,
  type Deck,
  type Fill,
  type Geometry,
  type Line,
  type LineEnd,
  type ListStyle,
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
  type TextBody,
  type Transition,
  type Xfrm,
  walkShapes,
} from './model';

/**
 * Writing a .pptx: the package it was read from is carried over whole
 * (masters, layouts, theme, media, charts...) and each slide is written
 * fresh from the model, with presentation.xml's slide list, the slides'
 * relationships and notes slides to match. Raw XML kept from reading gets
 * real relationship ids again here.
 */

export const CT_PML = {
  main: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
};

export const NS_DECL = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;

/** Hands out relationship ids for one part. */
export class RelAlloc {
  rels: Rel[] = [];
  constructor(readonly part: string) {}
  id(type: string, target: string, external = false): string {
    const same = this.rels.find((r) => r.type === type && r.target === target && r.external === external);
    if (same) return same.id;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type, target, external });
    return id;
  }
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Raw XML with relationship tokens (see relToken) turned back into ids. */
export function relink(xml: string, alloc: RelAlloc): string {
  return xml.replace(/§([^§]*)§([^§]*)§([01])§/g, (_m, type: string, target: string, ext: string) => alloc.id(unescape(type), unescape(target), ext === '1'));
}

// ---- DrawingML ------------------------------------------------------------------------

export function colorXml(c: Color): string {
  const mods = (c.mods ?? []).map(([n, v]) => `<a:${n} val="${Math.round(v)}"/>`).join('');
  if (c.scheme) return `<a:schemeClr val="${esc(c.scheme)}">${mods}</a:schemeClr>`.replace('"></a:schemeClr>', '"/>');
  const v = (c.hex ?? '000000').toUpperCase();
  return mods ? `<a:srgbClr val="${v}">${mods}</a:srgbClr>` : `<a:srgbClr val="${v}"/>`;
}

function fillXml(f: Fill | undefined, alloc: RelAlloc): string {
  if (!f) return '';
  switch (f.type) {
    case 'none':
      return '<a:noFill/>';
    case 'solid':
      return `<a:solidFill>${colorXml(f.color)}</a:solidFill>`;
    case 'grad':
      if (f.raw) return relink(f.raw, alloc);
      return `<a:gradFill rotWithShape="1"><a:gsLst>${f.stops.map((s) => `<a:gs pos="${Math.round(s.pos * 100000)}">${colorXml(s.color)}</a:gs>`).join('')}</a:gsLst>${
        f.path ? `<a:path path="${f.path}"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>` : `<a:lin ang="${Math.round(f.angle * 60000)}" scaled="0"/>`
      }</a:gradFill>`;
    case 'blip': {
      if (f.raw) return relink(f.raw, alloc);
      if (!f.media) return '<a:noFill/>';
      const id = alloc.id(REL.image, f.media);
      return `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${id}"/><a:srcRect/>${f.tile ? '<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>' : '<a:stretch><a:fillRect/></a:stretch>'}</a:blipFill>`;
    }
    case 'patt':
      return `<a:pattFill prst="${esc(f.prst)}"><a:fgClr>${colorXml(f.fg)}</a:fgClr><a:bgClr>${colorXml(f.bg)}</a:bgClr></a:pattFill>`;
    case 'grp':
      return '<a:grpFill/>';
  }
}

function lineEndXml(tag: string, e: LineEnd | undefined): string {
  return e ? x(`a:${tag}`, { type: e.type, w: e.w, len: e.len }) : '';
}

function lineXml(l: Line | undefined, alloc: RelAlloc): string {
  if (!l) return '';
  const raw = l.raw ?? {};
  const join = ['round', 'bevel', 'miter'].map((k) => raw[k] ?? '').join('');
  return x('a:ln', { w: l.w, cap: l.cap }, [
    fillXml(l.fill, alloc),
    l.dash ? `<a:prstDash val="${esc(l.dash)}"/>` : raw.custDash ? relink(raw.custDash, alloc) : '',
    join,
    lineEndXml('headEnd', l.head),
    lineEndXml('tailEnd', l.tail),
    raw.extLst ?? '',
  ]);
}

export function xfrmXml(xf: Xfrm | undefined, tag = 'a:xfrm', ch?: { x: number; y: number; w: number; h: number }): string {
  if (!xf) return '';
  const r = (n: number) => Math.round(n);
  return x(tag, { rot: xf.rot ? r(((xf.rot % 360) + 360) % 360 * 60000) : null, flipH: xf.flipH ? 1 : null, flipV: xf.flipV ? 1 : null }, [
    `<a:off x="${r(xf.x)}" y="${r(xf.y)}"/>`,
    `<a:ext cx="${Math.max(0, r(xf.w))}" cy="${Math.max(0, r(xf.h))}"/>`,
    ch ? `<a:chOff x="${r(ch.x)}" y="${r(ch.y)}"/><a:chExt cx="${Math.max(0, r(ch.w))}" cy="${Math.max(0, r(ch.h))}"/>` : '',
  ]);
}

function geomXml(g: Geometry | undefined, fallback?: string): string {
  if (g?.cust) return g.cust;
  const prst = g?.prst ?? fallback;
  if (!prst) return '';
  const av = Object.entries(g?.adj ?? {}).map(([k, v]) => `<a:gd name="${esc(k)}" fmla="val ${Math.round(v)}"/>`).join('');
  return `<a:prstGeom prst="${esc(prst)}"><a:avLst>${av}</a:avLst></a:prstGeom>`.replace('<a:avLst></a:avLst>', '<a:avLst/>');
}

function refXml(tag: string, r: StyleRef | undefined): string {
  if (!r) return '';
  return `<a:${tag} idx="${r.idx}">${r.color ? colorXml(r.color) : ''}</a:${tag}>`;
}

function styleXml(s: ShapeStyle | undefined): string {
  if (!s) return '';
  return `<p:style>${refXml('lnRef', s.ln ?? { idx: 0 })}${refXml('fillRef', s.fill ?? { idx: 0 })}${refXml('effectRef', s.effect ?? { idx: 0 })}${s.font ? refXml('fontRef', s.font) : '<a:fontRef idx="minor"/>'}</p:style>`;
}

const SP_PR_TAIL = ['effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'];

function spPrXml(parts: { xfrm?: Xfrm; geom?: Geometry; geomFallback?: string; fill?: Fill; line?: Line; raw?: RawKids }, alloc: RelAlloc): string {
  const raw = parts.raw ?? {};
  return x('p:spPr', null, `${xfrmXml(parts.xfrm)}${geomXml(parts.geom, parts.geomFallback)}${fillXml(parts.fill, alloc)}${lineXml(parts.line, alloc)}${SP_PR_TAIL.map((k) => (raw[k] ? relink(raw[k], alloc) : '')).join('')}`);
}

// ---- Text -------------------------------------------------------------------------------

const RPR_ORDER = ['ln', 'FILL', 'effectLst', 'effectDag', 'HIGHLIGHT', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'LATIN', 'ea', 'cs', 'sym', 'LINK', 'hlinkMouseOver', 'rtl', 'extLst'];

export function rPrXml(tag: string, p: RunProps | undefined, alloc: RelAlloc): string {
  if (!p) return '';
  const attrs: Record<string, string | number | null | undefined> = { ...(p.attrs ?? {}) };
  if (!('lang' in attrs)) attrs.lang = 'en-US';
  attrs.sz = p.sz !== undefined ? Math.round(p.sz) : undefined;
  attrs.b = p.b === undefined ? undefined : p.b ? 1 : 0;
  attrs.i = p.i === undefined ? undefined : p.i ? 1 : 0;
  attrs.u = p.u;
  attrs.strike = p.strike;
  attrs.cap = p.cap;
  attrs.spc = p.spc;
  attrs.baseline = p.baseline;
  const raw = p.raw ?? {};
  const kidsXml = RPR_ORDER.map((k) => {
    switch (k) {
      case 'FILL': return p.color ? `<a:solidFill>${colorXml(p.color)}</a:solidFill>` : raw.solidFill ?? raw.noFill ?? raw.gradFill ?? '';
      case 'HIGHLIGHT': return p.highlight ? `<a:highlight>${colorXml(p.highlight)}</a:highlight>` : '';
      case 'LATIN': return p.font ? `<a:latin typeface="${esc(p.font)}"/>` : '';
      case 'LINK':
        if (p.link) return `<a:hlinkClick r:id="${alloc.id(REL.hyperlink, p.link, true)}"/>`;
        return raw.hlinkClick ? relink(raw.hlinkClick, alloc) : '';
      default: return raw[k] ? relink(raw[k], alloc) : '';
    }
  }).join('');
  return x(tag, attrs, kidsXml);
}

function spacingXml(tag: string, s: Spacing | undefined): string {
  if (!s) return '';
  return 'pct' in s ? `<a:${tag}><a:spcPct val="${Math.round(s.pct * 100000)}"/></a:${tag}>` : `<a:${tag}><a:spcPts val="${Math.round(s.pts * 100)}"/></a:${tag}>`;
}

export function pPrXml(tag: string, p: ParaProps | undefined, alloc: RelAlloc): string {
  if (!p) return '';
  const raw = p.raw ?? {};
  const attrs = { ...(p.attrs ?? {}), marL: p.marL, lvl: p.lvl || undefined, indent: p.indent, algn: p.algn };
  let bullet = '';
  if (p.bullet?.type === 'none') bullet = '<a:buNone/>';
  else if (p.bullet?.type === 'char') bullet = `<a:buChar char="${esc(p.bullet.char)}"/>`;
  else if (p.bullet?.type === 'auto') bullet = x('a:buAutoNum', { type: p.bullet.scheme, startAt: p.bullet.start });
  else if (raw.buBlip) bullet = relink(raw.buBlip, alloc);
  const body = [
    spacingXml('lnSpc', p.lnSpc),
    spacingXml('spcBef', p.spcBef),
    spacingXml('spcAft', p.spcAft),
    p.buClrTx ? '<a:buClrTx/>' : p.buClr ? `<a:buClr>${colorXml(p.buClr)}</a:buClr>` : '',
    raw.buSzTx ?? (p.buSzPct !== undefined ? `<a:buSzPct val="${Math.round(p.buSzPct)}"/>` : raw.buSzPts ?? ''),
    p.buFontTx ? '<a:buFontTx/>' : p.buFont ? `<a:buFont typeface="${esc(p.buFont)}"/>` : '',
    bullet,
    raw.tabLst ?? '',
    p.defRPr ? rPrXml('a:defRPr', p.defRPr, alloc) : '',
    raw.extLst ?? '',
  ].join('');
  if (!body && Object.values(attrs).every((v) => v === undefined)) return tag === 'a:pPr' ? '' : `<${tag}/>`;
  return x(tag, attrs, body);
}

export function lstStyleXml(ls: ListStyle | undefined, alloc: RelAlloc): string {
  if (!ls) return '<a:lstStyle/>';
  const body = (ls.def ? pPrXml('a:defPPr', ls.def, alloc) : '') + ls.levels.map((l, i) => (l ? pPrXml(`a:lvl${i + 1}pPr`, l, alloc) : '')).join('');
  return body ? `<a:lstStyle>${body}</a:lstStyle>` : '<a:lstStyle/>';
}

function bodyPrXml(b: BodyProps, alloc: RelAlloc): string {
  const raw = b.raw ?? {};
  const attrs = {
    rot: b.rot ? Math.round(b.rot * 60000) : undefined,
    vert: b.vert,
    wrap: b.wrap,
    lIns: b.lIns,
    tIns: b.tIns,
    rIns: b.rIns,
    bIns: b.bIns,
    numCol: b.numCol,
    anchor: b.anchor,
    anchorCtr: b.anchorCtr === undefined ? undefined : b.anchorCtr ? 1 : 0,
    ...(b.attrs ?? {}),
  };
  const fit = b.autofit === 'none' ? '<a:noAutofit/>' : b.autofit === 'shape' ? '<a:spAutoFit/>' : b.autofit === 'norm' ? x('a:normAutofit', { fontScale: b.fontScale, lnSpcReduction: b.lnSpcReduction }) : '';
  return x('a:bodyPr', attrs, [raw.prstTxWarp ?? '', fit, raw.scene3d ?? '', raw.sp3d ?? '', raw.flatTx ?? '', raw.extLst ?? ''].map((s) => (s ? relink(s, alloc) : '')));
}

export function parasXml(paras: Para[], alloc: RelAlloc): string {
  return paras
    .map((p) => {
      const runs = p.runs
        .map((r) => {
          if (r.kind === 'br') return `<a:br>${rPrXml('a:rPr', r.props, alloc)}</a:br>`.replace('<a:br></a:br>', '<a:br/>');
          if (r.kind === 'field') return `<a:fld id="${esc(r.id)}" type="${esc(r.type)}">${rPrXml('a:rPr', r.props, alloc)}<a:t>${esc(r.text)}</a:t></a:fld>`;
          return `<a:r>${rPrXml('a:rPr', r.props, alloc)}<a:t>${esc(r.text)}</a:t></a:r>`;
        })
        .join('');
      return `<a:p>${pPrXml('a:pPr', p.props, alloc)}${runs}${p.end ? rPrXml('a:endParaRPr', p.end, alloc) : ''}</a:p>`;
    })
    .join('');
}

export function txBodyXml(tag: string, t: TextBody, alloc: RelAlloc): string {
  const paras = t.paras.length ? t.paras : [{ props: {}, runs: [] }];
  return `<${tag}>${bodyPrXml(t.body, alloc)}${lstStyleXml(t.lst, alloc)}${parasXml(paras, alloc)}</${tag}>`;
}

// ---- Shapes -----------------------------------------------------------------------------

function phXml(ph: Placeholder | undefined): string {
  if (!ph) return '';
  return x('p:ph', { type: ph.type, orient: ph.orient, sz: ph.sz, idx: ph.idx, hasCustomPrompt: ph.hasCustomPrompt ? 1 : undefined });
}

function cNvPrXml(s: Shape, alloc: RelAlloc): string {
  const raw = Object.entries(s.raw ?? {})
    .filter(([k]) => k.startsWith('cNvPr.'))
    .map(([, v]) => relink(v, alloc))
    .join('');
  return x('p:cNvPr', { id: s.id, name: s.name, descr: s.descr, hidden: s.hidden ? 1 : undefined }, raw);
}

function nvPrXml(s: Shape, ph: Placeholder | undefined, alloc: RelAlloc): string {
  const raw = Object.entries(s.raw ?? {})
    .filter(([k]) => k.startsWith('nvPr.'))
    .map(([, v]) => relink(v, alloc))
    .join('');
  return `<p:nvPr>${phXml(ph)}${raw}</p:nvPr>`.replace('<p:nvPr></p:nvPr>', '<p:nvPr/>');
}

function moveRaw(xml: string, from: Xfrm | undefined, to: Xfrm | undefined): string {
  if (!from || !to) return xml;
  const r = Math.round;
  return xml
    .replace(new RegExp(`(<(?:\\w+:)?off\\s+)x="${r(from.x)}"\\s+y="${r(from.y)}"`, 'g'), `$1x="${r(to.x)}" y="${r(to.y)}"`)
    .replace(new RegExp(`(<(?:\\w+:)?ext\\s+)cx="${r(from.w)}"\\s+cy="${r(from.h)}"`, 'g'), `$1cx="${r(to.w)}" cy="${r(to.h)}"`);
}

export function shapeXml(s: Shape, alloc: RelAlloc): string {
  switch (s.kind) {
    case 'sp': {
      const nv = s.connector ? 'p:nvCxnSpPr' : 'p:nvSpPr';
      const cnv = s.connector ? 'p:cNvCxnSpPr' : 'p:cNvSpPr';
      const nvRaw = s.nvRaw ? relink(s.nvRaw, alloc) : '';
      return x(s.connector ? 'p:cxnSp' : 'p:sp', null, [
        `<${nv}>${cNvPrXml(s, alloc)}${x(cnv, { txBox: s.txBox ? 1 : undefined }, nvRaw)}${nvPrXml(s, s.ph, alloc)}</${nv}>`,
        spPrXml({ xfrm: s.xfrm, geom: s.geom, geomFallback: s.ph ? undefined : 'rect', fill: s.fill, line: s.line, raw: s.spRaw }, alloc),
        styleXml(s.style),
        !s.connector && s.text ? txBodyXml('p:txBody', s.text, alloc) : '',
      ]);
    }
    case 'pic': {
      const nvRaw = s.nvRaw ? relink(s.nvRaw, alloc) : '';
      const embed = s.media ? alloc.id(REL.image, s.media) : null;
      const blip = x('a:blip', embed ? { 'r:embed': embed } : null, s.blipRaw ? relink(s.blipRaw, alloc) : '');
      const c = s.crop;
      const crop = c ? x('a:srcRect', { l: Math.round(c.l * 100000) || undefined, t: Math.round(c.t * 100000) || undefined, r: Math.round(c.r * 100000) || undefined, b: Math.round(c.b * 100000) || undefined }) : '<a:srcRect/>';
      return x('p:pic', null, [
        `<p:nvPicPr>${cNvPrXml(s, alloc)}${x('p:cNvPicPr', null, nvRaw || '<a:picLocks noChangeAspect="1"/>')}${nvPrXml(s, s.ph, alloc)}</p:nvPicPr>`,
        `<p:blipFill>${blip}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`,
        spPrXml({ xfrm: s.xfrm, geom: s.geom, geomFallback: s.ph ? undefined : 'rect', fill: s.fill, line: s.line, raw: s.spRaw }, alloc),
        styleXml(s.style),
      ]);
    }
    case 'grp':
      return x('p:grpSp', null, [
        `<p:nvGrpSpPr>${cNvPrXml(s, alloc)}<p:cNvGrpSpPr/>${nvPrXml(s, undefined, alloc)}</p:nvGrpSpPr>`,
        `<p:grpSpPr>${xfrmXml(s.xfrm, 'a:xfrm', s.ch)}${fillXml(s.fill, alloc)}</p:grpSpPr>`,
        ...s.children.map((c) => shapeXml(c, alloc)),
      ]);
    case 'frame': {
      if (s.xml) {
        let xml = relink(s.xml, alloc);
        xml = xml.replace(/<((?:\w+:)?)xfrm\b[^>]*>[\s\S]*?<\/\1xfrm>/, (_m, pfx: string) => xfrmXml(s.xfrm, `${pfx}xfrm`));
        xml = xml.replace(/(<(?:\w+:)?cNvPr\b[^>]*?\sid=")\d+"/, `$1${s.id}"`);
        return xml;
      }
      const t = s.table!;
      const rows = t.rows
        .map(
          (row) =>
            `<a:tr h="${Math.round(row.h)}">${row.cells
              .map(
                (c) =>
                  x('a:tc', { gridSpan: c.gridSpan, rowSpan: c.rowSpan, hMerge: c.hMerge ? 1 : undefined, vMerge: c.vMerge ? 1 : undefined }, [
                    txBodyXml('a:txBody', c.text, alloc),
                    c.tcPr ? relink(c.tcPr, alloc) : '<a:tcPr/>',
                  ]),
              )
              .join('')}</a:tr>`,
        )
        .join('');
      return x('p:graphicFrame', null, [
        `<p:nvGraphicFramePr>${cNvPrXml(s, alloc)}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>${nvPrXml(s, s.ph, alloc)}</p:nvGraphicFramePr>`,
        xfrmXml(s.xfrm, 'p:xfrm'),
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${relink(t.tblPr, alloc)}<a:tblGrid>${t.cols.map((w) => `<a:gridCol w="${Math.round(w)}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic>`,
      ]);
    }
    case 'raw':
      return moveRaw(relink(s.xml, alloc), s.orig, s.xfrm);
  }
}

// ---- Slides -------------------------------------------------------------------------------

function bgXml(bg: Background | undefined, alloc: RelAlloc): string {
  if (!bg) return '';
  if ('fill' in bg) return `<p:bg><p:bgPr>${fillXml(bg.fill, alloc)}<a:effectLst/></p:bgPr></p:bg>`;
  return `<p:bg><p:bgRef idx="${bg.ref.idx}">${bg.ref.color ? colorXml(bg.ref.color) : '<a:schemeClr val="bg1"/>'}</p:bgRef></p:bg>`;
}

function transitionXml(t: Transition | undefined, alloc: RelAlloc): string {
  if (!t) return '';
  if (t.raw) return relink(t.raw, alloc);
  if (t.type === 'none') return '';
  const spd = (t.dur ?? 700) >= 1000 ? 'slow' : (t.dur ?? 700) <= 400 ? 'fast' : 'med';
  const attrs = { spd, advClick: t.advClick === false ? 0 : undefined, advTm: t.advTm };
  const effect = t.type === 'push' || t.type === 'wipe' || t.type === 'cover' || t.type === 'pull' ? x(`p:${t.type}`, { dir: t.dir }) : `<p:${t.type}/>`;
  return x('p:transition', attrs, effect);
}

const SP_TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

export function slideXml(slide: Slide, alloc: RelAlloc): string {
  const ids = new Set<string>();
  walkShapes(slide.shapes, (s) => ids.add(String(s.id)));
  let timing = '';
  if (slide.timing) {
    const targets = [...slide.timing.matchAll(/spid="(\d+)"/g)].map((m) => m[1]);
    if (targets.every((t) => ids.has(t))) timing = relink(slide.timing, alloc);
  }
  const clr = slide.clrMapOvr ? x('a:overrideClrMapping', slide.clrMapOvr) : '<a:masterClrMapping/>';
  return (
    XML_HEADER +
    x('p:sld', { 'xmlns:a': NS.a, 'xmlns:r': NS.r, 'xmlns:p': NS.p, show: slide.hidden ? 0 : undefined, showMasterSp: slide.showMasterSp === false ? 0 : undefined }, [
      x('p:cSld', { name: slide.name }, [bgXml(slide.bg, alloc), `<p:spTree>${SP_TREE_HEAD}${slide.shapes.map((s) => shapeXml(s, alloc)).join('')}</p:spTree>`]),
      `<p:clrMapOvr>${clr}</p:clrMapOvr>`,
      transitionXml(slide.transition, alloc),
      timing,
    ])
  );
}

// ---- Notes --------------------------------------------------------------------------------

function notesParas(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>'))
    .join('');
}

function newNotesXml(text: string): string {
  return (
    `${XML_HEADER}<p:notes ${NS_DECL}><p:cSld><p:spTree>${SP_TREE_HEAD}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notesParas(text)}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

/** An existing notes slide with its body text replaced. */
function updatedNotesXml(xml: string, text: string): string {
  const doc = parseXml(xml);
  const sps = Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === 'sp');
  const body = sps.find((s) => Array.from(s.getElementsByTagName('*')).some((e) => e.localName === 'ph' && e.getAttribute('type') === 'body'));
  if (!body) return newNotesXml(text);
  let tx = kid(body, 'txBody');
  if (!tx) {
    tx = doc.createElementNS(NS.p, 'p:txBody');
    tx.appendChild(doc.createElementNS(NS.a, 'a:bodyPr'));
    tx.appendChild(doc.createElementNS(NS.a, 'a:lstStyle'));
    body.appendChild(tx);
  }
  for (const p of kids(tx, 'p')) p.remove();
  const frag = parseXml(`<x ${NS_DECL}>${notesParas(text)}</x>`).documentElement;
  for (const p of kids(frag, 'p')) tx.appendChild(doc.importNode(p, true));
  return XML_HEADER + serialize(doc.documentElement);
}

export function notesMasterXml(): string {
  const lvl = (n: number) =>
    `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return (
    `${XML_HEADER}<p:notesMaster ${NS_DECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    `<p:notesStyle>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(lvl).join('')}</p:notesStyle></p:notesMaster>`
  );
}

/** The package's notes master, made (with a theme of its own) if it has none. */
function ensureNotesMaster(pkg: OpcPackage, main: string, themeXml: () => string): string {
  const existing = pkg.relOfType(main, REL.notesMaster)?.target;
  if (existing && pkg.has(existing)) return existing;
  const part = 'ppt/notesMasters/notesMaster1.xml';
  pkg.setText(part, notesMasterXml());
  pkg.ensureOverride(part, CT_PML.notesMaster);
  const theme = pkg.freshName('ppt/theme/theme', 'xml');
  pkg.setText(theme, themeXml());
  pkg.ensureOverride(theme, 'application/vnd.openxmlformats-officedocument.theme+xml');
  pkg.setRels(part, [{ id: 'rId1', type: REL.theme, target: theme, external: false }]);
  const rid = pkg.addRel(main, REL.notesMaster, part);
  const doc = parseXml(pkg.text(main)!);
  const root = doc.documentElement;
  let list = kid(root, 'notesMasterIdLst');
  if (!list) {
    list = doc.createElementNS(NS.p, 'p:notesMasterIdLst');
    const after = kid(root, 'sldMasterIdLst');
    root.insertBefore(list, after ? after.nextSibling : root.firstChild);
  }
  for (const c of kids(list)) c.remove();
  const id = doc.createElementNS(NS.p, 'p:notesMasterId');
  id.setAttributeNS(NS.r, 'r:id', rid);
  list.appendChild(id);
  pkg.setText(main, XML_HEADER + serialize(root));
  return part;
}

// ---- Design changes --------------------------------------------------------------------

/** A theme part with new colors and fonts. */
export function patchTheme(xml: string, theme: { colors: Record<string, string>; majorFont: string; minorFont: string; name?: string }): string {
  let out = xml;
  for (const [name, hex] of Object.entries(theme.colors)) {
    out = out.replace(new RegExp(`<((?:\\w+:)?)${name}>[\\s\\S]*?</\\1${name}>`), (_m, p: string) => `<${p}${name}><${p}srgbClr val="${hex}"/></${p}${name}>`);
  }
  out = out.replace(/(<(?:\w+:)?majorFont>\s*<(?:\w+:)?latin\s+typeface=")[^"]*"/, `$1${esc(theme.majorFont)}"`);
  out = out.replace(/(<(?:\w+:)?minorFont>\s*<(?:\w+:)?latin\s+typeface=")[^"]*"/, `$1${esc(theme.minorFont)}"`);
  return out;
}

function patchMaster(xml: string, bg: Background | undefined, clrMap: Record<string, string>): string {
  const alloc = new RelAlloc('');
  const bgXmlStr = bgXml(bg, alloc);
  let out = xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '');
  if (bgXmlStr) out = out.replace(/(<p:cSld\b[^>]*>)/, `$1${bgXmlStr}`);
  out = out.replace(/<p:clrMap\b[^>]*\/>/, x('p:clrMap', clrMap));
  return out;
}

/**
 * PowerPoint's sections (p14:sectionLst) list slides by id. Slides stay in
 * the section they were in, new slides join the section of the slide
 * before them, and a slide moved away from its section joins its new
 * neighbors', so each section stays one run of slides.
 */
function fixSections(root: Element, slides: Slide[], ids: number[]): void {
  const list = Array.from(root.getElementsByTagName('*')).find((e) => e.localName === 'sectionLst');
  if (!list) return;
  const sections = kids(list, 'section');
  const sectionOf = new Map<number, number>();
  sections.forEach((sec, i) => {
    for (const s of Array.from(sec.getElementsByTagName('*')).filter((e) => e.localName === 'sldId')) sectionOf.set(Number(s.getAttribute('id')), i);
  });
  const members: number[][] = sections.map(() => []);
  const closed = new Set<number>();
  let cur = 0;
  slides.forEach((_, i) => {
    const want = sectionOf.get(ids[i]);
    if (want !== undefined && want !== cur && !closed.has(want) && want > cur) {
      for (let k = cur; k < want; k++) closed.add(k);
      cur = want;
    }
    members[cur]?.push(ids[i]);
  });
  sections.forEach((sec, i) => {
    let lst = Array.from(sec.children).find((e) => e.localName === 'sldIdLst');
    if (!lst) {
      lst = sec.ownerDocument.createElementNS(sec.namespaceURI, `${sec.prefix ? `${sec.prefix}:` : ''}sldIdLst`);
      sec.appendChild(lst);
    }
    while (lst.firstChild) lst.removeChild(lst.firstChild);
    for (const id of members[i]) {
      const el = sec.ownerDocument.createElementNS(sec.namespaceURI, `${sec.prefix ? `${sec.prefix}:` : ''}sldId`);
      el.setAttribute('id', String(id));
      lst.appendChild(el);
    }
  });
}

// ---- The package --------------------------------------------------------------------------

/** Scale every position and size in a layout or master part (for a new slide size). */
function scalePart(xml: string, sx: number, sy: number): string {
  const r = Math.round;
  return xml
    .replace(/(<(?:\w+:)?(?:off|chOff)\s+)x="(-?\d+)"\s+y="(-?\d+)"/g, (_m, pre: string, a: string, b: string) => `${pre}x="${r(Number(a) * sx)}" y="${r(Number(b) * sy)}"`)
    .replace(/(<(?:\w+:)?(?:ext|chExt)\s+)cx="(\d+)"\s+cy="(\d+)"/g, (_m, pre: string, a: string, b: string) => `${pre}cx="${r(Number(a) * sx)}" cy="${r(Number(b) * sy)}"`);
}

export function writeDeck(source: OpcPackage, deck: Deck, themeXml: () => string): Uint8Array {
  const pkg = new OpcPackage();
  pkg.files = new Map(source.files);
  const main = pkg.mainPart()!;
  const doc = parseXml(pkg.text(main)!);
  const root = doc.documentElement;

  // Old slides and their notes go; every slide is written afresh.
  const oldSlides = pkg.rels(main).filter((r) => r.type === REL.slide);
  const oldNotes = new Map<string, string>();
  for (const r of oldSlides) {
    const notes = pkg.relOfType(r.target, REL.notesSlide)?.target;
    if (notes) {
      const xml = pkg.text(notes);
      if (xml) oldNotes.set(r.target, xml);
      pkg.delete(notes);
    }
    pkg.delete(r.target);
  }

  // A new slide size scales the masters and layouts too.
  const sz = kid(root, 'sldSz');
  const oldW = Number(sz?.getAttribute('cx') ?? deck.w);
  const oldH = Number(sz?.getAttribute('cy') ?? deck.h);
  if (oldW !== deck.w || oldH !== deck.h) {
    for (const part of [...Object.keys(deck.masters), ...Object.keys(deck.layouts)]) {
      const xml = pkg.text(part);
      if (xml) pkg.setText(part, scalePart(xml, deck.w / oldW, deck.h / oldH));
    }
    sz?.setAttribute('cx', String(deck.w));
    sz?.setAttribute('cy', String(deck.h));
    sz?.removeAttribute('type');
  }

  for (const m of Object.values(deck.masters)) {
    if (m.themeDirty && m.themePart && pkg.has(m.themePart)) pkg.setText(m.themePart, patchTheme(pkg.text(m.themePart)!, m.theme));
    if (m.bgDirty && pkg.has(m.part)) pkg.setText(m.part, patchMaster(pkg.text(m.part)!, m.bg, m.clrMap));
  }

  const needNotes = deck.slides.some((s) => s.notes.trim() || (s.part && oldNotes.has(s.part)));
  const notesMaster = needNotes ? ensureNotesMaster(pkg, main, themeXml) : null;

  const presRels = pkg.rels(main).filter((r) => r.type !== REL.slide);
  const used = new Set(presRels.map((r) => r.id));
  let n = 1;
  const freshId = () => {
    while (used.has(`rId${n}`)) n++;
    used.add(`rId${n}`);
    return `rId${n}`;
  };
  const sldIds: { id: number; rid: string }[] = [];
  // Slides keep their ids (sections refer to them); new ones get fresh ones.
  const taken = new Set<number>();
  const ids = deck.slides.map((s) => (s.sldId && s.sldId >= 256 && !taken.has(s.sldId) ? (taken.add(s.sldId), s.sldId) : 0));
  let nextSldId = Math.max(255, ...taken) + 1;
  for (let i = 0; i < ids.length; i++) if (!ids[i]) ids[i] = nextSldId++;
  deck.slides.forEach((slide, i) => {
    const part = `ppt/slides/slide${i + 1}.xml`;
    const alloc = new RelAlloc(part);
    alloc.id(REL.slideLayout, slide.layout);
    const xml = slideXml(slide, alloc);
    const old = slide.part ? oldNotes.get(slide.part) : undefined;
    if (notesMaster && (slide.notes.trim() || old)) {
      const notesPart = `ppt/notesSlides/notesSlide${i + 1}.xml`;
      pkg.setText(notesPart, old ? updatedNotesXml(old, slide.notes) : newNotesXml(slide.notes));
      pkg.ensureOverride(notesPart, CT_PML.notesSlide);
      pkg.setRels(notesPart, [
        { id: 'rId1', type: REL.notesMaster, target: notesMaster, external: false },
        { id: 'rId2', type: REL.slide, target: part, external: false },
      ]);
      alloc.id(REL.notesSlide, notesPart);
    }
    pkg.setText(part, xml);
    pkg.setRels(part, alloc.rels);
    pkg.ensureOverride(part, CT_PML.slide);
    const rid = freshId();
    presRels.push({ id: rid, type: REL.slide, target: part, external: false });
    sldIds.push({ id: ids[i], rid });
  });
  pkg.setRels(main, presRels);

  // presentation.xml: the slide list, in order.
  const fresh = parseXml(pkg.text(main)!);
  const froot = fresh.documentElement;
  let list = kid(froot, 'sldIdLst');
  if (!list) {
    list = fresh.createElementNS(NS.p, 'p:sldIdLst');
    const before = kid(froot, 'sldSz');
    froot.insertBefore(list, before);
  }
  for (const c of kids(list)) c.remove();
  for (const s of sldIds) {
    const el = fresh.createElementNS(NS.p, 'p:sldId');
    el.setAttribute('id', String(s.id));
    el.setAttributeNS(NS.r, 'r:id', s.rid);
    list.appendChild(el);
  }
  if (!sldIds.length) list.remove();
  // Custom shows name slides by relationship ids that are new now.
  kid(froot, 'custShowLst')?.remove();
  fixSections(froot, deck.slides, ids);
  const fsz = kid(froot, 'sldSz');
  if (fsz && (oldW !== deck.w || oldH !== deck.h)) {
    fsz.setAttribute('cx', String(deck.w));
    fsz.setAttribute('cy', String(deck.h));
    fsz.removeAttribute('type');
  }
  pkg.setText(main, XML_HEADER + serialize(froot));

  // Pictures nothing points at any more go.
  const referenced = new Set<string>();
  for (const name of pkg.files.keys()) {
    if (!name.endsWith('.rels')) continue;
    const owner = name.replace(/_rels\/([^/]+)\.rels$/, '$1');
    for (const r of pkg.rels(owner)) if (!r.external) referenced.add(r.target);
  }
  for (const name of [...pkg.files.keys()]) {
    if (name.startsWith('ppt/media/') && !referenced.has(name)) pkg.files.delete(name);
  }
  touchModified(pkg);
  return pkg.write();
}
