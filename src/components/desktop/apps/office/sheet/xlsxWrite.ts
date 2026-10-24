import { addDocProps, CT, emptyPackage, esc, REL, x, XML_HEADER } from '../ooxml';
import { officeThemeXml } from '../theme';
import { cellName, keyCol, keyRow, rangeName } from './addr';
import { addPrefixes } from './formula';
import { pxToPt, pxToWidth, sheetExtent, type BorderSide, type Cell, type Sheet, type Style, type Workbook } from './model';
import { builtinId } from './numfmt';
import { CellError, numberToText, type Scalar } from './values';

/**
 * Writing .xlsx: a clean package with the workbook, its sheets, shared
 * strings, a styles part built from the formats in use, the Office theme and
 * document properties. Formulas are saved with their computed values, so
 * other programs show results before they recalculate.
 */

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CT_SHEET = {
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
};

/** Characters XML can't carry are written as _xHHHH_, as Excel does. */
function escText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return esc(s.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`));
}

const argb = (hex: string) => `FF${hex.toUpperCase()}`;

class Styles {
  fonts: string[] = [];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  numFmts = new Map<string, number>();
  xfs: string[] = [];
  private byStyle = new Map<number, number>();
  private keyed = new Map<string, number>();

  constructor(private wb: Workbook) {
    this.xf(0);
  }

  private intern(list: string[], item: string): number {
    const i = list.indexOf(item);
    if (i >= 0) return i;
    list.push(item);
    return list.length - 1;
  }

  private fontXml(s: Style): string {
    const f = s.font;
    return x('font', null, [
      f.bold && '<b/>',
      f.italic && '<i/>',
      f.strike && '<strike/>',
      f.underline && (f.underline === 'single' ? '<u/>' : `<u val="${f.underline}"/>`),
      f.vert && `<vertAlign val="${f.vert}"/>`,
      `<sz val="${f.size}"/>`,
      f.color ? `<color rgb="${argb(f.color)}"/>` : '<color theme="1"/>',
      `<name val="${esc(f.name)}"/>`,
      '<family val="2"/>',
      f.name === this.wb.theme.minorFont && '<scheme val="minor"/>',
    ]);
  }

  private fillXml(s: Style): string | null {
    if (s.fill) return `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`;
    if (s.pattern) {
      const p = s.pattern;
      return `<fill><patternFill patternType="${esc(p.type)}">${p.fg ? `<fgColor rgb="${argb(p.fg)}"/>` : ''}${p.bg ? `<bgColor rgb="${argb(p.bg)}"/>` : ''}</patternFill></fill>`;
    }
    return null;
  }

  private borderXml(s: Style): string | null {
    const b = s.border;
    if (!b.l && !b.r && !b.t && !b.b) return null;
    const side = (tag: string, v?: BorderSide) => (v ? `<${tag} style="${v.style}"><color rgb="${argb(v.color)}"/></${tag}>` : `<${tag}/>`);
    return `<border>${side('left', b.l)}${side('right', b.r)}${side('top', b.t)}${side('bottom', b.b)}<diagonal/></border>`;
  }

  /** The cellXfs index for a style id. */
  xf(id: number | undefined): number {
    const sid = id ?? 0;
    const known = this.byStyle.get(sid);
    if (known !== undefined) return known;
    const s = this.wb.styles.get(sid);
    let numFmtId = builtinId(s.numFmt);
    if (numFmtId === null) {
      numFmtId = this.numFmts.get(s.numFmt) ?? 164 + this.numFmts.size;
      this.numFmts.set(s.numFmt, numFmtId);
    }
    const fontId = this.intern(this.fonts, this.fontXml(s));
    const fillXml = this.fillXml(s);
    const fillId = fillXml ? this.intern(this.fills, fillXml) : 0;
    const borderXml = this.borderXml(s);
    const borderId = borderXml ? this.intern(this.borders, borderXml) : 0;
    const align =
      s.h !== 'general' || s.v !== 'bottom' || s.wrap || s.indent || s.rotate || s.shrink
        ? x('alignment', {
            horizontal: s.h !== 'general' ? s.h : null,
            vertical: s.v !== 'bottom' ? s.v : null,
            textRotation: s.rotate || null,
            wrapText: s.wrap || null,
            indent: s.indent || null,
            shrinkToFit: s.shrink || null,
          })
        : '';
    const xml = x(
      'xf',
      {
        numFmtId,
        fontId,
        fillId,
        borderId,
        xfId: 0,
        applyNumberFormat: numFmtId !== 0 || null,
        applyFont: fontId !== 0 || null,
        applyFill: fillId !== 0 || null,
        applyBorder: borderId !== 0 || null,
        applyAlignment: align ? 1 : null,
      },
      align,
    );
    let i = this.keyed.get(xml);
    if (i === undefined) {
      i = this.xfs.length;
      this.xfs.push(xml);
      this.keyed.set(xml, i);
    }
    this.byStyle.set(sid, i);
    return i;
  }

  xml(): string {
    const numFmts = [...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('');
    return (
      XML_HEADER +
      `<styleSheet xmlns="${MAIN}">` +
      (numFmts ? `<numFmts count="${this.numFmts.size}">${numFmts}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      (this.wb.dxfs ?? '<dxfs count="0"/>') +
      `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
      `</styleSheet>`
    );
  }
}

class SharedStrings {
  list: string[] = [];
  private index = new Map<string, number>();
  count = 0;

  id(s: string): number {
    this.count++;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }

  xml(): string {
    const items = this.list.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${escText(s)}</t></si>`).join('');
    return `${XML_HEADER}<sst xmlns="${MAIN}" count="${this.count}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

function cellXml(r: number, c: number, cell: Cell, value: Scalar, styles: Styles, strings: SharedStrings): string {
  const ref = cellName(r, c);
  const s = cell.s ? styles.xf(cell.s) : 0;
  const sAttr = s ? ` s="${s}"` : '';
  if (cell.f !== undefined) {
    const f = `<f>${esc(addPrefixes(cell.f))}</f>`;
    if (value === null) return `<c r="${ref}"${sAttr}>${f}</c>`;
    if (typeof value === 'number') return `<c r="${ref}"${sAttr}>${f}<v>${numberToText(value).replace('E+', 'E')}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${value ? 1 : 0}</v></c>`;
    if (value instanceof CellError) return `<c r="${ref}"${sAttr} t="e">${f}<v>${esc(value.code)}</v></c>`;
    return `<c r="${ref}"${sAttr} t="str">${f}<v>${escText(value)}</v></c>`;
  }
  const v = cell.v;
  if (v === null) return `<c r="${ref}"${sAttr}/>`;
  if (typeof v === 'number') return `<c r="${ref}"${sAttr}><v>${Number.isFinite(v) ? String(v) : 0}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (v instanceof CellError) return `<c r="${ref}"${sAttr} t="e"><v>${esc(v.code)}</v></c>`;
  return `<c r="${ref}"${sAttr} t="s"><v>${strings.id(v)}</v></c>`;
}

