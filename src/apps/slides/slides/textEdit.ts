import { Extension, Mark, Node, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { stepFontSize } from '@/shared/office/fonts';
import type { Para, ParaProps, Run, RunProps, TextBody } from './model';
import { resolvePara, resolveRun, type TextStyleChain } from './resolve';
import { fieldText, fullRunCss, paraLooks, styleString, type TextEnv } from './textStyle';

/**
 * Editing text in a shape with ProseMirror (through TipTap). The document
 * is Slides' own model in ProseMirror's clothes: paragraphs carry their
 * DrawingML paragraph properties, text carries its run properties in one
 * "run" mark, and a plugin styles both with the same CSS the static slide
 * uses (textStyle.ts), so the text looks the same while you type in it.
 */

export interface Look {
  chain: TextStyleChain;
  env: TextEnv;
}

const objAttr = (def: unknown) => ({ default: def, parseHTML: () => def, renderHTML: () => ({}) });

const SlideDoc = Node.create({ name: 'doc', topNode: true, content: 'paragraph+' });
const SlideText = Node.create({ name: 'text', group: 'inline' });

const SlidePara = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return { props: objAttr({}), end: objAttr(null) };
  },
  parseHTML: () => [{ tag: 'p' }, { tag: 'div' }],
  renderHTML: () => ['p', { class: 'sl-p' }, 0],
});

const LineBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  addAttributes() {
    return { props: objAttr({}) };
  },
  parseHTML: () => [{ tag: 'br' }],
  renderHTML: () => ['br'],
  renderText: () => '\n',
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak', attrs: { props: currentRunProps(this.editor.state) } }),
    };
  },
});

const Field = Node.create<{ slideNumber: () => number }>({
  name: 'field',
  group: 'inline',
  inline: true,
  atom: true,
  addOptions() {
    return { slideNumber: () => 1 };
  },
  addAttributes() {
    return { type: objAttr(''), id: objAttr(''), text: objAttr(''), props: objAttr({}) };
  },
  renderHTML({ node }) {
    const env = { slideNumber: this.options.slideNumber() } as TextEnv;
    return ['span', { 'data-field': node.attrs.type as string }, fieldText(node.attrs.type as string, node.attrs.text as string, env)];
  },
  renderText: ({ node }) => node.attrs.text as string,
});

const RunMark = Mark.create({
  name: 'run',
  inclusive: true,
  addAttributes() {
    return { props: objAttr({}) };
  },
  renderHTML: () => ['span', {}, 0],
});

