import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { cleanFsError, getFsBridge, parentPath } from '@/lib/fs';
import { setCloseGuard } from '@/lib/closeGuards';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
  RetroButton,
  RetroDialog,
} from './paint/chrome';
import { FIELD, FOCUS, RETRO_FONT, SUNKEN } from './paint/styles';
import { decode, encode, OPEN_EXTENSIONS, pngBlob, SAVE_TYPES, savesAs } from './paint/codec';
import * as fx from './paint/effects';
import { iconCursor } from './paint/iconData';
import { ColorBox, OptionsBox, ToolBox, Tray, type ToolOptions, type TraySettings } from './paint/panels';
import { TOOLS, type Tool } from './paint/tools';
import { patternFn } from './paint/patterns';
import { CANVAS_PRESETS, FONTS, PALETTES, ZOOMS } from './paint/presets';
import {
  bezier,
  dab,
  fillPolygon,
  floodFill,
  glyphSurface,
  hsl,
  line,
  pack,
  rectFrom,
  shape,
  Surface,
  textSurface,
  TRANSPARENT,
  unpack,
  type Color,
  type Packed,
  type Rect,
} from './paint/raster';
import { setSoundEnabled, sfx, startScribble, scribbleSpeed, stopScribble, type ScribbleKind } from './paint/sounds';

const MAX_UNDO = 40;
const MAX_BYTES = 256 * 1024 * 1024;
const SETTINGS_KEY = 'din:paint:settings';
const WHITE = pack('#ffffff');

type Symmetry = 'off' | 'h' | 'v' | 'both';

interface Settings {
  sound: boolean;
  grid: boolean;
  paletteId: string;
  palettes: Record<string, Color[]>;
  options: ToolOptions;
  tray: TraySettings;
}

const DEFAULT_SETTINGS: Settings = {
  sound: true,
  grid: true,
  paletteId: 'classic',
  palettes: {},
  options: {
    brush: { size: 4, shape: 'round' },
    eraserSize: 8,
    lineWidth: 1,
    sprayRadius: 8,
    fillMode: 'outline',
    selectTransparent: false,
  },
  tray: {
    wacky: 'rainbow',
    stamp: '🐱',
    stampGroup: 0,
    stampSize: 48,
    pattern: 'solid',
    mixer: 'invert',
    font: 'sans',
    fontSize: 16,
    bold: false,
    crisp: true,
  },
};

function readSettings(): Settings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
    const s = saved as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      options: { ...DEFAULT_SETTINGS.options, ...s.options },
      tray: { ...DEFAULT_SETTINGS.tray, ...s.tray },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(4096, Math.round(v)) : fallback;
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

interface Snapshot {
  surface: Surface;
  id: number;
}

interface Selection extends Rect {
  floating: boolean;
}

/** Everything one press-drag-release of the mouse needs to remember. */
interface Stroke {
  tool: Tool;
  right: boolean;
  fg: Packed;
  bg: Packed;
  x0: number;
  y0: number;
  x: number;
  y: number;
  base: Surface | null;
  box: Rect | null;
  traveled: number;
  next: number;
  hue: number;
  zig: [number, number] | null;
  zigSign: number;
  moved: boolean;
  move: { sx: number; sy: number; ox: number; oy: number } | null;
  marquee: boolean;
  /** This press began a new polygon. */
  fresh: boolean;
}

interface Drip {
  x: number;
  y: number;
  left: number;
  c: Packed;
  w: number;
}

interface Poly {
  points: [number, number][];
  base: Surface;
  fg: Packed;
  bg: Packed;
}

interface Curve {
  phase: 0 | 1 | 2;
  p0: [number, number];
  p1: [number, number];
  p3: [number, number];
  base: Surface;
  fg: Packed;
}

const CURSORS: Partial<Record<Tool, string>> = {
  pencil: iconCursor('pencil', [2, 13]),
  fill: iconCursor('fill', [13, 13]),
  picker: iconCursor('picker', [1, 13]),
  magnifier: iconCursor('magnifier', [5, 5]),
  stamp: iconCursor('stamp', [8, 13]),
  mixer: iconCursor('mixer', [2, 13]),
  dynamite: iconCursor('dynamite', [11, 1]),
  text: 'text',
};

/** Snap a drag to level, plumb or 45°. */
function snap45(x0: number, y0: number, x: number, y: number): [number, number] {
  const dx = x - x0;
  const dy = y - y0;
  if (Math.abs(dx) > 2 * Math.abs(dy)) return [x, y0];
  if (Math.abs(dy) > 2 * Math.abs(dx)) return [x0, y];
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return [x0 + Math.sign(dx) * d, y0 + Math.sign(dy) * d];
}

function snapSquare(x0: number, y0: number, x: number, y: number): [number, number] {
  const d = Math.max(Math.abs(x - x0), Math.abs(y - y0));
  return [x0 + (x < x0 ? -d : d), y0 + (y < y0 ? -d : d)];
}

/** A five-pointed twinkle, for the sparkle brush. */
function twinkle(s: Surface, x: number, y: number, c: Packed, big: boolean) {
  s.set(x, y, c);
  for (let i = 1; i <= (big ? 3 : 2); i++) {
    s.set(x + i, y, c);
    s.set(x - i, y, c);
    s.set(x, y + i, c);
    s.set(x, y - i, c);
  }
  if (big) {
    s.set(x + 1, y + 1, c);
    s.set(x - 1, y - 1, c);
    s.set(x + 1, y - 1, c);
    s.set(x - 1, y + 1, c);
  }
}

/**
 * Paint - a 1998-style paint program with Kid Pix's sillier tools and
 * what pixel artists need: hard-edged drawing, big zoom with a grid,
 * symmetry, see-through backgrounds, game palettes and an outline effect.
 *
 * Launch params: `{ path?: string }` opens a picture; `{ width?, height?,
 * transparent?, zoom? }` sets up a new one.
 */
