import { cellKey, parseCell, parseRange } from './addr';
import { dateSerial, todaySerial } from './dates';
import { charsToPx, newWorkbook, type BorderSide, type Cell, type Style, type Workbook } from './model';
import type { Scalar } from './values';

/** The workbooks File > New offers besides a blank one. */

type StyleBits = Partial<Omit<Style, 'font'>> & { font?: Partial<Style['font']> };

function builder(name: string) {
  const wb = newWorkbook();
  const sheet = wb.sheets[0];
  sheet.name = name;
  const cells = sheet.cells;
  const styleId = (bits: StyleBits) => {
    const base = wb.styles.base;
    return wb.styles.id({ ...base, ...bits, font: { ...base.font, ...bits.font }, border: bits.border ?? {} });
  };
  const put = (ref: string, v: Scalar | { f: string }, bits?: StyleBits) => {
    const p = parseCell(ref)!;
    const cell: Cell = typeof v === 'object' && v !== null && 'f' in v ? { v: null, f: v.f } : { v: v as Scalar };
    if (bits) cell.s = styleId(bits);
    cells.set(cellKey(p.r, p.c), cell);
  };
  const style = (range: string, bits: StyleBits) => {
    const g = parseRange(range)!;
    const s = styleId(bits);
    for (let r = g.r0; r <= g.r1; r++)
      for (let c = g.c0; c <= g.c1; c++) {
        const k = cellKey(r, c);
        cells.set(k, { ...(cells.get(k) ?? { v: null }), s });
      }
  };
  const width = (col: number, chars: number) => sheet.cols.set(col, { w: charsToPx(chars) });
  const height = (row: number, px: number) => sheet.rows.set(row, { h: px, custom: true });
  const merge = (range: string) => sheet.merges.push(parseRange(range)!);
  return { wb, sheet, put, style, width, height, merge };
}

const thin = (color = 'BFBFBF'): BorderSide => ({ style: 'thin', color });

export function budgetTemplate(): Workbook {
  const t = builder('Monthly Budget');
  const green = '107C41';
  const pale = 'E2EFDA';
  const money = '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)';
  t.sheet.gridlines = false;
  t.width(0, 2);
  t.width(1, 28);
  t.width(2, 14);
  t.width(3, 14);
  t.width(4, 14);
  t.height(1, 40);
  t.put('B2', 'Monthly Budget', { font: { name: 'Calibri Light', size: 24, color: green }, v: 'center' });
  t.put('B3', { f: 'TEXT(TODAY(),"mmmm yyyy")' }, { font: { name: 'Calibri', size: 12, color: '595959' } });
  const head = { font: { name: 'Calibri', size: 11, bold: true, color: 'FFFFFF' }, fill: green, h: 'center' as const, border: { b: thin(green) } };
  t.put('B5', 'Income', { ...head, h: 'left' });
  t.put('C5', 'Planned', head);
  t.put('D5', 'Actual', head);
  t.put('E5', 'Difference', head);
  const income: [string, number, number][] = [['Salary', 4200, 4200], ['Side projects', 600, 740], ['Other', 0, 85]];
  income.forEach(([label, plan, actual], i) => {
    const r = 6 + i;
    t.put(`B${r}`, label, { border: { b: thin() } });
    t.put(`C${r}`, plan, { numFmt: money, border: { b: thin() } });
    t.put(`D${r}`, actual, { numFmt: money, border: { b: thin() } });
    t.put(`E${r}`, { f: `D${r}-C${r}` }, { numFmt: money, border: { b: thin() } });
  });
  const total = { font: { name: 'Calibri', size: 11, bold: true }, fill: pale, numFmt: money, border: { t: thin(green), b: { style: 'double' as const, color: green } } };
  t.put('B9', 'Total income', { ...total, numFmt: 'General' });
  t.put('C9', { f: 'SUM(C6:C8)' }, total);
  t.put('D9', { f: 'SUM(D6:D8)' }, total);
  t.put('E9', { f: 'D9-C9' }, total);
  t.put('B11', 'Expenses', { ...head, h: 'left' });
  t.put('C11', 'Planned', head);
  t.put('D11', 'Actual', head);
  t.put('E11', 'Difference', head);
  const expenses: [string, number, number][] = [
    ['Rent', 1500, 1500],
    ['Utilities', 180, 164.32],
    ['Groceries', 520, 588.4],
    ['Transport', 140, 122.5],
    ['Phone & internet', 90, 90],
    ['Insurance', 160, 160],
    ['Eating out', 200, 246.75],
    ['Savings', 800, 800],
    ['Other', 150, 97.1],
  ];
  expenses.forEach(([label, plan, actual], i) => {
    const r = 12 + i;
    t.put(`B${r}`, label, { border: { b: thin() } });
    t.put(`C${r}`, plan, { numFmt: money, border: { b: thin() } });
    t.put(`D${r}`, actual, { numFmt: money, border: { b: thin() } });
    t.put(`E${r}`, { f: `C${r}-D${r}` }, { numFmt: money, border: { b: thin() } });
  });
  const last = 12 + expenses.length - 1;
  t.put(`B${last + 1}`, 'Total expenses', { ...total, numFmt: 'General' });
  t.put(`C${last + 1}`, { f: `SUM(C12:C${last})` }, total);
  t.put(`D${last + 1}`, { f: `SUM(D12:D${last})` }, total);
  t.put(`E${last + 1}`, { f: `C${last + 1}-D${last + 1}` }, total);
  const bal = last + 3;
  t.put(`B${bal}`, 'Balance', { font: { name: 'Calibri', size: 13, bold: true, color: green } });
  t.put(`C${bal}`, { f: `C9-C${last + 1}` }, { font: { name: 'Calibri', size: 13, bold: true }, numFmt: money });
  t.put(`D${bal}`, { f: `D9-D${last + 1}` }, { font: { name: 'Calibri', size: 13, bold: true }, numFmt: money });
  t.height(bal - 1, 24);
  t.sheet.sel = { active: { r: 5, c: 3 }, ranges: [{ r0: 5, c0: 3, r1: 5, c1: 3 }] };
  return t.wb;
}

