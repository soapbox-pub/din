import type { AdjustmentLayer } from 'ag-psd';
import { adjustCanvas, applyFilter, type FilterSpec } from './adjust';
import {
  blankLayer,
  cloneCanvas,
  ctx2d,
  duplicateLayer,
  findLayer,
  findPlace,
  freshName,
  groupLayer,
  makeCanvas,
  opaqueBounds,
  removeLayers,
  solidMask,
  updateLayer,
  updateList,
  walkTopDown,
  workingCanvas,
  workingMask,
  type Doc,
  type Layer,
  type Mask,
  type Rect,
  type TextData,
} from './model';
import { renderLayerAlone, renderLayers } from './render';
import type { Selection } from './selection';

/**
 * Edits to a document, as pure functions: each takes a Doc and returns a
 * new one. The editor turns each into a history state.
 */

export interface Result {
  doc: Doc;
  activeId?: number;
  selection?: Selection | null;
}

const docRect = (doc: Doc): Rect => ({ x: 0, y: 0, w: doc.width, h: doc.height });

/** Put `layer` just above `aboveId` in its list (or on top when there isn't one). */
export function insertAbove(doc: Doc, aboveId: number | null, layer: Layer): Doc {
  const place = aboveId !== null ? findPlace(doc.layers, aboveId) : null;
  if (!place) return { ...doc, layers: [...doc.layers, layer] };
  const parentId = place.parent?.id ?? null;
  // Clipped layers stay a clipping stack: something put inside it is clipped too.
  const above = place.list[place.index + 1];
  const l = above?.clipping ? { ...layer, clipping: true } : layer;
  return {
    ...doc,
    layers: updateList(doc.layers, parentId, (list) => [...list.slice(0, place.index + 1), l, ...list.slice(place.index + 1)]),
  };
}

export function addLayer(doc: Doc, activeId: number | null, props: Partial<Layer> = {}): Result {
  const layer = blankLayer(freshName(doc.layers, 'Layer'), doc, props);
  return { doc: insertAbove(doc, activeId, layer), activeId: layer.id };
}

export function deleteLayers(doc: Doc, ids: Set<number>, activeId: number | null): Result {
  const order = walkTopDown(doc.layers).map((e) => e.layer.id);
  const layers = removeLayers(doc.layers, ids);
  if (layers.length === 0) return { doc };
  // Select the layer that was below the active one, as Photoshop does.
  const at = activeId !== null ? order.indexOf(activeId) : -1;
  const remaining = new Set(walkTopDown(layers).map((e) => e.layer.id));
  const next = order.slice(at + 1).find((id) => remaining.has(id)) ?? [...order].reverse().find((id) => remaining.has(id));
  return { doc: { ...doc, layers }, activeId: next };
}

export function duplicate(doc: Doc, id: number): Result {
  const l = findLayer(doc.layers, id);
  if (!l) return { doc };
  const copy = duplicateLayer(l, freshName(doc.layers, `${l.name} copy`));
  return { doc: insertAbove(doc, id, copy), activeId: copy.id };
}

export function arrange(doc: Doc, id: number, how: 'front' | 'forward' | 'backward' | 'back'): Doc {
  const place = findPlace(doc.layers, id);
  if (!place) return doc;
  const { list, index } = place;
  const target = how === 'front' ? list.length - 1 : how === 'back' ? 0 : how === 'forward' ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1);
  if (target === index) return doc;
  return { ...doc, layers: updateList(doc.layers, place.parent?.id ?? null, (l) => moveWithin(l, index, target)) };
}

function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Drag-and-drop in the Layers panel: put `id` into `parentId`'s list at `index`. */
export function moveTo(doc: Doc, id: number, parentId: number | null, index: number): Doc {
  const l = findLayer(doc.layers, id);
  if (!l) return doc;
  // A group can't go inside itself.
  if (parentId !== null && (parentId === id || findLayer(l.children, parentId))) return doc;
  const place = findPlace(doc.layers, id)!;
  let at = index;
  if ((place.parent?.id ?? null) === parentId && place.index < index) at--;
  const without = removeLayers(doc.layers, new Set([id]));
  return { ...doc, layers: updateList(without, parentId, (list) => [...list.slice(0, at), l, ...list.slice(at)]) };
}

