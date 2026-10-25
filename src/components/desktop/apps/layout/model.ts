import { readSwatches, type Swatches } from './colors';
import { apply, boundsOf, IDENTITY, invert, mul, parseMat, pathBounds, rectCorners, transformRect, unionRect, type Mat, type Pt, type Rect, type SubPath } from './geom';
import { all, child, docVersion, kids, num, partRoot, propEl, type Pkg } from './idml';
import { childChain, cleanName, lookup, objectChain, readStyles, type Styles } from './styles';
import { unitFromIdml, type Unit } from './units';

/**
 * What Page Layout draws and edits, read out of an IDML package: spreads and
 * master spreads with their pages, the page items on them (frames, shapes,
 * lines, groups and the graphics placed in frames) with their transforms
 * worked out to spread coordinates, layers, swatches, styles and stories.
 * Each spread's reading is kept per part, so an edit to one spread doesn't
 * reread the others.
 */

export type ItemKind = 'rect' | 'oval' | 'polygon' | 'line' | 'text' | 'group' | 'graphic' | 'other';

export interface TextPrefs {
  columns: number;
  gutter: number;
  fixedWidth: number | null;
  /** Top, left, bottom, right. */
  inset: [number, number, number, number];
  vj: string;
  firstBaseline: string;
  minFirstBaseline: number;
  autoSize: string;
  ignoreWrap: boolean;
}

export interface Wrap {
  mode: string;
  offsets: [number, number, number, number];
  inverse: boolean;
}

export interface Item {
  self: string;
  tag: string;
  kind: ItemKind;
  part: string;
  parent: string | null;
  /** Its own ItemTransform. */
  local: Mat;
  /** Item to spread. */
  m: Mat;
  paths: SubPath[];
  box: Rect;
  fill: string | null;
  fillTint: number;
  stroke: string | null;
  strokeTint: number;
  strokeWeight: number;
  strokeType: string;
  strokeAlign: string;
  gap: string | null;
  join: string;
  cap: string;
  cornerOption: string;
  cornerRadius: number;
  opacity: number;
  blend: string;
  shadow: { color: string | null; opacity: number; x: number; y: number; blur: number } | null;
  gradFill: { start: Pt; length: number; angle: number } | null;
  layer: string;
  visible: boolean;
  locked: boolean;
  name: string;
  contentType: string;
  children: Item[];
  text: { story: string; prev: string | null; next: string | null; prefs: TextPrefs } | null;
  graphic: { kind: string; bounds: Rect; link: string | null; embedded: boolean } | null;
  wrap: Wrap | null;
  fitting: { autoFit: boolean; crop: [number, number, number, number] } | null;
  /** Master item this one overrides on a document page. */
  overrides: string | null;
  nonprinting: boolean;
  /** Anchored in a story's text. */
  anchored?: boolean;
}

export interface Guide {
  self: string;
  vertical: boolean;
  location: number;
  color: string;
  /** Page this guide is on (null: spread-wide). */
  page: string | null;
}

export interface Page {
  self: string;
  name: string;
  spread: string;
  part: string;
  /** GeometricBounds as a rect, in the page's own coordinates. */
  geom: Rect;
  /** Page to spread. */
  m: Mat;
  /** Page bounds in spread coordinates. */
  bounds: Rect;
  master: string | null;
  masterTransform: Mat;
  margins: { top: number; bottom: number; left: number; right: number; columns: number; gutter: number; positions: number[] };
  side: 'left' | 'right' | 'single';
  overrides: Set<string>;
  index: number;
}

export interface Spread {
  self: string;
  part: string;
  isMaster: boolean;
  name: string;
  prefix: string;
  pages: Page[];
  items: Item[];
  m: Mat;
  bounds: Rect;
  /** Where its origin sits on the pasteboard. */
  y: number;
  showMasterItems: boolean;
  guides: Guide[];
}

export interface LayerInfo {
  self: string;
  name: string;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  color: string;
}

export interface Prefs {
  pageW: number;
  pageH: number;
  facing: boolean;
  bleed: { top: number; bottom: number; inside: number; outside: number };
  hUnit: Unit;
  vUnit: Unit;
  domVersion: string;
  pagesPerDocument: number;
  columnGutter: number;
  text: { superSize: number; superPos: number; smallCap: number };
  intent: string;
}

