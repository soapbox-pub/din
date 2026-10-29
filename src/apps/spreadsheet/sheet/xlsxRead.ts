import { attr, isOle, isZip, kid, kids, numAttr, OpcPackage, REL, rid, serialize } from '@/shared/office/ooxml';
import { parseTheme, tintColor, type Theme } from '@/shared/office/theme';
import { cellKey, parseCell, parseRange, type Range } from './addr';
import { stripPrefixes, translateFormula } from './formula';
import {
  defaultStyle,
  newSheet,
  ptToPx,
  StyleTable,
  widthToPx,
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
import { BUILTIN_FORMATS, INDEXED_COLORS } from './numfmt';
import { errOf, type Scalar } from './values';
import type { ScanReply } from './xlsxRead.worker';
import {
  CELL_FIELDS,
  F_ARRAY,
  F_DATA_TABLE,
  F_SHARED,
  K_BOOL,
  K_ERR,
  K_NUM,
  K_SHARED,
  K_STR,
  ROW_CUSTOM_FORMAT,
  ROW_CUSTOM_HEIGHT,
  ROW_FIELDS,
  ROW_HIDDEN,
  type ScannedSheet,
} from './xlsxScan';

/**
 * Reading .xlsx: the workbook's sheets, cells (shared strings, shared
 * formulas expanded, cached values), styles resolved against the theme,
 * column widths, row heights, merges, freeze panes and defined names.
 * What the app doesn't model is listed so the user can be told it won't be kept.
 */

export interface Loaded {
  wb: Workbook;
  /** Features in the file that saving won't keep ("charts", "comments"...). */
  lost: string[];
}

const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const;

/** A SpreadsheetML <color>: rgb (ARGB), theme + tint, indexed, or auto. */
export function colorOf(el: Element | null, theme: Theme, fallback: string | null = null): string | null {
  if (!el) return fallback;
  if (attr(el, 'auto') === '1' || attr(el, 'auto') === 'true') return fallback;
  let hex: string | null = null;
  const rgb = attr(el, 'rgb');
  const th = numAttr(el, 'theme');
  const ix = numAttr(el, 'indexed');
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) hex = rgb.slice(-6).toUpperCase();
  else if (th !== null) hex = theme.colors[THEME_ORDER[th] ?? 'dk1'];
  else if (ix !== null) {
    if (ix === 64) return fallback;
    if (ix === 65) hex = 'FFFFFF';
    else hex = INDEXED_COLORS[ix] ?? null;
  }
  if (!hex) return fallback;
  const tint = numAttr(el, 'tint');
  return tint ? tintColor(hex, tint) : hex;
}

