import type { JSONContent } from '@tiptap/core';
import { at, attr, blobUrl, emuToPx, isOle, isZip, kid, kids, mimeOf, numAttr, OpcPackage, REL, rid, serialize, twipToPx, extOfPath } from '@/shared/office/ooxml';
import { parseTheme, type Theme } from '@/shared/office/theme';
import { parseNumbering, type Numbering } from './numbering';
import { parseStyles, readParaProps, readRunProps, type RunProps, type StyleSheet } from './styles';
import type { ParaAttrs } from './schema';

/**
 * Reading .docx: document.xml's paragraphs, runs and tables become the
 * editor's document; styles, lists, the page setup and headers and footers
 * are read alongside. Everything else in the package rides along untouched
 * and is written back on save.
 */

export interface Section {
  /** Pixels. */
  pageW: number;
  pageH: number;
  mTop: number;
  mBottom: number;
  mLeft: number;
  mRight: number;
  mHeader: number;
  mFooter: number;
  titlePg: boolean;
  /** The document's last sectPr as written, to write back with these values updated. */
  xml: string | null;
}

export type HFKind = 'default' | 'first' | 'even';

export interface HeaderFooter {
  /** Its part in the package; null for one made here. */
  part: string | null;
  content: JSONContent[];
  modified: boolean;
}

export interface WordDoc {
  pkg: OpcPackage | null;
  docPart: string;
  content: JSONContent;
  styles: StyleSheet;
  numbering: Numbering;
  section: Section;
  headers: Partial<Record<HFKind, HeaderFooter>>;
  footers: Partial<Record<HFKind, HeaderFooter>>;
  theme: Theme;
  /** What couldn't be shown, for the message bar. */
  warnings: string[];
  /** styles.xml for a new package, when the styles came from somewhere other than Word's defaults (an .odt). */
  stylesXml?: string;
}

export interface StoredImage {
  data: Uint8Array;
  ext: string;
}

/** Picture bytes behind the blob: URLs in documents, to write them back out. */
export const imageStore = new Map<string, StoredImage>();

export function storeImage(data: Uint8Array, ext: string): string {
  const url = blobUrl(data, mimeOf(`x.${ext}`));
  imageStore.set(url, { data, ext });
  return url;
}

export const LETTER: Section = {
  pageW: 816,
  pageH: 1056,
  mTop: 96,
  mBottom: 96,
  mLeft: 96,
  mRight: 96,
  mHeader: 48,
  mFooter: 48,
  titlePg: false,
  xml: null,
};

const ALIGN: Record<string, ParaAttrs['align']> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };

/** pPr children read into attributes; the rest are kept as they were. */
const HANDLED_PPR = new Set(['pStyle', 'jc', 'ind', 'spacing', 'numPr', 'pageBreakBefore', 'shd', 'sectPr', 'pPrChange']);

const HIGHLIGHTS: Record<string, string> = {
  yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF', blue: '#0000FF', red: '#FF0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#C0C0C0', black: '#000000', white: '#FFFFFF',
};

export const HIGHLIGHT_NAMES = Object.fromEntries(Object.entries(HIGHLIGHTS).map(([k, v]) => [v, k]));

interface Ctx {
  pkg: OpcPackage;
  part: string;
  styles: StyleSheet;
  theme: Theme;
  warnings: Set<string>;
  fields: { instr: string; result: boolean; kind: 'page' | 'numpages' | null; emitted: boolean }[];
}

function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

function marksFor(props: RunProps, extra: { shade?: string; link?: string | null }): JSONContent['marks'] {
  const marks: NonNullable<JSONContent['marks']> = [];
  if (props.bold) marks.push({ type: 'bold' });
  if (props.italic) marks.push({ type: 'italic' });
  if (props.underline) marks.push({ type: 'underline' });
  if (props.strike) marks.push({ type: 'strike' });
  if (props.vertAlign === 'superscript') marks.push({ type: 'superscript' });
  if (props.vertAlign === 'subscript') marks.push({ type: 'subscript' });
  const ts: Record<string, string> = {};
  if (props.font) ts.fontFamily = props.font;
  if (props.size) ts.fontSize = `${props.size}pt`;
  if (props.color) ts.color = `#${props.color}`;
  if (extra.shade) ts.backgroundColor = `#${extra.shade}`;
  if (Object.keys(ts).length) marks.push({ type: 'textStyle', attrs: ts });
  if (props.highlight && HIGHLIGHTS[props.highlight]) marks.push({ type: 'highlight', attrs: { color: HIGHLIGHTS[props.highlight] } });
  if (extra.link) marks.push({ type: 'link', attrs: { href: extra.link } });
  return marks.length ? marks : undefined;
}