/** Styles paragraphs and runs the way the slide draws them. */
const Styling = Extension.create<{ look: () => Look }>({
  name: 'slideStyling',
  addOptions() {
    return { look: () => ({}) as Look };
  },
  addProseMirrorPlugins() {
    const look = this.options.look;
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { chain, env } = look();
            const paras: Para[] = [];
            state.doc.forEach((node) => paras.push(paraFromNode(node)));
            const looks = paraLooks(paras, chain, env);
            const decos: Decoration[] = [];
            let i = 0;
            state.doc.forEach((node, offset) => {
              const l = looks[i];
              const attrs: Record<string, string> = { style: styleString(l.style) };
              if (l.bullet) attrs['data-bu'] = l.bullet;
              decos.push(Decoration.node(offset, offset + node.nodeSize, attrs));
              const end = (node.attrs.end as RunProps | null) ?? {};
              node.forEach((child, childOffset) => {
                const from = offset + 1 + childOffset;
                const props = child.isText ? (runOf(child) ?? end) : ((child.attrs.props as RunProps) ?? {});
                decos.push(Decoration.inline(from, from + child.nodeSize, { style: styleString(fullRunCss(props, l.rp, env)) }));
              });
              i++;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

const runOf = (n: PMNode): RunProps | null => (n.marks.find((m) => m.type.name === 'run')?.attrs.props as RunProps | undefined) ?? null;

function paraFromNode(node: PMNode): Para {
  const end = (node.attrs.end as RunProps | null) ?? undefined;
  const runs: Run[] = [];
  node.forEach((c) => {
    if (c.isText) runs.push({ kind: 'text', text: c.text ?? '', props: runOf(c) ?? end ?? {} });
    else if (c.type.name === 'hardBreak') runs.push({ kind: 'br', props: (c.attrs.props as RunProps) ?? {} });
    else if (c.type.name === 'field') runs.push({ kind: 'field', type: c.attrs.type as string, id: c.attrs.id as string, text: c.attrs.text as string, props: (c.attrs.props as RunProps) ?? {} });
  });
  const props = node.attrs.props as ParaProps;
  return end ? { props, runs, end } : { props, runs };
}

export function textToDoc(body: TextBody): JSONContent {
  return {
    type: 'doc',
    content: body.paras.map((p) => ({
      type: 'paragraph',
      attrs: { props: p.props, end: p.end ?? null },
      content: p.runs
        .map((r): JSONContent | null => {
          if (r.kind === 'br') return { type: 'hardBreak', attrs: { props: r.props } };
          if (r.kind === 'field') return { type: 'field', attrs: { type: r.type, id: r.id, text: r.text, props: r.props } };
          return r.text ? { type: 'text', text: r.text, marks: [{ type: 'run', attrs: { props: r.props } }] } : null;
        })
        .filter((c): c is JSONContent => !!c),
    })),
  };
}

export function docToText(doc: PMNode, base: TextBody): TextBody {
  const paras: Para[] = [];
  doc.forEach((node) => {
    const p = paraFromNode(node);
    // Typing in an empty paragraph gives text its end properties; keep the
    // end properties of a paragraph the same as its last run's.
    const last = [...p.runs].reverse().find((r) => r.kind === 'text');
    if (last && !p.end) p.end = last.props;
    paras.push(p);
  });
  return { ...base, paras: paras.length ? paras : [{ props: {}, runs: [] }] };
}

export function slideExtensions(look: () => Look, slideNumber: () => number, keys: Record<string, (editor: Editor) => boolean>) {
  const Keys = Extension.create({
    name: 'slideKeys',
    addKeyboardShortcuts() {
      return Object.fromEntries(Object.entries(keys).map(([k, fn]) => [k, () => fn(this.editor)]));
    },
  });
  return [SlideDoc, SlidePara, SlideText, LineBreak, Field.configure({ slideNumber }), RunMark, Styling.configure({ look }), Keys];
}

// ---- Commands ------------------------------------------------------------------------

/** The run properties typing would get at the caret, or of the selection's start. */
export function currentRunProps(state: EditorState): RunProps {
  const { $from, empty } = state.selection;
  const stored = state.storedMarks?.find((m) => m.type.name === 'run');
  if (stored) return stored.attrs.props as RunProps;
  const para = $from.parent;
  const end = (para.attrs.end as RunProps | null) ?? {};
  const node = empty ? ($from.nodeBefore ?? $from.nodeAfter) : ($from.nodeAfter ?? $from.nodeBefore);
  if (node?.isText) return runOf(node) ?? end;
  if (node && node.attrs.props && node.type.name !== 'paragraph') return node.attrs.props as RunProps;
  return end;
}

export function currentParaProps(state: EditorState): ParaProps {
  return (state.selection.$from.parent.attrs.props as ParaProps) ?? {};
}

/** Resolved run and paragraph properties at the selection, for the ribbon. */
export function editorLook(state: EditorState, look: Look): { run: RunProps; para: ParaProps; algn: string } {
  const para = currentParaProps(state);
  const rp = resolvePara(para, look.chain);
  return { run: resolveRun(currentRunProps(state), rp), para, algn: rp.algn };
}

function paragraphsInSelection(state: EditorState): { node: PMNode; pos: number }[] {
  const { from, to } = state.selection;
  const out: { node: PMNode; pos: number }[] = [];
  state.doc.forEach((node, pos) => {
    if (pos + node.nodeSize > from && pos <= to) out.push({ node, pos });
  });
  if (!out.length) {
    const $p = state.selection.$from;
    out.push({ node: $p.parent, pos: $p.before() });
  }
  return out;
}

export function applyRun(editor: Editor, fn: (p: RunProps) => RunProps): void {
  const { state } = editor;
  const type = state.schema.marks.run;
  const { from, to, empty } = state.selection;
  let tr: Transaction = state.tr;
  if (empty) {
    const next = fn(currentRunProps(state));
    tr = tr.setStoredMarks([type.create({ props: next })]);
    const $p = state.selection.$from;
    if ($p.parent.content.size === 0 && $p.depth > 0) tr = tr.setNodeMarkup($p.before(), undefined, { ...$p.parent.attrs, end: next });
    editor.view.dispatch(tr);
    return;
  }
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name === 'paragraph') {
      const end = (node.attrs.end as RunProps | null) ?? {};
      // A whole-paragraph selection restyles its end mark too.
      if (pos >= from - 1 && pos + node.nodeSize <= to + 1) tr = tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, end: fn(end) });
      return true;
    }
    const end = ((parent?.attrs.end as RunProps | null) ?? {}) as RunProps;
    if (node.isText) {
      const a = Math.max(pos, from);
      const b = Math.min(pos + node.nodeSize, to);
      const next = fn(runOf(node) ?? end);
      tr = tr.removeMark(a, b, type).addMark(a, b, type.create({ props: next }));
    } else if (node.type.name === 'hardBreak' || node.type.name === 'field') {
      tr = tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, props: fn((node.attrs.props as RunProps) ?? {}) });
    }
    return false;
  });
  editor.view.dispatch(tr);
}

