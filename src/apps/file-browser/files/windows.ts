import type { FsBridge } from '@/lib/fs';
import type { Rect } from '@/sdk';

/**
 * What Files windows share. Each window is its own document now, but they
 * share an origin, so they talk over a BroadcastChannel: like a native file
 * manager's, the undo history spans windows (Ctrl+Z works wherever focus
 * is), a change made in one refreshes the others' cached folders and
 * favorites, and tabs move between windows.
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

export interface WindowInfo {
  title: string;
  /** Where it is on the desktop (din.window.state.bounds). */
  bounds: Rect;
}

type Message =
  | { type: 'hello'; from: string; info: WindowInfo }
  | { type: 'here'; from: string; info: WindowInfo; undo: UndoEntry[] }
  | { type: 'bye'; from: string }
  | { type: 'invalidate'; paths: string[]; bookmarks: boolean }
  | { type: 'undo-push'; entry: UndoEntry }
  | { type: 'undo-remove'; id: string }
  | { type: 'tab'; to: string; path: string; x: number | null };

const UNDO_LIMIT = 50;

let channel: BroadcastChannel | null = null;
let self = '';
let selfInfo: WindowInfo | null = null;
const others = new Map<string, WindowInfo>();
let undoStack: UndoEntry[] = [];
const invalidateListeners = new Set<(paths: string[], bookmarks: boolean) => void>();
const othersListeners = new Set<() => void>();
let tabReceiver: ((path: string, x: number | null) => void) | null = null;

function post(message: Message): void {
  channel?.postMessage(message);
}

let othersSnapshot: [string, WindowInfo][] = [];

function emitOthers(): void {
  othersSnapshot = [...others];
  for (const l of othersListeners) l();
}

/** Join the other Files windows, as `windowId`. Once per document. */
export function joinWindows(windowId: string, info: WindowInfo): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  self = windowId;
  selfInfo = info;
  channel = new BroadcastChannel('din-files');
  channel.onmessage = (e: MessageEvent<Message>) => {
    const m = e.data;
    switch (m.type) {
      case 'hello':
        others.set(m.from, m.info);
        emitOthers();
        if (selfInfo) post({ type: 'here', from: self, info: selfInfo, undo: undoStack });
        break;
      case 'here': {
        // Windows move all the time; only joining and retitling change the list.
        const before = others.get(m.from);
        others.set(m.from, m.info);
        if (before?.title !== m.info.title) emitOthers();
        // A window just opened takes the history from whoever answers first.
        if (undoStack.length === 0 && m.undo.length > 0) undoStack = m.undo.slice(-UNDO_LIMIT);
        break;
      }
      case 'bye':
        others.delete(m.from);
        emitOthers();
        break;
      case 'invalidate':
        for (const l of invalidateListeners) l(m.paths, m.bookmarks);
        break;
      case 'undo-push':
        undoStack.push(m.entry);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        break;
      case 'undo-remove':
        undoStack = undoStack.filter((u) => u.id !== m.id);
        break;
      case 'tab':
        if (m.to === self) tabReceiver?.(m.path, m.x);
        break;
    }
  };
  post({ type: 'hello', from: self, info });
  window.addEventListener('pagehide', () => post({ type: 'bye', from: self }));
}

/** Tell the others this window's title or place changed. */
export function updateWindowInfo(info: WindowInfo): void {
  selfInfo = info;
  post({ type: 'here', from: self, info, undo: [] });
}

/** The other Files windows open now (the same array until that changes). */
export function otherWindows(): [string, WindowInfo][] {
  return othersSnapshot;
}

/** The other Files windows and where each is now, for finding the one under a point. */
export function otherWindowsNow(): [string, WindowInfo][] {
  return [...others];
}

export function onOtherWindowsChange(listener: () => void): () => void {
  othersListeners.add(listener);
  return () => othersListeners.delete(listener);
}

/** Folders changed (or the favorites did): other windows drop what they cached. */
export function broadcastInvalidate(paths: string[], bookmarks = false): void {
  post({ type: 'invalidate', paths, bookmarks });
}

export function onInvalidate(listener: (paths: string[], bookmarks: boolean) => void): () => void {
  invalidateListeners.add(listener);
  return () => invalidateListeners.delete(listener);
}

/**
 * Hand a tab (its folder) to another Files window: dropped at `x` on the
 * desktop (the receiver finds the slot), or at the end of its strip.
 */
export function sendTab(windowId: string, path: string, x: number | null = null): void {
  post({ type: 'tab', to: windowId, path, x });
}

export function receiveTabs(receiver: ((path: string, x: number | null) => void) | null): void {
  tabReceiver = receiver;
}

export function pushUndo(label: string, op: UndoOp): void {
  const entry = { id: crypto.randomUUID(), label, op };
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  post({ type: 'undo-push', entry });
}

export function popUndo(): UndoEntry | undefined {
  const entry = undoStack.pop();
  if (entry) post({ type: 'undo-remove', id: entry.id });
  return entry;
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
