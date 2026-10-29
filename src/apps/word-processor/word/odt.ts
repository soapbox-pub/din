import type { JSONContent } from '@tiptap/core';
import {
  AutoStyles,
  collapse,
  contentStyles,
  decodeStyleName,
  DRAWABLE_IMAGE,
  encodeStyleName,
  FontFaces,
  imageBytes,
  inch,
  lengthPt,
  lengthPx,
  masterStyles,
  nestedList,
  ODF_MIME,
  odfColor,
  OdfDocument,
  OdfMedia,
  odfRoot,
  pt,
  textXml,
  writeOdf,
  type OdfStyles,
  type Props,
} from '@/shared/office/odf';
import { attr, esc, kid, kids, parseXml } from '@/shared/office/ooxml';
import { OFFICE_THEME } from '@/shared/office/theme';
import { addList, bulletGlyph, levelOf, parseNumbering, type Level, type Numbering } from './numbering';
import { imageStore, LETTER, storeImage, type HeaderFooter, type HFKind, type Section, type WordDoc } from './read';
import type { ParaAttrs } from './schema';
import { BUILTIN_STYLES, effectivePara, parseStyles, type ParaProps, type RunProps, type Style } from './styles';

/**
 * OpenDocument text (.odt, and flat .fodt), LibreOffice Writer's format.
 * Reading turns its named paragraph styles into Word styles (Heading 1 stays
 * Heading 1, so the outline and the Styles gallery work), its automatic
 * styles into direct formatting, its list styles into numbering definitions,
 * and its page style into the section. Writing goes the other way, from the
 * same document the .docx writer works from.
 */

const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ---- Style names ------------------------------------------------------------------------------

const TO_WORD: Record<string, string> = {
  Standard: 'Normal',
  Default: 'Normal',
  'Default Paragraph Style': 'Normal',
  Title: 'Title',
  Subtitle: 'Subtitle',
  Quotations: 'Quote',
  Quote: 'Quote',
  'Text body': 'BodyText',
  'Body Text': 'BodyText',
  'List Paragraph': 'ListParagraph',
  'No Spacing': 'NoSpacing',
};

const FROM_WORD: Record<string, [string, string]> = {
  Normal: ['Standard', 'Default Paragraph Style'],
  Title: ['Title', 'Title'],
  Subtitle: ['Subtitle', 'Subtitle'],
  Quote: ['Quotations', 'Quotations'],
  BodyText: ['Text_20_body', 'Body Text'],
  ListParagraph: ['List_20_Paragraph', 'List Paragraph'],
};

function displayName(s: { name: string; el: Element }): string {
  return attr(s.el, 'display-name') ?? decodeStyleName(s.name);
}

/** Word's own name for a built-in style id ("heading 1"), as styles.xml writes it. */
function wordName(id: string, display: string): string {
  const h = /^Heading(\d)$/.exec(id);
  if (h) return `heading ${h[1]}`;
  if (id === 'BodyText') return 'Body Text';
  if (id === 'ListParagraph') return 'List Paragraph';
  if (id === 'NoSpacing') return 'No Spacing';
  return TO_WORD[display] === id ? id : display;
}

// ---- Properties: ODF → the models ---------------------------------------------------------------

const ALIGN_IN: Record<string, ParaProps['align']> = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' };

function paraPropsOf(p: Record<string, string> | undefined): ParaProps {
  const out: ParaProps = {};
  if (!p) return out;
  const align = ALIGN_IN[p['text-align'] ?? ''];
  if (align) out.align = align;
  const px = (k: string) => lengthPx(p[k]);
  const ml = px('margin-left');
  if (ml !== null) out.indLeft = Math.round(ml * 100) / 100;
  const mr = px('margin-right');
  if (mr !== null) out.indRight = Math.round(mr * 100) / 100;
  const ti = px('text-indent');
  if (ti !== null) out.indFirst = Math.round(ti * 100) / 100;
  const mt = lengthPt(p['margin-top']);
  if (mt !== null) out.spBefore = Math.round(mt * 100) / 100;
  const mb = lengthPt(p['margin-bottom']);
  if (mb !== null) out.spAfter = Math.round(mb * 100) / 100;
  const lh = p['line-height'];
  if (lh) {
    const pct = /^([\d.]+)%$/.exec(lh);
    if (pct) {
      out.line = Math.round(parseFloat(pct[1]) * 10) / 1000;
      out.lineRule = 'auto';
    } else if (lh === 'normal') {
      out.line = 1;
      out.lineRule = 'auto';
    } else {
      const v = lengthPt(lh);
      if (v !== null) {
        out.line = Math.round(v * 100) / 100;
        out.lineRule = 'exact';
      }
    }
  }
  const least = lengthPt(p['line-height-at-least']);
  if (least !== null) {
    out.line = Math.round(least * 100) / 100;
    out.lineRule = 'atLeast';
  }
  if (p['break-before'] === 'page') out.pageBreakBefore = true;
  if (p['keep-with-next'] === 'always') out.keepNext = true;
  if (p['contextual-spacing'] === 'true') out.contextual = true;
  const bg = odfColor(p['background-color']);
  if (bg) out.shading = bg;
  return out;
}

function runPropsOf(t: Record<string, string> | undefined, styles: OdfStyles): RunProps {
  const out: RunProps = {};
  if (!t) return out;
  const font = styles.fontOf(t);
  if (font) out.font = font;
  const size = lengthPt(t['font-size']);
  if (size) out.size = Math.round(size * 2) / 2;
  const w = t['font-weight'];
  if (w) out.bold = w === 'bold' || (/^\d+$/.test(w) && Number(w) >= 600);
  const st = t['font-style'];
  if (st) out.italic = st === 'italic' || st === 'oblique';
  const u = t['text-underline-style'];
  if (u) out.underline = u !== 'none';
  const lt = t['text-line-through-style'];
  if (lt) out.strike = lt !== 'none';
  const color = odfColor(t.color);
  if (color) out.color = color;
  if (t['text-transform'] === 'uppercase') out.caps = true;
  if (t['font-variant'] === 'small-caps') out.smallCaps = true;
  const ls = lengthPt(t['letter-spacing']);
  if (ls) out.spacing = Math.round(ls * 100) / 100;
  const pos = t['text-position'];
  if (pos) {
    const first = pos.split(/\s+/)[0];
    if (first === 'super' || (first.endsWith('%') && parseFloat(first) > 0)) out.vertAlign = 'superscript';
    else if (first === 'sub' || (first.endsWith('%') && parseFloat(first) < 0)) out.vertAlign = 'subscript';
  }
  return out;
}

const HIGHLIGHTS = new Set(['#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#0000FF', '#FF0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#C0C0C0', '#000000']);

function marksOf(r: RunProps, bg: string | null, link: string | null): JSONContent['marks'] {
  const marks: NonNullable<JSONContent['marks']> = [];
  if (r.bold) marks.push({ type: 'bold' });
  if (r.italic) marks.push({ type: 'italic' });
  if (r.underline) marks.push({ type: 'underline' });
  if (r.strike) marks.push({ type: 'strike' });
  if (r.vertAlign === 'superscript') marks.push({ type: 'superscript' });
  if (r.vertAlign === 'subscript') marks.push({ type: 'subscript' });
  const ts: Record<string, string> = {};
  if (r.font) ts.fontFamily = r.font;
  if (r.size) ts.fontSize = `${r.size}pt`;
  if (r.color) ts.color = `#${r.color}`;
  const hl = bg ? `#${bg}` : null;
  if (hl && !HIGHLIGHTS.has(hl)) ts.backgroundColor = hl;
  if (Object.keys(ts).length) marks.push({ type: 'textStyle', attrs: ts });
  if (hl && HIGHLIGHTS.has(hl)) marks.push({ type: 'highlight', attrs: { color: hl } });
  if (link) marks.push({ type: 'link', attrs: { href: link } });
  return marks.length ? marks : undefined;
}

