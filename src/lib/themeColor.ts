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
 * Whether a normalized `#rrggbb` color is "dark" — i.e. white text reads
 * better on it than black. Compares WCAG contrast ratios against both,
 * which resolves to a relative-luminance threshold of ~0.179.
 */
export function isDarkThemeColor(color: string): boolean {
  const channel = (i: number) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance < 0.179;
}
