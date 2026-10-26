import { attr, kid, kids, parseXml } from '../ooxml';
import type { Geometry } from './model';

/**
 * Shape outlines. DrawingML describes every preset shape (and custom ones,
 * a:custGeom) with guide formulas over the shape's size and adjust values,
 * and a path of moveTo/lnTo/arcTo/cubicBezTo commands. This evaluates those
 * into SVG paths; the presets are written in the same formula language as
 * Office's presetShapeDefinitions, so they adjust and resize like Office's.
 */

export interface SubPath {
  d: string;
  /** How it's filled: 'norm', 'none', or a shade of the fill (the side of a cube). */
  fill: 'norm' | 'none' | 'darken' | 'darkenLess' | 'lighten' | 'lightenLess';
  stroke: boolean;
}

export interface ShapePath {
  paths: SubPath[];
  /** Where text goes, in px from the shape's top left. */
  text: { l: number; t: number; r: number; b: number };
}

type Vars = Map<string, number>;

const ANGLE = 60000;
const toRad = (a: number) => (a / ANGLE) * (Math.PI / 180);

function builtins(w: number, h: number): Vars {
  const ss = Math.min(w, h);
  const ls = Math.max(w, h);
  const v: [string, number][] = [
    ['w', w], ['h', h], ['l', 0], ['t', 0], ['r', w], ['b', h], ['hc', w / 2], ['vc', h / 2],
    ['ss', ss], ['ls', ls],
    ['cd2', 10800000], ['cd4', 5400000], ['cd8', 2700000], ['3cd4', 16200000], ['3cd8', 8100000], ['5cd8', 13500000], ['7cd8', 18900000],
  ];
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    v.push([`wd${d}`, w / d], [`hd${d}`, h / d], [`ssd${d}`, ss / d]);
  }
  return new Map(v);
}

function val(vars: Vars, token: string): number {
  const v = vars.get(token);
  if (v !== undefined) return v;
  const n = Number(token);
  return Number.isFinite(n) ? n : 0;
}

/** One guide formula, like "*\/ ss a 100000". */
export function evalFormula(fmla: string, vars: Vars): number {
  const [op, ...args] = fmla.trim().split(/\s+/);
  const [x, y, z] = args.map((a) => val(vars, a));
  switch (op) {
    case '*/': return z ? (x * y) / z : 0;
    case '+-': return x + y - z;
    case '+/': return z ? (x + y) / z : 0;
    case '?:': return x > 0 ? y : z;
    case 'abs': return Math.abs(x);
    case 'at2': return (Math.atan2(y, x) * 180 / Math.PI) * ANGLE;
    case 'cat2': return x * Math.cos(Math.atan2(z, y));
    case 'sat2': return x * Math.sin(Math.atan2(z, y));
    case 'cos': return x * Math.cos(toRad(y));
    case 'sin': return x * Math.sin(toRad(y));
    case 'tan': return x * Math.tan(toRad(y));
    case 'max': return Math.max(x, y);
    case 'min': return Math.min(x, y);
    case 'mod': return Math.sqrt(x * x + y * y + z * z);
    case 'pin': return y < x ? x : y > z ? z : y;
    case 'sqrt': return Math.sqrt(Math.max(0, x));
    case 'val': return x;
  }
  return 0;
}

/** Builds an SVG path from DrawingML commands, tracking the pen for arcTo. */
class PathBuilder {
  d: string[] = [];
  x = 0;
  y = 0;
  sx = 0;
  sy = 0;
  private f = (n: number) => (Math.round(n * 100) / 100).toString();
  moveTo(x: number, y: number) {
    this.d.push(`M${this.f(x)} ${this.f(y)}`);
    this.x = this.sx = x;
    this.y = this.sy = y;
  }
  lineTo(x: number, y: number) {
    this.d.push(`L${this.f(x)} ${this.f(y)}`);
    this.x = x;
    this.y = y;
  }
  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.d.push(`C${this.f(x1)} ${this.f(y1)} ${this.f(x2)} ${this.f(y2)} ${this.f(x)} ${this.f(y)}`);
    this.x = x;
    this.y = y;
  }
  quad(x1: number, y1: number, x: number, y: number) {
    this.d.push(`Q${this.f(x1)} ${this.f(y1)} ${this.f(x)} ${this.f(y)}`);
    this.x = x;
    this.y = y;
  }
  /** DrawingML's arcTo: the pen sits on the ellipse at stAng; sweep swAng. */
  arcTo(wr: number, hr: number, st: number, sw: number) {
    if (wr <= 0 || hr <= 0) return;
    const param = (a: number) => {
      const r = toRad(a);
      return Math.atan2(wr * Math.sin(r), hr * Math.cos(r));
    };
    const s = param(st);
    const cx = this.x - wr * Math.cos(s);
    const cy = this.y - hr * Math.sin(s);
    // An SVG arc can't start and end at the same point; full turns go in halves.
    const pieces = Math.abs(sw) >= 21600000 - 1 ? 2 : 1;
    for (let i = 1; i <= pieces; i++) {
      const e = param(st + (sw * i) / pieces);
      const ex = cx + wr * Math.cos(e);
      const ey = cy + hr * Math.sin(e);
      const part = Math.abs(sw / pieces) / ANGLE;
      this.d.push(`A${this.f(wr)} ${this.f(hr)} 0 ${part > 180 ? 1 : 0} ${sw > 0 ? 1 : 0} ${this.f(ex)} ${this.f(ey)}`);
      this.x = ex;
      this.y = ey;
    }
  }
  close() {
    this.d.push('Z');
    this.x = this.sx;
    this.y = this.sy;
  }
}

