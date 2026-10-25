import { inflateSync, unzlibSync } from 'fflate';

/**
 * PDF's object layer, enough to read what Illustrator, Inkscape and the
 * rest write: the syntax, cross-reference tables and streams (repairing a
 * broken one by scanning for objects), object streams, and the filters art
 * is stored with. Images in DCT (JPEG) stay encoded; they're shown and
 * written back as they are.
 */

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
  get key() {
    return `${this.num} ${this.gen}`;
  }
}

export type PdfDict = Map<string, PdfValue>;

export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    /** As stored in the file, still encoded. */
    readonly raw: Uint8Array,
  ) {}
}

/** The `R` and `obj` keywords' operator, for content streams. */
export class PdfOp {
  constructor(readonly op: string) {}
}

export type PdfValue = null | boolean | number | string | Uint8Array | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream;

const name = (n: string) => new PdfName(n);
export { name as pdfName };

// ---- Lexing ----------------------------------------------------------------------

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

export const isWs = (c: number) => WS[c] === 1;
export const isDelim = (c: number) => DELIM[c] === 1;
const isRegular = (c: number) => !WS[c] && !DELIM[c];

export class Lexer {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skipWs() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS[c]) this.pos++;
      else if (c === 37) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next token: a value, an operator (PdfOp), or a structural marker. Undefined at the end. */
  token(): PdfValue | PdfOp | '[' | ']' | '<<' | '>>' | '{' | '}' | undefined {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos];
    if (c === 47) {
      // /Name with #xx escapes
      let i = ++this.pos;
      let s = '';
      while (i < b.length && isRegular(b[i])) {
        if (b[i] === 35 && i + 2 < b.length) {
          const h = parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16);
          if (!Number.isNaN(h)) {
            s += String.fromCharCode(h);
            i += 3;
            continue;
          }
        }
        s += String.fromCharCode(b[i++]);
      }
      this.pos = i;
      return new PdfName(s);
    }
    if (c === 40) return this.literalString();
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return '<<';
      }
      return this.hexString();
    }
    if (c === 62 && b[this.pos + 1] === 62) {
      this.pos += 2;
      return '>>';
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) {
      this.pos++;
      return c === 91 ? '[' : c === 93 ? ']' : c === 123 ? '{' : '}';
    }
    // number or keyword
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    if (this.pos === start) {
      // A stray delimiter; step over it.
      this.pos++;
      return new PdfOp(String.fromCharCode(c));
    }
    const word = latin1(b, start, this.pos);
    const n = numberOf(word);
    if (n !== null) return n;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new PdfOp(word);
  }

  private literalString(): Uint8Array {
    const b = this.buf;
    const out: number[] = [];
    let depth = 1;
    let i = this.pos + 1;
    while (i < b.length) {
      const c = b[i++];
      if (c === 92) {
        const e = b[i++];
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 13) {
          if (b[i] === 10) i++;
        } else if (e === 10) {
          // line continuation
        } else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
          out.push(v & 255);
        } else out.push(e);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    this.pos = i;
    return Uint8Array.from(out);
  }

  private hexString(): Uint8Array {
    const b = this.buf;
    let i = this.pos + 1;
    const out: number[] = [];
    let hi = -1;
    while (i < b.length && b[i] !== 62) {
      const v = hexVal(b[i++]);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    this.pos = i + 1;
    return Uint8Array.from(out);
  }
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

export function latin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 8192)));
  return s;
}

