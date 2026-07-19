/**
 * Typed access to the OS screenshot bridge exposed by the Electron preload
 * (`window.screenshot`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by webContents.capturePage() in the main process, which snapshots the
 * shell window's rendered contents - the whole Din desktop. It works on any
 * Linux session (cage/Wayland or bare X11) with no external dependency. In a
 * plain browser the bridge is absent; callers must feature-detect via
 * getScreenshotBridge() and render a fallback.
 */

export interface Screenshot {
  /** The captured image, PNG-encoded as a `data:` URL. */
  dataUrl: string;
  /** Pixel dimensions of the capture. */
  width: number;
  height: number;
}

export interface ScreenshotBridge {
  /** Capture the desktop as a PNG. */
  capture(): Promise<Screenshot>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    screenshot?: ScreenshotBridge;
  }
}

/** The screenshot bridge, or undefined when running outside the Electron shell. */
export function getScreenshotBridge(): ScreenshotBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.screenshot;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanScreenshotError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/**
 * A timestamped default filename for a saved capture, e.g.
 * "Screenshot 2026-07-18 at 14.32.05.png" (macOS-style, filesystem-safe).
 */
export function screenshotFilename(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const time = `${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  return `Screenshot ${day} at ${time}.png`;
}

/**
 * Decode a base64 `data:` URL into raw bytes.
 *
 * Deliberately does NOT use `fetch(dataUrl)`: the app's CSP `connect-src` does
 * not allow the `data:` scheme, so fetching a data URL throws. Decoding the
 * base64 payload directly avoids the network layer entirely.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Decode a PNG `data:` URL into a Blob (e.g. for the clipboard). */
export function dataUrlToBlob(dataUrl: string): Blob {
  return new Blob([dataUrlToBytes(dataUrl)], { type: 'image/png' });
}