// ---- Presets ------------------------------------------------------------------------

interface PresetDef {
  av?: string;
  gd?: string;
  /** Subpaths separated by '|', each optionally starting with flags: '!s' no stroke, '!f' no fill, '~dark' etc. */
  path: string;
  text?: string;
  /** Path coordinate space, if the literals in `path` aren't in shape units. */
  space?: [number, number];
  /** Mirrored left to right. */
  mirror?: boolean;
}

const ROUND_RECT_PATH = 'M l x1 A x1 x1 cd2 cd4 L x2 t A x1 x1 3cd4 cd4 L r y2 A x1 x1 0 cd4 L x1 b A x1 x1 cd4 cd4 Z';
const ELLIPSE_PATH = 'M l vc A wd2 hd2 cd2 cd4 A wd2 hd2 3cd4 cd4 A wd2 hd2 0 cd4 A wd2 hd2 cd4 cd4 Z';
const ELLIPSE_GD = 'idx cos wd2 2700000; idy sin hd2 2700000; il +- hc 0 idx; ir +- hc idx 0; it +- vc 0 idy; ib +- vc idy 0';
const WEDGE_GD =
  'dxPos */ w adj1 100000; dyPos */ h adj2 100000; xPos +- hc dxPos 0; yPos +- vc dyPos 0; dx */ dxPos h w; dy */ dyPos 1 1; adx abs dx; ady abs dy; dq +- adx 0 ady; ' +
  'xg1 ?: dxPos 7 2; xg2 ?: dxPos 10 5; x1 */ w xg1 12; x2 */ w xg2 12; yg1 ?: dyPos 7 2; yg2 ?: dyPos 10 5; y1 */ h yg1 12; y2 */ h yg2 12; ' +
  't1 ?: dxPos l xPos; xl ?: dq l t1; t2 ?: dyPos x1 xPos; xt ?: dq t2 x1; t3 ?: dxPos xPos r; xr ?: dq r t3; t4 ?: dyPos xPos x1; xb ?: dq t4 x1; ' +
  't5 ?: dxPos y1 yPos; yl ?: dq y1 t5; t6 ?: dyPos t yPos; yt ?: dq t6 t; t7 ?: dxPos yPos y1; yr ?: dq y1 t7; t8 ?: dyPos yPos b; yb ?: dq t8 b';
const PENTAGON_GD =
  'swd2 */ wd2 105146 100000; shd2 */ hd2 110557 100000; svc */ vc 110557 100000; dx1 cos swd2 1080000; dx2 cos swd2 18360000; dy1 sin shd2 1080000; dy2 sin shd2 18360000; ' +
  'x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- svc 0 dy1; y2 +- svc 0 dy2';

