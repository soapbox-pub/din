import type { SheetName } from './skin';

/** [sheet, x, y, width, height] of each piece of a classic skin. */
export type SpriteDef = readonly [SheetName, number, number, number, number];

export const SPRITES = {
  mainBg: ['main', 0, 0, 275, 116],
  titleActive: ['titlebar', 27, 0, 275, 14],
  title: ['titlebar', 27, 15, 275, 14],
  shadeActive: ['titlebar', 27, 29, 275, 14],
  shade: ['titlebar', 27, 42, 275, 14],
  options: ['titlebar', 0, 0, 9, 9],
  optionsDown: ['titlebar', 0, 9, 9, 9],
  minimize: ['titlebar', 9, 0, 9, 9],
  minimizeDown: ['titlebar', 9, 9, 9, 9],
  close: ['titlebar', 18, 0, 9, 9],
  closeDown: ['titlebar', 18, 9, 9, 9],
  shadeBtn: ['titlebar', 0, 18, 9, 9],
  shadeBtnDown: ['titlebar', 9, 18, 9, 9],
  unshadeBtn: ['titlebar', 0, 27, 9, 9],
  unshadeBtnDown: ['titlebar', 9, 27, 9, 9],
  clutter: ['titlebar', 304, 0, 8, 43],
  clutterO: ['titlebar', 304, 47, 8, 8],
  clutterA: ['titlebar', 312, 55, 8, 7],
  clutterI: ['titlebar', 320, 62, 8, 7],
  clutterD: ['titlebar', 328, 69, 8, 8],
  clutterV: ['titlebar', 336, 77, 8, 7],
  shadePosBg: ['titlebar', 0, 36, 17, 7],
  shadePosThumb: ['titlebar', 20, 36, 3, 7],
  shadePosThumbLeft: ['titlebar', 17, 36, 3, 7],
  shadePosThumbRight: ['titlebar', 23, 36, 3, 7],

  prev: ['cbuttons', 0, 0, 23, 18],
  prevDown: ['cbuttons', 0, 18, 23, 18],
  play: ['cbuttons', 23, 0, 23, 18],
  playDown: ['cbuttons', 23, 18, 23, 18],
  pause: ['cbuttons', 46, 0, 23, 18],
  pauseDown: ['cbuttons', 46, 18, 23, 18],
  stop: ['cbuttons', 69, 0, 23, 18],
  stopDown: ['cbuttons', 69, 18, 23, 18],
  next: ['cbuttons', 92, 0, 22, 18],
  nextDown: ['cbuttons', 92, 18, 22, 18],
  eject: ['cbuttons', 114, 0, 22, 16],
  ejectDown: ['cbuttons', 114, 16, 22, 16],

  repeat: ['shufrep', 0, 0, 28, 15],
  repeatDown: ['shufrep', 0, 15, 28, 15],
  repeatOn: ['shufrep', 0, 30, 28, 15],
  repeatOnDown: ['shufrep', 0, 45, 28, 15],
  shuffle: ['shufrep', 28, 0, 47, 15],
  shuffleDown: ['shufrep', 28, 15, 47, 15],
  shuffleOn: ['shufrep', 28, 30, 47, 15],
  shuffleOnDown: ['shufrep', 28, 45, 47, 15],
  eqBtn: ['shufrep', 0, 61, 23, 12],
  eqBtnOn: ['shufrep', 0, 73, 23, 12],
  eqBtnDown: ['shufrep', 46, 61, 23, 12],
  eqBtnOnDown: ['shufrep', 46, 73, 23, 12],
  plBtn: ['shufrep', 23, 61, 23, 12],
  plBtnOn: ['shufrep', 23, 73, 23, 12],
  plBtnDown: ['shufrep', 69, 61, 23, 12],
  plBtnOnDown: ['shufrep', 69, 73, 23, 12],

  stereo: ['monoster', 0, 12, 29, 12],
  stereoOn: ['monoster', 0, 0, 29, 12],
  mono: ['monoster', 29, 12, 27, 12],
  monoOn: ['monoster', 29, 0, 27, 12],

  playing: ['playpaus', 0, 0, 9, 9],
  paused: ['playpaus', 9, 0, 9, 9],
  stopped: ['playpaus', 18, 0, 9, 9],
  working: ['playpaus', 39, 0, 3, 9],
  notWorking: ['playpaus', 36, 0, 3, 9],

  posBg: ['posbar', 0, 0, 248, 10],
  posThumb: ['posbar', 248, 0, 29, 10],
  posThumbDown: ['posbar', 278, 0, 29, 10],

  volThumb: ['volume', 15, 422, 14, 11],
  volThumbDown: ['volume', 0, 422, 14, 11],
  balThumb: ['balance', 15, 422, 14, 11],
  balThumbDown: ['balance', 0, 422, 14, 11],

  eqBg: ['eqmain', 0, 0, 275, 116],
  eqTitleActive: ['eqmain', 0, 134, 275, 14],
  eqTitle: ['eqmain', 0, 149, 275, 14],
  eqClose: ['eqmain', 0, 116, 9, 9],
  eqCloseDown: ['eqmain', 0, 125, 9, 9],
  eqOn: ['eqmain', 10, 119, 26, 12],
  eqOnDown: ['eqmain', 128, 119, 26, 12],
  eqOnSel: ['eqmain', 69, 119, 26, 12],
  eqOnSelDown: ['eqmain', 187, 119, 26, 12],
  eqAuto: ['eqmain', 36, 119, 32, 12],
  eqAutoDown: ['eqmain', 154, 119, 32, 12],
  eqAutoSel: ['eqmain', 95, 119, 32, 12],
  eqAutoSelDown: ['eqmain', 213, 119, 32, 12],
  eqThumb: ['eqmain', 0, 164, 11, 11],
  eqThumbDown: ['eqmain', 0, 176, 11, 11],
  eqPresets: ['eqmain', 224, 164, 44, 12],
  eqPresetsDown: ['eqmain', 224, 176, 44, 12],
  eqGraphBg: ['eqmain', 0, 294, 113, 19],
  eqPreampLine: ['eqmain', 0, 314, 113, 1],

  eqShadeActive: ['eq_ex', 0, 0, 275, 14],
  eqShade: ['eq_ex', 0, 15, 275, 14],
  eqShadeVolLeft: ['eq_ex', 1, 30, 3, 7],
  eqShadeVolCenter: ['eq_ex', 4, 30, 3, 7],
  eqShadeVolRight: ['eq_ex', 7, 30, 3, 7],
  eqShadeBalLeft: ['eq_ex', 11, 30, 3, 7],
  eqShadeBalCenter: ['eq_ex', 14, 30, 3, 7],
  eqShadeBalRight: ['eq_ex', 17, 30, 3, 7],
  eqMaxDown: ['eq_ex', 1, 38, 9, 9],
  eqMinDown: ['eq_ex', 1, 47, 9, 9],
  eqShadeClose: ['eq_ex', 11, 38, 9, 9],
  eqShadeCloseDown: ['eq_ex', 11, 47, 9, 9],

  plTopTile: ['pledit', 127, 21, 25, 20],
  plTopLeft: ['pledit', 0, 21, 25, 20],
  plTitle: ['pledit', 26, 21, 100, 20],
  plTopRight: ['pledit', 153, 21, 25, 20],
  plTopTileActive: ['pledit', 127, 0, 25, 20],
  plTopLeftActive: ['pledit', 0, 0, 25, 20],
  plTitleActive: ['pledit', 26, 0, 100, 20],
  plTopRightActive: ['pledit', 153, 0, 25, 20],
  plLeft: ['pledit', 0, 42, 12, 29],
  plRight: ['pledit', 31, 42, 20, 29],
  plBottomTile: ['pledit', 179, 0, 25, 38],
  plBottomLeft: ['pledit', 0, 72, 125, 38],
  plBottomRight: ['pledit', 126, 72, 150, 38],
  plVisBg: ['pledit', 205, 0, 75, 38],
  plShadeBg: ['pledit', 72, 57, 25, 14],
  plShadeLeft: ['pledit', 72, 42, 25, 14],
  plShadeRight: ['pledit', 99, 57, 50, 14],
  plShadeRightActive: ['pledit', 99, 42, 50, 14],
  plScroll: ['pledit', 52, 53, 8, 18],
  plScrollDown: ['pledit', 61, 53, 8, 18],
  plCloseDown: ['pledit', 52, 42, 9, 9],
  plCollapseDown: ['pledit', 62, 42, 9, 9],
  plExpandDown: ['pledit', 150, 42, 9, 9],
} as const satisfies Record<string, SpriteDef>;

