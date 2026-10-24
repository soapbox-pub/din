import {
  maxShapeId,
  newUid,
  type Deck,
  type GroupShape,
  type Layout,
  type Para,
  type ParaProps,
  type Placeholder,
  type Run,
  type RunProps,
  type Shape,
  type Slide,
  type SpShape,
  type TextBody,
  type Xfrm,
} from './model';
import { effectiveXfrm, inheritChain } from './resolve';

/**
 * Edits to the deck as pure functions: each returns new objects for what
 * it changed and shares the rest, so history can keep every state.
 */

export function layoutOf(deck: Deck, slide: Slide): Layout | undefined {
  return deck.layouts[slide.layout] ?? Object.values(deck.layouts)[0];
}

export function masterOf(deck: Deck, slide: Slide) {
  const l = layoutOf(deck, slide);
  return l ? deck.masters[l.master] : undefined;
}

/** A shape's box on the slide, wherever it comes from. */
export function boxOf(deck: Deck, slide: Slide, shape: Shape): Xfrm | undefined {
  const layout = layoutOf(deck, slide);
  const master = layout && deck.masters[layout.master];
  if (!layout || !master) return shape.xfrm;
  return effectiveXfrm(shape, inheritChain(shape, { layout, master }));
}

const PH_NAMES: Record<string, string> = {
  title: 'Title', ctrTitle: 'Title', subTitle: 'Subtitle', body: 'Text Placeholder', obj: 'Content Placeholder', pic: 'Picture Placeholder',
  chart: 'Chart Placeholder', tbl: 'Table Placeholder', dt: 'Date Placeholder', ftr: 'Footer Placeholder', sldNum: 'Slide Number Placeholder',
};

export const emptyText = (props: ParaProps = {}): TextBody => ({ body: {}, paras: [{ props, runs: [] }] });

function placeholderFor(ph: Placeholder, id: number): SpShape {
  const p: Placeholder = { ...(ph.type ? { type: ph.type } : {}), ...(ph.idx !== undefined ? { idx: ph.idx } : {}), ...(ph.sz ? { sz: ph.sz } : {}), ...(ph.orient ? { orient: ph.orient } : {}) };
  return {
    kind: 'sp',
    uid: newUid(),
    id,
    name: `${PH_NAMES[ph.type ?? 'obj'] ?? 'Placeholder'} ${id - 1}`,
    ph: p,
    nvRaw: '<a:spLocks noGrp="1"/>',
    text: emptyText(),
  };
}

const FOOTERS = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/** A new slide with its layout's placeholders, empty. */
export function slideFromLayout(layout: Layout): Slide {
  const shapes: Shape[] = [];
  let id = 2;
  for (const s of layout.shapes) {
    if (!('ph' in s) || !s.ph || FOOTERS.has(s.ph.type ?? '')) continue;
    shapes.push(placeholderFor(s.ph, id++));
  }
  return { uid: newUid('slide'), layout: layout.part, shapes, notes: '' };
}

/**
 * Move a slide onto another layout, as PowerPoint's Layout gallery does: its
 * placeholders go to the new layout's matching ones, empty ones that don't
 * match go, ones with content stay where they were, and the new layout's
 * other placeholders arrive empty.
 */