export function invoiceTemplate(): Workbook {
  const t = builder('Invoice');
  const blue = '1F4E79';
  const money = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
  t.sheet.gridlines = false;
  t.width(0, 2);
  t.width(1, 12);
  t.width(2, 34);
  t.width(3, 10);
  t.width(4, 14);
  t.width(5, 16);
  t.height(1, 46);
  t.put('B2', 'INVOICE', { font: { name: 'Calibri Light', size: 28, color: blue }, v: 'center' });
  t.put('E2', 'Invoice #', { h: 'right', font: { name: 'Calibri', size: 11, color: '7F7F7F' } });
  t.put('F2', 'INV-0042', { h: 'right', font: { name: 'Calibri', size: 11, bold: true } });
  t.put('E3', 'Date', { h: 'right', font: { name: 'Calibri', size: 11, color: '7F7F7F' } });
  t.put('F3', todaySerial(), { numFmt: 'mmmm d, yyyy', h: 'right' });
  t.put('E4', 'Due', { h: 'right', font: { name: 'Calibri', size: 11, color: '7F7F7F' } });
  t.put('F4', { f: 'F3+30' }, { numFmt: 'mmmm d, yyyy', h: 'right' });
  t.put('B4', 'Your Company', { font: { name: 'Calibri', size: 12, bold: true } });
  t.put('B5', '123 Main Street, Springfield');
  t.put('B6', 'hello@example.com');
  t.put('B8', 'BILL TO', { font: { name: 'Calibri', size: 10, bold: true, color: blue } });
  t.put('B9', 'Client Name', { font: { name: 'Calibri', size: 11, bold: true } });
  t.put('B10', 'Client address');
  const head = { font: { name: 'Calibri', size: 11, bold: true, color: 'FFFFFF' }, fill: blue, v: 'center' as const };
  t.height(11, 22);
  t.put('B12', 'Item', head);
  t.put('C12', 'Description', head);
  t.put('D12', 'Qty', { ...head, h: 'center' });
  t.put('E12', 'Unit price', { ...head, h: 'right' });
  t.put('F12', 'Amount', { ...head, h: 'right' });
  const items: [string, string, number, number][] = [
    ['1001', 'Design consultation (hours)', 6, 85],
    ['1002', 'Website build', 1, 1800],
    ['1003', 'Hosting, 12 months', 1, 240],
    ['1004', 'Logo revisions', 3, 45],
  ];
  for (let i = 0; i < 8; i++) {
    const r = 13 + i;
    const it = items[i];
    const zebra = i % 2 ? { fill: 'F2F2F2' } : {};
    t.put(`B${r}`, it ? it[0] : null, { ...zebra, h: 'left' });
    t.put(`C${r}`, it ? it[1] : null, zebra);
    t.put(`D${r}`, it ? it[2] : null, { ...zebra, h: 'center' });
    t.put(`E${r}`, it ? it[3] : null, { ...zebra, numFmt: money });
    t.put(`F${r}`, { f: `IF(D${r}="","",D${r}*E${r})` }, { ...zebra, numFmt: money });
  }
  const label = { h: 'right' as const, font: { name: 'Calibri', size: 11, color: '595959' } };
  t.put('E22', 'Subtotal', label);
  t.put('F22', { f: 'SUM(F13:F20)' }, { numFmt: money });
  t.put('E23', 'Tax rate', label);
  t.put('F23', 0.08, { numFmt: '0.0%' });
  t.put('E24', 'Tax', label);
  t.put('F24', { f: 'ROUND(F22*F23,2)' }, { numFmt: money });
  t.put('E25', 'TOTAL', { h: 'right', font: { name: 'Calibri', size: 12, bold: true, color: blue }, border: { t: thin(blue) } });
  t.put('F25', { f: 'F22+F24' }, { numFmt: money, font: { name: 'Calibri', size: 12, bold: true, color: blue }, border: { t: thin(blue), b: { style: 'double', color: blue } } });
  t.put('B28', 'Thank you for your business!', { font: { name: 'Calibri', size: 11, italic: true, color: '7F7F7F' } });
  t.merge('B28:F28');
  t.style('B28:F28', { h: 'center', font: { name: 'Calibri', size: 11, italic: true, color: '7F7F7F' } });
  t.sheet.sel = { active: { r: 12, c: 2 }, ranges: [{ r0: 12, c0: 2, r1: 12, c1: 2 }] };
  return t.wb;
}

