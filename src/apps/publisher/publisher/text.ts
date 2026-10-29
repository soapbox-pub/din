import { setProp } from './idml';

/**
 * Story text as a flat string over the Story XML, and edits made straight
 * in that XML: typing goes into <Content>, Enter adds <Br/> (a paragraph
 * break in IDML), formatting splits CharacterStyleRanges, paragraph settings
 * split ParagraphStyleRanges at paragraph ends. Whatever else a story holds
 * (XML structure, hyperlinks, notes, tables, anchored frames) stays where it
 * was; those show up in the flat text as one object character.
 */

export type SegKind = 'text' | 'br' | 'obj' | 'pi';

export interface Seg {
  start: number;
  len: number;
  kind: SegKind;
  node: Node;
  csr: Element | null;
  psr: Element | null;
}

export interface Para {
  start: number;
  /** Past its break (or the story's end). */
  end: number;
  psr: Element | null;
}

export interface Flat {
  story: Element;
  text: string;
  segs: Seg[];
  paras: Para[];
}

/** Story children that aren't text. */
const SKIP = new Set([
  'StoryPreference',
  'InCopyExportOption',
  'Properties',
  'XMLAttribute',
  'XMLComment',
  'XMLInstruction',
  'HyperlinkTextDestination',
  'PageReference',
  'Bookmark',
  'DTD',
]);

/** Elements whose children are part of the text. */
const FLOW = new Set(['XMLElement', 'HyperlinkTextSource', 'Change', 'CrossReferenceSource', 'Story', 'ParagraphDestination', 'HiddenText']);

/** Special characters InDesign writes as processing instructions. */
export const PAGE_NUMBER = '\u0018';
export const NEXT_PAGE_NUMBER = '\u0019';
export const RIGHT_INDENT_TAB = '\u0008';
export const INDENT_HERE = '\u0007';
export const OBJECT = '\ufffc';

function piChar(pi: ProcessingInstruction): string {
  if (pi.target !== 'ACE') return '\u0001';
  switch (pi.data.trim()) {
    case '18':
      return PAGE_NUMBER;
    case '19':
      return NEXT_PAGE_NUMBER;
    case '8':
      return RIGHT_INDENT_TAB;
    case '7':
      return INDENT_HERE;
    case '3':
      return '\u0003';
    default:
      return '\u0001';
  }
}

export function flatten(story: Element): Flat {
  const segs: Seg[] = [];
  const out: string[] = [];
  let pos = 0;
  const push = (kind: SegKind, node: Node, s: string, csr: Element | null, psr: Element | null) => {
    segs.push({ start: pos, len: s.length, kind, node, csr, psr });
    out.push(s);
    pos += s.length;
  };
  const walk = (node: Element, csr: Element | null, psr: Element | null) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      const name = e.localName;
      if (name === 'ParagraphStyleRange') walk(e, null, e);
      else if (name === 'CharacterStyleRange') walk(e, e, psr);
      else if (name === 'Content') {
        for (let t = e.firstChild; t; t = t.nextSibling) {
          if (t.nodeType === 3 || t.nodeType === 4) {
            const s = (t as Text).data;
            if (s) push('text', t, s, csr, psr);
          } else if (t.nodeType === 7) push('pi', t, piChar(t as ProcessingInstruction), csr, psr);
        }
      } else if (name === 'Br') push('br', e, '\r', csr, psr);
      else if (SKIP.has(name)) continue;
      else if (FLOW.has(name)) walk(e, csr, psr);
      else push('obj', e, OBJECT, csr, psr);
    }
  };
  walk(story, null, null);
  const text = out.join('');
  const paras: Para[] = [];
  let si = 0;
  const psrAt = (p: number): Element | null => {
    while (si < segs.length && segs[si].start + segs[si].len <= p) si++;
    // Past the end (an empty last paragraph): the break before it.
    return segs[si]?.psr ?? segs[segs.length - 1]?.psr ?? firstPsr(story);
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\r') continue;
    paras.push({ start, end: i + 1, psr: psrAt(start) });
    start = i + 1;
  }
  // The last paragraph; empty when the story ends with a break.
  paras.push({ start, end: text.length, psr: psrAt(start) });
  return { story, text, segs, paras };
}

function firstPsr(story: Element): Element | null {
  return story.getElementsByTagName('ParagraphStyleRange')[0] ?? null;
}

