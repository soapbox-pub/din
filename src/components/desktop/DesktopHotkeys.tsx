import { useEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { toggleAppsMenu } from '@/lib/appsMenu';
import { publishBrowserHotkey, type BrowserHotkey } from '@/lib/browserTabBus';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { isScreenshotSessionActive } from '@/lib/screenshot';
import { isWebviewAvailable } from '@/lib/isElectron';
import { isWindowSwitcherActive } from '@/lib/windowSwitcherState';
import type { WindowState } from '@/hooks/useWindows';

/** The built-in Web Browser's app id (see src/lib/apps.ts). */
const WEB_BROWSER_APP_ID = 'web-browser';

/** The built-in Screenshot tool's app id (see src/lib/apps.ts). */
const SCREENSHOT_APP_ID = 'screenshot';

/**
 * Desktop-wide keyboard shortcuts. Renders nothing.
 *
 * (Alt+Tab / Alt+Shift+Tab window switching lives in its sibling
 * WindowSwitcher, which owns the keyboard for the duration of the gesture;
 * this component stands down while it's active.)
 *
 * - Print Screen opens the Screenshot app for a full-screen capture, and
 *   Shift+Print Screen for an area grab (the laptop screenshot function
 *   keys; the dedicated box-select key on newer laptops reaches the shell
 *   as the 'screenshot-area' bridge shortcut instead - see electron/main.mts).
 *   Both are ignored while a capture session is already running, so they
 *   can't re-raise the deliberately hidden window mid-shot.
 * - Super+Space opens the menu bar's apps menu with its search focused (or
 *   closes it again).
 * - Ctrl+T / Ctrl+W act on the focused window's tabs when it's the Web
 *   Browser (open / close a tab), and Ctrl+L focuses its address bar.
 *   Deliberately scoped: other apps keep these keys (e.g. Ctrl+W is
 *   delete-word in a terminal shell).
 * - Inside the Electron shell (webview mode), the rest of the browser's
 *   shortcut set is also scoped to a focused Web Browser window: Ctrl+F
 *   (find bar), Ctrl+R / F5 and Ctrl+Shift+R / Shift+F5 (reload),
 *   Ctrl+Tab / Ctrl+Shift+Tab (cycle tabs), Ctrl+1..9 (tab by position),
 *   and Alt+Left/Right (history). These are NOT intercepted in the
 *   plain-browser dev loop, where the host browser needs them itself
 *   (its own find bar, reload, tab and history navigation).
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
 * window manager usually consumes Alt+Tab (and the OS may grab Print
 * Screen) first; in the DinOS kiosk (cage) and the plain-browser dev
 * loop the shortcuts reach us.
 */
export function DesktopHotkeys() {
  const { windows, actions } = useWindowManager();

  // The keydown handler needs the current window list without re-binding
  // the listener on every desktop commit.
  const windowsRef = useRef<WindowState[]>(windows);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  // Same for the actions: `open` changes identity whenever the window list
  // (or installed apps) changes, but the hotkey listener must stay bound.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    /** The focused window: highest z among non-minimized (as the Dock). */
    const topWindow = () =>
      windowsRef.current.reduce<WindowState | null>(
        (top, w) => (!w.minimized && (!top || w.z > top.z) ? w : top),
        null,
      );

    // Shortcuts that would fight the host browser (find, reload, tab and
    // history navigation) are only intercepted inside the Electron shell.
    const guests = isWebviewAvailable();

    const onKeyDown = (e: KeyboardEvent) => {
      // The window switcher owns the keyboard while an Alt+Tab gesture is
      // open (its own listener handles navigation/commit); stand down so we
      // don't, e.g., read its Alt+Arrow selection as browser history.
      if (isWindowSwitcherActive()) return;

      // Print Screen: full-screen capture. Shift+Print Screen: select an
      // area (the same session the dedicated box-select key starts via the
      // Electron host's evdev watch). The session flag guards against a
      // press mid-capture, when the app's window is deliberately minimized
      // out of the shot.
      if (e.key === 'PrintScreen' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (!isScreenshotSessionActive()) {
          e.preventDefault();
          actionsRef.current.open(SCREENSHOT_APP_ID, {
            start: e.shiftKey ? 'area' : 'screen',
          });
        }
        return;
      }

      // Super+Space: open the apps menu, search focused.
      if (e.key === ' ' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleAppsMenu();
        return;
      }

      // Everything below acts on the focused window's browser tabs, so it
      // only applies when a Web Browser window is on top.
      const top = topWindow();
      if (!top || top.appId !== WEB_BROWSER_APP_ID) return;
      const publish = (hotkey: Omit<BrowserHotkey, 'windowId'>) => {
        e.preventDefault();
        e.stopPropagation();
        publishBrowserHotkey({ windowId: top.id, ...hotkey });
      };

      if (!guests) {
        // Plain-browser dev loop: only tab management is intercepted (the
        // host browser keeps find / reload / tab & history navigation).
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          const key = e.key.toLowerCase();
          if (key === 't') publish({ action: 'new-tab' });
          else if (key === 'w') publish({ action: 'close-tab' });
          else if (key === 'l') publish({ action: 'focus-address' });
        }
        return;
      }

      // F5 / Shift+F5 (no Ctrl): reload.
      if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        publish({ action: e.shiftKey ? 'force-reload' : 'reload' });
        return;
      }
      // Alt+Left/Right: history navigation.
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        publish({ action: e.key === 'ArrowLeft' ? 'back' : 'forward' });
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
        publish({ action: 'cycle-tab', backward: e.shiftKey });
        return;
      }
      // Ctrl+Shift+R: cache-bypassing reload.
      if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toLowerCase() === 'r'
      ) {
        publish({ action: 'force-reload' });
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 't') publish({ action: 'new-tab' });
        else if (key === 'w') publish({ action: 'close-tab' });
        else if (key === 'l') publish({ action: 'focus-address' });
        else if (key === 'f') publish({ action: 'find' });
        else if (key === 'u') publish({ action: 'view-source' });
        else if (key === 'r') publish({ action: 'reload' });
        else if (/^[1-9]$/.test(e.key)) {
          publish({ action: 'goto-tab', digit: Number(e.key) });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge) return;
    return bridge.onShortcut((shortcut) => {
      // Alt+Tab from a guest is handled by the WindowSwitcher's own bridge
      // subscription; here we only service the apps menu and screenshots.
      if (shortcut.action === 'apps-menu') {
        toggleAppsMenu();
      } else if (shortcut.action === 'screenshot' || shortcut.action === 'screenshot-area') {
        if (!isScreenshotSessionActive()) {
          actionsRef.current.open(SCREENSHOT_APP_ID, {
            start: shortcut.action === 'screenshot-area' ? 'area' : 'screen',
          });
        }
      }
    });
  }, []);

  return null;
}