// ---- Properties: the models → WordprocessingML (for the styles of a document read from ODF) -------

const tw = (px: number) => Math.round(px * 15);

function wmlPPr(p: ParaProps): string {
  const parts: string[] = [];
  if (p.keepNext) parts.push('<w:keepNext/>');
  if (p.pageBreakBefore) parts.push('<w:pageBreakBefore/>');
  if (p.shading) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shading}"/>`);
  const sp: string[] = [];
  if (p.spBefore !== undefined) sp.push(`w:before="${Math.round(p.spBefore * 20)}"`);
  if (p.spAfter !== undefined) sp.push(`w:after="${Math.round(p.spAfter * 20)}"`);
  if (p.line !== undefined) {
    const rule = p.lineRule ?? 'auto';
    sp.push(`w:line="${rule === 'auto' ? Math.round(p.line * 240) : Math.round(p.line * 20)}" w:lineRule="${rule}"`);
  }
  if (sp.length) parts.push(`<w:spacing ${sp.join(' ')}/>`);
  const ind: string[] = [];
  if (p.indLeft !== undefined) ind.push(`w:left="${tw(p.indLeft)}"`);
  if (p.indRight !== undefined) ind.push(`w:right="${tw(p.indRight)}"`);
  if (p.indFirst !== undefined) ind.push(p.indFirst < 0 ? `w:hanging="${tw(-p.indFirst)}"` : `w:firstLine="${tw(p.indFirst)}"`);
  if (ind.length) parts.push(`<w:ind ${ind.join(' ')}/>`);
  if (p.contextual) parts.push('<w:contextualSpacing/>');
  if (p.align) parts.push(`<w:jc w:val="${p.align === 'justify' ? 'both' : p.align}"/>`);
  if (p.outlineLvl !== undefined) parts.push(`<w:outlineLvl w:val="${p.outlineLvl}"/>`);
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}

function wmlRPr(r: RunProps): string {
  const parts: string[] = [];
  const flag = (tag: string, v: boolean | undefined) => v !== undefined && parts.push(v ? `<w:${tag}/>` : `<w:${tag} w:val="0"/>`);
  if (r.font) parts.push(`<w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>`);
  flag('b', r.bold);
  flag('i', r.italic);
  flag('caps', r.caps);
  flag('smallCaps', r.smallCaps);
  flag('strike', r.strike);
  if (r.color) parts.push(`<w:color w:val="${r.color}"/>`);
  if (r.spacing) parts.push(`<w:spacing w:val="${Math.round(r.spacing * 20)}"/>`);
  if (r.size) parts.push(`<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`);
  if (r.underline !== undefined) parts.push(`<w:u w:val="${r.underline ? 'single' : 'none'}"/>`);
  if (r.vertAlign) parts.push(`<w:vertAlign w:val="${r.vertAlign}"/>`);
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

/** styles.xml (WordprocessingML) for the named paragraph styles of an ODF document. */
function stylesXmlFor(styles: OdfStyles, ids: Map<string, string>): string {
  const def = styles.defaultProps('paragraph');
  const defRun: RunProps = { font: 'Liberation Serif', size: 12, ...runPropsOf(def.text, styles) };
  const defPara: ParaProps = { spBefore: 0, spAfter: 0, line: 1, lineRule: 'auto', ...paraPropsOf(def.paragraph) };
  const out: string[] = [];
  const named = styles.all('paragraph').filter((s) => !s.automatic);
  let hasNormal = false;
  for (const s of named) {
    const id = ids.get(s.name)!;
    if (id === 'Normal') hasNormal = true;
    const parent = s.parent ? ids.get(s.parent) : undefined;
    const next = ids.get(attr(s.el, 'next-style-name') ?? '');
    const para = paraPropsOf(s.props.paragraph);
    const outline = Number(attr(s.el, 'default-outline-level') ?? '');
    if (outline >= 1 && outline <= 9) para.outlineLvl = outline - 1;
    const quick = id === 'Normal' || /^Heading[1-3]$/.test(id) || id === 'Title' || id === 'Subtitle' || id === 'Quote';
    out.push(
      `<w:style w:type="paragraph"${id === 'Normal' ? ' w:default="1"' : ''} w:styleId="${esc(id)}"><w:name w:val="${esc(wordName(id, displayName(s)))}"/>` +
        (parent && parent !== id ? `<w:basedOn w:val="${esc(parent)}"/>` : '') +
        (next && next !== id ? `<w:next w:val="${esc(next)}"/>` : '') +
        (quick ? '<w:qFormat/>' : '') +
        `${wmlPPr(para)}${wmlRPr(runPropsOf(s.props.text, styles))}</w:style>`,
    );
  }
  if (!hasNormal) out.unshift(BUILTIN_STYLES.Normal);
  for (const id of ['Hyperlink', 'TableGrid']) out.push(BUILTIN_STYLES[id]);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:styles xmlns:w="${WML}">` +
    `<w:docDefaults><w:rPrDefault>${wmlRPr(defRun) || '<w:rPr/>'}</w:rPrDefault><w:pPrDefault>${wmlPPr(defPara) || '<w:pPr/>'}</w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    out.join('') +
    '</w:styles>'
  );
}