export function applyPara(editor: Editor, fn: (p: ParaProps) => ParaProps): void {
  const { state } = editor;
  let tr = state.tr;
  for (const { node, pos } of paragraphsInSelection(state)) {
    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, props: fn((node.attrs.props as ParaProps) ?? {}) });
  }
  editor.view.dispatch(tr);
}

/** Tab at the start of a paragraph (or across several) demotes it; elsewhere it types a tab. */
export function tabKey(editor: Editor, dir: 1 | -1): boolean {
  const { state } = editor;
  const { $from, empty, from, to } = state.selection;
  const multi = !empty && state.doc.resolve(to).parent !== $from.parent;
  const atStart = empty && $from.parentOffset === 0;
  if (dir > 0 && !multi && !atStart) {
    editor.view.dispatch(state.tr.insertText('\t', from, to));
    return true;
  }
  applyPara(editor, (p) => {
    const lvl = Math.max(0, Math.min(8, (p.lvl ?? 0) + dir));
    const next: ParaProps = { ...p, lvl };
    delete next.marL;
    delete next.indent;
    if (!lvl) delete next.lvl;
    return next;
  });
  return true;
}

export function growFont(p: RunProps, dir: 1 | -1, base: number): RunProps {
  return { ...p, sz: Math.round(stepFontSize((p.sz ?? base) / 100, dir) * 100) };
}

export function selectAllText(editor: Editor): void {
  const { state } = editor;
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
}

export function placeCaret(editor: Editor, x: number, y: number): void {
  const pos = editor.view.posAtCoords({ left: x, top: y });
  if (!pos) return;
  const { state } = editor;
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos.pos)));
}

/** The plain text of the selection, for the clipboard. */
export function selectedText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n', '\n');
}

/** The document position of a plain-text offset (paragraphs joined by newlines). */
export function offsetToPos(doc: PMNode, offset: number): number {
  let left = offset;
  let result = doc.content.size - 1;
  let found = false;
  doc.forEach((para, paraPos) => {
    if (found) return;
    let pos = paraPos + 1;
    para.forEach((child) => {
      if (found) return;
      const len = child.isText ? (child.text ?? '').length : 1;
      if (left <= len && child.isText) {
        result = pos + left;
        found = true;
        return;
      }
      left -= len;
      pos += child.nodeSize;
    });
    if (found) return;
    if (left === 0) {
      result = pos;
      found = true;
      return;
    }
    left -= 1;
  });
  return result;
}

export function selectRange(editor: Editor, from: number, to: number): void {
  const { state } = editor;
  const a = offsetToPos(state.doc, from);
  const b = offsetToPos(state.doc, to);
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, a, b)).scrollIntoView());
}

/** Change the case of the selected text, keeping its formatting. */
export function changeCaseIn(editor: Editor, fn: (s: string) => string): void {
  const { state } = editor;
  const { from, to } = state.selection;
  let tr = state.tr;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const a = Math.max(pos, from);
    const b = Math.min(pos + node.nodeSize, to);
    const text = (node.text ?? '').slice(a - pos, b - pos);
    tr = tr.replaceWith(a, b, state.schema.text(fn(text), node.marks));
    return false;
  });
  editor.view.dispatch(tr);
}
