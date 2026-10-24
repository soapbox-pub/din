import { packRgba, pack, rgbOf, Surface, type Color, type Packed } from './raster';

/**
 * Whole-picture tricks: the Image menu's flips and turns, and the Kid
 * Pix-style Mixer. Each takes a surface and returns the result, which may
 * be a different size; the input isn't touched.
 */

export function flipH(s: Surface): Surface {
  const out = new Surface(s.width, s.height);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) out.px[y * s.width + x] = s.px[y * s.width + (s.width - 1 - x)];
  }
  return out;
}

export function flipV(s: Surface): Surface {
  const out = new Surface(s.width, s.height);
  for (let y = 0; y < s.height; y++) {
    out.px.set(s.px.subarray((s.height - 1 - y) * s.width, (s.height - y) * s.width), y * s.width);
  }
  return out;
}

/** A quarter turn, clockwise or not. */
export function rotate(s: Surface, clockwise: boolean): Surface {
  const out = new Surface(s.height, s.width);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const nx = clockwise ? s.height - 1 - y : y;
      const ny = clockwise ? x : s.width - 1 - x;
      out.px[ny * out.width + nx] = s.px[y * s.width + x];
    }
  }
  return out;
}

/** Nearest-neighbor resize, which keeps pixel art blocky. */
export function scale(s: Surface, width: number, height: number): Surface {
  const out = new Surface(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(s.height - 1, Math.floor((y * s.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(s.width - 1, Math.floor((x * s.width) / width));
      out.px[y * width + x] = s.px[sy * s.width + sx];
    }
  }
  return out;
}

/** A bigger or smaller canvas, the picture kept at the top left. */
export function resizeCanvas(s: Surface, width: number, height: number, background: Packed): Surface {
  const out = Surface.filled(width, height, background);
  out.paste(s, 0, 0);
  return out;
}

function mapPixels(s: Surface, fn: (p: Packed, x: number, y: number) => Packed): Surface {
  const out = new Surface(s.width, s.height);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) out.px[y * s.width + x] = fn(s.px[y * s.width + x], x, y);
  }
  return out;
}

export function invert(s: Surface): Surface {
  return mapPixels(s, (p) => {
    const [r, g, b, a] = rgbOf(p);
    return a === 0 ? 0 : packRgba(255 - r, 255 - g, 255 - b, a);
  });
}

export function grayscale(s: Surface): Surface {
  return mapPixels(s, (p) => {
    const [r, g, b, a] = rgbOf(p);
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    return a === 0 ? 0 : packRgba(l, l, l, a);
  });
}

/** Old photograph. */
export function sepia(s: Surface): Surface {
  return mapPixels(s, (p) => {
    const [r, g, b, a] = rgbOf(p);
    if (a === 0) return 0;
    const c = (v: number) => Math.min(255, Math.round(v));
    return packRgba(c(r * 0.393 + g * 0.769 + b * 0.189), c(r * 0.349 + g * 0.686 + b * 0.168), c(r * 0.272 + g * 0.534 + b * 0.131), a);
  });
}

/** Big chunky squares. */
export function mosaic(s: Surface, block = 8): Surface {
  const out = new Surface(s.width, s.height);
  for (let by = 0; by < s.height; by += block) {
    for (let bx = 0; bx < s.width; bx += block) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = by; y < Math.min(s.height, by + block); y++) {
        for (let x = bx; x < Math.min(s.width, bx + block); x++) {
          const [pr, pg, pb, pa] = rgbOf(s.px[y * s.width + x]);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
          n++;
        }
      }
      const c = a === 0 ? 0 : packRgba(Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n));
      out.fillRect(bx, by, block, block, c);
    }
  }
  return out;
}

/** Every row nudged sideways a little: an earthquake. */
export function shake(s: Surface): Surface {
  const out = new Surface(s.width, s.height);
  let offset = 0;
  for (let y = 0; y < s.height; y++) {
    if (y % 3 === 0) offset = Math.round((Math.random() - 0.5) * Math.max(4, s.width / 40));
    for (let x = 0; x < s.width; x++) {
      const sx = Math.min(s.width - 1, Math.max(0, x - offset));
      out.px[y * s.width + x] = s.px[y * s.width + sx];
    }
  }
  return out;
}

/** The picture slides down like it's melting. */
export function melt(s: Surface): Surface {
  const out = s.clone();
  const reach = Math.max(6, Math.round(s.height / 6));
  let drop = Math.random() * reach;
  for (let x = 0; x < s.width; x++) {
    drop = Math.max(0, Math.min(reach, drop + (Math.random() - 0.5) * 4));
    const d = Math.round(drop);
    for (let y = s.height - 1; y >= 0; y--) {
      const sy = Math.max(0, y - d);
      out.px[y * s.width + x] = s.px[sy * s.width + x];
    }
  }
  return out;
}