/** Word style ids for an ODF document's named paragraph styles. */
function styleIds(styles: OdfStyles): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const s of styles.all('paragraph')) {
    if (s.automatic) continue;
    const display = displayName(s);
    const h = /^Heading (\d)$/.exec(display);
    let id = h ? `Heading${h[1]}` : (TO_WORD[display] ?? TO_WORD[decodeStyleName(s.name)] ?? (display.replace(/[^A-Za-z0-9]/g, '') || 'Style'));
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}${n}`)) n++;
      id = `${id}${n}`;
    }
    used.add(id);
    ids.set(s.name, id);
  }
  return ids;
}

// ---- Reading -------------------------------------------------------------------------------------

interface ReadCtx {
  odf: OdfDocument;
  styles: OdfStyles;
  ids: Map<string, string>;
  numbering: Numbering;
  warnings: Set<string>;
  /** numIds by list style name, for lists that continue an earlier one. */
  lists: Map<string, number>;
  /** By xml:id, for text:continue-list. */
  listIds: Map<string, number>;
  first: boolean;
}

function safeHref(href: string | null): string | null {
  const h = href?.trim() ?? '';
  return /^(https?:|mailto:)/i.test(h) ? h : null;
}

/** A paragraph style split into the named style it's based on and what's applied directly. */
function paraStyle(name: string | null, ctx: ReadCtx): { styleId: string | null; direct: Props; masterPage: boolean } {
  let direct: Props = {};
  let cur = ctx.styles.get('paragraph', name);
  let masterPage = false;
  const autos = [];
  while (cur && cur.automatic) {
    autos.unshift(cur);
    if (attr(cur.el, 'master-page-name')) masterPage = true;
    cur = ctx.styles.get('paragraph', cur.parent);
  }
  for (const a of autos) for (const [k, v] of Object.entries(a.props)) direct[k] = { ...(direct[k] ?? {}), ...v };
  if (!cur && name && !ctx.styles.get('paragraph', name)) direct = {};
  const styleId = cur ? (ctx.ids.get(cur.name) ?? null) : null;
  return { styleId: styleId === 'Normal' ? null : styleId, direct, masterPage };
}

interface Inline {
  run: RunProps;
  bg: string | null;
  link: string | null;
}

interface Walk {
  out: JSONContent[];
  space: boolean;
}

function textRunProps(name: string | null, ctx: ReadCtx): { run: RunProps; bg: string | null } {
  if (!name) return { run: {}, bg: null };
  const props = ctx.styles.resolve('text', name, false);
  return { run: runPropsOf(props.text, ctx.styles), bg: odfColor(props.text?.['background-color']) };
}

function readInline(el: Element, ctx: ReadCtx, cur: Inline, w: Walk): void {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const c = collapse(n.nodeValue ?? '', w.space);
      w.space = c.endsSpace;
      if (c.text) w.out.push({ type: 'text', text: c.text, marks: marksOf(cur.run, cur.bg, cur.link) });
      continue;
    }
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    const text = (t: string) => w.out.push({ type: 'text', text: t, marks: marksOf(cur.run, cur.bg, cur.link) });
    switch (e.localName) {
      case 's':
        text(' '.repeat(Math.max(1, Number(attr(e, 'c') ?? 1) || 1)));
        w.space = true;
        break;
      case 'tab':
        text('\t');
        w.space = false;
        break;
      case 'line-break':
        w.out.push({ type: 'hardBreak', marks: marksOf(cur.run, cur.bg, cur.link) });
        w.space = true;
        break;
      case 'span': {
        const own = textRunProps(attr(e, 'style-name'), ctx);
        readInline(e, ctx, { run: { ...cur.run, ...own.run }, bg: own.bg ?? cur.bg, link: cur.link }, w);
        break;
      }
      case 'a': {
        const own = textRunProps(attr(e, 'style-name'), ctx);
        const href = safeHref(e.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
        readInline(e, ctx, { run: { ...cur.run, ...own.run }, bg: own.bg ?? cur.bg, link: href ?? cur.link }, w);
        break;
      }
      case 'page-number':
        w.out.push({ type: 'field', attrs: { kind: 'page', text: '1' }, marks: marksOf(cur.run, cur.bg, null) });
        w.space = false;
        break;
      case 'page-count':
        w.out.push({ type: 'field', attrs: { kind: 'numpages', text: '1' }, marks: marksOf(cur.run, cur.bg, null) });
        w.space = false;
        break;
      case 'frame': {
        const img = frameImage(e, ctx);
        if (img) {
          w.out.push(img);
          w.space = false;
        }
        break;
      }
      case 'note':
        ctx.warnings.add('Footnotes and endnotes aren’t shown.');
        break;
      case 'annotation':
        ctx.warnings.add('Comments aren’t shown, and won’t be kept when you save.');
        break;
      case 'annotation-end':
      case 'bookmark':
      case 'bookmark-start':
      case 'bookmark-end':
      case 'reference-mark':
      case 'reference-mark-start':
      case 'reference-mark-end':
      case 'soft-page-break':
      case 'change':
      case 'change-start':
      case 'change-end':
      case 'toc-mark':
      case 'alphabetical-index-mark':
        break;
      case 'custom-shape':
      case 'rect':
      case 'line':
      case 'ellipse':
      case 'g':
        ctx.warnings.add('Shapes and drawings aren’t shown, and won’t be kept when you save.');
        break;
      default:
        // Fields (dates, titles...) and links on pictures: their text and contents.
        readInline(e, ctx, cur, w);
    }
  }
}

function frameImage(frame: Element, ctx: ReadCtx): JSONContent | null {
  const image = kid(frame, 'image');
  if (!image) {
    if (kid(frame, 'text-box')) ctx.warnings.add('Text boxes aren’t shown, and won’t be kept when you save.');
    else if (kid(frame, 'object') || kid(frame, 'object-ole')) ctx.warnings.add('Charts and embedded objects aren’t shown, and won’t be kept when you save.');
    return null;
  }
  const pic = imageBytes(ctx.odf, image);
  if (!pic) return null;
  if (!DRAWABLE_IMAGE.test(pic.ext)) {
    ctx.warnings.add('Some pictures are in formats (EMF/WMF/SVM) that can’t be shown.');
    return null;
  }
  const anchor = attr(frame, 'anchor-type');
  if (anchor && anchor !== 'as-char') ctx.warnings.add('Floating pictures are shown in line with the text.');
  const w = lengthPx(attr(frame, 'width')) ?? 96;
  const h = lengthPx(attr(frame, 'height')) ?? 96;
  const title = kid(frame, 'desc')?.textContent ?? kid(frame, 'title')?.textContent ?? '';
  return { type: 'image', attrs: { src: storeImage(pic.data, pic.ext), width: Math.round(w), height: Math.round(h), alt: title } };
}

function readParagraph(p: Element, ctx: ReadCtx, list: { numId: number; ilvl: number } | null): JSONContent[] {
  const { styleId, direct, masterPage } = paraStyle(attr(p, 'style-name'), ctx);
  const own = paraPropsOf(direct.paragraph);
  const a: Partial<ParaAttrs> = {};
  if (styleId) a.styleId = styleId;
  if (own.align) a.align = own.align;
  if (own.indLeft !== undefined) a.indLeft = own.indLeft;
  if (own.indRight !== undefined) a.indRight = own.indRight;
  if (own.indFirst !== undefined) a.indFirst = own.indFirst;
  if (own.spBefore !== undefined) a.spBefore = own.spBefore;
  if (own.spAfter !== undefined) a.spAfter = own.spAfter;
  if (own.line !== undefined) {
    a.line = own.line;
    a.lineRule = own.lineRule ?? 'auto';
  }
  if (own.shading) a.shading = own.shading;
  if ((own.pageBreakBefore || masterPage) && !ctx.first) a.pageBreakBefore = true;
  if (list) {
    a.numId = list.numId;
    a.ilvl = list.ilvl;
  }
  if (p.localName === 'h' && !styleId) {
    const lvl = Number(attr(p, 'outline-level') ?? 1) || 1;
    if (lvl >= 1 && lvl <= 3) a.styleId = `Heading${lvl}`;
  }
  ctx.first = false;
  const run = runPropsOf(direct.text, ctx.styles);
  const w: Walk = { out: [], space: true };
  readInline(p, ctx, { run, bg: odfColor(direct.text?.['background-color']), link: null }, w);
  // Trailing white space at the end of a paragraph is dropped too.
  const last = w.out[w.out.length - 1];
  if (last?.type === 'text' && last.text?.endsWith(' ') && !/\S {2,}$/.test(last.text)) {
    last.text = last.text.replace(/ $/, '');
    if (!last.text) w.out.pop();
  }
  const blocks: JSONContent[] = [{ type: 'paragraph', attrs: a, content: w.out.length ? w.out : undefined }];
  if (direct.paragraph?.['break-after'] === 'page') blocks.push({ type: 'pageBreak' });
  return blocks;
}

const NUM_FORMATS: Record<string, string> = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman', '': 'none' };

function levelsOf(listStyle: Element | undefined): Level[] {
  const levels: Level[] = [];
  for (let i = 0; i < 9; i++) {
    const el = kids(listStyle).find((e) => Number(attr(e, 'level')) === i + 1);
    const props = kid(el, 'list-level-properties');
    const align = kid(props, 'list-level-label-alignment');
    let indLeft = 48 * (i + 1);
    let hanging = 24;
    if (align) {
      indLeft = lengthPx(attr(align, 'margin-left')) ?? indLeft;
      hanging = -(lengthPx(attr(align, 'text-indent')) ?? -hanging);
    } else if (props) {
      const before = lengthPx(attr(props, 'space-before')) ?? 0;
      const width = lengthPx(attr(props, 'min-label-width')) ?? 24;
      indLeft = before + width;
      hanging = width;
    }
    if (el?.localName === 'list-level-style-number') {
      const fmt = NUM_FORMATS[attr(el, 'num-format') ?? '1'] ?? 'decimal';
      const shown = Math.max(1, Math.min(i + 1, Number(attr(el, 'display-levels') ?? 1) || 1));
      const nums = Array.from({ length: shown }, (_, k) => `%${i + 2 - shown + k}`).join('.');
      levels.push({ start: Number(attr(el, 'start-value') ?? 1) || 1, fmt, text: `${attr(el, 'num-prefix') ?? ''}${nums}${attr(el, 'num-suffix') ?? ''}`, indLeft, hanging });
    } else {
      const char = el?.localName === 'list-level-style-bullet' ? (attr(el, 'bullet-char') ?? '•') : '•';
      levels.push({ start: 1, fmt: 'bullet', text: char, indLeft, hanging });
    }
  }
  return levels;
}

function readList(list: Element, ctx: ReadCtx, depth: number, inherited: { style: string | null; numId: number | null }, out: JSONContent[]): void {
  const styleName = attr(list, 'style-name') ?? inherited.style;
  let numId = inherited.numId;
  if (numId === null) {
    const cont = attr(list, 'continue-list');
    const continues = attr(list, 'continue-numbering') === 'true';
    if (cont && ctx.listIds.has(cont)) numId = ctx.listIds.get(cont)!;
    else if (continues && styleName && ctx.lists.has(styleName)) numId = ctx.lists.get(styleName)!;
    else numId = addList(ctx.numbering, levelsOf(styleName ? ctx.styles.listStyles.get(styleName) : undefined));
    if (styleName) ctx.lists.set(styleName, numId);
  }
  const xmlId = list.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') ?? attr(list, 'id');
  if (xmlId) ctx.listIds.set(xmlId, numId);
  const ilvl = Math.min(8, depth);
  for (const item of kids(list)) {
    if (item.localName !== 'list-item' && item.localName !== 'list-header') continue;
    let numbered = item.localName === 'list-item';
    for (const c of kids(item)) {
      if (c.localName === 'p' || c.localName === 'h') {
        const blocks = readParagraph(c, ctx, numbered ? { numId, ilvl } : null);
        if (!numbered) {
          // Further paragraphs of an item line up with its text, without a number.
          const lvl = levelOf(ctx.numbering, numId, ilvl);
          const pa = blocks[0].attrs as Partial<ParaAttrs>;
          if (lvl && pa.indLeft === undefined) pa.indLeft = lvl.indLeft;
        }
        out.push(...blocks);
        numbered = false;
      } else if (c.localName === 'list') {
        readList(c, ctx, depth + 1, { style: styleName, numId }, out);
        numbered = false;
      } else out.push(...readBlocks(c, ctx, true));
    }
  }
}

function cellBorders(props: Props): boolean {
  const c = props['table-cell'] ?? {};
  return ['border', 'border-top', 'border-bottom', 'border-left', 'border-right'].some((k) => c[k] && c[k] !== 'none' && !/^0(\.0+)?[a-z]*\s/.test(c[k]));
}

function readTable(tbl: Element, ctx: ReadCtx): JSONContent {
  const widths: number[] = [];
  const addCols = (parent: Element) => {
    for (const c of kids(parent)) {
      if (c.localName === 'table-column') {
        const n = Math.min(1000, Number(attr(c, 'number-columns-repeated') ?? 1) || 1);
        const w = lengthPx(ctx.styles.resolve('table-column', attr(c, 'style-name'))['table-column']?.['column-width']);
        for (let i = 0; i < n; i++) widths.push(w ?? 0);
      } else if (['table-columns', 'table-header-columns', 'table-column-group'].includes(c.localName)) addCols(c);
    }
  };
  addCols(tbl);
  const rows: Element[] = [];
  const addRows = (parent: Element) => {
    for (const c of kids(parent)) {
      if (c.localName === 'table-row') {
        const n = Math.min(1000, Number(attr(c, 'number-rows-repeated') ?? 1) || 1);
        for (let i = 0; i < n; i++) rows.push(c);
      } else if (['table-rows', 'table-header-rows', 'table-row-group'].includes(c.localName)) addRows(c);
    }
  };
  addRows(tbl);
  let anyBorder = false;
  const content: JSONContent[] = rows.map((tr) => {
    const cells: JSONContent[] = [];
    let col = 0;
    for (const tc of kids(tr)) {
      const repeat = Math.min(1000, Number(attr(tc, 'number-columns-repeated') ?? 1) || 1);
      if (tc.localName === 'covered-table-cell') {
        col += repeat;
        continue;
      }
      if (tc.localName !== 'table-cell') continue;
      for (let k = 0; k < repeat; k++) {
        const span = Math.max(1, Number(attr(tc, 'number-columns-spanned') ?? 1) || 1);
        const rowspan = Math.max(1, Number(attr(tc, 'number-rows-spanned') ?? 1) || 1);
        const props = ctx.styles.resolve('table-cell', attr(tc, 'style-name'));
        if (cellBorders(props)) anyBorder = true;
        const cp = props['table-cell'] ?? {};
        const bg = odfColor(cp['background-color']);
        const va = cp['vertical-align'];
        const ws = widths.slice(col, col + span);
        const blocks = readBlocks(tc, ctx);
        cells.push({
          type: 'tableCell',
          attrs: {
            colspan: span,
            rowspan,
            colwidth: ws.length === span && ws.every((w) => w > 0) ? ws.map((w) => Math.max(24, Math.round(w))) : null,
            background: bg,
            valign: va === 'middle' ? 'middle' : va === 'bottom' ? 'bottom' : null,
          },
          content: blocks.length ? blocks : [{ type: 'paragraph' }],
        });
        col += span;
      }
    }
    return { type: 'tableRow', content: cells.length ? cells : [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] };
  });
  const tp = ctx.styles.resolve('table', attr(tbl, 'style-name')).table ?? {};
  const align = tp.align;
  const indent = lengthPx(tp['margin-left']);
  return {
    type: 'table',
    attrs: {
      borders: anyBorder,
      bordersFromFile: anyBorder,
      look: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRows: false },
      styleId: null,
      align: align === 'center' ? 'center' : null,
      indent: indent && align !== 'center' && align !== 'right' ? indent : null,
      tblPr: null,
    },
    content: content.length ? content : [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] }],
  };
}

function readBlocks(parent: Element, ctx: ReadCtx, nested = false): JSONContent[] {
  const out: JSONContent[] = [];
  const run = (el: Element) => {
    switch (el.localName) {
      case 'p':
      case 'h':
        out.push(...readParagraph(el, ctx, null));
        break;
      case 'list':
        readList(el, ctx, 0, { style: null, numId: null }, out);
        break;
      case 'table':
        if (el.namespaceURI === 'urn:oasis:names:tc:opendocument:xmlns:table:1.0') {
          out.push(readTable(el, ctx));
          ctx.first = false;
        }
        break;
      case 'section':
      case 'index-body':
      case 'index-title':
        for (const c of kids(el)) run(c);
        break;
      case 'table-of-content':
      case 'alphabetical-index':
      case 'illustration-index':
      case 'table-index':
      case 'object-index':
      case 'user-index':
      case 'bibliography': {
        const body = kid(el, 'index-body');
        if (body) for (const c of kids(body)) run(c);
        break;
      }
      case 'frame': {
        const img = frameImage(el, ctx);
        if (img) out.push({ type: 'paragraph', content: [img] });
        break;
      }
      case 'custom-shape':
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'g':
        ctx.warnings.add('Shapes and drawings aren’t shown, and won’t be kept when you save.');
        break;
    }
  };
  for (const c of kids(parent)) run(c);
  if (!nested && !out.length) out.push({ type: 'paragraph' });
  return out;
}

function readSection(odf: OdfDocument, firstMaster: string | null): { section: Section; master: Element | null } {
  const masters = kids(kid(odf.styles.documentElement, 'master-styles'), 'master-page');
  const master = masters.find((m) => attr(m, 'name') === firstMaster) ?? masters.find((m) => attr(m, 'name') === 'Standard') ?? masters[0] ?? null;
  const layoutName = attr(master, 'page-layout-name');
  const layout = kids(kid(odf.styles.documentElement, 'automatic-styles'), 'page-layout').find((l) => attr(l, 'name') === layoutName);
  const pp = kid(layout, 'page-layout-properties');
  if (!pp) return { section: { ...LETTER }, master };
  const px = (v: string | null, def: number) => lengthPx(v) ?? def;
  const mt = px(attr(pp, 'margin-top') ?? attr(pp, 'margin'), 76);
  const mb = px(attr(pp, 'margin-bottom') ?? attr(pp, 'margin'), 76);
  const hasHeader = !!kids(master).find((c) => c.localName.startsWith('header') && attr(c, 'display') !== 'false');
  const hasFooter = !!kids(master).find((c) => c.localName.startsWith('footer') && attr(c, 'display') !== 'false');
  const hf = (name: string) => kid(kid(layout, name), 'header-footer-properties');
  const hp = hf('header-style');
  const fp = hf('footer-style');
  const hh = Math.max(lengthPx(attr(hp, 'min-height') ?? attr(hp, 'height')) ?? 0, 19);
  const fh = Math.max(lengthPx(attr(fp, 'min-height') ?? attr(fp, 'height')) ?? 0, 19);
  const section: Section = {
    pageW: px(attr(pp, 'page-width'), LETTER.pageW),
    pageH: px(attr(pp, 'page-height'), LETTER.pageH),
    mLeft: px(attr(pp, 'margin-left') ?? attr(pp, 'margin'), 76),
    mRight: px(attr(pp, 'margin-right') ?? attr(pp, 'margin'), 76),
    mTop: hasHeader ? mt + hh + (lengthPx(attr(hp, 'margin-bottom')) ?? 0) : mt,
    mBottom: hasFooter ? mb + fh + (lengthPx(attr(fp, 'margin-top')) ?? 0) : mb,
    mHeader: hasHeader ? mt : Math.min(48, mt / 2),
    mFooter: hasFooter ? mb : Math.min(48, mb / 2),
    titlePg: !!kids(master).find((c) => c.localName === 'header-first' || c.localName === 'footer-first'),
    xml: null,
  };
  return { section, master };
}

/** The first paragraph's master page, which decides the page style. */
function firstMasterPage(body: Element, styles: OdfStyles): string | null {
  for (const el of Array.from(body.getElementsByTagName('*'))) {
    if (el.localName !== 'p' && el.localName !== 'h' && el.localName !== 'table') continue;
    let s = styles.get(el.localName === 'table' ? 'table' : 'paragraph', attr(el, 'style-name'));
    while (s) {
      const m = attr(s.el, 'master-page-name');
      if (m) return m;
      s = styles.get(s.family, s.parent);
    }
    return null;
  }
  return null;
}

export function readOdt(bytes: Uint8Array): WordDoc {
  const odf = OdfDocument.read(bytes, 'text', 'document');
  const styles = contentStyles(odf);
  const ids = styleIds(styles);
  const numbering = parseNumbering(null);
  const ctx: ReadCtx = { odf, styles, ids, numbering, warnings: new Set(), lists: new Map(), listIds: new Map(), first: true };
  const body = odf.body('text');
  const content = readBlocks(body, ctx);
  const ms = masterStyles(odf);
  const { section, master } = readSection(odf, firstMasterPage(body, styles));

  const headers: WordDoc['headers'] = {};
  const footers: WordDoc['footers'] = {};
  const hctx: ReadCtx = { ...ctx, styles: ms, first: true };
  for (const c of kids(master)) {
    if (attr(c, 'display') === 'false') continue;
    const m = /^(header|footer)(-first|-left)?$/.exec(c.localName);
    if (!m || m[2] === '-left') continue;
    const type: HFKind = m[2] === '-first' ? 'first' : 'default';
    const hf: HeaderFooter = { part: null, content: readBlocks(c, hctx), modified: true };
    (m[1] === 'header' ? headers : footers)[type] = hf;
  }
  if (odf.hasPrefix('Object ')) ctx.warnings.add('Charts and embedded objects aren’t shown, and won’t be kept when you save.');

  const stylesXml = stylesXmlFor(styles, ids);
  return {
    pkg: null,
    docPart: 'word/document.xml',
    content: { type: 'doc', content },
    styles: parseStyles(parseXml(stylesXml), OFFICE_THEME),
    numbering,
    section,
    headers,
    footers,
    theme: OFFICE_THEME,
    warnings: [...ctx.warnings],
    stylesXml,
  };
}

// ---- Writing -------------------------------------------------------------------------------------

type Marks = NonNullable<JSONContent['marks']>;

const ALIGN_OUT: Record<string, string> = { left: 'start', center: 'center', right: 'end', justify: 'justify' };

function paraPropsXml(p: ParaProps, extra = ''): string {
  const a: string[] = [];
  if (p.align) a.push(`fo:text-align="${ALIGN_OUT[p.align] ?? 'start'}"`);
  if (p.indLeft !== undefined) a.push(`fo:margin-left="${inch(p.indLeft)}"`);
  if (p.indRight !== undefined) a.push(`fo:margin-right="${inch(p.indRight)}"`);
  if (p.indFirst !== undefined) a.push(`fo:text-indent="${inch(p.indFirst)}"`);
  if (p.spBefore !== undefined) a.push(`fo:margin-top="${pt(p.spBefore)}"`);
  if (p.spAfter !== undefined) a.push(`fo:margin-bottom="${pt(p.spAfter)}"`);
  if (p.line !== undefined) {
    const rule = p.lineRule ?? 'auto';
    if (rule === 'auto') a.push(`fo:line-height="${Math.round(p.line * 100)}%"`);
    else if (rule === 'exact') a.push(`fo:line-height="${pt(p.line)}"`);
    else a.push(`style:line-height-at-least="${pt(p.line)}"`);
  }
  if (p.pageBreakBefore) a.push('fo:break-before="page"');
  if (p.keepNext) a.push('fo:keep-with-next="always"');
  if (p.contextual) a.push('style:contextual-spacing="true"');
  if (p.shading) a.push(`fo:background-color="#${p.shading}"`);
  if (extra) a.push(extra);
  return a.length ? `<style:paragraph-properties ${a.join(' ')}/>` : '';
}

interface TextLook extends RunProps {
  bg?: string;
}

function textPropsXml(r: TextLook, fonts: FontFaces): string {
  const a: string[] = [];
  const font = fonts.use(r.font);
  if (font) a.push(`style:font-name="${esc(font)}"`);
  if (r.size) a.push(`fo:font-size="${pt(r.size)}" style:font-size-asian="${pt(r.size)}" style:font-size-complex="${pt(r.size)}"`);
  if (r.bold !== undefined) {
    const v = r.bold ? 'bold' : 'normal';
    a.push(`fo:font-weight="${v}" style:font-weight-asian="${v}" style:font-weight-complex="${v}"`);
  }
  if (r.italic !== undefined) {
    const v = r.italic ? 'italic' : 'normal';
    a.push(`fo:font-style="${v}" style:font-style-asian="${v}" style:font-style-complex="${v}"`);
  }
  if (r.underline !== undefined) a.push(r.underline ? 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : 'style:text-underline-style="none"');
  if (r.strike !== undefined) a.push(r.strike ? 'style:text-line-through-style="solid" style:text-line-through-type="single"' : 'style:text-line-through-style="none"');
  if (r.vertAlign) a.push(`style:text-position="${r.vertAlign === 'superscript' ? 'super' : 'sub'} 58%"`);
  if (r.color) a.push(`fo:color="#${r.color}"`);
  if (r.caps) a.push('fo:text-transform="uppercase"');
  if (r.smallCaps) a.push('fo:font-variant="small-caps"');
  if (r.spacing) a.push(`fo:letter-spacing="${pt(r.spacing)}"`);
  if (r.bg) a.push(`fo:background-color="#${r.bg}"`);
  return a.length ? `<style:text-properties ${a.join(' ')}/>` : '';
}

function lookOf(marks: Marks | undefined): TextLook {
  const r: TextLook = {};
  if (!marks) return r;
  for (const m of marks) {
    switch (m.type) {
      case 'bold': r.bold = true; break;
      case 'italic': r.italic = true; break;
      case 'underline': r.underline = true; break;
      case 'strike': r.strike = true; break;
      case 'superscript': r.vertAlign = 'superscript'; break;
      case 'subscript': r.vertAlign = 'subscript'; break;
      case 'highlight': {
        const c = String(m.attrs?.color ?? '').replace('#', '');
        if (/^[0-9a-f]{6}$/i.test(c)) r.bg = c.toUpperCase();
        break;
      }
      case 'textStyle': {
        const ts = m.attrs ?? {};
        if (ts.fontFamily) r.font = String(ts.fontFamily).replace(/^["']|["']$/g, '').split(',')[0].trim();
        const size = parseFloat(String(ts.fontSize ?? ''));
        if (Number.isFinite(size) && size > 0) r.size = size;
        const color = String(ts.color ?? '').replace('#', '');
        if (/^[0-9a-f]{6}$/i.test(color)) r.color = color.toUpperCase();
        const bg = String(ts.backgroundColor ?? '').replace('#', '');
        if (/^[0-9a-f]{6}$/i.test(bg) && !r.bg) r.bg = bg.toUpperCase();
        break;
      }
    }
  }
  return r;
}

function paraAttrsProps(a: Record<string, unknown>): ParaProps {
  const p: ParaProps = {};
  if (typeof a.align === 'string') p.align = a.align as ParaProps['align'];
  if (typeof a.indLeft === 'number') p.indLeft = a.indLeft;
  if (typeof a.indRight === 'number') p.indRight = a.indRight;
  if (typeof a.indFirst === 'number') p.indFirst = a.indFirst;
  if (typeof a.spBefore === 'number') p.spBefore = a.spBefore;
  if (typeof a.spAfter === 'number') p.spAfter = a.spAfter;
  if (typeof a.line === 'number') {
    p.line = a.line;
    p.lineRule = (a.lineRule as ParaProps['lineRule']) ?? 'auto';
  }
  if (a.pageBreakBefore) p.pageBreakBefore = true;
  if (typeof a.shading === 'string') p.shading = a.shading;
  return p;
}

/** The ODF name (and display name) a Word paragraph style is written under. */
function odfStyleName(s: Style | undefined, id: string): { name: string; display: string } {
  const h = /^Heading(\d)$/.exec(id);
  if (h) return { name: `Heading_20_${h[1]}`, display: `Heading ${h[1]}` };
  const known = FROM_WORD[id];
  if (known) return { name: known[0], display: known[1] };
  const display = s?.name ?? id;
  return { name: encodeStyleName(display), display };
}

const FORMAT_OUT: Record<string, string> = { decimal: '1', decimalZero: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I', none: '' };

/** A Word list's levels as a text:list-style. */
function listStyleXml(name: string, n: Numbering, numId: number): string {
  const levels: string[] = [];
  for (let i = 0; i < 9; i++) {
    const lv = levelOf(n, numId, i) ?? { start: 1, fmt: 'bullet', text: '•', indLeft: 48 * (i + 1), hanging: 24 };
    const props = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${inch(lv.indLeft)}" fo:text-indent="${inch(-lv.hanging)}" fo:margin-left="${inch(lv.indLeft)}"/></style:list-level-properties>`;
    if (lv.fmt === 'bullet') {
      levels.push(`<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="${esc(bulletGlyph(lv.text, lv.font) || '•')}">${props}</text:list-level-style-bullet>`);
    } else {
      const first = lv.text.indexOf('%');
      const m = lv.text.match(/%\d/g) ?? [];
      const lastIdx = lv.text.lastIndexOf('%');
      const prefix = first >= 0 ? lv.text.slice(0, first) : lv.text;
      const suffix = lastIdx >= 0 ? lv.text.slice(lastIdx + 2) : '';
      levels.push(
        `<text:list-level-style-number text:level="${i + 1}"${prefix ? ` style:num-prefix="${esc(prefix)}"` : ''}${suffix ? ` style:num-suffix="${esc(suffix)}"` : ''} style:num-format="${FORMAT_OUT[lv.fmt] ?? '1'}"${lv.start !== 1 ? ` text:start-value="${lv.start}"` : ''}${m.length > 1 ? ` text:display-levels="${m.length}"` : ''}>${props}</text:list-level-style-number>`,
      );
    }
  }
  return `<text:list-style style:name="${name}">${levels.join('')}</text:list-style>`;
}

