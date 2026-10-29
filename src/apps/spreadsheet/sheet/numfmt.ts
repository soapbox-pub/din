import { dateSerial, DAYS, MONTHS, serialParts, timeSerial } from './dates';
import { CellError, errOf, numberToText, type Scalar } from './values';

/**
 * Excel number format codes ("#,##0.00", "m/d/yyyy", "[Red](0.00)",
 * `_("$"* #,##0_)`) and the other direction: reading what someone types
 * into a cell the way Excel does, number formats included.
 */

export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

export const FMT = {
  general: 'General',
  number: '0.00',
  comma: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  accounting: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  currency: '"$"#,##0.00',
  percent: '0%',
  shortDate: 'm/d/yyyy',
  longDate: '[$-x-sysdate]dddd, mmmm d, yyyy',
  time: '[$-x-systime]h:mm:ss AM/PM',
  fraction: '# ?/?',
  scientific: '0.00E+00',
  text: '@',
};

const COLORS: Record<string, string> = {
  black: '#000000', blue: '#0000FF', cyan: '#00FFFF', green: '#00FF00', magenta: '#FF00FF', red: '#FF0000', white: '#FFFFFF', yellow: '#FFFF00',
};

/** The 56-color legacy palette [Color1]–[Color56] refers to (and indexed colors). */
export const INDEXED_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00',
  'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF',
  '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF',
  'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

type Tok =
  | { t: 'lit'; s: string }
  | { t: 'space' }
  | { t: 'fill'; ch: string }
  | { t: 'digit'; ch: '0' | '#' | '?' }
  | { t: 'point' }
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; plus: boolean }
  | { t: 'slash' }
  | { t: 'text' }
  | { t: 'date'; s: string }
  | { t: 'ampm'; s: string }
  | { t: 'elapsed'; unit: 'h' | 'm' | 's'; len: number }
  | { t: 'subsec'; len: number }
  | { t: 'general' };

interface Section {
  toks: Tok[];
  color?: string;
  cond?: { op: string; v: number };
  kind: 'number' | 'date' | 'text' | 'general' | 'fraction';
}

interface Compiled {
  sections: Section[];
}

