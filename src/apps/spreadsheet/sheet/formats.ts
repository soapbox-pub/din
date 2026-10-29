import { FMT, isDateFormat } from './numfmt';

/** The number format categories of the ribbon's box and the Format Cells dialog, and how their codes are built. */

export const CATEGORY_NAMES = ['General', 'Number', 'Currency', 'Accounting', 'Date', 'Time', 'Percentage', 'Fraction', 'Scientific', 'Text', 'Custom'] as const;
export type Category = (typeof CATEGORY_NAMES)[number];

export const DATE_CODES = [
  'm/d/yyyy',
  FMT.longDate,
  'm/d;@',
  'm/d/yy;@',
  'mm/dd/yy;@',
  'd-mmm;@',
  'd-mmm-yy;@',
  'dd-mmm-yy;@',
  'mmm-yy;@',
  'mmmm-yy;@',
  'mmmm d, yyyy;@',
  'm/d/yy h:mm AM/PM;@',
  'm/d/yy h:mm;@',
  'mmmmm;@',
  'd-mmm-yyyy;@',
  'yyyy-mm-dd;@',
];

export const TIME_CODES = [FMT.time, 'h:mm;@', 'h:mm AM/PM;@', 'h:mm:ss;@', 'h:mm:ss AM/PM;@', 'mm:ss.0;@', '[h]:mm:ss;@', 'm/d/yy h:mm AM/PM;@', 'm/d/yy h:mm;@'];

export const FRACTION_CODES: [string, string][] = [
  ['# ?/?', 'Up to one digit (1/4)'],
  ['# ??/??', 'Up to two digits (21/25)'],
  ['# ???/???', 'Up to three digits (312/943)'],
  ['# ?/2', 'As halves (1/2)'],
  ['# ?/4', 'As quarters (2/4)'],
  ['# ?/8', 'As eighths (4/8)'],
  ['# ??/16', 'As sixteenths (8/16)'],
  ['# ?/10', 'As tenths (3/10)'],
  ['# ??/100', 'As hundredths (30/100)'],
];

export const CUSTOM_CODES = [
  'General', '0', '0.00', '#,##0', '#,##0.00', '#,##0_);(#,##0)', '#,##0_);[Red](#,##0)', '#,##0.00_);(#,##0.00)', '#,##0.00_);[Red](#,##0.00)',
  '"$"#,##0_);\\("$"#,##0\\)', '"$"#,##0_);[Red]\\("$"#,##0\\)', '"$"#,##0.00_);\\("$"#,##0.00\\)', '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  '0%', '0.00%', '0.00E+00', '##0.0E+0', '# ?/?', '# ??/??', 'm/d/yyyy', 'd-mmm-yy', 'd-mmm', 'mmm-yy', 'h:mm AM/PM', 'h:mm:ss AM/PM',
  'h:mm', 'h:mm:ss', 'm/d/yyyy h:mm', 'mm:ss', '[h]:mm:ss', 'mm:ss.0', '@', FMT.comma, FMT.accounting,
];

export const SYMBOLS: [string, string][] = [
  ['', 'None'],
  ['$', '$'],
  ['€', '€ Euro'],
  ['£', '£'],
  ['¥', '¥ Japanese'],
  ['₹', '₹ Indian'],
  ['CHF', 'CHF'],
  ['₿', '₿'],
];

/** The negative-number styles Format Cells offers: -1234.10, 1234.10 in red, (1234.10), (1234.10) in red. */
export const NEGATIVES = ['-', 'red', 'paren', 'redParen'] as const;
export type Negative = (typeof NEGATIVES)[number];

const decimalsPart = (d: number) => (d > 0 ? `.${'0'.repeat(d)}` : '');

function withNegative(pos: string, neg: Negative): string {
  switch (neg) {
    case 'red':
      return `${pos};[Red]${pos}`;
    case 'paren':
      return `${pos}_);\\(${pos}\\)`;
    case 'redParen':
      return `${pos}_);[Red]\\(${pos}\\)`;
    default:
      return pos;
  }
}

