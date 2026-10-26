/**
 * Typed access to the OS filesystem bridge exposed by the Electron preload
 * (`window.fs`, see electron/preload.cjs + electron/main.cjs).
 *
 * The API is Node-flavored but deliberately not Node's fs module: it is
 * promise-only, `readdir` returns rich entries in one batched IPC call, and
 * `readFile` is size-capped. Authority is bounded by the unprivileged OS
 * user the shell runs as (writes to system paths fail with EACCES).
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getFsBridge()` and render a fallback.
 */

/** What a path or directory entry resolved to (symlinks are followed). */
export type FsEntryKind = 'directory' | 'file' | 'other';

export interface FsStat {
  kind: FsEntryKind;
  size: number;
  /** Modification time (ms since epoch). */
  mtimeMs: number;
}

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
  /** True when the entry itself is a symbolic link. */
  symlink: boolean;
  /** Size in bytes, or null when stat failed (broken link, EACCES). */
  size: number | null;
  /** Modification time (ms since epoch), or null when stat failed. */
  mtimeMs: number | null;
}

export interface FsListing {
  /** Normalized absolute path that was listed. */
  path: string;
  entries: FsEntry[];
  /** True when the directory had more entries than the bridge returns. */
  truncated: boolean;
}

/** A file in the picker's Recent list. */
export interface FsRecentFile extends FsEntry {
  path: string;
  /** When it was last made, changed, moved in, or opened (ms since epoch). */
  usedMs: number;
}

export interface FsReadResult {
  data: Uint8Array;
  /** Full size of the file on disk (may exceed data.length). */
  size: number;
  /** True when `data` is a truncated prefix of the file. */
  truncated: boolean;
}

export interface FsBridge {
  /** Absolute path of the shell user's home directory. */
  homedir(): Promise<string>;
  /** Metadata for a single path (follows symlinks). */
  stat(path: string): Promise<FsStat>;
  /** List a directory with resolved kind/size/mtime per entry. */
  readdir(path: string): Promise<FsListing>;
  /** Read up to `maxBytes` of a regular file. */
  readFile(path: string, maxBytes?: number): Promise<FsReadResult>;
  /** Write a file, replacing any existing contents. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Create a directory (recursive, like `mkdir -p`). */
  mkdir(path: string): Promise<void>;
  /** Rename/move a file or directory. */
  rename(from: string, to: string): Promise<void>;
  /** Copy a single regular file. */
  copyFile(from: string, to: string): Promise<void>;
  /**
   * Remove a file or (empty) directory. Deleting a non-empty directory
   * requires an explicit `recursive: true`.
   */
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;

  // The Files app's richer operations (electron/files.mts).

  /**
   * Copy a file or folder into `dir` (as `name`, default its own name),
   * renaming to "name (2)" when taken. Resolves to the new path.
   */
  copyInto(from: string, dir: string, name?: string): Promise<string>;
  /** Move into `dir`, renaming to "name (2)" when taken. Resolves to the new path. */
  moveInto(from: string, dir: string): Promise<string>;
  /** Move to an exact path; fails if something is already there. */
  move(from: string, to: string): Promise<void>;
  /** Move to the Trash; resolves to the item's name in the Trash. */
  trash(path: string): Promise<string>;
  /** Put a trashed item (by its name in the Trash) back; resolves to where it went. */
  restore(name: string): Promise<string>;
  /** Delete one trashed item for good, or with no name, empty the Trash. */
  purge(name?: string): Promise<void>;
  /** The Trash's files folder (created when missing). */
  trashDir(): Promise<string>;
  /** Everything the Properties dialog shows about a path. */
  details(path: string): Promise<FsDetails>;
  /** Total size and item counts beneath a folder. */
  du(path: string): Promise<FsDiskUsage>;
  chmod(path: string, mode: number): Promise<void>;
  /**
   * Extract an archive into `dir`; resolves to what was created and the
   * archive's entries that came out damaged or not at all (the rest still do).
   */
  extract(archive: string, dir: string): Promise<{ path: string; damaged: string[] }>;
  /** Pack entries of `dir` into `dir/outName` (format by its extension). */
  compress(dir: string, names: string[], outName: string): Promise<string>;
  /** An archive's member names (capped; `total` counts them all). */
  listArchive(archive: string): Promise<{ entries: string[]; total: number }>;
  /**
   * The files most recently made, changed, or opened in the user's folders
   * (and GTK's recently used list), latest first. `extra` adds `[path, ms]`
   * pairs of the shell's own.
   */
  recent(extra: [string, number][]): Promise<FsRecentFile[]>;
  // The Text Editor's project operations (electron/project.mts).

  /**
   * Every file beneath `root`, relative to it with `/` separators: a git
   * checkout's tracked and unignored files, else a walk that skips
   * dependency and build folders.
   */
  listFiles(root: string): Promise<{ files: string[]; truncated: boolean }>;
  /** Search every file beneath `root`. Starting a new search stops the last one. */
  search(root: string, options: FsSearchOptions): Promise<FsSearchResult>;

