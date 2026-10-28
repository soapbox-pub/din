import type { Color } from './raster';

export interface PalettePreset {
  id: string;
  name: string;
  colors: Color[];
}

export const PALETTES: PalettePreset[] = [
  {
    id: 'classic',
    name: 'Classic',
    colors: [
      '#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080', '#800080', '#808040', '#004040', '#0080ff', '#004080', '#8000ff', '#804000',
      '#ffffff', '#c0c0c0', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffff80', '#00ff80', '#80ffff', '#8080ff', '#ff0080', '#ff8040',
    ],
  },
  {
    id: 'crayons',
    name: 'Crayon Box',
    colors: [
      '#000000', '#ed0a3f', '#ff8833', '#fbe870', '#3aa655', '#0095b7', '#6456b7', '#ff3399', '#8b5a2b', '#ffb97b', '#c5e17a', '#29ab87', '#93ccea', '#c364c5',
      '#ffffff', '#ff5349', '#ffae42', '#fff44f', '#87ff2a', '#00ccff', '#7070cc', '#fc80a5', '#d2b48c', '#ffcba4', '#bdda57', '#1cac78', '#c9c0bb', '#8e3179',
    ],
  },
  {
    id: 'underground',
    name: 'Underground',
    colors: [
      '#000000', '#ffffff', '#ff0000', '#ff8000', '#ffff00', '#00c000', '#42fcff', '#003cff', '#d535d9', '#808080', '#404040', '#c0c0c0', '#a0522d', '#ffc0cb',
    ],
  },
  {
    id: 'pico8',
    name: 'PICO-8',
    colors: [
      '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
      '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
    ],
  },
  {
    id: 'gameboy',
    name: 'Game Boy',
    colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  },
  {
    id: 'cga',
    name: 'CGA',
    colors: ['#000000', '#55ffff', '#ff55ff', '#ffffff', '#0000aa', '#00aa00', '#aa0000', '#aa5500', '#555555', '#5555ff', '#55ff55', '#ff5555', '#ffff55', '#aaaaaa', '#00aaaa', '#aa00aa'],
  },
];

export interface StampGroup {
  name: string;
  stamps: string[];
}

export const STAMPS: StampGroup[] = [
  { name: 'Critters', stamps: ['🐱', '🐶', '🐸', '🐙', '🦋', '🐝', '🐞', '🐢', '🦄', '🐠', '🦀', '🦖', '🐧', '🐷', '🐌', '🦉'] },
  { name: 'Snacks', stamps: ['🍕', '🍩', '🍓', '🍉', '🍔', '🍦', '🧁', '🍪', '🥕', '🍌', '🍝', '🥧'] },
  { name: 'Outside', stamps: ['🌵', '🌸', '🌻', '🍄', '🌳', '🌈', '⭐', '🌙', '☀️', '⚡', '❄️', '🔥', '💧', '☁️', '🌊', '🪨'] },
  { name: 'Stuff', stamps: ['🏠', '🏰', '🚀', '🛸', '🚗', '🚂', '⛵', '🎈', '🎁', '👑', '💎', '🗝️', '⚔️', '🛡️', '🎸', '⚽'] },
  { name: 'Spooky', stamps: ['❤️', '💀', '🦴', '🐐', '🌼', '🐕', '👻', '🤖', '👽', '🎃', '🕷️', '🧙', '🐉', '👁️', '🕯️', '⚰️'] },
  { name: 'Faces', stamps: ['😀', '😎', '🤪', '😱', '🥺', '😡', '🤠', '🥳', '😴', '🤡', '👀', '👄', '👍', '✌️', '👋', '💩'] },
];

export const STAMP_SIZES = [16, 24, 32, 48, 64, 96, 128];

export type WackyId = 'rainbow' | 'sparkle' | 'drip' | 'bubbles' | 'kaleido' | 'dots' | 'grass' | 'zigzag';

export const WACKY: { id: WackyId; name: string; emoji: string }[] = [
  { id: 'rainbow', name: 'Rainbow', emoji: '🌈' },
  { id: 'sparkle', name: 'Sparkles', emoji: '✨' },
  { id: 'drip', name: 'Drippy', emoji: '💧' },
  { id: 'bubbles', name: 'Bubbles', emoji: '🫧' },
  { id: 'kaleido', name: 'Kaleidoscope', emoji: '❄️' },
  { id: 'dots', name: 'Leaky Pen', emoji: '🖊️' },
  { id: 'grass', name: 'Grass', emoji: '🌱' },
  { id: 'zigzag', name: 'Zig-Zag', emoji: '⚡' },
];

export type PatternId = 'solid' | 'checks' | 'stripes' | 'dots' | 'bricks' | 'rainbow' | 'gradient' | 'noise';

export const PATTERNS: { id: PatternId; name: string }[] = [
  { id: 'solid', name: 'Solid' },
  { id: 'checks', name: 'Checks' },
  { id: 'stripes', name: 'Stripes' },
  { id: 'dots', name: 'Polka Dots' },
  { id: 'bricks', name: 'Bricks' },
  { id: 'rainbow', name: 'Rainbow' },
  { id: 'gradient', name: 'Fade' },
  { id: 'noise', name: 'Dither' },
];

export const FONTS: { id: string; name: string; css: string }[] = [
  { id: 'sans', name: 'Sans', css: '"Noto Sans", Arial, sans-serif' },
  { id: 'serif', name: 'Serif', css: '"Noto Serif", "Times New Roman", serif' },
  { id: 'mono', name: 'Mono', css: '"Noto Sans Mono", "Courier New", monospace' },
  { id: 'comic', name: 'Comic', css: '"Comic Sans MS", "Comic Neue", "Chalkboard SE", cursive' },
  { id: 'fancy', name: 'Fancy', css: 'fantasy' },
];

export const FONT_SIZES = [8, 10, 12, 14, 16, 20, 24, 32, 48, 72];

export const CANVAS_PRESETS: { name: string; width: number; height: number }[] = [
  { name: '16 × 16 sprite', width: 16, height: 16 },
  { name: '32 × 32 sprite', width: 32, height: 32 },
  { name: '64 × 64 sprite', width: 64, height: 64 },
  { name: '320 × 240 game screen', width: 320, height: 240 },
  { name: '640 × 480 VGA', width: 640, height: 480 },
  { name: '800 × 600 SVGA', width: 800, height: 600 },
  { name: '1280 × 720 HD', width: 1280, height: 720 },
];

export const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