/** The segment whose look a position has: the character before it, or at a paragraph's start the one after. */
export function segAt(f: Flat, pos: number): Seg | null {
  if (!f.segs.length) return null;
  const atParaStart = pos === 0 || f.text[pos - 1] === '\r';
  if (!atParaStart) {
    for (const s of f.segs) if (s.start < pos && pos <= s.start + s.len) return s;
  }
  for (const s of f.segs) if (s.start <= pos && pos < s.start + s.len) return s;
  return f.segs[f.segs.length - 1];
}

export const paraIndexAt = (f: Flat, pos: number) => {
  for (let i = 0; i < f.paras.length - 1; i++) if (pos < f.paras[i].end) return i;
  return f.paras.length - 1;
};

/** Plain text for the clipboard. */
export function plainText(f: Flat, a: number, b: number): string {
  return f.text
    .slice(a, b)
    .replace(/\r/g, '\n')
    .replace(/\u2028/g, '\n')
    .split('')
    .map((c) => (c === PAGE_NUMBER ? '#' : (c.charCodeAt(0) < 0x20 && c !== '\t' && c !== '\n') || c === '\ufeff' || c === OBJECT ? '' : c))
    .join('');
}

// ---- Edits ------------------------------------------------------------------------------

/** What can be typed into a story: no control characters (XML can't hold them) but tabs and breaks. */
export function cleanTyped(s: string): string {
  let out = '';
  for (const c of s) {
    const k = c.charCodeAt(0);
    if (k >= 0x20 || c === '\t' || c === '\r') out += c;
  }
  return out;
}

const isContent = (n: Node | null): n is Element => !!n && n.nodeType === 1 && (n as Element).localName === 'Content';

function newContent(doc: Document, text?: string): Element {
  const c = doc.createElement('Content');
  if (text) c.appendChild(doc.createTextNode(text));
  return c;
}

/** Splits a <Content> before one of its children; the second half is returned. */
function splitContentBefore(content: Element, before: Node): Element {
  const second = content.cloneNode(false) as Element;
  let n: Node | null = before;
  while (n) {
    const next: Node | null = n.nextSibling;
    second.appendChild(n);
    n = next;
  }
  content.after(second);
  return second;
}

function ensureCsr(story: Element): Element {
  const doc = story.ownerDocument;
  let csr = story.getElementsByTagName('CharacterStyleRange')[0];
  if (csr) return csr;
  let psr = firstPsr(story);
  if (!psr) {
    psr = doc.createElement('ParagraphStyleRange');
    psr.setAttribute('AppliedParagraphStyle', 'ParagraphStyle/$ID/NormalParagraphStyle');
    story.appendChild(psr);
  }
  csr = doc.createElement('CharacterStyleRange');
  csr.setAttribute('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]');
  psr.appendChild(csr);
  return csr;
}

/** Puts an element at a position in the text, splitting a <Content> if it falls inside one. */
function insertNodeAt(f: Flat, pos: number, node: Element) {
  const inside = f.segs.find((s) => s.kind === 'text' && s.start < pos && pos < s.start + s.len);
  if (inside) {
    const rest = (inside.node as Text).splitText(pos - inside.start);
    const content = rest.parentNode as Element;
    const second = splitContentBefore(content, rest);
    second.before(node);
    return;
  }
  const atParaStart = pos === 0 || f.text[pos - 1] === '\r';
  const prev = f.segs.find((s) => s.start + s.len === pos);
  const next = f.segs.find((s) => s.start === pos);
  const after = (seg: Seg) => {
    const parent = seg.node.parentNode as Element | null;
    if (isContent(parent)) {
      if (seg.node.nextSibling) splitContentBefore(parent, seg.node.nextSibling);
      parent.after(node);
    } else (seg.node as Element).after(node);
  };
  const before = (seg: Seg) => {
    const parent = seg.node.parentNode as Element | null;
    if (isContent(parent)) {
      if (seg.node.previousSibling) splitContentBefore(parent, seg.node);
      // The node now starts its own <Content>.
      (seg.node.parentNode as Element).before(node);
    } else (seg.node as Element).before(node);
  };
  if (prev && !(atParaStart && next) && prev.kind !== 'br') after(prev);
  else if (next) before(next);
  else if (prev) after(prev);
  else ensureCsr(f.story).appendChild(node);
}

