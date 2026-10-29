import type { Cfb } from '@/lib/cfb';
import { Bytes } from './blocks';
import type { PubDoc, PubImage, PubLine, PubPage, PubPara, PubShape } from './doc';
import { readQuill } from './quill';
import { preset } from './shapes';
import { storyParas } from './text';

/**
 * Publisher 2000 and 98 (and 97, which 98 shares a format with). Contents
 * is a list of fixed-layout chunks (document, pages, shapes, groups,
 * pictures, the color scheme) found through a trailer; 2000 keeps its text
 * in a Quill stream as later versions do, 98 in Contents itself.
 */

const EMU = 12700;

/** Bookkeeping pages, not the document's. */
const DUMMY_PAGES = new Set([0x116, 0x108, 0x10b, 0x10d, 0x119]);
/** The background page every page shows. */
const MASTER_PAGE = 0x109;

interface Chunk {
  id: number;
  parent: number;
  at: number;
  marker: number;
}

/** Office shape types for Publisher 2000's own autoshape numbers. */
const AUTOSHAPES: Record<number, number> = {
  0x01: 6, 0x03: 68, 0x04: 12, 0x05: 74, 0x06: 5, 0x07: 7, 0x09: 70, 0x0a: 59, 0x0c: 4, 0x0d: 8, 0x0e: 55,
  0x10: 92, 0x12: 56, 0x13: 15, 0x18: 9, 0x1e: 10, 0x1f: 11, 0x22: 73,
};

/** Publisher 2000's built-in colors. */
const BUILTIN = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', '00ffff', 'ff00ff', '808080', 'c0c0c0', '800000', '008000', '000080', '808000', '008080', '800080',
  'ff9933', '330033', '000099', '009900', '999900', 'cc6600', '990000', 'cc99cc', '6666ff', '66ff66', 'ffff99', 'ffcc99', 'ff6666', 'ff9900', '0066ff', 'ffcc00',
  '990033', '663300', '424242', 'ff9966', '993300', 'ff6600', '333300', '99cc00', 'ffff99', '003300', '339966', 'ccffcc', '003366', '33cccc', 'ccffff', '3366ff',
  '00ccff', '99ccff', '333399', '666699', '993366', 'cc99ff', '333333', '969696',
];

