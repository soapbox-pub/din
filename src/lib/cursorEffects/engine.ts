/**
 * Cursor effects: what the pointer leaves behind as it moves and sets off
 * when it clicks, drawn over the whole screen on a layer that takes no
 * input (CursorEffectsLayer). Off unless chosen in Settings, and off
 * entirely while the system asks for reduced motion.
 *
 * The pointer is followed from the shell document's own pointer events,
 * which include those GuestInputHost replays from inside web pages (moves
 * at most once a frame, so a trail is laid along the straight line between
 * them) and native apps' surfaces; releases inside pages come straight from
 * the guest-input bridge.
 *
 * Besides a trail and a click effect, three of Compiz's plugins:
 *  - Show Mouse: Super+Shift+K, or a shake of the mouse, rings the pointer
 *    with circling lights so it's easy to find;
 *  - Fire Paint: Super+Shift and drag to draw in fire, which burns away;
 *    Super+Shift+C puts it out;
 *  - Water: hold Super+Ctrl and move to stir the screen like a pond.
 *
 * Particles draw on a 2D canvas, cleared only where they were last frame;
 * water on a WebGL canvas under it. Both are hidden, and the frame loop
 * stopped, whenever there's nothing to draw.
 */

import {
  CLICK_EFFECTS,
  type ClickEffect,
  type Stroke,
  TRAIL_EFFECTS,
  type TrailEffect,
  along,
  burnPoint,
  SHOW_MOUSE_SPIN,
  showMouse,
  sparks,
} from '@/lib/cursorEffects/effects';
import { PACKAGE_PREFIX, loadPackage } from '@/lib/cursorEffects/packages';
import { type CursorImage, Scene } from '@/lib/cursorEffects/scene';
import type { Rgb } from '@/lib/cursorEffects/sprites';
import { Water } from '@/lib/cursorEffects/water';
import { getGuestInput } from '@/lib/guestInput';
import { getScreenshotBridge } from '@/lib/screenshot';

export interface CursorEffectSettings {
  /** A trail's id, `cursorfx:…` for an imported one, or `none`. */
  trail: string;
  /** A click effect's id, `cursorfx:…`, or `none`. */
  click: string;
  showMouse: boolean;
  firePaint: boolean;
  water: boolean;
}

/** Something Settings can show off: a trail, a click effect, or one of the plugins. */
export type PreviewKind = 'trail' | 'click' | 'show-mouse' | 'fire-paint' | 'water';

const OFF: CursorEffectSettings = { trail: 'none', click: 'none', showMouse: false, firePaint: false, water: false };

/** Moves further apart than this in time aren't joined into one stroke. */
const STROKE_GAP_MS = 250;
/** How long a shake shows the pointer for, and Show Mouse takes to fade in and out. */
const SHAKE_SHOW_MS = 1600;
const SHOW_FADE_MS = 250;
/** How long a painted point burns. */
const PAINT_LIFE_MS = 2600;
/**
 * How many painted points burn at full strength; past it they share that
 * many points' flames, so a long stroke costs no more than a short one.
 */
const PAINT_FLAME_POINTS = 60;
/** How long to wait for the water's snapshot of the screen before drawing without one. */
const BACKDROP_WAIT_MS = 300;
/** How long a preview runs. */
const PREVIEW_MS = 1700;
/** The particle canvas covers what's drawn in whole squares of this many CSS pixels. */
const CANVAS_TILE = 64;
/** How long the canvases are kept after the last effect ends. */
const RELEASE_MS = 15_000;

interface PaintPoint {
  x: number;
  y: number;
  age: number;
}

interface Preview {
  kind: PreviewKind;
  trail: TrailEffect | null;
  click: ClickEffect | null;
  rect: { x: number; y: number; width: number; height: number };
  age: number;
  last: { x: number; y: number } | null;
  state: Stroke['state'];
  clicks: number;
}

function blankState(): Stroke['state'] {
  return { carry: 0, hue: Math.random() * 360 };
}

/** The built-in trail or click effect with an id, or (async) an imported one. */
async function resolve<T extends TrailEffect | ClickEffect>(id: string, builtIn: T[], pick: 'trail' | 'click'): Promise<T | null> {
  if (id === 'none') return null;
  if (id.startsWith(PACKAGE_PREFIX)) {
    const pkg = await loadPackage(id);
    return ((pick === 'trail' ? pkg?.trail : pkg?.click) ?? null) as T | null;
  }
  return builtIn.find((e) => e.id === id) ?? null;
}

