// Effect packages: the on-click effects and trails that come in CursorFX
// files, which Din's cursor effects play (src/lib/cursorEffects). The
// converter reads them (src/lib/cursorImport/cursorfx.ts); cursorImport.mts
// checks what it sends back with checkEffects and has them written here,
// one directory per package in Din's own data: package.json with what's
// in it, and each animation's frames as raw RGBA beside it.
//
// They're read back the same careful way, since nothing stops another
// program writing there: every number in range, every file the size its
// frames say.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_PACKAGES = 16;
const MAX_EVENT = 8;
const MAX_FRAME_DIMENSION = 512;
const MAX_FRAMES = 256;
const MAX_STEPS = 4_096;
const MAX_DELAY = 3_600_000;
const MAX_RATE = 100;
const TRAIL_MODES = ['always', 'down', 'up'] as const;

/** A package's directory name. */
export const PACKAGE_ID = /^(?![-.])[A-Za-z0-9_.+-]{1,64}$/;

class EffectsError extends Error {}

export interface SpriteInfo {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  frameCount: number;
  steps: { index: number; delay: number }[];
}

export interface Sprite extends SpriteInfo {
  /** Straight RGBA, the frames side by side. */
  pixels: Uint8Array;
}

/** A package, without its pixels. */
export interface EffectPackageInfo {
  id: string;
  name: string;
  effects: (SpriteInfo & { event: number })[];
  trail: (SpriteInfo & { mode: (typeof TRAIL_MODES)[number]; rate: number }) | null;
}

export interface EffectPackage extends EffectPackageInfo {
  effects: (Sprite & { event: number })[];
  trail: (Sprite & { mode: (typeof TRAIL_MODES)[number]; rate: number }) | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function checkInfo(value: unknown): SpriteInfo {
  if (!isRecord(value)) throw new EffectsError();
  const { width, height, hotX, hotY, frameCount, steps } = value;
  if (
    !isInt(width, 1, MAX_FRAME_DIMENSION) ||
    !isInt(height, 1, MAX_FRAME_DIMENSION) ||
    !isInt(hotX, 0, width - 1) ||
    !isInt(hotY, 0, height - 1) ||
    !isInt(frameCount, 1, MAX_FRAMES) ||
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > MAX_STEPS
  ) {
    throw new EffectsError();
  }
  return {
    width,
    height,
    hotX,
    hotY,
    frameCount,
    steps: steps.map((step: unknown) => {
      if (!isRecord(step) || !isInt(step.index, 0, frameCount - 1) || !isInt(step.delay, 1, MAX_DELAY)) throw new EffectsError();
      return { index: step.index, delay: step.delay };
    }),
  };
}

function pixelBytes(info: SpriteInfo): number {
  return info.width * info.frameCount * info.height * 4;
}

function checkSprite(value: unknown): Sprite {
  const info = checkInfo(value);
  const { pixels } = value as { pixels?: unknown };
  if (!(pixels instanceof Uint8Array) || pixels.length !== pixelBytes(info)) throw new EffectsError();
  return { ...info, pixels };
}

function checkPackage<T extends SpriteInfo>(
  value: unknown,
  check: (sprite: unknown) => T,
): { name: string; effects: (T & { event: number })[]; trail: (T & { mode: (typeof TRAIL_MODES)[number]; rate: number }) | null } {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.effects)) throw new EffectsError();
  if (value.effects.length > MAX_EVENT + 1) throw new EffectsError();
  const effects = value.effects.map((effect: unknown) => {
    if (!isRecord(effect) || !isInt(effect.event, 0, MAX_EVENT)) throw new EffectsError();
    return { ...check(effect), event: effect.event };
  });
  let trail = null;
  if (value.trail !== null) {
    const raw = value.trail;
    if (!isRecord(raw) || !TRAIL_MODES.includes(raw.mode as never) || !isInt(raw.rate, 1, MAX_RATE)) throw new EffectsError();
    trail = { ...check(raw), mode: raw.mode as (typeof TRAIL_MODES)[number], rate: raw.rate };
  }
  if (!effects.length && !trail) throw new EffectsError();
  // eslint-disable-next-line no-control-regex
  const name = value.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 80) || 'Cursor effects';
  return { name, effects, trail };
}

