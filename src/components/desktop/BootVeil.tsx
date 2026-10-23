import { useEffect, useState } from 'react';
import { getBootBridge } from '@/lib/boot';
import { cn } from '@/lib/utils';
import { ScreenLayer } from './MonitorsProvider';

/**
 * Boot veil: a black overlay covering the shell's first frame, fading out
 * once the window is on screen so the desktop/login fades in from black.
 *
 * Doubles as the readiness signal for the Electron host: the shell window
 * starts hidden (electron/main.mts) and is only shown once the app has
 * mounted with this veil in the DOM, so the window never maps onto an
 * unpainted (white/garbage) buffer. The fade starts when the host reports
 * the window shown, never while the hidden window is still warming up (its
 * document already calls itself visible then). Without a host, it starts
 * once the page is visible.
 */
export function BootVeil() {
  const [bridge] = useState(getBootBridge);
  const [visible, setVisible] = useState(
    () => !bridge && document.visibilityState === 'visible',
  );

  useEffect(() => {
    if (bridge) {
      let cancelled = false;
      // Defer past the first commit so the veil is in the DOM (and queued
      // for paint) before the host starts its show warm-up.
      const t = setTimeout(() => {
        void bridge.ready().then(() => {
          if (!cancelled) setVisible(true);
        });
      }, 50);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setVisible(true);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [bridge]);

  return (
    <ScreenLayer
      aria-hidden
      className={cn(
        'pointer-events-none z-[10001] bg-black',
        visible && 'animate-veil-out motion-reduce:animate-none motion-reduce:opacity-0',
      )}
    />
  );
}