export function changeLayout(deck: Deck, slide: Slide, layoutPart: string): Slide {
  const next = deck.layouts[layoutPart];
  const prevLayout = layoutOf(deck, slide);
  if (!next || !prevLayout) return slide;
  const master = deck.masters[prevLayout.master];
  const targets = next.shapes.filter((s): s is Shape & { ph: Placeholder } => 'ph' in s && !!s.ph && !FOOTERS.has(s.ph.type ?? ''));
  const used = new Set<Shape>();
  const isTitle = (t?: string) => t === 'title' || t === 'ctrTitle';
  const kindOf = (t?: string) => (isTitle(t) ? 'title' : t === 'pic' ? 'pic' : 'body');
  const out: Shape[] = [];
  for (const s of slide.shapes) {
    const ph = 'ph' in s ? s.ph : undefined;
    if (!ph) {
      out.push(s);
      continue;
    }
    if (FOOTERS.has(ph.type ?? '')) {
      out.push(s);
      continue;
    }
    const match =
      targets.find((t) => !used.has(t) && (t.ph.type ?? 'obj') === (ph.type ?? 'obj') && t.ph.idx === ph.idx) ??
      targets.find((t) => !used.has(t) && kindOf(t.ph.type) === kindOf(ph.type));
    const hasContent = s.kind !== 'sp' || (s.text?.paras.some((p) => p.runs.length) ?? false);
    if (match) {
      used.add(match);
      const nph: Placeholder = { ...(match.ph.type ? { type: match.ph.type } : {}), ...(match.ph.idx !== undefined ? { idx: match.ph.idx } : {}), ...(match.ph.sz ? { sz: match.ph.sz } : {}) };
      // Position follows the new layout unless the shape had been moved.
      out.push({ ...s, ph: nph } as Shape);
    } else if (hasContent) {
      const box = master ? effectiveXfrm(s, inheritChain(s, { layout: prevLayout, master })) : s.xfrm;
      out.push({ ...s, xfrm: box } as Shape);
    }
  }
  let id = maxShapeId(out) + 1;
  for (const t of targets) if (!used.has(t)) out.push(placeholderFor(t.ph, id++));
  // Titles first, as PowerPoint orders a slide's placeholders.
  out.sort((a, b) => Number(isTitle('ph' in b ? b.ph?.type : undefined)) - Number(isTitle('ph' in a ? a.ph?.type : undefined)));
  return { ...slide, layout: layoutPart, shapes: out };
}

export const textCapable = (s: Shape | undefined): boolean => !!s && s.kind === 'sp' && !s.connector;

// ---- Shapes ----------------------------------------------------------------------------

export function cloneShape(s: Shape, id: number): Shape {
  const copy = JSON.parse(JSON.stringify(s)) as Shape;
  let next = id;
  const renew = (x: Shape, top: boolean) => {
    x.uid = newUid();
    x.id = top ? id : ++next;
    if (x.kind === 'grp') x.children.forEach((c) => renew(c, false));
  };
  renew(copy, true);
  return copy;
}

export function nextId(slide: Slide): number {
  return maxShapeId(slide.shapes) + 1;
}

