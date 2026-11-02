import type { KeyboardEvent } from 'react';

/**
 * Moving the keyboard between the parts of the desktop, as macOS's
 * Ctrl+F2 and friends do: the menu bar (the taskbar's Start button), the
 * Dock or the taskbar's buttons, the status icons, and the notifications
 * popped up. Each part marks its root with `data-focus-area`; Escape in one
 * goes back to where the keyboard was before (DesktopHotkeys binds the keys).
 */

export type FocusArea = 'menu-bar' | 'dock' | 'status' | 'notifications';

export const FOCUS_AREAS: readonly FocusArea[] = ['menu-bar', 'dock', 'status', 'notifications'];

/** The order Ctrl+F6 goes round in; `window` is the focused window. */
const CYCLE: readonly (FocusArea | 'window')[] = ['window', 'menu-bar', 'dock', 'notifications'];

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where the keyboard was before it came into a part of the desktop. */
let returnTo: HTMLElement | null = null;

function areaElement(area: FocusArea): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-focus-area="${area}"]`);
}

function shown(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]');
}

function focusablesIn(el: Element, selector = FOCUSABLE): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(selector)].filter(shown);
}

/** The part of the desktop the keyboard is in, if it's in one. */
export function currentArea(): FocusArea | null {
  const active = document.activeElement;
  const area = active instanceof Element ? active.closest('[data-focus-area]')?.getAttribute('data-focus-area') : null;
  return (FOCUS_AREAS as readonly string[]).includes(area ?? '') ? (area as FocusArea) : null;
}

/** Give the keyboard to a part of the desktop; false when it isn't on screen. */
export function focusArea(area: FocusArea): boolean {
  const el = areaElement(area);
  const first = el && focusablesIn(el)[0];
  if (!first) return false;
  if (!currentArea()) {
    const active = document.activeElement;
    returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  first.focus({ preventScroll: true });
  return true;
}

/** Give the keyboard back to the focused window, or wherever it was before. */
export function leaveArea(): void {
  const target = returnTo;
  returnTo = null;
  if (target?.isConnected && !target.closest('[data-focus-area]')) {
    target.focus({ preventScroll: true });
    return;
  }
  focusTopWindow();
}

/** The frontmost window's page, or its first control. */
function focusTopWindow(): void {
  const sections = [...document.querySelectorAll<HTMLElement>('section[data-window-id]')].filter(
    (s) => shown(s) && !s.classList.contains('pointer-events-none'),
  );
  const top = sections.reduce<HTMLElement | null>(
    (best, s) => (!best || Number(s.style.zIndex) > Number(best.style.zIndex) ? s : best),
    null,
  );
  if (!top) {
    (document.activeElement as HTMLElement | null)?.blur?.();
    return;
  }
  const target = top.querySelector<HTMLElement>('webview, iframe') ?? focusablesIn(top)[0];
  target?.focus({ preventScroll: true });
}

/** Ctrl+F6 (Shift: backwards): the next part of the desktop that's on screen. */
export function cycleArea(backward = false): void {
  // The status icons are on the menu bar (or the taskbar).
  const here = currentArea();
  const at = CYCLE.indexOf(here === 'status' ? 'menu-bar' : (here ?? 'window'));
  const step = backward ? -1 : 1;
  for (let i = 1; i <= CYCLE.length; i++) {
    const next = CYCLE[(at + step * i + CYCLE.length * 2) % CYCLE.length];
    if (next === 'window') {
      leaveArea();
      return;
    }
    if (next !== CYCLE[at] && focusArea(next)) return;
  }
}

/** What Ctrl+F2 and its kin ask for: a part of the desktop, or the next or previous one. */
export type FocusKey = FocusArea | 'next' | 'previous';

/** Give the keyboard to a part of the desktop, or go round them; false when there's nowhere to go. */
export function runFocusKey(key: FocusKey): boolean {
  if (key === 'next' || key === 'previous') {
    cycleArea(key === 'previous');
    return true;
  }
  return focusArea(key);
}

/**
 * Arrow keys between a toolbar's items (Home and End to its ends), for a
 * keydown handler on the toolbar. Only a key pressed on one of the items
 * moves: one in a field, or bubbling from a portaled menu, is left alone.
 */
export function moveAmongItems(
  e: KeyboardEvent<HTMLElement>,
  selector: string,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (e.key !== next && e.key !== previous && e.key !== 'Home' && e.key !== 'End') return;
  const items = focusablesIn(e.currentTarget, selector);
  const at = items.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const to =
    e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : (at + (e.key === next ? 1 : -1) + items.length) % items.length;
  items[to].focus();
}
