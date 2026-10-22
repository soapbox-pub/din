import { useCallback, useLayoutEffect, useRef, useState } from 'react';

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

/** Left edge an element would have without our transform. */
function naturalLeft(el: HTMLElement): number {
  const translate = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
  return el.getBoundingClientRect().left - translate;
}

/** Animate `el` from `delta` px away back to its natural slot. */
function settle(el: HTMLElement, delta: number): void {
  // Inline transitions only last as long as our animation, then the
  // element's own classes (the dock's width animation, for one) take over.
  const release = () => {
    if (el.dataset.reorderDragging === undefined) el.style.transition = '';
  };
  if (!delta || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.style.transform = '';
    release();
    return;
  }
  el.style.transition = 'none';
  el.style.transform = `translateX(${delta}px)`;
  void el.offsetWidth;
  el.style.transition = `transform ${SETTLE_MS}ms ease-out`;
  el.style.transform = '';
  window.setTimeout(release, SETTLE_MS);
}

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  /** Where in the dragged element the pointer grabbed it. */
  grabOffset: number;
  lastX: number;
  active: boolean;
}

/**
 * Drag-to-reorder for a horizontal row of items (tab strips, dock tiles).
 *
 * The dragged item follows the pointer, and as its center crosses a
 * neighbor's, `onMove(id, toIndex)` reorders the list right away (Chrome's
 * tab strip behaves the same way); neighbors slide into their new slots. The
 * pointer is captured for the whole gesture, so moves over a <webview> below
 * the row still count, and the click that ends a drag is swallowed so it
 * doesn't also activate or launch the item.
 *
 * Positions are written straight onto the elements' transforms rather than
 * through React state, so a drag only re-renders when the order changes.
 */
export function useDragReorder({
  ids,
  onMove,
  relayout,
}: {
  /** The reorderable items' ids, in display order. */
  ids: string[];
  onMove: (id: string, toIndex: number) => void;
  /**
   * Called after a reorder commits, before siblings are measured, for items
   * whose size depends on their position (the dock's magnification). Sizes
   * must settle synchronously here, not through a transition.
   */
  relayout?: () => void;
}) {
  const elements = useRef(new Map<string, HTMLElement>());
  const drag = useRef<Drag | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Sibling positions just before a reorder, to slide them from (FLIP).
  const before = useRef<Map<string, number> | null>(null);

  const latest = useRef({ ids, onMove, relayout });
  useLayoutEffect(() => {
    latest.current = { ids, onMove, relayout };
  });

  /** Put the dragged element under the pointer, and reorder if it crossed a neighbor. */
  const follow = useCallback(() => {
    const d = drag.current;
    if (!d?.active) return;
    const el = elements.current.get(d.id);
    if (!el) return;
    const left = naturalLeft(el);
    el.style.transform = `translateX(${d.lastX - d.grabOffset - left}px)`;

    const center = d.lastX - d.grabOffset + el.offsetWidth / 2;
    const { ids, onMove } = latest.current;
    const others = ids.filter((id) => id !== d.id);
    let to = 0;
    for (const id of others) {
      const sibling = elements.current.get(id);
      if (!sibling) continue;
      // Where it's headed, not where a slide-in animation has it right now.
      if (naturalLeft(sibling) + sibling.offsetWidth / 2 < center) to++;
    }
    if (to === ids.indexOf(d.id)) return;
    before.current = new Map(
      others.flatMap((id) => {
        const sibling = elements.current.get(id);
        return sibling ? [[id, sibling.getBoundingClientRect().left] as const] : [];
      }),
    );
    onMove(d.id, to);
  }, []);

  // After a reorder commits: keep the dragged item under the pointer, and
  // slide its displaced neighbors from where they were.
  useLayoutEffect(() => {
    const old = before.current;
    if (!old) return;
    before.current = null;
    latest.current.relayout?.();
    for (const [id, left] of old) {
      const el = elements.current.get(id);
      if (el) settle(el, left - el.getBoundingClientRect().left);
    }
    follow();
  });

  const end = useCallback((cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    setDraggingId(null);
    const el = elements.current.get(d.id);
    if (el) {
      delete el.dataset.reorderDragging;
      el.style.zIndex = '';
      settle(el, el.getBoundingClientRect().left - naturalLeft(el));
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
      grabOffset: e.clientX - naturalLeft(el),
      lastX: e.clientX,
      active: false,
    };
    const target = e.currentTarget;
    const onMovePointer = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      d.lastX = ev.clientX;
      if (!d.active) {
        if (Math.abs(ev.clientX - d.startX) < DRAG_THRESHOLD) return;
        d.active = true;
        target.setPointerCapture(d.pointerId);
        el.dataset.reorderDragging = '';
        el.style.transition = 'none';
        el.style.zIndex = '10';
        setDraggingId(d.id);
      }
      follow();
    };
    // Reordering moves the item's node in the DOM, which drops the capture;
    // take it back, or moves over a <webview> stop arriving.
    const onLostCapture = () => {
      const d = drag.current;
      if (d?.active && target.isConnected) target.setPointerCapture(d.pointerId);
    };
    target.addEventListener('lostpointercapture', onLostCapture);
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.current?.pointerId) return;
      target.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('pointermove', onMovePointer);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      end(ev.type === 'pointercancel');
    };
    window.addEventListener('pointermove', onMovePointer);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [end, follow]);

  /** Ref registrar for an item's moving element. Stable. */
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  return { register, onPointerDown, draggingId };
}
