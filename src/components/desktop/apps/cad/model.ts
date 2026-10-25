/**
 * The drawing CAD works on: AutoCAD's database, cut down to what a 2D
 * drafting app needs. Entities are plain immutable objects, so undo keeps
 * whole drawings and caches can key on an entity's identity.
 *
 * Coordinates are world units in the XY plane; angles are radians,
 * counterclockwise from +X, as in DXF.
 */

export interface Vec {
  x: number;
  y: number;
}

/** ACI 1-255, BYLAYER (256) or BYBLOCK (0); true colors are TRUE_COLOR | 0xRRGGBB. */
export type Color = number;
export const BYBLOCK = 0;
export const BYLAYER = 256;
export const TRUE_COLOR = 0x1000000;

/** Lineweights are hundredths of a millimetre, or one of these. */
export const LW_BYLAYER = -1;
export const LW_BYBLOCK = -2;
export const LW_DEFAULT = -3;
export const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export interface EntityBase {
  /** Unique within the drawing for its lifetime; new on every copy. */
  id: number;
  layer: string;
  color: Color;
  /** "ByLayer", "ByBlock", or a linetype's name. */
  linetype: string;
  lineweight: number;
  ltscale: number;
  /** Invisible (DXF 60). */
  hidden?: boolean;
}

export interface Line extends EntityBase {
  type: 'line';
  a: Vec;
  b: Vec;
}

export interface Circle extends EntityBase {
  type: 'circle';
  c: Vec;
  r: number;
}

export interface Arc extends EntityBase {
  type: 'arc';
  c: Vec;
  r: number;
  /** Counterclockwise from start to end. */
  start: number;
  end: number;
}

export interface Ellipse extends EntityBase {
  type: 'ellipse';
  c: Vec;
  /** The major axis's endpoint, relative to the center. */
  major: Vec;
  /** Minor over major. */
  ratio: number;
  /** Parameters (0 to 2π for a whole ellipse). */
  start: number;
  end: number;
}

export interface PlineVertex {
  x: number;
  y: number;
  /** tan(θ/4) of the arc to the next vertex; 0 is straight. */
  b: number;
  sw?: number;
  ew?: number;
}

export interface Pline extends EntityBase {
  type: 'pline';
  pts: PlineVertex[];
  closed: boolean;
  /** Constant width. */
  width: number;
}

export interface Spline extends EntityBase {
  type: 'spline';
  degree: number;
  knots: number[];
  ctrl: Vec[];
  weights?: number[];
  fit?: Vec[];
  closed: boolean;
}

export interface Point extends EntityBase {
  type: 'point';
  p: Vec;
}

/** Horizontal: left, center, right, aligned, middle, fit. Vertical: baseline, bottom, middle, top. */
export type HAlign = 0 | 1 | 2 | 3 | 4 | 5;
export type VAlign = 0 | 1 | 2 | 3;

export interface Text extends EntityBase {
  type: 'text';
  /** The insertion point (DXF 10). */
  p: Vec;
  /** The alignment point (DXF 11), used unless left/baseline. */
  a: Vec;
  h: number;
  rot: number;
  text: string;
  style: string;
  wf: number;
  oblique: number;
  halign: HAlign;
  valign: VAlign;
}

export interface AttDef extends Omit<Text, 'type'> {
  type: 'attdef';
  tag: string;
  prompt: string;
  /** 1 invisible, 2 constant, 4 verify, 8 preset. */
  flags: number;
}

export interface Attrib extends Omit<Text, 'type' | 'id'> {
  tag: string;
  flags: number;
}

/** MTEXT attachment: 1-9, top left to bottom right. */
export interface MText extends EntityBase {
  type: 'mtext';
  p: Vec;
  h: number;
  /** Wrapping width; 0 doesn't wrap. */
  width: number;
  rot: number;
  attach: number;
  text: string;
  style: string;
  spacing: number;
}

export interface Insert extends EntityBase {
  type: 'insert';
  block: string;
  p: Vec;
  sx: number;
  sy: number;
  rot: number;
  attribs: Attrib[];
  cols?: number;
  rows?: number;
  dc?: number;
  dr?: number;
}

export type DimKind = 'linear' | 'aligned' | 'angular' | 'angular3' | 'radius' | 'diameter' | 'ordinate';

