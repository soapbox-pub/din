import { newId, newLayer, type Artboard, type Doc, type ImageEntry, type ImageItem, type Rect } from './model';
import { readLegacyAi } from './legacy';
import { readPdf } from './pdf/read';
import { writePdf } from './pdf/write';
import { renderArea } from './render';
import { readSvg, writeSvg } from './svg';

/**
 * Opening and saving by kind of file. Illustrator files and PDFs share a
 * reader and a writer (a PDF-compatible .ai is a PDF); SVG has its own;
 * pictures open as a placed image on an artboard their size.
 */

export const OPEN_EXTENSIONS = ['.ai', '.ait', '.eps', '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

export const SAVE_TYPES = [
  { name: 'Adobe Illustrator (ai)', patterns: ['*.ai'], mimeTypes: ['application/illustrator'] },
  { name: 'Adobe PDF (pdf)', patterns: ['*.pdf'], mimeTypes: ['application/pdf'] },
  { name: 'SVG (svg)', patterns: ['*.svg'], mimeTypes: ['image/svg+xml'] },
];

export const EXPORT_TYPES = [
  { name: 'PNG (png)', patterns: ['*.png'], mimeTypes: ['image/png'] },
  { name: 'JPEG (jpg)', patterns: ['*.jpg', '*.jpeg'], mimeTypes: ['image/jpeg'] },
  { name: 'SVG (svg)', patterns: ['*.svg'], mimeTypes: ['image/svg+xml'] },
  { name: 'Adobe PDF (pdf)', patterns: ['*.pdf'], mimeTypes: ['application/pdf'] },
];

export const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
/** Formats a document saves to and opens back the same. */
export const isNative = (p: string) => ['ai', 'ait', 'pdf', 'svg'].includes(extOf(p));
export const savesAs = (p: string) => ['ai', 'pdf', 'svg'].includes(extOf(p));
export const exportsAs = (p: string) => ['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(extOf(p));
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
export const isImage = (p: string) => IMAGE.has(extOf(p));

function sniff(bytes: Uint8Array): 'pdf' | 'ps' | 'svg' | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (head.startsWith('%!PS')) return 'ps';
  if (/<svg[\s>]/.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'svg';
  return null;
}

/** An image file as a placed picture, ready to add. */
export async function imageEntry(bytes: Uint8Array, name: string): Promise<ImageEntry> {
  const ext = extOf(name);
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const blob = new Blob([bytes as BlobPart], { type });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error('It isn’t a picture this app can read.');
  }
  const entry: ImageEntry = { width: bmp.width, height: bmp.height, bitmap: bmp };
  // JPEGs keep their bytes; three components unless it says otherwise (SOF's component count).
  if (type === 'image/jpeg') {
    entry.jpeg = bytes;
    entry.jpegComponents = jpegComponents(bytes);
  }
  return entry;
}

function jpegComponents(b: Uint8Array): number {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return b[i + 9];
    i += 2 + len;
  }
  return 3;
}

export function placeImage(doc: Doc, entry: ImageEntry, at: Rect): { doc: Doc; item: ImageItem; key: string } {
  const key = `img${newId()}`;
  doc.res.images.set(key, entry);
  const item: ImageItem = { id: newId(), type: 'image', name: '', opacity: 1, blend: 'normal', image: key, matrix: [at.w, 0, 0, at.h, at.x, at.y] };
  return { doc, item, key };
}

export async function readDoc(bytes: Uint8Array, path: string): Promise<Doc> {
  // A DOS EPS header wraps the PostScript with a preview; skip to the PostScript.
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = v.getUint32(4, true);
    const len = v.getUint32(8, true);
    bytes = bytes.subarray(at, Math.min(bytes.length, at + len));
  }
  const kind = sniff(bytes);
  if (kind === 'pdf') return readPdf(bytes);
  if (kind === 'svg') return readSvg(new TextDecoder().decode(bytes));
  if (kind === 'ps') return readLegacyAi(bytes);
  if (isImage(path)) {
    const entry = await imageEntry(bytes, path);
    const ab: Artboard = { id: newId(), name: 'Artboard 1', x: 0, y: 0, w: entry.width, h: entry.height };
    const doc: Doc = { artboards: [ab], layers: [newLayer('Layer 1', 0)], res: { images: new Map(), fonts: new Map() }, mode: 'rgb', units: 'px', notes: [] };
    const { item } = placeImage(doc, entry, { x: 0, y: 0, w: entry.width, h: entry.height });
    doc.layers[0].children.push(item);
    return doc;
  }
  if (extOf(path) === 'ai') throw new Error('It was saved without PDF compatibility, so only Illustrator can open it.');
  throw new Error('It isn’t a kind of file this app opens.');
}

export interface EncodeOptions {
  /** Export: which artboard (index), or the art's bounds when null. */
  artboard?: number | null;
  /** Export: resolution scale (1 = 72 ppi). */
  scale?: number;
  title: string;
}

export async function encodeDoc(doc: Doc, path: string, opts: EncodeOptions): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const ext = extOf(path);
  if (ext === 'ai' || ext === 'pdf' || ext === 'ait') {
    const r = writePdf(doc, { title: opts.title, artboards: opts.artboard !== undefined && opts.artboard !== null && ext === 'pdf' ? [opts.artboard] : undefined });
    return r;
  }
  const area = opts.artboard !== undefined && opts.artboard !== null ? doc.artboards[opts.artboard] : opts.artboard === null ? null : doc.artboards[0];
  if (ext === 'svg') return { bytes: new TextEncoder().encode(writeSvg(doc, area ?? null)), notes: [] };
  const r = area ?? doc.artboards[0];
  const canvas = renderArea(doc, r, opts.scale ?? 1, ext === 'png' ? null : '#ffffff');
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, ext === 'png' ? 'image/png' : 'image/jpeg', 0.92));
  if (!blob) throw new Error('The picture couldn’t be made.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), notes: [] };
}
