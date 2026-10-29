import type { Cfb } from '@/lib/cfb';
import { blocks, Bytes, children, chunk, CONTAINER, EMPTY, find, SEQNUM } from './blocks';
import type { PubDoc, PubFill, PubImage, PubLine, PubPage, PubShape, PubTable } from './doc';
import { fixed, kidsOf, readBlip, readFopt, readPairs, records, T, type Props, type Rec } from './escher';
import { readQuill } from './quill';
import { freeform, preset } from './shapes';
import { storyParas, type Colors } from './text';

/**
 * Publisher 2002 and later (through 365). The Contents stream holds the
 * document as chunks listed in a trailer: the document (page size, page
 * order), pages (which shapes are on them, masters), shapes (text ids,
 * tables) and the color scheme. Shapes themselves are Office Art in
 * Escher/EscherStm, with their pictures in Escher/EscherDelayStm; text is
 * in the Quill stream.
 */

const EMU = 12700;

const CHUNK = { SHAPE: 0x01, ALTSHAPE: 0x20, DOCUMENT: 0x44, PAGE: 0x43, PALETTE: 0x5c, GROUP: 0x30, LOGO: 0x31, TABLE: 0x10, CELLS: 0x63 } as const;

/** Page sequence numbers Publisher uses for its own bookkeeping pages, not the document's. */
const DUMMY_PAGES = new Set([0x10d, 0x110, 0x113, 0x117]);

interface ChunkRef {
  type: number;
  at: number;
  seq: number;
}

interface ShapeInfo {
  textId?: number;
  /** Its place among text boxes linked together. */
  link?: number;
  /** Shapes its text wraps around. */
  wrapsAround?: number[];
  valign?: number;
  crop?: number;
  table?: { rows: number; cols: number; cells: number; sizes: number[] };
}

