/**
 * CAD's commands, written the way AutoCAD's prompt for things: each one
 * asks the command line for points, distances, options and objects in
 * turn, with live previews, and records one undo step.
 */
import {
  BYLAYER,
  CONTINUOUS,
  ENTITY_NAMES,
  defaultLayer,
  findBlock,
  findDimStyle,
  findLayer,
  findTextStyle,
  newId,
  type Block,
  type DimKind,
  type Dimension,
  type Drawing,
  type Entity,
  type EntityBase,
  type Hatch,
  type HAlign,
  type Insert,
  type PlineVertex,
  type Text,
  type VAlign,
  type Vec,
} from './model';
import {
  TAU,
  add,
  angleTo,
  boxValid,
  circleCircle,
  circleThrough,
  dist,
  dot,
  emptyBox,
  entitySegs,
  grow,
  interpolateSpline,
  lineCircle,
  lineLine,
  lerp,
  mid,
  mirroring,
  mul,
  norm,
  perp,
  plinePoints,
  polar,
  polygonArea,
  rotation,
  same,
  scaling,
  sub,
  sweep,
  transformEntity,
  translation,
  wrapAngle,
  type Box,
  type Mat,
  type Seg,
  distToSeg,
} from './geom';
import { Cancelled, type Answer, type Keyword, type PointReq, type Req } from './engine';
import { anchorOf, breakAt, chamfer, edgesOf, explode, extend, fillet, grips, join, offset, stretch, trim } from './edit';
import { dimText, measure } from './dim';
import { findRegion } from './boundary';
import { patternLines } from './hatch';
import { worldSegs } from './snap';
import { mtextPlain } from './text';

export interface HatchSettings {
  pattern: string;
  scale: number;
  /** Degrees. */
  angle: number;
}

export interface TextEditRequest {
  p: Vec;
  h: number;
  rot: number;
  style: string;
  initial: string;
}

export interface MTextEditRequest extends TextEditRequest {
  width: number;
  attach: number;
}

/** What commands need from the window they run in. */
export interface Host {
  drawing(): Drawing;
  /** Record a change; one command's changes make one undo step. */
  commit(label: string, d: Drawing): void;
  ask(req: Req): Promise<Answer>;
  say(msg: string): void;
  /** The properties new objects get. */
  props(): Omit<EntityBase, 'id'>;
  /** The objects selected before the command started (and clears them). */
  takeSelection(): Entity[];
  setSelection(ids: number[]): void;
  /** Ghost entities that stay while the command runs. */
  setTemp(list: Entity[]): void;
  lastPoint: Vec | null;
  metric: boolean;
  zoom(kind: 'extents' | 'all' | 'previous' | 'window' | 'scale' | 'pan', a?: Vec, b?: Vec | number): void;
  undo(n?: number): void;
  redo(): void;
  editText(r: TextEditRequest): Promise<string | null>;
  editMText(r: MTextEditRequest): Promise<string | null>;
  open(panel: 'layers' | 'properties' | 'units' | 'drafting' | 'insert' | 'dimstyle' | 'textstyle' | 'history' | 'about'): void;
  chooseBlock(): Promise<{ name: string; scale: number; rotation: number } | null>;
  hatch: { get(): HatchSettings; begin(): void; end(): void };
  file(op: 'new' | 'open' | 'save' | 'saveas' | 'close' | 'export-dxf'): void;
  clipboard: { copy(list: Entity[], base: Vec | null): void; paste(): Promise<{ list: Entity[]; base: Vec | null } | null> };
  /** The entities on screen, for HATCH's boundary search. */
  visible(): Entity[];
}

export type Command = (h: Host) => Promise<void>;

// ---- Asking ------------------------------------------------------------------------------

type PtOpts = Omit<PointReq, 'kind' | 'prompt'>;

/** A point, a keyword, or null for Enter. */
async function point(h: Host, prompt: string, o: PtOpts = {}): Promise<Vec | string | null> {
  const a = await h.ask({ kind: 'point', prompt, rubber: !!o.base, ...o });
  if (a.t === 'point') {
    h.lastPoint = a.p;
    return a.p;
  }
  if (a.t === 'keyword') return a.k;
  return null;
}

/** A point, insisting (Enter asks again). */
async function needPoint(h: Host, prompt: string, o: PtOpts = {}): Promise<Vec | string> {
  for (;;) {
    const p = await point(h, prompt, o);
    if (p !== null) return p;
  }
}

/** A distance: typed, or picked as two points (or one, from `base`). */
async function distance(h: Host, prompt: string, o: { base?: Vec | null; def?: number; keywords?: Keyword[]; preview?: (p: Vec) => Entity[] } = {}): Promise<number | string | null> {
  const a = await h.ask({ kind: 'point', prompt, number: true, base: o.base ?? null, rubber: !!o.base, keywords: o.keywords, default: o.def !== undefined ? fmt(o.def) : undefined, preview: o.preview });
  if (a.t === 'number') return a.n;
  if (a.t === 'keyword') return a.k;
  if (a.t === 'enter') return o.def ?? null;
  if (a.t === 'point') {
    if (o.base) return dist(o.base, a.p);
    const b = await needPoint(h, 'Specify second point', { base: a.p });
    return typeof b === 'string' ? null : dist(a.p, b);
  }
  return null;
}

/** An angle in radians: typed degrees, or picked from `base`. */
async function angle(h: Host, prompt: string, o: { base?: Vec | null; def?: number; keywords?: Keyword[]; preview?: (p: Vec) => Entity[] } = {}): Promise<number | string | null> {
  const a = await h.ask({ kind: 'point', prompt, number: true, base: o.base ?? null, rubber: !!o.base, keywords: o.keywords, default: o.def === undefined ? undefined : Math.abs(o.def - TAU) < 1e-12 ? '360' : fmtAngle(o.def), preview: o.preview });
  if (a.t === 'number') return (a.n * Math.PI) / 180;
  if (a.t === 'keyword') return a.k;
  if (a.t === 'enter') return o.def ?? null;
  if (a.t === 'point') {
    if (o.base) return angleTo(o.base, a.p);
    const b = await needPoint(h, 'Specify second point', { base: a.p });
    return typeof b === 'string' ? null : angleTo(a.p, b);
  }
  return null;
}

async function integer(h: Host, prompt: string, def: number, min = 1, max = 1e6): Promise<number> {
  for (;;) {
    const a = await h.ask({ kind: 'point', prompt, number: true, default: String(def) });
    if (a.t === 'enter') return def;
    if (a.t === 'number' && Number.isInteger(a.n) && a.n >= min && a.n <= max) return a.n;
    h.say(`Requires an integer between ${min} and ${max}.`);
  }
}

async function choose(h: Host, prompt: string, keywords: Keyword[], def: string): Promise<string> {
  for (;;) {
    const a = await h.ask({ kind: 'point', prompt, keywords, default: def, number: true });
    if (a.t === 'keyword') return a.k;
    if (a.t === 'enter') return def;
    h.say('Invalid option keyword.');
  }
}

async function text(h: Host, prompt: string, def?: string, spaces = false): Promise<string | null> {
  const a = await h.ask({ kind: 'string', prompt, default: def, spaces });
  return a.t === 'text' ? a.s : a.t === 'enter' ? (def ?? '') : null;
}

/** Objects: the ones already selected, or asked for. */
async function objects(h: Host, prompt = 'Select objects', filter?: (e: Entity) => boolean): Promise<Entity[]> {
  const pre = h.takeSelection().filter((e) => !filter || filter(e));
  if (pre.length) {
    h.say(`${pre.length} found`);
    return pre;
  }
  const a = await h.ask({ kind: 'select', prompt, filter });
  return a.t === 'objects' ? a.list : [];
}

async function pick(h: Host, prompt: string, filter?: (e: Entity) => boolean, keywords?: Keyword[]): Promise<{ e: Entity; p: Vec } | string | null> {
  const a = await h.ask({ kind: 'pick', prompt, filter, keywords });
  if (a.t === 'pick') return { e: a.e, p: a.p };
  if (a.t === 'keyword') return a.k;
  return null;
}

// ---- Helpers -----------------------------------------------------------------------------

export const fmt = (n: number, prec = 4) => {
  const t = n.toFixed(prec);
  return t === `-${(0).toFixed(prec)}` ? (0).toFixed(prec) : t;
};
export const fmtAngle = (rad: number) => {
  const deg = (wrapAngle(rad) * 180) / Math.PI;
  return String(Math.round(deg * 10000) / 10000);
};

const withEntities = (d: Drawing, entities: Entity[]): Drawing => ({ ...d, entities });

function add_(h: Host, label: string, ...list: Entity[]) {
  const d = h.drawing();
  h.commit(label, withEntities(d, [...d.entities, ...list]));
}

function replace(h: Host, label: string, remove: Set<number>, insert: Entity[] = []) {
  const d = h.drawing();
  const out: Entity[] = [];
  let placed = false;
  for (const e of d.entities) {
    if (remove.has(e.id)) {
      if (!placed) {
        out.push(...insert);
        placed = true;
      }
      continue;
    }
    out.push(e);
  }
  if (!placed) out.push(...insert);
  h.commit(label, withEntities(d, out));
}

const ent = (h: Host) => ({ ...h.props(), id: newId() });

const live = (h: Host, e: Entity) => h.drawing().entities.find((x) => x.id === e.id) ?? e;

const lockedLayer = (d: Drawing, e: Entity) => !!findLayer(d, e.layer)?.locked;

/** Leave out what's on locked layers, and say so. */
function unlocked(h: Host, list: Entity[]): Entity[] {
  const d = h.drawing();
  const ok = list.filter((e) => !lockedLayer(d, e));
  if (ok.length < list.length) h.say(`${list.length - ok.length} were on a locked layer.`);
  return ok;
}

const KW = (...names: string[]): Keyword[] => names.map((name) => ({ name }));

// ---- Draw ----------------------------------------------------------------------------------

const line: Command = async (h) => {
  const first = await needPoint(h, 'Specify first point');
  if (typeof first === 'string') return;
  const pts: Vec[] = [first];
  const ids: number[] = [];
  for (;;) {
    const last = pts[pts.length - 1];
    const kws = pts.length >= 3 ? KW('Close', 'Undo') : KW('Undo');
    const p = await point(h, 'Specify next point', { base: last, keywords: kws, preview: (q) => [{ ...ent(h), type: 'line', a: last, b: q }] });
    if (p === null) return;
    if (p === 'Undo') {
      if (pts.length > 1) {
        pts.pop();
        const id = ids.pop()!;
        replace(h, 'Line', new Set([id]));
        h.lastPoint = pts[pts.length - 1];
      } else h.say('All segments already undone.');
      continue;
    }
    if (p === 'Close') {
      const l: Entity = { ...ent(h), type: 'line', a: last, b: pts[0] };
      add_(h, 'Line', l);
      return;
    }
    if (typeof p === 'string') continue;
    if (same(p, last)) continue;
    const l: Entity = { ...ent(h), type: 'line', a: last, b: p };
    ids.push(l.id);
    pts.push(p);
    add_(h, 'Line', l);
  }
};

/** The direction a polyline is heading at its last vertex. */
function plineTangent(pts: PlineVertex[]): Vec {
  if (pts.length < 2) return { x: 1, y: 0 };
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const chord = norm(sub(b, a));
  if (Math.abs(a.b) < 1e-12) return chord;
  const half = 2 * Math.atan(a.b);
  const c = Math.cos(half);
  const s = Math.sin(half);
  return { x: chord.x * c - chord.y * s, y: chord.x * s + chord.y * c };
}

/** The bulge for an arc leaving `from` along `tan` and ending at `to`. */
function tangentBulge(from: Vec, tan: Vec, to: Vec): number {
  const chord = sub(to, from);
  const theta = Math.atan2(tan.x * chord.y - tan.y * chord.x, tan.x * chord.x + tan.y * chord.y);
  return Math.tan(theta / 2);
}

