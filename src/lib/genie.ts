/**
 * Genie minimize — a port of the "magic lamp" effect from Compiz's animation
 * plugin (`src/animation/magiclamp.c`, © 2006 Erkin Bahceci; based on the
 * Minimize plugin by David Reveman). macOS calls the same idea the genie
 * effect.
 *
 * Compiz deforms a 2 × GRID_RES mesh over the window. Two pieces make the
 * effect read as "sucked into the dock" rather than a rigid scale-down, and
 * both are ported here faithfully:
 *
 * - **The lamp silhouette is a function of height, not time.** Each vertex's
 *   x is derived from its *current* y through a normalized sigmoid running
 *   from the icon's mouth (fully pinched) up to the window's far edge (full
 *   width). The funnel stands still while the window streams through it.
 * - **A three-phase timeline** over linear progress: a "pre-shape" phase
 *   (first 22%) morphs the rectangle into the lamp shape while the near edge
 *   heads for the icon; a "stretch" phase ends with the near edge attached
 *   to the icon and the far edge still at the window (its share of the
 *   timeline is proportional to the travel distances); a "post-stretch"
 *   phase translates the whole shape into the icon, vertices piling up
 *   (clamping) at its far side until the window is fully swallowed.
 *
 * `genieFrame` is the model: any point of the window at any progress. Inside
 * the shell, minimize warps a bitmap snapshot of the window, which
 * src/lib/genieMesh.ts draws through a real 2 × GRID_RES mesh in WebGL, so
 * the sides follow the sigmoid curve as in Compiz. The DOM can't warp live
 * content through a mesh (the windows host an Electron <webview>, xterm,
 * etc.), so `animateGenie` - the fallback outside the shell or without WebGL
 * - evaluates the model only at the four corners and fits the projective
 * transform (CSS matrix3d) mapping the element onto that quad, like the
 * wobbly-windows port in src/lib/wobbly.ts: straight sides, Compiz's
 * "Vacuum" look. Neither has the "wavy" sides of the default Magic Lamp
 * variant (max_waves = 0, as on macOS). A short end-of-timeline fade covers
 * the final pop that Compiz hides behind the (opaque) icon — our dock tiles
 * sit on a transparent strip.
 *
 * Restore plays the same timeline backwards, as Compiz does for unminimize.
 */

import { quadTransform, type QuadPoint } from '@/lib/wobbly';

/** An axis-aligned rectangle in workspace coordinates. */
export interface GenieRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Genie timeline length. Progress over it is linear, like Compiz. */
export const GENIE_DURATION_MS = 400;

/** Portion of the timeline that morphs the rectangle into the lamp shape. */
const PRE_SHAPE_END = 0.22;

/**
 * Point in the timeline where the window starts fading. Compiz keeps the
 * window opaque - its final frame is icon-sized, hidden behind the icon -
 * but our dock strip is transparent, so the shrunken window would visibly
 * pop out of existence without a fade.
 */
const FADE_START = 0.8;

/** Compiz `sigmoid(fx)`: the lamp silhouette curve. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-10 * (x - 0.5)));
}

const SIGMOID_0 = sigmoid(0);
const SIGMOID_1 = sigmoid(1);

/**
 * Compiz `decelerateProgress`: the segment [0.5, 0.75] of a slope-8 sigmoid,
 * normalized. Used to slow the pre-shape morph toward its end.
 */
