import { useEffect, useState } from 'react';
import { getBootBridge } from '@/lib/boot';
import { cn } from '@/lib/utils';

/**
 * Boot veil: a black overlay covering the shell's first frame, fading out
 * once the window is on screen so the desktop/login fades in from black.
 *
 * Doubles as the readiness signal for the Electron host: the shell window
 * starts hidden (electron/main.mts) and is only shown once the app has
 * mounted with this veil in the DOM, so the window never maps onto an
 * unpainted (white/garbage) buffer on bare X11. The fade is gated on
 * document visibility, so it always starts exactly when the window appears,
 * never while the hidden window is still warming up.
 */
export function BootVeil() {
  const [visible, setVisible] = useState(
    () => document.visibilityState === 'visible',
  );

  useEffect(() => {
    // Defer past the first commit so the veil is in the DOM (and queued for
    // paint) before the host starts its show warm-up.
    const t = setTimeout(() => getBootBridge()?.ready(), 50);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setVisible(true);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-0 z-[10001] bg-black',
        visible && 'animate-veil-out motion-reduce:animate-none motion-reduce:opacity-0',
      )}
    />
  );
}
