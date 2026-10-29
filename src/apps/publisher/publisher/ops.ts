import { apply, boundsOf, fmtMat, fmtNum, invert, mul, ovalPath, pathBounds, polygonPath, rectCorners, rectPath, translate, type Mat, type Pt, type Rect, type SubPath } from './geom';
import { all, child, Draft, el, ensureProps, findSelf, kids, newPart, num, partRoot, setProp, type Pkg } from './idml';
import { isItemTag, layerColorName, type Item, type Model, type Page, type Spread } from './model';

/**
 * Edits to the document, each made on a Draft of the package: page items
 * (create, move, resize, transform, restyle, group, arrange, duplicate,
 * delete), placed graphics and fitting, text frames and their stories and
 * threads, pages and spreads, layers and guides.
 */

export const itemEl = (d: Draft, it: { self: string; part: string }) => findSelf(d.part(it.part), it.self);

export function writePaths(e: Element, paths: SubPath[]) {
  const doc = e.ownerDocument;
  const props = ensureProps(e);
  let pg = child(props, 'PathGeometry');
  if (pg) pg.textContent = '';
  else {
    pg = doc.createElement('PathGeometry');
    props.appendChild(pg);
  }
  for (const sp of paths) {
    const arr = el(
      doc,
      'PathPointArray',
      {},
      sp.points.map((p) =>
        el(doc, 'PathPointType', {
          Anchor: `${fmtNum(p.anchor.x)} ${fmtNum(p.anchor.y)}`,
          LeftDirection: `${fmtNum(p.left.x)} ${fmtNum(p.left.y)}`,
          RightDirection: `${fmtNum(p.right.x)} ${fmtNum(p.right.y)}`,
        }),
      ),
    );
    pg.appendChild(el(doc, 'GeometryPathType', { PathOpen: sp.open ? 'true' : 'false' }, [arr]));
  }
}

/** The transform from an item's parent to the spread (pages are children of the spread too). */
export function parentM(model: Model, it: Item): Mat {
  if (it.parent) return model.items.get(it.parent)?.m ?? model.spreadOf.get(it.self)?.m ?? [1, 0, 0, 1, 0, 0];
  return model.spreadOf.get(it.self)?.m ?? [1, 0, 0, 1, 0, 0];
}

/** An item with a transform applied in spread coordinates, as it'll be read back. */
export function transformed(model: Model, it: Item, t: Mat): Item {
  const pm = parentM(model, it);
  const local = mul(invert(pm), mul(t, mul(pm, it.local)));
  const m = mul(pm, local);
  const fix = (ch: Item, parent: Mat): Item => {
    const cm = mul(parent, ch.local);
    return { ...ch, m: cm, children: ch.children.map((g) => fix(g, cm)) };
  };
  return { ...it, local, m, children: it.children.map((c) => fix(c, m)) };
}

export function setTransformOf(d: Draft, model: Model, it: Item, t: Mat) {
  const e = itemEl(d, it);
  if (!e) return;
  const pm = parentM(model, it);
  const local = mul(invert(pm), mul(t, mul(pm, it.local)));
  e.setAttribute('ItemTransform', fmtMat(local));
}

/** An item with its outline fitted to a new box (in its own coordinates); what's inside stays put. */
export function reshaped(it: Item, box: Rect): Item {
  const o = it.box;
  const fx = (x: number) => box.x + (o.w ? ((x - o.x) / o.w) * box.w : box.w / 2);
  const fy = (y: number) => box.y + (o.h ? ((y - o.y) / o.h) * box.h : box.h / 2);
  const f = (p: Pt) => ({ x: fx(p.x), y: fy(p.y) });
  const paths = it.paths.map((sp) => ({ open: sp.open, points: sp.points.map((p) => ({ anchor: f(p.anchor), left: f(p.left), right: f(p.right) })) }));
  return { ...it, paths, box: pathBounds(paths) };
}

export function setPathsOf(d: Draft, it: Item, paths: SubPath[]) {
  const e = itemEl(d, it);
  if (e) writePaths(e, paths);
}

/** Resizing a group or a graphic scales it (InDesign changes their transform rather than a path). */
export const resizesByScale = (it: Item) => it.kind === 'group' || it.kind === 'graphic' || !it.paths.length;

export function setAttrs(d: Draft, it: { self: string; part: string }, attrs: Record<string, string | number | null>) {
  const e = itemEl(d, it);
  if (!e) return;
  for (const [k, v] of Object.entries(attrs)) setProp(e, k, v);
}

/** Corner options for all four corners, as InDesign writes them. */
export function cornerAttrs(option: string, radius: number): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const c of ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']) {
    out[`${c}CornerOption`] = option;
    out[`${c}CornerRadius`] = radius;
  }
  return out;
}

// ---- Creating ---------------------------------------------------------------------------------

export interface NewLook {
  fill: string;
  stroke: string;
  weight: number;
}

function objectStyle(model: Model, name: string): string {
  const want = `ObjectStyle/$ID/${name}`;
  if (model.styles.object.has(want)) return want;
  if (model.styles.object.has('ObjectStyle/$ID/[None]')) return 'ObjectStyle/$ID/[None]';
  return 'n';
}

export function spreadRoot(d: Draft, s: Spread): Element {
  return partRoot(d.part(s.part))!;
}

/** Spread coordinates (before the spread's own transform) of a pasteboard point. */
export const toSpreadLocal = (s: Spread, p: Pt): Pt => apply(invert(s.m), { x: p.x, y: p.y - s.y });

export type ShapeKind = 'rect' | 'oval' | 'polygon' | 'line' | 'text';