const BORDER_STYLES = new Set<string>(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair', 'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot']);

function readStyles(doc: Document | null, theme: Theme): { table: StyleTable; xfs: number[] } {
  if (!doc) return { table: new StyleTable(), xfs: [0] };
  const root = doc.documentElement;
  const numFmts = new Map<number, string>();
  for (const nf of kids(kid(root, 'numFmts'), 'numFmt')) numFmts.set(numAttr(nf, 'numFmtId') ?? -1, attr(nf, 'formatCode') ?? 'General');
  const fonts: Font[] = kids(kid(root, 'fonts'), 'font').map((f) => {
    const font: Font = {
      name: attr(kid(f, 'name'), 'val') ?? 'Calibri',
      size: numAttr(kid(f, 'sz'), 'val') ?? 11,
    };
    const flag = (n: string) => {
      const e = kid(f, n);
      if (!e) return false;
      const v = attr(e, 'val');
      return v === null || v === '1' || v === 'true';
    };
    if (flag('b')) font.bold = true;
    if (flag('i')) font.italic = true;
    if (flag('strike')) font.strike = true;
    const u = kid(f, 'u');
    if (u) {
      const v = attr(u, 'val') ?? 'single';
      if (v !== 'none') font.underline = v as Font['underline'];
    }
    const va = attr(kid(f, 'vertAlign'), 'val');
    if (va === 'superscript' || va === 'subscript') font.vert = va;
    const color = colorOf(kid(f, 'color'), theme);
    if (color && color !== '000000') font.color = color;
    return font;
  });
  const fills = kids(kid(root, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    if (p) {
      const type = attr(p, 'patternType') ?? 'none';
      if (type === 'none' || type === 'gray125' && !kid(p, 'fgColor')) return { fill: null as string | null, pattern: undefined };
      const fg = colorOf(kid(p, 'fgColor'), theme, type === 'solid' ? '000000' : null);
      const bg = colorOf(kid(p, 'bgColor'), theme, null);
      if (type === 'solid') return { fill: fg, pattern: undefined };
      return { fill: null, pattern: { type, fg, bg } };
    }
    const g = kid(f, 'gradientFill');
    if (g) {
      // Gradients show as their first stop.
      const stop = kids(g, 'stop')[0];
      return { fill: colorOf(kid(stop, 'color'), theme), pattern: undefined };
    }
    return { fill: null, pattern: undefined };
  });
  const borders = kids(kid(root, 'borders'), 'border').map((b) => {
    const side = (n: string): BorderSide | undefined => {
      const e = kid(b, n);
      const st = attr(e, 'style');
      if (!e || !st || !BORDER_STYLES.has(st)) return undefined;
      return { style: st as BorderStyle, color: colorOf(kid(e, 'color'), theme, '000000') ?? '000000' };
    };
    return { l: side('left') ?? side('start'), r: side('right') ?? side('end'), t: side('top'), b: side('bottom') };
  });
  const xfEls = kids(kid(root, 'cellXfs'), 'xf');
  const styleOf = (xf: Element | undefined): Style => {
    const base = defaultStyle(fonts[0] ?? { name: 'Calibri', size: 11 });
    if (!xf) return base;
    const id = numAttr(xf, 'numFmtId') ?? 0;
    const fill = fills[numAttr(xf, 'fillId') ?? 0];
    const border = borders[numAttr(xf, 'borderId') ?? 0];
    const al = kid(xf, 'alignment');
    const s: Style = {
      numFmt: numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? 'General',
      font: fonts[numAttr(xf, 'fontId') ?? 0] ?? base.font,
      fill: fill?.fill ?? null,
      border: border ? Object.fromEntries(Object.entries(border).filter(([, v]) => v)) : {},
      h: (attr(al, 'horizontal') as HAlign | null) ?? 'general',
      v: (attr(al, 'vertical') as VAlign | null) ?? 'bottom',
    };
    if (fill?.pattern) s.pattern = fill.pattern;
    if (al) {
      const wrap = attr(al, 'wrapText');
      if (wrap === '1' || wrap === 'true') s.wrap = true;
      const indent = numAttr(al, 'indent');
      if (indent) s.indent = indent;
      const rot = numAttr(al, 'textRotation');
      if (rot) s.rotate = rot;
      const shrink = attr(al, 'shrinkToFit');
      if (shrink === '1' || shrink === 'true') s.shrink = true;
    }
    if (s.numFmt.toLowerCase() === 'general') s.numFmt = 'General';
    return s;
  };
  const table = new StyleTable(styleOf(xfEls[0]));
  const xfs = xfEls.map((xf) => table.id(styleOf(xf)));
  if (!xfs.length) xfs.push(0);
  return { table, xfs };
}

/** Cells and row properties from a scanned <sheetData>, a slice at a time so the desktop keeps running. */
async function buildCells(scan: ScannedSheet | null, strings: string[], xfs: number[], defaultRowHeight: number, lost: Set<string>) {
  const rows = new Map<number, RowInfo>();
  const cells = new Map<number, Cell>();
  if (!scan) return { rows, cells };
  const R = scan.rows;
  for (let i = 0; i < R.length; i += ROW_FIELDS) {
    const r = R[i];
    const ht = R[i + 1];
    const flags = R[i + 2];
    const s = R[i + 3];
    const info: RowInfo = {};
    const custom = (flags & ROW_CUSTOM_HEIGHT) !== 0;
    if (!Number.isNaN(ht) && (custom || ptToPx(ht) !== defaultRowHeight)) info.h = ptToPx(ht);
    if (custom) info.custom = true;
    if (flags & ROW_HIDDEN) info.hidden = true;
    if (flags & ROW_CUSTOM_FORMAT && s) info.s = xfs[s] ?? 0;
    if (info.h !== undefined || info.hidden || info.s) rows.set(r, info);
  }
  const shared = new Map<string, { f: string; r: number; c: number }>();
  const pendingShared: { key: number; si: string; r: number; c: number }[] = [];
  const C = scan.cells;
  const n = C.length / CELL_FIELDS;
  let fi = 0;
  let sliceStart = performance.now();
  for (let i = 0; i < n; i++) {
    if ((i & 4095) === 0 && performance.now() - sliceStart > SLICE_MS) {
      await nextTask();
      sliceStart = performance.now();
    }
    const o = i * CELL_FIELDS;
    const r = C[o];
    const col = C[o + 1];
    const sIdx = C[o + 2];
    const kind = C[o + 3];
    const val = C[o + 4];
    let v: Scalar = null;
    if (kind === K_NUM) v = scan.nums[val];
    else if (kind === K_STR) v = scan.strs[val];
    else if (kind === K_SHARED) v = strings[val] ?? '';
    else if (kind === K_BOOL) v = val === 1;
    else if (kind === K_ERR) v = errOf(scan.strs[val]) ?? errOf('#N/A');
    const cell: Cell = { v };
    if (sIdx > 0) cell.s = xfs[sIdx] ?? 0;
    if (scan.fCell[fi] === i) {
      const ft = scan.fType[fi];
      const text = scan.fText[fi];
      const key = cellKey(r, col);
      if (ft === F_SHARED) {
        const si = scan.fSi[fi];
        if (text) {
          shared.set(si, { f: stripPrefixes(text), r, c: col });
          cell.f = stripPrefixes(text);
        } else pendingShared.push({ key, si, r, c: col });
      } else if (ft === F_DATA_TABLE) {
        // What-if data tables keep their values.
      } else if (text) {
        cell.f = stripPrefixes(text);
        if (ft === F_ARRAY) lost.add('array formulas (they’re kept as ordinary formulas)');
      }
      fi++;
    }
    if (cell.v === null && cell.f === undefined && !cell.s) continue;
    cells.set(cellKey(r, col), cell);
  }
  for (const p of pendingShared) {
    const m = shared.get(p.si);
    const cell = cells.get(p.key);
    if (m && cell) cell.f = translateFormula(m.f, p.r - m.r, p.c - m.c);
  }
  return { rows, cells };
}

const SLICE_MS = 12;

const nextTask = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });

