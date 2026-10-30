/**
 * Pictures of cursor effects for Settings' tiles: each effect run offscreen
 * on a little night-sky desktop, along a made-up pointer path (or after a
 * made-up click), and snapped mid-flight. Made once per effect and kept.
 */

import { CLICK_EFFECTS, TRAIL_EFFECTS, along, burnPoint, showMouse, type Stroke } from '@/lib/cursorEffects/effects';
import { PACKAGE_PREFIX, loadPackage } from '@/lib/cursorEffects/packages';
import { Scene, arrowImage } from '@/lib/cursorEffects/scene';
import type { Rgb } from '@/lib/cursorEffects/sprites';
import type { PreviewKind } from '@/lib/cursorEffects/engine';
import { Water } from '@/lib/cursorEffects/water';

/** The picture's size in CSS pixels, and how many device pixels each gets. */
const WIDTH = 160;
const HEIGHT = 100;
const SCALE = 2;
const STEP_MS = 16;

const cache = new Map<string, Promise<string | null>>();

/** A desktop to draw on: a dusky gradient with a window or two. */
function backdrop(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  g.addColorStop(0, '#1e1b4b');
  g.addColorStop(0.6, '#312e81');
  g.addColorStop(1, '#0f172a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.roundRect(12, 14, 70, 46, 4);
  ctx.roundRect(92, 40, 56, 44, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(12, 14, 70, 7);
  ctx.fillRect(92, 40, 56, 7);
}

/** The made-up pointer path: a lazy S from left to right. */
function pathAt(t: number): { x: number; y: number } {
  return { x: 14 + t * (WIDTH - 40), y: HEIGHT / 2 + Math.sin(t * Math.PI * 1.6) * 24 };
}

function canvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const c = document.createElement('canvas');
  c.width = WIDTH * SCALE;
  c.height = HEIGHT * SCALE;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);
  return { canvas: c, ctx };
}

function stroke(scene: Scene, from: { x: number; y: number }, to: { x: number; y: number }, state: Stroke['state'], water: Water | null): Stroke {
  return { scene, x0: from.x, y0: from.y, x1: to.x, y1: to.y, dt: STEP_MS, pressed: false, water, state };
}

/** Walk the path for `ms`, calling `at` with each step's stretch of it. */
function walk(scene: Scene, ms: number, at: (from: { x: number; y: number }, to: { x: number; y: number }) => void, water?: Water | null) {
  let from = pathAt(0);
  for (let elapsed = STEP_MS; elapsed <= ms; elapsed += STEP_MS) {
    const to = pathAt(elapsed / ms);
    at(from, to);
    scene.step(STEP_MS);
    water?.step(STEP_MS);
    from = to;
  }
  return from;
}

function run(steps: number, scene: Scene, each: () => void = () => {}, water?: Water | null) {
  for (let i = 0; i < steps; i++) {
    each();
    scene.step(STEP_MS);
    water?.step(STEP_MS);
  }
}

/** Water drawn over the backdrop, bent through it. */
function waterLayer(): { water: Water; picture: HTMLCanvasElement } | null {
  const picture = canvas();
  const surface = document.createElement('canvas');
  const water = new Water(surface);
  if (!picture || !water.available) return null;
  backdrop(picture.ctx);
  water.resize(WIDTH, HEIGHT, SCALE);
  return { water, picture: picture.canvas };
}

async function draw(kind: PreviewKind, id: string, tint: Rgb | null): Promise<string | null> {
  const out = canvas();
  if (!out) return null;
  const { ctx } = out;
  const scene = new Scene(0x5eed);
  scene.setTint(tint);
  const state = { carry: 0, hue: 200 };
  let pointer = { x: WIDTH / 2, y: HEIGHT / 2 };
  let water: { water: Water; picture: HTMLCanvasElement } | null = null;
  const needsWater = (needed?: boolean) => {
    if (needed && !water) water = waterLayer();
    return water?.water ?? null;
  };

  if (kind === 'trail') {
    const effect = id.startsWith(PACKAGE_PREFIX) ? (await loadPackage(id))?.trail : TRAIL_EFFECTS.find((e) => e.id === id);
    if (!effect) return null;
    const surface = needsWater(effect.water);
    pointer = walk(scene, 700, (from, to) => effect.stroke(stroke(scene, from, to, state, surface)), surface);
  } else if (kind === 'click') {
    const effect = id.startsWith(PACKAGE_PREFIX) ? (await loadPackage(id))?.click : CLICK_EFFECTS.find((e) => e.id === id);
    if (!effect) return null;
    const surface = needsWater(effect.water);
    effect.click(scene, pointer.x, pointer.y, surface);
    const pkg = id.startsWith(PACKAGE_PREFIX) ? await loadPackage(id) : null;
    const ms = pkg?.clickSheet ? pkg.clickSheet.duration * 0.45 : surface ? 420 : 260;
    run(Math.round(ms / STEP_MS), scene, undefined, surface);
  } else if (kind === 'show-mouse') {
    let phase = 0;
    run(30, scene, () => {
      phase += (STEP_MS / 1000) * 3.2;
      showMouse(scene, pointer.x, pointer.y, phase, STEP_MS, 1);
    });
  } else if (kind === 'fire-paint') {
    const points: { x: number; y: number }[] = [];
    pointer = walk(scene, 600, (from, to) => along(stroke(scene, from, to, state, null), 5, (x, y) => points.push({ x, y })));
    run(24, scene, () => {
      for (const p of points) burnPoint(scene, p.x, p.y, 1, STEP_MS);
    });
  } else {
    const surface = needsWater(true);
    if (!surface) return null;
    pointer = walk(scene, 700, (from, to) => along(stroke(scene, from, to, state, null), 8, (x, y) => surface.disturb(x, y, 10, 0.9)), surface);
  }

  backdrop(ctx);
  const pool = water as { water: Water; picture: HTMLCanvasElement } | null;
  if (pool) {
    pool.water.setBackground(pool.picture);
    pool.water.render();
    ctx.drawImage(pool.water.canvas as HTMLCanvasElement, 0, 0, WIDTH, HEIGHT);
    pool.water.dispose();
  }
  scene.draw(ctx);
  const arrow = arrowImage();
  ctx.drawImage(arrow.source, pointer.x - arrow.hotX * 0.7, pointer.y - arrow.hotY * 0.7, arrow.width * 0.7, arrow.height * 0.7);
  return out.canvas.toDataURL('image/png');
}

/** A picture of an effect as a data URL (in `tint`'s hue, if given), or null if it can't be drawn here. */
export function cursorEffectThumbnail(kind: PreviewKind, id: string, tint: Rgb | null = null): Promise<string | null> {
  const key = `${tint?.join(',') ?? 'own'}|${kind}:${id}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = draw(kind, id, tint).catch(() => null);
    cache.set(key, promise);
  }
  return promise;
}

/** Forget an imported package's pictures, after it's removed or imported anew. */
export function forgetThumbnails(id: string): void {
  for (const key of [...cache.keys()]) if (key.endsWith(`:${id}`)) cache.delete(key);
}
