/**
 * Text as it's read aloud: Markdown (the assistant's replies) turned into
 * what a person would say reading it, and long text cut into the pieces the
 * voice makes one at a time.
 */

/** A path's last part: "/home/din/src/App.tsx" is read "App.tsx". */
function shortPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}

/** Ends a line that's a thought of its own (a heading, a list item, a table row) with a stop. */
function stop(line: string): string {
  const text = line.trim();
  if (!text) return '';
  return /[.!?…:;,]$/.test(text) ? text : `${text}.`;
}

/**
 * What a reader says for Markdown: no code blocks (they're for looking at),
 * links by their words, pictures by their descriptions, paths by their
 * names, web addresses by their sites, tables by their cells, and every
 * heading, list item and row its own sentence.
 */
export function speakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  // Fenced code, and indented code after a blank line.
  text = text.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm, '\n');
  text = text.replace(/(^|\n\n)((?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/g, '$1');
  // Markup that isn't words.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');
  // Inline code keeps its words; a path in it is read by its name.
  text = text.replace(/`+([^`\n]+)`+/g, (_, code: string) => code);
  text = text.replace(/\bhttps?:\/\/(?:www\.)?([^/\s)>\]]+?)(?:[/?#][^\s)>\]]*?)?([.,!?;:]*)(?=[\s)>\]]|$)/g, '$1$2');
  text = text.replace(/(^|[\s(])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?)(?::\d+(?::\d+)?)?/g, (_, lead: string, path: string) => lead + shortPath(path));
  text = text.replace(/(^|[\s(])([\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?(?=[\s),.;:!?]|$)/g, (_, lead: string, path: string) => lead + shortPath(path));
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    // Rules, and a table's line under its heading.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(', ');
      lines.push(stop(line));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      lines.push(stop(heading[1] ?? ''), '');
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      lines.push(stop(item[1] ?? ''));
      continue;
    }
    line = line.replace(/^\s{0,3}>\s?/, '');
    lines.push(line);
  }
  text = lines.join('\n');
  // Emphasis, strikethrough and escapes.
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2');
  text = text.replace(/~~(.+?)~~/g, '$1').replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
  text = text.replace(/[*`~#|]+/g, ' ').replace(/(?<!\w)_+|_+(?!\w)/g, ' ');
  // Arrows, as said.
  text = text.replace(/\s*(?:→|->|⇒|=>)\s*/g, ' to ').replace(/\s*(?:←|<-)\s*/g, ' from ');
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** The first piece is short, so the voice starts soon; later ones are longer, so it makes fewer. */
const FIRST_PIECE = 160;
const PIECE = 400;
/** No piece is longer than this, even a sentence that never ends. */
const LONGEST = 1200;

/** Cuts a run of words too long for one piece at spaces. */
function cut(sentence: string): string[] {
  if (sentence.length <= LONGEST) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > LONGEST) {
    const at = rest.lastIndexOf(' ', LONGEST);
    const end = at > LONGEST / 2 ? at : LONGEST;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Text in the pieces it's read in, each whole sentences: the first one
 * sentence (or two short ones), the rest a few at a time, and a paragraph's
 * end always the end of a piece.
 */
export function speechPieces(text: string): string[] {
  const pieces: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const sentences = paragraph
      .split(/(?<=[.!?…])["'”’)\]]*\s+(?=\S)/)
      .flatMap((s) => cut(s.trim()))
      .filter(Boolean);
    let current = '';
    for (const sentence of sentences) {
      const limit = pieces.length === 0 ? FIRST_PIECE : PIECE;
      if (current && current.length + sentence.length + 1 > limit) {
        pieces.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) pieces.push(current);
  }
  return pieces;
}
