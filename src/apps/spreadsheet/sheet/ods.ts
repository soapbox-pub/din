import {
  attrs,
  contentStyles,
  FontFaces,
  inch,
  lengthPt,
  lengthPx,
  ODF,
  ODF_MIME,
  ODF_NS_DECLS,
  ODF_VERSION,
  odfColor,
  OdfDocument,
  odfRoot,
  paragraphText,
  pt,
  textXml,
  writeOdf,
  type OdfStyles,
  type Props,
} from '@/shared/office/odf';
import { attr, esc, kid, kids } from '@/shared/office/ooxml';
import { OFFICE_THEME } from '@/shared/office/theme';
import { cellKey, keyCol, keyRow, MAX_COLS, MAX_ROWS, type Range } from './addr';
import { dateSerial, serialParts, timeSerial } from './dates';
import { tokenize } from './formula';
import {
  defaultStyle,
  newSheet,
  sheetExtent,
  StyleTable,
  type BorderSide,
  type BorderStyle,
  type Cell,
  type ColInfo,
  type DefinedName,
  type Font,
  type HAlign,
  type RowInfo,
  type Sheet,
  type Style,
  type VAlign,
  type Workbook,
} from './model';
import { formatValue, isDateFormat } from './numfmt';
import { addressToExcel, formulaFromOdf, formulaToOdf, refToOdfAddress } from './odfFormula';
import { dataStylesFor, formatCodeOf } from './odfNumFmt';
import { CellError, errOf, type Scalar } from './values';
import type { Loaded } from './xlsxRead';

/**
 * OpenDocument spreadsheets (.ods, and flat .fods), LibreOffice Calc's
 * format: sheets of rows of cells (runs of identical rows, columns and cells
 * written once with a repeat count), cell styles with their data styles
 * (number formats), merged cells, OpenFormula formulas, named ranges, and
 * the view settings (active sheet, frozen panes, zoom).
 */

// ---- Reading -----------------------------------------------------------------------------------

const ALIGN_IN: Record<string, HAlign> = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' };
const VALIGN_IN: Record<string, VAlign> = { top: 'top', middle: 'center', bottom: 'bottom' };

function borderIn(v: string | undefined): BorderSide | undefined {
  if (!v || v === 'none' || v === 'hidden') return undefined;
  const parts = v.trim().split(/\s+/);
  const color = parts.map(odfColor).find(Boolean) ?? '000000';
  const width = parts.map(lengthPt).find((n) => n !== null) ?? 0.75;
  const kind = parts.find((p) => /^(solid|dashed|dotted|double|dash-dot|dash-dot-dot|fine-dashed|groove|ridge|inset|outset)$/.test(p)) ?? 'solid';
  if (width === 0) return undefined;
  let style: BorderStyle;
  if (kind === 'double') style = 'double';
  else if (kind === 'dotted') style = 'dotted';
  else if (kind === 'dashed' || kind === 'fine-dashed') style = width > 1.2 ? 'mediumDashed' : 'dashed';
  else if (kind === 'dash-dot') style = width > 1.2 ? 'mediumDashDot' : 'dashDot';
  else if (kind === 'dash-dot-dot') style = width > 1.2 ? 'mediumDashDotDot' : 'dashDotDot';
  else style = width < 0.3 ? 'hair' : width <= 1.2 ? 'thin' : width <= 2.1 ? 'medium' : 'thick';
  return { style, color };
}

/** An attribute set on a style or the nearest of its parents (data-style-name). */
function styleAttr(styles: OdfStyles, family: string, name: string | null, a: string): string | null {
  let s = styles.get(family, name);
  const seen = new Set<string>();
  while (s && !seen.has(s.name)) {
    seen.add(s.name);
    const v = attr(s.el, a);
    if (v) return v;
    s = styles.get(family, s.parent);
  }
  return null;
}

function styleFrom(props: Props, numFmt: string, styles: OdfStyles, base: Font): Style {
  const t = props.text ?? {};
  const c = props['table-cell'] ?? {};
  const p = props.paragraph ?? {};
  const size = lengthPt(t['font-size']);
  const font: Font = { name: styles.fontOf(t) ?? base.name, size: size === null ? base.size : Math.round(size * 100) / 100 };
  const w = t['font-weight'];
  if (w && (w === 'bold' || (/^\d+$/.test(w) && Number(w) >= 600))) font.bold = true;
  if (t['font-style'] === 'italic' || t['font-style'] === 'oblique') font.italic = true;
  const u = t['text-underline-style'];
  if (u && u !== 'none') font.underline = t['text-underline-type'] === 'double' ? 'double' : 'single';
  const lt = t['text-line-through-style'];
  if (lt && lt !== 'none') font.strike = true;
  const color = odfColor(t.color);
  if (color && color !== '000000') font.color = color;
  const pos = t['text-position']?.split(/\s+/)[0];
  if (pos === 'super' || (pos?.endsWith('%') && parseFloat(pos) > 0)) font.vert = 'superscript';
  else if (pos === 'sub' || (pos?.endsWith('%') && parseFloat(pos) < 0)) font.vert = 'subscript';
  const s: Style = defaultStyle(font);
  s.numFmt = numFmt;
  s.fill = odfColor(c['background-color']);
  const all = c.border;
  const b = { l: borderIn(c['border-left'] ?? all), r: borderIn(c['border-right'] ?? all), t: borderIn(c['border-top'] ?? all), b: borderIn(c['border-bottom'] ?? all) };
  s.border = Object.fromEntries(Object.entries(b).filter(([, v]) => v));
  if (c['text-align-source'] !== 'value-type' && p['text-align']) s.h = ALIGN_IN[p['text-align']] ?? 'general';
  s.v = VALIGN_IN[c['vertical-align'] ?? ''] ?? 'bottom';
  if (c['wrap-option'] === 'wrap') s.wrap = true;
  if (c['shrink-to-fit'] === 'true') s.shrink = true;
  const indent = lengthPx(p['margin-left']);
  if (indent && indent > 0) s.indent = Math.max(1, Math.round(indent / 12));
  const angle = Number(c['rotation-angle'] ?? 0) % 360;
  if (angle > 0 && angle <= 90) s.rotate = Math.round(angle);
  else if (angle >= 270) s.rotate = 90 + Math.round(360 - angle);
  return s;
}

