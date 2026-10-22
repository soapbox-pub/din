import { useEffect } from 'react';
import { useProfileTheme } from '@/hooks/useProfileTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { getColorSchemeBridge } from '@/lib/colorScheme';
import { deriveThemeTokens, isDarkTheme } from '@/lib/profileTheme';

const FONT_SANS_FALLBACK =
  "'Inter Variable', ui-sans-serif, system-ui, sans-serif, " +
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

/**
 * ProfileThemeApplier - applies the logged-in user's active profile theme
 * (kind 16767, Profile Themes NIP) to the entire OS.
 *
 * Colors are written as inline CSS custom properties on <html>, which take
 * precedence over both the `:root` and `.dark` token sets in index.css, so
 * every shadcn semantic token (and thus every window, taskbar, and app)
 * picks up the theme. Fonts are loaded through the FontFace API (no CSS
 * string interpolation) and the theme background is rendered by Wallpaper.
 *
 * All values were sanitized at the parse layer (see src/lib/profileTheme.ts):
 * colors match /^#[0-9a-f]{6}$/, font families are character-allowlisted,
 * and URLs are https-only.
 */
export function ProfileThemeApplier() {
  const theme = useProfileTheme();
  const { config } = useAppContext();
  const configuredTheme = config.theme;

  // Pages (browser tabs, web apps) see the mode the desktop is in. "system"
  // leaves it to Chromium, which is also what useApplyTheme reads it from.
  const scheme = theme ? (isDarkTheme(theme.colors.background) ? 'dark' : 'light') : configuredTheme;
  useEffect(() => {
    getColorSchemeBridge()?.set(scheme);
  }, [scheme]);

  // Apply color tokens.
  useEffect(() => {
    if (!theme) return;

    const root = document.documentElement;
    const dark = isDarkTheme(theme.colors.background);
    const tokens = deriveThemeTokens(theme.colors);

    for (const [property, value] of Object.entries(tokens)) {
      root.style.setProperty(property, value);
    }

    // Keep the light/dark class (used by `dark:` variants) in sync with the
    // theme's actual mode, and hint native UI (form controls, scrollbars).
    root.classList.remove('light', 'dark');
    root.classList.add(dark ? 'dark' : 'light');
    root.style.colorScheme = dark ? 'dark' : 'light';

    return () => {
      for (const property of Object.keys(tokens)) {
        root.style.removeProperty(property);
      }
      root.style.removeProperty('color-scheme');

      // Restore the configured light/dark class (mirrors useApplyTheme).
      const fallback =
        configuredTheme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : configuredTheme;
      root.classList.remove('light', 'dark');
      root.classList.add(fallback);
    };
  }, [theme, configuredTheme]);

  // Load and apply theme fonts.
  useEffect(() => {
    if (!theme) return;

    const root = document.documentElement;
    const loadedFaces: FontFace[] = [];
    let cancelled = false;

    const loadFont = async (font: { family: string; url: string }, apply: () => void) => {
      try {
        // FontFace API avoids interpolating event data into a stylesheet.
        // font.url is https-only and URL-normalized (quotes percent-encoded).
        const face = new FontFace(font.family, `url("${font.url}")`);
        document.fonts.add(face);
        loadedFaces.push(face);
        await face.load();
        // Only swap the font in once it has actually loaded; on failure we
        // gracefully keep the default font per the spec.
        if (!cancelled) apply();
      } catch (error) {
        console.error(`Failed to load theme font "${font.family}":`, error);
      }
    };

    const { body, title } = theme.fonts;

    if (body) {
      loadFont(body, () => {
        const stack = `'${body.family}', ${FONT_SANS_FALLBACK}`;
        root.style.setProperty('--font-sans', stack);
        root.style.fontFamily = stack;
      });
    }

    if (title) {
      // Exposed as a token for display-name styling (e.g. font-[family-name:var(--font-title)]).
      loadFont(title, () => {
        root.style.setProperty('--font-title', `'${title.family}', ${FONT_SANS_FALLBACK}`);
      });
    }

    return () => {
      cancelled = true;
      for (const face of loadedFaces) {
        document.fonts.delete(face);
      }
      root.style.removeProperty('--font-sans');
      root.style.removeProperty('--font-title');
      root.style.removeProperty('font-family');
    };
  }, [theme]);

  return null;
}
