/**
 * What was cut or copied, for every app: Din's file clipboard, behind
 * `din.clipboard` (DinAppFrame) and the native-window bridge. Like a native
 * file manager's, it spans windows, so a file cut in one pastes in another.
 */

export interface FileClipboard {
  op: 'copy' | 'cut';
  paths: string[];
  /** Put there by an app that could only read them: whoever pastes gets read-only copies. */
  readOnly?: boolean;
}

let clipboard: FileClipboard | null = null;
const listeners = new Set<() => void>();

/** Hear when what's cut or copied changes. */
export function subscribeFileClipboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFileClipboard(next: FileClipboard | null): void {
  clipboard = next;
  for (const l of listeners) l();
  // Paths go to the system clipboard too, for pasting into a terminal.
  if (next) void navigator.clipboard?.writeText(next.paths.join('\n')).catch(() => {});
}

export function getFileClipboard(): FileClipboard | null {
  return clipboard;
}
