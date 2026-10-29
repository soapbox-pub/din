import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { counterKey, hasStartOverride, labelText, levelOf, type Numbering } from './numbering';

/**
 * Laying the document out on pages, as Word's Print Layout does. The text
 * flows in one column; where a page ends, a spacer as tall as the bottom
 * margin, the gap between pages and the next top margin pushes what follows
 * onto the next page. A paragraph that doesn't fit breaks between lines,
 * keeping two lines together at either end (widow and orphan control), and
 * a heading moves with the paragraph after it.
 */

export interface PageGeometry {
  pageW: number;
  pageH: number;
  mTop: number;
  mBottom: number;
  /** Space between pages on screen. */
  gap: number;
  /** Print Layout lays out pages; Web Layout is one long page. */
  paged: boolean;
}

export interface LayoutResult {
  pages: number;
  /** Where each page's content starts, in document positions. */
  pageStarts: number[];
}

interface Spacer {
  pos: number;
  height: number;
  inline: boolean;
  /** A table row that starts a new page: it gets the gap as padding above its cells. */
  rowEnd?: number;
}

const spacerKey = (s: Spacer) => `${s.rowEnd ? 'r' : s.inline ? 'i' : 'b'}${s.height.toFixed(1)}`;

export const paginationKey = new PluginKey<DecorationSet>('wordPagination');

function spacerEl(height: number, inline: boolean): HTMLElement {
  const el = document.createElement(inline ? 'span' : 'div');
  el.className = inline ? 'wp-spacer wp-spacer-inline' : 'wp-spacer';
  el.style.height = `${height}px`;
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function decorationsFor(doc: PMNode, spacers: Spacer[]): DecorationSet {
  return DecorationSet.create(
    doc,
    spacers.map((s) =>
      s.rowEnd
        ? Decoration.node(s.pos, s.rowEnd, { class: 'wp-row-break', style: `--wp-gap: ${s.height.toFixed(1)}px` }, { key: spacerKey(s) })
        : Decoration.widget(s.pos, () => spacerEl(s.height, s.inline), {
            side: -1,
            key: spacerKey(s),
            ignoreSelection: true,
          }),
    ),
  );
}

/** A table's rows, top and bottom relative to the table, without the page gaps already in it. */
function rowBoxes(el: HTMLElement, scale: number): { top: number; bottom: number; gap: number }[] {
  const table = el.querySelector('table');
  if (!table) return [];
  const base = el.getBoundingClientRect().top;
  const out: { top: number; bottom: number; gap: number }[] = [];
  let gaps = 0;
  for (const row of Array.from(table.rows)) {
    if (row.closest('table') !== table) continue;
    const gap = parseFloat(row.style.getPropertyValue('--wp-gap')) || 0;
    const r = row.getBoundingClientRect();
    const top = (r.top - base) / scale - gaps;
    gaps += gap;
    out.push({ top, bottom: top + r.height / scale - gap, gap });
  }
  return out;
}

/** Line boxes of a paragraph, top and bottom relative to it, without the spacers already in it. */
function lineBoxes(el: HTMLElement, scale: number): { top: number; bottom: number; left: number; mid: number }[] {
  const base = el.getBoundingClientRect();
  const spacers = Array.from(el.querySelectorAll<HTMLElement>('.wp-spacer-inline')).map((s) => {
    const r = s.getBoundingClientRect();
    return { top: (r.top - base.top) / scale, height: r.height / scale };
  });
  const natural = (y: number) => y - spacers.filter((s) => s.top < y - 0.5).reduce((a, s) => a + s.height, 0);
  const rects: { top: number; bottom: number; left: number; screenTop: number; screenBottom: number }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n.nodeType === Node.TEXT_NODE || (n as Element).tagName === 'IMG' || (n as Element).classList.contains('wp-label') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let list: DOMRectList | DOMRect[];
    if (n.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(n);
      list = range.getClientRects();
    } else list = [(n as Element).getBoundingClientRect()];
    for (const r of Array.from(list)) {
      if (r.height === 0) continue;
      const t = (r.top - base.top) / scale;
      const b = (r.bottom - base.top) / scale;
      rects.push({ top: natural(t), bottom: natural(t) + (b - t), left: r.left, screenTop: r.top, screenBottom: r.bottom });
    }
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: { top: number; bottom: number; left: number; mid: number }[] = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && r.top < last.bottom - 2) {
      last.bottom = Math.max(last.bottom, r.bottom);
      last.top = Math.min(last.top, r.top);
      if (r.left < last.left) {
        last.left = r.left;
        last.mid = (r.screenTop + r.screenBottom) / 2;
      }
    } else lines.push({ top: r.top, bottom: r.bottom, left: r.left, mid: (r.screenTop + r.screenBottom) / 2 });
  }
  return lines;
}

