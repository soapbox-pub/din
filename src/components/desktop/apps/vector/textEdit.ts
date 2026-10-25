import type { TextItem, TextRun } from './model';
import { textOf } from './text';

/**
 * Editing type: replacing a range of characters across style runs, and
 * styling a range, the way the Type tool and Character panel change text.
 * Any edit drops the glyph placement the file came with.
 */

function merge(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) out[out.length - 1] = { ...last, text: last.text + r.text };
    else if (r.text || !out.length) out.push(r);
  }
  return out.length ? out : runs.slice(0, 1).map((r) => ({ ...r, text: '' }));
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    a.font.family === b.font.family &&
    a.font.style === b.font.style &&
    a.font.postscript === b.font.postscript &&
    a.font.embedded === b.font.embedded &&
    a.size === b.size &&
    a.tracking === b.tracking &&
    a.hscale === b.hscale &&
    a.rise === b.rise &&
    JSON.stringify(a.fill) === JSON.stringify(b.fill) &&
    JSON.stringify(a.stroke) === JSON.stringify(b.stroke)
  );
}

/** The run a character at `index` belongs to (for typing: the one before it). */
export function runAt(t: TextItem, index: number): TextRun {
  let at = 0;
  for (const r of t.runs) {
    if (index <= at + r.text.length && (index > at || at === 0)) return r;
    at += r.text.length;
  }
  return t.runs[t.runs.length - 1];
}

/** Replace [start, end) with `text`, typed in the style at `start`. */
export function replaceRange(t: TextItem, start: number, end: number, text: string): TextItem {
  const style = runAt(t, start);
  // Each character's run, as UTF-16 units, then the new text's.
  const owner: TextRun[] = [];
  for (const r of t.runs) for (let i = 0; i < r.text.length; i++) owner.push(r);
  const full = textOf(t);
  const chars = [...owner.slice(0, start).map((r, i) => [r, full[i]] as const), ...[...text].flatMap((c) => [...c].map((u) => [style, u] as const)), ...owner.slice(end).map((r, i) => [r, full[end + i]] as const)];
  const groups: { src: TextRun; run: TextRun }[] = [];
  for (const [r, c] of chars) {
    const last = groups[groups.length - 1];
    if (last && last.src === r) last.run.text += c;
    else groups.push({ src: r, run: { ...r, text: c } });
  }
  const runs = groups.map((x) => x.run);
  return { ...t, runs: merge(runs.length ? runs : [{ ...style, text: '' }]), placed: undefined };
}

/** Restyle [start, end) (all of it when start === end === -1). */
export function styleRange(t: TextItem, start: number, end: number, patch: (r: TextRun) => TextRun): TextItem {
  const total = textOf(t).length;
  if (start < 0 || (start === end && start === 0 && end === 0) || (start === 0 && end >= total)) {
    return { ...t, runs: merge(t.runs.map(patch)), placed: undefined };
  }
  if (start === end) return t;
  const out: TextRun[] = [];
  let at = 0;
  for (const r of t.runs) {
    const a = at;
    const b = at + r.text.length;
    at = b;
    if (end <= a || start >= b) {
      out.push(r);
      continue;
    }
    const s = Math.max(0, start - a);
    const e = Math.min(r.text.length, end - a);
    if (s > 0) out.push({ ...r, text: r.text.slice(0, s) });
    out.push(patch({ ...r, text: r.text.slice(s, e) }));
    if (e < r.text.length) out.push({ ...r, text: r.text.slice(e) });
  }
  return { ...t, runs: merge(out), placed: undefined };
}

/** Word boundaries around an index (double-click selects a word). */
export function wordAt(text: string, i: number): [number, number] {
  const isWord = (c: string) => /[\p{L}\p{N}_'’]/u.test(c);
  let a = i;
  let b = i;
  if (!isWord(text[i] ?? '') && i > 0 && isWord(text[i - 1])) a = b = i - 1;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return b > a ? [a, b] : [i, Math.min(text.length, i + 1)];
}