const PRESETS: Record<string, PresetDef> = {
  rect: { path: 'M l t L r t L r b L l b Z' },
  roundRect: {
    av: 'adj 16667',
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 29289 100000; ir +- r 0 il; ib +- b 0 il',
    path: ROUND_RECT_PATH,
    text: 'il il ir ib',
  },
  snip1Rect: {
    av: 'adj 16667',
    gd: 'a pin 0 adj 50000; dx1 */ ss a 100000; x1 +- r 0 dx1; it */ dx1 1 2; ir +/ x1 r 2',
    path: 'M l t L x1 t L r dx1 L r b L l b Z',
    text: 'l it ir b',
  },
  snip2SameRect: {
    av: 'adj1 16667; adj2 0',
    gd: 'a1 pin 0 adj1 50000; a2 pin 0 adj2 50000; tx1 */ ss a1 100000; tx2 +- r 0 tx1; bx1 */ ss a2 100000; bx2 +- r 0 bx1; by1 +- b 0 bx1; d +- tx1 0 bx1; dx ?: d tx1 bx1; il */ dx 1 2; ir +- r 0 il; it */ tx1 1 2; ib +/ by1 b 2',
    path: 'M tx1 t L tx2 t L r tx1 L r by1 L bx2 b L bx1 b L l by1 L l tx1 Z',
    text: 'il it ir ib',
  },
  round1Rect: {
    av: 'adj 16667',
    gd: 'a pin 0 adj 50000; dx1 */ ss a 100000; x1 +- r 0 dx1; idx */ dx1 29289 100000; ir +- r 0 idx',
    path: 'M l t L x1 t A dx1 dx1 3cd4 cd4 L r b L l b Z',
    text: 'l t ir b',
  },
  round2SameRect: {
    av: 'adj1 16667; adj2 0',
    gd: 'a1 pin 0 adj1 50000; a2 pin 0 adj2 50000; tx1 */ ss a1 100000; tx2 +- r 0 tx1; bx1 */ ss a2 100000; bx2 +- r 0 bx1; by1 +- b 0 bx1; d +- tx1 0 bx1; tdx */ tx1 29289 100000; bdx */ bx1 29289 100000; il ?: d tdx bdx; ir +- r 0 il; ib +- b 0 bdx',
    path: 'M tx1 t L tx2 t A tx1 tx1 3cd4 cd4 L r by1 A bx1 bx1 0 cd4 L bx1 b A bx1 bx1 cd4 cd4 L l tx1 A tx1 tx1 cd2 cd4 Z',
    text: 'il tdx ir ib',
  },
  ellipse: { gd: ELLIPSE_GD, path: ELLIPSE_PATH, text: 'il it ir ib' },
  triangle: {
    av: 'adj 50000',
    gd: 'a pin 0 adj 100000; x1 */ w a 200000; x2 */ w a 100000; x3 +- x1 wd2 0',
    path: 'M l b L x2 t L r b Z',
    text: 'x1 vc x3 b',
  },
  rtTriangle: { gd: 'it */ h 7 12; ir */ w 7 12; ib */ h 11 12', path: 'M l t L r b L l b Z', text: 'wd12 it ir ib' },
  diamond: { gd: 'ir */ w 3 4; ib */ h 3 4', path: 'M l vc L hc t L r vc L hc b Z', text: 'wd4 hd4 ir ib' },
  parallelogram: {
    av: 'adj 25000',
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; x1 */ ss a 200000; x2 */ ss a 100000; x6 +- r 0 x2; x5 +- r 0 x1; il */ wd3 a maxAdj; it */ hd3 a maxAdj; ir +- r 0 il; ib +- b 0 it',
    path: 'M l b L x2 t L r t L x6 b Z',
    text: 'il it ir ib',
  },
  trapezoid: {
    av: 'adj 25000',
    gd: 'maxAdj */ 50000 w ss; a pin 0 adj maxAdj; x2 */ ss a 100000; x3 +- r 0 x2; il */ wd3 a maxAdj; it */ hd3 a maxAdj; ir +- r 0 il',
    path: 'M l b L x2 t L x3 t L r b Z',
    text: 'il it ir b',
  },
  pentagon: { gd: `${PENTAGON_GD}; it */ y1 dx2 dx1`, path: 'M x1 y1 L hc t L x4 y1 L x3 y2 L x2 y2 Z', text: 'x2 it x3 y2' },
  hexagon: {
    av: 'adj 25000',
    gd: 'maxAdj */ 50000 w ss; a pin 0 adj maxAdj; shd2 */ hd2 115470 100000; x1 */ ss a 100000; x2 +- r 0 x1; dy1 sin shd2 3600000; y1 +- vc 0 dy1; y2 +- vc dy1 0',
    path: 'M l vc L x1 y1 L x2 y1 L r vc L x2 y2 L x1 y2 Z',
    text: 'x1 y1 x2 y2',
  },
  octagon: {
    av: 'adj 29289',
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 1 2; ir +- r 0 il; ib +- b 0 il',
    path: 'M l x1 L x1 t L x2 t L r x1 L r y2 L x2 b L x1 b L l y2 Z',
    text: 'il il ir ib',
  },
  star4: {
    av: 'adj 12500',
    gd: 'a pin 0 adj 50000; iwd2 */ wd2 a 50000; ihd2 */ hd2 a 50000; sdx cos iwd2 2700000; sdy sin ihd2 2700000; sx1 +- hc 0 sdx; sx2 +- hc sdx 0; sy1 +- vc 0 sdy; sy2 +- vc sdy 0',
    path: 'M l vc L sx1 sy1 L hc t L sx2 sy1 L r vc L sx2 sy2 L hc b L sx1 sy2 Z',
    text: 'sx1 sy1 sx2 sy2',
  },
  star5: {
    av: 'adj 19098',
    gd:
      `a pin 0 adj 50000; ${PENTAGON_GD}; iwd2 */ swd2 a 50000; ihd2 */ shd2 a 50000; sdx1 cos iwd2 20520000; sdx2 cos iwd2 3240000; sdy1 sin ihd2 3240000; sdy2 sin ihd2 20520000; ` +
      'sx1 +- hc 0 sdx1; sx2 +- hc 0 sdx2; sx3 +- hc sdx2 0; sx4 +- hc sdx1 0; sy1 +- svc 0 sdy1; sy2 +- svc 0 sdy2; sy3 +- svc ihd2 0',
    path: 'M x1 y1 L sx2 sy1 L hc t L sx3 sy1 L x4 y1 L sx4 sy2 L x3 y2 L hc sy3 L x2 y2 L sx1 sy2 Z',
    text: 'sx1 sy1 sx4 sy3',
  },
  star6: {
    av: 'adj 28868',
    gd:
      'a pin 0 adj 50000; swd2 */ wd2 115470 100000; dx1 cos swd2 1800000; x1 +- hc 0 dx1; x2 +- hc dx1 0; y2 +- vc hd4 0; iwd2 */ swd2 a 50000; ihd2 */ hd2 a 50000; ' +
      'sdx2 */ iwd2 1 2; sx1 +- hc 0 iwd2; sx2 +- hc 0 sdx2; sx3 +- hc sdx2 0; sx4 +- hc iwd2 0; sdy1 sin ihd2 3600000; sy1 +- vc 0 sdy1; sy2 +- vc sdy1 0',
    path: 'M x1 hd4 L sx2 sy1 L hc t L sx3 sy1 L x2 hd4 L sx4 vc L x2 y2 L sx3 sy2 L hc b L sx2 sy2 L x1 y2 L sx1 vc Z',
    text: 'sx1 sy1 sx4 sy2',
  },
  plus: {
    av: 'adj 25000',
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; d +- w 0 h; il ?: d l x1; ir ?: d r x2; it ?: d x1 t; ib ?: d y2 b',
    path: 'M l x1 L x1 x1 L x1 t L x2 t L x2 x1 L r x1 L r y2 L x2 y2 L x2 b L x1 b L x1 y2 L l y2 Z',
    text: 'il it ir ib',
  },
  donut: {
    av: 'adj 25000',
    gd: `a pin 0 adj 50000; dr */ ss a 100000; iwd2 +- wd2 0 dr; ihd2 +- hd2 0 dr; ${ELLIPSE_GD}`,
    path: `${ELLIPSE_PATH} M dr vc A iwd2 ihd2 cd2 -5400000 A iwd2 ihd2 cd4 -5400000 A iwd2 ihd2 0 -5400000 A iwd2 ihd2 3cd4 -5400000 Z`,
    text: 'il it ir ib',
  },
  can: {
    av: 'adj 25000',
    gd: 'maxAdj */ 50000 h ss; a pin 0 adj maxAdj; y1 */ ss a 200000; y2 +- y1 y1 0; y3 +- b 0 y1',
    path:
      '!s M l y1 A wd2 y1 cd2 -10800000 L r y3 A wd2 y1 0 cd4 A wd2 y1 cd4 cd4 Z' +
      '|!s ~lighten M l y1 A wd2 y1 cd2 cd2 A wd2 y1 0 cd2 Z' +
      '|!f M r y1 A wd2 y1 0 cd2 A wd2 y1 cd2 cd2 L r y3 A wd2 y1 0 cd2 L l y1',
    text: 'l y2 r y3',
  },
  cube: {
    av: 'adj 25000',
    gd: 'a pin 0 adj 100000; y1 */ ss a 100000; y4 +- b 0 y1; x4 +- r 0 y1',
    path:
      '!s M l y1 L x4 y1 L x4 b L l b Z|!s ~darkenLess M x4 y1 L r t L r y4 L x4 b Z|!s ~lightenLess M l y1 L y1 t L r t L x4 y1 Z' +
      '|!f M l y1 L y1 t L r t L r y4 L x4 b L l b Z M l y1 L x4 y1 L r t M x4 y1 L x4 b',
    text: 'l y1 x4 b',
  },
  frame: {
    av: 'adj1 12500',
    gd: 'a1 pin 0 adj1 50000; x1 */ ss a1 100000; x4 +- r 0 x1; y4 +- b 0 x1',
    path: 'M l t L r t L r b L l b Z M x1 x1 L x1 y4 L x4 y4 L x4 x1 Z',
    text: 'x1 x1 x4 y4',
  },
  heart: {
    gd: 'dx1 */ w 49 48; dx2 */ w 10 48; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- t 0 hd3; il */ w 1 6; ir */ w 5 6; ib */ h 2 3',
    path: 'M hc hd4 C x3 y1 x4 hd4 hc b C x1 hd4 x2 y1 hc hd4 Z',
    text: 'il hd4 ir ib',
  },
  smileyFace: {
    av: 'adj 4653',
    gd:
      `a pin -4653 adj 4653; x1 */ w 4969 21699; x2 */ w 6215 21600; x3 */ w 13135 21600; x4 */ w 16640 21600; y1 */ h 7570 21600; y3 */ h 16515 21600; dy2 */ h a 100000; y2 +- y3 0 dy2; y4 +- y3 dy2 0; dy3 */ h a 50000; y5 +- y4 dy3 0; ${ELLIPSE_GD}; wR */ w 1323 21600; hR */ h 1323 21600`,
    path: `!s ${ELLIPSE_PATH}|~darkenLess M x2 y1 A wR hR cd2 21600000 Z M x3 y1 A wR hR cd2 21600000 Z|!f M x1 y2 Q hc y5 x4 y2|!f ${ELLIPSE_PATH}`,
    text: 'il it ir ib',
  },
  teardrop: {
    av: 'adj 100000',
    gd: `a pin 0 adj 200000; r2 sqrt 2; tw */ r2 wd2 1; th */ r2 hd2 1; sw */ tw a 100000; sh */ th a 100000; dx1 cos sw 2700000; dy1 sin sh 2700000; x1 +- hc dx1 0; y1 +- vc 0 dy1; x2 +/ hc x1 2; y2 +/ vc y1 2; ${ELLIPSE_GD}`,
    path: 'M l vc A wd2 hd2 cd2 cd4 Q x2 t x1 y1 Q r y2 r vc A wd2 hd2 0 cd4 A wd2 hd2 cd4 cd4 Z',
    text: 'il it ir ib',
  },
  plaque: {
    av: 'adj 16667',
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 70711 100000; ir +- r 0 il; ib +- b 0 il',
    path: 'M l x1 A x1 x1 cd4 -5400000 L x2 t A x1 x1 cd2 -5400000 L r y2 A x1 x1 3cd4 -5400000 L x1 b A x1 x1 0 -5400000 Z',
    text: 'il il ir ib',
  },
  bracketPair: {
    av: 'adj 16667',
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 29289 100000; ir +- r 0 il; ib +- b 0 il',
    path: `!s ${ROUND_RECT_PATH}|!f M x1 b A x1 x1 cd4 cd4 L l x1 A x1 x1 cd2 cd4 M x2 t A x1 x1 3cd4 cd4 L r y2 A x1 x1 0 cd4`,
    text: 'il il ir ib',
  },
  leftBracket: {
    av: 'adj 8333',
    gd: 'maxAdj */ 50000 h ss; a pin 0 adj maxAdj; y1 */ ss a 100000; y2 +- b 0 y1',
    path: '!s M r b A w y1 cd4 cd4 L l y1 A w y1 cd2 cd4 Z|!f M r b A w y1 cd4 cd4 L l y1 A w y1 cd2 cd4',
    text: 'l y1 r y2',
  },
  leftBrace: {
    av: 'adj1 8333; adj2 50000',
    gd: 'a2 pin 0 adj2 100000; q1 +- 100000 0 a2; q2 min q1 a2; q3 */ q2 1 2; maxAdj1 */ q3 h ss; a1 pin 0 adj1 maxAdj1; y1 */ ss a1 100000; y3 */ h a2 100000; y4 +- y3 y1 0',
    path:
      '!s M r b A wd2 y1 cd4 cd4 L hc y4 A wd2 y1 0 -5400000 A wd2 y1 cd4 -5400000 L hc y1 A wd2 y1 cd2 cd4 Z' +
      '|!f M r b A wd2 y1 cd4 cd4 L hc y4 A wd2 y1 0 -5400000 A wd2 y1 cd4 -5400000 L hc y1 A wd2 y1 cd2 cd4',
    text: 'l y1 r b',
  },
  rightArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx1 */ ss a2 100000; x1 +- r 0 dx1; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; dx2 */ y1 dx1 hd2; x2 +- x1 dx2 0',
    path: 'M l y1 L x1 y1 L x1 t L r vc L x1 b L x1 y2 L l y2 Z',
    text: 'l y1 x2 y2',
  },
  leftArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx2 */ ss a2 100000; x2 +- l dx2 0; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; dx1 */ y1 dx2 hd2; x1 +- x2 0 dx1',
    path: 'M l vc L x2 t L x2 y1 L r y1 L r y2 L x2 y2 L x2 b Z',
    text: 'x1 y1 r y2',
  },
  upArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 100000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dy2 */ ss a2 100000; y2 +- t dy2 0; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy1 */ x1 dy2 wd2; y1 +- y2 0 dy1',
    path: 'M l y2 L hc t L r y2 L x2 y2 L x2 b L x1 b L x1 y2 Z',
    text: 'x1 y1 x2 b',
  },
  downArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 100000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dy1 */ ss a2 100000; y1 +- b 0 dy1; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy2 */ x1 dy1 wd2; y2 +- y1 dy2 0',
    path: 'M x1 t L x2 t L x2 y1 L r y1 L hc b L l y1 L x1 y1 Z',
    text: 'x1 t x2 y2',
  },
  leftRightArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 50000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; x2 */ ss a2 100000; x3 +- r 0 x2; dy */ h a1 200000; y1 +- vc 0 dy; y2 +- vc dy 0; dx1 */ y1 x2 hd2; x1 +- x2 0 dx1; x4 +- x3 dx1 0',
    path: 'M l vc L x2 t L x2 y1 L x3 y1 L x3 t L r vc L x3 b L x3 y2 L x2 y2 L x2 b Z',
    text: 'x1 y1 x4 y2',
  },
  upDownArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 50000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; y2 */ ss a2 100000; y3 +- b 0 y2; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy1 */ x1 y2 wd2; y1 +- y2 0 dy1; y4 +- y3 dy1 0',
    path: 'M l y2 L hc t L r y2 L x2 y2 L x2 y3 L r y3 L hc b L l y3 L x1 y3 L x1 y2 Z',
    text: 'x1 y1 x2 y4',
  },
  notchedRightArrow: {
    av: 'adj1 50000; adj2 50000',
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx2 */ ss a2 100000; x2 +- r 0 dx2; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; x1 */ dy1 dx2 hd2; x3 +- r 0 x1',
    path: 'M l y1 L x2 y1 L x2 t L r vc L x2 b L x2 y2 L l y2 L x1 vc Z',
    text: 'x1 y1 x3 y2',
  },
  chevron: {
    av: 'adj 50000',
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; x1 */ ss a 100000; x2 +- r 0 x1; dx +- x2 0 x1; il ?: dx x1 l; ir ?: dx x2 r',
    path: 'M l t L x2 t L r vc L x2 b L l b L x1 vc Z',
    text: 'il t ir b',
  },
  homePlate: {
    av: 'adj 50000',
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; dx1 */ ss a 100000; x1 +- r 0 dx1; ir +/ x1 r 2',
    path: 'M l t L x1 t L r vc L x1 b L l b Z',
    text: 'l t ir b',
  },
  wedgeRectCallout: {
    av: 'adj1 -20833; adj2 62500',
    gd: WEDGE_GD,
    path: 'M l t L x1 t L xt yt L x2 t L r t L r y1 L xr yr L r y2 L r b L x2 b L xb yb L x1 b L l b L l y2 L xl yl L l y1 Z',
  },
  wedgeRoundRectCallout: {
    av: 'adj1 -20833; adj2 62500; adj3 16667',
    gd: `${WEDGE_GD}; u1 */ ss adj3 100000; u2 +- r 0 u1; v2 +- b 0 u1; il */ u1 29289 100000; ir +- r 0 il; ib +- b 0 il`,
    path: 'M l u1 A u1 u1 cd2 cd4 L x1 t L xt yt L x2 t L u2 t A u1 u1 3cd4 cd4 L r y1 L xr yr L r y2 L r v2 A u1 u1 0 cd4 L x2 b L xb yb L x1 b L u1 b A u1 u1 cd4 cd4 L l y2 L xl yl L l y1 Z',
    text: 'il il ir ib',
  },
  wedgeEllipseCallout: {
    av: 'adj1 -20833; adj2 62500',
    gd:
      'dxPos */ w adj1 100000; dyPos */ h adj2 100000; xPos +- hc dxPos 0; yPos +- vc dyPos 0; sdx */ dxPos h 1; sdy */ dyPos w 1; pang at2 sdx sdy; stAng +- pang 660000 0; enAng +- pang 0 660000; ' +
      `dx1 cos wd2 stAng; dy1 sin hd2 stAng; x1 +- hc dx1 0; y1 +- vc dy1 0; stAng1 at2 dx1 dy1; dx2 cos wd2 enAng; dy2 sin hd2 enAng; enAng1 at2 dx2 dy2; swAng1 +- enAng1 0 stAng1; swAng2 +- swAng1 21600000 0; swAng ?: swAng1 swAng1 swAng2; ${ELLIPSE_GD}`,
    path: 'M xPos yPos L x1 y1 A wd2 hd2 stAng1 swAng Z',
    text: 'il it ir ib',
  },
  flowChartProcess: { path: 'M l t L r t L r b L l b Z' },
  flowChartAlternateProcess: {
    gd: 'x2 +- r 0 ssd6; y2 +- b 0 ssd6; il */ ssd6 29289 100000; ir +- r 0 il; ib +- b 0 il',
    path: 'M l ssd6 A ssd6 ssd6 cd2 cd4 L x2 t A ssd6 ssd6 3cd4 cd4 L r y2 A ssd6 ssd6 0 cd4 L ssd6 b A ssd6 ssd6 cd4 cd4 Z',
    text: 'il il ir ib',
  },
  flowChartDecision: { gd: 'ir */ w 3 4; ib */ h 3 4', path: 'M l vc L hc t L r vc L hc b Z', text: 'wd4 hd4 ir ib' },
  flowChartTerminator: {
    gd: 'il */ w 1018 21600; ir */ w 20582 21600; it */ h 3163 21600; ib */ h 18437 21600',
    path: 'M 3475 0 L 18125 0 A 3475 10800 3cd4 cd2 L 3475 21600 A 3475 10800 cd4 cd2 Z',
    space: [21600, 21600],
    text: 'il it ir ib',
  },
  flowChartDocument: {
    gd: 'y2 */ h 17322 21600; y1 */ h 20172 21600',
    path: 'M 0 0 L 21600 0 L 21600 17322 C 10800 17322 10800 23922 0 20172 Z',
    space: [21600, 21600],
    text: 'l t r y2',
  },
  flowChartInputOutput: {
    gd: 'x3 */ w 2 5; x4 */ w 3 5; x5 */ w 4 5; x6 */ w 9 10',
    path: 'M 0 5 L 1 0 L 5 0 L 4 5 Z',
    space: [5, 5],
    text: 'wd5 t x5 b',
  },
  flowChartPredefinedProcess: {
    gd: 'x2 */ w 7 8',
    path: 'M 0 0 L 8 0 L 8 8 L 0 8 Z|!f M 1 0 L 1 8 M 7 0 L 7 8|!f M 0 0 L 8 0 L 8 8 L 0 8 Z',
    space: [8, 8],
    text: 'wd8 t x2 b',
  },
  flowChartConnector: { gd: ELLIPSE_GD, path: ELLIPSE_PATH, text: 'il it ir ib' },
  line: { path: '!f M l t L r b' },
  straightConnector1: { path: '!f M l t L r b' },
  bentConnector2: { path: '!f M l t L r t L r b' },
  bentConnector3: { av: 'adj1 50000', gd: 'x1 */ w adj1 100000', path: '!f M l t L x1 t L x1 b L r b' },
  curvedConnector3: {
    av: 'adj1 50000',
    gd: 'x2 */ w adj1 100000; x1 +/ l x2 2; x3 +/ r x2 2; y3 */ h 3 4',
    path: '!f M l t C x1 t x2 hd4 x2 vc C x2 y3 x3 b r b',
  },
  arc: {
    av: 'adj1 16200000; adj2 0',
    gd:
      'stAng pin 0 adj1 21599999; enAng pin 0 adj2 21599999; sw11 +- enAng 0 stAng; sw12 +- sw11 21600000 0; swAng ?: sw11 sw11 sw12; wt1 sin wd2 stAng; ht1 cos hd2 stAng; dx1 cat2 wd2 ht1 wt1; dy1 sat2 hd2 ht1 wt1; x1 +- hc dx1 0; y1 +- vc dy1 0',
    path: '!s M x1 y1 A wd2 hd2 stAng swAng L hc vc Z|!f M x1 y1 A wd2 hd2 stAng swAng',
  },
};
PRESETS.rightBracket = { ...PRESETS.leftBracket, mirror: true };
PRESETS.rightBrace = { ...PRESETS.leftBrace, mirror: true };
PRESETS.flowChartMagneticDisk = PRESETS.can;
PRESETS.bentConnector4 = PRESETS.bentConnector3;
PRESETS.bentConnector5 = PRESETS.bentConnector3;
PRESETS.curvedConnector2 = PRESETS.curvedConnector3;
PRESETS.curvedConnector4 = PRESETS.curvedConnector3;
PRESETS.straightConnector2 = PRESETS.straightConnector1;
PRESETS.flowChartOffpageConnector = { path: 'M 0 0 L 10 0 L 10 8 L 5 10 L 0 8 Z', space: [10, 10], gd: 'y1 */ h 4 5', text: 'l t r y1' };
PRESETS.flowChartManualInput = { path: 'M 0 1 L 5 0 L 5 5 L 0 5 Z', space: [5, 5], gd: 'y1 */ h 1 5', text: 'l y1 r b' };
PRESETS.flowChartPreparation = { path: 'M 0 5 L 2 0 L 8 0 L 10 5 L 8 10 L 2 10 Z', space: [10, 10], gd: 'x2 */ w 4 5', text: 'wd5 t x2 b' };


