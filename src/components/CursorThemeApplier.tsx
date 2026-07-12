import { useEffect } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import { cursorThemeToCss } from '@/lib/cursorTheme';

const STYLE_ELEMENT_ID = 'custom-cursor-theme';

/**
 * CursorThemeApplier - applies the user's selected custom cursor theme
 * (e.g. a `.CurXPTheme`) to the entire OS.
 *
 * The parsed theme (see {@link cursorThemeToCss}) is compiled to a stylesheet
 * of `cursor: url(dataURI) hotX hotY, fallback` rules and injected as a single
 * managed `<style>` element in `<head>`. The `custom-cursor` class on `<html>`
 * scopes every rule, so removing the theme is just a matter of dropping the
 * class and stylesheet — no per-element cleanup required.
 *
 * Cursor frames are PNG data URLs produced at parse time on a canvas, so no
 * event-sourced or remote strings ever reach the DOM here.
 */
export function CursorThemeApplier() {
  const { config } = useAppContext();
  const cursorTheme = config.customCursor;

  useEffect(() => {
    const root = document.documentElement;

    if (!cursorTheme) {
      root.classList.remove('custom-cursor');
      document.getElementById(STYLE_ELEMENT_ID)?.remove();
      return;
    }

    let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }
    style.textContent = cursorThemeToCss(cursorTheme);
    root.classList.add('custom-cursor');

    return () => {
      root.classList.remove('custom-cursor');
      document.getElementById(STYLE_ELEMENT_ID)?.remove();
    };
  }, [cursorTheme]);

  return null;
}
