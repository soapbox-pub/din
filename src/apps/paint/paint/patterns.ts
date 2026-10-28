import { hsl, packRgba, rgbOf, type Packed } from './raster';
import type { PatternId } from './presets';

/** What the paint bucket pours: a color for every pixel it fills. */
export function patternFn(id: PatternId, fg: Packed, bg: Packed, height: number): Packed | ((x: number, y: number) => Packed) {
  switch (id) {
    case 'solid':
      return fg;
    case 'checks':
      return (x, y) => (((x >> 2) + (y >> 2)) & 1 ? bg : fg);
    case 'stripes':
      return (x, y) => (((x + y) >> 2) & 1 ? bg : fg);
    case 'dots':
      return (x, y) => {
        const row = Math.floor(y / 4);
        const cx = (x + (row & 1) * 2) % 4;
        return cx < 2 && y % 4 < 2 ? fg : bg;
      };
    case 'bricks':
      return (x, y) => {
        const row = Math.floor(y / 6);
        if (y % 6 === 5) return fg;
        return (x + (row & 1) * 6) % 12 === 11 ? fg : bg;
      };
    case 'rainbow':
      return (x, y) => hsl((x + y) * 3, 0.9, 0.55);
    case 'gradient': {
      const a = rgbOf(fg);
      const b = rgbOf(bg);
      return (_x, y) => {
        const t = height > 1 ? y / (height - 1) : 0;
        const m = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
        return packRgba(m(0), m(1), m(2), m(3));
      };
    }
    case 'noise':
      return (x, y) => ((x + y) & 1 ? bg : fg);
  }
}
