/**
 * Imported effect packages (the effects and trails of CursorFX files, see
 * src/lib/systemCursor.ts) made ready to play: each animation's frames as
 * one image, and the trail and click effects that play them.
 */

import type { ClickEffect, TrailEffect } from '@/lib/cursorEffects/effects';
import type { Sheet } from '@/lib/cursorEffects/scene';
import { type CursorEffectPackage, type EffectSprite, getSystemCursorBridge } from '@/lib/systemCursor';

/** How a choice names an imported package. */
export const PACKAGE_PREFIX = 'cursorfx:';

export interface LoadedPackage {
  id: string;
  name: string;
  trail: TrailEffect | null;
  click: ClickEffect | null;
  /** The animations, for pictures of the package. */
  trailSheet: Sheet | null;
  clickSheet: Sheet | null;
}

const loaded = new Map<string, Promise<LoadedPackage | null>>();

async function sheetFrom(sprite: EffectSprite): Promise<Sheet> {
  const width = sprite.width * sprite.frameCount;
  const pixels = new Uint8ClampedArray(sprite.pixels.length);
  pixels.set(sprite.pixels);
  const source = await createImageBitmap(new ImageData(pixels, width, sprite.height));
  return {
    source,
    width: sprite.width,
    height: sprite.height,
    hotX: sprite.hotX,
    hotY: sprite.hotY,
    steps: sprite.steps,
    duration: sprite.steps.reduce((sum, s) => sum + s.delay, 0),
  };
}

async function make(pkg: CursorEffectPackage): Promise<LoadedPackage> {
  const id = `${PACKAGE_PREFIX}${pkg.id}`;
  // Din plays an effect on every press, whichever event it was made for;
  // one made for a left press is the likeliest to look right there.
  const effect = pkg.effects.find((e) => e.event === 0) ?? pkg.effects[0];
  const clickSheet = effect ? await sheetFrom(effect) : null;
  const trailSheet = pkg.trail ? await sheetFrom(pkg.trail) : null;
  const mode = pkg.trail?.mode ?? 'always';
  const interval = 1000 / (pkg.trail?.rate ?? 20);
  return {
    id,
    name: pkg.name,
    trailSheet,
    clickSheet,
    // CursorFX lays a trail so many times a second while the pointer moves.
    trail: trailSheet && {
      id,
      name: pkg.name,
      group: 'magic',
      stroke: (s) => {
        if ((mode === 'down' && !s.pressed) || (mode === 'up' && s.pressed)) return;
        s.state.carry += s.dt;
        const steps = Math.min(10, Math.floor(s.state.carry / interval));
        for (let i = 1; i <= steps; i++) {
          const f = i / steps;
          s.scene.play(trailSheet, s.x0 + (s.x1 - s.x0) * f, s.y0 + (s.y1 - s.y0) * f);
        }
        s.state.carry -= steps * interval;
        if (s.state.carry > interval) s.state.carry = 0;
      },
    },
    click: clickSheet && {
      id,
      name: pkg.name,
      group: 'magic',
      click: (scene, x, y) => scene.play(clickSheet, x, y),
    },
  };
}

/** A package, ready to play, by its choice id (`cursorfx:…`); null if it's gone. */
export function loadPackage(choice: string): Promise<LoadedPackage | null> {
  let promise = loaded.get(choice);
  if (!promise) {
    const bridge = getSystemCursorBridge();
    promise = bridge
      ? bridge.effect(choice.slice(PACKAGE_PREFIX.length)).then((pkg) => (pkg ? make(pkg) : null), () => null)
      : Promise.resolve(null);
    loaded.set(choice, promise);
  }
  return promise;
}

/** Forget a package, after it's removed or imported anew. */
export function forgetPackage(choice: string): void {
  loaded.delete(choice);
}
