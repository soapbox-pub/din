/**
 * Turns LibreDWG's view of a DWG into CAD's drawing. LibreDWG reads every
 * DWG from R13 to AutoCAD 2018's; this keeps what a 2D drafting app can
 * show and edit, flattens 3D to the XY plane, breaks down what has no
 * equivalent here (multileaders and multilines become leaders, text and
 * polylines), and counts the rest.
 */
import type { DwgDatabase, DwgEntity } from '@mlightcad/libredwg-web';
import {
  BYLAYER,
  CONTINUOUS,
  DEFAULT_DIMSTYLE,
  LINEWEIGHTS,
  LW_BYBLOCK,
  LW_BYLAYER,
  LW_DEFAULT,
  newDrawing,
  newId,
  STANDARD_LINETYPES,
  TRUE_COLOR,
  type Block,
  type DimKind,
  type DimStyle,
  type Drawing,
  type Entity,
  type EntityBase,
  type HAlign,
  type HatchEdge,
  type HatchLoop,
  type Layer,
  type Linetype,
  type PlineVertex,
  type TextStyle,
  type VAlign,
  type Vec,
} from '../model';
import { interpolateSpline } from '../geom';

export interface ReadResult {
  drawing: Drawing;
  /** What couldn't be kept, by kind, e.g. { '3D solid': 2 }. */
  dropped: Record<string, number>;
  version: string;
}

/** Parse a DWG in a worker of its own. */
export function readDwgBytes(bytes: Uint8Array): Promise<DwgDatabase> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./readWorker.ts', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<{ ok: true; db: DwgDatabase } | { ok: false; error: string }>) => {
      done();
      if (e.data.ok) resolve(e.data.db);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'The DWG reader stopped.'));
    };
    const copy = bytes.slice().buffer;
    worker.postMessage({ bytes: copy }, [copy]);
  });
}