export function createItem(
  d: Draft,
  model: Model,
  s: Spread,
  kind: ShapeKind,
  /** Pasteboard rectangle (or the line's ends). */
  a: Pt,
  b: Pt,
  look: NewLook,
  opts: { frame?: boolean; sides?: number; inset?: number; layer: string },
): { self: string; story?: string } {
  const pa = toSpreadLocal(s, a);
  const pb = toSpreadLocal(s, b);
  const doc = d.part(s.part);
  const root = partRoot(doc)!;
  const self = d.newId();
  const cx = (pa.x + pb.x) / 2;
  const cy = (pa.y + pb.y) / 2;
  const w = Math.abs(pb.x - pa.x);
  const h = Math.abs(pb.y - pa.y);
  const box = { x: -w / 2, y: -h / 2, w, h };
  let paths: SubPath[];
  let tag: string;
  if (kind === 'line') {
    tag = 'GraphicLine';
    paths = [
      {
        open: true,
        points: [pa, pb].map((p) => {
          const q = { x: p.x - cx, y: p.y - cy };
          return { anchor: q, left: q, right: q };
        }),
      },
    ];
  } else if (kind === 'oval') {
    tag = 'Oval';
    paths = [ovalPath(box)];
  } else if (kind === 'polygon') {
    tag = 'Polygon';
    paths = [polygonPath(box, opts.sides ?? 6, opts.inset ?? 0)];
  } else {
    tag = kind === 'text' ? 'TextFrame' : 'Rectangle';
    paths = [rectPath(box)];
  }
  const attrs: Record<string, string> = { Self: self };
  let story: string | undefined;
  if (kind === 'text') {
    story = newStory(d, model);
    Object.assign(attrs, { ParentStory: story, PreviousTextFrame: 'n', NextTextFrame: 'n', ContentType: 'TextType' });
  } else attrs.ContentType = opts.frame ? 'GraphicType' : 'Unassigned';
  Object.assign(attrs, {
    StoryTitle: '$ID/',
    ItemLayer: opts.layer,
    Locked: 'false',
    LocalDisplaySetting: 'Default',
    AppliedObjectStyle: objectStyle(model, kind === 'text' ? '[Normal Text Frame]' : '[Normal Graphics Frame]'),
    Visible: 'true',
    Name: '$ID/',
    ItemTransform: fmtMat([1, 0, 0, 1, cx, cy]),
  });
  if (kind === 'text') {
    Object.assign(attrs, { FillColor: 'Swatch/None', StrokeColor: 'Swatch/None', StrokeWeight: '1' });
  } else if (opts.frame) {
    Object.assign(attrs, { FillColor: 'Swatch/None', StrokeColor: 'Swatch/None', StrokeWeight: '0' });
  } else {
    Object.assign(attrs, { FillColor: kind === 'line' ? 'Swatch/None' : look.fill, StrokeColor: look.stroke, StrokeWeight: String(look.weight) });
  }
  const e = el(doc, tag, attrs);
  writePaths(e, paths);
  if (kind === 'text') e.appendChild(el(doc, 'TextFramePreference', { TextColumnFixedWidth: fmtNum(w) }));
  root.appendChild(e);
  return { self, story };
}

/** A new, empty story part, listed in the designmap. */
export function newStory(d: Draft, model: Model, from?: Element): string {
  const self = d.newId();
  const part = `Stories/Story_${self}.xml`;
  const doc = newPart('Story', model.prefs.domVersion);
  const wrap = doc.documentElement;
  const st = el(doc, 'Story', { Self: self, AppliedTOCStyle: 'n', TrackChanges: 'false', StoryTitle: '$ID/', AppliedNamedGrid: 'n' });
  st.appendChild(el(doc, 'StoryPreference', { OpticalMarginAlignment: 'false', OpticalMarginSize: '12', FrameType: 'TextFrameType', StoryOrientation: 'Horizontal', StoryDirection: 'LeftToRightDirection' }));
  st.appendChild(el(doc, 'InCopyExportOption', { IncludeGraphicProxies: 'true', IncludeAllResources: 'false' }));
  if (from) {
    for (const c of Array.from(from.children)) if (c.localName !== 'StoryPreference' && c.localName !== 'InCopyExportOption') st.appendChild(doc.importNode(c, true));
  } else {
    const ps = model.styles.para.has('ParagraphStyle/$ID/NormalParagraphStyle') ? 'ParagraphStyle/$ID/NormalParagraphStyle' : (model.styles.paraList[0]?.self ?? 'ParagraphStyle/$ID/[No paragraph style]');
    st.appendChild(el(doc, 'ParagraphStyleRange', { AppliedParagraphStyle: ps }, [el(doc, 'CharacterStyleRange', { AppliedCharacterStyle: 'CharacterStyle/$ID/[No character style]' })]));
  }
  wrap.appendChild(st);
  d.add(part, doc);
  const dm = d.part('designmap.xml');
  const root = dm.documentElement;
  const ref = dm.createElement('idPkg:Story');
  ref.setAttribute('src', part);
  const stories = kids(root, 'idPkg:Story');
  const last = stories[stories.length - 1];
  if (last) last.after(ref);
  else root.appendChild(ref);
  const list = (root.getAttribute('StoryList') ?? '').split(/\s+/).filter(Boolean);
  list.push(self);
  root.setAttribute('StoryList', list.join(' '));
  return self;
}

export function removeStory(d: Draft, model: Model, story: string) {
  const part = model.stories.get(story);
  if (!part) return;
  d.remove(part);
  const dm = d.part('designmap.xml');
  const root = dm.documentElement;
  for (const r of kids(root, 'idPkg:Story')) if (r.getAttribute('src') === part) r.remove();
  const list = (root.getAttribute('StoryList') ?? '').split(/\s+/).filter((x) => x && x !== story);
  root.setAttribute('StoryList', list.join(' '));
}

// ---- Deleting, duplicating, grouping, arranging --------------------------------------------------

function textFramesIn(e: Element): Element[] {
  const out = e.localName === 'TextFrame' ? [e] : [];
  return out.concat(Array.from(e.getElementsByTagName('TextFrame')));
}

/** Keeps a thread whole around a frame being removed. */
function unthread(d: Draft, model: Model, tf: Element, removed: Set<string>) {
  const self = tf.getAttribute('Self') ?? '';
  const story = tf.getAttribute('ParentStory') ?? '';
  const frames = model.threads.get(story) ?? [];
  const idx = frames.findIndex((f) => f.self === self);
  if (idx < 0) return;
  const prev = frames.slice(0, idx).reverse().find((f) => !removed.has(f.self));
  const next = frames.slice(idx + 1).find((f) => !removed.has(f.self));
  if (prev) setAttrs(d, prev, { NextTextFrame: next?.self ?? 'n' });
  if (next) setAttrs(d, next, { PreviousTextFrame: prev?.self ?? 'n' });
  if (!frames.some((f) => !removed.has(f.self))) removeStory(d, model, story);
}

