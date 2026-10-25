import { blocks, Bytes, children, find, isContainer } from './blocks';

/**
 * Publisher's text ("Quill", the Quill/QuillSub/CONTENTS stream of 2000 and
 * later): one TEXT chunk with every story's UTF-16 text end to end, STRS
 * with each story's length, SYID with the ids text boxes refer to them by,
 * FDPC and FDPP runs of character and paragraph formatting, STSH default
 * styles, FONT names and the PL text colors.
 */

const EMU_PER_PT = 12700;

export interface CharStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: number;
  /** Points. */
  size?: number;
  /** A text color entry, as the file has it. */
  color?: number;
  font?: number;
  superSub?: number;
  outline?: boolean;
  shadow?: boolean;
  smallCaps?: boolean;
  allCaps?: boolean;
  scale?: number;
}

export interface ParaStyle {
  align?: number;
  defaultStyle?: number;
  /** Raw line spacing: points (bit 0) or a multiple (bit 1). */
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  firstIndent?: number;
  leftIndent?: number;
  rightIndent?: number;
  tabs?: number[];
  bullet?: number;
  list?: boolean;
  numberStart?: number;
  dropLines?: number;
  dropChars?: number;
}

export interface QuillSpan {
  text: string;
  style: CharStyle;
}

export interface QuillPara {
  spans: QuillSpan[];
  style: ParaStyle;
  /** Characters in the file, paragraph mark and all. */
  length: number;
}

export interface QuillText {
  /** Stories by the id shapes refer to them by. */
  stories: Map<number, QuillPara[]>;
  /** Where each story's table cells end (characters into it), for tables. */
  cellEnds: Map<number, number[]>;
  fonts: string[];
  /** Text color entries (2002 and later). */
  colors: number[];
  defaultChar: CharStyle[];
  defaultPara: ParaStyle[];
}

interface Ref {
  name: string;
  id: number;
  offset: number;
  length: number;
}

export function charStyle(s: Bytes, at: number): CharStyle {
  const st: CharStyle = {};
  for (const b of blocks(s, at + 4, at + s.u32(at))) {
    switch (b.id) {
      case 0x02: st.bold = true; break;
      case 0x03: st.italic = true; break;
      case 0x1e: st.underline = b.value & 0xff; break;
      case 0x0c: st.size = b.value / EMU_PER_PT; break;
      case 0x2e: st.color = b.value; break;
      case 0x44: {
        const c = find(children(s, b), 0x00);
        if (c) st.color = c.value;
        break;
      }
      case 0x24: {
        const g = children(s, b).find(isContainer);
        const first = g && children(s, g)[0];
        if (first) st.font = first.value;
        break;
      }
      case 0x0f: st.superSub = b.value; break;
      case 0x04: st.outline = true; break;
      case 0x05: st.shadow = true; break;
      case 0x13: st.smallCaps = true; break;
      case 0x14: st.allCaps = true; break;
      case 0x20: st.scale = b.value / 10; break;
    }
  }
  return st;
}

export function paraStyle(s: Bytes, at: number): ParaStyle {
  const st: ParaStyle = {};
  for (const b of blocks(s, at + 4, at + s.u32(at))) {
    switch (b.id) {
      case 0x04: st.align = b.value & 0xff; break;
      case 0x19: st.defaultStyle = b.value; break;
      case 0x34: st.lineSpacing = b.value; break;
      case 0x12: st.spaceBefore = b.value; break;
      case 0x13: st.spaceAfter = b.value; break;
      case 0x0c: st.firstIndent = b.value | 0; break;
      case 0x0d: st.leftIndent = b.value; break;
      case 0x0e: st.rightIndent = b.value; break;
      case 0x32: {
        const arr = find(children(s, b), 0x28);
        if (!arr) break;
        st.tabs = [];
        for (const e of children(s, arr)) {
          if (!isContainer(e)) continue;
          const amount = find(children(s, e), 0x00);
          if (amount) st.tabs.push(amount.value);
        }
        break;
      }
      case 0x57: {
        st.list = true;
        const bullet = find(children(s, b), 0x01);
        if (bullet) st.bullet = bullet.value;
        break;
      }
      case 0x15: st.numberStart = b.value; break;
      case 0x08: st.dropLines = b.value; break;
      case 0x2d: st.dropChars = b.value; break;
    }
  }
  return st;
}

/** The (end offset, style) runs of an FDPC or FDPP chunk. */
function runs<T>(s: Bytes, ref: Ref, read: (s: Bytes, at: number) => T): { last: number; style: T }[] {
  const n = s.u16(ref.offset);
  const out: { last: number; style: T }[] = [];
  for (let i = 0; i < n; i++) {
    const last = s.u32(ref.offset + 8 + i * 4);
    const rel = s.u16(ref.offset + 8 + n * 4 + i * 2);
    out.push({ last, style: read(s, ref.offset + rel) });
  }
  return out;
}

