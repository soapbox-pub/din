/**
 * The window effects on offer, and the user's choice of them. Each event
 * (minimize, close) takes an effect id, `random` (a different effect each
 * time, as Compiz offered), or one of two that don't use the engine: `none`
 * and, for close, `pop` - the quick CSS fade-and-shrink on the live window.
 */

import { ANIMATION_EFFECTS } from '@/lib/effects/animation';
import { ANIMATIONADDON_EFFECTS } from '@/lib/effects/animationaddon';
import { ANIMATIONPLUS_EFFECTS, ANIMATIONSIM_EFFECTS } from '@/lib/effects/animationplus';
import type { EffectGroup, WindowEffect } from '@/lib/effects/engine';

export type { WindowEffect } from '@/lib/effects/engine';
export { runWindowEffect } from '@/lib/effects/engine';

export type EffectEvent = 'minimize' | 'close';

export const WINDOW_EFFECTS: WindowEffect[] = [
  ...ANIMATION_EFFECTS,
  ...ANIMATIONADDON_EFFECTS,
  ...ANIMATIONPLUS_EFFECTS,
  ...ANIMATIONSIM_EFFECTS,
];

export const EFFECT_GROUPS: { id: EffectGroup; name: string }[] = [
  { id: 'animation', name: 'Animation' },
  { id: 'animationaddon', name: 'Animation Add-On' },
  { id: 'animationplus', name: 'Animation Plus' },
  { id: 'animationsim', name: 'Animation Sim' },
];

export const DEFAULT_MINIMIZE_EFFECT = 'magic-lamp';
export const DEFAULT_CLOSE_EFFECT = 'pop';

/** The effects offered for `event`. */
export function effectsFor(event: EffectEvent): WindowEffect[] {
  return event === 'close' ? WINDOW_EFFECTS.filter((e) => !e.minimizeOnly) : WINDOW_EFFECTS;
}

/**
 * What a choice comes to for one window: an engine effect, `none`, or
 * `pop`. `random` draws a fresh effect; an id this version doesn't know
 * (a setting from a newer Din) falls back to the default.
 */
export function resolveEffect(choice: string, event: EffectEvent): WindowEffect | 'none' | 'pop' {
  if (choice === 'none') return 'none';
  if (choice === 'pop' && event === 'close') return 'pop';
  const offered = effectsFor(event);
  if (choice === 'random') return offered[Math.floor(Math.random() * offered.length)];
  const found = offered.find((e) => e.id === choice);
  if (found) return found;
  return event === 'close' ? 'pop' : (offered.find((e) => e.id === DEFAULT_MINIMIZE_EFFECT) ?? offered[0]);
}
