/**
 * Parsing and classification for page-reported theme colors — the
 * `<meta name="theme-color">` value Electron surfaces through the webview's
 * `did-change-theme-color` event (Safari uses the same tag to tint its
 * window chrome).
 *
 * These values originate inside untrusted web pages, so they are strictly
 * parsed and re-emitted in a canonical `#rrggbb` form before ever touching a
 * style. Never interpolate the raw reported string into CSS.
 */

/**
 * Strictly parse an untrusted color string into canonical lowercase
 * `#rrggbb`. Accepts hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and
 * `rgb()`/`rgba()` notation; alpha is discarded (window chrome is opaque).
 * Returns `null` for anything else.
 */
export function normalizeThemeColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = input.trim();

  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    if (hex.length <= 4) {
      const [r, g, b] = hex;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return `#${hex.slice(0, 6)}`.toLowerCase();
  }

  const fn = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+%?\s*)?\)$/i,
  );
  if (fn) {
    const channels = fn.slice(1, 4).map((n) => Math.min(255, Number(n)));
    return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }

  return null;
}

/**
 * The opacity an untrusted color string asks for (0–1), from the same forms
 * normalizeThemeColor accepts: `#rgba`, `#rrggbbaa` or `rgba()`'s fourth
 * channel (a number or a percentage). 1 for an opaque color or anything
 * that doesn't parse.
 */
export function themeColorAlpha(input: string | null | undefined): number {
  if (!input || normalizeThemeColor(input) === null) return 1;
  const value = input.trim();
  const hex = value.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/i)?.[1];
  if (hex) return parseInt(hex.length === 4 ? hex[3] + hex[3] : hex.slice(6), 16) / 255;
  const fn = value.match(/^rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/i);
  if (fn) {
    const a = Number(fn[1]) / (fn[2] ? 100 : 1);
    return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
  }
  return 1;
}

/** WCAG 2.1 relative luminance of a normalized `#rrggbb` color (0–1). */
export function themeColorLuminance(color: string): number {
  const channel = (i: number) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Whether a normalized `#rrggbb` color is "dark" — i.e. it should carry white
 * text rather than black.
 *
 * White wins whenever it still reaches 3:1 (WCAG's floor for large text and
 * UI), not only past the ~0.179 crossover where the contrast ratios of black
 * and white swap. Maximizing the raw ratio mishandles saturated mid-tones:
 * Soapbox's `#0482d8` sits at luminance 0.21, so black scores higher (5.2:1
 * against white's 4.1:1) while reading as an unmistakably dark blue — black
 * text on it looks broken. The perceptual midpoint (0.5) goes too far the
 * other way: bright greens like `#20b634` (0.34) get white text at 2.7:1.
 */
export function isDarkThemeColor(color: string): boolean {
  return 1.05 / (themeColorLuminance(color) + 0.05) >= 3;
}

/**
 * Theme tokens re-pointed for content sitting on tinted chrome (a window's
 * title bar, or the menu bar matching it), which is styled with theme
 * tokens that can't guarantee contrast against an arbitrary color. The
 * `background` an active tab sits on pushes further from the text color —
 * darker under white text, lighter under black — so it only ever gains
 * contrast.
 */
export function themeColorTokens(color: string): Record<string, string> {
  const dark = isDarkThemeColor(color);
  return {
    '--foreground': dark ? '#ffffff' : '#000000',
    '--muted-foreground': dark ? 'rgb(255 255 255 / 0.8)' : 'rgb(0 0 0 / 0.7)',
    '--border': dark ? 'rgb(255 255 255 / 0.2)' : 'rgb(0 0 0 / 0.15)',
    '--background': dark ? 'rgb(0 0 0 / 0.25)' : 'rgb(255 255 255 / 0.5)',
    // What the root derives from the theme (src/index.css) keeps the root's
    // values unless it's re-pointed here too.
    '--raised': dark ? 'rgb(0 0 0 / 0.25)' : 'rgb(255 255 255 / 0.5)',
    '--secondary': dark ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.06)',
    '--ink-accent': dark ? '#ffffff' : '#000000',
    '--selected': dark ? 'rgb(255 255 255 / 0.18)' : 'rgb(0 0 0 / 0.08)',
    '--success': dark ? 'hsl(152 70% 72%)' : 'hsl(152 75% 22%)',
    '--warning': dark ? 'hsl(40 95% 72%)' : 'hsl(30 95% 28%)',
  };
}

/** The token names themeColorTokens re-points. */
const TINTED = ['foreground', 'muted-foreground', 'border', 'background', 'raised', 'secondary', 'ink-accent', 'selected', 'success', 'warning'];

/**
 * For what floats over tinted chrome in Din's own glass (a list under the
 * address bar): `untintedSource` on an untinted ancestor keeps the theme's
 * tokens under other names, and `untintedTokens` on the floating thing puts
 * them back, so its text matches its glass rather than the page's color.
 */
export const untintedSource: Record<string, string> = Object.fromEntries(TINTED.map((t) => [`--untinted-${t}`, `var(--${t})`]));
export const untintedTokens: Record<string, string> = Object.fromEntries(TINTED.map((t) => [`--${t}`, `var(--untinted-${t})`]));
