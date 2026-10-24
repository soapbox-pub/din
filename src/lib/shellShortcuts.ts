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
 *   - Super+Space             -> { action: 'apps-menu' }
 *   - Super+A                 -> { action: 'assistant' }, and when the A
 *                                comes up -> { action: 'assistant-released' }
 *   - Super+H                 -> { action: 'dictation' }
 *   - Ctrl+Shift+Escape       -> { action: 'system-monitor' }
 *   - Ctrl+Alt+Delete         -> { action: 'security-options' }
 *   - Super down / up         -> { action: 'super-key', down }
 *   - Alt up                  -> { action: 'alt-released' }
 *   - Print Screen            -> { action: 'screenshot' }
 *   - Shift+Print Screen, or the laptop box-select key
 *                             -> { action: 'screenshot-area' }
 *   - Ctrl+T in a browser tab -> { action: 'new-tab', wcId }
 *   - Ctrl+W in a browser tab -> { action: 'close-tab', wcId }
 *   - Ctrl+L / Alt+D / F6     -> { action: 'focus-address', wcId }
 *   - Ctrl+F in a browser tab -> { action: 'find', wcId }
 *   - Ctrl+U in a browser tab -> { action: 'view-source', wcId }
 *   - Ctrl+R / F5 (+Shift)    -> { action: 'reload', force, wcId }
 *   - Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / Ctrl+PageUp
 *                             -> { action: 'cycle-tab', backward, wcId }
 *   - Ctrl+1..9 in a browser tab -> { action: 'goto-tab', digit, wcId }
 *   - Alt+Left / Alt+Right    -> { action: 'back' | 'forward', wcId }
 *   - Ctrl+Shift+T            -> { action: 'reopen-tab', wcId }
 *   - Ctrl+N / Ctrl+Shift+N   -> { action: 'new-window' | 'new-private-window', wcId }
 *   - Ctrl+Shift+W            -> { action: 'close-window', wcId }
 *   - Ctrl+Shift+Delete       -> { action: 'clear-data', wcId }
 *   - Ctrl+= / Ctrl+- / Ctrl+0 -> { action: 'zoom-in' | 'zoom-out' | 'zoom-reset', wcId }
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
      /** Super+Space pressed inside a guest: toggle the apps menu. */
      action: 'apps-menu';
    }
  | {
      /**
       * Super+A pressed inside a guest: a tap toggles the assistant's prompt,
       * and holding it dictates into the prompt.
       */
      action: 'assistant';
    }
  | {
      /** The A of a Super+A pressed inside a guest came up. */
      action: 'assistant-released';
    }
  | {
      /** Super+H pressed inside a guest: start or stop dictating into it. */
      action: 'dictation';
    }
  | {
      /** Ctrl+Shift+Escape pressed inside a guest: open the System Monitor. */
      action: 'system-monitor';
    }
  | {
      /** Ctrl+Alt+Delete pressed inside a guest: open the security options screen. */
      action: 'security-options';
    }
  | {
      /** Super pressed or released inside a guest (Super+drag moves windows). */
      action: 'super-key';
      down: boolean;
    }
  | {
      /** Alt released inside a guest: ends an Alt+Tab started there. */
      action: 'alt-released';
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
      /** Ctrl+U pressed inside a browser tab: view its page source. */
      action: 'view-source';
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
    }
  | {
      /**
       * Window and page keys pressed inside a browser tab: Ctrl+Shift+T
       * (reopen a closed tab), Ctrl+N / Ctrl+Shift+N (new normal / private
       * window), Ctrl+Shift+W (close the window), Ctrl+Shift+Delete (clear
       * browsing data), and Ctrl+= / Ctrl+- / Ctrl+0 (page zoom).
       */
      action:
        | 'reopen-tab'
        | 'new-window'
        | 'new-private-window'
        | 'close-window'
        | 'clear-data'
        | 'zoom-in'
        | 'zoom-out'
        | 'zoom-reset';
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
