/**
 * Dimensions drawn the way AutoCAD draws them into their anonymous blocks:
 * extension lines, dimension lines, arrowheads and the measurement, from
 * the dimension's definition points and its style.
 */
import { BYBLOCK, LW_BYBLOCK, newId, type DimStyle, type Dimension, type Drawing, type Entity, type Vec } from './model';
import { add, angleOf, angleTo, dist, dot, lineLine, mid, mul, norm, perp, polar, sub, sweep, wrapAngle, TAU, onArc } from './geom';
import { findDimStyle } from './model';
import { layoutMText, fontFamily } from './text';
import { findTextStyle } from './model';

/** Format a length the way the style says: decimals, zero suppression, separator, prefix and suffix. */
export function formatLength(v: number, s: DimStyle, lunits = 2): string {
  const x = v * (s.dimlfac || 1);
  const r = s.dimrnd > 0 ? Math.round(x / s.dimrnd) * s.dimrnd : x;
  let t: string;
  if ((s.dimlunit || lunits) === 4 || (s.dimlunit || lunits) === 3) t = archFormat(r, s.dimdec, (s.dimlunit || lunits) === 3);
  else {
    t = r.toFixed(Math.max(0, Math.min(8, s.dimdec)));
    if (s.dimzin & 8 && t.includes('.')) t = t.replace(/\.?0+$/, '');
    if (s.dimzin & 4) t = t.replace(/^(-?)0\./, '$1.');
    if (s.dimdsep && s.dimdsep !== 46) t = t.replace('.', String.fromCharCode(s.dimdsep));
  }
  if (t === '-0') t = '0';
  return t;
}

function archFormat(inches: number, prec: number, engineering: boolean): string {
  const neg = inches < 0;
  const a = Math.abs(inches);
  let ft = Math.floor(a / 12);
  let rest = a - ft * 12;
  if (engineering) {
    const s = rest.toFixed(Math.max(0, prec));
    return `${neg ? '-' : ''}${ft}'-${s}"`;
  }
  const den = 2 ** Math.max(0, Math.min(8, prec));
  let whole = Math.floor(rest);
  let num = Math.round((rest - whole) * den);
  if (num === den) {
    whole++;
    num = 0;
  }
  if (whole === 12) {
    ft++;
    whole = 0;
  }
  rest = whole;
  let frac = '';
  if (num) {
    let g = num;
    let d = den;
    while (g % 2 === 0 && d % 2 === 0) {
      g /= 2;
      d /= 2;
    }
    frac = ` ${g}/${d}`;
  }
  return `${neg ? '-' : ''}${ft ? `${ft}'-` : ''}${rest}${frac}"`;
}

export function formatAngle(rad: number, s: DimStyle): string {
  const deg = (rad * 180) / Math.PI;
  let t = deg.toFixed(Math.max(0, Math.min(8, s.dimadec)));
  if (t.includes('.')) t = t.replace(/\.?0+$/, '');
  if (s.dimdsep && s.dimdsep !== 46) t = t.replace('.', String.fromCharCode(s.dimdsep));
  return `${t}%%d`;
}

/** What a dimension measures. */
export function measure(d: Dimension): number {
  switch (d.kind) {
    case 'linear': {
      const u = { x: Math.cos(d.rot), y: Math.sin(d.rot) };
      return Math.abs(dot(sub(d.p14, d.p13), u));
    }
    case 'aligned':
      return dist(d.p13, d.p14);
    case 'radius':
      return dist(d.p10, d.p15);
    case 'diameter':
      return dist(d.p10, d.p15);
    case 'angular3':
      return angular3(d).sweep;
    case 'angular':
      return angular2(d)?.sweep ?? 0;
    case 'ordinate':
      return Math.abs(d.ordinateX ? d.p13.x - d.p10.x : d.p13.y - d.p10.y);
  }
}

/** The text a dimension shows: its override, with <> standing for the measurement. */
export function dimText(d: Dimension, s: DimStyle, lunits = 2): string {
  const v = measure(d);
  let m = d.kind === 'angular' || d.kind === 'angular3' ? formatAngle(v, s) : formatLength(v, s, lunits);
  if (d.kind === 'radius') m = `R${m}`;
  if (d.kind === 'diameter') m = `%%c${m}`;
  if (s.dimpost && d.kind !== 'angular' && d.kind !== 'angular3') m = s.dimpost.includes('<>') ? s.dimpost.replace('<>', m) : `${m}${s.dimpost}`;
  if (d.override === '' || d.override === undefined) return m;
  if (d.override === ' ') return '';
  return d.override.replace(/<>/g, m);
}

