import type { AppConfig, TaskbarButtons, TaskbarPosition, TaskbarStyle } from '@/contexts/AppContext';

/** The taskbar's builds, in the order Settings and the taskbar's menu offer them. */
export const TASKBAR_STYLES: { value: TaskbarStyle; name: string }[] = [
  { value: 'tall', name: 'Tall' },
  { value: 'slim', name: 'Slim' },
];

/** The screen edges the taskbar can run along, in the order Settings and the taskbar's menu offer them. */
export const TASKBAR_POSITIONS: { value: TaskbarPosition; name: string }[] = [
  { value: 'bottom', name: 'Bottom' },
  { value: 'top', name: 'Top' },
  { value: 'left', name: 'Left' },
];

/** What the taskbar's buttons can stand for, in the order Settings offers them. */
export const TASKBAR_BUTTONS: { value: TaskbarButtons; name: string }[] = [
  { value: 'combine', name: 'Combine windows' },
  { value: 'separate', name: 'Separate windows' },
];

/**
 * The room the workspace leaves for the taskbar beside it, which is laid
 * over its left edge rather than beside it in the desktop's column (so moving
 * the taskbar never remounts the windows). Nothing along the top or bottom: the
 * taskbar takes its own row there.
 */
export function taskbarWorkspaceClass(config: Pick<AppConfig, 'taskbarStyle' | 'taskbarPosition'>): string | undefined {
  if (config.taskbarPosition !== 'left') return undefined;
  return config.taskbarStyle === 'slim' ? 'ml-14' : 'ml-16';
}