const pline: Command = async (h) => {
  const start = await needPoint(h, 'Specify start point');
  if (typeof start === 'string') return;
  let width = 0;
  h.say(`Current line-width is ${fmt(width)}`);
  const pts: PlineVertex[] = [{ x: start.x, y: start.y, b: 0 }];
  let arcMode = false;
  let closed = false;
  let lastTan: Vec | null = null;
  const build = (extra?: PlineVertex[]): Extract<Entity, { type: 'pline' }> => ({ ...ent(h), type: 'pline', pts: [...pts.map((p) => ({ ...p })), ...(extra ?? [])], closed: false, width });
  const show = () => h.setTemp(pts.length > 1 ? [build()] : []);
  try {
    for (;;) {
      show();
      const last = pts[pts.length - 1];
      const tan = pts.length > 1 ? plineTangent(pts) : (lastTan ?? { x: 1, y: 0 });
      if (!arcMode) {
        const kws = KW('Arc', 'Halfwidth', 'Length', 'Undo', 'Width');
        if (pts.length > 2) kws.splice(1, 0, { name: 'Close' });
        const p = await point(h, 'Specify next point', { base: last, keywords: kws, preview: (q) => [build([{ x: q.x, y: q.y, b: 0 }])] });
        if (p === null) break;
        if (p === 'Arc') {
          arcMode = true;
          continue;
        }
        if (p === 'Close') {
          closed = true;
          break;
        }
        if (p === 'Undo') {
          if (pts.length > 1) pts.pop();
          pts[pts.length - 1].b = 0;
          continue;
        }
        if (p === 'Width' || p === 'Halfwidth') {
          const w = await distance(h, `Specify starting ${p === 'Width' ? 'width' : 'half-width'}`, { base: last, def: p === 'Width' ? width : width / 2 });
          if (typeof w === 'number') width = p === 'Width' ? w : w * 2;
          continue;
        }
        if (p === 'Length') {
          const L = await distance(h, 'Specify length of line', { base: last });
          if (typeof L === 'number') {
            const q = add(last, mul(tan, L));
            pts.push({ x: q.x, y: q.y, b: 0 });
          }
          continue;
        }
        if (typeof p === 'string' || same(p, last)) continue;
        pts.push({ x: p.x, y: p.y, b: 0 });
      } else {
        const kws = KW('Angle', 'CEnter', 'CLose', 'Direction', 'Line', 'Second pt', 'Undo', 'Width');
        const p = await point(h, 'Specify endpoint of arc', {
          base: last,
          keywords: kws,
          rubber: false,
          preview: (q) => (same(q, last) ? [build()] : [{ ...build(), pts: [...pts.slice(0, -1), { ...last, b: tangentBulge(last, tan, q) }, { x: q.x, y: q.y, b: 0 }] }]),
        });
        if (p === null) break;
        if (p === 'Line') {
          arcMode = false;
          continue;
        }
        if (p === 'CLose') {
          if (pts.length > 1) {
            pts[pts.length - 1].b = tangentBulge(last, tan, pts[0]);
            closed = true;
          }
          break;
        }
        if (p === 'Undo') {
          if (pts.length > 1) pts.pop();
          pts[pts.length - 1].b = 0;
          continue;
        }
        if (p === 'Width') {
          const w = await distance(h, 'Specify starting width', { base: last, def: width });
          if (typeof w === 'number') width = w;
          continue;
        }
        if (p === 'Second pt') {
          const s = await needPoint(h, 'Specify second point on arc', { base: last });
          if (typeof s === 'string') continue;
          const e = await needPoint(h, 'Specify end point of arc', {
            base: s,
            rubber: false,
            preview: (q) => [{ ...build(), pts: [...pts.slice(0, -1), { ...last, b: bulge3(last, s, q) }, { x: q.x, y: q.y, b: 0 }] }],
          });
          if (typeof e === 'string') continue;
          last.b = bulge3(last, s, e);
          pts.push({ x: e.x, y: e.y, b: 0 });
          continue;
        }
        if (p === 'CEnter') {
          const c = await needPoint(h, 'Specify center point of arc', { base: last });
          if (typeof c === 'string') continue;
          const e = await needPoint(h, 'Specify end point of arc', {
            base: c,
            preview: (q) => {
              const r = dist(c, last);
              const a1 = angleTo(c, q);
              const b = Math.tan(sweep(angleTo(c, last), a1) / 4);
              return [{ ...build(), pts: [...pts.slice(0, -1), { ...last, b }, { ...polar(c, r, a1), b: 0 }] }];
            },
          });
          if (typeof e === 'string') continue;
          const r = dist(c, last);
          const a1 = angleTo(c, e);
          last.b = Math.tan(sweep(angleTo(c, last), a1) / 4);
          const q = polar(c, r, a1);
          pts.push({ x: q.x, y: q.y, b: 0 });
          continue;
        }
        if (p === 'Angle' || p === 'Direction') {
          h.say('Use an endpoint, Second pt or CEnter.');
          continue;
        }
        if (typeof p === 'string' || same(p, last)) continue;
        last.b = tangentBulge(last, tan, p);
        pts.push({ x: p.x, y: p.y, b: 0 });
      }
      lastTan = plineTangent(pts);
    }
  } finally {
    h.setTemp([]);
    if (pts.length > 1) {
      if (closed && same(pts[pts.length - 1], pts[0]) && pts.length > 2) pts.pop();
      add_(h, 'Polyline', { ...ent(h), type: 'pline', pts, closed, width });
    }
  }
};

function bulge3(a: Vec, m: Vec, b: Vec): number {
  const c = circleThrough(a, m, b);
  if (!c) return 0;
  const a0 = angleTo(c.c, a);
  const am = angleTo(c.c, m);
  const a1 = angleTo(c.c, b);
  const ccw = wrapAngle(am - a0) <= sweep(a0, a1);
  return Math.tan((ccw ? sweep(a0, a1) : -sweep(a1, a0)) / 4);
}

const circle: Command = async (h) => {
  const first = await needPoint(h, 'Specify center point for circle', { keywords: KW('3P', '2P', 'Ttr (tan tan radius)').map((k) => (k.name.startsWith('Ttr') ? { name: k.name, key: 'T' } : k)) });
  const make = (c: Vec, r: number): Entity => ({ ...ent(h), type: 'circle', c, r });
  if (first === '3P') {
    const a = await needPoint(h, 'Specify first point on circle');
    if (typeof a === 'string') return;
    const b = await needPoint(h, 'Specify second point on circle', { base: a });
    if (typeof b === 'string') return;
    const c = await needPoint(h, 'Specify third point on circle', {
      preview: (q) => {
        const k = circleThrough(a, b, q);
        return k ? [make(k.c, k.r)] : [];
      },
    });
    if (typeof c === 'string') return;
    const k = circleThrough(a, b, c);
    if (!k) return h.say('The points are in a line.');
    add_(h, 'Circle', make(k.c, k.r));
    return;
  }
  if (first === '2P') {
    const a = await needPoint(h, 'Specify first end point of circle’s diameter');
    if (typeof a === 'string') return;
    const b = await needPoint(h, 'Specify second end point of circle’s diameter', { base: a, preview: (q) => [make(mid(a, q), dist(a, q) / 2)] });
    if (typeof b === 'string') return;
    add_(h, 'Circle', make(mid(a, b), dist(a, b) / 2));
    return;
  }
  if (typeof first === 'string') {
    // Tangent, tangent, radius.
    const p1 = await pick(h, 'Specify point on object for first tangent of circle', (e) => ['line', 'circle', 'arc'].includes(e.type));
    if (!p1 || typeof p1 === 'string') return;
    const p2 = await pick(h, 'Specify point on object for second tangent of circle', (e) => ['line', 'circle', 'arc'].includes(e.type));
    if (!p2 || typeof p2 === 'string') return;
    const r = await distance(h, 'Specify radius of circle', { def: lastRadius });
    if (typeof r !== 'number' || r <= 0) return;
    const c = ttr(p1, p2, r);
    if (!c) return h.say('Circle does not exist.');
    lastRadius = r;
    add_(h, 'Circle', make(c, r));
    return;
  }
  const c = first;
  const r = await distance(h, 'Specify radius of circle', { base: c, def: lastRadius, keywords: KW('Diameter'), preview: (q) => [make(c, dist(c, q))] });
  let radius: number | null = null;
  if (r === 'Diameter') {
    const dd = await distance(h, 'Specify diameter of circle', { base: c, def: lastRadius * 2, preview: (q) => [make(c, dist(c, q) / 2)] });
    if (typeof dd === 'number') radius = dd / 2;
  } else if (typeof r === 'number') radius = r;
  if (!radius || radius <= 0) return;
  lastRadius = radius;
  add_(h, 'Circle', make(c, radius));
};
let lastRadius = 1;

