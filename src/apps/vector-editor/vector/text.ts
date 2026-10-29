import '@/shared/office/fonts';
import type { FontEntry, Resources, TextItem, TextRun } from './model';

/**
 * Setting type: lines, where each character goes, and how it's drawn.
 * Type opened from a file keeps its glyphs where the file put them until
 * it's edited. After that, characters the file's font has are drawn from
 * that font's own outlines; the rest, and type set in fonts the file didn't
 * have, are drawn by a free font close to the one named.
 */

const SANS = '"Arimo", "Liberation Sans", "Noto Sans", sans-serif';
const SERIF = '"Tinos", "Liberation Serif", "Noto Serif", serif';
const MONO = '"Cousine", "Liberation Mono", monospace';

const LIKE: [RegExp, string][] = [
  [/courier|mono|consolas|code|typewriter/i, MONO],
  [/calibri|carlito|aptos|candara|corbel/i, '"Carlito", ' + SANS],
  [/cambria|caladea/i, '"Caladea", ' + SERIF],
  [/inter\b|segoe|sf pro|roboto|open sans|source sans|lato|montserrat|nunito|poppins|raleway|work sans|ibm plex sans|noto sans/i, '"Inter Variable", ' + SANS],
  [/times|minion|garamond|georgia|baskerville|caslon|palatino|book|serif|tinos|merriweather|playfair|crimson|libre baskerville|bodoni|didot|chaparral|adobe text|utopia|charter/i, SERIF],
];

/** A CSS font-family list for a font as a file names it. */
export function cssFamily(family: string): string {
  const name = family.replace(/[^\p{L}\p{N} \-_.&+]/gu, '').trim();
  const like = LIKE.find(([re]) => re.test(name))?.[1] ?? SANS;
  return name ? `"${name}", ${like}` : like;
}

export function cssWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const weight = /black|heavy/.test(s) ? 900 : /extra ?bold|ultra ?bold/.test(s) ? 800 : /semi ?bold|demi/.test(s) ? 600 : /bold/.test(s) ? 700 : /medium/.test(s) ? 500 : /extra ?light|ultra ?light|thin/.test(s) ? 200 : /light/.test(s) ? 300 : 400;
  return { weight, italic: /italic|oblique/.test(s) };
}