  /** Watch a folder for changes; resolves to a watch id, or null if it can't be watched. */
  watch(path: string): Promise<number | null>;
  unwatch(id: number): Promise<void>;
  /** Subscribe to changes in watched folders. Returns an unsubscribe fn. */
  onChange(callback: (path: string) => void): () => void;
}

export interface FsSearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Comma-separated globs a file's relative path must match (empty: any). */
  include: string;
  /** Comma-separated globs that rule a file out. */
  exclude: string;
}

export interface FsSearchMatch {
  /** 1-based line. */
  line: number;
  /** 0-based offset of the match within its line. */
  column: number;
  length: number;
  /** The line, cut down to the part around the match. */
  preview: string;
  /** Where the match starts in `preview`. */
  previewColumn: number;
}

export interface FsSearchResult {
  /** Files with matches, by path relative to the root, sorted. */
  files: { path: string; matches: FsSearchMatch[] }[];
  /** True when the match or file cap cut the search short. */
  truncated: boolean;
  /** How many files were searched. */
  searched: number;
}

export interface FsDetails {
  path: string;
  kind: FsEntryKind;
  symlink: boolean;
  linkTarget: string | null;
  size: number;
  /** Permission bits (mode & 0o7777). */
  mode: number;
  uid: number;
  gid: number;
  owner: string;
  group: string;
  /** Whether Din's user owns it (and so can change its permissions). */
  isOwner: boolean;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number | null;
  /** Free and total space on its filesystem, when reported. */
  free: number | null;
  total: number | null;
  /** For an item in the Trash: where it came from and when it was trashed. */
  trashOrigin: { path: string; deletedAt: string | null } | null;
}

export interface FsDiskUsage {
  files: number;
  dirs: number;
  bytes: number;
  /** True when the folder was too big to count completely. */
  truncated: boolean;
}

/**
 * A URL the shell can load a local file from (img, video, fetch), served by
 * electron/files.mts with Range support.
 */
export function localFileUrl(path: string): string {
  return `din-file://localhost${path.split('/').map(encodeURIComponent).join('/')}`;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    fs?: FsBridge;
  }
}

/** The fs bridge, or undefined when running outside the Electron shell. */
export function getFsBridge(): FsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.fs;
}

/**
 * Strip Electron's IPC error prefix ("Error invoking remote method
 * 'fs:readdir': Error: ENOENT ...") so users see just the underlying message.
 */
export function cleanFsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** The warning for an extraction with damaged entries (by archive path). */
export function damagedExtractionMessage(damaged: string[]): string {
  const names = damaged.map((p) => p.slice(p.lastIndexOf('/') + 1));
  const listed = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return names.length === 1
    ? `Extracted, but 1 file is damaged and may be incomplete: ${listed}`
    : `Extracted, but ${names.length} files are damaged and may be incomplete: ${listed}`;
}

// ---------------------------------------------------------------------------
// POSIX path helpers (the shell only ever runs on Linux).
// ---------------------------------------------------------------------------

/** Parent directory of an absolute path ('/' is its own parent). */
export function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Join a directory and a child entry name. */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Whether a string is usable as a single new file/directory name (no path
 * separators or traversal).
 */
export function isValidEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  );
}

/**
 * Shared collator for filename ordering.
 *
 * IMPORTANT: this must be a single cached instance. Calling
 * `a.localeCompare(b, undefined, { numeric: true })` inside a sort comparator
 * makes V8 construct a fresh Intl.Collator on *every comparison* (the no-args
 * form has a cached fast path; the options form does not). Sorting a
 * 3000-entry directory that way blocks the main thread for ~400ms; with this
 * shared instance it is ~15ms.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * Sort directory entries for display: directories first, then natural
 * (numeric-aware) name order. Returns a new array.
 */
export function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return NAME_COLLATOR.compare(a.name, b.name);
  });
}

export type EntrySortKey = 'name' | 'size' | 'type' | 'modified';

/**
 * Order entries by a column, folders always first. Ties fall back to name
 * order, and `type` compares by extension.
 */
export function compareEntriesBy(
  key: EntrySortKey,
  descending: boolean,
): (a: FsEntry, b: FsEntry) => number {
  const ext = (name: string) => {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
  };
  const sign = descending ? -1 : 1;
  return (a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) {
      return a.kind === 'directory' ? -1 : 1;
    }
    let order = 0;
    if (key === 'size') order = (a.size ?? -1) - (b.size ?? -1);
    else if (key === 'modified') order = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
    else if (key === 'type') order = NAME_COLLATOR.compare(ext(a.name), ext(b.name));
    if (order === 0) order = NAME_COLLATOR.compare(a.name, b.name);
    return order * sign;
  };
}

/** Sort by a column (see {@link compareEntriesBy}). Returns a new array. */
export function sortEntriesBy(
  entries: readonly FsEntry[],
  key: EntrySortKey,
  descending: boolean,
): FsEntry[] {
  return [...entries].sort(compareEntriesBy(key, descending));
}

/** Human-readable byte size (e.g. "4.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
