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