export interface Model {
  pkg: Pkg;
  spreads: Spread[];
  masters: Spread[];
  pages: Page[];
  layers: LayerInfo[];
  swatches: Swatches;
  styles: Styles;
  /** Story Self to its part. */
  stories: Map<string, string>;
  items: Map<string, Item>;
  /** Item Self to the spread it's on. */
  spreadOf: Map<string, Spread>;
  prefs: Prefs;
  /** Text frames of each story, in thread order. */
  threads: Map<string, Item[]>;
  activeLayer: string | null;
}

export const LAYER_COLORS: Record<string, string> = {
  LightBlue: '#4f99ff',
  Red: '#ff0000',
  Green: '#4fff4f',
  Blue: '#0000ff',
  Yellow: '#ffff4f',
  Magenta: '#ff4fff',
  Cyan: '#00ffff',
  Gray: '#808080',
  Black: '#000000',
  Orange: '#ff6600',
  DarkGreen: '#005500',
  Teal: '#009999',
  Tan: '#cc9966',
  Brown: '#993300',
  Violet: '#9966ff',
  Gold: '#ff9900',
  DarkBlue: '#000087',
  Pink: '#ff99cc',
  Lavender: '#9999ff',
  BrickRed: '#990000',
  OliveGreen: '#666600',
  Peach: '#ff9966',
  Burgundy: '#990033',
  GrassGreen: '#99cc00',
  Ochre: '#996600',
  Purple: '#660099',
  LightGray: '#bababa',
};

const ORDER = ['LightBlue', 'Red', 'Green', 'Blue', 'Yellow', 'Magenta', 'Cyan', 'Gray', 'Black', 'Orange', 'DarkGreen', 'Teal', 'Tan', 'Brown', 'Violet', 'Gold'];
export const layerColorName = (i: number) => ORDER[i % ORDER.length];

function layerColor(el: Element, i: number): string {
  const c = propEl(el, 'LayerColor');
  if (!c) return LAYER_COLORS[ORDER[i % ORDER.length]];
  const t = (c.textContent ?? '').trim();
  if (c.getAttribute('type') === 'list') {
    const v = Array.from(c.children).map((x) => num(x.textContent));
    if (v.length === 3) return `rgb(${v.map((x) => Math.round(x)).join(',')})`;
  }
  return LAYER_COLORS[t] ?? LAYER_COLORS[ORDER[i % ORDER.length]];
}

const ITEM_TAGS: Record<string, ItemKind> = {
  Rectangle: 'rect',
  Oval: 'oval',
  Polygon: 'polygon',
  GraphicLine: 'line',
  TextFrame: 'text',
  Group: 'group',
  Image: 'graphic',
  PDF: 'graphic',
  EPS: 'graphic',
  ImportedPage: 'graphic',
  SVG: 'graphic',
  WMF: 'graphic',
  PICT: 'graphic',
  Button: 'other',
  MultiStateObject: 'other',
  FormField: 'other',
  CheckBox: 'other',
  RadioButton: 'other',
  TextBox: 'other',
  ComboBox: 'other',
  ListBox: 'other',
  SignatureField: 'other',
  EPSText: 'other',
};

export const isItemTag = (t: string) => t in ITEM_TAGS;

export function readPaths(el: Element): SubPath[] {
  const pg = propEl(el, 'PathGeometry');
  if (!pg) return [];
  const out: SubPath[] = [];
  for (const gpt of kids(pg, 'GeometryPathType')) {
    const arr = child(gpt, 'PathPointArray');
    const pts = kids(arr, 'PathPointType').map((p) => {
      const a = (p.getAttribute('Anchor') ?? '0 0').split(/\s+/).map(Number);
      const l = (p.getAttribute('LeftDirection') ?? p.getAttribute('Anchor') ?? '0 0').split(/\s+/).map(Number);
      const r = (p.getAttribute('RightDirection') ?? p.getAttribute('Anchor') ?? '0 0').split(/\s+/).map(Number);
      return { anchor: { x: a[0] || 0, y: a[1] || 0 }, left: { x: l[0] || 0, y: l[1] || 0 }, right: { x: r[0] || 0, y: r[1] || 0 } };
    });
    out.push({ points: pts, open: gpt.getAttribute('PathOpen') === 'true' });
  }
  return out;
}