function ttr(a: { e: Entity; p: Vec }, b: { e: Entity; p: Vec }, r: number): Vec | null {
  const offsets = (x: { e: Entity; p: Vec }): Seg[] => {
    const e = x.e;
    if (e.type === 'line') {
      const n = norm(perp(sub(e.b, e.a)));
      return [1, -1].map((s) => ({ k: 'line' as const, a: add(e.a, mul(n, r * s)), b: add(e.b, mul(n, r * s)) }));
    }
    if (e.type === 'circle' || e.type === 'arc') return [e.r + r, Math.abs(e.r - r)].filter((rr) => rr > 1e-9).map((rr) => ({ k: 'arc' as const, c: e.c, r: rr, a0: 0, a1: TAU }));
    return [];
  };
  let best: Vec | null = null;
  let bd = Infinity;
  for (const s1 of offsets(a))
    for (const s2 of offsets(b)) {
      let pts: Vec[] = [];
      if (s1.k === 'line' && s2.k === 'line') {
        const x = lineLine(s1.a, s1.b, s2.a, s2.b);
        if (x) pts = [x.p];
      } else if (s1.k === 'arc' && s2.k === 'arc') pts = circleCircle(s1.c, s1.r, s2.c, s2.r);
      else {
        const l = (s1.k === 'line' ? s1 : s2) as Extract<Seg, { k: 'line' }>;
        const c = (s1.k === 'arc' ? s1 : s2) as Extract<Seg, { k: 'arc' }>;
        pts = lineCircle(l.a, l.b, c.c, c.r).map((t) => lerp(l.a, l.b, t));
      }
      for (const q of pts) {
        const d = dist(q, a.p) + dist(q, b.p);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
    }
  return best;
}

const arc: Command = async (h) => {
  const make = (c: Vec, r: number, s: number, e: number): Entity => ({ ...ent(h), type: 'arc', c, r, start: s, end: e });
  const threeP = (a: Vec, m: Vec, b: Vec): Entity | null => {
    const k = circleThrough(a, m, b);
    if (!k) return null;
    const a0 = angleTo(k.c, a);
    const a1 = angleTo(k.c, b);
    const ccw = wrapAngle(angleTo(k.c, m) - a0) <= sweep(a0, a1);
    return ccw ? make(k.c, k.r, a0, a1) : make(k.c, k.r, a1, a0);
  };
  const first = await needPoint(h, 'Specify start point of arc', { keywords: KW('Center') });
  if (first === 'Center') {
    const c = await needPoint(h, 'Specify center point of arc');
    if (typeof c === 'string') return;
    const s = await needPoint(h, 'Specify start point of arc', { base: c });
    if (typeof s === 'string') return;
    const r = dist(c, s);
    const a0 = angleTo(c, s);
    const e = await needPoint(h, 'Specify end point of arc (hold Ctrl to switch direction)', { base: c, preview: (q) => [make(c, r, a0, angleTo(c, q))] });
    if (typeof e === 'string') return;
    add_(h, 'Arc', make(c, r, a0, angleTo(c, e)));
    return;
  }
  if (typeof first === 'string') return;
  const second = await needPoint(h, 'Specify second point of arc', { base: first, keywords: KW('Center', 'End') });
  if (second === 'Center') {
    const c = await needPoint(h, 'Specify center point of arc', { base: first });
    if (typeof c === 'string') return;
    const r = dist(c, first);
    const a0 = angleTo(c, first);
    const e = await needPoint(h, 'Specify end point of arc', { base: c, preview: (q) => [make(c, r, a0, angleTo(c, q))] });
    if (typeof e === 'string') return;
    add_(h, 'Arc', make(c, r, a0, angleTo(c, e)));
    return;
  }
  if (second === 'End') {
    const e = await needPoint(h, 'Specify end point of arc', { base: first });
    if (typeof e === 'string') return;
    const c = await needPoint(h, 'Specify center point of arc', {
      base: mid(first, e),
      preview: (q) => {
        const r = dist(q, first);
        return [make(q, r, angleTo(q, first), angleTo(q, e))];
      },
    });
    if (typeof c === 'string') return;
    add_(h, 'Arc', make(c, dist(c, first), angleTo(c, first), angleTo(c, e)));
    return;
  }
  if (typeof second === 'string') return;
  const third = await needPoint(h, 'Specify end point of arc', { preview: (q) => [threeP(first, second, q)].filter((x): x is Entity => !!x) });
  if (typeof third === 'string') return;
  const a = threeP(first, second, third);
  if (!a) return h.say('The points are in a line.');
  add_(h, 'Arc', a);
};

function rectPts(a: Vec, b: Vec, r: number): PlineVertex[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  if (rr <= 1e-12) return [{ x: x0, y: y0, b: 0 }, { x: x1, y: y0, b: 0 }, { x: x1, y: y1, b: 0 }, { x: x0, y: y1, b: 0 }];
  const k = Math.tan(Math.PI / 8);
  return [
    { x: x0 + rr, y: y0, b: 0 },
    { x: x1 - rr, y: y0, b: k },
    { x: x1, y: y0 + rr, b: 0 },
    { x: x1, y: y1 - rr, b: k },
    { x: x1 - rr, y: y1, b: 0 },
    { x: x0 + rr, y: y1, b: k },
    { x: x0, y: y1 - rr, b: 0 },
    { x: x0, y: y0 + rr, b: k },
  ];
}
let rectFillet = 0;

const rectang: Command = async (h) => {
  let a: Vec | string;
  for (;;) {
    a = await needPoint(h, 'Specify first corner point', { keywords: KW('Fillet', 'Width') });
    if (a === 'Fillet') {
      const r = await distance(h, 'Specify fillet radius for rectangles', { def: rectFillet });
      if (typeof r === 'number') rectFillet = r;
      continue;
    }
    if (typeof a !== 'string') break;
  }
  const first = a as Vec;
  const make = (b: Vec): Entity => ({ ...ent(h), type: 'pline', pts: rectPts(first, b, rectFillet), closed: true, width: 0 });
  const b = await needPoint(h, 'Specify other corner point', { base: first, rubber: false, keywords: KW('Dimensions'), preview: (q) => [make(q)] });
  if (b === 'Dimensions') {
    const L = await distance(h, 'Specify length for rectangles', { def: 10 });
    if (typeof L !== 'number') return;
    const W = await distance(h, 'Specify width for rectangles', { def: 10 });
    if (typeof W !== 'number') return;
    const c = await needPoint(h, 'Specify other corner point', {
      base: first,
      rubber: false,
      preview: (q) => [make({ x: first.x + Math.sign(q.x - first.x || 1) * L, y: first.y + Math.sign(q.y - first.y || 1) * W })],
    });
    if (typeof c === 'string') return;
    add_(h, 'Rectangle', make({ x: first.x + Math.sign(c.x - first.x || 1) * L, y: first.y + Math.sign(c.y - first.y || 1) * W }));
    return;
  }
  if (typeof b === 'string') return;
  add_(h, 'Rectangle', make(b));
};

let polygonSides = 4;
const polygon: Command = async (h) => {
  const n = await integer(h, 'Enter number of sides', polygonSides, 3, 1024);
  polygonSides = n;
  const make = (pts: Vec[]): Entity => ({ ...ent(h), type: 'pline', pts: pts.map((p) => ({ ...p, b: 0 })), closed: true, width: 0 });
  const c = await needPoint(h, 'Specify center of polygon', { keywords: KW('Edge') });
  if (c === 'Edge') {
    const a = await needPoint(h, 'Specify first endpoint of edge');
    if (typeof a === 'string') return;
    const edge = (b: Vec) => {
      const pts = [a, b];
      const ext = (2 * Math.PI) / n;
      for (let i = 2; i < n; i++) {
        const p = pts[i - 1];
        const q = pts[i - 2];
        pts.push(add(p, rotateVec(sub(p, q), ext)));
      }
      return pts;
    };
    const b = await needPoint(h, 'Specify second endpoint of edge', { base: a, preview: (q) => [make(edge(q))] });
    if (typeof b === 'string') return;
    add_(h, 'Polygon', make(edge(b)));
    return;
  }
  if (typeof c === 'string') return;
  const mode = await choose(h, 'Enter an option', KW('Inscribed in circle', 'Circumscribed about circle').map((k) => ({ name: k.name, key: k.name[0] })), 'Inscribed in circle');
  const inscribed = mode.startsWith('I');
  const verts = (q: Vec) => {
    const r = dist(c, q);
    const a0 = angleTo(c, q);
    const R = inscribed ? r : r / Math.cos(Math.PI / n);
    const off = inscribed ? 0 : Math.PI / n;
    return Array.from({ length: n }, (_, i) => polar(c, R, a0 + off + (2 * Math.PI * i) / n));
  };
  const r = await distance(h, 'Specify radius of circle', { base: c, preview: (q) => [make(verts(q))] });
  if (typeof r !== 'number') return;
  const lp = h.lastPoint;
  const dir = lp && dist(lp, c) > 1e-9 && Math.abs(dist(lp, c) - r) < 1e-9 ? lp : polar(c, r, inscribed ? Math.PI / 2 + Math.PI / n : -Math.PI / 2 - Math.PI / n + Math.PI / n);
  add_(h, 'Polygon', make(verts(dir)));
};

const rotateVec = (v: Vec, a: number): Vec => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

const ellipse: Command = async (h) => {
  const make = (c: Vec, major: Vec, ratio: number): Entity => ({ ...ent(h), type: 'ellipse', c, major, ratio: Math.max(1e-6, Math.min(1, ratio)), start: 0, end: TAU });
  const fixRatio = (c: Vec, major: Vec, ratio: number) => (ratio > 1 ? make(c, mul(perp(major), ratio), 1 / ratio) : make(c, major, ratio));
  const first = await needPoint(h, 'Specify axis endpoint of ellipse', { keywords: KW('Center') });
  let c: Vec;
  let major: Vec;
  if (first === 'Center') {
    const cc = await needPoint(h, 'Specify center of ellipse');
    if (typeof cc === 'string') return;
    const e = await needPoint(h, 'Specify endpoint of axis', { base: cc });
    if (typeof e === 'string') return;
    c = cc;
    major = sub(e, cc);
  } else {
    if (typeof first === 'string') return;
    const e = await needPoint(h, 'Specify other endpoint of axis', { base: first });
    if (typeof e === 'string') return;
    c = mid(first, e);
    major = sub(e, c);
  }
  const L = Math.hypot(major.x, major.y);
  if (L < 1e-12) return;
  const other = await distance(h, 'Specify distance to other axis', { base: c, preview: (q) => [fixRatio(c, major, Math.abs(dot(sub(q, c), norm(perp(major)))) / L)] });
  if (typeof other !== 'number' || other <= 0) return;
  // Picked points measure perpendicular to the major axis.
  const lp = h.lastPoint;
  const r = lp && Math.abs(dist(lp, c) - other) < 1e-9 ? Math.abs(dot(sub(lp, c), norm(perp(major)))) : other;
  add_(h, 'Ellipse', fixRatio(c, major, r / L));
};

const spline: Command = async (h) => {
  const first = await needPoint(h, 'Specify first point');
  if (typeof first === 'string') return;
  const fit: Vec[] = [first];
  let closed = false;
  const make = (pts: Vec[]): Entity => {
    const list = closed ? [...pts, pts[0]] : pts;
    const s = interpolateSpline(list);
    return { ...ent(h), type: 'spline', degree: s.degree, knots: s.knots, ctrl: s.ctrl, fit: list, closed };
  };
  try {
    for (;;) {
      h.setTemp(fit.length > 1 ? [make(fit)] : []);
      const kws = fit.length >= 3 ? KW('Close', 'Undo') : KW('Undo');
      const p = await point(h, 'Enter next point', { base: fit[fit.length - 1], keywords: kws, preview: (q) => [make([...fit, q])] });
      if (p === null) break;
      if (p === 'Undo') {
        if (fit.length > 1) fit.pop();
        continue;
      }
      if (p === 'Close') {
        closed = true;
        break;
      }
      if (typeof p === 'string' || same(p, fit[fit.length - 1])) continue;
      fit.push(p);
    }
  } finally {
    h.setTemp([]);
    if (fit.length > 1) add_(h, 'Spline', make(fit));
  }
};

const pointCmd = (multiple: boolean): Command => async (h) => {
  const d = h.drawing();
  h.say(`Current point modes:  PDMODE=${d.header.pdmode}  PDSIZE=${fmt(d.header.pdsize)}`);
  for (;;) {
    const p = await needPoint(h, 'Specify a point');
    if (typeof p === 'string') return;
    add_(h, 'Point', { ...ent(h), type: 'point', p });
    if (!multiple) return;
  }
};

const xline: Command = async (h) => {
  let dir: Vec | null = null;
  const first = await needPoint(h, 'Specify a point', { keywords: KW('Hor', 'Ver', 'Ang', 'Bisect') });
  if (first === 'Hor') dir = { x: 1, y: 0 };
  else if (first === 'Ver') dir = { x: 0, y: 1 };
  else if (first === 'Ang') {
    const a = await angle(h, 'Enter angle of xline', { def: 0 });
    if (typeof a !== 'number') return;
    dir = { x: Math.cos(a), y: Math.sin(a) };
  } else if (first === 'Bisect') {
    const v = await needPoint(h, 'Specify angle vertex point');
    if (typeof v === 'string') return;
    const a = await needPoint(h, 'Specify angle start point', { base: v });
    if (typeof a === 'string') return;
    for (;;) {
      const b = await point(h, 'Specify angle end point', { base: v, preview: (q) => [{ ...ent(h), type: 'xline', p: v, dir: norm(add(norm(sub(a, v)), norm(sub(q, v)))) }] });
      if (b === null || typeof b === 'string') return;
      add_(h, 'Xline', { ...ent(h), type: 'xline', p: v, dir: norm(add(norm(sub(a, v)), norm(sub(b, v)))) });
    }
  }
  if (dir) {
    for (;;) {
      const p = await point(h, 'Specify through point', { preview: (q) => [{ ...ent(h), type: 'xline', p: q, dir: dir! }] });
      if (p === null || typeof p === 'string') return;
      add_(h, 'Xline', { ...ent(h), type: 'xline', p, dir });
    }
  }
  if (typeof first === 'string') return;
  for (;;) {
    const p = await point(h, 'Specify through point', { base: first, preview: (q) => (same(q, first) ? [] : [{ ...ent(h), type: 'xline', p: first, dir: norm(sub(q, first)) }]) });
    if (p === null || typeof p === 'string') return;
    if (!same(p, first)) add_(h, 'Xline', { ...ent(h), type: 'xline', p: first, dir: norm(sub(p, first)) });
  }
};

const ray: Command = async (h) => {
  const first = await needPoint(h, 'Specify start point');
  if (typeof first === 'string') return;
  for (;;) {
    const p = await point(h, 'Specify through point', { base: first, preview: (q) => (same(q, first) ? [] : [{ ...ent(h), type: 'ray', p: first, dir: norm(sub(q, first)) }]) });
    if (p === null || typeof p === 'string') return;
    if (!same(p, first)) add_(h, 'Ray', { ...ent(h), type: 'ray', p: first, dir: norm(sub(p, first)) });
  }
};

let donutIn = 0.5;
let donutOut = 1;
const donut: Command = async (h) => {
  const i = await distance(h, 'Specify inside diameter of donut', { def: donutIn });
  if (typeof i !== 'number') return;
  const o = await distance(h, 'Specify outside diameter of donut', { def: donutOut });
  if (typeof o !== 'number' || o <= i) return;
  donutIn = i;
  donutOut = o;
  const r = (i + o) / 4;
  const w = (o - i) / 2;
  const make = (c: Vec): Entity => ({ ...ent(h), type: 'pline', pts: [{ x: c.x - r, y: c.y, b: 1 }, { x: c.x + r, y: c.y, b: 1 }], closed: true, width: w });
  for (;;) {
    const c = await point(h, 'Specify center of donut or <exit>', { preview: (q) => [make(q)] });
    if (c === null || typeof c === 'string') return;
    add_(h, 'Donut', make(c));
  }
};

// ---- Text ----------------------------------------------------------------------------------

const JUSTIFY: [string, HAlign, VAlign][] = [
  ['Left', 0, 0],
  ['Center', 1, 0],
  ['Right', 2, 0],
  ['Align', 3, 0],
  ['Middle', 4, 0],
  ['Fit', 5, 0],
  ['TL', 0, 3],
  ['TC', 1, 3],
  ['TR', 2, 3],
  ['ML', 0, 2],
  ['MC', 1, 2],
  ['MR', 2, 2],
  ['BL', 0, 1],
  ['BC', 1, 1],
  ['BR', 2, 1],
];

const dtext: Command = async (h) => {
  const d = h.drawing();
  let styleName = d.header.textstyle;
  let just: [HAlign, VAlign] = [0, 0];
  let h0 = d.header.textsize;
  const style = () => findTextStyle(h.drawing(), styleName);
  h.say(`Current text style:  "${style()?.name ?? styleName}"  Text height:  ${fmt(h0)}  Annotative:  No  Justify:  ${JUSTIFY.find((j) => j[1] === just[0] && j[2] === just[1])?.[0] ?? 'Left'}`);
  let p: Vec | string;
  for (;;) {
    p = await needPoint(h, 'Specify start point of text', { keywords: KW('Justify', 'Style') });
    if (p === 'Justify') {
      const k = await choose(h, 'Enter an option', JUSTIFY.map(([n]) => ({ name: n, key: n.length <= 2 ? n : n[0] })), 'Left');
      const j = JUSTIFY.find((x) => x[0] === k);
      if (j) just = [j[1], j[2]];
      continue;
    }
    if (p === 'Style') {
      const s = await text(h, 'Enter style name', styleName);
      if (s && findTextStyle(h.drawing(), s)?.name.toUpperCase() === s.toUpperCase()) styleName = s;
      else if (s) h.say(`Can't find text style “${s}”.`);
      continue;
    }
    break;
  }
  if (typeof p === 'string') return;
  let end: Vec | null = null;
  if (just[0] === 3 || just[0] === 5) {
    const e = await needPoint(h, 'Specify second endpoint of text baseline', { base: p });
    if (typeof e === 'string') return;
    end = e;
  }
  const fixed = style()?.height ?? 0;
  if (fixed > 0) h0 = fixed;
  else if (just[0] !== 3) {
    const hh = await distance(h, 'Specify height', { base: p, def: h0 });
    if (typeof hh !== 'number' || hh <= 0) return;
    h0 = hh;
  }
  let rot = end ? angleTo(p, end) : 0;
  if (!end) {
    const r = await angle(h, 'Specify rotation angle of text', { base: p, def: 0 });
    if (typeof r !== 'number') return;
    rot = r;
  }
  h.commit('Text', { ...h.drawing(), header: { ...h.drawing().header, textsize: h0 } });
  let at = p;
  const down = { x: Math.sin(rot) * h0 * (5 / 3), y: -Math.cos(rot) * h0 * (5 / 3) };
  for (;;) {
    const s = await h.editText({ p: at, h: h0, rot, style: styleName, initial: '' });
    if (s === null || s === '') return;
    const t: Text = { ...ent(h), type: 'text', p: at, a: end ?? at, h: h0, rot, text: s, style: style()?.name ?? styleName, wf: 1, oblique: 0, halign: just[0], valign: just[1] };
    add_(h, 'Text', t);
    if (end) return;
    at = add(at, down);
  }
};

const mtext: Command = async (h) => {
  const d = h.drawing();
  let hh = d.header.textsize;
  let attach = 1;
  const style = findTextStyle(d, d.header.textstyle);
  h.say(`Current text style:  "${style?.name ?? 'Standard'}"  Text height:  ${fmt(hh)}  Annotative:  No`);
  const a = await needPoint(h, 'Specify first corner');
  if (typeof a === 'string') return;
  let b: Vec | string;
  for (;;) {
    b = await needPoint(h, 'Specify opposite corner', { base: a, box: true, rubber: false, keywords: KW('Height', 'Justify') });
    if (b === 'Height') {
      const v = await distance(h, 'Specify height', { base: a, def: hh });
      if (typeof v === 'number' && v > 0) hh = v;
      continue;
    }
    if (b === 'Justify') {
      const k = await choose(h, 'Enter justification', KW('TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'), 'TL');
      attach = ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'].indexOf(k) + 1 || 1;
      continue;
    }
    break;
  }
  if (typeof b === 'string') return;
  const width = Math.abs(b.x - a.x);
  const x0 = Math.min(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const y0 = Math.min(a.y, b.y);
  const col = (attach - 1) % 3;
  const row = Math.floor((attach - 1) / 3);
  const p = { x: x0 + (col * width) / 2, y: row === 0 ? y1 : row === 1 ? (y0 + y1) / 2 : y0 };
  const s = await h.editMText({ p, h: hh, rot: 0, style: style?.name ?? 'Standard', initial: '', width, attach });
  if (!s) return;
  add_(h, 'MText', { ...ent(h), type: 'mtext', p, h: hh, width, rot: 0, attach, text: s, style: style?.name ?? 'Standard', spacing: 1 });
  h.commit('MText', { ...h.drawing(), header: { ...h.drawing().header, textsize: hh } });
};

const textedit: Command = async (h) => {
  for (;;) {
    const r = await pick(h, 'Select an annotation object', (e) => e.type === 'text' || e.type === 'mtext' || e.type === 'attdef' || e.type === 'dim', KW('Undo'));
    if (r === null) return;
    if (r === 'Undo') {
      h.undo();
      continue;
    }
    if (typeof r === 'string') continue;
    await editAnnotation(h, r.e);
  }
};

export async function editAnnotation(h: Host, e0: Entity) {
  const e = live(h, e0);
  if (e.type === 'text' || e.type === 'attdef') {
    const s = await h.editText({ p: e.p, h: e.h, rot: e.rot, style: e.style, initial: e.type === 'attdef' ? e.tag : e.text });
    if (s === null || s === '') return;
    replace(h, 'Edit Text', new Set([e.id]), [e.type === 'attdef' ? { ...e, id: newId(), tag: s.toUpperCase() } : { ...e, id: newId(), text: s }]);
  } else if (e.type === 'mtext') {
    const s = await h.editMText({ p: e.p, h: e.h, rot: e.rot, style: e.style, initial: e.text, width: e.width, attach: e.attach });
    if (s === null) return;
    replace(h, 'Edit MText', new Set([e.id]), s ? [{ ...e, id: newId(), text: s }] : []);
  } else if (e.type === 'dim') {
    const s = await text(h, 'Enter new dimension text (<> is the measurement)', e.override || '<>', true);
    if (s === null) return;
    replace(h, 'Edit Dimension', new Set([e.id]), [{ ...e, id: newId(), override: s === '<>' ? '' : s, block: undefined }]);
  }
}

// ---- Dimensions -----------------------------------------------------------------------------

function newDim(h: Host, kind: DimKind, p: Partial<Dimension>): Dimension {
  const d = h.drawing();
  const dim: Dimension = {
    ...ent(h),
    type: 'dim',
    kind,
    style: d.header.dimstyle,
    p10: { x: 0, y: 0 },
    p13: { x: 0, y: 0 },
    p14: { x: 0, y: 0 },
    p15: { x: 0, y: 0 },
    text: { x: 0, y: 0 },
    rot: 0,
    override: '',
    textMoved: false,
    ...p,
  };
  dim.measurement = measure(dim);
  return dim;
}

/** Where a linear dimension's text goes with its line through p10. */
function linearText(a: Vec, b: Vec, p10: Vec, rot: number, h: Host): Vec {
  const s = findDimStyle(h.drawing(), h.drawing().header.dimstyle);
  const u = { x: Math.cos(rot), y: Math.sin(rot) };
  const proj = (p: Vec) => add(p10, mul(u, dot(sub(p, p10), u)));
  const m = mid(proj(a), proj(b));
  const n = perp(u);
  const k = s.dimscale || 1;
  return s.dimtad > 0 ? add(m, mul(n, (s.dimgap + s.dimtxt / 2) * k * (n.y < 0 || (n.y === 0 && n.x < 0) ? -1 : 1))) : m;
}

async function dimOrigins(h: Host): Promise<[Vec, Vec] | null> {
  const a = await point(h, 'Specify first extension line origin or <select object>');
  if (a === null) {
    const r = await pick(h, 'Select object to dimension', (e) => e.type === 'line' || e.type === 'pline' || e.type === 'arc' || e.type === 'circle');
    if (!r || typeof r === 'string') return null;
    const e = r.e;
    if (e.type === 'line') return [e.a, e.b];
    const seg = entitySegs(e).reduce((best, s) => (distToSeg(s, r.p) < distToSeg(best, r.p) ? s : best));
    if (seg.k === 'line') return [seg.a, seg.b];
    return [polar(seg.c, seg.r, seg.a0), polar(seg.c, seg.r, seg.a1)];
  }
  if (typeof a === 'string') return null;
  const b = await needPoint(h, 'Specify second extension line origin', { base: a });
  if (typeof b === 'string') return null;
  return [a, b];
}

const dimlinear =
  (aligned: boolean): Command =>
  async (h) => {
    const o = await dimOrigins(h);
    if (!o) return;
    const [a, b] = o;
    let override = '';
    let fixedRot: number | null = null;
    const make = (q: Vec): Dimension => {
      let rot: number;
      if (aligned) rot = angleTo(a, b);
      else if (fixedRot !== null) rot = fixedRot;
      else {
        // Outside the points' box left or right: a vertical dimension.
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y, b.y);
        const outX = q.x < x0 || q.x > x1;
        const outY = q.y < y0 || q.y > y1;
        rot = outX && !outY ? Math.PI / 2 : 0;
      }
      return newDim(h, aligned ? 'aligned' : 'linear', { p13: a, p14: b, p10: q, rot, text: linearText(a, b, q, rot, h), override });
    };
    for (;;) {
      const kws = aligned ? KW('Mtext', 'Text', 'Angle') : KW('Mtext', 'Text', 'Angle', 'Horizontal', 'Vertical', 'Rotated');
      const q = await needPoint(h, 'Specify dimension line location', { keywords: kws, preview: (p) => [make(p)] });
      if (q === 'Text' || q === 'Mtext') {
        const s = await text(h, 'Enter dimension text', `<${dimText(make(b), findDimStyle(h.drawing(), h.drawing().header.dimstyle))}>`, true);
        if (s !== null) override = /^<.*>$/.test(s) ? '' : s;
        continue;
      }
      if (q === 'Horizontal') fixedRot = 0;
      else if (q === 'Vertical') fixedRot = Math.PI / 2;
      else if (q === 'Rotated') {
        const r = await angle(h, 'Specify angle of dimension line', { def: 0 });
        if (typeof r === 'number') fixedRot = r;
      } else if (q === 'Angle') h.say('Text angle follows the dimension style.');
      if (typeof q === 'string') continue;
      const dim = make(q);
      h.say(`Dimension text = ${dimText(dim, findDimStyle(h.drawing(), dim.style)).replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø')}`);
      add_(h, aligned ? 'Aligned Dimension' : 'Linear Dimension', dim);
      return;
    }
  };

const dimradial =
  (diameter: boolean): Command =>
  async (h) => {
    const r = await pick(h, 'Select arc or circle', (e) => e.type === 'arc' || e.type === 'circle' || (e.type === 'pline' && e.pts.some((p) => p.b !== 0)));
    if (!r || typeof r === 'string') return;
    let c: Vec;
    let rad: number;
    if (r.e.type === 'pline') {
      const seg = entitySegs(r.e).filter((s) => s.k === 'arc')[0] as Extract<Seg, { k: 'arc' }>;
      c = seg.c;
      rad = seg.r;
    } else if (r.e.type === 'arc' || r.e.type === 'circle') {
      c = r.e.c;
      rad = r.e.r;
    } else return;
    h.say(`Dimension text = ${fmt(diameter ? rad * 2 : rad)}`);
    const make = (q: Vec): Dimension => {
      const a = angleTo(c, same(q, c) ? add(c, { x: 1, y: 0 }) : q);
      const on = polar(c, rad, a);
      return diameter ? newDim(h, 'diameter', { p15: on, p10: polar(c, rad, a + Math.PI), text: q, textMoved: true }) : newDim(h, 'radius', { p10: c, p15: on, text: q, textMoved: true });
    };
    const q = await needPoint(h, 'Specify dimension line location', { preview: (p) => [make(p)] });
    if (typeof q === 'string') return;
    add_(h, diameter ? 'Diameter Dimension' : 'Radius Dimension', make(q));
  };

const dimangular: Command = async (h) => {
  const r = await pick(h, 'Select arc, circle, line, or <specify vertex>', (e) => e.type === 'line' || e.type === 'arc' || e.type === 'circle');
  let vertex: Vec;
  let p1: Vec;
  let p2: Vec;
  if (r === null) {
    const v = await needPoint(h, 'Specify angle vertex');
    if (typeof v === 'string') return;
    const a = await needPoint(h, 'Specify first angle endpoint', { base: v });
    if (typeof a === 'string') return;
    const b = await needPoint(h, 'Specify second angle endpoint', { base: v });
    if (typeof b === 'string') return;
    vertex = v;
    p1 = a;
    p2 = b;
  } else if (typeof r === 'string') return;
  else if (r.e.type === 'arc') {
    vertex = r.e.c;
    p1 = polar(r.e.c, r.e.r, r.e.start);
    p2 = polar(r.e.c, r.e.r, r.e.end);
  } else if (r.e.type === 'circle') {
    vertex = r.e.c;
    p1 = r.p;
    const b = await needPoint(h, 'Specify second angle endpoint', { base: vertex });
    if (typeof b === 'string') return;
    p2 = b;
  } else {
    const l1 = r.e;
    const r2 = await pick(h, 'Select second line', (e) => e.type === 'line');
    if (!r2 || typeof r2 === 'string' || r2.e.type !== 'line' || l1.type !== 'line') return;
    const l2 = r2.e;
    const x = lineLine(l1.a, l1.b, l2.a, l2.b);
    if (!x) return h.say('Lines are parallel.');
    const make2 = (q: Vec) => newDim(h, 'angular', { p13: l1.a, p14: l1.b, p10: l2.a, p15: l2.b, p16: q, text: q });
    const q = await needPoint(h, 'Specify dimension arc line location', { preview: (p) => [make2(p)] });
    if (typeof q === 'string') return;
    const dim = make2(q);
    dim.textMoved = false;
    add_(h, 'Angular Dimension', dim);
    return;
  }
  const make = (q: Vec) => {
    const dim = newDim(h, 'angular3', { p15: vertex, p13: p1, p14: p2, p10: q, text: q });
    return dim;
  };
  const q = await needPoint(h, 'Specify dimension arc line location', { preview: (p) => [make(p)] });
  if (typeof q === 'string') return;
  add_(h, 'Angular Dimension', make(q));
};

const dimordinate: Command = async (h) => {
  const f = await needPoint(h, 'Specify feature location');
  if (typeof f === 'string') return;
  const make = (q: Vec) => {
    const xType = Math.abs(q.y - f.y) > Math.abs(q.x - f.x);
    return newDim(h, 'ordinate', { p10: { x: 0, y: 0 }, p13: f, p14: q, text: q, ordinateX: xType });
  };
  const q = await needPoint(h, 'Specify leader endpoint', { base: f, preview: (p) => [make(p)] });
  if (typeof q === 'string') return;
  add_(h, 'Ordinate Dimension', make(q));
};

const leader: Command = async (h) => {
  const first = await needPoint(h, 'Specify first leader point');
  if (typeof first === 'string') return;
  const pts = [first];
  const make = (extra: Vec[] = []): Extract<Entity, { type: 'leader' }> => ({ ...ent(h), type: 'leader', pts: [...pts, ...extra], arrow: true, style: h.drawing().header.dimstyle, spline: false });
  for (;;) {
    h.setTemp(pts.length > 1 ? [make()] : []);
    const p = await point(h, 'Specify next point', { base: pts[pts.length - 1], preview: (q) => [make([q])] });
    if (p === null) break;
    if (typeof p === 'string') continue;
    pts.push(p);
    if (pts.length >= 3) break;
  }
  h.setTemp([]);
  if (pts.length < 2) return;
  const d = h.drawing();
  const style = findDimStyle(d, d.header.dimstyle);
  const k = style.dimscale || 1;
  const lines: string[] = [];
  for (;;) {
    const s = await text(h, lines.length ? 'Enter next line of annotation text' : 'Enter first line of annotation text', undefined, true);
    if (!s) break;
    lines.push(s);
  }
  const end = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const right = end.x >= prev.x;
  const out: Entity[] = [{ ...make(), pts: [...pts] }];
  if (lines.length) {
    const gap = style.dimgap * k;
    const th = style.dimtxt * k;
    out.push({ ...ent(h), type: 'mtext', p: add(end, { x: right ? gap : -gap, y: 0 }), h: th, width: 0, rot: 0, attach: right ? 4 : 6, text: lines.map(escapeMText).join('\\P'), style: style.dimtxsty, spacing: 1 });
  }
  add_(h, 'Leader', ...out);
};

export const escapeMText = (s: string) => s.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');

// ---- Hatch ----------------------------------------------------------------------------------

const hatch: Command = async (h) => {
  h.hatch.begin();
  const loops: Hatch['loops'] = [];
  const make = (): Hatch => {
    const st = h.hatch.get();
    const solid = st.pattern.toUpperCase() === 'SOLID';
    const ang = (st.angle * Math.PI) / 180;
    return { ...ent(h), type: 'hatch', loops: [...loops], solid, pattern: st.pattern.toUpperCase(), angle: ang, scale: st.scale, lines: solid ? [] : patternLines(st.pattern, ang, st.scale, h.metric), style: 0, patternType: 1, double: false };
  };
  try {
    for (;;) {
      h.setTemp(loops.length ? [make()] : []);
      const p = await point(h, 'Pick internal point', { keywords: KW('Select objects', 'Undo').map((k) => ({ ...k, key: k.name[0] })) });
      if (p === null) break;
      if (p === 'Undo') {
        loops.pop();
        continue;
      }
      if (p === 'Select objects') {
        const list = await objects(h, 'Select objects', (e) => e.type === 'circle' || (e.type === 'pline' && e.closed) || e.type === 'ellipse' || (e.type === 'spline' && e.closed));
        for (const e of list) {
          const region = findRegion(h.drawing(), [e], e.type === 'circle' || e.type === 'ellipse' ? e.c : e.type === 'pline' ? centroid(e.pts) : e.type === 'spline' ? centroid(e.ctrl) : { x: 0, y: 0 });
          if (region) loops.push(region.loops[0]);
          else if (e.type === 'pline') loops.push({ kind: 'poly', pts: e.pts.map((q) => ({ ...q })), closed: true, flags: 1 });
        }
        continue;
      }
      if (typeof p === 'string') continue;
      h.say('Analyzing the selected data...');
      const region = findRegion(h.drawing(), h.visible(), p);
      if (!region) {
        h.say('Valid hatch boundary not found.');
        continue;
      }
      loops.push(...region.loops);
    }
  } finally {
    h.setTemp([]);
    h.hatch.end();
  }
  if (loops.length) add_(h, 'Hatch', make());
};

function centroid(pts: Vec[]): Vec {
  const n = pts.length || 1;
  return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
}

const boundary: Command = async (h) => {
  for (;;) {
    const p = await point(h, 'Pick internal point');
    if (p === null || typeof p === 'string') return;
    const region = findRegion(h.drawing(), h.visible(), p);
    if (!region) {
      h.say('Valid boundary not found.');
      continue;
    }
    const pl: Entity = { ...ent(h), type: 'pline', pts: region.outer.map((q) => ({ x: q.x, y: q.y, b: 0 })), closed: true, width: 0 };
    add_(h, 'Boundary', pl);
    h.say('BOUNDARY created 1 polyline');
  }
};

// ---- Modify -------------------------------------------------------------------------------

/** Transform objects, with a live preview of where they'll go. */
async function transformCmd(h: Host, label: string, list: Entity[], copy: boolean, m: Mat) {
  const moved = list.map((e) => transformEntity({ ...e, id: copy ? newId() : e.id }, m));
  const d = h.drawing();
  if (copy) h.commit(label, withEntities(d, [...d.entities, ...moved]));
  else {
    const byId = new Map(moved.map((e) => [e.id, e]));
    h.commit(label, withEntities(d, d.entities.map((e) => byId.get(e.id) ?? e)));
  }
  return moved;
}

const ghost = (list: Entity[], m: Mat) => list.map((e) => transformEntity(e, m));

async function basePoint(h: Host, list: Entity[]): Promise<{ base: Vec; second: Vec } | null> {
  const b = await needPoint(h, 'Specify base point', { keywords: KW('Displacement'), default: 'Displacement' });
  if (b === 'Displacement') {
    const dd = await needPoint(h, 'Specify displacement', { default: '0,0' });
    if (typeof dd === 'string') return null;
    return { base: { x: 0, y: 0 }, second: dd };
  }
  if (typeof b === 'string') return null;
  const s = await point(h, 'Specify second point or <use first point as displacement>', { base: b, preview: (q) => ghost(list, translation(q.x - b.x, q.y - b.y)) });
  if (s === null) return { base: { x: 0, y: 0 }, second: b };
  if (typeof s === 'string') return null;
  return { base: b, second: s };
}

const move: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  const bp = await basePoint(h, list);
  if (!bp) return;
  await transformCmd(h, 'Move', list, false, translation(bp.second.x - bp.base.x, bp.second.y - bp.base.y));
  h.setSelection([]);
};

