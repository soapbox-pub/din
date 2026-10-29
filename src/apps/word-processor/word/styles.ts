import { at, attr, kid, kids, numAttr, onOff, parseXml, twipToPx } from '@/shared/office/ooxml';
import { fontStack } from '@/shared/office/fonts';
import { tintColor, type Theme } from '@/shared/office/theme';

/**
 * Word's styles (styles.xml): the document defaults, then paragraph styles
 * built on each other (Heading 1 is based on Normal...). Each is resolved
 * down its basedOn chain and turned into CSS for the page, so paragraphs only
 * carry their style's id and what's set on them directly, as in Word.
 */

export interface RunProps {
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  /** Hex without '#'. */
  color?: string;
  /** Letter spacing in points. */
  spacing?: number;
  highlight?: string;
  vertAlign?: 'superscript' | 'subscript';
}

export interface ParaProps {
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Pixels. */
  indLeft?: number;
  indRight?: number;
  /** First-line indent in pixels; negative for a hanging indent. */
  indFirst?: number;
  /** Points. */
  spBefore?: number;
  spAfter?: number;
  /** A multiple of single spacing for 'auto', points otherwise. */
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
  contextual?: boolean;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  numId?: number;
  ilvl?: number;
  outlineLvl?: number;
  shading?: string;
  borderTop?: string;
  borderBottom?: string;
}

export interface Style {
  id: string;
  name: string;
  type: 'paragraph' | 'character' | 'table' | 'numbering';
  basedOn?: string;
  next?: string;
  quick: boolean;
  hidden: boolean;
  priority: number;
  /** As written on the style itself. */
  ownRun: RunProps;
  ownPara: ParaProps;
  /** Down the basedOn chain. */
  run: RunProps;
  para: ParaProps;
  /** Tables: whether the style draws cell borders. */
  tableBorders?: boolean;
  table?: TableStyle;
}

type Side = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV';

/** The look of a part of a table (the header row, banded rows...) in a table style. */
export interface TablePart {
  fill?: string;
  run: RunProps;
  borders: Partial<Record<Side, string>>;
}

export interface TableStyle {
  whole: TablePart;
  parts: Partial<Record<'firstRow' | 'lastRow' | 'firstCol' | 'lastCol' | 'band1Horz' | 'band1Vert', TablePart>>;
}

export interface StyleSheet {
  defaultsRun: RunProps;
  defaultsPara: ParaProps;
  styles: Map<string, Style>;
  /** The style paragraphs get when they name none (normally Normal). */
  defaultParagraph: string;
  defaultTable: string | null;
  theme: Theme;
}

const ALIGN: Record<string, ParaProps['align']> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };

