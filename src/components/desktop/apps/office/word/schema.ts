import { Extension, mergeAttributes, Node, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow, TableView } from '@tiptap/extension-table';
import { fontStack } from '../fonts';
import { lineHeightCss } from './styles';

/**
 * The document model in the editor: paragraphs stay flat and carry Word's
 * paragraph properties (style, alignment, indents, spacing, list number),
 * runs carry marks, and tables, pictures, page breaks and fields are nodes.
 */

export interface ParaAttrs {
  styleId: string | null;
  align: 'left' | 'center' | 'right' | 'justify' | null;
  indLeft: number | null;
  indRight: number | null;
  indFirst: number | null;
  spBefore: number | null;
  spAfter: number | null;
  line: number | null;
  lineRule: 'auto' | 'exact' | 'atLeast' | null;
  numId: number | null;
  ilvl: number;
  pageBreakBefore: boolean;
  shading: string | null;
  /** pPr children this editor doesn't handle, kept as XML: [element name, xml]. */
  extra: [string, string][] | null;
  /** A section break ending at this paragraph, as XML. */
  sectPr: string | null;
}

const num = (v: string | null) => (v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function attrSpec<T>(def: T, keepOnSplit = true) {
  return { default: def, keepOnSplit, rendered: false };
}

export function paragraphStyle(a: ParaAttrs): string {
  const out: string[] = [];
  if (a.align) out.push(`text-align: ${a.align}`);
  if (a.indLeft !== null) out.push(`margin-left: ${a.indLeft}px`);
  if (a.indRight !== null) out.push(`margin-right: ${a.indRight}px`);
  if (a.indFirst !== null) out.push(`text-indent: ${a.indFirst}px`);
  if (a.spBefore !== null) out.push(`padding-top: ${a.spBefore}pt`);
  if (a.spAfter !== null) out.push(`padding-bottom: ${a.spAfter}pt`);
  if (a.line !== null) out.push(`line-height: ${lineHeightCss(a.line, a.lineRule ?? 'auto')}`);
  if (a.shading) out.push(`background-color: #${a.shading}`);
  return out.join('; ');
}

export const WordParagraph = Node.create({
  name: 'paragraph',
  priority: 1000,
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      styleId: attrSpec<string | null>(null),
      align: attrSpec<string | null>(null),
      indLeft: attrSpec<number | null>(null),
      indRight: attrSpec<number | null>(null),
      indFirst: attrSpec<number | null>(null),
      spBefore: attrSpec<number | null>(null),
      spAfter: attrSpec<number | null>(null),
      line: attrSpec<number | null>(null),
      lineRule: attrSpec<string | null>(null),
      numId: attrSpec<number | null>(null),
      ilvl: attrSpec(0),
      pageBreakBefore: attrSpec(false, false),
      shading: attrSpec<string | null>(null),
      extra: attrSpec<[string, string][] | null>(null),
      sectPr: attrSpec<string | null>(null, false),
    };
  },
  parseHTML() {
    return [
      {
        tag: 'p',
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const align = e.style.textAlign;
          return {
            styleId: e.getAttribute('data-style'),
            align: ['left', 'center', 'right', 'justify'].includes(align) ? align : null,
            numId: num(e.getAttribute('data-num')),
            ilvl: num(e.getAttribute('data-ilvl')) ?? 0,
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const a = node.attrs as ParaAttrs;
    const attrs: Record<string, string> = {};
    if (a.styleId) attrs['data-style'] = a.styleId;
    if (a.numId) {
      attrs['data-num'] = String(a.numId);
      attrs['data-ilvl'] = String(a.ilvl);
    }
    const style = paragraphStyle(a);
    if (style) attrs.style = style;
    return ['p', attrs, 0];
  },
});

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div.wp-pagebreak' }];
  },
  renderHTML() {
    return ['div', { class: 'wp-pagebreak', contenteditable: 'false' }, ['span', {}, 'Page Break']];
  },
});