function runMarks(rPr: Element | null, ctx: Ctx, link: string | null): JSONContent['marks'] {
  const styleId = attr(kid(rPr, 'rStyle'), 'val');
  const styled = styleId ? ctx.styles.styles.get(styleId)?.run ?? {} : {};
  // Hyperlinks look like links through their character style; the link mark draws that.
  const base = styleId === 'Hyperlink' && link ? {} : styled;
  const own = readRunProps(rPr, ctx.theme);
  const shd = attr(kid(rPr, 'shd'), 'fill');
  return marksFor({ ...base, ...own }, { shade: shd && /^[0-9a-f]{6}$/i.test(shd) ? shd.toUpperCase() : undefined, link });
}

function readImage(drawing: Element, ctx: Ctx): JSONContent | null {
  const holder = kid(drawing, 'inline') ?? kid(drawing, 'anchor');
  if (!holder) return null;
  if (holder.localName === 'anchor') ctx.warnings.add('Floating pictures are shown in line with the text.');
  const blip = holder.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
  const embed = rid(blip, 'embed');
  if (!embed) {
    ctx.warnings.add('Charts, shapes and text boxes aren’t shown, and won’t be kept when you save.');
    return null;
  }
  const rel = ctx.pkg.rel(ctx.part, embed);
  const data = rel && !rel.external ? ctx.pkg.bytes(rel.target) : null;
  if (!data) return null;
  const ext = extOfPath(rel!.target);
  if (ext === 'emf' || ext === 'wmf') {
    ctx.warnings.add('Some pictures are in old Windows formats (EMF/WMF) that can’t be shown.');
    return null;
  }
  const extent = kid(holder, 'extent');
  const docPr = kid(holder, 'docPr');
  return {
    type: 'image',
    attrs: {
      src: storeImage(data, ext),
      width: Math.round(emuToPx(numAttr(extent, 'cx') ?? 914400)),
      height: Math.round(emuToPx(numAttr(extent, 'cy') ?? 914400)),
      alt: attr(docPr, 'descr') ?? '',
    },
  };
}

const PAGE_BREAK = Symbol('page break');
type Inline = JSONContent | typeof PAGE_BREAK;

function fieldKind(instr: string): 'page' | 'numpages' | null {
  const word = instr.trim().split(/\s+/)[0]?.toUpperCase();
  return word === 'PAGE' ? 'page' : word === 'NUMPAGES' || word === 'SECTIONPAGES' ? 'numpages' : null;
}

function readRun(r: Element, ctx: Ctx, link: string | null, out: Inline[]): void {
  const rPr = kid(r, 'rPr');
  let marks: JSONContent['marks'] | null = null;
  const m = () => (marks ??= runMarks(rPr, ctx, link));
  const text = (t: string) => {
    if (!t) return;
    const top = ctx.fields[ctx.fields.length - 1];
    if (top && (!top.result || top.kind)) return;
    out.push({ type: 'text', text: t, marks: m() });
  };
  for (const c of kids(r)) {
    switch (c.localName) {
      case 't':
        text(c.textContent ?? '');
        break;
      case 'tab':
      case 'ptab':
        text('\t');
        break;
      case 'br': {
        const type = attr(c, 'type');
        if (type === 'page') out.push(PAGE_BREAK);
        else if (!ctx.fields.length) out.push({ type: 'hardBreak', marks: m() });
        break;
      }
      case 'cr':
        out.push({ type: 'hardBreak' });
        break;
      case 'noBreakHyphen':
        text('‑');
        break;
      case 'sym': {
        const code = parseInt(attr(c, 'char') ?? '', 16);
        if (Number.isFinite(code)) text(String.fromCodePoint(code >= 0xf000 ? code - 0xf000 : code));
        break;
      }
      case 'drawing': {
        const top = ctx.fields[ctx.fields.length - 1];
        if (top && !top.result) break;
        const img = readImage(c, ctx);
        if (img) out.push(img);
        break;
      }
      case 'pict':
      case 'object':
        ctx.warnings.add('Charts, shapes and text boxes aren’t shown, and won’t be kept when you save.');
        break;
      case 'footnoteReference':
      case 'endnoteReference':
        ctx.warnings.add('Footnotes and endnotes aren’t shown.');
        break;
      case 'fldChar': {
        const type = attr(c, 'fldCharType');
        if (type === 'begin') ctx.fields.push({ instr: '', result: false, kind: null, emitted: false });
        else if (type === 'separate' || type === 'end') {
          const top = ctx.fields[ctx.fields.length - 1];
          if (!top) break;
          if (!top.result) {
            top.result = true;
            top.kind = fieldKind(top.instr);
            if (top.kind && !top.emitted) {
              top.emitted = true;
              out.push({ type: 'field', attrs: { kind: top.kind, text: '1' }, marks: m() });
            }
          }
          if (type === 'end') ctx.fields.pop();
        }
        break;
      }
      case 'instrText': {
        const top = ctx.fields[ctx.fields.length - 1];
        if (top && !top.result) top.instr += c.textContent ?? '';
        break;
      }
    }
  }
}

