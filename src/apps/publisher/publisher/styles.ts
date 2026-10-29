import { all, child, docVersion, num, partRoot, prop, propEl } from './idml';

/**
 * Paragraph, character and object styles from Resources/Styles.xml, and how
 * text gets its look: the character range's own settings, then its character
 * style and what that's based on, then the paragraph range's, its paragraph
 * style and its BasedOn chain down to [No paragraph style].
 */

export interface StyleInfo {
  self: string;
  name: string;
  /** Group path, for the panels ("Body:Captions"). */
  group: string;
  basedOn: string | null;
  el: Element;
}

export interface Styles {
  para: Map<string, StyleInfo>;
  char: Map<string, StyleInfo>;
  object: Map<string, StyleInfo>;
  paraList: StyleInfo[];
  charList: StyleInfo[];
  objectList: StyleInfo[];
}

const CACHE = new WeakMap<XMLDocument, { version: number; styles: Styles }>();

export const cleanName = (s: string | null | undefined) => (s ?? '').replace(/^\$ID\//, '');

function basedOnRef(el: Element, kind: string): string | null {
  const b = prop(el, 'BasedOn');
  if (!b || b === 'n' || b === '$ID/') return null;
  if (b.startsWith(`${kind}/`)) return b;
  return `${kind}/${b}`;
}

export function readStyles(doc: XMLDocument | undefined): Styles {
  const empty: Styles = { para: new Map(), char: new Map(), object: new Map(), paraList: [], charList: [], objectList: [] };
  if (!doc) return empty;
  const hit = CACHE.get(doc);
  if (hit && hit.version === docVersion(doc)) return hit.styles;
  const root = partRoot(doc) ?? doc.documentElement;
  const collect = (tag: string, kind: string, map: Map<string, StyleInfo>, list: StyleInfo[]) => {
    for (const el of all(root, tag)) {
      const self = el.getAttribute('Self') ?? '';
      const groups: string[] = [];
      for (let p = el.parentElement; p && !p.localName.startsWith('Root'); p = p.parentElement) groups.unshift(cleanName(p.getAttribute('Name')));
      const full = cleanName(el.getAttribute('Name') ?? self.slice(kind.length + 1));
      // Styles in groups are named with their group path ("Body:Caption"); the panels show the last part.
      const name = groups.length && full.startsWith(`${groups.join(':')}:`) ? full.slice(groups.join(':').length + 1) : full;
      const info = { self, name, group: groups.join(':'), basedOn: basedOnRef(el, kind), el };
      map.set(self, info);
      list.push(info);
    }
  };
  collect('ParagraphStyle', 'ParagraphStyle', empty.para, empty.paraList);
  collect('CharacterStyle', 'CharacterStyle', empty.char, empty.charList);
  collect('ObjectStyle', 'ObjectStyle', empty.object, empty.objectList);
  CACHE.set(doc, { version: docVersion(doc), styles: empty });
  return empty;
}

/** A style and the styles it's based on, nearest first. */
export function chain(map: Map<string, StyleInfo>, self: string | null | undefined, root?: string): Element[] {
  const out: Element[] = [];
  const seen = new Set<string>();
  let s = self && self !== 'n' ? self : null;
  while (s && !seen.has(s)) {
    seen.add(s);
    const info = map.get(s) ?? map.get(s.replace(/^(\w+Style)\/(?!\$ID\/)/, '$1/$ID/'));
    if (!info) break;
    out.push(info.el);
    s = info.basedOn;
  }
  if (root && !seen.has(root)) {
    const r = map.get(root);
    if (r) out.push(r.el);
  }
  return out;
}

/** The first of these elements that sets the value. */
export function lookup(els: readonly Element[], name: string): string | null {
  for (const e of els) {
    const v = prop(e, name);
    if (v !== null) return v;
  }
  return null;
}

export function lookupEl(els: readonly Element[], name: string): Element | null {
  for (const e of els) {
    const v = e.getAttribute(name) !== null ? e : propEl(e, name);
    if (v) return v;
  }
  return null;
}

// ---- Text ---------------------------------------------------------------------------

export type Caps = 'Normal' | 'AllCaps' | 'SmallCaps' | 'CapToSmallCap';

export interface CharLook {
  font: string;
  fontStyle: string;
  size: number;
  /** Points, or null for Auto. */
  leading: number | null;
  autoLeading: number;
  tracking: number;
  hscale: number;
  vscale: number;
  baselineShift: number;
  caps: Caps;
  position: string;
  fill: string | null;
  fillTint: number;
  stroke: string | null;
  strokeTint: number;
  strokeWeight: number;
  underline: boolean;
  strike: boolean;
  skew: number;
  noBreak: boolean;
  charStyle: string;
}

export interface TabStop {
  position: number;
  alignment: 'LeftAlign' | 'RightAlign' | 'CenterAlign' | 'CharacterAlign';
  leader: string;
  alignOn: string;
}

export interface Rule {
  on: boolean;
  weight: number;
  color: string | null;
  tint: number;
  offset: number;
  left: number;
  right: number;
  width: 'ColumnWidth' | 'TextWidth';
}

export interface ParaLook {
  style: string;
  justification: string;
  leftIndent: number;
  rightIndent: number;
  firstIndent: number;
  lastIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  tabs: TabStop[];
  dropChars: number;
  dropLines: number;
  startParagraph: string;
  ruleAbove: Rule;
  ruleBelow: Rule;
  list: 'NoList' | 'BulletList' | 'NumberedList';
  bullet: string;
  bulletAfter: string;
  numberExpr: string;
  numberFormat: string;
  numberStart: number;
  numberContinue: boolean;
  keepWithNext: number;
  /** Space between paragraphs of the same style, instead of before and after (null: not used). */
  sameStyleSpacing: number | null;
  shading: { on: boolean; color: string | null; tint: number };
}

const bool = (s: string | null) => s === 'true';

function rule(els: readonly Element[], which: 'Above' | 'Below', fallbackColor: string | null): Rule {
  const color = lookup(els, `Rule${which}Color`);
  return {
    on: bool(lookup(els, `Rule${which}`)),
    weight: num(lookup(els, `Rule${which}LineWeight`), 1),
    color: !color || color === 'Text Color' ? fallbackColor : color,
    tint: num(lookup(els, `Rule${which}Tint`), -1),
    offset: num(lookup(els, `Rule${which}Offset`)),
    left: num(lookup(els, `Rule${which}LeftIndent`)),
    right: num(lookup(els, `Rule${which}RightIndent`)),
    width: lookup(els, `Rule${which}Width`) === 'TextWidth' ? 'TextWidth' : 'ColumnWidth',
  };
}

function tabs(els: readonly Element[]): TabStop[] {
  const t = lookupEl(els, 'TabList');
  if (!t) return [];
  const out: TabStop[] = [];
  for (const item of Array.from(t.children)) {
    const pos = item.querySelector('Position');
    const al = item.querySelector('Alignment');
    if (!pos) continue;
    out.push({
      position: num(pos.textContent),
      alignment: (al?.textContent as TabStop['alignment']) || 'LeftAlign',
      leader: item.querySelector('Leader')?.textContent ?? '',
      alignOn: item.querySelector('AlignmentCharacter')?.textContent ?? '.',
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

/** The elements whose settings a character range sees, nearest first. */
export function textChain(styles: Styles, csr: Element | null, psr: Element | null): Element[] {
  const out: Element[] = [];
  if (csr) {
    out.push(csr);
    out.push(...chain(styles.char, csr.getAttribute('AppliedCharacterStyle')));
  }
  if (psr) {
    out.push(psr);
    out.push(...chain(styles.para, psr.getAttribute('AppliedParagraphStyle') ?? 'ParagraphStyle/$ID/NormalParagraphStyle', 'ParagraphStyle/$ID/[No paragraph style]'));
  } else {
    out.push(...chain(styles.para, 'ParagraphStyle/$ID/NormalParagraphStyle', 'ParagraphStyle/$ID/[No paragraph style]'));
  }
  return out;
}

export function paraChain(styles: Styles, psr: Element | null): Element[] {
  return textChain(styles, null, psr);
}

export function charLook(els: readonly Element[]): CharLook {
  const leading = lookup(els, 'Leading');
  const fill = lookup(els, 'FillColor');
  const stroke = lookup(els, 'StrokeColor');
  return {
    font: cleanName(lookup(els, 'AppliedFont')) || 'Minion Pro',
    fontStyle: cleanName(lookup(els, 'FontStyle')) || 'Regular',
    size: num(lookup(els, 'PointSize'), 12),
    leading: !leading || leading === 'Auto' ? null : num(leading, 14.4),
    autoLeading: num(lookup(els, 'AutoLeading'), 120),
    tracking: num(lookup(els, 'Tracking')),
    hscale: num(lookup(els, 'HorizontalScale'), 100),
    vscale: num(lookup(els, 'VerticalScale'), 100),
    baselineShift: num(lookup(els, 'BaselineShift')),
    caps: (lookup(els, 'Capitalization') as Caps) || 'Normal',
    position: lookup(els, 'Position') || 'Normal',
    fill: fill === null ? 'Color/Black' : fill,
    fillTint: num(lookup(els, 'FillTint'), -1),
    stroke: stroke === null || stroke === 'Swatch/None' ? null : stroke,
    strokeTint: num(lookup(els, 'StrokeTint'), -1),
    strokeWeight: num(lookup(els, 'StrokeWeight'), 1),
    underline: bool(lookup(els, 'Underline')),
    strike: bool(lookup(els, 'StrikeThru')),
    skew: num(lookup(els, 'Skew')),
    noBreak: bool(lookup(els, 'NoBreak')),
    charStyle: els[0]?.localName === 'CharacterStyleRange' ? (els[0].getAttribute('AppliedCharacterStyle') ?? '') : '',
  };
}

export function paraLook(els: readonly Element[], textColor: string | null): ParaLook {
  const psr = els.find((e) => e.localName === 'ParagraphStyleRange');
  const bulletEl = lookupEl(els, 'BulletChar');
  const bv = bulletEl ? num(bulletEl.getAttribute('BulletCharacterValue'), 8226) : 8226;
  const shadingColor = lookup(els, 'ParagraphShadingColor');
  return {
    style: psr?.getAttribute('AppliedParagraphStyle') ?? 'ParagraphStyle/$ID/NormalParagraphStyle',
    justification: lookup(els, 'Justification') || 'LeftAlign',
    leftIndent: num(lookup(els, 'LeftIndent')),
    rightIndent: num(lookup(els, 'RightIndent')),
    firstIndent: num(lookup(els, 'FirstLineIndent')),
    lastIndent: num(lookup(els, 'LastLineIndent')),
    spaceBefore: num(lookup(els, 'SpaceBefore')),
    spaceAfter: num(lookup(els, 'SpaceAfter')),
    tabs: tabs(els),
    dropChars: num(lookup(els, 'DropCapCharacters')),
    dropLines: num(lookup(els, 'DropCapLines')),
    startParagraph: lookup(els, 'StartParagraph') || 'Anywhere',
    ruleAbove: rule(els, 'Above', textColor),
    ruleBelow: rule(els, 'Below', textColor),
    list: (lookup(els, 'BulletsAndNumberingListType') as ParaLook['list']) || 'NoList',
    bullet: String.fromCodePoint(bv > 0 && bv < 0x110000 ? bv : 8226),
    bulletAfter: unescapeMeta(lookup(els, 'BulletsTextAfter') ?? '^t'),
    numberExpr: lookup(els, 'NumberingExpression') ?? '^#.^t',
    numberFormat: lookup(els, 'NumberingFormat') ?? '1, 2, 3, 4...',
    numberStart: num(lookup(els, 'NumberingStartAt'), 1),
    numberContinue: lookup(els, 'NumberingContinue') !== 'false',
    keepWithNext: num(lookup(els, 'KeepWithNext')),
    sameStyleSpacing: ((v) => (v === null || v === 'Ignore' || v === '' ? null : num(v)))(lookup(els, 'SameParaStyleSpacing')),
    shading: { on: bool(lookup(els, 'ParagraphShadingOn')), color: shadingColor, tint: num(lookup(els, 'ParagraphShadingTint'), 20) },
  };
}

/** InDesign's ^-codes in bullet and numbering text. */
export function unescapeMeta(s: string): string {
  return s.replace(/\^t/g, '\t').replace(/\^>/g, '\u2002').replace(/\^m/g, '\u2003').replace(/\^s/g, '\u00a0').replace(/\^\^/g, '^');
}

export function formatNumber(n: number, format: string): string {
  if (/^a/i.test(format)) {
    let s = '';
    let v = n;
    while (v > 0) {
      v--;
      s = String.fromCharCode(97 + (v % 26)) + s;
      v = Math.floor(v / 26);
    }
    return format.startsWith('A') ? s.toUpperCase() : s;
  }
  if (/^i/i.test(format)) {
    const romans: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    let v = n;
    for (const [k, r] of romans) while (v >= k) {
      s += r;
      v -= k;
    }
    return format.startsWith('I') ? s.toUpperCase() : s;
  }
  if (/^0/.test(format)) return String(n).padStart(2, '0');
  return String(n);
}

// ---- Fonts --------------------------------------------------------------------------

const SERIF = /minion|garamond|times|caslon|palatino|georgia|baskerville|chaparral|utopia|warnock|arno|sabon|bembo|cambria|book antiqua|kepler|bodoni|didot|jenson|janson|century|serif|tinos|caladea|plantin|perpetua|goudy|trajan|mercury|miller|charter|cheltenham|clarendon|rockwell|courier|lora|merriweather|playfair|crimson|libre baskerville|source serif|noto serif|droid serif|pt serif|roman|antiqua/i;
const MONO = /mono|courier|consolas|cousine|code|typewriter|letter gothic|andale/i;
const CONDENSED = /bebas|league gothic|oswald|impact|haettenschweiler|compacta|knockout|condensed|compressed|narrow|ultra ?cond|extra ?cond|bernard|anton|fjalla|teko|six caps|alternate gothic|news gothic cond|tungsten/i;
const SCRIPT = /script|brush|hand|marker|comic|pacifico|lobster|zapfino|bickham|kuenstler|vivaldi|edwardian|mistral|segoe print|caflisch|poetica|chalk/i;

/** Narrow display faces, by how wide they set against the sans substitute. */
const WIDTHS: Record<string, number> = {
  birch: 0.5,
  mesquite: 0.6,
  bebas: 0.62,
  'league gothic': 0.6,
  oswald: 0.72,
  impact: 0.8,
  haettenschweiler: 0.6,
  'franklin gothic cond': 0.75,
  'news gothic cond': 0.75,
  'trade gothic cond': 0.72,
  'univers cond': 0.75,
  'din condensed': 0.72,
  'helvetica condensed': 0.8,
  'arial narrow': 0.82,
  'myriad pro cond': 0.8,
  'bernard': 0.7,
  'compacta': 0.6,
  'knockout': 0.65,
  'anton': 0.7,
  'fjalla': 0.75,
  'teko': 0.6,
};

/** Free fonts made to the same widths as common commercial ones, so lines break where they did. */
const METRIC: Record<string, string> = {
  calibri: 'Carlito',
  'calibri light': 'Carlito',
  candara: 'Carlito',
  cambria: 'Caladea',
  arial: 'Arimo',
  'arial mt': 'Arimo',
  arialmt: 'Arimo',
  helvetica: 'Arimo',
  'helvetica neue': 'Arimo',
  'liberation sans': 'Arimo',
  'times new roman': 'Tinos',
  times: 'Tinos',
  'times roman': 'Tinos',
  'liberation serif': 'Tinos',
  'courier new': 'Cousine',
  courier: 'Cousine',
  'segoe ui': 'Inter Variable',
  'myriad pro': 'Arimo',
};

/** How a document font is drawn here: CSS family stack, weight, slant, and a width to fake condensed faces. */
export interface WebFont {
  family: string;
  weight: number;
  italic: boolean;
  /** Extra horizontal scale for condensed faces drawn with a normal-width substitute. */
  width: number;
}

const FONT_CACHE = new Map<string, WebFont>();

export function webFont(font: string, style: string): WebFont {
  const key = `${font}\u0000${style}`;
  const hit = FONT_CACHE.get(key);
  if (hit) return hit;
  const f = font.replace(/[^\p{L}\p{N} \-_.&+]/gu, '').trim() || 'Minion Pro';
  const s = style.toLowerCase();
  const both = `${f} ${style}`;
  const weight = /thin|hairline/.test(s)
    ? 100
    : /extra ?light|ultra ?light/.test(s)
      ? 200
      : /light/.test(s)
        ? 300
        : /medium/.test(s)
          ? 500
          : /semi ?bold|demi/.test(s)
            ? 600
            : /extra ?bold|ultra ?bold|heavy/.test(s)
              ? 800
              : /black|ultra/.test(s)
                ? 900
                : /bold/.test(s)
                  ? 700
                  : 400;
  const italic = /italic|oblique|kursiv/.test(s);
  const metric = METRIC[f.toLowerCase()];
  const sub = metric
    ? `"${metric}", ${metric === 'Tinos' || metric === 'Caladea' ? 'serif' : metric === 'Cousine' ? 'monospace' : 'sans-serif'}`
    : MONO.test(f) ? '"Cousine", monospace' : SERIF.test(f) && !/sans/i.test(f) ? '"Tinos", "Noto Serif", serif' : SCRIPT.test(f) ? '"Tinos", serif' : '"Arimo", "Noto Sans", sans-serif';
  const known = Object.entries(WIDTHS).find(([k]) => f.toLowerCase().includes(k))?.[1];
  const width = known ?? (CONDENSED.test(both) && !/semi ?cond/i.test(both) ? (/compressed|six caps|tungsten/i.test(both) ? 0.62 : 0.78) : /semi ?cond/i.test(both) ? 0.9 : 1);
  const wf: WebFont = { family: `"${f}", ${sub}`, weight, italic: italic || (SCRIPT.test(f) && !/upright/i.test(s)), width };
  FONT_CACHE.set(key, wf);
  return wf;
}

/** A canvas font string at a size. */
export const cssFont = (wf: WebFont, size: number) => `${wf.italic ? 'italic ' : ''}${wf.weight} ${size}px ${wf.family}`;

// ---- Object styles --------------------------------------------------------------------

export function objectChain(styles: Styles, item: Element): Element[] {
  const out: Element[] = [item];
  const os = item.getAttribute('AppliedObjectStyle');
  if (os && os !== 'n') out.push(...chain(styles.object, os));
  return out;
}

/** A child preference (TextFramePreference, TextWrapPreference...) as the item and its object style set it. */
export function childChain(els: readonly Element[], name: string): Element[] {
  const out: Element[] = [];
  for (const e of els) {
    const c = child(e, name);
    if (c) out.push(c);
  }
  return out;
}
