import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, FilePlus, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, parentPath } from '@/lib/fs';
import { type DinFileHandle } from '@/sdk';
import { useCloseGuard, useDin, useWindowTitle } from '@/sdk/react';
import { looksLikePub, readPub } from './publisher/pub';
import { rasterizeMetafile } from './publisher/pub/raster';
import { pubToIdml } from './publisher/pub/toIdml';
import '@/shared/office/fonts';
import { Button, Dialog } from '@/shared/photo/chrome';
import { Panel } from '@/shared/photo/panels';
import { FOCUS, INPUT } from '@/shared/photo/styles';
import { rgbToCmyk, type Swatch } from './publisher/colors';
import { caretX, lineAt, posAt, resetMeasures, type Composition } from './publisher/compose';
import { ControlPanel, type Geometry, type ObjectInfo, type TypeInfo } from './publisher/control';
import {
  AboutDialog,
  CornerDialog,
  DocumentSetupDialog,
  InsertPagesDialog,
  MarginsDialog,
  NewDocDialog,
  SaveNoteDialog,
  ShortcutsDialog,
  SwatchDialog,
  TextFrameOptionsDialog,
} from './publisher/dialogs';
import { about, apply, boundsOf, dist, invert, mul, rectCorners, rotate, scale, translate, type Mat, type Pt, type Rect } from './publisher/geom';
import { hitTest, marqueeHits } from './publisher/hit';
import { Draft, findSelf, looksLikeIdml, partRoot, readPackage, writePackage, type Pkg } from './publisher/idml';
import { ImageStore, linkPath } from './publisher/images';
import { keepLinks, reachLink } from './publisher/linkTokens';
import { PublisherMenus, type Commands, type MenuState } from './publisher/menus';
import { buildModel, itemBounds, pageAt, spreadAtY, walkItems, type Item, type Model, type Page, type Spread } from './publisher/model';
import { newDocument, type NewDocSettings } from './publisher/newdoc';
import { writePublisherPdf } from './publisher/pdf';
import * as ops from './publisher/ops';
import { CharacterPanel, ColorPanel, LayersPanel, LinksPanel, PagesPanel, ParagraphPanel, StrokePanel, StylesPanel, SwatchesPanel, WrapPanel, type LinkRow } from './publisher/panels';
import { drawOverlay, drawScene, HANDLES, handlePoints, portPoints, spreadToScreen, type Overlay, type SceneOptions, type View } from './publisher/render';
import { DEFAULT_SETTINGS, PANEL_NAMES, type PanelId, geometryOf, readSettings, refPointOf, rulerOrigin, same, snap1, snapLines, unionBounds, unionCorners, writeSettings, type Settings } from './publisher/state';
import { Stories } from './publisher/stories';
import { charLook, paraLook, textChain } from './publisher/styles';
import * as text from './publisher/text';
import { Toolbar } from './publisher/toolbar';
import { TOOL_GROUPS, toolByCode, type ToolId } from './publisher/tools';
import { fmtLength, nudgeStep, rulerSteps, unitLabel } from './publisher/units';

/** Bigger files than this aren't read. */
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_HISTORY = 200;
const OPEN_EXTENSIONS = ['.indd', '.indt', '.idml', '.pub'];
const IDML_FILTER = { name: 'InDesign Markup (IDML)', patterns: ['*.idml'], mimeTypes: ['application/vnd.adobe.indesign-idml-package'] };
const PDF_FILTER = { name: 'PDF', patterns: ['*.pdf'], mimeTypes: ['application/pdf'] };
const PLACE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg'];
const RULER = 16;

interface Typing {
  story: string;
  /** Anchor and caret (the moving end). */
  a: number;
  b: number;
  /** Frame the caret was put in (for empty frames). */
  frame: string;
}

interface Entry {
  label: string;
  pkg: Pkg;
  sel: string[];
  direct: string | null;
  coalesce?: string;
}

interface Hist {
  entries: Entry[];
  index: number;
}

interface Gesture {
  move(p: Pt, e: PointerEvent): void;
  up(p: Pt, e: PointerEvent): void;
  cancel?(): void;
}

interface PlaceGun {
  path: string;
  w: number;
  h: number;
  size: number;
}

type DialogState =
  | { kind: 'new' }
  | { kind: 'frameOptions'; frame: Item }
  | { kind: 'insertPages' }
  | { kind: 'margins' }
  | { kind: 'corners' }
  | { kind: 'swatch'; self: string | null; initial: { name: string; space: 'CMYK' | 'RGB'; values: number[] } }
  | { kind: 'setup' }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'saveNote' }
  | { kind: 'unsaved' }
  | null;

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isIndd = (p: string) => /\.(indd|indt)$/i.test(p);
const isPub = (p: string) => /\.pub$/i.test(p);

/** Formats opened by converting to IDML, which saving can't write back. */
type Converted = 'indd' | 'pub' | null;
const fmtZoom = (z: number) => `${z >= 1 ? Math.round(z * 100) : Math.round(z * 1000) / 10}%`;
const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
const ZOOMS = [0.05, 0.0833, 0.125, 0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40];
const zoomStep = (z: number, dir: 1 | -1) => (dir > 0 ? (ZOOMS.find((s) => s > z * 1.01) ?? 40) : ([...ZOOMS].reverse().find((s) => s < z * 0.99) ?? 0.05));

/**
 * Publisher - documents laid out in pages, InDesign style: opens Microsoft
 * Publisher documents (.pub, converted by ./publisher/pub), InDesign
 * documents (.indd and .indt, read with indd-utils) and IDML, with InDesign's
 * tools, Control panel, panels, menus and shortcuts; frames, shapes, threaded
 * text with paragraph and character styles, placed images, master pages and
 * layers. Saves IDML, which InDesign opens.
 *
 * Launched with a file, it opens that; launch params `{ newDoc }` start a
 * new document (File > New from another window). Placed graphics are
 * links to files by path, found where they were placed or beside the
 * document as InDesign finds them: `file-folders` reaches the folders of
 * the document and of pictures placed, and links elsewhere keep a handle
 * across restarts (publisher/linkTokens).
 */
