import { useEffect, useState } from 'react';
import { getBootBridge } from '@/lib/boot';
import { cn } from '@/lib/utils';
import { ScreenLayer } from './MonitorsProvider';

/**
 * Boot veil: an overlay covering the shell's first frame, fading out once
 * the window is on screen so the desktop/login fades in from it. It's the
 * boot screen's last frame (os/boot-screen/din.script): the same background,
 * Din's logo at the foot and the progress bar above it, in the same places
 * on the primary monitor, so the handover doesn't show. The bar goes on
 * from where the boot screen leaves it to full as the veil fades.
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

  // Sizes are the boot screen's, which designs for 1080 lines and follows
  // the screen's height: here, hundredths of the monitor's height (cqh).
  return (
    <>
      <ScreenLayer
        aria-hidden
        className={cn(
          'pointer-events-none z-[10001] bg-[#0b0f14]',
          visible && 'animate-veil-out motion-reduce:animate-none motion-reduce:opacity-0',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none fixed inset-0 z-[10001] [container-type:size]',
          visible && 'animate-veil-out motion-reduce:animate-none motion-reduce:opacity-0',
        )}
      >
        <div className="absolute bottom-[8.52cqh] left-1/2 h-[max(0.37cqh,2px)] w-[14.81cqh] -translate-x-1/2 overflow-hidden bg-white/15">
          <div
            className={cn(
              'h-full bg-white/85 transition-[width] duration-1000 ease-out',
              visible ? 'w-full' : 'w-[70%]',
            )}
          />
        </div>
        <img
          src="/din-logo.svg"
          alt=""
          className="absolute bottom-[3.7cqh] left-1/2 h-[2.59cqh] -translate-x-1/2 opacity-85"
        />
      </div>
    </>
  );
}
