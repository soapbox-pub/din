import { apply, flatten, intersects, invert, pointInPolys, segDist, transformRect, type Pt, type Rect } from './geom';
import type { Item, Model, Spread } from './model';

/**
 * What's under the pointer: the frontmost item on a visible, unlocked layer,
 * found the way InDesign finds it (inside text frames, filled shapes and
 * graphics frames; on the edge of empty shapes and lines).
 */

export interface Hit {
  spread: Spread;
  /** The top-level item (a whole group). */
  item: Item;
  /** The innermost item hit (in a group, or the graphic in a frame). */
  leaf: Item;
}

function hitsItem(it: Item, q: Pt, tol: number, overrides: Map<string, Item>): Item | null {
  if (!it.visible) return null;
  if (it.kind === 'group') {
    for (let i = it.children.length - 1; i >= 0; i--) {
      const ch = overrides.get(it.children[i].self) ?? it.children[i];
      const h = hitsItem(ch, q, tol, overrides);
      if (h) return h;
    }
    return null;
  }
  const inv = invert(it.m);
  const lq = apply(inv, q);
  // Tolerance in the item's own units.
  const scale = Math.hypot(inv[0], inv[1]) || 1;
  const t = tol * scale;
  if (it.kind === 'graphic') {
    const b = it.box;
    return lq.x >= b.x && lq.x <= b.x + b.w && lq.y >= b.y && lq.y <= b.y + b.h ? it : null;
  }
  const b = it.box;
  if (lq.x < b.x - t - it.strokeWeight || lq.x > b.x + b.w + t + it.strokeWeight || lq.y < b.y - t - it.strokeWeight || lq.y > b.y + b.h + t + it.strokeWeight) return null;
  if (it.kind === 'text') return it;
  const polys = flatten(it.paths);
  const solid = !!it.fill || it.children.length > 0 || it.contentType === 'GraphicType' || it.kind === 'other';
  if (solid && it.kind !== 'line' && pointInPolys(lq, polys)) {
    // A graphic in the frame is the leaf.
    for (let i = it.children.length - 1; i >= 0; i--) {
      const ch = overrides.get(it.children[i].self) ?? it.children[i];
      const h = hitsItem(ch, q, tol, overrides);
      if (h) return h;
    }
    return it;
  }
  const edge = t + it.strokeWeight / 2;
  for (const poly of polys) {
    for (let i = 0; i + 1 < poly.length; i++) if (segDist(lq, poly[i], poly[i + 1]) <= edge) return it;
  }
  return null;
}

export function hitTest(model: Model, spreads: Spread[], p: Pt, zoom: number, overrides: Map<string, Item>, skipLocked = true): Hit | null {
  const tol = 4 / zoom;
  const layerIndex = new Map(model.layers.map((l, i) => [l.self, i]));
  for (const s of spreads) {
    const q = { x: p.x, y: p.y - s.y };
    const top = s.bounds.y - 2000;
    if (q.y < top || q.y > s.bounds.y + s.bounds.h + 2000) continue;
    // Front to back: layers from the top (first in the list), items from the end of the spread.
    const order = s.items
      .map((it, i) => ({ it: overrides.get(it.self) ?? it, i }))
      .sort((a, b) => (layerIndex.get(a.it.layer) ?? 0) - (layerIndex.get(b.it.layer) ?? 0) || b.i - a.i);
    for (const { it } of order) {
      const layer = model.layers.find((l) => l.self === it.layer);
      if (layer && !layer.visible) continue;
      if (skipLocked && (it.locked || layer?.locked)) continue;
      const leaf = hitsItem(it, q, tol, overrides);
      if (leaf) return { spread: s, item: it, leaf };
    }
  }
  return null;
}

/** Items whose bounds a marquee touches. */
export function marqueeHits(model: Model, spreads: Spread[], r: Rect): { spread: Spread; item: Item }[] {
  const out: { spread: Spread; item: Item }[] = [];
  for (const s of spreads) {
    const local = { x: r.x, y: r.y - s.y, w: r.w, h: r.h };
    for (const it of s.items) {
      const layer = model.layers.find((l) => l.self === it.layer);
      if ((layer && (!layer.visible || layer.locked)) || it.locked || !it.visible) continue;
      if (intersects(transformRect(it.m, it.box), local)) out.push({ spread: s, item: it });
    }
  }
  return out;
}

/** The item, or the item inside a group, with this Self, searching from the top. */
export function findTop(model: Model, self: string): { spread: Spread; item: Item } | null {
  const it = model.items.get(self);
  const s = model.spreadOf.get(self);
  return it && s ? { spread: s, item: it } : null;
}