/**
 * The converter's effect packages, every field checked; throws for anything
 * amiss. `charge` is told the bytes of their pixels, and throws past its limit.
 */
export function checkEffects(value: unknown, charge: (bytes: number) => void): Omit<EffectPackage, 'id'>[] {
  if (!Array.isArray(value) || value.length > MAX_PACKAGES) throw new EffectsError();
  return value.map((raw) => {
    const pkg = checkPackage(raw, checkSprite);
    for (const sprite of [...pkg.effects, ...(pkg.trail ? [pkg.trail] : [])]) charge(sprite.pixels.length);
    return pkg;
  });
}

/** A directory name made from a package's name. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_.+-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48) || 'effects'
  );
}

const strip = ({ pixels: _pixels, ...info }: Sprite) => info;

/**
 * Write packages into `base`, each replacing any of the same name, and
 * return their ids.
 */
export async function installEffects(packages: Omit<EffectPackage, 'id'>[], base: string): Promise<string[]> {
  await fs.mkdir(base, { recursive: true });
  const ids: string[] = [];
  for (const pkg of packages) {
    const stem = slug(pkg.name);
    let id = stem;
    for (let n = 2; ids.includes(id); n++) id = `${stem}-${n}`;
    const staging = await fs.mkdtemp(path.join(base, '.din-effects-'));
    try {
      const info = {
        name: pkg.name,
        effects: pkg.effects.map((effect) => ({ ...strip(effect), event: effect.event })),
        trail: pkg.trail ? { ...strip(pkg.trail), mode: pkg.trail.mode, rate: pkg.trail.rate } : null,
      };
      await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(info));
      for (const [i, effect] of pkg.effects.entries()) await fs.writeFile(path.join(staging, `effect-${i}.rgba`), effect.pixels);
      if (pkg.trail) await fs.writeFile(path.join(staging, 'trail.rgba'), pkg.trail.pixels);
      const dest = path.join(base, id);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(staging, dest);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    ids.push(id);
  }
  return ids;
}

async function readInfo(base: string, id: string): Promise<EffectPackageInfo | null> {
  if (!PACKAGE_ID.test(id)) return null;
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(base, id, 'package.json'), 'utf8'));
    return { id, ...checkPackage(raw, checkInfo) };
  } catch {
    return null;
  }
}

/** The installed packages, by name. */
export async function listEffects(base: string): Promise<EffectPackageInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    return [];
  }
  const found: EffectPackageInfo[] = [];
  for (const id of entries) {
    const info = await readInfo(base, id);
    if (info) found.push(info);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** One package with its pixels, or null if it's missing or damaged. */
export async function readEffects(base: string, id: string): Promise<EffectPackage | null> {
  const info = await readInfo(base, id);
  if (!info) return null;
  const load = async <T extends SpriteInfo>(sprite: T, file: string): Promise<T & { pixels: Uint8Array }> => {
    const pixels = new Uint8Array(await fs.readFile(path.join(base, id, file)));
    if (pixels.length !== pixelBytes(sprite)) throw new EffectsError();
    return { ...sprite, pixels };
  };
  try {
    return {
      ...info,
      effects: await Promise.all(info.effects.map((effect, i) => load(effect, `effect-${i}.rgba`))),
      trail: info.trail ? await load(info.trail, 'trail.rgba') : null,
    };
  } catch {
    return null;
  }
}

export async function removeEffects(base: string, id: string): Promise<void> {
  if (!PACKAGE_ID.test(id)) throw new Error('Not a cursor effect');
  await fs.rm(path.join(base, id), { recursive: true, force: true });
}
