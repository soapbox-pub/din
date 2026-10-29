import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowChrome, type ChromePoint } from '@/contexts/WindowChromeContext';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { activeFileDrag } from '@/components/desktop/apps/files/dnd';
import {
  getNativeSurface,
  raiseNativeWindow,
  releaseNativeKeys,
  sendNativeButton,
  sendNativeDragLeave,
  sendNativeDragOver,
  sendNativeDrop,
  sendNativeKey,
  sendNativeLeave,
  sendNativeMotion,
  sendNativePointerUnlock,
  sendNativeRelative,
  sendNativeWheel,
  setNativeFocus,
  setNativeFullscreen,
  setNativeGeometry,
  setNativeMaximized,
  subscribeNativeDisplay,
  typeNativeText,
  windowChrome,
  type NativeSurface,
} from '@/lib/nativeDisplay';
import { registerDictationTarget } from '@/lib/dictation';
import { noteNativeInput } from '@/lib/nativeLatency';
import { useMonitors } from '@/contexts/MonitorsContext';
import { contains } from '@/lib/monitors';

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
 *
 * An app that asks for full screen (a video player's button, a game) gets
 * it the way a web page does: the canvas's box goes fullscreen in the shell's
 * page, over the menu bar and Dock, on its window's monitor
 * (PageFullscreenHost.tsx).
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
  const { move, resize, setFrameless, maximize, minimize, toggleMaximize } = useWindowActions();
  const [title, setTitle] = useState(() => getNativeSurface(xid)?.title ?? '');
  /** Whether the app holds a pointer lock, which the canvas mirrors. */
  const lockedRef = useRef(false);
  /** The pointer, and whether a button is held on the canvas. */
  const pointerRef = useRef<ChromePoint & { held: boolean }>({ clientX: 0, clientY: 0, held: false });
  /** Where the last button went down on the canvas. */
  const pressRef = useRef<ChromePoint>({ clientX: 0, clientY: 0 });
  /** A move or resize the app asked for is under way: the pointer drives it. */
  const gestureRef = useRef(false);
  /** Whether the app was last told it's in full screen. */
  const fullscreenRef = useRef(false);
  const { monitors } = useMonitors();
  const monitorsRef = useRef(monitors);
  useEffect(() => {
    monitorsRef.current = monitors;
  }, [monitors]);
  const app = getApp(appId);
  useWindowTitle(title);

  const current = windows.find((w) => w.id === windowId);
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  });

  /**
   * Where the Din window of an app that draws its own title bar must be for
   * the app to sit at the root position it asked for: the window is all
   * app, so that's its position in workspace coordinates - kept on the
   * workspace, though. Apps place themselves by the screen, which the
   * workspace may be smaller than (a windowed Din), and a window remembered
   * on a bigger monitor can be off this one; with no Din title bar, it
   * couldn't be dragged back. The app is told where it landed, as with any
   * window manager.
   */
  const placeFor = useCallback((surface: NativeSurface) => {
    const area = workspaceOrigin(hostRef.current);
    return {
      x: clamp(surface.x - area.x, 0, area.width - surface.width),
      y: clamp(surface.y - area.y, 0, area.height - surface.height),
    };
  }, []);

  /** Report where the canvas is (viewport) and how big its box is. */
  const syncGeometry = useCallback(() => {
    const host = hostRef.current;
    if (!host || !xid) return;
    const rect = host.getBoundingClientRect();
    // Size from layout, not the bounding box: a wobble or genie transform
    // distorts the box, and must never resize the app.
    let width = host.clientWidth;
    let height = host.clientHeight;
    // In full screen the box spans the whole page, but only the monitor it
    // was moved onto shows.
    if (document.fullscreenElement === host) {
      const monitor = monitorsRef.current.find((m) => contains(m, rect.left, rect.top));
      if (monitor) {
        width = Math.min(width, monitor.width);
        height = Math.min(height, monitor.height);
      }
    }
    setNativeGeometry(xid, { x: rect.left, y: rect.top, width, height });
  }, [xid]);

  // Dictation while this window has the keyboard types into the app.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return registerDictationTarget(host, typeNativeText);
  }, []);

  // Adopt the surface's canvas, and keep geometry in sync with the box.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const surface = getNativeSurface(xid);
    if (!host || !surface) return;
    host.appendChild(surface.canvas);
    // An app that draws its own title bar opens where it put itself (the
    // Din window comes to it); everything else is placed by Din (the app
    // goes to it). The observer's first callback reports the result.
    if (surface.csd) {
      const place = placeFor(surface);
      move(windowId, place.x, place.y);
    } else {
      syncGeometry();
    }
    const observer = new ResizeObserver(syncGeometry);
    observer.observe(host);
    const timer = window.setInterval(syncGeometry, POSITION_SYNC_MS);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      if (surface.canvas.parentElement === host) surface.canvas.remove();
    };
    // Placement happens once, on adoption, not whenever the actions re-bind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xid, syncGeometry]);

  // The window on top holds the app's keyboard focus.
  useEffect(() => {
    if (!xid) return;
    setNativeFocus(xid, isTop);
    if (isTop) {
      syncGeometry();
      hostRef.current?.focus({ preventScroll: true });
    } else if (hostRef.current && document.fullscreenElement === hostRef.current) {
      // Another window came up (Alt+Tab, a launch): full screen ends.
      void document.exitFullscreen();
    }
  }, [xid, isTop, syncGeometry]);

  // Full screen ended, or began, on the shell's side too (Escape, another
  // window): the app is told either way, and fits the new box.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xid) return;
    const onChange = () => {
      const fullscreen = document.fullscreenElement === host;
      if (fullscreen === fullscreenRef.current) return;
      fullscreenRef.current = fullscreen;
      setNativeFullscreen(xid, fullscreen);
      if (fullscreen) host.focus({ preventScroll: true });
      // After PageFullscreenHost has moved the box onto its monitor.
      requestAnimationFrame(syncGeometry);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === host) void document.exitFullscreen();
    };
  }, [xid, syncGeometry]);
  useEffect(() => () => setNativeFocus(xid, false), [xid]);

  // Title changes, and the app resizing (or moving) itself, drawing its own
  // title bar, or driving the window from it: the Din window follows.
  useEffect(
    () =>
      subscribeNativeDisplay((event) => {
        if (event.surface.id !== xid) return;
        if (event.type === 'title') setTitle(event.surface.title);
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
        const { surface } = event;
        const extra = windowChrome(surface);
        const size = { width: surface.width + extra.width, height: surface.height + extra.height };
        // The app resized (or, drawing its own title bar, moved) itself: the
        // Din window follows. Mid-gesture the window is the pointer's, and the
        // app's echo of the move would only pull it back.
        if (event.type === 'configure' && !win.maximized && !win.snapped && !win.tiled) {
          const place = surface.csd && !gestureRef.current ? placeFor(surface) : win;
          resize(windowId, { x: place.x, y: place.y, ...size });
        }
        // Din's title bar came or went: the Din window keeps the app at its
        // size, and in one commit, so the content doesn't jump.
        if (event.type === 'decoration') {
          setFrameless(windowId, surface.csd, {
            ...(surface.csd ? placeFor(surface) : { x: win.x, y: win.y }),
            ...size,
          });
        }
        // Drags on the app's own title bar and edges. Only while a button
        // is still held on the canvas, so a late request can't start a
        // gesture nobody is driving. A move is anchored where the button
        // went down, not where the pointer is now: apps ask only once it
        // has travelled past their drag threshold, and the point grabbed
        // should stay under the pointer.
        const pointer = pointerRef.current;
        if ((event.type === 'move' || event.type === 'resize') && pointer.held && !gestureRef.current) {
          gestureRef.current =
            event.type === 'move' ? chrome.beginMove(pressRef.current) : chrome.beginResize(event.edge, pointer);
        }
        if (event.type === 'maximize') {
          if (event.maximized && !win.maximized) maximize(windowId);
          else if (!event.maximized && (win.maximized || win.snapped)) toggleMaximize(windowId);
          // Nothing changed: the app still hears back, so its button is right.
          else setNativeMaximized(xid, win.maximized);
        }
        if (event.type === 'minimize') minimize(windowId);
        if (event.type === 'fullscreen') {
          const host = hostRef.current;
          const fullscreen = !!host && document.fullscreenElement === host;
          if (event.fullscreen && host && !fullscreen) {
            // Blink allows it only just after a click or key, which is how
            // apps ask. One that asks on its own (a game starting in full
            // screen) fills its monitor instead.
            host.requestFullscreen().catch(() => {
              setNativeFullscreen(xid, false);
              if (!currentRef.current?.maximized) maximize(windowId);
            });
          } else if (!event.fullscreen && fullscreen) {
            void document.exitFullscreen();
          } else {
            // Nothing changed: the app still hears back.
            setNativeFullscreen(xid, fullscreen);
          }
        }
      }),
    [xid, windowId, resize, setFrameless, placeFor, maximize, minimize, toggleMaximize, chrome],
  );

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

  // Closing with a key down (Alt+F4) leaves no window to hear it come up.
  useEffect(() => releaseNativeKeys, []);

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

  // Motion reaches the app as soon as Chromium has it: pointermove waits
  // for the shell's next frame, up to a refresh late, before the app even
  // starts on its own.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xid || !RAW_POINTER) return;
    // TypeScript's DOM types have it as a plain Event; it's a PointerEvent.
    const onRawUpdate = (rawEvent: Event) => {
      const event = rawEvent as PointerEvent;
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY, held: event.buttons !== 0 };
      // A move or resize the app asked for runs on pointermove, at the
      // shell's frame rate, which is all it draws at.
      if (!gestureRef.current) forwardMotion(xid, host, event);
    };
    host.addEventListener('pointerrawupdate', onRawUpdate);
    return () => host.removeEventListener('pointerrawupdate', onRawUpdate);
  }, [xid]);

  if (!xid || !getNativeSurface(xid)) {
    return <div className="size-full bg-background" />;
  }

  return (
    <div
      ref={hostRef}
      data-native-window=""
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
        if (!RAW_POINTER) forwardMotion(xid, event.currentTarget, event.nativeEvent);
      }}
      onPointerDown={(event) => {
        pointerRef.current = { clientX: event.clientX, clientY: event.clientY, held: true };
        pressRef.current = { clientX: event.clientX, clientY: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        syncGeometry();
        const [x, y] = localPoint(event.currentTarget, event);
        if (import.meta.env.VITE_PROFILE === '1') noteNativeInput('button', event.timeStamp);
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
      // Files dragged from Files go on into the app, as they would from a
      // native file manager.
      onDragOver={(event) => {
        const drag = activeFileDrag(event);
        if (!drag) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeDragOver(xid, x, y, drag.paths);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) sendNativeDragLeave();
      }}
      onDrop={(event) => {
        if (!activeFileDrag(event)) return;
        event.preventDefault();
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeDrop(xid, x, y);
      }}
      onBlur={releaseNativeKeys}
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
 * Whether Chromium has pointerrawupdate here (secure contexts only, which
 * the shell is).
 */
const RAW_POINTER = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

/** Pointer motion over the window, to the app. */
function forwardMotion(xid: number, host: HTMLElement, event: PointerEvent): void {
  // Locked, the pointer stays put and only its movement counts.
  if (document.pointerLockElement === host) {
    sendNativeRelative(xid, event.movementX, event.movementY);
    return;
  }
  const [x, y] = localPoint(host, event);
  if (import.meta.env.VITE_PROFILE === '1') noteNativeInput('motion', event.timeStamp);
  sendNativeMotion(xid, x, y, { dx: event.movementX, dy: event.movementY });
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

/**
 * The workspace's top-left corner in the viewport (what a Din window's x/y
 * are relative to) and its size. Read off the window's offset parent rather
 * than the window itself, whose box an open animation or a wobble may be
 * distorting.
 */
function workspaceOrigin(host: HTMLElement | null): { x: number; y: number; width: number; height: number } {
  const parent = host?.closest('section')?.offsetParent;
  const rect = parent?.getBoundingClientRect();
  return {
    x: rect?.left ?? 0,
    y: rect?.top ?? 0,
    width: parent?.clientWidth ?? window.innerWidth,
    height: parent?.clientHeight ?? window.innerHeight,
  };
}

/** `value` held within [min, max], preferring min when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** A pointer position relative to an element, in its untransformed pixels. */
function localPoint(element: HTMLElement, event: { clientX: number; clientY: number }): [number, number] {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width > 0 ? element.clientWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? element.clientHeight / rect.height : 1;
  return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
}
