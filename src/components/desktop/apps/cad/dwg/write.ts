/**
 * Writes a drawing as an AutoCAD 2000 DWG (AC1015), the oldest format
 * every AutoCAD, LT, DWG TrueView and DWG library still opens and saves.
 *
 * The layout follows the Open Design Specification for .dwg files and the
 * order AutoCAD writes things in; where the specification is vague, it
 * follows ACadSharp's writer (MIT, Copyright (c) 2021 Albert Domenech), which
 * this is in part a port of, and LibreDWG's spec files.
 *
 * Every save rebuilds the database from the drawing: fresh handles, the
 * tables, the named objects dictionary, layouts, blocks and entities.
 */

import {
  BYLAYER,
  CONTINUOUS,
  LINEWEIGHTS,
  LW_BYBLOCK,
  LW_BYLAYER,
  LW_DEFAULT,
  TRUE_COLOR,
  type Attrib,
  type Block,
  type DimStyle,
  type Dimension,
  type Drawing,
  type Entity,
  type Hatch,
  type Insert,
  type Layer,
  type Linetype,
  type Text,
  type TextStyle,
  type Vec,
} from '../model';
import { nearestAci } from '../aci';
import {
  BitWriter,
  crc16,
  encoder,
  HARD_OWNER,
  HARD_POINTER,
  modularChar,
  modularShort,
  SOFT_OWNER,
  SOFT_POINTER,
  unsignedModularChar,
} from './bits';

export interface WriteOptions {
  /** The model space's extents, for EXTMIN/EXTMAX and the initial view. */
  extents: { min: Vec; max: Vec } | null;
  /** The geometry of a dimension that has no block of its own yet. */
  dimBlock: (dim: Dimension) => Entity[];
  /** Times are Julian dates. */
  now: number;
}

const SENTINEL = {
  headerStart: [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f],
  headerEnd: [0x30, 0x84, 0xe0, 0xdc, 0x02, 0x21, 0xc7, 0x56, 0xa0, 0x83, 0x97, 0x47, 0xb1, 0x92, 0xcc, 0xa0],
  classesStart: [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a],
  classesEnd: [0x72, 0x5e, 0x3b, 0x47, 0x3b, 0x56, 0x07, 0x3a, 0x3f, 0x23, 0x0b, 0xa0, 0x18, 0x30, 0x49, 0x75],
  previewStart: [0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b],
  previewEnd: [0xe0, 0xda, 0x92, 0xf8, 0x2b, 0xc9, 0xd7, 0xd7, 0x62, 0xa8, 0x35, 0xc0, 0x62, 0xbb, 0xef, 0xd4],
  fileHeaderEnd: [0x95, 0xa0, 0x4e, 0x28, 0x99, 0x82, 0x1a, 0xe5, 0x5e, 0x41, 0xe0, 0x5f, 0x9d, 0x3a, 0x4d, 0x00],
};

/** Fixed object types (R2000). */
const T = {
  TEXT: 1,
  ATTRIB: 2,
  ATTDEF: 3,
  BLOCK: 4,
  ENDBLK: 5,
  SEQEND: 6,
  INSERT: 7,
  MINSERT: 8,
  ARC: 17,
  CIRCLE: 18,
  LINE: 19,
  DIM_ORDINATE: 20,
  DIM_LINEAR: 21,
  DIM_ALIGNED: 22,
  DIM_ANG3PT: 23,
  DIM_ANG2LN: 24,
  DIM_RADIUS: 25,
  DIM_DIAMETER: 26,
  POINT: 27,
  FACE3D: 28,
  SOLID: 31,
  ELLIPSE: 35,
  SPLINE: 36,
  RAY: 40,
  XLINE: 41,
  DICTIONARY: 42,
  MTEXT: 44,
  LEADER: 45,
  BLOCK_CONTROL: 48,
  BLOCK_HEADER: 49,
  LAYER_CONTROL: 50,
  LAYER: 51,
  STYLE_CONTROL: 52,
  STYLE: 53,
  LTYPE_CONTROL: 56,
  LTYPE: 57,
  VIEW_CONTROL: 60,
  UCS_CONTROL: 62,
  VPORT_CONTROL: 64,
  VPORT: 65,
  APPID_CONTROL: 66,
  APPID: 67,
  DIMSTYLE_CONTROL: 68,
  DIMSTYLE: 69,
  VX_CONTROL: 70,
  MLINESTYLE: 73,
  LWPOLYLINE: 77,
  HATCH: 78,
  XRECORD: 79,
} as const;

/** Classes, numbered from 500, for objects without a fixed type in R2000. */
const CLASSES = [
  { num: 500, dxf: 'ACDBDICTIONARYWDFLT', cpp: 'AcDbDictionaryWithDefault', app: 'ObjectDBX Classes', flags: 0, entity: false },
  { num: 501, dxf: 'ACDBPLACEHOLDER', cpp: 'AcDbPlaceHolder', app: 'ObjectDBX Classes', flags: 0, entity: false },
  { num: 502, dxf: 'LAYOUT', cpp: 'AcDbLayout', app: 'ObjectDBX Classes', flags: 0, entity: false },
];
const C_DICT_DEFAULT = 500;
const C_PLACEHOLDER = 501;
const C_LAYOUT = 502;

/** ODA's ANSI_1252 code page index. */
const CODEPAGE_INDEX: Record<number, number> = { 1252: 30, 1250: 28, 1251: 29, 1253: 31, 1254: 32, 1255: 33, 1256: 34, 1257: 35, 1258: 36, 874: 37, 932: 38, 936: 39, 949: 40, 950: 41 };

const lwIndex = (lw: number) => {
  if (lw === LW_BYLAYER) return 29;
  if (lw === LW_BYBLOCK) return 30;
  if (lw === LW_DEFAULT) return 31;
  const i = LINEWEIGHTS.indexOf(lw);
  return i < 0 ? 31 : i;
};

const aciOf = (c: number) => (c >= TRUE_COLOR ? nearestAci(c & 0xffffff) : c);

const upper = (s: string) => s.toUpperCase();

interface BlockRec {
  name: string;
  handle: number;
  blockEnt: number;
  endblk: number;
  layout: number;
  base: Vec;
  entities: Entity[];
  flags: number;
  description: string;
  inserts: number[];
}

/** One object's two streams: the data, then the handle references after it. */
class ObjWriter {
  main = new BitWriter();
  hdl = new BitWriter();
  private sizePos = 0;

  constructor(type: number, handle: number) {
    this.main.bs(type);
    this.sizePos = this.main.pos;
    this.main.rl(0);
    this.main.h(0, handle);
    // No extended entity data.
    this.main.bs(0);
  }

  finish(): Uint8Array {
    const bits = this.main.pos;
    this.main.patchRlAtBit(this.sizePos, bits);
    const h = this.hdl;
    const n = h.pos;
    const src = h.bytes;
    for (let i = 0; i < n; i++) this.main.bit((src[i >> 3] >> (7 - (i & 7))) & 1);
    this.main.align();
    return this.main.bytes.slice();
  }
}