/** Colors as Word writes them: a value, or a theme color with a tint or shade. */
export function readColor(el: Element | null, theme: Theme): string | undefined {
  if (!el) return undefined;
  const themeColor = attr(el, 'themeColor');
  if (themeColor) {
    const map: Record<string, keyof Theme['colors']> = {
      dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2',
      accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
      hyperlink: 'hlink', followedHyperlink: 'folHlink',
    };
    const base = map[themeColor] ? theme.colors[map[themeColor]] : null;
    if (base) {
      const tint = attr(el, 'themeTint');
      const shade = attr(el, 'themeShade');
      if (shade) return tintColor(base, parseInt(shade, 16) / 255 - 1);
      if (tint) return tintColor(base, 1 - parseInt(tint, 16) / 255);
      return base;
    }
  }
  const v = attr(el, 'val');
  if (v && /^[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  return undefined;
}

export function readFont(rFonts: Element | null, theme: Theme): string | undefined {
  if (!rFonts) return undefined;
  const t = attr(rFonts, 'asciiTheme') ?? attr(rFonts, 'hAnsiTheme');
  if (t) return t.startsWith('major') ? theme.majorFont : theme.minorFont;
  return attr(rFonts, 'ascii') ?? attr(rFonts, 'hAnsi') ?? undefined;
}

export function readRunProps(rPr: Element | null, theme: Theme): RunProps {
  const p: RunProps = {};
  if (!rPr) return p;
  const font = readFont(kid(rPr, 'rFonts'), theme);
  if (font) p.font = font;
  const sz = numAttr(kid(rPr, 'sz'), 'val');
  if (sz) p.size = sz / 2;
  const flag = (name: string) => onOff(kid(rPr, name));
  const b = flag('b');
  if (b !== null) p.bold = b;
  const i = flag('i');
  if (i !== null) p.italic = i;
  const u = kid(rPr, 'u');
  if (u) p.underline = attr(u, 'val') !== 'none';
  const strike = flag('strike') ?? flag('dstrike');
  if (strike !== null) p.strike = strike;
  const caps = flag('caps');
  if (caps !== null) p.caps = caps;
  const small = flag('smallCaps');
  if (small !== null) p.smallCaps = small;
  const color = kid(rPr, 'color');
  if (color && attr(color, 'val') !== 'auto') {
    const c = readColor(color, theme);
    if (c) p.color = c;
  }
  const spacing = numAttr(kid(rPr, 'spacing'), 'val');
  if (spacing) p.spacing = spacing / 20;
  const hl = attr(kid(rPr, 'highlight'), 'val');
  if (hl && hl !== 'none') p.highlight = hl;
  const va = attr(kid(rPr, 'vertAlign'), 'val');
  if (va === 'superscript' || va === 'subscript') p.vertAlign = va;
  return p;
}

export function readParaProps(pPr: Element | null): ParaProps {
  const p: ParaProps = {};
  if (!pPr) return p;
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc && ALIGN[jc]) p.align = ALIGN[jc];
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = numAttr(ind, 'left') ?? numAttr(ind, 'start');
    const right = numAttr(ind, 'right') ?? numAttr(ind, 'end');
    const hanging = numAttr(ind, 'hanging');
    const first = numAttr(ind, 'firstLine');
    if (left !== null) p.indLeft = twipToPx(left);
    if (right !== null) p.indRight = twipToPx(right);
    if (hanging !== null) p.indFirst = -twipToPx(hanging);
    else if (first !== null) p.indFirst = twipToPx(first);
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = numAttr(sp, 'before');
    const after = numAttr(sp, 'after');
    const auto = (name: string) => {
      const v = attr(sp, name);
      return v !== null && !['0', 'false', 'off'].includes(v);
    };
    if (auto('beforeAutospacing')) p.spBefore = 14;
    else if (before !== null) p.spBefore = before / 20;
    if (auto('afterAutospacing')) p.spAfter = 14;
    else if (after !== null) p.spAfter = after / 20;
    const line = numAttr(sp, 'line');
    if (line !== null) {
      const rule = attr(sp, 'lineRule') ?? 'auto';
      if (rule === 'exact' || rule === 'atLeast') {
        p.lineRule = rule;
        p.line = line / 20;
      } else {
        p.lineRule = 'auto';
        p.line = line / 240;
      }
    }
  }
  const ctx = onOff(kid(pPr, 'contextualSpacing'));
  if (ctx !== null) p.contextual = ctx;
  const keep = onOff(kid(pPr, 'keepNext'));
  if (keep !== null) p.keepNext = keep;
  const pb = onOff(kid(pPr, 'pageBreakBefore'));
  if (pb !== null) p.pageBreakBefore = pb;
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    const numId = numAttr(kid(numPr, 'numId'), 'val');
    if (numId !== null) p.numId = numId;
    const ilvl = numAttr(kid(numPr, 'ilvl'), 'val');
    if (ilvl !== null) p.ilvl = ilvl;
  }
  const outline = numAttr(kid(pPr, 'outlineLvl'), 'val');
  if (outline !== null) p.outlineLvl = outline;
  const shd = attr(kid(pPr, 'shd'), 'fill');
  if (shd && /^[0-9a-f]{6}$/i.test(shd)) p.shading = shd.toUpperCase();
  const bdr = kid(pPr, 'pBdr');
  if (bdr) {
    const side = (name: string) => {
      const el = kid(bdr, name);
      if (!el || ['nil', 'none'].includes(attr(el, 'val') ?? '')) return undefined;
      const w = Math.max(1, Math.round(((numAttr(el, 'sz') ?? 4) / 8) * (96 / 72)));
      const c = attr(el, 'color');
      return `${w}px solid #${c && /^[0-9a-f]{6}$/i.test(c) ? c : '000000'}`;
    };
    p.borderTop = side('top');
    p.borderBottom = side('bottom');
  }
  return p;
}

