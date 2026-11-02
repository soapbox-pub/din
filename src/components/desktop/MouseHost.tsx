import { useEffect, useRef } from 'react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { focusedWindow, type WindowState } from '@/hooks/useWindows';
import { publishBrowserHotkey } from '@/lib/browserTabBus';
import { getMouseBridge, mouseSettings } from '@/lib/mouse';
import { getShellShortcuts } from '@/lib/shellShortcuts';

/** The built-in Web Browser's app id (see src/lib/apps.ts). */
const WEB_BROWSER_APP_ID = 'web-browser';

/**
 * The mouse, under din-shell. Renders nothing.
 *
 * - Settings → Mouse's settings go to din-shell, which applies them
 *   (electron/mouse.mts), now and as they change.
 * - A mouse's Back and Forward buttons, and a Magic Mouse's two-finger
 *   swipe, go Back and Forward in the focused Web Browser window; the swipe
 *   can show the workspace beside instead. din-shell tells them.
 */
export function MouseHost() {
  const { config } = useAppContext();
  const { windows, actions } = useWindowManager();

  const settings = mouseSettings(config);
  const key = JSON.stringify(settings);
  useEffect(() => {
    void getMouseBridge()?.set(JSON.parse(key)).catch(() => {});
  }, [key]);

  const windowsRef = useRef<WindowState[]>(windows);
  const actionsRef = useRef(actions);
  useEffect(() => {
    windowsRef.current = windows;
    actionsRef.current = actions;
  }, [windows, actions]);

  useEffect(() => {
    return getShellShortcuts()?.onShortcut((shortcut) => {
      if (shortcut.action === 'workspace-step') {
        actionsRef.current.stepWorkspace(shortcut.step);
      } else if (shortcut.action === 'history') {
        const top = focusedWindow(windowsRef.current);
        if (top?.appId === WEB_BROWSER_APP_ID) {
          publishBrowserHotkey({ windowId: top.id, action: shortcut.back ? 'back' : 'forward' });
        }
      }
    });
  }, []);

  return null;
}
