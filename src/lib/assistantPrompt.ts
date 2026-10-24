/**
 * Requests to open or close the assistant's prompt (the Super+A overlay in
 * AssistantHost) from elsewhere in the shell: the hotkey in DesktopHotkeys
 * and the menu-bar item. Kept in its own module so neither imports a
 * non-component export from the other.
 */
const listeners = new Set<() => void>();
const dictateListeners = new Set<() => void>();

/** Whether Super+A is being held to dictate into the prompt. */
let dictationHeld = false;

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

/**
 * Super+A is being held: open the prompt and dictate into it until
 * releaseAssistantPromptDictation.
 */
export function holdAssistantPromptDictation(): void {
  dictationHeld = true;
  for (const listener of dictateListeners) listener();
}

/** Super+A came up. */
export function releaseAssistantPromptDictation(): void {
  dictationHeld = false;
}

/**
 * Whether dictation into the prompt should (still) start: the prompt opens
 * a moment after the hold begins, and the key may be up by then.
 */
export function isAssistantPromptDictationHeld(): boolean {
  return dictationHeld;
}

/** Subscribe to hold requests. Returns an unsubscribe fn. */
export function onHoldAssistantPromptDictation(listener: () => void): () => void {
  dictateListeners.add(listener);
  return () => {
    dictateListeners.delete(listener);
  };
}
