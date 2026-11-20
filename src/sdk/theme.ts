/**
 * Styling an app from the desktop's theme, as the app's own choice:
 * window.din only reports the theme (din.theme), and never writes to the
 * page. These write it the way Din's stylesheet (src/index.css, app.css)
 * expects, onto the root or any element the app gives them; startApp
 * calls followTheme, and an app with its own styles can ignore them and
 * read din.theme itself.
 */
import type { Din, ThemeSnapshot, Unsubscribe } from '@/sdk/din';

const loadedFaces = new Set<string>();

/**
 * Write a theme onto an element: every token as a `--` custom property, the
 * `light` or `dark` class, `--din-color-scheme` (app.css gives it to the
 * body, so the root's canvas stays transparent), the theme's sans font, and
 * a profile theme's web fonts loaded into the document.
 */
export function applyTheme(theme: ThemeSnapshot, root: HTMLElement = document.documentElement): void {
  root.classList.remove('light', 'dark');
  root.classList.add(theme.scheme);
  root.style.setProperty('--din-color-scheme', theme.scheme);
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
  if (theme.tokens['font-sans']) root.style.fontFamily = theme.tokens['font-sans'];
  for (const face of theme.fontFaces) {
    const key = `${face.family}\u0000${face.url}`;
    if (loadedFaces.has(key) || !/^https:\/\//.test(face.url)) continue;
    loadedFaces.add(key);
    const font = new FontFace(face.family, `url("${face.url}")`);
    document.fonts.add(font);
    void font.load().catch(() => {});
  }
}

/**
 * Settings → Accessibility reach the app as the web's media features (set
 * on each app by electron/accessibility.mts); Din's stylesheet keys its
 * rules for them to root attributes, as the desktop's own root has them.
 */
export function markAccessibility(root: HTMLElement = document.documentElement): Unsubscribe {
  const offs: (() => void)[] = [];
  for (const [query, attribute] of [
    ['(prefers-reduced-motion: reduce)', 'data-reduce-motion'],
    ['(prefers-reduced-transparency: reduce)', 'data-reduce-transparency'],
    ['(prefers-contrast: more)', 'data-increase-contrast'],
  ]) {
    const media = matchMedia(query);
    const mark = () => root.toggleAttribute(attribute, media.matches);
    mark();
    media.addEventListener('change', mark);
    offs.push(() => media.removeEventListener('change', mark));
  }
  return () => offs.forEach((off) => off());
}

/** Apply the theme now and on every change, with the accessibility marks; returns a stop. */
export function followTheme(din: Din, root: HTMLElement = document.documentElement): Unsubscribe {
  applyTheme(din.theme.current, root);
  const offTheme = din.theme.onChange((theme) => applyTheme(theme, root));
  const offMarks = markAccessibility(root);
  return () => {
    offTheme();
    offMarks();
  };
}
