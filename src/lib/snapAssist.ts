import { useSyncExternalStore } from 'react';
import { zoneSide, type SnapZone } from '@/lib/monitors';

/**
 * Snap Assist, as Windows has it: once the user snaps a window to part of
 * a monitor, the rest of it offers their other windows to fill it. A snap
 * the user made by hand (a drag to an edge, the title bar's menu) asks for
 * it here; the desktop's SnapAssist shows it.
 */

/** A snap to assist with: the window just snapped, and where to. */
export interface SnapAssistRequest {
  windowId: string;
  zone: SnapZone;
  /** The work area it snapped on. */
  areaId: string;
  /** Tells one request from the next for the same window. */
  seq: number;
}

let current: SnapAssistRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Offer the user's other windows around the window they just snapped. */
export function offerSnapAssist(windowId: string, zone: SnapZone, areaId: string): void {
  current = { windowId, zone, areaId, seq: ++seq };
  emit();
}

/** Put Snap Assist away. */
export function dismissSnapAssist(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The snap Snap Assist is helping with, or null. */
export function useSnapAssistRequest(): SnapAssistRequest | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

const CELLS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

/** The quarters a zone covers. */
function cellsOf(zone: SnapZone): SnapZone[] {
  if (zone === 'left') return ['top-left', 'bottom-left'];
  if (zone === 'right') return ['top-right', 'bottom-right'];
  return [zone];
}

/**
 * The parts of a monitor left empty around the snapped zones, in the order
 * Snap Assist fills them: a column with nothing in it is offered whole, as
 * a half, else its empty quarters; the column of `first` comes first. None
 * when nothing's snapped.
 */
export function emptyZones(taken: SnapZone[], first: SnapZone | null): SnapZone[] {
  if (taken.length === 0) return [];
  const filled = new Set(taken.flatMap(cellsOf));
  const column = (side: 'left' | 'right'): SnapZone[] => {
    const cells = CELLS.filter((c) => c.endsWith(side) && !filled.has(c));
    return cells.length === 2 ? [side] : cells;
  };
  const firstSide = first ? zoneSide(first) : 'left';
  return firstSide === 'left' ? [...column('left'), ...column('right')] : [...column('right'), ...column('left')];
}
