import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { FilePlus, FileText, FolderOpen } from 'lucide-react';
import { DropdownMenu as Menu } from 'radix-ui';
import { useDin } from '@/sdk/react';
import '@/shared/office/fonts';
import { fontStack, stepFontSize } from '@/shared/office/fonts';
import {
  Backstage,
  MenuContent,
  MenuItem,
  MenuSeparator,
  OfficeDialog,
  OfficeFrame,
  RibbonTabs,
  StatusBar,
  StatusText,
  SubMenu,
  TitleBar,
  ViewButton,
  ZoomSlider,
  OfficeButton,
  Field,
  type BackstagePage,
  type PickedColor,
  type RibbonTab,
} from '@/shared/office/chrome';
import { FIELD } from '@/shared/office/accent';
import { extOfPath, imageSize, OpcPackage } from '@/shared/office/ooxml';
import { useOfficeFile } from '@/shared/office/useOfficeFile';
import { Canvas, type Editing, type InsertTool } from './slides/Canvas';
import { readChart } from './slides/chartData';
import { FitIcon, NormalViewIcon, NotesIcon, PlayIcon, SorterIcon } from './slides/icons';
import { copyMedia, loadPresentation, mediaUrl, newPresentation, OPEN_EXTENSIONS, SAVE_ODP, SAVE_PPSX, SAVE_TYPES, savePresentation } from './slides/io';
import {
  EMU_PER_INCH,
  hasText,
  newUid,
  plainText,
  PX,
  SIZE_16_9,
  SIZE_4_3,
  type Color,
  type Deck,
  type Layout,
  type ParaProps,
  type RunProps,
  type Shape,
  type Slide,
  type SlideCtx,
  type TextBody,
  type Xfrm,
  walkShapes,
} from './slides/model';
import { DESIGNS, type DesignTheme } from './slides/newDeck';
import {
  alignShapes,
  applyFooter,
  footerSettings,
  boxOf,
  changeLayout,
  cloneShape,
  emptyText,
  findShape,
  firstRunProps,
  groupShapes,
  layoutOf,
  mapParas,
  mapRuns,
  mapShapeDeep,
  masterOf,
  newPicture,
  newTable,
  nextId,
  reorder,
  resizeDeck,
  shapeText,
  slideFromLayout,
  textCapable,
  ungroupShape,
  withXfrm,
} from './slides/ops';
import { SlidesRibbon, type CaseKind, type FormatState, type RibbonCommands, type RibbonState } from './slides/Ribbon';
import { DesignSwatch } from './slides/Ribbon';
import { SlideImage } from './slides/render';
import { fontName, inheritChain, layoutCtx, resolvePara, resolveRun, slideCtx, textChain } from './slides/resolve';
import { SlideShow } from './slides/Show';
import { HeaderFooterDialog } from './slides/HeaderFooter';
import { cellLook } from './slides/table';
import { DEFAULT_TABLE_STYLE } from './slides/tableStyles';
import { applyPara, applyRun, changeCaseIn, editorLook, growFont, selectedText } from './slides/textEdit';
import { SLIDE_CSS, textEnv } from './slides/textStyle';
import { COLOR_SETS } from './slides/themes';
import { ThumbPane } from './slides/Thumbs';

const APP_ID = 'slides';
const MAX_HISTORY = 100;
const PICTURE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];

interface Entry {
  deck: Deck;
  label: string;
  /** The slide it happened on, to go back to on undo. */
  at: number;
  coalesce?: string;
}

interface Hist {
  entries: Entry[];
  index: number;
}

type Clip = { kind: 'shapes'; shapes: Shape[]; pkg: OpcPackage; text: string } | { kind: 'slides'; slides: Slide[]; pkg: OpcPackage; text: string };
/** Slides' clipboard, shared between windows like the system's. */
let clipboard: Clip | null = null;

interface ContextMenuState {
  /** Where, relative to the window's top left. */
  x: number;
  y: number;
  kind: 'slide' | 'shape' | 'canvas';
}

const TABS: RibbonTab[] = [
  { id: 'home', label: 'Home' },
  { id: 'insert', label: 'Insert' },
  { id: 'design', label: 'Design' },
  { id: 'transitions', label: 'Transitions' },
  { id: 'show', label: 'Slide Show' },
  { id: 'view', label: 'View' },
];

const editable = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** A color as the color picker gives it, as DrawingML has it: theme slots stay theme colors. */
function toColor(p: PickedColor): Color {
  if (!p.theme) return { hex: p.hex };
  const scheme = ({ lt1: 'bg1', dk1: 'tx1', lt2: 'bg2', dk2: 'tx2' } as Record<string, string>)[p.theme] ?? p.theme;
  const t = p.tint ?? 0;
  if (!t) return { scheme };
  return t > 0 ? { scheme, mods: [['lumMod', Math.round((1 - t) * 100000)], ['lumOff', Math.round(t * 100000)]] } : { scheme, mods: [['lumMod', Math.round((1 + t) * 100000)]] };
}

const caseFns: Record<CaseKind, (s: string) => string> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  title: (s) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase()),
  sentence: (s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase()),
  toggle: (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
};

/**
 * Slides, Din's PowerPoint: opens and saves .pptx, with PowerPoint 365's
 * Normal view (thumbnails, the slide, notes), Slide Sorter, the slide show,
 * and its ribbon. The deck is immutable data in a snapshot history; the
 * package it came from rides along so saving keeps everything Slides
 * doesn't edit (see slides/write.ts). LibreOffice's .odp opens onto
 * a new package and saves from the deck (see slides/odp.ts).
 */
