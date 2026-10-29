import type { WindowMoveGesture } from '@/hooks/useDragReorder';
import type { Din } from '@/sdk/din';

/**
 * Moving an app's window from a drag inside it (a window's only tab), for
 * useDragReorder and the TabStrip. The desktop follows the pointer from
 * `din.window.beginMove` on, so there's nothing to forward afterwards; the
 * release goes to the desktop, so its end is replayed here as one, for the
 * strip to settle at once.
 */
export function dinWindowMove(din: Din): WindowMoveGesture {
  return {
    beginMove: (_point, event) => {
      const { pointerId } = event;
      void din.window.beginMove(event).then(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId })));
      return true;
    },
    gestureMove: () => {},
    gestureEnd: () => {},
  };
}
