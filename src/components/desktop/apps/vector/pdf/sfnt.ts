import { unzlibSync } from 'fflate';
import { readCmaps, sfntTables } from './glyphs';
import { PdfRef, type PdfDict, type PdfValue } from './objects';
import { N, PdfWriter } from './writer';

/**
 * TrueType fonts (bare or in WOFF) embedded in a PDF the way InDesign and
 * Acrobat do it: a subset holding just the glyphs the document uses, as a
 * CIDFontType2 addressed by glyph id (Identity-H), with the widths it was set
 * with and a ToUnicode map so the text can be searched and copied.
 */

const u16 = (b: Uint8Array, p: number) => ((b[p] ?? 0) << 8) | (b[p + 1] ?? 0);
const i16 = (b: Uint8Array, p: number) => {
  const v = u16(b, p);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (b: Uint8Array, p: number) => (b[p] ?? 0) * 0x1000000 + (((b[p + 1] ?? 0) << 16) | ((b[p + 2] ?? 0) << 8) | (b[p + 3] ?? 0));
const tagAt = (b: Uint8Array, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

export interface SfntFont {
  tables: Map<string, Uint8Array>;
  unitsPerEm: number;
  numGlyphs: number;
  /** Glyph for a code point; 0 (.notdef) where the font has none. */
  gid(cp: number): number;
  /** Advance of a glyph in thousandths of an em. */
  advance(gid: number): number;
  postscriptName: string;
  italic: boolean;
  bold: boolean;
}

/** The tables of a WOFF (1.0) file, inflated. */
function woffTables(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const n = u16(b, 12);
  for (let i = 0; i < n; i++) {
    const p = 44 + i * 20;
    const tag = tagAt(b, p);
    const off = u32(b, p + 4);
    const comp = u32(b, p + 8);
    const orig = u32(b, p + 12);
    const data = b.subarray(off, off + comp);
    out.set(tag, comp < orig ? unzlibSync(data) : data);
  }
  return out;
}

function nameRecord(t: Uint8Array | undefined, id: number): string | null {
  if (!t) return null;
  const count = u16(t, 2);
  const strings = u16(t, 4);
  let mac: string | null = null;
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const platform = u16(t, p);
    if (u16(t, p + 6) !== id) continue;
    const len = u16(t, p + 8);
    const off = strings + u16(t, p + 10);
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(t, off + k));
      return s;
    }
    if (platform === 1 && mac === null) mac = String.fromCharCode(...t.subarray(off, off + len));
  }
  return mac;
}

/** Read a TrueType font from TTF or WOFF bytes. Null for what can't be embedded this way (CFF outlines, WOFF2). */
export function readSfnt(bytes: Uint8Array): SfntFont | null {
  const sig = tagAt(bytes, 0);
  if (sig === 'wOF2') return null;
  let tables: Map<string, Uint8Array>;
  try {
    tables = sig === 'wOFF' ? woffTables(bytes) : sfntTables(bytes);
  } catch {
    return null;
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const maxp = tables.get('maxp');
  if (!head || !hhea || !hmtx || !maxp || !tables.get('glyf') || !tables.get('loca')) return null;
  const unitsPerEm = u16(head, 18) || 1000;
  const numGlyphs = u16(maxp, 4);
  const nMetrics = Math.max(1, u16(hhea, 34));
  const cmaps = readCmaps(tables.get('cmap'));
  const cmap = cmaps.get('3,10') ?? cmaps.get('0,4') ?? cmaps.get('3,1') ?? cmaps.get('0,3') ?? new Map<number, number>();
  const macStyle = u16(head, 44);
  const ps = nameRecord(tables.get('name'), 6) ?? nameRecord(tables.get('name'), 4) ?? 'Font';
  return {
    tables,
    unitsPerEm,
    numGlyphs,
    gid: (cp) => {
      const g = cmap.get(cp) ?? 0;
      return g < numGlyphs ? g : 0;
    },
    advance: (gid) => (u16(hmtx, Math.min(gid, nMetrics - 1) * 4) * 1000) / unitsPerEm,
    postscriptName: ps.replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, ''),
    italic: !!(macStyle & 2),
    bold: !!(macStyle & 1),
  };
}