interface EscherShape {
  seq: number | null;
  type: number;
  flags: number;
  props: Props;
  tertiary: Props | null;
  /** Its box in page EMUs from the page center. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  children: EscherShape[] | null;
}

export function read2002(cfb: Cfb, warnings: Set<string>): PubDoc {
  const contents = cfb.stream('Contents');
  const quillData = cfb.stream('Quill/QuillSub/CONTENTS');
  const escherData = cfb.stream('Escher/EscherStm');
  if (!contents || !quillData || !escherData) throw new Error('Parts of it are missing (it may be damaged).');
  const s = new Bytes(contents);

  // The trailer lists every chunk; its position in the list is its sequence number.
  const trailer = s.u32(0x1a);
  const dir = blocks(s, trailer + 4, trailer + s.u32(trailer)).find((b) => b.type === 0x90);
  if (!dir) throw new Error('Its table of contents is missing (it may be damaged).');
  const refs: ChunkRef[] = [];
  const bySeq = new Map<number, ChunkRef>();
  children(s, dir).forEach((b, seq) => {
    if (b.type !== CONTAINER) return;
    const kids = children(s, b);
    const type = find(kids, 0x02);
    const at = find(kids, 0x04);
    if (!type || !at) return;
    const r = { type: type.value, at: at.value, seq };
    refs.push(r);
    bySeq.set(seq, r);
  });

  // The document: page size and the order of pages.
  const docRef = refs.find((r) => r.type === CHUNK.DOCUMENT);
  if (!docRef) throw new Error('It has no document settings (it may be damaged).');
  let width = 612;
  let height = 792;
  const pageOrder: number[] = [];
  for (const b of chunk(s, docRef.at)) {
    if (b.id === 0x12) {
      const kids = children(s, b);
      width = (find(kids, 0x01)?.value ?? width * EMU) / EMU;
      height = (find(kids, 0x02)?.value ?? height * EMU) / EMU;
    } else if (b.id === 0x02) {
      for (const p of children(s, b)) if (p.id === 0) pageOrder.push(p.value);
    }
  }

  // The color scheme: what "scheme color n" means. Fewer than 8 entries start with black.
  const palette: string[] = [];
  for (const r of refs.filter((x) => x.type === CHUNK.PALETTE)) {
    for (const b of chunk(s, r.at)) {
      if (b.type !== 0xa0) continue;
      for (const e of children(s, b)) {
        if (e.type === CONTAINER) {
          const c = find(children(s, e), 0x01);
          palette.push(c ? rgb(c.value) : '#000000');
        } else if (e.type === EMPTY) palette.push('#000000');
      }
    }
  }
  if (palette.length < 8) palette.unshift('#000000');
  const color: Colors = (c, base) => resolveColor(c, palette, base);

  // Pages: the shapes on each, which are masters, and which master each uses.
  interface PageInfo { seq: number; shapes: number[]; bg: number | null; isMaster: boolean; master: number | null }
  const pages = new Map<number, PageInfo>();
  for (const r of refs.filter((x) => x.type === CHUNK.PAGE)) {
    const info: PageInfo = { seq: r.seq, shapes: [], bg: null, isMaster: false, master: null };
    for (const b of chunk(s, r.at)) {
      if (b.id === 0x0a) info.bg = b.value;
      else if (b.id === 0x02) {
        for (const c of children(s, b)) if (c.type === SEQNUM) info.shapes.push(c.value);
      } else if (b.id === 0x0e) info.isMaster = s.slice(b.dataAt + 4, b.dataLength - 4).some((x) => x !== 0);
      else if (b.id === 0x0d) info.master = b.value;
    }
    pages.set(r.seq, info);
  }

  // Shapes' Contents side: text ids, vertical alignment, tables.
  const shapeInfo = new Map<number, ShapeInfo>();
  for (const r of refs) {
    if (r.type !== CHUNK.SHAPE && r.type !== CHUNK.ALTSHAPE && r.type !== CHUNK.GROUP && r.type !== CHUNK.LOGO && r.type !== CHUNK.TABLE) continue;
    const info: ShapeInfo = {};
    const list = chunk(s, r.at);
    for (const b of list) {
      if (b.id === 0x27) info.textId = b.value;
      else if (b.id === 0x28) info.link = b.value;
      else if (b.id === 0x47) info.wrapsAround = children(s, b).filter((c) => c.id === 0).map((c) => c.value);
      else if (b.id === 0x35) info.valign = b.value;
      else if (b.id === 0xb7 && b.value) info.crop = b.value;
    }
    if (r.type === CHUNK.TABLE) {
      const rows = find(list, 0x66)?.value ?? 0;
      const cols = find(list, 0x67)?.value ?? 0;
      const cells = find(list, 0x6b)?.value;
      const arr = find(list, 0x6d);
      if (rows && cols && cells !== undefined && arr) {
        const sizes: number[] = [];
        for (const e of children(s, arr)) if (e.id === 0) for (const z of children(s, e)) if (z.id === 0x02) sizes.push(z.value);
        info.table = { rows, cols, cells, sizes };
      }
    }
    shapeInfo.set(r.seq, info);
  }

  const quill = readQuill(quillData);

  // Pictures: the BLIP store's entries, in order (shapes refer to them from 1), with data in the delay stream.
  const images: PubImage[] = [];
  const blipIndex: number[] = [];
  const es = new Bytes(escherData);
  const delay = cfb.stream('Escher/EscherDelayStm');
  const ds = delay ? new Bytes(delay) : null;
  const top = records(es, 0, es.length);
  const dgg = top.find((r) => r.type === T.DGG);
  const bstore = dgg && kidsOf(es, dgg).find((r) => r.type === T.BSTORE);
  if (bstore) {
    for (const bse of kidsOf(es, bstore)) {
      if (bse.type !== T.BSE) {
        blipIndex.push(-1);
        continue;
      }
      const size = es.u32(bse.at + 20);
      const foDelay = es.u32(bse.at + 28);
      const nameLen = es.u8(bse.at + 33);
      let img: PubImage | null = null;
      if (bse.len > 36 + nameLen) {
        const inner = records(es, bse.at + 36 + nameLen, bse.at + bse.len)[0];
        if (inner) img = readBlip(es, inner);
      } else if (ds && size && foDelay < ds.length) {
        const inner = records(ds, foDelay, foDelay + size + 8)[0];
        if (inner) img = readBlip(ds, inner);
      }
      if (img) {
        blipIndex.push(images.length);
        images.push(img);
      } else blipIndex.push(-1);
    }
  }

  // Shapes: every drawing's group tree.
  const escher = new Map<number, EscherShape>();
  const tops: EscherShape[] = [];
  const readSp = (sp: Rec, parent: { cs: Box; abs: Box } | null): { shape: EscherShape; cs: Box | null } => {
    const kids = kidsOf(es, sp);
    const fsp = kids.find((r) => r.type === T.FSP);
    const fopt = kids.find((r) => r.type === T.FOPT);
    const tert = kids.find((r) => r.type === T.TERTIARY_FOPT);
    const data = kids.find((r) => r.type === T.CLIENT_DATA);
    const anchor = kids.find((r) => r.type === T.CLIENT_ANCHOR);
    const child = kids.find((r) => r.type === T.CHILD_ANCHOR);
    const fspgr = kids.find((r) => r.type === T.FSPGR);
    const props = fopt ? readFopt(es, fopt) : { v: new Map(), c: new Map() };
    const seq = data ? (readPairs(es, data).get(0x6801) ?? null) : null;
    let box: Box | null = null;
    if (anchor) {
      const a = readPairs(es, anchor);
      box = order({ x0: a.get(0x2001) ?? 0, y0: a.get(0x2002) ?? 0, x1: a.get(0x2003) ?? 0, y1: a.get(0x2004) ?? 0 }, true);
    } else if (child && parent) {
      const c = order({ x0: es.i32(child.at), y0: es.i32(child.at + 4), x1: es.i32(child.at + 8), y1: es.i32(child.at + 12) }, false);
      const sx = (parent.abs.x1 - parent.abs.x0) / (parent.cs.x1 - parent.cs.x0 || 1);
      const sy = (parent.abs.y1 - parent.abs.y0) / (parent.cs.y1 - parent.cs.y0 || 1);
      box = {
        x0: (c.x0 - parent.cs.x0) * sx + parent.abs.x0,
        y0: (c.y0 - parent.cs.y0) * sy + parent.abs.y0,
        x1: (c.x1 - parent.cs.x0) * sx + parent.abs.x0,
        y1: (c.y1 - parent.cs.y0) * sy + parent.abs.y0,
      };
    }
    // Shapes turned near 90° keep the box of their turned outline.
    const rot = ((fixed(props.v.get(0x0004) ?? 0) % 360) + 360) % 360;
    if (box && ((rot >= 45 && rot < 135) || (rot >= 225 && rot < 315))) {
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      box = { x0: cx - h / 2, y0: cy - w / 2, x1: cx + h / 2, y1: cy + w / 2 };
    }
    const shape: EscherShape = {
      seq,
      type: fsp ? fsp.inst : 1,
      flags: fsp ? es.u32(fsp.at + 4) : 0,
      props,
      tertiary: tert ? readFopt(es, tert) : null,
      box,
      children: null,
    };
    const cs = fspgr ? order({ x0: es.i32(fspgr.at), y0: es.i32(fspgr.at + 4), x1: es.i32(fspgr.at + 8), y1: es.i32(fspgr.at + 12) }, false) : null;
    return { shape, cs };
  };
  const readGroup = (spgr: Rec, parent: { cs: Box; abs: Box } | null, depth: number): EscherShape | null => {
    if (depth > 50) return null;
    const kids = kidsOf(es, spgr).filter((r) => r.type === T.SP || r.type === T.SPGR);
    if (!kids.length || kids[0].type !== T.SP) return null;
    const { shape: leader, cs } = readSp(kids[0], parent);
    leader.children = [];
    const inner = cs && leader.box ? { cs, abs: leader.box } : parent;
    for (const k of kids.slice(1)) {
      const sh = k.type === T.SPGR ? readGroup(k, inner, depth + 1) : readSp(k, inner).shape;
      if (!sh) continue;
      if (sh.seq !== null) escher.set(sh.seq, sh);
      leader.children.push(sh);
    }
    return leader;
  };
  for (const dg of top.filter((r) => r.type === T.DG)) {
    for (const spgr of kidsOf(es, dg).filter((r) => r.type === T.SPGR)) {
      // The drawing's own group: its first shape is the patriarch, the rest are the page's shapes.
      const g = readGroup(spgr, null, 0);
      for (const sh of g?.children ?? []) tops.push(sh);
    }
  }
  if (escher.size === 0 && !tops.length) warnings.add('It has no shapes Publisher could find.');
  for (const sh of tops) if (sh.seq !== null) escher.set(sh.seq, sh);

  const wrapped = new Set<number>();
  for (const info of shapeInfo.values()) for (const w of info.wrapsAround ?? []) wrapped.add(w);
  const ctx: Ctx = { width, height, color, images, blipIndex, shapeInfo, quill, warnings, bySeq, s, wrapped };

  // The document: masters first (pages point at them), then pages in order.
  const doc: PubDoc = { width, height, pages: [], masters: [], stories: new Map(), images, warnings, version: 'Publisher 2002 or later' };
  const masterIndex = new Map<number, number>();
  const pageShapes = (info: PageInfo): PubShape[] => {
    const on = new Set(info.shapes);
    const out: PubShape[] = [];
    for (const sh of tops) if (sh.seq !== null && on.has(sh.seq)) {
      const p = toShape(sh, ctx, doc);
      if (p) out.push(p);
    }
    return out;
  };
  const background = (info: PageInfo): PubFill | null => {
    const bg = info.bg !== null ? escher.get(info.bg) : undefined;
    return bg ? fillOf(bg.props, ctx) : null;
  };
  for (const info of pages.values()) {
    if (!info.isMaster) continue;
    masterIndex.set(info.seq, doc.masters.length);
    doc.masters.push({ shapes: pageShapes(info), background: background(info), master: null });
  }
  const order2 = pageOrder.length ? pageOrder : [...pages.keys()];
  for (const seq of order2) {
    const info = pages.get(seq);
    if (!info || info.isMaster || DUMMY_PAGES.has(seq)) continue;
    const page: PubPage = { shapes: pageShapes(info), background: background(info), master: info.master !== null ? (masterIndex.get(info.master) ?? null) : null };
    doc.pages.push(page);
  }
  // Pages after the last with anything on them are Publisher's spares.
  while (doc.pages.length > 1 && !doc.pages[doc.pages.length - 1].shapes.length) doc.pages.pop();
  if (!doc.pages.length) doc.pages.push({ shapes: [], master: doc.masters.length ? 0 : null });

  for (const [id] of quill.stories) if (!doc.stories.has(id)) doc.stories.set(id, storyParas(quill, id, color));
  return doc;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function order(b: Box, signed: boolean): Box {
  const f = (v: number) => (signed ? v | 0 : v);
  const x0 = f(b.x0);
  const x1 = f(b.x1);
  const y0 = f(b.y0);
  const y1 = f(b.y1);
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}

interface Ctx {
  width: number;
  height: number;
  color: Colors;
  images: PubImage[];
  blipIndex: number[];
  shapeInfo: Map<number, ShapeInfo>;
  quill: ReturnType<typeof readQuill>;
  warnings: Set<string>;
  bySeq: Map<number, ChunkRef>;
  s: Bytes;
  /** Shapes some text box wraps its text around. */
  wrapped: Set<number>;
}