/** Ctrl+G: put the layers in a new group, where the topmost of them was. */
export function group(doc: Doc, ids: number[]): Result {
  if (ids.length === 0) return { doc };
  const order = walkTopDown(doc.layers).map((e) => e.layer.id);
  const sorted = [...ids].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  const members = sorted.map((id) => findLayer(doc.layers, id)).filter((l): l is Layer => !!l);
  const topPlace = findPlace(doc.layers, sorted[sorted.length - 1])!;
  const g = groupLayer(freshName(doc.layers, 'Group'), members, { open: true });
  // Mark where the group goes, then lift the members out.
  const marker = blankLayer('', { width: 1, height: 1 });
  let layers = updateList(doc.layers, topPlace.parent?.id ?? null, (list) => [
    ...list.slice(0, topPlace.index + 1),
    marker,
    ...list.slice(topPlace.index + 1),
  ]);
  layers = removeLayers(layers, new Set(ids));
  const markerPlace = findPlace(layers, marker.id)!;
  layers = updateList(layers, markerPlace.parent?.id ?? null, (list) => list.map((l) => (l.id === marker.id ? g : l)));
  return { doc: { ...doc, layers }, activeId: g.id };
}

export function ungroup(doc: Doc, id: number): Result {
  const place = findPlace(doc.layers, id);
  const g = place?.list[place.index];
  if (!place || !g || g.kind !== 'group') return { doc };
  const layers = updateList(doc.layers, place.parent?.id ?? null, (list) => [
    ...list.slice(0, place.index),
    ...g.children,
    ...list.slice(place.index + 1),
  ]);
  return { doc: { ...doc, layers }, activeId: g.children[g.children.length - 1]?.id };
}

/** Bake a type, shape or smart-object layer into plain pixels. */
export function rasterize(doc: Doc, id: number): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      if (l.kind === 'pixel' || l.kind === 'group' || l.kind === 'adjustment') return l;
      let canvas = l.canvas;
      let left = l.left;
      let top = l.top;
      if (l.vectorMask && canvas) {
        const full = renderLayerAlone({ ...l, mask: null, effects: null, opacity: 1, fill: 1, blendMode: 'normal' }, doc.width, doc.height);
        canvas = full;
        left = 0;
        top = 0;
      }
      return { ...l, kind: 'pixel', canvas, left, top, vectorMask: null, text: null };
    }),
  };
}

/** Merge a layer into the one below it (Ctrl+E). */
export function mergeDown(doc: Doc, id: number): Result {
  const place = findPlace(doc.layers, id);
  if (!place || place.index === 0) return { doc };
  const upper = place.list[place.index];
  const lower = place.list[place.index - 1];
  if (lower.kind === 'adjustment' || lower.kind === 'group') return { doc };
  const merged = renderLayers(
    [
      { ...lower, opacity: 1, blendMode: 'normal', clipping: false, hidden: false },
      { ...upper, clipping: upper.clipping },
    ],
    doc.width,
    doc.height,
  );
  const result: Layer = { ...lower, kind: 'pixel', canvas: merged, left: 0, top: 0, mask: null, vectorMask: null, effects: null, text: null, fill: 1 };
  const layers = updateList(doc.layers, place.parent?.id ?? null, (list) => [
    ...list.slice(0, place.index - 1),
    result,
    ...list.slice(place.index + 1),
  ]);
  return { doc: { ...doc, layers }, activeId: result.id };
}

/** Merge several layers into one, where the topmost was. */
export function mergeLayers(doc: Doc, ids: number[], name?: string): Result {
  const order = walkTopDown(doc.layers).map((e) => e.layer.id);
  const sorted = [...ids].sort((a, b) => order.indexOf(b) - order.indexOf(a));
  const members = sorted.map((i) => findLayer(doc.layers, i)).filter((l): l is Layer => !!l);
  if (members.length < 2) return members.length === 1 ? mergeDown(doc, members[0].id) : { doc };
  const canvas = renderLayers(members, doc.width, doc.height);
  const top = members[members.length - 1];
  const merged = blankLayer(name ?? top.name, doc, { canvas });
  const r = group(doc, sorted);
  const layers = updateLayer(r.doc.layers, r.activeId!, () => merged);
  return { doc: { ...doc, layers }, activeId: merged.id };
}