function layout(view: EditorView, geo: PageGeometry, keepNext: (node: PMNode) => boolean): { spacers: Spacer[]; result: LayoutResult } {
  const dom = view.dom as HTMLElement;
  const scale = dom.getBoundingClientRect().width / Math.max(1, dom.offsetWidth) || 1;
  const spacers: Spacer[] = [];
  const stride = geo.pageH + geo.gap;
  const top = (p: number) => p * stride + geo.mTop;
  const bottom = (p: number) => p * stride + geo.pageH - geo.mBottom;
  const pageStarts = [0];
  if (!geo.paged) return { spacers, result: { pages: 1, pageStarts } };

  let page = 0;
  let y = top(0);
  let forceBreak = false;
  const blocks: { node: PMNode; pos: number; el: HTMLElement }[] = [];
  view.state.doc.forEach((node, pos) => {
    const el = view.nodeDOM(pos);
    if (el instanceof HTMLElement) blocks.push({ node, pos, el });
  });
  // Where the previous block started, to move a heading along with what follows it.
  let prev: { index: number; y: number; page: number; spacers: number } | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const { node, pos, el } = blocks[i];
    const inlineSpacers = Array.from(el.querySelectorAll<HTMLElement>('.wp-spacer-inline')).reduce((a, s) => a + s.getBoundingClientRect().height / scale, 0);
    const rows = node.type.name === 'table' ? rowBoxes(el, scale) : [];
    const rowGaps = rows.reduce((a, r) => a + r.gap, 0);
    // Fractional sizes: whole pixels add up to visible drift over a long document.
    const h = Math.max(0, el.getBoundingClientRect().height / scale - inlineSpacers - rowGaps);
    const startHere = () => {
      const next = page + 1;
      spacers.push({ pos, height: Math.max(0, top(next) - y), inline: false });
      page = next;
      y = top(page);
      pageStarts.push(pos);
    };
    if (node.type.name === 'pageBreak') {
      y += h;
      forceBreak = true;
      prev = null;
      continue;
    }
    if (forceBreak || (node.attrs.pageBreakBefore && y > top(page) + 0.5)) {
      forceBreak = false;
      startHere();
    } else if (y + h > bottom(page) + 0.5 && y > top(page) + 0.5) {
      let split = false;
      if (node.type.name === 'paragraph' && h > 0) {
        const lines = lineBoxes(el, scale);
        let k = lines.findIndex((l) => y + l.bottom > bottom(page) + 0.5);
        // Widow and orphan control: two lines stay together at each end.
        if (k !== -1 && lines.length >= 4) {
          if (k < 2) k = -1;
          else if (lines.length - k < 2) k = lines.length - 2;
        } else k = -1;
        if (k > 0) {
          const target = view.posAtCoords({ left: lines[k].left + 1, top: lines[k].mid });
          if (target && target.pos > pos + 1 && target.pos < pos + node.nodeSize - 1) {
            let lineTop = lines[k].top;
            let at = target.pos;
            for (;;) {
              const gapH = top(page + 1) - (y + lineTop);
              spacers.push({ pos: at, height: Math.max(0, gapH), inline: true });
              page++;
              pageStarts.push(at);
              y = top(page) - lineTop;
              const overflow = lines.findIndex((l, j) => j > k && y + l.bottom > bottom(page) + 0.5);
              if (overflow === -1 || overflow <= k) break;
              const t2 = view.posAtCoords({ left: lines[overflow].left + 1, top: lines[overflow].mid });
              if (!t2 || t2.pos <= at || t2.pos >= pos + node.nodeSize - 1) break;
              k = overflow;
              lineTop = lines[k].top;
              at = t2.pos;
            }
            y += h;
            split = true;
          }
        }
      }
      if (node.type.name === 'table' && rows.length > 1) {
        // Tables break between rows.
        let k = rows.findIndex((r) => y + r.bottom > bottom(page) + 0.5);
        if (k > 0) {
          const rowPos: number[] = [];
          node.forEach((row, offset) => rowPos.push(pos + 1 + offset));
          for (;;) {
            const start = rowPos[k];
            const end = start + node.child(k).nodeSize;
            spacers.push({ pos: start, rowEnd: end, height: Math.max(0, top(page + 1) - (y + rows[k].top)), inline: false });
            page++;
            pageStarts.push(start);
            y = top(page) - rows[k].top;
            const next = rows.findIndex((r, j) => j > k && y + r.bottom > bottom(page) + 0.5);
            if (next === -1) break;
            k = next;
          }
          y += h;
          split = true;
        }
      }
      if (split) {
        prev = null;
        continue;
      }
      // Keep with next: a heading goes over with the paragraph after it.
      if (prev && keepNext(blocks[prev.index].node) && prev.page === page && prev.y > top(page) + 0.5) {
        spacers.length = prev.spacers;
        y = prev.y;
        const back = blocks[prev.index];
        const next = page + 1;
        spacers.push({ pos: back.pos, height: Math.max(0, top(next) - y), inline: false });
        page = next;
        pageStarts.push(back.pos);
        y = top(page) + back.el.getBoundingClientRect().height / scale;
      } else startHere();
    }
    prev = { index: i, y, page, spacers: spacers.length };
    y += h;
    // A section break (other than a continuous one) starts the next section on a new page.
    const sect = node.attrs.sectPr as string | null | undefined;
    if (sect && !/<w:type\b[^>]*w:val="continuous"/.test(sect)) forceBreak = true;
    if (y > bottom(page) + 0.5) {
      // A block taller than a page runs on over the following ones.
      while (y > bottom(page) + 0.5) {
        page++;
        pageStarts.push(pos);
      }
      y = Math.max(y, top(page));
    }
  }
  return { spacers, result: { pages: page + 1, pageStarts } };
}

