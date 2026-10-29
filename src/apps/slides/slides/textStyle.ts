import type { CSSProperties } from 'react';
import { fontStack } from '@/shared/office/fonts';
import type { Theme } from '@/shared/office/theme';
import type { Bullet, Para, RunProps, SlideCtx } from './model';
import { colorCss, fontName, resolvePara, resolveRun, type ResolvedPara, type TextStyleChain } from './resolve';

/**
 * How PowerPoint text turns into CSS. The slide is laid out at 96 dpi
 * (a point is 4/3 px); single line spacing is 1.2 times the font size, as
 * PowerPoint spaces lines; bullets hang in the paragraph's indent. Static
 * slides and the text editor both style text through here, so text doesn't
 * move when you click into it.
 */

export interface TextEnv {
  theme: Theme;
  clrMap: Record<string, string>;
  /** normAutofit's font scale and line spacing reduction, as fractions. */
  fontScale: number;
  lnReduction: number;
  slideNumber: number;
}

export function textEnv(ctx: SlideCtx, chain: TextStyleChain): TextEnv {
  return {
    theme: ctx.theme,
    clrMap: ctx.clrMap,
    fontScale: (chain.body.fontScale ?? 100000) / 100000,
    lnReduction: (chain.body.lnSpcReduction ?? 0) / 100000,
    slideNumber: ctx.slideNumber,
  };
}

export const PT = 4 / 3;
export const LINE = 1.2;

export const sizePx = (sz: number | undefined, env: TextEnv) => ((sz ?? 1800) / 100) * PT * env.fontScale;

export function runCss(props: RunProps, env: TextEnv): CSSProperties {
  const s: CSSProperties = {};
  if (props.sz !== undefined) s.fontSize = `${sizePx(props.sz, env)}px`;
  const font = fontName(props.font, env.theme);
  if (font) s.fontFamily = fontStack(font);
  if (props.b !== undefined) s.fontWeight = props.b ? 700 : 400;
  if (props.i !== undefined) s.fontStyle = props.i ? 'italic' : 'normal';
  const deco: string[] = [];
  if (props.u && props.u !== 'none') deco.push('underline');
  if (props.strike && props.strike !== 'noStrike') deco.push('line-through');
  if (props.link || props.raw?.hlinkClick) {
    if (!deco.includes('underline')) deco.push('underline');
    s.color = colorCss({ scheme: 'hlink' }, env);
  } else if (props.color) s.color = colorCss(props.color, env);
  if (deco.length) s.textDecoration = deco.join(' ');
  if (props.u === 'dbl') s.textDecorationStyle = 'double';
  else if (props.u && /dash/i.test(props.u)) s.textDecorationStyle = 'dashed';
  else if (props.u && /dot/i.test(props.u)) s.textDecorationStyle = 'dotted';
  else if (props.u && /wavy/i.test(props.u)) s.textDecorationStyle = 'wavy';
  if (props.baseline) {
    s.verticalAlign = `${props.baseline / 1000}%`;
    if (props.sz !== undefined) s.fontSize = `${sizePx(props.sz, env) * 0.67}px`;
    else s.fontSize = '0.67em';
  }
  if (props.cap === 'all') s.textTransform = 'uppercase';
  else if (props.cap === 'small') s.fontVariant = 'small-caps';
  if (props.spc) s.letterSpacing = `${(props.spc / 100) * PT}px`;
  if (props.highlight) s.backgroundColor = colorCss(props.highlight, env);
  return s;
}

/** A run's complete style, with what it inherits filled in. */
export function fullRunCss(props: RunProps, rp: ResolvedPara, env: TextEnv): CSSProperties {
  const r = resolveRun(props, rp);
  return runCss({ ...r, sz: r.sz ?? 1800, font: r.font ?? '+mn-lt' }, env);
}

/** The base style of a paragraph's text: its level's run defaults. */
export function baseRunCss(rp: ResolvedPara, env: TextEnv): CSSProperties {
  const run: RunProps = { ...rp.run, sz: rp.run.sz ?? 1800, font: rp.run.font ?? '+mn-lt' };
  const s = runCss(run, env);
  if (!s.color) s.color = colorCss({ scheme: 'tx1' }, env);
  if (!s.fontWeight) s.fontWeight = 400;
  if (!s.fontStyle) s.fontStyle = 'normal';
  return s;
}

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

