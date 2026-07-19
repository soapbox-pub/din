/**
 * Typed access to the interface zoom bridge exposed by the Electron preload
 * (`window.zoom`, see electron/preload.cjs).
 *
 * Backed by Chromium's page zoom (`webFrame.setZoomFactor`), which scales the
 * layout viewport itself - like a DPI change - so `window.innerWidth`,
 * viewport units and canvas measurements all stay consistent. CSS `zoom` is
 * deliberately not used as a fallback: it scales rendering without shrinking
 * the layout viewport, which overflows the desktop and breaks anything that
 * measures in pixels (the window manager, xterm's cell sizing). In a plain
 * browser the bridge is absent and users rely on the browser's own zoom.
 */

export interface ZoomBridge {
  /** Set the interface zoom factor (1 = native size). Clamped to 0.5-2. */
  set(factor: number): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    zoom?: ZoomBridge;
  }
}

/** The zoom bridge, or undefined when running outside the Electron shell. */
export function getZoomBridge(): ZoomBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.zoom;
}
