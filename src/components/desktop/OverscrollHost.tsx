import { useEffect } from 'react';
import { createOverscrollBounce, type OverscrollBounce } from '@/lib/overscrollBounce';
import { watchOverscroll } from '@/shared/overscroll';

/** What bounces in the desktop's document: a window's content (Window.tsx). */
const SURFACE = '[data-overscroll-surface]';

/**
 * Bounces the desktop's own windows (Settings, the App Store, …) when their
 * content is scrolled past its end, as macOS does. Apps and web pages bounce
 * inside their GuestSurface, from their own document's detector.
 */
export function OverscrollHost() {
  useEffect(() => {
    const bounces = new Map<Element, OverscrollBounce>();
    const stop = watchOverscroll(
      window,
      (report, surface) => {
        if (!(surface instanceof HTMLElement)) return;
        let bounce = bounces.get(surface);
        if (!bounce) {
          bounce = createOverscrollBounce(surface);
          bounces.set(surface, bounce);
        }
        bounce.report(report);
        // Forget windows that have closed.
        for (const [el, b] of bounces) {
          if (!el.isConnected) {
            b.dispose();
            bounces.delete(el);
          }
        }
      },
      { surface: (target) => target.closest(SURFACE) },
    );
    return () => {
      stop();
      for (const bounce of bounces.values()) bounce.dispose();
    };
  }, []);
  return null;
}
