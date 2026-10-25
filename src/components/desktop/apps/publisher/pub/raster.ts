import { drawMetafile } from '@/lib/metafile';
import type { PubImage } from './doc';
import type { Raster } from './toIdml';

/** Pixels per point metafiles are drawn at: sharp at 200% zoom. */
const SCALE = 2;
const MAX = 3000;

/** A WMF or EMF picture drawn to a PNG the size of the frame it's in. */
export async function rasterizeMetafile(img: PubImage, w: number, h: number): Promise<Raster | null> {
  if (img.kind !== 'wmf' && img.kind !== 'emf') return null;
  const k = Math.min(SCALE, MAX / Math.max(w, h, 1));
  const pw = Math.max(1, Math.round(w * k));
  const ph = Math.max(1, Math.round(h * k));
  const canvas = new OffscreenCanvas(pw, ph);
  const c = canvas.getContext('2d');
  if (!c) return null;
  drawMetafile(c, img.data, pw, ph);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { png: new Uint8Array(await blob.arrayBuffer()), width: pw, height: ph };
}