export function Paint({ windowId, params }: AppComponentProps) {
  const fs = getFsBridge();
  const { open, close, focus } = useWindowActions();
  const { pickFile, pickFiles } = useFilePicker();
  const queryClient = useQueryClient();
  const initialPath = typeof params?.path === 'string' ? params.path : null;

  const [initial] = useState(() => ({
    width: num(params?.width, 640),
    height: num(params?.height, 480),
    transparent: params?.transparent === true,
    zoom: num(params?.zoom, 1),
  }));

  const [settings, setSettings] = useState(readSettings);
  const { sound, grid, paletteId, options, tray } = settings;
  const palette = settings.palettes[paletteId] ?? PALETTES.find((p) => p.id === paletteId)?.colors ?? PALETTES[0].colors;
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => setSoundEnabled(sound), [sound]);

  const [tool, setToolState] = useState<Tool>('pencil');
  const [prevTool, setPrevTool] = useState<Tool>('pencil');
  const [primary, setPrimary] = useState<Color>('#000000');
  const [secondary, setSecondary] = useState<Color>(initial.transparent ? TRANSPARENT : '#ffffff');
  const [size, setSize] = useState({ w: initial.width, h: initial.height });
  const [zoom, setZoom] = useState(Math.min(32, initial.zoom));
  const [symmetry, setSymmetry] = useState<Symmetry>('off');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [floatVersion, setFloatVersion] = useState(0);
  const [textBox, setTextBox] = useState<{ x: number; y: number; value: string } | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [docId, setDocId] = useState(0);
  const [savedId, setSavedId] = useState(0);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [loading, setLoading] = useState(initialPath !== null && fs !== undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'unsaved' | 'attributes' | 'about' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ w: number; h: number } | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; color: Color } | null>(null);

  const gridId = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floatRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const posRef = useRef<HTMLSpanElement>(null);

  const surfRef = useRef<Surface | null>(null);
  const floatingRef = useRef<Surface | null>(null);
  const clipRef = useRef<Surface | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const idRef = useRef({ current: 0, next: 1 });
  const strokeRef = useRef<Stroke | null>(null);
  const polyRef = useRef<Poly | null>(null);
  const curveRef = useRef<Curve | null>(null);
  const dripsRef = useRef<Drip[]>([]);
  const loopRef = useRef(0);
  const flushRef = useRef(0);
  const scrollToRef = useRef<{ left: number; top: number } | null>(null);
  const loadSeq = useRef(0);

  const dirty = docId !== savedId;
  const name = path ? basename(path) : 'untitled';
  useWindowTitle(`${dirty ? '• ' : ''}${name}`);

  const surf = () => surfRef.current!;

  // ---- Showing the pixels ------------------------------------------------

  const flushNow = () => {
    flushRef.current = 0;
    const s = surfRef.current;
    const ctx = canvasRef.current?.getContext('2d');
    if (!s || !ctx) return;
    const d = s.takeDirty();
    if (d) ctx.putImageData(s.image, 0, 0, d.x, d.y, d.w, d.h);
  };
  const flush = () => {
    if (!flushRef.current) flushRef.current = requestAnimationFrame(flushNow);
  };

  const replaceSurface = (s: Surface) => {
    surfRef.current = s;
    const c = canvasRef.current;
    if (c) {
      c.width = s.width;
      c.height = s.height;
      c.getContext('2d')?.putImageData(s.image, 0, 0);
    }
    s.takeDirty();
    setSize({ w: s.width, h: s.height });
  };

  useLayoutEffect(() => {
    if (!surfRef.current) {
      replaceSurface(Surface.filled(initial.width, initial.height, initial.transparent ? 0 : WHITE));
    }
    return () => {
      cancelAnimationFrame(loopRef.current);
      cancelAnimationFrame(flushRef.current);
      stopScribble();
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shortcuts work as soon as the window opens.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Keep the point under the mouse still while zooming.
  useLayoutEffect(() => {
    const ws = wsRef.current;
    const to = scrollToRef.current;
    if (ws && to) {
      ws.scrollLeft = to.left;
      ws.scrollTop = to.top;
      scrollToRef.current = null;
    }
  }, [zoom]);

  // The lifted-up selection, drawn on a canvas of its own so it can move.
  useLayoutEffect(() => {
    const f = floatingRef.current;
    const c = floatRef.current;
    if (!f || !c || !selection?.floating) return;
    c.width = f.width;
    c.height = f.height;
    let img = f;
    if (options.selectTransparent) {
      img = f.clone();
      const key = pack(secondary);
      for (let i = 0; i < img.px.length; i++) if (img.px[i] === key) img.px[i] = 0;
    }
    c.getContext('2d')?.putImageData(img.image, 0, 0);
  }, [selection?.floating, floatVersion, options.selectTransparent, secondary]);

  // ---- Undo --------------------------------------------------------------

  const setId = (id: number) => {
    idRef.current.current = id;
    setDocId(id);
  };
  const syncHistory = () => setHistory({ undo: undoRef.current.length, redo: redoRef.current.length });

  /** Remember the picture as it is, before changing it. */
  const checkpoint = () => {
    undoRef.current.push({ surface: surf().clone(), id: idRef.current.current });
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
    setId(idRef.current.next++);
    syncHistory();
    setStatus(null);
  };

  /** Forget the last checkpoint: nothing changed after all. */
  const dropCheckpoint = () => {
    const last = undoRef.current.pop();
    if (last) setId(last.id);
    syncHistory();
  };

  // ---- Finishing things that are still in progress -------------------------

  const commitText = () => {
    if (!textBox) return;
    setTextBox(null);
    if (!textBox.value.trim()) return;
    const font = FONTS.find((f) => f.id === tray.font) ?? FONTS[0];
    const ts = textSurface(
      textBox.value,
      `${tray.bold ? 'bold ' : ''}${tray.fontSize}px ${font.css}`,
      tray.fontSize,
      pack(primary),
      tray.crisp,
    );
    if (!ts) return;
    checkpoint();
    surf().paste(ts, textBox.x, textBox.y, undefined, true);
    flush();
  };

  const finishPoly = () => {
    const p = polyRef.current;
    if (!p) return;
    polyRef.current = null;
    const s = surf();
    s.restore(p.base, { x: 0, y: 0, w: s.width, h: s.height });
    const stroke = options.fillMode === 'fill' ? null : p.fg;
    const fill = options.fillMode === 'outline' ? null : options.fillMode === 'fill' ? p.fg : p.bg;
    if (fill !== null) fillPolygon(s, p.points, fill);
    if (stroke !== null) {
      p.points.forEach(([x, y], i) => {
        const [nx, ny] = p.points[(i + 1) % p.points.length];
        if (p.points.length > 1) line(x, y, nx, ny, (px, py) => dab(s, px, py, options.lineWidth, 'round', stroke));
        else dab(s, x, y, options.lineWidth, 'round', stroke);
      });
    }
    flush();
    sfx.pop();
  };

  const finishCurve = () => {
    if (curveRef.current) {
      curveRef.current = null;
      sfx.pop();
    }
  };

  const commitSelection = () => {
    const f = floatingRef.current;
    if (f && selection) {
      surf().paste(f, selection.x, selection.y, options.selectTransparent ? pack(secondary) : undefined);
      flush();
    }
    floatingRef.current = null;
    setSelection(null);
  };

  /** Put down anything half-done: text being typed, a polygon, a selection. */
  const settle = (keepSelection = false) => {
    commitText();
    finishPoly();
    finishCurve();
    if (!keepSelection) commitSelection();
  };

  const setTool = (t: Tool) => {
    // The mixer works on the selection, so picking it up keeps one.
    settle(t === 'mixer');
    if (t === 'picker' && tool !== 'picker') setPrevTool(tool);
    setToolState(t);
    sfx.click();
  };

  // ---- Zoom ----------------------------------------------------------------

  const zoomTo = (z: number, at?: { clientX: number; clientY: number }) => {
    const ws = wsRef.current;
    const c = canvasRef.current;
    const next = Math.max(1, Math.min(32, z));
    if (!ws || !c || next === zoom) return;
    const wr = ws.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const cx = at?.clientX ?? wr.left + wr.width / 2;
    const cy = at?.clientY ?? wr.top + wr.height / 2;
    const ix = (cx - cr.left) / zoom;
    const iy = (cy - cr.top) / zoom;
    scrollToRef.current = {
      left: ws.scrollLeft + ix * (next - zoom),
      top: ws.scrollTop + iy * (next - zoom),
    };
    setZoom(next);
  };
  const zoomStep = (dir: 1 | -1, at?: { clientX: number; clientY: number }) => {
    const i = ZOOMS.findIndex((z) => z >= zoom);
    const idx = dir === 1 ? (ZOOMS[i] === zoom ? i + 1 : i) : i - 1;
    zoomTo(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, idx))], at);
  };
  const zoomToFit = () => {
    const ws = wsRef.current;
    if (!ws) return;
    const z = Math.floor(Math.min((ws.clientWidth - 24) / size.w, (ws.clientHeight - 24) / size.h));
    setZoom(Math.max(1, Math.min(32, z)));
  };

  // ---- Drawing ---------------------------------------------------------------

  const mirrored = (x: number, y: number): [number, number][] => {
    const s = surf();
    const pts: [number, number][] = [[x, y]];
    if (symmetry === 'h' || symmetry === 'both') pts.push([s.width - 1 - x, y]);
    if (symmetry === 'v' || symmetry === 'both') pts.push([x, s.height - 1 - y]);
    if (symmetry === 'both') pts.push([s.width - 1 - x, s.height - 1 - y]);
    return pts;
  };
  const dabSym = (x: number, y: number, sz: number, sh: 'round' | 'square', c: Packed) => {
    for (const [mx, my] of mirrored(x, y)) dab(surf(), mx, my, sz, sh, c);
  };

  const spray = (st: Stroke) => {
    const r = options.sprayRadius;
    const n = Math.ceil((r * r) / 8) + 1;
    for (let i = 0; i < n; i++) {
      const a = rand(0, 1) * Math.PI * 2;
      const d = Math.sqrt(rand(0, 1)) * r;
      for (const [mx, my] of mirrored(Math.round(st.x + Math.cos(a) * d), Math.round(st.y + Math.sin(a) * d))) {
        surf().set(mx, my, st.fg);
      }
    }
  };

  const wackySegment = (st: Stroke, x0: number, y0: number, x1: number, y1: number) => {
    const s = surf();
    const d = Math.hypot(x1 - x0, y1 - y0);
    st.traveled += d;
    const sz = Math.max(3, options.brush.size * 2);
    switch (tray.wacky) {
      case 'rainbow':
        line(x0, y0, x1, y1, (x, y) => {
          st.hue = (st.hue + 3) % 360;
          dabSym(x, y, sz, 'round', hsl(st.hue, 1, 0.5));
        });
        break;
      case 'sparkle':
        for (let i = 0; i < 2; i++) {
          const c = hsl(rand(0, 1) * 360, 1, rand(0.55, 0.8));
          for (const [mx, my] of mirrored(Math.round(x1 + rand(-12, 12)), Math.round(y1 + rand(-12, 12)))) {
            twinkle(s, mx, my, c, rand(0, 1) < 0.3);
          }
        }
        break;
      case 'drip':
        line(x0, y0, x1, y1, (x, y) => dabSym(x, y, sz, 'round', st.fg));
        if (rand(0, 1) < Math.max(0.15, d / 20)) {
          for (const [mx, my] of mirrored(Math.round(x1 + rand(-sz / 2, sz / 2)), y1)) {
            dripsRef.current.push({ x: mx, y: my, left: rand(10, 50), c: st.fg, w: Math.round(rand(1, 3)) });
          }
        }
        break;
      case 'bubbles':
        while (st.traveled >= st.next) {
          st.next += rand(6, 14);
          const r = Math.round(rand(2, 10));
          for (const [mx, my] of mirrored(Math.round(x1 + rand(-6, 6)), Math.round(y1 + rand(-6, 6)))) {
            shape(s, 'ellipse', { x: mx - r, y: my - r, w: r * 2 + 1, h: r * 2 + 1 }, 1, st.fg, null);
            s.set(mx - Math.round(r / 2), my - Math.round(r / 2), WHITE);
          }
        }
        break;
      case 'kaleido': {
        const cx = (s.width - 1) / 2;
        const cy = (s.height - 1) / 2;
        line(x0, y0, x1, y1, (x, y) => {
          st.hue = (st.hue + 2) % 360;
          const c = hsl(st.hue, 1, 0.5);
          const dx = x - cx;
          const dy = y - cy;
          const pts = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy], [dy, dx], [-dy, dx], [dy, -dx], [-dy, -dx]];
          for (const [ax, ay] of pts) dab(s, Math.round(cx + ax), Math.round(cy + ay), Math.max(2, sz / 2), 'round', c);
        });
        break;
      }
      case 'dots':
        while (st.traveled >= st.next) {
          st.next += 9;
          dabSym(x1, y1, Math.round(rand(2, 6)), 'round', st.fg);
        }
        break;
      case 'grass':
        while (st.traveled >= st.next) {
          st.next += 3;
          const bx = Math.round(x1 + rand(-4, 4));
          const len = rand(6, 18);
          const tx = Math.round(bx + rand(-5, 5));
          const ty = Math.round(y1 - len);
          const c = hsl(rand(85, 140), 0.75, rand(0.25, 0.5));
          for (const [mx, my] of mirrored(bx, y1)) {
            const [ex, ey] = [mx + (tx - bx), my + (ty - y1) * (my === y1 ? 1 : -1)];
            line(mx, my, ex, ey, (px, py) => s.set(px, py, c));
          }
        }
        break;
      case 'zigzag': {
        if (!st.zig) st.zig = [x0, y0];
        while (st.traveled >= st.next && d > 0) {
          st.next += 8;
          const nx = -(y1 - y0) / d;
          const ny = (x1 - x0) / d;
          const v: [number, number] = [Math.round(x1 + nx * 7 * st.zigSign), Math.round(y1 + ny * 7 * st.zigSign)];
          st.zigSign = -st.zigSign;
          const [zx, zy] = st.zig;
          line(zx, zy, v[0], v[1], (px, py) => dabSym(px, py, 2, 'square', st.fg));
          st.zig = v;
        }
        break;
      }
    }
  };

  /** Paint one stretch of a freehand stroke. */
  const freehand = (st: Stroke, x0: number, y0: number, x1: number, y1: number) => {
    const s = surf();
    switch (st.tool) {
      case 'pencil':
        line(x0, y0, x1, y1, (x, y) => {
          for (const [mx, my] of mirrored(x, y)) s.set(mx, my, st.fg);
        });
        break;
      case 'brush':
        line(x0, y0, x1, y1, (x, y) => {
          for (const [mx, my] of mirrored(x, y)) dab(s, mx, my, options.brush.size, options.brush.shape, st.fg);
        });
        break;
      case 'eraser': {
        const e = options.eraserSize;
        const lo = -Math.floor((e - 1) / 2);
        const from = pack(primary);
        const to = pack(secondary);
        line(x0, y0, x1, y1, (x, y) => {
          for (const [mx, my] of mirrored(x, y)) {
            if (st.right) {
              // The color eraser: only the foreground color turns to background.
              for (let yy = my + lo; yy < my + lo + e; yy++) {
                for (let xx = mx + lo; xx < mx + lo + e; xx++) if (s.get(xx, yy) === from && s.inside(xx, yy)) s.set(xx, yy, to);
              }
            } else {
              s.fillRect(mx + lo, my + lo, e, e, to);
            }
          }
        });
        break;
      }
      case 'airbrush':
        st.x = x1;
        st.y = y1;
        spray(st);
        break;
      case 'wacky':
        wackySegment(st, x0, y0, x1, y1);
        break;
    }
  };

  /** Draw a shape-in-progress over the picture as it was when the drag began. */
  const preview = (st: Stroke, draw: (s: Surface) => Rect | null) => {
    const s = surf();
    if (st.base && st.box) s.restore(st.base, st.box);
    st.box = draw(s);
    flush();
  };

  const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

  const drawShape = (st: Stroke, x: number, y: number, shift: boolean) => {
    const [ex, ey] = shift ? snapSquare(st.x0, st.y0, x, y) : [x, y];
    const r = rectFrom(st.x0, st.y0, ex, ey);
    const kind = st.tool === 'ellipse' ? 'ellipse' : st.tool === 'roundrect' ? 'roundrect' : 'rect';
    const stroke = options.fillMode === 'fill' ? null : st.fg;
    const fill = options.fillMode === 'outline' ? null : options.fillMode === 'fill' ? st.fg : st.bg;
    preview(st, (s) => {
      shape(s, kind, r, options.lineWidth, stroke, fill);
      return r;
    });
    return r;
  };

  const drawLine = (st: Stroke, x: number, y: number, shift: boolean) => {
    const [ex, ey] = shift ? snap45(st.x0, st.y0, x, y) : [x, y];
    preview(st, (s) => {
      line(st.x0, st.y0, ex, ey, (px, py) => dab(s, px, py, options.lineWidth, 'round', st.fg));
      return grow(rectFrom(st.x0, st.y0, ex, ey), options.lineWidth);
    });
    return rectFrom(st.x0, st.y0, ex, ey);
  };

  const drawCurve = (c: Curve, p1: [number, number], p2: [number, number]) => {
    const s = surf();
    s.restore(c.base, { x: 0, y: 0, w: s.width, h: s.height });
    const pts = bezier(c.p0, p1, p2, c.p3);
    for (let i = 1; i < pts.length; i++) {
      line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], (px, py) => dab(s, px, py, options.lineWidth, 'round', c.fg));
    }
    flush();
  };

  const drawPolyPreview = (p: Poly, cursor: [number, number] | null) => {
    const s = surf();
    s.restore(p.base, { x: 0, y: 0, w: s.width, h: s.height });
    const pts = cursor ? [...p.points, cursor] : p.points;
    for (let i = 1; i < pts.length; i++) {
      line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], (px, py) => dab(s, px, py, options.lineWidth, 'round', p.fg));
    }
    if (pts.length === 1) dab(s, pts[0][0], pts[0][1], options.lineWidth, 'round', p.fg);
    flush();
  };

  // The animation loop: the airbrush keeps spraying while held, and drips run.
  const tick = () => {
    loopRef.current = 0;
    let again = false;
    const st = strokeRef.current;
    if (st?.tool === 'airbrush') {
      spray(st);
      again = true;
    }
    const s = surfRef.current;
    if (s && dripsRef.current.length) {
      for (const d of dripsRef.current) {
        const step = rand(0, 1) < 0.7 ? 1 : 2;
        for (let i = 0; i < step; i++) {
          d.y++;
          s.fillRect(d.x - (d.w >> 1), d.y, d.w, 1, d.c);
        }
        d.left -= step;
      }
      dripsRef.current = dripsRef.current.filter((d) => d.left > 0 && d.y < s.height);
      again ||= dripsRef.current.length > 0;
    }
    flush();
    if (again) loopRef.current = requestAnimationFrame(tick);
  };
  const ensureLoop = () => {
    if (!loopRef.current) loopRef.current = requestAnimationFrame(tick);
  };

  // ---- Effects and transforms -------------------------------------------------

  /**
   * Run a whole-picture function over the selection if there is one (lifting
   * it if needed), otherwise over the whole picture.
   */
  const transform = (fn: (s: Surface) => Surface, sound: () => void = sfx.sparkle) => {
    settle(true);
    const sel = selection;
    if (sel) {
      let f = floatingRef.current;
      if (!f) {
        checkpoint();
        f = surf().extract(sel);
        surf().fillRect(sel.x, sel.y, sel.w, sel.h, pack(secondary));
        flush();
      }
      const out = fn(f);
      floatingRef.current = out;
      setSelection({ ...sel, w: out.width, h: out.height, floating: true });
      setFloatVersion((v) => v + 1);
    } else {
      checkpoint();
      const out = fn(surf());
      replaceSurface(out);
    }
    sound();
  };

  const mix = (id: string) => {
    const m = fx.MIXER.find((e) => e.id === id);
    if (!m) return;
    transform((s) => m.apply(s, { palette, primary: pack(primary), secondary: pack(secondary) }));
  };

  // ---- Dynamite ------------------------------------------------------------------

  const explode = (x: number, y: number, bg: Packed) => {
    checkpoint();
    dripsRef.current = [];
    const s = surf();
    const boom = () => {
      s.fillRect(0, 0, s.width, s.height, bg);
      flush();
      sfx.bang();
    };
    const c = fxRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      boom();
      return;
    }
    sfx.fuse();
    const scaleDown = 3;
    c.width = Math.max(1, Math.ceil((s.width * zoom) / scaleDown));
    c.height = Math.max(1, Math.ceil((s.height * zoom) / scaleDown));
    const ox = (x * zoom) / scaleDown;
    const oy = (y * zoom) / scaleDown;
    const colors = ['#ffffff', '#ffff40', '#ffc000', '#ff6000', '#ff2000', '#808080'];
    const parts = Array.from({ length: 220 }, () => {
      const a = rand(0, 1) * Math.PI * 2;
      const v = rand(1, 9);
      return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: rand(25, 60), c: colors[Math.floor(rand(0, 1) * colors.length)], size: rand(0, 1) < 0.3 ? 2 : 1 };
    });
    let frame = 0;
    const fuseFrames = 18;
    const run = () => {
      frame++;
      ctx.clearRect(0, 0, c.width, c.height);
      if (frame < fuseFrames) {
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = colors[Math.floor(rand(0, 1) * 3)];
          ctx.fillRect(Math.round(ox + rand(-3, 3)), Math.round(oy + rand(-3, 3)), 1, 1);
        }
      } else {
        if (frame === fuseFrames) {
          boom();
          pageRef.current?.animate(
            [
              { transform: 'translate(0,0)' },
              { transform: 'translate(-8px,5px)' },
              { transform: 'translate(7px,-6px)' },
              { transform: 'translate(-5px,-3px)' },
              { transform: 'translate(4px,4px)' },
              { transform: 'translate(0,0)' },
            ],
            { duration: 420 },
          );
        }
        let alive = false;
        for (const p of parts) {
          if (p.life <= 0) continue;
          alive = true;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.25;
          p.vx *= 0.97;
          p.life--;
          ctx.fillStyle = p.c;
          ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
        }
        if (!alive) {
          ctx.clearRect(0, 0, c.width, c.height);
          return;
        }
      }
      requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  };

  // ---- The mouse -------------------------------------------------------------------

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const s = surf();
    return [Math.floor(((e.clientX - r.left) * s.width) / r.width), Math.floor(((e.clientY - r.top) * s.height) / r.height)];
  };

  const showPos = (x: number | null, y?: number, extra?: string) => {
    const el = posRef.current;
    if (el) el.textContent = x === null ? '' : `${x}, ${y}px${extra ? `   ${extra}` : ''}`;
  };

  const inSelection = (x: number, y: number) =>
    !!selection && x >= selection.x && y >= selection.y && x < selection.x + selection.w && y < selection.y + selection.h;

  const lift = (sel: Selection, leaveCopy: boolean): Surface => {
    checkpoint();
    const f = surf().extract(sel);
    if (!leaveCopy) {
      surf().fillRect(sel.x, sel.y, sel.w, sel.h, pack(secondary));
      flush();
    }
    floatingRef.current = f;
    setSelection({ ...sel, floating: true });
    setFloatVersion((v) => v + 1);
    return f;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.button !== 0 && e.button !== 2) || loading || !surfRef.current) return;
    if ((e.target as HTMLElement).closest('textarea, [data-handle]')) return;
    e.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const [x, y] = at(e);
    const right = e.button === 2;
    const fg = pack(right ? secondary : primary);
    const bg = pack(right ? primary : secondary);
    if (textBox) {
      commitText();
      return;
    }
    const st: Stroke = {
      tool, right, fg, bg, x0: x, y0: y, x, y,
      base: null, box: null, traveled: 0, next: 0, hue: rand(0, 1) * 360,
      zig: null, zigSign: 1, moved: false, move: null, marquee: false, fresh: false,
    };

    switch (tool) {
      case 'pencil':
      case 'brush':
      case 'eraser':
      case 'airbrush':
      case 'wacky': {
        checkpoint();
        const kinds: Record<string, ScribbleKind> = { pencil: 'pencil', brush: 'brush', eraser: 'eraser', airbrush: 'spray', wacky: 'wacky' };
        startScribble(kinds[tool]);
        freehand(st, x, y, x, y);
        flush();
        if (tool === 'airbrush' || tool === 'wacky') ensureLoop();
        break;
      }
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'roundrect':
        checkpoint();
        st.base = surf().clone();
        if (tool === 'line') drawLine(st, x, y, e.shiftKey);
        else drawShape(st, x, y, e.shiftKey);
        break;
      case 'curve': {
        const c = curveRef.current;
        if (!c) {
          checkpoint();
          curveRef.current = { phase: 0, p0: [x, y], p1: [x, y], p3: [x, y], base: surf().clone(), fg };
          drawCurve(curveRef.current, [x, y], [x, y]);
        } else if (c.phase === 1) {
          drawCurve(c, [x, y], [x, y]);
        } else {
          drawCurve(c, c.p1, [x, y]);
        }
        break;
      }
      case 'polygon': {
        const p = polyRef.current;
        if (!p) {
          checkpoint();
          polyRef.current = { points: [[x, y]], base: surf().clone(), fg, bg };
          st.fresh = true;
          drawPolyPreview(polyRef.current, [x, y]);
        } else {
          const [fx0, fy0] = p.points[0];
          const near = Math.max(2, Math.ceil(4 / zoom));
          if (p.points.length >= 3 && Math.abs(x - fx0) <= near && Math.abs(y - fy0) <= near) {
            finishPoly();
            return;
          }
          drawPolyPreview(p, [x, y]);
        }
        break;
      }
      case 'fill': {
        checkpoint();
        if (floodFill(surf(), x, y, patternFn(tray.pattern, fg, bg, surf().height))) {
          flush();
          sfx.bloop();
        } else {
          dropCheckpoint();
        }
        return;
      }
      case 'picker': {
        const c = unpack(surf().get(x, y));
        if (right) setSecondary(c);
        else setPrimary(c);
        setToolState(prevTool);
        sfx.click();
        return;
      }
      case 'magnifier':
        zoomStep(right ? -1 : 1, e);
        return;
      case 'text':
        settle();
        setTextBox({ x, y, value: '' });
        return;
      case 'stamp': {
        let g = glyphSurface(tray.stamp, tray.stampSize, tray.crisp);
        if (!g) return;
        if (right) g = fx.flipH(g);
        checkpoint();
        for (const [mx, my] of mirrored(x, y)) {
          surf().paste(g, mx - (g.width >> 1), my - (g.height >> 1), undefined, true);
        }
        flush();
        sfx.boing();
        return;
      }
      case 'mixer':
        mix(tray.mixer);
        return;
      case 'dynamite':
        settle();
        explode(x, y, pack(secondary));
        return;
      case 'select':
        if (selection && inSelection(x, y)) {
          if (!floatingRef.current) lift(selection, e.ctrlKey);
          else if (e.ctrlKey) {
            // Ctrl+drag a lifted selection: leave a copy where it was.
            checkpoint();
            surf().paste(floatingRef.current, selection.x, selection.y, options.selectTransparent ? pack(secondary) : undefined);
            flush();
          }
          st.move = { sx: x, sy: y, ox: selection.x, oy: selection.y };
        } else {
          commitSelection();
          st.marquee = true;
        }
        break;
    }
    strokeRef.current = st;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!surfRef.current) return;
    const [x, y] = at(e);
    const st = strokeRef.current;
    if (!st) {
      if (polyRef.current) drawPolyPreview(polyRef.current, [x, y]);
      showPos(x, y);
      return;
    }
    if (x === st.x && y === st.y) return;
    st.moved = true;
    let extra: string | undefined;
    switch (st.tool) {
      case 'pencil':
      case 'brush':
      case 'eraser':
      case 'airbrush':
      case 'wacky': {
        const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
        const pts = events.length ? events.map((ev) => at(ev)) : [[x, y] as [number, number]];
        for (const [px, py] of pts) {
          if (px === st.x && py === st.y) continue;
          scribbleSpeed(Math.hypot(px - st.x, py - st.y) * Math.max(1, zoom / 2));
          freehand(st, st.x, st.y, px, py);
          st.x = px;
          st.y = py;
        }
        if (dripsRef.current.length) ensureLoop();
        flush();
        break;
      }
      case 'line': {
        const r = drawLine(st, x, y, e.shiftKey);
        extra = `${r.w} × ${r.h}`;
        break;
      }
      case 'rect':
      case 'ellipse':
      case 'roundrect': {
        const r = drawShape(st, x, y, e.shiftKey);
        extra = `${r.w} × ${r.h}`;
        break;
      }
      case 'curve': {
        const c = curveRef.current;
        if (!c) break;
        if (c.phase === 0) {
          c.p3 = e.shiftKey ? snap45(c.p0[0], c.p0[1], x, y) : [x, y];
          drawCurve(c, c.p0, c.p3);
        } else if (c.phase === 1) drawCurve(c, [x, y], [x, y]);
        else drawCurve(c, c.p1, [x, y]);
        break;
      }
      case 'polygon': {
        const p = polyRef.current;
        if (p) drawPolyPreview(p, [x, y]);
        break;
      }
      case 'select': {
        const s = surf();
        if (st.move) {
          const { ox, oy, sx, sy } = st.move;
          setSelection((cur) => cur && { ...cur, x: ox + (x - sx), y: oy + (y - sy) });
        } else if (st.marquee) {
          const cx = Math.max(0, Math.min(s.width - 1, x));
          const cy = Math.max(0, Math.min(s.height - 1, y));
          const r = rectFrom(Math.max(0, Math.min(s.width - 1, st.x0)), Math.max(0, Math.min(s.height - 1, st.y0)), cx, cy);
          setSelection({ ...r, floating: false });
          extra = `${r.w} × ${r.h}`;
        }
        break;
      }
    }
    if (st.tool !== 'pencil' && st.tool !== 'brush' && st.tool !== 'eraser' && st.tool !== 'airbrush' && st.tool !== 'wacky') {
      st.x = x;
      st.y = y;
    }
    showPos(x, y, extra);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = strokeRef.current;
    if (!st) return;
    strokeRef.current = null;
    stopScribble();
    const [x, y] = at(e);
    switch (st.tool) {
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'roundrect':
        sfx.pop();
        break;
      case 'curve': {
        const c = curveRef.current;
        if (!c) break;
        if (c.phase === 0) {
          if (c.p0[0] === c.p3[0] && c.p0[1] === c.p3[1]) finishCurve();
          else c.phase = 1;
        } else if (c.phase === 1) {
          c.p1 = [x, y];
          c.phase = 2;
        } else finishCurve();
        break;
      }
      case 'polygon': {
        const p = polyRef.current;
        if (!p) break;
        const last = p.points[p.points.length - 1];
        if (st.fresh && !st.moved) break;
        if (last[0] !== x || last[1] !== y) p.points.push(e.shiftKey ? snap45(last[0], last[1], x, y) : [x, y]);
        drawPolyPreview(p, null);
        break;
      }
      case 'select':
        if (st.marquee && !st.moved) setSelection(null);
        break;
    }
  };

  // ---- Clipboard ------------------------------------------------------------------

  const selectionPixels = (): Surface | null =>
    floatingRef.current ?? (selection ? surf().extract(selection) : null);

  const copy = () => {
    const s = selectionPixels();
    if (!s) return;
    clipRef.current = s.clone();
    try {
      void navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(s) })]).catch(() => {});
    } catch {
      // The internal clipboard still has it.
    }
    setStatus('Copied');
  };

  const deleteSelection = () => {
    if (!selection) return;
    if (floatingRef.current) floatingRef.current = null;
    else {
      checkpoint();
      surf().fillRect(selection.x, selection.y, selection.w, selection.h, pack(secondary));
      flush();
    }
    setSelection(null);
  };

  const cut = () => {
    copy();
    deleteSelection();
  };

  /** Drop a picture in as a selection, ready to be dragged into place. */
  const placeFloating = (s: Surface) => {
    settle();
    checkpoint();
    const cur = surf();
    if (s.width > cur.width || s.height > cur.height) {
      replaceSurface(fx.resizeCanvas(cur, Math.max(cur.width, s.width), Math.max(cur.height, s.height), pack(secondary)));
    }
    const ws = wsRef.current;
    const x = ws ? Math.max(0, Math.min(Math.floor(ws.scrollLeft / zoom), surf().width - s.width)) : 0;
    const y = ws ? Math.max(0, Math.min(Math.floor(ws.scrollTop / zoom), surf().height - s.height)) : 0;
    floatingRef.current = s;
    setSelection({ x, y, w: s.width, h: s.height, floating: true });
    setFloatVersion((v) => v + 1);
    setToolState('select');
  };

  const paste = async () => {
    let s: Surface | null = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        s = await decode(new Uint8Array(await blob.arrayBuffer()), 'clipboard.png');
        break;
      }
    } catch {
      // No picture there, or no permission to look.
    }
    s ??= clipRef.current?.clone() ?? null;
    if (s) placeFloating(s);
    else setStatus('There’s no picture on the clipboard.');
  };

  const selectAll = () => {
    settle();
    setToolState('select');
    setSelection({ x: 0, y: 0, w: surf().width, h: surf().height, floating: false });
  };

  const cropToSelection = () => {
    const s = selectionPixels();
    if (!s) return;
    settle(true);
    checkpoint();
    floatingRef.current = null;
    setSelection(null);
    replaceSurface(s.clone());
  };

  const nudge = (dx: number, dy: number) => {
    if (!selection) return;
    if (!floatingRef.current) lift(selection, false);
    setSelection({ ...selection, x: selection.x + dx, y: selection.y + dy, floating: true });
  };

  // ---- Undo and redo ----------------------------------------------------------------

  const undo = () => {
    settle();
    const prev = undoRef.current.pop();
    if (!prev) return;
    dripsRef.current = [];
    redoRef.current.push({ surface: surf().clone(), id: idRef.current.current });
    replaceSurface(prev.surface);
    setId(prev.id);
    syncHistory();
    sfx.uhOh();
  };

  const redo = () => {
    settle();
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push({ surface: surf().clone(), id: idRef.current.current });
    replaceSurface(next.surface);
    setId(next.id);
    syncHistory();
    sfx.redo();
  };

  // ---- Files ------------------------------------------------------------------------

  const load = useCallback(
    (target: string) => {
      if (!fs) return;
      const seq = ++loadSeq.current;
      fs.readFile(target, MAX_BYTES)
        .then((r) => {
          if (r.truncated) throw new Error('It’s too big for Paint.');
          return decode(r.data, target);
        })
        .then((s) => {
          if (seq !== loadSeq.current) return;
          floatingRef.current = null;
          setSelection(null);
          setTextBox(null);
          surfRef.current = s;
          const c = canvasRef.current;
          if (c) {
            c.width = s.width;
            c.height = s.height;
            c.getContext('2d')?.putImageData(s.image, 0, 0);
          }
          s.takeDirty();
          setSize({ w: s.width, h: s.height });
          const id = idRef.current.next++;
          undoRef.current = [];
          redoRef.current = [];
          idRef.current.current = id;
          setDocId(id);
          setSavedId(id);
          setHistory({ undo: 0, redo: 0 });
          setPath(target);
          setStatus(null);
          setLoading(false);
          const ws = wsRef.current;
          if (ws) {
            const z = Math.floor(Math.min((ws.clientWidth - 24) / s.width, (ws.clientHeight - 24) / s.height));
            // Little pictures (sprites) open big enough to see.
            setZoom(Math.max(1, Math.min(16, z >= 2 ? Math.min(z, Math.max(1, Math.floor(256 / Math.max(s.width, s.height)))) : 1)));
          }
        })
        .catch((err: unknown) => {
          if (seq !== loadSeq.current) return;
          setLoading(false);
          setError(`Couldn’t open ${basename(target)}. ${err instanceof Error && err.message.startsWith('It') ? err.message : cleanFsError(err)}`);
          sfx.error();
        });
    },
    [fs],
  );

  const [prevInitial, setPrevInitial] = useState<string | null>(null);
  if (initialPath !== prevInitial) {
    setPrevInitial(initialPath);
    if (initialPath && fs) setLoading(true);
  }
  useEffect(() => {
    if (initialPath) load(initialPath);
  }, [initialPath, load]);

  const writeTo = async (target: string): Promise<boolean> => {
    if (!fs) return false;
    settle();
    try {
      const bytes = await encode(surf(), target);
      await fs.writeFile(target, bytes);
      setPath(target);
      setSavedId(idRef.current.current);
      setStatus('Saved');
      sfx.save();
      void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', target] });
      void invalidateListings(queryClient, target);
      return true;
    } catch (err) {
      setError(`Couldn’t save ${basename(target)}. ${cleanFsError(err)}`);
      sfx.error();
      return false;
    }
  };

  const saveAs = async (): Promise<boolean> => {
    const current = path && savesAs(path) ? basename(path) : `${path ? basename(path).replace(/\.[^.]*$/, '') : 'untitled'}.png`;
    const result = await pickFiles({
      mode: 'save',
      title: 'Save As',
      currentName: current,
      initialPath: path ? parentPath(path) : undefined,
      filters: SAVE_TYPES,
    });
    if (!result) return false;
    let target = result.paths[0];
    if (!savesAs(target)) {
      const filter = SAVE_TYPES[result.filter ?? 0] ?? SAVE_TYPES[0];
      target += filter.patterns[0].slice(1);
    }
    return writeTo(target);
  };

  const save = (): Promise<boolean> => (path && savesAs(path) ? writeTo(path) : saveAs());

  const openFile = async () => {
    const target = await pickFile({
      title: 'Open',
      extensions: OPEN_EXTENSIONS,
      initialPath: path ? parentPath(path) : undefined,
    });
    if (!target) return;
    // Unsaved work stays put; the picture gets a window of its own.
    if (dirty) {
      open('paint', { path: target });
      return;
    }
    setLoading(true);
    load(target);
  };

  const pasteFrom = async () => {
    if (!fs) return;
    const target = await pickFile({ title: 'Paste From', extensions: OPEN_EXTENSIONS, initialPath: path ? parentPath(path) : undefined });
    if (!target) return;
    try {
      const r = await fs.readFile(target, MAX_BYTES);
      placeFloating(await decode(r.data, target));
    } catch (err) {
      setError(`Couldn’t open ${basename(target)}. ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Closing with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    setCloseGuard(windowId, () => {
      focus(windowId);
      setDialog('unsaved');
      return true;
    });
    return () => setCloseGuard(windowId, null);
  }, [dirty, windowId, focus]);

  const closeNow = () => {
    setCloseGuard(windowId, null);
    setDialog(null);
    close(windowId);
  };

  // ---- Canvas size -----------------------------------------------------------------

  const resizeTo = (w: number, h: number, stretch: boolean) => {
    settle();
    const s = surf();
    if (w === s.width && h === s.height) return;
    checkpoint();
    replaceSurface(stretch ? fx.scale(s, w, h) : fx.resizeCanvas(s, w, h, pack(secondary)));
  };

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>, dir: 'e' | 's' | 'se') => {
    e.preventDefault();
    e.stopPropagation();
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let w = size.w;
    let h = size.h;
    const move = (ev: PointerEvent) => {
      if (dir !== 's') w = Math.max(1, Math.round((ev.clientX - r.left) / zoom));
      if (dir !== 'e') h = Math.max(1, Math.round((ev.clientY - r.top) / zoom));
      setResizing({ w, h });
      showPos(null);
      if (posRef.current) posRef.current.textContent = `${w} × ${h}`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      setResizing(null);
      resizeTo(Math.min(8192, w), Math.min(8192, h), false);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // ---- Colors ----------------------------------------------------------------------

  const pickColor = (c: Color, toSecondary: boolean) => {
    if (toSecondary) setSecondary(c);
    else setPrimary(c);
  };

  const editSwatch = (index: number) => setEditing({ index, color: palette[index] });

  const swap = () => {
    setPrimary(secondary);
    setSecondary(primary);
  };

  // ---- Keys ---------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog || error) return;
    const target = e.target as HTMLElement;
    const typing = target.closest('input, textarea, select');
    const key = e.key.toLowerCase();
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    let handled = true;
    if (ctrl && !e.shiftKey && key === 's') void save();
    else if (ctrl && e.shiftKey && key === 's') void saveAs();
    else if (ctrl && !e.shiftKey && key === 'o') void openFile();
    else if (ctrl && !e.shiftKey && key === 'n') open('paint');
    else if (ctrl && (key === 'w' || key === 'q')) close(windowId);
    else if (typing) handled = false;
    else if (ctrl && !e.shiftKey && key === 'z') undo();
    else if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) redo();
    else if (ctrl && key === 'a') selectAll();
    else if (ctrl && key === 'c') copy();
    else if (ctrl && key === 'x') cut();
    else if (ctrl && key === 'v') void paste();
    else if (ctrl && key === 'g') update({ grid: !grid });
    else if (ctrl && key === 'e') setDialog('attributes');
    else if (ctrl && key === 'i') transform(fx.invert);
    else if (ctrl && (key === '=' || key === '+')) zoomStep(1);
    else if (ctrl && key === '-') zoomStep(-1);
    else if (ctrl && key === '0') zoomToFit();
    else if (ctrl && key === '1') zoomTo(1);
    else if (ctrl && e.shiftKey && key === 'n') {
      settle();
      checkpoint();
      surf().fillRect(0, 0, surf().width, surf().height, pack(secondary));
      flush();
    } else if (ctrl) handled = false;
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    else if (e.key === 'Escape' || e.key === 'Enter') settle();
    else if (selection && e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
    } else if (key === 'x' && e.shiftKey) swap();
    else if (key === '[' || key === ']') {
      const d = key === ']' ? 1 : -1;
      if (tool === 'brush') update({ options: { ...options, brush: { ...options.brush, size: Math.max(1, Math.min(64, options.brush.size + d)) } } });
      else if (tool === 'eraser') update({ options: { ...options, eraserSize: Math.max(1, Math.min(64, options.eraserSize + d * 2)) } });
      else if (tool === 'airbrush') update({ options: { ...options, sprayRadius: Math.max(2, Math.min(48, options.sprayRadius + d * 2)) } });
      else if (tool === 'stamp') update({ tray: { ...tray, stampSize: Math.max(8, Math.min(256, tray.stampSize + d * 8)) } });
      else update({ options: { ...options, lineWidth: Math.max(1, Math.min(32, options.lineWidth + d)) } });
    } else {
      const t = TOOLS.find((x) => x.key === key && !e.altKey && !e.shiftKey);
      if (t) setTool(t.id);
      else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1, e);
  };

  // Ctrl+wheel must be able to preventDefault, which React's wheel listener can't.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const block = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    ws.addEventListener('wheel', block, { passive: false });
    return () => ws.removeEventListener('wheel', block);
  }, []);

  // ---- Rendering ------------------------------------------------------------------------

  const toolInfo = TOOLS.find((t) => t.id === tool)!;
  const font = FONTS.find((f) => f.id === tray.font) ?? FONTS[0];
  // See-through squares line up with the pixels once they're big.
  const checker = zoom >= 8 ? zoom : zoom >= 4 ? zoom * Math.ceil(8 / zoom) : 8;
  const cw = size.w * zoom;
  const ch = size.h * zoom;
  const fileOps = fs !== undefined;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative flex h-full w-full flex-col bg-[#c0c0c0] text-black outline-none select-none"
      style={RETRO_FONT}
    >
      <Menubar className="flex shrink-0 items-center px-0.5 pt-0.5">
        <MenubarMenu>
          <MenubarTrigger><u>F</u>ile</MenubarTrigger>
          <MenubarContent>
            <MenubarItem shortcut="Ctrl+N" onSelect={() => open('paint')}>New</MenubarItem>
            <MenubarSub>
              <MenubarSubTrigger>New Sprite</MenubarSubTrigger>
              <MenubarSubContent>
                {[16, 32, 48, 64, 128].map((n) => (
                  <MenubarItem key={n} onSelect={() => open('paint', { width: n, height: n, transparent: true, zoom: Math.max(2, Math.floor(384 / n)) })}>
                    {n} × {n}
                  </MenubarItem>
                ))}
                <MenubarItem onSelect={() => open('paint', { width: 320, height: 240, zoom: 2 })}>320 × 240 game screen</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarItem shortcut="Ctrl+O" disabled={!fileOps} onSelect={() => void openFile()}>Open…</MenubarItem>
            <MenubarItem shortcut="Ctrl+S" disabled={!fileOps} onSelect={() => void save()}>Save</MenubarItem>
            <MenubarItem shortcut="Ctrl+Shift+S" disabled={!fileOps} onSelect={() => void saveAs()}>Save As…</MenubarItem>
            <MenubarSeparator />
            <MenubarItem shortcut="Ctrl+W" onSelect={() => close(windowId)}>Exit</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>E</u>dit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem shortcut="Ctrl+Z" disabled={history.undo === 0} onSelect={undo}>Undo</MenubarItem>
            <MenubarItem shortcut="Ctrl+Y" disabled={history.redo === 0} onSelect={redo}>Repeat</MenubarItem>
            <MenubarSeparator />
            <MenubarItem shortcut="Ctrl+X" disabled={!selection} onSelect={cut}>Cut</MenubarItem>
            <MenubarItem shortcut="Ctrl+C" disabled={!selection} onSelect={copy}>Copy</MenubarItem>
            <MenubarItem shortcut="Ctrl+V" onSelect={() => void paste()}>Paste</MenubarItem>
            <MenubarItem shortcut="Del" disabled={!selection} onSelect={deleteSelection}>Clear Selection</MenubarItem>
            <MenubarItem shortcut="Ctrl+A" onSelect={selectAll}>Select All</MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!fileOps} onSelect={() => void pasteFrom()}>Paste From…</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>V</u>iew</MenubarTrigger>
          <MenubarContent>
            <MenubarSub>
              <MenubarSubTrigger>Zoom</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem shortcut="Ctrl++" onSelect={() => zoomStep(1)}>Zoom In</MenubarItem>
                <MenubarItem shortcut="Ctrl+-" onSelect={() => zoomStep(-1)}>Zoom Out</MenubarItem>
                <MenubarItem shortcut="Ctrl+1" onSelect={() => zoomTo(1)}>Normal Size</MenubarItem>
                <MenubarItem shortcut="Ctrl+0" onSelect={zoomToFit}>Fit in Window</MenubarItem>
                <MenubarSeparator />
                <MenubarRadioGroup value={String(zoom)} onValueChange={(v) => zoomTo(Number(v))}>
                  {ZOOMS.map((z) => (
                    <MenubarRadioItem key={z} value={String(z)}>{z * 100}%</MenubarRadioItem>
                  ))}
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarCheckboxItem shortcut="Ctrl+G" checked={grid} onCheckedChange={(v) => update({ grid: v === true })}>
              Pixel Grid (at 400% and up)
            </MenubarCheckboxItem>
            <MenubarSub>
              <MenubarSubTrigger>Mirror Drawing</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value={symmetry} onValueChange={(v) => setSymmetry(v as Symmetry)}>
                  <MenubarRadioItem value="off">Off</MenubarRadioItem>
                  <MenubarRadioItem value="h">Left ↔ Right</MenubarRadioItem>
                  <MenubarRadioItem value="v">Top ↕ Bottom</MenubarRadioItem>
                  <MenubarRadioItem value="both">All Four Ways</MenubarRadioItem>
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarCheckboxItem checked={sound} onCheckedChange={(v) => update({ sound: v === true })}>
              Sound Effects
            </MenubarCheckboxItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>I</u>mage</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={() => transform(fx.flipH, sfx.pop)}>Flip Horizontal</MenubarItem>
            <MenubarItem onSelect={() => transform(fx.flipV, sfx.pop)}>Flip Vertical</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.rotate(s, true), sfx.pop)}>Rotate Right 90°</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.rotate(s, false), sfx.pop)}>Rotate Left 90°</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.rotate(fx.rotate(s, true), true), sfx.pop)}>Rotate 180°</MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={() => transform((s) => fx.scale(s, Math.min(8192, s.width * 2), Math.min(8192, s.height * 2)), sfx.pop)}>Double Size</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.scale(s, Math.max(1, s.width >> 1), Math.max(1, s.height >> 1)), sfx.pop)}>Half Size</MenubarItem>
            <MenubarItem shortcut="Ctrl+E" onSelect={() => setDialog('attributes')}>Canvas Size…</MenubarItem>
            <MenubarItem disabled={!selection} onSelect={cropToSelection}>Crop to Selection</MenubarItem>
            <MenubarSeparator />
            <MenubarItem shortcut="Ctrl+I" onSelect={() => transform(fx.invert)}>Invert Colors</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.outline(s, pack(secondary), pack(primary)))}>Outline Sprite</MenubarItem>
            <MenubarItem onSelect={() => transform((s) => fx.replaceColor(s, pack(secondary), 0))}>Make Background See-Through</MenubarItem>
            <MenubarItem
              shortcut="Ctrl+Shift+N"
              onSelect={() => {
                settle();
                checkpoint();
                surf().fillRect(0, 0, surf().width, surf().height, pack(secondary));
                flush();
              }}
            >
              Clear Image
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>C</u>olors</MenubarTrigger>
          <MenubarContent>
            <MenubarItem
              onSelect={() => {
                const i = palette.indexOf(primary);
                setEditing({ index: i === -1 ? null : i, color: primary });
              }}
            >
              Edit Colors…
            </MenubarItem>
            <MenubarItem shortcut="Shift+X" onSelect={swap}>Swap Colors</MenubarItem>
            <MenubarItem
              disabled={!settings.palettes[paletteId]}
              onSelect={() => {
                const { [paletteId]: _, ...rest } = settings.palettes;
                update({ palettes: rest });
              }}
            >
              Reset Palette
            </MenubarItem>
            <MenubarSeparator />
            <MenubarRadioGroup value={paletteId} onValueChange={(v) => update({ paletteId: v })}>
              {PALETTES.map((p) => (
                <MenubarRadioItem key={p.id} value={p.id}>{p.name}</MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>M</u>ixer</MenubarTrigger>
          <MenubarContent>
            {fx.MIXER.map((m) => (
              <MenubarItem key={m.id} onSelect={() => mix(m.id)}>
                <span className="mr-2 w-4 text-center">{m.emoji}</span>
                {m.name}
              </MenubarItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger><u>H</u>elp</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={() => setDialog('about')}>About Paint</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <div className="flex min-h-0 flex-1 gap-0.5 px-0.5 pt-0.5">
        <div className="w-[60px] shrink-0 border-r border-r-[#808080] px-0.5 pt-1">
          <div className="mx-auto w-[52px]">
            <ToolBox tool={tool} onTool={setTool} />
          </div>
          <OptionsBox
            tool={tool}
            options={options}
            zoom={zoom}
            onChange={(patch) => update({ options: { ...options, ...patch } })}
            onZoom={(z) => zoomTo(z)}
          />
        </div>

        <div
          ref={wsRef}
          onWheel={onWheel}
          className={cn('relative min-h-0 min-w-0 flex-1 overflow-auto bg-[#808080]', SUNKEN)}
        >
          <div className="relative inline-block p-[3px] pr-4 pb-4 align-top">
            <div
              ref={pageRef}
              className="relative"
              style={{ width: cw, height: ch, cursor: CURSORS[tool] ?? 'crosshair' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => !strokeRef.current && showPos(null)}
              onDoubleClick={() => {
                if (polyRef.current) finishPoly();
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <canvas
                ref={canvasRef}
                aria-label={`Picture, ${size.w} by ${size.h} pixels`}
                role="img"
                className="absolute inset-0 block"
                style={{
                  width: cw,
                  height: ch,
                  imageRendering: 'pixelated',
                  background: `repeating-conic-gradient(#d4d4d4 0 25%, #ffffff 0 50%) 0 0 / ${checker * 2}px ${checker * 2}px`,
                }}
              />
              {grid && zoom >= 4 && (
                <svg aria-hidden className="pointer-events-none absolute inset-0" width={cw} height={ch}>
                  <defs>
                    <pattern id={`${gridId}-grid`} width={zoom} height={zoom} patternUnits="userSpaceOnUse">
                      <path d={`M ${zoom} 0.5 H 0.5 V ${zoom}`} fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth={1} />
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill={`url(#${gridId}-grid)`} />
                </svg>
              )}
              {symmetry !== 'off' && (
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  {(symmetry === 'h' || symmetry === 'both') && (
                    <div className="absolute inset-y-0 border-l border-dashed border-[#ff00ff]" style={{ left: cw / 2 }} />
                  )}
                  {(symmetry === 'v' || symmetry === 'both') && (
                    <div className="absolute inset-x-0 border-t border-dashed border-[#ff00ff]" style={{ top: ch / 2 }} />
                  )}
                </div>
              )}
              {selection && (
                <div
                  className="absolute"
                  style={{
                    left: selection.x * zoom,
                    top: selection.y * zoom,
                    width: selection.w * zoom,
                    height: selection.h * zoom,
                    cursor: tool === 'select' ? 'move' : undefined,
                    outline: '1px dashed #000080',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.8)',
                  }}
                >
                  {selection.floating && (
                    <canvas
                      ref={floatRef}
                      className="block size-full"
                      style={{ imageRendering: 'pixelated' }}
                    />
                  )}
                </div>
              )}
              {textBox && (
                <textarea
                  autoFocus
                  value={textBox.value}
                  ref={(el) => el?.style.setProperty('field-sizing', 'content')}
                  onChange={(e) => {
                    if (e.target.value.length > textBox.value.length) sfx.blip();
                    setTextBox({ ...textBox, value: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setTextBox(null);
                    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      e.stopPropagation();
                      commitText();
                    }
                  }}
                  aria-label="Text to add to the picture"
                  spellCheck={false}
                  className="absolute resize-none overflow-hidden bg-transparent p-0 outline-1 outline-[#000080] outline-dashed"
                  style={{
                    left: textBox.x * zoom,
                    top: textBox.y * zoom,
                    minWidth: Math.max(40, tray.fontSize * zoom * 2),
                    minHeight: Math.round(tray.fontSize * 1.25) * zoom,
                    color: primary === TRANSPARENT ? '#000' : primary,
                    font: `${tray.bold ? 'bold ' : ''}${tray.fontSize * zoom}px ${font.css}`,
                    lineHeight: `${Math.round(tray.fontSize * 1.25) * zoom}px`,
                    caretColor: '#000',
                  }}
                />
              )}
              <canvas
                ref={fxRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 size-full"
                style={{ imageRendering: 'pixelated' }}
              />
              {resizing && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 left-0 border border-dotted border-black"
                  style={{ width: resizing.w * zoom, height: resizing.h * zoom }}
                />
              )}
              {(['e', 's', 'se'] as const).map((dir) => (
                <div
                  key={dir}
                  data-handle
                  role="separator"
                  aria-label={dir === 'e' ? 'Drag to change the width' : dir === 's' ? 'Drag to change the height' : 'Drag to change the size'}
                  onPointerDown={(e) => onHandleDown(e, dir)}
                  className="absolute size-[5px] bg-[#000080]"
                  style={{
                    left: dir === 's' ? cw / 2 - 2 : cw,
                    top: dir === 'e' ? ch / 2 - 2 : ch,
                    cursor: dir === 'e' ? 'ew-resize' : dir === 's' ? 'ns-resize' : 'nwse-resize',
                  }}
                />
              ))}
            </div>
          </div>
          {loading && (
            <div className="absolute inset-0 grid place-items-center bg-[#808080] text-white">Opening…</div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-0.5 pt-1 pb-0.5">
        <Tray
          tool={tool}
          settings={tray}
          primary={primary}
          secondary={secondary}
          onChange={(patch) => update({ tray: { ...tray, ...patch } })}
          onMix={mix}
        />
        <ColorBox
          primary={primary}
          secondary={secondary}
          palette={palette}
          paletteId={paletteId}
          onPick={pickColor}
          onSwap={swap}
          onEditSwatch={editSwatch}
          onPalette={(id) => update({ paletteId: id })}
        />
      </div>

      <div className="flex shrink-0 gap-0.5 p-0.5">
        <span role="status" className={cn('min-w-0 flex-1 truncate px-1 py-px', FIELD)}>
          {status ?? toolInfo.hint}
        </span>
        <span ref={posRef} className={cn('hidden w-40 shrink-0 truncate px-1 py-px tabular-nums sm:block', FIELD)} />
        <span className={cn('w-28 shrink-0 truncate px-1 py-px tabular-nums', FIELD)}>
          {size.w} × {size.h}
          {zoom !== 1 && ` · ${zoom * 100}%`}
        </span>
      </div>

      {editing && (
        <EditColorsDialog
          color={editing.color === TRANSPARENT ? '#000000' : editing.color}
          onClose={() => setEditing(null)}
          onOk={(c) => {
            if (editing.index !== null) {
              const next = [...palette];
              next[editing.index] = c;
              update({ palettes: { ...settings.palettes, [paletteId]: next } });
            }
            setPrimary(c);
            setEditing(null);
          }}
        />
      )}

      {dialog === 'unsaved' && (
        <RetroDialog title="Paint" onClose={() => setDialog(null)} className="w-80">
          <div className="flex items-start gap-3">
            <span className="text-3xl leading-none" aria-hidden>⚠️</span>
            <p className="pt-1">Save changes to {name}?</p>
          </div>
          <div className="mt-4 flex justify-center gap-1.5">
            <RetroButton
              autoFocus
              onClick={() => {
                setDialog(null);
                void save().then((ok) => {
                  if (ok) closeNow();
                });
              }}
            >
              Yes
            </RetroButton>
            <RetroButton onClick={closeNow}>No</RetroButton>
            <RetroButton onClick={() => setDialog(null)}>Cancel</RetroButton>
          </div>
        </RetroDialog>
      )}

      {dialog === 'attributes' && (
        <AttributesDialog
          width={size.w}
          height={size.h}
          onClose={() => setDialog(null)}
          onApply={(w, h, stretch) => {
            setDialog(null);
            resizeTo(w, h, stretch);
          }}
        />
      )}

      {dialog === 'about' && (
        <RetroDialog title="About Paint" onClose={() => setDialog(null)} className="w-[22rem]">
          <div className="flex gap-3">
            <img src="/icons/apps/paint.png" alt="" className="size-12 shrink-0" />
            <div className="space-y-2">
              <p className="font-bold">Din Paint</p>
              <p>Version 1.0 for Din</p>
              <p>
                Pencils for pixels, stamps for silliness, and dynamite for fresh starts. Zoom way in, turn on the grid,
                pick the Underground palette and make a monster.
              </p>
              <p className="italic">* Despite everything, it’s still you.</p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <RetroButton autoFocus onClick={() => setDialog(null)}>OK</RetroButton>
          </div>
        </RetroDialog>
      )}

      {error && (
        <RetroDialog title="Paint" onClose={() => setError(null)} className="w-80">
          <div className="flex items-start gap-3">
            <span className="text-3xl leading-none" aria-hidden>🛑</span>
            <p className="pt-1 break-words">{error}</p>
          </div>
          <div className="mt-4 flex justify-center">
            <RetroButton autoFocus onClick={() => setError(null)}>OK</RetroButton>
          </div>
        </RetroDialog>
      )}
    </div>
  );
}

function AttributesDialog({
  width,
  height,
  onClose,
  onApply,
}: {
  width: number;
  height: number;
  onClose: () => void;
  onApply: (w: number, h: number, stretch: boolean) => void;
}) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const [stretch, setStretch] = useState(false);
  const wn = Number(w);
  const hn = Number(h);
  const valid = Number.isInteger(wn) && Number.isInteger(hn) && wn >= 1 && hn >= 1 && wn <= 8192 && hn <= 8192;
  const input = cn('h-[21px] w-20 bg-white px-1 text-black outline-none', FIELD, FOCUS);
  return (
    <RetroDialog title="Canvas Size" onClose={onClose} className="w-72">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onApply(wn, hn, stretch);
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <label htmlFor="paint-width">Width:</label>
          <input id="paint-width" data-autofocus inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} className={input} />
          <label htmlFor="paint-height">Height:</label>
          <input id="paint-height" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} className={input} />
        </div>
        <fieldset className="border border-[#808080] p-2 shadow-[1px_1px_#fff]">
          <legend className="px-1">Presets</legend>
          <div className="flex flex-wrap gap-1">
            {CANVAS_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  setW(String(p.width));
                  setH(String(p.height));
                }}
                className={cn('px-1 text-left underline decoration-dotted', FOCUS)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={stretch} onChange={(e) => setStretch(e.target.checked)} className="accent-[#000080]" />
          Stretch the picture to fit
        </label>
        <div className="flex justify-end gap-1.5">
          <RetroButton type="submit" disabled={!valid}>OK</RetroButton>
          <RetroButton onClick={onClose}>Cancel</RetroButton>
        </div>
      </form>
    </RetroDialog>
  );
}

