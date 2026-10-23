/**
 * The Ctrl+Alt+Delete screen (SecurityOptions), opened by DesktopHotkeys from
 * the desktop and by the main process from inside pages. A tiny module-level
 * bus, like the assistant's prompt, so the key handlers needn't reach into
 * React.
 */

const listeners = new Set<() => void>();
let active = false;

/** Open the Ctrl+Alt+Delete screen (nothing happens if it's already up). */
export function showSecurityOptions(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to open requests. Returns an unsubscribe fn. */
export function onShowSecurityOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the screen is up; desktop shortcuts stand down while it is. */
export function isSecurityOptionsActive(): boolean {
  return active;
}

export function setSecurityOptionsActive(value: boolean): void {
  active = value;
}