export function todoTemplate(): Workbook {
  const t = builder('To-Do List');
  const purple = '7030A0';
  t.sheet.gridlines = false;
  t.width(0, 2);
  t.width(1, 6);
  t.width(2, 40);
  t.width(3, 14);
  t.width(4, 12);
  t.width(5, 12);
  t.height(1, 40);
  t.put('B2', 'To-Do List', { font: { name: 'Calibri Light', size: 24, color: purple }, v: 'center' });
  t.put('E2', { f: 'COUNTIF(F5:F24,"Done")&" of "&COUNTA(C5:C24)&" done"' }, { h: 'right', font: { name: 'Calibri', size: 11, color: '7F7F7F' } });
  t.merge('E2:F2');
  const head = { font: { name: 'Calibri', size: 11, bold: true, color: purple }, border: { b: { style: 'medium' as const, color: purple } } };
  t.put('B4', '#', head);
  t.put('C4', 'Task', head);
  t.put('D4', 'Due', head);
  t.put('E4', 'Priority', head);
  t.put('F4', 'Status', head);
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;
  const tasks: [string, number, string, string][] = [
    ['Plan the week', 1, 'High', 'Done'],
    ['Reply to emails', 2, 'Medium', 'Done'],
    ['Draft the project proposal', 4, 'High', 'In progress'],
    ['Book the dentist', 9, 'Low', 'Not started'],
    ['Renew library books', 12, 'Low', 'Not started'],
  ];
  for (let i = 0; i < 20; i++) {
    const r = 5 + i;
    const task = tasks[i];
    const line = { border: { b: thin('D9D9D9') } };
    t.put(`B${r}`, { f: `IF(C${r}="","",ROW()-4)` }, { ...line, h: 'left', font: { name: 'Calibri', size: 11, color: 'A6A6A6' } });
    t.put(`C${r}`, task ? task[0] : null, line);
    t.put(`D${r}`, task ? dateSerial(y, m, task[1]) : null, { ...line, numFmt: 'd-mmm' });
    t.put(`E${r}`, task ? task[2] : null, line);
    t.put(`F${r}`, task ? task[3] : null, line);
  }
  t.sheet.freeze = { rows: 4, cols: 0 };
  t.sheet.sel = { active: { r: 9, c: 2 }, ranges: [{ r0: 9, c0: 2, r1: 9, c1: 2 }] };
  return t.wb;
}
