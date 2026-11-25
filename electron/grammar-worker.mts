// The grammar checker (grammar.mts), in a worker thread: Harper
// (https://writewithharper.com), Automattic's grammar checker, compiled to
// WebAssembly. It runs entirely on this computer. Loading it takes over half
// a second and checking a page of text tens of milliseconds, either of which
// on the main thread would stall input routing for the whole desktop.
//
// Messages are { id, type, ... } in and { id, result } or { id, error } out.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { parentPort } from 'node:worker_threads';
import { createBinaryModuleFromUrl, Dialect, LocalLinter, type Lint, type LintConfig } from 'harper.js';

export type GrammarDialect = 'american' | 'british' | 'australian' | 'canadian' | 'indian';

export interface GrammarSuggestion {
  /** What the menu shows. */
  label: string;
  /** What the problem text is replaced with. */
  replacement: string;
}

export interface GrammarIssue {
  /** UTF-16 offsets into the text checked, as JavaScript strings count. */
  start: number;
  end: number;
  /** The text at [start, end), to check it's still there before changing it. */
  text: string;
  message: string;
  /** Harper's category: Grammar, Agreement, Style, … */
  kind: string;
  /** The rule that found it, to turn it off. */
  rule: string;
  suggestions: GrammarSuggestion[];
  /** Harper's hash of the issue in its context, to ignore it. */
  hash: string;
}

export interface WorkerOptions {
  dialect: GrammarDialect;
  style: boolean;
  disabledRules: string[];
  ignored: string | null;
}

export type WorkerRequest =
  | { id: number; type: 'configure'; options: WorkerOptions }
  | { id: number; type: 'lint'; text: string }
  | { id: number; type: 'ignore'; hash: string }
  | { id: number; type: 'clearIgnored' }
  | { id: number; type: 'exportIgnored' }
  | { id: number; type: 'rules' };

/** Spelling is Chromium's, which already underlines it in red. */
const SKIPPED_KINDS = new Set(['Spelling']);
/** What "style suggestions" turns on: how it reads, not whether it's right. */
const STYLE_KINDS = new Set(['Style', 'Readability', 'Enhancement', 'Redundancy']);
/** Suggestions offered for one issue, at most. */
const MAX_SUGGESTIONS = 5;

const DIALECTS: Record<GrammarDialect, Dialect> = {
  american: Dialect.American,
  british: Dialect.British,
  australian: Dialect.Australian,
  canadian: Dialect.Canadian,
  indian: Dialect.Indian,
};

// The slim build: the same checker, without what only Harper's own editor
// integrations use, read from its file (DinOS ships only that one: see
// os/packages.nix) rather than the package's inlined 20 MB of base64.
const WASM = new URL('harper_wasm_slim_bg.wasm', import.meta.resolve('harper.js')).href;
const binary = createBinaryModuleFromUrl(WASM, 'slim');
const linter = new LocalLinter({ binary, dialect: Dialect.American });
const ready = linter.setup();

let style = true;

/** A suggestion as the menu offers it: Harper's are replace, remove, or insert after. */
function suggestionOf(lint: Lint, kind: number, text: string): GrammarSuggestion | null {
  const problem = lint.get_problem_text();
  // SuggestionKind: 0 Replace, 1 Remove, 2 InsertAfter.
  if (kind === 0) return { label: text || `Remove “${problem}”`, replacement: text };
  if (kind === 1) return { label: `Remove “${problem}”`, replacement: '' };
  if (kind === 2) return { label: `${problem}${text}`, replacement: `${problem}${text}` };
  return null;
}

/**
 * Where a text is checked in pieces: after a paragraph's last word, before
 * the blank line that ends it, so each piece starts with the break before
 * its paragraph. Harper's hash of an issue (what Ignore remembers) takes in
 * the words around it, the break included, so an issue hashes the same
 * checked in its piece as in the whole text.
 */
const PARAGRAPH_END = /\S(?=[^\S\n]*\n[^\S\n]*\n)/g;
/** After a sentence's end, for a paragraph too long to check in one piece. */
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s)/g;
/** A paragraph longer than this is checked a few sentences at a time. */
const MAX_PIECE = 2_000;
/** Pieces whose issues are kept, so a check after typing redoes only the paragraph typed in. */
const MAX_CACHED = 2_000;

/**
 * Harper checks a text in time proportional to its length, but its hash of
 * each issue reads the whole text again, so checking a long text all at once
 * took time in the square of its length (11 seconds for 60,000 characters),
 * the worker answering nothing else meanwhile. Pieces keep each hash to its
 * paragraph, and a piece seen before isn't checked again.
 */