export function writeDwg(input: Drawing, opts: WriteOptions): Uint8Array {
  const d = input;
  const enc = encoder(d.header.codepage);
  const tv = (w: BitWriter, s: string) => w.tv(s, enc);

  // ---- Handles ---------------------------------------------------------------------------
  let next = 1;
  const alloc = () => next++;

  const H = {
    blockCtl: alloc(),
    layerCtl: alloc(),
    styleCtl: alloc(),
    ltypeCtl: alloc(),
    viewCtl: alloc(),
    ucsCtl: alloc(),
    vportCtl: alloc(),
    appidCtl: alloc(),
    dimstyleCtl: alloc(),
    vxCtl: alloc(),
    root: alloc(),
    groupDict: alloc(),
    mlineDict: alloc(),
    mlineStandard: alloc(),
    plotStyleDict: alloc(),
    placeholder: alloc(),
    layoutDict: alloc(),
    plotSettingsDict: alloc(),
    appidAcad: alloc(),
    vportActive: alloc(),
    layoutModel: alloc(),
    layoutPaper: alloc(),
  };

  // Tables, with everything the entities name.
  const layers: Layer[] = d.layers.map((l) => ({ ...l }));
  const haveLayer = (n: string) => layers.some((l) => upper(l.name) === upper(n));
  const linetypes: Linetype[] = [];
  for (const name of ['ByBlock', 'ByLayer', CONTINUOUS]) {
    linetypes.push(d.linetypes.find((l) => upper(l.name) === upper(name)) ?? { name, description: name === CONTINUOUS ? 'Solid line' : '', pattern: [] });
  }
  for (const lt of d.linetypes) if (!linetypes.some((l) => upper(l.name) === upper(lt.name))) linetypes.push(lt);
  const styles: TextStyle[] = d.textStyles.length ? [...d.textStyles] : [{ name: 'Standard', font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 }];
  const dimstyles: DimStyle[] = [...d.dimStyles];

  const blocks: Record<string, Block> = { ...d.blocks };
  const allEntities = (fn: (e: Entity) => void) => {
    const walk = (list: Entity[]) => list.forEach(fn);
    walk(d.entities);
    walk(d.paper);
    for (const b of Object.values(blocks)) walk(b.entities);
  };

  // Dimensions without a block get one drawn now.
  let anon = 1;
  const usedNames = new Set(Object.keys(blocks).map(upper));
  const freshAnon = (prefix: string) => {
    let n: string;
    do n = `${prefix}${anon++}`;
    while (usedNames.has(upper(n)));
    usedNames.add(upper(n));
    return n;
  };
  const fixDims = (list: Entity[]): Entity[] =>
    list.map((e) => {
      if (e.type !== 'dim') return e;
      if (e.block && blocks[e.block]) return e;
      const name = freshAnon('*D');
      blocks[name] = { name, base: { x: 0, y: 0 }, entities: opts.dimBlock(e), flags: 1, description: '' };
      return { ...e, block: name };
    });
  const model = fixDims(d.entities);
  const paper = fixDims(d.paper);
  for (const b of Object.values({ ...blocks })) if (b.entities.some((e) => e.type === 'dim' && !(e.block && blocks[e.block]))) blocks[b.name] = { ...b, entities: fixDims(b.entities) };

  allEntities((e) => {
    if (!haveLayer(e.layer)) layers.push({ name: e.layer, color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
    if (!linetypes.some((l) => upper(l.name) === upper(e.linetype))) linetypes.push({ name: e.linetype, description: '', pattern: [] });
    const style = e.type === 'text' || e.type === 'attdef' || e.type === 'mtext' ? e.style : null;
    if (e.type === 'insert') for (const a of e.attribs) if (!styles.some((s) => upper(s.name) === upper(a.style))) styles.push({ name: a.style, font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 });
    if (e.type === 'dim' || e.type === 'leader') {
      if (!dimstyles.some((s) => upper(s.name) === upper(e.style))) dimstyles.push({ ...(dimstyles[0] ?? ({} as DimStyle)), name: e.style });
    } else if (style && !styles.some((s) => upper(s.name) === upper(style))) styles.push({ name: style, font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 });
  });
  if (!haveLayer('0')) layers.unshift({ name: '0', color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
  if (!dimstyles.length) throw new Error('A drawing needs a dimension style.');
  for (const l of layers) if (!linetypes.some((t) => upper(t.name) === upper(l.linetype))) l.linetype = CONTINUOUS;

  const layerH = new Map<string, number>();
  for (const l of layers) layerH.set(upper(l.name), alloc());
  const ltypeH = new Map<string, number>();
  for (const l of linetypes) ltypeH.set(upper(l.name), alloc());
  const styleH = new Map<string, number>();
  for (const s of styles) styleH.set(upper(s.name), alloc());
  const dimstyleH = new Map<string, number>();
  for (const s of dimstyles) dimstyleH.set(upper(s.name), alloc());

  const recs: BlockRec[] = [];
  const recByName = new Map<string, BlockRec>();
  const addRec = (name: string, b: Omit<BlockRec, 'handle' | 'blockEnt' | 'endblk' | 'name' | 'layout' | 'inserts'>, layout = 0) => {
    const r: BlockRec = { name, handle: alloc(), blockEnt: alloc(), endblk: alloc(), layout, inserts: [], ...b };
    recs.push(r);
    recByName.set(upper(name), r);
    return r;
  };
  const msRec = addRec('*Model_Space', { base: { x: 0, y: 0 }, entities: model, flags: 0, description: '' }, H.layoutModel);
  const psRec = addRec('*Paper_Space', { base: { x: 0, y: 0 }, entities: paper, flags: 0, description: '' }, H.layoutPaper);
  for (const b of Object.values(blocks)) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue;
    addRec(b.name, { base: b.base, entities: b.entities, flags: b.flags | (b.entities.some((e) => e.type === 'attdef') ? 2 : 0), description: b.description });
  }

  // Entities get handles in the order they're written, so each one's
  // neighbours (prev/next links) are known before it's written.
  const entH = new Map<Entity, number>();
  const attribH = new Map<Attrib, number>();
  const seqendH = new Map<Insert, number>();
  for (const r of recs) {
    for (const e of r.entities) {
      if (e.type === 'insert' && !recByName.has(upper(e.block))) continue;
      entH.set(e, alloc());
      if (e.type === 'insert' && e.attribs.length) {
        for (const a of e.attribs) attribH.set(a, alloc());
        seqendH.set(e, alloc());
      }
      if (e.type === 'insert') recByName.get(upper(e.block))!.inserts.push(entH.get(e)!);
    }
  }
  const handseed = next;

  const lt = (name: string) => ltypeH.get(upper(name)) ?? ltypeH.get(upper(CONTINUOUS))!;
  const la = (name: string) => layerH.get(upper(name)) ?? layerH.get('0')!;
  const st = (name: string) => styleH.get(upper(name)) ?? styleH.values().next().value!;
  const ds = (name: string) => dimstyleH.get(upper(name)) ?? dimstyleH.values().next().value!;
  const blk = (name: string) => recByName.get(upper(name))?.handle ?? 0;

  // ---- Objects -------------------------------------------------------------------------------
  const objects: { handle: number; bytes: Uint8Array }[] = [];
  const put = (handle: number, w: ObjWriter) => objects.push({ handle, bytes: w.finish() });

  /** Common non-entity data: owner, reactors, no extension dictionary. */
  const obj = (type: number, handle: number, owner: number, reactors: number[] = []) => {
    const w = new ObjWriter(type, handle);
    w.main.bl(reactors.length);
    w.hdl.h(SOFT_POINTER, owner);
    for (const r of reactors) w.hdl.h(SOFT_POINTER, r);
    w.hdl.h(HARD_OWNER, 0);
    return w;
  };

  /** Table entry name and xref bits; entries count as referenced (the 64 flag), as AutoCAD writes them. */
  const entryName = (w: ObjWriter, name: string) => {
    tv(w.main, name);
    w.main.bit(1);
    w.main.bs(0);
    w.main.bit(0);
  };

  const control = (type: number, handle: number, entries: number[], tail: number[] = [], extra?: (w: ObjWriter) => void) => {
    const w = obj(type, handle, 0);
    w.main.bl(entries.length);
    extra?.(w);
    for (const e of entries) w.hdl.h(SOFT_OWNER, e);
    for (const e of tail) w.hdl.h(HARD_OWNER, e);
    put(handle, w);
  };

  // Block control: real blocks, then *Model_Space and *Paper_Space.
  control(
    T.BLOCK_CONTROL,
    H.blockCtl,
    recs.filter((r) => r !== msRec && r !== psRec).map((r) => r.handle),
    [msRec.handle, psRec.handle],
  );
  control(T.LAYER_CONTROL, H.layerCtl, layers.map((l) => layerH.get(upper(l.name))!));
  control(T.STYLE_CONTROL, H.styleCtl, styles.map((s) => styleH.get(upper(s.name))!));
  const byBlock = ltypeH.get('BYBLOCK')!;
  const byLayer = ltypeH.get('BYLAYER')!;
  control(
    T.LTYPE_CONTROL,
    H.ltypeCtl,
    linetypes.filter((l) => !/^by(block|layer)$/i.test(l.name)).map((l) => ltypeH.get(upper(l.name))!),
    [byBlock, byLayer],
  );
  control(T.VIEW_CONTROL, H.viewCtl, []);
  control(T.UCS_CONTROL, H.ucsCtl, []);
  control(T.VPORT_CONTROL, H.vportCtl, [H.vportActive]);
  control(T.APPID_CONTROL, H.appidCtl, [H.appidAcad]);
  control(T.DIMSTYLE_CONTROL, H.dimstyleCtl, dimstyles.map((s) => dimstyleH.get(upper(s.name))!), [], (w) => w.main.byte(0));
  control(T.VX_CONTROL, H.vxCtl, []);

  // Layers.
  for (const l of layers) {
    const h = layerH.get(upper(l.name))!;
    const w = obj(T.LAYER, h, H.layerCtl);
    entryName(w, l.name);
    let flags = lwIndex(l.lineweight) << 5;
    if (l.frozen) flags |= 1;
    if (!l.on) flags |= 2;
    if (l.locked) flags |= 8;
    if (l.plot) flags |= 16;
    w.main.bs(flags);
    w.main.cmc(Math.max(1, Math.min(255, aciOf(l.color) || 7)));
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, H.placeholder);
    w.hdl.h(HARD_POINTER, lt(l.linetype));
    put(h, w);
  }

  // Text styles.
  for (const s of styles) {
    const h = styleH.get(upper(s.name))!;
    const w = obj(T.STYLE, h, H.styleCtl);
    entryName(w, s.name);
    w.main.bit(0);
    w.main.bit(0);
    w.main.bd(s.height);
    w.main.bd(s.width || 1);
    w.main.bd(s.oblique);
    w.main.byte(0);
    w.main.bd(s.height || 0.2);
    tv(w.main, s.font);
    tv(w.main, s.bigfont);
    w.hdl.h(HARD_POINTER, 0);
    put(h, w);
  }

  // Linetypes.
  for (const l of linetypes) {
    const h = ltypeH.get(upper(l.name))!;
    const w = obj(T.LTYPE, h, H.ltypeCtl);
    entryName(w, l.name);
    tv(w.main, l.description);
    w.main.bd(l.pattern.reduce((s, x) => s + Math.abs(x), 0));
    w.main.byte(65);
    w.main.byte(l.pattern.length);
    for (const dash of l.pattern) {
      w.main.bd(dash);
      w.main.bs(0);
      w.main.rd(0);
      w.main.rd(0);
      w.main.bd(1);
      w.main.bd(0);
      w.main.bs(0);
    }
    w.main.raw(new Uint8Array(256));
    w.hdl.h(HARD_POINTER, 0);
    for (let i = 0; i < l.pattern.length; i++) w.hdl.h(HARD_POINTER, 0);
    put(h, w);
  }

  // The view the drawing opens at.
  const ext = opts.extents;
  const view = d.view ?? (ext ? { center: { x: (ext.min.x + ext.max.x) / 2, y: (ext.min.y + ext.max.y) / 2 }, height: Math.max(1e-6, (ext.max.y - ext.min.y) * 1.1, (ext.max.x - ext.min.x) * 0.6) } : { center: { x: (d.header.limmax.x + d.header.limmin.x) / 2, y: (d.header.limmax.y + d.header.limmin.y) / 2 }, height: d.header.limmax.y - d.header.limmin.y || 9 });
  {
    const w = obj(T.VPORT, H.vportActive, H.vportCtl);
    entryName(w, '*Active');
    const aspect = 1.6;
    w.main.bd(view.height);
    w.main.bd(view.height * aspect);
    w.main.rd2(view.center);
    w.main.bd3(0, 0, 0);
    w.main.bd3(0, 0, 1);
    w.main.bd(0);
    w.main.bd(50);
    w.main.bd(0);
    w.main.bd(0);
    w.main.bits(0b0001, 4);
    w.main.byte(0);
    w.main.rd2({ x: 0, y: 0 });
    w.main.rd2({ x: 1, y: 1 });
    w.main.bit(0);
    w.main.bs(1000);
    w.main.bit(1);
    w.main.bits(3, 2);
    w.main.bit(0);
    const grid = d.header.measurement ? 10 : 0.5;
    w.main.rd2({ x: grid, y: grid });
    w.main.bit(0);
    w.main.bit(0);
    w.main.bs(0);
    w.main.bd(0);
    w.main.rd2({ x: 0, y: 0 });
    w.main.rd2({ x: grid, y: grid });
    w.main.bit(0);
    w.main.bit(1);
    w.main.bd3(0, 0, 0);
    w.main.bd3(1, 0, 0);
    w.main.bd3(0, 1, 0);
    w.main.bd(0);
    w.main.bs(0);
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, 0);
    put(H.vportActive, w);
  }

  // The ACAD application id.
  {
    const w = obj(T.APPID, H.appidAcad, H.appidCtl);
    entryName(w, 'ACAD');
    w.main.byte(0);
    w.hdl.h(HARD_POINTER, 0);
    put(H.appidAcad, w);
  }

  // Dimension styles.
  for (const s of dimstyles) {
    const h = dimstyleH.get(upper(s.name))!;
    const w = obj(T.DIMSTYLE, h, H.dimstyleCtl);
    entryName(w, s.name);
    const m = w.main;
    tv(m, s.dimpost);
    tv(m, '');
    m.bd(s.dimscale);
    m.bd(s.dimasz);
    m.bd(s.dimexo);
    m.bd(d.header.measurement ? 3.75 : 0.38);
    m.bd(s.dimexe);
    m.bd(s.dimrnd);
    m.bd(s.dimdle);
    m.bd(0);
    m.bd(0);
    m.bit(0);
    m.bit(0);
    m.bit(s.dimtih);
    m.bit(s.dimtoh);
    m.bit(s.dimse1);
    m.bit(s.dimse2);
    m.bs(s.dimtad);
    m.bs(s.dimzin);
    m.bs(0);
    m.bd(s.dimtxt);
    m.bd(s.dimcen);
    m.bd(s.dimtsz);
    m.bd(25.4);
    m.bd(s.dimlfac);
    m.bd(0);
    m.bd(1);
    m.bd(s.dimgap);
    m.bd(0);
    m.bit(0);
    m.bs(2);
    m.bit(s.dimtofl);
    m.bit(0);
    m.bit(s.dimtix);
    m.bit(s.dimsoxd);
    m.cmc(aciOf(s.dimclrd));
    m.cmc(aciOf(s.dimclre));
    m.cmc(aciOf(s.dimclrt));
    m.bs(s.dimadec);
    m.bs(s.dimdec);
    m.bs(s.dimdec);
    m.bs(2);
    m.bs(2);
    m.bs(0);
    m.bs(0);
    m.bs(s.dimlunit);
    m.bs(s.dimdsep);
    m.bs(0);
    m.bs(s.dimjust);
    m.bit(s.dimsd1);
    m.bit(s.dimsd2);
    m.bs(1);
    m.bs(0);
    m.bs(0);
    m.bs(0);
    m.bit(0);
    m.bs(s.dimatfit);
    m.bs(s.dimlwd);
    m.bs(s.dimlwe);
    m.bit(0);
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, st(s.dimtxsty));
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, blk(s.dimblk));
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, 0);
    put(h, w);
  }

  // Block records.
  for (const r of recs) {
    const w = obj(T.BLOCK_HEADER, r.handle, H.blockCtl);
    const m = w.main;
    entryName(w, r.name);
    m.bit(r.flags & 1);
    m.bit(r.flags & 2);
    m.bit(0);
    m.bit(0);
    m.bit(0);
    m.bd3(r.base.x, r.base.y, 0);
    tv(m, '');
    for (let i = 0; i < r.inserts.length; i++) m.byte(1);
    m.byte(0);
    tv(m, r.description);
    m.bl(0);
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_OWNER, r.blockEnt);
    const handles = r.entities.map((e) => entH.get(e)).filter((h): h is number => h !== undefined);
    w.hdl.h(SOFT_POINTER, handles[0] ?? 0);
    w.hdl.h(SOFT_POINTER, handles[handles.length - 1] ?? 0);
    w.hdl.h(HARD_OWNER, r.endblk);
    for (const i of r.inserts) w.hdl.h(SOFT_POINTER, i);
    w.hdl.h(HARD_POINTER, r.layout);
    put(r.handle, w);
  }

  // ---- Entities ------------------------------------------------------------------------------

  interface Common {
    layer: string;
    color: number;
    linetype: string;
    lineweight: number;
    ltscale: number;
    hidden?: boolean;
  }

  /**
   * Common entity data. `mode` is 2 in model space, 1 in paper space, 0
   * (with an owner) elsewhere.
   */
  const ent = (type: number, handle: number, e: Common, mode: number, owner: number, prev: number, nxt: number) => {
    const w = new ObjWriter(type, handle);
    const m = w.main;
    m.bit(0);
    m.bits(mode, 2);
    if (mode === 0) w.hdl.h(SOFT_POINTER, owner);
    m.bl(0);
    w.hdl.h(HARD_OWNER, 0);
    m.bit(0);
    w.hdl.h(SOFT_POINTER, prev);
    w.hdl.h(SOFT_POINTER, nxt);
    m.cmc(aciOf(e.color));
    m.bd(e.ltscale || 1);
    w.hdl.h(HARD_POINTER, la(e.layer));
    const ltn = upper(e.linetype || 'ByLayer');
    if (ltn === 'BYLAYER') m.bits(0, 2);
    else if (ltn === 'BYBLOCK') m.bits(1, 2);
    else if (ltn === upper(CONTINUOUS)) m.bits(2, 2);
    else {
      m.bits(3, 2);
      w.hdl.h(HARD_POINTER, lt(e.linetype));
    }
    m.bits(0, 2);
    m.bs(e.hidden ? 1 : 0);
    m.byte(lwIndex(e.lineweight));
    return w;
  };

  const writeText = (w: ObjWriter, t: Omit<Text, 'type' | 'id'>) => {
    const m = w.main;
    const aligned = !(t.halign === 0 && t.valign === 0);
    let flags = 1;
    if (!aligned) flags |= 2;
    if (!t.oblique) flags |= 4;
    if (!t.rot) flags |= 8;
    if (t.wf === 1 || !t.wf) flags |= 16;
    flags |= 32;
    if (t.halign === 0) flags |= 64;
    if (t.valign === 0) flags |= 128;
    m.byte(flags);
    m.rd(t.p.x);
    m.rd(t.p.y);
    if (aligned) {
      m.dd(t.a.x, t.p.x);
      m.dd(t.a.y, t.p.y);
    }
    m.be();
    m.bt(0);
    if (!(flags & 4)) m.rd(t.oblique);
    if (!(flags & 8)) m.rd(t.rot);
    m.rd(t.h);
    if (!(flags & 16)) m.rd(t.wf);
    tv(m, t.text);
    if (!(flags & 64)) m.bs(t.halign);
    if (!(flags & 128)) m.bs(t.valign);
    w.hdl.h(HARD_POINTER, st(t.style));
  };

  const writeAttribTail = (w: ObjWriter, tag: string, flags: number) => {
    tv(w.main, tag);
    w.main.bs(0);
    w.main.byte(flags);
  };

  const writeDimCommon = (w: ObjWriter, e: Dimension, measurement: number) => {
    const m = w.main;
    m.bd3(0, 0, 1);
    m.rd2(e.text);
    m.bd(0);
    m.byte(e.textMoved ? 0 : 1);
    tv(m, e.override);
    m.bd(0);
    m.bd(0);
    m.bd3(1, 1, 1);
    m.bd(0);
    m.bs(5);
    m.bs(1);
    m.bd(1);
    m.bd(measurement);
    m.rd2({ x: 0, y: 0 });
    w.hdl.h(HARD_POINTER, ds(e.style));
    w.hdl.h(HARD_POINTER, blk(e.block ?? ''));
  };

  const writeHatch = (w: ObjWriter, e: Hatch) => {
    const m = w.main;
    m.bd(0);
    m.bd3(0, 0, 1);
    tv(m, e.solid ? 'SOLID' : e.pattern);
    m.bit(e.solid);
    m.bit(0);
    m.bl(e.loops.length);
    let derived = false;
    for (const loop of e.loops) {
      if (loop.kind === 'poly') {
        const flags = (loop.flags | 2) & ~0x80;
        if (flags & 4) derived = true;
        m.bl(flags);
        const bulges = loop.pts.some((p) => p.b !== 0);
        m.bit(bulges);
        m.bit(loop.closed);
        m.bl(loop.pts.length);
        for (const p of loop.pts) {
          m.rd2(p);
          if (bulges) m.bd(p.b);
        }
      } else {
        const flags = loop.flags & ~2 & ~0x80;
        if (flags & 4) derived = true;
        m.bl(flags);
        m.bl(loop.edges.length);
        for (const ed of loop.edges) {
          if (ed.t === 'line') {
            m.byte(1);
            m.rd2(ed.a);
            m.rd2(ed.b);
          } else if (ed.t === 'arc') {
            m.byte(2);
            m.rd2(ed.c);
            m.bd(ed.r);
            m.bd(ed.start);
            m.bd(ed.end);
            m.bit(ed.ccw);
          } else if (ed.t === 'ellipse') {
            m.byte(3);
            m.rd2(ed.c);
            m.rd2(ed.major);
            m.bd(ed.ratio);
            m.bd(ed.start);
            m.bd(ed.end);
            m.bit(ed.ccw);
          } else {
            m.byte(4);
            m.bl(ed.degree);
            const rational = !!ed.weights?.length;
            m.bit(rational);
            m.bit(0);
            m.bl(ed.knots.length);
            m.bl(ed.ctrl.length);
            for (const k of ed.knots) m.bd(k);
            ed.ctrl.forEach((p, i) => {
              m.rd2(p);
              if (rational) m.bd(ed.weights![i] ?? 1);
            });
          }
        }
      }
      m.bl(0);
    }
    m.bs(e.style);
    m.bs(e.solid ? 1 : e.patternType);
    if (!e.solid) {
      m.bd(e.angle);
      m.bd(e.scale || 1);
      m.bit(e.double);
      m.bs(e.lines.length);
      for (const l of e.lines) {
        m.bd(l.angle);
        m.bd2(l.base);
        m.bd2(l.offset);
        m.bs(l.dashes.length);
        for (const dash of l.dashes) m.bd(dash);
      }
    }
    if (derived) m.bd(1);
    m.bl(0);
  };

  const writeEntity = (e: Entity, r: BlockRec, prev: number, nxt: number) => {
    const h = entH.get(e);
    if (h === undefined) return;
    const mode = r === msRec ? 2 : r === psRec ? 1 : 0;
    const begin = (type: number) => ent(type, h, e, mode, r.handle, prev, nxt);
    let w: ObjWriter;
    switch (e.type) {
      case 'line': {
        w = begin(T.LINE);
        const m = w.main;
        m.bit(1);
        m.rd(e.a.x);
        m.dd(e.b.x, e.a.x);
        m.rd(e.a.y);
        m.dd(e.b.y, e.a.y);
        m.bt(0);
        m.be();
        break;
      }
      case 'circle':
      case 'arc': {
        w = begin(e.type === 'arc' ? T.ARC : T.CIRCLE);
        const m = w.main;
        m.bd3(e.c.x, e.c.y, 0);
        m.bd(e.r);
        m.bt(0);
        m.be();
        if (e.type === 'arc') {
          m.bd(e.start);
          m.bd(e.end);
        }
        break;
      }
      case 'ellipse': {
        w = begin(T.ELLIPSE);
        const m = w.main;
        m.bd3(e.c.x, e.c.y, 0);
        m.bd3(e.major.x, e.major.y, 0);
        m.bd3(0, 0, 1);
        m.bd(e.ratio);
        m.bd(e.start);
        m.bd(e.end);
        break;
      }
      case 'pline': {
        w = begin(T.LWPOLYLINE);
        const m = w.main;
        const bulges = e.pts.some((p) => p.b !== 0);
        const widths = e.pts.some((p) => (p.sw ?? 0) !== 0 || (p.ew ?? 0) !== 0);
        let flags = 0;
        if (e.closed) flags |= 0x200;
        if (e.width) flags |= 4;
        if (bulges) flags |= 0x10;
        if (widths) flags |= 0x20;
        m.bs(flags);
        if (e.width) m.bd(e.width);
        m.bl(e.pts.length);
        if (bulges) m.bl(e.pts.length);
        if (widths) m.bl(e.pts.length);
        e.pts.forEach((p, i) => {
          if (i === 0) m.rd2(p);
          else {
            m.dd(p.x, e.pts[i - 1].x);
            m.dd(p.y, e.pts[i - 1].y);
          }
        });
        if (bulges) for (const p of e.pts) m.bd(p.b);
        if (widths)
          for (const p of e.pts) {
            m.bd(p.sw ?? 0);
            m.bd(p.ew ?? 0);
          }
        break;
      }
      case 'spline': {
        w = begin(T.SPLINE);
        const m = w.main;
        m.bl(1);
        m.bl(e.degree);
        const rational = !!e.weights?.length && e.weights.some((x) => x !== 1);
        m.bit(rational);
        m.bit(e.closed);
        m.bit(0);
        m.bd(1e-10);
        m.bd(1e-10);
        m.bl(e.knots.length);
        m.bl(e.ctrl.length);
        m.bit(rational);
        for (const k of e.knots) m.bd(k);
        e.ctrl.forEach((p, i) => {
          m.bd3(p.x, p.y, 0);
          if (rational) m.bd(e.weights![i] ?? 1);
        });
        break;
      }
      case 'point': {
        w = begin(T.POINT);
        const m = w.main;
        m.bd3(e.p.x, e.p.y, 0);
        m.bt(0);
        m.be();
        m.bd(0);
        break;
      }
      case 'text': {
        w = begin(T.TEXT);
        writeText(w, e);
        break;
      }
      case 'attdef': {
        w = begin(T.ATTDEF);
        writeText(w, e);
        writeAttribTail(w, e.tag, e.flags);
        tv(w.main, e.prompt);
        break;
      }
      case 'mtext': {
        w = begin(T.MTEXT);
        const m = w.main;
        m.bd3(e.p.x, e.p.y, 0);
        m.bd3(0, 0, 1);
        m.bd3(Math.cos(e.rot), Math.sin(e.rot), 0);
        m.bd(e.width);
        m.bd(e.h);
        m.bs(e.attach || 1);
        m.bs(1);
        m.bd(0);
        m.bd(0);
        tv(m, e.text);
        w.hdl.h(HARD_POINTER, st(e.style));
        m.bs(1);
        m.bd(e.spacing || 1);
        m.bit(0);
        break;
      }
      case 'insert': {
        const multiple = (e.cols ?? 1) > 1 || (e.rows ?? 1) > 1;
        w = begin(multiple ? T.MINSERT : T.INSERT);
        const m = w.main;
        m.bd3(e.p.x, e.p.y, 0);
        if (e.sx === 1 && e.sy === 1) m.bits(3, 2);
        else if (e.sx === e.sy) {
          m.bits(2, 2);
          m.rd(e.sx);
        } else {
          m.bits(0, 2);
          m.rd(e.sx);
          m.dd(e.sy, e.sx);
          m.dd(e.sx, e.sx);
        }
        m.bd(e.rot);
        m.bd3(0, 0, 1);
        const atts = e.attribs.length > 0;
        m.bit(atts);
        if (multiple) {
          m.bs(e.cols ?? 1);
          m.bs(e.rows ?? 1);
          m.bd(e.dc ?? 0);
          m.bd(e.dr ?? 0);
        }
        w.hdl.h(HARD_POINTER, blk(e.block));
        if (atts) {
          w.hdl.h(SOFT_POINTER, attribH.get(e.attribs[0])!);
          w.hdl.h(SOFT_POINTER, attribH.get(e.attribs[e.attribs.length - 1])!);
          w.hdl.h(HARD_OWNER, seqendH.get(e)!);
        }
        break;
      }
      case 'dim': {
        const type = {
          linear: T.DIM_LINEAR,
          aligned: T.DIM_ALIGNED,
          angular: T.DIM_ANG2LN,
          angular3: T.DIM_ANG3PT,
          radius: T.DIM_RADIUS,
          diameter: T.DIM_DIAMETER,
          ordinate: T.DIM_ORDINATE,
        }[e.kind];
        w = begin(type);
        writeDimCommon(w, e, e.measurement ?? 0);
        const m = w.main;
        const p3 = (p: Vec) => m.bd3(p.x, p.y, 0);
        switch (e.kind) {
          case 'linear':
          case 'aligned':
            p3(e.p13);
            p3(e.p14);
            p3(e.p10);
            m.bd(0);
            if (e.kind === 'linear') m.bd(e.rot);
            break;
          case 'angular':
            m.rd2(e.p16 ?? e.text);
            p3(e.p13);
            p3(e.p14);
            p3(e.p15);
            p3(e.p10);
            break;
          case 'angular3':
            p3(e.p10);
            p3(e.p13);
            p3(e.p14);
            p3(e.p15);
            break;
          case 'radius':
            p3(e.p10);
            p3(e.p15);
            m.bd(0);
            break;
          case 'diameter':
            p3(e.p15);
            p3(e.p10);
            m.bd(0);
            break;
          case 'ordinate':
            p3(e.p10);
            p3(e.p13);
            p3(e.p14);
            m.byte(e.ordinateX ? 1 : 0);
            break;
        }
        break;
      }
      case 'hatch': {
        w = begin(T.HATCH);
        writeHatch(w, e);
        break;
      }
      case 'solid': {
        w = begin(T.SOLID);
        const m = w.main;
        m.bt(0);
        m.bd(0);
        for (const p of e.pts) m.rd2(p);
        m.be();
        break;
      }
      case 'face': {
        w = begin(T.FACE3D);
        const m = w.main;
        m.bit(e.invisible === 0);
        m.bit(1);
        m.rd(e.pts[0].x);
        m.rd(e.pts[0].y);
        for (let i = 1; i < 4; i++) {
          m.dd(e.pts[i].x, e.pts[i - 1].x);
          m.dd(e.pts[i].y, e.pts[i - 1].y);
          m.dd(0, 0);
        }
        if (e.invisible) m.bs(e.invisible);
        break;
      }
      case 'leader': {
        w = begin(T.LEADER);
        const m = w.main;
        m.bit(0);
        m.bs(3);
        m.bs(e.spline ? 1 : 0);
        m.bl(e.pts.length);
        for (const p of e.pts) m.bd3(p.x, p.y, 0);
        const o = e.pts[0] ?? { x: 0, y: 0 };
        m.bd3(o.x, o.y, 0);
        m.bd3(0, 0, 1);
        m.bd3(1, 0, 0);
        m.bd3(0, 0, 0);
        m.bd3(0, 0, 0);
        m.bd(0);
        m.bd(0);
        m.bit(1);
        m.bit(e.arrow);
        m.bs(0);
        m.bit(0);
        m.bit(0);
        w.hdl.h(HARD_POINTER, 0);
        w.hdl.h(HARD_POINTER, ds(e.style));
        break;
      }
      case 'xline':
      case 'ray': {
        w = begin(e.type === 'ray' ? T.RAY : T.XLINE);
        w.main.bd3(e.p.x, e.p.y, 0);
        w.main.bd3(e.dir.x, e.dir.y, 0);
        break;
      }
    }
    put(h, w);

    // Attributes follow their insert, then a SEQEND.
    if (e.type === 'insert' && e.attribs.length) {
      e.attribs.forEach((a, i) => {
        const ah = attribH.get(a)!;
        const aw = ent(T.ATTRIB, ah, a, 0, h, i ? attribH.get(e.attribs[i - 1])! : 0, i < e.attribs.length - 1 ? attribH.get(e.attribs[i + 1])! : 0);
        writeText(aw, a);
        writeAttribTail(aw, a.tag, a.flags);
        put(ah, aw);
      });
      const sh = seqendH.get(e)!;
      put(sh, ent(T.SEQEND, sh, e, 0, h, 0, 0));
    }
  };

  const layer0: Common = { layer: '0', color: BYLAYER, linetype: 'ByLayer', lineweight: LW_BYLAYER, ltscale: 1 };
  for (const r of recs) {
    const b = ent(T.BLOCK, r.blockEnt, layer0, 0, r.handle, 0, 0);
    tv(b.main, r.name);
    put(r.blockEnt, b);
    const list = r.entities.filter((e) => entH.has(e));
    list.forEach((e, i) => writeEntity(e, r, i ? entH.get(list[i - 1])! : 0, i < list.length - 1 ? entH.get(list[i + 1])! : 0));
    put(r.endblk, ent(T.ENDBLK, r.endblk, layer0, 0, r.handle, 0, 0));
  }

  // ---- Named objects -----------------------------------------------------------------------------

  const dictionary = (type: number, handle: number, owner: number, entries: [string, number][], defaultEntry?: number) => {
    const w = obj(type, handle, owner, owner ? [owner] : []);
    w.main.bl(entries.length);
    w.main.bs(1);
    w.main.byte(0);
    for (const [name, h] of entries) {
      tv(w.main, name);
      w.hdl.h(SOFT_OWNER, h);
    }
    if (defaultEntry !== undefined) w.hdl.h(HARD_POINTER, defaultEntry);
    put(handle, w);
  };

  dictionary(T.DICTIONARY, H.root, 0, [
    ['ACAD_GROUP', H.groupDict],
    ['ACAD_LAYOUT', H.layoutDict],
    ['ACAD_MLINESTYLE', H.mlineDict],
    ['ACAD_PLOTSETTINGS', H.plotSettingsDict],
    ['ACAD_PLOTSTYLENAME', H.plotStyleDict],
  ]);
  dictionary(T.DICTIONARY, H.groupDict, H.root, []);
  dictionary(T.DICTIONARY, H.plotSettingsDict, H.root, []);
  dictionary(T.DICTIONARY, H.mlineDict, H.root, [['Standard', H.mlineStandard]]);
  dictionary(C_DICT_DEFAULT, H.plotStyleDict, H.root, [['Normal', H.placeholder]], H.placeholder);
  dictionary(T.DICTIONARY, H.layoutDict, H.root, [
    ['Layout1', H.layoutPaper],
    ['Model', H.layoutModel],
  ]);
  put(H.placeholder, obj(C_PLACEHOLDER, H.placeholder, H.plotStyleDict, [H.plotStyleDict]));

  {
    const w = obj(T.MLINESTYLE, H.mlineStandard, H.mlineDict, [H.mlineDict]);
    const m = w.main;
    tv(m, 'Standard');
    tv(m, '');
    m.bs(0);
    m.cmc(BYLAYER);
    m.bd(Math.PI / 2);
    m.bd(Math.PI / 2);
    m.byte(2);
    for (const off of [0.5, -0.5]) {
      m.bd(off);
      m.cmc(BYLAYER);
      m.bs(32767);
    }
    put(H.mlineStandard, w);
  }

  const metric = d.header.measurement === 1;
  const layout = (handle: number, name: string, tab: number, block: number, isModel: boolean) => {
    const w = obj(C_LAYOUT, handle, H.layoutDict, [H.layoutDict]);
    const m = w.main;
    tv(m, '');
    tv(m, 'none_device');
    m.bs(isModel ? 0x6b0 : 0x2b0);
    const margin = isModel ? 6.35 : 0;
    for (let i = 0; i < 4; i++) m.bd(margin);
    m.bd(isModel ? (metric ? 297 : 215.9) : 0);
    m.bd(isModel ? (metric ? 210 : 279.4) : 0);
    tv(m, isModel ? (metric ? 'ISO_A4_(297.00_x_210.00_MM)' : 'Letter_(8.50_x_11.00_Inches)') : '');
    m.bd(0);
    m.bd(0);
    m.bs(metric ? 1 : 0);
    m.bs(0);
    m.bs(isModel ? 0 : 5);
    m.bd(0);
    m.bd(0);
    m.bd(0);
    m.bd(0);
    tv(m, '');
    m.bd(1);
    m.bd(1);
    tv(m, '');
    m.bs(isModel ? 0 : 16);
    m.bd(1);
    m.bd2({ x: 0, y: 0 });
    tv(m, name);
    m.bl(tab);
    m.bs(1);
    m.bd3(0, 0, 0);
    m.rd2(d.header.limmin);
    m.rd2(d.header.limmax);
    m.bd3(0, 0, 0);
    m.bd3(1, 0, 0);
    m.bd3(0, 1, 0);
    m.bd(0);
    m.bs(0);
    const e = isModel ? ext : null;
    m.bd3(e ? e.min.x : 1e20, e ? e.min.y : 1e20, e ? 0 : 1e20);
    m.bd3(e ? e.max.x : -1e20, e ? e.max.y : -1e20, e ? 0 : -1e20);
    w.hdl.h(SOFT_POINTER, block);
    w.hdl.h(SOFT_POINTER, 0);
    w.hdl.h(HARD_POINTER, 0);
    w.hdl.h(HARD_POINTER, 0);
    put(handle, w);
  };
  layout(H.layoutModel, 'Model', 0, msRec.handle, true);
  layout(H.layoutPaper, 'Layout1', 1, psRec.handle, false);

  // ---- Sections ----------------------------------------------------------------------------------

  const header = writeHeader();
  const classes = writeClasses();
  const aux = writeAuxHeader();
  const preview = writePreview();

  const objStart = 0x61 + aux.length + preview.length + header.length + classes.length;
  objects.sort((a, b) => a.handle - b.handle);
  const objParts: Uint8Array[] = [];
  const map: [number, number][] = [];
  let off = 0;
  for (const o of objects) {
    const size = modularShort(o.bytes.length);
    const chunk = new Uint8Array(size.length + o.bytes.length + 2);
    chunk.set(size, 0);
    chunk.set(o.bytes, size.length);
    const crc = crc16(0xc0c1, chunk, 0, size.length + o.bytes.length);
    chunk[chunk.length - 2] = crc & 0xff;
    chunk[chunk.length - 1] = crc >> 8;
    map.push([o.handle, objStart + off]);
    objParts.push(chunk);
    off += chunk.length;
  }
  const objectsBytes = concat(objParts);
  const handles = writeHandleMap(map);
  const freeSpace = writeObjFreeSpace(objects.length);
  const template = new Uint8Array([0, 0, d.header.measurement & 0xff, 0]);

  // File header, with the section locators.
  const at = {
    aux: 0x61,
    preview: 0x61 + aux.length,
    header: 0x61 + aux.length + preview.length,
    classes: 0x61 + aux.length + preview.length + header.length,
    handles: objStart + objectsBytes.length,
  };
  const freeAt = at.handles + handles.length;
  const templateAt = freeAt + freeSpace.length;
  const fh = new BitWriter();
  for (const c of 'AC1015') fh.byte(c.charCodeAt(0));
  for (const b of [0, 0, 0, 0, 0, 15, 1]) fh.byte(b);
  fh.rl(at.preview);
  fh.byte(0x1b);
  fh.byte(0x19);
  fh.rs(CODEPAGE_INDEX[d.header.codepage] ?? 30);
  fh.rl(6);
  const rec = (n: number, addr: number, size: number) => {
    fh.byte(n);
    fh.rl(addr);
    fh.rl(size);
  };
  rec(0, at.header, header.length);
  rec(1, at.classes, classes.length);
  rec(2, at.handles, handles.length);
  rec(3, freeAt, freeSpace.length);
  rec(4, templateAt, template.length);
  rec(5, at.aux, aux.length);
  fh.rs(crc16(0xc0c1, fh.bytes));
  for (const b of SENTINEL.fileHeaderEnd) fh.byte(b);

  return concat([fh.bytes, aux, preview, header, classes, objectsBytes, handles, freeSpace, template]);

  // ---- Section writers ---------------------------------------------------------------------------

  function section(start: number[], body: Uint8Array, end: number[]): Uint8Array {
    const w = new BitWriter();
    for (const b of start) w.byte(b);
    const sizeAt = w.length;
    w.rl(body.length);
    w.raw(body);
    w.rs(crc16(0xc0c1, w.bytes, sizeAt));
    for (const b of end) w.byte(b);
    return w.bytes.slice();
  }

  function writeClasses(): Uint8Array {
    const w = new BitWriter();
    for (const c of CLASSES) {
      w.bs(c.num);
      w.bs(c.flags);
      tv(w, c.app);
      tv(w, c.cpp);
      tv(w, c.dxf);
      w.bit(0);
      w.bs(c.entity ? 0x1f2 : 0x1f3);
    }
    w.align();
    return section(SENTINEL.classesStart, w.bytes.slice(), SENTINEL.classesEnd);
  }

  function writeHeader(): Uint8Array {
    const hd = d.header;
    const ds0 = dimstyles.find((s) => upper(s.name) === upper(hd.dimstyle)) ?? dimstyles[0];
    const w = new BitWriter();
    const hw = w;
    const hp = (h: number) => hw.h(HARD_POINTER, h);
    w.bd(412148564080.0);
    w.bd(1);
    w.bd(1);
    w.bd(1);
    tv(w, 'm');
    tv(w, '');
    tv(w, '');
    tv(w, '');
    w.bl(24);
    w.bl(0);
    hp(0);
    w.bit(1); // DIMASO
    w.bit(1); // DIMSHO
    w.bit(0); // PLINEGEN
    w.bit(0); // ORTHOMODE
    w.bit(1); // REGENMODE
    w.bit(hd.fillmode); // FILLMODE
    w.bit(0); // QTEXTMODE
    w.bit(1); // PSLTSCALE
    w.bit(0); // LIMCHECK
    w.bit(1); // USRTIMER
    w.bit(0); // SKPOLY
    w.bit(hd.angdir); // ANGDIR
    w.bit(0); // SPLFRAME
    w.bit(0); // MIRRTEXT
    w.bit(1); // WORLDVIEW
    w.bit(1); // TILEMODE
    w.bit(0); // PLIMCHECK
    w.bit(1); // VISRETAIN
    w.bit(0); // DISPSILH
    w.bit(0); // PELLIPSE
    w.bs(1); // PROXYGRAPHICS
    w.bs(3020); // TREEDEPTH
    w.bs(hd.lunits);
    w.bs(hd.luprec);
    w.bs(hd.aunits);
    w.bs(hd.auprec);
    w.bs(1); // ATTMODE
    w.bs(hd.pdmode);
    for (let i = 0; i < 5; i++) w.bs(0); // USERI1-5
    w.bs(8); // SPLINESEGS
    w.bs(6); // SURFU
    w.bs(6); // SURFV
    w.bs(6); // SURFTYPE
    w.bs(6); // SURFTAB1
    w.bs(6); // SURFTAB2
    w.bs(6); // SPLINETYPE
    w.bs(3); // SHADEDGE
    w.bs(70); // SHADEDIF
    w.bs(0); // UNITMODE
    w.bs(64); // MAXACTVP
    w.bs(4); // ISOLINES
    w.bs(0); // CMLJUST
    w.bs(50); // TEXTQLTY
    w.bd(hd.ltscale || 1);
    w.bd(hd.textsize || 0.2);
    w.bd(0.05); // TRACEWID
    w.bd(0.1); // SKETCHINC
    w.bd(hd.filletrad);
    w.bd(0); // THICKNESS
    w.bd(hd.angbase);
    w.bd(hd.pdsize);
    w.bd(0); // PLINEWID
    for (let i = 0; i < 5; i++) w.bd(0); // USERR1-5
    w.bd(hd.chamfera);
    w.bd(hd.chamferb);
    w.bd(0); // CHAMFERC
    w.bd(0); // CHAMFERD
    w.bd(0.5); // FACETRES
    w.bd(1); // CMLSCALE
    w.bd(hd.celtscale || 1);
    tv(w, 'acad');
    const days = Math.floor(hd.tdcreate);
    w.bl(days);
    w.bl(Math.round((hd.tdcreate - days) * 86400000));
    const now = opts.now;
    const nd = Math.floor(now);
    w.bl(nd);
    w.bl(Math.round((now - nd) * 86400000));
    w.bl(0); // TDINDWG
    w.bl(0);
    w.bl(0); // TDUSRTIMER
    w.bl(0);
    w.cmc(BYLAYER); // CECOLOR
    w.h(0, handseed);
    hp(la(hd.clayer));
    hp(st(hd.textstyle));
    hp(byLayer);
    hp(ds(hd.dimstyle));
    hp(H.mlineStandard);
    w.bd(0); // PSVPSCALE
    // Paper space.
    w.bd3(0, 0, 0);
    w.bd3(1e20, 1e20, 1e20);
    w.bd3(-1e20, -1e20, -1e20);
    w.rd2({ x: 0, y: 0 });
    w.rd2(metric ? { x: 420, y: 297 } : { x: 12, y: 9 });
    w.bd(0);
    w.bd3(0, 0, 0);
    w.bd3(1, 0, 0);
    w.bd3(0, 1, 0);
    hp(0);
    hp(0); // PUCSORTHOREF
    w.bs(0);
    hp(0); // PUCSBASE
    for (let i = 0; i < 6; i++) w.bd3(0, 0, 0);
    // Model space.
    w.bd3(0, 0, 0);
    w.bd3(ext ? ext.min.x : 1e20, ext ? ext.min.y : 1e20, ext ? 0 : 1e20);
    w.bd3(ext ? ext.max.x : -1e20, ext ? ext.max.y : -1e20, ext ? 0 : -1e20);
    w.rd2(hd.limmin);
    w.rd2(hd.limmax);
    w.bd(0);
    w.bd3(0, 0, 0);
    w.bd3(1, 0, 0);
    w.bd3(0, 1, 0);
    hp(0);
    hp(0); // UCSORTHOREF
    w.bs(0);
    hp(0); // UCSBASE
    for (let i = 0; i < 6; i++) w.bd3(0, 0, 0);
    tv(w, ds0.dimpost);
    tv(w, '');
    // Dimension variables, from the current style.
    w.bd(ds0.dimscale);
    w.bd(ds0.dimasz);
    w.bd(ds0.dimexo);
    w.bd(metric ? 3.75 : 0.38);
    w.bd(ds0.dimexe);
    w.bd(ds0.dimrnd);
    w.bd(ds0.dimdle);
    w.bd(0);
    w.bd(0);
    w.bit(0); // DIMTOL
    w.bit(0); // DIMLIM
    w.bit(ds0.dimtih);
    w.bit(ds0.dimtoh);
    w.bit(ds0.dimse1);
    w.bit(ds0.dimse2);
    w.bs(ds0.dimtad);
    w.bs(ds0.dimzin);
    w.bs(0); // DIMAZIN
    w.bd(ds0.dimtxt);
    w.bd(ds0.dimcen);
    w.bd(ds0.dimtsz);
    w.bd(25.4); // DIMALTF
    w.bd(ds0.dimlfac);
    w.bd(0); // DIMTVP
    w.bd(1); // DIMTFAC
    w.bd(ds0.dimgap);
    w.bd(0); // DIMALTRND
    w.bit(0); // DIMALT
    w.bs(2); // DIMALTD
    w.bit(ds0.dimtofl);
    w.bit(0); // DIMSAH
    w.bit(ds0.dimtix);
    w.bit(ds0.dimsoxd);
    w.cmc(aciOf(ds0.dimclrd));
    w.cmc(aciOf(ds0.dimclre));
    w.cmc(aciOf(ds0.dimclrt));
    w.bs(ds0.dimadec);
    w.bs(ds0.dimdec);
    w.bs(ds0.dimdec); // DIMTDEC
    w.bs(2); // DIMALTU
    w.bs(2); // DIMALTTD
    w.bs(0); // DIMAUNIT
    w.bs(0); // DIMFRAC
    w.bs(ds0.dimlunit);
    w.bs(ds0.dimdsep);
    w.bs(0); // DIMTMOVE
    w.bs(ds0.dimjust);
    w.bit(ds0.dimsd1);
    w.bit(ds0.dimsd2);
    w.bs(1); // DIMTOLJ
    w.bs(0); // DIMTZIN
    w.bs(0); // DIMALTZ
    w.bs(0); // DIMALTTZ
    w.bit(0); // DIMUPT
    w.bs(ds0.dimatfit);
    hp(st(ds0.dimtxsty));
    hp(0); // DIMLDRBLK
    hp(blk(ds0.dimblk));
    hp(0);
    hp(0);
    w.bs(ds0.dimlwd);
    w.bs(ds0.dimlwe);
    const ho = (h: number) => w.h(HARD_OWNER, h);
    ho(H.blockCtl);
    ho(H.layerCtl);
    ho(H.styleCtl);
    ho(H.ltypeCtl);
    ho(H.viewCtl);
    ho(H.ucsCtl);
    ho(H.vportCtl);
    ho(H.appidCtl);
    ho(H.dimstyleCtl);
    ho(H.vxCtl);
    hp(H.groupDict);
    hp(H.mlineDict);
    ho(H.root);
    w.bs(1); // TSTACKALIGN
    w.bs(70); // TSTACKSIZE
    tv(w, ''); // HYPERLINKBASE
    tv(w, ''); // STYLESHEET
    hp(H.layoutDict);
    hp(H.plotSettingsDict);
    hp(H.plotStyleDict);
    // CELWEIGHT ByLayer, LWDISPLAY (the bit is set when off), EXTNAMES.
    let flags = 29;
    if (!hd.lwdisplay) flags |= 0x200;
    flags |= 0x800;
    w.bl(flags);
    w.bs(hd.insunits);
    w.bs(0); // CEPSNTYPE
    tv(w, guid());
    tv(w, guid());
    hp(psRec.handle);
    hp(msRec.handle);
    hp(byLayer);
    hp(byBlock);
    hp(lt(CONTINUOUS));
    w.bs(-1);
    w.bs(-1);
    w.bs(-1);
    w.bs(-1);
    w.align();
    return section(SENTINEL.headerStart, w.bytes.slice(), SENTINEL.headerEnd);
  }

  function writeAuxHeader(): Uint8Array {
    const w = new BitWriter();
    w.byte(0xff);
    w.byte(0x77);
    w.byte(0x01);
    w.rs(23);
    w.rs(6);
    w.rl(1);
    w.rl(-1);
    w.rs(1);
    w.rs(0);
    w.rl(0);
    w.rs(23);
    w.rs(6);
    w.rs(23);
    w.rs(6);
    for (const v of [5, 0x893, 5, 0x893, 0, 1]) w.rs(v);
    for (let i = 0; i < 5; i++) w.rl(0);
    const date = (j: number) => {
      const days = Math.floor(j);
      w.rl(days);
      w.rl(Math.round((j - days) * 86400000));
    };
    date(d.header.tdcreate);
    date(opts.now);
    w.rl(handseed);
    w.rl(0);
    w.rs(0);
    w.rs(1);
    w.rl(0);
    w.rl(0);
    w.rl(0);
    w.rl(1);
    w.rl(0);
    w.rl(0);
    w.rl(0);
    w.rl(0);
    return w.bytes.slice();
  }

  function writePreview(): Uint8Array {
    const w = new BitWriter();
    for (const b of SENTINEL.previewStart) w.byte(b);
    w.rl(1);
    w.byte(0);
    for (const b of SENTINEL.previewEnd) w.byte(b);
    return w.bytes.slice();
  }

  function writeObjFreeSpace(count: number): Uint8Array {
    const w = new BitWriter();
    w.rl(0);
    w.rl(count);
    const days = Math.floor(opts.now);
    w.rl(days);
    w.rl(Math.round((opts.now - days) * 86400000));
    w.rl(0);
    w.byte(4);
    for (const v of [0x32, 0, 0x64, 0, 0x200, 0, 0xffffffff, 0]) w.rl(v);
    return w.bytes.slice();
  }
}

/** The handle map: pages of (handle delta, offset delta) pairs, each page at most 2032 bytes with a big-endian size and CRC. */
function writeHandleMap(map: [number, number][]): Uint8Array {
  const out: number[] = [];
  let pageStart = 0;
  let lastH = 0;
  let lastLoc = 0;
  const startPage = () => {
    pageStart = out.length;
    out.push(0, 0);
    lastH = 0;
    lastLoc = 0;
  };
  const endPage = () => {
    const size = out.length - pageStart;
    out[pageStart] = size >> 8;
    out[pageStart + 1] = size & 0xff;
    const crc = crc16(0xc0c1, Uint8Array.from(out.slice(pageStart)));
    out.push(crc >> 8, crc & 0xff);
  };
  startPage();
  for (const [h, loc] of map) {
    let a = unsignedModularChar(h - lastH);
    let b = modularChar(loc - lastLoc);
    if (out.length - pageStart + a.length + b.length > 2032) {
      endPage();
      startPage();
      a = unsignedModularChar(h);
      b = modularChar(loc);
    }
    out.push(...a, ...b);
    lastH = h;
    lastLoc = loc;
  }
  endPage();
  startPage();
  endPage();
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function guid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}
