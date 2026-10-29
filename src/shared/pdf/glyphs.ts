import { STANDARD } from './encodings';

/**
 * Glyph outlines from the fonts PDFs embed — TrueType, CFF (bare, CID-keyed
 * or inside OpenType) and Type 1 — so type opens looking as it was set even
 * when the font isn't installed, the way Illustrator shows a file's type.
 * Outlines come out in a 1000-unit em, y up, as path commands.
 */

export type GlyphCmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export interface GlyphFont {
  kind: 'truetype' | 'cff' | 'type1';
  /** Glyph id from a name (CFF and Type 1 by name; TrueType through `post`). */
  gidByName(name: string): number | null;
  /** Glyph id from a CID (CID-keyed CFF); identity elsewhere. */
  gidByCid(cid: number): number;
  /** TrueType cmap subtables: platform/encoding → code → gid. */
  cmaps: Map<string, Map<number, number>>;
  /** The font's own encoding (CFF and Type 1): code → glyph name. */
  builtinEncoding: (string | undefined)[] | null;
  outline(gid: number): GlyphCmd[] | null;
  /** Advance in 1000-unit em, where the font knows it. */
  advance(gid: number): number | null;
  glyphCount: number;
}

// ---- Bytes ----------------------------------------------------------------------------

class Reader {
  constructor(
    readonly b: Uint8Array,
    public p = 0,
  ) {}
  u8() {
    return this.b[this.p++] ?? 0;
  }
  u16() {
    const v = ((this.b[this.p] ?? 0) << 8) | (this.b[this.p + 1] ?? 0);
    this.p += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32() {
    const v = ((this.b[this.p] ?? 0) * 0x1000000 + ((this.b[this.p + 1] ?? 0) << 16)) + (((this.b[this.p + 2] ?? 0) << 8) | (this.b[this.p + 3] ?? 0));
    this.p += 4;
    return v;
  }
  tag() {
    const s = String.fromCharCode(this.b[this.p], this.b[this.p + 1], this.b[this.p + 2], this.b[this.p + 3]);
    this.p += 4;
    return s;
  }
}

// ---- TrueType / OpenType -------------------------------------------------------------------

export function sfntTables(b: Uint8Array): Map<string, Uint8Array> {
  const r = new Reader(b);
  const tables = new Map<string, Uint8Array>();
  let base = 0;
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) === 'ttcf') {
    r.p = 12;
    base = r.u32();
    r.p = base;
  }
  r.p = base + 4;
  const n = r.u16();
  r.p = base + 12;
  for (let i = 0; i < n; i++) {
    const tag = r.tag();
    r.u32();
    const off = r.u32();
    const len = r.u32();
    if (off < b.length) tables.set(tag, b.subarray(off, Math.min(b.length, off + len)));
  }
  return tables;
}

export function readCmaps(t: Uint8Array | undefined): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  if (!t) return out;
  const r = new Reader(t);
  r.u16();
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const pid = r.u16();
    const eid = r.u16();
    const off = r.u32();
    const key = `${pid},${eid}`;
    if (out.has(key)) continue;
    const m = new Map<number, number>();
    try {
      const s = new Reader(t, off);
      const format = s.u16();
      if (format === 0) {
        s.u16();
        s.u16();
        for (let c = 0; c < 256; c++) m.set(c, s.u8());
      } else if (format === 4) {
        s.u16();
        s.u16();
        const segX2 = s.u16();
        s.p += 6;
        const seg = segX2 / 2;
        const ends: number[] = [];
        for (let k = 0; k < seg; k++) ends.push(s.u16());
        s.u16();
        const starts: number[] = [];
        for (let k = 0; k < seg; k++) starts.push(s.u16());
        const deltas: number[] = [];
        for (let k = 0; k < seg; k++) deltas.push(s.i16());
        const roStart = s.p;
        const ros: number[] = [];
        for (let k = 0; k < seg; k++) ros.push(s.u16());
        for (let k = 0; k < seg; k++) {
          for (let c = starts[k]; c <= ends[k] && c !== 0xffff; c++) {
            let g: number;
            if (ros[k] === 0) g = (c + deltas[k]) & 0xffff;
            else {
              const at = roStart + k * 2 + ros[k] + (c - starts[k]) * 2;
              g = ((t[at] ?? 0) << 8) | (t[at + 1] ?? 0);
              if (g) g = (g + deltas[k]) & 0xffff;
            }
            if (g) m.set(c, g);
          }
        }
      } else if (format === 6) {
        s.u16();
        s.u16();
        const first = s.u16();
        const count = s.u16();
        for (let k = 0; k < count; k++) m.set(first + k, s.u16());
      } else if (format === 12) {
        s.u16();
        s.u32();
        s.u32();
        const groups = s.u32();
        for (let k = 0; k < groups && k < 100000; k++) {
          const a = s.u32();
          const z = s.u32();
          const g = s.u32();
          for (let c = a; c <= z && c - a < 70000; c++) m.set(c, g + c - a);
        }
      }
    } catch {
      // a broken subtable; the others may do
    }
    out.set(key, m);
  }
  return out;
}

const MAC_GLYPHS = (
  '.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat'
).split(' ');

