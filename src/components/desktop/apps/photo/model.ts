import type { AdjustmentLayer, BlendMode, Layer as PsdLayer, LayerEffectsInfo, Psd } from 'ag-psd';

/**
 * Photo Editor's document: a stack of layers, bottom first (as in a PSD).
 * Documents are immutable. An edit makes a new Doc that shares every layer
 * it didn't touch, and a layer whose pixels change gets a new canvas, so
 * each history state is a cheap snapshot.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layer mask: grayscale, white shows the layer and black hides it. */
export interface Mask {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  /** The value everywhere outside the canvas: 0 or 255. */
  defaultColor: number;
  disabled: boolean;
}

/** What a type layer says and how, for the Type tool to re-render it. */
export interface TextData {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Where the first line's baseline starts (its left end, for left-aligned text). */
  x: number;
  y: number;
}

/**
 * Smart objects and shape layers draw from the pixels Photoshop stored;
 * painting on one (or on type) rasterizes it into a plain pixel layer.
 */
export type LayerKind = 'pixel' | 'group' | 'adjustment' | 'text' | 'smart' | 'shape';

export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  /** Pixels, positioned at left/top. Groups and adjustment layers have none. */
  canvas: HTMLCanvasElement | null;
  left: number;
  top: number;
  /** 0-1. */
  opacity: number;
  /** 0-1: like opacity, but leaves layer effects alone. */
  fill: number;
  blendMode: BlendMode;
  hidden: boolean;
  clipping: boolean;
  locked: boolean;
  lockAlpha: boolean;
  mask: Mask | null;
  /** A shape's outline as Photoshop rasterized it: drawn, but not editable. */
  vectorMask: Mask | null;
  /** A group's layers, bottom first. */
  children: Layer[];
  open: boolean;
  adjustment: AdjustmentLayer | null;
  text: TextData | null;
  /** The text changed here, so Photoshop should re-render it. */
  textEdited: boolean;
  effects: LayerEffectsInfo | null;
  /** The layer as it was read from a PSD, minus its pixels: everything we don't edit rides along. */
  source: PsdLayer | null;
  /** The canvas as read, to tell whether the pixels changed since. */
  sourceCanvas: HTMLCanvasElement | null;
}

export interface Doc {
  width: number;
  height: number;
  layers: Layer[];
  /** The PSD it was read from, minus pixels and layers, so saving keeps what we don't edit. */
  source: Psd | null;
}

let nextId = 1;
export const newId = () => nextId++;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: false })!;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function blankLayer(name: string, doc: { width: number; height: number }, props: Partial<Layer> = {}): Layer {
  return {
    id: newId(),
    name,
    kind: 'pixel',
    canvas: makeCanvas(doc.width, doc.height),
    left: 0,
    top: 0,
    opacity: 1,
    fill: 1,
    blendMode: 'normal',
    hidden: false,
    clipping: false,
    locked: false,
    lockAlpha: false,
    mask: null,
    vectorMask: null,
    children: [],
    open: true,
    adjustment: null,
    text: null,
    textEdited: false,
    effects: null,
    source: null,
    sourceCanvas: null,
    ...props,
  };
}

export function groupLayer(name: string, children: Layer[], props: Partial<Layer> = {}): Layer {
  return blankLayer(name, { width: 1, height: 1 }, {
    kind: 'group',
    canvas: null,
    blendMode: 'pass through',
    children,
    ...props,
  });
}

export function newDoc(width: number, height: number, background: string | null): Doc {
  const bg = blankLayer(background ? 'Background' : 'Layer 1', { width, height });
  if (background) {
    const c = ctx2d(bg.canvas!);
    c.fillStyle = background;
    c.fillRect(0, 0, width, height);
  }
  return { width, height, layers: [bg], source: null };
}

// ---- Tree helpers ------------------------------------------------------------

export function findLayer(layers: Layer[], id: number): Layer | null {
  for (const l of layers) {
    if (l.id === id) return l;
    const found = findLayer(l.children, id);
    if (found) return found;
  }
  return null;
}

/** The list a layer is in, and where. */
export function findPlace(layers: Layer[], id: number, parent: Layer | null = null): { list: Layer[]; index: number; parent: Layer | null } | null {
  const index = layers.findIndex((l) => l.id === id);
  if (index !== -1) return { list: layers, index, parent };
  for (const l of layers) {
    const found = findPlace(l.children, id, l);
    if (found) return found;
  }
  return null;
}

export function updateLayer(layers: Layer[], id: number, fn: (l: Layer) => Layer): Layer[] {
  let changed = false;
  const out = layers.map((l) => {
    if (l.id === id) {
      changed = true;
      return fn(l);
    }
    if (l.children.length) {
      const children = updateLayer(l.children, id, fn);
      if (children !== l.children) {
        changed = true;
        return { ...l, children };
      }
    }
    return l;
  });
  return changed ? out : layers;
}

