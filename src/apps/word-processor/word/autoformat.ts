import { Extension, InputRule } from '@tiptap/core';
import type { BulletKind, NumberKind } from './numbering';

/**
 * Word's AutoCorrect and AutoFormat As You Type: smart quotes, dashes, (c)
 * and friends, capitals at the start of sentences, and "* " or "1. " at the
 * start of a paragraph turning it into a list. Backspace straight after one
 * undoes it, as in Word. (A rule's range ends after the character just typed,
 * which is in the document by the time the handler runs. Enter runs rules
 * too, as a newline, so they look for real spaces.)
 */

const REPLACEMENTS: [RegExp, string][] = [
  [/\(c\)$/i, '©'],
  [/\(r\)$/i, '®'],
  [/\(tm\)$/i, '™'],
  [/\.\.\.$/, '…'],
  [/-->$/, '→'],
  [/<--$/, '←'],
  [/==>$/, '⇒'],
  [/<==$/, '⇐'],
  [/<=>$/, '⇔'],
];

export type ListKind = { bullet: BulletKind } | { number: NumberKind };

/** Typing "* " or "1. " asks the app to start a list with this event on the editor's element. */
export const AUTO_LIST_EVENT = 'wp-auto-list';

export function autoFormat() {
  return Extension.create({
    name: 'wordAutoFormat',
    addInputRules() {
      const startList = (kind: ListKind) => {
        queueMicrotask(() => this.editor.view.dom.dispatchEvent(new CustomEvent<ListKind>(AUTO_LIST_EVENT, { detail: kind })));
      };
      const rules: InputRule[] = [];
      for (const [find, to] of REPLACEMENTS) {
        rules.push(
          new InputRule({
            find,
            handler: ({ state, range }) => {
              state.tr.insertText(to, range.from, range.to);
            },
          }),
        );
      }
      // Quotes curl toward the text they belong to.
      rules.push(
        new InputRule({
          find: /(^|[\s([{\u2018\u201c-])"$/,
          handler: ({ state, range, match }) => {
            state.tr.insertText(`${match[1]}“`, range.from, range.to);
          },
        }),
        new InputRule({
          find: /"$/,
          handler: ({ state, range }) => {
            state.tr.insertText('”', range.from, range.to);
          },
        }),
        new InputRule({
          find: /(^|[\s([{\u201c-])'$/,
          handler: ({ state, range, match }) => {
            state.tr.insertText(`${match[1]}‘`, range.from, range.to);
          },
        }),
        new InputRule({
          find: /'$/,
          handler: ({ state, range }) => {
            state.tr.insertText('’', range.from, range.to);
          },
        }),
        // "word -- word" gets an en dash, "word--word" an em dash.
        new InputRule({
          find: /(\S) -- (\S)$/,
          handler: ({ state, range, match }) => {
            state.tr.insertText(`${match[1]} – ${match[2]}`, range.from, range.to);
          },
        }),
        new InputRule({
          find: /(\w)--(\w)$/,
          handler: ({ state, range, match }) => {
            state.tr.insertText(`${match[1]}—${match[2]}`, range.from, range.to);
          },
        }),
        // Capitalize the first letter of a sentence once its first word is typed.
        new InputRule({
          find: /(?:^|[.!?]["”’)]?\s+)([a-z][a-z]*)([ ,;:])$/,
          handler: ({ state, range, match }) => {
            // The range ends after what was just typed, which is in the document already.
            const at = range.to - match[2].length - match[1].length;
            state.tr.insertText(match[1][0].toUpperCase(), at, at + 1);
          },
        }),
        new InputRule({
          find: /(^|\s)i( |[’'])$/,
          handler: ({ state, range, match }) => {
            const at = range.from + match[1].length;
            if (match[2] === "'") state.tr.insertText('’', range.to - 1, range.to);
            state.tr.insertText('I', at, at + 1);
          },
        }),
        // Lists: "* ", "- " or "1. " at the start of a paragraph.
        new InputRule({
          find: /^([*\-•>]) $/,
          handler: ({ state, range, match }) => {
            state.tr.delete(range.from, range.to);
            const kind: BulletKind = match[1] === '>' ? 'arrow' : 'disc';
            startList({ bullet: kind });
          },
        }),
        new InputRule({
          find: /^(1|a|A|i|I)([.)]) $/,
          handler: ({ state, range, match }) => {
            state.tr.delete(range.from, range.to);
            const kinds: Record<string, NumberKind> = { '1.': '1.', '1)': '1)', 'a.': 'a.', 'a)': 'a)', 'A.': 'A.', 'A)': 'A.', 'i.': 'i.', 'i)': 'i.', 'I.': 'I.', 'I)': 'I.' };
            const kind = kinds[match[1] + match[2]] ?? '1.';
            startList({ number: kind });
          },
        }),
      );
      return rules;
    },
  });
}
