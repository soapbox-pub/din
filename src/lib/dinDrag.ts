/**
 * The desktop's broker for drags between apps (docs/din/drag-and-drop.md).
 * What crosses the screen is a token under DRAG_MIME; this keeps what each
 * token stands for, so a drop grants its target exactly the dragged files.
 * Drags of files the desktop itself starts (Files, Screenshot, files/dnd.ts)
 * register here too, so apps can take them.
 */
import { useSyncExternalStore } from 'react';
import type { DragInfo } from '@/sdk/din';

export const DRAG_MIME = 'application/x-din-drag';

export interface DinDragEntry {
  token: string;
  kind: 'files';
  /** The app that started it ('din' for the desktop). */
  source: string;
  paths: string[];
  folders: boolean;
  /** A source that may read the files but not write them: a target gets copies, never a move. */
  copyOnly?: boolean;
  /**
   * What the desktop's overlay shows following the pointer ("3 items"), for
   * a drag started in an app: a guest's own drag image doesn't reach the
   * screen. Unset for the desktop's own drags, whose drag image does.
   */
  label?: string;
  /** Hears how it ended, for the source's onEnd. */
  onEnd?: (result: { dropped: boolean; operation: 'copy' | 'move' | 'link' | null }) => void;
  /** Set once a target took it. */
  accepted: { operation: 'copy' | 'move' | 'link' } | null;
}

const drags = new Map<string, DinDragEntry>();
let current: DinDragEntry | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) l();
}

/** Register a drag; false if the token is taken. It becomes the current drag. */
export function registerDrag(entry: Omit<DinDragEntry, 'accepted'>): boolean {
  if (drags.has(entry.token)) return false;
  const full = { ...entry, accepted: null };
  drags.set(entry.token, full);
  current = full;
  changed();
  return true;
}

/** A target takes the drop: the drag, once, or null for an unknown token or a second taker. */
export function acceptDrag(token: string, operation: 'copy' | 'move' | 'link'): DinDragEntry | null {
  const entry = drags.get(token);
  if (!entry || entry.accepted) return null;
  entry.accepted = { operation: entry.copyOnly && operation === 'move' ? 'copy' : operation };
  return entry;
}

/**
 * The source's dragend: tell it how the drag went, and forget the drag a
 * little later. `dropEffect` is the source's own reading; a desktop target
 * (a Files window) takes a drop without accepting it here.
 */
export function finishDrag(token: string, dropEffect: string): DinDragEntry | null {
  const entry = drags.get(token);
  if (!entry) return null;
  const effect = dropEffect === 'copy' || dropEffect === 'move' || dropEffect === 'link' ? dropEffect : null;
  const operation = entry.accepted?.operation ?? effect;
  entry.onEnd?.({ dropped: operation !== null, operation });
  if (current === entry) {
    current = null;
    setDragPoint(null);
    changed();
  }
  // A drop can arrive after the source's dragend (another process), so the
  // token outlives it briefly.
  setTimeout(() => drags.delete(token), 5000);
  return entry;
}

/**
 * Stop treating the current drag as under way, for when its end was never
 * heard (its source's window closed mid-drag): a surface that sees pointer
 * events knows no drag is going on, since none come during one. It stays
 * registered, so a late drop or dragend still finds it.
 */
export function forgetCurrentDrag(): void {
  if (!current) return;
  current = null;
  setDragPoint(null);
  changed();
}

export function currentDrag(): DinDragEntry | null {
  return current;
}

/**
 * What apps see of a drag: no paths until they take it, and no token: that
 * a target reads from the drop's DataTransfer, so only where it's dropped
 * can take it.
 */
export function dragInfo(entry: DinDragEntry | null): DragInfo | null {
  if (!entry) return null;
  return {
    kind: entry.kind,
    source: entry.source,
    count: entry.paths.length,
    folders: entry.folders,
  };
}

/** Where the current drag is, in the desktop's viewport, as its surfaces last saw it. */
let point: { x: number; y: number } | null = null;
const pointListeners = new Set<() => void>();

/** A tab torn off an app's strip: what the overlay shows while it's dragged (din.window.tabDragMove). */
let tabLabel: string | null = null;
const labelListeners = new Set<() => void>();

export function setTabDragLabel(label: string | null): void {
  if (label === tabLabel) return;
  tabLabel = label;
  for (const l of labelListeners) l();
}

export function useTabDragLabel(): string | null {
  return useSyncExternalStore(
    (l) => {
      labelListeners.add(l);
      return () => labelListeners.delete(l);
    },
    () => tabLabel,
  );
}

export function setDragPoint(next: { x: number; y: number } | null): void {
  if (point?.x === next?.x && point?.y === next?.y) return;
  point = next;
  for (const l of pointListeners) l();
}

export function useDragPoint(): { x: number; y: number } | null {
  return useSyncExternalStore(
    (l) => {
      pointListeners.add(l);
      return () => pointListeners.delete(l);
    },
    () => point,
  );
}

export function subscribeDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrentDinDrag(): DinDragEntry | null {
  return useSyncExternalStore(subscribeDrag, currentDrag);
}
