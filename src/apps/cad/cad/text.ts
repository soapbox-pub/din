/**
 * Text as CAD lays it out: TEXT's alignment modes and %% codes, and MTEXT's
 * formatting codes (\P, \H, \C, \f, \L, \S and friends) with word wrap.
 * Measurement uses the same fonts the canvas draws with, so what's shown
 * lines up with what's picked and snapped to.
 */
import type { Text, TextStyle } from './model';

/** Fonts the app ships, standing in for AutoCAD's. */
export function fontFamily(style: TextStyle | undefined, override?: string): string {
  const f = (override || style?.font || 'txt').toLowerCase();
  if (/times|tinos|serif|roman(c|t|d|s)?\b|romanc|cambria|georgia/.test(f)) return '"Tinos", "Times New Roman", serif';
  if (/courier|cousine|mono|consol|monotxt/.test(f)) return '"Cousine", "Courier New", monospace';
  if (/calibri|carlito/.test(f)) return '"Carlito", "Calibri", sans-serif';
  if (/cambria|caladea/.test(f)) return '"Caladea", "Cambria", serif';
  return '"Arimo", "Arial", "Liberation Sans", sans-serif';
}

/** Capital height over font size, for Arial and its metric twins. */
export const CAP = 0.716;
const DESCENT = 0.212;

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

/** Load the text fonts before anything is measured with them; resolves once they're usable. */
export async function ensureFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const faces = ['Arimo', 'Tinos', 'Cousine', 'Carlito', 'Caladea'];
  await Promise.allSettled(faces.flatMap((f) => [document.fonts.load(`100px "${f}"`), document.fonts.load(`bold 100px "${f}"`), document.fonts.load(`italic 100px "${f}"`)]));
  widthCache.clear();
}

/** Width of `s` at text height 1, which is a cap height: the font is drawn at 1 / CAP. */
export function measure(s: string, family: string, bold = false, italic = false): number {
  if (!s) return 0;
  const key = `${family}|${bold ? 1 : 0}${italic ? 1 : 0}|${s}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    measureCtx = c.getContext('2d') as CanvasRenderingContext2D | null;
  }
  let w = s.length * 0.55;
  if (measureCtx) {
    measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}100px ${family}`;
    w = measureCtx.measureText(s).width / 100;
  }
  w /= CAP;
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

