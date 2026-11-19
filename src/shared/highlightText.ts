/**
 * Highlights of Markdown (NIP-84), for the Assistant, whose replies are
 * Markdown drawn: text selected as drawn is found in the Markdown, and the
 * highlight is the Markdown itself, its `content` a slice of its `context`
 * word for word, as NIP-84 has it.
 */

/** Longest excerpt offered as a highlight (guards "Select All" of an article). */
export const MAX_HIGHLIGHT_LENGTH = 5000;
/** Longest context attached to a highlight: a long assistant reply, whole. */
export const MAX_HIGHLIGHT_CONTEXT_LENGTH = 20_000;
/** Longest selection looked for loosely, past which only an exact match counts. */
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
 * Where text selected as drawn is in the Markdown, as [start, end): word for
 * word, else with Markdown's marks and its line breaks' markers allowed
 * between its characters. Null when it isn't there.
 */
function locate(markdown: string, text: string): [number, number] | null {
  const exact = markdown.indexOf(text);
  if (exact >= 0) return [exact, exact + text.length];
  if (text.length > MAX_LOOSE_LENGTH) return null;
  let pattern = '';
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    pattern += /^\s+$/.test(part) ? SPACE : [...part].map(escape).join(INLINE);
  }
  if (!pattern) return null;
  const match = new RegExp(pattern).exec(markdown);
  return match ? [match.index, match.index + match[0].length] : null;
}

/** Emphasis, strikethrough and code marks, longest first. */
const MARKS = ['***', '___', '**', '__', '~~', '*', '_', '~', '`'];

/** How many times a mark stands on its own in `text`, as a run of exactly its characters. */
function markCount(text: string, mark: string): number {
  const char = escape(mark[0]!);
  return (text.match(new RegExp(`(?<!${char})${escape(mark)}(?!${char})`, 'g')) ?? []).length;
}

/**
 * The slice widened to be Markdown of its own: a mark it opens or closes
 * without its partner takes in the partner just outside it, and a link it
 * holds a part of takes in the rest of the link.
 */
function widen(markdown: string, start: number, end: number): [number, number] {
  for (let pass = 0; pass < 4; pass++) {
    const before = [start, end];
    const slice = markdown.slice(start, end);
    for (const mark of MARKS) {
      if (markCount(slice, mark) % 2 === 0) continue;
      const char = mark[0]!;
      if (markdown.slice(start - mark.length, start) === mark && markdown[start - mark.length - 1] !== char) start -= mark.length;
      else if (markdown.slice(end, end + mark.length) === mark && markdown[end + mark.length] !== char) end += mark.length;
    }
    // A link's text or its address cut in two.
    const opens = (markdown.slice(start, end).match(/\[/g) ?? []).length;
    const closes = (markdown.slice(start, end).match(/\]\(/g) ?? []).length;
    if (closes > opens) {
      const open = markdown.lastIndexOf('[', start - 1);
      if (open >= 0 && !markdown.slice(open, start).includes('\n')) start = open;
    } else if (opens > closes) {
      const link = /^[^\n[\]]*\]\([^)\s]*\)/.exec(markdown.slice(end));
      if (link) end += link[0].length;
    }
    const tail = /^[^\s)]*\)/.exec(markdown.slice(end));
    if (tail && /\]\([^)\s]*$/.test(markdown.slice(start, end))) end += tail[0].length;
    if (before[0] === start && before[1] === end) break;
  }
  return [start, end];
}

/** The paragraphs (blank-line-separated blocks) of `markdown` that [start, end) is in. */
function paragraphsAround(markdown: string, start: number, end: number): string {
  const from = markdown.lastIndexOf('\n\n', start);
  const to = markdown.indexOf('\n\n', end);
  return markdown.slice(from < 0 ? 0 : from + 2, to < 0 ? markdown.length : to);
}

/**
 * A highlight of text selected in drawn Markdown, as Markdown: its `content`
 * the slice of the Markdown that draws the selection (widened to whole marks
 * and links), its `context` the whole Markdown, or the paragraphs around it
 * when that's too long. `content` is always in `context` word for word. Null
 * when the selection isn't found in the Markdown, or is too long.
 */
export function markdownHighlight(markdown: string, text: string): { content: string; context?: string } | null {
  if (!text) return null;
  const at = locate(markdown, text);
  if (!at) return null;
  const [start, end] = widen(markdown, at[0], at[1]);
  const content = markdown.slice(start, end).trim();
  if (!content || content.length > MAX_HIGHLIGHT_LENGTH) return null;
  const context = markdown.length <= MAX_HIGHLIGHT_CONTEXT_LENGTH ? markdown : paragraphsAround(markdown, start, end);
  return context !== content && context.length <= MAX_HIGHLIGHT_CONTEXT_LENGTH ? { content, context } : { content };
}
