import { addDocProps, CT, emptyPackage, OpcPackage, REL, XML_HEADER } from '../ooxml';
import { OFFICE_THEME, officeThemeXml, type ThemeColorName } from '../theme';
import { tableStyleListXml } from './tableStyles';
import { CT_PML, NS_DECL } from './write';

/**
 * New presentations: a complete package as PowerPoint makes one — a slide
 * master with the Office text styles (44 pt titles, 28/24/20/18 pt bulleted
 * body levels), its usual layouts, a theme, and the presentation, view and
 * table style parts — in the Office theme or one of Slides' own designs.
 */

export interface DesignTheme {
  id: string;
  name: string;
  colors: Record<ThemeColorName, string>;
  major: string;
  minor: string;
  /** Light text on a dark background: the color map swaps background and text. */
  dark?: boolean;
  /** The master's background (p:bg). */
  bg: string;
  /** Shapes behind every slide, and behind title and section slides only. */
  decor?: string;
  titleDecor?: string;
  /** Title color, if not the text color. */
  titleColor?: string;
  /** Title and subtitle color on the title slide, when its decoration is dark. */
  titleSlideColor?: string;
}

const BG_REF = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>';

function rect(id: number, name: string, x: number, y: number, w: number, h: number, fill: string, geom = 'rect'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

const scheme = (v: string, mods = '') => `<a:solidFill><a:schemeClr val="${v}">${mods}</a:schemeClr></a:solidFill>`.replace('"></a:schemeClr>', '"/>');

export const DESIGNS: DesignTheme[] = [
  { id: 'office', name: 'Office Theme', colors: OFFICE_THEME.colors, major: 'Calibri Light', minor: 'Calibri', bg: BG_REF },
  {
    id: 'midnight',
    name: 'Midnight',
    colors: { dk1: '161B26', lt1: 'FFFFFF', dk2: '232B3B', lt2: 'D5DCE8', accent1: '4FA3FF', accent2: 'FF7A59', accent3: '6DD3B0', accent4: 'FFC857', accent5: 'B18CFF', accent6: 'FF6B9A', hlink: '7DB8FF', folHlink: 'C5A3FF' },
    major: 'Segoe UI Semibold',
    minor: 'Segoe UI',
    dark: true,
    bg: '<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="bg2"/></a:gs><a:gs pos="100000"><a:schemeClr val="bg1"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>',
    decor: rect(7, 'Accent Bar', 838200, 1600200, 914400, 45720, scheme('accent1')),
    titleDecor: rect(7, 'Accent Glow', 9372600, -1371600, 4572000, 4572000, scheme('accent1', '<a:alpha val="18000"/>'), 'ellipse') + rect(8, 'Accent Glow 2', -1524000, 4572000, 3657600, 3657600, scheme('accent2', '<a:alpha val="14000"/>'), 'ellipse'),
    titleColor: 'tx1',
  },
  {
    id: 'vivid',
    name: 'Vivid',
    colors: { dk1: '1E1E1E', lt1: 'FFFFFF', dk2: '2B2350', lt2: 'FFF4EA', accent1: 'E8505B', accent2: 'F9A03F', accent3: '14A098', accent4: '7A4EAB', accent5: '2F80ED', accent6: 'F2C14E', hlink: '2F80ED', folHlink: '7A4EAB' },
    major: 'Trebuchet MS',
    minor: 'Trebuchet MS',
    bg: '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
    decor: rect(7, 'Side Band', 0, 0, 182880, 6858000, scheme('accent1')) + rect(8, 'Side Band 2', 182880, 0, 91440, 6858000, scheme('accent2')),
    titleDecor: rect(7, 'Color Block', 0, 0, 12192000, 1600200, scheme('accent1')) + rect(8, 'Color Stripe', 0, 1600200, 12192000, 137160, scheme('accent2')) + rect(9, 'Color Stripe 2', 0, 1737360, 12192000, 91440, scheme('accent3')),
    titleColor: 'tx2',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    colors: { dk1: '262626', lt1: 'FFFFFF', dk2: '3A3A3A', lt2: 'F6F4EF', accent1: '1F6F5C', accent2: 'C8553D', accent3: '8A8D91', accent4: 'D9A441', accent5: '3D5A80', accent6: '7E6B8F', hlink: '1F6F5C', folHlink: '7E6B8F' },
    major: 'Georgia',
    minor: 'Arial',
    bg: '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
    decor: rect(7, 'Rule', 838200, 1690688, 10515600, 12700, scheme('tx1', '<a:lumMod val="50000"/><a:lumOff val="50000"/>')),
    titleDecor: rect(7, 'Rule', 4800600, 3581400, 2590800, 25400, scheme('accent1')),
  },
  {
    id: 'ocean',
    name: 'Ocean',
    colors: { dk1: '0B2239', lt1: 'FFFFFF', dk2: '0E4A6B', lt2: 'E6F3F7', accent1: '0E7C99', accent2: '22B8CF', accent3: 'F4A259', accent4: '5B8E7D', accent5: '3D5A80', accent6: 'BC4B51', hlink: '0E7C99', folHlink: '5B8E7D' },
    major: 'Calibri Light',
    minor: 'Calibri',
    bg: BG_REF,
    decor: rect(7, 'Footer Band', 0, 6629400, 12192000, 228600, scheme('accent1')),
    titleDecor:
      '<p:sp><p:nvSpPr><p:cNvPr id="7" name="Wave"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="tx2"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>',
    titleSlideColor: 'bg1',
  },
];

export function themeXml(d: DesignTheme): string {
  let xml = officeThemeXml().replace('name="Office Theme"', `name="${d.name}"`);
  for (const [name, hex] of Object.entries(d.colors)) {
    xml = xml.replace(new RegExp(`<a:${name}>.*?</a:${name}>`), `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`);
  }
  xml = xml.replace(/(<a:majorFont><a:latin typeface=")[^"]*"/, `$1${d.major}"`).replace(/(<a:minorFont><a:latin typeface=")[^"]*"/, `$1${d.minor}"`);
  return xml;
}

// ---- Master ---------------------------------------------------------------------------

function ph(id: number, name: string, type: string | null, idx: number | null, xfrm: [number, number, number, number] | null, opts: { body?: string; lst?: string; text?: string; sz?: string; geom?: boolean } = {}): string {
  const phAttrs = [type ? `type="${type}"` : '', opts.sz ? `sz="${opts.sz}"` : '', idx !== null ? `idx="${idx}"` : ''].filter(Boolean).join(' ');
  const xf = xfrm ? `<a:xfrm><a:off x="${xfrm[0]}" y="${xfrm[1]}"/><a:ext cx="${xfrm[2]}" cy="${xfrm[3]}"/></a:xfrm>` : '';
  const geom = opts.geom ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : '';
  const text = opts.text ?? '<a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit text</a:t></a:r></a:p>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr><p:spPr>${xf}${geom}</p:spPr><p:txBody>${opts.body ?? '<a:bodyPr/>'}${opts.lst ?? '<a:lstStyle/>'}${text}</p:txBody></p:sp>`;
}

const FOOTER_LST = (algn: string) => `<a:lstStyle><a:lvl1pPr algn="${algn}"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>`;
const FOOTER_BODY = '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>';
const DATE_TEXT = '<a:p><a:fld id="{B3E1F8D2-7C56-4A2B-9E1D-3F4A5B6C7D8E}" type="datetimeFigureOut"><a:rPr lang="en-US"/><a:t>1/1/2026</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>';
const NUM_TEXT = '<a:p><a:fld id="{A7C2E9F1-3B4D-4E5F-8A9B-0C1D2E3F4A5B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>';
const EMPTY_TEXT = '<a:p><a:endParaRPr lang="en-US"/></a:p>';

function footers(start: number, master: boolean): string {
  const y = 6356350;
  const h = 365125;
  return (
    ph(start, 'Date Placeholder', 'dt', master ? 2 : 10, master ? [838200, y, 2743200, h] : null, master ? { body: FOOTER_BODY, lst: FOOTER_LST('l'), text: DATE_TEXT, sz: 'half', geom: true } : { text: DATE_TEXT, sz: 'half' }) +
    ph(start + 1, 'Footer Placeholder', 'ftr', master ? 3 : 11, master ? [4038600, y, 4114800, h] : null, master ? { body: FOOTER_BODY, lst: FOOTER_LST('ctr'), text: EMPTY_TEXT, sz: 'quarter', geom: true } : { text: EMPTY_TEXT, sz: 'quarter' }) +
    ph(start + 2, 'Slide Number Placeholder', 'sldNum', master ? 4 : 12, master ? [8610600, y, 2743200, h] : null, master ? { body: FOOTER_BODY, lst: FOOTER_LST('r'), text: NUM_TEXT, sz: 'quarter', geom: true } : { text: NUM_TEXT, sz: 'quarter' })
  );
}

const BODY_TEXT =
  '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"/><a:t>Second level</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:r><a:rPr lang="en-US"/><a:t>Third level</a:t></a:r></a:p><a:p><a:pPr lvl="3"/><a:r><a:rPr lang="en-US"/><a:t>Fourth level</a:t></a:r></a:p><a:p><a:pPr lvl="4"/><a:r><a:rPr lang="en-US"/><a:t>Fifth level</a:t></a:r></a:p>';
const TITLE_TEXT = '<a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>';

function level(n: number, marL: number, indent: number, sz: number, spcBef: number, bullet: boolean, font: string): string {
  return `<a:lvl${n}pPr marL="${marL}" indent="${indent}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${spcBef}"/></a:spcBef>${
    bullet ? '<a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="•"/>' : '<a:buNone/>'
  }<a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${font}"/><a:ea typeface="${font.replace('lt', 'ea')}"/><a:cs typeface="${font.replace('lt', 'cs')}"/></a:defRPr></a:lvl${n}pPr>`;
}

function txStyles(d: DesignTheme): string {
  const title = `<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="${d.titleColor ?? 'tx1'}"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`;
  const sizes = [2800, 2400, 2000, 1800, 1800, 1800, 1800, 1800, 1800];
  const body = `<p:bodyStyle>${sizes.map((sz, i) => level(i + 1, 228600 + i * 457200, -228600, sz, i === 0 ? 1000 : 500, true, '+mn-lt')).join('')}</p:bodyStyle>`;
  const other = `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${sizes
    .map((_, i) => `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`)
    .join('')}</p:otherStyle>`;
  return `<p:txStyles>${title}${body}${other}</p:txStyles>`;
}

const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"';
const CLR_MAP_DARK = 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"';
const CLR_REST = 'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function masterXml(d: DesignTheme, layoutCount: number): string {
  const title = ph(2, 'Title Placeholder 1', 'title', null, [838200, 365125, 10515600, 1325563], {
    body: '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr>',
    text: TITLE_TEXT,
    geom: true,
  });
  const body = ph(3, 'Text Placeholder 2', 'body', 1, [838200, 1825625, 10515600, 4351338], {
    body: '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr>',
    text: BODY_TEXT,
    geom: true,
  });
  const ids = Array.from({ length: layoutCount }, (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join('');
  return `${XML_HEADER}<p:sldMaster ${NS_DECL}><p:cSld>${d.bg}<p:spTree>${TREE_HEAD}${d.decor ?? ''}${title}${body}${footers(4, true)}</p:spTree></p:cSld><p:clrMap ${d.dark ? CLR_MAP_DARK : CLR_MAP} ${CLR_REST}/><p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst>${txStyles(d)}</p:sldMaster>`;
}

interface LayoutDef {
  name: string;
  type: string;
  shapes: (d: DesignTheme) => string;
  /** Hides the master's own shapes (title slides with their own decoration). */
  ownDecor?: boolean;
}

const lvlNoBullet = (sz: number, extra = '') => `<a:lvl1pPr marL="0" indent="0"${extra}><a:buNone/><a:defRPr sz="${sz}"/></a:lvl1pPr>`;

const LAYOUTS: LayoutDef[] = [
  {
    name: 'Title Slide',
    type: 'title',
    ownDecor: true,
    shapes: (d) =>
      (d.titleDecor ?? '') +
      ph(2, 'Title 1', 'ctrTitle', null, [1524000, 1122363, 9144000, 2387600], { body: '<a:bodyPr anchor="b"/>', lst: `<a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"${d.titleSlideColor ? `><a:solidFill><a:schemeClr val="${d.titleSlideColor}"/></a:solidFill></a:defRPr` : '/'}></a:lvl1pPr></a:lstStyle>`, text: TITLE_TEXT }) +
      ph(3, 'Subtitle 2', 'subTitle', 1, [1524000, 3602038, 9144000, 1655762], {
        lst: `<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"${d.titleSlideColor ? `><a:solidFill><a:schemeClr val="${d.titleSlideColor}"/></a:solidFill></a:defRPr` : '/'}></a:lvl1pPr><a:lvl2pPr marL="457200" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2000"/></a:lvl2pPr><a:lvl3pPr marL="914400" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="1800"/></a:lvl3pPr></a:lstStyle>`,
        text: '<a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master subtitle style</a:t></a:r></a:p>',
      }) +
      footers(4, false),
  },
  {
    name: 'Title and Content',
    type: 'obj',
    shapes: () => ph(2, 'Title 1', 'title', null, null, { text: TITLE_TEXT }) + ph(3, 'Content Placeholder 2', null, 1, null, { text: BODY_TEXT }) + footers(4, false),
  },
  {
    name: 'Section Header',
    type: 'secHead',
    ownDecor: true,
    shapes: (d) =>
      (d.titleDecor && d.id !== 'ocean' ? d.titleDecor : '') +
      ph(2, 'Title 1', 'title', null, [831850, 1709738, 10515600, 2852737], { body: '<a:bodyPr anchor="b"/>', lst: '<a:lstStyle><a:lvl1pPr><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>', text: TITLE_TEXT }) +
      ph(3, 'Text Placeholder 2', 'body', 1, [831850, 4589463, 10515600, 1500187], {
        lst: `<a:lstStyle>${lvlNoBullet(2400).replace('<a:defRPr sz="2400"/>', '<a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr>')}</a:lstStyle>`,
        text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>',
      }) +
      footers(4, false),
  },
  {
    name: 'Two Content',
    type: 'twoObj',
    shapes: () =>
      ph(2, 'Title 1', 'title', null, null, { text: TITLE_TEXT }) +
      ph(3, 'Content Placeholder 2', null, 1, [838200, 1825625, 5181600, 4351338], { sz: 'half', text: BODY_TEXT }) +
      ph(4, 'Content Placeholder 3', null, 2, [6172800, 1825625, 5181600, 4351338], { sz: 'half', text: BODY_TEXT }) +
      footers(5, false),
  },
  {
    name: 'Comparison',
    type: 'twoTxTwoObj',
    shapes: () =>
      ph(2, 'Title 1', 'title', null, [839788, 365125, 10515600, 1325563], { text: TITLE_TEXT }) +
      ph(3, 'Text Placeholder 2', 'body', 1, [839788, 1681163, 5157787, 823912], { body: '<a:bodyPr anchor="b"/>', lst: `<a:lstStyle>${lvlNoBullet(2400).replace('<a:defRPr sz="2400"/>', '<a:defRPr sz="2400" b="1"/>')}</a:lstStyle>`, text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>' }) +
      ph(4, 'Content Placeholder 3', null, 2, [839788, 2505075, 5157787, 3684588], { sz: 'half', text: BODY_TEXT }) +
      ph(5, 'Text Placeholder 4', 'body', 3, [6172200, 1681163, 5183188, 823912], { sz: 'quarter', body: '<a:bodyPr anchor="b"/>', lst: `<a:lstStyle>${lvlNoBullet(2400).replace('<a:defRPr sz="2400"/>', '<a:defRPr sz="2400" b="1"/>')}</a:lstStyle>`, text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>' }) +
      ph(6, 'Content Placeholder 5', null, 4, [6172200, 2505075, 5183188, 3684588], { sz: 'quarter', text: BODY_TEXT }) +
      footers(7, false),
  },
  {
    name: 'Title Only',
    type: 'titleOnly',
    shapes: () => ph(2, 'Title 1', 'title', null, null, { text: TITLE_TEXT }) + footers(3, false),
  },
  { name: 'Blank', type: 'blank', shapes: () => footers(2, false) },
  {
    name: 'Content with Caption',
    type: 'objTx',
    shapes: () =>
      ph(2, 'Title 1', 'title', null, [839788, 457200, 3932237, 1600200], { body: '<a:bodyPr anchor="b"/>', lst: '<a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle>', text: TITLE_TEXT }) +
      ph(3, 'Content Placeholder 2', null, 1, [5183188, 987425, 6172200, 4873625], { lst: '<a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2800"/></a:lvl2pPr><a:lvl3pPr><a:defRPr sz="2400"/></a:lvl3pPr></a:lstStyle>', text: BODY_TEXT }) +
      ph(4, 'Text Placeholder 3', 'body', 2, [839788, 2057400, 3932237, 3811588], { sz: 'half', lst: `<a:lstStyle>${lvlNoBullet(1600)}</a:lstStyle>`, text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>' }) +
      footers(5, false),
  },
  {
    name: 'Picture with Caption',
    type: 'picTx',
    shapes: () =>
      ph(2, 'Title 1', 'title', null, [839788, 457200, 3932237, 1600200], { body: '<a:bodyPr anchor="b"/>', lst: '<a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle>', text: TITLE_TEXT }) +
      ph(3, 'Picture Placeholder 2', 'pic', 1, [5183188, 987425, 6172200, 4873625], { lst: `<a:lstStyle>${lvlNoBullet(3200)}</a:lstStyle>`, text: EMPTY_TEXT }) +
      ph(4, 'Text Placeholder 3', 'body', 2, [839788, 2057400, 3932237, 3811588], { sz: 'half', lst: `<a:lstStyle>${lvlNoBullet(1600)}</a:lstStyle>`, text: '<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>' }) +
      footers(5, false),
  },
];

function layoutXml(l: LayoutDef, d: DesignTheme): string {
  const hideMaster = l.ownDecor && d.titleDecor;
  return `${XML_HEADER}<p:sldLayout ${NS_DECL} type="${l.type}" preserve="1"${hideMaster ? ' showMasterSp="0"' : ''}><p:cSld name="${l.name}"><p:spTree>${TREE_HEAD}${l.shapes(d)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function presentationXml(w: number, h: number): string {
  const lvl = (n: number) =>
    `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return `${XML_HEADER}<p:presentation ${NS_DECL} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldSz cx="${w}" cy="${h}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(lvl).join('')}</p:defaultTextStyle></p:presentation>`;
}

/** A presentation package with no slides yet, in a design. */
export function newPackage(design: DesignTheme = DESIGNS[0], size = { w: 12192000, h: 6858000 }): OpcPackage {
  const pkg = emptyPackage();
  pkg.setText('_rels/.rels', `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  pkg.addRel('', REL.officeDocument, 'ppt/presentation.xml');
  addDocProps(pkg, 'Din Slides');
  pkg.addRel('', REL.coreProps, 'docProps/core.xml');
  pkg.addRel('', REL.extProps, 'docProps/app.xml');
  const main = 'ppt/presentation.xml';
  pkg.setText(main, presentationXml(size.w, size.h));
  pkg.ensureOverride(main, CT_PML.main);
  const master = 'ppt/slideMasters/slideMaster1.xml';
  pkg.setText(master, masterXml(design, LAYOUTS.length));
  pkg.ensureOverride(master, CT_PML.master);
  const masterRels = LAYOUTS.map((l, i) => {
    const part = `ppt/slideLayouts/slideLayout${i + 1}.xml`;
    pkg.setText(part, layoutXml(l, design));
    pkg.ensureOverride(part, CT_PML.layout);
    pkg.setRels(part, [{ id: 'rId1', type: REL.slideMaster, target: master, external: false }]);
    return { id: `rId${i + 1}`, type: REL.slideLayout, target: part, external: false };
  });
  const theme = 'ppt/theme/theme1.xml';
  pkg.setText(theme, themeXml(design));
  pkg.ensureOverride(theme, CT.theme);
  pkg.setRels(master, [...masterRels, { id: `rId${LAYOUTS.length + 1}`, type: REL.theme, target: theme, external: false }]);
  pkg.setRels(main, [{ id: 'rId1', type: REL.slideMaster, target: master, external: false }]);
  const extra: [string, string, string, string][] = [
    ['ppt/presProps.xml', REL.presProps, CT_PML.presProps, `${XML_HEADER}<p:presentationPr ${NS_DECL}/>`],
    ['ppt/viewProps.xml', REL.viewProps, CT_PML.viewProps, `${XML_HEADER}<p:viewPr ${NS_DECL}><p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15611"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`],
    ['ppt/theme/theme1.xml', REL.theme, CT.theme, ''],
    ['ppt/tableStyles.xml', REL.tableStyles, CT_PML.tableStyles, XML_HEADER + tableStyleListXml()],
  ];
  for (const [part, rel, ct, xml] of extra) {
    if (xml) pkg.setText(part, xml);
    pkg.ensureOverride(part, ct);
    pkg.addRel(main, rel, part);
  }
  return pkg;
}