const unicodeEsc = (s: string) => s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** TEXT's control codes: %%d °, %%c Ø, %%p ±, %%u and %%o toggles (dropped), %%nnn. */
export function plainText(s: string): string {
  return unicodeEsc(s)
    .replace(/%%[dD]/g, '°')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%(\d{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/%%%/g, '%');
}

export interface TextRun {
  text: string;
  x: number;
  /** Height relative to the entity's. */
  size: number;
  family: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  overline: boolean;
  strike: boolean;
  /** An ACI color override. */
  color?: number;
  /** Baseline shift (stacked fractions), in entity heights. */
  dy?: number;
  width: number;
}

export interface TextLine {
  /** Baseline, downward from the top of the first line, in entity heights. */
  y: number;
  runs: TextRun[];
  width: number;
  height: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** In entity heights. */
  width: number;
  height: number;
}

/** A single-line TEXT's layout at height 1 and width factor 1. */
export function layoutText(t: Pick<Text, 'text'>, family: string): TextLayout {
  const s = plainText(t.text);
  const w = measure(s, family);
  const run: TextRun = { text: s, x: 0, size: 1, family, bold: false, italic: false, underline: /%%u/i.test(t.text), overline: /%%o/i.test(t.text), strike: false, width: w };
  return { lines: [{ y: 0, runs: [run], width: w, height: 1 }], width: w, height: 1 };
}

interface Fmt {
  size: number;
  family: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  overline: boolean;
  strike: boolean;
  color?: number;
  /** Width factor (\W). */
  wf: number;
}

type Token = { k: 'text'; s: string; f: Fmt } | { k: 'para' } | { k: 'stack'; top: string; bottom: string; f: Fmt };

function tokenize(src: string, base: Fmt, height: number): Token[] {
  const out: Token[] = [];
  const stack: Fmt[] = [];
  let f: Fmt = { ...base };
  let buf = '';
  const flush = () => {
    if (buf) out.push({ k: 'text', s: buf, f: { ...f } });
    buf = '';
  };
  const s = src;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      flush();
      stack.push({ ...f });
      continue;
    }
    if (ch === '}') {
      flush();
      f = stack.pop() ?? { ...base };
      continue;
    }
    if (ch === '%' && s[i + 1] === '%') {
      const code = s[i + 2]?.toLowerCase();
      const map: Record<string, string> = { d: '°', c: 'Ø', p: '±', '%': '%' };
      if (code && map[code]) {
        buf += map[code];
        i += 2;
        continue;
      }
    }
    if (ch !== '\\') {
      buf += ch === '\n' ? '' : ch;
      if (ch === '\n') {
        flush();
        out.push({ k: 'para' });
      }
      continue;
    }
    const c = s[i + 1];
    if (c === undefined) break;
    const arg = () => {
      const end = s.indexOf(';', i + 2);
      const v = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
      i = end < 0 ? s.length : end;
      return v;
    };
    switch (c) {
      case 'P':
        flush();
        out.push({ k: 'para' });
        i++;
        break;
      case 'X':
        flush();
        out.push({ k: 'para' });
        i++;
        break;
      case '~':
        buf += '\u00a0';
        i++;
        break;
      case '\\':
      case '{':
      case '}':
        buf += c;
        i++;
        break;
      case 'U':
        if (s[i + 2] === '+' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 7))) {
          buf += String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16));
          i += 6;
        } else i++;
        break;
      case 'L':
      case 'l':
      case 'O':
      case 'o':
      case 'K':
      case 'k':
        flush();
        if (c === 'L' || c === 'l') f.underline = c === 'L';
        else if (c === 'O' || c === 'o') f.overline = c === 'O';
        else f.strike = c === 'K';
        i++;
        break;
      case 'H': {
        flush();
        const v = arg();
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) f.size = /x$/i.test(v) ? f.size * n : n / height;
        break;
      }
      case 'C': {
        flush();
        const n = parseInt(arg(), 10);
        f.color = Number.isFinite(n) && n > 0 && n < 256 ? n : undefined;
        break;
      }
      case 'c':
        flush();
        arg();
        break;
      case 'f':
      case 'F': {
        flush();
        const parts = arg().split('|');
        if (parts[0]) f.family = fontFamily(undefined, parts[0]);
        for (const p of parts.slice(1)) {
          if (/^b1/i.test(p)) f.bold = true;
          if (/^b0/i.test(p)) f.bold = false;
          if (/^i1/i.test(p)) f.italic = true;
          if (/^i0/i.test(p)) f.italic = false;
        }
        break;
      }
      case 'W': {
        flush();
        const n = parseFloat(arg());
        if (Number.isFinite(n) && n > 0) f.wf = n;
        break;
      }
      case 'S': {
        flush();
        const v = arg();
        const m = /^(.*?)([/#^])(.*)$/.exec(v) ?? [v, v, '/', ''];
        out.push({ k: 'stack', top: m[1], bottom: m[3], f: { ...f } });
        break;
      }
      case 'A':
      case 'Q':
      case 'T':
      case 'p':
        flush();
        arg();
        break;
      default:
        i++;
    }
  }
  flush();
  return out;
}

/**
 * MTEXT's layout at height 1: lines of runs, wrapped to `width` (in
 * entity heights, 0 for no wrapping).
 */