function decelerate(progress: number): number {
  const s2 = (x: number) => 1 / (1 + Math.exp(-16 * (x - 0.5)));
  const x = 1 - progress;
  return 1 - (s2(0.5 + x * 0.25) - s2(0.5)) / (s2(0.75) - s2(0.5));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The window's deformation at one point of the timeline. */
export interface GenieFrame {
  /**
   * Where the window point at fractions (`gx`, `gy`) of its width and height
   * is drawn, in workspace coordinates. Linear in `gx` along a row, so a mesh
   * needs only two columns; values just outside [0, 1] extrapolate the edges.
   */
  point(gx: number, gy: number): QuadPoint;
  /** The window's opacity, 1 until the end-of-timeline fade. */
  opacity: number;
}

/**
 * The deformation for progress `p`: 0 is the window at rest in its own
 * geometry, 1 is fully swallowed by the tile. A port of Compiz
 * `fxMagicLampModelStep` for the minimize-downward case.
 */
export function genieFrame(win: GenieRect, target: GenieRect, p: number): GenieFrame {
  // Compiz's edge names, for a window above the icon: the "close" end is
  // the window's bottom edge, heading for the icon's mouth (top edge); the
  // "far" end is the window's top edge, last to be swallowed.
  const iconCloseY = target.y;
  const iconFarY = target.y + target.height;
  const winFarY = win.y;
  const winCloseY = Math.min(win.y + win.height, iconCloseY);
  /** Height of the funnel: how far the far edge travels to the mouth. */
  const funnel = Math.max(1, iconCloseY - winFarY);

  // The stretch phase's share of the timeline is proportional to the close
  // edge's share of the total travel (Compiz stretchPhaseEnd).
  const closeDist = iconCloseY - winCloseY;
  let stretchEnd = PRE_SHAPE_END + ((1 - PRE_SHAPE_END) * closeDist) / (funnel + closeDist);
  if (stretchEnd < PRE_SHAPE_END + 0.1) stretchEnd = PRE_SHAPE_END + 0.1;

  const preShape = p < PRE_SHAPE_END ? 1 - decelerate(1 - p / PRE_SHAPE_END) : 1;
  const stretch = Math.min(1, p / stretchEnd);
  const post = p < stretchEnd ? 0 : (p - stretchEnd) / (1 - stretchEnd);

  const point = (gx: number, gy: number): QuadPoint => {
    const origX = win.x + gx * win.width;
    const origY = win.y + gy * win.height;
    const iconX = target.x + gx * target.width;
    const iconY = target.y + gy * target.height;

    // Stretch pulls each row toward the icon in proportion to its grid y:
    // the far edge (gy 0) holds still while the close edge (gy 1) attaches
    // to the icon; post-stretch then translates the whole shape into the
    // icon, rows piling up (the clamp below) at its far side.
    const stretched = (1 - gy) * origY + gy * iconY;
    let y = post === 0 ? lerp(origY, stretched, stretch) : stretched + post * funnel;
    y = Math.min(y, iconFarY);

    // The silhouette: x follows the corner's *current* height through the
    // sigmoid, from full window width at the far end (fx 1) down to icon
    // width at the mouth (fx 0). During pre-shape, blend from the original
    // rectangle into this lamp shape.
    const fx = Math.min(1, Math.max(0, (iconCloseY - y) / funnel));
    const fy = (sigmoid(fx) - SIGMOID_0) / (SIGMOID_1 - SIGMOID_0);
    let x = fy * (origX - iconX) + iconX;
    if (preShape < 1) x = lerp(origX, x, preShape);

    return { x, y };
  };

  const opacity = p <= FADE_START ? 1 : Math.max(0, 1 - (p - FADE_START) / (1 - FADE_START));
  return { point, opacity };
}

/** Paint frame `p` onto the element, as the projective fit of its corners. */
function paintFrame(el: HTMLElement, win: GenieRect, target: GenieRect, p: number): void {
  const frame = genieFrame(win, target, p);
  // Corner offsets are relative to the window's layout box.
  const corner = (gx: 0 | 1, gy: 0 | 1): QuadPoint => {
    const pt = frame.point(gx, gy);
    return { x: pt.x - win.x, y: pt.y - win.y };
  };
  el.style.transform = quadTransform(
    win.width,
    win.height,
    corner(0, 0),
    corner(1, 0),
    corner(0, 1),
    corner(1, 1),
  );
  el.style.opacity = frame.opacity === 1 ? '' : String(frame.opacity);
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
    const t = Math.min(1, (now - start) / GENIE_DURATION_MS);
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

/** FLIP timeline length. */
const FLIP_DURATION_MS = 250;

/**
 * FLIP-style geometry transition for maximize/restore/tile: the element's
 * layout has already jumped to `to` (React committed the new geometry); this
 * plays a compositor-only translate+scale that starts at `from` and eases
 * (cubic ease-out, decelerating into place) to identity. Same contract as
 * animateGenie: first frame painted synchronously, `onDone` owns cleanup and
 * never fires on cancel; returns a cancel function.
 */
export function animateFlip(
  el: HTMLElement,
  from: GenieRect,
  to: GenieRect,
  onDone: () => void,
): () => void {
  el.style.transformOrigin = '0 0';
  let raf = 0;
  const start = performance.now();

  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / FLIP_DURATION_MS);
    const p = 1 - Math.pow(1 - t, 3);
    const x = lerp(from.x - to.x, 0, p);
    const y = lerp(from.y - to.y, 0, p);
    const sx = lerp(from.width / to.width, 1, p);
    const sy = lerp(from.height / to.height, 1, p);
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      onDone();
    }
  };

  frame(start);
  return () => cancelAnimationFrame(raf);
}
