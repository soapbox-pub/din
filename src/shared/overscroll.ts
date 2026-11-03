/**
 * Overscroll: a scroll (two fingers on a touchpad, a turn of the wheel, a
 * finger dragging on a touchscreen) that runs past the end of what it
 * scrolls. Din answers it with an elastic bounce of the content
 * (src/lib/overscrollBounce.ts), as macOS and iOS do, so a scroll that went
 * the way the user didn't expect still shows it happened.
 *
 * Chromium draws no overscroll of its own on Linux, nor tells the page about
 * one, so it's worked out here from the input: the scroll chain from what's
 * under the pointer, latched for a gesture the way Chromium latches it, and
 * which way it can still move. The desktop watches its own document with
 * this; electron/overscroll-preload.cjs bundles it into every app and web
 * page (scripts/build-din-runtime.mjs), so it must stay free of imports.
 */

/** What a watched document reports, for one surface. */
export type OverscrollReport =
  /**
   * The scroll ran this far past the edge since the last report, in the
   * document's CSS pixels, in scroll terms: +y is past the bottom, -y past
   * the top. Coming back the other way it's the opposite sign, up to what
   * went past.
   */
  | { type: 'pull'; dx: number; dy: number }
  /** The gesture ended (or paused): let the content spring back. */
  | { type: 'release' };

export interface WatchOverscrollOptions {
  /**
   * The surface that bounces for an event's target, where its scroll chain
   * stops, or null when nothing there bounces. Defaults to the document's
   * root scroller.
   */
  surface?: (target: Element) => Element | null;
}

type Axis = 'x' | 'y';

/** A gesture: wheel events closer together than this, or one touch. */
const GESTURE_GAP_MS = 150;
/** No overscrolling input for this long and the content springs back. */
const RELEASE_MS = 120;
/** A touch has to move this far before it picks an axis. */
const TOUCH_SLOP = 6;
/**
 * The most one event pulls, in px: a wheel's notch arrives as one jump of a
 * hundred or more, which would throw the content; fingers move a few px an
 * event, and keep all of it.
 */
const MAX_STEP = 40;

interface Gesture {
  surface: Element;
  axis: Axis;
  /** The scrollers between the target and the surface, innermost first. */
  chain: Element[];
  /** What Chromium scrolls for the gesture: the first scroller that could move. */
  latched: Element | null;
  /** How far past the edge it's been reported, on the axis (signed). */
  out: number;
  /** A handler took the gesture (preventDefault): it doesn't bounce. */
  claimed: boolean;
  last: number;
  touch: boolean;
}

/**
 * Watch a document for overscroll, reporting each surface's. Returns the
 * function that stops watching.
 */
