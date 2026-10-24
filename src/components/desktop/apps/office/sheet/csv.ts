import { cellKey } from './addr';
import { newSheet, newWorkbook, type Cell, type Workbook } from './model';
import { normalizeFormula } from './editing';
import { parseEntry } from './numfmt';

/** CSV and tab-separated text: opening one as a workbook, and saving a sheet as one. */

/** Split delimited text into rows of fields, RFC 4180 style (quotes, doubled quotes, newlines in quotes). */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Commas, semicolons or tabs: whichever splits the first lines most evenly. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 10).filter(Boolean);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 ? min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** A workbook of one sheet from delimited text, typed values read the way Excel reads them. */
export function readDelimited(text: string, name: string, delim?: string): Workbook {
  const wb = newWorkbook();
  const rows = parseDelimited(text, delim ?? sniffDelimiter(text));
  const sheet = newSheet(name.slice(0, 31).replace(/[[\]:*?/\\]/g, '_') || 'Sheet1');
  const cells = new Map<number, Cell>();
  const fmtIds = new Map<string, number>();
  rows.forEach((row, r) => {
    row.forEach((raw, c) => {
      if (raw === '') return;
      const p = parseEntry(raw, false);
      const cell: Cell = p.formula !== undefined ? { v: null, f: normalizeFormula(p.formula) } : { v: p.value };
      if (p.format && p.formula === undefined) {
        let id = fmtIds.get(p.format);
        if (id === undefined) fmtIds.set(p.format, (id = wb.styles.derive(0, (s) => ({ ...s, numFmt: p.format! }))));
        cell.s = id;
      }
      cells.set(cellKey(r, c), cell);
    });
  });
  sheet.cells = cells;
  wb.sheets = [sheet];
  return wb;
}

/** One sheet's cells as text, each shown the way it's formatted. */
export function writeDelimited(rows: string[][], delim: string): string {
  const quote = (s: string) => (s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((row) => row.map(quote).join(delim)).join('\r\n') + '\r\n';
}
