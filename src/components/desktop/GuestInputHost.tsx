import { useEffect, useRef } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import { getGuestInput } from '@/lib/guestInput';
import { findGuest } from '@/platform/guest';


const BUTTONS = { left: 0, middle: 1, right: 2 } as const;
const BUTTON_MASKS = { left: 1, middle: 4, right: 2 } as const;

/**
 * Replays pointer input from inside <webview> guests (see
 * src/lib/guestInput.ts) on their host elements, so the rest of the shell sees
 * pages as if they were ordinary DOM:
 *
 *  - a press in a page is a `pointerdown` on its <webview>, so Radix popovers
 *    and menus close on it like on any outside click, and the hosting
 *    window's raise-on-pointerdown fires;
 *  - it's also a `focusin`, since a press focuses the page and the <webview>
 *    doesn't reliably say so itself. Windows remember it as their
 *    last-focused element, to give it focus back when raised;
 *  - the pointer moving over a page is a `pointermove`, so the Dock's
 *    coordinate-based retraction works over web content too.
 *
 * The events are synthetic (`isTrusted` is false) and carry the pointer's
 * position in shell-viewport CSS pixels.
 */
export function GuestInputHost() {
  const { config } = useAppContext();
  // The guest reports DIPs; the shell frame is scaled by the interface zoom.
  const zoomRef = useRef(config.zoomLevel / 100);
  useEffect(() => {
    zoomRef.current = config.zoomLevel / 100;
  }, [config.zoomLevel]);

  useEffect(() => {
    const bridge = getGuestInput();
    if (!bridge) return;
    return bridge.onInput((input) => {
      const el = findGuest(input.wcId);
      if (!el) return;
      // From the shell's own view where main has it: the guest's rect may
      // have moved since the guest saw the event (its window being dragged
      // by this very pointer), and adding the newer rect would feed that
      // back into the drag.
      const zoom = zoomRef.current;
      let clientX: number;
      let clientY: number;
      if (input.sx !== undefined && input.sy !== undefined) {
        clientX = input.sx / zoom;
        clientY = input.sy / zoom;
      } else {
        const rect = el.getBoundingClientRect();
        clientX = rect.left + input.x / zoom;
        clientY = rect.top + input.y / zoom;
      }
      const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        metaKey: input.meta,
      };
      if (input.type === 'move') {
        el.dispatchEvent(new PointerEvent('pointermove', init));
        return;
      }
      el.dispatchEvent(new PointerEvent('pointerdown', {
        ...init,
        button: BUTTONS[input.button],
        buttons: BUTTON_MASKS[input.button],
      }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    });
  }, []);

  return null;
}
