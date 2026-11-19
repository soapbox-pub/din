/**
 * Where a highlight's excerpt is in its context (NIP-84), for the desktop's
 * composer, Din's card for a kind 9802, and the Assistant, which gives a
 * reply's whole Markdown as the context of text selected in it as drawn.
 */

/** Longest excerpt offered as a highlight (guards "Select All" of an article). */
export const MAX_HIGHLIGHT_LENGTH = 5000;
/** Longest context attached to a highlight: a long assistant reply, whole. */
export const MAX_HIGHLIGHT_CONTEXT_LENGTH = 20_000;
/** Longest excerpt looked for in Markdown, past which only an exact match counts. */
const MAX_LOOSE_LENGTH = 1000;

const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Markdown's marks that drawing it takes away, as they can sit between two
 * characters of the text drawn: emphasis, code and strikethrough marks, a
 * link's brackets and address, an escaping backslash.
 */
const INLINE = String.raw`(?:[*_~\x60[\\]|\]\([^)\s]*\))*`;
/** Whitespace drawn, as Markdown can write it: with a list's, a heading's or a quote's marker after a line break. */
const SPACE = String.raw`${INLINE}\s+(?:(?:[-*+]|\d+[.)]|#{1,6})\s+|>\s*)*${INLINE}`;

/**
 * Where `text` is in `context`, as [start, end): the excerpt word for word,
 * else (in Markdown, for an excerpt of what it draws) with Markdown's marks
 * and its line breaks' markers allowed between its characters. Null when it
 * isn't there.
 */
export function locateExcerpt(context: string, text: string): [number, number] | null {
  if (!text) return null;
  const exact = context.indexOf(text);
  if (exact >= 0) return [exact, exact + text.length];
  if (text.length > MAX_LOOSE_LENGTH) return null;
  let pattern = '';
  for (const part of text.trim().split(/(\s+)/)) {
    if (!part) continue;
    pattern += /^\s+$/.test(part) ? SPACE : [...part].map(escape).join(INLINE);
  }
  if (!pattern) return null;
  const match = new RegExp(pattern).exec(context);
  return match ? [match.index, match.index + match[0].length] : null;
}