const cache = new Map<string, Compiled>();

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      cur += ch;
      if (ch === '"') quote = false;
    } else if (ch === '"') {
      quote = true;
      cur += ch;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      cur += ch + (code[i + 1] ?? '');
      i++;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function compileSection(src: string): Section {
  const toks: Tok[] = [];
  const sec: Section = { toks, kind: 'number' };
  let i = 0;
  const lit = (s: string) => {
    const last = toks[toks.length - 1];
    if (last?.t === 'lit') last.s += s;
    else toks.push({ t: 'lit', s });
  };
  let isDate = false;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    const lower = ch.toLowerCase();
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, j < 0 ? undefined : j));
      i = j < 0 ? src.length : j + 1;
    } else if (ch === '\\') {
      lit(src[i + 1] ?? '');
      i += 2;
    } else if (ch === '_') {
      toks.push({ t: 'space' });
      i += 2;
    } else if (ch === '*') {
      toks.push({ t: 'fill', ch: src[i + 1] ?? ' ' });
      i += 2;
    } else if (ch === '[') {
      const j = src.indexOf(']', i);
      const inner = src.slice(i + 1, j < 0 ? undefined : j);
      i = j < 0 ? src.length : j + 1;
      const il = inner.toLowerCase();
      if (COLORS[il]) sec.color = COLORS[il];
      else if (/^color\s*\d+$/.test(il)) sec.color = `#${INDEXED_COLORS[(parseInt(il.slice(5), 10) - 1 + 8) % INDEXED_COLORS.length] ?? '000000'}`;
      else if (/^(<=|>=|<>|<|>|=)\s*-?[\d.]+$/.test(inner.trim())) {
        const m = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(inner.trim())!;
        sec.cond = { op: m[1], v: parseFloat(m[2]) };
      } else if (/^h+$/.test(il) || /^m+$/.test(il) || /^s+$/.test(il)) {
        toks.push({ t: 'elapsed', unit: il[0] as 'h' | 'm' | 's', len: il.length });
        isDate = true;
      } else if (inner.startsWith('$')) {
        const sym = inner.slice(1).split('-')[0];
        if (sym) lit(sym);
      }
    } else if (/^(am\/pm|a\/p)/i.test(rest)) {
      const m = /^(am\/pm|a\/p)/i.exec(rest)!;
      toks.push({ t: 'ampm', s: m[0] });
      i += m[0].length;
      isDate = true;
    } else if ('ymdhseb'.includes(lower) && !(lower === 'e' && /^e[+-]/i.test(rest))) {
      let j = i;
      while (j < src.length && src[j].toLowerCase() === lower) j++;
      toks.push({ t: 'date', s: src.slice(i, j).toLowerCase() });
      i = j;
      isDate = true;
    } else if (/^e[+-]/i.test(rest)) {
      toks.push({ t: 'exp', plus: rest[1] === '+' });
      i += 2;
    } else if (/^general/i.test(rest)) {
      toks.push({ t: 'general' });
      i += 7;
    } else if (ch === '0' || ch === '#' || ch === '?') {
      toks.push({ t: 'digit', ch });
      i++;
    } else if (ch === '.') {
      if (isDate && /^\.0+/.test(rest)) {
        const m = /^\.0+/.exec(rest)!;
        toks.push({ t: 'subsec', len: m[0].length - 1 });
        i += m[0].length;
      } else {
        toks.push({ t: 'point' });
        i++;
      }
    } else if (ch === ',') {
      toks.push({ t: 'comma' });
      i++;
    } else if (ch === '%') {
      toks.push({ t: 'percent' });
      i++;
    } else if (ch === '/') {
      toks.push({ t: 'slash' });
      i++;
    } else if (ch === '@') {
      toks.push({ t: 'text' });
      i++;
    } else {
      lit(ch);
      i++;
    }
  }
  if (isDate) {
    sec.kind = 'date';
    // "m" right after an hour or right before a second means minutes.
    const parts = toks.filter((t) => t.t === 'date' || t.t === 'elapsed');
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (p.t !== 'date' || p.s[0] !== 'm' || p.s.length > 2) continue;
      const prev = parts[k - 1];
      const next = parts[k + 1];
      const afterHour = prev && ((prev.t === 'date' && prev.s[0] === 'h') || (prev.t === 'elapsed' && prev.unit === 'h'));
      const beforeSec = next && ((next.t === 'date' && next.s[0] === 's') || (next.t === 'elapsed' && next.unit === 's'));
      if (afterHour || beforeSec) p.s = p.s === 'm' ? 'n' : 'nn';
    }
    // Commas and other number marks in a date code are literal text.
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === 'comma') toks[k] = { t: 'lit', s: ',' };
      else if (t.t === 'slash') toks[k] = { t: 'lit', s: '/' };
      else if (t.t === 'point') toks[k] = { t: 'lit', s: '.' };
      else if (t.t === 'digit') toks[k] = { t: 'lit', s: t.ch === '0' ? '0' : '' };
    }
  } else if (toks.some((t) => t.t === 'general')) sec.kind = 'general';
  else if (toks.some((t) => t.t === 'slash') && toks.some((t) => t.t === 'digit')) sec.kind = 'fraction';
  else if (!toks.some((t) => t.t === 'digit') && toks.some((t) => t.t === 'text')) sec.kind = 'text';
  return sec;
}

function compile(code: string): Compiled {
  let c = cache.get(code);
  if (!c) {
    const parts = splitSections(code);
    c = { sections: parts.map(compileSection) };
    if (cache.size > 2000) cache.clear();
    cache.set(code, c);
  }
  return c;
}

export interface Formatted {
  text: string;
  color?: string;
  /** A repeat-to-fill character (`*`), and where in `text` it goes. */
  fill?: { ch: string; at: number };
}

export function isDateFormat(code: string): boolean {
  if (!code || code === 'General') return false;
  return compile(code).sections[0]?.kind === 'date';
}

export function isTextFormat(code: string): boolean {
  return code === '@' || compile(code).sections[0]?.kind === 'text';
}

