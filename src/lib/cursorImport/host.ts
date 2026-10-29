/**
 * The cursor converter's page: what runs in its sandboxed window
 * (electron/cursorConverter.mts), bundled on its own by
 * scripts/build-cursor-converter.mjs. It takes one job from the window's
 * preload, converts it with Chromium's decoders, and hands back the result.
 */

import { DAMAGED } from './bytes';
import { type ConvertRequest, type ConvertedEffects, type ConvertedTheme, ImportError, convertImport } from './convert';
import { chromiumDecoder } from './decoder';

type Outcome = { ok: true; themes: ConvertedTheme[]; effects: ConvertedEffects[] } | { ok: false; error: string };

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
  convertImport(job, chromiumDecoder).then(
    ({ themes, effects }) => window.cursorConverterHost?.done({ ok: true, themes, effects }),
    (error) => window.cursorConverterHost?.done({ ok: false, error: error instanceof ImportError ? error.message : DAMAGED }),
  );
});