function postNames(t: Uint8Array | undefined, count: number): Map<string, number> {
  const names = new Map<string, number>();
  if (!t) return names;
  const r = new Reader(t);
  const version = r.u32();
  if (version !== 0x20000) return names;
  r.p = 32;
  const n = Math.min(count, r.u16());
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(r.u16());
  const custom: string[] = [];
  while (r.p < t.length) {
    const len = r.u8();
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(r.u8());
    custom.push(s);
  }
  idx.forEach((v, gid) => {
    const name = v < 258 ? MAC_GLYPHS[v] : custom[v - 258];
    if (name && !names.has(name)) names.set(name, gid);
  });
  return names;
}

function trueType(b: Uint8Array): GlyphFont | null {
  const tables = sfntTables(b);
  const cff = tables.get('CFF ');
  if (cff) return cffFont(cff);
  const head = tables.get('head');
  const glyf = tables.get('glyf');
  const loca = tables.get('loca');
  if (!head || !glyf || !loca) return null;
  const unitsPerEm = new Reader(head, 18).u16() || 1000;
  const longLoca = new Reader(head, 50).i16() === 1;
  const maxp = tables.get('maxp');
  const count = maxp ? new Reader(maxp, 4).u16() : Math.floor(loca.length / (longLoca ? 4 : 2)) - 1;
  const offset = (g: number) => (longLoca ? new Reader(loca, g * 4).u32() : new Reader(loca, g * 2).u16() * 2);
  const k = 1000 / unitsPerEm;
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const nh = hhea ? new Reader(hhea, 34).u16() : 0;
  const names = postNames(tables.get('post'), count);

  const glyph = (g: number, depth: number): GlyphCmd[] | null => {
    if (g < 0 || g >= count || depth > 8) return null;
    const start = offset(g);
    const end = offset(g + 1);
    if (end <= start || start >= glyf.length) return [];
    const r = new Reader(glyf, start);
    const nc = r.i16();
    r.p += 8;
    const cmds: GlyphCmd[] = [];
    if (nc >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < nc; i++) ends.push(r.u16());
      const np = nc ? ends[nc - 1] + 1 : 0;
      const instructions = r.u16();
      r.p += instructions;
      const flags: number[] = [];
      while (flags.length < np) {
        const f = r.u8();
        flags.push(f);
        if (f & 8) {
          const rep = r.u8();
          for (let i = 0; i < rep && flags.length < np; i++) flags.push(f);
        }
      }
      const xs: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) v += f & 16 ? r.u8() : -r.u8();
        else if (!(f & 16)) v += r.i16();
        xs.push(v);
      }
      const ys: number[] = [];
      v = 0;
      for (const f of flags) {
        if (f & 4) v += f & 32 ? r.u8() : -r.u8();
        else if (!(f & 32)) v += r.i16();
        ys.push(v);
      }
      let s = 0;
      for (const e of ends) {
        const pts: { x: number; y: number; on: boolean }[] = [];
        for (let i = s; i <= e; i++) pts.push({ x: xs[i] * k, y: ys[i] * k, on: !!(flags[i] & 1) });
        s = e + 1;
        if (!pts.length) continue;
        // Start on an on-curve point (or the midpoint of two off-curve ones).
        let first = pts.findIndex((p) => p.on);
        let startPt: { x: number; y: number };
        if (first < 0) {
          startPt = { x: (pts[0].x + pts[1 % pts.length].x) / 2, y: (pts[0].y + pts[1 % pts.length].y) / 2 };
          first = 0;
        } else startPt = pts[first];
        cmds.push(['M', startPt.x, startPt.y]);
        let cur = startPt;
        let ctrl: { x: number; y: number } | null = null;
        const n = pts.length;
        const startIdx = pts[first].on ? first + 1 : first;
        for (let i = 0; i < n; i++) {
          const p = pts[(startIdx + i) % n];
          if (p.on) {
            if (ctrl) quad(cur, ctrl, p);
            else cmds.push(['L', p.x, p.y]);
            cur = p;
            ctrl = null;
          } else if (ctrl) {
            const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 };
            quad(cur, ctrl, mid);
            cur = mid;
            ctrl = p;
          } else ctrl = p;
        }
        if (ctrl) quad(cur, ctrl, startPt);
        cmds.push(['Z']);
      }
      return cmds;
    }
    // Composite
    for (;;) {
      const flags = r.u16();
      const gi = r.u16();
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = r.i16();
        dy = r.i16();
      } else {
        dx = (r.u8() << 24) >> 24;
        dy = (r.u8() << 24) >> 24;
      }
      let a = 1;
      let bb = 0;
      let c = 0;
      let d = 1;
      const f2 = () => r.i16() / 16384;
      if (flags & 8) a = d = f2();
      else if (flags & 0x40) {
        a = f2();
        d = f2();
      } else if (flags & 0x80) {
        a = f2();
        bb = f2();
        c = f2();
        d = f2();
      }
      const sub = glyph(gi, depth + 1) ?? [];
      const ox = flags & 2 ? dx * k : 0;
      const oy = flags & 2 ? dy * k : 0;
      const tf = (x: number, y: number): [number, number] => [a * x + c * y + ox, bb * x + d * y + oy];
      for (const cmd of sub) {
        if (cmd[0] === 'M' || cmd[0] === 'L') cmds.push([cmd[0], ...tf(cmd[1], cmd[2])]);
        else if (cmd[0] === 'C') cmds.push(['C', ...tf(cmd[1], cmd[2]), ...tf(cmd[3], cmd[4]), ...tf(cmd[5], cmd[6])]);
        else cmds.push(cmd);
      }
      if (!(flags & 0x20)) break;
    }
    return cmds;

    function quad(p0: { x: number; y: number }, c: { x: number; y: number }, p: { x: number; y: number }) {
      cmds.push(['C', p0.x + ((c.x - p0.x) * 2) / 3, p0.y + ((c.y - p0.y) * 2) / 3, p.x + ((c.x - p.x) * 2) / 3, p.y + ((c.y - p.y) * 2) / 3, p.x, p.y]);
    }
  };

  return {
    kind: 'truetype',
    gidByName: (n) => names.get(n) ?? null,
    gidByCid: (c) => c,
    cmaps: readCmaps(tables.get('cmap')),
    builtinEncoding: null,
    outline: (g) => glyph(g, 0),
    advance: (g) => {
      if (!hmtx || !nh) return null;
      const i = Math.min(g, nh - 1);
      return new Reader(hmtx, i * 4).u16() * k;
    },
    glyphCount: count,
  };
}

