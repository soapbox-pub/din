import { quad, toPath2D } from './geom';
import { apply, mul, UNIT_PT, type Artboard, type Doc, type Item, type Mat, type Point, type Rect, type TextItem, type Units } from './model';
import { caretAt, layoutText } from './text';
import { viewMat, type View } from './render';

/**
 * What Illustrator draws over the art: selected paths in their layer's
 * color, the bounding box and its handles, anchor points and direction
 * lines, the marquee, smart guides, the type cursor and rulers.
 */

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
  const y = h.startsWith('n') ? r.y : h.startsWith('s') ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

export interface Overlay {
  /** Selected items with their layers' colors. */
  selection: { item: Item; color: string }[];
  bbox: Rect | null;
  bboxColor: string;
  showBox: boolean;
  /** Direct selection: paths whose anchors show, and which are selected. */
  anchors: { item: Item; color: string; selected: Set<string> } [];
  marquee: Rect | null;
  /** Lines in document space (pen preview, gradient vector, reflect axis). */
  lines: { a: Point; b: Point; color: string; dash?: boolean }[];
  /** Dots in document space. */
  dots: { p: Point; color: string; r?: number; square?: boolean; hollow?: boolean }[];
  guides: { a: Point; b: Point; label?: string; at?: Point }[];
  caret: { item: TextItem; start: number; end: number; on: boolean } | null;
  artboards: { boards: Artboard[]; active: number; tool: boolean };
  origin: Point | null;
  /** A shape being drawn, in document space. */
  ghost: Path2D | null;
  ghostColor: string;
  /** The art under the pointer, outlined. */
  hover: { item: Item; color: string } | null;
}

export function emptyOverlay(): Overlay {
  return {
    selection: [],
    bbox: null,
    bboxColor: '#4f80ff',
    showBox: true,
    anchors: [],
    marquee: null,
    lines: [],
    dots: [],
    guides: [],
    caret: null,
    artboards: { boards: [], active: 0, tool: false },
    origin: null,
    ghost: null,
    ghostColor: '#4f80ff',
    hover: null,
  };
}

