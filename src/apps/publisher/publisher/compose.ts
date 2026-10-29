import type { Rect } from './geom';
import { charLook, cssFont, formatNumber, paraLook, textChain, webFont, type CharLook, type ParaLook, type Styles } from './styles';
import { flatten, INDENT_HERE, NEXT_PAGE_NUMBER, OBJECT, PAGE_NUMBER, RIGHT_INDENT_TAB, type Flat } from './text';

/**
 * Publisher's composer: sets a story's paragraphs into the columns of its
 * threaded frames, one line at a time (a greedy single-line composer, where
 * InDesign uses its paragraph composer, so a line here and there may break
 * differently). Handles styles and local formatting, indents, space
 * before/after, tabs, forced line breaks, alignment and justification,
 * leading, first baseline offsets, vertical justification, bullets and
 * numbers, paragraph rules, drop caps, text wrap around bounding boxes and
 * overset text.
 */

export interface FrameSpec {
  self: string;
  /** The text area in the frame's own coordinates (inside the insets). */
  area: Rect;
  columns: number;
  gutter: number;
  fixedWidth: number | null;
  vj: string;
  firstBaseline: string;
  minFirstBaseline: number;
  /** Page name, for page number markers. */
  page: string;
  nextPage: string;
  /** Areas text wraps around, in the frame's coordinates. */
  wraps: { rect: Rect; mode: string }[];
}

export interface Look {
  font: string;
  size: number;
  fill: string | null;
  fillTint: number;
  stroke: string | null;
  strokeTint: number;
  strokeWeight: number;
  hscale: number;
  vscale: number;
  /** Baseline shift (up is positive), super/subscript included. */
  shift: number;
  tracking: number;
  underline: boolean;
  strike: boolean;
  skew: number;
}

export interface TableCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text area offset inside the cell. */
  tx: number;
  ty: number;
  comp: Composition;
  fill: string | null;
  fillTint: number;
  edges: { weight: number; color: string | null; tint: number }[];
}

/** A table set into a story: it takes a line of its own. */
export interface TableLayout {
  w: number;
  h: number;
  cells: TableCell[];
}

export interface Piece {
  x: number;
  w: number;
  table?: TableLayout;
  /** What's drawn. */
  text: string;
  start: number;
  end: number;
  look: Look;
  space: boolean;
}

export interface Line {
  frame: number;
  col: number;
  /** Left edge and width of the line's slot. */
  x: number;
  width: number;
  y: number;
  ascent: number;
  descent: number;
  leading: number;
  start: number;
  end: number;
  pieces: Piece[];
  para: number;
  /** Paragraph decorations drawn with the line. */
  ruleAbove?: { x0: number; x1: number; y: number; weight: number; color: string | null; tint: number };
  ruleBelow?: { x0: number; x1: number; y: number; weight: number; color: string | null; tint: number };
  shading?: { x0: number; x1: number; y0: number; y1: number; color: string | null; tint: number };
}

export interface Composition {
  flat: Flat;
  lines: Line[];
  /** Lines per frame. */
  byFrame: Line[][];
  /** Column rects per frame. */
  columns: Rect[][];
  overset: boolean;
  /** Where the set text ends (the rest is overset). */
  setEnd: number;
  fonts: Set<string>;
}

// ---- Measuring ----------------------------------------------------------------------

let mctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();
const metrics = new Map<string, { ascent: number; cap: number; x: number; descent: number; em: number }>();

function measurer(): CanvasRenderingContext2D {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d')!;
  return mctx;
}

export function resetMeasures() {
  widths.clear();
  metrics.clear();
}

