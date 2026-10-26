import { attrs, odfColor } from '../odf';
import { attr, esc, kid, kids } from '../ooxml';

/**
 * Number formats between the two worlds: OpenDocument's data styles
 * (number:number-style, number:date-style... built of elements) and the
 * Excel format codes the Spreadsheet works in ("#,##0.00", "m/d/yyyy").
 */

// ---- ODF → Excel -------------------------------------------------------------------------------

const COLOR_NAMES: Record<string, string> = { FF0000: 'Red', '0000FF': 'Blue', '00FF00': 'Green', '000000': 'Black', FFFFFF: 'White', FFFF00: 'Yellow', FF00FF: 'Magenta', '00FFFF': 'Cyan' };

function quote(text: string): string {
  if (!text) return '';
  if (/^[ \-/:,()$+]+$/.test(text)) return text;
  if (text.length === 1) return `\\${text}`;
  return `"${text.replace(/"/g, '')}"`;
}

function numberPart(el: Element): string {
  const decimals = Number(attr(el, 'decimal-places') ?? 0) || 0;
  const minDecimals = Math.min(decimals, Number(attr(el, 'min-decimal-places') ?? decimals) || 0);
  const minInt = Number(attr(el, 'min-integer-digits') ?? 1);
  const grouping = attr(el, 'grouping') === 'true';
  let int = minInt > 0 ? '0'.repeat(minInt) : '#';
  if (grouping) int = int.length >= 4 ? int : `#,${'#'.repeat(Math.max(0, 3 - int.length))}${int}`;
  const dec = decimals ? `.${'0'.repeat(minDecimals)}${'#'.repeat(decimals - minDecimals)}` : '';
  return int + dec;
}

/** One data style element as one section of a format code. */
function section(el: Element): string {
  let out = '';
  const color = odfColor(attr(kid(el, 'text-properties'), 'color'));
  if (color && COLOR_NAMES[color]) out += `[${COLOR_NAMES[color]}]`;
  const timeStyle = el.localName === 'time-style';
  const elapsed = timeStyle && attr(el, 'truncate-on-overflow') === 'false';
  let firstHour = true;
  for (const c of kids(el)) {
    const long = attr(c, 'style') === 'long';
    switch (c.localName) {
      case 'number':
        out += numberPart(c);
        break;
      case 'scientific-number': {
        const exp = Math.max(1, Number(attr(c, 'min-exponent-digits') ?? 2) || 2);
        out += `${numberPart(c)}E+${'0'.repeat(exp)}`;
        break;
      }
      case 'fraction': {
        const num = Math.max(1, Number(attr(c, 'min-numerator-digits') ?? 1) || 1);
        const den = Math.max(1, Number(attr(c, 'min-denominator-digits') ?? 1) || 1);
        const whole = attr(c, 'min-integer-digits') !== null ? '# ' : '';
        const value = attr(c, 'denominator-value');
        out += `${whole}${'?'.repeat(num)}/${value ?? '?'.repeat(den)}`;
        break;
      }
      case 'text': {
        const t = c.textContent ?? '';
        out += t === '%' ? '%' : quote(t);
        break;
      }
      case 'currency-symbol': {
        const sym = c.textContent ?? '';
        out += sym === '$' ? '"$"' : `[$${sym}]`;
        break;
      }
      case 'text-content':
        out += '@';
        break;
      case 'year':
        out += long ? 'yyyy' : 'yy';
        break;
      case 'month': {
        const textual = attr(c, 'textual') === 'true';
        out += textual ? (long ? 'mmmm' : 'mmm') : long ? 'mm' : 'm';
        break;
      }
      case 'day':
        out += long ? 'dd' : 'd';
        break;
      case 'day-of-week':
        out += long ? 'dddd' : 'ddd';
        break;
      case 'hours':
        out += elapsed && firstHour ? (long ? '[hh]' : '[h]') : long ? 'hh' : 'h';
        firstHour = false;
        break;
      case 'minutes':
        out += long ? 'mm' : 'm';
        break;
      case 'seconds': {
        out += long ? 'ss' : 's';
        const d = Number(attr(c, 'decimal-places') ?? 0) || 0;
        if (d) out += `.${'0'.repeat(d)}`;
        break;
      }
      case 'am-pm':
        out += 'AM/PM';
        break;
      case 'boolean':
        out += 'General';
        break;
      case 'quarter':
        out += long ? '"Q"' : 'Q';
        break;
    }
  }
  return out;
}

