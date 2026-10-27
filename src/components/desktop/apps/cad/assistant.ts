/**
 * The drawing as the assistant edits it: `drawing.json`, a plain JSON copy
 * of the drawing with one entity per line, written to the conversation's
 * folder before each prompt and read back as the agent saves it.
 *
 * What comes back is applied as a change from what was written rather than
 * as a whole new drawing, so edits the user makes meanwhile survive: the
 * entities the agent left alone stay as they are now, the ones it changed
 * (by id) are replaced, the ones it removed go, and ones without an id are
 * new. Fields it leaves out get defaults, and fields CAD derives (a hatch's
 * pattern lines, a dimension's block) are worked out again.
 */
import {
  BYLAYER,
  LW_BYLAYER,
  defaultLayer,
  newId,
  type Block,
  type DimKind,
  type Drawing,
  type Entity,
  type HatchLoop,
  type Header,
  type PlineVertex,
  type Vec,
} from './model';
import { TAU } from './geom';
import { PATTERNS, patternLines } from './hatch';
import { measure } from './dim';

/** What was written, to tell the agent's changes from what it left alone. */
export interface Snapshot {
  /** Each entity written, by id, with its `key`. */
  entities: Map<number, { e: Entity; key: string }>;
  /** Each table's `key` as written. */
  tables: Record<TableKey, string>;
}

type TableKey = 'header' | 'layers' | 'linetypes' | 'textStyles' | 'dimStyles' | 'blocks';
const TABLES: TableKey[] = ['header', 'layers', 'linetypes', 'textStyles', 'dimStyles', 'blocks'];

/**
 * JSON with keys sorted, to compare values whatever order a script wrote
 * them in.
 */
