/**
 * Typed access to the OS screenshot bridge exposed by the Electron preload
 * (`window.dinos.screenshot`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by webContents.capturePage() in the main process, which snapshots the
 * shell window's rendered contents - the whole Din desktop. It works on any
 * Linux session (cage/Wayland or bare X11) with no external dependency. In a
 * plain browser the bridge is absent; callers must feature-detect via
 * getScreenshotBridge() and render a fallback.
 */

import { joinPath, type FsBridge } from '@/lib/fs';

export interface Screenshot {
  /** The captured image, PNG-encoded as a `data:` URL. */
  dataUrl: string;
  /** Pixel dimensions of the capture. */
  width: number;
  height: number;
}

/** A window's on-screen rectangle in CSS pixels, relative to the viewport. */
export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotBridge {
  /** Capture the desktop as a PNG. */
  capture(): Promise<Screenshot>;
  /**
   * Capture just one window's on-screen rectangle as a PNG, for the genie
   * minimize/restore animation (see src/components/desktop/Window.tsx). Older
   * shell builds predate this method, so callers must feature-detect it.
   */
  captureRegion?(rect: CaptureRegion): Promise<Screenshot>;
  /**
   * Put a capture on the system clipboard. Older shell builds predate this
   * method; copyScreenshot() falls back to navigator.clipboard.
   */
  copy?(dataUrl: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    screenshot?: ScreenshotBridge;
  }
}

/** The screenshot bridge, or undefined when running outside the Electron shell. */
export function getScreenshotBridge(): ScreenshotBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.screenshot;
}

/**
 * Whether a capture session is in progress: the Screenshot app's (its window
 * minimized, the area-select/countdown overlay up) or a hotkey's (see
 * ScreenshotHost). Desktop hotkeys read this so a Print Screen press
 * mid-session doesn't start a second one. Set by whoever runs the session.
 */
let sessionActive = false;

export function setScreenshotSessionActive(active: boolean): void {
  sessionActive = active;
}

export function isScreenshotSessionActive(): boolean {
  return sessionActive;
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

/** What a Print Screen hotkey asks for: the whole desktop, or a dragged area. */
export type ScreenshotRequest = 'screen' | 'area';

type RequestListener = (request: ScreenshotRequest) => void;
const requestListeners = new Set<RequestListener>();

/**
 * Take a screenshot straight away, without the Screenshot app (the Print
 * Screen hotkeys). Serviced by ScreenshotHost on the desktop.
 */
export function requestScreenshot(request: ScreenshotRequest): void {
  for (const listener of requestListeners) listener(request);
}

export function onScreenshotRequest(listener: RequestListener): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** A rectangle in viewport (CSS pixel) coordinates. */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolve once two animation frames have painted plus a vsync cushion, so the
 * compositor has presented the latest DOM state before capturePage snapshots
 * it (a hidden window or a dismissed overlay must reach the screen first).
 */
export function paintSettled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  });
}

/**
 * Crop a full-desktop capture to the selected region. The selection is in
 * viewport CSS pixels while the capture is in device pixels; the shell
 * window fills the viewport, so the two relate by a plain per-axis scale.
 */
export async function cropCapture(shot: Screenshot, region: ViewportRect): Promise<Screenshot> {
  const sx = shot.width / window.innerWidth;
  const sy = shot.height / window.innerHeight;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const x = clamp(Math.round(region.x * sx), 0, shot.width - 1);
  const y = clamp(Math.round(region.y * sy), 0, shot.height - 1);
  const width = clamp(Math.round(region.width * sx), 1, shot.width - x);
  const height = clamp(Math.round(region.height * sy), 1, shot.height - y);
  if (x === 0 && y === 0 && width === shot.width && height === shot.height) return shot;

  const img = new Image();
  img.src = shot.dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return shot;
  // The image is loaded from a data: URL (same-origin), so the canvas isn't
  // tainted and toDataURL() works.
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/** Put a capture on the clipboard. */
export async function copyScreenshot(shot: Screenshot): Promise<void> {
  const bridge = getScreenshotBridge();
  if (bridge?.copy) {
    await bridge.copy(shot.dataUrl);
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(shot.dataUrl) })]);
}


/**
 * Save a capture into ~/Pictures/Screenshots and resolve to its path. Two
 * captures in the same second get "(2)", "(3)", ... rather than overwriting.
 */
export async function saveScreenshot(fs: FsBridge, shot: Screenshot): Promise<string> {
  const dir = joinPath(joinPath(await fs.homedir(), 'Pictures'), 'Screenshots');
  await fs.mkdir(dir);
  const taken = new Set((await fs.readdir(dir)).entries.map((e) => e.name));
  const base = screenshotFilename().replace(/\.png$/, '');
  let name = `${base}.png`;
  for (let n = 2; taken.has(name); n += 1) name = `${base} (${n}).png`;
  const path = joinPath(dir, name);
  await fs.writeFile(path, dataUrlToBytes(shot.dataUrl));
  return path;
}

let shutterContext: AudioContext | null = null;

/**
 * A camera shutter: two short bursts of band-passed noise, the curtain
 * opening and closing. Synthesized, so there's no sound file to ship.
 */
export function playShutter(): void {
  try {
    shutterContext ??= new AudioContext();
    const ctx = shutterContext;
    void ctx.resume();
    const length = Math.floor(ctx.sampleRate * 0.05);
    const noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.exp((-6 * i) / length);
    }
    const start = ctx.currentTime + 0.01;
    for (const [offset, gain, freq] of [
      [0, 0.5, 3200],
      [0.075, 0.35, 2200],
    ]) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.7;
      const level = ctx.createGain();
      level.gain.value = gain;
      source.connect(filter).connect(level).connect(ctx.destination);
      source.start(start + offset);
    }
  } catch {
    // No audio output; the capture still happened.
  }
}
