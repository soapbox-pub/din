/**
 * pdf.js, set up once for Din: its worker from the build, what it fetches
 * as it goes (fonts, character maps, decoders) from /pdfjs/ (vite.config.ts),
 * and the library as the global its viewer components look for, which is
 * why this module comes before them in every import list.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

(globalThis as { pdfjsLib?: typeof pdfjs }).pdfjsLib = pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : '/pdfjs/';

/** Open the PDF at `url`. Its scripts never run: nothing here runs them. */
export function openPdf(url: string): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    url,
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
  });
}

export { pdfjs };