// ---- CFF -------------------------------------------------------------------------------

const CFF_STD_STRINGS = (
  '.notdef space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand questiondown grave acute circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree thorn threequarters twosuperior registered minus eth multiply threesuperior copyright Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron aacute acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute icircumflex idieresis igrave ntilde oacute ocircumflex odieresis ograve otilde scaron uacute ucircumflex udieresis ugrave yacute ydieresis zcaron exclamsmall Hungarumlautsmall dollaroldstyle dollarsuperior ampersandsmall Acutesmall parenleftsuperior parenrightsuperior twodotenleader onedotenleader zerooldstyle oneoldstyle twooldstyle threeoldstyle fouroldstyle fiveoldstyle sixoldstyle sevenoldstyle eightoldstyle nineoldstyle commasuperior threequartersemdash periodsuperior questionsmall asuperior bsuperior centsuperior dsuperior esuperior isuperior lsuperior msuperior nsuperior osuperior rsuperior ssuperior tsuperior ff ffi ffl parenleftinferior parenrightinferior Circumflexsmall hyphensuperior Gravesmall Asmall Bsmall Csmall Dsmall Esmall Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall Psmall Qsmall Rsmall Ssmall Tsmall Usmall Vsmall Wsmall Xsmall Ysmall Zsmall colonmonetary onefitted rupiah Tildesmall exclamdownsmall centoldstyle Lslashsmall Scaronsmall Zcaronsmall Dieresissmall Brevesmall Caronsmall Gravesmall Macronsmall figuredash hypheninferior Ogoneksmall Ringsmall Cedillasmall questiondownsmall oneeighth threeeighths fiveeighths seveneighths onethird twothirds zerosuperior foursuperior fivesuperior sixsuperior sevensuperior eightsuperior ninesuperior zeroinferior oneinferior twoinferior threeinferior fourinferior fiveinferior sixinferior seveninferior eightinferior nineinferior centinferior dollarinferior periodinferior commainferior Agravesmall Aacutesmall Acircumflexsmall Atildesmall Adieresissmall Aringsmall AEsmall Ccedillasmall Egravesmall Eacutesmall Ecircumflexsmall Edieresissmall Igravesmall Iacutesmall Icircumflexsmall Idieresissmall Ethsmall Ntildesmall Ogravesmall Oacutesmall Ocircumflexsmall Otildesmall Odieresissmall OEsmall Oslashsmall Ugravesmall Uacutesmall Ucircumflexsmall Udieresissmall Yacutesmall Thornsmall Ydieresissmall 001.000 001.001 001.002 001.003 Black Bold Book Light Medium Regular Roman Semibold'
).split(' ');

function cffIndex(b: Uint8Array, p: number): { items: Uint8Array[]; end: number } {
  const r = new Reader(b, p);
  const count = r.u16();
  if (!count) return { items: [], end: p + 2 };
  const osz = r.u8();
  const off = () => {
    let v = 0;
    for (let i = 0; i < osz; i++) v = v * 256 + r.u8();
    return v;
  };
  const offs: number[] = [];
  for (let i = 0; i <= count; i++) offs.push(off());
  const base = r.p - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(base + offs[i], base + offs[i + 1]));
  return { items, end: base + offs[count] };
}

