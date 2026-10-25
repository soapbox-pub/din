import { cn } from '@/lib/utils';
import { LW_BYBLOCK, LW_BYLAYER, LW_DEFAULT } from '../model';

/** CAD's dark theme, after AutoCAD's. */
export const C = {
  title: '#1b2028',
  tabs: '#2a3039',
  ribbon: '#38404c',
  panelTitle: '#2f3640',
  border: '#1a1e24',
  canvas: '#212830',
  text: '#dfe4ec',
  dim: '#a9b2bf',
  hover: '#4b5563',
  accent: '#0696d7',
  field: '#262c34',
};

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3fa9f5] focus-visible:ring-offset-0';

export const FIELD = cn(
  'h-6 rounded-[2px] border border-[#555f6d] bg-[#262c34] px-1.5 text-[12px] text-[#e8ecf2] outline-none select-text',
  'hover:border-[#6f7b8b] focus:border-[#3fa9f5]',
);

/** Clicks on chrome keep focus where it was (the drawing or the command line). */
export const keepFocus = (e: React.MouseEvent) => {
  if (!(e.target as HTMLElement).closest('input, select, textarea')) e.preventDefault();
};

export const lwName = (lw: number) => (lw === LW_BYLAYER ? 'ByLayer' : lw === LW_BYBLOCK ? 'ByBlock' : lw === LW_DEFAULT ? 'Default' : `${(lw / 100).toFixed(2)} mm`);
