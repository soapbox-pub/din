import { useEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { toggleAppsMenu } from '@/lib/appsMenu';
import {
  holdAssistantPromptDictation,
  releaseAssistantPromptDictation,
  toggleAssistantPrompt,
} from '@/lib/assistantPrompt';
import { cancelDictation, finishDictation, getDictationState, isDictating, toggleDictation } from '@/lib/dictation';
import { publishBrowserHotkey, type BrowserHotkey } from '@/lib/browserTabBus';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { isSecurityOptionsActive, showSecurityOptions } from '@/lib/securityOptions';
import { isScreenshotSessionActive, requestScreenshot } from '@/lib/screenshot';
import { isWebviewAvailable } from '@/lib/isElectron';
import { isWindowSwitcherActive } from '@/lib/windowSwitcherState';
import { focusedWindow, type WindowState } from '@/hooks/useWindows';
import { useAppContext } from '@/hooks/useAppContext';
import { wmCommandFor, type WmCommand } from '@/lib/wmBindings';

/** The built-in Web Browser's app id (see src/lib/apps.ts). */
const WEB_BROWSER_APP_ID = 'web-browser';
/** The Terminal's and Settings' app ids (see src/lib/apps.ts). */
const TERMINAL_APP_ID = 'terminal';
const SETTINGS_APP_ID = 'settings';
/** The System Monitor's app id (see src/lib/apps.ts). */
const SYSTEM_MONITOR_APP_ID = 'system-monitor';
/** Super+A held this long dictates into the prompt instead of toggling it. */
const ASSISTANT_HOLD_MS = 300;

let assistantHoldTimer: ReturnType<typeof setTimeout> | null = null;
let assistantHeld = false;

/** Super+A went down: a tap or a hold, depending on when it comes up. */
function assistantKeyDown(): void {
  if (assistantHoldTimer !== null || assistantHeld) return;
  assistantHoldTimer = setTimeout(() => {
    assistantHoldTimer = null;
    assistantHeld = true;
    holdAssistantPromptDictation();
  }, ASSISTANT_HOLD_MS);
}

/** Super+A came up (its A, or Super): toggle the prompt, or finish dictating. */
function assistantKeyUp(): void {
  if (assistantHoldTimer !== null) {
    clearTimeout(assistantHoldTimer);
    assistantHoldTimer = null;
    toggleAssistantPrompt();
  } else if (assistantHeld) {
    assistantHeld = false;
    releaseAssistantPromptDictation();
    if (getDictationState().held) void finishDictation();
  }
}

function isAssistantKeyPressed(): boolean {
  return assistantHoldTimer !== null || assistantHeld;
}

/**
 * Desktop-wide keyboard shortcuts. Renders nothing.
 *
 * (Alt+Tab / Alt+Shift+Tab window switching lives in its sibling
 * WindowSwitcher, which owns the keyboard for the duration of the gesture;
 * this component stands down while it's active.)
 *
 * - Print Screen takes a full-screen capture on the spot, and Shift+Print
 *   Screen starts an area grab (the dedicated box-select key on newer
 *   laptops reaches the shell as the 'screenshot-area' bridge shortcut
 *   instead - see electron/main.mts). ScreenshotHost does the capturing.
 *   Both are ignored while a capture session is already running.
 * - Super+Space opens the menu bar's apps menu with its search focused (or
 *   closes it again).
 * - Super+A opens the assistant's prompt (AssistantHost), or closes it.
 *   Held, it opens the prompt listening, and what was said is typed into it
 *   (unsent) when the key comes up.
 * - Super+H dictates into whatever has focus (src/lib/dictation.ts), or
 *   finishes; Esc cancels.
 * - Ctrl+Shift+Escape opens the System Monitor, or brings it forward, as
 *   on Windows.
 * - Ctrl+Alt+Delete opens the security options screen (SecurityOptions):
 *   lock, switch account, sign out, change the password, System Monitor,
 *   restart and shut down. Everything else stands down while it's up.
 * - Super plus a key manages windows and workspaces, Hyprland style (the
 *   bindings are in src/lib/wmBindings.ts): Super+arrows focus, Super+1..0
 *   switch workspace, Super+Shift+T turns tiling on or off, and so on.
 * - Ctrl+T / Ctrl+W act on the focused window's tabs when it's the Web
 *   Browser (open / close a tab), and Ctrl+L focuses its address bar.
 *   Deliberately scoped: other apps keep these keys (e.g. Ctrl+W is
 *   delete-word in a terminal shell).
 * - Inside the Electron shell (webview mode), the rest of the browser's
 *   shortcut set is also scoped to a focused Web Browser window: Ctrl+F
 *   (find bar), Ctrl+R / F5 and Ctrl+Shift+R / Shift+F5 (reload),
 *   Ctrl+Tab / Ctrl+Shift+Tab (cycle tabs), Ctrl+1..9 (tab by position),
 *   and Alt+Left/Right (history), plus Ctrl+PageUp/PageDown (cycle tabs),
 *   Alt+D / F6 (address bar), Ctrl+Shift+T (reopen a closed tab), Ctrl+N /
 *   Ctrl+Shift+N (new normal / private window), Ctrl+Shift+W (close the
 *   window), Ctrl+Shift+Delete (clear browsing data), and Ctrl+= / Ctrl+- /
 *   Ctrl+0 (page zoom). These are NOT intercepted in the
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

  const { config, updateConfig } = useAppContext();
  const tilingRef = useRef(config.tilingEnabled);
  useEffect(() => {
    tilingRef.current = config.tilingEnabled;
  }, [config.tilingEnabled]);

  // Runs a window-management binding, from either key source below.
  const runWmRef = useRef<(cmd: WmCommand) => void>(() => {});
  useEffect(() => {
    const setTiling = (enabled: boolean) => {
      tilingRef.current = enabled;
      updateConfig((current) => ({ ...current, tilingEnabled: enabled }));
    };
    runWmRef.current = (cmd) => {
      const a = actionsRef.current;
      const top = focusedWindow(windowsRef.current);
      switch (cmd.type) {
        case 'focus':
          return a.focusDirection(cmd.dir);
        case 'swap':
          return a.swapDirection(cmd.dir);
        case 'move-to-monitor':
          return top && a.moveToMonitor(top.id, cmd.dir);
        case 'workspace':
          return a.showWorkspace(cmd.n);
        case 'move-to-workspace':
          return top && a.moveToWorkspace(top.id, cmd.n, cmd.follow);
        case 'workspace-step':
          return a.stepWorkspace(cmd.step);
        case 'workspace-previous':
          return a.previousWorkspace();
        case 'close':
          return top && a.close(top.id);
        case 'toggle-float':
          // With tiling off, Super+T is the way in: tiling comes on, with
          // this window tiled.
          if (!tilingRef.current) setTiling(true);
          return top && a.toggleFloating(top.id);
        case 'toggle-tiling':
          return setTiling(!tilingRef.current);
        case 'fullscreen':
          return top && a.toggleMaximize(top.id);
        case 'toggle-split':
          return top && a.toggleSplit(top.id);
        case 'minimize':
          return top && a.minimize(top.id);
        case 'resize':
          return top && a.resizeBy(top.id, cmd.dx, cmd.dy);
        case 'terminal':
          a.open(TERMINAL_APP_ID);
          return;
        case 'help':
          a.open(SETTINGS_APP_ID, { section: 'windows' });
          return;
      }
    };
  }, [updateConfig]);

  useEffect(() => {
    /** The focused window: highest z among those on screen (as the Dock). */
    const topWindow = () => focusedWindow(windowsRef.current);

    // Shortcuts that would fight the host browser (find, reload, tab and
    // history navigation) are only intercepted inside the Electron shell.
    const guests = isWebviewAvailable();

    const onKeyDown = (e: KeyboardEvent) => {
      // The window switcher owns the keyboard while an Alt+Tab gesture is
      // open (its own listener handles navigation/commit); stand down so we
      // don't, e.g., read its Alt+Arrow selection as browser history.
      if (isWindowSwitcherActive()) return;

      // Ctrl+Alt+Delete: the security options screen, as on Windows. Checked
      // before anything else, and swallowed so a native app doesn't get it.
      if (e.key === 'Delete' && e.ctrlKey && e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        showSecurityOptions();
        return;
      }
      // The screen has the keyboard while it's up.
      if (isSecurityOptionsActive()) return;

      // Print Screen: full-screen capture. Shift+Print Screen: select an
      // area (the same session the dedicated box-select key starts via the
      // Electron host's evdev watch). The session flag guards against a
      // press mid-capture.
      if (e.key === 'PrintScreen' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (!isScreenshotSessionActive()) {
          e.preventDefault();
          requestScreenshot(e.shiftKey ? 'area' : 'screen');
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

      // Super+A: the assistant's prompt, on the way up (holding it dictates).
      // While it's down, its A doesn't type (if Super comes up first).
      if (
        e.key.toLowerCase() === 'a' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.metaKey || isAssistantKeyPressed())
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) assistantKeyDown();
        return;
      }

      // Super+H: dictation.
      if (e.key.toLowerCase() === 'h' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleDictation();
        return;
      }

      // Super+key: window management (after Super+Space/A/H above).
      if (e.metaKey) {
        const cmd = wmCommandFor({ code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat || cmd.type === 'resize') runWmRef.current(cmd);
          return;
        }
      }

      // Esc: stop dictating, throwing it away.
      if (e.key === 'Escape' && isDictating() && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cancelDictation();
        return;
      }

      // Ctrl+Shift+Escape: the System Monitor (single-instance, so an open
      // one just comes forward).
      if (e.key === 'Escape' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.open(SYSTEM_MONITOR_APP_ID);
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
      // Alt+D / F6: the address bar.
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        publish({ action: 'focus-address' });
        return;
      }
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'd'
      ) {
        publish({ action: 'focus-address' });
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') {
        publish({ action: 'cycle-tab', backward: e.shiftKey });
        return;
      }
      // Ctrl+PageDown / Ctrl+PageUp: the same.
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key === 'PageDown' || e.key === 'PageUp')
      ) {
        publish({ action: 'cycle-tab', backward: e.key === 'PageUp' });
        return;
      }
      // Page zoom: Ctrl+= or Ctrl++ (the latter usually needs Shift),
      // Ctrl+-, and Ctrl+0.
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          publish({ action: 'zoom-in' });
          return;
        }
        if (e.key === '-' && !e.shiftKey) {
          publish({ action: 'zoom-out' });
          return;
        }
        if (e.key === '0' && !e.shiftKey) {
          publish({ action: 'zoom-reset' });
          return;
        }
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        // Ctrl+Shift+R: cache-bypassing reload.
        if (key === 'r') publish({ action: 'force-reload' });
        else if (key === 't') publish({ action: 'reopen-tab' });
        else if (key === 'n') publish({ action: 'new-private-window' });
        else if (key === 'w') publish({ action: 'close-window' });
        else if (e.key === 'Delete') publish({ action: 'clear-data' });
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 't') publish({ action: 'new-tab' });
        else if (key === 'w') publish({ action: 'close-tab' });
        else if (key === 'l') publish({ action: 'focus-address' });
        else if (key === 'f') publish({ action: 'find' });
        else if (key === 'u') publish({ action: 'view-source' });
        else if (key === 'p') publish({ action: 'print' });
        else if (key === 'r') publish({ action: 'reload' });
        else if (key === 'n') publish({ action: 'new-window' });
        else if (/^[1-9]$/.test(e.key)) {
          publish({ action: 'goto-tab', digit: Number(e.key) });
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isAssistantKeyPressed()) return;
      if (e.key.toLowerCase() === 'a' || e.key === 'Meta') assistantKeyUp();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge) return;
    return bridge.onShortcut((shortcut) => {
      // Alt+Tab from a guest is handled by the WindowSwitcher's own bridge
      // subscription; here we only service the apps menu and screenshots.
      if (shortcut.action === 'apps-menu') {
        toggleAppsMenu();
      } else if (shortcut.action === 'assistant') {
        assistantKeyDown();
      } else if (shortcut.action === 'assistant-released') {
        assistantKeyUp();
      } else if (shortcut.action === 'super-key' && !shortcut.down) {
        if (isAssistantKeyPressed()) assistantKeyUp();
      } else if (shortcut.action === 'wm') {
        const cmd = wmCommandFor(shortcut);
        if (cmd && (!shortcut.repeat || cmd.type === 'resize')) runWmRef.current(cmd);
      } else if (shortcut.action === 'dictation') {
        toggleDictation();
      } else if (shortcut.action === 'security-options') {
        showSecurityOptions();
      } else if (shortcut.action === 'system-monitor') {
        actionsRef.current.open(SYSTEM_MONITOR_APP_ID);
      } else if (shortcut.action === 'screenshot' || shortcut.action === 'screenshot-area') {
        if (!isScreenshotSessionActive()) {
          requestScreenshot(shortcut.action === 'screenshot-area' ? 'area' : 'screen');
        }
      }
    });
  }, []);

  return null;
}