/** PAGE and NUMPAGES fields; their text is filled in where they're drawn. */
export const Field = Node.create({
  name: 'field',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { kind: { default: 'page' }, text: { default: '1' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-field]', getAttrs: (el) => ({ kind: (el as HTMLElement).getAttribute('data-field') }) }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-field': node.attrs.kind, class: 'wp-field' }, String(node.attrs.text)];
  },
});

const SAFE_IMAGE = /^(blob:|data:image\/(png|jpeg|gif|webp|bmp);)/;

export const WordImage = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      width: { default: null },
      height: { default: null },
      alt: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => {
          const e = el as HTMLImageElement;
          const src = e.getAttribute('src') ?? '';
          if (!SAFE_IMAGE.test(src)) return false;
          return { src, width: num(e.getAttribute('width')), height: num(e.getAttribute('height')), alt: e.getAttribute('alt') ?? '' };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['img', { src: node.attrs.src, width: node.attrs.width, height: node.attrs.height, alt: node.attrs.alt }];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('span');
      dom.className = 'wp-img';
      const img = document.createElement('img');
      img.draggable = false;
      dom.append(img);
      const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].map((h) => {
        const el = document.createElement('span');
        el.className = `wp-img-handle wp-img-${h}`;
        el.dataset.handle = h;
        dom.append(el);
        return el;
      });
      const apply = (n: PMNode) => {
        if (SAFE_IMAGE.test(String(n.attrs.src ?? ''))) img.src = n.attrs.src;
        img.alt = n.attrs.alt ?? '';
        img.style.width = n.attrs.width ? `${n.attrs.width}px` : '';
        img.style.height = n.attrs.height ? `${n.attrs.height}px` : '';
      };
      apply(node);
      for (const h of handles) {
        h.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const which = h.dataset.handle!;
          const startX = e.clientX;
          const startY = e.clientY;
          const w0 = img.offsetWidth;
          const h0 = img.offsetHeight;
          // The page may be zoomed; screen pixels are scaled pixels.
          const scale = img.getBoundingClientRect().width / Math.max(1, w0);
          h.setPointerCapture(e.pointerId);
          let w = w0;
          let hh = h0;
          const move = (ev: PointerEvent) => {
            const dx = (ev.clientX - startX) / scale;
            const dy = (ev.clientY - startY) / scale;
            const sx = which.includes('e') ? 1 : which.includes('w') ? -1 : 0;
            const sy = which.includes('s') ? 1 : which.includes('n') ? -1 : 0;
            w = Math.max(8, w0 + sx * dx);
            hh = Math.max(8, h0 + sy * dy);
            if (sx && sy && !ev.shiftKey) {
              // Corners keep the picture's shape, as in Word.
              const k = Math.max(w / w0, hh / h0);
              w = w0 * k;
              hh = h0 * k;
            }
            img.style.width = `${Math.round(w)}px`;
            img.style.height = `${Math.round(hh)}px`;
          };
          const up = () => {
            h.removeEventListener('pointermove', move);
            h.removeEventListener('pointerup', up);
            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (pos === undefined) return;
            editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width: Math.round(w), height: Math.round(hh) }));
          };
          h.addEventListener('pointermove', move);
          h.addEventListener('pointerup', up);
        });
      }
      return {
        dom,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          apply(n);
          return true;
        },
        selectNode() {
          dom.classList.add('is-selected');
        },
        deselectNode() {
          dom.classList.remove('is-selected');
        },
        ignoreMutation: () => true,
        stopEvent: (e) => e.target instanceof HTMLElement && !!e.target.dataset.handle,
      };
    };
  },
});

class WordTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number, view?: EditorView) {
    super(node, cellMinWidth, view);
    this.decorate(node);
  }
  update(node: PMNode) {
    if (!super.update(node)) return false;
    this.decorate(node);
    return true;
  }
  decorate(node: PMNode) {
    // Borders set on the table itself win over its style's; null leaves them to the style.
    this.table.classList.toggle('wp-borders', node.attrs.borders === true);
    this.table.classList.toggle('wp-noborders', node.attrs.borders === false);
    const look = (node.attrs.look ?? {}) as Record<string, boolean>;
    for (const [k, attr] of [['firstRow', 'data-first-row'], ['lastRow', 'data-last-row'], ['firstCol', 'data-first-col'], ['lastCol', 'data-last-col'], ['bandRows', 'data-band-rows']]) {
      if (look[k]) this.table.setAttribute(attr, '');
      else this.table.removeAttribute(attr);
    }
    if (node.attrs.styleId) this.table.setAttribute('data-style', String(node.attrs.styleId));
    else this.table.removeAttribute('data-style');
    this.table.style.marginLeft = node.attrs.align === 'center' ? 'auto' : node.attrs.indent ? `${node.attrs.indent}px` : '';
    this.table.style.marginRight = node.attrs.align === 'center' ? 'auto' : '';
  }
}

export const WordTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borders: { default: null, rendered: false },
      look: { default: null, rendered: false },
      bordersFromFile: { default: null, rendered: false },
      styleId: { default: null, rendered: false },
      align: { default: null, rendered: false },
      indent: { default: null, rendered: false },
      /** tblPr as it was in the file. */
      tblPr: { default: null, rendered: false },
    };
  },
}).configure({ resizable: true, cellMinWidth: 24, View: WordTableView });

export const WordTableRow = TableRow.extend({
  addAttributes() {
    return { ...this.parent?.(), trPr: { default: null, rendered: false } };
  },
});

export const WordTableCell = TableCell.extend({
  content: 'block+',
  addAttributes() {
    return {
      ...this.parent?.(),
      background: {
        default: null,
        renderHTML: (a: { background?: string | null }) => (a.background ? { style: `background-color: #${a.background}` } : {}),
        parseHTML: () => null,
      },
      valign: {
        default: null,
        renderHTML: (a: { valign?: string | null }) => (a.valign ? { style: `vertical-align: ${a.valign}` } : {}),
        parseHTML: () => null,
      },
      /** tcPr children this editor doesn't handle (borders, margins), as XML. */
      tcExtra: { default: null, rendered: false },
    };
  },
});

// ---- Behaviour -------------------------------------------------------------------

export interface WordHooks {
  /** The style Word switches to after Enter at the end of a paragraph in `styleId`. */
  nextStyle: (styleId: string | null) => string | null | undefined;
}

function paragraphAt(state: { selection: Selection }) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'paragraph') return { node: n, pos: $from.before(d), depth: d };
  }
  return null;
}

