import { useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { MonitorsContext, type MonitorsLayout } from '@/contexts/MonitorsContext';
import {
  getMonitorsBridge,
  monitorsSignature,
  simulatedMonitors,
  toMonitors,
  type HostMonitor,
} from '@/lib/monitors';

/** The current viewport size, kept fresh on resize (zoom changes resize too). */
function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => {
      setSize((prev) =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight },
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/**
 * Tracks the monitors Din's window spans and makes the primary one the home
 * of everything that isn't a desktop window.
 *
 * With more than one monitor, <body> is shrunk to the primary monitor's
 * rectangle and made the containing block for fixed-position elements, so
 * every overlay - dialogs, toasts, popovers, OSDs, the window switcher -
 * lands on the primary monitor without knowing monitors exist. The few
 * layers that do span every monitor (the wallpaper, the window stack, the
 * boot veil) use ScreenLayer or position themselves from this context.
 */
export function MonitorsProvider({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HostMonitor[] | null>(simulatedMonitors);
  const viewport = useViewportSize();

  useEffect(() => {
    const bridge = getMonitorsBridge();
    if (!bridge || simulatedMonitors()) return;
    let live = true;
    bridge.get().then(
      (monitors) => {
        if (live) setHost(monitors);
      },
      () => {},
    );
    const unsubscribe = bridge.onChange(setHost);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const monitors = toMonitors(host, getMonitorsBridge()?.zoomFactor() ?? 1);
  const signature = `${monitorsSignature(monitors)}@${viewport.width}x${viewport.height}`;
  // Rebuilt only when the layout actually changes, so the desktop doesn't
  // re-render for a re-report of the same monitors.
  const layout = useMemo<MonitorsLayout>(
    () => ({
      monitors,
      primary: monitors.find((m) => m.primary) ?? monitors[0],
      width: viewport.width,
      height: viewport.height,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  const { primary, width, height } = layout;
  const spans = primary.x !== 0 || primary.y !== 0 || primary.width !== width || primary.height !== height;

  useLayoutEffect(() => {
    if (!spans) return;
    const { body } = document;
    const saved = body.style.cssText;
    Object.assign(body.style, {
      position: 'absolute',
      left: `${primary.x}px`,
      top: `${primary.y}px`,
      width: `${primary.width}px`,
      height: `${primary.height}px`,
      margin: '0',
      // Makes <body> the containing block for position: fixed.
      contain: 'layout',
    });
    // Radix's popovers and menus are placed by floating-ui, which looks for a
    // fixed element's containing block but never considers <body>: it places
    // them in viewport coordinates, as if <body> were still at the origin.
    // Pull them back by the primary monitor's offset to compensate. Not while
    // the desktop's layer is open for a fullscreen page (PageFullscreenHost):
    // it's an element, which floating-ui does account for.
    const popperFix = document.createElement('style');
    popperFix.textContent = `[data-radix-popper-content-wrapper]:not(#shell[open] *) { left: ${-primary.x}px !important; top: ${-primary.y}px !important; }`;
    document.head.appendChild(popperFix);
    return () => {
      body.style.cssText = saved;
      popperFix.remove();
    };
  }, [spans, primary.x, primary.y, primary.width, primary.height]);

  return <MonitorsContext.Provider value={layout}>{children}</MonitorsContext.Provider>;
}

/**
 * A fixed layer covering the whole window - every monitor - whatever the
 * primary monitor's offset. Its own coordinates are viewport coordinates, so
 * children can be placed straight from clientX/clientY. Outside a
 * MonitorsProvider it simply covers the viewport.
 */
export function ScreenLayer({ style, ...props }: React.ComponentProps<'div'>) {
  const layout = useContext(MonitorsContext);
  return <div {...props} style={{ position: 'fixed', ...screenRect(layout), ...style }} />;
}

/** CSS placing an element over the whole window from inside <body>. */
function screenRect(layout: MonitorsLayout | undefined): React.CSSProperties {
  if (!layout) return { inset: 0 };
  return { left: -layout.primary.x, top: -layout.primary.y, width: layout.width, height: layout.height };
}
