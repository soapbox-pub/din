/**
 * What saving needs before any bytes are written, the same for DWG and DXF:
 * tables holding everything the entities name, a block for every dimension,
 * and the view the drawing opens at.
 */
import { CONTINUOUS, LW_DEFAULT, type Block, type DimStyle, type Dimension, type Drawing, type Entity, type Layer, type Linetype, type TextStyle, type Vec } from './model';

export interface WriteOptions {
  /** The model space's extents, for EXTMIN/EXTMAX and the initial view. */
  extents: { min: Vec; max: Vec } | null;
  /** The geometry of a dimension that has no block of its own yet. */
  dimBlock: (dim: Dimension) => Entity[];
  /** Times are Julian dates. */
  now: number;
}

export interface Prepared {
  layers: Layer[];
  /** ByBlock, ByLayer and Continuous first. */
  linetypes: Linetype[];
  styles: TextStyle[];
  dimstyles: DimStyle[];
  blocks: Record<string, Block>;
  model: Entity[];
  paper: Entity[];
  view: { center: Vec; height: number };
}

const upper = (s: string) => s.toUpperCase();

export function prepare(d: Drawing, opts: WriteOptions): Prepared {
  const layers: Layer[] = d.layers.map((l) => ({ ...l }));
  const haveLayer = (n: string) => layers.some((l) => upper(l.name) === upper(n));
  const linetypes: Linetype[] = [];
  for (const name of ['ByBlock', 'ByLayer', CONTINUOUS]) {
    linetypes.push(d.linetypes.find((l) => upper(l.name) === upper(name)) ?? { name, description: name === CONTINUOUS ? 'Solid line' : '', pattern: [] });
  }
  for (const lt of d.linetypes) if (!linetypes.some((l) => upper(l.name) === upper(lt.name))) linetypes.push(lt);
  const styles: TextStyle[] = d.textStyles.length ? [...d.textStyles] : [{ name: 'Standard', font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 }];
  const dimstyles: DimStyle[] = [...d.dimStyles];

  const blocks: Record<string, Block> = { ...d.blocks };
  const allEntities = (fn: (e: Entity) => void) => {
    const walk = (list: Entity[]) => list.forEach(fn);
    walk(d.entities);
    walk(d.paper);
    for (const b of Object.values(blocks)) walk(b.entities);
  };

  // Dimensions without a block get one drawn now.
  let anon = 1;
  const usedNames = new Set(Object.keys(blocks).map(upper));
  const freshAnon = (prefix: string) => {
    let n: string;
    do n = `${prefix}${anon++}`;
    while (usedNames.has(upper(n)));
    usedNames.add(upper(n));
    return n;
  };
  const fixDims = (list: Entity[]): Entity[] =>
    list.map((e) => {
      if (e.type !== 'dim') return e;
      if (e.block && blocks[e.block]) return e;
      const name = freshAnon('*D');
      blocks[name] = { name, base: { x: 0, y: 0 }, entities: opts.dimBlock(e), flags: 1, description: '' };
      return { ...e, block: name };
    });
  const model = fixDims(d.entities);
  const paper = fixDims(d.paper);
  for (const b of Object.values({ ...blocks })) if (b.entities.some((e) => e.type === 'dim' && !(e.block && blocks[e.block]))) blocks[b.name] = { ...b, entities: fixDims(b.entities) };

  allEntities((e) => {
    if (!haveLayer(e.layer)) layers.push({ name: e.layer, color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
    if (!linetypes.some((l) => upper(l.name) === upper(e.linetype))) linetypes.push({ name: e.linetype, description: '', pattern: [] });
    const style = e.type === 'text' || e.type === 'attdef' || e.type === 'mtext' ? e.style : null;
    if (e.type === 'insert') for (const a of e.attribs) if (!styles.some((s) => upper(s.name) === upper(a.style))) styles.push({ name: a.style, font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 });
    if (e.type === 'dim' || e.type === 'leader') {
      if (!dimstyles.some((s) => upper(s.name) === upper(e.style))) dimstyles.push({ ...(dimstyles[0] ?? ({} as DimStyle)), name: e.style });
    } else if (style && !styles.some((s) => upper(s.name) === upper(style))) styles.push({ name: style, font: 'txt', bigfont: '', height: 0, width: 1, oblique: 0 });
  });
  if (!haveLayer('0')) layers.unshift({ name: '0', color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
  if (!dimstyles.length) throw new Error('A drawing needs a dimension style.');
  for (const l of layers) if (!linetypes.some((t) => upper(t.name) === upper(l.linetype))) l.linetype = CONTINUOUS;

  const ext = opts.extents;
  const hd = d.header;
  const view =
    d.view ??
    (ext
      ? { center: { x: (ext.min.x + ext.max.x) / 2, y: (ext.min.y + ext.max.y) / 2 }, height: Math.max(1e-6, (ext.max.y - ext.min.y) * 1.1, (ext.max.x - ext.min.x) * 0.6) }
      : { center: { x: (hd.limmax.x + hd.limmin.x) / 2, y: (hd.limmax.y + hd.limmin.y) / 2 }, height: hd.limmax.y - hd.limmin.y || 9 });

  return { layers, linetypes, styles, dimstyles, blocks, model, paper, view };
}