class OdtWriter {
  para: AutoStyles;
  text: AutoStyles;
  table: AutoStyles;
  graphic: AutoStyles;
  private lists = new Set<number>();
  private listXml: string[] = [];
  private seenLists = new Set<number>();
  private tableCount = 0;

  constructor(
    private doc: WordDoc,
    private fonts: FontFaces,
    private media: OdfMedia,
    private counters: { image: number },
    private prefix: string,
  ) {
    this.para = new AutoStyles(`${prefix}P`);
    this.text = new AutoStyles(`${prefix}T`);
    this.table = new AutoStyles(`${prefix}Tbl`);
    this.graphic = new AutoStyles(`${prefix}fr`);
  }

  autoStylesXml(): string {
    return this.para.xml() + this.text.xml() + this.table.xml() + this.graphic.xml() + this.listXml.join('');
  }

  private listName(numId: number): string {
    const name = `${this.prefix}L${numId}`;
    if (!this.lists.has(numId)) {
      this.lists.add(numId);
      this.listXml.push(listStyleXml(name, this.doc.numbering, numId));
    }
    return name;
  }

  private inline(nodes: JSONContent[] | undefined): string {
    if (!nodes) return '';
    const out: string[] = [];
    let i = 0;
    while (i < nodes.length) {
      const href = nodes[i].marks?.find((m) => m.type === 'link')?.attrs?.href as string | undefined;
      let j = i + 1;
      if (href) while (j < nodes.length && nodes[j].marks?.find((m) => m.type === 'link')?.attrs?.href === href) j++;
      const inner = nodes.slice(i, j).map((n) => this.node(n)).join('');
      if (href && /^(https?:|mailto:)/i.test(href)) out.push(`<text:a xlink:type="simple" xlink:href="${esc(href)}" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">${inner}</text:a>`);
      else out.push(inner);
      i = j;
    }
    return out.join('');
  }

