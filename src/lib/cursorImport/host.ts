/**
 * The cursor converter's page: what runs in its sandboxed window
 * (electron/cursorConverter.mts), bundled on its own by
 * scripts/build-cursor-converter.mjs. It takes one job from the window's
 * preload, converts it with Chromium's decoders, and hands back the result.
 */

import { DAMAGED } from './bytes';
import { type ConvertRequest, type ConvertedTheme, ImportError, convertCursors } from './convert';
import { chromiumDecoder } from './decoder';

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

window.cursorConverterHost?.onJob((job) => {
  convertCursors(job, chromiumDecoder).then(
    (themes) => window.cursorConverterHost?.done({ ok: true, themes }),
    (error) => window.cursorConverterHost?.done({ ok: false, error: error instanceof ImportError ? error.message : DAMAGED }),
  );
});
