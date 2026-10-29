import { divide, shapeMode, type ShapeMode } from './boolean';
import { boundsOf, itemBounds, splitSegment, transformItem, type TransformOptions } from './geom';
import {
  cloneItem,
  defaultStroke,
  findItem,
  mapItems,
  newId,
  newLayer,
  NONE,
  rectOfPoints,
  translate,
  type Doc,
  type GroupItem,
  type Item,
  type Layer,
  type Mat,
  type Node,
  type Paint,
  type PathItem,
  type Rect,
  type Stroke,
  type SubPath,
  walk,
} from './model';

/**
 * Edits to documents, as Illustrator's Object, Edit and Select menus make
 * them. Each takes a document and returns a new one.
 */

const KAPPA = 0.5522847498;

const corner = (x: number, y: number): Node => ({ x, y, ix: x, iy: y, ox: x, oy: y });

export function rectPath(x: number, y: number, w: number, h: number, r = 0): SubPath {
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return { closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] };
  const k = r * KAPPA;
  const n = (px: number, py: number, ix: number, iy: number, ox: number, oy: number): Node => ({ x: px, y: py, ix, iy, ox, oy });
  return {
    closed: true,
    nodes: [
      n(x + r, y, x + r - k, y, x + r, y),
      n(x + w - r, y, x + w - r, y, x + w - r + k, y),
      n(x + w, y + r, x + w, y + r - k, x + w, y + r),
      n(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k),
      n(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h),
      n(x + r, y + h, x + r, y + h, x + r - k, y + h),
      n(x, y + h - r, x, y + h - r + k, x, y + h - r),
      n(x, y + r, x, y + r, x, y + r - k),
    ],
  };
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    closed: true,
    nodes: [
      { x: cx, y: cy - ry, ix: cx - kx, iy: cy - ry, ox: cx + kx, oy: cy - ry },
      { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ky, ox: cx + rx, oy: cy + ky },
      { x: cx, y: cy + ry, ix: cx + kx, iy: cy + ry, ox: cx - kx, oy: cy + ry },
      { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ky, ox: cx - rx, oy: cy - ky },
    ],
  };
}