/** Replace the list that holds `id` (the top level when id is null). */
export function updateList(layers: Layer[], parentId: number | null, fn: (list: Layer[]) => Layer[]): Layer[] {
  if (parentId === null) return fn(layers);
  return updateLayer(layers, parentId, (g) => ({ ...g, children: fn(g.children) }));
}

export function removeLayers(layers: Layer[], ids: Set<number>): Layer[] {
  return layers
    .filter((l) => !ids.has(l.id))
    .map((l) => (l.children.length ? { ...l, children: removeLayers(l.children, ids) } : l));
}

/** Every layer, depth first, top of the stack first (the Layers panel's order). */
export function walkTopDown(layers: Layer[], depth = 0, out: { layer: Layer; depth: number }[] = []) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    out.push({ layer: l, depth });
    if (l.kind === 'group') walkTopDown(l.children, depth + 1, out);
  }
  return out;
}

export function allLayers(layers: Layer[]): Layer[] {
  return walkTopDown(layers).map((e) => e.layer);
}

/** Whether a layer is hidden itself or inside a hidden group. */
export function isEffectivelyHidden(layers: Layer[], id: number): boolean {
  const place = findPlace(layers, id);
  if (!place) return true;
  if (place.list[place.index].hidden) return true;
  return place.parent ? isEffectivelyHidden(layers, place.parent.id) : false;
}

export function layerRect(l: Layer): Rect | null {
  return l.canvas ? { x: l.left, y: l.top, w: l.canvas.width, h: l.canvas.height } : null;
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * The layer's canvas grown (as a copy) to cover `rect` as well, for painting
 * that reaches past its edges. Returns a fresh canvas either way, so the
 * caller can draw on it without touching history.
 */
export function workingCanvas(l: Layer, rect: Rect): { canvas: HTMLCanvasElement; left: number; top: number } {
  const own = layerRect(l);
  const r = own ? union(own, rect) : rect;
  const canvas = makeCanvas(r.w, r.h);
  if (l.canvas) ctx2d(canvas).drawImage(l.canvas, l.left - r.x, l.top - r.y);
  return { canvas, left: r.x, top: r.y };
}

/** Same for a mask, grown with its default color. */
export function workingMask(m: Mask, rect: Rect): Mask {
  const own = { x: m.left, y: m.top, w: m.canvas.width, h: m.canvas.height };
  const r = union(own, rect);
  const canvas = makeCanvas(r.w, r.h);
  const c = ctx2d(canvas);
  c.fillStyle = `rgb(${m.defaultColor},${m.defaultColor},${m.defaultColor})`;
  c.fillRect(0, 0, r.w, r.h);
  c.clearRect(m.left - r.x, m.top - r.y, m.canvas.width, m.canvas.height);
  c.drawImage(m.canvas, m.left - r.x, m.top - r.y);
  return { ...m, canvas, left: r.x, top: r.y };
}

export function solidMask(doc: { width: number; height: number }, value: number): Mask {
  const canvas = makeCanvas(doc.width, doc.height);
  const c = ctx2d(canvas);
  c.fillStyle = `rgb(${value},${value},${value})`;
  c.fillRect(0, 0, doc.width, doc.height);
  return { canvas, left: 0, top: 0, defaultColor: value, disabled: false };
}

/** The bounding box of a canvas's non-transparent pixels, or null if it's empty. */
export function opaqueBounds(c: HTMLCanvasElement): Rect | null {
  const { width: w, height: h } = c;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A name not yet used: "Layer 3", "Layer 1 copy 2". */
export function freshName(layers: Layer[], base: string): string {
  const names = new Set(allLayers(layers).map((l) => l.name));
  if (base === 'Layer' || base === 'Group') {
    let n = 1;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** A deep copy of a layer with new ids and its own canvases. */
export function duplicateLayer(l: Layer, name?: string): Layer {
  return {
    ...l,
    id: newId(),
    name: name ?? l.name,
    canvas: l.canvas ? cloneCanvas(l.canvas) : null,
    mask: l.mask ? { ...l.mask, canvas: cloneCanvas(l.mask.canvas) } : null,
    children: l.children.map((c) => duplicateLayer(c)),
  };
}

/** Rough memory a set of history states holds, counting shared canvases once. */
export function canvasBytes(docs: Doc[]): number {
  const seen = new Set<HTMLCanvasElement>();
  let bytes = 0;
  const add = (c: HTMLCanvasElement | null | undefined) => {
    if (c && !seen.has(c)) {
      seen.add(c);
      bytes += c.width * c.height * 4;
    }
  };
  for (const d of docs) {
    for (const l of allLayers(d.layers)) {
      add(l.canvas);
      add(l.mask?.canvas);
      add(l.vectorMask?.canvas);
    }
  }
  return bytes;
}
