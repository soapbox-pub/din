import { parseCell } from './addr';

/**
 * The bulk of a workbook, read without a DOM: a worksheet's <sheetData> and
 * the shared strings. These are the parts that grow with the data (hundreds
 * of megabytes in a big export), so they're scanned as text in a worker and
 * handed back as flat arrays; the rest of each part stays XML for the
 * reader's DOM.
 */

/** What a scanned cell's `val` means. */
export const K_NULL = 0;
/** `val` indexes `nums`. */
export const K_NUM = 1;
/** `val` indexes `strs`. */
export const K_STR = 2;
/** `val` indexes the shared strings (-1: none). */
export const K_SHARED = 3;
/** `val` is 0 or 1. */
export const K_BOOL = 4;
/** `val` indexes `strs`: the error's text. */
export const K_ERR = 5;

export const F_PLAIN = 0;
export const F_SHARED = 1;
export const F_ARRAY = 2;
export const F_DATA_TABLE = 3;

export const ROW_CUSTOM_HEIGHT = 1;
export const ROW_HIDDEN = 2;
export const ROW_CUSTOM_FORMAT = 4;

/** Fields per entry of `ScannedSheet.rows` and `.cells`. */
export const ROW_FIELDS = 4;
export const CELL_FIELDS = 5;

export interface ScannedSheet {
  /** The part with its <sheetData> emptied. */
  rest: string;
  /** Per row: index, height in points (NaN: none), ROW_* flags, style (NaN: none). */
  rows: Float64Array;
  /** Per cell: row, column, style (-1: none), K_* kind, value. */
  cells: Int32Array;
  nums: Float64Array;
  strs: string[];
  /** Formulas, in cell order: the cell's index in `cells`, F_* type, `si` and text. */
  fCell: Int32Array;
  fType: Uint8Array;
  fSi: string[];
  fText: string[];
}