export function polygonPath(cx: number, cy: number, r: number, sides: number, angle = -Math.PI / 2): SubPath {
  const nodes: Node[] = [];
  for (let i = 0; i < sides; i++) {
    const a = angle + (i * 2 * Math.PI) / sides;
    nodes.push(corner(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return { closed: true, nodes };
}

export function starPath(cx: number, cy: number, r1: number, r2: number, points: number, angle = -Math.PI / 2): SubPath {
  const nodes: Node[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = angle + (i * Math.PI) / points;
    const r = i % 2 ? r2 : r1;
    nodes.push(corner(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return { closed: true, nodes };
}

export function linePath(x1: number, y1: number, x2: number, y2: number): SubPath {
  return { closed: false, nodes: [corner(x1, y1), corner(x2, y2)] };
}

export function pathItem(paths: SubPath[], fill: Paint, stroke: Stroke): PathItem {
  return { id: newId(), type: 'path', name: '', opacity: 1, blend: 'normal', paths, fill, stroke, evenOdd: false };
}

// ---- Where things are ---------------------------------------------------------------------

/** The object the Selection tool picks for an item: its outermost group within the layer. */
export function topLevel(doc: Doc, id: number): Item | null {
  const p = findItem(doc, id);
  if (!p) return null;
  return p.parents[0] ?? p.item;
}

/** The selected items, outermost first (an item inside a selected group is left out), in stacking order. */
export function selectedItems(doc: Doc, ids: Set<number>): Item[] {
  const out: Item[] = [];
  const visit = (items: Item[]) => {
    for (const it of items) {
      if (ids.has(it.id)) out.push(it);
      else if (it.type === 'group') visit(it.children);
    }
  };
  for (const l of doc.layers) visit(l.children);
  return out;
}

export function selectionBounds(doc: Doc, ids: Set<number>): Rect | null {
  const items = selectedItems(doc, ids);
  if (!items.length) return null;
  const b = boundsOf(items, doc.res);
  return Number.isFinite(b.x) ? b : null;
}

/** Leaves (paths, type, images) under the selection. */
export function leaves(items: Item[]): Item[] {
  const out: Item[] = [];
  const visit = (it: Item) => {
    if (it.type === 'group') it.children.forEach(visit);
    else out.push(it);
  };
  items.forEach(visit);
  return out;
}

// ---- Edits ---------------------------------------------------------------------------------

export function deleteItems(doc: Doc, ids: Set<number>): Doc {
  return mapItems(doc, (it) => (ids.has(it.id) ? null : undefined));
}

export function transformItems(doc: Doc, ids: Set<number>, m: Mat, opts?: TransformOptions): Doc {
  return mapItems(doc, (it) => (ids.has(it.id) ? transformItem(it, m, opts) : undefined));
}

/** Copies placed just above their originals (offset by `m`), returning their ids. */
export function duplicateItems(doc: Doc, ids: Set<number>, m?: Mat): { doc: Doc; ids: Set<number> } {
  const out = new Set<number>();
  const next = mapItems(doc, (it) => {
    if (!ids.has(it.id)) return undefined;
    let copy = cloneItem(it);
    if (m) copy = transformItem(copy, m);
    out.add(copy.id);
    return [it, copy];
  });
  return { doc: next, ids: out };
}

/** Add items on top of a layer. */
export function addItems(doc: Doc, layerId: number, items: Item[]): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? { ...l, children: [...l.children, ...items] } : l)) };
}

/** Group the selection where its topmost item is. */
export function group(doc: Doc, ids: Set<number>, clip = false): { doc: Doc; id: number } | null {
  const items = selectedItems(doc, ids);
  if (!items.length) return null;
  const top = items[items.length - 1];
  const g: GroupItem = { id: newId(), type: 'group', name: '', opacity: 1, blend: 'normal', clip, children: items };
  if (clip) {
    const c = items[items.length - 1];
    if (c.type !== 'path') return null;
    const clipPath: PathItem = { ...c, fill: NONE, stroke: { ...c.stroke, paint: NONE } };
    g.children = [clipPath, ...items.slice(0, -1)];
  }
  const set = new Set(items.map((i) => i.id));
  const next = mapItems(doc, (it) => (it.id === top.id ? g : set.has(it.id) ? null : undefined));
  return { doc: next, id: g.id };
}

export function ungroup(doc: Doc, ids: Set<number>): { doc: Doc; ids: Set<number> } {
  const out = new Set<number>();
  const next = mapItems(doc, (it) => {
    if (!ids.has(it.id)) return undefined;
    if (it.type !== 'group') {
      out.add(it.id);
      return undefined;
    }
    // A group's opacity passes to its children, as Illustrator's Ungroup does.
    const kids = (it.clip ? it.children.slice(1) : it.children).map((c) => (it.opacity < 1 ? { ...c, opacity: c.opacity * it.opacity } : c));
    if (it.clip && it.children[0]) kids.unshift(it.children[0]);
    kids.forEach((k) => out.add(k.id));
    return kids;
  });
  return { doc: next, ids: out };
}

export function releaseClip(doc: Doc, ids: Set<number>): { doc: Doc; ids: Set<number> } | null {
  const out = new Set<number>();
  let found = false;
  const next = mapItems(doc, (it) => {
    if (!ids.has(it.id) || it.type !== 'group' || !it.clip) return undefined;
    found = true;
    const [clip, ...rest] = it.children;
    const kids = clip ? [clip, ...rest] : rest;
    kids.forEach((k) => out.add(k.id));
    return { ...it, clip: false, children: kids };
  });
  return found ? { doc: next, ids: out } : null;
}

export type Arrange = 'front' | 'forward' | 'backward' | 'back';

export function arrange(doc: Doc, ids: Set<number>, how: Arrange): Doc {
  const reorder = (items: Item[], keepFirst: boolean): Item[] => {
    const fixed = keepFirst ? items.slice(0, 1) : [];
    const list = keepFirst ? items.slice(1) : [...items];
    if (!list.some((i) => ids.has(i.id))) return items;
    let out: Item[];
    if (how === 'front') out = [...list.filter((i) => !ids.has(i.id)), ...list.filter((i) => ids.has(i.id))];
    else if (how === 'back') out = [...list.filter((i) => ids.has(i.id)), ...list.filter((i) => !ids.has(i.id))];
    else {
      out = [...list];
      if (how === 'forward') {
        for (let i = out.length - 2; i >= 0; i--) if (ids.has(out[i].id) && !ids.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]];
      } else {
        for (let i = 1; i < out.length; i++) if (ids.has(out[i].id) && !ids.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
      }
    }
    return [...fixed, ...out];
  };
  const visit = (items: Item[], clip: boolean): Item[] => {
    const mapped = items.map((it) => (it.type === 'group' ? { ...it, children: visit(it.children, it.clip) } : it));
    return reorder(mapped, clip);
  };
  return { ...doc, layers: doc.layers.map((l) => ({ ...l, children: visit(l.children, false) })) };
}

export function makeCompound(doc: Doc, ids: Set<number>): { doc: Doc; id: number } | null {
  const items = selectedItems(doc, ids);
  const paths = leaves(items).filter((i): i is PathItem => i.type === 'path');
  if (paths.length < 2) return null;
  const back = paths[0];
  const top = items[items.length - 1];
  const compound: PathItem = { ...back, id: newId(), name: '', paths: paths.flatMap((p) => p.paths), evenOdd: false };
  const set = new Set(items.map((i) => i.id));
  return { doc: mapItems(doc, (it) => (it.id === top.id ? compound : set.has(it.id) ? null : undefined)), id: compound.id };
}

export function releaseCompound(doc: Doc, ids: Set<number>): { doc: Doc; ids: Set<number> } | null {
  const out = new Set<number>();
  let found = false;
  const next = mapItems(doc, (it) => {
    if (!ids.has(it.id) || it.type !== 'path' || it.paths.length < 2) return undefined;
    found = true;
    return it.paths.map((sp) => {
      const p: PathItem = { ...it, id: newId(), paths: [sp] };
      out.add(p.id);
      return p;
    });
  });
  return found ? { doc: next, ids: out } : null;
}

/** Restyle every path and type under the selection. */
export function restyle(doc: Doc, ids: Set<number>, fn: (it: Item) => Item): Doc {
  const deep = (it: Item): Item => {
    if (it.type === 'group') return { ...it, children: it.children.map((c, i) => (it.clip && i === 0 ? c : deep(c))) };
    return fn(it);
  };
  return mapItems(doc, (it) => (ids.has(it.id) ? deep(it) : undefined));
}

export function setFill(doc: Doc, ids: Set<number>, paint: Paint): Doc {
  return restyle(doc, ids, (it) => {
    if (it.type === 'path') return { ...it, fill: paint };
    if (it.type === 'text') return { ...it, runs: it.runs.map((r) => ({ ...r, fill: paint })), placed: undefined };
    return it;
  });
}

export function setStroke(doc: Doc, ids: Set<number>, patch: Partial<Stroke>): Doc {
  return restyle(doc, ids, (it) => {
    if (it.type === 'path') {
      const s = { ...it.stroke, ...patch };
      if (patch.paint && patch.paint.type !== 'none' && it.stroke.width <= 0 && patch.width === undefined) s.width = 1;
      return { ...it, stroke: s };
    }
    if (it.type === 'text') return { ...it, runs: it.runs.map((r) => ({ ...r, stroke: { ...r.stroke, ...patch } })), placed: undefined };
    return it;
  });
}

export function setProps(doc: Doc, ids: Set<number>, patch: Partial<Pick<Item, 'opacity' | 'blend' | 'name' | 'hidden' | 'locked'>>): Doc {
  return mapItems(doc, (it) => (ids.has(it.id) ? ({ ...it, ...patch } as Item) : undefined));
}

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hspace' | 'vspace';

export function align(doc: Doc, ids: Set<number>, how: AlignHow, to: Rect | null): Doc {
  const items = selectedItems(doc, ids);
  if (!items.length) return doc;
  const target = to ?? boundsOf(items, doc.res);
  return mapItems(doc, (it) => {
    if (!ids.has(it.id)) return undefined;
    const b = itemBounds(it, doc.res);
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = target.x - b.x;
    else if (how === 'hcenter') dx = target.x + target.w / 2 - (b.x + b.w / 2);
    else if (how === 'right') dx = target.x + target.w - (b.x + b.w);
    else if (how === 'top') dy = target.y - b.y;
    else if (how === 'vcenter') dy = target.y + target.h / 2 - (b.y + b.h / 2);
    else dy = target.y + target.h - (b.y + b.h);
    return dx || dy ? transformItem(it, translate(dx, dy)) : it;
  });
}

export function distribute(doc: Doc, ids: Set<number>, how: DistributeHow): Doc {
  const items = selectedItems(doc, ids);
  if (items.length < 3) return doc;
  const res = doc.res;
  const horizontal = ['left', 'hcenter', 'right', 'hspace'].includes(how);
  const key = (r: Rect) =>
    how === 'left' ? r.x : how === 'hcenter' ? r.x + r.w / 2 : how === 'right' ? r.x + r.w : how === 'top' ? r.y : how === 'vcenter' ? r.y + r.h / 2 : how === 'bottom' ? r.y + r.h : horizontal ? r.x : r.y;
  const sorted = [...items].sort((a, b) => key(itemBounds(a, res)) - key(itemBounds(b, res)));
  const moves = new Map<number, number>();
  if (how === 'hspace' || how === 'vspace') {
    const bs = sorted.map((i) => itemBounds(i, res));
    const total = horizontal ? bs[bs.length - 1].x + bs[bs.length - 1].w - bs[0].x : bs[bs.length - 1].y + bs[bs.length - 1].h - bs[0].y;
    const sizes = bs.reduce((s, b) => s + (horizontal ? b.w : b.h), 0);
    const gap = (total - sizes) / (bs.length - 1);
    let at = horizontal ? bs[0].x : bs[0].y;
    bs.forEach((b, i) => {
      moves.set(sorted[i].id, at - (horizontal ? b.x : b.y));
      at += (horizontal ? b.w : b.h) + gap;
    });
  } else {
    const first = key(itemBounds(sorted[0], res));
    const last = key(itemBounds(sorted[sorted.length - 1], res));
    sorted.forEach((it, i) => moves.set(it.id, first + ((last - first) * i) / (sorted.length - 1) - key(itemBounds(it, res))));
  }
  return mapItems(doc, (it) => {
    const d = moves.get(it.id);
    if (d === undefined || !ids.has(it.id)) return undefined;
    return transformItem(it, horizontal ? translate(d, 0) : translate(0, d));
  });
}

export function moveToLayer(doc: Doc, ids: Set<number>, layerId: number): Doc {
  const items = selectedItems(doc, ids);
  const removed = deleteItems(doc, new Set(items.map((i) => i.id)));
  return addItems(removed, layerId, items);
}

export function addLayer(doc: Doc, above?: number): { doc: Doc; layer: Layer } {
  let n = doc.layers.length + 1;
  while (doc.layers.some((l) => l.name === `Layer ${n}`)) n++;
  const layer = newLayer(`Layer ${n}`, doc.layers.length);
  const i = above !== undefined ? doc.layers.findIndex((l) => l.id === above) : doc.layers.length - 1;
  const layers = [...doc.layers];
  layers.splice(i + 1, 0, layer);
  return { doc: { ...doc, layers }, layer };
}

// ---- Points -----------------------------------------------------------------------------------

/** Anchor points: "itemId:subpath:node". */
export type NodeKey = string;
export const nodeKey = (id: number, sp: number, n: number): NodeKey => `${id}:${sp}:${n}`;
export function parseNodeKey(k: NodeKey): [number, number, number] {
  const [a, b, c] = k.split(':').map(Number);
  return [a, b, c];
}

/** Move anchor points (and their handles) by dx, dy. */
export function moveNodes(doc: Doc, keys: Set<NodeKey>, dx: number, dy: number): Doc {
  const byItem = new Map<number, Set<string>>();
  for (const k of keys) {
    const [id, sp, n] = parseNodeKey(k);
    if (!byItem.has(id)) byItem.set(id, new Set());
    byItem.get(id)!.add(`${sp}:${n}`);
  }
  return mapItems(doc, (it) => {
    const sel = byItem.get(it.id);
    if (!sel || it.type !== 'path') return undefined;
    return {
      ...it,
      paths: it.paths.map((sp, si) => ({
        ...sp,
        nodes: sp.nodes.map((nd, ni) =>
          sel.has(`${si}:${ni}`) ? { x: nd.x + dx, y: nd.y + dy, ix: nd.ix + dx, iy: nd.iy + dy, ox: nd.ox + dx, oy: nd.oy + dy } : nd,
        ),
      })),
    };
  });
}

export function updatePath(doc: Doc, id: number, fn: (p: PathItem) => PathItem): Doc {
  return mapItems(doc, (it) => (it.id === id && it.type === 'path' ? fn(it) : undefined));
}

/** Remove anchor points, keeping the paths' shape as well as straight joins allow. Empty paths go. */
export function deleteNodes(doc: Doc, keys: Set<NodeKey>): Doc {
  const byItem = new Map<number, Set<string>>();
  for (const k of keys) {
    const [id, sp, n] = parseNodeKey(k);
    if (!byItem.has(id)) byItem.set(id, new Set());
    byItem.get(id)!.add(`${sp}:${n}`);
  }
  return mapItems(doc, (it) => {
    const sel = byItem.get(it.id);
    if (!sel || it.type !== 'path') return undefined;
    const paths = it.paths
      .map((sp, si) => ({ ...sp, nodes: sp.nodes.filter((_, ni) => !sel.has(`${si}:${ni}`)) }))
      .filter((sp) => sp.nodes.length > (sp.closed ? 1 : 0))
      .map((sp) => (sp.nodes.length < 3 && sp.closed ? { ...sp, closed: false } : sp));
    if (!paths.length || paths.every((p) => p.nodes.length < 2)) return null;
    return { ...it, paths };
  });
}

/** Add an anchor at parameter t of segment `seg` (from node seg to the next). */
export function insertNode(p: PathItem, sp: number, seg: number, t: number): PathItem {
  const path = p.paths[sp];
  const n = path.nodes.length;
  const a = path.nodes[seg];
  const b = path.nodes[(seg + 1) % n];
  const s = splitSegment(a, b, t);
  const nodes = [...path.nodes];
  nodes[seg] = s.a;
  nodes[(seg + 1) % n] = s.b;
  nodes.splice(seg + 1, 0, s.mid);
  return { ...p, paths: p.paths.map((x, i) => (i === sp ? { ...x, nodes } : x)) };
}

/** Cut a path at anchor `n` (Scissors): closed paths open there; open paths become two. */
export function cutAt(p: PathItem, sp: number, n: number): PathItem[] {
  const path = p.paths[sp];
  const others = p.paths.filter((_, i) => i !== sp);
  if (path.closed) {
    const nodes = [...path.nodes.slice(n), ...path.nodes.slice(0, n), path.nodes[n]];
    nodes[nodes.length - 1] = { ...path.nodes[n], ox: path.nodes[n].x, oy: path.nodes[n].y };
    nodes[0] = { ...nodes[0], ix: nodes[0].x, iy: nodes[0].y };
    return [{ ...p, paths: [...others, { closed: false, nodes }] }];
  }
  if (n === 0 || n === path.nodes.length - 1) return [p];
  const a = { closed: false, nodes: path.nodes.slice(0, n + 1) };
  const b = { closed: false, nodes: path.nodes.slice(n) };
  a.nodes[a.nodes.length - 1] = { ...a.nodes[a.nodes.length - 1], ox: path.nodes[n].x, oy: path.nodes[n].y };
  b.nodes[0] = { ...b.nodes[0], ix: path.nodes[n].x, iy: path.nodes[n].y };
  return [
    { ...p, paths: [...others, a] },
    { ...p, id: newId(), paths: [b] },
  ];
}

/** Join: close one open path, or connect the nearest ends of two. */
export function join(doc: Doc, ids: Set<number>): { doc: Doc; id: number } | null {
  const paths = leaves(selectedItems(doc, ids)).filter((i): i is PathItem => i.type === 'path' && i.paths.some((s) => !s.closed));
  if (paths.length === 1) {
    const p = paths[0];
    const si = p.paths.findIndex((s) => !s.closed);
    return { doc: updatePath(doc, p.id, (x) => ({ ...x, paths: x.paths.map((s, i) => (i === si ? { ...s, closed: true } : s)) })), id: p.id };
  }
  if (paths.length < 2) return null;
  const [a, b] = paths;
  const sa = a.paths.find((s) => !s.closed)!;
  const sb = b.paths.find((s) => !s.closed)!;
  const ends = (s: SubPath) => [s.nodes[0], s.nodes[s.nodes.length - 1]];
  let best = { d: Infinity, ra: false, rb: false };
  for (const ra of [false, true]) {
    for (const rb of [false, true]) {
      const ea = ends(sa)[ra ? 0 : 1];
      const eb = ends(sb)[rb ? 1 : 0];
      const d = Math.hypot(ea.x - eb.x, ea.y - eb.y);
      if (d < best.d) best = { d, ra, rb };
    }
  }
  const rev = (s: SubPath): Node[] => [...s.nodes].reverse().map((n) => ({ ...n, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy }));
  const na = best.ra ? rev(sa) : sa.nodes;
  const nb = best.rb ? rev(sb) : sb.nodes;
  const merged: Node[] = [...na];
  const last = merged[merged.length - 1];
  const first = nb[0];
  if (best.d < 0.01) merged[merged.length - 1] = { ...last, ox: first.ox, oy: first.oy };
  else merged.push(first);
  merged.push(...nb.slice(1));
  const joined: PathItem = { ...a, paths: [...a.paths.filter((s) => s !== sa), { closed: false, nodes: merged }] };
  const next = mapItems(doc, (it) => (it.id === a.id ? joined : it.id === b.id ? null : undefined));
  return { doc: next, id: a.id };
}

/** Average: line the selected anchors up on their mean. */
export function averageNodes(doc: Doc, keys: Set<NodeKey>, axis: 'h' | 'v' | 'both'): Doc {
  const pts: { x: number; y: number }[] = [];
  for (const k of keys) {
    const [id, sp, n] = parseNodeKey(k);
    const p = findItem(doc, id)?.item;
    const nd = p?.type === 'path' ? p.paths[sp]?.nodes[n] : undefined;
    if (nd) pts.push(nd);
  }
  if (!pts.length) return doc;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let out = doc;
  for (const k of keys) {
    const [id, sp, n] = parseNodeKey(k);
    out = updatePath(out, id, (p) => ({
      ...p,
      paths: p.paths.map((s, si) =>
        si !== sp
          ? s
          : {
              ...s,
              nodes: s.nodes.map((nd, ni) => {
                if (ni !== n) return nd;
                const dx = axis === 'v' ? 0 : mx - nd.x;
                const dy = axis === 'h' ? 0 : my - nd.y;
                return { x: nd.x + dx, y: nd.y + dy, ix: nd.ix + dx, iy: nd.iy + dy, ox: nd.ox + dx, oy: nd.oy + dy };
              }),
            },
      ),
    }));
  }
  return out;
}

/** Fit points drawn by hand with a smooth path (Pencil and Paintbrush). */
export function smoothPath(pts: { x: number; y: number }[], closed: boolean, tolerance = 2): SubPath {
  // Thin the points to roughly `tolerance` apart, then run Catmull-Rom through them.
  const thin: { x: number; y: number }[] = [];
  for (const p of pts) {
    const last = thin[thin.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= tolerance * 3) thin.push(p);
  }
  const lastPt = pts[pts.length - 1];
  if (lastPt && thin[thin.length - 1] !== lastPt) thin.push(lastPt);
  const simple = douglasPeucker(thin, tolerance);
  const n = simple.length;
  const nodes: Node[] = simple.map((p) => corner(p.x, p.y));
  if (n < 3) return { closed, nodes };
  for (let i = 0; i < n; i++) {
    const prev = simple[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = simple[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    if (!closed && (i === 0 || i === n - 1)) continue;
    nodes[i] = { ...nodes[i], ix: simple[i].x - tx, iy: simple[i].y - ty, ox: simple[i].x + tx, oy: simple[i].y + ty };
  }
  return { closed, nodes };
}

function douglasPeucker(pts: { x: number; y: number }[], tol: number): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let worst = 0;
  let wi = 0;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.y - a.y) * pts[i].x - (b.x - a.x) * pts[i].y + b.x * a.y - b.y * a.x) / len;
    if (d > worst) {
      worst = d;
      wi = i;
    }
  }
  if (worst <= tol) return [a, b];
  return [...douglasPeucker(pts.slice(0, wi + 1), tol).slice(0, -1), ...douglasPeucker(pts.slice(wi), tol)];
}