export const rgb = (c: number) => `#${[c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * An Office Art color: plain RGB, a scheme color (the document's palette),
 * or a lighter or darker version of another color (as gradients' second
 * colors are).
 */
export function resolveColor(c: number, palette: string[], base?: number): string {
  const flags = (c >>> 24) & 0xff;
  if (flags & 0x08) return palette[c & 0xffffff] ?? '#000000';
  if (flags & 0x10) {
    if (base === undefined || base === c) return rgb(c);
    const b = hex(resolveColor(base, palette));
    const how = (c >> 8) & 0xff;
    const k = ((c >> 16) & 0xff) / 255;
    if (how === 1) return toHex(b.map((v) => v * k));
    if (how === 2) return toHex(b.map((v) => v + (255 - v) * (1 - k)));
    return toHex(b);
  }
  return rgb(c);
}

const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const toHex = (v: number[]) => `#${v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;

/** Whether a line's on, from its boolean properties (and the geometry's). */
function lineOn(flags: number | undefined, geom?: number): boolean {
  if (flags === undefined) return false;
  if (flags & (1 << 19) && !(flags & (1 << 3))) return false;
  if (geom !== undefined && geom & (1 << 12) && !(geom & (1 << 28))) return false;
  return true;
}

function dashOf(v: number | undefined): PubLine['dash'] {
  if (!v) return undefined;
  if (v === 2 || v === 6) return 'dot';
  if (v === 3 || v === 8 || v === 9) return 'dashdot';
  return 'dash';
}

