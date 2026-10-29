/**
 * The built-in cursor effects: trails the pointer leaves as it moves, and
 * effects a click sets off. Compiz's own (Mouse Trails, the water plugin's
 * ripples) and magical ones in the spirit of CursorFX: fire, fairy dust,
 * comets, rainbows, smoke, bubbles, fireworks.
 *
 * Each is a function that adds to a scene (src/lib/cursorEffects/scene.ts)
 * or stirs the water; it never draws itself.
 */

import type { Scene } from '@/lib/cursorEffects/scene';
import { type Rgb, hueColor } from '@/lib/cursorEffects/sprites';
import type { Water } from '@/lib/cursorEffects/water';

export type CursorEffectGroup = 'compiz' | 'magic';

/** What a trail sees of one stretch of the pointer's path. */
export interface Stroke {
  scene: Scene;
  /** Where the pointer was, and where it is now, in CSS pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** How long the pointer took, in ms. */
  dt: number;
  /** Whether a button is down. */
  pressed: boolean;
  /** The water, when the trail stirs it. */
  water: Water | null;
  /** The trail's own memory between strokes (how far since its last puff, ...). */
  state: { carry: number; hue: number };
}

export interface TrailEffect {
  id: string;
  name: string;
  group: CursorEffectGroup;
  /** It needs the water surface (WebGL2) to show anything. */
  water?: boolean;
  stroke(stroke: Stroke): void;
}

export interface ClickEffect {
  id: string;
  name: string;
  group: CursorEffectGroup;
  water?: boolean;
  click(scene: Scene, x: number, y: number, water: Water | null): void;
}

const FIRE: Rgb[] = [
  [255, 250, 220],
  [255, 214, 90],
  [255, 140, 30],
  [220, 60, 20],
  [120, 20, 10],
];
const COMET: Rgb[] = [
  [255, 255, 255],
  [170, 220, 255],
  [90, 140, 255],
  [140, 80, 255],
];
const SMOKE: Rgb[] = [
  [200, 200, 205],
  [150, 150, 158],
  [110, 110, 118],
];
const FAIRY: Rgb[] = [
  [255, 170, 230],
  [255, 225, 120],
  [150, 230, 255],
  [200, 170, 255],
  [255, 255, 255],
];

const between = (scene: Scene, lo: number, hi: number) => lo + scene.random() * (hi - lo);
const pick = <T>(scene: Scene, list: readonly T[]) => list[Math.floor(scene.random() * list.length)];

/**
 * Call `at` every `spacing` pixels along the stroke, carrying the remainder
 * over to the next one so the spacing holds however the moves are sliced.
 */
export function along(s: Stroke, spacing: number, at: (x: number, y: number) => void): void {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  let d = spacing - s.state.carry;
  let count = 0;
  while (d <= length && count++ < 200) {
    at(s.x0 + (dx * d) / length, s.y0 + (dy * d) / length);
    d += spacing;
  }
  s.state.carry = length - (d - spacing);
}

