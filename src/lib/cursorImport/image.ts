/**
 * Pixels: the images the formats hold, made into cursor frames.
 *
 * Decoding PNG and drawing SVG is left to a `Decoder` (Chromium's, in the
 * converter's sandboxed window), but nothing reaches it before its size is
 * known from the image's own header and charged to the budget. Everything
 * else (cropping, trimming, scaling, pixel formats) is plain code here.
 *
 * Frames are kept as XCursor wants them: premultiplied alpha, one
 * little-endian ARGB word per pixel, which in memory is BGRA.
 */

import { Budget, DAMAGED, ImportError, LIMITS, TOO_BIG, startsWith, u32be } from './bytes';

/** Decoded pixels, straight (not premultiplied) RGBA. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Pixels as a cursor frame keeps them: premultiplied BGRA. */
export interface Bitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** One frame of a cursor, at one nominal size. */
export interface Frame extends Bitmap {
  /** The size a theme user asks for to get this image. */
  size: number;
  hotX: number;
  hotY: number;
  /** Milliseconds until the next frame; 0 when not animated. */
  delay: number;
}

/** What turns encoded images into pixels; Chromium's in the converter. */
export interface Decoder {
  /** A PNG's pixels. Only called once its header has been checked. */
  decodePng(data: Uint8Array): Promise<Rgba>;
  /** An SVG drawn into a `size` × `size` square. */
  renderSvg(data: Uint8Array, size: number): Promise<Rgba>;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(data: Uint8Array): boolean {
  return startsWith(data, PNG_SIGNATURE);
}

/** A PNG's size, from its IHDR chunk. */
export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (!isPng(data) || u32be(data, 12) !== 0x49484452) throw new ImportError(DAMAGED);
  return { width: u32be(data, 16), height: u32be(data, 20) };
}

/** Largest SVG source the converter will draw. */
const MAX_SVG_BYTES = 1024 * 1024;

/** Decode a PNG, once its size is known to be within limits. */
export async function decodePng(decoder: Decoder, budget: Budget, data: Uint8Array): Promise<Bitmap> {
  const { width, height } = pngSize(data);
  budget.image(width, height);
  let image: Rgba;
  try {
    image = await decoder.decodePng(data);
  } catch {
    throw new ImportError(DAMAGED);
  }
  return fromRgba(checked(image, width, height));
}

/** Draw an SVG at `size` × `size`. */
export async function renderSvg(decoder: Decoder, budget: Budget, data: Uint8Array, size: number): Promise<Bitmap> {
  if (data.length > MAX_SVG_BYTES) throw new ImportError(TOO_BIG);
  budget.image(size, size);
  let image: Rgba;
  try {
    image = await decoder.renderSvg(data, size);
  } catch {
    throw new ImportError(DAMAGED);
  }
  return fromRgba(checked(image, size, size));
}

function checked(image: Rgba, width: number, height: number): Rgba {
  if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) {
    throw new ImportError(DAMAGED);
  }
  return image;
}

/** Straight RGBA to premultiplied BGRA. */
export function fromRgba({ width, height, data }: Rgba): Bitmap {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = data[i + 3];
    pixels[i] = Math.round((data[i + 2] * a) / 255);
    pixels[i + 1] = Math.round((data[i + 1] * a) / 255);
    pixels[i + 2] = Math.round((data[i] * a) / 255);
    pixels[i + 3] = a;
  }
  return { width, height, pixels };
}

/** Straight BGRA (as Windows and CursorFX keep it), premultiplied in place. */
export function premultiplyBgra(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a === 255) continue;
    pixels[i] = Math.round((pixels[i] * a) / 255);
    pixels[i + 1] = Math.round((pixels[i + 1] * a) / 255);
    pixels[i + 2] = Math.round((pixels[i + 2] * a) / 255);
  }
  return pixels;
}

/** A rectangle of `image`; parts outside it are transparent. */
export function crop(image: Bitmap, x: number, y: number, width: number, height: number): Bitmap {
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    const from = Math.max(0, x);
    const to = Math.min(image.width, x + width);
    if (to <= from) continue;
    pixels.set(image.pixels.subarray((sy * image.width + from) * 4, (sy * image.width + to) * 4), (row * width + from - x) * 4);
  }
  return { width, height, pixels };
}

/** Frames of equal size laid side by side (`horizontal`) or stacked. */
export function splitStrip(image: Bitmap, count: number, horizontal: boolean): Bitmap[] {
  const width = horizontal ? Math.floor(image.width / count) : image.width;
  const height = horizontal ? image.height : Math.floor(image.height / count);
  if (count < 1 || width < 1 || height < 1) throw new ImportError(DAMAGED);
  return Array.from({ length: count }, (_, i) =>
    crop(image, horizontal ? i * width : 0, horizontal ? 0 : i * height, width, height),
  );
}

/**
 * The smallest box holding every opaque pixel of all `frames` (same size)
 * and the hotspot, so transparent margins can go.
 */
export function contentBox(frames: Bitmap[], hotX: number, hotY: number): { x: number; y: number; width: number; height: number } {
  let left = hotX;
  let top = hotY;
  let right = hotX + 1;
  let bottom = hotY + 1;
  for (const { width, height, pixels } of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] === 0) continue;
        if (x < left) left = x;
        if (x >= right) right = x + 1;
        if (y < top) top = y;
        if (y >= bottom) bottom = y + 1;
      }
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `image` scaled to `width` × `height`, by averaging the area each pixel covers. */
export function scale(image: Bitmap, width: number, height: number): Bitmap {
  if (width === image.width && height === image.height) return image;
  const pixels = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = Math.min(image.height, y0 + Math.max(1, sy));
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = Math.min(image.width, x0 + Math.max(1, sx));
      const sum = [0, 0, 0, 0];
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        if (wy <= 0) continue;
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const wx = Math.min(px + 1, x1) - Math.max(px, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (py * image.width + px) * 4;
          sum[0] += image.pixels[o] * w;
          sum[1] += image.pixels[o + 1] * w;
          sum[2] += image.pixels[o + 2] * w;
          sum[3] += image.pixels[o + 3] * w;
          area += w;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) pixels[o + c] = area ? Math.round(sum[c] / area) : 0;
    }
  }
  return { width, height, pixels };
}

/**
 * `image` scaled so its larger side is at most `limit`, keeping its aspect;
 * returns the factor used too, for the hotspot.
 */
export function fitWithin(image: Bitmap, limit: number): { image: Bitmap; factor: number } {
  const factor = Math.min(1, limit / Math.max(image.width, image.height));
  if (factor === 1) return { image, factor };
  return {
    image: scale(image, Math.max(1, Math.round(image.width * factor)), Math.max(1, Math.round(image.height * factor))),
    factor,
  };
}

/** A frame of `image`, kept within the frame limit, its hotspot inside it. */
export function makeFrame(
  budget: Budget,
  image: Bitmap,
  options: { size: number; hotX: number; hotY: number; delay: number },
): Frame {
  const { image: fitted, factor } = fitWithin(image, LIMITS.frameDimension);
  budget.frame(fitted.pixels.length);
  const clampHot = (n: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(n * factor)));
  return {
    ...fitted,
    size: Math.min(LIMITS.frameDimension, Math.max(1, Math.round(options.size * factor))),
    hotX: clampHot(options.hotX, fitted.width),
    hotY: clampHot(options.hotY, fitted.height),
    delay: options.delay,
  };
}