function leafOutlines(c: CanvasRenderingContext2D, it: Item, doc: Doc, m: Mat, dpr: number) {
  if (it.hidden) return;
  if (it.type === 'path') {
    c.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
    c.lineWidth = 1 / m[0];
    c.stroke(toPath2D(it.paths));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineWidth = 1;
    // Anchors as small solid squares.
    for (const sp of it.paths) {
      for (const n of sp.nodes) {
        const p = apply(m, n.x, n.y);
        c.fillRect(Math.round(p.x) - 1.5, Math.round(p.y) - 1.5, 3, 3);
      }
    }
  } else if (it.type === 'image' || it.type === 'text') {
    const q = it.type === 'image' ? quad(it.matrix) : (() => {
      const l = layoutText(it, doc.res);
      return quad(it.matrix, l.box.x, l.box.y, l.box.w, l.box.h);
    })();
    c.beginPath();
    q.forEach((p, i) => {
      const s = apply(m, p.x, p.y);
      if (i) c.lineTo(s.x, s.y);
      else c.moveTo(s.x, s.y);
    });
    c.closePath();
    c.stroke();
    if (it.type === 'text') {
      // Baselines, as Illustrator underlines selected type.
      const l = layoutText(it, doc.res);
      for (const ln of l.lines) {
        const a = apply(mul(it.matrix, m), ln.x, ln.y);
        const b = apply(mul(it.matrix, m), ln.x + Math.max(ln.width, 1), ln.y);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
      const o = apply(mul(it.matrix, m), 0, it.area ? 0 : 0);
      c.fillRect(o.x - 2, o.y - 2, 4, 4);
    }
  } else {
    const kids = it.clip ? it.children.slice(0, 1) : it.children;
    for (const k of kids) leafOutlines(c, k, doc, m, dpr);
  }
}

/** An item's outline only (no anchors), for object highlighting. */
function hoverOutline(c: CanvasRenderingContext2D, it: Item, doc: Doc, m: Mat, dpr: number) {
  if (it.hidden) return;
  if (it.type === 'path') {
    c.save();
    c.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
    c.lineWidth = 1.5 / m[0];
    c.stroke(toPath2D(it.paths));
    c.restore();
  } else if (it.type === 'group') {
    for (const k of it.clip ? it.children.slice(0, 1) : it.children) hoverOutline(c, k, doc, m, dpr);
  } else {
    const q = it.type === 'image' ? quad(it.matrix) : (() => {
      const l = layoutText(it, doc.res);
      return quad(it.matrix, l.box.x, l.box.y, l.box.w, l.box.h);
    })();
    c.beginPath();
    q.forEach((p, i) => {
      const s = apply(m, p.x, p.y);
      if (i) c.lineTo(s.x, s.y);
      else c.moveTo(s.x, s.y);
    });
    c.closePath();
    c.stroke();
  }
}

export function drawOverlay(c: CanvasRenderingContext2D, doc: Doc, view: View, dpr: number, o: Overlay) {
  const m = viewMat(view, 1);
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.lineWidth = 1;
  c.setLineDash([]);
  const S = (p: Point) => apply(m, p.x, p.y);

  // Artboard labels and frames when the Artboard tool is on.
  if (o.artboards.tool) {
    c.font = '11px "Inter Variable", sans-serif';
    o.artboards.boards.forEach((ab, i) => {
      const a = S({ x: ab.x, y: ab.y });
      const b = S({ x: ab.x + ab.w, y: ab.y + ab.h });
      c.strokeStyle = i === o.artboards.active ? '#2d8ceb' : '#9a9a9a';
      c.lineWidth = i === o.artboards.active ? 2 : 1;
      c.setLineDash(i === o.artboards.active ? [] : [4, 3]);
      c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      c.setLineDash([]);
      c.fillStyle = '#e6e6e6';
      c.fillText(`${String(i + 1).padStart(2, '0')} - ${ab.name}`, a.x, a.y - 6);
      if (i === o.artboards.active) {
        c.fillStyle = '#ffffff';
        c.strokeStyle = '#2d8ceb';
        c.lineWidth = 1;
        for (const h of HANDLES) {
          const p = S(handlePoint({ x: ab.x, y: ab.y, w: ab.w, h: ab.h }, h));
          c.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
          c.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
        }
      }
    });
  } else {
    c.font = '11px "Inter Variable", sans-serif';
    c.fillStyle = '#d6d6d6';
    if (o.artboards.boards.length > 1) {
      o.artboards.boards.forEach((ab, i) => {
        const a = S({ x: ab.x, y: ab.y });
        c.fillText(`${String(i + 1).padStart(2, '0')} - ${ab.name}`, a.x, a.y - 6);
      });
    }
  }

  if (o.hover) {
    c.strokeStyle = o.hover.color;
    c.fillStyle = 'transparent';
    c.lineWidth = 1.5;
    hoverOutline(c, o.hover.item, doc, m, dpr);
    c.lineWidth = 1;
  }

  // Selected art in its layer color.
  for (const { item, color } of o.selection) {
    c.strokeStyle = color;
    c.fillStyle = color;
    leafOutlines(c, item, doc, m, dpr);
  }

  // Bounding box.
  if (o.bbox && o.showBox) {
    const a = S({ x: o.bbox.x, y: o.bbox.y });
    const b = S({ x: o.bbox.x + o.bbox.w, y: o.bbox.y + o.bbox.h });
    c.strokeStyle = o.bboxColor;
    c.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    c.fillStyle = '#ffffff';
    for (const h of HANDLES) {
      const p = S(handlePoint(o.bbox, h));
      c.fillRect(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6);
      c.strokeRect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
    }
    // Center point.
    const mid = S({ x: o.bbox.x + o.bbox.w / 2, y: o.bbox.y + o.bbox.h / 2 });
    c.fillStyle = o.bboxColor;
    c.fillRect(Math.round(mid.x) - 1.5, Math.round(mid.y) - 1.5, 3, 3);
  }

  // Anchors and direction lines (Direct Selection).
  for (const { item, color, selected } of o.anchors) {
    if (item.type !== 'path') continue;
    c.strokeStyle = color;
    c.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
    c.lineWidth = 1 / view.zoom;
    c.stroke(toPath2D(item.paths));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineWidth = 1;
    item.paths.forEach((sp, si) =>
      sp.nodes.forEach((n, ni) => {
        const p = S(n);
        const sel = selected.has(`${si}:${ni}`);
        if (sel) {
          // Direction lines of selected anchors (and their neighbors', as Illustrator shows them).
          for (const [hx, hy] of [
            [n.ix, n.iy],
            [n.ox, n.oy],
          ]) {
            if (Math.abs(hx - n.x) < 1e-6 && Math.abs(hy - n.y) < 1e-6) continue;
            const h = S({ x: hx, y: hy });
            c.beginPath();
            c.moveTo(p.x, p.y);
            c.lineTo(h.x, h.y);
            c.stroke();
            c.beginPath();
            c.arc(h.x, h.y, 2.5, 0, Math.PI * 2);
            c.fillStyle = color;
            c.fill();
          }
        }
        c.fillStyle = sel ? color : '#ffffff';
        c.fillRect(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6);
        c.strokeRect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
      }),
    );
  }

  // Shape being drawn.
  if (o.ghost) {
    c.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
    c.lineWidth = 1 / view.zoom;
    c.strokeStyle = o.ghostColor;
    c.stroke(o.ghost);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineWidth = 1;
  }

  for (const l of o.lines) {
    const a = S(l.a);
    const b = S(l.b);
    c.strokeStyle = l.color;
    c.setLineDash(l.dash ? [4, 3] : []);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.setLineDash([]);
  }
  for (const d of o.dots) {
    const p = S(d.p);
    const r = d.r ?? 3;
    c.fillStyle = d.hollow ? '#ffffff' : d.color;
    c.strokeStyle = d.color;
    if (d.square) {
      c.fillRect(Math.round(p.x) - r, Math.round(p.y) - r, r * 2, r * 2);
      c.strokeRect(Math.round(p.x) - r + 0.5, Math.round(p.y) - r + 0.5, r * 2 - 1, r * 2 - 1);
    } else {
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
  }

  // Rotate/scale/reflect origin: Illustrator's crosshair target.
  if (o.origin) {
    const p = S(o.origin);
    c.strokeStyle = '#2d8ceb';
    c.beginPath();
    c.arc(p.x, p.y, 4, 0, Math.PI * 2);
    c.moveTo(p.x - 8, p.y);
    c.lineTo(p.x + 8, p.y);
    c.moveTo(p.x, p.y - 8);
    c.lineTo(p.x, p.y + 8);
    c.stroke();
  }

  // Smart guides.
  c.strokeStyle = '#ff00ff';
  c.fillStyle = '#ff00ff';
  c.font = '10px "Inter Variable", sans-serif';
  for (const g of o.guides) {
    const a = S(g.a);
    const b = S(g.b);
    c.beginPath();
    c.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    c.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    c.stroke();
    if (g.label && g.at) {
      const p = S(g.at);
      c.fillText(g.label, p.x + 6, p.y - 6);
    }
  }

  if (o.marquee) {
    const a = S({ x: o.marquee.x, y: o.marquee.y });
    const b = S({ x: o.marquee.x + o.marquee.w, y: o.marquee.y + o.marquee.h });
    c.strokeStyle = '#000';
    c.setLineDash([3, 3]);
    c.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
    c.strokeStyle = '#fff';
    c.lineDashOffset = 3;
    c.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
    c.setLineDash([]);
    c.lineDashOffset = 0;
  }

  // Type: selection highlight and caret.
  if (o.caret) {
    const t = o.caret.item;
    const layout = layoutText(t, doc.res);
    const tm = mul(t.matrix, m);
    c.setTransform(tm[0] * dpr, tm[1] * dpr, tm[2] * dpr, tm[3] * dpr, tm[4] * dpr, tm[5] * dpr);
    if (o.caret.start !== o.caret.end) {
      const lo = Math.min(o.caret.start, o.caret.end);
      const hi = Math.max(o.caret.start, o.caret.end);
      c.fillStyle = 'rgba(45,140,235,0.35)';
      for (const ln of layout.lines) {
        const s = Math.max(lo, ln.start);
        const e = Math.min(hi, ln.end);
        if (e < s || (e === s && !(hi > ln.end && lo <= ln.end))) continue;
        const xa = caretAt(layout, s).x;
        const xb = hi > ln.end ? ln.x + ln.width + 4 : caretAt(layout, e).x;
        c.fillRect(xa, ln.y - ln.ascent, Math.max(1, xb - xa), ln.ascent + ln.descent);
      }
    }
    if (o.caret.on) {
      const at = caretAt(layout, o.caret.end);
      const ln = layout.lines[at.line];
      c.fillStyle = '#000000';
      const k = Math.sqrt(Math.abs(tm[0] * tm[3] - tm[1] * tm[2])) || 1;
      c.fillRect(at.x - 0.5 / k, ln.y - ln.ascent, 1.25 / k, ln.ascent + ln.descent);
    }
    if (t.area) {
      c.strokeStyle = '#4f80ff';
      c.lineWidth = 1 / (Math.sqrt(Math.abs(tm[0] * tm[3])) || 1);
      c.strokeRect(0, 0, t.area.w, t.area.h);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  c.restore();
}

/** Rulers along the top and left, in the document's units from the active artboard's corner. */
export function drawRulers(c: CanvasRenderingContext2D, view: View, dpr: number, w: number, h: number, origin: Point, units: Units, pointer: Point | null) {
  const R = 18;
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#323232';
  c.fillRect(0, 0, w, R);
  c.fillRect(0, 0, R, h);
  c.strokeStyle = '#8a8a8a';
  c.fillStyle = '#bdbdbd';
  c.font = '9px "Inter Variable", sans-serif';
  const k = UNIT_PT[units];
  // A step that leaves ~60px between numbers.
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const per = view.zoom * k;
  const step = steps.find((s) => s * per >= 60) ?? 10000;
  const sub = step / 10;
  c.lineWidth = 1;
  c.beginPath();
  const x0 = Math.floor((-view.x / view.zoom - origin.x) / k / step) * step;
  for (let u = x0; ; u += sub) {
    const sx = (origin.x + u * k) * view.zoom + view.x;
    if (sx > w) break;
    if (sx < R) continue;
    const major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
    const half = Math.abs(u / (step / 2) - Math.round(u / (step / 2))) < 1e-6;
    c.moveTo(Math.round(sx) + 0.5, R);
    c.lineTo(Math.round(sx) + 0.5, major ? 2 : half ? R - 8 : R - 4);
    if (major) c.fillText(String(Math.round(u * 100) / 100), sx + 2, 9);
  }
  const y0 = Math.floor((-view.y / view.zoom - origin.y) / k / step) * step;
  for (let u = y0; ; u += sub) {
    const sy = (origin.y + u * k) * view.zoom + view.y;
    if (sy > h) break;
    if (sy < R) continue;
    const major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
    const half = Math.abs(u / (step / 2) - Math.round(u / (step / 2))) < 1e-6;
    c.moveTo(R, Math.round(sy) + 0.5);
    c.lineTo(major ? 2 : half ? R - 8 : R - 4, Math.round(sy) + 0.5);
    if (major) {
      c.save();
      c.translate(9, sy + 2);
      c.rotate(-Math.PI / 2);
      c.fillText(String(Math.round(u * 100) / 100), -c.measureText(String(Math.round(u * 100) / 100)).width, 0);
      c.restore();
    }
  }
  c.stroke();
  if (pointer) {
    const sx = pointer.x * view.zoom + view.x;
    const sy = pointer.y * view.zoom + view.y;
    c.strokeStyle = '#ffffff';
    c.beginPath();
    c.moveTo(Math.round(sx) + 0.5, 0);
    c.lineTo(Math.round(sx) + 0.5, R);
    c.moveTo(0, Math.round(sy) + 0.5);
    c.lineTo(R, Math.round(sy) + 0.5);
    c.stroke();
  }
  c.fillStyle = '#323232';
  c.fillRect(0, 0, R, R);
  c.strokeStyle = '#232323';
  c.beginPath();
  c.moveTo(0, R + 0.5);
  c.lineTo(w, R + 0.5);
  c.moveTo(R + 0.5, 0);
  c.lineTo(R + 0.5, h);
  c.stroke();
  c.restore();
}