function fillOf(p: Props, ctx: Ctx): PubFill | null {
  const v = p.v;
  const type = v.get(0x0180) ?? 0;
  const opacity = v.has(0x0182) ? (v.get(0x0182)! / 0x10000) : 1;
  const bool = v.get(0x01bf);
  if (type === 0) {
    const c = v.get(0x0181);
    if (c === undefined || (bool !== undefined && (bool & 0xf0) === 0)) return null;
    return { type: 'solid', color: ctx.color(c), opacity: Math.min(1, opacity) };
  }
  if (type >= 4 && type <= 7) {
    const c1 = v.get(0x0181) ?? 0xffffff;
    const c2 = v.get(0x0183) ?? 0xffffff;
    const angle = (v.get(0x018b) ?? 0) >> 16;
    const focus = ((v.get(0x018c) ?? 0) << 16) >> 16;
    const a = ctx.color(c1);
    const b = ctx.color(c2, c1);
    const op2 = v.has(0x0184) ? v.get(0x0184)! / 0x10000 : 1;
    let stops = [{ color: a, at: 0, opacity }, { color: b, at: 100, opacity: op2 }];
    if (focus === 100 || focus === -100) stops = [{ color: b, at: 0, opacity: op2 }, { color: a, at: 100, opacity }];
    else if (focus > 0) stops = [{ color: b, at: 0, opacity: op2 }, { color: a, at: focus, opacity }, { color: b, at: 100, opacity: op2 }];
    else if (focus < 0) stops = [{ color: a, at: 0, opacity }, { color: b, at: 100 + focus, opacity: op2 }, { color: a, at: 100, opacity }];
    // Office measures fill angles counterclockwise from the bottom.
    return { type: 'gradient', stops, angle: (((-angle - 90) % 360) + 360) % 360, radial: type === 5 || type === 6 };
  }
  if (type === 2 || type === 3) {
    const px = v.get(0x4186);
    const idx = px ? ctx.blipIndex[px - 1] : undefined;
    if (idx !== undefined && idx >= 0) return { type: 'picture', image: idx };
    return null;
  }
  if (type === 1) {
    // Patterns: drawn as their foreground color.
    const c = v.get(0x0181);
    ctx.warnings.add('Pattern fills are shown as solid colors.');
    return c === undefined ? null : { type: 'solid', color: ctx.color(c), opacity };
  }
  return null;
}

