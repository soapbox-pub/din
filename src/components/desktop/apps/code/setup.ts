import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { showMinimap } from '@replit/codemirror-minimap';
import { createFindPanel } from './findPanel';
import { editorChrome, fontSizeTheme, syntaxTheme } from './theme';

export interface EditorPrefs {
  wrap: boolean;
  fontSize: number;
  dark: boolean;
  minimap: boolean;
}

export const languageConf = new Compartment();
export const indentConf = new Compartment();
const wrapConf = new Compartment();
const fontConf = new Compartment();
const themeConf = new Compartment();
const minimapConf = new Compartment();

const minimap = showMinimap.compute([], () => ({
  create: () => ({ dom: document.createElement('div') }),
  displayText: 'blocks',
  showOverlay: 'mouse-over',
}));

const wrapExt = (on: boolean) => (on ? EditorView.lineWrapping : []);
const minimapExt = (on: boolean) => (on ? minimap : []);

/** Reconfigure an editor to the window's current preferences. */
export function prefEffects(prefs: EditorPrefs): StateEffect<unknown>[] {
  return [
    wrapConf.reconfigure(wrapExt(prefs.wrap)),
    fontConf.reconfigure(fontSizeTheme(prefs.fontSize)),
    themeConf.reconfigure(syntaxTheme(prefs.dark)),
    minimapConf.reconfigure(minimapExt(prefs.minimap)),
  ];
}

const shared: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  foldGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  // Words from the file, alongside whatever the language offers.
  EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  indentationMarkers({ markerType: 'codeOnly' }),
  search({ top: true, createPanel: createFindPanel }),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    indentWithTab,
  ]),
  editorChrome,
];

/** A document's state, with everything the editor does. */
export function createEditorState(doc: string, prefs: EditorPrefs, listener: Extension): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      shared,
      listener,
      languageConf.of([]),
      indentConf.of(indentUnit.of(detectIndent(doc))),
      wrapConf.of(wrapExt(prefs.wrap)),
      fontConf.of(fontSizeTheme(prefs.fontSize)),
      themeConf.of(syntaxTheme(prefs.dark)),
      minimapConf.of(minimapExt(prefs.minimap)),
    ],
  });
}

/**
 * How a file indents: a tab when most indented lines start with one, else
 * the commonest step between space indents, else four spaces.
 */
export function detectIndent(doc: string): string {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of doc.split('\n', 10_000)) {
    if (!line.trim()) continue;
    if (line[0] === '\t') {
      tabs++;
      continue;
    }
    const width = /^ */.exec(line)![0].length;
    if (width > 0) spaces++;
    const step = Math.abs(width - previous);
    if (step > 1 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs > spaces) return '\t';
  let best = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return best ? ' '.repeat(best) : '    ';
}

/** "Tabs" or "Spaces: 2", for the status bar. */
export function describeIndent(unit: string): string {
  return unit === '\t' ? 'Tabs' : `Spaces: ${unit.length}`;
}

export { indentUnit };
