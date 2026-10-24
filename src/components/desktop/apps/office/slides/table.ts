import { attr, kid, kids, numAttr } from '../ooxml';
import type { Color, Fill, FrameShape, Line, ListStyle, SlideCtx, TableStylePart } from './model';
import { fragment, parseColor } from './read';
import type { TextStyleChain } from './resolve';

/**
 * How a table cell looks: its table style's parts (whole table, banded
 * rows, header row...) layered in PowerPoint's order, then the cell's own
 * a:tcPr on top.
 */

export interface CellLook {
  fill?: Fill;
  borders: Partial<Record<'l' | 'r' | 't' | 'b', Line | null>>;
  /** marL, marT, marR, marB in EMU. */
  margins: [number, number, number, number];
  anchor?: string;
  chain: TextStyleChain;
}

interface TcPr {
  fill?: Fill;
  borders: Partial<Record<'l' | 'r' | 't' | 'b', Line | null>>;
  margins: [number, number, number, number];
  anchor?: string;
}

const tcPrCache = new Map<string, TcPr>();

function parseTcPr(xml: string): TcPr {
  const hit = tcPrCache.get(xml);
  if (hit) return hit;
  const look: TcPr = { borders: {}, margins: [91440, 45720, 91440, 45720] };
  if (xml) {
    const el = fragment(xml);
    look.margins = [numAttr(el, 'marL') ?? 91440, numAttr(el, 'marT') ?? 45720, numAttr(el, 'marR') ?? 91440, numAttr(el, 'marB') ?? 45720];
    const anchor = attr(el, 'anchor');
    if (anchor) look.anchor = anchor;
    for (const c of kids(el)) {
      const side = ({ lnL: 'l', lnR: 'r', lnT: 't', lnB: 'b' } as const)[c.localName as 'lnL'];
      if (side) {
        const color = parseColor(kid(c, 'solidFill')?.firstElementChild);
        look.borders[side] = kid(c, 'noFill') ? null : { w: numAttr(c, 'w') ?? 12700, fill: color ? { type: 'solid', color } : { type: 'none' }, dash: attr(kid(c, 'prstDash'), 'val') ?? undefined };
      } else if (c.localName === 'solidFill') {
        const color = parseColor(c.firstElementChild);
        if (color) look.fill = { type: 'solid', color };
      } else if (c.localName === 'noFill') look.fill = { type: 'none' };
      else if (c.localName === 'gradFill') {
        const color = parseColor(kids(kid(c, 'gsLst'), 'gs')[0]?.firstElementChild);
        if (color) look.fill = { type: 'solid', color };
      }
    }
  }
  if (tcPrCache.size > 2000) tcPrCache.clear();
  tcPrCache.set(xml, look);
  return look;
}

const flagCache = new Map<string, { flags: Record<string, boolean>; styleId: string | null; fill?: Fill }>();

export function tableFlags(xml: string): { flags: Record<string, boolean>; styleId: string | null; fill?: Fill } {
  const hit = flagCache.get(xml);
  if (hit) return hit;
  const el = fragment(xml);
  const flags: Record<string, boolean> = {};
  for (const k of ['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol']) flags[k] = attr(el, k) === '1' || attr(el, k) === 'true';
  const color = parseColor(kid(el, 'solidFill')?.firstElementChild);
  const out = { flags, styleId: kid(el, 'tableStyleId')?.textContent?.trim() ?? null, ...(color ? { fill: { type: 'solid' as const, color } } : {}) };
  flagCache.set(xml, out);
  return out;
}

export function cellLook(frame: FrameShape, r: number, c: number, ctx: SlideCtx): CellLook {
  const table = frame.table!;
  const cell = table.rows[r].cells[c];
  const { flags, styleId, fill: tblFill } = tableFlags(table.tblPr);
  const style = styleId ? ctx.deck.tableStyles[styleId] : undefined;
  const nRows = table.rows.length;
  const nCols = table.cols.length;
  const parts: TableStylePart[] = [];
  if (style) {
    const p = style.parts;
    const bodyRow = r - (flags.firstRow ? 1 : 0);
    const bodyCol = c - (flags.firstCol ? 1 : 0);
    const list = [
      p.wholeTbl,
      flags.bandCol && bodyCol >= 0 ? (bodyCol % 2 === 0 ? p.band1V : p.band2V) : undefined,
      flags.bandRow && bodyRow >= 0 ? (bodyRow % 2 === 0 ? p.band1H : p.band2H) : undefined,
      flags.firstCol && c === 0 ? p.firstCol : undefined,
      flags.lastCol && c === nCols - 1 ? p.lastCol : undefined,
      flags.lastRow && r === nRows - 1 ? p.lastRow : undefined,
      flags.firstRow && r === 0 ? p.firstRow : undefined,
    ];
    for (const q of list) if (q) parts.push(q);
  }
  const own = parseTcPr(cell.tcPr);
  let fill = tblFill;
  const borders: CellLook['borders'] = {};
  let bold: boolean | undefined;
  let color: Color | undefined;
  const outer = { l: c === 0, r: c + (cell.gridSpan ?? 1) >= nCols, t: r === 0, b: r + (cell.rowSpan ?? 1) >= nRows };
  for (const p of parts) {
    if (p.fill) fill = p.fill;
    if (p.b) bold = true;
    if (p.color) color = p.color;
    const bd = p.borders;
    if (bd.left && outer.l) borders.l = bd.left;
    if (bd.right && outer.r) borders.r = bd.right;
    if (bd.top && outer.t) borders.t = bd.top;
    if (bd.bottom && outer.b) borders.b = bd.bottom;
    if (bd.insideV && !outer.l) borders.l = bd.insideV;
    if (bd.insideV && !outer.r) borders.r = bd.insideV;
    if (bd.insideH && !outer.t) borders.t = bd.insideH;
    if (bd.insideH && !outer.b) borders.b = bd.insideH;
  }
  if (own.fill) fill = own.fill;
  Object.assign(borders, own.borders);
  const synth: ListStyle | null = bold || color ? { levels: Array.from({ length: 9 }, () => ({ defRPr: { ...(bold ? { b: true } : {}), ...(color ? { color } : {}) } })) } : null;
  const chain: TextStyleChain = {
    lists: [...(cell.text.lst ? [cell.text.lst] : []), ...(synth ? [synth] : []), ctx.master.other, ctx.deck.defaultText],
    body: { lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: own.anchor ?? 't', wrap: 'square' },
    own: (cell.text.lst ? 1 : 0) + (synth ? 1 : 0),
    isTitle: false,
  };
  return { fill, borders, margins: own.margins, anchor: own.anchor, chain };
}
