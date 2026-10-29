import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { listKey } from './layout';
import { isBulleted, listKind, newList, numberKindKey, bulletPreview, type BulletKind, type NumberKind, type Numbering } from './numbering';
import { effectivePara, effectiveRun, type Style, type StyleSheet } from './styles';
import type { ParaAttrs } from './schema';
import { storeImage } from './read';
import { imageSize } from '@/shared/office/ooxml';

/** What Word's buttons do to the selection. */

export function paragraphsInSelection(editor: Editor): { node: PMNode; pos: number }[] {
  const { from, to } = editor.state.selection;
  const out: { node: PMNode; pos: number }[] = [];
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

export function currentParagraph(editor: Editor): PMNode | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'paragraph') return $from.node(d);
  return null;
}

export function setParagraphs(editor: Editor, attrs: Partial<ParaAttrs> | ((a: ParaAttrs) => Partial<ParaAttrs>)): void {
  const tr = editor.state.tr;
  for (const { node, pos } of paragraphsInSelection(editor)) {
    const a = node.attrs as ParaAttrs;
    tr.setNodeMarkup(pos, undefined, { ...a, ...(typeof attrs === 'function' ? attrs(a) : attrs) });
  }
  editor.view.dispatch(tr);
  editor.commands.focus();
}

/** The list a new item should join: the one just above, if it's the same kind. */
function adjacentList(editor: Editor, numbering: Numbering, bullet: boolean): number | null {
  const paras = paragraphsInSelection(editor);
  if (!paras.length) return null;
  const $pos = editor.state.doc.resolve(paras[0].pos);
  const index = $pos.index();
  if (index === 0) return null;
  const before = $pos.parent.child(index - 1);
  const id = before.attrs.numId as number | null;
  if (before.type.name === 'paragraph' && id && isBulleted(numbering, id) === bullet) return id;
  return null;
}

export function toggleList(editor: Editor, numbering: Numbering, kind: { bullet: BulletKind } | { number: NumberKind }, force = false, listStyle = true): void {
  const paras = paragraphsInSelection(editor);
  const bullet = 'bullet' in kind;
  const wanted = bullet ? bulletPreview(kind.bullet) : numberKindKey(kind.number);
  const all = paras.length > 0 && paras.every(({ node }) => node.attrs.numId && listKind(numbering, node.attrs.numId) === wanted);
  if (all && !force) {
    setParagraphs(editor, (a) => ({ numId: null, ilvl: 0, styleId: a.styleId === 'ListParagraph' ? null : a.styleId }));
  } else {
    const current = paras[0]?.node.attrs.numId as number | null;
    // Changing the style of a list keeps it one list; otherwise join the one above or start one.
    const sameKind = adjacentList(editor, numbering, bullet);
    const id = sameKind !== null && listKind(numbering, sameKind) === wanted ? sameKind : newList(numbering, kind);
    // Word puts list items in List Paragraph, which keeps them close together.
    setParagraphs(editor, (a) => ({
      numId: id,
      ilvl: a.numId && current ? a.ilvl : 0,
      indLeft: null,
      indFirst: null,
      styleId: a.styleId === null && listStyle ? 'ListParagraph' : a.styleId,
    }));
  }
  editor.view.dispatch(editor.state.tr.setMeta(listKey, true));
}

export function changeIndent(editor: Editor, dir: 1 | -1, sheet: StyleSheet): void {
  setParagraphs(editor, (a) => {
    if (a.numId) return { ilvl: Math.max(0, Math.min(8, a.ilvl + dir)) };
    const base = a.indLeft ?? effectivePara(sheet, a.styleId).indLeft ?? 0;
    // Word moves to the next half-inch stop.
    const step = 48;
    const next = dir > 0 ? Math.floor(base / step + 1e-6) * step + step : Math.ceil(base / step - 1e-6) * step - step;
    return { indLeft: Math.max(0, next) };
  });
}

export function applyStyle(editor: Editor, style: Style): void {
  if (style.type === 'character') {
    // Character styles become the formatting they stand for.
    const chain = editor.chain().focus();
    if (style.run.bold) chain.setBold();
    if (style.run.italic) chain.setItalic();
    if (style.run.underline) chain.setUnderline();
    if (style.run.color) chain.setColor(`#${style.run.color}`);
    chain.run();
    return;
  }
  setParagraphs(editor, (a) => ({ styleId: style.id === 'Normal' ? null : style.id, numId: style.para.numId !== undefined ? null : a.numId }));
}

