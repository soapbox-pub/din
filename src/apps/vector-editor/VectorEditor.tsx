import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FilePlus, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes } from '@/lib/fs';
import { typesFromFilters } from '@/sdk';
import { useCloseGuard, useDin, useWindowTitle } from '@/sdk/react';
import { Button, Dialog, NumberField, Select } from '@/shared/photo/chrome';
import { Panel } from '@/shared/photo/panels';
import { FOCUS, INPUT } from '@/shared/photo/styles';
import { zoomStep } from '@/shared/photo/view';
import { ControlBar, Toolbar } from './vector/bars';
import { CanvasMenu } from './vector/contextMenu';
import { AverageDialog, DocumentSetupDialog, ExportDialog, NewDocDialog, NumberDialog, ShapeDialog, ShortcutsDialog, TransformDialogView, type ShapeSpec, type TransformSpec } from './vector/dialogs';
import { cmdsToSubPaths, hitItem, itemBounds, nearestOnSegment, toPath2D, transformItem } from './vector/geom';
import { encodeDoc, EXPORT_TYPES, extOf, imageEntry, isImage, isNative, OPEN_EXTENSIONS, placeImage, readDoc, SAVE_TYPES, savesAs } from './vector/io';
import { VectorMenus, type Commands, type MenuState, type PanelId, type TransformDialog } from './vector/menus';
import {
  apply,
  defaultStroke,
  findItem,
  intersects,
  invert,
  isEmpty,
  mapItems,
  mul,
  newDoc,
  newId,
  NONE,
  rotateAbout,
  scaleAbout,
  segments,
  translate,
  updateLayer,
  walk,
  type Artboard,
  type Doc,
  type Gradient,
  type Item,
  type Mat,
  type Node,
  type Paint,
  type PathItem,
  type Point,
  type Rect,
  type Stroke,
  type TextItem,
  type Units,
} from './vector/model';
import * as ops from './vector/ops';
import { fitGradient, gradientBetween, rgbToCmyk } from './vector/paint';
import {
  AlignPanel,
  ArtboardsPanel,
  CharacterPanel,
  LayersPanel,
  PaintEditor,
  PathfinderPanel,
  ParagraphPanel,
  PropertiesPanel,
  StrokePanel,
  SwatchesPanel,
  TransparencyPanel,
  type TypeStyle,
} from './vector/panels';
import { sameColor } from '@/shared/pdf/color';
import { drawDoc, drawItem, viewMat, type View } from './vector/render';
import { drawOverlay, drawRulers, emptyOverlay, handlePoint, HANDLES, type Handle, type Overlay } from './vector/overlay';
import { indexAt, layoutText, textOf } from './vector/text';
import { replaceRange, runAt, styleRange, wordAt } from './vector/textEdit';
import { DEFAULT_SHAPE, groupOf, TOOLS, toolInfo, type ToolId } from './vector/tools';
import { fmtLen } from './vector/units';
import { canWrite, fileTypes, pickFiles, pickSaveFile, windowLaunchFile, writeFile } from '@/shared/fileHandles';

const SETTINGS_KEY = 'din:vector-editor:settings';
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_HISTORY = 100;

interface Entry {
  label: string;
  doc: Doc;
  sel: number[];
  coalesce?: string;
}

interface Hist {
  entries: Entry[];
  index: number;
}

interface Settings {
  tool: ToolId;
  choice: Record<number, ToolId>;
  panels: Record<PanelId, boolean>;
  fill: Paint;
  stroke: Stroke;
  smartGuides: boolean;
  rulers: boolean;
  alignTo: 'selection' | 'artboard';
  type: TypeStyle;
}

const DEFAULT_TYPE: TypeStyle = { family: 'Myriad Pro', style: 'Regular', size: 12, leading: 0, tracking: 0, hscale: 1, rise: 0, align: 'left' };

const DEFAULT_SETTINGS: Settings = {
  tool: 'selection',
  choice: {},
  panels: { properties: true, layers: true, color: false, swatches: true, stroke: false, gradient: false, transparency: false, character: false, paragraph: false, align: false, artboards: false, pathfinder: false },
  ...ops.defaultPaints(),
  smartGuides: true,
  rulers: false,
  alignTo: 'selection',
  type: DEFAULT_TYPE,
};

function readSettings(): Settings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
    const s = saved as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      panels: { ...DEFAULT_SETTINGS.panels, ...s.panels },
      type: { ...DEFAULT_TYPE, ...s.type },
      tool: TOOLS.some((t) => t.id === s.tool) ? s.tool! : DEFAULT_SETTINGS.tool,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const fmtZoom = (z: number) => `${z >= 1 ? Math.round(z * 100) : Math.round(z * 1000) / 10}%`;
const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const BLACK: Paint = { type: 'color', color: { space: 'rgb', c: [0, 0, 0] } };

