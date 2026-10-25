import { getFsBridge } from '@/lib/fs';
import { fromBase64, propEl } from './idml';
import { decodeTiff } from './tiff';

/**
 * Pictures for placed graphics, looked up once and kept: embedded data in
 * the IDML, else the linked file (by its path, or beside the document or in
 * its Links folder, as InDesign looks), else InDesign's own preview from the
 * INDD, else nothing (the frame shows the gray placeholder with an X).
 */

export type ImageSource = 'embedded' | 'linked' | 'preview' | 'missing' | 'unsupported';

export interface ImageEntry {
  state: 'loading' | 'ready' | 'failed';
  source: ImageSource;
  image: ImageBitmap | null;
  width: number;
  height: number;
  /** The file it was read from, for linked graphics. */
  path: string | null;
}

/** A link's URI as a path on this computer. */
export function linkPath(uri: string | null): string | null {
  if (!uri || uri === '$ID/') return null;
  let s = uri;
  if (s.startsWith('file:')) s = s.slice(5);
  try {
    s = decodeURIComponent(s);
  } catch {
    // Keep it as written.
  }
  if (/^\/\/+/.test(s)) s = s.replace(/^\/+/, '/');
  return s;
}

const basename = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

function sniff(b: Uint8Array): 'jpeg' | 'png' | 'gif' | 'tiff' | 'webp' | 'bmp' | 'psd' | 'pdf' | 'eps' | 'svg' | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42)) return 'tiff';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[0] === 0x38 && b[1] === 0x42) return 'psd';
  if (b[0] === 0x25 && b[1] === 0x50) return 'pdf';
  if ((b[0] === 0x25 && b[1] === 0x21) || (b[0] === 0xc5 && b[1] === 0xd0)) return 'eps';
  if (b[0] === 0x3c) return 'svg';
  return null;
}

export async function decodeBytes(b: Uint8Array): Promise<ImageBitmap> {
  const kind = sniff(b);
  if (kind === 'tiff') return createImageBitmap(decodeTiff(b));
  if (kind === 'eps') {
    // A DOS EPS may carry a TIFF preview.
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b[0] === 0xc5 && v.getUint32(20, true) && v.getUint32(24, true)) {
      const at = v.getUint32(20, true);
      return createImageBitmap(decodeTiff(b.subarray(at, at + v.getUint32(24, true))));
    }
    throw new Error('EPS');
  }
  if (kind === 'pdf' || kind === 'psd' || kind === null) throw new Error(kind ?? 'unknown');
  const mime = kind === 'svg' ? 'image/svg+xml' : `image/${kind}`;
  return createImageBitmap(new Blob([b as BlobPart], { type: mime }));
}

export class ImageStore {
  private entries = new Map<string, ImageEntry>();
  constructor(
    private onChange: () => void,
    /** InDesign's previews by graphic Self, from an INDD. */
    private previews: Map<string, Uint8Array>,
    private docDir: string | null,
  ) {}

  /** The picture for a graphic element, starting to load it the first time. */
  get(self: string, el: Element | null, link: string | null): ImageEntry {
    const key = `${self}\u0000${link ?? ''}`;
    const hit = this.entries.get(key);
    if (hit) return hit;
    const entry: ImageEntry = { state: 'loading', source: 'missing', image: null, width: 0, height: 0, path: null };
    this.entries.set(key, entry);
    void this.load(entry, self, el, link);
    return entry;
  }

  peek(self: string, link: string | null): ImageEntry | undefined {
    return this.entries.get(`${self}\u0000${link ?? ''}`);
  }

  private async load(entry: ImageEntry, self: string, el: Element | null, link: string | null) {
    const done = (bmp: ImageBitmap | null, source: ImageSource, path: string | null = null) => {
      entry.image = bmp;
      entry.width = bmp?.width ?? 0;
      entry.height = bmp?.height ?? 0;
      entry.source = source;
      entry.path = path;
      entry.state = bmp ? 'ready' : 'failed';
      this.onChange();
    };
    // Embedded.
    const contents = el ? propEl(el, 'Contents') : null;
    if (contents?.textContent) {
      try {
        done(await decodeBytes(fromBase64(contents.textContent)), 'embedded');
        return;
      } catch {
        // Fall through to the preview.
      }
    }
    // Linked.
    const p = linkPath(link);
    const fs = getFsBridge();
    if (p && fs) {
      const name = basename(p);
      const tries = [p, ...(this.docDir ? [`${this.docDir}/Links/${name}`, `${this.docDir}/${name}`] : [])].filter((x) => x.startsWith('/'));
      for (const t of tries) {
        try {
          const r = await fs.readFile(t, 256 * 1024 * 1024);
          if (r.truncated) continue;
          done(await decodeBytes(r.data), 'linked', t);
          return;
        } catch {
          // Try the next place.
        }
      }
    }
    const prev = this.previews.get(self);
    if (prev) {
      try {
        done(await decodeBytes(prev), 'preview');
        return;
      } catch {
        // No picture then.
      }
    }
    done(null, contents ? 'unsupported' : 'missing');
  }

  /** Forget a graphic (after relinking or embedding). */
  drop(self: string) {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${self}\u0000`)) this.entries.delete(k);
  }
}