function alpha(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

export function autoNumber(scheme: string, n: number): string {
  const m = /^(arabic|romanUc|romanLc|alphaUc|alphaLc|circleNum\w*)(.*)$/.exec(scheme);
  const kind = m?.[1] ?? 'arabic';
  const tail = m?.[2] ?? 'Period';
  let s = String(n);
  if (kind === 'romanUc') s = roman(n).toUpperCase();
  else if (kind === 'romanLc') s = roman(n);
  else if (kind === 'alphaUc') s = alpha(n).toUpperCase();
  else if (kind === 'alphaLc') s = alpha(n);
  if (tail.startsWith('ParenBoth')) return `(${s})`;
  if (tail.startsWith('ParenR')) return `${s})`;
  if (tail.startsWith('Plain')) return s;
  if (tail.startsWith('Minus')) return `- ${s} -`;
  return `${s}.`;
}

/** Each paragraph's number, for autonumbered lists (a list counts on until its level changes upward). */
export function numberParas(paras: { lvl: number; bullet: Bullet | undefined; empty: boolean }[]): (number | null)[] {
  const counters: (number | null)[] = [];
  const schemes: (string | null)[] = [];
  return paras.map((p) => {
    for (let l = p.lvl + 1; l < 9; l++) {
      counters[l] = null;
      schemes[l] = null;
    }
    if (p.bullet?.type !== 'auto') {
      if (!p.empty) {
        counters[p.lvl] = null;
        schemes[p.lvl] = null;
      }
      return null;
    }
    const prev = counters[p.lvl];
    const n = prev !== null && prev !== undefined && schemes[p.lvl] === p.bullet.scheme ? prev + 1 : (p.bullet.start ?? 1);
    counters[p.lvl] = n;
    schemes[p.lvl] = p.bullet.scheme;
    return n;
  });
}

/**
 * Bullets in Wingdings and Symbol name their glyphs by those fonts' own
 * code points; with the fonts missing, they're drawn as the Unicode
 * characters they look like.
 */
const SYMBOL_GLYPHS: Record<'wingdings' | 'wingdings2' | 'wingdings3' | 'symbol', Record<string, string>> = {
  wingdings: {
    'l': '●', 'n': '■', 'o': '□', 'q': '❑', 'r': '❒', 's': '◆', 't': '⧫', 'u': '◆', 'v': '❖', 'w': '◆', 'x': '⌧', '§': '▪', 'Ø': '➢', 'ü': '✓', 'û': '✗', 'þ': '☑',
    'à': '➔', 'è': '➜', 'ð': '⇨', 'F': '☞', 'J': '☺', 'L': '☹', '«': '★', 'ª': '✦', '¨': '◻', '¡': '○', '¤': '◉', 'Ÿ': '•', 'Ö': '➢', '×': '➢',
  },
  wingdings2: { '¡': '○', '¢': '◎', '£': '●', '¿': '◆', 'P': '✓', 'O': '✗' },
  wingdings3: { '}': '▶', 'u': '▶', 'Ø': '➤', 'Æ': '➜' },
  symbol: { '·': '•', 'Ø': '¬', '®': '→', 'Þ': '⇒', '-': '−', '¨': '♣', '©': '♦', '§': '♣', '¾': '—', 'o': 'ο' },
};

function symbolFontOf(font: string | undefined): keyof typeof SYMBOL_GLYPHS | null {
  const f = (font ?? '').toLowerCase().replace(/\s+/g, '');
  return f === 'wingdings' || f === 'wingdings2' || f === 'wingdings3' || f === 'symbol' ? f : null;
}

export interface ParaLook {
  rp: ResolvedPara;
  style: CSSProperties;
  /** Bullet text, or null. */
  bullet: string | null;
}

function spacingPx(sp: ResolvedPara['spcBef'], sizePxV: number, env: TextEnv): number {
  if (!sp) return 0;
  if ('pts' in sp) return sp.pts * PT * env.fontScale;
  return sp.pct * sizePxV * LINE;
}

/** Style each paragraph of a text body (numbering needs them all). */
export function paraLooks(paras: Para[], chain: TextStyleChain, env: TextEnv): ParaLook[] {
  const resolved = paras.map((p) => resolvePara(p.props, chain));
  const numbers = numberParas(
    paras.map((p, i) => ({ lvl: p.props.lvl ?? 0, bullet: resolved[i].bullet, empty: !p.runs.length })),
  );
  return paras.map((p, i) => {
    const rp = resolved[i];
    const firstRun = p.runs.find((r) => r.kind !== 'br') ?? null;
    const firstProps = resolveRun(firstRun ? firstRun.props : (p.end ?? {}), rp);
    const fs = sizePx(firstProps.sz, env);
    // The paragraph's own size is its first run's, so an empty line or a
    // line of small text isn't as tall as the level's default size.
    const style: CSSProperties = {
      ...baseRunCss(rp, env),
      fontSize: `${fs}px`,
      textAlign: rp.algn === 'ctr' ? 'center' : rp.algn === 'r' ? 'right' : rp.algn === 'just' || rp.algn === 'dist' ? 'justify' : 'left',
      paddingLeft: rp.marL / 9525,
      textIndent: rp.indent / 9525,
      marginTop: spacingPx(rp.spcBef, fs, env),
      marginBottom: spacingPx(rp.spcAft, fs, env),
    };
    if (rp.lnSpc && 'pts' in rp.lnSpc) style.lineHeight = `${rp.lnSpc.pts * PT * env.fontScale}px`;
    else {
      const pct = rp.lnSpc && 'pct' in rp.lnSpc ? rp.lnSpc.pct : 1;
      style.lineHeight = Math.max(0.5, (pct - env.lnReduction) * LINE);
    }
    const hasText = p.runs.some((r) => r.kind !== 'br' && r.text.length);
    let bullet: string | null = null;
    const symbolFont = rp.bullet?.type === 'char' ? symbolFontOf(rp.buFont) : null;
    if (hasText && rp.bullet?.type === 'char') bullet = symbolFont ? (SYMBOL_GLYPHS[symbolFont][rp.bullet.char] ?? '•') : rp.bullet.char;
    else if (hasText && rp.bullet?.type === 'auto') bullet = autoNumber(rp.bullet.scheme, numbers[i] ?? 1);
    if (bullet) {
      // The bullet is the paragraph's ::before (see SLIDE_CSS), styled through these.
      const vars = style as Record<string, string | number | undefined>;
      const buFont = rp.bullet?.type === 'char' && !symbolFont ? fontName(rp.buFont, env.theme) : undefined;
      if (buFont) vars['--bu-font'] = fontStack(buFont);
      vars['--bu-size'] = `${fs * ((rp.buSzPct ?? 100000) / 100000)}px`;
      const color = rp.buClr ? colorCss(rp.buClr, env) : (runCss(firstProps, env).color ?? style.color);
      if (color) vars['--bu-color'] = color;
      vars['--bu-weight'] = firstProps.b ? 700 : 400;
      vars['--bu-w'] = rp.indent < 0 ? `${-rp.indent / 9525}px` : 'auto';
      vars['--bu-gap'] = rp.indent < 0 ? '0px' : `${fs * 0.3}px`;
    }
    return { rp, style, bullet };
  });
}

/** Turn CSS properties into a style attribute string, for ProseMirror decorations. */
export function styleString(s: CSSProperties): string {
  const unitless = new Set(['fontWeight', 'lineHeight', 'opacity', 'zIndex']);
  return Object.entries(s)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      const value = typeof v === 'number' && !unitless.has(k) ? `${v}px` : String(v);
      return `${prop}:${value}`;
    })
    .join(';');
}