export interface Dimension extends EntityBase {
  type: 'dim';
  kind: DimKind;
  style: string;
  /**
   * Definition points, DXF style: 10 (on the dimension line / arc), 13 and
   * 14 (what's measured), 15 (center or vertex), 16 (angular arc point).
   */
  p10: Vec;
  p13: Vec;
  p14: Vec;
  p15: Vec;
  p16?: Vec;
  /** The text's middle (DXF 11). */
  text: Vec;
  /** Linear dimension rotation. */
  rot: number;
  /** "" measures, "<>" stands for the measurement, anything else replaces it. */
  override: string;
  /** Text was moved by hand. */
  textMoved: boolean;
  /** Ordinate: measures X rather than Y. */
  ordinateX?: boolean;
  /** The anonymous block AutoCAD drew it into, kept until the dimension changes. */
  block?: string;
  measurement?: number;
}

export type HatchEdge =
  | { t: 'line'; a: Vec; b: Vec }
  | { t: 'arc'; c: Vec; r: number; start: number; end: number; ccw: boolean }
  | { t: 'ellipse'; c: Vec; major: Vec; ratio: number; start: number; end: number; ccw: boolean }
  | { t: 'spline'; degree: number; knots: number[]; ctrl: Vec[]; weights?: number[] };

export type HatchLoop =
  | { kind: 'poly'; pts: PlineVertex[]; closed: boolean; flags: number }
  | { kind: 'edges'; edges: HatchEdge[]; flags: number };

export interface PatternLine {
  angle: number;
  base: Vec;
  offset: Vec;
  dashes: number[];
}

export interface Hatch extends EntityBase {
  type: 'hatch';
  loops: HatchLoop[];
  solid: boolean;
  pattern: string;
  angle: number;
  scale: number;
  /** In drawing units, already turned and scaled. */
  lines: PatternLine[];
  /** 0 normal (odd parity), 1 outer, 2 ignore. */
  style: number;
  /** 0 user-defined, 1 predefined, 2 custom. */
  patternType: number;
  double: boolean;
}

export interface Solid extends EntityBase {
  type: 'solid';
  /** In DXF order: the 3rd and 4th corners are swapped from drawing order. */
  pts: [Vec, Vec, Vec, Vec];
}

export interface Face extends EntityBase {
  type: 'face';
  pts: [Vec, Vec, Vec, Vec];
  /** Invisible edges, bit per edge. */
  invisible: number;
}

export interface Leader extends EntityBase {
  type: 'leader';
  pts: Vec[];
  arrow: boolean;
  style: string;
  spline: boolean;
}

export interface XLine extends EntityBase {
  type: 'xline' | 'ray';
  p: Vec;
  dir: Vec;
}

export type Entity =
  | Line
  | Circle
  | Arc
  | Ellipse
  | Pline
  | Spline
  | Point
  | Text
  | AttDef
  | MText
  | Insert
  | Dimension
  | Hatch
  | Solid
  | Face
  | Leader
  | XLine;

export type EntityType = Entity['type'];

export interface Layer {
  name: string;
  color: Color;
  linetype: string;
  lineweight: number;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
  description?: string;
}

export interface Linetype {
  name: string;
  description: string;
  /** Dashes (positive), gaps (negative) and dots (0), in drawing units at scale 1. */
  pattern: number[];
}

export interface TextStyle {
  name: string;
  font: string;
  bigfont: string;
  /** 0 asks each time. */
  height: number;
  width: number;
  oblique: number;
}

export interface DimStyle {
  name: string;
  dimscale: number;
  dimasz: number;
  dimtxt: number;
  dimexo: number;
  dimexe: number;
  dimgap: number;
  dimdec: number;
  dimadec: number;
  dimtad: number;
  dimtih: boolean;
  dimtoh: boolean;
  dimclrd: Color;
  dimclre: Color;
  dimclrt: Color;
  dimtxsty: string;
  dimlfac: number;
  dimcen: number;
  dimtsz: number;
  dimdle: number;
  dimpost: string;
  dimzin: number;
  dimlunit: number;
  dimdsep: number;
  dimrnd: number;
  dimse1: boolean;
  dimse2: boolean;
  dimsd1: boolean;
  dimsd2: boolean;
  dimtofl: boolean;
  dimjust: number;
  dimatfit: number;
  dimtix: boolean;
  dimsoxd: boolean;
  dimlwd: number;
  dimlwe: number;
  /** Arrowhead block names; "" is the closed filled arrow. */
  dimblk: string;
}