/** Snap a vector to 45° steps (Shift). */
function constrain(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

interface Gesture {
  move(p: Point, e: PointerEvent): void;
  up(p: Point, e: PointerEvent): void;
  cancel?(): void;
}

/** Clipboard shared by every Vector Editor window. */
const shared: { clipboard: { items: Item[]; doc: Doc; text: string } | null } = { clipboard: null };

type DialogState =
  | { kind: 'new' }
  | { kind: 'unsaved' }
  | { kind: 'transform'; which: TransformDialog }
  | { kind: 'shape'; tool: ToolId; at: Point }
  | { kind: 'offset' }
  | { kind: 'average' }
  | { kind: 'export' }
  | { kind: 'setup' }
  | { kind: 'shortcuts' }
  | { kind: 'saveNote'; message: string }
  | null;

interface TextEditing {
  id: number;
  start: number;
  end: number;
}

/**
 * Vector Editor - vector art, Illustrator style: opens and saves .ai files
 * (and PDF and SVG), with Illustrator's tools, menus, panels and shortcuts.
 *
 * Launched with a file, it opens that; launch params `{ width, height,
 * units, mode, artboards, name }` start a new document (File > New from
 * another window).
 */
export function VectorEditor() {
  const din = useDin();
  const params = din.app.launch.params;
  const initial = windowLaunchFile();

  const [settings, setSettings] = useState(readSettings);
  const { panels } = settings;
  const [tool, setToolState] = useState<ToolId>(settings.tool);
  // File > New from another window opens this one with the new document's size.
  const [boot] = useState(() => {
    if (initial || typeof params?.width !== 'number' || typeof params?.height !== 'number') return null;
    const units = (typeof params.units === 'string' ? params.units : 'pt') as Units;
    const d = newDoc(params.width, params.height, params.mode === 'cmyk' ? 'cmyk' : 'rgb', units, typeof params.artboards === 'number' ? params.artboards : 1);
    const entry: Entry = { label: 'New Document', doc: d, sel: [] };
    return { entry, name: typeof params.name === 'string' && params.name ? params.name : 'Untitled-1' };
  });
  const [hist, setHist] = useState<Hist | null>(() => (boot ? { entries: [boot.entry], index: 0 } : null));
  const [savedEntry, setSavedEntry] = useState<Entry | null>(boot?.entry ?? null);
  const [sel, setSelState] = useState<Set<number>>(new Set());
  const [nodeSel, setNodeSel] = useState<Set<string>>(new Set());
  const [lastSel, setLastSel] = useState<number[]>([]);
  const [file, setFile] = useState<FileSystemFileHandle | null>(null);
  const [docName, setDocName] = useState(boot?.name ?? 'Untitled-1');
  const [loading, setLoading] = useState(initial !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [zoomShown, setZoomShown] = useState(1);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [focusPaint, setFocusPaint] = useState<'fill' | 'stroke'>('fill');
  const [outline, setOutline] = useState(false);
  const [edges, setEdges] = useState(true);
  const [showArtboards, setShowArtboards] = useState(true);
  const [boundingBox, setBoundingBox] = useState(true);
  const [grid, setGrid] = useState(false);
  const [hidePanels, setHidePanels] = useState(false);
  const [activeLayerState, setActiveLayer] = useState<number | null>(null);
  const [activeBoardState, setActiveBoard] = useState(0);
  const [editing, setEditing] = useState<TextEditing | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [altDown, setAltDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [lastTransform, setLastTransform] = useState<{ m: Mat; copy: boolean } | null>(null);
  const [linked, setLinked] = useState(false);
  const [recent, setRecent] = useState<Paint[]>([]);
  const [hasClip, setHasClip] = useState(shared.clipboard !== null);
  const [rotateField, setRotateField] = useState(0);
  const [hover, setHover] = useState<Handle | 'rotate' | null>(null);

  const cur = hist ? hist.entries[hist.index] : null;
  const doc = cur?.doc ?? null;
  const dirty = !!cur && cur !== savedEntry;
  const activeLayer = doc ? (doc.layers.find((l) => l.id === activeLayerState) ?? doc.layers[doc.layers.length - 1]) : null;
  const activeBoard = doc ? Math.min(activeBoardState, doc.artboards.length - 1) : 0;

  // ---- Refs the render loop and gestures read -------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<View>({ zoom: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const docRef = useRef<Doc | null>(null);
  const selRef = useRef<Set<number>>(sel);
  const nodeSelRef = useRef<Set<string>>(nodeSel);
  const liveRef = useRef<{ doc: Doc; skip?: Set<number>; draw?: Item[] } | null>(null);
  const overlayExtra = useRef<Partial<Overlay>>({});
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef(0);
  const artRef = useRef<{ canvas: HTMLCanvasElement; key: unknown[] } | null>(null);
  const fitPending = useRef(!!boot);
  const loadSeq = useRef(0);
  const penRef = useRef<{ id: number; sp: number } | null>(null);
  const caretOn = useRef(true);
  const editingRef = useRef<TextEditing | null>(null);
  const originRef = useRef<Point | null>(null);
  const pointerRef = useRef<Point | null>(null);
  const stateRef = useRef({ outline, edges, showArtboards, boundingBox, grid, rulers: settings.rulers, tool, activeBoard, smartGuides: settings.smartGuides });

  useLayoutEffect(() => {
    docRef.current = doc;
    selRef.current = sel;
    nodeSelRef.current = nodeSel;
    editingRef.current = editing;
    stateRef.current = { outline, edges, showArtboards, boundingBox, grid, rulers: settings.rulers, tool, activeBoard, smartGuides: settings.smartGuides };
  });

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, tool }));
  }, [settings, tool]);

  const say = useCallback((s: string | null) => setStatus(s), []);
  const title = doc ? `${dirty ? '• ' : ''}${docName} @ ${fmtZoom(zoomShown)} (${doc.mode.toUpperCase()}/${outline ? 'Outline' : 'Preview'})` : 'Vector Editor';
  useWindowTitle(title);

  // ---- Drawing --------------------------------------------------------------------------------

  const buildOverlay = useCallback((d: Doc): Overlay => {
    const o = emptyOverlay();
    const st = stateRef.current;
    const s = selRef.current;
    const colorOf = (id: number) => findItem(d, id)?.layer.color ?? '#4f80ff';
    o.artboards = { boards: d.artboards, active: st.activeBoard, tool: st.tool === 'artboard' };
    const ed = editingRef.current;
    if (st.edges) {
      const direct = st.tool === 'direct' || st.tool === 'group-select' || st.tool === 'pen' || st.tool === 'add-anchor' || st.tool === 'delete-anchor' || st.tool === 'anchor' || st.tool === 'scissors';
      for (const id of s) {
        const p = findItem(d, id);
        if (!p || (ed && ed.id === id)) continue;
        if (direct && p.item.type === 'path') {
          const keys = new Set<string>();
          for (const k of nodeSelRef.current) {
            const [iid, sp, n] = ops.parseNodeKey(k);
            if (iid === id) keys.add(`${sp}:${n}`);
          }
          o.anchors.push({ item: p.item, color: p.layer.color, selected: keys });
        } else o.selection.push({ item: p.item, color: p.layer.color });
      }
      const showBox = st.boundingBox && (st.tool === 'selection' || st.tool === 'free-transform' || st.tool === 'scale' || st.tool === 'rotate' || st.tool === 'reflect' || st.tool === 'shear');
      if (s.size && showBox && !ed) {
        o.bbox = ops.selectionBounds(d, s);
        o.bboxColor = colorOf([...s][0]);
      }
    }
    if (ed) {
      const t = findItem(d, ed.id)?.item;
      if (t?.type === 'text') o.caret = { item: t, start: ed.start, end: ed.end, on: caretOn.current };
    }
    o.origin = (st.tool === 'rotate' || st.tool === 'reflect' || st.tool === 'scale' || st.tool === 'shear') && s.size ? originRef.current ?? centerOf(d, s) : null;
    Object.assign(o, overlayExtra.current);
    return o;
  }, []);

  const frame = useCallback(() => {
    rafRef.current = 0;
    const canvas = screenRef.current;
    const live = liveRef.current;
    const d = live?.doc ?? docRef.current;
    const { w, h } = sizeRef.current;
    if (!canvas || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const c = canvas.getContext('2d')!;
    if (!d) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = '#535353';
      c.fillRect(0, 0, W, H);
      return;
    }
    const st = stateRef.current;
    const v = viewRef.current;
    const artDoc = live?.skip ? live.doc : d;
    const key = [live?.skip ? docRef.current : artDoc, v.zoom, v.x, v.y, W, H, st.outline, st.grid, st.showArtboards, live?.skip ?? null];
    let art = artRef.current;
    if (!art || art.key.length !== key.length || art.key.some((k, i) => k !== key[i])) {
      const ac = art?.canvas ?? document.createElement('canvas');
      ac.width = W;
      ac.height = H;
      const base = live?.skip ? docRef.current ?? d : artDoc;
      drawDoc(ac.getContext('2d')!, base, v, dpr, { outline: st.outline, artboards: st.showArtboards, grid: st.grid, skip: live?.skip });
      art = { canvas: ac, key };
      artRef.current = art;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(art.canvas, 0, 0);
    if (live?.draw) {
      const base = viewMat(v, dpr);
      for (const it of live.draw) drawItem(c, it, d.res, base, { outline: st.outline, artboards: false });
    }
    drawOverlay(c, d, v, dpr, buildOverlay(d));
    // The hidden type box follows the caret, so input methods pop up beside it.
    const ed = editingRef.current;
    const ta = textareaRef.current;
    if (ed && ta) {
      const t = findItem(d, ed.id)?.item;
      if (t?.type === 'text') {
        const ln = layoutText(t, d.res).lines[0];
        const q = apply(t.matrix, ln?.x ?? 0, ln?.y ?? 0);
        ta.style.left = `${q.x * v.zoom + v.x}px`;
        ta.style.top = `${q.y * v.zoom + v.y - 12}px`;
      }
    }
    if (st.rulers) {
      const ab = d.artboards[st.activeBoard] ?? d.artboards[0];
      drawRulers(c, v, dpr, w, h, { x: ab?.x ?? 0, y: ab?.y ?? 0 }, d.units, pointerRef.current);
    }
  }, [buildOverlay]);

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(frame);
  }, [frame]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  useLayoutEffect(() => schedule(), [doc, sel, nodeSel, editing, outline, edges, showArtboards, boundingBox, grid, settings.rulers, tool, activeBoard, schedule]);

  const setLive = useCallback(
    (l: { doc: Doc; skip?: Set<number>; draw?: Item[] } | null) => {
      liveRef.current = l;
      schedule();
    },
    [schedule],
  );

  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      setZoomShown(v.zoom);
      schedule();
    },
    [schedule],
  );

  const fitRect = useCallback(
    (r: Rect, maxZoom = Infinity) => {
      const { w, h } = sizeRef.current;
      if (!w || !h) {
        fitPending.current = true;
        return;
      }
      const pad = 40;
      const z = Math.max(1 / 64, Math.min(maxZoom, 64, (w - pad * 2) / Math.max(1, r.w), (h - pad * 2) / Math.max(1, r.h)));
      setView({ zoom: z, x: Math.round(w / 2 - (r.x + r.w / 2) * z), y: Math.round(h / 2 - (r.y + r.h / 2) * z) });
    },
    [setView],
  );

  const fitBoard = useCallback(
    (d?: Doc, i?: number) => {
      const dd = d ?? docRef.current;
      if (!dd) return;
      const ab = dd.artboards[i ?? stateRef.current.activeBoard] ?? dd.artboards[0];
      if (ab) fitRect(ab);
    },
    [fitRect],
  );

  const zoomAt = useCallback(
    (z: number, sx?: number, sy?: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const mx = sx ?? w / 2;
      const my = sy ?? h / 2;
      const nz = Math.max(1 / 64, Math.min(64, z));
      setView({ zoom: nz, x: mx - (mx - v.x) * (nz / v.zoom), y: my - (my - v.y) * (nz / v.zoom) });
    },
    [setView],
  );

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = { width: el.offsetWidth, height: el.offsetHeight };
      const was = sizeRef.current;
      sizeRef.current = { w: r.width, h: r.height };
      if (fitPending.current && docRef.current && r.width && r.height) {
        fitPending.current = false;
        fitBoard();
      } else if (was.w && was.h) {
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + (r.width - was.w) / 2, y: v.y + (r.height - was.h) / 2 };
      }
      schedule();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitBoard, schedule]);

  // Caret blink.
  useEffect(() => {
    if (!editing) return;
    caretOn.current = true;
    const t = setInterval(() => {
      caretOn.current = !caretOn.current;
      schedule();
    }, 530);
    return () => clearInterval(t);
  }, [editing, schedule]);

  // ---- History --------------------------------------------------------------------------------

  const setSel = useCallback((s: Set<number> | number[], nodes?: Set<string>) => {
    const next = s instanceof Set ? s : new Set(s);
    setSelState(next);
    selRef.current = next;
    const n = nodes ?? new Set<string>();
    setNodeSel(n);
    nodeSelRef.current = n;
    if (next.size) originRef.current = null;
  }, []);

  const commit = useCallback(
    (label: string, d: Doc, opts: { sel?: Set<number> | number[]; nodes?: Set<string>; coalesce?: string } = {}) => {
      liveRef.current = null;
      overlayExtra.current = {};
      const s = opts.sel !== undefined ? new Set(opts.sel) : selRef.current;
      setHist((h) => {
        if (!h) return h;
        const top = h.entries[h.index];
        const entry: Entry = { label, doc: d, sel: [...s], coalesce: opts.coalesce };
        const entries = h.entries.slice(0, h.index + 1);
        if (opts.coalesce && top.coalesce === opts.coalesce && h.index === h.entries.length - 1 && h.index > 0) entries[entries.length - 1] = entry;
        else entries.push(entry);
        while (entries.length > MAX_HISTORY) entries.shift();
        return { entries, index: entries.length - 1 };
      });
      docRef.current = d;
      if (opts.sel !== undefined || opts.nodes !== undefined) setSel(s, opts.nodes ?? (opts.sel !== undefined ? new Set() : nodeSelRef.current));
      setStatus(null);
      schedule();
    },
    [schedule, setSel],
  );

  const jump = useCallback(
    (index: number) => {
      if (!hist || index < 0 || index >= hist.entries.length) return;
      const e = hist.entries[index];
      setHist({ ...hist, index });
      docRef.current = e.doc;
      setSel(e.sel.filter((id) => findItem(e.doc, id)));
      setEditing(null);
      penRef.current = null;
      setLive(null);
    },
    [hist, setLive, setSel],
  );

  const startDoc = useCallback(
    (d: Doc, name: string, f: FileSystemFileHandle | null) => {
      const entry: Entry = { label: f ? 'Open' : 'New Document', doc: d, sel: [] };
      setHist({ entries: [entry], index: 0 });
      setSavedEntry(entry);
      docRef.current = d;
      setSel(new Set());
      setFile(f);
      setDocName(name);
      setError(null);
      setEditing(null);
      setActiveLayer(null);
      setActiveBoard(0);
      liveRef.current = null;
      artRef.current = null;
      penRef.current = null;
      if (d.notes.length) setStatus(d.notes.join(' '));
      fitPending.current = true;
      requestAnimationFrame(() => {
        if (sizeRef.current.w) {
          fitPending.current = false;
          fitBoard(d, 0);
        }
      });
    },
    [fitBoard, setSel],
  );

  // ---- Files ------------------------------------------------------------------------------------

  const load = useCallback(
    (f: FileSystemFileHandle) => {
      const seq = ++loadSeq.current;
      (async () => {
        try {
          const blob = await f.getFile();
          if (blob.size > MAX_BYTES) throw new Error(`It’s too big to open (${formatBytes(blob.size)}; up to 1 GB).`);
          const d = await readDoc(new Uint8Array(await blob.arrayBuffer()), f.name);
          if (seq !== loadSeq.current) return;
          startDoc(d, f.name, f);
        } catch (err) {
          if (seq !== loadSeq.current) return;
          setError(`Couldn’t open ${f.name}. ${err instanceof Error ? err.message : cleanFsError(err)}`);
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      })();
    },
    [startDoc],
  );

  useEffect(() => {
    if (initial) load(initial);
  }, [initial, load]);

  useEffect(() => {
    if (dialog || editing) return;
    const a = document.activeElement;
    if (!a || a === document.body || !rootRef.current?.contains(a)) rootRef.current?.focus({ preventScroll: true });
  }, [dialog, editing]);

  const writeTo = useCallback(
    async (f: FileSystemFileHandle, copy = false): Promise<boolean> => {
      const d = docRef.current;
      if (!d || !hist) return false;
      setBusy(true);
      setStatus('Saving…');
      try {
        await new Promise((r) => setTimeout(r, 30));
        const { bytes, notes } = await encodeDoc(d, f.name, { title: f.name.replace(/\.[^.]*$/, '') });
        await writeFile(f, bytes);
        if (!copy && savesAs(f.name)) {
          setSavedEntry(hist.entries[hist.index]);
          setFile(f);
          setDocName(f.name);
        }
        setStatus(notes.length ? `Saved ${f.name}. ${notes.join(' ')}` : `Saved ${f.name}`);
        return true;
      } catch (err) {
        setStatus(`Couldn’t save ${f.name}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [hist],
  );

  const saveAs = useCallback(
    async (copy = false): Promise<boolean> => {
      const stem = docName.replace(/\.[^.]*$/, '');
      const t = await pickSaveFile({
        title: copy ? 'Save a Copy' : 'Save As',
        suggestedName: `${stem}${copy ? ' copy' : ''}.ai`,
        startIn: file ?? undefined,
        types: typesFromFilters(SAVE_TYPES),
      });
      if (!t) return false;
      if (!savesAs(t.name)) {
        setStatus(`Couldn’t save ${t.name}: choose Illustrator, PDF or SVG.`);
        return false;
      }
      return writeTo(t, copy);
    },
    [docName, file, writeTo],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (file && (await canWrite(file)) && isNative(file.name)) return writeTo(file);
    return saveAs();
  }, [file, writeTo, saveAs]);

  const exportAs = useCallback(
    async (o: { format: 'png' | 'jpg' | 'svg' | 'pdf'; artboard: number | null; scale: number }) => {
      const d = docRef.current;
      if (!d) return;
      const stem = docName.replace(/\.[^.]*$/, '');
      const filters = EXPORT_TYPES.filter((t) => t.patterns[0] === `*.${o.format}`);
      const t = await pickSaveFile({ title: 'Export As', suggestedName: `${stem}.${o.format}`, startIn: file ?? undefined, types: typesFromFilters(filters) });
      if (!t) return;
      if (extOf(t.name) !== o.format && !(o.format === 'jpg' && extOf(t.name) === 'jpeg')) {
        setStatus(`Couldn’t export ${t.name}: its name should end in .${o.format}.`);
        return;
      }
      setBusy(true);
      try {
        const { bytes } = await encodeDoc(d, t.name, { title: stem, artboard: o.artboard, scale: o.scale });
        await writeFile(t, bytes);
        setStatus(`Exported ${t.name}`);
      } catch (err) {
        setStatus(`Couldn’t export: ${err instanceof Error ? err.message : cleanFsError(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [docName, file],
  );

  const pick = useCallback(
    async (title: string, extensions: string[]) =>
      (await pickFiles({ title, types: fileTypes([{ description: 'Artwork', extensions }]), startIn: file ?? undefined }))[0] ?? null,
    [file],
  );

  const openFile = useCallback(async () => {
    const t = await pick('Open', OPEN_EXTENSIONS);
    if (!t) return;
    if (docRef.current && (dirty || file)) {
      void din.app.open('vector-editor', {}, [t]);
      return;
    }
    setLoading(true);
    setError(null);
    load(t);
  }, [din, pick, file, dirty, load]);

  useCloseGuard(
    dirty
      ? () => {
          din.window.focus();
          setDialog({ kind: 'unsaved' });
          return true;
        }
      : null,
  );

  const closeNow = useCallback(() => {
    setDialog(null);
    din.window.close();
  }, [din]);

  // ---- Selection info -----------------------------------------------------------------------

  const selItems = useMemo(() => (doc ? ops.selectedItems(doc, sel) : []), [doc, sel]);
  // The colors the art uses, as the file's own swatches (spot colors by name).
  const docColors = useMemo(() => (doc ? ops.documentColors(doc) : []), [doc]);
  const selLeaves = useMemo(() => ops.leaves(selItems), [selItems]);
  const firstLeaf = selLeaves[0] ?? null;
  const selBounds = useMemo(() => (doc && sel.size ? ops.selectionBounds(doc, sel) : null), [doc, sel]);
  // X and Y as Illustrator shows them: from the active artboard's top-left corner.
  const boardOrigin = doc?.artboards[Math.min(activeBoardState, (doc?.artboards.length ?? 1) - 1)] ?? { x: 0, y: 0 };
  const shownBounds = selBounds ? { ...selBounds, x: selBounds.x - boardOrigin.x, y: selBounds.y - boardOrigin.y } : null;
  const setShownBounds = (b: Partial<Rect>) => setBounds({ ...b, ...(b.x !== undefined ? { x: b.x + boardOrigin.x } : {}), ...(b.y !== undefined ? { y: b.y + boardOrigin.y } : {}) });
  const editingItem = doc && editing ? (findItem(doc, editing.id)?.item as TextItem | undefined) : undefined;
  const textTarget = editingItem ?? (firstLeaf?.type === 'text' ? firstLeaf : null);
  const shownFill: Paint = firstLeaf?.type === 'path' ? firstLeaf.fill : firstLeaf?.type === 'text' ? (editingItem ? runAt(editingItem, Math.min(editing!.start, editing!.end)) : firstLeaf.runs[0]).fill : settings.fill;
  const shownStroke: Stroke = firstLeaf?.type === 'path' ? firstLeaf.stroke : firstLeaf?.type === 'text' ? firstLeaf.runs[0].stroke : settings.stroke;
  const shownOpacity = selItems[0]?.opacity ?? 1;
  const kindLabel = !selItems.length
    ? null
    : selItems.length > 1
      ? 'Mixed Objects'
      : selItems[0].type === 'path'
        ? selItems[0].paths.length > 1
          ? 'Compound Path'
          : 'Path'
        : selItems[0].type === 'group'
          ? selItems[0].clip
            ? 'Clip Group'
            : 'Group'
          : selItems[0].type === 'text'
            ? 'Type'
            : 'Image';
  const typeStyle: TypeStyle = textTarget
    ? (() => {
        const r = editingItem && editing ? runAt(editingItem, Math.min(editing.start, editing.end)) : textTarget.runs[0];
        return { family: r.font.family, style: r.font.style, size: Math.round(r.size * 100) / 100, leading: textTarget.leading, tracking: Math.round(r.tracking), hscale: r.hscale, rise: r.rise, align: textTarget.align };
      })()
    : settings.type;

  // ---- Edit helpers -------------------------------------------------------------------------------

  const need = (): Doc | null => docRef.current;

  const editSel = (label: string, fn: (d: Doc, ids: Set<number>) => Doc, coalesce?: string) => {
    const d = need();
    if (!d || !selRef.current.size) return;
    const next = fn(d, selRef.current);
    if (next !== d) commit(label, next, { coalesce });
  };

  const pushRecent = (p: Paint) => {
    if (p.type !== 'color') return;
    setRecent((r) => [p, ...r.filter((x) => !(x.type === 'color' && sameColor(x.color, p.color)))].slice(0, 10));
  };

  /** Set the fill or stroke paint: of the selection if there is one, else of what's drawn next. */
  const applyPaint = (which: 'fill' | 'stroke', p: Paint, coalesce?: string) => {
    const d = need();
    if (editing && editingItem && d) {
      const { start, end } = editing;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      const next = styleRange(editingItem, lo === hi ? -1 : lo, lo === hi ? -1 : hi, (r) => (which === 'fill' ? { ...r, fill: p } : { ...r, stroke: { ...r.stroke, paint: p, width: r.stroke.width || 1 } }));
      commit(which === 'fill' ? 'Fill Color' : 'Stroke Color', mapItems(d, (it) => (it.id === next.id ? next : undefined)), { coalesce });
      return;
    }
    if (d && selRef.current.size) {
      if (which === 'fill') commit('Fill Color', ops.setFill(d, selRef.current, p), { coalesce });
      else commit('Stroke Color', ops.setStroke(d, selRef.current, { paint: p }), { coalesce });
    }
    setSettings((s) => (which === 'fill' ? { ...s, fill: p } : { ...s, stroke: { ...s.stroke, paint: p, width: s.stroke.width || 1 } }));
  };

  const applyStroke = (patch: Partial<Stroke>, coalesce?: string) => {
    const d = need();
    if (d && selRef.current.size) commit('Stroke', ops.setStroke(d, selRef.current, patch), { coalesce });
    setSettings((s) => ({ ...s, stroke: { ...s.stroke, ...patch } }));
  };

  const applyType = (patch: Partial<TypeStyle>) => {
    const d = need();
    setSettings((s) => ({ ...s, type: { ...s.type, ...patch } }));
    if (!d) return;
    const runPatch = (r: TextItem['runs'][number]) => ({
      ...r,
      font: patch.family !== undefined || patch.style !== undefined ? { family: patch.family ?? r.font.family, style: patch.style ?? r.font.style, postscript: `${(patch.family ?? r.font.family).replace(/\s+/g, '')}-${(patch.style ?? r.font.style).replace(/\s+/g, '')}` } : r.font,
      size: patch.size ?? r.size,
      tracking: patch.tracking ?? r.tracking,
      hscale: patch.hscale ?? r.hscale,
      rise: patch.rise ?? r.rise,
    });
    const itemPatch = (t: TextItem): TextItem => ({ ...t, leading: patch.leading ?? t.leading, align: patch.align ?? t.align });
    if (editing && editingItem) {
      const lo = Math.min(editing.start, editing.end);
      const hi = Math.max(editing.start, editing.end);
      const touchesRuns = ['family', 'style', 'size', 'tracking', 'hscale', 'rise'].some((k) => k in patch);
      let t = itemPatch(editingItem);
      if (touchesRuns) t = styleRange(t, lo === hi ? -1 : lo, lo === hi ? -1 : hi, runPatch);
      else t = { ...t, placed: patch.align !== undefined && patch.align !== editingItem.align ? undefined : t.placed };
      commit('Character', mapItems(d, (it) => (it.id === t.id ? t : undefined)), { coalesce: `type:${t.id}` });
      return;
    }
    if (!selRef.current.size) return;
    commit(
      'Character',
      ops.restyle(d, selRef.current, (it) => (it.type === 'text' ? { ...itemPatch(it), runs: it.runs.map(runPatch), placed: undefined } : it)),
    );
  };

  const setBounds = (b: Partial<Rect>) => {
    const d = need();
    if (!d || !selBounds) return;
    const r = selBounds;
    let nw = b.w ?? r.w;
    let nh = b.h ?? r.h;
    if (linked && b.w !== undefined && r.w) nh = (r.h * b.w) / r.w;
    if (linked && b.h !== undefined && r.h) nw = (r.w * b.h) / r.h;
    const sx = r.w ? nw / r.w : 1;
    const sy = r.h ? nh / r.h : 1;
    const nx = b.x ?? r.x;
    const ny = b.y ?? r.y;
    const m = mul(scaleAbout(sx || 1, sy || 1, r.x, r.y), translate(nx - r.x, ny - r.y));
    commit('Transform', ops.transformItems(d, selRef.current, m, { strokes: false }));
  };


  const transformSel = (label: string, m: Mat, copy = false, strokes = false) => {
    const d = need();
    if (!d || !selRef.current.size) return;
    if (copy) {
      const r = ops.duplicateItems(d, selRef.current, m);
      commit(label, r.doc, { sel: r.ids });
    } else commit(label, ops.transformItems(d, selRef.current, m, { strokes }));
    setLastTransform({ m, copy });
  };

  const specMatrix = (s: TransformSpec): Mat | null => {
    const d = need();
    if (!d) return null;
    const o = originRef.current ?? centerOf(d, selRef.current);
    if (!o) return null;
    if (s.kind === 'move') return translate(s.dx, s.dy);
    if (s.kind === 'rotate') return rotateAbout((-s.angle * Math.PI) / 180, o.x, o.y);
    if (s.kind === 'scale') return scaleAbout(s.sx / 100, (s.uniform ? s.sx : s.sy) / 100, o.x, o.y);
    if (s.kind === 'shear') {
      const t = Math.tan((s.angle * Math.PI) / 180);
      const sh: Mat = s.axis === 'vertical' ? [1, -t, 0, 1, 0, 0] : [1, 0, -t, 1, 0, 0];
      return mul(mul(translate(-o.x, -o.y), sh), translate(o.x, o.y));
    }
    // Reflect across an axis through the origin.
    const a = s.axis === 'horizontal' ? 0 : s.axis === 'vertical' ? Math.PI / 2 : (-s.angle * Math.PI) / 180;
    const c2 = Math.cos(2 * a);
    const s2 = Math.sin(2 * a);
    return mul(mul(translate(-o.x, -o.y), [c2, s2, s2, -c2, 0, 0]), translate(o.x, o.y));
  };

  /** The layer new art goes on: the active one, or the topmost that's shown and unlocked. */
  const targetLayer = (d: Doc): { doc: Doc; id: number } => {
    const layer = d.layers.find((l) => l.id === activeLayer?.id) ?? d.layers[d.layers.length - 1];
    if (!layer.locked && !layer.hidden) return { doc: d, id: layer.id };
    const open = [...d.layers].reverse().find((l) => !l.locked && !l.hidden);
    if (open) return { doc: d, id: open.id };
    return { doc: updateLayer(d, layer.id, (l) => ({ ...l, locked: false, hidden: false })), id: layer.id };
  };

  const addToLayer = (items: Item[], label: string, d0?: Doc) => {
    const d = d0 ?? need();
    if (!d || !items.length) return;
    const t = targetLayer(d);
    commit(label, ops.addItems(t.doc, t.id, items), { sel: items.map((i) => i.id) });
  };

  const newPath = (paths: PathItem['paths'], kind: 'shape' | 'line' | 'freehand' = 'shape'): PathItem => {
    const s = settings;
    const stroke = kind !== 'shape' && s.stroke.paint.type === 'none' ? { ...s.stroke, paint: BLACK, width: s.stroke.width || 1 } : s.stroke;
    return ops.pathItem(paths, kind === 'shape' ? s.fill : NONE, stroke);
  };

  const finishPen = useCallback(() => {
    const pr = penRef.current;
    penRef.current = null;
    overlayExtra.current = {};
    const d = docRef.current;
    if (!pr || !d) return;
    const it = findItem(d, pr.id)?.item;
    if (it?.type === 'path' && it.paths.every((s) => s.nodes.length < 2)) commit('Delete', ops.deleteItems(d, new Set([pr.id])), { sel: [] });
    schedule();
  }, [commit, schedule]);

  const finishEditing = useCallback(() => {
    const ed = editingRef.current;
    setEditing(null);
    editingRef.current = null;
    const d = docRef.current;
    if (!ed || !d) return;
    const t = findItem(d, ed.id)?.item;
    if (t?.type === 'text' && !textOf(t).trim()) commit('Delete', ops.deleteItems(d, new Set([ed.id])), { sel: [] });
    else setSel(new Set([ed.id]));
    rootRef.current?.focus({ preventScroll: true });
  }, [commit, setSel]);

  const setTool = useCallback(
    (t: ToolId) => {
      if (t !== 'pen' && penRef.current) finishPen();
      if (editingRef.current && t !== 'type') finishEditing();
      setToolState(t);
      originRef.current = null;
      const gi = groupOf(t);
      setSettings((s) => ({ ...s, tool: t, choice: { ...s.choice, [gi]: t } }));
      overlayExtra.current = {};
      schedule();
    },
    [finishPen, finishEditing, schedule],
  );

  /** Tool by its letter; Shift for the Shift+ ones. */
  const toolByKey = (key: string, shift: boolean): boolean => {
    const map: Record<string, ToolId> = {
      v: 'selection',
      a: 'direct',
      p: 'pen',
      '+': 'add-anchor',
      '=': 'add-anchor',
      '-': 'delete-anchor',
      t: 'type',
      '\\': 'line',
      m: 'rectangle',
      l: 'ellipse',
      b: 'paintbrush',
      n: 'pencil',
      c: 'scissors',
      r: 'rotate',
      o: 'reflect',
      s: 'scale',
      e: 'free-transform',
      g: 'gradient',
      i: 'eyedropper',
      h: 'hand',
      z: 'zoom',
    };
    if (shift && key === 'c') {
      setTool('anchor');
      return true;
    }
    if (shift && key === 'o') {
      setTool('artboard');
      return true;
    }
    if (shift) return false;
    const t = map[key];
    if (!t) return false;
    setTool(t);
    return true;
  };

  // ---- Commands -----------------------------------------------------------------------------------

  const copySel = (): boolean => {
    const d = need();
    if (!d) return false;
    const items = ops.selectedItems(d, selRef.current);
    if (!items.length) return false;
    const text = ops.leaves(items).filter((i): i is TextItem => i.type === 'text').map(textOf).join('\n');
    shared.clipboard = { items, doc: d, text };
    setHasClip(true);
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    else void navigator.clipboard?.writeText('').catch(() => undefined);
    return true;
  };

  const pasteItems = async (how: 'normal' | 'front' | 'back' | 'place') => {
    const d = need();
    if (!d) return;
    // Something newer on the system clipboard: a picture, SVG markup, or text.
    try {
      const items = await navigator.clipboard.read();
      for (const ci of items) {
        const imgType = ci.types.find((t) => t.startsWith('image/') && t !== 'image/svg+xml');
        if (imgType) {
          const blob = await ci.getType(imgType);
          const entry = await imageEntry(new Uint8Array(await blob.arrayBuffer()), `paste.${imgType.split('/')[1]}`);
          placeAtCenter(entry, 'Paste');
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (text && (!shared.clipboard || text !== shared.clipboard.text)) {
        if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(text)) {
          const { readSvg } = await import('./vector/svg');
          const sd = await readSvg(text);
          for (const [k, v] of sd.res.images) d.res.images.set(k, v);
          const pasted = sd.layers.flatMap((l) => l.children);
          addToLayer(centerItems(d, pasted), 'Paste');
          return;
        }
        const v = viewRef.current;
        const { w, h } = sizeRef.current;
        const at = { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom };
        addToLayer([newText(at, text.replace(/\r\n?/g, '\n'))], 'Paste');
        return;
      }
    } catch {
      // No access to the system clipboard; use our own.
    }
    const clipboard = shared.clipboard;
    if (!clipboard) return;
    for (const [k, v] of clipboard.doc.res.images) if (!d.res.images.has(k)) d.res.images.set(k, v);
    for (const [k, v] of clipboard.doc.res.fonts) if (!d.res.fonts.has(k)) d.res.fonts.set(k, v);
    const copies = clipboard.items.map(cloneDeep);
    if (how === 'normal') {
      addToLayer(centerItems(d, copies), 'Paste');
      return;
    }
    if (how === 'place') {
      addToLayer(copies, 'Paste');
      return;
    }
    // In front of or behind the selection, in place.
    const target = ops.selectedItems(d, selRef.current);
    if (!target.length) {
      addToLayer(copies, 'Paste');
      return;
    }
    const anchor = how === 'front' ? target[target.length - 1] : target[0];
    const next = mapItems(d, (it) => (it.id === anchor.id ? (how === 'front' ? [it, ...copies] : [...copies, it]) : undefined));
    commit(how === 'front' ? 'Paste in Front' : 'Paste in Back', next, { sel: copies.map((c) => c.id) });
  };

  const cloneDeep = (it: Item): Item => (it.type === 'group' ? { ...it, id: newId(), children: it.children.map(cloneDeep) } : { ...it, id: newId() });

  const centerItems = (d: Doc, items: Item[]): Item[] => {
    const b = items.reduce<Rect | null>((acc, it) => {
      const r = itemBounds(it, d.res);
      if (isEmpty(r)) return acc;
      if (!acc) return r;
      const x = Math.min(acc.x, r.x);
      const y = Math.min(acc.y, r.y);
      return { x, y, w: Math.max(acc.x + acc.w, r.x + r.w) - x, h: Math.max(acc.y + acc.h, r.y + r.h) - y };
    }, null);
    if (!b) return items;
    const v = viewRef.current;
    const { w, h } = sizeRef.current;
    const cx = (w / 2 - v.x) / v.zoom;
    const cy = (h / 2 - v.y) / v.zoom;
    const m = translate(cx - (b.x + b.w / 2), cy - (b.y + b.h / 2));
    return items.map((it) => transformItem(it, m));
  };

  const placeAtCenter = (entry: Awaited<ReturnType<typeof imageEntry>>, label: string) => {
    const d = need();
    if (!d) return;
    const v = viewRef.current;
    const { w, h } = sizeRef.current;
    const k = Math.min(1, (w * 0.8) / v.zoom / entry.width, (h * 0.8) / v.zoom / entry.height);
    const iw = entry.width * k;
    const ih = entry.height * k;
    const cx = (w / 2 - v.x) / v.zoom;
    const cy = (h / 2 - v.y) / v.zoom;
    const { item } = placeImage(d, entry, { x: cx - iw / 2, y: cy - ih / 2, w: iw, h: ih });
    addToLayer([item], label, d);
  };

  const newText = (at: Point, text: string, area?: { w: number; h: number }): TextItem => {
    const t = settings.type;
    return {
      id: newId(),
      type: 'text',
      name: '',
      opacity: 1,
      blend: 'normal',
      matrix: [1, 0, 0, 1, at.x, at.y],
      align: t.align,
      leading: t.leading,
      area,
      runs: [
        {
          text,
          font: { family: t.family, style: t.style, postscript: `${t.family.replace(/\s+/g, '')}-${t.style.replace(/\s+/g, '')}` },
          size: t.size,
          fill: BLACK,
          stroke: defaultStroke(),
          tracking: t.tracking,
          hscale: t.hscale,
          rise: 0,
        },
      ],
    };
  };

  const selectAllWhere = (pred: (it: Item) => boolean) => {
    const d = need();
    if (!d) return;
    const out: number[] = [];
    for (const l of d.layers) {
      if (l.hidden || l.locked) continue;
      for (const it of l.children) if (!it.hidden && !it.locked && pred(it)) out.push(it.id);
    }
    setSel(out);
  };

  const cmd: Commands = {
    newDoc: () => setDialog({ kind: 'new' }),
    open: () => void openFile(),
    close: () => din.window.requestClose(),
    save: () => void save(),
    saveAs: () => void saveAs(),
    saveCopy: () => void saveAs(true),
    place: async () => {
      if (!need()) return;
      const t = await pick('Place', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ai', '.pdf']);
      if (!t) return;
      try {
        const f = await t.getFile();
        if (f.size > MAX_BYTES) throw new Error(`It’s too big (${formatBytes(f.size)}; up to 1 GB).`);
        const data = new Uint8Array(await f.arrayBuffer());
        if (isImage(t.name)) placeAtCenter(await imageEntry(data, t.name), 'Place');
        else {
          const placed = await readDoc(data, t.name);
          const d = need()!;
          for (const [k, v] of placed.res.images) d.res.images.set(k, v);
          for (const [k, v] of placed.res.fonts) d.res.fonts.set(k, v);
          const items = placed.layers.flatMap((l) => l.children);
          const g: Item = { id: newId(), type: 'group', name: t.name, opacity: 1, blend: 'normal', clip: false, children: items };
          addToLayer(centerItems(d, [g]), 'Place');
        }
      } catch (err) {
        say(`Couldn’t place ${t.name}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
      }
    },
    exportAs: () => setDialog({ kind: 'export' }),
    documentSetup: () => setDialog({ kind: 'setup' }),
    colorMode: (m) => {
      const d = need();
      if (!d || d.mode === m) return;
      commit('Document Color Mode', { ...d, mode: m });
    },
    undo: () => {
      if (editingRef.current) finishEditing();
      if (hist && hist.index > 0) jump(hist.index - 1);
    },
    redo: () => hist && hist.index < hist.entries.length - 1 && jump(hist.index + 1),
    cut: () => {
      if (!copySel()) return;
      editSel('Cut', (d, ids) => ops.deleteItems(d, ids));
      setSel([]);
    },
    copy: () => {
      if (copySel()) say('Copied');
    },
    paste: (how) => void pasteItems(how),
    clear: () => {
      const d = need();
      if (!d) return;
      if (nodeSelRef.current.size && (tool === 'direct' || tool === 'group-select')) {
        commit('Clear', ops.deleteNodes(d, nodeSelRef.current), { sel: [] });
        return;
      }
      editSel('Clear', (dd, ids) => ops.deleteItems(dd, ids));
      setSel([]);
    },
    transformAgain: () => lastTransform && transformSel('Transform Again', lastTransform.m, lastTransform.copy),
    transformDialog: (which) => selRef.current.size && setDialog({ kind: 'transform', which }),
    arrange: (how) => editSel(how === 'front' ? 'Bring to Front' : how === 'back' ? 'Send to Back' : how === 'forward' ? 'Bring Forward' : 'Send Backward', (d, ids) => ops.arrange(d, ids, how)),
    align: (how) => {
      const d = need();
      if (!d) return;
      const to = settings.alignTo === 'artboard' || selRef.current.size === 1 ? (d.artboards[activeBoard] ?? null) : null;
      editSel('Align', (dd, ids) => ops.align(dd, ids, how, to));
    },
    group: () => {
      const d = need();
      if (!d) return;
      const r = ops.group(d, selRef.current);
      if (r) commit('Group', r.doc, { sel: [r.id] });
    },
    ungroup: () => {
      const d = need();
      if (!d) return;
      const r = ops.ungroup(d, selRef.current);
      commit('Ungroup', r.doc, { sel: r.ids });
    },
    lock: () => {
      editSel('Lock', (d, ids) => ops.setProps(d, ids, { locked: true }));
      setSel([]);
    },
    unlockAll: () => {
      const d = need();
      if (!d) return;
      const ids: number[] = [];
      const next = mapItems(d, (it) => {
        if (!it.locked) return undefined;
        ids.push(it.id);
        return { ...it, locked: false };
      });
      commit('Unlock All', next, { sel: ids });
    },
    hide: () => {
      editSel('Hide', (d, ids) => ops.setProps(d, ids, { hidden: true }));
      setSel([]);
    },
    showAll: () => {
      const d = need();
      if (!d) return;
      const ids: number[] = [];
      const next = mapItems(d, (it) => {
        if (!it.hidden) return undefined;
        ids.push(it.id);
        return { ...it, hidden: false };
      });
      commit('Show All', next, { sel: ids });
    },
    join: () => {
      const d = need();
      if (!d) return;
      const r = ops.join(d, selRef.current);
      if (r) commit('Join', r.doc, { sel: [r.id] });
      else say('Select two open paths, or one, to join.');
    },
    average: () => (nodeSelRef.current.size > 1 ? setDialog({ kind: 'average' }) : say('Select two or more anchor points with the Direct Selection tool to average them.')),
    reversePath: () =>
      editSel('Reverse Path Direction', (d, ids) =>
        ops.restyle(d, ids, (it) => (it.type === 'path' ? { ...it, paths: it.paths.map((s) => ({ ...s, nodes: [...s.nodes].reverse().map((n) => ({ ...n, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy })) })) } : it)),
      ),
    addAnchors: () =>
      editSel('Add Anchor Points', (d, ids) =>
        ops.restyle(d, ids, (it) => {
          if (it.type !== 'path') return it;
          let p: PathItem = it;
          p.paths.forEach((sp, si) => {
            const count = segments(sp).length;
            for (let k = count - 1; k >= 0; k--) p = ops.insertNode(p, si, k, 0.5);
          });
          return p;
        }),
      ),
    offsetPath: () => setDialog({ kind: 'offset' }),
    makeClip: () => {
      const d = need();
      if (!d) return;
      const r = ops.group(d, selRef.current, true);
      if (r) commit('Clipping Mask', r.doc, { sel: [r.id] });
      else say('The topmost object must be a path to make a clipping mask.');
    },
    releaseClip: () => {
      const d = need();
      if (!d) return;
      const r = ops.releaseClip(d, selRef.current);
      if (r) commit('Release Clipping Mask', r.doc, { sel: r.ids });
    },
    makeCompound: () => {
      const d = need();
      if (!d) return;
      const r = ops.makeCompound(d, selRef.current);
      if (r) commit('Compound Path', r.doc, { sel: [r.id] });
    },
    releaseCompound: () => {
      const d = need();
      if (!d) return;
      const r = ops.releaseCompound(d, selRef.current);
      if (r) commit('Release Compound Path', r.doc, { sel: r.ids });
    },
    fitArtboard: () => {
      const d = need();
      if (d) commit('Fit Artboard', ops.fitArtboard(d, activeBoard));
    },
    fitArtboardToSelection: () => {
      const d = need();
      if (!d || !selBounds) return;
      commit('Fit Artboard', { ...d, artboards: d.artboards.map((a, i) => (i === activeBoard ? { ...a, ...selBounds } : a)) });
    },
    createOutlines: () => {
      const d = need();
      if (!d) return;
      let missing = false;
      const ids: number[] = [];
      const next = mapItems(d, (it) => {
        if (!selRef.current.has(it.id) || it.type !== 'text') return undefined;
        const g = outlineText(d, it);
        if (!g) {
          missing = true;
          return undefined;
        }
        ids.push(g.id);
        return g;
      });
      if (ids.length) commit('Create Outlines', next, { sel: ids });
      if (missing) say('Type in fonts this computer doesn’t have can only be outlined where the file’s own font has the letters.');
    },
    changeCase: (how) =>
      editSel('Change Case', (d, ids) =>
        ops.restyle(d, ids, (it) => {
          if (it.type !== 'text') return it;
          const tx = textOf(it);
          const next =
            how === 'upper'
              ? tx.toUpperCase()
              : how === 'lower'
                ? tx.toLowerCase()
                : how === 'title'
                  ? tx.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase())
                  : tx.toLowerCase().replace(/(^\s*|[.!?]\s+)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase());
          return replaceRange(it, 0, tx.length, next);
        }),
      ),
    selectAll: () => {
      if (editingRef.current) {
        const t = textareaRef.current;
        t?.select();
        return;
      }
      selectAllWhere(() => true);
    },
    selectAllOnArtboard: () => {
      const d = need();
      const ab = d?.artboards[activeBoard];
      if (!d || !ab) return;
      selectAllWhere((it) => intersects(itemBounds(it, d.res), ab));
    },
    deselect: () => {
      if (selRef.current.size) setLastSel([...selRef.current]);
      setSel([]);
    },
    reselect: () => setSel(lastSel),
    inverse: () => {
      const s = new Set(selRef.current);
      selectAllWhere((it) => !s.has(it.id));
    },
    nextObject: (dir) => {
      const d = need();
      if (!d) return;
      const order = d.layers.flatMap((l) => (l.hidden || l.locked ? [] : l.children.filter((i) => !i.hidden && !i.locked).map((i) => i.id)));
      const cur0 = [...selRef.current][0];
      const i = order.indexOf(cur0);
      const next = order[Math.max(0, Math.min(order.length - 1, i + dir))];
      if (next !== undefined) setSel([next]);
    },
    selectSame: (how) => {
      const d = need();
      if (!d || !firstLeaf) return;
      const ref = firstLeaf;
      const fillOf = (it: Item) => (it.type === 'path' ? it.fill : it.type === 'text' ? it.runs[0].fill : NONE);
      const strokeOf = (it: Item) => (it.type === 'path' ? it.stroke : it.type === 'text' ? it.runs[0].stroke : null);
      const same = (a: Paint, b: Paint) => a.type === b.type && (a.type !== 'color' || (b.type === 'color' && sameColor(a.color, b.color)));
      const out: number[] = [];
      for (const l of d.layers) {
        if (l.hidden || l.locked) continue;
        walk(l.children, (it, parents) => {
          if (it.type === 'group' || parents.some((g) => g.clip && g.children[0] === it)) return;
          const s1 = strokeOf(it);
          const s0 = strokeOf(ref);
          const ok =
            how === 'fill'
              ? same(fillOf(it), fillOf(ref))
              : how === 'stroke'
                ? !!s1 && !!s0 && same(s1.paint, s0.paint)
                : how === 'stroke-weight'
                  ? !!s1 && !!s0 && s1.paint.type !== 'none' && Math.abs(s1.width - s0.width) < 1e-3
                  : how === 'opacity'
                    ? Math.abs(it.opacity - ref.opacity) < 1e-3
                    : how === 'blend'
                      ? it.blend === ref.blend
                      : same(fillOf(it), fillOf(ref)) && !!s1 && !!s0 && same(s1.paint, s0.paint);
          if (ok) out.push(it.id);
        });
      }
      setSel(out);
    },
    toggleOutline: () => setOutline((o) => !o),
    zoomIn: () => zoomAt(zoomStep(viewRef.current.zoom, 1)),
    zoomOut: () => zoomAt(zoomStep(viewRef.current.zoom, -1)),
    fitArtboardView: () => fitBoard(),
    fitAll: () => {
      const d = need();
      if (!d) return;
      const all = d.artboards.reduce<Rect | null>((acc, a) => {
        if (!acc) return { ...a };
        const x = Math.min(acc.x, a.x);
        const y = Math.min(acc.y, a.y);
        return { x, y, w: Math.max(acc.x + acc.w, a.x + a.w) - x, h: Math.max(acc.y + acc.h, a.y + a.h) - y };
      }, null);
      if (all) fitRect(all);
    },
    actual: () => {
      const d = need();
      const ab = d?.artboards[activeBoard];
      const { w, h } = sizeRef.current;
      if (ab) setView({ zoom: 1, x: Math.round(w / 2 - (ab.x + ab.w / 2)), y: Math.round(h / 2 - (ab.y + ab.h / 2)) });
    },
    toggleEdges: () => setEdges((e) => !e),
    toggleArtboards: () => setShowArtboards((e) => !e),
    toggleRulers: () => setSettings((s) => ({ ...s, rulers: !s.rulers })),
    toggleBoundingBox: () => setBoundingBox((b) => !b),
    toggleGrid: () => setGrid((g) => !g),
    toggleSmartGuides: () => setSettings((s) => ({ ...s, smartGuides: !s.smartGuides })),
    togglePanel: (id) => {
      setHidePanels(false);
      setSettings((s) => ({ ...s, panels: { ...s.panels, [id]: !s.panels[id] } }));
    },
    shortcuts: () => setDialog({ kind: 'shortcuts' }),
  };

  const runPathfinder = (mode: ops.ShapeModeOrDivide) => {
    const d = need();
    if (!d) return;
    const r = ops.pathfinder(d, selRef.current, mode);
    if (!r) {
      say('Select two or more paths.');
      return;
    }
    const label = { unite: 'Unite', 'minus-front': 'Minus Front', intersect: 'Intersect', exclude: 'Exclude', divide: 'Divide' }[mode];
    commit(label, r.doc, { sel: r.ids });
    if (!r.ids.length) say('Nothing is left of them.');
  };

  /** Type as paths, from the file's own font outlines. */
  const outlineText = (d: Doc, t: TextItem): Item | null => {
    const layout = layoutText(t, d.res);
    const paths: Item[] = [];
    for (const ln of layout.lines) {
      for (const g of ln.glyphs) {
        if (g.ch === ' ' || g.ch === '\n') continue;
        const run = t.runs[g.run];
        const font = t.placed ? d.res.fonts.get(t.placed.font) : run.font.embedded ? d.res.fonts.get(run.font.embedded) : undefined;
        if (!font?.outlines || g.code === undefined) return null;
        const cmds = font.outline(g.code);
        if (!cmds?.length) continue;
        const k = run.size / 1000;
        const hs = t.placed ? t.placed.hscale : run.hscale;
        const m = mul([k * hs, 0, 0, -k, g.x, ln.y], t.matrix);
        paths.push(ops.pathItem(cmdsToSubPaths(cmds, m), run.fill, run.stroke));
      }
    }
    if (!paths.length) return null;
    // One compound path per object, as Create Outlines makes a group of compound paths.
    const all = paths as PathItem[];
    const compound: PathItem = { ...all[0], id: newId(), paths: all.flatMap((p) => p.paths) };
    return { id: newId(), type: 'group', name: '', opacity: t.opacity, blend: t.blend, clip: false, children: [compound] };
  };

  // ---- Pointer -----------------------------------------------------------------------------------

  const toDoc = (e: { clientX: number; clientY: number }): Point => {
    const r = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
  };
  const tol = () => 4 / viewRef.current.zoom;

  /** The topmost item under a point, as each selection tool picks: top level, the path itself, or one group up. */
  const hitTest = (d: Doc, p: Point, mode: 'top' | 'leaf' = 'top'): { item: Item; top: Item } | null => {
    for (let li = d.layers.length - 1; li >= 0; li--) {
      const l = d.layers[li];
      if (l.hidden || l.locked) continue;
      for (let i = l.children.length - 1; i >= 0; i--) {
        const it = l.children[i];
        if (it.hidden || it.locked) continue;
        if (!hitItem(it, p, tol(), d.res, outline)) continue;
        if (mode === 'top') return { item: it, top: it };
        const leaf = deepest(it, p, d);
        return { item: leaf ?? it, top: it };
      }
    }
    return null;
  };

  const deepest = (it: Item, p: Point, d: Doc): Item | null => {
    if (it.type !== 'group') return it;
    const kids = it.clip ? it.children.slice(1) : it.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k.hidden || k.locked) continue;
      if (hitItem(k, p, tol(), d.res, outline)) return deepest(k, p, d);
    }
    if (it.clip && it.children[0] && hitItem(it.children[0], p, tol(), d.res, true)) return it.children[0];
    return null;
  };

  /** Anchor points near a point: of selected paths first, then any path. */
  const anchorAt = (d: Doc, p: Point, onlySelected = false): { id: number; sp: number; n: number; node: Node } | null => {
    const r = 5 / viewRef.current.zoom;
    const check = (it: Item) => {
      if (it.type !== 'path') return null;
      for (let si = 0; si < it.paths.length; si++) {
        const nodes = it.paths[si].nodes;
        for (let ni = 0; ni < nodes.length; ni++) if (dist(nodes[ni], p) <= r) return { id: it.id, sp: si, n: ni, node: nodes[ni] };
      }
      return null;
    };
    for (const id of selRef.current) {
      const it = findItem(d, id)?.item;
      if (!it) continue;
      for (const leaf of ops.leaves([it])) {
        const hit = check(leaf);
        if (hit) return hit;
      }
    }
    if (onlySelected) return null;
    const h = hitTest(d, p, 'leaf');
    if (h?.item.type === 'path') return check(h.item);
    return null;
  };

  /** A direction handle (of a selected anchor) near a point. */
  const handleAt = (d: Doc, p: Point): { id: number; sp: number; n: number; which: 'in' | 'out' } | null => {
    const r = 5 / viewRef.current.zoom;
    for (const k of nodeSelRef.current) {
      const [id, sp, n] = ops.parseNodeKey(k);
      const it = findItem(d, id)?.item;
      const nd = it?.type === 'path' ? it.paths[sp]?.nodes[n] : undefined;
      if (!nd) continue;
      if ((nd.ix !== nd.x || nd.iy !== nd.y) && dist({ x: nd.ix, y: nd.iy }, p) <= r) return { id, sp, n, which: 'in' };
      if ((nd.ox !== nd.x || nd.oy !== nd.y) && dist({ x: nd.ox, y: nd.oy }, p) <= r) return { id, sp, n, which: 'out' };
    }
    return null;
  };

  const bboxHandleAt = (p: Point): Handle | 'rotate' | null => {
    const d = need();
    if (!d || !selRef.current.size || !boundingBox) return null;
    const b = ops.selectionBounds(d, selRef.current);
    if (!b) return null;
    const z = viewRef.current.zoom;
    for (const h of HANDLES) {
      const q = handlePoint(b, h);
      if (Math.abs(q.x - p.x) * z <= 5 && Math.abs(q.y - p.y) * z <= 5) return h;
    }
    for (const h of ['nw', 'ne', 'se', 'sw'] as Handle[]) {
      const q = handlePoint(b, h);
      const dd = dist(q, p) * z;
      if (dd > 5 && dd <= 18) {
        const outside = (h.includes('w') ? p.x < b.x : p.x > b.x + b.w) || (h.startsWith('n') ? p.y < b.y : p.y > b.y + b.h);
        if (outside) return 'rotate';
      }
    }
    return null;
  };

  /** Smart guides: snap a moving box to other art and artboards; returns the snapped offset and the guides to draw. */
  const snapper = (d: Doc, exclude: Set<number>) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const l of d.layers) {
      if (l.hidden) continue;
      for (const it of l.children) {
        if (exclude.has(it.id) || it.hidden) continue;
        const b = itemBounds(it, d.res);
        if (isEmpty(b)) continue;
        xs.push(b.x, b.x + b.w / 2, b.x + b.w);
        ys.push(b.y, b.y + b.h / 2, b.y + b.h);
      }
    }
    for (const a of d.artboards) {
      xs.push(a.x, a.x + a.w / 2, a.x + a.w);
      ys.push(a.y, a.y + a.h / 2, a.y + a.h);
    }
    return (box: Rect): { dx: number; dy: number; guides: Overlay['guides'] } => {
      const t = 5 / viewRef.current.zoom;
      let best = { dx: 0, dy: 0, gx: null as number | null, gy: null as number | null };
      let bx = t;
      let by = t;
      for (const cx of [box.x, box.x + box.w / 2, box.x + box.w]) {
        for (const x of xs) {
          const dd = Math.abs(x - cx);
          if (dd < bx) {
            bx = dd;
            best = { ...best, dx: x - cx, gx: x };
          }
        }
      }
      for (const cy of [box.y, box.y + box.h / 2, box.y + box.h]) {
        for (const y of ys) {
          const dd = Math.abs(y - cy);
          if (dd < by) {
            by = dd;
            best = { ...best, dy: y - cy, gy: y };
          }
        }
      }
      const guides: Overlay['guides'] = [];
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const left = -v.x / v.zoom;
      const top = -v.y / v.zoom;
      if (best.gx !== null) guides.push({ a: { x: best.gx, y: top }, b: { x: best.gx, y: top + h / v.zoom } });
      if (best.gy !== null) guides.push({ a: { x: left, y: best.gy }, b: { x: left + w / v.zoom, y: best.gy } });
      return { dx: best.dx, dy: best.dy, guides };
    };
  };

  const startMoveSel = (d: Doc, start: Point, e: React.PointerEvent): Gesture => {
    const ids = new Set(selRef.current);
    const b0 = ops.selectionBounds(d, ids);
    const snap = settings.smartGuides && b0 ? snapper(d, ids) : null;
    let moved = false;
    let last: Mat = translate(0, 0);
    const alt = e.altKey;
    return {
      move(p, ev) {
        let q = ev.shiftKey ? constrain(start, p) : p;
        if (!moved && dist(q, start) * viewRef.current.zoom < 3) return;
        moved = true;
        let dx = q.x - start.x;
        let dy = q.y - start.y;
        let guides: Overlay['guides'] = [];
        if (snap && b0) {
          const s = snap({ ...b0, x: b0.x + dx, y: b0.y + dy });
          dx += s.dx;
          dy += s.dy;
          guides = s.guides;
        }
        q = { x: start.x + dx, y: start.y + dy };
        last = translate(dx, dy);
        overlayExtra.current = { guides };
        setPointer(q);
        if (ev.altKey || alt) {
          const r = ops.duplicateItems(d, ids, last);
          setLive({ doc: r.doc });
        } else {
          const live = ops.transformItems(d, ids, last, { strokes: false });
          setLive({ doc: live, skip: ids, draw: ops.selectedItems(live, ids) });
        }
      },
      up(_p, ev) {
        overlayExtra.current = {};
        if (!moved) {
          setLive(null);
          return;
        }
        if (ev.altKey || alt) {
          const r = ops.duplicateItems(d, ids, last);
          commit('Copy', r.doc, { sel: r.ids });
          setLastTransform({ m: last, copy: true });
        } else {
          commit('Move', ops.transformItems(d, ids, last, { strokes: false }));
          setLastTransform({ m: last, copy: false });
        }
      },
      cancel() {
        overlayExtra.current = {};
        setLive(null);
      },
    };
  };

  const startMarquee = (d: Doc, start: Point, e: React.PointerEvent, direct: boolean): Gesture => {
    const add = e.shiftKey;
    const base = new Set(add ? selRef.current : []);
    const baseNodes = new Set(add ? nodeSelRef.current : []);
    const rect = (p: Point): Rect => ({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
    return {
      move(p) {
        overlayExtra.current = { marquee: rect(p) };
        schedule();
      },
      up(p) {
        overlayExtra.current = {};
        const r = rect(p);
        if (r.w * viewRef.current.zoom < 2 && r.h * viewRef.current.zoom < 2) {
          schedule();
          return;
        }
        const ids = new Set(base);
        const nodes = new Set(baseNodes);
        for (const l of d.layers) {
          if (l.hidden || l.locked) continue;
          for (const it of l.children) {
            if (it.hidden || it.locked) continue;
            if (!direct) {
              if (intersects(itemBounds(it, d.res), r)) ids.add(it.id);
              continue;
            }
            walk([it], (leaf, parents) => {
              if (leaf.type === 'group' || leaf.hidden || leaf.locked || parents.some((g) => g.hidden || g.locked)) return;
              if (leaf.type === 'path') {
                let any = false;
                leaf.paths.forEach((sp, si) =>
                  sp.nodes.forEach((n, ni) => {
                    if (n.x >= r.x && n.x <= r.x + r.w && n.y >= r.y && n.y <= r.y + r.h) {
                      nodes.add(ops.nodeKey(leaf.id, si, ni));
                      any = true;
                    }
                  }),
                );
                if (any) ids.add(leaf.id);
              } else if (intersects(itemBounds(leaf, d.res), r)) ids.add(leaf.id);
            });
          }
        }
        setSel(ids, nodes);
      },
      cancel() {
        overlayExtra.current = {};
        schedule();
      },
    };
  };

  const startScale = (d: Doc, handle: Handle, e: React.PointerEvent): Gesture | null => {
    const ids = new Set(selRef.current);
    const b = ops.selectionBounds(d, ids);
    if (!b) return null;
    const opp: Handle = ({ nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' } as const)[handle];
    const p0 = handlePoint(b, handle);
    let m: Mat = translate(0, 0);
    void e;
    return {
      move(p, ev) {
        const o = ev.altKey ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : handlePoint(b, opp);
        const hx = handle.includes('e') || handle.includes('w');
        const hy = handle.startsWith('n') || handle.startsWith('s');
        let sx = hx && p0.x !== o.x ? (p.x - o.x) / (p0.x - o.x) : 1;
        let sy = hy && p0.y !== o.y ? (p.y - o.y) / (p0.y - o.y) : 1;
        if (ev.shiftKey) {
          if (hx && hy) {
            const s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
            sx = Math.sign(sx || 1) * Math.abs(s);
            sy = Math.sign(sy || 1) * Math.abs(s);
          } else if (hx) sy = Math.abs(sx);
          else sx = Math.abs(sy);
        }
        if (!Number.isFinite(sx) || Math.abs(sx) < 1e-4) sx = 1e-4;
        if (!Number.isFinite(sy) || Math.abs(sy) < 1e-4) sy = 1e-4;
        m = scaleAbout(sx, sy, o.x, o.y);
        const live = ops.transformItems(d, ids, m, { strokes: false });
        setLive({ doc: live, skip: ids, draw: ops.selectedItems(live, ids) });
        const nb = ops.selectionBounds(live, ids);
        if (nb) say(`W: ${fmtLen(nb.w, d.units)}  H: ${fmtLen(nb.h, d.units)}`);
      },
      up() {
        commit('Scale', ops.transformItems(d, ids, m, { strokes: false }));
        setLastTransform({ m, copy: false });
      },
      cancel: () => setLive(null),
    };
  };

  const startRotate = (d: Doc, start: Point, origin: Point | null): Gesture | null => {
    const ids = new Set(selRef.current);
    const o = origin ?? centerOf(d, ids);
    if (!o) return null;
    const a0 = Math.atan2(start.y - o.y, start.x - o.x);
    let m: Mat = translate(0, 0);
    return {
      move(p, ev) {
        let a = Math.atan2(p.y - o.y, p.x - o.x) - a0;
        if (ev.shiftKey) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
        m = rotateAbout(a, o.x, o.y);
        const live = ev.altKey ? ops.duplicateItems(d, ids, m).doc : ops.transformItems(d, ids, m);
        setLive(ev.altKey ? { doc: live } : { doc: live, skip: ids, draw: ops.selectedItems(live, ids) });
        say(`${Math.round((-a * 180) / Math.PI * 10) / 10}°`);
      },
      up(_p, ev) {
        if (ev.altKey) {
          const r = ops.duplicateItems(d, ids, m);
          commit('Rotate', r.doc, { sel: r.ids });
        } else commit('Rotate', ops.transformItems(d, ids, m));
        setLastTransform({ m, copy: ev.altKey });
      },
      cancel: () => setLive(null),
    };
  };

  const startToolTransform = (d: Doc, start: Point, kind: 'reflect' | 'scale' | 'shear'): Gesture | null => {
    const ids = new Set(selRef.current);
    const o = originRef.current ?? centerOf(d, ids);
    if (!o) return null;
    let m: Mat = translate(0, 0);
    return {
      move(p, ev) {
        if (kind === 'reflect') {
          let a = Math.atan2(p.y - o.y, p.x - o.x);
          if (ev.shiftKey) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
          const c2 = Math.cos(2 * a);
          const s2 = Math.sin(2 * a);
          m = mul(mul(translate(-o.x, -o.y), [c2, s2, s2, -c2, 0, 0]), translate(o.x, o.y));
          overlayExtra.current = { lines: [{ a: { x: o.x - Math.cos(a) * 1e4, y: o.y - Math.sin(a) * 1e4 }, b: { x: o.x + Math.cos(a) * 1e4, y: o.y + Math.sin(a) * 1e4 }, color: '#2d8ceb', dash: true }] };
        } else if (kind === 'scale') {
          let sx = (p.x - o.x) / (start.x - o.x || 1);
          let sy = (p.y - o.y) / (start.y - o.y || 1);
          if (ev.shiftKey) sx = sy = Math.max(Math.abs(sx), Math.abs(sy));
          m = scaleAbout(sx || 1e-4, sy || 1e-4, o.x, o.y);
        } else {
          const t = (p.x - start.x) / (Math.abs(start.y - o.y) || 1);
          m = mul(mul(translate(-o.x, -o.y), [1, 0, -t * Math.sign(start.y - o.y || 1), 1, 0, 0]), translate(o.x, o.y));
        }
        const live = ev.altKey ? ops.duplicateItems(d, ids, m).doc : ops.transformItems(d, ids, m);
        setLive(ev.altKey ? { doc: live } : { doc: live, skip: ids, draw: ops.selectedItems(live, ids) });
      },
      up(_p, ev) {
        overlayExtra.current = {};
        const label = kind === 'reflect' ? 'Reflect' : kind === 'scale' ? 'Scale' : 'Shear';
        if (ev.altKey) {
          const r = ops.duplicateItems(d, ids, m);
          commit(label, r.doc, { sel: r.ids });
        } else commit(label, ops.transformItems(d, ids, m));
        setLastTransform({ m, copy: ev.altKey });
      },
      cancel() {
        overlayExtra.current = {};
        setLive(null);
      },
    };
  };

  /** Drag anchors (Direct Selection), or a handle. */
  const startNodeDrag = (d: Doc, start: Point, keys: Set<string>): Gesture => {
    let moved = false;
    let dx = 0;
    let dy = 0;
    return {
      move(p, ev) {
        const q = ev.shiftKey ? constrain(start, p) : p;
        if (!moved && dist(q, start) * viewRef.current.zoom < 2) return;
        moved = true;
        dx = q.x - start.x;
        dy = q.y - start.y;
        setLive({ doc: ops.moveNodes(d, keys, dx, dy) });
      },
      up() {
        if (moved) commit('Move', ops.moveNodes(d, keys, dx, dy));
        else setLive(null);
      },
      cancel: () => setLive(null),
    };
  };

  const startHandleDrag = (d: Doc, h: { id: number; sp: number; n: number; which: 'in' | 'out' }, independent: boolean): Gesture => {
    let next = d;
    return {
      move(p, ev) {
        next = ops.updatePath(d, h.id, (it) => ({
          ...it,
          paths: it.paths.map((s, si) =>
            si !== h.sp
              ? s
              : {
                  ...s,
                  nodes: s.nodes.map((n, ni) => {
                    if (ni !== h.n) return n;
                    const free = independent || ev.altKey;
                    const q = ev.shiftKey ? constrain(n, p) : p;
                    if (h.which === 'out') {
                      const smooth = !free && isSmooth(n);
                      const len = Math.hypot(n.ix - n.x, n.iy - n.y);
                      const a = Math.atan2(q.y - n.y, q.x - n.x);
                      return { ...n, ox: q.x, oy: q.y, ...(smooth ? { ix: n.x - Math.cos(a) * len, iy: n.y - Math.sin(a) * len } : {}) };
                    }
                    const smooth = !free && isSmooth(n);
                    const len = Math.hypot(n.ox - n.x, n.oy - n.y);
                    const a = Math.atan2(q.y - n.y, q.x - n.x);
                    return { ...n, ix: q.x, iy: q.y, ...(smooth ? { ox: n.x - Math.cos(a) * len, oy: n.y - Math.sin(a) * len } : {}) };
                  }),
                },
          ),
        }));
        setLive({ doc: next });
      },
      up: () => commit('Direction Handle', next),
      cancel: () => setLive(null),
    };
  };

  const startShape = (d: Doc, start: Point, kind: ToolId): Gesture => {
    let moved = false;
    const geometry = (p: Point, ev: PointerEvent): PathItem['paths'] | null => {
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (kind === 'line') {
        const q = ev.shiftKey ? constrain(start, p) : p;
        return [ops.linePath(ev.altKey ? 2 * start.x - q.x : start.x, ev.altKey ? 2 * start.y - q.y : start.y, q.x, q.y)];
      }
      if (kind === 'polygon' || kind === 'star') {
        const r = Math.hypot(dx, dy);
        const ang = ev.shiftKey ? -Math.PI / 2 : Math.atan2(dy, dx);
        return kind === 'polygon' ? [ops.polygonPath(start.x, start.y, r, DEFAULT_SHAPE.sides, ang)] : [ops.starPath(start.x, start.y, r, r * DEFAULT_SHAPE.inner, DEFAULT_SHAPE.points, ang)];
      }
      if (ev.shiftKey) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * s;
        dy = Math.sign(dy || 1) * s;
      }
      const x = ev.altKey ? start.x - dx : Math.min(start.x, start.x + dx);
      const y = ev.altKey ? start.y - dy : Math.min(start.y, start.y + dy);
      const w = ev.altKey ? Math.abs(dx) * 2 : Math.abs(dx);
      const h = ev.altKey ? Math.abs(dy) * 2 : Math.abs(dy);
      if (kind === 'ellipse') return [ops.ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2)];
      return [ops.rectPath(x, y, w, h, kind === 'rounded-rectangle' ? DEFAULT_SHAPE.radius : 0)];
    };
    let last: PathItem['paths'] | null = null;
    return {
      move(p, ev) {
        if (!moved && dist(p, start) * viewRef.current.zoom < 3) return;
        moved = true;
        last = geometry(p, ev);
        overlayExtra.current = { ghost: last ? toPath2D(last) : null, ghostColor: activeLayer?.color ?? '#4f80ff' };
        if (last) {
          // The shape as it will be, fill and stroke and all.
          const item = newPath(last, kind === 'line' ? 'line' : 'shape');
          setLive({ doc: d, draw: [item] });
        }
        const b = last ? ops.rectOfPoints(last.flatMap((s) => s.nodes)) : null;
        if (b) say(`W: ${fmtLen(b.w, d.units)}  H: ${fmtLen(b.h, d.units)}`);
        schedule();
      },
      up() {
        overlayExtra.current = {};
        liveRef.current = null;
        if (!moved || !last) {
          if (kind !== 'line') setDialog({ kind: 'shape', tool: kind, at: start });
          schedule();
          return;
        }
        addToLayer([newPath(last, kind === 'line' ? 'line' : 'shape')], kindName(kind));
      },
      cancel() {
        overlayExtra.current = {};
        schedule();
      },
    };
  };

  const startFreehand = (d: Doc, start: Point, kind: 'pencil' | 'paintbrush'): Gesture => {
    const pts: Point[] = [start];
    void d;
    return {
      move(p) {
        pts.push(p);
        const g = new Path2D();
        g.moveTo(pts[0].x, pts[0].y);
        for (const q of pts) g.lineTo(q.x, q.y);
        overlayExtra.current = { ghost: g, ghostColor: kind === 'pencil' ? '#4f80ff' : '#4f80ff' };
        schedule();
      },
      up() {
        overlayExtra.current = {};
        if (pts.length < 3) {
          schedule();
          return;
        }
        const closed = dist(pts[0], pts[pts.length - 1]) * viewRef.current.zoom < 8;
        const sp = ops.smoothPath(pts, closed, 1.5 / viewRef.current.zoom);
        addToLayer([newPath([sp], 'freehand')], kind === 'pencil' ? 'Pencil' : 'Paintbrush');
      },
      cancel() {
        overlayExtra.current = {};
        schedule();
      },
    };
  };

  const startPen = (d: Doc, p0: Point, e: React.PointerEvent): Gesture | null => {
    const z = viewRef.current.zoom;
    const pr = penRef.current;
    const pen = pr ? findItem(d, pr.id)?.item : null;
    if (pr && pen?.type === 'path') {
      const sp = pen.paths[pr.sp];
      const first = sp.nodes[0];
      const lastN = sp.nodes[sp.nodes.length - 1];
      const p = e.shiftKey ? constrain(lastN, p0) : p0;
      // Close the path on its first anchor.
      if (sp.nodes.length > 1 && dist(first, p0) * z <= 6) {
        let next = ops.updatePath(d, pr.id, (it) => ({ ...it, paths: it.paths.map((s, i) => (i === pr.sp ? { ...s, closed: true } : s)) }));
        return {
          move(q, ev) {
            next = ops.updatePath(d, pr.id, (it) => ({
              ...it,
              paths: it.paths.map((s, i) => {
                if (i !== pr.sp) return { ...s };
                const n0 = s.nodes[0];
                const ox = q.x;
                const oy = q.y;
                const nodes = [...s.nodes];
                nodes[0] = ev.altKey ? { ...n0, ix: 2 * n0.x - ox, iy: 2 * n0.y - oy } : { ...n0, ox, oy, ix: 2 * n0.x - ox, iy: 2 * n0.y - oy };
                return { ...s, closed: true, nodes };
              }),
            }));
            setLive({ doc: next });
          },
          up() {
            commit('Pen', next);
            penRef.current = null;
            overlayExtra.current = {};
          },
        };
      }
      const add = ops.updatePath(d, pr.id, (it) => ({
        ...it,
        paths: it.paths.map((s, i) => (i === pr.sp ? { ...s, nodes: [...s.nodes, { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y }] } : s)),
      }));
      let next = add;
      return {
        move(q, ev) {
          const qq = ev.shiftKey ? constrain(p, q) : q;
          next = ops.updatePath(add, pr.id, (it) => ({
            ...it,
            paths: it.paths.map((s, i) => {
              if (i !== pr.sp) return s;
              const nodes = [...s.nodes];
              const n = nodes[nodes.length - 1];
              nodes[nodes.length - 1] = ev.altKey ? { ...n, ox: qq.x, oy: qq.y } : { ...n, ox: qq.x, oy: qq.y, ix: 2 * n.x - qq.x, iy: 2 * n.y - qq.y };
              return { ...s, nodes };
            }),
          }));
          setLive({ doc: next });
        },
        up() {
          commit('Pen', next, { sel: [pr.id], nodes: new Set([ops.nodeKey(pr.id, pr.sp, (findItem(next, pr.id)?.item as PathItem).paths[pr.sp].nodes.length - 1)]) });
        },
      };
    }
    // Not drawing: continue an open path from its end, add or delete anchors on the selected path, or start a new one.
    const a = anchorAt(d, p0, true);
    if (a) {
      const it = findItem(d, a.id)?.item as PathItem;
      const sp = it.paths[a.sp];
      if (!sp.closed && (a.n === 0 || a.n === sp.nodes.length - 1)) {
        // Drawing goes on from the end; starting at the first anchor turns the path around.
        if (a.n === 0 && sp.nodes.length > 1) {
          commit('Pen', ops.updatePath(d, a.id, (x) => ({ ...x, paths: x.paths.map((s, i) => (i === a.sp ? { ...s, nodes: [...s.nodes].reverse().map((n) => ({ ...n, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy })) } : s)) })));
        }
        penRef.current = { id: a.id, sp: a.sp };
        setSel([a.id]);
        return null;
      }
      commit('Delete Anchor Point', ops.deleteNodes(d, new Set([ops.nodeKey(a.id, a.sp, a.n)])));
      return null;
    }
    for (const id of selRef.current) {
      const it = findItem(d, id)?.item;
      if (it?.type !== 'path') continue;
      for (let si = 0; si < it.paths.length; si++) {
        const segs = segments(it.paths[si]);
        for (let k = 0; k < segs.length; k++) {
          const near = nearestOnSegment(segs[k][0], segs[k][1], p0);
          if (near.d * z <= 4) {
            commit('Add Anchor Point', ops.updatePath(d, id, (x) => ops.insertNode(x, si, k, near.t)));
            return null;
          }
        }
      }
    }
    const item = newPath([{ closed: false, nodes: [{ x: p0.x, y: p0.y, ix: p0.x, iy: p0.y, ox: p0.x, oy: p0.y }] }], 'line');
    item.fill = settings.fill;
    const target = targetLayer(d);
    const layerDoc = ops.addItems(target.doc, target.id, [item]);
    penRef.current = { id: item.id, sp: 0 };
    let next = layerDoc;
    return {
      move(q, ev) {
        next = ops.updatePath(layerDoc, item.id, (it) => {
          const n = it.paths[0].nodes[0];
          const qq = ev.shiftKey ? constrain(n, q) : q;
          return { ...it, paths: [{ ...it.paths[0], nodes: [{ ...n, ox: qq.x, oy: qq.y, ix: 2 * n.x - qq.x, iy: 2 * n.y - qq.y }] }] };
        });
        setLive({ doc: next });
      },
      up() {
        commit('Pen', next, { sel: [item.id], nodes: new Set([ops.nodeKey(item.id, 0, 0)]) });
      },
    };
  };

  const startArtboard = (d: Doc, p: Point, e: React.PointerEvent): Gesture | null => {
    const z = viewRef.current.zoom;
    const ai = activeBoard;
    const ab = d.artboards[ai];
    if (ab) {
      for (const h of HANDLES) {
        const q = handlePoint(ab, h);
        if (Math.abs(q.x - p.x) * z <= 6 && Math.abs(q.y - p.y) * z <= 6) {
          let next = d;
          return {
            move(pp) {
              let { x, y, w, h: hh } = ab;
              if (h.includes('w')) {
                w = ab.x + ab.w - pp.x;
                x = pp.x;
              }
              if (h.includes('e')) w = pp.x - ab.x;
              if (h.startsWith('n')) {
                hh = ab.y + ab.h - pp.y;
                y = pp.y;
              }
              if (h.startsWith('s')) hh = pp.y - ab.y;
              const r = { x: w < 0 ? x + w : x, y: hh < 0 ? y + hh : y, w: Math.max(1, Math.abs(w)), h: Math.max(1, Math.abs(hh)) };
              next = { ...d, artboards: d.artboards.map((a, i) => (i === ai ? { ...a, ...r } : a)) };
              setLive({ doc: next });
              say(`W: ${fmtLen(r.w, d.units)}  H: ${fmtLen(r.h, d.units)}`);
            },
            up: () => commit('Resize Artboard', next),
            cancel: () => setLive(null),
          };
        }
      }
    }
    const hit = d.artboards.findIndex((a) => p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);
    if (hit >= 0) {
      setActiveBoard(hit);
      const a0 = d.artboards[hit];
      let next = d;
      let moved = false;
      const withArt = !e.altKey;
      const inside = new Set(d.layers.flatMap((l) => l.children.filter((it) => intersects(itemBounds(it, d.res), a0) && ops.selectionBounds(d, new Set([it.id])) !== null).map((it) => it.id)));
      return {
        move(pp, ev) {
          const q = ev.shiftKey ? constrain(p, pp) : pp;
          if (!moved && dist(q, p) * z < 3) return;
          moved = true;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          next = { ...d, artboards: d.artboards.map((a, i) => (i === hit ? { ...a, x: a0.x + dx, y: a0.y + dy } : a)) };
          if (withArt) next = ops.transformItems(next, inside, translate(dx, dy), { strokes: false });
          setLive({ doc: next });
        },
        up: () => (moved ? commit('Move Artboard', next) : setLive(null)),
        cancel: () => setLive(null),
      };
    }
    // Draw a new artboard.
    let r: Rect = { x: p.x, y: p.y, w: 0, h: 0 };
    return {
      move(pp) {
        r = { x: Math.min(p.x, pp.x), y: Math.min(p.y, pp.y), w: Math.abs(pp.x - p.x), h: Math.abs(pp.y - p.y) };
        overlayExtra.current = { marquee: r };
        schedule();
      },
      up() {
        overlayExtra.current = {};
        if (r.w * z < 4 || r.h * z < 4) {
          schedule();
          return;
        }
        const ab2: Artboard = { id: newId(), name: `Artboard ${d.artboards.length + 1}`, ...r };
        commit('New Artboard', { ...d, artboards: [...d.artboards, ab2] });
        setActiveBoard(d.artboards.length);
      },
      cancel() {
        overlayExtra.current = {};
        schedule();
      },
    };
  };

  const startGradient = (d: Doc, start: Point): Gesture | null => {
    const ids = new Set(selRef.current);
    if (!ids.size) return null;
    const firstFill = firstLeaf?.type === 'path' ? firstLeaf.fill : null;
    const base: Gradient = firstFill?.type === 'gradient' ? firstFill.gradient : fitGradient('linear', [
      { t: 0, color: firstFill?.type === 'color' ? firstFill.color : { space: 'rgb', c: [1, 1, 1] }, opacity: 1 },
      { t: 1, color: { space: 'rgb', c: [0, 0, 0] }, opacity: 1 },
    ], selBounds ?? { x: 0, y: 0, w: 1, h: 1 });
    let next = d;
    return {
      move(p, ev) {
        const q = ev.shiftKey ? constrain(start, p) : p;
        const g = gradientBetween(base, start, q);
        next = ops.setFill(d, ids, { type: 'gradient', gradient: g });
        overlayExtra.current = { lines: [{ a: start, b: q, color: '#000' }], dots: [{ p: start, color: '#000', r: 3, square: true, hollow: true }, { p: q, color: '#000', r: 3, square: true }] };
        setLive({ doc: next });
      },
      up() {
        overlayExtra.current = {};
        commit('Gradient', next);
      },
      cancel() {
        overlayExtra.current = {};
        setLive(null);
      },
    };
  };

  const eyedrop = (d: Doc, p: Point) => {
    const h = hitTest(d, p, 'leaf');
    if (!h) return;
    const src = h.item;
    const fill = src.type === 'path' ? src.fill : src.type === 'text' ? src.runs[0].fill : null;
    const stroke = src.type === 'path' ? src.stroke : src.type === 'text' ? src.runs[0].stroke : null;
    if (!fill || !stroke) return;
    if (selRef.current.size) {
      let next = ops.setFill(d, selRef.current, fill);
      next = ops.setStroke(next, selRef.current, stroke);
      commit('Eyedropper', next);
    }
    setSettings((s) => ({ ...s, fill, stroke }));
  };

  const scissors = (d: Doc, p: Point) => {
    const h = hitTest(d, p, 'leaf');
    if (!h || h.item.type !== 'path') return;
    const it = h.item;
    const z = viewRef.current.zoom;
    for (let si = 0; si < it.paths.length; si++) {
      const nodes = it.paths[si].nodes;
      for (let ni = 0; ni < nodes.length; ni++) {
        if (dist(nodes[ni], p) * z <= 5) {
          const parts = ops.cutAt(it, si, ni);
          commit('Scissors', mapItems(d, (x) => (x.id === it.id ? parts : undefined)), { sel: parts.map((q) => q.id) });
          return;
        }
      }
      const segs = segments(it.paths[si]);
      for (let k = 0; k < segs.length; k++) {
        const near = nearestOnSegment(segs[k][0], segs[k][1], p);
        if (near.d * z <= 5) {
          const withNode = ops.insertNode(it, si, k, near.t);
          const parts = ops.cutAt(withNode, si, k + 1);
          commit('Scissors', mapItems(d, (x) => (x.id === it.id ? parts : undefined)), { sel: parts.map((q) => q.id) });
          return;
        }
      }
    }
  };

  const textPointerDown = (d: Doc, p: Point, e: React.PointerEvent): Gesture | null => {
    const ed = editingRef.current;
    const pick = (t: TextItem, q: Point) => {
      const local = apply(invert(t.matrix), q.x, q.y);
      return indexAt(layoutText(t, d.res), local.x, local.y);
    };
    if (ed) {
      const t = findItem(d, ed.id)?.item;
      if (t?.type === 'text' && hitItem(t, p, tol() * 2, d.res)) {
        const i = pick(t, p);
        const text = textOf(t);
        if (e.detail === 2) {
          const [a, b] = wordAt(text, i);
          setCaret(a, b);
          return null;
        }
        if (e.detail >= 3) {
          setCaret(0, text.length);
          return null;
        }
        const anchor = e.shiftKey ? ed.start : i;
        setCaret(anchor, i);
        return {
          move(q) {
            setCaret(anchor, pick(t, q));
          },
          up() {},
        };
      }
      finishEditing();
      if (tool !== 'type') return null;
    }
    const h = hitTest(d, p, 'leaf');
    if (h?.item.type === 'text') {
      const t = h.item;
      const i = pick(t, p);
      beginEditing(t.id, i, i);
      return null;
    }
    // New type: a click is point type; a drag draws an area type box.
    let r: Rect | null = null;
    return {
      move(q) {
        if (dist(q, p) * viewRef.current.zoom < 4) return;
        r = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
        overlayExtra.current = { marquee: r };
        schedule();
      },
      up() {
        overlayExtra.current = {};
        const t = r ? newText({ x: r.x, y: r.y }, '', { w: Math.max(10, r.w), h: Math.max(10, r.h) }) : newText(p, '');
        addToLayer([t], 'Type');
        beginEditing(t.id, 0, 0);
      },
      cancel() {
        overlayExtra.current = {};
      },
    };
  };

  const setCaret = (start: number, end: number) => {
    const ed = editingRef.current;
    if (!ed) return;
    const next = { ...ed, start, end };
    editingRef.current = next;
    setEditing(next);
    caretOn.current = true;
    const ta = textareaRef.current;
    if (ta) {
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      ta.setSelectionRange(lo, hi, end < start ? 'backward' : 'forward');
    }
    schedule();
  };

  const beginEditing = (id: number, start: number, end: number) => {
    if (penRef.current) finishPen();
    const next = { id, start, end };
    editingRef.current = next;
    setEditing(next);
    setSel([id]);
    if (tool !== 'type') setToolState('type');
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(Math.min(start, end), Math.max(start, end));
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = docRef.current;
    if (!d || dialog) return;
    if (e.button === 2) {
      // A right-click on something not selected selects it first, as in Illustrator.
      const hit = hitTest(d, toDoc(e), 'top');
      if (hit && !selRef.current.has(hit.top.id)) setSel([hit.top.id]);
      return;
    }
    if (!editingRef.current) rootRef.current?.focus({ preventScroll: true });
    const r = viewportRef.current!.getBoundingClientRect();
    const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    const p = toDoc(e);
    let g: Gesture | null = null;
    // Ctrl borrows the last selection tool, as in Illustrator.
    const ctrl = e.ctrlKey || e.metaKey;
    const t: ToolId = ctrl && !['selection', 'direct', 'group-select'].includes(tool) ? 'selection' : tool;
    if (spaceDown || e.button === 1 || t === 'hand') {
      const v0 = viewRef.current;
      setPanning(true);
      g = {
        move(_q, ev) {
          setView({ ...v0, x: v0.x + ev.clientX - e.clientX, y: v0.y + ev.clientY - e.clientY });
        },
        up: () => setPanning(false),
        cancel: () => setPanning(false),
      };
    } else {
      if (editingRef.current && t !== 'type') finishEditing();
      switch (t) {
        case 'zoom': {
          const start = sp;
          g = {
            move(q) {
              const a = toDoc({ clientX: start.x + r.left, clientY: start.y + r.top });
              overlayExtra.current = { marquee: { x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), w: Math.abs(q.x - a.x), h: Math.abs(q.y - a.y) } };
              schedule();
            },
            up(q, ev) {
              const m = overlayExtra.current.marquee;
              overlayExtra.current = {};
              if (m && m.w * viewRef.current.zoom > 6 && m.h * viewRef.current.zoom > 6) fitRect(m);
              else zoomAt(zoomStep(viewRef.current.zoom, ev.altKey ? -1 : 1), start.x, start.y);
              void q;
            },
          };
          break;
        }
        case 'selection':
        case 'free-transform': {
          const h = bboxHandleAt(p);
          if (h === 'rotate') g = startRotate(d, p, null);
          else if (h) g = startScale(d, h, e);
          else {
            const hit = hitTest(d, p, 'top');
            if (hit) {
              const id = hit.top.id;
              if (e.shiftKey) {
                const s = new Set(selRef.current);
                if (s.has(id)) s.delete(id);
                else s.add(id);
                setSel(s);
              } else if (!selRef.current.has(id)) setSel([id]);
              if (selRef.current.has(id) || !e.shiftKey) g = startMoveSel(d, p, e);
              const lay = findItem(d, id)?.layer;
              if (lay) setActiveLayer(lay.id);
            } else g = startMarquee(d, p, e, false);
          }
          break;
        }
        case 'direct':
        case 'group-select': {
          const hd = handleAt(d, p);
          if (hd) {
            g = startHandleDrag(d, hd, false);
            break;
          }
          const a = anchorAt(d, p);
          if (a) {
            const k = ops.nodeKey(a.id, a.sp, a.n);
            let keys = new Set(nodeSelRef.current);
            const ids = new Set(selRef.current);
            if (e.shiftKey) {
              if (keys.has(k)) keys.delete(k);
              else keys.add(k);
              ids.add(a.id);
            } else if (!keys.has(k)) {
              keys = new Set([k]);
              ids.clear();
              ids.add(a.id);
            }
            setSel(ids, keys);
            g = startNodeDrag(d, p, keys);
            break;
          }
          const hit = hitTest(d, p, 'leaf');
          if (hit) {
            let target = hit.item;
            if (t === 'group-select') {
              // Each click on something already selected selects the next group up.
              const place = findItem(d, hit.item.id);
              const chain = place ? [...place.parents].reverse() : [];
              if (selRef.current.has(target.id)) {
                const up = chain.find((gp) => !selRef.current.has(gp.id));
                if (up) target = up;
              }
            }
            const ids = e.shiftKey ? new Set(selRef.current) : new Set<number>();
            ids.add(target.id);
            const keys = new Set<string>();
            for (const leaf of ops.leaves([target])) if (leaf.type === 'path') leaf.paths.forEach((s, si) => s.nodes.forEach((_n, ni) => keys.add(ops.nodeKey(leaf.id, si, ni))));
            setSel(ids, e.shiftKey ? new Set([...nodeSelRef.current, ...keys]) : keys);
            g = startMoveSel(d, p, e);
          } else g = startMarquee(d, p, e, true);
          break;
        }
        case 'pen':
          g = startPen(d, p, e);
          break;
        case 'add-anchor': {
          const hit = hitTest(d, p, 'leaf');
          if (hit?.item.type === 'path') {
            const it = hit.item;
            for (let si = 0; si < it.paths.length; si++) {
              const segs = segments(it.paths[si]);
              for (let k = 0; k < segs.length; k++) {
                const near = nearestOnSegment(segs[k][0], segs[k][1], p);
                if (near.d * viewRef.current.zoom <= 5) {
                  commit('Add Anchor Point', ops.updatePath(d, it.id, (x) => ops.insertNode(x, si, k, near.t)), { sel: [it.id] });
                  return;
                }
              }
            }
          }
          return;
        }
        case 'delete-anchor': {
          const a = anchorAt(d, p);
          if (a) commit('Delete Anchor Point', ops.deleteNodes(d, new Set([ops.nodeKey(a.id, a.sp, a.n)])), { sel: [a.id] });
          return;
        }
        case 'anchor': {
          const hd = handleAt(d, p);
          if (hd) {
            g = startHandleDrag(d, hd, true);
            break;
          }
          const a = anchorAt(d, p);
          if (!a) return;
          const key = ops.nodeKey(a.id, a.sp, a.n);
          setSel([a.id], new Set([key]));
          let moved = false;
          let next = d;
          g = {
            move(q) {
              moved = true;
              next = ops.updatePath(d, a.id, (it) => ({
                ...it,
                paths: it.paths.map((s, si) => (si !== a.sp ? s : { ...s, nodes: s.nodes.map((n, ni) => (ni !== a.n ? n : { ...n, ox: q.x, oy: q.y, ix: 2 * n.x - q.x, iy: 2 * n.y - q.y })) })),
              }));
              setLive({ doc: next });
            },
            up() {
              if (moved) commit('Convert Anchor Point', next);
              else
                commit(
                  'Convert Anchor Point',
                  ops.updatePath(d, a.id, (it) => ({
                    ...it,
                    paths: it.paths.map((s, si) => (si !== a.sp ? s : { ...s, nodes: s.nodes.map((n, ni) => (ni !== a.n ? n : { ...n, ix: n.x, iy: n.y, ox: n.x, oy: n.y })) })),
                  })),
                );
            },
            cancel: () => setLive(null),
          };
          break;
        }
        case 'type':
          g = textPointerDown(d, p, e);
          break;
        case 'line':
        case 'rectangle':
        case 'rounded-rectangle':
        case 'ellipse':
        case 'polygon':
        case 'star':
          g = startShape(d, p, t);
          break;
        case 'pencil':
        case 'paintbrush':
          g = startFreehand(d, p, t);
          break;
        case 'scissors':
          scissors(d, p);
          return;
        case 'rotate':
          if (!selRef.current.size) return;
          if (e.altKey) {
            originRef.current = p;
            setDialog({ kind: 'transform', which: 'rotate' });
            return;
          }
          g = startRotate(d, p, originRef.current);
          break;
        case 'reflect':
        case 'scale':
        case 'shear':
          if (!selRef.current.size) return;
          if (e.altKey) {
            originRef.current = p;
            setDialog({ kind: 'transform', which: t });
            return;
          }
          g = startToolTransform(d, p, t);
          break;
        case 'gradient':
          g = startGradient(d, p);
          break;
        case 'eyedropper':
          eyedrop(d, p);
          return;
        case 'artboard':
          g = startArtboard(d, p, e);
          break;
        default:
          break;
      }
    }
    if (!g) {
      schedule();
      return;
    }
    gestureRef.current = g;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!docRef.current) return;
    const p = toDoc(e);
    pointerRef.current = p;
    setPointer(p);
    const g = gestureRef.current;
    if (!g && (tool === 'selection' || tool === 'free-transform')) setHover(bboxHandleAt(p));
    if (!g && !spaceDown && ['selection', 'direct', 'group-select', 'free-transform', 'eyedropper', 'scissors', 'add-anchor', 'delete-anchor', 'anchor'].includes(tool)) {
      // Object highlighting: the art under the pointer outlined in its layer's color.
      const d = docRef.current;
      const hit = hitTest(d, p, tool === 'selection' || tool === 'free-transform' ? 'top' : 'leaf');
      const item = hit ? (tool === 'selection' || tool === 'free-transform' ? hit.top : hit.item) : null;
      const prev = overlayExtra.current.hover?.item ?? null;
      if (item !== prev) {
        overlayExtra.current = { ...overlayExtra.current, hover: item && !selRef.current.has(item.id) ? { item, color: findItem(d, item.id)?.layer.color ?? '#4f80ff' } : null };
        schedule();
      }
    }
    if (g) g.move(p, e.nativeEvent);
    else if (penRef.current && tool === 'pen') {
      const d = docRef.current;
      const it = findItem(d, penRef.current.id)?.item;
      if (it?.type === 'path') {
        const sp = it.paths[penRef.current.sp];
        const last = sp.nodes[sp.nodes.length - 1];
        const q = e.shiftKey ? constrain(last, p) : p;
        const preview = new Path2D();
        preview.moveTo(last.x, last.y);
        preview.bezierCurveTo(last.ox, last.oy, q.x, q.y, q.x, q.y);
        overlayExtra.current = { ghost: preview, ghostColor: findItem(d, it.id)?.layer.color ?? '#4f80ff' };
      }
      schedule();
    } else if (settings.rulers) schedule();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g) g.up(toDoc(e), e.nativeEvent);
    if (tool !== 'selection' && tool !== 'direct' && tool !== 'free-transform') say(null);
  };

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!docRef.current) return;
      e.preventDefault();
      const r = viewportRef.current!.getBoundingClientRect();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey || e.altKey) {
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

  // ---- Keyboard ------------------------------------------------------------------------------------

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
    if (e.key === 'Escape') {
      return run(() => {
        if (gestureRef.current) {
          gestureRef.current.cancel?.();
          gestureRef.current = null;
        } else if (penRef.current) finishPen();
        else if (tool === 'artboard') setTool('selection');
        schedule();
      });
    }
    if (e.key === 'Enter' && penRef.current) return run(finishPen);
    if (ctrl) {
      const shift = e.shiftKey;
      const alt = e.altKey;
      const map: Record<string, (() => void) | undefined> = {
        n: alt || shift ? undefined : cmd.newDoc,
        o: shift ? cmd.createOutlines : cmd.open,
        s: shift ? cmd.saveAs : alt ? cmd.saveCopy : cmd.save,
        w: cmd.close,
        z: shift ? cmd.redo : cmd.undo,
        y: cmd.toggleOutline,
        x: cmd.cut,
        c: cmd.copy,
        v: () => cmd.paste(shift ? 'place' : 'normal'),
        f: () => cmd.paste('front'),
        b: shift ? cmd.toggleBoundingBox : () => cmd.paste('back'),
        a: shift ? cmd.deselect : alt ? cmd.selectAllOnArtboard : cmd.selectAll,
        d: shift ? cmd.toggleGrid : cmd.transformAgain,
        g: shift ? cmd.ungroup : cmd.group,
        j: alt ? cmd.average : cmd.join,
        h: shift ? cmd.toggleArtboards : cmd.toggleEdges,
        r: cmd.toggleRulers,
        u: cmd.toggleSmartGuides,
        m: shift ? () => cmd.transformDialog('move') : undefined,
        p: shift ? cmd.place : alt ? cmd.documentSetup : undefined,
        t: () => cmd.togglePanel(alt ? 'paragraph' : 'character'),
        '2': alt ? cmd.unlockAll : cmd.lock,
        '3': alt ? cmd.showAll : cmd.hide,
        '6': cmd.reselect,
        '7': alt ? cmd.releaseClip : cmd.makeClip,
        '8': alt && shift ? cmd.releaseCompound : cmd.makeCompound,
        '*': alt ? cmd.releaseCompound : cmd.makeCompound,
        '0': alt ? cmd.fitAll : cmd.fitArtboardView,
        '1': cmd.actual,
        '=': cmd.zoomIn,
        '+': cmd.zoomIn,
        '-': cmd.zoomOut,
        ']': alt ? () => cmd.nextObject(1) : () => cmd.arrange(shift ? 'front' : 'forward'),
        '[': alt ? () => cmd.nextObject(-1) : () => cmd.arrange(shift ? 'back' : 'backward'),
        '}': () => cmd.arrange('front'),
        '{': () => cmd.arrange('back'),
      };
      if (e.key === 'F9') return run(() => cmd.togglePanel(shift ? 'pathfinder' : 'gradient'));
      if (e.key === 'F10') return run(() => cmd.togglePanel(shift ? 'transparency' : 'stroke'));
      const fn = map[key];
      if (fn) return run(fn);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return run(cmd.clear);
    if (e.key === 'F6') return run(() => cmd.togglePanel('color'));
    if (e.key === 'F7') return run(() => cmd.togglePanel(e.shiftKey ? 'align' : 'layers'));
    if (e.key === 'Tab') return run(() => setHidePanels((h) => !h));
    if (e.key.startsWith('Arrow') && selRef.current.size && docRef.current) {
      return run(() => {
        const n = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
        const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
        const d = docRef.current!;
        if (nodeSelRef.current.size && (tool === 'direct' || tool === 'group-select')) commit('Move', ops.moveNodes(d, nodeSelRef.current, dx, dy), { coalesce: 'nudge-nodes' });
        else if (e.altKey) {
          const r = ops.duplicateItems(d, selRef.current, translate(dx, dy));
          commit('Copy', r.doc, { sel: r.ids });
        } else commit('Move', ops.transformItems(d, selRef.current, translate(dx, dy), { strokes: false }), { coalesce: 'nudge' });
      });
    }
    if (e.altKey) return;
    if (key === 'd') return run(() => applyDefaults());
    if (key === 'x') return run(() => (e.shiftKey ? swapPaints() : setFocusPaint((f) => (f === 'fill' ? 'stroke' : 'fill'))));
    if (e.key === '/') return run(() => applyPaint(focusPaint, NONE));
    if (e.key === ',' || e.key === '<') return run(() => applyKind('color'));
    if (e.key === '.' || e.key === '>') return run(() => applyKind('gradient'));
    if (e.key.length === 1 && toolByKey(e.key === '+' || e.key === '=' ? '+' : key, e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') setSpaceDown(false);
    if (e.key === 'Alt') {
      setAltDown(false);
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

  const applyDefaults = () => {
    const { fill, stroke } = ops.defaultPaints();
    const d = need();
    if (d && selRef.current.size) commit('Default Fill and Stroke', ops.setStroke(ops.setFill(d, selRef.current, fill), selRef.current, stroke));
    setSettings((s) => ({ ...s, fill, stroke }));
  };

  const swapPaints = () => {
    const f = shownFill;
    const s = shownStroke.paint;
    const d = need();
    if (d && selRef.current.size) commit('Swap Fill and Stroke', ops.setStroke(ops.setFill(d, selRef.current, s), selRef.current, { paint: f }));
    setSettings((st) => ({ ...st, fill: s, stroke: { ...st.stroke, paint: f } }));
  };

  const applyKind = (kind: 'color' | 'gradient' | 'none') => {
    const curP = focusPaint === 'fill' ? shownFill : shownStroke.paint;
    if (kind === 'none') return applyPaint(focusPaint, NONE);
    if (kind === 'color') {
      if (curP.type === 'color') return;
      const c = recent.find((r) => r.type === 'color') ?? (focusPaint === 'fill' ? { type: 'color', color: { space: 'rgb', c: [1, 1, 1] } } : BLACK);
      return applyPaint(focusPaint, c as Paint);
    }
    if (curP.type === 'gradient') return;
    const b = selBounds ?? { x: 0, y: 0, w: 100, h: 100 };
    const first = curP.type === 'color' ? curP.color : { space: 'rgb' as const, c: [1, 1, 1] };
    applyPaint(focusPaint, { type: 'gradient', gradient: fitGradient('linear', [{ t: 0, color: first, opacity: 1 }, { t: 1, color: { space: 'rgb', c: [0, 0, 0] }, opacity: 1 }], b) });
    setSettings((s) => ({ ...s, panels: { ...s.panels, gradient: true } }));
  };

  // ---- Text input --------------------------------------------------------------------------------

  const onTextInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const d = need();
    const ed = editingRef.current;
    if (!d || !ed) return;
    const t = findItem(d, ed.id)?.item;
    if (t?.type !== 'text') return;
    const old = textOf(t);
    const now = e.target.value;
    let a = 0;
    while (a < old.length && a < now.length && old[a] === now[a]) a++;
    let b = 0;
    while (b < old.length - a && b < now.length - a && old[old.length - 1 - b] === now[now.length - 1 - b]) b++;
    const next = replaceRange(t, a, old.length - b, now.slice(a, now.length - b));
    commit('Typing', mapItems(d, (it) => (it.id === t.id ? next : undefined)), { coalesce: `type:${t.id}` });
    const s = e.target.selectionStart;
    const en = e.target.selectionEnd;
    const n = { ...ed, start: e.target.selectionDirection === 'backward' ? en : s, end: e.target.selectionDirection === 'backward' ? s : en };
    editingRef.current = n;
    setEditing(n);
    caretOn.current = true;
  };

  const onTextSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ed = editingRef.current;
    if (!ed) return;
    const ta = e.currentTarget;
    const back = ta.selectionDirection === 'backward';
    const n = { ...ed, start: back ? ta.selectionEnd : ta.selectionStart, end: back ? ta.selectionStart : ta.selectionEnd };
    if (n.start === ed.start && n.end === ed.end) return;
    editingRef.current = n;
    setEditing(n);
    caretOn.current = true;
    schedule();
  };

  const onTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      finishEditing();
      setTool('selection');
      return;
    }
    if (ctrl && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) cmd.undo();
      else cmd.redo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey) cmd.saveAs();
      else cmd.save();
      return;
    }
    if (ctrl && e.shiftKey && (e.key === '>' || e.key === '<' || e.key === '.' || e.key === ',')) {
      e.preventDefault();
      applyType({ size: Math.max(1, typeStyle.size + (e.key === '>' || e.key === '.' ? 2 : -2)) });
      return;
    }
    if (ctrl && e.shiftKey && ['l', 'c', 'r', 'j'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      applyType({ align: ({ l: 'left', c: 'center', r: 'right', j: 'justify' } as const)[e.key.toLowerCase() as 'l'] });
    }
  };

  // ---- Menu state ------------------------------------------------------------------------------------

  const menuState: MenuState = {
    hasDoc: !!doc,
    canUndo: !!hist && hist.index > 0,
    canRedo: !!hist && hist.index < hist.entries.length - 1,
    undoLabel: hist && hist.index > 0 ? hist.entries[hist.index].label : '',
    redoLabel: hist && hist.index < hist.entries.length - 1 ? hist.entries[hist.index + 1].label : '',
    hasSelection: sel.size > 0,
    multiple: selItems.length > 1,
    groupSelected: selItems.some((i) => i.type === 'group'),
    clipSelected: selItems.some((i) => i.type === 'group' && i.clip),
    compoundSelected: selItems.some((i) => i.type === 'path' && i.paths.length > 1),
    textSelected: selItems.some((i) => i.type === 'text'),
    pathSelected: selLeaves.some((i) => i.type === 'path'),
    hasClipboard: hasClip,
    canReselect: lastSel.length > 0,
    canTransformAgain: !!lastTransform && sel.size > 0,
    outline,
    edges,
    artboards: showArtboards,
    rulers: settings.rulers,
    boundingBox,
    grid,
    smartGuides: settings.smartGuides,
    mode: doc?.mode ?? 'rgb',
    panels,
  };

  // ---- Rendering ----------------------------------------------------------------------------------------

  const cursor = (() => {
    if (spaceDown || tool === 'hand') return panning ? 'grabbing' : 'grab';
    if (tool === 'zoom') return altDown ? 'zoom-out' : 'zoom-in';
    if (tool === 'type') return 'text';
    if (tool === 'eyedropper') return 'copy';
    if (tool === 'selection' || tool === 'direct' || tool === 'group-select' || tool === 'free-transform') {
      const h = hover;
      if (h === 'rotate') return 'alias';
      if (h === 'n' || h === 's') return 'ns-resize';
      if (h === 'e' || h === 'w') return 'ew-resize';
      if (h === 'nw' || h === 'se') return 'nwse-resize';
      if (h === 'ne' || h === 'sw') return 'nesw-resize';
      return 'default';
    }
    return 'crosshair';
  })();



  const paintTarget: Paint = focusPaint === 'fill' ? shownFill : shownStroke.paint;
  const openColor = (which: 'fill' | 'stroke') => {
    setFocusPaint(which);
    setHidePanels(false);
    setSettings((s) => ({ ...s, panels: { ...s.panels, color: true } }));
  };

  const quick: { label: string; run: () => void }[] = !selItems.length
    ? [
        { label: 'Document Setup', run: cmd.documentSetup },
        { label: 'Edit Artboards', run: () => setTool('artboard') },
      ]
    : [
        ...(selItems.length > 1 ? [{ label: 'Group', run: cmd.group }] : []),
        ...(selLeaves.filter((i) => i.type === 'path').length > 1 ? [{ label: 'Unite', run: () => runPathfinder('unite') }, { label: 'Minus Front', run: () => runPathfinder('minus-front') }] : []),
        ...(menuState.groupSelected ? [{ label: 'Ungroup', run: cmd.ungroup }] : []),
        ...(menuState.textSelected ? [{ label: 'Create Outlines', run: cmd.createOutlines }] : []),
        ...(selItems.length > 1 && selItems[selItems.length - 1].type === 'path' ? [{ label: 'Make Clipping Mask', run: cmd.makeClip }] : []),
        ...(menuState.clipSelected ? [{ label: 'Release Clipping Mask', run: cmd.releaseClip }] : []),
        { label: 'Arrange: Bring to Front', run: () => cmd.arrange('front') },
      ];

  const transformInit: TransformSpec = { kind: 'move', dx: 0, dy: 0, angle: 0, axis: 'vertical', uniform: true, sx: 100, sy: 100, strokes: false };

  const panelList = (
    <aside className={cn('flex w-[288px] shrink-0 flex-col overflow-y-auto border-l border-[#232323] bg-[#383838]', hidePanels && 'hidden')} aria-label="Panels">
      {panels.properties && (
        <Panel title="Properties" open onToggle={() => cmd.togglePanel('properties')}>
          {doc ? (
            <PropertiesPanel
              kind={kindLabel}
              bounds={shownBounds}
              units={doc.units}
              onBounds={setShownBounds}
              rotation={rotateField}
              onRotate={(deg) => {
                setRotateField(0);
                const o = centerOf(doc, sel);
                if (o && deg) transformSel('Rotate', rotateAbout((-deg * Math.PI) / 180, o.x, o.y));
              }}
              fill={shownFill}
              stroke={shownStroke}
              opacity={shownOpacity}
              onEditFill={() => openColor('fill')}
              onEditStroke={() => openColor('stroke')}
              onStrokeWidth={(w) => applyStroke({ width: w }, 'stroke-width')}
              onOpacity={(v) => editSel('Opacity', (d, ids) => ops.setProps(d, ids, { opacity: v }), 'opacity')}
              artboard={doc.artboards[activeBoard] ?? null}
              onArtboard={(b) => commit('Artboard', { ...doc, artboards: doc.artboards.map((a, i) => (i === activeBoard ? { ...a, ...b } : a)) })}
              onUnits={(u) => commit('Units', { ...doc, units: u })}
              quick={quick}
            />
          ) : (
            <p className="p-3 text-xs text-[#9a9a9a]">No document.</p>
          )}
        </Panel>
      )}
      {panels.color && (
        <Panel
          title={`Color — ${focusPaint === 'fill' ? 'Fill' : 'Stroke'}`}
          open
          onToggle={() => cmd.togglePanel('color')}
          actions={
            <Select
              label="Edit fill or stroke"
              value={focusPaint}
              onChange={setFocusPaint}
              options={[
                ['fill', 'Fill'],
                ['stroke', 'Stroke'],
              ]}
              className="h-5"
            />
          }
        >
          {paintTarget.type === 'none' ? (
            <div className="p-3 text-xs text-[#bdbdbd]">
              None.{' '}
              <button type="button" className={cn('underline hover:text-white', FOCUS)} onClick={() => applyKind('color')}>
                Use a color
              </button>
            </div>
          ) : (
            <PaintEditor
              paint={paintTarget}
              mode={doc?.mode ?? 'rgb'}
              bounds={selBounds}
              onChange={(p) => {
                applyPaint(focusPaint, p, `paint:${focusPaint}`);
                pushRecent(p);
              }}
            />
          )}
        </Panel>
      )}
      {panels.swatches && (
        <Panel title="Swatches" open onToggle={() => cmd.togglePanel('swatches')}>
          <SwatchesPanel
            mode={doc?.mode ?? 'rgb'}
            recent={recent}
            used={docColors}
            onPick={(p, g) => {
              if (g) {
                const b = selBounds ?? { x: 0, y: 0, w: 100, h: 100 };
                applyPaint(focusPaint, { type: 'gradient', gradient: fitGradient(g.type, g.stops, b) });
              } else {
                const conv = doc?.mode === 'cmyk' && p.type === 'color' && p.color.space === 'rgb' ? { type: 'color' as const, color: rgbToCmyk(p.color) } : p;
                applyPaint(focusPaint, conv);
                pushRecent(conv);
              }
            }}
          />
        </Panel>
      )}
      {panels.stroke && (
        <Panel title="Stroke" open onToggle={() => cmd.togglePanel('stroke')}>
          <StrokePanel stroke={shownStroke} onChange={(s) => applyStroke(s, `stroke:${Object.keys(s).join()}`)} />
        </Panel>
      )}
      {panels.gradient && (
        <Panel title="Gradient" open onToggle={() => cmd.togglePanel('gradient')}>
          {shownFill.type === 'gradient' ? (
            <PaintEditor paint={shownFill} mode={doc?.mode ?? 'rgb'} bounds={selBounds} onChange={(p) => applyPaint('fill', p, 'gradient')} />
          ) : (
            <div className="p-3 text-xs text-[#bdbdbd]">
              <Button onClick={() => { setFocusPaint('fill'); applyKind('gradient'); }}>Apply Gradient</Button>
            </div>
          )}
        </Panel>
      )}
      {panels.transparency && (
        <Panel title="Transparency" open onToggle={() => cmd.togglePanel('transparency')}>
          <TransparencyPanel
            opacity={shownOpacity}
            blend={selItems[0]?.blend ?? 'normal'}
            onOpacity={(v) => editSel('Opacity', (d, ids) => ops.setProps(d, ids, { opacity: v }), 'opacity')}
            onBlend={(b) => editSel('Blending Mode', (d, ids) => ops.setProps(d, ids, { blend: b }))}
          />
        </Panel>
      )}
      {panels.character && (
        <Panel title="Character" open onToggle={() => cmd.togglePanel('character')}>
          <CharacterPanel value={typeStyle} onChange={applyType} />
        </Panel>
      )}
      {panels.paragraph && (
        <Panel title="Paragraph" open onToggle={() => cmd.togglePanel('paragraph')}>
          <ParagraphPanel align={typeStyle.align} onAlign={(align) => applyType({ align })} />
        </Panel>
      )}
      {panels.align && (
        <Panel title="Align" open onToggle={() => cmd.togglePanel('align')}>
          <AlignPanel
            count={selItems.length}
            alignTo={settings.alignTo}
            onAlignTo={(alignTo) => setSettings((s) => ({ ...s, alignTo }))}
            onAlign={cmd.align}
            onDistribute={(how) => editSel('Distribute', (d, ids) => ops.distribute(d, ids, how))}
          />
        </Panel>
      )}
      {panels.artboards && doc && (
        <Panel title="Artboards" open onToggle={() => cmd.togglePanel('artboards')}>
          <ArtboardsPanel
            artboards={doc.artboards}
            active={activeBoard}
            onActivate={(i) => {
              setActiveBoard(i);
              fitBoard(doc, i);
            }}
            onRename={(i, name) => commit('Rename Artboard', { ...doc, artboards: doc.artboards.map((a, j) => (j === i ? { ...a, name } : a)) })}
            onAdd={() => {
              const last = doc.artboards[doc.artboards.length - 1];
              const ab: Artboard = { id: newId(), name: `Artboard ${doc.artboards.length + 1}`, x: last.x + last.w + 20, y: last.y, w: last.w, h: last.h };
              commit('New Artboard', { ...doc, artboards: [...doc.artboards, ab] });
              setActiveBoard(doc.artboards.length);
            }}
            onDelete={(i) => {
              if (doc.artboards.length < 2) return;
              commit('Delete Artboard', { ...doc, artboards: doc.artboards.filter((_, j) => j !== i) });
              setActiveBoard(Math.max(0, i - 1));
            }}
          />
        </Panel>
      )}
      {panels.pathfinder && (
        <Panel title="Pathfinder" open onToggle={() => cmd.togglePanel('pathfinder')}>
          <PathfinderPanel count={selLeaves.filter((i) => i.type === 'path').length} onMode={runPathfinder} />
        </Panel>
      )}
      {panels.layers && (
        <Panel title="Layers" open onToggle={() => cmd.togglePanel('layers')} grow>
          {doc ? (
            <LayersPanel
              doc={doc}
              selected={sel}
              activeLayer={activeLayer?.id ?? -1}
              onActivateLayer={setActiveLayer}
              onSelectItem={(id, add) => {
                const s = add ? new Set(sel) : new Set<number>();
                if (add && s.has(id)) s.delete(id);
                else s.add(id);
                setSel(s);
                const lay = findItem(doc, id)?.layer;
                if (lay) setActiveLayer(lay.id);
              }}
              onSelectLayer={(id) => {
                const l = doc.layers.find((x) => x.id === id);
                if (l && !l.locked && !l.hidden) setSel(l.children.filter((i) => !i.hidden && !i.locked).map((i) => i.id));
              }}
              onLayerProps={(id, patch) => commit(patch.name !== undefined ? 'Rename Layer' : patch.hidden !== undefined ? 'Hide Layer' : 'Lock Layer', updateLayer(doc, id, (l) => ({ ...l, ...patch })))}
              onItemProps={(id, patch) => commit(patch.name !== undefined ? 'Rename' : patch.hidden !== undefined ? 'Hide' : 'Lock', ops.setProps(doc, new Set([id]), patch))}
              onNewLayer={() => {
                const r = ops.addLayer(doc, activeLayer?.id);
                commit('New Layer', r.doc);
                setActiveLayer(r.layer.id);
              }}
              onDelete={() => {
                if (sel.size) cmd.clear();
                else if (activeLayer && doc.layers.length > 1) commit('Delete Layer', { ...doc, layers: doc.layers.filter((l) => l.id !== activeLayer.id) });
              }}
              onMoveLayer={(id, to) => {
                const layers = doc.layers.filter((l) => l.id !== id);
                const moving = doc.layers.find((l) => l.id === id)!;
                layers.splice(Math.min(to, layers.length), 0, moving);
                commit('Move Layer', { ...doc, layers });
              }}
              onMoveSelectionTo={(lid) => sel.size && commit('Move to Layer', ops.moveToLayer(doc, sel, lid))}
              onClip={() => (menuState.clipSelected ? cmd.releaseClip() : cmd.makeClip())}
            />
          ) : (
            <p className="p-3 text-xs text-[#9a9a9a]">No document.</p>
          )}
        </Panel>
      )}
    </aside>
  );

  const typeControls = textTarget || tool === 'type' ? (
    <span className="flex items-center gap-1.5">
      <span className="text-[#bdbdbd]">Character:</span>
      <input
        aria-label="Font family"
        list="vector-fonts"
        value={typeStyle.family}
        onChange={(e) => applyType({ family: e.target.value })}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(INPUT, 'w-32')}
      />
      <datalist id="vector-fonts">
        {['Arial', 'Helvetica', 'Myriad Pro', 'Minion Pro', 'Times New Roman', 'Courier New', 'Calibri', 'Cambria', 'Inter', 'Georgia'].map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Select
        label="Font style"
        value={typeStyle.style}
        onChange={(style) => applyType({ style })}
        options={[...new Set([typeStyle.style, 'Regular', 'Italic', 'Bold', 'Bold Italic', 'Light', 'Semibold'])].map((s) => [s, s] as [string, string])}
      />
      <NumberField value={typeStyle.size} onChange={(size) => applyType({ size: Math.max(0.1, size) })} min={0.1} max={1296} decimals={1} unit="pt" width="w-16" title="Font Size" />
    </span>
  ) : null;

  const boards = doc?.artboards ?? [];

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="relative flex h-full w-full flex-col bg-[#282828] text-[#e0e0e0] outline-none select-none"
      style={{ fontFamily: '"Inter Variable", "Noto Sans", sans-serif' }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <VectorMenus cmd={cmd} st={menuState} />
      <ControlBar
        kind={kindLabel}
        fill={shownFill}
        stroke={shownStroke.paint}
        strokeWidth={shownStroke.width}
        opacity={shownOpacity}
        bounds={shownBounds}
        units={doc?.units ?? 'pt'}
        linked={linked}
        onLinked={setLinked}
        onStrokeWidth={(w) => applyStroke({ width: w }, 'stroke-width')}
        onOpacity={(v) => editSel('Opacity', (d, ids) => ops.setProps(d, ids, { opacity: v }), 'opacity')}
        onBounds={setShownBounds}
        onEditFill={() => openColor('fill')}
        onEditStroke={() => openColor('stroke')}
        extra={typeControls}
      />
      <div className="flex min-h-0 flex-1">
        <Toolbar
          tool={tool}
          choice={settings.choice}
          onTool={setTool}
          fill={shownFill}
          stroke={shownStroke.paint}
          focus={focusPaint}
          onFocus={(f) => {
            if (f === focusPaint) openColor(f);
            setFocusPaint(f);
          }}
          onSwap={swapPaints}
          onDefault={applyDefaults}
          onApply={applyKind}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {doc && (
            <div className="flex h-7 shrink-0 items-end border-b border-[#1c1c1c] bg-[#2b2b2b] px-1">
              <div className="flex h-6 max-w-full items-center gap-2 truncate rounded-t-[3px] bg-[#383838] px-3 text-[11px] text-[#e6e6e6]" title={docName}>
                {title}
              </div>
            </div>
          )}
          <CanvasMenu cmd={cmd} st={menuState}>
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 touch-none overflow-hidden"
            style={{ cursor: doc ? cursor : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              pointerRef.current = null;
              setPointer(null);
              schedule();
            }}
            onDoubleClick={(e) => {
              const d = docRef.current;
              if (!d) return;
              const p = toDoc(e);
              if (tool === 'hand') cmd.fitArtboardView();
              else if (tool === 'zoom') cmd.actual();
              else if (tool === 'selection' || tool === 'direct') {
                const h = hitTest(d, p, 'leaf');
                if (h?.item.type === 'text') {
                  const t = h.item;
                  const local = apply(invert(t.matrix), p.x, p.y);
                  const i = indexAt(layoutText(t, d.res), local.x, local.y);
                  beginEditing(t.id, i, i);
                } else if (h && h.top.type === 'group' && tool === 'selection') {
                  // Double-clicking a group selects what's inside it.
                  setSel([h.item.id]);
                  setTool('direct');
                }
              }
            }}
          >
            <canvas ref={screenRef} className="absolute inset-0 size-full" aria-label={doc ? `Canvas: ${docName}` : undefined} />
            {editing && editingItem && (
              <textarea
                ref={textareaRef}
                aria-label="Type"
                value={textOf(editingItem)}
                onChange={onTextInput}
                onSelect={onTextSelect}
                onKeyDown={onTextKeyDown}
                onBlur={() => schedule()}
                spellCheck={false}
                wrap="off"
                className="absolute h-6 w-40 resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
              />
            )}
            {!doc && !loading && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <div className="w-full max-w-md space-y-6 text-center">
                  <div className="space-y-2">
                    <h1 className="text-[40px] leading-tight font-semibold tracking-tight text-[#f0f0f0]">Vector Editor</h1>
                    <p className="text-lg text-[#b5b5b5]">Paths, type and artboards. Opens and saves Illustrator files.</p>
                  </div>
                  {error && (
                    <p role="alert" className="rounded-md border border-[#7a2b2b] bg-[#3a2323] px-3 py-2 text-sm text-[#ffb4b4]">
                      {error}
                    </p>
                  )}
                  <div className="flex flex-wrap justify-center gap-3">
                    <button type="button" onClick={() => setDialog({ kind: 'new' })} className={cn('flex h-11 items-center gap-2 rounded-full bg-[#2d8ceb] px-5 text-base font-medium text-white hover:bg-[#4a9df0]', FOCUS)}>
                      <FilePlus className="size-5" />
                      New file
                    </button>
                    <button type="button" onClick={() => void openFile()} className={cn('flex h-11 items-center gap-2 rounded-full border border-[#6a6a6a] px-5 text-base font-medium text-[#e6e6e6] hover:bg-white/5', FOCUS)}>
                      <FolderOpen className="size-5" />
                      Open…
                    </button>
                  </div>
                  <p className="text-sm text-[#8a8a8a]">Ctrl+N new · Ctrl+O open · .ai, .pdf and .svg</p>
                </div>
              </div>
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Opening">
                <div className="h-2/3 w-2/3 animate-pulse rounded-sm bg-[#3a3a3a] motion-reduce:animate-none" />
              </div>
            )}
          </div>
          </CanvasMenu>
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
                <span className="flex items-center gap-0.5">
                  <button type="button" aria-label="Previous artboard" disabled={activeBoard <= 0} onClick={() => { setActiveBoard(activeBoard - 1); fitBoard(doc, activeBoard - 1); }} className={cn('grid size-5 place-items-center rounded-[3px] hover:bg-[#4a4a4a] disabled:opacity-35', FOCUS)}>
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <Select
                    label="Artboard"
                    value={String(activeBoard)}
                    onChange={(v) => {
                      setActiveBoard(Number(v));
                      fitBoard(doc, Number(v));
                    }}
                    options={boards.map((a, i) => [String(i), `${i + 1}`] as [string, string])}
                    className="h-5 text-[11px]"
                  />
                  <button type="button" aria-label="Next artboard" disabled={activeBoard >= boards.length - 1} onClick={() => { setActiveBoard(activeBoard + 1); fitBoard(doc, activeBoard + 1); }} className={cn('grid size-5 place-items-center rounded-[3px] hover:bg-[#4a4a4a] disabled:opacity-35', FOCUS)}>
                    <ChevronRight className="size-3.5" />
                  </button>
                </span>
                <span className="hidden sm:inline">{toolInfo(tool).name.replace(/ Tool$/, '')}</span>
                {pointer && (
                  <span className="hidden tabular-nums md:inline">
                    X: {fmtLen(pointer.x - (boards[activeBoard]?.x ?? 0), doc.units)} Y: {fmtLen(pointer.y - (boards[activeBoard]?.y ?? 0), doc.units)}
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
          onCancel={() => setDialog(null)}
          onCreate={(s) => {
            setDialog(null);
            if (docRef.current) {
              void din.app.open('vector-editor', { width: s.w, height: s.h, units: s.units, mode: s.mode, artboards: s.artboards, name: s.name });
              return;
            }
            startDoc(newDoc(s.w, s.h, s.mode, s.units, s.artboards), s.name || 'Untitled-1', null);
          }}
        />
      )}
      {dialog?.kind === 'transform' && doc && (
        <TransformDialogView
          kind={dialog.which}
          units={doc.units}
          initial={{ ...transformInit, kind: dialog.which, axis: dialog.which === 'shear' ? 'horizontal' : 'vertical' }}
          onPreview={(s) => {
            const m = s ? specMatrix(s) : null;
            if (m) {
              const live = ops.transformItems(doc, sel, m, { strokes: s?.strokes ?? false });
              setLive({ doc: live });
            } else setLive(null);
          }}
          onCancel={() => {
            setDialog(null);
            setLive(null);
          }}
          onOk={(s, copy) => {
            setDialog(null);
            const m = specMatrix(s);
            if (m) transformSel({ move: 'Move', rotate: 'Rotate', reflect: 'Reflect', scale: 'Scale', shear: 'Shear' }[s.kind], m, copy, s.strokes);
          }}
        />
      )}
      {dialog?.kind === 'shape' && doc && (
        <ShapeDialog
          kind={dialog.tool}
          units={doc.units}
          initial={{ w: 100, h: 100, radius: DEFAULT_SHAPE.radius, sides: DEFAULT_SHAPE.sides, points: DEFAULT_SHAPE.points, r1: 50, r2: 25 }}
          onCancel={() => setDialog(null)}
          onOk={(s: ShapeSpec) => {
            const at = dialog.at;
            const k = dialog.tool;
            setDialog(null);
            const geo =
              k === 'ellipse'
                ? ops.ellipsePath(at.x + s.w / 2, at.y + s.h / 2, s.w / 2, s.h / 2)
                : k === 'polygon'
                  ? ops.polygonPath(at.x, at.y, s.r1, s.sides)
                  : k === 'star'
                    ? ops.starPath(at.x, at.y, s.r1, s.r2, s.points)
                    : ops.rectPath(at.x, at.y, s.w, s.h, k === 'rounded-rectangle' ? s.radius : 0);
            addToLayer([newPath([geo])], kindName(k));
          }}
        />
      )}
      {dialog?.kind === 'offset' && doc && (
        <NumberDialog
          title="Offset Path"
          label="Offset:"
          value={10}
          units={doc.units}
          onCancel={() => setDialog(null)}
          onOk={(v) => {
            setDialog(null);
            const d = need();
            if (!d) return;
            const items = ops.leaves(ops.selectedItems(d, sel)).filter((i): i is PathItem => i.type === 'path');
            const copies = items.map((it) => {
              const b = itemBounds(it, d.res);
              const sx = b.w ? (b.w + v * 2) / b.w : 1;
              const sy = b.h ? (b.h + v * 2) / b.h : 1;
              return transformItem({ ...it, id: newId() }, scaleAbout(sx, sy, b.x + b.w / 2, b.y + b.h / 2), { strokes: false });
            });
            const ids = new Set(items.map((i) => i.id));
            const next = mapItems(d, (it) => (ids.has(it.id) ? [copies.find((c, i) => items[i].id === it.id) as Item, it].filter(Boolean) : undefined));
            commit('Offset Path', next, { sel: copies.map((c) => c.id) });
            say('Offset Path scales each shape outward from its center; corners don’t stay exactly parallel.');
          }}
        />
      )}
      {dialog?.kind === 'average' && (
        <AverageDialog
          onCancel={() => setDialog(null)}
          onOk={(a) => {
            setDialog(null);
            const d = need();
            if (d) commit('Average', ops.averageNodes(d, nodeSel, a));
          }}
        />
      )}
      {dialog?.kind === 'export' && doc && (
        <ExportDialog
          artboards={doc.artboards.map((a) => a.name)}
          onCancel={() => setDialog(null)}
          onOk={(o) => {
            setDialog(null);
            void exportAs(o);
          }}
        />
      )}
      {dialog?.kind === 'setup' && doc && (
        <DocumentSetupDialog
          units={doc.units}
          onCancel={() => setDialog(null)}
          onOk={(u) => {
            setDialog(null);
            if (u !== doc.units) commit('Document Setup', { ...doc, units: u });
          }}
        />
      )}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'saveNote' && (
        <Dialog title="Vector Editor" onCancel={() => setDialog(null)} onOk={() => setDialog(null)}>
          <p className="text-sm text-[#e6e6e6]">{dialog.message}</p>
        </Dialog>
      )}
      {dialog?.kind === 'unsaved' && (
        <Dialog
          title="Vector Editor"
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
          <p className="text-sm text-[#e6e6e6]">Save changes to the Adobe Illustrator document “{docName}” before closing?</p>
          <p className="mt-1 text-xs text-[#a0a0a0]">If you don’t, your changes will be lost.</p>
        </Dialog>
      )}
    </div>
  );
}

function centerOf(d: Doc, s: Set<number>): Point | null {
  const b = ops.selectionBounds(d, s);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
}

function isSmooth(n: Node): boolean {
  const ai = Math.atan2(n.y - n.iy, n.x - n.ix);
  const ao = Math.atan2(n.oy - n.y, n.ox - n.x);
  const hasIn = n.ix !== n.x || n.iy !== n.y;
  const hasOut = n.ox !== n.x || n.oy !== n.y;
  return hasIn && hasOut && Math.abs(Math.atan2(Math.sin(ai - ao), Math.cos(ai - ao))) < 0.05;
}

function kindName(t: ToolId): string {
  return t === 'line' ? 'Line' : t === 'ellipse' ? 'Ellipse' : t === 'polygon' ? 'Polygon' : t === 'star' ? 'Star' : t === 'rounded-rectangle' ? 'Rounded Rectangle' : 'Rectangle';
}