/** How far text keeps from a shape it wraps around (nothing, for shapes no text wraps around). */
function wrapOf(sh: EscherShape, ctx: Ctx): PubShape['wrap'] {
  if (sh.seq === null || !ctx.wrapped.has(sh.seq)) return undefined;
  const d = (id: number) => (sh.props.v.get(id) ?? 36576) / EMU;
  return [d(0x0385), d(0x0384), d(0x0387), d(0x0386)];
}

function toShape(sh: EscherShape, ctx: Ctx, doc: PubDoc): PubShape | null {
  if (!sh.box) return null;
  const v = sh.props.v;
  const box = {
    x: ctx.width / 2 + sh.box.x0 / EMU,
    y: ctx.height / 2 + sh.box.y0 / EMU,
    w: (sh.box.x1 - sh.box.x0) / EMU,
    h: (sh.box.y1 - sh.box.y0) / EMU,
  };
  const base = {
    ...box,
    rotation: ((fixed(v.get(0x0004) ?? 0) % 360) + 360) % 360,
    flipH: !!(sh.flags & 0x40),
    flipV: !!(sh.flags & 0x80),
  };
  if (sh.children) {
    const kids = sh.children.map((c) => toShape(c, ctx, doc)).filter((c): c is PubShape => !!c);
    if (!kids.length) return null;
    return { ...base, kind: 'group', rotation: 0, flipH: false, flipV: false, children: kids, wrap: wrapOf(sh, ctx) };
  }
  const info = (sh.seq !== null ? ctx.shapeInfo.get(sh.seq) : undefined) ?? {};
  const out: PubShape = { ...base, kind: 'rect', wrap: wrapOf(sh, ctx) };

  // Outline.
  const adj = (i: number, d: number) => (v.has(0x0147 + i) ? v.get(0x0147 + i)! | 0 : d);
  const type = info.crop ?? sh.type;
  const verts = sh.props.c.get(0xc145);
  const pr = preset(type, adj);
  if (verts && verts.length > 6 && (!pr || type === 0)) {
    const vs = new Bytes(verts);
    const n = vs.u16(0);
    let el = vs.u16(4);
    if (el === 0xfff0) el = 4;
    const pts = [];
    for (let i = 0; i < n && 6 + i * el + el <= vs.length; i++) {
      const o = 6 + i * el;
      pts.push(el === 8 ? { x: vs.i32(o), y: vs.i32(o + 4) } : el === 4 ? { x: vs.i16(o), y: vs.i16(o + 2) } : { x: vs.u8(o), y: vs.u8(o + 1) });
    }
    const sg = sh.props.c.get(0xc146);
    const segs: number[] = [];
    if (sg && sg.length > 6) {
      const ss = new Bytes(sg);
      const m = ss.u16(0);
      for (let i = 0; i < m && 6 + i * 2 + 2 <= ss.length; i++) segs.push(ss.u16(6 + i * 2));
    }
    const paths = freeform(pts, segs, v.get(0x0142) ?? 21600, v.get(0x0143) ?? 21600, true);
    if (paths.length) {
      out.kind = 'path';
      out.paths = paths;
    }
  } else if (pr) {
    if (pr.kind === 'ellipse') out.kind = 'ellipse';
    else if (pr.kind === 'line') out.kind = 'line';
    else if (pr.kind === 'round') out.corner = pr.radius * Math.min(box.w, box.h);
    else if (pr.kind === 'path') {
      out.kind = 'path';
      out.paths = pr.paths;
    }
  } else if (!(type >= 136 && type <= 175)) ctx.warnings.add('Some shapes Publisher doesn’t know yet are drawn as rectangles.');

  // Text wraps to these outlines in Publisher; their boxes would push it much too far.
  if (out.kind === 'path' || out.kind === 'line') delete out.wrap;

  // Fill and picture.
  out.fill = fillOf(sh.props, ctx);
  const px = v.get(0x4104);
  if (px) {
    const idx = ctx.blipIndex[px - 1];
    if (idx !== undefined && idx >= 0) out.image = idx;
    const crop = [0x0102, 0x0100, 0x0103, 0x0101].map((id) => fixed(v.get(id) ?? 0)) as [number, number, number, number];
    if (crop.some((c) => c)) out.crop = crop;
  }

  // Lines: one for the whole outline, or one per side (text boxes, pictures and tables).
  const geom = v.get(0x017f);
  const weight = (w: number | undefined) => (w ?? 9525) / EMU;
  if (lineOn(v.get(0x01ff), geom) && v.has(0x01c0)) {
    out.line = { color: ctx.color(v.get(0x01c0)!), width: weight(v.get(0x01cb)), dash: dashOf(v.get(0x01ce)) };
  } else if (sh.tertiary && lineOn(sh.tertiary.v.get(0x01ff))) {
    const t = sh.tertiary.v;
    const side = (c: number, w: number, f: number): PubLine | null => (t.has(c) && lineOn(t.get(f)) ? { color: ctx.color(t.get(c)!), width: weight(t.get(w)) } : null);
    const sides = [side(0x0580, 0x058b, 0x05bf), side(0x05c0, 0x05cb, 0x05ff), side(0x0600, 0x060b, 0x063f), side(0x0540, 0x054b, 0x057f)];
    const first = sides.find(Boolean) ?? null;
    if (first && sides.every((x) => x && x.color === first.color && x.width === first.width)) out.line = first;
    else if (first) out.sides = sides;
    const lf = t.get(0x057f) ?? 0;
    out.lineInside = !!(lf & (1 << 22) && (!(lf & (1 << 21)) || lf & (1 << 5)) && lf & (1 << 6));
  }
  if (out.kind === 'line') {
    const a = v.get(0x01d0);
    const b = v.get(0x01d1);
    if (a || b) out.arrows = { start: !!a, end: !!b };
  }

  // Shadow.
  const sb = v.get(0x023f);
  if (sb !== undefined && sb & (1 << 17) && sb & (1 << 1)) {
    out.shadow = {
      color: ctx.color(v.get(0x0201) ?? 0x808080),
      x: ((v.get(0x0205) ?? 0x6338) | 0) / EMU,
      y: ((v.get(0x0206) ?? 0x6338) | 0) / EMU,
      opacity: fixed(v.get(0x0204) ?? 0x10000),
    };
  }

  // Text.
  if (info.textId !== undefined) {
    const margin = (id: number) => (v.get(id) ?? 36576) / EMU;
    const t = sh.tertiary?.v;
    out.text = {
      story: info.textId,
      margins: [margin(0x0081), margin(0x0082), margin(0x0083), margin(0x0084)],
      columns: Math.max(1, t?.get(0x008c) ?? 1),
      gutter: (t?.get(0x008d) ?? 0) / EMU,
      valign: info.valign === 1 ? 'middle' : info.valign === 2 ? 'bottom' : 'top',
      link: info.link ?? 0,
      ignoreWrap: !info.wrapsAround?.length,
    };
    if (info.table) {
      const table = tableOf(info.table, info.textId, ctx);
      if (table) out.table = table;
    }
  }
  if (type >= 136 && type <= 175) {
    // WordArt: its text, set plainly in a frame.
    const g = sh.props.c.get(0xc0c0);
    ctx.warnings.add('WordArt is shown as plain text.');
    if (g) {
      const text = new Bytes(g).utf16(0, Math.floor(g.length / 2)).replace(/\0+$/, '');
      const id = -1 - doc.stories.size;
      doc.stories.set(id, [{ runs: [{ text, size: Math.max(8, Math.min(box.h * 0.6, 200)), color: out.fill && out.fill.type === 'solid' ? out.fill.color : '#000000' }], align: 'center' }]);
      out.text = { story: id, margins: [0, 0, 0, 0], columns: 1, gutter: 0, valign: 'middle', link: 0, ignoreWrap: true };
      out.fill = null;
      out.line = null;
    }
  }
  return out;
}

