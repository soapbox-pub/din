import type { DockStyle } from '@/contexts/AppContext';

/** The Dock's backdrops, in the order Settings and the Dock's menu offer them. */
export const DOCK_STYLES: { value: DockStyle; name: string }[] = [
  { value: 'none', name: 'None' },
  { value: 'modern', name: 'Modern' },
  { value: 'classic', name: 'Classic' },
];