/** Fit Artboard to Artwork Bounds. */
export function fitArtboard(doc: Doc, index: number): Doc {
  const ab = doc.artboards[index];
  if (!ab) return doc;
  const items = doc.layers.flatMap((l) => l.children);
  const b = boundsOf(items, doc.res);
  if (!Number.isFinite(b.x)) return doc;
  return { ...doc, artboards: doc.artboards.map((a, i) => (i === index ? { ...a, x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h) } : a)) };
}

export function defaultPaints(): { fill: Paint; stroke: Stroke } {
  return { fill: { type: 'color', color: { space: 'rgb', c: [1, 1, 1] } }, stroke: defaultStroke({ type: 'color', color: { space: 'rgb', c: [0, 0, 0] } }, 1) };
}

export { rectOfPoints };

/** Pathfinder: combine the selected paths (groups' paths too) into one, where the topmost of them was. */
export type ShapeModeOrDivide = ShapeMode | 'divide';

export function pathfinder(doc: Doc, ids: Set<number>, mode: ShapeModeOrDivide): { doc: Doc; ids: number[] } | null {
  const items = selectedItems(doc, ids);
  const paths = leaves(items).filter((i): i is PathItem => i.type === 'path' && i.paths.length > 0);
  if (paths.length < 2) return null;
  const made = mode === 'divide' ? divide(paths) : [shapeMode(paths, mode)].filter((p): p is PathItem => !!p);
  const top = items[items.length - 1];
  const set = new Set(items.map((i) => i.id));
  const replacement: Item[] =
    mode === 'divide' && made.length ? [{ id: newId(), type: 'group', name: '', opacity: 1, blend: 'normal', clip: false, children: made }] : made;
  const next = mapItems(doc, (it) => (it.id === top.id ? replacement : set.has(it.id) ? null : undefined));
  return { doc: next, ids: replacement.map((r) => r.id) };
}