function sameSpacers(a: DecorationSet, b: Spacer[], doc: PMNode): boolean {
  const found = a.find(0, doc.content.size);
  if (found.length !== b.length) return false;
  const keys = new Set(found.map((d) => `${d.from}:${(d.spec as { key: string }).key}`));
  return b.every((s) => keys.has(`${s.pos}:${spacerKey(s)}`));
}

export function pagination(opts: {
  geometry: () => PageGeometry;
  keepNext: (node: PMNode) => boolean;
  onLayout: (r: LayoutResult) => void;
}) {
  return Extension.create({
    name: 'wordPagination',
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: paginationKey,
          state: {
            init: () => DecorationSet.empty,
            apply(tr, set) {
              const next = tr.getMeta(paginationKey) as DecorationSet | undefined;
              return next ?? set.map(tr.mapping, tr.doc);
            },
          },
          props: {
            decorations: (state: EditorState) => paginationKey.getState(state),
          },
          view(view) {
            let frame = 0;
            let last = '';
            const run = () => {
              frame = 0;
              if (!view.dom.isConnected) return;
              const { spacers, result } = layout(view, opts.geometry(), opts.keepNext);
              const current = paginationKey.getState(view.state)!;
              if (!sameSpacers(current, spacers, view.state.doc)) {
                view.dispatch(view.state.tr.setMeta(paginationKey, decorationsFor(view.state.doc, spacers)).setMeta('addToHistory', false));
              }
              const key = `${result.pages}:${result.pageStarts.join(',')}`;
              if (key !== last) {
                last = key;
                opts.onLayout(result);
              }
            };
            const schedule = () => {
              if (!frame) frame = requestAnimationFrame(run);
            };
            const ro = new ResizeObserver(schedule);
            ro.observe(view.dom);
            // Pictures change size as they load; fonts too.
            view.dom.addEventListener('load', schedule, true);
            void document.fonts?.ready.then(schedule);
            schedule();
            return {
              update(_view, prevState) {
                if (prevState.doc !== view.state.doc) schedule();
              },
              destroy() {
                cancelAnimationFrame(frame);
                ro.disconnect();
                view.dom.removeEventListener('load', schedule, true);
              },
            };
          },
        }),
      ];
    },
  });
}

/** Ask the pagination to lay out again (after the page size or zoom changes). */
export function relayout(view: EditorView): void {
  view.dom.dispatchEvent(new Event('load'));
}

// ---- List labels -----------------------------------------------------------------

export const listKey = new PluginKey<DecorationSet>('wordLists');

/** Bullets drawn from symbol fonts look right in these. */
function labelFont(font: string | undefined): string | null {
  const f = (font ?? '').toLowerCase();
  if (f === 'symbol') return '"Arimo", sans-serif';
  if (f.startsWith('wingdings')) return '"DejaVu Sans", "Noto Sans Symbols2", sans-serif';
  if (f.startsWith('courier')) return '"Cousine", monospace';
  return null;
}