const VERSIONS: Record<string, string> = {
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

export function dwgVersion(bytes: Uint8Array): string | null {
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  return /^AC\d{4}$/.test(magic) ? magic : null;
}

export function versionName(code: string): string {
  return VERSIONS[code] ?? code;
}

interface P3 {
  x: number;
  y: number;
  z?: number;
}

const v = (p: P3 | undefined): Vec => ({ x: p?.x ?? 0, y: p?.y ?? 0 });
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const str = (x: unknown, d = '') => (typeof x === 'string' ? x : d);

function lineweight(idx: unknown): number {
  const i = num(idx, 29);
  if (i === 29 || i === -1) return LW_BYLAYER;
  if (i === 30 || i === -2) return LW_BYBLOCK;
  if (i === 31 || i === -3) return LW_DEFAULT;
  if (i >= 0 && i < LINEWEIGHTS.length) return LINEWEIGHTS[i];
  // Some readers already give hundredths of a millimetre.
  return LINEWEIGHTS.includes(i) ? i : LW_DEFAULT;
}

function color(index: unknown, rgb: unknown): number {
  if (typeof rgb === 'number' && rgb >= 0 && rgb <= 0xffffff) return TRUE_COLOR | rgb;
  const i = num(index, BYLAYER);
  if (i < 0) return Math.min(255, -i);
  return Math.max(0, Math.min(256, i));
}

/** Entities drawn with their extrusion pointing down are mirrored in X. */
const flipped = (e: { extrusionDirection?: P3; normal?: P3 }) => (e.extrusionDirection?.z ?? e.normal?.z ?? 1) < -0.5;

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

export function convertDwg(db: DwgDatabase, version: string): ReadResult {
  const d = newDrawing(num(db.header.MEASUREMENT) === 1);
  const dropped: Record<string, number> = {};
  const drop = (what: string) => (dropped[what] = (dropped[what] ?? 0) + 1);
  const h = db.header as unknown as Record<string, unknown>;

  // ---- Header ---------------------------------------------------------------------------
  const hd = d.header;
  hd.insunits = num(h.INSUNITS, hd.insunits);
  hd.lunits = num(h.LUNITS, hd.lunits);
  hd.luprec = num(h.LUPREC, hd.luprec);
  hd.aunits = num(h.AUNITS, hd.aunits);
  hd.auprec = num(h.AUPREC, hd.auprec);
  hd.ltscale = num(h.LTSCALE, 1) || 1;
  hd.celtscale = num(h.CELTSCALE, 1) || 1;
  hd.textsize = num(h.TEXTSIZE, hd.textsize) || hd.textsize;
  hd.clayer = str(h.CLAYER, '0') || '0';
  hd.dimstyle = str(h.DIMSTYLE, hd.dimstyle) || hd.dimstyle;
  hd.textstyle = str(h.TEXTSTYLE, 'Standard') || 'Standard';
  hd.pdmode = num(h.PDMODE);
  hd.pdsize = num(h.PDSIZE);
  hd.filletrad = num(h.FILLETRAD);
  hd.chamfera = num(h.CHAMFERA);
  hd.chamferb = num(h.CHAMFERB);
  hd.angbase = num(h.ANGBASE);
  hd.angdir = num(h.ANGDIR) === 1;
  hd.fillmode = num(h.FILLMODE, 1) !== 0;
  hd.lwdisplay = num(h.LWDISPLAY) !== 0;
  if (h.LIMMIN) hd.limmin = v(h.LIMMIN as P3);
  if (h.LIMMAX) hd.limmax = v(h.LIMMAX as P3);

  // ---- Tables -----------------------------------------------------------------------------
  d.linetypes = [...STANDARD_LINETYPES];
  for (const t of db.tables.LTYPE?.entries ?? []) {
    if (/^by(layer|block)$|^continuous$/i.test(t.name)) continue;
    const lt: Linetype = { name: t.name, description: str(t.description), pattern: (t.pattern ?? []).map((p) => num(p.elementLength)) };
    d.linetypes.push(lt);
  }
  const layers: Layer[] = [];
  for (const l of db.tables.LAYER?.entries ?? []) {
    const flag = num(l.standardFlag);
    layers.push({
      name: l.name,
      color: color(l.colorIndex, l.color !== 0xffffff ? l.color : undefined),
      linetype: /^by(layer|block)$/i.test(l.lineType) || !l.lineType ? CONTINUOUS : l.lineType,
      lineweight: lineweight(l.lineweight),
      on: !l.off && num(l.colorIndex, 7) >= 0,
      frozen: !!l.frozen,
      // LibreDWG's own `locked` is misread; the flag bits are right.
      locked: (flag & 8) !== 0,
      plot: num(l.plotFlag, 1) !== 0,
    });
  }
  if (layers.length) d.layers = layers;

  const styles: TextStyle[] = [];
  const styleByHandle = new Map<string, string>();
  for (const s of db.tables.STYLE?.entries ?? []) {
    styleByHandle.set(s.handle, s.name);
    if (!s.name) continue;
    styles.push({ name: s.name, font: str(s.font, 'txt'), bigfont: str(s.bigFont), height: num(s.fixedTextHeight), width: num(s.widthFactor, 1) || 1, oblique: num(s.obliqueAngle) });
  }
  if (styles.length) d.textStyles = styles;

  const dimstyles: DimStyle[] = [];
  for (const s of db.tables.DIMSTYLE?.entries ?? []) {
    const r = s as unknown as Record<string, unknown>;
    const clr = (x: unknown) => {
      if (x && typeof x === 'object') return color((x as { index?: number }).index, undefined);
      return color(x, undefined);
    };
    const txsty = r.DIMTXSTY;
    const dsep = r.DIMDSEP;
    dimstyles.push({
      ...DEFAULT_DIMSTYLE,
      name: s.name,
      dimscale: num(r.DIMSCALE, 1) || 1,
      dimasz: num(r.DIMASZ, DEFAULT_DIMSTYLE.dimasz),
      dimtxt: num(r.DIMTXT, DEFAULT_DIMSTYLE.dimtxt),
      dimexo: num(r.DIMEXO, DEFAULT_DIMSTYLE.dimexo),
      dimexe: num(r.DIMEXE, DEFAULT_DIMSTYLE.dimexe),
      dimgap: num(r.DIMGAP, DEFAULT_DIMSTYLE.dimgap),
      dimdec: num(r.DIMDEC, 4),
      dimadec: num(r.DIMADEC, 0),
      dimtad: num(r.DIMTAD),
      dimtih: num(r.DIMTIH) !== 0,
      dimtoh: num(r.DIMTOH) !== 0,
      dimclrd: clr(r.DIMCLRD),
      dimclre: clr(r.DIMCLRE),
      dimclrt: clr(r.DIMCLRT),
      dimtxsty: typeof txsty === 'string' ? txsty : (styleByHandle.get(num(txsty).toString(16).toUpperCase()) ?? 'Standard'),
      dimlfac: num(r.DIMLFAC, 1) || 1,
      dimcen: num(r.DIMCEN, DEFAULT_DIMSTYLE.dimcen),
      dimtsz: num(r.DIMTSZ),
      dimdle: num(r.DIMDLE),
      dimpost: str(r.DIMPOST),
      dimzin: num(r.DIMZIN),
      dimlunit: num(r.DIMLUNIT, 2),
      dimdsep: typeof dsep === 'string' ? (dsep.charCodeAt(0) || 46) : num(dsep, 46),
      dimrnd: num(r.DIMRND),
      dimse1: num(r.DIMSE1) !== 0,
      dimse2: num(r.DIMSE2) !== 0,
      dimsd1: num(r.DIMSD1) !== 0,
      dimsd2: num(r.DIMSD2) !== 0,
      dimtofl: num(r.DIMTOFL) !== 0,
      dimjust: num(r.DIMJUST),
      dimatfit: num(r.DIMATFIT, 3),
      dimtix: num(r.DIMTIX) !== 0,
      dimsoxd: num(r.DIMSOXD) !== 0,
      dimlwd: lwRaw(r.DIMLWD),
      dimlwe: lwRaw(r.DIMLWE),
      dimblk: str(r.DIMBLK),
    });
  }
  if (dimstyles.length) d.dimStyles = dimstyles;

  // ---- Entities -----------------------------------------------------------------------------

  const common = (e: DwgEntity): Omit<EntityBase, 'id'> => {
    const lt = str(e.lineType);
    return {
      layer: e.layer || '0',
      color: color(e.colorIndex, e.color),
      linetype: !lt || /^bylayer$/i.test(lt) ? 'ByLayer' : /^byblock$/i.test(lt) ? 'ByBlock' : lt,
      lineweight: lineweight(e.lineweight),
      ltscale: num(e.lineTypeScale, 1) || 1,
      ...(e.isVisible === false ? { hidden: true } : {}),
    };
  };

  const convert = (raw: DwgEntity, out: Entity[]) => {
    const e = raw as DwgEntity & Record<string, unknown>;
    const base = { id: newId(), ...common(e) };
    const flip = flipped(e as { extrusionDirection?: P3 });
    const fx = (p: P3 | undefined): Vec => (flip ? { x: -(p?.x ?? 0), y: p?.y ?? 0 } : v(p));
    switch (e.type) {
      case 'LINE':
        out.push({ ...base, type: 'line', a: v(e.startPoint as P3), b: v(e.endPoint as P3) });
        return;
      case 'CIRCLE':
        out.push({ ...base, type: 'circle', c: fx(e.center as P3), r: num(e.radius) });
        return;
      case 'ARC': {
        let s = num(e.startAngle);
        let en = num(e.endAngle);
        if (flip) [s, en] = [Math.PI - en, Math.PI - s];
        out.push({ ...base, type: 'arc', c: fx(e.center as P3), r: num(e.radius), start: wrap(s), end: wrap(en) });
        return;
      }
      case 'ELLIPSE': {
        let s = num(e.startAngle);
        let en = num(e.endAngle, TAU);
        const whole = Math.abs(en - s - TAU) < 1e-9 || (s === 0 && en === 0);
        if (flip && !whole) [s, en] = [TAU - en, TAU - s];
        out.push({ ...base, type: 'ellipse', c: v(e.center as P3), major: v(e.majorAxisEndPoint as P3), ratio: num(e.axisRatio, 1) || 1, start: whole ? 0 : wrap(s), end: whole ? TAU : wrap(en) || TAU });
        return;
      }
      case 'LWPOLYLINE': {
        const pts = ((e.vertices as { x: number; y: number; bulge?: number; startWidth?: number; endWidth?: number }[]) ?? []).map((p) => {
          const q: PlineVertex = { x: flip ? -p.x : p.x, y: p.y, b: flip ? -num(p.bulge) : num(p.bulge) };
          if (p.startWidth || p.endWidth) {
            q.sw = num(p.startWidth);
            q.ew = num(p.endWidth);
          }
          return q;
        });
        if (pts.length < 2) return;
        out.push({ ...base, type: 'pline', pts, closed: (num(e.flag) & 0x200) !== 0 || (num(e.flag) & 1) !== 0, width: num(e.constantWidth) });
        return;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        type V = P3 & { bulge?: number; startWidth?: number; endWidth?: number; flag?: number };
        let verts = (e.vertices as V[]) ?? [];
        const flag = num(e.flag);
        if (flag & 64) return void drop('polyface mesh');
        if (flag & 16) return void drop('polygon mesh');
        if (verts.some((p) => (num(p.flag) & 8) !== 0)) verts = verts.filter((p) => !(num(p.flag) & 16));
        const flip2 = e.type === 'POLYLINE2D' && flip;
        const pts = verts.map((p) => {
          const q: PlineVertex = { x: flip2 ? -p.x : p.x, y: p.y, b: e.type === 'POLYLINE2D' ? (flip2 ? -num(p.bulge) : num(p.bulge)) : 0 };
          if (p.startWidth || p.endWidth) {
            q.sw = num(p.startWidth);
            q.ew = num(p.endWidth);
          }
          return q;
        });
        if (pts.length < 2) return;
        out.push({ ...base, type: 'pline', pts, closed: (flag & 1) !== 0, width: 0 });
        return;
      }
      case 'SPLINE': {
        const ctrl = ((e.controlPoints as P3[]) ?? []).map(v);
        const fit = ((e.fitPoints as P3[]) ?? []).map(v);
        const knots = (e.knots as number[]) ?? [];
        const weights = (e.weights as number[]) ?? [];
        const degree = num(e.degree, 3) || 3;
        if (ctrl.length >= 2 && knots.length === ctrl.length + degree + 1) {
          out.push({ ...base, type: 'spline', degree, knots, ctrl, weights: weights.length === ctrl.length ? weights : undefined, closed: (num(e.flag) & 1) !== 0 });
        } else if (fit.length >= 2) {
          const s = interpolateSpline(fit, e.startTangent ? v(e.startTangent as P3) : undefined, e.endTangent ? v(e.endTangent as P3) : undefined);
          out.push({ ...base, type: 'spline', degree: s.degree, knots: s.knots, ctrl: s.ctrl, fit, closed: (num(e.flag) & 1) !== 0 });
        }
        return;
      }
      case 'POINT':
        out.push({ ...base, type: 'point', p: v(e.position as P3) });
        return;
      case 'TEXT': {
        const t = textBase(e as unknown as TextLike, flip);
        out.push({ ...base, type: 'text', ...t, text: str(e.text) });
        return;
      }
      case 'ATTDEF': {
        const inner = (e.text ?? {}) as TextLike;
        out.push({ ...base, type: 'attdef', ...textBase(inner, flip), text: str(inner.text), tag: str(e.tag), prompt: str(e.prompt), flags: num(e.flags) });
        return;
      }
      case 'MTEXT': {
        const dir = (e.direction as P3) ?? { x: 1, y: 0 };
        const rot = Math.atan2(dir.y, dir.x) || num(e.rotation);
        out.push({ ...base, type: 'mtext', p: fx(e.insertionPoint as P3), h: num(e.textHeight, 1) || 1, width: num(e.rectWidth), rot, attach: num(e.attachmentPoint, 1) || 1, text: str(e.text), style: str(e.styleName, 'Standard') || 'Standard', spacing: num(e.lineSpacing, 1) || 1 });
        return;
      }
      case 'INSERT': {
        const atts = ((e.attribs as (DwgEntity & Record<string, unknown>)[]) ?? []).map((a) => {
          const inner = (a.text ?? {}) as TextLike;
          return { ...common(a), ...textBase(inner, flipped(inner)), text: str(inner.text), tag: str(a.tag), flags: num(a.flags) };
        });
        const sx = num(e.xScale, 1) || 1;
        const sy = num(e.yScale, 1) || 1;
        const cols = num(e.columnCount, 1);
        const rows = num(e.rowCount, 1);
        out.push({
          ...base,
          type: 'insert',
          block: str(e.name),
          p: fx(e.insertionPoint as P3),
          sx: flip ? -sx : sx,
          sy,
          rot: flip ? Math.PI - num(e.rotation) : num(e.rotation),
          attribs: atts,
          ...(cols > 1 || rows > 1 ? { cols: Math.max(1, cols), rows: Math.max(1, rows), dc: num(e.columnSpacing), dr: num(e.rowSpacing) } : {}),
        });
        return;
      }
      case 'DIMENSION': {
        const t = num(e.dimensionType) & 0x0f;
        const kinds: DimKind[] = ['linear', 'aligned', 'angular', 'diameter', 'radius', 'angular3', 'ordinate'];
        const kind = kinds[t];
        if (!kind) return void drop('dimension');
        const sub = str(e.subclassMarker);
        const p10 = v(e.definitionPoint as P3);
        out.push({
          ...base,
          type: 'dim',
          kind: kind === 'linear' && sub === 'AcDbAlignedDimension' && num(e.rotationAngle) === 0 && t === 1 ? 'aligned' : kind,
          style: str(e.styleName, d.header.dimstyle) || d.header.dimstyle,
          p10,
          p13: v(e.subDefinitionPoint1 as P3),
          p14: v(e.subDefinitionPoint2 as P3),
          p15: v(e.centerPoint as P3),
          p16: e.arcPoint ? v(e.arcPoint as P3) : undefined,
          text: v(e.textPoint as P3),
          rot: num(e.rotationAngle),
          override: str(e.text),
          textMoved: (num(e.dimensionType) & 128) !== 0,
          ordinateX: (num(e.dimensionType) & 64) !== 0,
          block: str(e.name) || undefined,
          measurement: num(e.measurement),
        });
        return;
      }
      case 'HATCH': {
        const loops: HatchLoop[] = [];
        for (const path of (e.boundaryPaths as Record<string, unknown>[]) ?? []) {
          const flags = num(path.boundaryPathTypeFlag);
          if (Array.isArray(path.vertices)) {
            loops.push({
              kind: 'poly',
              flags,
              closed: path.isClosed !== false,
              pts: (path.vertices as { x: number; y: number; bulge?: number }[]).map((p) => ({ x: flip ? -p.x : p.x, y: p.y, b: flip ? -num(p.bulge) : num(p.bulge) })),
            });
          } else if (Array.isArray(path.edges)) {
            const edges: HatchEdge[] = [];
            for (const ed of path.edges as Record<string, unknown>[]) {
              const type = num(ed.type);
              if (type === 1) edges.push({ t: 'line', a: fx(ed.start as P3), b: fx(ed.end as P3) });
              else if (type === 2) {
                let s = num(ed.startAngle);
                let en = num(ed.endAngle);
                let ccw = ed.isCCW !== false;
                if (flip) {
                  [s, en] = [Math.PI - s, Math.PI - en];
                  ccw = !ccw;
                }
                edges.push({ t: 'arc', c: fx(ed.center as P3), r: num(ed.radius), start: s, end: en, ccw });
              } else if (type === 3) {
                const major = v(ed.end as P3);
                edges.push({ t: 'ellipse', c: fx(ed.center as P3), major: flip ? { x: -major.x, y: major.y } : major, ratio: num(ed.lengthOfMinorAxis, 1), start: num(ed.startAngle), end: num(ed.endAngle), ccw: flip ? ed.isCCW === false : ed.isCCW !== false });
              } else if (type === 4) {
                const cps = (ed.controlPoints as (P3 & { weight?: number })[]) ?? [];
                edges.push({ t: 'spline', degree: num(ed.degree, 3), knots: (ed.knots as number[]) ?? [], ctrl: cps.map(fx), weights: cps.some((c) => c.weight !== undefined && c.weight !== 1) ? cps.map((c) => num(c.weight, 1)) : undefined });
              }
            }
            loops.push({ kind: 'edges', flags, edges });
          }
        }
        if (!loops.length) return void drop('hatch');
        const solid = num(e.solidFill) === 1;
        out.push({
          ...base,
          type: 'hatch',
          loops,
          solid,
          pattern: str(e.patternName, solid ? 'SOLID' : 'ANSI31'),
          angle: num(e.patternAngle),
          scale: num(e.patternScale, 1) || 1,
          lines: ((e.definitionLines as Record<string, unknown>[]) ?? []).map((l) => ({
            angle: flip ? Math.PI - num(l.angle) : num(l.angle),
            base: fx(l.base as P3),
            offset: flip ? { x: -v(l.offset as P3).x, y: v(l.offset as P3).y } : v(l.offset as P3),
            dashes: (l.dashLengths as number[]) ?? [],
          })),
          style: num(e.hatchStyle),
          patternType: num(e.patternType, 1),
          double: false,
        });
        return;
      }
      case 'SOLID':
      case 'TRACE': {
        const c3 = fx(e.corner3 as P3);
        const c4 = e.corner4 ? fx(e.corner4 as P3) : c3;
        out.push({ ...base, type: 'solid', pts: [fx(e.corner1 as P3), fx(e.corner2 as P3), c3, c4] });
        return;
      }
      case '3DFACE': {
        const c3 = v(e.corner3 as P3);
        out.push({ ...base, type: 'face', pts: [v(e.corner1 as P3), v(e.corner2 as P3), c3, e.corner4 ? v(e.corner4 as P3) : c3], invisible: num(e.flag) & 15 });
        return;
      }
      case 'LEADER': {
        const pts = ((e.vertices as P3[]) ?? []).map(v);
        if (pts.length < 2) return;
        out.push({ ...base, type: 'leader', pts, arrow: e.isArrowheadEnabled !== false, style: str(e.styleName, d.header.dimstyle) || d.header.dimstyle, spline: !!e.isSpline });
        return;
      }
      case 'XLINE':
      case 'RAY':
        out.push({ ...base, type: e.type === 'RAY' ? 'ray' : 'xline', p: v(e.firstPoint as P3), dir: v(e.unitDirection as P3) });
        return;
      case 'MULTILEADER':
        explodeMLeader(e, base, out);
        return;
      case 'MLINE':
        explodeMLine(e, base, out);
        return;
      case 'VIEWPORT':
        return;
      case 'ATTRIB':
        // Also listed on their INSERT, where they're read.
        return;
      default:
        drop(DROPPED_NAMES[e.type] ?? e.type.toLowerCase());
    }
  };

  const explodeMLeader = (e: Record<string, unknown>, base: Omit<EntityBase, 'id'> & { id: number }, out: Entity[]) => {
    for (const sec of (e.leaderSections as Record<string, unknown>[]) ?? []) {
      const last = v(sec.lastLeaderLinePoint as P3);
      const dog = v(sec.doglegVector as P3);
      const dl = num(sec.doglegLength, num(e.doglegLength));
      for (const line of (sec.leaderLines as Record<string, unknown>[]) ?? []) {
        const pts = [...((line.vertices as P3[]) ?? []).map(v), last];
        if (e.doglegEnabled !== false && dl) pts.push({ x: last.x + dog.x * dl, y: last.y + dog.y * dl });
        if (pts.length >= 2) out.push({ ...base, id: newId(), type: 'leader', pts, arrow: true, style: d.header.dimstyle, spline: num(e.leaderLineType) === 2 });
      }
    }
    if (e.hasMText && str(e.textContent)) {
      const dir = v(e.textDirection as P3);
      out.push({
        ...base,
        id: newId(),
        type: 'mtext',
        p: v((e.textAnchor ?? e.contentBasePosition) as P3),
        h: num(e.textHeight, 2.5) || 2.5,
        width: num(e.textWidth),
        rot: Math.atan2(dir.y, dir.x || 1),
        attach: num(e.textAttachmentPoint, 1) || 1,
        text: str(e.textContent),
        style: styleByHandle.get(str(e.textStyleId)) ?? 'Standard',
        spacing: num(e.textLineSpacingFactor, 1) || 1,
      });
    }
  };

  const explodeMLine = (e: Record<string, unknown>, base: Omit<EntityBase, 'id'> & { id: number }, out: Entity[]) => {
    const verts = (e.vertices as Record<string, unknown>[]) ?? [];
    const n = num(e.numberOfLines);
    const closed = (num(e.flags) & 2) !== 0 && false;
    for (let i = 0; i < n; i++) {
      const pts: PlineVertex[] = verts.map((vx) => {
        const p = v(vx.vertex as P3);
        const m = v(vx.miterDirection as P3);
        const off = num(((vx.lines as Record<string, unknown>[])?.[i]?.segmentParams as number[])?.[0]);
        return { x: p.x + m.x * off, y: p.y + m.y * off, b: 0 };
      });
      if (pts.length >= 2) out.push({ ...base, id: newId(), type: 'pline', pts, closed, width: 0 });
    }
  };

  const model: Entity[] = [];
  for (const e of db.entities ?? []) convert(e, model);
  d.entities = model;

  const blocks: Record<string, Block> = {};
  for (const r of db.tables.BLOCK_RECORD?.entries ?? []) {
    if (/^\*model_space$/i.test(r.name)) continue;
    const list: Entity[] = [];
    for (const e of r.entities ?? []) convert(e, list);
    if (/^\*paper_space$/i.test(r.name)) {
      d.paper = list;
      continue;
    }
    if (/^\*paper_space/i.test(r.name)) continue;
    if (num(r.flags) & 4) {
      drop('external reference');
      continue;
    }
    blocks[r.name] = { name: r.name, base: v(r.basePoint as P3), entities: list, flags: num(r.flags) & 3, description: str(r.description) };
  }
  d.blocks = blocks;

  // Blocks whose content is an AutoCAD table or the like are kept with what was readable.
  const active = db.tables.VPORT?.entries?.find((p) => /^\*active$/i.test(p.name));
  if (active && num(active.viewHeight) > 0) d.view = { center: v(active.center), height: num(active.viewHeight) };

  if (!d.layers.some((l) => l.name === '0')) d.layers.unshift({ name: '0', color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true });
  if (!d.layers.some((l) => l.name.toUpperCase() === d.header.clayer.toUpperCase())) d.header.clayer = '0';
  if (!d.dimStyles.some((s) => s.name.toUpperCase() === d.header.dimstyle.toUpperCase())) d.header.dimstyle = d.dimStyles[0].name;
  return { drawing: d, dropped, version };
}

const DROPPED_NAMES: Record<string, string> = {
  '3DSOLID': '3D solid',
  REGION: 'region',
  BODY: '3D body',
  ACAD_TABLE: 'table',
  TOLERANCE: 'tolerance',
  WIPEOUT: 'wipeout',
  IMAGE: 'image',
  OLE2FRAME: 'OLE object',
  OLEFRAME: 'OLE object',
  SHAPE: 'shape',
  PROXY: 'proxy object',
  SECTION: 'section',
  ARC_DIMENSION: 'arc length dimension',
};

interface TextLike {
  text?: string;
  startPoint?: P3;
  endPoint?: P3;
  textHeight?: number;
  rotation?: number;
  xScale?: number;
  obliqueAngle?: number;
  styleName?: string;
  halign?: number;
  valign?: number;
  extrusionDirection?: P3;
}

function textBase(t: TextLike, flip: boolean) {
  const fx = (p: P3 | undefined): Vec => (flip ? { x: -(p?.x ?? 0), y: p?.y ?? 0 } : v(p));
  const halign = Math.max(0, Math.min(5, num(t.halign))) as HAlign;
  const valign = Math.max(0, Math.min(3, num(t.valign))) as VAlign;
  const p = fx(t.startPoint);
  const aligned = halign !== 0 || valign !== 0;
  return {
    p,
    a: aligned ? fx(t.endPoint) : p,
    h: num(t.textHeight, 1) || 1,
    rot: flip ? Math.PI - num(t.rotation) : num(t.rotation),
    style: str(t.styleName, 'Standard') || 'Standard',
    wf: num(t.xScale, 1) || 1,
    oblique: num(t.obliqueAngle),
    halign,
    valign,
  };
}

function lwRaw(x: unknown): number {
  const n = num(x, LW_BYBLOCK);
  return n === -1 || n === -2 || n === -3 || LINEWEIGHTS.includes(n) ? n : LW_BYBLOCK;
}
