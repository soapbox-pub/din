import { CATALOG, catalogEntry, type CatalogEntry } from './catalog';

/** The function call the caret is inside, and which argument it's on. */
export function enclosingCall(text: string, caret: number): { entry: CatalogEntry; arg: number } | undefined {
  let depth = 0;
  let arg = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) return undefined;
      depth--;
    } else if (ch === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const match = /([A-Za-z_][A-Za-z0-9_]*(?:⁻¹)?|[∫Σ√Π])$/.exec(text.slice(0, i));
      if (!match) {
        // A plain parenthesis: keep looking outward.
        arg = 0;
        continue;
      }
      const entry = catalogEntry(match[1]);
      if (!entry?.args) return undefined;
      return { entry, arg };
    } else if (ch === ',' && depth === 0) {
      arg++;
    }
  }
  return undefined;
}

const NAMES = CATALOG.filter((e) => e.args && /^[A-Za-z]/.test(e.name));

/** Catalog functions the word before the caret could be the start of. */
export function completions(text: string, caret: number): { word: string; entries: CatalogEntry[] } | undefined {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(0, caret));
  if (!match || match[0].length < 2) return undefined;
  // Not inside a unit (_km) or right after a digit (2xy).
  const before = text[caret - match[0].length - 1];
  if (before === '_' || (before && /[0-9]/.test(before))) return undefined;
  if (/^[A-Za-z0-9_(]/.test(text[caret] ?? '')) return undefined;
  const word = match[0].toLowerCase();
  const entries = NAMES.filter((e) => e.name.toLowerCase().startsWith(word) && e.name.toLowerCase() !== word).slice(0, 6);
  return entries.length ? { word: match[0], entries } : undefined;
}
