import type { PickedColor } from '../chrome';
import type { Theme } from '../theme';
import type { HAlign, Style, VAlign } from './model';
import type { BorderPreset, PasteMode } from './ops';

/** What the ribbon, menus and dialogs can ask the app to do. */
export interface Cmd {
  paste(mode?: PasteMode): void;
  cut(): void;
  copy(): void;
  painter(sticky: boolean): void;
  font(name: string): void;
  size(pt: number): void;
  growFont(dir: 1 | -1): void;
  toggle(what: 'bold' | 'italic' | 'underline' | 'strike'): void;
  underline(kind: 'single' | 'double'): void;
  border(preset: BorderPreset): void;
  fontColor(c: PickedColor | null): void;
  fillColor(c: PickedColor | null): void;
  valign(v: VAlign): void;
  halign(h: HAlign): void;
  wrap(): void;
  rotate(deg: number): void;
  merge(how: 'center' | 'across' | 'merge'): void;
  unmerge(): void;
  indent(dir: 1 | -1): void;
  numFmt(code: string): void;
  decimals(dir: 1 | -1): void;
  formatDialog(tab?: FormatTab): void;
  cellStyle(name: string): void;
  insert(kind: 'cells' | 'rows' | 'cols' | 'sheet'): void;
  remove(kind: 'cells' | 'rows' | 'cols' | 'sheet'): void;
  rowHeight(): void;
  colWidth(): void;
  defaultWidth(): void;
  autofit(kind: 'row' | 'col'): void;
  hide(kind: 'row' | 'col' | 'sheet'): void;
  unhide(kind: 'row' | 'col' | 'sheet'): void;
  renameSheet(): void;
  moveSheet(): void;
  tabColor(c: PickedColor | null): void;
  autoSum(fn: 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN'): void;
  fill(dir: 'down' | 'right' | 'up' | 'left' | 'series'): void;
  clear(what: 'all' | 'formats' | 'contents'): void;
  sort(asc: boolean): void;
  customSort(): void;
  removeDuplicates(): void;
  find(replace: boolean): void;
  goTo(): void;
  insertFunction(category?: string): void;
  useFunction(name: string): void;
  nameManager(): void;
  defineName(): void;
  freeze(kind: 'panes' | 'row' | 'col' | 'none'): void;
  view(what: 'gridlines' | 'headings' | 'formulaBar'): void;
  zoomDialog(): void;
  zoomTo(z: number): void;
  zoomSelection(): void;
  showFormulas(): void;
  calculate(): void;
  orientation(o: 'portrait' | 'landscape'): void;
  margins(kind: 'normal' | 'wide' | 'narrow'): void;
  newSheet(): void;
  selectAll(): void;
  link(): void;
  status(text: string): void;
}

export type FormatTab = 'number' | 'alignment' | 'font' | 'border' | 'fill';

/** What the ribbon shows as current. */
export interface RibbonState {
  style: Style;
  theme: Theme;
  merged: boolean;
  freeze: { rows: number; cols: number };
  gridlines: boolean;
  headings: boolean;
  formulaBar: boolean;
  showFormulas: boolean;
  painter: boolean;
  canPaste: boolean;
  fontColor: string | null;
  fillColor: string | null;
  orientation: 'portrait' | 'landscape';
  sheetCount: number;
}

export const RIBBON_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'layout', label: 'Page Layout' },
  { id: 'formulas', label: 'Formulas' },
  { id: 'data', label: 'Data' },
  { id: 'review', label: 'Review' },
  { id: 'view', label: 'View' },
];
