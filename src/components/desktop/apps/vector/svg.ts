import { defaultStroke, IDENTITY, mul, newId, newLayer, NONE, segments, type Artboard, type Doc, type GradStop, type Gradient, type Item, type Mat, type Node, type Paint, type PathItem, type Rect, type Stroke, type SubPath, type TextItem } from './model';
import { hexColor, toHex, type Color } from './pdf/color';
import { transformPaths } from './geom';
import { layoutText } from './text';
import { ellipsePath, rectPath } from './ops';

/**
 * SVG in and out: File > Export > SVG writes an artboard (or the whole art)
 * as SVG, and SVG files open as editable art, as they do in Illustrator.
 */

const f = (n: number) => String(Math.round(n * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pathData(paths: SubPath[]): string {
  const out: string[] = [];
  for (const sp of paths) {
    if (!sp.nodes.length) continue;
    out.push(`M${f(sp.nodes[0].x)} ${f(sp.nodes[0].y)}`);
    for (const [a, b] of segments(sp)) {
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) out.push(`L${f(b.x)} ${f(b.y)}`);
      else out.push(`C${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`);
    }
    if (sp.closed) out.push('Z');
  }
  return out.join('');
}

export function writeSvg(doc: Doc, area: Rect | null): string {
  const defs: string[] = [];
  let gid = 0;
  const paint = (p: Paint): string => {
    if (p.type === 'none') return 'none';
    if (p.type === 'color') return toHex(p.color);
    const g = p.gradient;
    const id = `g${gid++}`;
    const m = g.matrix;
    const stops = [...g.stops]
      .sort((a, b) => a.t - b.t)
      .map((s) => `<stop offset="${f(s.t)}" stop-color="${toHex(s.color)}"${s.opacity < 1 ? ` stop-opacity="${f(s.opacity)}"` : ''}/>`)
      .join('');
    const tf = `gradientTransform="matrix(${m.map(f).join(' ')})" gradientUnits="userSpaceOnUse"`;
    if (g.type === 'linear') defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0" ${tf}>${stops}</linearGradient>`);
    else {
      const fo = g.focal ?? { x: 0, y: 0, r: 0 };
      defs.push(`<radialGradient id="${id}" cx="0" cy="0" r="1" fx="${f(fo.x)}" fy="${f(fo.y)}" ${tf}>${stops}</radialGradient>`);
    }
    return `url(#${id})`;
  };
  const strokeAttrs = (s: Stroke) => {
    if (s.paint.type === 'none' || s.width <= 0) return ' stroke="none"';
    let a = ` stroke="${paint(s.paint)}" stroke-width="${f(s.width)}"`;
    if (s.cap) a += ` stroke-linecap="${['butt', 'round', 'square'][s.cap]}"`;
    if (s.join) a += ` stroke-linejoin="${['miter', 'round', 'bevel'][s.join]}"`;
    if (s.miter !== 4 && s.join === 0) a += ` stroke-miterlimit="${f(s.miter)}"`;
    if (s.dash.length) a += ` stroke-dasharray="${s.dash.map(f).join(' ')}"`;
    return a;
  };
  const common = (it: Item) =>
    `${it.opacity < 1 ? ` opacity="${f(it.opacity)}"` : ''}${it.blend !== 'normal' ? ` style="mix-blend-mode:${it.blend}"` : ''}${it.name ? ` id="${esc(it.name.replace(/\s+/g, '_'))}"` : ''}`;
  let clipId = 0;
  const item = (it: Item): string => {
    if (it.hidden) return '';
    if (it.type === 'path') {
      return `<path d="${pathData(it.paths)}" fill="${paint(it.fill)}"${it.evenOdd ? ' fill-rule="evenodd"' : ''}${strokeAttrs(it.stroke)}${common(it)}/>`;
    }
    if (it.type === 'image') {
      const img = doc.res.images.get(it.image);
      if (!img?.bitmap) return '';
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')!.drawImage(img.bitmap, 0, 0);
      return `<image width="1" height="1" preserveAspectRatio="none" transform="matrix(${it.matrix.map(f).join(' ')})" href="${c.toDataURL('image/png')}"${common(it)}/>`;
    }
    if (it.type === 'text') {
      const layout = layoutText(it, doc.res);
      const run = it.runs[0];
      const text = layout.lines
        .map((ln) => {
          const chars = ln.glyphs.filter((g) => g.ch !== '\n');
          if (!chars.length) return '';
          const xs = chars.map((g) => f(g.x)).join(' ');
          return `<tspan x="${xs}" y="${f(ln.y)}">${esc(chars.map((g) => g.ch).join(''))}</tspan>`;
        })
        .join('');
      const weight = /bold|black|heavy/i.test(run.font.style) ? ' font-weight="bold"' : '';
      const italic = /italic|oblique/i.test(run.font.style) ? ' font-style="italic"' : '';
      return `<text transform="matrix(${it.matrix.map(f).join(' ')})" font-family="${esc(run.font.family)}" font-size="${f(run.size)}"${weight}${italic} fill="${paint(run.fill)}"${strokeAttrs(run.stroke)}${common(it)} xml:space="preserve">${text}</text>`;
    }
    const kids = it.clip ? it.children.slice(1) : it.children;
    let clip = '';
    if (it.clip && it.children[0]?.type === 'path') {
      const id = `clip${clipId++}`;
      defs.push(`<clipPath id="${id}"><path d="${pathData(it.children[0].paths)}"${it.children[0].evenOdd ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
      clip = ` clip-path="url(#${id})"`;
    }
    return `<g${clip}${common(it)}>${kids.map(item).join('')}</g>`;
  };
  const body = doc.layers
    .filter((l) => !l.hidden)
    .map((l) => `<g id="${esc(l.name.replace(/\s+/g, '_'))}">${l.children.map(item).join('')}</g>`)
    .join('\n');
  const r = area ?? doc.artboards[0] ?? { x: 0, y: 0, w: 100, h: 100 };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${f(r.x)} ${f(r.y)} ${f(r.w)} ${f(r.h)}" width="${f(r.w)}" height="${f(r.h)}">
${defs.length ? `<defs>${defs.join('')}</defs>\n` : ''}${body}
</svg>
`;
}

// ---- Reading -------------------------------------------------------------------------------------

function parseTransform(s: string | null): Mat {
  let m: Mat = IDENTITY;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Mat = IDENTITY;
    if (fn === 'matrix' && a.length === 6) t = a as Mat;
    else if (fn === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180;
      const c = Math.cos(r);
      const sn = Math.sin(r);
      const cx = a[1] ?? 0;
      const cy = a[2] ?? 0;
      t = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
    } else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    // Later transforms apply first.
    m = mul(t, m);
  }
  return m;
}

/** SVG path data to subpaths. */
export function parsePathData(d: string): SubPath[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let sp: SubPath | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: { x: number; y: number } | null = null;
  let lastQ: { x: number; y: number } | null = null;
  let i = 0;
  let cmd = '';
  const num = () => Number(toks[i++]);
  const has = () => i < toks.length && !/[a-zA-Z]/.test(toks[i]);
  const cur = () => sp!.nodes[sp!.nodes.length - 1];
  const lineTo = (nx: number, ny: number) => {
    sp!.nodes.push({ x: nx, y: ny, ix: nx, iy: ny, ox: nx, oy: ny });
    x = nx;
    y = ny;
  };
  const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number) => {
    const p = cur();
    p.ox = c1x;
    p.oy = c1y;
    sp!.nodes.push({ x: nx, y: ny, ix: c2x, iy: c2y, ox: nx, oy: ny });
    x = nx;
    y = ny;
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === 'Z') {
      if (sp) {
        sp.closed = true;
        const a = sp.nodes[0];
        const z = sp.nodes[sp.nodes.length - 1];
        if (sp.nodes.length > 1 && Math.abs(a.x - z.x) < 1e-6 && Math.abs(a.y - z.y) < 1e-6) {
          a.ix = z.ix;
          a.iy = z.iy;
          sp.nodes.pop();
        }
      }
      x = sx;
      y = sy;
      sp = null;
      lastC = lastQ = null;
      continue;
    }
    if (!has()) {
      i++;
      continue;
    }
    if (C === 'M') {
      const nx = num() + ox;
      const ny = num() + oy;
      sp = { closed: false, nodes: [{ x: nx, y: ny, ix: nx, iy: ny, ox: nx, oy: ny }] };
      out.push(sp);
      x = sx = nx;
      y = sy = ny;
      cmd = rel ? 'l' : 'L';
      lastC = lastQ = null;
      continue;
    }
    if (!sp) {
      sp = { closed: false, nodes: [{ x, y, ix: x, iy: y, ox: x, oy: y }] };
      out.push(sp);
    }
    if (C === 'L') lineTo(num() + ox, num() + oy);
    else if (C === 'H') lineTo(num() + ox, y);
    else if (C === 'V') lineTo(x, num() + oy);
    else if (C === 'C') {
      const a = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy];
      curveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
      lastC = { x: a[2], y: a[3] };
      lastQ = null;
      continue;
    } else if (C === 'S') {
      const c1 = lastC ? { x: 2 * x - lastC.x, y: 2 * y - lastC.y } : { x, y };
      const a = [num() + ox, num() + oy, num() + ox, num() + oy];
      curveTo(c1.x, c1.y, a[0], a[1], a[2], a[3]);
      lastC = { x: a[0], y: a[1] };
      lastQ = null;
      continue;
    } else if (C === 'Q' || C === 'T') {
      const q: { x: number; y: number } = C === 'Q' ? { x: num() + ox, y: num() + oy } : lastQ ? { x: 2 * x - lastQ.x, y: 2 * y - lastQ.y } : { x, y };
      const nx = num() + ox;
      const ny = num() + oy;
      curveTo(x + ((q.x - x) * 2) / 3, y + ((q.y - y) * 2) / 3, nx + ((q.x - nx) * 2) / 3, ny + ((q.y - ny) * 2) / 3, nx, ny);
      lastQ = q;
      lastC = null;
      continue;
    } else if (C === 'A') {
      const rx = Math.abs(num());
      const ry = Math.abs(num());
      const rot = num();
      const large = num();
      const sweep = num();
      const nx = num() + ox;
      const ny = num() + oy;
      for (const c of arcToCubics(x, y, rx, ry, rot, !!large, !!sweep, nx, ny)) curveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
      x = nx;
      y = ny;
    } else i++;
    lastC = lastQ = null;
  }
  return out.filter((s) => s.nodes.length);
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const out: number[][] = [];
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step;
    const b = a + step;
    const p = (t: number) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
    const d = (t: number) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
    const [ax, ay] = p(a);
    const [bx, by] = p(b);
    const [dax, day] = d(a);
    const [dbx, dby] = d(b);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return out;
}

