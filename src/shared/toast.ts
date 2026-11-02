/**
 * An app's own toasts: short feedback on what the user just did in its
 * window ("Password copied", "Couldn't send the text"), drawn inside the
 * window and gone after a few seconds. One at a time; a new one replaces
 * the last. They sit at the bottom centre of the window, unless the app
 * puts a `<ToastViewport>` in its layout (above a compose bar, say).
 * Anything that should outlast the window is a `Notification`.
 *
 * `startApp` mounts the `<Toaster>` (src/shared/Toaster.tsx), so `toast()`
 * works anywhere in an app.
 */

export interface ToastMessage {
  id: number;
  title: string;
  body?: string;
  destructive: boolean;
}

const listeners = new Set<(message: ToastMessage) => void>();
let nextId = 1;

/** Show a toast in this window. `destructive` for failures: they stay longer and are read out at once. */
export function toast(title: string, options: { body?: string; destructive?: boolean } = {}): void {
  const message: ToastMessage = { id: nextId++, title, body: options.body || undefined, destructive: options.destructive === true };
  for (const listener of listeners) listener(message);
}

/** The Toaster's: hear each toast. */
export function onToast(listener: (message: ToastMessage) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