function insets(el: Element | null, d: number): [number, number, number, number] {
  const p = el && propEl(el, 'InsetSpacing');
  if (!p) return [d, d, d, d];
  const v = Array.from(p.children).map((c) => num(c.textContent));
  if (v.length === 4) return [v[0], v[1], v[2], v[3]];
  return [d, d, d, d];
}

function readTextPrefs(chainEls: Element[]): TextPrefs {
  const tf = childChain(chainEls, 'TextFramePreference');
  const insetEl = tf.find((e) => propEl(e, 'InsetSpacing')) ?? null;
  const fixed = lookup(tf, 'UseFixedColumnWidth') === 'true';
  return {
    columns: Math.max(1, Math.round(num(lookup(tf, 'TextColumnCount'), 1))),
    gutter: num(lookup(tf, 'TextColumnGutter'), 12),
    fixedWidth: fixed ? num(lookup(tf, 'TextColumnFixedWidth'), 0) || null : null,
    inset: insets(insetEl, 0),
    vj: lookup(tf, 'VerticalJustification') ?? 'TopAlign',
    firstBaseline: lookup(tf, 'FirstBaselineOffset') ?? 'AscentOffset',
    minFirstBaseline: num(lookup(tf, 'MinimumFirstBaselineOffset')),
    autoSize: lookup(tf, 'AutoSizingType') ?? 'Off',
    ignoreWrap: lookup(tf, 'IgnoreWrap') === 'true',
  };
}

function readWrap(chainEls: Element[]): Wrap | null {
  const tw = childChain(chainEls, 'TextWrapPreference');
  const mode = lookup(tw, 'TextWrapMode') ?? 'None';
  if (mode === 'None') return null;
  const off = tw.map((e) => propEl(e, 'TextWrapOffset')).find(Boolean);
  return {
    mode,
    offsets: [num(off?.getAttribute('Top')), num(off?.getAttribute('Left')), num(off?.getAttribute('Bottom')), num(off?.getAttribute('Right'))],
    inverse: lookup(tw, 'Inverse') === 'true',
  };
}

function readShadow(chainEls: Element[]): Item['shadow'] {
  const ts = childChain(chainEls, 'TransparencySetting');
  const ds = ts.map((t) => child(t, 'DropShadowSetting')).filter((x): x is Element => !!x);
  if (!ds.length || lookup(ds, 'Mode') !== 'Drop') return null;
  return {
    color: lookup(ds, 'EffectColor') ?? 'Color/Black',
    opacity: num(lookup(ds, 'Opacity'), 75) / 100,
    x: num(lookup(ds, 'XOffset'), 7),
    y: num(lookup(ds, 'YOffset'), 7),
    blur: num(lookup(ds, 'Size'), 5),
  };
}

function readOpacity(chainEls: Element[]): { opacity: number; blend: string } {
  const ts = childChain(chainEls, 'TransparencySetting');
  const bs = ts.map((t) => child(t, 'BlendingSetting')).filter((x): x is Element => !!x);
  return { opacity: num(lookup(bs, 'Opacity'), 100) / 100, blend: lookup(bs, 'BlendMode') ?? 'Normal' };
}

interface ReadCtx {
  part: string;
  styles: Styles;
  layers: Map<string, LayerInfo>;
  defaultLayer: string;
}