function sheetXml(sheet: Sheet, active: boolean, value: (r: number, c: number, cell: Cell) => Scalar, styles: Styles, strings: SharedStrings, linkRel: (url: string) => string): string {
  const ext = sheetExtent(sheet);
  const dim = ext.rows < 0 ? 'A1' : rangeName({ r0: 0, c0: 0, r1: ext.rows, c1: ext.cols });
  const parts: string[] = [];
  parts.push(sheet.tabColor ? `<sheetPr><tabColor rgb="${argb(sheet.tabColor)}"/></sheetPr>` : '');
  parts.push(`<dimension ref="${dim}"/>`);
  // View: gridlines, headings, zoom, frozen panes, selection.
  const { rows: fr, cols: fc } = sheet.freeze;
  const sel = sheet.sel;
  const sqref = sel.ranges.map(rangeName).join(' ');
  let paneXml = '';
  let paneName: string | null = null;
  if (fr > 0 || fc > 0) {
    paneName = fr > 0 && fc > 0 ? 'bottomRight' : fr > 0 ? 'bottomLeft' : 'topRight';
    const tl = cellName(Math.max(fr, sheet.top.r), Math.max(fc, sheet.top.c));
    paneXml = x('pane', { xSplit: fc || null, ySplit: fr || null, topLeftCell: tl, activePane: paneName, state: 'frozen' });
  }
  const selXml = x('selection', { pane: paneName, activeCell: cellName(sel.active.r, sel.active.c), sqref });
  parts.push(
    `<sheetViews>${x(
      'sheetView',
      {
        showGridLines: sheet.gridlines ? null : 0,
        showRowColHeaders: sheet.headings ? null : 0,
        tabSelected: active || null,
        zoomScale: sheet.zoom !== 100 ? Math.round(sheet.zoom) : null,
        zoomScaleNormal: sheet.zoom !== 100 ? Math.round(sheet.zoom) : null,
        topLeftCell: !paneXml && (sheet.top.r || sheet.top.c) ? cellName(sheet.top.r, sheet.top.c) : null,
        workbookViewId: 0,
      },
      [paneXml, selXml],
    )}</sheetViews>`,
  );
  const drh = pxToPt(sheet.defaultRowHeight);
  parts.push(
    x('sheetFormatPr', {
      baseColWidth: sheet.defaultColWidth !== 64 ? null : 8,
      defaultColWidth: sheet.defaultColWidth !== 64 ? pxToWidth(sheet.defaultColWidth) : null,
      defaultRowHeight: drh,
      customHeight: drh !== 15 || null,
    }),
  );
  // Columns, runs of the same settings merged into one <col>.
  const colKeys = [...sheet.cols.keys()].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < colKeys.length; ) {
    const c0 = colKeys[i];
    const info = sheet.cols.get(c0)!;
    const key = JSON.stringify(info);
    let j = i;
    while (j + 1 < colKeys.length && colKeys[j + 1] === colKeys[j] + 1 && JSON.stringify(sheet.cols.get(colKeys[j + 1])) === key) j++;
    const style = info.s ? styles.xf(info.s) : 0;
    runs.push(
      x('col', {
        min: c0 + 1,
        max: colKeys[j] + 1,
        width: pxToWidth(info.w ?? sheet.defaultColWidth),
        style: style || null,
        hidden: info.hidden || null,
        customWidth: info.w !== undefined || null,
      }),
    );
    i = j + 1;
  }
  if (runs.length) parts.push(`<cols>${runs.join('')}</cols>`);
  // Cells, by row.
  const byRow = new Map<number, number[]>();
  for (const k of sheet.cells.keys()) {
    const r = keyRow(k);
    let list = byRow.get(r);
    if (!list) byRow.set(r, (list = []));
    list.push(k);
  }
  for (const r of sheet.rows.keys()) if (!byRow.has(r)) byRow.set(r, []);
  const rowNums = [...byRow.keys()].sort((a, b) => a - b);
  let data = '';
  for (const r of rowNums) {
    const keys = byRow.get(r)!.sort((a, b) => a - b);
    const info = sheet.rows.get(r);
    const rs = info?.s ? styles.xf(info.s) : 0;
    let cellsXml = '';
    for (const k of keys) {
      const cell = sheet.cells.get(k)!;
      const c = keyCol(k);
      cellsXml += cellXml(r, c, cell, value(r, c, cell), styles, strings);
    }
    data += x(
      'row',
      {
        r: r + 1,
        s: rs || null,
        customFormat: rs ? 1 : null,
        ht: info?.h !== undefined ? pxToPt(info.h) : null,
        hidden: info?.hidden || null,
        customHeight: (info?.h !== undefined && info.custom) || null,
      },
      cellsXml,
    );
  }
  parts.push(data ? `<sheetData>${data}</sheetData>` : '<sheetData/>');
  if (sheet.merges.length) parts.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${rangeName(m)}"/>`).join('')}</mergeCells>`);
  if (sheet.kept) {
    parts.push(...sheet.kept.cf);
    if (sheet.kept.dv) parts.push(sheet.kept.dv);
  }
  if (sheet.links.size) {
    const links = [...sheet.links].sort((a, b) => a[0] - b[0]).map(([k, url]) => {
      const ref = cellName(keyRow(k), keyCol(k));
      if (url.startsWith('#')) return x('hyperlink', { ref, location: url.slice(1), display: url.slice(1) });
      return x('hyperlink', { ref, 'r:id': linkRel(url) });
    });
    parts.push(`<hyperlinks>${links.join('')}</hyperlinks>`);
  }
  const m = sheet.page.margins;
  parts.push(x('pageMargins', { left: m.left, right: m.right, top: m.top, bottom: m.bottom, header: m.header, footer: m.footer }));
  if (sheet.page.orientation === 'landscape') parts.push('<pageSetup orientation="landscape"/>');
  return `${XML_HEADER}<worksheet xmlns="${MAIN}" xmlns:r="${REL_NS}">${parts.join('')}</worksheet>`;
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** The workbook as .xlsx bytes. `value` gives each formula's computed value. */
export function writeXlsx(wb: Workbook, value: (sheet: number, r: number, c: number, cell: Cell) => Scalar, opts: { macroEnabled?: boolean } = {}): Uint8Array {
  const pkg = emptyPackage();
  const styles = new Styles(wb);
  const strings = new SharedStrings();
  pkg.addRel('', REL.officeDocument, 'xl/workbook.xml');
  pkg.ensureOverride('xl/workbook.xml', opts.macroEnabled ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : CT_SHEET.workbook);
  const sheetsXml: string[] = [];
  wb.sheets.forEach((sheet, i) => {
    const path = `xl/worksheets/sheet${i + 1}.xml`;
    pkg.setText(path, sheetXml(sheet, i === wb.active, (r, c, cell) => value(i, r, c, cell), styles, strings, (url) => pkg.addRel(path, REL.hyperlink, url, true)));
    pkg.ensureOverride(path, CT_SHEET.worksheet);
    const id = pkg.addRel('xl/workbook.xml', REL.worksheet, path);
    sheetsXml.push(x('sheet', { name: sheet.name, sheetId: i + 1, state: sheet.hidden ? 'hidden' : null, 'r:id': id }));
  });
  pkg.setText('xl/theme/theme1.xml', officeThemeXml());
  pkg.ensureOverride('xl/theme/theme1.xml', CT.theme);
  pkg.addRel('xl/workbook.xml', REL.theme, 'xl/theme/theme1.xml');
  pkg.setText('xl/styles.xml', styles.xml());
  pkg.ensureOverride('xl/styles.xml', CT_SHEET.styles);
  pkg.addRel('xl/workbook.xml', REL.styles, 'xl/styles.xml');
  pkg.setText('xl/sharedStrings.xml', strings.xml());
  pkg.ensureOverride('xl/sharedStrings.xml', CT_SHEET.sharedStrings);
  pkg.addRel('xl/workbook.xml', REL.sharedStrings, 'xl/sharedStrings.xml');
  const names = wb.names
    .filter((n) => n.formula)
    .map((n) => x('definedName', { name: n.name, localSheetId: n.sheet ?? null, hidden: (n.hidden && !n.name.startsWith('_xlnm.')) || null }, esc(addPrefixes(n.formula))))
    .join('');
  const firstVisible = Math.max(0, wb.sheets.findIndex((s) => !s.hidden));
  pkg.setText(
    'xl/workbook.xml',
    XML_HEADER +
      `<workbook xmlns="${MAIN}" xmlns:r="${REL_NS}">` +
      x('workbookPr', { date1904: wb.date1904 || null, defaultThemeVersion: 166925 }) +
      `<bookViews>${x('workbookView', { xWindow: 0, yWindow: 0, windowWidth: 28800, windowHeight: 12300, firstSheet: firstVisible || null, activeTab: wb.active || null })}</bookViews>` +
      `<sheets>${sheetsXml.join('')}</sheets>` +
      (names ? `<definedNames>${names}</definedNames>` : '') +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
      '</workbook>',
  );
  addDocProps(pkg, 'Din Spreadsheet');
  pkg.addRel('', REL.coreProps, 'docProps/core.xml');
  pkg.addRel('', REL.extProps, 'docProps/app.xml');
  return pkg.write();
}