  private span(marks: Marks | undefined, inner: string): string {
    const look = lookOf(marks?.filter((m) => m.type !== 'link'));
    const props = textPropsXml(look, this.fonts);
    if (!props) return inner;
    return `<text:span text:style-name="${this.text.name('text', props)}">${inner}</text:span>`;
  }

  private node(n: JSONContent): string {
    switch (n.type) {
      case 'text':
        return this.span(n.marks, textXml(n.text ?? ''));
      case 'hardBreak':
        return '<text:line-break/>';
      case 'field':
        return this.span(n.marks, n.attrs?.kind === 'numpages' ? '<text:page-count>1</text:page-count>' : '<text:page-number text:select-page="current">1</text:page-number>');
      case 'image': {
        const src = String(n.attrs?.src ?? '');
        const stored = imageStore.get(src) ?? decodeDataUrl(src);
        if (!stored) return '';
        const path = this.media.add(stored.data, stored.ext);
        const k = ++this.counters.image;
        const style = this.graphic.name('graphic', '<style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" style:mirror="none" fo:clip="rect(0in, 0in, 0in, 0in)" draw:luminance="0%" draw:contrast="0%" draw:red="0%" draw:green="0%" draw:blue="0%" draw:gamma="100%" draw:color-inversion="false" draw:image-opacity="100%" draw:color-mode="standard"/>', { 'style:parent-style-name': 'Graphics' });
        const alt = String(n.attrs?.alt ?? '');
        return `<draw:frame draw:style-name="${style}" draw:name="Image${k}" text:anchor-type="as-char" svg:width="${inch(Number(n.attrs?.width) || 96)}" svg:height="${inch(Number(n.attrs?.height) || 96)}" draw:z-index="${k}"><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="${this.media.files.find((f) => f.path === path)?.mime ?? 'image/png'}"/>${alt ? `<svg:desc>${esc(alt)}</svg:desc>` : ''}</draw:frame>`;
      }
      default:
        return '';
    }
  }

