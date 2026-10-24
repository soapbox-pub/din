import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdjustmentLayer, LayerEffectsInfo } from 'ag-psd';
import { FilePlus, FolderOpen } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, getFsBridge, parentPath } from '@/lib/fs';
import { setCloseGuard } from '@/lib/closeGuards';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { ADJUSTMENT_NAMES, defaultAdjustment, FILTER_NAMES, type FilterSpec } from './photo/adjust';
import { OptionsBar, Toolbar } from './photo/bars';
import { Button, Dialog } from './photo/chrome';
import { FOCUS, INPUT } from './photo/styles';
import {
  AdjustmentDialog,
  CanvasSizeDialog,
  ConfirmDialog,
  FillDialog,
  FilterDialog,
  ImageSizeDialog,
  LayerStyleDialog,
  NewDocDialog,
  RadiusDialog,
  type BackgroundChoice,
  type FillContents,
} from './photo/dialogs';
import { PhotoMenus, type Commands, type MenuState, type PanelId } from './photo/menus';
import {
  allLayers,
  blankLayer,
  canvasBytes,
  cloneCanvas,
  ctx2d,
  findLayer,
  findPlace,
  freshName,
  isEffectivelyHidden,
  makeCanvas,
  newDoc,
  solidMask,
  newId,
  opaqueBounds,
  updateLayer,
  walkTopDown,
  type Doc,
  type Layer,
  type Mask,
  type Rect,
  type TextData,
} from './photo/model';
import * as ops from './photo/ops';
import { dab, drawGradient, fillRegion, hardDab, stampLine } from './photo/paint';
import { ColorPanel, HistoryPanel, LayersPanel, Panel, PropertiesPanel, SwatchesPanel } from './photo/panels';
import { decodeImage, encodeDoc, isPsd, OPEN_EXTENSIONS, pngBlob, readDoc, SAVE_TYPES, savesAs } from './photo/psd';
import { renderDoc, renderLayerAlone, renderLayers } from './photo/render';
import * as selection from './photo/selection';
import type { Point, SelectMode, Selection } from './photo/selection';
import { DEFAULT_OPTIONS, PAINTS, TOOL_GROUPS, TOOLS, type ToolId, type ToolOptions } from './photo/tools';
import { boxCorners, drawScene, HANDLES, handlePoint, rectHandles, zoomStep, type Box, type Overlay, type View } from './photo/view';

const SETTINGS_KEY = 'din:photo-editor:settings';
/** Bigger files than this aren't read. */
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_HISTORY = 50;
/** History keeps about this much pixel memory before dropping its oldest states. */
const HISTORY_BUDGET = 1.5 * 1024 * 1024 * 1024;

interface Entry {
  label: string;
  doc: Doc;
  selection: Selection | null;
  activeId: number | null;
  /** Edits with the same key in a row (scrubbing opacity) make one state. */
  coalesce?: string;
}

interface Hist {
  entries: Entry[];
  index: number;
}

interface Settings {
  options: ToolOptions;
  fg: string;
  bg: string;
  panels: Record<PanelId, boolean>;
  choice: Record<number, ToolId>;
  tool: ToolId;
}

const DEFAULT_SETTINGS: Settings = {
  options: DEFAULT_OPTIONS,
  fg: '#000000',
  bg: '#ffffff',
  panels: { color: true, swatches: false, history: false, properties: true, layers: true },
  choice: {},
  tool: 'brush',
};

function readSettings(): Settings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
    const s = saved as Partial<Settings>;
    const options = { ...DEFAULT_OPTIONS } as ToolOptions;
    for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof ToolOptions)[]) {
      const v = s.options?.[k];
      if (v === undefined) continue;
      (options as unknown as Record<string, unknown>)[k] = typeof v === 'object' ? { ...(DEFAULT_OPTIONS[k] as object), ...v } : v;
    }
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      options,
      panels: { ...DEFAULT_SETTINGS.panels, ...s.panels },
      tool: TOOLS.some((t) => t.id === s.tool) ? s.tool! : DEFAULT_SETTINGS.tool,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
const fmtZoom = (z: number) => `${z >= 1 ? Math.round(z * 100) : Math.round(z * 1000) / 10}%`;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** What a pointer gesture does as it moves and when it lets go. */
interface Gesture {
  move(p: Point, e: PointerEvent): void;
  up(p: Point, e: PointerEvent): void;
  cancel?(): void;
}

/** Pixels lifted off a layer to move or transform, until they're put down. */
interface Float {
  id: number;
  piece: HTMLCanvasElement;
  /** The layer without the piece, when it came from a selection. */
  base: ops.Surface | null;
  orig: Box;
  box: Box;
  /** The selection it came from, to carry along. */
  selection: Selection | null;
  label: string;
}

/** Text being typed: what and where. How it looks comes from the Type tool's options. */
interface Typing {
  id: number | null;
  text: string;
  x: number;
  y: number;
}

type DialogState =
  | { kind: 'new' }
  | { kind: 'imageSize' }
  | { kind: 'canvasSize' }
  | { kind: 'adjust'; adj: AdjustmentLayer }
  | { kind: 'filter'; spec: FilterSpec }
  | { kind: 'fill' }
  | { kind: 'style' }
  | { kind: 'radius'; how: 'feather' | 'expand' | 'contract' }
  | { kind: 'unsaved' }
  | { kind: 'rasterize'; run: (d: Doc) => void }
  | null;

/** A layer mask that shows what's selected. */
function selectionMask(d: Doc, s: Selection): Mask {
  const m = solidMask(d, 0);
  ctx2d(m.canvas).drawImage(s.mask, 0, 0);
  return m;
}

/** Lay a float's piece, scaled and turned, over its base: the layer as it'd be if put down now. */
function placeFloat(f: Float, layer: Layer): Layer {
  const corners = boxCorners(f.box);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const bx = Math.floor(Math.min(...xs));
  const by = Math.floor(Math.min(...ys));
  const bw = Math.ceil(Math.max(...xs)) - bx;
  const bh = Math.ceil(Math.max(...ys)) - by;
  const moved = f.box.w === f.orig.w && f.box.h === f.orig.h && f.box.angle === 0;
  let x0 = bx;
  let y0 = by;
  let x1 = bx + bw;
  let y1 = by + bh;
  if (f.base) {
    x0 = Math.min(x0, f.base.left);
    y0 = Math.min(y0, f.base.top);
    x1 = Math.max(x1, f.base.left + f.base.canvas.width);
    y1 = Math.max(y1, f.base.top + f.base.canvas.height);
  }
  const canvas = makeCanvas(x1 - x0, y1 - y0);
  const c = ctx2d(canvas);
  if (f.base) c.drawImage(f.base.canvas, f.base.left - x0, f.base.top - y0);
  c.save();
  c.imageSmoothingQuality = 'high';
  c.translate(f.box.cx - x0, f.box.cy - y0);
  c.rotate(f.box.angle);
  c.scale(f.box.w / f.orig.w, f.box.h / f.orig.h);
  if (moved) c.imageSmoothingEnabled = false;
  c.drawImage(f.piece, -f.orig.w / 2, -f.orig.h / 2);
  c.restore();
  const dx = f.box.cx - f.orig.cx;
  const dy = f.box.cy - f.orig.cy;
  // A plain move keeps a type or smart layer what it is; anything more makes pixels.
  const keepKind = moved && !f.base;
  return {
    ...layer,
    canvas,
    left: x0,
    top: y0,
    kind: keepKind ? layer.kind : 'pixel',
    text: keepKind && layer.text ? { ...layer.text, x: layer.text.x + dx, y: layer.text.y + dy } : keepKind ? layer.text : null,
    mask: !f.base && moved && layer.mask ? { ...layer.mask, left: layer.mask.left + dx, top: layer.mask.top + dy } : layer.mask,
    vectorMask: keepKind && layer.vectorMask ? { ...layer.vectorMask, left: layer.vectorMask.left + dx, top: layer.vectorMask.top + dy } : null,
  };
}

/**
 * Photo Editor - layered pictures, Photoshop style: opens and saves PSDs
 * with their layers, groups, masks, blend modes, adjustment layers and
 * type, with Photoshop's tools, menus, panels and shortcuts. Also opens
 * PNG, JPEG and the like, and exports them.
 *
 * Launch params: `{ path?: string }` (absolute).
 */
