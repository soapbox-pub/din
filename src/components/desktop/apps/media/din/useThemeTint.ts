import { useSyncExternalStore } from 'react';
import { isDarkThemeColor, normalizeThemeColor } from '@/lib/themeColor';

/** Windows Media Player's blue, for themes whose primary color is a gray. */
const WMP_BLUE = '#1f7ae0';

let ctx: CanvasRenderingContext2D | null = null;

/** The theme's --primary as #rrggbb, if it's a color rather than a gray. */
function readPrimary(): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  if (!raw) return null;
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = raw;
  const hex = normalizeThemeColor(String(ctx.fillStyle));
  if (!hex) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return s >= 0.3 && l >= 0.2 && l <= 0.8 ? hex : null;
}

let current: string | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    current = readPrimary();
    // Profile themes set the tokens on <html>; dark mode toggles its class.
    observer = new MutationObserver(() => {
      const next = readPrimary();
      if (next === current) return;
      current = next;
      listeners.forEach((l) => l());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

const snapshot = () => (observer ? current : readPrimary());

/**
 * CSS variables tinting Din's skin: the theme's primary color when it has
 * one (a profile theme's), WMP blue otherwise, or the hue the user chose.
 */
export function useTintVars(hue: number | null): Record<string, string> {
  const primary = useSyncExternalStore(subscribe, snapshot);
  if (hue !== null) return { '--mp-tint': `hsl(${hue} 80% 48%)`, '--mp-on-tint': '#fff' };
  const tint = primary ?? WMP_BLUE;
  return { '--mp-tint': tint, '--mp-on-tint': isDarkThemeColor(tint) ? '#fff' : '#000' };
}
