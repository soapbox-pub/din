/**
 * Pictures of the window effects for Settings: each effect's own engine
 * draws one frame of it, mid-flight, on a made-up window over a made-up
 * desktop. The scene is drawn at desktop size and scaled down, so meshes
 * and particles keep the proportions they have on screen. Pictures are
 * drawn one at a time, each in a WebGL context released straight after,
 * and kept for the session as blob URLs.
 */

import type { GenieRect, GenieTarget } from '@/lib/genie';
import { createEffectRenderer, type WindowEffect } from '@/lib/effects/engine';
import type { EffectEvent } from '@/lib/effects';

const VIEW = { width: 1200, height: 750 };
const WIN: GenieRect = { x: 260, y: 60, width: 680, height: 460 };
const DOCK: GenieRect = { x: 456, y: 664, width: 288, height: 64 };
const DOCK_TILES = 5;
/** The middle dock tile, where a minimized window goes. */
const TARGET: GenieTarget = { x: 576, y: 672, width: 48, height: 48, edge: 'bottom' };
/** Device pixels per desktop pixel in a picture. */
const SCALE = 0.32;
const SEED = 7;

/**
 * The moment each effect is shown at, where 0.5 isn't its best: the
 * frame that says the most about it.
 */
const FRAME: Record<string, number> = {
  'magic-lamp': 0.45,
  'magic-lamp-wavy': 0.45,
  zoom: 0.4,
  sidekick: 0.4,
  fade: 0.55,
  'curved-fold': 0.4,
  'horizontal-folds': 0.4,
  'roll-up': 0.45,
  explode: 0.12,
  'leaf-spread': 0.35,
  skewer: 0.35,
  domino: 0.4,
  razr: 0.4,
  airplane: 0.35,
  burn: 0.35,
  'beam-up': 0.45,
  fold: 0.42,
  bounce: 0.65,
  'fly-out': 0.6,
  expand: 0.25,
  shatter: 0.3,
  bonanza: 0.4,
};

/** The window the effects play on: a little app with a sidebar and a picture. */
function windowSnapshot(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WIN.width;
  canvas.height = WIN.height;
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;

  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 18);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#eef0f5';
  ctx.fillRect(0, 0, w, 48);
  ctx.fillStyle = '#f5f6fa';
  ctx.fillRect(0, 48, 150, h - 48);
  for (const [i, color] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(26 + i * 24, 24, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#c9cdd8';
  ctx.beginPath();
  ctx.roundRect(w / 2 - 80, 18, 160, 12, 6);
  ctx.fill();

  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i === 1 ? '#7c5cff' : '#d5d9e3';
    ctx.beginPath();
    ctx.roundRect(22, 78 + i * 40, i === 1 ? 104 : 84 - (i % 3) * 14, 14, 7);
    ctx.fill();
  }

  const hero = ctx.createLinearGradient(178, 76, w - 28, 260);
  hero.addColorStop(0, '#ff8a4c');
  hero.addColorStop(0.5, '#f0508f');
  hero.addColorStop(1, '#7c5cff');
  ctx.fillStyle = hero;
  ctx.beginPath();
  ctx.roundRect(178, 76, w - 206, 184, 14);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(w - 110, 130, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2b2f3a';
  ctx.beginPath();
  ctx.roundRect(178, 286, 220, 18, 9);
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#c9cdd8';
    ctx.beginPath();
    ctx.roundRect(178, 322 + i * 24, w - 206 - (i % 2) * 90 - (i === 3 ? 120 : 0), 10, 5);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - 2, 18);
  ctx.stroke();
  return canvas;
}

let snapshot: HTMLCanvasElement | null = null;

/** The desktop behind: a wallpaper, and the Dock when minimizing. */
function paintDesktop(ctx: CanvasRenderingContext2D, event: EffectEvent): void {
  const sky = ctx.createLinearGradient(0, 0, VIEW.width, VIEW.height);
  sky.addColorStop(0, '#1e3a8a');
  sky.addColorStop(0.55, '#5b3fb8');
  sky.addColorStop(1, '#c2569b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  const glow = ctx.createRadialGradient(VIEW.width * 0.8, VIEW.height * 0.15, 0, VIEW.width * 0.8, VIEW.height * 0.15, 520);
  glow.addColorStop(0, 'rgba(255,200,150,0.45)');
  glow.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);

  if (event !== 'minimize') return;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.roundRect(DOCK.x, DOCK.y, DOCK.width, DOCK.height, 20);
  ctx.fill();
  const colors = ['#38bdf8', '#34d399', '#ffffff', '#fbbf24', '#f87171'];
  for (let i = 0; i < DOCK_TILES; i++) {
    const x = DOCK.x + 16 + i * 52;
    ctx.fillStyle = colors[i];
    ctx.globalAlpha = i === 2 ? 0.35 : 0.9;
    ctx.beginPath();
    ctx.roundRect(x, TARGET.y, TARGET.width, TARGET.height, 12);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** A picture's canvas, the desktop painted and scaled to desktop pixels. */
function pictureCanvas(event: EffectEvent): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(VIEW.width * SCALE);
  canvas.height = Math.round(VIEW.height * SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);
  paintDesktop(ctx, event);
  return { canvas, ctx };
}

function toUrl(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/webp', 0.9);
  });
}

/** What a picture shows: an engine effect mid-flight, or the window at rest or popping. */
export type ThumbnailSubject = WindowEffect | 'none' | 'pop';

function paint(subject: ThumbnailSubject, event: EffectEvent): HTMLCanvasElement | null {
  const picture = pictureCanvas(event);
  if (!picture) return null;
  const { canvas, ctx } = picture;
  snapshot ??= windowSnapshot();

  if (subject === 'none' || subject === 'pop') {
    const s = subject === 'pop' ? 0.95 : 1;
    ctx.globalAlpha = subject === 'pop' ? 0.45 : 1;
    const cx = WIN.x + WIN.width / 2;
    const cy = WIN.y + WIN.height / 2;
    ctx.drawImage(snapshot, cx - (WIN.width * s) / 2, cy - (WIN.height * s) / 2, WIN.width * s, WIN.height * s);
    ctx.globalAlpha = 1;
    return canvas;
  }

  const gl = document.createElement('canvas');
  const renderer = createEffectRenderer(gl, snapshot, subject, VIEW, SCALE, WIN, event === 'minimize' ? TARGET : null, SEED);
  if (!renderer) return null;
  try {
    renderer.draw(FRAME[subject.id] ?? 0.5);
    // Read back in the same task, before the drawing buffer is cleared.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(gl, 0, 0);
  } finally {
    renderer.release();
  }
  return canvas;
}

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * A blob URL of `subject`'s picture for `event`, or null where it can't be
 * drawn (no WebGL). Pictures are drawn in turn, a frame apart, so a page
 * of them doesn't stall the desktop.
 */
export function effectThumbnail(subject: ThumbnailSubject, event: EffectEvent): Promise<string | null> {
  const key = `${event}:${typeof subject === 'string' ? subject : subject.id}`;
  let url = cache.get(key);
  if (!url) {
    url = queue.then(
      () =>
        new Promise<string | null>((resolve) => {
          requestAnimationFrame(() => {
            let canvas: HTMLCanvasElement | null = null;
            try {
              canvas = paint(subject, event);
            } catch {
              // Drawn as a blank tile.
            }
            resolve(canvas ? toUrl(canvas) : null);
          });
        }),
    );
    queue = url.catch(() => null);
    cache.set(key, url);
  }
  return url;
}
