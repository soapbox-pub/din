/**
 * Typed access to the color scheme bridge exposed by the Electron preload
 * (`window.theme`, see electron/preload.cjs).
 *
 * Sets Chromium's own light/dark mode (`nativeTheme.themeSource`), which is
 * what `prefers-color-scheme` reports in every page: browser tabs, installed
 * web apps, and the shell itself. Absent in a plain browser, where the host
 * OS decides.
 */

export interface ColorSchemeBridge {
  set(source: 'light' | 'dark' | 'system'): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    theme?: ColorSchemeBridge;
  }
}

/** The color scheme bridge, or undefined when running outside the Electron shell. */
export function getColorSchemeBridge(): ColorSchemeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.theme;
}
