/**
 * Reads DXF, ASCII or binary, from R12 to the latest, into CAD's drawing.
 * It keeps what the DWG reader keeps and drops the same things, so a
 * drawing comes out the same whichever form it was saved in.
 *
 * DXF is a list of (group code, value) pairs. Pairs are grouped into
 * records at each code 0, and records into sections. Angles in DXF are
 * degrees (except ellipse parameters); the drawing's are radians.
 */
import {
  BYLAYER,
  CONTINUOUS,
  DEFAULT_DIMSTYLE,
  LINEWEIGHTS,
  LW_BYBLOCK,
  LW_BYLAYER,
  LW_DEFAULT,
  newDrawing,
  newId,
  STANDARD_LINETYPES,
  TRUE_COLOR,
  type Block,
  type DimKind,
  type DimStyle,
  type Entity,
  type EntityBase,
  type HAlign,
  type HatchEdge,
  type HatchLoop,
  type Layer,
  type Linetype,
  type PatternLine,
  type PlineVertex,
  type TextStyle,
  type VAlign,
  type Vec,
} from '../model';
import { interpolateSpline } from '../geom';
import { DROPPED_NAMES, type ReadResult } from '../dwg/read';

type Tag = [code: number, value: string];

interface Rec {
  type: string;
  tags: Tag[];
}

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

/** Whether these bytes look like a DXF file. */
export function isDxf(bytes: Uint8Array): boolean {
  if (latin1(bytes.subarray(0, BINARY_SENTINEL.length)) === BINARY_SENTINEL) return true;
  const head = latin1(bytes.subarray(0, 4096)).replace(/^\xEF\xBB\xBF/, '');
  // Comments (999) may come first.
  return /^(\s*999\r?\n[^\n]*\n)*\s*0\r?\n\s*SECTION\s*\r?\n/.test(head);
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
};

/**
 * Text decoding for files whose text isn't UTF-8: files from before
 * AutoCAD 2007 are in the code page their header names.
 */
function textDecoder(bytes: Uint8Array): TextDecoder {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return new TextDecoder('utf-8');
  } catch {
    const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\w+)/i.exec(latin1(bytes.subarray(0, 1 << 16)));
    const label = (m && CODEPAGES[m[1].toUpperCase()]) ?? 'windows-1252';
    try {
      return new TextDecoder(label);
    } catch {
      return new TextDecoder('windows-1252');
    }
  }
}

/** Unicode characters escaped in 8-bit files. */
const unescape = (s: string) => (s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s);

function asciiTags(bytes: Uint8Array): Tag[] {
  const text = textDecoder(bytes).decode(bytes);
  const lines = text.split(/\r?\n/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) throw new Error(`Line ${i + 1} should hold a group code.`);
    tags.push([code, unescape(lines[i + 1])]);
  }
  return tags;
}

function binaryTags(bytes: Uint8Array): Tag[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = BINARY_SENTINEL.length;
  // R12 writes one-byte group codes; later versions two.
  const wide = bytes[o + 1] === 0;
  const raw: [number, Uint8Array | number][] = [];
  const strings: Uint8Array[] = [];
  while (o < bytes.length) {
    let code: number;
    if (wide) {
      code = dv.getInt16(o, true);
      o += 2;
    } else {
      code = bytes[o++];
      if (code === 255) {
        code = dv.getInt16(o, true);
        o += 2;
      }
    }
    const kind = binaryKind(code);
    if (kind === 's') {
      const end = bytes.indexOf(0, o);
      if (end < 0) throw new Error('A string runs past the end of the file.');
      const s = bytes.subarray(o, end);
      strings.push(s);
      raw.push([code, s]);
      o = end + 1;
    } else if (kind === 'b') {
      const n = bytes[o];
      raw.push([code, bytes.subarray(o + 1, o + 1 + n)]);
      o += 1 + n;
    } else {
      if (o + kind > bytes.length) throw new Error('The file ends in the middle of a value.');
      raw.push([code, kind === 8 ? dv.getFloat64(o, true) : kind === 4 ? dv.getInt32(o, true) : kind === 2 ? dv.getInt16(o, true) : bytes[o]]);
      o += kind;
    }
    if (code === 0 && raw.length > 1 && typeof raw[raw.length - 1][1] !== 'number' && latin1(raw[raw.length - 1][1] as Uint8Array) === 'EOF') break;
  }
  // The binary form keeps text in the same encoding as the ASCII one.
  let total = 0;
  for (const s of strings) total += s.length + 1;
  const all = new Uint8Array(total);
  let p = 0;
  for (const s of strings) {
    all.set(s, p);
    all[p + s.length] = 10;
    p += s.length + 1;
  }
  const dec = textDecoder(all);
  return raw.map(([code, v]): Tag => {
    if (typeof v === 'number') return [code, String(v)];
    return [code, binaryKind(code) === 'b' ? '' : unescape(dec.decode(v))];
  });
}