export function read2000(cfb: Cfb, warnings: Set<string>): PubDoc {
  const contents = cfb.stream('Contents');
  if (!contents) throw new Error('Its contents are missing (it may be damaged).');
  const quillData = cfb.stream('Quill/QuillSub/CONTENTS');
  const is98 = !quillData;
  const s = new Bytes(contents);
  const OFF = is98
    ? { textId: 0x46, textMarker: 0x0000, line1: 0x22, line2: 0x2d, fillType: 0x20, fillColor: 0x18 }
    : { textId: 0x58, textMarker: 0x0008, line1: 0x2c, line2: 0x35, fillType: 0x2a, fillColor: 0x22 };

  const trailer = s.u32(0x16);
  const n = s.u16(trailer);
  const chunks: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    const o = trailer + 2 + i * 10;
    const at = s.u32(o + 6);
    chunks.push({ id: s.u16(o + 2), parent: s.u16(o + 4), at, marker: s.u16(at) });
  }
  const byParent = new Map<number, Chunk[]>();
  for (const c of chunks) byParent.set(c.parent, [...(byParent.get(c.parent) ?? []), c]);

  const docChunk = chunks.find((c) => c.marker === 0x15);
  if (!docChunk) throw new Error('It has no document settings (it may be damaged).');
  let banner = false;
  let width: number;
  let height: number;
  if (is98) {
    banner = s.u16(docChunk.at + 0x12) === 0x0007;
    width = s.u32(docChunk.at + 0x14) / EMU;
    height = s.u32(docChunk.at + 0x18) / EMU;
  } else {
    width = s.u32(docChunk.at + 0x14) / EMU;
    height = s.u32(docChunk.at + 0x18) / EMU;
  }
  // Publisher 98 measures from a point well up and left of the page.
  const shift = is98 ? (banner ? 120 : 25) * 914400 : 0;

  const palette: string[] = [];
  for (const c of chunks.filter((x) => x.marker === 0x47)) for (let j = 0; j < 8; j++) palette.push(hexColor(s.u32(c.at + 0xa0 + j * 4)));
  if (palette.length < 8) palette.unshift('#000000');
  const color = (ref: number) => {
    const t = (ref >>> 24) & 0xff;
    if (t === 0xc0 || t === 0xe0) return palette[ref & 0xff] ?? '#000000';
    return hexColor(ref);
  };

  const images: PubImage[] = [];
  const imageOf = new Map<number, number>();
  for (const c of chunks.filter((x) => x.marker === 0x21)) {
    const len = s.u32(c.at + 4);
    imageOf.set(c.parent, images.length);
    images.push({ kind: 'wmf', data: s.slice(c.at + 8, len) });
  }

  const doc: PubDoc = { width, height, pages: [], masters: [], stories: new Map(), images, warnings, version: is98 ? 'Publisher 98' : 'Publisher 2000' };

  const lineWidth = (w: number) => {
    const q = w === 0x81 ? 0 : w > 0x81 ? Math.floor((w - 0x81) / 3) * 4 + ((w - 0x81) % 3) + 1 : w * 4;
    return q / 4;
  };
  const lineAt = (o: number): PubLine | null => {
    const w = s.u8(o);
    return w ? { color: color(s.u32(o + 1)), width: lineWidth(w) } : null;
  };

  const seen = new Set<number>();
  const shapeOf = (c: Chunk, depth: number): PubShape | null => {
    if (seen.has(c.id) || depth > 50) return null;
    seen.add(c.id);
    const o = c.at;
    const coord = (k: number) => s.i32(o + 6 + k * 4) - shift;
    const x0 = coord(0);
    const y0 = coord(1);
    const x1 = coord(2);
    const y1 = coord(3);
    const box = {
      x: width / 2 + Math.min(x0, x1) / EMU,
      y: height / 2 + Math.min(y0, y1) / EMU,
      w: Math.abs(x1 - x0) / EMU,
      h: Math.abs(y1 - y0) / EMU,
    };
    const m = c.marker;
    if (m === 0x0f) {
      const kids = (byParent.get(c.id) ?? []).map((k) => shapeOf(k, depth + 1)).filter((k): k is PubShape => !!k);
      return kids.length ? { kind: 'group', ...box, rotation: 0, flipH: false, flipV: false, children: kids } : null;
    }
    if (![0x00, 0x02, 0x04, 0x05, 0x06, 0x07, 0x08].includes(m)) return null;
    const isLine = m === 0x04;
    const rot = s.u16(o + 4);
    const out: PubShape = { kind: 'rect', ...box, rotation: isLine || !rot ? 0 : (360 - rot / 10) % 360, flipH: false, flipV: false, lineInside: true };
    const flagsAt = m === 0x04 ? 0x41 : m === 0x06 ? 0x33 : 0;
    if (flagsAt) {
      const f = s.u8(o + flagsAt);
      out.flipV = !!(f & 0x01);
      out.flipH = !!(f & 0x12);
    }
    if (isLine) out.kind = 'line';
    else if (m === 0x07) out.kind = 'ellipse';
    else if (m === 0x06) {
      const mso = AUTOSHAPES[s.u8(o + 0x31)];
      const pr = mso !== undefined ? preset(mso, (_i, d) => d) : null;
      if (pr?.kind === 'path') {
        out.kind = 'path';
        out.paths = pr.paths;
      } else if (pr?.kind === 'ellipse') out.kind = 'ellipse';
      else warnings.add('Some shapes Publisher doesn’t know yet are drawn as rectangles.');
    }
    const isRect = m === 0x02 || m === 0x05 || m === OFF.textMarker;
    if (m === 0x02) {
      const img = imageOf.get(c.id);
      if (img !== undefined) out.image = img;
    } else if (s.u8(o + OFF.fillType) === 2) {
      out.fill = { type: 'solid', color: color(s.u32(o + OFF.fillColor)), opacity: 1 };
    }
    const left = lineAt(o + OFF.line1);
    if (isRect) {
      const top = lineAt(o + OFF.line2);
      const right = lineAt(o + OFF.line2 + 6);
      const bottom = lineAt(o + OFF.line2 + 12);
      const sides = [top, right, bottom, left];
      const first = sides.find(Boolean) ?? null;
      if (first && sides.every((x) => x && x.color === first.color && x.width === first.width)) out.line = first;
      else if (first) out.sides = sides;
    } else out.line = left;
    if (m === OFF.textMarker) {
      out.text = { story: s.u16(o + OFF.textId), margins: [2.88, 2.88, 2.88, 2.88], columns: 1, gutter: 0, valign: 'top', link: 0 };
    }
    return out;
  };

  const pageShapes = (pageId: number): PubShape[] => (byParent.get(pageId) ?? []).map((c) => shapeOf(c, 0)).filter((x): x is PubShape => !!x);
  // Some "pages" are tables of Publisher's own whose entries count up where shapes' types would be.
  const isTable = (p: Chunk) => {
    const kids = byParent.get(p.id) ?? [];
    return kids.length >= 4 && kids.every((k, i) => i === 0 || k.marker === kids[i - 1].marker + 1);
  };
  const pageChunks = chunks.filter((c) => c.marker === 0x14 && !DUMMY_PAGES.has(c.id) && !isTable(c)).sort((a, b) => a.id - b.id);
  const master = pageChunks.find((c) => c.id === MASTER_PAGE);
  if (master) {
    const shapes = pageShapes(master.id);
    if (shapes.length) doc.masters.push({ shapes, master: null });
  }
  for (const p of pageChunks) {
    if (p.id === MASTER_PAGE) continue;
    const page: PubPage = { shapes: pageShapes(p.id), master: doc.masters.length ? 0 : null };
    doc.pages.push(page);
  }
  if (quillData) {
    const q = readQuill(quillData);
    for (const id of q.stories.keys()) doc.stories.set(id, storyParas(q, id, (c) => hexColor(c), (entry) => color(entry)));
  } else {
    for (const [id, paras] of text98(s)) doc.stories.set(id, paras);
  }

  // Pages where nothing shows are Publisher's spares and bookkeeping, not the document's.
  const shows = (sh: PubShape): boolean =>
    !!(sh.fill || sh.line || sh.sides || sh.image !== undefined || sh.children?.some(shows)) ||
    (!!sh.text && (doc.stories.get(sh.text.story) ?? []).some((p) => p.runs.some((r) => r.text.trim())));
  doc.pages = doc.pages.filter((p) => p.shapes.some(shows));
  if (!doc.pages.length) doc.pages.push({ shapes: [], master: null });
  return doc;
}