const copy: Command = async (h) => {
  const list = await objects(h);
  if (!list.length) return;
  h.say('Current settings:  Copy mode = Multiple');
  const b = await needPoint(h, 'Specify base point', { keywords: KW('Displacement') });
  if (b === 'Displacement') {
    const dd = await needPoint(h, 'Specify displacement');
    if (typeof dd === 'string') return;
    await transformCmd(h, 'Copy', list, true, translation(dd.x, dd.y));
    return;
  }
  if (typeof b === 'string') return;
  const made: number[][] = [];
  for (;;) {
    const s = await point(h, 'Specify second point', { base: b, keywords: made.length ? KW('Exit', 'Undo') : KW('Array'), preview: (q) => ghost(list, translation(q.x - b.x, q.y - b.y)) });
    if (s === null || s === 'Exit') return;
    if (s === 'Undo') {
      const ids = made.pop();
      if (ids) replace(h, 'Copy', new Set(ids));
      continue;
    }
    if (s === 'Array') {
      const n = await integer(h, 'Enter number of items to array', 2, 2, 10000);
      const e = await needPoint(h, 'Specify second point', { base: b, keywords: KW('Fit'), preview: (q) => Array.from({ length: n - 1 }, (_, i) => ghost(list, translation((q.x - b.x) * (i + 1), (q.y - b.y) * (i + 1)))).flat() });
      if (typeof e === 'string') continue;
      const all: Entity[] = [];
      for (let i = 1; i < n; i++) all.push(...list.map((x) => transformEntity({ ...x, id: newId() }, translation((e.x - b.x) * i, (e.y - b.y) * i))));
      add_(h, 'Copy', ...all);
      made.push(all.map((x) => x.id));
      continue;
    }
    if (typeof s === 'string') continue;
    const moved = await transformCmd(h, 'Copy', list, true, translation(s.x - b.x, s.y - b.y));
    made.push(moved.map((x) => x.id));
  }
};

