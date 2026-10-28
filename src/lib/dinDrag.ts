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
  kind: 'files' | 'tab';
  /** The app that started it ('din' for the desktop). */
  source: string;
  paths: string[];
  folders: boolean;
  tabType?: string;
  tabState?: unknown;
  /** Hears how it ended, for the source's onEnd / onTabDetached. */
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
  entry.accepted = { operation };
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
    changed();
  }
  // A drop can arrive after the source's dragend (another process), so the
  // token outlives it briefly.
  setTimeout(() => drags.delete(token), 5000);
  return entry;
}

export function currentDrag(): DinDragEntry | null {
  return current;
}

/** What apps see of a drag: no paths until they take it. */
export function dragInfo(entry: DinDragEntry | null): DragInfo | null {
  if (!entry) return null;
  return {
    token: entry.token,
    kind: entry.kind,
    source: entry.source,
    count: entry.paths.length,
    folders: entry.folders,
    tabType: entry.tabType,
  };
}

export function subscribeDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrentDinDrag(): DinDragEntry | null {
  return useSyncExternalStore(subscribeDrag, currentDrag);
}
