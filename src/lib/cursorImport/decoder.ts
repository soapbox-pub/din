/**
 * Chromium's image decoders as the converter's `Decoder`: what the
 * sandboxed converter window (host.ts) and Preview's cursor view use.
 */

import type { Decoder, Rgba } from './image';

/** How long one SVG may take to draw. */
const SVG_TIMEOUT_MS = 5_000;

function pixels(source: CanvasImageSource, width: number, height: number): Rgba {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No canvas');
  context.drawImage(source, 0, 0, width, height);
  return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer) };
}

export const chromiumDecoder: Decoder = {
  async decodePng(data) {
    const bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/png' }), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    try {
      return pixels(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  },

  // Drawn as an image, never as a document: no script in it runs and
  // nothing it refers to is fetched.
  async renderSvg(data, size) {
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(binary)}`;
    let timer = 0;
    try {
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('timeout')), SVG_TIMEOUT_MS);
        }),
      ]);
    } finally {
      window.clearTimeout(timer);
    }
    return pixels(image, size, size);
  },
};
