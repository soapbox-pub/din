import { cssColor, parseColor, SkinImages } from './images';
import { prepareView, themeViews } from './prepare';
import type { VmNode } from './protocol';
import { openWmz } from './wms';

const num = (v: string | undefined): number | null => (v !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null);

/**
 * A picture of a WMP skin's first view as it looks at rest, for the skin
 * chooser: backgrounds, buttons and sliders drawn where the skin puts them,
 * without running its script (so anything placed by script is left out,
 * and so is anything hidden at load).
 */
export async function wmpPreview(bytes: Uint8Array): Promise<string | null> {
  const pkg = openWmz(bytes);
  const view = themeViews(pkg.theme)[0];
  if (!view) return null;
  const images = await SkinImages.load(pkg, pkg.names().filter((n) => /\.(bmp|png|jpe?g|gif)$/i.test(n)));
  const root = prepareView(view);
  const rootImg = images.get(root.attrs.backgroundimage);
  const width = num(root.attrs.width) ?? rootImg?.w ?? 0;
  const height = num(root.attrs.height) ?? rootImg?.h ?? 0;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  /** Draw an image with its transparency color (and clipping color, if any) cut out. */
  const drawImage = (name: string | undefined, key: string | undefined, x: number, y: number, clipKey?: string) => {
    const src = name ? images.keyed(name, key) : null;
    if (!src) return;
    const cut = clipKey !== undefined ? images.mask(name, clipKey) : null;
    if (!cut) {
      ctx.drawImage(src, x, y);
      return;
    }
    const layer = document.createElement('canvas');
    layer.width = src.width;
    layer.height = src.height;
    const lctx = layer.getContext('2d')!;
    lctx.drawImage(src, 0, 0);
    const px = lctx.getImageData(0, 0, layer.width, layer.height);
    for (let p = 0; p < cut.length; p++) if (!cut[p]) px.data[p * 4 + 3] = 0;
    lctx.putImageData(px, 0, 0);
    ctx.drawImage(layer, x, y);
  };

  const drawGroup = (node: VmNode, x: number, y: number) => {
    const map = images.get(node.attrs.mappingimage);
    const art = images.get(node.attrs.image);
    if (!map || !art) return;
    const colors = new Set(
      node.children.flatMap((c) => {
        const rgb = parseColor(c.attrs.mappingcolor);
        return rgb && rgb !== 'auto' ? [(rgb[0] << 16) | (rgb[1] << 8) | rgb[2]] : [];
      }),
    );
    const show = /^true$/i.test(node.attrs.showbackground ?? '');
    const key = images.key(node.attrs.image, node.attrs.transparencycolor);
    const out = ctx.createImageData(Math.min(map.w, art.w), Math.min(map.h, art.h));
    for (let py = 0; py < out.height; py++) {
      for (let px = 0; px < out.width; px++) {
        const m = (py * map.w + px) * 4;
        const a = (py * art.w + px) * 4;
        if (!show && !colors.has((map.data[m] << 16) | (map.data[m + 1] << 8) | map.data[m + 2])) continue;
        if (key && art.data[a] === key[0] && art.data[a + 1] === key[1] && art.data[a + 2] === key[2]) continue;
        out.data.set(art.data.subarray(a, a + 4), (py * out.width + px) * 4);
      }
    }
    const layer = document.createElement('canvas');
    layer.width = out.width;
    layer.height = out.height;
    layer.getContext('2d')!.putImageData(out, 0, 0);
    ctx.drawImage(layer, x, y);
  };

  const draw = (node: VmNode, ox: number, oy: number, isRoot: boolean) => {
    const a = node.attrs;
    if (/^false$/i.test(a.visible ?? '')) return;
    const left = isRoot ? 0 : num(a.left);
    const top = isRoot ? 0 : num(a.top);
    // Placed by script: where is anyone's guess until it runs.
    if (left === null || top === null) return;
    const x = ox + left;
    const y = oy + top;
    const container = node.tag === 'view' || node.tag === 'subview';
    if (container) {
      const img = images.get(a.backgroundimage);
      const w = num(a.width) ?? img?.w;
      const h = num(a.height) ?? img?.h;
      ctx.save();
      if (w && h) {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }
      const children = node.children.map((c, i) => ({ c, i, z: num(c.attrs.zindex) ?? 0 })).sort((p, q) => p.z - q.z || p.i - q.i);
      for (const { c } of children) if (c.attrs.zindex && Number(c.attrs.zindex) < 0) draw(c, x, y, false);
      const color = isRoot ? undefined : cssColor(a.backgroundcolor);
      if (color && w && h) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
      }
      drawImage(a.backgroundimage, a.transparencycolor ?? a.clippingcolor, x, y, a.transparencycolor !== undefined ? a.clippingcolor : undefined);
      for (const { c } of children) if (!(c.attrs.zindex && Number(c.attrs.zindex) < 0)) draw(c, x, y, false);
      ctx.restore();
      return;
    }
    switch (node.tag) {
      case 'button':
        drawImage(a.image, a.transparencycolor, x, y);
        break;
      case 'buttongroup':
        drawGroup(node, x, y);
        break;
      case 'slider':
      case 'progressbar': {
        drawImage(a.backgroundimage, a.transparencycolor, x, y);
        const thumb = images.get(a.thumbimage);
        const track = images.get(a.backgroundimage);
        if (thumb && track) {
          const vertical = /^vertical$/i.test(a.direction ?? '');
          const border = num(a.bordersize) ?? 0;
          drawImage(
            a.thumbimage,
            a.transparencycolor,
            vertical ? x + (track.w - thumb.w) / 2 : x + border - thumb.w / 2,
            vertical ? y + track.h - border - thumb.h / 2 : y + (track.h - thumb.h) / 2,
          );
        }
        break;
      }
      case 'customslider': {
        const frame = images.get(a.positionimage);
        const strip = images.keyed(a.image, a.transparencycolor);
        if (frame && strip) ctx.drawImage(strip, 0, 0, frame.w, frame.h, x, y, frame.w, frame.h);
        break;
      }
    }
  };
  draw(root, 0, 0, true);

  // Trim the empty margin around shaped skins.
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL();
}
