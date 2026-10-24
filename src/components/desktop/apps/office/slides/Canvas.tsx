import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { RotateCw } from 'lucide-react';
import { isLineGeom } from './geometry';
import { PX, type Geometry, type Shape, type Slide, type SlideCtx, type TextBody, type Xfrm } from './model';
import { adjustHandles, dragAdjust } from './adjust';
import { boxOf, cloneShape, findShape, nextId, newShape, newTextBox, textCapable, withXfrm } from './ops';
import { SlideImage, type TextInfo } from './render';
import { inheritChain, textChain } from './resolve';
import { ShapeTextEditor, type EditStart } from './TextEditor';

/**
 * The slide being edited, on PowerPoint's gray canvas: click to select,
 * drag to move (with smart guides to the slide's center and edges and to
 * other shapes), handles to resize and rotate, a marquee to select several,
 * drawing new shapes and text boxes, and the text editor in a shape.
 */

export type InsertTool = { kind: 'shape'; prst: string } | { kind: 'textbox' };

export interface Editing {
  uid: string;
  start: EditStart;
  /** A table cell (row, column), when editing a table. */
  cell?: [number, number];
}

interface Point {
  x: number;
  y: number;
}

interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

type Gesture =
  | { kind: 'move'; start: Point; orig: Map<string, Xfrm>; moved: boolean; clickUid: string; wasSelected: boolean; client: Point }
  | { kind: 'resize'; handle: [number, number]; primary: string; orig: Map<string, Xfrm> }
  | { kind: 'rotate'; center: Point; startAngle: number; orig: Map<string, Xfrm> }
  | { kind: 'lineEnd'; uid: string; end: 'a' | 'b'; orig: Xfrm }
  | { kind: 'adjust'; uid: string }
  | { kind: 'marquee'; start: Point; additive: boolean; base: string[] }
  | { kind: 'draw'; start: Point; tool: InsertTool };

interface Live {
  moving?: boolean;
  geoms?: Map<string, Geometry>;
  xfrms?: Map<string, Xfrm>;
  dup?: boolean;
  guides?: Guide[];
  rect?: { x: number; y: number; w: number; h: number };
  draw?: { a: Point; b: Point; tool: InsertTool };
}

/** Shapes PowerPoint puts the caret in on the first click: text boxes and text placeholders. */
const clickToType = (s: Shape | undefined): boolean => !!s && s.kind === 'sp' && !s.connector && (!!s.txBox || (!!s.ph && s.ph.type !== 'pic'));

/** normAutofit's font scales, with the line spacing reduction that goes with each. */
const FIT_STEPS: [number, number][] = [[100000, 0], [92500, 10000], [85000, 20000], [77500, 20000], [70000, 20000], [62500, 20000], [55000, 20000], [47500, 20000], [40000, 20000], [25000, 20000]];

const HANDLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];

function handleCursor(h: [number, number], rot: number): string {
  const base = Math.atan2(h[1], h[0]) * (180 / Math.PI) + rot;
  const idx = Math.round((((base % 180) + 180) % 180) / 45) % 4;
  return CURSORS[[2, 3, 0, 1][idx]];
}

const rad = (d: number) => (d * Math.PI) / 180;
const rotate = (p: Point, a: number): Point => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

function lineEnds(x: Xfrm): [Point, Point] {
  const a = { x: x.flipH ? x.x + x.w : x.x, y: x.flipV ? x.y + x.h : x.y };
  const b = { x: x.flipH ? x.x : x.x + x.w, y: x.flipV ? x.y : x.y + x.h };
  return [a, b];
}

