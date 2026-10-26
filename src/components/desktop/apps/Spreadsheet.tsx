import { useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { ClipboardPaste, Copy, FileSpreadsheet, FileText, Grid2x2, Link2, Scissors, Table } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { isWebviewAvailable } from '@/lib/isElectron';
import { sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import type { FileFilter } from '@/lib/fileFilters';
import './office/fonts';
import {
  Backstage,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MessageBar,
  OfficeFrame,
  Ribbon,
  RibbonTabs,
  StatusBar,
  StatusText,
  SubMenu,
  TitleBar,
  ViewButton,
  ZoomSlider,
  type BackstagePage,
  type PickedColor,
  type Template,
} from './office/chrome';
import { stepFontSize } from './office/fonts';
import { extOf, useOfficeFile } from './office/useOfficeFile';
import {
  cellKey,
  cellName,
  colName,
  isWholeCols,
  isWholeRows,
  MAX_COLS,
  MAX_ROWS,
  normRange,
  parseRange,
  quoteSheet,
  rangeName,
  type Range,
} from './office/sheet/addr';
import { CELL_STYLES } from './office/sheet/cellStyles';
import { RIBBON_TABS, type Cmd, type FormatTab, type RibbonState } from './office/sheet/commands';
import { readDelimited, writeDelimited, parseDelimited } from './office/sheet/csv';
import {
  ChoiceDialog,
  DefineNameDialog,
  FindDialog,
  FormatCellsDialog,
  GoToDialog,
  InsertFunctionDialog,
  LinkDialog,
  MessageDialog,
  MoveSheetDialog,
  NameManagerDialog,
  NumberDialog,
  PickListDialog,
  RemoveDuplicatesDialog,
  SortDialog,
  ZoomDialog,
  type FindOptions,
  type FormatResult,
} from './office/sheet/dialogs';
import { autoClose, coloredRefs, normalizeFormula, suggest } from './office/sheet/editing';
import { todaySerial, nowSerial } from './office/sheet/dates';
import { autofitHeight, autofitWidth, fitRowsOnLoad } from './office/sheet/fit';
import { changeDecimals } from './office/sheet/formats';
import { canInsertRef, cycleAbsolute, parseFormula, translateFormula, tokenize } from './office/sheet/formula';
import { Calc, evaluateText } from './office/sheet/formulaEval';
import { FormulaBar } from './office/sheet/FormulaBar';
import { Grid, type DragKind, type GridApi } from './office/sheet/Grid';
import {
  cellsIn,
  charsToPx,
  colWidth,
  expandMerges,
  mergeAt,
  newWorkbook,
  pxToChars,
  sheetExtent,
  styleIdAt,
  type Cell,
  type Selection,
  type Style,
  type Workbook,
} from './office/sheet/model';
import { editText, formatValue, isDateFormat, parseEntry } from './office/sheet/numfmt';
import * as ops from './office/sheet/ops';
import type { Highlight } from './office/sheet/render';
import { SheetRibbon } from './office/sheet/Ribbon';
import { SheetTabs } from './office/sheet/SheetTabs';
import { budgetTemplate, invoiceTemplate, todoTemplate } from './office/sheet/templates';
import { readXlsx } from './office/sheet/xlsxRead';
import { writeXlsx } from './office/sheet/xlsxWrite';
import { readOds, writeOds } from './office/sheet/ods';
import { isErr, numberToText, type Scalar } from './office/sheet/values';

const SAVE_TYPES: FileFilter[] = [
  { name: 'Excel Workbook', patterns: ['*.xlsx'], mimeTypes: [] },
  { name: 'OpenDocument Spreadsheet', patterns: ['*.ods'], mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'] },
  { name: 'CSV (Comma delimited)', patterns: ['*.csv'], mimeTypes: [] },
  { name: 'Text (Tab delimited)', patterns: ['*.tsv', '*.txt'], mimeTypes: [] },
];
const SAVE_XLSX = 0;
const SAVE_ODS = 1;
const SAVE_CSV = 2;
const SAVE_TSV = 3;
const OPEN_EXTENSIONS = ['xlsx', 'xlsm', 'ods', 'ots', 'fods', 'csv', 'tsv', 'txt', 'xls'];
const ODF_EXTENSIONS = new Set(['ods', 'ots', 'fods']);
const MAX_HISTORY = 100;

interface Entry {
  wb: Workbook;
  label: string;
  /** The sheet the change was made on, and the selection before it, for undo to go back to. */
  sheet: number;
  sel: Selection | null;
}

interface Hist {
  entries: Entry[];
  index: number;
}

interface View {
  sel: Selection;
  zoom: number;
}

interface Edit {
  sheet: number;
  r: number;
  c: number;
  text: string;
  s: number;
  e: number;
  where: 'cell' | 'bar';
  mode: 'enter' | 'edit';
  /** The reference being pointed at (with the mouse or arrows) and where it sits in the text. */
  point: { start: number; end: number; anchor: { r: number; c: number }; cur: { r: number; c: number }; sheet: number } | null;
  ac: number;
}

type Clip = ops.Clip;

type Dialog =
  | { kind: 'format'; tab: FormatTab }
  | { kind: 'function'; category?: string }
  | { kind: 'find'; replace: boolean }
  | { kind: 'goto' }
  | { kind: 'size'; what: 'row' | 'col' | 'std' }
  | { kind: 'insert' }
  | { kind: 'delete' }
  | { kind: 'zoom' }
  | { kind: 'moveSheet' }
  | { kind: 'unhide' }
  | { kind: 'message'; title: string; text: React.ReactNode }
  | { kind: 'sort'; g: Range; header: boolean }
  | { kind: 'dups'; g: Range; header: boolean }
  | { kind: 'names' }
  | { kind: 'defineName'; name: string; formula: string; old?: string }
  | { kind: 'link' }
  | null;

const isFormulaText = (t: string) => t.startsWith('=');
const one = (r: number, c: number): Range => ({ r0: r, c0: c, r1: r, c1: c });
const selOf = (r: number, c: number): Selection => ({ active: { r, c }, ranges: [one(r, c)] });

/**
 * Spreadsheet - an Excel workalike: workbooks of sheets with formulas,
 * number formats and cell formatting, opened from and saved to .xlsx (and
 * LibreOffice's .ods, and CSV), with Excel 365's ribbon, grid, keyboard and mouse.
 *
 * Launch params: `{ path?: string }` (absolute).
 */
export function Spreadsheet({ windowId, params }: AppComponentProps) {
  const initialPath = typeof params?.path === 'string' ? params.path : null;
  const [hist, setHist] = useState<Hist>(() => ({ entries: [{ wb: newWorkbook(), label: 'New', sheet: 0, sel: null }], index: 0 }));
  const wb = hist.entries[hist.index].wb;
  const [activeRaw, setActive] = useState(0);
  const si = Math.max(0, Math.min(activeRaw, wb.sheets.length - 1));
  const sheet = wb.sheets[si];
  const [views, setViews] = useState<Record<number, View>>({});
  const view = views[sheet.id] ?? { sel: sheet.sel, zoom: sheet.zoom };
  const sel = view.sel;
  const zoom = view.zoom;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [backstage, setBackstage] = useState<BackstagePage | null>(null);
  const [tab, setTab] = useState('home');
  const [collapsed, setCollapsed] = useState(false);
  const [showFormulas, setShowFormulas] = useState(false);
  const [formulaBar, setFormulaBar] = useState(true);
  const [barExpanded, setBarExpanded] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'cell' | 'col' | 'row' } | null>(null);
  const [lost, setLost] = useState<string[]>([]);
  const [painter, setPainter] = useState<{ cells: (number | undefined)[][]; sticky: boolean } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [fontColor, setFontColor] = useState<string | null>('FF0000');
  const [fillColor, setFillColor] = useState<string | null>('FFFF00');
  const [recentFns, setRecentFns] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [circSeen, setCircSeen] = useState('');
  const [errorDismissed, setErrorDismissed] = useState<string | null>(null);
  const [keptDismissed, setKeptDismissed] = useState(true);
  const [dragName, setDragName] = useState<string | null>(null);
  const gridApi = useRef<GridApi | null>(null);
  const editingRef = useRef(false);
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLTextAreaElement | null>(null);
  const extRef = useRef<{ r: number; c: number } | null>(null);
  const tabStart = useRef<number | null>(null);
  const dragStart = useRef<{ r: number; c: number; ctrl: boolean } | null>(null);
  const findState = useRef<{ sheet: number; r: number; c: number } | null>(null);
  const linkClick = useRef<{ r: number; c: number; t: number } | null>(null);
  const { open: openWindow } = useWindowActions();

  const calc = useMemo(() => new Calc(wb).all(), [wb]);
  /** F9: calculate again (a fresh copy of the workbook object makes a fresh calculation). */
  const recalculate = () => setHist((h) => ({ ...h, entries: h.entries.map((e, i) => (i === h.index ? { ...e, wb: { ...e.wb } } : e)) }));
  const value = (r: number, c: number, s = si): Scalar => calc.value(s, r, c);

  // The first circular reference a change makes gets Excel's warning.
  const circKey = calc.circular.length ? 'circular' : '';
  if (circKey !== circSeen) {
    setCircSeen(circKey);
    if (circKey && circSeen !== 'loaded' && hist.index > 0) {
      setDialog({
        kind: 'message',
        title: 'Spreadsheet',
        text: 'There are one or more circular references where a formula refers to its own cell either directly or indirectly. This might cause them to calculate incorrectly.\n\nTry removing or changing these references, or moving the formulas to different cells.',
      });
    }
  }

  // ---- File ----------------------------------------------------------------------------------------

  const resetTo = (next: Workbook, label = 'Open') => {
    setHist({ entries: [{ wb: next, label, sheet: next.active, sel: null }], index: 0 });
    setActive(next.active);
    setViews({});
    setEdit(null);
    setClip(null);
    setPainter(null);
    setCircSeen('loaded');
  };

  const file = useOfficeFile({
    windowId,
    appId: 'spreadsheet',
    app: 'excel',
    untitled: 'Book',
    initialPath,
    openExtensions: OPEN_EXTENSIONS,
    saveTypes: SAVE_TYPES,
    onLoad: (bytes, path) => {
      const ext = extOf(path);
      if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
        const text = new TextDecoder('utf-8').decode(bytes);
        const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
        resetTo(readDelimited(text, name, ext === 'csv' ? undefined : '\t'));
        setLost([]);
        return;
      }
      const loaded = ODF_EXTENSIONS.has(ext) ? readOds(bytes) : readXlsx(bytes);
      resetTo(fitRowsOnLoad(loaded.wb));
      setLost(loaded.lost);
      setKeptDismissed(!loaded.wb.sheets.some((sh) => sh.kept?.dv));
    },
    onSave: (path) => {
      const ext = extOf(path);
      if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
        const text = writeDelimited(displayRows(si), ext === 'csv' ? ',' : '\t');
        setMessage(`${sheet.name} was saved as ${ext.toUpperCase()}. Other sheets and formatting aren’t kept in this format.`);
        return new TextEncoder().encode(`\ufeff${text}`);
      }
      const out = finalWorkbook();
      const c = new Calc(out).all();
      if (ODF_EXTENSIONS.has(ext)) {
        if (out.sheets.some((sh) => sh.kept?.cf.length || sh.kept?.dv)) setMessage('Conditional formatting and data validation aren’t kept in OpenDocument format.');
        return writeOds(out, (s, r, col) => c.value(s, r, col), ext);
      }
      return writeXlsx(out, (s, r, col) => c.value(s, r, col), { macroEnabled: ext === 'xlsm' });
    },
  });

  /** The workbook as it should be saved: each sheet's selection, zoom and scroll position. */
  const finalWorkbook = (): Workbook => {
    const top = gridApi.current?.topLeft();
    return {
      ...wb,
      active: si,
      sheets: wb.sheets.map((s, i) => {
        const v = views[s.id];
        return { ...s, sel: v?.sel ?? s.sel, zoom: v?.zoom ?? s.zoom, top: i === si && top ? top : s.top };
      }),
    };
  };

  /** A sheet's cells as their displayed text, for CSV and the clipboard. */
  const displayRows = (s: number, g?: Range): string[][] => {
    const sh = wb.sheets[s];
    const ext = sheetExtent(sh);
    const range = g ?? { r0: 0, c0: 0, r1: ext.rows, c1: ext.cols };
    const rows: string[][] = [];
    for (let r = range.r0; r <= Math.min(range.r1, Math.max(ext.rows, range.r0)); r++) {
      const row: string[] = [];
      for (let c = range.c0; c <= Math.min(range.c1, Math.max(ext.cols, range.c0)); c++) {
        const cell = sh.cells.get(cellKey(r, c));
        const v = cell ? (cell.f !== undefined ? calc.value(s, r, c) : cell.v) : null;
        const st = wb.styles.get(cell?.s ?? styleIdAt(sh, r, c));
        row.push(v === null ? '' : formatValue(v, st.numFmt, wb.date1904, 255).text.replace(/\s+$/, (m) => (st.numFmt.includes('_') ? '' : m)));
      }
      rows.push(row);
    }
    return rows;
  };

  // ---- History ---------------------------------------------------------------------------------------

  const push = (next: Workbook, label: string, sheetIndex = si) => {
    setHist((h) => {
      const entries = h.entries.slice(0, h.index + 1);
      entries.push({ wb: next, label, sheet: sheetIndex, sel });
      while (entries.length > MAX_HISTORY) entries.shift();
      return { entries, index: entries.length - 1 };
    });
    file.setDirty(true);
    setMessage(null);
  };

  const undo = () => {
    if (edit) return cancelEdit();
    if (hist.index === 0) return;
    const e = hist.entries[hist.index];
    const target = hist.entries[hist.index - 1].wb;
    setHist({ ...hist, index: hist.index - 1 });
    const s = Math.min(e.sheet, target.sheets.length - 1);
    setActive(s);
    if (e.sel) setSelFor(target.sheets[s].id, e.sel);
    file.setDirty(true);
    setClip(null);
  };

  const redo = () => {
    if (hist.index >= hist.entries.length - 1) return;
    const e = hist.entries[hist.index + 1];
    setHist({ ...hist, index: hist.index + 1 });
    setActive(Math.min(e.sheet, e.wb.sheets.length - 1));
    file.setDirty(true);
  };

  /** Save; what's being typed goes into its cell first. */
  const saveAfterCommit = useRef(false);
  const saveNow = () => {
    if (edit) {
      if (!commitEdit(0, 0)) return;
      saveAfterCommit.current = true;
      return;
    }
    void file.save();
  };
  useEffect(() => {
    if (!saveAfterCommit.current) return;
    saveAfterCommit.current = false;
    void file.save();
  }, [hist, file]);

  // ---- Selection -------------------------------------------------------------------------------------

  const setSelFor = (id: number, s: Selection, z?: number) => {
    setViews((v) => {
      const sh = wb.sheets.find((x) => x.id === id);
      const cur = v[id] ?? { sel: sh?.sel ?? selOf(0, 0), zoom: sh?.zoom ?? 100 };
      return { ...v, [id]: { sel: s, zoom: z ?? cur.zoom } };
    });
  };
  const setSel = (s: Selection) => setSelFor(sheet.id, s);
  const setZoom = (z: number) => setSelFor(sheet.id, sel, Math.max(10, Math.min(400, Math.round(z))));

  const lastRange = sel.ranges[sel.ranges.length - 1];

  /** Select one cell (its merged area, if it's merged). */
  const selectCell = (r: number, c: number, reveal = true) => {
    const m = mergeAt(sheet, r, c);
    const g = m ?? one(r, c);
    setSel({ active: { r: g.r0, c: g.c0 }, ranges: [g] });
    extRef.current = { r: g.r0, c: g.c0 };
    tabStart.current = null;
    if (reveal) gridApi.current?.reveal(r, c);
  };

  const selectRange = (g: Range, active?: { r: number; c: number }) => {
    const a = active ?? { r: g.r0, c: g.c0 };
    setSel({ active: a, ranges: [g] });
    extRef.current = { r: g.r1, c: g.c1 };
  };

  const hiddenRow = (r: number) => !!sheet.rows.get(r)?.hidden;
  const hiddenCol = (c: number) => !!sheet.cols.get(c)?.hidden;

  /** One step in a direction, past hidden rows and columns and out of merged areas. */
  const step = (r: number, c: number, dr: number, dc: number): { r: number; c: number } => {
    const m = mergeAt(sheet, r, c);
    let nr = r;
    let nc = c;
    if (m) {
      if (dr > 0) nr = m.r1;
      if (dr < 0) nr = m.r0;
      if (dc > 0) nc = m.c1;
      if (dc < 0) nc = m.c0;
    }
    do {
      nr += dr;
      nc += dc;
    } while (nr >= 0 && nr < MAX_ROWS && nc >= 0 && nc < MAX_COLS && ((dr && hiddenRow(nr)) || (dc && hiddenCol(nc))));
    return { r: Math.max(0, Math.min(MAX_ROWS - 1, nr)), c: Math.max(0, Math.min(MAX_COLS - 1, nc)) };
  };

  const navigate = (dr: number, dc: number, extend: boolean, toEdge: boolean) => {
    if (extend) {
      const corner = extRef.current ?? { r: lastRange.r0 === sel.active.r ? lastRange.r1 : lastRange.r0, c: lastRange.c0 === sel.active.c ? lastRange.c1 : lastRange.c0 };
      const next = toEdge ? ops.dataEdge(sheet, corner.r, corner.c, dr, dc) : step(corner.r, corner.c, dr, dc);
      const g = expandMerges(sheet, normRange({ r0: sel.active.r, c0: sel.active.c, r1: next.r, c1: next.c }));
      setSel({ active: sel.active, ranges: [...sel.ranges.slice(0, -1), g] });
      extRef.current = next;
      gridApi.current?.reveal(next.r, next.c);
      return;
    }
    const from = sel.active;
    const next = toEdge ? ops.dataEdge(sheet, from.r, from.c, dr, dc) : step(from.r, from.c, dr, dc);
    selectCell(next.r, next.c);
  };

  /** Enter and Tab move within a selected range, wrapping, as Excel does. */
  const moveWithin = (dr: number, dc: number) => {
    const g = lastRange;
    const multi = sel.ranges.length > 1 || g.r0 !== g.r1 || g.c0 !== g.c1;
    const m = mergeAt(sheet, sel.active.r, sel.active.c);
    if (!multi || (m && m.r0 === g.r0 && m.c0 === g.c0 && m.r1 === g.r1 && m.c1 === g.c1)) {
      if (dr && tabStart.current !== null && dc === 0) {
        const c = tabStart.current;
        tabStart.current = null;
        const n = step(sel.active.r, c, dr, 0);
        selectCell(n.r, c);
        return;
      }
      const n = step(sel.active.r, sel.active.c, dr, dc);
      const keep = tabStart.current;
      selectCell(n.r, n.c);
      if (dc) tabStart.current = keep ?? sel.active.c;
      return;
    }
    let { r, c } = sel.active;
    if (dr) {
      r += dr;
      if (r > g.r1) {
        r = g.r0;
        c = c + 1 > g.c1 ? g.c0 : c + 1;
      } else if (r < g.r0) {
        r = g.r1;
        c = c - 1 < g.c0 ? g.c1 : c - 1;
      }
    } else {
      c += dc;
      if (c > g.c1) {
        c = g.c0;
        r = r + 1 > g.r1 ? g.r0 : r + 1;
      } else if (c < g.c0) {
        c = g.c1;
        r = r - 1 < g.r0 ? g.r1 : r - 1;
      }
    }
    setSel({ active: { r, c }, ranges: sel.ranges });
    gridApi.current?.reveal(r, c);
  };

  // ---- Editing ---------------------------------------------------------------------------------------

  const activeCell = sheet.cells.get(cellKey(sel.active.r, sel.active.c));
  const activeStyle = wb.styles.get(activeCell?.s ?? styleIdAt(sheet, sel.active.r, sel.active.c));

  /** The text a cell shows in the formula bar and starts editing with. */
  const contentText = (cell: Cell | undefined, style: Style) => {
    if (!cell) return '';
    if (cell.f !== undefined) return `=${cell.f}`;
    return editText(cell.v, style.numFmt, wb.date1904);
  };

  const startEdit = (opts: { text?: string; where?: 'cell' | 'bar'; mode?: 'enter' | 'edit'; s?: number; e?: number } = {}) => {
    const text = opts.text ?? contentText(activeCell, activeStyle);
    const s = opts.s ?? text.length;
    setEdit({ sheet: si, r: sel.active.r, c: sel.active.c, text, s, e: opts.e ?? s, where: opts.where ?? 'cell', mode: opts.mode ?? 'enter', point: null, ac: 0 });
    setClip(null);
    setMenu(null);
    gridApi.current?.reveal(sel.active.r, sel.active.c);
  };

  const cancelEdit = () => {
    if (!edit) return;
    setActive(edit.sheet);
    setEdit(null);
    sinkRef.current?.focus();
  };

  /** Excel's guess at a format for a formula's result in a General cell. */
  const inferFormat = (f: string, sheetIndex: number): string | null => {
    const head = /^\s*([A-Z][A-Z0-9.]*)\(/i.exec(f)?.[1]?.toUpperCase();
    if (head && ['TODAY', 'DATE', 'EDATE', 'EOMONTH', 'WORKDAY', 'DATEVALUE'].includes(head)) return 'm/d/yyyy';
    if (head === 'NOW') return 'm/d/yyyy h:mm';
    if (head === 'TIME' || head === 'TIMEVALUE') return 'h:mm AM/PM';
    if (head && ['PMT', 'FV', 'PV', 'IPMT', 'PPMT'].includes(head)) return '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)';
    const first = tokenize(f).find((t) => t.type === 'ref');
    if (first?.ref && !['SUM', 'COUNT', 'COUNTA', 'ROWS', 'COLUMNS', 'LEN', 'ROW', 'COLUMN', 'COUNTIF', 'MATCH'].includes(head ?? '')) {
      const s = first.ref.sheet ? wb.sheets.findIndex((x) => x.name.toLowerCase() === first.ref!.sheet!.toLowerCase()) : sheetIndex;
      if (s >= 0) {
        const fmt = wb.styles.get(styleIdAt(wb.sheets[s], first.ref.r0, first.ref.c0)).numFmt;
        if (fmt !== 'General' && fmt !== '@' && (isDateFormat(fmt) || /[$%€£¥]/.test(fmt))) return fmt;
      }
    }
    return null;
  };

  /** Rows that follow their contents' height get re-measured after an edit. */
  const autoRows = (w: Workbook, s: number, rows: Iterable<number>): Workbook => {
    let out = w;
    const sh = w.sheets[s];
    const c = new Calc(w);
    for (const r of new Set(rows)) {
      const info = sh.rows.get(r);
      if (info?.custom || info?.hidden) continue;
      const h = autofitHeight(out, s, c, r, (col) => colWidth(sh, col));
      const cur = info?.h ?? sh.defaultRowHeight;
      if (h !== cur) {
        out = ops.updateSheet(out, s, (x) => {
          const rowsMap = new Map(x.rows);
          if (h === x.defaultRowHeight && !info?.s) rowsMap.delete(r);
          else rowsMap.set(r, { ...info, h });
          return { ...x, rows: rowsMap };
        });
      }
    }
    return out;
  };

  /** A typed date or amount that doesn't fit a default-width column widens it, as Excel does. */
  const autoWiden = (w: Workbook, s: number, cells: { r: number; c: number }[]): Workbook => {
    let out = w;
    const c0 = new Calc(w);
    for (const { r, c } of cells) {
      const sh = out.sheets[s];
      if (sh.cols.get(c)?.w !== undefined || sh.cols.get(c)?.hidden) continue;
      const cell = sh.cells.get(cellKey(r, c));
      if (!cell || typeof cell.v !== 'number' || cell.f !== undefined) continue;
      const fmt = out.styles.get(cell.s).numFmt;
      if (fmt === 'General' || !(isDateFormat(fmt) || /[$€£¥]/.test(fmt))) continue;
      const need = autofitWidth(out, s, c0, c, one(r, c));
      if (need > sh.defaultColWidth) out = ops.updateSheet(out, s, (x) => ({ ...x, cols: new Map(x.cols).set(c, { ...x.cols.get(c), w: need }) }));
    }
    return out;
  };

  /** Enter: put what's typed into the cell (or every selected cell, with Ctrl). */
  const commitEdit = (dr: number, dc: number, opts: { all?: boolean } = {}): boolean => {
    if (!edit) return true;
    const es = edit.sheet;
    const sh = wb.sheets[es];
    const text = edit.text;
    const k = cellKey(edit.r, edit.c);
    const cell = sh.cells.get(k);
    const sid = cell?.s ?? styleIdAt(sh, edit.r, edit.c);
    const style = wb.styles.get(sid);
    let next: Cell;
    let newStyle = sid;
    if (style.numFmt === '@' && !text.startsWith('=')) next = { v: text === '' ? null : text };
    else {
      const p = parseEntry(text, wb.date1904);
      if (p.formula !== undefined) {
        const f = normalizeFormula(autoClose(p.formula));
        try {
          parseFormula(f);
        } catch {
          setDialog({
            kind: 'message',
            title: 'Spreadsheet',
            text: 'There’s a problem with this formula.\n\nNot trying to type a formula? When the first character is an equal (=) or minus (-) sign, Spreadsheet thinks it’s a formula. To get around this, type an apostrophe (’) first.',
          });
          return false;
        }
        next = { v: null, f };
        if (style.numFmt === 'General') {
          const fmt = inferFormat(f, es);
          if (fmt) newStyle = wb.styles.derive(sid, (s) => ({ ...s, numFmt: fmt }));
        }
        if (/^[A-Z][A-Z0-9.]*\(/i.test(f)) {
          const fn = /^([A-Z][A-Z0-9.]*)\(/i.exec(f)![1].toUpperCase();
          setRecentFns((list) => [fn, ...list.filter((x) => x !== fn)].slice(0, 10));
        }
      } else {
        let v = p.value;
        if (typeof v === 'number' && !p.format && style.numFmt.includes('%') && /^[+-]?[\d.]+$/.test(text.trim())) v = v / 100;
        next = { v };
        if (p.format && style.numFmt === 'General') newStyle = wb.styles.derive(sid, (s) => ({ ...s, numFmt: p.format! }));
      }
    }
    if (text.includes('\n') && !style.wrap) newStyle = wb.styles.derive(newStyle, (s) => ({ ...s, wrap: true }));
    if (newStyle) next.s = newStyle;
    const updates: [number, Cell | null][] = [];
    const rows = new Set<number>([edit.r]);
    if (opts.all) {
      for (const g of sel.ranges)
        for (let r = g.r0; r <= g.r1; r++)
          for (let c = g.c0; c <= g.c1; c++) {
            const ex = sh.cells.get(cellKey(r, c));
            const n: Cell = { ...next, s: next.s ?? ex?.s };
            if (next.f !== undefined) n.f = translateFormula(next.f, r - edit.r, c - edit.c);
            updates.push([cellKey(r, c), n]);
            rows.add(r);
          }
    } else updates.push([k, next]);
    let out = ops.updateSheet(wb, es, (s) => ops.withCells(s, updates));
    out = autoRows(out, es, rows);
    if (!opts.all) out = autoWiden(out, es, [{ r: edit.r, c: edit.c }]);
    push(out, 'Typing', es);
    setEdit(null);
    setActive(es);
    if (es !== si) {
      // Pointing on another sheet ends there; go back to the cell.
      requestAnimationFrame(() => sinkRef.current?.focus());
      return true;
    }
    if (dr || dc) moveWithin(dr, dc);
    return true;
  };

  /** Insert or update the reference being pointed at in the formula. */
  const pointTo = (anchor: { r: number; c: number }, cur: { r: number; c: number }) => {
    if (!edit) return;
    const g = normRange({ r0: anchor.r, c0: anchor.c, r1: cur.r, c1: cur.c });
    const m = mergeAt(sheet, g.r0, g.c0);
    const range = m && g.r0 === g.r1 && g.c0 === g.c1 ? m : g;
    let ref = range.r0 === range.r1 && range.c0 === range.c1 ? cellName(range.r0, range.c0) : rangeName(range);
    if (si !== edit.sheet) ref = `${quoteSheet(sheet.name)}!${ref}`;
    const start = edit.point ? edit.point.start : edit.s;
    const end = edit.point ? edit.point.end : edit.e;
    const text = edit.text.slice(0, start) + ref + edit.text.slice(end);
    const caret = start + ref.length;
    setEdit({ ...edit, text, s: caret, e: caret, point: { start, end: caret, anchor, cur, sheet: si }, ac: 0 });
    gridApi.current?.reveal(cur.r, cur.c);
  };

  const canPoint = (e: Edit | null) => !!e && isFormulaText(e.text) && (e.point ? e.s === e.point.end : canInsertRef(e.text, e.s) && e.s === e.e);

  const onEditChange = (text: string, s: number, e: number) => {
    if (!edit) {
      // Typing into the formula bar while not editing starts editing there.
      setEdit({ sheet: si, r: sel.active.r, c: sel.active.c, text, s, e, where: 'bar', mode: 'edit', point: null, ac: 0 });
      setClip(null);
      return;
    }
    setEdit({ ...edit, text, s, e, point: null, ac: 0 });
  };

  const onEditCaret = (s: number, e: number, where: 'cell' | 'bar') => {
    if (!edit) {
      if (where === 'bar' && document.activeElement === barRef.current) {
        const text = contentText(activeCell, activeStyle);
        setEdit({ sheet: si, r: sel.active.r, c: sel.active.c, text, s: Math.min(s, text.length), e: Math.min(e, text.length), where: 'bar', mode: 'edit', point: null, ac: 0 });
        setClip(null);
      }
      return;
    }
    if (edit.s === s && edit.e === e && edit.where === where) return;
    const point = edit.point && s === edit.point.end ? edit.point : null;
    setEdit({ ...edit, s, e, where, point, mode: where !== edit.where ? 'edit' : edit.mode });
  };

  const pickSuggestion = (name: string) => {
    if (!edit) return;
    const sug = suggest(edit.text, edit.s, wb.names.map((n) => n.name));
    const start = sug ? sug.start : edit.s;
    const isFn = !wb.names.some((n) => n.name === name);
    const insert = isFn ? `${name}(` : name;
    const text = edit.text.slice(0, start) + insert + edit.text.slice(edit.s);
    const caret = start + insert.length;
    setEdit({ ...edit, text, s: caret, e: caret, ac: 0, point: null });
  };

  const insertIntoEdit = (s: string) => {
    if (edit) {
      const text = edit.text.slice(0, edit.s) + s + edit.text.slice(edit.e);
      setEdit({ ...edit, text, s: edit.s + s.length, e: edit.s + s.length, point: null });
    } else startEdit({ text: s, mode: 'enter' });
  };

  // Focus follows editing: the in-cell editor or formula bar while typing, the grid otherwise.
  useEffect(() => {
    if (!edit) return;
    const el = edit.where === 'bar' ? barRef.current : editorRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(edit.s, edit.e);
    }
  }, [edit]);

  useEffect(() => {
    const was = editingRef.current;
    editingRef.current = !!edit;
    if (was && !edit && !dialog && !backstage) {
      const a = document.activeElement;
      if (!a || a === document.body || a === editorRef.current || a === barRef.current || a.closest?.('.office-frame')) sinkRef.current?.focus();
    }
  }, [edit, dialog, backstage]);

  useEffect(() => {
    if (!file.loading) sinkRef.current?.focus();
  }, [file.loading]);

  // Menus give focus back to nobody when they close; give it back to the sheet.
  // Not when focus went to nobody because of a press somewhere else (another
  // window's title bar, the desktop): taking it back would raise this window
  // over the one that was clicked.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let ours = false;
    const onIn = (e: FocusEvent) => {
      const t = e.target as Element | null;
      const from = e.relatedTarget as Node | null;
      if (t?.closest?.('[role=menu],[data-radix-popper-content-wrapper]')) ours = ours || !!(from && frameRef.current?.contains(from));
      else ours = !!(t && frameRef.current?.contains(t));
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('[role=menu],[data-radix-popper-content-wrapper]') && !frameRef.current?.contains(t)) ours = false;
    };
    const onOut = (e: FocusEvent) => {
      if (!ours || e.relatedTarget) return;
      setTimeout(() => {
        if (document.activeElement === document.body || document.activeElement === null) (editingRef.current ? (editorRef.current ?? barRef.current) : sinkRef.current)?.focus();
      }, 0);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  // ---- Changing cells ----------------------------------------------------------------------------------

  const formatSel = (fn: (s: Style) => Style, label = 'Format Cells', rows?: boolean) => {
    let out = ops.formatRanges(wb, si, sel.ranges, fn);
    if (rows) {
      const rs: number[] = [];
      for (const g of sel.ranges) for (let r = g.r0; r <= Math.min(g.r1, sheetExtent(sheet).rows + 1, g.r0 + 2000); r++) rs.push(r);
      out = autoRows(out, si, rs);
    }
    push(out, label);
  };

  const clearSel = (what: 'all' | 'contents' | 'formats') => push(ops.clearRanges(wb, si, sel.ranges, what), what === 'contents' ? 'Clear Contents' : what === 'formats' ? 'Clear Formats' : 'Clear');

  const buildClip = (cut: boolean): Clip | null => {
    if (sel.ranges.length > 1) {
      setDialog({ kind: 'message', title: 'Spreadsheet', text: 'This action won’t work on multiple selections.' });
      return null;
    }
    const g = clampToData(lastRange);
    const cells: (Cell | null)[][] = [];
    const values: Scalar[][] = [];
    for (let r = g.r0; r <= g.r1; r++) {
      const row: (Cell | null)[] = [];
      const vrow: Scalar[] = [];
      for (let c = g.c0; c <= g.c1; c++) {
        const cell = sheet.cells.get(cellKey(r, c)) ?? null;
        row.push(cell);
        vrow.push(cell ? (cell.f !== undefined ? value(r, c) : cell.v) : null);
      }
      cells.push(row);
      values.push(vrow);
    }
    const merges = sheet.merges.filter((m) => m.r0 >= g.r0 && m.r1 <= g.r1 && m.c0 >= g.c0 && m.c1 <= g.c1).map((m) => ({ r0: m.r0 - g.r0, c0: m.c0 - g.c0, r1: m.r1 - g.r0, c1: m.c1 - g.c0 }));
    const text = displayRows(si, g)
      .map((r) => r.map((x) => (/[\t\n"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join('\t'))
      .join('\r\n');
    return { rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1, cells, values, origin: { sheet: si, r: g.r0, c: g.c0 }, merges, text, cut };
  };

  /** Whole rows and columns are copied only as far as there's data. */
  const clampToData = (g: Range): Range => {
    const ext = sheetExtent(sheet);
    return { r0: g.r0, c0: g.c0, r1: isWholeCols(g) ? Math.max(g.r0, ext.rows) : g.r1, c1: isWholeRows(g) ? Math.max(g.c0, ext.cols) : g.c1 };
  };

  const doCopy = (cut: boolean, e?: React.ClipboardEvent) => {
    const c = buildClip(cut);
    if (!c) return;
    setClip(c);
    if (e) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', c.text);
    } else void navigator.clipboard?.writeText(c.text).catch(() => undefined);
    setMessage(cut ? 'Select destination and press ENTER or choose Paste' : 'Select destination and press ENTER or choose Paste');
  };

  const pasteClip = (c: Clip, mode: ops.PasteMode = 'all') => {
    const target = lastRange;
    let out = ops.paste(wb, si, { r: target.r0, c: target.c0 }, c, mode, target);
    const h = mode === 'transpose' ? c.cols : c.rows;
    const w = mode === 'transpose' ? c.rows : c.cols;
    const rows: number[] = [];
    for (let r = target.r0; r < target.r0 + Math.max(h, target.r1 - target.r0 + 1); r++) rows.push(r);
    out = autoRows(out, si, rows);
    push(out, c.cut ? 'Move' : 'Paste');
    const big = target.r1 - target.r0 + 1 >= h && target.c1 - target.c0 + 1 >= w && (target.r1 - target.r0 + 1) % h === 0 && (target.c1 - target.c0 + 1) % w === 0;
    selectRange(big ? target : { r0: target.r0, c0: target.c0, r1: target.r0 + h - 1, c1: target.c0 + w - 1 }, { r: target.r0, c: target.c0 });
    if (c.cut) setClip(null);
  };

  /** Text from another program: tab-separated rows, each value read as if typed. */
  const pasteText = (text: string) => {
    const rows = parseDelimited(text.replace(/\r?\n$/, ''), '\t');
    if (!rows.length) return;
    const at = lastRange;
    const updates: [number, Cell | null][] = [];
    rows.forEach((row, y) =>
      row.forEach((raw, x) => {
        const r = at.r0 + y;
        const c = at.c0 + x;
        if (r >= MAX_ROWS || c >= MAX_COLS) return;
        const ex = sheet.cells.get(cellKey(r, c));
        const p = parseEntry(raw, wb.date1904);
        let s = ex?.s;
        if (p.format && wb.styles.get(s).numFmt === 'General') s = wb.styles.derive(s, (st) => ({ ...st, numFmt: p.format! }));
        updates.push([cellKey(r, c), p.formula !== undefined ? { v: null, f: normalizeFormula(p.formula), s } : { v: p.value, s }]);
      }),
    );
    const w = Math.max(...rows.map((r) => r.length));
    const pasted: { r: number; c: number }[] = [];
    for (let y = 0; y < rows.length; y++) for (let x = 0; x < w; x++) pasted.push({ r: at.r0 + y, c: at.c0 + x });
    push(autoWiden(ops.updateSheet(wb, si, (s) => ops.withCells(s, updates)), si, pasted), 'Paste');
    selectRange({ r0: at.r0, c0: at.c0, r1: at.r0 + rows.length - 1, c1: at.c0 + w - 1 });
  };

  const doPaste = (mode: ops.PasteMode = 'all') => {
    if (clip) return pasteClip(clip, mode);
    void navigator.clipboard
      ?.readText()
      .then((t) => t && pasteText(t))
      .catch(() => setMessage('Use Ctrl+V to paste from other programs.'));
  };

  const autoSum = (fn: string) => {
    const sh = sheet;
    const g = lastRange;
    // A range of numbers selected: the total goes in the cell below (or right of) it.
    if (g.r0 !== g.r1 || g.c0 !== g.c1) {
      const vertical = g.r1 > g.r0;
      const updates: [number, Cell | null][] = [];
      if (vertical) {
        for (let c = g.c0; c <= g.c1; c++) updates.push([cellKey(g.r1 + 1, c), { v: null, f: `${fn}(${rangeName({ r0: g.r0, c0: c, r1: g.r1, c1: c })})`, s: sh.cells.get(cellKey(g.r1 + 1, c))?.s ?? sh.cells.get(cellKey(g.r1, c))?.s }]);
      } else updates.push([cellKey(g.r0, g.c1 + 1), { v: null, f: `${fn}(${rangeName(g)})`, s: sh.cells.get(cellKey(g.r0, g.c1))?.s }]);
      push(ops.updateSheet(wb, si, (s) => ops.withCells(s, updates)), 'AutoSum');
      return;
    }
    const r = ops.autoSumRange(sh, sel.active.r, sel.active.c, (rr, cc) => value(rr, cc));
    const ref = r ? rangeName(r) : '';
    const text = `=${fn}(${ref})`;
    setEdit({
      sheet: si,
      r: sel.active.r,
      c: sel.active.c,
      text,
      s: 2 + fn.length,
      e: 2 + fn.length + ref.length,
      where: 'cell',
      mode: 'enter',
      point: r ? { start: 2 + fn.length, end: 2 + fn.length + ref.length, anchor: { r: r.r0, c: r.c0 }, cur: { r: r.r1, c: r.c1 }, sheet: si } : null,
      ac: 0,
    });
  };

  const insertRowsCols = (axis: 'row' | 'col', remove = false) => {
    const g = lastRange;
    const at = axis === 'row' ? g.r0 : g.c0;
    const n = axis === 'row' ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
    push(ops.shiftAxis(wb, si, axis, at, remove ? -n : n), remove ? (axis === 'row' ? 'Delete Rows' : 'Delete Columns') : axis === 'row' ? 'Insert Rows' : 'Insert Columns');
    if (remove) selectCell(axis === 'row' ? Math.min(g.r0, MAX_ROWS - 1) : sel.active.r, axis === 'col' ? g.c0 : sel.active.c, false);
  };

  const insertCells = (how: 'right' | 'down' | 'row' | 'col') => {
    if (how === 'row') return insertRowsCols('row');
    if (how === 'col') return insertRowsCols('col');
    push(ops.shiftCells(wb, si, lastRange, how), 'Insert Cells');
  };

  const deleteCells = (how: 'left' | 'up' | 'row' | 'col') => {
    if (how === 'row') return insertRowsCols('row', true);
    if (how === 'col') return insertRowsCols('col', true);
    push(ops.shiftCells(wb, si, lastRange, how), 'Delete Cells');
  };

  const setSizes = (axis: 'row' | 'col', px: number, indexes: number[], label: string) => {
    push(
      ops.updateSheet(wb, si, (s) => {
        if (axis === 'col') {
          const cols = new Map(s.cols);
          for (const c of indexes) cols.set(c, { ...cols.get(c), w: Math.max(0, Math.round(px)), hidden: px === 0 ? true : undefined });
          return { ...s, cols };
        }
        const rows = new Map(s.rows);
        for (const r of indexes) rows.set(r, { ...rows.get(r), h: Math.max(0, Math.round(px)), custom: true, hidden: px === 0 ? true : undefined });
        return { ...s, rows };
      }),
      label,
    );
  };

  const selectedIndexes = (axis: 'row' | 'col'): number[] => {
    const out = new Set<number>();
    for (const g of sel.ranges) {
      const [a, b] = axis === 'row' ? [g.r0, Math.min(g.r1, g.r0 + 5000)] : [g.c0, g.c1];
      for (let i = a; i <= b; i++) out.add(i);
    }
    return [...out];
  };

  const autofit = (axis: 'row' | 'col', indexes = selectedIndexes(axis)) => {
    if (axis === 'col') {
      const rows = sel.ranges.every((g) => isWholeCols(g)) ? undefined : lastRange.r0 === lastRange.r1 && lastRange.c0 === lastRange.c1 ? undefined : lastRange;
      push(
        ops.updateSheet(wb, si, (s) => {
          const cols = new Map(s.cols);
          for (const c of indexes) cols.set(c, { ...cols.get(c), w: autofitWidth(wb, si, calc, c, rows), hidden: undefined });
          return { ...s, cols };
        }),
        'AutoFit Column Width',
      );
    } else {
      push(
        ops.updateSheet(wb, si, (s) => {
          const rows = new Map(s.rows);
          for (const r of indexes) {
            const h = autofitHeight(wb, si, calc, r, (c) => colWidth(s, c));
            rows.set(r, { ...rows.get(r), h, custom: undefined, hidden: undefined });
          }
          return { ...s, rows };
        }),
        'AutoFit Row Height',
      );
    }
  };

  const hide = (axis: 'row' | 'col', on: boolean) => {
    const idx = selectedIndexes(axis);
    push(
      ops.updateSheet(wb, si, (s) => {
        if (axis === 'col') {
          const cols = new Map(s.cols);
          const lo = Math.min(...idx);
          const hi = Math.max(...idx);
          // Unhide covers hidden columns inside (or just outside) the selection.
          for (let c = on ? lo : Math.max(0, lo - 1); c <= (on ? hi : hi + 1); c++) {
            if (!on && !cols.get(c)?.hidden) continue;
            cols.set(c, { ...cols.get(c), hidden: on || undefined, w: !on && cols.get(c)?.w === 0 ? undefined : cols.get(c)?.w });
          }
          return { ...s, cols };
        }
        const rows = new Map(s.rows);
        const lo = Math.min(...idx);
        const hi = Math.max(...idx);
        for (let r = on ? lo : Math.max(0, lo - 1); r <= (on ? hi : hi + 1); r++) {
          if (!on && !rows.get(r)?.hidden) continue;
          rows.set(r, { ...rows.get(r), hidden: on || undefined, h: !on && rows.get(r)?.h === 0 ? undefined : rows.get(r)?.h });
        }
        return { ...s, rows };
      }),
      on ? (axis === 'row' ? 'Hide Rows' : 'Hide Columns') : axis === 'row' ? 'Unhide Rows' : 'Unhide Columns',
    );
  };

  const sortRange = (): { g: Range; header: boolean } => {
    let g = lastRange;
    if (g.r0 === g.r1 && g.c0 === g.c1) g = ops.currentRegion(sheet, sel.active.r, sel.active.c);
    g = clampToData(g);
    return { g, header: ops.hasHeader(wb, si, g) };
  };

  const sortBy = (levels: { col: number; asc: boolean }[], g: Range, header: boolean) => {
    push(ops.sortRange(wb, si, g, levels, header, (r, c) => value(r, c)), 'Sort');
    selectRange(g, sel.active);
  };

  const columnsOf = (g: Range, header: boolean) => {
    const out: { index: number; label: string }[] = [];
    for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c++) {
      const v = header ? value(g.r0, c) : null;
      out.push({ index: c, label: v !== null && v !== '' ? String(v) : `Column ${colName(c)}` });
    }
    return out;
  };

  // Find: cells whose text (or formula) matches, after the active cell, by rows or columns.
  const findNext = (o: FindOptions): { sheet: number; r: number; c: number } | null => {
    if (!o.what) return null;
    const what = o.matchCase ? o.what : o.what.toLowerCase();
    const re = /[*?]/.test(o.what) ? new RegExp((o.entire ? '^' : '') + o.what.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + (o.entire ? '$' : ''), o.matchCase ? '' : 'i') : null;
    const matches = (s: number, r: number, c: number, cell: Cell) => {
      let t: string;
      if (o.inFormulas && cell.f !== undefined) t = `=${cell.f}`;
      else {
        const v = cell.f !== undefined ? calc.value(s, r, c) : cell.v;
        if (v === null) return false;
        t = o.inFormulas ? editText(v, 'General', wb.date1904) : formatValue(v, wb.styles.get(cell.s).numFmt, wb.date1904, 255).text;
      }
      if (re) return re.test(t);
      const tt = o.matchCase ? t : t.toLowerCase();
      return o.entire ? tt === what : tt.includes(what);
    };
    const order = o.workbook ? [...wb.sheets.keys()].map((k) => (si + k) % wb.sheets.length) : [si];
    const from = findState.current && findState.current.sheet === si ? findState.current : { sheet: si, r: sel.active.r, c: sel.active.c };
    for (let pass = 0; pass < order.length + 1; pass++) {
      const s = order[pass % order.length];
      const keys = [...wb.sheets[s].cells.keys()].sort((a, b) => (o.byColumns ? (a % MAX_COLS) - (b % MAX_COLS) || a - b : a - b));
      for (const k of keys) {
        const r = Math.floor(k / MAX_COLS);
        const c = k % MAX_COLS;
        if (pass === 0 && s === si) {
          const after = o.byColumns ? c > from.c || (c === from.c && r > from.r) : r > from.r || (r === from.r && c > from.c);
          if (!after) continue;
        }
        if (pass === order.length && s === si) {
          const before = o.byColumns ? c < from.c || (c === from.c && r <= from.r) : r < from.r || (r === from.r && c <= from.c);
          if (!before) continue;
        }
        const cell = wb.sheets[s].cells.get(k)!;
        if (matches(s, r, c, cell)) return { sheet: s, r, c };
      }
    }
    return null;
  };

  const replaceIn = (cell: Cell, o: FindOptions): Cell | null => {
    const src = cell.f !== undefined ? `=${cell.f}` : cell.v === null ? '' : editText(cell.v, 'General', wb.date1904);
    const flags = o.matchCase ? 'g' : 'gi';
    const pattern = o.what.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp(o.entire ? `^${pattern}$` : pattern, flags);
    if (!re.test(src)) return null;
    const out = src.replace(re, o.with.replace(/\$/g, '$$$$'));
    const p = parseEntry(out, wb.date1904);
    return p.formula !== undefined ? { ...cell, v: null, f: normalizeFormula(p.formula) } : { ...cell, v: p.value, f: undefined };
  };

  // Go To / Name Box: a cell, a range, or a defined name.
  const goTo = (ref: string): boolean => {
    const t = ref.trim();
    if (!t) {
      sinkRef.current?.focus();
      return true;
    }
    const name = wb.names.find((n) => n.name.toLowerCase() === t.toLowerCase());
    let target = name ? name.formula : t;
    let s = si;
    const bang = target.lastIndexOf('!');
    if (bang > 0) {
      const sheetName = target.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
      s = wb.sheets.findIndex((x) => x.name.toLowerCase() === sheetName.toLowerCase());
      target = target.slice(bang + 1);
      if (s < 0) return false;
    }
    const g = parseRange(target);
    if (!g) {
      // A new name for the selection, like typing into Excel's Name Box.
      if (/^[A-Za-z_\\][\w.]*$/.test(t) && !/^[A-Za-z]{1,3}\d+$/.test(t)) {
        push({ ...wb, names: [...wb.names, { name: t, formula: `${quoteSheet(sheet.name)}!${absRef(lastRange)}`, sheet: null }] }, 'Define Name');
        sinkRef.current?.focus();
        return true;
      }
      setDialog({ kind: 'message', title: 'Spreadsheet', text: 'Reference isn’t valid.' });
      return false;
    }
    setActive(s);
    const sh = wb.sheets[s];
    setSelFor(sh.id, { active: { r: g.r0, c: g.c0 }, ranges: [g] });
    extRef.current = { r: g.r1, c: g.c1 };
    requestAnimationFrame(() => {
      gridApi.current?.reveal(g.r0, g.c0);
      sinkRef.current?.focus();
    });
    return true;
  };

  const absRef = (g: Range) => {
    const a = (r: number, c: number) => `$${colName(c)}$${r + 1}`;
    return g.r0 === g.r1 && g.c0 === g.c1 ? a(g.r0, g.c0) : `${a(g.r0, g.c0)}:${a(g.r1, g.c1)}`;
  };

  const applyFormatResult = (res: FormatResult) => {
    let out = ops.formatRanges(wb, si, sel.ranges, res.patch);
    if (res.borders) {
      const b = res.borders;
      for (const g of sel.ranges) {
        out = ops.updateSheet(out, si, (s) => {
          const cells = new Map(s.cells);
          for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++)
            for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 500); c++) {
              const k = cellKey(r, c);
              const cell = cells.get(k);
              const st = out.styles.get(cell?.s ?? styleIdAt(s, r, c));
              const pick = (outer: typeof b.top, inner: typeof b.insideH, isEdge: boolean, cur: typeof b.top) => (isEdge ? (outer === undefined ? cur : outer) : inner === undefined ? cur : inner);
              const border = {
                t: pick(b.top, b.insideH, r === g.r0, st.border.t) ?? undefined,
                b: pick(b.bottom, b.insideH, r === g.r1, st.border.b) ?? undefined,
                l: pick(b.left, b.insideV, c === g.c0, st.border.l) ?? undefined,
                r: pick(b.right, b.insideV, c === g.c1, st.border.r) ?? undefined,
              };
              const id = out.styles.id({ ...st, border: Object.fromEntries(Object.entries(border).filter(([, v]) => v)) });
              cells.set(k, { ...(cell ?? { v: null }), s: id });
            }
          return { ...s, cells };
        });
      }
    }
    if (res.merge === true) out = ops.mergeCells(out, si, lastRange, 'merge');
    if (res.merge === false) out = ops.unmergeCells(out, si, lastRange);
    const rows: number[] = [];
    for (const g of sel.ranges) for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 2000, sheetExtent(sheet).rows + 1); r++) rows.push(r);
    push(autoRows(out, si, rows), 'Format Cells');
  };

  const shownDecimals = () => {
    const v = value(sel.active.r, sel.active.c);
    if (typeof v !== 'number') return 0;
    const t = formatValue(v, 'General', wb.date1904, 11).text;
    const m = /\.(\d+)/.exec(t);
    return m ? m[1].length : 0;
  };

  // ---- Commands --------------------------------------------------------------------------------------

  const toggleFlag = (what: 'bold' | 'italic' | 'underline' | 'strike') => {
    const on = !activeStyle.font[what];
    formatSel((s) => ({ ...s, font: { ...s.font, [what]: what === 'underline' ? (on ? 'single' : undefined) : on || undefined } }), what === 'bold' ? 'Bold' : what === 'italic' ? 'Italic' : what === 'underline' ? 'Underline' : 'Strikethrough');
  };

  const pickedHex = (c: PickedColor | null) => (c ? c.hex.toUpperCase() : null);

  const cmd: Cmd = {
    paste: (mode) => doPaste(mode),
    cut: () => doCopy(true),
    copy: () => doCopy(false),
    painter: (sticky) => {
      if (painter) return setPainter(null);
      const g = clampToData(lastRange);
      const cells: (number | undefined)[][] = [];
      for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 200); r++) {
        const row: (number | undefined)[] = [];
        for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 100); c++) row.push(styleIdAt(sheet, r, c));
        cells.push(row);
      }
      setPainter({ cells, sticky });
      setMessage('Click a cell or drag over cells to paste the formatting.');
    },
    font: (name) => {
      formatSel((s) => ({ ...s, font: { ...s.font, name } }), 'Font', true);
      requestAnimationFrame(() => sinkRef.current?.focus());
    },
    size: (pt) => {
      formatSel((s) => ({ ...s, font: { ...s.font, size: pt } }), 'Font Size', true);
      requestAnimationFrame(() => sinkRef.current?.focus());
    },
    growFont: (dir) => formatSel((s) => ({ ...s, font: { ...s.font, size: stepFontSize(s.font.size, dir) } }), 'Font Size', true),
    toggle: toggleFlag,
    underline: (kind) => formatSel((s) => ({ ...s, font: { ...s.font, underline: s.font.underline === kind ? undefined : kind } }), 'Underline'),
    border: (preset) => {
      let out = wb;
      for (const g of sel.ranges) out = ops.applyBorders(out, si, clampToData(g), preset);
      push(out, 'Borders');
    },
    fontColor: (c) => {
      setFontColor(pickedHex(c));
      formatSel((s) => ({ ...s, font: { ...s.font, color: pickedHex(c) ?? undefined } }), 'Font Color');
    },
    fillColor: (c) => {
      setFillColor(pickedHex(c));
      formatSel((s) => ({ ...s, fill: pickedHex(c), pattern: undefined }), 'Fill Color');
    },
    valign: (v) => formatSel((s) => ({ ...s, v }), 'Alignment'),
    halign: (h) => formatSel((s) => ({ ...s, h: activeStyle.h === h ? 'general' : h }), 'Alignment'),
    wrap: () => formatSel((s) => ({ ...s, wrap: !activeStyle.wrap || undefined }), 'Wrap Text', true),
    rotate: (deg) => formatSel((s) => ({ ...s, rotate: deg || undefined }), 'Orientation'),
    merge: (how) => {
      const g = lastRange;
      let filled = 0;
      cellsIn(sheet, g, (_r, _c, cell) => {
        if (cell.v !== null || cell.f !== undefined) filled++;
      });
      if (filled > 1 && how !== 'across') setMessage('Merging cells only keeps the upper-left value and discards other values.');
      push(ops.mergeCells(wb, si, g, how), how === 'center' ? 'Merge & Center' : 'Merge Cells');
      selectRange(g);
    },
    unmerge: () => push(ops.unmergeCells(wb, si, lastRange), 'Unmerge Cells'),
    indent: (dir) => formatSel((s) => ({ ...s, indent: Math.max(0, (s.indent ?? 0) + dir) || undefined, h: dir > 0 && (s.h === 'general' || s.h === 'center') ? 'left' : s.h }), 'Indent'),
    numFmt: (code) => formatSel((s) => ({ ...s, numFmt: code }), 'Number Format'),
    decimals: (dir) => {
      const d = shownDecimals();
      formatSel((s) => ({ ...s, numFmt: changeDecimals(s.numFmt, dir, d) }), dir > 0 ? 'Increase Decimal' : 'Decrease Decimal');
    },
    formatDialog: (t = 'number') => setDialog({ kind: 'format', tab: t }),
    cellStyle: (name) => {
      const def = CELL_STYLES.find((c) => c.name === name);
      if (def) formatSel((s) => def.apply(s, wb.theme), 'Cell Style', true);
    },
    insert: (kind) => {
      if (kind === 'sheet') return addSheet();
      if (kind === 'rows') return insertRowsCols('row');
      if (kind === 'cols') return insertRowsCols('col');
      if (sel.ranges.every(isWholeRows)) return insertRowsCols('row');
      if (sel.ranges.every(isWholeCols)) return insertRowsCols('col');
      setDialog({ kind: 'insert' });
    },
    remove: (kind) => {
      if (kind === 'sheet') return deleteSheet(si);
      if (kind === 'rows') return insertRowsCols('row', true);
      if (kind === 'cols') return insertRowsCols('col', true);
      if (sel.ranges.every(isWholeRows)) return insertRowsCols('row', true);
      if (sel.ranges.every(isWholeCols)) return insertRowsCols('col', true);
      setDialog({ kind: 'delete' });
    },
    rowHeight: () => setDialog({ kind: 'size', what: 'row' }),
    colWidth: () => setDialog({ kind: 'size', what: 'col' }),
    defaultWidth: () => setDialog({ kind: 'size', what: 'std' }),
    autofit: (kind) => autofit(kind),
    hide: (kind) => (kind === 'sheet' ? hideSheet(si) : hide(kind, true)),
    unhide: (kind) => (kind === 'sheet' ? setDialog({ kind: 'unhide' }) : hide(kind, false)),
    renameSheet: () => setRenaming(si),
    moveSheet: () => setDialog({ kind: 'moveSheet' }),
    tabColor: (c) => push(ops.updateSheet(wb, si, (s) => ({ ...s, tabColor: pickedHex(c) })), 'Tab Color'),
    autoSum,
    fill: (dir) => {
      const g = lastRange;
      if (dir === 'down' || dir === 'right') push(ops.fillDownRight(wb, si, g, dir), dir === 'down' ? 'Fill Down' : 'Fill Right');
      else if (dir === 'up') push(ops.fillRange(wb, si, { ...g, r0: g.r1 }, g, true), 'Fill Up');
      else if (dir === 'left') push(ops.fillRange(wb, si, { ...g, c0: g.c1 }, g, true), 'Fill Left');
      else {
        // Series: extend the pattern of the filled cells at the top through the rest of the selection.
        let last = g.r0;
        while (last < g.r1 && sheet.cells.get(cellKey(last + 1, g.c0))?.v != null) last++;
        push(ops.fillRange(wb, si, { ...g, r1: last }, g), 'Fill Series');
      }
    },
    clear: clearSel,
    sort: (asc) => {
      const { g, header } = sortRange();
      sortBy([{ col: sel.active.c, asc }], g, header);
    },
    customSort: () => setDialog({ kind: 'sort', ...sortRange() }),
    removeDuplicates: () => setDialog({ kind: 'dups', ...sortRange() }),
    find: (replace) => setDialog({ kind: 'find', replace }),
    goTo: () => setDialog({ kind: 'goto' }),
    insertFunction: (category) => setDialog({ kind: 'function', category }),
    useFunction: (name) => {
      if (name.startsWith('symbol:')) return insertIntoEdit(name.slice(7));
      const insert = `${name}(`;
      if (edit) insertIntoEdit(insert);
      else startEdit({ text: `=${insert}`, mode: 'enter' });
      setRecentFns((l) => [name, ...l.filter((x) => x !== name)].slice(0, 10));
    },
    nameManager: () => setDialog({ kind: 'names' }),
    defineName: () => setDialog({ kind: 'defineName', name: '', formula: `${quoteSheet(sheet.name)}!${absRef(lastRange)}` }),
    freeze: (kind) => {
      const top = gridApi.current?.topLeft() ?? { r: 0, c: 0 };
      const freeze = kind === 'none' ? { rows: 0, cols: 0 } : kind === 'row' ? { rows: 1, cols: 0 } : kind === 'col' ? { rows: 0, cols: 1 } : { rows: Math.max(0, sel.active.r), cols: Math.max(0, sel.active.c) };
      if (kind === 'panes' && sel.active.r === 0 && sel.active.c === 0) freeze.rows = Math.max(1, Math.floor((top.r + 10) / 2));
      push(ops.updateSheet(wb, si, (s) => ({ ...s, freeze, top: { r: 0, c: 0 } })), kind === 'none' ? 'Unfreeze Panes' : 'Freeze Panes');
      requestAnimationFrame(() => gridApi.current?.scrollTo({ r: 0, c: 0 }));
    },
    view: (what) => {
      if (what === 'formulaBar') return setFormulaBar((f) => !f);
      push(ops.updateSheet(wb, si, (s) => ({ ...s, [what]: !s[what] })), what === 'gridlines' ? 'Gridlines' : 'Headings');
    },
    zoomDialog: () => setDialog({ kind: 'zoom' }),
    zoomTo: (z) => setZoom(z),
    zoomSelection: () => zoomToSelection(),
    showFormulas: () => setShowFormulas((v) => !v),
    calculate: recalculate,
    orientation: (o) => push(ops.updateSheet(wb, si, (s) => ({ ...s, page: { ...s.page, orientation: o } })), 'Orientation'),
    margins: (kind) => {
      const m = kind === 'wide' ? { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 } : kind === 'narrow' ? { left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } : { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
      push(ops.updateSheet(wb, si, (s) => ({ ...s, page: { ...s.page, margins: m } })), 'Margins');
    },
    newSheet: () => addSheet(),
    selectAll: () => selectAll(),
    link: () => setDialog({ kind: 'link' }),
    status: (what) => {
      if (what === 'stats') {
        let cells = 0;
        let formulas = 0;
        const ext = sheetExtent(sheet);
        for (const c of sheet.cells.values()) {
          if (c.v !== null || c.f !== undefined) cells++;
          if (c.f !== undefined) formulas++;
        }
        let allCells = 0;
        for (const s of wb.sheets) for (const c of s.cells.values()) if (c.v !== null || c.f !== undefined) allCells++;
        setDialog({
          kind: 'message',
          title: 'Workbook Statistics',
          text: `Current sheet: ${sheet.name}\nEnd of sheet: ${ext.rows >= 0 ? cellName(ext.rows, ext.cols) : 'A1'}\nCells with data: ${cells.toLocaleString()}\nFormulas: ${formulas.toLocaleString()}\n\nWorkbook\nSheets: ${wb.sheets.length}\nCells with data: ${allCells.toLocaleString()}\nDefined names: ${wb.names.filter((n) => !n.hidden).length}`,
        });
      }
    },
  };

  const zoomToSelection = () => {
    const g = lastRange;
    const geo = gridApi.current?.geometry();
    if (!geo) return;
    const w = geo.cols.pos(g.c1 + 1) - geo.cols.pos(g.c0);
    const h = geo.rows.pos(Math.min(g.r1, g.r0 + 500) + 1) - geo.rows.pos(g.r0);
    const z = Math.floor(Math.min((geo.width - geo.hw - 20) / w, (geo.height - geo.hh - 20) / h) * 100);
    setZoom(Math.max(10, Math.min(400, z)));
    requestAnimationFrame(() => gridApi.current?.scrollTo({ r: g.r0, c: g.c0 }));
  };

  const selectAll = () => {
    const region = ops.currentRegion(sheet, sel.active.r, sel.active.c);
    const isRegion = region.r0 !== region.r1 || region.c0 !== region.c1;
    const already = lastRange.r0 === region.r0 && lastRange.r1 === region.r1 && lastRange.c0 === region.c0 && lastRange.c1 === region.c1;
    if (isRegion && !already && sheet.cells.get(cellKey(sel.active.r, sel.active.c))) setSel({ active: sel.active, ranges: [region] });
    else setSel({ active: sel.active, ranges: [{ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }] });
  };

  // ---- Sheets ----------------------------------------------------------------------------------------

  const addSheet = () => {
    const at = si + 1;
    push(ops.addSheet(wb, at), 'Insert Sheet', at);
    setActive(at);
  };

  const deleteSheet = (i: number) => {
    if (wb.sheets.filter((s) => !s.hidden).length < 2) {
      setDialog({ kind: 'message', title: 'Spreadsheet', text: 'A workbook must contain at least one visible worksheet.' });
      return;
    }
    const out = ops.deleteSheet(wb, i);
    push(out, 'Delete Sheet', out.active);
    setActive(out.active);
  };

  const hideSheet = (i: number) => {
    if (wb.sheets.filter((s) => !s.hidden).length < 2) return;
    let next = i + 1;
    while (next < wb.sheets.length && wb.sheets[next].hidden) next++;
    if (next >= wb.sheets.length) {
      next = i - 1;
      while (next > 0 && wb.sheets[next].hidden) next--;
    }
    push(ops.updateSheet(wb, i, (s) => ({ ...s, hidden: true })), 'Hide Sheet', next);
    setActive(next);
  };

  const switchSheet = (i: number) => {
    if (i === si) return;
    // While pointing at cells for a formula, other sheets can be pointed at too.
    if (edit && isFormulaText(edit.text) && (edit.point || canInsertRef(edit.text, edit.s))) {
      setActive(i);
      setEdit({ ...edit, point: edit.point ? { ...edit.point, sheet: i } : null, where: edit.where });
      return;
    }
    if (edit && !commitEdit(0, 0)) return;
    setActive(i);
    setClip((c) => c);
    extRef.current = null;
    requestAnimationFrame(() => sinkRef.current?.focus());
  };

  /** Follow a cell's hyperlink: a place in the workbook, or a web page in the Web Browser. */
  const followLink = (link: string) => {
    if (link.startsWith('#')) {
      goTo(link.slice(1));
      return;
    }
    const url = /^https?:\/\//i.test(link) ? sanitizeNavigationUrl(link) : null;
    if (!url) {
      setMessage('Spreadsheet can only open web (http and https) links.');
      return;
    }
    if (!isWebviewAvailable()) window.open(url, '_blank', 'noopener,noreferrer');
    else {
      if (!hasTabConsumer()) openWindow('web-browser');
      publishTabCommand({ type: 'open', url });
    }
  };

  const insertLink = (text: string, url: string) => {
    const { r, c } = sel.active;
    const k = cellKey(r, c);
    const cell = sheet.cells.get(k);
    const base = cell?.s ?? styleIdAt(sheet, r, c);
    const s = wb.styles.derive(base, (st) => ({ ...st, font: { ...st.font, color: wb.theme.colors.hlink, underline: 'single' } }));
    const v: Scalar = text ? text : cell && (cell.v !== null || cell.f !== undefined) ? cell.v : url.replace(/^#/, '');
    const next: Cell = cell?.f !== undefined && !text ? { ...cell, s } : { v, s };
    push(ops.updateSheet(wb, si, (x) => ({ ...ops.withCells(x, [[k, next]]), links: new Map(x.links).set(k, url) })), 'Insert Hyperlink');
  };

  // ---- Grid gestures ---------------------------------------------------------------------------------

  const onCellDown = (r: number, c: number, e: { shift: boolean; ctrl: boolean; time: number }): DragKind => {
    setMenu(null);
    if (edit) {
      if (canPoint(edit)) {
        const anchor = e.shift && edit.point ? edit.point.anchor : { r, c };
        pointTo(anchor, { r, c });
        return 'point';
      }
      if (!commitEdit(0, 0)) return 'none';
      if (edit.sheet !== si) return 'none';
    }
    findState.current = null;
    tabStart.current = null;
    linkClick.current = !e.shift && !e.ctrl && sheet.links.has(cellKey(r, c)) ? { r, c, t: e.time } : null;
    if (e.shift) {
      const g = expandMerges(sheet, normRange({ r0: sel.active.r, c0: sel.active.c, r1: r, c1: c }));
      setSel({ active: sel.active, ranges: [...sel.ranges.slice(0, -1), g] });
      extRef.current = { r, c };
      dragStart.current = { r: sel.active.r, c: sel.active.c, ctrl: false };
      return 'select';
    }
    const m = mergeAt(sheet, r, c);
    const g = m ?? one(r, c);
    if (e.ctrl) setSel({ active: { r: g.r0, c: g.c0 }, ranges: [...sel.ranges, g] });
    else setSel({ active: { r: g.r0, c: g.c0 }, ranges: [g] });
    extRef.current = { r, c };
    dragStart.current = { r: g.r0, c: g.c0, ctrl: e.ctrl };
    return 'select';
  };

  const onCellDrag = (r: number, c: number, kind: DragKind) => {
    if (kind === 'point' && edit?.point) {
      pointTo(edit.point.anchor, { r, c });
      return;
    }
    const start = dragStart.current;
    if (!start) return;
    if (linkClick.current && (linkClick.current.r !== r || linkClick.current.c !== c)) linkClick.current = null;
    const g = expandMerges(sheet, normRange({ r0: start.r, c0: start.c, r1: r, c1: c }));
    const ranges = sel.ranges.slice(0, -1);
    setSel({ active: { r: start.r, c: start.c }, ranges: [...ranges, g] });
    extRef.current = { r, c };
    const big = g.r1 - g.r0 + 1 > 1 || g.c1 - g.c0 + 1 > 1;
    setDragName(big ? `${g.r1 - g.r0 + 1}R x ${g.c1 - g.c0 + 1}C` : null);
  };

  const onCellUp = (kind: DragKind, time: number) => {
    setDragName(null);
    dragStart.current = null;
    // Click once to follow a link; click and hold to select the cell.
    const lc = linkClick.current;
    linkClick.current = null;
    if (kind === 'select' && lc && time - lc.t < 450) {
      const link = sheet.links.get(cellKey(lc.r, lc.c));
      if (link) followLink(link);
    }
    if (kind === 'point') {
      const el = edit?.where === 'bar' ? barRef.current : editorRef.current;
      el?.focus();
      return;
    }
    if (painter) {
      // Paste the copied formats over the selection, repeating the copied block.
      const g = lastRange;
      const h = painter.cells.length;
      const w = painter.cells[0]?.length ?? 1;
      const updates: [number, Cell | null][] = [];
      for (let r = g.r0; r <= Math.max(g.r1, g.r0 + h - 1); r++)
        for (let c = g.c0; c <= Math.max(g.c1, g.c0 + w - 1); c++) {
          const s = painter.cells[(r - g.r0) % h][(c - g.c0) % w];
          const ex = sheet.cells.get(cellKey(r, c));
          updates.push([cellKey(r, c), ex ? { ...ex, s } : s ? { v: null, s } : null]);
        }
      push(ops.updateSheet(wb, si, (s) => ops.withCells(s, updates)), 'Format Painter');
      if (!painter.sticky) {
        setPainter(null);
        setMessage(null);
      }
    }
    if (!edit) sinkRef.current?.focus();
  };

  const onHeaderDown = (kind: 'col' | 'row' | 'all', index: number, e: { shift: boolean; ctrl: boolean }) => {
    if (edit && !canPoint(edit) && !commitEdit(0, 0)) return;
    if (kind === 'all') {
      setSel({ active: sel.active, ranges: [{ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }] });
      return;
    }
    const g: Range = kind === 'col' ? { r0: 0, c0: index, r1: MAX_ROWS - 1, c1: index } : { r0: index, c0: 0, r1: index, c1: MAX_COLS - 1 };
    if (edit && canPoint(edit)) {
      const ref = kind === 'col' ? `${colName(index)}:${colName(index)}` : `${index + 1}:${index + 1}`;
      insertIntoEdit(ref);
      return;
    }
    if (e.shift) {
      const a = kind === 'col' ? sel.active.c : sel.active.r;
      const ng: Range = kind === 'col' ? { r0: 0, c0: Math.min(a, index), r1: MAX_ROWS - 1, c1: Math.max(a, index) } : { r0: Math.min(a, index), c0: 0, r1: Math.max(a, index), c1: MAX_COLS - 1 };
      setSel({ active: sel.active, ranges: [...sel.ranges.slice(0, -1), ng] });
      return;
    }
    const top = gridApi.current?.topLeft() ?? { r: 0, c: 0 };
    const active = kind === 'col' ? { r: top.r, c: index } : { r: index, c: top.c };
    setSel({ active, ranges: e.ctrl ? [...sel.ranges, g] : [g] });
    dragStart.current = { r: active.r, c: active.c, ctrl: e.ctrl };
  };

  const onHeaderDrag = (kind: 'col' | 'row', index: number) => {
    const start = dragStart.current;
    if (!start) return;
    const a = kind === 'col' ? start.c : start.r;
    const g: Range = kind === 'col' ? { r0: 0, c0: Math.min(a, index), r1: MAX_ROWS - 1, c1: Math.max(a, index) } : { r0: Math.min(a, index), c0: 0, r1: Math.max(a, index), c1: MAX_COLS - 1 };
    setSel({ active: sel.active, ranges: [...sel.ranges.slice(0, -1), g] });
    setDragName(kind === 'col' ? `${g.c1 - g.c0 + 1}C` : `${g.r1 - g.r0 + 1}R`);
  };

  const onResize = (kind: 'col' | 'row', index: number, px: number) => {
    // Resizing one of several selected whole columns resizes them all.
    const axisSel = kind === 'col' ? sel.ranges.filter(isWholeCols) : sel.ranges.filter(isWholeRows);
    const inSel = axisSel.some((g) => (kind === 'col' ? index >= g.c0 && index <= g.c1 : index >= g.r0 && index <= g.r1));
    const idx = inSel ? selectedIndexes(kind) : [index];
    setSizes(kind, px, idx, kind === 'col' ? 'Column Width' : 'Row Height');
  };

  const onFill = (src: Range, dest: Range, ctrl: boolean) => {
    // Dragging back into the selection clears what's left behind, as Excel does.
    if (dest.r1 < src.r1 || dest.c1 < src.c1) {
      if (dest.r0 === src.r0 && dest.c0 === src.c0 && (dest.r1 < src.r1 || dest.c1 < src.c1)) {
        const cleared: Range = dest.r1 < src.r1 ? { ...src, r0: dest.r1 + 1 } : { ...src, c0: dest.c1 + 1 };
        push(ops.clearRanges(wb, si, [cleared], 'contents'), 'Clear');
        selectRange(dest, sel.active);
        return;
      }
    }
    const single = src.r0 === src.r1 && src.c0 === src.c1;
    const cell = sheet.cells.get(cellKey(src.r0, src.c0));
    // One number copies; Ctrl makes it a series (and the reverse for everything else).
    const numeric = single && typeof cell?.v === 'number' && cell.f === undefined && !isDateFormat(wb.styles.get(cell.s).numFmt);
    const copyOnly = numeric ? !ctrl : ctrl;
    push(ops.fillRange(wb, si, src, dest, copyOnly), 'Auto Fill');
    selectRange(dest, sel.active);
  };

  /** Double-clicking the fill handle fills down as far as the data beside it goes. */
  const onFillDouble = () => {
    const src = lastRange;
    const has = (r: number, c: number) => {
      const cell = sheet.cells.get(cellKey(r, c));
      return !!cell && (cell.v !== null || cell.f !== undefined);
    };
    const reach = (c: number) => {
      if (c < 0 || c >= MAX_COLS) return src.r1;
      let r = src.r1;
      while (r + 1 < MAX_ROWS && has(r + 1, c)) r++;
      return r;
    };
    let end = reach(src.c0 - 1);
    if (end <= src.r1) end = reach(src.c1 + 1);
    if (end > src.r1) onFill(src, { ...src, r1: end }, false);
  };

  const onMoveRange = (src: Range, to: { r: number; c: number }, copy: boolean) => {
    const c = buildClip(!copy);
    if (!c) return;
    setSelFor(sheet.id, { active: to, ranges: [{ r0: to.r, c0: to.c, r1: to.r + src.r1 - src.r0, c1: to.c + src.c1 - src.c0 }] });
    const out = ops.paste(wb, si, to, c, 'all');
    push(out, copy ? 'Copy' : 'Move');
    setClip(null);
  };

  // ---- Clipboard events (from the grid's focus target) ------------------------------------------------

  const onCopyEvent = (e: React.ClipboardEvent) => doCopy(false, e);
  const onCutEvent = (e: React.ClipboardEvent) => doCopy(true, e);
  const onPasteEvent = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (clip && (text === clip.text || !text)) pasteClip(clip);
    else if (text) pasteText(text);
  };

  // ---- Keyboard ----------------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog || backstage) return;
    const target = e.target as HTMLElement;
    const inEditor = target === editorRef.current || target === barRef.current;
    if (!inEditor && (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || (target instanceof HTMLTextAreaElement && target !== sinkRef.current))) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Shortcuts that work everywhere.
    if (ctrl && !e.altKey) {
      const k = key.toLowerCase();
      if (k === 's' && !e.shiftKey) return handled(), saveNow();
      if (k === 'o') return handled(), void file.browse();
      if (k === 'n') return handled(), file.newWindow();
      // While typing, undo and redo work on the text.
      if (k === 'z' && !e.shiftKey && !edit) return handled(), undo();
      if ((k === 'y' || (k === 'z' && e.shiftKey)) && !edit) return handled(), redo();
      if (k === 'f1') return handled(), setCollapsed((c) => !c);
      if (k === 'u' && e.shiftKey) return handled(), setBarExpanded((x) => !x);
    }
    if (key === 'F12') return handled(), void file.saveAs();

    if (edit) {
      const sug = suggest(edit.text, edit.s, wb.names.map((n) => n.name));
      if (sug && (key === 'ArrowDown' || key === 'ArrowUp') && !ctrl) {
        handled();
        setEdit({ ...edit, ac: (edit.ac + (key === 'ArrowDown' ? 1 : sug.items.length - 1)) % sug.items.length });
        return;
      }
      if (sug && key === 'Tab') {
        handled();
        pickSuggestion(sug.items[edit.ac % sug.items.length]);
        return;
      }
      if (key === 'Enter') {
        handled();
        if (e.altKey) {
          insertIntoEdit('\n');
          return;
        }
        if (ctrl) commitEdit(0, 0, { all: true });
        else commitEdit(e.shiftKey ? -1 : 1, 0);
        return;
      }
      if (key === 'Tab') {
        handled();
        commitEdit(0, e.shiftKey ? -1 : 1);
        return;
      }
      if (key === 'Escape') {
        handled();
        cancelEdit();
        return;
      }
      if (key === 'F4') {
        handled();
        const res = cycleAbsolute(edit.text, edit.s);
        if (res) setEdit({ ...edit, text: res.text, s: res.end, e: res.end, point: null });
        return;
      }
      if (key === 'F2') {
        handled();
        setEdit({ ...edit, mode: edit.mode === 'edit' ? 'enter' : 'edit', point: null });
        return;
      }
      if (ctrl && key.toLowerCase() === 'a' && edit.text.startsWith('=')) {
        handled();
        setDialog({ kind: 'function' });
        return;
      }
      if (key.startsWith('Arrow') && edit.mode === 'enter' && edit.where === 'cell') {
        const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key] as [number, number];
        if (canPoint(edit)) {
          handled();
          const p = edit.point;
          const from = p ? p.cur : { r: edit.r, c: edit.c };
          const next = ctrl ? ops.dataEdge(sheet, from.r, from.c, d[0], d[1]) : step(from.r, from.c, d[0], d[1]);
          pointTo(e.shiftKey && p ? p.anchor : next, next);
          return;
        }
        handled();
        commitEdit(d[0], d[1]);
        return;
      }
      return;
    }

    // Ready mode.
    const shift = e.shiftKey;
    const k = key.toLowerCase();
    if (ctrl && !e.altKey) {
      if (k === 'b' || k === '2') return handled(), toggleFlag('bold');
      if (k === 'i' || k === '3') return handled(), toggleFlag('italic');
      if (k === 'u' || k === '4') return handled(), toggleFlag('underline');
      if (k === '5') return handled(), toggleFlag('strike');
      if (k === '1' && !shift) return handled(), setDialog({ kind: 'format', tab: 'number' });
      if (key === '~' || (shift && k === '`')) return handled(), cmd.numFmt('General');
      if (key === '$' || (shift && k === '4')) return handled(), cmd.numFmt('"$"#,##0.00_);\\("$"#,##0.00\\)');
      if (key === '%' || (shift && k === '5')) return handled(), cmd.numFmt('0%');
      if (key === '^' || (shift && k === '6')) return handled(), cmd.numFmt('0.00E+00');
      if (key === '#' || (shift && k === '3')) return handled(), cmd.numFmt('d-mmm-yy');
      if (key === '@' || (shift && k === '2')) return handled(), cmd.numFmt('h:mm AM/PM');
      if (key === '!' || (shift && k === '1')) return handled(), cmd.numFmt('#,##0.00');
      if (key === '&' || (shift && k === '7')) return handled(), cmd.border('outside');
      if (key === '_' || (shift && k === '-')) return handled(), cmd.border('none');
      if (key === '>' || (shift && k === '.')) return handled(), cmd.growFont(1);
      if (key === '<' || (shift && k === ',')) return handled(), cmd.growFont(-1);
      if (k === '`') return handled(), setShowFormulas((v) => !v);
      if (key === ';') return handled(), startEdit({ text: formatValue(todaySerial(wb.date1904), 'm/d/yyyy').text, mode: 'enter' });
      if (key === ':' || (shift && key === ';')) return handled(), startEdit({ text: formatValue(nowSerial(wb.date1904), 'h:mm AM/PM').text, mode: 'enter' });
      if (k === 'd') return handled(), cmd.fill('down');
      if (k === 'r') return handled(), cmd.fill('right');
      if (k === 'f') return handled(), setDialog({ kind: 'find', replace: false });
      if (k === 'h') return handled(), setDialog({ kind: 'find', replace: true });
      if (k === 'g') return handled(), setDialog({ kind: 'goto' });
      if (k === 'a') return handled(), selectAll();
      if (key === '+' || key === '=' || (shift && key === '=')) return handled(), cmd.insert('cells');
      if (key === '-') return handled(), cmd.remove('cells');
      if (key === '9' || key === '(') return handled(), hide('row', !shift && key === '9');
      if (key === '0' || key === ')') return handled(), hide('col', !shift && key === '0');
      if (key === ' ') return handled(), setSel({ active: sel.active, ranges: [{ r0: 0, c0: lastRange.c0, r1: MAX_ROWS - 1, c1: lastRange.c1 }] });
      if (key === 'PageDown' || key === 'PageUp') {
        handled();
        const dir = key === 'PageDown' ? 1 : -1;
        let i = si + dir;
        while (i >= 0 && i < wb.sheets.length && wb.sheets[i].hidden) i += dir;
        if (i >= 0 && i < wb.sheets.length) switchSheet(i);
        return;
      }
      if (key === 'Home') return handled(), selectCell(sheet.freeze.rows, sheet.freeze.cols);
      if (key === 'End') {
        handled();
        const ext = sheetExtent(sheet);
        return selectCell(Math.max(0, ext.rows), Math.max(0, ext.cols));
      }
      if (k === 'k') return handled(), setDialog({ kind: 'link' });
      if (k === 'l' || k === 't') return handled(), setMessage('That feature isn’t available in Spreadsheet yet.');
      if (k === 'c' || k === 'x' || k === 'v') return; // Native copy / cut / paste events.
    }
    if (e.altKey && (key === '=' || key === '+')) return handled(), autoSum('SUM');
    if (e.altKey && key === 'Enter') return handled(), startEdit({ mode: 'edit' });
    if (shift && key === ' ' && !ctrl) return handled(), setSel({ active: sel.active, ranges: [{ r0: lastRange.r0, c0: 0, r1: lastRange.r1, c1: MAX_COLS - 1 }] });
    if (shift && key === 'F11') return handled(), addSheet();
    if (shift && key === 'F3') return handled(), setDialog({ kind: 'function' });
    switch (key) {
      case 'ArrowUp':
        return handled(), navigate(-1, 0, shift, ctrl);
      case 'ArrowDown':
        return handled(), navigate(1, 0, shift, ctrl);
      case 'ArrowLeft':
        return handled(), navigate(0, -1, shift, ctrl);
      case 'ArrowRight':
        return handled(), navigate(0, 1, shift, ctrl);
      case 'Enter':
        return handled(), moveWithin(shift ? -1 : 1, 0);
      case 'Tab':
        return handled(), moveWithin(0, shift ? -1 : 1);
      case 'Home':
        return handled(), shift ? navigate(0, -sel.active.c, true, false) : selectCell(sel.active.r, 0);
      case 'PageDown':
      case 'PageUp': {
        handled();
        const n = gridApi.current?.pageRows() ?? 20;
        const dir = key === 'PageDown' ? 1 : -1;
        if (e.altKey) return navigate(0, dir * 10, shift, false);
        const r = Math.max(0, Math.min(MAX_ROWS - 1, sel.active.r + dir * n));
        if (shift) navigate(r - (extRef.current?.r ?? sel.active.r), 0, true, false);
        else selectCell(r, sel.active.c);
        return;
      }
      case 'Delete':
        return handled(), clearSel('contents');
      case 'Backspace':
        return handled(), startEdit({ text: '', mode: 'enter' });
      case 'F2':
        return handled(), startEdit({ mode: 'edit' });
      case 'F5':
        return handled(), setDialog({ kind: 'goto' });
      case 'F9':
        return handled(), recalculate();
      case 'Escape':
        handled();
        setClip(null);
        setPainter(null);
        setMessage(null);
        return;
    }
    if (key.length === 1 && !ctrl && !e.altKey) {
      handled();
      startEdit({ text: key, mode: 'enter' });
    }
  };

  // ---- Derived view state ------------------------------------------------------------------------------

  const highlights: Highlight[] = useMemo(() => {
    if (!edit || !isFormulaText(edit.text)) return [];
    const out: Highlight[] = [];
    for (const r of coloredRefs(edit.text)) {
      const sName = r.ref.sheet;
      const s = sName === null ? edit.sheet : wb.sheets.findIndex((x) => x.name.toLowerCase() === sName.toLowerCase());
      if (s !== si) continue;
      out.push({ range: normRange({ r0: r.ref.r0, c0: r.ref.c0, r1: r.ref.r1, c1: r.ref.c1 }), color: r.color, dashed: !!edit.point && edit.point.start === r.start });
    }
    return out;
  }, [edit, wb, si]);

  const stats = useMemo(() => {
    let count = 0;
    let numCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const seen = new Set<number>();
    for (const g of sel.ranges) {
      cellsIn(sheet, g, (r, c, cell) => {
        const k = cellKey(r, c);
        if (seen.has(k)) return;
        seen.add(k);
        const v = cell.f !== undefined ? calc.value(si, r, c) : cell.v;
        if (v === null || v === '') return;
        count++;
        if (typeof v === 'number') {
          numCount++;
          sum += v;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      });
    }
    return { count, numCount, sum, min, max };
  }, [sel, sheet, calc, si]);

  const multiCell = sel.ranges.length > 1 || lastRange.r0 !== lastRange.r1 || lastRange.c0 !== lastRange.c1;
  const statFmt = (n: number) => {
    const fmt = activeStyle.numFmt;
    const t = fmt !== 'General' && !isDateFormat(fmt) ? formatValue(n, fmt, wb.date1904, 255).text.trim() : formatValue(Number(n.toPrecision(15)), 'General', wb.date1904, 14).text;
    return t;
  };

  const nameBoxText = (() => {
    if (dragName) return dragName;
    const g = lastRange;
    const named = wb.names.find((n) => {
      const r = parseRange(n.formula.slice(n.formula.lastIndexOf('!') + 1));
      return r && !n.hidden && r.r0 === g.r0 && r.c0 === g.c0 && r.r1 === g.r1 && r.c1 === g.c1 && (n.formula.includes('!') ? n.formula.toLowerCase().startsWith(quoteSheet(sheet.name).toLowerCase() + '!') : true);
    });
    if (named) return named.name;
    return cellName(sel.active.r, sel.active.c);
  })();

  const kept = !keptDismissed && wb.sheets.some((sh) => sh.kept?.dv);
  const barText = edit ? edit.text : contentText(activeCell, activeStyle);
  const status = edit ? (edit.point ? 'Point' : edit.mode === 'edit' ? 'Edit' : 'Enter') : 'Ready';
  const circ = calc.circular[0];
  const visibleNames = wb.names.filter((n) => !n.hidden).map((n) => n.name);

  const ribbonState: RibbonState = {
    style: activeStyle,
    theme: wb.theme,
    merged: !!mergeAt(sheet, sel.active.r, sel.active.c),
    freeze: sheet.freeze,
    gridlines: sheet.gridlines,
    headings: sheet.headings,
    formulaBar,
    showFormulas,
    painter: !!painter,
    canPaste: !!clip,
    fontColor,
    fillColor,
    orientation: sheet.page.orientation,
    sheetCount: wb.sheets.length,
  };

  const templates: Template[] = [
    {
      id: 'blank',
      name: 'Blank workbook',
      preview: (
        <span className="block h-[110px] bg-white bg-[linear-gradient(#e1e1e1_1px,transparent_1px),linear-gradient(90deg,#e1e1e1_1px,transparent_1px)] bg-[length:28px_12px]" />
      ),
      create: () => openTemplate(newWorkbook()),
    },
    {
      id: 'budget',
      name: 'Monthly budget',
      preview: <TemplatePreview title="Monthly Budget" color="#107c41" rows={7} />,
      create: () => openTemplate(budgetTemplate()),
    },
    {
      id: 'invoice',
      name: 'Simple invoice',
      preview: <TemplatePreview title="INVOICE" color="#1f4e79" rows={5} />,
      create: () => openTemplate(invoiceTemplate()),
    },
    {
      id: 'todo',
      name: 'To-do list',
      preview: <TemplatePreview title="To-Do List" color="#7030a0" rows={6} />,
      create: () => openTemplate(todoTemplate()),
    },
  ];

  const openTemplate = (next: Workbook) => {
    setBackstage(null);
    // A fresh window keeps this one; an untouched blank one is reused.
    if (file.dirty || file.path || hist.entries.length > 1) {
      file.newWindow();
      setMessage('A new window was opened; templates open in the window they’re picked from when it’s empty.');
      return;
    }
    resetTo(next, 'New');
    setLost([]);
    file.setDirty(next.sheets[0].cells.size > 0);
  };

  // ---- Render ------------------------------------------------------------------------------------------

  if (!file.fs) {
    return <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">The Spreadsheet needs the Electron shell to read and save files.</p>;
  }

  const activeView = edit && edit.sheet === si ? { r: edit.r, c: edit.c, text: edit.text, selStart: edit.s, selEnd: edit.e, where: edit.where, acIndex: edit.ac } : null;

  return (
    <OfficeFrame ref={frameRef} app="excel" onKeyDown={onKeyDown}>
      <TitleBar
        title={`${file.name} - Spreadsheet`}
        status={file.status ?? undefined}
        onSave={saveNow}
        onUndo={undo}
        onRedo={redo}
        canUndo={hist.index > 0 || !!edit}
        canRedo={hist.index < hist.entries.length - 1}
        search={{ placeholder: 'Search (Alt+Q)', onSearch: (q) => q && setDialog({ kind: 'find', replace: false }) }}
      />
      <RibbonTabs tabs={RIBBON_TABS} active={tab} onSelect={setTab} onFile={() => setBackstage('home')} collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} />
      <Ribbon collapsed={collapsed}>
        <SheetRibbon tab={tab} cmd={cmd} st={ribbonState} />
      </Ribbon>
      {lost.length === 0 && kept && (
        <MessageBar onDismiss={() => setKeptDismissed(true)}>This workbook has data validation. Spreadsheet keeps it when you save, but doesn’t check what’s typed against it yet.</MessageBar>
      )}
      {lost.length > 0 && (
        <MessageBar tone="warning" onDismiss={() => setLost([])}>
          <b>Some features won’t be kept.</b> This workbook has {lost.join(', ')}, which Spreadsheet can’t edit yet. Saving it here will leave them out.
        </MessageBar>
      )}
      {file.error && file.error !== errorDismissed && (
        <MessageBar tone="warning" onDismiss={() => setErrorDismissed(file.error)}>
          <b>Couldn’t open this file.</b> {file.error}
        </MessageBar>
      )}
      {formulaBar && (
        <FormulaBar
          name={nameBoxText}
          names={visibleNames}
          onGo={goTo}
          text={barText}
          selStart={edit ? edit.s : 0}
          selEnd={edit ? edit.e : 0}
          editing={!!edit}
          editingHere={!!edit && edit.where === 'bar'}
          acIndex={edit?.ac ?? 0}
          onChange={onEditChange}
          onCaret={(s, e) => onEditCaret(s, e, 'bar')}
          onCancel={cancelEdit}
          onEnter={() => commitEdit(0, 0)}
          onFx={() => setDialog({ kind: 'function' })}
          onPick={pickSuggestion}
          inputRef={barRef}
          expanded={barExpanded}
          onToggleExpanded={() => setBarExpanded((x) => !x)}
        />
      )}
      <div className="relative mx-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-md border border-b-0 border-[#d6d6d6] bg-white">
        {file.loading ? (
          <div className="grid flex-1 place-items-center text-[13px] text-[#616161]">Opening…</div>
        ) : (
          <Grid
            wb={wb}
            sheetIndex={si}
            calc={calc}
            sel={sel}
            zoom={zoom}
            showFormulas={showFormulas}
            edit={activeView}
            highlights={highlights}
            marquee={clip && clip.origin.sheet === si ? [{ r0: clip.origin.r, c0: clip.origin.c, r1: clip.origin.r + clip.rows - 1, c1: clip.origin.c + clip.cols - 1 }] : null}
            apiRef={gridApi}
            sinkRef={sinkRef}
            editorRef={editorRef}
            names={visibleNames}
            onEditChange={onEditChange}
            onEditCaret={(s, e) => onEditCaret(s, e, 'cell')}
            onPick={pickSuggestion}
            onEditorFocus={() => edit && edit.where !== 'cell' && setEdit({ ...edit, where: 'cell' })}
            onCellDown={onCellDown}
            onCellDrag={onCellDrag}
            onCellUp={onCellUp}
            onDoubleClick={(r, c) => {
              if (edit && !commitEdit(0, 0)) return;
              selectCell(r, c, false);
              const cell = sheet.cells.get(cellKey(r, c));
              const st = wb.styles.get(cell?.s ?? styleIdAt(sheet, r, c));
              const text = contentText(cell, st);
              setEdit({ sheet: si, r, c, text, s: text.length, e: text.length, where: 'cell', mode: 'edit', point: null, ac: 0 });
              setClip(null);
            }}
            onHeaderDown={onHeaderDown}
            onHeaderDrag={onHeaderDrag}
            onResize={onResize}
            onAutofit={(kind, index) => {
              const idx = (kind === 'col' ? sel.ranges.filter(isWholeCols) : sel.ranges.filter(isWholeRows)).some((g) => (kind === 'col' ? index >= g.c0 && index <= g.c1 : index >= g.r0 && index <= g.r1)) ? selectedIndexes(kind) : [index];
              autofit(kind, idx);
            }}
            onFill={onFill}
            onFillDouble={onFillDouble}
            onMoveRange={onMoveRange}
            onContextMenu={(x, y, kind) => setMenu({ x, y, kind })}
            onZoom={(d) => setZoom(zoom + d)}
            onCopy={onCopyEvent}
            onCut={onCutEvent}
            onPaste={onPasteEvent}
            tabShare={0.6}
            bottomBar={
              <SheetTabs
                sheets={wb.sheets}
                active={si}
                theme={wb.theme}
                onSelect={switchSheet}
                onAdd={addSheet}
                onRename={(i, name) => push(ops.renameSheet(wb, i, name), 'Rename Sheet', i)}
                onDelete={deleteSheet}
                onMove={(from, to) => {
                  const out = ops.moveSheet(wb, from, to);
                  push(out, 'Move Sheet', out.active);
                  setActive(to);
                }}
                onMoveDialog={() => setDialog({ kind: 'moveSheet' })}
                onTabColor={cmd.tabColor}
                onHide={() => hideSheet(si)}
                onUnhide={() => setDialog({ kind: 'unhide' })}
                renaming={renaming}
                setRenaming={setRenaming}
                validate={(name, i) => ops.validSheetName(wb, name, i)}
              />
            }
          />
        )}
      </div>
      <StatusBar>
        <StatusText>{status}</StatusText>
        {circ && <StatusText>Circular References: {wb.sheets[circ.sheet].name !== sheet.name ? `${quoteSheet(wb.sheets[circ.sheet].name)}!` : ''}{cellName(circ.r, circ.c)}</StatusText>}
        {message && <StatusText className="truncate text-[#424242]">{message}</StatusText>}
        <span className="flex-1" />
        {multiCell && stats.count > 1 && (
          <>
            {stats.numCount > 0 && <StatusText>Average: {statFmt(stats.sum / stats.numCount)}</StatusText>}
            <StatusText>Count: {stats.count.toLocaleString()}</StatusText>
            {stats.numCount > 0 && <StatusText>Sum: {statFmt(stats.sum)}</StatusText>}
          </>
        )}
        <ViewButton label="Normal" active onClick={() => undefined}>
          <Grid2x2 />
        </ViewButton>
        <ViewButton label="Page Layout" onClick={() => setMessage('Page Layout view isn’t available in Spreadsheet yet.')}>
          <FileText />
        </ViewButton>
        <ViewButton label="Page Break Preview" onClick={() => setMessage('Page Break Preview isn’t available in Spreadsheet yet.')}>
          <Table />
        </ViewButton>
        <ZoomSlider zoom={zoom} onZoom={setZoom} onDialog={() => setDialog({ kind: 'zoom' })} min={10} max={400} />
      </StatusBar>

      <Menu.Root open={!!menu} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <Menu.Trigger asChild>
          <span className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </Menu.Trigger>
        <MenuContent>
          <MenuItem icon={<Scissors />} onSelect={cmd.cut} shortcut="Ctrl+X">
            Cut
          </MenuItem>
          <MenuItem icon={<Copy />} onSelect={cmd.copy} shortcut="Ctrl+C">
            Copy
          </MenuItem>
          <MenuItem icon={<ClipboardPaste />} onSelect={() => cmd.paste()} shortcut="Ctrl+V">
            Paste
          </MenuItem>
          <SubMenu label="Paste Special">
            <MenuItem onSelect={() => cmd.paste('values')}>Values</MenuItem>
            <MenuItem onSelect={() => cmd.paste('formulas')}>Formulas</MenuItem>
            <MenuItem onSelect={() => cmd.paste('formats')}>Formatting</MenuItem>
            <MenuItem onSelect={() => cmd.paste('transpose')}>Transpose</MenuItem>
          </SubMenu>
          <MenuSeparator />
          {menu?.kind === 'col' ? (
            <>
              <MenuItem onSelect={() => insertRowsCols('col')}>Insert</MenuItem>
              <MenuItem onSelect={() => insertRowsCols('col', true)}>Delete</MenuItem>
            </>
          ) : menu?.kind === 'row' ? (
            <>
              <MenuItem onSelect={() => insertRowsCols('row')}>Insert</MenuItem>
              <MenuItem onSelect={() => insertRowsCols('row', true)}>Delete</MenuItem>
            </>
          ) : (
            <>
              <MenuItem onSelect={() => cmd.insert('cells')}>Insert…</MenuItem>
              <MenuItem onSelect={() => cmd.remove('cells')}>Delete…</MenuItem>
            </>
          )}
          <MenuItem onSelect={() => clearSel('contents')}>Clear Contents</MenuItem>
          {menu?.kind === 'cell' && (
            <SubMenu label="Sort">
              <MenuItem onSelect={() => cmd.sort(true)}>Sort A to Z</MenuItem>
              <MenuItem onSelect={() => cmd.sort(false)}>Sort Z to A</MenuItem>
              <MenuItem onSelect={cmd.customSort}>Custom Sort…</MenuItem>
            </SubMenu>
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => setDialog({ kind: 'format', tab: 'number' })} shortcut="Ctrl+1">
            Format Cells…
          </MenuItem>
          {menu?.kind === 'col' && (
            <>
              <MenuItem onSelect={cmd.colWidth}>Column Width…</MenuItem>
              <MenuItem onSelect={() => hide('col', true)}>Hide</MenuItem>
              <MenuItem onSelect={() => hide('col', false)}>Unhide</MenuItem>
            </>
          )}
          {menu?.kind === 'row' && (
            <>
              <MenuItem onSelect={cmd.rowHeight}>Row Height…</MenuItem>
              <MenuItem onSelect={() => hide('row', true)}>Hide</MenuItem>
              <MenuItem onSelect={() => hide('row', false)}>Unhide</MenuItem>
            </>
          )}
          {menu?.kind === 'cell' && (
            <>
              <MenuItem onSelect={cmd.defineName}>Define Name…</MenuItem>
              <MenuItem icon={<Link2 />} onSelect={() => setDialog({ kind: 'link' })} shortcut="Ctrl+K">
                {sheet.links.has(cellKey(sel.active.r, sel.active.c)) ? 'Edit Link…' : 'Link…'}
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu.Root>

      {dialog?.kind === 'format' && (
        <FormatCellsDialog
          initialTab={dialog.tab}
          style={activeStyle}
          theme={wb.theme}
          sample={value(sel.active.r, sel.active.c)}
          date1904={wb.date1904}
          multi={multiCell}
          merged={!!mergeAt(sheet, sel.active.r, sel.active.c)}
          onOk={(res) => {
            setDialog(null);
            applyFormatResult(res);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'function' && (
        <InsertFunctionDialog
          initialCategory={dialog.category}
          recent={recentFns}
          onOk={(name) => {
            setDialog(null);
            cmd.useFunction(name);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'find' && (
        <FindDialog
          replace={dialog.replace}
          initial=""
          onClose={() => {
            setDialog(null);
            findState.current = null;
          }}
          onFind={(o) => {
            const hit = findNext(o);
            if (!hit) return 'Spreadsheet couldn’t find what you were looking for.';
            findState.current = hit;
            setActive(hit.sheet);
            setSelFor(wb.sheets[hit.sheet].id, selOf(hit.r, hit.c));
            requestAnimationFrame(() => gridApi.current?.reveal(hit.r, hit.c));
            return `${quoteSheet(wb.sheets[hit.sheet].name)}!${cellName(hit.r, hit.c)}`;
          }}
          onReplace={(o) => {
            const cell = sheet.cells.get(cellKey(sel.active.r, sel.active.c));
            const rep = cell ? replaceIn(cell, o) : null;
            if (rep) push(ops.setCell(wb, si, sel.active.r, sel.active.c, rep), 'Replace');
            const hit = findNext(o);
            if (hit) {
              findState.current = hit;
              setActive(hit.sheet);
              setSelFor(wb.sheets[hit.sheet].id, selOf(hit.r, hit.c));
            }
            return rep ? 'Replaced.' : hit ? null : 'Spreadsheet couldn’t find a match.';
          }}
          onReplaceAll={(o) => {
            let out = wb;
            let n = 0;
            const sheetsTo = o.workbook ? [...wb.sheets.keys()] : [si];
            for (const s of sheetsTo) {
              const updates: [number, Cell | null][] = [];
              for (const [k, cell] of wb.sheets[s].cells) {
                const rep = replaceIn(cell, o);
                if (rep) {
                  updates.push([k, rep]);
                  n++;
                }
              }
              if (updates.length) out = ops.updateSheet(out, s, (x) => ops.withCells(x, updates));
            }
            if (n) push(out, 'Replace All');
            return n ? `All done. We made ${n} replacement${n === 1 ? '' : 's'}.` : 'Spreadsheet couldn’t find anything to replace.';
          }}
        />
      )}
      {dialog?.kind === 'goto' && (
        <GoToDialog
          names={visibleNames}
          onOk={(ref) => {
            if (goTo(ref)) setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'size' && (
        <NumberDialog
          title={dialog.what === 'row' ? 'Row Height' : dialog.what === 'col' ? 'Column Width' : 'Standard Width'}
          label={dialog.what === 'row' ? 'Row height:' : dialog.what === 'col' ? 'Column width:' : 'Standard column width:'}
          value={dialog.what === 'row' ? (sheet.rows.get(sel.active.r)?.h ?? sheet.defaultRowHeight) * 0.75 : pxToChars(dialog.what === 'col' ? colWidth(sheet, sel.active.c) : sheet.defaultColWidth)}
          max={dialog.what === 'row' ? 409 : 255}
          onOk={(v) => {
            setDialog(null);
            if (dialog.what === 'row') setSizes('row', Math.round((v * 4) / 3), selectedIndexes('row'), 'Row Height');
            else if (dialog.what === 'col') setSizes('col', charsToPx(v), selectedIndexes('col'), 'Column Width');
            else push(ops.updateSheet(wb, si, (s) => ({ ...s, defaultColWidth: charsToPx(v) })), 'Standard Width');
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'insert' && (
        <ChoiceDialog
          title="Insert"
          choices={[
            ['right', 'Shift cells right'],
            ['down', 'Shift cells down'],
            ['row', 'Entire row'],
            ['col', 'Entire column'],
          ]}
          initial="down"
          onOk={(v) => {
            setDialog(null);
            insertCells(v);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ChoiceDialog
          title="Delete"
          choices={[
            ['left', 'Shift cells left'],
            ['up', 'Shift cells up'],
            ['row', 'Entire row'],
            ['col', 'Entire column'],
          ]}
          initial="up"
          onOk={(v) => {
            setDialog(null);
            deleteCells(v);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'zoom' && (
        <ZoomDialog
          zoom={zoom}
          onOk={(z) => {
            setDialog(null);
            if (z === 'fit') zoomToSelection();
            else setZoom(z);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'moveSheet' && (
        <MoveSheetDialog
          sheets={wb.sheets.map((s) => s.name)}
          current={si}
          onOk={(before, copy) => {
            setDialog(null);
            if (copy) {
              const out = ops.duplicateSheet(wb, si, before);
              push(out, 'Copy Sheet', before);
              setActive(before);
            } else if (before !== si && before !== si + 1) {
              const to = before > si ? before - 1 : before;
              push(ops.moveSheet(wb, si, to), 'Move Sheet', to);
              setActive(to);
            }
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'unhide' && (
        <PickListDialog
          title="Unhide"
          label="Unhide sheet:"
          items={wb.sheets.filter((s) => s.hidden).map((s) => s.name)}
          onOk={(k) => {
            setDialog(null);
            const name = wb.sheets.filter((s) => s.hidden)[k].name;
            const i = wb.sheets.findIndex((s) => s.name === name);
            push(ops.updateSheet(wb, i, (s) => ({ ...s, hidden: false })), 'Unhide Sheet', i);
            setActive(i);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'sort' && (
        <SortDialog
          columns={columnsOf(dialog.g, dialog.header)}
          initialHeader={dialog.header}
          initial={Math.max(dialog.g.c0, Math.min(dialog.g.c1, sel.active.c))}
          onOk={(levels, h) => {
            setDialog(null);
            sortBy(levels, dialog.g, h);
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'dups' && (
        <RemoveDuplicatesDialog
          columns={columnsOf(dialog.g, dialog.header)}
          initialHeader={dialog.header}
          onOk={(c, h) => {
            const res = ops.removeDuplicates(wb, si, dialog.g, c, h, (r, cc) => value(r, cc));
            if (res.removed) push(res.wb, 'Remove Duplicates');
            setDialog({ kind: 'message', title: 'Spreadsheet', text: res.removed ? `${res.removed} duplicate value${res.removed === 1 ? '' : 's'} found and removed; ${res.left} unique value${res.left === 1 ? '' : 's'} remain.` : 'No duplicate values found.' });
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'names' && (
        <NameManagerDialog
          names={wb.names
            .filter((n) => !n.hidden)
            .map((n) => {
              const v = evaluateText(calc, n.formula, n.sheet ?? si);
              const shown = typeof v === 'object' && v !== null && !isErr(v) && 'kind' in v ? (v.kind === 'ref' ? String(calc.value(v.sheet, v.r0, v.c0) ?? '') : '{…}') : v === null ? '' : typeof v === 'number' ? numberToText(v) : String(v);
              return { name: n.name, formula: n.formula, scope: n.sheet === null ? 'Workbook' : wb.sheets[n.sheet]?.name ?? '', value: shown };
            })}
          onNew={() => setDialog({ kind: 'defineName', name: '', formula: `${quoteSheet(sheet.name)}!${absRef(lastRange)}` })}
          onEdit={(name) => {
            const n = wb.names.find((x) => x.name === name);
            if (n) setDialog({ kind: 'defineName', name: n.name, formula: n.formula, old: n.name });
          }}
          onDelete={(name) => push({ ...wb, names: wb.names.filter((x) => x.name !== name) }, 'Delete Name')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'defineName' && (
        <DefineNameDialog
          initial={{ name: dialog.name, formula: dialog.formula }}
          onOk={(name, formula) => {
            if (!/^[A-Za-z_\\][\w.]*$/.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^(r|c)$/i.test(name)) return 'The name you entered is not valid.';
            if (wb.names.some((n) => n.name.toLowerCase() === name.toLowerCase() && n.name !== dialog.old)) return 'The name already exists. Enter a unique name.';
            try {
              parseFormula(formula);
            } catch {
              return 'There’s a problem with the reference.';
            }
            const names = wb.names.filter((n) => n.name !== dialog.old);
            names.push({ name, formula, sheet: null });
            push({ ...wb, names }, 'Define Name');
            setDialog(dialog.old !== undefined ? { kind: 'names' } : null);
            return null;
          }}
          onCancel={() => setDialog(dialog.old !== undefined ? { kind: 'names' } : null)}
        />
      )}
      {dialog?.kind === 'link' && (
        <LinkDialog
          initial={{ text: activeCell && typeof activeCell.v === 'string' ? activeCell.v : '', url: sheet.links.get(cellKey(sel.active.r, sel.active.c)) ?? '' }}
          onOk={(text, url) => {
            setDialog(null);
            insertLink(text, url);
          }}
          onRemove={
            sheet.links.has(cellKey(sel.active.r, sel.active.c))
              ? () => {
                  setDialog(null);
                  const k = cellKey(sel.active.r, sel.active.c);
                  push(ops.updateSheet(wb, si, (x) => {
                    const links = new Map(x.links);
                    links.delete(k);
                    return { ...x, links };
                  }), 'Remove Hyperlink');
                }
              : undefined
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'message' && <MessageDialog title={dialog.title} text={dialog.text} onClose={() => setDialog(null)} />}

      {backstage && (
        <Backstage
          page={backstage}
          onPage={setBackstage}
          onClose={() => setBackstage(null)}
          onSave={() => {
            setBackstage(null);
            void file.save();
          }}
          onCloseDocument={() => {
            setBackstage(null);
            file.requestClose();
          }}
          templates={templates}
          recent={file.recent}
          onOpenRecent={(p) => {
            setBackstage(null);
            file.openPath(p);
          }}
          onBrowse={() => {
            setBackstage(null);
            void file.browse();
          }}
          onSaveAs={() => {
            setBackstage(null);
            void file.saveAs();
          }}
          info={
            <div className="max-w-xl space-y-3 text-[13px]">
              <p className="flex items-center gap-2 text-[15px] font-semibold">
                <FileSpreadsheet className="size-5 text-[#107c41]" /> {file.name}
              </p>
              <p className="text-[#616161]">{file.path ?? 'Not saved yet'}</p>
              <table className="text-[13px]">
                <tbody>
                  <tr>
                    <td className="pr-6 text-[#616161]">Sheets</td>
                    <td>{wb.sheets.length}</td>
                  </tr>
                  <tr>
                    <td className="pr-6 text-[#616161]">Cells with data</td>
                    <td>{wb.sheets.reduce((n, s) => n + s.cells.size, 0).toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="pr-6 text-[#616161]">Defined names</td>
                    <td>{visibleNames.length}</td>
                  </tr>
                  <tr>
                    <td className="pr-6 text-[#616161]">Date system</td>
                    <td>{wb.date1904 ? '1904' : '1900'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          }
          exports={[
            { label: 'Save a copy as CSV', description: 'Comma-separated values of the active sheet, as they’re displayed.', icon: <FileText />, onClick: () => (setBackstage(null), void file.exportCopy(SAVE_CSV)) },
            { label: 'Save a copy as Text (Tab delimited)', description: 'Tab-separated values of the active sheet.', icon: <FileText />, onClick: () => (setBackstage(null), void file.exportCopy(SAVE_TSV)) },
            { label: 'Save a copy as Excel Workbook', description: 'An .xlsx copy, leaving this window on the current file.', icon: <FileSpreadsheet />, onClick: () => (setBackstage(null), void file.exportCopy(SAVE_XLSX)) },
            { label: 'Save a copy as OpenDocument Spreadsheet', description: 'An .ods copy for LibreOffice Calc and other OpenDocument apps.', icon: <FileSpreadsheet />, onClick: () => (setBackstage(null), void file.exportCopy(SAVE_ODS)) },
          ]}
          path={file.path}
        />
      )}
      {file.prompt}
    </OfficeFrame>
  );
}

function TemplatePreview({ title, color, rows }: { title: string; color: string; rows: number }) {
  return (
    <span className="block h-[110px] bg-white p-2">
      <span className="block text-[11px] font-light" style={{ color }}>
        {title}
      </span>
      <span className="mt-1 block h-2" style={{ background: color }} />
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="mt-[3px] flex gap-1">
          <span className="h-[6px] flex-[3] bg-[#e7e7e7]" />
          <span className="h-[6px] flex-1 bg-[#efefef]" />
          <span className="h-[6px] flex-1 bg-[#efefef]" />
        </span>
      ))}
    </span>
  );
}