/** Distinct solid colors the document's art uses, most used first (spot colors named). */
export function documentColors(doc: Doc, max = 36): { name: string; paint: Paint }[] {
  const counts = new Map<string, { name: string; paint: Paint; n: number }>();
  const add = (p: Paint) => {
    if (p.type !== 'color') return;
    const c = p.color;
    const key = `${c.space}:${c.spot ?? ''}:${c.c.map((v) => Math.round(v * 1000)).join(',')}`;
    const hit = counts.get(key);
    if (hit) hit.n++;
    else {
      const pct = (v: number) => Math.round(v * 100);
      const name = c.spot ?? (c.space === 'cmyk' ? `C=${pct(c.c[0])} M=${pct(c.c[1])} Y=${pct(c.c[2])} K=${pct(c.c[3])}` : c.space === 'gray' ? `K=${100 - pct(c.c[0])}` : `R=${Math.round(c.c[0] * 255)} G=${Math.round(c.c[1] * 255)} B=${Math.round(c.c[2] * 255)}`);
      counts.set(key, { name, paint: p, n: 1 });
    }
  };
  for (const l of doc.layers) {
    walk(l.children, (it) => {
      if (it.type === 'path') {
        add(it.fill);
        add(it.stroke.paint);
      } else if (it.type === 'text') for (const r of it.runs) add(r.fill);
    });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, max).map(({ name, paint }) => ({ name, paint }));
}