/** Unzip the package and scan its cells in a worker of its own. */
function scanPackage(bytes: Uint8Array): Promise<Extract<ScanReply, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsxRead.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ScanReply>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The workbook couldn’t be read.'));
    };
    const copy = bytes.slice().buffer;
    worker.postMessage({ bytes: copy }, [copy]);
  });
}

const LOST_ELEMENTS: Record<string, string> = {
  drawing: 'charts, pictures and shapes',
  legacyDrawing: 'comments and notes',
  tableParts: 'tables',
  autoFilter: 'filters',
  sheetProtection: 'sheet protection',
  sortState: 'sort settings',
};

async function readSheet(doc: Document, scan: ScannedSheet | null, name: string, strings: string[], xfs: number[], theme: Theme, lost: Set<string>): Promise<Sheet> {
  const root = doc.documentElement;
  const sheet = newSheet(name);
  // Sheet properties: tab color.
  const pr = kid(root, 'sheetPr');
  const tab = colorOf(kid(pr, 'tabColor'), theme);
  if (tab) sheet.tabColor = tab;
  // Views: gridlines, headings, zoom, freeze panes, selection.
  const view = kid(kid(root, 'sheetViews'), 'sheetView');
  if (view) {
    if (attr(view, 'showGridLines') === '0' || attr(view, 'showGridLines') === 'false') sheet.gridlines = false;
    if (attr(view, 'showRowColHeaders') === '0' || attr(view, 'showRowColHeaders') === 'false') sheet.headings = false;
    const zoom = numAttr(view, 'zoomScale');
    if (zoom) sheet.zoom = Math.max(10, Math.min(400, zoom));
    const pane = kid(view, 'pane');
    const state = attr(pane, 'state');
    if (pane && (state === 'frozen' || state === 'frozenSplit')) {
      sheet.freeze = { cols: Math.round(numAttr(pane, 'xSplit') ?? 0), rows: Math.round(numAttr(pane, 'ySplit') ?? 0) };
      const tl = parseCell(attr(pane, 'topLeftCell') ?? '');
      if (tl) sheet.top = { r: tl.r, c: tl.c };
    } else {
      const tl = parseCell(attr(view, 'topLeftCell') ?? '');
      if (tl) sheet.top = { r: tl.r, c: tl.c };
    }
    const sels = kids(view, 'selection');
    const sel = sels.find((s) => attr(s, 'pane') === attr(pane, 'activePane')) ?? sels[sels.length - 1];
    const ac = parseCell(attr(sel, 'activeCell') ?? '');
    if (ac) {
      const ranges = (attr(sel, 'sqref') ?? '').split(/\s+/).map(parseRange).filter((g): g is Range => !!g);
      sheet.sel = { active: { r: ac.r, c: ac.c }, ranges: ranges.length ? ranges : [{ r0: ac.r, c0: ac.c, r1: ac.r, c1: ac.c }] };
    }
  }
  const fmt = kid(root, 'sheetFormatPr');
  const dcw = numAttr(fmt, 'defaultColWidth');
  const bcw = numAttr(fmt, 'baseColWidth') ?? 8;
  sheet.defaultColWidth = dcw !== null ? widthToPx(dcw) : Math.ceil((bcw * 7 + 5) / 8) * 8;
  const drh = numAttr(fmt, 'defaultRowHeight');
  if (drh) sheet.defaultRowHeight = ptToPx(drh);
  // Columns.
  const cols = new Map<number, ColInfo>();
  for (const col of kids(kid(root, 'cols'), 'col')) {
    const min = (numAttr(col, 'min') ?? 1) - 1;
    const max = Math.min((numAttr(col, 'max') ?? min + 1) - 1, 16383);
    const w = numAttr(col, 'width');
    const hidden = attr(col, 'hidden') === '1' || attr(col, 'hidden') === 'true';
    const style = numAttr(col, 'style');
    const info: ColInfo = {};
    if (w !== null && (attr(col, 'customWidth') !== null || Math.abs(widthToPx(w) - sheet.defaultColWidth) > 0)) info.w = widthToPx(w);
    if (hidden) info.hidden = true;
    if (style) info.s = xfs[style] ?? 0;
    if (!info.w && !info.hidden && !info.s) continue;
    // A style over every column (max=16384) is common; keep it, the axis copes.
    for (let c = min; c <= max; c++) cols.set(c, info);
  }
  sheet.cols = cols;
  const { rows, cells } = await buildCells(scan, strings, xfs, sheet.defaultRowHeight, lost);
  sheet.rows = rows;
  sheet.cells = cells;
  sheet.merges = kids(kid(root, 'mergeCells'), 'mergeCell')
    .map((m) => parseRange(attr(m, 'ref') ?? ''))
    .filter((g): g is Range => !!g);
  const ps = kid(root, 'pageSetup');
  if (attr(ps, 'orientation') === 'landscape') sheet.page = { ...sheet.page, orientation: 'landscape' };
  const pm = kid(root, 'pageMargins');
  if (pm) {
    const m = { ...sheet.page.margins };
    for (const k of ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const) {
      const v = numAttr(pm, k);
      if (v !== null) m[k] = v;
    }
    sheet.page = { ...sheet.page, margins: m };
  }
  const cf = kids(root, 'conditionalFormatting').map(serialize);
  const dv = kid(root, 'dataValidations');
  if (cf.length || dv) sheet.kept = { cf, dv: dv ? serialize(dv) : null };
  for (const el of kids(root)) {
    const what = LOST_ELEMENTS[el.localName];
    if (what) lost.add(what);
    if (el.localName === 'extLst' && el.textContent && /sparkline/i.test(new XMLSerializer().serializeToString(el))) lost.add('sparklines');
  }
  return sheet;
}

