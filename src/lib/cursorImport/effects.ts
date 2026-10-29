/**
 * Effect packages: what the converter makes of a CursorFX file's on-click
 * effects and trail (src/lib/cursorImport/cursorfx.ts). Electron's main
 * process checks one and keeps it for Din's cursor effects to play
 * (electron/cursorImport.mts, src/lib/cursorEffects).
 */

/** The events CursorFX can give an effect, by index. */
export const EFFECT_EVENTS = [
  'left-down',
  'left-up',
  'left-double',
  'middle-down',
  'middle-up',
  'middle-double',
  'right-down',
  'right-up',
  'right-double',
] as const;

/** When a trail is laid: always, only while a button is down, or only while none is. */
export type TrailMode = 'always' | 'down' | 'up';

/** An animation played once where the pointer is. */
export interface EffectSprite {
  /** One frame's size. */
  width: number;
  height: number;
  /** The point in a frame that lands on the pointer. */
  hotX: number;
  hotY: number;
  frameCount: number;
  /** Straight RGBA, the frames side by side: `width * frameCount` × `height`. */
  pixels: Uint8Array;
  /** The frames in the order they play, each with how long it shows, in ms. */
  steps: { index: number; delay: number }[];
}

export interface ConvertedEffects {
  name: string;
  /** On-click effects, at most one per event. */
  effects: (EffectSprite & { event: number })[];
  /** Its trail, laid `rate` times a second while the pointer moves. */
  trail: (EffectSprite & { mode: TrailMode; rate: number }) | null;
}