function cffDict(b: Uint8Array): Map<number, number[]> {
  const d = new Map<number, number[]>();
  let ops: number[] = [];
  for (let i = 0; i < b.length; ) {
    const v = b[i];
    if (v <= 21) {
      let key = v;
      i++;
      if (v === 12) key = 1200 + b[i++];
      d.set(key, ops);
      ops = [];
    } else if (v === 28) {
      ops.push(((b[i + 1] << 24) >> 16) | b[i + 2]);
      i += 3;
    } else if (v === 29) {
      ops.push((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]);
      i += 5;
    } else if (v === 30) {
      let s = '';
      i++;
      const map = '0123456789.EE?-';
      loop: while (i < b.length) {
        const byte = b[i++];
        for (const nib of [byte >> 4, byte & 15]) {
          if (nib === 15) break loop;
          if (nib === 12) s += 'E-';
          else if (nib === 11) s += 'E';
          else s += map[nib];
        }
      }
      ops.push(parseFloat(s) || 0);
    } else if (v >= 32 && v <= 246) {
      ops.push(v - 139);
      i++;
    } else if (v >= 247 && v <= 250) {
      ops.push((v - 247) * 256 + b[i + 1] + 108);
      i += 2;
    } else if (v >= 251 && v <= 254) {
      ops.push(-(v - 251) * 256 - b[i + 1] - 108);
      i += 2;
    } else i++;
  }
  return d;
}

function subrBias(n: number) {
  return n < 1240 ? 107 : n < 33900 ? 1131 : 32768;
}

/** Type 2 charstrings (CFF): outline commands, in font units scaled by `k`. */
function type2(code: Uint8Array, gsubrs: Uint8Array[], lsubrs: Uint8Array[], k: number[]): { cmds: GlyphCmd[]; width: number | null } {
  const cmds: GlyphCmd[] = [];
  const st: number[] = [];
  let x = 0;
  let y = 0;
  let nStems = 0;
  let haveWidth = false;
  let width: number | null = null;
  let open = false;
  const tf = (px: number, py: number): [number, number] => [k[0] * px + k[2] * py + k[4], k[1] * px + k[3] * py + k[5]];
  const moveTo = (dx: number, dy: number) => {
    if (open) cmds.push(['Z']);
    x += dx;
    y += dy;
    cmds.push(['M', ...tf(x, y)]);
    open = true;
  };
  const lineTo = (dx: number, dy: number) => {
    x += dx;
    y += dy;
    cmds.push(['L', ...tf(x, y)]);
  };
  const curveTo = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const x1 = x + a;
    const y1 = y + b;
    const x2 = x1 + c;
    const y2 = y1 + d;
    x = x2 + e;
    y = y2 + f;
    cmds.push(['C', ...tf(x1, y1), ...tf(x2, y2), ...tf(x, y)]);
  };
  const takeWidth = (even: boolean) => {
    if (!haveWidth) {
      haveWidth = true;
      if (st.length % 2 === (even ? 1 : 0)) width = st.shift() ?? null;
    }
  };
  let depth = 0;
  const run = (c: Uint8Array): boolean => {
    if (++depth > 12) return false;
    for (let i = 0; i < c.length; ) {
      const v = c[i++];
      if (v >= 32) {
        if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + c[i++] + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - c[i++] - 108);
        else {
          st.push(((c[i] << 24) | (c[i + 1] << 16) | (c[i + 2] << 8) | c[i + 3]) / 65536);
          i += 4;
        }
        continue;
      }
      if (v === 28) {
        st.push(((c[i] << 24) >> 16) | c[i + 1]);
        i += 2;
        continue;
      }
      switch (v) {
        case 1: case 3: case 18: case 23:
          takeWidth(true);
          nStems += st.length >> 1;
          st.length = 0;
          break;
        case 19: case 20:
          takeWidth(true);
          nStems += st.length >> 1;
          st.length = 0;
          i += (nStems + 7) >> 3;
          break;
        case 21:
          takeWidth(false);
          moveTo(st[st.length - 2] ?? 0, st[st.length - 1] ?? 0);
          st.length = 0;
          break;
        case 22:
          if (!haveWidth) {
            haveWidth = true;
            if (st.length > 1) width = st.shift() ?? null;
          }
          moveTo(st[st.length - 1] ?? 0, 0);
          st.length = 0;
          break;
        case 4:
          if (!haveWidth) {
            haveWidth = true;
            if (st.length > 1) width = st.shift() ?? null;
          }
          moveTo(0, st[st.length - 1] ?? 0);
          st.length = 0;
          break;
        case 5:
          for (let j = 0; j + 1 < st.length; j += 2) lineTo(st[j], st[j + 1]);
          st.length = 0;
          break;
        case 6: case 7: {
          let horiz = v === 6;
          for (const d of st) {
            if (horiz) lineTo(d, 0);
            else lineTo(0, d);
            horiz = !horiz;
          }
          st.length = 0;
          break;
        }
        case 8:
          for (let j = 0; j + 5 < st.length; j += 6) curveTo(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]);
          st.length = 0;
          break;
        case 24: {
          let j = 0;
          for (; j + 5 < st.length - 2; j += 6) curveTo(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]);
          lineTo(st[j] ?? 0, st[j + 1] ?? 0);
          st.length = 0;
          break;
        }
        case 25: {
          let j = 0;
          for (; j + 1 < st.length - 6; j += 2) lineTo(st[j], st[j + 1]);
          curveTo(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]);
          st.length = 0;
          break;
        }
        case 26: {
          let j = 0;
          let dx1 = 0;
          if (st.length % 2) dx1 = st[j++];
          for (; j + 3 < st.length; j += 4) {
            curveTo(dx1, st[j], st[j + 1], st[j + 2], 0, st[j + 3]);
            dx1 = 0;
          }
          st.length = 0;
          break;
        }
        case 27: {
          let j = 0;
          let dy1 = 0;
          if (st.length % 2) dy1 = st[j++];
          for (; j + 3 < st.length; j += 4) {
            curveTo(st[j], dy1, st[j + 1], st[j + 2], st[j + 3], 0);
            dy1 = 0;
          }
          st.length = 0;
          break;
        }
        case 30: case 31: {
          let horiz = v === 31;
          for (let j = 0; j + 3 < st.length; j += 4) {
            const last = j + 5 === st.length ? st[j + 4] : 0;
            if (horiz) curveTo(st[j], 0, st[j + 1], st[j + 2], last, st[j + 3]);
            else curveTo(0, st[j], st[j + 1], st[j + 2], st[j + 3], last);
            horiz = !horiz;
          }
          st.length = 0;
          break;
        }
        case 10: {
          const n = (st.pop() ?? 0) + subrBias(lsubrs.length);
          if (lsubrs[n] && !run(lsubrs[n])) return false;
          break;
        }
        case 29: {
          const n = (st.pop() ?? 0) + subrBias(gsubrs.length);
          if (gsubrs[n] && !run(gsubrs[n])) return false;
          break;
        }
        case 11:
          depth--;
          return true;
        case 14:
          takeWidth(false);
          if (open) cmds.push(['Z']);
          open = false;
          st.length = 0;
          return false;
        case 12: {
          const e = c[i++];
          if (e === 35) {
            curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
            curveTo(st[6], st[7], st[8], st[9], st[10], st[11]);
          } else if (e === 34) {
            const y0 = y;
            curveTo(st[0], 0, st[1], st[2], st[3], 0);
            curveTo(st[4], 0, st[5], y0 - y, st[6], 0);
          } else if (e === 36) {
            const y0 = y;
            curveTo(st[0], st[1], st[2], st[3], st[4], 0);
            curveTo(st[5], 0, st[6], st[7], st[8], y0 - (y + st[7]));
          } else if (e === 37) {
            const x0 = x;
            const y0 = y;
            let dx = 0;
            let dy = 0;
            for (let j = 0; j < 10; j += 2) {
              dx += st[j];
              dy += st[j + 1];
            }
            curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
            const x2 = x + st[6] + st[8];
            const y2 = y + st[7] + st[9];
            if (Math.abs(dx) > Math.abs(dy)) curveTo(st[6], st[7], st[8], st[9], st[10], y0 - y2);
            else curveTo(st[6], st[7], st[8], st[9], x0 - x2, st[10]);
          }
          st.length = 0;
          break;
        }
        default:
          st.length = 0;
      }
    }
    depth--;
    return true;
  };
  run(code);
  if (open) cmds.push(['Z']);
  return { cmds, width };
}

