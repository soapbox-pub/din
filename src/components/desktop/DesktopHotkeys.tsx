import { useEffect } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getShellShortcuts } from '@/lib/shellShortcuts';

/**
 * Desktop-wide keyboard shortcuts. Renders nothing.
 *
 * Alt+Tab / Alt+Shift+Tab cycle focus through the open (non-minimized)
 * windows. The same action is fed from two sources:
 *
 *  - a window-level keydown listener (capture phase, so it wins over app
 *    content like xterm) for keys pressed while focus is in the shell, and
 *  - the shell-shortcut bridge for keys pressed inside Electron <webview>
 *    guests, where keydown never reaches the shell DOM (the main process
 *    intercepts them via before-input-event - see src/lib/shellShortcuts).
 *
 * Note: when Din runs windowed inside a desktop environment, the host
 * window manager usually consumes Alt+Tab first; in the Aladdin kiosk
 * (cage) and the plain-browser dev loop the shortcut reaches us.
 */
export function DesktopHotkeys() {
  const { cycleFocus } = useWindowActions();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      cycleFocus(e.shiftKey);
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