export function mergeVisible(doc: Doc): Result {
  const canvas = renderLayers(doc.layers, doc.width, doc.height);
  const hidden = doc.layers.filter((l) => l.hidden);
  const merged = blankLayer('Merged', doc, { canvas });
  return { doc: { ...doc, layers: [merged, ...hidden] }, activeId: merged.id };
}

export function flattenImage(doc: Doc): Result {
  const canvas = makeCanvas(doc.width, doc.height);
  const c = ctx2d(canvas);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, doc.width, doc.height);
  c.drawImage(renderLayers(doc.layers, doc.width, doc.height), 0, 0);
  const bg = blankLayer('Background', doc, { canvas });
  return { doc: { ...doc, layers: [bg] }, activeId: bg.id };
}

// ---- Masks -----------------------------------------------------------------------

export function addMask(doc: Doc, id: number, how: 'reveal' | 'hide' | 'selection', sel: Selection | null): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      let mask: Mask;
      if (how === 'selection' && sel) {
        mask = solidMask(doc, 0);
        const c = ctx2d(mask.canvas);
        c.drawImage(sel.mask, 0, 0);
      } else {
        mask = solidMask(doc, how === 'hide' ? 0 : 255);
      }
      return { ...l, mask };
    }),
  };
}

export function deleteMask(doc: Doc, id: number, apply: boolean): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      if (!apply || !l.mask || !l.canvas) return { ...l, mask: null };
      const full = renderLayerAlone({ ...l, effects: null, opacity: 1, fill: 1, blendMode: 'normal', vectorMask: null }, doc.width, doc.height);
      return { ...l, mask: null, canvas: full, left: 0, top: 0 };
    }),
  };
}

// ---- Pixels ----------------------------------------------------------------------

/** What pixel edits land on: a layer's pixels, or its mask. */
export type Target = 'pixels' | 'mask';

export interface Surface {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
}

/** A fresh doc-covering copy of what's being edited. */
export function workingSurface(l: Layer, target: Target, doc: Doc): Surface {
  if (target === 'mask' && l.mask) {
    const m = workingMask(l.mask, docRect(doc));
    return { canvas: m.canvas, left: m.left, top: m.top };
  }
  return workingCanvas(l, docRect(doc));
}

export function withSurface(l: Layer, target: Target, s: Surface): Layer {
  if (target === 'mask' && l.mask) return { ...l, mask: { ...l.mask, canvas: s.canvas, left: s.left, top: s.top } };
  return { ...l, canvas: s.canvas, left: s.left, top: s.top };
}

/**
 * Blend `edited` (the surface after an edit) with `original` through the
 * selection: unselected pixels keep their old values, partly selected ones mix.
 */
export function throughSelection(original: Surface, edited: HTMLCanvasElement, sel: Selection | null, lockAlpha = false): HTMLCanvasElement {
  let result = edited;
  if (lockAlpha) {
    result = makeCanvas(edited.width, edited.height);
    const r = ctx2d(result);
    r.drawImage(edited, 0, 0);
    r.globalCompositeOperation = 'destination-in';
    r.drawImage(original.canvas, 0, 0);
  }
  if (!sel) return result;
  const out = makeCanvas(original.canvas.width, original.canvas.height);
  const o = ctx2d(out);
  o.drawImage(original.canvas, 0, 0);
  o.globalCompositeOperation = 'destination-out';
  o.drawImage(sel.mask, -original.left, -original.top);
  const inside = makeCanvas(out.width, out.height);
  const i = ctx2d(inside);
  i.drawImage(result, 0, 0);
  i.globalCompositeOperation = 'destination-in';
  i.drawImage(sel.mask, -original.left, -original.top);
  o.globalCompositeOperation = 'lighter';
  o.drawImage(inside, 0, 0);
  return out;
}

/** Run an edit on the active layer's pixels or mask, within the selection. */
export function editPixels(doc: Doc, id: number, target: Target, sel: Selection | null, fn: (s: Surface) => HTMLCanvasElement): Doc {
  const l = findLayer(doc.layers, id);
  if (!l || (target === 'pixels' && l.kind !== 'pixel') || (target === 'mask' && !l.mask)) return doc;
  const s = workingSurface(l, target, doc);
  const edited = fn(s);
  const canvas = throughSelection(s, edited, sel, target === 'pixels' && l.lockAlpha);
  return { ...doc, layers: updateLayer(doc.layers, id, (x) => withSurface(x, target, { ...s, canvas })) };
}

