import { at, attr, kid, kids, numAttr, twipToPx } from '../ooxml';

/**
 * Word's lists (numbering.xml). A list paragraph names a numbering instance
 * (numId) and a level; the instance points at an abstract definition whose
 * levels say how to number (1., a), i., •), where the label goes, and the
 * indents. Paragraphs stay flat, as in Word, and their labels are worked out
 * by counting down the document.
 */

export interface Level {
  start: number;
  fmt: string;
  text: string;
  /** Pixels. */
  indLeft: number;
  hanging: number;
  font?: string;
}

interface Num {
  abstractId: number;
  starts: Map<number, number>;
  levels: Map<number, Level>;
}

export interface Numbering {
  abstracts: Map<number, Level[]>;
  nums: Map<number, Num>;
  /** Definitions added here, as XML to put into numbering.xml on save. */
  addedAbstracts: string[];
  addedNums: string[];
}

export type BulletKind = 'disc' | 'circle' | 'square' | 'diamond' | 'arrow' | 'check';
export type NumberKind = '1.' | '1)' | 'I.' | 'A.' | 'a)' | 'a.' | 'i.';

/** Symbol and Wingdings bullets live in the Private Use Area: what they look like. */
const PUA: Record<string, Record<number, string>> = {
  symbol: { 0xb7: '•', 0xa8: '♦', 0xa7: '♣', 0xa9: '♥', 0xaa: '♠', 0xde: '⇒', 0xae: '→', 0xd8: '¬' },
  wingdings: { 0xa7: '▪', 0xd8: '➢', 0xfc: '✓', 0x76: '❖', 0x6c: '●', 0x6e: '■', 0xa8: '◻', 0x71: '❑', 0xfb: '✗', 0x9f: '•', 0xe0: '➔', 0xe8: '➔', 0x4a: '☺', 0x3f: '✂' },
};

export function bulletGlyph(text: string, font?: string): string {
  if (!text) return '';
  const code = text.codePointAt(0)!;
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  const f = (font ?? '').toLowerCase();
  if (f.includes('wingdings')) return PUA.wingdings[low] ?? '•';
  if (f === 'symbol') return PUA.symbol[low] ?? '•';
  if (code >= 0xf000 && code <= 0xf0ff) return PUA.symbol[low] ?? PUA.wingdings[low] ?? '•';
  if (text === 'o' && f.startsWith('courier')) return '○';
  return text;
}

function readLevel(el: Element): Level {
  const ind = at(el, 'pPr', 'ind');
  const hanging = numAttr(ind, 'hanging');
  const first = numAttr(ind, 'firstLine');
  return {
    start: numAttr(kid(el, 'start'), 'val') ?? 1,
    fmt: attr(kid(el, 'numFmt'), 'val') ?? 'decimal',
    text: attr(kid(el, 'lvlText'), 'val') ?? '',
    indLeft: twipToPx(numAttr(ind, 'left') ?? numAttr(ind, 'start') ?? 0),
    hanging: twipToPx(hanging ?? (first !== null ? -first : 0)),
    font: attr(at(el, 'rPr', 'rFonts'), 'ascii') ?? attr(at(el, 'rPr', 'rFonts'), 'hAnsi') ?? undefined,
  };
}

export function parseNumbering(doc: Document | null): Numbering {
  const n: Numbering = { abstracts: new Map(), nums: new Map(), addedAbstracts: [], addedNums: [] };
  if (!doc) return n;
  const root = doc.documentElement;
  for (const a of kids(root, 'abstractNum')) {
    const id = numAttr(a, 'abstractNumId');
    if (id === null) continue;
    const levels: Level[] = [];
    for (const lvl of kids(a, 'lvl')) levels[numAttr(lvl, 'ilvl') ?? levels.length] = readLevel(lvl);
    n.abstracts.set(id, levels);
  }
  for (const num of kids(root, 'num')) {
    const id = numAttr(num, 'numId');
    const abstractId = numAttr(kid(num, 'abstractNumId'), 'val');
    if (id === null || abstractId === null) continue;
    const entry: Num = { abstractId, starts: new Map(), levels: new Map() };
    for (const o of kids(num, 'lvlOverride')) {
      const ilvl = numAttr(o, 'ilvl') ?? 0;
      const start = numAttr(kid(o, 'startOverride'), 'val');
      if (start !== null) entry.starts.set(ilvl, start);
      const lvl = kid(o, 'lvl');
      if (lvl) entry.levels.set(ilvl, readLevel(lvl));
    }
    n.nums.set(id, entry);
  }
  return n;
}