export function layoutMText(src: string, family: string, width: number, spacing: number): TextLayout {
  const base: Fmt = { size: 1, family, bold: false, italic: false, underline: false, overline: false, strike: false, wf: 1 };
  const tokens = tokenize(src, base, 1);
  const lines: TextLine[] = [];
  let runs: TextRun[] = [];
  let x = 0;
  let lineH = 1;
  const pushLine = () => {
    // Trailing spaces don't count toward the width.
    const last = runs[runs.length - 1];
    if (last && /\s+$/.test(last.text)) {
      const t = last.text.replace(/\s+$/, '');
      last.width = measure(t, last.family, last.bold, last.italic) * last.size;
      last.text = t;
    }
    const w = runs.reduce((m, r) => Math.max(m, r.x + r.width), 0);
    lines.push({ y: 0, runs, width: w, height: lineH });
    runs = [];
    x = 0;
    lineH = 1;
  };
  const place = (text: string, f: Fmt) => {
    const w = measure(text, f.family, f.bold, f.italic) * f.size * f.wf;
    runs.push({ text, x, size: f.size, family: f.family, bold: f.bold, italic: f.italic, underline: f.underline, overline: f.overline, strike: f.strike, color: f.color, width: w });
    x += w;
    lineH = Math.max(lineH, f.size);
  };
  for (const t of tokens) {
    if (t.k === 'para') {
      pushLine();
      continue;
    }
    if (t.k === 'stack') {
      const f = t.f;
      const sz = f.size * 0.7;
      const wt = measure(t.top, f.family) * sz;
      const wb = measure(t.bottom, f.family) * sz;
      const w = Math.max(wt, wb) + 0.1;
      if (width > 0 && x + w > width && runs.length) pushLine();
      runs.push({ text: t.top, x: x + (w - wt) / 2, size: sz, family: f.family, bold: f.bold, italic: f.italic, underline: false, overline: false, strike: false, color: f.color, dy: -0.55, width: wt });
      runs.push({ text: t.bottom, x: x + (w - wb) / 2, size: sz, family: f.family, bold: f.bold, italic: f.italic, underline: false, overline: false, strike: false, color: f.color, dy: 0.25, width: wb });
      x += w;
      continue;
    }
    if (width <= 0) {
      place(t.s, t.f);
      continue;
    }
    // Word wrap: break at spaces, and inside words longer than a line.
    const words = t.s.split(/(?<=\s)/);
    for (const word of words) {
      const w = measure(word.replace(/\s+$/, ''), t.f.family, t.f.bold, t.f.italic) * t.f.size * t.f.wf;
      if (x > 0 && x + w > width + 1e-9) pushLine();
      if (x === 0 && w > width && word.length > 1) {
        let piece = '';
        for (const ch of word) {
          const pw = measure(piece + ch, t.f.family, t.f.bold, t.f.italic) * t.f.size * t.f.wf;
          if (pw > width && piece) {
            place(piece, t.f);
            pushLine();
            piece = ch;
          } else piece += ch;
        }
        if (piece) place(piece, t.f);
      } else place(word, t.f);
    }
  }
  pushLine();
  // AutoCAD's line pitch is 5/3 of the text height, times the spacing factor.
  const pitch = (5 / 3) * (spacing || 1);
  let y = 0;
  lines.forEach((l, i) => {
    y += i === 0 ? l.height : pitch * Math.max(1, l.height);
    l.y = y;
  });
  const height = lines.length ? lines[lines.length - 1].y + DESCENT * 0.4 : 1;
  const w = lines.reduce((m, l) => Math.max(m, l.width), 0);
  return { lines, width: w, height };
}

/** MTEXT's codes stripped, for the Properties palette and lists. */
export function mtextPlain(src: string): string {
  return tokenize(src, { size: 1, family: '', bold: false, italic: false, underline: false, overline: false, strike: false, wf: 1 }, 1)
    .map((t) => (t.k === 'para' ? '\n' : t.k === 'stack' ? `${t.top}/${t.bottom}` : t.s))
    .join('');
}

export { DESCENT };