/** A WordprocessingML border element as CSS ('none' for nil). */
export function borderCss(el: Element | null, theme: Theme): string | undefined {
  if (!el) return undefined;
  const val = attr(el, 'val') ?? 'single';
  if (val === 'nil' || val === 'none') return 'none';
  const w = Math.max(1, Math.round(((numAttr(el, 'sz') ?? 4) / 8) * (96 / 72) * 2) / 2);
  const color = attr(el, 'color') === 'auto' ? '000000' : (readColor(el, theme) ?? '000000');
  const style = val === 'double' ? 'double' : val.includes('dash') ? 'dashed' : val === 'dotted' ? 'dotted' : 'solid';
  return `${style === 'double' ? Math.max(3, w) : w}px ${style} #${color}`;
}

function readTablePart(el: Element | null, theme: Theme, bordersEl: Element | null): TablePart {
  const fill = attr(at(el, 'tcPr', 'shd'), 'fill');
  const borders: Partial<Record<Side, string>> = {};
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as Side[]) {
    const b = borderCss(kid(bordersEl, side) ?? kid(bordersEl, side === 'left' ? 'start' : side === 'right' ? 'end' : side), theme);
    if (b) borders[side] = b;
  }
  return { fill: fill && /^[0-9a-f]{6}$/i.test(fill) ? fill.toUpperCase() : undefined, run: readRunProps(kid(el, 'rPr'), theme), borders };
}

export function parseStyles(doc: Document | null, theme: Theme): StyleSheet {
  const sheet: StyleSheet = {
    defaultsRun: { font: theme.minorFont, size: 10 },
    defaultsPara: {},
    styles: new Map(),
    defaultParagraph: 'Normal',
    defaultTable: null,
    theme,
  };
  if (!doc) return sheet;
  const root = doc.documentElement;
  const defaults = kid(root, 'docDefaults');
  sheet.defaultsRun = { font: theme.minorFont, size: 10, ...readRunProps(at(defaults, 'rPrDefault', 'rPr'), theme) };
  sheet.defaultsPara = readParaProps(at(defaults, 'pPrDefault', 'pPr'));
  for (const el of kids(root, 'style')) {
    const id = attr(el, 'styleId');
    const type = attr(el, 'type') as Style['type'] | null;
    if (!id || !type) continue;
    const style: Style = {
      id,
      name: attr(kid(el, 'name'), 'val') ?? id,
      type,
      basedOn: attr(kid(el, 'basedOn'), 'val') ?? undefined,
      next: attr(kid(el, 'next'), 'val') ?? undefined,
      quick: onOff(kid(el, 'qFormat')) === true,
      hidden: onOff(kid(el, 'semiHidden')) === true || onOff(kid(el, 'hidden')) === true,
      priority: numAttr(kid(el, 'uiPriority'), 'val') ?? 99,
      ownRun: readRunProps(kid(el, 'rPr'), theme),
      ownPara: readParaProps(kid(el, 'pPr')),
      run: {},
      para: {},
    };
    if (type === 'table') {
      const borders = at(el, 'tblPr', 'tblBorders');
      style.tableBorders = !!borders && kids(borders).some((b) => !['nil', 'none'].includes(attr(b, 'val') ?? 'none'));
      const table: TableStyle = { whole: readTablePart(el, theme, borders), parts: {} };
      for (const part of kids(el, 'tblStylePr')) {
        const t = attr(part, 'type') as keyof TableStyle['parts'] | null;
        if (t) table.parts[t] = readTablePart(part, theme, at(part, 'tcPr', 'tcBorders'));
      }
      style.table = table;
    }
    sheet.styles.set(id, style);
    if (onOff(el, 'default') && attr(el, 'default') !== null) {
      if (type === 'paragraph') sheet.defaultParagraph = id;
      if (type === 'table') sheet.defaultTable = id;
    }
  }
  resolveAll(sheet);
  return sheet;
}