/** Word's own keys for lists, tabs, page breaks and styles that carry on (or don't) after Enter. */
export function wordKeymap(hooks: WordHooks) {
  return Extension.create({
    name: 'wordKeymap',
    priority: 200,
    addKeyboardShortcuts() {
      const setLevel = (delta: number) => {
        const p = paragraphAt(this.editor.state);
        if (!p || !p.node.attrs.numId) return false;
        const { from, to } = this.editor.state.selection;
        const tr = this.editor.state.tr;
        this.editor.state.doc.nodesBetween(from, to, (n, pos) => {
          if (n.type.name === 'paragraph' && n.attrs.numId) {
            tr.setNodeMarkup(pos, undefined, { ...n.attrs, ilvl: Math.max(0, Math.min(8, n.attrs.ilvl + delta)) });
          }
        });
        this.editor.view.dispatch(tr);
        return true;
      };
      return {
        Tab: () => {
          const { state } = this.editor;
          const p = paragraphAt(state);
          const inCell = this.editor.isActive('tableCell');
          if (p?.node.attrs.numId && state.selection.$from.parentOffset === 0) return setLevel(1);
          if (inCell) return false;
          return this.editor.commands.insertContent('\t');
        },
        'Shift-Tab': () => {
          const p = paragraphAt(this.editor.state);
          if (p?.node.attrs.numId && this.editor.state.selection.$from.parentOffset === 0) return setLevel(-1);
          return false;
        },
        Enter: () => {
          const { state } = this.editor;
          const p = paragraphAt(state);
          if (!p || !state.selection.empty) return false;
          // Enter on an empty list item ends the list.
          if (p.node.attrs.numId && p.node.content.size === 0) {
            if (p.node.attrs.ilvl > 0) return setLevel(-1);
            const styleId = p.node.attrs.styleId === 'ListParagraph' ? null : p.node.attrs.styleId;
            this.editor.view.dispatch(state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, styleId, numId: null, ilvl: 0, indLeft: null, indFirst: null }));
            return true;
          }
          const atEnd = state.selection.$from.parentOffset === p.node.content.size;
          const next = hooks.nextStyle(p.node.attrs.styleId);
          if (!atEnd || next === undefined || next === p.node.attrs.styleId) return false;
          return this.editor
            .chain()
            .splitBlock()
            .command(({ tr }) => {
              const q = paragraphAt(tr);
              if (q) tr.setNodeMarkup(q.pos, undefined, { ...q.node.attrs, styleId: next, numId: null, ilvl: 0, extra: null });
              return true;
            })
            .run();
        },
        Backspace: () => {
          const { state } = this.editor;
          const p = paragraphAt(state);
          if (!p || !state.selection.empty || state.selection.$from.parentOffset !== 0) return false;
          // Backspace at the start of a list item takes its number away first, as Word does.
          if (p.node.attrs.numId) {
            this.editor.view.dispatch(state.tr.setNodeMarkup(p.pos, undefined, { ...p.node.attrs, numId: null, ilvl: 0 }));
            return true;
          }
          return false;
        },
        'Mod-Enter': () => this.editor.chain().insertContent({ type: 'pageBreak' }).run(),
        'Shift-Enter': () => this.editor.commands.setHardBreak(),
      };
    },
  });
}

/** Keeps the cursor out of page breaks' way: arrowing onto one selects it, as atoms do. */
export const AtomSelection = Extension.create({
  name: 'atomSelection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('atomSelection'),
        appendTransaction(_trs: readonly Transaction[], _old: EditorState, state: EditorState) {
          const sel = state.selection;
          if (sel instanceof NodeSelection && sel.node.type.name === 'pageBreak' && sel.from === 0) {
            return state.tr.setSelection(TextSelection.near(state.doc.resolve(sel.to)));
          }
          return null;
        },
      }),
    ];
  },
});

/** Font names on runs, drawn with the free fonts that stand in for Office's. */
export const OfficeFontFamily = Extension.create({
  name: 'fontFamily',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => element.style.fontFamily?.split(',')[0]?.replace(/["']/g, '').trim() || null,
            renderHTML: (attributes) => (attributes.fontFamily ? { style: `font-family: ${fontStack(String(attributes.fontFamily))}` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontFamily:
        (fontFamily: string) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontFamily }).run(),
      unsetFontFamily:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontFamily: null }).removeEmptyTextStyle().run(),
    };
  },
});

export function wordExtensions(hooks: WordHooks) {
  return [
    StarterKit.configure({
      paragraph: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      blockquote: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null } },
      undoRedo: { depth: 500 },
    }),
    WordParagraph,
    PageBreak,
    Field,
    WordImage,
    TextStyleKit.configure({ lineHeight: false, fontFamily: false }),
    OfficeFontFamily,
    Highlight.configure({ multicolor: true }),
    Subscript,
    Superscript,
    WordTable,
    WordTableRow,
    WordTableCell,
    TableHeader,
    wordKeymap(hooks),
    AtomSelection,
  ];
}

export function emptyDoc(): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export { mergeAttributes };