export interface Block {
  name: string;
  base: Vec;
  entities: Entity[];
  /** 1 anonymous, 2 has attributes, 4 xref. */
  flags: number;
  description: string;
}

export interface Header {
  insunits: number;
  lunits: number;
  luprec: number;
  aunits: number;
  auprec: number;
  /** 0 imperial, 1 metric. */
  measurement: number;
  ltscale: number;
  celtscale: number;
  textsize: number;
  textstyle: string;
  dimstyle: string;
  clayer: string;
  pdmode: number;
  pdsize: number;
  filletrad: number;
  chamfera: number;
  chamferb: number;
  limmin: Vec;
  limmax: Vec;
  angbase: number;
  /** Angles measured clockwise. */
  angdir: boolean;
  /** Julian dates, as DWG stores them. */
  tdcreate: number;
  fillmode: boolean;
  lwdisplay: boolean;
  /** Code page of the file's 8-bit text, as an ANSI code page number. */
  codepage: number;
}

export interface Drawing {
  header: Header;
  layers: Layer[];
  linetypes: Linetype[];
  textStyles: TextStyle[];
  dimStyles: DimStyle[];
  blocks: Record<string, Block>;
  /** Model space. */
  entities: Entity[];
  /** Paper space, kept so layouts survive a save. */
  paper: Entity[];
  /** Where the drawing was last looked at. */
  view: { center: Vec; height: number } | null;
}

let nextId = 1;
export const newId = () => nextId++;

export function withId<T extends Entity>(e: T): T {
  return { ...e, id: newId() };
}

export const CONTINUOUS = 'Continuous';

export const DEFAULT_DIMSTYLE: DimStyle = {
  name: 'Standard',
  dimscale: 1,
  dimasz: 0.18,
  dimtxt: 0.18,
  dimexo: 0.0625,
  dimexe: 0.18,
  dimgap: 0.09,
  dimdec: 4,
  dimadec: 0,
  dimtad: 0,
  dimtih: true,
  dimtoh: true,
  dimclrd: BYBLOCK,
  dimclre: BYBLOCK,
  dimclrt: BYBLOCK,
  dimtxsty: 'Standard',
  dimlfac: 1,
  dimcen: 0.09,
  dimtsz: 0,
  dimdle: 0,
  dimpost: '',
  dimzin: 0,
  dimlunit: 2,
  dimdsep: 46,
  dimrnd: 0,
  dimse1: false,
  dimse2: false,
  dimsd1: false,
  dimsd2: false,
  dimtofl: false,
  dimjust: 0,
  dimatfit: 3,
  dimtix: false,
  dimsoxd: false,
  dimlwd: LW_BYBLOCK,
  dimlwe: LW_BYBLOCK,
  dimblk: '',
};

/** ISO-25, the metric template's dimension style. */
export const ISO_DIMSTYLE: DimStyle = {
  ...DEFAULT_DIMSTYLE,
  name: 'ISO-25',
  dimasz: 2.5,
  dimtxt: 2.5,
  dimexo: 0.625,
  dimexe: 1.25,
  dimgap: 0.625,
  dimdec: 2,
  dimcen: 2.5,
  dimtad: 1,
  dimtih: false,
  dimtoh: false,
  dimtofl: true,
  dimzin: 8,
  dimdsep: 44,
  dimatfit: 3,
};

export const STANDARD_LINETYPES: Linetype[] = [
  { name: 'ByBlock', description: '', pattern: [] },
  { name: 'ByLayer', description: '', pattern: [] },
  { name: CONTINUOUS, description: 'Solid line', pattern: [] },
];