function angular3(d: Dimension) {
  const c = d.p15;
  let a0 = angleTo(c, d.p13);
  let a1 = angleTo(c, d.p14);
  const am = angleTo(c, d.p10);
  if (!onArc(am, a0, a1)) [a0, a1] = [a1, a0];
  return { c, r: dist(c, d.p10), a0, a1, sweep: sweep(a0, a1) };
}

function angular2(d: Dimension) {
  const x = lineLine(d.p13, d.p14, d.p10, d.p15);
  if (!x) return null;
  const c = x.p;
  const arcPt = d.p16 ?? d.text;
  const dirs = [angleTo(d.p13, d.p14), angleTo(d.p14, d.p13), angleTo(d.p10, d.p15), angleTo(d.p15, d.p10)];
  const am = angleTo(c, arcPt);
  // The pair of rays (one from each line) whose angle holds the arc point.
  let best: { a0: number; a1: number; sweep: number } | null = null;
  for (const a of dirs.slice(0, 2))
    for (const b of dirs.slice(2)) {
      for (const [s, e] of [
        [a, b],
        [b, a],
      ]) {
        const sw = sweep(s, e);
        if (sw < Math.PI + 1e-9 && onArc(am, s, e) && (!best || sw < best.sweep)) best = { a0: s, a1: e, sweep: sw };
      }
    }
  if (!best) return null;
  return { c, r: dist(c, arcPt), ...best };
}