/** A shape anywhere on the slide, in groups too. */
export function findShape(shapes: Shape[], uid: string): Shape | undefined {
  for (const s of shapes) {
    if (s.uid === uid) return s;
    if (s.kind === 'grp') {
      const hit = findShape(s.children, uid);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function mapShapeDeep(shapes: Shape[], uid: string, fn: (s: Shape) => Shape): Shape[] {
  return shapes.map((s) => (s.uid === uid ? fn(s) : s.kind === 'grp' ? { ...s, children: mapShapeDeep(s.children, uid, fn) } : s));
}

export function withXfrm(s: Shape, xfrm: Xfrm): Shape {
  if (s.kind === 'grp') return { ...s, xfrm };
  return { ...s, xfrm } as Shape;
}

/** Rotation-aware bounds of a box. */
export function bounds(x: Xfrm): { l: number; t: number; r: number; b: number } {
  if (!x.rot || x.rot % 180 === 0) return { l: x.x, t: x.y, r: x.x + x.w, b: x.y + x.h };
  const a = (x.rot * Math.PI) / 180;
  const cx = x.x + x.w / 2;
  const cy = x.y + x.h / 2;
  const hw = (Math.abs(Math.cos(a)) * x.w + Math.abs(Math.sin(a)) * x.h) / 2;
  const hh = (Math.abs(Math.sin(a)) * x.w + Math.abs(Math.cos(a)) * x.h) / 2;
  return { l: cx - hw, t: cy - hh, r: cx + hw, b: cy + hh };
}

export function groupShapes(deck: Deck, slide: Slide, uids: Set<string>): { slide: Slide; group: GroupShape } | null {
  const members = slide.shapes.filter((s) => uids.has(s.uid));
  if (members.length < 2) return null;
  const boxes = members.map((s) => {
    const box = boxOf(deck, slide, s) ?? { x: 0, y: 0, w: 0, h: 0 };
    return { s: (s.xfrm ? s : withXfrm(s, box)) as Shape, box };
  });
  const l = Math.min(...boxes.map((b) => b.box.x));
  const t = Math.min(...boxes.map((b) => b.box.y));
  const r = Math.max(...boxes.map((b) => b.box.x + b.box.w));
  const bt = Math.max(...boxes.map((b) => b.box.y + b.box.h));
  const xfrm = { x: l, y: t, w: r - l, h: bt - t };
  const group: GroupShape = {
    kind: 'grp',
    uid: newUid(),
    id: nextId(slide),
    name: `Group ${nextId(slide) - 1}`,
    xfrm,
    ch: { ...xfrm },
    children: boxes.map((b) => b.s),
  };
  const firstIndex = slide.shapes.findIndex((s) => uids.has(s.uid));
  const lastIndex = slide.shapes.reduce((acc, s, i) => (uids.has(s.uid) ? i : acc), firstIndex);
  const rest = slide.shapes.filter((s) => !uids.has(s.uid));
  const insertAt = lastIndex - (members.length - 1);
  rest.splice(Math.max(0, Math.min(rest.length, insertAt)), 0, group);
  return { slide: { ...slide, shapes: rest }, group };
}

export function ungroupShape(slide: Slide, g: GroupShape): { slide: Slide; children: Shape[] } {
  const sx = g.ch.w ? g.xfrm.w / g.ch.w : 1;
  const sy = g.ch.h ? g.xfrm.h / g.ch.h : 1;
  const gcx = g.xfrm.x + g.xfrm.w / 2;
  const gcy = g.xfrm.y + g.xfrm.h / 2;
  const rot = g.xfrm.rot ?? 0;
  const a = (rot * Math.PI) / 180;
  const children = g.children.map((c) => {
    const cx = c.xfrm;
    if (!cx) return c;
    let x = g.xfrm.x + (cx.x - g.ch.x) * sx;
    let y = g.xfrm.y + (cx.y - g.ch.y) * sy;
    const w = cx.w * sx;
    const h = cx.h * sy;
    let ccx = x + w / 2;
    let ccy = y + h / 2;
    if (g.xfrm.flipH) ccx = 2 * gcx - ccx;
    if (g.xfrm.flipV) ccy = 2 * gcy - ccy;
    if (rot) {
      const dx = ccx - gcx;
      const dy = ccy - gcy;
      ccx = gcx + dx * Math.cos(a) - dy * Math.sin(a);
      ccy = gcy + dx * Math.sin(a) + dy * Math.cos(a);
    }
    x = ccx - w / 2;
    y = ccy - h / 2;
    const nx: Xfrm = { ...cx, x, y, w, h, rot: ((cx.rot ?? 0) + rot) % 360 || undefined };
    if (g.xfrm.flipH) nx.flipH = !cx.flipH || undefined;
    if (g.xfrm.flipV) nx.flipV = !cx.flipV || undefined;
    if (!nx.flipH) delete nx.flipH;
    if (!nx.flipV) delete nx.flipV;
    if (!nx.rot) delete nx.rot;
    // Children inherit "use the group's fill"; give them the group's.
    if ((c.kind === 'sp' || c.kind === 'pic') && c.fill?.type === 'grp' && g.fill) return { ...c, fill: g.fill, xfrm: nx } as Shape;
    if (c.kind === 'grp') {
      const k = c.xfrm;
      return { ...c, xfrm: nx, ch: { ...c.ch }, children: c.children, ...(k ? {} : {}) };
    }
    return { ...c, xfrm: nx } as Shape;
  });
  const i = slide.shapes.indexOf(g);
  const shapes = [...slide.shapes];
  shapes.splice(i, 1, ...children);
  return { slide: { ...slide, shapes }, children };
}

export type Order = 'front' | 'back' | 'forward' | 'backward';

export function reorder(slide: Slide, uids: Set<string>, order: Order): Slide {
  const shapes = [...slide.shapes];
  const sel = shapes.filter((s) => uids.has(s.uid));
  if (!sel.length) return slide;
  if (order === 'front') return { ...slide, shapes: [...shapes.filter((s) => !uids.has(s.uid)), ...sel] };
  if (order === 'back') return { ...slide, shapes: [...sel, ...shapes.filter((s) => !uids.has(s.uid))] };
  if (order === 'forward') {
    for (let i = shapes.length - 2; i >= 0; i--) {
      if (uids.has(shapes[i].uid) && !uids.has(shapes[i + 1].uid)) [shapes[i], shapes[i + 1]] = [shapes[i + 1], shapes[i]];
    }
  } else {
    for (let i = 1; i < shapes.length; i++) {
      if (uids.has(shapes[i].uid) && !uids.has(shapes[i - 1].uid)) [shapes[i], shapes[i - 1]] = [shapes[i - 1], shapes[i]];
    }
  }
  return { ...slide, shapes };
}

export type AlignHow = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distH' | 'distV';

export function alignShapes(deck: Deck, slide: Slide, uids: Set<string>, how: AlignHow, toSlide: boolean): Slide {
  const sel = slide.shapes.filter((s) => uids.has(s.uid));
  const boxes = new Map(sel.map((s) => [s.uid, boxOf(deck, slide, s)] as const));
  const all = [...boxes.values()].filter((b): b is Xfrm => !!b);
  if (!all.length) return slide;
  const bb = toSlide || all.length === 1
    ? { l: 0, t: 0, r: deck.w, b: deck.h }
    : { l: Math.min(...all.map((b) => b.x)), t: Math.min(...all.map((b) => b.y)), r: Math.max(...all.map((b) => b.x + b.w)), b: Math.max(...all.map((b) => b.y + b.h)) };
  const place = new Map<string, Xfrm>();
  if (how === 'distH' || how === 'distV') {
    const horiz = how === 'distH';
    const sorted = sel.filter((s) => boxes.get(s.uid)).sort((a, b) => (horiz ? boxes.get(a.uid)!.x - boxes.get(b.uid)!.x : boxes.get(a.uid)!.y - boxes.get(b.uid)!.y));
    if (sorted.length < 2 && !toSlide) return slide;
    const size = sorted.reduce((acc, s) => acc + (horiz ? boxes.get(s.uid)!.w : boxes.get(s.uid)!.h), 0);
    const span = horiz ? bb.r - bb.l : bb.b - bb.t;
    const gap = sorted.length > 1 ? (span - size) / (sorted.length - 1) : 0;
    let pos = horiz ? bb.l : bb.t;
    for (const s of sorted) {
      const b = boxes.get(s.uid)!;
      place.set(s.uid, horiz ? { ...b, x: pos } : { ...b, y: pos });
      pos += (horiz ? b.w : b.h) + gap;
    }
  } else {
    for (const s of sel) {
      const b = boxes.get(s.uid);
      if (!b) continue;
      const n = { ...b };
      if (how === 'left') n.x = bb.l;
      if (how === 'center') n.x = (bb.l + bb.r) / 2 - b.w / 2;
      if (how === 'right') n.x = bb.r - b.w;
      if (how === 'top') n.y = bb.t;
      if (how === 'middle') n.y = (bb.t + bb.b) / 2 - b.h / 2;
      if (how === 'bottom') n.y = bb.b - b.h;
      place.set(s.uid, n);
    }
  }
  return { ...slide, shapes: slide.shapes.map((s) => (place.has(s.uid) ? withXfrm(s, place.get(s.uid)!) : s)) };
}

// ---- Text formatting on whole shapes ---------------------------------------------------------

export function mapRuns(text: TextBody, fn: (p: RunProps) => RunProps): TextBody {
  return {
    ...text,
    paras: text.paras.map((p) => ({
      ...p,
      runs: p.runs.map((r) => ({ ...r, props: fn(r.props) })),
      end: fn(p.end ?? {}),
    })),
  };
}

export function mapParas(text: TextBody, fn: (p: ParaProps, para: Para) => ParaProps): TextBody {
  return { ...text, paras: text.paras.map((p) => ({ ...p, props: fn(p.props, p) })) };
}

/** Apply a text change to a whole shape (what the ribbon does with a shape selected, not its text). */
export function shapeText(s: Shape, fn: (t: TextBody) => TextBody): Shape {
  if (s.kind === 'sp' && !s.connector) return { ...s, text: fn(s.text ?? emptyText()) };
  if (s.kind === 'grp') return { ...s, children: s.children.map((c) => shapeText(c, fn)) };
  if (s.kind === 'frame' && s.table) {
    return { ...s, table: { ...s.table, rows: s.table.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, text: fn(c.text) })) })) } };
  }
  return s;
}