const rotate: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  h.say('Current positive angle in UCS:  ANGDIR=counterclockwise  ANGBASE=0');
  const b = await needPoint(h, 'Specify base point');
  if (typeof b === 'string') return;
  let keep = false;
  for (;;) {
    const a = await angle(h, 'Specify rotation angle', { base: b, def: 0, keywords: KW('Copy', 'Reference'), preview: (q) => ghost(list, rotation(b, angleTo(b, q))) });
    if (a === 'Copy') {
      keep = true;
      h.say('Rotating a copy of the selected objects.');
      continue;
    }
    if (a === 'Reference') {
      const r = await angle(h, 'Specify the reference angle', { def: 0 });
      if (typeof r !== 'number') return;
      const n = await angle(h, 'Specify the new angle', { base: b, preview: (q) => ghost(list, rotation(b, angleTo(b, q) - r)) });
      if (typeof n !== 'number') return;
      await transformCmd(h, 'Rotate', list, keep, rotation(b, n - r));
      return;
    }
    if (typeof a !== 'number') return;
    await transformCmd(h, 'Rotate', list, keep, rotation(b, a));
    h.setSelection([]);
    return;
  }
};

const scale: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  const b = await needPoint(h, 'Specify base point');
  if (typeof b === 'string') return;
  let keep = false;
  for (;;) {
    const f = await distance(h, 'Specify scale factor', { base: b, def: 1, keywords: KW('Copy', 'Reference'), preview: (q) => ghost(list, scaling(b, Math.max(1e-9, dist(b, q)))) });
    if (f === 'Copy') {
      keep = true;
      h.say('Scaling a copy of the selected objects.');
      continue;
    }
    if (f === 'Reference') {
      const r = await distance(h, 'Specify reference length', { def: 1 });
      if (typeof r !== 'number' || r <= 0) return;
      const n = await distance(h, 'Specify new length', { base: b, preview: (q) => ghost(list, scaling(b, dist(b, q) / r)) });
      if (typeof n !== 'number' || n <= 0) return;
      await transformCmd(h, 'Scale', list, keep, scaling(b, n / r));
      return;
    }
    if (typeof f !== 'number' || f <= 0) return h.say(typeof f === 'number' ? 'Value must be positive and nonzero.' : '');
    await transformCmd(h, 'Scale', list, keep, scaling(b, f));
    h.setSelection([]);
    return;
  }
};

const mirror: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  const a = await needPoint(h, 'Specify first point of mirror line');
  if (typeof a === 'string') return;
  const b = await needPoint(h, 'Specify second point of mirror line', { base: a, preview: (q) => (same(q, a) ? [] : ghost(list, mirroring(a, q))) });
  if (typeof b === 'string' || same(a, b)) return;
  const erase = await choose(h, 'Erase source objects?', KW('Yes', 'No'), 'No');
  await transformCmd(h, 'Mirror', list, erase === 'No', mirroring(a, b));
  h.setSelection([]);
};

const stretchCmd: Command = async (h) => {
  h.say('Select objects to stretch by crossing-window or crossing-polygon...');
  const a = await needPoint(h, 'Specify first corner');
  if (typeof a === 'string') return;
  const b = await needPoint(h, 'Specify opposite corner', { base: a, box: true, rubber: false });
  if (typeof b === 'string') return;
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  const d = h.drawing();
  const list = unlocked(
    h,
    d.entities.filter((e) => worldSegs(e, d).some((s) => segInBoxish(s, min, max)) || (anchorOf(e) && inBox(anchorOf(e)!, min, max))),
  );
  h.say(`${list.length} found`);
  if (!list.length) return;
  const bp = await needPoint(h, 'Specify base point', { keywords: KW('Displacement') });
  if (typeof bp === 'string') return;
  const s = await needPoint(h, 'Specify second point', { base: bp, preview: (q) => list.map((e) => stretch(e, min, max, sub(q, bp))) });
  if (typeof s === 'string') return;
  const delta = sub(s, bp);
  const byId = new Map(list.map((e) => [e.id, { ...stretch(e, min, max, delta), id: e.id }]));
  h.commit('Stretch', withEntities(d, d.entities.map((e) => byId.get(e.id) ?? e)));
};

const inBox = (p: Vec, min: Vec, max: Vec) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
function segInBoxish(s: Seg, min: Vec, max: Vec) {
  const pts = s.k === 'line' ? [s.a, s.b] : [polar(s.c, s.r, s.a0), polar(s.c, s.r, s.a1)];
  return pts.some((p) => inBox(p, min, max));
}

let offsetDist: number | 'Through' = 'Through';
const offsetCmd: Command = async (h) => {
  h.say('Current settings: Erase source=No  Layer=Source  OFFSETGAPTYPE=0');
  const dd = await distance(h, 'Specify offset distance', { keywords: KW('Through', 'Erase', 'Layer'), def: offsetDist === 'Through' ? undefined : offsetDist });
  if (dd === 'Through') offsetDist = 'Through';
  else if (typeof dd === 'number' && dd > 0) offsetDist = dd;
  else if (dd === null && offsetDist === 'Through') offsetDist = 'Through';
  else if (typeof dd !== 'number' && dd !== null) return;
  const made: number[][] = [];
  for (;;) {
    const r = await pick(h, 'Select object to offset', (e) => ['line', 'arc', 'circle', 'pline', 'ellipse', 'spline', 'xline', 'ray'].includes(e.type), KW('Exit', 'Undo'));
    if (r === null || r === 'Exit') return;
    if (r === 'Undo') {
      const ids = made.pop();
      if (ids) replace(h, 'Offset', new Set(ids));
      continue;
    }
    if (typeof r === 'string') continue;
    const e = live(h, r.e);
    if (offsetDist === 'Through') {
      const t = await needPoint(h, 'Specify through point', { keywords: KW('Exit', 'Undo'), preview: (q) => [offsetThrough(e, q)].filter((x): x is Entity => !!x) });
      if (t === 'Exit') return;
      if (typeof t === 'string') continue;
      const o = offsetThrough(e, t);
      if (o) {
        add_(h, 'Offset', o);
        made.push([o.id]);
      }
    } else {
      const D = offsetDist;
      const side = await needPoint(h, 'Specify point on side to offset', { keywords: KW('Exit', 'Undo'), preview: (q) => [offset(e, D, q)].filter((x): x is Entity => !!x) });
      if (side === 'Exit') return;
      if (typeof side === 'string') continue;
      const o = offset(e, D, side);
      if (!o) {
        h.say('Unable to offset.');
        continue;
      }
      add_(h, 'Offset', o);
      made.push([o.id]);
    }
  }
};

function offsetThrough(e: Entity, p: Vec): Entity | null {
  const segs = entitySegs(e);
  if (!segs.length) return null;
  let best = Infinity;
  for (const s of segs) {
    const q = s.k === 'line' ? lineFoot(s.a, s.b, p) : polar(s.c, s.r, angleTo(s.c, p));
    best = Math.min(best, dist(q, p));
  }
  return best > 1e-12 ? offset(e, best, p) : null;
}

function lineFoot(a: Vec, b: Vec, p: Vec): Vec {
  const d = sub(b, a);
  const L = dot(d, d) || 1;
  return add(a, mul(d, dot(sub(p, a), d) / L));
}

const trimLike =
  (mode: 'trim' | 'extend'): Command =>
  async (h) => {
    h.say(`Current settings: Projection=UCS, Edge=None, Mode=Quick`);
    let edges: Entity[] | null = null;
    for (;;) {
      const verb = mode === 'trim' ? 'trim or shift-select to extend' : 'extend or shift-select to trim';
      const kws = mode === 'trim' ? KW('cuTting edges', 'eRase', 'Undo').map((k) => ({ ...k, key: k.name.replace(/[^A-Z]/g, '') })) : KW('Boundary edges', 'Undo');
      const r = await h.ask({ kind: 'pick', prompt: `Select object to ${verb}`, keywords: kws, filter: (e) => ['line', 'arc', 'circle', 'pline', 'ellipse', 'spline', 'xline', 'ray'].includes(e.type) });
      if (r.t === 'enter') return;
      if (r.t === 'keyword') {
        if (r.k === 'Undo') h.undo();
        else if (r.k === 'eRase') {
          const list = await objects(h, 'Select objects to erase');
          if (list.length) replace(h, 'Erase', new Set(list.map((e) => e.id)));
        } else {
          h.say('Current settings: Projection=UCS, Edge=None, Mode=Standard');
          edges = await objects(h, mode === 'trim' ? 'Select cutting edges ... Select objects or <select all>' : 'Select boundary edges ... Select objects or <select all>');
          if (!edges.length) edges = null;
        }
        continue;
      }
      if (r.t !== 'pick') continue;
      const d = h.drawing();
      const e = live(h, r.e);
      if (lockedLayer(d, e)) {
        h.say('The object is on a locked layer.');
        continue;
      }
      const shift = (r as { shift?: boolean }).shift === true;
      const doTrim = (mode === 'trim') !== shift;
      const others = (edges ?? h.visible()).filter((x) => x.id !== e.id);
      const segs = edgesOf(others.map((x) => live(h, x)), d);
      if (doTrim) {
        const out = trim(e, r.p, segs);
        if (!out) {
          h.say('Cannot trim that object.');
          continue;
        }
        replace(h, 'Trim', new Set([e.id]), out);
      } else {
        const out = extend(e, r.p, segs);
        if (!out) {
          h.say('Object does not intersect an edge.');
          continue;
        }
        replace(h, 'Extend', new Set([e.id]), [out]);
      }
    }
  };

