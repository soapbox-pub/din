import { useSyncExternalStore } from 'react';

/**
 * Whether to keep motion to what's needed: the system prefers reduced
 * motion, or Settings → Accessibility asks for it, which the desktop marks
 * on its root (src/lib/accessibility.ts) and the SDK on an app's, from the
 * theme. Use this rather than matching `prefers-reduced-motion` alone, which
 * misses Din's own setting; Tailwind's `motion-safe:` and `motion-reduce:`
 * already follow both (src/index.css).
 */

const QUERY = '(prefers-reduced-motion: reduce)';

/** The root attribute Din's Reduce motion setting puts on the document. */
export const REDUCE_MOTION_ATTRIBUTE = 'data-reduce-motion';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE) || (window.matchMedia?.(QUERY).matches ?? false);
}

/** Hear when prefersReducedMotion() may have changed. */
export function onReducedMotionChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia?.(QUERY);
  media?.addEventListener('change', listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [REDUCE_MOTION_ATTRIBUTE] });
  return () => {
    media?.removeEventListener('change', listener);
    observer.disconnect();
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion, () => false);
}
