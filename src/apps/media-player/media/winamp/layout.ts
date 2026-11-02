import type { MusicPrefs } from '../prefs';
import type { WinampSkin } from '@/shared/skins/winamp/skin';

export const MAIN_H = 116;
export const SHADE_H = 14;
export const W = 275;

/** The size of everything Winamp shows, unscaled. */
export function winampLayout(prefs: MusicPrefs['winamp'], skin: WinampSkin) {
  const mainH = prefs.mainShade ? SHADE_H : MAIN_H;
  const eqH = prefs.eq ? (prefs.eqShade && skin.sheets.eq_ex ? SHADE_H : MAIN_H) : 0;
  const plW = W + 25 * prefs.playlistW;
  const plH = prefs.playlist ? (prefs.playlistShade ? SHADE_H : MAIN_H + 29 * prefs.playlistH) : 0;
  return {
    mainH,
    eqH,
    plW,
    plH,
    width: Math.max(W, prefs.playlist ? plW : 0),
    height: mainH + eqH + plH,
  };
}
