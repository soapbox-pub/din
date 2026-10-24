import { tintColor, type Theme } from '../theme';
import type { BorderSide, Style } from './model';
import { FMT } from './numfmt';

/** Excel's built-in cell styles (Home > Cell Styles), applied as plain formatting. */

export interface CellStyleDef {
  name: string;
  group: 'Good, Bad and Neutral' | 'Data and Model' | 'Titles and Headings' | 'Number Format';
  apply: (base: Style, theme: Theme) => Style;
}

const line = (color: string, style: BorderSide['style'] = 'thin'): BorderSide => ({ style, color });

export const CELL_STYLES: CellStyleDef[] = [
  { name: 'Normal', group: 'Good, Bad and Neutral', apply: (b) => ({ ...b, numFmt: 'General', fill: null, border: {}, font: { name: b.font.name, size: b.font.size } }) },
  { name: 'Bad', group: 'Good, Bad and Neutral', apply: (b) => ({ ...b, fill: 'FFC7CE', font: { ...b.font, color: '9C0006' } }) },
  { name: 'Good', group: 'Good, Bad and Neutral', apply: (b) => ({ ...b, fill: 'C6EFCE', font: { ...b.font, color: '006100' } }) },
  { name: 'Neutral', group: 'Good, Bad and Neutral', apply: (b) => ({ ...b, fill: 'FFEB9C', font: { ...b.font, color: '9C5700' } }) },
  { name: 'Calculation', group: 'Data and Model', apply: (b) => ({ ...b, fill: 'F2F2F2', font: { ...b.font, bold: true, color: 'FA7D00' }, border: { l: line('7F7F7F'), r: line('7F7F7F'), t: line('7F7F7F'), b: line('7F7F7F') } }) },
  { name: 'Check Cell', group: 'Data and Model', apply: (b) => ({ ...b, fill: 'A5A5A5', font: { ...b.font, bold: true, color: 'FFFFFF' }, border: { l: line('3F3F3F', 'double'), r: line('3F3F3F', 'double'), t: line('3F3F3F', 'double'), b: line('3F3F3F', 'double') } }) },
  { name: 'Explanatory Text', group: 'Data and Model', apply: (b) => ({ ...b, font: { ...b.font, italic: true, color: '7F7F7F' } }) },
  { name: 'Input', group: 'Data and Model', apply: (b) => ({ ...b, fill: 'FFCC99', font: { ...b.font, color: '3F3F76' }, border: { l: line('7F7F7F'), r: line('7F7F7F'), t: line('7F7F7F'), b: line('7F7F7F') } }) },
  { name: 'Linked Cell', group: 'Data and Model', apply: (b) => ({ ...b, font: { ...b.font, color: 'FA7D00' }, border: { b: line('FF8001', 'double') } }) },
  { name: 'Note', group: 'Data and Model', apply: (b) => ({ ...b, fill: 'FFFFCC', border: { l: line('B2B2B2'), r: line('B2B2B2'), t: line('B2B2B2'), b: line('B2B2B2') } }) },
  { name: 'Output', group: 'Data and Model', apply: (b) => ({ ...b, fill: 'F2F2F2', font: { ...b.font, bold: true, color: '3F3F3F' }, border: { l: line('3F3F3F'), r: line('3F3F3F'), t: line('3F3F3F'), b: line('3F3F3F') } }) },
  { name: 'Warning Text', group: 'Data and Model', apply: (b) => ({ ...b, font: { ...b.font, color: 'FF0000' } }) },
  { name: 'Heading 1', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, size: 15, bold: true, color: t.colors.dk2 }, border: { b: line(t.colors.accent1, 'thick') } }) },
  { name: 'Heading 2', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, size: 13, bold: true, color: t.colors.dk2 }, border: { b: line(tintColor(t.colors.accent1, 0.5), 'thick') } }) },
  { name: 'Heading 3', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, size: 11, bold: true, color: t.colors.dk2 }, border: { b: line(tintColor(t.colors.accent1, 0.4), 'medium') } }) },
  { name: 'Heading 4', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, bold: true, color: t.colors.dk2 } }) },
  { name: 'Title', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, name: t.majorFont, size: 18, color: t.colors.dk2 } }) },
  { name: 'Total', group: 'Titles and Headings', apply: (b, t) => ({ ...b, font: { ...b.font, bold: true }, border: { t: line(t.colors.accent1), b: line(t.colors.accent1, 'double') } }) },
  { name: 'Comma', group: 'Number Format', apply: (b) => ({ ...b, numFmt: FMT.comma }) },
  { name: 'Comma [0]', group: 'Number Format', apply: (b) => ({ ...b, numFmt: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)' }) },
  { name: 'Currency', group: 'Number Format', apply: (b) => ({ ...b, numFmt: FMT.accounting }) },
  { name: 'Currency [0]', group: 'Number Format', apply: (b) => ({ ...b, numFmt: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)' }) },
  { name: 'Percent', group: 'Number Format', apply: (b) => ({ ...b, numFmt: '0%' }) },
];
