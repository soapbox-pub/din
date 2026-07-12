/**
 * Typed access to the devtools bridge exposed by the Electron preload
 * (`window.devtools`, see electron/preload.cjs + electron/main.cjs).
 *
 * The bridge lets the Web Browser app dock Chrome DevTools inside a tab.
 * Din runs as a single native window (fullscreen kiosk under cage), so the
 * default detached devtools window is unusable; instead the browser renders
 * a devtools host <webview> below the page and asks the main process to wire
 * it to the inspected tab via webContents.setDevToolsWebContents():
 *   - the shell opens/closes devtools for a tab by WebContents id
 *   - the main process forwards toggle shortcuts pressed inside guests
 *     (keyboard focus lives there, invisible to the shell) and context-menu
 *     "Inspect" clicks, and reports devtools closing from any side
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * must feature-detect via `getDevtoolsBridge()` and hide devtools UI.
 */

/** A devtools command initiated by the main process. */
export type DevtoolsCommand =
  | {
      /** F12 / Ctrl+Shift+I pressed inside the tab (or its devtools pane). */
      type: 'toggle';
      wcId: number;
    }
  | {
      /** Context-menu "Inspect": open devtools and highlight (x, y). */
      type: 'inspect';
      wcId: number;
      x: number;
      y: number;
    }
  | {
      /** The tab's devtools closed (frontend close button, tab destroyed…). */
      type: 'closed';
      wcId: number;
    };

export interface DevtoolsBridge {
  /** Dock a tab's devtools into a devtools host <webview> and open them. */
  open(targetWcId: number, hostWcId: number): Promise<void>;
  /** Close a tab's devtools. */
  close(targetWcId: number): Promise<void>;
  /** Highlight the element at page coordinates in the tab's open devtools. */
  inspect(targetWcId: number, x: number, y: number): Promise<void>;
  /** Subscribe to devtools commands. Returns an unsubscribe fn. */
  onCommand(callback: (command: DevtoolsCommand) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    devtools?: DevtoolsBridge;
  }
}

/** The devtools bridge, or undefined outside the Electron shell. */
export function getDevtoolsBridge(): DevtoolsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.devtools;
}
