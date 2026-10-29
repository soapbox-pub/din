/**
 * Settings' "Preview" buttons: play an effect on a window, there and back,
 * without minimizing or closing it. The window registers by id and plays
 * it (Window.tsx).
 */

import type { EffectEvent } from '@/lib/effects';

type PreviewListener = (event: EffectEvent, choice: string) => void;

const listeners = new Map<string, PreviewListener>();

export function onEffectPreview(windowId: string, listener: PreviewListener): () => void {
  listeners.set(windowId, listener);
  return () => {
    if (listeners.get(windowId) === listener) listeners.delete(windowId);
  };
}

/** Play `choice` for `event` on window `windowId`. False if no window by that id can. */
export function previewEffect(windowId: string, event: EffectEvent, choice: string): boolean {
  const listener = listeners.get(windowId);
  if (!listener) return false;
  listener(event, choice);
  return true;
}
