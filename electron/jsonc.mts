// JSON with comments and trailing commas (JSONC), read with where each value
// is in the text, so a file someone wrote by hand can be changed in place:
// an item added to a list or taken out of it, a property set, and everything
// else (their comments, their layout) left as they wrote it. OpenCode's
// config is such a file (assistant-skills.mts).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

export type JsoncNode =
  | { type: 'object'; start: number; end: number; props: { key: string; start: number; value: JsoncNode }[] }
  | { type: 'array'; start: number; end: number; items: JsoncNode[] }
  | { type: 'value'; start: number; end: number; value: string | number | boolean | null };

/** Parse JSONC. Throws where it isn't, naming the line. */
export function parseJsonc(text: string): JsoncNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (what: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`${what} on line ${line}`);
  };

  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('A comment isn’t closed');
        i = end + 2;
      } else return;
    }
  };

  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail('A string isn’t closed');
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) fail('A string isn’t closed');
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      return fail('A string can’t be read');
    }
  };

  const value = (): JsoncNode => {
    skip();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const props: { key: string; start: number; value: JsoncNode }[] = [];
      for (;;) {
        skip();
        if (text[i] === '}') break;
        if (text[i] !== '"') fail('Expected a property’s name');
        const at = i;
        const key = string();
        skip();
        if (text[i] !== ':') fail('Expected “:”');
        i++;
        props.push({ key, start: at, value: value() });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('Expected “,” or “}”');
      }
      i++;
      return { type: 'object', start, end: i, props };
    }
    if (c === '[') {
      i++;
      const items: JsoncNode[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') break;
        if (i >= text.length) fail('A list isn’t closed');
        items.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('Expected “,” or “]”');
      }
      i++;
      return { type: 'array', start, end: i, items };
    }
    if (c === '"') return { type: 'value', start, value: string(), end: i };
    while (i < text.length && /[-+.\w]/.test(text[i])) i++;
    if (i === start) fail(i >= text.length ? 'The file ends early' : `Unexpected “${text[i]}”`);
    try {
      return { type: 'value', start, end: i, value: JSON.parse(text.slice(start, i)) as number | boolean | null };
    } catch {
      i = start;
      return fail('A value can’t be read');
    }
  };

  const root = value();
  skip();
  if (i < text.length) fail('Something follows the end');
  return root;
}

/** What a node says, as JSON.parse would have it. */
export function jsoncValue(node: JsoncNode): unknown {
  if (node.type === 'value') return node.value;
  if (node.type === 'array') return node.items.map(jsoncValue);
  return Object.fromEntries(node.props.map((prop) => [prop.key, jsoncValue(prop.value)]));
}

/** An object's property, the last by that name (as JSON.parse takes it). */
export function jsoncProp(node: JsoncNode, key: string): JsoncNode | null {
  if (node.type !== 'object') return null;
  return node.props.findLast((prop) => prop.key === key)?.value ?? null;
}

/** The whitespace `at` is indented by, or null where it isn't first on its line. */
function indentOf(text: string, at: number): string | null {
  const line = text.lastIndexOf('\n', at - 1) + 1;
  const before = text.slice(line, at);
  return /^[ \t]*$/.test(before) ? before : null;
}

function followingComma(text: string, start: number, close: number): number {
  const trivia = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
  trivia.lastIndex = start;
  const end = start + (trivia.exec(text)?.[0].length ?? 0);
  return end < close && text[end] === ',' ? end : -1;
}

/**
 * `json` after `last`, the final entry of the list or object that closes at
 * `close`: on a line of its own where `last` has one, keeping a comment
 * that follows `last` on its line with it, and a trailing comma if there
 * was one.
 */
function insertAfter(text: string, last: { start: number; end: number }, close: number, json: string): string {
  const indent = indentOf(text, last.start);
  if (indent === null) return `${text.slice(0, last.end)}, ${json}${text.slice(last.end)}`;
  if (!/^[ \t]*(?:,?[ \t]*(?:\/\/[^\n]*)?)?(?:\r?\n|$)/.test(text.slice(last.end, close))) {
    return `${text.slice(0, last.end)}, ${json}${text.slice(last.end)}`;
  }
  const trailing = followingComma(text, last.end, close);
  if (trailing >= 0 && !/^[ \t]*,/.test(text.slice(last.end, close))) {
    return `${text.slice(0, last.end)}, ${json}${text.slice(last.end)}`;
  }
  const comma = /^[ \t]*,/.test(text.slice(last.end, close));
  let lineEnd = text.indexOf('\n', last.end);
  if (lineEnd < 0 || lineEnd > close - 1) lineEnd = close - 1;
  const eol = text[lineEnd - 1] === '\r' && text[lineEnd] === '\n' ? lineEnd - 1 : lineEnd;
  const newline = eol < lineEnd ? '\r\n' : '\n';
  return `${text.slice(0, last.end)}${comma ? '' : ','}${text.slice(last.end, eol)}${newline}${indent}${json}${comma ? ',' : ''}${text.slice(eol)}`;
}

/** The text with `json` added to the end of a list. */
export function appendJsoncItem(text: string, array: JsoncNode & { type: 'array' }, json: string): string {
  const last = array.items.at(-1);
  if (!last) return `${text.slice(0, array.start + 1)}${json}${text.slice(array.start + 1)}`;
  return insertAfter(text, last, array.end, json);
}

/** The text without a list's `index`th item, its comma and its line. */
export function removeJsoncItem(text: string, array: JsoncNode & { type: 'array' }, index: number): string {
  const item = array.items[index];
  const start = item.start;
  let end = item.end;
  // The only one, with nothing else in the list: the list is left empty.
  if (array.items.length === 1 && /^\[\s*$/.test(text.slice(array.start, start)) && /^\s*,?\s*\]$/.test(text.slice(end, array.end))) {
    return `${text.slice(0, array.start)}[]${text.slice(array.end)}`;
  }
  const after = followingComma(text, end, array.end - 1);
  if (after === end || (after > end && /^[ \t]*$/.test(text.slice(end, after)))) end = after + 1;
  else if (after >= 0) return text.slice(0, start) + text.slice(end, after) + text.slice(after + 1);
  else if (index > 0) {
    const before = followingComma(text, array.items[index - 1].end, start);
    if (before >= 0) {
      const gap = text.slice(before + 1, start);
      return text.slice(0, before) + (gap.trim() ? gap : '') + text.slice(end);
    }
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const alone = /^[ \t]*$/.test(text.slice(lineStart, start)) && newline >= 0 && /^[ \t\r]*$/.test(text.slice(end, newline));
  if (alone) return text.slice(0, lineStart) + text.slice(newline + 1);
  // One of several on a line: the space that parted it from the next goes too.
  if (after >= 0) end += /^[ \t]*/.exec(text.slice(end))![0].length;
  return text.slice(0, start) + text.slice(end);
}

/** The text with an object's property set to `json`, added last where it's new. */
export function setJsoncProp(text: string, object: JsoncNode & { type: 'object' }, key: string, json: string): string {
  const existing = jsoncProp(object, key);
  if (existing) return text.slice(0, existing.start) + json + text.slice(existing.end);
  const entry = `${JSON.stringify(key)}: ${json}`;
  const last = object.props.at(-1);
  if (!last) return `${text.slice(0, object.start + 1)}\n  ${entry}\n${text.slice(object.start + 1)}`;
  return insertAfter(text, { start: last.start, end: last.value.end }, object.end, entry);
}