/** A few of acad.lin's linetypes, for the Linetype list (scaled for inches). */
export const EXTRA_LINETYPES: Linetype[] = [
  { name: 'DASHED', description: 'Dashed __ __ __ __ __ __ __ __ __ __ __ __ __ _', pattern: [0.5, -0.25] },
  { name: 'HIDDEN', description: 'Hidden __ __ __ __ __ __ __ __ __ __ __ __ __ __', pattern: [0.25, -0.125] },
  { name: 'CENTER', description: 'Center ____ _ ____ _ ____ _ ____ _ ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] },
  { name: 'PHANTOM', description: 'Phantom ______  __  __  ______  __  __  ______', pattern: [1.25, -0.25, 0.25, -0.25, 0.25, -0.25] },
  { name: 'DOT', description: 'Dot . . . . . . . . . . . . . . . . . . . . . . . .', pattern: [0, -0.25] },
  { name: 'DASHDOT', description: 'Dash dot __ . __ . __ . __ . __ . __ . __ . __', pattern: [0.5, -0.25, 0, -0.25] },
  { name: 'BORDER', description: 'Border __ __ . __ __ . __ __ . __ __ . __ __ .', pattern: [0.5, -0.25, 0.5, -0.25, 0, -0.25] },
  { name: 'DIVIDE', description: 'Divide ____ . . ____ . . ____ . . ____ . . ____', pattern: [0.5, -0.25, 0, -0.25, 0, -0.25] },
];

export function defaultLayer(name = '0'): Layer {
  return { name, color: 7, linetype: CONTINUOUS, lineweight: LW_DEFAULT, on: true, frozen: false, locked: false, plot: true };
}

/** Julian date (days, with the time as a fraction) for a JS time. */
export function julian(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

export function newDrawing(metric: boolean): Drawing {
  const dim = metric ? ISO_DIMSTYLE : DEFAULT_DIMSTYLE;
  return {
    header: {
      insunits: metric ? 4 : 1,
      lunits: 2,
      luprec: 4,
      aunits: 0,
      auprec: 0,
      measurement: metric ? 1 : 0,
      ltscale: metric ? 25.4 : 1,
      celtscale: 1,
      textsize: metric ? 2.5 : 0.2,
      textstyle: 'Standard',
      dimstyle: dim.name,
      clayer: '0',
      pdmode: 0,
      pdsize: 0,
      filletrad: 0,
      chamfera: 0,
      chamferb: 0,
      limmin: { x: 0, y: 0 },
      limmax: metric ? { x: 420, y: 297 } : { x: 12, y: 9 },
      angbase: 0,
      angdir: false,
      tdcreate: julian(Date.now()),
      fillmode: true,
      lwdisplay: false,
      codepage: 1252,
    },
    layers: [defaultLayer('0')],
    linetypes: [...STANDARD_LINETYPES],
    textStyles: [{ name: 'Standard', font: metric ? 'isocp.shx' : 'txt', bigfont: '', height: 0, width: 1, oblique: 0 }],
    dimStyles: metric ? [{ ...DEFAULT_DIMSTYLE }, ISO_DIMSTYLE] : [{ ...DEFAULT_DIMSTYLE }],
    blocks: {},
    entities: [],
    paper: [],
    view: null,
  };
}

export function findLayer(d: Drawing, name: string): Layer | undefined {
  const key = name.toUpperCase();
  return d.layers.find((l) => l.name.toUpperCase() === key);
}

export function findLinetype(d: Drawing, name: string): Linetype | undefined {
  const key = name.toUpperCase();
  return d.linetypes.find((l) => l.name.toUpperCase() === key);
}

export function findTextStyle(d: Drawing, name: string): TextStyle | undefined {
  const key = name.toUpperCase();
  return d.textStyles.find((s) => s.name.toUpperCase() === key) ?? d.textStyles[0];
}

export function findDimStyle(d: Drawing, name: string): DimStyle {
  const key = name.toUpperCase();
  return d.dimStyles.find((s) => s.name.toUpperCase() === key) ?? d.dimStyles[0] ?? DEFAULT_DIMSTYLE;
}

export function findBlock(d: Drawing, name: string): Block | undefined {
  return d.blocks[name] ?? d.blocks[Object.keys(d.blocks).find((k) => k.toUpperCase() === name.toUpperCase()) ?? ''];
}

export const ENTITY_NAMES: Record<EntityType, string> = {
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  pline: 'Polyline',
  spline: 'Spline',
  point: 'Point',
  text: 'Text',
  attdef: 'Attribute Definition',
  mtext: 'MText',
  insert: 'Block Reference',
  dim: 'Dimension',
  hatch: 'Hatch',
  solid: '2D Solid',
  face: '3D Face',
  leader: 'Leader',
  xline: 'Construction Line',
  ray: 'Ray',
};
