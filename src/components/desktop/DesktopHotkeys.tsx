import { useEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { publishBrowserHotkey } from '@/lib/browserTabBus';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import type { WindowState } from '@/hooks/useWindows';

/** The built-in Web Browser's app id (see src/lib/apps.ts). */
const WEB_BROWSER_APP_ID = 'web-browser';

/**
 * Desktop-wide keyboard shortcuts. Renders nothing.
 *
 * - Alt+Tab / Alt+Shift+Tab cycle focus through the open (non-minimized)
 *   windows.
 * - Ctrl+T / Ctrl+W act on the focused window's tabs when it's the Web
 *   Browser (open / close a tab), and Ctrl+L focuses its address bar.
 *   Deliberately scoped: other apps keep these keys (e.g. Ctrl+W is
 *   delete-word in a terminal shell).
 *
 * Each action is fed from two sources:
 *  - a window-level keydown listener (capture phase, so it wins over app
 *    content) for keys pressed while focus is in the shell DOM, and
 *  - the shell-shortcut bridge for keys pressed inside Electron <webview>
 *    guests, where keydown never reaches the shell DOM (the main process
 *    intercepts them via before-input-event - see src/lib/shellShortcuts;
 *    tab shortcuts from guests route by WebContents id directly in the
 *    Web Browser app).
 *
 * Note: when Din runs windowed inside a desktop environment, the host
 * window manager usually consumes Alt+Tab first; in the Aladdin kiosk
 * (cage) and the plain-browser dev loop the shortcut reaches us.
 */
export function DesktopHotkeys() {
  const { windows, actions } = useWindowManager();
  const { cycleFocus } = actions;

  // The keydown handler needs the current window list without re-binding
  // the listener on every desktop commit.
  const windowsRef = useRef<WindowState[]>(windows);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    /** The focused window: highest z among non-minimized (as the Dock). */
    const topWindow = () =>
      windowsRef.current.reduce<WindowState | null>(
        (top, w) => (!w.minimized && (!top || w.z > top.z) ? w : top),
        null,
      );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        cycleFocus(e.shiftKey);
        return;
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key !== 't' && key !== 'w' && key !== 'l') return;
        const top = topWindow();
        if (!top || top.appId !== WEB_BROWSER_APP_ID) return;
        e.preventDefault();
        e.stopPropagation();
        publishBrowserHotkey({
          windowId: top.id,
          action: key === 't' ? 'new-tab' : key === 'w' ? 'close-tab' : 'focus-address',
        });
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cycleFocus]);

  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge) return;
    return bridge.onShortcut((shortcut) => {
      if (shortcut.action === 'cycle-windows') cycleFocus(shortcut.backward);
    });
  }, [cycleFocus]);

  return null;
}
