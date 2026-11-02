import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, parentPath } from '@/lib/fs';
import { typesFromFilters, type Din } from '@/sdk';
import { useCloseGuard, useDin, useWindowAccent, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { windowLaunch } from '@/shared/launch';
import { AppAssistantHost } from '@/shared/assistant/appHost';
import '@fontsource/arimo/400.css';
import '@fontsource/arimo/700.css';
import '@fontsource/arimo/400-italic.css';
import '@fontsource/tinos/400.css';
import '@fontsource/cousine/400.css';
import '@fontsource/carlito/400.css';
import '@fontsource/caladea/400.css';
import {
  BYLAYER,
  LW_BYLAYER,
  findLayer,
  julian,
  newDrawing,
  type Dimension,
  type Drawing,
  type Entity,
  type Layer,
  type Vec,
} from './cad/model';
import { angleOf, boxValid, dist, emptyBox, grow, rotation, sub, transformEntity, translation, type Box } from './cad/geom';
import { GeomCache, geomCrosses, geomDistance, layerVisible, type Prim } from './cad/prims';
import {
  DARK,
  LIGHT,
  drawCrosshair,
  drawGrid,
  drawGrip,
  drawPrims,
  drawSelectionWindow,
  drawSnapMarker,
  drawUcsIcon,
  screenLine,
  toScreen,
  toWorld,
  tooltip,
  type Size,
  type View,
} from './cad/render';
import { findSnap, OSNAP, SNAP_LABEL, type SnapHit } from './cad/snap';
import { Cancelled, parseInput, promptText, type Answer, type Keyword, type Req, kwKey } from './cad/engine';
import { ALIASES, COMMANDS, editAnnotation, escapeMText, fmt, resolveCommand, type HatchSettings, type Host, type MTextEditRequest, type TextEditRequest } from './cad/commands';
import { grips as gripsOf, type Grip } from './cad/edit';
import { dimGeometry } from './cad/dim';
import { writeDwg } from './cad/dwg/write';
import { convertDwg, dwgVersion, readDwgBytes, versionName, type ReadResult } from './cad/dwg/read';
import { isDxf, readDxf } from './cad/dxf/read';
import { writeDxf } from './cad/dxf/write';
import { CAP, ensureFonts, fontFamily } from './cad/text';
import { findTextStyle } from './cad/model';
import { Ribbon, type RibbonTabId } from './cad/ui/ribbon';
import { LayerManager, PropertiesPalette, type LayerIsolation } from './cad/ui/palettes';
import { DimStyleDialog, DraftingDialog, InsertDialog, TextStyleDialog, UnitsDialog, type DraftSettings } from './cad/ui/dialogs';
import { DropdownMenu as Menu } from 'radix-ui';
import { Button, Dialog, MenuContent, MenuItem, MenuSeparator } from './cad/ui/chrome';
import { FOCUS, keepFocus } from './cad/ui/style';
import { Icons } from './cad/ui/icons';
import { AssistantPalette } from './cad/ui/assistant';
import { useCadAssistant } from './cad/useCadAssistant';
import { unitsName } from './cad/assistant';
import { canWrite, fileTypes, pickFiles, pickSaveFile, windowLaunchFile, writeFile } from '@/shared/fileHandles';
import { forgetHandle, loadHandle, storeHandle } from '@/shared/handleStore';

const SETTINGS_KEY = 'din:cad:settings';
const RECENT_KEY = 'din:cad:recent';
const CLIP_MARK = 'din-cad-clipboard:';
const MAX_BYTES = 512 * 1024 * 1024;

/** What CAD saves: DWG, or DXF for programs that take nothing else. */
type Format = 'dwg' | 'dxf';
const SAVE_FILTERS = [
  { name: 'AutoCAD 2000 Drawing (*.dwg)', patterns: ['*.dwg'], mimeTypes: ['image/vnd.dwg'] },
  { name: 'AutoCAD 2004 DXF (*.dxf)', patterns: ['*.dxf'], mimeTypes: ['image/vnd.dxf'] },
];
/** The version each format is saved as, as `versionRef` holds it. */
const SAVED_AS: Record<Format, { version: string; name: string }> = {
  dwg: { version: 'AC1015', name: 'an AutoCAD 2000 drawing' },
  dxf: { version: 'DXF AC1018', name: 'an AutoCAD 2004 DXF' },
};
const formatOf = (p: string): Format | null => {
  const m = /\.(dwg|dxf)$/i.exec(p);
  return m ? (m[1].toLowerCase() as Format) : null;
};
const MAX_UNDO = 200;
/** Room the floating command line takes at the bottom of the drawing area. */
const CMDLINE_SPACE = 100;

interface Settings extends DraftSettings {
  lwt: boolean;
  dark: boolean;
  properties: boolean;
  assistant: boolean;
  ribbonCollapsed: boolean;
  tab: RibbonTabId;
}

const DEFAULTS: Settings = {
  osmode: OSNAP.end | OSNAP.mid | OSNAP.cen | OSNAP.int | OSNAP.qua | OSNAP.nod | OSNAP.ext,
  osnap: true,
  grid: true,
  snap: false,
  snapUnit: 0.5,
  gridUnit: 0.5,
  polar: true,
  polarAngle: 90,
  ortho: false,
  dyn: true,
  lwt: false,
  dark: true,
  properties: false,
  assistant: false,
  ribbonCollapsed: false,
  tab: 'home',
};

function readSettings(): Settings {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!v || typeof v !== 'object') return DEFAULTS;
    const s = { ...DEFAULTS, ...(v as Partial<Settings>) };
    if (s.tab === 'hatch') s.tab = 'home';
    return s;
  } catch {
    return DEFAULTS;
  }
}

/** A drawing opened or saved lately: its grant kept with a persist() token, and its path to show. */
interface Recent {
  token: string;
  key: string;
  path: string;
  time: number;
}

const RECENT_MAX = 12;

function readRecent(): Recent[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((r): r is Recent => typeof r?.token === 'string' && typeof r?.key === 'string' && typeof r?.path === 'string' && typeof r?.time === 'number')
      : [];
  } catch {
    return [];
  }
}

function writeRecent(din: Din, list: Recent[], keep: Recent[]): Recent[] {
  // Tokens of entries that left the list are let go.
  const kept = new Set(keep.map((r) => r.token));
  for (const r of list) if (!kept.has(r.token)) forgetHandle(r.token);
  localStorage.setItem(RECENT_KEY, JSON.stringify(keep));
  return keep;
}

async function addRecent(din: Din, file: FileSystemFileHandle): Promise<Recent[]> {
  const list = readRecent();
  const path = din.files.path(file);
  const same = list.find((r) => r.path === path);
  const token = same?.token ?? (await storeHandle(file));
  const entry = { token, key: path, path, time: Date.now() };
  return writeRecent(din, list, [entry, ...list.filter((r) => r.path !== path)].slice(0, RECENT_MAX));
}