/** Regular polygons and many-pointed stars, made rather than written out. */
function generated(prst: string, w: number, h: number, adj: Record<string, number>): ShapePath | null {
  const poly = /^(heptagon|decagon|dodecagon)$/.exec(prst);
  const star = /^star(7|8|10|12|16|24|32)$/.exec(prst);
  if (!poly && !star) return null;
  const n = poly ? { heptagon: 7, decagon: 10, dodecagon: 12 }[poly[1]]! : Number(star![1]);
  const inner = star ? Math.max(0, Math.min(50000, adj.adj ?? (n >= 16 ? 37500 : n >= 10 ? 42533 : 38250))) / 50000 : 1;
  const pts: string[] = [];
  const count = star ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const k = star && i % 2 === 1 ? inner : 1;
    pts.push(`${i ? 'L' : 'M'}${(w / 2 + (w / 2) * k * Math.cos(a)).toFixed(2)} ${(h / 2 + (h / 2) * k * Math.sin(a)).toFixed(2)}`);
  }
  const ti = star ? inner * 0.7 : 0.8;
  return {
    paths: [{ d: `${pts.join(' ')} Z`, fill: 'norm', stroke: true }],
    text: { l: (w / 2) * (1 - ti), t: (h / 2) * (1 - ti), r: (w / 2) * (1 + ti), b: (h / 2) * (1 + ti) },
  };
}