export async function readXlsx(bytes: Uint8Array): Promise<Loaded> {
  if (isOle(bytes)) throw new Error('This is an Excel 97–2003 workbook (.xls). Open it in Excel or LibreOffice and save it as .xlsx first.');
  if (!isZip(bytes)) throw new Error('It isn’t an Excel workbook.');
  const scanned = await scanPackage(bytes);
  const pkg = new OpcPackage();
  pkg.files = scanned.files;
  const main = pkg.mainPart();
  if (!main) throw new Error('It isn’t an Excel workbook (there’s no workbook part).');
  const wbDoc = pkg.xml(main);
  if (!wbDoc || wbDoc.documentElement.localName !== 'workbook') throw new Error('It isn’t an Excel workbook.');
  const rels = pkg.rels(main);
  const themeRel = rels.find((r) => r.type === REL.theme);
  const theme = parseTheme(themeRel ? pkg.xml(themeRel.target) : null);
  const stylesRel = rels.find((r) => r.type === REL.styles);
  const { table, xfs } = readStyles(stylesRel ? pkg.xml(stylesRel.target) : null, theme);
  const ssRel = rels.find((r) => r.type === REL.sharedStrings);
  const strings = (ssRel && scanned.strings[ssRel.target]) || [];
  const root = wbDoc.documentElement;
  const date1904 = ['1', 'true'].includes(attr(kid(root, 'workbookPr'), 'date1904') ?? '');
  const lost = new Set<string>();
  const sheets: Sheet[] = [];
  const sheetEls = kids(kid(root, 'sheets'), 'sheet');
  const sheetMap: number[] = [];
  for (const el of sheetEls) {
    const name = attr(el, 'name') ?? `Sheet${sheets.length + 1}`;
    const rel = rels.find((r) => r.id === rid(el));
    if (!rel || rel.type !== REL.worksheet) {
      // Chart sheets and macro sheets aren't kept.
      lost.add('chart sheets');
      sheetMap.push(-1);
      continue;
    }
    const doc = pkg.xml(rel.target);
    if (!doc) continue;
    const sheet = await readSheet(doc, scanned.sheets[rel.target] ?? null, name, strings, xfs, theme, lost);
    const sheetRels = pkg.rels(rel.target);
    for (const h of kids(kid(doc.documentElement, 'hyperlinks'), 'hyperlink')) {
      const g = parseRange(attr(h, 'ref') ?? '');
      if (!g) continue;
      const id = rid(h);
      const target = id ? sheetRels.find((x) => x.id === id && x.external)?.target : null;
      const location = attr(h, 'location');
      const link = target ? target + (location ? `#${location}` : '') : location ? `#${location}` : null;
      if (link) for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 1000); r++) for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 100); c++) sheet.links.set(cellKey(r, c), link);
    }
    const state = attr(el, 'state');
    if (state === 'hidden' || state === 'veryHidden') sheet.hidden = true;
    sheetMap.push(sheets.length);
    sheets.push(sheet);
    if (pkg.rels(rel.target).some((r) => /pivotTable/.test(r.type))) lost.add('PivotTables');
  }
  if (!sheets.length) throw new Error('The workbook has no worksheets.');
  const names: DefinedName[] = [];
  for (const dn of kids(kid(root, 'definedNames'), 'definedName')) {
    const name = attr(dn, 'name');
    const formula = dn.textContent ?? '';
    if (!name || !formula) continue;
    const local = numAttr(dn, 'localSheetId');
    const sheet = local !== null ? (sheetMap[local] ?? -1) : null;
    if (sheet === -1) continue;
    names.push({ name, formula: stripPrefixes(formula), sheet, hidden: attr(dn, 'hidden') === '1' || name.startsWith('_xlnm.') || undefined });
  }
  if (pkg.files.has('xl/vbaProject.bin')) lost.add('macros');
  if ([...pkg.files.keys()].some((p) => p.startsWith('xl/pivotTables/'))) lost.add('PivotTables');
  if ([...pkg.files.keys()].some((p) => p.startsWith('xl/charts/')) && !lost.has('charts, pictures and shapes')) lost.add('charts');
  const tabIndex = numAttr(kid(kid(root, 'bookViews'), 'workbookView'), 'activeTab') ?? 0;
  let active = Math.max(0, Math.min(sheets.length - 1, sheetMap[tabIndex] ?? 0));
  if (sheets[active].hidden) active = Math.max(0, sheets.findIndex((s) => !s.hidden));
  const dxfs = stylesRel ? kid(pkg.xml(stylesRel.target)?.documentElement, 'dxfs') : null;
  const wb: Workbook = { sheets, active, names, date1904, theme, styles: table };
  if (dxfs && kids(dxfs, 'dxf').length) wb.dxfs = serialize(dxfs);
  return { wb, lost: [...lost] };
}