/** An Excel format code for a data style (by name, with the ones it maps to). */
export function formatCodeOf(name: string | null | undefined, styles: Map<string, Element>): string {
  const el = name ? styles.get(name) : undefined;
  if (!el) return 'General';
  const kind = el.localName;
  if (kind === 'boolean-style') return 'General';
  if (kind === 'text-style' && kids(el).every((c) => c.localName === 'text-content')) return '@';
  const own = section(el);
  const maps = kids(el, 'map').map((m) => ({ cond: (attr(m, 'condition') ?? '').replace(/\s+/g, ''), style: styles.get(attr(m, 'apply-style-name') ?? '') }));
  const sec = (e: Element | undefined) => (e ? section(e) : '');
  let code = own;
  const pos = maps.find((m) => m.cond === 'value()>=0' || m.cond === 'value()>0');
  const neg = maps.find((m) => m.cond === 'value()<0');
  if (pos && neg) code = `${sec(pos.style)};${sec(neg.style)};${own}`;
  else if (pos) code = `${sec(pos.style)};${own}`;
  else if (neg) code = `${own};${sec(neg.style)}`;
  // A data style with only its number and no decorations is just the number.
  if (!code || code === '#' || code === 'General') return 'General';
  return code;
}

// ---- Excel → ODF -------------------------------------------------------------------------------