/** Byte length of a binary DXF value, or 's' for a string and 'b' for a binary chunk. */
function binaryKind(code: number): number | 's' | 'b' {
  if (code < 10) return 's';
  if (code < 60) return 8;
  if (code < 80) return 2;
  if (code >= 90 && code < 100) return 4;
  if ((code >= 100 && code <= 102) || code === 105) return 's';
  if (code >= 110 && code < 150) return 8;
  if (code >= 160 && code < 170) return 8;
  if (code >= 170 && code < 180) return 2;
  if (code >= 210 && code < 240) return 8;
  if (code >= 270 && code < 290) return 2;
  if (code >= 290 && code < 300) return 1;
  if (code >= 300 && code < 310) return 's';
  if (code >= 310 && code < 320) return 'b';
  if (code >= 320 && code < 370) return 's';
  if (code >= 370 && code < 390) return 2;
  if (code >= 390 && code < 400) return 's';
  if (code >= 400 && code < 410) return 2;
  if (code >= 410 && code < 420) return 's';
  if (code >= 420 && code < 430) return 4;
  if (code >= 430 && code < 440) return 's';
  if (code >= 440 && code < 460) return 4;
  if (code >= 460 && code < 470) return 8;
  if (code >= 470 && code < 482) return 's';
  if (code === 999) return 's';
  if (code === 1004) return 'b';
  if (code >= 1000 && code < 1010) return 's';
  if (code >= 1010 && code < 1060) return 8;
  if (code >= 1060 && code < 1071) return 2;
  if (code === 1071) return 4;
  throw new Error(`Unknown group code ${code}.`);
}

function records(tags: Tag[]): Rec[] {
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (const t of tags) {
    if (t[0] === 0) {
      cur = { type: t[1].trim().toUpperCase(), tags: [] };
      out.push(cur);
    } else if (cur && t[0] !== 999) cur.tags.push(t);
  }
  return out;
}

// ---- Reading a record's values ---------------------------------------------------------------

const get = (r: Rec, code: number): string | undefined => r.tags.find((t) => t[0] === code)?.[1];
const str = (r: Rec, code: number, d = '') => get(r, code)?.trim() ?? d;
/** Text values keep their spaces. */
const txt = (r: Rec, code: number) => get(r, code) ?? '';
const parse = (s: string | undefined, d: number) => {
  if (s === undefined) return d;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : d;
};
const num = (r: Rec, code: number, d = 0) => parse(get(r, code), d);
const pt = (r: Rec, code: number): Vec => ({ x: num(r, code), y: num(r, code + 10) });
const has = (r: Rec, code: number) => r.tags.some((t) => t[0] === code);
const all = (r: Rec, code: number) => r.tags.filter((t) => t[0] === code).map((t) => parse(t[1], 0));

/** Points given as repeated code / code+10 pairs. */
function pts(r: Rec, code: number): Vec[] {
  const out: Vec[] = [];
  for (const [c, v] of r.tags) {
    if (c === code) out.push({ x: parse(v, 0), y: 0 });
    else if (c === code + 10 && out.length) out[out.length - 1].y = parse(v, 0);
  }
  return out;
}

function color(index: string | undefined, rgb: string | undefined): number {
  if (rgb !== undefined) {
    const c = parseInt(rgb, 10);
    if (c >= 0 && c <= 0xffffff) return TRUE_COLOR | c;
  }
  const i = parse(index, BYLAYER);
  if (i < 0) return Math.min(255, -i);
  return Math.max(0, Math.min(256, i));
}

function lineweight(s: string | undefined, d: number): number {
  const n = parse(s, d);
  return n === LW_BYLAYER || n === LW_BYBLOCK || n === LW_DEFAULT || LINEWEIGHTS.includes(n) ? n : d;
}

/** Entities drawn with their extrusion pointing down are mirrored in X. */
const flipped = (r: Rec) => num(r, 230, 1) < -0.5;

/** A record and the records that belong to it: a POLYLINE's VERTEXes, an INSERT's ATTRIBs. */
interface Item {
  rec: Rec;
  kids: Rec[];
}

function items(recs: Rec[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const item: Item = { rec, kids: [] };
    const kid = rec.type === 'POLYLINE' ? 'VERTEX' : rec.type === 'INSERT' ? 'ATTRIB' : null;
    if (kid) {
      while (recs[i + 1]?.type === kid) item.kids.push(recs[++i]);
      if (recs[i + 1]?.type === 'SEQEND') i++;
    }
    out.push(item);
  }
  return out;
}

