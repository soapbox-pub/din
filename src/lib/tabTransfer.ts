import { portalContainer } from '@/lib/portalContainer';

/**
 * Moving tabs between windows of the same app (Chrome-style): a tab dragged
 * out of its strip and dropped on another window's strip moves there, and
 * one dropped anywhere else opens in a new window.
 *
 * Every tab strip that can take tabs registers itself here as a drop target.
 * Tabs only move between strips of the same `group` - an app id, plus
 * anything else that must match (a private browser window's tabs stay among
 * private windows). What a tab carries is up to its app: the payload is
 * whatever the receiving window of that app needs to rebuild it.
 */

export interface TabDropTarget {
  windowId: string;
  group: string;
  /** The strip's tablist element; its `[role="tab"]` children are the tabs. */
  element: HTMLElement;
  /** What the window is showing, for "Move to window" menus. */
  title: () => string;
  /** Add a tab taken from another window, at `index` in the strip. */
  receive: (payload: unknown, index: number) => void;
}

const targets = new Set<TabDropTarget>();

/** Register a strip as a drop target. Returns the unregister fn. */
export function registerTabDropTarget(target: TabDropTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/** The other windows' strips in a group, in registration order. */
export function tabDropTargets(group: string, exceptWindowId: string): TabDropTarget[] {
  return [...targets].filter((t) => t.group === group && t.windowId !== exceptWindowId);
}

export function tabDropTargetFor(group: string, windowId: string): TabDropTarget | undefined {
  return [...targets].find((t) => t.group === group && t.windowId === windowId);
}

/**
 * The strip in `group` under a viewport point, if one is visible there. Hit
 * testing goes through the DOM, so a strip covered by another window doesn't
 * count.
 */
export function tabDropTargetAt(x: number, y: number, group: string): TabDropTarget | null {
  const list = document.elementFromPoint(x, y)?.closest('[role="tablist"]');
  if (!list) return null;
  for (const t of targets) {
    if (t.element === list && t.group === group) return t;
  }
  return null;
}

/**
 * Where a tab dropped at viewport x lands in a strip: its index, and the x
 * of the gap it goes into (for the drop indicator).
 */
export function dropSlotAt(element: HTMLElement, x: number): { index: number; x: number } {
  const tabs = [...element.querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
  let index = 0;
  for (const tab of tabs) {
    const r = tab.getBoundingClientRect();
    if (r.left + r.width / 2 < x) index++;
  }
  if (tabs.length === 0) return { index: 0, x: element.getBoundingClientRect().left };
  if (index < tabs.length) return { index, x: tabs[index].getBoundingClientRect().left - 2 };
  return { index, x: tabs[tabs.length - 1].getBoundingClientRect().right + 2 };
}

let indicator: HTMLDivElement | null = null;

/** Mark where a dragged tab would land in a strip. */
export function showDropIndicator(element: HTMLElement, x: number): void {
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.setAttribute('aria-hidden', 'true');
    indicator.className = 'pointer-events-none fixed w-0.5 rounded-full bg-primary';
    indicator.style.zIndex = '2147483646';
    portalContainer().appendChild(indicator);
  }
  const rect = element.getBoundingClientRect();
  indicator.style.left = `${dropSlotAt(element, x).x - 1}px`;
  indicator.style.top = `${rect.top + 4}px`;
  indicator.style.height = `${Math.max(0, rect.height - 8)}px`;
}

export function hideDropIndicator(): void {
  indicator?.remove();
  indicator = null;
}

// A tab headed for a window that doesn't exist yet waits here: the new
// window's launch params carry the token (params must stay serializable) and
// its app claims the payload when it mounts.
const parked = new Map<string, unknown>();
let nextToken = 0;

/** How long a parked tab waits for its window before it's dropped. */
const PARK_MS = 60_000;

export function parkTab(payload: unknown): string {
  const token = `tab-transfer-${nextToken++}`;
  parked.set(token, payload);
  window.setTimeout(() => parked.delete(token), PARK_MS);
  return token;
}

/**
 * The payload parked under the token in a window's launch params, if any.
 * Doesn't consume it: state initializers can run twice in development.
 */
export function parkedTab(params: Record<string, unknown> | undefined): unknown {
  const token = params?.adoptTab;
  return typeof token === 'string' ? parked.get(token) : undefined;
}