/** Mask colors are gray: the brightness of a color. */
export function grayOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const v = Math.round(0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255));
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

export function fill(doc: Doc, id: number, target: Target, sel: Selection | null, color: string, opacity = 1): Doc {
  return editPixels(doc, id, target, sel, (s) => {
    const out = cloneCanvas(s.canvas);
    const c = ctx2d(out);
    c.globalAlpha = opacity;
    c.fillStyle = target === 'mask' ? grayOf(color) : color;
    c.fillRect(0, 0, out.width, out.height);
    return out;
  });
}

/** Delete: clear the selection to transparency (or, on a mask, to black). */
export function clear(doc: Doc, id: number, target: Target, sel: Selection | null, bg: string): Doc {
  const l = findLayer(doc.layers, id);
  if (target === 'mask') return fill(doc, id, target, sel, '#000000');
  // Backgrounds and locked transparency fill with the background color instead.
  if (l?.lockAlpha) return fill(doc, id, target, sel, bg);
  return editPixels(doc, id, target, sel, (s) => makeCanvas(s.canvas.width, s.canvas.height));
}

export function filterLayer(doc: Doc, id: number, target: Target, sel: Selection | null, f: FilterSpec): Doc {
  return editPixels(doc, id, target, sel, (s) => applyFilter(s.canvas, f));
}

export function adjustLayer(doc: Doc, id: number, target: Target, sel: Selection | null, adj: AdjustmentLayer): Doc {
  return editPixels(doc, id, target, sel, (s) => adjustCanvas(s.canvas, adj));
}

/** The selected part of a layer (or all of it), cropped to the selection's bounds. */
export function copyPixels(doc: Doc, id: number, sel: Selection | null, merged: boolean): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const l = findLayer(doc.layers, id);
  const src = merged ? renderLayers(doc.layers, doc.width, doc.height) : l ? renderLayerAlone({ ...l, opacity: 1, effects: null }, doc.width, doc.height) : null;
  if (!src) return null;
  const box = sel?.bounds ?? opaqueBounds(src) ?? docRect(doc);
  const out = makeCanvas(box.w, box.h);
  const c = ctx2d(out);
  c.drawImage(src, -box.x, -box.y);
  if (sel) {
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(sel.mask, -box.x, -box.y);
  }
  return { canvas: out, x: box.x, y: box.y };
}

/** Ctrl+J / Shift+Ctrl+J: the selected pixels onto a new layer, copied or cut. */
export function layerVia(doc: Doc, id: number, sel: Selection | null, cut: boolean): Result {
  if (!sel) return duplicate(doc, id);
  const l = findLayer(doc.layers, id);
  if (!l || l.kind !== 'pixel') return { doc };
  const piece = copyPixels(doc, id, sel, false);
  if (!piece) return { doc };
  let d = doc;
  if (cut) d = editPixels(doc, id, 'pixels', sel, (s) => makeCanvas(s.canvas.width, s.canvas.height));
  const layer = blankLayer(freshName(d.layers, 'Layer'), d, { canvas: piece.canvas, left: piece.x, top: piece.y });
  return { doc: insertAbove(d, id, layer), activeId: layer.id, selection: null };
}

// ---- The whole canvas ---------------------------------------------------------------

function mapAll(layers: Layer[], fn: (l: Layer) => Layer): Layer[] {
  return layers.map((l) => fn(l.children.length ? { ...l, children: mapAll(l.children, fn) } : l));
}

function moveMask(m: Mask | null, dx: number, dy: number): Mask | null {
  return m ? { ...m, left: m.left + dx, top: m.top + dy } : null;
}

/** Shift every layer and mask; for crops and canvas resizes. */
function offsetAll(layers: Layer[], dx: number, dy: number): Layer[] {
  return mapAll(layers, (l) => ({
    ...l,
    left: l.left + dx,
    top: l.top + dy,
    mask: moveMask(l.mask, dx, dy),
    vectorMask: moveMask(l.vectorMask, dx, dy),
    text: l.text ? { ...l.text, x: l.text.x + dx, y: l.text.y + dy } : null,
  }));
}