function cffFont(b: Uint8Array): GlyphFont | null {
  const hdrSize = b[2];
  const names = cffIndex(b, hdrSize);
  const tops = cffIndex(b, names.end);
  const strings = cffIndex(b, tops.end);
  const gsubrs = cffIndex(b, strings.end).items;
  if (!tops.items.length) return null;
  const top = cffDict(tops.items[0]);
  const str = (sid: number) => (sid < CFF_STD_STRINGS.length ? CFF_STD_STRINGS[sid] : new TextDecoder('latin1').decode(strings.items[sid - CFF_STD_STRINGS.length] ?? new Uint8Array()));
  const csOff = top.get(17)?.[0];
  if (csOff === undefined) return null;
  const charstrings = cffIndex(b, csOff).items;
  const n = charstrings.length;
  const fm = top.get(1207) ?? [0.001, 0, 0, 0.001, 0, 0];
  const isCid = top.has(1230);

  const privateOf = (d: Map<number, number[]>) => {
    const p = d.get(18);
    if (!p || p.length < 2) return { subrs: [] as Uint8Array[], nominal: 0, defaultW: 0 };
    const [size, off] = p;
    const pd = cffDict(b.subarray(off, off + size));
    const so = pd.get(19)?.[0];
    return { subrs: so !== undefined ? cffIndex(b, off + so).items : [], nominal: pd.get(21)?.[0] ?? 0, defaultW: pd.get(20)?.[0] ?? 0 };
  };

  let fdSelect: ((g: number) => number) | null = null;
  let fdPrivates: ReturnType<typeof privateOf>[] = [];
  let fdMatrices: number[][] = [];
  if (isCid) {
    const fdArr = top.get(1236)?.[0];
    if (fdArr !== undefined) {
      const fds = cffIndex(b, fdArr).items.map(cffDict);
      fdPrivates = fds.map(privateOf);
      fdMatrices = fds.map((d) => d.get(1207) ?? []);
    }
    const fsOff = top.get(1237)?.[0];
    if (fsOff !== undefined) {
      const fmt = b[fsOff];
      if (fmt === 0) fdSelect = (g) => b[fsOff + 1 + g] ?? 0;
      else if (fmt === 3) {
        const r = new Reader(b, fsOff + 1);
        const nr = r.u16();
        const ranges: [number, number][] = [];
        for (let i = 0; i < nr; i++) {
          const first = r.u16();
          ranges.push([first, r.u8()]);
        }
        const sentinel = r.u16();
        fdSelect = (g) => {
          for (let i = ranges.length - 1; i >= 0; i--) if (g >= ranges[i][0] && g < (i + 1 < ranges.length ? ranges[i + 1][0] : sentinel)) return ranges[i][1];
          return 0;
        };
      }
    }
  }
  const priv = privateOf(top);

  // charset: gid → sid (or cid)
  const gidToSid: number[] = [0];
  const csetOff = top.get(15)?.[0] ?? 0;
  if (csetOff > 2) {
    const r = new Reader(b, csetOff);
    const fmt = r.u8();
    if (fmt === 0) for (let g = 1; g < n; g++) gidToSid.push(r.u16());
    else {
      while (gidToSid.length < n && r.p < b.length) {
        const first = r.u16();
        const left = fmt === 1 ? r.u8() : r.u16();
        for (let i = 0; i <= left && gidToSid.length < n; i++) gidToSid.push(first + i);
      }
    }
  } else if (csetOff === 0) for (let g = 1; g < n; g++) gidToSid.push(g);
  const byName = new Map<string, number>();
  const byCid = new Map<number, number>();
  gidToSid.forEach((sid, gid) => {
    if (isCid) byCid.set(sid, gid);
    else byName.set(str(sid), gid);
  });

  let builtin: (string | undefined)[] | null = null;
  const encOff = top.get(16)?.[0] ?? 0;
  if (!isCid) {
    if (encOff === 0) builtin = STANDARD.map((s) => s || undefined);
    else if (encOff > 1) {
      builtin = new Array(256);
      const r = new Reader(b, encOff);
      const fmt = r.u8();
      if ((fmt & 0x7f) === 0) {
        const nc = r.u8();
        for (let i = 1; i <= nc; i++) builtin[r.u8()] = str(gidToSid[i] ?? 0);
      } else if ((fmt & 0x7f) === 1) {
        const nr = r.u8();
        let gid = 1;
        for (let i = 0; i < nr; i++) {
          const first = r.u8();
          const left = r.u8();
          for (let c = first; c <= first + left; c++) builtin[c] = str(gidToSid[gid++] ?? 0);
        }
      }
      if (fmt & 0x80) {
        const ns = r.u8();
        for (let i = 0; i < ns; i++) {
          const c = r.u8();
          builtin[c] = str(r.u16());
        }
      }
    }
  }

  const glyph = (g: number) => {
    if (g < 0 || g >= n) return null;
    const fd = fdSelect ? fdSelect(g) : 0;
    const p = isCid ? (fdPrivates[fd] ?? priv) : priv;
    // FontMatrix scaled to a 1000-unit em; a FD matrix composes with the top one.
    let m = fm;
    const fdm = isCid ? fdMatrices[fd] : undefined;
    if (fdm && fdm.length === 6) {
      m = [fdm[0] * fm[0] + fdm[1] * fm[2], fdm[0] * fm[1] + fdm[1] * fm[3], fdm[2] * fm[0] + fdm[3] * fm[2], fdm[2] * fm[1] + fdm[3] * fm[3], fdm[4] * fm[0] + fdm[5] * fm[2] + fm[4], fdm[4] * fm[1] + fdm[5] * fm[3] + fm[5]];
    }
    const k = m.map((v) => v * 1000);
    const r = type2(charstrings[g], gsubrs, p.subrs, k);
    return { cmds: r.cmds, width: (r.width === null ? p.defaultW : r.width + p.nominal) * k[0] };
  };

  return {
    kind: 'cff',
    gidByName: (name) => byName.get(name) ?? null,
    gidByCid: (c) => (isCid ? (byCid.get(c) ?? (c < n ? c : 0)) : c),
    cmaps: new Map(),
    builtinEncoding: builtin,
    outline: (g) => glyph(g)?.cmds ?? null,
    advance: (g) => glyph(g)?.width ?? null,
    glyphCount: n,
  };
}