export function clearFormatting(editor: Editor): void {
  editor.chain().focus().unsetAllMarks().run();
  setParagraphs(editor, {
    styleId: null,
    align: null,
    indLeft: null,
    indRight: null,
    indFirst: null,
    spBefore: null,
    spAfter: null,
    line: null,
    lineRule: null,
    shading: null,
  });
}

export type CaseMode = 'sentence' | 'lower' | 'upper' | 'title' | 'toggle';

export function changeCase(editor: Editor, mode: CaseMode): void {
  const { from, to } = editor.state.selection;
  if (from === to) return;
  const tr = editor.state.tr;
  let atSentenceStart = true;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text!.slice(start - pos, end - pos);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const prev = i > 0 ? text[i - 1] : start > pos ? node.text![start - pos - 1] : ' ';
      switch (mode) {
        case 'lower': out += c.toLowerCase(); break;
        case 'upper': out += c.toUpperCase(); break;
        case 'toggle': out += c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); break;
        case 'title': out += /\s/.test(prev) || i + start === pos ? c.toUpperCase() : c.toLowerCase(); break;
        case 'sentence':
          out += atSentenceStart && /\p{L}/u.test(c) ? c.toUpperCase() : c.toLowerCase();
          if (/\p{L}/u.test(c)) atSentenceStart = false;
          if (/[.!?]/.test(c)) atSentenceStart = true;
          break;
      }
    }
    tr.replaceWith(start, end, editor.state.schema.text(out, node.marks));
    return false;
  });
  tr.setSelection(TextSelection.create(tr.doc, from, to));
  editor.view.dispatch(tr);
}

/** The run formatting at the cursor, with what the paragraph style gives filled in. */
export function currentRun(editor: Editor, sheet: StyleSheet): { font: string; size: number } {
  const para = currentParagraph(editor);
  const eff = effectiveRun(sheet, para?.attrs.styleId ?? null);
  const ts = editor.getAttributes('textStyle');
  const size = typeof ts.fontSize === 'string' ? parseFloat(ts.fontSize) : NaN;
  return {
    font: typeof ts.fontFamily === 'string' && ts.fontFamily ? ts.fontFamily.replace(/^["']|["']$/g, '') : (eff.font ?? 'Calibri'),
    size: Number.isFinite(size) ? size : (eff.size ?? 11),
  };
}

/** Insert a picture, no wider than the text column. */
export async function insertImage(editor: Editor, data: Uint8Array, ext: string, maxWidth: number): Promise<void> {
  const src = storeImage(data, ext);
  const { width, height } = await imageSize(src);
  const k = Math.min(1, maxWidth / Math.max(1, width));
  editor
    .chain()
    .focus()
    .insertContent({ type: 'image', attrs: { src, width: Math.round(width * k), height: Math.round(height * k) } })
    .run();
}

export function wordCount(doc: PMNode): { words: number; chars: number; charsNoSpaces: number; paragraphs: number; lines: number } {
  let words = 0;
  let chars = 0;
  let charsNoSpaces = 0;
  let paragraphs = 0;
  doc.descendants((node) => {
    if (node.type.name === 'paragraph') {
      const t = node.textContent;
      if (t.trim()) paragraphs++;
      words += (t.match(/\S+/g) ?? []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      chars += t.length;
      charsNoSpaces += t.replace(/\s/g, '').length;
      return false;
    }
    return true;
  });
  return { words, chars, charsNoSpaces, paragraphs, lines: paragraphs };
}

/** A table as Word inserts one: Table Grid, across the text column in equal columns. */
export function insertTable(editor: Editor, cols: number, rows: number, width: number): void {
  const w = Math.max(24, Math.floor(width / cols));
  const cell = { type: 'tableCell', attrs: { colwidth: [w] }, content: [{ type: 'paragraph' }] };
  const from = editor.state.selection.from;
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'table',
      attrs: { styleId: 'TableGrid', borders: null, look: { firstRow: true, firstCol: true, bandRows: true } },
      content: Array.from({ length: rows }, () => ({ type: 'tableRow', content: Array.from({ length: cols }, () => cell) })),
    })
    .run();
  // The cursor goes in the first cell, as in Word.
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target !== -1) return false;
    if (node.type.name === 'table' && pos >= from - 2) target = pos;
    return true;
  });
  if (target !== -1) {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target + 4))).scrollIntoView());
  }
}