/** The first run's properties in a shape, for showing in the ribbon. */
export function firstRunProps(s: Shape | undefined): { run: RunProps; para: ParaProps } | null {
  if (!s) return null;
  if (s.kind === 'sp' && s.text) {
    const p = s.text.paras[0];
    const r = p?.runs.find((x) => x.kind !== 'br');
    return { run: r?.props ?? p?.end ?? {}, para: p?.props ?? {} };
  }
  if (s.kind === 'grp') return firstRunProps(s.children[0]);
  return null;
}

// ---- Header and footer ---------------------------------------------------------------------

export interface FooterSettings {
  date: boolean;
  fixedDate: string | null;
  number: boolean;
  footer: boolean;
  footerText: string;
  skipTitle: boolean;
}

const guid = () =>
  `{${[8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('')).join('-')}}`;

/** What a slide's footer placeholders say now, for the Header and Footer dialog. */
export function footerSettings(slide: Slide): FooterSettings {
  const ph = (t: string) => slide.shapes.find((s): s is SpShape => s.kind === 'sp' && s.ph?.type === t);
  const dt = ph('dt');
  const ftr = ph('ftr');
  const dtRun = dt?.text?.paras[0]?.runs[0];
  return {
    date: !!dt,
    fixedDate: dtRun && dtRun.kind === 'text' ? dtRun.text : null,
    number: !!ph('sldNum'),
    footer: !!ftr,
    footerText: ftr?.text ? ftr.text.paras.map((p) => p.runs.map((r) => (r.kind === 'br' ? '\n' : r.text)).join('')).join('\n') : '',
    skipTitle: false,
  };
}