interface Tok {
  t: 'lit' | 'digits' | 'date' | 'ampm' | 'color' | 'currency' | 'percent' | 'at' | 'exp' | 'elapsed';
  v: string;
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      const end = j < 0 ? code.length : j;
      cur += code.slice(i, end + 1);
      i = end;
    } else if (ch === '\\') {
      cur += code.slice(i, i + 2);
      i++;
    } else if (ch === '[') {
      const j = code.indexOf(']', i);
      const end = j < 0 ? code.length - 1 : j;
      cur += code.slice(i, end + 1);
      i = end;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const lit = (v: string) => {
    const last = out[out.length - 1];
    if (last?.t === 'lit') last.v += v;
    else out.push({ t: 'lit', v });
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const rest = s.slice(i);
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      const end = j < 0 ? s.length : j;
      lit(s.slice(i + 1, end));
      i = end;
    } else if (ch === '\\') {
      lit(s[i + 1] ?? '');
      i++;
    } else if (ch === '_') {
      // Space as wide as the next character.
      lit(' ');
      i++;
    } else if (ch === '*') {
      i++;
    } else if (ch === '[') {
      const j = s.indexOf(']', i);
      const inner = s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j;
      if (/^\$/.test(inner)) {
        const sym = inner.slice(1).split('-')[0];
        if (sym) out.push({ t: 'currency', v: sym });
      } else if (/^h+$|^m+$|^s+$/i.test(inner)) out.push({ t: 'elapsed', v: inner.toLowerCase() });
      else if (/^[a-z]+$/i.test(inner) && !/^color/i.test(inner)) out.push({ t: 'color', v: inner.toLowerCase() });
    } else if (/^AM\/PM|^A\/P/i.test(rest)) {
      out.push({ t: 'ampm', v: 'AM/PM' });
      i += /^AM\/PM/i.test(rest) ? 4 : 2;
    } else if (/[yYmMdDhHsS]/.test(ch)) {
      let j = i;
      while (j < s.length && s[j].toLowerCase() === ch.toLowerCase()) j++;
      out.push({ t: 'date', v: s.slice(i, j).toLowerCase() });
      i = j - 1;
    } else if (/[0#?]/.test(ch) || (ch === '.' && /[0#?]/.test(s[i + 1] ?? '')) || (ch === ',' && /[0#?]/.test(s[i - 1] ?? '') && /[0#?,]/.test(s[i + 1] ?? ''))) {
      let j = i;
      while (j < s.length && (/[0#?.,]/.test(s[j]) || (s[j] === '/' && /[0-9?#]/.test(s[j + 1] ?? '')) || (s[j] === ' ' && /[?#0]/.test(s[j + 1] ?? '') && s.slice(j + 1).includes('/')))) j++;
      out.push({ t: 'digits', v: s.slice(i, j) });
      i = j - 1;
    } else if ((ch === 'E' || ch === 'e') && /^[eE][+-]/.test(rest)) {
      let j = i + 2;
      while (j < s.length && /[0#]/.test(s[j])) j++;
      out.push({ t: 'exp', v: s.slice(i + 2, j) });
      i = j - 1;
    } else if (ch === '%') out.push({ t: 'percent', v: '%' });
    else if (ch === '@') out.push({ t: 'at', v: '@' });
    else if ('$€£¥'.includes(ch)) out.push({ t: 'currency', v: ch });
    else lit(ch);
  }
  return out;
}

const COLOR_HEX: Record<string, string> = { red: '#FF0000', blue: '#0000FF', green: '#00FF00', black: '#000000', white: '#FFFFFF', yellow: '#FFFF00', magenta: '#FF00FF', cyan: '#00FFFF' };

function numberEl(digits: string, tag = 'number:number', extra = ''): string {
  const fraction = /\//.test(digits);
  if (fraction) {
    const m = /^(?:([#0?]+)\s+)?([?#0]+)\/([?#0]+|\d+)$/.exec(digits.trim());
    const num = m?.[2]?.length ?? 1;
    const den = m?.[3] ?? '?';
    return `<number:fraction${m?.[1] ? ` number:min-integer-digits="${(m[1].match(/0/g) ?? []).length}"` : ''} number:min-numerator-digits="${num}"${/^\d+$/.test(den) ? ` number:denominator-value="${den}"` : ` number:min-denominator-digits="${den.length}"`}/>`;
  }
  const clean = digits.replace(/,+$/, '');
  const [int, dec = ''] = clean.split('.');
  const minInt = (int.match(/0/g) ?? []).length;
  const grouping = int.includes(',');
  const decimals = (dec.match(/[0#?]/g) ?? []).length;
  const minDecimals = (dec.match(/0/g) ?? []).length;
  return `<${tag}${attrs({ 'number:decimal-places': decimals, 'number:min-decimal-places': minDecimals, 'number:min-integer-digits': minInt, 'number:grouping': grouping ? 'true' : null })}${extra}/>`;
}

/** A section as a data style element; null if it's General. */
function sectionStyle(code: string, name: string, extra = ''): { xml: string; family: string } | null {
  const toks = tokenize(code);
  if (!toks.length || (toks.length === 1 && toks[0].t === 'lit' && /^general$/i.test(toks[0].v.trim()))) return null;
  const isDate = toks.some((t) => t.t === 'date' || t.t === 'elapsed');
  const color = toks.find((t) => t.t === 'color');
  const tp = color && COLOR_HEX[color.v] ? `<style:text-properties fo:color="${COLOR_HEX[color.v]}"/>` : '';
  const text = (v: string) => (v ? `<number:text>${esc(v)}</number:text>` : '');
  let body = '';
  let family = 'number-style';
  if (isDate) {
    const hasDate = toks.some((t) => t.t === 'date' && /^[yd]/.test(t.v)) || toks.some((t, i) => t.t === 'date' && t.v.startsWith('m') && !isMinute(toks, i));
    family = hasDate ? 'date-style' : 'time-style';
    let elapsed = false;
    toks.forEach((t, i) => {
      if (t.t === 'lit') body += text(t.v.replace(/^\.$/, '.'));
      else if (t.t === 'ampm') body += '<number:am-pm/>';
      else if (t.t === 'elapsed') {
        elapsed = true;
        const c = t.v[0];
        body += c === 'h' ? `<number:hours${t.v.length > 1 ? ' number:style="long"' : ''}/>` : c === 'm' ? '<number:minutes number:style="long"/>' : '<number:seconds number:style="long"/>';
      } else if (t.t === 'digits' && /^\.0+$/.test(t.v)) {
        // Fractions of a second belong to the seconds before them.
        const prev = body.lastIndexOf('<number:seconds');
        if (prev >= 0) body = body.slice(0, prev) + body.slice(prev).replace('<number:seconds', `<number:seconds number:decimal-places="${t.v.length - 1}"`);
      } else if (t.t === 'date') {
        const long = t.v.length >= 2;
        const style = long ? ' number:style="long"' : '';
        switch (t.v[0]) {
          case 'y':
            body += `<number:year${t.v.length > 2 ? ' number:style="long"' : ''}/>`;
            break;
          case 'd':
            body += t.v.length >= 4 ? '<number:day-of-week number:style="long"/>' : t.v.length === 3 ? '<number:day-of-week/>' : `<number:day${style}/>`;
            break;
          case 'h':
            body += `<number:hours${style}/>`;
            break;
          case 's':
            body += `<number:seconds${style}/>`;
            break;
          case 'm':
            if (isMinute(toks, i)) body += `<number:minutes${style}/>`;
            else if (t.v.length >= 4) body += '<number:month number:style="long" number:textual="true"/>';
            else if (t.v.length === 3) body += '<number:month number:textual="true"/>';
            else body += `<number:month${style}/>`;
            break;
        }
      }
    });
    const tag = `number:${family}`;
    return { family, xml: `<${tag} style:name="${name}"${elapsed && family === 'time-style' ? ' number:truncate-on-overflow="false"' : ''}>${tp}${body}${extra}</${tag}>` };
  }
  if (toks.some((t) => t.t === 'at') && !toks.some((t) => t.t === 'digits')) {
    family = 'text-style';
    for (const t of toks) body += t.t === 'at' ? '<number:text-content/>' : t.t === 'lit' ? text(t.v) : '';
    return { family, xml: `<number:text-style style:name="${name}">${tp}${body}${extra}</number:text-style>` };
  }
  const percent = toks.some((t) => t.t === 'percent');
  const currency = toks.find((t) => t.t === 'currency');
  family = percent ? 'percentage-style' : currency ? 'currency-style' : 'number-style';
  let numberDone = false;
  toks.forEach((t, i) => {
    if (t.t === 'lit') {
      // A quoted "$" is how Excel writes dollars; keep it a currency symbol for LibreOffice.
      if (family === 'currency-style' && t.v === '$') body += '<number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol>';
      else body += text(t.v);
    } else if (t.t === 'percent') body += text('%');
    else if (t.t === 'currency') body += `<number:currency-symbol>${esc(t.v)}</number:currency-symbol>`;
    else if (t.t === 'digits' && !numberDone) {
      numberDone = true;
      const exp = toks[i + 1]?.t === 'exp' ? toks[i + 1].v : null;
      body += exp !== null ? numberEl(t.v, 'number:scientific-number', ` number:min-exponent-digits="${Math.max(1, exp.length)}"`) : numberEl(t.v);
    }
  });
  if (!numberDone) return null;
  const tag = `number:${family}`;
  return { family, xml: `<${tag} style:name="${name}">${tp}${body}${extra}</${tag}>` };
}

/** Whether an m at token i means minutes: right after hours or right before seconds. */
function isMinute(toks: Tok[], i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.t === 'date' || t.t === 'elapsed') {
      if (t.v[0] === 'h') return true;
      break;
    }
  }
  for (let k = i + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'date' || t.t === 'elapsed') return t.v[0] === 's';
  }
  return false;
}

/** Data styles for a format code, named `name` (its sections get `name`P0, P1...); null for General. */
export function dataStylesFor(code: string, name: string): string | null {
  if (!code || /^general$/i.test(code)) return null;
  const secs = splitSections(code).map((s) => s.trim() === '' ? 'General' : s);
  if (secs.length === 1) return sectionStyle(secs[0], name)?.xml ?? null;
  // The main style is the last numeric section; the others map onto it by condition.
  const numeric = secs.slice(0, 3);
  const conds = numeric.length === 2 ? ['value()>=0'] : ['value()>0', 'value()<0'];
  const out: string[] = [];
  const maps: string[] = [];
  for (let i = 0; i < numeric.length - 1; i++) {
    const sub = sectionStyle(numeric[i], `${name}P${i}`);
    if (!sub) continue;
    out.push(sub.xml);
    maps.push(`<style:map style:condition="${esc(conds[i])}" style:apply-style-name="${name}P${i}"/>`);
  }
  // A negative section that writes no sign of its own shows one in Excel; ODF's needs it spelled out.
  let last = numeric[numeric.length - 1];
  if (numeric.length === 2 && !/[-(]/.test(last.replace(/"[^"]*"|\[[^\]]*\]/g, ''))) last = `-${last}`;
  const main = sectionStyle(last, name, maps.join(''));
  if (!main) return sectionStyle(secs[0], name)?.xml ?? null;
  return out.join('') + main.xml;
}
