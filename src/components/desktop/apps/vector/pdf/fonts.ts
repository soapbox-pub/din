import type { FontEntry, FontRef } from '../model';
import { ENCODINGS, glyphNameToText, STANDARD } from './encodings';
import { cmdsToPath, readGlyphFont, type GlyphFont } from './glyphs';
import { decodeStream, latin1, PdfDoc, PdfName, PdfRef, PdfStream, type PdfDict, type PdfValue } from './objects';

/**
 * A PDF font as the editor uses it: which glyph each code draws, how wide it
 * is, what text it stands for, and how to write new text with it again.
 */

/** "ABCDEF+MyriadPro-BoldIt" → { family: "Myriad Pro", style: "Bold Italic", postscript: "MyriadPro-BoldIt" }. */
export function fontRefFromName(base: string, embedded?: string): FontRef {
  const ps = base.replace(/^[A-Z]{6}\+/, '');
  const [famRaw, styleRaw = ''] = ps.split(/[-,]/);
  const family = famRaw
    .replace(/(MT|PS|Std|Pro|LT)$/, (m) => ` ${m}`)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/ (MT|PS)$/, '')
    .trim();
  const style = styleRaw
    .replace(/It$/, 'Italic')
    .replace(/^It$/, 'Italic')
    .replace(/Bd/, 'Bold')
    .replace(/Lt/, 'Light')
    .replace(/Smbd|SemiBd/, 'Semibold')
    .replace(/Cond/, 'Condensed ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return { family: family || ps, style: style || 'Regular', postscript: ps, embedded };
}

/** Parse a ToUnicode CMap (bfchar and bfrange). */
function parseToUnicode(data: Uint8Array): { map: Map<number, string>; bytes: 1 | 2 } {
  const s = latin1(data);
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const hex = (h: string) => parseInt(h, 16);
  const utf16 = (h: string) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(hex(h.slice(i, i + 4)));
    if (h.length === 2) out = String.fromCharCode(hex(h));
    return out;
  };
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(s);
  if (cs) {
    const m = /<([0-9a-fA-F]+)>/.exec(cs[1]);
    if (m && m[1].length >= 4) bytes = 2;
  }
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(hex(m[1]), utf16(m[2]));
      if (m[1].length >= 4) bytes = 2;
    }
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    for (const m of block[1].matchAll(re)) {
      const a = hex(m[1]);
      const z = hex(m[2]);
      if (m[1].length >= 4) bytes = 2;
      if (z - a > 65535) continue;
      if (m[3] !== undefined) {
        const base = utf16(m[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = a; c <= z; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + c - a));
      } else if (m[4] !== undefined) {
        const list = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        for (let c = a; c <= z; c++) map.set(c, list[c - a] ?? '');
      }
    }
  }
  return { map, bytes };
}

/** A CID CMap embedded as a stream: code ranges to CIDs. Identity when it can't say. */
function parseCidCmap(data: Uint8Array): (code: number) => number {
  const s = latin1(data);
  const ranges: [number, number, number][] = [];
  const singles = new Map<number, number>();
  for (const block of s.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push([parseInt(m[1], 16), parseInt(m[2], 16), Number(m[3])]);
  }
  for (const block of s.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) singles.set(parseInt(m[1], 16), Number(m[2]));
  }
  return (code) => {
    const v = singles.get(code);
    if (v !== undefined) return v;
    for (const [a, z, cid] of ranges) if (code >= a && code <= z) return cid + code - a;
    return code;
  };
}

let fontSeq = 0;

