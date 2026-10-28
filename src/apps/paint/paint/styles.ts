/**
 * Paint's 1998 look: battleship gray, bevels made of four one-pixel lines,
 * navy highlights and dotted focus rectangles.
 */

export const RAISED =
  'shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#ffffff,inset_-2px_-2px_#808080,inset_2px_2px_#dfdfdf]';
export const SUNKEN =
  'shadow-[inset_-1px_-1px_#ffffff,inset_1px_1px_#0a0a0a,inset_-2px_-2px_#dfdfdf,inset_2px_2px_#808080]';
export const FIELD = 'shadow-[inset_-1px_-1px_#ffffff,inset_1px_1px_#808080]';
export const FOCUS =
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-dotted focus-visible:outline-black focus-visible:-outline-offset-4';

export const RETRO_FONT: React.CSSProperties = {
  fontFamily: 'Tahoma, "MS Sans Serif", "Noto Sans", "DejaVu Sans", sans-serif',
  fontSize: 12,
};
