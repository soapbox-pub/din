/**
 * Typed access to the eyedropper bridge exposed by the Electron preload
 * (`window.dinos.eyeDropper`, see electron/preload.cjs + electron/eyedropper.mts).
 *
 * A web page's `new EyeDropper().open()` arrives as a pick. `EyeDropperHost`
 * freezes the screen, lets the user click a color on it, and answers with
 * that color, or null when they cancel. A pick the page aborts (or leaves,
 * navigating or closing) arrives here as a cancel.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent, so callers
 * feature-detect via `getEyeDropperBridge()`.
 */

export interface EyeDropperRequest {
  requestId: number;
  /** The requesting page's origin (e.g. `https://www.canva.com`). */
  origin: string;
}

export interface EyeDropperBridge {
  onPick(callback: (request: EyeDropperRequest) => void): () => void;
  onCancel(callback: (requestId: number) => void): () => void;
  /** A color like `#1a2b3c`, or null for cancelled; `unavailable` when the screen couldn't be captured. */
  choose(response: { requestId: number; color: string | null; unavailable?: boolean }): void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    eyeDropper?: EyeDropperBridge;
  }
}

/** The eyedropper bridge, or undefined when running outside the shell. */
export function getEyeDropperBridge(): EyeDropperBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.eyeDropper;
}

/** `#rrggbb` for an 8-bit RGB triple. */
export function hexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
