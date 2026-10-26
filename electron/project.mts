// Project-wide operations behind the Text Editor's folder view: every file
// in a folder (for quick open) and searching all of them at once.
//
// Same threat model as the fs bridge (see main.mts): every request is
// re-validated against the shell's main frame, and authority is bounded by
// the unprivileged OS user Din runs as. Nothing here can do more than
// window.fs already can; it just does it in one round trip instead of
// thousands.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import fs from 'node:fs';
import { ipcMain } from 'electron';
import { runCommand } from './system.mts';

const fsp = fs.promises;

type IpcEvent = Electron.IpcMainInvokeEvent;

/** Files listed before giving up on a folder (someone opened `/`). */
const MAX_FILES = 100_000;
/** Files bigger than this aren't searched. */
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
/** Matches returned by one search. */
const MAX_MATCHES = 10_000;
/** Characters of a line shown around a match, and how many of them before it. */
const PREVIEW_CHARS = 200;
const PREVIEW_BEFORE = 16;
/** Files read at once while searching. */
const SEARCH_CONCURRENCY = 16;

/** Folders never worth listing when there's no .gitignore to say so. */
const SKIPPED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.cache',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'target', '.direnv',
]);

function absolute(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p) || p.includes('\0')) {
    throw new Error('An absolute path is required');
  }
  return path.normalize(p);
}

/** A git checkout's tracked and untracked-but-not-ignored files, or null outside one. */
async function gitFiles(root: string): Promise<string[] | null> {
  const run = (args: string[]) =>
    runCommand('git', ['-C', root, 'ls-files', '-z', ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const [listed, deleted] = await Promise.all([
      run(['--cached', '--others', '--exclude-standard']),
      run(['--deleted']),
    ]);
    const gone = new Set(deleted.stdout.split('\0'));
    const files = [...new Set(listed.stdout.split('\0'))].filter((f) => f && !gone.has(f));
    return files.slice(0, MAX_FILES);
  } catch {
    return null;
  }
}

/** Every file beneath `root`, breadth first, skipping build and dependency folders. */
async function walkFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let level = [''];
  while (level.length > 0 && files.length < MAX_FILES) {
    const next: string[] = [];
    for (const rel of level) {
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!SKIPPED_DIRS.has(d.name)) next.push(child);
        } else if (d.isFile() || d.isSymbolicLink()) {
          files.push(child);
        }
      }
      if (files.length >= MAX_FILES) break;
    }
    level = next;
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length >= MAX_FILES };
}

/** Paths relative to `root`, with `/` separators. */
async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const tracked = await gitFiles(root);
  if (tracked) return { files: tracked, truncated: tracked.length >= MAX_FILES };
  return walkFiles(root);
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Comma-separated globs a file's relative path must match (empty: any). */
  include: string;
  /** Comma-separated globs that rule a file out. */
  exclude: string;
}

export interface SearchMatch {
  /** 1-based line. */
  line: number;
  /** 0-based offset of the match in the line, in UTF-16 code units. */
  column: number;
  length: number;
  /** The line, cut down to about PREVIEW_CHARS around the match. */
  preview: string;
  /** Where the match starts in `preview`. */
  previewColumn: number;
}

