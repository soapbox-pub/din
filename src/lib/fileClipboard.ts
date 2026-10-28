import { useSyncExternalStore } from 'react';

/**
 * State shared by every Files window: what was cut or copied, and what can
 * be undone. Like a native file manager's, both span windows, so a file cut
 * in one window pastes in another and Ctrl+Z works wherever focus is.
 */

export interface FileClipboard {
  op: 'copy' | 'cut';
  paths: string[];
}

let clipboard: FileClipboard | null = null;
const listeners = new Set<() => void>();

/** Hear when what's cut or copied changes. */
export function subscribeFileClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFileClipboard(next: FileClipboard | null): void {
  clipboard = next;
  for (const l of listeners) l();
  // Paths go to the system clipboard too, for pasting into a terminal.
  if (next) void navigator.clipboard?.writeText(next.paths.join('\n')).catch(() => {});
}

export function getFileClipboard(): FileClipboard | null {
  return clipboard;
}

export function useFileClipboard(): FileClipboard | null {
  return useSyncExternalStore(subscribeFileClipboard, () => clipboard);
}

/** One undoable file operation. */
export interface UndoEntry {
  /** What undoing does, for the status bar: "Undo move of 3 items". */
  label: string;
  undo: () => Promise<void>;
}

const UNDO_LIMIT = 50;
const undoStack: UndoEntry[] = [];

export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function popUndo(): UndoEntry | undefined {
  return undoStack.pop();
}