function readItem(el: Element, ctx: ReadCtx, parent: string | null, parentM: Mat, parentLayer: string | null): Item | null {
  const tag = el.localName;
  const kind = ITEM_TAGS[tag];
  if (!kind) return null;
  const self = el.getAttribute('Self') ?? '';
  const local = parseMat(el.getAttribute('ItemTransform'));
  const m = mul(parentM, local);
  const ch = objectChain(ctx.styles, el);
  let paths = readPaths(el);
  const layer = el.getAttribute('ItemLayer') ?? parentLayer ?? ctx.defaultLayer;
  let graphic: Item['graphic'] = null;
  let box: Rect;
  if (kind === 'graphic') {
    const gb = propEl(el, 'GraphicBounds');
    const b = gb
      ? { x: num(gb.getAttribute('Left')), y: num(gb.getAttribute('Top')), w: num(gb.getAttribute('Right')) - num(gb.getAttribute('Left')), h: num(gb.getAttribute('Bottom')) - num(gb.getAttribute('Top')) }
      : pathBounds(paths);
    const link = child(el, 'Link');
    graphic = {
      kind: tag,
      bounds: b,
      link: link?.getAttribute('LinkResourceURI') ?? null,
      embedded: !!propEl(el, 'Contents') || link?.getAttribute('StoredState') === 'Embedded',
    };
    box = b;
    if (!paths.length) paths = [{ open: false, points: rectCorners(b).map((p) => ({ anchor: p, left: p, right: p })) }];
  } else box = pathBounds(paths);
  const { opacity, blend } = readOpacity(ch);
  const fill = lookup(ch, 'FillColor');
  const stroke = lookup(ch, 'StrokeColor');
  const tfEl = kind === 'text' ? el : null;
  const fitting = child(el, 'FrameFittingOption');
  const children: Item[] = [];
  const item: Item = {
    self,
    tag,
    kind,
    part: ctx.part,
    parent,
    local,
    m,
    paths,
    box,
    fill: !fill || fill === 'Swatch/None' || fill === 'n' ? null : fill,
    fillTint: num(lookup(ch, 'FillTint'), -1),
    stroke: !stroke || stroke === 'Swatch/None' || stroke === 'n' ? null : stroke,
    strokeTint: num(lookup(ch, 'StrokeTint'), -1),
    strokeWeight: num(lookup(ch, 'StrokeWeight'), stroke ? 1 : 0),
    strokeType: lookup(ch, 'StrokeType') ?? 'StrokeStyle/$ID/Solid',
    strokeAlign: lookup(ch, 'StrokeAlignment') ?? 'CenterAlignment',
    gap: lookup(ch, 'GapColor'),
    join: lookup(ch, 'EndJoin') ?? 'MiterEndJoin',
    cap: lookup(ch, 'EndCap') ?? 'ButtEndCap',
    cornerOption: lookup(ch, 'CornerOption') ?? lookup(ch, 'TopLeftCornerOption') ?? 'None',
    cornerRadius: num(lookup(ch, 'CornerRadius') ?? lookup(ch, 'TopLeftCornerRadius'), 12),
    opacity,
    blend,
    shadow: readShadow(ch),
    gradFill: (() => {
      const len = num(el.getAttribute('GradientFillLength'));
      if (!len) return null;
      const s = (el.getAttribute('GradientFillStart') ?? '0 0').split(/\s+/).map(Number);
      return { start: { x: s[0] || 0, y: s[1] || 0 }, length: len, angle: num(el.getAttribute('GradientFillAngle')) };
    })(),
    layer,
    visible: el.getAttribute('Visible') !== 'false',
    locked: el.getAttribute('Locked') === 'true',
    name: cleanName(el.getAttribute('Name')),
    contentType: el.getAttribute('ContentType') ?? (kind === 'text' ? 'TextType' : 'Unassigned'),
    children,
    text: tfEl
      ? {
          story: el.getAttribute('ParentStory') ?? '',
          prev: ((p) => (p && p !== 'n' ? p : null))(el.getAttribute('PreviousTextFrame')),
          next: ((p) => (p && p !== 'n' ? p : null))(el.getAttribute('NextTextFrame')),
          prefs: readTextPrefs(ch),
        }
      : null,
    graphic,
    wrap: readWrap(ch),
    fitting: fitting
      ? {
          autoFit: fitting.getAttribute('AutoFit') === 'true',
          crop: [num(fitting.getAttribute('LeftCrop')), num(fitting.getAttribute('TopCrop')), num(fitting.getAttribute('RightCrop')), num(fitting.getAttribute('BottomCrop'))],
        }
      : null,
    overrides: el.getAttribute('OverriddenMasterPageItem'),
    nonprinting: lookup(ch, 'Nonprinting') === 'true',
  };
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (!ITEM_TAGS[c.localName]) continue;
    const ci = readItem(c, ctx, self, m, layer);
    if (ci) children.push(ci);
  }
  // A group's box is what's in it, in its own coordinates.
  if (kind === 'group' && children.length) item.box = boundsOf(children.flatMap((ch) => rectCorners(ch.box).map((p) => apply(ch.local, p))));
  return item;
}

