import { imageMime, type WmzPackage } from './wms';

/**
 * A WMP skin's images, decoded once with exact colors (no color management,
 * no premultiplication), because skins key on exact pixel values: color keys
 * make pixels transparent, mapping images say which button a pixel belongs
 * to, and position images' grays give custom sliders their values.
 */

export type Rgb = [number, number, number];

export interface SkinImage {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  canvas: HTMLCanvasElement;
}

let colorCtx: CanvasRenderingContext2D | null = null;

/**
 * A skin color: `#RRGGBB`, `RRGGBB`, or one of the named colors; `auto`
 * for "the image's top-left pixel"; null for none.
 */
export function parseColor(value: unknown): Rgb | 'auto' | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return null;
  if (v === 'auto') return 'auto';
  const hex = /^#?([0-9a-f]{6})$/.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx || !/^[a-z]+$/.test(v)) return null;
  colorCtx.fillStyle = '#010203';
  colorCtx.fillStyle = v;
  const norm = String(colorCtx.fillStyle);
  if (norm === '#010203') return null;
  const m = /^#([0-9a-f]{6})$/.exec(norm);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A CSS color for a skin color attribute, or undefined for none. */
export function cssColor(value: unknown): string | undefined {
  const c = parseColor(value);
  return c && c !== 'auto' ? `rgb(${c[0]},${c[1]},${c[2]})` : undefined;
}

const baseName = (name: string) => name.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

export class SkinImages {
  private images = new Map<string, SkinImage>();
  private urls = new Map<string, string>();
  private masks = new Map<string, Uint8Array>();
  private regions = new Map<string, string | null>();

  static async load(pkg: WmzPackage, names: string[]): Promise<SkinImages> {
    const store = new SkinImages();
    await Promise.all(
      names.map(async (name) => {
        const data = pkg.file(name);
        if (!data) return;
        try {
          const bitmap = await createImageBitmap(new Blob([data.slice()], { type: imageMime(name) }), {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          });
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          store.images.set(baseName(name), {
            w: canvas.width,
            h: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas,
          });
        } catch {
          // Undecodable: drawn as nothing.
        }
      }),
    );
    return store;
  }

  get(name: unknown): SkinImage | undefined {
    return typeof name === 'string' && name ? this.images.get(baseName(name)) : undefined;
  }

  sizes(): Record<string, { w: number; h: number }> {
    const out: Record<string, { w: number; h: number }> = {};
    for (const [k, v] of this.images) out[k] = { w: v.w, h: v.h };
    return out;
  }

  pixel(name: unknown, x: number, y: number): Rgb | null {
    const img = this.get(name);
    if (!img || x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
    const i = (Math.floor(y) * img.w + Math.floor(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  }

  /** The key color resolved for an image ('auto' = its top-left pixel). */
  key(name: unknown, color: unknown): Rgb | null {
    const c = parseColor(color);
    if (c === 'auto') return this.pixel(name, 0, 0);
    return c;
  }

  /** Which pixels survive a color key (1) and which it removes (0). */
  mask(name: unknown, color: unknown): Uint8Array | null {
    const img = this.get(name);
    if (!img) return null;
    const key = this.key(name, color);
    const id = `${baseName(String(name))}|${key?.join(',') ?? ''}`;
    let mask = this.masks.get(id);
    if (!mask) {
      mask = new Uint8Array(img.w * img.h);
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        mask[p] = img.data[i + 3] > 0 && !(key && img.data[i] === key[0] && img.data[i + 1] === key[1] && img.data[i + 2] === key[2]) ? 1 : 0;
      }
      this.masks.set(id, mask);
    }
    return mask;
  }

  /** A URL for an image with its key color made transparent. */
  url(name: unknown, color?: unknown): string | null {
    const img = this.get(name);
    if (!img) return null;
    const key = color === undefined ? null : this.key(name, color);
    const id = `${baseName(String(name))}|${key?.join(',') ?? ''}`;
    let url = this.urls.get(id);
    if (!url) {
      if (!key) url = img.canvas.toDataURL();
      else {
        const canvas = document.createElement('canvas');
        canvas.width = img.w;
        canvas.height = img.h;
        const ctx = canvas.getContext('2d')!;
        const out = ctx.createImageData(img.w, img.h);
        out.data.set(img.data);
        const mask = this.mask(name, color)!;
        for (let p = 0; p < mask.length; p++) if (!mask[p]) out.data[p * 4 + 3] = 0;
        ctx.putImageData(out, 0, 0);
        url = canvas.toDataURL();
      }
      this.urls.set(id, url);
    }
    return url;
  }

  /**
   * A CSS clip-path for the shape a color key leaves (a window region, as
   * Windows built them: a union of rectangles), or null when nothing is
   * cut away. Clip paths shape hit testing too, so clicks in the cut-away
   * parts reach whatever is behind.
   */
  region(name: unknown, color: unknown, width?: number, height?: number): string | null {
    const img = this.get(name);
    if (!img) return null;
    const key = this.key(name, color);
    const id = `${baseName(String(name))}|${key?.join(',') ?? ''}|${width ?? ''}x${height ?? ''}`;
    if (this.regions.has(id)) return this.regions.get(id)!;
    const mask = this.mask(name, color)!;
    const w = Math.min(img.w, width ?? img.w);
    const h = Math.min(img.h, height ?? img.h);
    let cut = false;
    const rects: string[] = [];
    let open = new Map<string, { y: number; x0: number; x1: number }>();
    const close = (r: { y: number; x0: number; x1: number }, y: number) => rects.push(`M${r.x0} ${r.y}H${r.x1}V${y}H${r.x0}Z`);
    for (let y = 0; y < h; y++) {
      const runs: [number, number][] = [];
      let x = 0;
      while (x < w) {
        while (x < w && !mask[y * img.w + x]) {
          cut = true;
          x++;
        }
        const start = x;
        while (x < w && mask[y * img.w + x]) x++;
        if (x > start) runs.push([start, x]);
      }
      const next = new Map<string, { y: number; x0: number; x1: number }>();
      for (const [x0, x1] of runs) {
        const k = `${x0},${x1}`;
        next.set(k, open.get(k) ?? { y, x0, x1 });
        open.delete(k);
      }
      for (const r of open.values()) close(r, y);
      open = next;
    }
    for (const r of open.values()) close(r, h);
    // Everything outside the image (when the element is bigger) stays.
    if (width !== undefined && width > img.w) rects.push(`M${img.w} 0H${width}V${height ?? h}H${img.w}Z`);
    if (height !== undefined && height > img.h) rects.push(`M0 ${img.h}H${img.w}V${height}H0Z`);
    const path = cut ? `path('${rects.join('')}')` : null;
    this.regions.set(id, path);
    return path;
  }
}