export function crop(doc: Doc, r: Rect): Doc {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  return { ...doc, width: w, height: h, layers: offsetAll(doc.layers, -x, -y) };
}

export function canvasSize(doc: Doc, w: number, h: number, anchor: [number, number], fillColor: string | null): Doc {
  const dx = Math.round((w - doc.width) * anchor[0]);
  const dy = Math.round((h - doc.height) * anchor[1]);
  let layers = offsetAll(doc.layers, dx, dy);
  // The Background grows with the canvas, filled with the background color.
  const bottom = layers[0];
  if (fillColor && bottom?.name === 'Background' && bottom.kind === 'pixel' && bottom.canvas) {
    const canvas = makeCanvas(w, h);
    const c = ctx2d(canvas);
    c.fillStyle = fillColor;
    c.fillRect(0, 0, w, h);
    c.drawImage(bottom.canvas, bottom.left, bottom.top);
    layers = [{ ...bottom, canvas, left: 0, top: 0 }, ...layers.slice(1)];
  }
  return { ...doc, width: w, height: h, layers };
}

function scaleCanvas(src: HTMLCanvasElement, sx: number, sy: number, smooth: boolean): HTMLCanvasElement {
  const out = makeCanvas(src.width * sx, src.height * sy);
  const c = ctx2d(out);
  c.imageSmoothingEnabled = smooth;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

export function imageSize(doc: Doc, w: number, h: number, smooth: boolean): Doc {
  const sx = w / doc.width;
  const sy = h / doc.height;
  const scaleMask = (m: Mask | null): Mask | null =>
    m ? { ...m, canvas: scaleCanvas(m.canvas, sx, sy, smooth), left: Math.round(m.left * sx), top: Math.round(m.top * sy) } : null;
  return {
    ...doc,
    width: w,
    height: h,
    layers: mapAll(doc.layers, (l) => ({
      ...l,
      canvas: l.canvas ? scaleCanvas(l.canvas, sx, sy, smooth) : null,
      left: Math.round(l.left * sx),
      top: Math.round(l.top * sy),
      mask: scaleMask(l.mask),
      vectorMask: scaleMask(l.vectorMask),
      text: l.text ? { ...l.text, x: l.text.x * sx, y: l.text.y * sy, size: l.text.size * sy } : null,
      // Shapes and smart objects are pixels now that their pixels are resampled.
      kind: l.kind === 'smart' || l.kind === 'shape' ? 'pixel' : l.kind,
    })),
  };
}

type Turn = 'cw' | 'ccw' | '180' | 'flipH' | 'flipV';

/** Turn or flip a canvas; returns where its top-left lands within a `w`×`h` frame. */
function turnCanvas(src: HTMLCanvasElement, left: number, top: number, w: number, h: number, how: Turn) {
  const sw = src.width;
  const sh = src.height;
  const quarter = how === 'cw' || how === 'ccw';
  const out = makeCanvas(quarter ? sh : sw, quarter ? sw : sh);
  const c = ctx2d(out);
  let nl = left;
  let nt = top;
  if (how === 'cw') {
    c.translate(sh, 0);
    c.rotate(Math.PI / 2);
    nl = h - top - sh;
    nt = left;
  } else if (how === 'ccw') {
    c.translate(0, sw);
    c.rotate(-Math.PI / 2);
    nl = top;
    nt = w - left - sw;
  } else if (how === '180') {
    c.translate(sw, sh);
    c.rotate(Math.PI);
    nl = w - left - sw;
    nt = h - top - sh;
  } else if (how === 'flipH') {
    c.translate(sw, 0);
    c.scale(-1, 1);
    nl = w - left - sw;
  } else {
    c.translate(0, sh);
    c.scale(1, -1);
    nt = h - top - sh;
  }
  c.drawImage(src, 0, 0);
  return { canvas: out, left: nl, top: nt };
}

function turnLayer(l: Layer, w: number, h: number, how: Turn): Layer {
  const t = (m: Mask | null): Mask | null => {
    if (!m) return null;
    const r = turnCanvas(m.canvas, m.left, m.top, w, h, how);
    return { ...m, canvas: r.canvas, left: r.left, top: r.top };
  };
  const px = l.canvas ? turnCanvas(l.canvas, l.left, l.top, w, h, how) : null;
  return {
    ...l,
    canvas: px?.canvas ?? null,
    left: px?.left ?? l.left,
    top: px?.top ?? l.top,
    mask: t(l.mask),
    vectorMask: t(l.vectorMask),
    kind: l.kind === 'smart' || l.kind === 'shape' || l.kind === 'text' ? 'pixel' : l.kind,
    text: null,
  };
}

/** Image > Image Rotation: the whole document. */
export function rotateCanvas(doc: Doc, how: Turn): Doc {
  const quarter = how === 'cw' || how === 'ccw';
  return {
    ...doc,
    width: quarter ? doc.height : doc.width,
    height: quarter ? doc.width : doc.height,
    layers: mapAll(doc.layers, (l) => (l.kind === 'group' ? l : turnLayer(l, doc.width, doc.height, how))),
  };
}

/** Edit > Transform: one layer, about its own middle. */
export function turnOne(doc: Doc, id: number, how: Turn): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      if (!l.canvas) return l;
      const b = { x: l.left, y: l.top, w: l.canvas.width, h: l.canvas.height };
      const r = turnCanvas(l.canvas, 0, 0, b.w, b.h, how);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return {
        ...l,
        canvas: r.canvas,
        left: Math.round(cx - r.canvas.width / 2),
        top: Math.round(cy - r.canvas.height / 2),
        kind: l.kind === 'group' || l.kind === 'adjustment' ? l.kind : 'pixel',
        text: null,
      };
    }),
  };
}