function readPage(el: Element, spread: string, part: string, index: number): Page {
  const gb = (el.getAttribute('GeometricBounds') ?? '0 0 792 612').split(/\s+/).map(Number);
  const geom = { x: gb[1] || 0, y: gb[0] || 0, w: (gb[3] || 0) - (gb[1] || 0), h: (gb[2] || 0) - (gb[0] || 0) };
  const m = parseMat(el.getAttribute('ItemTransform'));
  const mp = child(el, 'MarginPreference');
  const master = el.getAttribute('AppliedMaster');
  return {
    self: el.getAttribute('Self') ?? '',
    name: el.getAttribute('Name') ?? String(index + 1),
    spread,
    part,
    geom,
    m,
    bounds: transformRect(m, geom),
    master: master && master !== 'n' ? master : null,
    masterTransform: parseMat(el.getAttribute('MasterPageTransform')),
    margins: {
      top: num(mp?.getAttribute('Top'), 36),
      bottom: num(mp?.getAttribute('Bottom'), 36),
      left: num(mp?.getAttribute('Left'), 36),
      right: num(mp?.getAttribute('Right'), 36),
      columns: Math.max(1, num(mp?.getAttribute('ColumnCount'), 1)),
      gutter: num(mp?.getAttribute('ColumnGutter'), 12),
      positions: (mp?.getAttribute('ColumnsPositions') ?? '').split(/\s+/).filter(Boolean).map(Number),
    },
    side: 'single',
    overrides: new Set((el.getAttribute('OverrideList') ?? '').split(/\s+/).filter(Boolean)),
    index,
  };
}

function readGuide(el: Element, page: string | null): Guide {
  const c = propEl(el, 'GuideColor');
  const name = (c?.textContent ?? 'Cyan').trim();
  return {
    self: el.getAttribute('Self') ?? '',
    vertical: el.getAttribute('Orientation') === 'Vertical',
    location: num(el.getAttribute('Location')),
    color: LAYER_COLORS[name] ?? '#4ad3ff',
    page,
  };
}

interface SpreadCache {
  version: number;
  stylesVersion: number;
  styles: XMLDocument | undefined;
  layersKey: string;
  spread: Omit<Spread, 'y'>;
}
const SPREADS = new WeakMap<XMLDocument, SpreadCache>();

function readSpread(doc: XMLDocument, part: string, styles: Styles, stylesDoc: XMLDocument | undefined, layers: Map<string, LayerInfo>, defaultLayer: string): Omit<Spread, 'y'> | null {
  const layersKey = defaultLayer;
  const hit = SPREADS.get(doc);
  if (hit && hit.styles === stylesDoc && hit.layersKey === layersKey && hit.version === docVersion(doc) && hit.stylesVersion === (stylesDoc ? docVersion(stylesDoc) : 0)) return hit.spread;
  const root = partRoot(doc);
  if (!root) return null;
  const isMaster = root.localName === 'MasterSpread';
  const self = root.getAttribute('Self') ?? part;
  const m = parseMat(root.getAttribute('ItemTransform'));
  const pages: Page[] = [];
  const items: Item[] = [];
  const guides: Guide[] = [];
  const ctx: ReadCtx = { part, styles, layers, defaultLayer };
  for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'Page') {
      const p = readPage(c, self, part, pages.length);
      pages.push(p);
      for (const g of kids(c, 'Guide')) guides.push(readGuide(g, p.self));
    } else if (c.localName === 'Guide') guides.push(readGuide(c, null));
    else if (ITEM_TAGS[c.localName]) {
      const it = readItem(c, ctx, null, m, null);
      if (it) items.push(it);
    }
  }
  for (const p of pages) p.m = mul(m, p.m);
  for (const p of pages) p.bounds = transformRect(p.m, p.geom);
  // Facing pages: pages left of the spine are left pages.
  if (pages.length > 1 || (pages.length === 1 && pages[0].bounds.x + pages[0].bounds.w <= 0.5)) {
    for (const p of pages) p.side = p.bounds.x + p.bounds.w / 2 < 0 ? 'left' : 'right';
  } else if (pages.length === 1) pages[0].side = pages[0].bounds.x >= -0.5 ? 'right' : 'single';
  let bounds: Rect | null = null;
  for (const p of pages) bounds = unionRect(bounds, p.bounds);
  const spread = {
    self,
    part,
    isMaster,
    name: isMaster ? cleanName(root.getAttribute('Name')) : '',
    prefix: isMaster ? cleanName(root.getAttribute('NamePrefix')) : '',
    pages,
    items,
    m,
    bounds: bounds ?? { x: 0, y: 0, w: 612, h: 792 },
    showMasterItems: root.getAttribute('ShowMasterItems') !== 'false',
    guides,
  };
  SPREADS.set(doc, { styles: stylesDoc, layersKey, spread, version: docVersion(doc), stylesVersion: stylesDoc ? docVersion(stylesDoc) : 0 });
  return spread;
}

