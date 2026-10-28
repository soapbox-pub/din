import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

export const MONO_FONT = "ui-monospace, 'Noto Sans Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace";

const mix = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`;
const SELECTION = mix('var(--sidebar-ring)', 28);

/** The editor's chrome, in Din's colors so it follows light and dark on its own. */
export const editorChrome = EditorView.theme({
  '&': { height: '100%', color: 'var(--foreground)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO_FONT, overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': {
    backgroundColor: mix('var(--foreground)', 3),
    color: mix('var(--muted-foreground)', 85),
    border: 'none',
    borderRight: `1px solid ${mix('var(--border)', 50)}`,
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 16px', minWidth: '40px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-activeLine': { backgroundColor: mix('var(--foreground)', 4) },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: `${SELECTION} !important` },
  '.cm-selectionMatch': { backgroundColor: mix('var(--sidebar-ring)', 14) },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: mix('var(--sidebar-ring)', 20),
    outline: `1px solid ${mix('var(--sidebar-ring)', 60)}`,
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: mix('var(--destructive)', 30) },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, #f59e0b 30%, transparent)',
    outline: '1px solid color-mix(in oklab, #f59e0b 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklab, #f59e0b 60%, transparent)' },
  '.cm-foldPlaceholder': {
    backgroundColor: mix('var(--foreground)', 10),
    border: 'none',
    color: 'var(--muted-foreground)',
    padding: '0 6px',
    borderRadius: '4px',
  },
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${mix('var(--border)', 60)}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${mix('var(--border)', 60)}` },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: MONO_FONT, maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: mix('var(--sidebar-ring)', 30),
    color: 'var(--foreground)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--sidebar-ring)' },
  '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal' },
  '.cm-indentation-marker': { opacity: '0.6' },
});

/** Font size, and a line height that keeps rows readable as it grows. */
export function fontSizeTheme(px: number): Extension {
  return EditorView.theme({
    '&': { fontSize: `${px}px` },
    '.cm-scroller': { lineHeight: `${Math.round(px * 1.55)}px` },
  });
}

const light = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: '#cf222e' },
  { tag: [t.string, t.special(t.string), t.character], color: '#0a3069' },
  { tag: [t.regexp, t.escape], color: '#116329' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6e7781', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal, t.unit], color: '#0550ae' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#8250df' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: '#953800' },
  { tag: [t.propertyName, t.attributeName], color: '#0550ae' },
  { tag: [t.tagName, t.angleBracket], color: '#116329' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName), t.self], color: '#0550ae' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: '#6e7781' },
  { tag: t.heading, color: '#0550ae', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#0a3069', textDecoration: 'underline' },
  { tag: t.inserted, color: '#116329', backgroundColor: '#dafbe1' },
  { tag: t.deleted, color: '#82071e', backgroundColor: '#ffebe9' },
  { tag: t.changed, color: '#953800' },
  { tag: t.invalid, color: '#82071e' },
]);

const dark = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: '#ff7b72' },
  { tag: [t.string, t.special(t.string), t.character], color: '#a5d6ff' },
  { tag: [t.regexp, t.escape], color: '#7ee787' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#8b949e', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal, t.unit], color: '#79c0ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#d2a8ff' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: '#ffa657' },
  { tag: [t.propertyName, t.attributeName], color: '#79c0ff' },
  { tag: [t.tagName, t.angleBracket], color: '#7ee787' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName), t.self], color: '#79c0ff' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: '#8b949e' },
  { tag: t.heading, color: '#79c0ff', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#a5d6ff', textDecoration: 'underline' },
  { tag: t.inserted, color: '#aff5b4', backgroundColor: '#033a16' },
  { tag: t.deleted, color: '#ffdcd7', backgroundColor: '#67060c' },
  { tag: t.changed, color: '#ffa657' },
  { tag: t.invalid, color: '#ffa198' },
]);

/** Syntax colors for a light or dark desktop. */
export function syntaxTheme(isDark: boolean): Extension {
  return [syntaxHighlighting(isDark ? dark : light), EditorView.darkTheme.of(isDark)];
}