export function fieldText(type: string, text: string, env: TextEnv): string {
  if (type === 'slidenum') return String(env.slideNumber);
  if (type.startsWith('datetime')) {
    const d = new Date();
    if (type === 'datetime1' || type === 'datetime') return d.toLocaleDateString('en-US');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  return text;
}

/** Bullets, and paragraph boxes, shared by static and editing text. */
export const SLIDE_CSS = `
.sl-text p.sl-p, .sl-text div.sl-p { margin-left: 0; margin-right: 0; white-space: pre-wrap; overflow-wrap: break-word; }
.sl-text .sl-p:first-child { margin-top: 0 !important; }
.sl-text.sl-nowrap .sl-p { white-space: pre; }
.sl-text .sl-p[data-bu]::before {
  content: attr(data-bu); display: inline-block; min-width: var(--bu-w, auto); padding-right: var(--bu-gap, 0px);
  font-family: var(--bu-font, inherit); font-size: var(--bu-size, inherit); color: var(--bu-color, inherit);
  font-weight: var(--bu-weight, 400); font-style: normal; text-indent: 0; text-decoration: none; white-space: pre;
}
.sl-text .ProseMirror { outline: none; white-space: pre-wrap; word-wrap: break-word; caret-color: auto; }
.sl-text .ProseMirror ::selection { background: rgba(160, 196, 255, 0.55); }
.sl-text .ProseMirror-trailingBreak { line-height: inherit; }
`;