/** Page items anchored in a story's text (not those inside them). */
const ANCHORED = new WeakMap<Element, { version: number; els: Element[] }>();

function anchoredIn(story: Element): Element[] {
  const v = docVersion(story.ownerDocument as XMLDocument);
  const hit = ANCHORED.get(story);
  if (hit && hit.version === v) return hit.els;
  const out: Element[] = [];
  ANCHORED.set(story, { version: v, els: out });
  const walk = (el: Element) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (ITEM_TAGS[c.localName] && c.localName !== 'Image' && c.localName !== 'PDF' && c.localName !== 'EPS') out.push(c);
      else if (c.localName !== 'Properties' && c.localName !== 'Table') walk(c);
    }
  };
  walk(story);
  return out;
}

/** Spreads are stacked down the pasteboard this far apart. */
export const SPREAD_GAP = 54;

export function buildModel(pkg: Pkg): Model {
  const dm = pkg.xml.get('designmap.xml');
  const root = dm?.documentElement;
  if (!dm || !root) throw new Error('It has no designmap.xml.');
  const stylesPart = kids(root, 'idPkg:Styles')[0]?.getAttribute('src') ?? 'Resources/Styles.xml';
  const graphicPart = kids(root, 'idPkg:Graphic')[0]?.getAttribute('src') ?? 'Resources/Graphic.xml';
  const prefsPart = kids(root, 'idPkg:Preferences')[0]?.getAttribute('src') ?? 'Resources/Preferences.xml';
  const stylesDoc = pkg.xml.get(stylesPart);
  const styles = readStyles(stylesDoc);
  const swatches = readSwatches(pkg.xml.get(graphicPart));

  const layers: LayerInfo[] = kids(root, 'Layer').map((l, i) => ({
    self: l.getAttribute('Self') ?? '',
    name: l.getAttribute('Name') || `Layer ${i + 1}`,
    visible: l.getAttribute('Visible') !== 'false',
    locked: l.getAttribute('Locked') === 'true',
    printable: l.getAttribute('Printable') !== 'false',
    color: layerColor(l, i),
  }));
  const layerMap = new Map(layers.map((l) => [l.self, l]));
  const defaultLayer = layers[layers.length - 1]?.self ?? '';

  const prefsDoc = pkg.xml.get(prefsPart);
  const dp = prefsDoc ? all(prefsDoc.documentElement, 'DocumentPreference')[0] : null;
  const vp = prefsDoc ? all(prefsDoc.documentElement, 'ViewPreference')[0] : null;
  const mp = prefsDoc ? all(prefsDoc.documentElement, 'MarginPreference')[0] : null;
  const tp = prefsDoc ? all(prefsDoc.documentElement, 'TextPreference')[0] : null;

  const spreads: Spread[] = [];
  const masters: Spread[] = [];
  const pages: Page[] = [];
  const items = new Map<string, Item>();
  const spreadOf = new Map<string, Spread>();
  const stories = new Map<string, string>();
  let y = 0;
  let my = 0;
  for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
    const src = c.getAttribute('src');
    if (!src) continue;
    if (c.nodeName === 'idPkg:Spread' || c.nodeName === 'idPkg:MasterSpread') {
      const doc = pkg.xml.get(src);
      if (!doc) continue;
      const s0 = readSpread(doc, src, styles, stylesDoc, layerMap, defaultLayer);
      if (!s0) continue;
      const isMaster = c.nodeName === 'idPkg:MasterSpread';
      const s: Spread = { ...s0, y: 0 };
      if (isMaster) {
        s.y = my - s.bounds.y;
        my += s.bounds.h + SPREAD_GAP;
        masters.push(s);
      } else {
        s.y = y - s.bounds.y;
        y += s.bounds.h + SPREAD_GAP;
        spreads.push(s);
        for (const p of s.pages) pages.push({ ...p, index: pages.length });
      }
      const walk = (list: Item[]) => {
        for (const it of list) {
          items.set(it.self, it);
          spreadOf.set(it.self, s);
          walk(it.children);
        }
      };
      walk(s.items);
    } else if (c.nodeName === 'idPkg:Story') {
      const doc = pkg.xml.get(src);
      const st = doc && partRoot(doc);
      if (st) stories.set(st.getAttribute('Self') ?? '', src);
    }
  }
  // Pages keep their place in the document for the Pages panel; spreads point at the same objects.
  for (const s of spreads) s.pages = s.pages.map((p) => pages.find((q) => q.self === p.self) ?? p);

  // Objects anchored in text, drawn where InDesign last put them (their transform is on the spread).
  const done = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const frames = new Map<string, Item[]>();
    for (const it of items.values()) if (it.kind === 'text' && it.text) frames.set(it.text.story, [...(frames.get(it.text.story) ?? []), it]);
    let added = false;
    for (const [story, part] of stories) {
      if (done.has(story)) continue;
      const fs = frames.get(story);
      if (!fs) continue;
      done.add(story);
      const doc = pkg.xml.get(part);
      const st = doc && partRoot(doc);
      if (!st) continue;
      for (const el of anchoredIn(st)) {
        const first = fs[0];
        const s = spreadOf.get(first.self);
        if (!s) continue;
        const it = readItem(el, { part, styles, layers: layerMap, defaultLayer }, null, s.m, first.layer);
        if (!it) continue;
        // On the spread of the frame it sits in, just above that frame.
        const c = apply(it.m, { x: it.box.x + it.box.w / 2, y: it.box.y + it.box.h / 2 });
        const host = fs.find((f) => {
          const b = transformRect(f.m, f.box);
          return c.x >= b.x - 50 && c.x <= b.x + b.w + 50 && c.y >= b.y - 50 && c.y <= b.y + b.h + 50;
        }) ?? first;
        const hs = spreadOf.get(host.self) ?? s;
        let top = host;
        while (top.parent && items.get(top.parent)) top = items.get(top.parent)!;
        const at = hs.items.indexOf(top);
        hs.items = [...hs.items.slice(0, at + 1), { ...it, anchored: true }, ...hs.items.slice(at + 1)];
        const walk = (list: Item[]) => {
          for (const x of list) {
            items.set(x.self, x);
            spreadOf.set(x.self, hs);
            walk(x.children);
          }
        };
        walk([{ ...it, anchored: true }]);
        added = true;
      }
    }
    if (!added) break;
  }

  const threads = new Map<string, Item[]>();
  for (const it of items.values()) {
    if (it.kind !== 'text' || !it.text) continue;
    const list = threads.get(it.text.story) ?? [];
    list.push(it);
    threads.set(it.text.story, list);
  }
  for (const [story, list] of threads) {
    if (list.length < 2) continue;
    const byself = new Map(list.map((f) => [f.self, f]));
    const first = list.find((f) => !f.text!.prev || !byself.has(f.text!.prev)) ?? list[0];
    const ordered: Item[] = [];
    const seen = new Set<string>();
    for (let f: Item | undefined = first; f && !seen.has(f.self); f = f.text!.next ? byself.get(f.text!.next) : undefined) {
      seen.add(f.self);
      ordered.push(f);
    }
    for (const f of list) if (!seen.has(f.self)) ordered.push(f);
    threads.set(story, ordered);
  }

  const bleedOut = num(dp?.getAttribute('DocumentBleedOutsideOrRightOffset'));
  return {
    pkg,
    spreads,
    masters,
    pages,
    layers,
    swatches,
    styles,
    stories,
    items,
    spreadOf,
    prefs: {
      pageW: num(dp?.getAttribute('PageWidth'), pages[0]?.geom.w ?? 612),
      pageH: num(dp?.getAttribute('PageHeight'), pages[0]?.geom.h ?? 792),
      facing: dp ? dp.getAttribute('FacingPages') === 'true' : spreads.some((s) => s.pages.length > 1),
      bleed: {
        top: num(dp?.getAttribute('DocumentBleedTopOffset')),
        bottom: num(dp?.getAttribute('DocumentBleedBottomOffset')),
        inside: num(dp?.getAttribute('DocumentBleedInsideOrLeftOffset')),
        outside: bleedOut,
      },
      hUnit: unitFromIdml(vp?.getAttribute('HorizontalMeasurementUnits')),
      vUnit: unitFromIdml(vp?.getAttribute('VerticalMeasurementUnits')),
      domVersion: root.getAttribute('DOMVersion') ?? '8.0',
      pagesPerDocument: num(dp?.getAttribute('PagesPerDocument'), 1),
      columnGutter: num(mp?.getAttribute('ColumnGutter'), 12),
      text: {
        superSize: num(tp?.getAttribute('SuperscriptSize'), 58.3) / 100,
        superPos: num(tp?.getAttribute('SuperscriptPosition'), 33.3) / 100,
        smallCap: num(tp?.getAttribute('SmallCap'), 70) / 100,
      },
      intent: dp?.getAttribute('Intent') ?? 'PrintIntent',
    },
    threads,
    activeLayer: root.getAttribute('ActiveLayer'),
  };
}