/** office:date-value ("2024-01-15T10:30:00") as a serial. */
function dateValue(v: string, date1904: boolean): number | null {
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(v);
  if (!m) return null;
  const day = dateSerial(Number(m[1]), Number(m[2]), Number(m[3]), date1904);
  return day + (m[4] ? timeSerial(Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) : 0);
}

/** office:time-value ("PT12H30M00S") as a fraction of a day (or more, for durations). */
function timeValue(v: string): number | null {
  const m = /^(-)?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(v);
  if (!m) return null;
  const days = Number(m[2] ?? 0) + timeSerial(Number(m[3] ?? 0), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return m[1] ? -days : days;
}

interface ViewSettings {
  active: string | null;
  grid: boolean;
  tables: Map<string, Map<string, string>>;
}

function readSettings(settings: Element | null): ViewSettings {
  const out: ViewSettings = { active: null, grid: true, tables: new Map() };
  const view = kids(settings, 'config-item-set').find((s) => attr(s, 'name') === 'ooo:view-settings');
  const views = kids(view, 'config-item-map-indexed').find((m) => attr(m, 'name') === 'Views');
  const entry = kid(views, 'config-item-map-entry');
  if (!entry) return out;
  for (const item of kids(entry, 'config-item')) {
    if (attr(item, 'name') === 'ActiveTable') out.active = item.textContent;
    if (attr(item, 'name') === 'ShowGrid') out.grid = item.textContent !== 'false';
  }
  const tables = kids(entry, 'config-item-map-named').find((m) => attr(m, 'name') === 'Tables');
  for (const t of kids(tables, 'config-item-map-entry')) {
    const items = new Map<string, string>();
    for (const item of kids(t, 'config-item')) items.set(attr(item, 'name') ?? '', item.textContent ?? '');
    out.tables.set(attr(t, 'name') ?? '', items);
  }
  return out;
}

const LOST: [string, string][] = [
  ['shapes', 'charts, pictures and shapes'],
  ['conditional-formats', 'conditional formatting'],
  ['content-validations', 'data validation'],
  ['data-pilot-tables', 'PivotTables'],
  ['database-ranges', 'filters'],
];

export function readOds(bytes: Uint8Array): Loaded {
  const odf = OdfDocument.read(bytes, 'spreadsheet', 'spreadsheet');
  const styles = contentStyles(odf);
  const body = odf.body('spreadsheet');
  const lost = new Set<string>();
  const nullDate = attr(kid(kid(body, 'calculation-settings'), 'null-date'), 'date-value');
  const date1904 = nullDate === '1904-01-01';
  const baseProps = styles.resolve('table-cell', 'Default');
  const baseFont: Font = { name: styles.fontOf(baseProps.text) ?? 'Liberation Sans', size: Math.round((lengthPt(baseProps.text?.['font-size']) ?? 10) * 100) / 100 };
  const table = new StyleTable(styleFrom(baseProps, formatCodeOf(styleAttr(styles, 'table-cell', 'Default', 'data-style-name'), styles.dataStyles), styles, baseFont));
  const styleIds = new Map<string, number>();
  const styleId = (name: string | null): number | undefined => {
    if (!name || name === 'Default') return undefined;
    let id = styleIds.get(name);
    if (id === undefined) {
      const props = styles.resolve('table-cell', name);
      id = table.id(styleFrom(props, formatCodeOf(styleAttr(styles, 'table-cell', name, 'data-style-name'), styles.dataStyles), styles, baseFont));
      styleIds.set(name, id);
    }
    return id || undefined;
  };
  const settings = readSettings(odf.settings());
  const sheets: Sheet[] = [];
  const names: DefinedName[] = [];
  const readNames = (el: Element | null, sheet: number | null) => {
    for (const n of kids(el)) {
      const name = attr(n, 'name');
      if (!name) continue;
      if (n.localName === 'named-range') {
        const a = attr(n, 'cell-range-address');
        if (a) names.push({ name, formula: addressToExcel(a), sheet });
      } else if (n.localName === 'named-expression') {
        const e = attr(n, 'expression');
        if (e) names.push({ name, formula: formulaFromOdf(e), sheet });
      }
    }
  };

  for (const tbl of kids(body, 'table')) {
    const name = attr(tbl, 'name') ?? `Sheet${sheets.length + 1}`;
    const sheet = newSheet(name);
    const tp = styles.resolve('table', attr(tbl, 'style-name')).table ?? {};
    if (tp.display === 'false') sheet.hidden = true;
    const tab = odfColor(tp['tab-color']);
    if (tab) sheet.tabColor = tab;
    // Page: the orientation and margins of the table's page style.
    const masterName = styleAttr(styles, 'table', attr(tbl, 'style-name'), 'master-page-name') ?? 'Default';
    const master = kids(kid(odf.styles.documentElement, 'master-styles'), 'master-page').find((m) => attr(m, 'name') === masterName);
    const layout = kids(kid(odf.styles.documentElement, 'automatic-styles'), 'page-layout').find((l) => attr(l, 'name') === attr(master, 'page-layout-name'));
    const pp = kid(layout, 'page-layout-properties');
    if (pp) {
      const inches = (a: string, def: number) => {
        const v = lengthPx(attr(pp, a) ?? attr(pp, 'margin'));
        return v === null ? def : Math.round((v / 96) * 100) / 100;
      };
      const m = sheet.page.margins;
      sheet.page = {
        orientation: attr(pp, 'print-orientation') === 'landscape' ? 'landscape' : 'portrait',
        margins: { ...m, left: inches('margin-left', m.left), right: inches('margin-right', m.right), top: inches('margin-top', m.top), bottom: inches('margin-bottom', m.bottom) },
      };
    }

    // Columns.
    const cols = new Map<number, ColInfo>();
    const colDefaults: (number | undefined)[] = [];
    const widthCount = new Map<number, number>();
    let c = 0;
    const readCols = (parent: Element) => {
      for (const col of kids(parent)) {
        if (col.localName !== 'table-column') {
          if (['table-columns', 'table-header-columns', 'table-column-group'].includes(col.localName)) readCols(col);
          continue;
        }
        const n = Math.max(1, Number(attr(col, 'number-columns-repeated') ?? 1) || 1);
        const w = lengthPx(styles.resolve('table-column', attr(col, 'style-name'))['table-column']?.['column-width']);
        const hidden = attr(col, 'visibility') === 'collapse' || attr(col, 'visibility') === 'filter';
        const s = styleId(attr(col, 'default-cell-style-name'));
        const px = w !== null ? Math.round(w) : undefined;
        if (px !== undefined) widthCount.set(px, (widthCount.get(px) ?? 0) + Math.min(n, MAX_COLS));
        for (let k = 0; k < n && c < MAX_COLS; k++, c++) {
          const info: ColInfo = {};
          if (px !== undefined) info.w = px;
          if (hidden) info.hidden = true;
          if (s) info.s = s;
          colDefaults[c] = s;
          if (info.w !== undefined || info.hidden || info.s) cols.set(c, info);
          if (n > 4096 && k > 64 && !hidden && !s) {
            c += n - k;
            break;
          }
        }
      }
    };
    readCols(tbl);
    const commonW = [...widthCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (commonW) {
      sheet.defaultColWidth = commonW;
      for (const [k, info] of cols) {
        if (info.w === commonW) delete info.w;
        if (info.w === undefined && !info.hidden && !info.s) cols.delete(k);
      }
    }
    sheet.cols = cols;

    // Rows and cells.
    const rows = new Map<number, RowInfo>();
    const cells = new Map<number, Cell>();
    const heightCount = new Map<number, number>();
    const merges: Range[] = [];
    let r = 0;
    const readRow = (row: Element) => {
      const n = Math.max(1, Number(attr(row, 'number-rows-repeated') ?? 1) || 1);
      const rp = styles.resolve('table-row', attr(row, 'style-name'))['table-row'] ?? {};
      const h = lengthPx(rp['row-height']);
      const custom = rp['use-optimal-row-height'] === 'false';
      const hidden = attr(row, 'visibility') === 'collapse' || attr(row, 'visibility') === 'filter';
      if (h !== null) heightCount.set(Math.round(h), (heightCount.get(Math.round(h)) ?? 0) + Math.min(n, MAX_ROWS));
      const parsed: { c: number; cell: Cell | null; link: string | null }[] = [];
      let col = 0;
      for (const tc of kids(row)) {
        if (tc.localName !== 'table-cell' && tc.localName !== 'covered-table-cell') continue;
        const repeat = Math.max(1, Number(attr(tc, 'number-columns-repeated') ?? 1) || 1);
        if (tc.localName === 'covered-table-cell') {
          col += repeat;
          continue;
        }
        const { cell, link } = readCell(tc, col);
        if (cell) {
          const cs = Number(attr(tc, 'number-columns-spanned') ?? 1) || 1;
          const rs = Number(attr(tc, 'number-rows-spanned') ?? 1) || 1;
          if ((cs > 1 || rs > 1) && n === 1) merges.push({ r0: r, c0: col, r1: r + rs - 1, c1: col + cs - 1 });
          for (let k = 0; k < Math.min(repeat, MAX_COLS - col); k++) parsed.push({ c: col + k, cell: k === 0 ? cell : { ...cell }, link });
        }
        col += repeat;
        if (col >= MAX_COLS) break;
      }
      const reps = parsed.length ? Math.min(n, 10000) : hidden ? Math.min(n, 100000) : n;
      for (let k = 0; k < reps && r < MAX_ROWS; k++, r++) {
        if (h !== null || hidden) {
          const info: RowInfo = {};
          if (h !== null) info.h = Math.round(h);
          if (custom) info.custom = true;
          if (hidden) info.hidden = true;
          rows.set(r, info);
        }
        for (const p of parsed) {
          if (p.cell) cells.set(cellKey(r, p.c), k === 0 ? p.cell : { ...p.cell });
          if (p.link) sheet.links.set(cellKey(r, p.c), p.link);
        }
        if (!parsed.length && n > 64 && !hidden) {
          r += n - k;
          break;
        }
      }
    };
    const readCell = (tc: Element, col: number): { cell: Cell | null; link: string | null } => {
      const sName = attr(tc, 'style-name');
      const s = sName ? styleId(sName) : colDefaults[col];
      const type = attr(tc, 'value-type');
      const calcType = tc.getAttributeNS(ODF.calcext, 'value-type');
      const formula = attr(tc, 'formula');
      const paras = kids(tc, 'p');
      const text = paras.map(paragraphText).join('\n');
      let v: Scalar = null;
      switch (type) {
        case 'float':
        case 'percentage':
        case 'currency': {
          const n = Number(attr(tc, 'value'));
          v = Number.isFinite(n) ? n : null;
          break;
        }
        case 'date':
          v = dateValue(attr(tc, 'date-value') ?? '', date1904);
          break;
        case 'time':
          v = timeValue(attr(tc, 'time-value') ?? '');
          break;
        case 'boolean':
          v = (attr(tc, 'boolean-value') ?? '') === 'true';
          break;
        case 'string':
          v = attr(tc, 'string-value') ?? text;
          break;
        default:
          if (text) v = text;
      }
      if (calcType === 'error') v = errOf(text) ?? errOf('#N/A');
      const cell: Cell = { v };
      if (s) cell.s = s;
      if (formula) cell.f = formulaFromOdf(formula);
      let link: string | null = null;
      const a = paras.flatMap((p) => Array.from(p.getElementsByTagNameNS(ODF.text, 'a')))[0];
      if (a) {
        const href = a.getAttributeNS(ODF.xlink, 'href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) link = href;
        else if (href.startsWith('#')) link = `#${addressToExcel(href.slice(1))}`;
      }
      if (kids(tc, 'annotation').length) lost.add('comments');
      if (kids(tc).some((e) => e.localName === 'frame' || e.localName === 'custom-shape')) lost.add('charts, pictures and shapes');
      if (cell.v === null && cell.f === undefined && !cell.s) return { cell: null, link };
      return { cell, link };
    };
    const readRows = (parent: Element) => {
      for (const row of kids(parent)) {
        if (row.localName === 'table-row') readRow(row);
        else if (['table-rows', 'table-header-rows', 'table-row-group'].includes(row.localName)) readRows(row);
      }
    };
    readRows(tbl);
    const commonH = [...heightCount].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (commonH) {
      sheet.defaultRowHeight = commonH;
      for (const [k, info] of rows) {
        if (info.h === commonH && !info.custom) delete info.h;
        if (info.h === undefined && !info.hidden) rows.delete(k);
      }
    }
    sheet.rows = rows;
    sheet.cells = cells;
    sheet.merges = merges;
    readNames(kid(tbl, 'named-expressions'), sheets.length);
    for (const [el, what] of LOST) if (kid(tbl, el)) lost.add(what);
    if (attr(tbl, 'protected') === 'true') lost.add('sheet protection');

    // View: frozen panes, zoom, gridlines and the cursor, from settings.xml.
    const v = settings.tables.get(name);
    if (v) {
      const num = (k: string) => Number(v.get(k) ?? 0) || 0;
      if (num('HorizontalSplitMode') === 2 || num('VerticalSplitMode') === 2) {
        sheet.freeze = { cols: num('HorizontalSplitMode') === 2 ? num('HorizontalSplitPosition') : 0, rows: num('VerticalSplitMode') === 2 ? num('VerticalSplitPosition') : 0 };
      }
      const zoom = num('ZoomValue');
      if (zoom) sheet.zoom = Math.max(10, Math.min(400, zoom));
      if (v.get('ShowGrid') === 'false') sheet.gridlines = false;
      const cx = num('CursorPositionX');
      const cy = num('CursorPositionY');
      sheet.sel = { active: { r: cy, c: cx }, ranges: [{ r0: cy, c0: cx, r1: cy, c1: cx }] };
      const top = sheet.freeze.rows ? num('PositionBottom') : num('PositionTop');
      const left = sheet.freeze.cols ? num('PositionRight') : num('PositionLeft');
      sheet.top = { r: top, c: left };
    }
    if (!settings.grid) sheet.gridlines = false;
    sheets.push(sheet);
  }
  if (!sheets.length) throw new Error('The spreadsheet has no sheets.');
  readNames(kid(body, 'named-expressions'), null);
  for (const [el, what] of LOST) if (kid(body, el)) lost.add(what);
  if (odf.hasPrefix('Object ')) lost.add('charts');
  if (odf.hasPrefix('Basic/')) lost.add('macros');
  let active = Math.max(0, sheets.findIndex((s) => s.name === settings.active));
  if (sheets[active].hidden) active = Math.max(0, sheets.findIndex((s) => !s.hidden));
  return { wb: { sheets, active, names, date1904, theme: OFFICE_THEME, styles: table }, lost: [...lost] };
}

// ---- Writing -----------------------------------------------------------------------------------

const ALIGN_OUT: Partial<Record<HAlign, string>> = { left: 'start', center: 'center', right: 'end', justify: 'justify', distributed: 'justify', fill: 'start', centerContinuous: 'center' };
const VALIGN_OUT: Partial<Record<VAlign, string>> = { top: 'top', center: 'middle', bottom: 'bottom', justify: 'middle', distributed: 'middle' };

function borderOut(b: BorderSide | undefined): string {
  if (!b) return 'none';
  const w = { hair: 0.26, thin: 0.74, medium: 1.76, thick: 2.49, double: 2.01, dashed: 0.74, dotted: 0.74, mediumDashed: 1.76, dashDot: 0.74, mediumDashDot: 1.76, dashDotDot: 0.74, mediumDashDotDot: 1.76, slantDashDot: 1.76 }[b.style];
  const css = b.style === 'double' ? 'double' : b.style === 'dotted' ? 'dotted' : /dash/i.test(b.style) ? (/Dot/.test(b.style) ? (/DotDot/.test(b.style) ? 'dash-dot-dot' : 'dash-dot') : 'dashed') : 'solid';
  return `${w}pt ${css} #${b.color}`;
}

function textProps(f: Font, fonts: FontFaces): string {
  const name = fonts.use(f.name);
  return `<style:text-properties${attrs({
    'style:font-name': name,
    'fo:font-size': pt(f.size),
    'style:font-size-asian': pt(f.size),
    'style:font-size-complex': pt(f.size),
    'fo:font-weight': f.bold ? 'bold' : 'normal',
    'style:font-weight-asian': f.bold ? 'bold' : 'normal',
    'style:font-weight-complex': f.bold ? 'bold' : 'normal',
    'fo:font-style': f.italic ? 'italic' : 'normal',
    'style:font-style-asian': f.italic ? 'italic' : 'normal',
    'style:font-style-complex': f.italic ? 'italic' : 'normal',
    'style:text-underline-style': f.underline ? 'solid' : 'none',
    'style:text-underline-type': f.underline?.startsWith('double') ? 'double' : null,
    'style:text-underline-width': f.underline ? 'auto' : null,
    'style:text-underline-color': f.underline ? 'font-color' : null,
    'style:text-line-through-style': f.strike ? 'solid' : 'none',
    'style:text-position': f.vert === 'superscript' ? 'super 58%' : f.vert === 'subscript' ? 'sub 58%' : null,
    'fo:color': `#${f.color ?? '000000'}`,
  })}/>`;
}

class SheetStyles {
  private cell = new Map<number, string>();
  private keyed = new Map<string, string>();
  private dataNames = new Map<string, string | null>();
  private out: string[] = [];
  private data: string[] = [];
  private other = new Map<string, string>();

  constructor(
    private wb: Workbook,
    private fonts: FontFaces,
  ) {}

  dataStyle(code: string): string | null {
    if (this.dataNames.has(code)) return this.dataNames.get(code)!;
    const name = `N${this.dataNames.size + 100}`;
    const xml = dataStylesFor(code, name);
    this.dataNames.set(code, xml ? name : null);
    if (xml) this.data.push(xml);
    return xml ? name : null;
  }

  /** The automatic cell style for a style id ('Default' for the base style). */
  cellStyle(id: number | undefined): string {
    const sid = id ?? 0;
    const hit = this.cell.get(sid);
    if (hit) return hit;
    const s = this.wb.styles.get(sid);
    const data = this.dataStyle(s.numFmt);
    const cellProps = attrs({
      'fo:background-color': s.fill ? `#${s.fill}` : 'transparent',
      'fo:border-left': borderOut(s.border.l),
      'fo:border-right': borderOut(s.border.r),
      'fo:border-top': borderOut(s.border.t),
      'fo:border-bottom': borderOut(s.border.b),
      'style:vertical-align': VALIGN_OUT[s.v] ?? 'bottom',
      'fo:wrap-option': s.wrap ? 'wrap' : 'no-wrap',
      'style:shrink-to-fit': s.shrink ? 'true' : null,
      'style:rotation-angle': s.rotate ? (s.rotate <= 90 ? s.rotate : 360 - (s.rotate - 90)) : null,
      'style:text-align-source': s.h === 'general' ? 'value-type' : 'fix',
      'style:repeat-content': s.h === 'fill' ? 'true' : 'false',
    });
    const para = s.h !== 'general' || s.indent ? `<style:paragraph-properties${attrs({ 'fo:text-align': ALIGN_OUT[s.h] ?? null, 'fo:margin-left': s.indent ? pt(s.indent * 9) : null })}/>` : '';
    const body = `<style:table-cell-properties${cellProps}/>${para}${textProps(s.font, this.fonts)}`;
    const key = `${data}|${body}`;
    let name = this.keyed.get(key);
    if (!name) {
      name = `ce${this.keyed.size + 1}`;
      this.keyed.set(key, name);
      this.out.push(`<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${data ? ` style:data-style-name="${data}"` : ''}>${body}</style:style>`);
    }
    this.cell.set(sid, name);
    return name;
  }

  /** Column, row and table styles, one per distinct look. */
  named(prefix: string, family: string, body: string, extra = ''): string {
    const key = `${family}|${extra}|${body}`;
    let name = this.other.get(key);
    if (!name) {
      name = `${prefix}${[...this.other.keys()].filter((k) => k.startsWith(`${family}|`)).length + 1}`;
      this.other.set(key, name);
    }
    return name;
  }

  xml(): string {
    const others = [...this.other].map(([key, name]) => {
      const [family, extra, ...rest] = key.split('|');
      return `<style:style style:name="${name}" style:family="${family}"${extra}>${rest.join('|')}</style:style>`;
    });
    return this.data.join('') + others.join('') + this.out.join('');
  }
}

