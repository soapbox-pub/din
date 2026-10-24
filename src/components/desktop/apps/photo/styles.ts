import { cn } from '@/lib/utils';

/** Photo Editor's look: Photoshop's dark grays and blue, whatever Din's theme. */

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2d8ceb] focus-visible:ring-offset-0';
export const INPUT = cn(
  'h-6 rounded-[3px] border border-[#1f1f1f] bg-[#252525] px-1.5 text-xs text-[#e6e6e6] tabular-nums outline-none',
  'focus:border-[#2d8ceb] disabled:opacity-50',
);

export const RANGE = cn(
  'h-4 w-full cursor-pointer appearance-none bg-transparent',
  '[&::-webkit-slider-runnable-track]:h-[4px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:[background:var(--track,#5c5c5c)]',
  '[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[#1f1f1f] [&::-webkit-slider-thumb]:bg-[#e6e6e6]',
);

/** Photoshop's default swatches, near enough. */
export const SWATCHES = [
  '#ffffff', '#e6e6e6', '#bfbfbf', '#999999', '#737373', '#4d4d4d', '#262626', '#000000',
  '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ed1c24', '#f26522',
  '#f7941d', '#fff200', '#8dc63f', '#39b54a', '#00a651', '#00a99d', '#00aeef', '#0072bc',
  '#0054a6', '#2e3192', '#662d91', '#92278f', '#ec008c', '#ed145b', '#c69c6d', '#754c24',
];