export function levelOf(n: Numbering, numId: number | null | undefined, ilvl: number): Level | null {
  if (!numId) return null;
  const num = n.nums.get(numId);
  if (!num) return null;
  const level = num.levels.get(ilvl) ?? n.abstracts.get(num.abstractId)?.[ilvl];
  if (!level) return null;
  const start = num.starts.get(ilvl);
  return start === undefined ? level : { ...level, start };
}

/**
 * Lists sharing a definition count together in Word, unless an instance
 * restarts a level with a start override.
 */
export function counterKey(n: Numbering, numId: number): number {
  const num = n.nums.get(numId);
  return num ? num.abstractId : -numId;
}

export function hasStartOverride(n: Numbering, numId: number, ilvl: number): boolean {
  return n.nums.get(numId)?.starts.has(ilvl) ?? false;
}

export function isBulleted(n: Numbering, numId: number | null | undefined): boolean {
  return levelOf(n, numId, 0)?.fmt === 'bullet';
}

function roman(num: number): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of table) {
    while (num >= v) {
      out += s;
      num -= v;
    }
  }
  return out;
}

function letters(num: number): string {
  // Word repeats the letter: a..z, aa..zz, aaa...
  const letter = String.fromCharCode(97 + ((num - 1) % 26));
  return letter.repeat(Math.floor((num - 1) / 26) + 1);
}

export function formatNumber(value: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter': return letters(value);
    case 'upperLetter': return letters(value).toUpperCase();
    case 'lowerRoman': return roman(value);
    case 'upperRoman': return roman(value).toUpperCase();
    case 'decimalZero': return value < 10 ? `0${value}` : String(value);
    case 'ordinal': return `${value}${['th', 'st', 'nd', 'rd'][value % 100 > 10 && value % 100 < 14 ? 0 : Math.min(value % 10, 4) % 4] ?? 'th'}`;
    case 'none': return '';
    default: return String(value);
  }
}

/** The label for a list paragraph, given the counters of every level above and at it. */
export function labelText(n: Numbering, numId: number, ilvl: number, counters: number[]): string {
  const level = levelOf(n, numId, ilvl);
  if (!level) return '';
  if (level.fmt === 'bullet') return bulletGlyph(level.text, level.font);
  return level.text.replace(/%(\d)/g, (_, d: string) => {
    const i = Number(d) - 1;
    const lv = levelOf(n, numId, i);
    return formatNumber(counters[i] ?? lv?.start ?? 1, lv?.fmt ?? 'decimal');
  });
}

// ---- New lists -------------------------------------------------------------------

const BULLETS: Record<BulletKind, [string, string][]> = {
  disc: [['\uF0B7', 'Symbol'], ['o', 'Courier New'], ['\uF0A7', 'Wingdings']],
  circle: [['o', 'Courier New'], ['\uF0A7', 'Wingdings'], ['\uF0B7', 'Symbol']],
  square: [['\uF0A7', 'Wingdings'], ['\uF0B7', 'Symbol'], ['o', 'Courier New']],
  diamond: [['\uF076', 'Wingdings'], ['o', 'Courier New'], ['\uF0A7', 'Wingdings']],
  arrow: [['\uF0D8', 'Wingdings'], ['o', 'Courier New'], ['\uF0A7', 'Wingdings']],
  check: [['\uF0FC', 'Wingdings'], ['o', 'Courier New'], ['\uF0A7', 'Wingdings']],
};

const NUMBERS: Record<NumberKind, [string, string]> = {
  '1.': ['decimal', '%1.'],
  '1)': ['decimal', '%1)'],
  'I.': ['upperRoman', '%1.'],
  'A.': ['upperLetter', '%1.'],
  'a)': ['lowerLetter', '%1)'],
  'a.': ['lowerLetter', '%1.'],
  'i.': ['lowerRoman', '%1.'],
};

