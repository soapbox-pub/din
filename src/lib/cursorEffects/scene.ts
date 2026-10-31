/**
 * What cursor effects draw: particles (glows, stars, smoke, ...), copies of
 * the pointer, ribbons, and CursorFX animations, all in CSS pixels of the
 * screen. Effects add to a scene; the engine steps it each frame and draws
 * it, and only the part of the canvas it drew on is cleared again.
 *
 * A scene doesn't know the time: it's stepped by whoever runs it, so the
 * same scene draws Settings' pictures offscreen as it draws the screen.
 */

import { type Rgb, type SpriteKind, rampColor, sprite, tintColor, toHsl } from '@/lib/cursorEffects/sprites';

/** The most particles a scene keeps; past it, the oldest go first. */
const MAX_PARTICLES = 3000;

export interface ParticleSpec {
  x: number;
  y: number;
  /** Velocity, in pixels per second. */
  vx?: number;
  vy?: number;
  /** Downward acceleration, in pixels per second squared (negative rises). */
  gravity?: number;
  /** How quickly the particle slows: velocity falls by e every 1/drag seconds. */
  drag?: number;
  /** How long it lives, in ms. */
  life: number;
  /** Its diameter, in pixels, when born. */
  size: number;
  /** Its size at the end of its life, as a multiple of `size`. */
  endSize?: number;
  kind: SpriteKind;
  /** Its color over its life: one color, or a ramp from birth to death. */
  colors: readonly Rgb[];
  /** Its opacity at full strength. */
  alpha?: number;
  /** The fraction of its life it takes to fade in. */
  fadeIn?: number;
  /** Whether it adds light (glows) rather than covering what's under it (smoke). */
  additive?: boolean;
  /** Turns per second, in radians, and the angle it starts at. */
  spin?: number;
  angle?: number;
  /** Twinkles this many times a second. */
  twinkle?: number;
  /** Sways side to side this many pixels. */
  sway?: number;
  /** Delay before it appears, in ms. */
  delay?: number;
  /** A name to clear it by (Fire Paint's flames). */
  group?: string;
  /** Keep its colors under a tint (power mode's sparks are the text's color). */
  untinted?: boolean;
}

interface Particle extends Required<Omit<ParticleSpec, 'group' | 'untinted'>> {
  age: number;
  seed: number;
  group: string | undefined;
}

/** An image of the pointer, in CSS pixels, with its hot spot. */
export interface CursorImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
}

interface Ghost {
  x: number;
  y: number;
  age: number;
  life: number;
}

/** A CursorFX animation sheet: the frames side by side. */
export interface Sheet {
  source: CanvasImageSource;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  steps: { index: number; delay: number }[];
  /** The whole animation's length, in ms. */
  duration: number;
}

interface Playing {
  sheet: Sheet;
  x: number;
  y: number;
  age: number;
}

interface RibbonPoint {
  x: number;
  y: number;
  age: number;
  hue: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A small, fast, seedable random number generator (mulberry32). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A vector arrow, for copies of the pointer when its own image isn't known. */
let fallbackArrow: CursorImage | null = null;
export function arrowImage(): CursorImage {
  if (fallbackArrow) return fallbackArrow;
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(2, 2);
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(2, 19);
    ctx.lineTo(6.5, 15);
    ctx.lineTo(9.5, 21.5);
    ctx.lineTo(12.5, 20.2);
    ctx.lineTo(9.6, 13.8);
    ctx.lineTo(15.5, 13.8);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'white';
    ctx.fillStyle = 'black';
    ctx.fill();
    ctx.stroke();
  }
  fallbackArrow = { source: canvas, width: 24, height: 24, hotX: 2, hotY: 2 };
  return fallbackArrow;
}