export function resolveAll(sheet: StyleSheet): void {
  const resolving = new Set<string>();
  const resolve = (s: Style): void => {
    if (resolving.has(s.id)) return;
    resolving.add(s.id);
    const base = s.basedOn ? sheet.styles.get(s.basedOn) : undefined;
    if (base && base.id !== s.id) {
      resolve(base);
      s.run = { ...base.run, ...s.ownRun };
      s.para = { ...base.para, ...s.ownPara };
      if (s.tableBorders === undefined) s.tableBorders = base.tableBorders;
      if (base.table && s.table) {
        const merge = (a: TablePart | undefined, b: TablePart | undefined): TablePart | undefined =>
          a || b ? { fill: b?.fill ?? a?.fill, run: { ...a?.run, ...b?.run }, borders: { ...a?.borders, ...b?.borders } } : undefined;
        const parts = { ...base.table.parts };
        for (const [k, v] of Object.entries(s.table.parts) as [keyof TableStyle['parts'], TablePart][]) parts[k] = merge(parts[k], v);
        s.table = { whole: merge(base.table.whole, s.table.whole)!, parts };
      }
    } else {
      s.run = { ...s.ownRun };
      s.para = { ...s.ownPara };
    }
  };
  for (const s of sheet.styles.values()) resolve(s);
}

/** A run's effective properties under a paragraph style, for the font box and friends. */
export function effectiveRun(sheet: StyleSheet, styleId: string | null): RunProps {
  const style = sheet.styles.get(styleId ?? sheet.defaultParagraph) ?? sheet.styles.get(sheet.defaultParagraph);
  return { ...sheet.defaultsRun, ...(style?.run ?? {}) };
}

export function effectivePara(sheet: StyleSheet, styleId: string | null): ParaProps {
  const style = sheet.styles.get(styleId ?? sheet.defaultParagraph) ?? sheet.styles.get(sheet.defaultParagraph);
  return { ...sheet.defaultsPara, ...(style?.para ?? {}) };
}

/** The styles Word shows in the Styles gallery, in its order. */
export function galleryStyles(sheet: StyleSheet): Style[] {
  return [...sheet.styles.values()]
    .filter((s) => (s.type === 'paragraph' || s.type === 'character') && (s.quick || s.id === sheet.defaultParagraph) && !s.hidden)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  function rank(s: Style) {
    return s.id === sheet.defaultParagraph ? -1 : s.priority;
  }
}

// ---- CSS -------------------------------------------------------------------------

/**
 * Single line spacing is the font's own line height, which differs by
 * font; CSS's 'normal' would follow the substitute font's metrics instead.
 */
export function lineFactor(font: string | undefined): number {
  const f = (font ?? '').toLowerCase();
  if (f.startsWith('calibri') || f.startsWith('aptos') || f === 'carlito') return 1.2207;
  if (f.startsWith('cambria') || f === 'caladea') return 1.1724;
  if (f.startsWith('courier') || f === 'consolas') return 1.1328;
  if (f.startsWith('arial') || f.startsWith('times') || f.startsWith('helvetica') || f === 'liberation sans') return 1.1499;
  if (f.startsWith('segoe')) return 1.33;
  if (f.startsWith('georgia')) return 1.136;
  if (f.startsWith('verdana') || f.startsWith('tahoma')) return 1.2153;
  return 1.17;
}

const safeNum = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

export function runCss(r: RunProps): string[] {
  const out: string[] = [];
  if (r.font) out.push(`font-family: ${fontStack(r.font)}`, `--lh: ${lineFactor(r.font)}`);
  if (r.size) out.push(`font-size: ${safeNum(r.size)}pt`);
  if (r.bold !== undefined) out.push(`font-weight: ${r.bold ? 700 : 400}`);
  if (r.italic !== undefined) out.push(`font-style: ${r.italic ? 'italic' : 'normal'}`);
  const deco = [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean);
  if (r.underline !== undefined || r.strike !== undefined) out.push(`text-decoration: ${deco.length ? deco.join(' ') : 'none'}`);
  if (r.caps) out.push('text-transform: uppercase');
  if (r.smallCaps) out.push('font-variant: small-caps');
  if (r.color) out.push(`color: #${r.color}`);
  if (r.spacing) out.push(`letter-spacing: ${safeNum(r.spacing)}pt`);
  return out;
}