export function Slides() {
  const din = useDin();
  const params = din.app.launch.params;
  const initialDesign = typeof params?.design === 'string' ? DESIGNS.find((d) => d.id === params.design) : undefined;
  const [initial] = useState(() => newPresentation(initialDesign));
  const [pkg, setPkg] = useState<OpcPackage>(initial.pkg);
  const [hist, setHist] = useState<Hist>({ entries: [{ deck: initial.deck, label: 'New', at: 0 }], index: 0 });
  const deck = hist.entries[hist.index].deck;
  const [cur, setCur] = useState(0);
  const [slideSel, setSlideSel] = useState<Set<string>>(() => new Set());
  const [sel, setSel] = useState<string[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tool, setTool] = useState<InsertTool | null>(null);
  const [tab, setTab] = useState('home');
  const [collapsed, setCollapsed] = useState(false);
  const [backstage, setBackstage] = useState<BackstagePage | null>(null);
  const [view, setView] = useState<'normal' | 'sorter'>('normal');
  const [notesOpen, setNotesOpen] = useState(true);
  const [notesH, setNotesH] = useState(84);
  const [paneW, setPaneW] = useState(206);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(0.6);
  const [show, setShow] = useState<number | null>(null);
  const [focusArea, setFocusArea] = useState<'thumbs' | 'canvas'>('canvas');
  const [dialog, setDialog] = useState<null | 'find' | 'replace' | 'zoom' | 'footer'>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [gridlines, setGridlines] = useState(false);
  const [colors, setColors] = useState({ font: 'C00000', fill: '4472C4', line: '000000' });
  const [painter, setPainter] = useState<Shape | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [frameW, setFrameW] = useState(1400);
  const [, setEdTick] = useState(0);
  const [editorInst, setEditorInst] = useState<Editor | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editSession = useRef(0);

  const slideIndex = Math.min(cur, Math.max(0, deck.slides.length - 1));
  const slide = deck.slides[slideIndex] as Slide | undefined;

  // ---- File ------------------------------------------------------------------------

  const file = useOfficeFile({
    app: 'powerpoint',
    untitled: 'Presentation',
    openExtensions: OPEN_EXTENSIONS,
    saveTypes: SAVE_TYPES,
    onLoad: (bytes, path) => {
      const loaded = loadPresentation(bytes, path);
      setPkg(loaded.pkg);
      setHist({ entries: [{ deck: loaded.deck, label: 'Open', at: 0 }], index: 0 });
      setCur(0);
      setSel([]);
      setEditing(null);
      setSlideSel(new Set(loaded.deck.slides[0] ? [loaded.deck.slides[0].uid] : []));
      setMessage(loaded.lost?.length ? `Some things in this presentation can’t be shown here and won’t be kept when you save: ${loaded.lost.join(', ')}.` : null);
    },
    onSave: (path) => savePresentation(pkg, deckRef.current, path),
  });
  const { setDirty } = file;

  const deckRef = useRef(deck);
  useLayoutEffect(() => {
    deckRef.current = deck;
  });

  // ---- History ---------------------------------------------------------------------

  const push = useCallback(
    (next: Deck, label: string, coalesce?: string, at?: number) => {
      setHist((h) => {
        const entries = h.entries.slice(0, h.index + 1);
        const top = entries[entries.length - 1];
        if (coalesce && top.coalesce === coalesce) {
          entries[entries.length - 1] = { ...top, deck: next };
          return { entries, index: h.index };
        }
        entries.push({ deck: next, label, at: at ?? cur, coalesce });
        while (entries.length > MAX_HISTORY) entries.shift();
        return { entries, index: entries.length - 1 };
      });
      setDirty(true);
    },
    [cur, setDirty],
  );

  const undo = () => {
    if (hist.index === 0) return;
    const at = hist.entries[hist.index].at;
    setHist({ ...hist, index: hist.index - 1 });
    setCur(Math.min(at, hist.entries[hist.index - 1].deck.slides.length - 1));
    setSel([]);
    setEditing(null);
    setDirty(true);
  };
  const redo = () => {
    if (hist.index >= hist.entries.length - 1) return;
    setHist({ ...hist, index: hist.index + 1 });
    setCur(Math.min(hist.entries[hist.index + 1].at, hist.entries[hist.index + 1].deck.slides.length - 1));
    setSel([]);
    setEditing(null);
    setDirty(true);
  };

  const setSlides = useCallback((slides: Slide[], label: string, coalesce?: string) => push({ ...deckRef.current, slides }, label, coalesce), [push]);

  const updateSlide = useCallback(
    (index: number, next: Slide, label: string, coalesce?: string) => {
      const slides = [...deckRef.current.slides];
      slides[index] = next;
      push({ ...deckRef.current, slides }, label, coalesce, index);
    },
    [push],
  );

  // ---- Contexts --------------------------------------------------------------------

  // Contexts hang off the deck's frame (masters, layouts, size), so a
  // change to one slide doesn't redraw every thumbnail.
  const { layouts, masters, defaultText, tableStyles, w: deckW, h: deckH } = deck;
  const frame = useMemo((): Deck => ({ w: deckW, h: deckH, layouts, masters, defaultText, tableStyles, slides: [] }), [layouts, masters, defaultText, tableStyles, deckW, deckH]);
  const ctxFor = useCallback(
    (s: Slide, i: number): SlideCtx | null => {
      const c = slideCtx(frame, s, i, (p) => mediaUrl(pkg, p));
      if (c) c.chart = (part) => readChart(pkg, part);
      return c;
    },
    [frame, pkg],
  );
  const ctx = useMemo(() => (slide ? ctxFor(slide, slideIndex) : null), [slide, slideIndex, ctxFor]);
  const layoutsOfMaster = useMemo((): Layout[] => {
    const m = slide ? masterOf(deck, slide) : Object.values(deck.masters)[0];
    return (m?.layouts ?? []).map((p) => deck.layouts[p]).filter((l): l is Layout => !!l);
  }, [deck, slide]);
  const layoutPreview = useCallback(
    (l: Layout): SlideCtx | null => {
      const c = layoutCtx(deck, l);
      if (!c) return null;
      const placeholders = l.shapes.filter((s) => 'ph' in s && s.ph && !['dt', 'ftr', 'sldNum'].includes(s.ph.type ?? ''));
      return { ...c, slide: { ...c.slide, shapes: placeholders }, media: (p) => mediaUrl(pkg, p) };
    },
    [deck, pkg],
  );

  const selected = useMemo(() => (slide ? slide.shapes.filter((s) => sel.includes(s.uid)) : []), [slide, sel]);
  const single = selected.length === 1 ? selected[0] : undefined;
  const editingShape = editing && slide ? findShape(slide.shapes, editing.uid) : undefined;

  const look = useMemo(() => {
    const s = editingShape ?? single;
    if (!s || !ctx) return null;
    const cell = editing?.cell;
    const chain = s.kind === 'frame' && s.table && cell && s.table.rows[cell[0]]?.cells[cell[1]] ? cellLook(s, cell[0], cell[1], ctx).chain : textChain(s, inheritChain(s, ctx), ctx);
    return { chain, env: textEnv(ctx, chain) };
  }, [editingShape, single, ctx, editing?.cell]);

  // ---- Format state (for the ribbon) ----------------------------------------------

  const ed = editing ? editorInst : null;
  const fmt: FormatState = (() => {
    let run: RunProps = {};
    let para: ParaProps = {};
    let algn = 'l';
    if (ed && look && !ed.isDestroyed) {
      const l = editorLook(ed.state, look);
      run = l.run;
      para = l.para;
      algn = l.algn;
    } else if (single && look) {
      const first = firstRunProps(single);
      if (first) {
        const rp = resolvePara(first.para, look.chain);
        run = resolveRun(first.run, rp);
        para = first.para;
        algn = rp.algn;
      }
    }
    const bulletType = look ? resolvePara(para, look.chain).bullet?.type : undefined;
    const anchorShape = editingShape ?? single;
    return {
      font: (() => {
        const theme = ctx?.theme ?? Object.values(deck.masters)[0].theme;
        const f = run.font ?? '+mn-lt';
        if (f.startsWith('+mj')) return `${theme.majorFont} (Headings)`;
        if (f.startsWith('+mn')) return `${theme.minorFont} (Body)`;
        return fontName(f, theme) ?? 'Calibri';
      })(),
      size: run.sz ? run.sz / 100 : look ? 18 : null,
      b: !!run.b,
      i: !!run.i,
      u: !!run.u && run.u !== 'none',
      strike: !!run.strike && run.strike !== 'noStrike',
      baseline: run.baseline ?? 0,
      algn,
      bullet: bulletType === 'char' ? 'char' : bulletType === 'auto' ? 'auto' : 'none',
      anchor: (anchorShape && look ? look.chain.body.anchor : undefined) ?? 't',
    };
  })();

  // ---- Edits to shapes ------------------------------------------------------------------

  const commitSlide = useCallback(
    (next: Slide, label: string, select?: string[]) => {
      updateSlide(slideIndex, next, label);
      if (select) setSel(select);
    },
    [updateSlide, slideIndex],
  );

  const mapSelected = (fn: (s: Shape) => Shape, label: string, coalesce?: string) => {
    if (!slide) return;
    const uids = editing ? [editing.uid] : sel;
    if (!uids.length) return;
    let shapes = slide.shapes;
    for (const u of uids) shapes = mapShapeDeep(shapes, u, fn);
    updateSlide(slideIndex, { ...slide, shapes }, label, coalesce);
  };

  /** A run change: to the selected text while editing, or to all of each selected shape's text. */
  const fmtRun = (fn: (p: RunProps) => RunProps, label: string) => {
    if (ed && !ed.isDestroyed) {
      applyRun(ed, fn);
      ed.view.focus();
      return;
    }
    mapSelected((s) => shapeText(s, (t) => mapRuns(t, fn)), label);
  };

  const fmtPara = (fn: (p: ParaProps) => ParaProps, label: string) => {
    if (ed && !ed.isDestroyed) {
      applyPara(ed, fn);
      ed.view.focus();
      return;
    }
    mapSelected((s) => shapeText(s, (t) => mapParas(t, fn)), label);
  };

  const onText = useCallback(
    (uid: string, body: TextBody, cell?: [number, number]) => {
      const s = deckRef.current.slides[slideIndex];
      if (!s) return;
      const shapes = mapShapeDeep(s.shapes, uid, (x): Shape => {
        if (x.kind === 'sp') return { ...x, text: body };
        if (x.kind === 'frame' && x.table && cell) {
          const rows = x.table.rows.map((row, r) => (r !== cell[0] ? row : { ...row, cells: row.cells.map((c, ci) => (ci === cell[1] ? { ...c, text: body } : c)) }));
          return { ...x, table: { ...x.table, rows } };
        }
        return x;
      });
      updateSlide(slideIndex, { ...s, shapes }, 'Typing', `text:${uid}:${editSession.current}`);
    },
    [slideIndex, updateSlide],
  );

  const onAutoSize = useCallback(
    (uid: string, xfrm: Xfrm) => {
      const s = deckRef.current.slides[slideIndex];
      if (!s) return;
      updateSlide(slideIndex, { ...s, shapes: s.shapes.map((x) => (x.uid === uid ? withXfrm(x, xfrm) : x)) }, 'Typing', `text:${uid}:${editSession.current}`);
    },
    [slideIndex, updateSlide],
  );

  const onAutoFit = useCallback(
    (uid: string, fontScale: number, lnSpcReduction: number) => {
      const s = deckRef.current.slides[slideIndex];
      if (!s) return;
      const shapes = s.shapes.map((x): Shape => {
        if (x.uid !== uid || x.kind !== 'sp') return x;
        const text = x.text ?? emptyText();
        const body = { ...text.body, autofit: 'norm' as const, fontScale: fontScale < 100000 ? fontScale : undefined, lnSpcReduction: lnSpcReduction || undefined };
        return { ...x, text: { ...text, body } };
      });
      updateSlide(slideIndex, { ...s, shapes }, 'Typing', `text:${uid}:${editSession.current}`);
    },
    [slideIndex, updateSlide],
  );

  const startEditing = useCallback((e: Editing | null) => {
    if (e) editSession.current++;
    setEditing(e);
  }, []);

  const onEditor = useCallback((e: Editor | null) => setEditorInst(e), []);
  const onEditorChange = useCallback(() => setEdTick((t) => t + 1), []);

  /** Selecting a shape; with the Format Painter on, it takes the copied look. */
  const selectShapes = (uids: string[]) => {
    setSel(uids);
    const target = slide && uids.length === 1 ? slide.shapes.find((s) => s.uid === uids[0]) : undefined;
    if (!painter || !slide || !target || target.uid === painter.uid) return;
    const src = painter;
    setPainter(null);
    const shapes = slide.shapes.map((s) => {
      if (s.uid !== target.uid) return s;
      if (s.kind === 'sp' && src.kind === 'sp') {
        const run = firstRunProps(src)?.run ?? {};
        return { ...s, fill: src.fill, line: src.line, style: src.style, text: s.text ? mapRuns(s.text, (p) => ({ ...run, attrs: p.attrs })) : s.text };
      }
      if (s.kind === 'pic' && src.kind === 'pic') return { ...s, line: src.line };
      return s;
    });
    updateSlide(slideIndex, { ...slide, shapes }, 'Format Painter');
  };

  // ---- Slides ---------------------------------------------------------------------------

  const goTo = useCallback(
    (i: number) => {
      const s = deckRef.current.slides[i];
      if (!s) return;
      setCur(i);
      setSel([]);
      setEditing(null);
      setSlideSel(new Set([s.uid]));
    },
    [],
  );

  const newSlide = (layoutPart?: string) => {
    const base = slide ? layoutOf(deck, slide) : Object.values(deck.layouts)[0];
    // PowerPoint follows a title slide with Title and Content, and repeats any other layout.
    let layout = layoutPart ? deck.layouts[layoutPart] : base;
    if (!layoutPart && base?.type === 'title') layout = layoutsOfMaster.find((l) => l.type === 'obj') ?? base;
    if (!layout) return;
    const s = slideFromLayout(layout);
    const slides = [...deck.slides];
    const at = deck.slides.length ? slideIndex + 1 : 0;
    slides.splice(at, 0, s);
    push({ ...deck, slides }, 'New Slide', undefined, at);
    setCur(at);
    setSel([]);
    setEditing(null);
    setSlideSel(new Set([s.uid]));
  };

  const selectedSlides = (): number[] => {
    const idx = deck.slides.map((s, i) => (slideSel.has(s.uid) ? i : -1)).filter((i) => i >= 0);
    return idx.length ? idx : slide ? [slideIndex] : [];
  };

  const duplicateSlides = () => {
    const idx = selectedSlides();
    if (!idx.length) return;
    const copies = idx.map((i) => {
      const s = deck.slides[i];
      return { ...s, uid: newUid('slide'), part: undefined, shapes: s.shapes.map((x) => cloneShape(x, x.id)), notes: s.notes };
    });
    const slides = [...deck.slides];
    const at = idx[idx.length - 1] + 1;
    slides.splice(at, 0, ...copies);
    push({ ...deck, slides }, 'Duplicate Slide', undefined, at);
    setCur(at);
    setSlideSel(new Set(copies.map((c) => c.uid)));
    setSel([]);
  };

  const deleteSlides = () => {
    const idx = new Set(selectedSlides());
    if (!idx.size) return;
    const slides = deck.slides.filter((_, i) => !idx.has(i));
    push({ ...deck, slides }, 'Delete Slide', undefined, Math.min(...idx));
    const next = Math.min(Math.min(...idx), slides.length - 1);
    setCur(Math.max(0, next));
    setSlideSel(new Set(slides[next] ? [slides[next].uid] : []));
    setSel([]);
    setEditing(null);
  };

  const moveSlides = (uids: string[], to: number) => {
    const moving = deck.slides.filter((s) => uids.includes(s.uid));
    const before = deck.slides.slice(0, to).filter((s) => !uids.includes(s.uid));
    const after = deck.slides.slice(to).filter((s) => !uids.includes(s.uid));
    const slides = [...before, ...moving, ...after];
    if (slides.every((s, i) => s === deck.slides[i])) return;
    push({ ...deck, slides }, 'Move Slide', undefined, before.length);
    setCur(before.length);
    setSlideSel(new Set(uids));
  };

  const pickSlide = (i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const s = deck.slides[i];
    if (!s) return;
    if (e.shiftKey) {
      const [a, b] = [Math.min(i, slideIndex), Math.max(i, slideIndex)];
      setSlideSel(new Set(deck.slides.slice(a, b + 1).map((x) => x.uid)));
      setCur(i);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(slideSel);
      if (next.has(s.uid) && next.size > 1) next.delete(s.uid);
      else next.add(s.uid);
      setSlideSel(next);
      setCur(i);
    } else {
      setSlideSel(new Set([s.uid]));
      setCur(i);
    }
    setSel([]);
    setEditing(null);
  };

  const setLayout = (part: string) => {
    const idx = selectedSlides();
    const slides = deck.slides.map((s, i) => (idx.includes(i) ? changeLayout(deck, s, part) : s));
    setSlides(slides, 'Layout');
    setSel([]);
    setEditing(null);
  };

  const resetSlide = () => {
    const idx = selectedSlides();
    const slides = deck.slides.map((s, i) => {
      if (!idx.includes(i)) return s;
      return {
        ...s,
        bg: undefined,
        shapes: s.shapes.map((x) => {
          if (!('ph' in x) || !x.ph || x.kind !== 'sp') return x;
          const reset: Shape = { ...x, xfrm: undefined, geom: undefined, fill: undefined, line: undefined, style: undefined };
          return x.text ? { ...reset, text: { ...mapRuns(mapParas(x.text, (p) => (p.lvl ? { lvl: p.lvl } : {})), () => ({})), body: {} } } : reset;
        }),
      };
    });
    setSlides(slides, 'Reset Slide');
  };

  const toggleHidden = () => {
    const idx = selectedSlides();
    const hide = !deck.slides[idx[0]]?.hidden;
    setSlides(deck.slides.map((s, i) => (idx.includes(i) ? { ...s, hidden: hide || undefined } : s)), hide ? 'Hide Slide' : 'Unhide Slide');
  };

  // ---- Shapes ---------------------------------------------------------------------------

  const deleteShapes = () => {
    if (!slide || !sel.length) return;
    // Deleting a filled placeholder empties it first, as PowerPoint does.
    const uids = new Set(sel);
    const shapes = slide.shapes.flatMap((s): Shape[] => {
      if (!uids.has(s.uid)) return [s];
      if (s.kind === 'sp' && s.ph && hasText(s.text)) return [{ ...s, text: emptyText() }];
      return [];
    });
    commitSlide({ ...slide, shapes }, 'Delete', []);
  };

  const duplicateShapes = () => {
    if (!slide || !sel.length) return;
    let id = nextId(slide);
    const copies = selected.map((s) => {
      const c = cloneShape(s, id++);
      const b = boxOf(deck, slide, s);
      return b ? withXfrm(c, { ...b, x: b.x + 91440 * 2, y: b.y + 91440 * 2 }) : c;
    });
    commitSlide({ ...slide, shapes: [...slide.shapes, ...copies] }, 'Duplicate', copies.map((c) => c.uid));
  };

  const shapesText = (shapes: Shape[]) => {
    const parts: string[] = [];
    for (const s of shapes) walkShapes([s], (x) => {
      if (x.kind === 'sp' && x.text && hasText(x.text)) parts.push(plainText(x.text.paras));
    });
    return parts.join('\n');
  };

  const copyShapes = (cut: boolean): string | null => {
    if (!slide || !selected.length) return null;
    const boxed = selected.map((s) => {
      const b = boxOf(deck, slide, s);
      return b && !s.xfrm ? withXfrm(s, b) : s;
    });
    const text = shapesText(selected) || ' ';
    clipboard = { kind: 'shapes', shapes: boxed, pkg, text };
    if (cut) deleteShapes();
    return text;
  };

  const copySlides = (cut: boolean): string | null => {
    const idx = selectedSlides();
    if (!idx.length) return null;
    const slides = idx.map((i) => deck.slides[i]);
    const text = slides.map((s) => shapesText(s.shapes)).join('\n') || ' ';
    clipboard = { kind: 'slides', slides, pkg, text };
    if (cut) deleteSlides();
    return text;
  };

  /** Bring shapes from another presentation: their pictures come along; charts and the like can't. */
  const adopt = (shapes: Shape[], from: OpcPackage): Shape[] => {
    if (from === pkg) return shapes;
    const done = new Map<string, string>();
    const fix = (s: Shape): Shape | null => {
      if (s.kind === 'pic') return { ...s, media: copyMedia(from, pkg, s.media, done) };
      if (s.kind === 'grp') return { ...s, children: s.children.map(fix).filter((c): c is Shape => !!c) };
      if (s.kind === 'raw' || (s.kind === 'frame' && s.xml)) return null;
      if (s.kind === 'sp' && s.fill?.type === 'blip') return { ...s, fill: { type: 'blip', media: copyMedia(from, pkg, s.fill.media, done) } };
      return s;
    };
    return shapes.map(fix).filter((s): s is Shape => !!s);
  };

  const pasteInternal = () => {
    const c = clipboard;
    if (!c) return;
    if (c.kind === 'slides') {
      const fallbackLayout = slide?.layout ?? Object.keys(deck.layouts)[0];
      const copies = c.slides.map((s) => ({
        ...s,
        uid: newUid('slide'),
        part: undefined,
        layout: c.pkg === pkg && deck.layouts[s.layout] ? s.layout : fallbackLayout,
        shapes: adopt(s.shapes.map((x) => cloneShape(x, x.id)), c.pkg),
      }));
      const slides = [...deck.slides];
      const at = deck.slides.length ? slideIndex + 1 : 0;
      slides.splice(at, 0, ...copies);
      push({ ...deck, slides }, 'Paste', undefined, at);
      setCur(at);
      setSlideSel(new Set(copies.map((s) => s.uid)));
      return;
    }
    if (!slide) return;
    let id = nextId(slide);
    const sameSlide = c.shapes.every((s) => slide.shapes.some((x) => x.uid === s.uid));
    const copies = adopt(c.shapes, c.pkg).map((s) => {
      const copy = cloneShape(s, id++);
      if (sameSlide && copy.xfrm) return withXfrm(copy, { ...copy.xfrm, x: copy.xfrm.x + 182880, y: copy.xfrm.y + 182880 });
      return copy;
    });
    commitSlide({ ...slide, shapes: [...slide.shapes, ...copies] }, 'Paste', copies.map((s) => s.uid));
  };

  const insertPictureBytes = async (data: Uint8Array, ext: string, name: string, into?: string) => {
    if (!slide) return;
    const media = pkg.addMedia('ppt/media', data, ext);
    const url = mediaUrl(pkg, media);
    const size = url ? await imageSize(url) : { width: 400, height: 300 };
    const maxW = deck.w * 0.8;
    const maxH = deck.h * 0.8;
    let w = size.width / PX;
    let h = size.height / PX;
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
    const s = deckRef.current.slides[slideIndex];
    const id = nextId(s);
    // A selected empty picture placeholder takes the picture.
    const target = s.shapes.find((x) => (into ? x.uid === into : sel.includes(x.uid)) && x.kind === 'sp' && x.ph && (x.ph.type === 'pic' || x.ph.type === undefined || x.ph.type === 'obj') && !hasText(x.text));
    if (target) {
      const box = boxOf(deck, s, target);
      if (box) {
        const kk = Math.min(box.w / w, box.h / h);
        const pic = { ...newPicture(target.id, media, { x: box.x + (box.w - w * kk) / 2, y: box.y + (box.h - h * kk) / 2, w: w * kk, h: h * kk }, name), ph: 'ph' in target ? target.ph : undefined };
        commitSlide({ ...s, shapes: s.shapes.map((x) => (x === target ? pic : x)) }, 'Insert Picture', [pic.uid]);
        return;
      }
    }
    const pic = newPicture(id, media, { x: (deck.w - w) / 2, y: (deck.h - h) / 2, w, h }, name);
    commitSlide({ ...s, shapes: [...s.shapes, pic] }, 'Insert Picture', [pic.uid]);
    setTab('pictureFormat');
  };

  const insertPicture = async () => {
    try {
      const picked = await file.pickInsert('Insert Picture', PICTURE_TYPES);
      if (!picked) return;
      await insertPictureBytes(picked.bytes, extOfPath(picked.name) || 'png', picked.name);
    } catch {
      setMessage('That picture couldn’t be inserted.');
    }
  };

  /** The icons in an empty content placeholder: a picture or a table takes its place. */
  const placeholderAction = (uid: string, kind: string) => {
    if (!slide) return;
    const target = slide.shapes.find((s) => s.uid === uid);
    if (!target) return;
    setSel([uid]);
    if (kind === 'picture') {
      void (async () => {
        const picked = await file.pickInsert('Insert Picture', PICTURE_TYPES).catch(() => null);
        if (!picked) return;
        await insertPictureBytes(picked.bytes, extOfPath(picked.name) || 'png', picked.name, uid);
      })();
      return;
    }
    const box = boxOf(deck, slide, target);
    if (!box) return;
    const t = newTable(target.id, 3, 3, { ...box }, DEFAULT_TABLE_STYLE);
    const frame = { ...t, ph: 'ph' in target ? target.ph : undefined } as Shape;
    commitSlide({ ...slide, shapes: slide.shapes.map((s) => (s.uid === uid ? frame : s)) }, 'Insert Table', [frame.uid]);
  };

  const pasteText = (text: string) => {
    if (!slide) return;
    const id = nextId(slide);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const box = { x: deck.w * 0.25, y: deck.h * 0.4, w: deck.w * 0.5, h: 369332 * lines.length };
    const shape: Shape = {
      kind: 'sp',
      uid: newUid(),
      id,
      name: `TextBox ${id - 1}`,
      txBox: true,
      xfrm: box,
      geom: { prst: 'rect' },
      fill: { type: 'none' },
      text: { body: { wrap: 'square', autofit: 'shape' }, paras: lines.map((l) => ({ props: {}, runs: l ? [{ kind: 'text' as const, text: l, props: {} }] : [] })) },
    };
    commitSlide({ ...slide, shapes: [...slide.shapes, shape] }, 'Paste', [shape.uid]);
  };

  const doPaste = async () => {
    if (ed && !ed.isDestroyed) {
      try {
        const text = await navigator.clipboard.readText();
        ed.commands.insertContent(text);
      } catch {
        /* the editor's own paste (Ctrl+V) still works */
      }
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith('image/'));
        if (img) {
          const blob = await it.getType(img);
          await insertPictureBytes(new Uint8Array(await blob.arrayBuffer()), img.split('/')[1] ?? 'png', 'Picture');
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (clipboard && text === clipboard.text) pasteInternal();
      else if (text.trim()) pasteText(text);
      else pasteInternal();
    } catch {
      pasteInternal();
    }
  };

  const groupSel = () => {
    if (!slide) return;
    const r = groupShapes(deck, slide, new Set(sel));
    if (r) commitSlide(r.slide, 'Group', [r.group.uid]);
  };
  const ungroupSel = () => {
    if (!slide) return;
    let s = slide;
    const out: string[] = [];
    for (const g of selected) {
      if (g.kind !== 'grp') continue;
      const cur = s.shapes.find((x) => x.uid === g.uid);
      if (!cur || cur.kind !== 'grp') continue;
      const r = ungroupShape(s, cur);
      s = r.slide;
      out.push(...r.children.map((c) => c.uid));
    }
    if (out.length) commitSlide(s, 'Ungroup', out);
  };

  const nudge = (dx: number, dy: number) => {
    if (!slide || !sel.length) return;
    const shapes = slide.shapes.map((s) => {
      if (!sel.includes(s.uid)) return s;
      const b = boxOf(deck, slide, s);
      return b ? withXfrm(s, { ...b, x: b.x + dx, y: b.y + dy }) : s;
    });
    updateSlide(slideIndex, { ...slide, shapes }, 'Nudge', `nudge:${sel.join(',')}`);
  };

  // ---- Find and replace ---------------------------------------------------------------

  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const findPos = useRef<{ slide: number; shape: number; offset: number }>({ slide: 0, shape: -1, offset: 0 });

  const findNext = (): boolean => {
    if (!findText) return false;
    const needle = matchCase ? findText : findText.toLowerCase();
    const n = deck.slides.length;
    const start = findPos.current;
    for (let k = 0; k <= n; k++) {
      const si = (start.slide + k) % n;
      const s = deck.slides[si];
      for (let j = k === 0 ? Math.max(0, start.shape) : 0; j < s.shapes.length; j++) {
        const shape = s.shapes[j];
        if (shape.kind !== 'sp' || !shape.text) continue;
        const text = plainText(shape.text.paras);
        const hay = matchCase ? text : text.toLowerCase();
        const from = k === 0 && j === start.shape ? start.offset : 0;
        const at = hay.indexOf(needle, from);
        if (at >= 0) {
          findPos.current = { slide: si, shape: j, offset: at + needle.length };
          setCur(si);
          setSlideSel(new Set([s.uid]));
          setSel([shape.uid]);
          setEditing(null);
          requestAnimationFrame(() => startEditing({ uid: shape.uid, start: { range: { from: at, to: at + needle.length } } }));
          return true;
        }
      }
    }
    setMessage(`We couldn’t find what you were looking for: “${findText}”.`);
    return false;
  };

  const replaceAll = () => {
    if (!findText) return;
    let count = 0;
    const flags = matchCase ? 'g' : 'gi';
    const re = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const fix = (t: TextBody): TextBody => ({
      ...t,
      paras: t.paras.map((p) => ({
        ...p,
        runs: p.runs.map((r) => {
          if (r.kind !== 'text') return r;
          const next = r.text.replace(re, () => {
            count++;
            return replaceText;
          });
          return next === r.text ? r : { ...r, text: next };
        }),
      })),
    });
    const slides = deck.slides.map((s) => ({ ...s, shapes: s.shapes.map((x) => shapeText(x, fix)) }));
    setEditing(null);
    if (count) setSlides(slides, 'Replace All');
    setMessage(count ? `All done. We made ${count} replacement${count === 1 ? '' : 's'}.` : `We couldn’t find what you were looking for: “${findText}”.`);
  };

  const replaceOne = () => {
    if (ed && !ed.isDestroyed) {
      const sel = selectedText(ed);
      if (matchCase ? sel === findText : sel.toLowerCase() === findText.toLowerCase()) {
        ed.commands.insertContent(replaceText);
        findPos.current = { ...findPos.current, offset: findPos.current.offset - findText.length + replaceText.length };
      }
    }
    setTimeout(findNext, 0);
  };

  // ---- Design ----------------------------------------------------------------------

  const mapMasters = (fn: (m: Deck['masters'][string]) => Deck['masters'][string], label: string) => {
    push({ ...deck, masters: Object.fromEntries(Object.entries(deck.masters).map(([k, m]) => [k, fn(m)])) }, label);
  };

  const applyDesign = (d: DesignTheme) => {
    mapMasters(
      (m) => ({
        ...m,
        theme: { ...m.theme, name: d.name, colors: { ...d.colors }, majorFont: d.major, minorFont: d.minor },
        themeDirty: true,
        clrMap: d.dark ? { ...m.clrMap, bg1: 'dk1', tx1: 'lt1', bg2: 'dk2', tx2: 'lt2' } : { ...m.clrMap, bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' },
        bg: d.id === 'office' ? { ref: { idx: 1001, color: { scheme: 'bg1' } } } : d.dark ? { fill: { type: 'grad', angle: 90, stops: [{ pos: 0, color: { scheme: 'bg2' } }, { pos: 1, color: { scheme: 'bg1' } }] } } : { fill: { type: 'solid', color: { scheme: 'bg2' } } },
        bgDirty: true,
      }),
      `Apply ${d.name}`,
    );
  };

  // ---- Commands --------------------------------------------------------------------

  const quickStyle = (n: number, kind: 'fill' | 'outline' | 'subtle' | 'intense') => {
    const accent = `accent${n}`;
    mapSelected((s) => {
      if (s.kind !== 'sp') return s;
      const base: Shape = { ...s, fill: undefined, line: undefined };
      if (kind === 'fill') return { ...base, style: { ln: { idx: 2, color: { scheme: accent, mods: [['shade', 50000]] } }, fill: { idx: 1, color: { scheme: accent } }, effect: { idx: 0, color: { scheme: accent } }, font: { idx: 'minor', color: { scheme: 'lt1' } } } };
      if (kind === 'outline') return { ...base, style: { ln: { idx: 2, color: { scheme: accent } }, fill: { idx: 1, color: { scheme: 'lt1' } }, effect: { idx: 0, color: { scheme: accent } }, font: { idx: 'minor', color: { scheme: accent } } } };
      if (kind === 'subtle') return { ...base, style: { ln: { idx: 1, color: { scheme: accent } }, fill: { idx: 1, color: { scheme: accent, mods: [['lumMod', 20000], ['lumOff', 80000]] } }, effect: { idx: 0, color: { scheme: accent } }, font: { idx: 'minor', color: { scheme: 'dk1' } } } };
      return { ...base, line: { fill: { type: 'none' } }, style: { ln: { idx: 0, color: { scheme: accent } }, fill: { idx: 1, color: { scheme: accent } }, effect: { idx: 0, color: { scheme: accent } }, font: { idx: 'minor', color: { scheme: 'lt1' } } } };
    }, 'Quick Style');
  };

  const transitionOf = slide?.transition;
  const setTransition = (fn: (t: Slide['transition']) => Slide['transition'], label: string) => {
    if (!slide) return;
    const idx = selectedSlides();
    setSlides(deck.slides.map((s, i) => (idx.includes(i) ? { ...s, transition: fn(s.transition) } : s)), label);
  };

  const cmd: RibbonCommands = {
    paste: () => void doPaste(),
    cut: () => {
      if (ed && !ed.isDestroyed) {
        void navigator.clipboard?.writeText(selectedText(ed)).catch(() => {});
        ed.commands.deleteSelection();
        return;
      }
      const text = focusArea === 'thumbs' ? copySlides(true) : copyShapes(true);
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    },
    copy: () => {
      if (ed && !ed.isDestroyed) {
        void navigator.clipboard?.writeText(selectedText(ed)).catch(() => {});
        return;
      }
      const text = focusArea === 'thumbs' ? copySlides(false) : copyShapes(false);
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    },
    formatPainter: () => setPainter(painter ? null : (single ?? null)),
    newSlide,
    duplicateSlides,
    deleteSlides,
    setLayout,
    resetSlide,
    font: (raw) => {
      const name = raw.replace(/\s+\((Headings|Body)\)$/, '');
      const theme = look?.env.theme;
      const font = /\(Headings\)$/.test(raw) ? '+mj-lt' : /\(Body\)$/.test(raw) ? '+mn-lt' : name;
      fmtRun((p) => ({ ...p, font: theme && font === theme.minorFont ? '+mn-lt' : theme && font === theme.majorFont ? '+mj-lt' : font }), 'Font');
    },
    size: (pt) => fmtRun((p) => ({ ...p, sz: Math.round(pt * 100) }), 'Font Size'),
    grow: (dir) => {
      const base = (fmt.size ?? 18) * 100;
      if (ed && !ed.isDestroyed) fmtRun((p) => growFont(p, dir, base), 'Font Size');
      else {
        const next = Math.round(stepFontSize(fmt.size ?? 18, dir) * 100);
        fmtRun((p) => ({ ...p, sz: p.sz ? Math.round(stepFontSize(p.sz / 100, dir) * 100) : next }), 'Font Size');
      }
    },
    clearFormatting: () => fmtRun((p) => (p.attrs?.lang ? { attrs: { lang: p.attrs.lang } } : {}), 'Clear Formatting'),
    toggle: (k) => {
      const on = !fmt[k];
      fmtRun((p) => ({ ...p, [k]: k === 'u' ? (on ? 'sng' : 'none') : k === 'strike' ? (on ? 'sngStrike' : 'noStrike') : on }), k === 'b' ? 'Bold' : k === 'i' ? 'Italic' : k === 'u' ? 'Underline' : 'Strikethrough');
    },
    baseline: (v) => fmtRun((p) => ({ ...p, baseline: v || undefined }), v < 0 ? 'Subscript' : 'Superscript'),
    fontColor: (c) => {
      if (c) setColors((x) => ({ ...x, font: c.hex }));
      fmtRun((p) => ({ ...p, color: c ? toColor(c) : undefined }), 'Font Color');
    },
    changeCase: (k) => {
      if (ed && !ed.isDestroyed) {
        changeCaseIn(ed, caseFns[k]);
        return;
      }
      mapSelected((s) => shapeText(s, (t) => ({ ...t, paras: t.paras.map((p) => ({ ...p, runs: p.runs.map((r) => (r.kind === 'text' ? { ...r, text: caseFns[k](r.text) } : r)) })) })), 'Change Case');
    },
    spacing: (spc) => fmtRun((p) => ({ ...p, spc: spc || undefined }), 'Character Spacing'),
    bullets: (b) => fmtPara((p) => ({ ...p, bullet: b ? { type: 'char', char: b.char } : { type: 'none' }, buFont: b?.font, buFontTx: undefined, ...(b ? {} : { marL: 0, indent: 0 }) }), 'Bullets'),
    numbering: (scheme) => fmtPara((p) => ({ ...p, bullet: scheme ? { type: 'auto', scheme } : { type: 'none' }, buFont: scheme ? '+mj-lt' : undefined, ...(scheme ? {} : { marL: 0, indent: 0 }) }), 'Numbering'),
    level: (dir) =>
      fmtPara((p) => {
        const lvl = Math.max(0, Math.min(8, (p.lvl ?? 0) + dir));
        const next = { ...p, lvl: lvl || undefined };
        delete next.marL;
        delete next.indent;
        return next;
      }, dir > 0 ? 'Increase List Level' : 'Decrease List Level'),
    lineSpacing: (v) => fmtPara((p) => ({ ...p, lnSpc: { pct: v } }), 'Line Spacing'),
    align: (a) => fmtPara((p) => ({ ...p, algn: a }), 'Align'),
    anchor: (a) => mapSelected((s) => (s.kind === 'sp' ? { ...s, text: { ...(s.text ?? emptyText()), body: { ...(s.text?.body ?? {}), anchor: a } } } : s), 'Align Text'),
    tool: (prst) => {
      setEditing(null);
      setTool(prst === 'textbox' ? { kind: 'textbox' } : { kind: 'shape', prst });
    },
    textBox: () => {
      setEditing(null);
      setTool({ kind: 'textbox' });
    },
    picture: () => void insertPicture(),
    table: (rows, cols) => {
      if (!slide) return;
      const id = nextId(slide);
      const w = Math.min(deck.w * 0.67, cols * 1.4 * EMU_PER_INCH);
      const t = newTable(id, rows, cols, { x: (deck.w - w) / 2, y: deck.h * 0.25, w, h: 0 }, DEFAULT_TABLE_STYLE);
      commitSlide({ ...slide, shapes: [...slide.shapes, t] }, 'Insert Table', [t.uid]);
    },
    headerFooter: () => setDialog('footer'),
    slideNumber: () => {
      if (ed && !ed.isDestroyed) {
        ed.commands.insertContent({ type: 'field', attrs: { type: 'slidenum', id: '{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', text: String(slideIndex + 1), props: {} } });
        return;
      }
      if (!slide) return;
      const id = nextId(slide);
      const s: Shape = {
        kind: 'sp', uid: newUid(), id, name: `Slide Number ${id - 1}`, txBox: true, xfrm: { x: deck.w - 2743200 - 457200, y: deck.h - 640080, w: 2743200, h: 369332 }, geom: { prst: 'rect' }, fill: { type: 'none' },
        text: { body: { wrap: 'square' }, paras: [{ props: { algn: 'r' }, runs: [{ kind: 'field', type: 'slidenum', id: '{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', text: String(slideIndex + 1), props: { sz: 1200 } }] }] },
      };
      commitSlide({ ...slide, shapes: [...slide.shapes, s] }, 'Slide Number', [s.uid]);
    },
    dateTime: () => {
      const text = new Date().toLocaleDateString('en-US');
      if (ed && !ed.isDestroyed) {
        ed.commands.insertContent(text);
        return;
      }
      pasteText(text);
    },
    order: (o) => slide && commitSlide(reorder(slide, new Set(sel), o), o === 'front' ? 'Bring to Front' : o === 'back' ? 'Send to Back' : o === 'forward' ? 'Bring Forward' : 'Send Backward'),
    alignShapes: (a) => slide && commitSlide(alignShapes(deck, slide, new Set(sel), a, sel.length === 1), 'Align'),
    group: groupSel,
    ungroup: ungroupSel,
    rotate: (k) =>
      slide &&
      commitSlide(
        {
          ...slide,
          shapes: slide.shapes.map((s) => {
            if (!sel.includes(s.uid)) return s;
            const b = boxOf(deck, slide, s);
            if (!b) return s;
            if (k === 'flipH') return withXfrm(s, { ...b, flipH: !b.flipH || undefined });
            if (k === 'flipV') return withXfrm(s, { ...b, flipV: !b.flipV || undefined });
            const rot = ((((b.rot ?? 0) + (k === 'r90' ? 90 : -90)) % 360) + 360) % 360;
            return withXfrm(s, { ...b, rot: rot || undefined });
          }),
        },
        'Rotate',
      ),
    fill: (c) => {
      if (c) setColors((x) => ({ ...x, fill: c.hex }));
      mapSelected((s) => (s.kind === 'sp' || s.kind === 'pic' || s.kind === 'grp' ? ({ ...s, fill: c ? { type: 'solid', color: toColor(c) } : { type: 'none' } } as Shape) : s), 'Shape Fill');
    },
    outline: (c) => {
      if (c) setColors((x) => ({ ...x, line: c.hex }));
      mapSelected((s) => (s.kind === 'sp' || s.kind === 'pic' ? ({ ...s, line: { ...s.line, fill: c ? { type: 'solid', color: toColor(c) } : { type: 'none' } } } as Shape) : s), 'Shape Outline');
    },
    outlineWeight: (w) => mapSelected((s) => (s.kind === 'sp' || s.kind === 'pic' ? ({ ...s, line: { ...s.line, w, ...(s.line?.fill?.type === 'none' ? { fill: { type: 'solid', color: { hex: colors.line } } } : {}) } } as Shape) : s), 'Outline Weight'),
    outlineDash: (d) => mapSelected((s) => (s.kind === 'sp' || s.kind === 'pic' ? ({ ...s, line: { ...s.line, dash: d } } as Shape) : s), 'Outline Dashes'),
    arrows: (k) =>
      mapSelected(
        (s) => (s.kind === 'sp' ? { ...s, line: { ...s.line, head: k === 'start' || k === 'both' ? { type: 'triangle' } : undefined, tail: k === 'end' || k === 'both' ? { type: 'triangle' } : undefined } } : s),
        'Arrows',
      ),
    quickStyle,
    find: () => setDialog('find'),
    replace: () => setDialog('replace'),
    selectAll: () => slide && setSel(slide.shapes.map((s) => s.uid)),
    design: applyDesign,
    colors: (name) => {
      const set = COLOR_SETS.find((c) => c.name === name);
      if (set) mapMasters((m) => ({ ...m, theme: { ...m.theme, colors: { ...set.colors } }, themeDirty: true }), 'Theme Colors');
    },
    fonts: (major, minor) => mapMasters((m) => ({ ...m, theme: { ...m.theme, majorFont: major, minorFont: minor }, themeDirty: true }), 'Theme Fonts'),
    slideSize: (wide) => {
      const size = wide ? SIZE_16_9 : SIZE_4_3;
      if (size.w === deck.w && size.h === deck.h) return;
      push(resizeDeck(deck, size.w, size.h), 'Slide Size');
    },
    background: (c) => {
      const idx = selectedSlides();
      setSlides(deck.slides.map((s, i) => (idx.includes(i) ? { ...s, bg: c ? { fill: { type: 'solid', color: toColor(c) } } : undefined } : s)), 'Format Background');
    },
    backgroundPicture: () =>
      void (async () => {
        const picked = await file.pickInsert('Insert Picture', PICTURE_TYPES).catch(() => null);
        if (!picked) return;
        const media = pkg.addMedia('ppt/media', picked.bytes, extOfPath(picked.name) || 'png');
        const idx = selectedSlides();
        setSlides(deck.slides.map((s, i) => (idx.includes(i) ? { ...s, bg: { fill: { type: 'blip', media } } } : s)), 'Format Background');
      })(),
    backgroundAll: () => {
      const bg = slide?.bg;
      setSlides(deck.slides.map((s) => ({ ...s, bg })), 'Apply Background to All');
    },
    transition: (type, dir) => setTransition((t) => (type === 'none' ? undefined : { ...t, type, dur: t?.dur ?? (type === 'fade' ? 700 : 1000), dir: dir ?? (type === 'push' || type === 'wipe' || type === 'cover' ? (t?.dir ?? 'l') : undefined), raw: undefined }), 'Transition'),
    transitionDuration: (ms) => setTransition((t) => (t ? { ...t, dur: ms, raw: undefined } : t), 'Duration'),
    transitionAll: () => setSlides(deck.slides.map((s) => ({ ...s, transition: transitionOf })), 'Apply To All'),
    advance: (onClick, after) => setTransition((t) => ({ ...(t ?? { type: 'none' }), advClick: onClick ? undefined : false, advTm: after ?? undefined, raw: undefined }), 'Advance Slide'),
    preview: () => setShow(slideIndex),
    show: (fromCurrent) => setShow(fromCurrent ? slideIndex : 0),
    hideSlide: toggleHidden,
    view: (v) => {
      setView(v);
      setEditing(null);
    },
    notes: () => setNotesOpen((o) => !o),
    gridlines: () => setGridlines((g) => !g),
    zoom: () => setDialog('zoom'),
    fit: () => setZoom(null),
    boxSize: (dim, emu) =>
      mapSelected((s) => {
        const b = slide ? boxOf(deck, slide, s) : undefined;
        if (!b || emu <= 0) return s;
        const pic = s.kind === 'pic';
        const k = dim === 'w' ? emu / b.w : emu / b.h;
        const nb = dim === 'w' ? { ...b, w: emu, ...(pic ? { h: b.h * k } : {}) } : { ...b, h: emu, ...(pic ? { w: b.w * k } : {}) };
        return withXfrm(s, nb);
      }, 'Size'),
    resetPicture: () => mapSelected((s) => (s.kind === 'pic' ? { ...s, crop: undefined, line: undefined, fill: undefined, spRaw: undefined, blipRaw: undefined } : s), 'Reset Picture'),
  };

  // ---- Keyboard ----------------------------------------------------------------------

  const editorKeys = useMemo((): Record<string, (e: Editor) => boolean> => {
    const run = (fn: (p: RunProps) => RunProps) => (e: Editor) => {
      applyRun(e, fn);
      return true;
    };
    const para = (fn: (p: ParaProps) => ParaProps) => (e: Editor) => {
      applyPara(e, fn);
      return true;
    };
    const toggleRun = (k: 'b' | 'i' | 'u') => (e: Editor) => {
      const props = look ? editorLook(e.state, look).run : {};
      const on = k === 'u' ? !(props.u && props.u !== 'none') : !props[k];
      applyRun(e, (p) => ({ ...p, [k]: k === 'u' ? (on ? 'sng' : 'none') : on }));
      return true;
    };
    const grow = (dir: 1 | -1) => (e: Editor) => {
      const base = (look ? (editorLook(e.state, look).run.sz ?? 1800) : 1800);
      applyRun(e, (p) => growFont(p, dir, base));
      return true;
    };
    return {
      'Mod-b': toggleRun('b'),
      'Mod-i': toggleRun('i'),
      'Mod-u': toggleRun('u'),
      'Mod-e': para((p) => ({ ...p, algn: 'ctr' })),
      'Mod-l': para((p) => ({ ...p, algn: 'l' })),
      'Mod-r': para((p) => ({ ...p, algn: 'r' })),
      'Mod-j': para((p) => ({ ...p, algn: 'just' })),
      'Mod->': grow(1),
      'Mod-Shift->': grow(1),
      'Mod-]': grow(1),
      'Mod-<': grow(-1),
      'Mod-Shift-<': grow(-1),
      'Mod-[': grow(-1),
      'Mod-=': run((p) => ({ ...p, baseline: p.baseline && p.baseline < 0 ? undefined : -25000 })),
      'Mod-Shift-+': run((p) => ({ ...p, baseline: p.baseline && p.baseline > 0 ? undefined : 30000 })),
      'Mod-Space': run((p) => (p.attrs?.lang ? { attrs: { lang: p.attrs.lang } } : {})),
    };
  }, [look]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || show !== null || backstage || dialog) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Shortcuts that work everywhere, even while typing.
    if (mod && k.toLowerCase() === 's') {
      handled();
      if (e.shiftKey) void file.saveAs();
      else void file.save();
      return;
    }
    if (k === 'F12') {
      handled();
      void file.saveAs();
      return;
    }
    if (k === 'F5') {
      handled();
      setEditing(null);
      setShow(e.shiftKey ? slideIndex : 0);
      return;
    }
    if (mod && k === 'F1') {
      handled();
      setCollapsed((c) => !c);
      return;
    }
    if (mod && (k === 'f' || k === 'h')) {
      handled();
      setDialog(k === 'f' ? 'find' : 'replace');
      return;
    }
    if (editing) {
      if (k === 'Escape') {
        handled();
        setEditing(null);
      }
      return;
    }
    if (editable(e.target)) return;
    if (mod && k.toLowerCase() === 'z' && !e.shiftKey) {
      handled();
      undo();
      return;
    }
    if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) {
      handled();
      redo();
      return;
    }
    if (mod && k.toLowerCase() === 'm') {
      handled();
      newSlide();
      return;
    }
    if (mod && k.toLowerCase() === 'o') {
      handled();
      setBackstage('open');
      return;
    }
    if (mod && k.toLowerCase() === 'n') {
      handled();
      file.newWindow();
      return;
    }
    if (k === 'Escape') {
      handled();
      if (tool) setTool(null);
      else if (painter) setPainter(null);
      else setSel([]);
      return;
    }
    if (focusArea === 'thumbs' || view === 'sorter') {
      if (k === 'Delete' || k === 'Backspace') {
        handled();
        deleteSlides();
      } else if (mod && k.toLowerCase() === 'd') {
        handled();
        duplicateSlides();
      } else if (mod && k.toLowerCase() === 'a') {
        handled();
        setSlideSel(new Set(deck.slides.map((s) => s.uid)));
      } else if (k === 'Enter') {
        handled();
        newSlide();
      } else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') {
        handled();
        if (e.shiftKey && slideIndex > 0) pickSlide(slideIndex - 1, { shiftKey: true, ctrlKey: false, metaKey: false });
        else goTo(Math.max(0, slideIndex - 1));
      } else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') {
        handled();
        if (e.shiftKey && slideIndex < deck.slides.length - 1) pickSlide(slideIndex + 1, { shiftKey: true, ctrlKey: false, metaKey: false });
        else goTo(Math.min(deck.slides.length - 1, slideIndex + 1));
      } else if (k === 'Home') {
        handled();
        goTo(0);
      } else if (k === 'End') {
        handled();
        goTo(deck.slides.length - 1);
      }
      return;
    }
    // The canvas.
    if (k === 'Delete' || k === 'Backspace') {
      handled();
      deleteShapes();
    } else if (mod && k.toLowerCase() === 'd') {
      handled();
      duplicateShapes();
    } else if (mod && k.toLowerCase() === 'a') {
      handled();
      if (slide) setSel(slide.shapes.map((s) => s.uid));
    } else if (mod && k.toLowerCase() === 'g') {
      handled();
      if (e.shiftKey) ungroupSel();
      else groupSel();
    } else if (k.startsWith('Arrow') && sel.length) {
      handled();
      const step = mod ? 9525 : 76200;
      nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
    } else if ((k === 'PageUp' || k === 'ArrowUp' || k === 'ArrowLeft') && !sel.length) {
      handled();
      goTo(Math.max(0, slideIndex - 1));
    } else if ((k === 'PageDown' || k === 'ArrowDown' || k === 'ArrowRight') && !sel.length) {
      handled();
      goTo(Math.min(deck.slides.length - 1, slideIndex + 1));
    } else if (k === 'Tab' && slide?.shapes.length) {
      handled();
      const i = single ? slide.shapes.findIndex((s) => s.uid === single.uid) : -1;
      const n = slide.shapes.length;
      setSel([slide.shapes[(i + (e.shiftKey ? -1 : 1) + n) % n].uid]);
    } else if ((k === 'Enter' || k === 'F2') && single && textCapable(single)) {
      handled();
      startEditing({ uid: single.uid, start: { selectAll: true } });
    } else if (mod && ['b', 'i', 'u'].includes(k.toLowerCase()) && sel.length) {
      handled();
      cmd.toggle(k.toLowerCase() as 'b' | 'i' | 'u');
    } else if (mod && ['e', 'l', 'r', 'j'].includes(k.toLowerCase()) && sel.length) {
      handled();
      cmd.align({ e: 'ctr', l: 'l', r: 'r', j: 'just' }[k.toLowerCase()]!);
    } else if (mod && (k === '>' || k === ']' || k === '<' || k === '[') && sel.length) {
      handled();
      cmd.grow(k === '>' || k === ']' ? 1 : -1);
    } else if (!mod && !e.altKey && k.length === 1 && single && textCapable(single)) {
      // Typing on a selected shape replaces its text.
      handled();
      startEditing({ uid: single.uid, start: { typed: k } });
    }
  };

  const onCopyEvent = (e: React.ClipboardEvent, cut: boolean) => {
    if (editing || editable(e.target)) return;
    const text = focusArea === 'thumbs' || view === 'sorter' ? copySlides(cut) : copyShapes(cut);
    if (text === null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
  };

  const onPasteEvent = (e: React.ClipboardEvent) => {
    if (editing || editable(e.target)) return;
    e.preventDefault();
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files[0]) {
      const f = files[0];
      void f.arrayBuffer().then((buf) => insertPictureBytes(new Uint8Array(buf), f.type.split('/')[1] ?? 'png', f.name || 'Picture'));
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (clipboard && (text === clipboard.text || !text)) pasteInternal();
    else if (text) pasteText(text);
  };

  const openMenu = (at: { x: number; y: number }, kind: ContextMenuState['kind']) => {
    const r = rootRef.current?.getBoundingClientRect();
    setMenu({ x: at.x - (r?.left ?? 0), y: at.y - (r?.top ?? 0), kind });
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFrameW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keys keep coming here when a dialog, the Backstage or the slide show goes.
  useEffect(() => {
    const a = document.activeElement;
    if (!backstage && !dialog && show === null && (!a || a === document.body)) rootRef.current?.focus({ preventScroll: true });
  }, [backstage, dialog, show]);

  // ---- Contextual tabs ---------------------------------------------------------------

  const contextual: RibbonTab[] = [];
  if (single?.kind === 'pic') contextual.push({ id: 'pictureFormat', label: 'Picture Format', contextual: true });
  else if (selected.length && view === 'normal') contextual.push({ id: 'shapeFormat', label: 'Shape Format', contextual: true });
  const tabs = [...TABS, ...contextual];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'home';

  const box = single && slide ? (boxOf(deck, slide, single) ?? null) : null;
  const ribbonState: RibbonState = {
    tab: activeTab,
    theme: ctx?.theme ?? Object.values(deck.masters)[0].theme,
    layouts: layoutsOfMaster,
    layoutCtx: layoutPreview,
    currentLayout: slide?.layout ?? '',
    fmt,
    sel: !selected.length ? 'none' : selected.length > 1 ? 'multi' : single?.kind === 'pic' ? 'picture' : 'shape',
    canGroup: selected.length > 1,
    canUngroup: selected.some((s) => s.kind === 'grp'),
    box,
    hidden: !!slide?.hidden,
    transition: transitionOf,
    view,
    notes: notesOpen,
    gridlines,
    fontColor: colors.font,
    fillColor: colors.fill,
    lineColor: colors.line,
    wide: deck.w / deck.h > 1.5,
    painter: !!painter,
    isLine: single?.kind === 'sp' && !!single.connector,
    width: frameW,
  };

  const effZoom = zoom ?? fitZoom;

  // ---- Backstage ---------------------------------------------------------------------

  const pristine = !file.handle && !file.dirty;
  const templates = useMemo(
    () =>
      DESIGNS.map((d) => {
        const loaded = newPresentation(d);
        const first = loaded.deck.slides[0];
        // Each design previews with its name as the title, as Office's templates do.
        const s = first && d.id !== 'office' ? { ...first, shapes: first.shapes.map((x) => (x.kind === 'sp' && x.ph?.type === 'ctrTitle' ? { ...x, text: { body: {}, paras: [{ props: {}, runs: [{ kind: 'text' as const, text: d.name, props: {} }] }] } } : x)) } : first;
        const c = s ? slideCtx(loaded.deck, s, 0, () => null) : null;
        return { d, c };
      }),
    [],
  );
  const createFrom = (d: DesignTheme) => {
    setBackstage(null);
    if (pristine) {
      const loaded = newPresentation(d);
      setPkg(loaded.pkg);
      setHist({ entries: [{ deck: loaded.deck, label: 'New', at: 0 }], index: 0 });
      setCur(0);
      setSel([]);
    } else void din.app.open(APP_ID, { design: d.id });
  };


  const notes = slide?.notes ?? '';
  const statusSlide = view === 'sorter' ? `Slide Sorter` : `Slide ${slide ? slideIndex + 1 : 0} of ${deck.slides.length}`;

  return (
    <OfficeFrame
      app="powerpoint"
      ref={rootRef}
      tabIndex={-1}
      className="outline-none"
      onKeyDown={onKeyDown}
      onCopy={(e) => onCopyEvent(e, false)}
      onCut={(e) => onCopyEvent(e, true)}
      onPaste={onPasteEvent}
    >
      <style>{SLIDE_CSS}</style>
      <TitleBar
        title={`${file.name} - Slides`}
        status={file.status ?? (file.dirty || file.error ? undefined : file.handle ? 'Saved' : undefined)}
        onSave={() => void file.save()}
        onUndo={undo}
        onRedo={redo}
        canUndo={hist.index > 0 && !editing}
        canRedo={hist.index < hist.entries.length - 1 && !editing}
        search={{ placeholder: 'Search', onSearch: (q) => {
          setFindText(q);
          findPos.current = { slide: slideIndex, shape: -1, offset: 0 };
          setDialog('find');
        } }}
      />
      <RibbonTabs tabs={tabs} active={activeTab} onSelect={setTab} onFile={() => setBackstage('home')} collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} />
      <SlidesRibbon state={ribbonState} cmd={cmd} collapsed={collapsed} />
      {file.error && (
        <div className="mx-1.5 mb-1.5 rounded-md border border-[#f1bbbc] bg-[#fde7e9] px-3 py-2 text-[12.5px] text-[#a4262c]">
          Slides couldn’t open {file.name}. {file.error}
        </div>
      )}
      {message && (
        <div role="status" className="mx-1.5 mb-1.5 flex items-center gap-2 rounded-md border border-[#c7dbf3] bg-[#ebf3fc] px-3 py-1.5 text-[12px] text-[#1d3a5f]">
          <span className="flex-1">{message}</span>
          <button type="button" className="rounded px-2 hover:bg-black/5" onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 bg-[#e6e6e6]">
        {view === 'normal' ? (
          <>
            <div className="flex shrink-0 flex-col bg-[#f3f3f3]" style={{ width: paneW }} onPointerDown={() => setFocusArea('thumbs')}>
              <ThumbPane
                deck={deck}
                current={slideIndex}
                selected={slideSel.size ? slideSel : new Set(slide ? [slide.uid] : [])}
                ctxFor={ctxFor}
                onPick={pickSlide}
                onMove={moveSlides}
                onFocus={() => setFocusArea('thumbs')}
                onContext={(at) => openMenu(at, 'slide')}
                width={paneW}
              />
            </div>
            <Splitter onDrag={(dx) => setPaneW((w) => Math.max(120, Math.min(420, w + dx)))} vertical />
            <div className="flex min-w-0 flex-1 flex-col" onPointerDown={() => setFocusArea('canvas')}>
              {slide && ctx ? (
                <Canvas
                  slide={slide}
                  ctx={ctx}
                  zoom={effZoom}
                  onFit={setFitZoom}
                  onZoom={setZoom}
                  sel={sel}
                  onSelect={selectShapes}
                  editing={editing}
                  onEdit={startEditing}
                  tool={tool}
                  onToolDone={() => setTool(null)}
                  commit={commitSlide}
                  onText={onText}
                  onAutoSize={onAutoSize}
                  onAutoFit={onAutoFit}
                  onEditor={onEditor}
                  onEditorChange={onEditorChange}
                  editorKeys={editorKeys}
                  onContext={(at, onShape) => openMenu(at, onShape ? 'shape' : 'canvas')}
                  gridlines={gridlines}
                  onPlaceholderAction={placeholderAction}
                />
              ) : (
                <button type="button" onClick={() => newSlide()} className="m-auto rounded-md border border-dashed border-[#9e9e9e] px-6 py-4 text-[14px] text-[#616161] hover:bg-white/60">
                  Click to add first slide
                </button>
              )}
              {notesOpen && slide && (
                <>
                  <Splitter onDrag={(_dx, dy) => setNotesH((h) => Math.max(40, Math.min(400, h - dy)))} />
                  <textarea
                    aria-label="Notes"
                    value={notes}
                    onChange={(e) => updateSlide(slideIndex, { ...slide, notes: e.target.value }, 'Notes', `notes:${slide.uid}`)}
                    placeholder="Click to add notes"
                    className="w-full shrink-0 resize-none border-0 border-t border-[#d6d6d6] bg-white px-4 py-2 text-[14px] text-[#242424] outline-none placeholder:text-[#7a7a7a]"
                    style={{ height: notesH, fontFamily: fontStack('Calibri') }}
                  />
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col" onPointerDown={() => setFocusArea('thumbs')}>
            <ThumbPane
              deck={deck}
              current={slideIndex}
              selected={slideSel.size ? slideSel : new Set(slide ? [slide.uid] : [])}
              ctxFor={ctxFor}
              onPick={pickSlide}
              onMove={moveSlides}
              onFocus={() => setFocusArea('thumbs')}
              onContext={(at) => openMenu(at, 'slide')}
              width={Math.round(240 * Math.max(0.5, effZoom / 0.6))}
              grid
              onOpen={(i) => {
                goTo(i);
                setView('normal');
              }}
            />
          </div>
        )}
      </div>
      <StatusBar>
        <StatusText>{statusSlide}</StatusText>
        <StatusText className="hidden md:inline">English (United States)</StatusText>
        <span className="flex-1" />
        <StatusText onClick={() => setNotesOpen((o) => !o)} className={notesOpen ? 'bg-black/10' : undefined} title="Notes">
          <span className="flex items-center gap-1">
            <NotesIcon className="size-3.5" /> Notes
          </span>
        </StatusText>
        <ViewButton label="Normal" active={view === 'normal'} onClick={() => setView('normal')}>
          <NormalViewIcon />
        </ViewButton>
        <ViewButton label="Slide Sorter" active={view === 'sorter'} onClick={() => setView('sorter')}>
          <SorterIcon />
        </ViewButton>
        <ViewButton label="Slide Show" onClick={() => setShow(slideIndex)}>
          <PlayIcon />
        </ViewButton>
        <ZoomSlider zoom={Math.round(effZoom * 100)} onZoom={(z) => setZoom(z / 100)} onDialog={() => setDialog('zoom')} />
        <ViewButton label="Fit slide to current window" active={zoom === null} onClick={() => setZoom(null)}>
          <FitIcon />
        </ViewButton>
      </StatusBar>

      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {menu.kind === 'slide' ? (
            <>
              <MenuItem onSelect={() => cmd.cut()} shortcut="Ctrl+X">Cut</MenuItem>
              <MenuItem onSelect={() => cmd.copy()} shortcut="Ctrl+C">Copy</MenuItem>
              <MenuItem onSelect={() => pasteInternal()} disabled={!clipboard} shortcut="Ctrl+V">Paste</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={() => newSlide()} shortcut="Ctrl+M">New Slide</MenuItem>
              <MenuItem onSelect={duplicateSlides} shortcut="Ctrl+D">Duplicate Slide</MenuItem>
              <MenuItem onSelect={deleteSlides}>Delete Slide</MenuItem>
              <MenuSeparator />
              <SubMenu label="Layout">
                {layoutsOfMaster.map((l) => (
                  <MenuItem key={l.part} checked={slide?.layout === l.part} onSelect={() => setLayout(l.part)}>
                    {l.name}
                  </MenuItem>
                ))}
              </SubMenu>
              <MenuItem onSelect={resetSlide}>Reset Slide</MenuItem>
              <MenuItem onSelect={toggleHidden} checked={!!slide?.hidden}>Hide Slide</MenuItem>
            </>
          ) : menu.kind === 'shape' ? (
            <>
              <MenuItem onSelect={() => cmd.cut()} shortcut="Ctrl+X">Cut</MenuItem>
              <MenuItem onSelect={() => cmd.copy()} shortcut="Ctrl+C">Copy</MenuItem>
              <MenuItem onSelect={() => pasteInternal()} disabled={!clipboard} shortcut="Ctrl+V">Paste</MenuItem>
              <MenuSeparator />
              {single && textCapable(single) && <MenuItem onSelect={() => startEditing({ uid: single.uid, start: { selectAll: true } })}>Edit Text</MenuItem>}
              <SubMenu label="Group">
                <MenuItem disabled={selected.length < 2} onSelect={groupSel} shortcut="Ctrl+G">Group</MenuItem>
                <MenuItem disabled={!ribbonState.canUngroup} onSelect={ungroupSel} shortcut="Ctrl+Shift+G">Ungroup</MenuItem>
              </SubMenu>
              <SubMenu label="Bring to Front">
                <MenuItem onSelect={() => cmd.order('front')}>Bring to Front</MenuItem>
                <MenuItem onSelect={() => cmd.order('forward')}>Bring Forward</MenuItem>
              </SubMenu>
              <SubMenu label="Send to Back">
                <MenuItem onSelect={() => cmd.order('back')}>Send to Back</MenuItem>
                <MenuItem onSelect={() => cmd.order('backward')}>Send Backward</MenuItem>
              </SubMenu>
              <MenuSeparator />
              <MenuItem onSelect={duplicateShapes} shortcut="Ctrl+D">Duplicate</MenuItem>
              <MenuItem onSelect={deleteShapes} shortcut="Delete">Delete</MenuItem>
            </>
          ) : (
            <>
              <MenuItem onSelect={() => pasteInternal()} disabled={!clipboard} shortcut="Ctrl+V">Paste</MenuItem>
              <MenuSeparator />
              <SubMenu label="Layout">
                {layoutsOfMaster.map((l) => (
                  <MenuItem key={l.part} checked={slide?.layout === l.part} onSelect={() => setLayout(l.part)}>
                    {l.name}
                  </MenuItem>
                ))}
              </SubMenu>
              <MenuItem onSelect={resetSlide}>Reset Slide</MenuItem>
              <MenuItem onSelect={() => setGridlines((g) => !g)} checked={gridlines}>Grid and Guides</MenuItem>
              <MenuItem onSelect={() => setTab('design')}>Format Background…</MenuItem>
            </>
          )}
        </ContextMenu>
      )}

      {dialog === 'find' || dialog === 'replace' ? (
        <OfficeDialog
          title={dialog === 'find' ? 'Find' : 'Replace'}
          onCancel={() => setDialog(null)}
          width={420}
          footer={
            <>
              <OfficeButton primary onClick={() => findNext()}>Find Next</OfficeButton>
              {dialog === 'replace' && <OfficeButton onClick={replaceOne}>Replace</OfficeButton>}
              {dialog === 'replace' && <OfficeButton onClick={replaceAll}>Replace All</OfficeButton>}
              {dialog === 'find' && <OfficeButton onClick={() => setDialog('replace')}>Replace…</OfficeButton>}
              <OfficeButton onClick={() => setDialog(null)}>Close</OfficeButton>
            </>
          }
        >
          <div className="space-y-2">
            <Field label="Find what:">
              <input
                autoFocus
                value={findText}
                onChange={(e) => {
                  setFindText(e.target.value);
                  findPos.current = { slide: slideIndex, shape: -1, offset: 0 };
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    findNext();
                  }
                }}
                className={`${FIELD} w-64`}
              />
            </Field>
            {dialog === 'replace' && (
              <Field label="Replace with:">
                <input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} className={`${FIELD} w-64`} />
              </Field>
            )}
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} className="accent-[#c43e1c]" /> Match case
            </label>
          </div>
        </OfficeDialog>
      ) : null}

      {dialog === 'footer' && slide && (
        <HeaderFooterDialog
          initial={footerSettings(slide)}
          onCancel={() => setDialog(null)}
          onApply={(c, all) => {
            const idx = selectedSlides();
            setSlides(deck.slides.map((s, i) => (all || idx.includes(i) ? applyFooter(deck, s, c) : s)), 'Header and Footer');
            setDialog(null);
          }}
        />
      )}

      {dialog === 'zoom' && <ZoomDialog zoom={Math.round(effZoom * 100)} onCancel={() => setDialog(null)} onOk={(z) => { setZoom(z === null ? null : z / 100); setDialog(null); }} />}

      {backstage && (
        <Backstage
          page={backstage}
          onPage={setBackstage}
          onClose={() => setBackstage(null)}
          onSave={() => {
            setBackstage(null);
            void file.save();
          }}
          onCloseDocument={() => {
            setBackstage(null);
            file.requestClose();
          }}
          templates={templates.map(({ d, c }) => ({
            id: d.id,
            name: d.id === 'office' ? 'Blank Presentation' : d.name,
            preview: c ? <SlideImage ctx={c} width={148} /> : <DesignSwatch d={d} />,
            create: () => createFrom(d),
          }))}
          recent={file.recent}
          onOpenRecent={(r) => {
            setBackstage(null);
            void file.openRecent(r);
          }}
          onBrowse={() => {
            setBackstage(null);
            void file.browse();
          }}
          onSaveAs={() => {
            setBackstage(null);
            void file.saveAs();
          }}
          info={
            <div className="max-w-xl space-y-2 text-[13px]">
              <p className="flex items-center gap-2 text-[16px]">
                <FileText className="size-5 text-[var(--office-accent)]" /> {file.name}
              </p>
              <p className="text-[#616161]">{file.handle?.name ?? 'Not saved yet'}</p>
              <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-1.5">
                <dt className="text-[#616161]">Slides</dt>
                <dd>{deck.slides.length}</dd>
                <dt className="text-[#616161]">Hidden slides</dt>
                <dd>{deck.slides.filter((s) => s.hidden).length}</dd>
                <dt className="text-[#616161]">Slide size</dt>
                <dd>
                  {(deck.w / EMU_PER_INCH).toFixed(2)}″ × {(deck.h / EMU_PER_INCH).toFixed(2)}″
                </dd>
                <dt className="text-[#616161]">Theme</dt>
                <dd>{ribbonState.theme.name}</dd>
              </dl>
            </div>
          }
          exports={[
            { label: 'Save as PowerPoint Show', description: 'A .ppsx file opens straight into the slide show.', icon: <FilePlus />, onClick: () => void file.exportCopy(SAVE_PPSX) },
            { label: 'Save as OpenDocument Presentation', description: 'An .odp copy for LibreOffice Impress and other OpenDocument apps.', icon: <FilePlus />, onClick: () => void file.exportCopy(SAVE_ODP) },
            { label: 'Save a copy', description: 'Save the presentation under another name, keeping this one open.', icon: <FolderOpen />, onClick: () => void file.exportCopy(0) },
          ]}
          fileName={file.handle?.name ?? null}
        />
      )}
      {show !== null && (
        <SlideShow
          deck={deck}
          start={Math.min(show, deck.slides.length - 1)}
          ctxFor={ctxFor}
          onExit={(last) => {
            setShow(null);
            if (deck.slides[last]) goTo(last);
            requestAnimationFrame(() => rootRef.current?.focus());
          }}
        />
      )}
      {file.prompt}
      {file.loading && <div className="absolute inset-0 z-30 grid place-items-center bg-white/70 text-[13px] text-[#616161]">Opening…</div>}
    </OfficeFrame>
  );
}

