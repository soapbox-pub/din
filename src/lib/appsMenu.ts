/**
 * Requests to open or close the menu bar's apps menu from elsewhere in the
 * shell (the Super+Space hotkey in DesktopHotkeys), kept in its own module so
 * neither component imports a non-component export from the other.
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
