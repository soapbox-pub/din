import '@fontsource/carlito/400.css';
import '@fontsource/carlito/400-italic.css';
import '@fontsource/carlito/700.css';
import '@fontsource/carlito/700-italic.css';
import '@fontsource/caladea/400.css';
import '@fontsource/caladea/400-italic.css';
import '@fontsource/caladea/700.css';
import '@fontsource/caladea/700-italic.css';
import '@fontsource/arimo/400.css';
import '@fontsource/arimo/400-italic.css';
import '@fontsource/arimo/700.css';
import '@fontsource/arimo/700-italic.css';
import '@fontsource/tinos/400.css';
import '@fontsource/tinos/400-italic.css';
import '@fontsource/tinos/700.css';
import '@fontsource/tinos/700-italic.css';
import '@fontsource/cousine/400.css';
import '@fontsource/cousine/400-italic.css';
import '@fontsource/cousine/700.css';
import '@fontsource/cousine/700-italic.css';

/**
 * Office's fonts aren't on Din, so documents name them and Din draws them
 * with free fonts built to the same measurements (Carlito is Calibri's
 * width, Arimo Arial's, Tinos Times New Roman's...): lines break where they
 * do in Office, and files keep the font they had.
 */
const SUBSTITUTES: Record<string, string> = {
  calibri: 'Carlito',
  'calibri light': 'Carlito',
  aptos: 'Carlito',
  'aptos display': 'Carlito',
  'aptos narrow': 'Carlito',
  candara: 'Carlito',
  corbel: 'Carlito',
  'segoe ui': 'Inter Variable',
  'segoe ui light': 'Inter Variable',
  'segoe ui semibold': 'Inter Variable',
  cambria: 'Caladea',
  'cambria math': 'Caladea',
  constantia: 'Caladea',
  arial: 'Arimo',
  'arial narrow': 'Arimo',
  'arial black': 'Arimo',
  helvetica: 'Arimo',
  'helvetica neue': 'Arimo',
  'liberation sans': 'Arimo',
  tahoma: 'DejaVu Sans',
  verdana: 'DejaVu Sans',
  'trebuchet ms': 'Arimo',
  'century gothic': 'Arimo',
  'gill sans mt': 'Arimo',
  'franklin gothic book': 'Arimo',
  'times new roman': 'Tinos',
  times: 'Tinos',
  'liberation serif': 'Tinos',
  georgia: 'Tinos',
  garamond: 'Tinos',
  'book antiqua': 'Tinos',
  'palatino linotype': 'Tinos',
  'courier new': 'Cousine',
  courier: 'Cousine',
  consolas: 'Cousine',
  'lucida console': 'Cousine',
  'liberation mono': 'Cousine',
};

const SERIF = /serif|times|roman|georgia|garamond|cambria|caladea|tinos|book|palatino|constantia|baskerville/i;
const MONO = /mono|courier|consolas|cousine|console|code/i;

/** A CSS font-family list for an Office font name. */
export function fontStack(name: string | null | undefined): string {
  // Names come from documents and end up in stylesheets: keep only what font names are made of.
  const n = (name ?? '').replace(/[^\p{L}\p{N} \-_.&+]/gu, '').trim();
  if (!n) return '"Carlito", sans-serif';
  const sub = SUBSTITUTES[n.toLowerCase()];
  const generic = MONO.test(n) ? 'monospace' : SERIF.test(n) && !/sans/i.test(n) ? 'serif' : 'sans-serif';
  return [`"${n}"`, sub && `"${sub}"`, generic].filter(Boolean).join(', ');
}

/** The fonts the font box lists, alphabetically, as Office does. */
export const FONT_CHOICES = [
  'Aptos',
  'Arial',
  'Arial Black',
  'Book Antiqua',
  'Calibri',
  'Calibri Light',
  'Cambria',
  'Consolas',
  'Courier New',
  'DejaVu Sans',
  'Garamond',
  'Georgia',
  'Helvetica',
  'Inter',
  'Noto Sans',
  'Noto Serif',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
];

/** The sizes in the font size box. */
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

/** The next size up or down the list, as Grow Font and Shrink Font step. */
export function stepFontSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return FONT_SIZES.find((s) => s > size) ?? Math.min(1638, Math.round(size + 10));
  return [...FONT_SIZES].reverse().find((s) => s < size) ?? Math.max(1, size - 1);
}