function readInline(parent: Element, ctx: Ctx, link: string | null, out: Inline[]): void {
  for (const c of kids(parent)) {
    switch (c.localName) {
      case 'r':
        readRun(c, ctx, link, out);
        break;
      case 'hyperlink': {
        const id = rid(c);
        const rel = id ? ctx.pkg.rel(ctx.part, id) : undefined;
        readInline(c, ctx, rel?.external ? safeHref(rel.target) : link, out);
        break;
      }
      case 'fldSimple': {
        const kind = fieldKind(attr(c, 'instr') ?? '');
        if (kind) {
          const r = kid(c, 'r');
          out.push({ type: 'field', attrs: { kind, text: '1' }, marks: runMarks(kid(r, 'rPr'), ctx, link) });
        } else readInline(c, ctx, link, out);
        break;
      }
      case 'sdt':
        readInline(kid(c, 'sdtContent') ?? c, ctx, link, out);
        break;
      case 'smartTag':
      case 'customXml':
      case 'ins':
      case 'moveTo':
      case 'dir':
      case 'bdo':
        readInline(c, ctx, link, out);
        break;
      case 'oMath':
      case 'oMathPara':
        ctx.warnings.add('Equations aren’t shown, and won’t be kept when you save.');
        break;
      case 'AlternateContent': {
        const choice = kid(c, 'Choice');
        const fallback = kid(c, 'Fallback');
        // Pictures sometimes come wrapped like this; drawings with shapes don't render here.
        const inner = choice && Array.from(choice.getElementsByTagName('*')).some((e) => e.localName === 'blip') ? choice : fallback;
        if (inner) readInline(inner, ctx, link, out);
        break;
      }
    }
  }
}

function paraAttrs(pPr: Element | null, ctx: Ctx): Partial<ParaAttrs> {
  const a: Partial<ParaAttrs> = {};
  if (!pPr) return a;
  const style = attr(kid(pPr, 'pStyle'), 'val');
  if (style && style !== ctx.styles.defaultParagraph) a.styleId = style;
  const own = readParaProps(pPr);
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc && ALIGN[jc]) a.align = ALIGN[jc];
  if (own.indLeft !== undefined) a.indLeft = Math.round(own.indLeft * 100) / 100;
  if (own.indRight !== undefined) a.indRight = Math.round(own.indRight * 100) / 100;
  if (own.indFirst !== undefined) a.indFirst = Math.round(own.indFirst * 100) / 100;
  if (own.spBefore !== undefined) a.spBefore = own.spBefore;
  if (own.spAfter !== undefined) a.spAfter = own.spAfter;
  if (own.line !== undefined) {
    a.line = Math.round(own.line * 1000) / 1000;
    a.lineRule = own.lineRule ?? 'auto';
  }
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    const numId = numAttr(kid(numPr, 'numId'), 'val');
    // numId 0 means "no list", overriding a style's.
    a.numId = numId ?? null;
    a.ilvl = numAttr(kid(numPr, 'ilvl'), 'val') ?? 0;
  }
  if (own.pageBreakBefore) a.pageBreakBefore = true;
  if (own.shading) a.shading = own.shading;
  const extra: [string, string][] = [];
  for (const c of kids(pPr)) if (!HANDLED_PPR.has(c.localName)) extra.push([c.localName, serialize(c)]);
  if (extra.length) a.extra = extra;
  const sect = kid(pPr, 'sectPr');
  if (sect) a.sectPr = serialize(sect);
  return a;
}

function readParagraph(p: Element, ctx: Ctx): JSONContent[] {
  const attrs = paraAttrs(kid(p, 'pPr'), ctx);
  const inline: Inline[] = [];
  readInline(p, ctx, null, inline);
  const blocks: JSONContent[] = [];
  let cur: JSONContent[] = [];
  let started = false;
  for (const item of inline) {
    if (item === PAGE_BREAK) {
      if (cur.length || started) blocks.push({ type: 'paragraph', attrs, content: cur.length ? cur : undefined });
      blocks.push({ type: 'pageBreak' });
      cur = [];
      started = false;
      continue;
    }
    if (item.type === 'text' && !item.text) continue;
    cur.push(item);
    started = true;
  }
  blocks.push({ type: 'paragraph', attrs, content: cur.length ? cur : undefined });
  return blocks;
}