  private paragraph(node: JSONContent, breakBefore: boolean): string {
    const a = (node.attrs ?? {}) as Record<string, unknown>;
    const id = typeof a.styleId === 'string' ? a.styleId : this.doc.styles.defaultParagraph;
    const named = odfStyleName(this.doc.styles.styles.get(id), id).name;
    const props = paraAttrsProps(a);
    if (breakBefore) props.pageBreakBefore = true;
    const ppr = paraPropsXml(props);
    const style = ppr ? this.para.name('paragraph', ppr, { 'style:parent-style-name': named }) : named;
    const outline = effectivePara(this.doc.styles, typeof a.styleId === 'string' ? a.styleId : null).outlineLvl;
    const body = this.inline(node.content);
    if (outline !== undefined && outline >= 0 && outline < 9) return `<text:h text:style-name="${style}" text:outline-level="${outline + 1}">${body}</text:h>`;
    return `<text:p text:style-name="${style}">${body}</text:p>`;
  }

  private list(items: { node: JSONContent; breakBefore: boolean }[], numId: number): string {
    const name = this.listName(numId);
    const cont = this.seenLists.has(numId);
    this.seenLists.add(numId);
    return nestedList(
      items.map(({ node, breakBefore }) => ({ level: Math.min(8, Number(node.attrs?.ilvl) || 0), xml: this.paragraph(node, breakBefore) })),
      ` text:style-name="${name}"${cont ? ' text:continue-numbering="true"' : ''}`,
    );
  }