export function deleteItems(d: Draft, model: Model, items: Item[]) {
  const removed = new Set<string>();
  for (const it of items) {
    removed.add(it.self);
    const e = itemEl(d, it);
    if (e) for (const tf of textFramesIn(e)) removed.add(tf.getAttribute('Self') ?? '');
  }
  for (const it of items) {
    const e = itemEl(d, it);
    if (!e) continue;
    for (const tf of textFramesIn(e)) unthread(d, model, tf, removed);
  }
  for (const it of items) itemEl(d, it)?.remove();
}

/** Renumbers every Self in a copied element; text frames get copies of their stories. */
function renumber(d: Draft, model: Model, e: Element) {
  const nodes = [e, ...Array.from(e.getElementsByTagName('*'))];
  for (const n of nodes) {
    if (n.getAttribute('Self')) n.setAttribute('Self', d.newId());
  }
  for (const tf of textFramesIn(e)) {
    const story = tf.getAttribute('ParentStory') ?? '';
    const part = model.stories.get(story);
    const src = part ? d.peek(part) : undefined;
    const st = src ? partRoot(src) : null;
    // A copied frame gets the text it shows; threaded frames copy the whole story into the first copy.
    const copy = newStory(d, model, st ?? undefined);
    tf.setAttribute('ParentStory', copy);
    tf.setAttribute('PreviousTextFrame', 'n');
    tf.setAttribute('NextTextFrame', 'n');
  }
}

export function duplicateItems(d: Draft, model: Model, items: Item[], t: Mat): string[] {
  const out: string[] = [];
  for (const it of items) {
    const e = itemEl(d, it);
    if (!e) continue;
    const copy = e.cloneNode(true) as Element;
    renumber(d, model, copy);
    const pm = parentM(model, it);
    const local = mul(invert(pm), mul(t, mul(pm, it.local)));
    copy.setAttribute('ItemTransform', fmtMat(local));
    // Pasted onto the top of its layer.
    e.parentElement!.appendChild(copy);
    out.push(copy.getAttribute('Self')!);
  }
  return out;
}

/** Copies elements onto another spread (paste), keeping where they were relative to the page. */
export function pasteElements(d: Draft, model: Model, s: Spread, els: Element[], t: Mat, layer: string): string[] {
  const root = spreadRoot(d, s);
  const out: string[] = [];
  for (const src of els) {
    const copy = root.ownerDocument.importNode(src, true) as Element;
    renumberDetached(d, model, copy);
    copy.setAttribute('ItemTransform', fmtMat(mul(t, parseLocal(copy))));
    if (!model.layers.some((l) => l.self === copy.getAttribute('ItemLayer'))) copy.setAttribute('ItemLayer', layer);
    root.appendChild(copy);
    out.push(copy.getAttribute('Self')!);
  }
  return out;
}

function parseLocal(e: Element): Mat {
  const n = (e.getAttribute('ItemTransform') ?? '1 0 0 1 0 0').split(/\s+/).map(Number);
  return n.length === 6 && n.every(Number.isFinite) ? (n as unknown as Mat) : [1, 0, 0, 1, 0, 0];
}

function renumberDetached(d: Draft, model: Model, e: Element) {
  const nodes = [e, ...Array.from(e.getElementsByTagName('*'))];
  for (const n of nodes) if (n.getAttribute('Self')) n.setAttribute('Self', d.newId());
  for (const tf of textFramesIn(e)) {
    const storyXml = tf.getAttribute('data-story');
    tf.removeAttribute('data-story');
    let from: Element | undefined;
    if (storyXml) {
      const parsed = new DOMParser().parseFromString(storyXml, 'application/xml');
      from = parsed.documentElement.localName === 'Story' ? parsed.documentElement : undefined;
    }
    const copy = newStory(d, model, from);
    tf.setAttribute('ParentStory', copy);
    tf.setAttribute('PreviousTextFrame', 'n');
    tf.setAttribute('NextTextFrame', 'n');
  }
}

/** Elements for the clipboard, with each text frame carrying its story. */
export function copyElements(pkg: Pkg, model: Model, items: Item[]): Element[] {
  const out: Element[] = [];
  for (const it of items) {
    const doc = pkg.xml.get(it.part);
    const e = doc && findSelf(doc, it.self);
    if (!e) continue;
    const copy = e.cloneNode(true) as Element;
    const pm = parentM(model, it);
    copy.setAttribute('ItemTransform', fmtMat(mul(pm, it.local)));
    for (const tf of textFramesIn(copy)) {
      const part = model.stories.get(tf.getAttribute('ParentStory') ?? '');
      const st = part && pkg.xml.get(part);
      const root = st && partRoot(st);
      if (root) tf.setAttribute('data-story', new XMLSerializer().serializeToString(root));
    }
    out.push(copy);
  }
  return out;
}

export function groupItems(d: Draft, model: Model, items: Item[], layer: string): string | null {
  if (items.length < 2) return null;
  const els = items.map((it) => itemEl(d, it)).filter((e): e is Element => !!e);
  const parent = els[0]?.parentElement;
  if (!parent || els.some((e) => e.parentElement !== parent)) return null;
  const doc = parent.ownerDocument;
  const self = d.newId();
  const g = el(doc, 'Group', {
    Self: self,
    ItemLayer: items[items.length - 1].layer || layer,
    Locked: 'false',
    AppliedObjectStyle: objectStyle(model, '[None]'),
    Visible: 'true',
    Name: '$ID/',
    ItemTransform: '1 0 0 1 0 0',
  });
  // The group goes where the frontmost of its items was.
  const order = Array.from(parent.children);
  const front = els.reduce((a, b) => (order.indexOf(a) > order.indexOf(b) ? a : b));
  front.after(g);
  for (const e of els.sort((a, b) => order.indexOf(a) - order.indexOf(b))) g.appendChild(e);
  return self;
}

export function ungroup(d: Draft, model: Model, group: Item): string[] {
  const g = itemEl(d, group);
  if (!g) return [];
  const out: string[] = [];
  for (const c of Array.from(g.children)) {
    if (!isItemTag(c.localName)) continue;
    c.setAttribute('ItemTransform', fmtMat(mul(group.local, parseLocal(c))));
    if (!c.getAttribute('ItemLayer')) c.setAttribute('ItemLayer', group.layer);
    g.before(c);
    out.push(c.getAttribute('Self') ?? '');
  }
  g.remove();
  void model;
  return out;
}

