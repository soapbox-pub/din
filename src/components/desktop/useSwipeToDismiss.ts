import { useRef, type MouseEvent, type PointerEvent } from 'react';

/** How far a finger moves before it's a swipe rather than a tap. */
const SLOP = 8;
/** A fling this fast (px/ms) dismisses however short it was. */
const FLING = 0.5;
/** Released past this share of the card's width (or height, going up), it goes. */
const DISTANCE = 0.35;
const OUT_MS = 180;
const BACK_MS = 200;

type Axis = 'right' | 'up';

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  axis: Axis | null;
  /** The last few moves, for the release's speed. */
  samples: { t: number; d: number }[];
}

/**
 * A notification swiped off with a finger or pen: to the right, or up as
 * well where `up` is set (a popup, which has no list to scroll), it follows
 * the finger and fades, and once let go far or fast enough it slides away
 * and `onDismiss` runs; otherwise it springs back. The mouse keeps its
 * clicks and text selection. A swipe never also clicks what it started on.
 *
 * Spread the handlers on the card's root; `style` gives it the touch-action
 * that leaves the browser vertical scrolling (in a list) and nothing else.
 */
export function useSwipeToDismiss({ onDismiss, up }: { onDismiss: () => void; up: boolean }) {
  const gesture = useRef<Gesture | null>(null);
  const swiped = useRef(false);
  const gone = useRef(false);

  const place = (el: HTMLElement, axis: Axis, d: number, transition: string) => {
    el.style.transition = transition;
    el.style.transform = axis === 'right' ? `translateX(${d}px)` : `translateY(${-d}px)`;
    const size = axis === 'right' ? el.offsetWidth : el.offsetHeight;
    el.style.opacity = String(Math.max(0, 1 - d / Math.max(1, size)));
  };

  const reset = (el: HTMLElement) => {
    el.style.transition = `transform ${BACK_MS}ms ease-out, opacity ${BACK_MS}ms ease-out`;
    el.style.transform = '';
    el.style.opacity = '';
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    swiped.current = false;
    if (e.pointerType === 'mouse' || gone.current || gesture.current) return;
    // A reply being written keeps its own touches (selecting, scrolling it).
    if (e.target instanceof Element && e.target.closest('input, textarea')) return;
    gesture.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, axis: null, samples: [] };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < SLOP) return;
      if (dx > 0 && Math.abs(dx) > Math.abs(dy)) g.axis = 'right';
      else if (up && dy < 0 && Math.abs(dy) > Math.abs(dx)) g.axis = 'up';
      else {
        // Left, or down, or scrolling the list: not ours.
        gesture.current = null;
        return;
      }
      swiped.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    // Back past where it started, it only gives a little.
    const raw = g.axis === 'right' ? dx : -dy;
    const d = raw >= 0 ? raw : raw / 4;
    g.samples.push({ t: e.timeStamp, d });
    if (g.samples.length > 5) g.samples.shift();
    place(e.currentTarget, g.axis, d, 'none');
  };

  const finish = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    if (!g.axis) return;
    const el = e.currentTarget;
    const last = g.samples[g.samples.length - 1];
    const first = g.samples[0];
    const d = last?.d ?? 0;
    const speed = last && first && last.t > first.t ? (last.d - first.d) / (last.t - first.t) : 0;
    const size = g.axis === 'right' ? el.offsetWidth : el.offsetHeight;
    if (cancelled || (d < size * DISTANCE && speed < FLING) || d <= 0) {
      reset(el);
      return;
    }
    gone.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDismiss();
      return;
    }
    // Out past its own size (and the screen edge, going right), then gone.
    place(el, g.axis, size + 32, `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`);
    window.setTimeout(onDismiss, OUT_MS);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: PointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => finish(e, true),
    /** The click a swipe ends in isn't one. */
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!swiped.current) return;
      swiped.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    style: { touchAction: up ? 'none' : 'pan-y' } as const,
  };
}