class CursorEffectsEngine {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private waterCanvas: HTMLCanvasElement | null = null;
  private water: Water | null = null;
  private readonly scene = new Scene();
  private settings = OFF;
  private enabled = true;
  private width = 0;
  private height = 0;
  private frame = 0;
  /**
   * In a tick, which schedules the next itself: a wake from inside one used
   * to start a second loop alongside it, and every frame of a Fire Paint
   * preview another, each stepping the scene and adding Show Mouse's light.
   */
  private ticking = false;
  private last = 0;
  /** Where the particle canvas is on the screen, in CSS pixels: only over what's drawn. */
  private area: { x: number; y: number } | null = null;
  /** The particle canvas's size in CSS pixels, and the device pixels per CSS pixel it was made at. */
  private canvasSize = { width: 0, height: 0, scale: 0 };
  private listening: (() => void) | null = null;

  private pointer: { x: number; y: number; t: number } | null = null;
  private pressed = false;
  private trail: TrailEffect | null = null;
  private click: ClickEffect | null = null;
  private trailState = blankState();
  private idleTimer = 0;

  private showing = false;
  private shownUntil = 0;
  private showStrength = 0;
  private showPhase = 0;
  /** Where Show Mouse was drawn last frame, to spread this frame's light from. */
  private shownAt: { x: number; y: number } | null = null;
  private shake: { x: number; t: number; dir: number }[] = [];

  private painting = false;
  private paint: PaintPoint[] = [];
  private paintState = blankState();

  private backdrop: 'none' | 'pending' | 'ready' = 'none';
  private backdropSince = 0;
  private previews: Preview[] = [];

  /** Put the canvases in `host`, a layer over the whole screen. */
  mount(host: HTMLElement): () => void {
    this.host = host;
    this.update();
    return () => {
      this.stop();
      this.releaseCanvases();
      this.host = null;
      this.update();
    };
  }

  /** The screen's size in CSS pixels. */
  setViewport(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.sizeCanvases();
  }

  setSettings(settings: CursorEffectSettings): void {
    const before = this.settings;
    this.settings = settings;
    // An imported package loads in the background; a choice changed again
    // meanwhile wins.
    if (settings.trail !== before.trail) {
      this.trail = null;
      this.trailState = blankState();
      void resolve(settings.trail, TRAIL_EFFECTS, 'trail').then((e) => {
        if (this.settings.trail === settings.trail) this.trail = e;
      });
    }
    if (settings.click !== before.click) {
      this.click = null;
      void resolve(settings.click, CLICK_EFFECTS, 'click').then((e) => {
        if (this.settings.click === settings.click) this.click = e;
      });
    }
    if (!settings.showMouse) this.showing = false;
    if (!settings.firePaint) {
      this.paint = [];
      this.scene.clear('paint');
    }
    this.update();
  }

  /** Whether effects may run at all: not while the system asks for reduced motion. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.scene.clear();
      this.paint = [];
      this.previews = [];
      this.water?.calm();
    }
    this.update();
  }

  /** The pointer's picture, for Mouse Trails' copies of it. */
  setCursorImage(image: CursorImage | null): void {
    this.scene.cursor = image;
  }

  /** The theme's color for effects to take on, or null for their own colors. */
  setTint(tint: Rgb | null): void {
    this.scene.setTint(tint);
  }

  /** Super+Shift+K: ring the pointer, or stop. */
  toggleShowMouse(): void {
    if (!this.enabled || !this.settings.showMouse) return;
    this.showing = !this.showing;
    this.shownUntil = 0;
    this.wake();
  }

  /** Super+Shift+C: put out Fire Paint. */
  clearPaint(): void {
    this.paint = [];
    this.scene.clear('paint');
  }

  /** Power mode's sparks from the caret at (x, y), in the text's color. */
  sparks(x: number, y: number, color: Rgb): void {
    if (!this.enabled || !this.host) return;
    sparks(this.scene, x, y, color);
    this.wake();
  }

  /** Show off an effect inside `rect` (CSS pixels of the screen), as Settings does on choosing one. */
  preview(kind: PreviewKind, id: string, rect: { x: number; y: number; width: number; height: number }): void {
    if (!this.enabled || !this.host) return;
    const run: Preview = { kind, trail: null, click: null, rect, age: 0, last: null, state: blankState(), clicks: 0 };
    if (kind === 'trail') void resolve(id, TRAIL_EFFECTS, 'trail').then((e) => (run.trail = e));
    if (kind === 'click') void resolve(id, CLICK_EFFECTS, 'click').then((e) => (run.click = e));
    this.previews = [...this.previews.filter((p) => p.kind !== kind), run];
    this.wake();
  }

