import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowChrome, type ChromePoint } from '@/contexts/WindowChromeContext';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import {
  getNativeSurface,
  raiseNativeWindow,
  sendNativeButton,
  sendNativeKey,
  sendNativeLeave,
  sendNativeMotion,
  sendNativePointerUnlock,
  sendNativeRelative,
  sendNativeWheel,
  setNativeFocus,
  setNativeGeometry,
  setNativeMaximized,
  subscribeNativeDisplay,
  windowChrome,
} from '@/lib/nativeDisplay';

/**
 * How often the canvas's screen position is re-reported. Pointer and focus
 * events re-sync it immediately; this catches the rest (a window moved by a
 * drag, then driven from the keyboard), and costs one layout read.
 */
const POSITION_SYNC_MS = 500;

/**
 * A native Linux app's toplevel window, inside a Din window.
 *
 * The pixels are a <canvas> owned by src/lib/nativeDisplay.ts, adopted into
 * this component's DOM; input on it is forwarded to the app, and the canvas
 * size and screen position are reported back so the app's X window always
 * sits exactly under it.
 *
 * An app that draws its own title bar (client-side decorations) gets none
 * from Din; drags on its title bar and edges, and its maximize and minimize
 * buttons, drive the Din window instead (WindowChromeContext).
 */
