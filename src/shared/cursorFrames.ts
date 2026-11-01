import type { Frame } from '@/lib/cursorImport/image';

/** Cursor frames for showing and trying on, in a page. */

/** A frame (premultiplied BGRA) as a PNG data URL. */
export function frameUrl(frame: Frame): string {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  const p = frame.pixels;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = p[i + 3];
    if (!a) continue;
    rgba[i] = (p[i + 2] * 255) / a;
    rgba[i + 1] = (p[i + 1] * 255) / a;
    rgba[i + 2] = (p[i] * 255) / a;
    rgba[i + 3] = a;
  }
  context.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** The frames at the nominal size nearest `size`. */
export function framesNear(frames: Frame[], size: number): Frame[] {
  const sizes = [...new Set(frames.map((f) => f.size))];
  const best = sizes.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
  return frames.filter((f) => f.size === best);
}
