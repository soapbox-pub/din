import { boundsOf, decompose, rectCorners, apply, type Pt, type Rect } from './geom';
import type { Item, Model, Spread } from './model';
import type { ToolId } from './tools';

/** Page Layout's saved settings and the selection helpers the editor shares with its panels. */

export type PanelId =
  | 'pages'
  | 'layers'
  | 'links'
  | 'stroke'
  | 'swatches'
  | 'color'
  | 'character'
  | 'paragraph'
  | 'paraStyles'
  | 'charStyles'
  | 'wrap';

export const PANEL_NAMES: Record<PanelId, string> = {
  pages: 'Pages',
  layers: 'Layers',
  links: 'Links',
  stroke: 'Stroke',
  swatches: 'Swatches',
  color: 'Color',
  character: 'Character',
  paragraph: 'Paragraph',
  paraStyles: 'Paragraph Styles',
  charStyles: 'Character Styles',
  wrap: 'Text Wrap',
};


export interface Settings {
  panels: Record<PanelId, boolean>;
  choice: Record<number, ToolId>;
  tool: ToolId;
  frameEdges: boolean;
  guides: boolean;
  threads: boolean;
  rulers: boolean;
  snap: boolean;
  control: boolean;
  hidden: boolean;
  refPoint: [number, number];
  constrain: boolean;
  defaults: { fill: string; stroke: string; weight: number };
  polygonSides: number;
}

export const DEFAULT_SETTINGS: Settings = {
  panels: {
    pages: true,
    layers: true,
    links: false,
    stroke: false,
    swatches: true,
    color: false,
    character: false,
    paragraph: false,
    paraStyles: false,
    charStyles: false,
    wrap: false,
  },
  choice: {},
  tool: 'select',
  frameEdges: true,
  guides: true,
  threads: false,
  rulers: true,
  snap: true,
  control: true,
  hidden: false,
  refPoint: [-1, -1],
  constrain: false,
  defaults: { fill: 'Swatch/None', stroke: 'Color/Black', weight: 1 },
  polygonSides: 6,
};

const KEY = 'din:page-layout:settings';

export function readSettings(): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
    const s = raw as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...s, panels: { ...DEFAULT_SETTINGS.panels, ...s.panels }, defaults: { ...DEFAULT_SETTINGS.defaults, ...s.defaults } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Settings just won't stick.
  }
}

/** The corners of items together, in spread coordinates. */
export function unionCorners(items: Item[]): Pt[] {
  const pts: Pt[] = [];
  for (const it of items) for (const p of rectCorners(it.box)) pts.push(apply(it.m, p));
  return rectCorners(boundsOf(pts));
}

export function unionBounds(items: Item[]): Rect {
  const pts: Pt[] = [];
  for (const it of items) for (const p of rectCorners(it.box)) pts.push(apply(it.m, p));
  return boundsOf(pts);
}

/** A point of an item's box by the reference point proxy (-1, 0, 1 each way), in spread coordinates. */
export function refPointOf(items: Item[], ref: [number, number]): Pt {
  if (items.length === 1) {
    const b = items[0].box;
    return apply(items[0].m, { x: b.x + ((ref[0] + 1) / 2) * b.w, y: b.y + ((ref[1] + 1) / 2) * b.h });
  }
  const b = unionBounds(items);
  return { x: b.x + ((ref[0] + 1) / 2) * b.w, y: b.y + ((ref[1] + 1) / 2) * b.h };
}

/** Size, rotation and shear as InDesign's Control panel shows them (angles counterclockwise). */
export function geometryOf(items: Item[]): { w: number; h: number; rotation: number; shear: number; sx: number; sy: number } {
  if (items.length === 1) {
    const it = items[0];
    const d = decompose(it.m);
    const local = decompose(it.local);
    return {
      w: it.box.w * d.sx,
      h: it.box.h * Math.abs(d.sy),
      rotation: Math.round((-d.rotation * 180) / Math.PI * 1000) / 1000 || 0,
      shear: Math.round((-d.shear * 180) / Math.PI * 1000) / 1000 || 0,
      sx: it.kind === 'group' || it.kind === 'graphic' ? local.sx * 100 : 100,
      sy: it.kind === 'group' || it.kind === 'graphic' ? Math.abs(local.sy) * 100 : 100,
    };
  }
  const b = unionBounds(items);
  return { w: b.w, h: b.h, rotation: 0, shear: 0, sx: 100, sy: 100 };
}

/** All the same, or undefined when they differ. */
export function same<T>(items: Item[], f: (it: Item) => T): T | undefined {
  if (!items.length) return undefined;
  const v = f(items[0]);
  return items.every((it) => f(it) === v) ? v : undefined;
}

/** The spread origin the rulers measure from: the top left of its pages. */
export const rulerOrigin = (s: Spread): Pt => ({ x: s.bounds.x, y: s.bounds.y });

/** Lines things snap to on a spread: page edges, margins, columns, guides, and its center. */
export function snapLines(model: Model, s: Spread): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of s.pages) {
    const b = p.bounds;
    xs.push(b.x, b.x + b.w, b.x + b.w / 2);
    ys.push(b.y, b.y + b.h, b.y + b.h / 2);
    const mg = p.margins;
    const ml = p.side === 'left' ? mg.right : mg.left;
    const mr = p.side === 'left' ? mg.left : mg.right;
    const tl = apply(p.m, { x: p.geom.x + ml, y: p.geom.y + mg.top });
    const br = apply(p.m, { x: p.geom.x + p.geom.w - mr, y: p.geom.y + p.geom.h - mg.bottom });
    xs.push(tl.x, br.x);
    ys.push(tl.y, br.y);
    if (mg.columns > 1) {
      const inner = br.x - tl.x;
      const cw = (inner - mg.gutter * (mg.columns - 1)) / mg.columns;
      for (let i = 1; i < mg.columns; i++) xs.push(tl.x + i * (cw + mg.gutter) - mg.gutter, tl.x + i * (cw + mg.gutter));
    }
    const bl = model.prefs.bleed;
    if (bl.top) ys.push(b.y - bl.top);
    if (bl.bottom) ys.push(b.y + b.h + bl.bottom);
  }
  for (const g of s.guides) {
    const p = g.page ? s.pages.find((q) => q.self === g.page) : null;
    if (g.vertical) xs.push(p ? apply(p.m, { x: g.location, y: 0 }).x : g.location);
    else ys.push(p ? apply(p.m, { x: 0, y: g.location }).y : g.location);
  }
  return { xs, ys };
}

export function snap1(v: number, lines: number[], tol: number): number | null {
  let best: number | null = null;
  let bd = tol;
  for (const l of lines) {
    const d = Math.abs(l - v);
    if (d <= bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}