function isoDate(serial: number, date1904: boolean, withTime: boolean): string {
  const p = serialParts(serial, date1904);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  return withTime ? `${date}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${p.ms ? `.${pad(p.ms, 3)}` : ''}` : date;
}

function isoDuration(days: number): string {
  const neg = days < 0;
  let ms = Math.round(Math.abs(days) * 86400000);
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = ms / 1000;
  return `${neg ? '-' : ''}PT${h}H${String(m).padStart(2, '0')}M${s < 10 ? '0' : ''}${s}S`;
}

function linkHref(link: string): string {
  if (!link.startsWith('#')) return link;
  const toks = tokenize(link.slice(1)).filter((t) => t.type === 'ref');
  return toks[0]?.ref ? `#${refToOdfAddress(toks[0].ref).replace(/^\$/, '')}` : link;
}

function cellXml(cell: Cell, value: Scalar, wb: Workbook, styles: SheetStyles, link: string | undefined, span: string): string {
  const style = cell.s ? ` table:style-name="${styles.cellStyle(cell.s)}"` : '';
  const formula = cell.f !== undefined ? ` table:formula="${esc(formulaToOdf(cell.f))}"` : '';
  const v = cell.f !== undefined ? value : cell.v;
  const fmt = wb.styles.get(cell.s).numFmt;
  let typed: string;
  let shown = '';
  if (v === null) {
    if (!formula) return `<table:table-cell${style}${span}/>`;
    typed = ' office:value-type="string" office:string-value="" calcext:value-type="string"';
  } else if (typeof v === 'number') {
    shown = formatValue(v, fmt, wb.date1904).text;
    if (isDateFormat(fmt)) {
      const timeOnly = Math.abs(v) < 1 && !/[yd]|(?<![hH:])m(?!m*[: ]*s)/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]/g, ''));
      typed = timeOnly
        ? ` office:value-type="time" office:time-value="${isoDuration(v)}" calcext:value-type="time"`
        : ` office:value-type="date" office:date-value="${isoDate(v, wb.date1904, Math.round((v % 1) * 86400000) !== 0)}" calcext:value-type="date"`;
    } else if (/%/.test(fmt.replace(/"[^"]*"/g, ''))) typed = ` office:value-type="percentage" office:value="${v}" calcext:value-type="percentage"`;
    else typed = ` office:value-type="float" office:value="${v}" calcext:value-type="float"`;
  } else if (typeof v === 'boolean') {
    shown = v ? 'TRUE' : 'FALSE';
    typed = ` office:value-type="boolean" office:boolean-value="${v}" calcext:value-type="boolean"`;
  } else if (v instanceof CellError) {
    shown = v.code;
    typed = ' office:value-type="string" office:string-value="" calcext:value-type="error"';
  } else {
    shown = v;
    typed = formula ? ` office:value-type="string" office:string-value="${esc(v)}" calcext:value-type="string"` : ' office:value-type="string" calcext:value-type="string"';
  }
  const paras = shown.split('\n').map((line, i) => {
    const t = textXml(line);
    return `<text:p>${link && i === 0 ? `<text:a xlink:href="${esc(linkHref(link))}" xlink:type="simple">${t}</text:a>` : t}</text:p>`;
  });
  return `<table:table-cell${style}${formula}${typed}${span}>${paras.join('')}</table:table-cell>`;
}