// ---- Type 1 ------------------------------------------------------------------------------

function decrypt(data: Uint8Array, key: number, skip: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, data.length - skip));
  let r = key;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const p = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
    if (i >= skip) out[i - skip] = p;
  }
  return out;
}

function type1(b: Uint8Array, len1: number): GlyphFont | null {
  let clear = b.subarray(0, len1 || b.length);
  let enc = b.subarray(len1);
  if (!len1) {
    const s = new TextDecoder('latin1').decode(b);
    const e = s.indexOf('eexec');
    if (e < 0) return null;
    clear = b.subarray(0, e);
    let st = e + 5;
    while (b[st] === 13 || b[st] === 10 || b[st] === 32) st++;
    enc = b.subarray(st);
  }
  // Hex-encoded eexec section?
  const isHex = [...enc.subarray(0, 4)].every((c) => /[0-9a-fA-F]/.test(String.fromCharCode(c)));
  if (isHex) {
    const hex = new TextDecoder('latin1').decode(enc).replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    enc = bytes;
  }
  const priv = decrypt(enc, 55665, 4);
  const clearText = new TextDecoder('latin1').decode(clear);
  const builtin: (string | undefined)[] = new Array(256);
  if (/\/Encoding\s+StandardEncoding/.test(clearText)) STANDARD.forEach((n, i) => (builtin[i] = n || undefined));
  else for (const m of clearText.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) builtin[Number(m[1])] = m[2];
  const fmM = /\/FontMatrix\s*\[([^\]]+)\]/.exec(clearText);
  const fm = fmM ? fmM[1].trim().split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];
  const k = fm.map((v) => v * 1000);
  const ptext = new TextDecoder('latin1').decode(priv);
  const lenIV = Number(/\/lenIV\s+(\d+)/.exec(ptext)?.[1] ?? 4);
  const subrs: Uint8Array[] = [];
  const charstrings = new Map<string, Uint8Array>();
  // Binary tokens: "dup n len RD <bytes> NP" and "/name len RD <bytes> ND".
  const re = /dup\s+(\d+)\s+(\d+)\s+(RD|-\|)\s/g;
  for (let m = re.exec(ptext); m; m = re.exec(ptext)) {
    const start = m.index + m[0].length;
    const len = Number(m[2]);
    subrs[Number(m[1])] = decrypt(priv.subarray(start, start + len), 4330, lenIV);
    re.lastIndex = start + len;
  }
  const csStart = ptext.indexOf('/CharStrings');
  const re2 = /\/([^\s/]+)\s+(\d+)\s+(RD|-\|)\s/g;
  re2.lastIndex = csStart < 0 ? 0 : csStart;
  for (let m = re2.exec(ptext); m; m = re2.exec(ptext)) {
    const start = m.index + m[0].length;
    const len = Number(m[2]);
    charstrings.set(m[1], decrypt(priv.subarray(start, start + len), 4330, lenIV));
    re2.lastIndex = start + len;
  }
  const names = [...charstrings.keys()];
  const gidOf = new Map(names.map((n, i) => [n, i] as [string, number]));
  const cache = new Map<number, { cmds: GlyphCmd[]; width: number }>();
  const glyph = (g: number, depth = 0): { cmds: GlyphCmd[]; width: number } | null => {
    if (cache.has(g)) return cache.get(g)!;
    const cs = charstrings.get(names[g]);
    if (!cs || depth > 4) return null;
    const r = type1Charstring(cs, subrs, k, (code) => {
      const name = STANDARD[code];
      const gi = name ? gidOf.get(name) : undefined;
      return gi !== undefined ? (glyph(gi, depth + 1)?.cmds ?? []) : [];
    });
    cache.set(g, r);
    return r;
  };
  return {
    kind: 'type1',
    gidByName: (n) => gidOf.get(n) ?? null,
    gidByCid: (c) => c,
    cmaps: new Map(),
    builtinEncoding: builtin,
    outline: (g) => glyph(g)?.cmds ?? null,
    advance: (g) => glyph(g)?.width ?? null,
    glyphCount: names.length,
  };
}

