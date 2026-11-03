import { prefersReducedMotion } from '@/shared/reducedMotion';
import type { OverscrollReport } from '@/shared/overscroll';

/**
 * The bounce of content scrolled past its end (src/shared/overscroll.ts says
 * when): it follows the scroll out, ever more stiffly, and springs back when
 * the gesture lets go, as on macOS and iOS. Only a transform moves, so the
 * page doesn't lay out again or hear of it.
 */
export interface OverscrollBounce {
  /** Hear a report from the surface's detector. */
  report(report: OverscrollReport): void;
  /** Put the content back at once and stop. */
  dispose(): void;
}

/** With Reduce motion, the content moves no further than this, in px. */
const REDUCED_MAX = 8;
/** How quickly the content follows a pull, and comes back once let go (rad/s). */
const FOLLOW = 36;
const RETURN = 16;

/**
 * iOS's rubber band: how far content goes for a pull of `distance` px past
 * the edge, in a view `dimension` px long. Close to half at first, never
 * more than the view.
 */
export function rubberBand(distance: number, dimension: number): number {
  if (dimension <= 0) return 0;
  const x = Math.abs(distance);
  return Math.sign(distance) * (1 - 1 / ((x * 0.55) / dimension + 1)) * dimension;
}

export interface OverscrollBounceOptions {
  /** Clipped while the content is out, so it doesn't paint over its neighbours. */
  clip?: HTMLElement | null;
  /** The surface's pixels per reported pixel (a page's own zoom). */
  scale?: () => number;
}

/** Bounce `el` for its surface's overscroll. */
export function createOverscrollBounce(el: HTMLElement, options: OverscrollBounceOptions = {}): OverscrollBounce {
  // How far past the edge the scroll is, in reported px (scroll terms: +y past the bottom).
  const raw = { x: 0, y: 0 };
  // Where the content is drawn, in px, and how fast it's going.
  const pos = { x: 0, y: 0 };
  const vel = { x: 0, y: 0 };
  let pulling = false;
  let frame = 0;
  let last = 0;

  const targetOf = (axis: 'x' | 'y') => {
    const dimension = axis === 'y' ? el.clientHeight : el.clientWidth;
    const scale = options.scale?.() ?? 1;
    // The content moves against the scroll: past the bottom, it rises.
    const target = -rubberBand(raw[axis] * scale, dimension);
    if (!prefersReducedMotion()) return target;
    return Math.max(-REDUCED_MAX, Math.min(REDUCED_MAX, target));
  };

  const apply = () => {
    if (pos.x === 0 && pos.y === 0) {
      el.style.removeProperty('transform');
      options.clip?.style.removeProperty('clip-path');
    } else {
      el.style.transform = `translate3d(${pos.x.toFixed(2)}px, ${pos.y.toFixed(2)}px, 0)`;
      if (options.clip) options.clip.style.clipPath = 'inset(0)';
    }
  };

  const step = (now: number) => {
    frame = 0;
    // A critically damped spring toward the target, in small steps so a
    // slow frame can't overshoot it.
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const omega = pulling ? FOLLOW : RETURN;
    let settled = true;
    for (const axis of ['x', 'y'] as const) {
      const target = targetOf(axis);
      let t = dt;
      while (t > 0) {
        const h = Math.min(t, 0.004);
        const accel = omega * omega * (target - pos[axis]) - 2 * omega * vel[axis];
        vel[axis] += accel * h;
        pos[axis] += vel[axis] * h;
        t -= h;
      }
      if (Math.abs(target - pos[axis]) < 0.25 && Math.abs(vel[axis]) < 4) {
        pos[axis] = target;
        vel[axis] = 0;
      } else {
        settled = false;
      }
    }
    apply();
    // Settled while still pulling, the next report starts it again.
    if (!settled) frame = requestAnimationFrame(step);
  };

  const run = () => {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  };

  return {
    report(report) {
      if (report.type === 'release') {
        pulling = false;
        raw.x = 0;
        raw.y = 0;
        run();
        return;
      }
      pulling = true;
      for (const [axis, delta] of [['x', report.dx], ['y', report.dy]] as const) {
        const next = raw[axis] + delta;
        // Coming back stops at the edge: past it, the page scrolls itself.
        raw[axis] = raw[axis] !== 0 && Math.sign(next) !== Math.sign(raw[axis]) ? 0 : next;
        const dimension = axis === 'y' ? el.clientHeight : el.clientWidth;
        raw[axis] = Math.max(-3 * dimension, Math.min(3 * dimension, raw[axis]));
      }
      run();
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      raw.x = raw.y = pos.x = pos.y = vel.x = vel.y = 0;
      pulling = false;
      apply();
    },
  };
}

/** A report from a guest, checked: it crossed from the page's process. */
export function parseOverscrollReport(value: unknown): OverscrollReport | null {
  if (!value || typeof value !== 'object') return null;
  const { type, dx, dy } = value as { type?: unknown; dx?: unknown; dy?: unknown };
  if (type === 'release') return { type };
  if (type !== 'pull' || typeof dx !== 'number' || typeof dy !== 'number') return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const clamp = (v: number) => Math.max(-500, Math.min(500, v));
  return { type, dx: clamp(dx), dy: clamp(dy) };
}