// ---- Subsetting ------------------------------------------------------------------------------

function glyphRange(f: SfntFont, gid: number): [number, number] {
  const head = f.tables.get('head')!;
  const loca = f.tables.get('loca')!;
  if (i16(head, 50) === 1) return [u32(loca, gid * 4), u32(loca, gid * 4 + 4)];
  return [u16(loca, gid * 2) * 2, u16(loca, gid * 2 + 2) * 2];
}

/** The glyphs a composite glyph is built from. */
function components(glyph: Uint8Array): number[] {
  if (glyph.length < 10 || i16(glyph, 0) >= 0) return [];
  const out: number[] = [];
  let p = 10;
  for (;;) {
    const flags = u16(glyph, p);
    out.push(u16(glyph, p + 2));
    p += 4 + (flags & 1 ? 4 : 2);
    if (flags & 8) p += 2;
    else if (flags & 0x40) p += 4;
    else if (flags & 0x80) p += 8;
    if (!(flags & 0x20) || p >= glyph.length) break;
  }
  return out;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + u32(b, i)) >>> 0;
  return sum;
}

/** A TrueType font holding only `keep` (and what they're made of); glyph ids stay as they were. */
export function subsetTrueType(f: SfntFont, keep: Iterable<number>): Uint8Array {
  const glyf = f.tables.get('glyf')!;
  const used = new Set<number>();
  const todo = [0, ...keep];
  while (todo.length) {
    const g = todo.pop()!;
    if (g >= f.numGlyphs || used.has(g)) continue;
    used.add(g);
    const [a, z] = glyphRange(f, g);
    for (const c of components(glyf.subarray(a, z))) if (!used.has(c)) todo.push(c);
  }
  const parts: Uint8Array[] = [];
  const loca = new Uint8Array((f.numGlyphs + 1) * 4);
  const lv = new DataView(loca.buffer);
  let off = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    lv.setUint32(g * 4, off);
    if (!used.has(g)) continue;
    const [a, z] = glyphRange(f, g);
    if (z <= a) continue;
    const len = (z - a + 3) & ~3;
    const data = new Uint8Array(len);
    data.set(glyf.subarray(a, z));
    parts.push(data);
    off += len;
  }
  lv.setUint32(f.numGlyphs * 4, off);
  const newGlyf = new Uint8Array(off);
  let p = 0;
  for (const d of parts) {
    newGlyf.set(d, p);
    p += d.length;
  }
  const head = Uint8Array.from(f.tables.get('head')!);
  new DataView(head.buffer).setUint32(8, 0);
  new DataView(head.buffer).setInt16(50, 1);
  // A post table that names no glyphs.
  const post = new Uint8Array(32);
  const pv = new DataView(post.buffer);
  pv.setUint32(0, 0x30000);
  const oldPost = f.tables.get('post');
  if (oldPost && oldPost.length >= 16) post.set(oldPost.subarray(4, 16), 4);
  const out = new Map<string, Uint8Array>([
    ['glyf', newGlyf],
    ['head', head],
    ['hhea', f.tables.get('hhea')!],
    ['hmtx', f.tables.get('hmtx')!],
    ['loca', loca],
    ['maxp', f.tables.get('maxp')!],
    ['post', post],
  ]);
  for (const t of ['cvt ', 'fpgm', 'prep', 'OS/2']) {
    const d = f.tables.get(t);
    if (d) out.set(t, d);
  }
  return sfntBytes(out);
}

function sfntBytes(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let size = 12 + n * 16;
  for (const t of tags) size += (tables.get(t)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x10000);
  v.setUint16(4, n);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) {
    pow *= 2;
    log++;
  }
  v.setUint16(6, pow * 16);
  v.setUint16(8, log);
  v.setUint16(10, n * 16 - pow * 16);
  let off = 12 + n * 16;
  let headAt = -1;
  tags.forEach((t, i) => {
    const d = tables.get(t)!;
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[p + k] = t.charCodeAt(k);
    v.setUint32(p + 4, checksum(d));
    v.setUint32(p + 8, off);
    v.setUint32(p + 12, d.length);
    out.set(d, off);
    if (t === 'head') headAt = off;
    off += (d.length + 3) & ~3;
  });
  if (headAt >= 0) v.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

