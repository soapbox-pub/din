import { useSyncExternalStore } from 'react';
import { onThemeChange } from '@/components/desktop/dinHost/theme';
import type { Rgb } from '@/lib/cursorEffects/sprites';

/**
 * The theme's primary color as RGB, painted to get it whatever form the
 * token takes (hex, hsl(), …); null if it's missing or doesn't parse.
 */
function themePrimary(): Rgb | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!value || !ctx) return null;
  // A fill style that doesn't parse leaves the transparent one in place.
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a ? [r, g, b] : null;
}

// Read again only after the theme may have changed, and kept as the same
// array while the color is, so it can be a dependency.
let primary: Rgb | null = null;
let stale = true;

function subscribe(listener: () => void): () => void {
  // Nothing watched the theme before this: it may have changed meanwhile.
  stale = true;
  return onThemeChange(() => {
    stale = true;
    listener();
  });
}

function snapshot(): Rgb | null {
  if (stale) {
    stale = false;
    const next = themePrimary();
    if (next?.join(',') !== primary?.join(',')) primary = next;
  }
  return primary;
}

const NO_SUBSCRIPTION = () => () => {};
const NONE = () => null;

/** The color cursor effects take on when they match the theme (`enabled`), kept current; else null. */
export function useCursorEffectTint(enabled: boolean): Rgb | null {
  return useSyncExternalStore(enabled ? subscribe : NO_SUBSCRIPTION, enabled ? snapshot : NONE, NONE);
}
