export interface FuzzyMatch {
  score: number;
  /** Indexes into the text of the characters that matched. */
  positions: number[];
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') return true;
  // camelCase: a capital after a lowercase letter.
  return text[i] !== text[i].toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
};

/**
 * Whether every character of `query` appears in `text` in order (ignoring
 * case and spaces), and how well: runs of consecutive characters, word
 * starts, and matches in the last path segment score higher, and so do
 * shorter texts.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const exact = query.replace(/\s+/g, '');
  const q = exact.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const lastSlash = text.lastIndexOf('/');

  // The query as one run beats any scattering of it: at a word start if it
  // appears at one, else its last appearance (nearest the file name).
  let run = -1;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + 1)) {
    run = i;
    if (isBoundary(text, i)) break;
  }

  const positions = run === -1 ? scattered(q, text, lower) : Array.from(q, (_, k) => run + k);
  if (!positions) return null;

  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k];
    score += 1;
    if (k > 0 && positions[k - 1] === p - 1) score += 5;
    if (isBoundary(text, p)) score += 8;
    if (p > lastSlash) score += 3;
    if (text[p] === exact[k]) score += 1;
  }
  if (run !== -1) score += 10;
  if (lower.slice(lastSlash + 1).startsWith(q)) score += 20;
  score -= text.length * 0.05;
  return { score, positions };
}

/** Where the query's characters fall when they aren't one run, or null if they don't all appear in order. */
function scattered(q: string, text: string, lower: string): number[] | null {
  // Greedy from the end finds the tightest match in the file name first.
  const positions: number[] = [];
  let qi = q.length - 1;
  for (let i = lower.length - 1; i >= 0 && qi >= 0; i--) {
    if (lower[i] === q[qi]) {
      positions.push(i);
      qi--;
    }
  }
  if (qi >= 0) return null;
  positions.reverse();

  // Then pull each character forward onto a word start where one follows the previous match.
  for (let k = 0; k < positions.length; k++) {
    const min = k === 0 ? 0 : positions[k - 1] + 1;
    const max = k + 1 < positions.length ? positions[k + 1] - 1 : lower.length - 1;
    if (isBoundary(text, positions[k])) continue;
    for (let i = min; i <= max; i++) {
      if (lower[i] === q[k] && isBoundary(text, i)) {
        positions[k] = i;
        break;
      }
    }
  }
  return positions;
}
