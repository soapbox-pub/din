import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useNativeApps } from '@/hooks/useNativeApps';
import { getNativeAppsBridge } from '@/lib/nativeApps';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  isNativeWindowOpen,
  nativePopups,
  sendNativeButton,
  sendNativeMotion,
  startNativeDisplay,
  subscribeNativeDisplay,
  windowChrome,
  type NativeSurface,
} from '@/lib/nativeDisplay';

/** Registry id of the generic host for windows no installed app claims. */
const UNMATCHED_APP_ID = 'native-window';

/** Popup kinds that take input; tooltips and the like are look-only. */
const INTERACTIVE_POPUPS = new Set(['MENU', 'DROPDOWN_MENU', 'POPUP_MENU', 'COMBO', 'NORMAL', 'DIALOG', 'UTILITY']);

/** Popup kinds that grab the pointer, so a click anywhere must reach the app. */
const GRABBING_POPUPS = new Set(['MENU', 'DROPDOWN_MENU', 'POPUP_MENU', 'COMBO']);

/**
 * Bridges Din's embedded display into the desktop: every toplevel an app
 * maps opens a Din window (grouped under its installed app's Dock tile),
 * closes when the app unmaps it, and comes forward when the app asks for
 * focus. Popups - menus, tooltips, dropdowns, which no window manager owns -
 * are drawn in an overlay above everything, at their screen position.
 */
export function NativeDisplayHost() {
  const { open, close, focus } = useWindowActions();
  const { getApp } = useInstalledApps();
  // Windows can only be matched to apps the registry already knows, so the
  // display connects once the app list is in (after a shell reload, every
  // open window is announced again the moment it does).
  const { available } = useNativeApps();
  // X window id -> Din window id.
  const windowsRef = useRef(new Map<number, string>());
  const [popups, setPopups] = useState<NativeSurface[]>(nativePopups);
  // A window that ignored being asked to close, pending a force-quit choice.
  const [stuck, setStuck] = useState<NativeSurface | null>(null);

  useEffect(() => {
    if (available) startNativeDisplay();
  }, [available]);

  useEffect(() => {
    return subscribeNativeDisplay((event) => {
      const { surface } = event;
      switch (event.type) {
        case 'open': {
          const bridge = getNativeAppsBridge();
          void (bridge ? bridge.resolve(surface.pid, surface.wmClass) : Promise.resolve(null))
            .catch(() => null)
            .then((appId) => {
              // Gone before the lookup finished (a splash screen, say).
              if (!isNativeWindowOpen(surface.id) || windowsRef.current.has(surface.id)) return;
              const hostId = appId && getApp(appId) ? appId : UNMATCHED_APP_ID;
              const chrome = windowChrome(surface);
              const id = open(hostId, {
                xid: surface.id,
                appId: hostId,
                width: surface.width + chrome.width,
                height: surface.height + chrome.height,
                frameless: surface.csd,
              });
              if (id) windowsRef.current.set(surface.id, id);
            });
          return;
        }
        case 'close': {
          const id = windowsRef.current.get(surface.id);
          windowsRef.current.delete(surface.id);
          if (id) close(id);
          if (surface.popup) setPopups(nativePopups());
          // It closed after all; nothing left to force.
          setStuck((s) => (s?.id === surface.id ? null : s));
          return;
        }
        case 'activate': {
          const id = windowsRef.current.get(surface.id);
          if (id) focus(id);
          return;
        }
        case 'close-ignored':
          if (surface.pid !== null) setStuck(surface);
          return;
        case 'popup':
        case 'configure':
          if (surface.popup) setPopups(nativePopups());
          return;
      }
    });
  }, [open, close, focus, getApp]);

  const grabbing = popups.some((p) => GRABBING_POPUPS.has(p.kind));

  return (
    <>
      {popups.length > 0 && (
        <NativePopupLayer popups={popups} grabbing={grabbing} />
      )}
      <ForceQuitDialog surface={stuck} onDone={() => setStuck(null)} />
    </>
  );
}

/**
 * Offered when a window ignores being asked to close twice. It may be
 * showing a "save changes?" prompt somewhere, so this asks rather than
 * killing it outright.
 */
function ForceQuitDialog({
  surface,
  onDone,
}: {
  surface: NativeSurface | null;
  onDone: () => void;
}) {
  const name = surface?.title.trim() || 'This program';
  return (
    <AlertDialog open={surface !== null} onOpenChange={(isOpen) => !isOpen && onDone()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{name} isn’t closing</AlertDialogTitle>
          <AlertDialogDescription>
            You can wait for it, or force it to quit. Anything it hasn’t saved will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Wait</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (surface?.pid != null) void getNativeAppsBridge()?.forceQuit(surface.pid).catch(() => {});
            }}
          >
            Force Quit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Popups (menus, tooltips) drawn above everything, at their screen position. */
function NativePopupLayer({ popups, grabbing }: { popups: NativeSurface[]; grabbing: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[10000]">
      {/* While a menu is open the app holds a pointer grab: a click anywhere
          belongs to it (that's how it learns to close the menu), so the rest
          of the desktop is shielded and clicks forwarded at screen
          coordinates. */}
      {grabbing && (
        <div
          className="pointer-events-auto absolute inset-0"
          onPointerMove={(e) => sendNativeMotion(0, e.clientX, e.clientY)}
          onPointerDown={(e) => {
            e.preventDefault();
            sendNativeButton(0, e.clientX, e.clientY, e.button, true);
          }}
          onPointerUp={(e) => sendNativeButton(0, e.clientX, e.clientY, e.button, false)}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}
      {popups.map((popup) => (
        <NativePopup key={popup.id} surface={popup} />
      ))}
    </div>
  );
}

/** One override-redirect window, at its screen position. */
function NativePopup({ surface }: { surface: NativeSurface }) {
  const ref = useRef<HTMLDivElement>(null);
  const interactive = INTERACTIVE_POPUPS.has(surface.kind);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(surface.canvas);
    return () => {
      if (surface.canvas.parentElement === host) surface.canvas.remove();
    };
  }, [surface]);

  const point = (e: React.PointerEvent) => [e.clientX - surface.x, e.clientY - surface.y] as const;

  return (
    <div
      ref={ref}
      className={interactive ? 'pointer-events-auto absolute shadow-lg' : 'absolute shadow-md'}
      style={{ left: surface.x, top: surface.y, width: surface.width, height: surface.height }}
      onPointerMove={(e) => sendNativeMotion(surface.id, ...point(e))}
      onPointerDown={(e) => {
        // Keep DOM focus (and with it the keyboard) on the app's window.
        e.preventDefault();
        sendNativeButton(surface.id, ...point(e), e.button, true);
      }}
      onPointerUp={(e) => sendNativeButton(surface.id, ...point(e), e.button, false)}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