const filletCmd =
  (kind: 'fillet' | 'chamfer'): Command =>
  async (h) => {
    const d0 = h.drawing();
    if (kind === 'fillet') h.say(`Current settings: Mode = TRIM, Radius = ${fmt(d0.header.filletrad)}`);
    else h.say(`(TRIM mode) Current chamfer Dist1 = ${fmt(d0.header.chamfera)}, Dist2 = ${fmt(d0.header.chamferb)}`);
    let multiple = false;
    for (;;) {
      const kws = kind === 'fillet' ? KW('Undo', 'Radius', 'Multiple') : KW('Undo', 'Distance', 'Multiple');
      const r1 = await pick(h, kind === 'fillet' ? 'Select first object' : 'Select first line', (e) => e.type === 'line', kws);
      if (r1 === null) return;
      if (r1 === 'Undo') {
        h.undo();
        continue;
      }
      if (r1 === 'Multiple') {
        multiple = true;
        continue;
      }
      if (r1 === 'Radius') {
        const r = await distance(h, 'Specify fillet radius', { def: h.drawing().header.filletrad });
        if (typeof r === 'number' && r >= 0) h.commit('Fillet Radius', { ...h.drawing(), header: { ...h.drawing().header, filletrad: r } });
        continue;
      }
      if (r1 === 'Distance') {
        const a = await distance(h, 'Specify first chamfer distance', { def: h.drawing().header.chamfera });
        if (typeof a !== 'number') continue;
        const b = await distance(h, 'Specify second chamfer distance', { def: a });
        if (typeof b !== 'number') continue;
        h.commit('Chamfer Distance', { ...h.drawing(), header: { ...h.drawing().header, chamfera: a, chamferb: b } });
        continue;
      }
      if (typeof r1 === 'string') continue;
      const a2 = await h.ask({ kind: 'pick', prompt: kind === 'fillet' ? 'Select second object or shift-select to apply corner' : 'Select second line or shift-select to apply corner', filter: (e) => e.type === 'line' && e.id !== r1.e.id });
      if (a2.t !== 'pick') return;
      const shift = (a2 as { shift?: boolean }).shift === true;
      const hd = h.drawing().header;
      const e1 = live(h, r1.e);
      const e2 = live(h, a2.e);
      const out = kind === 'fillet' ? fillet(e1, r1.p, e2, a2.p, shift ? 0 : hd.filletrad) : chamfer(e1, r1.p, e2, a2.p, shift ? 0 : hd.chamfera, shift ? 0 : hd.chamferb);
      if (typeof out === 'string') {
        h.say(out);
        continue;
      }
      replace(h, kind === 'fillet' ? 'Fillet' : 'Chamfer', new Set([e1.id, e2.id]), out);
      if (!multiple) return;
    }
  };

const erase: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  replace(h, 'Erase', new Set(list.map((e) => e.id)));
  h.setSelection([]);
};

const explodeCmd: Command = async (h) => {
  const list = unlocked(h, await objects(h));
  if (!list.length) return;
  const d = h.drawing();
  let done = 0;
  let out = d.entities;
  for (const e of list) {
    const parts = explode(e, d);
    if (!parts) {
      h.say(`1 ${ENTITY_NAMES[e.type].toLowerCase()} could not be exploded.`);
      continue;
    }
    done++;
    out = out.flatMap((x) => (x.id === e.id ? parts : [x]));
  }
  if (done) h.commit('Explode', withEntities(d, out));
};

const array: Command = async (h) => {
  const list = await objects(h);
  if (!list.length) return;
  const type = await choose(h, 'Enter array type', KW('Rectangular', 'POlar').map((k) => ({ ...k, key: k.name.replace(/[^A-Z]/g, '') })), 'Rectangular');
  if (type === 'Rectangular') await arrayRect(h, list);
  else await arrayPolar(h, list);
};

async function arrayRect(h: Host, list: Entity[]) {
  const box = emptyBox();
  const d = h.drawing();
  for (const e of list) for (const s of worldSegs(e, d)) for (const p of s.k === 'line' ? [s.a, s.b] : [polar(s.c, s.r, 0), polar(s.c, s.r, Math.PI)]) grow(box, p);
  const w = boxValid(box) ? box.max.x - box.min.x : 1;
  const ht = boxValid(box) ? box.max.y - box.min.y : 1;
  const rows = await integer(h, 'Enter the number of rows', 3, 1, 10000);
  const cols = await integer(h, 'Enter the number of columns', 4, 1, 10000);
  const dr = await distance(h, 'Specify the distance between rows', { def: Math.max(ht * 1.5, 1e-6) });
  if (typeof dr !== 'number') return;
  const dc = await distance(h, 'Specify the distance between columns', { def: Math.max(w * 1.5, 1e-6) });
  if (typeof dc !== 'number') return;
  const out: Entity[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r || c) out.push(...list.map((e) => transformEntity({ ...e, id: newId() }, translation(c * dc, r * dr))));
  add_(h, 'Array', ...out);
}

async function arrayPolar(h: Host, list: Entity[]) {
  const c = await needPoint(h, 'Specify center point of array');
  if (typeof c === 'string') return;
  const n = await integer(h, 'Enter the number of items in the array', 6, 2, 10000);
  const fill = await angle(h, 'Specify the angle to fill (+=ccw, -=cw)', { def: TAU });
  if (typeof fill !== 'number') return;
  const rot = await choose(h, 'Rotate arrayed objects?', KW('Yes', 'No'), 'Yes');
  const full = Math.abs(Math.abs(fill) - TAU) < 1e-9 || Math.abs(fill) < 1e-12;
  const step = full ? TAU / n : fill / (n - 1);
  const out: Entity[] = [];
  const d = h.drawing();
  for (let i = 1; i < n; i++) {
    const a = step * i;
    for (const e of list) {
      if (rot === 'Yes') out.push(transformEntity({ ...e, id: newId() }, rotation(c, a)));
      else {
        const anchor = anchorOf(e) ?? worldSegs(e, d)[0]?.k === 'line' ? (worldSegs(e, d)[0] as Extract<Seg, { k: 'line' }>).a : (anchorOf(e) ?? c);
        const to = add(c, rotateVec(sub(anchor, c), a));
        out.push(transformEntity({ ...e, id: newId() }, translation(to.x - anchor.x, to.y - anchor.y)));
      }
    }
  }
  add_(h, 'Array', ...out);
}

const breakCmd =
  (atPoint: boolean): Command =>
  async (h) => {
    const r = await pick(h, 'Select object', (e) => ['line', 'arc', 'circle', 'pline', 'ellipse', 'spline'].includes(e.type));
    if (!r || typeof r === 'string') return;
    const e = live(h, r.e);
    let a = r.p;
    let b: Vec;
    if (atPoint) {
      const p = await needPoint(h, 'Specify break point');
      if (typeof p === 'string') return;
      a = p;
      b = p;
    } else {
      const p = await needPoint(h, 'Specify second break point', { keywords: KW('First point') });
      if (p === 'First point') {
        const f = await needPoint(h, 'Specify first break point');
        if (typeof f === 'string') return;
        const s = await needPoint(h, 'Specify second break point');
        if (typeof s === 'string') return;
        a = f;
        b = s;
      } else if (typeof p === 'string') return;
      else b = p;
    }
    if (e.type === 'circle' && same(a, b)) return h.say('Arc cannot be full 360 degrees.');
    const out = breakAt(e, a, b);
    if (!out) return h.say('Cannot break that object.');
    replace(h, 'Break', new Set([e.id]), out);
  };

const joinCmd: Command = async (h) => {
  const list = unlocked(h, await objects(h, 'Select source object or multiple objects to join at once'));
  if (list.length < 2) return h.say('Select at least two objects that meet end to end.');
  const j = join(list.map((e) => live(h, e)));
  if (!j) return h.say('The objects don’t meet end to end, so they can’t be joined.');
  replace(h, 'Join', new Set(list.map((e) => e.id)), [j]);
  h.say(`${list.length} objects joined into 1 ${j.type === 'line' ? 'line' : 'polyline'}`);
};

const matchprop: Command = async (h) => {
  const src = await pick(h, 'Select source object');
  if (!src || typeof src === 'string') return;
  h.say('Current active settings:  Color Layer Ltype Ltscale Lineweight Text Dim Hatch');
  for (;;) {
    const r = await h.ask({ kind: 'select', prompt: 'Select destination object(s)' });
    if (r.t !== 'objects' || !r.list.length) return;
    const s = src.e;
    const ids = new Set(r.list.map((e) => e.id));
    const d = h.drawing();
    h.commit(
      'Match Properties',
      withEntities(
        d,
        d.entities.map((e) => {
          if (!ids.has(e.id)) return e;
          let x: Entity = { ...e, layer: s.layer, color: s.color, linetype: s.linetype, lineweight: s.lineweight, ltscale: s.ltscale };
          if ((x.type === 'text' || x.type === 'mtext') && (s.type === 'text' || s.type === 'mtext')) x = { ...x, style: s.style, h: s.h } as Entity;
          if (x.type === 'dim' && s.type === 'dim') x = { ...x, style: s.style, block: undefined };
          if (x.type === 'hatch' && s.type === 'hatch') x = { ...x, pattern: s.pattern, solid: s.solid, scale: s.scale, angle: s.angle, lines: s.lines.length ? patternLines(s.pattern, s.angle, s.scale, h.metric) : [] };
          return x;
        }),
      ),
    );
  }
};

// ---- Blocks ---------------------------------------------------------------------------------