export class Scene {
  private particles: Particle[] = [];
  private ghosts: Ghost[] = [];
  private playing: Playing[] = [];
  private ribbon: RibbonPoint[] = [];
  /** How long a ribbon point lasts, in ms, and how wide it starts. */
  ribbonLife = 600;
  ribbonWidth = 10;
  /** How long a copy of the pointer lasts, in ms. */
  ghostLife = 380;
  /** The pointer's picture, for its copies. */
  cursor: CursorImage | null = null;
  readonly random: () => number;
  /** A color particles and the ribbon take on instead of their own (tintColor), and it as HSL. */
  private tint: Rgb | null = null;
  private tintHsl: [number, number, number] | null = null;
  /** Colors already tinted, by their RGB. */
  private tinted = new Map<string, Rgb>();

  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.random = seeded(seed);
  }

  /** Draw what's added from now on in `tint`'s hue (the theme's color), or in its own colors. */
  setTint(tint: Rgb | null): void {
    this.tint = tint;
    this.tintHsl = tint ? toHsl(tint) : null;
    this.tinted.clear();
  }

  private tintAll(colors: readonly Rgb[]): readonly Rgb[] {
    const tint = this.tint;
    if (!tint) return colors;
    return colors.map((color) => {
      const key = color.join(',');
      let out = this.tinted.get(key);
      if (!out) {
        out = tintColor(color, tint);
        this.tinted.set(key, out);
      }
      return out;
    });
  }

  /** Whether anything is left to draw. */
  get busy(): boolean {
    return this.particles.length > 0 || this.ghosts.length > 0 || this.playing.length > 0 || this.ribbon.length > 0;
  }

  add(spec: ParticleSpec): void {
    // Full: the oldest tenth goes at once, not one per add (each a shift of
    // the whole list, thousands of times a second under Fire Paint).
    if (this.particles.length >= MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES + MAX_PARTICLES / 10);
    this.particles.push({
      vx: 0,
      vy: 0,
      gravity: 0,
      drag: 0,
      endSize: 1,
      alpha: 1,
      fadeIn: 0,
      additive: true,
      spin: 0,
      angle: 0,
      twinkle: 0,
      sway: 0,
      delay: 0,
      ...spec,
      colors: spec.untinted ? spec.colors : this.tintAll(spec.colors),
      group: spec.group,
      age: 0,
      seed: this.random() * 1000,
    });
  }

  /** A fading copy of the pointer, at the pointer's position. */
  ghost(x: number, y: number): void {
    this.ghosts.push({ x, y, age: 0, life: this.ghostLife });
  }

  /** Play a CursorFX animation once with its hot spot at (x, y). */
  play(sheet: Sheet, x: number, y: number): void {
    if (this.playing.length < 400) this.playing.push({ sheet, x, y, age: 0 });
  }

  /** Extend the ribbon to (x, y). */
  extendRibbon(x: number, y: number, hue: number): void {
    this.ribbon.push({ x, y, age: 0, hue });
  }

  /** Remove everything of a group, or everything. */
  clear(group?: string): void {
    if (group === undefined) {
      this.particles = [];
      this.ghosts = [];
      this.playing = [];
      this.ribbon = [];
    } else {
      this.particles = this.particles.filter((p) => p.group !== group);
    }
  }

  /** Move everything on by `dt` ms. */
  step(dt: number): void {
    const s = dt / 1000;
    let kept = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life + p.delay) continue;
      if (p.age > p.delay) {
        if (p.drag) {
          const k = Math.exp(-p.drag * s);
          p.vx *= k;
          p.vy *= k;
        }
        p.vy += p.gravity * s;
        p.x += p.vx * s;
        p.y += p.vy * s;
        p.angle += p.spin * s;
      }
      this.particles[kept++] = p;
    }
    this.particles.length = kept;

    for (const g of this.ghosts) g.age += dt;
    this.ghosts = this.ghosts.filter((g) => g.age < g.life);
    for (const p of this.playing) p.age += dt;
    this.playing = this.playing.filter((p) => p.age < p.sheet.duration);
    for (const r of this.ribbon) r.age += dt;
    while (this.ribbon.length && this.ribbon[0].age >= this.ribbonLife) this.ribbon.shift();
  }

  /**
   * Where `draw` would draw now (in CSS pixels), or null for nowhere: for
   * the engine to size its canvas to, since the compositor redraws all of a
   * canvas that changed, and everything blurred under it.
   */
  bounds(): Bounds | null {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const grow = (x: number, y: number, half: number) => {
      left = Math.min(left, x - half);
      top = Math.min(top, y - half);
      right = Math.max(right, x + half);
      bottom = Math.max(bottom, y + half);
    };
    if (this.ribbon.length > 1) {
      for (const r of this.ribbon) grow(r.x, r.y, this.ribbonWidth);
    }
    const cursor = this.cursor ?? (this.ghosts.length ? arrowImage() : null);
    if (cursor) {
      for (const g of this.ghosts) {
        grow(g.x - cursor.hotX, g.y - cursor.hotY, 0);
        grow(g.x - cursor.hotX + cursor.width, g.y - cursor.hotY + cursor.height, 0);
      }
    }
    for (const p of this.playing) {
      grow(p.x - p.sheet.hotX, p.y - p.sheet.hotY, 0);
      grow(p.x - p.sheet.hotX + p.sheet.width, p.y - p.sheet.hotY + p.sheet.height, 0);
    }
    for (const p of this.particles) {
      if (p.age < p.delay) continue;
      const t = (p.age - p.delay) / p.life;
      const size = p.size * (1 + (p.endSize - 1) * t);
      // A turned sprite reaches its corners out to the diagonal.
      grow(p.x, p.y, (size / 2) * (p.angle ? Math.SQRT2 : 1) + p.sway);
    }
    return left < right ? { left, top, right, bottom } : null;
  }

  /** Draw onto `ctx` (in CSS pixels), returning where it drew, or null for nowhere. */
  draw(ctx: CanvasRenderingContext2D): Bounds | null {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const grow = (x: number, y: number, w: number, h: number) => {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
    };

    // The ribbon, under the rest: segments from its oldest point to its newest.
    if (this.ribbon.length > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 1; i < this.ribbon.length; i++) {
        const a = this.ribbon[i - 1];
        const b = this.ribbon[i];
        const t = b.age / this.ribbonLife;
        const width = Math.max(0.5, this.ribbonWidth * (1 - t));
        ctx.globalAlpha = Math.max(0, 1 - t) * 0.85;
        // Tinted, the rainbow shimmers either side of the tint's hue instead.
        ctx.strokeStyle = this.tintHsl
          ? `hsl(${this.tintHsl[0] + Math.sin((b.hue * Math.PI) / 180) * 20} ${Math.round(this.tintHsl[1] * 100)}% 62%)`
          : `hsl(${b.hue % 360} 100% 62%)`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        grow(Math.min(a.x, b.x) - width, Math.min(a.y, b.y) - width, Math.abs(a.x - b.x) + width * 2, Math.abs(a.y - b.y) + width * 2);
      }
      ctx.restore();
    }

    const cursor = this.cursor ?? (this.ghosts.length ? arrowImage() : null);
    if (cursor) {
      for (const g of this.ghosts) {
        const t = g.age / g.life;
        ctx.globalAlpha = 0.55 * (1 - t);
        const x = g.x - cursor.hotX;
        const y = g.y - cursor.hotY;
        ctx.drawImage(cursor.source, x, y, cursor.width, cursor.height);
        grow(x, y, cursor.width, cursor.height);
      }
    }

    for (const p of this.playing) {
      const { sheet } = p;
      let at = p.age;
      let index = sheet.steps[sheet.steps.length - 1].index;
      for (const step of sheet.steps) {
        if (at < step.delay) {
          index = step.index;
          break;
        }
        at -= step.delay;
      }
      ctx.globalAlpha = 1;
      const x = p.x - sheet.hotX;
      const y = p.y - sheet.hotY;
      ctx.drawImage(sheet.source, index * sheet.width, 0, sheet.width, sheet.height, x, y, sheet.width, sheet.height);
      grow(x, y, sheet.width, sheet.height);
    }

    let additive = false;
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.particles) {
      if (p.age < p.delay) continue;
      const t = (p.age - p.delay) / p.life;
      let alpha = p.alpha * (p.fadeIn > 0 && t < p.fadeIn ? t / p.fadeIn : (1 - t) / (1 - p.fadeIn || 1));
      if (p.twinkle) alpha *= 0.55 + 0.45 * Math.sin(p.seed + (p.age / 1000) * p.twinkle * Math.PI * 2);
      if (alpha <= 0.01) continue;
      const size = p.size * (1 + (p.endSize - 1) * t);
      if (size < 0.5) continue;
      if (p.additive !== additive) {
        additive = p.additive;
        ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
      }
      const x = p.x + (p.sway ? Math.sin(p.seed + p.age / 180) * p.sway : 0);
      ctx.globalAlpha = Math.min(1, alpha);
      const image = sprite(p.kind, rampColor(p.colors, t));
      if (p.angle) {
        ctx.save();
        ctx.translate(x, p.y);
        ctx.rotate(p.angle);
        ctx.drawImage(image, -size / 2, -size / 2, size, size);
        ctx.restore();
      } else {
        ctx.drawImage(image, x - size / 2, p.y - size / 2, size, size);
      }
      grow(x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    return left < right ? { left, top, right, bottom } : null;
  }
}