export type SpriteName = keyof typeof SPRITES;

/** The playlist's pop-up menus: their buttons (bottom first) and bar. */
export const PL_MENUS = {
  add: { left: 14, bar: [48, 111, 3, 54], items: [[0, 149], [0, 130], [0, 111]] },
  rem: { left: 43, bar: [100, 111, 3, 72], items: [[54, 168], [54, 149], [54, 130], [54, 111]] },
  sel: { left: 72, bar: [150, 111, 3, 54], items: [[104, 149], [104, 130], [104, 111]] },
  misc: { left: 101, bar: [200, 111, 3, 54], items: [[154, 149], [154, 130], [154, 111]] },
  list: { left: -1, bar: [250, 111, 3, 54], items: [[204, 149], [204, 130], [204, 111]] },
} as const;

/** TEXT.BMP's grid position (row, column) of each character it has. */
export const FONT: Record<string, [number, number]> = (() => {
  const map: Record<string, [number, number]> = {};
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => (map[c] = [0, i]));
  map['"'] = [0, 26];
  map['@'] = [0, 27];
  map[' '] = [0, 30];
  '0123456789'.split('').forEach((c, i) => (map[c] = [1, i]));
  const row1 = ['…', '.', ':', '(', ')', '-', "'", '!', '_', '+', '\\', '/', '[', ']', '^', '&', '%', ',', '=', '$', '#'];
  row1.forEach((c, i) => (map[c] = [1, 10 + i]));
  ['å', 'ö', 'ä', '?', '*'].forEach((c, i) => (map[c] = [2, i]));
  map['<'] = [1, 22];
  map['>'] = [1, 23];
  map['{'] = [1, 22];
  map['}'] = [1, 23];
  return map;
})();
