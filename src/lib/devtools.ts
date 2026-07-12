/**
 * Typed access to the devtools bridge exposed by the Electron preload
 * (`window.devtools`, see electron/preload.cjs + electron/main.cjs).
 *
 * The bridge lets the Web Browser app dock Chrome DevTools inside a tab.
 * Din runs as a single native window (fullscreen kiosk under cage), so the
 * default detached devtools window is unusable; instead the browser renders
 * a devtools host <webview> below the page, and the main process loads the
 * bundled DevTools frontend in it, connected to the inspected tab over a
 * loopback CDP bridge (electron/devtools-bridge.cjs):
 *   - the shell opens/closes devtools for a tab by WebContents id
 *   - the main process forwards toggle shortcuts pressed inside guests
 *     (keyboard focus lives there, invisible to the shell) and context-menu
 *     "Inspect" clicks, and reports sessions dying with their tab or pane
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
      /** The tab's devtools session died with its tab or pane. */
      type: 'closed';
      wcId: number;
    };

/** Device-metrics + user-agent override for the responsive/device view. */
export interface DeviceMetrics {
  /** Viewport width in CSS pixels. */
  width: number;
  /** Viewport height in CSS pixels. */
  height: number;
  /** Device pixel ratio; 0 uses the platform default. */
  deviceScaleFactor?: number;
  /** Emulate a mobile device (touch events, mobile viewport). */
  mobile?: boolean;
  /** Override the navigator user-agent string. */
  userAgent?: string;
}

export interface DevtoolsBridge {
  /** Dock a tab's devtools into a devtools host <webview> and open them. */
  open(targetWcId: number, hostWcId: number): Promise<void>;
  /** Close a tab's devtools. */
  close(targetWcId: number): Promise<void>;
  /** Highlight the element at page coordinates in the tab's open devtools. */
  inspect(targetWcId: number, x: number, y: number): Promise<void>;
  /**
   * Apply device/responsive emulation to a tab, or clear it with `null`.
   * Works whether or not the tab's devtools pane is open.
   */
  emulate(targetWcId: number, metrics: DeviceMetrics | null): Promise<void>;
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
