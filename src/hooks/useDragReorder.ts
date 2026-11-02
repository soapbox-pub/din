import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/shared/reducedMotion';

/** Pointer travel before a press turns into a drag, in CSS pixels. */
const DRAG_THRESHOLD = 5;
/** How long siblings take to slide into their new slots. */
const SETTLE_MS = 150;

/** Return a copy of `list` with the item `id` moved to index `to`. */
export function moveItem<T extends { id: string }>(list: T[], id: string, to: number): T[] {
  const from = list.findIndex((item) => item.id === id);
  if (from === -1 || from === to) return list;
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** The axis a row of items runs along: across, or down a column. */
export type ReorderAxis = 'x' | 'y';

/** Left (or top, down a column) edge an element would have without our transform. */
function naturalStart(el: HTMLElement, axis: ReorderAxis = 'x'): number {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  const rect = el.getBoundingClientRect();
  return axis === 'y' ? rect.top - matrix.m42 : rect.left - matrix.m41;
}

/** An element's left edge, or its top down a column. */
function start(el: HTMLElement, axis: ReorderAxis): number {
  const rect = el.getBoundingClientRect();
  return axis === 'y' ? rect.top : rect.left;
}

/** An element's width, or its height down a column. */
function length(el: HTMLElement, axis: ReorderAxis): number {
  return axis === 'y' ? el.offsetHeight : el.offsetWidth;
}

/** A transform moving an element `px` along the axis. */
function translate(axis: ReorderAxis, px: number): string {
  return axis === 'y' ? `translateY(${px}px)` : `translateX(${px}px)`;
}

/** Animate `el` from `delta` px away back to its natural slot. */
function settle(el: HTMLElement, delta: number, axis: ReorderAxis): void {
  // Inline transitions only last as long as our animation, then the
  // element's own classes (the dock's width animation, for one) take over.
  const release = () => {
    if (el.dataset.reorderDragging === undefined) el.style.transition = '';
  };
  if (!delta || prefersReducedMotion()) {
    el.style.transform = '';
    release();
    return;
  }
  el.style.transition = 'none';
  el.style.transform = translate(axis, delta);
  void el.offsetWidth;
  el.style.transition = `transform ${SETTLE_MS}ms ease-out`;
  el.style.transform = '';
  window.setTimeout(release, SETTLE_MS);
}

/** How far the pointer leaves the row, up or down, to tear an item off. */
const TEAR_OFF_PX = 32;

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where in the dragged element the pointer grabbed it. */
  grabOffset: number;
  grabOffsetY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  /** The drag is moving the window (see `moveWindow`). */
  window: WindowMoveGesture | null;
  /** A copy of the item following the pointer while it's torn off the row. */
  ghost: HTMLElement | null;
  /**
   * Where the ghost's `left: 0; top: 0` lands in the viewport. Not always the
   * origin: with several monitors, <body> is the containing block for fixed
   * elements and sits at the primary monitor's offset (MonitorsProvider).
   */
  ghostOrigin: DragPoint;
}

/** A point in viewport coordinates. */
export interface DragPoint {
  x: number;
  y: number;
}

/**
 * Moving the item's window instead of the item: the desktop's window chrome,
 * or an app's `din.window.beginMove`. `beginMove` gets the press point and the
 * pointer event that crossed the drag threshold, and says whether the window
 * took the gesture; `gestureMove` and `gestureEnd` follow it from then on.
 */
export interface WindowMoveGesture {
  beginMove(point: { clientX: number; clientY: number }, event: PointerEvent): boolean;
  gestureMove(point: { clientX: number; clientY: number }): void;
  gestureEnd(): void;
}

/** Dragging items off the row (tabs into other windows, apps off the dock). */
export interface TearOff {
  /** Whether items, or a given item, can leave the row at all. */
  enabled: boolean | ((id: string) => boolean);
  /** How far past the row's top or bottom the pointer goes to tear an item off, in px. */
  distance?: number;
  /** Adjust the copy that follows the pointer, once it's made. */
  decorateGhost?: (ghost: HTMLElement) => void;
  /** While torn off, where the pointer is; null once it's back on the row. */
  onHover?: (id: string, point: DragPoint | null) => void;
  /** The item was released away from the row. */
  onDrop: (id: string, point: DragPoint) => void;
  /** Takes the ghost away after a drop, instead of removing it at once. */
  dismissGhost?: (ghost: HTMLElement) => void;
}

function tearable(tearOff: TearOff | undefined, id: string): boolean {
  if (!tearOff) return false;
  return typeof tearOff.enabled === 'function' ? tearOff.enabled(id) : tearOff.enabled;
}

