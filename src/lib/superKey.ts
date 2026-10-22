import { useSyncExternalStore } from 'react';
import { getShellShortcuts } from '@/lib/shellShortcuts';

/**
 * Whether the Super (Meta) key is held, for Super+drag window moves.
 *
 * Fed from three places, since no single one sees every press:
 *  - keydown/keyup in the shell document, while focus is in the shell (or a
 *    native app, whose keys pass through the shell DOM);
 *  - the shell-shortcut bridge, while focus is inside a <webview> guest
 *    (the main process forwards Super's down/up as 'super-key');
 *  - the `metaKey` flag of pointer events in the shell document, which
 *    corrects a missed keyup the next time the pointer moves over the shell.
 *
 * Losing window focus clears it, since the keyup may go elsewhere.
 */
let held = false;
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

function set(value: boolean): void {
  if (value === held) return;
  held = value;
  for (const listener of listeners) listener();
}

function install(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Meta') set(e.type === 'keydown');
  };
  const onPointer = (e: PointerEvent) => set(e.metaKey);
  const onBlur = () => set(false);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('pointermove', onPointer, true);
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', onBlur);
  const unsubscribe = getShellShortcuts()?.onShortcut((shortcut) => {
    if (shortcut.action === 'super-key') set(shortcut.down);
  });
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('pointermove', onPointer, true);
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('blur', onBlur);
    unsubscribe?.();
  };
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) teardown = install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardown?.();
      teardown = null;
      held = false;
    }
  };
}

/** Whether Super is held right now; re-renders when that changes. */
export function useSuperHeld(): boolean {
  return useSyncExternalStore(subscribe, () => held, () => false);
}