function runPath(source: string, vars: Vars, scaleX: number, scaleY: number, pb: PathBuilder) {
  const tok = source.trim().split(/\s+/);
  let i = 0;
  const num = () => val(vars, tok[i++]);
  const px = () => num() * scaleX;
  const py = () => num() * scaleY;
  while (i < tok.length) {
    const c = tok[i++];
    if (c === 'M') pb.moveTo(px(), py());
    else if (c === 'L') pb.lineTo(px(), py());
    else if (c === 'C') {
      const a = [px(), py(), px(), py(), px(), py()] as const;
      pb.cubic(...a);
    } else if (c === 'Q') {
      const a = [px(), py(), px(), py()] as const;
      pb.quad(...a);
    } else if (c === 'A') {
      const wr = num() * scaleX;
      const hr = num() * scaleY;
      pb.arcTo(wr, hr, num(), num());
    } else if (c === 'Z') pb.close();
  }
}

function presetPath(prst: string, w: number, h: number, adjIn: Record<string, number>): ShapePath {
  const gen = generated(prst, w, h, adjIn);
  if (gen) return gen;
  const def = PRESETS[prst] ?? PRESETS.rect;
  const vars = builtins(w, h);
  for (const a of (def.av ?? '').split(';').filter((s) => s.trim())) {
    const [name, v] = a.trim().split(/\s+/);
    vars.set(name, adjIn[name] ?? (name === 'adj1' && adjIn.adj !== undefined ? adjIn.adj : Number(v)));
  }
  for (const g of (def.gd ?? '').split(';').filter((s) => s.trim())) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(g);
    if (m) vars.set(m[1], evalFormula(m[2], vars));
  }
  const [sx, sy] = def.space ? [w / def.space[0], h / def.space[1]] : [1, 1];
  const paths: SubPath[] = def.path.split('|').map((src) => {
    let s = src.trim();
    let stroke = true;
    let fill: SubPath['fill'] = 'norm';
    for (;;) {
      const m = /^(!s|!f|~\w+)\s+/.exec(s);
      if (!m) break;
      if (m[1] === '!s') stroke = false;
      else if (m[1] === '!f') fill = 'none';
      else fill = m[1].slice(1) as SubPath['fill'];
      s = s.slice(m[0].length);
    }
    const pb = new PathBuilder();
    runPath(s, vars, sx, sy, pb);
    return { d: pb.d.join(' '), fill, stroke };
  });
  let text = { l: 0, t: 0, r: w, b: h };
  if (def.text) {
    const [l, t, r, b] = def.text.split(/\s+/).map((k) => val(vars, k));
    text = { l, t, r, b };
  }
  if (def.mirror) {
    for (const p of paths) p.d = mirrorPath(p.d, w);
    text = { l: w - text.r, t: text.t, r: w - text.l, b: text.b };
  }
  return { paths, text };
}

