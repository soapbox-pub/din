import { useEffect, useRef } from 'react';
import { useMonitors } from '@/contexts/MonitorsContext';
import { contains, getMonitorsBridge, type Monitor } from '@/lib/monitors';
import { setFullscreenMonitors } from '@/lib/pageFullscreen';
import { guestElements, guestFrame, guestId, isGuestElement, isGuestFullscreen } from '@/platform/guest';

interface PageFullscreenBridge {
  fit(webContentsId: number, width: number, height: number): Promise<void>;
  /** A mouse event for a fullscreen page that reached the desktop instead; x and y in the page's DIPs. */
  forward(webContentsId: number, input: ForwardedInput): void;
  /** A native app's window into full screen without a click or key just before (NativeWindowView.tsx). */
  enterNative(xid: number): Promise<boolean>;
  /** A native app's pointer lock, likewise. */
  lockNativePointer(xid: number): Promise<boolean>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    pageFullscreen?: PageFullscreenBridge;
  }
}

interface ForwardedInput {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
}

/** Marks the style this adds to a <webview>'s shadow root. */
const STYLE_ID = 'din-page-fullscreen';

/** A fitted fullscreen page: its <webview>, its guest, and the monitor it covers. */
interface FittedPage {
  host: HTMLElement;
  pageId: number;
  monitor: Monitor;
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/** The modifiers (and held buttons) of a mouse event, as Electron names them. */
function modifiersOf(event: MouseEvent): string[] {
  const modifiers: string[] = [];
  if (event.shiftKey) modifiers.push('shift');
  if (event.ctrlKey) modifiers.push('control');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');
  if (event.buttons & 1) modifiers.push('leftbuttondown');
  if (event.buttons & 2) modifiers.push('rightbuttondown');
  if (event.buttons & 4) modifiers.push('middlebuttondown');
  return modifiers;
}

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
 *
 * Each monitor can have its own fullscreen page at the same time; each frame
 * goes to its monitor and the layer has a hole over every one. (Chromium
 * takes them all out of fullscreen when one leaves; main puts the others
 * back, electron/main.mts.)
 *
 * A native app in full screen is the same, with its window's canvas host
 * (NativeWindowView.tsx) as the frame; the app sizes itself to the monitor.
 *
 * The covered monitor is recorded (src/lib/pageFullscreen.ts) so new
 * windows and links open on another one rather than behind the page.
 *
 * The page's frame is below the layer, seen through its hole, and Chromium
 * doesn't always send the input there to the page: once the desktop has the
 * focus (a click on another monitor), it can ask the desktop what's under
 * the pointer over the hole, and the desktop answers with the frame, an
 * element of its own, so the page never hears of the click and the screen
 * it fills ignores the mouse (and Escape, which follows the focus). Mouse
 * events that land on a page's frame in the desktop are handed on to the
 * page, and a press gives the page the focus, which puts Chromium's routing
 * right again.
 *
 * Monitors can come and go while a page is fullscreen (an AirPlay receiver
 * taken over by another device), so the fit is redone whenever they change.
 */
export function PageFullscreenHost() {
  const { monitors } = useMonitors();
  const monitorsRef = useRef(monitors);
  const refitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    monitorsRef.current = monitors;
    refitRef.current?.();
  }, [monitors]);

  useEffect(() => {
    const bridge = window.dinos?.pageFullscreen;
    if (!bridge) return;
    const shell = document.getElementById('shell');
    const layer = shell instanceof HTMLDialogElement ? shell : null;
    const fitted = new Set<HTMLElement>();
    // The fitted frames of web pages, for handing them their input.
    const pages = new Map<HTMLElement, FittedPage>();
    // The fullscreen pages laid out at a monitor's size, which only leaving
    // fullscreen undoes in the main process.
    const emulated = new Set<number>();

    /** The page whose frame EVENT landed on in the desktop, which it was meant for. */
    const pageFor = (event: Event): FittedPage | undefined => {
      const target = event.composedPath()[0];
      return target instanceof HTMLElement ? pages.get(target) : undefined;
    };
    // Kept from the desktop, whose own handlers (raising a window, closing
    // menus) would take it as a click on itself.
    const onPointer = (event: Event) => {
      if (pageFor(event)) event.stopImmediatePropagation();
    };
    const onMouse = (event: MouseEvent) => {
      const page = pageFor(event);
      if (!page) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'contextmenu' || event.type === 'click' || event.type === 'dblclick' || event.type === 'auxclick') return;
      if (event.type === 'mousedown' && document.activeElement !== page.host) page.host.focus({ preventScroll: true });
      const zoom = getMonitorsBridge()?.zoomFactor() ?? 1;
      const at = { x: (event.clientX - page.monitor.x) * zoom, y: (event.clientY - page.monitor.y) * zoom, modifiers: modifiersOf(event) };
      if (event instanceof WheelEvent) {
        // DOM's deltas point the way the view moves; Chromium's input the way the content does.
        const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
        bridge.forward(page.pageId, { type: 'mouseWheel', ...at, deltaX: -event.deltaX * lines, deltaY: -event.deltaY * lines });
        return;
      }
      const type = event.type === 'mousedown' ? 'mouseDown' : event.type === 'mouseup' ? 'mouseUp' : 'mouseMove';
      bridge.forward(page.pageId, { type, ...at, button: BUTTONS[event.button] ?? 'left', clickCount: Math.max(1, event.detail) });
    };
    const pointerTypes = ['pointerdown', 'pointerup', 'pointermove'];
    const mouseTypes = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu'];
    for (const type of pointerTypes) window.addEventListener(type, onPointer, true);
    for (const type of mouseTypes) window.addEventListener(type, onMouse as EventListener, true);
    window.addEventListener('wheel', onMouse as EventListener, { capture: true, passive: false });

    // Escape belongs to the fullscreen page, not to the desktop's layer.
    const onCancel = (event: Event) => event.preventDefault();
    layer?.addEventListener('cancel', onCancel);

    const unfit = () => {
      for (const frame of fitted) {
        frame.style.translate = '';
        frame.style.clipPath = '';
      }
      fitted.clear();
      pages.clear();
      if (layer?.open) {
        layer.close();
        Object.assign(layer.style, { left: '', top: '', width: '', height: '', clipPath: '' });
      }
    };

    const fit = (pageId: number, width: number, height: number) => {
      emulated.add(pageId);
      const zoom = getMonitorsBridge()?.zoomFactor() ?? 1;
      void bridge
        .fit(pageId, width * zoom, height * zoom)
        .catch((error: unknown) => console.warn('page fullscreen: fitting failed:', error));
    };

    const onChange = () => {
      unfit();
      setFullscreenMonitors([]);
      // Pages on different monitors can be fullscreen together, and
      // document.fullscreenElement is only the last of them.
      const hosts: HTMLElement[] = [
        ...guestElements().filter(isGuestFullscreen),
        ...document.querySelectorAll<HTMLElement>('[data-native-window]:fullscreen'),
      ];
      const pageIds = new Set(hosts.map((host) => (isGuestElement(host) ? guestId(host) : null)));
      for (const id of emulated) if (!pageIds.has(id)) emulated.delete(id);
      if (monitorsRef.current.length < 2) {
        // Down to one monitor under pages fitted to another: they fill the
        // whole window again.
        for (const id of emulated) fit(id, window.innerWidth, window.innerHeight);
        return;
      }

      const covered: Monitor[] = [];
      for (const host of hosts) {
        const page = isGuestElement(host);
        const frame = page ? guestFrame(host) : host;
        if (!frame) continue;

        // The window's monitor: the one under the middle of the webview, which
        // keeps its place in the window while its frame is fullscreen (or of
        // the native app's Din window, likewise).
        const box = (page ? host : (host.closest('section') ?? host)).getBoundingClientRect();
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const monitor: Monitor =
          monitorsRef.current.find((m) => contains(m, cx, cy)) ??
          monitorsRef.current.find((m) => m.primary) ??
          monitorsRef.current[0];

        if (page && !host.shadowRoot?.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = 'iframe::backdrop { background: transparent; }';
          host.shadowRoot?.append(style);
        }
        frame.style.translate = `${monitor.x}px ${monitor.y}px`;
        // The frame still has the page's size; past the monitor's edge is the
        // rest of the page's view, which isn't drawn.
        frame.style.clipPath = `inset(0px ${Math.max(0, window.innerWidth - monitor.width)}px ${Math.max(0, window.innerHeight - monitor.height)}px 0px)`;
        fitted.add(frame);
        if (!covered.includes(monitor)) covered.push(monitor);

        const pageId = page ? guestId(host) : null;
        if (pageId !== null) {
          fit(pageId, monitor.width, monitor.height);
          pages.set(frame, { host, pageId, monitor });
        }
      }
      if (covered.length === 0) return;
      setFullscreenMonitors(covered);

      if (layer && !layer.open) {
        // Opening a modal dialog focuses into it; the page keeps the focus.
        const focused = document.activeElement;
        layer.showModal();
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
        // In the top layer the desktop leaves <body>, which MonitorsProvider
        // shrinks to the primary monitor as the containing block for
        // everything fixed. The layer takes over that role, or the whole
        // desktop shifts by the primary monitor's offset.
        const primary = monitorsRef.current.find((m) => m.primary) ?? monitorsRef.current[0];
        const left = primary.x;
        const top = primary.y;
        const holes = covered
          .map(({ x, y, width, height }) => ` M${x - left} ${y - top}h${width}v${height}h${-width}Z`)
          .join('');
        Object.assign(layer.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${primary.width}px`,
          height: `${primary.height}px`,
          // The path is in the layer's own coordinates.
          clipPath: `path(evenodd, 'M${-left} ${-top}h${window.innerWidth}v${window.innerHeight}h${-window.innerWidth}Z${holes}')`,
        });
      }
    };

    document.addEventListener('fullscreenchange', onChange);
    refitRef.current = onChange;
    return () => {
      refitRef.current = null;
      document.removeEventListener('fullscreenchange', onChange);
      layer?.removeEventListener('cancel', onCancel);
      for (const type of pointerTypes) window.removeEventListener(type, onPointer, true);
      for (const type of mouseTypes) window.removeEventListener(type, onMouse as EventListener, true);
      window.removeEventListener('wheel', onMouse as EventListener, { capture: true });
      unfit();
      setFullscreenMonitors([]);
    };
  }, []);

  return null;
}