export function watchOverscroll(
  win: Window,
  report: (report: OverscrollReport, surface: Element) => void,
  options: WatchOverscrollOptions = {},
): () => void {
  const doc = win.document;
  const rootSurface = () => doc.scrollingElement ?? doc.documentElement;
  const surfaceOf = options.surface ?? (() => rootSurface());

  let gesture: Gesture | null = null;
  /** Events seen this frame, checked once handlers have had them. */
  let pending: Array<{ event: Event; delta: number }> = [];
  let frame = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let touchStart: { id: number; x: number; y: number; lastX: number; lastY: number; target: Element } | null = null;

  const isRoot = (el: Element) => el === doc.scrollingElement || el === doc.documentElement || el === doc.body;

  /** How far an element can scroll on an axis, toward -1 and +1, in px. */
  function room(el: Element, axis: Axis): [number, number] {
    const size = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (size <= 1) return [0, 0];
    const pos = axis === 'y' ? el.scrollTop : el.scrollLeft;
    // Reversed scrollers (column-reverse chats, right-to-left text) start at
    // 0 at the bottom or right and go negative from there.
    if (pos < 0 || (pos === 0 && isReversed(el, axis))) return [Math.max(0, size + pos), Math.max(0, -pos)];
    return [Math.max(0, pos), Math.max(0, size - pos)];
  }

  function isReversed(el: Element, axis: Axis): boolean {
    const style = win.getComputedStyle(el);
    if (axis === 'y') return style.flexDirection === 'column-reverse';
    return style.direction === 'rtl' || style.flexDirection === 'row-reverse';
  }

  /** Whether an element scrolls on an axis at all (the user can scroll it). */
  function scrolls(el: Element, axis: Axis): boolean {
    const size = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (size <= 1) return false;
    if (isRoot(el)) {
      if (el !== doc.scrollingElement) return false;
      // overflow: hidden on <html>, or on <body> when <html> leaves it
      // visible, stops the page scrolling.
      const prop = axis === 'y' ? 'overflowY' : 'overflowX';
      const html = win.getComputedStyle(doc.documentElement)[prop];
      const body = doc.body ? win.getComputedStyle(doc.body)[prop] : 'visible';
      const stopped = (value: string) => value === 'hidden' || value === 'clip';
      return !stopped(html) && !(html === 'visible' && stopped(body));
    }
    const overflow = win.getComputedStyle(el)[axis === 'y' ? 'overflowY' : 'overflowX'];
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  }

  /** The element's parent, through shadow roots and slots. */
  function parentOf(el: Element): Element | null {
    if (el.assignedSlot) return el.assignedSlot;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  /**
   * The scrollers from the target out to the surface, and whether the page
   * opted out of overscroll effects (`overscroll-behavior: none`) on the way.
   */
  function chainOf(target: Element, surface: Element, axis: Axis): { chain: Element[]; none: boolean } {
    const chain: Element[] = [];
    const prop = axis === 'y' ? 'overscrollBehaviorY' : 'overscrollBehaviorX';
    let el: Element | null = target;
    while (el) {
      if (scrolls(el, axis)) {
        chain.push(el);
        const behavior = win.getComputedStyle(el)[prop];
        if (behavior === 'none') return { chain, none: true };
        // `contain` keeps the scroll from chaining on: it bounces here.
        if (behavior === 'contain') return { chain, none: false };
      }
      if (el === surface) break;
      el = parentOf(el);
    }
    if (surface === rootSurface()) {
      const root = doc.scrollingElement;
      if (root && !chain.includes(root) && scrolls(root, axis)) chain.push(root);
      // The page asks for no overscroll effects on its root.
      if (win.getComputedStyle(doc.documentElement)[prop] === 'none') return { chain, none: true };
      if (doc.body && win.getComputedStyle(doc.body)[prop] === 'none') return { chain, none: true };
    }
    return { chain, none: false };
  }

  /** Whether a touch on this target pans on the axis (not drawn on, dragged, or mapped). */
  function touchPans(target: Element, axis: Axis): boolean {
    let el: Element | null = target;
    while (el) {
      const action = win.getComputedStyle(el).touchAction;
      if (action === 'none') return false;
      if (action !== 'auto' && action !== 'manipulation') {
        if (!action.includes(axis === 'y' ? 'pan-y' : 'pan-x') && !action.includes(axis === 'y' ? 'pan-up' : 'pan-left') && !action.includes(axis === 'y' ? 'pan-down' : 'pan-right')) return false;
      }
      el = parentOf(el);
    }
    return true;
  }

  function begin(target: Element, axis: Axis, sign: number, now: number, touch: boolean): Gesture | null {
    const surface = surfaceOf(target);
    if (!surface) return null;
    if (doc.fullscreenElement) return null;
    if (touch && !touchPans(target, axis)) return null;
    const { chain, none } = chainOf(target, surface, axis);
    // Nothing on this axis scrolls here: nothing to bounce.
    if (none || chain.length === 0) return null;
    const latched = chain.find((el) => room(el, axis)[sign > 0 ? 1 : 0] > 0.5) ?? null;
    return { surface, axis, chain, latched, out: 0, claimed: false, last: now, touch };
  }

  /** How much of a scroll delta on the gesture's axis goes past the edge. */
  function overscrollOf(g: Gesture, delta: number): number {
    if (delta === 0) return 0;
    // Coming back from past the edge: that much undoes it first.
    if (g.out !== 0 && Math.sign(delta) !== Math.sign(g.out)) {
      return Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(g.out));
    }
    if (g.out === 0 && g.latched) {
      const [toNeg, toPos] = room(g.latched, g.axis);
      // Still room to scroll: Chromium scrolls it.
      if ((delta > 0 ? toPos : toNeg) > 0.5) return 0;
    }
    if (!g.latched) {
      // Latched to nothing, the gesture can't scroll anything this way. Turned
      // around, it scrolls whatever in the chain could go back.
      const into = g.chain.some((el) => room(el, g.axis)[delta > 0 ? 1 : 0] > 0.5);
      if (into && g.out === 0) return 0;
    }
    return delta;
  }

  function schedule() {
    if (!frame) frame = win.requestAnimationFrame(flush);
  }

  /** Once a frame, after the page's own handlers have seen the events. */
  function flush() {
    frame = 0;
    const g = gesture;
    const events = pending;
    pending = [];
    if (!g) return;
    let sum = 0;
    for (const { event, delta } of events) {
      if (event.defaultPrevented) g.claimed = true;
      if (g.claimed) continue;
      sum += delta;
    }
    if (g.claimed) {
      if (g.out !== 0) release();
      return;
    }
    if (sum === 0) return;
    g.out += sum;
    if (Math.abs(g.out) < 0.01) g.out = 0;
    report(g.axis === 'y' ? { type: 'pull', dx: 0, dy: sum } : { type: 'pull', dx: sum, dy: 0 }, g.surface);
  }

  function release() {
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
    const g = gesture;
    if (!g || g.out === 0) return;
    g.out = 0;
    report({ type: 'release' }, g.surface);
  }

  function armRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      // The page's handlers have had the last events by now.
      flush();
      release();
      // A pause ends the gesture: the next scroll latches afresh.
      if (gesture && !gesture.touch) gesture = null;
    }, RELEASE_MS);
  }

  function track(event: Event, delta: number) {
    const g = gesture;
    if (!g) return;
    const over = overscrollOf(g, delta);
    if (over === 0) return;
    pending.push({ event, delta: Math.sign(over) * Math.min(Math.abs(over), MAX_STEP) });
    schedule();
    if (!g.touch) armRelease();
  }

  function onWheel(event: WheelEvent) {
    // Ctrl+wheel zooms; synthetic wheels aren't the user's.
    if (event.ctrlKey || !event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? win.innerHeight : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    if (dx === 0 && dy === 0) return;
    const now = event.timeStamp;
    if (!gesture || gesture.touch || now - gesture.last > GESTURE_GAP_MS) {
      if (gesture && !gesture.touch) release();
      const axis: Axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      gesture = begin(target, axis, axis === 'y' ? dy : dx, now, false);
      if (!gesture) {
        // Remembered as a gesture that bounces nothing, so the rest of it
        // doesn't latch afresh onto whatever it scrolls past.
        gesture = { surface: target, axis, chain: [], latched: null, out: 0, claimed: true, last: now, touch: false };
        return;
      }
    }
    gesture.last = now;
    if (gesture.claimed) return;
    track(event, gesture.axis === 'y' ? dy : dx);
  }

  function onTouchStart(event: TouchEvent) {
    if (!event.isTrusted) return;
    if (event.touches.length !== 1) {
      // A second finger: a pinch, not a scroll.
      touchStart = null;
      flush();
      release();
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    const target = touch.target instanceof Element ? touch.target : null;
    if (!target) return;
    flush();
    release();
    gesture = null;
    touchStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, target };
  }

  function onTouchMove(event: TouchEvent) {
    const start = touchStart;
    if (!start || !event.isTrusted) return;
    const touch = [...event.touches].find((t) => t.identifier === start.id);
    if (!touch) return;
    // Scroll deltas: the content follows the finger, so it scrolls the other way.
    const dx = start.lastX - touch.clientX;
    const dy = start.lastY - touch.clientY;
    start.lastX = touch.clientX;
    start.lastY = touch.clientY;
    if (!gesture) {
      const mx = touch.clientX - start.x;
      const my = touch.clientY - start.y;
      if (Math.hypot(mx, my) < TOUCH_SLOP) return;
      const axis: Axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      gesture = begin(start.target, axis, axis === 'y' ? -my : -mx, event.timeStamp, true) ?? {
        surface: start.target, axis, chain: [], latched: null, out: 0, claimed: true, last: event.timeStamp, touch: true,
      };
    }
    if (gesture.claimed) return;
    gesture.last = event.timeStamp;
    track(event, gesture.axis === 'y' ? dy : dx);
  }

  function onTouchEnd(event: TouchEvent) {
    if (!touchStart || [...event.touches].some((t) => t.identifier === touchStart?.id)) return;
    touchStart = null;
    flush();
    release();
    gesture = null;
  }

  const passive = { passive: true, capture: true } as const;
  win.addEventListener('wheel', onWheel, passive);
  win.addEventListener('touchstart', onTouchStart, passive);
  win.addEventListener('touchmove', onTouchMove, passive);
  win.addEventListener('touchend', onTouchEnd, passive);
  win.addEventListener('touchcancel', onTouchEnd, passive);
  return () => {
    win.removeEventListener('wheel', onWheel, passive);
    win.removeEventListener('touchstart', onTouchStart, passive);
    win.removeEventListener('touchmove', onTouchMove, passive);
    win.removeEventListener('touchend', onTouchEnd, passive);
    win.removeEventListener('touchcancel', onTouchEnd, passive);
    if (frame) win.cancelAnimationFrame(frame);
    clearTimeout(releaseTimer);
    gesture = null;
  };
}