export function numberCode(decimals: number, thousands: boolean, neg: Negative = '-'): string {
  return withNegative(`${thousands ? '#,##0' : '0'}${decimalsPart(decimals)}`, neg);
}

const quoteSym = (s: string) => (s ? (s === '$' ? '"$"' : `[$${s}]`) : '');

export function currencyCode(decimals: number, symbol: string, neg: Negative = '-'): string {
  return withNegative(`${quoteSym(symbol)}#,##0${decimalsPart(decimals)}`, neg);
}

export function accountingCode(decimals: number, symbol: string): string {
  const sym = symbol ? `${quoteSym(symbol)}* ` : '* ';
  const n = `#,##0${decimalsPart(decimals)}`;
  const dash = decimals > 0 ? `"-"${'?'.repeat(decimals)}` : '"-"';
  return `_(${sym}${n}_);_(${sym}\\(${n}\\);_(${sym}${dash}_);_(@_)`;
}

export const percentCode = (decimals: number) => `0${decimalsPart(decimals)}%`;
export const scientificCode = (decimals: number) => `0${decimalsPart(decimals)}E+00`;

/** Which category a format code belongs to, as the ribbon's box names it. */
export function categoryOf(code: string): Category {
  if (!code || code === 'General') return 'General';
  if (code === '@') return 'Text';
  if (code.startsWith('_(') && code.includes('* ')) return 'Accounting';
  if (isDateFormat(code)) return /[hs]|AM\/PM/i.test(code.replace(/"[^"]*"/g, '')) && !/[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) ? 'Time' : 'Date';
  if (/%/.test(code)) return 'Percentage';
  if (/E[+-]/i.test(code)) return 'Scientific';
  if (/\?\/|#\s*\?/.test(code)) return 'Fraction';
  if (/\$|€|£|¥|₹|\[\$/.test(code)) return 'Currency';
  if (/^[#,0.]+(_\)|;|$)/.test(code.replace(/\[Red\]|\\|\(|\)/g, ''))) return 'Number';
  return 'Custom';
}

/** The label the ribbon's Number Format box shows. */
export function formatLabel(code: string): string {
  if (code === 'm/d/yyyy' || code === 'mm-dd-yy') return 'Short Date';
  if (code === FMT.longDate) return 'Long Date';
  const c = categoryOf(code);
  return c;
}

export function decimalsOf(code: string): number {
  const first = code.split(';')[0].replace(/"[^"]*"/g, '');
  const m = /\.([0#?]+)/.exec(first);
  return m ? m[1].length : 0;
}

/** Increase / Decrease Decimal: one more or less place in every section. */
export function changeDecimals(code: string, dir: 1 | -1, shownDecimals: number): string {
  if (!code || code === 'General') {
    const d = Math.max(0, shownDecimals + dir);
    return `0${decimalsPart(d)}`;
  }
  if (isDateFormat(code) || code === '@') return code;
  const sections = code.split(';');
  return sections
    .map((sec) => {
      // Only the digits, not quoted text.
      const parts = sec.split(/("[^"]*")/);
      let done = false;
      return parts
        .map((p) => {
          if (done || p.startsWith('"')) return p;
          if (dir > 0) {
            if (/\.0+/.test(p)) {
              done = true;
              return p.replace(/\.(0+)/, '.$10');
            }
            const m = /(0)(?![0.])/.exec(p);
            if (m && /[0#]/.test(p)) {
              done = true;
              return p.slice(0, m.index + 1) + '.0' + p.slice(m.index + 1);
            }
            return p;
          }
          if (/\.0+/.test(p)) {
            done = true;
            return p.replace(/\.(0+)/, (_m, zeros: string) => (zeros.length > 1 ? `.${zeros.slice(1)}` : ''));
          }
          return p;
        })
        .join('');
    })
    .join(';');
}