export type Arrange = 'front' | 'forward' | 'backward' | 'back';

export function arrange(d: Draft, items: Item[], how: Arrange) {
  for (const it of how === 'front' || how === 'backward' ? items : [...items].reverse()) {
    const e = itemEl(d, it);
    const parent = e?.parentElement;
    if (!e || !parent) continue;
    const siblings = Array.from(parent.children).filter((c) => isItemTag(c.localName));
    const i = siblings.indexOf(e);
    if (how === 'front') parent.appendChild(e);
    else if (how === 'back') {
      if (siblings[0] !== e) siblings[0].before(e);
    }
    else if (how === 'forward') siblings[i + 1]?.after(e);
    else siblings[i - 1]?.before(e);
  }
}

// ---- Graphics ------------------------------------------------------------------------------------

const FORMATS: Record<string, string> = {
  jpg: '$ID/JPEG',
  jpeg: '$ID/JPEG',
  png: '$ID/Portable Network Graphics (PNG)',
  gif: '$ID/GIF',
  tif: '$ID/TIFF',
  tiff: '$ID/TIFF',
  psd: '$ID/Photoshop',
  bmp: '$ID/Windows Bitmap',
  webp: '$ID/WebP',
  svg: '$ID/SVG',
};

export function linkUri(path: string): string {
  return `file:${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Puts a picture (linked to its file) into a frame, at 100% or fitted. */
export function placeImage(d: Draft, frame: Item, path: string, size: { w: number; h: number }, fileSize: number, fit: 'fill' | 'fit' | 'none') {
  const fe = itemEl(d, frame);
  if (!fe) return null;
  for (const c of Array.from(fe.children)) if (isItemTag(c.localName)) c.remove();
  const doc = fe.ownerDocument;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const self = d.newId();
  const now = new Date().toISOString().slice(0, 19);
  const t = fitMatrix(frame.box, { x: 0, y: 0, w: size.w, h: size.h }, fit);
  const img = el(doc, 'Image', {
    Self: self,
    Space: '$ID/#Links_RGB',
    ActualPpi: '72 72',
    EffectivePpi: `${Math.round(72 / t[0])} ${Math.round(72 / t[3])}`,
    ImageRenderingIntent: 'UseColorSettings',
    LocalDisplaySetting: 'Default',
    ImageTypeName: FORMATS[ext] ?? '$ID/JPEG',
    AppliedObjectStyle: 'ObjectStyle/$ID/[None]',
    ItemTransform: fmtMat(t),
    Visible: 'true',
    Name: '$ID/',
  });
  const props = ensureProps(img);
  props.appendChild(el(doc, 'Profile', { type: 'string' }));
  props.lastElementChild!.textContent = '$ID/None';
  props.appendChild(el(doc, 'GraphicBounds', { Left: 0, Top: 0, Right: fmtNum(size.w), Bottom: fmtNum(size.h) }));
  img.appendChild(
    el(doc, 'Link', {
      Self: d.newId(),
      AssetURL: '$ID/',
      AssetID: '$ID/',
      LinkResourceURI: linkUri(path),
      LinkResourceFormat: FORMATS[ext] ?? '$ID/JPEG',
      StoredState: 'Normal',
      LinkClassID: '35906',
      LinkClientID: '257',
      LinkResourceModified: 'false',
      LinkObjectModified: 'false',
      ShowInUI: 'true',
      CanEmbed: 'true',
      CanUnembed: 'true',
      CanPackage: 'true',
      ImportPolicy: 'NoAutoImport',
      ExportPolicy: 'NoAutoExport',
      LinkImportStamp: `file 0 ${fileSize}`,
      LinkImportModificationTime: now,
      LinkImportTime: now,
      LinkResourceSize: `0~${fileSize.toString(16)}`,
    }),
  );
  fe.appendChild(img);
  if (fe.getAttribute('ContentType') !== 'GraphicType') fe.setAttribute('ContentType', 'GraphicType');
  return self;
}

/** Where a picture sits in a frame's box for a fitting. */
export function fitMatrix(frame: Rect, gb: Rect, how: 'fill' | 'fit' | 'none' | 'stretch' | 'center', current?: Mat): Mat {
  if (how === 'none') return [1, 0, 0, 1, frame.x - gb.x, frame.y - gb.y];
  if (how === 'stretch') {
    const sx = frame.w / (gb.w || 1);
    const sy = frame.h / (gb.h || 1);
    return [sx, 0, 0, sy, frame.x - gb.x * sx, frame.y - gb.y * sy];
  }
  const cur = current ? Math.hypot(current[0], current[1]) : 1;
  const s = how === 'center' ? cur : how === 'fill' ? Math.max(frame.w / (gb.w || 1), frame.h / (gb.h || 1)) : Math.min(frame.w / (gb.w || 1), frame.h / (gb.h || 1));
  const w = gb.w * s;
  const h = gb.h * s;
  return [s, 0, 0, s, frame.x + (frame.w - w) / 2 - gb.x * s, frame.y + (frame.h - h) / 2 - gb.y * s];
}

export type Fitting = 'fill' | 'fit' | 'stretch' | 'center' | 'frameToContent';

export function fitContent(d: Draft, frame: Item, how: Fitting) {
  const g = frame.children.find((c) => c.kind === 'graphic' || c.kind !== 'group') ?? frame.children[0];
  if (!g) return;
  const ge = itemEl(d, g);
  if (!ge) return;
  const gb = g.kind === 'graphic' && g.graphic ? g.graphic.bounds : g.box;
  if (how === 'frameToContent') {
    const corners = rectCorners(gb).map((p) => apply(g.local, p));
    const b = boundsOf(corners);
    setPathsOf(d, frame, reshaped(frame, b).paths);
    return;
  }
  ge.setAttribute('ItemTransform', fmtMat(fitMatrix(frame.box, gb, how, g.local)));
}

// ---- Text frames --------------------------------------------------------------------------------

export interface FrameOptions {
  columns: number;
  gutter: number;
  inset: [number, number, number, number];
  vj: string;
  firstBaseline: string;
  minFirstBaseline: number;
  ignoreWrap: boolean;
}

export function setFrameOptions(d: Draft, frame: Item, o: FrameOptions) {
  const e = itemEl(d, frame);
  if (!e) return;
  const doc = e.ownerDocument;
  let tf = child(e, 'TextFramePreference');
  if (!tf) {
    tf = doc.createElement('TextFramePreference');
    // After Properties, before anything else.
    const props = child(e, 'Properties');
    if (props) props.after(tf);
    else e.insertBefore(tf, e.firstChild);
  }
  tf.setAttribute('TextColumnCount', String(o.columns));
  tf.setAttribute('TextColumnGutter', fmtNum(o.gutter));
  tf.setAttribute('VerticalJustification', o.vj);
  tf.setAttribute('FirstBaselineOffset', o.firstBaseline);
  tf.setAttribute('MinimumFirstBaselineOffset', fmtNum(o.minFirstBaseline));
  tf.setAttribute('IgnoreWrap', o.ignoreWrap ? 'true' : 'false');
  const w = frame.box.w - o.inset[1] - o.inset[3];
  tf.setAttribute('TextColumnFixedWidth', fmtNum(Math.max(0, (w - o.gutter * (o.columns - 1)) / o.columns)));
  const props = ensureProps(tf);
  let ins = child(props, 'InsetSpacing');
  if (!ins) {
    ins = el(doc, 'InsetSpacing', { type: 'list' });
    props.appendChild(ins);
  }
  ins.textContent = '';
  for (const v of o.inset) {
    const li = el(doc, 'ListItem', { type: 'unit' });
    li.textContent = fmtNum(v);
    ins.appendChild(li);
  }
}

export function setWrap(d: Draft, it: Item, mode: string, offsets: [number, number, number, number]) {
  const e = itemEl(d, it);
  if (!e) return;
  const doc = e.ownerDocument;
  let tw = child(e, 'TextWrapPreference');
  if (!tw) {
    tw = el(doc, 'TextWrapPreference', { Inverse: 'false', ApplyToMasterPageOnly: 'false', TextWrapSide: 'BothSides' });
    const props = child(e, 'Properties');
    const after = child(e, 'TextFramePreference') ?? props;
    if (after) after.after(tw);
    else e.insertBefore(tw, e.firstChild);
  }
  tw.setAttribute('TextWrapMode', mode);
  const props = ensureProps(tw);
  let off = child(props, 'TextWrapOffset');
  if (!off) {
    off = doc.createElement('TextWrapOffset');
    props.appendChild(off);
  }
  off.setAttribute('Top', fmtNum(offsets[0]));
  off.setAttribute('Left', fmtNum(offsets[1]));
  off.setAttribute('Bottom', fmtNum(offsets[2]));
  off.setAttribute('Right', fmtNum(offsets[3]));
}

/** Threads `to` after `from`; text already in `to` joins the end of the story. */
export function threadFrames(d: Draft, model: Model, from: Item, to: Item) {
  const story = from.text!.story;
  const frames = model.threads.get(story) ?? [from];
  const next = from.text!.next ? frames.find((f) => f.self === from.text!.next) : undefined;
  const oldStory = to.text!.story;
  if (oldStory !== story) {
    const oldFrames = model.threads.get(oldStory) ?? [];
    const part = model.stories.get(oldStory);
    const src = part ? d.peek(part) : undefined;
    const sroot = src ? partRoot(src) : null;
    const tpart = model.stories.get(story);
    if (sroot && tpart) {
      const troot = partRoot(d.part(tpart))!;
      const ranges = kids(sroot, 'ParagraphStyleRange').concat(kids(sroot, 'XMLElement'));
      const hasText = (sroot.textContent ?? '').trim().length > 0;
      if (hasText) {
        // Start the moved text on a new paragraph.
        const lastCsr = Array.from(troot.getElementsByTagName('CharacterStyleRange')).pop();
        if (lastCsr) lastCsr.appendChild(troot.ownerDocument.createElement('Br'));
        for (const r of ranges) troot.appendChild(troot.ownerDocument.importNode(r, true));
      }
    }
    // Its other frames (if any) stay with the old story; this one leaves it.
    if (oldFrames.length <= 1) removeStory(d, model, oldStory);
    else {
      const rest = oldFrames.filter((f) => f.self !== to.self);
      rest.forEach((f, i) => setAttrs(d, f, { PreviousTextFrame: rest[i - 1]?.self ?? 'n', NextTextFrame: rest[i + 1]?.self ?? 'n' }));
    }
  }
  setAttrs(d, to, { ParentStory: story, PreviousTextFrame: from.self, NextTextFrame: next?.self ?? 'n' });
  setAttrs(d, from, { NextTextFrame: to.self });
  if (next) setAttrs(d, next, { PreviousTextFrame: to.self });
}

/** Breaks the thread after a frame: the frames after it keep... nothing; their text flows back. */
export function unthreadAfter(d: Draft, model: Model, from: Item) {
  const frames = model.threads.get(from.text!.story) ?? [];
  const i = frames.findIndex((f) => f.self === from.self);
  if (i < 0 || i === frames.length - 1) return;
  setAttrs(d, from, { NextTextFrame: 'n' });
  for (const f of frames.slice(i + 1)) {
    const st = newStory(d, model);
    setAttrs(d, f, { ParentStory: st, PreviousTextFrame: 'n', NextTextFrame: 'n' });
  }
}

export function storyRoot(d: Draft, model: Model, story: string): Element | null {
  const part = model.stories.get(story);
  if (!part) return null;
  return partRoot(d.part(part));
}

// ---- Pages --------------------------------------------------------------------------------------

interface PagePlan {
  page: Element;
  /** Page transform before (spread coordinates). */
  old: Mat;
  items: Element[];
}

/** Which page each top-level item of a spread sits on. */
function itemsByPage(model: Model, s: Spread): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const p of s.pages) out.set(p.self, []);
  for (const it of s.items) {
    const b = boundsOf(rectCorners(it.box).map((q) => apply(it.m, q)));
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    let best = s.pages[0];
    let bd = Infinity;
    for (const p of s.pages) {
      const pb = p.bounds;
      const d = Math.abs(c.x - (pb.x + pb.w / 2)) + Math.abs(c.y - (pb.y + pb.h / 2)) * 0.01;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) out.get(best.self)!.push(it);
  }
  void model;
  return out;
}

/**
 * Lays the document's pages out again (after pages are added or removed):
 * one page per spread, or pairs after a first right-hand page when pages
 * face. Items go with their pages.
 */
function relayout(d: Draft, model: Model, plan: PagePlan[]) {
  const facing = model.prefs.facing;
  const groups: PagePlan[][] = [];
  if (facing) {
    if (plan.length) groups.push([plan[0]]);
    for (let i = 1; i < plan.length; i += 2) groups.push(plan.slice(i, i + 2));
  } else for (const p of plan) groups.push([p]);
  const dm = d.part('designmap.xml');
  const root = dm.documentElement;
  const refs = kids(root, 'idPkg:Spread');
  // Detach every page and item from the spreads first.
  const spreadRoots = refs.map((r) => partRoot(d.part(r.getAttribute('src')!))!);
  for (const sr of spreadRoots) for (const c of Array.from(sr.children)) if (c.localName === 'Page' || isItemTag(c.localName)) c.remove();
  for (let gi = 0; gi < groups.length; gi++) {
    let sr: Element;
    if (gi < spreadRoots.length) sr = spreadRoots[gi];
    else {
      const self = d.newId();
      const part = `Spreads/Spread_${self}.xml`;
      const doc = newPart('Spread', model.prefs.domVersion);
      sr = el(doc, 'Spread', { Self: self, FlattenerOverride: 'Default', AllowPageShuffle: 'true', ItemTransform: '1 0 0 1 0 0', ShowMasterItems: 'true', PageCount: '1', BindingLocation: '0', PageTransitionType: 'None', PageTransitionDirection: 'NotApplicable', PageTransitionDuration: 'Medium' });
      doc.documentElement.appendChild(sr);
      d.add(part, doc);
      const ref = dm.createElement('idPkg:Spread');
      ref.setAttribute('src', part);
      const lastRef = kids(root, 'idPkg:Spread').pop();
      if (lastRef) lastRef.after(ref);
      else root.appendChild(ref);
      spreadRoots.push(sr);
    }
    const g = groups[gi];
    const sm: Mat = [1, 0, 0, 1, 0, 0];
    const leftCount = facing ? (gi === 0 ? 0 : 1) : 0;
    let x = facing ? (gi === 0 ? 0 : -(boundsW(g[0].page))) : 0;
    const firstPageEl = sr.firstElementChild && sr.firstElementChild.localName === 'FlattenerPreference' ? sr.firstElementChild : null;
    let anchor: Element | null = firstPageEl;
    for (const p of g) {
      const gb = (p.page.getAttribute('GeometricBounds') ?? '0 0 792 612').split(/\s+/).map(Number);
      const h = (gb[2] ?? 792) - (gb[0] ?? 0);
      const nm: Mat = [1, 0, 0, 1, x - (gb[1] ?? 0), -h / 2 - (gb[0] ?? 0)];
      p.page.setAttribute('ItemTransform', fmtMat(nm));
      if (anchor) anchor.after(p.page);
      else sr.insertBefore(p.page, sr.firstChild);
      anchor = p.page;
      const delta = mul(nm, invert(p.old));
      for (const it of p.items) {
        it.setAttribute('ItemTransform', fmtMat(mul(invert(sm), mul(delta, parseLocal(it)))));
        sr.appendChild(it);
      }
      x += (gb[3] ?? 612) - (gb[1] ?? 0);
    }
    sr.setAttribute('PageCount', String(g.length));
    sr.setAttribute('BindingLocation', String(leftCount));
  }
  // Spreads left with no pages go.
  for (let i = groups.length; i < spreadRoots.length; i++) {
    const ref = kids(root, 'idPkg:Spread')[groups.length];
    const src = ref?.getAttribute('src');
    if (ref) ref.remove();
    if (src) d.remove(src);
  }
  renumberPages(d, plan.map((p) => p.page));
}

function boundsW(page: Element): number {
  const gb = (page.getAttribute('GeometricBounds') ?? '0 0 792 612').split(/\s+/).map(Number);
  return (gb[3] ?? 612) - (gb[1] ?? 0);
}

/** Page names follow the first section's numbering. */
function renumberPages(d: Draft, pages: Element[]) {
  const root = d.part('designmap.xml').documentElement;
  const sections = kids(root, 'Section');
  const first = sections[0];
  const start = first ? num(first.getAttribute('PageNumberStart'), 1) : 1;
  pages.forEach((p, i) => p.setAttribute('Name', String(start + i)));
  if (first) {
    first.setAttribute('Length', String(pages.length));
    if (pages[0]) first.setAttribute('PageStart', pages[0].getAttribute('Self') ?? '');
    for (const s of sections.slice(1)) s.remove();
  }
}

function currentPlan(d: Draft, model: Model): PagePlan[] {
  const plan: PagePlan[] = [];
  for (const s of model.spreads) {
    const by = itemsByPage(model, s);
    for (const p of s.pages) {
      const pe = findSelf(d.part(s.part), p.self);
      if (!pe) continue;
      plan.push({
        page: pe,
        // Page to spread, before the spread's own transform (what page items' transforms are relative to).
        old: mul(invert(s.m), p.m),
        items: (by.get(p.self) ?? []).map((it) => findSelf(d.part(s.part), it.self)).filter((e): e is Element => !!e),
      });
    }
  }
  return plan;
}

export function insertPages(d: Draft, model: Model, after: number, count: number, master: string | null) {
  const plan = currentPlan(d, model);
  const ref = plan[Math.max(0, Math.min(after, plan.length - 1))]?.page;
  const news: PagePlan[] = [];
  for (let i = 0; i < count; i++) {
    const p = ref ? (ref.cloneNode(false) as Element) : d.part('designmap.xml').createElement('Page');
    if (ref) for (const c of Array.from(ref.children)) if (c.localName !== 'Guide') p.appendChild(c.cloneNode(true));
    p.setAttribute('Self', d.newId());
    p.setAttribute('AppliedMaster', master ?? 'n');
    p.setAttribute('OverrideList', '');
    if (!p.getAttribute('GeometricBounds')) p.setAttribute('GeometricBounds', `0 0 ${fmtNum(model.prefs.pageH)} ${fmtNum(model.prefs.pageW)}`);
    news.push({ page: p, old: [1, 0, 0, 1, 0, 0], items: [] });
  }
  plan.splice(after + 1, 0, ...news);
  relayout(d, model, plan);
}

export function deletePages(d: Draft, model: Model, pages: Set<string>) {
  const plan = currentPlan(d, model);
  const keep = plan.filter((p) => !pages.has(p.page.getAttribute('Self') ?? ''));
  if (!keep.length) return false;
  const gone: Item[] = [];
  for (const s of model.spreads) {
    const by = itemsByPage(model, s);
    for (const p of s.pages) if (pages.has(p.self)) gone.push(...(by.get(p.self) ?? []));
  }
  deleteItems(d, model, gone);
  for (const p of plan) if (!keep.includes(p)) p.page.remove();
  relayout(
    d,
    model,
    keep.map((p) => ({ ...p, items: p.items.filter((e) => e.isConnected) })),
  );
  return true;
}

export function movePage(d: Draft, model: Model, from: number, to: number) {
  const plan = currentPlan(d, model);
  const [p] = plan.splice(from, 1);
  if (!p) return;
  plan.splice(Math.max(0, Math.min(plan.length, to)), 0, p);
  relayout(d, model, plan);
}

export function applyMaster(d: Draft, model: Model, pageSelves: string[], master: string | null) {
  for (const s of model.spreads) {
    for (const p of s.pages) {
      if (!pageSelves.includes(p.self)) continue;
      const pe = findSelf(d.part(s.part), p.self);
      if (pe) pe.setAttribute('AppliedMaster', master ?? 'n');
    }
  }
}

export function setMargins(d: Draft, page: Page, m: { top: number; bottom: number; left: number; right: number; columns: number; gutter: number }) {
  const pe = findSelf(d.part(page.part), page.self);
  if (!pe) return;
  let mp = child(pe, 'MarginPreference');
  if (!mp) {
    mp = pe.ownerDocument.createElement('MarginPreference');
    pe.appendChild(mp);
  }
  mp.setAttribute('Top', fmtNum(m.top));
  mp.setAttribute('Bottom', fmtNum(m.bottom));
  mp.setAttribute('Left', fmtNum(m.left));
  mp.setAttribute('Right', fmtNum(m.right));
  mp.setAttribute('ColumnCount', String(m.columns));
  mp.setAttribute('ColumnGutter', fmtNum(m.gutter));
  mp.removeAttribute('ColumnsPositions');
}

// ---- Layers and guides -----------------------------------------------------------------------------

export function addLayer(d: Draft, model: Model, name?: string): string {
  const dm = d.part('designmap.xml');
  const root = dm.documentElement;
  const self = d.newId();
  const layers = kids(root, 'Layer');
  let n = layers.length + 1;
  const names = new Set(model.layers.map((l) => l.name));
  while (names.has(`Layer ${n}`)) n++;
  const e = el(dm, 'Layer', {
    Self: self,
    Name: name ?? `Layer ${n}`,
    Visible: 'true',
    Locked: 'false',
    IgnoreWrap: 'false',
    ShowGuides: 'true',
    LockGuides: 'false',
    UI: 'true',
    Expendable: 'true',
    Printable: 'true',
  });
  const color = el(dm, 'LayerColor', { type: 'enumeration' });
  color.textContent = layerColorName(layers.length);
  e.appendChild(el(dm, 'Properties', {}, [color]));
  // New layers go on top, which is first in the designmap.
  if (layers[0]) layers[0].before(e);
  else root.appendChild(e);
  root.setAttribute('ActiveLayer', self);
  return self;
}

export function setLayer(d: Draft, self: string, attrs: Record<string, string>) {
  const e = kids(d.part('designmap.xml').documentElement, 'Layer').find((l) => l.getAttribute('Self') === self);
  if (e) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
}

export function deleteLayer(d: Draft, model: Model, self: string) {
  const items: Item[] = [];
  for (const s of [...model.spreads, ...model.masters]) for (const it of s.items) if (it.layer === self) items.push(it);
  deleteItems(d, model, items);
  const root = d.part('designmap.xml').documentElement;
  kids(root, 'Layer')
    .find((l) => l.getAttribute('Self') === self)
    ?.remove();
  if (root.getAttribute('ActiveLayer') === self) root.setAttribute('ActiveLayer', kids(root, 'Layer')[0]?.getAttribute('Self') ?? 'n');
  for (const s of [...model.spreads, ...model.masters]) {
    for (const g of all(d.part(s.part).documentElement, 'Guide')) if (g.getAttribute('ItemLayer') === self) g.remove();
  }
}

export function moveLayer(d: Draft, self: string, toIndex: number) {
  const root = d.part('designmap.xml').documentElement;
  const layers = kids(root, 'Layer');
  const e = layers.find((l) => l.getAttribute('Self') === self);
  if (!e) return;
  const rest = layers.filter((l) => l !== e);
  const target = rest[toIndex];
  if (target) target.before(e);
  else rest[rest.length - 1]?.after(e);
}

export function addGuide(d: Draft, s: Spread, page: Page | null, vertical: boolean, at: number, layer: string) {
  const doc = d.part(s.part);
  const color = el(doc, 'GuideColor', { type: 'enumeration' });
  color.textContent = 'Cyan';
  const g = el(doc, 'Guide', {
    Self: d.newId(),
    Orientation: vertical ? 'Vertical' : 'Horizontal',
    Location: fmtNum(at),
    FitToPage: page ? 'true' : 'false',
    ViewThreshold: '5',
    ItemLayer: layer,
    Locked: 'false',
  });
  g.appendChild(el(doc, 'Properties', {}, [color]));
  if (page) {
    const pe = findSelf(doc, page.self);
    // Guides come before the page's margin settings.
    const mp = pe && child(pe, 'MarginPreference');
    if (mp) mp.before(g);
    else pe?.appendChild(g);
  } else {
    const root = partRoot(doc)!;
    const pages = kids(root, 'Page');
    if (pages.length) pages[pages.length - 1].after(g);
    else root.appendChild(g);
  }
}

export function moveGuide(d: Draft, s: Spread, self: string, at: number | null) {
  const g = findSelf(d.part(s.part), self);
  if (!g) return;
  if (at === null) g.remove();
  else g.setAttribute('Location', fmtNum(at));
}

/** A rectangle in pasteboard coordinates to a spread's own. */
export function rectToSpread(s: Spread, r: Rect): Rect {
  const a = toSpreadLocal(s, { x: r.x, y: r.y });
  const b = toSpreadLocal(s, { x: r.x + r.w, y: r.y + r.h });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// ---- Appearance, swatches, styles ---------------------------------------------------------------

/** Puts a preference child (TransparencySetting...) where InDesign keeps it: before nested items. */
function prefChild(e: Element, name: string): Element {
  let c = child(e, name);
  if (c) return c;
  c = e.ownerDocument.createElement(name);
  const firstItem = Array.from(e.children).find((x) => isItemTag(x.localName));
  if (firstItem) firstItem.before(c);
  else e.appendChild(c);
  return c;
}

export function setOpacity(d: Draft, it: Item, pct: number) {
  const e = itemEl(d, it);
  if (!e) return;
  const ts = prefChild(e, 'TransparencySetting');
  let bs = child(ts, 'BlendingSetting');
  if (!bs) {
    bs = e.ownerDocument.createElement('BlendingSetting');
    ts.insertBefore(bs, ts.firstChild);
  }
  bs.setAttribute('Opacity', fmtNum(Math.max(0, Math.min(100, pct))));
}

export function graphicPart(model: Model): string {
  const root = model.pkg.xml.get('designmap.xml')!.documentElement;
  return kids(root, 'idPkg:Graphic')[0]?.getAttribute('src') ?? 'Resources/Graphic.xml';
}

export function stylesPart(model: Model): string {
  const root = model.pkg.xml.get('designmap.xml')!.documentElement;
  return kids(root, 'idPkg:Styles')[0]?.getAttribute('src') ?? 'Resources/Styles.xml';
}

/** A color: named (a swatch) or not (applied straight from the Color panel). */
export function addColor(d: Draft, model: Model, name: string | null, space: 'CMYK' | 'RGB', values: number[]): string {
  const doc = d.part(graphicPart(model));
  const root = partRoot(doc) ?? doc.documentElement;
  const self = name ? `Color/${name}` : `Color/${d.newId()}`;
  let e = findSelf(doc, self);
  if (!e) {
    e = doc.createElement('Color');
    const colors = all(root, 'Color');
    if (colors.length) colors[colors.length - 1].after(e);
    else root.insertBefore(e, root.firstChild);
  }
  const attrs: Record<string, string> = {
    Self: self,
    Model: 'Process',
    Space: space,
    ColorValue: values.map((v) => fmtNum(Math.round(v * 1000) / 1000)).join(' '),
    ColorOverride: 'Normal',
    AlternateSpace: 'NoAlternateColor',
    AlternateColorValue: '',
    Name: name ?? '$ID/',
    ColorEditable: 'true',
    ColorRemovable: 'true',
    Visible: name ? 'true' : 'false',
    SwatchCreatorID: '7937',
  };
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return self;
}

export function editColor(d: Draft, model: Model, self: string, space: 'CMYK' | 'RGB', values: number[], name?: string) {
  const doc = d.part(graphicPart(model));
  const e = findSelf(doc, self);
  if (!e) return;
  e.setAttribute('Space', space);
  e.setAttribute('ColorValue', values.map((v) => fmtNum(Math.round(v * 1000) / 1000)).join(' '));
  if (name) e.setAttribute('Name', name);
}

export function deleteSwatch(d: Draft, model: Model, self: string) {
  const doc = d.part(graphicPart(model));
  findSelf(doc, self)?.remove();
}

/** A new paragraph or character style, based on another, taking a range's own settings. */
export function newStyle(d: Draft, model: Model, kind: 'ParagraphStyle' | 'CharacterStyle', basedOn: string | null, from: Element | null): string {
  const doc = d.part(stylesPart(model));
  const root = partRoot(doc) ?? doc.documentElement;
  const group = all(root, kind === 'ParagraphStyle' ? 'RootParagraphStyleGroup' : 'RootCharacterStyleGroup')[0] ?? root;
  const existing = kind === 'ParagraphStyle' ? model.styles.para : model.styles.char;
  const label = kind === 'ParagraphStyle' ? 'Paragraph Style' : 'Character Style';
  let n = 1;
  while (existing.has(`${kind}/${label} ${n}`)) n++;
  const name = `${label} ${n}`;
  const self = `${kind}/${name}`;
  const e = el(doc, kind, { Self: self, Name: name, Imported: 'false' });
  if (from) {
    for (const a of Array.from(from.attributes)) {
      if (a.name === 'AppliedParagraphStyle' || a.name === 'AppliedCharacterStyle' || a.name === 'Self') continue;
      e.setAttribute(a.name, a.value);
    }
    const fp = child(from, 'Properties');
    if (fp) e.appendChild(doc.importNode(fp, true));
  }
  if (basedOn) {
    const props = ensureProps(e);
    const b = el(doc, 'BasedOn', { type: 'object' });
    b.textContent = basedOn;
    props.insertBefore(b, props.firstChild);
  }
  group.appendChild(e);
  return self;
}

/** Page size for the whole document; items keep their place from each page's top left. */
export function setPageSize(d: Draft, model: Model, w: number, h: number) {
  const prefsSrc = kids(d.part('designmap.xml').documentElement, 'idPkg:Preferences')[0]?.getAttribute('src');
  if (prefsSrc && d.has(prefsSrc)) {
    const dp = all(d.part(prefsSrc).documentElement, 'DocumentPreference')[0];
    if (dp) {
      dp.setAttribute('PageWidth', fmtNum(w));
      dp.setAttribute('PageHeight', fmtNum(h));
    }
  }
  for (const s of [...model.spreads, ...model.masters]) {
    const doc = d.part(s.part);
    const lefts = s.pages.filter((p) => p.side === 'left').length;
    const by = s.isMaster ? null : itemsByPage(model, s);
    s.pages.forEach((p, i) => {
      const pe = findSelf(doc, p.self);
      if (!pe) return;
      pe.setAttribute('GeometricBounds', `0 0 ${fmtNum(h)} ${fmtNum(w)}`);
      const nm: Mat = [1, 0, 0, 1, (i - lefts) * w, -h / 2];
      pe.setAttribute('ItemTransform', fmtMat(nm));
      const oldTL = apply(mul(invert(s.m), p.m), { x: p.geom.x, y: p.geom.y });
      const delta = translate(nm[4] - oldTL.x, nm[5] - oldTL.y);
      for (const it of by?.get(p.self) ?? []) {
        const e = findSelf(doc, it.self);
        if (e) e.setAttribute('ItemTransform', fmtMat(mul(delta, it.local)));
      }
    });
  }
}