function labelEl(text: string, hanging: number, labelOnly: boolean, font: string | null): HTMLElement {
  const el = document.createElement('span');
  el.className = 'wp-label';
  if (font) el.style.fontFamily = font;
  el.setAttribute('contenteditable', 'false');
  el.textContent = text;
  el.style.minWidth = `${Math.max(0, hanging)}px`;
  if (labelOnly) el.style.paddingRight = '0.5em';
  return el;
}

function listDecorations(doc: PMNode, numbering: () => Numbering, styleNum: (styleId: string | null) => { numId?: number; ilvl?: number }): DecorationSet {
  const n = numbering();
  const decos: Decoration[] = [];
  const counters = new Map<number, number[]>();
  const restarted = new Set<string>();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    const fromStyle = styleNum(node.attrs.styleId);
    const numId: number | null = node.attrs.numId ?? fromStyle.numId ?? null;
    if (!numId) return false;
    const ilvl: number = node.attrs.numId ? node.attrs.ilvl : (fromStyle.ilvl ?? node.attrs.ilvl ?? 0);
    const level = levelOf(n, numId, ilvl);
    if (!level) return false;
    const key = counterKey(n, numId);
    const c = counters.get(key) ?? [];
    const restart = hasStartOverride(n, numId, ilvl) && !restarted.has(`${numId}:${ilvl}`);
    if (restart) restarted.add(`${numId}:${ilvl}`);
    c[ilvl] = ((restart ? undefined : c[ilvl]) ?? level.start - 1) + 1;
    for (let d = 0; d < ilvl; d++) if (c[d] === undefined) c[d] = levelOf(n, numId, d)?.start ?? 1;
    c.length = ilvl + 1;
    counters.set(key, c);
    const text = labelText(n, numId, ilvl, c);
    const own = node.attrs.indLeft !== null || node.attrs.indFirst !== null;
    const left = node.attrs.indLeft ?? level.indLeft;
    const first = node.attrs.indFirst ?? -level.hanging;
    if (!own) decos.push(Decoration.node(pos, pos + node.nodeSize, { style: `margin-left: ${left}px; text-indent: ${first}px` }));
    const hanging = first < 0 ? -first : 0;
    decos.push(
      Decoration.widget(pos + 1, () => labelEl(text, hanging, hanging === 0, level.fmt === 'bullet' ? labelFont(level.font) : null), {
        side: -1,
        key: `l:${text}:${hanging}`,
        ignoreSelection: true,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function listLabels(opts: { numbering: () => Numbering; styleNum: (styleId: string | null) => { numId?: number; ilvl?: number } }) {
  return Extension.create({
    name: 'wordLists',
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: listKey,
          state: {
            init: (_c, state) => listDecorations(state.doc, opts.numbering, opts.styleNum),
            apply: (tr, set) => (tr.docChanged || tr.getMeta(listKey) ? listDecorations(tr.doc, opts.numbering, opts.styleNum) : set),
          },
          props: { decorations: (state) => listKey.getState(state) },
        }),
      ];
    },
  });
}

// ---- Find ------------------------------------------------------------------------

export interface FindState {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  matches: { from: number; to: number }[];
  current: number;
}

export const findKey = new PluginKey<FindState>('wordFind');

export function findMatches(doc: PMNode, query: string, matchCase: boolean, wholeWord: boolean): { from: number; to: number }[] {
  if (!query) return [];
  const out: { from: number; to: number }[] = [];
  const needle = matchCase ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Text of the block with a map back to positions.
    let text = '';
    const map: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i];
          map.push(pos + 1 + offset + i);
        }
      } else {
        text += '￼';
        map.push(pos + 1 + offset);
      }
    });
    const hay = matchCase ? text : text.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
      if (wholeWord && ((i > 0 && /\w/.test(hay[i - 1])) || (i + needle.length < hay.length && /\w/.test(hay[i + needle.length])))) continue;
      out.push({ from: map[i], to: map[i + needle.length - 1] + 1 });
    }
    return false;
  });
  return out;
}

export const FindHighlight = Extension.create({
  name: 'wordFind',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', matchCase: false, wholeWord: false, matches: [], current: -1 }),
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const next = { ...prev, ...meta };
            if (tr.docChanged || meta?.query !== undefined || meta?.matchCase !== undefined || meta?.wholeWord !== undefined) {
              next.matches = findMatches(tr.doc, next.query, next.matchCase, next.wholeWord);
              if (next.current >= next.matches.length) next.current = next.matches.length - 1;
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const f = findKey.getState(state);
            if (!f || !f.matches.length) return null;
            return DecorationSet.create(
              state.doc,
              f.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === f.current ? 'wp-find wp-find-current' : 'wp-find' })),
            );
          },
        },
      }),
    ];
  },
});
