import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
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
  subscribeNativeDisplay,
  windowChrome,
  type NativeSurface,
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
 */
export function NativeWindowView({ windowId, params }: AppComponentProps) {
  const xid = typeof params?.xid === 'number' ? params.xid : 0;
  const appId = typeof params?.appId === 'string' ? params.appId : '';
  const hostRef = useRef<HTMLDivElement>(null);
  const isTop = useWindowIsTop();
  const setTitlebar = useWindowTitlebar();
  const { getApp } = useInstalledApps();
  const { windows } = useWindowManager();
  const { move, resize, setFrameless } = useWindowActions();
  const [title, setTitle] = useState(() => getNativeSurface(xid)?.title ?? '');
  /** Whether the app holds a pointer lock, which the canvas mirrors. */
  const lockedRef = useRef(false);
  /** Where the last button went down on the app, and whether it's still down. */
  const pointerRef = useRef({ x: 0, y: 0, down: false });
  /** An app-requested drag in progress: where it started, pointer and window. */
  const draggingRef = useRef<{ x: number; y: number; winX: number; winY: number } | null>(null);
  const app = getApp(appId);

  const current = windows.find((w) => w.id === windowId);
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  });

  /**
   * Where a borderless window's Din window must be for its app to sit at
   * the root position it asked for: the window is all content, so that's
   * the app's position in workspace coordinates - kept on the workspace,
   * though. Apps place themselves by the screen, which the workspace may
   * be smaller than (a windowed Din), and a window remembered on a bigger
   * monitor can be off this one; with no frame, it couldn't be dragged
   * back. The app is told where it landed, as with any window manager.
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
    // A borderless window opens where its app put it (the Din window comes
    // to it); everything else is placed by Din (the app goes to it). The
    // observer's first callback reports the result.
    if (surface.borderless) {
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
    }
  }, [xid, isTop, syncGeometry]);
  useEffect(() => () => setNativeFocus(xid, false), [xid]);

  // Title changes, and the app resizing (or, borderless, moving) itself,
  // dropping its frame, or asking to be dragged: the Din window follows.
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
        const chrome = windowChrome(surface);
        const size = { width: surface.width + chrome.width, height: surface.height + chrome.height };
        if (event.type === 'configure' && !win.maximized && !win.snapped) {
          // Mid-drag, the window is the pointer's; the app's echo of the
          // move would only pull it back.
          const place = surface.borderless && !draggingRef.current ? placeFor(surface) : win;
          resize(windowId, { x: place.x, y: place.y, ...size });
        }
        if (event.type === 'borderless') {
          setFrameless(windowId, surface.borderless, {
            ...(surface.borderless ? placeFor(surface) : { x: win.x, y: win.y }),
            ...size,
          });
        }
        // Anchored where the button went down, not where the pointer is now:
        // apps ask only once it has travelled past their drag threshold, and
        // the point grabbed should stay under the pointer.
        if (event.type === 'move-request' && pointerRef.current.down) {
          draggingRef.current = { x: pointerRef.current.x, y: pointerRef.current.y, winX: win.x, winY: win.y };
        }
      }),
    [xid, windowId, resize, setFrameless, placeFor],
  );

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
        // Locked, the pointer stays put and only its movement counts.
        if (document.pointerLockElement === event.currentTarget) {
          sendNativeRelative(xid, event.movementX, event.movementY);
          return;
        }
        // The app handed its window to the pointer: it moves, and the app
        // hears nothing until the button comes up.
        const drag = draggingRef.current;
        if (drag) {
          move(windowId, drag.winX + event.clientX - drag.x, drag.winY + event.clientY - drag.y);
          return;
        }
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeMotion(xid, x, y, { dx: event.movementX, dy: event.movementY });
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        pointerRef.current = { x: event.clientX, y: event.clientY, down: true };
        syncGeometry();
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeButton(xid, x, y, event.button, true);
      }}
      onPointerUp={(event) => {
        pointerRef.current.down = false;
        if (draggingRef.current) {
          draggingRef.current = null;
          // Tell the app where the drag left it before it hears the release.
          syncGeometry();
        }
        const [x, y] = localPoint(event.currentTarget, event);
        sendNativeButton(xid, x, y, event.button, false);
      }}
      onPointerCancel={() => {
        pointerRef.current.down = false;
        draggingRef.current = null;
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