export function paraCss(p: ParaProps, font?: string): string[] {
  const out: string[] = [];
  if (p.align) out.push(`text-align: ${p.align}`);
  if (p.indLeft !== undefined) out.push(`margin-left: ${safeNum(p.indLeft)}px`);
  if (p.indRight !== undefined) out.push(`margin-right: ${safeNum(p.indRight)}px`);
  if (p.indFirst !== undefined) out.push(`text-indent: ${safeNum(p.indFirst)}px`);
  if (p.spBefore !== undefined) out.push(`padding-top: ${safeNum(p.spBefore)}pt`);
  if (p.spAfter !== undefined) out.push(`padding-bottom: ${safeNum(p.spAfter)}pt`);
  if (p.line !== undefined) out.push(`line-height: ${lineHeightCss(p.line, p.lineRule ?? 'auto', font)}`);
  if (p.shading) out.push(`background-color: #${p.shading}`);
  if (p.borderTop) out.push(`border-top: ${p.borderTop}`, 'padding-top: 2px');
  if (p.borderBottom) out.push(`border-bottom: ${p.borderBottom}`);
  return out;
}

export function lineHeightCss(line: number, rule: 'auto' | 'exact' | 'atLeast', font?: string): string {
  if (rule === 'exact') return `${safeNum(line)}pt`;
  if (rule === 'atLeast') return `max(${safeNum(line)}pt, calc(var(--lh, 1.17) * 1em))`;
  return font ? `${safeNum(lineFactor(font) * line)}` : `calc(var(--lh, 1.17) * ${safeNum(line)})`;
}

/** The stylesheet for one document, scoped under `scope` (a class selector). */
export function styleCss(sheet: StyleSheet, scope: string): string {
  const rules: string[] = [];
  const rule = (sel: string, decls: string[]) => decls.length && rules.push(`${sel} { ${decls.join('; ')}; }`);
  const d = sheet.defaultsRun;
  rule(scope, [...runCss({ ...d, bold: undefined, italic: undefined, underline: undefined, strike: undefined }), `line-height: calc(var(--lh) * 1)`]);
  rule(`${scope} p`, paraCss({ spBefore: 0, spAfter: 0, line: 1, lineRule: 'auto', ...sheet.defaultsPara }));
  const sel = (id: string) => `[data-style="${CSS.escape(id)}"]`;
  const order = [...sheet.styles.values()].filter((s) => s.type === 'paragraph');
  // Normal first, then table styles, then the rest, which beat both.
  const normal = sheet.styles.get(sheet.defaultParagraph);
  if (normal) {
    rule(`${scope} p:where(:not([data-style]), ${sel(normal.id)})`, [...runCss(normal.run), ...paraCss(normal.para, normal.run.font)]);
  }
  for (const s of sheet.styles.values()) {
    if (s.type !== 'table') continue;
    rule(`${scope} :where(table${sel(s.id)}) p`, [...runCss(s.run), ...paraCss(s.para, s.run.font ?? normal?.run.font)]);
  }
  for (const s of order) {
    if (s === normal) continue;
    const font = s.run.font ?? normal?.run.font ?? d.font;
    rule(`${scope} p${sel(s.id)}`, [...runCss(s.run), ...paraCss(s.para, font)]);
    if (s.para.contextual) {
      rule(`${scope} p${sel(s.id)}:has(+ p${sel(s.id)})`, ['padding-bottom: 0']);
      rule(`${scope} p${sel(s.id)} + p${sel(s.id)}`, ['padding-top: 0']);
    }
  }
  if (normal?.para.contextual) {
    rule(`${scope} p:where(:not([data-style])):has(+ p:not([data-style]))`, ['padding-bottom: 0']);
    rule(`${scope} p:where(:not([data-style])) + p:not([data-style])`, ['padding-top: 0']);
  }
  for (const s of sheet.styles.values()) {
    if (s.type === 'character') rule(`${scope} span${sel(s.id)}`, runCss(s.run));
  }
  for (const s of sheet.styles.values()) if (s.type === 'table' && s.table) tableCss(`${scope} table${sel(s.id)}`, s.table, rule);
  return rules.join('\n');
}

