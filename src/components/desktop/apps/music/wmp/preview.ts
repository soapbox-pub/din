import { findNode, imageMime, openWmz } from './wms';

/** A WMP skin's first view background, its key color clipped out, for the skin chooser. */
export async function wmpPreview(bytes: Uint8Array): Promise<string | null> {
  const pkg = openWmz(bytes);
  const view = findNode(pkg.theme, 'view');
  const name = view?.attrs.backgroundimage;
  if (!view || !name || name.includes(':')) return null;
  const data = pkg.file(name);
  if (!data) return null;
  const bitmap = await createImageBitmap(new Blob([data.slice()], { type: imageMime(name) }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const key = view.attrs.clippingcolor ?? view.attrs.transparencycolor;
  const m = key ? /^#?([0-9a-f]{6})$/i.exec(key.trim()) : null;
  if (m) {
    const rgb = parseInt(m[1], 16);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      if (((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]) === rgb) img.data[i + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas.toDataURL();
}
