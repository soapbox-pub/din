import { contains, type Monitor } from '@/lib/monitors';

/**
 * The monitors fullscreen pages (or native apps in full screen) cover, while
 * there are others to open things on instead (PageFullscreenHost.tsx). New
 * windows and links stay off them: anything opened there would land behind
 * a page, out of sight.
 */
let covered: Monitor[] = [];

export function setFullscreenMonitors(monitors: Monitor[]): void {
  covered = monitors;
}

/** The ids of the monitors fullscreen pages cover. */
export function fullscreenMonitorIds(): string[] {
  return covered.map((m) => m.id);
}

/** Whether a desktop window sits on a monitor a fullscreen page covers. */
export function onFullscreenMonitor(windowId: string): boolean {
  if (covered.length === 0) return false;
  const section = document.querySelector(`[data-window-id="${CSS.escape(windowId)}"]`);
  if (!section) return false;
  const box = section.getBoundingClientRect();
  return covered.some((m) => contains(m, box.x + box.width / 2, box.y + box.height / 2));
}
