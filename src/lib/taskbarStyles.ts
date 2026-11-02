import type { TaskbarButtons, TaskbarStyle } from '@/contexts/AppContext';

/** The taskbar's builds, in the order Settings and the taskbar's menu offer them. */
export const TASKBAR_STYLES: { value: TaskbarStyle; name: string }[] = [
  { value: 'slim', name: 'Slim' },
  { value: 'tall', name: 'Tall' },
];

/** What the taskbar's buttons can stand for, in the order Settings offers them. */
export const TASKBAR_BUTTONS: { value: TaskbarButtons; name: string }[] = [
  { value: 'combine', name: 'Combine windows' },
  { value: 'separate', name: 'Separate windows' },
];