/** Read a font resource. Never throws: a font that can't be read draws with a substitute. */
export function loadFont(doc: PdfDoc, ref: PdfValue, cache: Map<string, FontEntry>): FontEntry {
  const key = ref instanceof PdfRef ? `f${docSerial(doc)}:${ref.num} ${ref.gen}` : `inline${fontSeq++}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = doc.dict(ref) ?? new Map();
  const subtype = doc.name(d.get('Subtype')) ?? 'Type1';
  const base = doc.name(d.get('BaseFont')) ?? 'Helvetica';
  const src = { doc, value: ref };
  let entry: FontEntry;
  try {
    entry = subtype === 'Type0' ? cidFont(doc, d, base, key, src) : subtype === 'Type3' ? type3Font(doc, d, key, src) : simpleFont(doc, d, base, subtype, key, src);
  } catch {
    entry = fallbackFont(base, key, src);
  }
  cache.set(key, entry);
  return entry;
}

function fallbackFont(base: string, key: string, source: FontEntry['source']): FontEntry {
  return {
    key,
    ref: fontRefFromName(base),
    glyph: () => null,
    outline: () => null,
    width: () => 500,
    toUnicode: (c) => String.fromCharCode(c),
    encode: () => null,
    bytes: 1,
    source,
    outlines: false,
    ascent: 750,
    descent: -250,
  };
}

function descriptorProgram(doc: PdfDoc, desc: PdfDict | null): GlyphFont | null {
  if (!desc) return null;
  for (const k of ['FontFile2', 'FontFile3', 'FontFile'] as const) {
    const s = doc.resolve(desc.get(k));
    if (s instanceof PdfStream) {
      const data = decodeStream(doc, s).data;
      const len1 = typeof doc.resolve(s.dict.get('Length1')) === 'number' ? (doc.resolve(s.dict.get('Length1')) as number) : 0;
      return readGlyphFont(data, k, k === 'FontFile' ? len1 : 0);
    }
  }
  return null;
}

function metrics(doc: PdfDoc, desc: PdfDict | null) {
  const a = doc.resolve(desc?.get('Ascent'));
  const dd = doc.resolve(desc?.get('Descent'));
  return { ascent: typeof a === 'number' && a > 0 ? a : 750, descent: typeof dd === 'number' && dd < 0 ? dd : -250 };
}

function simpleFont(doc: PdfDoc, d: PdfDict, base: string, subtype: string, key: string, source: FontEntry['source']): FontEntry {
  const desc = doc.dict(d.get('FontDescriptor'));
  const prog = descriptorProgram(doc, desc);
  const flags = typeof doc.resolve(desc?.get('Flags')) === 'number' ? (doc.resolve(desc?.get('Flags')) as number) : 0;
  const symbolic = !!(flags & 4) && !(flags & 32);
  // Code → glyph name: Differences over the base encoding over the font's own.
  const encVal = doc.resolve(d.get('Encoding'));
  let names: (string | undefined)[] = new Array(256);
  let hasEncoding = false;
  const baseName = encVal instanceof PdfName ? encVal.name : encVal instanceof Map ? doc.name(encVal.get('BaseEncoding')) : null;
  if (baseName && ENCODINGS[baseName]) {
    names = ENCODINGS[baseName].map((n) => n || undefined);
    hasEncoding = true;
  } else if (prog?.builtinEncoding) names = [...prog.builtinEncoding];
  else if (!symbolic) {
    names = (subtype === 'TrueType' ? ENCODINGS.WinAnsiEncoding : STANDARD).map((n) => n || undefined);
    hasEncoding = subtype === 'TrueType';
  }
  if (encVal instanceof Map) {
    const diffs = doc.array(encVal.get('Differences'));
    let code = 0;
    for (const v of diffs) {
      const r = doc.resolve(v);
      if (typeof r === 'number') code = r;
      else if (r instanceof PdfName) {
        names[code++] = r.name;
        hasEncoding = true;
      }
    }
  }
  const tu = doc.resolve(d.get('ToUnicode'));
  const toUni = tu instanceof PdfStream ? parseToUnicode(decodeStream(doc, tu).data).map : null;

  const first = typeof doc.resolve(d.get('FirstChar')) === 'number' ? (doc.resolve(d.get('FirstChar')) as number) : 0;
  const widths = doc.numbers(d.get('Widths'));
  const missing = typeof doc.resolve(desc?.get('MissingWidth')) === 'number' ? (doc.resolve(desc?.get('MissingWidth')) as number) : 0;

  const gidOf = (code: number): number | null => {
    if (!prog) return null;
    const name = names[code];
    if (prog.kind === 'truetype') {
      const c30 = prog.cmaps.get('3,0');
      const c10 = prog.cmaps.get('1,0');
      const c31 = prog.cmaps.get('3,1');
      if ((symbolic || !hasEncoding) && c30) {
        const g = c30.get(0xf000 + code) ?? c30.get(code) ?? c30.get(0xf100 + code) ?? c30.get(0xf200 + code);
        if (g) return g;
      }
      if (name && c31) {
        const t = glyphNameToText(name);
        const g = t ? c31.get(t.charCodeAt(0)) : undefined;
        if (g) return g;
      }
      if (name) {
        const g = prog.gidByName(name);
        if (g) return g;
      }
      if (c10) {
        const g = c10.get(code);
        if (g) return g;
      }
      if (c30) {
        const g = c30.get(0xf000 + code) ?? c30.get(code);
        if (g) return g;
      }
      if (c31 && !name) {
        const g = c31.get(code);
        if (g) return g;
      }
      return null;
    }
    if (name) {
      const g = prog.gidByName(name);
      if (g !== null) return g;
    }
    const builtin = prog.builtinEncoding?.[code];
    return builtin ? prog.gidByName(builtin) : null;
  };

  const paths = new Map<number, Path2D | null>();
  const unicodeOf = (code: number) => toUni?.get(code) ?? (names[code] ? glyphNameToText(names[code]!) : '') ?? String.fromCharCode(code);
  const reverse = new Map<string, number>();
  for (let c = 255; c >= 0; c--) {
    const t = unicodeOf(c);
    if (t && (!prog || gidOf(c) !== null)) reverse.set(t, c);
  }
  const m = metrics(doc, desc);
  return {
    key,
    ref: fontRefFromName(base, prog ? key : undefined),
    glyph(code) {
      if (paths.has(code)) return paths.get(code)!;
      const g = gidOf(code);
      const cmds = g !== null && prog ? prog.outline(g) : null;
      const p = cmds && cmds.length ? cmdsToPath(cmds) : null;
      paths.set(code, p);
      return p;
    },
    outline(code) {
      const g = gidOf(code);
      return g !== null && prog ? prog.outline(g) : null;
    },
    width(code) {
      const i = code - first;
      if (i >= 0 && i < widths.length) return widths[i];
      if (prog) {
        const g = gidOf(code);
        const a = g !== null ? prog.advance(g) : null;
        if (a !== null) return a;
      }
      return missing || 500;
    },
    toUnicode: unicodeOf,
    encode(text) {
      const out: { code: number; bytes: number }[] = [];
      for (const ch of text) {
        const c = reverse.get(ch);
        if (c === undefined) return null;
        out.push({ code: c, bytes: 1 });
      }
      return out;
    },
    bytes: 1,
    source,
    outlines: !!prog,
    ...m,
  };
}

function cidFont(doc: PdfDoc, d: PdfDict, base: string, key: string, source: FontEntry['source']): FontEntry {
  const desc0 = doc.array(d.get('DescendantFonts'))[0];
  const cid = doc.dict(desc0) ?? new Map();
  const desc = doc.dict(cid.get('FontDescriptor'));
  const prog = descriptorProgram(doc, desc);
  const encVal = doc.resolve(d.get('Encoding'));
  const codeToCid = encVal instanceof PdfStream ? parseCidCmap(decodeStream(doc, encVal).data) : (c: number) => c;
  const c2g = doc.resolve(cid.get('CIDToGIDMap'));
  const cidToGidMap = c2g instanceof PdfStream ? decodeStream(doc, c2g).data : null;
  const gidOf = (code: number) => {
    const c = codeToCid(code);
    if (!prog) return null;
    if (prog.kind === 'cff') return prog.gidByCid(c);
    if (cidToGidMap) return ((cidToGidMap[c * 2] ?? 0) << 8) | (cidToGidMap[c * 2 + 1] ?? 0);
    return c;
  };
  const dw = typeof doc.resolve(cid.get('DW')) === 'number' ? (doc.resolve(cid.get('DW')) as number) : 1000;
  const widths = new Map<number, number>();
  const w = doc.array(cid.get('W')).map((x) => doc.resolve(x));
  for (let i = 0; i < w.length; ) {
    const a = w[i];
    const b = w[i + 1];
    if (typeof a !== 'number') break;
    if (Array.isArray(b)) {
      b.forEach((v, k) => {
        const n = doc.resolve(v);
        if (typeof n === 'number') widths.set(a + k, n);
      });
      i += 2;
    } else if (typeof b === 'number' && typeof w[i + 2] === 'number') {
      for (let c = a; c <= b && c - a < 65536; c++) widths.set(c, w[i + 2] as number);
      i += 3;
    } else break;
  }
  const tu = doc.resolve(d.get('ToUnicode'));
  const toUni = tu instanceof PdfStream ? parseToUnicode(decodeStream(doc, tu).data).map : null;
  const reverse = new Map<string, number>();
  if (toUni) for (const [c, t] of toUni) if (t && !reverse.has(t)) reverse.set(t, c);
  const paths = new Map<number, Path2D | null>();
  const m = metrics(doc, desc);
  return {
    key,
    ref: fontRefFromName(base, prog ? key : undefined),
    glyph(code) {
      if (paths.has(code)) return paths.get(code)!;
      const g = gidOf(code);
      const cmds = g !== null && prog ? prog.outline(g) : null;
      const p = cmds && cmds.length ? cmdsToPath(cmds) : null;
      paths.set(code, p);
      return p;
    },
    outline(code) {
      const g = gidOf(code);
      return g !== null && prog ? prog.outline(g) : null;
    },
    width: (code) => widths.get(codeToCid(code)) ?? dw,
    toUnicode: (code) => toUni?.get(code) ?? '',
    encode(text) {
      const out: { code: number; bytes: number }[] = [];
      for (const ch of text) {
        const c = reverse.get(ch);
        if (c === undefined) return null;
        out.push({ code: c, bytes: 2 });
      }
      return out;
    },
    bytes: 2,
    source,
    outlines: !!prog,
    ...m,
  };
}

/** Type 3 fonts draw glyphs with content streams; shown with a substitute, kept as they are. */
function type3Font(doc: PdfDoc, d: PdfDict, key: string, source: FontEntry['source']): FontEntry {
  const fm = doc.numbers(d.get('FontMatrix'));
  const first = typeof doc.resolve(d.get('FirstChar')) === 'number' ? (doc.resolve(d.get('FirstChar')) as number) : 0;
  const widths = doc.numbers(d.get('Widths'));
  const scale = (fm[0] || 0.001) * 1000;
  const tu = doc.resolve(d.get('ToUnicode'));
  const toUni = tu instanceof PdfStream ? parseToUnicode(decodeStream(doc, tu).data).map : null;
  return {
    ...fallbackFont('Type3', key, source),
    width: (c) => (widths[c - first] ?? 0) * scale,
    toUnicode: (c) => toUni?.get(c) ?? String.fromCharCode(c),
  };
}

const serials = new WeakMap<PdfDoc, number>();
let serialSeq = 1;
function docSerial(doc: PdfDoc): number {
  let s = serials.get(doc);
  if (!s) serials.set(doc, (s = serialSeq++));
  return s;
}
