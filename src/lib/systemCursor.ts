/**
 * Typed access to the cursor bridge exposed by the Electron preload
 * (`window.dinos.cursor`, see electron/preload.cjs + electron/cursor.mts).
 *
 * The pointer's theme and size are the system's (XCursor themes, named in
 * GSettings): they apply to Din's own windows, web pages and native apps
 * alike, and change at once. Din can change them on DinOS, and import
 * themes from other formats as XCursor ones; elsewhere they're only shown.
 * In a plain browser the bridge is absent.
 */

export interface SystemCursorTheme {
  /** Directory name, e.g. "Bibata-Modern-Classic". */
  id: string;
  /** Human-readable name, e.g. "Bibata Modern Classic". */
  name: string;
  /** Whether Din imported it, and so can remove it. */
  imported: boolean;
}

export interface SystemCursorStatus {
  /** The current theme's id. */
  theme: string;
  /** The current size, in logical pixels. */
  size: number;
  /** The sizes that can be chosen. */
  sizes: number[];
  /** Whether the theme has one size only, whatever size is asked for. */
  fixedSize: boolean;
  /** Whether Din can change the cursor here. */
  canChange: boolean;
}

export interface SystemCursorPreview {
  /** CSS cursor name it stands for, e.g. "pointer". */
  role: string;
  width: number;
  height: number;
  /** The point that lands on the pointer's position. */
  hotX: number;
  hotY: number;
  /** Straight RGBA pixels. */
  rgba: Uint8Array;
}

/** An animation of an effect package, played once where the pointer is. */
export interface EffectSpriteInfo {
  /** One frame's size. */
  width: number;
  height: number;
  /** The point in a frame that lands on the pointer. */
  hotX: number;
  hotY: number;
  frameCount: number;
  /** The frames in the order they play, each with how long it shows, in ms. */
  steps: { index: number; delay: number }[];
}

export interface EffectSprite extends EffectSpriteInfo {
  /** Straight RGBA, the frames side by side. */
  pixels: Uint8Array;
}

/**
 * The on-click effects and trail that came in a CursorFX file. An effect's
 * event is CursorFX's (src/lib/cursorImport/effects.ts); a trail is laid
 * `rate` times a second while the pointer moves, when `mode` says.
 */
export interface CursorEffectPackageInfo {
  id: string;
  name: string;
  effects: (EffectSpriteInfo & { event: number })[];
  trail: (EffectSpriteInfo & { mode: 'always' | 'down' | 'up'; rate: number }) | null;
}

export interface CursorEffectPackage extends CursorEffectPackageInfo {
  effects: (EffectSprite & { event: number })[];
  trail: (EffectSprite & { mode: 'always' | 'down' | 'up'; rate: number }) | null;
}

export interface SystemCursorBridge {
  status(): Promise<SystemCursorStatus>;
  themes(): Promise<SystemCursorTheme[]>;
  preview(id: string, size: number): Promise<SystemCursorPreview[]>;
  set(choice: { theme: string; size: number }): Promise<void>;
  /**
   * Import the themes and effect packages in a file or folder (absolute
   * path) and use the first theme; resolves with their ids.
   */
  importTheme(source: string): Promise<{ themes: string[]; effects: string[] }>;
  /** Delete a theme Din imported. */
  removeTheme(id: string): Promise<void>;
  /** The imported effect packages, without their pixels. */
  effects(): Promise<CursorEffectPackageInfo[]>;
  /** One effect package with its pixels, or null if it's gone. */
  effect(id: string): Promise<CursorEffectPackage | null>;
  /** Delete an effect package. */
  removeEffect(id: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    cursor?: SystemCursorBridge;
  }
}

/** The cursor bridge, or undefined when running outside the Electron shell. */
export function getSystemCursorBridge(): SystemCursorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.cursor;
}

/** An import's error, without Electron's "Error invoking remote method" prefix. */
export function cleanCursorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
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
