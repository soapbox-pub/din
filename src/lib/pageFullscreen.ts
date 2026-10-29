import { contains, type Monitor } from '@/lib/monitors';

/**
 * The monitor a fullscreen page (or native app in full screen) covers, while
 * there are others to open things on instead (PageFullscreenHost.tsx). New
 * windows and links stay off it: anything opened there would land behind the
 * page, out of sight.
 */
let covered: Monitor | null = null;

export function setFullscreenMonitor(monitor: Monitor | null): void {
  covered = monitor;
}

/** The id of the monitor a fullscreen page covers, or null. */
export function fullscreenMonitorId(): string | null {
  return covered?.id ?? null;
}

/** Whether a desktop window sits on the monitor a fullscreen page covers. */
export function onFullscreenMonitor(windowId: string): boolean {
  if (!covered) return false;
  const section = document.querySelector(`[data-window-id="${CSS.escape(windowId)}"]`);
  if (!section) return false;
  const box = section.getBoundingClientRect();
  return contains(covered, box.x + box.width / 2, box.y + box.height / 2);
}
