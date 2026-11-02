/**
 * Power mode, after activate-power-mode for Atom: type a while without
 * stopping, and from then on every keystroke throws sparks in the text's
 * color from the caret, and (if chosen) shakes the window. A pause breaks
 * the streak, and the next one has to build up again.
 *
 * Keystrokes come from the desktop's own fields, heard here; from built-in
 * apps' (window.din's runtime finds their caret and tells DinAppFrame,
 * which hands it on); and from web pages' and nsites', whose preload finds
 * it and main passes on (`window.dinos.powerMode`, electron/power-mode.mts).
 * Only where the caret is ever leaves a page, never what's typed, and
 * nothing at all while power mode is off. The sparks are drawn by the
 * cursor effects engine, on its layer over the screen.
 */

import { cursorEffects } from '@/lib/cursorEffects';
import type { Rgb } from '@/lib/cursorEffects/sprites';
import { findGuest } from '@/platform/guest';
import { caretSpot, typesText, type CaretSpot } from '@/shared/caret';

/** What the Electron preload exposes as `window.dinos.powerMode`. */
export interface PowerModeBridge {
  set(on: boolean): Promise<void>;
  /** Keys typed in web pages: the caret in the page's CSS pixels, the page's width in them, and the text's color. */
  onTyped(callback: (typed: { wcId: number; x: number; y: number; width: number; color: string }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    powerMode?: PowerModeBridge;
  }
}

/** Keystrokes in a row before the sparks start (five times the plugin's first threshold). */
const ACTIVATION = 100;
/**
 * A pause this long breaks the streak, and ends the sparks once they've
 * started (the plugin's is 10 s, which everyday typing rarely breaks): only
 * typing flat out, not stopping to think, gets there and keeps it going.
 */
const STREAK_TIMEOUT_MS = 1_000;
/** How far, at most, a keystroke throws the window, in CSS pixels, and how long it takes to settle. */
const SHAKE_PX = 3;
const SHAKE_MS = 120;

let on = false;
let shaking = true;
let streak = 0;
let lastAt = 0;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;
const shakes = new WeakMap<HTMLElement, Animation>();
const colors = new Map<string, Rgb>();
let colorCtx: CanvasRenderingContext2D | null = null;

/** Whether power mode is on (chosen, and motion isn't reduced): apps follow their caret only then. */
export function powerModeOn(): boolean {
  return on;
}

export function subscribePowerMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switch power mode on or off, and whether it shakes windows. */
export function setPowerMode(enabled: boolean, shake: boolean): void {
  shaking = shake;
  if (enabled === on) return;
  on = enabled;
  streak = 0;
  void window.dinos?.powerMode?.set(on).catch(() => {});
  if (on) stopListening = listenToDesktop();
  else {
    stopListening?.();
    stopListening = null;
  }
  for (const listener of listeners) listener();
}

/**
 * A keystroke typed at `spot` (CSS pixels of the screen), in `win`, the
 * window's element, if it's in one.
 */
export function typed(spot: CaretSpot, win: HTMLElement | null): void {
  if (!on) return;
  const now = performance.now();
  if (now - lastAt > STREAK_TIMEOUT_MS) streak = 0;
  lastAt = now;
  streak++;
  if (streak < ACTIVATION) return;
  cursorEffects.sparks(spot.x, spot.y, rgbOf(spot.color) ?? rgbOf(getComputedStyle(document.body).color) ?? [255, 255, 255]);
  if (shaking && win) shakeWindow(win);
}

/**
 * Show power mode off over a rectangle of the screen, as Settings does on
 * switching it on, shaking `win` (Settings' window) with it if given.
 */
export function previewPowerMode(rect: { x: number; y: number; width: number; height: number }, color: string, win: HTMLElement | null = null): void {
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    window.setTimeout(() => {
      cursorEffects.sparks(rect.x + rect.width * (0.15 + (0.7 * i) / (steps - 1)), rect.y + rect.height / 2, rgbOf(color) ?? [255, 255, 255]);
      if (win && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) shakeWindow(win);
    }, i * 70);
  }
}

function listenToDesktop(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!typesText(e)) return;
    const target = e.target instanceof Element ? e.target : null;
    // After the key has gone in, so the caret has moved.
    requestAnimationFrame(() => {
      const spot = caretSpot(document);
      if (spot) typed(spot, target?.closest<HTMLElement>('[data-window-id]') ?? null);
    });
  };
  window.addEventListener('keydown', onKeyDown, true);
  // Web pages' caret is in the page's CSS pixels, which its own zoom scales.
  const stopPages = window.dinos?.powerMode?.onTyped(({ wcId, x, y, width, color }) => {
    const guest = findGuest(wcId);
    if (!guest) return;
    const rect = guest.getBoundingClientRect();
    const scale = rect.width / width;
    typed({ x: rect.left + x * scale, y: rect.top + y * scale, color }, guest.closest<HTMLElement>('[data-window-id]'));
  });
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    stopPages?.();
  };
}

/** Knock the window a few pixels aside, to spring back; `translate` leaves its `transform` to drags and wobbles. */
function shakeWindow(win: HTMLElement): void {
  const angle = Math.random() * Math.PI * 2;
  const distance = 1 + Math.random() * (SHAKE_PX - 1);
  shakes.get(win)?.cancel();
  shakes.set(
    win,
    win.animate(
      [{ translate: `${Math.cos(angle) * distance}px ${Math.sin(angle) * distance}px` }, { translate: '0px 0px' }],
      { duration: SHAKE_MS, easing: 'ease-out', composite: 'add' },
    ),
  );
}

/** Any CSS color (oklch, named, …) as RGB, or null for an empty or unknown one. */
function rgbOf(color: string): Rgb | null {
  if (!color) return null;
  const known = colors.get(color);
  if (known) return known;
  if (!colorCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    colorCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = colorCtx;
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const rgb: Rgb | null = a === 0 ? null : [r, g, b];
  if (rgb) {
    if (colors.size > 64) colors.clear();
    colors.set(color, rgb);
  }
  return rgb;
}