const BASIC_COLORS = [
  '#ff8080', '#ffff80', '#80ff80', '#00ff80', '#80ffff', '#0080ff', '#ff80c0', '#ff80ff',
  '#ff0000', '#ffff00', '#80ff00', '#00ff40', '#00ffff', '#0080c0', '#8080c0', '#ff00ff',
  '#804040', '#ff8040', '#00ff00', '#008080', '#004080', '#8080ff', '#800040', '#ff0080',
  '#800000', '#ff8000', '#008000', '#008040', '#0000ff', '#0000a0', '#800080', '#8000ff',
  '#400000', '#804000', '#004000', '#004040', '#000080', '#000040', '#400040', '#400080',
  '#000000', '#808000', '#808040', '#808080', '#408080', '#c0c0c0', '#202020', '#ffffff',
];

function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

/** The Edit Colors dialog: basic colors, or mix your own. */
function EditColorsDialog({
  color,
  onClose,
  onOk,
}: {
  color: string;
  onClose: () => void;
  onOk: (color: string) => void;
}) {
  const [value, setValue] = useState(color);
  const [hex, setHex] = useState(color);
  const [h, s, l] = toHsl(value);
  const set = (c: string) => {
    setValue(c);
    setHex(c);
  };
  const fromHsl = (nh: number, ns: number, nl: number) => set(unpack(hsl(nh, ns / 100, nl / 100)));
  const slider = (label: string, v: number, max: number, onChange: (n: number) => void, background: string) => (
    <label className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={max}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-3 w-full cursor-pointer appearance-none accent-[#000080]"
        style={{ background }}
      />
      <span className="text-right tabular-nums">{v}</span>
    </label>
  );
  return (
    <RetroDialog title="Edit Colors" onClose={onClose} className="w-[22rem]">
      <p className="mb-1">Basic colors:</p>
      <div className="grid grid-cols-8 gap-1">
        {BASIC_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={value === c}
            onClick={() => set(c)}
            className={cn('h-4 w-full', SUNKEN, FOCUS, value === c && 'outline outline-1 outline-black outline-offset-1')}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {slider('Hue', h, 359, (v) => fromHsl(v, s, l), 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)')}
        {slider('Saturation', s, 100, (v) => fromHsl(h, v, l), `linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`)}
        {slider('Lightness', l, 100, (v) => fromHsl(h, s, v), `linear-gradient(to right, #000, hsl(${h} ${s}% 50%), #fff)`)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className={cn('h-10 w-16 shrink-0', SUNKEN)} style={{ background: value }} aria-label="Color preview" role="img" />
        <label className="flex items-center gap-1">
          Hex:
          <input
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
              const v = e.target.value.trim().toLowerCase();
              const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(v);
              if (m) set(`#${m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]}`);
            }}
            onBlur={() => setHex(value)}
            spellCheck={false}
            className={cn('h-[21px] w-20 bg-white px-1 font-mono text-black outline-none', FIELD, FOCUS)}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-1.5">
        <RetroButton autoFocus onClick={() => onOk(value)}>OK</RetroButton>
        <RetroButton onClick={onClose}>Cancel</RetroButton>
      </div>
    </RetroDialog>
  );
}
