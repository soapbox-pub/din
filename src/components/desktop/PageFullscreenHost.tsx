import { useEffect, useRef } from 'react';
import { useMonitors } from '@/contexts/MonitorsContext';
import { contains, getMonitorsBridge, type Monitor } from '@/lib/monitors';

interface PageFullscreenBridge {
  fit(webContentsId: number, width: number, height: number): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    pageFullscreen?: PageFullscreenBridge;
  }
}

/** Marks the style this adds to a <webview>'s shadow root. */
const STYLE_ID = 'din-page-fullscreen';

/**
 * Keeps a fullscreen web page on its own monitor.
 *
 * A page in a <webview> that goes fullscreen (a video's fullscreen button)
 * makes the webview's frame fullscreen in the shell's page, and the shell's
 * page spans every monitor. Chromium pins that frame to the whole page with
 * styles nothing can override but `translate` and `clip-path`, so with
 * several monitors this moves the frame onto the monitor its window is on
 * and clips it there, and the main process lays the page out at that
 * monitor's size (electron/main.mts). The backdrop goes clear, so the other
 * monitors keep showing the desktop.
 *
 * Blink also makes everything outside a fullscreen element inert, so the
 * desktop on the other monitors would show but ignore every click and key.
 * Only a modal dialog outranks the fullscreen element, so the desktop's
 * layer (index.html's `#shell`) opens as one, above the frame, with a hole
 * cut over the frame's monitor.
 */
export function PageFullscreenHost() {
  const { monitors } = useMonitors();
  const monitorsRef = useRef(monitors);
  useEffect(() => {
    monitorsRef.current = monitors;
  }, [monitors]);

  useEffect(() => {
    const bridge = window.pageFullscreen;
    if (!bridge) return;
    const shell = document.getElementById('shell');
    const layer = shell instanceof HTMLDialogElement ? shell : null;
    let fitted: HTMLIFrameElement | null = null;

    // Escape belongs to the fullscreen page, not to the desktop's layer.
    const onCancel = (event: Event) => event.preventDefault();
    layer?.addEventListener('cancel', onCancel);

    const unfit = () => {
      if (!fitted) return;
      fitted.style.translate = '';
      fitted.style.clipPath = '';
      fitted = null;
      if (layer?.open) {
        layer.close();
        layer.style.clipPath = '';
      }
    };

    const onChange = () => {
      unfit();
      const host = document.fullscreenElement;
      if (!host || host.tagName !== 'WEBVIEW' || monitorsRef.current.length < 2) return;
      const frame = host.shadowRoot?.querySelector('iframe');
      if (!frame) return;

      // The window's monitor: the one under the middle of the webview, which
      // keeps its place in the window while its frame is fullscreen.
      const box = host.getBoundingClientRect();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const monitor: Monitor =
        monitorsRef.current.find((m) => contains(m, cx, cy)) ??
        monitorsRef.current.find((m) => m.primary) ??
        monitorsRef.current[0];

      if (!host.shadowRoot?.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = 'iframe::backdrop { background: transparent; }';
        host.shadowRoot?.append(style);
      }
      frame.style.translate = `${monitor.x}px ${monitor.y}px`;
      // The frame still has the page's size; past the monitor's edge is the
      // rest of the page's view, which isn't drawn.
      frame.style.clipPath = `inset(0px ${Math.max(0, window.innerWidth - monitor.width)}px ${Math.max(0, window.innerHeight - monitor.height)}px 0px)`;
      fitted = frame;

      if (layer && !layer.open) {
        // Opening a modal dialog focuses into it; the page keeps the focus.
        const focused = document.activeElement;
        layer.showModal();
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
        const { x, y, width, height } = monitor;
        layer.style.clipPath = `path(evenodd, 'M0 0H${window.innerWidth}V${window.innerHeight}H0Z M${x} ${y}h${width}v${height}h${-width}Z')`;
      }

      const getId = (host as HTMLElement & { getWebContentsId?: () => number }).getWebContentsId;
      const zoom = getMonitorsBridge()?.zoomFactor() ?? 1;
      if (getId) {
        void bridge
          .fit(getId.call(host), monitor.width * zoom, monitor.height * zoom)
          .catch((error: unknown) => console.warn('page fullscreen: fitting failed:', error));
      }
    };

    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      layer?.removeEventListener('cancel', onCancel);
      unfit();
    };
  }, []);

  return null;
}