export function Publisher() {
  const din = useDin();
  const params = din.app.launch.params;
  const initial = din.app.launch.files[0] ?? null;

  const [settings, setSettings] = useState<Settings>(readSettings);
  const { panels } = settings;
  const [tool, setToolState] = useState<ToolId>(settings.tool === 'type' ? 'select' : settings.tool);
  // File > New from another window opens this one with the new document's settings.
  const [boot] = useState(() => {
    const nd = params?.newDoc;
    if (initial || !isNewDocSettings(nd)) return null;
    const entry: Entry = { label: 'New', pkg: newDocument(nd), sel: [], direct: null };
    return entry;
  });
  const [hist, setHist] = useState<Hist | null>(() => (boot ? { entries: [boot], index: 0 } : null));
  const [savedEntry, setSavedEntry] = useState<Entry | null>(boot);
  const [file, setFile] = useState<DinFileHandle | null>(null);
  const [docName, setDocName] = useState('Untitled-1');
  const [converted, setConverted] = useState<Converted>(null);
  const [loading, setLoading] = useState(initial !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [zoomShown, setZoomShown] = useState(1);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [masterView, setMasterView] = useState(false);
  const [currentPage, setCurrentPage] = useState<string | null>(null);
  const [pagesSel, setPagesSel] = useState<Set<string>>(new Set());
  const [placeGun, setPlaceGun] = useState<PlaceGun | null>(null);
  const [threadGun, setThreadGun] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [zoomKey, setZoomKey] = useState<'in' | 'out' | null>(null);
  const [panning, setPanning] = useState(false);
  const [preview, setPreview] = useState(false);
  const [hidePanels, setHidePanels] = useState(false);
  const [activeAttr, setActiveAttr] = useState<'fill' | 'stroke'>('fill');
  const [affectsText, setAffectsText] = useState(false);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hasClip, setHasClip] = useState(false);
  const [linkSel, setLinkSel] = useState<string | null>(null);
  const [pendingChar, setPendingChar] = useState<text.Attrs | null>(null);
  const [cursorHint, setCursorHint] = useState<string | null>(null);
  const [images, setImages] = useState<ImageStore | null>(null);
  const [imagesVersion, setImagesVersion] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [layerPick, setLayerPick] = useState<string | null>(null);

  const cur = hist ? hist.entries[hist.index] : null;
  const pkg = cur?.pkg ?? null;
  const model = useMemo(() => {
    if (!pkg) return null;
    try {
      return buildModel(pkg);
    } catch {
      return null;
    }
  }, [pkg]);
  const dirty = !!cur && cur.pkg !== savedEntry?.pkg;
  const spreads = useMemo(() => (model ? (masterView ? model.masters : model.spreads) : []), [model, masterView]);
  const sel = useMemo(() => (cur && model ? cur.sel.filter((s) => model.items.has(s)) : []), [cur, model]);
  const direct = cur && model && cur.direct && model.items.has(cur.direct) ? cur.direct : null;
  const selItems = useMemo(() => (model ? (direct ? [model.items.get(direct)!] : sel.map((s) => model.items.get(s)!).filter(Boolean)) : []), [model, sel, direct]);
  const unit = model?.prefs.hUnit ?? 'p';

  // ---- Refs the render loop and gestures read ----------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<View>({ zoom: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const gestureRef = useRef<Gesture | null>(null);
  const rafScene = useRef(0);
  const rafOverlay = useRef(0);
  const overridesRef = useRef<Map<string, Item>>(new Map());
  const ovRef = useRef<Pick<Overlay, 'marquee' | 'draft' | 'guide' | 'pen' | 'pivot'>>({ marquee: null, draft: null, guide: null, pen: null, pivot: null });
  const hoverRef = useRef<{ item: Item; spread: Spread } | null>(null);
  const storiesRef = useRef(new Stories());
  const imagesRef = useRef<ImageStore | null>(null);
  const previewsRef = useRef<Map<string, Uint8Array>>(new Map());
  const modelRef = useRef<Model | null>(null);
  const spreadsRef = useRef<Spread[]>([]);
  const stateRef = useRef({ sel: [] as string[], direct: null as string | null, typing: null as Typing | null, preview: false, settings: DEFAULT_SETTINGS, caretOn: true, threadGun: null as string | null });
  const fontsAsked = useRef(new Set<string>());
  const fitPending = useRef(boot !== null);
  const loadSeq = useRef(0);
  const clipboard = useRef<{ els: Element[]; text: string | null; spread: string | null } | null>(null);
  const penRef = useRef<{ pts: { anchor: Pt; left: Pt; right: Pt }[] } | null>(null);
  const lastClick = useRef<{ t: number; x: number; y: number; n: number }>({ t: 0, x: 0, y: 0, n: 0 });
  const composing = useRef(false);
  const caretRef = useRef(true);
  const errorsRef = useRef(0);

  useLayoutEffect(() => {
    modelRef.current = model;
    spreadsRef.current = spreads;
    stateRef.current = { sel, direct, typing, preview, settings, caretOn: caretRef.current, threadGun };
  });

  useEffect(() => writeSettings({ ...settings, tool }), [settings, tool]);
  const setSetting = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v })), []);

  const title = model ? `${dirty ? '• ' : ''}${docName} @ ${fmtZoom(zoomShown)}${preview ? ' [Preview]' : ''}` : 'Publisher';
  useWindowTitle(title);

  // ---- Text -------------------------------------------------------------------------------------

  const textSource = useMemo(
    () => ({
      comp: (story: string, page: Page | null) => {
        const m = modelRef.current;
        if (!m) return null;
        const c = storiesRef.current.comp(m, story, page, overridesRef.current);
        if (c) for (const f of c.fonts) if (!fontsAsked.current.has(f)) needFont(f);
        return c;
      },
      frameIndex: (it: Item) => {
        const m = modelRef.current;
        if (!m || !it.text) return 0;
        return Math.max(0, (m.threads.get(it.text.story) ?? []).findIndex((f) => f.self === it.self));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** The composition of a story as it shows on its first frame's page. */
  const compOf = useCallback((story: string): Composition | null => {
    const m = modelRef.current;
    if (!m) return null;
    const first = m.threads.get(story)?.[0];
    const s = first ? m.spreadOf.get(first.self) : undefined;
    const page = s && first ? (s.pages.length === 1 ? s.pages[0] : (s.pages.find((p) => p.bounds.x <= itemBounds(first).x + 1 && itemBounds(first).x < p.bounds.x + p.bounds.w) ?? s.pages[0])) : null;
    return storiesRef.current.comp(m, story, s?.isMaster ? null : page, overridesRef.current);
  }, []);

  // ---- Drawing ----------------------------------------------------------------------------------

  const sceneOptions = (): SceneOptions | null => {
    const m = modelRef.current;
    const st = stateRef.current;
    if (!m) return null;
    imagesRef.current ??= new ImageStore(() => scheduleScene(), new Map(), null);
    return {
      model: m,
      spreads: spreadsRef.current,
      view: viewRef.current,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
      dpr: window.devicePixelRatio || 1,
      preview: st.preview,
      showGuides: st.settings.guides,
      showFrameEdges: st.settings.frameEdges,
      showThreads: st.settings.threads,
      images: imagesRef.current,
      text: textSource,
      overrides: overridesRef.current,
      partEls: (part) => m.pkg.xml.get(part),
    };
  };

  const drawSceneNow = () => {
    rafScene.current = 0;
    const canvas = sceneRef.current;
    const o = sceneOptions();
    if (!canvas || !o) return;
    const c = canvas.getContext('2d')!;
    drawScene(c, o);
    if (stateRef.current.settings.hidden && !o.preview) drawHidden(c, o);
    // Overset text counts as an error, as in InDesign's preflight.
    let n = 0;
    for (const [story] of o.model.threads) if (compOf(story)?.overset) n++;
    if (n !== errorsRef.current) {
      errorsRef.current = n;
      setErrorCount(n);
    }
  };

  /** Hidden characters: paragraph marks, tabs and spaces, in Type's blue. */
  const drawHidden = (c: CanvasRenderingContext2D, o: SceneOptions) => {
    c.save();
    c.fillStyle = '#4a7fd8';
    for (const [story, frames] of o.model.threads) {
      const comp = compOf(story);
      if (!comp) continue;
      frames.forEach((f, fi) => {
        const s = o.model.spreadOf.get(f.self);
        if (!s || !o.spreads.includes(s)) return;
        const m = mul([o.dpr, 0, 0, o.dpr, 0, 0], mul(spreadToScreen(o.view, s), f.m));
        c.setTransform(...m);
        for (const l of comp.byFrame[fi] ?? []) {
          for (const p of l.pieces) {
            const ch = comp.flat.text[p.start];
            const size = p.look.size * 0.8;
            c.font = `${size}px sans-serif`;
            if (ch === '\r') c.fillText('¶', p.x + 1, l.y);
            else if (ch === '\t') c.fillText('»', p.x + 1, l.y);
            else if (ch === '\u2028') c.fillText('¬', p.x + 1, l.y);
            else if (p.space && p.text) for (let k = 0; k < p.text.length; k++) c.fillText('·', p.x + (p.w / p.text.length) * k + p.w / p.text.length / 3, l.y);
          }
        }
        if (fi === frames.length - 1 && comp.byFrame[fi]?.length) {
          const last = comp.byFrame[fi][comp.byFrame[fi].length - 1];
          if (last.end >= comp.flat.text.length && !comp.overset) c.fillText('#', caretX(last, last.end) + 1, last.y);
        }
      });
    }
    c.restore();
  };

  const overlayState = (): Overlay | null => {
    const m = modelRef.current;
    const st = stateRef.current;
    if (!m) return null;
    const ov = overridesRef.current;
    const live = (it: Item) => ov.get(it.self) ?? it;
    const selected = (st.direct ? [st.direct] : st.sel)
      .map((s) => {
        const it = m.items.get(s);
        const sp = m.spreadOf.get(s);
        if (!it || !sp || !spreadsRef.current.includes(sp)) return null;
        // Children of a moved group move with it.
        let item = live(it);
        if (it.parent && st.direct) {
          const parent = m.items.get(it.parent);
          const lp = parent && ov.get(parent.self);
          if (lp) item = { ...item, m: mul(lp.m, item.local) };
        }
        return { item, spread: sp, content: !!st.direct };
      })
      .filter((x): x is { item: Item; spread: Spread; content: boolean } => !!x);
    const overset = new Set<string>();
    for (const s of selected) {
      if (s.item.kind !== 'text' || !s.item.text) continue;
      const frames = m.threads.get(s.item.text.story) ?? [];
      if (frames[frames.length - 1]?.self !== s.item.self) continue;
      const comp = compOf(s.item.text.story);
      if (comp?.overset) overset.add(s.item.self);
    }
    let textOv: Overlay['text'] = null;
    if (st.typing) {
      const comp = compOf(st.typing.story);
      const frames = (m.threads.get(st.typing.story) ?? []).map((f, index) => ({ item: live(f), spread: m.spreadOf.get(f.self)!, index })).filter((f) => f.spread && spreadsRef.current.includes(f.spread));
      if (comp) textOv = { comp, frames, a: Math.min(st.typing.a, st.typing.b), b: Math.max(st.typing.a, st.typing.b), caret: st.caretOn };
    }
    const many = selected.length > 1 && !st.direct;
    const firstSpread = selected[0]?.spread;
    return {
      selected: st.typing ? [] : selected,
      groupBox: many && firstSpread ? { corners: unionCorners(selected.map((x) => x.item)), spread: firstSpread } : null,
      showHandles: !st.typing,
      hover: hoverRef.current && !st.typing ? { item: live(hoverRef.current.item), spread: hoverRef.current.spread } : null,
      text: textOv,
      overset,
      ...ovRef.current,
    };
  };

  const drawRulers = (c: CanvasRenderingContext2D) => {
    const { w, h } = sizeRef.current;
    const v = viewRef.current;
    const m = modelRef.current;
    if (!m) return;
    const s = spreadAtY(spreadsRef.current, (h / 2 - v.y) / v.zoom);
    const origin = s ? rulerOrigin(s) : { x: 0, y: 0 };
    const oy = (s?.y ?? 0) + origin.y;
    c.fillStyle = '#323232';
    c.fillRect(0, 0, w, RULER);
    c.fillRect(0, 0, RULER, h);
    c.strokeStyle = '#8a8a8a';
    c.fillStyle = '#bdbdbd';
    c.lineWidth = 1;
    c.font = '9px "Inter Variable", sans-serif';
    const draw = (horizontal: boolean, u: typeof m.prefs.hUnit) => {
      const { major, minor } = rulerSteps(u, v.zoom);
      const o = horizontal ? origin.x : oy;
      const toScreen = (p: number) => (horizontal ? v.x + p * v.zoom : v.y + p * v.zoom);
      const span = horizontal ? w : h;
      const from = Math.floor(((horizontal ? -v.x : -v.y) / v.zoom - o) / major) * major;
      const to = ((horizontal ? w - v.x : h - v.y) / v.zoom - o) + major;
      c.beginPath();
      for (let p = from; p <= to; p += major) {
        for (let k = 0; k < minor; k++) {
          const q = p + (major / minor) * k;
          const sp = Math.round(toScreen(q + o)) + 0.5;
          if (sp < RULER || sp > span) continue;
          const len = k === 0 ? RULER : k === minor / 2 ? 6 : 3;
          if (horizontal) {
            c.moveTo(sp, RULER);
            c.lineTo(sp, RULER - len);
          } else {
            c.moveTo(RULER, sp);
            c.lineTo(RULER - len, sp);
          }
        }
        const sp = toScreen(p + o);
        if (sp < RULER || sp > span) continue;
        const label = unitLabel(p, u);
        if (horizontal) c.fillText(label, sp + 2, 9);
        else {
          c.save();
          c.translate(9, sp + 2);
          c.rotate(-Math.PI / 2);
          c.fillText(label, -c.measureText(label).width - 2, 0);
          c.restore();
        }
      }
      c.stroke();
    };
    draw(true, m.prefs.hUnit);
    draw(false, m.prefs.vUnit);
    c.fillStyle = '#2a2a2a';
    c.fillRect(0, 0, RULER, RULER);
    c.strokeStyle = '#1c1c1c';
    c.beginPath();
    c.moveTo(0, RULER + 0.5);
    c.lineTo(w, RULER + 0.5);
    c.moveTo(RULER + 0.5, 0);
    c.lineTo(RULER + 0.5, h);
    c.stroke();
  };

  const drawOverlayNow = () => {
    rafOverlay.current = 0;
    const canvas = overlayRef.current;
    const o = sceneOptions();
    const ov = overlayState();
    if (!canvas || !o || !ov) return;
    const c = canvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    drawOverlay(c, o, ov);
    if (stateRef.current.settings.rulers) {
      c.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
      drawRulers(c);
    }
    // The type box sits at the caret, for input methods.
    const ta = textareaRef.current;
    const t = stateRef.current.typing;
    if (ta && t && ov.text) {
      const l = lineAt(ov.text.comp, t.b);
      const f = l ? ov.text.frames.find((x) => x.index === l.frame) : ov.text.frames[0];
      if (f) {
        const pt = l ? { x: caretX(l, t.b), y: l.y } : { x: f.item.box.x, y: f.item.box.y };
        const sp = apply(mul(spreadToScreen(o.view, f.spread), f.item.m), pt);
        ta.style.left = `${Math.round(sp.x)}px`;
        ta.style.top = `${Math.round(sp.y - 14)}px`;
      }
    }
  };

  const scheduleScene = useCallback(() => {
    if (!rafScene.current) rafScene.current = requestAnimationFrame(drawSceneNow);
    if (!rafOverlay.current) rafOverlay.current = requestAnimationFrame(drawOverlayNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const scheduleOverlay = useCallback(() => {
    if (!rafOverlay.current) rafOverlay.current = requestAnimationFrame(drawOverlayNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafScene.current);
      cancelAnimationFrame(rafOverlay.current);
    },
    [],
  );

  function needFont(font100: string) {
    fontsAsked.current.add(font100);
    if (typeof document === 'undefined' || !document.fonts) return;
    void document.fonts
      .load(font100.replace(' 100px ', ' 16px '))
      .then((faces) => {
        if (!faces.length) return;
        resetMeasures();
        storiesRef.current.clear();
        scheduleScene();
      })
      .catch(() => {});
  }

  // Redraw when anything drawn changes.
  useLayoutEffect(() => {
    scheduleScene();
  }, [model, spreads, preview, settings.guides, settings.frameEdges, settings.threads, settings.hidden, scheduleScene]);
  useLayoutEffect(() => {
    scheduleOverlay();
  }, [sel, direct, typing, settings.rulers, scheduleOverlay]);

  // The caret blinks.
  useEffect(() => {
    if (!typing) return;
    caretRef.current = true;
    const t = setInterval(() => {
      caretRef.current = !caretRef.current;
      stateRef.current.caretOn = caretRef.current;
      scheduleOverlay();
    }, 530);
    return () => clearInterval(t);
  }, [typing, scheduleOverlay]);

  // Thumbnails catch up a moment after edits.
  useEffect(() => {
    const t = setTimeout(() => setThumbVersion((v) => v + 1), 400);
    return () => clearTimeout(t);
  }, [model]);

  // ---- View -------------------------------------------------------------------------------------

  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      setZoomShown(v.zoom);
      scheduleScene();
      // The current page follows the middle of the window.
      const { w, h } = sizeRef.current;
      const hit = pageAt(spreadsRef.current, { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom });
      const self = hit?.page?.self ?? null;
      setCurrentPage((p) => (p === self ? p : self));
    },
    [scheduleScene],
  );

  /** Fits a pasteboard rectangle into the window. */
  const fitRect = useCallback(
    (r: Rect, maxZoom = 40) => {
      const { w, h } = sizeRef.current;
      if (!w || !h) {
        fitPending.current = true;
        return;
      }
      const pad = 40;
      const z = Math.max(0.02, Math.min(maxZoom, (w - RULER - pad * 2) / r.w, (h - RULER - pad * 2) / r.h));
      setView({ zoom: z, x: RULER + (w - RULER) / 2 - (r.x + r.w / 2) * z, y: RULER + (h - RULER) / 2 - (r.y + r.h / 2) * z });
    },
    [setView],
  );

  const pageRect = (s: Spread, p: Page): Rect => ({ x: p.bounds.x, y: p.bounds.y + s.y, w: p.bounds.w, h: p.bounds.h });
  const spreadRect = (s: Spread): Rect => ({ x: s.bounds.x, y: s.bounds.y + s.y, w: s.bounds.w, h: s.bounds.h });

  const currentSpread = (): Spread | null => {
    const { h } = sizeRef.current;
    const v = viewRef.current;
    return spreadAtY(spreadsRef.current, (h / 2 - v.y) / v.zoom);
  };
  const currentPageObj = (): { spread: Spread; page: Page } | null => {
    const { w, h } = sizeRef.current;
    const v = viewRef.current;
    const hit = pageAt(spreadsRef.current, { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom });
    return hit && hit.page ? { spread: hit.spread, page: hit.page } : null;
  };

  const fitPage = (p?: { spread: Spread; page: Page } | null) => {
    const t = p ?? currentPageObj();
    if (t) fitRect(pageRect(t.spread, t.page));
  };

  const goToPage = (s: Spread, p: Page) => {
    const v = viewRef.current;
    const r = pageRect(s, p);
    const { w, h } = sizeRef.current;
    // Keep the zoom if the page fits; otherwise fit it.
    if (r.w * v.zoom < w - 60 && r.h * v.zoom < h - 60) setView({ ...v, x: RULER + (w - RULER) / 2 - (r.x + r.w / 2) * v.zoom, y: RULER + (h - RULER) / 2 - (r.y + r.h / 2) * v.zoom });
    else fitRect(r);
  };

  const zoomAt = useCallback(
    (z: number, sx?: number, sy?: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const mx = sx ?? w / 2;
      const my = sy ?? h / 2;
      const nz = Math.max(0.02, Math.min(40, z));
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
      const dpr = window.devicePixelRatio || 1;
      for (const c of [sceneRef.current, overlayRef.current]) {
        if (!c) continue;
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
      }
      if (fitPending.current && modelRef.current && r.width && r.height) {
        fitPending.current = false;
        const s = spreadsRef.current[0];
        if (s?.pages[0]) fitRect(pageRect(s, s.pages[0]));
      } else if (was.w && was.h) {
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + (r.width - was.w) / 2, y: v.y + (r.height - was.h) / 2 };
      }
      scheduleScene();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRect, scheduleScene, model !== null]);

  // ---- History ----------------------------------------------------------------------------------

  const commit = useCallback(
    (label: string, next: Pkg, opts: { sel?: string[]; direct?: string | null; coalesce?: string } = {}) => {
      overridesRef.current = new Map();
      setHist((h) => {
        if (!h) return h;
        const top = h.entries[h.index];
        if (next === top.pkg && opts.sel === undefined && opts.direct === undefined) return h;
        const entry: Entry = { label, pkg: next, sel: opts.sel ?? top.sel, direct: opts.direct !== undefined ? opts.direct : opts.sel !== undefined ? null : top.direct, coalesce: opts.coalesce };
        const entries = h.entries.slice(0, h.index + 1);
        if (opts.coalesce && top.coalesce === opts.coalesce && h.index > 0) entries[entries.length - 1] = entry;
        else entries.push(entry);
        while (entries.length > MAX_HISTORY) entries.shift();
        return { entries, index: entries.length - 1 };
      });
      setStatus(null);
    },
    [],
  );

  /** Changes the selection without an undo step. */
  const select = useCallback((selves: string[], directSelf: string | null = null) => {
    setHist((h) => {
      if (!h) return h;
      const entries = [...h.entries];
      entries[h.index] = { ...entries[h.index], sel: selves, direct: directSelf };
      return { ...h, entries };
    });
  }, []);

  const jump = useCallback(
    (index: number) => {
      if (!hist || index < 0 || index >= hist.entries.length) return;
      overridesRef.current = new Map();
      setHist({ ...hist, index });
      setTyping((t) => {
        if (!t) return t;
        const e = hist.entries[index];
        const m = buildModel(e.pkg);
        if (!m.stories.has(t.story)) return null;
        const part = m.stories.get(t.story)!;
        const root = partRoot(e.pkg.xml.get(part)!);
        const len = root ? text.flatten(root).text.length : 0;
        return { ...t, a: Math.min(t.a, len), b: Math.min(t.b, len) };
      });
    },
    [hist],
  );

  const startDoc = useCallback(
    (p: Pkg, name: string, f: DinFileHandle | null, from: Converted, previews: Map<string, Uint8Array>) => {
      const m0 = buildModel(p);
      const entry: Entry = { label: f ? 'Open' : 'New', pkg: p, sel: [], direct: null };
      previewsRef.current = previews;
      const store = new ImageStore(
        () => {
          scheduleScene();
          setImagesVersion((v) => v + 1);
        },
        previews,
        f?.path ? parentPath(f.path) : null,
        (path) => reachLink(din, path),
      );
      imagesRef.current = store;
      setImages(store);
      storiesRef.current = new Stories();
      setHist({ entries: [entry], index: 0 });
      setSavedEntry(entry);
      setFile(f);
      setDocName(name);
      setConverted(from);
      setTyping(null);
      setMasterView(false);
      setError(null);
      setPlaceGun(null);
      setThreadGun(null);
      setPagesSel(new Set(m0.pages[0] ? [m0.pages[0].self] : []));
      overridesRef.current = new Map();
      fitPending.current = true;
      requestAnimationFrame(() => {
        if (!sizeRef.current.w) return;
        fitPending.current = false;
        const s = m0.spreads[0];
        if (s?.pages[0]) fitRect(pageRect(s, s.pages[0]));
      });
    },
    [din, fitRect, scheduleScene],
  );

  // ---- Files ------------------------------------------------------------------------------------

  const load = useCallback(
    (f: DinFileHandle) => {
      const seq = ++loadSeq.current;
      (async () => {
        try {
          const blob = await f.getFile();
          if (blob.size > MAX_BYTES) throw new Error(`It’s too big to open (${formatBytes(blob.size)}; up to 1 GB).`);
          const data = new Uint8Array(await blob.arrayBuffer());
          let pk: Pkg;
          const previews = new Map<string, Uint8Array>();
          let warn: string[] = [];
          let from: Converted = null;
          if (isPub(f.name) || looksLikePub(data)) {
            from = 'pub';
            const doc = readPub(data);
            pk = await pubToIdml(doc, rasterizeMetafile);
            warn = [...doc.warnings];
          } else if (isIndd(f.name) || !looksLikeIdml(data)) {
            from = 'indd';
            const bridge = din.system.indd;
            if (!bridge) throw new Error('Publisher can’t read InDesign documents outside Din.');
            const conv = await bridge.convert(data, f.name);
            for (const pr of conv.previews) for (const g of pr.graphics) previews.set(g, pr.data);
            warn = conv.warnings;
            pk = readPackage(conv.idml);
          } else pk = readPackage(data);
          if (seq !== loadSeq.current) return;
          startDoc(pk, f.name, f, from, previews);
          setWarnings(warn);
          if (warn.length && from === 'pub') setStatus(warn.length === 1 ? warn[0] : `Opened with ${warn.length} things that look different from Publisher.`);
          else if (warn.length) setStatus(`Opened with ${warn.length} ${warn.length === 1 ? 'thing' : 'things'} InDesign keeps that couldn’t be read.`);
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

  useEffect(() => {
    if (initial) load(initial);
  }, [initial, load]);

  // Keys go to the editor when nothing else has them.
  useEffect(() => {
    if (dialog || typing) return;
    const a = document.activeElement;
    if (!a || a === document.body || !rootRef.current?.contains(a)) rootRef.current?.focus({ preventScroll: true });
  }, [dialog, typing]);

  const writeTo = useCallback(
    async (f: DinFileHandle): Promise<boolean> => {
      if (!hist) return false;
      const entry = hist.entries[hist.index];
      setBusy(true);
      setStatus('Saving…');
      try {
        await new Promise((r) => setTimeout(r, 30));
        await f.write(writePackage(entry.pkg));
        const linked: string[] = [];
        for (const it of buildModel(entry.pkg).items.values()) {
          const p = it.kind === 'graphic' && it.graphic && !it.graphic.embedded ? linkPath(it.graphic.link) : null;
          if (p) linked.push(p);
        }
        void keepLinks(din, f.key, parentPath(f.path), linked);
        setSavedEntry(entry);
        setFile(f);
        setDocName(f.name);
        setConverted(null);
        setStatus(`Saved ${f.name}`);
        return true;
      } catch (err) {
        setStatus(`Couldn’t save ${f.name}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [din, hist],
  );

  /** Din's save dialog for one type; false when the name it comes back with doesn't end in it. */
  const saveTarget = useCallback(
    async (title: string, suggestedName: string, type: { description: string; extension: string }) => {
      const t = await din.files.save({ title, suggestedName, startIn: file ?? undefined, types: [{ description: type.description, extensions: [type.extension] }] });
      if (t && !t.name.toLowerCase().endsWith(type.extension)) {
        setStatus(`Couldn’t save ${t.name}: its name should end in ${type.extension}.`);
        return null;
      }
      return t;
    },
    [din, file],
  );

  const saveAs = useCallback(async (): Promise<boolean> => {
    const stem = docName.replace(/\.[^.]*$/, '');
    const t = await saveTarget('Save As', `${stem}.idml`, { description: IDML_FILTER.name, extension: '.idml' });
    return t ? writeTo(t) : false;
  }, [docName, saveTarget, writeTo]);

  const save = useCallback((): Promise<boolean> => {
    if (!hist) return Promise.resolve(false);
    if (file?.writable && !converted && /\.idml$/i.test(file.name)) return writeTo(file);
    if (converted) {
      setDialog({ kind: 'saveNote' });
      return Promise.resolve(false);
    }
    return saveAs();
  }, [hist, file, converted, writeTo, saveAs]);

  const pick = useCallback(
    async (title: string, description: string, extensions: string[]) =>
      (await din.files.open({ title, types: [{ description, extensions }], startIn: file ?? undefined }))[0] ?? null,
    [din, file],
  );

  const openFile = useCallback(async () => {
    const t = await pick('Open', 'Documents', OPEN_EXTENSIONS);
    if (!t) return;
    if (modelRef.current) {
      void din.app.open('publisher', {}, [t]);
      return;
    }
    setLoading(true);
    setError(null);
    load(t);
  }, [din, pick, load]);

  // Closing with unsaved changes asks first.
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

  // ---- Rendering pages to pictures (export, print, thumbnails) -----------------------------------------

  const renderPage = (s: Spread, p: Page, k: number): HTMLCanvasElement | null => {
    const m = modelRef.current;
    if (!m || !imagesRef.current) return null;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(p.bounds.w * k));
    c.height = Math.max(1, Math.round(p.bounds.h * k));
    const ctx = c.getContext('2d')!;
    drawScene(ctx, {
      model: m,
      spreads: [s],
      view: { zoom: k, x: -p.bounds.x * k, y: -(p.bounds.y + s.y) * k },
      width: c.width,
      height: c.height,
      dpr: 1,
      preview: true,
      showGuides: false,
      showFrameEdges: false,
      showThreads: false,
      images: imagesRef.current,
      text: textSource,
      overrides: new Map(),
      partEls: (part) => m.pkg.xml.get(part),
    });
    return c;
  };

  const [drawThumb] = useState(() => (s: Spread, canvas: HTMLCanvasElement, w: number, h: number) => {
      const m = modelRef.current;
      if (!m || !imagesRef.current) return;
      const dpr = 2;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const k = (w / (s.bounds.w || 1)) * dpr;
      drawScene(canvas.getContext('2d')!, {
        model: m,
        spreads: [s],
        view: { zoom: k, x: -s.bounds.x * k, y: -(s.bounds.y + s.y) * k },
        width: canvas.width,
        height: canvas.height,
        dpr: 1,
        preview: true,
        showGuides: false,
        showFrameEdges: false,
        showThreads: false,
        images: imagesRef.current,
        text: textSource,
        overrides: new Map(),
        partEls: (part) => m.pkg.xml.get(part),
      });
    });

  const exportPng = async () => {
    const t = currentPageObj();
    if (!t) return;
    const stem = docName.replace(/\.[^.]*$/, '');
    const out = await saveTarget('Export', `${stem}-${t.page.name}.png`, { description: 'PNG', extension: '.png' });
    if (!out) return;
    setBusy(true);
    setStatus('Exporting…');
    try {
      // 150 ppi, as InDesign's default for PNG export.
      const c = renderPage(t.spread, t.page, 150 / 72);
      if (!c) return;
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('The page couldn’t be drawn.');
      await out.write(blob);
      setStatus(`Exported page ${t.page.name} to ${out.name}`);
    } catch (err) {
      setStatus(`Couldn’t export: ${err instanceof Error ? err.message : cleanFsError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    const m = modelRef.current;
    const images = imagesRef.current;
    if (!m || !images) return;
    const stem = docName.replace(/\.[^.]*$/, '');
    const out = await saveTarget('Export', `${stem}.pdf`, { description: PDF_FILTER.name, extension: '.pdf' });
    if (!out) return;
    setBusy(true);
    setStatus('Exporting…');
    try {
      // Every story's fonts loaded (for the characters it has) before anything is measured for the PDF.
      const wanted = new Map<string, Set<string>>();
      for (const story of m.threads.keys()) {
        const comp = storiesRef.current.comp(m, story, null);
        if (!comp) continue;
        const gather = (c: Composition) => {
          for (const l of c.lines) {
            for (const p of l.pieces) {
              if (p.table) for (const cell of p.table.cells) gather(cell.comp);
              else if (p.text) {
                const set = wanted.get(p.look.font) ?? new Set<string>();
                for (const ch of p.text) set.add(ch);
                wanted.set(p.look.font, set);
              }
            }
          }
        };
        gather(comp);
      }
      await Promise.all([...wanted].map(([f, chars]) => document.fonts.load(f.replace(' 100px ', ' 16px '), [...chars].join('') || ' ').catch(() => [])));
      resetMeasures();
      storiesRef.current.clear();
      const { bytes, notes } = await writePublisherPdf({ model: m, images, text: textSource, title: stem });
      await out.write(bytes);
      setStatus(`Exported ${out.name}${notes.length ? ` (${notes.join(' ')})` : ''}`);
    } catch (err) {
      setStatus(`Couldn’t export: ${err instanceof Error ? err.message : cleanFsError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const printPdf = async () => {
    const m = modelRef.current;
    if (!m) return;
    setBusy(true);
    setStatus('Preparing pages…');
    try {
      await new Promise((r) => setTimeout(r, 30));
      const parts: string[] = [];
      const w = m.prefs.pageW;
      const h = m.prefs.pageH;
      for (const s of m.spreads) {
        for (const p of s.pages) {
          const c = renderPage(s, p, 200 / 72);
          if (c) parts.push(`<img src="${c.toDataURL('image/jpeg', 0.92)}" alt="">`);
        }
      }
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${w}pt ${h}pt;margin:0}html,body{margin:0}img{display:block;width:${w}pt;height:${h}pt;page-break-after:always}</style></head><body>${parts.join('')}</body></html>`;
      await din.print.html(docName, html);
      setStatus('Choose “Save as PDF” in the print dialog to export a PDF.');
    } catch (err) {
      setStatus(`Couldn’t print: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---- Editing helpers --------------------------------------------------------------------------------

  const say = (msg: string) => setStatus(msg);

  /** Runs an edit on a draft of the document and commits it. */
  const edit = (label: string, fn: (d: Draft, m: Model) => void | { sel?: string[]; direct?: string | null }, coalesce?: string) => {
    const m = modelRef.current;
    if (!m) return;
    const d = new Draft(m.pkg);
    const r = fn(d, m);
    const next = d.done();
    if (next === m.pkg && !(r && r.sel)) return;
    commit(label, next, { ...(r ?? {}), coalesce });
  };

  const activeLayer = (): string => (layerPick && modelRef.current?.layers.some((l) => l.self === layerPick) ? layerPick : activeLayerOf(modelRef.current));

  const toPb = (e: { clientX: number; clientY: number }): Pt => {
    const r = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
  };
  const toScreen = (p: Pt): Pt => {
    const v = viewRef.current;
    return { x: v.x + p.x * v.zoom, y: v.y + p.y * v.zoom };
  };

  const isEditable = (it: Item) => {
    const m = modelRef.current;
    const layer = m?.layers.find((l) => l.self === it.layer);
    return !it.locked && !layer?.locked;
  };

  // ---- Typing -------------------------------------------------------------------------------------

  const flatOf = (story: string): text.Flat | null => {
    const m = modelRef.current;
    const part = m?.stories.get(story);
    const doc = part ? m!.pkg.xml.get(part) : undefined;
    const root = doc && partRoot(doc);
    return root ? text.flatten(root) : null;
  };

  const startTyping = (frame: Item, pos: number, anchor?: number) => {
    if (!frame.text) return;
    setTyping({ story: frame.text.story, a: anchor ?? pos, b: pos, frame: frame.self });
    caretRef.current = true;
    if (tool !== 'type') setToolState('type');
    select([frame.self]);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  };

  const stopTyping = (keepFrame = true) => {
    const t = stateRef.current.typing;
    setTyping(null);
    setPendingChar(null);
    if (t && keepFrame) {
      const m = modelRef.current;
      const f = m?.items.get(t.frame);
      const top = f?.parent ? null : f;
      select(top ? [top.self] : []);
    }
    rootRef.current?.focus({ preventScroll: true });
  };

  /** An edit to the story being typed in; `fn` returns the new selection. */
  const editText = (label: string, fn: (root: Element, f: text.Flat) => [number, number] | number, coalesce?: string) => {
    const t = stateRef.current.typing;
    const m = modelRef.current;
    if (!t || !m) return;
    const d = new Draft(m.pkg);
    const root = ops.storyRoot(d, m, t.story);
    if (!root) return;
    const r = fn(root, text.flatten(root));
    const [a, b] = typeof r === 'number' ? [r, r] : r;
    commit(label, d.done(), { coalesce });
    setTyping({ ...t, a, b });
    caretRef.current = true;
  };

  const typeText = (raw: string) => {
    const t = stateRef.current.typing;
    const s = text.cleanTyped(raw);
    if (!t || !s) return;
    const lo = Math.min(t.a, t.b);
    const hi = Math.max(t.a, t.b);
    const pc = pendingChar;
    editText(
      'Typing',
      (root) => {
        if (hi > lo) text.deleteRange(root, lo, hi);
        const end = text.insertText(root, lo, s);
        if (pc) text.applyChar(root, lo, end, pc);
        return end;
      },
      `type:${t.story}`,
    );
    setPendingChar(null);
  };

  const deleteText = (dir: -1 | 1, word: boolean) => {
    const t = stateRef.current.typing;
    if (!t) return;
    const f = flatOf(t.story);
    if (!f) return;
    let lo = Math.min(t.a, t.b);
    let hi = Math.max(t.a, t.b);
    if (lo === hi) {
      if (dir < 0) lo = word ? text.nextWord(f.text, lo, -1) : Math.max(0, lo - 1);
      else hi = word ? text.nextWord(f.text, hi, 1) : Math.min(f.text.length, hi + 1);
    }
    if (hi <= lo) return;
    editText(
      'Delete Text',
      (root) => {
        text.deleteRange(root, lo, hi);
        return lo;
      },
      `del:${t.story}`,
    );
  };

  const applyCharAttrs = (attrs: text.Attrs, label = 'Character Formatting') => {
    const t = stateRef.current.typing;
    const m = modelRef.current;
    if (!m) return;
    if (t) {
      const lo = Math.min(t.a, t.b);
      const hi = Math.max(t.a, t.b);
      if (lo === hi) {
        // With only a caret, the formatting waits for what's typed next.
        setPendingChar((p) => ({ ...(p ?? {}), ...attrs }));
        return;
      }
      editText(label, (root) => {
        text.applyChar(root, lo, hi, attrs);
        return [t.a, t.b];
      });
      return;
    }
    // Text frames selected: the whole story.
    const stories = [...new Set(selItems.filter((it) => it.kind === 'text' && it.text).map((it) => it.text!.story))];
    if (!stories.length) return;
    edit(label, (d) => {
      for (const st of stories) {
        const root = ops.storyRoot(d, m, st);
        if (root) text.applyChar(root, 0, text.flatten(root).text.length || 0, attrs);
      }
    });
  };

  const applyParaAttrs = (attrs: text.Attrs, label = 'Paragraph Formatting') => {
    const t = stateRef.current.typing;
    const m = modelRef.current;
    if (!m) return;
    if (t) {
      const lo = Math.min(t.a, t.b);
      const hi = Math.max(t.a, t.b);
      editText(label, (root) => {
        text.applyPara(root, lo, hi, attrs);
        return [t.a, t.b];
      });
      return;
    }
    const stories = [...new Set(selItems.filter((it) => it.kind === 'text' && it.text).map((it) => it.text!.story))];
    if (!stories.length) return;
    edit(label, (d) => {
      for (const st of stories) {
        const root = ops.storyRoot(d, m, st);
        if (root) text.applyPara(root, 0, text.flatten(root).text.length, attrs);
      }
    });
  };

  /** Where the caret goes moving up or down a line. */
  const verticalMove = (comp: Composition, pos: number, dir: 1 | -1): number => {
    const l = lineAt(comp, pos) ?? comp.lines[comp.lines.length - 1];
    if (!l) return pos;
    const x = caretX(l, pos);
    const i = comp.lines.indexOf(l);
    let j = i + dir;
    while (j >= 0 && j < comp.lines.length && Math.abs(comp.lines[j].y - l.y) < 0.01 && comp.lines[j].frame === l.frame) j += dir;
    const target = comp.lines[j];
    if (!target) return dir < 0 ? 0 : comp.flat.text.length;
    return posAt({ ...comp, byFrame: comp.byFrame.map((ls, fi) => (fi === target.frame ? [target] : ls)) }, target.frame, x, target.y);
  };

  const lineEnds = (comp: Composition, pos: number): [number, number] => {
    const l = lineAt(comp, pos);
    if (!l) return [pos, pos];
    const last = l.pieces[l.pieces.length - 1];
    const end = last && last.text === '' && last.end - last.start === 1 ? last.start : l.end;
    return [l.start, end];
  };

  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = stateRef.current.typing;
    if (!t || composing.current) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    const comp = compOf(t.story);
    const len = comp?.flat.text.length ?? 0;
    const moveTo = (p: number, extend: boolean) => {
      const q = Math.max(0, Math.min(len, p));
      setTyping({ ...t, a: extend ? t.a : q, b: q });
      caretRef.current = true;
      setPendingChar(null);
    };
    if (key === 'Escape') return run(() => {
      stopTyping();
      setToolState('select');
    });
    if (ctrl && e.shiftKey && (key === '>' || key === '.' || key === '<' || key === ',')) {
      return run(() => cmd.fontSize((key === '>' || key === '.' ? 2 : -2) * (e.altKey ? 5 : 1)));
    }
    if (ctrl && e.shiftKey && !e.altKey) {
      const al: Record<string, string> = { l: 'LeftAlign', c: 'CenterAlign', r: 'RightAlign', j: 'LeftJustified', f: 'FullyJustified' };
      const k = key.toLowerCase();
      if (al[k]) return run(() => applyParaAttrs({ Justification: al[k] }, 'Alignment'));
      if (k === 'b' || k === 'i') {
        return run(() => {
          const look = typeInfo?.char;
          const st = (look?.fontStyle ?? 'Regular').toLowerCase();
          const bold = /bold|black|heavy/.test(st);
          const italic = /italic|oblique/.test(st);
          const nb = k === 'b' ? !bold : bold;
          const ni = k === 'i' ? !italic : italic;
          applyCharAttrs({ FontStyle: nb && ni ? 'Bold Italic' : nb ? 'Bold' : ni ? 'Italic' : 'Regular' });
        });
      }
      if (k === 'u') return run(() => applyCharAttrs({ Underline: typeInfo?.char.underline ? 'false' : 'true' }));
      if (k === 'k') return run(() => applyCharAttrs({ Capitalization: typeInfo?.char.caps === 'AllCaps' ? 'Normal' : 'AllCaps' }));
      if (k === 'h') return run(() => applyCharAttrs({ Capitalization: typeInfo?.char.caps === 'SmallCaps' ? 'Normal' : 'SmallCaps' }));
      if (key === '/' || key === '?') return run(() => applyCharAttrs({ StrikeThru: typeInfo?.char.strike ? 'false' : 'true' }));
      if (key === '=' || key === '+') return run(() => applyCharAttrs({ Position: typeInfo?.char.position === 'Superscript' ? 'Normal' : 'Superscript' }));
    }
    if (ctrl && e.shiftKey && e.altKey && (key === '=' || key === '+')) return run(() => applyCharAttrs({ Position: typeInfo?.char.position === 'Subscript' ? 'Normal' : 'Subscript' }));
    if (ctrl && e.shiftKey && e.altKey && key.toLowerCase() === 'n') return run(() => cmd.insertPageNumber());
    if (e.altKey && !ctrl && (key === 'ArrowUp' || key === 'ArrowDown')) {
      return run(() => {
        const c = typeInfo?.char;
        if (!c) return;
        const cur = c.leading ?? (c.size * c.autoLeading) / 100;
        applyCharAttrs({ Leading: Math.max(0, cur + (key === 'ArrowUp' ? -2 : 2)) }, 'Leading');
      });
    }
    if (e.altKey && !ctrl && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      return run(() => {
        const c = typeInfo?.char;
        if (!c) return;
        applyCharAttrs({ Tracking: c.tracking + (key === 'ArrowRight' ? 20 : -20) * (e.shiftKey ? 5 : 1) }, 'Tracking');
      });
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      const k = key.toLowerCase();
      if (k === 'a') return run(() => setTyping({ ...t, a: 0, b: len }));
      if (k === 'c' || k === 'x') {
        return run(() => {
          const f = flatOf(t.story);
          const lo = Math.min(t.a, t.b);
          const hi = Math.max(t.a, t.b);
          if (!f || hi <= lo) return;
          const s = text.plainText(f, lo, hi);
          clipboard.current = { els: [], text: s, spread: null };
          setHasClip(true);
          void navigator.clipboard?.writeText(s).catch(() => {});
          if (k === 'x') deleteText(1, false);
        });
      }
      if (k === 'v') {
        return run(() => {
          void (async () => {
            let s: string | null = null;
            try {
              s = (await navigator.clipboard?.readText?.()) ?? null;
            } catch {
              // The system clipboard may be off limits.
            }
            if (!s) s = clipboard.current?.text ?? null;
            if (s) typeText(s.replace(/\r\n?/g, '\n').replace(/\n/g, '\r'));
          })();
        });
      }
      if (k === 'z') return run(() => cmd.undo());
      if (k === 'y') return run(() => cmd.redo());
      if (k === 's') return run(() => cmd.save());
      if (k === 't') return run(() => cmd.togglePanel('character'));
      if (k === 'b') return run(() => cmd.textFrameOptions());
    }
    if (ctrl && e.shiftKey && key.toLowerCase() === 'z') return run(() => cmd.redo());
    if (ctrl && e.altKey && key.toLowerCase() === 't') return run(() => cmd.togglePanel('paragraph'));
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      return run(() => {
        const dir = key === 'ArrowLeft' ? -1 : 1;
        if (!e.shiftKey && t.a !== t.b && !ctrl) return moveTo(dir < 0 ? Math.min(t.a, t.b) : Math.max(t.a, t.b), false);
        const f = comp?.flat.text ?? '';
        moveTo(ctrl ? text.nextWord(f, t.b, dir) : t.b + dir, e.shiftKey);
      });
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      return run(() => {
        if (!comp) return;
        if (ctrl) {
          // Ctrl+Up/Down: paragraph by paragraph.
          const pi = text.paraIndexAt(comp.flat, t.b);
          const p = comp.flat.paras[pi];
          const target = key === 'ArrowUp' ? (t.b > p.start ? p.start : (comp.flat.paras[pi - 1]?.start ?? 0)) : (comp.flat.paras[pi + 1]?.start ?? len);
          return moveTo(target, e.shiftKey);
        }
        moveTo(verticalMove(comp, t.b, key === 'ArrowUp' ? -1 : 1), e.shiftKey);
      });
    }
    if (key === 'Home' || key === 'End') {
      return run(() => {
        if (!comp) return;
        if (ctrl) return moveTo(key === 'Home' ? 0 : len, e.shiftKey);
        const [a, b] = lineEnds(comp, t.b);
        moveTo(key === 'Home' ? a : b, e.shiftKey);
      });
    }
    if (key === 'Backspace') return run(() => deleteText(-1, ctrl));
    if (key === 'Delete') return run(() => deleteText(1, ctrl));
    if (key === 'Enter') {
      if (ctrl) return;
      return run(() => typeText(e.shiftKey ? '\u2028' : '\r'));
    }
    if (key === 'Tab') {
      return run(() => {
        if (!e.shiftKey) return typeText('\t');
        // Shift+Tab: InDesign's right indent tab, kept as a marker.
        editText('Insert Right Indent Tab', (root) => {
          const lo = Math.min(t.a, t.b);
          if (t.a !== t.b) text.deleteRange(root, lo, Math.max(t.a, t.b));
          return text.insertMarker(root, lo, '8');
        });
      });
    }
  };

  const onTextInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    const v = e.currentTarget.value;
    e.currentTarget.value = '';
    if (v) typeText(v.replace(/\r\n?|\n/g, '\r'));
  };

  // ---- Tools ------------------------------------------------------------------------------------------

  const setTool = useCallback(
    (t: ToolId) => {
      if (stateRef.current.typing && t !== 'type') {
        setTyping(null);
        setPendingChar(null);
      }
      penRef.current = null;
      ovRef.current = { marquee: null, draft: null, guide: null, pen: null, pivot: null };
      setToolState(t);
      setThreadGun(null);
      const gi = TOOL_GROUPS.findIndex((g) => g.some((x) => x.id === t));
      setSettings((s) => ({ ...s, choice: { ...s.choice, [gi]: t } }));
      scheduleOverlay();
    },
    [scheduleOverlay],
  );

  // ---- Selection info ------------------------------------------------------------------------------

  const selSpread = selItems[0] && model ? (model.spreadOf.get(selItems[0].self) ?? null) : null;

  const objInfo: ObjectInfo | null = (() => {
    if (!model || !selItems.length || !selSpread) return null;
    const ref = refPointOf(selItems, settings.refPoint);
    const o = rulerOrigin(selSpread);
    const g = geometryOf(selItems);
    const sw = (s: string | null) => s ?? 'Swatch/None';
    const frame = selItems.length === 1 ? selItems[0] : null;
    return {
      count: selItems.length,
      x: ref.x - o.x,
      y: ref.y - o.y,
      w: g.w,
      h: g.h,
      rotation: g.rotation,
      shear: g.shear,
      sx: g.sx,
      sy: g.sy,
      fill: same(selItems, (it) => sw(it.fill)),
      stroke: same(selItems, (it) => sw(it.stroke)),
      weight: same(selItems, (it) => it.strokeWeight) ?? null,
      strokeType: same(selItems, (it) => it.strokeType) ?? null,
      opacity: same(selItems, (it) => Math.round(it.opacity * 100)) ?? null,
      hasContent: !!frame && (frame.children.length > 0 || frame.kind === 'graphic') && frame.kind !== 'group',
      textFrame: !!frame && frame.kind === 'text',
      columns: frame?.text ? frame.text.prefs.columns : null,
      content: !!direct,
    };
  })();

  /** What the Type controls show: the text at the caret, or a selected frame's first characters. */
  const typeInfo: TypeInfo | null = (() => {
    if (!model) return null;
    let story: string | null = null;
    let pos = 0;
    if (typing) {
      story = typing.story;
      pos = Math.min(typing.a, typing.b);
    } else {
      const tf = selItems.find((it) => it.kind === 'text' && it.text);
      if (tf) story = tf.text!.story;
    }
    if (!story) return null;
    const part = model.stories.get(story);
    const doc = part ? model.pkg.xml.get(part) : undefined;
    const root = doc && partRoot(doc);
    if (!root) return null;
    const f = text.flatten(root);
    const seg = text.segAt(f, typing && typing.a !== typing.b ? pos + 1 : pos);
    const para = f.paras[text.paraIndexAt(f, pos)];
    const ch = charLook(textChain(model.styles, seg?.csr ?? null, seg?.psr ?? para?.psr ?? null));
    if (pendingChar) {
      if (typeof pendingChar.AppliedFont === 'string') ch.font = pendingChar.AppliedFont;
      if (typeof pendingChar.FontStyle === 'string') ch.fontStyle = pendingChar.FontStyle;
      if (typeof pendingChar.PointSize === 'number') ch.size = pendingChar.PointSize;
    }
    const pl = paraLook(textChain(model.styles, null, para?.psr ?? null), ch.fill);
    const fontsPart = model.pkg.xml.get('Resources/Fonts.xml');
    const fams = new Set<string>(['Minion Pro', 'Myriad Pro', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Garamond', 'Futura', 'Inter', 'Arimo', 'Tinos', 'Carlito', 'Caladea', 'Cousine', 'Noto Sans', 'Noto Serif', 'DejaVu Sans']);
    const styles = new Set<string>(['Regular', 'Italic', 'Bold', 'Bold Italic', 'Light', 'Light Italic', 'Medium', 'Semibold', 'Black']);
    if (fontsPart) {
      for (const fam of Array.from(fontsPart.getElementsByTagName('FontFamily')).slice(0, 400)) {
        const n = fam.getAttribute('Name');
        if (n) fams.add(n);
        if (n === ch.font) for (const fo of Array.from(fam.getElementsByTagName('Font'))) styles.add(fo.getAttribute('FontStyleName') ?? '');
      }
    }
    styles.delete('');
    return {
      char: ch,
      para: pl,
      fonts: [...fams].sort((a, b) => a.localeCompare(b)),
      styles: [...styles],
      paraStyles: model.styles.paraList,
      charStyles: model.styles.charList,
    };
  })();

  const fillSw: Swatch | null | undefined = model ? (typing || (affectsText && selItems.some((i) => i.kind === 'text')) ? (typeInfo ? model.swatches.bySelf.get(typeInfo.char.fill ?? 'Swatch/None') : undefined) : objInfo ? (objInfo.fill === undefined ? undefined : model.swatches.bySelf.get(objInfo.fill ?? 'Swatch/None')) : model.swatches.bySelf.get(settings.defaults.fill)) : undefined;
  const strokeSw: Swatch | null | undefined = model ? (typing ? (typeInfo?.char.stroke ? model.swatches.bySelf.get(typeInfo.char.stroke) : model.swatches.bySelf.get('Swatch/None')) : objInfo ? (objInfo.stroke === undefined ? undefined : model.swatches.bySelf.get(objInfo.stroke ?? 'Swatch/None')) : model.swatches.bySelf.get(settings.defaults.stroke)) : undefined;

  // ---- Applying things to the selection --------------------------------------------------------------

  const applyAttrs = (attrs: text.Attrs, label = 'Apply Attributes') => {
    const m = modelRef.current;
    if (!m) return;
    if (!selItems.length) {
      // Nothing selected: the defaults for what's drawn next.
      const dflt = { ...settings.defaults };
      if (typeof attrs.FillColor === 'string') dflt.fill = attrs.FillColor;
      if (typeof attrs.StrokeColor === 'string') dflt.stroke = attrs.StrokeColor;
      if (typeof attrs.StrokeWeight === 'number') dflt.weight = attrs.StrokeWeight;
      setSetting('defaults', dflt);
      return;
    }
    edit(label, (d) => {
      for (const it of selItems) {
        const a = { ...attrs };
        // A stroke needs a weight to show.
        if (typeof a.StrokeColor === 'string' && a.StrokeColor !== 'Swatch/None' && it.strokeWeight === 0 && a.StrokeWeight === undefined) a.StrokeWeight = 1;
        ops.setAttrs(d, it, a);
      }
    });
  };

  /** A swatch for the active attribute (fill or stroke): to text when typing, else to the selection. */
  const applySwatch = (self: string, which: 'fill' | 'stroke' = activeAttr) => {
    if (typing || (affectsText && selItems.some((i) => i.kind === 'text'))) {
      applyCharAttrs(which === 'fill' ? { FillColor: self } : { StrokeColor: self }, 'Apply Color');
      return;
    }
    applyAttrs(which === 'fill' ? { FillColor: self } : { StrokeColor: self }, 'Apply Color');
  };

  const transformSel = (t: Mat, label: string) => {
    if (!selItems.length) return;
    edit(label, (d, m) => {
      for (const it of selItems) if (isEditable(it)) ops.setTransformOf(d, m, it, t);
    });
  };

  const onGeometry = (g: Geometry) => {
    const m = modelRef.current;
    if (!m || !selItems.length || !selSpread) return;
    const ref = refPointOf(selItems, settings.refPoint);
    const o = rulerOrigin(selSpread);
    const cur = geometryOf(selItems);
    if (g.x !== undefined || g.y !== undefined) {
      const dx = g.x !== undefined ? g.x + o.x - ref.x : 0;
      const dy = g.y !== undefined ? g.y + o.y - ref.y : 0;
      return transformSel(translate(dx, dy), 'Move');
    }
    if (g.rotation !== undefined) return transformSel(about(rotate((-(g.rotation - cur.rotation) * Math.PI) / 180), ref), 'Rotate');
    if (g.shear !== undefined) {
      const k = Math.tan((-(g.shear - cur.shear) * Math.PI) / 180);
      return transformSel(about([1, 0, k, 1, 0, 0], ref), 'Shear');
    }
    if (g.w !== undefined || g.h !== undefined || g.sx !== undefined || g.sy !== undefined) {
      let kx = g.w !== undefined ? g.w / (cur.w || 1) : g.sx !== undefined ? g.sx / (cur.sx || 100) : 1;
      let ky = g.h !== undefined ? g.h / (cur.h || 1) : g.sy !== undefined ? g.sy / (cur.sy || 100) : 1;
      if (settings.constrain) {
        if (g.w !== undefined || g.sx !== undefined) ky = kx;
        else kx = ky;
      }
      if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= 0 || ky <= 0) return;
      const byScale = g.sx !== undefined || g.sy !== undefined;
      edit('Resize', (d) => {
        for (const it of selItems) {
          if (!isEditable(it)) continue;
          if (selItems.length === 1 && !byScale && !ops.resizesByScale(it)) {
            // Resize the outline in the item's own coordinates, about the reference point.
            const b = it.box;
            const rx = b.x + ((settings.refPoint[0] + 1) / 2) * b.w;
            const ry = b.y + ((settings.refPoint[1] + 1) / 2) * b.h;
            const nb = { x: rx - (rx - b.x) * kx, y: ry - (ry - b.y) * ky, w: b.w * kx, h: b.h * ky };
            ops.setPathsOf(d, it, ops.reshaped(it, nb).paths);
          } else {
            const inner = invert(it.m);
            const lr = apply(inner, ref);
            ops.setTransformOf(d, m, it, mul(it.m, mul(about(scale(kx, ky), lr), inner)));
          }
        }
      });
    }
  };

  const turn = (how: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV') => {
    if (!selItems.length) return;
    const ref = refPointOf(selItems, [0, 0]);
    const t: Mat = how === 'cw' ? rotate(Math.PI / 2) : how === 'ccw' ? rotate(-Math.PI / 2) : how === '180' ? rotate(Math.PI) : how === 'flipH' ? scale(-1, 1) : scale(1, -1);
    transformSel(about(t, ref), how === 'flipH' ? 'Flip Horizontal' : how === 'flipV' ? 'Flip Vertical' : 'Rotate');
  };

  const fitSel = (how: ops.Fitting) => {
    const m = modelRef.current;
    if (!m) return;
    const frames = selItems.map((it) => (it.kind === 'graphic' && it.parent ? m.items.get(it.parent)! : it)).filter((it) => it && it.children.length);
    if (!frames.length) return say('Select a frame with a picture in it.');
    edit({ fill: 'Fill Frame Proportionally', fit: 'Fit Content Proportionally', stretch: 'Fit Content to Frame', center: 'Center Content', frameToContent: 'Fit Frame to Content' }[how], (d) => {
      for (const f of frames) ops.fitContent(d, f, how);
    });
  };

  const placeFile = async (into: Item | null) => {
    const t = await pick('Place', 'Graphics', PLACE_EXTENSIONS);
    if (!t) return;
    try {
      // Placed graphics are linked by path, as in InDesign.
      if (!t.path) throw new Error('Din didn’t say where it is.');
      const f = await t.getFile();
      if (f.size > 256 * 1024 * 1024) throw new Error(`It’s too big (${formatBytes(f.size)}).`);
      const { decodeBytes } = await import('./publisher/images');
      const bmp = await decodeBytes(new Uint8Array(await f.arrayBuffer()));
      const gun: PlaceGun = { path: t.path, w: bmp.width, h: bmp.height, size: f.size };
      bmp.close();
      if (into && into.kind !== 'text' && into.kind !== 'group' && into.kind !== 'line') {
        edit('Place', (d) => {
          ops.placeImage(d, into, gun.path, { w: gun.w, h: gun.h }, gun.size, 'fill');
          return { sel: [into.self] };
        });
        return;
      }
      setPlaceGun(gun);
      setTool('select');
      say(`Click to place ${t.name} at 100%, drag to size it, or click a frame to put it in.`);
    } catch (err) {
      say(`Couldn’t place ${t.name}: ${err instanceof Error ? err.message : cleanFsError(err)}`);
    }
  };

  // ---- Pointer gestures ----------------------------------------------------------------------------------

  /** The handle under a screen point, for the selection's box. */
  const handleAt = (sp: Pt): number | null => {
    const m = modelRef.current;
    if (!m || !selItems.length) return null;
    const s = m.spreadOf.get(selItems[0].self);
    if (!s) return null;
    const corners = (selItems.length === 1 ? rectCorners(selItems[0].box).map((p) => apply(selItems[0].m, p)) : unionCorners(selItems)).map((p) => apply(spreadToScreen(viewRef.current, s), p));
    const hs = handlePoints(corners);
    for (let i = 0; i < hs.length; i++) if (dist(hs[i], sp) <= 6) return i;
    return null;
  };

  /** Just outside a corner: the selection tool rotates there. */
  const rotateZone = (sp: Pt): boolean => {
    const m = modelRef.current;
    if (!m || !selItems.length) return false;
    const s = m.spreadOf.get(selItems[0].self);
    if (!s) return false;
    const corners = (selItems.length === 1 ? rectCorners(selItems[0].box).map((p) => apply(selItems[0].m, p)) : unionCorners(selItems)).map((p) => apply(spreadToScreen(viewRef.current, s), p));
    return corners.some((c) => {
      const d = dist(c, sp);
      return d > 6 && d < 20;
    });
  };

  const portAt = (sp: Pt): { frame: Item; port: 'in' | 'out' } | null => {
    const m = modelRef.current;
    if (!m) return null;
    for (const it of selItems) {
      if (it.kind !== 'text') continue;
      const s = m.spreadOf.get(it.self);
      if (!s) continue;
      const { inPort, outPort } = portPoints(it, mul(spreadToScreen(viewRef.current, s), it.m));
      if (dist(inPort, sp) <= 6) return { frame: it, port: 'in' };
      if (dist(outPort, sp) <= 6) return { frame: it, port: 'out' };
    }
    return null;
  };

  const startMove = (p0: Pt, items: Item[], e: React.PointerEvent): Gesture => {
    const m = modelRef.current!;
    const s = m.spreadOf.get(items[0].self)!;
    const lines = settings.snap ? snapLines(m, s) : { xs: [], ys: [] };
    const b0 = unionBounds(items);
    let dx = 0;
    let dy = 0;
    let moved = false;
    const startShift = e.shiftKey;
    return {
      move(p, ev) {
        dx = p.x - p0.x;
        dy = p.y - p0.y;
        if (!moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
        moved = true;
        if (ev.shiftKey && !startShift) {
          if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0;
          else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0;
          else {
            const k = (Math.abs(dx) + Math.abs(dy)) / 2;
            dx = Math.sign(dx) * k;
            dy = Math.sign(dy) * k;
          }
        }
        if (settings.snap) {
          const tol = 5 / viewRef.current.zoom;
          const cx = [b0.x + dx, b0.x + b0.w / 2 + dx, b0.x + b0.w + dx];
          const cy = [b0.y + dy, b0.y + b0.h / 2 + dy, b0.y + b0.h + dy];
          let sx: number | null = null;
          let sy: number | null = null;
          for (const v of cx) {
            const t = snap1(v, lines.xs, tol);
            if (t !== null && (sx === null || Math.abs(t - v) < Math.abs(sx))) sx = t - v;
          }
          for (const v of cy) {
            const t = snap1(v, lines.ys, tol);
            if (t !== null && (sy === null || Math.abs(t - v) < Math.abs(sy))) sy = t - v;
          }
          if (sx !== null) dx += sx;
          if (sy !== null) dy += sy;
        }
        const ov = new Map<string, Item>();
        for (const it of items) ov.set(it.self, ops.transformed(m, it, translate(dx, dy)));
        overridesRef.current = ov;
        scheduleScene();
      },
      up(_p, ev) {
        overridesRef.current = new Map();
        if (!moved) {
          scheduleScene();
          return;
        }
        const t = translate(dx, dy);
        if (ev.altKey) {
          edit('Duplicate', (d) => ({ sel: ops.duplicateItems(d, m, items, t) }));
        } else edit('Move', (d) => {
          for (const it of items) ops.setTransformOf(d, m, it, t);
        });
      },
      cancel() {
        overridesRef.current = new Map();
        scheduleScene();
      },
    };
  };

  const startResize = (handle: number, e: React.PointerEvent): Gesture | null => {
    const m = modelRef.current!;
    const items = selItems.filter(isEditable);
    if (!items.length) return null;
    const [hx, hy] = HANDLES[handle];
    const single = items.length === 1 ? items[0] : null;
    // Work in the item's own coordinates (a rotated frame resizes along its sides), or the spread's for several.
    const frameM: Mat = single ? single.m : [1, 0, 0, 1, 0, 0];
    const inv = invert(frameM);
    const box = single ? single.box : unionBounds(items);
    const scaleContent = e.ctrlKey || e.metaKey;
    const compute = (p: Pt, ev: PointerEvent): { box: Rect; kx: number; ky: number; anchor: Pt } => {
      const s = m.spreadOf.get(items[0].self)!;
      const q = apply(inv, { x: p.x, y: p.y - s.y });
      const fromCenter = ev.altKey;
      const ax = fromCenter ? box.x + box.w / 2 : hx < 0 ? box.x + box.w : box.x;
      const ay = fromCenter ? box.y + box.h / 2 : hy < 0 ? box.y + box.h : box.y;
      let w = hx ? Math.abs(q.x - ax) * (fromCenter ? 2 : 1) : box.w;
      let h = hy ? Math.abs(q.y - ay) * (fromCenter ? 2 : 1) : box.h;
      if (ev.shiftKey && hx && hy) {
        const k = Math.max(w / (box.w || 1), h / (box.h || 1));
        w = box.w * k;
        h = box.h * k;
      }
      w = Math.max(1, w);
      h = Math.max(1, h);
      const flipX = hx && (q.x - ax) * hx < 0 && !fromCenter;
      const flipY = hy && (q.y - ay) * hy < 0 && !fromCenter;
      const x = fromCenter ? ax - w / 2 : hx > 0 ? (flipX ? ax - w : ax) : hx < 0 ? (flipX ? ax : ax - w) : box.x;
      const y = fromCenter ? ay - h / 2 : hy > 0 ? (flipY ? ay - h : ay) : hy < 0 ? (flipY ? ay : ay - h) : box.y;
      return { box: { x, y, w, h }, kx: w / (box.w || 1), ky: h / (box.h || 1), anchor: { x: ax, y: ay } };
    };
    let last: { box: Rect; kx: number; ky: number; anchor: Pt } | null = null;
    const build = (r: { box: Rect; kx: number; ky: number }): Map<string, Item> => {
      const ov = new Map<string, Item>();
      for (const it of items) {
        if (single && !scaleContent && !ops.resizesByScale(it)) ov.set(it.self, ops.reshaped(it, r.box));
        else {
          // Scale: map the old box onto the new one.
          const t: Mat = [r.kx, 0, 0, r.ky, r.box.x - box.x * r.kx, r.box.y - box.y * r.ky];
          const spreadT = mul(frameM, mul(t, inv));
          ov.set(it.self, ops.transformed(m, it, spreadT));
        }
      }
      return ov;
    };
    return {
      move(p, ev) {
        last = compute(p, ev);
        overridesRef.current = build(last);
        scheduleScene();
      },
      up() {
        overridesRef.current = new Map();
        if (!last) return scheduleScene();
        const r = last;
        edit('Resize', (d) => {
          for (const it of items) {
            if (single && !scaleContent && !ops.resizesByScale(it)) ops.setPathsOf(d, it, ops.reshaped(it, r.box).paths);
            else {
              const t: Mat = [r.kx, 0, 0, r.ky, r.box.x - box.x * r.kx, r.box.y - box.y * r.ky];
              ops.setTransformOf(d, m, it, mul(frameM, mul(t, inv)));
            }
          }
        });
      },
      cancel() {
        overridesRef.current = new Map();
        scheduleScene();
      },
    };
  };

  const startRotate = (p0: Pt, items: Item[], pivotIn?: Pt): Gesture | null => {
    const m = modelRef.current!;
    if (!items.length) return null;
    const s = m.spreadOf.get(items[0].self)!;
    const pivot = pivotIn ?? refPointOf(items, [0, 0]);
    const a0 = Math.atan2(p0.y - s.y - pivot.y, p0.x - pivot.x);
    let t: Mat | null = null;
    ovRef.current.pivot = { x: pivot.x, y: pivot.y + s.y };
    return {
      move(p, ev) {
        let a = Math.atan2(p.y - s.y - pivot.y, p.x - pivot.x) - a0;
        if (ev.shiftKey) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
        t = about(rotate(a), pivot);
        const ov = new Map<string, Item>();
        for (const it of items) ov.set(it.self, ops.transformed(m, it, t));
        overridesRef.current = ov;
        scheduleScene();
      },
      up() {
        overridesRef.current = new Map();
        ovRef.current.pivot = null;
        if (!t) return scheduleScene();
        const tt = t;
        edit('Rotate', (d) => {
          for (const it of items) ops.setTransformOf(d, m, it, tt);
        });
      },
      cancel() {
        overridesRef.current = new Map();
        ovRef.current.pivot = null;
        scheduleScene();
      },
    };
  };

  const startScaleOrShear = (p0: Pt, items: Item[], kind: 'scale' | 'shear'): Gesture | null => {
    const m = modelRef.current!;
    if (!items.length) return null;
    const s = m.spreadOf.get(items[0].self)!;
    const pivot = refPointOf(items, [0, 0]);
    const v0 = { x: p0.x - pivot.x, y: p0.y - s.y - pivot.y };
    let t: Mat | null = null;
    ovRef.current.pivot = { x: pivot.x, y: pivot.y + s.y };
    return {
      move(p, ev) {
        const v = { x: p.x - pivot.x, y: p.y - s.y - pivot.y };
        if (kind === 'scale') {
          let kx = Math.abs(v0.x) > 2 ? v.x / v0.x : 1;
          let ky = Math.abs(v0.y) > 2 ? v.y / v0.y : 1;
          if (ev.shiftKey) kx = ky = Math.max(Math.abs(kx), Math.abs(ky)) * Math.sign(kx || 1);
          t = about(scale(kx || 1, ky || 1), pivot);
        } else {
          const k = (v.x - v0.x) / Math.max(20, Math.abs(v.y) || 20);
          t = about([1, 0, -k, 1, 0, 0], pivot);
        }
        const ov = new Map<string, Item>();
        for (const it of items) ov.set(it.self, ops.transformed(m, it, t));
        overridesRef.current = ov;
        scheduleScene();
      },
      up() {
        overridesRef.current = new Map();
        ovRef.current.pivot = null;
        if (!t) return scheduleScene();
        const tt = t;
        edit(kind === 'scale' ? 'Scale' : 'Shear', (d) => {
          for (const it of items) ops.setTransformOf(d, m, it, tt);
        });
      },
      cancel() {
        overridesRef.current = new Map();
        ovRef.current.pivot = null;
        scheduleScene();
      },
    };
  };

  const startMarquee = (p0: Pt, add: boolean, zoom = false): Gesture => {
    let r: Rect = { x: p0.x, y: p0.y, w: 0, h: 0 };
    return {
      move(p) {
        r = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
        ovRef.current.marquee = r;
        scheduleOverlay();
      },
      up() {
        ovRef.current.marquee = null;
        scheduleOverlay();
        if (zoom) {
          if (r.w * viewRef.current.zoom > 4) fitRect(r);
          return;
        }
        const m = modelRef.current;
        if (!m) return;
        if (r.w * viewRef.current.zoom < 3 && r.h * viewRef.current.zoom < 3) {
          if (!add) select([]);
          return;
        }
        const hits = marqueeHits(m, spreadsRef.current, r).map((h) => h.item.self);
        select(add ? [...new Set([...sel, ...hits])] : hits);
      },
    };
  };

  /** Drawing a shape or frame, a line, or a text frame. */
  const startDraw = (p0: Pt, kind: 'rect' | 'oval' | 'polygon' | 'line' | 'text', frame: boolean): Gesture | null => {
    const m = modelRef.current!;
    const hit = spreadAtY(spreadsRef.current, p0.y);
    if (!hit) return null;
    const s = hit;
    const lines = settings.snap ? snapLines(m, s) : { xs: [], ys: [] };
    const tol = 5 / viewRef.current.zoom;
    const snapPt = (p: Pt): Pt => ({ x: snap1(p.x, lines.xs, tol) ?? p.x, y: (snap1(p.y - s.y, lines.ys, tol) ?? p.y - s.y) + s.y });
    const a0 = snapPt(p0);
    let a = a0;
    let b = a0;
    return {
      move(p, ev) {
        let q = snapPt(p);
        if (kind === 'line') {
          if (ev.shiftKey) {
            const ang = Math.round(Math.atan2(q.y - a0.y, q.x - a0.x) / (Math.PI / 4)) * (Math.PI / 4);
            const r = dist(a0, q);
            q = { x: a0.x + Math.cos(ang) * r, y: a0.y + Math.sin(ang) * r };
          }
          a = a0;
          b = q;
        } else {
          let w = q.x - a0.x;
          let h = q.y - a0.y;
          if (ev.shiftKey) {
            const k = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * k;
            h = Math.sign(h || 1) * k;
          }
          if (ev.altKey) {
            a = { x: a0.x - w, y: a0.y - h };
            b = { x: a0.x + w, y: a0.y + h };
          } else {
            a = a0;
            b = { x: a0.x + w, y: a0.y + h };
          }
        }
        ovRef.current.draft = { kind: kind === 'text' ? 'rect' : kind, a, b };
        scheduleOverlay();
      },
      up() {
        ovRef.current.draft = null;
        scheduleOverlay();
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        if (kind === 'line' ? dist(a, b) * viewRef.current.zoom < 3 : w * viewRef.current.zoom < 3 || h * viewRef.current.zoom < 3) return;
        const tl = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
        const br = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
        let made: { self: string; story?: string } | null = null;
        const label = kind === 'text' ? 'New Text Frame' : kind === 'line' ? 'Line' : frame ? 'Frame' : kind === 'oval' ? 'Ellipse' : kind === 'polygon' ? 'Polygon' : 'Rectangle';
        edit(label, (d) => {
          made = ops.createItem(d, m, s, kind, kind === 'line' ? a : tl, kind === 'line' ? b : br, settings.defaults, { frame, sides: settings.polygonSides, layer: activeLayer() });
          return { sel: [made.self] };
        });
        if (kind === 'text' && made) {
          const mm = made as { self: string; story?: string };
          if (mm.story) {
            setTyping({ story: mm.story, a: 0, b: 0, frame: mm.self });
            caretRef.current = true;
            requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
          }
        }
      },
      cancel() {
        ovRef.current.draft = null;
        scheduleOverlay();
      },
    };
  };

  const startPencil = (p0: Pt): Gesture | null => {
    const m = modelRef.current!;
    const s = spreadAtY(spreadsRef.current, p0.y);
    if (!s) return null;
    const pts: Pt[] = [p0];
    return {
      move(p) {
        if (dist(p, pts[pts.length - 1]) * viewRef.current.zoom >= 3) pts.push(p);
        ovRef.current.pen = pts;
        scheduleOverlay();
      },
      up() {
        ovRef.current.pen = null;
        scheduleOverlay();
        if (pts.length < 2) return;
        const simplified = simplify(pts, 1.5 / viewRef.current.zoom);
        createPath(m, s, simplified.map((p) => ({ anchor: p, left: p, right: p })), false);
      },
      cancel() {
        ovRef.current.pen = null;
        scheduleOverlay();
      },
    };
  };

  /** A path from the Pen or Pencil, as a GraphicLine (two points) or a Polygon. */
  const createPath = (m: Model, s: Spread, pts: { anchor: Pt; left: Pt; right: Pt }[], closed: boolean) => {
    const local = pts.map((p) => ({ anchor: ops.toSpreadLocal(s, p.anchor), left: ops.toSpreadLocal(s, p.left), right: ops.toSpreadLocal(s, p.right) }));
    const b = boundsOf(local.flatMap((p) => [p.anchor]));
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const shift = (p: Pt) => ({ x: p.x - cx, y: p.y - cy });
    const paths = [{ open: !closed, points: local.map((p) => ({ anchor: shift(p.anchor), left: shift(p.left), right: shift(p.right) })) }];
    edit(closed ? 'Pen Tool' : pts.length === 2 ? 'Line' : 'Path', (d) => {
      const kind = !closed && pts.length === 2 ? 'line' : 'polygon';
      const made = ops.createItem(d, m, s, kind, { x: cx - 1, y: cy - 1 + s.y }, { x: cx + 1, y: cy + 1 + s.y }, closed ? settings.defaults : { ...settings.defaults, fill: 'Swatch/None' }, { layer: activeLayer() });
      const e = findSelf(d.part(s.part), made.self);
      if (e) {
        e.setAttribute('ItemTransform', `1 0 0 1 ${cx} ${cy}`);
        ops.writePaths(e, paths);
      }
      return { sel: [made.self] };
    });
  };

  const finishPen = (closed: boolean) => {
    const pen = penRef.current;
    penRef.current = null;
    ovRef.current.pen = null;
    scheduleOverlay();
    const m = modelRef.current;
    if (!pen || !m || pen.pts.length < 2) return;
    const s = spreadAtY(spreadsRef.current, pen.pts[0].anchor.y);
    if (s) createPath(m, s, pen.pts, closed);
  };

  /** Pen: click for corners, drag for curves; click the first point to close, Enter or Esc to end. */
  const penDown = (p: Pt): Gesture => {
    const pen = (penRef.current ??= { pts: [] });
    if (pen.pts.length >= 2 && dist(toScreen(pen.pts[0].anchor), toScreen(p)) <= 6) {
      finishPen(true);
      return { move() {}, up() {} };
    }
    const pt = { anchor: p, left: p, right: p };
    pen.pts.push(pt);
    ovRef.current.pen = pen.pts.map((x) => x.anchor);
    scheduleOverlay();
    return {
      move(q) {
        pt.right = q;
        pt.left = { x: 2 * p.x - q.x, y: 2 * p.y - q.y };
        scheduleOverlay();
      },
      up() {},
    };
  };

  const textHit = (p: Pt): { frame: Item; pos: number } | null => {
    const m = modelRef.current;
    if (!m) return null;
    const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
    const frame = hit?.leaf.kind === 'text' ? hit.leaf : hit?.item.kind === 'text' ? hit.item : null;
    if (!frame || !frame.text || !hit) return null;
    const comp = compOf(frame.text.story);
    if (!comp) return { frame, pos: 0 };
    const idx = (m.threads.get(frame.text.story) ?? []).findIndex((f) => f.self === frame.self);
    const lp = apply(invert(frame.m), { x: p.x, y: p.y - hit.spread.y });
    return { frame, pos: posAt(comp, Math.max(0, idx), lp.x, lp.y) };
  };

  const typeDown = (p: Pt, e: React.PointerEvent): Gesture | null => {
    const m = modelRef.current!;
    const th = textHit(p);
    const now = e.timeStamp;
    const lc = lastClick.current;
    const n = now - lc.t < 450 && Math.abs(lc.x - e.clientX) < 4 && Math.abs(lc.y - e.clientY) < 4 ? lc.n + 1 : 1;
    lastClick.current = { t: now, x: e.clientX, y: e.clientY, n };
    if (th) {
      if (!isEditable(th.frame)) return null;
      const story = th.frame.text!.story;
      const t = stateRef.current.typing;
      const f = flatOf(story);
      if (n >= 2 && f && t && t.story === story) {
        let a = th.pos;
        let b = th.pos;
        if (n === 2) [a, b] = text.wordAt(f.text, th.pos);
        else if (n === 3) {
          const comp = compOf(story);
          if (comp) [a, b] = lineEnds(comp, th.pos);
        } else {
          const para = f.paras[text.paraIndexAt(f, th.pos)];
          a = para.start;
          b = para.end;
        }
        setTyping({ ...t, a, b });
        return null;
      }
      const anchor = e.shiftKey && t && t.story === story ? t.a : th.pos;
      startTyping(th.frame, th.pos, anchor);
      return {
        move(q) {
          const h2 = textHit(q);
          if (h2 && h2.frame.text?.story === story) {
            setTyping((cur) => (cur ? { ...cur, b: h2.pos } : cur));
          }
        },
        up() {},
      };
    }
    if (stateRef.current.typing) stopTyping(false);
    // Dragging outside text draws a text frame.
    void m;
    return startDraw(p, 'text', false);
  };

  const placeDown = (p: Pt): Gesture | null => {
    const gun = placeGun;
    const m = modelRef.current!;
    if (!gun) return null;
    const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
    const target = hit && (hit.leaf.kind === 'graphic' ? m.items.get(hit.leaf.parent ?? '') : hit.leaf);
    const s = spreadAtY(spreadsRef.current, p.y);
    if (!s) return null;
    let b = p;
    return {
      move(q) {
        b = q;
        ovRef.current.draft = { kind: 'frame', a: p, b };
        scheduleOverlay();
      },
      up() {
        ovRef.current.draft = null;
        scheduleOverlay();
        setPlaceGun(null);
        const dragged = Math.abs(b.x - p.x) * viewRef.current.zoom > 4 && Math.abs(b.y - p.y) * viewRef.current.zoom > 4;
        if (!dragged && target && target.kind !== 'text' && target.kind !== 'line' && target.kind !== 'group' && isEditable(target)) {
          edit('Place', (d) => {
            ops.placeImage(d, target, gun.path, { w: gun.w, h: gun.h }, gun.size, 'fill');
            return { sel: [target.self] };
          });
          return;
        }
        const a = dragged ? { x: Math.min(p.x, b.x), y: Math.min(p.y, b.y) } : p;
        const z = dragged ? { x: Math.max(p.x, b.x), y: Math.max(p.y, b.y) } : { x: p.x + gun.w, y: p.y + gun.h };
        edit('Place', (d) => {
          const made = ops.createItem(d, m, s, 'rect', a, z, settings.defaults, { frame: true, layer: activeLayer() });
          const doc = d.part(s.part);
          const e = findSelf(doc, made.self);
          if (!e) return;
          const item = { ...(buildModel(d.done()).items.get(made.self) as Item) };
          ops.placeImage(d, item, gun.path, { w: gun.w, h: gun.h }, gun.size, dragged ? 'fill' : 'none');
          return { sel: [made.self] };
        });
      },
      cancel() {
        ovRef.current.draft = null;
        scheduleOverlay();
      },
    };
  };

  const threadDown = (p: Pt): Gesture | null => {
    const from = threadGun;
    const m = modelRef.current!;
    setThreadGun(null);
    if (!from) return null;
    const src = m.items.get(from);
    if (!src?.text) return null;
    const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
    const target = hit?.leaf.kind === 'text' ? hit.leaf : null;
    if (target && target.self !== src.self) {
      if (target.text!.story === src.text.story) return say('That frame is already in this thread.'), null;
      if (target.text!.prev) return say('That frame already has text flowing into it.'), null;
      edit('Thread Text', (d) => {
        ops.threadFrames(d, m, src, target);
        return { sel: [target.self] };
      });
      return null;
    }
    const s = spreadAtY(spreadsRef.current, p.y);
    if (!s) return null;
    let b = p;
    return {
      move(q) {
        b = q;
        ovRef.current.draft = { kind: 'rect', a: p, b };
        scheduleOverlay();
      },
      up() {
        ovRef.current.draft = null;
        scheduleOverlay();
        const dragged = Math.abs(b.x - p.x) * viewRef.current.zoom > 4 && Math.abs(b.y - p.y) * viewRef.current.zoom > 4;
        const sz = geometryOf([src]);
        const a = dragged ? { x: Math.min(p.x, b.x), y: Math.min(p.y, b.y) } : p;
        const z = dragged ? { x: Math.max(p.x, b.x), y: Math.max(p.y, b.y) } : { x: p.x + sz.w, y: p.y + sz.h };
        edit('Thread Text', (d) => {
          const made = ops.createItem(d, m, s, 'text', a, z, settings.defaults, { layer: activeLayer() });
          const m2 = buildModel(d.done());
          const target2 = m2.items.get(made.self);
          if (target2) ops.threadFrames(d, m2, src, target2);
          return { sel: [made.self] };
        });
      },
      cancel() {
        ovRef.current.draft = null;
        scheduleOverlay();
      },
    };
  };

  const startGuideDrag = (vertical: boolean): Gesture => ({
    move(p) {
      ovRef.current.guide = { vertical, pos: vertical ? p.x : p.y };
      scheduleOverlay();
    },
    up(p, ev) {
      ovRef.current.guide = null;
      scheduleOverlay();
      const r = viewportRef.current!.getBoundingClientRect();
      if (ev.clientX - r.left < RULER || ev.clientY - r.top < RULER) return;
      const hit = pageAt(spreadsRef.current, p);
      if (!hit) return;
      const s = hit.spread;
      const pg = hit.page && pagesContain(hit.page, { x: p.x, y: p.y - s.y }) ? hit.page : null;
      edit('Add Guide', (d) => {
        if (pg) {
          const lp = apply(invert(pg.m), { x: p.x, y: p.y - s.y });
          ops.addGuide(d, s, pg, vertical, vertical ? lp.x : lp.y, activeLayer());
        } else ops.addGuide(d, s, null, vertical, vertical ? p.x : p.y - s.y, activeLayer());
      });
    },
  });

  const pagesContain = (pg: Page, q: Pt) => q.x >= pg.bounds.x && q.x <= pg.bounds.x + pg.bounds.w && q.y >= pg.bounds.y && q.y <= pg.bounds.y + pg.bounds.h;

  /** A guide under the pointer, to drag (or drop on the ruler to delete). */
  const guideAt = (p: Pt): { spread: Spread; self: string; vertical: boolean; page: Page | null } | null => {
    const m = modelRef.current;
    if (!m || !settings.guides) return null;
    const tol = 3 / viewRef.current.zoom;
    for (const s of spreadsRef.current) {
      const q = { x: p.x, y: p.y - s.y };
      for (const g of s.guides) {
        const pg = g.page ? (s.pages.find((x) => x.self === g.page) ?? null) : null;
        if (pg && !pagesContain(pg, q)) continue;
        const at = pg ? apply(pg.m, g.vertical ? { x: g.location, y: 0 } : { x: 0, y: g.location }) : { x: g.location, y: g.location };
        if (g.vertical ? Math.abs(q.x - at.x) <= tol : Math.abs(q.y - at.y) <= tol) return { spread: s, self: g.self, vertical: g.vertical, page: pg };
      }
    }
    return null;
  };

  const startGuideMove = (g: { spread: Spread; self: string; vertical: boolean; page: Page | null }): Gesture => ({
    move(p) {
      ovRef.current.guide = { vertical: g.vertical, pos: g.vertical ? p.x : p.y };
      scheduleOverlay();
    },
    up(p, ev) {
      ovRef.current.guide = null;
      scheduleOverlay();
      const r = viewportRef.current!.getBoundingClientRect();
      const onRuler = ev.clientX - r.left < RULER || ev.clientY - r.top < RULER;
      edit(onRuler ? 'Delete Guide' : 'Move Guide', (d) => {
        if (onRuler) return ops.moveGuide(d, g.spread, g.self, null);
        const q = { x: p.x, y: p.y - g.spread.y };
        const lp = g.page ? apply(invert(g.page.m), q) : q;
        ops.moveGuide(d, g.spread, g.self, g.vertical ? lp.x : lp.y);
      });
    },
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const m = modelRef.current;
    if (!m || dialog || e.button === 2) return;
    if (!stateRef.current.typing) rootRef.current?.focus({ preventScroll: true });
    const r = viewportRef.current!.getBoundingClientRect();
    const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    const p = toPb(e);
    let g: Gesture | null = null;
    // Rulers: drag out a guide.
    if (settings.rulers && (sp.x < RULER || sp.y < RULER)) {
      if (sp.x < RULER && sp.y < RULER) return;
      g = startGuideDrag(sp.y >= RULER && sp.x < RULER);
    } else if (spaceDown || e.button === 1 || tool === 'hand') {
      const v0 = viewRef.current;
      setPanning(true);
      g = {
        move(_q, ev) {
          setView({ ...v0, x: v0.x + ev.clientX - e.clientX, y: v0.y + ev.clientY - e.clientY });
        },
        up: () => setPanning(false),
        cancel: () => setPanning(false),
      };
    } else if (zoomKey || tool === 'zoom') {
      const out = zoomKey === 'out' || e.altKey;
      if (out) {
        zoomAt(zoomStep(viewRef.current.zoom, -1), sp.x, sp.y);
        return;
      }
      const v0 = viewRef.current.zoom;
      const mq = startMarquee(p, false, true);
      g = {
        move: mq.move,
        up(q, ev) {
          if (dist(toScreen(q), toScreen(p)) < 4) {
            ovRef.current.marquee = null;
            zoomAt(zoomStep(v0, 1), sp.x, sp.y);
          } else mq.up(q, ev);
        },
      };
    } else if (placeGun) {
      g = placeDown(p);
    } else if (threadGun) {
      g = threadDown(p);
    } else {
      // Ctrl gives the Selection tool for a moment, as in InDesign.
      const effective: ToolId = (e.ctrlKey || e.metaKey) && tool !== 'select' && tool !== 'direct' && tool !== 'type' ? 'select' : tool;
      const port = effective === 'select' && !stateRef.current.typing ? portAt(sp) : null;
      const handle = (effective === 'select' || effective === 'direct' || effective === 'free') && !stateRef.current.typing ? handleAt(sp) : null;
      if (port) {
        if (port.port === 'out') {
          setThreadGun(port.frame.self);
          say('Click a text frame to flow the text into it, or click or drag to make a new one. Esc cancels.');
        } else if (port.frame.text?.prev) {
          edit('Unthread', (d, mm) => {
            const prev = mm.items.get(port.frame.text!.prev!);
            if (prev) ops.unthreadAfter(d, mm, prev);
          });
        }
        return;
      }
      if (handle !== null && selItems.length) {
        g = startResize(handle, e);
      } else if ((effective === 'select' || effective === 'free') && selItems.length && rotateZone(sp) && !hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current)) {
        g = startRotate(p, selItems.filter(isEditable));
      } else {
        switch (effective) {
          case 'select':
          case 'free': {
            if (stateRef.current.typing) stopTyping(false);
            const gd = guideAt(p);
            const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
            if (!hit && gd) {
              g = startGuideMove(gd);
              break;
            }
            if (!hit) {
              g = startMarquee(p, e.shiftKey);
              break;
            }
            // The content grabber: the middle of a graphics frame moves the picture inside it.
            const frame = hit.item;
            const content = frame.kind !== 'group' && frame.children.find((c) => c.kind === 'graphic');
            if (content && effective === 'select' && !e.shiftKey) {
              const c = apply(frame.m, { x: frame.box.x + frame.box.w / 2, y: frame.box.y + frame.box.h / 2 });
              if (dist(toScreen({ x: c.x, y: c.y + hit.spread.y }), sp) <= 10) {
                select([frame.self], content.self);
                g = startMove(p, [content], e);
                break;
              }
            }
            let next = sel;
            if (e.shiftKey) next = sel.includes(frame.self) ? sel.filter((s) => s !== frame.self) : [...sel, frame.self];
            else if (!sel.includes(frame.self) || direct) next = [frame.self];
            select(next);
            const moving = next.map((s) => m.items.get(s)!).filter((it) => it && isEditable(it));
            if (moving.length && next.includes(frame.self)) g = startMove(p, moving, e);
            break;
          }
          case 'direct': {
            const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
            if (!hit) {
              g = startMarquee(p, e.shiftKey);
              break;
            }
            const leaf = hit.leaf;
            if (leaf.self === hit.item.self) select([leaf.self]);
            else select([hit.item.self], leaf.self);
            if (isEditable(hit.item)) g = startMove(p, [leaf], e);
            break;
          }
          case 'type':
            g = typeDown(p, e);
            break;
          case 'line':
            g = startDraw(p, 'line', false);
            break;
          case 'frame-rect':
          case 'frame-ellipse':
          case 'frame-polygon':
          case 'rect':
          case 'ellipse':
          case 'polygon': {
            const kind = effective.endsWith('rect') ? 'rect' : effective.endsWith('ellipse') ? 'oval' : 'polygon';
            g = startDraw(p, kind, effective.startsWith('frame'));
            break;
          }
          case 'pen':
            g = penDown(p);
            break;
          case 'pencil':
            g = startPencil(p);
            break;
          case 'rotate':
            g = startRotate(p, selItems.filter(isEditable));
            break;
          case 'scale':
          case 'shear':
            g = startScaleOrShear(p, selItems.filter(isEditable), effective);
            break;
          case 'eyedropper': {
            const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
            if (!hit) break;
            const src = hit.leaf.kind === 'graphic' ? hit.item : hit.leaf;
            const attrs = { FillColor: src.fill ?? 'Swatch/None', StrokeColor: src.stroke ?? 'Swatch/None', StrokeWeight: src.strokeWeight };
            if (selItems.length && !selItems.some((s) => s.self === src.self)) applyAttrs(attrs, 'Eyedropper');
            else {
              setSetting('defaults', { fill: attrs.FillColor, stroke: attrs.StrokeColor, weight: attrs.StrokeWeight });
              say('Picked up its fill and stroke. Select something and click again to apply them.');
            }
            break;
          }
          case 'gradient': {
            const targets = selItems.filter(isEditable);
            if (!targets.length) {
              say('Select something to put a gradient on.');
              break;
            }
            const grad = m.swatches.list.find((s) => s.kind === 'gradient') ?? [...m.swatches.bySelf.values()].find((s) => s.kind === 'gradient');
            let b = p;
            g = {
              move(q) {
                b = q;
                ovRef.current.draft = { kind: 'line', a: p, b };
                scheduleOverlay();
              },
              up() {
                ovRef.current.draft = null;
                scheduleOverlay();
                if (dist(p, b) * viewRef.current.zoom < 3) return;
                edit('Gradient', (d) => {
                  for (const it of targets) {
                    const s = m.spreadOf.get(it.self)!;
                    const inv = invert(it.m);
                    const la = apply(inv, { x: p.x, y: p.y - s.y });
                    const lb = apply(inv, { x: b.x, y: b.y - s.y });
                    const attrs: text.Attrs = {
                      GradientFillStart: `${la.x} ${la.y}`,
                      GradientFillLength: dist(la, lb),
                      GradientFillAngle: (-Math.atan2(lb.y - la.y, lb.x - la.x) * 180) / Math.PI,
                    };
                    const fillSwatch = it.fill ? m.swatches.bySelf.get(it.fill) : null;
                    if ((!fillSwatch || fillSwatch.kind !== 'gradient') && grad) attrs.FillColor = grad.self;
                    ops.setAttrs(d, it, attrs);
                  }
                });
              },
            };
            break;
          }
        }
      }
    }
    if (!g) return;
    gestureRef.current = g;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const m = modelRef.current;
    if (!m) return;
    const p = toPb(e);
    const g = gestureRef.current;
    if (g) {
      g.move(p, e.nativeEvent);
      return;
    }
    if (penRef.current && tool === 'pen') {
      ovRef.current.pen = [...penRef.current.pts.map((x) => x.anchor), p];
      scheduleOverlay();
    }
    // Hover feedback and cursors.
    const r = viewportRef.current!.getBoundingClientRect();
    const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    let hint: string | null = null;
    if ((tool === 'select' || tool === 'direct' || tool === 'free') && !stateRef.current.typing && !placeGun && !threadGun) {
      const h = handleAt(sp);
      if (h !== null) {
        const [hx, hy] = HANDLES[h];
        hint = hx === 0 ? 'ns-resize' : hy === 0 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize';
      } else if (portAt(sp)) hint = 'pointer';
      const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
      if (!hint && !hit && selItems.length && rotateZone(sp)) hint = 'alias';
      if (!hint && !hit && guideAt(p)) hint = 'move';
      const hv = hit ? { item: tool === 'direct' ? hit.leaf : hit.item, spread: hit.spread } : null;
      if (hv?.item.self !== hoverRef.current?.item.self) {
        hoverRef.current = hv;
        scheduleOverlay();
      }
    } else if (tool === 'type' && !placeGun) {
      const th = textHit(p);
      hint = th ? 'text' : 'crosshair';
    }
    if (hint !== cursorHint) setCursorHint(hint);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g) g.up(toPb(e), e.nativeEvent);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const m = modelRef.current;
    if (!m) return;
    const p = toPb(e);
    if (tool === 'pen' && penRef.current) return finishPen(false);
    if (tool === 'hand') return fitPage();
    if (tool === 'zoom') return zoomAt(1);
    if (tool !== 'select' && tool !== 'direct') return;
    const hit = hitTest(m, spreadsRef.current, p, viewRef.current.zoom, overridesRef.current);
    if (!hit) return;
    // Double-clicking a text frame starts typing there; a graphics frame selects its picture; a group, the item clicked.
    if (hit.leaf.kind === 'text' && isEditable(hit.leaf)) {
      const th = textHit(p);
      if (th) startTyping(th.frame, th.pos);
      return;
    }
    if (hit.leaf.self !== hit.item.self) select([hit.item.self], hit.leaf.self);
  };

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!modelRef.current) return;
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
  }, [onWheel, model !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Commands -------------------------------------------------------------------------------------

  const allPages = model?.pages ?? [];
  const pageIndex = Math.max(0, allPages.findIndex((p) => p.self === currentPage));

  const goPageIndex = (i: number) => {
    const m = modelRef.current;
    if (!m) return;
    if (masterView) setMasterView(false);
    const p = m.pages[Math.max(0, Math.min(m.pages.length - 1, i))];
    const s = p && m.spreads.find((x) => x.pages.some((q) => q.self === p.self));
    if (p && s) {
      requestAnimationFrame(() => goToPage(s, p));
      setPagesSel(new Set([p.self]));
    }
  };

  const selectedPages = (): Set<string> => (pagesSel.size ? pagesSel : new Set(currentPage ? [currentPage] : []));

  const cmd: Commands = {
    newDoc: () => setDialog({ kind: 'new' }),
    open: () => void openFile(),
    place: () => {
      if (!modelRef.current) return;
      const frame = selItems.length === 1 && selItems[0].kind !== 'text' && selItems[0].kind !== 'group' && selItems[0].kind !== 'line' ? (selItems[0].kind === 'graphic' ? modelRef.current.items.get(selItems[0].parent ?? '') ?? null : selItems[0]) : null;
      void placeFile(frame);
    },
    close: () => din.window.requestClose(),
    save: () => void save(),
    saveAs: () => void saveAs(),
    exportPng: () => void exportPng(),
    exportPdf: () => void exportPdf(),
    print: () => void printPdf(),
    documentSetup: () => setDialog({ kind: 'setup' }),
    undo: () => hist && hist.index > 0 && jump(hist.index - 1),
    redo: () => hist && hist.index < hist.entries.length - 1 && jump(hist.index + 1),
    cut: () => {
      cmd.copy();
      cmd.clear();
    },
    copy: () => {
      const m = modelRef.current;
      if (!m || !selItems.length) return;
      const top = direct ? selItems : selItems;
      clipboard.current = { els: ops.copyElements(m.pkg, m, top), text: null, spread: m.spreadOf.get(top[0].self)?.self ?? null };
      setHasClip(true);
      say(`Copied ${top.length === 1 ? 'one item' : `${top.length} items`}.`);
    },
    paste: () => pasteItems(false),
    pasteInPlace: () => pasteItems(true),
    clear: () => {
      if (!selItems.length) return;
      const items = selItems.filter(isEditable);
      if (!items.length) return say('The selection is locked.');
      edit('Delete', (d, m) => {
        ops.deleteItems(d, m, items);
        return { sel: [] };
      });
    },
    duplicate: () => {
      if (!selItems.length) return;
      edit('Duplicate', (d, m) => ({ sel: ops.duplicateItems(d, m, selItems, translate(12, 12)) }));
    },
    selectAll: () => {
      const s = currentSpread();
      if (!s) return;
      select(s.items.filter((it) => isEditable(it) && it.visible).map((it) => it.self));
    },
    deselectAll: () => select([]),
    addPage: () => edit('Add Page', (d, m) => ops.insertPages(d, m, pageIndex, 1, m.pages[pageIndex]?.master ?? m.masters[0]?.self ?? null)),
    insertPages: () => setDialog({ kind: 'insertPages' }),
    deletePage: () => {
      const pages = selectedPages();
      if (!pages.size) return;
      edit(pages.size > 1 ? 'Delete Pages' : 'Delete Page', (d, m) => {
        if (!ops.deletePages(d, m, pages)) say('A document needs at least one page.');
        return { sel: [] };
      });
      setPagesSel(new Set());
    },
    marginsColumns: () => setDialog({ kind: 'margins' }),
    goPage: (which) => goPageIndex(which === 'first' ? 0 : which === 'last' ? allPages.length - 1 : pageIndex + (which === 'next' ? 1 : -1)),
    fontSize: (delta) => {
      const c = typeInfo?.char;
      if (!c) return;
      applyCharAttrs({ PointSize: Math.max(0.1, Math.round((c.size + delta) * 10) / 10) }, 'Point Size');
    },
    insertPageNumber: () => {
      const t = stateRef.current.typing;
      if (!t) return;
      editText('Insert Page Number', (root) => {
        const lo = Math.min(t.a, t.b);
        if (t.a !== t.b) text.deleteRange(root, lo, Math.max(t.a, t.b));
        return text.insertMarker(root, lo, '18');
      });
    },
    toggleHidden: () => setSetting('hidden', !settings.hidden),
    textFrameOptions: () => {
      const m = modelRef.current;
      const t = stateRef.current.typing;
      const f = t ? m?.items.get(t.frame) : selItems.find((it) => it.kind === 'text');
      if (f?.kind === 'text') setDialog({ kind: 'frameOptions', frame: f });
    },
    transform: turn,
    arrange: (how) => selItems.length && edit('Arrange', (d) => ops.arrange(d, selItems, how)),
    group: () => {
      if (selItems.length < 2) return;
      edit('Group', (d, m) => {
        const g = ops.groupItems(d, m, selItems, activeLayer());
        if (!g) say('Only items on the same spread group together.');
        return g ? { sel: [g] } : undefined;
      });
    },
    ungroup: () => {
      const groups = selItems.filter((it) => it.kind === 'group');
      if (!groups.length) return;
      edit('Ungroup', (d, m) => ({ sel: groups.flatMap((g) => ops.ungroup(d, m, g)) }));
    },
    lock: () => selItems.length && edit('Lock', (d) => selItems.forEach((it) => ops.setAttrs(d, it, { Locked: 'true' }))),
    unlockAll: () => {
      const s = currentSpread();
      if (!s) return;
      const locked = [...walkItems(s.items)].filter((it) => it.locked);
      if (!locked.length) return;
      edit('Unlock All on Spread', (d) => {
        locked.forEach((it) => ops.setAttrs(d, it, { Locked: 'false' }));
        return { sel: locked.filter((it) => !it.parent).map((it) => it.self) };
      });
    },
    hide: () => selItems.length && edit('Hide', (d) => (selItems.forEach((it) => ops.setAttrs(d, it, { Visible: 'false' })), { sel: [] })),
    showAll: () => {
      const s = currentSpread();
      if (!s) return;
      const hidden = [...walkItems(s.items)].filter((it) => !it.visible);
      if (!hidden.length) return;
      edit('Show All on Spread', (d) => {
        hidden.forEach((it) => ops.setAttrs(d, it, { Visible: 'true' }));
        return { sel: hidden.filter((it) => !it.parent).map((it) => it.self) };
      });
    },
    fit: fitSel,
    cornerOptions: () => setDialog({ kind: 'corners' }),
    zoomIn: () => zoomAt(zoomStep(viewRef.current.zoom, 1)),
    zoomOut: () => zoomAt(zoomStep(viewRef.current.zoom, -1)),
    fitPage: () => fitPage(),
    fitSpread: () => {
      const s = currentSpread();
      if (s) fitRect(spreadRect(s));
    },
    actualSize: () => {
      // Keep the middle of the window where it is.
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const c = { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom };
      setView({ zoom: 1, x: w / 2 - c.x, y: h / 2 - c.y });
    },
    pasteboard: () => {
      const ss = spreadsRef.current;
      if (!ss.length) return;
      const all = ss.map(spreadRect);
      const b = boundsOf(all.flatMap((r) => rectCorners(r)));
      fitRect({ x: b.x - 200, y: b.y - 50, w: b.w + 400, h: b.h + 100 });
    },
    togglePreview: () => setPreview((v) => !v),
    toggleFrameEdges: () => setSetting('frameEdges', !settings.frameEdges),
    toggleThreads: () => setSetting('threads', !settings.threads),
    toggleGuides: () => setSetting('guides', !settings.guides),
    toggleRulers: () => setSetting('rulers', !settings.rulers),
    toggleSnap: () => setSetting('snap', !settings.snap),
    togglePanel: (id) => {
      setHidePanels(false);
      setSettings((s) => ({ ...s, panels: { ...s.panels, [id]: !s.panels[id] } }));
    },
    showControl: () => setSetting('control', !settings.control),
    shortcuts: () => setDialog({ kind: 'shortcuts' }),
    about: () => setDialog({ kind: 'about' }),
  };

  const pasteItems = (inPlace: boolean) => {
    const m = modelRef.current;
    const clip = clipboard.current;
    if (!m) return;
    if (!clip || !clip.els.length) {
      if (clip?.text && selItems.length === 1 && selItems[0].kind === 'text') return say('Double-click the text frame to paste text into it.');
      return say('There’s nothing to paste.');
    }
    const s = (inPlace && clip.spread ? spreadsRef.current.find((x) => x.self === clip.spread) : null) ?? currentSpread();
    if (!s) return;
    let t: Mat = [1, 0, 0, 1, 0, 0];
    if (!inPlace) {
      // Into the middle of the window.
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const center = { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom - s.y };
      const pts: Pt[] = [];
      for (const e of clip.els) {
        const n = (e.getAttribute('ItemTransform') ?? '1 0 0 1 0 0').split(/\s+/).map(Number);
        pts.push({ x: n[4] || 0, y: n[5] || 0 });
      }
      const b = boundsOf(pts);
      t = translate(center.x - (b.x + b.w / 2), center.y - (b.y + b.h / 2));
    }
    edit(inPlace ? 'Paste in Place' : 'Paste', (d) => ({ sel: ops.pasteElements(d, m, s, clip.els, mul(invert(s.m), t), activeLayer()) }));
  };

  const menuState: MenuState = {
    hasDoc: !!model,
    canUndo: !!hist && hist.index > 0,
    canRedo: !!hist && hist.index < hist.entries.length - 1,
    undoLabel: hist && hist.index > 0 ? hist.entries[hist.index].label : '',
    redoLabel: hist && hist.index < hist.entries.length - 1 ? hist.entries[hist.index + 1].label : '',
    hasSelection: selItems.length > 0,
    multiple: selItems.length > 1,
    isGroup: selItems.some((it) => it.kind === 'group'),
    hasContent: selItems.some((it) => (it.children.length > 0 && it.kind !== 'group') || it.kind === 'graphic'),
    textFrame: selItems.some((it) => it.kind === 'text') || !!typing,
    typing: !!typing,
    clipboard: hasClip,
    preview,
    frameEdges: settings.frameEdges,
    threads: settings.threads,
    guides: settings.guides,
    rulers: settings.rulers,
    snap: settings.snap,
    hidden: settings.hidden,
    panels,
    control: settings.control,
    pageCount: allPages.length,
  };

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
    if (e.key === ' ' && ctrl) return run(() => setZoomKey(e.altKey ? 'out' : 'in'));
    if (e.key === ' ') return run(() => setSpaceDown(true));
    if (e.key === 'Escape') {
      return run(() => {
        if (gestureRef.current) {
          gestureRef.current.cancel?.();
          gestureRef.current = null;
        } else if (penRef.current) finishPen(false);
        else if (placeGun) setPlaceGun(null);
        else if (threadGun) setThreadGun(null);
        else select([]);
        scheduleOverlay();
      });
    }
    if (e.key === 'Enter' && penRef.current) return run(() => finishPen(false));
    if (ctrl) {
      const shift = e.shiftKey;
      const alt = e.altKey;
      const map: Record<string, (() => void) | undefined> = {
        n: alt || shift ? undefined : cmd.newDoc,
        o: cmd.open,
        s: shift ? cmd.saveAs : cmd.save,
        w: alt ? (() => cmd.togglePanel('wrap')) : cmd.close,
        z: shift ? cmd.redo : cmd.undo,
        y: alt ? cmd.toggleThreads : cmd.redo,
        x: cmd.cut,
        c: alt && shift ? () => cmd.fit('fill') : alt ? () => cmd.fit('frameToContent') : cmd.copy,
        v: alt && shift ? cmd.pasteInPlace : cmd.paste,
        a: shift ? cmd.deselectAll : cmd.selectAll,
        d: alt && shift ? cmd.duplicate : shift ? () => cmd.togglePanel('links') : cmd.place,
        e: alt && shift ? () => cmd.fit('fit') : alt ? () => cmd.fit('stretch') : shift ? () => cmd.fit('center') : cmd.exportPng,
        g: shift ? cmd.ungroup : cmd.group,
        l: alt ? cmd.unlockAll : cmd.lock,
        '3': alt ? cmd.showAll : cmd.hide,
        b: cmd.textFrameOptions,
        t: alt ? () => cmd.togglePanel('paragraph') : () => cmd.togglePanel('character'),
        p: shift ? cmd.addPage : alt ? cmd.documentSetup : cmd.print,
        h: cmd.toggleFrameEdges,
        r: cmd.toggleRulers,
        i: alt ? cmd.toggleHidden : undefined,
        ';': shift ? cmd.toggleSnap : cmd.toggleGuides,
        '0': alt && shift ? cmd.pasteboard : alt ? cmd.fitSpread : cmd.fitPage,
        '1': cmd.actualSize,
        '=': cmd.zoomIn,
        '+': cmd.zoomIn,
        '-': cmd.zoomOut,
        ']': () => cmd.arrange(shift ? 'front' : 'forward'),
        '[': () => cmd.arrange(shift ? 'back' : 'backward'),
        '}': () => cmd.arrange('front'),
        '{': () => cmd.arrange('back'),
        '6': alt ? cmd.showControl : undefined,
        pageup: shift ? () => cmd.goPage('first') : undefined,
        pagedown: shift ? () => cmd.goPage('last') : undefined,
      };
      const fn = map[key] ?? map[e.code === 'Digit0' ? '0' : e.code === 'Digit3' ? '3' : e.code === 'Digit1' ? '1' : e.code === 'Digit6' ? '6' : ''];
      if (fn) return run(fn);
      return;
    }
    if (e.key === 'F5') return run(() => cmd.togglePanel('swatches'));
    if (e.key === 'F6') return run(() => cmd.togglePanel('color'));
    if (e.key === 'F7') return run(() => cmd.togglePanel('layers'));
    if (e.key === 'F10') return run(() => cmd.togglePanel('stroke'));
    if (e.key === 'F11') return run(() => cmd.togglePanel(e.shiftKey ? 'charStyles' : 'paraStyles'));
    if (e.key === 'F12') return run(() => cmd.togglePanel('pages'));
    if (e.key === 'PageUp' || e.key === 'PageDown') return run(() => cmd.goPage(e.key === 'PageUp' ? 'prev' : 'next'));
    if (e.key === 'Delete' || e.key === 'Backspace') return run(cmd.clear);
    if (e.key === 'Tab') return run(() => setHidePanels((h) => !h));
    if (e.key.startsWith('Arrow') && selItems.length) {
      return run(() => {
        const n = nudgeStep(unit) * (e.shiftKey ? 10 : 1);
        const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
        const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
        if (e.altKey) edit('Duplicate', (d, m) => ({ sel: ops.duplicateItems(d, m, selItems, translate(dx, dy)) }));
        else edit('Nudge', (d, m) => selItems.filter(isEditable).forEach((it) => ops.setTransformOf(d, m, it, translate(dx, dy))), `nudge:${sel.join(',')}`);
      });
    }
    if (e.altKey) return;
    if (key === 'x' && e.shiftKey) {
      return run(() => {
        if (selItems.length) applyAttrs({ FillColor: objInfo?.stroke ?? 'Swatch/None', StrokeColor: objInfo?.fill ?? 'Swatch/None' }, 'Swap Fill and Stroke');
        else setSetting('defaults', { ...settings.defaults, fill: settings.defaults.stroke, stroke: settings.defaults.fill });
      });
    }
    if (key === 'x') return run(() => setActiveAttr((a) => (a === 'fill' ? 'stroke' : 'fill')));
    if (key === 'd' && !e.shiftKey) {
      return run(() => {
        if (selItems.length) applyAttrs({ FillColor: 'Swatch/None', StrokeColor: 'Color/Black', StrokeWeight: 1 }, 'Default Fill and Stroke');
        else setSetting('defaults', { fill: 'Swatch/None', stroke: 'Color/Black', weight: 1 });
      });
    }
    if (key === '/') return run(() => applySwatch('Swatch/None'));
    if (key === 'w' && !e.shiftKey) return run(cmd.togglePreview);
    const t = toolByCode(key);
    if (t && !e.shiftKey) return run(() => setTool(t.id));
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      setSpaceDown(false);
      setZoomKey(null);
    }
    if (e.key === 'Control' || e.key === 'Meta') setZoomKey(null);
    if (e.key === 'Alt') e.preventDefault();
  };

  useEffect(() => {
    const blur = () => {
      setSpaceDown(false);
      setZoomKey(null);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);

  // ---- Links ----------------------------------------------------------------------------------------

  const links: LinkRow[] = useMemo(() => {
    if (!model) return [];
    const out: LinkRow[] = [];
    for (const it of model.items.values()) {
      if (it.kind !== 'graphic' || !it.graphic) continue;
      const s = model.spreadOf.get(it.self);
      const page = s && !s.isMaster ? (s.pages.find((p) => apply(it.m, { x: it.box.x + it.box.w / 2, y: 0 }).x < p.bounds.x + p.bounds.w) ?? s.pages[0]) : null;
      const entry = images?.peek(it.self, it.graphic.link);
      const lp = linkPath(it.graphic.link);
      out.push({
        self: it.self,
        name: lp ? basename(lp.replace(/\\/g, '/')) : it.graphic.embedded ? 'Embedded graphic' : `${it.graphic.kind} ${it.self}`,
        page: s?.isMaster ? s.prefix : (page?.name ?? ''),
        status: it.graphic.embedded ? 'embedded' : !entry || entry.state === 'loading' ? 'loading' : entry.source === 'linked' ? 'ok' : entry.source === 'preview' ? 'preview' : entry.source === 'embedded' ? 'embedded' : 'missing',
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, images, imagesVersion]);

  const relink = async (self: string) => {
    const m = modelRef.current;
    const it = m?.items.get(self);
    if (!m || !it) return;
    const f = await pick('Relink', 'Graphics', PLACE_EXTENSIONS);
    const t = f?.path;
    if (!t) return;
    edit('Relink', (d) => {
      const e = ops.itemEl(d, it);
      const link = e && Array.from(e.children).find((c) => c.localName === 'Link');
      if (link) {
        link.setAttribute('LinkResourceURI', ops.linkUri(t));
        link.setAttribute('StoredState', 'Normal');
      }
    });
    images?.drop(self);
  };

  // ---- Rendering ---------------------------------------------------------------------------------------

  const cursor = (() => {
    if (spaceDown) return panning ? 'grabbing' : 'grab';
    if (zoomKey) return zoomKey === 'out' ? 'zoom-out' : 'zoom-in';
    if (placeGun || threadGun) return 'copy';
    if (cursorHint) return cursorHint;
    switch (tool) {
      case 'hand':
        return panning ? 'grabbing' : 'grab';
      case 'zoom':
        return 'zoom-in';
      case 'type':
        return 'text';
      case 'select':
      case 'direct':
      case 'free':
        return 'default';
      case 'eyedropper':
        return 'crosshair';
      default:
        return 'crosshair';
    }
  })();

  const layerOfSel = new Set(selItems.map((it) => it.layer));
  const curPara = typeInfo?.para.style ?? null;
  const curChar = typeInfo?.char.charStyle || null;
  const selItem = selItems.length === 1 ? selItems[0] : null;
  const activeSw = activeAttr === 'fill' ? fillSw : strokeSw;

  const panelBody: Record<PanelId, React.ReactNode> = {
    pages: model ? (
      <PagesPanel
        masters={model.masters}
        spreads={model.spreads}
        pageCount={model.pages.length}
        current={currentPage}
        selected={pagesSel}
        onSelect={setPagesSel}
        onGo={(p) => {
          setMasterView(false);
          const s = model.spreads.find((x) => x.pages.some((q) => q.self === p.self));
          if (s) requestAnimationFrame(() => goToPage(s, p));
        }}
        onGoMaster={(ms) => {
          setMasterView(true);
          requestAnimationFrame(() => fitRect(spreadRect(ms)));
        }}
        onInsert={cmd.addPage}
        onDelete={cmd.deletePage}
        onApplyMaster={(ms) =>
          edit('Apply Master', (d, m) => {
            ops.applyMaster(d, m, [...selectedPages()], ms);
          })
        }
        draw={drawThumb}
        version={thumbVersion}
      />
    ) : null,
    layers: model ? (
      <LayersPanel
        layers={model.layers}
        active={layerPick && model.layers.some((l) => l.self === layerPick) ? layerPick : activeLayerOf(model)}
        withSelection={layerOfSel}
        onActive={setLayerPick}
        onToggle={(self, what) => {
          const l = model.layers.find((x) => x.self === self);
          if (!l) return;
          edit(what === 'Visible' ? (l.visible ? 'Hide Layer' : 'Show Layer') : l.locked ? 'Unlock Layer' : 'Lock Layer', (d) => ops.setLayer(d, self, { [what]: String(what === 'Visible' ? !l.visible : !l.locked) }));
        }}
        onRename={(self, name) => edit('Rename Layer', (d) => ops.setLayer(d, self, { Name: name }))}
        onNew={() => {
          setLayerPick(null);
          edit('New Layer', (d, m) => void ops.addLayer(d, m));
        }}
        onDelete={(self) => edit('Delete Layer', (d, m) => (ops.deleteLayer(d, m, self), { sel: [] }))}
        onMoveSelection={(self) => selItems.length && edit('Move to Layer', (d) => selItems.forEach((it) => ops.setAttrs(d, it, { ItemLayer: self })))}
      />
    ) : null,
    links: (
      <LinksPanel
        links={links}
        selected={linkSel}
        onSelect={(self) => {
          setLinkSel(self);
          const m = modelRef.current;
          const it = m?.items.get(self);
          const s = it && m?.spreadOf.get(self);
          if (it && s && m) {
            if (s.isMaster !== masterView) setMasterView(s.isMaster);
            select(it.parent ? [it.parent] : [self], it.parent ? self : null);
            const b = itemBounds(it);
            requestAnimationFrame(() => fitRect({ x: b.x, y: b.y + s.y, w: b.w, h: b.h }, viewRef.current.zoom));
          }
        }}
        onRelink={(self) => void relink(self)}
      />
    ),
    stroke: <StrokePanel obj={objInfo} item={selItem} onAttrs={(a) => applyAttrs(a, 'Stroke')} />,
    swatches: model ? (
      <SwatchesPanel
        swatches={model.swatches}
        fill={fillSw ? fillSw.self : fillSw}
        stroke={strokeSw ? strokeSw.self : strokeSw}
        active={activeAttr}
        onActive={setActiveAttr}
        onApply={(self) => applySwatch(self)}
        onNew={() => {
          const base = activeSw && activeSw.kind !== 'none' && activeSw.kind !== 'gradient' ? activeSw : null;
          const space = base?.space === 'RGB' ? 'RGB' : 'CMYK';
          const values = base ? (space === 'RGB' ? [...base.rgb] : base.space === 'CMYK' ? [...base.values] : rgbToCmyk(...base.rgb)) : [0, 0, 0, 100];
          setDialog({ kind: 'swatch', self: null, initial: { name: '', space, values } });
        }}
        onDelete={(self) => edit('Delete Swatch', (d, m) => ops.deleteSwatch(d, m, self))}
        onEdit={(self) => {
          const s = model.swatches.bySelf.get(self);
          if (!s) return;
          const space = s.space === 'RGB' ? 'RGB' : 'CMYK';
          setDialog({ kind: 'swatch', self, initial: { name: s.name, space, values: space === 'CMYK' && s.space === 'CMYK' ? [...s.values] : space === 'RGB' ? [...s.rgb] : rgbToCmyk(...s.rgb) } });
        }}
        tint={selItem ? (activeAttr === 'fill' ? (selItem.fillTint < 0 ? 100 : selItem.fillTint) : selItem.strokeTint < 0 ? 100 : selItem.strokeTint) : null}
        onTint={(v) => applyAttrs(activeAttr === 'fill' ? { FillTint: v } : { StrokeTint: v }, 'Tint')}
      />
    ) : null,
    color: (
      <ColorPanel
        swatch={activeSw}
        label={activeAttr === 'fill' ? 'Fill' : 'Stroke'}
        onColor={(space, values) => {
          const m = modelRef.current;
          if (!m) return;
          // An unnamed color, as InDesign makes when you mix one in the Color panel.
          const d = new Draft(m.pkg);
          const self = ops.addColor(d, m, null, space, values);
          const attr = activeAttr === 'fill' ? 'FillColor' : 'StrokeColor';
          if (typing) {
            const t = typing;
            const root = ops.storyRoot(d, m, t.story);
            if (root && t.a !== t.b) text.applyChar(root, Math.min(t.a, t.b), Math.max(t.a, t.b), { [attr]: self });
          } else if (selItems.length) for (const it of selItems) ops.setAttrs(d, it, { [attr]: self });
          else setSetting('defaults', { ...settings.defaults, [activeAttr]: self });
          commit('Color', d.done(), { coalesce: `color:${sel.join(',')}:${activeAttr}` });
        }}
      />
    ),
    character: <CharacterPanel type={typeInfo} onChar={(a) => applyCharAttrs(a)} />,
    paragraph: <ParagraphPanel type={typeInfo} unit={unit} onPara={(a) => applyParaAttrs(a)} />,
    paraStyles: model ? (
      <StylesPanel
        kind="paragraph"
        styles={model.styles.paraList}
        current={curPara}
        onApply={(self) => applyParaAttrs({ AppliedParagraphStyle: self }, 'Apply Paragraph Style')}
        onNew={() => {
          const m = modelRef.current;
          if (!m) return;
          const f = typing ? flatOf(typing.story) : null;
          const psr = f ? (f.paras[text.paraIndexAt(f, Math.min(typing!.a, typing!.b))]?.psr ?? null) : null;
          const d = new Draft(m.pkg);
          const self = ops.newStyle(d, m, 'ParagraphStyle', curPara, psr);
          commit('New Paragraph Style', d.done());
          if (typing) requestAnimationFrame(() => applyParaAttrs({ AppliedParagraphStyle: self }, 'Apply Paragraph Style'));
        }}
      />
    ) : null,
    charStyles: model ? (
      <StylesPanel
        kind="character"
        styles={model.styles.charList}
        current={curChar ?? 'CharacterStyle/$ID/[No character style]'}
        onApply={(self) => applyCharAttrs({ AppliedCharacterStyle: self }, 'Apply Character Style')}
        onNew={() => {
          const m = modelRef.current;
          if (!m) return;
          const f = typing ? flatOf(typing.story) : null;
          const seg = f ? text.segAt(f, Math.min(typing!.a, typing!.b) + 1) : null;
          const d = new Draft(m.pkg);
          ops.newStyle(d, m, 'CharacterStyle', null, seg?.csr ?? null);
          commit('New Character Style', d.done());
        }}
      />
    ) : null,
    wrap: (
      <WrapPanel
        wrap={selItem ? (selItem.wrap ? { mode: selItem.wrap.mode, offsets: selItem.wrap.offsets } : null) : undefined}
        unit={unit}
        onWrap={(mode, off) => selItem && edit('Text Wrap', (d) => ops.setWrap(d, selItem, mode, off), `wrap:${selItem.self}`)}
      />
    ),
  };

  const order: PanelId[] = ['pages', 'layers', 'links', 'stroke', 'swatches', 'color', 'character', 'paragraph', 'paraStyles', 'charStyles', 'wrap'];
  const panelList = (
    <aside className={cn('flex w-[264px] shrink-0 flex-col overflow-y-auto border-l border-[#232323] bg-[#383838]', hidePanels && 'hidden')} aria-label="Panels">
      {order.map((id) => (
        <Panel key={id} title={PANEL_NAMES[id]} open={panels[id]} onToggle={() => cmd.togglePanel(id)} grow={id === 'pages'}>
          {model ? panelBody[id] : <p className="p-3 text-[11px] text-[#9a9a9a]">No document.</p>}
        </Panel>
      ))}
    </aside>
  );

  const errors = errorCount + links.filter((l) => l.status === 'missing').length;

  const tabTitle = model ? `${docName} @ ${fmtZoom(zoomShown)}${masterView ? ' [Masters]' : ''}` : '';

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="relative flex h-full w-full flex-col bg-[#282828] text-[#e0e0e0] outline-none select-none"
      style={{ fontFamily: '"Inter Variable", "Noto Sans", sans-serif' }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <PublisherMenus cmd={cmd} st={menuState} />
      {settings.control && (
        <ControlPanel
          mode={typing || (tool === 'type' && typeInfo) ? 'type' : objInfo ? 'object' : 'none'}
          unit={unit}
          refPoint={settings.refPoint}
          onRefPoint={(p) => setSetting('refPoint', p)}
          obj={objInfo}
          onGeometry={onGeometry}
          onAttrs={(a) => applyAttrs(a)}
          onOpacity={(v) => selItems.length && edit('Opacity', (d) => selItems.forEach((it) => ops.setOpacity(d, it, v)), `opacity:${sel.join(',')}`)}
          onTurn={turn}
          onFit={fitSel}
          onColumns={(n) => {
            const f = selItems.find((it) => it.kind === 'text');
            if (f?.text) edit('Columns', (d) => ops.setFrameOptions(d, f, { ...f.text!.prefs, columns: n, gutter: f.text!.prefs.gutter, inset: f.text!.prefs.inset, firstBaseline: f.text!.prefs.firstBaseline, minFirstBaseline: f.text!.prefs.minFirstBaseline, ignoreWrap: f.text!.prefs.ignoreWrap, vj: f.text!.prefs.vj }));
          }}
          swatches={model?.swatches ?? { bySelf: new Map(), list: [] }}
          type={typeInfo}
          onChar={(a) => applyCharAttrs(a)}
          onPara={(a) => applyParaAttrs(a)}
          onParaStyle={(s) => applyParaAttrs({ AppliedParagraphStyle: s }, 'Apply Paragraph Style')}
          onCharStyle={(s) => applyCharAttrs({ AppliedCharacterStyle: s }, 'Apply Character Style')}
          textFill={typeInfo?.char.fill ?? null}
          constrain={settings.constrain}
          onConstrain={(v) => setSetting('constrain', v)}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <Toolbar
          tool={tool}
          choice={settings.choice}
          onTool={setTool}
          fill={fillSw}
          stroke={strokeSw}
          active={activeAttr}
          onActive={setActiveAttr}
          onSwap={() => {
            if (selItems.length) applyAttrs({ FillColor: objInfo?.stroke ?? 'Swatch/None', StrokeColor: objInfo?.fill ?? 'Swatch/None' }, 'Swap Fill and Stroke');
            else setSetting('defaults', { ...settings.defaults, fill: settings.defaults.stroke, stroke: settings.defaults.fill });
          }}
          onDefault={() => {
            if (selItems.length) applyAttrs({ FillColor: 'Swatch/None', StrokeColor: 'Color/Black', StrokeWeight: 1 }, 'Default Fill and Stroke');
            else setSetting('defaults', { fill: 'Swatch/None', stroke: 'Color/Black', weight: 1 });
          }}
          onApply={(what) => {
            if (what === 'none') return applySwatch('Swatch/None');
            const m = modelRef.current;
            if (!m) return;
            const pick = what === 'gradient' ? m.swatches.list.find((s) => s.kind === 'gradient') ?? [...m.swatches.bySelf.values()].find((s) => s.kind === 'gradient') : m.swatches.bySelf.get(settings.defaults.fill !== 'Swatch/None' ? settings.defaults.fill : 'Color/Black');
            if (pick) applySwatch(pick.self);
          }}
          affectsText={affectsText || !!typing}
          onAffectsText={setAffectsText}
          preview={preview}
          onPreview={setPreview}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {model && (
            <div className="flex h-7 shrink-0 items-end border-b border-[#1c1c1c] bg-[#2b2b2b] px-1">
              <div className="flex h-6 max-w-full items-center gap-2 truncate rounded-t-[3px] bg-[#383838] px-3 text-[11px] text-[#e6e6e6]" title={file?.path ?? docName}>
                {dirty ? '• ' : ''}
                {tabTitle}
              </div>
            </div>
          )}
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 touch-none overflow-hidden"
            style={{ cursor: model ? cursor : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (hoverRef.current) {
                hoverRef.current = null;
                scheduleOverlay();
              }
            }}
            onDoubleClick={onDoubleClick}
            onContextMenu={(e) => e.preventDefault()}
          >
            <canvas ref={sceneRef} className="absolute inset-0 size-full" aria-label={model ? `Document: ${docName}` : undefined} />
            <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
            {typing && (
              <textarea
                ref={textareaRef}
                aria-label="Type"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onInput={onTextInput}
                onKeyDown={onTextKey}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={(e) => {
                  composing.current = false;
                  const v = e.currentTarget.value;
                  e.currentTarget.value = '';
                  if (v) typeText(v);
                }}
                onBlur={(e) => {
                  // Clicks on panels and fields keep the text selection; the canvas takes focus back.
                  if (e.relatedTarget === null) return;
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="pointer-events-none absolute h-4 w-4 resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent outline-none"
                style={{ left: 0, top: 0 }}
              />
            )}
            {!model && !loading && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <div className="w-full max-w-md space-y-6 text-center">
                  <div className="space-y-2">
                    <h1 className="text-[40px] leading-tight font-semibold tracking-tight text-[#f0f0f0]">Publisher</h1>
                    <p className="text-lg text-[#b5b5b5]">Pages, frames, threaded text and styles. Opens Microsoft Publisher and InDesign documents and IDML, and saves IDML.</p>
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
                      New document
                    </button>
                    <button
                      type="button"
                      onClick={() => void openFile()}
                      className={cn('flex h-11 items-center gap-2 rounded-full border border-[#6a6a6a] px-5 text-base font-medium text-[#e6e6e6] hover:bg-white/5', FOCUS)}
                    >
                      <FolderOpen className="size-5" />
                      Open…
                    </button>
                  </div>
                  <p className="text-sm text-[#8a8a8a]">Ctrl+N new · Ctrl+O open · .pub, .indd, .indt and .idml</p>
                </div>
              </div>
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Opening">
                <div className="flex h-2/3 w-1/2 animate-pulse items-center justify-center rounded-sm bg-[#3a3a3a] text-sm text-[#9a9a9a] motion-reduce:animate-none">Opening…</div>
              </div>
            )}
          </div>
          <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-[#1c1c1c] bg-[#323232] px-2 text-[11px] text-[#bdbdbd]">
            {model && (
              <>
                <input
                  aria-label="Zoom level"
                  key={zoomShown}
                  defaultValue={fmtZoom(zoomShown)}
                  list="publisher-zooms"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      const v = parseFloat((e.target as HTMLInputElement).value);
                      if (Number.isFinite(v) && v > 0) zoomAt(v / 100);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (/%$/.test(e.target.value) && Number.isFinite(v) && v > 0 && ZOOMS.some((z) => Math.abs(z * 100 - v) < 0.6)) zoomAt(v / 100);
                  }}
                  className={cn(INPUT, 'h-5 w-[62px] text-[11px]')}
                />
                <datalist id="publisher-zooms">
                  {[5, 12.5, 25, 50, 75, 100, 125, 150, 200, 400, 800].map((z) => (
                    <option key={z} value={`${z}%`} />
                  ))}
                </datalist>
                <span className="mx-1 h-4 w-px bg-[#232323]" />
                <button type="button" aria-label="First page" title="First Spread" onClick={() => cmd.goPage('first')} className={cn('grid size-5 place-items-center rounded-[2px] hover:bg-[#4a4a4a]', FOCUS)}>
                  <ChevronFirst className="size-3.5" />
                </button>
                <button type="button" aria-label="Previous page" title="Previous Spread" onClick={() => cmd.goPage('prev')} className={cn('grid size-5 place-items-center rounded-[2px] hover:bg-[#4a4a4a]', FOCUS)}>
                  <ChevronLeft className="size-3.5" />
                </button>
                <select
                  aria-label="Page"
                  value={masterView ? '' : (currentPage ?? '')}
                  onChange={(e) => {
                    const i = allPages.findIndex((p) => p.self === e.target.value);
                    if (i >= 0) goPageIndex(i);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={cn(INPUT, 'h-5 w-16 cursor-pointer px-1 text-[11px]')}
                >
                  {masterView && <option value="">Masters</option>}
                  {allPages.map((p) => (
                    <option key={p.self} value={p.self}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label="Next page" title="Next Spread" onClick={() => cmd.goPage('next')} className={cn('grid size-5 place-items-center rounded-[2px] hover:bg-[#4a4a4a]', FOCUS)}>
                  <ChevronRight className="size-3.5" />
                </button>
                <button type="button" aria-label="Last page" title="Last Spread" onClick={() => cmd.goPage('last')} className={cn('grid size-5 place-items-center rounded-[2px] hover:bg-[#4a4a4a]', FOCUS)}>
                  <ChevronLast className="size-3.5" />
                </button>
                <span className="mx-1 h-4 w-px bg-[#232323]" />
                <span className="flex items-center gap-1" title={errors ? 'Overset text or missing links' : 'No errors'}>
                  <span className={cn('size-2.5 rounded-full', errors ? 'bg-[#e0443e]' : 'bg-[#3fb950]')} />
                  {errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : 'No errors'}
                </span>
                {selItems.length > 0 && objInfo && (
                  <span className="hidden tabular-nums md:inline">
                    · W {fmtLength(objInfo.w, unit)} × H {fmtLength(objInfo.h, unit)}
                  </span>
                )}
              </>
            )}
            <span role="status" className={cn('min-w-0 flex-1 truncate text-right', status?.startsWith('Couldn’t') && 'text-[#ff8a8a]')} title={warnings.length ? warnings.slice(0, 12).join('\n') : undefined}>
              {busy && !status ? 'Working…' : status}
            </span>
          </div>
        </div>
        {panelList}
      </div>

      {dialog?.kind === 'new' && (
        <NewDocDialog
          onCancel={() => setDialog(null)}
          onCreate={(s: NewDocSettings) => {
            setDialog(null);
            const pk = newDocument(s);
            if (modelRef.current) {
              // A document of its own window, as InDesign opens another tab.
              void din.app.open('publisher', { newDoc: { ...s, margins: { ...s.margins }, bleed: { ...s.bleed } } });
              return;
            }
            startDoc(pk, 'Untitled-1', null, null, new Map());
          }}
        />
      )}
      {dialog?.kind === 'frameOptions' && (
        <TextFrameOptionsDialog
          initial={{ ...dialog.frame.text!.prefs }}
          unit={unit}
          onCancel={() => {
            overridesRef.current = new Map();
            setDialog(null);
            scheduleScene();
          }}
          onPreview={(o) => {
            const f = dialog.frame;
            overridesRef.current = o ? new Map([[f.self, { ...f, text: { ...f.text!, prefs: { ...f.text!.prefs, ...o } } }]]) : new Map();
            scheduleScene();
          }}
          onOk={(o) => {
            const f = dialog.frame;
            setDialog(null);
            edit('Text Frame Options', (d) => ops.setFrameOptions(d, f, o));
          }}
        />
      )}
      {dialog?.kind === 'insertPages' && model && (
        <InsertPagesDialog
          count={model.pages.length}
          masters={model.masters.map((m) => ({ self: m.self, name: `${m.prefix}-${m.name}` }))}
          onCancel={() => setDialog(null)}
          onOk={(n, where, at, master) => {
            setDialog(null);
            const after = where === 'start' ? -1 : where === 'end' ? model.pages.length - 1 : where === 'before' ? at - 2 : at - 1;
            edit(n > 1 ? 'Insert Pages' : 'Insert Page', (d, m) => ops.insertPages(d, m, after, n, master));
          }}
        />
      )}
      {dialog?.kind === 'margins' && model && (
        <MarginsDialog
          initial={(() => {
            const p = model.pages.find((x) => selectedPages().has(x.self)) ?? model.pages[0];
            return { top: p.margins.top, bottom: p.margins.bottom, left: p.margins.left, right: p.margins.right, columns: p.margins.columns, gutter: p.margins.gutter };
          })()}
          unit={unit}
          onCancel={() => setDialog(null)}
          onOk={(mg) => {
            setDialog(null);
            const pages = selectedPages();
            edit('Margins and Columns', (d, m) => {
              for (const p of m.pages) if (pages.has(p.self)) ops.setMargins(d, p, mg);
            });
          }}
        />
      )}
      {dialog?.kind === 'corners' && selItems.length > 0 && (
        <CornerDialog
          initial={{ option: selItems[0].cornerOption, radius: selItems[0].cornerRadius }}
          unit={unit}
          onCancel={() => setDialog(null)}
          onOk={(option, radius) => {
            setDialog(null);
            edit('Corner Options', (d) => selItems.forEach((it) => ops.setAttrs(d, it, ops.cornerAttrs(option, radius))));
          }}
        />
      )}
      {dialog?.kind === 'swatch' && (
        <SwatchDialog
          title={dialog.self ? 'Swatch Options' : 'New Color Swatch'}
          initial={dialog.initial}
          onCancel={() => setDialog(null)}
          onOk={(name, space, values) => {
            const self = dialog.self;
            setDialog(null);
            edit(self ? 'Swatch Options' : 'New Swatch', (d, m) => {
              if (self) ops.editColor(d, m, self, space, values, name);
              else {
                const s = ops.addColor(d, m, name, space, values);
                for (const it of selItems) ops.setAttrs(d, it, activeAttr === 'fill' ? { FillColor: s } : { StrokeColor: s });
              }
            });
          }}
        />
      )}
      {dialog?.kind === 'setup' && model && (
        <DocumentSetupDialog
          initial={{ width: model.prefs.pageW, height: model.prefs.pageH, facing: model.prefs.facing }}
          unit={unit}
          onCancel={() => setDialog(null)}
          onOk={(w, h) => {
            setDialog(null);
            edit('Document Setup', (d, m) => ops.setPageSize(d, m, w, h));
          }}
        />
      )}
      {dialog?.kind === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'saveNote' && (
        <SaveNoteDialog
          name={docName}
          from={converted ?? 'indd'}
          onCancel={() => setDialog(null)}
          onOk={() => {
            setDialog(null);
            void saveAs();
          }}
        />
      )}
      {dialog?.kind === 'unsaved' && (
        <Dialog
          title="Publisher"
          onCancel={() => setDialog(null)}
          onOk={() => {
            setDialog(null);
            void (converted ? saveAs() : save()).then((ok) => ok && closeNow());
          }}
          okLabel={busy ? 'Saving…' : 'Save'}
          extra={
            <Button onClick={closeNow} className="border-[#a05050] text-[#ffb4b4] hover:border-[#c06060]">
              Don’t Save
            </Button>
          }
        >
          <p className="text-sm text-[#e6e6e6]">Save changes to “{docName}” before closing?</p>
          <p className="mt-1 text-xs text-[#a0a0a0]">{converted ? 'It will be saved as InDesign Markup (.idml), which InDesign opens.' : 'If you don’t, your changes will be lost.'}</p>
        </Dialog>
      )}
    </div>
  );
}

function isNewDocSettings(v: unknown): v is NewDocSettings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const n = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  const sides = (x: unknown) => !!x && typeof x === 'object' && ['top', 'bottom', 'inside', 'outside'].every((k) => n((x as Record<string, unknown>)[k], 0, 5000));
  return (
    n(s.width, 1, 15552) &&
    n(s.height, 1, 15552) &&
    n(s.pages, 1, 9999) &&
    n(s.startPage, 1, 99999) &&
    n(s.columns, 1, 216) &&
    n(s.gutter, 0, 5000) &&
    typeof s.facing === 'boolean' &&
    typeof s.primaryTextFrame === 'boolean' &&
    typeof s.unit === 'string' &&
    ['pt', 'p', 'in', 'mm', 'cm', 'px'].includes(s.unit) &&
    sides(s.margins) &&
    sides(s.bleed)
  );
}

/** The layer new things go on. */
function activeLayerOf(m: Model | null): string {
  if (!m) return '';
  return (m.activeLayer && m.layers.some((l) => l.self === m.activeLayer) ? m.activeLayer : m.layers[0]?.self) ?? '';
}

/** Fewer points along a freehand line (Ramer–Douglas–Peucker). */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDistance(pts[i], pts[a], pts[b]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