export const TRAIL_EFFECTS: TrailEffect[] = [
  {
    id: 'mouse-trails',
    name: 'Mouse Trails',
    group: 'compiz',
    stroke: (s) => along(s, 16, (x, y) => s.scene.ghost(x, y)),
  },
  {
    id: 'water-wake',
    name: 'Water',
    group: 'compiz',
    water: true,
    stroke: (s) => {
      const speed = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / Math.max(1, s.dt);
      along(s, 10, (x, y) => s.water?.disturb(x, y, 14, Math.min(0.8, 0.15 + speed * 0.25)));
    },
  },
  {
    id: 'fire',
    name: 'Fire',
    group: 'magic',
    stroke: (s) =>
      along(s, 3, (x, y) => {
        const { scene } = s;
        scene.add({
          x: x + between(scene, -3, 3),
          y: y + between(scene, -3, 3),
          vx: between(scene, -20, 20),
          vy: between(scene, -140, -60),
          life: between(scene, 420, 760),
          size: between(scene, 26, 40),
          endSize: 0.25,
          kind: 'glow',
          colors: FIRE,
          alpha: 0.85,
          fadeIn: 0.08,
          sway: 3,
        });
        if (scene.random() < 0.08) {
          scene.add({
            x,
            y,
            vx: between(scene, -40, 40),
            vy: between(scene, -160, -90),
            gravity: -20,
            drag: 0.8,
            life: between(scene, 800, 1300),
            size: between(scene, 3, 5),
            kind: 'glow',
            colors: [FIRE[1], FIRE[3]],
            twinkle: 6,
            sway: 6,
          });
        }
      }),
  },
  {
    id: 'fairy-dust',
    name: 'Fairy Dust',
    group: 'magic',
    stroke: (s) =>
      along(s, 7, (x, y) => {
        const { scene } = s;
        const color = pick(scene, FAIRY);
        scene.add({
          x: x + between(scene, -6, 6),
          y: y + between(scene, -6, 6),
          vx: between(scene, -25, 25),
          vy: between(scene, -10, 40),
          gravity: 110,
          drag: 1.2,
          life: between(scene, 900, 1500),
          size: between(scene, 18, 30),
          endSize: 0.4,
          kind: 'star',
          colors: [color],
          twinkle: between(scene, 4, 9),
          spin: between(scene, -3, 3),
          angle: between(scene, 0, Math.PI),
        });
      }),
  },
  {
    id: 'comet',
    name: 'Comet',
    group: 'magic',
    stroke: (s) =>
      along(s, 2, (x, y) => {
        const { scene } = s;
        scene.add({ x, y, life: 380, size: 30, endSize: 0.1, kind: 'glow', colors: COMET, alpha: 0.45 });
        if (scene.random() < 0.06) {
          scene.add({
            x,
            y,
            vx: between(scene, -50, 50),
            vy: between(scene, -50, 50),
            drag: 2,
            life: between(scene, 500, 900),
            size: between(scene, 8, 12),
            endSize: 0.3,
            kind: 'star',
            colors: [COMET[1]],
            twinkle: 8,
          });
        }
      }),
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    group: 'magic',
    stroke: (s) =>
      along(s, 4, (x, y) => {
        s.state.hue = (s.state.hue + 5) % 360;
        s.scene.extendRibbon(x, y, s.state.hue);
      }),
  },
  {
    id: 'smoke',
    name: 'Smoke',
    group: 'magic',
    stroke: (s) =>
      along(s, 9, (x, y) => {
        const { scene } = s;
        scene.add({
          x,
          y,
          vx: between(scene, -12, 12),
          vy: between(scene, -40, -15),
          drag: 0.6,
          life: between(scene, 1200, 1800),
          size: between(scene, 18, 26),
          endSize: 3,
          kind: 'smoke',
          colors: SMOKE,
          alpha: 0.6,
          fadeIn: 0.1,
          additive: false,
          spin: between(scene, -0.6, 0.6),
          angle: between(scene, 0, Math.PI * 2),
        });
      }),
  },
  {
    id: 'bubbles',
    name: 'Bubbles',
    group: 'magic',
    stroke: (s) =>
      along(s, 22, (x, y) => {
        const { scene } = s;
        scene.add({
          x: x + between(scene, -6, 6),
          y,
          vx: between(scene, -10, 10),
          vy: between(scene, -70, -30),
          life: between(scene, 1200, 2000),
          size: between(scene, 10, 24),
          endSize: 1.3,
          kind: 'bubble',
          colors: [pick(scene, [[170, 220, 255], [200, 255, 240], [230, 200, 255]] as Rgb[])],
          alpha: 0.9,
          fadeIn: 0.1,
          additive: false,
          sway: 8,
        });
      }),
  },
  {
    id: 'hearts',
    name: 'Hearts',
    group: 'magic',
    stroke: (s) =>
      along(s, 26, (x, y) => {
        const { scene } = s;
        scene.add({
          x,
          y,
          vx: between(scene, -15, 15),
          vy: between(scene, -50, -25),
          life: between(scene, 900, 1300),
          size: between(scene, 12, 20),
          endSize: 0.7,
          kind: 'heart',
          colors: [pick(scene, [[255, 80, 130], [255, 130, 180], [240, 60, 90]] as Rgb[])],
          fadeIn: 0.15,
          additive: false,
          sway: 5,
          spin: between(scene, -0.8, 0.8),
          angle: between(scene, -0.4, 0.4),
        });
      }),
  },
];

/** A burst of `count` particles thrown out from (x, y). */
function burst(scene: Scene, x: number, y: number, count: number, make: (angle: number, speed: number) => Parameters<Scene['add']>[0]) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + between(scene, -0.15, 0.15);
    scene.add(make(angle, between(scene, 0.6, 1)));
  }
}

