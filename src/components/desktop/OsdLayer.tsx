import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { MonitorsContext } from '@/contexts/MonitorsContext';
import { cn } from '@/lib/utils';

/**
 * Where the volume, brightness and other key readouts appear: low and
 * centered on the primary monitor, fading in and out, and over everything,
 * a page or game in full screen included.
 *
 * Something in full screen (a video, a native app's window: anything going
 * through the Fullscreen API, PageFullscreenHost.tsx) is in the browser's top
 * layer, above every z-index the desktop has. So the readout is in the top
 * layer too, as a manual popover (no light dismiss, never takes the focus),
 * and goes back on top of it whenever it shows and whenever something goes
 * into full screen: the top layer is stacked in the order things joined it.
 *
 * In the top layer its containing block is the whole window, every monitor,
 * not <body> (which MonitorsProvider moves onto the primary monitor), so it
 * places itself over the primary monitor.
 */
export function OsdLayer({
  visible,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & { visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useContext(MonitorsContext);
  const primary = layout?.primary;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;
    raise(el);
    // After PageFullscreenHost has opened the desktop's own layer for it.
    let frame = 0;
    const onFullscreen = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => raise(el));
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (el.matches(':popover-open')) el.hidePopover();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (visible && el && typeof el.showPopover === 'function') raise(el);
  }, [visible]);

  return (
    <div
      ref={ref}
      popover="manual"
      {...props}
      style={{
        ...(primary
          ? { left: primary.x, top: primary.y, width: primary.width, height: primary.height }
          : { inset: 0, width: '100%', height: '100%' }),
        ...style,
      }}
      className={cn(
        // Undo the popover's UA box: it's a transparent sheet over the monitor.
        'pointer-events-none fixed z-[9998] m-0 flex max-h-none max-w-none items-end justify-center overflow-visible border-0 bg-transparent p-0 pb-24 text-inherit',
        // starting: fades it in after being shown again over something in full screen.
        'transition-opacity duration-200 motion-reduce:transition-none starting:opacity-0',
        visible ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Put EL on top of the top layer (showing it again is the only way). */
function raise(el: HTMLElement): void {
  if (el.matches(':popover-open')) {
    // With nothing in full screen and no modal dialog open, nothing that
    // could cover it is in the top layer (the other readouts don't overlap
    // in time), and showing it again would cut its fade short.
    const fullscreen = document.fullscreenElement;
    const modal = document.querySelector('dialog:modal');
    if (!fullscreen && !modal) return;
    el.hidePopover();
  }
  try {
    el.showPopover();
  } catch {
    // Disconnected, or a document without popovers: it stays where it is.
  }
}