function type1Charstring(
  code: Uint8Array,
  subrs: Uint8Array[],
  k: number[],
  accent: (stdCode: number) => GlyphCmd[],
): { cmds: GlyphCmd[]; width: number } {
  const cmds: GlyphCmd[] = [];
  const st: number[] = [];
  const ps: number[] = [];
  let x = 0;
  let y = 0;
  let width = 0;
  let sbx = 0;
  let flex: [number, number][] | null = null;
  const tf = (px: number, py: number): [number, number] => [k[0] * px + k[2] * py + k[4], k[1] * px + k[3] * py + k[5]];
  const run = (c: Uint8Array, depth: number) => {
    if (depth > 10) return;
    for (let i = 0; i < c.length; ) {
      const v = c[i++];
      if (v >= 32) {
        if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + c[i++] + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - c[i++] - 108);
        else {
          st.push((c[i] << 24) | (c[i + 1] << 16) | (c[i + 2] << 8) | c[i + 3]);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 13: // hsbw
          sbx = st[0] ?? 0;
          width = (st[1] ?? 0) * k[0];
          x = sbx;
          y = 0;
          st.length = 0;
          break;
        case 21: // rmoveto
          x += st[0] ?? 0;
          y += st[1] ?? 0;
          if (flex) flex.push([x, y]);
          else cmds.push(['M', ...tf(x, y)]);
          st.length = 0;
          break;
        case 22:
          x += st[0] ?? 0;
          if (flex) flex.push([x, y]);
          else cmds.push(['M', ...tf(x, y)]);
          st.length = 0;
          break;
        case 4:
          y += st[0] ?? 0;
          if (flex) flex.push([x, y]);
          else cmds.push(['M', ...tf(x, y)]);
          st.length = 0;
          break;
        case 5:
          x += st[0] ?? 0;
          y += st[1] ?? 0;
          cmds.push(['L', ...tf(x, y)]);
          st.length = 0;
          break;
        case 6:
          x += st[0] ?? 0;
          cmds.push(['L', ...tf(x, y)]);
          st.length = 0;
          break;
        case 7:
          y += st[0] ?? 0;
          cmds.push(['L', ...tf(x, y)]);
          st.length = 0;
          break;
        case 8: {
          const [a, b, cc, d, e, f] = st;
          const x1 = x + a;
          const y1 = y + b;
          const x2 = x1 + cc;
          const y2 = y1 + d;
          x = x2 + e;
          y = y2 + f;
          cmds.push(['C', ...tf(x1, y1), ...tf(x2, y2), ...tf(x, y)]);
          st.length = 0;
          break;
        }
        case 30: {
          const [a, b, cc, d] = st;
          const y1 = y + a;
          const x2 = x + b;
          const y2 = y1 + cc;
          const x1 = x;
          x = x2 + d;
          y = y2;
          cmds.push(['C', ...tf(x1, y1), ...tf(x2, y2), ...tf(x, y)]);
          st.length = 0;
          break;
        }
        case 31: {
          const [a, b, cc, d] = st;
          const x1 = x + a;
          const x2 = x1 + b;
          const y2 = y + cc;
          const y1 = y;
          x = x2;
          y = y2 + d;
          cmds.push(['C', ...tf(x1, y1), ...tf(x2, y2), ...tf(x, y)]);
          st.length = 0;
          break;
        }
        case 9:
          cmds.push(['Z']);
          st.length = 0;
          break;
        case 10: {
          const n = st.pop() ?? 0;
          if (subrs[n]) run(subrs[n], depth + 1);
          break;
        }
        case 11:
          return;
        case 14:
          st.length = 0;
          return;
        case 1: case 3:
          st.length = 0;
          break;
        case 12: {
          const e = c[i++];
          if (e === 7) {
            // sbw
            sbx = st[0] ?? 0;
            width = (st[2] ?? 0) * k[0];
            x = sbx;
            y = st[1] ?? 0;
            st.length = 0;
          } else if (e === 6) {
            // seac: accented character from two standard glyphs
            const [, adx, ady, bchar, achar] = st;
            cmds.push(...accent(bchar));
            const acc = accent(achar);
            const ox = k[0] * (adx - sbx + 0) + k[2] * ady;
            const oy = k[1] * adx + k[3] * ady;
            for (const cmd of acc) {
              if (cmd[0] === 'M' || cmd[0] === 'L') cmds.push([cmd[0], cmd[1] + ox, cmd[2] + oy]);
              else if (cmd[0] === 'C') cmds.push(['C', cmd[1] + ox, cmd[2] + oy, cmd[3] + ox, cmd[4] + oy, cmd[5] + ox, cmd[6] + oy]);
              else cmds.push(cmd);
            }
            st.length = 0;
            return;
          } else if (e === 12) {
            const b = st.pop() ?? 1;
            const a = st.pop() ?? 0;
            st.push(a / b);
          } else if (e === 16) {
            // callothersubr: flex (0), start flex (1), hint replacement (3)
            const othersubr = st.pop() ?? 0;
            const n = st.pop() ?? 0;
            const args = st.splice(st.length - n, n);
            if (othersubr === 1) flex = [];
            else if (othersubr === 0 && flex) {
              const p = flex;
              flex = null;
              if (p.length >= 8) {
                cmds.push(['C', ...tf(p[2][0], p[2][1]), ...tf(p[3][0], p[3][1]), ...tf(p[4][0], p[4][1])]);
                cmds.push(['C', ...tf(p[5][0], p[5][1]), ...tf(p[6][0], p[6][1]), ...tf(p[7][0], p[7][1])]);
              }
              ps.push(args[2] ?? y, args[1] ?? x);
            } else if (othersubr === 3) ps.push(3);
            else ps.push(...args.reverse());
          } else if (e === 17) {
            st.push(ps.pop() ?? 0);
          } else if (e === 33) {
            x = st[0] ?? x;
            y = st[1] ?? y;
            st.length = 0;
          } else st.length = 0;
          break;
        }
        default:
          st.length = 0;
      }
    }
  };
  run(code, 0);
  return { cmds, width };
}