/** Add, update or remove a slide's date, footer and slide number placeholders. */
export function applyFooter(deck: Deck, slide: Slide, c: FooterSettings): Slide {
  const layout = layoutOf(deck, slide);
  const off = !!c.skipTitle && layout?.type === 'title';
  const want: Record<string, boolean> = { dt: c.date && !off, ftr: c.footer && !off, sldNum: c.number && !off };
  const textFor = (type: string): TextBody => {
    const run: Run =
      type === 'sldNum'
        ? { kind: 'field', type: 'slidenum', id: guid(), text: '‹#›', props: {} }
        : type === 'dt'
          ? c.fixedDate !== null
            ? { kind: 'text', text: c.fixedDate, props: {} }
            : { kind: 'field', type: 'datetime1', id: guid(), text: new Date().toLocaleDateString('en-US'), props: {} }
          : { kind: 'text', text: c.footerText, props: {} };
    return { body: {}, paras: [{ props: {}, runs: [run] }] };
  };
  let shapes = slide.shapes.filter((s) => !(s.kind === 'sp' && s.ph && s.ph.type && s.ph.type in want && !want[s.ph.type]));
  let id = maxShapeId(shapes) + 1;
  for (const type of ['dt', 'ftr', 'sldNum']) {
    if (!want[type]) continue;
    const have = shapes.find((s) => s.kind === 'sp' && s.ph?.type === type);
    if (have) {
      if (type !== 'sldNum') shapes = shapes.map((s) => (s === have ? { ...s, text: textFor(type) } as Shape : s));
      continue;
    }
    const lp = layout?.shapes.find((s) => 'ph' in s && s.ph?.type === type);
    const lph = lp && 'ph' in lp ? lp.ph : undefined;
    shapes = [
      ...shapes,
      {
        kind: 'sp',
        uid: newUid(),
        id,
        name: `${PH_NAMES[type]} ${id - 1}`,
        ph: { type, ...(lph?.sz ? { sz: lph.sz } : {}), ...(lph?.idx !== undefined ? { idx: lph.idx } : {}) },
        nvRaw: '<a:spLocks noGrp="1"/>',
        text: textFor(type),
      },
    ];
    id++;
  }
  return { ...slide, shapes };
}

// ---- Slide size ---------------------------------------------------------------------------------

