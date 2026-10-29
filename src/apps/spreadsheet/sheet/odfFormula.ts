import { colName, quoteSheet } from './addr';
import { tokenize, type RefTok } from './formula';

/**
 * Formulas between OpenFormula, as .ods files store them
 * ("of:=SUM([.A1:.B3];[$Sheet2.C1])"), and the Excel syntax the Spreadsheet
 * edits and calculates ("SUM(A1:B3,Sheet2!C1)").
 */

/** Functions LibreOffice writes with a vendor prefix, being Excel's own. */
const MS_FUNCTIONS = new Set([
  'IFS', 'SWITCH', 'MAXIFS', 'MINIFS', 'CONCAT', 'TEXTJOIN', 'XLOOKUP', 'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE',
  'RANDARRAY', 'LET', 'IFNA', 'FORECAST.LINEAR', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P',
]);

const FROM_ODF_NAMES: Record<string, string> = { 'CEILING.XCL': 'CEILING', 'FLOOR.XCL': 'FLOOR', 'CEILING.MATH': 'CEILING.MATH', 'FLOOR.MATH': 'FLOOR.MATH' };

/** One part of an ODF reference ("$Sheet1.$A$1", ".B2", "'My sheet'.C3") as an optional sheet and an address. */
function refPart(p: string): { sheet: string | null; addr: string } {
  let s = p.trim();
  let sheet: string | null = null;
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith("'")) {
    let i = 1;
    let name = '';
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += s[i++];
    }
    sheet = name;
    s = s.slice(i + 1);
  } else {
    const dot = s.lastIndexOf('.');
    if (dot > 0) {
      sheet = s.slice(0, dot);
      s = s.slice(dot);
    }
  }
  return { sheet, addr: s.replace(/^\./, '') };
}

/** The inside of a [...] reference in Excel syntax. */
function refToExcel(inner: string): string {
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of inner) {
    if (ch === "'") q = !q;
    if (ch === ':' && !q) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const a = refPart(parts[0]);
  const prefix = a.sheet ? `${quoteSheet(a.sheet)}!` : '';
  if (/#REF!/i.test(inner)) return `${prefix}#REF!`;
  if (parts.length === 1) return prefix + a.addr;
  const b = refPart(parts[1]);
  return `${prefix}${a.addr}:${b.addr}`;
}

/** An ODF cell address ("$Sheet1.$A$1:.$B$2", as named ranges write them) in Excel syntax. */
export function addressToExcel(address: string): string {
  return refToExcel(address.trim().replace(/^\[|\]$/g, ''));
}

/** An OpenFormula formula as Excel formula text (without the '='). */
export function formulaFromOdf(src: string): string {
  const m = /^(?:([a-z]+):)?=?/i.exec(src);
  const ns = m?.[1]?.toLowerCase();
  const s = src.slice(m?.[0].length ?? 0);
  if (ns === 'msoxl') return s;
  let out = '';
  let braces = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      let q = false;
      while (j < s.length && (s[j] !== ']' || q)) {
        if (s[j] === "'") q = !q;
        j++;
      }
      out += refToExcel(s.slice(i + 1, j));
      i = j;
      continue;
    }
    if (ch === '{') braces++;
    if (ch === '}') braces = Math.max(0, braces - 1);
    if (ch === ';') {
      out += ',';
      continue;
    }
    if (ch === '|' && braces) {
      out += ';';
      continue;
    }
    if (ch === '~') {
      out += ',';
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\w.]/.test(s[j])) j++;
      const word = s.slice(i, j);
      let k = j;
      while (s[k] === ' ') k++;
      if (s[k] === '(') {
        let name = word.replace(/^(COM\.MICROSOFT\.|ORG\.OPENOFFICE\.|ORG\.LIBREOFFICE\.|LEGACY\.|_xlfn\.)/i, '');
        name = FROM_ODF_NAMES[name.toUpperCase()] ?? name;
        const up = name.toUpperCase();
        if ((up === 'TRUE' || up === 'FALSE') && s[k + 1] === ')') {
          out += up;
          i = k + 1;
          continue;
        }
        out += name;
        i = j - 1;
        continue;
      }
      out += word;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function addr(c: number, r: number, ac: boolean, ar: boolean): string {
  return `${ac ? '$' : ''}${colName(c)}${ar ? '$' : ''}${r + 1}`;
}

function odfSheet(name: string): string {
  return /^[A-Za-z_][\w]*$/.test(name) ? `$${name}` : `$'${name.replace(/'/g, "''")}'`;
}

/** An Excel reference in ODF's bracketless address form (".A1:.B2", "$Sheet1.A1"). */
export function refToOdfAddress(ref: RefTok): string {
  const sheet = ref.sheet !== null ? odfSheet(ref.sheet) : '';
  switch (ref.kind) {
    case 'cell':
      return `${sheet}.${addr(ref.c0, ref.r0, ref.ac0, ref.ar0)}`;
    case 'area':
      return `${sheet}.${addr(ref.c0, ref.r0, ref.ac0, ref.ar0)}:.${addr(ref.c1, ref.r1, ref.ac1, ref.ar1)}`;
    case 'cols':
      return `${sheet}.${ref.ac0 ? '$' : ''}${colName(ref.c0)}:.${ref.ac1 ? '$' : ''}${colName(ref.c1)}`;
    case 'rows':
      return `${sheet}.${ref.ar0 ? '$' : ''}${ref.r0 + 1}:.${ref.ar1 ? '$' : ''}${ref.r1 + 1}`;
  }
}

/** Excel formula text (without '=') as an OpenFormula formula, "of:=..." */
export function formulaToOdf(src: string): string {
  let out = '';
  let braces = 0;
  for (const t of tokenize(src)) {
    switch (t.type) {
      case 'ref':
        out += t.ref ? `[${refToOdfAddress(t.ref)}]` : t.text;
        break;
      case 'comma':
        out += ';';
        break;
      case 'semi':
        out += braces ? '|' : ';';
        break;
      case 'lbrace':
        braces++;
        out += '{';
        break;
      case 'rbrace':
        braces = Math.max(0, braces - 1);
        out += '}';
        break;
      case 'bool':
        out += `${t.text.toUpperCase()}()`;
        break;
      case 'func': {
        const name = t.text.replace(/^_xlfn\.(_xlws\.)?/i, '');
        out += MS_FUNCTIONS.has(name.toUpperCase()) ? `COM.MICROSOFT.${name.toUpperCase()}` : name;
        break;
      }
      case 'err':
        out += t.text.toUpperCase().endsWith('#REF!') ? '[.#REF!]' : t.text;
        break;
      default:
        out += t.text;
    }
  }
  return `of:=${out}`;
}