export interface SearchResult {
  files: { path: string; matches: SearchMatch[] }[];
  /** True when MAX_MATCHES (or the file cap) cut the search short. */
  truncated: boolean;
  /** Files searched. */
  searched: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The search as a global RegExp; throws on an invalid pattern. */
function searchRegExp(options: Pick<SearchOptions, 'query' | 'regex' | 'caseSensitive' | 'wholeWord'>): RegExp {
  let source = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  return new RegExp(source, `gmu${options.caseSensitive ? '' : 'i'}`);
}

/** A glob (`*`, `**`, `?`, `{a,b}`) as a RegExp over a relative path. */
function globRegExp(glob: string): RegExp {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') source += '[^/]';
    else if (c === '{') {
      braces++;
      source += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (c === ',' && braces > 0) source += '|';
    else source += escapeRegExp(c);
  }
  // A bare name or folder ("src", "*.ts") matches at any depth, like VS Code's.
  const anchored = glob.includes('/') ? `^${source}` : `(?:^|/)${source}`;
  return new RegExp(`${anchored}(?:/.*)?$`);
}

function globList(list: string): RegExp[] {
  return list.split(',').map((g) => g.trim().replace(/^\.\//, '')).filter(Boolean).map(globRegExp);
}

/** Search one file's text. */
function searchText(text: string, pattern: RegExp, budget: number): SearchMatch[] {
  const matches: SearchMatch[] = [];
  pattern.lastIndex = 0;
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (let m = pattern.exec(text); m && matches.length < budget; m = pattern.exec(text)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = m.index;
    let lineEnd = text.indexOf('\n', m.index);
    if (lineEnd === -1) lineEnd = text.length;
    const column = m.index - lineStart;
    // A little of what comes before the match, so a narrow sidebar still shows it.
    const from = Math.max(lineStart, m.index - PREVIEW_BEFORE);
    const to = Math.min(lineEnd, from + PREVIEW_CHARS);
    const raw = text.slice(from, to).replace(/\r$/, '');
    const lead = Math.min(/^\s*/.exec(raw)![0].length, m.index - from);
    const trimmed = raw.slice(lead);
    const cut = from > lineStart ? '…' : '';
    matches.push({
      line,
      column,
      length: Math.min(m[0].length, lineEnd - m.index),
      preview: cut + trimmed,
      previewColumn: m.index - from - lead + cut.length,
    });
  }
  return matches;
}

async function search(root: string, options: SearchOptions, isCurrent: () => boolean): Promise<SearchResult> {
  const pattern = searchRegExp(options);
  const include = globList(options.include);
  const exclude = globList(options.exclude);
  const { files, truncated: tooManyFiles } = await listFiles(root);
  const candidates = files
    .filter((f) => (include.length === 0 || include.some((g) => g.test(f))) && !exclude.some((g) => g.test(f)))
    .sort();

  const found = new Map<string, SearchMatch[]>();
  let total = 0;
  let searched = 0;
  let next = 0;
  const worker = async () => {
    while (next < candidates.length && total < MAX_MATCHES && isCurrent()) {
      const rel = candidates[next++];
      let data: Buffer;
      try {
        const file = path.join(root, rel);
        const stats = await fsp.stat(file);
        if (!stats.isFile() || stats.size > MAX_SEARCH_BYTES) continue;
        data = await fsp.readFile(file);
      } catch {
        continue;
      }
      searched++;
      if (data.subarray(0, 8192).includes(0)) continue;
      const matches = searchText(data.toString('utf8'), pattern, MAX_MATCHES - total);
      if (matches.length === 0) continue;
      total += matches.length;
      found.set(rel, matches);
    }
  };
  await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));

  return {
    files: candidates.filter((f) => found.has(f)).map((f) => ({ path: f, matches: found.get(f)! })),
    truncated: tooManyFiles || total >= MAX_MATCHES,
    searched,
  };
}

function searchOptions(value: unknown): SearchOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.query !== 'string' || v.query.length === 0) throw new Error('Nothing to search for');
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    query: v.query,
    regex: v.regex === true,
    caseSensitive: v.caseSensitive === true,
    wholeWord: v.wholeWord === true,
    include: str(v.include),
    exclude: str(v.exclude),
  };
}

export function registerProjectHandlers({ assertShellSender }: {
  assertShellSender: (event: IpcEvent) => void;
}): void {
  ipcMain.handle('fs:listFiles', async (event, root) => {
    assertShellSender(event);
    return listFiles(absolute(root));
  });

  // A new search stops the one before it: typing searches as it goes.
  let generation = 0;
  ipcMain.handle('fs:search', async (event, root, options) => {
    assertShellSender(event);
    const mine = ++generation;
    return search(absolute(root), searchOptions(options), () => mine === generation);
  });
}