  blocks(blocks: JSONContent[]): string {
    const out: string[] = [];
    let pendingBreak = false;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'pageBreak') {
        if (pendingBreak) out.push(this.paragraph({ type: 'paragraph' }, true));
        pendingBreak = true;
        continue;
      }
      if (b.type === 'paragraph' && b.attrs?.numId) {
        const numId = Number(b.attrs.numId);
        const items: { node: JSONContent; breakBefore: boolean }[] = [];
        while (i < blocks.length && blocks[i].type === 'paragraph' && Number(blocks[i].attrs?.numId) === numId) {
          items.push({ node: blocks[i], breakBefore: pendingBreak });
          pendingBreak = false;
          i++;
        }
        i--;
        out.push(this.list(items, numId));
        continue;
      }
      if (b.type === 'paragraph') {
        out.push(this.paragraph(b, pendingBreak));
        pendingBreak = false;
        continue;
      }
      if (b.type === 'table') {
        if (pendingBreak) out.push(this.paragraph({ type: 'paragraph' }, true));
        pendingBreak = false;
        out.push(this.tableXml(b));
      }
    }
    if (pendingBreak) out.push(this.paragraph({ type: 'paragraph' }, true));
    return out.join('');
  }

  private tableXml(node: JSONContent): string {
    const rows = node.content ?? [];
    const textWidth = this.doc.section.pageW - this.doc.section.mLeft - this.doc.section.mRight;
    // Lay the cells out on a grid: rowspans take room in the rows below.
    const taken: Map<number, { until: number; span: number }>[] = [];
    const grid: number[] = [];
    const layout: { cell: JSONContent | null; span: number }[][] = [];
    rows.forEach((row, r) => {
      const line: { cell: JSONContent | null; span: number }[] = [];
      let col = 0;
      const cells = [...(row.content ?? [])];
      const owner = (c: number) => taken.find((m, rr) => rr < r && (m.get(c)?.until ?? -1) >= r)?.get(c);
      while (cells.length || owner(col)) {
        const o = owner(col);
        if (o) {
          for (let k = 0; k < o.span; k++) line.push({ cell: null, span: 1 });
          col += o.span;
          continue;
        }
        const cell = cells.shift()!;
        const span = Number(cell.attrs?.colspan) || 1;
        const rowspan = Number(cell.attrs?.rowspan) || 1;
        const widths = (cell.attrs?.colwidth as number[] | null) ?? [];
        for (let k = 0; k < span; k++) if (widths[k] && !grid[col + k]) grid[col + k] = widths[k];
        if (rowspan > 1) (taken[r] ??= new Map()).set(col, { until: r + rowspan - 1, span });
        line.push({ cell, span });
        for (let k = 1; k < span; k++) line.push({ cell: null, span: 1 });
        col += span;
      }
      layout.push(line);
    });
    const cols = Math.max(1, ...layout.map((l) => l.length));
    const known = grid.filter(Boolean);
    const rest = Math.max(1, cols - known.length);
    const fallback = Math.max(24, (textWidth - known.reduce((s, w) => s + w, 0)) / rest);
    for (let c = 0; c < cols; c++) if (!grid[c]) grid[c] = known.length === cols ? textWidth / cols : fallback;
    const total = grid.slice(0, cols).reduce((s, w) => s + w, 0);

    const a = node.attrs ?? {};
    const styleBorders = typeof a.styleId === 'string' ? this.doc.styles.styles.get(a.styleId)?.tableBorders : undefined;
    const borders = a.borders === true || (a.borders !== false && !!styleBorders);
    const k = ++this.tableCount;
    const tableStyle = this.table.name(
      'table',
      `<style:table-properties style:width="${inch(total)}" table:align="${a.align === 'center' ? 'center' : 'left'}"${typeof a.indent === 'number' && a.align !== 'center' ? ` fo:margin-left="${inch(a.indent)}"` : ''}/>`,
    );
    const colsXml = grid
      .slice(0, cols)
      .map((w) => `<table:table-column table:style-name="${this.table.name('table-column', `<style:table-column-properties style:column-width="${inch(w)}"/>`)}"/>`)
      .join('');
    const rowsXml = layout.map((line) => {
      const cells = line.map(({ cell }) => {
        if (!cell) return '<table:covered-table-cell/>';
        const ca = cell.attrs ?? {};
        const props = [
          'fo:padding="0.0417in"',
          borders ? 'fo:border="0.5pt solid #000000"' : 'fo:border="none"',
          typeof ca.background === 'string' ? `fo:background-color="#${ca.background}"` : '',
          ca.valign === 'middle' || ca.valign === 'bottom' ? `style:vertical-align="${ca.valign}"` : '',
        ].filter(Boolean);
        const style = this.table.name('table-cell', `<style:table-cell-properties ${props.join(' ')}/>`);
        const span = Number(ca.colspan) || 1;
        const rowspan = Number(ca.rowspan) || 1;
        const body = this.blocks(cell.content ?? []) || '<text:p text:style-name="Table_20_Contents"/>';
        return `<table:table-cell table:style-name="${style}"${span > 1 ? ` table:number-columns-spanned="${span}"` : ''}${rowspan > 1 ? ` table:number-rows-spanned="${rowspan}"` : ''} office:value-type="string">${body}</table:table-cell>`;
      });
      return `<table:table-row>${cells.join('')}</table:table-row>`;
    });
    return `<table:table table:name="${this.prefix}Table${k}" table:style-name="${tableStyle}">${colsXml}${rowsXml.join('')}</table:table>`;
  }
}