function tableOf(t: NonNullable<ShapeInfo['table']>, textId: number, ctx: Ctx): PubTable | null {
  const cols = t.sizes.slice(0, t.cols).map((v) => v / EMU);
  const rows = t.sizes.slice(t.cols, t.cols + t.rows).map((v) => v / EMU);
  if (cols.length !== t.cols || rows.length !== t.rows) return null;
  const ref = ctx.bySeq.get(t.cells);
  if (!ref) return null;
  const cells: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const b of chunk(ctx.s, ref.at)) {
    if (b.id !== 0x02) continue;
    for (const item of children(ctx.s, b)) {
      if (item.id !== 0) continue;
      const k = children(ctx.s, item);
      const val = (id: number) => find(k, id)?.value ?? 0;
      cells.push({ r0: val(0x01), r1: val(0x02), c0: val(0x03), c1: val(0x04) });
    }
  }
  // Each cell's paragraphs, by where the story says each cell's text ends.
  const paras = ctx.quill.stories.get(textId) ?? [];
  const ends = ctx.quill.cellEnds.get(textId) ?? [];
  const resolved = storyParas(ctx.quill, textId, ctx.color);
  const byCell: number[][] = [];
  let offset = 1;
  let first = 0;
  for (let p = 0; p < paras.length && byCell.length < ends.length; p++) {
    offset += paras[p].length;
    if (offset >= ends[byCell.length]) {
      byCell.push(Array.from({ length: p - first + 1 }, (_, i) => first + i));
      first = p + 1;
    }
  }
  return {
    rows,
    cols,
    cells: cells
      .filter((c) => c.r1 < t.rows && c.c1 < t.cols && c.r0 <= c.r1 && c.c0 <= c.c1)
      .map((c, i) => ({ row: c.r0, col: c.c0, rows: c.r1 - c.r0 + 1, cols: c.c1 - c.c0 + 1, paras: (byCell[i] ?? []).map((p) => resolved[p]).filter(Boolean) })),
  };
}