const LETTER_IN = { w: 816, h: 1056 };
/** Columns written out for every sheet, so the default width covers what LibreOffice shows. */
const COLS_WRITTEN = 1024;

function sheetXml(sheet: Sheet, si: number, wb: Workbook, value: (r: number, c: number, cell: Cell) => Scalar, styles: SheetStyles, masterFor: (s: Sheet) => string): string {
  const ext = sheetExtent(sheet);
  const mergeAt = new Map<number, Range>();
  const covered = new Set<number>();
  let maxRow = ext.rows;
  let maxCol = ext.cols;
  for (const m of sheet.merges) {
    mergeAt.set(cellKey(m.r0, m.c0), m);
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(cellKey(r, c));
    maxRow = Math.max(maxRow, m.r1);
    maxCol = Math.max(maxCol, m.c1);
  }
  for (const k of sheet.cols.keys()) if (k < COLS_WRITTEN) maxCol = Math.max(maxCol, k);
  for (const k of sheet.rows.keys()) maxRow = Math.max(maxRow, k);
  for (const k of sheet.links.keys()) {
    maxRow = Math.max(maxRow, keyRow(k));
    maxCol = Math.max(maxCol, keyCol(k));
  }

  const tableStyle = styles.named(
    'ta',
    'table',
    `<style:table-properties${attrs({ 'table:display': sheet.hidden ? 'false' : 'true', 'style:writing-mode': 'lr-tb', 'tableooo:tab-color': sheet.tabColor ? `#${sheet.tabColor}` : null })}/>`,
    ` style:master-page-name="${masterFor(sheet)}"`,
  );
  const colStyle = (w: number) => styles.named('co', 'table-column', `<style:table-column-properties fo:break-before="auto" style:column-width="${inch(w)}"/>`);
  const rowStyle = (h: number, custom: boolean) => styles.named('ro', 'table-row', `<style:table-row-properties style:row-height="${inch(h)}" fo:break-before="auto" style:use-optimal-row-height="${custom ? 'false' : 'true'}"/>`);

  // Columns, runs of the same settings written once.
  const colXml: string[] = [];
  const total = Math.max(COLS_WRITTEN, maxCol + 1);
  for (let c = 0; c < total; ) {
    const info = sheet.cols.get(c);
    const key = JSON.stringify(info ?? null);
    let n = 1;
    while (c + n < total && JSON.stringify(sheet.cols.get(c + n) ?? null) === key) n++;
    colXml.push(
      `<table:table-column${attrs({
        'table:style-name': colStyle(info?.w ?? sheet.defaultColWidth),
        'table:number-columns-repeated': n > 1 ? n : null,
        'table:visibility': info?.hidden ? 'collapse' : null,
        'table:default-cell-style-name': info?.s ? styles.cellStyle(info.s) : 'Default',
      })}/>`,
    );
    c += n;
  }

  // Rows.
  const byRow = new Map<number, number[]>();
  for (const k of sheet.cells.keys()) {
    const r = keyRow(k);
    let list = byRow.get(r);
    if (!list) byRow.set(r, (list = []));
    list.push(keyCol(k));
  }
  for (const k of sheet.links.keys()) {
    const r = keyRow(k);
    let list = byRow.get(r);
    if (!list) byRow.set(r, (list = []));
    if (!list.includes(keyCol(k))) list.push(keyCol(k));
  }
  for (const k of covered) {
    const r = keyRow(k);
    if (!byRow.has(r)) byRow.set(r, []);
  }
  const rowXml: string[] = [];
  const emptyRow = (n: number) =>
    `<table:table-row table:style-name="${rowStyle(sheet.defaultRowHeight, false)}"${n > 1 ? ` table:number-rows-repeated="${n}"` : ''}><table:table-cell table:number-columns-repeated="${total}"/></table:table-row>`;
  let blank = 0;
  for (let r = 0; r <= maxRow; r++) {
    const info = sheet.rows.get(r);
    const colsHere = byRow.get(r);
    if (!colsHere && !info) {
      blank++;
      continue;
    }
    if (blank) rowXml.push(emptyRow(blank));
    blank = 0;
    const lastCol = Math.max(-1, ...(colsHere ?? []), ...[...covered].filter((k) => keyRow(k) === r).map(keyCol));
    let cellsXml = '';
    let gap = 0;
    for (let c = 0; c <= lastCol; c++) {
      const k = cellKey(r, c);
      if (covered.has(k)) {
        if (gap) cellsXml += `<table:table-cell${gap > 1 ? ` table:number-columns-repeated="${gap}"` : ''}/>`;
        gap = 0;
        cellsXml += '<table:covered-table-cell/>';
        continue;
      }
      const cell = sheet.cells.get(k);
      const link = sheet.links.get(k);
      const m = mergeAt.get(k);
      if (!cell && !link && !m) {
        gap++;
        continue;
      }
      if (gap) cellsXml += `<table:table-cell${gap > 1 ? ` table:number-columns-repeated="${gap}"` : ''}/>`;
      gap = 0;
      const span = m ? attrs({ 'table:number-columns-spanned': m.c1 - m.c0 + 1, 'table:number-rows-spanned': m.r1 - m.r0 + 1 }) : '';
      cellsXml += cellXml(cell ?? { v: null }, cell ? value(r, c, cell) : null, wb, styles, link, span);
    }
    const rest = total - (lastCol + 1);
    if (rest > 0) cellsXml += `<table:table-cell table:number-columns-repeated="${rest}"/>`;
    rowXml.push(
      `<table:table-row${attrs({
        'table:style-name': rowStyle(info?.h ?? sheet.defaultRowHeight, !!info?.custom),
        'table:visibility': info?.hidden ? 'collapse' : null,
      })}>${cellsXml}</table:table-row>`,
    );
  }
  const remaining = MAX_ROWS - (maxRow + 1);
  if (remaining > 0) rowXml.push(emptyRow(remaining));
  const names = wb.names.filter((n) => n.sheet === si);
  return `<table:table table:name="${esc(sheet.name)}" table:style-name="${tableStyle}">${colXml.join('')}${rowXml.join('')}${names.length ? `<table:named-expressions>${names.map(nameXml).join('')}</table:named-expressions>` : ''}</table:table>`;
}

