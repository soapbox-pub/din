/**
 * Shared logic for OverdriveSlider (src/components/ui/overdrive-slider.tsx)
 * and its read-only meter: ranges that can be pushed past their ends, the
 * detent at each edge, and the knock and jolt animations.
 */

/** How far the extra range reaches past the track, as a fraction of its width. */
export const REACH = 0.3;

/** How long after a knock at the edge the next key press goes through. */
export const KNOCK_MS = 1000;

export type OverdriveVariant = 'warn' | 'broken';

// Prototype: localStorage['din:overdrive-variant'] = 'broken' picks that look everywhere.
export function defaultVariant(): OverdriveVariant {
  try {
    return localStorage.getItem('din:overdrive-variant') === 'broken' ? 'broken' : 'warn';
  } catch {
    return 'warn';
  }
}

export interface OverdriveRange {
  /** The normal range. */
  min: number;
  max: number;
  /** How far past max it can be pushed, if at all. */
  overMax?: number;
  /** How far under min it can be pushed, if at all. */
  underMin?: number;
}

/**
 * Step a value by `delta`, with a detent at each edge that has extra range
 * past it: a step that would cross the edge stops on it, and the first step
 * from the edge only knocks. Another step within KNOCK_MS goes through.
 * `knock` holds when the last knock happened. Keep in step with the media
 * keys' copy in electron/main.mts.
 */
export function stepWithDetent(
  current: number,
  delta: number,
  range: OverdriveRange,
  knock: { at: number },
  now = Date.now(),
): { value: number; knocked: boolean } {
  const { min, max, overMax, underMin } = range;
  const next = current + delta;
  const edge = delta > 0 ? (overMax === undefined ? null : max) : underMin === undefined ? null : min;
  if (edge !== null) {
    const crossing = delta > 0 ? current < edge && next > edge : current > edge && next < edge;
    if (crossing) return { value: edge, knocked: false };
    if (current === edge && now - knock.at > KNOCK_MS) {
      knock.at = now;
      return { value: current, knocked: true };
    }
  }
  return { value: Math.max(underMin ?? min, Math.min(overMax ?? max, next)), knocked: false };
}

/**
 * Where a value sits along the track, as a fraction of its width: 0-1 in the
 * normal range, past 1 (up to 1 + REACH) or under 0 in the extra range.
 */
export function position(value: number, { min, max, overMax, underMin }: OverdriveRange): number {
  if (overMax !== undefined && value > max) return 1 + ((value - max) / (overMax - max)) * REACH;
  if (underMin !== undefined && value < min) return -((min - value) / (min - underMin)) * REACH;
  return (Math.max(min, Math.min(max, value)) - min) / (max - min);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** A small bump toward `direction` (1 = right), for a knock at the edge. */
export function knockAnimation(element: HTMLElement | null, direction: 1 | -1): void {
  if (!element || prefersReducedMotion()) return;
  element.animate(
    [
      { transform: 'translateX(0)' },
      { transform: `translateX(${direction * 3}px)` },
      { transform: 'translateX(0)' },
    ],
    { duration: 160, easing: 'ease-out' },
  );
}

/** A short shake, for the moment the broken look gives way. */
export function joltAnimation(element: HTMLElement | null): void {
  if (!element || prefersReducedMotion()) return;
  element.animate(
    [
      { transform: 'translate(0, 0)' },
      { transform: 'translate(2px, -1px)' },
      { transform: 'translate(-2px, 1px)' },
      { transform: 'translate(1px, 0)' },
      { transform: 'translate(0, 0)' },
    ],
    { duration: 200, easing: 'ease-out' },
  );
}