/** Show a value in a number format. `width` is how many characters General may use. */
export function formatValue(v: Scalar, code: string, date1904 = false, width = 11): Formatted {
  if (v === null) return { text: '' };
  if (v instanceof CellError) return { text: v.code };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (!code || code === 'General') return typeof v === 'number' ? { text: formatGeneral(v, width) } : { text: v };
  const c = compile(code);
  if (typeof v === 'string') {
    const sec = c.sections.length >= 4 ? c.sections[3] : c.sections.find((s) => s.kind === 'text');
    if (!sec) return { text: v };
    return render(sec, sec.toks, 0, v, date1904, width);
  }
  const secs = c.sections.slice(0, 3);
  let sec: Section;
  let n = v;
  let signed = false;
  if (secs.some((s) => s.cond)) {
    const test = (s: Section) => {
      if (!s.cond) return true;
      const { op, v: x } = s.cond;
      return op === '<' ? v < x : op === '<=' ? v <= x : op === '>' ? v > x : op === '>=' ? v >= x : op === '=' ? v === x : v !== x;
    };
    sec = secs.find((s) => s.cond && test(s)) ?? secs.find((s) => !s.cond) ?? secs[secs.length - 1];
    if (sec !== secs[0] || (sec.cond && sec.cond.v === 0 && sec.cond.op.startsWith('<'))) n = Math.abs(v);
    else signed = true;
  } else if (secs.length === 1 || (v > 0 && secs.length >= 1) || (v === 0 && secs.length < 3)) {
    sec = secs[0];
    signed = secs.length === 1;
  } else if (v < 0) {
    sec = secs[1];
    n = -v;
  } else {
    sec = secs[2];
    n = 0;
  }
  if (sec.kind === 'text') return render(sec, sec.toks, n, numberToText(n), date1904, width);
  return render(sec, sec.toks, n, null, date1904, width, signed);
}

function render(sec: Section, toks: Tok[], n: number, text: string | null, date1904: boolean, width: number, signed = false): Formatted {
  let out = '';
  let fill: Formatted['fill'];
  const color = sec.color;
  if (sec.kind === 'date' && text === null) {
    const r = formatDate(toks, n, date1904);
    return r === null ? { text: '#'.repeat(Math.max(1, Math.min(width, 11))), color } : { text: r.text, color, fill: r.fill };
  }
  if (sec.kind === 'general' && text === null) {
    for (const t of toks) {
      if (t.t === 'general') out += formatGeneral(signed ? n : Math.abs(n), width);
      else if (t.t === 'lit') out += t.s;
      else if (t.t === 'space') out += ' ';
      else if (t.t === 'fill') fill = { ch: t.ch, at: out.length };
    }
    return { text: out, color, fill };
  }
  if (sec.kind === 'fraction' && text === null) return { text: formatFraction(toks, signed ? n : n, signed), color };
  if (text !== null) {
    for (const t of toks) {
      if (t.t === 'text') out += text;
      else if (t.t === 'lit') out += t.s;
      else if (t.t === 'space') out += ' ';
      else if (t.t === 'fill') fill = { ch: t.ch, at: out.length };
      else if (t.t === 'general') out += text;
    }
    return { text: out, color, fill };
  }
  return { ...formatNumber(toks, n, signed), color };
}

// ---- General --------------------------------------------------------------------------------