function insertPlain(story: Element, pos: number, s: string) {
  const f = flatten(story);
  const atParaStart = pos === 0 || f.text[pos - 1] === '\r';
  const textSegs = f.segs.filter((x) => x.kind === 'text');
  let seg = atParaStart ? textSegs.find((x) => x.start === pos) : undefined;
  if (!seg) seg = textSegs.find((x) => x.start < pos && pos <= x.start + x.len && !(atParaStart && x.start + x.len === pos));
  if (!seg && !atParaStart) seg = textSegs.find((x) => x.start === pos);
  if (seg) {
    (seg.node as Text).insertData(pos - seg.start, s);
    return;
  }
  insertNodeAt(f, pos, newContent(story.ownerDocument, s));
}

/** Inserts text ("\r" for paragraph breaks); returns where the caret goes. */
export function insertText(story: Element, pos: number, s: string): number {
  const parts = s.split('\r');
  let p = pos;
  parts.forEach((part, i) => {
    if (i > 0) {
      insertNodeAt(flatten(story), p, story.ownerDocument.createElement('Br'));
      p += 1;
    }
    if (part) {
      insertPlain(story, p, part);
      p += part.length;
    }
  });
  return p;
}

/** Inserts a special character InDesign keeps as a processing instruction (page numbers: "18"). */
export function insertMarker(story: Element, pos: number, code: string): number {
  const doc = story.ownerDocument;
  const c = newContent(doc);
  c.appendChild(doc.createProcessingInstruction('ACE', code));
  insertNodeAt(flatten(story), pos, c);
  return pos + 1;
}

function removeEmptyContents(story: Element) {
  for (const c of Array.from(story.getElementsByTagName('Content'))) {
    let empty = true;
    for (let n = c.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 7 || ((n.nodeType === 3 || n.nodeType === 4) && (n as Text).data)) {
        empty = false;
        break;
      }
    }
    if (empty) c.remove();
  }
}

export function deleteRange(story: Element, a: number, b: number) {
  if (b <= a) return;
  const f = flatten(story);
  let removedBreak = false;
  for (let i = f.segs.length - 1; i >= 0; i--) {
    const s = f.segs[i];
    const s0 = Math.max(a, s.start);
    const s1 = Math.min(b, s.start + s.len);
    if (s1 <= s0) continue;
    if (s.kind === 'text') (s.node as Text).deleteData(s0 - s.start, s1 - s0);
    else {
      if (s.kind === 'br') removedBreak = true;
      s.node.parentNode?.removeChild(s.node);
    }
  }
  removeEmptyContents(story);
  if (removedBreak) mergeParagraph(story, a);
}

/** After a break is deleted: the joined paragraph's text moves into the first paragraph's range. */
function mergeParagraph(story: Element, pos: number) {
  const f = flatten(story);
  const para = f.paras[paraIndexAt(f, pos)];
  if (!para?.psr) return;
  const p1 = para.psr;
  const inPara = f.segs.filter((s) => s.start >= para.start && s.start < para.end);
  const later = inPara.filter((s) => s.psr && s.psr !== p1);
  if (!later.length) return;
  const p2 = later[0].psr!;
  if (p2.parentNode !== p1.parentNode) return;
  const last = inPara[inPara.length - 1];
  if (last.psr !== p2) return;
  // Everything in p2 up to the end of this paragraph moves over.
  let stop: Node | null = null;
  if (last.kind === 'br') {
    const csr = last.node.parentNode as Element | null;
    if (!csr || csr.localName !== 'CharacterStyleRange' || csr.parentNode !== p2) return;
    if (last.node.nextSibling) {
      const second = cloneRange(csr);
      moveFrom(last.node.nextSibling, second);
      csr.after(second);
    }
    stop = csr.nextSibling;
  }
  for (let n = p2.firstChild; n && n !== stop; ) {
    const next: ChildNode | null = n.nextSibling;
    if (!(n.nodeType === 1 && (n as Element).localName === 'Properties')) p1.appendChild(n);
    n = next;
  }
  if (!Array.from(p2.childNodes).some((n) => n.nodeType === 1 && (n as Element).localName !== 'Properties')) p2.remove();
}

/** A copy of a range element with its settings but none of its text. */
function cloneRange(range: Element): Element {
  const c = range.cloneNode(false) as Element;
  const props = Array.from(range.children).find((e) => e.localName === 'Properties');
  if (props) c.appendChild(props.cloneNode(true));
  return c;
}