function fromEnds(a: Point, b: Point, base: Xfrm): Xfrm {
  const n: Xfrm = { ...base, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  delete n.flipH;
  delete n.flipV;
  if (b.x < a.x) n.flipH = true;
  if (b.y < a.y) n.flipV = true;
  return n;
}

export function Canvas({
  slide,
  ctx,
  zoom,
  onFit,
  onZoom,
  sel,
  onSelect,
  editing,
  onEdit,
  tool,
  onToolDone,
  commit,
  onText,
  onAutoSize,
  onAutoFit,
  onEditor,
  onEditorChange,
  editorKeys,
  onContext,
  onPlaceholderAction,
  gridlines,
}: {
  slide: Slide;
  ctx: SlideCtx;
  zoom: number;
  onFit: (z: number) => void;
  onZoom: (z: number) => void;
  sel: string[];
  onSelect: (uids: string[]) => void;
  editing: Editing | null;
  onEdit: (e: Editing | null) => void;
  tool: InsertTool | null;
  onToolDone: () => void;
  commit: (slide: Slide, label: string, select?: string[]) => void;
  onText: (uid: string, body: TextBody, cell?: [number, number]) => void;
  onAutoSize: (uid: string, xfrm: Xfrm) => void;
  onAutoFit: (uid: string, fontScale: number, lnSpcReduction: number) => void;
  onEditor: (e: Editor | null) => void;
  onEditorChange: () => void;
  editorKeys: Record<string, (e: Editor) => boolean>;
  onContext: (at: { x: number; y: number }, onShape: boolean) => void;
  onPlaceholderAction: (uid: string, kind: string) => void;
  gridlines: boolean;
}) {
  const deck = ctx.deck;
  const scrollRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Live>({});
  const scale = zoom * PX;
  const slideW = deck.w * scale;
  const slideH = deck.h * scale;

  // Fit-to-window zoom follows the canvas's size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - 48;
      const h = el.clientHeight - 48;
      if (w > 0 && h > 0) onFit(Math.max(0.05, Math.min(w / (deck.w * PX), h / (deck.h * PX))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck.w, deck.h, onFit]);

  const shapeByUid = useMemo(() => new Map(slide.shapes.map((s) => [s.uid, s])), [slide.shapes]);
  const boxFor = useCallback((s: Shape): Xfrm | undefined => live.xfrms?.get(s.uid) ?? boxOf(deck, slide, s), [live.xfrms, deck, slide]);

  const toSlide = (clientX: number, clientY: number): Point => {
    const r = slideRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  // What's drawn: the slide, with whatever's being dragged where it's going.
  const shown = useMemo((): Slide => {
    if (live.geoms) return { ...slide, shapes: slide.shapes.map((s) => (live.geoms!.has(s.uid) && s.kind === 'sp' ? { ...s, geom: live.geoms!.get(s.uid) } : s)) };
    if (!live.xfrms) return slide;
    if (live.dup) {
      const copies = slide.shapes.filter((s) => live.xfrms!.has(s.uid)).map((s) => ({ ...withXfrm(s, live.xfrms!.get(s.uid)!), uid: `${s.uid}-dup` }));
      return { ...slide, shapes: [...slide.shapes, ...copies] };
    }
    return { ...slide, shapes: slide.shapes.map((s) => (live.xfrms!.has(s.uid) ? withXfrm(s, live.xfrms!.get(s.uid)!) : s)) };
  }, [slide, live.xfrms, live.dup, live.geoms]);

  const shownCtx = useMemo(() => ({ ...ctx, slide: shown }), [ctx, shown]);

  // ---- Smart guides ----------------------------------------------------------------

  const snap = (boxes: Xfrm[], moving: Set<string>, dx: number, dy: number): { dx: number; dy: number; guides: Guide[] } => {
    const l = Math.min(...boxes.map((b) => b.x)) + dx;
    const t = Math.min(...boxes.map((b) => b.y)) + dy;
    const r = Math.max(...boxes.map((b) => b.x + b.w)) + dx;
    const b = Math.max(...boxes.map((bx) => bx.y + bx.h)) + dy;
    const others = slide.shapes.filter((s) => !moving.has(s.uid) && !s.hidden).map((s) => boxOf(deck, slide, s)).filter((x): x is Xfrm => !!x && x.w * x.h > 0);
    const tol = 6 / scale;
    const xTargets: { at: number; from: number; to: number }[] = [
      { at: deck.w / 2, from: 0, to: deck.h },
      { at: 0, from: 0, to: deck.h },
      { at: deck.w, from: 0, to: deck.h },
    ];
    const yTargets: { at: number; from: number; to: number }[] = [
      { at: deck.h / 2, from: 0, to: deck.w },
      { at: 0, from: 0, to: deck.w },
      { at: deck.h, from: 0, to: deck.w },
    ];
    for (const o of others) {
      for (const at of [o.x, o.x + o.w / 2, o.x + o.w]) xTargets.push({ at, from: o.y, to: o.y + o.h });
      for (const at of [o.y, o.y + o.h / 2, o.y + o.h]) yTargets.push({ at, from: o.x, to: o.x + o.w });
    }
    const best = (edges: number[], targets: typeof xTargets) => {
      let hit: { d: number; at: number } | null = null;
      for (const e of edges) for (const tg of targets) {
        const d = tg.at - e;
        if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: tg.at };
      }
      return hit;
    };
    const hx = best([l, (l + r) / 2, r], xTargets);
    const hy = best([t, (t + b) / 2, b], yTargets);
    const guides: Guide[] = [];
    const ndx = dx + (hx?.d ?? 0);
    const ndy = dy + (hy?.d ?? 0);
    if (hx) {
      const nt = t + (hy?.d ?? 0);
      const nb = b + (hy?.d ?? 0);
      const matched = xTargets.filter((tg) => Math.abs(tg.at - hx.at) < 1);
      guides.push({ axis: 'x', at: hx.at, from: Math.min(nt, ...matched.map((m) => m.from)), to: Math.max(nb, ...matched.map((m) => m.to)) });
    }
    if (hy) {
      const nl = l + (hx?.d ?? 0);
      const nr = r + (hx?.d ?? 0);
      const matched = yTargets.filter((tg) => Math.abs(tg.at - hy.at) < 1);
      guides.push({ axis: 'y', at: hy.at, from: Math.min(nl, ...matched.map((m) => m.from)), to: Math.max(nr, ...matched.map((m) => m.to)) });
    }
    return { dx: ndx, dy: ndy, guides };
  };

  // ---- Gestures ------------------------------------------------------------------------

  const finish = useCallback(
    (g: Gesture, p: Point, e: PointerEvent) => {
      const xfrms = live.xfrms;
      switch (g.kind) {
        case 'move': {
          if (!g.moved) {
            const s = shapeByUid.get(g.clickUid);
            // A click (no drag) on a text box or placeholder, or on a shape
            // that was already selected, puts the caret there.
            const cellEl = (e.target as HTMLElement | null)?.closest?.('[data-cell]') as HTMLElement | null;
            if (s?.kind === 'frame' && s.table && cellEl && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              onSelect([s.uid]);
              onEdit({ uid: s.uid, cell: cellEl.dataset.cell!.split(',').map(Number) as [number, number], start: { caret: { x: g.client.x, y: g.client.y } } });
              break;
            }
            if (s && textCapable(s) && (clickToType(s) || (g.wasSelected && sel.length === 1)) && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              onSelect([s.uid]);
              onEdit({ uid: s.uid, start: { caret: { x: g.client.x, y: g.client.y } } });
            }
            break;
          }
          if (!xfrms) break;
          if (e.ctrlKey || e.metaKey) {
            let id = nextId(slide);
            const copies = slide.shapes.filter((s) => xfrms.has(s.uid)).map((s) => withXfrm(cloneShape(s, id++), xfrms.get(s.uid)!));
            commit({ ...slide, shapes: [...slide.shapes, ...copies] }, 'Duplicate', copies.map((c) => c.uid));
          } else commit(applyXfrms(slide, xfrms), 'Move');
          break;
        }
        case 'resize':
        case 'rotate':
          if (xfrms) commit(applyXfrms(slide, xfrms, g.kind === 'resize' ? g.orig : undefined), g.kind === 'resize' ? 'Resize' : 'Rotate');
          break;
        case 'lineEnd':
          if (xfrms) commit(applyXfrms(slide, xfrms), 'Resize');
          break;
        case 'marquee':
          break;
        case 'adjust': {
          const geom = live.geoms?.get(g.uid);
          if (geom) commit({ ...slide, shapes: slide.shapes.map((s) => (s.uid === g.uid && s.kind === 'sp' ? { ...s, geom } : s)) }, 'Adjust Shape');
          break;
        }
        case 'draw': {
          const a = g.start;
          const dragged = Math.hypot(p.x - a.x, p.y - a.y) * scale > 4;
          const id = nextId(slide);
          let shape: Shape;
          const d = live.draw;
          const b = d?.b ?? p;
          if (g.tool.kind === 'textbox') {
            const w = dragged ? Math.abs(b.x - a.x) : 0;
            shape = newTextBox(id, { x: dragged ? Math.min(a.x, b.x) : a.x, y: dragged ? Math.min(a.y, b.y) : a.y, w: Math.max(w, dragged ? 91440 : 182880), h: 369332 }, dragged);
          } else {
            const line = g.tool.prst === 'line' || g.tool.prst.includes('Connector');
            if (!dragged) {
              const size = line ? { w: 914400, h: 0 } : { w: 914400, h: 914400 };
              shape = newShape(g.tool.prst, id, { x: a.x - size.w / 2, y: a.y - size.h / 2, ...size });
            } else if (line) shape = newShape(g.tool.prst, id, fromEnds(a, b, { x: 0, y: 0, w: 0, h: 0 }));
            else shape = newShape(g.tool.prst, id, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
          }
          commit({ ...slide, shapes: [...slide.shapes, shape] }, g.tool.kind === 'textbox' ? 'Insert Text Box' : 'Insert Shape', [shape.uid]);
          if (g.tool.kind === 'textbox') onEdit({ uid: shape.uid, start: {} });
          onToolDone();
          break;
        }
      }
      setLive({});
    },
    [live, shapeByUid, sel, slide, scale, commit, onEdit, onSelect, onToolDone],
  );

  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });

  const track = (move: (p: Point, e: PointerEvent) => void) => {
    const onMove = (e: PointerEvent) => move(toSlide(e.clientX, e.clientY), e);
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const g = gesture.current;
      gesture.current = null;
      if (g) finishRef.current(g, toSlide(e.clientX, e.clientY), e);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const startMove = (uid: string, e: React.PointerEvent, selection: string[]) => {
    const p = toSlide(e.clientX, e.clientY);
    const orig = new Map<string, Xfrm>();
    for (const u of selection) {
      const s = shapeByUid.get(u);
      const b = s && boxOf(deck, slide, s);
      if (b) orig.set(u, b);
    }
    const g: Gesture = { kind: 'move', start: p, orig, moved: false, clickUid: uid, wasSelected: sel.includes(uid), client: { x: e.clientX, y: e.clientY } };
    gesture.current = g;
    track((q, ev) => {
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      if (!g.moved && Math.hypot(dx, dy) * scale < 4) return;
      g.moved = true;
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let guides: Guide[] = [];
      if (!ev.altKey) {
        const s = snap([...orig.values()], new Set(orig.keys()), dx, dy);
        if (ev.shiftKey) {
          if (dy === 0) dx = s.dx;
          else dy = s.dy;
        } else {
          dx = s.dx;
          dy = s.dy;
        }
        guides = s.guides;
      }
      const xfrms = new Map([...orig].map(([u, b]) => [u, { ...b, x: b.x + dx, y: b.y + dy }] as const));
      setLive({ xfrms, dup: ev.ctrlKey || ev.metaKey, guides, moving: true });
    });
  };

  const startResize = (handle: [number, number], primary: string) => {
    const orig = new Map<string, Xfrm>();
    for (const u of sel) {
      const s = shapeByUid.get(u);
      const b = s && boxOf(deck, slide, s);
      if (b) orig.set(u, b);
    }
    const o = orig.get(primary);
    if (!o) return;
    const pic = shapeByUid.get(primary)?.kind === 'pic';
    gesture.current = { kind: 'resize', handle, primary, orig };
    track((p, ev) => {
      const [hx, hy] = handle;
      const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      const th = rad(o.rot ?? 0);
      const q = rotate({ x: p.x - c.x, y: p.y - c.y }, -th);
      const fromCenter = ev.ctrlKey || ev.metaKey;
      const ax = fromCenter ? 0 : (-hx * o.w) / 2;
      const ay = fromCenter ? 0 : (-hy * o.h) / 2;
      const min = 4 / scale;
      let w = hx ? Math.max(min, (q.x - ax) * hx * (fromCenter ? 2 : 1)) : o.w;
      let h = hy ? Math.max(min, (q.y - ay) * hy * (fromCenter ? 2 : 1)) : o.h;
      if (hx && hy && (ev.shiftKey !== pic) && o.w > 0 && o.h > 0) {
        const k = Math.max(w / o.w, h / o.h);
        w = o.w * k;
        h = o.h * k;
      }
      const sx = o.w ? w / o.w : 1;
      const sy = o.h ? h / o.h : 1;
      const xfrms = new Map<string, Xfrm>();
      for (const [u, b] of orig) {
        const bw = b.w * sx;
        const bh = b.h * sy;
        const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        const bth = rad(b.rot ?? 0);
        const bax = fromCenter ? 0 : (-hx * b.w) / 2;
        const bay = fromCenter ? 0 : (-hy * b.h) / 2;
        const lc = { x: fromCenter || !hx ? 0 : bax + (hx * bw) / 2, y: fromCenter || !hy ? 0 : bay + (hy * bh) / 2 };
        const wc = rotate(lc, bth);
        xfrms.set(u, { ...b, x: bc.x + wc.x - bw / 2, y: bc.y + wc.y - bh / 2, w: bw, h: bh });
      }
      setLive({ xfrms });
    });
  };

  const startRotate = (e: React.PointerEvent) => {
    const orig = new Map<string, Xfrm>();
    for (const u of sel) {
      const s = shapeByUid.get(u);
      const b = s && boxOf(deck, slide, s);
      if (b) orig.set(u, b);
    }
    const first = [...orig.values()][0];
    if (!first) return;
    const center = { x: first.x + first.w / 2, y: first.y + first.h / 2 };
    const p = toSlide(e.clientX, e.clientY);
    const startAngle = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
    gesture.current = { kind: 'rotate', center, startAngle, orig };
    track((q, ev) => {
      const a = (Math.atan2(q.y - center.y, q.x - center.x) * 180) / Math.PI;
      const xfrms = new Map<string, Xfrm>();
      for (const [u, b] of orig) {
        let r = (b.rot ?? 0) + a - startAngle;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        r = ((r % 360) + 360) % 360;
        xfrms.set(u, { ...b, rot: r || undefined });
      }
      setLive({ xfrms });
    });
  };

  const startLineEnd = (uid: string, end: 'a' | 'b') => {
    const s = shapeByUid.get(uid);
    const o = s && boxOf(deck, slide, s);
    if (!o) return;
    gesture.current = { kind: 'lineEnd', uid, end, orig: o };
    const [a0, b0] = lineEnds(o);
    track((p, ev) => {
      const fixed = end === 'a' ? b0 : a0;
      let q = p;
      if (ev.shiftKey) {
        const ang = Math.round(Math.atan2(p.y - fixed.y, p.x - fixed.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(p.x - fixed.x, p.y - fixed.y);
        q = { x: fixed.x + len * Math.cos(ang), y: fixed.y + len * Math.sin(ang) };
      }
      const n = end === 'a' ? fromEnds(q, b0, o) : fromEnds(a0, q, o);
      setLive({ xfrms: new Map([[uid, n]]) });
    });
  };

  const startAdjust = (uid: string, i: number) => {
    const s = shapeByUid.get(uid);
    const b = s && boxOf(deck, slide, s);
    if (!s || s.kind !== 'sp' || !s.geom?.prst || !b) return;
    const geom = s.geom;
    const prst = s.geom.prst;
    gesture.current = { kind: 'adjust', uid };
    track((p) => {
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const q = rotate({ x: p.x - c.x, y: p.y - c.y }, -rad(b.rot ?? 0));
      let x = q.x + b.w / 2;
      let y = q.y + b.h / 2;
      if (b.flipH) x = b.w - x;
      if (b.flipV) y = b.h - y;
      const adj = dragAdjust(prst, geom.adj, i, x, y, b.w, b.h);
      setLive({ geoms: new Map([[uid, { ...geom, adj }]]) });
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    const target = e.target as HTMLElement;
    const p = toSlide(e.clientX, e.clientY);
    if (e.button === 2) {
      const el = target.closest<HTMLElement>('[data-shape]');
      const uid = el?.dataset.shape;
      if (uid && !sel.includes(uid)) onSelect([uid]);
      if (!uid) onSelect([]);
      return;
    }
    if (tool) {
      e.preventDefault();
      gesture.current = { kind: 'draw', start: p, tool };
      track((q, ev) => {
        let b = q;
        if (ev.shiftKey) {
          const line = tool.kind === 'shape' && (tool.prst === 'line' || tool.prst.includes('Connector'));
          if (line) {
            const ang = Math.round(Math.atan2(q.y - p.y, q.x - p.x) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(q.x - p.x, q.y - p.y);
            b = { x: p.x + len * Math.cos(ang), y: p.y + len * Math.sin(ang) };
          } else {
            const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y));
            b = { x: p.x + Math.sign(q.x - p.x || 1) * d, y: p.y + Math.sign(q.y - p.y || 1) * d };
          }
        }
        setLive({ draw: { a: p, b, tool } });
      });
      return;
    }
    const action = target.closest<HTMLElement>('[data-ph-action]');
    const actionUid = action?.closest<HTMLElement>('[data-shape]')?.dataset.shape;
    if (action && actionUid) {
      e.preventDefault();
      e.stopPropagation();
      onPlaceholderAction(actionUid, action.dataset.phAction!);
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]');
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      const kind = handle.dataset.handle!;
      const uid = handle.dataset.uid!;
      if (kind === 'rotate') startRotate(e);
      else if (kind.startsWith('adj:')) startAdjust(uid, Number(kind.slice(4)));
      else if (kind === 'a' || kind === 'b') startLineEnd(uid, kind);
      else startResize(kind.split(',').map(Number) as [number, number], uid);
      return;
    }
    const shapeEl = target.closest<HTMLElement>('[data-shape]');
    const uid = shapeEl?.dataset.shape;
    if (editing) onEdit(null);
    if (uid && shapeByUid.has(uid)) {
      e.preventDefault();
      let next = sel;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (sel.includes(uid)) {
          if (!e.ctrlKey && !e.metaKey) next = sel.filter((u) => u !== uid);
        } else next = [...sel, uid];
      } else if (!sel.includes(uid)) next = [uid];
      if (next !== sel) onSelect(next);
      if (next.includes(uid)) startMove(uid, e, next);
      scrollRef.current?.focus({ preventScroll: true });
      return;
    }
    // Empty canvas: a marquee.
    e.preventDefault();
    scrollRef.current?.focus({ preventScroll: true });
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive) onSelect([]);
    const base = additive ? sel : [];
    gesture.current = { kind: 'marquee', start: p, additive, base };
    track((q) => {
      const rect = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
      const inside = slide.shapes
        .filter((s) => {
          const b = boxOf(deck, slide, s);
          return b && !s.hidden && b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h;
        })
        .map((s) => s.uid);
      onSelect([...new Set([...base, ...inside])]);
      setLive({ rect });
    });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const uid = (e.target as HTMLElement).closest<HTMLElement>('[data-shape]')?.dataset.shape;
    const s = uid ? shapeByUid.get(uid) : undefined;
    // A shape in a group: its text can be edited without ungrouping.
    const childUid = (e.target as HTMLElement).closest<HTMLElement>('[data-child]')?.dataset.child;
    if (s?.kind === 'grp' && childUid) {
      const child = findShape(s.children, childUid);
      if (child && textCapable(child)) {
        onSelect([s.uid]);
        onEdit({ uid: childUid, start: { caret: { x: e.clientX, y: e.clientY } } });
        return;
      }
    }
    const cellEl = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (s?.kind === 'frame' && s.table && cellEl) {
      onSelect([s.uid]);
      onEdit({ uid: s.uid, cell: cellEl.dataset.cell!.split(',').map(Number) as [number, number], start: { caret: { x: e.clientX, y: e.clientY } } });
      return;
    }
    if (s && textCapable(s)) {
      onSelect([s.uid]);
      onEdit({ uid: s.uid, start: { caret: { x: e.clientX, y: e.clientY } } });
    }
  };

  // ---- The text editor in a shape ---------------------------------------------------------

  const renderEditor = useCallback(
    (shape: Shape, info: TextInfo, cell?: [number, number]) => {
      if (!editing) return null;
      if (shape.kind === 'frame' && shape.table && cell) {
        const [r, col] = cell;
        const rows = shape.table.rows;
        const next = (dir: 1 | -1): [number, number] | null => {
          let rr = r;
          let cc = col + dir;
          for (;;) {
            if (cc >= rows[rr].cells.length) {
              rr++;
              cc = 0;
            } else if (cc < 0) {
              rr--;
              if (rr < 0) return null;
              cc = rows[rr].cells.length - 1;
            }
            if (rr >= rows.length) return null;
            const cl = rows[rr].cells[cc];
            if (!cl.hMerge && !cl.vMerge) return [rr, cc];
            cc += dir;
          }
        };
        const move = (dir: 1 | -1) => () => {
          const n = next(dir);
          if (n) onEdit({ uid: shape.uid, cell: n, start: { selectAll: true } });
          return true;
        };
        return (
          <ShapeTextEditor
            key={`${shape.uid}:${r}:${col}`}
            body={rows[r].cells[col].text}
            look={info}
            slideNumber={ctx.slideNumber}
            start={editing.start}
            onChange={(b) => onText(shape.uid, b, cell)}
            onExit={() => onEdit(null)}
            onReady={onEditor}
            onSelection={onEditorChange}
            keys={{ ...editorKeys, Tab: move(1), 'Shift-Tab': move(-1) }}
          />
        );
      }
      if (shape.kind !== 'sp') return null;
      const chainShapes = inheritChain(shape, ctx);
      const tc = textChain(shape, chainShapes, ctx);
      // Shapes in groups don't resize themselves to their text.
      const nested = !shapeByUid.has(shape.uid);
      const auto = tc.body.autofit === 'shape' && !nested;
      const norm = tc.body.autofit === 'norm' && !nested;
      const box = boxOf(deck, slide, shape);
      const b = tc.body;
      return (
        <ShapeTextEditor
          key={`${shape.uid}`}
          body={shape.text ?? { body: {}, paras: [{ props: {}, runs: [] }] }}
          look={info}
          slideNumber={ctx.slideNumber}
          start={editing.start}
          onChange={(b) => onText(shape.uid, b)}
          onExit={() => onEdit(null)}
          onReady={onEditor}
          onSelection={onEditorChange}
          keys={editorKeys}
          onMeasure={
            auto && box
              ? ({ w, h }) => {
                  const nh = h / PX + (b.tIns ?? 45720) + (b.bIns ?? 45720);
                  const nw = w / PX + (b.lIns ?? 91440) + (b.rIns ?? 91440);
                  const grow = { ...box, h: nh, ...(b.wrap === 'none' ? { w: nw } : {}) };
                  if (Math.abs(grow.h - box.h) > 9525 || Math.abs(grow.w - box.w) > 9525) onAutoSize(shape.uid, grow);
                }
              : norm && box
                ? ({ h }) => {
                    // Shrink text on overflow, in PowerPoint's steps.
                    const avail = (box.h - (b.tIns ?? 45720) - (b.bIns ?? 45720)) * PX;
                    const scale = b.fontScale ?? 100000;
                    let i = FIT_STEPS.findIndex(([s]) => s <= scale + 1);
                    if (i < 0) i = FIT_STEPS.length - 1;
                    if (h > avail + 1 && i < FIT_STEPS.length - 1) onAutoFit(shape.uid, ...FIT_STEPS[i + 1]);
                    else if (i > 0 && (h * FIT_STEPS[i - 1][0]) / FIT_STEPS[i][0] < avail - 2) onAutoFit(shape.uid, ...FIT_STEPS[i - 1]);
                  }
                : undefined
          }
        />
      );
    },
    [editing, ctx, deck, slide, shapeByUid, onText, onEdit, onEditor, onEditorChange, editorKeys, onAutoSize, onAutoFit],
  );

  const opts = useMemo(() => ({ edit: true, editing: editing?.uid ?? null, editingCell: editing?.cell ?? null, editor: renderEditor }), [editing, renderEditor]);

  // When the text editor goes, keys come back to the canvas.
  useEffect(() => {
    const a = document.activeElement;
    if (!editing && (!a || a === document.body || !a.isConnected)) scrollRef.current?.focus({ preventScroll: true });
  }, [editing]);

  // Ctrl+wheel zooms, as in PowerPoint.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom(Math.max(0.1, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, onZoom]);

  // ---- Overlay ---------------------------------------------------------------------------

  const selected = sel.map((u) => shapeByUid.get(u)).filter((s): s is Shape => !!s);
  const editingShape = editing ? (shapeByUid.get(editing.uid) ?? (slide.shapes.find((s) => s.kind === 'grp' && findShape(s.children, editing.uid)))) : undefined;

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      className="relative min-h-0 flex-1 overflow-auto outline-none"
      style={{ background: '#e6e6e6', cursor: tool ? 'crosshair' : undefined }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        const onShape = !!(e.target as HTMLElement).closest('[data-shape]');
        onContext({ x: e.clientX, y: e.clientY }, onShape);
      }}
    >
      <div className="flex min-h-full min-w-full items-center justify-center p-6" style={{ width: 'max-content', height: 'max-content' }}>
        <div ref={slideRef} className="relative shrink-0" style={{ width: slideW, height: slideH, boxShadow: '0 0 0 1px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.18)' }}>
          <SlideImage ctx={shownCtx} width={slideW} opts={opts} />
          {gridlines && <Gridlines w={slideW} h={slideH} step={(deck.w / 16) * scale} />}
          <div className="pointer-events-none absolute inset-0" style={{ overflow: 'visible' }}>
            {live.guides?.map((g, i) =>
              g.axis === 'x' ? (
                <div key={i} className="absolute" style={{ left: g.at * scale, top: g.from * scale, height: (g.to - g.from) * scale, borderLeft: '1px dashed #e8442b' }} />
              ) : (
                <div key={i} className="absolute" style={{ top: g.at * scale, left: g.from * scale, width: (g.to - g.from) * scale, borderTop: '1px dashed #e8442b' }} />
              ),
            )}
            {live.rect && (
              <div className="absolute border border-[#6b6b6b] bg-[rgba(140,160,200,0.12)]" style={{ left: live.rect.x * scale, top: live.rect.y * scale, width: live.rect.w * scale, height: live.rect.h * scale }} />
            )}
            {live.draw && <DrawPreview a={live.draw.a} b={live.draw.b} tool={live.draw.tool} scale={scale} />}
            {!live.draw &&
              selected.map((s) => {
                const b = boxFor(s);
                if (!b) return null;
                const isLine = s.kind === 'sp' && isLineGeom(s.geom);
                return isLine ? (
                  <LineHandles key={s.uid} uid={s.uid} box={b} scale={scale} />
                ) : (
                  <SelectionBox
                    key={s.uid}
                    uid={s.uid}
                    box={b}
                    scale={scale}
                    dashed={editingShape?.uid === s.uid}
                    handles={!live.moving}
                    adjust={selected.length === 1 && s.kind === 'sp' ? adjustHandles(s.geom?.prst, (live.geoms?.get(s.uid) ?? s.geom)?.adj, b.w, b.h) : []}
                  />
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}

function applyXfrms(slide: Slide, xfrms: Map<string, Xfrm>, orig?: Map<string, Xfrm>): Slide {
  return {
    ...slide,
    shapes: slide.shapes.map((s) => {
      const x = xfrms.get(s.uid);
      if (!x) return s;
      const o = orig?.get(s.uid);
      // Tables grow their columns and rows with their frame.
      if (s.kind === 'frame' && s.table && o && o.w && o.h) {
        const kx = x.w / o.w;
        const ky = x.h / o.h;
        return { ...s, xfrm: x, table: { ...s.table, cols: s.table.cols.map((c) => c * kx), rows: s.table.rows.map((r) => ({ ...r, h: r.h * ky })) } };
      }
      return withXfrm(s, x);
    }),
  };
}

function SelectionBox({ uid, box, scale, dashed, handles, adjust }: { uid: string; box: Xfrm; scale: number; dashed: boolean; handles: boolean; adjust: [number, number][] }) {
  const w = box.w * scale;
  const h = box.h * scale;
  const rot = box.rot ?? 0;
  const small = w < 18 || h < 18;
  return (
    <div
      className="absolute"
      style={{ left: box.x * scale, top: box.y * scale, width: w, height: h, transform: rot ? `rotate(${rot}deg)` : undefined, border: dashed ? '1px dashed #707070' : '1px solid #8a8a8a', margin: -1, boxSizing: 'content-box' }}
    >
      {handles && (
        <>
          <span className="absolute left-1/2 h-[18px] w-px -translate-x-1/2 bg-[#8a8a8a]" style={{ top: -18 }} />
          <span
            data-handle="rotate"
            data-uid={uid}
            title="Rotate"
            className="pointer-events-auto absolute left-1/2 grid size-[18px] -translate-x-1/2 place-items-center rounded-full bg-white text-[#3b3b3b] shadow-[0_0_0_1px_#8a8a8a]"
            style={{ top: -30, cursor: 'grab' }}
          >
            <RotateCw className="size-3" />
          </span>
          {HANDLES.filter(([hx, hy]) => !small || (hx !== 0 && hy !== 0)).map(([hx, hy]) => (
            <span
              key={`${hx},${hy}`}
              data-handle={`${hx},${hy}`}
              data-uid={uid}
              className="pointer-events-auto absolute size-[9px] rounded-full border border-[#6b6b6b] bg-white"
              style={{ left: ((hx + 1) / 2) * w - 4.5, top: ((hy + 1) / 2) * h - 4.5, cursor: handleCursor([hx, hy], rot) }}
            />
          ))}
          {adjust.map(([ax, ay], i) => (
            <span
              key={`adj${i}`}
              data-handle={`adj:${i}`}
              data-uid={uid}
              title="Adjust"
              className="pointer-events-auto absolute size-[9px] rounded-full border border-[#5c4a00] bg-[#ffd400]"
              style={{ left: (box.flipH ? box.w - ax : ax) * scale - 4.5, top: (box.flipV ? box.h - ay : ay) * scale - 4.5, cursor: 'default' }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function LineHandles({ uid, box, scale }: { uid: string; box: Xfrm; scale: number }) {
  const [a, b] = lineEnds(box);
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const rot = rad(box.rot ?? 0);
  const at = (p: Point) => {
    const r = rotate({ x: p.x - c.x, y: p.y - c.y }, rot);
    return { x: (c.x + r.x) * scale, y: (c.y + r.y) * scale };
  };
  return (
    <>
      {([['a', a], ['b', b]] as const).map(([k, p]) => {
        const q = at(p);
        return <span key={k} data-handle={k} data-uid={uid} className="pointer-events-auto absolute size-[9px] rounded-full border border-[#6b6b6b] bg-white" style={{ left: q.x - 4.5, top: q.y - 4.5, cursor: 'move' }} />;
      })}
    </>
  );
}

function DrawPreview({ a, b, tool, scale }: { a: Point; b: Point; tool: InsertTool; scale: number }) {
  const line = tool.kind === 'shape' && (tool.prst === 'line' || tool.prst.includes('Connector'));
  if (line) {
    return (
      <svg className="absolute inset-0 overflow-visible" width="100%" height="100%">
        <line x1={a.x * scale} y1={a.y * scale} x2={b.x * scale} y2={b.y * scale} stroke="#4472c4" strokeWidth={1.5} />
      </svg>
    );
  }
  return (
    <div
      className="absolute border border-[#4472c4]"
      style={{ left: Math.min(a.x, b.x) * scale, top: Math.min(a.y, b.y) * scale, width: Math.abs(b.x - a.x) * scale, height: Math.abs(b.y - a.y) * scale, borderRadius: tool.kind === 'shape' && tool.prst === 'ellipse' ? '50%' : undefined }}
    />
  );
}

function Gridlines({ w, h, step }: { w: number; h: number; step: number }) {
  if (step < 4) return null;
  return (
    <svg className="pointer-events-none absolute inset-0" width={w} height={h}>
      <defs>
        <pattern id="sl-grid" width={step} height={step} patternUnits="userSpaceOnUse">
          <path d={`M${step} 0V${step}M0 ${step}H${step}`} fill="none" stroke="rgba(0,0,0,0.18)" strokeDasharray="1 3" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={w} height={h} fill="url(#sl-grid)" />
    </svg>
  );
}