/** The left half, mirrored onto the right. */
export function mirror(s: Surface): Surface {
  const out = s.clone();
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < Math.floor(s.width / 2); x++) {
      out.px[y * s.width + (s.width - 1 - x)] = s.px[y * s.width + x];
    }
  }
  return out;
}

/** The top-left quarter, mirrored into all four corners. */
export function kaleidoscope(s: Surface): Surface {
  const out = s.clone();
  const hw = Math.ceil(s.width / 2);
  const hh = Math.ceil(s.height / 2);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const p = s.px[y * s.width + x];
      out.px[y * s.width + (s.width - 1 - x)] = p;
      out.px[(s.height - 1 - y) * s.width + x] = p;
      out.px[(s.height - 1 - y) * s.width + (s.width - 1 - x)] = p;
    }
  }
  return out;
}

/** TV snow, sprinkled over the top. */
export function noise(s: Surface): Surface {
  return mapPixels(s, (p) => {
    if (Math.random() > 0.15) return p;
    const v = Math.floor(Math.random() * 256);
    return packRgba(v, v, v);
  });
}

/** Every color swapped for the closest one in the palette. */
export function posterize(s: Surface, palette: Color[]): Surface {
  const colors = palette.filter((c) => c !== 'transparent').map((c) => rgbOf(pack(c)));
  if (colors.length === 0) return s.clone();
  const cache = new Map<Packed, Packed>();
  return mapPixels(s, (p) => {
    const [r, g, b, a] = rgbOf(p);
    if (a < 128) return 0;
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    let best = colors[0];
    let bestD = Infinity;
    for (const c of colors) {
      // Weighted for how eyes see it, so skin doesn't come out green.
      const d = 2 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 3 * (c[2] - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    const out = packRgba(best[0], best[1], best[2]);
    cache.set(p, out);
    return out;
  });
}

/**
 * A one-pixel line around everything that isn't background: the edge
 * every game sprite needs. Background is `bg` (usually transparent).
 */
export function outline(s: Surface, bg: Packed, color: Packed): Surface {
  const out = s.clone();
  const { width: w, height: h, px } = s;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[y * w + x] !== bg) continue;
      const solid =
        (x > 0 && px[y * w + x - 1] !== bg) ||
        (x < w - 1 && px[y * w + x + 1] !== bg) ||
        (y > 0 && px[(y - 1) * w + x] !== bg) ||
        (y < h - 1 && px[(y + 1) * w + x] !== bg);
      if (solid) out.px[y * w + x] = color;
    }
  }
  return out;
}

/** Brightness up or down by `amount` (-255 to 255). */
export function brighten(s: Surface, amount: number): Surface {
  const c = (v: number) => Math.max(0, Math.min(255, v + amount));
  return mapPixels(s, (p) => {
    const [r, g, b, a] = rgbOf(p);
    return a === 0 ? 0 : packRgba(c(r), c(g), c(b), a);
  });
}

/** Turn one color into another everywhere (the "Replace color" trick). */
export function replaceColor(s: Surface, from: Packed, to: Packed): Surface {
  return mapPixels(s, (p) => (p === from ? to : p));
}

export interface MixerEffect {
  id: string;
  name: string;
  emoji: string;
  apply: (s: Surface, ctx: { palette: Color[]; primary: Packed; secondary: Packed }) => Surface;
}

export const MIXER: MixerEffect[] = [
  { id: 'invert', name: 'Invert', emoji: '🌓', apply: invert },
  { id: 'gray', name: 'Gray', emoji: '🌫️', apply: grayscale },
  { id: 'sepia', name: 'Old Photo', emoji: '📜', apply: sepia },
  { id: 'mosaic', name: 'Mosaic', emoji: '🧱', apply: (s) => mosaic(s, Math.max(4, Math.round(Math.min(s.width, s.height) / 40))) },
  { id: 'shake', name: 'Earthquake', emoji: '🫨', apply: shake },
  { id: 'melt', name: 'Melt', emoji: '🫠', apply: melt },
  { id: 'mirror', name: 'Mirror', emoji: '🪞', apply: mirror },
  { id: 'kaleidoscope', name: 'Kaleido', emoji: '🔮', apply: kaleidoscope },
  { id: 'noise', name: 'TV Snow', emoji: '📺', apply: noise },
  { id: 'brighter', name: 'Brighter', emoji: '☀️', apply: (s) => brighten(s, 32) },
  { id: 'darker', name: 'Darker', emoji: '🌑', apply: (s) => brighten(s, -32) },
  { id: 'posterize', name: 'Palette-ize', emoji: '🎨', apply: (s, { palette }) => posterize(s, palette) },
  { id: 'outline', name: 'Outline', emoji: '✏️', apply: (s, { primary, secondary }) => outline(s, secondary, primary) },
];
