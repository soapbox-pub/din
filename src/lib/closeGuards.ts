/**
 * Windows that want a say before they close, by window id: an editor with
 * unsaved changes asks whether to save them. A guard returning true has
 * taken the close over (it's asking) and the window stays open; the app
 * closes it later, once its guard is gone.
 */
const guards = new Map<string, () => boolean>();

/** Install (or with null, remove) a window's close guard. */
export function setCloseGuard(windowId: string, guard: (() => boolean) | null): void {
  if (guard) guards.set(windowId, guard);
  else guards.delete(windowId);
}

/** Whether a window's guard took over a request to close it. */
export function closeIntercepted(windowId: string): boolean {
  return guards.get(windowId)?.() ?? false;
}
