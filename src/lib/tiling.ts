/**
 * Hyprland-style "dwindle" tiling: each (monitor, workspace) pair keeps a
 * binary tree of splits whose leaves are window ids. A new window splits
 * the focused one in two, side by side when that tile is wider than it is
 * tall and stacked otherwise, so a run of windows spirals into the corner.
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

/** How far a split's ratio may go before a side gets too small to use. */
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

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

/** The rect inside `area` that tiles get, `gap` in from every edge. */
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

/**
 * Add a window to a tree, splitting `target`'s tile (or, without one in the
 * tree, the last tile) in two, the new window taking the right or bottom half.
 */
export function insertLeaf(node: TileNode | null, id: string, target: string | null, rect: Rect, gap: number): TileNode {
  const leaf: TileNode = { leaf: id };
  if (!node) return leaf;
  const leaves = treeLeaves(node);
  const victim = target !== null && leaves.includes(target) ? target : leaves[leaves.length - 1];
  const at = layoutTree(node, rect, gap).get(victim) ?? rect;
  const split = at.width >= at.height ? 'h' : 'v';
  const replace = (n: TileNode): TileNode => {
    if ('leaf' in n) return n.leaf === victim ? { split, ratio: 0.5, a: n, b: leaf } : n;
    const a = replace(n.a);
    const b = a === n.a ? replace(n.b) : n.b;
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return replace(node);
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

/**
 * Grow (or, negative, shrink) a window's tile by `dx` / `dy` pixels, moving
 * the nearest split along that axis it sits in.
 */
export function resizeLeaf(node: TileNode | null, id: string, dx: number, dy: number, rect: Rect, gap: number): TileNode | null {
  if (!node) return null;
  let next: TileNode = node;
  for (const [axis, delta] of [['h', dx], ['v', dy]] as const) {
    if (delta === 0) continue;
    /** Returns the updated subtree, and whether the leaf was found under it. */
    const walk = (n: TileNode, r: Rect): { n: TileNode; found: boolean; done: boolean } => {
      if ('leaf' in n) return { n, found: n.leaf === id, done: false };
      const [ra, rb] = splitRects(r, n.split, n.ratio, gap);
      for (const side of ['a', 'b'] as const) {
        const sub = walk(n[side], side === 'a' ? ra : rb);
        if (!sub.found) continue;
        const updated = { ...n, [side]: sub.n };
        if (sub.done || n.split !== axis) return { n: updated, found: true, done: sub.done };
        const size = Math.max(1, (axis === 'h' ? r.width : r.height) - gap);
        const ratio = clampRatio(n.ratio + (side === 'a' ? delta : -delta) / size);
        return { n: { ...updated, ratio }, found: true, done: true };
      }
      return { n, found: false, done: false };
    };
    next = walk(next, rect).n;
  }
  return next;
}
