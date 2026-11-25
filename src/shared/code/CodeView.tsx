import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { useIsDark } from '@/hooks/useIsDark';
import { editorChrome, fontSizeTheme, syntaxTheme } from '@/shared/codeTheme';
import { createFindPanel } from '@/shared/code/findPanel';
import { languageFor, languageForShebang } from '@/shared/code/languages';

/*
 * Code to read, not edit: the Text Editor's colors, languages, gutter and
 * find bar (Ctrl+F), in a view that can be selected and copied from but not
 * typed in. CodeMirror draws only the lines in sight, so a long file costs
 * no more than a short one. Loaded lazily: CodeMirror and its languages are
 * big.
 */

const FONT_SIZE = 13;

export default function CodeView({ text, name, className }: { text: string; /** The file's name, which picks its language. */ name: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const dark = useIsDark();

  // One view for as long as the component lives; new text replaces its
  // document, keeping where it's scrolled to.
  useEffect(() => {
    const state = EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true, createPanel: createFindPanel }),
        keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
        EditorState.readOnly.of(true),
        editorChrome,
        fontSizeTheme(FONT_SIZE),
        language.current.of([]),
        // Set to the desktop's scheme by the effect below, which runs next.
        theme.current.of([]),
        EditorView.contentAttributes.of({ 'aria-label': 'File contents', 'aria-readonly': 'true' }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === text) return;
    const top = v.scrollDOM.scrollTop;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    v.requestMeasure({ read: () => {}, write: () => (v.scrollDOM.scrollTop = top) });
  }, [text]);

  // The `#!` line only matters for a file whose name says nothing.
  const byName = languageFor(name);
  const description = byName ?? languageForShebang(text.slice(0, 200).split('\n', 1)[0]);
  useEffect(() => {
    if (!description) {
      view.current?.dispatch({ effects: language.current.reconfigure([]) });
      return;
    }
    let live = true;
    description.load().then(
      (support) => live && view.current?.dispatch({ effects: language.current.reconfigure(support) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [description]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(syntaxTheme(dark)) });
  }, [dark]);

  return <div ref={host} className={className} />;
}
