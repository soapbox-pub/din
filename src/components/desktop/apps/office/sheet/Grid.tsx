import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cellKey, MAX_COLS, MAX_ROWS, type Range } from './addr';
import { EditText } from './EditText';
import type { Calc } from './formulaEval';
import { mergeAt, pxToChars, sheetExtent, styleIdAt, type Sheet, type Selection, type Workbook } from './model';
import { drawScene, fontCss, Geometry, measure, resetMeasures, wrapLines, type Highlight } from './render';
import { cn } from '@/lib/utils';
import { fontStack } from '../fonts';

/**
 * The sheet itself: a canvas that draws only what's on screen, with the
 * scrollbars, the in-cell editor, and the mouse: selecting, pointing at
 * cells while writing a formula, the fill handle, resizing rows and columns
 * by their header borders.
 */

export interface GridApi {
  /** Rows on screen in the scrolling pane (for Page Up/Down). */
  pageRows(): number;
  geometry(): Geometry | null;
  reveal(r: number, c: number): void;
  topLeft(): { r: number; c: number };
  scrollTo(top: { r: number; c: number }): void;
}

export interface EditView {
  r: number;
  c: number;
  text: string;
  selStart: number;
  selEnd: number;
  where: 'cell' | 'bar';
  acIndex: number;
}

export type DragKind = 'select' | 'point' | 'none';