export function cssFont(run: Pick<TextRun, 'font' | 'size'>, px = run.size): string {
  const { weight, italic } = cssWeight(run.font.style);
  return `${italic ? 'italic ' : ''}${weight} ${px}px ${cssFamily(run.font.family)}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

/** A character's advance in a CSS font at 1pt. */
export function cssAdvanceOf(run: TextRun, ch: string): number {
  const font = cssFont(run, 100);
  const key = `${font}\u0000${ch}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx ??= document.createElement('canvas').getContext('2d')!;
    measureCtx.font = font;
    w = measureCtx.measureText(ch).width / 100;
    if (widthCache.size > 50000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

export interface LaidGlyph {
  ch: string;
  /** Index into the item's text (all runs joined). */
  index: number;
  run: number;
  x: number;
  /** Advance, in points. */
  w: number;
  /** When drawn from the file's font. */
  code?: number;
}

export interface LaidLine {
  /** Baseline, in the text's space. */
  y: number;
  x: number;
  width: number;
  ascent: number;
  descent: number;
  glyphs: LaidGlyph[];
  /** Text index of the line's first character and one past its last (newline excluded). */
  start: number;
  end: number;
}

export interface Layout {
  lines: LaidLine[];
  /** In the text's space: the type's extent (area type: its box). */
  box: { x: number; y: number; w: number; h: number };
}

export const textOf = (t: TextItem) => t.runs.map((r) => r.text).join('');

/** The file's font for a run, when it can draw these characters. */
export function embeddedFor(res: Resources, run: TextRun): FontEntry | null {
  if (!run.font.embedded) return null;
  const f = res.fonts.get(run.font.embedded);
  return f && f.outlines ? f : null;
}

const layoutCache = new WeakMap<TextItem, Layout>();

export function layoutText(item: TextItem, res: Resources): Layout {
  const hit = layoutCache.get(item);
  if (hit) return hit;
  const l = doLayout(item, res);
  layoutCache.set(item, l);
  return l;
}

function doLayout(item: TextItem, res: Resources): Layout {
  const text = textOf(item);
  const placed = item.placed && item.placed.text === text ? item.placed : null;
  if (placed && item.runs.length) {
    const run = item.runs[0];
    const font = res.fonts.get(placed.font);
    const glyphs: LaidGlyph[] = placed.glyphs.map((g, i) => ({
      ch: g.ch,
      index: i,
      run: 0,
      x: g.x,
      w: g.code < 0 ? 0 : ((font?.width(g.code) ?? 500) / 1000) * placed.size * placed.hscale + (run.tracking / 1000) * run.size,
      code: g.code < 0 ? undefined : g.code,
    }));
    // A virtual space spans the gap to the next glyph.
    for (let i = 0; i < glyphs.length; i++) if (placed.glyphs[i].code < 0) glyphs[i].w = (glyphs[i + 1]?.x ?? glyphs[i].x) - glyphs[i].x;
    const x0 = glyphs.length ? Math.min(...glyphs.map((g) => g.x)) : 0;
    const x1 = glyphs.length ? Math.max(...glyphs.map((g) => g.x + g.w)) : 0;
    const asc = ((font?.ascent ?? 750) / 1000) * run.size;
    const desc = (-(font?.descent ?? -250) / 1000) * run.size;
    const line: LaidLine = { y: -run.rise, x: x0, width: x1 - x0, ascent: asc, descent: desc, glyphs, start: 0, end: text.length };
    return { lines: [line], box: { x: x0, y: -asc, w: x1 - x0, h: asc + desc } };
  }

  // Characters with their runs.
  const chars: { ch: string; run: number; index: number }[] = [];
  let idx = 0;
  item.runs.forEach((r, ri) => {
    for (const ch of r.text) {
      chars.push({ ch, run: ri, index: idx });
      idx += ch.length;
    }
  });
  const encoded = new Map<number, Map<string, number>>();
  const advance = (c: { ch: string; run: number }): { w: number; code?: number } => {
    const run = item.runs[c.run];
    if (c.ch === '\n' || c.ch === '\r') return { w: 0 };
    const f = embeddedFor(res, run);
    let code: number | undefined;
    if (f) {
      let m = encoded.get(c.run);
      if (!m) encoded.set(c.run, (m = new Map()));
      if (!m.has(c.ch)) {
        const e = f.encode(c.ch);
        m.set(c.ch, e && e.length === 1 && f.glyph(e[0].code) !== null ? e[0].code : e && c.ch === ' ' ? e[0].code : -1);
      }
      const k = m.get(c.ch)!;
      if (k >= 0) code = k;
    }
    const base = code !== undefined ? f!.width(code) / 1000 : cssAdvanceOf(run, c.ch);
    return { w: base * run.size * run.hscale + (run.tracking / 1000) * run.size, code };
  };

  const maxSize = (from: number, to: number) => {
    let m = 0;
    for (let i = from; i < to; i++) m = Math.max(m, item.runs[chars[i].run].size);
    return m || item.runs[chars[Math.max(0, from - 1)]?.run ?? 0]?.size || item.runs[0]?.size || 12;
  };

  // Break into lines: paragraphs at newlines; area type also wraps at its width.
  const lines: { from: number; to: number; glyphs: LaidGlyph[]; width: number }[] = [];
  const wrapW = item.area ? item.area.w : Infinity;
  let i = 0;
  while (i <= chars.length) {
    let j = i;
    while (j < chars.length && chars[j].ch !== '\n' && chars[j].ch !== '\r') j++;
    // [i, j) is a paragraph
    let start = i;
    let x = 0;
    let glyphs: LaidGlyph[] = [];
    let lastBreak = -1;
    for (let k = i; k < j; k++) {
      const a = advance(chars[k]);
      if (x + a.w > wrapW && k > start && chars[k].ch !== ' ') {
        let cut = lastBreak >= start ? lastBreak + 1 : k;
        if (cut <= start) cut = k;
        const kept = glyphs.filter((g) => g.index < chars[cut]?.index);
        lines.push({ from: start, to: cut, glyphs: kept, width: lineWidth(kept) });
        start = cut;
        glyphs = [];
        x = 0;
        for (let q = cut; q < k; q++) {
          const aq = advance(chars[q]);
          glyphs.push({ ch: chars[q].ch, index: chars[q].index, run: chars[q].run, x, w: aq.w, code: aq.code });
          x += aq.w;
        }
        lastBreak = -1;
      }
      glyphs.push({ ch: chars[k].ch, index: chars[k].index, run: chars[k].run, x, w: a.w, code: a.code });
      x += a.w;
      if (chars[k].ch === ' ' || chars[k].ch === '-') lastBreak = k;
    }
    lines.push({ from: start, to: j, glyphs, width: lineWidth(glyphs) });
    i = j + 1;
    if (j >= chars.length) break;
  }

  const out: LaidLine[] = [];
  let y = 0;
  lines.forEach((ln, li) => {
    const size = maxSize(ln.from, ln.to);
    const asc = size * 0.8;
    const desc = size * 0.2;
    const lead = item.leading || size * 1.2;
    if (li === 0) y = item.area ? asc : 0;
    else y += lead;
    let x = 0;
    const box = item.area?.w ?? 0;
    if (item.align === 'center') x = item.area ? (box - ln.width) / 2 : -ln.width / 2;
    else if (item.align === 'right') x = item.area ? box - ln.width : -ln.width;
    for (const g of ln.glyphs) g.x += x;
    const startIdx = chars[ln.from]?.index ?? text.length;
    const endIdx = ln.to < chars.length ? chars[ln.to].index : text.length;
    const rise = item.runs[chars[ln.from]?.run ?? 0]?.rise ?? 0;
    out.push({ y: y - rise, x, width: ln.width, ascent: asc, descent: desc, glyphs: ln.glyphs, start: startIdx, end: endIdx });
  });
  if (!out.length) {
    const size = item.runs[0]?.size ?? 12;
    out.push({ y: item.area ? size * 0.8 : 0, x: 0, width: 0, ascent: size * 0.8, descent: size * 0.2, glyphs: [], start: 0, end: 0 });
  }
  let box: Layout['box'];
  if (item.area) box = { x: 0, y: 0, w: item.area.w, h: item.area.h };
  else {
    const x0 = Math.min(...out.map((l) => l.x));
    const x1 = Math.max(...out.map((l) => l.x + l.width));
    const y0 = out[0].y - out[0].ascent;
    const y1 = out[out.length - 1].y + out[out.length - 1].descent;
    box = { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: y1 - y0 };
  }
  return { lines: out, box };
}

function lineWidth(glyphs: LaidGlyph[]): number {
  let n = glyphs.length;
  while (n > 0 && glyphs[n - 1].ch === ' ') n--;
  if (!n) return 0;
  const g = glyphs[n - 1];
  return g.x + g.w - glyphs[0].x;
}

/** The caret's position for a text index: line and x. */
export function caretAt(layout: Layout, index: number): { line: number; x: number } {
  for (let li = 0; li < layout.lines.length; li++) {
    const ln = layout.lines[li];
    const last = li === layout.lines.length - 1;
    if (index >= ln.start && (index < ln.end || (index === ln.end && (last || layout.lines[li + 1].start > ln.end)))) {
      const g = ln.glyphs.find((gg) => gg.index >= index);
      if (g && g.index === index) return { line: li, x: g.x };
      const lastG = ln.glyphs.filter((gg) => gg.index < index).pop();
      return { line: li, x: lastG ? lastG.x + lastG.w : ln.x };
    }
  }
  const li = layout.lines.length - 1;
  const ln = layout.lines[li];
  const lastG = ln.glyphs[ln.glyphs.length - 1];
  return { line: li, x: lastG ? lastG.x + lastG.w : ln.x };
}

/** The text index nearest a point in the text's space. */
export function indexAt(layout: Layout, x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  layout.lines.forEach((ln, li) => {
    const d = y < ln.y - ln.ascent ? ln.y - ln.ascent - y : y > ln.y + ln.descent ? y - ln.y - ln.descent : 0;
    if (d < bestD) {
      bestD = d;
      best = li;
    }
  });
  const ln = layout.lines[best];
  for (const g of ln.glyphs) if (x < g.x + g.w / 2) return g.index;
  return ln.end;
}
