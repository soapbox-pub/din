/**
 * Hyprland-style "dwindle" tiling: each (monitor, workspace) pair keeps a
 * binary tree of splits whose leaves are window ids. A new window splits
 * the focused one in two, side by side when that tile is wider than it is
 * tall and stacked otherwise, so a run of windows spirals into the corner.
 * Set up as Omarchy sets Hyprland up: splits keep their direction once made
 * (`preserve_split`), and a new window takes the right or bottom half
 * (`force_split = 2`).
 *
 * Pure functions over immutable trees; the window manager (useWindows)
 * keeps the trees and turns them into window rects with `layoutTree`.
 */
import type { Rect } from '@/lib/monitors';

/** A tile holding one window, or a split of a rect between two subtrees. */
export type TileNode =
  | { leaf: string }
  | {
      /** 'h': `a` on the left, `b` on the right; 'v': `a` above, `b` below. */
      split: 'h' | 'v';
      /** The share of the rect `a` gets, 0..1. */
      ratio: number;
      a: TileNode;
      b: TileNode;
    };

/**
 * How far a split's ratio may go, as on Hyprland (its 0.1 to 1.9 of an even
 * half): a side keeps a twentieth of the split.
 */
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

/** A point in workspace coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Which of a tile's edges a resize has hold of (a corner is two). None at
 * all is a resize from the keyboard, which moves the nearest splits.
 */
export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** The window ids in a tree, left to right / top to bottom. */
export function treeLeaves(node: TileNode | null): string[] {
  if (!node) return [];
  return 'leaf' in node ? [node.leaf] : [...treeLeaves(node.a), ...treeLeaves(node.b)];
}

/** The rects of a split's two sides, with `gap` pixels between them. */
function splitRects(rect: Rect, split: 'h' | 'v', ratio: number, gap: number): [Rect, Rect] {
  if (split === 'h') {
    const room = Math.max(0, rect.width - gap);
    const aw = Math.round(room * ratio);
    return [
      { x: rect.x, y: rect.y, width: aw, height: rect.height },
      { x: rect.x + aw + gap, y: rect.y, width: room - aw, height: rect.height },
    ];
  }
  const room = Math.max(0, rect.height - gap);
  const ah = Math.round(room * ratio);
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: ah },
    { x: rect.x, y: rect.y + ah + gap, width: rect.width, height: room - ah },
  ];
}

/** The rect inside `area` that tiles get, `gap` (the outer gap) in from every edge. */
export function tilingRect(area: Rect, gap: number): Rect {
  return {
    x: area.x + gap,
    y: area.y + gap,
    width: Math.max(0, area.width - gap * 2),
    height: Math.max(0, area.height - gap * 2),
  };
}

/** Every window's rect: the tree laid out over `rect` (see tilingRect). */
export function layoutTree(node: TileNode | null, rect: Rect, gap: number, out = new Map<string, Rect>()): Map<string, Rect> {
  if (!node) return out;
  if ('leaf' in node) {
    out.set(node.leaf, rect);
    return out;
  }
  const [ra, rb] = splitRects(rect, node.split, node.ratio, gap);
  layoutTree(node.a, ra, gap, out);
  layoutTree(node.b, rb, gap, out);
  return out;
}

/** How far a point is from a rect, squared (0 inside it). */
function distanceSquared(point: Point, r: Rect): number {
  const dx = Math.max(r.x - point.x, 0, point.x - (r.x + r.width));
  const dy = Math.max(r.y - point.y, 0, point.y - (r.y + r.height));
  return dx * dx + dy * dy;
}

/** The tile nearest a point (the one it's in, if any), or null in an empty tree. */
export function nearestLeaf(node: TileNode | null, point: Point, rect: Rect, gap: number): string | null {
  let nearest = Infinity;
  let found: string | null = null;
  for (const [id, r] of layoutTree(node, rect, gap)) {
    const d = distanceSquared(point, r);
    if (d < nearest) {
      nearest = d;
      found = id;
    }
  }
  return found;
}