/** Put a ghost of `el` under the pointer. */
function placeGhost(ghost: HTMLElement, d: Drag): void {
  const x = d.lastX - d.grabOffset - d.ghostOrigin.x;
  const y = d.lastY - d.grabOffsetY - d.ghostOrigin.y;
  ghost.style.transform = `translate(${x}px, ${y}px)`;
}

function createGhost(el: HTMLElement, d: Drag): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  for (const attr of ['id', 'role', 'tabindex']) ghost.removeAttribute(attr);
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${el.offsetWidth}px`,
    height: `${el.offsetHeight}px`,
    margin: '0',
    transition: 'none',
    pointerEvents: 'none',
    zIndex: '2147483647',
    opacity: '0.95',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.25)',
  });
  (document.getElementById('shell') ?? document.body).appendChild(ghost);
  const origin = ghost.getBoundingClientRect();
  d.ghostOrigin = { x: origin.left, y: origin.top };
  placeGhost(ghost, d);
  return ghost;
}

/**
 * Drag-to-reorder for a horizontal row of items (tab strips, dock tiles), or
 * a column of them with `axis: 'y'` (a taskbar down the side of the screen).
 *
 * The dragged item follows the pointer, and as its center crosses a
 * neighbor's, `onMove(id, toIndex)` reorders the list right away (Chrome's
 * tab strip behaves the same way); neighbors slide into their new slots. The
 * pointer is captured for the whole gesture, so moves over a <webview> below
 * the row still count, and the click that ends a drag is swallowed so it
 * doesn't also activate or launch the item.
 *
 * With `tearOff`, dragging an item well above or below the row tears it off
 * (tabs into other windows, pinned apps off the dock):
 * it stays in its slot, dimmed, while a copy follows the pointer, and
 * releasing it there hands it to `tearOff.onDrop`. Bringing it back onto the
 * row resumes reordering.
 *
 * With `moveWindow`, a drag moves the window instead (a window's only tab,
 * Chrome-style): past the threshold, the gesture goes to the window's chrome
 * and the item stays put.
 *
 * Positions are written straight onto the elements' transforms rather than
 * through React state, so a drag only re-renders when the order changes.
 */
export function useDragReorder({
  ids,
  onMove,
  constrain,
  relayout,
  tearOff,
  moveWindow,
  axis = 'x',
}: {
  /** The reorderable items' ids, in display order. */
  ids: string[];
  onMove: (id: string, toIndex: number) => void;
  /** Limits where an item may go: maps the index it's over to the one it moves to. */
  constrain?: (id: string, toIndex: number) => number;
  /**
   * Called after a reorder commits, before siblings are measured, for items
   * whose size depends on their position (the dock's magnification). Sizes
   * must settle synchronously here, not through a transition.
   */
  relayout?: () => void;
  tearOff?: TearOff;
  /** Drags move this window instead of the item. */
  moveWindow?: WindowMoveGesture;
  /** Whether the items run across (the default) or down. */
  axis?: ReorderAxis;
}) {
  const elements = useRef(new Map<string, HTMLElement>());
  const drag = useRef<Drag | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Sibling positions just before a reorder, to slide them from (FLIP).
  const before = useRef<Map<string, number> | null>(null);

  const latest = useRef({ ids, onMove, constrain, relayout, tearOff, moveWindow, axis });
  useLayoutEffect(() => {
    latest.current = { ids, onMove, constrain, relayout, tearOff, moveWindow, axis };
  });

  /** Put the dragged element under the pointer, and reorder if it crossed a neighbor. */
  const follow = useCallback(() => {
    const d = drag.current;
    if (!d?.active || d.ghost) return;
    const el = elements.current.get(d.id);
    if (!el) return;
    const { ids, onMove, constrain, axis } = latest.current;
    const grabbed = axis === 'y' ? d.lastY - d.grabOffsetY : d.lastX - d.grabOffset;
    el.style.transform = translate(axis, grabbed - naturalStart(el, axis));

    const center = grabbed + length(el, axis) / 2;
    const others = ids.filter((id) => id !== d.id);
    let to = 0;
    for (const id of others) {
      const sibling = elements.current.get(id);
      if (!sibling) continue;
      // Where it's headed, not where a slide-in animation has it right now.
      if (naturalStart(sibling, axis) + length(sibling, axis) / 2 < center) to++;
    }
    if (constrain) to = constrain(d.id, to);
    if (to === ids.indexOf(d.id)) return;
    before.current = new Map(
      others.flatMap((id) => {
        const sibling = elements.current.get(id);
        return sibling ? [[id, start(sibling, axis)] as const] : [];
      }),
    );
    onMove(d.id, to);
  }, []);

  /** Tear the dragged item off the row, or put it back, as the pointer goes. */
  const tear = useCallback(() => {
    const d = drag.current;
    const tearOff = latest.current.tearOff;
    if (!d?.active || !tearOff || !tearable(tearOff, d.id)) return;
    const el = elements.current.get(d.id);
    if (!el) return;
    const row = (el.parentElement ?? el).getBoundingClientRect();
    if (!d.ghost) {
      const distance = tearOff.distance ?? TEAR_OFF_PX;
      if (d.lastY > row.top - distance && d.lastY < row.bottom + distance) return;
      el.style.transform = '';
      el.style.opacity = '0.4';
      d.ghost = createGhost(el, d);
      tearOff.decorateGhost?.(d.ghost);
    } else if (
      d.lastY >= row.top && d.lastY <= row.bottom &&
      d.lastX >= row.left && d.lastX <= row.right
    ) {
      d.ghost.remove();
      d.ghost = null;
      el.style.opacity = '';
      tearOff.onHover?.(d.id, null);
      return;
    }
    placeGhost(d.ghost, d);
    tearOff.onHover?.(d.id, { x: d.lastX, y: d.lastY });
  }, []);

  // After a reorder commits: keep the dragged item under the pointer, and
  // slide its displaced neighbors from where they were.
  useLayoutEffect(() => {
    const old = before.current;
    if (!old) return;
    before.current = null;
    const { relayout, axis } = latest.current;
    relayout?.();
    for (const [id, was] of old) {
      const el = elements.current.get(id);
      if (el) settle(el, was - start(el, axis), axis);
    }
    follow();
  });

  const end = useCallback((cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    if (d.window) {
      d.window.gestureEnd();
    } else {
      setDraggingId(null);
      const el = elements.current.get(d.id);
      if (el) {
        delete el.dataset.reorderDragging;
        el.style.zIndex = '';
        el.style.opacity = '';
        const { axis } = latest.current;
        settle(el, start(el, axis) - naturalStart(el, axis), axis);
      }
      if (d.ghost) {
        const tearOff = latest.current.tearOff;
        if (!cancelled && tearOff?.dismissGhost) tearOff.dismissGhost(d.ghost);
        else d.ghost.remove();
        tearOff?.onHover?.(d.id, null);
        if (!cancelled) tearOff?.onDrop(d.id, { x: d.lastX, y: d.lastY });
      }
    }
    if (cancelled) return;
    // The click that ends the drag isn't a click on the item.
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }));
  }, []);

  const onPointerDown = useCallback((id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary || drag.current) return;
    // Controls inside the item (a tab's close button) keep their own presses.
    const control = e.target instanceof Element ? e.target.closest('button, a, input') : null;
    if (control && control !== e.currentTarget && e.currentTarget.contains(control)) return;
    const el = elements.current.get(id);
    if (!el) return;
    drag.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffset: e.clientX - naturalStart(el, 'x'),
      grabOffsetY: e.clientY - naturalStart(el, 'y'),
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      window: null,
      ghost: null,
      ghostOrigin: { x: 0, y: 0 },
    };
    const target = e.currentTarget;
    const onMovePointer = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      // The button came up somewhere its release didn't reach us.
      if (ev.buttons === 0) {
        finish(false);
        return;
      }
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      if (!d.active) {
        const { tearOff, moveWindow, axis } = latest.current;
        // An item that can be torn off, or that moves its window, starts
        // dragging in any direction.
        const travel = tearable(tearOff, d.id) || moveWindow
          ? Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY)
          : axis === 'y' ? Math.abs(ev.clientY - d.startY) : Math.abs(ev.clientX - d.startX);
        if (travel < DRAG_THRESHOLD) return;
        d.active = true;
        target.setPointerCapture(d.pointerId);
        if (moveWindow?.beginMove({ clientX: d.startX, clientY: d.startY }, ev)) {
          d.window = moveWindow;
        } else {
          el.dataset.reorderDragging = '';
          el.style.transition = 'none';
          el.style.zIndex = '10';
          setDraggingId(d.id);
        }
      }
      if (d.window) {
        d.window.gestureMove(ev);
        return;
      }
      tear();
      follow();
    };
    // Reordering moves the item's node in the DOM, which drops the capture;
    // take it back, or moves over a <webview> stop arriving.
    const onLostCapture = () => {
      const d = drag.current;
      if (d?.active && target.isConnected) target.setPointerCapture(d.pointerId);
    };
    target.addEventListener('lostpointercapture', onLostCapture);
    const finish = (cancelled: boolean) => {
      target.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('pointermove', onMovePointer);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      end(cancelled);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.current?.pointerId) return;
      finish(ev.type === 'pointercancel');
    };
    window.addEventListener('pointermove', onMovePointer);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [end, follow, tear]);

  /** Ref registrar for an item's moving element. Stable. */
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  return { register, onPointerDown, draggingId };
}