function numberOf(w: string): number | null {
  const c = w.charCodeAt(0);
  if (!((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return null;
  const n = Number(w);
  if (Number.isFinite(n)) return n;
  // "--5" and "5-" happen in the wild.
  const m = /^[+-]*(\d*\.?\d*)/.exec(w);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? (w.includes('-') && w.indexOf('-') < w.search(/\d/) ? -v : v) : null;
}

/** Parse values from a lexer; `R` references are folded. */
export class Parser {
  private queue: { tok: ReturnType<Lexer['token']>; pos: number }[] = [];
  constructor(readonly lex: Lexer) {}

  private next() {
    return this.queue.length ? this.queue.shift()!.tok : this.lex.token();
  }
  private peek(n: number) {
    while (this.queue.length < n) {
      this.lex.skipWs();
      const pos = this.lex.pos;
      this.queue.push({ tok: this.lex.token(), pos });
    }
    return this.queue[n - 1].tok;
  }

  /** Like token(), with arrays and dicts read whole. Operators come back as PdfOp. */
  value(): PdfValue | PdfOp | undefined {
    const t = this.next();
    if (t === undefined) return undefined;
    if (t === '[') {
      const arr: PdfValue[] = [];
      for (;;) {
        const p = this.peek(1);
        if (p === ']' || p === undefined) {
          this.next();
          break;
        }
        const v = this.value();
        if (v instanceof PdfOp) continue;
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (t === '<<') {
      const d: PdfDict = new Map();
      for (;;) {
        const k = this.next();
        if (k === '>>' || k === undefined) break;
        if (!(k instanceof PdfName)) continue;
        const p = this.peek(1);
        if (p === '>>') {
          d.set(k.name, null);
          continue;
        }
        const v = this.value();
        if (v === undefined) break;
        if (v instanceof PdfOp) continue;
        d.set(k.name, v);
      }
      return d;
    }
    if (t === ']' || t === '>>' || t === '{' || t === '}') return new PdfOp(t);
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
      const g = this.peek(1);
      const r = this.peek(2);
      if (typeof g === 'number' && Number.isInteger(g) && r instanceof PdfOp && r.op === 'R') {
        this.next();
        this.next();
        return new PdfRef(t, g);
      }
    }
    return t;
  }

  /** Drop any lookahead so the lexer's position is where the last value ended. */
  sync() {
    if (this.queue.length) this.lex.pos = this.queue[0].pos;
    this.queue = [];
  }
}

// ---- Filters -----------------------------------------------------------------------

function asArray<T>(v: T | T[] | null | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function inflate(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    try {
      // Missing or broken zlib header/checksum.
      return inflateSync(data.subarray(2));
    } catch {
      return partialInflate(data);
    }
  }
}

/** Whatever inflates before a stream goes bad, as viewers show it. */
function partialInflate(data: Uint8Array): Uint8Array {
  for (let cut = data.length - 1; cut > 2; cut = Math.floor(cut * 0.9)) {
    try {
      return inflateSync(data.subarray(2, cut));
    } catch {
      // keep cutting
    }
  }
  return new Uint8Array(0);
}

function predictor(data: Uint8Array, parms: PdfDict | null): Uint8Array {
  if (!parms) return data;
  const pred = num(parms.get('Predictor'), 1);
  if (pred < 2) return data;
  const colors = num(parms.get('Colors'), 1);
  const bpc = num(parms.get('BitsPerComponent'), 8);
  const columns = num(parms.get('Columns'), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r * rowLen < out.length; r++) {
      const o = r * rowLen;
      for (let i = bpp; i < rowLen && o + i < out.length; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 255;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else v = x;
      out[dst + i] = v & 255;
    }
    prev.set(out.subarray(dst, dst + rowLen));
  }
  return out;
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 62) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  if (data[0] === 60 && data[1] === 126) i = 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 126) break;
    if (WS[c]) continue;
    if (c === 122 && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function lzw(data: Uint8Array, early = 1): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let bits = 9;
  let buf = 0;
  let nbuf = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < data.length; i++) {
    buf = (buf << 8) | data[i];
    nbuf += 8;
    while (nbuf >= bits) {
      const code = (buf >> (nbuf - bits)) & ((1 << bits) - 1);
      nbuf -= bits;
      if (code === 256) {
        reset();
        bits = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < dict.length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else continue;
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= 1 << bits && bits < 12) bits++;
    }
  }
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
    } else {
      const v = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

export function num(v: PdfValue | undefined, d = 0): number {
  return typeof v === 'number' ? v : d;
}

/** Names of image filters left in place: the bytes are a file format of their own. */
export const IMAGE_CODECS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

/**
 * Decode a stream's data. Decoding stops at an image codec, whose name comes
 * back as `codec` with the bytes it takes.
 */
export function decodeStream(doc: PdfDoc | null, s: PdfStream): { data: Uint8Array; codec: string | null; codecParms: PdfDict | null } {
  const resolve = (v: PdfValue | undefined) => (doc ? doc.resolve(v) : (v ?? null));
  const filters = asArray(resolve(s.dict.get('Filter') ?? s.dict.get('F'))).map((f) => (f instanceof PdfName ? f.name : ''));
  const parms = asArray(resolve(s.dict.get('DecodeParms') ?? s.dict.get('DP'))).map((p) => {
    const r = resolve(p as PdfValue);
    return r instanceof Map ? r : null;
  });
  let data = s.raw;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const p = parms[i] ?? null;
    if (IMAGE_CODECS.has(f)) return { data, codec: f === 'DCT' ? 'DCTDecode' : f, codecParms: p };
    if (f === 'FlateDecode' || f === 'Fl') data = predictor(inflate(data), p);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
    else if (f === 'LZWDecode' || f === 'LZW') data = predictor(lzw(data, p ? num(p.get('EarlyChange'), 1) : 1), p);
    else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
    else if (f === 'Crypt') continue;
    else throw new Error(`It uses a kind of compression this app doesn’t read (${f}).`);
  }
  return { data, codec: null, codecParms: null };
}

// ---- The document -----------------------------------------------------------------

interface XrefEntry {
  /** Byte offset, or the object stream's number for compressed objects. */
  offset: number;
  gen: number;
  /** Index within the object stream, or -1 for an uncompressed object. */
  index: number;
}

export class PdfDoc {
  readonly xref = new Map<number, XrefEntry>();
  trailer: PdfDict = new Map();
  private cache = new Map<number, PdfValue>();
  private objStreams = new Map<number, Map<number, PdfValue>>();
  version = '1.7';

  constructor(readonly bytes: Uint8Array) {
    const head = latin1(bytes, 0, Math.min(1024, bytes.length));
    const v = /%PDF-(\d\.\d)/.exec(head);
    if (!v) throw new Error('It isn’t a PDF.');
    this.version = v[1];
    try {
      this.readXrefChain();
    } catch {
      this.xref.clear();
    }
    if (!this.xref.size || !this.trailer.get('Root')) this.reconstruct();
    if (this.trailer.get('Encrypt')) throw new Error('It’s password-protected or encrypted.');
  }

  private readXrefChain() {
    const tail = latin1(this.bytes, Math.max(0, this.bytes.length - 2048));
    const m = /startxref\s+(\d+)/g;
    let last: RegExpExecArray | null = null;
    for (let r = m.exec(tail); r; r = m.exec(tail)) last = r;
    if (!last) throw new Error('no startxref');
    let offset = Number(last[1]);
    const seen = new Set<number>();
    let first = true;
    while (offset > 0 && !seen.has(offset) && offset < this.bytes.length) {
      seen.add(offset);
      const trailer = this.readXrefAt(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      } else {
        for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      }
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm)) {
        seen.add(stm);
        this.readXrefAt(stm);
      }
      const prev = trailer.get('Prev');
      offset = typeof prev === 'number' ? prev : 0;
    }
  }

  /** Read one xref section (table or stream); earlier entries win, as later sections are older. */
  private readXrefAt(offset: number): PdfDict {
    const lex = new Lexer(this.bytes, offset);
    lex.skipWs();
    if (latin1(this.bytes, lex.pos, lex.pos + 4) === 'xref') {
      lex.pos += 4;
      for (;;) {
        lex.skipWs();
        const save = lex.pos;
        const a = lex.token();
        if (a instanceof PdfOp && a.op === 'trailer') break;
        const b = lex.token();
        if (typeof a !== 'number' || typeof b !== 'number') {
          lex.pos = save;
          break;
        }
        lex.skipWs();
        for (let i = 0; i < b; i++) {
          const line = latin1(this.bytes, lex.pos, lex.pos + 20);
          const mm = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(line);
          if (!mm) break;
          lex.pos += mm[0].length;
          lex.skipWs();
          const n = a + i;
          if (mm[3] === 'n' && !this.xref.has(n)) this.xref.set(n, { offset: Number(mm[1]), gen: Number(mm[2]), index: -1 });
        }
      }
      const p = new Parser(lex);
      const t = p.value();
      return t instanceof Map ? t : new Map();
    }
    // An xref stream: "n g obj << ... >> stream"
    const obj = this.parseObjectAt(offset);
    if (!(obj instanceof PdfStream)) throw new Error('bad xref');
    const d = obj.dict;
    const w = (d.get('W') as number[]) ?? [1, 2, 1];
    const size = num(d.get('Size'));
    const index = (d.get('Index') as number[]) ?? [0, size];
    const data = decodeStream(null, obj).data;
    const rowLen = w[0] + w[1] + w[2];
    let pos = 0;
    const field = (len: number, def: number) => {
      if (!len) return def;
      let v = 0;
      for (let k = 0; k < len; k++) v = v * 256 + data[pos++];
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1] && pos + rowLen <= data.length; i++) {
        const type = field(w[0], 1);
        const f2 = field(w[1], 0);
        const f3 = field(w[2], 0);
        const n = index[s] + i;
        if (this.xref.has(n)) continue;
        if (type === 1) this.xref.set(n, { offset: f2, gen: f3, index: -1 });
        else if (type === 2) this.xref.set(n, { offset: f2, gen: 0, index: f3 });
      }
    }
    return d;
  }

  /** Find every "n g obj" in the file when its cross-reference is missing or broken. */
  private reconstruct() {
    this.xref.clear();
    const s = latin1(this.bytes);
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m.index > 0 && !WS[s.charCodeAt(m.index - 1)] && !DELIM[s.charCodeAt(m.index - 1)]) continue;
      this.xref.set(Number(m[1]), { offset: m.index, gen: Number(m[2]), index: -1 });
    }
    const tr = /trailer\s*<</g;
    let root: PdfValue | undefined;
    for (let m = tr.exec(s); m; m = tr.exec(s)) {
      const p = new Parser(new Lexer(this.bytes, m.index + 7));
      const t = p.value();
      if (t instanceof Map) {
        for (const [k, v] of t) if (k !== 'Prev') this.trailer.set(k, v);
        root ??= t.get('Root');
      }
    }
    if (!this.trailer.get('Root')) {
      // Look for a catalog among the objects, including xref streams' dicts.
      for (const n of this.xref.keys()) {
        const o = this.get(n);
        const d = o instanceof PdfStream ? o.dict : o instanceof Map ? o : null;
        if (d?.get('Type') instanceof PdfName && (d.get('Type') as PdfName).name === 'Catalog') {
          this.trailer.set('Root', new PdfRef(n, 0));
          break;
        }
        if (d?.get('Type') instanceof PdfName && (d.get('Type') as PdfName).name === 'XRef' && d.get('Root')) this.trailer.set('Root', d.get('Root')!);
      }
    }
    // Objects inside object streams.
    for (const n of [...this.xref.keys()]) {
      const o = this.get(n);
      if (o instanceof PdfStream && (o.dict.get('Type') as PdfName | undefined)?.name === 'ObjStm') {
        const objs = this.objectStream(n);
        for (const k of objs.keys()) if (!this.xref.has(k)) this.xref.set(k, { offset: n, gen: 0, index: 0 });
      }
    }
  }

  private parseObjectAt(offset: number): PdfValue {
    const lex = new Lexer(this.bytes, offset);
    const p = new Parser(lex);
    const n = p.value();
    const g = p.value();
    const kw = p.value();
    if (typeof n !== 'number' || typeof g !== 'number' || !(kw instanceof PdfOp) || kw.op !== 'obj') {
      throw new Error(`no object at ${offset}`);
    }
    const v = p.value();
    if (v instanceof PdfOp || v === undefined) return null;
    // Is a stream next? Peek without the parser's queue.
    p.sync();
    const save = lex.pos;
    const t = lex.token();
    if (v instanceof Map && t instanceof PdfOp && t.op === 'stream') {
      let start = lex.pos;
      if (this.bytes[start] === 13) start++;
      if (this.bytes[start] === 10) start++;
      const len = this.resolve(v.get('Length'));
      let end = typeof len === 'number' ? start + len : -1;
      if (end < 0 || end > this.bytes.length || !this.endstreamNear(end)) end = this.findEndstream(start);
      return new PdfStream(v, this.bytes.subarray(start, end));
    }
    lex.pos = save;
    return v;
  }

  private endstreamNear(end: number) {
    const s = latin1(this.bytes, end, Math.min(this.bytes.length, end + 20));
    return /^\s*endstream/.test(s);
  }

  private findEndstream(start: number) {
    const b = this.bytes;
    for (let i = start; i < b.length - 9; i++) {
      if (b[i] === 101 && latin1(b, i, i + 9) === 'endstream') {
        let e = i;
        if (b[e - 1] === 10) e--;
        if (b[e - 1] === 13) e--;
        return Math.max(start, e);
      }
    }
    return b.length;
  }

  private objectStream(num: number): Map<number, PdfValue> {
    let m = this.objStreams.get(num);
    if (m) return m;
    m = new Map();
    this.objStreams.set(num, m);
    const s = this.get(num);
    if (!(s instanceof PdfStream)) return m;
    const data = decodeStream(this, s).data;
    const n = numOf(this.resolve(s.dict.get('N')));
    const first = numOf(this.resolve(s.dict.get('First')));
    const lex = new Lexer(data);
    const heads: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = lex.token();
      const b = lex.token();
      if (typeof a !== 'number' || typeof b !== 'number') break;
      heads.push([a, b]);
    }
    for (const [objNum, off] of heads) {
      const p = new Parser(new Lexer(data, first + off));
      const v = p.value();
      if (!(v instanceof PdfOp) && v !== undefined) m.set(objNum, v);
    }
    return m;
  }

  /** Object `num`, parsed; null if it isn't there. */
  get(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num)!;
    const e = this.xref.get(num);
    let v: PdfValue = null;
    if (e) {
      try {
        v = e.index >= 0 ? (this.objectStream(e.offset).get(num) ?? null) : this.parseObjectAt(e.offset);
      } catch {
        v = null;
      }
    }
    this.cache.set(num, v);
    return v;
  }

  resolve(v: PdfValue | undefined): PdfValue {
    let x = v ?? null;
    for (let i = 0; i < 32 && x instanceof PdfRef; i++) x = this.get(x.num);
    return x instanceof PdfRef ? null : x;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return r instanceof Map ? r : r instanceof PdfStream ? r.dict : null;
  }

  array(v: PdfValue | undefined): PdfValue[] {
    const r = this.resolve(v);
    return Array.isArray(r) ? r : [];
  }

  numbers(v: PdfValue | undefined): number[] {
    return this.array(v).map((x) => numOf(this.resolve(x)));
  }

  name(v: PdfValue | undefined): string | null {
    const r = this.resolve(v);
    return r instanceof PdfName ? r.name : null;
  }

  get catalog(): PdfDict {
    return this.dict(this.trailer.get('Root')) ?? new Map();
  }

  /** Every page's dictionary in order, with inherited attributes filled in. */
  pages(): PdfDict[] {
    const out: PdfDict[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | null, inherited: PdfDict) => {
      if (!node || seen.has(node) || out.length > 10000) return;
      seen.add(node);
      const inh = new Map(inherited);
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) inh.set(k, node.get(k)!);
      const kids = node.get('Kids');
      if (kids !== undefined && this.name(node.get('Type')) !== 'Page') {
        for (const k of this.array(kids)) walk(this.dict(k), inh);
      } else {
        const page = new Map(node);
        for (const [k, v] of inh) if (!page.has(k)) page.set(k, v);
        out.push(page);
      }
    };
    walk(this.dict(this.catalog.get('Pages')), new Map());
    return out;
  }
}

function numOf(v: PdfValue): number {
  return typeof v === 'number' ? v : 0;
}

/** Text strings: UTF-16 with a BOM, UTF-8 with one, else PDFDocEncoding (near enough Latin-1). */
export function textString(v: PdfValue | undefined): string {
  if (typeof v === 'string') return v;
  if (!(v instanceof Uint8Array)) return '';
  if (v[0] === 0xfe && v[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
    return s;
  }
  if (v[0] === 0xef && v[1] === 0xbb && v[2] === 0xbf) return new TextDecoder().decode(v.subarray(3));
  return latin1(v);
}
