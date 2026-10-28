/**
 * The cursor converter's page: what runs in its sandboxed window
 * (electron/cursorConverter.mts), bundled on its own by
 * scripts/build-cursor-converter.mjs. It takes one job from the window's
 * preload, converts it with Chromium's decoders, and hands back the result.
 */

import { DAMAGED } from './bytes';
import { type ConvertRequest, type ConvertedTheme, type Decoder, type Rgba, ImportError, convertCursors } from './convert';

type Outcome = { ok: true; themes: ConvertedTheme[] } | { ok: false; error: string };

declare global {
  interface Window {
    /** From electron/cursor-converter-preload.cjs. */
    cursorConverterHost?: {
      onJob(callback: (job: ConvertRequest) => void): void;
      done(outcome: Outcome): void;
    };
  }
}

/** How long one SVG may take to draw. */
const SVG_TIMEOUT_MS = 5_000;

function pixels(source: CanvasImageSource, width: number, height: number): Rgba {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No canvas');
  context.drawImage(source, 0, 0, width, height);
  return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer) };
}

const decoder: Decoder = {
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

window.cursorConverterHost?.onJob((job) => {
  convertCursors(job, decoder).then(
    (themes) => window.cursorConverterHost?.done({ ok: true, themes }),
    (error) => window.cursorConverterHost?.done({ ok: false, error: error instanceof ImportError ? error.message : DAMAGED }),
  );
});