function mirrorPath(d: string, w: number): string {
  return d.replace(/([MLCQA])([^MLCQAZ]*)/g, (_m, cmd: string, args: string) => {
    const n = args.trim().split(/\s+/).map(Number);
    if (cmd === 'A') return `A${n[0]} ${n[1]} ${n[2]} ${n[3]} ${n[4] ? 0 : 1} ${(w - n[5]).toFixed(2)} ${n[6]} `;
    const out = n.map((v, i) => (i % 2 === 0 ? (w - v).toFixed(2) : String(v)));
    return `${cmd}${out.join(' ')} `;
  });
}

/** A custom geometry read out of its XML once: guides, then paths of commands. */
interface CustGeom {
  guides: [name: string, fmla: string][];
  paths: { w: number; h: number; fill: SubPath['fill']; stroke: boolean; cmds: { op: string; args: string[] }[] }[];
}

function compileCust(el: Element): CustGeom {
  const guides = [...kids(kid(el, 'avLst'), 'gd'), ...kids(kid(el, 'gdLst'), 'gd')].map((g): [string, string] => [attr(g, 'name') ?? '', attr(g, 'fmla') ?? '']);
  const paths = kids(kid(el, 'pathLst'), 'path').map((p) => {
    const fillAttr = attr(p, 'fill');
    const cmds = kids(p).map((c) => ({
      op: c.localName,
      args:
        c.localName === 'arcTo'
          ? [attr(c, 'wR') ?? '0', attr(c, 'hR') ?? '0', attr(c, 'stAng') ?? '0', attr(c, 'swAng') ?? '0']
          : kids(c, 'pt').flatMap((pt) => [attr(pt, 'x') ?? '0', attr(pt, 'y') ?? '0']),
    }));
    return {
      w: Number(attr(p, 'w') ?? 0),
      h: Number(attr(p, 'h') ?? 0),
      fill: (fillAttr === null ? 'norm' : fillAttr) as SubPath['fill'],
      stroke: attr(p, 'stroke') !== '0' && attr(p, 'stroke') !== 'false',
      cmds,
    };
  });
  return { guides, paths };
}

