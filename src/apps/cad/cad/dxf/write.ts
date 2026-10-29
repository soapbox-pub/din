/**
 * Writes a drawing as an AutoCAD 2004 DXF (AC1018): the oldest DXF that
 * keeps true colors, and one every CAD program, laser cutter and CNC tool
 * that takes DXF still reads.
 *
 * It holds what the DWG writer writes: the tables, blocks, entities, the
 * named objects dictionary and the two layouts, with handles and owners as
 * AutoCAD writes them so it audits clean. Text other than ASCII is written
 * as \U+XXXX, so the file is plain ASCII in any code page.
 */
import {
  BYLAYER,
  CONTINUOUS,
  LW_BYLAYER,
  TRUE_COLOR,
  type Drawing,
  type Entity,
  type Hatch,
  type Text,
  type Vec,
} from '../model';
import { nearestAci } from '../aci';
import { prepare, type WriteOptions } from '../prepare';

const RAD = 180 / Math.PI;
const TAU = Math.PI * 2;

interface Common {
  layer: string;
  color: number;
  linetype: string;
  lineweight: number;
  ltscale: number;
  hidden?: boolean;
}
const upper = (s: string) => s.toUpperCase();

/** A double as DXF spells it. */
function real(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  const s = String(n);
  if (s.includes('e')) return n.toExponential().replace('e', 'E');
  return s.includes('.') ? s : `${s}.0`;
}

