import type { WindowMoveGesture } from '@/hooks/useDragReorder';
import type { Din } from '@/sdk/din';

/**
 * Moving an app's window from a drag inside it (a window's only tab), for
 * useDragReorder and the TabStrip. The desktop follows the pointer from
 * `din.window.beginMove` on, so there's nothing to forward afterwards.
 */
export function dinWindowMove(din: Din): WindowMoveGesture {
  return {
    beginMove: (_point, event) => {
      din.window.beginMove(event);
      return true;
    },
    gestureMove: () => {},
    gestureEnd: () => {},
  };
}
