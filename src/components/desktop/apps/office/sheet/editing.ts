import { tokenize, type RefTok } from './formula';
import { FUNCTION_NAMES, FUNCTIONS } from './functions';
import { REF_COLORS } from './render';

/** Helpers for the text being typed into a cell: reference colors, autocomplete, the function tooltip. */

export interface Span {
  text: string;
  color?: string;
}

/** A reference's identity for coloring: the same cells get the same color. */
function refId(ref: RefTok): string {
  return `${(ref.sheet ?? '').toLowerCase()}!${ref.kind}:${ref.r0},${ref.c0},${ref.r1},${ref.c1}`;
}

export interface ColoredRef {
  ref: RefTok;
  color: string;
  start: number;
  end: number;
}

/** The references in an entry ("=A1+B2"), each with its color in order of first appearance. */
export function coloredRefs(text: string): ColoredRef[] {
  if (!text.startsWith('=')) return [];
  const ids = new Map<string, number>();
  const out: ColoredRef[] = [];
  for (const t of tokenize(text.slice(1))) {
    if (t.type !== 'ref' || !t.ref) continue;
    const id = refId(t.ref);
    let n = ids.get(id);
    if (n === undefined) ids.set(id, (n = ids.size));
    out.push({ ref: t.ref, color: REF_COLORS[n % REF_COLORS.length], start: t.start + 1, end: t.end + 1 });
  }
  return out;
}

export function spans(text: string): Span[] {
  const refs = coloredRefs(text);
  if (!refs.length) return [{ text }];
  const out: Span[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push({ text: text.slice(at, r.start) });
    out.push({ text: text.slice(r.start, r.end), color: r.color });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The partial function name being typed at the caret, if any. */
export function partialName(text: string, caret: number): { start: number; word: string } | null {
  if (!text.startsWith('=')) return null;
  const before = text.slice(0, caret);
  const m = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[1].length;
  const prev = before.slice(0, start).replace(/\s+$/, '');
  if (!/[=(,+\-*/^&<>:;{ ]$/.test(prev) && prev !== '=') return null;
  // Inside a string?
  const quotes = (before.slice(0, start).match(/"/g) ?? []).length;
  if (quotes % 2) return null;
  if (/^[A-Za-z]{1,3}\d+$/.test(m[1])) return null;
  return { start, word: m[1] };
}

export function suggest(text: string, caret: number, names: string[] = []): { start: number; word: string; items: string[] } | null {
  const p = partialName(text, caret);
  if (!p) return null;
  const u = p.word.toUpperCase();
  const items = [...FUNCTION_NAMES.filter((n) => n.startsWith(u)), ...names.filter((n) => n.toUpperCase().startsWith(u))].slice(0, 12);
  if (!items.length || (items.length === 1 && items[0] === u)) return null;
  return { ...p, items };
}

/** The function call the caret is inside, and which argument it's on. */
export function callAt(text: string, caret: number): { name: string; arg: number } | null {
  if (!text.startsWith('=')) return null;
  const toks = tokenize(text.slice(1, caret));
  const stack: { name: string | null; arg: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'func') {
      stack.push({ name: t.text.toUpperCase(), arg: 0 });
      if (toks[i + 1]?.type === 'lparen') i++;
    } else if (t.type === 'lparen' || t.type === 'lbrace') stack.push({ name: null, arg: 0 });
    else if (t.type === 'rparen' || t.type === 'rbrace') stack.pop();
    else if (t.type === 'comma' && stack.length) stack[stack.length - 1].arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name && FUNCTIONS[stack[i].name!]) return { name: stack[i].name!, arg: stack[i].arg };
  return null;
}

/** A signature split into its arguments, for bolding the current one. */
export function sigParts(name: string): { head: string; args: string[] } | null {
  const fn = FUNCTIONS[name];
  if (!fn) return null;
  const open = fn.sig.indexOf('(');
  const inner = fn.sig.slice(open + 1, -1);
  return { head: fn.sig.slice(0, open), args: inner ? inner.split(', ') : [] };
}

/** Close what's left open in a formula, as Excel does on Enter: quotes, then parentheses. */
export function autoClose(text: string): string {
  let out = text;
  const quotes = (out.match(/"/g) ?? []).length;
  if (quotes % 2) out += '"';
  let depth = 0;
  let inStr = false;
  for (const ch of out) {
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') depth++;
    else if (!inStr && ch === ')') depth--;
  }
  if (depth > 0) out += ')'.repeat(depth);
  return out;
}

/** Function names and references in capitals, as Excel shows them after Enter. */
export function normalizeFormula(src: string): string {
  let out = '';
  for (const t of tokenize(src)) {
    if (t.type === 'func' || t.type === 'bool' || t.type === 'err') out += t.text.toUpperCase();
    else if (t.type === 'ref') {
      const bang = t.text.lastIndexOf('!');
      out += bang >= 0 ? t.text.slice(0, bang + 1) + t.text.slice(bang + 1).toUpperCase() : t.text.toUpperCase();
    } else out += t.text;
  }
  return out;
}