/** ASCII only: other characters become \U+XXXX; line breaks can't appear in a value. */
function text(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) out += ' ';
    else if (c < 32) continue;
    else if (c < 128) out += s[i];
    else out += `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

export function writeDxf(d: Drawing, opts: WriteOptions): Uint8Array {
  const { layers, linetypes, styles, dimstyles, blocks, model, paper, view } = prepare(d, opts);
  const hd = d.header;
  const ext = opts.extents;
  const metric = hd.measurement === 1;

  // ---- Handles ---------------------------------------------------------------------------
  let next = 1;
  const alloc = () => next++;
  // The tables and root dictionary get the handles AutoCAD gives them, which some readers count on.
  const H = {
    blockTbl: alloc(),
    layerTbl: alloc(),
    styleTbl: alloc(),
    unused4: alloc(),
    ltypeTbl: alloc(),
    viewTbl: alloc(),
    ucsTbl: alloc(),
    vportTbl: alloc(),
    appidTbl: alloc(),
    dimstyleTbl: alloc(),
    // DWG's VX table, which DXF doesn't have.
    vxTbl: alloc(),
    root: alloc(),
    groupDict: alloc(),
    layoutDict: alloc(),
    mlineDict: alloc(),
    mlineStandard: alloc(),
    plotSettingsDict: alloc(),
    plotStyleDict: alloc(),
    placeholder: alloc(),
    layoutModel: alloc(),
    layoutPaper: alloc(),
    vportActive: alloc(),
    appidAcad: alloc(),
  };
  // *Model_Space's block record is 1F in AutoCAD's files, and LibreDWG assumes it.
  const MODEL_SPACE = 0x1f;
  next = MODEL_SPACE + 1;
  const layerH = new Map(layers.map((l) => [upper(l.name), alloc()]));
  const ltypeH = new Map(linetypes.map((l) => [upper(l.name), alloc()]));
  const styleH = new Map(styles.map((s) => [upper(s.name), alloc()]));
  const dimstyleH = new Map(dimstyles.map((s) => [upper(s.name), alloc()]));

  interface Rec {
    name: string;
    handle: number;
    begin: number;
    end: number;
    layout: number;
    base: Vec;
    entities: Entity[];
    flags: number;
    description: string;
  }
  const recs: Rec[] = [];
  const recByName = new Map<string, Rec>();
  const addRec = (name: string, b: Pick<Rec, 'base' | 'entities' | 'flags' | 'description'>, layout = 0, handle = alloc()) => {
    const r: Rec = { name, handle, begin: alloc(), end: alloc(), layout, ...b };
    recs.push(r);
    recByName.set(upper(name), r);
    return r;
  };
  const msRec = addRec('*Model_Space', { base: { x: 0, y: 0 }, entities: model, flags: 0, description: '' }, H.layoutModel, MODEL_SPACE);
  const psRec = addRec('*Paper_Space', { base: { x: 0, y: 0 }, entities: paper, flags: 0, description: '' }, H.layoutPaper);
  for (const b of Object.values(blocks)) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue;
    addRec(b.name, { base: b.base, entities: b.entities, flags: b.flags | (b.entities.some((e) => e.type === 'attdef') ? 2 : 0), description: b.description });
  }

  const lt = (name: string) => linetypes.find((l) => upper(l.name) === upper(name))?.name ?? CONTINUOUS;
  const la = (name: string) => (layerH.has(upper(name)) ? name : '0');
  const st = (name: string) => styles.find((s) => upper(s.name) === upper(name))?.name ?? styles[0].name;
  const ds = (name: string) => dimstyles.find((s) => upper(s.name) === upper(name))?.name ?? dimstyles[0].name;
  const blk = (name: string) => recByName.get(upper(name));

  // ---- Output ----------------------------------------------------------------------------
  const out: string[] = [];
  const g = (code: number, value: string) => out.push(String(code).padStart(3), value);
  const s = (code: number, v: string) => g(code, text(v));
  const r = (code: number, v: number) => out.push(String(code).padStart(3), real(v));
  const i = (code: number, v: number) => out.push(String(code).padStart(3), String(Math.round(v)));
  const hx = (code: number, h: number) => out.push(String(code).padStart(3), h.toString(16).toUpperCase());
  const p2 = (code: number, p: Vec) => {
    r(code, p.x);
    r(code + 10, p.y);
  };
  const p3 = (code: number, p: Vec, z = 0) => {
    p2(code, p);
    r(code + 20, z);
  };
  const reactors = (...owners: number[]) => {
    g(102, '{ACAD_REACTORS');
    for (const o of owners) hx(330, o);
    g(102, '}');
  };
  /** Colour as DXF has it: an ACI index, plus a true color from AutoCAD 2004 on. */
  const color = (c: number, always = false) => {
    if (c >= TRUE_COLOR) {
      i(62, nearestAci(c & 0xffffff));
      i(420, c & 0xffffff);
    } else if (always || c !== BYLAYER) i(62, c);
  };

  // ---- Header ----------------------------------------------------------------------------
  const ds0 = dimstyles.find((x) => upper(x.name) === upper(hd.dimstyle)) ?? dimstyles[0];
  g(0, 'SECTION');
  g(2, 'HEADER');
  const v = (name: string, code: number, val: string | number) => {
    g(9, name);
    if (typeof val === 'string') s(code, val);
    else if (REAL(code)) r(code, val);
    else i(code, val);
  };
  const vp = (name: string, p: Vec, z?: number) => {
    g(9, name);
    if (z === undefined) p2(10, p);
    else p3(10, p, z);
  };
  v('$ACADVER', 1, 'AC1018');
  v('$ACADMAINTVER', 70, 0);
  v('$DWGCODEPAGE', 3, 'ANSI_1252');
  vp('$INSBASE', { x: 0, y: 0 }, 0);
  vp('$EXTMIN', ext ? ext.min : { x: 1e20, y: 1e20 }, ext ? 0 : 1e20);
  vp('$EXTMAX', ext ? ext.max : { x: -1e20, y: -1e20 }, ext ? 0 : -1e20);
  vp('$LIMMIN', hd.limmin);
  vp('$LIMMAX', hd.limmax);
  v('$ORTHOMODE', 70, 0);
  v('$REGENMODE', 70, 1);
  v('$FILLMODE', 70, hd.fillmode ? 1 : 0);
  v('$QTEXTMODE', 70, 0);
  v('$MIRRTEXT', 70, 0);
  v('$LTSCALE', 40, hd.ltscale || 1);
  v('$ATTMODE', 70, 1);
  v('$TEXTSIZE', 40, hd.textsize || 0.2);
  v('$TRACEWID', 40, 0.05);
  v('$TEXTSTYLE', 7, st(hd.textstyle));
  v('$CLAYER', 8, la(hd.clayer));
  v('$CELTYPE', 6, 'ByLayer');
  v('$CECOLOR', 62, BYLAYER);
  v('$CELTSCALE', 40, hd.celtscale || 1);
  v('$DIMSCALE', 40, ds0.dimscale);
  v('$DIMASZ', 40, ds0.dimasz);
  v('$DIMEXO', 40, ds0.dimexo);
  v('$DIMDLI', 40, metric ? 3.75 : 0.38);
  v('$DIMEXE', 40, ds0.dimexe);
  v('$DIMRND', 40, ds0.dimrnd);
  v('$DIMDLE', 40, ds0.dimdle);
  v('$DIMTIH', 70, ds0.dimtih ? 1 : 0);
  v('$DIMTOH', 70, ds0.dimtoh ? 1 : 0);
  v('$DIMSE1', 70, ds0.dimse1 ? 1 : 0);
  v('$DIMSE2', 70, ds0.dimse2 ? 1 : 0);
  v('$DIMTAD', 70, ds0.dimtad);
  v('$DIMZIN', 70, ds0.dimzin);
  v('$DIMTXT', 40, ds0.dimtxt);
  v('$DIMCEN', 40, ds0.dimcen);
  v('$DIMTSZ', 40, ds0.dimtsz);
  v('$DIMLFAC', 40, ds0.dimlfac);
  v('$DIMGAP', 40, ds0.dimgap);
  v('$DIMTOFL', 70, ds0.dimtofl ? 1 : 0);
  v('$DIMTIX', 70, ds0.dimtix ? 1 : 0);
  v('$DIMSOXD', 70, ds0.dimsoxd ? 1 : 0);
  v('$DIMCLRD', 70, aci(ds0.dimclrd));
  v('$DIMCLRE', 70, aci(ds0.dimclre));
  v('$DIMCLRT', 70, aci(ds0.dimclrt));
  v('$DIMADEC', 70, ds0.dimadec);
  v('$DIMDEC', 70, ds0.dimdec);
  v('$DIMLUNIT', 70, ds0.dimlunit);
  v('$DIMDSEP', 70, ds0.dimdsep);
  v('$DIMJUST', 70, ds0.dimjust);
  v('$DIMSD1', 70, ds0.dimsd1 ? 1 : 0);
  v('$DIMSD2', 70, ds0.dimsd2 ? 1 : 0);
  v('$DIMATFIT', 70, ds0.dimatfit);
  v('$DIMTXSTY', 7, st(ds0.dimtxsty));
  v('$DIMLWD', 70, ds0.dimlwd);
  v('$DIMLWE', 70, ds0.dimlwe);
  v('$DIMSTYLE', 2, ds0.name);
  v('$LUNITS', 70, hd.lunits);
  v('$LUPREC', 70, hd.luprec);
  v('$AUNITS', 70, hd.aunits);
  v('$AUPREC', 70, hd.auprec);
  v('$ANGBASE', 50, hd.angbase * RAD);
  v('$ANGDIR', 70, hd.angdir ? 1 : 0);
  v('$PDMODE', 70, hd.pdmode);
  v('$PDSIZE', 40, hd.pdsize);
  v('$FILLETRAD', 40, hd.filletrad);
  v('$CHAMFERA', 40, hd.chamfera);
  v('$CHAMFERB', 40, hd.chamferb);
  v('$TDCREATE', 40, hd.tdcreate);
  v('$TDUPDATE', 40, opts.now);
  v('$PSLTSCALE', 70, 1);
  v('$TILEMODE', 70, 1);
  v('$CELWEIGHT', 370, LW_BYLAYER);
  v('$ENDCAPS', 280, 0);
  v('$JOINSTYLE', 280, 0);
  v('$LWDISPLAY', 290, hd.lwdisplay ? 1 : 0);
  v('$INSUNITS', 70, hd.insunits);
  v('$EXTNAMES', 290, 1);
  v('$MEASUREMENT', 70, hd.measurement);
  const seedAt = out.length;
  v('$HANDSEED', 5, '0');
  g(0, 'ENDSEC');

  // ---- Classes -----------------------------------------------------------------------------
  g(0, 'SECTION');
  g(2, 'CLASSES');
  for (const c of [
    ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 1],
    ['ACDBPLACEHOLDER', 'AcDbPlaceHolder', 1],
    ['LAYOUT', 'AcDbLayout', 2],
  ] as const) {
    g(0, 'CLASS');
    g(1, c[0]);
    g(2, c[1]);
    g(3, 'ObjectDBX Classes');
    i(90, 0);
    i(91, c[2]);
    i(280, 0);
    i(281, 0);
  }
  g(0, 'ENDSEC');

  // ---- Tables --------------------------------------------------------------------------------
  g(0, 'SECTION');
  g(2, 'TABLES');
  const table = (name: string, handle: number, count: number, body: () => void, dimstyle = false) => {
    g(0, 'TABLE');
    g(2, name);
    hx(5, handle);
    hx(330, 0);
    g(100, 'AcDbSymbolTable');
    i(70, count);
    if (dimstyle) {
      g(100, 'AcDbDimStyleTable');
      i(71, dimstyles.length);
      for (const h of dimstyleH.values()) hx(340, h);
    }
    body();
    g(0, 'ENDTAB');
  };
  /** A table entry's start; block records have no flags (their BLOCK has them). */
  const entry = (type: string, handle: number, owner: number, sub: string, name: string, flags: number | null = 0, handleCode = 5) => {
    g(0, type);
    hx(handleCode, handle);
    hx(330, owner);
    g(100, 'AcDbSymbolTableRecord');
    g(100, sub);
    s(2, name);
    if (flags !== null) i(70, flags);
  };

  table('VPORT', H.vportTbl, 1, () => {
    entry('VPORT', H.vportActive, H.vportTbl, 'AcDbViewportTableRecord', '*Active');
    const grid = metric ? 10 : 0.5;
    p2(10, { x: 0, y: 0 });
    p2(11, { x: 1, y: 1 });
    p2(12, view.center);
    p2(13, { x: 0, y: 0 });
    p2(14, { x: grid, y: grid });
    p2(15, { x: grid, y: grid });
    p3(16, { x: 0, y: 0 }, 1);
    p3(17, { x: 0, y: 0 }, 0);
    r(40, view.height);
    r(41, 1.6);
    r(42, 50);
    r(43, 0);
    r(44, 0);
    r(50, 0);
    r(51, 0);
    i(71, 0);
    i(72, 1000);
    i(73, 1);
    i(74, 3);
    i(75, 0);
    i(76, 0);
    i(77, 0);
    i(78, 0);
    i(281, 0);
    i(65, 1);
    p3(110, { x: 0, y: 0 }, 0);
    p3(111, { x: 1, y: 0 }, 0);
    p3(112, { x: 0, y: 1 }, 0);
    i(79, 0);
    r(146, 0);
  });

  table('LTYPE', H.ltypeTbl, linetypes.length, () => {
    for (const l of linetypes) {
      entry('LTYPE', ltypeH.get(upper(l.name))!, H.ltypeTbl, 'AcDbLinetypeTableRecord', l.name);
      s(3, l.description);
      i(72, 65);
      i(73, l.pattern.length);
      r(40, l.pattern.reduce((a, x) => a + Math.abs(x), 0));
      for (const dash of l.pattern) {
        r(49, dash);
        i(74, 0);
      }
    }
  });

  table('LAYER', H.layerTbl, layers.length, () => {
    for (const l of layers) {
      entry('LAYER', layerH.get(upper(l.name))!, H.layerTbl, 'AcDbLayerTableRecord', l.name, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      const c = l.color >= TRUE_COLOR ? l.color : Math.max(1, Math.min(255, l.color || 7));
      const index = c >= TRUE_COLOR ? nearestAci(c & 0xffffff) : c;
      i(62, l.on ? index : -index);
      if (c >= TRUE_COLOR) i(420, c & 0xffffff);
      s(6, lt(l.linetype));
      i(290, l.plot ? 1 : 0);
      i(370, l.lineweight);
      hx(390, H.placeholder);
    }
  });

  table('STYLE', H.styleTbl, styles.length, () => {
    for (const ts of styles) {
      entry('STYLE', styleH.get(upper(ts.name))!, H.styleTbl, 'AcDbTextStyleTableRecord', ts.name);
      r(40, ts.height);
      r(41, ts.width || 1);
      r(50, ts.oblique * RAD);
      i(71, 0);
      r(42, ts.height || 0.2);
      s(3, ts.font);
      s(4, ts.bigfont);
    }
  });

  table('VIEW', H.viewTbl, 0, () => {});
  table('UCS', H.ucsTbl, 0, () => {});

  table('APPID', H.appidTbl, 1, () => {
    entry('APPID', H.appidAcad, H.appidTbl, 'AcDbRegAppTableRecord', 'ACAD');
  });

  table(
    'DIMSTYLE',
    H.dimstyleTbl,
    dimstyles.length,
    () => {
      for (const x of dimstyles) {
        entry('DIMSTYLE', dimstyleH.get(upper(x.name))!, H.dimstyleTbl, 'AcDbDimStyleTableRecord', x.name, 0, 105);
        s(3, x.dimpost);
        r(40, x.dimscale);
        r(41, x.dimasz);
        r(42, x.dimexo);
        r(43, metric ? 3.75 : 0.38);
        r(44, x.dimexe);
        r(45, x.dimrnd);
        r(46, x.dimdle);
        r(140, x.dimtxt);
        r(141, x.dimcen);
        r(142, x.dimtsz);
        r(144, x.dimlfac);
        r(147, x.dimgap);
        i(73, x.dimtih ? 1 : 0);
        i(74, x.dimtoh ? 1 : 0);
        i(75, x.dimse1 ? 1 : 0);
        i(76, x.dimse2 ? 1 : 0);
        i(77, x.dimtad);
        i(78, x.dimzin);
        i(172, x.dimtofl ? 1 : 0);
        i(174, x.dimtix ? 1 : 0);
        i(175, x.dimsoxd ? 1 : 0);
        i(176, aci(x.dimclrd));
        i(177, aci(x.dimclre));
        i(178, aci(x.dimclrt));
        i(179, x.dimadec);
        i(271, x.dimdec);
        i(272, x.dimdec);
        i(277, x.dimlunit);
        i(278, x.dimdsep);
        i(280, x.dimjust);
        i(281, x.dimsd1 ? 1 : 0);
        i(282, x.dimsd2 ? 1 : 0);
        i(289, x.dimatfit);
        hx(340, styleH.get(upper(st(x.dimtxsty)))!);
        const arrow = x.dimblk ? blk(x.dimblk) : undefined;
        if (arrow) hx(342, arrow.handle);
        i(371, x.dimlwd);
        i(372, x.dimlwe);
      }
    },
    true,
  );

  table('BLOCK_RECORD', H.blockTbl, recs.length, () => {
    for (const b of recs) {
      entry('BLOCK_RECORD', b.handle, H.blockTbl, 'AcDbBlockTableRecord', b.name, null);
      hx(340, b.layout);
      i(70, b === msRec || b === psRec ? 0 : hd.insunits);
      i(280, 1);
      i(281, 0);
    }
  });
  g(0, 'ENDSEC');

  // ---- Entities --------------------------------------------------------------------------------

  const common = (type: string, handle: number, owner: number, e: Common, sub: string, inPaper: boolean) => {
    g(0, type);
    hx(5, handle);
    hx(330, owner);
    g(100, 'AcDbEntity');
    if (inPaper) i(67, 1);
    s(8, la(e.layer));
    const ltn = e.linetype || 'ByLayer';
    if (upper(ltn) !== 'BYLAYER') s(6, /^byblock$/i.test(ltn) ? 'ByBlock' : lt(ltn));
    color(e.color);
    if (e.lineweight !== LW_BYLAYER) i(370, e.lineweight);
    if ((e.ltscale || 1) !== 1) r(48, e.ltscale);
    if (e.hidden) i(60, 1);
    if (sub) g(100, sub);
  };

  const textBody = (t: Omit<Text, 'type' | 'id'>, value: string) => {
    p3(10, t.p);
    r(40, t.h);
    s(1, value);
    if (t.rot) r(50, t.rot * RAD);
    if (t.wf !== 1) r(41, t.wf || 1);
    if (t.oblique) r(51, t.oblique * RAD);
    s(7, st(t.style));
    if (t.halign) i(72, t.halign);
    if (t.halign || t.valign) p3(11, t.a);
  };

  const hatchBody = (e: Hatch) => {
    p3(10, { x: 0, y: 0 }, 0);
    p3(210, { x: 0, y: 0 }, 1);
    s(2, e.solid ? 'SOLID' : e.pattern);
    i(70, e.solid ? 1 : 0);
    i(71, 0);
    i(91, e.loops.length);
    let derived = false;
    for (const loop of e.loops) {
      if (loop.kind === 'poly') {
        const flags = (loop.flags | 2) & ~0x80;
        if (flags & 4) derived = true;
        i(92, flags);
        const bulges = loop.pts.some((p) => p.b !== 0);
        i(72, bulges ? 1 : 0);
        i(73, loop.closed ? 1 : 0);
        i(93, loop.pts.length);
        for (const p of loop.pts) {
          p2(10, p);
          if (bulges) r(42, p.b);
        }
      } else {
        const flags = loop.flags & ~2 & ~0x80;
        if (flags & 4) derived = true;
        i(92, flags);
        i(93, loop.edges.length);
        for (const ed of loop.edges) {
          if (ed.t === 'line') {
            i(72, 1);
            p2(10, ed.a);
            p2(11, ed.b);
          } else if (ed.t === 'arc') {
            i(72, 2);
            p2(10, ed.c);
            r(40, ed.r);
            r(50, ed.start * RAD);
            r(51, ed.end * RAD);
            i(73, ed.ccw ? 1 : 0);
          } else if (ed.t === 'ellipse') {
            i(72, 3);
            p2(10, ed.c);
            p2(11, ed.major);
            r(40, ed.ratio);
            r(50, ed.start * RAD);
            r(51, ed.end * RAD);
            i(73, ed.ccw ? 1 : 0);
          } else {
            i(72, 4);
            const rational = !!ed.weights?.length;
            i(94, ed.degree);
            i(73, rational ? 1 : 0);
            i(74, 0);
            i(95, ed.knots.length);
            i(96, ed.ctrl.length);
            for (const k of ed.knots) r(40, k);
            ed.ctrl.forEach((p, j) => {
              p2(10, p);
              if (rational) r(42, ed.weights![j] ?? 1);
            });
          }
        }
      }
      i(97, 0);
    }
    i(75, e.style);
    i(76, e.solid ? 1 : e.patternType);
    if (!e.solid) {
      r(52, e.angle * RAD);
      r(41, e.scale || 1);
      i(77, e.double ? 1 : 0);
      i(78, e.lines.length);
      for (const l of e.lines) {
        r(53, l.angle * RAD);
        r(43, l.base.x);
        r(44, l.base.y);
        r(45, l.offset.x);
        r(46, l.offset.y);
        i(79, l.dashes.length);
        for (const dash of l.dashes) r(49, dash);
      }
    }
    if (derived) r(47, 1);
    i(98, 0);
  };

  const DIM_TYPE = { linear: 0, aligned: 1, angular: 2, diameter: 3, radius: 4, angular3: 5, ordinate: 6 } as const;

  const entity = (e: Entity, owner: Rec) => {
    const h = alloc();
    const inPaper = owner === psRec;
    const ownerH = owner.handle;
    const begin = (type: string, sub: string) => common(type, h, ownerH, e, sub, inPaper);
    switch (e.type) {
      case 'line':
        begin('LINE', 'AcDbLine');
        p3(10, e.a);
        p3(11, e.b);
        return;
      case 'circle':
        begin('CIRCLE', 'AcDbCircle');
        p3(10, e.c);
        r(40, e.r);
        return;
      case 'arc':
        begin('ARC', 'AcDbCircle');
        p3(10, e.c);
        r(40, e.r);
        g(100, 'AcDbArc');
        r(50, e.start * RAD);
        r(51, e.end * RAD);
        return;
      case 'ellipse': {
        begin('ELLIPSE', 'AcDbEllipse');
        // The major axis has to be the longer one: swap them if it isn't, which turns the parameters a quarter.
        const swap = e.ratio > 1;
        const whole = Math.abs(e.end - e.start - TAU) < 1e-6;
        p3(10, e.c);
        p3(11, swap ? { x: -e.major.y * e.ratio, y: e.major.x * e.ratio } : e.major);
        p3(210, { x: 0, y: 0 }, 1);
        r(40, swap ? 1 / e.ratio : e.ratio);
        const quarter = (t: number) => (((t - Math.PI / 2) % TAU) + TAU) % TAU;
        r(41, swap && !whole ? quarter(e.start) : e.start);
        r(42, swap && !whole ? quarter(e.end) || TAU : e.end);
        return;
      }
      case 'pline': {
        begin('LWPOLYLINE', 'AcDbPolyline');
        i(90, e.pts.length);
        i(70, e.closed ? 1 : 0);
        if (e.width) r(43, e.width);
        const widths = e.pts.some((p) => (p.sw ?? 0) !== 0 || (p.ew ?? 0) !== 0);
        for (const p of e.pts) {
          p2(10, p);
          if (widths) {
            r(40, p.sw ?? 0);
            r(41, p.ew ?? 0);
          }
          if (p.b) r(42, p.b);
        }
        return;
      }
      case 'spline': {
        begin('SPLINE', 'AcDbSpline');
        const rational = !!e.weights?.length && e.weights.some((w) => w !== 1);
        p3(210, { x: 0, y: 0 }, 1);
        i(70, 8 | (e.closed ? 1 : 0) | (rational ? 4 : 0));
        i(71, e.degree);
        i(72, e.knots.length);
        i(73, e.ctrl.length);
        i(74, 0);
        r(42, 1e-10);
        r(43, 1e-10);
        for (const k of e.knots) r(40, k);
        if (rational) for (let j = 0; j < e.ctrl.length; j++) r(41, e.weights![j] ?? 1);
        for (const p of e.ctrl) p3(10, p);
        return;
      }
      case 'point':
        begin('POINT', 'AcDbPoint');
        p3(10, e.p);
        return;
      case 'text':
        begin('TEXT', 'AcDbText');
        textBody(e, e.text);
        g(100, 'AcDbText');
        if (e.valign) i(73, e.valign);
        return;
      case 'attdef':
        begin('ATTDEF', 'AcDbText');
        textBody(e, e.text);
        g(100, 'AcDbAttributeDefinition');
        s(3, e.prompt);
        s(2, e.tag);
        i(70, e.flags);
        if (e.valign) i(74, e.valign);
        return;
      case 'mtext': {
        begin('MTEXT', 'AcDbMText');
        p3(10, e.p);
        r(40, e.h);
        r(41, e.width);
        i(71, e.attach || 1);
        i(72, 1);
        const body = text(e.text.replace(/\r?\n/g, '\\P'));
        // Long text is split into 250-character chunks, the last one under code 1.
        let at = 0;
        while (body.length - at > 250) {
          let end = at + 250;
          // Don't split a \U+XXXX escape.
          const cut = body.lastIndexOf('\\U+', end);
          if (cut > end - 7 && cut >= at) end = cut;
          g(3, body.slice(at, end));
          at = end;
        }
        g(1, body.slice(at));
        s(7, st(e.style));
        p3(11, { x: Math.cos(e.rot), y: Math.sin(e.rot) });
        i(73, 1);
        r(44, e.spacing || 1);
        return;
      }
      case 'insert': {
        const target = blk(e.block);
        if (!target) return;
        begin('INSERT', 'AcDbBlockReference');
        if (e.attribs.length) i(66, 1);
        s(2, target.name);
        p3(10, e.p);
        if (e.sx !== 1) r(41, e.sx);
        if (e.sy !== 1) r(42, e.sy);
        if (e.rot) r(50, e.rot * RAD);
        if ((e.cols ?? 1) > 1 || (e.rows ?? 1) > 1) {
          i(70, e.cols ?? 1);
          i(71, e.rows ?? 1);
          r(44, e.dc ?? 0);
          r(45, e.dr ?? 0);
        }
        if (e.attribs.length) {
          for (const a of e.attribs) {
            common('ATTRIB', alloc(), h, a, 'AcDbText', inPaper);
            textBody(a, a.text);
            g(100, 'AcDbAttribute');
            s(2, a.tag);
            i(70, a.flags);
            if (a.valign) i(74, a.valign);
          }
          common('SEQEND', alloc(), h, e, '', inPaper);
        }
        return;
      }
      case 'dim': {
        begin('DIMENSION', 'AcDbDimension');
        const target = e.block ? blk(e.block) : undefined;
        if (target) s(2, target.name);
        p3(10, e.p10);
        p3(11, e.text);
        i(70, DIM_TYPE[e.kind] | (target ? 32 : 0) | (e.kind === 'ordinate' && e.ordinateX ? 64 : 0) | (e.textMoved ? 128 : 0));
        i(71, 5);
        i(72, 1);
        r(41, 1);
        if (e.measurement) r(42, e.measurement);
        if (e.override) s(1, e.override);
        s(3, ds(e.style));
        switch (e.kind) {
          case 'linear':
          case 'aligned':
            g(100, 'AcDbAlignedDimension');
            p3(13, e.p13);
            p3(14, e.p14);
            if (e.kind === 'linear') {
              r(50, e.rot * RAD);
              g(100, 'AcDbRotatedDimension');
            }
            break;
          case 'angular':
            g(100, 'AcDb2LineAngularDimension');
            p3(13, e.p13);
            p3(14, e.p14);
            p3(15, e.p15);
            p3(16, e.p16 ?? e.text);
            break;
          case 'angular3':
            g(100, 'AcDb3PointAngularDimension');
            p3(13, e.p13);
            p3(14, e.p14);
            p3(15, e.p15);
            break;
          case 'radius':
          case 'diameter':
            g(100, e.kind === 'radius' ? 'AcDbRadialDimension' : 'AcDbDiametricDimension');
            p3(15, e.p15);
            r(40, 0);
            break;
          case 'ordinate':
            g(100, 'AcDbOrdinateDimension');
            p3(13, e.p13);
            p3(14, e.p14);
            break;
        }
        return;
      }
      case 'hatch':
        begin('HATCH', 'AcDbHatch');
        hatchBody(e);
        return;
      case 'solid':
        begin('SOLID', 'AcDbTrace');
        e.pts.forEach((p, j) => p3(10 + j, p));
        return;
      case 'face':
        begin('3DFACE', 'AcDbFace');
        e.pts.forEach((p, j) => p3(10 + j, p));
        if (e.invisible) i(70, e.invisible);
        return;
      case 'leader':
        begin('LEADER', 'AcDbLeader');
        s(3, ds(e.style));
        i(71, e.arrow ? 1 : 0);
        i(72, e.spline ? 1 : 0);
        i(73, 3);
        i(74, 0);
        i(75, 0);
        r(40, 0);
        r(41, 0);
        i(76, e.pts.length);
        for (const p of e.pts) p3(10, p);
        return;
      case 'xline':
      case 'ray':
        begin(e.type === 'ray' ? 'RAY' : 'XLINE', e.type === 'ray' ? 'AcDbRay' : 'AcDbXline');
        p3(10, e.p);
        p3(11, e.dir);
        return;
    }
  };

  // ---- Blocks: the two spaces' are empty here; their entities go in ENTITIES. ---------------
  const layer0 = { layer: '0', color: BYLAYER, linetype: 'ByLayer', lineweight: LW_BYLAYER, ltscale: 1 };
  g(0, 'SECTION');
  g(2, 'BLOCKS');
  for (const b of recs) {
    const inPaper = b === psRec;
    common('BLOCK', b.begin, b.handle, layer0, 'AcDbBlockBegin', inPaper);
    s(2, b.name);
    i(70, b.flags);
    p3(10, b.base);
    s(3, b.name);
    g(1, '');
    if (b.description) s(4, b.description);
    if (b !== msRec && b !== psRec) for (const e of b.entities) entity(e, b);
    common('ENDBLK', b.end, b.handle, layer0, 'AcDbBlockEnd', inPaper);
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const e of msRec.entities) entity(e, msRec);
  for (const e of psRec.entities) entity(e, psRec);
  g(0, 'ENDSEC');

  // ---- Objects -----------------------------------------------------------------------------------
  g(0, 'SECTION');
  g(2, 'OBJECTS');
  const dictionary = (handle: number, owner: number, entries: [string, number][], type = 'DICTIONARY', defaultEntry?: number) => {
    g(0, type);
    hx(5, handle);
    if (owner) reactors(owner);
    hx(330, owner);
    g(100, 'AcDbDictionary');
    i(281, 1);
    for (const [name, h] of entries) {
      s(3, name);
      hx(350, h);
    }
    if (defaultEntry !== undefined) {
      g(100, 'AcDbDictionaryWithDefault');
      hx(340, defaultEntry);
    }
  };
  dictionary(H.root, 0, [
    ['ACAD_GROUP', H.groupDict],
    ['ACAD_LAYOUT', H.layoutDict],
    ['ACAD_MLINESTYLE', H.mlineDict],
    ['ACAD_PLOTSETTINGS', H.plotSettingsDict],
    ['ACAD_PLOTSTYLENAME', H.plotStyleDict],
  ]);
  dictionary(H.groupDict, H.root, []);
  dictionary(H.layoutDict, H.root, [
    ['Layout1', H.layoutPaper],
    ['Model', H.layoutModel],
  ]);
  dictionary(H.mlineDict, H.root, [['Standard', H.mlineStandard]]);
  dictionary(H.plotSettingsDict, H.root, []);
  dictionary(H.plotStyleDict, H.root, [['Normal', H.placeholder]], 'ACDBDICTIONARYWDFLT', H.placeholder);

  g(0, 'ACDBPLACEHOLDER');
  hx(5, H.placeholder);
  reactors(H.plotStyleDict);
  hx(330, H.plotStyleDict);

  g(0, 'MLINESTYLE');
  hx(5, H.mlineStandard);
  reactors(H.mlineDict);
  hx(330, H.mlineDict);
  g(100, 'AcDbMlineStyle');
  g(2, 'Standard');
  i(70, 0);
  g(3, '');
  i(62, BYLAYER);
  r(51, 90);
  r(52, 90);
  i(71, 2);
  for (const off of [0.5, -0.5]) {
    r(49, off);
    i(62, BYLAYER);
    g(6, 'BYLAYER');
  }

  const layout = (handle: number, name: string, tab: number, rec: Rec, isModel: boolean) => {
    g(0, 'LAYOUT');
    hx(5, handle);
    reactors(H.layoutDict);
    hx(330, H.layoutDict);
    g(100, 'AcDbPlotSettings');
    g(1, '');
    g(2, 'none_device');
    g(4, isModel ? (metric ? 'ISO_A4_(297.00_x_210.00_MM)' : 'Letter_(8.50_x_11.00_Inches)') : '');
    g(6, '');
    const margin = isModel ? 6.35 : 0;
    for (const c of [40, 41, 42, 43]) r(c, margin);
    r(44, isModel ? (metric ? 297 : 215.9) : 0);
    r(45, isModel ? (metric ? 210 : 279.4) : 0);
    for (const c of [46, 47, 48, 49, 140, 141]) r(c, 0);
    r(142, 1);
    r(143, 1);
    i(70, isModel ? 0x6b0 : 0x2b0);
    i(72, metric ? 1 : 0);
    i(73, 0);
    i(74, isModel ? 0 : 5);
    g(7, '');
    i(75, isModel ? 0 : 16);
    r(147, 1);
    r(148, 0);
    r(149, 0);
    g(100, 'AcDbLayout');
    s(1, name);
    i(70, 1);
    i(71, tab);
    p2(10, hd.limmin);
    p2(11, hd.limmax);
    p3(12, { x: 0, y: 0 });
    const e = isModel ? ext : null;
    p3(14, e ? e.min : { x: 1e20, y: 1e20 }, e ? 0 : 1e20);
    p3(15, e ? e.max : { x: -1e20, y: -1e20 }, e ? 0 : -1e20);
    r(146, 0);
    p3(13, { x: 0, y: 0 });
    p3(16, { x: 1, y: 0 });
    p3(17, { x: 0, y: 1 });
    i(76, 0);
    hx(330, rec.handle);
  };
  layout(H.layoutModel, 'Model', 0, msRec, true);
  layout(H.layoutPaper, 'Layout1', 1, psRec, false);
  g(0, 'ENDSEC');
  g(0, 'EOF');

  out[seedAt + 3] = next.toString(16).toUpperCase();
  return new TextEncoder().encode(out.join('\r\n') + '\r\n');
}

/** Group codes whose values are doubles. */
function REAL(code: number): boolean {
  return (code >= 10 && code < 60) || (code >= 110 && code < 150) || (code >= 210 && code < 240) || (code >= 460 && code < 470) || (code >= 1010 && code < 1060);
}

const aci = (c: number) => (c >= TRUE_COLOR ? nearestAci(c & 0xffffff) : c);
