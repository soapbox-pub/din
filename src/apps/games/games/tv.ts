/**
 * The TV view's look for what a controller (or the keys) has focused: lifted
 * toward you, outlined in white and glowing, as a console's is. The TV shell
 * sets `data-tv-focus` while a controller or the keys are in use, so the
 * mouse never leaves a tile lit up.
 */
export const tvLift =
  'in-data-[tv-focus]:focus:z-10 in-data-[tv-focus]:focus:scale-[1.08] in-data-[tv-focus]:focus:bg-white/12 in-data-[tv-focus]:focus:ring-[3px] in-data-[tv-focus]:focus:ring-white in-data-[tv-focus]:focus:shadow-[0_0_48px_-4px_rgb(255_255_255/0.35)]';

/** The same for a button or a row: outlined and glowing, not lifted. */
export const tvRing =
  'in-data-[tv-focus]:focus:ring-[3px] in-data-[tv-focus]:focus:ring-white in-data-[tv-focus]:focus:shadow-[0_0_32px_-4px_rgb(255_255_255/0.4)]';