/** What each bullet looks like, for the Bullet Library. */
export function bulletPreview(kind: BulletKind): string {
  const [text, font] = BULLETS[kind][0];
  return bulletGlyph(text, font);
}

function nextId(used: Iterable<number>): number {
  let max = 0;
  for (const id of used) max = Math.max(max, id);
  return max + 1;
}

/** Start a new list (a new definition and instance) and return its numId. */
export function newList(n: Numbering, kind: { bullet: BulletKind } | { number: NumberKind }): number {
  const abstractId = nextId(n.abstracts.keys());
  const numId = nextId(n.nums.keys());
  const levels: Level[] = [];
  const xmlLevels: string[] = [];
  for (let i = 0; i < 9; i++) {
    const left = 720 * (i + 1);
    let fmt: string;
    let text: string;
    let font: string | undefined;
    if ('bullet' in kind) {
      [text, font] = BULLETS[kind.bullet][i % 3];
      fmt = 'bullet';
    } else {
      // Deeper levels go 1. a. i. as Word's numbering does.
      const [f0, t0] = NUMBERS[kind.number];
      const cycle: [string, string][] = [[f0, t0], ['lowerLetter', '%L.'], ['lowerRoman', '%L.']];
      [fmt, text] = cycle[i % 3];
      text = text.replace('%1', `%${i + 1}`).replace('%L', `%${i + 1}`);
    }
    const hanging = 360;
    levels.push({ start: 1, fmt, text, indLeft: twipToPx(left), hanging: twipToPx(hanging), font });
    const xmlText = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    xmlLevels.push(
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${xmlText}"/><w:lvlJc w:val="${fmt === 'lowerRoman' ? 'right' : 'left'}"/><w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr>${
        font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : ''
      }</w:lvl>`,
    );
  }
  n.abstracts.set(abstractId, levels);
  n.nums.set(numId, { abstractId, starts: new Map(), levels: new Map() });
  n.addedAbstracts.push(`<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${xmlLevels.join('')}</w:abstractNum>`);
  n.addedNums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`);
  return numId;
}

/** Restart numbering: a new instance of the same definition, starting at `start`. */
export function restartList(n: Numbering, numId: number, start = 1): number {
  const num = n.nums.get(numId);
  if (!num) return numId;
  const id = nextId(n.nums.keys());
  n.nums.set(id, { abstractId: num.abstractId, starts: new Map([[0, start]]), levels: new Map() });
  n.addedNums.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${num.abstractId}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`);
  return id;
}

/** Which bullet or number style a list uses, to tick it in the library menus. */
export function listKind(n: Numbering, numId: number | null): string | null {
  const lv = levelOf(n, numId, 0);
  if (!lv) return null;
  if (lv.fmt === 'bullet') return bulletGlyph(lv.text, lv.font);
  return `${lv.fmt}:${lv.text}`;
}

export function numberKindKey(kind: NumberKind): string {
  return `${NUMBERS[kind][0]}:${NUMBERS[kind][1]}`;
}

/** numbering.xml with the lists added here merged in. */
export function numberingXml(original: string | null, n: Numbering): string | null {
  if (!n.addedAbstracts.length && !n.addedNums.length) return original;
  const base =
    original ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>';
  // Every abstractNum comes before the first num.
  const firstNum = base.search(/<w:num[\s>]/);
  const close = base.lastIndexOf('</w:numbering>');
  let out: string;
  if (firstNum >= 0) out = base.slice(0, firstNum) + n.addedAbstracts.join('') + base.slice(firstNum, close) + n.addedNums.join('') + base.slice(close);
  else if (close >= 0) out = base.slice(0, close) + n.addedAbstracts.join('') + n.addedNums.join('') + base.slice(close);
  else out = base.replace(/<w:numbering([^>]*)\/>/, `<w:numbering$1>${n.addedAbstracts.join('')}${n.addedNums.join('')}</w:numbering>`);
  return out;
}
