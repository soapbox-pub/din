import type { JSONContent } from '@tiptap/core';
import {
  addDocProps,
  CT,
  emptyPackage,
  esc,
  OpcPackage,
  parseXml,
  pxToEmu,
  pxToTwip,
  REL,
  serialize,
  kid,
  kids,
  touchModified,
  x,
  XML_HEADER,
  type Rel,
} from '../ooxml';
import { officeThemeXml } from '../theme';
import { numberingXml } from './numbering';
import { HIGHLIGHT_NAMES, imageStore, type HeaderFooter, type HFKind, type Section, type WordDoc } from './read';
import { BUILTIN_STYLES, defaultStylesXml } from './styles';

/**
 * Writing .docx: the editor's document becomes document.xml again, in the
 * element order Word insists on, inside the package it came from (or a new
 * one), with pictures, links, lists, styles and headers and footers wired up.
 */

const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAIN_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const STYLES_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const SETTINGS_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
const NUMBERING_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const HEADER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FOOTER_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

const NS_DECLS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14"';

const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs',
  'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
  'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment',
  'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
];
const TCPR_ORDER = ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark'];
const SECT_ORDER = [
  'headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType',
  'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange',
];

function ordered(children: [string, string][], order: string[]): string {
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i === -1 ? order.length : i;
  };
  return children
    .map((c, i) => [c, i] as const)
    .sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1])
    .map(([c]) => c[1])
    .join('');
}

const tw = (px: number) => pxToTwip(px);
const ptTw = (pt: number) => Math.round(pt * 20);

interface PartCtx {
  pkg: OpcPackage;
  part: string;
  rels: Rel[];
  usedStyles: Set<string>;
  doc: { drawingId: number };
  /** Available text width in px, for tables without widths. */
  textWidth: number;
}

function addRel(ctx: PartCtx, type: string, target: string, external = false): string {
  const same = ctx.rels.find((r) => r.type === type && r.target === target && r.external === external);
  if (same) return same.id;
  const used = new Set(ctx.rels.map((r) => r.id));
  let n = ctx.rels.length + 1;
  while (used.has(`rId${n}`)) n++;
  const id = `rId${n}`;
  ctx.rels.push({ id, type, target, external });
  return id;
}

// ---- Runs ------------------------------------------------------------------------

type Marks = NonNullable<JSONContent['marks']>;