function nameXml(n: DefinedName): string {
  if (n.name.startsWith('_xlnm.')) return '';
  const toks = tokenize(n.formula).filter((t) => t.type !== 'ws');
  if (toks.length === 1 && toks[0].type === 'ref' && toks[0].ref?.sheet) {
    const ref = toks[0].ref;
    const a = refToOdfAddress(ref);
    const base = refToOdfAddress({ ...ref, kind: 'cell', r1: ref.r0, c1: ref.c0, ar0: true, ac0: true });
    return `<table:named-range table:name="${esc(n.name)}" table:base-cell-address="${esc(base)}" table:cell-range-address="${esc(a)}"/>`;
  }
  return `<table:named-expression table:name="${esc(n.name)}" table:base-cell-address="$Sheet1.$A$1" table:expression="${esc(formulaToOdf(n.formula))}"/>`;
}

function settingsXml(wb: Workbook): string {
  const item = (name: string, type: string, v: string | number | boolean) => `<config:config-item config:name="${name}" config:type="${type}">${esc(String(v))}</config:config-item>`;
  const tables = wb.sheets
    .map((s) => {
      const f = s.freeze;
      return (
        `<config:config-item-map-entry config:name="${esc(s.name)}">` +
        item('CursorPositionX', 'int', s.sel.active.c) +
        item('CursorPositionY', 'int', s.sel.active.r) +
        item('HorizontalSplitMode', 'short', f.cols ? 2 : 0) +
        item('VerticalSplitMode', 'short', f.rows ? 2 : 0) +
        item('HorizontalSplitPosition', 'int', f.cols) +
        item('VerticalSplitPosition', 'int', f.rows) +
        item('ActiveSplitRange', 'short', f.rows ? 2 : f.cols ? 3 : 2) +
        item('PositionLeft', 'int', f.cols ? 0 : s.top.c) +
        item('PositionRight', 'int', f.cols ? Math.max(f.cols, s.top.c) : 0) +
        item('PositionTop', 'int', f.rows ? 0 : s.top.r) +
        item('PositionBottom', 'int', f.rows ? Math.max(f.rows, s.top.r) : 0) +
        item('ZoomType', 'short', 0) +
        item('ZoomValue', 'int', Math.round(s.zoom)) +
        item('PageViewZoomValue', 'int', 60) +
        item('ShowGrid', 'boolean', s.gridlines) +
        '</config:config-item-map-entry>'
      );
    })
    .join('');
  const active = wb.sheets[wb.active]?.name ?? wb.sheets[0].name;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-settings ${ODF_NS_DECLS} office:version="${ODF_VERSION}"><office:settings>` +
    '<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
    item('ViewId', 'string', 'view1') +
    `<config:config-item-map-named config:name="Tables">${tables}</config:config-item-map-named>` +
    item('ActiveTable', 'string', active) +
    item('ShowGrid', 'boolean', true) +
    item('HasColumnRowHeaders', 'boolean', wb.sheets[wb.active]?.headings ?? true) +
    '</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>'
  );
}

/** The workbook as .ods bytes (or .ots, .fods by `ext`). `value` gives each formula's computed value. */
export function writeOds(wb: Workbook, value: (sheet: number, r: number, c: number, cell: Cell) => Scalar, ext = 'ods'): Uint8Array {
  const fonts = new FontFaces();
  const styles = new SheetStyles(wb, fonts);
  const pages = new Map<string, string>();
  const layouts: string[] = [];
  const masters: string[] = [];
  const masterFor = (s: Sheet) => {
    const key = JSON.stringify(s.page);
    let name = pages.get(key);
    if (!name) {
      name = pages.size ? `Din_20_Page_20_${pages.size + 1}` : 'Default';
      const land = s.page.orientation === 'landscape';
      const m = s.page.margins;
      const layout = `pm${pages.size + 1}`;
      layouts.push(
        `<style:page-layout style:name="${layout}"><style:page-layout-properties${attrs({
          'fo:page-width': inch(land ? LETTER_IN.h : LETTER_IN.w),
          'fo:page-height': inch(land ? LETTER_IN.w : LETTER_IN.h),
          'style:print-orientation': land ? 'landscape' : 'portrait',
          'fo:margin-top': `${m.top}in`,
          'fo:margin-bottom': `${m.bottom}in`,
          'fo:margin-left': `${m.left}in`,
          'fo:margin-right': `${m.right}in`,
          'style:writing-mode': 'lr-tb',
        })}/><style:header-style/><style:footer-style/></style:page-layout>`,
      );
      masters.push(`<style:master-page style:name="${name}"${name !== 'Default' ? ` style:display-name="Din Page ${pages.size + 1}"` : ''} style:page-layout-name="${layout}"/>`);
      pages.set(key, name);
    }
    return name;
  };
  const tables = wb.sheets.map((sheet, i) => sheetXml(sheet, i, wb, (r, c, cell) => value(i, r, c, cell), styles, masterFor)).join('');
  const globalNames = wb.names.filter((n) => n.sheet === null).map(nameXml).join('');
  const base = wb.styles.base;
  const baseData = dataStylesFor(base.numFmt, 'N99');
  const defaults =
    `<style:default-style style:family="table-cell"><style:paragraph-properties style:tab-stop-distance="0.5in"/>${textProps(base.font, fonts)}</style:default-style>` +
    `<style:style style:name="Default" style:family="table-cell"${baseData ? ' style:data-style-name="N99"' : ''}>${textProps(base.font, fonts)}</style:style>`;
  const body =
    (wb.date1904 ? '<table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>' : '') +
    tables +
    (globalNames ? `<table:named-expressions>${globalNames}</table:named-expressions>` : '');
  const autoStyles = styles.xml();
  const stylesXml = odfRoot(
    'office:document-styles',
    `${fonts.xml()}<office:styles>${baseData ?? ''}${defaults}</office:styles><office:automatic-styles>${layouts.join('')}</office:automatic-styles><office:master-styles>${masters.join('')}</office:master-styles>`,
  );
  const contentXml = odfRoot('office:document-content', `${fonts.xml()}<office:automatic-styles>${autoStyles}</office:automatic-styles><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body>`);
  return writeOdf({
    mimetype: ext === 'ots' ? ODF_MIME.spreadsheetTemplate : ODF_MIME.spreadsheet,
    content: contentXml,
    styles: stylesXml,
    settings: settingsXml(wb),
    generator: 'Din Spreadsheet',
    flat: ext === 'fods',
  });
}