function custPath(geom: CustGeom, w: number, h: number): ShapePath {
  const paths: SubPath[] = [];
  // Paths drawn in the same space share their guides' values.
  const spaces = new Map<string, Vars>();
  for (const p of geom.paths) {
    const space = `${p.w}x${p.h}`;
    let vars = spaces.get(space);
    if (!vars) {
      // Guides use the path's own space, which is the shape's size when it was drawn.
      const v = builtins(p.w || w, p.h || h);
      for (const [name, fmla] of geom.guides) v.set(name, evalFormula(fmla, v));
      spaces.set(space, (vars = v));
    }
    const sx = p.w ? w / p.w : 1;
    const sy = p.h ? h / p.h : 1;
    const pb = new PathBuilder();
    for (const { op, args } of p.cmds) {
      const n = args.map((a, i) => val(vars, a) * (op === 'arcTo' ? (i === 0 ? sx : i === 1 ? sy : 1) : i % 2 ? sy : sx));
      switch (op) {
        case 'moveTo': if (n.length >= 2) pb.moveTo(n[0], n[1]); break;
        case 'lnTo': if (n.length >= 2) pb.lineTo(n[0], n[1]); break;
        case 'cubicBezTo': if (n.length === 6) pb.cubic(n[0], n[1], n[2], n[3], n[4], n[5]); break;
        case 'quadBezTo': if (n.length === 4) pb.quad(n[0], n[1], n[2], n[3]); break;
        case 'arcTo': pb.arcTo(n[0], n[1], n[2], n[3]); break;
        case 'close': pb.close(); break;
      }
    }
    paths.push({ d: pb.d.join(' '), fill: p.fill, stroke: p.stroke });
  }
  return { paths, text: { l: 0, t: 0, r: w, b: h } };
}

