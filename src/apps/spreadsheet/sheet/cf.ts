import { attr, kid, kids, numAttr, parseXml } from '@/shared/office/ooxml';
import type { Theme } from '@/shared/office/theme';
import { parseRange, type Range } from './addr';
import { isArr, isRef } from './evalCore';
import { translateFormula } from './formula';
import { evaluateText, type Calc } from './formulaEval';
import { cellsIn, type Sheet, type Workbook } from './model';
import { compare, isErr, type Scalar } from './values';
import { colorOf } from './xlsxRead';

/**
 * Showing conditional formatting kept from a file: the common rule types
 * (cell value, formula, text, top/bottom, above average, color scales, data
 * bars), with their formats from the workbook's differential styles.
 */

export interface Dxf {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

interface Rule {
  type: string;
  priority: number;
  operator: string | null;
  formulas: string[];
  text: string | null;
  dxf: Dxf | null;
  stop: boolean;
  rank: number;
  percent: boolean;
  bottom: boolean;
  below: boolean;
  scale: { types: string[]; vals: (string | null)[]; colors: string[] } | null;
  bar: string | null;
}

interface Block {
  ranges: Range[];
  rules: Rule[];
}

export interface CfLook extends Dxf {
  /** A data bar: how far across, in what color. */
  bar?: { frac: number; color: string };
}

function readDxfs(xml: string | undefined, theme: Theme): Dxf[] {
  if (!xml) return [];
  const root = parseXml(xml).documentElement;
  return kids(root, 'dxf').map((d) => {
    const out: Dxf = {};
    const font = kid(d, 'font');
    if (font) {
      const c = colorOf(kid(font, 'color'), theme);
      if (c) out.color = c;
      if (kid(font, 'b') && attr(kid(font, 'b'), 'val') !== '0') out.bold = true;
      if (kid(font, 'i') && attr(kid(font, 'i'), 'val') !== '0') out.italic = true;
      if (kid(font, 'strike') && attr(kid(font, 'strike'), 'val') !== '0') out.strike = true;
    }
    const pf = kid(kid(d, 'fill'), 'patternFill');
    if (pf) {
      // A dxf's solid fill names its color in bgColor (fgColor in some writers).
      const c = colorOf(kid(pf, 'bgColor'), theme) ?? colorOf(kid(pf, 'fgColor'), theme);
      if (c) out.fill = c;
    }
    return out;
  });
}

const parsedBlocks = new WeakMap<object, Block[]>();

function blocksOf(sheet: Sheet, wb: Workbook): Block[] {
  const kept = sheet.kept;
  if (!kept?.cf.length) return [];
  let blocks = parsedBlocks.get(kept);
  if (blocks) return blocks;
  const dxfs = readDxfs(wb.dxfs, wb.theme);
  blocks = [];
  for (const xml of kept.cf) {
    let root: Element;
    try {
      root = parseXml(xml).documentElement;
    } catch {
      continue;
    }
    const ranges = (attr(root, 'sqref') ?? '').split(/\s+/).map(parseRange).filter((g): g is Range => !!g);
    const rules: Rule[] = kids(root, 'cfRule').map((el) => {
      const cs = kid(el, 'colorScale');
      const db = kid(el, 'dataBar');
      const dxfId = numAttr(el, 'dxfId');
      return {
        type: attr(el, 'type') ?? '',
        priority: numAttr(el, 'priority') ?? 0,
        operator: attr(el, 'operator'),
        formulas: kids(el, 'formula').map((f) => f.textContent ?? ''),
        text: attr(el, 'text'),
        dxf: dxfId !== null ? (dxfs[dxfId] ?? null) : null,
        stop: attr(el, 'stopIfTrue') === '1',
        rank: numAttr(el, 'rank') ?? 10,
        percent: attr(el, 'percent') === '1',
        bottom: attr(el, 'bottom') === '1',
        below: attr(el, 'aboveAverage') === '0',
        scale: cs ? { types: kids(cs, 'cfvo').map((v) => attr(v, 'type') ?? 'min'), vals: kids(cs, 'cfvo').map((v) => attr(v, 'val')), colors: kids(cs, 'color').map((c) => colorOf(c, wb.theme) ?? 'FFFFFF') } : null,
        bar: db ? (colorOf(kid(db, 'color'), wb.theme) ?? '638EC6') : null,
      };
    });
    blocks.push({ ranges, rules });
  }
  blocks.sort((a, b) => Math.min(...a.rules.map((r) => r.priority)) - Math.min(...b.rules.map((r) => r.priority)));
  parsedBlocks.set(kept, blocks);
  return blocks;
}

/** Numbers in a block's ranges, sorted (for scales, bars, top 10, averages); cached per calculation. */
const stats = new WeakMap<Calc, Map<Block, number[]>>();

function numbersOf(block: Block, sheet: Sheet, si: number, calc: Calc): number[] {
  let byBlock = stats.get(calc);
  if (!byBlock) stats.set(calc, (byBlock = new Map()));
  let xs = byBlock.get(block);
  if (!xs) {
    xs = [];
    for (const g of block.ranges) {
      cellsIn(sheet, g, (r, c, cell) => {
        const v = cell.f !== undefined ? calc.value(si, r, c) : cell.v;
        if (typeof v === 'number') xs!.push(v);
      });
    }
    xs.sort((a, b) => a - b);
    byBlock.set(block, xs);
  }
  return xs;
}

function scalarOf(calc: Calc, si: number, f: string): Scalar {
  const v = evaluateText(calc, f, si);
  if (isRef(v)) return calc.value(v.sheet, v.r0, v.c0);
  if (isArr(v)) return v.rows[0]?.[0] ?? null;
  return v;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a, 16);
  const pb = parseInt(b, 16);
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function threshold(type: string, val: string | null, xs: number[], calc: Calc, si: number): number {
  const min = xs[0];
  const max = xs[xs.length - 1];
  switch (type) {
    case 'min':
      return min;
    case 'max':
      return max;
    case 'percent':
      return min + ((max - min) * Number(val ?? 0)) / 100;
    case 'percentile': {
      const p = Number(val ?? 50) / 100;
      const rank = p * (xs.length - 1);
      const lo = Math.floor(rank);
      return xs[lo] + (rank - lo) * ((xs[Math.ceil(rank)] ?? xs[lo]) - xs[lo]);
    }
    default: {
      const v = val !== null ? scalarOf(calc, si, val) : 0;
      return typeof v === 'number' ? v : Number(v) || 0;
    }
  }
}

/** The conditional look of one cell, if any rule applies. */
export function conditionalLook(wb: Workbook, si: number, calc: Calc, r: number, c: number, v: Scalar): CfLook | null {
  const sheet = wb.sheets[si];
  const blocks = blocksOf(sheet, wb);
  if (!blocks.length) return null;
  let look: CfLook | null = null;
  const apply = (d: Dxf | null) => {
    if (!d) return;
    look ??= {};
    for (const k of ['fill', 'color', 'bold', 'italic', 'strike'] as const) if (d[k] !== undefined && look[k] === undefined) (look as Record<string, unknown>)[k] = d[k];
  };
  for (const block of blocks) {
    const g = block.ranges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
    if (!g) continue;
    const top = block.ranges[0];
    for (const rule of block.rules) {
      let hit = false;
      const formula = (i: number) => {
        const f = rule.formulas[i];
        return f === undefined ? null : scalarOf(calc, si, translateFormula(f, r - top.r0, c - top.c0));
      };
      switch (rule.type) {
        case 'cellIs': {
          if (v === null) break;
          const a = formula(0);
          const b = formula(1);
          if (isErr(a) || isErr(v)) break;
          const d = compare(v, a);
          switch (rule.operator) {
            case 'equal': hit = d === 0; break;
            case 'notEqual': hit = d !== 0; break;
            case 'greaterThan': hit = d > 0; break;
            case 'greaterThanOrEqual': hit = d >= 0; break;
            case 'lessThan': hit = d < 0; break;
            case 'lessThanOrEqual': hit = d <= 0; break;
            case 'between': hit = d >= 0 && compare(v, b) <= 0; break;
            case 'notBetween': hit = d < 0 || compare(v, b) > 0; break;
          }
          break;
        }
        case 'expression': {
          const x = formula(0);
          hit = x === true || (typeof x === 'number' && x !== 0);
          break;
        }
        case 'containsText':
          hit = typeof v === 'string' && !!rule.text && v.toLowerCase().includes(rule.text.toLowerCase());
          break;
        case 'notContainsText':
          hit = typeof v === 'string' && !!rule.text && !v.toLowerCase().includes(rule.text.toLowerCase());
          break;
        case 'beginsWith':
          hit = typeof v === 'string' && !!rule.text && v.toLowerCase().startsWith(rule.text.toLowerCase());
          break;
        case 'endsWith':
          hit = typeof v === 'string' && !!rule.text && v.toLowerCase().endsWith(rule.text.toLowerCase());
          break;
        case 'containsBlanks':
          hit = v === null || (typeof v === 'string' && !v.trim());
          break;
        case 'notContainsBlanks':
          hit = !(v === null || (typeof v === 'string' && !v.trim()));
          break;
        case 'containsErrors':
          hit = isErr(v);
          break;
        case 'top10': {
          if (typeof v !== 'number') break;
          const xs = numbersOf(block, sheet, si, calc);
          const n = rule.percent ? Math.max(1, Math.floor((xs.length * rule.rank) / 100)) : rule.rank;
          hit = rule.bottom ? v <= xs[Math.min(n, xs.length) - 1] : v >= xs[Math.max(0, xs.length - n)];
          break;
        }
        case 'aboveAverage': {
          if (typeof v !== 'number') break;
          const xs = numbersOf(block, sheet, si, calc);
          const avg = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
          hit = rule.below ? v < avg : v > avg;
          break;
        }
        case 'colorScale': {
          if (typeof v !== 'number' || !rule.scale) break;
          const xs = numbersOf(block, sheet, si, calc);
          if (!xs.length) break;
          const s = rule.scale;
          const pts = s.types.map((t, i) => threshold(t, s.vals[i], xs, calc, si));
          let fill: string;
          if (v <= pts[0]) fill = s.colors[0];
          else if (v >= pts[pts.length - 1]) fill = s.colors[s.colors.length - 1];
          else {
            let i = 0;
            while (i < pts.length - 2 && v > pts[i + 1]) i++;
            const span = pts[i + 1] - pts[i];
            fill = mix(s.colors[i], s.colors[i + 1], span ? (v - pts[i]) / span : 0);
          }
          look ??= {};
          look.fill ??= fill;
          break;
        }
        case 'dataBar': {
          if (typeof v !== 'number' || !rule.bar) break;
          const xs = numbersOf(block, sheet, si, calc);
          if (!xs.length) break;
          const min = Math.min(0, xs[0]);
          const max = xs[xs.length - 1];
          look ??= {};
          look.bar ??= { frac: max > min ? Math.max(0.1, (v - min) / (max - min)) : 1, color: rule.bar };
          break;
        }
      }
      if (hit) {
        apply(rule.dxf);
        if (rule.stop) return look;
      }
    }
  }
  return look;
}
