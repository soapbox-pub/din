/**
 * The command line's side of things: what a running command is waiting
 * for (a point, a distance, a choice, objects), and parsing what's typed
 * the way AutoCAD does: 3,4 · @3,4 · @5<30 · 5<30 · direct distances ·
 * option keywords.
 */
import type { Entity, Vec } from './model';

export interface Keyword {
  /** As shown in the prompt, with its shortcut capitalized: "Undo", "Close", "3P". */
  name: string;
  /** What to type, upper case. Defaults to the capitals in the name. */
  key?: string;
}

export const kwKey = (k: Keyword) => (k.key ?? k.name.replace(/[^A-Z0-9]/g, '') ?? k.name).toUpperCase() || k.name.toUpperCase();

interface Common {
  prompt: string;
  keywords?: Keyword[];
  /** Shown as <default>, returned for an empty Enter. */
  default?: string;
}

export interface PointReq extends Common {
  kind: 'point';
  /** Rubber band, direct distance and polar tracking work from here. */
  base?: Vec | null;
  /** Ghost entities following the cursor. */
  preview?: (p: Vec) => Entity[];
  /** A typed number comes back as a number instead of a direct distance. */
  number?: boolean;
  /** Draw a rubber-band line from the base. */
  rubber?: boolean;
  /** The point is a window corner: draw a box from base. */
  box?: boolean;
}

export interface StringReq extends Common {
  kind: 'string';
  /** Spaces are typed rather than ending the input (TEXT's contents). */
  spaces?: boolean;
}

export interface SelectReq extends Common {
  kind: 'select';
  /** Objects for which this is false can't be picked. */
  filter?: (e: Entity) => boolean;
}

export interface PickReq extends Common {
  kind: 'pick';
  filter?: (e: Entity) => boolean;
  /** Highlight this while asking. */
  highlight?: Entity[];
}

export type Req = PointReq | StringReq | SelectReq | PickReq;

export type Answer = { t: 'point'; p: Vec } | { t: 'number'; n: number } | { t: 'keyword'; k: string } | { t: 'enter' } | { t: 'text'; s: string } | { t: 'objects'; list: Entity[] } | { t: 'pick'; e: Entity; p: Vec };

export class Cancelled extends Error {
  constructor() {
    super('*Cancel*');
  }
}

/** The prompt as the command line shows it: "Specify next point or [Undo/Close] <4.0000>:". */
export function promptText(r: Req): string {
  let s = r.prompt;
  // A question offers its answers ("Erase source objects? [Yes/No]") rather than options.
  if (r.keywords?.length) s += `${s.endsWith('?') ? '' : ' or'} [${r.keywords.map((k) => k.name).join('/')}]`;
  if (r.default !== undefined && r.default !== '') s += ` <${r.default}>`;
  return `${s}:`;
}

export interface ParseCtx {
  /** The last point picked, for @ coordinates. */
  last: Vec | null;
  /** The request's base, for direct distance. */
  base: Vec | null;
  /** Where the cursor is (after ortho and polar), for direct distance's direction. */
  cursor: Vec | null;
  /** Angles counterclockwise in degrees from east, unless the drawing says otherwise. */
  angdir: boolean;
  angbase: number;
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;

/** Parse a length, accepting feet and inches (3'6", 2'-4 1/2", 7/8"). */
export function parseLength(s: string): number | null {
  const t = s.trim();
  if (new RegExp(`^${NUM}$`).test(t)) return parseFloat(t);
  const arch = /^(-)?(?:(\d+(?:\.\d+)?)')?-?\s*(?:(\d+(?:\.\d+)?)?(?:\s*(\d+)\/(\d+))?"?)?$/.exec(t);
  if (arch && (arch[2] || arch[3] || arch[4]) && /['"/]/.test(t)) {
    const ft = parseFloat(arch[2] ?? '0');
    const inch = parseFloat(arch[3] ?? '0') + (arch[4] ? parseFloat(arch[4]) / parseFloat(arch[5]) : 0);
    const v = ft * 12 + inch;
    return arch[1] ? -v : v;
  }
  if (/^\d+\/\d+$/.test(t)) {
    const [a, b] = t.split('/').map(Number);
    return b ? a / b : null;
  }
  return null;
}

/** Degrees as typed ("30", "30d", "-45"), to radians in drawing terms. */
export function parseAngle(s: string, ctx: Pick<ParseCtx, 'angdir' | 'angbase'>): number | null {
  const t = s.trim().replace(/[d°]$/i, '');
  if (!new RegExp(`^${NUM}$`).test(t)) return null;
  const deg = parseFloat(t);
  const rad = (deg * Math.PI) / 180;
  return ctx.angbase + (ctx.angdir ? -rad : rad);
}

/** What typed input means for a request. */
export function parseInput(raw: string, r: Req, ctx: ParseCtx): Answer | { t: 'error'; msg: string } {
  const s = raw.trim();
  if (s === '') {
    if (r.default !== undefined && r.default !== '' && r.kind !== 'string') return parseInput(r.default, { ...r, default: undefined }, ctx);
    if (r.kind === 'string' && r.default !== undefined) return { t: 'text', s: r.default };
    return { t: 'enter' };
  }
  if (r.kind === 'string') return { t: 'text', s: raw };
  // Keywords: the capitalized shortcut, or the whole word.
  const up = s.toUpperCase();
  for (const k of r.keywords ?? []) {
    const key = kwKey(k);
    if (up === key || up === k.name.toUpperCase() || (up.length >= key.length && k.name.toUpperCase().startsWith(up))) return { t: 'keyword', k: k.name };
  }
  if (r.kind !== 'point') return { t: 'error', msg: 'Invalid option keyword.' };
  // Coordinates.
  const rel = s.startsWith('@');
  const abs = s.startsWith('#');
  const body = rel || abs ? s.slice(1) : s;
  if (rel && body === '') return ctx.last ? { t: 'point', p: ctx.last } : { t: 'error', msg: 'No last point.' };
  const polar = body.split('<');
  if (polar.length === 2) {
    const d = parseLength(polar[0]);
    const a = parseAngle(polar[1], ctx);
    if (d === null || a === null) return { t: 'error', msg: 'Point or option keyword required.' };
    const origin = rel ? (ctx.last ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    return { t: 'point', p: { x: origin.x + d * Math.cos(a), y: origin.y + d * Math.sin(a) } };
  }
  const parts = body.split(',');
  if (parts.length === 2 || parts.length === 3) {
    const x = parseLength(parts[0]);
    const y = parseLength(parts[1]);
    if (x === null || y === null) return { t: 'error', msg: 'Point or option keyword required.' };
    const origin = rel ? (ctx.last ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    return { t: 'point', p: { x: origin.x + x, y: origin.y + y } };
  }
  const n = parseLength(body);
  if (n !== null && !rel) {
    if (r.number) return { t: 'number', n };
    // Direct distance: that far from the base toward the cursor.
    const base = r.base ?? null;
    if (base && ctx.cursor) {
      const dx = ctx.cursor.x - base.x;
      const dy = ctx.cursor.y - base.y;
      const L = Math.hypot(dx, dy);
      if (L > 1e-12) return { t: 'point', p: { x: base.x + (dx / L) * n, y: base.y + (dy / L) * n } };
    }
    return { t: 'error', msg: 'Point or option keyword required.' };
  }
  return { t: 'error', msg: 'Point or option keyword required.' };
}