export function NativeWindowView({ windowId, params }: AppComponentProps) {
  const xid = typeof params?.xid === 'number' ? params.xid : 0;
  const appId = typeof params?.appId === 'string' ? params.appId : '';
  const hostRef = useRef<HTMLDivElement>(null);
  const isTop = useWindowIsTop();
  const setTitlebar = useWindowTitlebar();
  const chrome = useWindowChrome();
  const { getApp } = useInstalledApps();
  const { windows } = useWindowManager();
  const { resize, maximize, minimize, toggleMaximize } = useWindowActions();
  const [title, setTitle] = useState(() => getNativeSurface(xid)?.title ?? '');
  const [csd, setCsd] = useState(() => getNativeSurface(xid)?.csd ?? false);
  /** Whether the app holds a pointer lock, which the canvas mirrors. */
  const lockedRef = useRef(false);
  /** The pointer, and whether a button is held on the canvas. */
  const pointerRef = useRef<ChromePoint & { held: boolean }>({ clientX: 0, clientY: 0, held: false });
  /** A move or resize the app asked for is under way: the pointer drives it. */
  const gestureRef = useRef(false);
  const app = getApp(appId);

  /** Report where the canvas is (viewport) and how big its box is. */
  const syncGeometry = useCallback(() => {
    const host = hostRef.current;
    if (!host || !xid) return;
    const rect = host.getBoundingClientRect();
    // Size from layout, not the bounding box: a wobble or genie transform
    // distorts the box, and must never resize the app.
    setNativeGeometry(xid, {
      x: rect.left,
      y: rect.top,
      width: host.clientWidth,
      height: host.clientHeight,
    });
  }, [xid]);

  // Adopt the surface's canvas, and keep geometry in sync with the box.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const surface = getNativeSurface(xid);
    if (!host || !surface) return;
    host.appendChild(surface.canvas);
    syncGeometry();
    const observer = new ResizeObserver(syncGeometry);
    observer.observe(host);
    const timer = window.setInterval(syncGeometry, POSITION_SYNC_MS);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      if (surface.canvas.parentElement === host) surface.canvas.remove();
    };
  }, [xid, syncGeometry]);

  // The window on top holds the app's keyboard focus.
  useEffect(() => {
    if (!xid) return;
    setNativeFocus(xid, isTop);
    if (isTop) {
      syncGeometry();
      hostRef.current?.focus({ preventScroll: true });
    }
  }, [xid, isTop, syncGeometry]);
  useEffect(() => () => setNativeFocus(xid, false), [xid]);

  // Title changes, and the app resizing itself (the Din window follows).
  const current = windows.find((w) => w.id === windowId);
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  });
  useEffect(
    () =>
      subscribeNativeDisplay((event) => {
        if (event.surface.id !== xid) return;
        if (event.type === 'title') setTitle(event.surface.title);
        if (event.type === 'decoration') setCsd(event.surface.csd);
        if (event.type === 'pointer-lock') {
          lockedRef.current = event.locked;
          const host = hostRef.current;
          if (event.locked && host) {
            void lockPointer(host).then((locked) => {
              // Refused: the app is told the lock is over.
              if (!locked && lockedRef.current) {
                lockedRef.current = false;
                sendNativePointerUnlock(xid);
              }
            });
          } else if (!event.locked && document.pointerLockElement === host) document.exitPointerLock();
        }
        const win = currentRef.current;
        if (!win) return;
        // The app resized itself, or Din's title bar came or went: the Din
        // window keeps the app at its size.
        if ((event.type === 'configure' || event.type === 'decoration') && !win.maximized && !win.snapped) {
          const extra = windowChrome(event.surface);
          resize(windowId, {
            x: win.x,
            y: win.y,
            width: event.surface.width + extra.width,
            height: event.surface.height + extra.height,
          });
        }
        // Drags on the app's own title bar and edges. Only while a button
        // is still held on the canvas, so a late request can't start a
        // gesture nobody is driving.
        const pointer = pointerRef.current;
        if ((event.type === 'move' || event.type === 'resize') && pointer.held && !gestureRef.current) {
          gestureRef.current =
            event.type === 'move' ? chrome.beginMove(pointer) : chrome.beginResize(event.edge, pointer);
        }
        if (event.type === 'maximize') {
          if (event.maximized && !win.maximized) maximize(windowId);
          else if (!event.maximized && (win.maximized || win.snapped)) toggleMaximize(windowId);
          // Nothing changed: the app still hears back, so its button is right.
          else setNativeMaximized(xid, win.maximized);
        }
        if (event.type === 'minimize') minimize(windowId);
      }),
    [xid, windowId, resize, maximize, minimize, toggleMaximize, chrome],
  );

  // No Din title bar for an app that draws its own. A layout effect, so a
  // new window never paints with both.
  useLayoutEffect(() => {
    chrome.setFrameless(csd);
    return () => chrome.setFrameless(false);
  }, [chrome, csd]);

  // The app's own title bar shows whether the window is maximized.
  const maximized = current?.maximized ?? false;
  const reportedMaximizedRef = useRef(false);
  useEffect(() => {
    if (!xid || reportedMaximizedRef.current === maximized) return;
    reportedMaximizedRef.current = maximized;
    setNativeMaximized(xid, maximized);
  }, [xid, maximized]);

  /** The gesture the app asked for is over (the button came up). */
  const endGesture = useCallback(() => {
    if (!gestureRef.current) return;
    gestureRef.current = false;
    chrome.gestureEnd();
    // The window moved: the app learns where it is now, after the commit.
    requestAnimationFrame(syncGeometry);
  }, [chrome, syncGeometry]);

  // The app's own title, beside its icon, in Din's title bar.
  useEffect(() => {
    setTitlebar(
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {app && <AppIcon icon={app.icon} className="size-4 shrink-0 text-muted-foreground" />}
        <span className="flex-1 truncate text-sm font-medium text-foreground/90">
          {title || app?.name || 'Application'}
        </span>
      </div>,
    );
    return () => setTitlebar(null);
  }, [setTitlebar, title, app]);

  // The lock ended on the shell's side (Escape, or focus went elsewhere):
  // the app lets go too, until the user clicks back in.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xid) return;
    const onChange = () => {
      if (document.pointerLockElement !== host && lockedRef.current) {
        lockedRef.current = false;
        sendNativePointerUnlock(xid);
      }
    };
    document.addEventListener('pointerlockchange', onChange);
    return () => {
      document.removeEventListener('pointerlockchange', onChange);
      if (document.pointerLockElement === host) document.exitPointerLock();
    };
  }, [xid]);

  // Wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xid) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [x, y] = localPoint(host, event);
      sendNativeWheel(xid, x, y, event);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [xid]);

  if (!xid || !getNativeSurface(xid)) {
    return <div className="size-full bg-background" />;
  }

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      aria-label={title || app?.name}
      className="size-full overflow-hidden bg-background outline-none"
      onPointerEnter={() => {
        syncGeometry();
        raiseNativeWindow(xid);
      }}
      onPointerLeave={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) sendNativeLeave();
      }}
      onPointerMove={(event) => {
        pointerRef.current = { clientX: event.clientX, clientY: event.clientY, held: event.buttons !== 0 };
        if (gestureRef.current) {
          chrome.gestureMove(event);
          return;
        }
        // Locked, the pointer stays put and only its movement counts.
        if (document.pointerLockElement === event.currentTarget) {
          sendNativeRelative(xid, event.movementX, event.movementY);
          return;
        }
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeMotion(xid, x, y, { dx: event.movementX, dy: event.movementY });
      }}
      onPointerDown={(event) => {
        pointerRef.current = { clientX: event.clientX, clientY: event.clientY, held: true };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        syncGeometry();
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeButton(xid, x, y, event.button, true);
      }}
      onPointerUp={(event) => {
        pointerRef.current = { clientX: event.clientX, clientY: event.clientY, held: event.buttons !== 0 };
        if (!pointerRef.current.held) endGesture();
        // The app hears the release either way, so no button stays down.
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeButton(xid, x, y, event.button, false);
      }}
      onPointerCancel={() => {
        pointerRef.current.held = false;
        endGesture();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // Shell shortcuts (Alt+Tab, screenshots) are claimed in the capture
        // phase before they get here.
        if (event.defaultPrevented) return;
        // The X server autorepeats held keys itself.
        if (event.repeat || sendNativeKey(event.nativeEvent, true)) event.preventDefault();
      }}
      onKeyUp={(event) => {
        if (event.defaultPrevented) return;
        if (sendNativeKey(event.nativeEvent, false)) event.preventDefault();
      }}
    />
  );
}

/**
 * Mirror an app's pointer lock with the DOM's: the cursor hides and the
 * canvas gets raw movement, unaccelerated where the platform offers it, as
 * games expect. Resolves whether the lock took.
 */
async function lockPointer(host: HTMLElement): Promise<boolean> {
  if (document.pointerLockElement === host) return true;
  try {
    await host.requestPointerLock({ unadjustedMovement: true });
    return true;
  } catch {
    try {
      await host.requestPointerLock();
      return true;
    } catch {
      return false;
    }
  }
}

/** A pointer position relative to an element, in its untransformed pixels. */
function localPoint(element: HTMLElement, event: { clientX: number; clientY: number }): [number, number] {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width > 0 ? element.clientWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? element.clientHeight / rect.height : 1;
  return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
}