// ---- Entry -------------------------------------------------------------------------------

/** Read a font program: FontFile (Type 1), FontFile2 (TrueType) or FontFile3 (CFF/OpenType). */
export function readGlyphFont(data: Uint8Array, kind: 'FontFile' | 'FontFile2' | 'FontFile3', len1 = 0): GlyphFont | null {
  try {
    const sig = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (sig === 'OTTO' || sig === 'true' || sig === 'ttcf' || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0)) return trueType(data);
    if (kind === 'FontFile3' && data[0] === 1) return cffFont(data);
    if (kind === 'FontFile' || data[0] === 0x25 || data[0] === 0x80) {
      if (data[0] === 0x80) {
        // PFB segments
        const parts: Uint8Array[] = [];
        let p = 0;
        let first = 0;
        while (p + 6 <= data.length && data[p] === 0x80 && data[p + 1] !== 3) {
          const len = data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16) | (data[p + 5] << 24);
          parts.push(data.subarray(p + 6, p + 6 + len));
          if (!first) first = len;
          p += 6 + len;
        }
        const all = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
        let o = 0;
        for (const x of parts) {
          all.set(x, o);
          o += x.length;
        }
        return type1(all, first);
      }
      return type1(data, len1);
    }
    if (data[0] === 1) return cffFont(data);
    return null;
  } catch {
    return null;
  }
}

export function cmdsToPath(cmds: GlyphCmd[]): Path2D {
  const p = new Path2D();
  for (const c of cmds) {
    if (c[0] === 'M') p.moveTo(c[1], c[2]);
    else if (c[0] === 'L') p.lineTo(c[1], c[2]);
    else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else p.closePath();
  }
  return p;
}
