/**
 * Genie minimize — the "window gets sucked into the dock" animation. Compiz
 * ships it as the "magic lamp" effect; macOS calls it the genie effect.
 *
 * The live window element is warped by a per-frame CSS matrix3d() homography
 * (the same technique the wobbly-windows deformation uses — see
 * src/lib/wobbly.ts): each frame fits the projective transform mapping the
 * window's layout box onto a quad interpolated between the window's rect and
 * the app's dock tile. The bottom corners lead the top corners by EDGE_LAG
 * of the timeline, so mid-animation the window is a tall funnel — bottom
 * edge already pinched into the tile, top edge still up at the window — which
 * is what reads as "poured into the dock" rather than a rigid scale-down.
 *
 * A true genie additionally bows the window's sides, but a single homography
 * can only produce straight-edged quads, and slicing live DOM content (an
 * Electron <webview>, an xterm) into strips isn't an option. The staggered
 * corners are a close, cheap approximation that runs compositor-only.
 *
 * Restore plays the same timeline backwards.
 */

import { quadTransform } from '@/lib/wobbly';

/** An axis-aligned rectangle in workspace coordinates. */
export interface GenieRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Total timeline length. */
const DURATION_MS = 400;

/**
 * Fraction of the timeline by which the bottom edge leads the top edge.
 * Higher = more exaggerated stretch; 0 degenerates into a plain scale.
 */
const EDGE_LAG = 0.45;

/**
 * Point in the timeline where the window starts fading. The dock strip has
 * no background, so without a fade the shrunken window would visibly pop
 * out of existence on top of the tile icon.
 */
const FADE_START = 0.7;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Paint the deformation for overall progress `p` onto the element: 0 is the
 * window at rest in its own geometry, 1 is fully swallowed by the tile.
 */
function paintFrame(el: HTMLElement, win: GenieRect, target: GenieRect, p: number): void {
  const pBottom = easeInOutCubic(Math.min(1, p / (1 - EDGE_LAG)));
  const pTop = easeInOutCubic(Math.max(0, (p - EDGE_LAG) / (1 - EDGE_LAG)));

  // Corner destinations relative to the window's layout box (the transform
  // applies with transform-origin 0 0).
  const left = target.x - win.x;
  const right = left + target.width;
  const top = target.y - win.y;
  const bottom = top + target.height;

  el.style.transform = quadTransform(
    win.width,
    win.height,
    { x: lerp(0, left, pTop), y: lerp(0, top, pTop) },
    { x: lerp(win.width, right, pTop), y: lerp(0, top, pTop) },
    { x: lerp(0, left, pBottom), y: lerp(win.height, bottom, pBottom) },
    { x: lerp(win.width, right, pBottom), y: lerp(win.height, bottom, pBottom) },
  );
  el.style.opacity =
    p <= FADE_START
      ? ''
      : String(Math.max(0, 1 - (p - FADE_START) / (1 - FADE_START)));
}

/**
 * Animate `el` (the window's <section>) into (`minimize`) or out of
 * (`restore`) the dock tile rect. Both rects are in workspace coordinates.
 *
 * The first frame is painted synchronously, so a restore never flashes the
 * full-size window before the animation kicks in. The caller owns style
 * cleanup via `onDone`, which fires exactly once when the timeline completes
 * (never on cancel). Returns a cancel function.
 */
export function animateGenie(
  el: HTMLElement,
  win: GenieRect,
  target: GenieRect,
  direction: 'minimize' | 'restore',
  onDone: () => void,
): () => void {
  el.style.transformOrigin = '0 0';
  let raf = 0;
  const start = performance.now();

  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    paintFrame(el, win, target, direction === 'minimize' ? t : 1 - t);
    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      onDone();
    }
  };

  frame(start);
  return () => cancelAnimationFrame(raf);
}