/** Where a window joins a tree (see insertLeaf). */
export interface Placement {
  before?: boolean;
  /** The tile to split; without one in the tree, the tile nearest `point`, else the last. */
  target?: string | null;
  /** Where the pointer is. */
  point?: Point;
  /**
   * Take the side nearest `point` (a tile dragged and dropped), rather
   * than the right or bottom half.
   */
  byHalf?: boolean;
}

/**
 * Add a window to a tree, splitting a tile in two: side by side when the
 * tile is wider than it is tall, stacked otherwise (Hyprland's dwindle).
 *
 * Opened, a window splits `target`'s tile (the focused one) and takes the
 * right or bottom half, as Omarchy's `force_split = 2` has it. With no
 * target (a floating window tiled again), it splits the tile nearest the
 * pointer. Dropped (`byHalf`, a tile dragged there), it also takes the half
 * of that tile the pointer is in.
 */
export function insertLeaf(node: TileNode | null, id: string, rect: Rect, gap: number, where: Placement = {}): TileNode {
  const leaf: TileNode = { leaf: id };
  if (!node) return leaf;
  const { target = null, point, byHalf = false } = where;
  const rects = layoutTree(node, rect, gap);
  const leaves = [...rects.keys()];
  let victim = leaves[leaves.length - 1];
  if (target !== null && rects.has(target)) victim = target;
  else if (point) victim = nearestLeaf(node, point, rect, gap) ?? victim;
  const at = rects.get(victim) ?? rect;
  const u = point && at.width > 0 ? (point.x - at.x) / at.width : 0.5;
  const v = point && at.height > 0 ? (point.y - at.y) / at.height : 0.5;
  const horizontal = byHalf && point
    ? Math.min(u, 1 - u) <= Math.min(v, 1 - v)
    : at.width > at.height;
  const split = horizontal ? 'h' : 'v';
  const first = where.before ?? (byHalf && (horizontal ? u < 0.5 : v < 0.5));
  const replace = (n: TileNode): TileNode => {
    if ('leaf' in n) {
      if (n.leaf !== victim) return n;
      return first ? { split, ratio: 0.5, a: leaf, b: n } : { split, ratio: 0.5, a: n, b: leaf };
    }
    const a = replace(n.a);
    const b = a === n.a ? replace(n.b) : n.b;
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return replace(node);
}

/**
 * Put a window down at `point`: out of the tree if it's in it (the others
 * close up), then back in beside the tile nearest the point, in the half of
 * it the point is in. Where a tile dragged and dropped there lands, as on
 * Hyprland.
 */
export function placeLeaf(node: TileNode | null, id: string, point: Point, rect: Rect, gap: number): TileNode {
  return insertLeaf(removeLeaf(node, id), id, rect, gap, { point, byHalf: true });
}

/** Take a window out of a tree; its sibling gets the whole split. */
export function removeLeaf(node: TileNode | null, id: string): TileNode | null {
  if (!node) return null;
  if ('leaf' in node) return node.leaf === id ? null : node;
  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Rename leaves: each id in `map` becomes its value (a swap maps both ways). */
export function renameLeaves(node: TileNode | null, map: ReadonlyMap<string, string>): TileNode | null {
  if (!node) return null;
  if ('leaf' in node) {
    const to = map.get(node.leaf);
    return to === undefined ? node : { leaf: to };
  }
  const a = renameLeaves(node.a, map)!;
  const b = renameLeaves(node.b, map)!;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Flip the split a window's tile came from: side by side <-> stacked. */
export function toggleSplit(node: TileNode | null, id: string): TileNode | null {
  if (!node || 'leaf' in node) return node;
  const holds = (n: TileNode) => 'leaf' in n && n.leaf === id;
  if (holds(node.a) || holds(node.b)) return { ...node, split: node.split === 'h' ? 'v' : 'h' };
  const a = toggleSplit(node.a, id)!;
  const b = toggleSplit(node.b, id)!;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** A split on the way from the root down to a tile, and which side the tile is on. */
interface Step {
  node: Extract<TileNode, { split: 'h' | 'v' }>;
  side: 'a' | 'b';
  /** The split's rect, and the rect of the side the tile is on. */
  rect: Rect;
  child: Rect;
}

/** The splits from the root down to a window's tile, or null if it isn't in the tree. */
function pathTo(node: TileNode, id: string, rect: Rect, gap: number): Step[] | null {
  if ('leaf' in node) return node.leaf === id ? [] : null;
  const [ra, rb] = splitRects(rect, node.split, node.ratio, gap);
  for (const side of ['a', 'b'] as const) {
    const child = side === 'a' ? ra : rb;
    const rest = pathTo(node[side], id, child, gap);
    if (rest) return [{ node, side, rect, child }, ...rest];
  }
  return null;
}

/** The tree with the split `depth` steps down `sides` given a new ratio. */
function withRatio(node: TileNode, sides: ('a' | 'b')[], depth: number, ratio: number): TileNode {
  if ('leaf' in node) return node;
  if (depth === 0) return node.ratio === ratio ? node : { ...node, ratio };
  const side = sides[0];
  const child = withRatio(node[side], sides.slice(1), depth - 1, ratio);
  return child === node[side] ? node : { ...node, [side]: child };
}

const extent = (r: Rect, axis: 'h' | 'v') => (axis === 'h' ? r.width : r.height);

/**
 * Resize a window's tile by `dx` / `dy` pixels, as Hyprland's dwindle does
 * with `smart_resizing`.
 *
 * From the keyboard (no `edges`, its `resizeactive`), the nearest
 * side-by-side split the tile sits in goes right (negative: left) and the
 * nearest stacked one down (negative: up), whichever side of it the window
 * is on: a window on the left or top of its split grows with a positive
 * number, one on the right or bottom shrinks.
 *
 * By the mouse, the split moved is the one that edge of the tile lies
 * along (an edge at the screen's stands for the one across from it), and a
 * nearer split along the same axis is put back, so only the tiles either
 * side of the dragged edge change size.
 */
export function resizeLeaf(
  node: TileNode | null,
  id: string,
  dx: number,
  dy: number,
  rect: Rect,
  gap: number,
  edges: ResizeEdges = {},
): TileNode | null {
  if (!node) return null;
  const path = pathTo(node, id, rect, gap);
  if (!path || path.length === 0) return node;
  const tile = path[path.length - 1].child;
  const sticks = (a: number, b: number) => Math.abs(a - b) < 2;
  const atLeft = sticks(tile.x, rect.x);
  const atRight = sticks(tile.x + tile.width, rect.x + rect.width);
  const atTop = sticks(tile.y, rect.y);
  const atBottom = sticks(tile.y + tile.height, rect.y + rect.height);
  const none = !edges.left && !edges.right && !edges.top && !edges.bottom;
  const sides = path.map((step) => step.side);
  let next: TileNode = node;

  for (const axis of ['h', 'v'] as const) {
    if (!none && !(axis === 'h' ? edges.left || edges.right : edges.top || edges.bottom)) continue;
    const delta = axis === 'h' ? dx : dy;
    // A tile as wide (or tall) as the layout has no split to move that way.
    if (delta === 0 || (axis === 'h' ? atLeft && atRight : atTop && atBottom)) continue;
    // Toward the start of the axis (left, top) and toward its end.
    const toStart = axis === 'h' ? edges.left || atRight : edges.top || atBottom;
    const toEnd = axis === 'h' ? edges.right || atLeft : edges.bottom || atTop;
    let outer = -1;
    let inner = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i];
      if (step.node.split !== axis) continue;
      if (none || (toStart && step.side === 'b') || (toEnd && step.side === 'a')) {
        outer = i;
        break;
      }
      if (inner < 0) inner = i;
    }
    if (outer < 0) continue;
    const step = path[outer];
    const size = Math.max(1, extent(step.rect, axis) - gap);
    const ratio = clampRatio(step.node.ratio + delta / size);
    next = withRatio(next, sides, outer, ratio);
    if (inner < 0) continue;
    // The nearer split keeps the tile across it from the dragged edge as it was.
    const moved = Math.round(size * ratio) - Math.round(size * step.node.ratio);
    const held = path[inner];
    const room = Math.max(1, extent(pathTo(next, id, rect, gap)![inner].rect, axis) - gap);
    const mine = extent(held.child, axis);
    const share = held.side === 'a' ? (mine - moved) / room : 1 - (mine + moved) / room;
    next = withRatio(next, sides, inner, clampRatio(share));
  }
  return next;
}