function rPrXml(marks: Marks | undefined, ctx: PartCtx, link: boolean): string {
  const parts: string[] = [];
  const has = (t: string) => marks?.some((m) => m.type === t);
  const ts = marks?.find((m) => m.type === 'textStyle')?.attrs ?? {};
  const hl = marks?.find((m) => m.type === 'highlight')?.attrs?.color as string | undefined;
  if (link) {
    parts.push('<w:rStyle w:val="Hyperlink"/>');
    ctx.usedStyles.add('Hyperlink');
  }
  if (ts.fontFamily) {
    const f = esc(String(ts.fontFamily).replace(/^["']|["']$/g, ''));
    parts.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`);
  }
  if (has('bold')) parts.push('<w:b/><w:bCs/>');
  if (has('italic')) parts.push('<w:i/><w:iCs/>');
  if (has('strike')) parts.push('<w:strike/>');
  const color = typeof ts.color === 'string' ? ts.color.replace('#', '') : '';
  if (/^[0-9a-f]{6}$/i.test(color)) parts.push(`<w:color w:val="${color.toUpperCase()}"/>`);
  const size = typeof ts.fontSize === 'string' ? parseFloat(ts.fontSize) : NaN;
  if (Number.isFinite(size) && size > 0) {
    const half = Math.round(size * 2);
    parts.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`);
  }
  if (hl) {
    const name = HIGHLIGHT_NAMES[hl.toUpperCase()];
    if (name) parts.push(`<w:highlight w:val="${name}"/>`);
  }
  if (has('underline')) parts.push('<w:u w:val="single"/>');
  const bg = typeof ts.backgroundColor === 'string' ? ts.backgroundColor.replace('#', '') : '';
  if (/^[0-9a-f]{6}$/i.test(bg) || (hl && !HIGHLIGHT_NAMES[hl.toUpperCase()])) {
    parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${(bg || hl!.replace('#', '')).toUpperCase()}"/>`);
  }
  if (has('superscript')) parts.push('<w:vertAlign w:val="superscript"/>');
  else if (has('subscript')) parts.push('<w:vertAlign w:val="subscript"/>');
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function textRuns(text: string, rPr: string): string {
  const out: string[] = [];
  const pieces = text.split('\t');
  pieces.forEach((piece, i) => {
    if (i > 0) out.push('<w:tab/>');
    if (piece) out.push(`<w:t xml:space="preserve">${esc(piece)}</w:t>`);
  });
  return `<w:r>${rPr}${out.join('')}</w:r>`;
}

function decodeDataUrl(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { data, ext: m[1] === 'jpeg' ? 'jpeg' : m[1] };
}

function imageRun(node: JSONContent, ctx: PartCtx, rPr: string): string {
  const src = String(node.attrs?.src ?? '');
  const stored = imageStore.get(src) ?? decodeDataUrl(src);
  if (!stored) return '';
  const media = ctx.pkg.addMedia('word/media', stored.data, stored.ext);
  const id = addRel(ctx, REL.image, media);
  const w = pxToEmu(Number(node.attrs?.width) || 96);
  const h = pxToEmu(Number(node.attrs?.height) || 96);
  const n = ctx.doc.drawingId++;
  const alt = esc(String(node.attrs?.alt ?? ''));
  return (
    `<w:r>${rPr}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${w}" cy="${h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${n}" name="Picture ${n}" descr="${alt}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

function inlineXml(nodes: JSONContent[] | undefined, ctx: PartCtx): string {
  if (!nodes) return '';
  const out: string[] = [];
  let i = 0;
  while (i < nodes.length) {
    const href = nodes[i].marks?.find((m) => m.type === 'link')?.attrs?.href as string | undefined;
    // Neighbours with the same link go in one w:hyperlink.
    let j = i + 1;
    if (href) while (j < nodes.length && nodes[j].marks?.find((m) => m.type === 'link')?.attrs?.href === href) j++;
    const runs = nodes.slice(i, j).map((n) => {
      const rPr = rPrXml(n.marks?.filter((m) => m.type !== 'link'), ctx, !!href);
      switch (n.type) {
        case 'text':
          return textRuns(n.text ?? '', rPr);
        case 'hardBreak':
          return `<w:r>${rPr}<w:br/></w:r>`;
        case 'image':
          return imageRun(n, ctx, rPr);
        case 'field': {
          const instr = n.attrs?.kind === 'numpages' ? 'NUMPAGES' : 'PAGE';
          return `<w:fldSimple w:instr=" ${instr} \\* MERGEFORMAT "><w:r>${rPr}<w:t>${esc(String(n.attrs?.text ?? '1'))}</w:t></w:r></w:fldSimple>`;
        }
        default:
          return '';
      }
    });
    if (href && /^(https?:|mailto:)/i.test(href)) {
      const id = addRel(ctx, REL.hyperlink, href, true);
      out.push(`<w:hyperlink r:id="${id}" w:history="1">${runs.join('')}</w:hyperlink>`);
    } else out.push(runs.join(''));
    i = j;
  }
  return out.join('');
}

// ---- Paragraphs ------------------------------------------------------------------

function pPrXml(a: Record<string, unknown>, ctx: PartCtx): string {
  const children: [string, string][] = [...((a.extra as [string, string][] | null) ?? [])];
  if (a.styleId) {
    children.push(['pStyle', `<w:pStyle w:val="${esc(String(a.styleId))}"/>`]);
    ctx.usedStyles.add(String(a.styleId));
  }
  if (a.pageBreakBefore) children.push(['pageBreakBefore', '<w:pageBreakBefore/>']);
  if (a.numId !== null && a.numId !== undefined) {
    children.push(['numPr', `<w:numPr><w:ilvl w:val="${Number(a.ilvl) || 0}"/><w:numId w:val="${Number(a.numId)}"/></w:numPr>`]);
  }
  if (typeof a.shading === 'string') children.push(['shd', `<w:shd w:val="clear" w:color="auto" w:fill="${esc(a.shading)}"/>`]);
  const sp: Record<string, string | number | null> = {
    'w:before': typeof a.spBefore === 'number' ? ptTw(a.spBefore) : null,
    'w:after': typeof a.spAfter === 'number' ? ptTw(a.spAfter) : null,
    'w:line': null,
    'w:lineRule': null,
  };
  if (typeof a.line === 'number') {
    const rule = (a.lineRule as string) ?? 'auto';
    sp['w:line'] = rule === 'auto' ? Math.round(a.line * 240) : ptTw(a.line);
    sp['w:lineRule'] = rule;
  }
  if (Object.values(sp).some((v) => v !== null)) children.push(['spacing', x('w:spacing', sp)]);
  if (typeof a.indLeft === 'number' || typeof a.indRight === 'number' || typeof a.indFirst === 'number') {
    const first = typeof a.indFirst === 'number' ? a.indFirst : null;
    children.push([
      'ind',
      x('w:ind', {
        'w:left': typeof a.indLeft === 'number' ? tw(a.indLeft) : null,
        'w:right': typeof a.indRight === 'number' ? tw(a.indRight) : null,
        'w:firstLine': first !== null && first >= 0 ? tw(first) : null,
        'w:hanging': first !== null && first < 0 ? tw(-first) : null,
      }),
    ]);
  }
  if (a.align) children.push(['jc', `<w:jc w:val="${a.align === 'justify' ? 'both' : esc(String(a.align))}"/>`]);
  if (typeof a.sectPr === 'string') children.push(['sectPr', a.sectPr]);
  return children.length ? `<w:pPr>${ordered(children, PPR_ORDER)}</w:pPr>` : '';
}

function paragraphXml(node: JSONContent, ctx: PartCtx, prefix = ''): string {
  return `<w:p>${pPrXml(node.attrs ?? {}, ctx)}${prefix}${inlineXml(node.content, ctx)}</w:p>`;
}

// ---- Tables ----------------------------------------------------------------------

function tableXml(node: JSONContent, ctx: PartCtx): string {
  const rows = node.content ?? [];
  // Lay the cells out on a grid: rowspans take room in the rows below.
  const occupied: Map<number, { until: number; span: number; width: number }>[] = [];
  const grid: number[] = [];
  const layout: { cell: JSONContent | null; col: number; span: number }[][] = [];
  rows.forEach((row, r) => {
    const line: { cell: JSONContent | null; col: number; span: number }[] = [];
    let col = 0;
    const cells = [...(row.content ?? [])];
    const occ = (c: number) => occupied.some((m, rr) => rr < r && (m.get(c)?.until ?? -1) >= r);
    while (cells.length || occ(col)) {
      if (occ(col)) {
        const owner = occupied.map((m) => m.get(col)).find((o, rr) => o && rr < r && o.until >= r)!;
        line.push({ cell: null, col, span: owner.span });
        col += owner.span;
        continue;
      }
      const cell = cells.shift()!;
      const span = Number(cell.attrs?.colspan) || 1;
      const rowspan = Number(cell.attrs?.rowspan) || 1;
      const widths = (cell.attrs?.colwidth as number[] | null) ?? [];
      for (let k = 0; k < span; k++) if (widths[k] && !grid[col + k]) grid[col + k] = widths[k];
      if (rowspan > 1) {
        occupied[r] ??= new Map();
        occupied[r].set(col, { until: r + rowspan - 1, span, width: 0 });
      }
      line.push({ cell, col, span });
      col += span;
    }
    layout.push(line);
  });
  const cols = Math.max(1, ...layout.map((l) => l.reduce((n, c) => n + c.span, 0)));
  const known = grid.filter(Boolean);
  const fallback = known.length === cols ? 0 : (ctx.textWidth - known.reduce((a, b) => a + b, 0)) / Math.max(1, cols - known.length);
  for (let c = 0; c < cols; c++) if (!grid[c]) grid[c] = Math.max(24, fallback || ctx.textWidth / cols);

  const a = node.attrs ?? {};
  let tblPr: string;
  if (typeof a.tblPr === 'string' && a.borders === a.bordersFromFile) tblPr = a.tblPr;
  else {
    const style = (a.styleId as string | null) ?? (a.borders ? 'TableGrid' : null);
    if (style) ctx.usedStyles.add(style);
    const b = a.borders ? 'single" w:sz="4" w:space="0" w:color="auto' : 'nil';
    const sides = typeof a.borders === 'boolean' ? ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="${b}"/>`).join('') : '';
    tblPr =
      '<w:tblPr>' +
      (style ? `<w:tblStyle w:val="${esc(style)}"/>` : '') +
      '<w:tblW w:w="0" w:type="auto"/>' +
      (a.align === 'center' ? '<w:jc w:val="center"/>' : '') +
      (typeof a.indent === 'number' ? `<w:tblInd w:w="${tw(a.indent)}" w:type="dxa"/>` : '') +
      (sides ? `<w:tblBorders>${sides}</w:tblBorders>` : '') +
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>';
  }
  const gridXml = `<w:tblGrid>${grid.slice(0, cols).map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>`;
  const rowsXml = rows.map((row, r) => {
    const cellsXml = layout[r].map(({ cell, col, span }) => {
      const width = grid.slice(col, col + span).reduce((s, w) => s + w, 0);
      const children: [string, string][] = [['tcW', `<w:tcW w:w="${tw(width)}" w:type="dxa"/>`]];
      if (span > 1) children.push(['gridSpan', `<w:gridSpan w:val="${span}"/>`]);
      if (!cell) {
        children.push(['vMerge', '<w:vMerge/>']);
        return `<w:tc><w:tcPr>${ordered(children, TCPR_ORDER)}</w:tcPr><w:p/></w:tc>`;
      }
      const ca = cell.attrs ?? {};
      if ((Number(ca.rowspan) || 1) > 1) children.push(['vMerge', '<w:vMerge w:val="restart"/>']);
      if (typeof ca.background === 'string') children.push(['shd', `<w:shd w:val="clear" w:color="auto" w:fill="${esc(ca.background)}"/>`]);
      if (ca.valign === 'middle' || ca.valign === 'bottom') children.push(['vAlign', `<w:vAlign w:val="${ca.valign === 'middle' ? 'center' : 'bottom'}"/>`]);
      for (const e of (ca.tcExtra as [string, string][] | null) ?? []) children.push(e);
      const blocks = cell.content ?? [];
      let body = blocksXml(blocks, ctx);
      if (!blocks.length || blocks[blocks.length - 1].type !== 'paragraph') body += '<w:p/>';
      return `<w:tc><w:tcPr>${ordered(children, TCPR_ORDER)}</w:tcPr>${body}</w:tc>`;
    });
    const trPr = typeof row.attrs?.trPr === 'string' ? row.attrs.trPr : '';
    return `<w:tr>${trPr}${cellsXml.join('')}</w:tr>`;
  });
  return `<w:tbl>${tblPr}${gridXml}${rowsXml.join('')}</w:tbl>`;
}

function blocksXml(blocks: JSONContent[], ctx: PartCtx): string {
  const out: string[] = [];
  let pendingBreak = false;
  for (const b of blocks) {
    if (b.type === 'pageBreak') {
      if (pendingBreak) out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      pendingBreak = true;
      continue;
    }
    if (b.type === 'paragraph') {
      // A page break goes at the start of the paragraph after it, as Word writes Ctrl+Enter.
      out.push(paragraphXml(b, ctx, pendingBreak ? '<w:r><w:br w:type="page"/></w:r>' : ''));
      pendingBreak = false;
      continue;
    }
    if (pendingBreak) out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    pendingBreak = false;
    if (b.type === 'table') out.push(tableXml(b, ctx));
  }
  if (pendingBreak) out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  return out.join('');
}

// ---- Sections, headers and footers --------------------------------------------------

function sectPrXml(section: Section, refs: [string, string][]): string {
  const children: [string, string][] = [];
  if (section.xml) {
    const el = parseXml(section.xml).documentElement;
    for (const c of kids(el)) {
      if (['pgSz', 'pgMar', 'titlePg', 'headerReference', 'footerReference'].includes(c.localName)) continue;
      children.push([c.localName, serialize(c)]);
    }
  } else {
    children.push(['cols', '<w:cols w:space="720"/>'], ['docGrid', '<w:docGrid w:linePitch="360"/>']);
  }
  const orig = section.xml ? kid(parseXml(section.xml).documentElement, 'pgSz') : null;
  const landscape = section.pageW > section.pageH;
  children.push([
    'pgSz',
    x('w:pgSz', {
      'w:w': tw(section.pageW),
      'w:h': tw(section.pageH),
      'w:orient': landscape ? 'landscape' : null,
      'w:code': orig?.getAttributeNS(WML, 'code') || null,
    }),
  ]);
  children.push([
    'pgMar',
    x('w:pgMar', {
      'w:top': tw(section.mTop),
      'w:right': tw(section.mRight),
      'w:bottom': tw(section.mBottom),
      'w:left': tw(section.mLeft),
      'w:header': tw(section.mHeader),
      'w:footer': tw(section.mFooter),
      'w:gutter': 0,
    }),
  ]);
  if (section.titlePg) children.push(['titlePg', '<w:titlePg/>']);
  children.push(...refs);
  return `<w:sectPr>${ordered(children, SECT_ORDER)}</w:sectPr>`;
}

function partXml(root: 'w:hdr' | 'w:ftr', content: JSONContent[], ctx: PartCtx): string {
  const body = blocksXml(content, ctx) || '<w:p/>';
  return `${XML_HEADER}<${root} ${NS_DECLS}>${body}</${root}>`;
}

// ---- Package ---------------------------------------------------------------------

function newPackage(): OpcPackage {
  const pkg = emptyPackage();
  pkg.ensureOverride('word/document.xml', MAIN_CT);
  pkg.setRels('', [{ id: 'rId1', type: REL.officeDocument, target: 'word/document.xml', external: false }]);
  addDocProps(pkg, 'Din Word Processor');
  const rels = pkg.rels('');
  pkg.setRels('', [
    ...rels,
    { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml', external: false },
    { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml', external: false },
  ]);
  pkg.setText('word/styles.xml', defaultStylesXml());
  pkg.ensureOverride('word/styles.xml', STYLES_CT);
  pkg.setText(
    'word/settings.xml',
    `${XML_HEADER}<w:settings xmlns:w="${WML}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
  );
  pkg.ensureOverride('word/settings.xml', SETTINGS_CT);
  pkg.setText('word/theme/theme1.xml', officeThemeXml());
  pkg.ensureOverride('word/theme/theme1.xml', CT.theme);
  pkg.setRels('word/document.xml', [
    { id: 'rId1', type: REL.styles, target: 'word/styles.xml', external: false },
    { id: 'rId2', type: REL.settings, target: 'word/settings.xml', external: false },
    { id: 'rId3', type: REL.theme, target: 'word/theme/theme1.xml', external: false },
  ]);
  return pkg;
}

/** Media files no relationship points at any more. */
function dropUnusedMedia(pkg: OpcPackage): void {
  const used = new Set<string>();
  for (const name of pkg.files.keys()) {
    if (!name.endsWith('.rels')) continue;
    const dir = name.replace(/_rels\/[^/]*$/, '');
    const part = dir + name.slice(name.lastIndexOf('/') + 1).replace(/\.rels$/, '');
    for (const r of pkg.rels(part)) if (!r.external) used.add(r.target);
  }
  for (const name of [...pkg.files.keys()]) if (name.startsWith('word/media/') && !used.has(name)) pkg.files.delete(name);
}

export interface WriteInput {
  doc: WordDoc;
  content: JSONContent;
  /** The file's extension: a .docm keeps its macros' content type, anything else is a plain document. */
  ext?: string;
}

const MACRO_CT = 'application/vnd.ms-word.document.macroEnabled.main+xml';

export function writeDocx({ doc, content, ext = 'docx' }: WriteInput): Uint8Array {
  const pkg = doc.pkg ? copyPackage(doc.pkg) : newPackage();
  const docPart = doc.pkg ? doc.docPart : 'word/document.xml';
  const textWidth = doc.section.pageW - doc.section.mLeft - doc.section.mRight;
  const shared = { drawingId: 1 };
  const usedStyles = new Set<string>();
  const ctxFor = (part: string): PartCtx => ({
    pkg,
    part,
    // Pictures and links are re-linked from what's in the document now.
    rels: pkg.rels(part).filter((r) => r.type !== REL.image && r.type !== REL.hyperlink),
    usedStyles,
    doc: shared,
    textWidth,
  });

  const ctx = ctxFor(docPart);
  const body = blocksXml(content.content ?? [], ctx);

  // Headers and footers: written again if changed here, linked from the section.
  const refs: [string, string][] = [];
  const hf = (kind: 'header' | 'footer', all: Partial<Record<HFKind, HeaderFooter>>) => {
    for (const [type, h] of Object.entries(all) as [HFKind, HeaderFooter][]) {
      let part = h.part;
      if (!part || h.modified) {
        part ??= pkg.freshName(`word/${kind}`, 'xml');
        const hctx = ctxFor(part);
        pkg.setText(part, partXml(kind === 'header' ? 'w:hdr' : 'w:ftr', h.content, hctx));
        pkg.setRels(part, hctx.rels);
        pkg.ensureOverride(part, kind === 'header' ? HEADER_CT : FOOTER_CT);
      }
      const id = addRel(ctx, kind === 'header' ? REL.header : REL.footer, part);
      refs.push([`${kind}Reference`, `<w:${kind}Reference w:type="${type}" r:id="${id}"/>`]);
    }
  };
  hf('header', doc.headers);
  hf('footer', doc.footers);
  // Header parts no longer referenced go away.
  const keep = new Set(ctx.rels.map((r) => r.target));
  ctx.rels = ctx.rels.filter((r) => (r.type !== REL.header && r.type !== REL.footer) || keep.has(r.target));

  // Styles: add Word's built-in definitions for any used here that the file lacks.
  let stylesRel = ctx.rels.find((r) => r.type === REL.styles);
  if (!stylesRel) {
    addRel(ctx, REL.styles, 'word/styles.xml');
    stylesRel = ctx.rels.find((r) => r.type === REL.styles)!;
    pkg.setText(stylesRel.target, defaultStylesXml());
    pkg.ensureOverride(stylesRel.target, STYLES_CT);
  }
  let stylesText = pkg.text(stylesRel.target) ?? defaultStylesXml();
  const missing = [...usedStyles].filter((id) => !doc.styles.styles.has(id) && BUILTIN_STYLES[id] && !stylesText.includes(`w:styleId="${id}"`));
  if (missing.length) {
    const close = stylesText.lastIndexOf('</w:styles>');
    stylesText = stylesText.slice(0, close) + missing.map((id) => BUILTIN_STYLES[id]).join('') + stylesText.slice(close);
    pkg.setText(stylesRel.target, stylesText);
  }

  // Lists added here.
  const numRel = ctx.rels.find((r) => r.type === REL.numbering);
  const numText = numberingXml(numRel ? pkg.text(numRel.target) : null, doc.numbering);
  if (numText) {
    const target = numRel?.target ?? 'word/numbering.xml';
    if (!numRel) addRel(ctx, REL.numbering, target);
    pkg.setText(target, numText);
    pkg.ensureOverride(target, NUMBERING_CT);
  }

  const rootOpen = docRootOpen(doc.pkg ? doc.pkg.text(docPart) : null);
  pkg.setText(docPart, `${XML_HEADER}${rootOpen}<w:body>${body}${sectPrXml(doc.section, refs)}</w:body></w:document>`);
  pkg.setRels(docPart, ctx.rels);
  pkg.ensureOverride(docPart, ext === 'docm' ? MACRO_CT : MAIN_CT);
  dropUnusedMedia(pkg);
  touchModified(pkg);
  return pkg.write();
}

/** The original <w:document ...> start tag, so every namespace the file declared stays declared. */
function docRootOpen(original: string | null): string {
  if (original) {
    const m = /<w:document\b[^>]*>/.exec(original);
    if (m) {
      let tag = m[0];
      for (const [prefix, uri] of [
        ['w', WML],
        ['r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
        ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
      ]) {
        if (!tag.includes(`xmlns:${prefix}=`)) tag = tag.replace(/>$/, ` xmlns:${prefix}="${uri}">`);
      }
      return tag.replace(/\/>$/, '>');
    }
  }
  return `<w:document ${NS_DECLS}>`;
}

function copyPackage(src: OpcPackage): OpcPackage {
  const pkg = new OpcPackage();
  for (const [k, v] of src.files) pkg.files.set(k, v);
  return pkg;
}

/** Plain text: one line per paragraph, tabs kept. */
export function writeText(content: JSONContent): Uint8Array {
  const lines: string[] = [];
  const walk = (blocks: JSONContent[] | undefined) => {
    for (const b of blocks ?? []) {
      if (b.type === 'paragraph') lines.push((b.content ?? []).map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : n.type === 'field' ? n.attrs?.text : '')).join(''));
      else if (b.type === 'table') for (const row of b.content ?? []) lines.push((row.content ?? []).map((c) => textOf(c)).join('\t'));
    }
  };
  const textOf = (n: JSONContent): string => (n.text ?? '') + (n.content ?? []).map(textOf).join(n.type === 'tableCell' ? ' ' : '');
  walk(content.content);
  return new TextEncoder().encode(lines.join('\n') + '\n');
}
