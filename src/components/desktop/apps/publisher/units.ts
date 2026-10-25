/**
 * Measurement units the way InDesign shows and reads them. Documents keep
 * points; fields show the document's ruler units, and accept anything typed
 * with a unit ("3p6", "12pt", "1in", "25mm", "100px") or a bit of arithmetic.
 */

export type Unit = 'pt' | 'p' | 'in' | 'mm' | 'cm' | 'px';

export const UNIT_NAMES: Record<Unit, string> = { pt: 'Points', p: 'Picas', in: 'Inches', mm: 'Millimeters', cm: 'Centimeters', px: 'Pixels' };

const PER: Record<Unit, number> = { pt: 1, p: 12, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, px: 1 };

/** IDML's MeasurementUnits names. */
export function unitFromIdml(s: string | null | undefined): Unit {
  switch (s) {
    case 'Points':
    case 'AmericanPoints':
      return 'pt';
    case 'Picas':
      return 'p';
    case 'Inches':
    case 'InchesDecimal':
      return 'in';
    case 'Millimeters':
      return 'mm';
    case 'Centimeters':
      return 'cm';
    case 'Pixels':
      return 'px';
    default:
      return 'p';
  }
}

export function unitToIdml(u: Unit): string {
  return { pt: 'Points', p: 'Picas', in: 'Inches', mm: 'Millimeters', cm: 'Centimeters', px: 'Pixels' }[u];
}

const trim = (v: number, d: number) => {
  const r = Number(v.toFixed(d));
  return String(Object.is(r, -0) ? 0 : r);
};

/** Points as the unit shows them: "3p6", "1.5 in", "12 pt". */
export function fmtLength(pt: number, u: Unit, d = 3): string {
  if (u === 'p') {
    const neg = pt < 0;
    const a = Math.abs(pt);
    let picas = Math.floor(a / 12 + 1e-9);
    let rest = Number((a - picas * 12).toFixed(3));
    if (rest >= 12) {
      picas += 1;
      rest = 0;
    }
    return `${neg ? '-' : ''}${picas}p${trim(rest, d)}`;
  }
  return `${trim(pt / PER[u], u === 'in' ? d + 1 : d)} ${u}`;
}

/** Reads a typed length into points; plain numbers are in the default unit. */
export function parseLength(raw: string, u: Unit): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '.');
  if (!s) return null;
  // Simple sums and products, as InDesign's fields allow ("3p+6", "12*2").
  const m = s.match(/^(.+?)\s*([+\-*/])\s*([^+\-*/]+)$/);
  if (m && !/^-?\d*\.?\d*p\d/.test(s)) {
    const a = parseLength(m[1], u);
    if (a === null) return null;
    if (m[2] === '*' || m[2] === '/') {
      const k = parseFloat(m[3]);
      if (!Number.isFinite(k) || (m[2] === '/' && k === 0)) return null;
      return m[2] === '*' ? a * k : a / k;
    }
    const b = parseLength(m[3], u);
    if (b === null) return null;
    return m[2] === '+' ? a + b : a - b;
  }
  const picas = s.match(/^(-?)(\d*\.?\d*)p(\d*\.?\d*)$/);
  if (picas && (picas[2] || picas[3])) {
    const v = (parseFloat(picas[2] || '0') || 0) * 12 + (parseFloat(picas[3] || '0') || 0);
    return picas[1] ? -v : v;
  }
  const pre = s.match(/^p(\d*\.?\d*)$/);
  if (pre) return parseFloat(pre[1]) || 0;
  const n = s.match(/^(-?\d*\.?\d+)\s*(pt|pts|points?|in|inch|inches|"|mm|cm|px|picas?)?$/);
  if (!n) return null;
  const v = parseFloat(n[1]);
  if (!Number.isFinite(v)) return null;
  const unit = n[2];
  if (!unit) return v * PER[u];
  if (unit.startsWith('pt') || unit.startsWith('point')) return v;
  if (unit.startsWith('pica')) return v * 12;
  if (unit === 'in' || unit.startsWith('inch') || unit === '"') return v * 72;
  if (unit === 'mm') return v * PER.mm;
  if (unit === 'cm') return v * PER.cm;
  return v;
}

/** How far the arrow keys move things in a unit (InDesign's default cursor key increment). */
export const nudgeStep = (u: Unit) => (u === 'mm' ? PER.mm * 0.25 : u === 'cm' ? PER.mm : u === 'in' ? 0.0625 * 72 : 1);

/** Ruler ticks: the gap between labelled ticks, and how many parts between them. */
export function rulerSteps(u: Unit, zoom: number): { major: number; minor: number } {
  const per = u === 'p' ? 12 : PER[u];
  const target = 80 / zoom; // points between labels
  const candidates = u === 'in' ? [0.125, 0.25, 0.5, 1, 2, 4, 8, 16] : u === 'p' ? [0.5, 1, 2, 3, 6, 12, 24, 48, 96] : [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  let major = candidates[candidates.length - 1] * per;
  for (const c of candidates) {
    if (c * per >= target) {
      major = c * per;
      break;
    }
  }
  const minor = u === 'in' ? 8 : u === 'p' ? 6 : 10;
  return { major, minor };
}

export const unitLabel = (pt: number, u: Unit) => {
  const v = u === 'p' ? pt / 12 : pt / PER[u];
  return trim(v, 2);
};