function moveFrom(start: Node, into: Element) {
  let n: Node | null = start;
  while (n) {
    const next: Node | null = n.nextSibling;
    if (!(n.nodeType === 1 && (n as Element).localName === 'Properties')) into.appendChild(n);
    n = next;
  }
}

/** The child of `ancestor` that holds `node`. */
function childOf(ancestor: Element, node: Node): Node | null {
  let n: Node | null = node;
  while (n && n.parentNode !== ancestor) n = n.parentNode;
  return n;
}

/** Makes `pos` fall between two <Content> pieces (splitting text there). */
function splitTextAt(story: Element, pos: number) {
  const f = flatten(story);
  const inside = f.segs.find((s) => s.kind === 'text' && s.start < pos && pos < s.start + s.len);
  if (!inside) return;
  const rest = (inside.node as Text).splitText(pos - inside.start);
  const parent = rest.parentNode as Element;
  if (isContent(parent)) splitContentBefore(parent, rest);
}

/** Splits the range element (CharacterStyleRange or ParagraphStyleRange) holding `pos`. */
function splitRangeAt(story: Element, pos: number, which: 'csr' | 'psr'): boolean {
  splitTextAt(story, pos);
  const f = flatten(story);
  const prev = f.segs.find((s) => s.start + s.len === pos);
  const next = f.segs.find((s) => s.start === pos);
  if (!prev || !next) return true;
  const range = prev[which];
  if (!range || range !== next[which]) return true;
  if (which === 'psr') splitRangeAt(story, pos, 'csr');
  const g = flatten(story);
  const n = g.segs.find((s) => s.start === pos);
  const p = g.segs.find((s) => s.start + s.len === pos);
  if (!n || !p) return true;
  const r = n[which];
  if (!r || r !== p[which]) return true;
  const nc = childOf(r, n.node);
  const pc = childOf(r, p.node);
  if (!nc || !pc || nc === pc) return false;
  const second = cloneRange(r);
  moveFrom(nc, second);
  r.after(second);
  return true;
}

export type Attrs = Record<string, string | number | null>;

/** Character formatting over a range: the ranges are split at its ends, then set. */
export function applyChar(story: Element, a: number, b: number, attrs: Attrs) {
  if (b <= a) return;
  splitRangeAt(story, a, 'csr');
  splitRangeAt(story, b, 'csr');
  const f = flatten(story);
  const ranges = new Set<Element>();
  for (const s of f.segs) if (s.start < b && s.start + s.len > a && s.csr) ranges.add(s.csr);
  for (const r of ranges) for (const [k, v] of Object.entries(attrs)) setProp(r, k, v);
}

/** Paragraph formatting for every paragraph the range touches. */
export function applyPara(story: Element, a: number, b: number, attrs: Attrs) {
  const f0 = flatten(story);
  const i0 = paraIndexAt(f0, a);
  const i1 = paraIndexAt(f0, Math.max(a, b - (b > a ? 1 : 0)));
  const first = f0.paras[i0];
  const last = f0.paras[i1];
  splitRangeAt(story, first.start, 'psr');
  splitRangeAt(story, last.end, 'psr');
  // Paragraphs in between may share ranges with each other; that's fine, they all change.
  const f = flatten(story);
  const ranges = new Set<Element>();
  for (const s of f.segs) if (s.start >= first.start && s.start < Math.max(last.end, first.start + 1) && s.psr) ranges.add(s.psr);
  if (!ranges.size) {
    const p = f.paras[paraIndexAt(f, a)]?.psr ?? firstPsr(story);
    if (p) ranges.add(p);
    else ranges.add(ensureCsr(story).parentElement!);
  }
  for (const r of ranges) for (const [k, v] of Object.entries(attrs)) setProp(r, k, v);
}

/** Word boundaries around a position, for double-click. */
export function wordAt(text: string, pos: number): [number, number] {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’-]/u.test(c);
  let a = pos;
  let b = pos;
  if (!isWord(text[pos]) && isWord(text[pos - 1])) a = b = pos - 1;
  if (!isWord(text[a])) return [pos, Math.min(text.length, pos + 1)];
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return [a, b];
}

export function nextWord(text: string, pos: number, dir: 1 | -1): number {
  let p = pos;
  const word = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
  if (dir > 0) {
    while (p < text.length && word(text[p])) p++;
    while (p < text.length && !word(text[p])) p++;
  } else {
    while (p > 0 && !word(text[p - 1])) p--;
    while (p > 0 && word(text[p - 1])) p--;
  }
  return p;
}