const block: Command = async (h) => {
  let name: string | null;
  for (;;) {
    name = await text(h, 'Enter block name');
    if (!name) return;
    if (/[<>/\\":;?*|,=`]/.test(name)) {
      h.say('Invalid block name.');
      continue;
    }
    if (findBlock(h.drawing(), name)) {
      const r = await choose(h, `Block "${name}" already exists. Redefine it?`, KW('Yes', 'No'), 'No');
      if (r === 'No') continue;
    }
    break;
  }
  const base = await needPoint(h, 'Specify insertion base point');
  if (typeof base === 'string') return;
  const list = await objects(h);
  if (!list.length) return;
  const d = h.drawing();
  const b: Block = { name, base, entities: list.map((e) => ({ ...e, id: newId() })), flags: list.some((e) => e.type === 'attdef') ? 2 : 0, description: '' };
  const ins: Insert = { ...ent(h), type: 'insert', block: name, p: base, sx: 1, sy: 1, rot: 0, attribs: attribsFor(b, base, 1, 1, 0, {}) };
  const ids = new Set(list.map((e) => e.id));
  h.commit('Block', { ...d, blocks: { ...d.blocks, [name]: b }, entities: [...d.entities.filter((e) => !ids.has(e.id)), ins] });
  h.say(`Block "${name}" created.`);
};

/** The attributes a block's attribute definitions give an insert, with these values. */
function attribsFor(b: Block, p: Vec, sx: number, sy: number, rot: number, values: Record<string, string>) {
  const m = compose3(p, rot, sx, sy, b.base);
  return b.entities
    .filter((e) => e.type === 'attdef')
    .map((ad) => {
      if (ad.type !== 'attdef') throw new Error();
      const t = transformEntity({ ...ad, type: 'text' } as unknown as Text, m) as Text;
      return { layer: ad.layer, color: ad.color, linetype: ad.linetype, lineweight: ad.lineweight, ltscale: ad.ltscale, p: t.p, a: t.a, h: t.h, rot: t.rot, text: values[ad.tag] ?? ad.text, style: ad.style, wf: ad.wf, oblique: ad.oblique, halign: ad.halign, valign: ad.valign, tag: ad.tag, flags: ad.flags & ~2 };
    });
}

function compose3(p: Vec, rot: number, sx: number, sy: number, base: Vec): Mat {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  // Only uniform scales keep text right; use the X scale.
  const k = Math.abs(sx) || 1;
  void sy;
  return { a: c * k, b: s * k, c: -s * k, d: c * k, e: p.x - (c * base.x - s * base.y) * k, f: p.y - (s * base.x + c * base.y) * k };
}

export async function insertBlock(h: Host, name: string, sc: number, rot: number, askAfter = false) {
  const d = h.drawing();
  const b = findBlock(d, name);
  if (!b) return h.say(`Block "${name}" not found.`);
  let s = sc;
  let r = rot;
  let p: Vec | string;
  const make = (q: Vec): Insert => ({ ...ent(h), type: 'insert', block: b.name, p: q, sx: s, sy: s, rot: r, attribs: attribsFor(b, q, s, s, r, {}) });
  for (;;) {
    p = await needPoint(h, 'Specify insertion point', { keywords: KW('Scale', 'Rotate'), preview: (q) => [make(q)] });
    if (p === 'Scale') {
      const v = await distance(h, 'Specify scale factor for XYZ axes', { def: s });
      if (typeof v === 'number' && v > 0) s = v;
      continue;
    }
    if (p === 'Rotate') {
      const v = await angle(h, 'Specify rotation angle', { def: r });
      if (typeof v === 'number') r = v;
      continue;
    }
    break;
  }
  if (typeof p === 'string') return;
  if (askAfter) {
    const x = await distance(h, 'Enter X scale factor', { def: s });
    if (typeof x === 'number' && x !== 0) s = x;
    const y = await distance(h, 'Enter Y scale factor <use X scale factor>', {});
    if (typeof y === 'number' && y !== s) h.say('Only uniform scales are supported; using the X scale factor.');
    const at = p;
    const a = await angle(h, 'Specify rotation angle', { def: r, base: at, preview: (q) => [{ ...make(at), rot: angleTo(at, q) }] });
    if (typeof a === 'number') r = a;
  }
  const values: Record<string, string> = {};
  for (const ad of b.entities) {
    if (ad.type !== 'attdef' || ad.flags & 2) continue;
    const v = await text(h, ad.prompt || ad.tag, ad.text, true);
    if (v === null) return;
    values[ad.tag] = v;
  }
  const ins = make(p);
  ins.attribs = attribsFor(b, p, s, s, r, values);
  add_(h, 'Insert', ins);
}

const insert: Command = async (h) => {
  const r = await h.chooseBlock();
  if (!r) return;
  await insertBlock(h, r.name, r.scale, r.rotation);
};

let lastInsert = '';

const insertTyped: Command = async (h) => {
  const name = await text(h, 'Enter block name or [?]', lastInsert || undefined);
  if (!name) return;
  if (name === '?') {
    const names = Object.keys(h.drawing().blocks).filter((n) => !n.startsWith('*'));
    h.say(names.length ? `Defined blocks: ${names.join(', ')}` : 'No blocks are defined.');
    return;
  }
  const b = findBlock(h.drawing(), name);
  if (!b) return h.say(`Block "${name}" not found.`);
  lastInsert = b.name;
  await insertBlock(h, b.name, 1, 0, true);
};

// ---- Inquiry --------------------------------------------------------------------------------

const distCmd: Command = async (h) => {
  const a = await needPoint(h, 'Specify first point');
  if (typeof a === 'string') return;
  const b = await needPoint(h, 'Specify second point', { base: a });
  if (typeof b === 'string') return;
  h.say(`Distance = ${fmt(dist(a, b))},  Angle in XY Plane = ${fmtAngle(angleTo(a, b))},  Angle from XY Plane = 0`);
  h.say(`Delta X = ${fmt(b.x - a.x)},  Delta Y = ${fmt(b.y - a.y)},  Delta Z = ${fmt(0)}`);
};

const idCmd: Command = async (h) => {
  const p = await needPoint(h, 'Specify point');
  if (typeof p === 'string') return;
  h.say(`X = ${fmt(p.x)}     Y = ${fmt(p.y)}     Z = ${fmt(0)}`);
};

const area: Command = async (h) => {
  const first = await needPoint(h, 'Specify first corner point', { keywords: KW('Object') });
  if (first === 'Object') {
    const r = await pick(h, 'Select objects', (e) => ['circle', 'pline', 'ellipse', 'spline', 'hatch'].includes(e.type));
    if (!r || typeof r === 'string') return;
    const e = r.e;
    let a: number;
    let per: number;
    if (e.type === 'circle') {
      a = Math.PI * e.r * e.r;
      per = TAU * e.r;
    } else if (e.type === 'pline') {
      const pts = plinePoints(e.pts, true, 256);
      a = Math.abs(polygonArea(pts));
      per = entitySegs(e).reduce((s, x) => s + (x.k === 'line' ? dist(x.a, x.b) : x.r * sweep(x.a0, x.a1)), 0);
    } else {
      const segs = worldSegs(e, h.drawing());
      const pts = segs.map((s) => (s.k === 'line' ? s.a : polar(s.c, s.r, s.a0)));
      a = Math.abs(polygonArea(pts));
      per = segs.reduce((s, x) => s + (x.k === 'line' ? dist(x.a, x.b) : x.r * sweep(x.a0, x.a1)), 0);
    }
    h.say(`Area = ${fmt(a)}, ${e.type === 'circle' ? 'Circumference' : 'Perimeter'} = ${fmt(per)}`);
    return;
  }
  if (typeof first === 'string') return;
  const pts = [first];
  for (;;) {
    const p = await point(h, 'Specify next point', { base: pts[pts.length - 1], preview: (q) => [{ ...ent(h), type: 'pline', pts: [...pts, q].map((x) => ({ ...x, b: 0 })), closed: true, width: 0 }] });
    if (p === null) break;
    if (typeof p === 'string') continue;
    pts.push(p);
  }
  if (pts.length < 3) return;
  let per = 0;
  for (let i = 0; i < pts.length; i++) per += dist(pts[i], pts[(i + 1) % pts.length]);
  h.say(`Area = ${fmt(Math.abs(polygonArea(pts)))}, Perimeter = ${fmt(per)}`);
};

const list: Command = async (h) => {
  const sel = await objects(h);
  const d = h.drawing();
  for (const e of sel) {
    h.say(`                  ${ENTITY_NAMES[e.type].toUpperCase()}       Layer: "${e.layer}"`);
    h.say(`                            Space: Model space`);
    if (e.color !== BYLAYER) h.say(`                   Color: ${e.color}    Linetype: "${e.linetype}"`);
    switch (e.type) {
      case 'line':
        h.say(`              from point, X=${fmt(e.a.x)}  Y=${fmt(e.a.y)}  Z=${fmt(0)}`);
        h.say(`                to point, X=${fmt(e.b.x)}  Y=${fmt(e.b.y)}  Z=${fmt(0)}`);
        h.say(`          Length =${fmt(dist(e.a, e.b))},  Angle in XY Plane = ${fmtAngle(angleTo(e.a, e.b))}`);
        break;
      case 'circle':
        h.say(`            center point, X=${fmt(e.c.x)}  Y=${fmt(e.c.y)}  Z=${fmt(0)}`);
        h.say(`            radius ${fmt(e.r)}`);
        h.say(`     circumference ${fmt(TAU * e.r)}`);
        h.say(`              area ${fmt(Math.PI * e.r * e.r)}`);
        break;
      case 'arc':
        h.say(`            center point, X=${fmt(e.c.x)}  Y=${fmt(e.c.y)}  Z=${fmt(0)}`);
        h.say(`            radius ${fmt(e.r)}`);
        h.say(`            start angle ${fmtAngle(e.start)}`);
        h.say(`              end angle ${fmtAngle(e.end)}`);
        h.say(`            length ${fmt(e.r * sweep(e.start, e.end))}`);
        break;
      case 'pline':
        h.say(`              ${e.closed ? 'Closed' : 'Open'}     Constant width    ${fmt(e.width)}`);
        h.say(`              area   ${fmt(Math.abs(polygonArea(plinePoints(e.pts, true, 128))))}`);
        h.say(`              length ${fmt(entitySegs(e).reduce((s, x) => s + (x.k === 'line' ? dist(x.a, x.b) : x.r * sweep(x.a0, x.a1)), 0))}`);
        for (const p of e.pts) h.say(`          at point  X=${fmt(p.x)}  Y=${fmt(p.y)}  Z=${fmt(0)}`);
        break;
      case 'text':
        h.say(`              Style = "${e.style}"  Font file = ${findTextStyle(d, e.style)?.font ?? 'txt'}`);
        h.say(`              start point  X=${fmt(e.p.x)}  Y=${fmt(e.p.y)}  Z=${fmt(0)}`);
        h.say(`              height ${fmt(e.h)}   text ${e.text}`);
        break;
      case 'mtext':
        h.say(`              Location:  X=${fmt(e.p.x)}  Y=${fmt(e.p.y)}  Z=${fmt(0)}`);
        h.say(`              Text height: ${fmt(e.h)}   Contents: ${mtextPlain(e.text).replace(/\n/g, ' ')}`);
        break;
      case 'insert':
        h.say(`                  Block Name: "${e.block}"`);
        h.say(`               at point, X=${fmt(e.p.x)}  Y=${fmt(e.p.y)}  Z=${fmt(0)}`);
        h.say(`   X scale factor: ${fmt(e.sx)}   Y scale factor: ${fmt(e.sy)}   rotation angle: ${fmtAngle(e.rot)}`);
        break;
      case 'dim':
        h.say(`            type: ${e.kind}   style: "${e.style}"   measurement: ${dimText(e, findDimStyle(d, e.style))}`);
        break;
      default:
        break;
    }
  }
  if (sel.length) h.open('history');
};

// ---- Settings and the rest ----------------------------------------------------------------

const ltscale: Command = async (h) => {
  const d = h.drawing();
  const v = await distance(h, 'Enter new linetype scale factor', { def: d.header.ltscale });
  if (typeof v !== 'number' || v <= 0) return;
  h.commit('LTSCALE', { ...h.drawing(), header: { ...h.drawing().header, ltscale: v } });
  h.say('Regenerating model.');
};

const purge: Command = async (h) => {
  const d = h.drawing();
  const usedBlocks = new Set<string>();
  const usedLayers = new Set<string>(['0', 'DEFPOINTS', d.header.clayer.toUpperCase()]);
  const usedLt = new Set<string>(['BYLAYER', 'BYBLOCK', CONTINUOUS.toUpperCase()]);
  const usedStyles = new Set<string>([d.header.textstyle.toUpperCase(), 'STANDARD']);
  const walk = (list: Entity[]) => {
    for (const e of list) {
      usedLayers.add(e.layer.toUpperCase());
      usedLt.add(e.linetype.toUpperCase());
      if (e.type === 'insert' && !usedBlocks.has(e.block.toUpperCase())) {
        usedBlocks.add(e.block.toUpperCase());
        const b = findBlock(d, e.block);
        if (b) walk(b.entities);
      }
      if (e.type === 'dim' && e.block) {
        usedBlocks.add(e.block.toUpperCase());
        const b = findBlock(d, e.block);
        if (b) walk(b.entities);
      }
      if (e.type === 'text' || e.type === 'mtext' || e.type === 'attdef') usedStyles.add(e.style.toUpperCase());
    }
  };
  walk(d.entities);
  walk(d.paper);
  for (const l of d.layers) usedLt.add(l.linetype.toUpperCase());
  for (const s of d.dimStyles) usedStyles.add(s.dimtxsty.toUpperCase());
  const blocks = Object.fromEntries(Object.entries(d.blocks).filter(([k]) => usedBlocks.has(k.toUpperCase())));
  const layers = d.layers.filter((l) => usedLayers.has(l.name.toUpperCase()));
  const linetypes = d.linetypes.filter((l) => usedLt.has(l.name.toUpperCase()));
  const textStyles = d.textStyles.filter((s) => usedStyles.has(s.name.toUpperCase()));
  const n = Object.keys(d.blocks).length - Object.keys(blocks).length + d.layers.length - layers.length + d.linetypes.length - linetypes.length + d.textStyles.length - textStyles.length;
  if (!n) return h.say('No unreferenced items found.');
  h.commit('Purge', { ...d, blocks, layers, linetypes, textStyles });
  h.say(`${n} items purged.`);
};

const zoom: Command = async (h) => {
  const kws = KW('All', 'Extents', 'Previous', 'Window', 'Object');
  const p = await point(h, 'Specify corner of window, enter a scale factor (nX or nXP),', { keywords: kws, default: 'real time' });
  if (p === null || p === 'real time') return h.zoom('pan');
  if (p === 'All') return h.zoom('all');
  if (p === 'Extents') return h.zoom('extents');
  if (p === 'Previous') return h.zoom('previous');
  if (p === 'Object') {
    const list = await objects(h);
    if (!list.length) return;
    const d = h.drawing();
    const box: Box = emptyBox();
    for (const e of list) for (const s of worldSegs(e, d)) for (const q of s.k === 'line' ? [s.a, s.b] : [add(s.c, { x: -s.r, y: -s.r }), add(s.c, { x: s.r, y: s.r })]) grow(box, q);
    if (boxValid(box)) h.zoom('window', box.min, box.max);
    return;
  }
  let a: Vec | null = typeof p === 'string' ? null : p;
  if (p === 'Window' || !a) {
    const q = await needPoint(h, 'Specify first corner');
    if (typeof q === 'string') return;
    a = q;
  }
  const b = await needPoint(h, 'Specify opposite corner', { base: a, box: true, rubber: false });
  if (typeof b === 'string') return;
  h.zoom('window', a, b);
};

const layerTool =
  (what: 'off' | 'freeze' | 'lock' | 'unlock' | 'on' | 'thaw' | 'current' | 'isolate'): Command =>
  async (h) => {
    const d0 = h.drawing();
    if (what === 'on' || what === 'thaw') {
      h.commit(what === 'on' ? 'Turn All Layers On' : 'Thaw All Layers', { ...d0, layers: d0.layers.map((l) => ({ ...l, ...(what === 'on' ? { on: true } : { frozen: false }) })) });
      h.say(`All layers have been ${what === 'on' ? 'turned on' : 'thawed'}.`);
      return;
    }
    const prompt = { off: 'Select an object on the layer to be turned off', freeze: 'Select an object on the layer to be frozen', lock: 'Select an object on the layer to be locked', unlock: 'Select an object on the layer to be unlocked', current: 'Select object whose layer will become current', isolate: 'Select objects on the layer(s) to be isolated' }[what];
    const pre = h.takeSelection();
    let targets: Entity[] = pre;
    if (!targets.length) {
      if (what === 'isolate') targets = await objects(h, prompt);
      else {
        const r = await pick(h, prompt);
        if (!r || typeof r === 'string') return;
        targets = [r.e];
      }
    }
    if (!targets.length) return;
    const names = new Set(targets.map((e) => e.layer.toUpperCase()));
    const d = h.drawing();
    if (what === 'current') {
      const name = targets[0].layer;
      h.commit('Make Layer Current', { ...d, header: { ...d.header, clayer: name } });
      h.say(`${name} is now the current layer.`);
      return;
    }
    if ((what === 'off' || what === 'freeze') && names.has(d.header.clayer.toUpperCase()) && what === 'freeze') return h.say('Cannot freeze the current layer.');
    const layers = d.layers.map((l) => {
      const hit = names.has(l.name.toUpperCase());
      switch (what) {
        case 'off':
          return hit ? { ...l, on: false } : l;
        case 'freeze':
          return hit ? { ...l, frozen: true } : l;
        case 'lock':
          return hit ? { ...l, locked: true } : l;
        case 'unlock':
          return hit ? { ...l, locked: false } : l;
        case 'isolate':
          return hit ? { ...l, on: true } : { ...l, on: false };
      }
      return l;
    });
    h.commit('Layer', { ...d, layers, header: what === 'isolate' ? { ...d.header, clayer: targets[0].layer } : d.header });
    h.say(`Layer${names.size > 1 ? 's' : ''} "${[...names].join('", "')}" ${{ off: 'turned off', freeze: 'frozen', lock: 'locked', unlock: 'unlocked', isolate: 'isolated' }[what]}.`);
  };

const newLayer = (d: Drawing, name: string): Drawing => (findLayer(d, name) ? d : { ...d, layers: [...d.layers, defaultLayer(name)] });

const selectall: Command = async (h) => {
  const d = h.drawing();
  h.setSelection(d.entities.filter((e) => {
    const l = findLayer(d, e.layer);
    return !l || (l.on && !l.frozen);
  }).map((e) => e.id));
};

const copyclip =
  (cut: boolean, withBase: boolean): Command =>
  async (h) => {
    const list = await objects(h);
    if (!list.length) return;
    let base: Vec | null = null;
    if (withBase) {
      const b = await needPoint(h, 'Specify base point');
      if (typeof b === 'string') return;
      base = b;
    }
    h.clipboard.copy(list, base);
    if (cut) replace(h, 'Cut', new Set(unlocked(h, list).map((e) => e.id)));
    h.say(`${list.length} object${list.length === 1 ? '' : 's'} ${cut ? 'cut' : 'copied'} to the clipboard.`);
  };

const pasteclip: Command = async (h) => {
  const c = await h.clipboard.paste();
  if (!c || !c.list.length) return h.say('Nothing to paste.');
  const box = emptyBox();
  const d = h.drawing();
  for (const e of c.list) for (const s of worldSegs(e, d)) grow(box, s.k === 'line' ? s.a : s.c);
  const base = c.base ?? (boxValid(box) ? box.min : anchorOf(c.list[0]) ?? { x: 0, y: 0 });
  const p = await needPoint(h, 'Specify insertion point', { preview: (q) => ghost(c.list, translation(q.x - base.x, q.y - base.y)) });
  if (typeof p === 'string') return;
  let dd = h.drawing();
  for (const e of c.list) dd = newLayer(dd, e.layer);
  const out = c.list.map((e) => transformEntity({ ...e, id: newId() }, translation(p.x - base.x, p.y - base.y)));
  h.commit('Paste', { ...dd, entities: [...dd.entities, ...out] });
  h.setSelection(out.map((e) => e.id));
};

const gripsOf = grips;
export { gripsOf };

const undo: Command = async (h) => {
  const a = await h.ask({ kind: 'point', prompt: 'Enter the number of operations to undo', number: true, default: '1', keywords: KW('Back') });
  const n = a.t === 'number' ? Math.max(1, Math.round(a.n)) : a.t === 'keyword' ? 1000 : 1;
  h.undo(n);
};

const file =
  (op: Parameters<Host['file']>[0]): Command =>
  async (h) =>
    h.file(op);

const panel =
  (p: Parameters<Host['open']>[0]): Command =>
  async (h) =>
    h.open(p);

const simple =
  (fn: (h: Host) => void): Command =>
  async (h) =>
    fn(h);

// ---- The table -----------------------------------------------------------------------------

export interface CommandInfo {
  run: Command;
  /** What it says on the command line when it starts. */
  title: string;
  /** Shown in autocomplete. */
  description: string;
  /** Runs without interrupting another command (zoom, pan). */
  transparent?: boolean;
  /** Keeps the pickfirst selection for itself. */
  usesSelection?: boolean;
}

export const COMMANDS: Record<string, CommandInfo> = {
  LINE: { run: line, title: 'LINE', description: 'Creates straight line segments' },
  PLINE: { run: pline, title: 'PLINE', description: 'Creates a 2D polyline' },
  CIRCLE: { run: circle, title: 'CIRCLE', description: 'Creates a circle' },
  ARC: { run: arc, title: 'ARC', description: 'Creates an arc' },
  RECTANG: { run: rectang, title: 'RECTANG', description: 'Creates a rectangular polyline' },
  POLYGON: { run: polygon, title: 'POLYGON', description: 'Creates an equilateral closed polyline' },
  ELLIPSE: { run: ellipse, title: 'ELLIPSE', description: 'Creates an ellipse' },
  SPLINE: { run: spline, title: 'SPLINE', description: 'Creates a smooth curve through points' },
  POINT: { run: pointCmd(false), title: 'POINT', description: 'Creates a point object' },
  MULTIPLEPOINT: { run: pointCmd(true), title: 'POINT', description: 'Creates several point objects' },
  XLINE: { run: xline, title: 'XLINE', description: 'Creates a line of infinite length' },
  RAY: { run: ray, title: 'RAY', description: 'Creates a semi-infinite line' },
  DONUT: { run: donut, title: 'DONUT', description: 'Creates a filled circle or a wide ring' },
  TEXT: { run: dtext, title: 'TEXT', description: 'Creates single-line text' },
  MTEXT: { run: mtext, title: 'MTEXT', description: 'Creates paragraphs of text' },
  TEXTEDIT: { run: textedit, title: 'TEXTEDIT', description: 'Edits a text, mtext or dimension' },
  HATCH: { run: hatch, title: 'HATCH', description: 'Fills an enclosed area with a hatch pattern' },
  BOUNDARY: { run: boundary, title: 'BOUNDARY', description: 'Creates a polyline from an enclosed area' },
  DIMLINEAR: { run: dimlinear(false), title: 'DIMLINEAR', description: 'Creates a linear dimension' },
  DIMALIGNED: { run: dimlinear(true), title: 'DIMALIGNED', description: 'Creates an aligned linear dimension' },
  DIMRADIUS: { run: dimradial(false), title: 'DIMRADIUS', description: 'Creates a radius dimension' },
  DIMDIAMETER: { run: dimradial(true), title: 'DIMDIAMETER', description: 'Creates a diameter dimension' },
  DIMANGULAR: { run: dimangular, title: 'DIMANGULAR', description: 'Creates an angular dimension' },
  DIMORDINATE: { run: dimordinate, title: 'DIMORDINATE', description: 'Creates an ordinate dimension' },
  LEADER: { run: leader, title: 'LEADER', description: 'Creates a line that connects annotation to a feature' },
  MOVE: { run: move, title: 'MOVE', description: 'Moves objects a specified distance', usesSelection: true },
  COPY: { run: copy, title: 'COPY', description: 'Copies objects a specified distance', usesSelection: true },
  ROTATE: { run: rotate, title: 'ROTATE', description: 'Rotates objects around a base point', usesSelection: true },
  SCALE: { run: scale, title: 'SCALE', description: 'Enlarges or reduces objects', usesSelection: true },
  MIRROR: { run: mirror, title: 'MIRROR', description: 'Creates a mirrored copy of objects', usesSelection: true },
  STRETCH: { run: stretchCmd, title: 'STRETCH', description: 'Stretches objects crossed by a window' },
  OFFSET: { run: offsetCmd, title: 'OFFSET', description: 'Creates concentric circles, parallel lines and curves' },
  TRIM: { run: trimLike('trim'), title: 'TRIM', description: 'Trims objects to meet the edges of other objects' },
  EXTEND: { run: trimLike('extend'), title: 'EXTEND', description: 'Extends objects to meet the edges of other objects' },
  FILLET: { run: filletCmd('fillet'), title: 'FILLET', description: 'Rounds the corner between two lines' },
  CHAMFER: { run: filletCmd('chamfer'), title: 'CHAMFER', description: 'Bevels the corner between two lines' },
  ERASE: { run: erase, title: 'ERASE', description: 'Removes objects from the drawing', usesSelection: true },
  EXPLODE: { run: explodeCmd, title: 'EXPLODE', description: 'Breaks a compound object into its parts', usesSelection: true },
  ARRAY: { run: array, title: 'ARRAY', description: 'Creates copies of objects in a pattern', usesSelection: true },
  ARRAYRECT: { run: async (h) => arrayRect(h, await objects(h)), title: 'ARRAYRECT', description: 'Copies objects into rows and columns', usesSelection: true },
  ARRAYPOLAR: { run: async (h) => arrayPolar(h, await objects(h)), title: 'ARRAYPOLAR', description: 'Copies objects around a center point', usesSelection: true },
  BREAK: { run: breakCmd(false), title: 'BREAK', description: 'Breaks an object between two points' },
  BREAKATPOINT: { run: breakCmd(true), title: 'BREAKATPOINT', description: 'Breaks an object into two at a point' },
  JOIN: { run: joinCmd, title: 'JOIN', description: 'Joins objects end to end into one', usesSelection: true },
  MATCHPROP: { run: matchprop, title: 'MATCHPROP', description: 'Applies the properties of one object to others' },
  BLOCK: { run: block, title: 'BLOCK', description: 'Creates a block definition from selected objects', usesSelection: true },
  INSERT: { run: insert, title: 'INSERT', description: 'Inserts a block' },
  '-INSERT': { run: insertTyped, title: '-INSERT', description: 'Inserts a block from the command line' },
  DIST: { run: distCmd, title: 'DIST', description: 'Measures the distance and angle between two points' },
  ID: { run: idCmd, title: 'ID', description: 'Displays the coordinates of a point' },
  AREA: { run: area, title: 'AREA', description: 'Calculates the area and perimeter' },
  LIST: { run: list, title: 'LIST', description: 'Displays property data for selected objects', usesSelection: true },
  LTSCALE: { run: ltscale, title: 'LTSCALE', description: 'Sets the global linetype scale factor' },
  PURGE: { run: purge, title: 'PURGE', description: 'Removes unused blocks, layers, linetypes and styles' },
  ZOOM: { run: zoom, title: 'ZOOM', description: 'Increases or decreases the magnification of the view', transparent: true },
  PAN: { run: simple((h) => h.zoom('pan')), title: 'PAN', description: 'Moves the view', transparent: true },
  REGEN: { run: simple((h) => h.say('Regenerating model.')), title: 'REGEN', description: 'Regenerates the drawing' },
  UNDO: { run: undo, title: 'UNDO', description: 'Reverses the effect of commands' },
  U: { run: simple((h) => h.undo()), title: 'U', description: 'Reverses the most recent operation' },
  REDO: { run: simple((h) => h.redo()), title: 'REDO', description: 'Reverses the effects of the previous UNDO' },
  LAYER: { run: panel('layers'), title: 'LAYER', description: 'Opens the Layer Properties Manager' },
  LAYOFF: { run: layerTool('off'), title: 'LAYOFF', description: 'Turns off the layer of a selected object', usesSelection: true },
  LAYON: { run: layerTool('on'), title: 'LAYON', description: 'Turns on all layers' },
  LAYFRZ: { run: layerTool('freeze'), title: 'LAYFRZ', description: 'Freezes the layer of a selected object', usesSelection: true },
  LAYTHW: { run: layerTool('thaw'), title: 'LAYTHW', description: 'Thaws all layers' },
  LAYLCK: { run: layerTool('lock'), title: 'LAYLCK', description: 'Locks the layer of a selected object', usesSelection: true },
  LAYULK: { run: layerTool('unlock'), title: 'LAYULK', description: 'Unlocks the layer of a selected object', usesSelection: true },
  LAYMCUR: { run: layerTool('current'), title: 'LAYMCUR', description: 'Makes the layer of a selected object current', usesSelection: true },
  LAYISO: { run: layerTool('isolate'), title: 'LAYISO', description: 'Hides all layers except those of selected objects', usesSelection: true },
  PROPERTIES: { run: panel('properties'), title: 'PROPERTIES', description: 'Controls properties of existing objects', usesSelection: true },
  UNITS: { run: panel('units'), title: 'UNITS', description: 'Controls coordinate and angle display formats and precision' },
  DSETTINGS: { run: panel('drafting'), title: 'DSETTINGS', description: 'Sets grid, snap, polar tracking and object snap modes' },
  DIMSTYLE: { run: panel('dimstyle'), title: 'DIMSTYLE', description: 'Creates and modifies dimension styles' },
  STYLE: { run: panel('textstyle'), title: 'STYLE', description: 'Creates and modifies text styles' },
  SELECTALL: { run: selectall, title: 'SELECTALL', description: 'Selects all objects' },
  COPYCLIP: { run: copyclip(false, false), title: 'COPYCLIP', description: 'Copies objects to the clipboard', usesSelection: true },
  COPYBASE: { run: copyclip(false, true), title: 'COPYBASE', description: 'Copies objects with a base point', usesSelection: true },
  CUTCLIP: { run: copyclip(true, false), title: 'CUTCLIP', description: 'Cuts objects to the clipboard', usesSelection: true },
  PASTECLIP: { run: pasteclip, title: 'PASTECLIP', description: 'Pastes objects from the clipboard' },
  NEW: { run: file('new'), title: 'NEW', description: 'Creates a new drawing' },
  OPEN: { run: file('open'), title: 'OPEN', description: 'Opens an existing drawing file' },
  QSAVE: { run: file('save'), title: 'QSAVE', description: 'Saves the current drawing' },
  SAVE: { run: file('save'), title: 'SAVE', description: 'Saves the drawing' },
  SAVEAS: { run: file('saveas'), title: 'SAVEAS', description: 'Saves a copy of the drawing under a new name' },
  DXFOUT: { run: file('export-dxf'), title: 'DXFOUT', description: 'Exports the drawing as DXF' },
  CLOSE: { run: file('close'), title: 'CLOSE', description: 'Closes the drawing' },
  TEXTSCR: { run: panel('history'), title: 'TEXTSCR', description: 'Opens the text window' },
  ABOUT: { run: panel('about'), title: 'ABOUT', description: 'About CAD' },
};

/** acad.pgp's aliases. */
export const ALIASES: Record<string, string> = {
  L: 'LINE',
  PL: 'PLINE',
  C: 'CIRCLE',
  A: 'ARC',
  REC: 'RECTANG',
  RECTANGLE: 'RECTANG',
  POL: 'POLYGON',
  EL: 'ELLIPSE',
  SPL: 'SPLINE',
  PO: 'POINT',
  XL: 'XLINE',
  DO: 'DONUT',
  DT: 'TEXT',
  DTEXT: 'TEXT',
  T: 'MTEXT',
  MT: 'MTEXT',
  ED: 'TEXTEDIT',
  DDEDIT: 'TEXTEDIT',
  H: 'HATCH',
  BH: 'HATCH',
  BO: 'BOUNDARY',
  DLI: 'DIMLINEAR',
  DAL: 'DIMALIGNED',
  DRA: 'DIMRADIUS',
  DDI: 'DIMDIAMETER',
  DAN: 'DIMANGULAR',
  DOR: 'DIMORDINATE',
  LE: 'LEADER',
  QLEADER: 'LEADER',
  M: 'MOVE',
  CO: 'COPY',
  CP: 'COPY',
  RO: 'ROTATE',
  SC: 'SCALE',
  MI: 'MIRROR',
  S: 'STRETCH',
  O: 'OFFSET',
  TR: 'TRIM',
  EX: 'EXTEND',
  F: 'FILLET',
  CHA: 'CHAMFER',
  E: 'ERASE',
  DEL: 'ERASE',
  X: 'EXPLODE',
  AR: 'ARRAY',
  BR: 'BREAK',
  J: 'JOIN',
  MA: 'MATCHPROP',
  PAINTER: 'MATCHPROP',
  B: 'BLOCK',
  I: 'INSERT',
  DI: 'DIST',
  AA: 'AREA',
  MEA: 'DIST',
  LI: 'LIST',
  LS: 'LIST',
  LTS: 'LTSCALE',
  PU: 'PURGE',
  Z: 'ZOOM',
  P: 'PAN',
  RE: 'REGEN',
  LA: 'LAYER',
  PR: 'PROPERTIES',
  PROPS: 'PROPERTIES',
  CH: 'PROPERTIES',
  MO: 'PROPERTIES',
  UN: 'UNITS',
  DS: 'DSETTINGS',
  OS: 'DSETTINGS',
  OSNAP: 'DSETTINGS',
  D: 'DIMSTYLE',
  DST: 'DIMSTYLE',
  ST: 'STYLE',
  AI_SELALL: 'SELECTALL',
};

export function resolveCommand(input: string): string | null {
  const raw = input.trim().toUpperCase().replace(/^[_.']+/, '');
  // The command-line form of a command that has one, like -INSERT.
  if (raw.startsWith('-') && COMMANDS[raw]) return raw;
  const k = raw.replace(/^-+/, '');
  if (COMMANDS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  return null;
}

export { Cancelled };