function removeRecent(din: Din, token: string): Recent[] {
  const list = readRecent();
  return writeRecent(din, list, list.filter((r) => r.token !== token));
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

interface Entry {
  d: Drawing;
  label: string;
  run: number;
}

interface Pending {
  req: Req;
  resolve: (a: Answer) => void;
  reject: (e: Error) => void;
}

interface TextEdit {
  id: number;
  kind: 'text' | 'mtext';
  req: TextEditRequest | MTextEditRequest;
  resolve: (s: string | null) => void;
}

/** Selection being gathered for a "Select objects:" prompt, or implied selection's window. */
interface WindowSel {
  start: Vec;
  /** Screen position where it started. */
  sx: number;
  sy: number;
  dragged: boolean;
}

type DialogState = { kind: 'units' } | { kind: 'drafting' } | { kind: 'insert'; resolve: (r: { name: string; scale: number; rotation: number } | null) => void } | { kind: 'textstyle' } | { kind: 'dimstyle' } | { kind: 'about' } | { kind: 'unsaved'; then: () => void } | { kind: 'dropped'; text: string } | null;

let untitled = 0;
let textEditSeq = 0;

/**
 * CAD - 2D drafting for people who know AutoCAD: the ribbon, command line,
 * aliases, object snaps, grips and dialogs where AutoCAD keeps them. Opens
 * DWG files from R13 to AutoCAD 2018 and DXF files of any version, and saves
 * AutoCAD 2000 DWGs or AutoCAD 2004 DXFs.
 *
 * Opened with a file (from Files), it opens that drawing; launch params
 * `{ new?: 'imperial' | 'metric' }` start one. Its assistant palette needs
 * the `assistant` and `fs` permissions (see cad/useCadAssistant.ts); the
 * drawings themselves are files it's handed.
 */
export function CAD() {
  return (
    <AppAssistantHost>
      <CADWindow />
    </AppAssistantHost>
  );
}

function CADWindow() {
  const din = useDin();
  const params = windowLaunch().params;
  const launchFile = windowLaunchFile();

  const [settings, setSettings] = useState(readSettings);
  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), [settings]);
  const set = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const theme = settings.dark ? DARK : LIGHT;

  const [hist, setHist] = useState<{ entries: Entry[]; index: number } | null>(() => {
    if (launchFile) return null;
    const kind = params.new === 'metric' ? 'metric' : params.new === 'imperial' ? 'imperial' : null;
    if (!kind) return null;
    return { entries: [{ d: newDrawing(kind === 'metric'), label: 'New', run: 0 }], index: 0 };
  });
  const doc = hist ? hist.entries[hist.index].d : null;
  const [savedEntry, setSavedEntry] = useState<Entry | null>(() => hist?.entries[0] ?? null);
  const dirty = !!hist && hist.entries[hist.index] !== savedEntry;
  const [file, setFile] = useState<FileSystemFileHandle | null>(null);
  const path = file ? din.files.path(file) : null;
  const [docName, setDocName] = useState(() => (hist ? `Drawing${++untitled}.dwg` : ''));
  const [loading, setLoading] = useState(launchFile !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(readRecent);
  const [selection, setSelectionState] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Req | null>(null);
  const [history, setHistoryLines] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const [suggest, setSuggest] = useState(0);
  const [cursorInfo, setCursorInfo] = useState<Vec | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [layersPos, setLayersPos] = useState<Vec | null>(null);
  const [layerIso, setLayerIso] = useState<LayerIsolation>(null);
  const [hatchActive, setHatchActive] = useState(false);
  const [hatch, setHatch] = useState<HatchSettings>({ pattern: 'ANSI31', scale: 1, angle: 0 });
  const [current, setCurrent] = useState({ color: BYLAYER, linetype: 'ByLayer', lineweight: LW_BYLAYER });
  const [menuAt, setMenuAt] = useState<Vec | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);
  /** Counts drawings opened in this window, so the assistant starts over with each. */
  const [docSerial, setDocSerial] = useState(0);

  const title = doc ? `${dirty ? '• ' : ''}${docName}` : 'CAD';
  const noDoc = doc === null;
  useWindowTitle(title);

  // ---- Refs the canvas and the commands read ----------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histRef = useRef(hist);
  const docRef = useRef<Drawing | null>(doc);
  const selRef = useRef(selection);
  const viewRef = useRef<View>({ cx: 6, cy: 4.5, scale: 60 });
  const viewStack = useRef<View[]>([]);
  const sizeRef = useRef<Size>({ w: 0, h: 0, dpr: 1 });
  const cache = useMemo(() => new GeomCache(), []);
  const settingsRef = useRef(settings);
  const pendingRef = useRef<Pending | null>(null);
  const runRef = useRef(0);
  const runningRef = useRef<string | null>(null);
  const lastCmd = useRef<string | null>(null);
  const macro = useRef<string[]>([]);
  const lastPoint = useRef<Vec | null>(null);
  const tempRef = useRef<Entity[]>([]);
  const cursorRef = useRef<{ screen: Vec; world: Vec; p: Vec; snap: SnapHit | null; polar: { angle: number; dist: number; base: Vec } | null } | null>(null);
  const hoverRef = useRef<Entity | null>(null);
  const hoverDoc = useRef<Drawing | null>(null);
  const hoverGrip = useRef<{ e: Entity; g: Grip } | null>(null);
  const winRef = useRef<WindowSel | null>(null);
  const pickBuf = useRef<Set<number>>(new Set());
  const panRef = useRef<{ x: number; y: number; v: View } | null>(null);
  const panMode = useRef<null | (() => void)>(null);
  const rafBase = useRef(0);
  const rafOver = useRef(0);
  const clipboard = useRef<{ list: Entity[]; base: Vec | null } | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const hatchRef = useRef(hatch);
  const currentRef = useRef(current);
  const cmdHistory = useRef<string[]>([]);
  const cmdHistIdx = useRef(-1);
  const fitPending = useRef(true);
  const loadSeq = useRef(0);
  const dropped = useRef<Record<string, number>>({});
  const versionRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    histRef.current = hist;
    docRef.current = hist ? hist.entries[hist.index].d : null;
    selRef.current = selection;
    settingsRef.current = settings;
    textEditRef.current = textEdit;
    hatchRef.current = hatch;
    currentRef.current = current;
  });

  useEffect(() => {
    void ensureFonts().then(() => setFontsReady(true));
  }, []);

  // ---- Drawing ----------------------------------------------------------------------------------

  const visibleEntities = useCallback((d: Drawing): Entity[] => {
    const v = viewRef.current;
    const s = sizeRef.current;
    const tl = toWorld(v, s, { x: 0, y: 0 });
    const br = toWorld(v, s, { x: s.w, y: s.h });
    cache.sync(d);
    const hidden = new Set(d.layers.filter((l) => !layerVisible(l)).map((l) => l.name.toUpperCase()));
    return d.entities.filter((e) => {
      if (hidden.has(e.layer.toUpperCase())) return false;
      const b = cache.get(e, d).box;
      return b.max.x >= tl.x && b.min.x <= br.x && b.max.y >= br.y && b.min.y <= tl.y;
    });
  }, [cache]);

  const renderBase = useCallback(() => {
    rafBase.current = 0;
    const c = baseRef.current;
    const d = docRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const s = sizeRef.current;
    const st = settingsRef.current;
    const t = st.dark ? DARK : LIGHT;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    if (!d) return;
    const v = viewRef.current;
    if (st.grid) drawGrid(ctx, v, s, t, st.gridUnit, 5);
    const list = visibleEntities(d);
    const prims: Prim[] = [];
    for (const e of list) for (const p of cache.get(e, d).prims) prims.push(p);
    drawPrims(ctx, prims, v, s, { lineweights: st.lwt || d.header.lwdisplay, theme: t });
    drawUcsIcon(ctx, s, t);
  }, [cache, visibleEntities]);

  const renderOverlay = useCallback(() => {
    rafOver.current = 0;
    const c = overRef.current;
    const d = docRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!d) return;
    const s = sizeRef.current;
    const v = viewRef.current;
    const st = settingsRef.current;
    const t = st.dark ? DARK : LIGHT;
    const opts = { lineweights: st.lwt, theme: t };
    const pend = pendingRef.current;
    cache.sync(d);
    // Selected objects, and what's under the cursor.
    const sel = selRef.current;
    const buf = pickBuf.current;
    const hot = new Set([...sel, ...buf]);
    if (hot.size) {
      const list = d.entities.filter((e) => hot.has(e.id));
      const prims = list.flatMap((e) => cache.get(e, d).prims);
      drawPrims(ctx, prims, v, s, opts, { color: t.dark ? 'rgba(90, 170, 255, 0.55)' : 'rgba(20, 110, 220, 0.5)', width: 4 });
      drawPrims(ctx, prims, v, s, opts, { color: t.dark ? '#d8ecff' : '#0b4f9c', width: 1, dash: [6, 4] });
    }
    // Until the cursor moves again, an edit may have replaced what was under it.
    const hover = hoverDoc.current === d ? hoverRef.current : null;
    if (hover && !hot.has(hover.id)) {
      const g = cache.get(hover, d);
      drawPrims(ctx, g.prims, v, s, opts, { color: t.dark ? 'rgba(140, 200, 255, 0.85)' : 'rgba(30, 120, 220, 0.85)', width: 2.5 });
    }
    // Temporary and preview geometry from the running command.
    const cur = cursorRef.current;
    const ghosts: Entity[] = [...tempRef.current];
    if (pend?.req.kind === 'point' && pend.req.preview && cur) {
      try {
        ghosts.push(...pend.req.preview(cur.p));
      } catch {
        // A preview that can't be drawn for this point just isn't.
      }
    }
    if (ghosts.length) {
      const g = ghosts.flatMap((e) => cache.get(e, d).prims);
      drawPrims(ctx, g, v, s, opts);
    }
    if (pend?.req.kind === 'point' && cur) {
      const base = pend.req.base;
      if (base && pend.req.rubber !== false && !pend.req.preview) screenLine(ctx, s, toScreen(v, s, base), toScreen(v, s, cur.p), t.dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)', [6, 4]);
      if (base && pend.req.box) {
        const a = toScreen(v, s, base);
        const b = toScreen(v, s, cur.p);
        drawSelectionWindow(ctx, s, a, b, false);
      }
    }
    // Grips.
    if (!pend && sel.size && sel.size <= 200) {
      for (const e of d.entities) {
        if (!sel.has(e.id)) continue;
        for (const g of gripsOf(e)) {
          const sp = toScreen(v, s, g.p);
          const isHover = hoverGrip.current?.e.id === e.id && dist(hoverGrip.current.g.p, g.p) < 1e-12;
          drawGrip(ctx, s, sp, isHover ? 'hover' : 'cold');
        }
      }
    }
    // Selection window.
    const w = winRef.current;
    if (w && cur) {
      const a = toScreen(v, s, w.start);
      drawSelectionWindow(ctx, s, a, cur.screen, cur.screen.x < a.x);
    }
    if (cur) {
      if (cur.polar) {
        const b = toScreen(v, s, cur.polar.base);
        const far = { x: b.x + Math.cos(cur.polar.angle) * 4000, y: b.y - Math.sin(cur.polar.angle) * 4000 };
        screenLine(ctx, s, b, far, 'rgba(110, 220, 140, 0.8)', [3, 4]);
      }
      const sp = toScreen(v, s, cur.p);
      if (cur.snap) drawSnapMarker(ctx, s, toScreen(v, s, cur.snap.p), cur.snap.kind, SNAP_LABEL[cur.snap.kind]);
      else if (cur.polar) tooltip(ctx, s, { x: sp.x + 16, y: sp.y + 20 }, `Polar: ${fmt(cur.polar.dist)} < ${Math.round(((cur.polar.angle * 180) / Math.PI + 360) % 360)}°`);
      const picking = !pend || pend.req.kind === 'select' || pend.req.kind === 'pick';
      if (!panMode.current && !textEditRef.current) drawCrosshair(ctx, s, cur.screen, t, picking, pend?.req.kind === 'pick' || pend?.req.kind === 'select' ? 0 : 0.05);
      // Dynamic input: the prompt beside the cursor, with what's being typed.
      if (st.dyn && pend && !cur.snap && !panMode.current && !textEditRef.current) {
        const typed = inputRef.current?.value ?? '';
        const base = pend.req.kind === 'point' ? pend.req.base : null;
        let label = promptText(pend.req).replace(/:$/, '');
        if (label.length > 60) label = `${label.slice(0, 57)}…`;
        if (typed) label = `${label}: ${typed}`;
        else if (base && !cur.polar) label = `${fmt(dist(base, cur.p))} < ${Math.round(((angleOf(sub(cur.p, base)) * 180) / Math.PI + 360) % 360)}°`;
        if (!cur.polar || typed) tooltip(ctx, s, { x: cur.screen.x + 18, y: cur.screen.y + 18 }, label);
      }
    }
  }, [cache]);

  const scheduleBase = useCallback(() => {
    if (!rafBase.current) rafBase.current = requestAnimationFrame(renderBase);
    if (!rafOver.current) rafOver.current = requestAnimationFrame(renderOverlay);
  }, [renderBase, renderOverlay]);
  const scheduleOver = useCallback(() => {
    if (!rafOver.current) rafOver.current = requestAnimationFrame(renderOverlay);
  }, [renderOverlay]);
  useEffect(
    () => () => {
      cancelAnimationFrame(rafBase.current);
      cancelAnimationFrame(rafOver.current);
    },
    [],
  );

  useLayoutEffect(() => scheduleBase(), [doc, settings.grid, settings.dark, settings.lwt, settings.gridUnit, fontsReady, scheduleBase]);
  useLayoutEffect(() => scheduleOver(), [selection, prompt, scheduleOver]);

  // ---- View -------------------------------------------------------------------------------------

  const setView = useCallback(
    (v: View, remember = false) => {
      if (remember) {
        viewStack.current.push(viewRef.current);
        if (viewStack.current.length > 50) viewStack.current.shift();
      }
      viewRef.current = v;
      setViewTick((t) => t + 1);
      scheduleBase();
    },
    [scheduleBase],
  );

  const extents = useCallback(
    (d: Drawing): Box | null => {
      cache.sync(d);
      const b = emptyBox();
      for (const e of d.entities) {
        if (e.type === 'xline' || e.type === 'ray') continue;
        if (!layerVisible(findLayer(d, e.layer))) continue;
        const g = cache.get(e, d).box;
        grow(b, g.min);
        grow(b, g.max);
      }
      return boxValid(b) ? b : null;
    },
    [cache],
  );

  const zoomBox = useCallback(
    (a: Vec, b: Vec, remember = true) => {
      const s = sizeRef.current;
      if (!s.w || !s.h) return;
      const w = Math.max(Math.abs(b.x - a.x), 1e-9);
      const h = Math.max(Math.abs(b.y - a.y), 1e-9);
      // Fit above the floating command line, not under it.
      const below = s.h > 320 ? CMDLINE_SPACE : 0;
      const scale = Math.max(1e-9, Math.min(1e9, Math.min((s.w * 0.92) / w, ((s.h - below) * 0.92) / h)));
      setView({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 - below / 2 / scale, scale }, remember);
    },
    [setView],
  );

  const zoomExtents = useCallback(
    (remember = true) => {
      const d = docRef.current;
      if (!d) return;
      const b = extents(d);
      if (b) zoomBox(b.min, b.max, remember);
      else zoomBox(d.header.limmin, d.header.limmax, remember);
    },
    [extents, zoomBox],
  );

  const zoomAt = useCallback(
    (factor: number, sx: number, sy: number) => {
      const v = viewRef.current;
      const s = sizeRef.current;
      const w = toWorld(v, s, { x: sx, y: sy });
      const scale = Math.max(1e-9, Math.min(1e9, v.scale * factor));
      // Keep the point under the cursor where it is.
      setView({ cx: w.x - (sx - s.w / 2) / scale, cy: w.y + (sy - s.h / 2) / scale, scale });
    },
    [setView],
  );

  // The viewport's size.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = { width: el.offsetWidth, height: el.offsetHeight };
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: r.width, h: r.height, dpr };
      for (const c of [baseRef.current, overRef.current]) {
        if (!c) continue;
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
      }
      if (fitPending.current && docRef.current && r.width > 0) {
        fitPending.current = false;
        const d = docRef.current;
        if (d.view) setView({ cx: d.view.center.x, cy: d.view.center.y, scale: r.height / d.view.height });
        else zoomExtents(false);
      }
      scheduleBase();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleBase, setView, zoomExtents, noDoc]);

  // ---- History ----------------------------------------------------------------------------------

  const commit = useCallback(
    (label: string, d: Drawing, turn?: number) => {
      docRef.current = d;
      const run = turn ?? runRef.current;
      setHist((h) => {
        if (!h) return { entries: [{ d, label, run }], index: 0 };
        const top = h.entries[h.index];
        const entries = h.entries.slice(0, h.index + 1);
        // One command, one undo step; the same for each of the assistant's turns.
        if ((turn !== undefined || runningRef.current) && top.run === run && h.index > 0) entries[entries.length - 1] = { d, label: top.label, run };
        else entries.push({ d, label, run });
        while (entries.length > MAX_UNDO) entries.shift();
        const next = { entries, index: entries.length - 1 };
        histRef.current = next;
        return next;
      });
      // Drop selected ids that are gone.
      const ids = new Set(d.entities.map((e) => e.id));
      setSelectionState((s) => {
        const n = new Set([...s].filter((id) => ids.has(id)));
        selRef.current = n;
        return n.size === s.size ? s : n;
      });
      scheduleBase();
    },
    [scheduleBase],
  );

  const say = useCallback((msg: string) => {
    if (!msg) return;
    setHistoryLines((h) => [...h.slice(-400), msg]);
  }, []);

  const undo = useCallback(
    (n = 1) => {
      const h = histRef.current;
      if (!h) return;
      if (h.index === 0) return say('Everything has been undone');
      const index = Math.max(0, h.index - n);
      for (let i = h.index; i > index; i--) say(`Undo: ${h.entries[i].label}`);
      const next = { ...h, index };
      histRef.current = next;
      docRef.current = next.entries[index].d;
      setHist(next);
      setSelectionState(new Set());
      scheduleBase();
    },
    [say, scheduleBase],
  );

  const redo = useCallback(() => {
    const h = histRef.current;
    if (!h || h.index >= h.entries.length - 1) return say('Nothing to redo');
    const next = { ...h, index: h.index + 1 };
    say(`Redo: ${h.entries[next.index].label}`);
    histRef.current = next;
    docRef.current = next.entries[next.index].d;
    setHist(next);
    scheduleBase();
  }, [say, scheduleBase]);

  const setSelection = useCallback(
    (ids: Iterable<number>) => {
      const n = new Set(ids);
      selRef.current = n;
      setSelectionState(n);
      scheduleOver();
    },
    [scheduleOver],
  );

  // ---- Files ------------------------------------------------------------------------------------

  const startDoc = useCallback(
    (d: Drawing, name: string, f: FileSystemFileHandle | null) => {
      const entry: Entry = { d, label: f ? 'Open' : 'New', run: 0 };
      const h = { entries: [entry], index: 0 };
      histRef.current = h;
      docRef.current = d;
      setHist(h);
      setSavedEntry(entry);
      setFile(f);
      setDocName(name);
      setSelection([]);
      setLayerIso(null);
      setError(null);
      setHistoryLines([]);
      setDocSerial((n) => n + 1);
      fitPending.current = true;
      requestAnimationFrame(() => {
        const s = sizeRef.current;
        if (s.w) {
          fitPending.current = false;
          if (d.view) setView({ cx: d.view.center.x, cy: d.view.center.y, scale: s.h / d.view.height });
          else zoomExtents(false);
        }
      });
    },
    [setSelection, setView, zoomExtents],
  );

  const load = useCallback(
    (f: FileSystemFileHandle) => {
      const seq = ++loadSeq.current;
      (async () => {
        try {
          const blob = await f.getFile();
          if (blob.size > MAX_BYTES) throw new Error(`It’s too big to open (${formatBytes(blob.size)}).`);
          const data = new Uint8Array(await blob.arrayBuffer());
          const version = dwgVersion(data);
          const dxf = !version && isDxf(data);
          if (!version && !dxf) throw new Error('It isn’t a DWG or DXF drawing.');
          let res: ReadResult;
          if (version) {
            if (version < 'AC1012') throw new Error(`It’s from ${versionName(version)} or earlier, older than CAD can read (R13 and later).`);
            const db = await readDwgBytes(data);
            if (seq !== loadSeq.current) return;
            res = convertDwg(db, version);
          } else {
            res = readDxf(data);
          }
          versionRef.current = dxf ? `DXF ${res.version}` : res.version;
          dropped.current = res.dropped;
          startDoc(res.drawing, f.name, f);
          void addRecent(din, f).then(setRecent);
          const n = Object.values(res.dropped).reduce((a, b) => a + b, 0);
          setStatus(`Opened ${versionName(res.version)} ${dxf ? 'DXF' : 'drawing'}`);
          if (n) {
            const what = Object.entries(res.dropped)
              .map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`)
              .join(', ');
            setDialog({ kind: 'dropped', text: what });
          }
        } catch (err) {
          if (seq !== loadSeq.current) return;
          setError(`Couldn’t open ${f.name}. ${err instanceof Error ? err.message : cleanFsError(err)}`);
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      })();
    },
    [din, startDoc],
  );

  const openHandle = useCallback(
    (f: FileSystemFileHandle) => {
      setLoading(true);
      setError(null);
      load(f);
    },
    [load],
  );
  /** A recent drawing, by the grant it was kept with; one that's gone leaves the list. */
  const openRecent = useCallback(
    (r: Recent) =>
      void loadHandle(r.token).then(
        (handle) => {
          if (handle?.kind === 'file') {
            openHandle(handle as FileSystemFileHandle);
            return;
          }
          setRecent(removeRecent(din, r.token));
          setError(`${basename(r.path)} isn’t there anymore.`);
        },
        (err: unknown) => setError(`Couldn’t open ${basename(r.path)}. ${cleanFsError(err)}`),
      ),
    [din, openHandle],
  );
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || !launchFile) return;
    launched.current = true;
    load(launchFile);
  }, [launchFile, load]);

  const encode = useCallback(
    (d: Drawing, format: Format): Uint8Array => {
      const ext = extents(d);
      const v = viewRef.current;
      const s = sizeRef.current;
      const withView: Drawing = s.h ? { ...d, view: { center: { x: v.cx, y: v.cy }, height: s.h / v.scale } } : d;
      const opts = { extents: ext, dimBlock: (dim: Dimension) => dimGeometry(dim, d), now: julian(Date.now()) };
      return format === 'dxf' ? writeDxf(withView, opts) : writeDwg(withView, opts);
    },
    [extents],
  );

  const writeTo = useCallback(
    async (f: FileSystemFileHandle): Promise<boolean> => {
      const d = docRef.current;
      const h = histRef.current;
      if (!d || !h) return false;
      setBusy(true);
      setStatus('Saving…');
      try {
        await new Promise((r) => setTimeout(r, 16));
        const format = formatOf(f.name) ?? 'dwg';
        const bytes = encode(d, format);
        await writeFile(f, bytes);
        setSavedEntry(h.entries[h.index]);
        setFile(f);
        setDocName(f.name);
        void addRecent(din, f).then(setRecent);
        const was = versionRef.current;
        const now = SAVED_AS[format];
        setStatus(was && was !== now.version ? `Saved as ${now.name}` : `Saved ${f.name}`);
        versionRef.current = now.version;
        return true;
      } catch (err) {
        setStatus(`Couldn’t save ${f.name}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [din, encode],
  );

  const saveAs = useCallback(
    async (format?: Format): Promise<boolean> => {
      if (!docRef.current) return false;
      const start: Format = format ?? (file ? formatOf(file.name) : null) ?? 'dwg';
      // The format asked for first, so a name typed without one gets its extension.
      const types = typesFromFilters(start === 'dxf' ? [...SAVE_FILTERS].reverse() : SAVE_FILTERS);
      const t = await pickSaveFile({
        title: format === 'dxf' ? 'Export DXF' : 'Save Drawing As',
        suggestedName: `${docName.replace(/\.[^.]*$/, '')}.${start}`,
        startIn: file ?? undefined,
        types,
      });
      if (!t) return false;
      if (!formatOf(t.name)) {
        setStatus(`CAD can’t save ${t.name}: choose a .dwg or .dxf name.`);
        return false;
      }
      return writeTo(t);
    },
    [docName, file, writeTo],
  );

  const save = useCallback(
    async (): Promise<boolean> => (file && (await canWrite(file)) && formatOf(file.name) ? writeTo(file) : saveAs()),
    [file, writeTo, saveAs],
  );

  const openFile = useCallback(async () => {
    const [t] = await pickFiles({
      title: 'Select File',
      types: fileTypes([{ description: 'Drawings', extensions: ['.dwg', '.dxf'] }]),
      startIn: file ?? undefined,
    });
    if (!t) return;
    // Work in progress stays put; the drawing gets a window of its own.
    if (docRef.current && (dirty || file)) void din.app.open('cad', {}, [t]);
    else openHandle(t);
  }, [din, file, dirty, openHandle]);

  const newFile = useCallback(
    (metric: boolean) => {
      if (docRef.current) void din.app.open('cad', { new: metric ? 'metric' : 'imperial' });
      else startDoc(newDrawing(metric), `Drawing${++untitled}.dwg`, null);
    },
    [din, startDoc],
  );

  // Closing with unsaved changes asks first.
  useCloseGuard(
    dirty
      ? () => {
          window.focus();
          setDialog({ kind: 'unsaved', then: () => window.close() });
          return true;
        }
      : null,
  );

  const closeNow = useCallback(() => window.close(), []);

  // ---- The command engine -----------------------------------------------------------------------

  const props = useCallback(() => {
    const d = docRef.current!;
    const c = currentRef.current;
    return { layer: d.header.clayer, color: c.color, linetype: c.linetype, lineweight: c.lineweight, ltscale: d.header.celtscale || 1 };
  }, []);

  const parseCtx = useCallback(() => {
    const d = docRef.current;
    return { last: lastPoint.current, base: pendingRef.current?.req.kind === 'point' ? (pendingRef.current.req.base ?? null) : null, cursor: cursorRef.current?.p ?? null, angdir: d?.header.angdir ?? false, angbase: d?.header.angbase ?? 0 };
  }, []);

  /** Answer the pending request; returns false if the input wasn't valid for it. */
  const answer = useCallback(
    (a: Answer) => {
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      setPrompt(null);
      pickBuf.current = new Set();
      winRef.current = null;
      p.resolve(a);
    },
    [],
  );

  const submitText = useCallback(
    (raw: string): boolean => {
      const p = pendingRef.current;
      if (!p) return false;
      if (p.req.kind === 'select') {
        if (raw.trim() === '') {
          const d = docRef.current!;
          const list = d.entities.filter((e) => pickBuf.current.has(e.id));
          say(`${promptText(p.req)}`);
          answer({ t: 'objects', list });
          return true;
        }
        const k = raw.trim().toUpperCase();
        const d = docRef.current!;
        const filter = p.req.filter;
        say(`${promptText(p.req)} ${raw.trim()}`);
        if (k === 'ALL') {
          const list = d.entities.filter((e) => layerVisible(findLayer(d, e.layer)) && (!filter || filter(e)));
          for (const e of list) pickBuf.current.add(e.id);
          say(`${list.length} found`);
          scheduleOver();
          return true;
        }
        if (k === 'L' || k === 'LAST') {
          const e = [...d.entities].reverse().find((x) => layerVisible(findLayer(d, x.layer)));
          if (e) pickBuf.current.add(e.id);
          say('1 found');
          scheduleOver();
          return true;
        }
        if (k === 'P' || k === 'PREVIOUS') {
          for (const id of selRef.current) pickBuf.current.add(id);
          scheduleOver();
          return true;
        }
        say('*Invalid selection*  Expects a point or Window/Last/Crossing/ALL/Previous');
        return false;
      }
      const r = parseInput(raw, p.req, parseCtx());
      if (r.t === 'error') {
        say(r.msg);
        return false;
      }
      say(`${promptText(p.req)} ${raw.trim() || ''}`.trim());
      if (r.t === 'point') lastPoint.current = r.p;
      answer(r);
      return true;
    },
    [answer, parseCtx, say, scheduleOver],
  );

  const ask = useCallback(
    (req: Req): Promise<Answer> =>
      new Promise((resolve, reject) => {
        pendingRef.current = { req, resolve, reject };
        setPrompt(req);
        if (req.kind === 'select') pickBuf.current = new Set();
        scheduleOver();
        // Options typed ahead (ribbon macros like "CIRCLE 2P") answer right away.
        const next = macro.current.shift();
        if (next !== undefined) queueMicrotask(() => submitText(next));
      }),
    [scheduleOver, submitText],
  );

  const cancel = useCallback(() => {
    const p = pendingRef.current;
    if (p) {
      pendingRef.current = null;
      setPrompt(null);
      p.reject(new Cancelled());
    }
    const te = textEditRef.current;
    if (te) {
      textEditRef.current = null;
      setTextEdit(null);
      te.resolve(null);
    }
    winRef.current = null;
    pickBuf.current = new Set();
    panMode.current?.();
  }, []);

  const hostRef = useRef<Host | null>(null);

  const runFn = useCallback(
    async (name: string, title: string, fn: (h: Host) => Promise<void>, keepSelection: boolean) => {
      if (runningRef.current) cancel();
      // Wait for the cancelled command to unwind.
      await new Promise((r) => setTimeout(r, 0));
      const h = hostRef.current!;
      runRef.current++;
      runningRef.current = name;
      setRunning(name);
      say(`Command: ${title}`);
      if (!keepSelection && selRef.current.size) setSelection([]);
      try {
        await fn(h);
      } catch (err) {
        if (err instanceof Cancelled) say('*Cancel*');
        else {
          say(`${title}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(err);
        }
      } finally {
        if (runningRef.current === name) {
          runningRef.current = null;
          setRunning(null);
        }
        pendingRef.current = null;
        setPrompt(null);
        tempRef.current = [];
        macro.current = [];
        winRef.current = null;
        pickBuf.current = new Set();
        runRef.current++;
        scheduleBase();
      }
    },
    [cancel, say, setSelection, scheduleBase],
  );

  const run = useCallback(
    (text: string) => {
      const tokens = text.trim().split(/\s+/);
      const name = resolveCommand(tokens[0] ?? '');
      if (!name) {
        say(`Unknown command "${(tokens[0] ?? '').toUpperCase()}".  Press F1 for help.`);
        return;
      }
      if (!docRef.current && !['NEW', 'OPEN', 'ABOUT'].includes(name)) return;
      const info = COMMANDS[name];
      // Zoom and pan go on top of whatever's running.
      if (info.transparent && runningRef.current && tokens.length > 1) {
        const k = tokens[1].toUpperCase();
        if (k === 'E') zoomExtents();
        if (k === 'P') {
          const v = viewStack.current.pop();
          if (v) setView(v);
        }
        return;
      }
      macro.current = tokens.slice(1);
      if (!['U', 'UNDO', 'REDO'].includes(name)) lastCmd.current = name;
      void runFn(name, info.title, info.run, !!info.usesSelection);
    },
    [runFn, say, zoomExtents, setView],
  );

  // ---- Text editing in place --------------------------------------------------------------------

  const editText = useCallback((req: TextEditRequest) => new Promise<string | null>((resolve) => {
    const te: TextEdit = { id: ++textEditSeq, kind: 'text', req, resolve };
    textEditRef.current = te;
    setTextEdit(te);
  }), []);
  const editMText = useCallback((req: MTextEditRequest) => new Promise<string | null>((resolve) => {
    const te: TextEdit = { id: ++textEditSeq, kind: 'mtext', req, resolve };
    textEditRef.current = te;
    setTextEdit(te);
  }), []);
  const textCommit = useRef<(() => void) | null>(null);
  const finishText = useCallback((value: string | null) => {
    const te = textEditRef.current;
    if (!te) return;
    textEditRef.current = null;
    setTextEdit(null);
    te.resolve(value);
    requestAnimationFrame(() => {
      if (!textEditRef.current) inputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  // ---- The host commands talk to -----------------------------------------------------------------

  const hatchCtl = useMemo(
    () => ({
      get: () => hatchRef.current,
      begin: () => {
        setHatchActive(true);
        set({ tab: 'hatch' });
      },
      end: () => {
        setHatchActive(false);
        setSettings((s) => (s.tab === 'hatch' ? { ...s, tab: 'home' } : s));
      },
    }),
    [set],
  );

  useLayoutEffect(() => {
    hostRef.current = {
      drawing: () => docRef.current!,
      commit,
      ask,
      say,
      props,
      takeSelection: () => {
        const d = docRef.current!;
        const list = d.entities.filter((e) => selRef.current.has(e.id));
        if (list.length) setSelection([]);
        return list;
      },
      setSelection,
      setTemp: (list) => {
        tempRef.current = list;
        scheduleOver();
      },
      get lastPoint() {
        return lastPoint.current;
      },
      set lastPoint(p) {
        lastPoint.current = p;
      },
      metric: docRef.current?.header.measurement === 1,
      zoom: (kind, a, b) => {
        if (kind === 'extents') zoomExtents();
        else if (kind === 'all') {
          const d = docRef.current!;
          const e = extents(d);
          const box = emptyBox();
          grow(box, d.header.limmin);
          grow(box, d.header.limmax);
          if (e) {
            grow(box, e.min);
            grow(box, e.max);
          }
          zoomBox(box.min, box.max);
        } else if (kind === 'previous') {
          const v = viewStack.current.pop();
          if (v) setView(v);
          else say('No previous view saved.');
        } else if (kind === 'window' && a && b && typeof b !== 'number') zoomBox(a, b);
        else if (kind === 'pan') {
          say('Press ESC or ENTER to exit, or right-click to display shortcut menu.');
          panMode.current = () => {
            panMode.current = null;
            scheduleOver();
          };
          scheduleOver();
        }
      },
      undo,
      redo,
      editText,
      editMText,
      open: (p) => {
        if (p === 'layers') setLayersOpen(true);
        else if (p === 'properties') set({ properties: true });
        else if (p === 'history') setShowHistory(true);
        else setDialog({ kind: p === 'units' ? 'units' : p === 'drafting' ? 'drafting' : p === 'dimstyle' ? 'dimstyle' : p === 'textstyle' ? 'textstyle' : 'about' } as DialogState);
      },
      chooseBlock: () => new Promise((resolve) => setDialog({ kind: 'insert', resolve })),
      hatch: hatchCtl,
      file: (op) => {
        if (op === 'new') newFile(docRef.current?.header.measurement === 1);
        else if (op === 'open') void openFile();
        else if (op === 'save') void save();
        else if (op === 'saveas') void saveAs();
        else if (op === 'close') {
          if (dirty) setDialog({ kind: 'unsaved', then: closeNow });
          else closeNow();
        } else void saveAs('dxf');
      },
      clipboard: {
        copy: (list, base) => {
          clipboard.current = { list, base };
          const d = docRef.current!;
          const blocks = Object.fromEntries(Object.entries(d.blocks).filter(([k]) => list.some((e) => e.type === 'insert' && e.block === k)));
          void navigator.clipboard?.writeText(CLIP_MARK + JSON.stringify({ list, base, blocks })).catch(() => {});
        },
        paste: async () => {
          try {
            const t = await navigator.clipboard?.readText();
            if (t?.startsWith(CLIP_MARK)) {
              const v = JSON.parse(t.slice(CLIP_MARK.length)) as { list: Entity[]; base: Vec | null; blocks: Drawing['blocks'] };
              const d = docRef.current!;
              const missing = Object.entries(v.blocks ?? {}).filter(([k]) => !d.blocks[k]);
              if (missing.length) commit('Paste', { ...d, blocks: { ...d.blocks, ...Object.fromEntries(missing) } });
              return { list: v.list, base: v.base };
            }
          } catch {
            // Fall back to what this window copied.
          }
          return clipboard.current;
        },
      },
      visible: () => visibleEntities(docRef.current!),
    };
  });

  // ---- Pointer --------------------------------------------------------------------------------------

  const aperture = () => 10 / viewRef.current.scale;

  const entityAt = useCallback(
    (p: Vec, filter?: (e: Entity) => boolean): Entity | null => {
      const d = docRef.current;
      if (!d) return null;
      const tol = 5 / viewRef.current.scale;
      let best: Entity | null = null;
      let bd = Infinity;
      cache.sync(d);
      const hidden = new Set(d.layers.filter((l) => !layerVisible(l)).map((l) => l.name.toUpperCase()));
      // Topmost first: later entities draw over earlier ones.
      for (let i = d.entities.length - 1; i >= 0; i--) {
        const e = d.entities[i];
        if (hidden.has(e.layer.toUpperCase())) continue;
        if (filter && !filter(e)) continue;
        const dd = geomDistance(cache.get(e, d), p, tol);
        if (dd <= tol && dd < bd) {
          bd = dd;
          best = e;
          if (dd === 0 && e.type !== 'hatch') break;
        }
      }
      return best;
    },
    [cache],
  );

  /** Where a click goes: object snaps, then ortho or polar tracking, then grid snap. */
  const resolvePoint = useCallback(
    (raw: Vec, shiftOrtho: boolean): { p: Vec; snap: SnapHit | null; polar: { angle: number; dist: number; base: Vec } | null } => {
      const d = docRef.current!;
      const st = settingsRef.current;
      const pend = pendingRef.current;
      const base = pend?.req.kind === 'point' ? (pend.req.base ?? null) : hoverGrip.current ? null : null;
      if (st.osnap) {
        const hit = findSnap(d, visibleEntities(d), cache, raw, aperture(), st.osmode, base);
        if (hit) return { p: hit.p, snap: hit, polar: null };
      }
      if (base) {
        const ortho = st.ortho !== shiftOrtho;
        const a = angleOf(sub(raw, base));
        const L = dist(raw, base);
        if (ortho) {
          const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
          const along = L * Math.cos(a - q);
          return { p: { x: base.x + Math.cos(q) * along, y: base.y + Math.sin(q) * along }, snap: null, polar: null };
        }
        if (st.polar && L * viewRef.current.scale > 8) {
          const inc = (st.polarAngle * Math.PI) / 180;
          const q = Math.round(a / inc) * inc;
          const off = Math.abs(L * Math.sin(a - q)) * viewRef.current.scale;
          if (off < 8) {
            const along = L * Math.cos(a - q);
            const p = { x: base.x + Math.cos(q) * along, y: base.y + Math.sin(q) * along };
            return { p, snap: null, polar: { angle: q, dist: along, base } };
          }
        }
      }
      if (st.snap) {
        const u = st.snapUnit;
        return { p: { x: Math.round(raw.x / u) * u, y: Math.round(raw.y / u) * u }, snap: null, polar: null };
      }
      return { p: raw, snap: null, polar: null };
    },
    [cache, visibleEntities],
  );

  const screenOf = (e: { clientX: number; clientY: number }): Vec => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const updateCursor = useCallback(
    (screen: Vec, shift: boolean) => {
      const d = docRef.current;
      if (!d) return;
      const world = toWorld(viewRef.current, sizeRef.current, screen);
      const pend = pendingRef.current;
      let p = world;
      let snap: SnapHit | null = null;
      let polar = null;
      if (pend?.req.kind === 'point') {
        const r = resolvePoint(world, shift);
        p = r.p;
        snap = r.snap;
        polar = r.polar;
      }
      cursorRef.current = { screen, world, p, snap, polar };
      // What's under the cursor.
      if (!pend || pend.req.kind === 'pick' || pend.req.kind === 'select') {
        hoverRef.current = winRef.current ? null : entityAt(world, pend && (pend.req.kind === 'pick' || pend.req.kind === 'select') ? pend.req.filter : undefined);
      } else hoverRef.current = null;
      hoverDoc.current = docRef.current;
      // A grip under the cursor (with nothing running).
      hoverGrip.current = null;
      if (!pend && selRef.current.size && selRef.current.size <= 200) {
        const v = viewRef.current;
        const s = sizeRef.current;
        for (const e of d.entities) {
          if (!selRef.current.has(e.id)) continue;
          for (const g of gripsOf(e)) {
            const sp = toScreen(v, s, g.p);
            if (Math.abs(sp.x - screen.x) <= 6 && Math.abs(sp.y - screen.y) <= 6) {
              hoverGrip.current = { e, g };
              break;
            }
          }
          if (hoverGrip.current) break;
        }
      }
      setCursorInfo(p);
      scheduleOver();
    },
    [entityAt, resolvePoint, scheduleOver],
  );

  /** Finish a window or crossing selection between two screen points. */
  const windowSelect = useCallback(
    (a: Vec, b: Vec, filter?: (e: Entity) => boolean): Entity[] => {
      const d = docRef.current!;
      const v = viewRef.current;
      const s = sizeRef.current;
      const wa = toWorld(v, s, a);
      const wb = toWorld(v, s, b);
      const min = { x: Math.min(wa.x, wb.x), y: Math.min(wa.y, wb.y) };
      const max = { x: Math.max(wa.x, wb.x), y: Math.max(wa.y, wb.y) };
      const crossing = b.x < a.x;
      cache.sync(d);
      return d.entities.filter((e) => {
        if (!layerVisible(findLayer(d, e.layer))) return false;
        if (filter && !filter(e)) return false;
        const g = cache.get(e, d);
        if (crossing) return geomCrosses(g, min, max);
        return g.box.min.x >= min.x && g.box.max.x <= max.x && g.box.min.y >= min.y && g.box.max.y <= max.y;
      });
    },
    [cache],
  );

  /** Drag a grip: a little STRETCH command of its own. */
  const gripEdit = useCallback(
    (e: Entity, g: Grip) => {
      void runFn('GRIP', '** STRETCH **', async (h) => {
        const d = h.drawing();
        if (findLayer(d, e.layer)?.locked) {
          h.say('The object is on a locked layer.');
          return;
        }
        let mode = 0;
        const modes = ['STRETCH', 'MOVE', 'ROTATE', 'SCALE', 'MIRROR'];
        const base = g.p;
        for (;;) {
          const kws: Keyword[] = [{ name: 'Base point' }, { name: 'Copy' }, { name: 'Undo' }, { name: 'eXit', key: 'X' }];
          const make = (q: Vec): Entity => {
            switch (modes[mode]) {
              case 'STRETCH':
                return g.move(q);
              case 'MOVE':
                return transformEntity(e, translation(q.x - base.x, q.y - base.y));
              case 'ROTATE':
                return transformEntity(e, rotation(base, angleOf(sub(q, base))));
              case 'SCALE':
                return transformEntity(e, { a: dist(base, q) || 1, b: 0, c: 0, d: dist(base, q) || 1, e: base.x - (dist(base, q) || 1) * base.x, f: base.y - (dist(base, q) || 1) * base.y });
              default: {
                const ang = angleOf(sub(q, base));
                const k = Math.cos(2 * ang);
                const s = Math.sin(2 * ang);
                return transformEntity(e, { a: k, b: s, c: s, d: -k, e: base.x - (k * base.x + s * base.y), f: base.y - (s * base.x - k * base.y) });
              }
            }
          };
          h.say(`** ${modes[mode]} **`);
          const a = await h.ask({ kind: 'point', prompt: modes[mode] === 'STRETCH' ? 'Specify stretch point' : modes[mode] === 'MOVE' ? 'Specify move point' : modes[mode] === 'ROTATE' ? 'Specify rotation angle' : modes[mode] === 'SCALE' ? 'Specify scale factor' : 'Specify second point', base, keywords: kws, preview: (q) => [make(q)] });
          if (a.t === 'enter') {
            mode = (mode + 1) % modes.length;
            continue;
          }
          if (a.t === 'keyword') {
            if (a.k === 'eXit') return;
            continue;
          }
          if (a.t !== 'point') return;
          const out = { ...make(a.p), id: e.id };
          const dd = h.drawing();
          h.commit('Grip Edit', { ...dd, entities: dd.entities.map((x) => (x.id === e.id ? out : x)) });
          h.setSelection([e.id]);
          return;
        }
      }, true);
    },
    [runFn],
  );

  const onPointerDown = (ev: React.PointerEvent) => {
    if (!docRef.current) return;
    const screen = screenOf(ev);
    setMenuAt(null);
    // A click outside the text editor keeps what was typed, as in AutoCAD.
    if (textEditRef.current) {
      if (textCommit.current) textCommit.current();
      else finishText(null);
      return;
    }
    if (ev.button === 1 || (ev.button === 0 && panMode.current)) {
      ev.preventDefault();
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      panRef.current = { x: screen.x, y: screen.y, v: viewRef.current };
      return;
    }
    if (ev.button === 2) return;
    if (ev.button !== 0) return;
    rootRef.current?.focus({ preventScroll: true });
    updateCursor(screen, ev.shiftKey);
    const cur = cursorRef.current!;
    const pend = pendingRef.current;
    if (pend) {
      const req = pend.req;
      if (req.kind === 'point') {
        lastPoint.current = cur.p;
        say(`${promptText(req)}`);
        answer({ t: 'point', p: cur.p });
        return;
      }
      if (req.kind === 'pick') {
        const e = entityAt(cur.world, req.filter);
        if (e) {
          say(promptText(req));
          const a = { t: 'pick', e, p: cur.world, shift: ev.shiftKey } as Answer;
          answer(a);
        }
        return;
      }
      if (req.kind === 'select') {
        if (winRef.current) {
          finishWindow(screen, req.filter);
          return;
        }
        const e = entityAt(cur.world, req.filter);
        if (e) {
          if (ev.shiftKey) pickBuf.current.delete(e.id);
          else pickBuf.current.add(e.id);
          say(`${promptText(req)} 1 found, ${pickBuf.current.size} total`);
          scheduleOver();
        } else winRef.current = { start: cur.world, sx: screen.x, sy: screen.y, dragged: false };
        return;
      }
      return;
    }
    // Nothing running: grips, then implied selection.
    if (hoverGrip.current) {
      const { e, g } = hoverGrip.current;
      hoverGrip.current = null;
      gripEdit(e, g);
      return;
    }
    if (winRef.current) {
      finishWindow(screen);
      return;
    }
    const e = entityAt(cur.world);
    if (e) {
      const n = new Set(selRef.current);
      if (ev.shiftKey) n.delete(e.id);
      else n.add(e.id);
      setSelection(n);
      return;
    }
    winRef.current = { start: cur.world, sx: screen.x, sy: screen.y, dragged: false };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  };

  const finishWindow = (screen: Vec, filter?: (e: Entity) => boolean) => {
    const w = winRef.current;
    if (!w) return;
    winRef.current = null;
    const list = windowSelect({ x: w.sx, y: w.sy }, screen, filter);
    const pend = pendingRef.current;
    if (pend?.req.kind === 'select') {
      for (const e of list) pickBuf.current.add(e.id);
      say(`${list.length} found, ${pickBuf.current.size} total`);
      scheduleOver();
      return;
    }
    const n = new Set(selRef.current);
    for (const e of list) n.add(e.id);
    setSelection(n);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const screen = screenOf(ev);
    const pan = panRef.current;
    if (pan) {
      const v = pan.v;
      setView({ ...v, cx: v.cx - (screen.x - pan.x) / v.scale, cy: v.cy + (screen.y - pan.y) / v.scale });
      return;
    }
    const w = winRef.current;
    if (w && Math.hypot(screen.x - w.sx, screen.y - w.sy) > 4) w.dragged = true;
    updateCursor(screen, ev.shiftKey);
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    if (panRef.current) {
      panRef.current = null;
      return;
    }
    const w = winRef.current;
    if (w && w.dragged && ev.button === 0) finishWindow(screenOf(ev), pendingRef.current?.req.kind === 'select' ? pendingRef.current.req.filter : undefined);
  };

  const onWheel = (ev: React.WheelEvent) => {
    if (!docRef.current) return;
    const s = screenOf(ev);
    const k = Math.pow(1.0015, -ev.deltaY * (ev.deltaMode === 1 ? 33 : 1));
    zoomAt(k, s.x, s.y);
    updateCursor(s, ev.shiftKey);
  };

  const onDoubleClick = (ev: React.MouseEvent) => {
    const d = docRef.current;
    if (!d || pendingRef.current) return;
    if (ev.button === 1) return zoomExtents();
    const cur = cursorRef.current;
    if (!cur) return;
    const e = entityAt(cur.world);
    if (!e) return;
    if (e.type === 'text' || e.type === 'mtext' || e.type === 'attdef' || e.type === 'dim') {
      void runFn('TEXTEDIT', 'TEXTEDIT', (h) => editAnnotation(h, e), false);
      return;
    }
    setSelection([e.id]);
    set({ properties: true });
  };

  const onAuxClick = (ev: React.MouseEvent) => {
    if (ev.button === 1 && ev.detail === 2) zoomExtents();
  };

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (pendingRef.current) {
      submitText(inputRef.current?.value ?? '');
      setInput('');
      return;
    }
    if (panMode.current) {
      panMode.current();
      return;
    }
    setMenuAt(screenOf(ev));
  };

  // ---- Keyboard ----------------------------------------------------------------------------------

  const toggle = useCallback(
    (key: 'grid' | 'snap' | 'ortho' | 'polar' | 'osnap' | 'dyn' | 'lwt') => {
      const s = settingsRef.current;
      const v = !s[key];
      const patch: Partial<Settings> = { [key]: v };
      if (key === 'ortho' && v) patch.polar = false;
      if (key === 'polar' && v) patch.ortho = false;
      set(patch);
      const names = { grid: 'Grid', snap: 'Snap', ortho: 'Ortho', polar: 'Polar', osnap: 'Osnap', dyn: 'Dynamic Input', lwt: 'Lineweight' };
      say(`<${names[key]} ${v ? 'on' : 'off'}>`);
      scheduleBase();
    },
    [set, say, scheduleBase],
  );

  const suggestions = useMemo(() => {
    const t = input.trim().toUpperCase();
    if (!t || running || /\s/.test(input)) return [];
    const names = new Set<string>();
    if (ALIASES[t]) names.add(ALIASES[t]);
    for (const k of Object.keys(COMMANDS)) if (k.startsWith(t)) names.add(k);
    for (const [a, k] of Object.entries(ALIASES)) if (a.startsWith(t)) names.add(k);
    return [...names].slice(0, 9);
  }, [input, running]);

  const submitInput = useCallback(
    (raw: string) => {
      if (raw.trim()) {
        cmdHistory.current = [raw, ...cmdHistory.current.filter((x) => x !== raw)].slice(0, 50);
        cmdHistIdx.current = -1;
      }
      if (pendingRef.current) {
        if (submitText(raw)) setInput('');
        else setInput('');
        return;
      }
      if (panMode.current) {
        panMode.current();
        return;
      }
      // A command waiting on a dialog or the text editor isn't asking the command line.
      if (runningRef.current) return;
      if (!raw.trim()) {
        if (lastCmd.current) run(lastCmd.current);
        return;
      }
      const pick = suggestions[suggest] && raw.trim().toUpperCase() !== suggestions[suggest] && !resolveCommand(raw) ? suggestions[suggest] : raw;
      setInput('');
      run(pick);
    },
    [run, submitText, suggestions, suggest],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inCmd = target === inputRef.current;
    if (!inCmd && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const fkeys: Record<string, Parameters<typeof toggle>[0]> = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap', F10: 'polar', F12: 'dyn' };
    if (fkeys[k]) {
      e.preventDefault();
      toggle(fkeys[k]);
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      setShowHistory((v) => !v);
      return;
    }
    if (!docRef.current) {
      if (mod && k.toLowerCase() === 'o') {
        e.preventDefault();
        void openFile();
      }
      if (mod && k.toLowerCase() === 'n') {
        e.preventDefault();
        newFile(false);
      }
      return;
    }
    if (mod) {
      const lower = k.toLowerCase();
      const map: Record<string, () => void> = {
        z: () => (runningRef.current ? cancel() : undo()),
        y: () => redo(),
        s: () => (e.shiftKey ? void saveAs() : void save()),
        o: () => void openFile(),
        n: () => newFile(docRef.current?.header.measurement === 1),
        c: () => run(e.shiftKey ? 'COPYBASE' : 'COPYCLIP'),
        x: () => run('CUTCLIP'),
        v: () => run('PASTECLIP'),
        a: () => run('SELECTALL'),
        '1': () => set({ properties: !settingsRef.current.properties }),
        ...(e.shiftKey ? { a: () => set({ assistant: !settingsRef.current.assistant }) } : {}),
        '0': () => set({ ribbonCollapsed: !settingsRef.current.ribbonCollapsed }),
      };
      if (map[lower]) {
        e.preventDefault();
        map[lower]();
      }
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      if (input) setInput('');
      else if (pendingRef.current || runningRef.current || panMode.current) cancel();
      else if (winRef.current) {
        winRef.current = null;
        scheduleOver();
      } else if (selRef.current.size) setSelection([]);
      return;
    }
    if (k === 'Delete' && !inCmd && !pendingRef.current) {
      if (selRef.current.size) {
        e.preventDefault();
        run('ERASE');
      }
      return;
    }
    const spaces = pendingRef.current?.req.kind === 'string' && pendingRef.current.req.spaces;
    if (k === 'Enter' || (k === ' ' && !spaces)) {
      e.preventDefault();
      submitInput(input);
      return;
    }
    if (inCmd && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      if (suggestions.length) {
        setSuggest((i) => (k === 'ArrowDown' ? (i + 1) % suggestions.length : (i - 1 + suggestions.length) % suggestions.length));
        return;
      }
      const list = cmdHistory.current;
      if (!list.length) return;
      cmdHistIdx.current = Math.max(-1, Math.min(list.length - 1, cmdHistIdx.current + (k === 'ArrowUp' ? 1 : -1)));
      setInput(cmdHistIdx.current < 0 ? '' : list[cmdHistIdx.current]);
      return;
    }
    if (k === 'Tab' && inCmd && suggestions.length) {
      e.preventDefault();
      setInput(suggestions[suggest] ?? input);
      return;
    }
    // Typing anywhere goes to the command line.
    if (!inCmd && k.length === 1 && !e.altKey) {
      e.preventDefault();
      setInput((s) => s + k);
      setSuggest(0);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  // Keys go to the window: at first, and after dialogs close.
  useEffect(() => {
    if (dialog || textEdit) return;
    const a = document.activeElement;
    if (!a || a === document.body || !rootRef.current?.contains(a)) rootRef.current?.focus({ preventScroll: true });
  }, [dialog, textEdit, noDoc]);

  // ---- Title bar ------------------------------------------------------------------------------------

  const qat = useRef({ newFile, openFile, save, saveAs, undo, redo, run });
  useLayoutEffect(() => {
    qat.current = { newFile, openFile, save, saveAs, undo, redo, run };
  });
  const hasDoc = !!doc;
  const canUndo = !!hist && hist.index > 0;
  const canRedo = !!hist && hist.index < hist.entries.length - 1;
  const titleContent = useMemo(
    () => (
      <WindowDragRegion className="relative grid h-9 shrink-0 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-3 bg-[#1b2028] pl-2 text-[#e3e8ef]" onMouseDown={keepFocus} style={{ fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" }}>
        <div className="flex items-center gap-px">
          <Menu.Root modal={false}>
            <Menu.Trigger asChild>
              <button type="button" aria-label="Application menu" title="Application menu" className={cn('mr-1 flex h-7 items-center gap-1 rounded-[3px] px-1.5 hover:bg-white/10', FOCUS)}>
                <img src="/icons/apps/cad.png" alt="" className="size-5" draggable={false} />
                <span className="text-[11px] text-[#a9b2bf]">▾</span>
              </button>
            </Menu.Trigger>
            <MenuContent className="min-w-60">
              <MenuItem icon={<Icons.newFile />} onSelect={() => qat.current.newFile(false)} shortcut="Ctrl+N">New Drawing (inches)</MenuItem>
              <MenuItem icon={<Icons.newFile />} onSelect={() => qat.current.newFile(true)}>New Drawing (millimeters)</MenuItem>
              <MenuItem icon={<Icons.openFile />} onSelect={() => void qat.current.openFile()} shortcut="Ctrl+O">Open…</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Icons.save />} onSelect={() => void qat.current.save()} disabled={!hasDoc} shortcut="Ctrl+S">Save</MenuItem>
              <MenuItem icon={<Icons.saveAs />} onSelect={() => void qat.current.saveAs()} disabled={!hasDoc} shortcut="Ctrl+Shift+S">Save As…</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Icons.units />} onSelect={() => qat.current.run('UNITS')} disabled={!hasDoc}>Drawing Utilities: Units…</MenuItem>
              <MenuItem icon={<Icons.erase />} onSelect={() => qat.current.run('PURGE')} disabled={!hasDoc}>Drawing Utilities: Purge</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Icons.close />} onSelect={() => qat.current.run('CLOSE')}>Close</MenuItem>
            </MenuContent>
          </Menu.Root>
          {[
            ['New', <Icons.newFile key="n" />, () => qat.current.newFile(false), true],
            ['Open', <Icons.openFile key="o" />, () => void qat.current.openFile(), true],
            ['Save', <Icons.save key="s" />, () => void qat.current.save(), hasDoc],
            ['Save As', <Icons.saveAs key="sa" />, () => void qat.current.saveAs(), hasDoc],
            ['Undo', <Icons.undo key="u" />, () => qat.current.undo(), canUndo],
            ['Redo', <Icons.redo key="r" />, () => qat.current.redo(), canRedo],
          ].map(([label, icon, fn, enabled]) => (
            <button key={label as string} type="button" aria-label={label as string} title={label as string} disabled={!enabled} onClick={fn as () => void} className={cn('grid size-7 place-items-center rounded-[3px] hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-transparent [&>svg]:size-4', FOCUS)}>
              {icon as React.ReactNode}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center justify-center gap-2">
          <span className="truncate text-[12.5px]">
            CAD <span className="text-[#8e98a6]">·</span> {title}
          </span>
          {status && <span className="hidden shrink-0 text-[12px] text-[#a9b2bf] sm:inline">• {status}</span>}
        </div>
        <div className="pr-[100px]" />
        <WindowControls className="absolute top-1/2 right-2 -translate-y-1/2" />
      </WindowDragRegion>
    ),
    [title, status, hasDoc, canUndo, canRedo],
  );
  // The title bar is the app's own, in the drawing area's colors; the accent
  // gives Din's window controls on it their light icons.
  useWindowAccent('#1b2028');

  // ---- The assistant ------------------------------------------------------------------------------

  const assistant = useCadAssistant(
    {
      name: docName,
      drawing: () => docRef.current,
      view: () => {
        const d = docRef.current!;
        const v = viewRef.current;
        const s = sizeRef.current;
        const tl = toWorld(v, s, { x: 0, y: 0 });
        const br = toWorld(v, s, { x: s.w, y: s.h });
        const n = (x: number) => String(Number(x.toPrecision(6)));
        const sel = d.entities.filter((e) => selRef.current.has(e.id));
        return [
          '# What the user sees',
          '',
          `- Drawing: ${docName}, in ${unitsName(d)}.`,
          `- Visible area: x from ${n(tl.x)} to ${n(br.x)}, y from ${n(br.y)} to ${n(tl.y)}.`,
          `- Current layer: ${d.header.clayer}.`,
          sel.length
            ? `- Selected (${sel.length}): ${sel
                .slice(0, 100)
                .map((e) => `id ${e.id} (${e.type} on ${e.layer})`)
                .join(', ')}${sel.length > 100 ? ', …' : ''}.`
            : '- Nothing is selected.',
          '',
        ].join('\n');
      },
      capture: async () => {
        const base = baseRef.current;
        if (!base) return null;
        const k = Math.min(1, 1600 / base.width);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(base.width * k));
        c.height = Math.max(1, Math.round(base.height * k));
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(base, 0, 0, c.width, c.height);
        if (overRef.current) ctx.drawImage(overRef.current, 0, 0, c.width, c.height);
        const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      },
      apply: (d, turn) => commit('Assistant', d, turn),
    },
    docSerial,
  );

  // ---- Ribbon state ---------------------------------------------------------------------------------

  const selList = useMemo(() => (doc ? doc.entities.filter((e) => selection.has(e.id)) : []), [doc, selection]);
  const common = <T,>(get: (e: Entity) => T): T | null | undefined => {
    if (!selList.length) return null;
    const v = get(selList[0]);
    return selList.every((e) => get(e) === v) ? v : undefined;
  };

  const updateEntities = useCallback(
    (label: string, list: Entity[]) => {
      const d = docRef.current;
      if (!d) return;
      const byId = new Map(list.map((e) => [e.id, e]));
      commit(label, { ...d, entities: d.entities.map((e) => byId.get(e.id) ?? e) });
    },
    [commit],
  );

  const applyToSelection = (label: string, fn: (e: Entity) => Entity) => {
    const d = docRef.current;
    if (!d || !selList.length) return false;
    updateEntities(label, selList.filter((e) => !findLayer(d, e.layer)?.locked).map(fn));
    return true;
  };

  const setLayerProp = (name: string, patch: Partial<Layer>) => {
    const d = docRef.current;
    if (!d) return;
    if (patch.frozen && name === d.header.clayer) return say('Cannot freeze the current layer.');
    commit('Layer', { ...d, layers: d.layers.map((l) => (l.name === name ? { ...l, ...patch } : l)) });
  };

  // ---- Render ----------------------------------------------------------------------------------------

  const promptLine = prompt ? promptText(prompt) : running ? '' : 'Type a command';
  const pend = prompt;
  const s = sizeRef.current;
  void viewTick;

  const textEditor = textEdit && doc ? <InPlaceText key={textEdit.id} te={textEdit} drawing={doc} view={viewRef.current} size={s} onDone={finishText} commitRef={textCommit} /> : null;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="cad-frame relative flex h-full w-full flex-col overflow-hidden bg-[#2a3039] text-[12px] text-[#e3e8ef] outline-none select-none"
      style={{ fontFamily: "'Inter Variable', 'Segoe UI', system-ui, sans-serif", colorScheme: 'dark' }}
      onKeyDown={onKeyDown}
    >
      {titleContent}
      {doc && (
        <Ribbon
          tab={settings.tab === 'hatch' && !hatchActive ? 'home' : settings.tab}
          setTab={(t) => set({ tab: t })}
          collapsed={settings.ribbonCollapsed}
          setCollapsed={(v) => set({ ribbonCollapsed: v })}
          run={run}
          drawing={doc}
          selLayer={common((e) => e.layer)}
          selColor={common((e) => e.color)}
          selLinetype={common((e) => e.linetype)}
          selLineweight={common((e) => e.lineweight)}
          current={current}
          setLayerProp={setLayerProp}
          chooseLayer={(n) => (applyToSelection('Layer', (e) => ({ ...e, layer: n })) ? null : commit('Set Current Layer', { ...doc, header: { ...doc.header, clayer: n } }))}
          chooseColor={(c) => applyToSelection('Color', (e) => ({ ...e, color: c })) || setCurrent((x) => ({ ...x, color: c }))}
          chooseLinetype={(n) => applyToSelection('Linetype', (e) => ({ ...e, linetype: n })) || setCurrent((x) => ({ ...x, linetype: n }))}
          chooseLineweight={(n) => applyToSelection('Lineweight', (e) => ({ ...e, lineweight: n })) || setCurrent((x) => ({ ...x, lineweight: n }))}
          chooseTextStyle={(n) => commit('Text Style', { ...doc, header: { ...doc.header, textstyle: n } })}
          chooseDimStyle={(n) => commit('Dimension Style', { ...doc, header: { ...doc.header, dimstyle: n } })}
          setTextHeight={(h) => commit('Text Height', { ...doc, header: { ...doc.header, textsize: h } })}
          hatchActive={hatchActive}
          hatch={hatch}
          setHatch={(h) => {
            setHatch(h);
            hatchRef.current = h;
            scheduleOver();
          }}
          finishHatch={() => submitText('')}
          palettes={{ properties: settings.properties, layers: layersOpen, assistant: settings.assistant }}
          togglePalette={(p) => (p === 'properties' ? set({ properties: !settings.properties }) : p === 'assistant' ? set({ assistant: !settings.assistant }) : setLayersOpen((v) => !v))}
          dark={settings.dark}
          toggleDark={() => set({ dark: !settings.dark })}
        />
      )}
      {/* File tabs. */}
      <div className="flex h-[28px] shrink-0 items-end gap-0.5 border-t border-[#1d2229] bg-[#2a3039] px-2" onMouseDown={keepFocus}>
        <button type="button" onClick={() => (doc ? newFile(doc.header.measurement === 1) : undefined)} className={cn('mb-0.5 h-[22px] rounded-[2px] px-2.5 text-[12px] text-[#c4ccd7] hover:bg-white/5', !doc && 'bg-[#212830] text-white')}>
          Start
        </button>
        {doc && (
          <div className="flex h-[25px] items-center gap-2 rounded-t-[3px] bg-[#212830] pr-1 pl-3 text-[12px] text-white">
            <span className="max-w-64 truncate" title={path ?? docName}>
              {docName}
              {dirty && '*'}
            </span>
            <button type="button" aria-label="Close drawing" title="Close" onClick={() => run('CLOSE')} className="grid size-4 place-items-center rounded-[2px] text-[#a9b2bf] hover:bg-white/10 hover:text-white">
              <X className="size-3" />
            </button>
          </div>
        )}
        <button type="button" aria-label="New drawing" title="New drawing" onClick={() => newFile(doc?.header.measurement === 1)} className="mb-0.5 grid size-[22px] place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-white/10">
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <div
            ref={viewportRef}
            className="absolute inset-0 touch-none overflow-hidden"
            style={{ cursor: doc ? (panMode.current || panRef.current ? 'grab' : 'none') : 'default', background: theme.bg }}
            onPointerDown={onPointerDown}
            // Focus is handled on pointerdown; the default would take it back from a text editor the click opened.
            onMouseDown={(e) => (e.target === e.currentTarget || e.target instanceof HTMLCanvasElement) && e.preventDefault()}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              cursorRef.current = null;
              hoverRef.current = null;
              setCursorInfo(null);
              scheduleOver();
            }}
            onWheel={onWheel}
            onDoubleClick={onDoubleClick}
            onAuxClick={onAuxClick}
            onContextMenu={onContextMenu}
          >
            <canvas ref={baseRef} className="absolute inset-0 size-full" aria-label={doc ? `Drawing: ${docName}` : undefined} />
            <canvas ref={overRef} className="absolute inset-0 size-full" aria-hidden />
            {doc && (
              <div className="pointer-events-none absolute top-1.5 left-2 text-[11.5px] text-[#9fb4c8]" aria-hidden>
                [-][Top][2D Wireframe]
              </div>
            )}
            {textEditor}
            {!doc && !loading && (
              <StartPage error={error} recent={recent} onNew={(m) => newFile(m)} onOpen={() => void openFile()} onOpenRecent={openRecent} />
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Opening">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-40 w-64 animate-pulse rounded-[3px] bg-[#2d3540] motion-reduce:animate-none" />
                  <span className="text-[13px] text-[#a9b2bf]">Opening drawing…</span>
                </div>
              </div>
            )}
            {menuAt && doc && (
              <ContextMenu
                at={menuAt}
                last={lastCmd.current}
                hasSelection={selection.size > 0}
                onClose={() => setMenuAt(null)}
                run={(c) => {
                  setMenuAt(null);
                  if (c === 'DESELECT') setSelection([]);
                  else if (c === 'PROPERTIES') set({ properties: true });
                  else run(c);
                }}
              />
            )}
          </div>

          {/* The command line, floating over the drawing as AutoCAD's does. */}
          {doc && (
            <div className="pointer-events-none absolute right-3 bottom-2 left-3 z-20 flex flex-col items-stretch">
              {suggestions.length > 0 && (
                <ul role="listbox" aria-label="Commands" className="pointer-events-auto mb-1 w-80 overflow-hidden rounded-[3px] border border-[#15191e] bg-[#2f3640]/97 py-1 text-[12px] shadow-[0_6px_18px_rgba(0,0,0,0.45)]">
                  {suggestions.map((n, i) => (
                    <li key={n} role="option" aria-selected={i === suggest}>
                      <button
                        type="button"
                        onMouseDown={keepFocus}
                        onClick={() => {
                          setInput('');
                          run(n);
                        }}
                        className={cn('flex w-full items-baseline gap-2 px-2.5 py-1 text-left', i === suggest ? 'bg-[#0b6aa8] text-white' : 'hover:bg-white/5')}
                      >
                        <span className="font-semibold">{n}</span>
                        <span className={cn('truncate text-[11px]', i === suggest ? 'text-white/80' : 'text-[#9aa4b1]')}>{COMMANDS[n].description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pointer-events-auto mx-auto w-full max-w-[1100px] overflow-hidden rounded-[3px] border border-[#15191e] bg-[#2a3039]/95 shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
                {(showHistory ? history.slice(-14) : history.slice(-3)).length > 0 && (
                  <div className={cn('overflow-y-auto px-2 pt-1 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-[#a9b2bf] select-text', showHistory ? 'max-h-60' : 'max-h-[54px]')} aria-live="polite">
                    {(showHistory ? history.slice(-200) : history.slice(-3)).map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
                <div className="flex h-[28px] items-center gap-1.5 border-t border-[#20252c] pr-2 pl-1.5">
                  <button type="button" aria-label={showHistory ? 'Hide command history' : 'Show command history'} title="Command history (F2)" onClick={() => setShowHistory((v) => !v)} onMouseDown={keepFocus} className="grid size-5 place-items-center rounded-[2px] text-[#a9b2bf] hover:bg-white/10">
                    {showHistory ? '▾' : '▸'}
                  </button>
                  <span className="shrink-0 text-[#7fd4ff]">{running ? '' : '▸'}</span>
                  <span className="shrink-0 font-mono text-[12px] text-[#dfe4ec]">
                    {pend ? <PromptWithKeywords req={pend} onKeyword={(k) => submitText(k)} /> : <span className="text-[#8e98a6]">{promptLine}</span>}
                  </span>
                  <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setSuggest(0);
                      scheduleOver();
                    }}
                    aria-label="Command line"
                    spellCheck={false}
                    autoComplete="off"
                    className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-white outline-none placeholder:text-[#6c7480]"
                    placeholder={pend ? '' : ''}
                  />
                </div>
              </div>
            </div>
          )}
          {layersOpen && doc && (
            <LayerManager
              drawing={doc}
              commit={commit}
              onClose={() => setLayersOpen(false)}
              inUse={(n) => doc.entities.some((e) => e.layer === n) || Object.values(doc.blocks).some((b) => b.entities.some((e) => e.layer === n))}
              pos={layersPos}
              onMove={setLayersPos}
              isolation={layerIso}
              setIsolation={setLayerIso}
            />
          )}
        </div>
        {settings.properties && doc && (
          <PropertiesPalette
            drawing={doc}
            selection={selList}
            update={updateEntities}
            current={current}
            setCurrent={(p) => {
              if (p.layer) commit('Set Current Layer', { ...doc, header: { ...doc.header, clayer: p.layer } });
              const { layer: _l, ...rest } = p;
              if (Object.keys(rest).length) setCurrent((c) => ({ ...c, ...rest }));
            }}
            onClose={() => set({ properties: false })}
            metric={doc.header.measurement === 1}
          />
        )}
        {settings.assistant && doc && <AssistantPalette assistant={assistant} onClose={() => set({ assistant: false })} />}
      </div>

      {/* Layout tabs and the status bar. */}
      <div className="flex h-[28px] shrink-0 items-center gap-2 border-t border-[#15191e] bg-[#2a3039] px-2 text-[11.5px]" onMouseDown={keepFocus}>
        {doc && (
          <div className="flex items-center gap-0.5">
            <span className="rounded-[2px] bg-[#38404c] px-2.5 py-0.5 text-white">Model</span>
            <span className="cursor-default px-2.5 py-0.5 text-[#8e98a6]" title="Layouts are kept as they are when you save; CAD edits model space.">
              Layout1
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1 truncate text-right text-[#a9b2bf]" role="status">
          {busy ? 'Working…' : null}
        </div>
        {doc && (
          <>
            <span className="w-[200px] shrink-0 text-right font-mono text-[11.5px] text-[#c4ccd7] tabular-nums">{cursorInfo ? `${fmt(cursorInfo.x, doc.header.luprec)}, ${fmt(cursorInfo.y, doc.header.luprec)}, ${fmt(0, doc.header.luprec)}` : ''}</span>
            <span className="rounded-[2px] px-1.5 py-0.5 font-semibold text-[#c4ccd7]">MODEL</span>
            <StatusToggle on={settings.grid} label="Grid (F7)" onClick={() => toggle('grid')} icon={<Icons.grid />} />
            <StatusToggle on={settings.snap} label="Snap Mode (F9)" onClick={() => toggle('snap')} icon={<Icons.snap />} />
            <StatusToggle on={settings.ortho} label="Ortho Mode (F8)" onClick={() => toggle('ortho')} icon={<Icons.ortho />} />
            <StatusToggle on={settings.polar} label={`Polar Tracking (F10) — ${settings.polarAngle}°`} onClick={() => toggle('polar')} icon={<Icons.polar />} />
            <StatusToggle on={settings.osnap} label="Object Snap (F3)" onClick={() => toggle('osnap')} icon={<Icons.osnap />} />
            <button type="button" aria-label="Object snap settings" title="Object snap settings" onClick={() => setDialog({ kind: 'drafting' })} className="-ml-1.5 grid h-5 w-3 place-items-center text-[#a9b2bf] hover:text-white">
              ▾
            </button>
            <StatusToggle on={settings.dyn} label="Dynamic Input (F12)" onClick={() => toggle('dyn')} icon={<Icons.dyn />} />
            <StatusToggle on={settings.lwt} label="Show/Hide Lineweight" onClick={() => toggle('lwt')} icon={<Icons.lineweight />} />
            <span className="px-1 text-[#c4ccd7]" title="Annotation scale">
              1:1
            </span>
            <button type="button" title="Units" onClick={() => run('UNITS')} className="rounded-[2px] px-1.5 py-0.5 text-[#c4ccd7] hover:bg-white/10">
              {['', 'Scientific', 'Decimal', 'Engineering', 'Architectural', 'Fractional'][doc.header.lunits] ?? 'Decimal'}
            </button>
            <StatusToggle on={settings.properties} label="Properties (Ctrl+1)" onClick={() => set({ properties: !settings.properties })} icon={<Icons.properties />} />
            <StatusToggle on={settings.assistant} label="Assistant (Ctrl+Shift+A)" onClick={() => set({ assistant: !settings.assistant })} icon={<Icons.assistant />} />
          </>
        )}
      </div>

      {dialog?.kind === 'units' && doc && (
        <UnitsDialog
          drawing={doc}
          onCancel={() => setDialog(null)}
          onOk={(h) => {
            setDialog(null);
            commit('Units', { ...docRef.current!, header: h });
          }}
        />
      )}
      {dialog?.kind === 'drafting' && (
        <DraftingDialog
          s={settings}
          onCancel={() => setDialog(null)}
          onOk={(v) => {
            setDialog(null);
            set(v);
          }}
        />
      )}
      {dialog?.kind === 'insert' && doc && (
        <InsertDialog
          drawing={doc}
          onCancel={() => {
            const r = dialog.resolve;
            setDialog(null);
            r(null);
          }}
          onOk={(v) => {
            const r = dialog.resolve;
            setDialog(null);
            r(v);
          }}
        />
      )}
      {dialog?.kind === 'textstyle' && doc && (
        <TextStyleDialog
          drawing={doc}
          onCancel={() => setDialog(null)}
          onOk={(styles, cur) => {
            setDialog(null);
            const d = docRef.current!;
            commit('Text Style', { ...d, textStyles: styles, header: { ...d.header, textstyle: cur } });
          }}
        />
      )}
      {dialog?.kind === 'dimstyle' && doc && (
        <DimStyleDialog
          drawing={doc}
          onCancel={() => setDialog(null)}
          onOk={(styles, cur) => {
            setDialog(null);
            const d = docRef.current!;
            // Dimensions in a changed style get drawn again.
            const changed = new Set(styles.filter((s) => d.dimStyles.find((o) => o.name === s.name) !== s).map((s) => s.name));
            commit('Dimension Style', { ...d, dimStyles: styles, header: { ...d.header, dimstyle: cur }, entities: d.entities.map((e) => (e.type === 'dim' && changed.has(e.style) ? { ...e, block: undefined } : e)) });
          }}
        />
      )}
      {dialog?.kind === 'about' && (
        <Dialog title="About CAD" onCancel={() => setDialog(null)} cancelLabel="Close" width={440}>
          <div className="flex gap-4">
            <img src="/icons/apps/cad.png" alt="" className="size-16" />
            <div className="space-y-2 text-[12.5px] text-[#c4ccd7]">
              <p className="text-[15px] font-semibold text-white">CAD</p>
              <p>2D drafting that opens DWG drawings from AutoCAD R13 through AutoCAD 2018 and later and DXF files of any version, and saves AutoCAD 2000 DWG files every AutoCAD and DWG viewer reads, or AutoCAD 2004 DXF for programs that only take DXF.</p>
              <p className="text-[11.5px] text-[#8e98a6]">DWG reading by LibreDWG (GPL-3.0). AutoCAD is a trademark of Autodesk, Inc.; CAD isn’t affiliated with Autodesk.</p>
            </div>
          </div>
        </Dialog>
      )}
      {dialog?.kind === 'dropped' && (
        <Dialog title="Opening" onCancel={() => setDialog(null)} cancelLabel="OK" width={440}>
          <p className="text-[12.5px] text-[#dfe4ec]">Some objects in this drawing can’t be shown or kept here: {dialog.text}.</p>
          <p className="mt-2 text-[12px] text-[#a9b2bf]">Everything else opens as usual. Saving writes an AutoCAD 2000 drawing without them, so keep the original if you need them.</p>
        </Dialog>
      )}
      {dialog?.kind === 'unsaved' && (
        <Dialog
          title="CAD"
          onCancel={() => setDialog(null)}
          width={420}
          footer={
            <div className="flex gap-2">
              <Button
                primary
                autoFocus
                onClick={() => {
                  const then = dialog.then;
                  setDialog(null);
                  void save().then((ok) => {
                    if (ok) then();
                  });
                }}
              >
                Yes
              </Button>
              <Button
                onClick={() => {
                  const then = dialog.then;
                  setDialog(null);
                  then();
                }}
              >
                No
              </Button>
            </div>
          }
        >
          <p className="text-[13px]">Save changes to {docName}?</p>
        </Dialog>
      )}
    </div>
  );
}

function StatusToggle({ on, label, onClick, icon }: { on: boolean; label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn('grid size-6 place-items-center rounded-[2px] [&>svg]:size-4', on ? 'bg-[#0b6aa8]/45 text-[#7fd4ff] hover:bg-[#0b6aa8]/60' : 'text-[#8e98a6] hover:bg-white/10 hover:text-[#dfe4ec]', FOCUS)}
    >
      {icon}
    </button>
  );
}

function PromptWithKeywords({ req, onKeyword }: { req: Req; onKeyword: (k: string) => void }) {
  const kws = req.keywords ?? [];
  return (
    <span>
      {req.prompt}
      {kws.length > 0 && (
        <>
          {' '}
          or [
          {kws.map((k, i) => (
            <span key={k.name}>
              {i > 0 && '/'}
              <button type="button" onMouseDown={keepFocus} onClick={() => onKeyword(kwKey(k))} className="rounded-[2px] px-0.5 text-[#7fd4ff] hover:bg-[#0b6aa8] hover:text-white">
                {k.name}
              </button>
            </span>
          ))}
          ]
        </>
      )}
      {req.default !== undefined && req.default !== '' && <span className="text-[#a9b2bf]"> &lt;{req.default}&gt;</span>}:
    </span>
  );
}

function ContextMenu({ at, last, hasSelection, onClose, run }: { at: Vec; last: string | null; hasSelection: boolean; onClose: () => void; run: (c: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const item = (label: string, cmd: string, icon?: React.ReactNode, shortcut?: string) => (
    <button key={cmd + label} type="button" role="menuitem" onClick={() => run(cmd)} className="flex h-7 w-full items-center gap-2 rounded-[2px] px-2 text-left hover:bg-[#0b6aa8] hover:text-white">
      <span className="grid size-4 place-items-center [&>svg]:size-4">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[11px] text-[#9aa4b1]">{shortcut}</span>}
    </button>
  );
  const sep = (k: string) => <div key={k} className="mx-1 my-1 h-px bg-[#454e5b]" />;
  return (
    <div
      ref={ref}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="absolute z-40 w-56 rounded-[3px] border border-[#15191e] bg-[#2f3640] p-1 text-[12px] text-[#e3e8ef] shadow-[0_6px_18px_rgba(0,0,0,0.45)]"
      style={{ left: at.x, top: at.y }}
    >
      {last && item(`Repeat ${COMMANDS[last]?.title ?? last}`, last)}
      {last && sep('a')}
      {hasSelection ? (
        <>
          {item('Cut', 'CUTCLIP', <Icons.cut />, 'Ctrl+X')}
          {item('Copy', 'COPYCLIP', <Icons.copyclip />, 'Ctrl+C')}
          {item('Paste', 'PASTECLIP', <Icons.paste />, 'Ctrl+V')}
          {sep('b')}
          {item('Erase', 'ERASE', <Icons.erase />, 'Del')}
          {item('Move', 'MOVE', <Icons.move />)}
          {item('Copy Selection', 'COPY', <Icons.copy />)}
          {item('Scale', 'SCALE', <Icons.scale />)}
          {item('Rotate', 'ROTATE', <Icons.rotate />)}
          {sep('c')}
          {item('Deselect All', 'DESELECT')}
          {item('Properties', 'PROPERTIES', <Icons.properties />, 'Ctrl+1')}
        </>
      ) : (
        <>
          {item('Paste', 'PASTECLIP', <Icons.paste />, 'Ctrl+V')}
          {sep('d')}
          {item('Pan', 'PAN', <Icons.pan />)}
          {item('Zoom Extents', 'ZOOM E', <Icons.zoomExtents />)}
          {item('Zoom Window', 'ZOOM W', <Icons.zoomWindow />)}
          {sep('e')}
          {item('Select All', 'SELECTALL', undefined, 'Ctrl+A')}
          {item('Properties', 'PROPERTIES', <Icons.properties />, 'Ctrl+1')}
        </>
      )}
    </div>
  );
}

function StartPage({ error, recent, onNew, onOpen, onOpenRecent }: { error: string | null; recent: Recent[]; onNew: (metric: boolean) => void; onOpen: () => void; onOpenRecent: (r: Recent) => void }) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-[#212830]">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-8 p-8">
        <div className="flex items-center gap-5">
          <img src="/icons/apps/cad.png" alt="" className="size-20 drop-shadow-[0_6px_14px_rgba(0,0,0,0.4)]" draggable={false} />
          <div>
            <h1 className="text-[40px] leading-tight font-semibold tracking-tight text-white">CAD</h1>
            <p className="text-[18px] text-[#a9b2bf]">Draw and edit DWG and DXF drawings, the AutoCAD way.</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-[3px] border border-[#7a2b2b] bg-[#3a2323] px-3 py-2 text-[13px] text-[#ffb4b4]">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => onNew(false)} className={cn('flex h-11 items-center gap-2 rounded-[3px] bg-[#0696d7] px-5 text-[15px] font-medium text-white hover:bg-[#13a7ea]', FOCUS)}>
            <Icons.newFile className="size-5" />
            New drawing
          </button>
          <button type="button" onClick={() => onNew(true)} className={cn('flex h-11 items-center gap-2 rounded-[3px] border border-[#5a6473] px-5 text-[15px] text-[#e3e8ef] hover:bg-white/5', FOCUS)}>
            <Icons.newFile className="size-5" />
            New metric drawing
          </button>
          <button type="button" onClick={onOpen} className={cn('flex h-11 items-center gap-2 rounded-[3px] border border-[#5a6473] px-5 text-[15px] text-[#e3e8ef] hover:bg-white/5', FOCUS)}>
            <FolderOpen className="size-5 text-[#f5c542]" />
            Open…
          </button>
        </div>
        <div>
          <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-[#a9b2bf] uppercase">Recent documents</h2>
          {recent.length ? (
            <ul className="divide-y divide-[#2b313a] overflow-hidden rounded-[3px] border border-[#2b313a]">
              {recent.map((r) => (
                <li key={r.key}>
                  <button type="button" onClick={() => onOpenRecent(r)} className={cn('flex w-full items-center gap-3 bg-[#262c35] px-3 py-2.5 text-left hover:bg-[#2f3742]', FOCUS)}>
                    <Icons.model className="size-5 shrink-0 text-[#7fd4ff]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-white">{basename(r.path)}</span>
                      <span className="block truncate text-[12px] text-[#8e98a6]">{parentPath(r.path)}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-[#8e98a6]">{new Date(r.time).toLocaleDateString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-[3px] border border-dashed border-[#3b4452] px-6 py-8 text-center text-[13px] text-[#8e98a6]">Drawings you open or save show up here.</div>
          )}
        </div>
        <p className="text-[12.5px] text-[#8e98a6]">Ctrl+N new · Ctrl+O open · type commands like LINE, CIRCLE or TRIM, or their aliases L, C, TR</p>
      </div>
    </div>
  );
}

/** Typing text where it goes, the way TEXT and MTEXT do in AutoCAD. */
function InPlaceText({ te, drawing, view, size, onDone, commitRef }: { te: TextEdit; drawing: Drawing; view: View; size: Size; onDone: (v: string | null) => void; commitRef: React.RefObject<(() => void) | null> }) {
  const r = te.req;
  const style = findTextStyle(drawing, r.style);
  const family = fontFamily(style);
  const px = Math.max(6, (r.h * view.scale) / CAP);
  const sp = toScreen(view, size, r.p);
  const deg = (-r.rot * 180) / Math.PI;
  const [value, setValue] = useState(() => (te.kind === 'mtext' ? r.initial.replace(/\\P/g, '\n') : r.initial));
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const mtext = te.kind === 'mtext';
  useEffect(() => {
    commitRef.current = () => onDone(mtext ? (value.trim() ? toMText(value) : null) : value || null);
    return () => {
      commitRef.current = null;
    };
  }, [commitRef, onDone, mtext, value]);
  if (te.kind === 'text') {
    return (
      <input
        ref={ref}
        value={value}
        aria-label="Text"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            onDone(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone(value || null);
          }
        }}
        onBlur={() => onDone(value || null)}
        className="absolute z-30 min-w-[2ch] border border-dashed border-[#3fa9f5]/80 bg-[#3fa9f5]/10 p-0 text-white outline-none [field-sizing:content]"
        style={{ left: sp.x, top: sp.y - px * CAP * 1.18, font: `${px}px / ${px * 1.2}px ${family}`, transform: `rotate(${deg}deg)`, transformOrigin: `0 ${px * CAP * 1.18}px`, caretColor: '#fff' }}
      />
    );
  }
  const req = r as MTextEditRequest;
  const width = req.width > 0 ? req.width * view.scale : undefined;
  return (
    <div className="absolute z-30" style={{ left: sp.x, top: sp.y, transform: `rotate(${deg}deg)`, transformOrigin: '0 0' }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center gap-2 rounded-[3px] border border-[#15191e] bg-[#2f3640] px-2 py-1 text-[11.5px] text-[#c4ccd7] shadow-lg">
        <span>Text Editor</span>
        <span className="text-[#8e98a6]">Ctrl+Enter to close</span>
        <button type="button" onClick={() => onDone(toMText(value))} className="rounded-[2px] bg-[#0696d7] px-2 py-0.5 text-white hover:bg-[#13a7ea]">
          Close Text Editor
        </button>
      </div>
      <textarea
        ref={ref}
        value={value}
        aria-label="Multiline text"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onDone(toMText(value));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone(value.trim() ? toMText(value) : null);
          }
        }}
        rows={Math.max(2, value.split('\n').length + 1)}
        className="resize-none border border-[#3fa9f5] bg-[#212830]/85 p-1 text-white outline-none"
        style={{ width: width ?? Math.max(160, px * 12), font: `${px}px / ${px * (5 / 3) * CAP}px ${family}`, caretColor: '#fff' }}
      />
    </div>
  );
}

/** Typed lines as MTEXT contents. */
const toMText = (s: string) => s.split('\n').map(escapeKeepCodes).join('\\P');

/** Escape MTEXT's special characters in typed text, leaving codes the text already had (editing existing MTEXT) alone. */
function escapeKeepCodes(s: string): string {
  if (/\\[A-Za-z~{}\\]/.test(s)) return s;
  return escapeMText(s);
}

