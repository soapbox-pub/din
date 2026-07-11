import { useEffect } from 'react';
import { useProfileTheme } from '@/hooks/useProfileTheme';
import { contrastForeground, relativeLuminance, type ProfileTheme } from '@/lib/profileTheme';

const FONT_SANS_FALLBACK =
  "'Inter Variable', ui-sans-serif, system-ui, sans-serif, " +
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

/**
 * Build the full shadcn token set from the theme's three colors
 * (background / text / primary), deriving intermediate surfaces with
 * color-mix so the palette works for both light and dark themes.
 */
function buildCssTokens(theme: ProfileTheme): Record<string, string> {
  const { background: bg, text: fg, primary } = theme.colors;
  const primaryForeground = contrastForeground(primary);
  const mix = (base: string, tint: string, basePercent: number) =>
    `color-mix(in srgb, ${base} ${basePercent}%, ${tint})`;

  const surface = mix(bg, fg, 96); // cards, popovers
  const subtle = mix(bg, fg, 88); // secondary, muted, accent
  const line = mix(bg, fg, 84); // borders, inputs

  return {
    '--background': bg,
    '--foreground': fg,
    '--card': surface,
    '--card-foreground': fg,
    '--popover': surface,
    '--popover-foreground': fg,
    '--primary': primary,
    '--primary-foreground': primaryForeground,
    '--secondary': subtle,
    '--secondary-foreground': fg,
    '--muted': subtle,
    '--muted-foreground': mix(fg, bg, 65),
    '--accent': subtle,
    '--accent-foreground': fg,
    '--border': line,
    '--input': line,
    '--ring': primary,
    '--sidebar': surface,
    '--sidebar-foreground': fg,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': subtle,
    '--sidebar-accent-foreground': fg,
    '--sidebar-border': line,
    '--sidebar-ring': primary,
  };
}

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

  // Apply color tokens.
  useEffect(() => {
    if (!theme) return;

    const root = document.documentElement;
    const tokens = buildCssTokens(theme);

    for (const [property, value] of Object.entries(tokens)) {
      root.style.setProperty(property, value);
    }

    // Hint native UI (form controls, scrollbars) toward the theme's mode.
    root.style.colorScheme = relativeLuminance(theme.colors.background) < 0.4 ? 'dark' : 'light';

    return () => {
      for (const property of Object.keys(tokens)) {
        root.style.removeProperty(property);
      }
      root.style.removeProperty('color-scheme');
    };
  }, [theme]);

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
