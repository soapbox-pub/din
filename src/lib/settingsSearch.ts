/**
 * Text matching for Settings search. Matching ignores case, accents, spaces
 * and punctuation, so "wifi" finds "Wi-Fi" and "datetime" finds
 * "Date & Time", and the ranges it returns point back into the original text
 * so the whole of "Wi-Fi", hyphen included, is highlighted.
 */

interface Normalized {
  /** Lowercased letters and digits only, accents removed. */
  text: string;
  /** For each character of `text`, where it came from in the original. */
  spans: { start: number; end: number }[];
}

const KEEP = /[\p{L}\p{N}]/u;
const MARKS = /\p{M}/gu;

export function normalize(text: string): Normalized {
  let out = '';
  const spans: Normalized['spans'] = [];
  let i = 0;
  for (const ch of text) {
    const start = i;
    i += ch.length;
    // A combining accent belongs to the letter before it.
    if (/^\p{M}$/u.test(ch)) {
      if (spans.length > 0 && spans[spans.length - 1].end === start) spans[spans.length - 1].end = i;
      continue;
    }
    for (const c of ch.normalize('NFD').replace(MARKS, '').toLowerCase()) {
      if (!KEEP.test(c)) continue;
      out += c;
      spans.push({ start, end: i });
    }
  }
  return { text: out, spans };
}

/** The query's words, normalized; empty when there's nothing to search for. */
export function parseQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((word) => normalize(word).text)
    .filter(Boolean);
}

/** Whether every term occurs in at least one of the texts. */
export function matchesAll(texts: string[], terms: string[]): boolean {
  const normalized = texts.map((t) => normalize(t).text);
  return terms.every((term) => normalized.some((t) => t.includes(term)));
}

/**
 * Where any of the terms occur in `text`, as sorted, non-overlapping
 * [start, end) ranges of the original string.
 */
export function findMatches(text: string, terms: string[]): [number, number][] {
  const { text: norm, spans } = normalize(text);
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let at = norm.indexOf(term); at !== -1; at = norm.indexOf(term, at + 1)) {
      found.push([spans[at].start, spans[at + term.length - 1].end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
