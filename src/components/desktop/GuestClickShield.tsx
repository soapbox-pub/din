import { useEffect, useRef } from 'react';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { getGuestInput } from '@/lib/guestInput';

/**
 * A transparent overlay that makes clicks on embedded web content raise the
 * hosting window, while still letting the wheel scroll that content in place.
 *
 * <webview> guests and iframes are foreign surfaces: pointer input over them
 * goes to the guest page and never reaches this document, so the Window's
 * raise-on-pointerdown handler is blind to clicks inside them. Focus events
 * don't cover the gap either - Electron <webview>s don't reliably fire
 * focus/focusin on their host element, and focus moving from one guest to
 * another fires nothing in this document at all. The only reliable fix is the
 * same one the Dock's hot-edge strip uses: a real DOM element sitting above
 * the guest.
 *
 * Inside the Electron shell none of this is needed: GuestInputHost replays a
 * press in a <webview> as a pointerdown on it, which raises the window like
 * any other click. There the shield renders nothing, so a background page
 * gets hover, scrolling and its first click directly, as on Linux and Windows
 * desktops. It only stands in for the iframe fallback in a plain browser.
 *
 * While the hosting window is not on top, this shield covers the guest and
 * eats the first pointerdown, which bubbles to the window's own
 * raise-on-pointerdown handler. Raising makes the window top, which unmounts
 * the shield, so every later event goes straight to the guest.
 *
 * Scrolling is the exception: on `wheel` the shield briefly drops its
 * pointer-events, letting the wheel reach the guest and scroll it in place. It
 * re-arms shortly after scrolling stops, so clicks still raise as usual.
 *
 * Render it as the last child of a `relative` wrapper that exactly covers the
 * guest surface.
 */
export function GuestClickShield() {
  const isTop = useWindowIsTop();
  const ref = useRef<HTMLDivElement | null>(null);
  const rearmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(rearmTimer.current), []);

  if (isTop || getGuestInput()) return null;

  // Let the wheel fall through to the guest so a background window scrolls
  // under the cursor without being raised, then re-catch pointer input once
  // scrolling settles so a click still raises the window. The event that
  // triggers this first pass-through is consumed here, but any continuous
  // scroll keeps the shield disarmed, so it scrolls smoothly after the first
  // notch.
  const passWheelThrough = () => {
    const el = ref.current;
    if (!el) return;
    el.style.pointerEvents = 'none';
    clearTimeout(rearmTimer.current);
    rearmTimer.current = setTimeout(() => {
      if (ref.current) ref.current.style.pointerEvents = '';
    }, 400);
  };

  return (
    <div
      ref={ref}
      aria-hidden
      className="absolute inset-0 z-10"
      onWheel={passWheelThrough}
    />
  );
}
