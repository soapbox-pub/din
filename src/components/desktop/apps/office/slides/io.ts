import type { FileFilter } from '@/lib/fileFilters';
import { blobUrl, extOfPath, isOle, isZip, mimeOf, OpcPackage } from '../ooxml';
import { officeThemeXml } from '../theme';
import type { Deck } from './model';
import { DESIGNS, newPackage, type DesignTheme } from './newDeck';
import { readOdp, writeOdp } from './odp';
import { slideFromLayout } from './ops';
import { readDeck } from './read';
import { writeDeck } from './write';

export const OPEN_EXTENSIONS = ['pptx', 'ppsx', 'potx', 'pptm', 'odp', 'otp', 'fodp', 'ppt'];

export const SAVE_TYPES: FileFilter[] = [
  { name: 'PowerPoint Presentation', patterns: ['*.pptx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  { name: 'PowerPoint Show', patterns: ['*.ppsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.slideshow'] },
  { name: 'OpenDocument Presentation', patterns: ['*.odp'], mimeTypes: ['application/vnd.oasis.opendocument.presentation'] },
];

export const SAVE_PPSX = 1;
export const SAVE_ODP = 2;

const ODF_EXTENSIONS = new Set(['odp', 'otp', 'fodp']);

export interface Loaded {
  pkg: OpcPackage;
  deck: Deck;
  /** Things in the file that didn't come across (from an .odp). */
  lost?: string[];
}

export function loadPresentation(bytes: Uint8Array, path = ''): Loaded {
  if (ODF_EXTENSIONS.has(extOfPath(path))) return readOdp(bytes);
  if (isOle(bytes)) {
    throw new Error('It’s a PowerPoint 97–2003 presentation (.ppt), which Slides can’t open. Save it as a PowerPoint Presentation (.pptx) in PowerPoint or LibreOffice, then open that.');
  }
  if (!isZip(bytes)) throw new Error('It isn’t a PowerPoint presentation.');
  const pkg = OpcPackage.read(bytes);
  const deck = readDeck(pkg);
  return { pkg, deck };
}

/** A new presentation with one title slide, as PowerPoint starts one. */
export function newPresentation(design: DesignTheme = DESIGNS[0]): Loaded {
  const pkg = newPackage(design);
  const deck = readDeck(pkg);
  const title = Object.values(deck.layouts).find((l) => l.type === 'title') ?? Object.values(deck.layouts)[0];
  return { pkg, deck: { ...deck, slides: title ? [slideFromLayout(title)] : [] } };
}

export function savePresentation(pkg: OpcPackage, deck: Deck, path: string): Uint8Array {
  const ext = extOfPath(path);
  if (ODF_EXTENSIONS.has(ext)) return writeOdp(pkg, deck, ext);
  const out = writeDeck(pkg, deck, officeThemeXml);
  if (extOfPath(path) !== 'ppsx') return out;
  // A show is the same package with the main part typed as one.
  const show = OpcPackage.read(out);
  show.ensureOverride('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml');
  return show.write();
}

const urls = new WeakMap<OpcPackage, Map<string, string | null>>();
const DRAWABLE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

/** An object URL for a picture in the package (null for ones a browser can't draw, like EMF). */
export function mediaUrl(pkg: OpcPackage, path: string | null): string | null {
  if (!path) return null;
  let m = urls.get(pkg);
  if (!m) urls.set(pkg, (m = new Map()));
  if (m.has(path)) return m.get(path)!;
  const data = pkg.bytes(path);
  const url = data && DRAWABLE.test(path) ? blobUrl(data, mimeOf(path)) : null;
  m.set(path, url);
  return url;
}

/** Copy pictures a shape uses from one package into another. */
export function copyMedia(from: OpcPackage, to: OpcPackage, path: string | null, done: Map<string, string>): string | null {
  if (!path || from === to) return path;
  const hit = done.get(path);
  if (hit) return hit;
  const data = from.bytes(path);
  if (!data) return null;
  const out = to.addMedia('ppt/media', data, extOfPath(path) || 'png');
  done.set(path, out);
  return out;
}
