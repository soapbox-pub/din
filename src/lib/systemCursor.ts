/**
 * Typed access to the cursor bridge exposed by the Electron preload
 * (`window.cursor`, see electron/preload.cjs + electron/cursor.mts).
 *
 * The pointer's theme and size are the system's (XCursor themes, named in
 * GSettings): they apply to Din's own windows, web pages and native apps
 * alike, and change at once. Din can change them on DinOS; elsewhere they're
 * only shown. In a plain browser the bridge is absent.
 */

export interface SystemCursorTheme {
  /** Directory name, e.g. "Bibata-Modern-Classic". */
  id: string;
  /** Human-readable name, e.g. "Bibata Modern Classic". */
  name: string;
}

export interface SystemCursorStatus {
  /** The current theme's id. */
  theme: string;
  /** The current size, in logical pixels. */
  size: number;
  /** The sizes that can be chosen. */
  sizes: number[];
  /** Whether Din can change the cursor here. */
  canChange: boolean;
}

export interface SystemCursorPreview {
  /** CSS cursor name it stands for, e.g. "pointer". */
  role: string;
  width: number;
  height: number;
  /** Straight RGBA pixels. */
  rgba: Uint8Array;
}

export interface SystemCursorBridge {
  status(): Promise<SystemCursorStatus>;
  themes(): Promise<SystemCursorTheme[]>;
  preview(id: string, size: number): Promise<SystemCursorPreview[]>;
  set(choice: { theme: string; size: number }): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    cursor?: SystemCursorBridge;
  }
}

/** The cursor bridge, or undefined when running outside the Electron shell. */
export function getSystemCursorBridge(): SystemCursorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.cursor;
}

/** A preview as a PNG data URL, for an <img>. */
export function previewToDataUrl(preview: SystemCursorPreview): string {
  const canvas = document.createElement('canvas');
  canvas.width = preview.width;
  canvas.height = preview.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const pixels = new Uint8ClampedArray(preview.width * preview.height * 4);
  pixels.set(preview.rgba);
  ctx.putImageData(new ImageData(pixels, preview.width, preview.height), 0, 0);
  return canvas.toDataURL('image/png');
}