/** A dimension's geometry in world coordinates, as AutoCAD would put in its block. */
export function dimGeometry(dim: Dimension, drawing: Drawing): Entity[] {
  const s = findDimStyle(drawing, dim.style);
  const k = s.dimscale || 1;
  const asz = s.dimasz * k;
  const txt = s.dimtxt * k;
  const exo = s.dimexo * k;
  const exe = s.dimexe * k;
  const gap = s.dimgap * k;
  const base = { layer: '0', color: BYBLOCK, linetype: 'ByBlock', lineweight: LW_BYBLOCK, ltscale: 1 };
  const out: Entity[] = [];
  const line = (a: Vec, b: Vec, color = s.dimclrd, lw = s.dimlwd) => out.push({ ...base, id: newId(), type: 'line', a, b, color, lineweight: lw });
  const tstyle = findTextStyle(drawing, s.dimtxsty);
  const family = fontFamily(tstyle);
  const label = dimText(dim, s, drawing.header.lunits);
  const textWidth = layoutMText(label.replace(/%%[dDcCpP]/g, 'W'), family, 0, 1).width * txt;
  const text = (p: Vec, rot: number) => out.push({ ...base, id: newId(), type: 'mtext', p, h: txt, width: 0, rot, attach: 5, text: label, style: tstyle?.name ?? 'Standard', spacing: 1, color: s.dimclrt });

  /** An arrowhead with its tip at p, pointing along `dir`. */
  const arrow = (p: Vec, dir: Vec) => {
    const u = norm(dir);
    const n = perp(u);
    const blk = s.dimblk.toUpperCase().replace(/^_/, '');
    if (s.dimtsz > 0 || blk === 'ARCHTICK' || blk === 'OBLIQUE') {
      const t = (s.dimtsz > 0 ? s.dimtsz * k : asz) / 2;
      const d = norm(add(u, n));
      line(sub(p, mul(d, t)), add(p, mul(d, t)));
      return;
    }
    if (blk === 'DOT' || blk === 'DOTSMALL') {
      const r = asz / (blk === 'DOT' ? 4 : 8);
      out.push({ ...base, id: newId(), type: 'pline', pts: [{ x: p.x - r / 2, y: p.y, b: 1 }, { x: p.x + r / 2, y: p.y, b: 1 }], closed: true, width: r, color: s.dimclrd });
      return;
    }
    const back = sub(p, mul(u, asz));
    const w = asz / 6;
    if (blk === 'OPEN' || blk === 'OPEN30' || blk === 'OPEN90') {
      line(p, add(back, mul(n, w)));
      line(p, sub(back, mul(n, w)));
      return;
    }
    out.push({ ...base, id: newId(), type: 'solid', pts: [p, add(back, mul(n, w)), sub(back, mul(n, w)), sub(back, mul(n, w))], color: s.dimclrd });
  };

  const readable = (a: number) => {
    const w = wrapAngle(a);
    return w > Math.PI / 2 + 1e-6 && w <= (3 * Math.PI) / 2 + 1e-6 ? wrapAngle(w - Math.PI) : w;
  };

  /** A straight dimension line between d1 and d2 with the text placed per the style. */
  const dimLine = (d1: Vec, d2: Vec) => {
    const u = norm(sub(d2, d1));
    const L = dist(d1, d2);
    const lineAng = readable(angleOf(u));
    const n = perp({ x: Math.cos(lineAng), y: Math.sin(lineAng) });
    const horizontal = s.dimtih && s.dimtad === 0;
    const rot = horizontal ? 0 : lineAng;
    const inside = L >= textWidth + 2 * asz + 2 * gap || dim.textMoved;
    const arrowsOutside = L < 2 * asz * 1.25;
    let tp: Vec;
    if (dim.textMoved) tp = dim.text;
    else if (s.dimtad > 0) tp = add(mid(d1, d2), mul(n, gap + txt / 2));
    else tp = mid(d1, d2);
    if (!inside && !dim.textMoved) tp = add(d2, mul(u, asz * 2 + textWidth / 2 + gap));
    // Break the line around centered text.
    if (s.dimtad === 0 && inside && !dim.textMoved) {
      const half = (horizontal ? Math.abs(textWidth * u.x) + Math.abs(txt * u.y) : textWidth) / 2 + gap;
      const m = mid(d1, d2);
      if (L / 2 > half) {
        if (!s.dimsd1) line(d1, sub(m, mul(u, half)));
        if (!s.dimsd2) line(add(m, mul(u, half)), d2);
      }
    } else {
      if (!s.dimsd1 && !s.dimsd2) line(d1, d2);
      else if (!s.dimsd1) line(d1, mid(d1, d2));
      else if (!s.dimsd2) line(mid(d1, d2), d2);
    }
    if (arrowsOutside) {
      line(d1, sub(d1, mul(u, asz * 2)));
      line(d2, add(d2, mul(u, asz * 2)));
      arrow(d1, u);
      arrow(d2, mul(u, -1));
    } else {
      arrow(d1, mul(u, -1));
      arrow(d2, u);
    }
    if (!inside && !dim.textMoved) line(d2, add(d2, mul(u, asz * 2)));
    text(tp, rot);
  };

  const extLine = (from: Vec, to: Vec, suppress: boolean) => {
    if (suppress) return;
    const L = dist(from, to);
    if (L < 1e-12) return;
    const u = norm(sub(to, from));
    line(add(from, mul(u, Math.min(exo, L))), add(to, mul(u, exe)), s.dimclre, s.dimlwe);
  };

  switch (dim.kind) {
    case 'linear':
    case 'aligned': {
      const u = dim.kind === 'linear' ? { x: Math.cos(dim.rot), y: Math.sin(dim.rot) } : norm(sub(dim.p14, dim.p13));
      // The dimension line runs through p10 along u.
      const proj = (p: Vec) => add(dim.p10, mul(u, dot(sub(p, dim.p10), u)));
      const d1 = proj(dim.p13);
      const d2 = proj(dim.p14);
      extLine(dim.p13, d1, s.dimse1);
      extLine(dim.p14, d2, s.dimse2);
      if (dist(d1, d2) > 1e-12) dimLine(d1, d2);
      break;
    }
    case 'radius':
    case 'diameter': {
      const c = dim.kind === 'radius' ? dim.p10 : mid(dim.p10, dim.p15);
      const onCurve = dim.p15;
      const r = dist(c, onCurve);
      const tp = dim.text;
      const tInside = dist(tp, c) < r;
      const u = norm(sub(onCurve, c));
      const rot = readable(angleOf(u));
      if (dim.kind === 'diameter') {
        line(dim.p10, dim.p15);
        arrow(dim.p15, u);
        arrow(dim.p10, mul(u, -1));
        text(tInside ? tp : add(onCurve, mul(u, asz + textWidth / 2 + gap)), rot);
      } else if (tInside) {
        line(c, onCurve);
        arrow(onCurve, u);
        text(tp, rot);
      } else {
        const end = add(onCurve, mul(u, Math.max(asz * 2, dist(onCurve, tp) - textWidth / 2 - gap)));
        line(onCurve, end);
        arrow(onCurve, mul(u, -1));
        text(add(end, mul(u, textWidth / 2 + gap)), rot);
      }
      if (s.dimcen > 0 && dim.kind === 'radius') {
        const m = s.dimcen * k;
        line({ x: c.x - m, y: c.y }, { x: c.x + m, y: c.y });
        line({ x: c.x, y: c.y - m }, { x: c.x, y: c.y + m });
      }
      break;
    }
    case 'angular3':
    case 'angular': {
      const g = dim.kind === 'angular3' ? angular3(dim) : angular2(dim);
      if (!g || g.r < 1e-12) break;
      const p0 = polar(g.c, g.r, g.a0);
      const p1 = polar(g.c, g.r, g.a1);
      // Extension lines from the measured points out to the arc.
      const legs = dim.kind === 'angular3' ? [dim.p13, dim.p14] : [nearestOnRay(g.c, g.a0, [dim.p13, dim.p14, dim.p10, dim.p15]), nearestOnRay(g.c, g.a1, [dim.p13, dim.p14, dim.p10, dim.p15])];
      const [l0, l1] = dist(legs[0], p0) < dist(legs[0], p1) ? [legs[0], legs[1]] : [legs[1], legs[0]];
      if (dist(g.c, l0) < g.r) extLine(l0, p0, s.dimse1);
      if (dist(g.c, l1) < g.r) extLine(l1, p1, s.dimse2);
      out.push({ ...base, id: newId(), type: 'arc', c: g.c, r: g.r, start: g.a0, end: g.a1, color: s.dimclrd, lineweight: s.dimlwd });
      arrow(p0, perp({ x: Math.cos(g.a0), y: Math.sin(g.a0) }));
      arrow(p1, mul(perp({ x: Math.cos(g.a1), y: Math.sin(g.a1) }), -1));
      const am = g.a0 + g.sweep / 2;
      const tp = dim.textMoved ? dim.text : polar(g.c, g.r + (s.dimtad > 0 ? gap + txt / 2 : 0), am);
      text(tp, s.dimtih ? 0 : readable(am - Math.PI / 2));
      break;
    }
    case 'ordinate': {
      const a = dim.p13;
      const b = dim.p14;
      const dir = dim.ordinateX ? { x: 0, y: Math.sign(b.y - a.y) || 1 } : { x: Math.sign(b.x - a.x) || 1, y: 0 };
      line(add(a, mul(dir, exo)), b);
      const rot = dim.ordinateX ? Math.PI / 2 : 0;
      text(add(b, mul(dir, textWidth / 2 + gap)), rot);
      break;
    }
  }
  return out;
}

function nearestOnRay(c: Vec, a: number, pts: Vec[]): Vec {
  const u = { x: Math.cos(a), y: Math.sin(a) };
  let best = c;
  let bd = Infinity;
  for (const p of pts) {
    const d = sub(p, c);
    const along = dot(d, u);
    const off = Math.abs(d.x * u.y - d.y * u.x);
    if (along > 0 && off < bd) {
      bd = off;
      best = p;
    }
  }
  return best;
}

/** A leader's arrowhead, in the leader's dimension style. */
export function leaderArrow(pts: Vec[], drawing: Drawing, styleName: string): Entity[] {
  if (pts.length < 2) return [];
  const s = findDimStyle(drawing, styleName);
  const asz = s.dimasz * (s.dimscale || 1);
  const p = pts[0];
  const u = norm(sub(p, pts[1]));
  const n = perp(u);
  const back = sub(p, mul(u, asz));
  const w = asz / 6;
  return [{ layer: '0', color: BYBLOCK, linetype: 'ByBlock', lineweight: LW_BYBLOCK, ltscale: 1, id: newId(), type: 'solid', pts: [p, add(back, mul(n, w)), sub(back, mul(n, w)), sub(back, mul(n, w))] }];
}

export { TAU };
