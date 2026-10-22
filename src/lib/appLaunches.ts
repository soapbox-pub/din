import { useSyncExternalStore } from 'react';

/**
 * Apps that were launched but haven't opened a window yet, so the Dock can
 * bounce their tiles meanwhile.
 *
 * Only native apps take a while: Din's own apps open their window in the
 * same commit that launches them. A native app's window arrives on its own,
 * through the embedded display, so a launch ends when any window of the app
 * opens - or, for an app that never maps one (it crashed, or it just raised
 * a window it already had), after LAUNCH_TIMEOUT.
 */
const LAUNCH_TIMEOUT = 15_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
/** The launching app ids, rebuilt on change so snapshots stay stable. */
let launching: string[] = [];

function notify(): void {
  launching = [...timers.keys()];
  for (const listener of listeners) listener();
}

/** Mark an app as launching, restarting its timeout if it already was. */
export function startLaunching(appId: string): void {
  const had = timers.has(appId);
  clearTimeout(timers.get(appId));
  timers.set(appId, setTimeout(() => endLaunching(appId), LAUNCH_TIMEOUT));
  if (!had) notify();
}

/** The app's launch is over: it opened a window, or failed to start. */
export function endLaunching(appId: string): void {
  if (!timers.has(appId)) return;
  clearTimeout(timers.get(appId));
  timers.delete(appId);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every app launching right now, in launch order. */
export function useLaunchingApps(): string[] {
  return useSyncExternalStore(subscribe, () => launching, () => launching);
}

/** Whether the app is launching right now; re-renders when that changes. */
export function useLaunching(appId: string): boolean {
  return useSyncExternalStore(subscribe, () => timers.has(appId), () => false);
}