class Ints {
  a = new Int32Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

class Floats {
  a = new Float64Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** _x000D_-style escapes Excel writes for control characters. */
export function unescapeX(s: string): string {
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : s;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isTrue = (v: string | undefined) => v === '1' || v === 'true';

/** A forward-only reader of XML tags over a string. */
class Tags {
  pos: number;
  /** The tag just read: its local name, whether it closes, whether it's empty (<x/>). */
  private local = '';
  closing = false;
  empty = false;
  attrs: Record<string, string> = {};

  name(): string {
    return this.local;
  }

  constructor(
    private s: string,
    start: number,
    private end: number,
  ) {
    this.pos = start;
  }

  /** Read the next tag, skipping text, comments and processing instructions. False at the end. */
  next(): boolean {
    const s = this.s;
    for (;;) {
      const lt = s.indexOf('<', this.pos);
      if (lt < 0 || lt >= this.end) {
        this.pos = this.end;
        return false;
      }
      const c = s.charCodeAt(lt + 1);
      if (c === 33 /* ! */) {
        const close = s.startsWith('<!--', lt) ? '-->' : s.startsWith('<![CDATA[', lt) ? ']]>' : '>';
        const e = s.indexOf(close, lt);
        this.pos = e < 0 ? this.end : e + close.length;
        continue;
      }
      if (c === 63 /* ? */) {
        const e = s.indexOf('?>', lt);
        this.pos = e < 0 ? this.end : e + 2;
        continue;
      }
      this.tag(lt);
      return true;
    }
  }

  private tag(lt: number) {
    const s = this.s;
    let p = lt + 1;
    this.closing = s.charCodeAt(p) === 47;
    if (this.closing) p++;
    const start = p;
    let colon = -1;
    for (;;) {
      const c = s.charCodeAt(p);
      if (c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13 || Number.isNaN(c)) break;
      if (c === 58) colon = p;
      p++;
    }
    this.local = s.slice(colon < 0 ? start : colon + 1, p);
    const attrs: Record<string, string> = {};
    this.empty = false;
    for (;;) {
      const c = s.charCodeAt(p);
      if (Number.isNaN(c)) break;
      if (c === 62) {
        p++;
        break;
      }
      if (c === 47) {
        this.empty = true;
        p++;
        continue;
      }
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        p++;
        continue;
      }
      const eq = s.indexOf('=', p);
      if (eq < 0) break;
      let key = s.slice(p, eq).trim();
      const k = key.indexOf(':');
      if (k >= 0 && key.slice(0, k) !== 'xmlns') key = key.slice(k + 1);
      let q = eq + 1;
      while (s.charCodeAt(q) !== 34 && s.charCodeAt(q) !== 39 && q < s.length) q++;
      const quote = s[q];
      const e = s.indexOf(quote, q + 1);
      if (e < 0) break;
      attrs[key] = decode(s.slice(q + 1, e).replace(/[\t\n\r]/g, ' '));
      p = e + 1;
    }
    this.attrs = attrs;
    this.pos = p;
  }

  /** The text inside the element whose open tag was just read, up to and past its close. */
  text(): string {
    if (this.empty) return '';
    const s = this.s;
    // The common case: plain text, then the close tag.
    const lt = s.indexOf('<', this.pos);
    if (lt >= 0 && s.charCodeAt(lt + 1) === 47) {
      const raw = s.slice(this.pos, lt);
      this.tag(lt);
      return decode(raw);
    }
    let out = '';
    let depth = 1;
    while (depth > 0) {
      const at = s.indexOf('<', this.pos);
      if (at < 0 || at >= this.end) {
        out += decode(s.slice(this.pos, this.end));
        this.pos = this.end;
        break;
      }
      out += decode(s.slice(this.pos, at));
      if (s.startsWith('<![CDATA[', at)) {
        const e = s.indexOf(']]>', at);
        out += s.slice(at + 9, e < 0 ? this.end : e);
        this.pos = e < 0 ? this.end : e + 3;
        continue;
      }
      this.pos = at;
      if (!this.next()) break;
      if (this.closing) depth--;
      else if (!this.empty) depth++;
    }
    return out;
  }

  /** Skip past the close of the element whose open tag was just read. */
  skip() {
    if (this.empty) return;
    let depth = 1;
    while (depth > 0 && this.next()) {
      if (this.closing) depth--;
      else if (!this.empty) depth++;
    }
  }
}

/** The text of an <si> or <is> whose open tag was just read: plain <t>, or rich-text runs. */
function stringItem(tags: Tags): string {
  if (tags.empty) return '';
  let plain: string | null = null;
  let runs = '';
  while (tags.next()) {
    if (tags.closing) break;
    if (tags.name() === 't') {
      const t = tags.text();
      plain ??= t;
    } else if (tags.name() === 'r') {
      if (tags.empty) continue;
      while (tags.next()) {
        if (tags.closing) break;
        if (tags.name() === 't') runs += tags.text();
        else tags.skip();
      }
    } else tags.skip();
  }
  return unescapeX(plain ?? runs);
}

/** The root element's local name, or null. */
export function rootName(s: string): string | null {
  const tags = new Tags(s, 0, Math.min(s.length, 4096));
  return tags.next() && !tags.closing ? tags.name() : null;
}

/** A shared strings part's strings. */
export function scanSharedStrings(s: string): string[] {
  const out: string[] = [];
  const tags = new Tags(s, 0, s.length);
  if (!tags.next() || tags.empty) return out;
  while (tags.next()) {
    if (tags.closing) break;
    if (tags.name() === 'si') out.push(stringItem(tags));
    else tags.skip();
  }
  return out;
}

const SHEET_DATA = /<([\w.-]+:)?sheetData[\s/>]/g;

/** A worksheet part's rows and cells. Null if it has no <sheetData>. */
export function scanSheet(s: string): ScannedSheet | null {
  SHEET_DATA.lastIndex = 0;
  const m = SHEET_DATA.exec(s);
  if (!m) return null;
  const open = m.index;
  const tags = new Tags(s, open, s.length);
  tags.next();
  const prefix = m[1] ?? '';
  let close = tags.pos;
  let end = tags.pos;
  if (!tags.empty) {
    const closeTag = `</${prefix}sheetData>`;
    close = s.indexOf(closeTag, tags.pos);
    if (close < 0) throw new Error('A part of the file isn’t well-formed XML.');
    end = close + closeTag.length;
  }

  const rows = new Floats();
  const cells = new Ints();
  const nums = new Floats();
  const strs: string[] = [];
  const strIndex = new Map<string, number>();
  const fCell = new Ints();
  const fType: number[] = [];
  const fSi: string[] = [];
  const fText: string[] = [];
  const str = (v: string) => {
    let i = strIndex.get(v);
    if (i === undefined) {
      i = strs.length;
      strs.push(v);
      strIndex.set(v, i);
    }
    return i;
  };

  const body = new Tags(s, tags.pos, close);
  let nextRow = 0;
  while (body.next()) {
    if (body.closing) continue;
    if (body.name() !== 'row') {
      body.skip();
      continue;
    }
    const ra = body.attrs;
    const r = (num(ra.r) ?? nextRow + 1) - 1;
    nextRow = r + 1;
    rows.push(r);
    rows.push(num(ra.ht) ?? NaN);
    rows.push((isTrue(ra.customHeight) ? ROW_CUSTOM_HEIGHT : 0) | (isTrue(ra.hidden) ? ROW_HIDDEN : 0) | (ra.customFormat === '1' ? ROW_CUSTOM_FORMAT : 0));
    rows.push(num(ra.s) ?? NaN);
    if (body.empty) continue;
    let nextCol = 0;
    while (body.next()) {
      if (body.closing) break;
      if (body.name() !== 'c') {
        body.skip();
        continue;
      }
      const ca = body.attrs;
      const ref = parseCell(ca.r ?? '');
      const col = ref ? ref.c : nextCol;
      nextCol = col + 1;
      const t = ca.t ?? 'n';
      const sIdx = num(ca.s);
      let raw: string | null = null;
      let inline: string | null = null;
      let fType_ = -1;
      let fSi_ = '';
      let fText_ = '';
      if (!body.empty) {
        while (body.next()) {
          if (body.closing) break;
          const n = body.name();
          if (n === 'v') raw ??= body.text();
          else if (n === 'is') inline ??= stringItem(body);
          else if (n === 'f' && fType_ < 0) {
            const ft = body.attrs.t;
            fType_ = ft === 'shared' ? F_SHARED : ft === 'array' ? F_ARRAY : ft === 'dataTable' ? F_DATA_TABLE : F_PLAIN;
            fSi_ = body.attrs.si ?? '';
            fText_ = body.text();
          } else body.skip();
        }
      }
      let kind = K_NULL;
      let val = 0;
      if (t === 's') {
        if (raw !== null) {
          kind = K_SHARED;
          const i = parseInt(raw, 10);
          val = Number.isFinite(i) ? i : -1;
        }
      } else if (t === 'inlineStr') {
        kind = K_STR;
        val = str(inline ?? '');
      } else if (t === 'str') {
        kind = K_STR;
        val = str(raw !== null ? unescapeX(raw) : '');
      } else if (t === 'b') {
        kind = K_BOOL;
        val = raw === '1' || raw === 'true' ? 1 : 0;
      } else if (t === 'e') {
        kind = K_ERR;
        val = str(raw ?? '');
      } else if (t === 'd') {
        const d = raw ? Date.parse(raw) : NaN;
        if (Number.isFinite(d)) {
          kind = K_NUM;
          val = nums.n;
          nums.push(d / 86400000 + 25569);
        }
      } else if (raw !== null && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          kind = K_NUM;
          val = nums.n;
          nums.push(n);
        } else {
          kind = K_STR;
          val = str(raw);
        }
      }
      if (fType_ >= 0) {
        fCell.push(cells.n / CELL_FIELDS);
        fType.push(fType_);
        fSi.push(fSi_);
        fText.push(fText_);
      }
      cells.push(r);
      cells.push(col);
      cells.push(sIdx !== null && Number.isInteger(sIdx) ? sIdx : -1);
      cells.push(kind);
      cells.push(val);
    }
  }

  const rest = `${s.slice(0, open)}<${prefix}sheetData/>${s.slice(end)}`;
  return {
    rest,
    rows: rows.done(),
    cells: cells.done(),
    nums: nums.done(),
    strs,
    fCell: fCell.done(),
    fType: Uint8Array.from(fType),
    fSi,
    fText,
  };
}