export function readQuill(data: Uint8Array): QuillText {
  const s = new Bytes(data);
  const refs: Ref[] = [];
  const seen = new Set<number>();
  for (let list = 0x18; list !== 0xffffffff && list < s.length && !seen.has(list); ) {
    seen.add(list);
    const n = s.u16(list + 2);
    const next = s.u32(list + 4);
    for (let i = 0; i < n; i++) {
      const o = list + 8 + i * 24;
      refs.push({ name: s.ascii(o + 2, 4), id: s.u16(o + 6), offset: s.u32(o + 16), length: s.u32(o + 20) });
    }
    list = next;
  }

  const out: QuillText = { stories: new Map(), cellEnds: new Map(), fonts: [], colors: [], defaultChar: [], defaultPara: [] };
  let text: Ref | null = null;
  const lengths: number[] = [];
  const ids: number[] = [];
  const spans: { last: number; style: CharStyle }[] = [];
  const paras: { last: number; style: ParaStyle }[] = [];
  const cellEnds = new Map<number, number[]>();
  let stsh = 0;
  for (const r of refs) {
    switch (r.name) {
      case 'TEXT':
        text = r;
        break;
      case 'STRS': {
        const n = s.u32(r.offset);
        const at = r.offset + 4 + s.u32(r.offset + 4);
        for (let j = 0; j < n && at + j * 4 + 4 <= s.length; j++) lengths.push(s.u32(at + j * 4));
        break;
      }
      case 'SYID': {
        const n = s.u32(r.offset + 4);
        for (let j = 0; j < n && r.offset + 8 + j * 4 + 4 <= s.length; j++) ids.push(s.u32(r.offset + 8 + j * 4));
        break;
      }
      case 'PL  ': {
        const n = s.u32(r.offset);
        let o = r.offset + 12;
        for (let j = 0; j < n && o < s.length; j++) {
          const len = s.u32(o);
          if (len < 4) break;
          const c = find(blocks(s, o + 4, o + len), 0x01);
          out.colors.push(c ? c.value : 0);
          o += len;
        }
        break;
      }
      case 'FDPC':
        spans.push(...runs(s, r, charStyle));
        break;
      case 'FDPP':
        paras.push(...runs(s, r, paraStyle));
        break;
      case 'STSH':
        // The second STSH holds the default styles, character and paragraph alternately.
        if (stsh++ === 1) {
          const n = Math.min(s.u32(r.offset + 4), 4096);
          for (let j = 0; j < n; j++) {
            const at = r.offset + 20 + s.u32(r.offset + 20 + j * 4) + 2;
            if (j % 2 === 0) out.defaultChar.push(charStyle(s, at));
            else out.defaultPara.push(paraStyle(s, at));
          }
        }
        break;
      case 'FONT': {
        const n = Math.min(s.u32(r.offset + 4), 4096);
        let o = r.offset + 8 + 12 + 4 * n;
        for (let j = 0; j < n && o < s.length; j++) {
          const len = s.u16(o);
          out.fonts.push(s.utf16(o + 2, len).replace(/\0+$/, ''));
          o += 2 + len * 2 + 4;
        }
        break;
      }
      case 'TCD ': {
        const n = s.u32(r.offset) + 1;
        const ends: number[] = [];
        for (let j = 0; j < n && j < 100000; j++) ends.push(s.u32(r.offset + 12 + j * 4) + (j !== n - 1 ? 2 : 0));
        cellEnds.set(r.id, ends);
        break;
      }
    }
  }
  if (!text) return out;

  // Walk the text, cutting it where the formatting runs end (offsets into the stream).
  let read = 0;
  let si = 0;
  let pi = 0;
  let pos = text.offset;
  for (let j = 0; j < ids.length && j < lengths.length; j++) {
    const story: QuillPara[] = [];
    let cur: QuillSpan[] = [];
    let chars: number[] = [];
    let n = 0;
    const flushSpan = () => {
      if (chars.length && si < spans.length) cur.push({ text: decode(chars), style: spans[si].style });
      chars = [];
    };
    for (let k = 0; k < lengths[j] && si < spans.length && pi < paras.length; k++) {
      chars.push(s.u16(pos));
      n++;
      pos += 2;
      read += 2;
      if (read >= spans[si].last - text.offset) {
        flushSpan();
        si++;
      }
      if (read >= paras[pi].last - text.offset) {
        flushSpan();
        if (cur.length) story.push({ spans: cur, style: paras[pi].style, length: n });
        pi++;
        cur = [];
        n = 0;
      }
    }
    flushSpan();
    if (cur.length && pi < paras.length) story.push({ spans: cur, style: paras[pi].style, length: n });
    out.stories.set(ids[j], story);
    const ce = cellEnds.get(j);
    if (ce) out.cellEnds.set(ids[j], ce);
  }
  return out;
}

/**
 * Quill's characters as text: paragraph marks go (paragraphs are split
 * already), vertical tabs are line breaks, other control characters drop.
 */
function decode(chars: number[]): string {
  let t = '';
  for (const c of chars) {
    if (c === 0x0d) continue;
    if (c === 0x0b || c === 0x0a) t += '\u2028';
    else if (c === 0x09) t += '\t';
    else if (c < 0x20) continue;
    else t += String.fromCharCode(c);
  }
  return t;
}