export function moveLayer(doc: Doc, id: number, dx: number, dy: number): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      const moved = (x: Layer): Layer => ({
        ...x,
        left: x.left + dx,
        top: x.top + dy,
        mask: moveMask(x.mask, dx, dy),
        vectorMask: moveMask(x.vectorMask, dx, dy),
        text: x.text ? { ...x.text, x: x.text.x + dx, y: x.text.y + dy } : null,
        children: x.children.map(moved),
      });
      return moved(l);
    }),
  };
}

// ---- Type --------------------------------------------------------------------------

export function cssFont(t: TextData): string {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size}px "${t.font}", sans-serif`;
}

/** Draw a type layer's text. */
export function renderText(t: TextData): Surface {
  const probe = ctx2d(makeCanvas(1, 1));
  probe.font = cssFont(t);
  const lines = t.text.split('\n');
  const lh = t.size * 1.2;
  const widths = lines.map((l) => probe.measureText(l || ' ').width);
  const maxW = Math.max(1, ...widths);
  const pad = Math.ceil(t.size * 0.5);
  const anchor = t.align === 'center' ? maxW / 2 : t.align === 'right' ? maxW : 0;
  const ascent = t.size;
  const w = Math.ceil(maxW + pad * 2);
  const h = Math.ceil(lh * (lines.length - 1) + ascent + t.size * 0.4 + pad * 2);
  const canvas = makeCanvas(w, h);
  const c = ctx2d(canvas);
  c.font = cssFont(t);
  c.fillStyle = t.color;
  c.textBaseline = 'alphabetic';
  c.textAlign = t.align;
  lines.forEach((line, i) => c.fillText(line, pad + anchor, pad + ascent + i * lh));
  return { canvas, left: Math.round(t.x - anchor - pad), top: Math.round(t.y - ascent - pad) };
}

export function textLayer(doc: Doc, t: TextData, props: Partial<Layer> = {}): Layer {
  const s = renderText(t);
  const name = t.text.split('\n')[0].slice(0, 30) || 'Text';
  return blankLayer(name, doc, { kind: 'text', text: t, textEdited: true, canvas: s.canvas, left: s.left, top: s.top, ...props });
}

export function setText(doc: Doc, id: number, t: TextData): Doc {
  return {
    ...doc,
    layers: updateLayer(doc.layers, id, (l) => {
      const s = renderText(t);
      const name = l.source || l.name !== (l.text?.text.split('\n')[0].slice(0, 30) || 'Text') ? l.name : t.text.split('\n')[0].slice(0, 30) || 'Text';
      return { ...l, text: t, textEdited: true, canvas: s.canvas, left: s.left, top: s.top, name };
    }),
  };
}
