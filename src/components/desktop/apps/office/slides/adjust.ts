/**
 * The yellow adjustment handles: where each sits on a shape for its current
 * adjust values, and the adjust values a handle dragged to a point means
 * (both in px, in the shape's own unrotated box).
 */

type Adj = Record<string, number>;

interface Handle {
  pos: (w: number, h: number, a: Adj) => [number, number];
  set: (x: number, y: number, w: number, h: number, a: Adj) => Adj;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ss = (w: number, h: number) => Math.min(w, h) || 1;

/** Corner-ish handles along the top edge from the left: x = ss * adj. */
const fromLeft = (name: string, max: (w: number, h: number) => number = () => 50000): Handle => ({
  pos: (w, h, a) => [(ss(w, h) * a[name]) / 100000, 0],
  set: (x, _y, w, h) => ({ [name]: Math.round(clamp((x / ss(w, h)) * 100000, 0, max(w, h))) }),
});

const fromRight = (name: string, max: (w: number, h: number) => number = () => 50000): Handle => ({
  pos: (w, h, a) => [w - (ss(w, h) * a[name]) / 100000, 0],
  set: (x, _y, w, h) => ({ [name]: Math.round(clamp(((w - x) / ss(w, h)) * 100000, 0, max(w, h))) }),
});

const fromTop = (name: string, max: (w: number, h: number) => number = () => 50000): Handle => ({
  pos: (w, h, a) => [0, (ss(w, h) * a[name]) / 100000],
  set: (_x, y, w, h) => ({ [name]: Math.round(clamp((y / ss(w, h)) * 100000, 0, max(w, h))) }),
});

const shaftY = (name: string, at: 'l' | 'r'): Handle => ({
  pos: (w, h, a) => [at === 'l' ? 0 : w, h / 2 - (h * a[name]) / 200000],
  set: (_x, y, _w, h) => ({ [name]: Math.round(clamp(((h / 2 - y) * 200000) / (h || 1), 0, 100000)) }),
});

const shaftX = (name: string, at: 't' | 'b'): Handle => ({
  pos: (w, h, a) => [w / 2 - (w * a[name]) / 200000, at === 't' ? 0 : h],
  set: (x, _y, w) => ({ [name]: Math.round(clamp(((w / 2 - x) * 200000) / (w || 1), 0, 100000)) }),
});

const starInner: Handle = {
  pos: (w, h, a) => [w / 2, h / 2 - ((h / 2) * a.adj) / 50000],
  set: (_x, y, _w, h) => ({ adj: Math.round(clamp(((h / 2 - y) / (h / 2 || 1)) * 50000, 0, 50000)) }),
};

const tail: Handle = {
  pos: (w, h, a) => [w / 2 + (w * a.adj1) / 100000, h / 2 + (h * a.adj2) / 100000],
  set: (x, y, w, h) => ({ adj1: Math.round(((x - w / 2) / (w || 1)) * 100000), adj2: Math.round(((y - h / 2) / (h || 1)) * 100000) }),
};

const DEFS: Record<string, { defaults: Adj; handles: Handle[] }> = {
  roundRect: { defaults: { adj: 16667 }, handles: [fromLeft('adj')] },
  flowChartAlternateProcess: { defaults: {}, handles: [] },
  snip1Rect: { defaults: { adj: 16667 }, handles: [fromRight('adj')] },
  round1Rect: { defaults: { adj: 16667 }, handles: [fromRight('adj')] },
  snip2SameRect: { defaults: { adj1: 16667, adj2: 0 }, handles: [fromLeft('adj1')] },
  round2SameRect: { defaults: { adj1: 16667, adj2: 0 }, handles: [fromLeft('adj1')] },
  triangle: {
    defaults: { adj: 50000 },
    handles: [{ pos: (w, _h, a) => [(w * a.adj) / 100000, 0], set: (x, _y, w) => ({ adj: Math.round(clamp((x / (w || 1)) * 100000, 0, 100000)) }) }],
  },
  parallelogram: { defaults: { adj: 25000 }, handles: [fromLeft('adj', (w, h) => (100000 * w) / ss(w, h))] },
  trapezoid: { defaults: { adj: 25000 }, handles: [fromLeft('adj', (w, h) => (50000 * w) / ss(w, h))] },
  hexagon: { defaults: { adj: 25000 }, handles: [fromLeft('adj', (w, h) => (50000 * w) / ss(w, h))] },
  octagon: { defaults: { adj: 29289 }, handles: [fromLeft('adj')] },
  plus: { defaults: { adj: 25000 }, handles: [fromLeft('adj')] },
  frame: { defaults: { adj1: 12500 }, handles: [fromLeft('adj1')] },
  plaque: { defaults: { adj: 16667 }, handles: [fromLeft('adj')] },
  bracketPair: { defaults: { adj: 16667 }, handles: [fromLeft('adj')] },
  cube: { defaults: { adj: 25000 }, handles: [fromTop('adj', () => 100000)] },
  can: {
    defaults: { adj: 25000 },
    handles: [{ pos: (w, h, a) => [w / 2, (ss(w, h) * a.adj) / 100000], set: (_x, y, w, h) => ({ adj: Math.round(clamp((y / ss(w, h)) * 100000, 0, (50000 * h) / ss(w, h))) }) }],
  },
  donut: {
    defaults: { adj: 25000 },
    handles: [{ pos: (w, h, a) => [(ss(w, h) * a.adj) / 100000, h / 2], set: (x, _y, w, h) => ({ adj: Math.round(clamp((x / ss(w, h)) * 100000, 0, 50000)) }) }],
  },
  chevron: { defaults: { adj: 50000 }, handles: [fromRight('adj', (w, h) => (100000 * w) / ss(w, h))] },
  homePlate: { defaults: { adj: 50000 }, handles: [fromRight('adj', (w, h) => (100000 * w) / ss(w, h))] },
  rightArrow: { defaults: { adj1: 50000, adj2: 50000 }, handles: [fromRight('adj2', (w, h) => (100000 * w) / ss(w, h)), shaftY('adj1', 'l')] },
  leftArrow: { defaults: { adj1: 50000, adj2: 50000 }, handles: [fromLeft('adj2', (w, h) => (100000 * w) / ss(w, h)), shaftY('adj1', 'r')] },
  leftRightArrow: { defaults: { adj1: 50000, adj2: 50000 }, handles: [fromLeft('adj2', (w, h) => (50000 * w) / ss(w, h))] },
  notchedRightArrow: { defaults: { adj1: 50000, adj2: 50000 }, handles: [fromRight('adj2', (w, h) => (100000 * w) / ss(w, h)), shaftY('adj1', 'l')] },
  upArrow: { defaults: { adj1: 50000, adj2: 50000 }, handles: [fromTop('adj2', (w, h) => (100000 * h) / ss(w, h)), shaftX('adj1', 'b')] },
  downArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    handles: [
      { pos: (w, h, a) => [0, h - (ss(w, h) * a.adj2) / 100000], set: (_x, y, w, h) => ({ adj2: Math.round(clamp(((h - y) / ss(w, h)) * 100000, 0, (100000 * h) / ss(w, h))) }) },
      shaftX('adj1', 't'),
    ],
  },
  star4: { defaults: { adj: 12500 }, handles: [starInner] },
  star5: { defaults: { adj: 19098 }, handles: [starInner] },
  star6: { defaults: { adj: 28868 }, handles: [starInner] },
  wedgeRectCallout: { defaults: { adj1: -20833, adj2: 62500 }, handles: [tail] },
  wedgeRoundRectCallout: { defaults: { adj1: -20833, adj2: 62500, adj3: 16667 }, handles: [tail] },
  wedgeEllipseCallout: { defaults: { adj1: -20833, adj2: 62500 }, handles: [tail] },
};

export function adjustHandles(prst: string | undefined, adj: Adj | undefined, w: number, h: number): [number, number][] {
  const def = prst ? DEFS[prst] : undefined;
  if (!def) return [];
  const a = { ...def.defaults, ...(adj ?? {}) };
  return def.handles.map((hd) => hd.pos(w, h, a));
}

/** New adjust values for dragging handle `i` to (x, y). */
export function dragAdjust(prst: string, adj: Adj | undefined, i: number, x: number, y: number, w: number, h: number): Adj {
  const def = DEFS[prst];
  const a = { ...def.defaults, ...(adj ?? {}) };
  return { ...(adj ?? {}), ...def.handles[i].set(x, y, w, h, a) };
}