export function PhotoEditor({ windowId, params }: AppComponentProps) {
  const initial = typeof params?.path === 'string' ? params.path : null;
  const fs = getFsBridge();
  const { open, close, focus } = useWindowActions();
  const { pickFile, pickFiles } = useFilePicker();
  const queryClient = useQueryClient();

  const [settings, setSettings] = useState(readSettings);
  const { options, fg, bg, panels } = settings;
  const [tool, setToolState] = useState<ToolId>(settings.tool);
  // File > New from another window opens this one with the new document's size.
  const [boot] = useState(() => {
    if (initial) return null;
    const w = typeof params?.width === 'number' ? Math.round(params.width) : 0;
    const h = typeof params?.height === 'number' ? Math.round(params.height) : 0;
    if (w < 1 || h < 1 || w > 16384 || h > 16384) return null;
    const d = newDoc(w, h, isHex(params?.background) ? params.background : null);
    const entry: Entry = { label: 'New', doc: d, selection: null, activeId: d.layers[0].id };
    return { entry, name: typeof params?.name === 'string' && params.name ? params.name : 'Untitled-1' };
  });
  const [hist, setHist] = useState<Hist | null>(() => (boot ? { entries: [boot.entry], index: 0 } : null));
  const [activeState, setActiveId] = useState<number | null>(null);
  const [selectedState, setSelectedIds] = useState<Set<number>>(new Set());
  const [editMask, setEditMask] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [docName, setDocName] = useState(boot?.name ?? 'Untitled-1');
  const [savedEntry, setSavedEntry] = useState<Entry | null>(boot?.entry ?? null);
  const [lastSel, setLastSel] = useState<Selection | null>(null);
  const [panning, setPanning] = useState(false);
  const [loading, setLoading] = useState(initial !== null && fs !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [zoomShown, setZoomShown] = useState(1);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [float, setFloat] = useState<Float | null>(null);
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [colorEditing, setColorEditing] = useState<'fg' | 'bg'>('fg');
  const [hidePanels, setHidePanels] = useState(false);
  const [lastFilter, setLastFilter] = useState<FilterSpec | null>(null);
  const [polyPoints, setPolyPoints] = useState<Point[] | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [altDown, setAltDown] = useState(false);
  const [cloneSource, setCloneSource] = useState<Point | null>(null);
  const [clipSize, setClipSize] = useState<{ w: number; h: number } | null>(null);
  const [compositeCanvas] = useState(() => document.createElement('canvas'));

  const cur = hist ? hist.entries[hist.index] : null;
  const doc = cur?.doc ?? null;
  const sel = cur?.selection ?? null;
  // The active layer: as chosen, or (after an undo took it away) the one history remembers, or the top one.
  const activeId = !doc
    ? null
    : activeState !== null && findLayer(doc.layers, activeState)
      ? activeState
      : cur && cur.activeId !== null && findLayer(doc.layers, cur.activeId)
        ? cur.activeId
        : (doc.layers[doc.layers.length - 1]?.id ?? null);
  const active = doc && activeId !== null ? findLayer(doc.layers, activeId) : null;
  const selectedIds = new Set([...selectedState].filter((id) => doc && findLayer(doc.layers, id)));
  if (activeId !== null) selectedIds.add(activeId);
  const target: ops.Target = active?.mask && (editMask || active.kind === 'adjustment' || active.kind === 'group') ? 'mask' : 'pixels';
  const dirty = !!cur && cur !== savedEntry;
  const typingData: TextData | null = typing ? { ...options.type, text: typing.text, x: typing.x, y: typing.y, color: fg } : null;
  const docW = doc?.width ?? 0;
  const docH = doc?.height ?? 0;
  const crop = useMemo(() => (tool === 'crop' && docW ? (cropRect ?? { x: 0, y: 0, w: docW, h: docH }) : null), [tool, docW, docH, cropRect]);

  // What the render loop and gestures read; they run outside React's renders.
  useLayoutEffect(() => {
    docRef.current = doc;
    selRef.current = sel;
    cloneRef.current = tool === 'clone' ? cloneSource : null;
    typingRef.current = typingData;
  });

  // ---- Refs for the render loop and gestures ----------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLCanvasElement>(null);
  const compositeRef = useRef<HTMLCanvasElement>(compositeCanvas);
  const viewRef = useRef<View>({ zoom: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const liveRef = useRef<{ doc: Doc | null; selection: Selection | null | undefined; masks: Set<HTMLCanvasElement> }>({
    doc: null,
    selection: undefined,
    masks: new Set(),
  });
  const overlayRef = useRef<Overlay | null>(null);
  const cursorRef = useRef<{ x: number; y: number; r: number } | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef(0);
  const needComposite = useRef(true);
  const antsPhase = useRef(0);
  const docRef = useRef<Doc | null>(null);
  const selRef = useRef<Selection | null>(null);
  const lastPaint = useRef<Point | null>(null);
  const cloneOffset = useRef<Point | null>(null);
  const clipboard = useRef<{ canvas: HTMLCanvasElement; x: number; y: number } | null>(null);
  const cloneRef = useRef<Point | null>(null);
  const loadSeq = useRef(0);
  const fitPending = useRef(!!boot);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef<TextData | null>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, tool }));
  }, [settings, tool]);

  const setOptions = useCallback((fn: (o: ToolOptions) => ToolOptions) => setSettings((s) => ({ ...s, options: fn(s.options) })), []);
  const setColor = useCallback((which: 'fg' | 'bg', hex: string) => setSettings((s) => ({ ...s, [which]: hex })), []);

  const title = doc
    ? `${dirty ? '• ' : ''}${docName} @ ${fmtZoom(zoomShown)} (${active ? (target === 'mask' ? `${active.name}, Layer Mask` : active.name) : 'RGB'}, RGB/8)`
    : 'Photo Editor';
  useWindowTitle(title);

  // ---- Drawing -----------------------------------------------------------------------------

  const frame = useCallback(() => {
    rafRef.current = 0;
    const canvas = screenRef.current;
    const composite = compositeRef.current!;
    const d = liveRef.current.doc ?? docRef.current;
    if (!canvas || !d) return;
    if (needComposite.current) {
      renderDoc(d, composite, { liveMasks: liveRef.current.masks });
      needComposite.current = false;
    }
    const s = liveRef.current.selection !== undefined ? liveRef.current.selection : selRef.current;
    drawScene(
      canvas,
      {
        docW: d.width,
        docH: d.height,
        composite,
        view: viewRef.current,
        overlay: overlayRef.current,
        ants: s ? selection.outline(s) : null,
        antsBounds: s?.bounds ?? null,
        antsPhase: antsPhase.current,
        cursor: cursorRef.current,
        cloneSource: cloneRef.current,
      },
      sizeRef.current.w,
      sizeRef.current.h,
      window.devicePixelRatio || 1,
    );
    // The type box follows the text as the view moves.
    const t = typingRef.current;
    const ta = textareaRef.current;
    if (t && ta) {
      const v = viewRef.current;
      ta.style.left = `${v.x + t.x * v.zoom}px`;
      ta.style.top = `${v.y + t.y * v.zoom - t.size * v.zoom * 1.08}px`;
    }
  }, []);

  const schedule = useCallback(
    (composite = false) => {
      if (composite) needComposite.current = true;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(frame);
    },
    [frame],
  );

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /** Show a document that isn't history yet (mid-stroke, previews). Null goes back to the real one. */
  const setLive = useCallback(
    (d: Doc | null, s?: Selection | null) => {
      liveRef.current.doc = d;
      liveRef.current.selection = s;
      schedule(true);
    },
    [schedule],
  );

  useLayoutEffect(() => {
    if (!liveRef.current.doc) schedule(true);
  }, [doc, schedule]);
  useLayoutEffect(() => schedule(), [sel, schedule]);

  // Marching ants march.
  useEffect(() => {
    if (!sel && !overlayRef.current) return;
    const t = setInterval(() => {
      antsPhase.current = (antsPhase.current + 1) % 8;
      schedule();
    }, 120);
    return () => clearInterval(t);
  }, [sel, schedule, crop, polyPoints]);

  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      setZoomShown(v.zoom);
      schedule();
    },
    [schedule],
  );

  const fit = useCallback(
    (maxZoom = Infinity, of?: Doc) => {
      const d = of ?? docRef.current;
      const { w, h } = sizeRef.current;
      if (!d || !w || !h) {
        fitPending.current = true;
        return;
      }
      const zoom = Math.min(maxZoom, (w - 48) / d.width, (h - 48) / d.height);
      const z = Math.max(1 / 32, zoom);
      setView({ zoom: z, x: Math.round((w - d.width * z) / 2), y: Math.round((h - d.height * z) / 2) });
    },
    [setView],
  );

  const zoomAt = useCallback(
    (z: number, sx?: number, sy?: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const mx = sx ?? w / 2;
      const my = sy ?? h / 2;
      const nz = Math.max(1 / 32, Math.min(32, z));
      setView({ zoom: nz, x: mx - (mx - v.x) * (nz / v.zoom), y: my - (my - v.y) * (nz / v.zoom) });
    },
    [setView],
  );

  // The viewport's size.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const was = sizeRef.current;
      sizeRef.current = { w: r.width, h: r.height };
      if (fitPending.current && docRef.current && r.width && r.height) {
        fitPending.current = false;
        fit(1);
      } else if (was.w && was.h) {
        // Keep the picture where it was relative to the middle.
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + (r.width - was.w) / 2, y: v.y + (r.height - was.h) / 2 };
      }
      schedule();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, schedule]);

  // ---- History ---------------------------------------------------------------------------------

  const commit = useCallback(
    (label: string, d: Doc, opts: { selection?: Selection | null; activeId?: number | null; coalesce?: string } = {}) => {
      liveRef.current = { doc: null, selection: undefined, masks: new Set() };
      overlayRef.current = null;
      setHist((h) => {
        if (!h) return h;
        const top = h.entries[h.index];
        const entry: Entry = {
          label,
          doc: d,
          selection: opts.selection !== undefined ? opts.selection : top.selection,
          activeId: opts.activeId !== undefined ? opts.activeId : top.activeId,
          coalesce: opts.coalesce,
        };
        const entries = h.entries.slice(0, h.index + 1);
        if (opts.coalesce && top.coalesce === opts.coalesce && h.index === h.entries.length - 1 && h.index > 0) entries[entries.length - 1] = entry;
        else entries.push(entry);
        while (entries.length > MAX_HISTORY || (entries.length > 3 && canvasBytes(entries.map((e) => e.doc)) > HISTORY_BUDGET)) entries.shift();
        return { entries, index: entries.length - 1 };
      });
      if (opts.activeId !== undefined) {
        setActiveId(opts.activeId);
        setSelectedIds(new Set(opts.activeId !== null ? [opts.activeId] : []));
      }
      if (opts.selection !== undefined && selRef.current) setLastSel(selRef.current);
      setStatus(null);
      schedule(true);
    },
    [schedule],
  );

  const jump = useCallback(
    (index: number) => {
      if (!hist || index < 0 || index >= hist.entries.length) return;
      const e = hist.entries[index];
      setHist({ ...hist, index });
      if (e.activeId !== null && findLayer(e.doc.layers, e.activeId)) {
        setActiveId(e.activeId);
        setSelectedIds(new Set([e.activeId]));
      }
      setFloat(null);
      setTyping(null);
      setLive(null);
    },
    [hist, setLive],
  );

  const startDoc = useCallback(
    (d: Doc, name: string, p: string | null) => {
      const top = d.layers[d.layers.length - 1];
      const entry: Entry = { label: p ? 'Open' : 'New', doc: d, selection: null, activeId: top?.id ?? null };
      setHist({ entries: [entry], index: 0 });
      setSavedEntry(entry);
      setActiveId(top?.id ?? null);
      setSelectedIds(new Set(top ? [top.id] : []));
      setEditMask(false);
      setPath(p);
      setDocName(name);
      setFloat(null);
      setCropRect(null);
      setTyping(null);
      setError(null);
      liveRef.current = { doc: null, selection: undefined, masks: new Set() };
      setLastSel(null);
      fitPending.current = true;
      requestAnimationFrame(() => {
        if (sizeRef.current.w) {
          fitPending.current = false;
          fit(1, d);
        }
      });
    },
    [fit],
  );

  // ---- Files ---------------------------------------------------------------------------------------

  const load = useCallback(
    (p: string) => {
      if (!fs) return;
      const seq = ++loadSeq.current;
      (async () => {
        try {
          const r = await fs.readFile(p, MAX_BYTES);
          if (r.truncated) throw new Error(`It’s too big to open (${formatBytes(r.size ?? r.data.length)}; up to 1 GB).`);
          const d = await readDoc(r.data, p);
          if (seq !== loadSeq.current) return;
          startDoc(d, basename(p), p);
        } catch (err) {
          if (seq !== loadSeq.current) return;
          setError(`Couldn’t open ${basename(p)}. ${err instanceof Error ? err.message : cleanFsError(err)}`);
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      })();
    },
    [fs, startDoc],
  );

  // Keys go to the editor: at first, and again once a dialog or the type box that had them goes away.
  useEffect(() => {
    if (dialog || typing) return;
    const a = document.activeElement;
    if (!a || a === document.body || !rootRef.current?.contains(a)) rootRef.current?.focus({ preventScroll: true });
  }, [dialog, typing]);

  const [prevInitial, setPrevInitial] = useState<string | null>(null);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (initial && fs) {
      setLoading(true);
      setError(null);
    }
  }
  useEffect(() => {
    if (initial) load(initial);
  }, [initial, load]);

  const writeTo = useCallback(
    async (p: string): Promise<boolean> => {
      const d = docRef.current;
      if (!fs || !d || !hist) return false;
      setBusy(true);
      setStatus('Saving…');
      try {
        // Let "Saving…" paint before the encoder holds the thread.
        await new Promise((r) => setTimeout(r, 30));
        const bytes = await encodeDoc(d, p);
        await fs.writeFile(p, bytes);
        const entry = hist.entries[hist.index];
        if (isPsd(p) || allLayers(d.layers).length === 1) {
          setSavedEntry(entry);
          setPath(p);
          setDocName(basename(p));
        }
        setStatus(`Saved ${basename(p)}`);
        void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', p] });
        void invalidateListings(queryClient, p);
        return true;
      } catch (err) {
        setStatus(`Couldn’t save ${basename(p)}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fs, hist, queryClient],
  );

  const saveAs = useCallback(
    async (exporting = false): Promise<boolean> => {
      const stem = docName.replace(/\.[^.]*$/, '');
      const types = exporting ? SAVE_TYPES.slice(1) : SAVE_TYPES;
      const result = await pickFiles({
        mode: 'save',
        title: exporting ? 'Export As' : 'Save As',
        currentName: `${stem}.${exporting ? 'png' : 'psd'}`,
        initialPath: path ? parentPath(path) : undefined,
        filters: types,
      });
      if (!result) return false;
      let t = result.paths[0];
      if (!savesAs(t) || (exporting && isPsd(t))) {
        const filter = types[result.filter ?? 0] ?? types[0];
        t += filter.patterns[0].slice(1);
      }
      return writeTo(t);
    },
    [pickFiles, docName, path, writeTo],
  );

  const save = useCallback((): Promise<boolean> => {
    const d = docRef.current;
    if (!d) return Promise.resolve(false);
    // Layers only survive in a PSD; a flat picture can go back where it came from.
    if (path && (isPsd(path) || (savesAs(path) && allLayers(d.layers).length === 1))) return writeTo(path);
    return saveAs();
  }, [path, writeTo, saveAs]);

  const quickExport = useCallback(async () => {
    const d = docRef.current;
    if (!d || !fs) return;
    if (!path) {
      void saveAs(true);
      return;
    }
    const p = `${path.replace(/\.[^./]*$/, '')}.png`;
    setBusy(true);
    try {
      await fs.writeFile(p, await encodeDoc(d, p));
      setStatus(`Exported ${basename(p)}`);
      void invalidateListings(queryClient, p);
    } catch (err) {
      setStatus(`Couldn’t export: ${cleanFsError(err)}`);
    } finally {
      setBusy(false);
    }
  }, [fs, path, saveAs, queryClient]);

  const openFile = useCallback(async () => {
    const t = await pickFile({ title: 'Open', extensions: OPEN_EXTENSIONS, initialPath: path ? parentPath(path) : undefined });
    if (!t) return;
    // Work in progress stays put; the file gets a window of its own.
    if (docRef.current && (dirty || path)) {
      open('photo-editor', { path: t });
      return;
    }
    load(t);
  }, [pickFile, path, dirty, open, load]);

  // Closing with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    setCloseGuard(windowId, () => {
      focus(windowId);
      setDialog({ kind: 'unsaved' });
      return true;
    });
    return () => setCloseGuard(windowId, null);
  }, [dirty, windowId, focus]);

  const closeNow = useCallback(() => {
    setCloseGuard(windowId, null);
    setDialog(null);
    close(windowId);
  }, [windowId, close]);

  // ---- Helpers for edits ----------------------------------------------------------------------------

  const say = (msg: string) => setStatus(msg);

  /** Run a pixel edit on the active layer, rasterizing a type/smart/shape layer first (after asking). */
  const pixelEdit = (label: string, fn: (d: Doc, id: number) => Doc) => {
    const d = docRef.current;
    if (!d || !active) return;
    if (active.locked) return say(`“${active.name}” is locked.`);
    if (target === 'pixels' && (active.kind === 'group' || active.kind === 'adjustment')) {
      return say('Choose a pixel layer, or the layer’s mask, to change pixels.');
    }
    if (target === 'pixels' && active.kind !== 'pixel') {
      setDialog({ kind: 'rasterize', run: (r) => commit(label, fn(r, active.id)) });
      return;
    }
    commit(label, fn(d, active.id));
  };

  const needsPixels = (): boolean => {
    if (!active) return false;
    if (active.locked) {
      say(`“${active.name}” is locked.`);
      return false;
    }
    if (target === 'mask') return true;
    if (active.kind === 'pixel') return true;
    if (active.kind === 'group' || active.kind === 'adjustment') {
      say('Choose a pixel layer to paint on (or click a layer mask to paint the mask).');
      return false;
    }
    setDialog({ kind: 'rasterize', run: (r) => commit('Rasterize Layer', r) });
    return false;
  };

  /** A doc-sized picture of what tools sample: the merged image, or just the active layer. */
  const sampleImage = (all: boolean): ImageData | null => {
    const d = docRef.current;
    if (!d) return null;
    const src = all || !active ? compositeRef.current! : renderLayerAlone({ ...active, opacity: 1, effects: null, mask: null }, d.width, d.height);
    return src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, d.width, d.height);
  };

  const pickColor = (p: Point, toBg: boolean, all = options.eyedropper.sampleAll) => {
    const d = docRef.current;
    if (!d) return;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    const src = all || !active ? compositeRef.current! : renderLayerAlone({ ...active, opacity: 1 }, d.width, d.height);
    const px = src.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
    if (px[3] === 0) return;
    const hex = `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    setColor(toBg ? 'bg' : 'fg', hex);
  };

  const toDoc = (e: { clientX: number; clientY: number }): Point => {
    const r = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
  };
  const toScreen = (p: Point): Point => {
    const v = viewRef.current;
    return { x: v.x + p.x * v.zoom, y: v.y + p.y * v.zoom };
  };

  const selectMode = (e: { shiftKey: boolean; altKey: boolean }): SelectMode =>
    e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : options.selectMode;

  const applySelectShape = (mask: HTMLCanvasElement, mode: SelectMode, label: string) => {
    const d = docRef.current!;
    let shape = mask;
    if (options.feather > 0) shape = selection.feather({ mask, bounds: { x: 0, y: 0, w: d.width, h: d.height } }, options.feather)?.mask ?? mask;
    const next = selection.combine(selRef.current, shape, mode);
    commit(label, d, { selection: next });
  };

  const layerAt = (p: Point): Layer | null => {
    const d = docRef.current;
    if (!d) return null;
    for (const { layer } of walkTopDown(d.layers)) {
      if (layer.kind === 'group' || layer.kind === 'adjustment' || !layer.canvas || isEffectivelyHidden(d.layers, layer.id)) continue;
      const x = Math.floor(p.x - layer.left);
      const y = Math.floor(p.y - layer.top);
      if (x < 0 || y < 0 || x >= layer.canvas.width || y >= layer.canvas.height) continue;
      if (layer.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data[3] > 0) return layer;
    }
    return null;
  };

  // ---- Floating pixels (move with a selection, Free Transform) ----------------------------------------

  const liftFloat = (d: Doc, l: Layer, s: Selection | null, label: string): Float | null => {
    if (!l.canvas) return null;
    if (s && l.kind === 'pixel') {
      const surf = ops.workingSurface(l, 'pixels', d);
      const b = s.bounds;
      const piece = makeCanvas(b.w, b.h);
      const pc = ctx2d(piece);
      pc.drawImage(surf.canvas, surf.left - b.x, surf.top - b.y);
      pc.globalCompositeOperation = 'destination-in';
      pc.drawImage(s.mask, -b.x, -b.y);
      const baseCanvas = cloneCanvas(surf.canvas);
      const bc = ctx2d(baseCanvas);
      bc.globalCompositeOperation = 'destination-out';
      bc.drawImage(s.mask, -surf.left, -surf.top);
      const box: Box = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0 };
      return { id: l.id, piece, base: { canvas: baseCanvas, left: surf.left, top: surf.top }, orig: box, box, selection: s, label };
    }
    // The box hugs the layer's pixels, not its whole canvas.
    const b = opaqueBounds(l.canvas);
    if (!b) return null;
    const piece = makeCanvas(b.w, b.h);
    ctx2d(piece).drawImage(l.canvas, -b.x, -b.y);
    const box: Box = { cx: l.left + b.x + b.w / 2, cy: l.top + b.y + b.h / 2, w: b.w, h: b.h, angle: 0 };
    return { id: l.id, piece, base: null, orig: box, box, selection: null, label };
  };

  const showFloat = (f: Float) => {
    const d = docRef.current;
    if (!d) return;
    const l = findLayer(d.layers, f.id);
    if (!l) return;
    setLive({ ...d, layers: updateLayer(d.layers, f.id, () => placeFloat(f, l)) }, f.selection ? null : undefined);
    overlayRef.current = f.label === 'Free Transform' ? { kind: 'transform', box: f.box } : null;
    schedule();
  };

  const commitFloat = (f: Float) => {
    const d = docRef.current;
    if (!d) return;
    const l = findLayer(d.layers, f.id);
    if (!l) return;
    const moved = f.box.w === f.orig.w && f.box.h === f.orig.h && f.box.angle === 0;
    let nextSel: Selection | null | undefined = undefined;
    if (f.selection) {
      if (moved) {
        const dx = Math.round(f.box.cx - f.orig.cx);
        const dy = Math.round(f.box.cy - f.orig.cy);
        const m = makeCanvas(d.width, d.height);
        ctx2d(m).drawImage(f.selection.mask, dx, dy);
        nextSel = selection.fromMask(m);
      } else {
        nextSel = null;
      }
    }
    setFloat(null);
    overlayRef.current = null;
    commit(f.label, { ...d, layers: updateLayer(d.layers, f.id, () => placeFloat(f, l)) }, { selection: nextSel });
  };

  const cancelFloat = () => {
    setFloat(null);
    overlayRef.current = null;
    setLive(null);
  };

  // ---- Type ---------------------------------------------------------------------------------------

  const commitTyping = useCallback(() => {
    const t = typing;
    const data = typingRef.current;
    const d = docRef.current;
    setTyping(null);
    setLive(null);
    if (!t || !d || !data) return;
    const text = data.text.replace(/\s+$/, '');
    if (t.id !== null) {
      const l = findLayer(d.layers, t.id);
      if (!l) return;
      if (!text) {
        const r = ops.deleteLayers(d, new Set([t.id]), t.id);
        commit('Delete Layer', r.doc, { activeId: r.activeId ?? null });
        return;
      }
      const was = l.text;
      const same = was && (Object.keys(data) as (keyof TextData)[]).every((k) => (k === 'text' ? was.text === text : was[k] === data[k]));
      if (same) return;
      commit('Edit Type Layer', ops.setText(d, t.id, { ...data, text }));
    } else if (text) {
      const layer = ops.textLayer(d, { ...data, text });
      commit('Type Tool', ops.insertAbove(d, activeId, layer), { activeId: layer.id });
    }
  }, [typing, setLive, commit, activeId]);

  // While typing over an existing layer, hide it so the text isn't doubled.
  useEffect(() => {
    const d = docRef.current;
    if (!typing || !d) return;
    if (typing.id !== null) setLive({ ...d, layers: updateLayer(d.layers, typing.id, (l) => ({ ...l, hidden: true })) });
  }, [typing?.id, setLive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Place the type box once it's up.
  useLayoutEffect(() => schedule(), [typing, schedule]);

  // ---- Tool switching ------------------------------------------------------------------------------

  const setTool = useCallback(
    (t: ToolId) => {
      if (typing) commitTyping();
      setPolyPoints(null);
      overlayRef.current = null;
      setCropRect(null);
      setToolState(t);
      const gi = TOOL_GROUPS.findIndex((g) => g.some((x) => x.id === t));
      setSettings((s) => ({ ...s, choice: { ...s.choice, [gi]: t } }));
      schedule();
    },
    [typing, commitTyping, schedule],
  );

  const toolByKey = (key: string, cycle: boolean) => {
    const group = TOOL_GROUPS.find((g) => g[0].key === key.toUpperCase());
    if (!group) return false;
    const gi = TOOL_GROUPS.indexOf(group);
    const currentIdx = group.findIndex((t) => t.id === tool);
    if (cycle && group.length > 1) setTool(group[(Math.max(0, currentIdx) + 1) % group.length].id);
    else if (currentIdx === -1) setTool((group.find((t) => t.id === settings.choice[gi]) ?? group[0]).id);
    return true;
  };

  // ---- Pointer gestures --------------------------------------------------------------------------------

  const startPaint = (p: Point, e: React.PointerEvent): Gesture | null => {
    const d = docRef.current!;
    if (!active || !needsPixels()) return null;
    const kind = tool as 'brush' | 'pencil' | 'eraser' | 'clone';
    const o = options[kind];
    const tgt = target;
    const base = ops.workingSurface(active, tgt, d);
    const W = base.canvas.width;
    const H = base.canvas.height;
    const buf = makeCanvas(W, H);
    const bc = ctx2d(buf);
    const out = makeCanvas(W, H);
    const oc = ctx2d(out);
    if (tgt === 'mask') liveRef.current.masks.add(out);
    const lockAlpha = tgt === 'pixels' && active.lockAlpha;
    const erase = kind === 'eraser';
    const color = erase ? (tgt === 'mask' || lockAlpha ? ops.grayOf(bg) : '#000000') : tgt === 'mask' ? ops.grayOf(fg) : fg;
    const paintColor = erase && lockAlpha && tgt === 'pixels' ? bg : color;
    const size = Math.max(1, o.size);
    const stampImg = kind === 'pencil' ? hardDab(size, paintColor) : dab(size, o.hardness / 100, kind === 'clone' ? '#ffffff' : paintColor);
    const half = stampImg.width / 2;
    const spacing = kind === 'pencil' ? 1 : Math.max(1, size * 0.15);
    const s = selRef.current;
    bc.globalAlpha = kind === 'pencil' ? 1 : o.flow / 100;

    // The clone stamp copies from its source, offset from where you paint.
    let sample: ops.Surface | null = null;
    let offset: Point | null = null;
    let piece: HTMLCanvasElement | null = null;
    if (kind === 'clone') {
      if (!cloneSource) {
        say('Alt+click to choose where the Clone Stamp copies from.');
        return null;
      }
      sample = options.clone.sampleAll
        ? { canvas: cloneCanvas(compositeRef.current!), left: 0, top: 0 }
        : { canvas: cloneCanvas(base.canvas), left: base.left, top: base.top };
      if (!options.clone.aligned || !cloneOffset.current) cloneOffset.current = { x: p.x - cloneSource.x, y: p.y - cloneSource.y };
      offset = cloneOffset.current;
      piece = makeCanvas(stampImg.width, stampImg.height);
    }

    const stamp = (x: number, y: number) => {
      const sx = kind === 'pencil' ? Math.floor(x - half + 0.5) : x - half;
      const sy = kind === 'pencil' ? Math.floor(y - half + 0.5) : y - half;
      if (piece && sample && offset) {
        const pc = ctx2d(piece);
        pc.globalCompositeOperation = 'source-over';
        pc.clearRect(0, 0, piece.width, piece.height);
        pc.drawImage(sample.canvas, sample.left - (sx - offset.x), sample.top - (sy - offset.y));
        pc.globalCompositeOperation = 'destination-in';
        pc.drawImage(stampImg, 0, 0);
        bc.drawImage(piece, sx - base.left, sy - base.top);
      } else {
        bc.drawImage(stampImg, sx - base.left, sy - base.top);
      }
    };

    const masked = s ? makeCanvas(W, H) : null;
    const compose = () => {
      oc.globalCompositeOperation = 'source-over';
      oc.globalAlpha = 1;
      oc.clearRect(0, 0, W, H);
      oc.drawImage(base.canvas, 0, 0);
      let src = buf;
      if (masked && s) {
        const mc = ctx2d(masked);
        mc.globalCompositeOperation = 'source-over';
        mc.clearRect(0, 0, W, H);
        mc.drawImage(buf, 0, 0);
        mc.globalCompositeOperation = 'destination-in';
        mc.drawImage(s.mask, -base.left, -base.top);
        src = masked;
      }
      oc.globalAlpha = o.opacity / 100;
      oc.globalCompositeOperation = erase && tgt === 'pixels' && !lockAlpha ? 'destination-out' : lockAlpha ? 'source-atop' : 'source-over';
      oc.drawImage(src, 0, 0);
      oc.globalAlpha = 1;
      oc.globalCompositeOperation = 'source-over';
      setLive({ ...d, layers: updateLayer(d.layers, active.id, (l) => ops.withSurface(l, tgt, { ...base, canvas: out })) });
    };

    let last = p;
    let carry = 0;
    if (e.shiftKey && lastPaint.current) carry = stampLine(lastPaint.current, p, spacing, 0, stamp);
    else stamp(p.x, p.y);
    compose();
    const label = { brush: 'Brush Tool', pencil: 'Pencil Tool', eraser: 'Eraser', clone: 'Clone Stamp' }[kind];
    return {
      move(q) {
        carry = stampLine(last, q, spacing, carry === 0 ? spacing : carry, stamp);
        last = q;
        compose();
      },
      up(q) {
        lastPaint.current = q;
        const finished = { ...d, layers: updateLayer(d.layers, active.id, (l) => ops.withSurface(l, tgt, { ...base, canvas: out })) };
        liveRef.current.masks.delete(out);
        commit(label, finished);
      },
      cancel() {
        setLive(null);
      },
    };
  };

  const startMarquee = (p: Point, e: React.PointerEvent, ellipse: boolean): Gesture => {
    const d = docRef.current!;
    const mode = selectMode(e);
    const s = selRef.current;
    // Dragging inside the selection with nothing held moves its outline.
    if (mode === options.selectMode && options.selectMode === 'replace' && s && !e.shiftKey && !e.altKey) {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (x >= 0 && y >= 0 && x < d.width && y < d.height && s.mask.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data[3] > 0) {
        let moved: Selection | null = s;
        return {
          move(q) {
            const m = makeCanvas(d.width, d.height);
            ctx2d(m).drawImage(s.mask, Math.round(q.x - p.x), Math.round(q.y - p.y));
            moved = selection.fromMask(m);
            liveRef.current.selection = moved;
            schedule();
          },
          up() {
            liveRef.current.selection = undefined;
            if (moved !== s) commit('Move Selection', d, { selection: moved });
          },
        };
      }
    }
    const byModifier = e.shiftKey;
    let rect: Rect = { x: p.x, y: p.y, w: 0, h: 0 };
    return {
      move(q, ev) {
        let w = q.x - p.x;
        let h = q.y - p.y;
        if (ev.shiftKey && !byModifier) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        let x = p.x;
        let y = p.y;
        if (ev.altKey && mode !== 'subtract') {
          x -= w;
          y -= h;
          w *= 2;
          h *= 2;
        }
        rect = { x: Math.round(Math.min(x, x + w)), y: Math.round(Math.min(y, y + h)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) };
        overlayRef.current = { kind: 'marquee', rect, ellipse };
        schedule();
      },
      up() {
        overlayRef.current = null;
        if (rect.w < 1 || rect.h < 1) {
          if (mode === 'replace' && selRef.current) commit('Deselect', d, { selection: null });
          schedule();
          return;
        }
        applySelectShape(selection.rectMask(d.width, d.height, rect, ellipse), mode, ellipse ? 'Elliptical Marquee' : 'Rectangular Marquee');
      },
    };
  };

  const startLasso = (p: Point, e: React.PointerEvent): Gesture => {
    const d = docRef.current!;
    const mode = selectMode(e);
    const pts: Point[] = [p];
    overlayRef.current = { kind: 'lasso', points: pts, cursor: null };
    return {
      move(q) {
        if (dist(q, pts[pts.length - 1]) * viewRef.current.zoom >= 2) pts.push(q);
        overlayRef.current = { kind: 'lasso', points: pts, cursor: null };
        schedule();
      },
      up() {
        overlayRef.current = null;
        if (pts.length < 3) {
          if (mode === 'replace' && selRef.current) commit('Deselect', d, { selection: null });
          schedule();
          return;
        }
        applySelectShape(selection.polygonMask(d.width, d.height, pts), mode, 'Lasso');
      },
    };
  };

  const finishPolygon = (pts: Point[], mode: SelectMode = options.selectMode) => {
    const d = docRef.current;
    setPolyPoints(null);
    overlayRef.current = null;
    if (!d || pts.length < 3) return schedule();
    applySelectShape(selection.polygonMask(d.width, d.height, pts), mode, 'Polygonal Lasso');
  };
  const polyMode = useRef<SelectMode>('replace');

  const hitCrop = (sp: Point, r: Rect): number | 'inside' | null => {
    const hs = rectHandles(r).map(toScreen);
    for (let i = 0; i < hs.length; i++) if (dist(hs[i], sp) <= 7) return i;
    const a = toScreen({ x: r.x, y: r.y });
    const b = toScreen({ x: r.x + r.w, y: r.y + r.h });
    if (sp.x >= a.x && sp.x <= b.x && sp.y >= a.y && sp.y <= b.y) return 'inside';
    return null;
  };

  const startCrop = (p: Point, sp: Point): Gesture => {
    const d = docRef.current!;
    const r0 = crop ?? { x: 0, y: 0, w: d.width, h: d.height };
    const untouched = r0.x === 0 && r0.y === 0 && r0.w === d.width && r0.h === d.height;
    // As in Photoshop, dragging over the untouched box draws a new one.
    const raw = hitCrop(sp, r0);
    const hit = raw === 'inside' && untouched ? null : raw;
    const update = (r: Rect) => {
      const n = {
        x: Math.round(r.w < 0 ? r.x + r.w : r.x),
        y: Math.round(r.h < 0 ? r.y + r.h : r.y),
        w: Math.max(1, Math.round(Math.abs(r.w))),
        h: Math.max(1, Math.round(Math.abs(r.h))),
      };
      setCropRect(n);
      overlayRef.current = { kind: 'crop', rect: n };
      schedule();
    };
    return {
      move(q) {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        if (hit === 'inside') update({ ...r0, x: r0.x + dx, y: r0.y + dy });
        else if (typeof hit === 'number') {
          const [hx, hy] = HANDLES[hit];
          let { x, y, w, h } = r0;
          if (hx < 0) {
            x += dx;
            w -= dx;
          } else if (hx > 0) w += dx;
          if (hy < 0) {
            y += dy;
            h -= dy;
          } else if (hy > 0) h += dy;
          update({ x, y, w, h });
        } else update({ x: p.x, y: p.y, w: dx, h: dy });
      },
      up() {},
    };
  };

  const commitCrop = useCallback(() => {
    const d = docRef.current;
    if (!d || !crop) return;
    if (crop.x === 0 && crop.y === 0 && crop.w === d.width && crop.h === d.height) return;
    let next = ops.crop(d, crop);
    if (options.crop.deletePixels) {
      // Cut every layer down to the new canvas.
      const clip = (layers: Layer[]): Layer[] =>
        layers.map((l) => {
          if (l.kind === 'group') return { ...l, children: clip(l.children) };
          if (!l.canvas || l.kind !== 'pixel') return l;
          const c = makeCanvas(next.width, next.height);
          ctx2d(c).drawImage(l.canvas, l.left, l.top);
          return { ...l, canvas: c, left: 0, top: 0 };
        });
      next = { ...next, layers: clip(next.layers) };
    }
    setCropRect(null);
    commit('Crop', next, { selection: null });
    requestAnimationFrame(() => fit(viewRef.current.zoom));
  }, [crop, options.crop.deletePixels, commit, fit]);

  const hitTransform = (sp: Point, b: Box): { kind: 'scale'; handle: [number, number] } | { kind: 'move' } | { kind: 'rotate' } => {
    for (const h of HANDLES) if (dist(toScreen(handlePoint(b, h)), sp) <= 7) return { kind: 'scale', handle: h };
    const corners = boxCorners(b).map(toScreen);
    // Inside the (possibly turned) box?
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = corners[i];
      const c = corners[j];
      if (a.y > sp.y !== c.y > sp.y && sp.x < ((c.x - a.x) * (sp.y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
    }
    return inside ? { kind: 'move' } : { kind: 'rotate' };
  };

  const startTransformDrag = (f: Float, p: Point, sp: Point): Gesture => {
    const hit = hitTransform(sp, f.box);
    const b0 = f.box;
    const update = (b: Box) => {
      const nf = { ...f, box: b };
      setFloat(nf);
      showFloat(nf);
    };
    return {
      move(q, ev) {
        if (hit.kind === 'move') {
          update({ ...b0, cx: b0.cx + q.x - p.x, cy: b0.cy + q.y - p.y });
        } else if (hit.kind === 'rotate') {
          let a = b0.angle + Math.atan2(q.y - b0.cy, q.x - b0.cx) - Math.atan2(p.y - b0.cy, p.x - b0.cx);
          if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
          update({ ...b0, angle: a });
        } else {
          const [hx, hy] = hit.handle;
          const cos = Math.cos(-b0.angle);
          const sin = Math.sin(-b0.angle);
          const vx = q.x - b0.cx;
          const vy = q.y - b0.cy;
          const lx = vx * cos - vy * sin;
          const ly = vx * sin + vy * cos;
          const fromCenter = ev.altKey;
          const ax = fromCenter ? 0 : (-hx * b0.w) / 2;
          const ay = fromCenter ? 0 : (-hy * b0.h) / 2;
          let w = hx ? Math.max(1, (lx - ax) * hx * (fromCenter ? 2 : 1)) : b0.w;
          let h = hy ? Math.max(1, (ly - ay) * hy * (fromCenter ? 2 : 1)) : b0.h;
          // Corners keep proportions unless Shift is held, as in Photoshop today.
          if (hx && hy && !ev.shiftKey) {
            const k = Math.max(w / b0.w, h / b0.h);
            w = b0.w * k;
            h = b0.h * k;
          }
          const clx = fromCenter ? 0 : hx ? ax + (hx * w) / 2 : 0;
          const cly = fromCenter ? 0 : hy ? ay + (hy * h) / 2 : 0;
          const c2 = Math.cos(b0.angle);
          const s2 = Math.sin(b0.angle);
          update({ ...b0, w, h, cx: b0.cx + clx * c2 - cly * s2, cy: b0.cy + clx * s2 + cly * c2 });
        }
      },
      up() {},
    };
  };

  const startMove = (p: Point, e: React.PointerEvent): Gesture | null => {
    let d = docRef.current!;
    let layer = active;
    if (options.move.autoSelect || e.ctrlKey || e.metaKey) {
      const hit = layerAt(p);
      if (hit) {
        layer = hit;
        setActiveId(hit.id);
        setSelectedIds(new Set([hit.id]));
        setEditMask(false);
      }
    }
    if (!layer) return null;
    if (layer.locked) {
      say(`“${layer.name}” is locked.`);
      return null;
    }
    let label = 'Move';
    if (e.altKey) {
      const r = ops.duplicate(d, layer.id);
      d = r.doc;
      layer = findLayer(d.layers, r.activeId!)!;
      label = 'Duplicate Layer';
    }
    const s = selRef.current;
    if (s && layer.kind === 'pixel') {
      const f = liftFloat(d, layer, s, label);
      if (!f) return null;
      const base = d;
      return {
        move(q, ev) {
          let dx = Math.round(q.x - p.x);
          let dy = Math.round(q.y - p.y);
          if (ev.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          const nf = { ...f, box: { ...f.box, cx: f.orig.cx + dx, cy: f.orig.cy + dy } };
          const l = findLayer(base.layers, f.id)!;
          setLive({ ...base, layers: updateLayer(base.layers, f.id, () => placeFloat(nf, l)) }, null);
          f.box = nf.box;
        },
        up() {
          const l = findLayer(base.layers, f.id)!;
          const dx = Math.round(f.box.cx - f.orig.cx);
          const dy = Math.round(f.box.cy - f.orig.cy);
          const m = makeCanvas(base.width, base.height);
          ctx2d(m).drawImage(s.mask, dx, dy);
          commit(label, { ...base, layers: updateLayer(base.layers, f.id, () => placeFloat(f, l)) }, { selection: selection.fromMask(m), activeId: layer.id });
        },
        cancel: () => setLive(null),
      };
    }
    const base = d;
    const id = layer.id;
    let last: Doc = base;
    return {
      move(q, ev) {
        let dx = Math.round(q.x - p.x);
        let dy = Math.round(q.y - p.y);
        if (ev.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
        last = ops.moveLayer(base, id, dx, dy);
        setLive(last);
      },
      up() {
        if (last === base && label === 'Move') return setLive(null);
        commit(label, last, { activeId: id });
      },
      cancel: () => setLive(null),
    };
  };

  const startGradient = (p: Point): Gesture | null => {
    if (!needsPixels() || !active) return null;
    const d = docRef.current!;
    const o = options.gradient;
    const tgt = target;
    let b = p;
    const make = () => {
      const from = tgt === 'mask' ? ops.grayOf(fg) : fg;
      const to = o.colors === 'fg-transparent' ? null : tgt === 'mask' ? ops.grayOf(bg) : bg;
      const g = drawGradient(d.width, d.height, p, b, o.kind, from, to, o.reverse);
      return ops.editPixels(d, active.id, tgt, selRef.current, (s) => {
        const out = cloneCanvas(s.canvas);
        const c = ctx2d(out);
        c.globalAlpha = o.opacity / 100;
        c.drawImage(g, -s.left, -s.top);
        return out;
      });
    };
    return {
      move(q, ev) {
        b = q;
        if (ev.shiftKey) {
          const a = Math.round(Math.atan2(q.y - p.y, q.x - p.x) / (Math.PI / 4)) * (Math.PI / 4);
          const r = dist(p, q);
          b = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
        }
        overlayRef.current = { kind: 'line', a: p, b };
        setLive(make());
      },
      up() {
        overlayRef.current = null;
        if (dist(p, b) < 1) return setLive(null);
        commit('Gradient', make());
      },
      cancel: () => setLive(null),
    };
  };

  const fillAt = (p: Point) => {
    if (!needsPixels() || !active) return;
    const d = docRef.current!;
    const o = options.bucket;
    const src = sampleImage(o.sampleAll);
    if (!src) return;
    const region = fillRegion(src, p.x, p.y, o.tolerance, o.contiguous);
    const regionCanvas = makeCanvas(d.width, d.height);
    ctx2d(regionCanvas).putImageData(region, 0, 0);
    const color = target === 'mask' ? ops.grayOf(fg) : fg;
    commit(
      'Paint Bucket',
      ops.editPixels(d, active.id, target, selRef.current, (s) => {
        const paint = makeCanvas(s.canvas.width, s.canvas.height);
        const pc = ctx2d(paint);
        pc.drawImage(regionCanvas, -s.left, -s.top);
        pc.globalCompositeOperation = 'source-in';
        pc.fillStyle = color;
        pc.fillRect(0, 0, paint.width, paint.height);
        const out = cloneCanvas(s.canvas);
        const oc = ctx2d(out);
        oc.globalAlpha = o.opacity / 100;
        oc.drawImage(paint, 0, 0);
        return out;
      }),
    );
  };

  const startShape = (p: Point, ellipse: boolean): Gesture => {
    const d = docRef.current!;
    let made: Doc | null = null;
    const id = newId();
    const name = freshName(d.layers, ellipse ? 'Ellipse 1' : 'Rectangle 1');
    return {
      move(q, ev) {
        let w = q.x - p.x;
        let h = q.y - p.y;
        if (ev.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        let x = p.x;
        let y = p.y;
        if (ev.altKey) {
          x -= w;
          y -= h;
          w *= 2;
          h *= 2;
        }
        const r = { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
        if (r.w < 1 || r.h < 1) return;
        const canvas = makeCanvas(Math.ceil(r.w) + 2, Math.ceil(r.h) + 2);
        const c = ctx2d(canvas);
        c.fillStyle = fg;
        const ox = r.x - Math.floor(r.x) + 1;
        const oy = r.y - Math.floor(r.y) + 1;
        if (ellipse) {
          c.beginPath();
          c.ellipse(ox + r.w / 2, oy + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          c.fill();
        } else c.fillRect(Math.round(ox), Math.round(oy), Math.round(r.w), Math.round(r.h));
        made = ops.insertAbove(d, activeId, blankLayer(name, d, { canvas, left: Math.floor(r.x) - 1, top: Math.floor(r.y) - 1, id }));
        setLive(made);
      },
      up() {
        if (made) commit(ellipse ? 'Ellipse Tool' : 'Rectangle Tool', made, { activeId: id });
        else setLive(null);
      },
      cancel: () => setLive(null),
    };
  };

  const startTyping = (p: Point) => {
    const d = docRef.current!;
    if (typing) {
      commitTyping();
      return;
    }
    // Clicking an existing type layer edits it.
    const hit = walkTopDown(d.layers).find(
      ({ layer: l }) =>
        l.kind === 'text' &&
        l.text &&
        l.canvas &&
        !isEffectivelyHidden(d.layers, l.id) &&
        p.x >= l.left &&
        p.y >= l.top &&
        p.x < l.left + l.canvas.width &&
        p.y < l.top + l.canvas.height,
    )?.layer;
    if (hit?.text) {
      setActiveId(hit.id);
      setSelectedIds(new Set([hit.id]));
      setOptions((o) => ({
        ...o,
        type: { font: hit.text!.font, size: hit.text!.size, bold: hit.text!.bold, italic: hit.text!.italic, align: hit.text!.align },
      }));
      setColor('fg', hit.text.color);
      setTyping({ id: hit.id, text: hit.text.text, x: hit.text.x, y: hit.text.y });
      return;
    }
    setTyping({ id: null, text: '', x: Math.round(p.x), y: Math.round(p.y + options.type.size * 0.35) });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = docRef.current;
    if (!d || dialog) return;
    if (e.button === 2) return;
    rootRef.current?.focus({ preventScroll: true });
    const r = viewportRef.current!.getBoundingClientRect();
    const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    const p = toDoc(e);
    let g: Gesture | null = null;
    if (spaceDown || e.button === 1 || tool === 'hand') {
      const v0 = viewRef.current;
      setPanning(true);
      g = {
        move(_q, ev) {
          setView({ ...v0, x: v0.x + ev.clientX - e.clientX, y: v0.y + ev.clientY - e.clientY });
        },
        up: () => setPanning(false),
        cancel: () => setPanning(false),
      };
    } else if (float) {
      g = startTransformDrag(float, p, sp);
    } else if (typing && tool === 'type') {
      commitTyping();
      return;
    } else {
      switch (tool) {
        case 'zoom':
          zoomAt(zoomStep(viewRef.current.zoom, e.altKey ? -1 : 1), sp.x, sp.y);
          return;
        case 'eyedropper':
          pickColor(p, e.altKey);
          g = { move: (q) => pickColor(q, e.altKey), up() {} };
          break;
        case 'move':
          g = startMove(p, e);
          break;
        case 'marquee':
        case 'ellipse-marquee':
          g = startMarquee(p, e, tool === 'ellipse-marquee');
          break;
        case 'lasso':
          g = startLasso(p, e);
          break;
        case 'polygon-lasso': {
          const pts = polyPoints ?? [];
          if (!polyPoints) polyMode.current = selectMode(e);
          if (pts.length >= 3 && dist(toScreen(pts[0]), sp) <= 8) {
            finishPolygon(pts, polyMode.current);
            return;
          }
          const next = [...pts, p];
          setPolyPoints(next);
          overlayRef.current = { kind: 'lasso', points: next, cursor: p };
          schedule();
          return;
        }
        case 'wand': {
          const src = sampleImage(options.wand.sampleAll);
          if (!src) return;
          applySelectShape(selection.wand(src, p.x, p.y, options.wand.tolerance, options.wand.contiguous), selectMode(e), 'Magic Wand');
          return;
        }
        case 'crop':
          g = startCrop(p, sp);
          break;
        case 'brush':
        case 'pencil':
        case 'eraser':
          if (e.altKey && tool !== 'eraser') {
            pickColor(p, false, true);
            return;
          }
          g = startPaint(p, e);
          break;
        case 'clone':
          if (e.altKey) {
            setCloneSource(p);
            cloneOffset.current = null;
            say('Clone source set. Paint to copy from it.');
            return;
          }
          g = startPaint(p, e);
          break;
        case 'bucket':
          fillAt(p);
          return;
        case 'gradient':
          g = startGradient(p);
          break;
        case 'type':
          startTyping(p);
          return;
        case 'rectangle':
        case 'ellipse':
          g = startShape(p, tool === 'ellipse');
          break;
      }
    }
    if (!g) return;
    gestureRef.current = g;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const updateCursor = (p: Point | null) => {
    const o = PAINTS.has(tool) ? options[tool as 'brush'] : null;
    cursorRef.current = p && o && !spaceDown ? { x: p.x, y: p.y, r: o.size / 2 } : null;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!docRef.current) return;
    const p = toDoc(e);
    setPointer({ x: Math.floor(p.x), y: Math.floor(p.y) });
    updateCursor(p);
    const g = gestureRef.current;
    if (g) {
      // Coalesced events keep fast strokes smooth.
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      if (events.length > 1 && PAINTS.has(tool)) for (const ev of events) g.move(toDoc(ev), ev);
      else g.move(p, e.nativeEvent);
    } else if (tool === 'polygon-lasso' && polyPoints) {
      overlayRef.current = { kind: 'lasso', points: polyPoints, cursor: p };
    }
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g) g.up(toDoc(e), e.nativeEvent);
  };

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!docRef.current) return;
      e.preventDefault();
      const r = viewportRef.current!.getBoundingClientRect();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Pinches arrive as Ctrl+wheel with small deltas; zoom smoothly for those.
        const k = Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 50 ? 0.01 : 0.002));
        zoomAt(v.zoom * k, e.clientX - r.left, e.clientY - r.top);
      } else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        setView({ ...v, x: v.x - dx, y: v.y - dy });
      }
    },
    [zoomAt, setView],
  );
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // ---- Commands ------------------------------------------------------------------------------------

  /** The document, when commands may run on it (not under a dialog). */
  const need = (): Doc | null => (dialog ? null : docRef.current);

  // For Levels and Curves: the merged picture's brightness.
  const needHistogram = dialog?.kind === 'adjust' || (active?.kind === 'adjustment' && panels.properties);
  const histogram = useMemo(() => {
    if (!needHistogram || !doc) return null;
    const flat = renderLayers(
      doc.layers.filter((l) => l.id !== activeId),
      doc.width,
      doc.height,
    );
    const step = Math.max(1, Math.floor((doc.width * doc.height) / 250_000));
    const d = flat.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, doc.width, doc.height).data;
    const h = new Array<number>(256).fill(0);
    for (let i = 0; i < d.length; i += 4 * step) if (d[i + 3]) h[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    return h;
  }, [needHistogram, activeId, doc]);

  const copySelection = (merged: boolean) => {
    const d = docRef.current;
    if (!d || (!merged && !active)) return null;
    const piece = ops.copyPixels(d, merged ? (d.layers[0]?.id ?? 0) : active!.id, selRef.current, merged);
    if (!piece) return null;
    clipboard.current = piece;
    setClipSize({ w: piece.canvas.width, h: piece.canvas.height });
    void navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': pngBlob(piece.canvas) })]).catch(() => {});
    return piece;
  };

  const pasteCanvas = (c: HTMLCanvasElement, at: Point | null, name = 'Layer') => {
    const d = docRef.current;
    if (!d) {
      startDoc({ width: c.width, height: c.height, layers: [blankLayer('Background', c, { canvas: c })], source: null }, 'Untitled-1', null);
      return;
    }
    const left = at ? at.x : Math.round((d.width - c.width) / 2);
    const top = at ? at.y : Math.round((d.height - c.height) / 2);
    const layer = blankLayer(freshName(d.layers, name), d, { canvas: c, left, top });
    commit(name === 'Layer' ? 'Paste' : 'Place', ops.insertAbove(d, activeId, layer), { activeId: layer.id });
  };

  const openAdjustment = (type: AdjustmentLayer['type']) => {
    if (!active) return;
    if (active.kind === 'adjustment') return say('Adjust the layer in the Properties panel.');
    if (type === 'invert') {
      pixelEdit('Invert', (d, id) => ops.adjustLayer(d, id, target, selRef.current, { type: 'invert' }));
      return;
    }
    if (target === 'pixels' && active.kind !== 'pixel') {
      if (active.kind === 'group') return say('Choose a pixel layer to adjust, or add an adjustment layer.');
      setDialog({
        kind: 'rasterize',
        run: (r) => {
          commit('Rasterize Layer', r);
          setDialog({ kind: 'adjust', adj: defaultAdjustment(type) });
        },
      });
      return;
    }
    setDialog({ kind: 'adjust', adj: defaultAdjustment(type) });
  };

  const runFilter = (spec: FilterSpec) => {
    pixelEdit(FILTER_NAMES[spec.type], (d, id) => ops.filterLayer(d, id, target, selRef.current, spec));
    setLastFilter(spec);
  };

  const openFilter = (type: FilterSpec['type']) => {
    if (!active) return;
    if (type === 'sharpen' || type === 'emboss') return runFilter({ type });
    const spec: FilterSpec =
      type === 'gaussian'
        ? { type, radius: 2 }
        : type === 'unsharp'
          ? { type, amount: 50, radius: 1, threshold: 0 }
          : type === 'noise'
            ? { type, amount: 12.5, mono: false }
            : type === 'mosaic'
              ? { type, size: 8 }
              : type === 'motion'
                ? { type, angle: 0, distance: 10 }
                : { type: 'desaturate' };
    if (target === 'pixels' && active.kind !== 'pixel') {
      if (active.kind === 'group' || active.kind === 'adjustment') return say('Choose a pixel layer for filters.');
      setDialog({
        kind: 'rasterize',
        run: (r) => {
          commit('Rasterize Layer', r);
          setDialog({ kind: 'filter', spec });
        },
      });
      return;
    }
    setDialog({ kind: 'filter', spec });
  };

  const previewOnActive = useCallback(
    (fn: ((d: Doc, id: number) => Doc) | null) => {
      const d = docRef.current;
      if (!d || activeId === null) return;
      setLive(fn ? fn(d, activeId) : null);
    },
    [activeId, setLive],
  );

  const onAdjustPreview = useCallback(
    (adj: AdjustmentLayer | null) => previewOnActive(adj ? (d, id) => ops.adjustLayer(d, id, target, selRef.current, adj) : null),
    [previewOnActive, target],
  );
  const onFilterPreview = useCallback(
    (spec: FilterSpec | null) => previewOnActive(spec ? (d, id) => ops.filterLayer(d, id, target, selRef.current, spec) : null),
    [previewOnActive, target],
  );
  const onStylePreview = useCallback(
    (fx: LayerEffectsInfo | null) => previewOnActive(fx ? (d, id) => ({ ...d, layers: updateLayer(d.layers, id, (l) => ({ ...l, effects: fx })) }) : null),
    [previewOnActive],
  );

  const setLayerProps = (props: Partial<Layer>, label: string, coalesce?: string) => {
    const d = docRef.current;
    if (!d || !active) return;
    const ids = selectedIds.size > 1 && !coalesce ? [...selectedIds] : [active.id];
    let layers = d.layers;
    for (const id of ids) layers = updateLayer(layers, id, (l) => ({ ...l, ...props }));
    commit(label, { ...d, layers }, { coalesce });
  };

  const cmd: Commands = {
    newDoc: () => setDialog({ kind: 'new' }),
    open: () => void openFile(),
    place: async () => {
      if (!fs) return;
      const t = await pickFile({
        title: 'Place Embedded',
        extensions: OPEN_EXTENSIONS.filter((x) => x !== '.psd'),
        initialPath: path ? parentPath(path) : undefined,
      });
      if (!t) return;
      try {
        const r = await fs.readFile(t, MAX_BYTES);
        const c = await decodeImage(r.data, t);
        pasteCanvas(c, null, basename(t).replace(/\.[^.]*$/, ''));
      } catch (err) {
        say(`Couldn’t place ${basename(t)}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
      }
    },
    close: () => close(windowId),
    save: () => void save(),
    saveAs: () => void saveAs(),
    quickExport: () => void quickExport(),
    exportAs: () => void saveAs(true),
    undo: () => hist && hist.index > 0 && jump(hist.index - 1),
    redo: () => hist && hist.index < hist.entries.length - 1 && jump(hist.index + 1),
    cut: () => {
      const d = need();
      if (!d) return;
      if (!active || active.kind !== 'pixel' || !copySelection(false)) return;
      commit('Cut Pixels', ops.clear(d, active.id, 'pixels', selRef.current, bg));
    },
    copy: () => {
      if (!need()) return;
      if (copySelection(false)) say('Copied');
    },
    copyMerged: () => {
      if (!need()) return;
      if (copySelection(true)) say('Copied merged');
    },
    paste: async (inPlace: boolean) => {
      let c: HTMLCanvasElement | null = null;
      try {
        for (const item of (await navigator.clipboard?.read?.()) ?? []) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          c = await decodeImage(new Uint8Array(await blob.arrayBuffer()), `clip.${type.split('/')[1]}`);
          break;
        }
      } catch {
        // The system clipboard may be off limits; ours still works.
      }
      const own = clipboard.current;
      const at = inPlace && own && (!c || (c.width === own.canvas.width && c.height === own.canvas.height)) ? { x: own.x, y: own.y } : null;
      if (!c && own) c = cloneCanvas(own.canvas);
      if (c) pasteCanvas(c, at);
      else say('There’s no picture on the clipboard.');
    },
    clear: () => {
      if (!need()) return;
      pixelEdit('Clear', (d, id) => ops.clear(d, id, target, selRef.current, bg));
    },
    fill: () => {
      if (!need()) return;
      if (needsPixels()) setDialog({ kind: 'fill' });
    },
    freeTransform: () => {
      const d = need();
      if (!d) return;
      if (!active || active.kind === 'adjustment' || active.kind === 'group') return say('Choose a layer with pixels to transform.');
      if (active.locked) return say(`“${active.name}” is locked.`);
      if (active.kind !== 'pixel') say('Moving keeps it editable; scaling or rotating turns it into pixels.');
      const f = liftFloat(d, active, selRef.current, 'Free Transform');
      if (!f) return say('There’s nothing on this layer to transform.');
      setFloat(f);
      showFloat(f);
    },
    transformLayer: (how) =>
      pixelEdit(
        { cw: 'Rotate 90° Clockwise', ccw: 'Rotate 90° Counter Clockwise', '180': 'Rotate 180°', flipH: 'Flip Horizontal', flipV: 'Flip Vertical' }[how],
        (d, id) => ops.turnOne(d, id, how),
      ),
    adjustment: openAdjustment,
    desaturate: () => pixelEdit('Desaturate', (d, id) => ops.filterLayer(d, id, target, selRef.current, { type: 'desaturate' })),
    imageSize: () => {
      if (!need()) return;
      setDialog({ kind: 'imageSize' });
    },
    canvasSize: () => {
      if (!need()) return;
      setDialog({ kind: 'canvasSize' });
    },
    rotateCanvas: (how) => {
      const d = need();
      if (!d) return;
      commit(
        { cw: 'Rotate Canvas', ccw: 'Rotate Canvas', '180': 'Rotate Canvas', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' }[how],
        ops.rotateCanvas(d, how),
        { selection: null },
      );
      requestAnimationFrame(() => fit(viewRef.current.zoom));
    },
    cropToSelection: () => {
      const d = need();
      if (!d) return;
      const s = selRef.current;
      if (!s) return;
      commit('Crop', ops.crop(d, s.bounds), { selection: null });
      requestAnimationFrame(() => fit(viewRef.current.zoom));
    },
    trim: () => {
      const d = need();
      if (!d) return;
      const b = opaqueBounds(compositeRef.current!);
      if (!b) return say('There’s nothing to trim to.');
      if (b.w === d.width && b.h === d.height) return say('There are no transparent edges to trim.');
      commit('Trim', ops.crop(d, b), { selection: null });
      requestAnimationFrame(() => fit(viewRef.current.zoom));
    },
    newLayer: () => {
      const d = need();
      if (!d) return;
      const r = ops.addLayer(d, activeId);
      setEditMask(false);
      commit('New Layer', r.doc, { activeId: r.activeId });
    },
    newAdjustmentLayer: (type) => {
      const d = need();
      if (!d) return;
      const layer = blankLayer(ADJUSTMENT_NAMES[type] ?? 'Adjustment', d, {
        kind: 'adjustment',
        canvas: null,
        adjustment: defaultAdjustment(type),
        // Made with a selection, it adjusts only what's selected.
        mask: selRef.current ? selectionMask(d, selRef.current) : solidMask(d, 255),
      });
      setSettings((s) => ({ ...s, panels: { ...s.panels, properties: true } }));
      commit(`New ${ADJUSTMENT_NAMES[type] ?? 'Adjustment'} Layer`, ops.insertAbove(d, activeId, layer), { activeId: layer.id, selection: null });
    },
    duplicate: () => {
      const d = need();
      if (!d) return;
      if (activeId === null) return;
      const r = ops.duplicate(d, activeId);
      commit('Duplicate Layer', r.doc, { activeId: r.activeId });
    },
    deleteLayer: () => {
      const d = need();
      if (!d) return;
      if (allLayers(d.layers).length <= selectedIds.size) return say('A document needs at least one layer.');
      const r = ops.deleteLayers(d, selectedIds.size ? selectedIds : new Set(activeId !== null ? [activeId] : []), activeId);
      commit('Delete Layer', r.doc, { activeId: r.activeId ?? null });
    },
    layerVia: (cut) => {
      const d = need();
      if (!d) return;
      if (activeId === null) return;
      if (selRef.current && active?.kind !== 'pixel') return say('Choose a pixel layer.');
      const r = ops.layerVia(d, activeId, selRef.current, cut);
      commit(cut ? 'Layer via Cut' : 'Layer via Copy', r.doc, { activeId: r.activeId, selection: r.selection });
    },
    group: () => {
      const d = need();
      if (!d) return;
      const ids = selectedIds.size ? [...selectedIds] : activeId !== null ? [activeId] : [];
      if (!ids.length) {
        const g = blankLayer(freshName(d.layers, 'Group'), d, { kind: 'group', canvas: null, blendMode: 'pass through', open: true });
        commit('New Group', ops.insertAbove(d, null, g), { activeId: g.id });
        return;
      }
      // Only layers that share a list group together; the active one's list wins.
      const parent = activeId !== null ? (findPlace(d.layers, activeId)?.parent?.id ?? null) : null;
      const same = ids.filter((id) => (findPlace(d.layers, id)?.parent?.id ?? null) === parent);
      const r = ops.group(d, same);
      commit('Group Layers', r.doc, { activeId: r.activeId });
    },
    ungroup: () => {
      const d = need();
      if (!d) return;
      if (activeId === null) return;
      const r = ops.ungroup(d, activeId);
      commit('Ungroup Layers', r.doc, { activeId: r.activeId ?? null });
    },
    addMask: (how) => {
      const d = need();
      if (!d) return;
      if (activeId === null || active?.mask) return;
      commit('Add Layer Mask', ops.addMask(d, activeId, how, selRef.current), { selection: how === 'selection' ? null : undefined });
      setEditMask(true);
    },
    deleteMask: (apply) => {
      const d = need();
      if (!d) return;
      if (activeId === null || !active?.mask) return;
      setEditMask(false);
      commit(apply ? 'Apply Layer Mask' : 'Delete Layer Mask', ops.deleteMask(d, activeId, apply));
    },
    toggleMask: () => {
      const d = need();
      if (!d) return;
      if (activeId === null || !active?.mask) return;
      commit(active.mask.disabled ? 'Enable Layer Mask' : 'Disable Layer Mask', {
        ...d,
        layers: updateLayer(d.layers, activeId, (l) => ({ ...l, mask: l.mask ? { ...l.mask, disabled: !l.mask.disabled } : null })),
      });
    },
    clipping: () => {
      const d = need();
      if (!d) return;
      if (activeId === null || !active) return;
      const place = findPlace(d.layers, activeId);
      if (!place || (place.index === 0 && !active.clipping)) return say('There’s no layer below to clip to.');
      commit(active.clipping ? 'Release Clipping Mask' : 'Create Clipping Mask', {
        ...d,
        layers: updateLayer(d.layers, activeId, (l) => ({ ...l, clipping: !l.clipping })),
      });
    },
    layerStyle: () => {
      if (!need()) return;
      if (!active || active.kind === 'adjustment') return;
      setDialog({ kind: 'style' });
    },
    clearStyle: () => {
      const d = need();
      if (!d) return;
      if (activeId === null || !active?.effects) return;
      commit('Clear Layer Style', { ...d, layers: updateLayer(d.layers, activeId, (l) => ({ ...l, effects: null })) });
    },
    rasterize: () => {
      const d = need();
      if (!d) return;
      if (activeId !== null) commit('Rasterize Layer', ops.rasterize(d, activeId));
    },
    arrange: (how) => {
      const d = need();
      if (!d) return;
      if (activeId !== null) commit('Arrange', ops.arrange(d, activeId, how));
    },
    mergeDown: () => {
      const d = need();
      if (!d) return;
      if (activeId === null) return;
      const r = selectedIds.size > 1 ? ops.mergeLayers(d, [...selectedIds]) : ops.mergeDown(d, activeId);
      if (r.doc === d) return say('There’s no pixel layer below to merge into.');
      commit(selectedIds.size > 1 ? 'Merge Layers' : 'Merge Down', r.doc, { activeId: r.activeId });
    },
    mergeVisible: () => {
      const d = need();
      if (!d) return;
      const r = ops.mergeVisible(d);
      commit('Merge Visible', r.doc, { activeId: r.activeId });
    },
    flatten: () => {
      const d = need();
      if (!d) return;
      const r = ops.flattenImage(d);
      commit('Flatten Image', r.doc, { activeId: r.activeId, selection: null });
    },
    selectAll: () => {
      const d = need();
      if (!d) return;
      commit('Select All', d, { selection: selection.selectAll(d.width, d.height) });
    },
    deselect: () => {
      const d = need();
      if (!d) return;
      if (selRef.current) commit('Deselect', d, { selection: null });
    },
    reselect: () => {
      const d = need();
      if (!d) return;
      if (lastSel) commit('Reselect', d, { selection: lastSel });
    },
    inverse: () => {
      const d = need();
      if (!d) return;
      commit('Inverse', d, { selection: selection.invert(selRef.current, d.width, d.height) });
    },
    loadSelection: () => {
      const d = need();
      if (!d) return;
      if (!active) return;
      commit('Load Selection', d, { selection: selection.fromAlpha(renderLayerAlone({ ...active, opacity: 1, effects: null }, d.width, d.height)) });
    },
    modifySelection: (how) => {
      if (selRef.current) setDialog({ kind: 'radius', how });
    },
    filter: openFilter,
    lastFilter: () => lastFilter && runFilter(lastFilter),
    zoomIn: () => zoomAt(zoomStep(viewRef.current.zoom, 1)),
    zoomOut: () => zoomAt(zoomStep(viewRef.current.zoom, -1)),
    fit: () => fit(),
    actual: () => zoomAt(1),
    togglePanel: (id) => setSettings((s) => ({ ...s, panels: { ...s.panels, [id]: !s.panels[id] } })),
  };

  const menuState: MenuState = {
    hasDoc: !!doc,
    canUndo: !!hist && hist.index > 0,
    canRedo: !!hist && hist.index < hist.entries.length - 1,
    undoLabel: hist && hist.index > 0 ? hist.entries[hist.index].label : '',
    redoLabel: hist && hist.index < hist.entries.length - 1 ? hist.entries[hist.index + 1].label : '',
    hasSelection: !!sel,
    canReselect: !!lastSel,
    activeKind: active?.kind ?? null,
    hasMask: !!active?.mask,
    maskDisabled: !!active?.mask?.disabled,
    clipped: !!active?.clipping,
    multiple: selectedIds.size > 1,
    hasClipboard: !!clipSize,
    lastFilter: lastFilter ? FILTER_NAMES[lastFilter.type] : null,
    panels,
  };

  // ---- Keyboard -------------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog) return;
    if (editable(e.target)) return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (e.key === ' ' && !ctrl) return run(() => setSpaceDown(true));
    if (e.key === 'Alt') setAltDown(true);

    // Things in progress first: transforms, crops, lassos.
    if (float) {
      if (e.key === 'Enter') return run(() => commitFloat(float));
      if (e.key === 'Escape') return run(cancelFloat);
    }
    if (crop) {
      if (e.key === 'Enter') return run(commitCrop);
      if (e.key === 'Escape') return run(() => setCropRect(null));
    }
    if (polyPoints) {
      if (e.key === 'Enter') return run(() => finishPolygon(polyPoints, polyMode.current));
      if (e.key === 'Escape')
        return run(() => {
          setPolyPoints(null);
          overlayRef.current = null;
          schedule();
        });
      if (e.key === 'Backspace' || e.key === 'Delete') return run(() => setPolyPoints((p) => (p && p.length > 1 ? p.slice(0, -1) : null)));
    }
    if (e.key === 'Escape' && gestureRef.current) {
      return run(() => {
        gestureRef.current?.cancel?.();
        gestureRef.current = null;
        overlayRef.current = null;
        schedule();
      });
    }

    if (ctrl) {
      const shift = e.shiftKey;
      const alt = e.altKey;
      const map: Record<string, (() => void) | undefined> = {
        n: shift ? cmd.newLayer : alt ? undefined : cmd.newDoc,
        o: cmd.open,
        s: shift && alt ? undefined : shift ? cmd.saveAs : cmd.save,
        w: shift && alt ? cmd.exportAs : cmd.close,
        z: shift ? cmd.redo : cmd.undo,
        y: cmd.redo,
        x: cmd.cut,
        c: alt ? cmd.canvasSize : shift ? cmd.copyMerged : cmd.copy,
        v: () => cmd.paste(shift),
        t: cmd.freeTransform,
        a: cmd.selectAll,
        d: shift ? cmd.reselect : cmd.deselect,
        i: alt ? cmd.imageSize : shift ? cmd.inverse : () => cmd.adjustment('invert'),
        j: () => cmd.layerVia(shift),
        g: alt ? cmd.clipping : shift ? cmd.ungroup : cmd.group,
        e: shift ? cmd.mergeVisible : cmd.mergeDown,
        l: () => cmd.adjustment('levels'),
        m: () => cmd.adjustment('curves'),
        u: shift ? cmd.desaturate : () => cmd.adjustment('hue/saturation'),
        b: shift && alt ? () => cmd.adjustment('black & white') : undefined,
        f: alt ? cmd.lastFilter : undefined,
        '0': cmd.fit,
        '1': cmd.actual,
        '=': cmd.zoomIn,
        '+': cmd.zoomIn,
        '-': cmd.zoomOut,
        ']': () => cmd.arrange(shift ? 'front' : 'forward'),
        '[': () => cmd.arrange(shift ? 'back' : 'backward'),
        '}': () => cmd.arrange('front'),
        '{': () => cmd.arrange('back'),
        backspace: () => {
          if (!need()) return;
          pixelEdit('Fill', (d, id) => ops.fill(d, id, target, selRef.current, bg));
        },
      };
      const fn = map[key];
      if (fn) return run(fn);
      return;
    }
    if (e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      return run(() => {
        if (!need()) return;
        pixelEdit('Fill', (d, id) => ops.fill(d, id, target, selRef.current, fg));
      });
    }
    if (e.altKey && (e.key === '[' || e.key === ']')) {
      // Alt+[ and Alt+]: the layer below or above.
      return run(() => {
        const d = docRef.current;
        if (!d) return;
        const order = walkTopDown(d.layers).map((x) => x.layer.id);
        const i = activeId !== null ? order.indexOf(activeId) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === ']' ? -1 : 1)))];
        if (next !== undefined) {
          setActiveId(next);
          setSelectedIds(new Set([next]));
          setEditMask(false);
        }
      });
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return run(cmd.clear);
    if (e.key === 'F5' && e.shiftKey) return run(cmd.fill);
    if (e.key === 'F6' && e.shiftKey) return run(() => cmd.modifySelection('feather'));
    if (e.key === 'F6') return run(() => cmd.togglePanel('color'));
    if (e.key === 'F7') return run(() => cmd.togglePanel('layers'));
    if (e.key === 'Tab') return run(() => setHidePanels((h) => !h));
    if (e.key === 'Enter' && tool === 'polygon-lasso' && polyPoints) return run(() => finishPolygon(polyPoints, polyMode.current));
    if (e.key.startsWith('Arrow') && tool === 'move' && active && !active.locked && docRef.current) {
      return run(() => {
        const n = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
        const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
        commit('Nudge', ops.moveLayer(docRef.current!, active.id, dx, dy), { coalesce: `nudge:${active.id}` });
      });
    }
    if (e.altKey) return;
    if (key === 'd') return run(() => setSettings((s) => ({ ...s, fg: '#000000', bg: '#ffffff' })));
    if (key === 'x') return run(() => setSettings((s) => ({ ...s, fg: s.bg, bg: s.fg })));
    if (key === '[' || key === ']' || key === '{' || key === '}') {
      return run(() => {
        if (!PAINTS.has(tool)) return;
        const k = tool as 'brush' | 'pencil' | 'eraser' | 'clone';
        setOptions((o) => {
          const b = o[k];
          if (key === '{' || key === '}') return { ...o, [k]: { ...b, hardness: Math.max(0, Math.min(100, b.hardness + (key === '}' ? 25 : -25))) } };
          const step = b.size < 10 ? 1 : b.size < 100 ? 10 : b.size < 200 ? 25 : 50;
          return { ...o, [k]: { ...b, size: Math.max(1, Math.min(2500, b.size + (key === ']' ? step : -step))) } };
        });
      });
    }
    if (/^[0-9]$/.test(e.key)) {
      // Number keys set opacity: the tool's when painting, the layer's otherwise.
      return run(() => {
        const v = e.key === '0' ? 100 : Number(e.key) * 10;
        if (PAINTS.has(tool)) {
          const k = tool as 'brush';
          setOptions((o) => ({ ...o, [k]: { ...o[k], [e.shiftKey ? 'flow' : 'opacity']: v } }));
        } else if (active) setLayerProps({ opacity: v / 100 }, 'Opacity Change', `opacity:${active.id}`);
      });
    }
    if (/^[a-z]$/.test(key) && toolByKey(key, e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') setSpaceDown(false);
    if (e.key === 'Alt') {
      setAltDown(false);
      // A lone Alt would otherwise focus Chromium's menu.
      e.preventDefault();
    }
  };

  useEffect(() => {
    const blur = () => {
      setSpaceDown(false);
      setAltDown(false);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);

  // ---- Overlays that follow state ---------------------------------------------------------------------

  const cropKey = crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : '';
  useEffect(() => {
    if (crop) overlayRef.current = { kind: 'crop', rect: crop };
    else if (overlayRef.current?.kind === 'crop') overlayRef.current = null;
    schedule();
  }, [cropKey, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Rendering ----------------------------------------------------------------------------------------

  if (!fs) {
    return (
      <p className="grid h-full place-items-center bg-[#323232] p-6 text-sm text-[#cfcfcf]">Photo Editor needs the Electron shell to read and save files.</p>
    );
  }

  const cursor = (() => {
    if (spaceDown || tool === 'hand') return panning ? 'grabbing' : 'grab';
    if (float) return 'default';
    if (PAINTS.has(tool)) {
      if (altDown && tool !== 'eraser') return 'crosshair';
      const o = options[tool as 'brush'];
      return o.size * zoomShown > 6 ? 'none' : 'crosshair';
    }
    if (tool === 'zoom') return altDown ? 'zoom-out' : 'zoom-in';
    if (tool === 'type') return 'text';
    if (tool === 'move') return 'move';
    return 'crosshair';
  })();

  // Where it sits is set by the render loop, which knows where the view is.
  const typingBox = typingData && {
    fontPx: typingData.size * zoomShown,
    rows: typingData.text.split('\n').length,
    shift: typingData.align === 'center' ? '-50%' : typingData.align === 'right' ? '-100%' : '0',
  };

  const panelList = (
    <aside
      className={cn('flex w-[288px] shrink-0 flex-col overflow-y-auto border-l border-[#232323] bg-[#383838]', hidePanels && 'hidden')}
      aria-label="Panels"
    >
      <Panel title="Color" open={panels.color} onToggle={() => cmd.togglePanel('color')}>
        <ColorPanel fg={fg} bg={bg} editing={colorEditing} onEditing={setColorEditing} onChange={setColor} />
      </Panel>
      <Panel title="Swatches" open={panels.swatches} onToggle={() => cmd.togglePanel('swatches')}>
        <SwatchesPanel onPick={(hex, toBg) => setColor(toBg ? 'bg' : 'fg', hex)} />
      </Panel>
      <Panel title="History" open={panels.history} onToggle={() => cmd.togglePanel('history')}>
        {hist ? (
          <HistoryPanel labels={hist.entries.map((e) => e.label)} index={hist.index} onJump={jump} />
        ) : (
          <p className="p-3 text-xs text-[#9a9a9a]">No document.</p>
        )}
      </Panel>
      <Panel title="Properties" open={panels.properties} onToggle={() => cmd.togglePanel('properties')}>
        {doc ? (
          <div className="max-h-[34vh] overflow-y-auto">
            <PropertiesPanel
              doc={doc}
              layer={active}
              histogram={histogram}
              onAdjust={(adj) => {
                if (activeId === null) return;
                commit(
                  `Modify ${ADJUSTMENT_NAMES[adj.type] ?? 'Adjustment'} Layer`,
                  { ...doc, layers: updateLayer(doc.layers, activeId, (l) => ({ ...l, adjustment: adj })) },
                  { coalesce: `adj:${activeId}` },
                );
              }}
              onMove={(x, y) => active && commit('Move', ops.moveLayer(doc, active.id, x - active.left, y - active.top))}
              onMaskProps={() => cmd.toggleMask()}
            />
          </div>
        ) : (
          <p className="p-3 text-xs text-[#9a9a9a]">No document.</p>
        )}
      </Panel>
      <Panel title="Layers" open={panels.layers} onToggle={() => cmd.togglePanel('layers')} grow>
        {doc ? (
          <LayersPanel
            doc={doc}
            activeId={activeId}
            selectedIds={selectedIds}
            editMask={target === 'mask'}
            onSelect={(id, how) => {
              if (typing) commitTyping();
              setEditMask(false);
              if (how.ctrl) {
                setSelectedIds((s) => {
                  const n = new Set(s);
                  if (n.has(id) && n.size > 1) n.delete(id);
                  else n.add(id);
                  return n;
                });
                setActiveId(id);
              } else if (how.shift && activeId !== null) {
                const order = walkTopDown(doc.layers).map((x) => x.layer.id);
                const a = order.indexOf(activeId);
                const b = order.indexOf(id);
                setSelectedIds(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)));
              } else {
                setActiveId(id);
                setSelectedIds(new Set([id]));
              }
            }}
            onSelectMask={(id) => {
              setActiveId(id);
              setSelectedIds(new Set([id]));
              setEditMask(true);
            }}
            onToggleVisible={(id, solo) => {
              if (solo) {
                // Alt+click: this layer alone, or everything back.
                const others = allLayers(doc.layers).filter((l) => l.id !== id && !findLayer(findLayer(doc.layers, id)!.children, l.id));
                const anyShown = others.some((l) => !l.hidden && l.kind !== 'group');
                let layers = doc.layers;
                for (const l of others) if (l.kind !== 'group') layers = updateLayer(layers, l.id, (x) => ({ ...x, hidden: anyShown }));
                layers = updateLayer(layers, id, (x) => ({ ...x, hidden: false }));
                commit('Show/Hide Layers', { ...doc, layers });
                return;
              }
              const l = findLayer(doc.layers, id);
              commit(l?.hidden ? 'Show Layer' : 'Hide Layer', { ...doc, layers: updateLayer(doc.layers, id, (x) => ({ ...x, hidden: !x.hidden })) });
            }}
            onToggleOpen={(id) => {
              // Opening a group isn't an edit worth a history state; change the current one in place.
              setHist((h) => {
                if (!h) return h;
                const e = h.entries[h.index];
                const nd = { ...e.doc, layers: updateLayer(e.doc.layers, id, (l) => ({ ...l, open: !l.open })) };
                const entries = [...h.entries];
                entries[h.index] = { ...e, doc: nd };
                if (savedEntry === e) setSavedEntry(entries[h.index]);
                return { ...h, entries };
              });
            }}
            onRename={(id, name) => commit('Rename Layer', { ...doc, layers: updateLayer(doc.layers, id, (l) => ({ ...l, name })) })}
            onSetProps={setLayerProps}
            onNewLayer={cmd.newLayer}
            onNewGroup={() => {
              const d = need();
              if (!d) return;
              const g = blankLayer(freshName(d.layers, 'Group'), d, { kind: 'group', canvas: null, blendMode: 'pass through', open: true });
              commit('New Group', ops.insertAbove(d, activeId, g), { activeId: g.id });
            }}
            onDelete={cmd.deleteLayer}
            onAddMask={() => cmd.addMask(sel ? 'selection' : 'reveal')}
            onToggleMask={(id) => {
              const l = findLayer(doc.layers, id);
              if (l?.mask)
                commit(l.mask.disabled ? 'Enable Layer Mask' : 'Disable Layer Mask', {
                  ...doc,
                  layers: updateLayer(doc.layers, id, (x) => ({ ...x, mask: x.mask ? { ...x.mask, disabled: !x.mask.disabled } : null })),
                });
            }}
            onAdjustment={cmd.newAdjustmentLayer}
            onLayerStyle={cmd.layerStyle}
            onDrop={(id, parentId, index) => commit('Move Layer', ops.moveTo(doc, id, parentId, index))}
            onLoadSelection={(id) => {
              const l = findLayer(doc.layers, id);
              if (l)
                commit('Load Selection', doc, { selection: selection.fromAlpha(renderLayerAlone({ ...l, opacity: 1, effects: null }, doc.width, doc.height)) });
            }}
            onToggleClipping={() => cmd.clipping()}
          />
        ) : (
          <p className="p-3 text-xs text-[#9a9a9a]">No document.</p>
        )}
      </Panel>
    </aside>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="relative flex h-full w-full flex-col bg-[#282828] text-[#e0e0e0] outline-none select-none"
      style={{ fontFamily: '"Inter Variable", "Noto Sans", sans-serif' }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <PhotoMenus cmd={cmd} st={menuState} />
      <OptionsBar
        tool={tool}
        options={options}
        setOptions={setOptions}
        transform={
          float && float.label === 'Free Transform'
            ? {
                box: float.box,
                base: { w: float.orig.w, h: float.orig.h },
                onBox: (b) => {
                  const nf = { ...float, box: b };
                  setFloat(nf);
                  showFloat(nf);
                },
                onCommit: () => commitFloat(float),
                onCancel: cancelFloat,
              }
            : null
        }
        crop={
          crop ? { onCommit: commitCrop, onCancel: () => setCropRect(null), size: { w: crop.w, h: crop.h } }
            : null
        }
        typing={!!typing}
        onTypeCommit={commitTyping}
        onTypeCancel={() => {
          setTyping(null);
          setLive(null);
        }}
      />
      <div className="flex min-h-0 flex-1">
        <Toolbar
          tool={tool}
          choice={settings.choice}
          onTool={setTool}
          fg={fg}
          bg={bg}
          onSwap={() => setSettings((s) => ({ ...s, fg: s.bg, bg: s.fg }))}
          onDefault={() => setSettings((s) => ({ ...s, fg: '#000000', bg: '#ffffff' }))}
          onEditColor={(w) => {
            setColorEditing(w);
            setSettings((s) => ({ ...s, panels: { ...s.panels, color: true } }));
            setHidePanels(false);
          }}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {doc && (
            <div className="flex h-7 shrink-0 items-end border-b border-[#1c1c1c] bg-[#2b2b2b] px-1">
              <div
                className="flex h-6 max-w-full items-center gap-2 truncate rounded-t-[3px] bg-[#383838] px-3 text-[11px] text-[#e6e6e6]"
                title={path ?? docName}
              >
                {title}
              </div>
            </div>
          )}
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 touch-none overflow-hidden"
            style={{ cursor: doc ? cursor : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              cursorRef.current = null;
              setPointer(null);
              schedule();
            }}
            onDoubleClick={(e) => {
              if (tool === 'polygon-lasso' && polyPoints) finishPolygon(polyPoints.slice(0, -1).concat([toDoc(e)]), polyMode.current);
              else if (tool === 'hand') cmd.fit();
              else if (tool === 'zoom') cmd.actual();
              else if (crop) commitCrop();
              else if (float) commitFloat(float);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <canvas ref={screenRef} className="absolute inset-0 size-full" aria-label={doc ? `Canvas: ${docName}` : undefined} />
            {typingData && typingBox && (
              <textarea
                autoFocus
                ref={textareaRef}
                value={typingData.text}
                aria-label="Type"
                spellCheck={false}
                onChange={(e) => {
                  const text = e.target.value;
                  setTyping((t) => (t ? { ...t, text } : t));
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.location === 3))) {
                    e.preventDefault();
                    commitTyping();
                  }
                }}
                rows={typingBox.rows}
                className="absolute resize-none overflow-hidden border border-dashed border-[#2d8ceb]/70 bg-transparent p-0 whitespace-pre outline-none [field-sizing:content]"
                style={{
                  transform: `translateX(${typingBox.shift})`,
                  minWidth: Math.max(8, typingBox.fontPx * 0.6),
                  font: `${typingData.italic ? 'italic ' : ''}${typingData.bold ? 'bold ' : ''}${typingBox.fontPx}px / ${typingBox.fontPx * 1.2}px "${typingData.font}", sans-serif`,
                  color: typingData.color,
                  textAlign: typingData.align,
                  caretColor: typingData.color,
                }}
              />
            )}
            {!doc && !loading && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <div className="w-full max-w-md space-y-6 text-center">
                  <div className="space-y-2">
                    <h1 className="text-[40px] leading-tight font-semibold tracking-tight text-[#f0f0f0]">Photo Editor</h1>
                    <p className="text-lg text-[#b5b5b5]">Layers, masks and adjustments. Opens and saves Photoshop documents.</p>
                  </div>
                  {error && (
                    <p role="alert" className="rounded-md border border-[#7a2b2b] bg-[#3a2323] px-3 py-2 text-sm text-[#ffb4b4]">
                      {error}
                    </p>
                  )}
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setDialog({ kind: 'new' })}
                      className={cn('flex h-11 items-center gap-2 rounded-full bg-[#2d8ceb] px-5 text-base font-medium text-white hover:bg-[#4a9df0]', FOCUS)}
                    >
                      <FilePlus className="size-5" />
                      New file
                    </button>
                    <button
                      type="button"
                      onClick={() => void openFile()}
                      className={cn(
                        'flex h-11 items-center gap-2 rounded-full border border-[#6a6a6a] px-5 text-base font-medium text-[#e6e6e6] hover:bg-white/5',
                        FOCUS,
                      )}
                    >
                      <FolderOpen className="size-5" />
                      Open…
                    </button>
                  </div>
                  <p className="text-sm text-[#8a8a8a]">Ctrl+N new · Ctrl+O open · Ctrl+V pastes a picture as a new document</p>
                </div>
              </div>
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Opening">
                <div className="h-2/3 w-2/3 animate-pulse rounded-sm bg-[#3a3a3a] motion-reduce:animate-none" />
              </div>
            )}
          </div>
          <div className="flex h-6 shrink-0 items-center gap-3 border-t border-[#1c1c1c] bg-[#323232] px-2 text-[11px] text-[#bdbdbd]">
            {doc && (
              <>
                <input
                  aria-label="Zoom level"
                  key={zoomShown}
                  defaultValue={fmtZoom(zoomShown)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      const v = parseFloat((e.target as HTMLInputElement).value);
                      if (Number.isFinite(v) && v > 0) zoomAt(v / 100);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className={cn(INPUT, 'h-5 w-16 text-[11px]')}
                />
                <span className="tabular-nums">
                  {doc.width} px × {doc.height} px
                </span>
                {pointer && (
                  <span className="hidden tabular-nums sm:inline">
                    X: {pointer.x} Y: {pointer.y}
                  </span>
                )}
                {sel && (
                  <span className="hidden tabular-nums md:inline">
                    Selection: {sel.bounds.w} × {sel.bounds.h}
                  </span>
                )}
              </>
            )}
            <span role="status" className={cn('min-w-0 flex-1 truncate text-right', status?.startsWith('Couldn’t') && 'text-[#ff8a8a]')}>
              {busy && !status ? 'Working…' : status}
            </span>
          </div>
        </div>
        {panelList}
      </div>

      {dialog?.kind === 'new' && (
        <NewDocDialog
          initial={clipSize ?? { w: 1920, h: 1080 }}
          onCancel={() => setDialog(null)}
          onCreate={(w, h, b: BackgroundChoice, name) => {
            setDialog(null);
            const color = b === 'white' ? '#ffffff' : b === 'black' ? '#000000' : b === 'background' ? bg : null;
            if (docRef.current) {
              // A new document gets a window of its own, as in Photoshop's tabs.
              open('photo-editor', { width: w, height: h, background: color ?? 'transparent', name });
              return;
            }
            startDoc(newDoc(w, h, color), name || 'Untitled-1', null);
          }}
        />
      )}
      {dialog?.kind === 'imageSize' && doc && (
        <ImageSizeDialog
          w0={doc.width}
          h0={doc.height}
          onCancel={() => setDialog(null)}
          onOk={(w, h, smooth) => {
            setDialog(null);
            if (w === doc.width && h === doc.height) return;
            commit('Image Size', ops.imageSize(doc, w, h, smooth), { selection: null });
            requestAnimationFrame(() => fit(viewRef.current.zoom));
          }}
        />
      )}
      {dialog?.kind === 'canvasSize' && doc && (
        <CanvasSizeDialog
          w0={doc.width}
          h0={doc.height}
          onCancel={() => setDialog(null)}
          onOk={(w, h, anchor, fillChoice) => {
            setDialog(null);
            const color = fillChoice === 'background' ? bg : fillChoice === 'white' ? '#ffffff' : fillChoice === 'black' ? '#000000' : null;
            commit('Canvas Size', ops.canvasSize(doc, w, h, anchor, color), { selection: null });
            requestAnimationFrame(() => fit(viewRef.current.zoom));
          }}
        />
      )}
      {dialog?.kind === 'adjust' && (
        <AdjustmentDialog
          initial={dialog.adj}
          histogram={histogram}
          onCancel={() => {
            setDialog(null);
            setLive(null);
          }}
          onPreview={onAdjustPreview}
          onOk={(adj) => {
            setDialog(null);
            pixelEdit(ADJUSTMENT_NAMES[adj.type] ?? 'Adjustment', (d, id) => ops.adjustLayer(d, id, target, selRef.current, adj));
          }}
        />
      )}
      {dialog?.kind === 'filter' && (
        <FilterDialog
          initial={dialog.spec}
          onCancel={() => {
            setDialog(null);
            setLive(null);
          }}
          onPreview={onFilterPreview}
          onOk={(spec) => {
            setDialog(null);
            runFilter(spec);
          }}
        />
      )}
      {dialog?.kind === 'fill' && (
        <FillDialog
          fg={fg}
          onCancel={() => setDialog(null)}
          onOk={(contents: FillContents, color, opacity) => {
            setDialog(null);
            const c = { fg, bg, black: '#000000', white: '#ffffff', gray: '#808080', color }[contents];
            pixelEdit('Fill', (d, id) => ops.fill(d, id, target, selRef.current, c, opacity));
          }}
        />
      )}
      {dialog?.kind === 'style' && active && (
        <LayerStyleDialog
          initial={active.effects}
          onCancel={() => {
            setDialog(null);
            setLive(null);
          }}
          onPreview={onStylePreview}
          onOk={(fx) => {
            setDialog(null);
            const d = docRef.current!;
            commit('Layer Style', { ...d, layers: updateLayer(d.layers, active.id, (l) => ({ ...l, effects: fx })) });
          }}
        />
      )}
      {dialog?.kind === 'radius' && doc && sel && (
        <RadiusDialog
          title={{ feather: 'Feather Selection', expand: 'Expand Selection', contract: 'Contract Selection' }[dialog.how]}
          label={{ feather: 'Feather Radius:', expand: 'Expand By:', contract: 'Contract By:' }[dialog.how]}
          onCancel={() => setDialog(null)}
          onOk={(r) => {
            const how = dialog.how;
            setDialog(null);
            const next = how === 'feather' ? selection.feather(sel, r) : how === 'expand' ? selection.expand(sel, r) : selection.contract(sel, r);
            commit({ feather: 'Feather', expand: 'Expand', contract: 'Contract' }[how], doc, { selection: next });
          }}
        />
      )}
      {dialog?.kind === 'rasterize' && doc && active && (
        <ConfirmDialog
          title="Rasterize"
          message={`“${active.name}” is a ${active.kind === 'text' ? 'type layer' : active.kind === 'smart' ? 'smart object' : 'shape layer'}. It has to be rasterized into plain pixels before this; it will no longer be editable as ${active.kind === 'text' ? 'text' : active.kind === 'smart' ? 'a smart object' : 'a shape'}.`}
          okLabel="Rasterize"
          onCancel={() => setDialog(null)}
          onOk={() => {
            const run = dialog.run;
            setDialog(null);
            run(ops.rasterize(doc, active.id));
          }}
        />
      )}
      {dialog?.kind === 'unsaved' && (
        <Dialog
          title="Photo Editor"
          onCancel={() => setDialog(null)}
          onOk={() => {
            setDialog(null);
            void save().then((ok) => ok && closeNow());
          }}
          okLabel={busy ? 'Saving…' : 'Save'}
          extra={
            <Button onClick={closeNow} className="border-[#a05050] text-[#ffb4b4] hover:border-[#c06060]">
              Don’t Save
            </Button>
          }
        >
          <p className="text-sm text-[#e6e6e6]">Save changes to “{docName}” before closing?</p>
          <p className="mt-1 text-xs text-[#a0a0a0]">
            {path && !isPsd(path) && allLayers(doc?.layers ?? []).length > 1
              ? 'It has layers, so it will be saved as a Photoshop document.'
              : 'If you don’t, your changes will be lost.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