export function readDxf(bytes: Uint8Array): ReadResult {
  const binary = latin1(bytes.subarray(0, BINARY_SENTINEL.length)) === BINARY_SENTINEL;
  const recs = records(binary ? binaryTags(bytes) : asciiTags(bytes));

  const sections: Record<string, Rec[]> = {};
  let headerTags: Tag[] = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type !== 'SECTION') continue;
    const name = str(recs[i], 2).toUpperCase();
    if (name === 'HEADER') headerTags = recs[i].tags;
    const list: Rec[] = [];
    while (++i < recs.length && recs[i].type !== 'ENDSEC') list.push(recs[i]);
    sections[name] = list;
  }
  if (!sections.ENTITIES && !sections.BLOCKS) throw new Error('It has no drawing in it.');

  // ---- Header ---------------------------------------------------------------------------
  const vars = new Map<string, Rec>();
  for (let i = 0; i < headerTags.length; i++) {
    if (headerTags[i][0] !== 9) continue;
    const name = headerTags[i][1].trim().toUpperCase();
    const tags: Tag[] = [];
    while (i + 1 < headerTags.length && headerTags[i + 1][0] !== 9) tags.push(headerTags[++i]);
    vars.set(name, { type: name, tags });
  }
  const hv = (name: string, d: number) => {
    const r = vars.get(name);
    return r?.tags.length ? parse(r.tags[0][1], d) : d;
  };
  const hs = (name: string, d: string) => vars.get(name)?.tags[0]?.[1].trim() || d;
  const hp = (name: string) => {
    const r = vars.get(name);
    return r && has(r, 10) ? pt(r, 10) : null;
  };

  const version = hs('$ACADVER', 'AC1009').toUpperCase();
  const d = newDrawing(hv('$MEASUREMENT', 0) === 1);
  const dropped: Record<string, number> = {};
  const drop = (what: string) => (dropped[what] = (dropped[what] ?? 0) + 1);

  const hd = d.header;
  hd.insunits = hv('$INSUNITS', hd.insunits);
  hd.lunits = hv('$LUNITS', hd.lunits);
  hd.luprec = hv('$LUPREC', hd.luprec);
  hd.aunits = hv('$AUNITS', hd.aunits);
  hd.auprec = hv('$AUPREC', hd.auprec);
  hd.ltscale = hv('$LTSCALE', 1) || 1;
  hd.celtscale = hv('$CELTSCALE', 1) || 1;
  hd.textsize = hv('$TEXTSIZE', hd.textsize) || hd.textsize;
  hd.clayer = hs('$CLAYER', '0');
  hd.dimstyle = hs('$DIMSTYLE', hd.dimstyle);
  hd.textstyle = hs('$TEXTSTYLE', 'Standard');
  hd.pdmode = hv('$PDMODE', 0);
  hd.pdsize = hv('$PDSIZE', 0);
  hd.filletrad = hv('$FILLETRAD', 0);
  hd.chamfera = hv('$CHAMFERA', 0);
  hd.chamferb = hv('$CHAMFERB', 0);
  hd.angbase = hv('$ANGBASE', 0) * DEG;
  hd.angdir = hv('$ANGDIR', 0) === 1;
  hd.fillmode = hv('$FILLMODE', 1) !== 0;
  hd.lwdisplay = hv('$LWDISPLAY', 0) !== 0;
  hd.tdcreate = hv('$TDCREATE', hd.tdcreate) || hd.tdcreate;
  hd.limmin = hp('$LIMMIN') ?? hd.limmin;
  hd.limmax = hp('$LIMMAX') ?? hd.limmax;

  // ---- Tables -----------------------------------------------------------------------------
  const tables = sections.TABLES ?? [];
  const entries = (type: string) => tables.filter((r) => r.type === type);
  const handle = (r: Rec) => str(r, 5) || str(r, 105);

  d.linetypes = [...STANDARD_LINETYPES];
  for (const t of entries('LTYPE')) {
    const name = str(t, 2);
    if (!name || /^by(layer|block)$|^continuous$/i.test(name)) continue;
    const lt: Linetype = { name, description: str(t, 3), pattern: all(t, 49) };
    d.linetypes.push(lt);
  }

  const layers: Layer[] = [];
  for (const l of entries('LAYER')) {
    const name = str(l, 2);
    if (!name) continue;
    const flag = num(l, 70);
    const lt = str(l, 6);
    layers.push({
      name,
      color: color(get(l, 62) ?? '7', get(l, 420)),
      linetype: !lt || /^by(layer|block)$/i.test(lt) ? CONTINUOUS : lt,
      lineweight: lineweight(get(l, 370), LW_DEFAULT),
      on: num(l, 62, 7) >= 0,
      frozen: (flag & 1) !== 0,
      locked: (flag & 4) !== 0,
      plot: num(l, 290, 1) !== 0,
    });
  }
  if (layers.length) d.layers = layers;

  const styles: TextStyle[] = [];
  const styleByHandle = new Map<string, string>();
  for (const s of entries('STYLE')) {
    const name = str(s, 2);
    styleByHandle.set(handle(s).toUpperCase(), name);
    // Shape files are listed as nameless styles.
    if (!name || num(s, 70) & 1) continue;
    styles.push({ name, font: str(s, 3, 'txt') || 'txt', bigfont: str(s, 4), height: num(s, 40), width: num(s, 41, 1) || 1, oblique: num(s, 50) * DEG });
  }
  if (styles.length) d.textStyles = styles;

  const blockByHandle = new Map<string, string>();
  for (const r of entries('BLOCK_RECORD')) blockByHandle.set(handle(r).toUpperCase(), str(r, 2));

  const dimstyles: DimStyle[] = [];
  for (const s of entries('DIMSTYLE')) {
    const name = str(s, 2);
    if (!name) continue;
    const D = DEFAULT_DIMSTYLE;
    const flag = (code: number) => num(s, code) !== 0;
    const blk = has(s, 342) ? (blockByHandle.get(str(s, 342).toUpperCase()) ?? '') : version < 'AC1012' ? str(s, 5) : '';
    const txsty = has(s, 340) ? styleByHandle.get(str(s, 340).toUpperCase()) : str(s, 7);
    dimstyles.push({
      ...D,
      name,
      dimscale: num(s, 40, 1) || 1,
      dimasz: num(s, 41, D.dimasz),
      dimtxt: num(s, 140, D.dimtxt),
      dimexo: num(s, 42, D.dimexo),
      dimexe: num(s, 44, D.dimexe),
      dimgap: num(s, 147, D.dimgap),
      dimdec: num(s, 271, D.dimdec),
      dimadec: num(s, 179, D.dimadec),
      dimtad: num(s, 77),
      dimtih: num(s, 73, 1) !== 0,
      dimtoh: num(s, 74, 1) !== 0,
      dimclrd: color(get(s, 176) ?? '0', undefined),
      dimclre: color(get(s, 177) ?? '0', undefined),
      dimclrt: color(get(s, 178) ?? '0', undefined),
      dimtxsty: txsty || 'Standard',
      dimlfac: num(s, 144, 1) || 1,
      dimcen: num(s, 141, D.dimcen),
      dimtsz: num(s, 142),
      dimdle: num(s, 46),
      dimpost: txt(s, 3),
      dimzin: num(s, 78),
      dimlunit: num(s, 277, D.dimlunit),
      dimdsep: num(s, 278, D.dimdsep),
      dimrnd: num(s, 45),
      dimse1: flag(75),
      dimse2: flag(76),
      dimsd1: flag(281),
      dimsd2: flag(282),
      dimtofl: flag(172),
      dimjust: num(s, 280),
      dimatfit: num(s, 289, D.dimatfit),
      dimtix: flag(174),
      dimsoxd: flag(175),
      dimlwd: lineweight(get(s, 371), LW_BYBLOCK),
      dimlwe: lineweight(get(s, 372), LW_BYBLOCK),
      dimblk: blk,
    });
  }
  if (dimstyles.length) d.dimStyles = dimstyles;

  // ---- Entities -----------------------------------------------------------------------------

  const common = (r: Rec): Omit<EntityBase, 'id'> => {
    const lt = str(r, 6);
    return {
      layer: str(r, 8) || '0',
      color: color(get(r, 62), get(r, 420)),
      linetype: !lt || /^bylayer$/i.test(lt) ? 'ByLayer' : /^byblock$/i.test(lt) ? 'ByBlock' : lt,
      lineweight: lineweight(get(r, 370), LW_BYLAYER),
      ltscale: num(r, 48, 1) || 1,
      ...(num(r, 60) === 1 ? { hidden: true } : {}),
    };
  };

  const textBase = (r: Rec, valignCode: number) => {
    const flip = flipped(r);
    const fx = (p: Vec): Vec => (flip ? { x: -p.x, y: p.y } : p);
    const halign = Math.max(0, Math.min(5, num(r, 72))) as HAlign;
    const valign = Math.max(0, Math.min(3, num(r, valignCode))) as VAlign;
    const p = fx(pt(r, 10));
    const rot = num(r, 50) * DEG;
    return {
      p,
      a: (halign !== 0 || valign !== 0) && has(r, 11) ? fx(pt(r, 11)) : p,
      h: num(r, 40, 1) || 1,
      rot: flip ? Math.PI - rot : rot,
      style: str(r, 7, 'Standard') || 'Standard',
      wf: num(r, 41, 1) || 1,
      oblique: num(r, 51) * DEG,
      halign,
      valign,
    };
  };

  /** Attributes may carry an embedded MTEXT after code 101; only the single-line part is read. */
  const head = (r: Rec): Rec => {
    const i = r.tags.findIndex((t) => t[0] === 101);
    return i < 0 ? r : { type: r.type, tags: r.tags.slice(0, i) };
  };

  const convert = (item: Item, out: Entity[]) => {
    const r = item.rec;
    const base = { id: newId(), ...common(r) };
    const flip = flipped(r);
    const fx = (p: Vec): Vec => (flip ? { x: -p.x, y: p.y } : p);
    switch (r.type) {
      case 'LINE':
        out.push({ ...base, type: 'line', a: pt(r, 10), b: pt(r, 11) });
        return;
      case 'CIRCLE':
        out.push({ ...base, type: 'circle', c: fx(pt(r, 10)), r: num(r, 40) });
        return;
      case 'ARC': {
        let s = num(r, 50) * DEG;
        let en = num(r, 51) * DEG;
        if (flip) [s, en] = [Math.PI - en, Math.PI - s];
        out.push({ ...base, type: 'arc', c: fx(pt(r, 10)), r: num(r, 40), start: wrap(s), end: wrap(en) });
        return;
      }
      case 'ELLIPSE': {
        let s = num(r, 41);
        let en = num(r, 42, TAU);
        const whole = Math.abs(en - s - TAU) < 1e-9 || (s === 0 && en === 0);
        if (flip && !whole) [s, en] = [TAU - en, TAU - s];
        out.push({ ...base, type: 'ellipse', c: pt(r, 10), major: pt(r, 11), ratio: num(r, 40, 1) || 1, start: whole ? 0 : wrap(s), end: whole ? TAU : wrap(en) || TAU });
        return;
      }
      case 'LWPOLYLINE': {
        const verts: PlineVertex[] = [];
        for (const [c, val] of r.tags) {
          const v = verts[verts.length - 1];
          const n = parse(val, 0);
          if (c === 10) verts.push({ x: flip ? -n : n, y: 0, b: 0 });
          else if (!v) continue;
          else if (c === 20) v.y = n;
          else if (c === 42) v.b = flip ? -n : n;
          else if (c === 40) v.sw = n;
          else if (c === 41) v.ew = n;
        }
        for (const v of verts) {
          if (!v.sw && !v.ew) {
            delete v.sw;
            delete v.ew;
          } else {
            v.sw ??= 0;
            v.ew ??= 0;
          }
        }
        if (verts.length < 2) return;
        out.push({ ...base, type: 'pline', pts: verts, closed: (num(r, 70) & 1) !== 0, width: num(r, 43) });
        return;
      }
      case 'POLYLINE': {
        const flag = num(r, 70);
        if (flag & 64) return void drop('polyface mesh');
        if (flag & 16) return void drop('polygon mesh');
        const is3d = (flag & 8) !== 0;
        const flip2 = !is3d && flip;
        let verts = item.kids;
        if (verts.some((v) => (num(v, 70) & 8) !== 0)) verts = verts.filter((v) => !(num(v, 70) & 16));
        const sw0 = num(r, 40);
        const ew0 = num(r, 41);
        const out2 = verts.map((v) => {
          const p = pt(v, 10);
          const b = is3d ? 0 : num(v, 42);
          const q: PlineVertex = { x: flip2 ? -p.x : p.x, y: p.y, b: flip2 ? -b : b };
          const sw = num(v, 40, sw0);
          const ew = num(v, 41, ew0);
          if (sw || ew) {
            q.sw = sw;
            q.ew = ew;
          }
          return q;
        });
        if (out2.length < 2) return;
        out.push({ ...base, type: 'pline', pts: out2, closed: (flag & 1) !== 0, width: 0 });
        return;
      }
      case 'SPLINE': {
        const ctrl = pts(r, 10);
        const fit = pts(r, 11);
        const knots = all(r, 40);
        const weights = all(r, 41);
        const degree = num(r, 71, 3) || 3;
        const closed = (num(r, 70) & 1) !== 0;
        if (ctrl.length >= 2 && knots.length === ctrl.length + degree + 1) {
          out.push({ ...base, type: 'spline', degree, knots, ctrl, weights: weights.length === ctrl.length ? weights : undefined, closed });
        } else if (fit.length >= 2) {
          const s = interpolateSpline(fit, has(r, 12) ? pt(r, 12) : undefined, has(r, 13) ? pt(r, 13) : undefined);
          out.push({ ...base, type: 'spline', degree: s.degree, knots: s.knots, ctrl: s.ctrl, fit, closed });
        }
        return;
      }
      case 'POINT':
        out.push({ ...base, type: 'point', p: pt(r, 10) });
        return;
      case 'TEXT':
        out.push({ ...base, type: 'text', ...textBase(r, 73), text: txt(r, 1) });
        return;
      case 'ATTDEF': {
        const h = head(r);
        out.push({ ...base, type: 'attdef', ...textBase(h, 74), text: txt(h, 1), tag: str(h, 2), prompt: txt(h, 3), flags: num(h, 70) });
        return;
      }
      case 'MTEXT': {
        const text = r.tags.filter((t) => t[0] === 3).map((t) => t[1]).join('') + txt(r, 1);
        const rot = has(r, 11) ? Math.atan2(num(r, 21), num(r, 11)) : num(r, 50) * DEG;
        out.push({ ...base, type: 'mtext', p: pt(r, 10), h: num(r, 40, 1) || 1, width: num(r, 41), rot, attach: num(r, 71, 1) || 1, text, style: str(r, 7, 'Standard') || 'Standard', spacing: num(r, 44, 1) || 1 });
        return;
      }
      case 'INSERT': {
        const attribs = item.kids.map((a) => {
          const h = head(a);
          return { ...common(h), ...textBase(h, 74), text: txt(h, 1), tag: str(h, 2), flags: num(h, 70) };
        });
        const sx = num(r, 41, 1) || 1;
        const sy = num(r, 42, 1) || 1;
        const cols = num(r, 70, 1);
        const rows = num(r, 71, 1);
        const rot = num(r, 50) * DEG;
        out.push({
          ...base,
          type: 'insert',
          block: str(r, 2),
          p: fx(pt(r, 10)),
          sx: flip ? -sx : sx,
          sy,
          rot: flip ? Math.PI - rot : rot,
          attribs,
          ...(cols > 1 || rows > 1 ? { cols: Math.max(1, cols), rows: Math.max(1, rows), dc: num(r, 44), dr: num(r, 45) } : {}),
        });
        return;
      }
      case 'DIMENSION': {
        const type = num(r, 70);
        const kinds: DimKind[] = ['linear', 'aligned', 'angular', 'diameter', 'radius', 'angular3', 'ordinate'];
        const kind = kinds[type & 0x0f];
        if (!kind) return void drop('dimension');
        out.push({
          ...base,
          type: 'dim',
          kind,
          style: str(r, 3, d.header.dimstyle) || d.header.dimstyle,
          p10: pt(r, 10),
          p13: pt(r, 13),
          p14: pt(r, 14),
          p15: pt(r, 15),
          p16: has(r, 16) ? pt(r, 16) : undefined,
          text: pt(r, 11),
          rot: num(r, 50) * DEG,
          override: txt(r, 1),
          textMoved: (type & 128) !== 0,
          ordinateX: (type & 64) !== 0,
          block: str(r, 2) || undefined,
          measurement: num(r, 42),
        });
        return;
      }
      case 'HATCH':
        hatch(r, base, flip, out);
        return;
      case 'SOLID':
      case 'TRACE': {
        const c3 = fx(pt(r, 12));
        out.push({ ...base, type: 'solid', pts: [fx(pt(r, 10)), fx(pt(r, 11)), c3, has(r, 13) ? fx(pt(r, 13)) : c3] });
        return;
      }
      case '3DFACE': {
        const c3 = pt(r, 12);
        out.push({ ...base, type: 'face', pts: [pt(r, 10), pt(r, 11), c3, has(r, 13) ? pt(r, 13) : c3], invisible: num(r, 70) & 15 });
        return;
      }
      case 'LEADER': {
        const verts = pts(r, 10);
        if (verts.length < 2) return;
        out.push({ ...base, type: 'leader', pts: verts, arrow: num(r, 71, 1) !== 0, style: str(r, 3, d.header.dimstyle) || d.header.dimstyle, spline: num(r, 72) === 1 });
        return;
      }
      case 'XLINE':
      case 'RAY':
        out.push({ ...base, type: r.type === 'RAY' ? 'ray' : 'xline', p: pt(r, 10), dir: pt(r, 11) });
        return;
      case 'MULTILEADER':
      case 'MLEADER':
        mleader(r, base, out);
        return;
      case 'MLINE':
        mline(r, base, out);
        return;
      case 'VIEWPORT':
      case 'ATTRIB':
      case 'SEQEND':
      case 'VERTEX':
        return;
      default:
        drop(DROPPED_NAMES[r.type] ?? r.type.toLowerCase());
    }
  };

  const hatch = (r: Rec, base: EntityBase, flip: boolean, out: Entity[]) => {
    const tags = r.tags;
    const fx = (p: Vec): Vec => (flip ? { x: -p.x, y: p.y } : p);
    let i = tags.findIndex((t) => t[0] === 91);
    if (i < 0) return void drop('hatch');
    const nLoops = parse(tags[i++][1], 0);
    const peek = () => tags[i]?.[0];
    const take = (code: number, d = 0) => (peek() === code ? parse(tags[i++][1], d) : d);
    const point = (code: number): Vec => ({ x: take(code), y: take(code + 10) });
    const loops: HatchLoop[] = [];
    for (let k = 0; k < nLoops; k++) {
      while (i < tags.length && peek() !== 92 && peek() !== 75) i++;
      if (peek() !== 92) break;
      const flags = take(92);
      if (flags & 2) {
        const bulges = take(72) !== 0;
        const closed = take(73, 1) !== 0;
        const n = take(93);
        const verts: PlineVertex[] = [];
        for (let j = 0; j < n && peek() === 10; j++) {
          const p = fx(point(10));
          const b = bulges ? take(42) : 0;
          verts.push({ ...p, b: flip ? -b : b });
        }
        loops.push({ kind: 'poly', flags, closed, pts: verts });
      } else {
        const n = take(93);
        const edges: HatchEdge[] = [];
        for (let j = 0; j < n && peek() === 72; j++) {
          const type = take(72);
          if (type === 1) edges.push({ t: 'line', a: fx(point(10)), b: fx(point(11)) });
          else if (type === 2) {
            const c = fx(point(10));
            const radius = take(40);
            let s = take(50) * DEG;
            let en = take(51) * DEG;
            let ccw = take(73, 1) !== 0;
            if (flip) {
              [s, en] = [Math.PI - s, Math.PI - en];
              ccw = !ccw;
            }
            edges.push({ t: 'arc', c, r: radius, start: s, end: en, ccw });
          } else if (type === 3) {
            const c = fx(point(10));
            const major = point(11);
            const ratio = take(40, 1);
            const s = take(50) * DEG;
            const en = take(51) * DEG;
            const ccw = take(73, 1) !== 0;
            edges.push({ t: 'ellipse', c, major: flip ? { x: -major.x, y: major.y } : major, ratio, start: s, end: en, ccw: flip ? !ccw : ccw });
          } else if (type === 4) {
            const degree = take(94, 3);
            const rational = take(73) !== 0;
            take(74);
            const nk = take(95);
            const nc = take(96);
            const knots: number[] = [];
            for (let q = 0; q < nk && peek() === 40; q++) knots.push(take(40));
            const ctrl: Vec[] = [];
            const weights: number[] = [];
            for (let q = 0; q < nc && peek() === 10; q++) {
              ctrl.push(fx(point(10)));
              if (rational) weights.push(take(42, 1));
            }
            // Fit data, from AutoCAD 2010 on.
            if (peek() === 97) {
              const nf = take(97);
              for (let q = 0; q < nf && peek() === 11; q++) point(11);
              if (peek() === 12) point(12);
              if (peek() === 13) point(13);
            }
            edges.push({ t: 'spline', degree, knots, ctrl, weights: rational && weights.some((w) => w !== 1) ? weights : undefined });
          } else break;
        }
        loops.push({ kind: 'edges', flags, edges });
      }
    }
    if (!loops.length) return void drop('hatch');

    const solid = num(r, 70) === 1;
    let style = 0;
    let patternType = 1;
    let angle = 0;
    let scale = 1;
    let double = false;
    const lines: PatternLine[] = [];
    while (i < tags.length && peek() !== 75) i++;
    for (; i < tags.length; i++) {
      const [c, val] = tags[i];
      const n = parse(val, 0);
      const line = lines[lines.length - 1];
      if (c === 75) style = n;
      else if (c === 76) patternType = n;
      else if (c === 52) angle = n * DEG;
      else if (c === 41) scale = n || 1;
      else if (c === 77) double = n !== 0;
      else if (c === 53) lines.push({ angle: n * DEG, base: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, dashes: [] });
      else if (!line) continue;
      else if (c === 43) line.base.x = n;
      else if (c === 44) line.base.y = n;
      else if (c === 45) line.offset.x = n;
      else if (c === 46) line.offset.y = n;
      else if (c === 49) line.dashes.push(n);
      else if (c === 47 || c === 98) break;
    }
    out.push({
      ...base,
      type: 'hatch',
      loops,
      solid,
      pattern: str(r, 2, solid ? 'SOLID' : 'ANSI31') || (solid ? 'SOLID' : 'ANSI31'),
      angle,
      scale,
      lines: lines.map((l) =>
        flip ? { angle: Math.PI - l.angle, base: { x: -l.base.x, y: l.base.y }, offset: { x: -l.offset.x, y: l.offset.y }, dashes: l.dashes } : l,
      ),
      style,
      patternType,
      double,
    });
  };

  const mleader = (r: Rec, base: EntityBase, out: Entity[]) => {
    type Section = { last: Vec | null; dog: Vec; len: number; lines: Vec[][] };
    const sections: Section[] = [];
    let depth = 0;
    let sec: Section | null = null;
    let line: Vec[] | null = null;
    let text = '';
    let textAt: Vec | null = null;
    let textDir: Vec = { x: 1, y: 0 };
    let height = 0;
    let width = 0;
    let attach = 1;
    let style = 'Standard';
    let leaderType = 1;
    let dogleg = true;
    const tags = r.tags;
    for (let i = 0; i < tags.length; i++) {
      const [c, val] = tags[i];
      const n = parse(val, 0);
      const y = () => (tags[i + 1]?.[0] === c + 10 ? parse(tags[++i][1], 0) : 0);
      if (c === 300 && val.trim() === 'CONTEXT_DATA{') depth = 1;
      else if (c === 301) depth = 0;
      else if (c === 302 && val.trim() === 'LEADER{') {
        sec = { last: null, dog: { x: 1, y: 0 }, len: 0, lines: [] };
        sections.push(sec);
        depth = 2;
      } else if (c === 303) depth = 1;
      else if (c === 304 && val.trim() === 'LEADER_LINE{') {
        line = [];
        sec?.lines.push(line);
        depth = 3;
      } else if (c === 305) depth = 2;
      else if (depth === 3 && c === 10) line?.push({ x: n, y: y() });
      else if (depth === 2 && sec) {
        if (c === 10) sec.last = { x: n, y: y() };
        else if (c === 11) sec.dog = { x: n, y: y() };
        else if (c === 40) sec.len = n;
      } else if (depth === 1) {
        if (c === 304) text = val;
        else if (c === 12) textAt = { x: n, y: y() };
        else if (c === 13) textDir = { x: n, y: y() };
        else if (c === 41) height = n;
        else if (c === 43) width = n;
        else if (c === 171) attach = n;
        else if (c === 340) style = styleByHandle.get(val.trim().toUpperCase()) || style;
      } else if (depth === 0) {
        if (c === 170) leaderType = n;
        else if (c === 291) dogleg = n !== 0;
      }
    }
    for (const s of sections) {
      for (const l of s.lines) {
        const p = s.last ? [...l, s.last] : [...l];
        if (s.last && dogleg && s.len) p.push({ x: s.last.x + s.dog.x * s.len, y: s.last.y + s.dog.y * s.len });
        if (leaderType !== 0 && p.length >= 2) out.push({ ...base, id: newId(), type: 'leader', pts: p, arrow: true, style: d.header.dimstyle, spline: leaderType === 2 });
      }
    }
    if (text && textAt) {
      out.push({
        ...base,
        id: newId(),
        type: 'mtext',
        p: textAt,
        h: height || 2.5,
        width,
        rot: Math.atan2(textDir.y, textDir.x || 1),
        attach: attach >= 1 && attach <= 9 ? attach : 1,
        text,
        style,
        spacing: 1,
      });
    }
  };

  const mline = (r: Rec, base: EntityBase, out: Entity[]) => {
    const tags = r.tags;
    const nLines = num(r, 73);
    const closed = (num(r, 71) & 2) !== 0;
    let i = tags.findIndex((t) => t[0] === 11);
    if (i < 0 || nLines <= 0) return;
    const peek = () => tags[i]?.[0];
    const take = (code: number) => (peek() === code ? parse(tags[i++][1], 0) : 0);
    const point = (code: number): Vec => {
      const p = { x: take(code), y: take(code + 10) };
      take(code + 20);
      return p;
    };
    const paths: PlineVertex[][] = Array.from({ length: nLines }, () => []);
    while (peek() === 11) {
      const p = point(11);
      point(12);
      const m = point(13);
      for (let k = 0; k < nLines; k++) {
        const np = take(74);
        const params: number[] = [];
        for (let q = 0; q < np && peek() === 41; q++) params.push(take(41));
        const nf = take(75);
        for (let q = 0; q < nf && peek() === 42; q++) take(42);
        const off = params[0] ?? 0;
        paths[k].push({ x: p.x + m.x * off, y: p.y + m.y * off, b: 0 });
      }
    }
    for (const p of paths) if (p.length >= 2) out.push({ ...base, id: newId(), type: 'pline', pts: p, closed, width: 0 });
  };

  const model: Entity[] = [];
  const paper: Entity[] = [];
  for (const item of items(sections.ENTITIES ?? [])) convert(item, num(item.rec, 67) === 1 ? paper : model);
  d.entities = model;

  const blocks: Record<string, Block> = {};
  const blockRecs = sections.BLOCKS ?? [];
  for (let i = 0; i < blockRecs.length; i++) {
    const b = blockRecs[i];
    if (b.type !== 'BLOCK') continue;
    const list: Rec[] = [];
    while (++i < blockRecs.length && blockRecs[i].type !== 'ENDBLK') list.push(blockRecs[i]);
    const name = str(b, 2) || str(b, 3);
    if (/^[*$]model_space$/i.test(name)) continue;
    const ents: Entity[] = [];
    for (const item of items(list)) convert(item, ents);
    if (/^[*$]paper_space$/i.test(name)) {
      paper.push(...ents);
      continue;
    }
    if (/^[*$]paper_space/i.test(name)) continue;
    if (num(b, 70) & 4) {
      drop('external reference');
      continue;
    }
    blocks[name] = { name, base: pt(b, 10), entities: ents, flags: num(b, 70) & 3, description: txt(b, 4) };
  }
  d.blocks = blocks;
  d.paper = paper;

  const active = entries('VPORT').find((p) => /^\*active$/i.test(str(p, 2)));
  if (active && num(active, 40) > 0) d.view = { center: pt(active, 12), height: num(active, 40) };

  if (!d.layers.some((l) => l.name === '0')) d.layers.unshift({ name: '0', color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
  if (!d.layers.some((l) => l.name.toUpperCase() === d.header.clayer.toUpperCase())) d.header.clayer = '0';
  if (!d.dimStyles.some((s) => s.name.toUpperCase() === d.header.dimstyle.toUpperCase())) d.header.dimstyle = d.dimStyles[0].name;
  return { drawing: d, dropped, version };
}
