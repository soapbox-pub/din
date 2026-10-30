/**
 * The soft little pictures particles are stamped from: a glow, a twinkling
 * star, a puff of smoke, a ring, a bubble. Each is drawn once per color and
 * kept, so a frame of a few hundred particles is a few hundred drawImage
 * calls and nothing else.
 */

export type Rgb = readonly [number, number, number];

export type SpriteKind = 'glow' | 'star' | 'smoke' | 'ring' | 'bubble' | 'heart';

/** A sprite's size in pixels; particles scale it to theirs. */
const SIZE = 64;

const cache = new Map<string, HTMLCanvasElement>();

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`;

function draw(kind: SpriteKind, color: Rgb, ctx: CanvasRenderingContext2D): void {
  const c = SIZE / 2;
  if (kind === 'glow') {
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, rgba([255, 255, 255], 1));
    g.addColorStop(0.2, rgba(color, 1));
    g.addColorStop(0.5, rgba(color, 0.5));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else if (kind === 'star') {
    const halo = ctx.createRadialGradient(c, c, 0, c, c, c * 0.6);
    halo.addColorStop(0, rgba(color, 0.7));
    halo.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Four long rays and four short ones, each a thin diamond.
    const ray = (angle: number, length: number, width: number) => {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, length, 0);
      g.addColorStop(0, rgba([255, 255, 255], 1));
      g.addColorStop(0.35, rgba(color, 0.9));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -width);
      ctx.lineTo(length, 0);
      ctx.lineTo(0, width);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < 4; i++) ray((i * Math.PI) / 2, c, 3);
    for (let i = 0; i < 4; i++) ray(Math.PI / 4 + (i * Math.PI) / 2, c * 0.45, 2);
  } else if (kind === 'smoke') {
    // A few overlapping blobs, so a puff isn't a perfect disc.
    const blobs: [number, number, number][] = [
      [0, 0, 1],
      [-0.25, -0.12, 0.7],
      [0.22, -0.18, 0.65],
      [0.1, 0.22, 0.7],
      [-0.2, 0.18, 0.6],
    ];
    for (const [dx, dy, r] of blobs) {
      const x = c + dx * c;
      const y = c + dy * c;
      const g = ctx.createRadialGradient(x, y, 0, x, y, c * r);
      g.addColorStop(0, rgba(color, 0.4));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
  } else if (kind === 'ring') {
    ctx.shadowColor = rgba(color, 1);
    ctx.shadowBlur = 6;
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c, c, c - 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = rgba([255, 255, 255], 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (kind === 'bubble') {
    const g = ctx.createRadialGradient(c, c, c * 0.6, c, c, c - 2);
    g.addColorStop(0, rgba(color, 0.05));
    g.addColorStop(0.8, rgba(color, 0.35));
    g.addColorStop(1, rgba(color, 0.9));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.fill();
    const shine = ctx.createRadialGradient(c * 0.7, c * 0.62, 0, c * 0.7, c * 0.62, c * 0.3);
    shine.addColorStop(0, rgba([255, 255, 255], 0.95));
    shine.addColorStop(1, rgba([255, 255, 255], 0));
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else {
    const g = ctx.createRadialGradient(c, c * 0.8, 0, c, c, c);
    g.addColorStop(0, rgba([255, 255, 255], 1));
    g.addColorStop(0.4, rgba(color, 1));
    g.addColorStop(1, rgba(color, 0.85));
    ctx.fillStyle = g;
    ctx.shadowColor = rgba(color, 0.9);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const s = c * 0.62;
    ctx.moveTo(c, c + s * 0.95);
    ctx.bezierCurveTo(c - s * 1.6, c - s * 0.1, c - s * 0.7, c - s * 1.3, c, c - s * 0.45);
    ctx.bezierCurveTo(c + s * 0.7, c - s * 1.3, c + s * 1.6, c - s * 0.1, c, c + s * 0.95);
    ctx.fill();
  }
}

/** The sprite of `kind` in `color`, drawn on first use. */
export function sprite(kind: SpriteKind, color: Rgb): HTMLCanvasElement {
  const key = `${kind}:${color.join(',')}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) draw(kind, color, ctx);
    cache.set(key, canvas);
  }
  return canvas;
}

/** A color part way along a ramp, snapped to one of `steps` so the sprites stay few. */
export function rampColor(ramp: readonly Rgb[], t: number, steps = 8): Rgb {
  if (ramp.length === 1) return ramp[0];
  const snapped = Math.round(Math.min(1, Math.max(0, t)) * (steps - 1)) / (steps - 1);
  const at = snapped * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(at));
  const f = at - i;
  const [a, b] = [ramp[i], ramp[i + 1]];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** A hue (0 to 360), saturation and lightness (0 to 1), as RGB. */
export function hslColor(hue: number, saturation: number, lightness: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = lightness - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A hue (0 to 360) at full saturation, as RGB. */
export function hueColor(hue: number, lightness = 0.6): Rgb {
  return hslColor(hue, 1, lightness);
}

/** RGB as hue (0 to 360), saturation and lightness (0 to 1). */
export function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255];
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rf ? ((gf - bf) / d) % 6 : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;
  return [(h * 60 + 360) % 360, Math.min(1, s), l];
}

/**
 * `color` in the tint's hue and saturation, at its own lightness: a glow's
 * white heart stays white and its dark edge dark, and the rest takes on the
 * tint, however pale or deep the tint itself is.
 */
export function tintColor(color: Rgb, tint: Rgb): Rgb {
  const [h, s] = toHsl(tint);
  return hslColor(h, s, toHsl(color)[2]);
}
