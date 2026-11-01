import type { CaptureRect, StudioAspect, StudioScene } from '@/lib/capture';

/**
 * Where the screen and the camera go on the picture, for each scene and
 * shape. Pure math, shared by the compositor (which draws it), the stage
 * (which lets the camera be dragged) and the take (which writes it down for
 * the Assistant).
 */

export type CameraShape = 'circle' | 'rounded' | 'split';

/** The camera bubble: its center and its size, as fractions of the canvas (size: of its shorter side). */
export interface Bubble {
  cx: number;
  cy: number;
  size: number;
}

export interface Layout {
  scene: StudioScene;
  aspect: StudioAspect;
  shape: CameraShape;
  /** Each shape of picture keeps its own bubble. */
  bubbles: Record<StudioAspect, Bubble>;
}

export interface Size {
  width: number;
  height: number;
}

/** What to draw where, in canvas pixels. */
export interface Frame {
  /** The screen, letterboxed into its area. */
  screen: CaptureRect | null;
  /** The area the screen sits in, filled behind it. */
  screenArea: CaptureRect | null;
  camera: CaptureRect | null;
  /** How the camera's corners are cut: a circle, a radius in pixels, or square. */
  cameraClip: 'circle' | number;
}

export const CANVAS: Record<StudioAspect, Size> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

export const DEFAULT_BUBBLES: Record<StudioAspect, Bubble> = {
  '16:9': { cx: 0.865, cy: 0.79, size: 0.3 },
  '9:16': { cx: 0.74, cy: 0.85, size: 0.4 },
  '1:1': { cx: 0.82, cy: 0.82, size: 0.3 },
};

export const MIN_BUBBLE = 0.12;
export const MAX_BUBBLE = 0.7;

/** `inner` scaled to fit inside `area`, centered. */
function contain(inner: Size, area: CaptureRect): CaptureRect {
  const scale = Math.min(area.width / inner.width, area.height / inner.height);
  const width = inner.width * scale;
  const height = inner.height * scale;
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height };
}

/** The bubble's square on the canvas, kept inside it with a margin. */
export function bubbleRect(bubble: Bubble, canvas: Size): CaptureRect {
  const short = Math.min(canvas.width, canvas.height);
  const d = Math.min(MAX_BUBBLE, Math.max(MIN_BUBBLE, bubble.size)) * short;
  const margin = short * 0.025;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const x = clamp(bubble.cx * canvas.width - d / 2, margin, canvas.width - margin - d);
  const y = clamp(bubble.cy * canvas.height - d / 2, margin, canvas.height - margin - d);
  return { x, y, width: d, height: d };
}

/**
 * The frame for a layout, given what's on: the screen's size (cropped to
 * the display) and whether the camera is. A scene missing what it needs
 * shows what there is.
 */
export function frameFor(layout: Layout, screen: Size | null, camera: boolean): Frame {
  const canvas = CANVAS[layout.aspect];
  const full: CaptureRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const wantsScreen = layout.scene !== 'camera' && screen !== null;
  const wantsCamera = layout.scene !== 'screen' && camera;

  if (!wantsScreen) return { screen: null, screenArea: null, camera: wantsCamera ? full : null, cameraClip: 0 };
  if (!wantsCamera) return { screen: contain(screen, full), screenArea: full, camera: null, cameraClip: 0 };

  if (layout.shape === 'split') {
    if (layout.aspect === '16:9') {
      // The camera as a column on the right.
      const column = Math.round(canvas.width * 0.3);
      const area = { x: 0, y: 0, width: canvas.width - column, height: canvas.height };
      return { screen: contain(screen, area), screenArea: area, camera: { x: area.width, y: 0, width: column, height: canvas.height }, cameraClip: 0 };
    }
    // The screen across the top, the camera filling what's below it.
    const top = Math.min(canvas.height * 0.62, (canvas.width * screen.height) / screen.width);
    const area = { x: 0, y: 0, width: canvas.width, height: top };
    return { screen: contain(screen, area), screenArea: area, camera: { x: 0, y: top, width: canvas.width, height: canvas.height - top }, cameraClip: 0 };
  }

  const camRect = bubbleRect(layout.bubbles[layout.aspect], canvas);
  return {
    screen: contain(screen, full),
    screenArea: full,
    camera: camRect,
    cameraClip: layout.shape === 'circle' ? 'circle' : camRect.width * 0.18,
  };
}

/** A rect as fractions of the canvas, for take.json. */
export function asFraction(rect: CaptureRect | null, canvas: Size): CaptureRect | null {
  if (!rect) return null;
  return { x: rect.x / canvas.width, y: rect.y / canvas.height, width: rect.width / canvas.width, height: rect.height / canvas.height };
}