function cssColor(v: string): { color: Color; alpha: number } | null {
  v = v.trim();
  if (!v || v === 'none' || v === 'transparent') return null;
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = '#000';
  c.fillStyle = v;
  const s = c.fillStyle;
  if (s.startsWith('#')) return { color: hexColor(s), alpha: 1 };
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const [r, g, b, a] = m[1].split(',').map((x) => Number(x.trim()));
    return { color: { space: 'rgb', c: [r / 255, g / 255, b / 255] }, alpha: a ?? 1 };
  }
  return null;
}

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  fillRule: string;
  cap: string;
  join: string;
  miter: number;
  dash: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  display: string;
}

const BASE_STYLE: Style = {
  fill: '#000',
  stroke: 'none',
  strokeWidth: 1,
  opacity: 1,
  fillOpacity: 1,
  fillRule: 'nonzero',
  cap: 'butt',
  join: 'miter',
  miter: 4,
  dash: 'none',
  fontFamily: 'Arial',
  fontSize: 16,
  fontWeight: 'normal',
  fontStyle: 'normal',
  display: 'inline',
};

function styleOf(el: Element, parent: Style): Style {
  const s: Style = { ...parent, opacity: 1 };
  const props: Record<string, string> = {};
  for (const a of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight', 'font-style', 'display', 'visibility']) {
    const v = el.getAttribute(a);
    if (v !== null) props[a] = v;
  }
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const [k, ...rest] = decl.split(':');
    if (k && rest.length) props[k.trim()] = rest.join(':').trim();
  }
  if (props.fill) s.fill = props.fill;
  if (props.stroke) s.stroke = props.stroke;
  if (props['stroke-width']) s.strokeWidth = parseFloat(props['stroke-width']) || 0;
  if (props.opacity) s.opacity = parseFloat(props.opacity);
  if (props['fill-opacity']) s.fillOpacity = parseFloat(props['fill-opacity']);
  if (props['fill-rule']) s.fillRule = props['fill-rule'];
  if (props['stroke-linecap']) s.cap = props['stroke-linecap'];
  if (props['stroke-linejoin']) s.join = props['stroke-linejoin'];
  if (props['stroke-miterlimit']) s.miter = parseFloat(props['stroke-miterlimit']);
  if (props['stroke-dasharray']) s.dash = props['stroke-dasharray'];
  if (props['font-family']) s.fontFamily = props['font-family'].split(',')[0].replace(/['"]/g, '').trim();
  if (props['font-size']) s.fontSize = parseFloat(props['font-size']) || s.fontSize;
  if (props['font-weight']) s.fontWeight = props['font-weight'];
  if (props['font-style']) s.fontStyle = props['font-style'];
  if (props.display === 'none' || props.visibility === 'hidden') s.display = 'none';
  return s;
}

/** Read an SVG file as a document. */
export async function readSvg(source: string): Promise<Doc> {
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = xml.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || xml.getElementsByTagName('parsererror').length) throw new Error('It isn’t an SVG file that can be read.');
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const w = parseFloat(root.getAttribute('width') ?? '') || vb[2] || 800;
  const h = parseFloat(root.getAttribute('height') ?? '') || vb[3] || 600;
  let base: Mat = IDENTITY;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) base = [w / vb[2], 0, 0, h / vb[3], (-vb[0] * w) / vb[2], (-vb[1] * h) / vb[3]];
  const ab: Artboard = { id: newId(), name: 'Artboard 1', x: 0, y: 0, w, h };
  const byId = new Map<string, Element>();
  for (const el of Array.from(xml.querySelectorAll('[id]'))) byId.set(el.getAttribute('id')!, el);
  const layer = newLayer('Layer 1', 0);
  const doc: Doc = { artboards: [ab], layers: [layer], res: { images: new Map(), fonts: new Map() }, mode: 'rgb', units: 'px', notes: [] };

  const gradient = (id: string, m: Mat, bbox: () => Rect): Gradient | null => {
    let el = byId.get(id);
    if (!el) return null;
    const own = el;
    // Stops may come from an href'd gradient.
    let stopsEl = el;
    for (let k = 0; k < 4 && !stopsEl.querySelector('stop'); k++) {
      const href = (stopsEl.getAttribute('href') ?? stopsEl.getAttribute('xlink:href') ?? '').replace('#', '');
      const next = byId.get(href);
      if (!next) break;
      stopsEl = next;
    }
    el = own;
    const stops: GradStop[] = Array.from(stopsEl.querySelectorAll('stop')).map((s) => {
      const sc = s.getAttribute('stop-color') ?? /stop-color:\s*([^;]+)/.exec(s.getAttribute('style') ?? '')?.[1] ?? '#000';
      const so = s.getAttribute('stop-opacity') ?? /stop-opacity:\s*([^;]+)/.exec(s.getAttribute('style') ?? '')?.[1] ?? '1';
      const off = s.getAttribute('offset') ?? '0';
      return { t: off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off), color: cssColor(sc)?.color ?? { space: 'gray', c: [0] }, opacity: parseFloat(so) };
    });
    if (!stops.length) return null;
    const userSpace = el.getAttribute('gradientUnits') === 'userSpaceOnUse';
    const gt = parseTransform(el.getAttribute('gradientTransform'));
    const num = (a: string, d: number) => {
      const v = el!.getAttribute(a);
      if (v === null) return d;
      return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    };
    let unit: Mat = IDENTITY;
    if (!userSpace) {
      const b = bbox();
      unit = [b.w, 0, 0, b.h, b.x, b.y];
    }
    const space = mul(mul(gt, unit), m);
    if (el.nodeName.endsWith('linearGradient')) {
      const x1 = num('x1', 0);
      const y1 = num('y1', 0);
      const x2 = num('x2', 1);
      const y2 = num('y2', 0);
      const dx = x2 - x1;
      const dy = y2 - y1;
      return { type: 'linear', stops, matrix: mul([dx, dy, -dy, dx, x1, y1], space) };
    }
    const cx = num('cx', 0.5);
    const cy = num('cy', 0.5);
    const r = num('r', 0.5) || 1;
    const fx = num('fx', cx);
    const fy = num('fy', cy);
    return { type: 'radial', stops, matrix: mul([r, 0, 0, r, cx, cy], space), focal: { x: (fx - cx) / r, y: (fy - cy) / r, r: 0 } };
  };

  const paintOf = (v: string, alpha: number, m: Mat, bbox: () => Rect): { paint: Paint; alpha: number } => {
    const url = /url\(\s*#([^)\s]+)\s*\)/.exec(v);
    if (url) {
      const g = gradient(url[1], m, bbox);
      return g ? { paint: { type: 'gradient', gradient: g }, alpha } : { paint: NONE, alpha };
    }
    const c = cssColor(v === 'currentColor' ? '#000' : v);
    return c ? { paint: { type: 'color', color: c.color }, alpha: alpha * c.alpha } : { paint: NONE, alpha };
  };

  const shape = (el: Element, st: Style, m: Mat): Item | null => {
    const tag = el.nodeName.replace(/^.*:/, '');
    const n = (a: string) => parseFloat(el.getAttribute(a) ?? '0') || 0;
    let paths: SubPath[];
    if (tag === 'path') paths = parsePathData(el.getAttribute('d') ?? '');
    else if (tag === 'rect') paths = [rectPath(n('x'), n('y'), n('width'), n('height'), n('rx') || n('ry'))];
    else if (tag === 'circle') paths = [ellipsePath(n('cx'), n('cy'), n('r'), n('r'))];
    else if (tag === 'ellipse') paths = [ellipsePath(n('cx'), n('cy'), n('rx'), n('ry'))];
    else if (tag === 'line') paths = [{ closed: false, nodes: [pt(n('x1'), n('y1')), pt(n('x2'), n('y2'))] }];
    else if (tag === 'polyline' || tag === 'polygon') {
      const v = (el.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const nodes: Node[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) nodes.push(pt(v[i], v[i + 1]));
      paths = [{ closed: tag === 'polygon', nodes }];
    } else return null;
    if (!paths.length) return null;
    const local = paths;
    paths = transformPaths(paths, m);
    const bbox = () => {
      const xs = local.flatMap((s) => s.nodes.map((q) => q.x));
      const ys = local.flatMap((s) => s.nodes.map((q) => q.y));
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
    };
    const fill = paintOf(st.fill, st.fillOpacity, m, bbox);
    const strokeP = paintOf(st.stroke, 1, m, bbox);
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const stroke: Stroke = {
      ...defaultStroke(strokeP.paint, st.strokeWidth * k),
      cap: st.cap === 'round' ? 1 : st.cap === 'square' ? 2 : 0,
      join: st.join === 'round' ? 1 : st.join === 'bevel' ? 2 : 0,
      miter: st.miter,
      dash: st.dash === 'none' ? [] : st.dash.split(/[\s,]+/).map(Number).filter((x) => x >= 0).map((x) => x * k),
    };
    const p: PathItem = { id: newId(), type: 'path', name: '', opacity: st.opacity * fill.alpha, blend: 'normal', paths, fill: fill.paint, stroke, evenOdd: st.fillRule === 'evenodd' };
    return p;
  };

  const text = (el: Element, st: Style, m: Mat): Item | null => {
    const content = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!content) return null;
    const first = el.querySelector('tspan') ?? el;
    const x = parseFloat(first.getAttribute('x') ?? el.getAttribute('x') ?? '0') || 0;
    const y = parseFloat(first.getAttribute('y') ?? el.getAttribute('y') ?? '0') || 0;
    const fill = paintOf(st.fill, st.fillOpacity, m, () => ({ x, y, w: 1, h: 1 }));
    const bold = /bold|[6-9]00/.test(st.fontWeight);
    const t: TextItem = {
      id: newId(),
      type: 'text',
      name: '',
      opacity: st.opacity * fill.alpha,
      blend: 'normal',
      matrix: mul([1, 0, 0, 1, x, y], m),
      align: el.getAttribute('text-anchor') === 'middle' ? 'center' : el.getAttribute('text-anchor') === 'end' ? 'right' : 'left',
      leading: 0,
      runs: [
        {
          text: content,
          font: { family: st.fontFamily, style: `${bold ? 'Bold' : 'Regular'}${st.fontStyle === 'italic' ? ' Italic' : ''}`.replace('Regular Italic', 'Italic'), postscript: st.fontFamily.replace(/\s+/g, '') },
          size: st.fontSize,
          fill: fill.paint,
          stroke: defaultStroke(),
          tracking: 0,
          hscale: 1,
          rise: 0,
        },
      ],
    };
    return t;
  };

  const image = (el: Element, st: Style, m: Mat): Item | null => {
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('data:image/')) return null;
    const key = `img${newId()}`;
    const entry = { width: 1, height: 1, bitmap: null as ImageBitmap | null };
    doc.res.images.set(key, entry);
    pendingImages.push(
      fetch(href)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b))
        .then((bmp) => {
          entry.bitmap = bmp;
          entry.width = bmp.width;
          entry.height = bmp.height;
        })
        .catch(() => undefined),
    );
    const n = (a: string, d = 0) => parseFloat(el.getAttribute(a) ?? '') || d;
    return { id: newId(), type: 'image', name: '', opacity: st.opacity, blend: 'normal', image: key, matrix: mul([n('width', 1), 0, 0, n('height', 1), n('x'), n('y')], m) };
  };

  const walkEl = (el: Element, parent: Style, m: Mat, out: Item[]) => {
    for (const child of Array.from(el.children)) {
      const tag = child.nodeName.replace(/^.*:/, '');
      if (['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'style', 'title', 'desc', 'metadata', 'symbol', 'marker', 'filter'].includes(tag)) continue;
      const st = styleOf(child, parent);
      if (st.display === 'none') continue;
      const cm = mul(parseTransform(child.getAttribute('transform')), m);
      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        const kids: Item[] = [];
        walkEl(child, { ...st, opacity: 1 }, cm, kids);
        if (!kids.length) continue;
        const clipRef = /url\(\s*#([^)\s]+)\s*\)/.exec(child.getAttribute('clip-path') ?? '')?.[1];
        const clipEl = clipRef ? byId.get(clipRef) : null;
        const clipShape = clipEl ? Array.from(clipEl.children).map((c) => shape(c, BASE_STYLE, mul(parseTransform(c.getAttribute('transform')), cm))).find(Boolean) : null;
        const name = child.getAttribute('id') ?? '';
        out.push({ id: newId(), type: 'group', name: name.replace(/_/g, ' '), opacity: st.opacity, blend: 'normal', clip: !!clipShape, children: clipShape ? [{ ...clipShape, fill: NONE, stroke: defaultStroke() } as Item, ...kids] : kids });
      } else if (tag === 'use') {
        const ref = byId.get((child.getAttribute('href') ?? child.getAttribute('xlink:href') ?? '').replace('#', ''));
        if (!ref) continue;
        const dx = parseFloat(child.getAttribute('x') ?? '0') || 0;
        const dy = parseFloat(child.getAttribute('y') ?? '0') || 0;
        const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        wrap.appendChild(ref.cloneNode(true));
        walkEl(wrap, st, mul([1, 0, 0, 1, dx, dy], cm), out);
      } else if (tag === 'text') {
        const t = text(child, st, cm);
        if (t) out.push(t);
      } else if (tag === 'image') {
        const im = image(child, st, cm);
        if (im) out.push(im);
      } else {
        const s = shape(child, st, cm);
        if (s) out.push(s);
      }
    }
  };
  const pendingImages: Promise<unknown>[] = [];
  walkEl(root, BASE_STYLE, base, layer.children);
  // Top-level groups named like layers become layers.
  if (layer.children.length > 1 && layer.children.every((c) => c.type === 'group' && c.name && c.opacity === 1 && !c.clip)) {
    doc.layers = layer.children.map((g, i) => ({ ...newLayer(g.name, i), children: (g as Item & { type: 'group' }).children }));
  }
  await Promise.all(pendingImages);
  return doc;
}

function pt(x: number, y: number): Node {
  return { x, y, ix: x, iy: y, ox: x, oy: y };
}
