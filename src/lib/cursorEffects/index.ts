/**
 * Cursor effects on offer: trails and click effects, built in or imported
 * from CursorFX files, and Compiz's Show Mouse, Fire Paint and Water.
 * See engine.ts for how they're played.
 */

export { CLICK_EFFECTS, TRAIL_EFFECTS } from '@/lib/cursorEffects/effects';
export type { ClickEffect, CursorEffectGroup, TrailEffect } from '@/lib/cursorEffects/effects';
export { FIND_MAX_SCALE, cursorEffects } from '@/lib/cursorEffects/engine';
export type { CursorEffectSettings, PreviewKind } from '@/lib/cursorEffects/engine';
export { PACKAGE_PREFIX, forgetPackage } from '@/lib/cursorEffects/packages';
export { cursorEffectThumbnail, forgetThumbnails } from '@/lib/cursorEffects/thumbnail';
export type { ThumbnailKind } from '@/lib/cursorEffects/thumbnail';

export const DEFAULT_CURSOR_TRAIL = 'none';
export const DEFAULT_CURSOR_CLICK = 'none';
