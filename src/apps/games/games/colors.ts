/** Each system's colors, and a game's backdrop picture, for what Games draws. */
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

/** A screenshot or title screen of a game, for a backdrop, or null to show none. */
export function backdropOf(game: Game | null, resume?: string | null): string | null {
  return resume ?? game?.art?.snap ?? game?.art?.title ?? game?.art?.boxart ?? null;
}
