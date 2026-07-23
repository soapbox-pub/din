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
 *   - Print Screen            -> { action: 'screenshot' }
 *   - Shift+Print Screen, or the laptop box-select key
 *                             -> { action: 'screenshot-area' }
 *   - Ctrl+T in a browser tab -> { action: 'new-tab', wcId }
 *   - Ctrl+W in a browser tab -> { action: 'close-tab', wcId }
 *   - Ctrl+L in a browser tab -> { action: 'focus-address', wcId }
 *   - Ctrl+F in a browser tab -> { action: 'find', wcId }
 *   - Ctrl+R / F5 (+Shift)    -> { action: 'reload', force, wcId }
 *   - Ctrl+Tab / Ctrl+Shift+Tab -> { action: 'cycle-tab', backward, wcId }
 *   - Ctrl+1..9 in a browser tab -> { action: 'goto-tab', digit, wcId }
 *   - Alt+Left / Alt+Right    -> { action: 'back' | 'forward', wcId }
 *
 * Tab-scoped shortcuts carry the guest's WebContents id so only the browser
 * window owning that tab acts (mirrors the devtools command routing).
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; the tab
 * management shortcuts are handled by DOM keydown listeners instead (see
 * DesktopHotkeys and the Web Browser app), which see all keys because there
 * are no guests. Shortcuts that would clash with the host browser itself
 * (Ctrl+F, reload, tab/history navigation) are NOT intercepted there - the
 * host keeps them.
 */

/** A shell shortcut forwarded from the main process. */
export type ShellShortcut =
  | {
      /** Alt+Tab pressed inside a guest: cycle window focus. */
      action: 'cycle-windows';
      backward: boolean;
    }
  | {
      /** Print Screen pressed inside a guest: full-screen capture. */
      action: 'screenshot';
    }
  | {
      /**
       * Area-select capture: Shift+Print Screen inside a guest, or the
       * dedicated box-select key on newer laptops (read from evdev by the
       * main process, since Chromium can't identify its keysym).
       */
      action: 'screenshot-area';
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
    }
  | {
      /** Ctrl+L pressed inside a browser tab: focus its address bar. */
      action: 'focus-address';
      wcId: number;
    }
  | {
      /** Ctrl+F pressed inside a browser tab: open the find bar. */
      action: 'find';
      wcId: number;
    }
  | {
      /** Ctrl+R / F5 (with Shift for a cache-bypassing reload). */
      action: 'reload';
      force: boolean;
      wcId: number;
    }
  | {
      /** Ctrl+Tab / Ctrl+Shift+Tab: activate the next/previous tab. */
      action: 'cycle-tab';
      backward: boolean;
      wcId: number;
    }
  | {
      /** Ctrl+1..9: activate a tab by position (9 = last tab). */
      action: 'goto-tab';
      digit: number;
      wcId: number;
    }
  | {
      /** Alt+Left / Alt+Right: history navigation in that tab. */
      action: 'back' | 'forward';
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
