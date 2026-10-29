import { BYBLOCK, BYLAYER, TRUE_COLOR, type Color } from './model';

/** AutoCAD Color Index: 1-9 are named, 10-249 run round the hue wheel in five shades, 250-255 are grays. */
export const ACI: readonly number[] = (() => {
  const t = new Array<number>(256).fill(0);
  const fixed = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  fixed.forEach((c, i) => (t[i] = c));
  const levels = [255, 165, 127, 76, 38];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    const level = levels[k >> 1] / 255;
    const light = k & 1;
    const f = (n: number) => {
      const x = (n + hue / 60) % 6;
      return 1 - Math.max(0, Math.min(x, 4 - x, 1));
    };
    const rgb = [f(5), f(3), f(1)].map((c) => Math.round((light ? 0.5 + c / 2 : c) * 255 * level));
    t[i] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  }
  [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff].forEach((c, i) => (t[250 + i] = c));
  return t;
})();

export const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;

export function nearestAci(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  let best = 7;
  let bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = ACI[i];
    const d = (r - ((c >> 16) & 255)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A concrete color's RGB, with 7 drawn in the background's opposite. */
export function colorRgb(c: Color, darkBackground: boolean): number {
  if (c >= TRUE_COLOR) return c & 0xffffff;
  if (c === 7 || c === BYLAYER || c === BYBLOCK) return darkBackground ? 0xffffff : 0x000000;
  return ACI[Math.abs(c)] ?? 0xffffff;
}

export function colorName(c: Color): string {
  if (c === BYLAYER) return 'ByLayer';
  if (c === BYBLOCK) return 'ByBlock';
  if (c >= TRUE_COLOR) {
    const rgb = c & 0xffffff;
    return `${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255}`;
  }
  return (['', 'Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta', 'White'][c] ?? `Color ${c}`) || `Color ${c}`;
}
