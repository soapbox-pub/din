import type { FsBridge } from '@/lib/fs';
import type { Din } from '@/sdk';

/**
 * What Files windows share. Like a native file manager's, the undo history
 * spans windows (Ctrl+Z works wherever focus is) and lasts as long as the
 * desktop runs, so it lives in `din.app.session`. The windows share an
 * origin, so a BroadcastChannel carries the rest: a change made in one
 * refreshes the others' cached folders and favorites, and a drag of files
 * from one tells the others what it carries before the drop.
 */

/** An undoable file operation, as data, so any window can undo it. */
export type UndoOp =
  /** Things went to the Trash: restore them (by their path in the Trash). */
  | { kind: 'restore'; trashed: string[] }
  /** Things were made (copies, duplicates, archives): trash them. */
  | { kind: 'trash'; paths: string[] }
  /** Things were moved or renamed: move them back. */
  | { kind: 'move'; moves: { from: string; to: string }[] }
  /** An empty file or folder was made: remove it. */
  | { kind: 'remove'; path: string };

export interface UndoEntry {
  id: string;
  /** What undoing does, for the status bar: "Undoing move of 3 items". */
  label: string;
  op: UndoOp;
}

/** Files being dragged out of a Files window. */
export interface WindowDrag {
  paths: string[];
  folders: string[];
}

type Message =
  | { type: 'invalidate'; paths: string[]; bookmarks: boolean }
  | { type: 'drag'; drag: WindowDrag | null };

const UNDO_KEY = 'undo';
const UNDO_LIMIT = 50;

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('din-files');
const invalidateListeners = new Set<(paths: string[], bookmarks: boolean) => void>();
let otherDrag: WindowDrag | null = null;

if (channel) {
  channel.onmessage = (e: MessageEvent<Message>) => {
    const m = e.data;
    switch (m.type) {
      case 'invalidate':
        for (const l of invalidateListeners) l(m.paths, m.bookmarks);
        break;
      case 'drag':
        otherDrag = m.drag;
        break;
    }
  };
}

/** Folders changed (or the favorites did): other windows drop what they cached. */
export function broadcastInvalidate(paths: string[], bookmarks = false): void {
  channel?.postMessage({ type: 'invalidate', paths, bookmarks } satisfies Message);
}

export function onInvalidate(listener: (paths: string[], bookmarks: boolean) => void): () => void {
  invalidateListeners.add(listener);
  return () => invalidateListeners.delete(listener);
}

/** A drag of files from this window started (or, with null, ended). */
export function broadcastDrag(drag: WindowDrag | null): void {
  channel?.postMessage({ type: 'drag', drag } satisfies Message);
}

/** What another Files window is dragging, if it's dragging files. */
export function otherWindowDrag(): WindowDrag | null {
  return otherDrag;
}

function isUndoStack(value: unknown): value is UndoEntry[] {
  return Array.isArray(value);
}

// This window's reads and writes of the history, one after another.
let undoQueue: Promise<unknown> = Promise.resolve();

function editUndo<T>(din: Din, edit: (stack: UndoEntry[]) => T): Promise<T> {
  const next = undoQueue.then(async () => {
    const stored = await din.app.session.get(UNDO_KEY);
    const stack = isUndoStack(stored) ? stored : [];
    const result = edit(stack);
    din.app.session.set(UNDO_KEY, stack.slice(-UNDO_LIMIT));
    return result;
  });
  undoQueue = next.catch(() => {});
  return next;
}

export function pushUndo(din: Din, label: string, op: UndoOp): void {
  void editUndo(din, (stack) => stack.push({ id: crypto.randomUUID(), label, op }));
}

export function popUndo(din: Din): Promise<UndoEntry | undefined> {
  return editUndo(din, (stack) => stack.pop());
}

/** Undo an operation; resolves with the paths it touched, to refresh. */
export async function runUndo(fs: FsBridge, op: UndoOp): Promise<string[]> {
  switch (op.kind) {
    case 'restore': {
      const restored: string[] = [];
      for (const t of op.trashed) restored.push(await fs.restore(t));
      return restored;
    }
    case 'trash':
      for (const p of op.paths) await fs.trash(p);
      return op.paths;
    case 'move':
      for (const m of [...op.moves].reverse()) await fs.move(m.to, m.from);
      return op.moves.flatMap((m) => [m.from, m.to]);
    case 'remove':
      await fs.rm(op.path);
      return [op.path];
  }
}
