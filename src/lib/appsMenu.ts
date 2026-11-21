/**
 * Toggle requests from the App Search shortcut in DesktopHotkeys.
 */
const listeners = new Set<() => void>();

/** Open the apps menu, or close it if it's already open. */
export function toggleAppsMenu(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to toggle requests. Returns an unsubscribe fn. */
export function onToggleAppsMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