/** Excel's General format: as many digits as fit in `width` characters, scientific when the number is too big or small. */
export function formatGeneral(n: number, width = 11): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const neg = n < 0;
  const abs = Math.abs(n);
  const avail = Math.max(1, width - (neg ? 1 : 0));
  const sign = neg ? '-' : '';
  if (abs >= 1e-4 || (abs >= 1e-9 && avail > 10)) {
    const intDigits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 1;
    if (intDigits <= avail && abs < 1e11) {
      const decimals = Math.max(0, Math.min(avail - intDigits - 1, 15 - (abs >= 1 ? intDigits : 0)));
      let s = abs.toFixed(Math.min(decimals, 20));
      // Excel keeps 15 significant digits at most.
      s = String(Number(Number(s).toPrecision(15)));
      if (s.includes('e')) s = abs.toFixed(Math.min(decimals, 20)).replace(/\.?0+$/, '');
      if (s.includes('.')) s = s.replace(/\.?0+$/, '');
      if (s !== '0' && s.length <= avail) return sign + s;
    }
  }
  const exp = Math.floor(Math.log10(abs));
  const expText = `E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  const mantDigits = Math.max(0, Math.min(14, avail - expText.length - 2));
  let mant = abs / Math.pow(10, exp);
  let m = mant.toFixed(mantDigits);
  if (parseFloat(m) >= 10) {
    mant /= 10;
    m = mant.toFixed(mantDigits);
    return sign + m.replace(/\.?0+$/, '') + `E${exp + 1 < 0 ? '-' : '+'}${String(Math.abs(exp + 1)).padStart(2, '0')}`;
  }
  return sign + m.replace(/\.?0+$/, '') + expText;
}

// ---- Numbers ----------------------------------------------------------------------------------

function formatNumber(toks: Tok[], value: number, signed: boolean): Formatted {
  const pointAt = toks.findIndex((t) => t.t === 'point');
  const expAt = toks.findIndex((t) => t.t === 'exp');
  const endInt = pointAt >= 0 ? pointAt : expAt >= 0 ? expAt : toks.length;
  let lastDigit = -1;
  toks.forEach((t, k) => {
    if (t.t === 'digit' && k < (expAt >= 0 ? expAt : toks.length)) lastDigit = k;
  });
  const intIdx: number[] = [];
  const fracIdx: number[] = [];
  const expIdx: number[] = [];
  let grouping = false;
  let scale = 0;
  let firstDigit = -1;
  toks.forEach((t, k) => {
    if (t.t === 'digit') {
      if (firstDigit < 0) firstDigit = k;
      if (expAt >= 0 && k > expAt) expIdx.push(k);
      else if (k < endInt) intIdx.push(k);
      else fracIdx.push(k);
    } else if (t.t === 'comma') {
      // A comma between digits groups thousands; trailing commas divide by 1000.
      const before = toks.slice(0, k).some((x) => x.t === 'digit');
      const afterDigitInInt = toks.slice(k + 1, endInt).some((x) => x.t === 'digit');
      if (before && afterDigitInInt) grouping = true;
      else if (before && k > lastDigit - (pointAt >= 0 && k > pointAt ? 0 : 0) && !afterDigitInInt) scale++;
    }
  });
  let n = value;
  const pct = toks.filter((t) => t.t === 'percent').length;
  n *= Math.pow(100, pct);
  n /= Math.pow(1000, scale);
  const neg = n < 0;
  let abs = Math.abs(n);
  let exponent = 0;
  if (expAt >= 0) {
    if (abs !== 0) {
      const step = intIdx.length > 1 && toks[intIdx[0]].t === 'digit' && (toks[intIdx[0]] as { ch: string }).ch === '#' ? intIdx.length : 1;
      exponent = Math.floor(Math.log10(abs));
      exponent = Math.floor(exponent / step) * step;
      if (step === 1 && intIdx.length > 1) exponent -= intIdx.length - 1;
      abs /= Math.pow(10, exponent);
      // Rounding may carry the mantissa up a digit.
      const r = Number(abs.toFixed(fracIdx.length));
      if (r >= Math.pow(10, step === 1 ? Math.max(1, intIdx.length) : step)) {
        abs = r / 10;
        exponent += 1;
      }
    }
  }
  const fixed = roundFixed(abs, fracIdx.length);
  const parts = fixed.split('.');
  let intStr = parts[0];
  const fracStr = parts[1] ?? '';
  if (intStr === '0') intStr = '';
  // Integer placeholders.
  const placeholders = intIdx.map((k) => (toks[k] as { ch: '0' | '#' | '?' }).ch);
  let intText: string;
  {
    const P = placeholders.length;
    let digits = intStr;
    const chars: string[] = [];
    if (digits.length < P) {
      const pad = P - digits.length;
      for (let k = 0; k < pad; k++) chars.push(placeholders[k] === '0' ? '0' : placeholders[k] === '?' ? ' ' : '');
      for (const d of digits) chars.push(d);
    } else {
      chars.push(digits.slice(0, digits.length - P + 1));
      digits = digits.slice(digits.length - P + 1);
      for (const d of digits) chars.push(d);
    }
    intText = chars.join('');
    if (grouping) {
      const lead = /^ */.exec(intText)![0];
      const core = intText.slice(lead.length);
      intText = lead + core.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    // Literals between integer placeholders (phone numbers, "000-00-0000") keep their place.
    if (!grouping && P > 1 && toks.slice(intIdx[0], intIdx[P - 1]).some((t) => t.t === 'lit')) {
      const per: string[] = [];
      const extra = Math.max(0, chars.length - P);
      for (let k = 0; k < P; k++) per.push(k === 0 ? chars.slice(0, extra + 1).join('') : chars[k + extra]);
      let out = '';
      let pi = 0;
      let fill: Formatted['fill'];
      const sign = neg && signed && value !== 0 ? '-' : '';
      toks.forEach((t, k) => {
        if (t.t === 'digit' && pi < P && intIdx.includes(k)) out += (pi === 0 ? sign : '') + per[pi++];
        else if (t.t === 'lit') out += t.s;
        else if (t.t === 'space') out += ' ';
        else if (t.t === 'fill') fill = { ch: t.ch, at: out.length };
      });
      return { text: out, fill };
    }
  }
  // Fraction placeholders: trailing zeros go for '#', become spaces for '?'.
  const fracChars = fracStr.padEnd(fracIdx.length, '0').split('');
  for (let k = fracIdx.length - 1; k >= 0; k--) {
    const ph = (toks[fracIdx[k]] as { ch: string }).ch;
    if (fracChars[k] !== '0' || ph === '0') break;
    fracChars[k] = ph === '?' ? ' ' : '';
  }
  const fracText = fracChars.join('');
  let expText = '';
  if (expAt >= 0) {
    const e = Math.abs(exponent);
    const eDigits = expIdx.length;
    expText = (exponent < 0 ? '-' : (toks[expAt] as { plus: boolean }).plus ? '+' : '') + String(e).padStart(eDigits, '0');
  }
  const isZero = Number(fixed) === 0 && (expAt < 0 || abs === 0);
  const sign = neg && signed && !isZero ? '-' : '';
  let out = '';
  let fill: Formatted['fill'];
  let wroteInt = false;
  let wroteFrac = false;
  let wroteExp = false;
  toks.forEach((t, k) => {
    switch (t.t) {
      case 'digit':
        if (intIdx.includes(k)) {
          if (!wroteInt) {
            out += sign + intText;
            wroteInt = true;
          }
        } else if (fracIdx.includes(k)) {
          if (!wroteFrac) {
            out += fracText;
            wroteFrac = true;
          }
        } else if (!wroteExp) {
          out += expText;
          wroteExp = true;
        }
        break;
      case 'point':
        if (!wroteInt) {
          out += sign + intText;
          wroteInt = true;
        }
        out += '.';
        break;
      case 'exp':
        if (!wroteInt) {
          out += sign + intText;
          wroteInt = true;
        }
        out += 'E';
        break;
      case 'lit':
        out += t.s;
        break;
      case 'space':
        out += ' ';
        break;
      case 'fill':
        fill = { ch: t.ch, at: out.length };
        break;
      case 'percent':
        out += '%';
        break;
      case 'text':
        break;
    }
  });
  if (!wroteInt && firstDigit < 0) out = sign + out;
  return { text: out, fill };
}

/** toFixed without its floating-point surprises (1.005 → 1.01). */
function roundFixed(n: number, decimals: number): string {
  if (n >= 1e21) return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals, minimumFractionDigits: decimals });
  const p = Number(n.toPrecision(15));
  const shifted = Math.round(Number(`${p}e${decimals}`));
  const r = Number(`${shifted}e-${decimals}`);
  return Number.isFinite(r) ? r.toFixed(decimals) : p.toFixed(decimals);
}

function formatFraction(toks: Tok[], value: number, signed: boolean): string {
  const slashAt = toks.findIndex((t) => t.t === 'slash');
  const before = toks.slice(0, slashAt);
  const after = toks.slice(slashAt + 1);
  // "# ?/?" has a whole-number part: the digits before a space-like literal.
  let wholeEnd = -1;
  for (let k = before.length - 1; k >= 0; k--) {
    if (before[k].t === 'lit' || before[k].t === 'space') {
      if (before.slice(0, k).some((t) => t.t === 'digit')) wholeEnd = k;
      break;
    }
  }
  const numerToks = before.slice(wholeEnd + 1).filter((t) => t.t === 'digit');
  const denomDigits = after.filter((t) => t.t === 'digit');
  const fixedDenom = after.filter((t) => t.t === 'lit').map((t) => (t as { s: string }).s).join('').trim();
  const neg = value < 0;
  const abs = Math.abs(value);
  let whole = wholeEnd >= 0 ? Math.floor(abs) : 0;
  let frac = abs - whole;
  let num: number;
  let den: number;
  if (/^\d+$/.test(fixedDenom) && !denomDigits.length) {
    den = parseInt(fixedDenom, 10);
    num = Math.round(frac * den);
  } else {
    const maxDen = Math.pow(10, Math.max(1, denomDigits.length)) - 1;
    [num, den] = bestFraction(frac, maxDen);
  }
  if (num === den && den > 0 && wholeEnd >= 0) {
    whole += 1;
    num = 0;
  }
  frac = num;
  const sign = neg && signed ? '-' : '';
  const dw = Math.max(1, denomDigits.length || fixedDenom.length);
  const nw = Math.max(1, numerToks.length);
  if (wholeEnd >= 0) {
    if (num === 0) return `${sign}${whole}`.padEnd(String(whole).length + sign.length + 1 + nw + 1 + dw, ' ');
    return `${sign}${whole ? whole : ''}${whole ? ' ' : ''}${String(frac).padStart(nw, ' ')}/${String(den).padEnd(dw, ' ')}`;
  }
  return `${sign}${String(Math.round(abs * den) || num).padStart(nw, ' ')}/${String(den).padEnd(dw, ' ')}`;
}

function bestFraction(x: number, maxDen: number): [number, number] {
  let best: [number, number] = [Math.round(x), 1];
  let bestErr = Math.abs(x - best[0]);
  for (let d = 1; d <= maxDen; d++) {
    const n = Math.round(x * d);
    const e = Math.abs(x - n / d);
    if (e < bestErr - 1e-12) {
      best = [n, d];
      bestErr = e;
      if (e < 1e-12) break;
    }
  }
  return best;
}

// ---- Dates ------------------------------------------------------------------------------------

function formatDate(toks: Tok[], serial: number, date1904: boolean): { text: string; fill?: Formatted['fill'] } | null {
  if (serial < 0 || serial > 2958465.99999) return null;
  const subsec = toks.find((t) => t.t === 'subsec') as { len: number } | undefined;
  const decimals = subsec?.len ?? 0;
  // Round to what's shown, so 12:59:59.6 shows as 13:00:00.
  const unit = 86400 * Math.pow(10, decimals);
  const rounded = Math.round(serial * unit) / unit;
  const p = serialParts(rounded, date1904);
  const hasAmPm = toks.some((t) => t.t === 'ampm');
  let out = '';
  let fill: Formatted['fill'];
  const pad = (v: number, n: number) => String(v).padStart(n, '0');
  const totalSeconds = rounded * 86400;
  for (const t of toks) {
    switch (t.t) {
      case 'lit':
        out += t.s;
        break;
      case 'space':
        out += ' ';
        break;
      case 'fill':
        fill = { ch: t.ch, at: out.length };
        break;
      case 'elapsed': {
        const v = t.unit === 'h' ? Math.floor(totalSeconds / 3600 + 1e-9) : t.unit === 'm' ? Math.floor(totalSeconds / 60 + 1e-9) : Math.floor(totalSeconds + 1e-9);
        out += pad(v, t.len);
        break;
      }
      case 'subsec':
        out += '.' + pad(Math.floor(p.ms / Math.pow(10, 3 - decimals)), decimals);
        break;
      case 'ampm': {
        const pm = p.hh >= 12;
        out += t.s.length > 3 ? (pm ? 'PM' : 'AM') : t.s[0] === t.s[0].toUpperCase() ? (pm ? 'P' : 'A') : pm ? 'p' : 'a';
        break;
      }
      case 'date': {
        const s = t.s;
        const c = s[0];
        if (c === 'y' || c === 'e') out += s.length <= 2 && c === 'y' ? pad(p.y % 100, 2) : String(p.y);
        else if (c === 'm') {
          if (s.length === 1) out += p.m;
          else if (s.length === 2) out += pad(p.m, 2);
          else if (s.length === 3) out += MONTHS[p.m - 1].slice(0, 3);
          else if (s.length === 5) out += MONTHS[p.m - 1][0];
          else out += MONTHS[p.m - 1];
        } else if (c === 'n') out += s.length === 1 ? p.mm : pad(p.mm, 2);
        else if (c === 'd') {
          if (s.length === 1) out += p.d;
          else if (s.length === 2) out += pad(p.d, 2);
          else if (s.length === 3) out += DAYS[p.dow].slice(0, 3);
          else out += DAYS[p.dow];
        } else if (c === 'h') {
          let h = p.hh;
          if (hasAmPm) h = h % 12 || 12;
          out += s.length === 1 ? h : pad(h, 2);
        } else if (c === 's') out += s.length === 1 ? p.ss : pad(p.ss, 2);
        else if (c === 'b') out += String(p.y + 543);
        break;
      }
      case 'percent':
        out += '%';
        break;
    }
  }
  return { text: out, fill };
}

// ---- Reading what's typed --------------------------------------------------------------------

export interface Parsed {
  value: Scalar;
  formula?: string;
  /** The number format Excel gives a General cell for this kind of entry. */
  format?: string;
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function monthIndex(name: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function fullYear(y: string): number {
  const n = parseInt(y, 10);
  if (y.length <= 2) return n < 30 ? 2000 + n : 1900 + n;
  return n;
}

function parseTime(s: string): { t: number; seconds: boolean; ampm: boolean } | null {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(am|pm|a|p)?$/i.exec(s.trim()) ?? /^(\d{1,2})\s*(am|pm|a|p)$/i.exec(s.trim());
  if (!m) return null;
  if (m.length === 3) {
    let h = parseInt(m[1], 10);
    if (h > 12) return null;
    if (/^p/i.test(m[2])) h = (h % 12) + 12;
    else h = h % 12;
    return { t: timeSerial(h, 0, 0), seconds: false, ampm: true };
  }
  let h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const sec = m[3] ? parseFloat(m[3]) : 0;
  if (mi > 59 || sec >= 60) return null;
  if (m[4]) {
    if (h > 12) return null;
    if (/^p/i.test(m[4])) h = (h % 12) + 12;
    else h = h % 12;
  } else if (h > 23) return null;
  return { t: timeSerial(h, mi, sec), seconds: m[3] !== undefined, ampm: !!m[4] };
}

function parseDate(s: string, date1904: boolean): { v: number; format: string } | null {
  const t = s.trim();
  const year = new Date().getFullYear();
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{1,4})$/.exec(t);
  if (m) {
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { v: dateSerial(fullYear(m[3]), mo, d, date1904), format: 'm/d/yyyy' };
  }
  m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(t);
  if (m) {
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { v: dateSerial(parseInt(m[1], 10), mo, d, date1904), format: 'm/d/yyyy' };
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) {
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { v: dateSerial(year, mo, d, date1904), format: 'd-mmm' };
  }
  m = new RegExp(`^(\\d{1,2})[-\\s/]${MONTH_RE}(?:[-\\s/,]+(\\d{2,4}))?$`, 'i').exec(t);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d < 1 || d > 31) return null;
    return { v: dateSerial(m[3] ? fullYear(m[3]) : year, monthIndex(m[2]), d, date1904), format: m[3] ? 'd-mmm-yy' : 'd-mmm' };
  }
  m = new RegExp(`^${MONTH_RE}[-\\s/]+(\\d{1,2})(?:(?:,\\s*|[-\\s/]+)(\\d{2,4}))?$`, 'i').exec(t);
  if (m) {
    const d = parseInt(m[2], 10);
    // "Mar-26" is March 2026, not the 26th.
    if (!m[3] && t.includes('-') && m[2].length === 2 && d > 31) return { v: dateSerial(fullYear(m[2]), monthIndex(m[1]), 1, date1904), format: 'mmm-yy' };
    if (d < 1 || d > 31) return null;
    return { v: dateSerial(m[3] ? fullYear(m[3]) : year, monthIndex(m[1]), d, date1904), format: m[3] ? 'd-mmm-yy' : 'd-mmm' };
  }
  m = new RegExp(`^${MONTH_RE}[-\\s/]+(\\d{4})$`, 'i').exec(t);
  if (m) return { v: dateSerial(parseInt(m[2], 10), monthIndex(m[1]), 1, date1904), format: 'mmm-yy' };
  return null;
}

/** What a typed entry means, as Excel reads it. */
export function parseEntry(raw: string, date1904 = false): Parsed {
  if (raw === '') return { value: null };
  if (raw.startsWith("'")) return { value: raw.slice(1) };
  if (raw.startsWith('=') && raw.length > 1) return { value: null, formula: raw.slice(1) };
  if ((raw.startsWith('+') || raw.startsWith('-')) && raw.length > 1 && /^[+-][A-Za-z(]/.test(raw)) return { value: null, formula: raw };
  const t = raw.trim();
  const u = t.toUpperCase();
  if (u === 'TRUE') return { value: true };
  if (u === 'FALSE') return { value: false };
  const e = errOf(t);
  if (e) return { value: e };
  let m = /^([+-]?)(\d+\.?\d*|\.\d+)$/.exec(t);
  if (m) return { value: parseFloat(t) };
  m = /^([+-]?)(\d+\.?\d*|\.\d+)[eE]([+-]?\d+)$/.exec(t);
  if (m) return { value: parseFloat(t), format: '0.00E+00' };
  m = /^([+-]?)(\d{1,3}(?:,\d{3})+)(\.\d*)?$/.exec(t);
  if (m) return { value: parseFloat(t.replace(/,/g, '')), format: m[3] && m[3].length > 1 ? '#,##0.00' : '#,##0' };
  m = /^([+-]?)(\d{1,3}(?:,\d{3})*|\d+)?(\.\d+)?\s*%$/.exec(t);
  if (m && (m[2] || m[3])) return { value: parseFloat(t.replace(/[,%\s]/g, '')) / 100, format: m[3] ? '0.00%' : '0%' };
  m = /^(-?)\$\s*(-?)(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?$/.exec(t) ?? /^\(\$\s*(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?\)$/.exec(t);
  if (m) {
    const neg = t.startsWith('(') || m[1] === '-' || m[2] === '-';
    const num = parseFloat(t.replace(/[$,()\s-]/g, ''));
    const decimals = t.includes('.');
    return { value: neg ? -num : num, format: decimals ? '"$"#,##0.00_);\\("$"#,##0.00\\)' : '"$"#,##0_);\\("$"#,##0\\)' };
  }
  m = /^\((\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?\)$/.exec(t);
  if (m) return { value: -parseFloat(t.replace(/[(),]/g, '')) };
  m = /^([+-]?)(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(t);
  if (m && m[2] !== undefined) {
    const den = parseInt(m[4], 10);
    if (den > 0) {
      const v = parseInt(m[2], 10) + parseInt(m[3], 10) / den;
      return { value: m[1] === '-' ? -v : v, format: den > 9 ? '# ??/??' : '# ?/?' };
    }
  }
  const time = parseTime(t);
  if (time) return { value: time.t, format: time.ampm ? (time.seconds ? 'h:mm:ss AM/PM' : 'h:mm AM/PM') : time.seconds ? 'h:mm:ss' : 'h:mm' };
  const date = parseDate(t, date1904);
  if (date) return { value: date.v, format: date.format };
  // A date and a time: "3/14/2026 9:30 AM".
  const sp = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|a|p)?)$/i.exec(t);
  if (sp) {
    const d = parseDate(sp[1], date1904);
    const tm = parseTime(sp[2]);
    if (d && tm) return { value: d.v + tm.t, format: 'm/d/yyyy h:mm' };
  }
  return { value: raw };
}

/** How a cell's value reads in the formula bar and the editor (dates as dates, percentages with %). */
export function editText(v: Scalar, code: string, date1904 = false): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof CellError) return v.code;
  if (typeof v === 'string') {
    if (code !== '@' && (parseEntry(v, date1904).value !== v || v.startsWith('=') || v.startsWith("'"))) return `'${v}`;
    return v;
  }
  if (code && code !== 'General') {
    const sec = compile(code).sections[0];
    if (sec?.kind === 'date') {
      const p = serialParts(v, date1904);
      const hasDate = Math.floor(v) !== 0 || sec.toks.some((t) => t.t === 'date' && /^[yd]/.test(t.s));
      const hasTime = v % 1 !== 0 || sec.toks.some((t) => (t.t === 'date' && /^[hsn]/.test(t.s)) || t.t === 'elapsed');
      const date = `${p.m}/${p.d}/${p.y}`;
      const h12 = p.hh % 12 || 12;
      const time = `${h12}:${String(p.mm).padStart(2, '0')}:${String(p.ss).padStart(2, '0')} ${p.hh >= 12 ? 'PM' : 'AM'}`;
      if (v >= 1 && hasDate && hasTime) return `${date} ${time}`;
      if (hasDate && v >= 1) return date;
      return time;
    }
    if (sec?.toks.some((t) => t.t === 'percent')) return `${numberToText(Number((v * 100).toPrecision(15)))}%`;
  }
  return numberToText(v);
}

/** Built-in id for a format code, if it is one (for writing styles.xml). */
export function builtinId(code: string): number | null {
  for (const [id, c] of Object.entries(BUILTIN_FORMATS)) if (c === code) return Number(id);
  return null;
}