function Splitter({ onDrag, vertical }: { onDrag: (dx: number, dy: number) => void; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={vertical ? 'w-1 shrink-0 cursor-col-resize bg-[#e6e6e6] hover:bg-[#c8c8c8]' : 'h-1 shrink-0 cursor-row-resize bg-[#e6e6e6] hover:bg-[#c8c8c8]'}
      onPointerDown={(e) => {
        e.preventDefault();
        let x = e.clientX;
        let y = e.clientY;
        const move = (ev: PointerEvent) => {
          onDrag(ev.clientX - x, ev.clientY - y);
          x = ev.clientX;
          y = ev.clientY;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function ContextMenu({ menu, onClose, children }: { menu: ContextMenuState; onClose: () => void; children: React.ReactNode }) {
  return (
    <Menu.Root open modal={false} onOpenChange={(o) => !o && onClose()}>
      <Menu.Trigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-px" style={{ left: menu.x, top: menu.y }} />
      </Menu.Trigger>
      <MenuContent onCloseAutoFocus={(e) => e.preventDefault()}>{children}</MenuContent>
    </Menu.Root>
  );
}

function ZoomDialog({ zoom, onCancel, onOk }: { zoom: number; onCancel: () => void; onOk: (z: number | null) => void }) {
  const [choice, setChoice] = useState<string>('custom');
  const [pct, setPct] = useState(zoom);
  const presets: [string, number | null][] = [['Fit', null], ['400%', 400], ['200%', 200], ['100%', 100], ['66%', 66], ['50%', 50], ['33%', 33]];
  return (
    <OfficeDialog title="Zoom" onCancel={onCancel} onOk={() => onOk(choice === 'Fit' ? null : pct)} width={300}>
      <fieldset className="grid grid-cols-2 gap-y-1.5 text-[13px]">
        <legend className="mb-1 text-[12px] text-[#616161]">Zoom to</legend>
        {presets.map(([label, v]) => (
          <label key={label} className="flex items-center gap-2">
            <input
              type="radio"
              name="zoom"
              checked={choice === label}
              onChange={() => {
                setChoice(label);
                if (v) setPct(v);
              }}
              className="accent-[#c43e1c]"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="mt-3 flex items-center gap-2 text-[13px]">
        Percent:
        <input
          type="number"
          min={10}
          max={400}
          value={pct}
          onChange={(e) => {
            setChoice('custom');
            setPct(Math.max(10, Math.min(400, Number(e.target.value) || 100)));
          }}
          className={`${FIELD} w-20`}
        />
      </label>
    </OfficeDialog>
  );
}