function hexColor(ref: number): string {
  const t = (ref >>> 24) & 0xff;
  if (t === 0x80 || t === 0x00) return `#${BUILTIN[ref & 0xff] ?? '000000'}`;
  if (t === 0x90 || t === 0x20) return `#${[ref & 0xff, (ref >> 8) & 0xff, (ref >> 16) & 0xff].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}

/** Publisher 98's text: one run of Windows-1252 text in Contents, stories ending in form feeds, with 512-byte pages of formatting. */
function text98(s: Bytes): Map<number, PubPara[]> {
  const out = new Map<number, PubPara[]>();
  const at = s.u32(0x12) + 14;
  const start = s.u32(at);
  const end = s.u32(at + 4);
  const p1 = s.u16(at + 8);
  const p2 = s.u16(at + 10);
  if (end <= start || end > s.length) return out;

  // Character formatting: where each run ends (from the text's start) and how it looks.
  const runs: { end: number; bold: boolean; italic: boolean; underline: boolean; size: number; color?: number }[] = [];
  let base = 0;
  for (let i = p1; i < p2 && i * 0x200 + 0x200 <= s.length; i++) {
    const o = i * 0x200;
    const count = s.u8(o + 0x1ff);
    if (i === p1) base = s.u32(o);
    const ends: number[] = [];
    for (let j = 0; j < count; j++) ends.push(s.u32(o + 4 + j * 4) - base);
    const idx: number[] = [];
    for (let j = 0; j < count; j++) idx.push(s.u8(o + 4 + count * 4 + j));
    for (let j = 0; j < count; j++) {
      const so = idx[j] ? o + idx[j] * 2 : 0;
      const len = so ? s.u8(so) : 0;
      const b = so + 1;
      const flags = len >= 1 ? s.u8(b) : 0;
      const varSize = len >= 6 ? s.i16(b + 4) : len >= 5 ? (s.u8(b + 4) << 24) >> 24 : 0;
      runs.push({
        end: ends[j],
        bold: !!(flags & 1),
        italic: !!(flags & 2),
        underline: len >= 9 && !!(s.u8(b + 8) & 1),
        size: 10 + varSize / 2,
        color: len >= 16 ? s.u32(b + 12) : undefined,
      });
    }
  }

  const bytes = s.slice(start, end - start);
  const dec = new TextDecoder('windows-1252');
  let story: PubPara[] = [];
  let para: PubPara = { runs: [] };
  let ri = 0;
  let buf: number[] = [];
  const flush = (pos: number) => {
    if (!buf.length) return;
    const r = runs[Math.min(ri, runs.length - 1)];
    const text = dec.decode(new Uint8Array(buf)).split('\v').join('\u2028');
    para.runs.push(r ? { text, bold: r.bold || undefined, italic: r.italic || undefined, underline: r.underline ? 'single' : undefined, size: r.size, color: r.color !== undefined ? hexColor(r.color) : undefined } : { text });
    buf = [];
    void pos;
  };
  for (let i = 0; i < bytes.length; i++) {
    while (ri < runs.length && i >= runs[ri].end) {
      flush(i);
      ri++;
    }
    const ch = bytes[i];
    if (ch === 0x0d) {
      flush(i);
      story.push(para);
      para = { runs: [] };
      if (bytes[i + 1] === 0x0a) i++;
    } else if (ch === 0x0c) {
      flush(i);
      if (para.runs.length) story.push(para);
      out.set(out.size, story);
      story = [];
      para = { runs: [] };
    } else buf.push(ch);
  }
  return out;
}