// ---- In the PDF ------------------------------------------------------------------------------

let tagSeq = 0;

/** A font being embedded: glyphs are noted as text is set, and the font is written once at the end. */
export class EmbeddedFont {
  readonly ref: PdfRef;
  /** Glyph → the text it stands for. */
  private used = new Map<number, string>();
  constructor(
    readonly w: PdfWriter,
    readonly font: SfntFont,
  ) {
    this.ref = w.add(null);
  }

  /** Glyph id for a character (0 where the font lacks it), noting it as used. */
  glyph(text: string): number {
    const cp = text.codePointAt(0) ?? 0;
    const g = this.font.gid(cp);
    if (g && !this.used.has(g)) this.used.set(g, text);
    return g;
  }

  has(cp: number): boolean {
    return this.font.gid(cp) !== 0;
  }

  width(gid: number): number {
    return Math.round(this.font.advance(gid));
  }

  /** Write the font's objects (if any of its glyphs were used). */
  finish() {
    if (!this.used.size) return;
    const f = this.font;
    const w = this.w;
    let tag = '';
    for (let k = 0, n = ++tagSeq * 7919 + f.postscriptName.length; k < 6; k++, n = Math.floor(n / 26)) tag += String.fromCharCode(65 + (n % 26));
    const base = `${tag}+${f.postscriptName}`;
    const program = subsetTrueType(f, this.used.keys());
    const file = w.stream(new Map<string, PdfValue>([['Length1', program.length]]), program);
    const head = f.tables.get('head')!;
    const hhea = f.tables.get('hhea')!;
    const os2 = f.tables.get('OS/2');
    const post = f.tables.get('post');
    const k = 1000 / f.unitsPerEm;
    const ascent = Math.round(i16(hhea, 4) * k);
    const descent = Math.round(i16(hhea, 6) * k);
    const italicAngle = post ? (u32(post, 4) | 0) / 65536 : 0;
    const desc: PdfDict = new Map<string, PdfValue>([
      ['Type', N('FontDescriptor')],
      ['FontName', N(base)],
      ['Flags', 4 | (f.italic || italicAngle ? 64 : 0)],
      ['FontBBox', [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)].map((v) => Math.round(v * k))],
      ['ItalicAngle', italicAngle],
      ['Ascent', ascent],
      ['Descent', descent],
      ['CapHeight', os2 && u16(os2, 0) >= 2 && os2.length >= 90 ? Math.round(i16(os2, 88) * k) : ascent],
      ['StemV', f.bold ? 140 : 80],
      ['FontFile2', file],
    ]);
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const widths: PdfValue[] = [];
    for (let i = 0; i < gids.length; ) {
      const start = gids[i];
      const run: number[] = [];
      while (i < gids.length && gids[i] === start + run.length) run.push(this.width(gids[i++]));
      widths.push(start, run);
    }
    const cid: PdfDict = new Map<string, PdfValue>([
      ['Type', N('Font')],
      ['Subtype', N('CIDFontType2')],
      ['BaseFont', N(base)],
      ['CIDSystemInfo', new Map<string, PdfValue>([['Registry', 'Adobe'], ['Ordering', 'Identity'], ['Supplement', 0]])],
      ['FontDescriptor', w.add(desc)],
      ['DW', this.width(0)],
      ['W', widths],
      ['CIDToGIDMap', N('Identity')],
    ]);
    w.set(
      this.ref,
      new Map<string, PdfValue>([
        ['Type', N('Font')],
        ['Subtype', N('Type0')],
        ['BaseFont', N(base)],
        ['Encoding', N('Identity-H')],
        ['DescendantFonts', [w.add(cid)]],
        ['ToUnicode', w.stream(new Map(), new TextEncoder().encode(toUnicode(this.used)))],
      ]),
    );
  }
}

function utf16Hex(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0');
  return out;
}

function toUnicode(map: Map<number, string>): string {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [g, t] of chunk) lines.push(`<${g.toString(16).padStart(4, '0')}> <${utf16Hex(t)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}