interface Props {
  wb: Workbook;
  sheetIndex: number;
  calc: Calc;
  sel: Selection;
  zoom: number;
  showFormulas: boolean;
  edit: EditView | null;
  highlights: Highlight[];
  marquee: Range[] | null;
  apiRef: React.RefObject<GridApi | null>;
  sinkRef: React.RefObject<HTMLTextAreaElement | null>;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  names: string[];
  onEditChange: (text: string, s: number, e: number) => void;
  onEditCaret: (s: number, e: number) => void;
  onPick: (name: string) => void;
  onEditorFocus: () => void;
  onCellDown: (r: number, c: number, e: { shift: boolean; ctrl: boolean; button: number; time: number }) => DragKind;
  onCellDrag: (r: number, c: number, kind: DragKind) => void;
  onCellUp: (kind: DragKind, time: number) => void;
  onDoubleClick: (r: number, c: number) => void;
  onHeaderDown: (kind: 'col' | 'row' | 'all', index: number, e: { shift: boolean; ctrl: boolean; button: number }) => void;
  onHeaderDrag: (kind: 'col' | 'row', index: number) => void;
  onResize: (kind: 'col' | 'row', index: number, px: number) => void;
  onAutofit: (kind: 'col' | 'row', index: number) => void;
  onFill: (src: Range, dest: Range, ctrl: boolean) => void;
  onFillDouble: () => void;
  onMoveRange: (src: Range, to: { r: number; c: number }, copy: boolean) => void;
  onContextMenu: (x: number, y: number, kind: 'cell' | 'col' | 'row') => void;
  onZoom: (delta: number) => void;
  onCopy: (e: React.ClipboardEvent) => void;
  onCut: (e: React.ClipboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  bottomBar: React.ReactNode;
  /** The horizontal scrollbar's share of the bottom bar (0..1). */
  tabShare: number;
}

const svgCursor = (svg: string, x: number, y: number, fallback: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CELL_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M7 2h6v5h5v6h-5v5H7v-5H2V7h5z" fill="#fff" stroke="#000" stroke-width="1"/></svg>',
  10,
  10,
  'cell',
);
const DOWN_CURSOR = svgCursor('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M5.5 1h5v7h3.5L8 15 2 8h3.5z" fill="#000" stroke="#fff"/></svg>', 8, 15, 's-resize');
const RIGHT_CURSOR = svgCursor('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M1 5.5v5h7v3.5L15 8 8 2v3.5z" fill="#000" stroke="#fff"/></svg>', 15, 8, 'e-resize');

const SCROLLBAR = 17;
const BAR = '[&::-webkit-scrollbar]:size-[17px] [&::-webkit-scrollbar-track]:bg-[#f3f3f3] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-[5px] [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-[#f3f3f3] [&::-webkit-scrollbar-thumb]:bg-[#bdbdbd] [&::-webkit-scrollbar-thumb:hover]:bg-[#8f8f8f] [&::-webkit-scrollbar-corner]:bg-[#f3f3f3]';
const MAX_SCROLL_PX = 8_000_000;

export function Grid(props: Props) {
  const { apiRef, sinkRef, editorRef } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const vbar = useRef<HTMLDivElement>(null);
  const hbar = useRef<HTMLDivElement>(null);
  const vspace = useRef<HTMLDivElement>(null);
  const hspace = useRef<HTMLDivElement>(null);
  const editorBox = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  const size = useRef({ w: 0, h: 0 });
  const scrolls = useRef(new Map<number, { sx: number; sy: number }>());
  const resize = useRef<{ kind: 'col' | 'row'; index: number; px: number } | null>(null);
  const fillDrag = useRef<{ src: Range; dest: Range } | null>(null);
  const frame = useRef(0);
  const ignoreScroll = useRef(0);
  const [cursor, setCursor] = useState(CELL_CURSOR);
  const geoRef = useRef<Geometry | null>(null);

  useLayoutEffect(() => {
    live.current = props;
  });

  const sheetOf = (p: Props): Sheet => {
    const s = p.wb.sheets[p.sheetIndex];
    const r = resize.current;
    if (!r) return s;
    if (r.kind === 'col') return { ...s, cols: new Map(s.cols).set(r.index, { ...s.cols.get(r.index), w: r.px, hidden: r.px === 0 ? undefined : s.cols.get(r.index)?.hidden }) };
    return { ...s, rows: new Map(s.rows).set(r.index, { ...s.rows.get(r.index), h: r.px, custom: true }) };
  };

  const scrollOf = (p: Props) => {
    const id = p.wb.sheets[p.sheetIndex].id;
    let s = scrolls.current.get(id);
    if (!s) {
      const sheet = p.wb.sheets[p.sheetIndex];
      const g = new Geometry(sheet, 1, 1, 1, 0, 0);
      const top = sheet.top;
      s = {
        sx: top.c > sheet.freeze.cols ? g.cols.pos(top.c) - g.cols.pos(sheet.freeze.cols) : 0,
        sy: top.r > sheet.freeze.rows ? g.rows.pos(top.r) - g.rows.pos(sheet.freeze.rows) : 0,
      };
      scrolls.current.set(id, s);
    }
    return s;
  };

  const makeGeo = useCallback((p: Props): Geometry => {
    const s = scrollOf(p);
    return new Geometry(sheetOf(p), p.zoom / 100, size.current.w, size.current.h, s.sx, s.sy);
  }, []);

  const draw = useCallback(() => {
    frame.current = 0;
    const p = live.current;
    const cv = canvas.current;
    if (!cv) return;
    const { w, h } = size.current;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const geo = makeGeo(p);
    geoRef.current = geo;
    const fd = fillDrag.current;
    drawScene(ctx, {
      wb: p.wb,
      sheetIndex: p.sheetIndex,
      calc: p.calc,
      geo,
      sel: p.sel,
      editing: p.edit ? { r: p.edit.r, c: p.edit.c } : null,
      marquee: p.marquee ? { ranges: p.marquee, offset: (performance.now() / 60) % 8 } : null,
      highlights: p.highlights,
      fillPreview: fd ? fd.dest : null,
      showFormulas: p.showFormulas,
    });
    // Scrollbars: the content is the used area, or further if scrolled past it.
    const sheet = geo.sheet;
    const ext = sheetExtent(sheet);
    const s = scrollOf(p);
    const viewH = (h - geo.hh - geo.fh) / geo.z;
    const viewW = (w - geo.hw - geo.fw) / geo.z;
    const contentH = Math.max(geo.rows.pos(Math.min(MAX_ROWS, ext.rows + 2)) - geo.rows.pos(geo.fr), s.sy + viewH * 1.5, viewH * 2);
    const contentW = Math.max(geo.cols.pos(Math.min(MAX_COLS, ext.cols + 2)) - geo.cols.pos(geo.fc), s.sx + viewW * 1.5, viewW * 2);
    const scaleY = Math.max(1, (contentH * geo.z) / MAX_SCROLL_PX);
    const scaleX = Math.max(1, (contentW * geo.z) / MAX_SCROLL_PX);
    if (vspace.current && vbar.current) {
      vspace.current.style.height = `${(contentH * geo.z) / scaleY + geo.hh + geo.fh}px`;
      const want = Math.round((s.sy * geo.z) / scaleY);
      if (Math.abs(vbar.current.scrollTop - want) > 1) {
        ignoreScroll.current++;
        vbar.current.scrollTop = want;
      }
    }
    if (hspace.current && hbar.current) {
      hspace.current.style.width = `${(contentW * geo.z) / scaleX + hbar.current.clientWidth}px`;
      const want = Math.round((s.sx * geo.z) / scaleX);
      if (Math.abs(hbar.current.scrollLeft - want) > 1) {
        ignoreScroll.current++;
        hbar.current.scrollLeft = want;
      }
    }
    // The in-cell editor sits over its cell and grows with its text.
    const box = editorBox.current;
    if (box && p.edit) {
      const m = mergeAt(sheet, p.edit.r, p.edit.c) ?? { r0: p.edit.r, c0: p.edit.c, r1: p.edit.r, c1: p.edit.c };
      const rc = geo.rect(m);
      const style = p.wb.styles.get(sheet.cells.get(cellKey(p.edit.r, p.edit.c))?.s ?? styleIdAt(sheet, p.edit.r, p.edit.c));
      const font = fontCss(style.font, geo.z);
      const px = ((style.font.size * 96) / 72) * geo.z;
      const lineH = Math.round(px * 1.22);
      const pad = 2 * geo.z;
      let lines: string[];
      let width = rc.w;
      if (style.wrap) lines = wrapLines(p.edit.text, font, rc.w - 2 * pad);
      else {
        lines = p.edit.text.split('\n');
        const textW = Math.max(...lines.map((l) => measure(l, font))) + 2 * pad + 8;
        width = Math.min(Math.max(rc.w, textW), Math.max(rc.w, w - rc.x - 2));
      }
      const textH = lines.length * lineH;
      const height = Math.max(rc.h, textH + 2);
      box.style.left = `${rc.x}px`;
      box.style.top = `${rc.y}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      const top = style.v === 'top' ? 1 : style.v === 'center' ? Math.max(0, (rc.h - textH) / 2) : Math.max(0, rc.h - textH - 1);
      box.style.setProperty('--pad', `${top}px ${pad}px 0 ${pad}px`);
      box.style.visibility = rc.x + 2 > geo.hw || rc.y + 2 > geo.hh ? 'visible' : 'hidden';
    }
  }, [makeGeo]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useLayoutEffect(() => {
    draw();
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // The copied range's marching ants.
  const ants = !!props.marquee;
  useEffect(() => {
    if (!ants) return;
    const id = window.setInterval(schedule, 60);
    return () => clearInterval(id);
  }, [ants, schedule]);

  // Canvas size follows its box.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      size.current = { w: Math.floor(r.width), h: Math.floor(r.height) };
      if (canvas.current) {
        canvas.current.style.width = `${size.current.w}px`;
        canvas.current.style.height = `${size.current.h}px`;
      }
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // Redraw once the document fonts arrive (text was measured with fallbacks).
  useEffect(() => {
    const onDone = () => {
      resetMeasures();
      schedule();
    };
    document.fonts?.addEventListener?.('loadingdone', onDone);
    // Canvas text doesn't ask for fonts by itself; ask for the usual ones up front.
    const faces = ['Carlito', 'Caladea', 'Arimo', 'Tinos', 'Cousine'];
    void Promise.all(faces.flatMap((f) => [`15px "${f}"`, `bold 15px "${f}"`, `italic 15px "${f}"`].map((spec) => document.fonts?.load(spec).catch(() => undefined)))).then(onDone);
    return () => document.fonts?.removeEventListener?.('loadingdone', onDone);
  }, [schedule]);

  const setScroll = useCallback(
    (sx: number, sy: number) => {
      const p = live.current;
      scrolls.current.set(p.wb.sheets[p.sheetIndex].id, { sx: Math.max(0, sx), sy: Math.max(0, sy) });
      schedule();
    },
    [schedule],
  );

  useLayoutEffect(() => {
    apiRef.current = {
      pageRows: () => {
        const g = geoRef.current;
        return g ? Math.max(1, g.lastRow - g.firstRow) : 20;
      },
      geometry: () => geoRef.current,
      reveal: (r, c) => {
        const p = live.current;
        const g = makeGeo(p);
        const n = g.reveal(Math.min(r, MAX_ROWS - 1), Math.min(c, MAX_COLS - 1));
        if (n.sx !== g.sx || n.sy !== g.sy) setScroll(n.sx, n.sy);
      },
      topLeft: () => {
        const g = geoRef.current;
        return g ? { r: g.firstRow, c: g.firstCol } : { r: 0, c: 0 };
      },
      scrollTo: (top) => {
        const g = makeGeo(live.current);
        setScroll(g.cols.pos(Math.max(top.c, g.fc)) - g.cols.pos(g.fc), g.rows.pos(Math.max(top.r, g.fr)) - g.rows.pos(g.fr));
      },
    };
  }, [apiRef, makeGeo, setScroll]);

  // ---- Mouse ---------------------------------------------------------------------------------------

  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  type Hit =
    | { kind: 'cell'; r: number; c: number }
    | { kind: 'fill' }
    | { kind: 'border' }
    | { kind: 'col'; index: number }
    | { kind: 'row'; index: number }
    | { kind: 'colEdge'; index: number }
    | { kind: 'rowEdge'; index: number }
    | { kind: 'all' }
    | { kind: 'none' };

  const hit = (x: number, y: number): Hit => {
    const g = geoRef.current ?? makeGeo(live.current);
    const p = live.current;
    if (x < 0 || y < 0 || x > g.width || y > g.height) return { kind: 'none' };
    if (y < g.hh && x < g.hw) return { kind: 'all' };
    if (y < g.hh) {
      const c = g.colAt(x);
      // Near a border: resize the column to its left (skipping hidden ones, as Excel does).
      const right = g.colEnd(c);
      const left = g.colX(c);
      if (Math.abs(x - right) <= 3) return { kind: 'colEdge', index: c };
      if (Math.abs(x - left) <= 3 && c > 0) {
        let k = c - 1;
        while (k > 0 && g.cols.size(k) === 0) k--;
        return { kind: 'colEdge', index: k };
      }
      return { kind: 'col', index: c };
    }
    if (x < g.hw) {
      const r = g.rowAt(y);
      const bottom = g.rowEnd(r);
      const top = g.rowY(r);
      if (Math.abs(y - bottom) <= 2) return { kind: 'rowEdge', index: r };
      if (Math.abs(y - top) <= 2 && r > 0) return { kind: 'rowEdge', index: r - 1 };
      return { kind: 'row', index: r };
    }
    if (!p.edit && p.sel.ranges.length === 1) {
      const last = p.sel.ranges[0];
      const rc = g.rect({ ...last, r1: Math.min(last.r1, g.lastRow + 1), c1: Math.min(last.c1, g.lastCol + 1) });
      if (Math.abs(x - (rc.x + rc.w - 1)) <= 4 && Math.abs(y - (rc.y + rc.h - 1)) <= 4) return { kind: 'fill' };
      const inside = x >= rc.x - 3 && x <= rc.x + rc.w + 2 && y >= rc.y - 3 && y <= rc.y + rc.h + 2;
      const core = x > rc.x + 2 && x < rc.x + rc.w - 3 && y > rc.y + 2 && y < rc.y + rc.h - 3;
      if (inside && !core && last.r1 - last.r0 < MAX_ROWS - 1 && last.c1 - last.c0 < MAX_COLS - 1) return { kind: 'border' };
    }
    return { kind: 'cell', r: g.rowAt(y), c: g.colAt(x) };
  };

  const autoScroll = useRef<{ timer: number; x: number; y: number } | null>(null);

  /** While dragging past an edge, keep scrolling that way. */
  const edgeScroll = (x: number, y: number, onStep: () => void) => {
    const g = geoRef.current;
    if (!g) return;
    const dx = x > g.width ? x - g.width : x < g.hw + g.fw ? x - g.hw - g.fw : 0;
    const dy = y > g.height ? y - g.height : y < g.hh + g.fh ? y - g.hh - g.fh : 0;
    if (autoScroll.current) {
      autoScroll.current.x = dx;
      autoScroll.current.y = dy;
      if (!dx && !dy) {
        clearInterval(autoScroll.current.timer);
        autoScroll.current = null;
      }
      return;
    }
    if (!dx && !dy) return;
    const state = { x: dx, y: dy, timer: 0 };
    state.timer = window.setInterval(() => {
      const s = scrollOf(live.current);
      const gz = geoRef.current?.z ?? 1;
      setScroll(s.sx + Math.sign(state.x) * Math.min(200, Math.abs(state.x)) / gz, s.sy + Math.sign(state.y) * Math.min(200, Math.abs(state.y)) / gz);
      onStep();
    }, 50);
    autoScroll.current = state;
  };

  const stopEdgeScroll = () => {
    if (autoScroll.current) clearInterval(autoScroll.current.timer);
    autoScroll.current = null;
  };

  const track = (move: (x: number, y: number, e: MouseEvent) => void, up: (x: number, y: number, e: MouseEvent) => void) => {
    let last = { x: 0, y: 0 };
    const mm = (e: MouseEvent) => {
      last = local(e);
      move(last.x, last.y, e);
      edgeScroll(last.x, last.y, () => move(last.x, last.y, e));
    };
    const mu = (e: MouseEvent) => {
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      stopEdgeScroll();
      const l = local(e);
      up(l.x, l.y, e);
    };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  };

  const clampCell = (x: number, y: number) => {
    const g = geoRef.current!;
    const cx = Math.max(g.hw + 1, Math.min(g.width - 1, x));
    const cy = Math.max(g.hh + 1, Math.min(g.height - 1, y));
    return { r: Math.max(0, g.rowAt(cy)), c: Math.max(0, g.colAt(cx)) };
  };

  const showTip = (text: string | null, x = 0, y = 0) => {
    const t = tip.current;
    if (!t) return;
    if (text === null) {
      t.style.display = 'none';
      return;
    }
    t.textContent = text;
    t.style.display = 'block';
    t.style.left = `${x + 12}px`;
    t.style.top = `${Math.max(0, y - 28)}px`;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.target !== canvas.current) return;
    const { x, y } = local(e);
    const h = hit(x, y);
    const p = live.current;
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, button: e.button, time: e.timeStamp };
    if (e.button === 2) {
      // Right-click inside the selection keeps it; outside it selects the cell first.
      if (h.kind === 'cell' && !p.sel.ranges.some((g) => h.r >= g.r0 && h.r <= g.r1 && h.c >= g.c0 && h.c <= g.c1)) p.onCellDown(h.r, h.c, { shift: false, ctrl: false, button: 0, time: e.timeStamp });
      if (h.kind === 'col' && !p.sel.ranges.some((g) => g.r0 === 0 && g.r1 === MAX_ROWS - 1 && h.index >= g.c0 && h.index <= g.c1)) p.onHeaderDown('col', h.index, { shift: false, ctrl: false, button: 0 });
      if (h.kind === 'row' && !p.sel.ranges.some((g) => g.c0 === 0 && g.c1 === MAX_COLS - 1 && h.index >= g.r0 && h.index <= g.r1)) p.onHeaderDown('row', h.index, { shift: false, ctrl: false, button: 0 });
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (!p.edit) sinkRef.current?.focus();
    if (h.kind === 'cell') {
      if (e.detail === 2) {
        p.onDoubleClick(h.r, h.c);
        return;
      }
      const kind = p.onCellDown(h.r, h.c, mods);
      if (kind === 'none') return;
      track(
        (mx, my) => {
          const c = clampCell(mx, my);
          live.current.onCellDrag(c.r, c.c, kind);
        },
        (_x, _y, ev) => live.current.onCellUp(kind, ev.timeStamp),
      );
    } else if (h.kind === 'border') {
      // Drag the selection's border to move it (Ctrl copies).
      const src = p.sel.ranges[0];
      const g = geoRef.current!;
      const grab = { r: Math.max(src.r0, Math.min(src.r1, g.rowAt(y))), c: Math.max(src.c0, Math.min(src.c1, g.colAt(x))) };
      let to = { r: src.r0, c: src.c0 };
      track(
        (mx, my) => {
          const c = clampCell(mx, my);
          to = { r: Math.max(0, src.r0 + c.r - grab.r), c: Math.max(0, src.c0 + c.c - grab.c) };
          fillDrag.current = { src, dest: { r0: to.r, c0: to.c, r1: to.r + src.r1 - src.r0, c1: to.c + src.c1 - src.c0 } };
          schedule();
        },
        (_x, _y, ev) => {
          fillDrag.current = null;
          schedule();
          if (to.r !== src.r0 || to.c !== src.c0) live.current.onMoveRange(src, to, ev.ctrlKey);
        },
      );
    } else if (h.kind === 'fill') {
      if (e.detail === 2) {
        p.onFillDouble();
        return;
      }
      const src = p.sel.ranges[0];
      fillDrag.current = { src, dest: src };
      track(
        (mx, my) => {
          const c = clampCell(mx, my);
          const fd = fillDrag.current!;
          // Extend along whichever way the pointer has gone further.
          const below = c.r - src.r1;
          const above = src.r0 - c.r;
          const right = c.c - src.c1;
          const left = src.c0 - c.c;
          const vert = Math.max(below, above);
          const horiz = Math.max(right, left);
          let dest = src;
          if (vert > 0 && vert >= horiz) dest = below > 0 ? { ...src, r1: c.r } : { ...src, r0: c.r };
          else if (horiz > 0) dest = right > 0 ? { ...src, c1: c.c } : { ...src, c0: c.c };
          fd.dest = dest;
          schedule();
        },
        (_x, _y, ev) => {
          const fd = fillDrag.current;
          fillDrag.current = null;
          schedule();
          if (fd && (fd.dest.r0 !== fd.src.r0 || fd.dest.r1 !== fd.src.r1 || fd.dest.c0 !== fd.src.c0 || fd.dest.c1 !== fd.src.c1)) live.current.onFill(fd.src, fd.dest, ev.ctrlKey);
        },
      );
    } else if (h.kind === 'col' || h.kind === 'row') {
      p.onHeaderDown(h.kind, h.index, mods);
      track(
        (mx, my) => {
          const c = clampCell(mx, my);
          live.current.onHeaderDrag(h.kind as 'col' | 'row', h.kind === 'col' ? c.c : c.r);
        },
        (_x, _y, ev) => live.current.onCellUp('select', ev.timeStamp),
      );
    } else if (h.kind === 'all') p.onHeaderDown('all', 0, mods);
    else if (h.kind === 'colEdge' || h.kind === 'rowEdge') {
      if (e.detail === 2) {
        p.onAutofit(h.kind === 'colEdge' ? 'col' : 'row', h.index);
        return;
      }
      const g = geoRef.current!;
      const isCol = h.kind === 'colEdge';
      const start = isCol ? g.colX(h.index) : g.rowY(h.index);
      const z = g.z;
      const label = (px: number) => (isCol ? `Width: ${pxToChars(px).toFixed(2)} (${Math.round(px)} pixels)` : `Height: ${(px * 0.75).toFixed(2)} (${Math.round(px)} pixels)`);
      track(
        (mx, my) => {
          const px = Math.max(0, Math.round(((isCol ? mx : my) - start) / z));
          resize.current = { kind: isCol ? 'col' : 'row', index: h.index, px };
          showTip(label(px), mx, my);
          schedule();
        },
        () => {
          const r = resize.current;
          resize.current = null;
          showTip(null);
          if (r) live.current.onResize(r.kind, r.index, r.px);
          schedule();
        },
      );
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (e.buttons) return;
    const { x, y } = local(e);
    const h = hit(x, y);
    const p = live.current;
    const next =
      h.kind === 'fill'
        ? 'crosshair'
        : h.kind === 'border'
          ? 'move'
          : h.kind === 'colEdge'
          ? 'col-resize'
          : h.kind === 'rowEdge'
            ? 'row-resize'
            : h.kind === 'col'
              ? DOWN_CURSOR
              : h.kind === 'row'
                ? RIGHT_CURSOR
                : h.kind === 'all'
                  ? 'default'
                  : h.kind === 'cell' && p.wb.sheets[p.sheetIndex].links.has(cellKey(h.r, h.c)) && !p.edit
                    ? 'pointer'
                    : CELL_CURSOR;
    if (next !== cursor) setCursor(next);
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = live.current;
    if (e.ctrlKey || e.metaKey) {
      p.onZoom(e.deltaY < 0 ? 10 : -10);
      return;
    }
    const s = scrollOf(p);
    const z = p.zoom / 100;
    const unit = e.deltaMode === 1 ? 20 : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    setScroll(s.sx + dx / z, s.sy + dy / z);
  };

  // Native wheel listener so ctrl+wheel doesn't zoom the page.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  const onVScroll = () => {
    if (ignoreScroll.current) {
      ignoreScroll.current--;
      return;
    }
    const g = geoRef.current;
    const el = vbar.current;
    if (!g || !el || !vspace.current) return;
    const contentPx = parseFloat(vspace.current.style.height) - g.hh - g.fh;
    const scale = Math.max(1, contentPx > 0 ? (MAX_SCROLL_PX < contentPx ? contentPx / MAX_SCROLL_PX : 1) : 1);
    const s = scrollOf(live.current);
    setScroll(s.sx, (el.scrollTop * scale) / g.z);
  };

  const onHScroll = () => {
    if (ignoreScroll.current) {
      ignoreScroll.current--;
      return;
    }
    const g = geoRef.current;
    const el = hbar.current;
    if (!g || !el) return;
    const s = scrollOf(live.current);
    setScroll(el.scrollLeft / g.z, s.sy);
  };

  const p = props;
  const sheet = p.wb.sheets[p.sheetIndex];
  const z = p.zoom / 100;
  const editStyle = p.edit ? p.wb.styles.get(sheet.cells.get(cellKey(p.edit.r, p.edit.c))?.s ?? styleIdAt(sheet, p.edit.r, p.edit.c)) : null;
  const editPx = editStyle ? ((editStyle.font.size * 96) / 72) * z : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          ref={host}
          className="relative min-w-0 flex-1 overflow-hidden bg-white"
          style={{ cursor }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
          onContextMenu={(e) => {
            e.preventDefault();
            const { x, y } = local(e);
            const h = hit(x, y);
            if (h.kind === 'cell' || h.kind === 'col' || h.kind === 'row') live.current.onContextMenu(e.clientX, e.clientY, h.kind);
          }}
        >
          <canvas ref={canvas} className="absolute top-0 left-0" />
          <textarea
            ref={sinkRef}
            aria-label="Worksheet"
            className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
            readOnly
            value=""
            onCopy={p.onCopy}
            onCut={p.onCut}
            onPaste={p.onPaste}
          />
          {p.edit && editStyle && (
            <div
              ref={editorBox}
              className="absolute z-10 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.0)]"
              style={{
                fontFamily: fontStack(editStyle.font.name),
                fontSize: `${editPx * (editStyle.font.vert ? 0.7 : 1)}px`,
                fontWeight: editStyle.font.bold ? 700 : 400,
                fontStyle: editStyle.font.italic ? 'italic' : 'normal',
                lineHeight: `${Math.round(editPx * 1.22)}px`,
                color: editStyle.font.color ? `#${editStyle.font.color}` : '#000',
                textDecoration: [editStyle.font.underline ? 'underline' : '', editStyle.font.strike ? 'line-through' : ''].join(' ').trim() || undefined,
                textAlign: editStyle.h === 'center' ? 'center' : editStyle.h === 'right' ? 'right' : 'left',
                outline: '2px solid #107c41',
                outlineOffset: '-1px',
              }}
            >
              <EditText
                inputRef={editorRef}
                label="Cell editor"
                value={p.edit.text}
                selStart={p.edit.selStart}
                selEnd={p.edit.selEnd}
                onChange={p.onEditChange}
                onCaret={p.onEditCaret}
                onFocus={p.onEditorFocus}
                className="size-full"
                pad="var(--pad)"
                wrap={!!editStyle.wrap}
                active={p.edit.where === 'cell'}
                colored
                acIndex={p.edit.acIndex}
                onPick={p.onPick}
                names={p.names}
              />
            </div>
          )}
          <div ref={tip} className="pointer-events-none absolute z-20 hidden rounded-[3px] border border-[#bdbdbd] bg-white px-1.5 py-0.5 text-[11.5px] whitespace-nowrap text-[#242424] shadow-sm" />
        </div>
        <div ref={vbar} onScroll={onVScroll} className={cn(BAR, 'shrink-0 overflow-x-hidden overflow-y-scroll bg-[#f3f3f3]')} style={{ width: SCROLLBAR }}>
          <div ref={vspace} style={{ width: 1 }} />
        </div>
      </div>
      <div className="flex h-[30px] shrink-0 items-stretch border-t border-[#d6d6d6] bg-[#f3f3f3]">
        <div className="flex min-w-0 items-stretch" style={{ flex: `0 1 ${Math.round(p.tabShare * 100)}%` }}>
          {p.bottomBar}
        </div>
        <div ref={hbar} onScroll={onHScroll} className={cn(BAR, 'min-w-24 flex-1 self-center overflow-x-scroll overflow-y-hidden')} style={{ height: SCROLLBAR }}>
          <div ref={hspace} style={{ height: 1 }} />
        </div>
        <div className="shrink-0" style={{ width: SCROLLBAR }} />
      </div>
    </div>
  );
}