function readTable(tbl: Element, ctx: Ctx): JSONContent {
  const tblPr = kid(tbl, 'tblPr');
  const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => twipToPx(numAttr(g, 'w') ?? 0));
  const styleId = attr(kid(tblPr, 'tblStyle'), 'val');
  const borderEls = kids(kid(tblPr, 'tblBorders'));
  // Borders written on the table itself; otherwise its style decides.
  const borders = borderEls.length ? borderEls.some((b) => !['nil', 'none'].includes(attr(b, 'val') ?? 'none')) : null;
  const lookEl = kid(tblPr, 'tblLook');
  const lookVal = parseInt(attr(lookEl, 'val') ?? '04A0', 16);
  const flag = (name: string, bit: number) => {
    const v = attr(lookEl, name);
    return v !== null ? v === '1' || v === 'true' || v === 'on' : (lookVal & bit) !== 0;
  };
  const look = {
    firstRow: flag('firstRow', 0x20),
    lastRow: flag('lastRow', 0x40),
    firstCol: flag('firstColumn', 0x80),
    lastCol: flag('lastColumn', 0x100),
    bandRows: !flag('noHBand', 0x200),
  };
  const jc = attr(kid(tblPr, 'jc'), 'val');
  const indent = numAttr(kid(tblPr, 'tblInd'), 'w');

  // Lay the rows out on the grid to turn vMerge into rowspans.
  const rows = kids(tbl, 'tr');
  type Cell = { el: Element; col: number; span: number; vMerge: 'restart' | 'continue' | null };
  const layout: Cell[][] = rows.map((tr) => {
    let col = numAttr(at(tr, 'trPr', 'gridBefore'), 'val') ?? 0;
    const cells: Cell[] = [];
    const tcs: Element[] = [];
    for (const c of kids(tr)) {
      if (c.localName === 'tc') tcs.push(c);
      else if (c.localName === 'sdt') tcs.push(...kids(kid(c, 'sdtContent'), 'tc'));
    }
    for (const tc of tcs) {
      const tcPr = kid(tc, 'tcPr');
      const span = numAttr(kid(tcPr, 'gridSpan'), 'val') ?? 1;
      const vm = kid(tcPr, 'vMerge');
      const vMerge = vm ? (attr(vm, 'val') === 'restart' ? 'restart' : 'continue') : null;
      cells.push({ el: tc, col, span, vMerge });
      col += span;
    }
    return cells;
  });

  const content: JSONContent[] = rows.map((tr, ri) => {
    const cells: JSONContent[] = [];
    for (const cell of layout[ri]) {
      if (cell.vMerge === 'continue') continue;
      let rowspan = 1;
      if (cell.vMerge === 'restart') {
        for (let k = ri + 1; k < layout.length; k++) {
          const below = layout[k].find((c) => c.col === cell.col);
          if (below?.vMerge === 'continue') rowspan++;
          else break;
        }
      }
      const tcPr = kid(cell.el, 'tcPr');
      const fill = attr(kid(tcPr, 'shd'), 'fill');
      const valign = attr(kid(tcPr, 'vAlign'), 'val');
      const extra = kids(tcPr).filter((c) => ['tcBorders', 'tcMar', 'noWrap', 'textDirection', 'tcFitText', 'hideMark'].includes(c.localName));
      const colwidth = grid.length ? grid.slice(cell.col, cell.col + cell.span).map((w) => Math.max(24, Math.round(w))) : null;
      const blocks = readBlocks(cell.el, ctx);
      cells.push({
        type: 'tableCell',
        attrs: {
          colspan: cell.span,
          rowspan,
          colwidth: colwidth && colwidth.length === cell.span ? colwidth : null,
          background: fill && /^[0-9a-f]{6}$/i.test(fill) ? fill.toUpperCase() : null,
          valign: valign === 'center' ? 'middle' : valign === 'bottom' ? 'bottom' : null,
          tcExtra: extra.length ? extra.map((e) => [e.localName, serialize(e)]) : null,
        },
        content: blocks.length ? blocks : [{ type: 'paragraph' }],
      });
    }
    const trPr = kid(tr, 'trPr');
    return { type: 'tableRow', attrs: { trPr: trPr ? serialize(trPr) : null }, content: cells.length ? cells : [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] };
  });
  return {
    type: 'table',
    attrs: {
      borders,
      bordersFromFile: borders,
      look,
      styleId: styleId ?? ctx.styles.defaultTable,
      align: jc === 'center' ? 'center' : null,
      indent: indent ? twipToPx(indent) : null,
      tblPr: tblPr ? serialize(tblPr) : null,
    },
    content,
  };
}