export const CLICK_EFFECTS: ClickEffect[] = [
  {
    id: 'ripple',
    name: 'Ripple',
    group: 'compiz',
    click: (scene, x, y) => {
      for (const [delay, life] of [[0, 600], [90, 700]]) {
        scene.add({ x, y, life, delay, size: 12, endSize: 7, kind: 'ring', colors: [[150, 200, 255], [110, 150, 255]], alpha: 0.9 });
      }
    },
  },
  {
    id: 'splash',
    name: 'Splash',
    group: 'compiz',
    water: true,
    click: (_scene, x, y, water) => water?.disturb(x, y, 18, 2.2),
  },
  {
    id: 'starburst',
    name: 'Starburst',
    group: 'magic',
    click: (scene, x, y) => {
      scene.add({ x, y, life: 220, size: 70, endSize: 0.4, kind: 'glow', colors: [[255, 240, 200]], alpha: 0.8 });
      burst(scene, x, y, 14, (angle, speed) => ({
        x,
        y,
        vx: Math.cos(angle) * 420 * speed,
        vy: Math.sin(angle) * 420 * speed,
        drag: 5,
        life: between(scene, 420, 620),
        size: between(scene, 18, 26),
        endSize: 0.3,
        kind: 'star',
        colors: [[255, 230, 140], [255, 160, 60]],
        spin: 4,
      }));
    },
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    group: 'magic',
    click: (scene, x, y) => {
      const hue = between(scene, 0, 360);
      burst(scene, x, y, 42, (angle, speed) => ({
        x,
        y,
        vx: Math.cos(angle) * 300 * speed,
        vy: Math.sin(angle) * 300 * speed,
        gravity: 260,
        drag: 1.6,
        life: between(scene, 900, 1400),
        size: between(scene, 12, 18),
        endSize: 0.3,
        kind: 'glow',
        colors: [[255, 255, 255], hueColor(Math.round((hue + between(scene, -30, 30)) / 15) * 15)],
        twinkle: between(scene, 6, 12),
      }));
    },
  },
  {
    id: 'fireball',
    name: 'Fireball',
    group: 'magic',
    click: (scene, x, y) => {
      burst(scene, x, y, 36, (angle, speed) => ({
        x,
        y,
        vx: Math.cos(angle) * 160 * speed,
        vy: Math.sin(angle) * 160 * speed - 40,
        gravity: -120,
        drag: 3,
        life: between(scene, 500, 800),
        size: between(scene, 28, 44),
        endSize: 0.3,
        kind: 'glow',
        colors: FIRE,
        alpha: 0.75,
      }));
    },
  },
  {
    id: 'sparkle',
    name: 'Sparkle',
    group: 'magic',
    click: (scene, x, y) => {
      for (let i = 0; i < 9; i++) {
        const angle = between(scene, 0, Math.PI * 2);
        const r = between(scene, 6, 34);
        scene.add({
          x: x + Math.cos(angle) * r,
          y: y + Math.sin(angle) * r,
          vy: -10,
          delay: between(scene, 0, 180),
          life: between(scene, 500, 800),
          size: between(scene, 12, 22),
          endSize: 0.2,
          kind: 'star',
          colors: [pick(scene, FAIRY)],
          fadeIn: 0.3,
          spin: between(scene, -4, 4),
        });
      }
    },
  },
  {
    id: 'hearts',
    name: 'Hearts',
    group: 'magic',
    click: (scene, x, y) => {
      burst(scene, x, y, 7, (angle, speed) => ({
        x,
        y,
        vx: Math.cos(angle) * 110 * speed,
        vy: Math.sin(angle) * 110 * speed - 50,
        gravity: 90,
        drag: 2,
        life: between(scene, 800, 1100),
        size: between(scene, 14, 22),
        endSize: 0.6,
        kind: 'heart',
        colors: [[255, 90, 140]],
        additive: false,
        angle: between(scene, -0.4, 0.4),
      }));
    },
  },
];

/** Show Mouse's colors: Compiz's blue, brightening to white at the heart. */
const SHOW_MOUSE: Rgb[] = [
  [255, 255, 255],
  [140, 200, 255],
  [60, 120, 255],
];

/**
 * Compiz's Show Mouse, for one frame: emitters circling the pointer, each
 * shedding a stream of light. `phase` is how far round they've come.
 */
export function showMouse(scene: Scene, x: number, y: number, phase: number, dt: number, strength: number): void {
  const emitters = 3;
  const radius = 40;
  const count = Math.max(1, Math.round((dt / 1000) * 90 * strength));
  for (let e = 0; e < emitters; e++) {
    const angle = phase + (e * Math.PI * 2) / emitters;
    const ex = x + Math.cos(angle) * radius;
    const ey = y + Math.sin(angle) * radius;
    for (let i = 0; i < count; i++) {
      scene.add({
        x: ex + between(scene, -2, 2),
        y: ey + between(scene, -2, 2),
        vx: Math.cos(angle) * between(scene, 5, 30),
        vy: Math.sin(angle) * between(scene, 5, 30),
        life: between(scene, 500, 800),
        size: between(scene, 14, 22) * Math.max(0.4, strength),
        endSize: 0.2,
        kind: 'glow',
        colors: SHOW_MOUSE,
        alpha: 0.8,
      });
    }
  }
}

/** Compiz's Fire Paint, for one frame: a painted point gives off flames, fewer as it burns down. */
export function burnPoint(scene: Scene, x: number, y: number, left: number, dt: number): void {
  const count = (dt / 1000) * 20 * Math.max(0.15, left);
  let n = Math.floor(count);
  if (scene.random() < count - n) n++;
  for (let i = 0; i < n; i++) {
    scene.add({
      x: x + between(scene, -3, 3),
      y: y + between(scene, -2, 2),
      vx: between(scene, -12, 12),
      vy: between(scene, -110, -50),
      life: between(scene, 380, 650),
      size: between(scene, 20, 32) * (0.6 + 0.4 * left),
      endSize: 0.3,
      kind: 'glow',
      colors: FIRE.slice(1),
      alpha: 0.5,
      fadeIn: 0.1,
      sway: 2,
      group: 'paint',
    });
  }
}