function pieces(text: string): string[] {
  const cuts: number[] = [0];
  for (const match of text.matchAll(PARAGRAPH_END)) cuts.push(match.index + 1);
  cuts.push(text.length);
  const out: string[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const piece = text.slice(cuts[i], cuts[i + 1]);
    if (!piece) continue;
    if (piece.length <= MAX_PIECE) {
      out.push(piece);
      continue;
    }
    // A wall of text: cut between sentences, as few times as keeps each piece short.
    let from = 0;
    let last = 0;
    for (const match of piece.matchAll(SENTENCE_END)) {
      const at = match.index + match[0].length;
      if (at - from > MAX_PIECE && last > from) {
        out.push(piece.slice(from, last));
        from = last;
      }
      last = at;
    }
    if (piece.length - from > MAX_PIECE && last > from) {
      out.push(piece.slice(from, last));
      from = last;
    }
    out.push(piece.slice(from));
  }
  return out;
}

/** Issues found in a piece, at offsets into it, by the piece's text. Most recently used last. */
const cache = new Map<string, GrammarIssue[]>();

async function lintPiece(text: string): Promise<GrammarIssue[]> {
  const known = cache.get(text);
  if (known) {
    cache.delete(text);
    cache.set(text, known);
    return known;
  }
  const groups = await linter.organizedLints(text, { language: 'plaintext' });
  const issues: GrammarIssue[] = [];
  for (const [rule, lints] of Object.entries(groups)) {
    for (const found of lints) {
      const kind = found.lint_kind();
      if (SKIPPED_KINDS.has(kind)) continue;
      const span = found.span();
      // "window.din" and "file.txt" aren't two sentences: a sentence starts
      // after a space (or a quote or bracket), never straight after a dot.
      if (rule === 'SentenceCapitalization' && span.start > 0 && /[\p{L}\p{N}._/\\~-]/u.test(text[span.start - 1])) continue;
      const suggestions: GrammarSuggestion[] = [];
      for (const s of found.suggestions()) {
        const suggestion = suggestionOf(found, s.kind(), s.get_replacement_text());
        // Harper sometimes offers the same word twice, once with a space after.
        if (suggestion && !suggestions.some((other) => other.replacement.trim() === suggestion.replacement.trim())) {
          suggestions.push(suggestion);
        }
        if (suggestions.length >= MAX_SUGGESTIONS) break;
      }
      issues.push({
        start: span.start,
        end: span.end,
        text: text.slice(span.start, span.end),
        message: found.message(),
        kind,
        rule,
        suggestions,
        hash: String(await linter.contextHash(text, found)),
      });
      found.free();
    }
  }
  cache.set(text, issues);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return issues;
}

async function lint(text: string): Promise<GrammarIssue[]> {
  await ready;
  const issues: GrammarIssue[] = [];
  let at = 0;
  for (const piece of pieces(text)) {
    for (const issue of await lintPiece(piece)) {
      if (!style && STYLE_KINDS.has(issue.kind)) continue;
      issues.push(at ? { ...issue, start: issue.start + at, end: issue.end + at } : issue);
    }
    at += piece.length;
  }
  return issues.sort((a, b) => a.start - b.start);
}

async function configure(options: WorkerOptions): Promise<void> {
  await ready;
  cache.clear();
  style = options.style;
  await linter.setDialect(DIALECTS[options.dialect] ?? Dialect.American);
  const config: LintConfig = await linter.getDefaultLintConfig();
  for (const rule of options.disabledRules) if (rule in config) config[rule] = false;
  await linter.setLintConfig(config);
  await linter.clearIgnoredLints();
  if (options.ignored) await linter.importIgnoredLints(options.ignored);
}

/** Every rule, with what it looks for. */
async function rules(): Promise<{ name: string; description: string }[]> {
  await ready;
  const descriptions = await linter.getLintDescriptions();
  return Object.entries(descriptions).map(([name, description]) => ({ name, description }));
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'configure':
      return configure(request.options);
    case 'lint':
      return lint(request.text);
    case 'ignore':
      await ready;
      cache.clear();
      await linter.ignoreLintHash(BigInt(request.hash));
      return linter.exportIgnoredLints();
    case 'clearIgnored':
      await ready;
      cache.clear();
      await linter.clearIgnoredLints();
      return null;
    case 'exportIgnored':
      await ready;
      return linter.exportIgnoredLints();
    case 'rules':
      return rules();
  }
}

// One at a time, in order: a lint sees the configuration sent before it.
let queue: Promise<unknown> = Promise.resolve();
parentPort?.on('message', (request: WorkerRequest) => {
  queue = queue.then(() =>
    handle(request).then(
      (result) => parentPort?.postMessage({ id: request.id, result }),
      (error: unknown) => parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
    ),
  );
});
