/**
 * Typed access to the read-only OS filesystem bridge exposed by the Electron
 * preload (`window.webosFs`, see electron/preload.cjs + electron/main.cjs).
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getFsBridge()` and render a fallback.
 */

/** What a directory entry resolved to (symlinks are followed for `kind`). */
export type FsEntryKind = 'directory' | 'file' | 'other';

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

export interface WebosFsBridge {
  home(): Promise<string>;
  list(dirPath: string): Promise<FsListing>;
  readFile(filePath: string, maxBytes?: number): Promise<FsReadResult>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    webosFs?: WebosFsBridge;
  }
}

/** The fs bridge, or undefined when running outside the Electron shell. */
export function getFsBridge(): WebosFsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.webosFs;
}

/**
 * Strip Electron's IPC error prefix ("Error invoking remote method 'fs:list':
 * Error: ENOENT ...") so users see just the underlying message.
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