// Big enough to hold every shape of a drawing exported to slides (a floor
// plan from CAD is thousands of custom shapes a slide), so moving between
// slides doesn't recompute them all.
const CACHE_LIMIT = 50000;
const cache = new Map<string, ShapePath>();
/** Custom geometries by their XML, read once, with their paths by size. */
const custCache = new Map<string, { geom: CustGeom; sizes: Map<string, ShapePath> }>();

function cached<K>(map: Map<K, ShapePath>, key: K, w: number, h: number, make: () => ShapePath): ShapePath {
  const hit = map.get(key);
  if (hit) return hit;
  let out: ShapePath;
  try {
    out = make();
  } catch {
    out = presetPath('rect', w, h, {});
  }
  map.set(key, out);
  return out;
}

function remember(xml: string, el: Element) {
  if (custCache.size >= CACHE_LIMIT) custCache.clear();
  const entry = { geom: compileCust(el), sizes: new Map<string, ShapePath>() };
  custCache.set(xml, entry);
  return entry;
}

/**
 * Hands over an a:custGeom already parsed (with `xml` its serialization),
 * so drawing it doesn't parse it again; a slide can have thousands.
 */
export function rememberCustGeom(xml: string, el: Element): void {
  if (!custCache.has(xml)) remember(xml, el);
}

/** The outline of a shape of this geometry and size (px). */
export function shapePath(geom: Geometry | undefined, w: number, h: number): ShapePath {
  const size = `${w.toFixed(2)}|${h.toFixed(2)}`;
  // A custom geometry's XML can be long; it's looked up by itself rather
  // than as part of a key string, which would be built and hashed each time.
  if (geom?.cust) {
    let entry = custCache.get(geom.cust);
    if (!entry) {
      try {
        entry = remember(geom.cust, parseXml(geom.cust).documentElement);
      } catch {
        return presetPath('rect', w, h, {});
      }
    }
    const { geom: cust } = entry;
    return cached(entry.sizes, size, w, h, () => custPath(cust, w, h));
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  return cached(cache, `${geom?.prst ?? ''}|${JSON.stringify(geom?.adj ?? {})}|${size}`, w, h, () => presetPath(geom?.prst ?? 'rect', w, h, geom?.adj ?? {}));
}

/** Whether a geometry is a line (drawn with no fill, stretched to its two ends). */
export function isLineGeom(geom: Geometry | undefined): boolean {
  const p = geom?.prst ?? '';
  return p === 'line' || /Connector/.test(p);
}