/** Width of text at 1pt, cached per font. */
function width100(font100: string, text: string): number {
  const key = `${font100}\u0000${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    const c = measurer();
    if (c.font !== font100) c.font = font100;
    w = c.measureText(text).width / 100;
    if (widths.size > 200_000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

export function fontMetrics(font100: string) {
  let m = metrics.get(font100);
  if (!m) {
    const c = measurer();
    c.font = font100;
    const d = c.measureText('dhlb');
    const h = c.measureText('HIEF');
    const x = c.measureText('xzvw');
    const g = c.measureText('gjpqy');
    m = {
      ascent: (d.actualBoundingBoxAscent || 72) / 100,
      cap: (h.actualBoundingBoxAscent || 70) / 100,
      x: (x.actualBoundingBoxAscent || 50) / 100,
      descent: (g.actualBoundingBoxDescent || 22) / 100,
      em: (d.fontBoundingBoxAscent || 88) / 100,
    };
    metrics.set(font100, m);
  }
  return m;
}

export function measure(look: Look, text: string): number {
  if (!text) return 0;
  return width100(look.font, text) * look.size * look.hscale + look.tracking * look.size * [...text].length;
}

// ---- Looks ------------------------------------------------------------------------------

interface CharInfo {
  look: Look;
  small: Look | null;
  caps: CharLook['caps'];
  leading: number;
  ascent: number;
  descent: number;
  cap: number;
  xh: number;
  noBreak: boolean;
}

function lookOf(c: CharLook, superscript: number, superPos: number): { look: Look; small: Look | null; ascent: number; descent: number; cap: number; xh: number } {
  const wf = webFont(c.font, c.fontStyle);
  let size = c.size;
  let shift = c.baselineShift;
  if (c.position === 'Superscript' || c.position === 'OTSuperscript') {
    shift += size * superPos;
    size *= superscript;
  } else if (c.position === 'Subscript' || c.position === 'OTSubscript') {
    shift -= size * superPos;
    size *= superscript;
  }
  const font = cssFont(wf, 100);
  const fm = fontMetrics(font);
  const look: Look = {
    font,
    size,
    fill: c.fill,
    fillTint: c.fillTint,
    stroke: c.stroke,
    strokeTint: c.strokeTint,
    strokeWeight: c.strokeWeight,
    hscale: (c.hscale / 100) * wf.width,
    vscale: c.vscale / 100,
    shift,
    tracking: c.tracking / 1000,
    underline: c.underline,
    strike: c.strike,
    skew: c.skew,
  };
  const small = c.caps === 'SmallCaps' || c.caps === 'CapToSmallCap' ? { ...look, size: size * 0.7 } : null;
  return { look, small, ascent: fm.ascent * c.size, descent: fm.descent * c.size, cap: fm.cap * c.size, xh: fm.x * c.size };
}

// ---- Atoms --------------------------------------------------------------------------------

type AtomKind = 'word' | 'space' | 'tab' | 'rtab' | 'forced' | 'end' | 'zero' | 'here' | 'table';

interface Atom {
  kind: AtomKind;
  start: number;
  end: number;
  text: string;
  look: Look;
  w: number;
  info: CharInfo;
  /** A break may follow (after a space or hyphen). */
  breakAfter: boolean;
  table?: TableLayout;
}

const SPACE = /[ \u00a0\u2000-\u200a\u3000]/;
/** Characters that take no room: controls, soft hyphens, zero-width spaces and joiners, BOM. */
const isZero = (ch: string) => {
  const c = ch.charCodeAt(0);
  return (c < 0x20 && c !== 9 && c !== 13 && c !== 8 && c !== 7) || c === 0xad || (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff;
};

function display(ch: string, info: CharInfo, pageName: string, nextPage: string): string {
  if (ch === PAGE_NUMBER) return pageName;
  if (ch === NEXT_PAGE_NUMBER) return nextPage;
  if (info.caps === 'AllCaps' || info.caps === 'CapToSmallCap') {
    const u = ch.toUpperCase();
    return u.length === 1 ? u : ch;
  }
  return ch;
}

// ---- Composing ----------------------------------------------------------------------------

interface Slot {
  x: number;
  width: number;
}

interface Column {
  frame: number;
  col: number;
  rect: Rect;
}

type TextPrefs = { superSize: number; superPos: number; smallCap: number };

export function compose(story: Element, styles: Styles, frames: FrameSpec[], prefs: TextPrefs, depth = 0): Composition {
  const flat = flatten(story);
  const fonts = new Set<string>();
  const lines: Line[] = [];
  const byFrame: Line[][] = frames.map(() => []);
  const columns: Rect[][] = frames.map((f) => {
    const n = Math.max(1, f.columns);
    const cw = f.fixedWidth ?? (f.area.w - f.gutter * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({ x: f.area.x + i * (cw + f.gutter), y: f.area.y, w: Math.max(1, cw), h: Math.max(0, f.area.h) }));
  });
  const cols: Column[] = [];
  frames.forEach((_, fi) => columns[fi].forEach((rect, ci) => cols.push({ frame: fi, col: ci, rect })));

  // Character looks, per segment.
  const segInfo = new Map<Element | null, Map<Element | null, CharInfo>>();
  const infoFor = (csr: Element | null, psr: Element | null): CharInfo => {
    let byPsr = segInfo.get(csr);
    if (!byPsr) {
      byPsr = new Map();
      segInfo.set(csr, byPsr);
    }
    let ci = byPsr.get(psr);
    if (!ci) {
      const c = charLook(textChain(styles, csr, psr));
      const l = lookOf(c, prefs.superSize, prefs.superPos);
      if (l.small) l.small.size = c.size * prefs.smallCap;
      fonts.add(l.look.font);
      ci = {
        look: l.look,
        small: l.small,
        caps: c.caps,
        leading: c.leading ?? (c.size * c.autoLeading) / 100,
        ascent: l.ascent,
        descent: l.descent,
        cap: l.cap,
        xh: l.xh,
        noBreak: c.noBreak,
      };
      byPsr.set(psr, ci);
    }
    return ci;
  };
  const charInfo: CharInfo[] = new Array(flat.text.length);
  for (const s of flat.segs) {
    const ci = infoFor(s.csr, s.psr);
    for (let i = s.start; i < s.start + s.len; i++) charInfo[i] = ci;
  }
  const objText = new Map<number, string>();
  const tables = new Map<number, Element>();
  for (const s of flat.segs) {
    if (s.kind !== 'obj') continue;
    const e = s.node as Element;
    if (e.localName === 'TextVariableInstance') objText.set(s.start, e.getAttribute('ResultText') ?? '');
    else if (e.localName === 'Table') tables.set(s.start, e);
  }

  let ci = 0;
  let baseline = 0;
  let first = true;
  let prevAfter = 0;
  let prevStyle: string | null = null;
  let guard = 0;
  let overset = false;
  let setEnd = flat.text.length;
  const numbering = new Map<string, number>();
  const pageName = frames[0]?.page ?? '1';
  const nextPage = frames[0]?.nextPage ?? '2';

  const fallbackInfo = (): CharInfo => infoFor(null, flat.paras[0]?.psr ?? null);

  const nextColumn = () => {
    ci++;
    first = true;
    prevAfter = 0;
    return ci < cols.length;
  };

  outer: for (let pi = 0; pi < flat.paras.length; pi++) {
    const para = flat.paras[pi];
    const pinfo0 = charInfo[para.start] ?? (para.start > 0 ? charInfo[para.start - 1] : undefined) ?? fallbackInfo();
    const pl: ParaLook = paraLook(textChain(styles, null, para.psr), pinfo0.look.fill);
    if (pl.startParagraph === 'NextColumn' || pl.startParagraph === 'NextFrame' || pl.startParagraph === 'NextPage' || pl.startParagraph === 'NextOddPage' || pl.startParagraph === 'NextEvenPage') {
      if (!first && ci < cols.length) {
        const want = pl.startParagraph === 'NextColumn' ? 'col' : 'frame';
        const startFrame = cols[ci].frame;
        if (!nextColumn()) {
          overset = true;
          setEnd = para.start;
          break;
        }
        while (want === 'frame' && ci < cols.length && cols[ci].frame === startFrame) ci++;
        if (ci >= cols.length) {
          overset = true;
          setEnd = para.start;
          break;
        }
      }
    }

    // The paragraph's atoms.
    const atoms: Atom[] = [];
    let prefix = '';
    if (pl.list === 'BulletList') prefix = pl.bullet + pl.bulletAfter;
    else if (pl.list === 'NumberedList') {
      const key = pl.style;
      const n = pl.numberContinue && numbering.has(key) ? numbering.get(key)! + 1 : pl.numberStart;
      numbering.set(key, n);
      prefix = pl.numberExpr.replace(/\^#/g, formatNumber(n, pl.numberFormat)).replace(/\^t/g, '\t').replace(/\^\./g, '');
    }
    if (prefix) {
      const info = pinfo0;
      for (const part of prefix.split(/(\t)/)) {
        if (!part) continue;
        atoms.push({ kind: part === '\t' ? 'tab' : 'word', start: para.start, end: para.start, text: part === '\t' ? '' : part, look: info.look, w: part === '\t' ? 0 : measure(info.look, part), info, breakAfter: false });
      }
    }
    let i = para.start;
    const end = para.end;
    while (i < end) {
      const ch = flat.text[i];
      const info = charInfo[i] ?? pinfo0;
      if (ch === '\r') {
        atoms.push({ kind: 'end', start: i, end: i + 1, text: '', look: info.look, w: 0, info, breakAfter: true });
        i++;
        continue;
      }
      if (ch === '\u2028') {
        atoms.push({ kind: 'forced', start: i, end: i + 1, text: '', look: info.look, w: 0, info, breakAfter: true });
        i++;
        continue;
      }
      if (ch === '\t' || ch === RIGHT_INDENT_TAB) {
        atoms.push({ kind: ch === '\t' ? 'tab' : 'rtab', start: i, end: i + 1, text: '', look: info.look, w: 0, info, breakAfter: false });
        i++;
        continue;
      }
      if (ch === INDENT_HERE) {
        atoms.push({ kind: 'here', start: i, end: i + 1, text: '', look: info.look, w: 0, info, breakAfter: false });
        i++;
        continue;
      }
      if (ch === OBJECT && tables.has(i)) {
        const tl = layoutTable(tables.get(i)!, styles, prefs, depth);
        for (const cell of tl.cells) for (const f of cell.comp.fonts) fonts.add(f);
        atoms.push({ kind: 'table', start: i, end: i + 1, text: '', look: info.look, w: tl.w, info, breakAfter: true, table: tl });
        i++;
        continue;
      }
      if (ch === OBJECT) {
        const t = objText.get(i) ?? '';
        atoms.push({ kind: t ? 'word' : 'zero', start: i, end: i + 1, text: t, look: info.look, w: t ? measure(info.look, t) : 0, info, breakAfter: false });
        i++;
        continue;
      }
      if (isZero(ch) && ch !== PAGE_NUMBER && ch !== NEXT_PAGE_NUMBER) {
        atoms.push({ kind: 'zero', start: i, end: i + 1, text: '', look: info.look, w: 0, info, breakAfter: ch === '\u200b' });
        i++;
        continue;
      }
      const space = SPACE.test(ch);
      // A run of one kind (word or space) with one look.
      let j = i + 1;
      while (j < end) {
        const c2 = flat.text[j];
        if ((charInfo[j] ?? pinfo0) !== info) break;
        if (c2 === '\r' || c2 === '\u2028' || c2 === '\t' || c2 === RIGHT_INDENT_TAB || c2 === INDENT_HERE || c2 === OBJECT || (isZero(c2) && c2 !== PAGE_NUMBER && c2 !== NEXT_PAGE_NUMBER)) break;
        if (SPACE.test(c2) !== space) break;
        if (c2 === PAGE_NUMBER || c2 === NEXT_PAGE_NUMBER || ch === PAGE_NUMBER || ch === NEXT_PAGE_NUMBER) break;
        // Breaks after hyphens and dashes inside words.
        if (!space && /[-–—/]/.test(flat.text[j - 1]) && !info.noBreak) break;
        j++;
      }
      const raw = flat.text.slice(i, j);
      if (space) {
        const sp = ch === '\u00a0' || info.noBreak;
        atoms.push({ kind: 'space', start: i, end: j, text: raw.replace(/[\u00a0\u2000-\u200a\u3000]/g, ' '), look: info.look, w: measure(info.look, raw.replace(/[\u2000-\u200a\u3000\u00a0]/g, ' ')), info, breakAfter: !sp });
      } else {
        // Small caps: lower case letters drawn as smaller capitals, in their own pieces.
        let text = '';
        for (const c of raw) text += display(c, info, pageName, nextPage);
        if (info.small) {
          let k = 0;
          const src = [...raw];
          while (k < src.length) {
            const lower = src[k] !== src[k].toUpperCase();
            let m = k + 1;
            while (m < src.length && (src[m] !== src[m].toUpperCase()) === lower) m++;
            const part = src.slice(k, m).join('');
            const t = lower ? part.toUpperCase() : part;
            const look = lower ? info.small : info.look;
            atoms.push({ kind: 'word', start: i + k, end: i + m, text: t, look, w: measure(look, t), info, breakAfter: false });
            k = m;
          }
          atoms[atoms.length - 1].breakAfter = /[-–—/]$/.test(raw) && !info.noBreak;
        } else {
          atoms.push({ kind: 'word', start: i, end: j, text, look: info.look, w: measure(info.look, text), info, breakAfter: /[-–—/]$/.test(raw) && !info.noBreak });
        }
      }
      i = j;
    }
    if (!atoms.length || atoms[atoms.length - 1].kind !== 'end') {
      // The story's last paragraph has no break; give it an end so empty paragraphs still take a line.
      atoms.push({ kind: 'end', start: end, end: end, text: '', look: pinfo0.look, w: 0, info: pinfo0, breakAfter: true });
    }

    // Drop cap: the first characters span several lines; those lines are indented past them.
    let drop: { atoms: Atom[]; width: number; lines: number; look: Look } | null = null;
    if (pl.dropChars > 0 && pl.dropLines > 1) {
      const firstWord = atoms.find((a) => a.kind === 'word' && a.start >= para.start);
      if (firstWord) {
        const n = Math.min(pl.dropChars, firstWord.end - firstWord.start);
        const lead = pinfo0.leading;
        const capH = pinfo0.cap || pinfo0.look.size * 0.7;
        const k = (capH + lead * (pl.dropLines - 1)) / (capH || 1);
        const look = { ...firstWord.look, size: firstWord.look.size * k };
        const t = firstWord.text.slice(0, n);
        drop = { atoms: [], width: measure(look, t) + pinfo0.look.size * 0.1, lines: pl.dropLines, look };
        const idx = atoms.indexOf(firstWord);
        const dropAtom: Atom = { ...firstWord, end: firstWord.start + n, text: t, look, w: measure(look, t) };
        const rest: Atom = { ...firstWord, start: firstWord.start + n, text: firstWord.text.slice(n), w: measure(firstWord.look, firstWord.text.slice(n)) };
        atoms.splice(idx, 1, ...(rest.text ? [rest] : []));
        drop.atoms.push(dropAtom);
      }
    }

    let ai = 0;
    let lineInPara = 0;
    while (ai < atoms.length) {
      // A guard against layouts that can't move on (zero leading and the like).
      if (++guard > 400_000) {
        overset = true;
        setEnd = atoms[ai].start;
        break outer;
      }
      if (ci >= cols.length) {
        overset = true;
        setEnd = atoms[ai].start;
        break outer;
      }
      const col = cols[ci];
      const r = col.rect;
      const frame = frames[col.frame];
      // Metrics of what's coming, to place the line before it's filled.
      let estLead = 0;
      let estAsc = 0;
      let estCap = 0;
      let estX = 0;
      let estDesc = 0;
      for (let k = ai; k < atoms.length && k < ai + 12; k++) {
        const tb = atoms[k].table;
        if (tb && k === ai) {
          estLead = Math.max(estLead, tb.h);
          estAsc = Math.max(estAsc, tb.h);
          estCap = Math.max(estCap, tb.h);
          estX = Math.max(estX, tb.h);
          break;
        }
        const inf = atoms[k].info;
        estLead = Math.max(estLead, inf.leading);
        estAsc = Math.max(estAsc, inf.ascent);
        estCap = Math.max(estCap, inf.cap);
        estX = Math.max(estX, inf.xh);
        estDesc = Math.max(estDesc, inf.descent);
        if (atoms[k].kind === 'end' || atoms[k].kind === 'forced') break;
      }
      estLead = Math.max(estLead, 0.5);
      let y: number;
      if (first) {
        const fb = frame.firstBaseline;
        const off = fb === 'CapHeight' ? estCap : fb === 'XHeight' ? estX : fb === 'LeadingOffset' ? estLead : fb === 'EmBoxHeight' ? estAsc * 1.2 : fb === 'FixedHeight' ? frame.minFirstBaseline : estAsc;
        y = r.y + Math.max(off, frame.minFirstBaseline);
      } else {
        const gap = pl.sameStyleSpacing !== null && prevStyle === pl.style ? pl.sameStyleSpacing : Math.max(0, pl.spaceBefore) + prevAfter;
        y = baseline + estLead + (lineInPara === 0 ? gap : 0);
      }
      // A column's first line may hang below a frame too short for its leading, as InDesign lets it.
      if (first ? y - estAsc > r.y + r.h + 0.5 || (r.h <= 0 && ci < cols.length - 1) : y + estDesc * 0.25 > r.y + r.h + 0.5) {
        if (!nextColumn()) {
          overset = true;
          setEnd = atoms[ai].start;
          break outer;
        }
        continue;
      }
      // Where the line can go: the column, less indents and anything it wraps around.
      const firstLine = lineInPara === 0;
      let left = r.x + pl.leftIndent + (firstLine ? pl.firstIndent : 0);
      const right = r.x + r.w - pl.rightIndent;
      if (drop && lineInPara < drop.lines) left = Math.max(left, r.x + pl.leftIndent + drop.width);
      // A line's band reaches up to its leading, but not above the top of its column.
      const slots = wrapSlots(frame.wraps, left, right, Math.max(r.y, y - estLead * 0.8), y + estDesc);
      if (slots === 'jump') {
        baseline = first ? y : Math.max(y, baseline + 1);
        first = false;
        continue;
      }
      if (!slots.length) {
        // Nothing fits on this band; try further down.
        baseline = first ? y : Math.max(y, baseline + 1);
        first = false;
        if (y > r.y + r.h) {
          if (!nextColumn()) {
            overset = true;
            setEnd = atoms[ai].start;
            break outer;
          }
        }
        continue;
      }
      const lineFrom = ai;
      let lineLead = 0;
      let lineAsc = 0;
      let lineDesc = 0;
      let lastLine = false;
      const made: Line[] = [];
      for (const slot of slots) {
        if (ai >= atoms.length) break;
        // Beside a wrapped object, a sliver too narrow for the next word stays empty.
        if (slots.length > 1) {
          let word = 0;
          for (let k = ai; k < atoms.length && k < ai + 64; k++) {
            word += atoms[k].w;
            if (atoms[k].breakAfter || atoms[k].kind === 'end' || atoms[k].kind === 'forced') break;
          }
          if (word > slot.width) continue;
        }
        const res = fillLine(atoms, ai, slot, r.x, pl);
        const line: Line = {
          frame: col.frame,
          col: col.col,
          x: slot.x,
          width: slot.width,
          y,
          ascent: res.ascent,
          descent: res.descent,
          leading: res.leading,
          start: res.start,
          end: res.end,
          pieces: res.pieces,
          para: pi,
        };
        lineLead = Math.max(lineLead, res.leading);
        lineAsc = Math.max(lineAsc, res.ascent);
        lineDesc = Math.max(lineDesc, res.descent);
        made.push(line);
        ai = res.next;
        if (res.ended) {
          lastLine = true;
          break;
        }
        if (res.forced) break;
      }
      if (!made.length) {
        baseline = first ? y : Math.max(y, baseline + 1);
        first = false;
        if (y > r.y + r.h && !nextColumn()) {
          overset = true;
          setEnd = atoms[ai].start;
          break outer;
        }
        continue;
      }
      // Leading is set by the tallest thing on the line; recheck the fit with it.
      if (!first && lineLead > estLead + 0.01) {
        const dy = lineLead - estLead;
        for (const l of made) l.y += dy;
        y += dy;
      } else if (first && frame.firstBaseline === 'AscentOffset' && lineAsc > estAsc + 0.01) {
        const dy = Math.max(lineAsc, frame.minFirstBaseline) - Math.max(estAsc, frame.minFirstBaseline);
        for (const l of made) l.y += dy;
        y += dy;
      }
      if (y + lineDesc * 0.25 > r.y + r.h + 0.5 && !first) {
        // Didn't fit after all: put the atoms back and go on in the next column.
        ai = lineFrom;
        if (!nextColumn()) {
          overset = true;
          setEnd = made[0].start;
          break outer;
        }
        continue;
      }
      if (drop && lineInPara === 0) {
        const d = drop.atoms[0];
        made[0].pieces.unshift({ x: r.x + pl.leftIndent, w: d.w, text: d.text, start: d.start, end: d.end, look: d.look, space: false });
        made[0].start = d.start;
      }
      if (lineInPara === 0 && pl.ruleAbove.on) {
        const rr = pl.ruleAbove;
        const x0 = r.x + pl.leftIndent + rr.left;
        const x1 = rr.width === 'TextWidth' ? made[0].x + lineWidth(made[0]) : r.x + r.w - pl.rightIndent - rr.right;
        made[0].ruleAbove = { x0, x1: rr.width === 'TextWidth' ? x0 + lineWidth(made[0]) : x1, y: y - lineAsc - rr.offset - rr.weight / 2, weight: rr.weight, color: rr.color, tint: rr.tint };
      }
      if (lastLine && pl.ruleBelow.on) {
        const rr = pl.ruleBelow;
        const l0 = made[made.length - 1];
        const x0 = r.x + pl.leftIndent + rr.left;
        const x1 = rr.width === 'TextWidth' ? l0.x + lineWidth(l0) : r.x + r.w - pl.rightIndent - rr.right;
        l0.ruleBelow = { x0: rr.width === 'TextWidth' ? l0.x : x0, x1, y: y + rr.offset + rr.weight / 2, weight: rr.weight, color: rr.color, tint: rr.tint };
      }
      if (pl.shading.on) {
        for (const l of made) l.shading = { x0: r.x + pl.leftIndent, x1: r.x + r.w - pl.rightIndent, y0: y - lineLead + lineDesc, y1: y + lineDesc, color: pl.shading.color, tint: pl.shading.tint };
      }
      for (const l of made) {
        lines.push(l);
        byFrame[l.frame].push(l);
      }
      baseline = y;
      first = false;
      lineInPara++;
    }
    prevAfter = Math.max(0, pl.spaceAfter);
    prevStyle = pl.style;
  }

  // Vertical justification, per column.
  for (let fi = 0; fi < frames.length; fi++) {
    const vj = frames[fi].vj;
    if (vj === 'TopAlign') continue;
    for (let c = 0; c < columns[fi].length; c++) {
      const ls = byFrame[fi].filter((l) => l.col === c);
      if (!ls.length) continue;
      const r = columns[fi][c];
      const top = ls[0].y - ls[0].ascent;
      const last = ls[ls.length - 1];
      const bottom = last.y + last.descent;
      const free = r.y + r.h - bottom - (top - r.y);
      // Taller than the frame: keep the top.
      if (free <= 0 && vj !== 'JustifyAlign') continue;
      if (vj === 'CenterAlign') for (const l of ls) shiftLine(l, free / 2);
      else if (vj === 'BottomAlign') for (const l of ls) shiftLine(l, r.y + r.h - bottom);
      else if (vj === 'JustifyAlign' && ls.length > 1) {
        const extra = (r.y + r.h - bottom) / (ls.length - 1);
        if (extra > 0) ls.forEach((l, k) => shiftLine(l, extra * k));
      }
    }
  }
  // Only an empty last paragraph left over isn't worth the overset marker.
  if (overset && setEnd >= flat.text.length) overset = false;
  return { flat, lines, byFrame, columns, overset, setEnd: overset ? setEnd : flat.text.length, fonts };
}

function shiftLine(l: Line, dy: number) {
  l.y += dy;
  if (l.ruleAbove) l.ruleAbove.y += dy;
  if (l.ruleBelow) l.ruleBelow.y += dy;
  if (l.shading) {
    l.shading.y0 += dy;
    l.shading.y1 += dy;
  }
}

const lineWidth = (l: Line) => {
  const ps = l.pieces.filter((p) => !p.space);
  if (!ps.length) return 0;
  return ps[ps.length - 1].x + ps[ps.length - 1].w - l.x;
};

/** The free horizontal stretches of a band after text wrap; 'jump' when an object makes text skip it. */
function wrapSlots(wraps: FrameSpec['wraps'], left: number, right: number, top: number, bottom: number): Slot[] | 'jump' {
  let slots: { a: number; b: number }[] = [{ a: left, b: right }];
  for (const w of wraps) {
    const r = w.rect;
    if (r.y >= bottom || r.y + r.h <= top || r.x >= right || r.x + r.w <= left) continue;
    if (w.mode === 'JumpObjectTextWrap') return 'jump';
    const next: { a: number; b: number }[] = [];
    for (const s of slots) {
      if (r.x + r.w <= s.a || r.x >= s.b) next.push(s);
      else {
        if (r.x > s.a) next.push({ a: s.a, b: r.x });
        if (r.x + r.w < s.b) next.push({ a: r.x + r.w, b: s.b });
      }
    }
    slots = next;
  }
  return slots.filter((s) => s.b - s.a >= 12).map((s) => ({ x: s.a, width: s.b - s.a }));
}

interface FillResult {
  pieces: Piece[];
  next: number;
  start: number;
  end: number;
  ended: boolean;
  forced: boolean;
  ascent: number;
  descent: number;
  leading: number;
}

const DEFAULT_TAB = 36;

function fillLine(atoms: Atom[], from: number, slot: Slot, colX: number, pl: ParaLook): FillResult {
  const pieces: Piece[] = [];
  let x = 0;
  let k = from;
  let lastBreak = -1;
  let lastBreakPieces = 0;
  let ended = false;
  let forced = false;
  const W = slot.width;
  // Text before an "indent to here" sets where later lines start; kept simple: this line only.
  while (k < atoms.length) {
    const a = atoms[k];
    if (a.kind === 'end') {
      pieces.push({ x, w: 0, text: '', start: a.start, end: a.end, look: a.look, space: true });
      k++;
      ended = true;
      break;
    }
    if (a.kind === 'forced') {
      pieces.push({ x, w: 0, text: '', start: a.start, end: a.end, look: a.look, space: true });
      k++;
      forced = true;
      break;
    }
    if (a.kind === 'table') {
      // A table starts a line of its own and ends it.
      if (pieces.some((p) => !p.space || p.w > 0)) break;
      pieces.push({ x: 0, w: a.w, text: '', start: a.start, end: a.end, look: a.look, space: false, table: a.table });
      k++;
      forced = true;
      break;
    }
    if (a.kind === 'zero' || a.kind === 'here') {
      pieces.push({ x, w: 0, text: '', start: a.start, end: a.end, look: a.look, space: true });
      if (a.breakAfter) {
        lastBreak = k + 1;
        lastBreakPieces = pieces.length;
      }
      k++;
      continue;
    }
    if (a.kind === 'tab' || a.kind === 'rtab') {
      // Tab stops count from the column's left edge.
      const abs = slot.x + x - colX;
      const stop = pl.tabs.find((t) => t.position > abs + 0.01);
      let target: number;
      let align: string = 'LeftAlign';
      if (a.kind === 'rtab') {
        target = W;
        align = 'RightAlign';
      } else if (stop) {
        target = stop.position - (slot.x - colX);
        align = stop.alignment;
      } else {
        const last = pl.tabs.length ? pl.tabs[pl.tabs.length - 1].position : 0;
        const base = Math.max(last, 0);
        const n = Math.floor((abs - base) / DEFAULT_TAB) + 1;
        target = base + n * DEFAULT_TAB - (slot.x - colX);
      }
      let w = target - x;
      if (align === 'RightAlign' || align === 'CenterAlign' || align === 'CharacterAlign') {
        let follow = 0;
        for (let m = k + 1; m < atoms.length; m++) {
          const b = atoms[m];
          if (b.kind === 'tab' || b.kind === 'rtab' || b.kind === 'end' || b.kind === 'forced') break;
          follow += b.w;
        }
        w = target - x - (align === 'CenterAlign' ? follow / 2 : follow);
      }
      w = Math.max(0, w);
      if (x + w > W + 0.01 && pieces.length && a.kind === 'tab') {
        // The tab doesn't fit: break before it.
        break;
      }
      pieces.push({ x, w, text: '', start: a.start, end: a.end, look: a.look, space: true });
      x += w;
      k++;
      continue;
    }
    if (a.kind === 'space') {
      pieces.push({ x, w: a.w, text: a.text, start: a.start, end: a.end, look: a.look, space: true });
      x += a.w;
      k++;
      if (a.breakAfter) {
        lastBreak = k;
        lastBreakPieces = pieces.length;
      }
      continue;
    }
    // A word.
    if (x + a.w > W + 0.01 && (pieces.some((p) => !p.space) || lastBreak > from)) {
      if (lastBreak > from) {
        pieces.length = lastBreakPieces;
        k = lastBreak;
      }
      break;
    }
    if (x + a.w > W + 0.01) {
      // A word longer than the line: break it where it overflows.
      let n = 1;
      const chars = [...a.text];
      while (n < chars.length && measure(a.look, chars.slice(0, n + 1).join('')) <= W - x) n++;
      const t = chars.slice(0, n).join('');
      const w = measure(a.look, t);
      const flatLen = a.end - a.start === a.text.length ? n : Math.min(a.end - a.start, n);
      pieces.push({ x, w, text: t, start: a.start, end: a.start + flatLen, look: a.look, space: false });
      atoms[k] = { ...a, start: a.start + flatLen, text: chars.slice(n).join(''), w: measure(a.look, chars.slice(n).join('')) };
      break;
    }
    pieces.push({ x, w: a.w, text: a.text, start: a.start, end: a.end, look: a.look, space: false });
    x += a.w;
    k++;
    if (a.breakAfter) {
      lastBreak = k;
      lastBreakPieces = pieces.length;
    }
  }
  if (k === from && from < atoms.length) {
    // Nothing fit (a very narrow slot): take one atom anyway so text moves on.
    const a = atoms[k];
    pieces.push({ x: 0, w: a.w, text: a.text, start: a.start, end: a.end, look: a.look, space: a.kind !== 'word' });
    k++;
    if (a.kind === 'end') ended = true;
  }
  // Metrics.
  let ascent = 0;
  let descent = 0;
  let leading = 0;
  for (const p of pieces) {
    if (p.table) {
      ascent = Math.max(ascent, p.table.h);
      leading = Math.max(leading, p.table.h);
      continue;
    }
    const a = atoms.find((t) => t.start === p.start) ?? atoms[Math.min(k, atoms.length) - 1];
    const inf = a?.info;
    if (!inf) continue;
    if (p.text || p.space) {
      ascent = Math.max(ascent, inf.ascent);
      descent = Math.max(descent, inf.descent);
      leading = Math.max(leading, inf.leading);
    }
  }
  // Trailing spaces hang outside the measure.
  let natural = 0;
  for (const p of pieces) if (!p.space || p.w === 0 || p.text === '') natural = Math.max(natural, p.x + p.w);
  for (let q = pieces.length - 1; q >= 0 && pieces[q].space; q--) natural = Math.min(natural, pieces[q].x);
  const lastOfPara = ended;
  const j = pl.justification;
  const justify = j === 'FullyJustified' || ((j === 'LeftJustified' || j === 'CenterJustified' || j === 'RightJustified') && !lastOfPara);
  let offset = 0;
  const free = W - natural;
  const lastAlign = j === 'CenterJustified' ? 'CenterAlign' : j === 'RightJustified' ? 'RightAlign' : 'LeftAlign';
  const align = justify ? 'Justify' : j === 'LeftJustified' || j === 'CenterJustified' || j === 'RightJustified' ? lastAlign : j;
  if (align === 'CenterAlign') offset = free / 2;
  else if (align === 'RightAlign' || align === 'AwayFromBindingSide') offset = free;
  if (pl.lastIndent && lastOfPara && !justify) offset += align === 'RightAlign' ? -pl.lastIndent : pl.lastIndent;
  if (align === 'Justify' && free > 0) {
    // Spread the room over the spaces between words (not the trailing ones, nor before a tab).
    let lastTab = -1;
    pieces.forEach((p, idx) => {
      if (p.space && p.text === '' && p.w > 0) lastTab = idx;
    });
    let endIdx = pieces.length - 1;
    while (endIdx >= 0 && pieces[endIdx].space) endIdx--;
    const gaps = pieces.filter((p, idx) => idx > lastTab && idx < endIdx && p.space && p.text);
    if (gaps.length) {
      const per = free / gaps.length;
      let add = 0;
      for (let idx = 0; idx < pieces.length; idx++) {
        const p = pieces[idx];
        p.x += add;
        if (idx > lastTab && idx < endIdx && p.space && p.text) {
          p.w += per;
          add += per;
        }
      }
    }
  }
  for (const p of pieces) p.x += slot.x + offset;
  const startPos = pieces.length ? pieces[0].start : (atoms[from]?.start ?? 0);
  const endPos = pieces.length ? pieces[pieces.length - 1].end : startPos;
  return { pieces, next: k, start: startPos, end: endPos, ended, forced, ascent, descent, leading: leading || 14.4 };
}

// ---- Caret and selection -------------------------------------------------------------------

/** x of a position inside a piece. */
export function pieceX(p: Piece, pos: number): number {
  if (pos <= p.start) return p.x;
  if (pos >= p.end || !p.text) return p.x + p.w;
  const k = pos - p.start;
  if (p.end - p.start !== p.text.length) return p.x + p.w;
  return p.x + measure(p.look, p.text.slice(0, k)) * (p.space && p.text ? p.w / Math.max(1e-6, measure(p.look, p.text)) : 1);
}

/** The line a caret at `pos` sits on. */
export function lineAt(comp: Composition, pos: number): Line | null {
  let best: Line | null = null;
  for (const l of comp.lines) {
    if (pos >= l.start && pos < l.end) return l;
    if (pos === l.end) {
      // At a line's end: stay on it unless that end is a break.
      const lastPiece = l.pieces[l.pieces.length - 1];
      const isBreak = !!lastPiece && lastPiece.text === '' && lastPiece.end - lastPiece.start === 1 && (comp.flat.text[lastPiece.start] === '\r' || comp.flat.text[lastPiece.start] === '\u2028');
      if (!isBreak) best = l;
    }
    if (l.start > pos) break;
  }
  return best;
}

export function caretX(l: Line, pos: number): number {
  for (const p of l.pieces) if (pos >= p.start && pos < p.end) return pieceX(p, pos);
  const last = l.pieces[l.pieces.length - 1];
  if (!last) return l.x;
  if (pos <= l.start) return l.pieces[0].x;
  return last.x + (last.text === '' && last.end - last.start === 1 ? 0 : last.w);
}

/** The text position nearest a point in a frame. */
export function posAt(comp: Composition, frame: number, x: number, y: number): number {
  const ls = comp.byFrame[frame] ?? [];
  if (!ls.length) {
    // An empty frame: the start of what would go in it.
    const before = comp.byFrame.slice(0, frame).flat();
    return before.length ? before[before.length - 1].end : comp.setEnd;
  }
  // Lines sharing a baseline (text wrap) count as one row.
  let best: Line = ls[0];
  let bd = Infinity;
  for (const l of ls) {
    const top = l.y - l.leading * 0.8;
    const bottom = l.y + l.descent + 2;
    const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    const dx = x < l.x ? l.x - x : x > l.x + l.width ? x - l.x - l.width : 0;
    const d = dy * 4 + dx;
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  const l = best;
  for (const p of l.pieces) {
    if (x < p.x + p.w || p === l.pieces[l.pieces.length - 1]) {
      if (x <= p.x) return p.start;
      if (!p.text || p.end - p.start !== p.text.length) {
        if (p.text === '' && p.end - p.start === 1 && (comp.flat.text[p.start] === '\r' || comp.flat.text[p.start] === '\u2028')) return p.start;
        return x < p.x + p.w / 2 ? p.start : p.end;
      }
      for (let k = 0; k < p.text.length; k++) {
        const a = pieceX(p, p.start + k);
        const b = pieceX(p, p.start + k + 1);
        if (x < (a + b) / 2) return p.start + k;
      }
      return p.end;
    }
  }
  return l.end;
}

/** Highlight rectangles for a selection, per frame. */
export function selectionRects(comp: Composition, a: number, b: number): { frame: number; rect: Rect }[] {
  const out: { frame: number; rect: Rect }[] = [];
  if (b <= a) return out;
  for (const l of comp.lines) {
    if (l.end <= a || l.start >= b) {
      if (!(l.start === l.end && l.start >= a && l.start < b)) continue;
    }
    const x0 = caretX(l, Math.max(a, l.start));
    let x1 = caretX(l, Math.min(b, l.end));
    if (b > l.end || (b === l.end && l.pieces.length && l.pieces[l.pieces.length - 1].text === '')) x1 = Math.max(x1, x0 + l.ascent * 0.3);
    const top = l.y - Math.max(l.ascent, l.leading * 0.75);
    out.push({ frame: l.frame, rect: { x: Math.min(x0, x1), y: top, w: Math.abs(x1 - x0), h: l.y + l.descent - top } });
  }
  return out;
}

// ---- Tables ---------------------------------------------------------------------------------

const attrNum = (e: Element | null | undefined, name: string, d: number) => {
  const v = e?.getAttribute(name);
  const n = v === null || v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/** Lays a table out: column widths, rows grown to fit their text, each cell's text composed. */
function layoutTable(table: Element, styles: Styles, prefs: TextPrefs, depth: number): TableLayout {
  const kidsOf = (name: string) => Array.from(table.children).filter((c) => c.localName === name);
  const colEls = kidsOf('Column');
  const rowEls = kidsOf('Row');
  const cols = colEls.length ? colEls.map((c) => attrNum(c, 'SingleColumnWidth', 72)) : [72];
  const rows = rowEls.map((r) => Math.max(attrNum(r, 'SingleRowHeight', 0), attrNum(r, 'MinimumHeight', 3)));
  const nRows = Math.max(rows.length, 1);
  while (rows.length < nRows) rows.push(14);
  const colX = [0];
  for (const w of cols) colX.push(colX[colX.length - 1] + w);
  const cells: { el: Element; c: number; r: number; cs: number; rs: number; inset: [number, number, number, number]; need: number }[] = [];
  for (const cell of kidsOf('Cell')) {
    const [c, r] = (cell.getAttribute('Name') ?? '0:0').split(':').map((n) => parseInt(n, 10) || 0);
    const cs = Math.max(1, attrNum(cell, 'ColumnSpan', 1));
    const rs = Math.max(1, attrNum(cell, 'RowSpan', 1));
    if (cs < 0 || rs < 0) continue;
    const inset: [number, number, number, number] = [attrNum(cell, 'TextTopInset', 4), attrNum(cell, 'TextLeftInset', 4), attrNum(cell, 'TextBottomInset', 4), attrNum(cell, 'TextRightInset', 4)];
    cells.push({ el: cell, c, r, cs, rs, inset, need: 0 });
  }
  const widthOf = (c: number, cs: number) => (colX[Math.min(cols.length, c + cs)] ?? colX[colX.length - 1]) - (colX[c] ?? 0);
  const spec = (w: number, h: number, vj: string, fb: string): FrameSpec => ({
    self: '',
    area: { x: 0, y: 0, w: Math.max(1, w), h },
    columns: 1,
    gutter: 0,
    fixedWidth: null,
    vj,
    firstBaseline: fb,
    minFirstBaseline: 0,
    page: '',
    nextPage: '',
    wraps: [],
  });
  // Rows grow to fit what's in them (spanning cells aside).
  if (depth < 3) {
    for (const cell of cells) {
      const w = widthOf(cell.c, cell.cs) - cell.inset[1] - cell.inset[3];
      const comp = compose(cell.el, styles, [spec(w, 1e5, 'TopAlign', cell.el.getAttribute('FirstBaselineOffset') ?? 'AscentOffset')], prefs, depth + 1);
      const last = comp.lines[comp.lines.length - 1];
      cell.need = (last ? last.y + last.descent : 0) + cell.inset[0] + cell.inset[2];
      if (cell.rs === 1 && cell.r < rows.length) rows[cell.r] = Math.max(rows[cell.r], cell.need);
    }
  }
  const rowY = [0];
  for (const h of rows) rowY.push(rowY[rowY.length - 1] + h);
  const out: TableCell[] = [];
  for (const cell of cells) {
    const x = colX[cell.c] ?? 0;
    const y = rowY[cell.r] ?? 0;
    const w = widthOf(cell.c, cell.cs);
    const h = (rowY[Math.min(rows.length, cell.r + cell.rs)] ?? rowY[rowY.length - 1]) - y;
    const tw = w - cell.inset[1] - cell.inset[3];
    const th = h - cell.inset[0] - cell.inset[2];
    const comp =
      depth < 3
        ? compose(cell.el, styles, [spec(tw, Math.max(th, 1), cell.el.getAttribute('VerticalJustification') ?? 'TopAlign', cell.el.getAttribute('FirstBaselineOffset') ?? 'AscentOffset')], prefs, depth + 1)
        : compose(cell.el, styles, [], prefs, depth + 1);
    const edge = (side: string) => ({
      weight: attrNum(cell.el, `${side}EdgeStrokeWeight`, 1),
      color: ((v) => (v === 'Swatch/None' ? null : (v ?? 'Color/Black')))(cell.el.getAttribute(`${side}EdgeStrokeColor`)),
      tint: attrNum(cell.el, `${side}EdgeStrokeTint`, -1),
    });
    const fill = cell.el.getAttribute('FillColor');
    out.push({
      x,
      y,
      w,
      h,
      tx: cell.inset[1],
      ty: cell.inset[0],
      comp,
      fill: fill && fill !== 'Swatch/None' ? fill : null,
      fillTint: attrNum(cell.el, 'FillTint', -1),
      edges: [edge('Top'), edge('Left'), edge('Bottom'), edge('Right')],
    });
  }
  return { w: colX[colX.length - 1], h: rowY[rowY.length - 1], cells: out };
}
