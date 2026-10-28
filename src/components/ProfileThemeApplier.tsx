import { useEffect } from 'react';
import { usePaintedTheme } from '@/hooks/useDesktopTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { getColorSchemeBridge } from '@/lib/colorScheme';
import { deriveThemeTokens, isDarkTheme } from '@/lib/profileTheme';
import { setThemeFontFaces } from '@/lib/themeFontFaces';

const FONT_SANS_FALLBACK =
  "'Inter Variable', ui-sans-serif, system-ui, sans-serif, " +
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

/**
 * ProfileThemeApplier - applies the desktop's custom theme to the entire OS:
 * the logged-in user's active profile theme (kind 16767, Profile Themes NIP),
 * or the one kept on this computer (see useDesktopTheme), or one being
 * tried on (see themePreview).
 *
 * Colors are written as inline CSS custom properties on <html>, which take
 * precedence over both the `:root` and `.dark` token sets in index.css, so
 * every shadcn semantic token (and thus every window, taskbar, and app)
 * picks up the theme. Fonts are loaded through the FontFace API (no CSS
 * string interpolation) and the theme background is rendered by Wallpaper.
 *
 * All values were sanitized at the parse layer (see src/lib/profileTheme.ts):
 * colors match /^#[0-9a-f]{6}$/, font families are character-allowlisted,
 * and URLs are https-only (a local theme's background may be a local file).
 */
export function ProfileThemeApplier() {
  const theme = usePaintedTheme();
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

  // Load and apply theme fonts, again only when they change: not when a
  // color does, which would flash the default font while they reload.
  const bodyFamily = theme?.fonts.body?.family;
  const bodyUrl = theme?.fonts.body?.url;
  const titleFamily = theme?.fonts.title?.family;
  const titleUrl = theme?.fonts.title?.url;
  useEffect(() => {
    const root = document.documentElement;
    const loadedFaces: FontFace[] = [];
    let cancelled = false;

    setThemeFontFaces([
      ...(bodyFamily && bodyUrl ? [{ family: bodyFamily, url: bodyUrl }] : []),
      ...(titleFamily && titleUrl ? [{ family: titleFamily, url: titleUrl }] : []),
    ]);

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

    if (bodyFamily && bodyUrl) {
      loadFont({ family: bodyFamily, url: bodyUrl }, () => {
        const stack = `'${bodyFamily}', ${FONT_SANS_FALLBACK}`;
        root.style.setProperty('--font-sans', stack);
        root.style.fontFamily = stack;
      });
    }

    if (titleFamily && titleUrl) {
      // Exposed as a token for titles (font-[family-name:var(--font-title)]).
      loadFont({ family: titleFamily, url: titleUrl }, () => {
        root.style.setProperty('--font-title', `'${titleFamily}', ${FONT_SANS_FALLBACK}`);
      });
    }

    return () => {
      cancelled = true;
      setThemeFontFaces([]);
      for (const face of loadedFaces) {
        document.fonts.delete(face);
      }
      root.style.removeProperty('--font-sans');
      root.style.removeProperty('--font-title');
      root.style.removeProperty('font-family');
    };
  }, [bodyFamily, bodyUrl, titleFamily, titleUrl]);

  return null;
}
