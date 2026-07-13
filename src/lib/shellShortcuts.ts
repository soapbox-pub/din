/**
 * Typed access to the shell-shortcut bridge exposed by the Electron preload
 * (`window.shellShortcuts`, see electron/preload.cjs + electron/main.cjs).
 *
 * Keyboard focus often lives inside Electron <webview> guests (browser
 * tabs, devtools panes), where the shell can't observe keydown events. The
 * main process intercepts shell-level shortcuts there via
 * `before-input-event` and forwards them to the shell:
 *
 *   - Alt+Tab / Alt+Shift+Tab -> { action: 'cycle-windows', backward }
 *   - Ctrl+T in a browser tab -> { action: 'new-tab', wcId }
 *   - Ctrl+W in a browser tab -> { action: 'close-tab', wcId }
 *
 * Tab-scoped shortcuts carry the guest's WebContents id so only the browser
 * window owning that tab acts (mirrors the devtools command routing).
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; the same
 * shortcuts are handled by DOM keydown listeners instead (see DesktopHotkeys
 * and the Web Browser app), which see all keys because there are no guests.
 */

/** A shell shortcut forwarded from the main process. */
export type ShellShortcut =
  | {
      /** Alt+Tab pressed inside a guest: cycle window focus. */
      action: 'cycle-windows';
      backward: boolean;
    }
  | {
      /** Ctrl+T pressed inside a browser tab: open a new tab. */
      action: 'new-tab';
      wcId: number;
    }
  | {
      /** Ctrl+W pressed inside a browser tab: close that tab. */
      action: 'close-tab';
      wcId: number;
    };

export interface ShellShortcutsBridge {
  /** Subscribe to forwarded shortcuts. Returns an unsubscribe fn. */
  onShortcut(callback: (shortcut: ShellShortcut) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    shellShortcuts?: ShellShortcutsBridge;
  }
}

/** The shell-shortcut bridge, or undefined outside the Electron shell. */
export function getShellShortcuts(): ShellShortcutsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.shellShortcuts;
}
