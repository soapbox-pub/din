/**
 * Typed access to the safe-area bridge exposed by the Electron preload
 * (`window.safeArea`, see electron/preload.cjs).
 *
 * Pages that declare `viewport-fit=cover` in their viewport meta tag are
 * designed to run edge to edge and pad themselves with
 * `env(safe-area-inset-*)`. Din lays such pages out under the window chrome
 * and reports how much of them it covers through those insets. Absent in a
 * plain browser, where the iframe fallback can't set them.
 */

export interface SafeAreaInsets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface SafeAreaBridge {
  set(wcId: number, insets: SafeAreaInsets | null): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    safeArea?: SafeAreaBridge;
  }
}

/** The safe-area bridge, or undefined when running outside the Electron shell. */
export function getSafeAreaBridge(): SafeAreaBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.safeArea;
}

/**
 * Guest-side script (run via `<webview>.executeJavaScript`) that reports
 * whether the page opts into edge-to-edge layout: its viewport meta tag (the
 * last one wins, as in browsers) includes `viewport-fit=cover`.
 */
export const VIEWPORT_FIT_COVER_JS = `(() => {
  const metas = document.querySelectorAll('meta[name="viewport" i]');
  const meta = metas[metas.length - 1];
  return !!meta && /(?:^|[,;\\s])viewport-fit\\s*=\\s*cover(?:$|[,;\\s])/i.test(meta.content);
})()`;
