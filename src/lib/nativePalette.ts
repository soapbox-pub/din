/**
 * The desktop's colors as native apps get them (electron/gtk-theme.mts):
 * its theme tokens, as painted right now, each as `#rrggbb`.
 */

import { isDarkTheme } from '@/lib/profileTheme';

export interface NativePalette {
  dark: boolean;
  window: string;
  windowFg: string;
  view: string;
  viewFg: string;
  headerbar: string;
  headerbarFg: string;
  sidebar: string;
  sidebarFg: string;
  card: string;
  cardFg: string;
  popover: string;
  popoverFg: string;
  accent: string;
  accentFg: string;
  destructive: string;
  destructiveFg: string;
  border: string;
}

/** Din's blue, the accent of the built-in themes (DEFAULT_SELECTION_COLOR, opaque). */
const DEFAULT_ACCENT = '#3b82f6';

/** Each palette color, from the theme token it's painted with. */
const TOKENS: Record<Exclude<keyof NativePalette, 'dark' | 'accent' | 'accentFg'>, string> = {
  window: '--background',
  windowFg: '--foreground',
  view: '--card',
  viewFg: '--card-foreground',
  headerbar: '--card',
  headerbarFg: '--foreground',
  sidebar: '--sidebar',
  sidebarFg: '--sidebar-foreground',
  card: '--card',
  cardFg: '--card-foreground',
  popover: '--popover',
  popoverFg: '--popover-foreground',
  destructive: '--destructive',
  destructiveFg: '--destructive-foreground',
  border: '--border',
};

/** A CSS color as `#rrggbb`, composited over SOLID if it's translucent. */
function toHex(context: CanvasRenderingContext2D, color: string, solid: string): string | null {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = solid;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = '#000';
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white, whichever reads better on BACKGROUND. */
function readableOn(background: string): string {
  return luminance(background) > 0.4 ? '#000000' : '#ffffff';
}

/**
 * The palette ROOT is painted with now, with ACCENT (a custom theme's
 * primary color) or Din's blue for its accent. Null where there's no
 * canvas to resolve colors with (tests).
 */
export function readNativePalette(root: HTMLElement, accent: string | null): NativePalette | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  // Tokens may be any CSS color, or refer to other tokens: a probe resolves
  // them as the page does.
  const probe = document.createElement('span');
  probe.style.display = 'none';
  root.appendChild(probe);
  try {
    const resolve = (token: string, under: string): string | null => {
      probe.style.color = `var(${token})`;
      return toHex(context, getComputedStyle(probe).color, under);
    };
    const background = resolve('--background', '#ffffff');
    if (!background) return null;
    const colors: Partial<NativePalette> = { window: background };
    for (const [key, token] of Object.entries(TOKENS) as [keyof typeof TOKENS, string][]) {
      const color = resolve(token, background);
      if (!color) return null;
      colors[key] = color;
    }
    const accentColor = (accent && toHex(context, accent, background)) || DEFAULT_ACCENT;
    return {
      ...(colors as Omit<NativePalette, 'dark' | 'accent' | 'accentFg'>),
      dark: isDarkTheme(background),
      accent: accentColor,
      accentFg: readableOn(accentColor),
    };
  } finally {
    probe.remove();
  }
}