function scaleShape(s: Shape, sx: number, sy: number): Shape {
  const sc = (x: Xfrm | undefined): Xfrm | undefined => (x ? { ...x, x: x.x * sx, y: x.y * sy, w: x.w * sx, h: x.h * sy } : x);
  if (s.kind === 'grp') return { ...s, xfrm: sc(s.xfrm)! };
  return { ...s, xfrm: sc(s.xfrm) } as Shape;
}

/** Change the slide size, scaling everything on the slides, layouts and masters (PowerPoint's "Ensure Fit" without shrinking text). */
export function resizeDeck(deck: Deck, w: number, h: number): Deck {
  const sx = w / deck.w;
  const sy = h / deck.h;
  const layouts = Object.fromEntries(Object.entries(deck.layouts).map(([k, l]) => [k, { ...l, shapes: l.shapes.map((s) => scaleShape(s, sx, sy)) }]));
  const masters = Object.fromEntries(Object.entries(deck.masters).map(([k, m]) => [k, { ...m, shapes: m.shapes.map((s) => scaleShape(s, sx, sy)) }]));
  return { ...deck, w, h, layouts, masters, slides: deck.slides.map((sl) => ({ ...sl, shapes: sl.shapes.map((s) => scaleShape(s, sx, sy)) })) };
}

// ---- New shapes ----------------------------------------------------------------------------------

export function newShape(prst: string, id: number, xfrm: Xfrm): Shape {
  const line = prst === 'line' || prst.includes('Connector');
  if (line) {
    return {
      kind: 'sp',
      connector: true,
      uid: newUid(),
      id,
      name: `${prst === 'line' ? 'Straight Connector' : 'Connector'} ${id - 1}`,
      xfrm,
      geom: { prst },
      style: { ln: { idx: 1, color: { scheme: 'accent1' } }, fill: { idx: 0, color: { scheme: 'accent1' } }, effect: { idx: 0, color: { scheme: 'accent1' } }, font: { idx: 'minor', color: { scheme: 'tx1' } } },
      ...(prst === 'straightConnector1' ? { line: { tail: { type: 'triangle' } } } : {}),
    };
  }
  return {
    kind: 'sp',
    uid: newUid(),
    id,
    name: `${prst.replace(/^\w/, (c) => c.toUpperCase())} ${id - 1}`,
    xfrm,
    geom: { prst },
    style: {
      ln: { idx: 2, color: { scheme: 'accent1', mods: [['shade', 50000]] } },
      fill: { idx: 1, color: { scheme: 'accent1' } },
      effect: { idx: 0, color: { scheme: 'accent1' } },
      font: { idx: 'minor', color: { scheme: 'lt1' } },
    },
    text: { body: { anchor: 'ctr', attrs: { rtlCol: '0' } }, paras: [{ props: { algn: 'ctr' }, runs: [] }] },
  };
}

export function newTextBox(id: number, xfrm: Xfrm, wrap: boolean): Shape {
  return {
    kind: 'sp',
    uid: newUid(),
    id,
    name: `TextBox ${id - 1}`,
    txBox: true,
    xfrm,
    geom: { prst: 'rect' },
    fill: { type: 'none' },
    text: { body: { wrap: wrap ? 'square' : 'none', autofit: 'shape', attrs: { rtlCol: '0' } }, paras: [{ props: {}, runs: [] }] },
  };
}

export function newPicture(id: number, media: string, xfrm: Xfrm, name: string): Shape {
  return { kind: 'pic', uid: newUid(), id, name: `Picture ${id - 1}`, descr: name, media, xfrm, nvRaw: '<a:picLocks noChangeAspect="1"/>', geom: { prst: 'rect' } };
}

export function newTable(id: number, rows: number, cols: number, xfrm: Xfrm, styleId: string): Shape {
  const colW = Math.round(xfrm.w / cols);
  const rowH = 370840;
  return {
    kind: 'frame',
    uid: newUid(),
    id,
    name: `Table ${id - 1}`,
    xfrm: { ...xfrm, h: rowH * rows },
    table: {
      tblPr: `<a:tblPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>`,
      cols: Array.from({ length: cols }, () => colW),
      rows: Array.from({ length: rows }, () => ({ h: rowH, cells: Array.from({ length: cols }, () => ({ text: emptyText(), tcPr: '' })) })),
    },
  };
}
