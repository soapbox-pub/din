/** Each system's colors and box shape, and a game's backdrop picture, for what Games draws. */
import type { Game } from '@/lib/games';

/** Each system's colors for the covers Din makes: two stops of a gradient. */
const SYSTEM_COLORS: Record<string, [string, string]> = {
  nes: ['#8b1e2d', '#3b0d14'],
  fds: ['#b8860b', '#4a3505'],
  snes: ['#5b4a9e', '#221a45'],
  virtualboy: ['#b3141f', '#2a0306'],
  n64: ['#1f7a3d', '#0b2e17'],
  gb: ['#6f7f3a', '#2a3214'],
  gbc: ['#7a3fa0', '#2c1340'],
  gba: ['#3b3fa0', '#14164a'],
  gamecube: ['#5a3fa8', '#1d1245'],
  nds: ['#5a6470', '#1e2328'],
  wii: ['#6b8fb5', '#24384f'],
  '3ds': ['#b81e3a', '#460a15'],
  switch: ['#e60012', '#4a0006'],
  mastersystem: ['#a51d24', '#3a080b'],
  genesis: ['#1d4fa5', '#0a1c3d'],
  gamegear: ['#2b2b2b', '#0a0a0a'],
  dreamcast: ['#e8742a', '#5a2a0b'],
  psx: ['#4d5a68', '#1a1f25'],
  ps2: ['#1b3c8c', '#0a1638'],
  pcengine: ['#d24b1e', '#4d1709'],
  ngp: ['#2a6fb5', '#0e2845'],
  ngpc: ['#2a8fa5', '#0d3540'],
  wonderswan: ['#5a8a5a', '#1f331f'],
  wonderswancolor: ['#8a5a9a', '#321f3a'],
  atari2600: ['#8a5a2a', '#33200d'],
  atari7800: ['#3a3a5a', '#141420'],
};

export function systemColors(system: string): [string, string] {
  return SYSTEM_COLORS[system] ?? ['#4b5563', '#1f2937'];
}

/** The shape of a box in a list that mixes systems, and of a system's whose shape isn't known. */
export const DEFAULT_BOX_SHAPE = 3 / 4;

/**
 * Each system's box, width over height, as libretro-thumbnails has its front
 * covers (the median of its USA covers, measured): the shape of the tiles in a
 * list of the system's games, so its boxes fill them and stand in even rows.
 * Covers of another shape (a Japanese Super Famicom box among American Super
 * Nintendo ones) fit inside.
 */
const BOX_SHAPES: Record<string, number> = {
  nes: 5 / 7,
  fds: 1,
  snes: 4 / 3, // USA and Europe 1.4, Japan 0.55
  virtualboy: 1,
  n64: 4 / 3, // USA and Europe 1.37, Japan 0.71
  gb: 1,
  gbc: 1,
  gba: 4 / 5, // some 1, some 0.55
  gamecube: 5 / 7,
  nds: 9 / 8,
  wii: 5 / 7,
  '3ds': 9 / 8,
  mastersystem: 5 / 7,
  genesis: 5 / 7,
  gamegear: 5 / 7,
  dreamcast: 1,
  psx: 1,
  ps2: 5 / 7,
  ngp: 7 / 8,
  ngpc: 1,
  atari2600: 5 / 7,
  atari7800: 5 / 7,
};

export function boxShape(system: string): number {
  return BOX_SHAPES[system] ?? DEFAULT_BOX_SHAPE;
}

/** A screenshot or title screen of a game, for a backdrop, or null to show none. */
export function backdropOf(game: Game | null, resume?: string | null): string | null {
  return resume ?? game?.art?.snap ?? game?.art?.title ?? game?.art?.boxart ?? null;
}