// ---- Questions about the model ----------------------------------------------------------

/** The spread and page a point on the pasteboard falls on (or is nearest). */
export function pageAt(spreads: Spread[], p: Pt): { spread: Spread; page: Page | null } | null {
  let best: { spread: Spread; page: Page | null; d: number } | null = null;
  for (const s of spreads) {
    const q = { x: p.x, y: p.y - s.y };
    for (const pg of s.pages) {
      const b = pg.bounds;
      const dx = Math.max(b.x - q.x, 0, q.x - b.x - b.w);
      const dy = Math.max(b.y - q.y, 0, q.y - b.y - b.h);
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { spread: s, page: pg, d };
    }
  }
  return best ? { spread: best.spread, page: best.page } : null;
}

export function spreadAtY(spreads: Spread[], y: number): Spread | null {
  let best: Spread | null = null;
  let bd = Infinity;
  for (const s of spreads) {
    const top = s.y + s.bounds.y;
    const d = y < top ? top - y : y > top + s.bounds.h ? y - top - s.bounds.h : 0;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** Bounds of an item in spread coordinates. */
export const itemBounds = (it: Item) => transformRect(it.m, it.box);

/** The page an item belongs to: the one under its center. */
export function pageOf(spread: Spread, it: Item): Page | null {
  const b = itemBounds(it);
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let best: Page | null = null;
  let bd = Infinity;
  for (const p of spread.pages) {
    const pb = p.bounds;
    const dx = Math.max(pb.x - c.x, 0, c.x - pb.x - pb.w);
    const dy = Math.max(pb.y - c.y, 0, c.y - pb.y - pb.h);
    const d = Math.hypot(dx, dy);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** Spread coordinates of master items as they land on a document page. */
export function masterToPage(page: Page, masterPage: Page): Mat {
  return mul(page.m, mul(page.masterTransform, invert(masterPage.m)));
}

/** Which master page a document page takes its items from. */
export function masterPageFor(master: Spread, page: Page): Page | null {
  if (!master.pages.length) return null;
  if (master.pages.length === 1) return master.pages[0];
  if (page.side === 'left') return master.pages[0];
  if (page.side === 'right') return master.pages[master.pages.length - 1];
  return master.pages[0];
}

/** Walks items depth first, parents before children. */
export function* walkItems(list: Item[]): Generator<Item> {
  for (const it of list) {
    yield it;
    yield* walkItems(it.children);
  }
}

export function topItem(model: Model, self: string): Item | null {
  let it = model.items.get(self) ?? null;
  while (it?.parent) {
    const p = model.items.get(it.parent);
    if (!p) break;
    it = p;
  }
  return it;
}

/** The box of an item's outline in spread coordinates, as four corners. */
export function itemCorners(it: Item): Pt[] {
  return rectCorners(it.box).map((p) => apply(it.m, p));
}

export { boundsOf, IDENTITY };