function decodeDataUrl(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { data, ext: m[1] };
}

function namedStylesXml(doc: WordDoc, fonts: FontFaces): string {
  const sheet = doc.styles;
  const defRun: TextLook = { ...sheet.defaultsRun };
  const out: string[] = [
    `<style:default-style style:family="paragraph">${paraPropsXml(sheet.defaultsPara, 'style:writing-mode="page" style:tab-stop-distance="0.5in"')}${textPropsXml(defRun, fonts)}</style:default-style>`,
    '<style:default-style style:family="graphic"><style:graphic-properties draw:shadow="hidden"/></style:default-style>',
  ];
  let hasNormal = false;
  for (const s of sheet.styles.values()) {
    if (s.type !== 'paragraph') continue;
    const { name, display } = odfStyleName(s, s.id);
    if (name === 'Standard') hasNormal = true;
    const parent = s.basedOn && sheet.styles.get(s.basedOn)?.type === 'paragraph' ? odfStyleName(sheet.styles.get(s.basedOn), s.basedOn).name : null;
    const next = s.next && sheet.styles.get(s.next) ? odfStyleName(sheet.styles.get(s.next), s.next).name : null;
    const outline = s.ownPara.outlineLvl;
    const own: ParaProps = { ...s.ownPara };
    delete own.numId;
    delete own.ilvl;
    out.push(
      `<style:style style:name="${esc(name)}"${display !== name ? ` style:display-name="${esc(display)}"` : ''} style:family="paragraph"${parent && parent !== name ? ` style:parent-style-name="${esc(parent)}"` : ''}${next && next !== name ? ` style:next-style-name="${esc(next)}"` : ''}${outline !== undefined ? ` style:default-outline-level="${outline + 1}"` : ''} style:class="text">` +
        paraPropsXml(own) +
        textPropsXml(s.ownRun, fonts) +
        '</style:style>',
    );
  }
  if (!hasNormal) out.push('<style:style style:name="Standard" style:family="paragraph" style:class="text"/>');
  out.push('<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>');
  out.push('<style:style style:name="Graphics" style:family="graphic"><style:graphic-properties text:anchor-type="paragraph" svg:x="0in" svg:y="0in" style:wrap="dynamic" style:number-wrapped-paragraphs="no-limit" style:wrap-contour="false" style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="center" style:horizontal-rel="paragraph"/></style:style>');
  out.push('<style:style style:name="Internet_20_link" style:display-name="Internet Link" style:family="text"><style:text-properties fo:color="#0563C1" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>');
  out.push('<style:style style:name="Visited_20_Internet_20_Link" style:display-name="Visited Internet Link" style:family="text"><style:text-properties fo:color="#954F72" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>');
  return out.join('');
}

const HEADER_LINE = 19;

/** `ext` picks the variant: .ott is a template, .fodt the flat XML form. */
export function writeOdt(doc: WordDoc, content: JSONContent, ext = 'odt'): Uint8Array {
  const fonts = new FontFaces();
  const media = new OdfMedia();
  const counters = { image: 0 };
  const body = new OdtWriter(doc, fonts, media, counters, '');
  const bodyXml = body.blocks(content.content ?? []);
  const master = new OdtWriter(doc, fonts, media, counters, 'M');
  const s = doc.section;
  const part = (tag: string, hf: HeaderFooter | undefined) => (hf ? `<style:${tag}>${master.blocks(hf.content) || '<text:p/>'}</style:${tag}>` : '');
  const hasHeader = !!doc.headers.default || (s.titlePg && !!doc.headers.first);
  const hasFooter = !!doc.footers.default || (s.titlePg && !!doc.footers.first);
  const masterXml =
    '<style:master-page style:name="Standard" style:page-layout-name="pm1">' +
    part('header', doc.headers.default ?? (s.titlePg && doc.headers.first ? { part: null, content: [{ type: 'paragraph' }], modified: true } : undefined)) +
    (s.titlePg ? part('header-first', doc.headers.first ?? (doc.headers.default ? { part: null, content: [{ type: 'paragraph' }], modified: true } : undefined)) : '') +
    part('footer', doc.footers.default ?? (s.titlePg && doc.footers.first ? { part: null, content: [{ type: 'paragraph' }], modified: true } : undefined)) +
    (s.titlePg ? part('footer-first', doc.footers.first ?? (doc.footers.default ? { part: null, content: [{ type: 'paragraph' }], modified: true } : undefined)) : '') +
    '</style:master-page>';
  const headerGap = Math.max(0, s.mTop - s.mHeader - HEADER_LINE);
  const footerGap = Math.max(0, s.mBottom - s.mFooter - HEADER_LINE);
  const pageLayout =
    '<style:page-layout style:name="pm1">' +
    `<style:page-layout-properties fo:page-width="${inch(s.pageW)}" fo:page-height="${inch(s.pageH)}" style:print-orientation="${s.pageW > s.pageH ? 'landscape' : 'portrait'}" fo:margin-top="${inch(hasHeader ? s.mHeader : s.mTop)}" fo:margin-bottom="${inch(hasFooter ? s.mFooter : s.mBottom)}" fo:margin-left="${inch(s.mLeft)}" fo:margin-right="${inch(s.mRight)}" style:writing-mode="lr-tb"/>` +
    (hasHeader ? `<style:header-style><style:header-footer-properties fo:min-height="0in" fo:margin-bottom="${inch(headerGap)}" style:dynamic-spacing="false"/></style:header-style>` : '<style:header-style/>') +
    (hasFooter ? `<style:footer-style><style:header-footer-properties fo:min-height="0in" fo:margin-top="${inch(footerGap)}" style:dynamic-spacing="false"/></style:footer-style>` : '<style:footer-style/>') +
    '</style:page-layout>';
  const named = namedStylesXml(doc, fonts);
  const stylesXml = odfRoot(
    'office:document-styles',
    `${fonts.xml()}<office:styles>${named}</office:styles><office:automatic-styles>${pageLayout}${master.autoStylesXml()}</office:automatic-styles><office:master-styles>${masterXml}</office:master-styles>`,
  );
  const contentXml = odfRoot(
    'office:document-content',
    `${fonts.xml()}<office:automatic-styles>${body.autoStylesXml()}</office:automatic-styles><office:body><office:text>${bodyXml || '<text:p text:style-name="Standard"/>'}</office:text></office:body>`,
  );
  return writeOdf({ mimetype: ext === 'ott' ? ODF_MIME.textTemplate : ODF_MIME.text, content: contentXml, styles: stylesXml, files: media.files, generator: 'Din Word Processor', flat: ext === 'fodt' });
}
