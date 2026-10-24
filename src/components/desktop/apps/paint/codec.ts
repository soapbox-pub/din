import { Surface } from './raster';

/** Pictures bigger than this on a side aren't opened: they'd crawl. */
export const MAX_SIDE = 8192;

export const SAVE_TYPES = [
  { name: 'PNG (keeps see-through parts)', patterns: ['*.png'], mimeTypes: ['image/png'] },
  { name: 'JPEG', patterns: ['*.jpg', '*.jpeg'], mimeTypes: ['image/jpeg'] },
  { name: '24-bit Bitmap', patterns: ['*.bmp'], mimeTypes: ['image/bmp'] },
  { name: 'WebP', patterns: ['*.webp'], mimeTypes: ['image/webp'] },
];

export const OPEN_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.avif', '.ico', '.svg'];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

const ext = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Whether Paint saves this kind of file itself (otherwise it adds .png). */
export function savesAs(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'bmp', 'webp'].includes(ext(path));
}

/** Decode an image file's bytes. */
export async function decode(bytes: Uint8Array, path: string): Promise<Surface> {
  const blob = new Blob([bytes as BlobPart], { type: MIME[ext(path)] ?? '' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth || 300;
    const height = img.naturalHeight || 150;
    if (width > MAX_SIDE || height > MAX_SIDE) {
      throw new Error(`It’s too big for Paint (${width} × ${height}; up to ${MAX_SIDE} on a side).`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, width, height);
    return new Surface(width, height, ctx.getImageData(0, 0, width, height));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('It’s')) throw error;
    throw new Error('It doesn’t look like a picture Paint can open.', { cause: error });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function toCanvas(s: Surface, flattenOn?: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = s.width;
  canvas.height = s.height;
  const ctx = canvas.getContext('2d')!;
  if (flattenOn) {
    const tmp = document.createElement('canvas');
    tmp.width = s.width;
    tmp.height = s.height;
    tmp.getContext('2d')!.putImageData(s.image, 0, 0);
    ctx.fillStyle = flattenOn;
    ctx.fillRect(0, 0, s.width, s.height);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(s.image, 0, 0);
  }
  return canvas;
}

function blobOf(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture couldn’t be encoded.'))), type, quality),
  );
}

/** A 24-bit Windows bitmap, the format Paint was born with. */
function bmp(s: Surface): Uint8Array {
  const rowSize = Math.ceil((s.width * 3) / 4) * 4;
  const size = 54 + rowSize * s.height;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, s.width, true);
  view.setInt32(22, s.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, rowSize * s.height, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  const d = s.image.data;
  for (let y = 0; y < s.height; y++) {
    let o = 54 + (s.height - 1 - y) * rowSize;
    for (let x = 0; x < s.width; x++) {
      const i = (y * s.width + x) * 4;
      // See-through pixels come out white.
      const a = d[i + 3] / 255;
      bytes[o++] = Math.round(d[i + 2] * a + 255 * (1 - a));
      bytes[o++] = Math.round(d[i + 1] * a + 255 * (1 - a));
      bytes[o++] = Math.round(d[i] * a + 255 * (1 - a));
    }
  }
  return bytes;
}

/** Encode for saving, by the file's extension. */
export async function encode(s: Surface, path: string): Promise<Uint8Array> {
  const e = ext(path);
  if (e === 'bmp') return bmp(s);
  const blob =
    e === 'jpg' || e === 'jpeg'
      ? await blobOf(toCanvas(s, '#ffffff'), 'image/jpeg', 0.92)
      : e === 'webp'
        ? await blobOf(toCanvas(s), 'image/webp', 0.95)
        : await blobOf(toCanvas(s), 'image/png');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function pngBlob(s: Surface): Promise<Blob> {
  return blobOf(toCanvas(s), 'image/png');
}