/** A table style's borders and conditional formatting (header row, bands...) as CSS. */
function tableCss(t: string, ts: TableStyle, rule: (sel: string, decls: string[]) => void) {
  const cell = `${t} > tbody > tr > td`;
  const part = (sel: string, p: TablePart | undefined, edges = true) => {
    if (!p) return;
    const decls: string[] = [];
    if (p.fill) decls.push(`background-color: #${p.fill}`);
    const run = runCss(p.run).filter((d) => !d.startsWith('--lh'));
    if (edges) {
      const b = p.borders;
      if (b.top) decls.push(`border-top: ${b.top}`);
      if (b.bottom) decls.push(`border-bottom: ${b.bottom}`);
      if (b.left) decls.push(`border-left: ${b.left}`);
      if (b.right) decls.push(`border-right: ${b.right}`);
    }
    rule(sel, decls);
    if (run.length) rule(`${sel} p`, run);
  };
  const w = ts.whole.borders;
  rule(cell, [
    `border-top: ${w.insideH ?? 'none'}`,
    `border-bottom: ${w.insideH ?? 'none'}`,
    `border-left: ${w.insideV ?? 'none'}`,
    `border-right: ${w.insideV ?? 'none'}`,
    ...(ts.whole.fill ? [`background-color: #${ts.whole.fill}`] : []),
  ]);
  if (w.top) rule(`${t} > tbody > tr:first-child > td`, [`border-top: ${w.top}`]);
  if (w.bottom) rule(`${t} > tbody > tr:last-child > td`, [`border-bottom: ${w.bottom}`]);
  if (w.left) rule(`${t} > tbody > tr > td:first-child`, [`border-left: ${w.left}`]);
  if (w.right) rule(`${t} > tbody > tr > td:last-child`, [`border-right: ${w.right}`]);
  const P = ts.parts;
  // Bands count the rows under the header row.
  part(`${t}[data-band-rows][data-first-row] > tbody > tr:nth-child(2n) > td`, P.band1Horz, false);
  part(`${t}[data-band-rows]:not([data-first-row]) > tbody > tr:nth-child(2n+1) > td`, P.band1Horz, false);
  part(`${t}[data-first-col] > tbody > tr > td:first-child`, P.firstCol);
  part(`${t}[data-last-col] > tbody > tr > td:last-child`, P.lastCol);
  part(`${t}[data-first-row] > tbody > tr:first-child > td`, P.firstRow);
  part(`${t}[data-last-row] > tbody > tr:last-child > td`, P.lastRow);
}

// ---- Built-in styles -------------------------------------------------------------

/**
 * Word's built-in styles as Word writes them, for new documents and for
 * documents that lack one someone applies from the gallery.
 */
export const BUILTIN_STYLES: Record<string, string> = {
  Normal: '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
  Heading1:
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading1Char"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>',
  Heading2:
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading2Char"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>',
  Heading3:
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading3Char"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="1F3763" w:themeColor="accent1" w:themeShade="7F"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>',
  Title:
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="TitleChar"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>',
  Subtitle:
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="SubtitleChar"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/><w:color w:val="5A5A5A" w:themeColor="text1" w:themeTint="A5"/><w:spacing w:val="15"/></w:rPr></w:style>',
  Quote:
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="QuoteChar"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="160"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040" w:themeColor="text1" w:themeTint="BF"/></w:rPr></w:style>',
  IntenseQuote:
    '<w:style w:type="paragraph" w:styleId="IntenseQuote"><w:name w:val="Intense Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="IntenseQuoteChar"/><w:uiPriority w:val="30"/><w:qFormat/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="10" w:color="4472C4" w:themeColor="accent1"/><w:bottom w:val="single" w:sz="4" w:space="10" w:color="4472C4" w:themeColor="accent1"/></w:pBdr><w:spacing w:before="360" w:after="360"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="4472C4" w:themeColor="accent1"/></w:rPr></w:style>',
  ListParagraph:
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>',
  NoSpacing:
    '<w:style w:type="paragraph" w:styleId="NoSpacing"><w:name w:val="No Spacing"/><w:uiPriority w:val="1"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>',
  Hyperlink:
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>',
  TableGrid:
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>',
};

/** Add one of Word's built-in styles to a document that lacks it; true if it was added. */
export function ensureBuiltin(sheet: StyleSheet, id: string): boolean {
  if (sheet.styles.has(id) || !BUILTIN_STYLES[id]) return false;
  const doc = parseXml(`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${BUILTIN_STYLES[id]}</w:styles>`);
  const parsed = parseStyles(doc, sheet.theme);
  const style = parsed.styles.get(id);
  if (!style) return false;
  if (style.basedOn === 'Normal') style.basedOn = sheet.defaultParagraph;
  sheet.styles.set(id, style);
  resolveAll(sheet);
  return true;
}

/** styles.xml for a new document: Word's defaults with Calibri. */
export function defaultStylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    Object.values(BUILTIN_STYLES).join('') +
    '</w:styles>'
  );
}