function readBlocks(parent: Element, ctx: Ctx): JSONContent[] {
  const out: JSONContent[] = [];
  for (const c of kids(parent)) {
    switch (c.localName) {
      case 'p':
        out.push(...readParagraph(c, ctx));
        break;
      case 'tbl':
        out.push(readTable(c, ctx));
        break;
      case 'sdt':
        out.push(...readBlocks(kid(c, 'sdtContent') ?? c, ctx));
        break;
      case 'customXml':
      case 'ins':
        out.push(...readBlocks(c, ctx));
        break;
      case 'AlternateContent':
        out.push(...readBlocks(kid(c, 'Fallback') ?? c, ctx));
        break;
    }
  }
  return out;
}

export function readSection(sectPr: Element | null): Section {
  if (!sectPr) return { ...LETTER };
  const sz = kid(sectPr, 'pgSz');
  const mar = kid(sectPr, 'pgMar');
  const px = (el: Element | null, name: string, def: number) => {
    const v = numAttr(el, name);
    return v === null ? def : Math.abs(twipToPx(v));
  };
  return {
    pageW: px(sz, 'w', LETTER.pageW),
    pageH: px(sz, 'h', LETTER.pageH),
    mTop: px(mar, 'top', LETTER.mTop),
    mBottom: px(mar, 'bottom', LETTER.mBottom),
    mLeft: px(mar, 'left', LETTER.mLeft),
    mRight: px(mar, 'right', LETTER.mRight),
    mHeader: px(mar, 'header', LETTER.mHeader),
    mFooter: px(mar, 'footer', LETTER.mFooter),
    titlePg: !!kid(sectPr, 'titlePg') && attr(kid(sectPr, 'titlePg'), 'val') !== '0',
    xml: serialize(sectPr),
  };
}

export function readDocx(bytes: Uint8Array): WordDoc {
  if (isOle(bytes)) throw new Error('It’s either an old Word 97–2003 document (.doc) or protected with a password, and neither can be opened here. Word can save it as an unprotected .docx.');
  if (!isZip(bytes)) throw new Error('It isn’t a Word document.');
  const pkg = OpcPackage.read(bytes);
  const docPart = pkg.mainPart();
  if (!docPart || !pkg.has(docPart)) throw new Error('It isn’t a Word document (there’s no main document part).');
  const doc = pkg.xml(docPart);
  if (!doc || doc.documentElement.localName !== 'document') throw new Error('It isn’t a Word document.');
  const themeRel = pkg.relOfType(docPart, REL.theme);
  const theme = parseTheme(themeRel ? pkg.xml(themeRel.target) : null);
  const stylesRel = pkg.relOfType(docPart, REL.styles);
  const styles = parseStyles(stylesRel ? pkg.xml(stylesRel.target) : null, theme);
  const numRel = pkg.relOfType(docPart, REL.numbering);
  const numbering = parseNumbering(numRel ? pkg.xml(numRel.target) : null);
  const ctx: Ctx = { pkg, part: docPart, styles, theme, warnings: new Set(), fields: [] };
  const body = kid(doc.documentElement, 'body');
  const blocks = readBlocks(body!, ctx);
  const sectPr = kid(body, 'sectPr');
  const section = readSection(sectPr);

  const headers: WordDoc['headers'] = {};
  const footers: WordDoc['footers'] = {};
  for (const ref of kids(sectPr)) {
    const isHeader = ref.localName === 'headerReference';
    if (!isHeader && ref.localName !== 'footerReference') continue;
    const type = (attr(ref, 'type') ?? 'default') as HFKind;
    const rel = pkg.rel(docPart, rid(ref) ?? '');
    const partDoc = rel ? pkg.xml(rel.target) : null;
    if (!rel || !partDoc) continue;
    const hfCtx: Ctx = { ...ctx, part: rel.target, fields: [] };
    const hf = { part: rel.target, content: readBlocks(partDoc.documentElement, hfCtx), modified: false };
    (isHeader ? headers : footers)[type] = hf;
  }

  return {
    pkg,
    docPart,
    content: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] },
    styles,
    numbering,
    section,
    headers,
    footers,
    theme,
    warnings: [...ctx.warnings],
  };
}

/** Plain text files open as one paragraph per line. */
export function readText(bytes: Uint8Array): JSONContent {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n');
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : undefined })),
  };
}