  // -------------------------------------------------------------------------

  private get wanted(): boolean {
    const s = this.settings;
    return this.enabled && !!this.host && (s.trail !== 'none' || s.click !== 'none' || s.showMouse || s.firePaint || s.water);
  }

  /** Listen to the pointer while any effect is on. */
  private update(): void {
    if (this.wanted && !this.listening) this.listening = this.listen();
    else if (!this.wanted && this.listening) {
      this.listening();
      this.listening = null;
      this.pointer = null;
      this.pressed = false;
      this.painting = false;
    }
    if (!this.wanted && !this.previews.length) this.paint = [];
  }

  private listen(): () => void {
    const onMove = (e: PointerEvent) => {
      // Trusted moves know the buttons; ones replayed from pages don't.
      if (e.isTrusted) this.pressed = e.buttons !== 0;
      const events = e.isTrusted && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const c of events.length ? events : [e]) this.moveTo(c.clientX, c.clientY, c.timeStamp || e.timeStamp, e);
    };
    const onDown = (e: PointerEvent) => {
      if (this.settings.firePaint && e.metaKey && e.shiftKey && e.button === 0) {
        // Fire Paint has the press: the window under it mustn't start a Super+drag.
        e.preventDefault();
        e.stopImmediatePropagation();
        this.painting = true;
        this.paintState = blankState();
        this.addPaint(e.clientX, e.clientY);
        window.addEventListener('click', (c) => c.stopImmediatePropagation(), { capture: true, once: true });
        this.pointer = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        return;
      }
      this.pressed = true;
      this.pointer = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (this.click && e.button >= 0 && e.button <= 2) {
        this.click.click(this.scene, e.clientX, e.clientY, this.ensureWater(this.click.water));
        this.wake();
      }
    };
    const onUp = () => {
      this.pressed = false;
      this.painting = false;
    };
    const onBlur = () => {
      onUp();
      this.pointer = null;
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', onBlur);
    const unsubscribe = getGuestInput()?.onInput((input) => {
      if (input.type === 'up') onUp();
    });
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onBlur);
      unsubscribe?.();
    };
  }

  private moveTo(x: number, y: number, t: number, e: PointerEvent): void {
    const from = this.pointer;
    this.pointer = { x, y, t };
    if (!from || t - from.t > STROKE_GAP_MS || (from.x === x && from.y === y)) return;
    const dt = Math.max(1, t - from.t);
    let active = false;

    if (this.painting) {
      along({ ...this.strokeBase(from, x, y, dt), state: this.paintState }, 6, (px, py) => this.addPaint(px, py));
      active = true;
    } else if (this.settings.water && e.metaKey && e.ctrlKey) {
      const water = this.ensureWater(true);
      along({ ...this.strokeBase(from, x, y, dt), state: this.paintState }, 8, (px, py) => water?.disturb(px, py, 16, 0.9));
      active = true;
    }
    if (this.trail) {
      const water = this.ensureWater(this.trail.water);
      this.trail.stroke({ ...this.strokeBase(from, x, y, dt), water, state: this.trailState });
      active = true;
    }
    if (this.settings.showMouse) {
      this.detectShake(x, t);
      if (this.showing || this.shownUntil > t) active = true;
    }
    if (active) this.wake();
  }

  private strokeBase(from: { x: number; y: number }, x: number, y: number, dt: number): Omit<Stroke, 'state'> {
    return { scene: this.scene, x0: from.x, y0: from.y, x1: x, y1: y, dt, pressed: this.pressed, water: null };
  }

  /** Four quick turns left and right within a moment is a shake. */
  private detectShake(x: number, t: number): void {
    const last = this.shake[this.shake.length - 1];
    if (!last) {
      this.shake.push({ x, t, dir: 0 });
      return;
    }
    const dx = x - last.x;
    if (Math.abs(dx) < 30) return;
    const dir = Math.sign(dx);
    if (dir === last.dir) last.x = x;
    else this.shake.push({ x, t, dir });
    this.shake = this.shake.filter((s) => t - s.t < 700);
    if (this.shake.length >= 5) {
      this.shake = [];
      this.shownUntil = t + SHAKE_SHOW_MS;
      this.wake();
    }
  }

  private addPaint(x: number, y: number): void {
    if (this.paint.length < 4000) this.paint.push({ x, y, age: this.scene.random() * -200 });
    this.wake();
  }

  // -------------------------------------------------------------------------

  private ensureCanvas(): CanvasRenderingContext2D | null {
    if (this.ctx) return this.ctx;
    if (!this.host) return null;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;visibility:hidden';
    this.host.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    return this.ctx;
  }

  /** The water, for effects that stir it; null when they don't or WebGL2 is missing. */
  private ensureWater(needed: boolean | undefined): Water | null {
    if (!needed || !this.host) return null;
    if (!this.water) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden';
      this.host.prepend(canvas);
      this.waterCanvas = canvas;
      this.water = new Water(canvas);
      this.sizeCanvases();
    }
    if (!this.water.available) return null;
    if (!this.water.moving && this.backdrop === 'none') this.takeBackdrop();
    return this.water;
  }

  /**
   * Snapshot the screen for the water to bend, while it's still calm. Until
   * it arrives the water isn't drawn, so it can't end up in its own picture.
   */
  private takeBackdrop(): void {
    const capture = getScreenshotBridge()?.captureRegion;
    this.backdropSince = performance.now();
    if (!capture) {
      this.backdrop = 'ready';
      return;
    }
    this.backdrop = 'pending';
    capture
      .call(getScreenshotBridge(), { x: 0, y: 0, width: 100_000, height: 100_000 }, { scale: 0.5 })
      .then(async (shot) => {
        const image = new Image();
        image.src = shot.dataUrl;
        await image.decode();
        return image;
      })
      .then(
        (image) => {
          if (this.backdrop === 'pending' && this.water?.moving) this.water.setBackground(image);
        },
        () => {},
      )
      .finally(() => {
        if (this.backdrop === 'pending') this.backdrop = 'ready';
      });
  }

  private sizeCanvases(): void {
    this.water?.resize(this.width, this.height, 1);
  }

  /** Free the canvases' memory; they're made again when next needed. */
  private releaseCanvases(): void {
    window.clearTimeout(this.idleTimer);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.water?.dispose();
    this.waterCanvas?.remove();
    this.water = null;
    this.waterCanvas = null;
    this.backdrop = 'none';
    this.area = null;
    this.canvasSize = { width: 0, height: 0, scale: 0 };
  }

  private wake(): void {
    window.clearTimeout(this.idleTimer);
    // From inside a tick (a preview painting), the tick itself goes on.
    if (this.frame || this.ticking || !this.host) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    this.ticking = true;
    try {
      this.step(now);
    } finally {
      this.ticking = false;
    }
  };

  private step(now: number): void {
    const dt = Math.min(50, Math.max(0, now - this.last));
    this.last = now;

    this.runPreviews(dt);

    // Show Mouse, fading in and out.
    const shown = this.settings.showMouse && (this.showing || this.shownUntil > now);
    this.showStrength = Math.min(1, Math.max(0, this.showStrength + (shown ? dt : -dt) / SHOW_FADE_MS));
    if (this.showStrength > 0 && this.pointer) {
      this.showPhase += (dt / 1000) * SHOW_MOUSE_SPIN;
      showMouse(this.scene, this.pointer.x, this.pointer.y, this.showPhase, dt, this.showStrength, this.shownAt ?? this.pointer);
      this.shownAt = { x: this.pointer.x, y: this.pointer.y };
    } else {
      this.shownAt = null;
    }

    const rate = Math.min(1, PAINT_FLAME_POINTS / Math.max(1, this.paint.length));
    for (const p of this.paint) {
      p.age += dt;
      if (p.age > 0) burnPoint(this.scene, p.x, p.y, 1 - p.age / PAINT_LIFE_MS, dt, rate);
    }
    if (!this.painting) this.paint = this.paint.filter((p) => p.age < PAINT_LIFE_MS);
    else for (const p of this.paint) p.age = Math.min(p.age, PAINT_LIFE_MS * 0.5);

    this.scene.step(dt);
    this.drawParticles();
    this.drawWater(dt, now);

    const busy =
      this.scene.busy || this.paint.length > 0 || this.showStrength > 0 || this.previews.length > 0 || !!this.water?.moving;
    if (busy) this.frame = requestAnimationFrame(this.tick);
    else this.idleTimer = window.setTimeout(() => this.releaseCanvases(), RELEASE_MS);
  }

  /**
   * Draw the particles on a canvas over just the part of the screen they're
   * in, snapped out to whole tiles. A canvas that changes is redrawn whole
   * by the compositor, with every backdrop blur under it: over the whole
   * screen, Show Mouse alone kept the desktop's glass recomputing every
   * frame. It follows the effect by moving, and only ever grows (until it's
   * released): sizing a canvas makes it anew, and on a GPU a canvas made
   * anew every few frames both costs a frame and can show its last picture
   * stretched to the new size for one.
   */
  private drawParticles(): void {
    const bounds = this.scene.busy ? this.scene.bounds() : null;
    const x = bounds ? Math.max(0, Math.floor((bounds.left - 4) / CANVAS_TILE) * CANVAS_TILE) : 0;
    const y = bounds ? Math.max(0, Math.floor((bounds.top - 4) / CANVAS_TILE) * CANVAS_TILE) : 0;
    const width = bounds ? Math.min(this.width, Math.ceil((bounds.right + 4) / CANVAS_TILE) * CANVAS_TILE) - x : 0;
    const height = bounds ? Math.min(this.height, Math.ceil((bounds.bottom + 4) / CANVAS_TILE) * CANVAS_TILE) - y : 0;
    if (width <= 0 || height <= 0) {
      if (this.canvas && this.area) this.canvas.style.visibility = 'hidden';
      this.area = null;
      return;
    }
    const ctx = this.ensureCanvas();
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const scale = window.devicePixelRatio || 1;
    const size = this.canvasSize;
    if (width > size.width || height > size.height || scale !== size.scale) {
      // Sizing a canvas clears it.
      this.canvasSize = { width: Math.max(width, size.width), height: Math.max(height, size.height), scale };
      canvas.width = Math.round(this.canvasSize.width * scale);
      canvas.height = Math.round(this.canvasSize.height * scale);
      canvas.style.width = `${this.canvasSize.width}px`;
      canvas.style.height = `${this.canvasSize.height}px`;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const was = this.area;
    if (!was || was.x !== x || was.y !== y) canvas.style.transform = `translate(${x}px, ${y}px)`;
    if (!was) canvas.style.visibility = 'visible';
    this.area = { x, y };
    ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    this.scene.draw(ctx);
  }

  private drawWater(dt: number, now: number): void {
    const water = this.water;
    if (!water || !this.waterCanvas) return;
    water.step(dt);
    if (!water.moving) {
      if (this.backdrop !== 'none') {
        water.calm();
        water.render();
        this.backdrop = 'none';
      }
      this.waterCanvas.style.visibility = 'hidden';
      return;
    }
    if (this.backdrop === 'pending' && now - this.backdropSince < BACKDROP_WAIT_MS) return;
    water.render();
    this.waterCanvas.style.visibility = 'visible';
  }

  private runPreviews(dt: number): void {
    for (const run of this.previews) {
      run.age += dt;
      const { x, y, width, height } = run.rect;
      const t = Math.min(1, run.age / PREVIEW_MS);
      // A figure of eight across the middle of the rectangle.
      const angle = t * Math.PI * 2;
      const point = {
        x: x + width / 2 + Math.sin(angle) * width * 0.36,
        y: y + height / 2 + Math.sin(angle * 2) * height * 0.28,
      };
      const from = run.last;
      run.last = point;
      if (run.kind === 'trail' && run.trail && from) {
        run.trail.stroke({ ...this.strokeBase(from, point.x, point.y, dt), water: this.ensureWater(run.trail.water), state: run.state });
      } else if (run.kind === 'click' && run.click) {
        const due = Math.min(3, Math.floor(run.age / 450) + 1);
        while (run.clicks < due) {
          const at = [0.3, 0.7, 0.5][run.clicks];
          run.click.click(this.scene, x + width * at, y + height * (run.clicks === 2 ? 0.65 : 0.4), this.ensureWater(run.click.water));
          run.clicks++;
        }
      } else if (run.kind === 'show-mouse') {
        const strength = Math.min(1, Math.min(run.age, PREVIEW_MS - run.age) / SHOW_FADE_MS);
        if (strength > 0) showMouse(this.scene, point.x, point.y, (run.age / 1000) * SHOW_MOUSE_SPIN, dt, strength, from ?? point);
      } else if (run.kind === 'fire-paint' && from && t < 0.6) {
        along({ ...this.strokeBase(from, point.x, point.y, dt), state: run.state }, 5, (px, py) => this.addPaint(px, py));
      } else if (run.kind === 'water' && from) {
        const water = this.ensureWater(true);
        along({ ...this.strokeBase(from, point.x, point.y, dt), state: run.state }, 8, (px, py) => water?.disturb(px, py, 16, 0.9));
      }
    }
    this.previews = this.previews.filter((p) => p.age < PREVIEW_MS);
  }
}

/** The one engine; CursorEffectsLayer gives it its layer and settings. */
export const cursorEffects = new CursorEffectsEngine();
