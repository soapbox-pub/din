import { useEffect, useLayoutEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import { UndoRedo } from '@tiptap/extensions';
import type { TextBody } from './model';
import { docToText, placeCaret, selectAllText, selectRange, slideExtensions, tabKey, textToDoc, type Look } from './textEdit';

export interface EditStart {
  /** Where the click that started editing was, to put the caret there. */
  caret?: { x: number; y: number };
  selectAll?: boolean;
  /** Text typed on the selected shape, which replaces its text. */
  typed?: string;
  /** Text to select, as plain-text offsets (Find). */
  range?: { from: number; to: number };
}

/**
 * A shape's text while it's being edited: ProseMirror mounted in the
 * shape's text box. It owns the text until editing ends, reporting every
 * change so the thumbnails and the file follow along.
 */
export function ShapeTextEditor({
  body,
  look,
  slideNumber,
  start,
  onChange,
  onExit,
  onReady,
  onSelection,
  onMeasure,
  keys,
}: {
  body: TextBody;
  look: Look;
  slideNumber: number;
  start: EditStart;
  onChange: (body: TextBody) => void;
  onExit: () => void;
  onReady: (editor: Editor | null) => void;
  onSelection: () => void;
  onMeasure?: (size: { w: number; h: number }) => void;
  keys: Record<string, (editor: Editor) => boolean>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const live = useRef({ body, look, slideNumber, onChange, onExit, onReady, onSelection, onMeasure, keys, start });
  useLayoutEffect(() => {
    live.current = { body, look, slideNumber, onChange, onExit, onReady, onSelection, onMeasure, keys, start };
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const L = live.current;
    const keyMap: Record<string, (e: Editor) => boolean> = {
      Tab: (e) => tabKey(e, 1),
      'Shift-Tab': (e) => tabKey(e, -1),
      Escape: () => {
        live.current.onExit();
        return true;
      },
    };
    for (const k of Object.keys(L.keys)) keyMap[k] = (e) => live.current.keys[k](e);
    const editor = new Editor({
      element: el,
      extensions: [...slideExtensions(() => live.current.look, () => live.current.slideNumber, keyMap), UndoRedo.configure({ depth: 200 })],
      content: textToDoc(L.body),
      editorProps: { attributes: { spellcheck: 'true', 'aria-label': 'Shape text', role: 'textbox', 'aria-multiline': 'true' } },
      onUpdate: ({ editor: e }) => live.current.onChange(docToText(e.state.doc, live.current.body)),
      onSelectionUpdate: () => live.current.onSelection(),
      onTransaction: () => live.current.onSelection(),
    });
    editorRef.current = editor;
    editor.view.focus();
    const s = L.start;
    if (s.typed !== undefined) {
      selectAllText(editor);
      editor.view.dispatch(editor.state.tr.insertText(s.typed));
    } else if (s.range) selectRange(editor, s.range.from, s.range.to);
    else if (s.selectAll) selectAllText(editor);
    else if (s.caret) placeCaret(editor, s.caret.x, s.caret.y);
    else editor.commands.focus('end');
    L.onReady(editor);
    const ro = new ResizeObserver(() => {
      const pm = el.firstElementChild as HTMLElement | null;
      if (pm) live.current.onMeasure?.({ w: pm.scrollWidth, h: pm.offsetHeight });
    });
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      ro.disconnect();
      live.current.onReady(null);
      editorRef.current = null;
      editor.destroy();
    };
  }, []);

  // Restyle when what the text inherits changes (a new theme or font scale).
  const env = look.env;
  const lookKey = [env.fontScale, env.lnReduction, env.theme.majorFont, env.theme.minorFont, ...Object.values(env.theme.colors), ...Object.values(env.clrMap)].join('|');
  useEffect(() => {
    const e = editorRef.current;
    if (e && !e.isDestroyed) e.view.dispatch(e.state.tr.setMeta('slideLook', lookKey));
  }, [lookKey]);

  return <div ref={host} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} style={{ cursor: 'text' }} />;
}
