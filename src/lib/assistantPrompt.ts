/**
 * Requests to open or close the assistant's prompt (the Super+A overlay in
 * AssistantHost) from elsewhere in the shell: the hotkey in DesktopHotkeys
 * and the menu-bar item. Kept in its own module so neither imports a
 * non-component export from the other.
 */
const listeners = new Set<() => void>();

/** Open the assistant's prompt, or close it if it's already open. */
export function toggleAssistantPrompt(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to toggle requests. Returns an unsubscribe fn. */
export function onToggleAssistantPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