function key(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : key(x))).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${key(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** An entity as the agent sees it: without what CAD works out for itself. */
function visible(e: Entity): Record<string, unknown> {
  const head = { id: e.id, type: e.type };
  if (e.type === 'dim') {
    const { block: _b, measurement: _m, ...rest } = e;
    return { ...head, ...rest };
  }
  if (e.type === 'hatch') {
    const { lines: _l, ...rest } = e;
    return { ...head, ...rest };
  }
  return { ...head, ...e };
}

const namedBlocks = (d: Drawing): Record<string, Block> =>
  Object.fromEntries(Object.entries(d.blocks).filter(([, b]) => !(b.flags & 1)));

function blocksOut(d: Drawing): Record<string, unknown> {
  return Object.fromEntries(Object.entries(namedBlocks(d)).map(([k, b]) => [k, { ...b, entities: b.entities.map(visible) }]));
}

/** The text for drawing.json, and what to compare the agent's version with. */
export function writeAgentDrawing(d: Drawing): { text: string; snapshot: Snapshot } {
  const entities = new Map(d.entities.map((e) => [e.id, { e, key: key(visible(e)) }]));
  const tables = {
    header: key(d.header),
    layers: key(d.layers),
    linetypes: key(d.linetypes),
    textStyles: key(d.textStyles),
    dimStyles: key(d.dimStyles),
    blocks: key(blocksOut(d)),
  };
  const list = (items: unknown[]) => (items.length ? `[\n    ${items.map((x) => JSON.stringify(x)).join(',\n    ')}\n  ]` : '[]');
  const blocks = Object.entries(blocksOut(d));
  const blockText = blocks.length ? `{\n${blocks.map(([k, b]) => `    ${JSON.stringify(k)}: ${JSON.stringify(b)}`).join(',\n')}\n  }` : '{}';
  const text = [
    '{',
    `  "header": ${JSON.stringify(d.header)},`,
    `  "layers": ${list(d.layers)},`,
    `  "linetypes": ${list(d.linetypes)},`,
    `  "textStyles": ${list(d.textStyles)},`,
    `  "dimStyles": ${list(d.dimStyles)},`,
    `  "blocks": ${blockText},`,
    `  "entities": ${list(d.entities.map(visible))}`,
    '}',
    '',
  ].join('\n');
  return { text, snapshot: { entities, tables } };
}

// ---- Reading it back ------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const str = (v: unknown, def: string): string => (typeof v === 'string' ? v : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

class Invalid extends Error {}

function vec(v: unknown, what: string, def?: Vec): Vec {
  if (isObj(v) && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
  if (Array.isArray(v) && v.length >= 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return { x: v[0] as number, y: v[1] as number };
  if (def) return def;
  throw new Invalid(`needs ${what} as {"x": …, "y": …}`);
}

function vecs(v: unknown, what: string, min: number): Vec[] {
  if (!Array.isArray(v) || v.length < min) throw new Invalid(`needs ${what} with at least ${min} points`);
  return v.map((p) => vec(p, what));
}

function vertices(v: unknown): PlineVertex[] {
  if (!Array.isArray(v) || v.length < 2) throw new Invalid('needs pts with at least 2 vertices');
  return v.map((p) => {
    const q = vec(p, 'pts');
    const r = isObj(p) ? p : {};
    const out: PlineVertex = { ...q, b: num(r.b, 0) };
    if (typeof r.sw === 'number') out.sw = r.sw;
    if (typeof r.ew === 'number') out.ew = r.ew;
    return out;
  });
}

/** A clamped, uniform knot vector for a spline through `n` control points. */
function knotsFor(n: number, degree: number): number[] {
  const k: number[] = [];
  const inner = n - degree;
  for (let i = 0; i < n + degree + 1; i++) k.push(i <= degree ? 0 : i >= n ? inner : i - degree);
  return k;
}

const DIM_KINDS: DimKind[] = ['linear', 'aligned', 'angular', 'angular3', 'radius', 'diameter', 'ordinate'];

function loops(v: unknown): HatchLoop[] {
  if (!Array.isArray(v) || !v.length) throw new Invalid('needs loops, its boundary');
  return v.map((l) => {
    if (!isObj(l)) throw new Invalid('has a loop that isn’t an object');
    if (l.kind === 'edges') {
      if (!Array.isArray(l.edges) || !l.edges.length) throw new Invalid('has an edges loop without edges');
      return { kind: 'edges', edges: l.edges as Extract<HatchLoop, { kind: 'edges' }>['edges'], flags: num(l.flags, 1) };
    }
    return { kind: 'poly', pts: vertices(l.pts), closed: bool(l.closed, true), flags: num(l.flags, 1) };
  });
}

/**
 * One entity from the agent's file, with defaults filled in. `was` is the
 * entity it had that id, whose derived fields are kept when nothing they
 * depend on changed.
 */
function entity(r: Raw, h: Header, metric: boolean, was: Entity | undefined): Entity {
  const base = {
    id: 0,
    layer: str(r.layer, h.clayer) || '0',
    color: num(r.color, BYLAYER),
    linetype: str(r.linetype, 'ByLayer'),
    lineweight: num(r.lineweight, LW_BYLAYER),
    ltscale: num(r.ltscale, 1),
    ...(r.hidden === true ? { hidden: true } : {}),
  };
  const text = () => {
    const p = vec(r.p, 'p (the insertion point)');
    return { p, a: vec(r.a, 'a', p), h: num(r.h, h.textsize), rot: num(r.rot, 0), text: str(r.text, ''), style: str(r.style, h.textstyle), wf: num(r.wf, 1), oblique: num(r.oblique, 0), halign: Math.round(num(r.halign, 0)) as 0, valign: Math.round(num(r.valign, 0)) as 0 };
  };
  switch (r.type) {
    case 'line':
      return { ...base, type: 'line', a: vec(r.a, 'a'), b: vec(r.b, 'b') };
    case 'circle':
      return { ...base, type: 'circle', c: vec(r.c, 'c (the center)'), r: positive(r.r, 'r (the radius)') };
    case 'arc':
      return { ...base, type: 'arc', c: vec(r.c, 'c (the center)'), r: positive(r.r, 'r (the radius)'), start: num(r.start, 0), end: num(r.end, Math.PI) };
    case 'ellipse':
      return { ...base, type: 'ellipse', c: vec(r.c, 'c (the center)'), major: vec(r.major, 'major (the major axis’s end, from the center)'), ratio: num(r.ratio, 1), start: num(r.start, 0), end: num(r.end, TAU) };
    case 'pline':
      return { ...base, type: 'pline', pts: vertices(r.pts), closed: bool(r.closed, false), width: num(r.width, 0) };
    case 'spline': {
      const ctrl = vecs(r.ctrl, 'ctrl (control points)', 2);
      const degree = Math.max(1, Math.min(ctrl.length - 1, Math.round(num(r.degree, 3))));
      const given = Array.isArray(r.knots) && r.knots.length === ctrl.length + degree + 1 && r.knots.every((k) => typeof k === 'number') ? (r.knots as number[]) : null;
      const out: Entity = { ...base, type: 'spline', degree, knots: given ?? knotsFor(ctrl.length, degree), ctrl, closed: bool(r.closed, false) };
      if (Array.isArray(r.weights) && r.weights.length === ctrl.length) out.weights = r.weights.map((w) => num(w, 1));
      if (Array.isArray(r.fit)) out.fit = r.fit.map((p) => vec(p, 'fit'));
      return out;
    }
    case 'point':
      return { ...base, type: 'point', p: vec(r.p, 'p') };
    case 'text':
      return { ...base, type: 'text', ...text() };
    case 'attdef':
      return { ...base, type: 'attdef', ...text(), tag: str(r.tag, 'TAG'), prompt: str(r.prompt, ''), flags: num(r.flags, 0) };
    case 'mtext':
      return { ...base, type: 'mtext', p: vec(r.p, 'p (the insertion point)'), h: num(r.h, h.textsize), width: num(r.width, 0), rot: num(r.rot, 0), attach: Math.round(num(r.attach, 1)), text: str(r.text, ''), style: str(r.style, h.textstyle), spacing: num(r.spacing, 1) };
    case 'insert': {
      if (typeof r.block !== 'string' || !r.block) throw new Invalid('needs block, the name of the block it shows');
      const out: Entity = { ...base, type: 'insert', block: r.block, p: vec(r.p, 'p (the insertion point)'), sx: num(r.sx, 1), sy: num(r.sy, num(r.sx, 1)), rot: num(r.rot, 0), attribs: Array.isArray(r.attribs) ? (r.attribs.filter(isObj) as unknown as Extract<Entity, { type: 'insert' }>['attribs']) : [] };
      for (const k of ['cols', 'rows', 'dc', 'dr'] as const) if (typeof r[k] === 'number') out[k] = r[k] as number;
      return out;
    }
    case 'dim': {
      const kind = DIM_KINDS.includes(r.kind as DimKind) ? (r.kind as DimKind) : 'linear';
      const p10 = vec(r.p10, 'p10');
      const p15 = vec(r.p15, 'p15', p10);
      const out: Entity = {
        ...base,
        type: 'dim',
        kind,
        style: str(r.style, h.dimstyle),
        p10,
        p13: vec(r.p13, 'p13', p10),
        p14: vec(r.p14, 'p14', p10),
        p15,
        text: vec(r.text, 'text', kind === 'radius' || kind === 'diameter' ? p15 : p10),
        rot: num(r.rot, 0),
        override: str(r.override, ''),
        textMoved: bool(r.textMoved, false),
      };
      if (r.p16 !== undefined) out.p16 = vec(r.p16, 'p16');
      if (typeof r.ordinateX === 'boolean') out.ordinateX = r.ordinateX;
      out.measurement = measure(out);
      return out;
    }
    case 'hatch': {
      const pattern = str(r.pattern, r.solid === true ? 'SOLID' : 'ANSI31').toUpperCase();
      const solid = bool(r.solid, pattern === 'SOLID');
      const angle = num(r.angle, 0);
      const scale = num(r.scale, 1);
      const same = was?.type === 'hatch' && was.pattern === pattern && was.angle === angle && was.scale === scale && was.solid === solid;
      return {
        ...base,
        type: 'hatch',
        loops: loops(r.loops),
        solid,
        pattern,
        angle,
        scale,
        lines: same ? was.lines : solid ? [] : patternLines(PATTERNS[pattern] ? pattern : 'ANSI31', angle, scale, metric),
        style: num(r.style, 0),
        patternType: num(r.patternType, 1),
        double: bool(r.double, false),
      };
    }
    case 'solid':
    case 'face': {
      const pts = vecs(r.pts, 'pts', 3);
      const four = [pts[0], pts[1], pts[2], pts[3] ?? pts[2]] as [Vec, Vec, Vec, Vec];
      return r.type === 'solid' ? { ...base, type: 'solid', pts: four } : { ...base, type: 'face', pts: four, invisible: num(r.invisible, 0) };
    }
    case 'leader':
      return { ...base, type: 'leader', pts: vecs(r.pts, 'pts', 2), arrow: bool(r.arrow, true), style: str(r.style, h.dimstyle), spline: bool(r.spline, false) };
    case 'xline':
    case 'ray':
      return { ...base, type: r.type, p: vec(r.p, 'p'), dir: vec(r.dir, 'dir') };
    default:
      throw new Invalid(`has an unknown type ${JSON.stringify(r.type)}`);
  }
}

function positive(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  throw new Invalid(`needs ${what}, a positive number`);
}

export interface Merged {
  drawing: Drawing;
  /** The entities the agent added, as they went in, for the next read to replace. */
  added: Entity[];
  changed: number;
  removed: number;
  /** Entities that couldn't be read, and why. */
  problems: string[];
}

/**
 * Apply the agent's drawing.json to `current`. `added` are the entities its
 * last read of this turn put in, which this one replaces. Throws when the
 * file isn't a drawing at all (it may be half written).
 */
export function readAgentDrawing(text: string, snapshot: Snapshot, current: Drawing, added: Entity[]): Merged {
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed) || !Array.isArray(parsed.entities)) throw new Error('drawing.json needs an "entities" list');
  const problems: string[] = [];

  // Tables first: entities take their defaults from the header.
  const next: Drawing = { ...current };
  const changedTable = (k: TableKey) => k in parsed && key(parsed[k]) !== snapshot.tables[k];
  if (changedTable('header') && isObj(parsed.header)) next.header = { ...current.header, ...(parsed.header as Partial<Header>) };
  if (changedTable('layers') && Array.isArray(parsed.layers)) {
    next.layers = parsed.layers.filter((l): l is Raw => isObj(l) && typeof l.name === 'string' && l.name !== '').map((l) => ({ ...defaultLayer(l.name as string), ...l }) as Drawing['layers'][number]);
  }
  for (const k of ['linetypes', 'textStyles', 'dimStyles'] as const) {
    if (changedTable(k) && Array.isArray(parsed[k])) {
      const was = current[k] as { name: string }[];
      const list = (parsed[k] as unknown[]).filter((x): x is Raw => isObj(x) && typeof x.name === 'string');
      // New ones start from the first, so they have every field.
      (next as unknown as Record<string, unknown>)[k] = list.map((x) => ({ ...(was.find((w) => w.name === x.name) ?? was[0] ?? {}), ...x }));
    }
  }
  const metric = next.header.measurement === 1;
  if (changedTable('blocks') && isObj(parsed.blocks)) {
    const blocks: Record<string, Block> = Object.fromEntries(Object.entries(current.blocks).filter(([, b]) => b.flags & 1));
    for (const [name, b] of Object.entries(parsed.blocks)) {
      if (!isObj(b)) continue;
      const list: Entity[] = [];
      for (const [i, r] of (Array.isArray(b.entities) ? b.entities : []).entries()) {
        try {
          if (!isObj(r)) throw new Invalid('isn’t an object');
          list.push({ ...entity(r, next.header, metric, undefined), id: newId() });
        } catch (err) {
          if (err instanceof Invalid) problems.push(`Block ${name}, entity ${i + 1} ${err.message}`);
          else throw err;
        }
      }
      blocks[name] = { name, base: vec(b.base, 'base', { x: 0, y: 0 }), entities: list, flags: num(b.flags, 0) & ~1, description: str(b.description, '') };
    }
    next.blocks = blocks;
  }

  // Then the entities.
  const seen = new Set<number>();
  const changed = new Map<number, Entity>();
  const fresh: Entity[] = [];
  for (const [i, r] of parsed.entities.entries()) {
    try {
      if (!isObj(r)) throw new Invalid('isn’t an object');
      const id = typeof r.id === 'number' ? r.id : null;
      const old = id !== null && !seen.has(id) ? snapshot.entities.get(id) : undefined;
      if (old) {
        seen.add(id!);
        if (key(r) === old.key) continue;
        const e = entity(r, next.header, metric, old.e);
        // Fields this doesn't know about stay as they were; a dimension's block is drawn again.
        const merged = { ...old.e, ...e, id: id! } as Entity;
        if (merged.type === 'dim') merged.block = undefined;
        if (key(visible(merged)) !== old.key) changed.set(id!, merged);
      } else fresh.push(entity(r, next.header, metric, undefined));
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      const id = isObj(r) && typeof r.id === 'number' ? r.id : null;
      // A broken edit leaves the entity as it was.
      if (id !== null && snapshot.entities.has(id)) seen.add(id);
      problems.push(`Entity ${i + 1}${isObj(r) && typeof r.type === 'string' ? ` (${r.type})` : ''} ${err.message}`);
    }
  }
  const removed = new Set([...snapshot.entities.keys()].filter((id) => !seen.has(id)));
  const before = new Set(added.map((e) => e.id));
  // New ones the last read put in keep their ids (and cached geometry) while unchanged.
  const nextAdded = fresh.map((e, i) => {
    const prev = added[i];
    return prev && key(visible({ ...e, id: prev.id })) === key(visible(prev)) ? prev : { ...e, id: newId() };
  });
  // Tables read the same as before stay the same objects, and so does the geometry cached for them.
  for (const k of TABLES) if (next[k] !== current[k] && key(next[k]) === key(current[k])) (next as unknown as Record<string, unknown>)[k] = current[k];
  const styleChanged = next.dimStyles !== current.dimStyles;
  next.entities = [
    ...current.entities
      .filter((e) => !before.has(e.id) && !removed.has(e.id))
      .map((e) => {
        let c = changed.get(e.id);
        // An earlier read this turn may have put it in already.
        if (!c || key(visible(c)) === key(visible(e))) c = e;
        return styleChanged && c.type === 'dim' ? { ...c, block: undefined } : c;
      }),
    ...nextAdded,
  ];

  // Layers the agent drew on without adding them.
  const names = new Set(next.layers.map((l) => l.name.toUpperCase()));
  const missing = [...new Set(next.entities.map((e) => e.layer))].filter((n) => !names.has(n.toUpperCase()));
  if (missing.length) next.layers = [...next.layers, ...missing.map((n) => defaultLayer(n))];
  if (next.layers !== current.layers && key(next.layers) === key(current.layers)) next.layers = current.layers;

  const same =
    next.entities.length === current.entities.length &&
    next.entities.every((e, i) => e === current.entities[i]) &&
    TABLES.every((k) => next[k] === current[k]);
  return { drawing: same ? current : next, added: nextAdded, changed: changed.size, removed: removed.size, problems };
}

// ---- What the agent is told -----------------------------------------------------------------

const UNITS: Record<number, string> = { 0: 'unitless', 1: 'inches', 2: 'feet', 4: 'millimeters', 5: 'centimeters', 6: 'meters' };

export function unitsName(d: Drawing): string {
  return UNITS[d.header.insunits] ?? (d.header.measurement === 1 ? 'millimeters' : 'inches');
}

/** INSTRUCTIONS.md, sent with the conversation's first message. */
export function instructions(name: string, d: Drawing): string {
  return `# Editing a drawing in CAD

You're working on **${name}**, a 2D drawing the user has open in Din's CAD app (which works like AutoCAD). They're looking at it now, and see your changes as you save them.

## Files in this folder

- \`drawing.json\` — the drawing. **Edit this file in place**; that's the only way to change the drawing. CAD reads it every time it's saved, and once more when you finish. It's rewritten from what's on screen before each of the user's messages (they may have edited by hand meanwhile), so read it again then rather than relying on an earlier copy.
- \`view.md\` — what the user can see and has selected right now ("this", "these", "here" mean those). Rewritten with each message.
- \`view.png\` — a picture of their screen. Look at it when the layout matters.

Don't write other drawing files or touch the original on disk: CAD saves when the user does.

## How drawing.json works

- One entity per line in \`"entities"\`, in draw order. For large or repetitive edits, write a short script (Python or Node) that loads the JSON, changes it, and writes it back.
- **Keep the \`id\`** of an entity you change. **Leave \`id\` out** of new entities. **Delete the line** to erase one.
- Fields you leave out get defaults: \`layer\` is the current layer (\`header.clayer\`), \`color\` ByLayer, \`linetype\` "ByLayer", \`lineweight\` ByLayer, text height \`header.textsize\`, styles the current ones.
- The tables (\`header\`, \`layers\`, \`linetypes\`, \`textStyles\`, \`dimStyles\`, \`blocks\`) can be edited too. A layer an entity names but the table lacks is added.
- Units are **${unitsName(d)}**. The Y axis points up. **Angles are radians**, counterclockwise from +X. Points are \`{"x": 1, "y": 2}\`.
- Colors are AutoCAD Color Index numbers: 1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black, 8 dark gray, 9 light gray, 256 ByLayer, 0 ByBlock. A true color is 16777216 + 0xRRGGBB.
- Lineweights are hundredths of a millimeter (25 = 0.25 mm); -1 ByLayer, -2 ByBlock, -3 default.

## Entity types

Every entity also has \`layer\`, \`color\`, \`linetype\`, \`lineweight\`, \`ltscale\`.

- \`{"type":"line","a":P,"b":P}\`
- \`{"type":"circle","c":P,"r":R}\`
- \`{"type":"arc","c":P,"r":R,"start":A,"end":A}\` — counterclockwise from start to end.
- \`{"type":"ellipse","c":P,"major":P,"ratio":0.5,"start":0,"end":6.283185307179586}\` — \`major\` is the major axis's endpoint relative to the center; ratio is minor/major.
- \`{"type":"pline","pts":[{"x":0,"y":0,"b":0},…],"closed":true,"width":0}\` — \`b\` is the bulge to the next vertex: tan(sweep/4), 0 for straight, 1 for a counterclockwise half circle. Use closed polylines for rectangles and outlines.
- \`{"type":"spline","degree":3,"ctrl":[P,…]}\` — control points; knots are worked out if left out.
- \`{"type":"point","p":P}\`
- \`{"type":"text","p":P,"h":H,"text":"…","rot":0,"halign":0,"valign":0,"a":P}\` — single line. \`h\` is the capital height. halign 0 left, 1 center, 2 right, 4 middle; valign 0 baseline, 1 bottom, 2 middle, 3 top. Unless left/baseline, \`a\` is the alignment point the text is placed by. %%d is °, %%c is Ø, %%p is ±.
- \`{"type":"mtext","p":P,"h":H,"width":0,"attach":1,"text":"…"}\` — multiline; \`\\P\` in the text (\`"\\\\P"\` in the JSON) starts a new line. attach 1–9 is top-left to bottom-right; width 0 doesn't wrap.
- \`{"type":"insert","block":"NAME","p":P,"sx":1,"sy":1,"rot":0}\` — a block reference; the block must be in \`blocks\`.
- \`{"type":"dim","kind":"linear","p13":P,"p14":P,"p10":P,"rot":0}\` — linear (or "aligned") dimension measuring p13 to p14 with its line through p10; rot is the line's angle (0 horizontal, π/2 vertical). \`{"type":"dim","kind":"radius","p10":center,"p15":pointOnCircle}\`, \`{"type":"dim","kind":"diameter","p15":P,"p10":oppositePoint}\`. \`override\` replaces the measured text ("<>" stands for the measurement).
- \`{"type":"hatch","pattern":"ANSI31","scale":1,"angle":0,"loops":[{"kind":"poly","pts":[{"x":0,"y":0,"b":0},…],"closed":true}]}\` — patterns: SOLID, ${Object.keys(PATTERNS).join(', ')}.
- \`{"type":"leader","pts":[arrowTip,…],"arrow":true}\`
- \`{"type":"solid","pts":[P,P,P,P]}\` — filled; the 3rd and 4th corners are swapped from drawing order.
- \`{"type":"xline","p":P,"dir":P}\` and \`"ray"\` — construction lines.

Blocks are \`{"name":"NAME","base":P,"flags":0,"description":"","entities":[…]}\` with entities relative to \`base\`.

## When you're done

Say in a sentence or two what you changed. Ask first if the request is ambiguous and getting it wrong would mean a lot of rework.
`;
}
